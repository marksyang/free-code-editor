//! Small headless VT peer for PTY smoke tests, not the application's terminal renderer.
#[derive(Default)]
enum State {
    #[default]
    Text,
    Escape,
    Csi(Vec<u8>),
    Osc,
    OscEscape,
}
pub struct Probe {
    state: State,
    text: Vec<u8>,
    row: usize,
    column: usize,
    columns: usize,
    rows: usize,
}
impl Probe {
    pub fn new(columns: usize, rows: usize) -> Self {
        Self {
            state: State::Text,
            text: Vec::new(),
            row: 1,
            column: 1,
            columns,
            rows,
        }
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.text).into_owned()
    }
    /// Preserve parser state across reads, including split CSI and OSC sequences.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut replies = Vec::new();
        for &byte in bytes {
            let state = std::mem::take(&mut self.state);
            self.state = match state {
                State::Text => {
                    match byte {
                        0x1b => {
                            self.state = State::Escape;
                            continue;
                        }
                        b'\r' => {
                            self.column = 1;
                            self.text.push(byte);
                        }
                        b'\n' => {
                            self.row = (self.row + 1).min(self.rows);
                            self.text.push(byte);
                        }
                        8 => {
                            self.column = self.column.saturating_sub(1).max(1);
                        }
                        0x20..=0x7e => {
                            if self.column > self.columns {
                                self.column = 1;
                                self.row = (self.row + 1).min(self.rows);
                            }
                            self.column += 1;
                            self.text.push(byte);
                        }
                        0x80..=0xff => {
                            self.text.push(byte);
                        }
                        _ => {}
                    }
                    State::Text
                }
                State::Escape => match byte {
                    b'[' => State::Csi(Vec::new()),
                    b']' => State::Osc,
                    _ => State::Text,
                },
                State::Csi(mut parameters) => {
                    if (0x40..=0x7e).contains(&byte) {
                        let raw = String::from_utf8_lossy(&parameters);
                        let values: Vec<usize> =
                            raw.split(';').map(|v| v.parse().unwrap_or(0)).collect();
                        let first = values.first().copied().unwrap_or(0).max(1);
                        match byte {
                            b'H' | b'f' => {
                                self.row = first.min(self.rows);
                                self.column =
                                    values.get(1).copied().unwrap_or(1).max(1).min(self.columns);
                            }
                            b'A' => self.row = self.row.saturating_sub(first).max(1),
                            b'B' => self.row = (self.row + first).min(self.rows),
                            b'C' => self.column = (self.column + first).min(self.columns),
                            b'D' => self.column = self.column.saturating_sub(first).max(1),
                            b'G' => self.column = first.min(self.columns),
                            b'n' if raw == "6" || raw == "?6" => replies.push(format!(
                                "\x1b[{}{};{}R",
                                if raw.starts_with('?') { "?" } else { "" },
                                self.row,
                                self.column.min(self.columns)
                            )),
                            b'n' if raw == "5" => replies.push("\x1b[0n".into()),
                            _ => {}
                        }
                        State::Text
                    } else if parameters.len() < 128 {
                        parameters.push(byte);
                        State::Csi(parameters)
                    } else {
                        State::Text
                    }
                }
                State::Osc => match byte {
                    7 => State::Text,
                    0x1b => State::OscEscape,
                    _ => State::Osc,
                },
                State::OscEscape => {
                    if byte == b'\\' {
                        State::Text
                    } else {
                        State::Osc
                    }
                }
            };
        }
        replies
    }
}
#[test]
fn vt_peer_reassembles_split_markers_and_answers_cursor_queries() {
    let mut peer = Probe::new(96, 28);
    assert!(peer.feed(b"\x1b[2;").is_empty());
    assert_eq!(peer.feed(b"5H\x1b[6n"), vec!["\x1b[2;5R"]);
    peer.feed(b"__PTY_\x1b[?25hREADY__\x1b[0m");
    assert!(peer.text().contains("__PTY_READY__"));
    assert_eq!(peer.feed(b"\x1b[?6n"), vec!["\x1b[?2;18R"]);
}
#[test]
fn vt_peer_ignores_split_window_titles_and_preserves_utf8_bytes() {
    let mut peer = Probe::new(80, 24);
    peer.feed(b"\x1b]0;__PTY_FAKE__\x1b");
    peer.feed(b"\\PS C:\\Temp> \x1b[?25h");
    assert_eq!(peer.text(), "PS C:\\Temp> ");
    for &byte in "中文 🦀".as_bytes() {
        peer.feed(&[byte]);
    }
    assert!(peer.text().contains("中文 🦀"));
}
