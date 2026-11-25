# 功能：唯讀終端機晨報指令（agy-pipeline --brief）

分級：預測至少 **T2**（因為結案升版會動到危險清單上的 `plugin.json`；另預計會動到程式區的 `status.mjs`、`lib/cliTodo.mjs`、`lib/todo.mjs`、`lib/collect.mjs` 與文件 `README.md`，並新增程式檔 `lib/brief.mjs` 與測試檔 `scripts/brief.test.mjs`——新增的 `lib/brief.mjs` 落在危險清單定好之後，施工時須由你判斷要不要加入危險清單）。T2 要求 A、C、D 與補測試。

> 2026-11-25 規劃（依總進度追蹤對話 2026-11-24 Oscar 原話與建議對話卡開立；目前 `main` 為 `v0.9.0`，階段 3「誠實任務板」尚未併回 `main`，本初版依建議卡先接現有 `collectAll`／`todoBoard`／「還沒開始」建議卡，未來階段 3 上線後可直接銜接；同日依規格預審 5 條與 Oscar 4 點拍板更新後搬入 `docs/進行中/` 開工）。
> 讀了：`AGENTS.md`、`README.md`、`docs/ROADMAP.md`、`docs/FAILURE-PATTERNS.md`、`.agents/pipeline-stages.json`、`package.json`、`status.mjs`、`lib/{todo,cliTodo,collect,faults,conflicts,lang,events,rounds,stageLines}.mjs`、`scripts/{docsIndex,todo,lang,_harness}.test.mjs`、`docs/升級摘要/{還差什麼總表,worktree-conflict-detection}.md`。找不到 `docs/SPEC-TEMPLATE.md`（沿用通用最小格式）；`docs/LESSONS.md` 存在，本次只透過 `FAILURE-PATTERNS.md` 對照、未整份通讀。

## 這是為了解決什麼

想要搭配 Antigravity 原生 `/schedule` 定時巡檢全機工地（像晨報一樣有事才提醒、沒事安靜），但現有 `agy-pipeline --todo` 偏向逐專案完整列出所有細項且不支援「真正沒事時安靜不打擾」；這個唯讀指令直接把既有的白板與故障事實濃縮成精簡晨報，並提供誠實的安靜模式，不另造排程常駐服務。

## 驗收條件

**AC-1　一個唯讀終端機指令濃縮全機巡檢晨報，直接複用既有事實、不多跑重複的 git 查詢** ✅ 對過 2026-11-25
> **白話**：像每天早上的工地晨報，直接把主任辦公室白板上的現況濃縮成一份重點清單，不用重新派人繞整個工地查一圈；只看、不動任何檔案或 git 分支。
> **會發生的情況**：
> 1. 在任何資料夾（不需要站在 git 專案裡）執行 `agy-pipeline --brief`，只列需要留意的項目並依巡檢優先序分區呈現：
>    - **系統與服務提醒**：全機故障橫條（感測器／收工 hook／改檔把關／分級通知異常、資料搬家未完）、故障檔讀不懂或無權限讀取（`unreadableLine`）、儀表板尚未 `--serve-restart`（或連不上／忙碌逾時／跑舊版／問不到）、語言設定讀不懂或沒權限讀、個別專案的感測器掛壞或退出記錄提醒，以及退回內建五關的 `stagesNote`。
>    - **防丟與衝突警示**：已結案（或在 app 裡刪除）但資料夾還在且留有未存檔、未併存檔或問不到狀態的對話；跨 worktree 檔案重疊衝突與衝突檢查不全；各專案 `main` 尚未 push 或問不到 push 狀態。
>    - **等你拍板**：所有進行中對話的待決項（規格寫好等點頭、規格預審找到問題、驗收清單待討論、D／E 要不要再跑或等你查核），以及過期危險清單提醒（新加程式檔尚未判斷、或清單內檔案已不存在）。
>    - **問不到與看不全**：任何資料夾不在／非 git、分級未設／讀不懂、三階梯或章問不到、全機還看不到任何案件（零專案）、專案 90 天內零事件／未掛感測器（`emptyLine`）或只剩已刪工作區、對話含無法識別的系統標籤（`unknownNote`）、以及進行中對話寫好或連結的規格檔失蹤／同名歧義／讀不出 AC 格式等無法確認沒事的項目。
>    - **其餘進行中待辦與可結案提醒**：進行中對話尚缺的關卡、未對完清單、未存／未併／未蓋章，或已無待辦可按結案的精簡列示（不印「資料夾的事見……」這類純說明項；若第 4 區已有該對話的 `unknownNote`／規格異常，則不列成可按結案）。
>    - **可開工的待辦項目**：目前階段 3 誠實任務板尚未上線，直接掃描所有專案裡「還沒開始」的建議卡（每張只列一次，跨專案卡直接標出目標專案／資料夾，不漏掉目標專案尚無紀錄的卡），超過上限時列前 N 張並附總數，指路「在對應專案資料夾執行 `agy-pipeline --cards`」；未來階段 3 上線時可直接切換資料來源。
> 2. 沒有任何第 1～5 區項目且至少看得到 1 個專案時，不印空白也不宣稱「通過／安全」（R2／P10），誠實印出一句已檢查幾個專案且紀錄裡未列出需要留意的項目；若有「還沒開始」建議卡則接續列出；若有已結案且資料夾已經不在的對話，附註「資料夾已經不在的看不到」（R1）。
> 3. 帶了 `--brief` 與 `--quiet-if-clear` 以外的任何額外引數（包含不認得的 `--*`、單槓旗標 `-q`、位置引數 `quiet-if-clear` 或混用 `--lang`）時，直接印清楚錯誤提示並回傳結束碼 `1`，不靜默忽略也不被 `--lang` 攔截。
> **技術**：新增純函式模組 `lib/brief.mjs`（單一真相來源）並在 `lib/cliTodo.mjs` 新增 `doBrief`；於 `status.mjs` 將 `--brief` 分派移至 `--lang` 與 `L.state` 列印之前，交由 `parseBriefArgs(argv)` 嚴格白名單檢查並把 `L.state` 交給 `doBrief` 納入第 1 區（P2／P4）。`lib/collect.mjs` 的 `collectAll()` 回傳 `faults` 補帶 `unreadableLine: unreadableLine(faults)`；`lib/todo.mjs` 的 `serveSlowLine(seconds, cmd = '--todo')` 支援帶入 `'--brief'`。`doBrief` 單次呼叫 `collectAll({ monitorDir })`、`askServe({ cmd: '--brief' })` 與 `todoBoard(all, { restart, ago })`，**零新增 git 查詢**（P2），文案複用現有模組並以 `checklistHead`／`specNotes` 補齊規格異常檢查（跳過正在寫規格初態）。

**AC-2　誠實的安靜模式（`--brief --quiet-if-clear`）：只有在確實零待辦、零故障且零「問不到」時才安靜** ✅ 對過 2026-11-25
> **白話**：搭配定時巡檢排程時，真正沒事才安靜不打擾；只要有一件問不到、連不上儀表板、或根本看不到任何專案，就絕不裝沒事安靜略過，一定出聲提醒；純 backlog 建議卡不單獨把你叫醒。
> **會發生的情況**：
> 1. 執行 `agy-pipeline --brief --quiet-if-clear`：唯有「系統與服務零異常且儀表板確認在線且不需重啟（`restart === null`）」、「語言設定正常（`ok` 或 `unset`）」、「至少看得到 1 個專案（非 `board.empty`）」、「全專案零感測器掛壞／退出記錄／`emptyLine`／孤兒已刪資料夾／`stagesNote`、零衝突與檢查不全、零已結案未存未併、零 `main` 未推／問不到、零待拍板與過期危險清單、零進行中對話列項、零任何 `unknown`（含 `unknownNote` 與規格異常）項」**全部同時成立**時，stdout 輸出為空（0 bytes）並回傳結束碼 `0`。**「還沒開始的建議卡」與「已結案且資料夾已刪（`goneHidden`）」不單獨打破靜音**（只在本來就有上述任一提醒時一併印出）。
> 2. 只要第 1～5 區任一項非空——包含儀表板連不上／忙碌逾時／跑舊版、全機看不到任何專案（0 專案）、任一進行中對話資料夾不見／分級未設或讀不懂／三階梯或章問不到／`unknownNote`／規格失蹤或讀不出 AC、任一專案感測器掛壞／手動退出記錄／`emptyLine`／`stagesNote`、任一跨 worktree 衝突檢查不全、故障檔有讀不懂的行、語言設定讀不懂或無權限——一律輸出晨報內容（絕不靜音），回傳結束碼 `0`（權限讀取失敗如 `EPERM`／`EACCES` 沿用現有錯誤提示與結束碼 `1`）。
> 3. 必抓：全機 0 個專案（P5）、儀表板沒開／連不上（R1）、專案分級沒設定（R1）、感測器掛壞（P3）、`_sensor.jsonl` 壞行（P3）、`emptyLine`（P3）、單一對話有 `unknown`／`unknownNote`／規格失蹤其餘清零（R1／P5）。必放：至少 1 個專案、全部問得到且第 1～5 區全空、儀表板在線且不需重啟（含僅有未開始建議卡或 `goneHidden` 的情況）→ 0 bytes 空輸出＋結束碼 `0`。
> **技術**：`lib/brief.mjs` 產出單一結構 `{ clear, goneHidden, projectCount, sections, lines }`，`clear` 僅由第 1～5 區是否皆為空決定（與輸出分區共用同一計算，P2）；`--quiet-if-clear` 僅在 `clear === true` 時省略 stdout 輸出。

**AC-3　中英雙語同步且遵守三條紅線用語，純唯讀不另造排程或改寫任何檔案** ✅ 對過 2026-11-25
> **白話**：切成英文後整份晨報全數換成英文、零中文殘留也不講「all clear／passed／safe」這類禁語；這支指令純粹讀狀態印文字，不會順手改程式、併分支、或在背景起新的排程服務。
> **會發生的情況**：切換 `agy-pipeline --lang en`／`zh` 後，`--brief` 與 `--brief --quiet-if-clear` 的標題、分區名、清零摘要與錯誤提示全數同步切換，英文輸出零中文與全形空白，用語對齊 `lib/lang.mjs` 的 `TERMS`（不使用 `passed`、`all clear`、`verified`、`safe`、`✓`、`✅`）；不修改任何專案檔、不建立或改動還原點、不另建排程 daemon，可直接放進 Antigravity `/schedule` 提示詞使用。
> **技術**：所有新文案以 `zhEn(中文, English)` 動態並排寫於函式內（禁止檔頂層呼叫 `zhEn`，確保 `scripts/lang.test.mjs` 靜態掃描全綠）。`README.md` 補上 `--brief` 與 `--quiet-if-clear` 用法說明。

**AC-4　補齊 CLI、安靜模式、雙語與 R1 邊界回歸測試，本機與乾淨副本檢查全綠** ✅ 對過 2026-11-25
> **白話**：把「問不到不能裝沒事」「安靜模式不能誤靜音」「中英雙語零漏翻」「不偷跑重複 git」這些最容易安靜說謊的角落全部釘進測試，推上去前在乾淨環境重跑一次確認。
> **會發生的情況**：新增 `scripts/brief.test.mjs`，涵蓋六大分區整理、跨專案建議卡不漏不重複、預審 5 條邊界、`--quiet-if-clear` 各種必抓與必放條件（含純建議卡與 `goneHidden` 不單獨打破靜音）、未知參數防呆（含 `-q`／`--lang`）、非 git 目錄可執行、中英雙語零中文與禁語檢查，以及真實 repo＋`collectAll` 整合驗證且零額外 git 查詢；`npm test` 與 `npm run test:clean` 檢查全綠，不碰真實 `~/.pipeline-monitor-agy/` 與原版 `~/.pipeline-monitor/`。
> **技術**：`scripts/brief.test.mjs` 的 `section()` 標記對應 `docs/FAILURE-PATTERNS.md` 代號（`P2`、`P3`、`P4`、`P5`、`P8`、`P10`）；使用獨立暫存家目錄（`AGY_PIPELINE_HOME`）、獨立暫存 repo 與本機假 HTTP 服務（`listen(0)`＋`AGY_PIPELINE_PORT`），避免污染本機環境（P8）。

## 混沌推導

▸ **網路（本機服務）**：定時巡檢時儀表板常駐服務沒開、正在忙（10 秒內沒回）或還在跑舊程式 → `askServe({ cmd: '--brief' })` 回對應提醒，納入系統提醒且絕不進入安靜模式（R1／P5）。
▸ **時間**：不自編「超過幾天沒動就警告」的門檻或緊急分數（R3）；只照既有 `ago()` 顯示最後動作時間。
▸ **容量**：未開始建議卡很多或專案很多時 → 建議卡列前 N 張並明講總張數與「在對應專案資料夾執行 `agy-pipeline --cards`」指路，絕不靜默省略（P5）；複用單次 `collectAll` 的 `withGitMemo`，不多跑重複 git 查詢（P2）。
▸ **權限憑證**：在沙盒內執行遇到 `~/.pipeline-monitor-agy/` 無權限（`EPERM`／`EACCES`）→ 沿用 `status.mjs` 既有錯誤提示並回傳結束碼 `1`，絕不靜音當沒事（R1）。
▸ **輸入畸形**：使用者把 `--quiet-if-clear` 拼錯（如 `--quiet`、`-q`、`quiet-if-clear`）或混用 `--lang`、或 `lang.json`／`_sensor.jsonl`／`pipeline-stages.json` 內容損壞 → 非法參數直接報錯回 `1`；設定或故障檔損壞照實列出且絕不靜音（R1）。

## 已拍板（2026-11-25，Oscar 確認開工）

1. **先做基於現有 `todoBoard`＋未開始建議卡的初版**：階段 3 誠實任務板尚未併回 `main`，先完成初版並保留銜接空間。
2. **「還沒開始的建議卡」不單獨打破 `--quiet-if-clear` 靜音**：只在本來就有其他待辦／異常時一併印出；一般 `--brief`（不帶 `--quiet-if-clear`）照常列出。
3. **「已手動 `--off` 退出記錄的專案」不靜音**：比照 `--todo` 照實列出提醒、不放進安靜清零。
4. **已結案且資料夾已刪（`goneHidden`）＋安靜輸出格式＋跨 worktree 衝突**：`goneHidden` 不單獨打破 `--quiet-if-clear`（非安靜輸出照實附註看不到）；清零靜音輸出 0 bytes stdout＋結束碼 `0`；跨 worktree 衝突與檢查不全納入防丟與衝突區。
5. **採納規格預審 5 條補強**：`collectAll()` 補帶 `faults.unreadableLine`；納入 `p.emptyLine`／無活資料夾專案／`card.stagesNote`／`s.unknownNote`；`status.mjs` 將 `--brief` 移到 `--lang` 與 `L.state` 列印之前並嚴格拒收未知參數；建議卡第 6 區一律只掃 `p.suggestions`；進行中對話規格失蹤／同名歧義／無 AC 格式歸入第 4 區並抑制 `r.clear`。

## 明確不做

- 不自建排程常駐服務（cron／launchd daemon）：定時觸發交給 Antigravity 原生 `/schedule`。
- 不自動執行合併、提交、推送、重啟或結案：純唯讀巡檢指令。
- 不自編「太久沒動」天數門檻或緊急度分數（R3）。
- 不額外對「已結案且資料夾已刪除」的舊工作區跑 git 查詢（沿用 `todoBoard` 邊界，非安靜模式照實標註看不到）。
- 不更動儀表板網頁 UI（本輪只做終端機唯讀指令 `--brief`）。

## 施作紀錄

- 2026-11-25（A 規格＋規格預審）：寫完規格並記 `--report A ok`；派 1 位獨立唯讀 `research` subagent 跑一輪 `spec-precheck` 找到 5 條（記 `--precheck found`）。依 Oscar 4 點拍板與預審 5 條補強更新規格後搬入 `docs/進行中/` 開工。
- 2026-11-25（B 寫程式＋對過 AC-1～AC-4）：
  - 新增純函式單一真相來源 `lib/brief.mjs`（`BRIEF_CARD_CAP`、`parseBriefArgs`、`briefReport`），以 `zhEn` 動態並排提供所有文案、零額外 git 呼叫；消費 `collectAll` 與 `todoBoard` 既有事實並補齊 `faults.unreadableLine`、`p.emptyLine`、孤兒已刪資料夾專案、`card.stagesNote`、`s.unknownNote` 與進行中對話 `A` 關卡規格異常檢查；`clear` 僅由第 1～5 區是否皆空決定（未開始建議卡與 `goneHidden` 不單獨打破 `--quiet-if-clear` 靜音，非安靜模式照實列出或附註）。
  - 接入 `lib/collect.mjs`（`faults.unreadableLine`）、`lib/todo.mjs`（`serveSlowLine(seconds, cmd)`）、`lib/cliTodo.mjs`（`doBrief` 與 `askServe` `cmd` 傳遞）、`status.mjs`（`--brief` 移至 `--lang` 與 `L.state` 列印之前分派）與 `README.md` 用法說明。
  - 新增 `scripts/brief.test.mjs`（68 項檢查皆為 ✓）；`npm test` 33/33 支測試檔檢查全綠，未觸及真實 `~/.pipeline-monitor-agy/` 與原版 `~/.pipeline-monitor/`。
- 2026-11-25（C 打掃＋D 第 1 輪＋危險清單拍板＋升版結案）：
  - C 打掃：`--report C ok`（已改 0 項、建議 0 條；測試檔唯讀）。
  - D 第 1 輪：T1 依規自行檢視本輪 6 支程式／測試檔，沒對到已知死法，記 `--report D ok`。
  - 危險清單判斷：Oscar 拍板 `lib/brief.mjs` 不加入 `tiers.danger`（清單維持 12 條），並以 `--tier-checked` 記下原話。
  - 升版為 `v0.10.0`（`package.json`＋`plugin.json`）、規格搬入 `docs/升級摘要/brief-patrol-command.md` 並更新 `AGENTS.md` 索引。
  - 上線版本：v0.10.0
