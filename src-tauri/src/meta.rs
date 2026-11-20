// Text metadata of an image, for the info card and the metadata search: PNG text
// chunks (Stable Diffusion / ComfyUI parameters, descriptions), EXIF (camera, dates,
// comments, Windows tags), XMP (titles, keywords) and JPEG comments. Only the metadata
// is read: the pixel data is skipped, so this costs a few small reads per file.

use crate::png;
use rayon::prelude::*;
use regex::Regex;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufReader, Read, Seek, SeekFrom},
    path::Path,
    sync::{Arc, LazyLock, Mutex},
    time::SystemTime,
};

// Larger metadata blocks are skipped (nothing real comes close)
const MAX_BLOCK: u64 = 16 << 20;
// Per field and per image, in the search index
const MAX_FIELD_TEXT: usize = 16 << 10;
const MAX_SEARCH_TEXT: usize = 64 << 10;

#[derive(Default)]
pub struct Metadata {
    // A1111-style generation parameters (PNG "parameters" chunk or EXIF user comment)
    pub sd_raw: Option<String>,
    // (label, value) pairs for display, in file order
    pub fields: Vec<(String, String)>,
    // Extra searchable text that isn't worth showing (all of XMP, strings in JSON)
    search: Vec<String>,
}

impl Metadata {
    fn add(&mut self, label: &str, value: String) {
        let value = value.trim_matches(|c: char| c == '\0' || c.is_whitespace()).to_string();
        if value.is_empty() {
            return;
        }
        // Stable Diffusion parameters are shown (and parsed) separately
        if self.sd_raw.is_none() && looks_like_sd(&value) && matches!(label, "parameters" | "User comment" | "Comment" | "Description") {
            self.sd_raw = Some(value);
            return;
        }
        if self.fields.iter().any(|(l, v)| l == label && *v == value) {
            return;
        }
        self.fields.push((label.to_string(), value));
    }
}

fn looks_like_sd(s: &str) -> bool {
    s.contains("Steps: ") && (s.contains("Sampler: ") || s.contains("CFG scale: ") || s.contains("Seed: "))
}

pub fn read(path: &Path) -> Metadata {
    let mut m = Metadata::default();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let Ok(f) = File::open(path) else { return m };
    let mut r = BufReader::with_capacity(16 << 10, f);
    let mut magic = [0u8; 12];
    if r.read_exact(&mut magic).is_err() || r.seek(SeekFrom::Start(0)).is_err() {
        return m;
    }
    // By content, not extension: a WebP saved as .jpg is still read
    let _ = if magic.starts_with(b"\x89PNG") {
        read_png(&mut r, &mut m)
    } else if magic.starts_with(&[0xFF, 0xD8]) {
        read_jpeg(&mut r, &mut m)
    } else if magic.starts_with(b"RIFF") && &magic[8..12] == b"WEBP" {
        read_webp(&mut r, &mut m)
    } else if (magic.starts_with(b"II*\0") || magic.starts_with(b"MM\0*")) && matches!(ext.as_str(), "tif" | "tiff") {
        read_tiff(&mut r, &mut m)
    } else {
        Ok(())
    };
    m
}

fn read_block<R: Read>(r: &mut R, len: u64) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(len as usize);
    r.take(len).read_to_end(&mut buf)?;
    if (buf.len() as u64) < len {
        return Err(std::io::ErrorKind::UnexpectedEof.into());
    }
    Ok(buf)
}

fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(data).take(MAX_BLOCK).read_to_end(&mut out).ok()?;
    Some(out)
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

// ── PNG ──────────────────────────────────────────────────────────────────────

fn read_png<R: Read + Seek>(r: &mut R, m: &mut Metadata) -> std::io::Result<()> {
    r.seek(SeekFrom::Start(8))?;
    loop {
        let mut head = [0u8; 8];
        if r.read_exact(&mut head).is_err() {
            return Ok(());
        }
        let len = u32::from_be_bytes(head[..4].try_into().unwrap()) as u64;
        let ty = &head[4..8];
        match ty {
            b"IEND" => return Ok(()),
            b"tEXt" | b"zTXt" | b"iTXt" | b"eXIf" if len <= MAX_BLOCK => {
                let data = read_block(r, len)?;
                r.seek(SeekFrom::Current(4))?; // CRC
                png_text_chunk(ty, &data, m);
            }
            _ => {
                r.seek(SeekFrom::Current(len as i64 + 4))?;
            }
        }
    }
}

fn png_text_chunk(ty: &[u8], data: &[u8], m: &mut Metadata) {
    if ty == b"eXIf" {
        exif(data, m);
        return;
    }
    let Some(nul) = data.iter().position(|&b| b == 0) else { return };
    let key = latin1(&data[..nul]);
    let rest = &data[nul + 1..];
    let text = match ty {
        b"tEXt" => latin1(rest),
        b"zTXt" => match rest.split_first() {
            Some((0, z)) => inflate(z).map(|b| latin1(&b)).unwrap_or_default(),
            _ => return,
        },
        _ => {
            // iTXt: compressed flag, method, language\0, translated keyword\0, UTF-8 text
            if rest.len() < 2 {
                return;
            }
            let compressed = rest[0] == 1;
            let mut p = &rest[2..];
            for _ in 0..2 {
                match p.iter().position(|&b| b == 0) {
                    Some(i) => p = &p[i + 1..],
                    None => return,
                }
            }
            let bytes = if compressed { inflate(p).unwrap_or_default() } else { p.to_vec() };
            String::from_utf8_lossy(&bytes).into_owned()
        }
    };
    match key.as_str() {
        "XML:com.adobe.xmp" => xmp(&text, m),
        "parameters" => m.add("parameters", text),
        // ComfyUI: the node graph and the prompt as JSON. Their strings are searchable;
        // the graph itself is only listed by size.
        "workflow" => {
            json_strings(&text, m);
            m.fields.push(("ComfyUI workflow".into(), format!("{} KB of node graph", (text.len() + 1023) / 1024)));
        }
        "prompt" if text.trim_start().starts_with('{') => {
            json_strings(&text, m);
            m.fields.push(("ComfyUI prompt".into(), format!("{} KB of node settings", (text.len() + 1023) / 1024)));
        }
        _ => m.add(&key, text),
    }
}

// Every string value in a JSON document, as searchable text
fn json_strings(text: &str, m: &mut Metadata) {
    fn walk(v: &serde_json::Value, out: &mut String) {
        match v {
            serde_json::Value::String(s) => {
                if out.len() < MAX_FIELD_TEXT * 4 {
                    out.push_str(s);
                    out.push('\n');
                }
            }
            serde_json::Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            serde_json::Value::Object(o) => o.values().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        let mut out = String::new();
        walk(&v, &mut out);
        m.search.push(out);
    }
}

// ── JPEG ─────────────────────────────────────────────────────────────────────

const XMP_NS: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

fn read_jpeg<R: Read + Seek>(r: &mut R, m: &mut Metadata) -> std::io::Result<()> {
    r.seek(SeekFrom::Start(2))?;
    loop {
        let mut b = [0u8; 2];
        r.read_exact(&mut b)?;
        if b[0] != 0xFF {
            return Ok(());
        }
        let marker = b[1];
        if marker == 0xFF {
            r.seek(SeekFrom::Current(-1))?; // fill byte
            continue;
        }
        // Start of scan / end of image: the metadata segments are all before
        if marker == 0xDA || marker == 0xD9 {
            return Ok(());
        }
        if (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            continue;
        }
        r.read_exact(&mut b)?;
        let len = u16::from_be_bytes(b) as u64;
        if len < 2 {
            return Ok(());
        }
        let len = len - 2;
        match marker {
            0xE1 | 0xFE => {
                let data = read_block(r, len)?;
                if marker == 0xFE {
                    m.add("Comment", String::from_utf8_lossy(&data).into_owned());
                } else if let Some(tiff) = data.strip_prefix(b"Exif\0\0") {
                    exif(tiff, m);
                } else if let Some(x) = data.strip_prefix(XMP_NS) {
                    xmp(&String::from_utf8_lossy(x), m);
                }
            }
            _ => {
                r.seek(SeekFrom::Current(len as i64))?;
            }
        }
    }
}

// ── WebP ─────────────────────────────────────────────────────────────────────

fn read_webp<R: Read + Seek>(r: &mut R, m: &mut Metadata) -> std::io::Result<()> {
    r.seek(SeekFrom::Start(12))?;
    loop {
        let mut head = [0u8; 8];
        if r.read_exact(&mut head).is_err() {
            return Ok(());
        }
        let len = u32::from_le_bytes(head[4..].try_into().unwrap()) as u64;
        let padded = len + (len & 1);
        match &head[..4] {
            b"EXIF" | b"XMP " if len <= MAX_BLOCK => {
                let data = read_block(r, len)?;
                if len != padded {
                    r.seek(SeekFrom::Current(1))?;
                }
                if &head[..4] == b"EXIF" {
                    exif(data.strip_prefix(b"Exif\0\0").unwrap_or(&data), m);
                } else {
                    xmp(&String::from_utf8_lossy(&data), m);
                }
            }
            _ => {
                r.seek(SeekFrom::Current(padded as i64))?;
            }
        }
    }
}

// ── TIFF ─────────────────────────────────────────────────────────────────────

fn read_tiff<R: Read + Seek>(r: &mut R, m: &mut Metadata) -> std::io::Result<()> {
    // The tags are near the start in practice; the strips are skipped
    let mut buf = Vec::new();
    r.take(1 << 20).read_to_end(&mut buf)?;
    exif(&buf, m);
    Ok(())
}

// ── EXIF ─────────────────────────────────────────────────────────────────────

struct Tiff<'a> {
    b: &'a [u8],
    le: bool,
}

impl Tiff<'_> {
    fn u16(&self, at: usize) -> Option<u16> {
        let s: [u8; 2] = self.b.get(at..at + 2)?.try_into().ok()?;
        Some(if self.le { u16::from_le_bytes(s) } else { u16::from_be_bytes(s) })
    }
    fn u32(&self, at: usize) -> Option<u32> {
        let s: [u8; 4] = self.b.get(at..at + 4)?.try_into().ok()?;
        Some(if self.le { u32::from_le_bytes(s) } else { u32::from_be_bytes(s) })
    }
    // (tag, type, count, value bytes) of each entry of the IFD at `at`
    fn entries(&self, at: usize) -> Vec<(u16, u16, usize, &[u8])> {
        let mut out = Vec::new();
        let Some(n) = self.u16(at) else { return out };
        for i in 0..n.min(512) as usize {
            let e = at + 2 + i * 12;
            let (Some(tag), Some(ty), Some(count)) = (self.u16(e), self.u16(e + 2), self.u32(e + 4)) else { break };
            let unit = match ty {
                1 | 2 | 6 | 7 => 1,
                3 | 8 => 2,
                4 | 9 | 11 => 4,
                5 | 10 | 12 => 8,
                _ => continue,
            };
            let size = unit * count as usize;
            let data = if size <= 4 {
                self.b.get(e + 8..e + 8 + size)
            } else {
                self.u32(e + 8).and_then(|off| self.b.get(off as usize..off as usize + size))
            };
            if let Some(d) = data {
                out.push((tag, ty, count as usize, d));
            }
        }
        out
    }
}

fn utf16(b: &[u8], le: bool) -> String {
    let units: Vec<u16> = b
        .chunks_exact(2)
        .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
        .collect();
    String::from_utf16_lossy(&units)
}

fn ascii(b: &[u8]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    match std::str::from_utf8(&b[..end]) {
        Ok(s) => s.to_string(),
        Err(_) => latin1(&b[..end]),
    }
}

// EXIF UserComment: an 8-byte character code, then the text. "UNICODE" is UTF-16 in
// either byte order depending on the writer (A1111 writes big-endian), so guess it from
// where the zero bytes of ASCII-range characters fall.
fn user_comment(b: &[u8], le_file: bool) -> String {
    if b.len() < 8 {
        return String::new();
    }
    let (code, text) = b.split_at(8);
    if code.starts_with(b"UNICODE") {
        let even_zeros = text.iter().step_by(2).filter(|&&c| c == 0).count();
        let odd_zeros = text.iter().skip(1).step_by(2).filter(|&&c| c == 0).count();
        let le = if even_zeros == odd_zeros { le_file } else { odd_zeros > even_zeros };
        utf16(text, le)
    } else {
        String::from_utf8_lossy(text).trim_end_matches('\0').to_string()
    }
}

fn exif(b: &[u8], m: &mut Metadata) {
    let le = match b.get(..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return,
    };
    let t = Tiff { b, le };
    let Some(ifd0) = t.u32(4) else { return };
    let mut sub = None;
    for (tag, ty, _, d) in t.entries(ifd0 as usize) {
        let label = match tag {
            0x010E => "Description",
            0x010F => "Camera make",
            0x0110 => "Camera model",
            0x0131 => "Software",
            0x013B => "Artist",
            0x8298 => "Copyright",
            0x9C9B => "Title",
            0x9C9C => "Comment",
            0x9C9D => "Author",
            0x9C9E => "Keywords",
            0x9C9F => "Subject",
            0x8769 => {
                // Exif sub-IFD offset: a LONG in the file's byte order
                if ty == 4 {
                    sub = <[u8; 4]>::try_from(d).ok().map(|a| if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) });
                }
                continue;
            }
            _ => continue,
        };
        // Windows' XP* tags are UTF-16LE whatever the file's byte order
        let value = if (0x9C9B..=0x9C9F).contains(&tag) { utf16(d, true) } else { ascii(d) };
        m.add(label, value);
    }
    if let Some(off) = sub {
        for (tag, _, _, d) in t.entries(off as usize) {
            match tag {
                0x9003 => m.add("Date taken", ascii(d)),
                0x9286 => m.add("User comment", user_comment(d, le)),
                0xA434 => m.add("Lens", ascii(d)),
                _ => {}
            }
        }
    }
}

// ── XMP ──────────────────────────────────────────────────────────────────────

static XMP_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").unwrap());
static XMP_ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\s([A-Za-z][\w.-]*:[\w.-]+)="([^"]*)""#).unwrap());
static XMP_LI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<rdf:li[^>]*>(.*?)</rdf:li>").unwrap());

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#xA;", "\n").replace("&amp;", "&")
}

fn xmp(x: &str, m: &mut Metadata) {
    // The common Dublin Core fields are shown; everything (text and attribute values)
    // is searchable
    for (tag, label) in [("dc:title", "Title"), ("dc:description", "Description"), ("dc:creator", "Author"), ("dc:subject", "Keywords"), ("dc:rights", "Copyright")] {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        if let (Some(a), Some(b)) = (x.find(&open), x.find(&close)) {
            if a < b {
                let inner = &x[a + open.len()..b];
                let items: Vec<String> = XMP_LI.captures_iter(inner).map(|c| unescape(c[1].trim())).filter(|s| !s.is_empty()).collect();
                let value = if items.is_empty() { unescape(XMP_TAG.replace_all(inner, " ").trim()) } else { items.join(", ") };
                m.add(label, value);
            }
        }
    }
    for c in XMP_ATTR.captures_iter(x) {
        if c[1].starts_with("xmlns") {
            continue;
        }
        if &c[1] == "xmp:CreatorTool" {
            m.add("Software", unescape(&c[2]));
        }
    }
    let mut text = String::new();
    for c in XMP_ATTR.captures_iter(x) {
        if !c[1].starts_with("xmlns") && !c[2].starts_with("uuid:") && !c[2].starts_with("xmp.") {
            text.push_str(&unescape(&c[2]));
            text.push('\n');
        }
    }
    for part in XMP_TAG.split(x) {
        let p = part.trim();
        if !p.is_empty() {
            text.push_str(&unescape(p));
            text.push('\n');
        }
    }
    m.search.push(text);
}

// ── Search ───────────────────────────────────────────────────────────────────

fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// Everything a search matches against, lowercased: file name, format, dimensions and
// all the metadata text
fn search_text(path: &Path) -> String {
    let mut s = String::new();
    if let Some(n) = path.file_name() {
        s.push_str(&n.to_string_lossy());
        s.push('\n');
    }
    if let Ok(sz) = imagesize::size(path) {
        s.push_str(&format!("{}x{} {} × {}\n", sz.width, sz.height, sz.width, sz.height));
    }
    let m = read(path);
    if let Some(sd) = &m.sd_raw {
        s.push_str(truncate(sd, MAX_FIELD_TEXT));
        s.push('\n');
    }
    for (label, value) in &m.fields {
        s.push_str(label);
        s.push_str(": ");
        s.push_str(truncate(value, MAX_FIELD_TEXT));
        s.push('\n');
    }
    for t in &m.search {
        if s.len() >= MAX_SEARCH_TEXT {
            break;
        }
        s.push_str(truncate(t, MAX_FIELD_TEXT));
        s.push('\n');
    }
    truncate(&s, MAX_SEARCH_TEXT).to_lowercase()
}

// Search terms: words or "quoted phrases", all of which must appear; a leading -
// excludes. Case-insensitive.
struct Query {
    include: Vec<String>,
    exclude: Vec<String>,
}

fn parse_query(q: &str) -> Query {
    let mut include = Vec::new();
    let mut exclude = Vec::new();
    let mut chars = q.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let Some(&c) = chars.peek() else { break };
        let negate = c == '-';
        if negate {
            chars.next();
        }
        let mut term = String::new();
        if chars.peek() == Some(&'"') {
            chars.next();
            for c in chars.by_ref() {
                if c == '"' {
                    break;
                }
                term.push(c);
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                term.push(c);
                chars.next();
            }
        }
        let term = term.trim().to_lowercase();
        if term.is_empty() {
            continue;
        }
        if negate { exclude.push(term) } else { include.push(term) }
    }
    Query { include, exclude }
}

// Search text of each image, kept while its size and modification time are unchanged
#[derive(Default)]
pub struct SearchIndex {
    entries: Mutex<HashMap<String, (u64, Option<SystemTime>, Arc<str>)>>,
}

impl SearchIndex {
    fn text(&self, path: &str) -> Option<Arc<str>> {
        let meta = fs::metadata(path).ok()?;
        let stamp = (meta.len(), meta.modified().ok());
        if let Some((len, mtime, text)) = self.entries.lock().unwrap().get(path) {
            if (*len, *mtime) == stamp {
                return Some(text.clone());
            }
        }
        let text: Arc<str> = search_text(Path::new(path)).into();
        self.entries.lock().unwrap().insert(path.to_string(), (stamp.0, stamp.1, text.clone()));
        Some(text)
    }

    // Indexes (into `paths`) of the images matching `query`. An empty query matches
    // everything, and still reads every image's metadata (warming the index).
    pub fn search(&self, paths: &[String], query: &str) -> Vec<u32> {
        let q = parse_query(query);
        let hits: Vec<u32> = paths
            .par_iter()
            .enumerate()
            .filter_map(|(i, p)| {
                let text = self.text(p)?;
                let ok = q.include.iter().all(|t| text.contains(t.as_str())) && !q.exclude.iter().any(|t| text.contains(t.as_str()));
                ok.then_some(i as u32)
            })
            .collect();
        // Forget images no longer listed (deleted, renamed, folders removed)
        if q.include.is_empty() && q.exclude.is_empty() {
            let keep: std::collections::HashSet<&str> = paths.iter().map(String::as_str).collect();
            self.entries.lock().unwrap().retain(|k, _| keep.contains(k.as_str()));
        }
        hits
    }
}

pub fn parse_sd(m: &Metadata) -> Option<png::SdParams> {
    m.sd_raw.as_deref().map(png::parse_sd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_terms() {
        let q = parse_query(r#"  Cat "red hat" -dog -"blue sky" "#);
        assert_eq!(q.include, vec!["cat", "red hat"]);
        assert_eq!(q.exclude, vec!["dog", "blue sky"]);
    }

    #[test]
    fn user_comment_byte_order() {
        let mut be = b"UNICODE\0".to_vec();
        for c in "Steps: 20".encode_utf16() {
            be.extend_from_slice(&c.to_be_bytes());
        }
        assert_eq!(user_comment(&be, true), "Steps: 20");
        let mut le = b"UNICODE\0".to_vec();
        for c in "Steps: 20".encode_utf16() {
            le.extend_from_slice(&c.to_le_bytes());
        }
        assert_eq!(user_comment(&le, false), "Steps: 20");
    }
}
