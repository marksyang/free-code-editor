# macOS 真實桌面互動驗證

## 2026-11-07 實際結果：受環境阻擋

本次嘗試啟動產出的 `.app`，沒有以單元測試或模擬 IPC 取代桌面結果。

| 檢查 | 結果 | 證據 |
| --- | --- | --- |
| Bundle 可執行檔 | 通過 | `Contents/MacOS/free-code-editor` 存在、可執行，為 arm64 Mach-O；名稱符合 `CFBundleExecutable` |
| 原始 bundle 簽章 | 失敗，已修正 | 原本只有 linker 的 ad-hoc 簽章，`codesign --verify` 回報 `code has no resources but signature indicates they must be present` |
| 修正後重新打包 | 通過 | `bundle.macOS.signingIdentity` 設為 `-`，`npm run bundle` 成功 |
| 修正後 bundle 簽章 | 通過 | `codesign --verify --deep --strict --verbose=2` 回報 `valid on disk` 及 `satisfies its Designated Requirement` |
| LaunchServices 啟動 | 失敗 | `open -n` 回傳 `NSOSStatusErrorDomain -10827`，即使可執行檔存在且修復簽章後仍無法啟動 |
| 直接啟動修正後的執行檔 | 失敗 | 程序立即中止，exit code `134`，未取得視窗 |
| CoreGraphics 桌面工作階段 | 不可用 | `CGSessionCopyCurrentDictionary()` 回傳 nil |
| CoreGraphics 視窗清單 | 不可用 | `CGWindowListCopyWindowInfo()` 回傳 nil |
| 輔助使用及畫面擷取 | 不可用 | `AXIsProcessTrusted()` 與 `CGPreflightScreenCaptureAccess()` 均為 false |
| 開檔、輸入、儲存、Markdown、LSP UI | **尚未驗證** | 沒有可操作的編輯器視窗 |

以上是目前受限執行程序所見的結果，不代表使用者的 macOS 沒有登入桌面，也不能把啟動失敗單獨歸因於簽章。沒有調整系統安全設定或授予桌面控制權限。

## 再次驗證：仍無法取得桌面

依再次要求，重新執行 `npm run test:desktop:preflight -- --launch`，並直接呼叫 LaunchServices 與 System Events；未重跑模擬 IPC 測試來替代桌面操作。

- 前置檢查 exit code：`2`，結果 `DESKTOP_BLOCKED`。
- `packageValid: true`、`signatureValid: true`。
- `graphicalSessionAvailable: false`、`windowListAvailable: false`。
- `accessibilityTrusted: false`、`screenCaptureAllowed: false`、`editorWindowsVisible: 0`。
- 直接 `open -n` 仍回傳 `NSOSStatusErrorDomain -10827`；System Events 查詢也回傳 `-10827`。
- 本次可用工具未提供桌面畫面、滑鼠或鍵盤控制介面。

結論：目前對話的執行程序仍無法取得或控制實際視窗，所有互動驗收項目維持「受阻，未執行」。再次執行同樣的建置或單元測試不會解除這個條件；須在能存取 macOS 圖形桌面的工作階段繼續。

## 在 macOS 圖形工作階段重現

使用登入 macOS 桌面的「終端機」App，於 repository 根目錄執行：

```sh
npm run bundle
npm run test:desktop:preflight -- --launch
```

`test:desktop:preflight` 驗證 bundle、簽章及桌面 API 的可用性；只有加上 `--launch` 且有可用圖形工作階段時，才送出啟動請求。它不要求權限、不點擊視窗，也不宣稱功能測試通過。

結果與 exit code：

- `PACKAGE_FAILED`／`1`：bundle 或簽章有問題。
- `DESKTOP_BLOCKED`／`2`：無法取得桌面或自動控制所需條件。
- `PREFLIGHT_READY`／`0`：可繼續驗證；**不代表互動功能已通過**。仍須查看啟動結果與實際視窗。

手動操作不需要為這個檢查程序授予輔助使用權限。若只想手動開啟：

```sh
open "src-tauri/target/release/bundle/macos/Free Code Editor.app"
```

ad-hoc 簽章僅供本機開發使用，未使用 Developer ID 或 Apple 公證；詳見 [Tauri 簽章文件](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing)。

## 測試資料

```sh
npm run test:desktop:fixture
```

指令在系統暫存目錄建立全新的獨立工作區並印出完整路徑，包含 Markdown、圖片、Makefile、C、JavaScript、Python、Bash、CSS 及 HTML。將印出的目錄路徑填入編輯器工具列後按「開啟」。不需要修改 repository 的原始碼。

## 待完成的人工互動驗收

以下各項本次均為「受阻，未執行」。必須在實際 `.app` 中操作並觀察後，才能改成通過。

| 項目 | 操作 | 預期結果 |
| --- | --- | --- |
| 啟動與開專案 | 開啟 `.app`，輸入測試目錄 | 主視窗、檔案樹及狀態列正常顯示，沒有錯誤覆蓋畫面 |
| 快速開檔與命令面板 | `Cmd+P` 搜尋 `mkfl`；再按 `Cmd+Shift+P` | 可選到 Makefile；命令面板顯示可執行命令 |
| 中文輸入與存檔 | `Cmd+N`，以輸入法輸入中文及 emoji，`Cmd+S` 另存為 `notes.md` | 組字不被快捷鍵截斷；存檔後無修改標記，重開內容一致 |
| 外部修改衝突 | 編輯 `notes.md`；用終端機在同一測試檔附加一行，再回到編輯器儲存 | 顯示衝突並保留磁碟內容與尚未儲存的編輯 |
| Makefile | 開啟 Makefile，檢查 recipe 縮排並按 Tab，儲存 | 使用實際 Tab；另在終端機用 `make -n -C 測試目錄 demo` 檢查可解析 |
| 檔案比較 | 對非目前分頁按右鍵選 Compare with active tab；另以 Compare with 選擇分頁或工作區檔案 | 顯示唯讀差異及未儲存內容、可交換左右，關閉後原分頁與內容保留；此項尚未實測 |
| 分割編輯 | 按 `Cmd+\`，右側選擇同一個分頁並編輯 | 兩側內容同步；切換不同檔案後各自保留內容 |
| Markdown | 開啟 README.md，切換 `M↓` | 顯示表格、工作清單、程式碼上色及本機圖片；原始 HTML 不執行 |
| Markdown 清單 | 在清單末尾按 Enter，再於空項目按 Enter | 延續清單／清除勾選；空項目結束清單；程式碼區塊不延續清單 |
| 資料夾搜尋 | 在檔案樹對資料夾按右鍵，選「在資料夾中搜尋」，輸入關鍵字，再切回整個工作區 | 僅顯示該資料夾及子目錄結果；點選能開啟正確檔案；切回後涵蓋整個工作區；此項尚未實測 |
| 專案搜尋 | `Cmd+Shift+F` 搜尋 `answer`，點選結果 | 正確開檔並跳到命中位置 |
| C LSP | 在 LSP 設定確認 clangd，開啟 main.c，游標放在 return 後的 answer，執行前往定義 | 顯示已連線，跳到第一行定義；hover、補全與診斷可依伺服器能力操作 |
| 符號重新命名 | 在 answer 上按 F2 改名 | 定義與參照更新，保留為未儲存修改；儲存前磁碟保持原內容 |
| 未儲存關閉 | 修改檔案後關閉分頁或視窗，分別選取消／儲存／捨棄 | 取消保留編輯；儲存正確落盤；捨棄後不在下次啟動復活 |
| 工作階段 | 儲存檔案並切換語言／分割，關閉再重開 | 恢復分頁及配置；已捨棄內容不復原 |
| 其他語言 | 自行安裝並設定其他語言伺服器，逐一開啟 fixture 檔案 | 每個伺服器的補全、診斷及跳轉分別確認；未安裝者標記未測，不以 clangd 代替 |

驗收記錄應包含日期、macOS／CPU、程式版本、每項結果、錯誤訊息及必要的該程式視窗截圖。沒有畫面或操作證據時，不以「打包成功」填寫為通過。
