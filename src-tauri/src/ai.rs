//! Local AI configuration and history. Secrets are deliberately excluded.
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use tauri::Manager;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(default)]
    pub chat_only: bool,
    pub endpoint: String,
    pub model: String,
    pub command_timeout_seconds: u32,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            chat_only: false,
            endpoint: "http://localhost:11434/v1".into(),
            model: String::new(),
            command_timeout_seconds: 120,
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if self.endpoint.len() > 2048 || self.endpoint.chars().any(char::is_control) {
            return Err("Invalid AI endpoint".into());
        }
        let url = tauri::Url::parse(&self.endpoint).map_err(|_| "Invalid AI endpoint")?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !(url.scheme() == "https" || url.scheme() == "http" && local)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("AI endpoint must use HTTPS, or HTTP on localhost, without credentials/query/fragment".into());
        }
        if self.model.trim().is_empty()
            || self.model.len() > 256
            || self.model.chars().any(char::is_control)
        {
            return Err("A model name of 1–256 bytes is required".into());
        }
        if !(1..=3600).contains(&self.command_timeout_seconds) {
            return Err("Command timeout must be 1–3600 seconds".into());
        }
        Ok(())
    }
}
fn read_settings(path: &Path) -> Result<Settings, String> {
    if !path.exists() {
        return Ok(Settings::default());
    }
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 16384 {
        return Err("AI settings exceed 16 KiB".into());
    }
    let settings: Settings = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    settings.validate()?;
    Ok(settings)
}
#[tauri::command]
pub fn load_ai_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    read_settings(
        &app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("ai-settings.json"),
    )
}
#[tauri::command]
pub fn save_ai_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    settings.validate()?;
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    crate::workspace::atomic_write(
        &directory.join("ai-settings.json"),
        &serde_json::to_vec(&settings).map_err(|e| e.to_string())?,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_local_and_remote_endpoints_without_embedded_secrets() {
        let mut s = Settings {
            model: "model".into(),
            ..Settings::default()
        };
        for endpoint in [
            "http://localhost:11434/v1",
            "http://127.0.0.1:11434/v1",
            "http://[::1]:11434/v1",
            "https://example.com/v1",
        ] {
            s.endpoint = endpoint.into();
            assert!(s.validate().is_ok(), "{endpoint}");
        }
        for endpoint in [
            "file:///tmp",
            "http://example.com/v1",
            "https://user:key@example.com",
            "https://example.com?key=secret",
        ] {
            s.endpoint = endpoint.into();
            assert!(s.validate().is_err(), "{endpoint}");
        }
        assert!(serde_json::from_str::<Settings>(r#"{"endpoint":"http://localhost:11434/v1","model":"test","commandTimeoutSeconds":120,"apiKey":"secret"}"#).is_err());
    }
}
