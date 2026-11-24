# 功能：ask_question 一鍵決策卡解析（點選項卡誠實採認為人類決定）

分級：預測至少 **T2**（因為會動到危險清單上的 `lib/transcript.mjs`，結案升版也會碰到 `plugin.json`；另外會改動程式區的 `lib/rounds.mjs`、`lib/verify.mjs`、`lib/tier.mjs`、`lib/cliRerun.mjs`、`lib/cliReport.mjs`、`lib/cliTier.mjs`、`lib/cliWrap.mjs`、`gate.mjs`、`skills/{chaos-check,verify,tier-setup,director}/SKILL.md`、`rules/AGENTS.md`，並新增回歸測試檔）。T2 要求 A、C、D 與補測試。

> 2026-11-24 規劃（依總進度追蹤對話階段 2 建議卡開立獨立規格；前置階段 1 `v0.7.1` 已在 `main` 結案並於獨立 worktree 分支 `ask_question_decision_cards` 開工）。
> 階段 0 本機實機查證 5 份真實轉錄檔（`16815013`、`bcdc0632`、`6812a4f1`、`7633796a`、`d8de7a97`）：`ask_question` 呼叫記於 `PLANNER_RESPONSE.tool_calls`（含 AI 題目 `args.questions`），使用者回覆記於緊接配對的 `source:"MODEL"`、`status:"DONE"` 工具結果步驟（現代版 `type:"GENERIC"`，舊版 `type:"ASK_QUESTION"`），`content` 帶 1–2 組 `Created At:`／`Completed At:` 標頭後接 `A1: …`（多題 `A1:`／`A2:`…；Other 自訂文字同接於 `An: ` 後），真正送出時間為 `Completed At`（與 `PostToolUse` 觸發秒數一致，而 `PostToolUse.prompt` 仍只含舊 `lastUserInput`）。
> 讀了：`AGENTS.md`、`README.md`、`docs/FAILURE-PATTERNS.md`、`.agents/pipeline-stages.json`、`docs/升級摘要/antigravity-v01-foundation.md`、`docs/升級摘要/spec-chaos-precheck.md`、`hook.sh`、`hooks.json`、`gate.mjs`、`lib/{transcript,rounds,verify,tier,cliRerun,cliReport,cliTier,cliWrap,checklist,stageLines,todo}.mjs`、`ui/app.js`、`skills/{spec,spec-precheck,chaos-check,verify,tier-setup,director}/SKILL.md`、`rules/AGENTS.md`、`scripts/{docsIndex,skills}.test.mjs` 及上述 5 份本機真實轉錄檔。找不到 `docs/SPEC-TEMPLATE.md`（沿用既定最小格式）；`docs/LESSONS.md` 存在，本次未整份通讀。

## 這是為了解決什麼

現在 Antigravity 裡點 `ask_question` 選項卡的回覆被記成 `source:"MODEL"` 的工具結果而非 `USER_INPUT`，讀取端完全看不到，迫使每次 D 多輪、E 驗收、危險清單或 F 主任收尾都只能手打文字；這個功能讓讀取端誠實解析使用者親點的選項卡回覆與真正送出時間，使一鍵點卡能安全對回四大決策指令，同時保留純文字回話完全相容。

## 驗收條件

**AC-1　精準讀出 Antigravity 選項卡的「使用者親點結果」與真正送出時間，絕不把 AI 題目、終端輸出或未完成卡片當成人話** ✅ 對過 2026-11-24
> **白話**：只認你在畫面上「真的點下送出」的那一行答案與按下那一刻的時間；AI 自己寫出來的選項文字、沒按送出就被取消的卡片、或是終端機指令剛好印出「A1: 不用再跑」的假輸出，全都不算你說的話。
> **會發生的情況**：
> 1. 支援新舊版 Antigravity 轉錄檔：現代版 `type:"GENERIC"` 須以 `step_index` 精確對齊前一個 `PLANNER_RESPONSE.tool_calls`（`entry.step_index - plannerStep - 1`，遇壞行跳過或系統插行絕不位移錯配 `run_command`；僅無 `step_index` 時才退回順序對位且筆數不符即拒收），舊版 `type:"ASK_QUESTION"` 直接辨識；且只採認 `status === "DONE"`、剝除 1–2 組 `Created At:`／`Completed At:` 標頭後首行符合 `An:` 且含非空實質回答的結果（保留 `An:` 下方多行複選／多行 Other 自訂輸入，略過空答案題目，全空則整筆拒收）。
> 2. 時間戳優先採納標頭中最後一個合法 `Completed At`（轉為標準 UTC ISO，代表你真正點擊送出的時刻，而非卡片剛彈出的 `created_at`）；缺合法 `Completed At` 時**絕不**拿 `created_at` 充數，僅在 `enrichWithTranscripts` 對得上同 `(session, step)` 的 `PostToolUse(tool:'ask_question')` 時間戳時採納，否則照實略過（R1、P9）。
> 3. `PLANNER_RESPONSE` 裡的 `args.questions`、`run_command` 等其他 `GENERIC` 工具輸出、`status !== "DONE"`（取消／錯誤／進行中）、subagent 轉錄檔、以及讀不到轉錄檔時的 `PostToolUse` 紀錄，一律不當成人類回覆（R1、P7）。
> 4. `guessTranscriptPath` 優先找完整轉錄檔 `transcript_full.jsonl`（找不到再找 `transcript.jsonl`）；若 `transcript.jsonl` 該筆被截斷（`truncated_fields` 含 `content`），同目錄找得到 `transcript_full.jsonl` 就懶載入補讀該 `step_index`，找不到照實略過不猜（R1）。
> **技術**：`lib/transcript.mjs` 新增純函式 `parseAskQuestionReply(content, { fallbackTs, allowMissingTs })`，聚合多行 `An:` 答案、以 `[...text]`（Unicode 字元數）依 `PROMPT_CAP = 200` 截斷並產出 `askAnswers` 逐題陣列。`readTranscript` 以 `step_index` 差值嚴格配對 `PLANNER_RESPONSE`（遇 `USER_INPUT`／`SYSTEM_MESSAGE` 清空狀態），`enrichWithTranscripts` 補入 `hook: 'UserPrompt'`、`via: 'ask_question'`、`_fromTranscript: true`（subagent 跳過、`(session, step)` 去重並配對 `cwdTimeline` 與 `askPostTs`）。

**AC-2　四大決策指令（`--decide`、`--clear`、`--tier-later`、`--wrap`）誠實採認選項卡回覆，並把「點卡」與「打字」講清楚** ✅ 對過 2026-11-24
> **白話**：以後 D 要不要再跑、E 驗收過了沒、新檔要不要先不看、F 主任要不要照建議收尾，你可以直接點選項卡拍板；看板和終端機照實寫「你在選項卡點的回覆：「…」」，附的是轉錄檔裡你真的點的那一行，不是 AI 轉述的字；你要自己打字也照舊完全能用。
> **會發生的情況**：
> 1. 在 D／E 被叫（或 E 驗收、收工門禁問危險清單、叫 F 主任）之後，你透過 `ask_question` 點選或填寫 Other 送出，AI 接著代記 `--decide D/E skip`、`--clear E`、`--tier-later` 或執行 `--wrap merge|push|restart|stamp` 時，讀取端當場對得上你的選項卡回覆與送出時間（秒級 `Completed At` 遇同秒毫秒級錨點時，具備同對話且較大 `step` 即合法成立），不再判成「沒有你說的話」或「找不到這句話」。
> 2. 「只蓋到拍板之前」照舊成立：點完「不用再跑」或「驗收過了」之後若又改了程式檔（修改時間 ≥ 送出時間），一樣重新變成「要不要再跑／再走由你決定」（P9）。
> 3. 四大指令面對多題超長（合併後超過 200 字）選項卡時，共用比對先對每題答案陣列 `ask_answers`，命中哪一題就印出該題實際點的字，且仍守住「同一次點擊每步只試一次」（`triedBefore`）；截斷判斷全站統一用字元數（`[...str].length >= PROMPT_CAP` 或 `prompt_cut`），不含 UTF-16 分歧（P2、P6）。
> 4. 終端機與儀表板呈現原話對照時，選項卡來源明標「在選項卡點的回覆」（英文 `option-card reply`），手打文字維持原本「說的最後一句」文案一字不差（P2、R2）；純文字回話流程完全相容。
> **技術**：`lib/rounds.mjs` 新增共用 `isAskQuestion`、`isPromptCut`、`matchAskQuote`、`isAfterAnchor`；`promptKind` 對 `e.via === 'ask_question'`（非空字串）回 `'human'`（不因選項以 `<` 開頭誤判 `unknown`/`system`）；`decisionOf`、`judgeClear`、`laterOf`、`cliWrap.findWords` 共用 `matchAskQuote` 並保留 `via`。`rerunLine`、`eLines`、`cliRerun`、`cliReport`、`cliTier`、`cliWrap` 依 `via === 'ask_question'` 以 `zhEn` 分流文案（伺服器算好帶給網頁，網頁不另算，P2）。

**AC-3　守住邊界不誤傷：點選項卡絕不移動收工門禁回合起點、不截斷 A 寫規格、也不冒充斜線指令或 `!` 親跑** ✅ 對過 2026-11-24
> **白話**：回合中途彈出選項卡只是「同一件事裡問你一個問題」，不會讓收工門禁誤以為「這是新的一回合、剛剛改的程式不算」，也不會讓寫規格中途問你意見就把後面寫出來的規格檔切掉，更不會讓選項文字裡剛好寫著 `/chaos-check` 或 `<bash-input>` 被誤當成你親手敲指令。
> **會發生的情況**：
> 1. AI 改完程式後同回合用 `ask_question` 釐清細節、你點完後 AI 沒再改檔就想收工 → `gate.mjs` 的 `turnStart` 仍錨定在你打的 `USER_INPUT`，照樣擋下缺少的 D／A／測試；`again` 時同回合已擋紀錄也不會被洗掉。
> 2. A 寫規格中途用 `ask_question` 確認範圍、你點完後才寫出規格檔 → `specsOfRun` 仍把該規格檔算進這次 A，不因中途點卡截斷。
> 3. 選項文字開頭就算含 `/spec`、`/chaos-check` 或 `<bash-input>agy-pipeline --clear E` → `typedRun` 不算手打斜線指令，`judgeClear` 不算你自己用 `!` 跑 `--clear E`（P7）。
> 4. 對話標題摘要、建議卡「已開始」比對與 `specHint` 只看真實開頭人話，不拿選項卡回覆頂替；對話「最後說話時間」照實更新。
> **技術**：`gate.mjs` `turnStart` 優先取 `saidByHuman(e) && e.via !== 'ask_question'`（全對話無 `USER_INPUT` 才退回）；`lib/rounds.mjs` 的 `typedRun`、`judgeClear` 的 `BANG` 檢查、`specsOfRun` 的 `nextPrompt`、`firstPromptsOf`、`specContext.firstPrompt`、`firstEventAt`（`prompt` 旗標）與 `sessionsOf._firstPromptTitle` 皆排除 `isAskQuestion(e)`；`coalesceRuns`、`linkOwner`、`sessionsOf.lastSaidAt` 保留採認。

**AC-4　開放四支決策技能、門禁提示與常駐規則使用 `ask_question` 選項卡，同時保留純文字回話完全相容** ✅ 對過 2026-11-24
> **白話**：把原本因為還沒接通解析而寫死的「禁止用選項卡」拿掉，讓魔鬼教官、驗收、危險清單、工地主任在該問你拍板時，都可以先講清楚事實與建議再彈一張精簡選擇題給你一鍵點，但「驗收過了」依然只有你親自說或明確點選才算，也不准推薦你點它，純文字回答照舊能用。
> **會發生的情況**：
> 1. 更新 `skills/{chaos-check,verify,tier-setup,director}/SKILL.md`、`rules/AGENTS.md`，以及 `lib/tier.mjs`（`pendingRequirements`／`dangerAskLine`）與 `lib/cliRerun.mjs`（`--round D/E`）提示：移除「不要用選項卡（v0.1 尚未接上解析）」限制，改為可先白話講清事實與建議，再用精簡的 `ask_question` 選項卡（單題聚焦、選項精簡在 200 字內、互斥清楚）或一般文字對話請你拍板，AI 照你實際點選或填寫的內容傳給 `--decide`／`--clear`／`--tier-checked`／`--tier-later`／`--wrap`。
> 2. 紅線與邊界不放寬：E 驗收選項卡須綁死三條防線——「驗收過了」與「不用再走」拆成互斥選項、**嚴禁將「驗收過了」標成 `(Recommended)`**（R2／P10）、絕不併入 F 主任的「照建議收尾」；使用者回答前 AI 絕不擅自執行或代記；純文字回覆完全相容。
> 3. `rules/AGENTS.md` 維持無 frontmatter 且 `< 24,000 bytes`；四支技能的中英對照表與 `lib/lang.mjs` 逐字同步，既有的中英提示關鍵句檢查維持全綠（P2）。
> **技術**：同步更新上述 4 支 `SKILL.md`、`rules/AGENTS.md`、`lib/tier.mjs` 與 `lib/cliRerun.mjs`，維持 `scripts/skills.test.mjs`、`scripts/director.test.mjs`、`scripts/lang.test.mjs` 全部斷言通過。

**AC-5　中英雙語同步、全套回歸與乾淨副本測試檢查全綠** ✅ 對過 2026-11-24
> **白話**：切換成英文時，選項卡對照文案全為自然且守住紅線的英文、零中文殘留；測試把新舊版轉錄檔、防偽造、時間戳、四大指令、收工門禁邊界與雙語全部真的跑過一遍，不碰這台電腦上真的紀錄。
> **會發生的情況**：
> 1. 新增專屬測試檔覆蓋：新版 `GENERIC`（含並行多工具 `step_index` 精確配對與壞行防錯位）及舊版 `ASK_QUESTION` 真實格式、雙重 `Created At`/`Completed At` 與時區正規化、缺 `Completed At` 不退回 `created_at`、單選／多行複選與 Other／空答與取消拒收、多題超過 200 字與 emoji 字元截斷一致性、`transcript.jsonl` 截斷補讀 `transcript_full.jsonl`、subagent 排除、選項含 `/chaos-check`/`<bash-input>`/`<tag>` 防護、四大指令（`--decide`、`--clear`、`--tier-later`、`--wrap`）與拍板後再改檔、`gate.mjs` 中途點卡不放行與不洗掉 `blocked`、`specsOfRun` 中途點卡不截斷、`--lang en` 雙語與紅線，以及 E 驗收禁標 `(Recommended)` 檢查，且 `section()` 標記對應 `P2`/`P6`/`P7`/`P9`。
> 2. `npm test` 與 `npm run test:clean` 檢查全綠，真實資料夾零殘留。
> **技術**：新增 `scripts/askQuestion.test.mjs`，並視需要同步既有測試套件。

## 混沌推導

▸ **時間**：選項卡彈出（`created_at`）後使用者過了幾分鐘才點擊送出，或秒級 `Completed At` 與同秒毫秒級事件並存 → 絕不拿 `created_at` 充數（缺 `Completed At` 時僅在對得上同 `(session, step)` `PostToolUse` 才採納，R1），秒級戳記同秒內透過 `step > anchorStep` 允許成立，拍板後再改檔照樣重問（P9）。
▸ **併發**：同回合 AI 一次並行呼叫多個工具（含 `ask_question` 與 `run_command`），或跨多個工作區／subagent 同時有對話 → 具 `step_index` 時嚴格以 `step_index - plannerStep - 1` 對齊 `tool_calls`，壞行跳過或系統插行絕不位移錯配；subagent 轉錄檔標 `_subagent:true` 絕不滲入主對話（P6、P7）。
▸ **輸入畸形**：使用者取消或未完成選項卡（`status !== "DONE"`）、全空或部分空答、選項文字以 `<` 或 `/` 開頭、`run_command` 輸出偽造 `Created At:`／`A1:` → 僅採認對齊且 `status === "DONE"`、剝除標頭後具實質內容的 `An:` 回覆；選項文字不經過 `<tag>` 系統訊息過濾，亦不當成斜線指令或 `!` 親跑（P7、R1）。
▸ **容量**：多題卡片合併後超過 200 字（`PROMPT_CAP`）或 `transcript.jsonl` 單行 `content` 被截斷 → 截斷與 `cut` 統一按 Unicode 字元數 `[...text].length` 計算，並以 `matchAskQuote` 讓四大指令均能比對與印出命中的該題原文；`guessTranscriptPath` 優先讀 `transcript_full.jsonl`，讀到截斷的 `transcript.jsonl` 則同目錄補讀 `transcript_full.jsonl`（P2、P6、R1）。
▸ **權限憑證**：轉錄檔無讀取權限、檔案遺失或環境無法取讀 → `readTranscript` 靜默降級回 `{ ok: false }` 絕不阻斷儀表板或收工門禁，`hook.sh` 熱路徑維持零讀取轉錄檔、永遠 `{}` ＋ `exit 0`（R1）。

## 已拍板（2026-11-24，Oscar 確認開工）

1. **原話對照文案分流**：點選項卡明確標示「你在選項卡點的回覆：「…」」（英文 `your last option-card reply`），手打文字維持原本「你說的最後一句」不變。
2. **E 驗收選項卡與三條防線**：開放 E 驗收使用 `ask_question` 選項卡拍板，但「驗收過了」與「不用再走」必須拆成互斥選項、**嚴禁將「驗收過了」標成 `(Recommended)`**（R2／P10）、絕不併入 F 主任的「照建議收尾」。
3. **採納規格預審 5 條發現**：全部補入規格 AC-1／AC-2／AC-4／AC-5 與混沌推導，同步強化 `step_index` 對位防錯配、空答拒收、不拿 `created_at` 充數與同秒 `step` 保護、統一字元數截斷與四指令多題對齊、以及 `lib/tier.mjs`／`lib/cliRerun.mjs` 提示同步。

## 明確不做

- **不改 `hook.sh` 熱路徑去讀 `transcript.jsonl`**：維持 `/bin/sh` + `jq`、不讀大檔、永遠輸出 `{}` ＋ `exit 0`。
- **不從 `PostToolUse` 的 `toolCall.args` 推論答案**：`args.questions` 是 AI 傳入題目而非人話（P7、R1）。
- **不由工具自動判斷選項語意**：只驗證為使用者親點並附原文對照，不替人判定 `skip`／`accept`（R2）。
- **不強制取代純文字回話**：純文字路徑維持完全相容。

## 施作紀錄

- **2026-11-24 階段 0 實機查證與規格（A／A→D 預審）**：實查本機 5 份真實轉錄檔（`16815013`、`bcdc0632`、`6812a4f1`、`7633796a`、`d8de7a97`）確認 `ask_question` 結構；撰寫規格並由 `spec-precheck` 提出 5 條發現，經 Oscar 拍板將文案分流、E 驗收選項卡三防線與 5 條預審發現全數補入規格後開工。
- **2026-11-24 實作與測試（B）**：
  - [lib/transcript.mjs](../../lib/transcript.mjs)：實作 `parseAskQuestionReply`（剝除 `Created At`/`Completed At`、嚴取合法 `Completed At` 且不退回 `Created At`、拒收空答／取消）、`guessTranscriptPath` 優先完整轉錄檔與截斷懶補讀、`enrichWithTranscripts` 支援 `(session, step)` `PostToolUse(ask_question)` 補時並寫入 `via: 'ask_question'` 與 `ask_answers`（subagent 排除）。
  - [lib/rounds.mjs](../../lib/rounds.mjs)、[lib/verify.mjs](../../lib/verify.mjs)、[lib/tier.mjs](../../lib/tier.mjs)、[lib/cliRerun.mjs](../../lib/cliRerun.mjs)、[lib/cliReport.mjs](../../lib/cliReport.mjs)、[lib/cliTier.mjs](../../lib/cliTier.mjs)、[lib/cliWrap.mjs](../../lib/cliWrap.mjs)：新增共用 `isAskQuestion`／`isPromptCut`／`matchAskQuote`／`isAfterAnchor`，串通四大決策指令（含多題超長比對、同秒 `step` 與 Unicode 字元數一致性）及中英選項卡對照文案，守住 AC-3 邊界不誤傷。
  - [gate.mjs](../../gate.mjs)：`turnStart` 錨定於一般打字 `USER_INPUT`，中途點選項卡不重算回合或洗掉 `blocked`。
  - [rules/AGENTS.md](../../rules/AGENTS.md) 與 `skills/{chaos-check,verify,tier-setup,director}/SKILL.md`：移除 v0.1 選項卡禁令，開放精簡選項卡並保留純文字完全相容，同步綁死 E 驗收選項卡三條防線（互斥、禁標 `(Recommended)`、不併入照建議收尾）。
  - [scripts/askQuestion.test.mjs](../../scripts/askQuestion.test.mjs)：補齊 AC-1～AC-5 回歸與中英雙語檢查。
- **2026-11-24 打掃（C）與魔鬼教官（D 第 1～2 輪）**：
  - C 打掃：`agy-pipeline --report C ok`，`已改 0 項、建議 2 條`（不改測試與控制流）。
  - D 第 1 輪：`agy-pipeline --report D found`（`沒派 agent`），抓到 1 條 `[P6]`（本機 15 個真實對話共 58 次出現 `GENERIC` 先於所屬 `PLANNER_RESPONSE` 寫入 `transcript_full.jsonl`）；隨即修補 [lib/transcript.mjs](../../lib/transcript.mjs) 改以 `step_index` 排序後配對並共用 `extractAsk`，於 [scripts/askQuestion.test.mjs](../../scripts/askQuestion.test.mjs) 補上亂序寫入與 `tool_calls` 截斷補讀 `P6` 回歸測試。
  - D 第 2 輪（Oscar 拍板重跑）：`agy-pipeline --report D ok`，僅檢查第 1 輪後改動的 `lib/transcript.mjs` 與 `scripts/askQuestion.test.mjs`，結論為「沒對到已知死法」。
- **2026-11-24 實況實測與收尾結案**：啟動 worktree 測試頁 `http://127.0.0.1:4325` 並透過 `ask_question` 實況點擊實測即時解析；已依 `AGENTS.md` 結案搬入 `docs/升級摘要/`、同步索引與升版，全套回歸與雙語測試檢查全綠，真實紀錄目錄零殘留。

上線版本：v0.8.0
