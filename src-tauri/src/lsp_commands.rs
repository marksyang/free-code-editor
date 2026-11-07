use crate::{
    lsp::{self, Hub},
    root, workspace, Workspace,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::{ipc::Channel, Manager, State};

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("lsp.json"))
}
fn active_root(state: &Workspace, expected: &str) -> Result<PathBuf, String> {
    let root = root(state)?;
    if root.to_string_lossy() != expected {
        return Err("Workspace changed during language request".into());
    }
    Ok(root)
}
#[tauri::command]
pub fn load_lsp_settings(app: tauri::AppHandle) -> Result<lsp::Settings, String> {
    lsp::Settings::load(&settings_path(&app)?)
}
#[tauri::command]
pub async fn save_lsp_settings(
    app: tauri::AppHandle,
    hub: State<'_, Arc<Hub>>,
    settings: lsp::Settings,
) -> Result<(), String> {
    let path = settings_path(&app)?;
    let hub = hub.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        settings.save(&path)?;
        hub.stop_all();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn restart_lsp(hub: State<'_, Arc<Hub>>) -> Result<(), String> {
    let hub = hub.inner().clone();
    tauri::async_runtime::spawn_blocking(move || hub.stop_all())
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn start_lsp(
    app: tauri::AppHandle,
    state: State<'_, Workspace>,
    hub: State<'_, Arc<Hub>>,
    expected_root: String,
    language: String,
    on_event: Channel<lsp::Event>,
) -> Result<lsp::Started, String> {
    let root = active_root(&state, &expected_root)?;
    let settings = lsp::Settings::load(&settings_path(&app)?)?;
    let hub = hub.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        hub.start(
            &root,
            &language,
            &settings,
            Arc::new(move |event| {
                let _ = on_event.send(event);
            }),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Serialize)]
pub struct Stamp {
    pub uri: String,
    pub version: i64,
}
#[tauri::command]
pub async fn sync_lsp_document(
    state: State<'_, Workspace>,
    hub: State<'_, Arc<Hub>>,
    expected_root: String,
    server_id: String,
    path: String,
    language: String,
    text: String,
) -> Result<Stamp, String> {
    let root = active_root(&state, &expected_root)?;
    let client = hub.get(&server_id, &root)?;
    tauri::async_runtime::spawn_blocking(move || {
        if lsp::server_key(&language).is_none() {
            return Err("Unsupported LSP language".into());
        }
        let uri = lsp::file_uri(&workspace::resolve(&root, &path)?)?;
        let version = client.sync(&uri, &language, &text)?;
        Ok(Stamp { uri, version })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn close_lsp_document(
    state: State<'_, Workspace>,
    hub: State<'_, Arc<Hub>>,
    expected_root: String,
    server_id: String,
    uri: String,
) -> Result<(), String> {
    let root = active_root(&state, &expected_root)?;
    let client = hub.get(&server_id, &root)?;
    // The document may already be deleted or renamed. Client.close only operates on an existing tracked URI.
    tauri::async_runtime::spawn_blocking(move || client.close(&uri))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn saved_lsp_document(
    state: State<'_, Workspace>,
    hub: State<'_, Arc<Hub>>,
    expected_root: String,
    server_id: String,
    uri: String,
) -> Result<(), String> {
    let root = active_root(&state, &expected_root)?;
    let client = hub.get(&server_id, &root)?;
    tauri::async_runtime::spawn_blocking(move || client.saved(&uri))
        .await
        .map_err(|e| e.to_string())?
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    server_id: String,
    request_id: String,
    method: String,
    path: String,
    params: Value,
}
#[tauri::command]
pub async fn lsp_request(
    state: State<'_, Workspace>,
    hub: State<'_, Arc<Hub>>,
    expected_root: String,
    request: Request,
) -> Result<Value, String> {
    let Request {
        server_id,
        request_id,
        method,
        path,
        mut params,
    } = request;
    if ![
        "textDocument/completion",
        "textDocument/hover",
        "textDocument/definition",
        "textDocument/references",
        "textDocument/rename",
    ]
    .contains(&method.as_str())
    {
        return Err("Unsupported language request".into());
    }
    if request_id.is_empty() || request_id.len() > 128 || request_id == "initialize" {
        return Err("Invalid request identifier".into());
    }
    if !params.is_object() {
        return Err("Invalid language request parameters".into());
    }
    let root = active_root(&state, &expected_root)?;
    let client = hub.get(&server_id, &root)?;
    tauri::async_runtime::spawn_blocking(move || {
        let uri = lsp::file_uri(&workspace::resolve(&root, &path)?)?;
        params["textDocument"] = json!({"uri":uri});
        client.request(request_id, &method, params, Duration::from_secs(10))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn cancel_lsp_request(
    state: State<Workspace>,
    hub: State<Arc<Hub>>,
    expected_root: String,
    server_id: String,
    request_id: String,
) -> Result<(), String> {
    hub.get(&server_id, &active_root(&state, &expected_root)?)?
        .cancel(&request_id);
    Ok(())
}
#[tauri::command]
pub fn lsp_document_path(
    state: State<Workspace>,
    expected_root: String,
    uri: String,
) -> Result<String, String> {
    lsp::uri_path(&active_root(&state, &expected_root)?, &uri)
}
