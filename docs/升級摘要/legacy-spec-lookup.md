# 功能：舊規格與已知死法即時反查（零快取純字面掃描）

分級：預測至少 **T2**（因為結案升版會碰到危險清單上的 `plugin.json`；預計新增純唯讀模組 `lib/history.mjs` 與測試檔 `scripts/history.test.mjs`，並修改程式區的 `lib/cliRerun.mjs`、`status.mjs`、`skills/spec/SKILL.md`、`skills/spec-precheck/SKILL.md`、`skills/chaos-check/SKILL.md`、`rules/AGENTS.md`，以及 `README.md`、`AGENTS.md`、`package.json` 與測試 `scripts/skills.test.mjs`、`scripts/lang.test.mjs`——新增的 `lib/history.mjs` 落在 `tiers.code` 的 `lib/` 底下，施工時須由你判斷要不要加入危險清單）。T2 要求 A、C、D 與補測試。

> 2026-11-27 規劃（依總進度追蹤對話 2026-11-26 Oscar 原話與建議對話卡開立，無前置依賴；於獨立 worktree 分支 `legacy_spec_lookup_pipeline` 起草，`main` 目前為 `v0.12.0`；納入規格預審 8 條補強與 Oscar 拍板後搬入 `docs/進行中/` 開工）。
> 實機查證摘要（來自本專案 `docs/升級摘要/` 的已結案規格與 `docs/FAILURE-PATTERNS.md`）：
> 1. 既有舊規格檔內皆含 `YYYY-MM-DD` 日期（多數亦含上線版本），但新開 worktree 或乾淨副本中所有檔案的檔案系統 `mtime` 會落於同一刻，排序不可依賴 `mtime`（避開 P8／P9）。
> 2. 近期多份規格使用單層大括號縮寫列檔（如 `lib/{rounds,cliRerun}.mjs`、`skills/{spec,chaos-check}/SKILL.md`、`ui/{app.js,ui.css}`），純字面反查須兼認單層 `{a,b}` 展開並守住路徑邊界，否則會漏掉近期規格或誤中子字串（防 P4）。
> 3. 單檔點名數落差極大（例如 `status.mjs` 見於數十份、`lib/cliRerun.mjs` 僅數份），`docs/FAILURE-PATTERNS.md` 多點名核心模組與測試檔，反查須節制每檔列數並報真實總數，且明講「沒列到不代表無關」（R1／R3）。
> 讀了：`AGENTS.md`、`README.md`、`docs/ROADMAP.md`、`docs/FAILURE-PATTERNS.md`、`.agents/pipeline-stages.json`、`package.json`、`plugin.json`、`stages.json`、`hook.sh`、`gate.mjs`、`status.mjs`、`rules/AGENTS.md`、`lib/{cliRerun,cliFacts,checklist,lang}.mjs`、`skills/{spec,spec-precheck,chaos-check}/SKILL.md`、`docs/升級摘要/{spec-chaos-precheck,context-token-scale}.md`、`scripts/{docsIndex,skills,lang,precheck,rerun,_zhscan}.test.mjs` 及 `docs/升級摘要/*.md` 實測掃描。找不到 `docs/SPEC-TEMPLATE.md`（沿用既定最小格式）；`docs/LESSONS.md` 存在，本次未整份通讀。

## 這是為了解決什麼

專案累積超過五十份已完成規格與多條已知死法後，AI 寫規格或審核時很容易漏讀過往刻意決定而重蹈舊坑；本功能在現有 `--round precheck` 與 `--round D`（及唯讀查詢 `agy-pipeline --context`）裡即時純字面掃描已完成規格資料夾與 `docs/FAILURE-PATTERNS.md`，列出點名過目標檔案的最近歷史出處並誠實標示邊界，同時絕不另存第二份索引檔（防 P2）。

## 驗收條件

**AC-1　即時純字面反查舊規格與已知死法，絕不存快取索引，跨環境穩定排序且守住路徑邊界** ✅ 對過 2026-11-27
> **白話**：每次要查歷史紀錄時，現場把已結案的規格資料夾和老毛病清單拿出來翻，哪一份真正寫到過這個檔名就當場列出來；絕不另外抄一份目錄或索引表放在旁邊免得過期說謊，也不會因為新開工作區所有檔案時間都一樣就排錯順序，更不會把 `lib/status.mjs` 或 `status.mjs.bak` 錯認成 `status.mjs`。
> **會發生的情況**：
> 1. 每次查詢即時讀取 `ctx.root` 下由 `lib/lang.mjs` `specDirNames(['done'])` 定義的已完成規格資料夾（兼認 `docs/升級摘要/*.md` 與 `docs/done/*.md`，兩者並存時合併並依相對路徑去重，僅讀該層 `.md` 檔，P2）與 `docs/FAILURE-PATTERNS.md`，零快取、索引或暫存檔寫入。
> 2. 路徑比對守住左右非路徑字元邊界（允許前方 `./`、`../` 相對前綴），並支援單層 `{a,b}` 展開（如 `lib/{rounds,cliRerun}.mjs`、`skills/{spec,chaos-check}/SKILL.md`，單組設安全上限 50 項防畸形輸入）；`status.mjs` 絕不誤中 `lib/status.mjs`、`my-status.mjs` 或 `status.mjs.bak`，`lib/a.js` 絕不誤中 `lib/a.json` 或 `other/lib/a.js`（P4）。
> 3. 舊規格依內文（跳過 code fence）最新合法 `YYYY-MM-DD` 日期由新到舊穩定排序（無日期者排後、不編造日期），同日依相對路徑字碼順序排序，絕不依賴檔案 `mtime` 或 `git log`（P8／P9）；超過顯示上限（`--round` 預設每檔列最近 3 份、`--context` 預設每檔列最近 5 份，已知死法每檔列前 5 條）必報出真實總數（R3）。
> 4. `docs/FAILURE-PATTERNS.md` 跳過 code fence 解析 `## ` 分段標題（P4），輸出代號與精簡標題（相容中文 `P1`～`P13` 與英文專案自訂分段標題）。
> **技術**：新增純唯讀單一真相來源 `lib/history.mjs`（匯出 `lookupHistory`、`extractSpecTargetPaths`、`formatHistoryLines`、`doContext`），複用 `lib/lang.mjs` 的 `specDirNames(['done'])` 與 `zhEn`（P2），全程以 `ctx.root` 解析路徑（P11／P13），零外部相依。

**AC-2　誠實邊界：沒列到不代表無關；資料夾不存在、空目錄、讀檔失敗或找不到條目各自明講** ✅ 對過 2026-11-27
> **白話**：工具只看得到「白紙黑字點名過這個檔名」的舊檔案，沒寫全路徑或換過檔名的它看不到；所以每次一定先提醒「沒列到的不代表無關」，而且找不到資料夾、資料夾是空的、或檔案讀不動都會各自老實講清楚，絕不講成「沒有任何歷史決定」。
> **會發生的情況**：
> 1. 凡輸出反查區塊必帶邊界聲明：「僅列字面上點名過該檔路徑的歷史紀錄，沒列到的不代表無關」（EN：`Only lists historical records that literally name that file path; what isn't listed isn't necessarily unrelated.`）。
> 2. 來源異常各自明講、不折成 0 筆（R1／P5）：找不到已完成規格資料夾（`docs/升級摘要/` 與 `docs/done/` 皆不存在；EN 模式下缺夾提示不夾雜中文字面以守住零 CJK 檢查）、資料夾存在但無 `.md` 檔、目錄無權限或個別 `.md` 讀檔失敗（明報不可讀筆數與檔名，不靜默略過）；`docs/FAILURE-PATTERNS.md` 缺檔、讀不到權限或找不到 `## ` 分段各講各的；單側失敗時另一側照常反查。
> 3. 來源可讀且 0 命中時顯示「未見字面點名」（EN：`no literal mention found`），絕不寫「沒有歷史決策」「沒有老毛病」「無關」「安全」（R1／R2）。
> **技術**：`lookupHistory` 以明確狀態列舉（`ok` / `no-dir` / `empty` / `unreadable` 等）與 `unreadableFiles` 清單回傳結果，`formatHistoryLines` 依狀態統一產生 `zhEn` 文案，絕不以空陣列混充失敗。

**AC-3　無縫整合進 `--round precheck` 與 `--round D`，零重複算改動清單且不破壞既有分流與輪次** ✅ 對過 2026-11-27
> **白話**：不論是在開工前預審規格、還是寫完程式請魔鬼教官檢查，只要照舊跑一次原本的準備指令，畫面底下就會順手附上相關舊規格與老毛病提醒，不用多記新步驟，也不會弄亂原本的輪次、範圍或分流提醒。
> **會發生的情況**：
> 1. `--round precheck`：從本輪讀得到的規格檔（一律自 `a.specPlaces`／`a.specPlace` 解析 `found === 'here'` 與 `found === 'main'` 的 `mainFile`，含 `--spec` 連結與搬家後位置，P2／P6）抽取預計觸及檔名——同時抽取 `分級／Tier` 行與所有 `**技術**：`／`**Technical**:` 行並合併去重（跳過 code fence 與 `## 明確不做`／`## Not doing`，與 AC-1 共用同一組單層 `{a,b}` 展開輔助函式；無 `/` 的詞須實際存在於 `ctx.root` 才算檔名，防 `tiers.code`／`cfg.state` 誤中，P4；排除規格自身與已完成規格資料夾參考連結）；多份規格部分讀不到（含 `a.ghostSpecs` 與非 `here`/`main` 之 `a.specPlaces`）時逐份附註未納入自動反查；抽不到目標檔或規格檔讀不到時誠實明講無法自動反查（R1／P5）。
> 2. `--round D`：第 1 輪沿用 `printScope()` 的 `look` 清單（不重跑 git、保留既有範圍與分流提醒，P2；`!scope.known` 明講問不到、`lookCount === 0` 不印多餘反查）；第 2 輪以上沿用 `roundFiles()` 第一輪之後改動的 `look` 清單（若拿不到第一輪後清單，改對 `f.health?.list` 的要看檔反查並標註整批，問不到就明講，R1）。
> 3. `--round`（含 `--round precheck` 與 `--round D`）於 `readTierConfig` 為 `ok` 時皆依危險清單檔優先、其餘依檔名穩定排序，最多展開前 8 個目標檔，超過時明講「另有 N 個檔未展開」（P2／R3）。
> 4. `--round C`、`--round E`、`gate.mjs`、`hook.sh`、`guard.mjs`、`escalate.mjs` 與儀表板網頁維持零改動。
> **技術**：修改 `lib/cliRerun.mjs` 的 `roundOfPrecheck`（從 `a.specPlaces`／`a.specPlace` 解析，不依賴 `f.view.checklist?.file`）、`doRound` 與 `printScope`（回傳 `lookFiles`），與 `lib/history.mjs` 共用同一份目標清單與排序規則（P2）。

**AC-4　新增唯讀查詢 `agy-pipeline --context <檔...>`，並更新三支技能指引動手前速讀** ✅ 對過 2026-11-27
> **白話**：除了預審和魔鬼教官自動附帶以外，建築師在寫規格剛盤點完「預計會動哪些檔」時，也能主動下一句唯讀指令一次查出這些檔過去的所有刻意決定；同時更新三支技能手冊，提醒 AI 在動手前先速讀這些出處。
> **會發生的情況**：
> 1. `agy-pipeline --context <檔...>`（可附 `--all` 解除每檔 5 份上限）：純唯讀、在 git 專案內即可執行（不需有 commit、不讀事件檔，在 `loadEvents` 之前早退分派，P6／P3）；沿用 `lib/checklist.mjs` 的 `realOf()` 上溯最近存在父目錄做實路徑正規化（同時正規化 `ctx.root`），相容從子目錄執行的相對路徑、macOS `/tmp` 符號連結與尚未建立的新檔（P8／P13）；缺參數或未知旗標印白話用法並回傳非零（`1`）；工作區外路徑、工作區根目錄 `.`（`rel === ''`）或實存目錄（或尾斜線 `/`）明講不可查詢並排除於查詢清單，不靜默回 0 筆（若無任何合法目標回傳 `1`，R1／P4）。
> 2. 更新 `skills/spec/SKILL.md`（步驟 3 預計動檔後可先跑 `--context` 速讀舊規格與死法）、`skills/spec-precheck/SKILL.md`（第一步提醒 `--round precheck` 已附歷史反查，派子 agent 時一併附上）、`skills/chaos-check/SKILL.md`（第一步與步驟 2 提醒 `--round D` 已附歷史反查，速讀過往刻意決定並交給第一輪 T2 子 agent），並同步更新 `rules/AGENTS.md`（嚴控 `< 24,000 bytes`）與 `README.md`。
> **技術**：`status.mjs` 在 `loadEvents(...)` 之前（`--cards` 之後早退區）處理 `at('--context') !== -1` 並呼叫 `doContext(ctx, argv)`；`lib/history.mjs` 共用 `realOf()` 正規化路徑與處理 `--all` 旗標。

**AC-5　中英雙語完整對齊、補齊反查邊界回歸測試，本機與乾淨副本檢查全綠** ✅ 對過 2026-11-27
> **白話**：切成英文後，反查的標題、邊界聲明、找不到或沒權限的提示全部是自然且守住紅線的英文、沒有殘留中文或禁字；自動化測試與乾淨副本把路徑邊界、大括號展開、中英資料夾、竄改時間排序、子目錄與無權限情境全部驗齊。
> **會發生的情況**：
> 1. 所有文案以 `zhEn(中文, English)` 並排（通過 `scripts/lang.test.mjs` `_zhscan`），英文不含禁語（`passed`、`all clear`、`no problems`、`safe`、`verified`），且缺資料夾提示在 EN 下零 CJK 殘留（相容既有 `scripts/precheck.test.mjs` EN 檢查）。
> 2. 新增 `scripts/history.test.mjs`（`section()` 標記 `P2`、`P4`、`P5`、`P8`、`P9`、`P13`），涵蓋正反路徑邊界與 `{a,b}` 展開、中英資料夾與並存去重、缺夾／空夾／無權限讀檔、`FAILURE-PATTERNS.md` 各種狀態、竄改 `mtime` 仍穩定排序與報總數、`--round precheck`／`--round D`（第 1／2 輪）／`--context`（子目錄、零 commit＋無權限家目錄、macOS `/tmp` 新檔、`.`／目錄／工作區外路徑、缺參數、`--all`）及 ZH／EN 雙語實跑；同步更新 `scripts/{skills,lang}.test.mjs`。
> 3. `npm test` 與 `npm run test:clean` 檢查全綠且真實 `~/.pipeline-monitor-agy/` 零殘留；結案時搬入 `docs/升級摘要/legacy-spec-lookup.md`、更新 `AGENTS.md` 索引並同步升版 `package.json` 與 `plugin.json`。
> **技術**：所有測試以 `mkdtempSync`／`makeRepo` 與 `AGY_PIPELINE_HOME` 假家目錄完全隔離（P8）。

## 混沌推導

▸ **時間**：新開 worktree 或乾淨副本中所有歷史檔案的 `mtime` 落於同一秒 → 一律依內文（跳過 code fence）最新合法 `YYYY-MM-DD` 日期由新到舊、同日再依相對路徑字碼順序穩定排序，絕不依賴檔案 `mtime` 或 `git log`（P8／P9）。
▸ **容量**：單檔出現於數十份舊規格或一次改動大量檔案 → `--round` 最多展開前 8 個檔（危險清單檔優先）、每檔顯示前 3 份舊規格與前 5 條已知死法，並必報真實總數與未展開檔案數（`--context` 每檔前 5 份，加 `--all` 可看全部），避免洗版蓋掉範圍或分流提醒（R3）。
▸ **權限憑證**：舊規格目錄或部分 `.md`、`docs/FAILURE-PATTERNS.md` 無讀取權限（`EACCES`/`EPERM`）或存在壞符號連結 → 不拋未捕捉例外中斷 `--round`，明報不可讀檔案數與無法確認項目，且另一側來源仍照常反查（R1）。
▸ **輸入畸形**：規格檔誤寫 `tiers.code`／`cfg.state`、未閉合 `{a,b` 大括號、目標路徑在工作區外／`.`／實存目錄、含空白／反斜線、或於 macOS `/tmp` 符號連結下查詢尚未建立的新檔 → 單層大括號配對設上限且未閉合不展開；無 `/` 詞須存在於 `ctx.root` 才納入；反斜線正規化為 `/`；以 `realOf()` 上溯父目錄實路徑比對並拒收工作區外、`.` 與目錄，不靜默回 0 筆（P4／P8／P13／R1）。

## 已拍板（2026-11-27，Oscar 確認開工）

1. **唯讀查詢指令**：納入 `agy-pipeline --context <檔...>`（含 `--all`）。
2. **預設顯示上限**：`--round` 最多展開前 8 檔（危險清單檔優先）、每檔前 3 份舊規格；`--context` 每檔前 5 份（`--all` 看全部）；已知死法每檔前 5 條；皆必報真實總數。
3. **預審 8 條補強全數納入**：`--context` 移至 `loadEvents` 之前分派、`realOf()` 父目錄上溯正規化、`--round precheck` 合併抽取 `分級／Tier` 與 `**技術**：` 行並共用 `{a,b}` 展開、多份規格部分讀不到（含 `ghostSpecs`）附註、改從 `specPlace`/`specPlaces`（含 `mainFile` 與 `--spec` 連結）解析、`--round precheck` 同步採危險清單檔優先排序，以及 `--context` 排除 `.` 與實存目錄。

## 明確不做

- **不另建持久化索引檔、快取檔或知識庫**：絕不新增 `.json`／`.sqlite`／第二份摘要表，守住 `AGENTS.md` 單一真相來源與防 P2。
- **不接向量資料庫、語意搜尋、模糊比對或在 CLI 內呼叫 LLM**：維持零外部相依與純字面反查，避免不可預期延遲與幻覺關聯。
- **不改動儀表板網頁（`ui/`、`server.mjs`、`lib/collect.mjs`）與五支 hook（`hook.sh`、`guard.*`、`escalate.*`、`gate.mjs`、`remind.sh`）**：反查只在終端機 `--round precheck`、`--round D` 與 `--context` 呈現。
- **不自動全文載入或摘要歷史規格內文**：只列出檔名、最近日期與對應標題／分段代號，由 AI 按需自行 `read_file` 速讀。
- **不掃描未完成規格（`docs/規劃中/`、`docs/進行中/`）與 `docs/LESSONS.md`**：未完成規格並非已拍板的歷史決定，教訓全文則留待 AI 依死法代號按標題查閱。

## 施作紀錄

- 2026-11-27（A 寫規格＋規格預審）：起草規格並記 `--report A ok`；派獨立唯讀 `research` 子 agent 跑 `spec-precheck` 找到 8 條（記 `--precheck found`）。Oscar 回覆「照建議開工」將 3 項拍板與預審 8 條補強納入規格並搬入 `docs/進行中/`。
- 2026-11-27（B 寫程式＋補測試）：新增 `lib/history.mjs` 與 `scripts/history.test.mjs`，擴充 `lib/lang.mjs`、`lib/checklist.mjs`、`lib/cliRerun.mjs`、`status.mjs`、`skills/{spec,spec-precheck,chaos-check}/SKILL.md`、`rules/AGENTS.md`、`README.md` 與 `scripts/{skills,lang}.test.mjs`；`npm test` 35/35 支測試檔檢查全綠且真實紀錄零殘留。
- 2026-11-27（C 打掃＋D 第 1 輪＋危險清單定案＋結案升版）：C 打掃記 `--report C ok "已改 0 項、建議 0 條"`；D 第 1 輪自查未對到已知死法（`--report D ok`）。Oscar 拍板確認 `lib/history.mjs` 不加入危險清單（`--tier-checked` 維持 12 條）且先前 12 檔不用重跑 D（`--decide D skip`）。依 Oscar 指示執行結案升版至 [package.json](../../package.json) 與 [plugin.json](../../plugin.json) `v0.13.0`、規格搬入 `docs/升級摘要/` 並更新 `AGENTS.md` 索引。

上線版本：v0.13.0
