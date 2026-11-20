# 功能：危險清單即時 `force_ask` 把關（v0.2 第一段）

分級：預測至少 **T2**（因為會動到危險清單上的 `hooks.json`、`lib/mount.mjs`、結案升版的 `plugin.json`；另外會動到程式區的 `lib/tier.mjs`、`lib/faults.mjs`、`lib/collect.mjs`、`lib/cliView.mjs`、`ui/app.js`、`rules/AGENTS.md`，並新增程式檔 `guard.sh`、`guard.mjs` 與測試檔 `scripts/guard.test.mjs`——新增的 `guard.sh`、`guard.mjs` 落在危險清單定好之後，施工時須由你判斷要不要加入危險清單）。T2 要求 A、C、D 與補測試。

> 2026-11-20 規劃（依 Oscar 於本對話對 v0.2 範圍與各項定義的確認，先收「危險清單即時 `force_ask`」單一主軸，維持一頁可審）。
> 讀了：`AGENTS.md`、`README.md`、`docs/FAILURE-PATTERNS.md`、`docs/LESSONS.md`（搜關鍵字與前半）、`docs/升級摘要/antigravity-v01-foundation.md`、`docs/升級摘要/分級.md`、`.agents/pipeline-stages.json`、`hooks.json`、`hook.sh`、`remind.sh`、`gate.sh`、`gate.mjs`、`stages.json`、`status.mjs`、`lib/{tier,rounds,mount,faults,collect,cliView}.mjs`、`ui/app.js`、`rules/AGENTS.md`、`scripts/{docsIndex,shellSyntax,privacy,run-tests}.test.mjs`，以及 Antigravity 官方 hook 契約 `agy-customizations/docs/hooks.md`。找不到 `docs/SPEC-TEMPLATE.md`（沿用既定最小格式）。

## 這是為了解決什麼

現在的危險清單要等到「AI 已經改完、準備收工」時才由收工門禁與看板提醒，如果平常開啟了改檔自動放行，AI 會在你沒點頭前就直接改掉改錯會靜默出事的關鍵檔；這個功能讓 AI 在動手改危險清單上的檔案**之前**，Antigravity 一律跳出來向你確認，並當場說明這次改動會升到哪一級、需要補哪幾關。

## 驗收條件

**AC-1　AI 要改危險清單上的檔案前，Antigravity 一定跳出來問你確認** ✅ 對過 2026-11-20
> **白話**：以前像工地收工前才點名「你剛才動到承重牆了」；現在改成 AI 拿起電鑽要動承重牆的那一秒，門口警鈴就響、等你親口點頭才准動手，就算平常開了「自動放行」也不會偷跑過去。
> **會發生的情況**：在有設定分級與危險清單的 git 專案裡，AI 呼叫任何寫／改檔工具要改危險清單上的檔案（或危險資料夾裡的新檔／舊檔）時，Antigravity 一定跳出確認視窗（不受「總是允許」快取影響），並用目前的語言（中／英）講清楚三件事：即將改動哪個危險檔、動了它這次改動會升到哪一級（照專案設定的等級名稱，不寫死 T2）、這一級收工前要求哪幾關。你點拒絕，檔案就不會被改動。
> **技術**：根目錄 `hooks.json` 新增獨立 named hook `agy-pipeline-guard`，掛在 `PreToolUse`（matcher `write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content`），呼叫 `sh ./guard.sh` → `guard.mjs`。`guard.mjs` 直接共用 `lib/tier.mjs` 的 `readTierConfig`＋`computeTier`、`lib/rounds.mjs` 的 `loadStages`、`lib/lang.mjs` 的 `readLang`/`withLang`/`zhEn`（單一真相來源，P2），命中 `tiers.danger` 時回傳 `{"decision":"force_ask","reason":"..."}`。`hook.sh`（`PostToolUse` 感測器）維持零變動、永遠 `{}`＋`exit 0`。**開工前先做本機實機確認（比照 v0.1 階段 0）**：實測 Antigravity `PreToolUse` 的 `force_ask` 畫面與 `reason` 呈現。

**AC-2　改一般檔案、沒設分級或退出記錄的專案，照 Antigravity 原本的規矩走、不亂彈也不偷放行** ✅ 對過 2026-11-20
> **白話**：警鈴只對承重牆響，換燈泡不會每次都把你叫來簽字；而且把關的人說「這不是承重牆」只代表「我沒意見、照原本門禁走」，絕不會順手幫陌生人把工作區以外的系統檔大門一起打開。
> **會發生的情況**：AI 改一般程式檔、文件檔、工作區外的檔案（例如暫存檔或家目錄檔案），或目標屬於非 git 資料夾、已退出記錄（`.agents/` 或 `.claude/pipeline-monitor.off`）、還沒設分級（`unset`）、明講不分級（`tiers.off`）、或危險清單為空時，把關 hook 不跳出額外確認，也絕不覆蓋或削弱 Antigravity 原本的權限保護。
> **技術**：非命中與錯誤情況一律輸出**零位元組（0 bytes 空輸出）＋`exit 0`** 交回 Antigravity 預設權限政策（階段 0 實機確認：`{}` 與 `{"decision":""}` 會直接拒絕工具呼叫；`"allow"` 會連工作區外路徑也自動放行、削弱系統保護；非零離開碼／非 JSON／逾時皆直接阻擋；**嚴禁**對非危險檔或工作區外檔案回傳 `"allow"`，也不得印 `{}`）。退出記號共用 `lib/mount.mjs` 的 `optOutState()`（P2）。

**AC-3　跨工作區、捷徑與新建檔案都認得對，不會拿錯專案名單也不會漏抓** ✅ 對過 2026-11-20
> **白話**：不管 AI 是站在分身工地（worktree）裡改主資料夾的檔案、在危險資料夾底下新建檔案、還是透過捷徑繞路指過去，都照「那個檔案自己所屬專案」的危險清單查，不會張冠李戴，也不會因為檔案還沒建出來就查不到。
> **會發生的情況**：在 worktree 對話裡改主資料夾的危險檔、在危險資料夾裡新建一個尚不存在的檔、用相對路徑或經過系統捷徑（如 macOS `/var` → `/private/var`）指向危險檔，都會準確觸發確認；在專案 A 的對話裡改專案 B 的檔案，查的是專案 B 自己的設定檔（worktree 沒設定檔時照既有順序往主資料夾與 `.claude/` 找）。
> **技術**：從工具參數（`Path` / `TargetFile` / `AbsolutePath`）展開目標檔絕對路徑（相對路徑以 `cwd` 或 `workspacePaths[0]` 展開），對目標檔（尚不存在時往最近已存在的上層資料夾）做 `realpathSync` 後再問 `git rev-parse --show-toplevel` 與 `--git-common-dir`（區分相對與絕對路徑，P13）；以 `realpathSync(root)` 算出專案內相對路徑交由 `computeTier([rel], config)` 判定，並沿用 `readProjectConfig` 的停止規則（`.agents/` 優先、相容 `.claude/`、工作區優先於主資料夾，P2）。

**AC-4　設定檔讀不懂時誠實提醒，把關自己壞了絕不鎖死你、而且畫面看得到** ✅ 對過 2026-11-20
> **白話**：萬一專案的分級名單寫壞讀不懂，警鈴不能假裝「名單裡沒這面牆」默默放行；反過來，如果警鈴自己斷電壞了，不能把門鎖死讓你改不了任何檔，但儀表板跟終端機一定要亮燈承認「把關剛壞了」，免得你以為有保護其實沒有。
> **會發生的情況**：
> 1. 專案設定檔（`.agents/` 或 `.claude/pipeline-stages.json`）存在但格式壞掉讀不懂（`state === 'broken'`）→ AI 要改該專案內任何檔案時一律跳出確認，白話說明「設定檔讀不懂、無法確認是否在危險清單上」，由你決定放行或先修設定檔（不把「讀不懂」折成「安全」，R1）。
> 2. `guard.sh` 找不到 `node`、`guard.mjs` 執行出錯或收到壞輸入 → 一律交回原本權限並 `exit 0`（絕不 `deny` 鎖死編輯），同時記下故障記號，讓終端機與儀表板上方故障橫條照實亮燈說明「那段期間改危險檔可能沒跳出來問你」並給修法（P3）。
> 3. 每次 `guard.mjs` 真的跑起來都留下心跳，終端機與儀表板感測器列同步顯示「改檔把關：還沒跑過／最後一次跑 N 分鐘前」，掛載檢查也一併驗證把關腳本有沒有缺檔斷鏈（L13、P3）。
> **技術**：`guard.sh` 比照 `gate.sh` 搜尋 `node`（含 `/opt/homebrew/bin/node`、`/usr/local/bin/node`、nvm），找不到寫 `guard_broken` 至 `logs/_sensor.jsonl`；`guard.mjs` 先寫心跳 `logs/_guard.json`（`{ ts, cwd }`），主邏輯包 `try/catch` 出錯記 `guard_broken`（含 `cwd`，錯誤原文不上畫面）。`lib/faults.mjs` 新增 `GUARD_FILE`、`guardHeartbeat()`、`guardLine()` 與 `guardNode`/`guardError` 狀態並接入 `faultState()`、`faultBanner()`、`faultNotes()`（終端機與網頁同一句，P2）；`ui/app.js` 補顯示標籤並更新 `oldServerBanner()`（P2）；`lib/mount.mjs` `mountState()` 依 `hooks.json` 檢查所有必要腳本。

**AC-5　留存「跳出確認」的紀錄但絕不猜你按了什麼，並講明終端機寫檔的盲區** ✅ 對過 2026-11-20
> **白話**：警鈴響過會在工地日誌記一行「幾點幾分對哪個危險檔響過警鈴」，但日誌不替你猜你有沒有放行（有沒有真的改到看改檔後的紀錄）；同時誠實講明，這道門禁守的是寫／改檔工具，用終端機指令繞道改檔它看不到，最後仍由收工門禁依 git 事實查核。
> **會發生的情況**：每次觸發 `force_ask` 時，專案紀錄檔留下一筆 `guard_asked` 事件（單行 `< 4096 bytes`，不記檔案內容），不把這筆算成「已修改檔案」、不算成「你已同意」、也不算成「感測器正常」（R2）；常駐規則 `rules/AGENTS.md` 明確寫入改檔把關守則：被使用者拒絕改危險檔時停手討論，絕不改用終端機指令繞道硬改（P6、L8）。
> **技術**：`guard.mjs` 回傳 `force_ask` 前附加寫入 `{"ts":...,"event":"guard_asked","session":...,"cwd":...,"file":...,"level":...,"source":"guard"}` 至專案 `.jsonl`（寫檔失敗記 `guard_broken` 但仍照常回傳 `force_ask`，不讓寫日誌失敗取消保護）；該事件不帶 `hook` 欄位，不影響 `hookTimesIn()` 與 `isEditEvent()`。更新 `rules/AGENTS.md`（嚴控低於 24,000 bytes 上限）。

**AC-6　安裝、專案級掛載、中英雙語與全套測試一致對齊，不碰原版資料** ✅ 對過 2026-11-20
> **白話**：不管是全機裝一次（`--install`）還是單獨掛某個專案（`--on`），都會自動帶上改檔把關；切英文時每一句提示、狀態列、故障橫條全數同步無中文殘留；全套自動化測試與乾淨副本都把正常、壞檔、跨目錄與防說謊情境實際跑過一遍，不碰真實資料與原版資料夾。
> **會發生的情況**：`agy-pipeline --on`／`--off` 自動合併／拆除 `agy-pipeline-guard` 且不動別人的 hook；切換 `--lang en`／`zh` 後，`force_ask` 理由、把關心跳列、故障橫條全數同步且英文零中文殘留；更新 `AGENTS.md`「刻意的決定」中原本 v0.1 不碰 `PreToolUse` 與三支 hook 的說明為四支 hook 契約分明；`npm test` 與 `npm run test:clean` 全綠且零外洩。
> **技術**：`lib/mount.mjs` 直接讀根目錄 `hooks.json`（P2）；新增 `scripts/guard.test.mjs`（覆蓋命中單檔／資料夾、非危險檔不回 `allow`、worktree／跨專案／新檔／符號連結、`unset`/`off`/`broken`、退出記號、缺 `node`／壞 JSON、`guard_asked` 與 `_guard.json` 心跳、中英切換，標記 P2/P3/P13），同步更新 `scripts/{mount,shellSyntax,faults,ui,lang}.test.mjs`。

## 已拍板（2026-11-20，Oscar 在寫規格的對話裡回的）

1. 設定檔讀不懂（`broken`）→ 照 AC-4 第 1 點：改該專案的檔一律 `force_ask` 講明讀不懂。原話：「守 R1，避免設定壞掉時靜默失去保護，而且讓你按一次允許就能修好它」。
2. `.agents/pipeline-stages.json`、`.agents/pipeline-monitor.off` 不內建成危險檔。原話：「由各專案決定要不要放進 tiers.danger」。
3. 「分級當場升級通知 AI」「A 寫完先由 D 預審」等這一份結案後各開一份規格。原話：「先等這一份做完再各開一份規格」。

## 開工前要先在本機實測的事（比照 v0.1 階段 0；任何一條跟假設不符就先停下來問 Oscar）

1. `PreToolUse` 回 `{}`：是不是交回原本的權限規矩（不自動放行、也不多問一次）。
2. `force_ask`：在開了「總是允許」的情況下是不是照樣跳出來；`reason` 是給人看、給 AI 看、還是兩邊都看得到。
3. 你按拒絕：AI 收到什麼；那次改檔的 `PostToolUse` 會不會觸發（預期不會——`guard_asked` 後面沒有改檔紀錄，畫面只能講「沒看到後續」，不講「你拒絕了」，R1）。
4. 子 agent 改危險檔時 `force_ask` 會不會跳到你面前；跳不出來的話是卡住、自動拒絕、還是放行——三種都要照實寫進施作紀錄，不准變成漏網之魚。
5. hook 逾時、回傳非零、印出看不懂的東西時，Antigravity 是放行還是擋下。

## 混沌推導

▸ **權限憑證**：`PreToolUse` 若對非危險檔（特別是工作區外檔案如 `~/.zshrc`）誤回 `"allow"`，會靜默削弱 Antigravity 原本的系統權限把關 → 嚴禁對非危險檔回 `"allow"`，開工前實測 `{}` 的預設交回行為；寫入 `_guard.json` 或 `guard_asked` 若遇沙盒 `EPERM`，不可取消 `force_ask` 保護或鎖死編輯。
▸ **時間**：每次寫／改檔前都會同步跑 `guard.mjs` → 只查目標檔所屬 repo 的 `rev-parse` 與設定檔，絕不跑 `git log`、`dangerSince` 或讀 `transcript.jsonl`，保持低延遲並設 `timeout: 10`。
▸ **併發**：主對話與可寫檔 subagent 同時修改多檔並同時寫 `_guard.json` 與 `guard_asked` → `guard_asked` 截短維持單行 `< 4096 bytes` 保障 `O_APPEND` 原子性；`_guard.json` 寫入容錯，不影響回傳結果。
▸ **輸入畸形**：壞 JSON、缺路徑、空 `cwd`、相對路徑含 `..`、尚不存在的新檔、符號連結、設定檔格式壞掉、缺 `node` → 壞 JSON／缺路徑／缺 `node` 一律安全交回原權限＋`exit 0`（缺 `node`／執行錯誤記 `guard_broken`）；設定檔讀不懂則對該專案檔案 `force_ask` 明講讀不懂（R1）。
▸ **容量**：絕不讀目標檔案內容、絕不讀 `transcript.jsonl`，只讀路徑與小型 JSON 設定檔；寫入紀錄的檔案路徑做長度上限截短。

## 明確不做

- **不做終端機指令（`run_command`）寫檔攔截**（如 `sed`、`mv`、`cat >`）：用正則猜 shell 指令會漏抓也會亂叫（P4、L8），改由 `rules/AGENTS.md` 明禁繞道並由收工門禁依 git 事實兜底。
- **不做硬擋（`deny`）與「核准過一次就自動放行」快取**：決定權永遠留給你（`force_ask`），不自創放行快取（先實際體驗每次確認的節奏，真嫌吵再另開規格）。
- **不把不在 `tiers.danger` 裡的檔案偷算成危險檔**（守住「工具不猜危險清單」；例如「改 `.agents/pipeline-stages.json` 或 `.agents/pipeline-monitor.off` 本身要不要也 `force_ask`」等你拍板才加）。
- **v0.2 其餘項目本次不收，保持每份規格一頁（後續各開獨立規格）**：
  - 不做 `PreInvocation` 動態分級升級上下文注入（先透過本次 `force_ask` 的提示文字當場告知升級後的等級與必跑關卡；你定義的「改到一半碰到危險檔，分級當場往上升並主動告訴 AI」如需獨立注入機制，後續另開規格）。
  - 不做 A/D 單輪預審（已記下你定義的方向：寫完規格 A 後由魔鬼教官 D 先對規格跑一輪老毛病，後續另開規格）。
  - 不做 `ask_question` 一鍵決策卡解析、不做 C/D 並行異質模型調度。
  - 不做 Sidecar／`agentapi` 雙向即時控制（尚未在本機實測其運作機制，不靠猜寫驗收條件）。

## 施作紀錄

- 2026-11-20（開工前階段 0 本機實測，推翻 `{}` 交回預設權限的原假設）：
  1. `PreToolUse` 輸出 `{}` 或 `{"decision":""}` 會被 Antigravity 當成拒絕工具（`tool call denied by pre-tool hook`）；改為 **0 bytes 空輸出＋`exit 0`** 才交回原本權限（工作區內寫檔約 2 秒直接寫入並觸發 `PostToolUse`，無彈窗；工作區外路徑依原本規矩處理）。
  2. 輸出 `{"decision":"allow"}` 會連工作區外 `/tmp` 也自動放行，因此非危險檔與專案外檔案絕不能回 `"allow"`。
  3. 輸出非 JSON、`exit 1`/`exit 2`、逾時被殺都會直接阻擋工具呼叫，因此正式把關失敗或內部錯誤必須自己吞掉並改走 **0 bytes＋`exit 0`** 並記 `guard_broken`，絕不能讓 hook 報錯鎖死編輯。
  4. `force_ask` 實機截圖確認：會顯示在路徑上方（`reason` 文字完整呈現給使用者），並把選項 2/3「永遠允許」反灰停用（只剩「這次允許」與「No」）；AI 端不見 `reason`（點允許收到 `Created file.`；點拒絕收到 `permission check failed ... user denied permission` 且檔案未建、`PostToolUse` 未觸發）。
  5. 子 agent 觸發 `force_ask` 時確認視窗正常彈給使用者，不會卡死也不會自行放行；且專案級 `.agents/hooks.json` 在同一個對話的下一個回合就會被載入生效。
- 2026-11-20（B 寫程式完成＋對過 AC-1～AC-6）：
  - 在 `lib/tier.mjs` 抽出 `dangerRuleFor()` 單一比對函式（`computeTier` 與把關共用）。
  - 新增 `guard.sh`（POSIX `/bin/sh` 殼，缺 `node` 記 `guard_broken` 後 0 bytes＋`exit 0`）與 `guard.mjs`（依目標檔所屬 repo 查 `.agents/`→`.claude/` 分級、支援跨 worktree／跨專案／符號連結／尚不存在的新檔；命中 `tiers.danger` 或設定讀不懂回 `force_ask` 並寫 `logs/_guard.json` 心跳與 `guard_asked` 事件；其餘與任何錯誤一律 0 bytes 空輸出＋`exit 0`）。
  - 更新 `hooks.json`（新增 `agy-pipeline-guard` 掛 `PreToolUse`）、`lib/mount.mjs`（動態檢核 `hooks.json` 所有必要腳本與 `.mjs`）、`lib/faults.mjs`（`GUARD_FILE`、`guardHeartbeat()`、`guardLine()`、`guardNode`/`guardError` 橫條與五關旁說明）、`lib/collect.mjs`（帶入 `guard` 心跳與 `guardSupport: true`）、`lib/cliView.mjs`（印出 `改檔把關：` 行）、`ui/app.js`（`oldServerBanner` 與感測器 chip）、`rules/AGENTS.md`、`AGENTS.md`、`README.md`。
  - 新增 `scripts/guard.test.mjs`（62 項全綠）並同步更新 `scripts/{mount,shellSyntax,faults,ui,lang}.test.mjs`；全套 `npm test` 27/27 支測試檔檢查全綠（含真實資料守護檢查無外洩），尚未進 `npm run test:clean` 與 C 打掃／D 魔鬼教官／新檔是否進危險清單確認。
- 2026-11-20（C 打掃＋D 魔鬼教官第 1 輪與修補）：
  - **C 打掃（ok）**：檢視本次全部變更之非測試檔，清出 0 項死碼、建議 1 條（`guard.mjs` 與 `gate.mjs` 入口／cwd／故障記錄模式可後續抽出共用）、依規則放過 2 項（測試檔唯讀、`lib/faults.mjs` 兩段分支刻意分開）。
  - **D 魔鬼教官第 1 輪（found）**：派 2 個唯讀子 agent（`Guard Path & Contract Checker`、`Faults UI & Bilingual Checker`）平行對照 `docs/FAILURE-PATTERNS.md` 與既有呼叫點，抓出 4 條 bug：
    1. `[P2/P11/R1]` 跨專案（或非 git 目錄）觸發 `guard_asked` 時把呼叫端 `cwd` 與 `transcript` 寫進目標專案 `.jsonl`，導致 `collect.mjs`／`rounds.mjs`／`transcript.mjs` 混入別的專案 worktree、假對話卡與 prompt，甚至整案因 `notGit` 被藏起來 → `guard.mjs` 改為 `guard_asked` 只記目標 `repo.root`（跨專案時另記 `caller_cwd`）、不再寫 `transcript`，並在 `lib/collect.mjs`、`lib/rounds.mjs`、`lib/transcript.mjs`、`lib/cliFacts.mjs` 顯式略過 `guard_asked` 的 worktree／對話／時間線採計。
    2. `[P6/R1]` `guard.mjs` 的 `resolveTargetPath()` 用 `existsSync()` 不跟斷鏈符號連結，指向尚不存在危險檔／資料夾的斷鏈 symlink 會依連結所在安全路徑判斷而漏放 → 改用 `lstatSync` + `readlinkSync` 逐層展開符號連結（限 40 跳防循環）即使目標尚不存在仍追到真實危險路徑。
    3. `[P2/P5/R1]` `lib/rounds.mjs` 的 `isSensorBacked` 未要求 `e.hook`，只有 `guard_asked` 沒有感測器紀錄的專案或 worktree 會讓 `noRecordsWithin` 失效、終端機誤印「⚪ 這一輪還沒跑」→ 改為 `Boolean(e.hook)` 與 `lib/collect.mjs`、`lib/cliStages.mjs` 對齊。
    4. `[P2/P7/R1]` `lib/rounds.mjs` 的 `sessionsOf` 未要求對話至少有過一筆 `hook` 事件且未略過 `guard_asked`，當子 agent 被拒且缺 `transcriptPath` 時會長出「（還沒有標題）」假人類對話卡並誤判 `sharesCwd` → 改為在 `sessionsOf` 略過 `guard_asked` 且僅保留具 `_hasHook` 的對話後再算 `sharesCwd`。
  - 已在 `scripts/guard.test.mjs` 補入以上 4 條情境的回歸測試；待 Oscar 拍板是否跑 D 第 2 輪與新增的 `guard.sh`、`guard.mjs` 是否納入危險清單。
- 2026-11-20（危險清單更新＋D 魔鬼教官第 2 輪與修補）：
  - 依 Oscar 確認（「2.照建議」）將 `guard.sh`、`guard.mjs` 加入 `.agents/pipeline-stages.json` 的 `tiers.code` 與 `tiers.danger`，並執行 `agy-pipeline --tier-checked "2.照建議"`。
  - **D 魔鬼教官第 2 輪（found）**：僅檢視第 1 輪之後改動的 6 檔（`guard.mjs`、`lib/cliFacts.mjs`、`lib/collect.mjs`、`lib/rounds.mjs`、`lib/transcript.mjs`、`scripts/guard.test.mjs`），找到 3 條並獲 Oscar 確認後修補：
    1. `[P8]` `scripts/guard.test.mjs` 缺 `node` 測試改用只連 `dirname`/`mkdir`/`date` 的暫存 `fakeBin` 與 `/bin/sh`，避免在有 `/usr/bin/node` 的 Linux／GitHub CI 誤找到系統 `node`。
    2. `[P2/P11]` `guard.mjs` 記 `guard_asked` 失敗時的 `noteBroken` 改傳呼叫端 `cwd`（與 `_guard.json` 心跳、`evaluate` 失敗記號及 `gate.mjs` 口徑一致），避免子資料夾／符號連結／跨專案恢復後仍卡在 `unclear` 黃燈。
    3. `[P6/R1]` `guard.mjs` 展開相對目標路徑改用已 `real()` 的 `realCallerCwd`，避免符號連結工作區搭配 `../` 提前走出 repo 漏抓危險檔。
  - 在 `scripts/guard.test.mjs` 補齊上述回歸測試。
  - **D 魔鬼教官第 3 輪（ok）**：僅檢視第 1 輪之後改動的 6 檔，沒對到已知死法；完整 `npm test` 27/27 支測試檔檢查全綠（含 `scripts/guard.test.mjs` 90 項與不碰真實紀錄檢查）。
  - 上線版本：v0.2.0
