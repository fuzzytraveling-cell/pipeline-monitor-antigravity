# 功能：工地復盤官技能與近期卡關純事實盤點（retrospect）

分級：預測至少 **T2**（因為更新技能說明與結案升版都會動到危險清單上的 `plugin.json`；另預計新增第 8 支非關卡技能 `skills/retrospect/SKILL.md`、純唯讀事實模組 `lib/retrospect.mjs` 與測試檔 `scripts/retrospect.test.mjs`，並修改程式區的 `status.mjs`、`lib/history.mjs`、`rules/AGENTS.md`，以及 `README.md`、`AGENTS.md`、`package.json`、`scripts/skills.test.mjs`——新增的 `skills/retrospect/SKILL.md` 與 `lib/retrospect.mjs` 落在 `tiers.code` 底下，施工收尾時須由你判斷要不要加入危險清單）。T2 要求 A、C、D 與補測試。

> 2026-11-27 規劃並開工（依總進度追蹤對話 2026-11-26 Oscar 原話「照順序執行，幫我規劃並開建議對話卡片」開立；前置波 2-1a `v0.12.0` 與波 2-1b `v0.13.0` 皆已併入 `main`，於獨立 worktree 分支 `add_retrospect_skill` 起草；納入獨立規格預審 8 條補強與 Oscar 選項卡拍板後搬入 `docs/進行中/` 開工）。
> 階段 0 本機實機查證摘要：本專案紀錄檔 `~/.pipeline-monitor-agy/logs/pipeline-monitor_for_antigravty.jsonl` 目前累積 2,400+ 筆事件（含 `stage_report(D)`、`spec_precheck`、`gate_blocked`、`guard_asked`），單檔超出 `read_file` 單次行數上限且檔名經 `safeName()` 逐位元組編碼、跨 worktree 共用主資料夾專案名；若由 `SKILL.md` 叫 AI 手寫腳本讀檔會重演路徑分歧與漏讀 `noteFile`（P2／P6／P11／P13），故經 Oscar 拍板納入輕量純統計唯讀旗標 `agy-pipeline --retrospect`（零自然語言猜測）。
> 讀了：`AGENTS.md`、`README.md`、`docs/ROADMAP.md`、`docs/FAILURE-PATTERNS.md`、`docs/LESSONS.md`、`.agents/pipeline-stages.json`、`stages.json`、`plugin.json`、`package.json`、`hook.sh`、`gate.mjs`、`guard.mjs`、`escalate.mjs`、`status.mjs`、`rules/AGENTS.md`、`lib/{events,paths,lang,history,cliFacts,cliReport,cliRerun,cliView,rounds,skills,transcript,faults,tier}.mjs`、`skills/{spec,spec-precheck,director,tier-setup}/SKILL.md`、`docs/升級摘要/{legacy-spec-lookup,spec-chaos-precheck,brief-patrol-command,ask-question-decision-cards,主任技能}.md`、`scripts/{skills,docsIndex,independence,lang,history}.test.mjs` 及 `agy-pipeline --context` 反查結果。找不到 `docs/SPEC-TEMPLATE.md`（沿用既定最小格式）。

## 這是為了解決什麼

每次施工踩到的坑、預審或魔鬼教官抓出的缺陷、收工門禁攔下的漏項與危險檔詢問，平時分散在各份已結案規格與本機紀錄檔裡，沒人定期回頭整理哪些錯一犯再犯；本功能新增第 8 支通用非關卡技能 `retrospect`（工地復盤官）與一條輕量純事實盤點指令，讓 AI 依真實紀錄提煉最多三類防線升級提案，交給你拍板確認後才動手或開建議卡。

## 驗收條件

**AC-1　新增第 8 支非關卡技能「工地復盤官」，中英雙語都叫得到，且絕不干擾正在進行的關卡與輪次** ✅ 對過 2026-11-27
> **白話**：工地多請一位復盤顧問，隨時叫來翻舊帳找規律，但他不算五關工班裡的一關——叫他不會讓做到一半的工程重頭算起，也不會讓驗過屋的紀錄突然變過期。
> **會發生的情況**：
> 1. 新增 `skills/retrospect/SKILL.md`，不放進 `stages.json`；使用者說中文（「復盤一下」「工地復盤」「踩坑復盤」）或英文（`"run a retrospect"`、`"site retrospect"`、`"pitfall retrospect"`、`"retrospect"`）都能觸發，`description` 中英雙段完整落在前 `1,536` 個字元以內。
> 2. 在做到一半的對話裡呼叫 `retrospect`：五關（A～E）狀態、「這一輪從哪算起」、D／E 第幾輪與過期判斷皆與呼叫前完全一致；同回合 AI 讀取技能檔時 `gate.mjs` 判斷結果不變，新回合使用者手打 `/retrospect`（或 `/agy-pipeline:retrospect`）進行純唯讀問答時，`gate.mjs` 依契約 3 安靜放行且不洗掉本輪既有待補關卡。
> 3. 專案自己也有同名 `retrospect` 技能時兩者並存，使用者叫哪個就跑哪個。
> **技術**：新增 `skills/retrospect/SKILL.md`（frontmatter 僅含 `name` 與 `description`，不含 Claude 專有 `allowed-tools`／`argument-hint`，不指向 TutorPod）；`hook.sh` 零改動照記技能呼叫，讀取端 `stages.json` 維持五關不變。

**AC-2　一條唯讀指令一次攤開專案文件與近 90 天卡關事實，零自然語言猜測，缺檔或問不到各自明講** ✅ 對過 2026-11-27
> **白話**：復盤第一步先拉一張純事實帳單，把最近結案的規格清單、老毛病與教訓檔在不在、以及近三個月預審、魔鬼教官、收工門禁、危險檔把關實際發生過幾次照實印出來；程式只數結構化欄位、絕不猜語意，沒紀錄或壞掉就老實承認，絕不講成「零失誤」。
> **會發生的情況**：
> 1. 在 git 專案內（含尚無 commit 的新專案、子目錄與 worktree）執行 `agy-pipeline --retrospect`（可附 `--all` 解除顯示上限；整包 `argv` 除 `--retrospect` 與選填 `--all` 外，前後出現任何其他旗標或位置參數一律印用法並回傳 `1`，絕不誤觸其他寫檔旗標），純唯讀零寫入、零額外 git 歷史查詢，一次輸出兩塊事實：
>    - **專案文件與分級現況**：已完成規格資料夾（兼認 `docs/升級摘要/*.md` 與 `docs/done/*.md`，依內文跳過 code fence 之最新合法 `YYYY-MM-DD` 日期由新到舊、同日依相對路徑字碼排序，預設列最近 10 份並報真實總份數，絕不依賴檔案 `mtime`）、`docs/FAILURE-PATTERNS.md`（分段總數與代號）、`docs/LESSONS.md`（相容 `docs/references/LESSONS.md`）與專案分級設定（`ok` 列目前 `tiers.code`／`tiers.danger` 條目數與清單並以 `missingDanger` 標出工作區已消失的危險清單路徑，`unset`、`off`、`broken` 四態分明，絕不把沒設折成 `T0`）。當位於獨立 worktree（`ctx.mainRoot && ctx.mainRoot !== ctx.root`）時，明標 worktree 身分並同步對照 `ctx.mainRoot` 多出的已完成規格、老毛病代號、`LESSONS.md` 與分級設定差異，避免落後 `main` 時漏看主資料夾已完成的防線（P2／P6／P11）。
>    - **本專案近 90 天紀錄純統計與近期明細**（明標跨 worktree 共用同一份專案紀錄檔）：
>      - 先交代紀錄與防線健康狀態：相容「90 天內無感測器 `hook` 紀錄（`noRecordsWithin`）」與「仍有 Node 寫入之結構化事件」並存（兩者皆照實顯示，僅在 `no-file` 或零結構化事件時不印四類 `0 次`，P3／P5／R1）；一併揭露退出記錄、感測器掛壞、目前故障橫條、`unreadableLine`（`_sensor.jsonl` 壞行）、90 天內**已恢復（`recovered`）**的感測器／門禁／把關／通知故障區間，以及收工門禁（`_gate.json`）與改檔把關（`_guard.json`）是否從未有心跳。
>      - 列出 4 類結構化事件純統計（依 `loadStages` 動態讀取關卡並印 `stagesBrokenLine` 若關卡設定損壞，保留已不在目前 `stages.json` 內的歷史舊關卡代號分列，不寫死代號 `D`）：`spec_precheck` 與 `stage_report` 一律共用 `reportText` 展開 `noteFile`（遺失時明講完整清單找不到、`specs` 缺漏明標；預設各列最近 10 筆 `found` 時間、規格／關卡與摘要，單筆長文截短時明標並可由 `--all` 展開全文，非 `ok`/`found` 異常值亦照實單列不折入 `ok`）、`gate_blocked`（總擋次數＋各 `missing` 種類出現次數分開標明分母）、`guard_asked`（總次數＋`config_broken` 次數＋前 10 個命中 `danger` 的檔案與次數；以 `dangerRuleFor` 支援資料夾規則判定目前是否仍在 `tiers.danger`，遇分級設定 `broken`／`unset`／`off` 時明標無法確認／未啟用分級，且明標其為既有危險清單或設定讀不懂之詢問紀錄）。
> 2. 任何來源缺資料夾、空資料夾、無權限讀取、感測器故障或退出記錄均各自明講（沙盒阻擋 `~/.pipeline-monitor-agy/` 時沿用既有權限提示回傳 `1`），絕不把「沒問到／沒有紀錄／超過 90 天保留期」印成「0 次問題」或「一切正常」（R1／R2／P3／P5）。
> **技術**：`lib/history.mjs` 匯出既有的 `readDoneSpecs` 與 `readFailurePatternsSource` 共用單一來源（防 P2／P8／P9）；新增純唯讀模組 `lib/retrospect.mjs`（匯出 `parseRetrospectArgs`、`collectRetrospectFacts`、`formatRetrospectLines`、`doRetrospect`，複用 `readEvents`、`noRecordsWithin`、`reportText`、`loadStages`、`stagesBrokenLine`、`readTierConfig`、`dangerRuleFor`、`missingDanger`、`optOutState`、`mountState`、`faultsNow`、`faultBanner`、`unreadableLine`、`gateHeartbeat`、`guardHeartbeat`），於 `status.mjs` 語言狀態提示之後、所有其他旗標與 `loadEvents` 之前早退分派 `--retrospect`（參數合法再做 `gitContext` 與 `ctx.isGit` 檢查）。

**AC-3　嚴格唯讀提煉最多三類防線升級提案，每條必附真實日期與檔名證據，找不到就老實說沒看到** ✅ 對過 2026-11-27
> **白話**：復盤官看完帳單和近期施作紀錄後，只挑「真的有憑有據重複發生」的問題寫成最多三種提案，每一條都要指得出哪一天、哪個檔案發生過；已經寫進防線（含主資料夾 `main` 已完成）的不重提，紀錄太少湊不到證據就老實說沒看到，絕不硬湊清單或編健康分數。
> **會發生的情況**：
> 1. AI 依 `skills/retrospect/SKILL.md` 先跑 `agy-pipeline --retrospect`，再按需抽讀近期已完成規格的「施作紀錄」、`docs/LESSONS.md`、`docs/FAILURE-PATTERNS.md`（若在落後 `main` 的 worktree 一併核對主資料夾差異）與相關 `SKILL.md`／常駐規則，產出嚴格唯讀提案（上限 3 類、總計上限 6 條，不給百分比、健康度評分或通過背書，R2／R3）：
>    - **類別一（新老毛病條目草稿）**：同類錯誤在不同地方發生 ≥ 2 次（依 `FAILURE-PATTERNS.md` 既有門檻）且尚未被現有代號涵蓋時，草擬新條目（含一句話判準、兩處以上真實日期＋檔名證據，以及建議釘上的測試檔／`section()` 切點提醒；專案尚無該檔時可提議新建）。
>    - **類別二（危險清單候選提議）**：反覆在預審／魔鬼教官 `found` 或返工紀錄被點名、且目前不在 `tiers.danger` 的檔案，逐檔套用 `tier-setup` 三個問題說明理由，提議由你判斷是否補進 `tiers.danger`（工具絕不替人決定；先前已明確拍板不加且無新靜默壞檔證據者不重炒；`tiers.off` 尊重決定不硬推、`unset` 改提議是否跑 `tier-setup`）。
>    - **類別三（技能或規則摩擦修訂草稿）**：反覆觸發 `gate_blocked`、`spec_precheck(found)` 或漏步驟的摩擦點，讀過目標 `SKILL.md`／常駐規則確認尚未涵蓋且不違反手冊「刻意的決定」後，提出精準修訂草稿（並標明 `rules/AGENTS.md < 24,000 bytes`、`SKILL.md description < 1,536` 字元與 `TERMS` 同步限制）。
> 2. 讀得到的紀錄裡沒有符合證據門檻的項目時，誠實回報「在目前讀得到的紀錄裡，沒看到符合證據門檻的重複錯誤或卡關項目——這只代表讀得到的紀錄裡沒看到，不代表專案沒有隱患」，不硬湊提案、也不彈無意義選項卡。
> 3. 固定結尾明講「這是復盤盤點，不是通過或安全背書」，並列出實際讀了哪些檔案、哪些找不到／讀不到及事件紀錄涵蓋範圍。
> **技術**：於 `skills/retrospect/SKILL.md` 明訂讀取順序、三類證據門檻、worktree 與主資料夾既有防線去重檢查、以及空結果中英誠實結尾範本。

**AC-4　全程不擅自改檔，以 `ask_question` 選項卡（相容純文字）交由人類拍板後才動手或開建議卡** ✅ 對過 2026-11-27
> **白話**：復盤官把提案攤在桌上後一定先停手問你「要採納哪幾條、當場改還是另開新對話卡、還是都先不用」，並先講清楚當場改會觸發哪幾關檢查；你沒點頭前一個字都不改，你點頭後也只做你選的那幾件。
> **會發生的情況**：
> 1. 有 ≥ 1 條提案時，AI 在提出提案階段**絕不修改或新增任何檔案，也絕不預先跑 `--suggest` 開卡**；正文列清每條編號、真實證據、具體草稿，以及**若在此對話直接套用該項目會在專案分級下觸發的關卡要求**（例如改 `skills/`／`rules/` 升 T1 需跑 D，達最高級 T2 時建議改走另開建議卡）後，以精簡的 `ask_question` 選項卡（選項精簡在 200 字內、**不將「直接套用」標成 `(Recommended)`** 防替人背書 P10，保留純文字回話完全相容）請你拍板「採納哪幾條（在此對話套用／另開建議卡留給新對話處理）／都先不用」。
> 2. 回覆「都先不用」時，零改檔直接結束。
> 3. 選擇「另開建議卡」時，開卡前同時查 `agy-pipeline --cards`、`agy-pipeline --todo` 與未完成規格資料夾（`docs/規劃中/`、`docs/進行中/` 及 `docs/planned/`、`docs/in-progress/`，防 P2／P6 漏看既有未完成規格或進行中對話）；確認未重複且未說過不做後，只替你本次親口／親點拍板的項目以 `agy-pipeline --suggest "標題" <<'EOF' … EOF` 將本次拍板原話、證據出處與完成條件寫入 stdin 內文（絕不把原話塞進標題參數，也絕不把對話開頭系統／背景包裝文字當成原話，防 P7）。
> 4. 選擇「在此對話套用指定項目」時：若本對話已有其他未結案改動先提醒會併入同一輪；若要修改 `tiers.danger`，**必先執行 `agy-pipeline --tier-review` 檢查專案內是否有其他尚未判斷的新程式檔**並一併請你確認後，才可寫入 `tiers.danger` 並執行 `agy-pipeline --tier-checked "<你的原話>"`（防靜默將其他未審新檔蓋章放行，P3／P7／R2）；若新增 `FAILURE-PATTERNS.md` 代號且專案測試有釘代號，同步提醒補上對應測試切點以免檢查變紅。
> **技術**：於 `skills/retrospect/SKILL.md` 明訂拍板前唯讀禁令、套用分級預告、`ask_question` 選項設計防線、`--suggest` stdin 契約與三處查重、以及 `--tier-review` 前置保護契約。

**AC-5　雙語用語與紅線逐字同步，同步更新常駐規則、plugin 與文件，本機與乾淨副本檢查全綠** ✅ 對過 2026-11-27
> **白話**：切成英文時，`--retrospect` 輸出與 `retrospect` 技能的紅線對照表全數同步成不說謊的英文；常駐規則、安裝說明與技能測試同步升為 8 支技能，全套測試與乾淨副本一次驗過。
> **會發生的情況**：
> 1. `skills/retrospect/SKILL.md` 內含與 `lib/lang.mjs` 逐字一致的 `TERMS` 對照表、`RED_LINES_EN` 與「用使用者講的語言回」聲明；`--lang en` 下 `agy-pipeline --retrospect` 全英文且零 CJK／全形空白殘留，不含 `passed`、`all clear`、`no problems`、`safe`、`verified` 等禁語。
> 2. 同步更新 `rules/AGENTS.md`（無 YAML frontmatter、`< 24,000 bytes`，補入第 8 支技能 `retrospect` 與 `--retrospect` 入口）、`plugin.json`（中英雙段說明更新為 8 支技能並保留 `first 200 characters`）、`README.md`（用法與 8 支技能表）。
> 3. 更新 `scripts/skills.test.mjs`（8 支技能契約、補認單字觸發詞 `"retrospect"` 並直接檢查 `[...description].length < 1536`、用語表同步、不指向 TutorPod），並新增 `scripts/retrospect.test.mjs`（標記 `P2`、`P3`、`P4`、`P5`、`P6`、`P8`、`P9`、`P10`、`P11`、`P13`：中英雙套規格資料夾與竄改 `mtime` 排序、獨立 worktree 對照 `mainRoot` 差異、缺夾／空夾／無權限、`noRecordsWithin` 與結構化事件並存、90 天已恢復故障與無心跳揭露、4 類事件純統計、`spec_precheck` 與 `stage_report` 共用 `reportText` 展開／遺失、`dangerRuleFor` 資料夾規則與 `missingDanger`、壞關卡設定與歷史關卡代號、零 commit 專案與子目錄／worktree、整包 `argv` 未知參數與寫檔旗標攔截、同回合讀技能檔與新回合手打 `/retrospect` 門禁契約、以及 ZH／EN 雙語實跑）；`npm test` 與 `npm run test:clean` 檢查全綠且真實 `~/.pipeline-monitor-agy/` 零殘留。
> **技術**：`lib/retrospect.mjs` 所有中文文案皆置於函式內 `zhEn(中文, English)`（通過 `scripts/lang.test.mjs` `_zhscan`）；測試全數以 `makeRepo`＋`AGY_PIPELINE_HOME` 假家目錄隔離（P8）。

## 混沌推導

▸ **時間**：新開 worktree 或乾淨副本中所有歷史檔案的 `mtime` 落於同一秒 → 已完成規格複用 `lib/history.mjs` 依內文（跳過 code fence）最新合法 `YYYY-MM-DD` 日期由新到舊、同日依相對路徑字碼順序穩定排序，絕不依賴檔案 `mtime`（P8／P9）；事件紀錄只看 90 天保留期限內並明講期限邊界與 90 天內曾發生之已恢復故障（L3／P3／P5）。
▸ **容量**：已完成規格超過五十份或本機事件數千筆 → `--retrospect` 預設僅列最近 10 份已完成規格、最近 10 筆 `spec_precheck(found)` 與 `stage_report(found)` 摘要、前 10 個 `guard_asked` 檔案並必報真實總數（附 `--all` 解除上限，R3）；技能提案限最多 3 類（總計上限 6 條），不整包洗版。
▸ **併發**：同專案多個 worktree 共用同一份 `<project>.jsonl`，或在落後 `main` 的 worktree／做到一半的對話中途叫 `retrospect` → 統計明標為「整個專案近 90 天紀錄」並在獨立 worktree 同步比對 `ctx.mainRoot` 文件與分級設定差異；壞 JSON 行由 `readEvents` 安全略過；`retrospect` 不進 `stages.json`、拍板前零改檔，不重設這一輪起點也不讓 D／E 過期（P6／P11／P12）。
▸ **權限憑證**：沙盒阻擋 `~/.pipeline-monitor-agy/`（`EPERM`／`EACCES`）或個別 `.md`／`noteFile` 無權限或遺失 → 沿用 `status.mjs` 權限錯誤回傳 `1`，個別缺檔、無權限或 `noteFile` 遺失各自明講，絕不折成「0 次踩坑」（R1／P3／P5）。
▸ **輸入畸形**：`--retrospect` 前後混帶未知旗標／寫檔旗標／位置參數、零 commit 新專案、分級未設／壞掉／不分級／退出記錄、或對話開頭含系統／背景包裝文字 → 早退檢查整包 `argv` 直接報錯回 `1`；零 commit 專案照常可跑；分級四態照實呈現不折成 `T0`；拍板開卡（走 `--suggest` stdin）或更新危險清單（先 `--tier-review`）只認本次復盤問完後你的親口／親點回覆（P4／P7／R1）。

## 已拍板（2026-11-27，Oscar 確認開工）

1. **輕量純統計唯讀指令與預設上限**：納入 `agy-pipeline --retrospect [--all]`（預設列最近 10 份規格、最近 10 筆 `found` 明細、前 10 個 `guard_asked` 檔案；`retrospect` 技能每次提案最多 3 類共上限 6 條）。
2. **規格預審 8 條邊界補強全數納入**：① 相容 `noRecordsWithin` 與結構化事件並存，並揭露 `_sensor.jsonl` 壞行、90 天已恢復故障與無心跳；② `status.mjs` 移至語言提示後、寫檔旗標與 `loadEvents` 前早退分派並驗整包 `argv`；③ `spec_precheck` 與 `stage_report` 共用 `reportText` 展開 `noteFile`，提示壞關卡設定並保留歷史關卡代號；④ `guard_asked` 用 `dangerRuleFor` 支援資料夾規則、區分分級非 `ok` 狀態並以 `missingDanger` 標示消失路徑；⑤ 獨立 worktree 對照 `ctx.mainRoot` 差異；⑥ 當場改 `tiers.danger` 前必先跑 `--tier-review` 且拍板前先預告觸發分級關卡；⑦ 另開建議卡走 `--suggest` stdin 契約並同時查 `--cards`、`--todo` 與未完成規格資料夾；⑧ `skills.test.mjs` 支援單字 `"retrospect"` 與直接檢查 `description` 長度，並對齊問答回合門禁契約。

## 明確不做

- **不在 CLI 內做自然語言猜測、關鍵字聚類、語意搜尋或呼叫 LLM**：`--retrospect` 只做結構化事件與檔案清單的純事實統計，跨文本歸納由執行 `retrospect` 技能的 AI 對照真實檔案完成。
- **不另存任何復盤快取檔、持久化索引檔或新增復盤專用事件寫入紀錄檔**：不設 `--report retrospect`、不寫 `.json`／`.sqlite` 狀態檔，守住單一真相來源（防 P2）。
- **不把 `retrospect` 放進 `stages.json` 或 `gate.mjs` 收工門禁**：復盤是定期自主保養，不是每次改程式收工必擋的關卡。
- **不在你拍板前自動修改 `FAILURE-PATTERNS.md`、`tiers.danger`、`SKILL.md`、`rules/AGENTS.md`，也不預先自動開立 `--suggest` 建議卡**。
- **不改動儀表板網頁（`ui/`、`server.mjs`、`lib/collect.mjs`）與五支 hook（`hook.sh`、`guard.*`、`escalate.*`、`gate.mjs`、`remind.sh`）**。

## 施作紀錄

- **2026-11-27（A 規格＋規格預審）**：起草規格並記 `--report A ok`；派獨立唯讀 `research` 子 agent 跑 `spec-precheck` 找到 8 條（記 `--precheck found`）。Oscar 拍板納入輕量唯讀指令 `agy-pipeline --retrospect [--all]` 與預審 8 條補強並搬入 `docs/進行中/` 開工。
- **2026-11-27（B 寫程式＋對過 AC-1～AC-5）**：
  - [lib/history.mjs](../../lib/history.mjs)：匯出 `readDoneSpecs` 與 `readFailurePatternsSource` 供單一真相來源共用。
  - [lib/retrospect.mjs](../../lib/retrospect.mjs) 與 [status.mjs](../../status.mjs)：實作 `parseRetrospectArgs`、`readLessonsSource`、`collectRetrospectFacts`、`formatRetrospectLines`、`doRetrospect`，於 `status.mjs` 在 `--brief` 之後、`--lang` 與其他寫檔旗標之前早退分派 `--retrospect`。
  - [skills/retrospect/SKILL.md](../../skills/retrospect/SKILL.md)、[rules/AGENTS.md](../../rules/AGENTS.md)、[plugin.json](../../plugin.json)、[README.md](../../README.md)：新增第 8 支非關卡技能「工地復盤官」，對齊 `lib/lang.mjs` `TERMS` 與 `RED_LINES_EN`、`description` 1,087 字元（`< 1,536`）、`rules/AGENTS.md` 5,733 bytes（`< 24,000`）。
  - [scripts/skills.test.mjs](../../scripts/skills.test.mjs) 與 [scripts/retrospect.test.mjs](../../scripts/retrospect.test.mjs)：補齊 8 支技能契約（含單字 `"retrospect"` 與直接長度檢查）與復盤邊界測試；`npm test` 36/36 支測試檔檢查全綠，真實 `~/.pipeline-monitor-agy/` 與 `~/.pipeline-monitor/` 無多出測試檔。
- **2026-11-27（C 打掃＋D 魔鬼教官第 1 輪與修復）**：
  - C 打掃：`--report C ok`（已改 0 項、建議 0 條；測試檔唯讀）。
  - D 魔鬼教官第 1 輪：派 1 位獨立唯讀 `research` subagent 審查本輪 8 個改動檔案，找到 6 條（`--report D found`）：
    1. `[P11/P3/R1]` [lib/retrospect.mjs](../../lib/retrospect.mjs) 誤將 `monitorDir` 當成 `home` 傳給 `mountState`，導致正式環境 plugin 掛載與斷鏈偵測失效 → 改以 `home` 參數傳遞（預設 `undefined` 交由 `mountState` 取 `homedir()`）並補接 `mountFix`。
    2. `[P6/P2/R1]` 曾有紀錄但之後拆掉感測器時，`mount.state === 'off'` 被靜默跳過不報 → 改用 `sensorOffLine` 呈現。
    3. `[R1/R3/P5]` 獨立 worktree `LESSONS.md` 無權限被折成 0 段算出假差數、兩邊同段數不同標題則歸零 → 改以 `headings` 集合差集比對並在任一側 `unreadable` 時明講無法比對。
    4. `[R1]` worktree 分級為 `broken`／`unset`／`off` 時把主資料夾整份危險清單誤報為尚未同步並蓋掉狀態差異 → 僅於兩側皆 `ok` 時比對危險清單差集，其餘各自明講分級狀態差異。
    5. `[P6/R1]` `faultNotes` 只傳 `root` 與 `mainRoot`，漏掉已刪除舊 worktree 的 90 天內已恢復故障 → 改從專案事件 `projectCwds` 併入所有已知工作區路徑核對並去重。
    6. `[P2]` `sensorCount` 計數與 `noSensorWithin`（`isSensorBacked`）口徑不一致 → 從 [lib/rounds.mjs](../../lib/rounds.mjs) 匯出共用 `isSensorBacked` 並改用 `loadEvents` 合併轉錄檔後計數。
    - 另順手納入 2 條邊界補強：`inProjectCwd` 對 `e.cwd` 同步做 `real()` 正規化，以及 [skills/retrospect/SKILL.md](../../skills/retrospect/SKILL.md) 開卡前於獨立 worktree 同步檢查主資料夾未完成規格資料夾。
  - 已於 [scripts/retrospect.test.mjs](../../scripts/retrospect.test.mjs) 補齊上述 6 條回歸測試。
- **2026-11-27（危險清單拍板＋D 魔鬼教官第 2 輪與修復）**：
  - `--tier-checked`：依 Oscar 選項卡 `A1` 拍板，`lib/retrospect.mjs` 與 `skills/retrospect/SKILL.md` 兩支都不加入 `tiers.danger`，維持在 `tiers.code`。
  - D 魔鬼教官第 2 輪：檢視第 1 輪後改動的 4 個檔（[lib/retrospect.mjs](../../lib/retrospect.mjs)、[lib/rounds.mjs](../../lib/rounds.mjs)、[scripts/retrospect.test.mjs](../../scripts/retrospect.test.mjs)、[skills/retrospect/SKILL.md](../../skills/retrospect/SKILL.md)），找到 2 條（`--report D found`）：
    1. `[R1/R3/P5]` [lib/retrospect.mjs](../../lib/retrospect.mjs) 獨立 worktree 的 `mainDiff` 在 `mainSpecs` 或 `mainFp` 任一側無權限／部分讀不到時仍取空陣列差集，會把主資料夾條目／規格誤報為尚未同步或靜默不報 → 補齊 `specsDiffState`／`specsPartialUnreadable`（含 `unreadableFiles` 排除）與 `fpDiffState` 雙語提示。
    2. `[P8]` [scripts/retrospect.test.mjs](../../scripts/retrospect.test.mjs) 第 9 段直接呼叫 `collectRetrospectFacts` 漏傳 `home: s.home` → 已補傳並於第 4 段補齊上述 3 條權限隔離回歸檢查。
- **2026-11-27（收尾與上線）**：Oscar 選項卡拍板不跑 D 第 3 輪（`--decide D skip`）直接升版並併回 `main`；本機 `npm test`（36/36 支測試檔）與乾淨副本 `npm run test:clean` 檢查全綠，規格搬入 `docs/升級摘要/`。上線版本：v0.14.0
