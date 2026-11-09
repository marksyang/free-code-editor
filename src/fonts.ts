/** Explicit CJK fallback for Linux WebKitGTK, shared by editors and terminal. */
export const cjkFontFamily = '"Noto Sans Mono CJK TC", "Noto Sans CJK TC", "Noto Sans CJK SC", "Noto Sans TC", "Noto Sans SC", "WenQuanYi Micro Hei"';
export const editorFontFamily = `Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", ${cjkFontFamily}, monospace`;
export const terminalFontFamily = `"SauceCodePro Nerd Font Mono", "SauceCodePro Nerd Font", "MesloLGS NF", "MesloLGM Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", "Hack Nerd Font Mono", "Symbols Nerd Font Mono", ${editorFontFamily}`;
