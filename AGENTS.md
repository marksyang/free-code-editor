# Repository Guidelines

## Project Structure & Module Organization

This project uses Rust and Tauri 2 for the desktop backend and React, TypeScript, Monaco Editor, and Vite for the frontend. Frontend source lives in `src/`; Rust code and desktop configuration live in `src-tauri/`. See `README.md` for implemented features and known gaps.

Keep frontend modules under `src/`, Node tests and fixtures under `tests/`, optional browser checks under `scripts/`, and Rust services under `src-tauri/src/`. Group modules by feature and document layout changes in `README.md`.

## Build, Test, and Development Commands

Run `npm install` to install dependencies, `npm run desktop` for desktop development, `npm run build` for frontend checks and builds, and `npm run bundle` to package the application. Run Rust tests using `cargo test --manifest-path src-tauri/Cargo.toml`.

`npm test` runs language, editor-state, folder-tree, Markdown-list, Makefile, tokenizer/worker and LSP regression tests on Node.js 24. Most tests need no installed dependencies; LSP bridge adapter and tree-rendering tests require TypeScript (and React for rendering); tokenizer and language-worker checks require Monaco. These checks skip when their dependencies are absent. Makefile parsing checks use the installed `make` and skip unsupported versions. For offline Rust service tests, use the standalone `rustc --test` command in `README.md`. Full frontend and desktop checks require downloaded dependencies.

## Coding Style & Naming Conventions

Follow the selected language’s standard conventions and use consistent indentation throughout each file. Configure a formatter and linter when introducing the toolchain, and commit their configuration.

Choose descriptive names that reflect purpose. Keep filename casing consistent within each module type, and avoid mixing naming patterns without a framework requirement.

## Testing Guidelines

Rust service tests are colocated in `src-tauri/src/workspace.rs`, `session.rs` and `lsp.rs`; Node built-in tests live in `tests/`. LSP stdio tests require Python 3; a real clangd integration check runs when `/usr/bin/clangd` is available. No React component test framework or coverage threshold is established. Test user-visible behavior, file integrity, path boundaries, and asynchronous state changes. Report standalone unit results separately from unverified desktop integration checks. `npm run test:ui` is an optional Chrome check with mocked IPC; it does not verify Tauri or WKWebView integration. Use `npm run test:desktop:preflight` for macOS prerequisites and record actual interaction evidence separately in `docs/desktop-verification.md`.

## Commit & Pull Request Guidelines

No Git history is available to establish existing commit conventions. Once Git is initialized, use concise, imperative commit subjects, such as `Add editor layout` or `Fix file loading`.

Pull requests should describe the change, explain its purpose, link relevant issues, and report validation performed. Include screenshots for visible interface changes and identify any setup or configuration changes reviewers need.

## Security & Configuration

Keep credentials and local configuration out of version control. Provide placeholder configuration examples when needed, and ignore generated output and installed dependencies.

## 回應語言

請使用繁體中文回應使用者，包含說明、進度更新與最終回覆。程式碼、指令、檔案路徑及專有名詞可保留原文。
