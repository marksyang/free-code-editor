use crate::{
    ai_process,
    workspace::{self, text_encoding::Encoding},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub text: Option<String>,
    pub dirty: bool,
    pub encoding: Option<String>,
}
pub struct Tools {
    pub root: PathBuf,
    pub documents: Vec<Document>,
    pub originals: HashMap<String, (String, Encoding)>,
    pub cancel: Arc<AtomicBool>,
    pub timeout: u32,
}
fn sensitive(path: &str) -> bool {
    path.split('/').any(|part| {
        let p = part.to_ascii_lowercase();
        [
            ".git",
            "node_modules",
            "target",
            "dist",
            ".venv",
            "__pycache__",
            ".ssh",
            ".aws",
            ".gnupg",
            ".codex",
        ]
        .contains(&p.as_str())
            || p.starts_with(".env")
            || p.contains("credential")
            || p.contains("secret")
            || ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].contains(&p.as_str())
            || [".pem", ".key", ".p12", ".pfx", ".jks"]
                .iter()
                .any(|extension| p.ends_with(extension))
    })
}
fn matches_rule(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim_start_matches('/').trim_end_matches('/');
    let options = glob::MatchOptions {
        case_sensitive: true,
        require_literal_separator: true,
        require_literal_leading_dot: false,
    };
    let Ok(glob) = glob::Pattern::new(pattern) else {
        return true;
    };
    let mut candidate = Some(Path::new(path));
    while let Some(p) = candidate {
        if glob.matches_path_with(p, options)
            || !pattern.contains('/')
                && p.file_name()
                    .is_some_and(|n| glob.matches_with(&n.to_string_lossy(), options))
        {
            return true;
        }
        candidate = p.parent().filter(|p| !p.as_os_str().is_empty());
    }
    false
}
fn ignored_by_file(root: &Path, file: &Path, path: &str) -> bool {
    let Ok(metadata) = fs::symlink_metadata(file) else {
        return false;
    };
    if metadata.file_type().is_symlink() || metadata.len() > 65536 {
        return true;
    }
    let Ok(rules) = fs::read_to_string(file) else {
        return true;
    };
    // Unsupported escapes are handled conservatively rather than exposing an ignored file.
    if rules
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .any(|line| line.contains('\\'))
    {
        return true;
    }
    let base = file.parent().unwrap_or(root);
    let Ok(relative) = root.join(path).strip_prefix(base).map(Path::to_path_buf) else {
        return false;
    };
    let relative = relative.to_string_lossy().replace('\\', "/");
    let mut ignored = false;
    for rule in rules
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        let (negate, pattern) = rule.strip_prefix('!').map_or((false, rule), |s| (true, s));
        if glob::Pattern::new(pattern.trim_start_matches('/').trim_end_matches('/')).is_err() {
            return true;
        }
        if matches_rule(pattern, &relative) {
            ignored = !negate;
        }
    }
    ignored
}
pub fn allowed(root: &Path, path: &str, allow_root: bool) -> Result<PathBuf, String> {
    if allow_root && (path.is_empty() || path == ".") {
        return Ok(root.to_path_buf());
    }
    let relative = Path::new(path);
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\0')
        || path.contains('\\')
        || !relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        || sensitive(path)
    {
        return Err("Agent path is excluded or not workspace-relative".into());
    }
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part.as_os_str());
        if let Ok(meta) = fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() {
                return Err("Agent does not follow symbolic links".into());
            }
            if !current
                .canonicalize()
                .map_err(|e| e.to_string())?
                .starts_with(root)
            {
                return Err("Path outside workspace".into());
            }
        }
        let prefix = workspace::relative_path(root, &current)?;
        let prefix_path = Path::new(&prefix);
        let mut parent = Some(prefix_path.parent().unwrap_or(Path::new("")));
        while let Some(directory) = parent {
            if ignored_by_file(root, &root.join(directory).join(".gitignore"), &prefix) {
                return Err("Path excluded by .gitignore".into());
            }
            parent = directory.parent();
        }
        if ignored_by_file(root, &root.join(".aiignore"), &prefix) {
            return Err("Path excluded by .aiignore".into());
        }
    }
    Ok(current)
}
fn string<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args[name]
        .as_str()
        .ok_or_else(|| format!("Missing string argument: {name}"))
}
fn preserve_newlines(original: &str, replacement: &str) -> String {
    if original.contains("\r\n") && !original.replace("\r\n", "").contains('\n') {
        replacement.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        replacement.to_string()
    }
}
impl Tools {
    fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::SeqCst) {
            Err("Task cancelled".into())
        } else {
            Ok(())
        }
    }
    pub fn execute(&mut self, name: &str, args: &Value) -> Result<Value, String> {
        self.check()?;
        match name {
            "list_directory" => {
                let path = string(args, "path")?;
                let directory = allowed(&self.root, path, true)?;
                let mut items = Vec::new();
                for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
                    self.check()?;
                    let entry = entry.map_err(|e| e.to_string())?;
                    let child = workspace::relative_path(&self.root, &entry.path())?;
                    if allowed(&self.root, &child, false).is_err() {
                        continue;
                    }
                    items.push(json!({"path":child,"directory":entry.file_type().map_err(|e|e.to_string())?.is_dir()}));
                    if items.len() >= 500 {
                        break;
                    }
                }
                items.sort_by_key(|v| v["path"].as_str().unwrap_or("").to_string());
                Ok(json!({"truncated":items.len() >= 500,"entries":items,"limit":500}))
            }
            "read_document" => {
                let path = string(args, "path")?;
                let target = allowed(&self.root, path, false)?;
                let doc = self.documents.iter().find(|d| d.path == path);
                let encoding = Encoding::parse(
                    args["encoding"]
                        .as_str()
                        .or_else(|| doc.and_then(|d| d.encoding.as_deref())),
                )?;
                let text = if let Some(doc) = doc.filter(|d| d.dirty) {
                    doc.text.clone().ok_or("Dirty document exceeds attachment limit; save or select a smaller document")?
                } else {
                    if fs::metadata(target).map_err(|e| e.to_string())?.len() > 256 * 1024 {
                        return Err("Agent document reads are limited to 256 KiB; use search or a command after approval for larger files".into());
                    }
                    workspace::read_encoded(&self.root, path, encoding)?
                };
                if text.len() > 256 * 1024 {
                    return Err("Decoded document exceeds 256 KiB".into());
                }
                let start = args["startLine"].as_u64().unwrap_or(1);
                let end = args["endLine"].as_u64().unwrap_or(u64::MAX);
                if start == 0 || end < start {
                    return Err("Invalid line range".into());
                }
                self.originals.insert(path.into(), (text.clone(), encoding));
                Ok(
                    json!({"path":path,"encoding":encoding.label(),"text":text.split_inclusive('\n').enumerate().filter(|(i,_)| (*i as u64)+1>=start && (*i as u64)<end).map(|(_,line)|line).collect::<String>()}),
                )
            }
            "search" => {
                let query = string(args, "query")?;
                if query.is_empty() || query.len() > 1024 {
                    return Err("Search query must be 1–1024 bytes".into());
                }
                let mut stack = vec![self.root.clone()];
                let mut results = Vec::new();
                let mut visited = 0;
                while let Some(directory) = stack.pop() {
                    self.check()?;
                    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
                        self.check()?;
                        visited += 1;
                        if visited > 100000 {
                            return Ok(json!({"matches":results,"truncated":true}));
                        }
                        let entry = entry.map_err(|e| e.to_string())?;
                        let path = workspace::relative_path(&self.root, &entry.path())?;
                        if allowed(&self.root, &path, false).is_err() {
                            continue;
                        }
                        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                            stack.push(entry.path());
                            continue;
                        }
                        if entry.metadata().map_err(|e| e.to_string())?.len() > 256 * 1024 {
                            continue;
                        }
                        let doc = self.documents.iter().find(|d| d.path == path);
                        let encoding = Encoding::parse(doc.and_then(|d| d.encoding.as_deref()))?;
                        let text = if let Some(d) = doc.filter(|d| d.dirty) {
                            d.text
                                .clone()
                                .ok_or_else(|| "Dirty document attachment unavailable".to_string())
                        } else {
                            workspace::read_encoded(&self.root, &path, encoding)
                        };
                        if let Ok(text) = text {
                            for (line, content) in text.lines().enumerate() {
                                if content.contains(query) {
                                    results.push(json!({"path":path,"line":line+1,"text":content.chars().take(400).collect::<String>()}));
                                    if results.len() >= 100 {
                                        return Ok(json!({"matches":results,"truncated":true}));
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(json!({"matches":results,"truncated":false}))
            }
            "propose_changes" => {
                let changes = args["changes"]
                    .as_array()
                    .filter(|v| !v.is_empty() && v.len() <= 20)
                    .ok_or("Expected 1–20 changes")?;
                let mut results = Vec::new();
                for change in changes {
                    self.check()?;
                    let path = change["path"].as_str().unwrap_or("");
                    let result = (|| -> Result<(), String> {
                        let target = allowed(&self.root, path, false)?;
                        if self.documents.iter().any(|d| d.path == path && d.dirty) {
                            return Err("Document has unsaved edits; save it or discard edits before an Agent task".into());
                        }
                        match string(change, "action")? {
                            "create" => {
                                let content = string(change, "content")?;
                                if content.len() > 256 * 1024 {
                                    return Err("Change exceeds 256 KiB".into());
                                }
                                workspace::create_encoded(&self.root, path, content, Encoding::Utf8)
                            }
                            "replace" | "delete" => {
                                let (original, encoding) = self
                                    .originals
                                    .get(path)
                                    .ok_or("Read the existing document before modifying it")?;
                                if workspace::read_encoded(&self.root, path, *encoding)?
                                    != *original
                                {
                                    return Err("Document changed externally; read it again".into());
                                }
                                if change["action"] == "delete" {
                                    fs::remove_file(target).map_err(|e| e.to_string())
                                } else {
                                    let content = string(change, "content")?;
                                    if content.len() > 256 * 1024 {
                                        return Err("Change exceeds 256 KiB".into());
                                    }
                                    let content = preserve_newlines(original, content);
                                    workspace::save_encoded(
                                        &self.root, path, original, &content, *encoding,
                                    )
                                }
                            }
                            _ => Err("Unknown file change action".into()),
                        }
                    })();
                    self.originals.remove(path);
                    results
                        .push(json!({"path":path,"action":change["action"],"success":result.is_ok(),"error":result.err()}));
                }
                Ok(json!({"files":results}))
            }
            "run_command" => {
                if self.documents.iter().any(|d| d.dirty) {
                    return Err("Save or discard unsaved documents before running commands".into());
                }
                let script = string(args, "command")?;
                if script.is_empty() || script.len() > 16384 || script.contains('\0') {
                    return Err("Invalid command".into());
                }
                #[cfg(unix)]
                let mut command = {
                    let mut c = Command::new("/bin/sh");
                    c.args(["-c", &format!("{{\n{script}\n}} 2>&1")]);
                    c
                };
                #[cfg(windows)]
                let mut command = {
                    let mut c = Command::new("powershell.exe");
                    c.args(["-NoLogo","-NoProfile","-NonInteractive","-Command", &format!("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); & {{\n{script}\n}} 2>&1")]);
                    c
                };
                command.current_dir(&self.root);
                let mut output = Vec::new();
                let result = ai_process::run(
                    command,
                    vec![],
                    &self.cancel,
                    Duration::from_secs(self.timeout as u64),
                    256 * 1024,
                    |bytes| {
                        output.extend(bytes);
                        Ok(())
                    },
                );
                // Commands may have changed files, so all read snapshots are now stale.
                self.originals.clear();
                Ok(
                    json!({"exitCode":result.as_ref().ok(),"error":result.as_ref().err(),"output":String::from_utf8_lossy(&output)}),
                )
            }
            _ => Err("Unsupported Agent tool".into()),
        }
    }
    pub fn preview(&self, args: &Value) -> Value {
        json!({"changes":args["changes"].as_array().map(|changes| changes.iter().map(|change| {
            let path=change["path"].as_str().unwrap_or("");
            json!({"path":path,"action":change["action"],"before":self.originals.get(path).map(|v|&v.0),"after":change["content"]})
        }).collect::<Vec<_>>())})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exclusions_cover_secrets_globs_and_symlinks() {
        assert!(sensitive("nested/.env.local"));
        assert!(sensitive("keys/server.pem"));
        assert!(matches_rule("*.log", "nested/device.log"));
        assert!(matches_rule("build/", "build/a.rs"));
        assert!(allowed(Path::new("/workspace"), "../outside", false).is_err());
    }
}

#[cfg(test)]
mod integrity_tests {
    use super::*;
    fn setup() -> (PathBuf, Tools) {
        let dir = std::env::temp_dir().join(format!(
            "editor-ai-tools-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let tools = Tools {
            root: dir.clone(),
            documents: vec![],
            originals: HashMap::new(),
            cancel: Arc::new(AtomicBool::new(false)),
            timeout: 2,
        };
        (dir, tools)
    }
    #[test]
    fn edits_keep_big5_crlf_and_detect_conflicts_and_partial_failures() {
        let (dir, mut tools) = setup();
        let text = "下午\r\n";
        workspace::create_encoded(&dir, "a.log", text, Encoding::Big5).unwrap();
        tools
            .execute("read_document", &json!({"path":"a.log","encoding":"big5"}))
            .unwrap();
        let result=tools.execute("propose_changes",&json!({"changes":[{"path":"a.log","action":"replace","content":"上午\n"},{"path":"missing","action":"delete"}]})).unwrap();
        assert_eq!(result["files"][0]["success"], true);
        assert_eq!(result["files"][1]["success"], false);
        assert_eq!(
            workspace::read_encoded(&dir, "a.log", Encoding::Big5).unwrap(),
            "上午\r\n"
        );
        tools
            .execute("read_document", &json!({"path":"a.log","encoding":"big5"}))
            .unwrap();
        fs::write(dir.join("a.log"), b"external").unwrap();
        let result = tools
            .execute(
                "propose_changes",
                &json!({"changes":[{"path":"a.log","action":"delete"}]}),
            )
            .unwrap();
        assert_eq!(result["files"][0]["success"], false);
        assert_eq!(fs::read(dir.join("a.log")).unwrap(), b"external");
        tools.documents.push(Document {
            path: "a.log".into(),
            text: Some("dirty".into()),
            dirty: true,
            encoding: None,
        });
        assert!(tools
            .execute("run_command", &json!({"command":"echo unsafe"}))
            .is_err());
        assert_eq!(
            tools
                .execute("read_document", &json!({"path":"a.log"}))
                .unwrap()["text"],
            "dirty"
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn ignore_rules_apply_to_listing_search_and_explicit_reads() {
        let (dir, mut tools) = setup();
        fs::write(dir.join(".gitignore"), "ignored/\n*.log\n!public.log\n").unwrap();
        fs::write(dir.join(".aiignore"), "private.txt\n").unwrap();
        fs::create_dir(dir.join("ignored")).unwrap();
        for path in [
            "ignored/a.rs",
            "private.txt",
            "device.log",
            "public.log",
            "normal.rs",
            ".env",
        ] {
            fs::write(dir.join(path), "needle").unwrap();
        }
        for path in ["ignored/a.rs", "private.txt", "device.log", ".env"] {
            assert!(
                tools
                    .execute("read_document", &json!({"path":path}))
                    .is_err(),
                "{path}"
            );
        }
        let results = tools.execute("search", &json!({"query":"needle"})).unwrap();
        assert_eq!(results["matches"].as_array().unwrap().len(), 2);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("normal.rs"), dir.join("link.rs")).unwrap();
            assert!(allowed(&dir, "link.rs", false).is_err());
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
