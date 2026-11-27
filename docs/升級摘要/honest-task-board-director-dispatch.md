# 功能：誠實任務板＋F 主任調度整合＋新版 Antigravity ROADMAP

分級：預測至少 **T2**（因為結案升版會動到危險清單上的 `plugin.json`；預計新增 `lib/tasks.mjs`、`lib/cliDispatch.mjs` 與測試 `scripts/tasks.test.mjs`、`scripts/dispatch.test.mjs`，並修改程式區的 `status.mjs`、`lib/cliWrap.mjs`、`lib/cliTodo.mjs`、`lib/collect.mjs`、`lib/rounds.mjs`、`server.mjs`、`ui/app.js`、`ui/ui.css`、`skills/director/SKILL.md`、`rules/AGENTS.md`，以及文件 `docs/ROADMAP.md`、`README.md`、`AGENTS.md`、`package.json` 與測試 `scripts/{ui,director,wrap,skills,lang}.test.mjs`——新增的 `lib/tasks.mjs` 與 `lib/cliDispatch.mjs` 落在 `tiers.code` 底下，施工收尾時須由你判斷要不要加入危險清單）。T2 要求 A、C、D 與補測試（涉及看板改動，完工後可選跑 E 驗收）。

> 2026-11-27 規劃（依總進度追蹤對話 2026-11-26 Oscar 原話「照順序執行，幫我規劃並開建議對話卡片」開立；納入獨立規格預審 8 條補強與 3 項設計拍板後，於 Oscar 確認「照建議開工」搬入 `docs/進行中/` 施工；`main` 目前在 `v0.14.1`）。
> 階段 0 本機實機查證摘要（2026-11-27 實測，`ANTIGRAVITY_PROJECT_ID=8e21ee51-7c43-4edf-88fb-e3d500cf41d8`，基準 13 個 worktree）：
> 1. **A0（空白 `CreateConversation` 只帶 `projectId`、`UpdateConversation` 命名／歸檔）**：回傳 HTTP 200，`metadata` 不含 `environmentId`；`UpdateConversation` 設定 `annotations.title` 與 `annotations.archived: true` 均成功，`GetConversation` 與 `ListConversations`（`includeArchived: false` 隱藏、`true` 顯示）驗證通過。
> 2. **A1（無工具探針 `prompt`、只帶 `projectId`、省略 `environmentId`）**：回傳 HTTP 200、`metadata` 無 `environmentId`、未新建 worktree（維持 13）；探針轉錄檔回報 `Active Workspaces` 與 `Command Working Directory` 皆落於**主資料夾**（`/Users/oscarhsieh/Desktop/pipeline-monitor for antigravty`），且 `PreInvocation` 照常在主資料夾寫入 1 筆 `tier_notified` 事件。
> 3. **B（同探針、帶 `projectId`＋目前對話 `environmentId`）**：回傳 HTTP 200、未新建 worktree，探針轉錄檔回報**直接共用目前對話的同一個 worktree**（`.../antigravity_roadmap_spec_dispatch`）。
> 4. **清理與架構結論**：三筆皆以 `DeleteConversation`（HTTP 200 `{}`）刪除並確認 `ListConversations(includeArchived: true)` 殘留 `0`、worktree 維持 13。因 `CreateConversation` **不會**自動建獨立 worktree（不帶 `environmentId` 開在主資料夾、帶了會與舊對話撞在同一個 worktree），`--wrap dispatch` 必須省略 `environmentId`，且開工前必檢主資料夾在 `main`／`master`、0 未存檔、無其他未結案對話正在主資料夾活動，並於確認卡與純文字確認明講新對話會開在主資料夾與型號規則。
> 讀了：`AGENTS.md`、`README.md`、`docs/ROADMAP.md`、`docs/DESIGN.md`、`docs/FAILURE-PATTERNS.md`、`docs/LESSONS.md`（標題目錄）、`.agents/pipeline-stages.json`、`stages.json`、`plugin.json`、`package.json`、`rules/AGENTS.md`、`status.mjs`、`server.mjs`、`lib/{cliWrap,cliTodo,cliReport,todo,collect,rounds,checklist,history,git,lang}.mjs`、`ui/app.js`、`skills/{spec,spec-precheck,director}/SKILL.md`、Antigravity 內建 `conversations` 技能、`docs/升級摘要/{antigravity-v01-foundation,dashboard-brief-card,legacy-spec-lookup,retrospect-skill}.md`、`scripts/{docsIndex,skills,director,wrap}.test.mjs` 及 `agy-pipeline --context` 反查結果。找不到 `docs/SPEC-TEMPLATE.md`（沿用既定最小格式）。

## 這是為了解決什麼

解決多份規格與多 worktree 並進時看不清任務相依與真實進展、以及 F 工地主任只能在對話裡出建議卡而無法在人確認後直接派工開新對話或清理已合併舊 worktree／歸檔舊對話的痛點，同時將過時的 `docs/ROADMAP.md` 翻新為 Antigravity 專用版。

## 驗收條件

**AC-1　專案輕量任務清單與 6 欄狀態 100% 由真實事實推導，終端機與網頁共用單一真相來源** ✅ 對過 2026-11-27
> **白話**：專案放一張極輕量的「工地工作清單」（只寫誰先誰後、對應哪份規格檔名），每張卡片落在「鎖定中／可開工／等點頭／施工中／只剩收尾／已歸檔」哪一欄，全靠檔案、git 分支與對話紀錄當場推算，絕不手填狀態或百分比；終端機與看板永遠講同一套事實。
> **會發生的情況**：
> 1. 任務定義檔讀主資料夾 `.agents/pipeline-tasks.json`（相容 `.claude/pipeline-tasks.json`），僅存宣告欄位 `tasks: [{ id, title, epic?, spec?, dependsOn?, prompt?, model? }]`（`spec` 僅寫檔名／slug，統一剝除尾端 `.md` 且拒收 `/`、`\`、`..` 防搬家過期；忽略任何手寫 `status`/`column`/`percent`/`progress`/`done`/`completedAt` 並附誠實提醒）。設定呈五態：`no-main`（找不到主資料夾，不折成沒設定，R1）、`unset`（無檔）、`ok`（空陣列 `tasks: []` 明確講清單為空，P5）、`broken`（壞 JSON、重複或空白 ID、非法 `spec`、指到不存在 `dependsOn` 或循環相依，逐條講明問題且不拖垮整頁 L37）、`unreadable`（權限錯誤）。
> 2. 6 欄狀態（另加誠實兜底「問不到／待釐清」）即時推導（同時認 `main`/`master` 主線，P8）：`已歸檔` 須主線已 commit `docs/升級摘要/<slug>.md` 或 `docs/done/<slug>.md`（每專案只跑一次 `git ls-tree`，回 `null` 或無主線時依賴主線之任務標為 `問不到／待釐清`，R1／P5）且所有關聯對話／工作區無未存、未併或 `unknown` 項目（**已結案且 `card.gone` 已清理不阻擋 `已歸檔`**，未結案 `gone` 或在線 `dirty===null`/`merge==='unknown'` 標 `問不到／待釐清`），僅 `已歸檔` 解鎖下游 `dependsOn`（未設 `spec` 者明標無法自動歸檔解鎖）；關聯對話統一以 `s.stages` A 關（`link`/`specPlace`/`specPlaces`/`checklist`）、`task_dispatched`、活 worktree 規格與 `prompt` `startMatch` 單一來源配對（P2）；活工作區／對話狀態優先於主線未刪的 `規劃中/` 舊檔（預審 #4）：`只剩收尾` 與 F 主任白板 `call`/`clear`/已結案未存未併一致；`施工與檢查中` 為進行中規格、活 worktree、已過點頭或待工具事件的 `task_dispatched`；`規格等點頭` 為規劃中規格或白板 `hold`；`鎖定中` 為前置未歸檔且未動工（若已提前動工，照實畫在實際進度欄並掛 `⚠️ 前置任務 ... 尚未併入 <mainRef> 歸檔` 警示）。
> 3. 新增唯讀指令 `agy-pipeline --tasks`（於 git 專案執行，與 `todoBoard`／看板共用同一組推導與中英文案；若當前 worktree 的任務檔與主資料夾不同步另附誠實提醒）。
> **技術**：新增 `lib/tasks.mjs`（匯出 `COLUMNS`、`columnLabel`、`normSpecSlug`、`readTasksConfig`、`dispatchesOf`、`deriveTaskBoard`、`formatTasksLines`、`doTasks`），於 `status.mjs` 分派 `--tasks`；在 `lib/rounds.mjs` 匯出 `startMatch` 共用；複用 `lib/todo.mjs` 的 `todoBoard` 結果、`lib/git.mjs` 單次 `gitRaw(['-c','core.quotepath=false','ls-tree',...])` 與 `lib/lang.mjs` `zhEn`／`specDirNames`（P2／P5／P8／R1）。

**AC-2　儀表板案件頁「誠實任務板」純檢視＋一鍵複製，不存百分比、不畫綠燈、不放直開按鈕** ✅ 對過 2026-11-27
> **白話**：打開任何專案的案件頁，多一塊「誠實任務板」按 6 個真實階段把任務排好，只數幾張卡、寫清楚為什麼算在這一欄；想開工點一下「複製交辦」就能貼進新對話或請 F 主任派工，網頁自己不偷存憑證也不替你亂開對話。
> **會發生的情況**：
> 1. 案件頁 `#/p/<project>` 在白板旁呈現任務板：各欄只印真實整數筆數與總數（絕無 `%` 進度條或假門檻）；卡片顯示 ID、Epic（如有）、標題、推導依據一句話、警示、關聯對話連結（如有）及由 `lib/tasks.mjs` 統一生成的開工交辦文案與 `複製開工交辦`（`data-copy`）按鈕（缺 `prompt` 時提供預設模板；`鎖定中` 卡片註明前置未解鎖警告與區別字樣；`已歸檔` 不顯示開工複製鈕，預審 #8），並註明「網頁不直接開對話，可複製貼入新對話或於對話內請 F 主任派工」。
> 2. `已歸檔` 欄預設收合並記憶於 `localStorage`（5 秒自動刷新不重置）；`no-main`／`unset`／`unreadable`／`broken`／空陣列各自照實顯示，絕不用綠色光暈或打勾替「可開工／已歸檔」背書（R2／P10）。
> 3. 樣式全吃 `ui設計規格/variables.css` token 支援白天／夜間工班風格；`lib/collect.mjs` 併入專案 `taskBoard` 與 `taskBoardSupport: true`，`ui/app.js` `oldServerBanner()` 納入檢查，服務未 `--serve-restart` 時任務板區塊與頁頂皆顯示 `OLD_LINE`／舊服務提示（預審 #8）。
> **技術**：擴充 `lib/collect.mjs`、`lib/cliTodo.mjs`、`server.mjs`（零 CSRF token 落地、不新增開對話 POST 端點）、`ui/app.js` 與 `ui/ui.css`。

**AC-3　F 工地主任在對話內經人確認後真派工：開新對話、自動命名並依實測防撞車** ✅ 對過 2026-11-27
> **白話**：當一張卡的先行任務都已併進主線解鎖後，在對話裡叫 F 主任，主任先用選項卡或純文字問清楚；只有你點頭確認後，主任才真的替下一張任務開好新對話、取好名字並把交辦塞進去，而且絕不跟別的進行中對話擠在同一個資料夾撞車。
> **會發生的情況**：
> 1. 新增帶目標的 `--wrap` 步驟 `agy-pipeline --wrap dispatch <taskId> "<原話>"`：`doWrap` 依步驟類型分流固定位置引數（`merge|push|restart|stamp` 無目標、`dispatch|clean-worktree|archive` 帶 `<target>` 防止含空白路徑污染 `<原話>`），並於 `wrap` 事件與 `triedBefore` 加入正規化 `target` 鍵，使一句話可確認多筆不同目標但對同一目標仍擋重試（預審 #1／P2／P6／P7）。
> 2. 派工前必驗：環境變數 `ANTIGRAVITY_LS_ADDRESS`、`ANTIGRAVITY_CSRF_TOKEN`、`ANTIGRAVITY_PROJECT_ID` 齊全（缺一即 `沒做`，R1）；目標 `<taskId>` 在任務板為 `可開工`（其餘狀態一律 `沒做`）；投影防盲區必驗專案未退出記錄（`optedOut`）且感測器未故障／未掛載（預審 #2）；依階段 0 實測結果，呼叫 `CreateConversation` **必須省略 `environmentId`**（開在主資料夾），故必驗主資料夾目前位於 `main`/`master`、未存／未追蹤檔數為 `0`、經路徑歸一（含子目錄與 symlink）無其他未結案對話或未收尾 `task_dispatched` 占著主資料夾，且同時呼叫 `ListConversations` 確認主資料夾無活躍對話（任一不成立或 LS 列表問不到皆 `沒做`，預審 #2／#3）。無論透過 `ask_question` 選項卡或純文字詢問，皆須明講「新對話將開在主資料夾」及型號規則（`task.model` 有設定才傳入，未設定則省略並明講「未指定型號，沿用 Antigravity 預設」，預審 #6）。
> 3. 呼叫 `ConversationService/CreateConversation` 建立並命名對話後，必再呼叫 `GetConversation` 讀回驗證對話存在且標題相符（必要時補 `UpdateConversation` 重讀）。只要 `CreateConversation` 已回傳有效 `conversationId`，無論後續命名或讀回是否成功，**一律** append-only 寫入 `event: 'task_dispatched'`（附 `conversationId` 與 `verified: boolean`，零 token）並印出該 ID；讀回成功才回 `成了`（R2），命名或讀回失敗則回 `沒成`／`問不到` 並警示主資料夾已建立該對話勿重複派工（預審 #7）。
> **技術**：新增 `lib/cliDispatch.mjs` 並掛入 `lib/cliWrap.mjs`（`STEPS` 擴充 `dispatch`），`lib/collect.mjs` 匯出 `buildPathCanonicalizer` 與 `applyCwdCanon` 共用；所有錯誤與紀錄皆遮罩並禁止寫入或印出 `ANTIGRAVITY_CSRF_TOKEN`（P2／P7／P13）。

**AC-4　F 工地主任收尾併回主線後，經人確認可選清理已合併舊 worktree 與歸檔已結案對話** ✅ 對過 2026-11-27
> **白話**：事情做完併回主線後，工地留著的舊工作資料夾和側邊欄已完成對話常常越積越多；主任收尾問題可附上可選項目，只有你點頭確認，才安全撤掉「確定已經全部存好併進主線、且不是自己正在站著的」舊工作資料夾（若附帶已合併本地分支則一併安全移除），以及歸檔「已經按結案」的舊對話。
> **會發生的情況**：
> 1. 新增 `agy-pipeline --wrap clean-worktree <path|branch> "<原話>"`：於主資料夾從 `git worktree list --porcelain` 名冊核對目標（以 `real()` 比對路徑或精準匹配分支），確認非 `mainRoot`、非本對話當前 `cwd`、資料夾存在、未存與未追蹤檔數為 `0`（P1）、`git merge-base --is-ancestor <wtHead> <mainRef>` 已併入主線、且經路徑歸一後該 worktree（含子目錄）無其他未結案對話（預審 #2）；以非強制 `git worktree remove`（嚴禁 `--force`）移除後重查名冊與 `!existsSync` 確認消失才講「成了」（R2），若原分支非主線且未在其他 worktree 檢出則嘗試安全 `git branch -d`（嚴禁 `-D`）並分開回報結果。
> 2. 新增 `agy-pipeline --wrap archive <conversationId> "<原話>"`：驗齊環境憑證與 `GetConversation` 確認對話存在、同 `projectId` 且尚未歸檔（已歸檔回 `不用`）；複用 `collectAll`／`sessionsOf` 驗證該對話在儀表板紀錄**已按結案**（`closedAt !== null`，排除結案後復工者，預審 #5；絕不代人按結案）；資料安全檢查明確區分「工作區已不存在（例如剛清掉 worktree）或已換手 `movedOn` → 放行」與「工作區仍在磁碟 → 必驗未存檔數為 `0` 且分支已併入主線，任一問不到即 `沒做`」（預審 #5）；呼叫 `UpdateConversation` 設 `annotations.archived: true` 後再以 `GetConversation` 讀回確認 `archived === true` 才講「成了」（R2）。
> 3. 更新 `skills/director/SKILL.md`（同步讀 `--todo` 與 `--tasks`、收尾與開工派工合流為單一精簡問題與 `ask_question` 選項卡、明講「開在主資料夾」與型號規則、嚴禁自動替人執行、維持 `description < 1,536` 字元與 `TERMS` 同步）及 `rules/AGENTS.md`（守住 `< 24,000 bytes`）。
> **技術**：擴充 `lib/cliDispatch.mjs`、`lib/cliWrap.mjs`、`skills/director/SKILL.md`、`rules/AGENTS.md`。

**AC-5　重寫過期的 `docs/ROADMAP.md` 為 Antigravity 專用版** ✅ 對過 2026-11-27
> **白話**：把還停留在早期 Claude Code 構想的總路線圖整個翻新，照實寫清楚 Antigravity 專用版從 v0.1 一路蓋到 v0.14.1 的每一棟樓、接下來的任務板與主任調度方向、以及還只是「想到還沒點頭」的探索點子。
> **會發生的情況**：
> 1. 重寫 `docs/ROADMAP.md`：保留三條紅線、V1–V6 死法、四級誠實功能地圖與明確不做原則；移除過時的 Claude Code 專用敘述（僅留一句歷史分叉脈絡）；完整整理 `v0.1.0`～`v0.14.1` 已上線里程碑並連向對應 `docs/升級摘要/*.md`（絕不指向 `規劃中/` 或 `進行中/`，P2）；列出本規格目標與後續探索方向並明確標註「探索方向、未點頭不算規格」。
> 2. 通過 `scripts/docsIndex.test.mjs` 全部檢查（文件索引雙向吻合、所有 `.md` 相對連結皆實存）。
> **技術**：更新 `docs/ROADMAP.md`、`README.md` 與 `AGENTS.md` 索引。

**AC-6　中英雙語與全套邊界測試齊備，絕不碰真實 Antigravity 對話與真實家目錄** ✅ 對過 2026-11-27
> **白話**：中英文切換零殘留、零禁語；所有新功能都用假的本機服務與暫存 repo 把成功、失敗、防呆邊界全部測過一遍，跑測試時絕不打真實 Antigravity API、也不會把這台電腦的真實紀錄或 worktree 弄亂。
> **會發生的情況**：
> 1. `lib/tasks.mjs`、`lib/cliDispatch.mjs`、`lib/cliWrap.mjs`、`ui/app.js` 所有使用者文案採 `zhEn(中文, English)` 動態並排，通過 `scripts/lang.test.mjs` `_zhscan` 與禁語檢查；雙語輸出皆守住三條紅線。
> 2. 新增 `scripts/tasks.test.mjs` 與 `scripts/dispatch.test.mjs`（`section()` 標記 `P1`、`P2`、`P3`、`P5`、`P6`、`P7`、`P8`、`P10`、`P11`、`P13`），以本機 mock HTTP server 與隔離暫存 repo／假家目錄覆蓋：5 態任務設定檔、循環相依／壞 slug／忽略手寫狀態、6 欄＋`unknown` 推導（含 `master` 分支、已結案且 `gone` 不阻擋歸檔、活 worktree 優先於主線舊檔、提前動工警示、`ls-tree` 失敗）、`dispatch` 省略 `environmentId`／主資料夾撞車／`optedOut`／LS 錯誤阻擋、部分失敗仍記 `task_dispatched` 印 ID、token 零落地／零洩漏、`clean-worktree` 擋髒檔／未追蹤新檔／未合併／主資料夾／目前 worktree 與安全 `branch -d`、`archive` 擋未結案／復工／跨專案與放行已清 worktree、帶目標 `triedBefore` 單次防護、以及 ZH/EN 雙語；同步更新 `scripts/{ui,director,wrap,skills,lang}.test.mjs`。`npm test` 與 `npm run test:clean` 全綠且真實 `~/.pipeline-monitor-agy/` 零殘留。
> **技術**：測試以 `node:http` 本機 mock server 與 `makeRepo`／`AGY_PIPELINE_HOME` 完全隔離，零真實 LS 呼叫（P8）。

## 混沌推導

▸ **網路／本機服務**：`ANTIGRAVITY_LS_ADDRESS` 未啟動、連線逾時、回傳 HTTP 401/403/500 或缺環境變數 → 先驗證再呼叫，失敗或無法從 `GetConversation` 讀回確認時誠實回報 `沒做`／`沒成`／`問不到` 並遮罩憑證；若 `CreateConversation` 已成功建出對話但後續讀回失敗，仍記錄 `task_dispatched`（`verified: false`）與對話 ID 防撞車（R1／R2）。
▸ **時間**：worktree 已寫完規格或已 `commit` 但尚未併進主線，或乾淨副本所有檔案 `mtime` 相同 → 歸檔與解鎖只看主線（`main`/`master`）的 `git ls-tree`（不看 worktree 本地檔案也不看 `mtime`），避免未併入主線就提前解鎖下游（P8／P9）。
▸ **容量**：專案累積數十筆已歸檔任務與大量對話 → 每專案只執行一次 `git ls-tree` 且 `ui/app.js` 預設收合已歸檔欄並記憶於 `localStorage`（5 秒輪詢不重置）。
▸ **併發**：① 階段 0 已證實省略 `environmentId` 會開在主資料夾，若主資料夾不乾淨或已有活躍對話（含感測器未記到工具事件的新對話或專案退出記錄）將發生撞車 → `dispatch` 開工前必檢感測器啟用、主資料夾位於主線、0 未存檔、無活躍對話與 `ListConversations` 無主資料夾執行中對話；② 單句話確認多個不同目標（如清兩個 worktree）→ `triedBefore` 納入正規化 `target` 鍵不誤擋，同一目標仍擋重試；③ 上游未歸檔就提前開工 → 實話掛在實際階段欄並印出警示（P6）。
▸ **權限憑證**：`ANTIGRAVITY_CSRF_TOKEN` 屬於暫時會話憑證 → 只於 `status.mjs` 執行期從環境變數讀取、記憶體傳遞給 `ConversationService`，絕不寫入 `~/.pipeline-monitor-agy/` 任何檔案、事件紀錄或錯誤輸出；讀任務檔遇 `EPERM`/`EACCES` 誠實報 `unreadable`（R1）。
▸ **輸入畸形**：壞 JSON、重複任務 ID、循環 `dependsOn`、`spec` 含 `/` 或 `..`、手寫偽造 `status: "done"`、`clean-worktree` 傳入 `mainRoot` 或自己正站著的 `cwd`、含空白路徑污染 `<原話>`、系統包裝文字 `prompt_wrap` 冒充原話 → 設定檔報 `broken`、忽略手寫狀態、`doWrap` 依步驟分流引數、非法路徑與危險目標全數拒絕並回報原因（P4／P7／P13）。

## 已拍板（2026-11-27，Oscar 確認開工）

1. **任務清單位置與欄位**：置於主資料夾 `.agents/pipeline-tasks.json`（相容 `.claude/pipeline-tasks.json`），採極輕量欄位 `{ id, title, epic?, spec?, dependsOn?, prompt?, model? }`，`spec` 只寫檔名／slug，不存任何狀態或百分比。
2. **`dispatch` 型號與 `clean-worktree` 分支**：`dispatch` 僅在任務檔有填 `model` 時傳入，否則省略並於確認卡與純文字確認皆明講開在主資料夾及沿用預設；`clean-worktree` 移除已合併舊 worktree 後若原分支非主線且未在其他工作區檢出，嘗試安全 `git branch -d`（嚴禁 `-D`）並分開回報結果。
3. **規格預審 8 條補強全數納入**：① `doWrap` 依步驟類型分流固定位置引數並於 `triedBefore` 加入 `target` 鍵；② 活躍對話比對走與 `collectAll` 一致的 `gitContext` 路徑歸一，且 `dispatch` 兼查 `optedOut`、感測器、未發事件 `task_dispatched` 與 `ListConversations`；③ 主分支同時認 `main`/`master`，補上 `no-main` 設定態與 `ls-tree` 失敗之 `問不到／待釐清`；④ 以 `s.stages` A 關為單一「任務↔對話」歸屬來源、統一剝除 `.md`、區分「已結案且 `gone`」與「在線問不到」、活工作區／對話優先於主線舊 `規劃中/`；⑤ `--wrap archive` 複用 `sessionsOf` 驗 `closedAt` 並區分工作區已移除與 `dirty === null`；⑥ 明確 `task.model` 單一來源與純文字確認路徑明講要求；⑦ `CreateConversation` 回傳有效 ID 後一律記 `task_dispatched`（標 `verified`）防隱形撞車；⑧ 舊服務無 `taskBoardSupport` 時任務板區塊顯示 `OLD_LINE`，並由 `lib/tasks.mjs` 統一生成缺省 `prompt` 模板與區別 `鎖定中`/`已歸檔` 按鈕。

## 明確不做

- **不把 `ANTIGRAVITY_CSRF_TOKEN` 寫入磁碟給 `server.mjs` 或背景服務使用**：token 僅限對話內 CLI 執行期使用，守住本機憑證安全與避開 `launchd` P3 大坑。
- **不在儀表板網頁放「一鍵直開對話」「刪 worktree」「歸檔對話」寫入按鈕**：網頁任務板維持純檢視＋複製交辦文案。
- **不做 MCP App 側邊欄或引入任何外部 npm 相依**：守住零相依與輕量架構。
- **不做無人值守自動寫碼、自動合併、自動派工、自動刪 worktree（或 `--force`／`git branch -D`）或自動歸檔對話**：所有狀態變更操作一律須經人類透過 `ask_question` 或對話原話確認後方可執行單步。
- **不在任務設定檔存進度百分比、時間估計或任何可手改的狀態欄位，亦不改動五支 hook（`hook.sh`、`guard.*`、`escalate.*`、`gate.*`、`remind.sh`）與 `stages.json` 關卡數量**。

## 施作紀錄

### 2026-11-27　階段 A（規格與預審）＋ 階段 B（程式實作與測試）

- **階段 A 與規格預審**：完成本機 `ConversationService` 階段 0 實測（證實 `CreateConversation` 省略 `environmentId` 開在主資料夾、帶入會共用原 worktree），撰寫一頁規格並請獨立 `research` 子 agent 跑過一輪 `spec-precheck`（補充 8 條補強）。經 Oscar 回覆「照建議開工」後，將規格由 `docs/規劃中/` 搬至 `docs/進行中/`，更新 [AGENTS.md](../../AGENTS.md) 索引並執行 `agy-pipeline --spec` 與 `--report A ok`。
- **階段 B 完成項目**：
  - **誠實任務板推導與 `--tasks`**：新增 [lib/tasks.mjs](../../lib/tasks.mjs)（`no-main`/`unset`/`unreadable`/`broken`/`ok` 五態、`normSpecSlug`、單次 `git ls-tree` 支援 `main`/`master`、6 欄＋`unknown` 即時推導、環狀相依檢測與統一交辦模板），並在 [lib/rounds.mjs](../../lib/rounds.mjs) 匯出 `startMatch`、[lib/collect.mjs](../../lib/collect.mjs) 併入 `taskBoard` 與 `taskBoardSupport: true`、[lib/cliTodo.mjs](../../lib/cliTodo.mjs) 與 [status.mjs](../../status.mjs) 接入 `--tasks`。
  - **看板案件頁任務板卡片與雙語**：更新 [ui/app.js](../../ui/app.js) 與 [ui/ui.css](../../ui/ui.css)，於 `#/p/<project>` 加入 `taskBoardBlock(p)`（純整數計數、摺疊 `已歸檔` 與 `localStorage` 記憶、零 `%`、零綠燈背書、支援舊服務 `OLD_LINE` 提醒與日間／夜間工班配色 token）。
  - **F 主任對話內派工／清理／歸檔**：新增 [lib/cliDispatch.mjs](../../lib/cliDispatch.mjs)，並於 [lib/cliWrap.mjs](../../lib/cliWrap.mjs) 加入目標分流與含 `target` 的 `triedBefore` 防重試；同步更新 [skills/director/SKILL.md](../../skills/director/SKILL.md) 與 [rules/AGENTS.md](../../rules/AGENTS.md)。
  - **新版 Antigravity ROADMAP**：重寫 [docs/ROADMAP.md](../ROADMAP.md)（統整 `v0.1.0`～`v0.14.1` 里程碑與後續方向）並更新 [README.md](../../README.md)。
  - **測試與驗收對條**：新增 [scripts/tasks.test.mjs](../../scripts/tasks.test.mjs) 與 [scripts/dispatch.test.mjs](../../scripts/dispatch.test.mjs)，並更新 [scripts/ui.test.mjs](../../scripts/ui.test.mjs)、[scripts/lang.test.mjs](../../scripts/lang.test.mjs)、[scripts/director.test.mjs](../../scripts/director.test.mjs)、[scripts/wrap.test.mjs](../../scripts/wrap.test.mjs)、[scripts/skills.test.mjs](../../scripts/skills.test.mjs)；執行 `node scripts/dispatch.test.mjs`、`node scripts/lang.test.mjs`、`npm test`（36/36 支測試檔）與 `npm run test:clean` 均檢查全綠，真實紀錄隔離檢查未動到 `~/.pipeline-monitor-agy` 與 `~/.pipeline-monitor`。
  - **暫停待定事項**：`package.json`／`plugin.json` 升版（預計 `v0.15.0`，動到危險清單上的 `plugin.json`）與搬往 `docs/升級摘要/` 依規定保留至審查與危險清單盤點拍板後執行。

### 2026-11-27　階段 C（打掃）＋ 階段 D 第一輪（魔鬼教官與修補）

- **階段 C（打掃）**：依 `--round C` 範圍檢查程式區改動檔；靜態清查 zero unused imports、zero unused private functions，測試檔維持唯讀未改；記 `--report C ok`（已改 0 項、建議 2 條、放過 1 項）。
- **階段 D 第一輪（T1 本回合自查，不派子 agent）**：依 `--round D` 反查 `docs/FAILURE-PATTERNS.md`（P1–P13）與 R1–R3，找到 1 條 P2／P6 問題並記 `--report D found`：
  - **[P2／P6] 無 hook 派工對話結案同步問題**：原本 `lib/cliDispatch.mjs` 的防撞車讀原始 `session_closed` 認得出零工具派工對話已結案，但 `lib/tasks.mjs` 只查 `sessionsOf` 導致該任務卡在 `施工與檢查中` 而無法重派。
  - **修補與單一來源整併**：將無 hook 結案／重開判定收斂進 `lib/tasks.mjs` 的 `dispatchesOf(events, projectSessions)` 單一來源（`cliDispatch.mjs` 移除重複判斷並改讀 `d.closed`，`deriveTaskBoard` 改以 `dispatchOpen` 推導），並於 `scripts/tasks.test.mjs` 與 `scripts/dispatch.test.mjs` 補齊迴歸測試；依「修完後先問人不自動重跑 D 第二輪」規定停手等待 Oscar 拍板。

### 2026-11-27　升版 v0.15.0、危險清單盤點、D 第二輪與 E 第一趟走過一遍

- **危險清單盤點（`--tier-checked`）**：依 Oscar 確認「1.照建議」，將 `lib/cliDispatch.mjs` 加入 `.agents/pipeline-stages.json` 的 `tiers.danger`，`lib/tasks.mjs` 維持於 `tiers.code`。
- **升版與歸檔**：`package.json` 與 `plugin.json` 升至 `v0.15.0`，將本規格從 `docs/進行中/` 歸檔至 `docs/升級摘要/`，並同步更新 [AGENTS.md](../../AGENTS.md) 索引與 [docs/ROADMAP.md](../ROADMAP.md) 里程碑表；升版後重跑 `npm test`（36/36）與 `npm run test:clean` 檢查全綠。
- **階段 D 第二輪（`--report D ok`）**：依 `--round D`（T2）僅針對第一輪之後修改的 5 個檔案（`lib/cliDispatch.mjs`、`lib/tasks.mjs`、`plugin.json`、`scripts/dispatch.test.mjs`、`scripts/tasks.test.mjs`）在本回合對照已知死法與三條紅線自查，未對到已知死法。
- **階段 E 第一趟走過一遍（`--report E ok`）**：在本機臨時啟動 `http://127.0.0.1:4329`（實況唯讀）與 `http://127.0.0.1:4330`（隔離示範資料），以 `browser` subagent 實看誠實任務板 `unset`、手寫欄位忽略提醒、6 欄整數統計、摺疊 `已歸檔`、複製按鈕區別、無 `%` 與無綠燈背書、日間／夜間切換後關閉臨時伺服器並清理暫存目錄；AC-1／AC-2 看到了（原文附於報告）、AC-3～AC-6 因屬 CLI／git／LS／文件／終端測試而標「驗不了」，保留由 Oscar 決定是否「驗收過了」。
- **上線版本：v0.15.0**
