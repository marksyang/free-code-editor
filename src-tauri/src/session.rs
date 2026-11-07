use serde_json::Value;
use std::{fs, path::Path};

const MAX_SESSION_BYTES: u64 = 32 * 1024 * 1024;

pub fn load(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_SESSION_BYTES {
        return Err("Session recovery exceeds 32 MiB".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("Invalid session recovery: {e}"))
}

pub fn save(path: &Path, payload: &Value) -> Result<(), String> {
    if payload.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported session version".into());
    }
    let bytes = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_SESSION_BYTES {
        return Err("Session recovery exceeds 32 MiB".into());
    }
    fs::create_dir_all(path.parent().ok_or("Missing session directory")?)
        .map_err(|e| e.to_string())?;
    crate::workspace::atomic_write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_versions_without_touching_disk() {
        let path = std::env::temp_dir().join("editor-rejected-session.json");
        assert!(save(&path, &serde_json::json!({"version": 999})).is_err());
    }
    #[test]
    fn checkpoint_round_trip_preserves_dirty_text_and_private_permissions() {
        let dir = std::env::temp_dir().join(format!("editor-session-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.json");
        let snapshot = serde_json::json!({
            "version": 1,
            "root": "/workspace",
            "tabs": [{"path": "Makefile", "text": "all:\n\t@echo 中文", "original": "old"}]
        });
        save(&path, &snapshot).unwrap();
        assert_eq!(load(&path).unwrap(), Some(snapshot.clone()));
        assert!(save(&path, &serde_json::json!({"version": 99})).is_err());
        assert_eq!(load(&path).unwrap(), Some(snapshot));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn malformed_recovery_is_reported_without_changing_the_backup() {
        let path =
            std::env::temp_dir().join(format!("editor-broken-session-{}.json", std::process::id()));
        fs::write(&path, b"broken json").unwrap();
        assert!(load(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken json");
        fs::remove_file(path).unwrap();
    }
}
