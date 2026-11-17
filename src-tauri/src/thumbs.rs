// Thumbnail cache: one file per folder, "Folio.thumbs" (hidden), next to the images,
// holding the thumbnails of every image in that folder. Folders Folio can't write to
// (read-only drives, protected folders) keep theirs in the data folder instead, as
// thumbnails/<sha1(folder)>.thumbs. Thumbnails are WebP, generated in renderer Web
// Workers; the backend stores them and serves them through the thumb:// protocol.
//
// A pack is an append-only log, so saving a thumbnail never rewrites the file:
//   magic "FOLIOTB1"
//   records: u32 length of the rest | u8 kind | u16 name length | file name (UTF-8)
//            | u64 image size | i64 image mtime (ns since 1970) | WebP bytes
// kind 1 is a thumbnail, kind 2 deletes the name's thumbnail. A later record for a
// name replaces an earlier one. A thumbnail is current while the image's size and
// mtime match the record, so an image edited outside Folio gets a fresh one. Packs
// are rewritten without dead records (replaced, deleted, or images no longer in the
// folder) once those are a large part of the file, and deleted when nothing is left.

use sha1::{Digest, Sha1};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const PACK_NAME: &str = "Folio.thumbs";
const MAGIC: &[u8; 8] = b"FOLIOTB1";
const KIND_THUMB: u8 = 1;
const KIND_DELETED: u8 = 2;
const RECORD_FIXED: u64 = 1 + 2 + 8 + 8; // kind, name length, size, mtime
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
// Rewrite a pack once dead records take at least this much of it
const COMPACT_MIN_DEAD: u64 = 512 * 1024;
const COMPACT_RATIO: f64 = 0.25;
// Fallback packs (in the data folder) for folders not seen this long are deleted
const FALLBACK_MAX_AGE: Duration = Duration::from_secs(90 * 24 * 3600);

// An image's size and modification time: a thumbnail is current while these match
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Version {
    size: u64,
    mtime_ns: i64,
}

impl Version {
    fn of(meta: &fs::Metadata) -> Version {
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(0);
        Version { size: meta.len(), mtime_ns }
    }
    // Opaque token for the renderer (a string: the numbers exceed JS's safe integers)
    pub fn token(&self) -> String {
        format!("{}-{}", self.size, self.mtime_ns)
    }
    pub fn parse(token: &str) -> Option<Version> {
        let (s, m) = token.split_once('-')?;
        Some(Version { size: s.parse().ok()?, mtime_ns: m.parse().ok()? })
    }
}

// (kind, file name, image version, WebP bytes)
type Record = (u8, String, Version, Vec<u8>);

pub enum Lookup {
    Cached(Version),
    Missing(Version),
}

struct Entry {
    name: String, // as stored (original case)
    version: Version,
    data: u64,   // offset of the WebP bytes
    len: u64,    // their length
    record: u64, // whole record, length prefix included
}

struct Pack {
    file: Option<PathBuf>, // None until the first thumbnail is saved
    entries: HashMap<String, Entry>, // lowercase file name → thumbnail
    end: u64,  // end of the last valid record
    dead: u64, // bytes in replaced and deleted records
    stamp: Option<(u64, SystemTime)>, // length and mtime when read or written
}

impl Pack {
    fn empty(file: Option<PathBuf>) -> Pack {
        Pack { file, entries: HashMap::new(), end: 0, dead: 0, stamp: None }
    }
}

pub struct ThumbCache {
    fallback_dir: PathBuf,
    packs: Mutex<HashMap<String, Pack>>, // folder key → its pack
}

fn folder_key(folder: &Path) -> String {
    folder.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase()
}

fn split(image_path: &Path) -> Option<(PathBuf, String)> {
    let folder = image_path.parent()?.to_path_buf();
    let name = image_path.file_name()?.to_string_lossy().into_owned();
    Some((folder, name))
}

fn stamp_of(file: &Path) -> Option<(u64, SystemTime)> {
    let m = fs::metadata(file).ok()?;
    Some((m.len(), m.modified().ok()?))
}

fn read_exact_at(file: &Path, offset: u64, len: u64) -> Option<Vec<u8>> {
    let mut f = fs::File::open(file).ok()?;
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0; len as usize];
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn encode_record(kind: u8, name: &str, version: Version, data: &[u8]) -> Vec<u8> {
    let name = name.as_bytes();
    let len = RECORD_FIXED + name.len() as u64 + data.len() as u64;
    let mut out = Vec::with_capacity(4 + len as usize);
    out.extend_from_slice(&(len as u32).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(name);
    out.extend_from_slice(&version.size.to_le_bytes());
    out.extend_from_slice(&version.mtime_ns.to_le_bytes());
    out.extend_from_slice(data);
    out
}

// Reads a pack's records. Stops at the first damaged or incomplete record (a write
// cut short), which the next save overwrites.
fn load_pack(file: &Path) -> Pack {
    let mut pack = Pack::empty(Some(file.to_path_buf()));
    let Ok(f) = fs::File::open(file) else { return pack };
    let total = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut r = BufReader::with_capacity(64 * 1024, f);
    let mut magic = [0u8; 8];
    if r.read_exact(&mut magic).is_err() || &magic != MAGIC {
        return pack; // not a pack (or empty): rewritten from scratch on the next save
    }
    let mut pos = 8u64;
    loop {
        let mut head = [0u8; 7];
        if r.read_exact(&mut head).is_err() {
            break;
        }
        let len = u32::from_le_bytes(head[0..4].try_into().unwrap()) as u64;
        let kind = head[4];
        let name_len = u16::from_le_bytes(head[5..7].try_into().unwrap()) as u64;
        if len < RECORD_FIXED + name_len || pos + 4 + len > total {
            break;
        }
        let mut name = vec![0u8; name_len as usize];
        let mut ver = [0u8; 16];
        if r.read_exact(&mut name).is_err() || r.read_exact(&mut ver).is_err() {
            break;
        }
        let data_len = len - RECORD_FIXED - name_len;
        if r.seek_relative(data_len as i64).is_err() {
            break;
        }
        let record = 4 + len;
        let data = pos + 4 + RECORD_FIXED + name_len;
        let name = String::from_utf8_lossy(&name).into_owned();
        let key = name.to_lowercase();
        let version = Version {
            size: u64::from_le_bytes(ver[0..8].try_into().unwrap()),
            mtime_ns: i64::from_le_bytes(ver[8..16].try_into().unwrap()),
        };
        let replaced = match kind {
            KIND_THUMB => pack.entries.insert(key, Entry { name, version, data, len: data_len, record }),
            KIND_DELETED => {
                pack.dead += record;
                pack.entries.remove(&key)
            }
            _ => {
                pack.dead += record;
                None
            }
        };
        if let Some(old) = replaced {
            pack.dead += old.record;
        }
        pos += record;
    }
    pack.end = pos;
    pack.stamp = stamp_of(file);
    pack
}

impl ThumbCache {
    pub fn open(fallback_dir: PathBuf) -> Arc<Self> {
        let _ = fs::create_dir_all(&fallback_dir);
        let cache = Arc::new(ThumbCache { fallback_dir, packs: Mutex::new(HashMap::new()) });
        let c = cache.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(5)); // off the startup path
            c.clean_data_folder();
        });
        cache
    }

    // Deletes the loose per-image files of Folio 1.2.1 and earlier, and fallback packs
    // of folders not used for a long time
    fn clean_data_folder(&self) {
        let Ok(entries) = fs::read_dir(&self.fallback_dir) else { return };
        let cutoff = SystemTime::now() - FALLBACK_MAX_AGE;
        for e in entries.flatten() {
            let p = e.path();
            let is_pack = p.extension().is_some_and(|x| x == "thumbs");
            let stale = !is_pack || fs::metadata(&p).and_then(|m| m.modified()).map(|t| t < cutoff).unwrap_or(false);
            if stale {
                let _ = fs::remove_file(&p);
            }
        }
    }

    fn fallback_file(&self, folder: &Path) -> PathBuf {
        self.fallback_dir.join(format!("{}.thumbs", hex::encode(Sha1::digest(folder_key(folder).as_bytes()))))
    }

    // The folder's pack, loaded on first use and reloaded if something else changed
    // or deleted the file
    fn pack<'a>(&self, packs: &'a mut HashMap<String, Pack>, folder: &Path) -> &'a mut Pack {
        let key = folder_key(folder);
        let fresh = match packs.get(&key) {
            None => false,
            Some(p) => match &p.file {
                Some(f) => stamp_of(f) == p.stamp,
                None => !folder.join(PACK_NAME).exists() && !self.fallback_file(folder).exists(),
            },
        };
        if !fresh {
            let in_folder = folder.join(PACK_NAME);
            let fallback = self.fallback_file(folder);
            let pack = if in_folder.exists() {
                load_pack(&in_folder)
            } else if fallback.exists() {
                load_pack(&fallback)
            } else {
                Pack::empty(None)
            };
            packs.insert(key.clone(), pack);
        }
        packs.get_mut(&key).unwrap()
    }

    // Appends records to the folder's pack, creating it (in the folder, or in the data
    // folder if the folder isn't writable) if needed
    fn append(&self, pack: &mut Pack, folder: &Path, records: &[Record]) -> bool {
        if records.is_empty() {
            return true;
        }
        let primary = pack.file.clone().unwrap_or_else(|| folder.join(PACK_NAME));
        if self.append_at(pack, &primary, records) {
            return true;
        }
        // The folder isn't writable: keep this folder's thumbnails in the data folder
        let fallback = self.fallback_file(folder);
        if primary == fallback {
            return false;
        }
        *pack = if fallback.exists() { load_pack(&fallback) } else { Pack::empty(None) };
        self.append_at(pack, &fallback, records)
    }

    fn append_at(&self, pack: &mut Pack, file: &Path, records: &[Record]) -> bool {
        // A new file, or one that isn't a valid pack, starts over with the magic
        let fresh = pack.file.as_deref() != Some(file) || pack.end < MAGIC.len() as u64;
        let start = if fresh { 0 } else { pack.end };
        let mut buf = Vec::new();
        if fresh {
            buf.extend_from_slice(MAGIC);
        }
        let mut offsets = Vec::with_capacity(records.len());
        for (kind, name, version, data) in records {
            offsets.push(start + buf.len() as u64);
            buf.extend_from_slice(&encode_record(*kind, name, *version, data));
        }
        if self.write_at(file, start, &buf).is_err() {
            return false;
        }
        if fresh {
            *pack = Pack::empty(None);
        }
        pack.file = Some(file.to_path_buf());
        self.index_appended(pack, records, &offsets);
        pack.end = start + buf.len() as u64;
        pack.stamp = stamp_of(file);
        true
    }

    // Writes buf at offset, cutting off anything after it (a damaged tail)
    fn write_at(&self, file: &Path, offset: u64, buf: &[u8]) -> io::Result<()> {
        let mut f = OpenOptions::new().read(true).write(true).create(true).attributes(FILE_ATTRIBUTE_HIDDEN).open(file)?;
        if f.metadata()?.len() != offset {
            f.set_len(offset)?;
        }
        f.seek(SeekFrom::Start(offset))?;
        f.write_all(buf)?;
        f.flush()
    }

    fn index_appended(&self, pack: &mut Pack, records: &[Record], offsets: &[u64]) {
        for ((kind, name, version, data), at) in records.iter().zip(offsets) {
            let record = 4 + RECORD_FIXED + name.len() as u64 + data.len() as u64;
            let key = name.to_lowercase();
            let replaced = if *kind == KIND_THUMB {
                let data_at = at + 4 + RECORD_FIXED + name.len() as u64;
                pack.entries.insert(key, Entry { name: name.clone(), version: *version, data: data_at, len: data.len() as u64, record })
            } else {
                pack.dead += record;
                pack.entries.remove(&key)
            };
            if let Some(old) = replaced {
                pack.dead += old.record;
            }
        }
    }

    // For each image: Cached / Missing with its current version, or None when the image
    // can't be read
    pub fn lookup_many(&self, paths: &[String]) -> Vec<Option<Lookup>> {
        use rayon::prelude::*;
        let versions: Vec<Option<Version>> = paths
            .par_iter()
            .map(|p| fs::metadata(p).ok().filter(|m| m.is_file()).map(|m| Version::of(&m)))
            .collect();
        let mut packs = self.packs.lock().unwrap();
        paths
            .iter()
            .zip(versions)
            .map(|(p, version)| {
                let version = version?;
                let (folder, name) = split(Path::new(p))?;
                let pack = self.pack(&mut packs, &folder);
                Some(match pack.entries.get(&name.to_lowercase()) {
                    Some(e) if e.version == version => Lookup::Cached(version),
                    _ => Lookup::Missing(version),
                })
            })
            .collect()
    }

    // Stores generated thumbnails: (image path, version token from lookup, WebP bytes).
    // Returns each one's token, or None if it couldn't be stored.
    pub fn save_many(&self, items: Vec<(String, String, &[u8])>) -> Vec<Option<String>> {
        let mut result = vec![None; items.len()];
        let mut by_folder: HashMap<String, (PathBuf, Vec<(usize, Record)>)> = HashMap::new();
        for (i, (path, token, bytes)) in items.into_iter().enumerate() {
            let p = Path::new(&path);
            let (Some(version), Some((folder, name))) = (Version::parse(&token), split(p)) else { continue };
            if !crate::is_image(p) || bytes.is_empty() {
                continue;
            }
            by_folder
                .entry(folder_key(&folder))
                .or_insert_with(|| (folder.clone(), Vec::new()))
                .1
                .push((i, (KIND_THUMB, name, version, bytes.to_vec())));
        }
        let mut packs = self.packs.lock().unwrap();
        for (_, (folder, list)) in by_folder {
            let records: Vec<_> = list.iter().map(|(_, r)| r.clone()).collect();
            let pack = self.pack(&mut packs, &folder);
            if self.append(pack, &folder, &records) {
                for (i, (_, _, version, _)) in &list {
                    result[*i] = Some(version.token());
                }
            }
        }
        result
    }

    // WebP bytes of an image's thumbnail, for the thumb:// protocol
    pub fn read(&self, image_path: &Path) -> Option<Vec<u8>> {
        let (folder, name) = split(image_path)?;
        let (file, offset, len) = {
            let mut packs = self.packs.lock().unwrap();
            let pack = self.pack(&mut packs, &folder);
            let e = pack.entries.get(&name.to_lowercase())?;
            (pack.file.clone()?, e.data, e.len)
        };
        read_exact_at(&file, offset, len)
    }

    pub fn delete_for(&self, image_path: &str) {
        let Some((folder, name)) = split(Path::new(image_path)) else { return };
        let mut packs = self.packs.lock().unwrap();
        let pack = self.pack(&mut packs, &folder);
        if let Some(e) = pack.entries.get(&name.to_lowercase()) {
            let v = e.version;
            self.append(pack, &folder, &[(KIND_DELETED, name, v, Vec::new())]);
        }
    }

    // After a rename or move (size and mtime unchanged), carry the thumbnail along,
    // into the destination folder's pack if it moved
    pub fn rename(&self, old_path: &Path, new_path: &Path) {
        let (Some((old_folder, old_name)), Some((new_folder, new_name))) = (split(old_path), split(new_path)) else { return };
        let mut packs = self.packs.lock().unwrap();
        let (version, data) = {
            let pack = self.pack(&mut packs, &old_folder);
            let Some(e) = pack.entries.get(&old_name.to_lowercase()) else { return };
            let Some(file) = pack.file.clone() else { return };
            let Some(data) = read_exact_at(&file, e.data, e.len) else { return };
            (e.version, data)
        };
        if folder_key(&old_folder) == folder_key(&new_folder) {
            let pack = self.pack(&mut packs, &old_folder);
            self.append(pack, &old_folder, &[(KIND_DELETED, old_name, version, Vec::new()), (KIND_THUMB, new_name, version, data)]);
        } else {
            let dest = self.pack(&mut packs, &new_folder);
            self.append(dest, &new_folder, &[(KIND_THUMB, new_name, version, data)]);
            let src = self.pack(&mut packs, &old_folder);
            self.append(src, &old_folder, &[(KIND_DELETED, old_name, version, Vec::new())]);
        }
    }

    // F5: deletes the packs of these folders
    pub fn clear(&self, folders: &[String]) {
        let mut packs = self.packs.lock().unwrap();
        for f in folders {
            let folder = Path::new(f);
            let _ = fs::remove_file(folder.join(PACK_NAME));
            let _ = fs::remove_file(self.fallback_file(folder));
            packs.remove(&folder_key(folder));
        }
    }

    // After a scan: drops thumbnails of images no longer in the folder by rewriting the
    // pack once enough of it is dead, or deleting it when nothing is left. `names` are
    // the folder's image file names.
    pub fn tidy(&self, folder: &Path, names: &[String]) {
        if !folder.is_dir() {
            return; // unreachable (network drive offline?): leave its thumbnails alone
        }
        let live: HashSet<String> = names.iter().map(|n| n.to_lowercase()).collect();
        let mut packs = self.packs.lock().unwrap();
        let pack = self.pack(&mut packs, folder);
        let Some(file) = pack.file.clone() else { return };
        let gone: u64 = pack.entries.iter().filter(|(k, _)| !live.contains(*k)).map(|(_, e)| e.record).sum();
        let dead = pack.dead + gone;
        let keep: Vec<(&String, &Entry)> = pack.entries.iter().filter(|(k, _)| live.contains(*k)).collect();
        if keep.is_empty() {
            let _ = fs::remove_file(&file);
            *pack = Pack::empty(None);
            return;
        }
        if dead < COMPACT_MIN_DEAD || (dead as f64) < pack.end as f64 * COMPACT_RATIO {
            return;
        }
        // Rewrite with only the live thumbnails, then swap the new file in
        let Ok(old) = fs::read(&file) else { return };
        let mut buf = Vec::with_capacity(pack.end as usize - dead.min(pack.end) as usize);
        buf.extend_from_slice(MAGIC);
        for (_, e) in &keep {
            let start = e.data as usize;
            let Some(data) = old.get(start..start + e.len as usize) else { return };
            buf.extend_from_slice(&encode_record(KIND_THUMB, &e.name, e.version, data));
        }
        let tmp = file.with_extension("thumbs.tmp");
        let _ = fs::remove_file(&tmp);
        let written = OpenOptions::new()
            .write(true)
            .create_new(true)
            .attributes(FILE_ATTRIBUTE_HIDDEN)
            .open(&tmp)
            .and_then(|mut f| f.write_all(&buf).and_then(|_| f.flush()));
        if written.is_ok() && fs::rename(&tmp, &file).is_ok() {
            *pack = load_pack(&file);
        } else {
            let _ = fs::remove_file(&tmp);
        }
    }
}
