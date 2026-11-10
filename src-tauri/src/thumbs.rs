// Disk thumbnail cache. Thumbnails are WebP files the renderer loads through the
// asset protocol. They're generated in renderer Web Workers, so the backend only
// stats, reads and writes files.
//
// Name: <sha1(path)>_<sha1(size|mtimeMs) prefix>.webp, the same scheme as the
// Electron build, so both share one cache. The version part means a file edited
// outside Folio gets a fresh thumbnail; the path part lets a newer thumbnail replace
// an older one for the same image instead of leaving it behind.

use regex::Regex;
use sha1::{Digest, Sha1};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static THUMB_FILE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9a-f]{40})_[0-9a-f]{16}\.webp$").unwrap());

// Thumbnails not used for this long are pruned at startup (images deleted or edited
// while Folio was closed, or folders no longer loaded). Hits refresh the age.
const THUMB_MAX_AGE: Duration = Duration::from_secs(90 * 24 * 3600);
const THUMB_TOUCH_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);

pub struct ThumbCache {
    pub dir: PathBuf,
    index: Mutex<HashMap<String, String>>, // sha1(path) → current cache file name
}

pub enum Lookup {
    Cached(PathBuf),
    Missing(PathBuf),
}

fn sha1_hex(s: &str) -> String {
    hex::encode(Sha1::digest(s.as_bytes()))
}

pub fn path_key(image_path: &str) -> String {
    sha1_hex(image_path)
}

// Node's stat().mtimeMs: seconds·1e3 + nanoseconds/1e6 as a double, printed the way
// JavaScript prints numbers (shortest round-trip, which Rust's Display also uses)
fn mtime_ms(meta: &fs::Metadata) -> String {
    let d = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).unwrap_or_default();
    let ms = d.as_secs() as f64 * 1e3 + d.subsec_nanos() as f64 / 1e6;
    format!("{}", ms)
}

impl ThumbCache {
    pub fn open(dir: PathBuf) -> Arc<Self> {
        let _ = fs::create_dir_all(&dir);
        let mut index = HashMap::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                match THUMB_FILE_RE.captures(&name) {
                    Some(m) => {
                        index.insert(m[1].to_string(), name);
                    }
                    // Anything else is from an older cache format
                    None => {
                        let _ = fs::remove_file(e.path());
                    }
                }
            }
        }
        let cache = Arc::new(ThumbCache { dir, index: Mutex::new(index) });
        let c = cache.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(15)); // off the startup path
            c.prune_old();
        });
        cache
    }

    fn prune_old(&self) {
        let cutoff = SystemTime::now() - THUMB_MAX_AGE;
        let entries: Vec<(String, String)> = self.index.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (key, f) in entries {
            let p = self.dir.join(&f);
            let old = fs::metadata(&p).and_then(|m| m.modified()).map(|t| t < cutoff).unwrap_or(false);
            if old && fs::remove_file(&p).is_ok() {
                let mut idx = self.index.lock().unwrap();
                if idx.get(&key) == Some(&f) {
                    idx.remove(&key);
                }
            }
        }
    }

    fn thumb_file(&self, image_path: &str, meta: &fs::Metadata) -> PathBuf {
        let version = sha1_hex(&format!("{}|{}", meta.len(), mtime_ms(meta)));
        self.dir.join(format!("{}_{}.webp", path_key(image_path), &version[..16]))
    }

    // None when the image itself can't be read
    pub fn lookup(&self, image_path: &str) -> Option<Lookup> {
        let meta = fs::metadata(image_path).ok()?;
        let file = self.thumb_file(image_path, &meta);
        match fs::metadata(&file).and_then(|m| m.modified()) {
            Ok(modified) => {
                // Keep thumbnails in use from being pruned as old
                if SystemTime::now().duration_since(modified).unwrap_or_default() > THUMB_TOUCH_AFTER {
                    let now = filetime::FileTime::now();
                    let _ = filetime::set_file_times(&file, now, now);
                }
                Some(Lookup::Cached(file))
            }
            Err(_) => Some(Lookup::Missing(file)),
        }
    }

    // Only accepts a cache file name handed out by lookup(), inside the cache dir
    pub fn save(&self, file: &str, bytes: &[u8]) -> Option<PathBuf> {
        let path = PathBuf::from(file);
        if path.parent() != Some(self.dir.as_path()) {
            return None;
        }
        let name = path.file_name()?.to_string_lossy().into_owned();
        let key = THUMB_FILE_RE.captures(&name)?[1].to_string();
        fs::write(&path, bytes).ok()?;
        // Replace the image's previous thumbnail (it was edited) rather than orphan it
        let mut idx = self.index.lock().unwrap();
        if let Some(prev) = idx.get(&key) {
            if *prev != name {
                let _ = fs::remove_file(self.dir.join(prev));
            }
        }
        idx.insert(key, name);
        Some(path)
    }

    pub fn clear(&self) {
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for e in entries.flatten() {
                let _ = fs::remove_file(e.path());
            }
        }
        self.index.lock().unwrap().clear();
    }

    pub fn delete_for(&self, image_path: &str) {
        if let Some(f) = self.index.lock().unwrap().remove(&path_key(image_path)) {
            let _ = fs::remove_file(self.dir.join(f));
        }
    }

    // After a rename/move (size and mtime unchanged), carry the cached thumbnail over
    pub fn rename(&self, old_path: &Path, new_path: &Path) {
        let old_key = path_key(&old_path.to_string_lossy());
        let mut idx = self.index.lock().unwrap();
        let Some(f) = idx.get(&old_key).cloned() else { return };
        let new_key = path_key(&new_path.to_string_lossy());
        let moved = format!("{}{}", new_key, &f[old_key.len()..]);
        if fs::rename(self.dir.join(&f), self.dir.join(&moved)).is_ok() {
            idx.remove(&old_key);
            idx.insert(new_key, moved);
        }
    }
}
