use crate::{git_service, root, terminal, Workspace};
use tauri::State;
#[tauri::command]
pub async fn git_status(
    state: State<'_, Workspace>,
    workspace_root: String,
) -> Result<git_service::Status, String> {
    let root = root(&state)?;
    if root.to_string_lossy() != workspace_root {
        return Err("Workspace changed; retry the action".into());
    }
    tauri::async_runtime::spawn_blocking(move || git_service::status(&root))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn git_stage(
    state: State<'_, Workspace>,
    workspace_root: String,
    path: String,
    undo: bool,
    original: Option<String>,
) -> Result<(), String> {
    let root = root(&state)?;
    if root.to_string_lossy() != workspace_root {
        return Err("Workspace changed; retry the action".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        git_service::stage(&root, &path, undo, original.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn git_commit(
    state: State<'_, Workspace>,
    workspace_root: String,
    message: String,
) -> Result<(), String> {
    let root = root(&state)?;
    if root.to_string_lossy() != workspace_root {
        return Err("Workspace changed; retry the action".into());
    }
    tauri::async_runtime::spawn_blocking(move || git_service::commit(&root, &message))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn git_diff(
    state: State<'_, Workspace>,
    workspace_root: String,
    path: String,
    staged: bool,
    original: Option<String>,
    encoding: Option<String>,
) -> Result<git_service::Diff, String> {
    let root = root(&state)?;
    let encoding = crate::workspace::text_encoding::Encoding::parse(encoding.as_deref())?;
    if root.to_string_lossy() != workspace_root {
        return Err("Workspace changed; retry the action".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        git_service::diff_encoded(&root, &path, staged, original.as_deref(), encoding)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn git_history(
    state: State<'_, Workspace>,
    workspace_root: String,
    offset: u32,
    anchor: Option<String>,
) -> Result<git_service::History, String> {
    let root = root(&state)?;
    if root.to_string_lossy() != workspace_root {
        return Err("Workspace changed; retry the action".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        git_service::history(&root, offset, anchor.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn git_commit_files(
    state: State<'_, Workspace>,
    workspace_root: String,
    revision: String,
) -> Result<git_service::CommitFiles, String> {
    let root = root(&state)?;
    if root.to_string_lossy() != workspace_root {
        return Err("Workspace changed; retry the action".into());
    }
    tauri::async_runtime::spawn_blocking(move || git_service::commit_files(&root, &revision))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn git_history_diff(
    state: State<'_, Workspace>,
    workspace_root: String,
    revision: String,
    path: String,
    original: Option<String>,
    encoding: Option<String>,
) -> Result<git_service::Diff, String> {
    let root = root(&state)?;
    let encoding = crate::workspace::text_encoding::Encoding::parse(encoding.as_deref())?;
    if root.to_string_lossy() != workspace_root {
        return Err("Workspace changed; retry the action".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        git_service::history_diff_encoded(&root, &revision, &path, original.as_deref(), encoding)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn terminal_start(
    state: State<'_, Workspace>,
    workspace_root: String,
    manager: State<'_, std::sync::Arc<terminal::Manager>>,
    columns: u16,
    rows: u16,
) -> Result<u64, String> {
    let root = root(&state)?;
    if root.to_string_lossy() != workspace_root {
        return Err("Workspace changed; retry the action".into());
    }
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.start(&root, columns, rows))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn terminal_write(
    manager: State<'_, std::sync::Arc<terminal::Manager>>,
    id: u64,
    data: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.write(id, &data))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn terminal_poll(
    manager: State<std::sync::Arc<terminal::Manager>>,
    id: u64,
) -> Result<terminal::Poll, String> {
    manager.poll(id)
}
#[tauri::command]
pub fn terminal_resize(
    manager: State<std::sync::Arc<terminal::Manager>>,
    id: u64,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(id, columns, rows)
}
#[tauri::command]
pub fn terminal_stop(manager: State<std::sync::Arc<terminal::Manager>>, id: Option<u64>) {
    manager.stop(id);
}

#[tauri::command]
pub async fn terminal_font() -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(crate::terminal_font::installed)
        .await
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}
