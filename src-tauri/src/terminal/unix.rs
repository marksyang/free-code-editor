#[cfg(target_os = "linux")]
#[link(name = "util")]
unsafe extern "C" {}

use serde::Serialize;
use std::{
    collections::VecDeque,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
const MAX_PENDING: usize = 256 * 1024;
#[derive(Default)]
struct Output {
    bytes: VecDeque<u8>,
    truncated: bool,
    finished: bool,
}
struct Session {
    id: u64,
    master: File,
    child: Child,
    output: Arc<Mutex<Output>>,
    stopped: Arc<std::sync::atomic::AtomicBool>,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.stopped
            .store(true, std::sync::atomic::Ordering::Relaxed);
        // Interactive foreground jobs have a separate process group from the shell.
        if self.child.try_wait().ok().flatten().is_none() {
            unsafe {
                let foreground = libc::tcgetpgrp(self.master.as_raw_fd());
                if foreground > 0 {
                    libc::kill(-foreground, libc::SIGKILL);
                }
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}
#[derive(Default)]
pub struct Manager {
    session: Mutex<Option<Session>>,
    active_root: Mutex<Option<PathBuf>>,
    next: std::sync::atomic::AtomicU64,
}
#[derive(Serialize)]
pub struct Poll {
    pub bytes: Vec<u8>,
    pub exited: bool,
    pub truncated: bool,
}
impl Manager {
    pub fn activate(&self, root: &Path) -> Result<(), String> {
        let mut active = self.active_root.lock().map_err(|e| e.to_string())?;
        self.stop(None);
        *active = Some(root.to_path_buf());
        Ok(())
    }
    pub fn start(&self, root: &Path, columns: u16, rows: u16) -> Result<u64, String> {
        let active = self.active_root.lock().map_err(|e| e.to_string())?;
        if active.as_deref() != Some(root) {
            return Err("Workspace changed; reopen terminal".into());
        }
        let mut slot = self.session.lock().map_err(|e| e.to_string())?;
        *slot = None;
        let mut size = libc::winsize {
            ws_row: rows.clamp(2, 300),
            ws_col: columns.clamp(10, 500),
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let mut master = -1;
        let mut slave = -1;
        let size_pointer = &raw mut size;
        // openpty initializes both descriptors atomically; ownership transfers to File below.
        if unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                size_pointer,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let master = unsafe { File::from_raw_fd(master) };
        let slave = unsafe { File::from_raw_fd(slave) };
        for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        let flags = unsafe { libc::fcntl(master.as_raw_fd(), libc::F_GETFL) };
        if flags == -1
            || unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) }
                == -1
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut command = Command::new(shell);
        command
            .arg("-i")
            .current_dir(root)
            .env("TERM", "xterm-256color")
            .stdin(Stdio::from(slave.try_clone().map_err(|e| e.to_string())?))
            .stdout(Stdio::from(slave.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(slave));
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut reader = master.try_clone().map_err(|e| e.to_string())?;
        let child = command.spawn().map_err(|e| e.to_string())?;
        let output = Arc::new(Mutex::new(Output::default()));
        let buffer = output.clone();
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader_stopped = stopped.clone();
        thread::spawn(move || {
            let mut chunk = [0; 8192];
            while !reader_stopped.load(std::sync::atomic::Ordering::Relaxed) {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => {
                        if let Ok(mut out) = buffer.lock() {
                            let discard = (out.bytes.len() + count).saturating_sub(MAX_PENDING);
                            if discard > 0 {
                                out.bytes.drain(..discard);
                                out.truncated = true;
                            }
                            out.bytes.extend(&chunk[..count]);
                        } else {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
            }
            if let Ok(mut out) = buffer.lock() {
                out.finished = true;
            }
        });
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        *slot = Some(Session {
            id,
            master,
            child,
            output,
            stopped,
        });
        Ok(id)
    }
    fn with<T>(
        &self,
        id: u64,
        action: impl FnOnce(&mut Session) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut slot = self.session.lock().map_err(|e| e.to_string())?;
        let session = slot
            .as_mut()
            .filter(|s| s.id == id)
            .ok_or("Terminal session is no longer active")?;
        action(session)
    }
    pub fn write(&self, id: u64, data: &str) -> Result<(), String> {
        if data.len() > 65536 {
            return Err("Paste at most 64 KiB at a time".into());
        }
        self.with(id, |s| {
            let mut bytes = data.as_bytes();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
            while !bytes.is_empty() {
                match s.master.write(bytes) {
                    Ok(0) => return Err("Terminal closed".into()),
                    Ok(count) => bytes = &bytes[count..],
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        thread::sleep(std::time::Duration::from_millis(5))
                    }
                    Err(e) => return Err(e.to_string()),
                }
            }
            Ok(())
        })
    }
    pub fn resize(&self, id: u64, columns: u16, rows: u16) -> Result<(), String> {
        self.with(id, |s| {
            let size = libc::winsize {
                ws_row: rows.clamp(2, 300),
                ws_col: columns.clamp(10, 500),
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            if unsafe { libc::ioctl(s.master.as_raw_fd(), libc::TIOCSWINSZ as _, &size) } == -1 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(())
        })
    }
    pub fn poll(&self, id: u64) -> Result<Poll, String> {
        self.with(id, |s| {
            let exited = s.child.try_wait().map_err(|e| e.to_string())?.is_some();
            let mut out = s.output.lock().map_err(|e| e.to_string())?;
            Ok(Poll {
                bytes: out.bytes.drain(..).collect(),
                exited: exited && out.finished,
                truncated: std::mem::take(&mut out.truncated),
            })
        })
    }
    pub fn stop(&self, id: Option<u64>) {
        if let Ok(mut slot) = self.session.lock() {
            if id.is_none() || slot.as_ref().is_some_and(|s| Some(s.id) == id) {
                *slot = None;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_pty_supports_input_resize_exit_and_stale_session_rejection() {
        let manager = Manager::default();
        let root = std::env::temp_dir().canonicalize().unwrap();
        manager.activate(&root).unwrap();
        let id = manager.start(&root, 80, 24).unwrap();

        manager.resize(id, 96, 28).unwrap();
        manager.write(id, "printf '__PTY_%s__\\n' READY\r").unwrap();
        let mut bytes = Vec::new();
        for _ in 0..100 {
            bytes.extend(manager.poll(id).unwrap().bytes);
            if String::from_utf8_lossy(&bytes).contains("__PTY_READY__") {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(String::from_utf8_lossy(&bytes).contains("__PTY_READY__"));
        manager.stop(Some(id + 1));
        assert!(manager.poll(id).is_ok());
        manager
            .write(id, "printf '__LAST_%s__\\n' OUTPUT; exit\r")
            .unwrap();
        let mut final_bytes = Vec::new();
        let mut exited = false;
        for _ in 0..100 {
            let output = manager.poll(id).unwrap();
            final_bytes.extend(output.bytes);
            if output.exited {
                exited = true;
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(exited);
        assert!(String::from_utf8_lossy(&final_bytes).contains("__LAST_OUTPUT__"));
        manager.stop(Some(id));
        assert!(manager.poll(id).is_err());
        assert!(manager.write(id, "input").is_err());
        let newer = manager.start(&root, 80, 24).unwrap();
        assert_ne!(newer, id);
        let other = Path::new("/").canonicalize().unwrap();
        manager.activate(&other).unwrap();
        assert!(manager.poll(newer).is_err());
        assert!(manager.start(&root, 80, 24).is_err());
    }
}
