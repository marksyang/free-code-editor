use crate::workspace::text_encoding::{self, Encoding};
use serde::Serialize;
use std::{
    path::{Component, Path},
    process::Command,
};

#[derive(Serialize, Debug)]
pub struct Entry {
    pub path: String,
    pub original: Option<String>,
    pub index: String,
    pub worktree: String,
}
#[derive(Serialize)]
pub struct Status {
    pub branch: String,
    pub entries: Vec<Entry>,
}
#[derive(Serialize)]
pub struct Diff {
    pub before: String,
    pub after: String,
}
fn run(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    crate::platform::hide_console(&mut command);
    let output = command
        .arg("--literal-pathspecs")
        .arg("-c")
        .arg("i18n.logOutputEncoding=UTF-8")
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    if output.stdout.len() > 8 * 1024 * 1024 {
        return Err("Git output exceeds 8 MiB".into());
    }
    Ok(output.stdout)
}
fn text(bytes: Vec<u8>) -> Result<String, String> {
    String::from_utf8(bytes).map_err(|_| "Git requires UTF-8 text paths and files".into())
}
fn repository(root: &Path) -> Result<(), String> {
    let top = text(run(root, &["rev-parse", "--show-toplevel"])?)?;
    if Path::new(top.strip_suffix('\n').unwrap_or(&top))
        .canonicalize()
        .map_err(|e| e.to_string())?
        != root
    {
        return Err("Open the Git repository root as the workspace".into());
    }
    Ok(())
}
fn validate(path: &str) -> Result<(), String> {
    if path.is_empty()
        || !Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("Use a relative Git path without parent traversal".into());
    }
    Ok(())
}
pub fn parse_status(bytes: &[u8]) -> Result<Vec<Entry>, String> {
    let mut records = bytes.split(|b| *b == 0).filter(|part| !part.is_empty());
    let mut entries = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 || record[2] != b' ' {
            return Err("Invalid Git status record".into());
        }
        let original = if record[..2].iter().any(|b| *b == b'R' || *b == b'C') {
            Some(text(
                records.next().ok_or("Missing rename source")?.to_vec(),
            )?)
        } else {
            None
        };
        entries.push(Entry {
            path: text(record[3..].to_vec())?,
            original,
            index: char::from(record[0]).to_string(),
            worktree: char::from(record[1]).to_string(),
        });
    }
    Ok(entries)
}
pub fn status(root: &Path) -> Result<Status, String> {
    repository(root)?;
    let branch = text(
        run(root, &["symbolic-ref", "--short", "HEAD"])
            .or_else(|_| run(root, &["rev-parse", "--short", "HEAD"]))?,
    )?;
    let entries = parse_status(&run(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?)?;
    Ok(Status {
        branch: branch.trim().into(),
        entries,
    })
}
pub fn stage(root: &Path, path: &str, undo: bool, original: Option<&str>) -> Result<(), String> {
    repository(root)?;
    validate(path)?;
    let mut args = if !undo {
        vec!["add", "--"]
    } else if run(root, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "--ignore-unmatch", "--"]
    };
    args.push(path);
    if let Some(old) = original {
        validate(old)?;
        if old != path {
            args.push(old);
        }
    }
    run(root, &args)?;
    Ok(())
}

pub fn commit(root: &Path, message: &str) -> Result<(), String> {
    repository(root)?;
    if message.trim().is_empty() || message.len() > 16384 {
        return Err("Enter a commit message (up to 16 KiB)".into());
    }
    run(root, &["commit", "-m", message])?;
    Ok(())
}
fn version(root: &Path, spec: &str, encoding: Encoding) -> Result<String, String> {
    // Missing HEAD/index entries represent newly added or deleted files.
    if run(root, &["cat-file", "-e", spec]).is_err() {
        return Ok(String::new());
    }
    text_encoding::decode(&run(root, &["show", spec])?, encoding)
}
#[cfg(test)]
pub fn diff(root: &Path, path: &str, staged: bool, original: Option<&str>) -> Result<Diff, String> {
    diff_encoded(root, path, staged, original, Encoding::Utf8)
}
pub fn diff_encoded(
    root: &Path,
    path: &str,
    staged: bool,
    original: Option<&str>,
    encoding: Encoding,
) -> Result<Diff, String> {
    repository(root)?;
    validate(path)?;
    let old = original.unwrap_or(path);
    validate(old)?;
    let before = version(
        root,
        &format!("{}:{}", if staged { "HEAD" } else { "" }, old),
        encoding,
    )?;
    let after = if staged {
        version(root, &format!(":{path}"), encoding)?
    } else if !root.join(path).try_exists().map_err(|e| e.to_string())? {
        String::new()
    } else {
        crate::workspace::read_encoded(root, path, encoding)?
    };
    Ok(Diff { before, after })
}
#[derive(Serialize, Debug)]
pub struct HistoryCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub date: String,
    pub subject: String,
}
#[derive(Serialize)]
pub struct History {
    pub commits: Vec<HistoryCommit>,
    pub head: Option<String>,
    pub has_more: bool,
}
#[derive(Serialize, Debug)]
pub struct HistoryFile {
    pub path: String,
    pub original: Option<String>,
    pub status: String,
}
#[derive(Serialize)]
pub struct CommitFiles {
    pub parent: Option<String>,
    pub files: Vec<HistoryFile>,
}
fn hash(value: &str) -> Result<(), String> {
    if ![40, 64].contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Use a full commit hash".into());
    }
    Ok(())
}
fn commit_parent(root: &Path, revision: &str) -> Result<Option<String>, String> {
    hash(revision)?;
    let parents = text(run(root, &["show", "-s", "--format=%P", revision, "--"])?)?;
    let parent = parents.split_whitespace().next().map(String::from);
    if let Some(parent) = &parent {
        hash(parent)?;
    }
    Ok(parent)
}
fn parse_history(bytes: &[u8]) -> Result<Vec<HistoryCommit>, String> {
    let mut fields: Vec<_> = bytes.split(|b| *b == 0).collect();
    if fields.last().is_some_and(|field| field.is_empty()) {
        fields.pop();
    }
    if !fields.len().is_multiple_of(5) {
        return Err("Invalid Git history record".into());
    }
    fields
        .as_chunks::<5>()
        .0
        .iter()
        .map(|f| {
            let revision = text(f[0].to_vec())?;
            hash(&revision)?;
            let parents = text(f[1].to_vec())?
                .split_whitespace()
                .map(String::from)
                .collect();
            Ok(HistoryCommit {
                hash: revision,
                parents,
                author: text(f[2].to_vec())?,
                date: text(f[3].to_vec())?,
                subject: text(f[4].to_vec())?,
            })
        })
        .collect()
}
pub fn history(root: &Path, offset: u32, anchor: Option<&str>) -> Result<History, String> {
    repository(root)?;
    let head = if let Some(anchor) = anchor {
        hash(anchor)?;
        anchor.to_string()
    } else {
        match run(root, &["rev-parse", "--verify", "HEAD"]) {
            Ok(bytes) => text(bytes)?.trim().to_string(),
            Err(_) => {
                return Ok(History {
                    commits: Vec::new(),
                    head: None,
                    has_more: false,
                })
            }
        }
    };
    hash(&head)?;
    let skip = format!("--skip={offset}");
    let mut commits = parse_history(&run(
        root,
        &[
            "log",
            "--topo-order",
            "-z",
            "--max-count=51",
            &skip,
            "--format=%H%x00%P%x00%an%x00%aI%x00%s",
            &head,
            "--",
        ],
    )?)?;
    let has_more = commits.len() > 50;
    commits.truncate(50);
    Ok(History {
        commits,
        head: Some(head),
        has_more,
    })
}
fn parse_history_files(bytes: &[u8]) -> Result<Vec<HistoryFile>, String> {
    let mut fields = bytes.split(|b| *b == 0).peekable();
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        let status = text(status.to_vec())?;
        let first = text(fields.next().ok_or("Missing history path")?.to_vec())?;
        validate(&first)?;
        let (path, original) = if status.starts_with(['R', 'C']) {
            (
                text(fields.next().ok_or("Missing rename destination")?.to_vec())?,
                Some(first),
            )
        } else {
            (first, None)
        };
        validate(&path)?;
        files.push(HistoryFile {
            path,
            original,
            status,
        });
    }
    Ok(files)
}
pub fn commit_files(root: &Path, revision: &str) -> Result<CommitFiles, String> {
    repository(root)?;
    let parent = commit_parent(root, revision)?;
    let mut args = vec![
        "diff-tree",
        "--root",
        "--no-commit-id",
        "-r",
        "-M",
        "--name-status",
        "-z",
    ];
    if let Some(parent) = &parent {
        args.push(parent);
    }
    args.extend([revision, "--"]);
    let files = parse_history_files(&run(root, &args)?)?;
    Ok(CommitFiles { parent, files })
}
#[cfg(test)]
pub fn history_diff(
    root: &Path,
    revision: &str,
    path: &str,
    original: Option<&str>,
) -> Result<Diff, String> {
    history_diff_encoded(root, revision, path, original, Encoding::Utf8)
}
pub fn history_diff_encoded(
    root: &Path,
    revision: &str,
    path: &str,
    original: Option<&str>,
    encoding: Encoding,
) -> Result<Diff, String> {
    repository(root)?;
    validate(path)?;
    let old = original.unwrap_or(path);
    validate(old)?;
    let parent = commit_parent(root, revision)?;
    let before = if let Some(parent) = parent {
        version(root, &format!("{parent}:{old}"), encoding)?
    } else {
        String::new()
    };
    let after = version(root, &format!("{revision}:{path}"), encoding)?;
    Ok(Diff { before, after })
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "editor-git-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&dir).unwrap();
            let fixture = Self(dir.canonicalize().unwrap());
            let root = &fixture.0;
            run(root, &["init"]).unwrap();
            run(root, &["config", "user.name", "Test"]).unwrap();
            run(root, &["config", "user.email", "test@example.invalid"]).unwrap();
            run(root, &["config", "commit.gpgsign", "false"]).unwrap();
            run(root, &["config", "core.autocrlf", "false"]).unwrap();
            // Preserve fixture bytes regardless of global attributes or Windows defaults.
            std::fs::create_dir_all(root.join(".git/info")).unwrap();
            std::fs::write(
                root.join(".git/info/attributes"),
                "* -text !eol !working-tree-encoding !filter\n",
            )
            .unwrap();
            fixture
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn history_preserves_fields_and_rejects_invalid_records() {
        let id = "a".repeat(40);
        let record = format!("{id}\0\0作者\02026-11-07T12:00:00+08:00\0subject with spaces\0");
        let parsed = parse_history(record.as_bytes()).unwrap();
        assert_eq!(parsed[0].author, "作者");
        assert!(parsed[0].parents.is_empty());
        assert_eq!(parsed[0].subject, "subject with spaces");
        assert!(parse_history(b"malformed\0").is_err());
        assert!(hash("--all").is_err());
        let files = parse_history_files(b"R100\0old name\0new\nname\0D\0deleted\0").unwrap();
        assert_eq!(files[0].original.as_deref(), Some("old name"));
        assert_eq!(files[0].path, "new\nname");
        assert_eq!(files[1].status, "D");
        assert!(parse_history_files(b"R100\0old\0").is_err());
    }
    #[test]
    fn history_handles_root_rename_delete_merge_and_stable_pagination() {
        let fixture = Fixture::new("history");
        let root = &fixture.0;
        assert!(history(root, 0, None).unwrap().commits.is_empty());
        std::fs::write(root.join("old name.rs"), "first\n").unwrap();
        stage(root, "old name.rs", false, None).unwrap();
        commit(root, "初始提交").unwrap();
        let initial = history(root, 0, None).unwrap().commits.remove(0);
        assert_eq!(initial.subject, "初始提交");
        assert!(commit_files(root, &initial.hash).unwrap().parent.is_none());
        let initial_diff = history_diff(root, &initial.hash, "old name.rs", None).unwrap();
        assert_eq!(initial_diff.before, "");
        assert_eq!(initial_diff.after, "first\n");
        std::fs::rename(root.join("old name.rs"), root.join("new name.rs")).unwrap();
        stage(root, "new name.rs", false, Some("old name.rs")).unwrap();
        commit(root, "Rename").unwrap();
        let renamed = history(root, 0, None).unwrap().commits.remove(0);
        let files = commit_files(root, &renamed.hash).unwrap();
        assert_eq!(files.files[0].original.as_deref(), Some("old name.rs"));
        let renamed_diff =
            history_diff(root, &renamed.hash, "new name.rs", Some("old name.rs")).unwrap();
        assert_eq!(renamed_diff.before, renamed_diff.after);
        std::fs::remove_file(root.join("new name.rs")).unwrap();
        stage(root, "new name.rs", false, None).unwrap();
        commit(root, "Delete").unwrap();
        let deleted = history(root, 0, None).unwrap().commits.remove(0);
        let deleted_diff = history_diff(root, &deleted.hash, "new name.rs", None).unwrap();
        assert_eq!(deleted_diff.before, "first\n");
        assert_eq!(deleted_diff.after, "");
        for index in 0..50 {
            run(
                root,
                &["commit", "--allow-empty", "-m", &format!("Page {index}")],
            )
            .unwrap();
        }
        let first = history(root, 0, None).unwrap();
        assert_eq!(first.commits.len(), 50);
        assert!(first.has_more);
        run(root, &["commit", "--allow-empty", "-m", "New head"]).unwrap();
        let second = history(root, 50, first.head.as_deref()).unwrap();
        assert_eq!(second.commits.len(), 3);
        assert!(!second.has_more);
        assert!(second
            .commits
            .iter()
            .all(|c| !first.commits.iter().any(|a| a.hash == c.hash)));
        let base_branch = status(root).unwrap().branch;
        run(root, &["checkout", "-b", "history-feature"]).unwrap();
        std::fs::write(root.join("feature.rs"), "feature\n").unwrap();
        stage(root, "feature.rs", false, None).unwrap();
        commit(root, "Feature").unwrap();
        run(root, &["checkout", &base_branch]).unwrap();
        std::fs::write(root.join("main.rs"), "main\n").unwrap();
        stage(root, "main.rs", false, None).unwrap();
        commit(root, "Main").unwrap();
        run(
            root,
            &["merge", "--no-ff", "-m", "Merge feature", "history-feature"],
        )
        .unwrap();
        let merge = history(root, 0, None).unwrap().commits.remove(0);
        assert_eq!(merge.parents.len(), 2);
        let files = commit_files(root, &merge.hash).unwrap();
        assert_eq!(files.parent.as_deref(), Some(merge.parents[0].as_str()));
        assert_eq!(files.files.len(), 1);
        assert_eq!(files.files[0].path, "feature.rs");
        assert_eq!(
            history_diff(root, &merge.hash, "feature.rs", None)
                .unwrap()
                .after,
            "feature\n"
        );
        assert!(history_diff(root, &merge.hash, "../outside", None).is_err());
    }
    #[test]
    fn parses_renames_spaces_newlines_and_conflicts() {
        let entries = parse_status(
            b" M space name.rs\0R  new\nname.rs\0old name.rs\0?? new.rs\0UU conflict\0",
        )
        .unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].path, "space name.rs");
        assert_eq!(entries[1].original.as_deref(), Some("old name.rs"));
        assert_eq!(entries[1].path, "new\nname.rs");
        assert_eq!(entries[3].index, "U");
        assert!(parse_status(b"R  destination\0").is_err());
        assert!(validate("../outside").is_err());
    }
    #[test]
    fn staging_committing_and_diff_keep_worktree_edits() {
        let fixture = Fixture::new("staging");
        let root = fixture.0.clone();
        std::fs::write(root.join("a file.rs"), "first\n").unwrap();
        assert_eq!(status(&root).unwrap().entries[0].index, "?");
        stage(&root, "a file.rs", false, None).unwrap();
        stage(&root, "a file.rs", true, None).unwrap();
        assert_eq!(status(&root).unwrap().entries[0].index, "?");
        stage(&root, "a file.rs", false, None).unwrap();
        commit(&root, "Initial").unwrap();
        std::fs::write(root.join("a file.rs"), "second\n").unwrap();
        let change = diff(&root, "a file.rs", false, None).unwrap();
        assert_eq!(change.before, "first\n");
        assert_eq!(change.after, "second\n");
        stage(&root, "a file.rs", false, None).unwrap();
        assert_eq!(
            diff(&root, "a file.rs", true, None).unwrap().after,
            "second\n"
        );
        stage(&root, "a file.rs", true, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("a file.rs")).unwrap(),
            "second\n"
        );
        assert!(commit(&root, "  ").is_err());
        std::fs::rename(root.join("a file.rs"), root.join("renamed.rs")).unwrap();
        stage(&root, "renamed.rs", false, Some("a file.rs")).unwrap();
        stage(&root, "renamed.rs", true, Some("a file.rs")).unwrap();
        assert!(root.join("renamed.rs").exists());
        assert!(!root.join("a file.rs").exists());
        assert!(status(&root)
            .unwrap()
            .entries
            .iter()
            .all(|entry| entry.index == " " || entry.index == "?"));
        let encoded = crate::workspace::text_encoding::encode("下午\r\n", Encoding::Big5).unwrap();
        std::fs::write(root.join("legacy.log"), &encoded).unwrap();
        stage(&root, "legacy.log", false, None).unwrap();
        commit(&root, "Big5 baseline").unwrap();
        std::fs::write(
            root.join("legacy.log"),
            crate::workspace::text_encoding::encode("上午\r\n", Encoding::Big5).unwrap(),
        )
        .unwrap();
        let encoded_diff = diff_encoded(&root, "legacy.log", false, None, Encoding::Big5).unwrap();
        assert_eq!(encoded_diff.before, "下午\r\n");
        assert_eq!(encoded_diff.after, "上午\r\n");
        assert!(diff(&root, "legacy.log", false, None).is_err());
    }
    #[test]
    fn big5_diff_respects_git_normalization_without_changing_worktree_bytes() {
        let fixture = Fixture::new("autocrlf");
        let root = &fixture.0;
        run(root, &["config", "core.autocrlf", "true"]).unwrap();
        run(root, &["config", "core.safecrlf", "false"]).unwrap();
        std::fs::write(
            root.join(".git/info/attributes"),
            "* text=auto !eol !working-tree-encoding !filter\n",
        )
        .unwrap();
        let original = text_encoding::encode("下午\r\n", Encoding::Big5).unwrap();
        std::fs::write(root.join("legacy.log"), &original).unwrap();
        stage(root, "legacy.log", false, None).unwrap();
        let staged = diff_encoded(root, "legacy.log", true, None, Encoding::Big5).unwrap();
        assert_eq!(staged.after, "下午\n");
        assert_eq!(std::fs::read(root.join("legacy.log")).unwrap(), original);
        commit(root, "Normalized Big5").unwrap();
        let edited = text_encoding::encode("上午\r\n", Encoding::Big5).unwrap();
        std::fs::write(root.join("legacy.log"), &edited).unwrap();
        let change = diff_encoded(root, "legacy.log", false, None, Encoding::Big5).unwrap();
        assert_eq!(change.before, "下午\n");
        assert_eq!(change.after, "上午\r\n");
        assert_eq!(std::fs::read(root.join("legacy.log")).unwrap(), edited);
    }
}
