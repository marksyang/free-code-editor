# Free Code Editor

Rust / Tauri 2 + React / TypeScript / Monaco 桌面編輯器，優先支援 macOS。專案仍在開發中，已加入 LSP 語言智慧功能，AI 功能尚未完成。

## 開發與建置

需要 Rust stable、Node.js 24 或更新版本及 Xcode Command Line Tools。首次安裝依賴需要網路連線。

```sh
npm install
npm run desktop       # 開啟桌面開發環境
npm run build         # TypeScript 檢查與前端正式建置
npm run bundle        # 產生 macOS .app
```

```sh
open "src-tauri/target/release/bundle/macos/Free Code Editor.app"
```

## 已實作功能

- 輸入絕對路徑開啟單檔或專案資料夾；以資料夾名稱為根節點的樹狀檢視（含空資料夾）、開啟檔案清單、分頁、檔名篩選、模糊快速開檔及命令面板。
- 新增未命名檔案、儲存、另存新檔、重新命名、從磁碟重新載入及重新整理檔案樹。新增、另存及重新命名不覆寫既有檔案，父資料夾須已存在。
- 左右分割編輯，可在右側選擇另一個分頁，或以兩個檢視編輯同一個緩衝區。
- Monaco 多游標、搜尋取代、縮圖導覽，以及 C、C++、Rust、JavaScript、TypeScript、JSON、Python、Perl、Bash、CSS、HTML、Makefile、Markdown、Puppet、Pascal 與 BitBake 語法上色。狀態列可手動指定語言。
- LSP 補全（含 snippets）、hover、診斷、定義／參照跳轉及跨檔案符號重新命名；提供伺服器設定、狀態與重新啟動。
- Makefile 預設使用實際 Tab，辨識 `Makefile`、`makefile`、`GNUmakefile`、`*.mk`，保留 recipe 及 `.RECIPEPREFIX` 內容。
- Markdown 清單自動延續、編號遞增、工作清單延續為未勾選項目、空項目結束清單；程式碼圍欄內不自動延續清單。
- Markdown GFM 並排即時預覽，包含表格、工作清單、程式碼上色及本機 PNG／JPEG／GIF／WebP 圖片。停用原始 HTML；遠端圖片預設封鎖，須主動勾選載入。
- 檔案樹資料夾右鍵選單提供「在資料夾中搜尋／Find in Folder…」，限定選取資料夾及子目錄；搜尋面板顯示範圍，可切回整個工作區。資料夾節點亦支援 `Shift+F10` 開啟選單。
- 分頁右鍵選單提供「Compare with…」選擇其他分頁或工作區檔案，亦可「Compare with active tab」。Monaco 唯讀並排差異檢視支援交換左右，使用已開啟分頁的未儲存內容快照；關閉不修改檔案或原分頁。
- Rust 背景專案搜尋：純文字、可區分大小寫、結果跳轉與取消過期搜尋。每行顯示第一個命中位置，最多 500 行結果；不區分大小寫時採 ASCII 大小寫摺疊。
- 分頁或視窗關閉、切換工作區前，可選擇儲存、捨棄或取消。
- 自動備份分頁、未儲存內容、語言模式、介面語言、分割與預覽設定及視窗尺寸；重新啟動時復原，保留外部修改衝突資訊。
- 繁體中文／英文操作介面切換。

## 語言與檔案辨識

| 語言／格式 | 自動辨識的檔案 | 支援方式 |
| --- | --- | --- |
| Rust | `.rs` | 語法上色；可設定 rust-analyzer 提供 LSP |
| JSON | `.json` | 語法上色、格式化、嚴格 JSON 診斷；可設定 JSON LSP |
| TypeScript | `.ts`、`.tsx`、`.mts`、`.cts`、`.d.ts` | 語法上色、單檔型別診斷與 TSX 解析；專案智慧功能透過 LSP |
| Perl | `.pl`、`.pm`、`.t`、`.psgi` | 語法上色；可設定 Perl Navigator 提供 LSP |
| Puppet | `.pp`（目前的預設解讀） | 資源、變數、註解、字串與運算子的基本上色 |
| Pascal | `.pas`、`.p` | Monaco 語法上色；Pascal 的 `.pp` 請在狀態列手動選擇 `pascal` |
| BitBake／Yocto | `.bb`、`.bbappend`、`.bbclass` | 指派／override、變數展開、續行字串及內嵌 Python／Shell 函式上色 |

既有 C、C++、JavaScript、Python、Bash、CSS、HTML、Makefile 與 Markdown 支援保留。所有模式均可由狀態列手動指定，也可用於 Markdown 程式碼區塊上色，例如 `rust`／`rs`、`typescript`／`ts`、`perl`／`pl`、`puppet`／`pp`、`bitbake`／`bb`。

`.pp` 可能是 Puppet 或 Pascal，目前預設 Puppet，Pascal 可手動切換。`.bb` 以 BitBake recipe 解讀。為避免誤判其他程式的檔案，只有可辨識的 Yocto 路徑會把 `.inc`／`.conf` 自動設為 BitBake，例如 `recipes-core/demo/base.inc`、`conf/layer.conf`、`conf/local.conf`、`conf/bblayers.conf`、`conf/machine/board.conf`；其餘可手動選擇 `bitbake`。

JSON 模式不允許註解與尾逗號，預設不發送遠端 schema 請求。內建 TypeScript worker 可處理目前編輯文件；跨檔案匯入與完整專案分析建議使用已設定的 LSP。

## 資料夾樹狀檢視

側邊欄分為「開啟的檔案」與「資料夾」；英文介面顯示 OPEN FILES／FOLDERS。開啟資料夾後，以該資料夾名稱為根節點，顯示展開箭頭、資料夾／檔案圖示、層級縮排與目前檔案反白。資料夾先於檔案排列，同類依名稱自然排序。

根節點預設展開，子資料夾預設收合；點擊資料夾可展開或收合，點擊檔案開啟編輯。空資料夾會保留為資料夾節點。開啟深層檔案時，自動展開其上層路徑；篩選檔名時保留符合結果的目錄結構。

樹內支援方向鍵導覽：上下移動、右鍵展開／進入、左鍵收合／回上層，Home／End 跳至首尾，Enter 或空白鍵開檔／切換展開。

## 語言智慧功能（LSP）

按工具列的 **LSP**，或在命令面板選擇「設定語言智慧功能」，可設定執行檔、JSON 參數陣列及環境變數。開啟已儲存的程式碼檔案後自動啟動對應伺服器；未命名檔案請先儲存。缺少伺服器時保留基本編輯，安裝後選擇「重新啟動語言服務」。

| 語言 | 預設執行檔 | 參數 |
| --- | --- | --- |
| C、C++ | `clangd`（同專案共用程序） | `[]` |
| JavaScript、TypeScript | `typescript-language-server`（共用設定及程序） | `["--stdio"]` |
| Rust | `rust-analyzer` | `[]` |
| JSON | `vscode-json-language-server` | `["--stdio"]` |
| Perl | `perlnavigator` | `["--stdio"]` |
| Python | `pyright-langserver` | `["--stdio"]` |
| Bash | `bash-language-server` | `["start"]` |
| CSS | `vscode-css-language-server` | `["--stdio"]` |
| HTML | `vscode-html-language-server` | `["--stdio"]` |

可依需求自行安裝；程式不會自動執行安裝指令：

```sh
npm install -g typescript-language-server typescript@6
npm install -g pyright
npm install -g bash-language-server
npm install -g vscode-langservers-extracted
npm install -g perlnavigator-server
rustup component add rust-analyzer rust-src
```

安裝參考：[rust-analyzer](https://rust-analyzer.github.io/book/installation.html)、[Perl Navigator](https://github.com/bscan/PerlNavigator)、[TypeScript Language Server](https://github.com/typescript-language-server/typescript-language-server#installing)、[Pyright](https://github.com/microsoft/pyright/blob/main/docs/installation.md)、[Bash Language Server](https://github.com/bash-lsp/bash-language-server)、[HTML／CSS 伺服器](https://github.com/hrsh7th/vscode-langservers-extracted)。Bash 的 lint 診斷通常還需要 ShellCheck；功能取決於伺服器及工具是否安裝。Perl Navigator 另需 Perl 執行環境。

macOS 已有 `clangd` 時可用 `command -v clangd` 確認位置。C／C++ 專案請提供 `compile_commands.json`，以供 clangd 判斷 include 路徑、巨集及編譯選項；也可在參數加入 `--compile-commands-dir=/absolute/build/path`，詳見 [clangd 專案設定](https://clangd.llvm.org/installation#project-setup)。

從 Finder 啟動的 `.app` 不一定繼承終端機的 PATH。找不到 npm 安裝的伺服器或 Node.js 時，請設定執行檔絕對路徑及環境變數 `PATH`。參數直接傳給程序，不經 shell 展開。設定存於 `~/Library/Application Support/dev.freecode.editor/lsp.json`，環境變數以明文保存。既有設定載入時保留原本的啟用狀態、路徑、參數及環境變數，並補入 Rust／JSON／Perl 的預設伺服器；TypeScript 沿用 JavaScript 的設定。

使用 `F12` 前往定義、`Shift+F12` 尋找參照、`F2` 重新命名符號，或使用命令面板。重新命名的文字修改保留在未儲存的分頁中，檢查後再個別儲存；不接受伺服器自行發起的 `workspace/applyEdit` 或檔案建立／刪除／移動操作。跳轉與修改限於工作區，系統標頭及外部相依檔案不會開啟。

文件以完整內容同步，追蹤 UTF-16 位置與版本；支援取消過期請求、逾時與退出清理。尚未支援動態註冊、程式碼動作、語意 token、格式化及伺服器自訂命令。Makefile、Markdown、Puppet、Pascal 與 BitBake 目前維持基本編輯模式，沒有整合對應的 LSP。

## 快捷鍵

| 快捷鍵 | 功能 |
| --- | --- |
| `Cmd+O` | 輸入路徑開啟檔案或專案 |
| `Cmd+P` | 模糊快速開檔 |
| `Cmd+Shift+P` | 命令面板 |
| `Cmd+N` | 新增檔案 |
| `Cmd+S` / `Cmd+Shift+S` | 儲存／另存新檔 |
| `Cmd+W` | 關閉目前分頁 |
| `Cmd+\` | 切換左右分割 |
| `Cmd+Shift+F` | 搜尋專案內容 |
| `Cmd+B` | 切換側邊欄 |

重新命名、從磁碟重新載入、重新整理檔案樹及 Markdown 預覽開關可由命令面板操作。

## 資料與限制

- 文字檔以 UTF-8 為主，上限 8 MiB；工作區不設固定項目數上限，後端已以 100,011 個檔案驗證列舉、快速開檔索引與全文搜尋；檔案樹按需載入資料夾，快速開檔首次開啟時建立完整索引，全文搜尋逐檔掃描（最多 500 筆結果），最多開啟 100 個分頁。檔案樹的篩選僅涵蓋已載入的目錄；搜尋整個工作區的檔名請使用快速開檔（⌘P）。排除 `.git`、`node_modules`、`target`、`dist`、`.venv`、`__pycache__` 與符號連結；尚未完整解析 `.gitignore`。
- 新增與重新命名的路徑限制於工作區。重新命名使用同檔案系統的硬連結避免覆寫目的檔，跨檔案系統時會回報錯誤。
- 儲存前比對原內容，再以同目錄暫存檔替換並保留權限；可偵測已發生的外部修改，但尚未消除外部程式在比對與替換之間寫入的競態。
- 本機圖片限制於工作區、上限 2 MiB；未儲存文件須先儲存，SVG 圖片不載入。只有使用者點擊的 HTTP(S) 連結會交由系統瀏覽器開啟。
- 工作階段約在操作停止 700ms 後備份至 macOS 的 `~/Library/Application Support/dev.freecode.editor/session.json`，以使用者私有權限保存。備份包含未儲存的原始碼純文字，總上限 32 MiB。異常中止可能遺失最近尚未備份的輸入；備份損毀時顯示錯誤並保留原檔。
- 尚未完成：AI 連線／Keychain／串流聊天／行內補全／Agent、即時檔案監看、完整雙語錯誤訊息及自訂快捷鍵。尚未提供 HTML／PDF 匯出、Git 介面、終端機或除錯器。

## 測試與驗證

```sh
npm test
cargo test --manifest-path src-tauri/Cargo.toml --offline
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --offline -- -D warnings
```

離線檔案服務測試也可獨立執行：

```sh
rustc --edition=2021 --test src-tauri/src/workspace.rs -o /private/tmp/free-code-editor-workspace-tests
/private/tmp/free-code-editor-workspace-tests
```

2026-11-07：Node 測試 45 個通過，1 個 `.RECIPEPREFIX` 解析測試因本機 GNU Make 3.81 而略過；Rust 測試 32 個通過。格式檢查與 Clippy 通過，TypeScript、Vite 正式建置及 macOS `.app` 打包通過。Vite 仍有大型 chunk 警告。

LSP 的 Rust 測試透過 Python 3 stdio 假伺服器驗證訊息分段、UTF-8 長度、同步、儲存、取消、逾時、退出與程序生命週期，並在本機 `/usr/bin/clangd` 存在時實測初始化及 C 定義查詢。需要 Python 3。

樹狀檢視測試涵蓋根節點、排序、空資料夾、收合、篩選、路徑展開與 React 靜態渲染；後端測試驗證空目錄、單層按需列舉、路徑邊界、遍歷取消，以及 100,011 個檔案的列舉、快速開檔索引與全文搜尋。前端協定測試驗證 UTF-16／CRLF 範圍及 workspace edit；橋接層測試透過 TypeScript 轉譯和模擬 Monaco／IPC，驗證過期結果、診斷版本、模式切換及跨檔案重新命名。橋接層測試在未安裝 TypeScript 時略過；它們不等於真實 GUI 測試。另以實際 Monaco Monarch lexer 驗證 Puppet／BitBake 與內嵌語言上色，並在瀏覽器形式的 VM context 執行實際 JSON／TypeScript worker，驗證嚴格 JSON、型別錯誤與 TSX 解析；未啟動真實 WebView。這些測試在未安裝 Monaco 時略過。本機 rust-analyzer 元件及其他新增語言伺服器尚未安裝，未逐一實測。

真實 macOS 桌面驗證另有獨立前置檢查與測試資料：

```sh
npm run test:desktop:preflight -- --launch
npm run test:desktop:fixture
```

本次實際啟動仍受阻：目前程序無法取得 CoreGraphics 圖形工作階段與視窗清單，Accessibility 檢查為 false；LaunchServices 回報 `-10827`，直接執行亦中止。發現的 bundle 簽章問題已修正為 Tauri ad-hoc 簽章，重新打包後通過 `codesign --verify --deep --strict`。**真實桌面互動尚未通過驗收**；證據、重現指令及待測項目見 [桌面驗證紀錄](docs/desktop-verification.md)。

選用的瀏覽器煙霧測試使用 Chrome 及模擬 Tauri IPC：

```sh
npm run test:ui
# 非預設 Chrome 位置時可設定 CHROME_PATH
```

此環境無法綁定本機開發伺服器埠（`EPERM`），Chrome headless 亦以 `SIGABRT` 中止，故未完成瀏覽器煙霧測試或真實桌面互動驗證。模擬 IPC 測試亦不能替代 WKWebView／Tauri 的實際操作驗證。

## 結構與圖示

- `src/`：React 介面、編輯狀態、Monaco、Markdown 預覽及操作面板。
- `src-tauri/src/`：Rust 工作區、搜尋、工作階段保存、LSP stdio 與程序管理，以及 Tauri commands。
- `tests/`：Node 回歸測試、Makefile fixtures 及 Python 假 LSP 伺服器；Rust 測試與服務程式碼放在一起。
- `scripts/`：選用的 Chrome 煙霧測試、macOS 桌面前置檢查及獨立測試資料產生器。

圖示原始檔為 `src-tauri/icons/source.svg`，PNG、ICNS 與 ICO 一起保存。修改後執行 `npm run icons` 重新產生。
