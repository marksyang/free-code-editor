use std::process::Command;

pub fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW (not for ConPTY sessions)
    }
    #[cfg(not(windows))]
    let _ = command;
}
pub fn lsp_executable(value: &str) -> std::ffi::OsString {
    #[cfg(windows)]
    {
        let name = std::path::Path::new(value)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if [
            "typescript-language-server",
            "vscode-json-language-server",
            "perlnavigator",
            "pyright-langserver",
            "bash-language-server",
            "vscode-css-language-server",
            "vscode-html-language-server",
        ]
        .contains(&name)
        {
            return format!("{value}.cmd").into();
        }
    }
    value.into()
}
pub fn lsp_path(command: &mut Command) {
    #[cfg(target_os = "macos")]
    {
        let mut paths: Vec<_> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        for path in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            if !paths.iter().any(|p| p == std::path::Path::new(path)) {
                paths.push(path.into());
            }
        }
        if let Ok(path) = std::env::join_paths(paths) {
            command.env("PATH", path);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = command;
}
pub fn open_external(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://"))
        || url.chars().any(char::is_control)
    {
        return Err("Only HTTP(S) links are supported".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn ShellExecuteW(
                window: *mut std::ffi::c_void,
                operation: *const u16,
                file: *const u16,
                parameters: *const u16,
                directory: *const u16,
                show: i32,
            ) -> isize;
        }
        let wide: Vec<u16> = std::ffi::OsStr::new(url)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if result <= 32 {
            return Err(format!("Unable to open browser: Windows error {result}"));
        }
        Ok(())
    }
    #[cfg(unix)]
    {
        #[cfg(target_os = "macos")]
        let program = "/usr/bin/open";
        #[cfg(not(target_os = "macos"))]
        let program = "xdg-open";
        let mut child = Command::new(program)
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_rejects_non_web_schemes_and_control_characters() {
        for value in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://example.com/\n",
            "http://example.com/\0",
        ] {
            assert!(open_external(value).is_err());
        }
        let expected = if cfg!(windows) {
            "typescript-language-server.cmd"
        } else {
            "typescript-language-server"
        };
        assert_eq!(
            lsp_executable("typescript-language-server"),
            std::ffi::OsString::from(expected)
        );
        assert_eq!(
            lsp_executable("node.exe"),
            std::ffi::OsString::from("node.exe")
        );
    }
}
