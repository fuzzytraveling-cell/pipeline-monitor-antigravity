# 功能：軟整併「建議新增的對話（--suggest）」與「誠實任務板」為單一主力入口

分級：預測至少 **T2**（因為結案升版會動到危險清單上的 `plugin.json`；預計修改程式區的 `lib/tasks.mjs`、`lib/collect.mjs`、`lib/todo.mjs`、`lib/brief.mjs`、`lib/cliReport.mjs`、`ui/app.js`、`ui/ui.css`、`skills/director/SKILL.md`、`skills/retrospect/SKILL.md`、`rules/AGENTS.md`，以及文件 `AGENTS.md`、`package.json` 與測試 `scripts/{tasks,ui,todo,director,brief,skills,lang}.test.mjs`）。T2 要求 A、C、D 與補測試（涉及看板案件頁與首頁晨報卡改動，完工後可選跑 E 驗收）。

> 2026-11-27 規劃與實作完成（對應 `.agents/pipeline-tasks.json` 任務 `T-19`；已與 Oscar 拍板**做法 A**、3 項使用習慣拍板與納入獨立規格預審 8 條補強，已結案歸檔）。
> 讀了：`AGENTS.md`、`README.md`、`docs/ROADMAP.md`、`docs/DESIGN.md`、`docs/FAILURE-PATTERNS.md`、`.agents/pipeline-stages.json`、`.agents/pipeline-tasks.json`、`package.json`、`plugin.json`、`rules/AGENTS.md`、`server.mjs`、`lib/{tasks,todo,cliTodo,brief,collect,cliReport,rounds,lang}.mjs`、`ui/app.js`、`ui/ui.css`、`skills/{spec,spec-precheck,director,retrospect}/SKILL.md`、`docs/升級摘要/{honest-task-board-director-dispatch,主任技能}.md`、`scripts/{ui,director,todo,brief,skills,docsIndex}.test.mjs` 與 `agy-pipeline --context` 反查結果。找不到 `docs/SPEC-TEMPLATE.md`（沿用既定最小格式）。

## 這是為了解決什麼

解決專案建立 `.agents/pipeline-tasks.json` 誠實任務板之後，案件頁同時堆疊「誠實任務板」與「建議新增的對話（`--suggest`）」兩套入口搶版面、且 F 工地主任與工地復盤官仍會重複開立 `--suggest` 建議卡造成雙軌並存的混亂，同時確保無任務板的小專案維持原輕量兜底、歷史建議卡一張不丟。

## 驗收條件

**AC-1　三態任務入口模式由單一真相來源推導，異常態與舊服務絕不偷折成無任務板或誤收折** ✅ 對過 2026-11-27
> **白話**：工地先講明今天用的是「大任務板（主力）」還是「小便條（輕量建議卡）」；如果大任務板的清單壞掉、鎖住打不開，或看板服務還沒重啟成新版，就照實講清楚，絕不假裝這工地沒設任務板，也不把原本看得到的便條藏起來。
> **會發生的情況**：
> 1. 在 `lib/tasks.mjs` 定義唯一共用的入口模式 `entryMode` 並併入 `deriveTaskBoard()` 回傳結果：`state` 為 `ok` 或 `empty`（已建立 `.agents/pipeline-tasks.json` 或相容 `.claude/pipeline-tasks.json`，含空陣列 `tasks: []`）→ `'task-board'`；`state === 'unset'`（尚未建檔的小專案）→ `'fallback'`；`state` 為 `broken`、`unreadable` 或 `no-main` → `'unknown'`（守住 R1：問不到／讀不懂絕不折成 `unset` 或 `task-board`）。
> 2. 看板（`ui/app.js`）、終端機 `--todo`／`--cards`（`lib/todo.mjs`）、工地晨報（`lib/brief.mjs`）與 `--suggest`（`lib/cliReport.mjs`）全數消費同一來源判定（P2）。
> 3. `lib/collect.mjs` 頂層附帶 `taskEntryMergeSupport: true`，`ui/app.js` `oldServerBanner()` 納入檢查；前端**僅在** `'taskEntryMergeSupport' in latest` 且 `p.taskBoard?.entryMode` 同時存在時才套用三態分流，欠缺任一者（例如從 `v0.15.0` 升級尚未 `--serve-restart`）一律視為舊服務降級——於頁頂與任務板區塊內皆顯示舊服務提醒（`OLD_LINE`），完整保留 `suggestionsBlock` 不收折，且**禁止前端由 `tb.state` 自行反推 `entryMode`**（預審 #6／P2）。
> **技術**：於 `lib/tasks.mjs` 匯出 `entryModeOf(state)` 寫入 `taskBoard.entryMode`；`lib/collect.mjs` 輸出 `taskEntryMergeSupport: true`；`ui/app.js` `oldServerBanner()` 與 `taskBoardBlock()` 同步檢查 `taskEntryMergeSupport` 與 `entryMode`（P2）。

**AC-2　案件頁軟整併為單一主力入口：有任務板時舊建議卡條件收折不搶版面、零丟失，無任務板維持原兜底** ✅ 對過 2026-11-27
> **白話**：案件頁「接下來要做什麼」只留一個主力視窗——有任務板的專案只要沒有還沒開始的舊建議卡，歷史建議卡就縮成任務板底部一條折疊收據不佔空間，點開隨時看得到全部舊卡；有還沒清完的舊卡就攤開等你處理；沒任務板的小專案照舊直接用輕量建議卡，不強迫建大板子。
> **會發生的情況**：
> 1. **`entryMode === 'task-board'`（有任務板，涵蓋 `tb.state === 'ok'` 與 `tb.state === 'empty'`）**：案件頁只畫一個「誠實任務板」主區塊，不再另起獨立的「建議新增的對話」大區塊；`taskBoardBlock(p)` 無論在 `ok`（`已歸檔` 折疊列下方）或 `empty`（空清單提示下方，**不得因 `tb.state !== 'ok'` 提早 `return` 吞掉建議卡**，預審 #4）皆共用渲染底部建議卡子區，依「是否有未開始建議卡（本專案 `open` 或他專案指過來的 `incomingSuggestions`）」分兩態呈現（與 `cardState`／`cardFolded` 同源，P2）：
>    - **0 張未開始且 0 張他專案指過來**：預設收折為單行 `<details>` 歷史折疊列（`data-fold="sg-hist|<project>"` 記憶於 `localStorage`，5 秒輪詢不重置）。有歷史卡時摘要印真實整數（`歷史建議卡（--suggest）：目前 0 張未開始 · 已收起 N 張（已開始 X、…、你說不做了 Z）`）；0 張紀錄時仍畫折疊列並標明「紀錄裡 0 張（僅列 `--suggest` 與保留期內紀錄）」，絕不整區消失（P5）。展開後完整顯示全部歷史建議卡（標題、來源、時間、對話連結、複製鈕）與保留天數誠實說明，零遺失。
>    - **仍有 ≥ 1 張未開始建議卡或他專案指過來的未開始卡**：**不可藏進預設收折列**，改以展開的「待清理建議卡（`--suggest`）」子區直接列出（含他專案指路連結、「複製說明」與「不做了」`data-dismiss` 鈕；固定附帶「僅列 `--suggest` 與保留期限（N 天）內紀錄」誠實邊界說明，即使已收起舊卡為 0 張也不缺漏，預審 #7；已收起舊卡照舊放下方折疊列），清零後自然縮回單行歷史折疊列。
> 2. **`entryMode === 'fallback'`（無任務板小專案，`unset`）**：維持原有「建議新增的對話」完整版面與全部互動（空狀態說明、保留天數、他專案指路、「這一區看不到的」、收起折疊列），僅於該區塊附一句輕量說明「還沒建立 `.agents/pipeline-tasks.json`，目前使用輕量建議卡模式」，不再於上方另佔一整塊空的「誠實任務板」大區塊。
> 3. **`entryMode === 'unknown'`（`broken`／`unreadable`／`no-main`）或舊服務降級**：同時顯示任務板錯誤／權限／舊服務提示與完整「建議新增的對話」區塊，**絕不收折隱藏建議卡**（R1）。
> 4. **對話頁 F 工地主任那一列（`directorRow`）與首頁晨報卡（`briefCard`）同步對齊**：
>    - `directorOf(p, s)` 傳入 `entryMode`（僅於具備 `taskEntryMergeSupport` 時讀取）：在 `task-board` 模式且本對話與散落未開始 `--suggest` 皆為 0 時，顯示已改用誠實任務板（仍保留「只看得到 `--suggest` 放的」但書，P5）；「細節」位置引導同步指向「誠實任務板底部的『待清理建議卡（`--suggest`）』」（預審 #5）；有任一筆歷史／未開始／散落建議卡，或非 `task-board` 模式，照實列出絕不隱藏。
>    - `briefCard()` 照印 `lib/brief.mjs` 提供的第 6 區真實總數與來源徽章文案（不自行寫死「建議卡」或只數截短後的 5 筆，預審 #2）。
> 5. 全部樣式沿用 `ui設計規格/variables.css` token 支援白天／夜間工班風格；無百分比、無綠燈背書（P10）。
> **技術**：更新 `ui/app.js` 的 `projectPage`、`taskBoardBlock`、`suggestionsBlock`（共用建議卡項目渲染，不複製兩份）、`directorOf`、`directorRow`、`briefCard` 與 `ui/ui.css`。

**AC-3　F 工地主任與工地復盤官於有任務板的專案皆改採任務板單軌運作，不再重複開 `--suggest`** ✅ 對過 2026-11-27
> **白話**：工地已經掛上大任務板，不論是主任巡檢收尾、還是復盤官盤點完要留給新對話處理的項目，都改對照任務板去重並給清單草稿等你確認，不再順手又貼 `--suggest` 小便條弄出兩套清單；還沒掛任務板的小工地照舊貼小便條；任務板壞掉或問不到時先提醒你修，絕不自作主張亂貼。
> **會發生的情況**：
> 1. 更新 `skills/director/SKILL.md`（第四步、第二步優先序 ⑦、回覆格式與 `description`）及 `skills/retrospect/SKILL.md`（第四步選項說明與第五步「留給新對話處理」流程），兩者統一先跑 `agy-pipeline --tasks` 並依中英實印字樣分三路（每條分路字樣須與 `lib/tasks.mjs` 及 `status.mjs` 輸出逐字同步，P2）：
>    - **有任務板（`共 N 項：`／`1 task total:`／`tasks total:`，或 `任務清單裡目前沒有任何任務`／`The task list is currently empty`，預審 #1）**：**不跑 `agy-pipeline --suggest` 開新建議卡**。對使用者本輪明確拍板或規格施作紀錄明寫使用者決定的新事項（守住 P7：排除對話開頭系統或他對話包入的背景摘要），先對照 `--tasks`（復盤官並照舊核對未完成規格資料夾）去重（分不出是否同一件就照實問）；未入表者只附上精簡 `.agents/pipeline-tasks.json` 任務草稿（不含手寫狀態）請使用者確認，**確認前絕不自行改寫檔案**。若 `--todo`／`--cards` 仍顯示有待清理未開始舊建議卡（含他專案指過來的），照實提醒不假裝沒有（R1）。
>    - **無任務板（`還沒建立 .agents/pipeline-tasks.json`／`hasn't set up .agents/pipeline-tasks.json yet`）**：完整維持兩支技能原有的輕量 `--suggest` 兜底流程（先 `--cards` 查重、說不做了的不再開、stdin `<<'EOF'`、上限 3 張）。
>    - **任務板異常或問不到（`設定有誤`／`讀不懂`／`結構不符`／`讀取失敗`／`沒有權限讀取`／`沒有權限存取`／`找不到主資料夾`／非 git 專案，以及完整英文對應：`has errors`、`can't be parsed`、`has an invalid structure`、`Couldn't read task list`、`No permission to read task list`、`No permission to access`、`Can't find the main folder`、`doesn't look like a git project`，預審 #8）**：照實回報原因並停下來請使用者決定，**絕不當成無任務板偷偷開 `--suggest`**（R1）。
> 2. 同步精簡更新 `rules/AGENTS.md` 任務板條目；守住兩支技能的 `description < 1,536` 字元（含全部英文觸發句）、`TERMS` 表與 `lib/lang.mjs` 逐字同步、`rules/AGENTS.md < 24,000 bytes` 且無 frontmatter。
> **技術**：更新 `skills/director/SKILL.md`、`skills/retrospect/SKILL.md`、`rules/AGENTS.md`，並於 `scripts/director.test.mjs`、`scripts/skills.test.mjs` 釘住中英單複數與完整異常字樣對照（P2）。

**AC-4　終端機 `--todo`、`--cards`、`--suggest` 與工地晨報（`--brief`）全面對齊且保留全部歷史紀錄** ✅ 對過 2026-11-27
> **白話**：停用重複的 `--suggest` 後，終端機白板跟每日晨報一樣看得到任務板上「可開工」的項目，異常或問不到的任務板也會老實亮出來不裝沒事；查舊建議卡或手動放建議卡的指令也都保留，位置與提醒文字跟看板完全一致。
> **會發生的情況**：
> 1. **`agy-pipeline --todo`（`lib/todo.mjs`）**：
>    - 專案有任務板且 `counts.ready > 0` 時列出「誠實任務板：可開工 N 項（共 M 項；跑 `agy-pipeline --tasks` 查看）」，且與有未開始建議卡一樣不收進「其他專案沒事」的 `quiet` 行。
>    - `taskBoard.state` 為 `broken`、`unreadable`、`no-main`（由共用 `isSuppressedNoMain` 排除已結案且資料夾已刪 `goneHidden` 與 90 天清空空檔 `emptyLine`，P2/P5/P8），或 `counts.unknown > 0`（`問不到／待釐清`）時，於專案段誠實列出異常／待釐清提醒且禁止收進 `quiet`（預審 #3／R1／P5）。
>    - 既有未開始建議卡（含他專案指過來的）照舊列 `cards` 行；在 `entryMode === 'task-board'` 時，位置引導對齊指向「誠實任務板底部的『待清理建議卡（`--suggest`）』」（預審 #5）。
> 2. **工地晨報（`lib/brief.mjs`：`--brief` 與首頁晨報卡共源）**：
>    - 第 6 區「可開工的待辦項目」同時收錄任務板 `可開工`（`ready`）任務與尚存未開始 `--suggest` 建議卡（維持 `BRIEF_CARD_CAP` 截短、純整數計數、連回 `#/p/<project>`，兩者皆不單獨打破 `--quiet-if-clear` 靜音）；依實際來源（僅任務板／僅建議卡／兩者並存）動態輸出區段標題、尾行 `--tasks`／`--cards` 指路，並帶出真實總筆數與徽章文案給 `ui/app.js` `briefCard()` 共用（預審 #2／P2／R3）。
>    - 若任一專案 `taskBoard.state` 為 `broken`、`unreadable`、`no-main`（排除已由 `goneHidden`／`emptyLine`／孤兒已刪資料夾警示誠實涵蓋者），或 `counts.unknown > 0`，一律納入「問不到與看不全」並打破安靜模式（預審 #3／R1）。
> 3. **`agy-pipeline --cards`（`lib/todo.mjs`）**：照常列出全部 4 種狀態歷史建議卡與跨專案待開卡（零丟失）；在 `task-board` 模式尾行附註「已建立誠實任務板，看任務請跑 `agy-pipeline --tasks`」。
> 4. **`agy-pipeline --suggest`（`lib/cliReport.mjs`）**：維持「保留寫入＋溫和提醒」——寫入事件不中斷；若該專案為 `task-board` 模式，第一行位置引導改指「誠實任務板底部的『待清理建議卡（`--suggest`）』」（預審 #5），並多印一行溫和提示（說明此專案以任務板為主力、長期工作建議列進 `.agents/pipeline-tasks.json`）；無任務板或異常時維持原輸出。
> **技術**：更新 `lib/todo.mjs`、`lib/brief.mjs`、`lib/cliReport.mjs`，全數複用 `lib/tasks.mjs` 結果，零新增 git 查詢（P2）。

**AC-5　中英雙語零殘留、零禁語，全套邊界測試與乾淨副本檢查全綠** ✅ 對過 2026-11-27
> **白話**：切英文一字不漏、沒有說謊禁語；所有情境（有板無卡、有板有舊卡、有板有跨專案卡、空任務板、無板兜底、任務檔壞掉／沒權限／無主資料夾／問不到任務、舊服務降級）都用隔離測試釘死，不碰這台電腦的真實紀錄。
> **會發生的情況**：
> 1. `lib/tasks.mjs`、`lib/todo.mjs`、`lib/brief.mjs`、`lib/cliReport.mjs`、`ui/app.js` 所有新增／調整文案採 `zhEn(中文, English)` 動態並排，通過 `scripts/lang.test.mjs` `_zhscan` 與禁語檢查。
> 2. 更新並擴充 `scripts/{tasks,ui,todo,director,brief,skills,lang}.test.mjs`（`section()` 標記 `P2`、`P5`、`P6`、`P7`、`P10`），覆蓋上述三態與 8 項預審邊界（含 `tb.total === 1` 單數英文、`tb.state === 'empty'` 仍畫建議卡子區、`v0.15.0` 舊服務缺 `taskEntryMergeSupport` 降級、`no-main` 與 `counts.unknown > 0`、`briefCard` 真實總數、真實 `ui/app.js` 渲染與 `localStorage` 摺疊鍵），`npm test` 與 `npm run test:clean` 全綠且真實 `~/.pipeline-monitor-agy/` 零殘留。
> **技術**：測試全採隔離暫存 repo 與 `AGY_PIPELINE_HOME`，不觸碰本機真實紀錄與常駐服務。

## 混沌推導

▸ **時間**：舊建議卡滿保留期限（90 天）被自動清空 → 任務板底部歷史折疊列與待清理子區皆明講「僅列 `--suggest` 與保留期內紀錄」，絕不整區消失或將 0 張講成從沒開過卡（P5）。
▸ **容量**：專案曾累積數十張歷史建議卡或超過 `BRIEF_CARD_CAP` 項可開工項目 → 任務板無未開始卡時預設收折為單行 `<details>` 並記於 `localStorage`（5 秒輪詢不重置）；晨報第 6 區守上限截短並由 `brief.mjs` 帶出真實總數給終端機與 `briefCard()` 共用（P2／R3）。
▸ **併發**：主資料夾剛建好 `.agents/pipeline-tasks.json` 但常駐儀表板仍跑 `v0.15.0` 未 `--serve-restart`，或對話位於與主資料夾不同步的 worktree → 入口模式一律讀主資料夾並以 `taskEntryMergeSupport`＋`entryMode` 雙重把關，舊服務時期誠實於頁頂與任務板區塊提示重啟、維持建議卡完整展開、不於前端反推模式（P2）。
▸ **權限憑證**：`.agents/pipeline-tasks.json` 無讀取權限（`EPERM`/`EACCES`）、沙盒擋 `~/.pipeline-monitor-agy/`（`沒有權限存取`）或找不到主資料夾（`no-main`）→ `entryMode` 為 `unknown`，看板與 `--todo`/`--brief` 誠實呈現異常且打破安靜模式、不收折建議卡，F 主任與復盤官絕不當成無任務板偷開 `--suggest`（R1）。
▸ **輸入畸形**：任務檔 JSON 損壞／循環相依、空清單 `tasks: []` 仍有舊卡、`counts.unknown > 0`、建議卡缺欄位、或本專案 0 卡但別的專案有未開始 `incomingSuggestions` → 壞檔歸 `unknown` 不拖垮整頁且不藏建議卡；`empty` 照畫底部建議卡子區不早退；缺欄位不洩漏 `undefined`/`null`；跨專案指過來的未開始卡強制展開指路且附誠實邊界說明（P5／P6）。

## 已拍板（2026-11-27，Oscar 確認）

1. **案件頁「還差什麼」白板（做法 A）**：維持獨立不併入本輪，繼續承載專案級警示與未入表臨時對話。
2. **空清單 `tasks: []`（`empty`）**：歸為 `task-board` 模式（無未開始舊卡時收折為歷史折疊列、F 主任與復盤官不開 `--suggest`），並修正 `taskBoardBlock` 不在 `empty` 分支提早 `return` 吞掉建議卡。
3. **工地復盤官（`skills/retrospect/SKILL.md`）**：本輪同步納入 AC-3，有任務板的專案改提 `.agents/pipeline-tasks.json` 任務草稿，不再重複開 `--suggest`；無任務板維持原 `--suggest` 兜底。
4. **終端機 `--suggest`**：採「保留寫入＋溫和提醒」，有任務板專案第一行對齊指向任務板底部「待清理建議卡（`--suggest`）」並提示長期工作改列任務清單。
5. **獨立規格預審 8 條補強全數納入**：涵蓋英文單數 `1 task total:`、`brief.mjs`/`briefCard()` 動態來源與真實總數、`no-main`/`counts.unknown > 0` 打破安靜、`empty` 不早退吞卡、`cardsLine`/`directorRow`/`doSuggest` 區名同步、`v0.15.0` 舊服務 `taskEntryMergeSupport` 降級禁前端反推、待清理子區固定保留天數邊界說明，以及沙盒 `沒有權限存取` 與 `lib/tasks.mjs` 完整英文異常片語。

## 明確不做

- **不動案件頁「還差什麼」白板（`whiteboard`）與對話清單（`sessionList`）的獨立結構**：已拍板做法 A，白板繼續承載專案級警示（`main` 未推、衝突、感測器）與未入表臨時對話；若日後需進一步聯動再另開規格。
- **不刪除或遷移 `~/.pipeline-monitor-agy/logs/*.jsonl` 裡任何歷史 `suggestion`／`suggestion_dismissed` 事件，也不移除 `--suggest`、`--cards` 指令與 `/api/suggest-dismiss` 端點**。
- **不讓儀表板網頁、F 工地主任或工地復盤官在使用者確認前自動改寫 `.agents/pipeline-tasks.json`**。
- **不改動五支生命週期 hook（`hook.sh`、`guard.*`、`escalate.*`、`gate.*`、`remind.sh`）與 `stages.json` 關卡數量**。
- **不做「把舊 `--suggest` 卡自動轉換寫入任務板 JSON」的批次遷移工具，亦不加入百分比進度條或綠燈背書**。

## 施作紀錄

### 2026-11-27　階段 A（規格與預審）＋ 階段 B（程式實作與測試）

- **階段 A 與規格預審**：完成本規格撰寫與獨立 `research` 子 agent 一輪 `spec-precheck`（記 `--precheck found` 8 條補強）。經 Oscar 確認採用做法 A、拍板 3 項使用習慣並「開工」後，將規格由 `docs/規劃中/` 搬至 `docs/進行中/`，更新 [AGENTS.md](../../AGENTS.md) 索引並執行 `--report A ok`。
- **階段 B 完成項目**：
  - **三態入口與伺服器標記**：於 [lib/tasks.mjs](../../lib/tasks.mjs) 匯出 `entryModeOf(state)` 並併入 `deriveTaskBoard()` 回傳 `entryMode`（`task-board`／`fallback`／`unknown`），於 [lib/collect.mjs](../../lib/collect.mjs) 附帶 `taskEntryMergeSupport: true`。
  - **終端機 `--todo`、`--cards`、`--suggest` 與工地晨報對齊**：更新 [lib/todo.mjs](../../lib/todo.mjs)（`tasksLine`、`cardsLine` 新位置引導、`--cards` 尾行提醒與 `broken`/`unreadable`/`no-main`/`counts.unknown` 不入 `quiet`）、[lib/brief.mjs](../../lib/brief.mjs)（第 6 區收錄任務板 `ready` 任務並輸出真實總數與動態 `badge`，異常／`unknown` 打破靜音）、及 [lib/cliReport.mjs](../../lib/cliReport.mjs)（`doSuggest` 於有任務板保留寫入＋溫和提醒並改指待清理子區）。
  - **案件頁軟整併與對話頁 F 列同步**：更新 [ui/app.js](../../ui/app.js) 與 [ui/ui.css](../../ui/ui.css)（`oldServerBanner` 納檢 `taskEntryMergeSupport`、`serverEntryMode` 嚴禁前端反推、`taskBoardBlock` 於 `ok`/`empty` 不早退共用 `suggestionsBlock({ embedded: true })`、0 未開始卡預設收折為 `sg-hist|<project>` 折疊列、有未開始或跨專案卡強制展開待清理子區並附保留期限說明、`fallback` 輕量單區塊、`unknown` 雙區塊不收折、`directorOf`/`directorRow` 與 `briefCard` 真實總數對齊）。
  - **雙技能與常駐規則單軌同步**：更新 [skills/director/SKILL.md](../../skills/director/SKILL.md)、[skills/retrospect/SKILL.md](../../skills/retrospect/SKILL.md) 與 [rules/AGENTS.md](../../rules/AGENTS.md)，統一先跑 `--tasks` 依中英單複數與完整異常字樣分三路，有任務板改提任務草稿不開 `--suggest`、無任務板維持 `--suggest`、異常不偷開。
  - **測試與驗收對條**：擴充 [scripts/tasks.test.mjs](../../scripts/tasks.test.mjs)、[scripts/ui.test.mjs](../../scripts/ui.test.mjs)、[scripts/todo.test.mjs](../../scripts/todo.test.mjs)、[scripts/brief.test.mjs](../../scripts/brief.test.mjs)、[scripts/director.test.mjs](../../scripts/director.test.mjs)、[scripts/skills.test.mjs](../../scripts/skills.test.mjs) 與 [scripts/lang.test.mjs](../../scripts/lang.test.mjs)，並於本規格對過 AC-1 ～ AC-5；執行 `npm test`（38/38 支測試檔）與 `npm run test:clean` 均檢查全綠，真實紀錄隔離未動到 `~/.pipeline-monitor-agy/`。
  - **暫停待定事項**：升版（預計 `v0.16.0`，動到危險清單上的 `plugin.json`）與搬往 `docs/升級摘要/` 依規定保留待階段 C（打掃）與階段 D（魔鬼教官）審查後執行。

### 2026-11-27　階段 D 第 1 輪修補（`no-main` 誤報邊界）

- **第 1 輪發現並修補**：`lib/brief.mjs` 與 `lib/todo.mjs` 原先對所有 `taskBoard.state === 'no-main'` 無條件告警並移出安靜列，導致已結案且資料夾已刪（`goneHidden`）的舊專案永久打破 `--brief --quiet-if-clear`、以及 90 天清空空檔（`emptyLine`）／孤兒已刪資料夾在無 `mainRoot` 時重複或誤報任務板異常（`P2/P5/P8`）。
- **修法**：於 [lib/tasks.mjs](../../lib/tasks.mjs) 匯出共用 `isSuppressedNoMain(p)` 並在 [lib/todo.mjs](../../lib/todo.mjs) 與 [lib/brief.mjs](../../lib/brief.mjs) 共用（同時於 `brief.mjs` 排除已有「找不到還在的資料夾」孤兒警示者），保留 `broken`、`unreadable`、`counts.unknown > 0` 與仍有未結案／活卡的 `no-main` 一律照常告警；於 [scripts/tasks.test.mjs](../../scripts/tasks.test.mjs)、[scripts/brief.test.mjs](../../scripts/brief.test.mjs) 與 [scripts/todo.test.mjs](../../scripts/todo.test.mjs) 補真實 `collectAll()` 回歸測試，依規範修完停手並先問人決定後續。

### 2026-11-27　階段 C（打掃）與升版 v0.16.0 歸檔

- **階段 C（打掃，`--report C ok`）**：依 `--round C` 檢查本輪程式區改動檔，確認零未使用 import／變數、零死碼與零同檔字面重複；7 支測試檔保持唯讀未動，記下 0 項改動與 2 條跨檔案／跨路徑建議。
- **升版與規格歸檔**：依 Oscar 確認開始收尾升版，更新 `package.json` 與 `plugin.json` 至 `v0.16.0`，將本規格從 `docs/進行中/` 歸檔至 `docs/升級摘要/`，並同步更新 [AGENTS.md](../../AGENTS.md) 索引與 [docs/ROADMAP.md](../ROADMAP.md) 里程碑表；升版搬檔後執行最終階段 D（魔鬼教官）第 2 輪審查。
- **上線版本：v0.16.0**
