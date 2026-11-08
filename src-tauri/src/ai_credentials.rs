//! OS credential storage; endpoint is part of the credential identity.
#[cfg(not(windows))]
use crate::ai_process;
#[cfg(not(windows))]
use std::process::Command;
#[cfg(not(windows))]
use std::sync::{atomic::AtomicBool, Arc};
#[cfg(not(windows))]
use std::time::Duration;
fn identity(endpoint: &str) -> String {
    format!("dev.freecode.editor.ai:{}", endpoint.trim_end_matches('/'))
}
#[cfg(not(windows))]
fn output(command: Command, input: Vec<u8>) -> Result<String, String> {
    let mut bytes = Vec::new();
    let status = ai_process::run(
        command,
        input,
        &Arc::new(AtomicBool::new(false)),
        Duration::from_secs(30),
        32768,
        |part| {
            bytes.extend(part);
            Ok(())
        },
    )?;
    if status != 0 {
        return Err(
            "System credential store is unavailable, locked, or contains no matching credential"
                .into(),
        );
    }
    String::from_utf8(bytes)
        .map(|s| s.trim_end_matches(['\r', '\n']).to_string())
        .map_err(|_| "Invalid credential bytes".into())
}
#[cfg(target_os = "macos")]
pub fn get(endpoint: &str) -> Result<String, String> {
    let mut command = Command::new("/usr/bin/security");
    command.args([
        "find-generic-password",
        "-s",
        &identity(endpoint),
        "-a",
        "api-key",
        "-w",
    ]);
    output(command, vec![])
}
#[cfg(target_os = "macos")]
pub fn set(endpoint: &str, key: Option<&str>) -> Result<(), String> {
    let service = identity(endpoint);
    if let Some(key) = key {
        if key.chars().any(char::is_control) {
            return Err("API Key contains control characters".into());
        }
        // Interactive security input avoids exposing the secret in process arguments.
        let quote = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
        let mut command = Command::new("/usr/bin/security");
        command.arg("-i");
        let input = format!(
            "add-generic-password -U -s {} -a api-key -w {}\n",
            quote(&service),
            quote(key)
        );
        output(command, input.into_bytes())?;
        if get(endpoint)? != key {
            return Err("System credential store did not preserve the API Key".into());
        }
        Ok(())
    } else {
        let mut command = Command::new("/usr/bin/security");
        command.args(["delete-generic-password", "-s", &service, "-a", "api-key"]);
        output(command, vec![]).map(|_| ())
    }
}
#[cfg(all(unix, not(target_os = "macos")))]
pub fn get(endpoint: &str) -> Result<String, String> {
    let mut command = Command::new("secret-tool");
    command.args([
        "lookup",
        "application",
        "dev.freecode.editor",
        "endpoint",
        &identity(endpoint),
    ]);
    output(command, vec![])
}
#[cfg(all(unix, not(target_os = "macos")))]
pub fn set(endpoint: &str, key: Option<&str>) -> Result<(), String> {
    let mut command = Command::new("secret-tool");
    if key.is_some() {
        command.args(["store", "--label=Free Code Editor AI"]);
    } else {
        command.arg("clear");
    }
    command.args([
        "application",
        "dev.freecode.editor",
        "endpoint",
        &identity(endpoint),
    ]);
    output(command, key.unwrap_or("").as_bytes().to_vec()).map(|_| ())
}
#[cfg(windows)]
mod windows {
    use std::{ffi::c_void, ptr};
    #[repr(C)]
    struct Credential {
        flags: u32,
        kind: u32,
        target: *mut u16,
        comment: *mut u16,
        time: u64,
        size: u32,
        blob: *mut u8,
        persist: u32,
        count: u32,
        attributes: *mut c_void,
        alias: *mut u16,
        user: *mut u16,
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn CredReadW(
            target: *const u16,
            kind: u32,
            flags: u32,
            credential: *mut *mut Credential,
        ) -> i32;
        fn CredWriteW(credential: *const Credential, flags: u32) -> i32;
        fn CredDeleteW(target: *const u16, kind: u32, flags: u32) -> i32;
        fn CredFree(buffer: *mut c_void);
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    pub fn get(endpoint: &str) -> Result<String, String> {
        let target = wide(&super::identity(endpoint));
        let mut credential = ptr::null_mut();
        unsafe {
            if CredReadW(target.as_ptr(), 1, 0, &mut credential) == 0 {
                return Err("Windows Credential Manager has no accessible AI credential".into());
            }
            let c = &*credential;
            let result =
                String::from_utf8(std::slice::from_raw_parts(c.blob, c.size as usize).to_vec())
                    .map_err(|_| "Invalid credential bytes".into());
            CredFree(credential.cast());
            result
        }
    }
    pub fn set(endpoint: &str, key: Option<&str>) -> Result<(), String> {
        let mut target = wide(&super::identity(endpoint));
        unsafe {
            if let Some(key) = key {
                let mut blob = key.as_bytes().to_vec();
                let mut user = wide("api-key");
                let credential = Credential {
                    flags: 0,
                    kind: 1,
                    target: target.as_mut_ptr(),
                    comment: ptr::null_mut(),
                    time: 0,
                    size: blob.len() as u32,
                    blob: blob.as_mut_ptr(),
                    persist: 2,
                    count: 0,
                    attributes: ptr::null_mut(),
                    alias: ptr::null_mut(),
                    user: user.as_mut_ptr(),
                };
                if CredWriteW(&credential, 0) == 0 {
                    return Err("Cannot write Windows Credential Manager".into());
                }
            } else if CredDeleteW(target.as_ptr(), 1, 0) == 0 {
                return Err("Cannot delete Windows credential".into());
            }
        }
        Ok(())
    }
}
#[cfg(windows)]
pub use windows::{get, set};
