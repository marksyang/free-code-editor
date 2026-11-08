//! Windows 10 1809+ ConPTY. Input/output run on independent threads to avoid pipe deadlocks.
use serde::Serialize;
use std::{
    collections::VecDeque,
    ffi::{c_void, OsStr},
    fs::File,
    io::{Read, Write},
    mem::{size_of, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
};
type Handle = *mut c_void;
#[repr(C)]
#[derive(Clone, Copy)]
struct Coord {
    x: i16,
    y: i16,
}
#[repr(C)]
struct StartupInfo {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_chars: u32,
    y_chars: u32,
    fill: u32,
    flags: u32,
    show: u16,
    reserved_size: u16,
    reserved_bytes: *mut u8,
    stdin: Handle,
    stdout: Handle,
    stderr: Handle,
}
#[repr(C)]
struct StartupInfoEx {
    info: StartupInfo,
    attributes: *mut c_void,
}
#[repr(C)]
struct ProcessInfo {
    process: Handle,
    thread: Handle,
    pid: u32,
    tid: u32,
}
#[repr(C)]
struct BasicLimits {
    process_time: i64,
    job_time: i64,
    flags: u32,
    min_working_set: usize,
    max_working_set: usize,
    active_processes: u32,
    affinity: usize,
    priority: u32,
    scheduling: u32,
}
#[repr(C)]
struct IoCounters {
    read_ops: u64,
    write_ops: u64,
    other_ops: u64,
    read_bytes: u64,
    write_bytes: u64,
    other_bytes: u64,
}
#[repr(C)]
struct ExtendedLimits {
    basic: BasicLimits,
    io: IoCounters,
    process_memory: usize,
    job_memory: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreatePipe(read: *mut Handle, write: *mut Handle, security: *const c_void, size: u32)
        -> i32;
    fn CreatePseudoConsole(
        size: Coord,
        input: Handle,
        output: Handle,
        flags: u32,
        console: *mut Handle,
    ) -> i32;
    fn ResizePseudoConsole(console: Handle, size: Coord) -> i32;
    fn ClosePseudoConsole(console: Handle);
    fn InitializeProcThreadAttributeList(
        list: *mut c_void,
        count: u32,
        flags: u32,
        size: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *mut c_void,
        size: usize,
        previous: *mut c_void,
        returned: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(list: *mut c_void);
    fn CreateProcessW(
        application: *const u16,
        command: *mut u16,
        process_security: *const c_void,
        thread_security: *const c_void,
        inherit: i32,
        flags: u32,
        environment: *const c_void,
        directory: *const u16,
        startup: *const StartupInfo,
        process: *mut ProcessInfo,
    ) -> i32;
    fn CreateJobObjectW(security: *const c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, size: u32) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn TerminateJobObject(job: Handle, code: u32) -> i32;
    fn TerminateProcess(process: Handle, code: u32) -> i32;
    fn ResumeThread(thread: Handle) -> u32;
    fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
}
fn error() -> String {
    std::io::Error::last_os_error().to_string()
}
fn wide(value: &OsStr) -> Result<Vec<u16>, String> {
    let mut data: Vec<_> = value.encode_wide().collect();
    if data.contains(&0) {
        return Err("Paths cannot contain NUL".into());
    }
    data.push(0);
    Ok(data)
}
fn pipe() -> Result<(OwnedHandle, OwnedHandle), String> {
    let mut read = std::ptr::null_mut();
    let mut write = std::ptr::null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) } == 0 {
        return Err(error());
    }
    Ok(unsafe {
        (
            OwnedHandle::from_raw_handle(read),
            OwnedHandle::from_raw_handle(write),
        )
    })
}
struct Console(usize);
impl Drop for Console {
    fn drop(&mut self) {
        unsafe {
            ClosePseudoConsole(self.0 as Handle);
        }
    }
}
struct Attributes(Vec<usize>);
impl Attributes {
    fn new(console: &Console) -> Result<Self, String> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(error());
        }
        let mut memory = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let pointer = memory.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut bytes) } == 0 {
            return Err(error());
        }
        let result = Self(memory);
        if unsafe {
            UpdateProcThreadAttribute(
                pointer,
                0,
                0x0002_0016,
                console.0 as Handle,
                size_of::<Handle>(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(error());
        }
        Ok(result)
    }
    fn pointer(&mut self) -> *mut c_void {
        self.0.as_mut_ptr().cast()
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer());
        }
    }
}
#[derive(Default)]
struct Output {
    bytes: VecDeque<u8>,
    truncated: bool,
    finished: bool,
}
#[derive(Serialize)]
pub struct Poll {
    pub bytes: Vec<u8>,
    pub exited: bool,
    pub truncated: bool,
}
struct Session {
    id: u64,
    console: Option<Console>,
    process: OwnedHandle,
    job: OwnedHandle,
    input: mpsc::SyncSender<Vec<u8>>,
    output: Arc<Mutex<Output>>,
}
impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            TerminateJobObject(self.job.as_raw_handle(), 1);
        }
        // Reader remains active while ClosePseudoConsole flushes its final VT output.
        self.console.take();
        unsafe {
            WaitForSingleObject(self.process.as_raw_handle(), 1000);
        }
    }
}
fn start_session(id: u64, root: &Path, columns: u16, rows: u16) -> Result<Session, String> {
    let (pty_input, writer) = pipe()?;
    let (reader, pty_output) = pipe()?;
    let mut console = std::ptr::null_mut();
    let result = unsafe {
        CreatePseudoConsole(
            size(columns, rows),
            pty_input.as_raw_handle(),
            pty_output.as_raw_handle(),
            0,
            &mut console,
        )
    };
    if result < 0 {
        return Err(format!(
            "CreatePseudoConsole failed: 0x{:08X}. Windows 10 1809+ is required",
            result as u32
        ));
    }
    let console = Console(console as usize);
    let output = Arc::new(Mutex::new(Output::default()));
    let buffer = output.clone();
    // Drain output before spawning: ConPTY teardown must never wait on an unread pipe.
    thread::spawn(move || {
        let mut file = File::from(reader);
        let mut chunk = [0; 8192];
        loop {
            match file.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => {
                    if let Ok(mut out) = buffer.lock() {
                        let discard = (out.bytes.len() + count).saturating_sub(256 * 1024);
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
                Err(_) => break,
            }
        }
        if let Ok(mut out) = buffer.lock() {
            out.finished = true;
        }
    });
    let mut attributes = Attributes::new(&console)?;
    let windows = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let shell = windows.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let application = wide(shell.as_os_str())?;
    let mut command: Vec<u16> = OsStr::new(&format!("\"{}\" -NoLogo", shell.display()))
        .encode_wide()
        .chain(Some(0))
        .collect();
    let directory = wide(root.as_os_str())?;
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(job) };
    let mut limits: ExtendedLimits = unsafe { zeroed() };
    limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            9,
            (&limits as *const ExtendedLimits).cast(),
            size_of::<ExtendedLimits>() as u32,
        )
    } == 0
    {
        return Err(error());
    }
    let mut startup: StartupInfoEx = unsafe { zeroed() };
    startup.info.cb = size_of::<StartupInfoEx>() as u32;
    startup.attributes = attributes.pointer();
    let mut process: ProcessInfo = unsafe { zeroed() };
    // Suspend until the process is assigned to our cleanup job object.
    if unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            0x0008_0004,
            std::ptr::null(),
            directory.as_ptr(),
            &startup.info,
            &mut process,
        )
    } == 0
    {
        return Err(error());
    }
    let process_handle = unsafe { OwnedHandle::from_raw_handle(process.process) };
    let thread_handle = unsafe { OwnedHandle::from_raw_handle(process.thread) };
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process_handle.as_raw_handle()) } == 0
    {
        let message = error();
        unsafe {
            TerminateProcess(process_handle.as_raw_handle(), 1);
        }
        return Err(message);
    }
    if unsafe { ResumeThread(thread_handle.as_raw_handle()) } == u32::MAX {
        return Err(error());
    }
    drop(pty_input);
    drop(pty_output);
    let (input, received) = mpsc::sync_channel::<Vec<u8>>(64);
    thread::spawn(move || {
        let mut writer = File::from(writer);
        while let Ok(bytes) = received.recv() {
            if writer.write_all(&bytes).is_err() {
                break;
            }
        }
    });
    Ok(Session {
        id,
        console: Some(console),
        process: process_handle,
        job,
        input,
        output,
    })
}
fn size(columns: u16, rows: u16) -> Coord {
    Coord {
        x: columns.clamp(10, 500) as i16,
        y: rows.clamp(2, 300) as i16,
    }
}
#[derive(Default)]
pub struct Manager {
    session: Mutex<Option<Session>>,
    active_root: Mutex<Option<PathBuf>>,
    next: std::sync::atomic::AtomicU64,
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
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        *slot = Some(start_session(id, root, columns, rows)?);
        Ok(id)
    }
    fn with<T>(
        &self,
        id: u64,
        action: impl FnOnce(&mut Session) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut slot = self.session.lock().map_err(|e| e.to_string())?;
        action(
            slot.as_mut()
                .filter(|s| s.id == id)
                .ok_or("Terminal session is no longer active")?,
        )
    }
    pub fn write(&self, id: u64, data: &str) -> Result<(), String> {
        if data.len() > 65536 {
            return Err("Paste at most 64 KiB at a time".into());
        }
        self.with(id, |s| {
            s.input
                .try_send(data.as_bytes().to_vec())
                .map_err(|e| e.to_string())
        })
    }
    pub fn resize(&self, id: u64, columns: u16, rows: u16) -> Result<(), String> {
        self.with(id, |s| {
            let console = s.console.as_ref().ok_or("Shell exited")?;
            let result = unsafe { ResizePseudoConsole(console.0 as Handle, size(columns, rows)) };
            if result < 0 {
                return Err(format!(
                    "ResizePseudoConsole failed: 0x{:08X}",
                    result as u32
                ));
            }
            Ok(())
        })
    }
    pub fn poll(&self, id: u64) -> Result<Poll, String> {
        self.with(id, |s| {
            let mut code = 0;
            if unsafe { GetExitCodeProcess(s.process.as_raw_handle(), &mut code) } == 0 {
                return Err(error());
            }
            let exited = code != 259;
            if exited {
                s.console.take();
            }
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
    fn conpty_accepts_powershell_input_resize_and_rejects_stale_sessions() {
        let manager = Manager::default();
        let root = std::env::temp_dir().canonicalize().unwrap();
        manager.activate(&root).unwrap();
        let id = manager.start(&root, 80, 24).unwrap();
        manager.resize(id, 96, 28).unwrap();
        let mut peer = super::super::probe::Probe::new(96, 28);
        let mut raw = Vec::new();
        let mut command_sent = false;
        let mut deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let output = manager.poll(id).unwrap();
            raw.extend(&output.bytes);
            for reply in peer.feed(&output.bytes) {
                manager.write(id, &reply).unwrap();
            }
            let visible = peer.text();
            // PowerShell/PSReadLine may initialize or flush input before its first prompt.
            if !command_sent && visible.trim_end().ends_with('>') {
                manager
                    .write(id, "Write-Output ('__PTY_' + 'READY__')\r")
                    .unwrap();
                command_sent = true;
                deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            }
            // ConPTY emits VT repaint sequences, so raw byte substring matching is invalid.
            if command_sent && visible.contains("__PTY_READY__") {
                break;
            }
            assert!(!output.truncated, "ConPTY test output overflowed");
            assert!(!output.exited && std::time::Instant::now() < deadline,
                "ConPTY probe failed: command_sent={command_sent}, exited={}, visible={visible:?}, raw_tail={:?}",
                output.exited, String::from_utf8_lossy(&raw[raw.len().saturating_sub(8192)..]));
            thread::sleep(std::time::Duration::from_millis(20));
        }
        manager.stop(Some(id));
        assert!(manager.poll(id).is_err());
        assert!(manager.write(id, "input").is_err());
    }
}
