use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
const MAX_FONT_BYTES: u64 = 16 * 1024 * 1024;
fn rank(path: &Path) -> Option<(u8, String)> {
    let name = path.file_name()?.to_str()?.to_lowercase();
    if !name.ends_with(".ttf") && !name.ends_with(".otf") {
        return None;
    }
    if !name.contains("nerd") && !(name.contains("meslo") && name.contains("nf")) {
        return None;
    }
    let style = ["bold", "italic", "light", "black", "medium", "thin"]
        .iter()
        .any(|s| name.contains(s));
    let score = u8::from(!name.contains("mono")) * 5
        + u8::from(style) * 20
        + u8::from(name.contains("symbols")) * 50;
    Some((score, name))
}
fn from_directories(directories: Vec<PathBuf>) -> Option<Vec<u8>> {
    let mut pending: Vec<_> = directories.into_iter().rev().map(|p| (p, 0)).collect();
    let mut candidates = Vec::new();
    let mut visited = 0;
    while let Some((directory, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 2048 {
                break;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() && depth < 3 {
                pending.push((entry.path(), depth + 1));
            }
            if kind.is_file() {
                if let Some(rank) = rank(&entry.path()) {
                    candidates.push((rank, entry.path()));
                }
            }
        }
        if visited > 2048 {
            break;
        }
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    for (_, path) in candidates {
        let Ok(file) = fs::File::open(path) else {
            continue;
        };
        let mut bytes = Vec::new();
        if file
            .take(MAX_FONT_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_FONT_BYTES
        {
            continue;
        }
        if bytes.starts_with(&[0, 1, 0, 0]) || bytes.starts_with(b"OTTO") {
            return Some(bytes);
        }
    }
    None
}
/// Load only installed Nerd Fonts, without copying font files into the repository or app bundle.
pub fn installed() -> Vec<u8> {
    let mut directories = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        directories.extend([
            home.join("Library/Fonts"),
            home.join(".local/share/fonts"),
            home.join(".fonts"),
        ]);
    }
    directories.extend([
        PathBuf::from("/Library/Fonts"),
        PathBuf::from("/usr/share/fonts"),
        PathBuf::from("/usr/local/share/fonts"),
    ]);
    if let Some(profile) = std::env::var_os("LOCALAPPDATA") {
        directories.insert(0, PathBuf::from(profile).join("Microsoft/Windows/Fonts"));
    }
    if let Some(windows) = std::env::var_os("WINDIR") {
        directories.push(PathBuf::from(windows).join("Fonts"));
    }
    from_directories(directories).unwrap_or_default()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prefers_regular_mono_nerd_fonts_and_ignores_unrelated_files() {
        let regular = rank(Path::new("SauceCodeProNerdFontMono-Regular.ttf")).unwrap();
        assert!(regular < rank(Path::new("SauceCodeProNerdFontMono-Bold.ttf")).unwrap());
        assert!(regular < rank(Path::new("SymbolsNerdFontMono-Regular.ttf")).unwrap());
        assert!(rank(Path::new("MesloLGS NF Regular.ttf")).is_some());
        assert!(rank(Path::new("Menlo.ttf")).is_none());
        assert!(rank(Path::new("NerdFont.txt")).is_none());
        let dir = std::env::temp_dir().join(format!("editor-font-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("A Nerd Font.ttf"), b"invalid font").unwrap();
        let bytes = b"\x00\x01\x00\x00test font bytes";
        fs::write(dir.join("Z Nerd Font.ttf"), bytes).unwrap();
        assert_eq!(from_directories(vec![dir.clone()]).unwrap(), bytes);
        fs::remove_dir_all(dir).unwrap();
    }
}
