# 功能：儀表板首頁工地晨報卡（方案 A）

分級：預測至少 **T2**（因為結案升版會動到危險清單上的 `plugin.json`；另預計會動到程式區的 `lib/brief.mjs`、`server.mjs`、`ui/app.js`、`ui/ui.css` 與測試檔 `scripts/brief.test.mjs`、`scripts/ui.test.mjs`、`scripts/lang.test.mjs`）。T2 要求 A、C、D 與補測試（另涉及畫面改動，完工後可選跑 E 驗收）。

> 2026-11-25 規劃（接續 `v0.10.0` 終端機 `--brief` 上線後，Oscar 指定採「方案 A」：把工地晨報做到儀表板首頁案件列表上方；同日依規格預審 4 條與 Oscar 3 點拍板更新後搬入 `docs/進行中/` 開工）。
> 讀了：`AGENTS.md`、`docs/DESIGN.md`、`docs/FAILURE-PATTERNS.md`、`.agents/pipeline-stages.json`、`ui設計規格/variables.css`、`lib/brief.mjs`、`server.mjs`、`ui/app.js`、`ui/ui.css`、`scripts/{ui,lang,brief}.test.mjs`、`docs/升級摘要/brief-patrol-command.md`。找不到 `docs/SPEC-TEMPLATE.md`（沿用通用最小格式）；`docs/LESSONS.md` 存在，本次只透過 `FAILURE-PATTERNS.md` 對照、未整份通讀。

## 這是為了解決什麼

目前工地晨報只能在終端機跑 `agy-pipeline --brief`，打開儀表板首頁時只看得到各案件卡、還得逐一進案件頁看白板；在首頁案件列表上方放一張與終端機同一份來源的「工地晨報」卡，讓一進首頁就能看見全機跨專案的提醒、防丟與衝突、待拍板、問不到項目與可開工建議卡，還能直接點去對應案件或對話頁。

## 驗收條件

**AC-1　首頁案件列表上方顯示「工地晨報」卡，文案與終端機 `--brief` 來自同一份計算、零額外 git 查詢** ✅ 對過 2026-11-25
> **白話**：儀表板首頁就像工地大門口，一進去先看到一張跟早班晨報同一本帳的今日重點公告欄；頁頂已經貼著的全機警報不重複貼第二遍，其餘提醒、防丟、待拍板與建議卡一眼看得到，也不用為了這張卡重查一次工地。
> **會發生的情況**：
> 1. 打開儀表板首頁（`#/`）時，在頂部全機提醒橫條下方、案件列表上方出現「工地晨報」卡；案件頁（`#/p/...`）與對話頁（`#/p/.../s/...`）不重複畫這張卡。
> 2. 網頁卡刻意省略已畫在頁頂橫條的全機系統項目（`onTopBanner: true`：全機故障橫條、語言設定讀不懂／無權限、儀表板重啟），而頁頂沒畫的 `unreadableLine`、專案感測器掛壞／退出記錄與 `stagesNote` 照常列在卡內；其餘非空分區每一條與終端機 `--brief` 一字不差（P2）。
> 3. `clear === true`（五個警報／待辦分區皆空）時，顯示與終端機相同的誠實清零摘要（含已檢查專案數與 `goneHidden` 附註），且若有「還沒開始的建議卡」仍照常渲染該分區（不寫成互斥而吞掉，P2／P5）；若 `!clear` 但濾掉頁頂項後卡內只剩清零（`topOnly`），誠實顯示「上方全機提醒之外，目前沒有列出其他待拍板、未存未併或進行中待辦」，不畫空白框（P5）；`!clear` 且同時有 `goneHidden` 時在卡片底部印出 `goneNote`（R1）。清零狀態絕不畫綠燈、不打勾、不宣稱通過或安全（R2／P10）。
> 4. 有待留意項（非建議卡）時預設展開、清零或僅頁頂提醒時預設收成一行摘要；手動切換收合後存進瀏覽器本機（`foldOpen('home|brief', ...)`），每 5 秒自動刷新不會蓋掉。
> 5. 常駐服務還沒 `--serve-restart`、`/api/status` 沒有 `brief` 欄位（或 `brief` 為空值）時，頁頂舊服務橫條與晨報卡位置皆明講「服務還在跑舊的程式」，不畫空白卡也不假裝沒事（P2／P5）。
> **技術**：擴充 `lib/brief.mjs` 的 `briefReport()`，以單一結構化組裝同時衍生向後相容的 `clear`／`goneHidden`／`projectCount`／`sections`／`lines` 與新增的 `title`、`clearLine`、`topOnlyLine`、`goneNote`、`copyText` 與 `groups: [{ id, title, kind, items: [{ text, project?, sessionId?, onTopBanner?, summary? }] }]`（各分區標題與條目文案只寫一份，P2）。`server.mjs` 的 `/api/status` 直接複用既有 `all`、`todo` 與 `L.state` 附帶 `brief: briefReport(all, todo, { langState: L.state })`，**零額外 git 查詢**。`ui/app.js` 的 `briefCard()` 先擋 `if (!latest) return '';` 與 `!('brief' in latest) || !latest.brief`（預審 #3），放於 `render()` 首頁分支 `projectList()` 之前，並於 `oldServerBanner()` 納入 `!('brief' in latest)`。

**AC-2　每一條晨報項目可直達對應案件或對話頁，並提供一鍵複製純文字晨報** ✅ 對過 2026-11-25
> **白話**：晨報上看到哪一間工地有狀況、哪一個對話等你點頭，點一下直接走過去看細節，不用再自己回案件清單翻找；想把整份晨報貼給 AI 或留紀錄時，按一顆鈕就能整份複製。
> **會發生的情況**：
> 1. 綁定特定對話的條目（如等你拍板、進行中待辦、已結案未存／未併、對話層問不到）渲染可點擊連結直達 `#/p/<project>/s/<sessionId>`；綁定特定專案的條目（如 `main` 未推、專案感測器掛壞、跨 worktree 衝突、未開始建議卡一律連往卡片所在的來源專案 `p.name`）渲染連結直達 `#/p/<project>`；全機條目與建議卡尾行彙總（`summary: true`）只顯示文字、不附假連結（預審 #2）。
> 2. 卡片標頭提供獨立於 `<summary>` 之外的「複製純文字晨報」按鈕，點擊後複製與終端機 `agy-pipeline --brief` 完全一致的完整純文字（`brief.copyText`，含頁頂系統項），並顯示既有「已複製到剪貼簿」回饋。
> 3. 所有標題、專案名與動態文字均經 `esc()` 跳脫，路徑參數經 `encodeURIComponent()` 編碼，防止含特殊字元或 HTML 標籤的對話標題破壞頁面。
> **技術**：`lib/brief.mjs` 組裝每個項目時同步記錄 `{ text, project, sessionId, onTopBanner, summary }`（不從顯示字串反推）；`ui/app.js` 依欄位產出 `<a class="brief-link" href="#/p/...">` 並複用既有 `[data-copy]` 點擊處理器。

**AC-3　中英雙語同步且支援白天／夜間工班風格，只使用設計規格 token、不畫綠色狀態燈** ✅ 對過 2026-11-25
> **白話**：不管切中文還是英文、白天工班還是夜間工班，這張晨報卡都跟著同步切換且配色一致；紅、藍、灰、黃標色只看項目種類，絕對不會用綠色替「沒列出項目」背書。
> **會發生的情況**：
> 1. 切換 `--lang en` 或按 `L` 切英文後，晨報卡標題、分區名、清零與 `topOnly` 摘要、`goneNote`、按鈕文案與舊服務提示全數換成英文，零中文殘留與全形空白，不含禁語（`passed`、`all clear`、`verified`、`safe`、`✓`、`✅`）。
> 2. 切換白天／夜間／自動換班風格時，卡片背景、邊框、分區色條與連結均清楚可讀，完全沿用 `ui設計規格/variables.css` 既有變數，不寫死色碼，且清零狀態不出現綠色或笑臉（P10）。
> **技術**：`ui/ui.css` 新增 `.brief-*` 樣式全部引用 `variables.css` token；`ui/app.js` 文案一律以 `zhEn(中文, English)` 動態並排（確保 `scripts/lang.test.mjs` 掃描全綠）。

**AC-4　補齊前後端、舊服務、連結跳脫與雙語回歸測試，本機與乾淨副本檢查全綠** ✅ 對過 2026-11-25
> **白話**：把「網頁跟終端機一字不差」「舊服務不畫空白卡」「只有建議卡或只有頁頂警報也不會吞掉內容」「連結都指對地方」「英文零中文與禁語」全都寫進自動化測試，本機與乾淨副本都檢查全綠。
> **會發生的情況**：更新 `scripts/brief.test.mjs`、`scripts/ui.test.mjs` 與 `scripts/lang.test.mjs`，驗證 `/api/status` 攜帶 `brief`、網頁 `briefCard()` 文字與 `briefReport()` 一字不差（P2）、頁頂項省略與 `topOnly`／`unreadableLine`／`p.note`／`stagesNote` 保留、`clear: true`＋建議卡同時呈現與 `clear: false`＋`goneNote`（預審 #1）、`!latest` 與舊服務無 `brief`／`brief: null` 處置並同步更新既有 `oldServerBanner` 基準夾具（預審 #3）、各層級項目連結與安全跳脫、清零狀態無綠燈／禁語（P10）、以及於 `enWorld()` 補帶 `brief` 驗證英文 `clear: false` 與 `clear: true`＋`goneHidden` 渲染零中文（預審 #4）；`npm test` 與 `npm run test:clean` 檢查全綠。
> **技術**：沿用 `scripts/ui.test.mjs` 與 `scripts/todo.test.mjs` 的 `uiOf()` 真實執行 `ui/app.js` 測法（L20），`section()` 標記 `P2`、`P5`、`P10`。

## 混沌推導

▸ **併發／更新時序**：每 5 秒輪詢更新畫面時，使用者剛收合或展開晨報卡 → 收合狀態存進 `localStorage`（`foldOpen('home|brief', ...)`），重畫不跳回預設。
▸ **舊版服務**：程式合併進 `main` 後尚未 `--serve-restart`，瀏覽器已先載入新 `ui/app.js` 但 `/api/status` 沒有 `brief` → `oldServerBanner()` 與 `briefCard()` 皆明講服務還在跑舊程式，絕不畫成「沒有項目」（P2／P5）。
▸ **容量**：多專案或多張未開始建議卡 → 沿用 `BRIEF_CARD_CAP`（5 張＋總數提示）與可收合設計，避免首頁被洗版、案件列表被推到畫面外。
▸ **輸入畸形**：專案名含空白／斜線、對話標題含 `<script>` 或雙引號、`data-copy` 含換行與雙引號 → 所有文字與屬性均走 `esc()`、路由參數走 `encodeURIComponent()`。

## 已拍板（2026-11-25，Oscar 確認開工）

1. **網頁卡刻意省略已畫在頁頂橫條的系統項目**：`faults.banner`、`langNote`、`board.restart` 不在首頁晨報卡內重複顯示，免得首頁上方看到兩遍；頁頂沒畫的 `unreadableLine`、`p.note`、`stagesNote` 照列，且 `copyText` 保留完整全文；若濾掉後只剩清零則印出 `topOnlyLine`，不畫空框。
2. **預設展開／收起**：有卡內待留意項（非建議卡）時預設展開，清零或 `topOnly` 時預設收成一行摘要；手動切換後由 `localStorage` 記住、5 秒刷新不覆蓋。
3. **保留一鍵複製純文字晨報鈕與項目直達案件／對話頁連結**。
4. **採納規格預審 4 條補強**：`clear` 與非空 `groups`／`goneNote` 不互斥；單一結構衍生 `lines`/`copyText`/`groups` 且建議卡連回來源專案 `p.name`；`briefCard()` 先擋 `!latest` 與 `!latest.brief` 並同步更新 `ui.test.mjs` 夾具；`lang.test.mjs` 的 `enWorld()` 補帶 `brief` 驗證英文實態。

## 明確不做

- 不在晨報卡上直接放「結案」「併進 main」「重啟」等寫入按鈕：寫入操作集中在案件白板、對話頁或主任收尾，晨報卡只做唯讀總覽＋點擊直達＋複製純文字。
- 不改動案件頁的「還差什麼」白板與對話頁 F 工地主任：首頁看跨專案晨報、案件頁看單一專案白板，兩者分工不重疊。
- 不新增瀏覽器通知（Notification API）或背景排程：定時巡檢維持交給 `/schedule` 搭配 `agy-pipeline --brief --quiet-if-clear`。

## 施作紀錄

- 2026-11-25（A 規格＋規格預審）：寫完規格並記 `--report A ok`；派 1 位獨立唯讀 `research` subagent 跑一輪 `spec-precheck` 找到 4 條（記 `--precheck found`）。依 Oscar 3 點拍板與預審 4 條補強更新規格後搬入 `docs/進行中/` 開工。
- 2026-11-25（B 寫程式＋對過 AC-1～AC-4）：
  - 擴充 `lib/brief.mjs` 的 `briefReport()` 改以單一 `groupDefs` 結構衍生 `title`、`clearLine`、`topOnlyLine`、`goneNote`、`copyText`、`sections`、`groups` 與 `lines`（條目附 `project`、`sessionId`、`onTopBanner`、`summary`），向後相容既有 CLI；建議卡一律連回來源專案 `p.name`，尾行彙總不附連結。
  - `server.mjs` 於 `/api/status` 複用現有 `all`／`todo`／`L.state` 帶出 `brief`（零額外 git 查詢）。
  - `ui/app.js` 新增 `briefCard()` 放在首頁 `projectList()` 上方並更新 `oldServerBanner()` 納入 `brief`；刻意省略已畫在頁頂橫條的 `onTopBanner` 項、保留 `unreadableLine`／`p.note`／`stagesNote`、`topOnlyLine`、`goneNote`、`data-copy` 完整純文字、安全跳脫連結與 `foldOpen('home|brief')` 收合記憶；`ui/ui.css` 新增雙風格 `.brief-*` 樣式全吃 `variables.css` token 且無 `data-k="clear"`。
  - 更新 `scripts/brief.test.mjs`、`scripts/ui.test.mjs`、`scripts/lang.test.mjs`、`scripts/faults.test.mjs`，`npm test` 33/33 支測試檔檢查全綠。
- 2026-11-25（C 打掃＋D 第 1 輪＋E 驗收＋升版結案）：
  - C 打掃：`--report C ok`（已改 0 項、建議 0 條；測試檔唯讀）。
  - D 第 1 輪：T1 檢視本輪程式／樣式／測試改動，沒對到已知死法，記 `--report D ok`。
  - E 驗收：透過瀏覽器走過 `http://127.0.0.1:4325/`（AC-1、AC-2 看到畫面實況，AC-3 英文切換看到實況、AC-4 靠自動化測試確認），記 `--report E ok`；Oscar 檢視測試頁後確認「驗收通過，可以開始收尾跑結案流程」，記 `--clear E`。
  - 升版為 `v0.11.0`（`package.json`＋`plugin.json`）、規格搬入 `docs/升級摘要/dashboard-brief-card.md` 並更新 `AGENTS.md` 索引。
  - 上線版本：v0.11.0
