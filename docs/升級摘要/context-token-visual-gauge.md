# 功能：儀表板「對話記憶量表」視覺化儀表（白天手繪尺規／夜間賽博量表）

分級：預測至少 **T2**（因為結案升版會動到危險清單上的 `plugin.json`；另預計修改程式區的 `lib/contextScale.mjs`、`lib/collect.mjs`、`ui/app.js`、`ui/ui.css`，以及色票 `ui設計規格/variables.css`、文件 `docs/DESIGN.md` 與測試 `scripts/{contextScale,ui,lang,theme}.test.mjs`，不碰 `lib/transcript.mjs`、感測器或任何攔截 hook）。T2 要求 A、C、D 與補測試（涉及對話頁視覺改動，完工後可選跑 E 驗收）。

> 2026-11-27 依 `spec` 技能起草並獲 Oscar 點頭「開工」（對應 `.agents/pipeline-tasks.json` 任務 `T-16`，接續 `v0.12.0` [context-token-scale](context-token-scale.md) 純文字記憶量表；已納入規格預審 5 條補強後搬入 `docs/進行中/`）。
> 讀了：`AGENTS.md`、`docs/ROADMAP.md`、`docs/DESIGN.md`、`docs/FAILURE-PATTERNS.md`、`.agents/pipeline-stages.json`、`.agents/pipeline-tasks.json`、`package.json`、`ui設計規格/variables.css`、`lib/contextScale.mjs`、`lib/collect.mjs`、`ui/app.js`、`ui/ui.css`、`docs/升級摘要/{context-token-scale,工地工班風畫面,night-shift-ui-theme,dashboard-theme-toggle,dashboard-brief-card,merge-suggestions-into-task-board}.md`、`scripts/{contextScale,ui,theme,lang,docsIndex}.test.mjs` 與 `agy-pipeline --context` 反查結果。找不到 `docs/SPEC-TEMPLATE.md`（沿用通用最小格式）；`docs/LESSONS.md` 與 `README.md` 存在，本次只透過 `FAILURE-PATTERNS.md` 與 `AGENTS.md` 對照、未整份通讀。

## 這是為了解決什麼

目前儀表板對話頁的「對話記憶量表」全靠幾行純文字並列，使用者得在腦中自己對照目前用量、本對話峰值、本專案過往結案的通常值與最高值以及壓縮次數；升級成以本專案真實歷史比例尺繪製的視覺化儀表（白天工班延伸為手繪工地尺規、夜間工班延伸為賽博 HUD 量表），讓記憶長到哪、壓縮前曾衝多高一眼看懂，同時嚴守不編造未知模型上限與假百分比。

## 驗收條件

**AC-1　視覺量表以單一來源的專案真實歷史比例尺呈現目前用量、本對話峰值、歷史通常值／最高值與壓縮標記** ✅ 對過 2026-11-27
> **白話**：像工地牆上釘著一把真的捲尺——尺的刻度只拿這個專案以前真的結案過的對話當基準，一眼看出「現在走到哪、這場對話曾經衝到哪（壓縮掉回來也留著殘影）、專案平常跟過往最高在哪、已經壓縮過幾次」，絕不自己編一把「模型上限 100%」的假尺。
> **會發生的情況**：
> 1. 對話頁（含活躍對話、`c.gone` 已刪工作區與 `s.movedOn` 換手對話頁）的「對話記憶量表」卡，於主數值下方、展開細節上方呈現橫向視覺量表與下方圖例列；既有的 `headline`、`metaLine`、`compactionLine`、`peakNote`、`scaleLine` 與可收合「細節」（`foldOpen` 記憶開關）完整保留，並與終端機 `agy-pipeline` 一字不差（P2）。
> 2. 當本專案有 ≥ 5 個可讀已結案對話（`scale.ready === true`）且本對話 `state === 'ok'` 時，尺規範圍為 `0` 至 `domainMax = max(目前用量, 本對話峰值, 專案歷史最高)`，於真實比例位置同步畫出：
>    - **目前用量**：自 `0` 延伸的主量條與前端游標（極小非零值保留可見指針，不偽裝成 0）；
>    - **本對話峰值**：當 `peakTokens > contextTokens`（例如壓縮後數值回落）時，保留自目前用量延伸至峰值的殘影區段與峰值標記，避免壓縮後誤以為記憶很輕；
>    - **專案歷史通常值（中位數 `median`）**與**專案歷史最高值（`max`）**兩條參考刻度；
>    - 當目前或本對話峰值超過專案過往最高時，尺規右端自然延展為本對話最高（不截斷、不硬頂滿格），過往最高刻度退回尺內真實位置，並以中性事實標註已高於過往最高（不亮固定紅燈警報，R3／P10）。
> 3. 當 `compactions > 0` 時，量表標頭旁顯示實測「壓縮 N 次」標記（與 `compactionLine` 同源；0 次時不顯示空徽章）。因實機中位數／峰值／歷史最高甚至目前用量常高度貼近（如 `511k`/`550.5k`/`554.2k` 或 `current === peak === max`），SVG 尺軌上只繪製幾何刻度／游標與 `<title>` 懸停提示（僅左端 `0` 與右端 `domainMax` 放尺端標籤），四項名稱與實數統一固定列於下方可換行圖例列，絕不疊字（預審 #4）。
> 4. 任何輸出（SVG、圖例、提示、中英文）皆零 `%` 符號、無「百分比／進度」字樣、無 `<progress>`、無未知模型上限推測、無固定警戒門檻、無綠燈或打勾背書（R2／R3／P4／P10）。
> **技術**：於 `lib/contextScale.mjs` 的 `sessionContextView()` 集中計算並輸出 `gauge` 物件（`mode: 'scale' | 'no-scale' | 'unavailable'`、`domainMax`、`domainMaxLabel`、`exceedsHistoryMax`、各標記的 `tokens`／`label`／`0..1` 歸一座標 `ratio`、`compactions`、`compactionBadge`、`ariaLabel`），`ui/app.js` 絕不重算 `formatTokens` 或比例（P2）；SVG 以純數字 `viewBox` 座標繪製且 `ui/ui.css` 只使用 `variables.css` 定義的全域變數，不新增未列白名單的區域 CSS 變數（預審 #4）。

**AC-2　樣本未滿 5 個、轉錄檔讀不到或舊服務未重啟時誠實降級，絕不畫假 0 或假滿格長條** ✅ 對過 2026-11-27
> **白話**：尺還沒校準好、資料問不到、或儀表板還在跑舊程式時，就老實畫出「空尺框＋原因」，絕不把「問不到」畫成 0，也不把沒有歷史基準的單一數字畫成一條塞滿整格的 100% 長條。
> **會發生的情況**：
> 1. **優先序與本對話不可用（`mode: 'unavailable'`）**：先判本對話是否可讀——轉錄檔遺失／讀不到／舊格式無 token／數值不合法／subagent 找不到主對話（`state !== 'ok'`）一律出 `unavailable`（即使專案樣本未滿 5 個亦優先歸為本對話不可用，不畫 `0 tokens` 量條或假指針）；改畫靜止空尺框並維持原誠實狀態文案（`問不到`／`讀不到`／`看不到`），若舊格式轉錄檔仍有 `CHECKPOINT` 壓縮紀錄則照常顯示壓縮次數標記（預審 #2、R1／P5）。
> 2. **專案可讀結案樣本不足 5 個（`mode: 'no-scale'`）**：通過本對話檢查後，若專案可讀樣本不足 5 個、歷史數值異常、或未傳入 `projectScale`（`null`），不畫假歷史刻度與會看似滿格的單條進度條；改畫靜止未校準虛線尺框並附帶誠實原因（區分尚未建檔、90 天內無結案、目前只有 N 個、或未提供比例尺），主數值、壓縮標記與峰值／拆解文字仍照常顯示（預審 #2、R1／R3／P5）。
> 3. **舊服務防護三層分流（預審 #3）**：`lib/collect.mjs` 頂層新增 `contextGaugeSupport: true`、`ui/app.js` 的 `oldServerBanner()` 納入檢查；前端採三層分流：① 缺 `contextScaleSupport` 或 `!s?.context` → 整卡只印 `OLD_LINE`；② 有 `contextScaleSupport` 但缺 `contextGaugeSupport`（`v0.12`–`v0.16` 舊服務）→ 保留既有文字並於量表位置印 `OLD_LINE`；③ 已有 `contextGaugeSupport` 但缺 `s.context.gauge` → 保留文字並於量表區印誠實降級（「問不到視覺量表資料」），不誤報舊服務（P2／P5）。
> **技術**：於 `sessionContextView()` 進入文案組裝前統一完成 `contextTokens`（有限正數）與 `effectivePeak = Math.max(contextTokens, validPeakTokens)` 驗證與正規化，不合法即整組降級 `no-tokens`（杜絕 `"null tokens"`，預審 #1）；`projectScale` 驗證 `ready && median > 0 && max > 0 && median <= max`，異常時降級 `no-scale`（P2／R1）。

**AC-3　雙主題風格各自延伸：白天為手繪工地尺規風、夜間為賽博 HUD 量表風，零硬編碼色碼且不閃爍不變綠** ✅ 對過 2026-11-27
> **白話**：切到白天工班，量表就像釘在施工紙板上的手繪紙筆尺規配水彩筆觸；切到夜間工班，就變成夜班控制室裡的賽博毛玻璃發光刻度條——風格各自到位，但兩邊都守住「不用綠色背書、不靠閃爍裝成還在跑」。
> **會發生的情況**：
> 1. **白天工班（`[data-theme="day"]`，手繪風）**：暖白紙板／白板卡面搭淡施工方格，SVG 量尺採手繪微抖筆觸尺框與圓頭手畫刻度；目前用量為水彩／色鉛筆藍（Lake Blue／天藍系）手塗感長條＋手繪箭頭游標，峰值殘影為手繪斜線陰影，歷史中位數／最高值為手繪虛線標記與紙膠帶感小標，壓縮標記為暖橘紅手繪印章框；超出過往最高延伸標註採中性 Lake Blue／藍灰（禁用紅／橘紅與綠，預審 #5）。
> 2. **夜間工班（預設 `:root`，賽博風）**：深藍炭毛玻璃儀表框搭微細電青藍圖格線，SVG 量尺採賽博分段刻度軌；目前用量為電青→電藍霓虹靜態微光量條＋菱形游標，峰值殘影為電紫半透明示波器殘留區（peak-hold）與峰值刻度線，歷史中位數／最高值為高對比 HUD 標線與膠囊小標，壓縮標記為靜態琥珀霓虹警示章；超出過往最高延伸標註採中性電藍紫色系（禁用珊瑚紅與綠，預審 #5）。
> 3. 兩套風格均嚴禁用綠色系（薄荷綠／賽博綠）代表低用量或安全、均不閃爍不呼吸（P10）；按 `T` 或切換白天／夜間／自動時即時換裝且保留折疊狀態與捲動位置；`body.dim` 斷線變灰與較窄視窗下圖表與圖例清晰不截斷；若含任何 CSS 動畫皆須納入 `@media (prefers-reduced-motion: reduce)` 停止。
> 4. 所有顏色集中定義於 `ui設計規格/variables.css`（`:root` 夜間、`:root[data-theme="day"]` 白天），`ui/ui.css` 與 `ui/app.js` 維持零硬編碼色碼（P4）；`docs/DESIGN.md` 同步補記量表雙風格延伸。
> **技術**：於 `ui設計規格/variables.css` 新增 `--color-ctx-*` 雙主題色票；`ui/app.js` SVG `<linearGradient>` `offset`／`<pattern>` 屬性一律使用 `0`～`1` 小數或純像素數值，確保字串字面量零 `%`（符合 `scripts/ui.test.mjs` P4，預審 #5）；SVG 採純 CSS `[data-theme="day"]` 分流 `.ctx-g-day`／`.ctx-g-night` 風格圖層與 `var(--color-...)`；零外部字型、圖片或套件（離線可用）。

**AC-4　中英雙語同步、無障礙語意與前後端回歸測試完整涵蓋，本機與乾淨副本檢查全綠** ✅ 對過 2026-11-27
> **白話**：切英文時量表的圖例、刻度名稱、壓縮標記、未校準說明與螢幕閱讀器摘要全數換成自然且守住紅線的英文、沒有漏中文或百分比；自動化測試把各種比例、壓縮回落、超過過往最高、未滿 5 筆、讀不到、舊服務與日夜色票一次盯緊。
> **會發生的情況**：
> 1. 切換 `--lang en` 或按 `L` 後，視覺量表圖例、壓縮標記、`aria-label`、SVG `<title>` 與降級文案全數同步切換英文，零中文殘留與全形空白，不含 `%` 與禁語（`passed`、`all clear`、`verified`、`safe`、`✓`、`✅`）。
> 2. 擴充 `scripts/contextScale.test.mjs`、`scripts/ui.test.mjs`、`scripts/lang.test.mjs`、`scripts/theme.test.mjs`（標記 `P2`、`P4`、`P5`、`P10`）：同步更新既有世界替身（`scripts/lang.test.mjs` `enWorld` 與 `scripts/contextScale.test.mjs` 既有 `fakeWorld`／英文世界補上 `contextGaugeSupport`，預審 #3），並覆蓋 `scale`／`no-scale`／`unavailable` 三態與優先序、壓縮回落殘影與標記、超過歷史最高動態延展、極小非零值、`511k/550.5k/554.2k` 與 `current===peak===max` 不疊字、畸形數值防 `NaN`/`null tokens`、三層舊服務與缺 `gauge` 分流、`gone`/`movedOn` 頁呈現、英文零中文與零 `%`、零硬編碼色碼、新 CSS 變數皆定義於 `variables.css` 與不增未列白名單區域變數。
> 3. `npm test` 與 `npm run test:clean` 檢查全綠；結案時搬入 `docs/升級摘要/context-token-visual-gauge.md`、更新 `AGENTS.md` 索引與 `docs/DESIGN.md`、`package.json` 與 `plugin.json` 同步升版。
> **技術**：測試以暫存目錄與 `uiSessionHarness`/`uiOf` 實跑 `ui/app.js`，不碰真實 `~/.pipeline-monitor-agy/`（P8）。

## 混沌推導

▸ **空間／尺度碰撞**：本專案實機結案對話的中位數、本對話峰值與歷史最高常擠在不到一成寬度內（如 `511k`／`550.5k`／`554.2k`），或 `current === peak === max`，或儀表板開在窄視窗 → SVG 尺軌只畫幾何刻度與 `<title>` 提示（僅左右端點放軸端字），四項完整數值固定列於下方可換行圖例列，不疊字、不溢出。
▸ **時間／更新時序**：每 5 秒自動重繪、或切換白天／夜間／自動換班 → SVG 採純資料繪製、日夜風格純 CSS 分流、細節折疊沿用 `foldOpen('ctx|<id>')` 記憶於 `localStorage`，不閃爍、不重置收合狀態；斷線變灰（`body.dim`）照常可讀。
▸ **輸入畸形**：假資料或異常紀錄出現 `NaN`／`Infinity`／負數／`peakTokens < contextTokens`／`median > max` → `sessionContextView()` 進入文案組裝前統一驗證並正規化 `effectivePeak`，異常時整組降級 `no-tokens` 或 `no-scale`，絕不印 `"null tokens"` 或把 `NaN` 寫入 SVG；動態字全經 `esc()` 跳脫。
▸ **容量／效能**：每 5 秒輪詢單一對話頁 → 複用既有 `sessionContextView` 與 `readTranscript` 快取，零額外檔案 I/O 與零額外 git 呼叫；輕量 inline SVG 不拖慢渲染。
▸ **權限／舊版相容**：升級後尚未 `--serve-restart` → 透過 `contextGaugeSupport` 三層分流，頁頂亮黃條、卡內留文字並於量表位置顯示 `OLD_LINE`（AC-2）；完全離線不載入外部字型、圖表庫或圖檔。

## 已拍板（2026-11-27，Oscar 確認開工）

1. **開工與納編預審**：Oscar 回覆「開工」，將規格搬入 `docs/進行中/` 並將規格預審 5 條補強（統一數值驗證與正規化、三態優先序與 `projectScale: null` 原因、三層舊服務／缺 `gauge` 分流與測試替身補齊、尺軌僅畫幾何刻度防疊字與 `variables.css` 變數白名單對齊、中性 `exceedsHistoryMax` 色系與 SVG 零 `%`）全數納入 AC 進行實作。

## 明確不做

- **不編造未知模型 Context 上限或使用百分比（`%`）**：不假設 200k／1M 分母、不畫剩餘空間進度條、不使用 `<progress>`（R3／P4）。
- **不自設固定 token 紅／黃／綠警戒區間或綠燈背書**：不因低於中位數就塗綠，也不因超過中位數或過往最高就亮固定紅燈（R2／R3／P10）。
- **不改動終端機 `agy-pipeline` 的純文字輸出與文字版記憶量表文案**：終端機維持簡潔文字，網頁文字行與終端機維持一字不差（P2）。
- **不畫歷史逐回合折線圖或掃描整份轉錄檔全部歷史步驟陣列**：只複用目前用量、本對話峰值、壓縮次數與專案歷史 `median`/`max`，零額外轉錄檔解析。
- **不改動 `lib/transcript.mjs`、感測器（`hook.sh`）或任何攔截 hook（`guard`/`escalate`/`gate`）**，也不引入任何外部圖表套件或 npm 相依。
- **不把視覺量表搬進首頁晨報卡或案件頁白板**：本次專注於對話頁既有的「對話記憶量表」卡。

## 施作紀錄

### 2026-11-27　B 寫程式＋對過 AC-1～AC-4

- **後端單一來源與資料支援旗標**：
  - [lib/contextScale.mjs](../../lib/contextScale.mjs)：新增 `posFinite()`、`compactionBadgeOf()`；於 `sessionContextView()` 進入文案組裝前統一完成 `contextTokens`（有限正數）、`effectivePeak = Math.max(currentTokens, rawPeak)` 與 `projectScale`（`ready && median > 0 && max > 0 && median <= max`）驗證與正規化，並產出 `gauge`（`scale`／`no-scale`／`unavailable` 三態優先序、比例座標 `ratio`、`domainMax`、`exceedsHistoryMax`、`compactionBadge`、`ariaLabel`）。既有文字與終端機 `agy-pipeline` 輸出保持不變。
  - [lib/collect.mjs](../../lib/collect.mjs)：`collectAll()` 頂層補上 `contextGaugeSupport: true`。
- **雙主題色票與視覺化介面**：
  - [ui設計規格/variables.css](../../ui設計規格/variables.css)：於 `:root`（夜間賽博 HUD 風）與 `:root[data-theme="day"]`（白天手繪工地尺規風）成對定義 15 個 `--color-ctx-*` 色票（禁用綠色，超出過往最高採中性藍／電藍紫）。
  - [ui/app.js](../../ui/app.js)：`oldServerBanner()` 納入 `contextGaugeSupport`；新增 `contextGaugeBlock(g, sid, hasScaleLine)`（純數字 `viewBox` 零 `%`、日夜雙圖層 `.ctx-g-day`／`.ctx-g-night`、壓縮回落殘影／斜線、未滿 5 筆與不可用虛線空尺框、下方四項可換行圖例）；更新 `contextScaleCard(s)` 實作三層舊服務與缺 `gauge` 分流及壓縮徽章。
  - [ui/ui.css](../../ui/ui.css) 與 [docs/DESIGN.md](../../docs/DESIGN.md)：補齊 `.ctx-*` 日夜雙風格樣式（零硬編碼色碼、零新增區域 CSS 變數、零閃爍動畫）與設計文件雙風格段落。
- **測試與本機檢查**：更新 [scripts/ui.test.mjs](../../scripts/ui.test.mjs)、[scripts/lang.test.mjs](../../scripts/lang.test.mjs)、[scripts/theme.test.mjs](../../scripts/theme.test.mjs) 與擴充 [scripts/contextScale.test.mjs](../../scripts/contextScale.test.mjs)（`npm test` 38/38 支測試檔檢查全綠，真實 `~/.pipeline-monitor-agy/` 與 `~/.pipeline-monitor/` 零殘留）。
- **尚未在真實瀏覽器肉眼看過的項目**：白天手繪尺規與夜間賽博 HUD 的實際像素渲染、壓縮回落斜線與霓虹光暈比例、窄視窗圖例換行實況尚未開瀏覽器預覽目視確認，待 Oscar 指示是否跑 E 驗收或結案。

### 2026-11-27　D 第 1 輪發現與修補

- D 第 1 輪（T1 自檢）找到 2 條（`--report D found`）：① `[P5/R1]` `ui/app.js` 在歷史比例尺數值異常退回 `no-scale` 且帶 `scaleLine` 時硬覆寫為「需滿 5 個可讀已結案對話」；② `[P2]` `ui/app.js` 在缺 `gauge` 時於前端自拼「壓縮 N 次／Compacted N×」。
- **修補（[lib/contextScale.mjs](../../lib/contextScale.mjs)、[ui/app.js](../../ui/app.js)、[scripts/contextScale.test.mjs](../../scripts/contextScale.test.mjs)）**：新增 `gauge.emptyLabel` 單一來源區分異常與未滿 5 筆；拿掉前端硬覆寫與自拼壓縮標籤；補齊兩處回歸檢查。

### 2026-11-27　依 Oscar 實機預覽截圖簡化夜間工班為極簡發光光條

- Oscar 檢視 `http://127.0.0.1:4327` 後回饋：「夜間工班版本的改發光的光條就好，不要那麼複雜的圖形」。
- 調整 [ui/app.js](../../ui/app.js)、[ui/ui.css](../../ui/ui.css) 與 [docs/DESIGN.md](../../docs/DESIGN.md)：保留白天手繪尺規不變，將夜間 `.ctx-g-night` 精簡為圓角暗光槽＋電青電藍發光光條與燈芯＋電紫峰值光段＋極簡細發光刻度線（移除菱形、箭頭、方帽、掛圓點與虛線框），僅對光條與發光刻度套用克制 `drop-shadow`。

### 2026-11-27　D 第 2 輪、E 驗收過了與歸檔升版

- D 第 2 輪僅檢視第 1 輪後改動之 3 檔（[lib/contextScale.mjs](../../lib/contextScale.mjs)、[scripts/contextScale.test.mjs](../../scripts/contextScale.test.mjs)、[ui/app.js](../../ui/app.js)），沒對到已知死法（`--report D ok`）；夜間光條簡化後依 Oscar 確認 `--decide D skip`。
- E 第 1 趟於本工作區獨立預覽（`http://127.0.0.1:4327`，已關閉）走查 `AC-1`、`AC-3` 看到了並記 `--report E ok`（`AC-2`、`AC-4` 標記驗不了，由自動化測試涵蓋）；Oscar 實機看過新版後確認「驗收過了」（`--clear E`）。
- 規格搬入 `docs/升級摘要/context-token-visual-gauge.md`、更新 [AGENTS.md](../../AGENTS.md) 索引並同步升版 [package.json](../../package.json) 與 [plugin.json](../../plugin.json)。

上線版本：v0.17.0
