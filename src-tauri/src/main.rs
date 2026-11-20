// Folio's backend. The React renderer (src/renderer) reaches these commands through
// src/renderer/src/backend.js, which exposes them as window.folio.*.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod meta;
mod png;
mod thumbs;
mod watch;

use percent_encoding::percent_decode_str;
use rayon::prelude::*;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{ipc::Request, ipc::Response, AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use meta::SearchIndex;
use thumbs::{Lookup, ThumbCache};
use watch::FolderWatch;

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "avif", "svg"];

struct Paths {
    data: PathBuf, // config.json and thumbnails/
}

#[derive(Default)]
struct SleepBlock(Mutex<Option<keepawake::KeepAwake>>);

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub fn is_image(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn scan_folder(folder: &str) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        // fs::metadata follows symlinks, like Node's statSync
        .filter(|p| is_image(p) && fs::metadata(p).map(|m| m.is_file()).unwrap_or(false))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

#[derive(Serialize, Clone)]
pub struct ImageEntry {
    path: String,
    folder: String,
}

// Folders are scanned in parallel; the result keeps the folders' order
pub fn scan_all(folders: &[String]) -> Vec<ImageEntry> {
    folders
        .par_iter()
        .map(|f| scan_folder(f).into_iter().map(|path| ImageEntry { path, folder: f.clone() }).collect::<Vec<_>>())
        .collect::<Vec<_>>()
        .concat()
}

fn stem(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn parent(p: &Path) -> PathBuf {
    p.parent().map(Path::to_path_buf).unwrap_or_default()
}

fn header(request: &Request<'_>, name: &str) -> Option<String> {
    let raw = request.headers().get(name)?.to_str().ok()?;
    Some(percent_decode_str(raw).decode_utf8().ok()?.into_owned())
}

fn raw_body(request: &Request<'_>) -> Res<Vec<u8>> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err("expected raw bytes".into()),
    }
}

// Save dialog, modal to the main window. Must not run on the main thread.
// FOLIO_TEST_SAVE_DIR (automated tests only) answers it with that folder instead.
fn save_dialog(app: &AppHandle, title: &str, default_path: &Path, filter: (&str, &str)) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("FOLIO_TEST_SAVE_DIR") {
        return Some(PathBuf::from(dir).join(default_path.file_name()?));
    }
    let mut d = app.dialog().file().set_title(title).add_filter(filter.0, &[filter.1]);
    if let Some(w) = app.get_webview_window("main") {
        d = d.set_parent(&w);
    }
    if let Some(dir) = default_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        d = d.set_directory(dir);
    }
    if let Some(name) = default_path.file_name() {
        d = d.set_file_name(name.to_string_lossy());
    }
    d.blocking_save_file()?.into_path().ok()
}

// ── Folders and config ───────────────────────────────────────────────────────

#[tauri::command]
async fn select_folder(app: AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = app.dialog().file();
        if let Some(w) = app.get_webview_window("main") {
            d = d.set_parent(&w);
        }
        d.blocking_pick_folder()?.into_path().ok().map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn scan_images(folders: Vec<String>, cache: State<'_, Arc<ThumbCache>>) -> Res<Vec<ImageEntry>> {
    let scanned = folders.clone();
    let images = tauri::async_runtime::spawn_blocking(move || scan_all(&scanned)).await.map_err(err)?;
    // Afterwards, drop the thumbnails of images no longer in these folders (every
    // folder, including those with no images left)
    let cache = cache.inner().clone();
    let listing = images.clone();
    std::thread::spawn(move || {
        let mut names: HashMap<&str, Vec<String>> = folders.iter().map(|f| (f.as_str(), Vec::new())).collect();
        for img in &listing {
            if let (Some(list), Some(n)) = (names.get_mut(img.folder.as_str()), Path::new(&img.path).file_name()) {
                list.push(n.to_string_lossy().into_owned());
            }
        }
        for (folder, files) in names {
            cache.tidy(Path::new(folder), &files);
        }
    });
    Ok(images)
}

#[derive(Serialize)]
struct DroppedImage {
    path: String,
    folder: String, // its parent folder, the form scan_images reports it in
}

#[derive(Serialize)]
struct DropContents {
    folders: Vec<String>,
    images: Vec<DroppedImage>,
}

// Paths dropped on the window: the folders, and the image files (other files are
// ignored)
#[tauri::command]
fn classify_drop(paths: Vec<String>) -> DropContents {
    let mut out = DropContents { folders: vec![], images: vec![] };
    for p in paths {
        let path = Path::new(&p);
        if path.is_dir() {
            out.folders.push(p);
        } else if path.is_file() && is_image(path) {
            out.images.push(DroppedImage { folder: parent(path).to_string_lossy().into_owned(), path: p });
        }
    }
    out
}

#[tauri::command]
fn load_config(paths: State<'_, Paths>) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(paths.data.join("config.json")).ok()?).ok()
}

#[tauri::command]
fn save_config(config: Value, paths: State<'_, Paths>) {
    if let Ok(json) = serde_json::to_string_pretty(&config) {
        let _ = fs::write(paths.data.join("config.json"), json); // ignore write errors
    }
}

#[tauri::command]
fn watch_folders(folders: Vec<String>, watch: State<'_, FolderWatch>) {
    watch.set(folders);
}

// ── Thumbnails and image bytes ───────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum ThumbLookup {
    Cached(String),
    Missing(String),
}

// For each path: { cached: token } when the folder's thumbnail file has a current
// thumbnail (served at thumb://<path>), { missing: token } when one must be generated
// and saved with that token, null when the image itself can't be read. Batched
// because each IPC call costs the webview's UI thread a few ms, and scrolling the
// grid mounts many thumbnails per frame.
#[tauri::command]
async fn get_thumbnails(paths: Vec<String>, cache: State<'_, Arc<ThumbCache>>) -> Res<Vec<Option<ThumbLookup>>> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        cache
            .lookup_many(&paths)
            .into_iter()
            .map(|l| {
                l.map(|l| match l {
                    Lookup::Cached(v) => ThumbLookup::Cached(v.token()),
                    Lookup::Missing(v) => ThumbLookup::Missing(v.token()),
                })
            })
            .collect()
    })
    .await
    .map_err(err)
}

// F5: deletes the thumbnail files of these folders
#[tauri::command]
async fn clear_thumbnail_cache(folders: Vec<String>, cache: State<'_, Arc<ThumbCache>>) -> Res<bool> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.clear(&folders)).await.map_err(err)?;
    Ok(true)
}

// Raw file bytes for renderer-side (Chromium) decoding, sent as an ArrayBuffer
#[tauri::command]
async fn read_image_bytes(path: String) -> Res<Response> {
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(path)).await.map_err(err)?.map_err(err)?;
    Ok(Response::new(bytes))
}

// Several generated thumbnails in one call (batched like get_thumbnails), stored in
// their folders' thumbnail files. Body: their WebP bytes, concatenated. Header
// x-files: JSON [[image path, token from get_thumbnails, byte length], ...] in body
// order. Returns each stored thumbnail's token, or null.
#[tauri::command]
async fn save_thumbnails(request: Request<'_>, cache: State<'_, Arc<ThumbCache>>) -> Res<Vec<Option<String>>> {
    let files: Vec<(String, String, usize)> =
        serde_json::from_str(&header(&request, "x-files").ok_or("missing x-files")?).map_err(err)?;
    let body = raw_body(&request)?;
    if files.iter().map(|(_, _, len)| len).sum::<usize>() != body.len() {
        return Err("x-files lengths don't match the body".into());
    }
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut offset = 0;
        let items = files
            .into_iter()
            .map(|(path, token, len)| {
                let bytes = &body[offset..offset + len];
                offset += len;
                (path, token, bytes)
            })
            .collect();
        cache.save_many(items)
    })
    .await
    .map_err(err)
}

// thumb://<percent-encoded image path>: the image's thumbnail from its folder's
// thumbnail file (the query string, a version token, only busts the webview's cache)
fn serve_thumbnail(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let path = percent_decode_str(request.uri().path().trim_start_matches('/')).decode_utf8_lossy().into_owned();
    let bytes = app.state::<Arc<ThumbCache>>().read(Path::new(&path));
    let builder = tauri::http::Response::builder().header("Access-Control-Allow-Origin", "*");
    match bytes {
        Some(b) => builder.status(200).header("Content-Type", "image/webp").body(b),
        None => builder.status(404).body(Vec::new()),
    }
    .unwrap()
}

// ── Editing and file operations ──────────────────────────────────────────────

// Resize/crop editor and bulk resize output. The renderer encodes the result; this
// writes it to a new file chosen in a save dialog ('new'), to a new file next to the
// source with a suffix and no dialog ('sibling', for bulk), or over the original
// ('overwrite'), which goes to the Recycle Bin first so it can be undone.
// Body: encoded bytes. Headers: x-source, x-ext, x-mode, x-suffix.
#[tauri::command]
async fn save_edited_image(request: Request<'_>, app: AppHandle, cache: State<'_, Arc<ThumbCache>>) -> Res<Option<String>> {
    let source = PathBuf::from(header(&request, "x-source").ok_or("missing x-source")?);
    let ext = header(&request, "x-ext").ok_or("missing x-ext")?;
    let mode = header(&request, "x-mode").unwrap_or_else(|| "new".into());
    let suffix = header(&request, "x-suffix").filter(|s| !s.is_empty()).unwrap_or_else(|| "_edit".into());
    let mut out = raw_body(&request)?;
    let cache = cache.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        if ext == "png" {
            if let Ok(src) = fs::read(&source) {
                out = png::copy_text_chunks(&src, out);
            }
        }
        let dir = parent(&source);
        let target = match mode.as_str() {
            "new" => {
                let default = dir.join(format!("{}_edit.{}", stem(&source), ext));
                match save_dialog(&app, "Save edited image", &default, (&ext.to_uppercase(), &ext)) {
                    Some(p) => p,
                    None => return Ok(None),
                }
            }
            "sibling" => {
                let mut t = dir.join(format!("{}{}.{}", stem(&source), suffix, ext));
                let mut n = 2;
                while t.exists() {
                    t = dir.join(format!("{}{}_{}.{}", stem(&source), suffix, n, ext));
                    n += 1;
                }
                t
            }
            _ => source.clone(),
        };
        if target.exists() {
            cache.delete_for(&target.to_string_lossy());
            trash::delete(&target).map_err(err)?;
        }
        fs::write(&target, out).map_err(err)?;
        Ok(Some(target.to_string_lossy().into_owned()))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn trash_image(path: String, cache: State<'_, Arc<ThumbCache>>) -> Res<()> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        cache.delete_for(&path);
        trash::delete(&path).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn rename_image(old_path: String, new_name: String, cache: State<'_, Arc<ThumbCache>>) -> Res<String> {
    let old = PathBuf::from(&old_path);
    let ext = old.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let new = parent(&old).join(format!("{}{}", new_name, ext));
    fs::rename(&old, &new).map_err(err)?;
    cache.rename(&old, &new);
    Ok(new.to_string_lossy().into_owned())
}

fn move_one(source: &Path, target_folder: &str, cache: &ThumbCache) -> Res<PathBuf> {
    let dest = Path::new(target_folder).join(source.file_name().ok_or("no file name")?);
    if source != dest {
        fs::rename(source, &dest).map_err(err)?;
        cache.rename(source, &dest);
    }
    Ok(dest)
}

#[tauri::command]
fn move_image(source_path: String, target_folder: String, cache: State<'_, Arc<ThumbCache>>) -> Res<String> {
    move_one(Path::new(&source_path), &target_folder, &cache).map(|p| p.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveResult {
    source_path: String,
    dest_path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[tauri::command]
async fn move_images_bulk(paths: Vec<String>, target_folder: String, cache: State<'_, Arc<ThumbCache>>) -> Res<Vec<MoveResult>> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|source_path| {
                let src = PathBuf::from(&source_path);
                let dest = Path::new(&target_folder).join(src.file_name().unwrap_or_default());
                let res = move_one(&src, &target_folder, &cache);
                MoveResult {
                    source_path,
                    dest_path: dest.to_string_lossy().into_owned(),
                    ok: res.is_ok(),
                    error: res.err(),
                }
            })
            .collect()
    })
    .await
    .map_err(err)
}

// Decode → re-encode as PNG or JPEG (quality 92, transparency flattened onto white)
fn convert_bytes(source: &Path, format: &str) -> Res<Vec<u8>> {
    let img = image::ImageReader::open(source).map_err(err)?.with_guessed_format().map_err(err)?.decode().map_err(err)?;
    let mut buf = Vec::new();
    if format == "jpeg" {
        let rgba = img.to_rgba8();
        let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
        for (o, p) in rgb.pixels_mut().zip(rgba.pixels()) {
            let a = p[3] as u32;
            for c in 0..3 {
                o[c] = ((p[c] as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
            }
        }
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 92).encode_image(&rgb).map_err(err)?;
    } else {
        img.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png).map_err(err)?;
    }
    Ok(buf)
}

fn format_ext(format: &str) -> &str {
    if format == "jpeg" { "jpg" } else { format }
}

#[tauri::command]
async fn convert_image(source_path: String, format: String, app: AppHandle) -> Res<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = PathBuf::from(&source_path);
        let ext = format_ext(&format);
        let default = parent(&src).join(format!("{}.{}", stem(&src), ext));
        let title = format!("Save as {}", format.to_uppercase());
        let Some(target) = save_dialog(&app, &title, &default, (&format.to_uppercase(), ext)) else { return Ok(None) };
        fs::write(&target, convert_bytes(&src, &format)?).map_err(err)?;
        Ok(Some(target.to_string_lossy().into_owned()))
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
struct ConvertSummary {
    success: usize,
    failed: usize,
}

#[tauri::command]
async fn convert_images_bulk(paths: Vec<String>, format: String) -> Res<ConvertSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let ok: Vec<bool> = paths
            .par_iter()
            .map(|p| {
                let src = PathBuf::from(p);
                let out = parent(&src).join(format!("{}.{}", stem(&src), format_ext(&format)));
                convert_bytes(&src, &format).and_then(|b| fs::write(out, b).map_err(err)).is_ok()
            })
            .collect();
        let success = ok.iter().filter(|o| **o).count();
        ConvertSummary { success, failed: ok.len() - success }
    })
    .await
    .map_err(err)
}

// Put the file on the clipboard as CF_HDROP so it can be pasted in Explorer
#[tauri::command]
fn copy_image(file_path: String) -> bool {
    let Ok(_clip) = clipboard_win::Clipboard::new_attempts(10) else { return false };
    let _ = clipboard_win::raw::empty();
    clipboard_win::raw::set_file_list(&[file_path.as_str()]).is_ok()
}

#[tauri::command]
async fn save_text_file(default_path: String, content: String, app: AppHandle) -> Res<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(target) = save_dialog(&app, "Save parameters", Path::new(&default_path), ("Text", "txt")) else { return Ok(false) };
        fs::write(target, content).map_err(err)?;
        Ok(true)
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
struct ImageMetadata {
    name: String,
    ext: String,
    size: u64,
    width: usize,
    height: usize,
    created: String,
    modified: String,
    sd: Option<png::SdParams>,
    // Other text metadata (EXIF, XMP, PNG text): [label, value] pairs
    fields: Vec<(String, String)>,
}

fn iso(t: std::io::Result<std::time::SystemTime>) -> String {
    t.map(|t| humantime::format_rfc3339_millis(t).to_string()).unwrap_or_default()
}

#[tauri::command]
async fn get_image_metadata(file_path: String) -> Res<ImageMetadata> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&file_path);
        let meta = fs::metadata(&p).map_err(err)?;
        // Header-only read: every format Folio lists, without decoding the pixels
        let (width, height) = imagesize::size(&p).map(|s| (s.width, s.height)).unwrap_or((0, 0));
        let ext = p.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
        let m = meta::read(&p);
        Ok(ImageMetadata {
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            ext: ext.to_uppercase(),
            size: meta.len(),
            width,
            height,
            created: iso(meta.created()),
            modified: iso(meta.modified()),
            sd: meta::parse_sd(&m),
            fields: m.fields,
        })
    })
    .await
    .map_err(err)?
}

// Images whose file name, dimensions or text metadata match the query: indexes into
// `paths`. Metadata is read once per image and kept while the file is unchanged.
#[tauri::command]
async fn search_images(paths: Vec<String>, query: String, index: State<'_, Arc<SearchIndex>>) -> Res<Vec<u32>> {
    let index = index.inner().clone();
    tauri::async_runtime::spawn_blocking(move || index.search(&paths, &query)).await.map_err(err)
}

// ── Window and app ───────────────────────────────────────────────────────────

// Keeps the display awake while a slideshow plays
#[tauri::command]
fn set_prevent_sleep(enable: bool, block: State<'_, SleepBlock>) -> bool {
    let mut slot = block.0.lock().unwrap();
    if enable && slot.is_none() {
        *slot = keepawake::Builder::default()
            .display(true)
            .reason("Slideshow playing")
            .app_name("Folio")
            .app_reverse_domain("com.velvethorizon.folio")
            .create()
            .ok();
    } else if !enable {
        *slot = None; // dropping the guard releases it
    }
    slot.is_some()
}

#[tauri::command]
fn get_readme() -> &'static str {
    include_str!("../../README.MD")
}

fn data_dir(app: &AppHandle) -> PathBuf {
    // %APPDATA%\Folio is where Folio 1.1 (Electron) kept its data: using it keeps
    // folders and settings on upgrade.
    // FOLIO_DATA_DIR overrides it (automated tests use a scratch folder).
    if let Some(d) = std::env::var_os("FOLIO_DATA_DIR") {
        return PathBuf::from(d);
    }
    std::env::var_os("APPDATA")
        .map(|d| PathBuf::from(d).join("Folio"))
        .or_else(|| app.path().app_data_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || responder.respond(serve_thumbnail(&app, &request)));
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let data = data_dir(&handle);
            let _ = fs::create_dir_all(&data);
            app.manage(ThumbCache::open(data.join("thumbnails")));
            app.manage(Paths { data });
            app.manage(FolderWatch::new(handle));
            app.manage(SleepBlock::default());
            app.manage(Arc::new(SearchIndex::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            select_folder,
            scan_images,
            classify_drop,
            load_config,
            save_config,
            watch_folders,
            get_thumbnails,
            clear_thumbnail_cache,
            read_image_bytes,
            save_thumbnails,
            save_edited_image,
            trash_image,
            rename_image,
            move_image,
            move_images_bulk,
            convert_image,
            convert_images_bulk,
            copy_image,
            save_text_file,
            get_image_metadata,
            search_images,
            set_prevent_sleep,
            get_readme
        ])
        .run(tauri::generate_context!())
        .expect("error while running Folio");
}
