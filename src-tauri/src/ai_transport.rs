use crate::{ai::Settings, ai_process};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    process::Command,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
#[derive(Default)]
pub struct Stream {
    pending: Vec<u8>,
    data: Vec<String>,
    content: String,
    calls: BTreeMap<u64, (String, String, String)>,
    finished: bool,
}
impl Stream {
    pub fn push(&mut self, bytes: &[u8], delta: &mut impl FnMut(&str)) -> Result<(), String> {
        self.pending.extend(bytes);
        if self.pending.len() > 1024 * 1024 {
            return Err("AI stream line exceeds 1 MiB".into());
        }
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = self.pending.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "AI stream contains invalid UTF-8")?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    let data = std::mem::take(&mut self.data).join("\n");
                    self.consume(&data, delta)?;
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                self.data
                    .push(value.strip_prefix(' ').unwrap_or(value).to_string());
            }
            if self.data.iter().map(String::len).sum::<usize>() > 1024 * 1024 {
                return Err("AI stream event exceeds 1 MiB".into());
            }
        }
        Ok(())
    }
    fn consume(&mut self, data: &str, delta: &mut impl FnMut(&str)) -> Result<(), String> {
        if data == "[DONE]" {
            return Ok(());
        }
        let value: Value = serde_json::from_str(data).map_err(|_| "Invalid AI stream JSON")?;
        if value.get("error").is_some() {
            return Err("AI provider returned an error".into());
        }
        let Some(choice) = value["choices"]
            .as_array()
            .and_then(|choices| choices.iter().find(|c| c["index"] == 0))
        else {
            return Ok(());
        };
        if let Some(reason) = choice["finish_reason"].as_str() {
            if !["stop", "tool_calls"].contains(&reason) {
                return Err(format!("AI response was incomplete: {reason}"));
            }
            self.finished = true;
        }
        let part = &choice["delta"];
        if let Some(role) = part["role"].as_str() {
            if role != "assistant" {
                return Err("Invalid AI response role".into());
            }
        }
        if let Some(text) = part["content"].as_str() {
            self.content.push_str(text);
            delta(text);
        }
        if let Some(calls) = part["tool_calls"].as_array() {
            for call in calls {
                let index = call["index"]
                    .as_u64()
                    .filter(|i| *i < 32)
                    .ok_or("Invalid AI tool index")?;
                let target = self.calls.entry(index).or_default();
                if let Some(id) = call["id"].as_str() {
                    target.0.push_str(id);
                }
                if let Some(name) = call["function"]["name"].as_str() {
                    target.1.push_str(name);
                }
                if let Some(args) = call["function"]["arguments"].as_str() {
                    target.2.push_str(args);
                }
            }
        }
        if self.content.len()
            + self
                .calls
                .values()
                .map(|c| c.0.len() + c.1.len() + c.2.len())
                .sum::<usize>()
            > 1024 * 1024
        {
            return Err("AI response exceeds 1 MiB".into());
        }
        Ok(())
    }
    pub fn finish(self) -> Result<Value, String> {
        if !self.finished || !self.pending.is_empty() || !self.data.is_empty() {
            return Err("AI stream ended before completion".into());
        }
        let mut calls = Vec::new();
        let mut ids = std::collections::HashSet::new();
        for (_, (id, name, args)) in self.calls {
            if id.is_empty() || name.is_empty() || !ids.insert(id.clone()) {
                return Err("Invalid or duplicate tool call ID".into());
            }
            let _: Value = serde_json::from_str(&args).map_err(|_| "Invalid tool argument JSON")?;
            calls
                .push(json!({"id":id,"type":"function","function":{"name":name,"arguments":args}}));
        }
        let mut result = json!({"role":"assistant","content":self.content});
        if !calls.is_empty() {
            result["tool_calls"] = json!(calls);
        }
        Ok(result)
    }
}
fn quote(value: &str) -> String {
    serde_json::to_string(value).expect("string is serializable")
}
pub fn complete(
    settings: &Settings,
    key: &str,
    messages: &[Value],
    cancel: &Arc<AtomicBool>,
    mut delta: impl FnMut(&str),
) -> Result<Value, String> {
    let command = Command::new(if cfg!(windows) { "curl.exe" } else { "curl" });
    complete_with(settings, key, messages, cancel, &mut delta, command)
}
fn complete_with(
    settings: &Settings,
    key: &str,
    messages: &[Value],
    cancel: &Arc<AtomicBool>,
    delta: &mut impl FnMut(&str),
    mut command: Command,
) -> Result<Value, String> {
    if key.chars().any(char::is_control) || key.len() > 8192 {
        return Err("Invalid API Key".into());
    }
    let mut body =
        json!({"model":settings.model,"messages":messages,"stream":true,"tools":tools()});
    if settings.chat_only {
        body.as_object_mut()
            .ok_or("Invalid request body")?
            .remove("tools");
    }
    if serde_json::to_vec(messages)
        .map_err(|e| e.to_string())?
        .len()
        > 65536
    {
        return Err("Conversation exceeds the 64 KiB request budget; start a new conversation or attach smaller ranges".into());
    }
    let mut config = format!(
        "url = {}\nrequest = \"POST\"\nheader = \"Content-Type: application/json\"\ndata = {}\n",
        quote(&format!(
            "{}/chat/completions",
            settings.endpoint.trim_end_matches('/')
        )),
        quote(&body.to_string())
    );
    if !key.is_empty() {
        config.push_str(&format!(
            "header = {}\n",
            quote(&format!("Authorization: Bearer {key}"))
        ));
    }
    command.args([
        "-q",
        "--silent",
        "--show-error",
        "--no-buffer",
        "--fail",
        "--connect-timeout",
        "15",
        "--max-time",
        "120",
        "--proto",
        "=http,https",
        "--config",
        "-",
    ]);
    let mut stream = Stream::default();
    let status = ai_process::run(
        command,
        config.into_bytes(),
        cancel,
        Duration::from_secs(125),
        1024 * 1024,
        |bytes| stream.push(bytes, delta),
    )?;
    if status != 0 {
        return Err(format!("AI connection failed (curl exit {status}); check endpoint, API Key, model and server availability"));
    }
    stream.finish()
}
pub fn tools() -> Value {
    let schemas = [
        ("list_directory", "List an allowed workspace directory", json!({"path":{"type":"string"}}), vec!["path"]),
        ("search", "Search allowed text files, up to 100 matches", json!({"query":{"type":"string"}}), vec!["query"]),
        ("read_document", "Read document lines; optional encoding utf8/big5/gbk/gb18030", json!({"path":{"type":"string"},"startLine":{"type":"integer","minimum":1},"endLine":{"type":"integer","minimum":1},"encoding":{"type":"string"}}), vec!["path"]),
        ("propose_changes", "Create, replace or delete files. Read each existing file first. Partial results are reported per file. New directories must already exist.", json!({"changes":{"type":"array","maxItems":20,"items":{"type":"object","properties":{"path":{"type":"string"},"action":{"type":"string","enum":["create","replace","delete"]},"content":{"type":"string"}},"required":["path","action"],"additionalProperties":false}}}), vec!["changes"]),
        ("run_command", "Execute a shell command at workspace root. Commands can access network and paths outside the workspace. Output is bounded; never request secrets.", json!({"command":{"type":"string"}}), vec!["command"]),
    ];
    json!(schemas.into_iter().map(|(name, description, properties, required)| json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}})).collect::<Vec<_>>())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stream_preserves_utf8_and_assembles_tool_calls() {
        let mut p = Stream::default();
        let mut text = String::new();
        let parts = [
            json!({"choices":[{"index":0,"delta":{"content":"中文","tool_calls":[{"index":0,"id":"id","function":{"name":"read_document","arguments":"{\"path\":"}}]}}]}),
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.rs\"}"}}]},"finish_reason":"tool_calls"}]}),
        ];
        let wire = parts
            .iter()
            .map(|p| format!("data: {p}\r\n\r\n"))
            .collect::<String>()
            + "data: [DONE]\n\n";
        for byte in wire.bytes() {
            p.push(&[byte], &mut |s| text.push_str(s)).unwrap();
        }
        assert_eq!(text, "中文");
        assert_eq!(
            p.finish().unwrap()["tool_calls"][0]["function"]["arguments"],
            "{\"path\":\"a.rs\"}"
        );
        assert!(Stream::default().finish().is_err());
    }
}

#[cfg(test)]
mod process_tests {
    use super::*;
    #[test]
    fn transport_sends_credentials_only_on_stdin_and_consumes_a_real_process_stream() {
        let mut command = Command::new(if cfg!(windows) { "python" } else { "python3" });
        command.args(["-c",r#"
import sys,json
assert 'test-private-key' not in ' '.join(sys.argv)
config=sys.stdin.read()
assert 'Authorization: Bearer test-private-key' in config
line=next(line for line in config.splitlines() if line.startswith('data = '))
request=json.loads(json.loads(line[7:]))
assert request['model']=='fixture-model'
assert request['tools'][0]['function']['name']=='list_directory'
for value in [dict(choices=[dict(index=0,delta=dict(content='串流中文'))]),dict(choices=[dict(index=0,delta={},finish_reason='stop')])]:
 sys.stdout.buffer.write(('data: '+json.dumps(value,ensure_ascii=False)+'\r\n\r\n').encode('utf-8'));sys.stdout.buffer.flush()
sys.stdout.write('data: [DONE]\n\n')
"#]);
        let settings = Settings {
            model: "fixture-model".into(),
            ..Settings::default()
        };
        let mut delta = String::new();
        let result = complete_with(
            &settings,
            "test-private-key",
            &[json!({"role":"user","content":"test"})],
            &Arc::new(AtomicBool::new(false)),
            &mut |text| delta.push_str(text),
            command,
        )
        .unwrap();
        assert_eq!(result["content"], "串流中文");
        assert_eq!(delta, "串流中文");
    }
}
