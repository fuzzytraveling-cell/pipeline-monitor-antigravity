# 功能：改到一半碰到危險檔，分級當場往上升並立刻告訴 AI

分級：預測至少 **T2**（因為會動到危險清單上的 `hooks.json`、`lib/mount.mjs`、結案升版的 `plugin.json`；另外會動到程式區的 `lib/tier.mjs`、`gate.mjs`、`lib/faults.mjs`、`lib/collect.mjs`、`lib/rounds.mjs`、`lib/transcript.mjs`、`lib/cliFacts.mjs`、`lib/cliView.mjs`、`ui/app.js`、`rules/AGENTS.md`，並新增程式檔 `escalate.sh`、`escalate.mjs` 與測試檔 `scripts/escalate.test.mjs`——新增的 `escalate.sh`、`escalate.mjs` 落在危險清單定好之後，施工時須由你判斷要不要加入危險清單）。T2 要求 A、C、D 與補測試。

> 2026-11-23 規劃（依 `docs/升級摘要/danger-guard-force-ask.md`「已拍板」第 3 條開立獨立規格；v0.2 第一段 v0.2.0 已在 `main` 結案並蓋章；同日依規格預審 6 條修正與 Oscar 拍板更新後搬入 `docs/進行中/` 開工）。
> 讀了：`AGENTS.md`、`README.md`、`docs/ROADMAP.md`、`docs/FAILURE-PATTERNS.md`、`docs/升級摘要/danger-guard-force-ask.md`、`docs/升級摘要/spec-chaos-precheck.md`、`docs/升級摘要/antigravity-v01-foundation.md`、`.agents/pipeline-stages.json`、`stages.json`、`hooks.json`、`hook.sh`、`remind.sh`、`gate.sh`、`gate.mjs`、`guard.sh`、`guard.mjs`、`lib/{tier,faults,mount,collect,rounds,cliFacts,cliView,transcript}.mjs`、`ui/app.js`、`rules/AGENTS.md`、`package.json`、`plugin.json`、`scripts/docsIndex.test.mjs`、`agy-customizations/docs/hooks.md`。找不到 `docs/SPEC-TEMPLATE.md`（沿用既定最小格式）；`docs/LESSONS.md` 存在，本次只搜關鍵字、未整份通讀。
> 開工前階段 0 本機實測事實（2026-11-23 實機驗證）：
> 1. `PreInvocation` 會在同一回合的**每一次**模型呼叫前觸發（`inv=0, 1, 2...`），`PostInvocation` 緊接在工具執行完、下一次 `PreInvocation` 之前；stdin 含 `conversationId`、`cwd`、`workspacePaths`、`transcriptPath`、`invocationNum`、`initialNumSteps`、`lastUserInput`、`hookEventName`、`modelName`、`artifactDirectoryPath`。
> 2. `{"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}` 可在同一回合內立刻注入模型上下文（外框標記 `PreInvocation hook`），並以 `source:"SYSTEM_SDK"`、`type:"SYSTEM_MESSAGE"` 寫入 `transcript.jsonl`（不與人類發言混淆，P7）。
> 3. 帶 `metadata.user_markdown` 的 `systemMessage` 實測被靜默丟棄（模型上下文與 `transcript.jsonl` 均未出現），正式實作**不得依賴** `metadata.user_markdown`。
> 4. 不注入時 `{}`、0 bytes＋`exit 0`、`{"injectSteps":[]}` 皆安靜放行；壞 JSON 與 `exit 1` 均由 Antigravity 寬容放行（不中斷回合）。
> 5. 子 agent 亦會觸發 `PreInvocation`，且其 `inv=0` 時 `transcriptPath` 尚未落地（`ENOENT`）、`lastUserInput` 為空字串 `""`，直到 `PostInvocation`/`inv=1` 才寫出 step 0（`SYSTEM_MESSAGE` 含 `sender=`）；專案級 `.agents/hooks.json` 於下一回合生效。

## 這是為了解決什麼

現在施工到一半才碰到危險清單上的檔案（或你中途手動調高分級）時，雖然 `force_ask` 會在改檔前問你確認，但 AI 端看不到確認視窗的提示文字，往往要一路寫完、準備收工時才被收工門禁攔下來補規格、打掃或補測試而整段返工；這個功能讓分級升到最高級（預設 T2）的當下，在 AI 同回合的**下一步動手前**立刻把新等級與還缺的關卡通知給 AI，不必拖到收工才發現。

## 驗收條件

**AC-1　改到一半升到最高級（預設 T2），AI 在同一個回合的下一步就收到系統通知** ✅ 對過 2026-11-23
> **白話**：以前像蓋房子蓋到一半挖到承重牆，工人自己不知道規矩已經升級，一路蓋完要收工才被大門警衛攔下來叫他補設計圖；現在只要真的改到危險清單上的檔案（或你手動調高到最高級），工頭立刻在工人下一步動手前遞上紙條，寫清升到哪一級、因此多了哪幾關還沒跑。
> **會發生的情況**：在已設定分級的 git 專案裡，這一輪因實際改動危險清單上的檔案（無論經由改檔工具獲你允許後、用終端機指令修改、新建危險資料夾裡的檔、或改名搬動危險檔）或因你用 `--tier`／儀表板手動調高，使最終分級達到專案最高級（依設定檔 `tiers.levels.danger.id`，不寫死 T2）時，AI 在同回合的下一次模型呼叫前立刻收到一則系統通知，用目前語言（中／英）講清三件事：目前升到哪一級、原因（命中哪幾個危險檔，或你調高的理由）、以及這一級要求但目前還沒補齊或問不到的項目（含過期須重問的 D、還沒記結論的關，以及若尚無規格也沒有 `--spec` 連結時特別引導 AI 先停下來向你確認要不要補規格或補連；已有確實紀錄或已連結的關卡不重複要求）。
> **技術**：根目錄 `hooks.json` 新增獨立 named hook `agy-pipeline-escalate`，掛在 `PreInvocation`（扁平陣列，`sh ./escalate.sh` → `escalate.mjs`，`timeout: 10`）。注入格式依階段 0 實測契約**只輸出** `{"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}`（絕不帶 `metadata.user_markdown`）。先將 `payload.cwd` 解析成真實 git 根目錄 `ctx.root`（`git rev-parse --show-toplevel`＋`real()`，P2/P13），並比照 `gate.mjs` 傳入 `extraTranscripts` 與 `sessionId` 呼叫 `lib/collect.mjs` 的 `cardFor`＋`sessionTier`（排除從 `main` 併入未經本對話改動的檔，P12）；缺項由 `lib/tier.mjs` 抽出與 `gate.mjs` 共用的單一真相來源 `pendingRequirements()` 計算（涵蓋 `missing`、`no-report`、`ask`、`accepted-stale`、`found` 與 `unknown`，不把 `unknown` 折成已具備，P2/R1/R2）。文案以 `zhEn` 並排，依 `readLang()` 輸出。

**AC-2　同輪只通知一次不洗版，沒升級、你按拒絕或子 agent 活動絕不亂打擾** ✅ 對過 2026-11-23
> **白話**：紙條只遞一次，不會每敲一根釘子就塞同一張洗版；如果你剛才在確認窗按了拒絕（檔案根本沒改）、專案沒設分級或退出記錄、只動到一般檔、或是 AI 派出去查資料的小助手在做事，都不會亂塞紙條。
> **會發生的情況**：
> 1. 同一輪針對同一級只注入一次；後續同輪再改更多危險檔不再重複注入；若因通知而剛開始寫規格（`/spec`）也不會在寫規格中途重複通知。換新的一輪（例如原本已有 A 又開新一輪 A，或蓋新還原點），或你手動收回調高（`--tier-retract`）後又再次升上最高級時，才會重新通知。
> 2. 你在 `force_ask` 按拒絕（檔案未改動）、專案未設分級（`unset`）／不分級（`off`）／設定讀不懂（`broken`）／退出記錄、非 git 資料夾、僅達一般程式級（預設 T1）、或 `pendingRequirements()` 全部要求皆已確實具備（不含 `unknown`）時，一律安靜放行不注入。
> 3. 子 agent（`research`／`browser` 等）觸發 `PreInvocation` 時一律安靜放行（包含第 0 步轉錄檔尚未建立的瞬間），絕不把升級通知塞給子 agent（亦不因缺欄位或權限錯誤吞人類通知）。
> 4. 注入的系統訊息絕不會被讀取端誤認成「使用者說的話」（P7）。
> **技術**：注入前先將 `{"ts":...,"event":"tier_notified","session":...,"cwd":ctx.root,"level":...,"trigger":"danger"|"manual"|"both","files":[...],"hadSpec":...,"cpAt":...,"originFrom":...,"source":"escalate"}` 寫入專案 `.jsonl`（不帶 `hook` 欄位，單行 `< 4096 bytes`）；同輪去重錨定對話級 `mineNow.view?.origin?.at` 與同工作區（`e.cwd === ctx.root`）最後一筆 `tier_retracted`，一律以 `Date.parse` 毫秒比較；`origin.at === null` 或首次 fallback 補出起點時依同 `(session, cwd, level)` 保底去重；且前一次通知 `hadSpec === false` 後緊接著同 `cpAt` 本對話首次叫出 `A` 時不二度洗版（避免補規前再改第 2 檔或逾 12 檔截斷誤重發，P2/P6）。**先寫入成功才輸出 `injectSteps`**，寫檔失敗改記 `escalate_broken` 並回 `{}`（防每步洗版）。子 agent 過濾獨立檢查：若 `transcriptPath` 存在且 step 0 含 `SYSTEM_MESSAGE`＋`sender=`、**或** `typeof transcriptPath === 'string' && transcriptPath.trim()` 對該路徑 `statSync` **明確捕捉 `err.code === 'ENOENT'`** 且 `lastUserInput === ""`，即直接輸出 `{}`＋`exit 0`（缺欄位或非 `ENOENT` 不視為子 agent，P6/P7/R1）。`lib/collect.mjs`、`lib/rounds.mjs`、`lib/transcript.mjs`、`lib/cliFacts.mjs` 顯式略過 `tier_notified`（P2/P5/P11）。

**AC-3　分級通知活著沒、壞了沒都看得到，出錯絕不卡住對話** ✅ 對過 2026-11-23
> **白話**：遞紙條的工頭有沒有上班，終端機跟網頁看板都看得到心跳；萬一它自己出錯或找不到 node，絕不會卡死你的對話，但上方故障橫條會誠實亮燈承認「這段期間分級往上升可能沒即時通知 AI」並給修法。
> **會發生的情況**：
> 1. `escalate.sh` 找不到 `node`、`escalate.mjs` 收到壞輸入或執行出錯 → 一律輸出 `{}` 並 `exit 0` 交回正常流程，同時記下故障記號，終端機與儀表板上方橫條照實亮燈說明並附修法（錯誤原文不上畫面，P3）。
> 2. 每次 `escalate.mjs` 執行都先留下心跳，終端機與儀表板感測器列同步顯示「分級通知：還沒跑過／最後一次跑 N 分鐘前」，掛載檢查亦同步驗證 `escalate.sh` 與 `escalate.mjs` 沒有缺檔斷鏈（L13、P3）。
> 3. 常駐儀表板還沒 `--serve-restart` 跑著舊程式時，上方黃條照實提醒（P2）。
> **技術**：`escalate.sh` 比照 **`guard.sh`**（先 `umask 077 && mkdir -p "$LOGS"`）搜尋 `node`（含 Homebrew、`/usr/local/bin`、nvm），找不到寫 `escalate_broken` 至 `logs/_sensor.jsonl` 後輸出 `{}`＋`exit 0`。`escalate.mjs` 先寫心跳 `logs/_escalate.json`（`{ ts, cwd }`），主邏輯包 `try/catch` 出錯記 `escalate_broken`（含 `cwd`）。`lib/faults.mjs` 新增 `ESCALATE_FILE`、`escalateHeartbeat()`、`escalateLine()`、`escalateNode`/`escalateError` 並接入 `faultState()`、`faultBanner()`、`faultNotes()`、`sensorParts()`（終端機與網頁同一句，P2）；`lib/cliView.mjs`、`lib/collect.mjs`（補 `escalateSupport: true`、更新 `anyRecovered` 含 `escalateNode`/`escalateError` 及 `notGit` 卡片 `sensorParts` 傳 `escalate`，P2/P3）、`ui/app.js`（更新 `oldServerBanner()` 與感測器列）同步呈現；`lib/mount.mjs` `pluginMissingFiles()` 檢核 `escalate.sh`＋`escalate.mjs`。

**AC-4　常駐規則、掛載、中英雙語與全套測試一致對齊，不碰原版資料** ✅ 對過 2026-11-23
> **白話**：不管是全機裝一次（`--install`）還是單獨掛某個專案（`--on`）都會自動帶上分級通知；常駐總則教 AI 收到升級通知時該怎麼應對；切英文時每句提示、心跳列與故障橫條全數同步無中文殘留，全套測試與乾淨副本檢查全綠。
> **會發生的情況**：`agy-pipeline --on`／`--off` 自動合併／拆除 `agy-pipeline-escalate` 且不動別人的 hook；`rules/AGENTS.md`（嚴控低於 24,000 bytes 上限）新增 `PreInvocation` 分級升級通知守則；`AGENTS.md`「刻意的決定」更新為五支 hook 契約分明、`README.md` 同步更新；切換 `--lang en`／`zh` 後通知文字、心跳列、故障橫條全數同步且英文零中文殘留、不踩紅線禁用字；`npm test` 與 `npm run test:clean` 全綠且不碰真實資料與原版 `~/.pipeline-monitor/`。
> **技術**：`lib/mount.mjs` 直接讀根目錄 `hooks.json`（P2）；新增 `scripts/escalate.test.mjs`（覆蓋改檔工具／`run_command`／新檔／`git mv`／手動 `--tier` 觸發、`force_ask` 被拒不誤觸、從 `main` 併入不誤觸、`pendingRequirements` 與 `gate.mjs` 一致性（含 T1→T2 過期 D 與 `unknown`）、同輪去重／補跑 `/spec` 不二度洗版／換輪重設／`--tier-retract` 同 `cwd` 重觸與跨 worktree 不誤重設、子目錄與 symlink `ctx.root` 對齊、`inv=0` 帶 `extraTranscripts` 換手不混入、子 agent 真 `ENOENT` vs 缺欄位/`EACCES` 過濾、`tier_notified` 寫失敗不注入防迴圈且不汙染 `sessionsOf`/`worktrees`/`isSensorBacked`、注入之 `SYSTEM_SDK` 不被 `lib/transcript.mjs` 誤認成人話、缺 `node` 先建 `$LOGS`／壞 JSON 心跳與 `collect.mjs` `anyRecovered` ＋ `notGit`、中英雙語，標記 P1/P2/P3/P5/P6/P7/P8/P11/P12/P13），同步更新 `scripts/{mount,shellSyntax,faults,ui,lang}.test.mjs`。

## 混沌推導

▸ **時間**：`PreInvocation` 會在每次模型呼叫前同步執行 → 非 git、退出記錄、未設分級（`unset`/`off`/`broken`）與子 agent 一律於呼叫 `cardFor` 之前早退輸出 `{}`；`timeout` 設為 `10` 秒，逾時時 Antigravity 實測寬容放行不卡死對話。
▸ **併發**：同工作區有兩個對話或主對話與子 agent 同時執行 → `tier_notified` 帶 `session` 歸屬、單行 `< 4096 bytes` 保障 `O_APPEND` 原子性；子 agent 在 `inv=0`（轉錄檔尚未寫出）與 `inv>=1` 皆被過濾不搶記、不汙染主對話去重狀態。
▸ **權限憑證**：寫入 `tier_notified` 遇沙盒 `EPERM` 或磁碟滿 → 記錄 `escalate_broken` 並**略過本次注入**（回傳 `{}`），避免記不了去重紀錄導致後續每步無限洗版；`_escalate.json` 心跳寫入容錯不影響正常判斷。
▸ **輸入畸形**：壞 JSON、缺 `cwd`／`conversationId`、專案設定檔格式壞掉、缺 `node`、非 git 目錄 → 一律安全輸出 `{}`＋`exit 0`（缺 `node`／壞 JSON／執行錯誤記 `escalate_broken`）；設定檔讀不懂已由 `guard.mjs` `force_ask` 與看板明講，此處不額外編造分級（R1）。
▸ **容量**：危險檔數量多時注入文字只列前 3 個＋「等 N 個」（沿用 `fewFiles` 口徑），`tier_notified` 的 `files` 與路徑皆做長度截短維持單行 `< 4096 bytes`。

## 已拍板（2026-11-23，Oscar 確認開工）

1. **規格預審 6 條全收進規格**：含 `pendingRequirements` 與 `gate.mjs` 共用、傳 `extraTranscripts`/`sessionId` 與錨定對話級 `view.origin.at`、依通知補寫 `/spec` 不當場二度洗版、解析 `ctx.root` 對齊 `--tier`/`--tier-retract`、補齊 `collect.mjs` `anyRecovered`／`notGit` 與 `escalate.sh` 先建 `$LOGS`、以及區分真 `ENOENT` 與缺欄位／`EACCES`。
2. **觸發門檻**：只在升到最高級（預設 T2，碰到危險檔或手動調高到最高級）時通知，不對 `T0 → T1` 自動注入。
3. **升上 T2 且尚無規格／未連 `--spec` 時**：注入通知明確引導 AI 先停下來告訴使用者、確認是否補寫規格或補連 `--spec`。

## 明確不做

- **不對 `T0 → T1`（一般程式區）自動注入通知**：一般寫程式幾乎第一筆編輯就會進 T1，每次都塞系統訊息只會製造噪音與破壞快取；本次聚焦升到最高級（預設 T2，碰到危險檔或手動調高到最高級）。若實戰後覺得連 T1 也要即時提醒，再另調或另開規格。
- **不依賴 `metadata.user_markdown` 做畫面內嵌橫幅**：階段 0 實機驗證此欄位會使整個 `systemMessage` 注入被靜默丟棄，只用實測有效的純 `systemMessage`。
- **不用 `PreInvocation` 的 `terminationBehavior: "terminate"` 硬停對話，也不取代 `force_ask` 或 `Stop` 收工門禁**：分級升級通知是**提早告訴 AI** 的主動提醒；動檔前把關仍由 `PreToolUse` `force_ask` 負責，收工兜底仍由 `Stop` `gate.mjs` 負責。
- **不把新發現的「清單定好後才新加的程式檔（`stale.fresh`）」在 `PreInvocation` 擅自升成 T2**：守住「工具不猜危險清單」（AGENTS.md 刻意的決定），未判斷新檔仍由收工門禁與看板交給你判斷。
- **不混入其他獨立項目**（`ask_question` 一鍵決策卡、C/D 並行異質模型調度、Sidecar／`agentapi`），維持每份規格一頁。

## 施作紀錄

- 2026-11-23（A 規格＋規格預審）：先完成階段 0 本機實測 `PreInvocation` 注入契約並實機驗證 v0.2.0 `force_ask`；初稿完成後由獨立 `research` subagent 跑一輪 `spec-precheck`（記 `--precheck found`）；依 Oscar 拍板將 6 條預審補強與 3 項決策併入規格後搬入 `docs/進行中/` 開工。
- 2026-11-23（B 寫程式＋對過 AC-1～AC-4）：
  - `lib/tier.mjs` 抽出並匯出 `pendingRequirements()` 單一真相來源，`gate.mjs` 改為共用；新增 `escalate.sh` 與 `escalate.mjs` 並掛入 `hooks.json` 的 `PreInvocation`（`agy-pipeline-escalate`），依實測契約只輸出純 `injectSteps.systemMessage.systemMessage`。（註：`buildTier` 於命中危險檔時會略過手動調高，故 `tier_notified.trigger` 實作為 `'danger' | 'manual'`，同時命中時記 `'danger'`。）
  - 補齊 `lib/faults.mjs`、`lib/mount.mjs`、`lib/collect.mjs`、`lib/rounds.mjs`、`lib/transcript.mjs`、`lib/cliFacts.mjs`、`lib/cliView.mjs`、`ui/app.js`、`rules/AGENTS.md`、`AGENTS.md`、`README.md`。
  - 新增 `scripts/escalate.test.mjs`（61 項檢查皆為 ✓）並同步更新 `scripts/{mount,shellSyntax,faults,ui,lang}.test.mjs`；`npm test` 29/29 支測試檔檢查全綠（含不碰真實 `~/.pipeline-monitor-agy/` 與原版 `~/.pipeline-monitor/`）。
- 2026-11-23（C 打掃＋D 魔鬼教官第 1 輪與修補）：
  - C 打掃記 `--report C ok`（已改 0 項、建議 4 條、放過 3 項）；D 魔鬼教官第 1 輪派 2 位獨立唯讀 subagent 查核後記 `--report D found "派了 2 個 agent；找到 5 條"`。
  - 依 Oscar 同意（「都照建議」）修完 5 條並補齊測試：`escalate.mjs` 修共用工作區 `aRuns` 加 `e.session === sid` 過濾與補寫 `/spec` 中途去重（`#1`/`#3`）；`lib/collect.mjs` 新增 `normalizeEventsCwd()` 對齊 `hook.sh` 原始子目錄／symlink `cwd` 與真實 git 根目錄（`#2`）；`lib/faults.mjs` 新增 `sameWorkspace()` 對齊 `faultNotes()` 終端機與網頁對話頁的子目錄／symlink 比對（`#5`）；`scripts/faults.test.mjs` 補實測 `notGit` 卡片與 `escalateError` `anyRecovered` 整合（`#4`）；並將 `escalate.sh`、`escalate.mjs` 納入 `.agents/pipeline-stages.json` 之 `tiers.code` 與 `tiers.danger` 並記 `--tier-checked`。
- 2026-11-23（D 魔鬼教官第 2 輪與結案準備）：第 2 輪只看第 1 輪後改動的 5 個檔（`escalate.mjs`、`lib/collect.mjs`、`lib/faults.mjs`、`scripts/escalate.test.mjs`、`scripts/faults.test.mjs`），沒對到已知死法（記 `--report D ok`）；搬入 `docs/升級摘要/` 並升版至 `v0.4.0`。

上線版本：v0.4.0
