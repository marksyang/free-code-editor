#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod dev_commands;
mod git_service;
mod lsp;
mod lsp_commands;
mod platform;
mod session;
mod terminal;
mod terminal_font;
mod workspace;

use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, State};
use workspace::text_encoding::Encoding;

#[derive(Default)]
struct Workspace(Mutex<Option<PathBuf>>);

#[derive(Default)]
struct SearchEpoch(Arc<AtomicU64>);

#[tauri::command]
fn cancel_search(epoch: State<SearchEpoch>) {
    epoch.0.fetch_add(1, Ordering::SeqCst);
}

fn root(state: &Workspace) -> Result<PathBuf, String> {
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Open a workspace first".into())
}

#[derive(Serialize)]
struct WorkspaceInfo {
    root: String,
    files: Vec<String>,
    directories: Vec<String>,
    selected: Option<String>,
}

#[tauri::command]
async fn open_workspace(
    state: State<'_, Workspace>,
    hub: State<'_, Arc<lsp::Hub>>,
    terminal: State<'_, Arc<terminal::Manager>>,
    path: String,
) -> Result<WorkspaceInfo, String> {
    let path = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    let selected = if path.is_file() {
        Some(
            path.file_name()
                .ok_or("Invalid filename")?
                .to_string_lossy()
                .into_owned(),
        )
    } else {
        None
    };
    let directory = if selected.is_some() {
        path.parent()
            .ok_or("Missing parent directory")?
            .to_path_buf()
    } else {
        path
    };
    if !directory.is_dir() {
        return Err("Not a directory".into());
    }
    let list_root = directory.clone();
    let listing =
        tauri::async_runtime::spawn_blocking(move || workspace::directory(&list_root, ""))
            .await
            .map_err(|e| e.to_string())??;
    let hub = hub.inner().clone();
    let active_root = directory.clone();
    tauri::async_runtime::spawn_blocking(move || hub.activate_root(&active_root))
        .await
        .map_err(|e| e.to_string())?;
    terminal.activate(&directory)?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(directory.clone());
    Ok(WorkspaceInfo {
        root: directory.to_string_lossy().into_owned(),
        files: listing.files,
        directories: listing.directories,
        selected,
    })
}

#[tauri::command]
async fn read_file(state: State<'_, Workspace>, path: String) -> Result<String, String> {
    let root = root(&state)?;
    tauri::async_runtime::spawn_blocking(move || workspace::read(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct TextDocument {
    text: String,
    encoding: String,
}
#[tauri::command]
async fn read_document(
    state: State<'_, Workspace>,
    path: String,
    encoding: Option<String>,
) -> Result<TextDocument, String> {
    let root = root(&state)?;
    let encoding = Encoding::parse(encoding.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(TextDocument {
            text: workspace::read_encoded(&root, &path, encoding)?,
            encoding: encoding.label().into(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn save_file(
    state: State<'_, Workspace>,
    path: String,
    original: String,
    content: String,
    encoding: Option<String>,
) -> Result<(), String> {
    let root = root(&state)?;
    let encoding = Encoding::parse(encoding.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        workspace::save_encoded(&root, &path, &original, &content, encoding)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_file(
    state: State<'_, Workspace>,
    path: String,
    content: String,
    encoding: Option<String>,
) -> Result<(), String> {
    let root = root(&state)?;
    let encoding = Encoding::parse(encoding.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        workspace::create_encoded(&root, &path, &content, encoding)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rename_file(
    state: State<'_, Workspace>,
    path: String,
    destination: String,
    original: String,
    encoding: Option<String>,
) -> Result<(), String> {
    let root = root(&state)?;
    let encoding = Encoding::parse(encoding.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        workspace::rename_encoded(&root, &path, &destination, &original, encoding)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_files(state: State<'_, Workspace>) -> Result<Vec<String>, String> {
    let root = root(&state)?;
    tauri::async_runtime::spawn_blocking(move || workspace::list(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_workspace(state: State<'_, Workspace>) -> Result<WorkspaceInfo, String> {
    let root = root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let listing = workspace::directory(&root, "")?;
        Ok(WorkspaceInfo {
            root: root.to_string_lossy().into_owned(),
            files: listing.files,
            directories: listing.directories,
            selected: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_directory(
    state: State<'_, Workspace>,
    path: String,
) -> Result<WorkspaceInfo, String> {
    let root = root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let listing = workspace::directory(&root, &path)?;
        Ok(WorkspaceInfo {
            root: root.to_string_lossy().into_owned(),
            files: listing.files,
            directories: listing.directories,
            selected: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct SearchMatch {
    path: String,
    line: usize,
    column: usize,
    preview: String,
}

#[tauri::command]
async fn search_files(
    state: State<'_, Workspace>,
    epoch: State<'_, SearchEpoch>,
    query: String,
    case_sensitive: bool,
    directory: Option<String>,
    encoding: Option<String>,
) -> Result<Vec<SearchMatch>, String> {
    let root = root(&state)?;
    let encoding = Encoding::parse(encoding.as_deref())?;
    let cancellation = epoch.0.clone();
    let version = cancellation.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        workspace::search_encoded(
            &root,
            directory.as_deref().unwrap_or(""),
            &query,
            case_sensitive,
            encoding,
            || cancellation.load(Ordering::SeqCst) != version,
        )
        .map(|matches| {
            matches
                .into_iter()
                .map(|m| SearchMatch {
                    path: m.path,
                    line: m.line,
                    column: m.column,
                    preview: m.preview,
                })
                .collect()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct ImageAsset {
    mime: String,
    data: Vec<u8>,
}

#[tauri::command]
async fn read_image(
    state: State<'_, Workspace>,
    document: String,
    source: String,
) -> Result<ImageAsset, String> {
    let root = root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        workspace::image(&root, &document, &source).map(|(mime, data)| ImageAsset { mime, data })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn load_session(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("session.json");
    session::load(&path)
}

#[tauri::command]
fn save_session(app: tauri::AppHandle, payload: serde_json::Value) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("session.json");
    session::save(&path, &payload)
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || platform::open_external(&url))
        .await
        .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .manage(Workspace::default())
        .manage(Arc::new(lsp::Hub::default()))
        .manage(SearchEpoch::default())
        .manage(Arc::new(terminal::Manager::default()))
        .invoke_handler(tauri::generate_handler![
            dev_commands::git_status,
            dev_commands::git_history,
            dev_commands::git_commit_files,
            dev_commands::git_history_diff,
            dev_commands::git_stage,
            dev_commands::git_commit,
            dev_commands::git_diff,
            dev_commands::terminal_start,
            dev_commands::terminal_font,
            dev_commands::terminal_write,
            dev_commands::terminal_poll,
            dev_commands::terminal_resize,
            dev_commands::terminal_stop,
            open_workspace,
            read_file,
            read_document,
            save_file,
            create_file,
            rename_file,
            list_files,
            list_workspace,
            list_directory,
            search_files,
            cancel_search,
            read_image,
            load_session,
            save_session,
            open_external,
            lsp_commands::load_lsp_settings,
            lsp_commands::save_lsp_settings,
            lsp_commands::restart_lsp,
            lsp_commands::start_lsp,
            lsp_commands::sync_lsp_document,
            lsp_commands::close_lsp_document,
            lsp_commands::saved_lsp_document,
            lsp_commands::lsp_request,
            lsp_commands::cancel_lsp_request,
            lsp_commands::lsp_document_path,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<Arc<lsp::Hub>>().stop_all();
                window.state::<Arc<terminal::Manager>>().stop(None);
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to start editor")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Arc<lsp::Hub>>().stop_all();
                app.state::<Arc<terminal::Manager>>().stop(None);
            }
        });
}
