use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

const MAX_MESSAGE: usize = 16 * 1024 * 1024;
static NEXT_SERVER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub enabled: bool,
    pub executable: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub enabled: bool,
    pub servers: BTreeMap<String, ServerConfig>,
}

impl Default for Settings {
    fn default() -> Self {
        let mut servers = BTreeMap::new();
        for (key, executable, args) in [
            ("cpp", "clangd", vec![]),
            ("javascript", "typescript-language-server", vec!["--stdio"]),
            ("rust", "rust-analyzer", vec![]),
            ("json", "vscode-json-language-server", vec!["--stdio"]),
            ("perl", "perlnavigator", vec!["--stdio"]),
            ("python", "pyright-langserver", vec!["--stdio"]),
            ("shell", "bash-language-server", vec!["start"]),
            ("css", "vscode-css-language-server", vec!["--stdio"]),
            ("html", "vscode-html-language-server", vec!["--stdio"]),
        ] {
            servers.insert(
                key.into(),
                ServerConfig {
                    enabled: true,
                    executable: executable.into(),
                    args: args.into_iter().map(String::from).collect(),
                    env: BTreeMap::new(),
                },
            );
        }
        Self {
            enabled: true,
            servers,
        }
    }
}

pub fn server_key(language: &str) -> Option<&str> {
    match language {
        "c" | "cpp" => Some("cpp"),
        "typescript" => Some("javascript"),
        "javascript" | "rust" | "json" | "perl" | "python" | "shell" | "css" | "html" => {
            Some(language)
        }
        _ => None,
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if self.servers.len() > Self::default().servers.len() {
            return Err("Unsupported LSP server configuration".into());
        }
        for (key, config) in &self.servers {
            if server_key(key) != Some(key.as_str())
                || config.executable.trim().is_empty()
                || config.executable.len() > 4096
                || config.executable.contains('\0')
                || config.args.len() > 64
                || config.env.len() > 64
            {
                return Err("Invalid LSP server configuration".into());
            }
            if config
                .args
                .iter()
                .any(|s| s.len() > 8192 || s.contains('\0'))
                || config.env.iter().any(|(k, v)| {
                    k.is_empty() || k.contains(['=', '\0']) || v.len() > 32768 || v.contains('\0')
                })
            {
                return Err("Invalid LSP arguments or environment".into());
            }
        }
        Ok(())
    }
    pub fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 256 * 1024 {
            return Err("LSP settings exceed 256 KiB".into());
        }
        let mut settings = Self::default();
        let loaded: Self =
            serde_json::from_slice(&bytes).map_err(|e| format!("Invalid LSP settings: {e}"))?;
        loaded.validate()?;
        settings.enabled = loaded.enabled;
        settings.servers.extend(loaded.servers);
        Ok(settings)
    }
    pub fn save(&self, path: &Path) -> Result<(), String> {
        self.validate()?;
        std::fs::create_dir_all(path.parent().ok_or("Missing settings directory")?)
            .map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        if bytes.len() > 256 * 1024 {
            return Err("LSP settings exceed 256 KiB".into());
        }
        crate::workspace::atomic_write(path, &bytes)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub server_id: String,
    pub method: String,
    pub params: Value,
}
pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;
type Reply = Result<Value, String>;

pub fn read_frame(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut length = None;
    let mut total = 0;
    loop {
        let mut line = String::new();
        let read = (&mut *reader)
            .take(8193)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            return if total == 0 {
                Ok(None)
            } else {
                Err("Incomplete LSP header".into())
            };
        }
        total += read;
        if total > 8192 {
            return Err("LSP header exceeds 8 KiB".into());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        let (key, value) = line.split_once(':').ok_or("Invalid LSP header")?;
        if key.eq_ignore_ascii_case("Content-Length") {
            if length.is_some() {
                return Err("Duplicate LSP Content-Length".into());
            }
            let size: usize = value
                .trim()
                .parse()
                .map_err(|_| "Invalid LSP Content-Length")?;
            if size > MAX_MESSAGE {
                return Err("LSP message exceeds 16 MiB".into());
            }
            length = Some(size);
        }
    }
    let mut bytes = vec![0; length.ok_or("Missing LSP Content-Length")?];
    reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("Invalid LSP JSON: {e}"))
}

fn write_frame(writer: &mut impl Write, message: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_MESSAGE {
        return Err("LSP message exceeds 16 MiB".into());
    }
    write!(writer, "Content-Length: {}\r\n\r\n", bytes.len()).map_err(|e| e.to_string())?;
    writer
        .write_all(&bytes)
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())
}

#[derive(Clone)]
struct Document {
    language: String,
    text: String,
    version: i64,
}

pub struct Client {
    pub id: String,
    pub root: PathBuf,
    outbound: mpsc::SyncSender<Value>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<String, mpsc::Sender<Reply>>>,
    cancelled: Mutex<HashSet<String>>,
    next_version: AtomicU64,
    pub capabilities: Mutex<Value>,
    documents: Mutex<HashMap<String, Document>>,
    stopped: AtomicBool,
    sink: Sink,
}

impl Client {
    pub fn spawn(root: &Path, config: &ServerConfig, sink: Sink) -> Result<Arc<Self>, String> {
        let mut command = Command::new(crate::platform::lsp_executable(&config.executable));
        command
            .args(&config.args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::platform::hide_console(&mut command);
        crate::platform::lsp_path(&mut command);
        command.envs(&config.env);
        let mut child = command.spawn().map_err(|e| {
            format!(
                "Cannot start {}: {e}. Configure an absolute executable path in LSP settings.",
                config.executable
            )
        })?;
        let input = child.stdin.take().ok_or("Missing language server stdin")?;
        let output = child
            .stdout
            .take()
            .ok_or("Missing language server stdout")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Missing language server stderr")?;
        let (outbound, outgoing) = mpsc::sync_channel::<Value>(16);
        let client = Arc::new(Self {
            id: NEXT_SERVER.fetch_add(1, Ordering::SeqCst).to_string(),
            root: root.to_path_buf(),
            outbound,
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashSet::new()),
            next_version: AtomicU64::new(1),
            capabilities: Mutex::new(Value::Null),
            documents: Mutex::new(HashMap::new()),
            stopped: AtomicBool::new(false),
            sink,
        });
        let writer_client = Arc::downgrade(&client);
        thread::spawn(move || {
            let mut input = input;
            loop {
                if !writer_client.upgrade().is_some_and(|c| c.alive()) {
                    break;
                }
                match outgoing.recv_timeout(Duration::from_millis(100)) {
                    Ok(message) => {
                        if let Err(error) = write_frame(&mut input, &message) {
                            if let Some(client) = writer_client.upgrade() {
                                client.stop(&error);
                            }
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        let weak = Arc::downgrade(&client);
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            let error = loop {
                match read_frame(&mut reader) {
                    Ok(Some(message)) => {
                        if let Some(client) = weak.upgrade() {
                            client.receive(message);
                        } else {
                            break "LSP client was closed".to_string();
                        }
                    }
                    Ok(None) => break "Language server exited".to_string(),
                    Err(e) => break e,
                }
            };
            if let Some(client) = weak.upgrade() {
                client.stop(&error);
            }
        });
        thread::spawn(move || {
            let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink());
        });
        let root_uri = file_uri(root)?;
        let result = client.request("initialize".into(), "initialize", json!({
            "processId": std::process::id(), "rootUri": root_uri,
            "clientInfo": { "name": "Free Code Editor", "version": env!("CARGO_PKG_VERSION") },
            "workspaceFolders": [{ "uri": root_uri, "name": root.file_name().unwrap_or_default().to_string_lossy() }],
            "capabilities": {
                "general": { "positionEncodings": ["utf-16"] },
                "workspace": { "applyEdit": false, "workspaceFolders": true, "configuration": true,
                    "workspaceEdit": { "documentChanges": true, "resourceOperations": [], "failureHandling": "abort" } },
                "textDocument": {
                    "synchronization": { "dynamicRegistration": false, "didSave": true },
                    "completion": { "dynamicRegistration": false, "completionItem": { "snippetSupport": true, "insertReplaceSupport": true, "documentationFormat": ["markdown", "plaintext"] } },
                    "hover": { "dynamicRegistration": false, "contentFormat": ["markdown", "plaintext"] },
                    "definition": { "dynamicRegistration": false, "linkSupport": true },
                    "references": { "dynamicRegistration": false },
                    "rename": { "dynamicRegistration": false, "prepareSupport": false },
                    "publishDiagnostics": { "versionSupport": true, "relatedInformation": false }
                }
            }
        }), Duration::from_secs(15));
        match result {
            Ok(result) => {
                let capabilities = result.get("capabilities").cloned().unwrap_or(Value::Null);
                if capabilities
                    .get("positionEncoding")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s != "utf-16")
                {
                    client.stop("Server did not negotiate UTF-16 positions");
                    return Err("Server did not negotiate UTF-16 positions".into());
                }
                *client.capabilities.lock().map_err(|e| e.to_string())? = capabilities;
                client.notify("initialized", json!({}))?;
                Ok(client)
            }
            Err(e) => {
                client.stop(&e);
                Err(e)
            }
        }
    }
    fn send(&self, value: Value) -> Result<(), String> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err("Language server is stopped".into());
        }
        self.outbound.try_send(value).map_err(|_| {
            self.stop("Language server output queue is full or disconnected");
            "Language server output queue is full or disconnected".into()
        })
    }
    pub fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params}))
    }
    pub fn request(&self, id: String, method: &str, params: Value, timeout: Duration) -> Reply {
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
            if pending.len() >= 128 || pending.contains_key(&id) {
                return Err("Too many or duplicate LSP requests".into());
            }
            if self
                .cancelled
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&id)
            {
                return Err("LSP request cancelled".into());
            }
            pending.insert(id.clone(), sender);
        }
        if let Err(e) =
            self.send(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))
        {
            self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
            return Err(e);
        }
        let result = receiver
            .recv_timeout(timeout)
            .unwrap_or_else(|_| Err("LSP request timed out".into()));
        if self
            .pending
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&id)
            .is_some()
        {
            let _ = self.notify("$/cancelRequest", json!({"id": id}));
        }
        result
    }
    pub fn cancel(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(sender) = pending.remove(id) {
                let _ = sender.send(Err("LSP request cancelled".into()));
            } else if let Ok(mut cancelled) = self.cancelled.lock() {
                if cancelled.len() >= 256 {
                    cancelled.clear();
                }
                cancelled.insert(id.into());
            }
        }
        let _ = self.notify("$/cancelRequest", json!({"id": id}));
    }
    fn receive(&self, message: Value) {
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            if let Some(id) = message.get("id") {
                let result = match method {
                    "workspace/configuration" => Value::Array(vec![
                        Value::Null;
                        params
                            .get("items")
                            .and_then(Value::as_array)
                            .map_or(0, Vec::len)
                            .min(100)
                    ]),
                    "workspace/workspaceFolders" => {
                        json!([{ "uri": file_uri(&self.root).ok(), "name": self.root.file_name().unwrap_or_default().to_string_lossy() }])
                    }
                    "workspace/applyEdit" => {
                        json!({ "applied": false, "failureReason": "Unsolicited server edits are not applied" })
                    }
                    "window/workDoneProgress/create" | "window/showMessageRequest" => Value::Null,
                    _ => {
                        let _ = self.send(json!({"jsonrpc":"2.0", "id": id, "error":{"code":-32601,"message":"Unsupported client request"}}));
                        return;
                    }
                };
                let _ = self.send(json!({"jsonrpc":"2.0", "id": id, "result": result}));
            } else if method == "textDocument/publishDiagnostics" {
                let Some(uri) = params.get("uri").and_then(Value::as_str) else {
                    return;
                };
                if uri_path(&self.root, uri).is_err() {
                    return;
                }
                if let Ok(documents) = self.documents.lock() {
                    let Some(document) = documents.get(uri) else {
                        return;
                    };
                    if params
                        .get("version")
                        .and_then(Value::as_i64)
                        .is_some_and(|v| v != document.version)
                    {
                        return;
                    }
                }
                (self.sink)(Event {
                    server_id: self.id.clone(),
                    method: method.into(),
                    params,
                });
            } else if method == "window/showMessage" {
                (self.sink)(Event {
                    server_id: self.id.clone(),
                    method: method.into(),
                    params,
                });
            }
        } else if let Some(id) = message.get("id").and_then(Value::as_str) {
            if let Ok(mut pending) = self.pending.lock() {
                if let Some(sender) = pending.remove(id) {
                    let result = if let Some(error) = message.get("error") {
                        Err(format!(
                            "LSP {}: {}",
                            error.get("code").unwrap_or(&Value::Null),
                            error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("request failed")
                                .chars()
                                .take(1000)
                                .collect::<String>()
                        ))
                    } else {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = sender.send(result);
                }
            }
        }
    }
    pub fn sync(&self, uri: &str, language: &str, text: &str) -> Result<i64, String> {
        if text.len() > crate::workspace::MAX_FILE_BYTES as usize {
            return Err("Document exceeds 8 MiB".into());
        }
        let language_id = if language == "shell" {
            "shellscript"
        } else {
            language
        };
        let mut documents = self.documents.lock().map_err(|e| e.to_string())?;
        if documents.get(uri).is_some_and(|d| d.language != language) {
            self.notify("textDocument/didClose", json!({"textDocument":{"uri":uri}}))?;
            documents.remove(uri);
        }
        if let Some(document) = documents.get_mut(uri) {
            if document.text == text {
                return Ok(document.version);
            }
            document.version = self.next_version.fetch_add(1, Ordering::SeqCst) as i64;
            let version = document.version;
            self.notify("textDocument/didChange", json!({"textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":text}]}))?;
            document.text = text.into();
            Ok(version)
        } else {
            if documents.len() >= 100 {
                return Err("Too many LSP documents".into());
            }
            let version = self.next_version.fetch_add(1, Ordering::SeqCst) as i64;
            self.notify(
                "textDocument/didOpen",
                json!({"textDocument":{"uri":uri,"languageId":language_id,"version":version,"text":text}}),
            )?;
            documents.insert(
                uri.into(),
                Document {
                    language: language.into(),
                    text: text.into(),
                    version,
                },
            );
            Ok(version)
        }
    }
    pub fn close(&self, uri: &str) -> Result<(), String> {
        if self
            .documents
            .lock()
            .map_err(|e| e.to_string())?
            .remove(uri)
            .is_some()
        {
            self.notify("textDocument/didClose", json!({"textDocument":{"uri":uri}}))?;
        }
        Ok(())
    }
    pub fn saved(&self, uri: &str) -> Result<(), String> {
        let save = self
            .capabilities
            .lock()
            .map_err(|e| e.to_string())?
            .get("textDocumentSync")
            .and_then(|s| s.get("save"))
            .cloned()
            .unwrap_or(Value::Null);
        if save != Value::Bool(true) && !save.is_object() {
            return Ok(());
        }
        let document = self
            .documents
            .lock()
            .map_err(|e| e.to_string())?
            .get(uri)
            .cloned()
            .ok_or("Document is not synchronized")?;
        let mut params = json!({"textDocument":{"uri":uri}});
        if save.get("includeText").and_then(Value::as_bool) == Some(true) {
            params["text"] = json!(document.text);
        }
        self.notify("textDocument/didSave", params)
    }
    pub fn shutdown(&self) {
        if !self.alive() {
            return;
        }
        let id = format!(
            "internal-shutdown-{}",
            NEXT_SERVER.fetch_add(1, Ordering::SeqCst)
        );
        let _ = self.request(id, "shutdown", Value::Null, Duration::from_millis(500));
        let _ = self.notify("exit", Value::Null);
        for _ in 0..50 {
            if !self.alive() {
                return;
            }
            let exited = self
                .child
                .lock()
                .ok()
                .and_then(|mut c| c.try_wait().ok())
                .flatten()
                .is_some();
            if exited {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        self.stop("Language server shutdown");
    }
    pub fn stop(&self, reason: &str) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(reason.into()));
            }
        }
        (self.sink)(Event {
            server_id: self.id.clone(),
            method: "client/stopped".into(),
            params: json!({"message":reason}),
        });
    }
    pub fn alive(&self) -> bool {
        !self.stopped.load(Ordering::SeqCst)
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub fn file_uri(path: &Path) -> Result<String, String> {
    tauri::Url::from_file_path(path)
        .map(String::from)
        .map_err(|_| "Invalid file URI".into())
}
pub fn uri_path(root: &Path, uri: &str) -> Result<String, String> {
    let url = tauri::Url::parse(uri).map_err(|e| e.to_string())?;
    if url.scheme() != "file" || url.query().is_some() || url.fragment().is_some() {
        return Err("Unsupported LSP document URI".into());
    }
    #[cfg(not(windows))]
    if url.host_str().is_some_and(|h| h != "localhost") {
        return Err("Unsupported LSP document host".into());
    }
    let path = url
        .to_file_path()
        .map_err(|_| "Invalid file URI")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("LSP document outside workspace".into());
    }
    crate::workspace::relative_path(root, &path)
}

#[derive(Default)]
pub struct Hub {
    clients: Mutex<HashMap<String, Arc<Client>>>,
    active_root: Mutex<Option<PathBuf>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub server_id: String,
    pub capabilities: Value,
}
impl Hub {
    pub fn start(
        &self,
        root: &Path,
        language: &str,
        settings: &Settings,
        sink: Sink,
    ) -> Result<Started, String> {
        let key = server_key(language).ok_or("No LSP server for this language")?;
        let config = settings
            .servers
            .get(key)
            .ok_or("No language server configured")?;
        if !settings.enabled || !config.enabled {
            return Err("LSP is disabled".into());
        }
        settings.validate()?;
        let cache_key = format!("{}\0{key}", root.display());
        let mut clients = self.clients.lock().map_err(|e| e.to_string())?;
        if self
            .active_root
            .lock()
            .map_err(|e| e.to_string())?
            .as_deref()
            != Some(root)
        {
            return Err("Workspace changed before language server startup".into());
        }
        if let Some(client) = clients.get(&cache_key) {
            if client.alive() {
                return Ok(Started {
                    server_id: client.id.clone(),
                    capabilities: client
                        .capabilities
                        .lock()
                        .map_err(|e| e.to_string())?
                        .clone(),
                });
            }
        }
        let client = Client::spawn(root, config, sink)?;
        let started = Started {
            server_id: client.id.clone(),
            capabilities: client
                .capabilities
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        };
        clients.insert(cache_key, client);
        Ok(started)
    }
    pub fn get(&self, id: &str, root: &Path) -> Result<Arc<Client>, String> {
        self.clients
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .find(|c| c.id == id && c.root == root && c.alive())
            .cloned()
            .ok_or("Language server is no longer active".into())
    }
    pub fn activate_root(&self, root: &Path) {
        if let Ok(mut clients) = self.clients.lock() {
            for (_, client) in clients.drain() {
                client.shutdown();
            }
            if let Ok(mut active) = self.active_root.lock() {
                *active = Some(root.to_path_buf());
            }
        }
    }
    pub fn stop_all(&self) {
        if let Ok(mut clients) = self.clients.lock() {
            for (_, client) in clients.drain() {
                client.shutdown();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Cursor};
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "editor-lsp-{}-{}",
                std::process::id(),
                NEXT_SERVER.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn server(&self) -> (Arc<Client>, mpsc::Receiver<Event>) {
            let (tx, rx) = mpsc::channel();
            let config = ServerConfig {
                enabled: true,
                executable: if cfg!(windows) { "python" } else { "python3" }.into(),
                args: vec![
                    "-u".into(),
                    format!(
                        "{}/../tests/fixtures/lsp_server.py",
                        env!("CARGO_MANIFEST_DIR")
                    ),
                ],
                env: BTreeMap::new(),
            };
            let client = Client::spawn(
                &self.0,
                &config,
                Arc::new(move |e| {
                    let _ = tx.send(e);
                }),
            )
            .unwrap();
            (client, rx)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn framing_uses_utf8_byte_lengths_and_reads_consecutive_messages() {
        let first = json!({"value":"中文 🦀"});
        let second = json!({"value":2});
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &first).unwrap();
        write_frame(&mut bytes, &second).unwrap();
        let mut reader = Cursor::new(bytes);
        assert_eq!(read_frame(&mut reader).unwrap(), Some(first));
        assert_eq!(read_frame(&mut reader).unwrap(), Some(second));
        assert_eq!(read_frame(&mut reader).unwrap(), None);
    }
    #[test]
    fn framing_rejects_malformed_duplicate_oversized_and_incomplete_messages() {
        for bytes in [
            b"Content-Length: 16777217\r\n\r\n".as_slice(),
            b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
            b"Content-Length: 5\r\n\r\n{}",
            b"Other: 1\r\n\r\n{}",
        ] {
            assert!(read_frame(&mut Cursor::new(bytes)).is_err());
        }
        assert!(read_frame(&mut Cursor::new(vec![b'a'; 9000])).is_err());
    }
    #[test]
    fn stdio_peer_syncs_unsaved_unicode_and_routes_diagnostics_and_replies() {
        let f = Fixture::new();
        let (client, events) = f.server();
        let path = f.0.join("測試.c");
        fs::write(&path, "disk").unwrap();
        let uri = file_uri(&path).unwrap();
        assert_eq!(client.sync(&uri, "c", "unsaved 中文 🦀").unwrap(), 1);
        assert_eq!(client.sync(&uri, "c", "unsaved 中文 🦀").unwrap(), 1);
        assert_eq!(client.sync(&uri, "c", "new text").unwrap(), 2);
        let result = client
            .request(
                "hover".into(),
                "textDocument/hover",
                json!({"textDocument":{"uri":uri}}),
                Duration::from_secs(2),
            )
            .unwrap();
        assert_eq!(result["contents"]["value"], "new text");
        let diagnostic = events.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(diagnostic.method, "textDocument/publishDiagnostics");
        assert_eq!(diagnostic.params["diagnostics"][0]["message"], "中文 🦀");
        client.close(&uri).unwrap();
        client.stop("test complete");
        assert!(!client.alive());
    }
    #[test]
    fn cancellation_and_timeouts_remove_pending_requests() {
        let f = Fixture::new();
        let (client, _) = f.server();
        assert!(client
            .request(
                "timeout".into(),
                "test/ignore",
                json!({}),
                Duration::from_millis(50)
            )
            .unwrap_err()
            .contains("timed out"));
        assert!(client.pending.lock().unwrap().is_empty());
        let waiting = client.clone();
        let join = thread::spawn(move || {
            waiting.request(
                "cancel".into(),
                "test/ignore",
                json!({}),
                Duration::from_secs(2),
            )
        });
        for _ in 0..100 {
            if client.pending.lock().unwrap().contains_key("cancel") {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        client.cancel("cancel");
        assert!(join.join().unwrap().unwrap_err().contains("cancelled"));
        assert!(client.pending.lock().unwrap().is_empty());
        client.stop("test complete");
    }
    #[test]
    fn exited_server_releases_waiters_and_unsolicited_edits_are_rejected() {
        let f = Fixture::new();
        let (client, _) = f.server();
        let result = client
            .request(
                "client-edit-check".into(),
                "test/requestClientEdit",
                json!({}),
                Duration::from_secs(2),
            )
            .unwrap();
        assert_eq!(result["applied"], false);
        assert!(client
            .request(
                "crash".into(),
                "test/crash",
                json!({}),
                Duration::from_secs(2)
            )
            .is_err());
        assert!(!client.alive());
    }
    #[test]
    fn file_uri_roundtrip_handles_spaces_unicode_and_rejects_outside_paths() {
        let f = Fixture::new();
        let path = f.0.join("中文 space.c");
        fs::write(&path, "").unwrap();
        assert_eq!(
            uri_path(&f.0, &file_uri(&path).unwrap()).unwrap(),
            "中文 space.c"
        );
        assert!(uri_path(&f.0, "https://example.com/a.c").is_err());
        let outside = Fixture::new();
        let path = outside.0.join("outside.c");
        fs::write(&path, "").unwrap();
        assert!(uri_path(&f.0, &file_uri(&path).unwrap()).is_err());
    }
    #[test]
    fn settings_validate_and_roundtrip_arguments_without_shell_interpretation() {
        let f = Fixture::new();
        let mut settings = Settings::default();
        settings.servers.get_mut("cpp").unwrap().args =
            vec!["--compile-commands-dir=directory with spaces".into()];
        settings.save(&f.0.join("lsp.json")).unwrap();
        assert_eq!(
            Settings::load(&f.0.join("lsp.json")).unwrap().servers,
            settings.servers
        );
        settings
            .servers
            .get_mut("cpp")
            .unwrap()
            .env
            .insert("BAD=KEY".into(), "value".into());
        assert!(settings.validate().is_err());
    }
    #[test]
    fn clangd_initializes_syncs_and_returns_a_real_definition() {
        if !Path::new("/usr/bin/clangd").exists() {
            eprintln!("clangd not available; real server check skipped");
            return;
        }
        let f = Fixture::new();
        let path = f.0.join("main.c");
        let text = "int answer = 42;\nint main(void) { return answer; }\n";
        fs::write(&path, text).unwrap();
        let config = ServerConfig {
            executable: "/usr/bin/clangd".into(),
            enabled: true,
            args: vec!["--background-index=0".into(), "--clang-tidy=0".into()],
            env: BTreeMap::new(),
        };
        let client = Client::spawn(&f.0, &config, Arc::new(|_| {})).unwrap();
        let uri = file_uri(&path).unwrap();
        client.sync(&uri, "c", text).unwrap();
        let result = client
            .request(
                "definition".into(),
                "textDocument/definition",
                json!({"textDocument":{"uri":uri},"position":{"line":1,"character":26}}),
                Duration::from_secs(5),
            )
            .unwrap();
        assert!(result.as_array().is_some_and(|v| !v.is_empty()), "{result}");
        client.stop("test complete");
    }
    #[test]
    fn cancellation_before_dispatch_is_not_lost_and_reopen_versions_do_not_repeat() {
        let f = Fixture::new();
        let (client, _) = f.server();
        client.cancel("early");
        assert!(client
            .request(
                "early".into(),
                "test/ignore",
                json!({}),
                Duration::from_secs(1)
            )
            .unwrap_err()
            .contains("cancelled"));
        let path = f.0.join("main.c");
        fs::write(&path, "int x;").unwrap();
        let uri = file_uri(&path).unwrap();
        let first = client.sync(&uri, "c", "int x;").unwrap();
        client.close(&uri).unwrap();
        assert!(client.sync(&uri, "cpp", "int x;").unwrap() > first);
        client.shutdown();
        assert!(!client.alive());
    }
    #[test]
    fn hub_reuses_c_cpp_and_rejects_late_starts_for_a_previous_workspace() {
        let first = Fixture::new();
        let second = Fixture::new();
        let mut settings = Settings::default();
        let config = settings.servers.get_mut("cpp").unwrap();
        config.executable = if cfg!(windows) { "python" } else { "python3" }.into();
        config.args = vec![
            "-u".into(),
            format!(
                "{}/../tests/fixtures/lsp_server.py",
                env!("CARGO_MANIFEST_DIR")
            ),
        ];
        let hub = Hub::default();
        hub.activate_root(&first.0);
        let a = hub
            .start(&first.0, "c", &settings, Arc::new(|_| {}))
            .unwrap();
        let b = hub
            .start(&first.0, "cpp", &settings, Arc::new(|_| {}))
            .unwrap();
        assert_eq!(a.server_id, b.server_id);
        let client = hub.get(&a.server_id, &first.0).unwrap();
        hub.activate_root(&second.0);
        assert!(!client.alive());
        assert!(hub.get(&a.server_id, &first.0).is_err());
        assert!(hub
            .start(&first.0, "c", &settings, Arc::new(|_| {}))
            .is_err());
        let c = hub
            .start(&second.0, "cpp", &settings, Arc::new(|_| {}))
            .unwrap();
        assert_ne!(c.server_id, a.server_id);
        hub.stop_all();
    }
    #[test]
    fn save_notifications_include_text_and_bash_uses_the_standard_language_id() {
        let f = Fixture::new();
        let (client, _) = f.server();
        let path = f.0.join("test.sh");
        fs::write(&path, "echo disk").unwrap();
        let uri = file_uri(&path).unwrap();
        client.sync(&uri, "shell", "echo 中文 🦀").unwrap();
        client.saved(&uri).unwrap();
        let result = client
            .request(
                "saved-check".into(),
                "test/getSaved",
                json!({"textDocument":{"uri":uri}}),
                Duration::from_secs(2),
            )
            .unwrap();
        assert_eq!(result["text"], "echo 中文 🦀");
        assert_eq!(result["language"], "shellscript");
        client.shutdown();
    }
    #[test]
    fn legacy_settings_keep_existing_preferences_and_gain_new_servers() {
        let f = Fixture::new();
        let mut previous = Settings::default();
        for key in ["rust", "json", "perl"] {
            previous.servers.remove(key);
        }
        let javascript = previous.servers.get_mut("javascript").unwrap();
        javascript.enabled = false;
        javascript.executable = "/custom path/typescript-language-server".into();
        javascript
            .env
            .insert("PATH".into(), "/custom/node/bin".into());
        previous.save(&f.0.join("lsp.json")).unwrap();
        let loaded = Settings::load(&f.0.join("lsp.json")).unwrap();
        assert_eq!(loaded.servers.len(), 9);
        assert_eq!(loaded.servers["javascript"], previous.servers["javascript"]);
        assert_eq!(loaded.servers["rust"].executable, "rust-analyzer");
        assert_eq!(
            loaded.servers["json"].executable,
            "vscode-json-language-server"
        );
        assert_eq!(loaded.servers["perl"].executable, "perlnavigator");
        loaded.validate().unwrap();
        assert_eq!(server_key("typescript"), Some("javascript"));
        for language in ["rust", "json", "perl"] {
            assert_eq!(server_key(language), Some(language));
        }
        assert_eq!(server_key("bitbake"), None);
    }
    #[test]
    fn additional_languages_use_their_standard_lsp_identifiers() {
        let f = Fixture::new();
        let (client, _) = f.server();
        for (index, (language, file)) in [
            ("rust", "main.rs"),
            ("json", "config.json"),
            ("typescript", "main.ts"),
            ("perl", "main.pl"),
        ]
        .into_iter()
        .enumerate()
        {
            let path = f.0.join(file);
            fs::write(&path, "test content").unwrap();
            let uri = file_uri(&path).unwrap();
            client.sync(&uri, language, "unsaved content").unwrap();
            client.saved(&uri).unwrap();
            let result = client
                .request(
                    format!("language-{index}"),
                    "test/getSaved",
                    json!({"textDocument":{"uri":uri}}),
                    Duration::from_secs(2),
                )
                .unwrap();
            assert_eq!(result["language"], language);
            assert_eq!(result["text"], "unsaved content");
            client.close(&uri).unwrap();
        }
        client.shutdown();
    }
}
