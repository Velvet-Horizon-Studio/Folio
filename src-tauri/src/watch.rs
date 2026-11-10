// Folder watchers: any image file change in a loaded folder rescans every folder and
// pushes the new list to the window, debounced so a burst of changes is one rescan.

use crate::scan_all;
use notify::{RecursiveMode, Watcher};
use std::{
    path::Path,
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(400);

pub struct FolderWatch {
    folders: Arc<Mutex<Vec<String>>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    ping: mpsc::Sender<()>,
}

impl FolderWatch {
    pub fn new(app: AppHandle) -> Self {
        let folders = Arc::new(Mutex::new(Vec::<String>::new()));
        let (ping, rx) = mpsc::channel::<()>();
        let watched = folders.clone();
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                // Wait for the burst to settle
                while rx.recv_timeout(DEBOUNCE).is_ok() {}
                let list = watched.lock().unwrap().clone();
                let _ = app.emit("images-updated", scan_all(&list));
            }
        });
        FolderWatch { folders, watcher: Mutex::new(None), ping }
    }

    pub fn set(&self, folders: Vec<String>) {
        *self.folders.lock().unwrap() = folders.clone();
        let ping = self.ping.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                if event.paths.iter().any(|p| crate::is_image(p)) {
                    let _ = ping.send(());
                }
            }
        });
        // Replacing the old watcher drops it, which stops it
        let mut slot = self.watcher.lock().unwrap();
        *slot = None;
        if let Ok(mut w) = watcher {
            for f in &folders {
                let _ = w.watch(Path::new(f), RecursiveMode::NonRecursive); // inaccessible: skip
            }
            *slot = Some(w);
        }
    }
}
