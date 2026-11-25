# 功能：多 worktree 並發改動衝突偵測

分級：預測至少 **T2**（因為結案升版會動到危險清單上的 `plugin.json`；另會動到程式區的 `lib/collect.mjs`、`lib/todo.mjs`、`lib/cliFacts.mjs`、`lib/cliView.mjs`、`status.mjs`、`ui/app.js`，並新增程式檔 `lib/conflicts.mjs` 與測試檔 `scripts/conflicts.test.mjs`——新增的 `lib/conflicts.mjs` 落在危險清單定好之後，施工時須由你判斷要不要加入危險清單）。T2 要求 A、C、D 與補測試。

> 2026-11-24 規劃（依總進度追蹤對話 2026-11-24 Oscar 原話與建議對話卡開立；階段 1 已併回 `main`，目前 `main` 版本為 `v0.8.0`；同日依規格預審 7 條與 Oscar 拍板更新後搬入 `docs/進行中/` 開工）。
> 讀了：`AGENTS.md`、`README.md`、`docs/ROADMAP.md`（搜衝突／worktree 段落）、`docs/FAILURE-PATTERNS.md`、`.agents/pipeline-stages.json`、`package.json`、`lib/{collect,todo,cliView,cliTodo,cliFacts,git,tier,lang,scope,origin}.mjs`、`status.mjs`、`server.mjs`、`ui/app.js`、`scripts/{docsIndex,ui}.test.mjs`、`docs/升級摘要/tier-escalation-notify.md`。找不到 `docs/SPEC-TEMPLATE.md`（沿用通用最小格式）；`docs/LESSONS.md` 存在，本次只透過 `FAILURE-PATTERNS.md` 對照、未整份通讀。

## 這是為了解決什麼

同時開好幾個 worktree 並行施工時，兩個對話各自改到同一支檔案不會馬上報錯，往往要到最後合併回 `main` 才發現撞車重做；這個功能直接拿產線監視器已經算好的各活躍工作區改動清單做比對，在儀表板與終端機提早講清楚哪幾個對話／分支都動到哪幾支檔。

## 驗收條件

**AC-1　多個活躍工作區動到同一支檔時，馬上抓得出來且不多跑重複的 git 查詢** ✅ 對過 2026-11-24
> **白話**：好幾個工班在不同工作資料夾同時開工，只要有兩組以上動到同一面牆（同一個檔案），監視器直接拿各工班現成的施工清單對照就能立刻指出撞車，不用重新繞工地查一次；已拆掉的資料夾、收工且沒留未存改動的舊資料夾，以及只是從主線同步進來的檔案，都不會來亂報警。
> **會發生的情況**：同一個專案有兩個以上有紀錄或有還原點的工作區時，只要至少兩個參與工作區動到同一支檔，就能查出重疊的檔名與對應對話／分支（含尚未被 git 追蹤的新檔案，以及搬家改名的新舊兩個路徑）；資料夾已刪除（`gone`）、非 git 資料夾、已結案且確認沒有未存改動的工作區，以及僅由 `main` 併入且沒看到本對話動過的檔案（P12），都不會被算進衝突；已結案但仍留有未存改動的工作區只計其未存改動檔案參與比對；同一工作區裡有多個對話共用（`sharesCwd`）或不同子目錄／捷徑指到同一實體工作區（P13），先歸一去重，不會誤報成自己跟自己衝突。
> **技術**：新增 `lib/conflicts.mjs` 作為單一真相來源，純函式直接複用 `lib/collect.mjs` 已算好的 `cards` 與 `sessions` 做交集，**`collectAll()` 零新增 git 指令**（P2）。`collectAllNow()` 與單一專案輔助函式在建卡／跳過前，先透過 `gitContext` 將真實存在且屬 git repo 的子目錄／symlink `e.cwd` 歸一為 `real(ctx.root)`（不以路徑前綴比對，以免誤併巢狀獨立 repo，P1/P13/P6）。`buildCard()` 與 `gatherChange()` 直接保留現成 `root: real(ctx.root)` 與 `dirtyFiles: dirtySet ? [...dirtySet].sort() : null`（零額外 git 呼叫，不反組含本地化資料夾名的 `files.unsaved`，P1/P2/R1）。去重與篩選順序：先過濾 `gone`/`notGit`，以 `real(card.root ?? card.path)` 去重合併，配對對話時排除 `s.movedOn`；參與條件為「有任一未結案非 `movedOn` 對話」或「`dirty > 0`」或「`dirty === null`」；**去重篩選後參與者 `< 2` 即不回報衝突或檢查不全**（P13/P5）。活躍工作區（含零 commit 只看 `dirtyFiles`）取 `health.list` 逐筆經 `unquotePath` 後聯集 `dirtyFiles`（`dirtyPaths()` 已由 `-z` 去引號，不再重複 `unquotePath`，P1）；已結案或僅有還原點（無對話紀錄）而僅因 `dirty > 0` 參與者只取 `dirtyFiles`。重疊依相同參與工作區集合分組排序。

**AC-2　儀表板與終端機四處講同一句話，明講哪幾個對話／分支都動到哪幾支檔** ✅ 對過 2026-11-24
> **白話**：不論你看網頁的案件頁、點進個別對話頁，還是在終端機跑 `agy-pipeline` 或 `agy-pipeline --todo`，看到的衝突提醒字句都一字不差，直接講明哪幾個對話（附分支名）都動到哪幾支檔，檔案很多時只列前 3 支再寫「等 N 支檔」，不洗版；白板上重疊算「等你決定」（紅筆）、看不全算「看不到」（灰筆），但不會熄掉工地主任「只剩收尾」的黃燈，方便你拍板先併哪一條。
> **會發生的情況**：
> 1. 儀表板案件頁（白板）與終端機 `agy-pipeline --todo` 顯示該專案全部條目，每條寫明代表對話標題＋分支名（`sharesCwd` 多活對話採最近活躍標題加註「等 N 個對話」；無標題直用分支名不重複印兩次；已結案／僅有還原點各有明確註記，且已結案 `dirty === null` 標成「已結案、問不到有無未存檔」，絕不寫成仍有未存改動，R1）與重疊檔名（超過 3 支時採前 3 支＋「等 N 支檔」口徑）。
> 2. 儀表板對話頁（正常活躍對話頁，不含 `c.gone` 與 `s.movedOn` 舊頁，P6）與終端機 `agy-pipeline`（含零 commit 工作區 `!ctx.hasCommits` 早退分支）只顯示「包含本工作區」的重疊條目及檢查不全警告，字句與案件頁／`--todo` 一字不差；單獨提醒不關掉 F 工地主任「只剩收尾」黃燈。
> 3. 所有參與工作區都問得到且沒有重疊時，安靜不顯示衝突提醒，也不貼「無衝突／安全」的綠燈或打勾（R2／P10）。
> 4. 常駐儀表板還沒 `--serve-restart` 跑舊程式時，每一頁上方黃條照常提醒，不把缺欄位當成沒衝突（P2／P5）。
> **技術**：所有文案集中於 `lib/conflicts.mjs`，以 `zhEn` 動態並排。`collectAll()` 掛上 `p.conflicts`、各卡／活躍對話 `conflicts` 與頂層 `conflictSupport: true`；`ui/app.js` 照印不另算，且於 `oldServerBanner()` 納入 `!('conflictSupport' in latest)`。`lib/todo.mjs` 的 `projectSection(p)` 將衝突寫入 `sec.conflicts`（`ask` 紅筆／`unknown` 灰筆）供 `boardText()` 與 `whiteboard()` 共用，納入筆槽 `used` 與 `bossMood()` 並排除出 `quiet`，不動 `callLine()`（P2/P10）。`status.mjs` 預設檢視與 `!ctx.hasCommits` 分支皆包進 `withGitMemo`，透過 `lib/collect.mjs` 的 `projectConflictsFor()`（僅看同專案已知兄弟工作區並複用當前工作區已算好的事實；單工作區零額外 git 呼叫）與 `lib/cliView.mjs` `renderConflicts()` 輸出。

**AC-3　有任何工作區問不到改動或看不全已存改動時，誠實說明衝突檢查不全** ✅ 對過 2026-11-24
> **白話**：同時有三個工作區在動，就算看得到的兩個沒有撞車，只要第三個暫時問不到 git 改動、找不到這一輪起點、或是蓋章後還有沒併回主線的舊存檔沒納入比對，監視器絕不裝沒事，一定講明白「衝突檢查不全」並點名是哪一個工作區。
> **會發生的情況**：
> 1. 專案去重篩選後有至少 2 個可能參與的工作區，且其中任一個遇以下情況時，四處同步顯示檢查不全警告並點名該對話／分支：
>    - 活躍工作區問不到 git 改動（`health.list === null`）或問不到未存改動（`dirty === null`）；或已結案／僅還原點工作區問不到有無未存檔（`dirty === null`）。
>    - 活躍參與工作區找不到這一輪起點只能看到未存改動（`scope.blind === true`，已結案僅取未存檔者不誤觸 `blind`，P5）。
>    - 活躍參與工作區目前基準為上次蓋章（`base.kind === 'checkpoint'`）且尚有未併回主線的存檔（`ladder.unmerged > 0`），僅比對了蓋章後的改動（零額外 git 呼叫，P1/P5）。
> 2. 已比對出部分衝突、同時又有另一個工作區檢查不全時，兩邊訊息同時呈現，互不覆蓋。
> 3. 專案去重後只有 1 個參與工作區時，不跳跨工作區檢查不全提醒。
> **技術**：`lib/conflicts.mjs` 區分 `overlaps`（`kind: 'ask'`）與 `incomplete`（`reason: 'unreadable' | 'dirty-unknown' | 'blind' | 'checkpoint-unmerged'`，`kind: 'unknown'`），同類原因合併點名工作區；英文依 `lib/lang.mjs` `TERMS`（`問不到` → `couldn't check`、`看不全` → `can't see all of it`），嚴禁 `no conflicts`／`all clear`／`safe`。

**AC-4　中英雙語同步、純唯讀提醒不干擾編輯，補齊回歸測試且檢查全綠** ✅ 對過 2026-11-24
> **白話**：切到英文後四處的衝突與檢查不全提醒全數換成英文、零中文殘留且不說禁語；這個功能只幫你看清楚撞車，不會鎖住檔案、不會擋你改檔，也不會擅自合併；補齊各種邊界測試後，本機與乾淨副本檢查全綠。
> **會發生的情況**：切換 `--lang en`／`zh` 後，儀表板案件頁、對話頁、`agy-pipeline` 與 `agy-pipeline --todo` 全數同步且英文零中文殘留；不新增或改變任何編輯權限、改檔把關或收工門禁行為；新增測試覆蓋多 worktree 重疊、多檔前 3 支＋等 N 支、排除 `gone`／已結案無未存／P12 `main` 併入檔、納入已結案有未存檔、同工作區共用與子目錄／捷徑歸一去重（P13）、`health.list === null`／`dirty === null`／`blind`／`checkpoint + unmerged > 0`（R1／P5）、四處文案一字不差（P2）、舊服務黃條、筆槽紅灰筆亮燈、F 黃燈不滅、零重複 git 查詢與中英雙語，`npm test` 與 `npm run test:clean` 檢查全綠。
> **技術**：新增 `scripts/conflicts.test.mjs`（`section()` 標記 `P1`、`P2`、`P5`、`P10`、`P12`、`P13`），同步更新 `scripts/ui.test.mjs`（`oldServerBanner` 驗證 `conflictSupport`），不碰真實 `~/.pipeline-monitor-agy/` 與原版 `~/.pipeline-monitor/`。結案時搬入 `docs/升級摘要/worktree-conflict-detection.md`、更新 `AGENTS.md` 索引、`package.json` 與 `plugin.json` 同步升版。

## 混沌推導

▸ **時間**：`agy-pipeline` 終端機查詢兄弟工作區時可能增加執行時間 → 只掃描同專案已知兄弟工作區，複用當前工作區已算好的事實並包在 `withGitMemo` 內；單工作區零額外 git 呼叫；儀表板與 `--todo` 複用 `collectAll()` 零額外 git 呼叫。
▸ **併發**：另一 worktree 正執行 `git commit`／`rebase` 致 `.git/index.lock` 失敗 → `health.list` 或 `dirty` 回 `null`，依 AC-3 顯示檢查不全警告，絕不折成沒衝突（R1）。
▸ **容量**：多支共同檔案或多組重疊 → 每組檔名採前 3 支＋「等 N 支檔」（沿用 `fewFiles` 口徑），不洗版。
▸ **輸入畸形**：檔名含空白／引號／中文、detached HEAD、無標題、僅還原點無對話、零 commit → `dirtyFiles` 不重複去引號且只對 `health.list` 套用 `unquotePath`（P1）；無標題不重複分支名；零 commit 改採未存檔清單（P5）。

## 已拍板（2026-11-24，Oscar 確認開工）

1. **已結案但仍有未存改動的工作區**：只比對未存改動檔（`dirtyFiles`），不計已存舊 diff、不誤觸 `blind`／`checkpoint-unmerged`。
2. **不關掉 F 工地主任黃燈**：衝突提醒獨立顯示，留給你決定先併哪一條。
3. **不額外跑 `git worktree list`**：維持只比對有紀錄或有還原點的工作區。
4. **白板與筆槽顏色**：重疊衝突用紅筆（`ask`，等你決定）、檢查不全用灰筆（`unknown`，看不到），皆納入筆槽 `used`。
5. **活分支蓋章後尚有未併主線存檔（`checkpoint + unmerged > 0`）**：以現成 `ladder.unmerged` 零成本補「僅比對蓋章後改動、衝突檢查不全」誠實提醒（R1）。
6. **其餘預審 5 條對齊修補全收**：含 `dirtyFiles`、子目錄 `e.cwd` 歸一、`status.mjs` 包 `withGitMemo` 與 `!hasCommits` 出口、經 `sec.conflicts` 共用與 `sessionPage` 排除 `gone`/`movedOn`、去重與標籤 5 規則。

## 明確不做

- **不做自動合併或自動解決衝突**：只呈現檔案重疊事實，合併順序與方式完全由人決定。
- **不做檔案鎖定、不阻擋編輯，也不改變 `PreToolUse`／`Stop` 門禁行為**：不干涉日常改檔與收工流程。
- **不額外執行 `git worktree list` 掃描未知工作區**：延續 `collect.mjs` 原則，只比對有感測器紀錄或有還原點的工作區。
- **不做語意層衝突推論**：不同檔案之間無法由檔名交集得知，零重疊時亦不宣稱「沒有衝突／安全」（R2）。

## 施作紀錄

- 2026-11-24（A 規格＋規格預審）：寫完規格並記 `--report A ok`；派 1 位獨立唯讀 `research` subagent 跑一輪 `spec-precheck` 找到 7 條（記 `--precheck found`）。依 Oscar 拍板將 6 點決策與預審 7 條補強全數併入規格後搬入 `docs/進行中/` 開工。
- 2026-11-24（B 寫程式＋對過 AC-1～AC-4）：
  - 新增純函式單一真相來源 `lib/conflicts.mjs`（`detectConflicts`、`conflictsForWorktree`），以 `zhEn` 動態並排提供所有文案、零額外 git 呼叫；先依 `real(root ?? path)` 去重再篩選參與者，排除 `gone`／`notGit`／已結案無未存／P12 `main` 併入檔／`movedOn`，已結案仍有未存或無對話紀錄者僅看 `dirtyFiles`，活躍工作區涵蓋 `health.list`（`unquotePath`）、`dirtyFiles`（不重複去引號）、`scope.blind` 與 `checkpoint + unmerged > 0`。
  - 接入 `lib/collect.mjs`（`normalizeProjectEventsCwd` 僅強制歸一子目錄 `e.cwd` 以保留 root 捷徑既有卡相容性、`buildCard` 補 `root` 與 `dirtyFiles`、`collectAllNow` 掛 `conflicts` 與 `conflictSupport: true`、匯出 `projectConflictsFor`）、`lib/cliFacts.mjs`（`gatherChange` 保留 `dirtyFiles`）、`lib/cliView.mjs`（`renderConflicts`）、`status.mjs`（預設檢視與 `!ctx.hasCommits` 早退皆包 `withGitMemo` 並輸出衝突）、`lib/todo.mjs`（`sec.conflicts` 共用、影響 `quiet`、不關 `callLine`）、`ui/app.js`（`oldServerBanner` 納 `conflictSupport`、`whiteboard` 畫 `sec.conflicts` 並納筆槽 `used` 與 `bossMood`、`sessionPage` 於活躍對話畫衝突）。
  - 更新 `scripts/ui.test.mjs` 並新增 `scripts/conflicts.test.mjs`（60 項檢查皆為 ✓）；`npm test` 32/32 支測試檔檢查全綠，不碰真實 `~/.pipeline-monitor-agy/` 與原版 `~/.pipeline-monitor/`。（`npm run test:clean`、危險清單 `--tier-checked`、升版與搬入 `docs/升級摘要/` 待 C／D 與 Oscar 確認後進行。）
- 2026-11-24（C 打掃＋D 第 1 輪＋危險清單判斷＋D 修補）：
  - C 打掃：`--report C ok`（已改 0 項、建議 2 條）。
  - D 第 1 輪：T1 依規自行檢視、未派 agent，記 `--report D found`（找到 3 條：`[R1/P5]` 蓋章後 `ladder.unmerged === null` 靜默放行、`[P2/P13]` 子目錄對話跑 `status.mjs` 與儀表板不一致、`[P13/P6]` symlink 根＋子目錄拆成兩張卡）。
  - 危險清單判斷：Oscar 拍板 `lib/conflicts.mjs` 不加入 `tiers.danger` 並先以 `--tier-checked` 記下，清單維持 12 條。
  - 修補 D 第 1 輪 3 條發現並補齊回歸測試：`lib/conflicts.mjs` 補 `checkpoint-unmerged-unknown`（`!ladder?.onMain`）、`lib/collect.mjs` 改以兩階段 `buildPathCanonicalizer` 統一工作區拼法並匯出 `normalizeEventsCwd`、`status.mjs` 預設檢視改傳 `normEv`；`scripts/conflicts.test.mjs`（69 項）與 `npm test`（32/32 支測試檔）皆檢查全綠。
  - Oscar 原拍板先記 `--decide D skip` 並進入收尾，完成 `package.json` 與 `plugin.json` 升版並搬入 `docs/升級摘要/`、更新 `AGENTS.md` 索引；因編輯危險清單檔案 `plugin.json` 觸發分級升為 **T2** 且在先前回覆之後，停下來向 Oscar 確認後依規補跑 **D 第 2 輪**（不派 agent，只看第 1 輪後改的 5 個檔：`lib/collect.mjs`、`lib/conflicts.mjs`、`plugin.json`、`scripts/conflicts.test.mjs`、`status.mjs`，沒對到已知死法），並記 `--report D ok`。
  - 上線版本：v0.9.0
