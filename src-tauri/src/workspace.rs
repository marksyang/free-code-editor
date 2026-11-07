use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

pub fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    let mut temporary = None;
    for _ in 0..100 {
        let name = format!(
            ".free-code-{}-{}.tmp",
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        );
        let candidate = parent.join(name);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(file) => {
                temporary = Some((candidate, file));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    let (temporary, mut file) = temporary.ok_or("Unable to allocate temporary file")?;
    let result = (|| {
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions())?;
        }
        file.write_all(content)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok::<_, std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|e| e.to_string())
}

fn new_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    if path.is_empty()
        || !relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("Use a relative file path without parent traversal".into());
    }
    let parent = relative.parent().unwrap_or(Path::new(""));
    let parent = root
        .join(parent)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !parent.starts_with(root) {
        return Err("Path outside workspace".into());
    }
    Ok(parent.join(relative.file_name().ok_or("Missing filename")?))
}

pub fn create(root: &Path, path: &str, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("File exceeds 8 MiB".into());
    }
    let target = new_path(root, path)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options.open(&target).map_err(|e| e.to_string())?;
    if let Err(e) = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(target);
        return Err(e.to_string());
    }
    Ok(())
}

pub fn rename(root: &Path, path: &str, destination: &str, original: &str) -> Result<(), String> {
    if fs::symlink_metadata(root.join(path))
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Rename the actual file instead of its symbolic link".into());
    }
    let source = resolve(root, path)?;
    let target = new_path(root, destination)?;
    if source == target {
        return Ok(());
    }
    if read(root, path)? != original {
        return Err("File changed externally; reopen before renaming".into());
    }
    // Creating a hard link fails if the destination already exists, so no file is overwritten.
    fs::hard_link(&source, &target).map_err(|e| e.to_string())?;
    if let Err(e) = fs::remove_file(&source) {
        let _ = fs::remove_file(&target);
        return Err(e.to_string());
    }
    Ok(())
}

pub fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    Ok(path
        .strip_prefix(root)
        .map_err(|e| e.to_string())?
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

pub fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let candidate = root.join(path).canonicalize().map_err(|e| e.to_string())?;
    if !candidate.starts_with(root) {
        return Err("Path outside workspace".into());
    }
    Ok(candidate)
}

pub fn read(root: &Path, path: &str) -> Result<String, String> {
    let path = resolve(root, path)?;
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_FILE_BYTES {
        return Err("File exceeds 8 MiB".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("File exceeds 8 MiB".into());
    }
    let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    if text.contains('\0') {
        return Err("Binary files are not supported".into());
    }
    Ok(text)
}

pub fn save(root: &Path, path: &str, original: &str, content: &str) -> Result<(), String> {
    let path = resolve(root, path)?;
    if fs::read_to_string(&path).map_err(|e| e.to_string())? != original {
        return Err("File changed externally; reopen before saving".into());
    }
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("File exceeds 8 MiB".into());
    }
    atomic_write(&path, content.as_bytes())
}

pub struct Listing {
    pub files: Vec<String>,
    pub directories: Vec<String>,
}

pub fn list(root: &Path) -> Result<Vec<String>, String> {
    scan(root).map(|listing| listing.files)
}

fn ignored(entry: &fs::DirEntry) -> bool {
    [
        ".git",
        "node_modules",
        "target",
        "dist",
        ".venv",
        "__pycache__",
    ]
    .contains(&entry.file_name().to_string_lossy().as_ref())
}

/// Read only one directory; opening a workspace never traverses its descendants.
pub fn directory(root: &Path, relative: &str) -> Result<Listing, String> {
    let directory = resolve(root, relative)?;
    let mut listing = Listing {
        files: Vec::new(),
        directories: Vec::new(),
    };
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if ignored(&entry) {
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        let path = relative_path(root, &entry.path())?;
        if kind.is_dir() {
            listing.directories.push(path);
        } else if kind.is_file() {
            listing.files.push(path);
        }
    }
    listing.files.sort();
    listing.directories.sort();
    Ok(listing)
}

/// Stream entries with bounded traversal state and cancellation between entries.
fn walk(
    root: &Path,
    cancelled: impl Fn() -> bool,
    mut visit: impl FnMut(String, bool) -> Result<bool, String>,
) -> Result<(), String> {
    let mut stack = vec![fs::read_dir(root).map_err(|e| e.to_string())?];
    while !stack.is_empty() {
        if cancelled() {
            return Err("Search cancelled".into());
        }
        let Some(entry) = stack.last_mut().unwrap().next() else {
            stack.pop();
            continue;
        };
        let entry = entry.map_err(|e| e.to_string())?;
        if ignored(&entry) {
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() || !(kind.is_file() || kind.is_dir()) {
            continue;
        }
        let path = entry.path();
        let relative = relative_path(root, &path)?;
        if !visit(relative, kind.is_dir())? {
            return Ok(());
        }
        if kind.is_dir() {
            stack.push(fs::read_dir(path).map_err(|e| e.to_string())?);
        }
    }
    Ok(())
}

pub fn scan(root: &Path) -> Result<Listing, String> {
    let mut listing = Listing {
        files: Vec::new(),
        directories: Vec::new(),
    };
    walk(
        root,
        || false,
        |path, directory| {
            if directory {
                listing.directories.push(path);
            } else {
                listing.files.push(path);
            }
            Ok(true)
        },
    )?;
    listing.files.sort();
    listing.directories.sort();
    Ok(listing)
}

pub fn image(root: &Path, document: &str, source: &str) -> Result<(String, Vec<u8>), String> {
    if source.is_empty()
        || source.contains(':')
        || source.starts_with('/')
        || source.starts_with('\\')
    {
        return Err("Only relative image paths are supported".into());
    }
    let document = resolve(root, document)?;
    let target = document
        .parent()
        .ok_or("Missing document directory")?
        .join(source)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !target.starts_with(root) {
        return Err("Image outside workspace".into());
    }
    if fs::metadata(&target).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
        return Err("Image exceeds 2 MiB".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(target)
        .map_err(|e| e.to_string())?
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Image exceeds 2 MiB".into());
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("Only PNG, JPEG, GIF and WebP images are supported".into());
    };
    Ok((mime.into(), bytes))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Match {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub preview: String,
}

#[cfg(test)]
pub fn search(root: &Path, query: &str, case_sensitive: bool) -> Result<Vec<Match>, String> {
    search_cancellable(root, query, case_sensitive, || false)
}

#[cfg(test)]
pub fn search_cancellable(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    cancelled: impl Fn() -> bool,
) -> Result<Vec<Match>, String> {
    search_in_directory(root, "", query, case_sensitive, cancelled)
}

pub fn search_in_directory(
    root: &Path,
    directory: &str,
    query: &str,
    case_sensitive: bool,
    cancelled: impl Fn() -> bool,
) -> Result<Vec<Match>, String> {
    let scope = resolve(root, directory)?;
    if !scope.is_dir() {
        return Err("Search scope must be a directory".into());
    }
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if query.len() > 4096 {
        return Err("Search query is too long".into());
    }
    let needle = if case_sensitive {
        query.to_string()
    } else {
        query.to_ascii_lowercase()
    };
    let mut matches = Vec::new();
    walk(&scope, &cancelled, |relative, directory| {
        let path = relative_path(root, &scope.join(relative))?;
        if directory {
            return Ok(true);
        }
        if cancelled() {
            return Err("Search cancelled".into());
        }
        let Ok(text) = read(root, &path) else {
            return Ok(true);
        };
        for (line, value) in text.lines().enumerate() {
            if cancelled() {
                return Err("Search cancelled".into());
            }
            // ASCII case folding preserves UTF-8 positions for conversion to UTF-16.
            let haystack = if case_sensitive {
                value.to_string()
            } else {
                value.to_ascii_lowercase()
            };
            if let Some(byte) = haystack.find(&needle) {
                matches.push(Match {
                    path: path.clone(),
                    line: line + 1,
                    column: value[..byte].encode_utf16().count() + 1,
                    preview: value.chars().take(300).collect(),
                });
                if matches.len() >= 500 {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    })?;
    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "editor-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn frontend_relative_paths_use_forward_slashes_and_keep_unicode() {
        let f = Fixture::new();
        let path = f.0.join("src").join("中文.rs");
        assert_eq!(relative_path(&f.0, &path).unwrap(), "src/中文.rs");
        let outside = Fixture::new();
        assert!(relative_path(&f.0, &outside.0.join("file.rs")).is_err());
    }
    #[test]
    fn folder_search_excludes_siblings_and_preserves_workspace_paths() {
        let f = Fixture::new();
        for dir in ["src/nested", "src-other"] {
            fs::create_dir_all(f.0.join(dir)).unwrap();
        }
        for path in [
            "src/main.rs",
            "src/nested/lib.rs",
            "src-other/main.rs",
            "root.rs",
        ] {
            fs::write(f.0.join(path), "find-me").unwrap();
        }
        let mut paths: Vec<_> = search_in_directory(&f.0, "src", "find-me", true, || false)
            .unwrap()
            .into_iter()
            .map(|m| m.path)
            .collect();
        paths.sort();
        assert_eq!(paths, vec!["src/main.rs", "src/nested/lib.rs"]);
        assert_eq!(
            search_in_directory(&f.0, "", "find-me", true, || false)
                .unwrap()
                .len(),
            4
        );
        assert!(search_in_directory(&f.0, "..", "find-me", true, || false).is_err());
        assert!(search_in_directory(&f.0, "root.rs", "find-me", true, || false).is_err());
    }

    #[test]
    fn large_workspaces_open_lazily_and_remain_searchable() {
        let f = Fixture::new();
        fs::create_dir(f.0.join("recipes")).unwrap();
        for index in 0..100_010 {
            fs::write(f.0.join(format!("recipes/recipe-{index:05}.bb")), "").unwrap();
        }
        fs::write(
            f.0.join("recipes/needle.bb"),
            "unique-large-workspace-marker",
        )
        .unwrap();
        let top = directory(&f.0, "").unwrap();
        assert_eq!(top.directories, vec!["recipes"]);
        assert!(top.files.is_empty());
        assert_eq!(directory(&f.0, "recipes").unwrap().files.len(), 100_011);
        assert_eq!(list(&f.0).unwrap().len(), 100_011);
        let matches = search(&f.0, "unique-large-workspace-marker", true).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "recipes/needle.bb");
    }

    #[test]
    fn directory_listing_is_scoped_and_does_not_follow_links() {
        let f = Fixture::new();
        fs::create_dir_all(f.0.join("src/nested")).unwrap();
        fs::create_dir(f.0.join("node_modules")).unwrap();
        fs::write(f.0.join("src/main.rs"), "").unwrap();
        let listing = directory(&f.0, "src").unwrap();
        assert_eq!(listing.directories, vec!["src/nested"]);
        assert_eq!(listing.files, vec!["src/main.rs"]);
        assert!(directory(&f.0, "..").is_err());
        assert!(directory(&f.0, "src/main.rs").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/", f.0.join("escape")).unwrap();
            assert!(directory(&f.0, "escape").is_err());
            assert_eq!(directory(&f.0, "").unwrap().directories, vec!["src"]);
        }
    }

    #[test]
    fn traversal_checks_cancellation_before_descending_into_directories() {
        let f = Fixture::new();
        fs::create_dir_all(f.0.join("a/b/c")).unwrap();
        let checks = AtomicUsize::new(0);
        let result = search_cancellable(&f.0, "needle", true, || {
            checks.fetch_add(1, Ordering::Relaxed) >= 1
        });
        assert!(result.err().unwrap().contains("cancelled"));
        assert_eq!(checks.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn rejects_parent_paths_and_absolute_outside_paths() {
        let f = Fixture::new();
        assert!(resolve(&f.0, "..").is_err());
        assert!(resolve(&f.0, "/").is_err());
    }
    #[test]
    fn conflict_does_not_overwrite_external_changes() {
        let f = Fixture::new();
        fs::write(f.0.join("file.py"), "external change").unwrap();
        assert!(save(&f.0, "file.py", "old", "replacement").is_err());
        assert_eq!(read(&f.0, "file.py").unwrap(), "external change");
    }
    #[test]
    fn preserves_recipe_tabs_crlf_and_unicode() {
        let f = Fixture::new();
        let text = "all:\r\n\t@echo 中文 🦀\r\n";
        fs::write(f.0.join("Makefile"), text).unwrap();
        let changed = text.replace("all:", "build:");
        save(&f.0, "Makefile", text, &changed).unwrap();
        assert_eq!(fs::read(f.0.join("Makefile")).unwrap(), changed.as_bytes());
    }
    #[test]
    fn lists_nested_files_and_excludes_build_directories() {
        let f = Fixture::new();
        fs::create_dir(f.0.join("src")).unwrap();
        fs::create_dir(f.0.join("target")).unwrap();
        fs::write(f.0.join("src/main.c"), "").unwrap();
        fs::write(f.0.join("target/output"), "").unwrap();
        assert_eq!(list(&f.0).unwrap(), vec!["src/main.c"]);
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_pointing_outside_workspace() {
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("secret"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret"), f.0.join("link")).unwrap();
        assert!(read(&f.0, "link").is_err());
        assert!(save(&f.0, "link", "secret", "changed").is_err());
        assert!(list(&f.0).unwrap().is_empty());
    }
    #[test]
    fn create_and_rename_never_overwrite_existing_files() {
        let f = Fixture::new();
        create(&f.0, "one.md", "one").unwrap();
        create(&f.0, "two.md", "two").unwrap();
        assert!(create(&f.0, "one.md", "lost").is_err());
        assert!(rename(&f.0, "one.md", "two.md", "one").is_err());
        assert_eq!(read(&f.0, "one.md").unwrap(), "one");
        assert_eq!(read(&f.0, "two.md").unwrap(), "two");
        rename(&f.0, "one.md", "new.md", "one").unwrap();
        assert!(!f.0.join("one.md").exists());
        assert_eq!(read(&f.0, "new.md").unwrap(), "one");
    }
    #[test]
    fn new_paths_reject_parent_traversal_and_symlinked_parents() {
        let f = Fixture::new();
        assert!(create(&f.0, "../bad", "").is_err());
        assert!(create(&f.0, "/tmp/bad", "").is_err());
        #[cfg(unix)]
        {
            let outside = Fixture::new();
            std::os::unix::fs::symlink(&outside.0, f.0.join("alias")).unwrap();
            assert!(create(&f.0, "alias/bad", "").is_err());
            assert!(!outside.0.join("bad").exists());
        }
    }
    #[test]
    fn search_reports_utf16_columns_and_skips_binary_files() {
        let f = Fixture::new();
        create(&f.0, "a.md", "🦀 中文 Find\nno\nfind").unwrap();
        fs::write(f.0.join("binary"), b"\0find").unwrap();
        let results = search(&f.0, "find", false).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].line, 1);
        assert_eq!(results[0].column, 7);
        assert_eq!(results[1].line, 3);
        assert_eq!(search(&f.0, "find", true).unwrap().len(), 1);
    }
    #[test]
    fn atomic_save_preserves_permissions_and_leaves_no_temporary_files() {
        let f = Fixture::new();
        create(&f.0, "script.sh", "echo old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(f.0.join("script.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        }
        save(&f.0, "script.sh", "echo old", "echo new").unwrap();
        assert_eq!(list(&f.0).unwrap(), vec!["script.sh"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(f.0.join("script.sh"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o755
            );
        }
    }
    #[test]
    fn preview_images_are_limited_to_raster_files_inside_workspace() {
        let f = Fixture::new();
        create(&f.0, "README.md", "").unwrap();
        fs::write(f.0.join("image.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        assert_eq!(
            image(&f.0, "README.md", "image.png").unwrap().0,
            "image/png"
        );
        create(&f.0, "danger.svg", "<svg><script/></svg>").unwrap();
        assert!(image(&f.0, "README.md", "danger.svg").is_err());
        assert!(image(&f.0, "README.md", "../outside.png").is_err());
        assert!(image(&f.0, "README.md", "https://remote/image.png").is_err());
    }
    #[test]
    fn cancelled_search_stops_without_publishing_partial_results() {
        let f = Fixture::new();
        create(&f.0, "a.txt", "match").unwrap();
        assert_eq!(
            search_cancellable(&f.0, "match", true, || true).unwrap_err(),
            "Search cancelled"
        );
    }
    #[test]
    fn workspace_scan_keeps_empty_directories_in_the_explorer() {
        let f = Fixture::new();
        fs::create_dir(f.0.join("empty")).unwrap();
        fs::create_dir_all(f.0.join("src/nested")).unwrap();
        fs::create_dir_all(f.0.join("target/generated")).unwrap();
        fs::write(f.0.join("src/main.c"), "int main(void) {}").unwrap();
        let listing = scan(&f.0).unwrap();
        assert_eq!(listing.directories, vec!["empty", "src", "src/nested"]);
        assert_eq!(listing.files, vec!["src/main.c"]);
        assert_eq!(list(&f.0).unwrap(), listing.files);
    }
}
