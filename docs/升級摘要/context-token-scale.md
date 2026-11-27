# 功能：對話 Context Token 真實量表（從本機轉錄檔讀實數與專案歷史比例尺）

分級：預測至少 **T2**（因為會動到危險清單上的 `lib/transcript.mjs`，結案升版也會碰到 `plugin.json`；另預計新增程式檔 `lib/contextScale.mjs` 與測試檔 `scripts/contextScale.test.mjs`，並修改程式區的 `lib/collect.mjs`、`lib/cliView.mjs`、`status.mjs`、`ui/app.js`、`ui/ui.css` 與既有測試 `scripts/ui.test.mjs`、`scripts/lang.test.mjs`——新增的 `lib/contextScale.mjs` 落在危險清單定好之後，施工時須由你判斷要不要加入危險清單）。T2 要求 A、C、D 與補測試（另有儀表板對話頁畫面改動，完工後可選跑 E 驗收）。

> 2026-11-26 規劃（依總進度追蹤對話 2026-11-26 Oscar 原話與建議對話卡開立，無前置依賴；於獨立 worktree 分支 `context_token_scale_spec` 起草，`main` 目前為 `v0.11.0`；納入規格預審 8 條與 Oscar 拍板後搬入 `docs/進行中/` 開工）。
> 階段 0 本機實機查證（95 個 Antigravity 對話／190 份轉錄檔，含 66 主對話與 29 subagent，及 `~/.pipeline-monitor-agy/logs/pipeline-monitor_for_antigravty.jsonl`）：
> 1. **跨 11 款模型（Gemini 與 Claude 全系列，共 2,683 筆含 token 之 `PLANNER_RESPONSE`）一致證實：`input_tokens` 不含 `cache_read_tokens`**（2,380／2,455 筆快取命中步驟 `cache_read_tokens > input_tokens`，且相鄰步驟滿足「下一步 `cache_read_tokens ≈ 上一步 input_tokens + cache_read_tokens`」，快取失效時則整包落入 `input_tokens`、`cache_read_tokens = 0`）。故單步真實 Context 輸入用量固定為 **`input_tokens + cache_read_tokens`**；`output_tokens` 為該步回應輸出量，分開呈現不混入輸入；四欄（`model`、`input_tokens`、`cache_read_tokens`、`output_tokens`）與 `created_at` 在現代格式 100% 同時存在。
> 2. **精簡／完整轉錄檔一致**：比對最大 5 份對話共 1,182 筆配對 `PLANNER_RESPONSE`，`transcript.jsonl` 與 `transcript_full.jsonl` 在 token／模型／時間戳上 **0 筆差異**；`truncated_fields` 只會截斷 `thinking`、`tool_calls`、`content`，絕不截斷 token 欄位。
> 3. **舊格式與混合對話**：48 份早期對話（2026-05～08）無 token 欄位，1 份對話（`16815013`）前半無欄位、後半有欄位；故須取排序後「最後一筆含合法 token 欄位的 `PLANNER_RESPONSE`」，全無時明講讀不到 token 紀錄（R1）。
> 4. **壓縮（compaction）標記確實存在**：共見 79 筆 `source:"SYSTEM"`、`type:"CHECKPOINT"`、`status:"DONE"`（現代 25 筆以 `# Resuming from a compaction` 開頭、舊版 54 筆以 `{{ CHECKPOINT N }}` 加 `truncated due to its long length` 開頭）；23 次大幅 Context 驟降中有 22 次緊接此標記（約 468k–554k 壓縮回 20k–32k），另 1 次為中途切換模型。`CHECKPOINT` 本身也可能帶 token 欄位，不可誤算為 `PLANNER_RESPONSE`。
> 5. **本專案實況**：本機紀錄已有 14 個已結案非 subagent 對話全數可讀（單對話最高用量介於 65.8k–554.2k，中位數約 511k、最高 554.2k；其中 9 個曾壓縮 1–4 次，例如 `83621d7d` 最高 550.5k、壓縮後結束於 97.6k）。
> 讀了：`AGENTS.md`、`docs/ROADMAP.md`、`docs/DESIGN.md`、`docs/FAILURE-PATTERNS.md`、`.agents/pipeline-stages.json`、`package.json`、`ui設計規格/variables.css`、`lib/{transcript,collect,rounds,git,scope,lang,cliFacts,cliView}.mjs`、`status.mjs`、`server.mjs`、`ui/{app.js,ui.css}`、`docs/升級摘要/{終端機與網頁說同一句,ask-question-decision-cards,worktree-conflict-detection,dashboard-brief-card}.md`、`scripts/{ui,lang,docsIndex}.test.mjs` 及上述本機實測轉錄檔與紀錄。找不到 `docs/SPEC-TEMPLATE.md`（沿用既定最小格式）；`docs/LESSONS.md` 與 `README.md` 存在，本次只透過 `FAILURE-PATTERNS.md` 與 `AGENTS.md` 對照、未整份通讀。

## 這是為了解決什麼

長對話做到一半容易被系統自動壓縮、忘記前面講好的細節，但目前 `agy-pipeline` 與儀表板都看不到這個對話目前吃掉多少 context token、有沒有已經壓縮過，也沒有本專案過往結案對話的歷史對照；這個功能直接從本機 Antigravity 轉錄檔讀出真實 token 數、模型名、量測時間與壓縮紀錄，搭配本專案自己的歷史比例尺，讓對話長度與壓縮事實一目了然，同時絕不編造假百分比或固定危險門檻。

## 驗收條件

**AC-1　從本機轉錄檔讀出最後一次模型回應的真實 token 用量、模型名、量測時間與壓縮紀錄，讀不到或沒欄位時照實講、不折成 0** ✅ 對過 2026-11-26
> **白話**：只看對話紀錄裡「最後一次 AI 真的回應完」那一刻的實際記憶用量、用的模型與多久前量的；如果這個對話中途已經被系統壓縮（忘掉一部分舊內容）也會直接講出來，免得壓縮後數字變小讓你誤以為它還記得全部細節；檔案刪了、讀不到或舊版沒記 token，就直接說問不到，絕不畫成 0。
> **會發生的情況**：
> 1. 讀到可解析轉錄檔時，依 `step_index` 排序（相容無 `step_index` 合成資料）取**最後一筆** `source: "MODEL"`、`type: "PLANNER_RESPONSE"`、`status: "DONE"`、且同時具備合法非負有限數 `input_tokens` 與 `cache_read_tokens`（兩者相加 `> 0`）與合法 `created_at` 時間戳的步驟，算出真實 Context 用量 `input_tokens + cache_read_tokens`、記錄 `model`（缺值時明標未記錄，不印 `null`/`undefined`）、`output_tokens`（合法非負數或 `null`）與量測時間 `created_at`；同時記錄整個對話曾經到達的最高值 `peakTokens` 與時刻 `peakAt`。
> 2. `SYSTEM` 的 `CHECKPOINT` 步驟絕不計入 `PLANNER_RESPONSE` token；但凡屬 `source: "SYSTEM"`、`type: "CHECKPOINT"`、`status: "DONE"` 且內容符合現代壓縮（`# Resuming from a compaction`）或舊版截斷（`{{ CHECKPOINT N }}` 且含 `truncated due to its long length`）者，計入本對話壓縮次數 `compactions` 與最近一次壓縮時間 `lastCompactionAt`（若 `truncated_fields` 含 `content` 且尚未判出標記，比照 `extractAsk()` 僅對該 `step_index` 懶載入 `loadFullStep` 補齊；缺合法 `created_at` 時覆寫為 `null` 不沿用前一次時間，畫面印「時間未記錄」絕不直傳 `ago(null)`，P6／P9／R1）。
> 3. 轉錄檔遺失／讀不到、有檔但尚未有含合法 token 欄位的 `PLANNER_RESPONSE`（舊格式、剛開場或欄位缺漏如缺少 `cache_read_tokens`／`created_at`），區分誠實狀態（`no-file`／`unreadable`／`no-tokens`）並明講「問不到／看不到」，絕不折成 `0 tokens`（R1、P5）。
> 4. subagent 轉錄檔（`isSubagent: true`）不作為獨立主對話呈現，也不混入專案歷史比例尺樣本。
> **技術**：擴充 `lib/transcript.mjs` 的 `readTranscript()` 回傳向後相容的 `usage` 物件，並在 `{ ok: false }` 時附帶 `reason: 'missing' | 'unreadable'`（沿用既有 `(mtimeMs, size)` 快取與 compact `transcript.jsonl`，僅對截斷之 `CHECKPOINT` 懶補讀 `transcript_full.jsonl`），同時匯出共用路徑查找輔助 `transcriptPathOf`（維持 **`extraTranscripts` → 紀錄中最新 `e.transcript` → `guessTranscriptPath`**，與既有 `enrichWithTranscripts`／`sessionStartOf` 一致，P2／P8）。`hook.sh` 熱路徑維持零讀取轉錄檔、永遠 `{}` ＋ `exit 0`。

**AC-2　歷史比例尺只用本專案過往結案對話的最高用量，滿 5 個可讀樣本才顯示基準，嚴禁百分比與固定危險門檻** ✅ 對過 2026-11-26
> **白話**：這間工地平常一個對話做到多大才收工，只拿「這個專案自己以前真的結案過的對話」當尺，滿 5 個才報「平常到多大、最多到過多大」；樣本不夠就老實說還沒湊滿 5 個，絕不自己編「80% 危險」或「超過 400k 就警告」，也不算花費金額。
> **會發生的情況**：
> 1. 專案歷史比例尺取本專案 `sessionsOf(events)` 判定為已結案（`closedAt` 非空、結案後又活動被算回進行中者不納入，P2）且非 subagent 的對話，依最近結案／最後動作時間由新到舊掃描，收集最多 **30 個**具可讀 `peakTokens > 0` 的已結案對話；拆清 `totalClosed`、`scanned`、`sample`、`unreadInScanned`（僅限已掃描範圍內讀不到或無 token 紀錄者）與 `unscanned = totalClosed - scanned`（「另有 N 個更早的已結案對話未掃描」，不推論未掃描對話之可讀性，R1）。
> 2. 每個結案樣本採該對話曾經到達的最高值 **`peakTokens`**（避免中途壓縮後收尾變小的重度對話拉低基準）；達 **5 個以上**可讀樣本才算出中位數 `median`（`sorted[Math.floor(n / 2)]`，與 `lib/git.mjs` `changeScale` 同口徑）與最大值 `max`，並寫明樣本數（若有已掃描但讀不到的結案對話或未掃描筆數一併附註）。
> 3. 可讀結案樣本不足 5 個時**不給**中位數／最大值，並區分 `evState === 'no-file'`（「這個專案尚未建立對話紀錄檔」）、有紀錄檔但保留期內無已結案對話（「這個專案 90 天內沒有已結案對話（紀錄只留 90 天）」），以及「目前只有 N 個可讀已結案對話（滿 5 個才給歷史比例尺）」三種說法（R1、R3、P5）。
> 4. 若目前對話曾壓縮（`compactions > 0`）或曾經到過比現在更高的 `peakTokens`，在對照歷史比例尺時同時寫出本對話已壓縮次數、最近壓縮時間（無合法時間戳印「時間未記錄」，絕不直傳 `ago(null)`，P9）與本對話最高用量，避免把壓縮後的低數字直接拿去跟歷史最高值誤比。
> 5. 任何輸出（中英文、終端機、網頁）均**不出現**剩餘空間百分比、`%` 符號、固定 token 警戒線、花費金額、綠燈或打勾（R2、R3、P4、P10）。
> **技術**：新增純函式單一真相來源 `lib/contextScale.mjs`（實作 `formatTokens`、`projectContextScale`、`sessionContextView` 與所有 `zhEn` 雙語文案）。

**AC-3　終端機 `agy-pipeline` 與儀表板對話頁講同一份文案，舊服務不裝沒事且不改寫任何攔截 hook** ✅ 對過 2026-11-26
> **白話**：不管你在終端機打 `agy-pipeline`，還是在瀏覽器打開這個對話頁，看到的 token 數字、量測時間、壓縮提醒與專案歷史比例尺都是一字不差的同一句話；剛更新還沒重啟儀表板時，頁頂和量表位置都會老實提醒要重啟，不會空白裝沒事，也不會中途跳出來打斷你跟 AI 對話。
> **會發生的情況**：
> 1. **終端機 `agy-pipeline`**（含零 commit `!ctx.hasCommits` 早退路徑，且該路徑須同樣先執行 `normalizeEventsCwd`，P6／P13）：
>    - 在 Antigravity 對話內執行（環境變數有 `ANTIGRAVITY_CONVERSATION_ID`）→ 直接讀該對話的轉錄檔（即使首回合尚無 hook 事件也可透過 `guessTranscriptPath` 查到）；若該轉錄檔屬 subagent（`isSubagent: true`），追回 `parentId` 對應主對話顯示用量並加註目前位於 subagent，找不到主對話則照實說明（P6／R1）。
>    - 人在獨立終端機執行（無對話代號）→ 看本工作區這一手（`tenure`）進行中的對話（從 `tenureEvents` 取 `sessionsOf` 後須再依 `s.cwd === ctx.root` 過濾並排除 `previousTenant`，以免混入他處 worktree，P6）：剛好 1 個就直接顯示該對話；超過 1 個（共用工作區）則顯示最近有動作的那個，並明標標題／前碼與「這個工作區有 N 個進行中的對話，以下為最近有動作的那個（其他請看儀表板各對話頁）」；0 個進行中對話時區分 `evState === 'no-file'`（「這個專案尚未建立對話紀錄檔（且獨立終端機未帶對話代號），看不到目前是否有進行中的對話或 context 用量」）與有紀錄檔但無進行中對話（「紀錄裡這個工作區目前沒有進行中的對話（獨立終端機未帶對話代號），問不到目前的 context 用量」），不拿已結案舊對話冒充（R1、P3、P6）。
>    - 專案歷史比例尺在 CLI 與儀表板一律吃未經 `tenureEvents` 裁切的全專案 `events`（P2）。
> 2. **儀表板對話頁（`sessionPage`）**：
>    - 在對話頁第一區塊畫一張精簡的「對話記憶量表」卡（獨立於四張 `.stats` 便條紙外，不打亂四卡節奏，且在 `c.gone` 與 `s.movedOn` 舊對話頁同樣看得到——轉錄檔跟著對話代號走，不跟著 git 資料夾消失，P6）。
>    - 畫面只照印伺服器照 `lib/contextScale.mjs` 算好的文案：主數值（或問不到狀態）、模型名與量測時間（`ago`）、壓縮事實行（有壓縮才印）、專案歷史比例尺行（或未滿 5 筆原因）；點開可收合「細節」（`foldOpen` 記憶開關）顯示 `input_tokens`＋`cache_read_tokens`＋`output_tokens` 拆解、本對話最高用量、基準樣本覆蓋說明與誠實註記（不含「百分比」「進度」字樣，P4）。
>    - 樣式全吃 `ui設計規格/variables.css` token（`ui/ui.css` 零色碼），支援白天／夜間工班雙風格，絕不出現綠燈或笑臉（P10）。
> 3. **舊服務防護**：`collectAll()` 頂層補 `contextScaleSupport: true`、案件補 `p.contextScale`、對話補 `s.context`；`ui/app.js` 的 `oldServerBanner()` 納入 `!('contextScaleSupport' in latest)`，舊服務無欄位時量表卡顯示 `OLD_LINE`，不空白、不當成沒有紀錄（P2、P5）。
> 4. 不新增或改動任何 `PreInvocation`／`PreToolUse`／`Stop` 攔截行為。
> **技術**：`lib/collect.mjs` 複用 `readTranscript` 快取算出 `p.contextScale` 與各對話 `s.context`（零新增 git 呼叫）；`lib/cliView.mjs` 新增 `renderContextScale()` 供 `status.mjs` 正常與 `!ctx.hasCommits` 兩條路呼叫；`ui/app.js` 新增 `contextScaleCard(s)` 並更新 `oldServerBanner()`；`ui/ui.css` 新增 `.ctx-*` 雙風格樣式。

**AC-4　中英雙語同步、補齊轉錄檔與前後端回歸測試，本機與乾淨副本檢查全綠** ✅ 對過 2026-11-26
> **白話**：切成英文後，終端機與儀表板對話頁的記憶量表全部換成自然且守住紅線的英文、沒有殘留中文或百分比字眼；自動化測試把跨模型加總、亂序寫入、壓縮偵測、舊格式缺欄、未滿／滿 5 個結案樣本、終端機多情境識別、前後端一字不差與舊服務橫條全部跑過一遍，不碰這台電腦上真的紀錄。
> **會發生的情況**：
> 1. 切換 `--lang en`／`zh`（或儀表板按 `L`）後，終端機與儀表板對話頁量表全數同步切換，英文零中文殘留與全形空白，不含禁語（`passed`、`all clear`、`verified`、`safe`、`%`）。
> 2. 新增 `scripts/contextScale.test.mjs`（`section()` 標記 `P2`、`P4`、`P5`、`P6`、`P8`、`P9`、`P10`），並同步更新 `scripts/ui.test.mjs`（`oldServerBanner` 基準、`contextScaleSupport` 及「上一手的對話頁」替身同步注入 `contextScaleCard`）與 `scripts/lang.test.mjs`（`enWorld` 補 `contextScaleSupport`/`context` 驗證英文零中文）；涵蓋 Gemini/Claude 加總、亂序 `step_index`、混合舊新步驟、現代與舊版 `CHECKPOINT` 壓縮偵測（且不誤計其 token）、`CHECKPOINT` 截斷補讀、缺檔（`missing` vs `unreadable`）／空欄／缺 `cache_read_tokens`／缺 `created_at`（不印 1970 假時間）誠實回報、subagent 排除與 CLI 追回主對話、已結案未滿 5（區分 `no-file` 與 90 天無結案）／滿 5／超過 30 筆拆清未掃描筆數與結案後重開排除、CLI 四種會話識別路徑與 `!ctx.hasCommits` 子目錄路徑歸一、終端機與網頁一字不差及假字串照印（P2）、舊服務黃條、`gone`/`movedOn` 頁呈現、零 `%` 與零綠燈。
> 3. `npm test` 與 `npm run test:clean` 檢查全綠，真實 `~/.pipeline-monitor-agy/` 與原版 `~/.pipeline-monitor/` 零殘留；結案時搬入 `docs/升級摘要/context-token-scale.md`、更新 `AGENTS.md` 索引、`package.json` 與 `plugin.json` 同步升版。
> **技術**：所有測試以暫存目錄與 `extraTranscripts`／假家目錄隔離（P8），沿用 `scripts/ui.test.mjs` 的 `uiOf()` 實際執行 `ui/app.js`。

## 混沌推導

▸ **時間**：`PLANNER_RESPONSE.created_at` 距今已過數分鐘、或跨時鐘調整呈負秒差 → 顯示一律附 `ago(created_at)`（「N 分鐘前量得」），負秒差沿用 `lib/git.mjs` `ago()` 回「時間對不上」；`lastCompactionAt` 或 `peakAt` 缺合法時間戳時為 `null`，改印「時間未記錄」，絕不把 `null` 傳給 `ago()` 算出 1970 年假時間，也絕不以檔案 `mtime` 或現在時間充數（R1、R3、P9）。
▸ **併發／更新時序**：AI 剛寫完轉錄檔或每 5 秒儀表板輪詢 → `readTranscript` 以 `(mtimeMs, size)` 快取，檔案沒變不重讀、檔案更新即自動重讀；壓縮步驟與工具步驟寫入順序可能與 `step_index` 不同，一律先依 `step_index` 排序再算（P6）。
▸ **容量**：單一專案累積上百個已結案對話或單份轉錄檔達數 MB → 歷史比例尺由新到舊只掃至湊滿 30 個可讀已結案樣本即停止，並另報「另有 N 個更早的已結案對話未掃描」，直接讀精簡 `transcript.jsonl`（僅對內容被截斷且尚未判出標記之 `CHECKPOINT` 懶載入 `transcript_full.jsonl`）搭配 `readTranscript` 快取，避免拖慢每 5 秒刷新；終端機與網頁只傳摘要欄位，不傳逐筆步驟陣列。
▸ **輸入畸形**：壞 JSON 行、`input_tokens` 為字串／負數／`NaN`、缺 `cache_read_tokens`、兩者相加為 `0`、舊版無 token 欄位、`model` 為空或非字串、對話標題含 HTML 字元 → 壞行與不合法步驟直接略過，無任何合法步驟回 `no-tokens` 絕不折成 `0`；缺模型名照實標「未記錄」不印 `null`；所有動態字皆經 `esc()` 跳脫（R1、P5）。
▸ **權限憑證**：沙盒或權限不足導致轉錄檔讀不到（`EACCES`/`EPERM`）與檔案不存在（`ENOENT`）→ `readTranscript` 靜默回 `{ ok: false, reason }`（區分 `missing` 與 `unreadable`），畫面照實講「找不到轉錄檔」或「沒有權限讀轉錄檔」，不讓儀表板或 `agy-pipeline` 當機（R1）。

## 已拍板（2026-11-26，Oscar 確認開工）

1. **基準口徑**：歷史比例尺採用本專案各已結案對話曾經到達的最高用量 **`peakTokens`**，避免中途壓縮過的長對話把基準拉低。
2. **對話頁版面**：於對話頁獨立放置一張精簡「對話記憶量表」卡（獨立於四張 `.stats` 便條紙外，同時支援 `gone` 與 `movedOn` 舊對話頁）。
3. **預審 8 條補強全數納入**：含 90 天清理與 `no-file` 區分、30 筆上限拆清 `unscanned`、`extraTranscripts` 優先序、`null` 時間戳防 `ago(null)`、`readTranscript` 失敗附 `reason`、CLI `!ctx.hasCommits` 歸一／依 `cwd` 過濾／吃全專案 `events`、`CHECKPOINT` 截斷補讀、`ANTIGRAVITY_CONVERSATION_ID` 為 subagent 時追回 `parentId`，以及 `scripts/ui.test.mjs` `sessionPage` 替身注入 `contextScaleCard`。

## 明確不做

- **不編造 Context 使用百分比或剩餘空間進度條**：本機轉錄檔未紀錄各模型當下真實有效上限（且壓縮觸發線由系統動態決定），不假設分母、不出現 `%`（R3、P4）。
- **不自設固定 token 警戒線（例如 400k 紅燈／80% 警告）**：只呈現真實數值、壓縮事實與本專案自己的歷史比例尺，不下「太多／危險」判斷（R3、P10）。
- **不計算 API 花費金額（USD）**：定價隨方案與模型變動且與「失憶風險」無關（延續 `ROADMAP.md` Q6 原則）。
- **不新增 `PreInvocation`／`PreToolUse`／`Stop` 攔截或中途碎念**：本功能為純唯讀觀測，不干擾對話流、不阻擋工具呼叫或收工。
- **不改 `hook.sh` 熱路徑去讀轉錄檔**：維持 `/bin/sh` + `jq` 零讀大檔、永遠 `{}` ＋ `exit 0`。
- **不改動案件頁白板或首頁工地晨報卡**：本次專注於終端機 `agy-pipeline` 與儀表板對話頁。

## 施作紀錄

- 2026-11-26（階段 0＋A 規格＋規格預審）：實查本機 95 個 Antigravity 對話／190 份轉錄檔及本專案 14 個已結案紀錄，寫妥規格並記 `--report A ok`；派 1 位獨立唯讀 `research` subagent 跑一輪 `spec-precheck` 找到 8 條（記 `--precheck found`）。依 Oscar 拍板將 3 項決定與預審 8 條補強全數納入規格並搬入 `docs/進行中/` 開工。
- 2026-11-26（B 寫程式＋對過 AC-1～AC-4）：
  - [lib/transcript.mjs](../../lib/transcript.mjs)：擴充 `readTranscript()` 依 `step_index` 計算真實 `input_tokens + cache_read_tokens`、最高用量 `peakTokens` 與時刻、現代／舊版 `SYSTEM/CHECKPOINT` 壓縮次數（遇 `truncated_fields` 含 `content` 時懶載入 `transcript_full.jsonl` 補讀；缺合法 `created_at` 時覆寫 `lastCompactionAt` 為 `null`）；失敗回傳附帶 `reason: 'missing' | 'unreadable'`；新增並匯出 `transcriptPathOf()`（維持 `extraTranscripts` → 最新 `e.transcript` → `guessTranscriptPath`）。
  - [lib/contextScale.mjs](../../lib/contextScale.mjs)：新增單一真相來源，實作 `formatTokens`、`formatExactTokens`、`safeAgo`、`projectContextScale`（區分 `no-file` 與 90 天無結案、採 `peakTokens` 滿 5 個可讀才給基準、掃滿 30 個即停並拆清 `unscanned` 與 `unreadInScanned`、排除重開與 subagent）、`sessionContextView`（區分 `no-session`/`no-file`/`unreadable`/`no-tokens`/`subagent-no-parent`/`ok`、subagent 追回 `parentId`、`null` 時間戳印「時間未記錄」、不含 `%` 與固定門檻）及 `resolveCliContext`（獨立終端機只看本工作區這一手進行中對話）。
  - 串接 [lib/collect.mjs](../../lib/collect.mjs)（`p.contextScale`、`s.context`、`contextScaleSupport: true`）、[lib/cliView.mjs](../../lib/cliView.mjs)（`renderContextScale`）、[status.mjs](../../status.mjs)（正常路徑與 `!ctx.hasCommits` 先跑 `normalizeEventsCwd` 再印量表）、[ui/app.js](../../ui/app.js)（`contextScaleCard(s)` 支援正常／`c.gone`／`s.movedOn` 對話頁並納入 `oldServerBanner()`）、[ui/ui.css](../../ui/ui.css)（`.ctx-*` 雙風格樣式全吃 `variables.css` token、零色碼無綠燈）。
  - 測試：新增 [scripts/contextScale.test.mjs](../../scripts/contextScale.test.mjs)（62 項檢查），並更新 [scripts/ui.test.mjs](../../scripts/ui.test.mjs)、[scripts/lang.test.mjs](../../scripts/lang.test.mjs)、[scripts/faults.test.mjs](../../scripts/faults.test.mjs)；`npm test` 34/34 支測試檔檢查全綠且真實紀錄目錄零殘留。
- 2026-11-26（C 打掃＋D 第 1 輪＋危險清單定案＋修補）：C 打掃記 `--report C ok "已改 0 項、建議 0 條"`；D 第 1 輪找到 2 條（記 `--report D found`）。依 Oscar 拍板：`--tier-checked` 記定案不將 [lib/contextScale.mjs](../../lib/contextScale.mjs) 加入危險清單；修補 [lib/transcript.mjs](../../lib/transcript.mjs)（`plannerSteps++` 移至 `status === 'DONE'` 之後，避免首回合 `RUNNING` 誤判為舊格式缺欄位）與 [lib/contextScale.mjs](../../lib/contextScale.mjs)（`no-session` 路徑傳入並區分 `evState === 'no-file'` 與紀錄無進行中對話），並於 [scripts/contextScale.test.mjs](../../scripts/contextScale.test.mjs) 補齊兩處回歸測試。
- 2026-11-26（E 第 1 趟實機問題修補）：E 第 1 趟實測抓到主對話進行中且剛由瀏覽器 subagent 執行 `webview_browser` 時，[lib/transcript.mjs](../../lib/transcript.mjs) `enrichWithTranscripts()` 歸屬 `_fromSubagent` 事件會連帶複製 subagent 自己的 `e.transcript`、進而讓 `transcriptPathOf()` 誤讀成 subagent 轉錄檔落入「問不到／目前位於 subagent 對話」（記 `--report E found`）。經 Oscar 拍板後修補 `enrichWithTranscripts()` 拿掉 `_fromSubagent` 合成事件的 `transcript`、`transcriptPathOf()` 防禦性略過 `e?._fromSubagent`（保留 `e?._subagent` 以供 subagent 內追回主對話），並於 [scripts/contextScale.test.mjs](../../scripts/contextScale.test.mjs) 補齊回歸測試。
- 2026-11-26～11-27（D 第 2 輪＋E 第 2 趟＋結案收尾）：D 第 2 輪只檢視第 1 輪後改動之 3 檔、沒對到已知死法（`--report D ok`）；E 第 2 趟實測 `4c739056` 與抽查對話皆正常顯示（`--report E ok`）；經 Oscar 確認「驗收過了」（`--clear E`），規格搬入 `docs/升級摘要/`、更新 `AGENTS.md` 索引並同步升版 [package.json](../../package.json) 與 [plugin.json](../../plugin.json)。

上線版本：v0.12.0
