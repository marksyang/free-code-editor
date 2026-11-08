//! Bounded, cancellable subprocesses. Secrets travel over stdin, never argv.
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
mod job {
    use std::{ffi::c_void, os::windows::io::AsRawHandle, process::Child};
    type Handle = *mut c_void;
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
    extern "system" {
        fn CreateJobObjectW(a: Handle, n: *const u16) -> Handle;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, size: u32) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtResumeProcess(process: Handle) -> i32;
    }
    pub struct Job(Handle);
    impl Job {
        pub fn attach(child: &Child) -> Result<Self, String> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if job.is_null() {
                    return Err("Cannot create agent process job".into());
                }
                let mut limits: ExtendedLimits = std::mem::zeroed();
                limits.basic.flags = 0x2000;
                if SetInformationJobObject(
                    job,
                    9,
                    (&limits as *const ExtendedLimits).cast(),
                    std::mem::size_of::<ExtendedLimits>() as u32,
                ) == 0
                {
                    CloseHandle(job);
                    return Err("Cannot configure agent job cleanup".into());
                }
                if AssignProcessToJobObject(job, child.as_raw_handle()) == 0 {
                    CloseHandle(job);
                    return Err("Cannot isolate agent process job".into());
                }
                if NtResumeProcess(child.as_raw_handle()) < 0 {
                    TerminateJobObject(job, 1);
                    CloseHandle(job);
                    return Err("Cannot resume agent process".into());
                }
                Ok(Self(job))
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                TerminateJobObject(self.0, 1);
                CloseHandle(self.0);
            }
        }
    }
}

pub fn run(
    mut command: Command,
    input: Vec<u8>,
    cancel: &Arc<AtomicBool>,
    timeout: Duration,
    limit: usize,
    mut receive: impl FnMut(&[u8]) -> Result<(), String>,
) -> Result<i32, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Task cancelled".into());
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0004); // no console window
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start agent process: {e}"))?;
    #[cfg(windows)]
    let _job = match job::Job::attach(&child) {
        Ok(job) => job,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let stdin = child.stdin.take().ok_or("Missing process stdin")?;
    let writer = thread::spawn(move || {
        let mut stdin = stdin;
        let _ = stdin.write_all(&input);
    });
    let (tx, rx) = mpsc::sync_channel::<(bool, Vec<u8>)>(16);
    let output = child.stdout.take().ok_or("Missing process stdout")?;
    let error = child.stderr.take().ok_or("Missing process stderr")?;
    let readers: Vec<_> = [
        (false, Box::new(output) as Box<dyn Read + Send>),
        (true, Box::new(error) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .map(|(stderr, mut stream)| {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut bytes = [0; 4096];
            loop {
                match stream.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send((stderr, bytes[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        })
    })
    .collect();
    drop(tx);
    let start = Instant::now();
    let mut count = 0;
    let mut failure = None;
    let mut exit = None;
    loop {
        if cancel.load(Ordering::SeqCst) {
            failure = Some("Task cancelled".to_string());
            break;
        }
        if start.elapsed() > timeout {
            failure = Some("Agent process timed out".to_string());
            break;
        }
        match rx.recv_timeout(Duration::from_millis(30)) {
            Ok((stderr, bytes)) => {
                count += bytes.len();
                if count > limit {
                    failure = Some(format!("Process output exceeds {limit} bytes"));
                    break;
                }
                if !stderr {
                    if let Err(e) = receive(&bytes) {
                        failure = Some(e);
                        break;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                    exit = Some(status);
                    break;
                }
                thread::sleep(Duration::from_millis(30));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    // Always kill the whole group, including descendants holding inherited pipes.
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    drop(_job);
    let _ = child.kill();
    if exit.is_none() {
        let _ = child.wait();
    }
    drop(rx);
    let _ = writer.join();
    for reader in readers {
        let _ = reader.join();
    }
    if let Some(e) = failure {
        return Err(e);
    }
    Ok(exit.and_then(|status| status.code()).unwrap_or(-1))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_process_and_cancel() {
        let cancel = Arc::new(AtomicBool::new(false));
        #[cfg(unix)]
        let command = {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", "printf '中文'"]);
            c
        };
        #[cfg(windows)]
        let command = {
            let mut c = Command::new("cmd.exe");
            c.args(["/C", "echo test"]);
            c
        };
        let mut output: Vec<u8> = Vec::new();
        assert_eq!(
            run(
                command,
                vec![],
                &cancel,
                Duration::from_secs(5),
                1024,
                |bytes| {
                    output.extend_from_slice(bytes);
                    Ok(())
                }
            )
            .unwrap(),
            0
        );
        assert!(!output.is_empty());
        cancel.store(true, Ordering::SeqCst);
        assert!(run(
            Command::new("unreachable"),
            vec![],
            &cancel,
            Duration::from_secs(1),
            1024,
            |_| Ok(())
        )
        .is_err());
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::*;
    #[test]
    fn cancellation_and_timeout_kill_descendants_even_with_closed_output() {
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let trigger = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            flag.store(true, Ordering::SeqCst);
        });
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec 1>&- 2>&-; sleep 30 & wait"]);
        let started = Instant::now();
        assert!(run(
            command,
            vec![],
            &cancel,
            Duration::from_secs(5),
            1024,
            |_| Ok(())
        )
        .unwrap_err()
        .contains("cancelled"));
        trigger.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(3));
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & wait"]);
        assert!(run(
            command,
            vec![],
            &Arc::new(AtomicBool::new(false)),
            Duration::from_millis(100),
            1024,
            |_| Ok(())
        )
        .unwrap_err()
        .contains("timed out"));
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "while true; do printf 1234567890; done"]);
        assert!(run(
            command,
            vec![],
            &Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
            100,
            |_| Ok(())
        )
        .unwrap_err()
        .contains("exceeds"));
    }
}
