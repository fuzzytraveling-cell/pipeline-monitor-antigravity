# 功能：寫規格後、動手前由魔鬼教官預審規格（A → D 規格預審）

分級：預測至少 **T2**（因為結案升版會碰到危險清單上的 `plugin.json`；另外會改動程式區的 `lib/rounds.mjs`、`lib/stageLines.mjs`、`lib/cliReport.mjs`、`lib/cliRerun.mjs`、`lib/cliStages.mjs`、`lib/collect.mjs`、`lib/todo.mjs`、`status.mjs`、`gate.mjs`、`ui/app.js`、`skills/spec/SKILL.md`、`skills/chaos-check/SKILL.md`、`rules/AGENTS.md`，並新增技能檔 `skills/spec-precheck/SKILL.md` 與測試檔 `scripts/precheck.test.mjs`——新增的 `skills/spec-precheck/SKILL.md` 落在 `tiers.code` 的 `skills/` 底下，施工時須由你確認是否加入危險清單）。T2 要求 A、C、D 與補測試。

> 2026-11-23 規劃（依 `docs/升級摘要/danger-guard-force-ask.md`「已拍板」第 3 條開立獨立規格；v0.2 第一段 v0.2.0 已在 `main` 結案並蓋章）。
> 讀了：`AGENTS.md`、`README.md`、`docs/ROADMAP.md`、`docs/FAILURE-PATTERNS.md`、`docs/升級摘要/danger-guard-force-ask.md`、`docs/升級摘要/D多輪先問人.md`、`docs/升級摘要/五關自動結案.md`、`.agents/pipeline-stages.json`、`stages.json`、`hook.sh`、`gate.mjs`、`status.mjs`、`rules/AGENTS.md`、`lib/{rounds,stageLines,cliReport,cliRerun,cliStages,collect,tier,todo}.mjs`、`ui/app.js`、`skills/{spec,chaos-check}/SKILL.md`、`scripts/{skills,docsIndex}.test.mjs`。找不到 `docs/SPEC-TEMPLATE.md`（沿用既定最小格式）；`docs/LESSONS.md` 存在，本次未整份通讀。

## 這是為了解決什麼

現在魔鬼教官（D）只會在寫完程式後檢查程式碼，但很多會讓人返工或靜默說謊的老毛病（例如漏接第二條路徑 P6、兩個地方各算一次 P2、把沒問到寫成沒有 R1）其實在**寫規格那一刻**就已經埋進設計裡了；這個功能讓 AI 在寫完規格（A）後、動手寫程式（B）前，先由魔鬼教官用獨立視角對規格本身跑一輪老毛病預審，把問題交給你拍板，同時與完工後的「程式魔鬼教官（D）」徹底分開，不搶佔 D 的輪次、也不重複擋人。

## 驗收條件

**AC-1　預測到最高級（預設 T2）且已設定分級的專案，寫完規格後、等你點頭前自動跑一輪規格預審，只找問題、不改任何檔也不自動重跑** ✅ 對過 2026-11-23
> **白話**：設計圖畫好、碰到了關鍵危險區，交給你簽字開工前，先請一位沒畫過這張圖的驗圖師傅拿老毛病清單掃一遍，把發現的雷點連同設計圖一起遞給你；師傅只畫紅筆意見、絕不偷偷改你的設計圖，也不會自己反覆重驗燒時間；一般小改動的設計圖不主動多花這一道，除非你點名才驗。
> **會發生的情況**：在**已設定分級**的專案裡，AI 跑完 A 寫規格（寫出規格檔、更新索引並記 `--report A ok`）後，若規格預測到最高級（預設 `T2`，依專案 `tiers.levels.danger.id`），在停下來等你點頭前自動執行一輪規格預審：優先派 1 個獨立唯讀子 agent（全新腦袋，不沿用剛寫規格的盲點；無法派時改由本對話對照並明講），拿這份規格對照專案的 `docs/FAILURE-PATTERNS.md`、手冊「刻意的決定」與三條通用紅線 R1–R3（沒有專案清單時只對 R1–R3 並明講），列出上限 8 條具體會踩坑的發現（或明講「這份規格沒對到已知死法」），附上固定結尾「這是『找過』，不是『通過』」，全程不改任何檔案，再把 AC 清單與預審結果一併交給你決定要加、要改還是要刪。專案還沒設定分級（或設成不分級）、或規格預測未達最高級／讀不出預測分級時，不自動跑預審，只有你主動點名才跑。之後你在討論中要求修改規格時，AI 不會自動跑第二輪預審；只有你主動點名才再預審。
> **技術**：`lib/checklist.mjs` 新增單一真相來源 `predictedTierOf`／`predictsDanger` 解析規格「分級／Tier」行（跳過 code fence 與括號附註，防 P4），供 `skills/spec`、`--round precheck`、`gate.mjs` 共用（P2）。新增第 7 支非關卡技能 `skills/spec-precheck/SKILL.md`（不放進 `stages.json`，比照 `tier-setup`／`director`），並新增唯讀輔助指令 `agy-pipeline --round precheck`（從 `roundView` 取得這一輪單份／多份／搬家後的規格檔、既有預審紀錄與專案清單位置，P2）。更新 `skills/spec/SKILL.md` 步驟 6 之後：僅在專案已設定分級且規格預測達最高級時銜接單輪 `spec-precheck`（派 1 個 `TypeName: "research"` 子 agent，明禁子 agent 讀取 `SKILL.md` 或編輯檔案）。

**AC-2　規格預審與程式魔鬼教官（D）徹底隔離：不佔用 D 輪次、不重設這一輪、不讓程式 D 第一輪降格或被跳過** ✅ 對過 2026-11-23
> **白話**：開工前的「驗圖」和完工後的「驗屋」分開記帳——驗過圖不會讓完工後的驗屋被誤當成「早就驗過第一輪」，也不會還沒動工、看板上的驗屋師傅就提早亮燈或標過期。
> **會發生的情況**：
> 1. 規格預審記成獨立事件；還沒改程式檔前，五關裡的 **D 魔鬼教官**維持「這一輪還沒跑」。
> 2. 你點頭開工、AI 寫完程式後，**程式 D 仍是這一輪的第 1 次**（T2 第一輪照舊可派獨立 agent、收工門禁照舊要求完整跑程式 D，絕不會變成「D 之後又改了程式檔，要不要再跑由你決定」或第 2 輪只看部分檔）。
> 3. 之後你主動要求對修過的規格再預審一次，不會被算成「又叫一次 A」而重設這一輪起點。
> 4. 這一輪有規格檔、還沒改到程式檔時若跑了 `agy-pipeline --round D`，會明講「這一輪還沒改到程式檔，若要審規格請走規格預審（`spec-precheck` 與 `--precheck`）」，避免誤記進程式 D。
> **技術**：新增 `agy-pipeline --precheck <ok|found> "<說明>"`，寫入獨立事件 `event: 'spec_precheck'`（含 `verdict`、`note`/`noteFile`、`specs`、`by_session`、`cwd`、`head`、`source: 'ai'`，單行 `< 4096 bytes`，長清單沿用 `logs/reports/`，寫失敗大聲報錯），絕不寫入 `stage_report`（避開 P11）。`hook.sh` 零改動自動記 `skill: "agy-pipeline:spec-precheck"`；`lib/rounds.mjs` 以既有 `skillCallsOf(events, 'spec-precheck')` 配對 `spec_precheck` 事件，與 `runsPerStage(A/D)`、`roundOf()`、`rerunOf(D)` 完全獨立。更新 `skills/chaos-check/SKILL.md` 與 `lib/cliRerun.mjs` 標明兩者分界。

**AC-3　結論與過期狀態誠實呈現：終端機、儀表板 A 格與「還差什麼」白板說同一句話，不給假綠勾** ✅ 對過 2026-11-23
> **白話**：驗圖報告貼在「A 寫規格」那一格底下，寫清是「AI 說」沒對到已知死法還是找到幾條、花了幾分鐘；開工前如果你又改了規格，旁邊誠實註明「預審後規格有改動，要不要再預審由你決定」，絕不拿舊報告假裝看過新版，也不畫綠勾或笑臉替它背書。
> **會發生的情況**：
> 1. 終端機（`agy-pipeline`）與儀表板對話頁的 **A 寫規格**那一格下方顯示「規格預審」一行（`found` 時一併列出發現清單）：
>    - A 有規格但查不到預審紀錄 →「規格預審：沒有紀錄」（不說「沒跑過」，R1）。
>    - 叫了還沒記結論 →「規格預審：N 分鐘前叫了，AI 還沒記結論（可能還在跑，也可能收尾忘了記）」。
>    - 記了 `ok` →「規格預審：N 分鐘前 AI 說沒對到已知死法（從叫到記結論 X 分鐘）」；**不打綠勾、工班不笑（R2、P10）**。
>    - 記了 `found` →「規格預審：N 分鐘前 AI 說找到 N 條（從叫到記結論 X 分鐘）」並逐條列出發現。
>    - **開工（B 動手改程式）之前**規格檔在預審後又被改過 → 附加「預審之後規格有改動（要不要再預審由你決定）」；一旦進 B 開工（之後打勾 AC 或追加施作紀錄），只保留當時預審事實、不再誤報「規格有改動」。
> 2. 案件頁「還差什麼」白板與 `--todo`：預審叫了沒記結論列為「還差（藍）」；預審找到問題且等你拍板時，在 A 等點頭那一項標明「規格預審找到 N 條，等你確認並點頭開工」（標 `hold: true`，F 工地主任絕不因此誤亮「只剩收尾」，P10）。
> 3. 常駐儀表板還沒 `--serve-restart` 跑著舊程式時，上方黃條照實提醒（P2、R1）。
> **技術**：預審配對與過期判斷只在 `lib/rounds.mjs` 算一次（改動證據取感測器對規格檔改檔與 `mtimeOf`，限定在 B 開工之前，避開 P1／P9）；文案只在 `lib/stageLines.mjs` 寫一份（`zhEn` 並排），由 `lib/cliStages.mjs`、`lib/collect.mjs`、`lib/todo.mjs` 共用、`ui/app.js` 照印不另算（P2）。`collect.mjs` 補 `precheckSupport: true` 接入 `ui/app.js` 的 `oldServerBanner()`。

**AC-4　收工門禁（`gate.mjs`）只在「已設定分級專案剛寫完高風險規格、還沒動工」提醒一次，絕不重複擋人或干擾寫程式** ✅ 對過 2026-11-23
> **白話**：工地大門只在有規定分級的工地裡、建築師剛畫完碰到底線工程的設計圖卻忘了驗圖就想收工時提醒一次；還沒定分級的專案、一般小工程、已經驗過圖、還在問需求沒畫圖、已經開工進工地蓋房子、或是拿別的對話畫好的圖來施工，大門都不會再拿「驗圖」重複擋人。
> **會發生的情況**：
> 1. **會提醒（同回合每種最多一次）**：專案**已設定分級**（`state === 'ok'`）且未退出記錄；本回合跑了 A 並產出讀得到的規格檔、規格預測到最高級（預設 `T2`，即 `tiers.levels.danger.id`）、本輪尚未改動程式檔、且本輪尚無 `spec_precheck` 結論 → 收工時擋一次（`A:precheck`），提醒補跑一輪 `spec-precheck` 並記 `--precheck`。若已叫了 `spec-precheck` 卻還沒記結論（或子 agent 仍在跑）→ 擋一次（`A:precheck:report`，含純對話回合），提醒還在跑照實說、跑完要記 `--precheck`。
> 2. **絕不擋**：專案未設定分級（`unset`）、設成不分級（`tiers.off`）、設定檔讀不懂（`broken`）或退出記錄；規格預測未達最高級（如 T0／T1）或讀不出預測分級；A 還沒寫出規格檔（先問你釐清需求就停下）；本輪已有 `spec_precheck` 結論（之後你再修規格也不重擋）；已開始改程式檔（B 已啟動）或 `--spec` 連結別的對話寫的規格；本回合已擋過同種類（防迴圈）；子 agent 結束或門禁出錯。
> **技術**：`gate.mjs` 在 `cfg.state === 'ok'` 檢查之後、且在 `tier.requires` 檢查之前加入 `A:precheck` 與 `A:precheck:report`（因為純寫規格回合只改 `docs/`，機器分級為 T0、`requires` 為空），共用 `roundView` 的預審狀態、`predictsDanger(a.checklist, cfg.config.levels.danger.id)` 與既有 `gate_blocked` 同回合去重契約（P2、P7），不影響既有程式 D／C／清單／測試門禁。

**AC-5　中英雙語完整對齊、常駐規則同步，全套自動化測試與乾淨副本檢查全綠** ✅ 對過 2026-11-23
> **白話**：切換成英文時，預審技能的觸發句、提示、結論、終端機與儀表板每一句都同步成自然且守住紅線的英文（絕不美化成 `passed`、`all clear`、`no problems`），自動化測試與乾淨副本把隔離程式 D、不重複擋人、過期提示與雙語一次驗齊。
> **會發生的情況**：`--lang en` 時，`--round precheck`、`--precheck`、A 格預審列、白板與收工門禁全數為英文且零中文殘留；`skills/spec-precheck/SKILL.md` 附中英觸發句（前 1,536 字內）、與 `lib/lang.mjs` 逐字對齊的 `TERMS` 表與 `RED_LINES_EN`；`rules/AGENTS.md`（嚴控 `< 24,000 bytes`）與 `README.md` 同步更新為 7 支技能與 `--precheck`／`--round precheck` 入口；全套 `npm test` 與 `npm run test:clean` 檢查全綠且不碰真實紀錄。
> **技術**：所有新文案以 `zhEn(中文, English)` 並排（過 `scripts/lang.test.mjs`）；新增 `scripts/precheck.test.mjs`（覆蓋單／多份規格、不污染程式 D、T1/T2 仍從程式 D 第 1 輪起算、`gate.mjs` 只擋一次且不干擾澄清／修規格／B／`--spec`、預審後改規格提示、舊服務黃條、雙語與紅線，標記 P1/P2/P5/P6/P7/P10/P11），同步更新 `scripts/{skills,gate,lang,ui,todo}.test.mjs`。

## 混沌推導

▸ **時間**：`spec-precheck` 交給 `research` 子 agent 跑了幾分鐘，期間主對話又改了規格檔 → 改檔晚於預審呼叫（留 `SKEW_MS` 兩秒誤差），A 格誠實加註「預審之後規格有改動（要不要再預審由你決定）」。
▸ **併發**：同工作區有兩個對話，或主對話與子 agent 同時活動 → `spec_precheck` 帶 `by_session` 只歸屬記它的對話，單行 `< 4096 bytes` 保障 `O_APPEND` 原子性；子 agent 工具呼叫由 `transcript.mjs` 標 `_subagent: true`，不影響主對話關卡計數。
▸ **權限憑證**：`--precheck` 寫紀錄遇沙盒 `EPERM` 或目錄唯讀 → 大聲回報失敗並回傳非零（與 `--report` 一致）；`gate.mjs` 讀取或判斷出錯 → 靜默放行並記 `gate_broken`，絕不鎖死對話。
▸ **輸入畸形**：`--precheck` 給了 `ok`/`found` 以外的字、一次 A 寫多份規格且其中一份讀不到、專案沒有 `docs/FAILURE-PATTERNS.md` → 非法 verdict 拒收並給用法；多份規格由 `roundView` 逐份列出、讀不到的明講不編條目（R1）；無專案死法清單則明講只對通用三條紅線 R1–R3。
▸ **容量**：預審發現清單過長 → 沿用 `MAX_NOTE_BYTES` 機制將全文另存 `logs/reports/`，紀錄檔只留首行與 `noteFile`，讀取時檔案遺失明講「完整清單找不到」（R1）。

## 已拍板（2026-11-23，Oscar 確認開工）

1. **收工門禁（`gate.mjs`）範圍**：只有**已設定分級的專案**（`readTierConfig(...).state === 'ok'`）才由門禁提醒 `A:precheck`／`A:precheck:report`。
2. **自動觸發門檻**：只有規格裡**預測到最高級**（預設 `T2`，即專案設定的 `tiers.levels.danger.id`）才自動跑一輪規格預審；其餘由使用者主動點名才跑。
3. **誤用 `/chaos-check` 的防呆**：維持獨立非關卡技能 `spec-precheck` ＋ `--round D` 在沒改程式檔時提示分流；不在讀端抹掉已記下的 `chaos-check` 事件。

## 施作紀錄

### 2026-11-23 — B 實作、C 打掃與 D 魔鬼教官第一輪
- **實作範圍（B）**：
  - `lib/lang.mjs`、`lib/checklist.mjs`：加入中英雙語規格 `分級／Tier` 預測解析（`predictedTierOf`、`predictsDanger`），跳過 code fence 與括號附註（P4），多份規格彙整 `predictedTiers` 與無法確認分級的 `tierUnreadable`（R1）。
  - `lib/rounds.mjs`、`lib/cliFacts.mjs`：新增 `prechecksIn`、`precheckOf`、`spanText`、`precheckSpanLine`；於 `roundView`／`sessionView` 單一來源計算 `a.precheck`（與 `runsPerStage`、`roundOf`、`rerunOf(D)`、`stage_report` 徹底隔離）；僅在開工前依 `specLastEdit` 與活規格檔 `mtimeOf` 比對 `stale`，一進 B 即固定為 `false`。
  - `lib/stageLines.mjs`、`lib/collect.mjs`、`lib/cliStages.mjs`、`lib/todo.mjs`、`ui/app.js`：統一終端機、網頁與白板的預審狀態句與清單呈現；`no-report`／`found` 設 `hold: true` 防止 F 工地主任誤亮「只剩收尾」；`oldServerBanner` 納入 `precheckSupport`；不畫綠勾或笑眼（P10）。
  - `lib/cliReport.mjs`、`lib/cliRerun.mjs`、`status.mjs`、`gate.mjs`：新增 `--precheck ok|found`（寫入 `spec_precheck` 事件並比照長報告拆存 `logs/reports/`）與 `--round precheck`；`--round D` 於有規格且尚未動程式時印分流提醒；`gate.mjs` 僅在 `cfg.state === 'ok'`、預測達專案最高級且未動工／未連結 `--spec` 時擋一次 `A:precheck` 或 `A:precheck:report`。
  - `skills/spec-precheck/SKILL.md`、`skills/spec/SKILL.md`、`skills/chaos-check/SKILL.md`、`rules/AGENTS.md`、`README.md`、`plugin.json`：新增非關卡技能 `spec-precheck` 並更新 A／D 銜接與雙語文案（`plugin.json` 維持 `0.2.0`，待 Oscar 驗收確認結案再升版搬入 `docs/升級摘要/`）。
  - `scripts/precheck.test.mjs`、`scripts/skills.test.mjs`、`scripts/ui.test.mjs`：補齊規格預審全套隔離、單一真相來源、白板、門禁與雙語測試。
- **C 打掃（`--report C ok`）**：掃描 13 支改動程式檔，確認 0 項可安全刪除的死碼／未使用 import（測試檔唯讀、不動控制流），另記 2 條長清單存檔／展開格式化共用建議待評估。
- **D 魔鬼教官第一輪（`--report D found`）**：派 2 個獨立唯讀 subagent 分別審查後端／門禁與畫面／白板／測試（明禁讀任何 `SKILL.md`），對照 `FAILURE-PATTERNS.md` 確認並修正 **8 條程式缺陷** ＋ 補齊 **2 項測試涵蓋**：
  1. `lib/rounds.mjs`（`sessionView`／`roundView` fallback）：`skillCallsOf` 改收完整事件與 `pick`/`reportPick`，避免同回合重叫時 `spec_precheck`（只有 `by_session`）被預濾而漏切。
  2. `lib/rounds.mjs`（`pcScope`、`precheckOf` 與 `roundView` `ownRep`）：共用資料夾下未標 `by_session` 的 `spec_precheck` 不冒領進沒叫預審的對話、`precheckOf` 無 `calls` 回 `none`、`roundView` 共用時不讓別的對話的 `stage_report` 蓋掉本對話的 A 結論。
  3. `lib/cliFacts.mjs`（`stageFacts`）：共用工作區修正 Case A／B／B2 的 `A` 與 `precheck` 歸屬，避免掩蓋他人找到的問題或將預審結果嫁接到另一份規格。
  4. `lib/cliRerun.mjs`（`printScope`／`--round D` 分流提醒）：須 `scope.known && scope.lookCount === 0` 且無程式區命中才提醒，問不到 git 或無分級卻已改程式檔時不誤印。
  5. `lib/checklist.mjs`、`lib/cliRerun.mjs`（`combineChecklists`／`predictsDanger`／`roundOfPrecheck`）：多份規格納入無 AC 標題但有分級行的檔案，並以 `tierUnreadable` 在讀不到時回 `null` 明講（R1）。
  6. `lib/rounds.mjs`（`roundView` `specEditedAt`）：改以數值 `Date.parse` 比較混合秒／毫秒 ISO 時間戳，避免同秒內丟失 `stale`（P9）。
  7. `lib/cliRerun.mjs`（`roundOfPrecheck`）：`--spec` 連結別的對話寫的 `T2` 規格時不再自相矛盾印出自動預審提醒。
  8. `lib/todo.mjs`（`stageItems`）：`precheck.state === 'found'` 獨立於 `waitingNod` 之外處理，即使使用者追問過或 `--spec` 手動預審仍列「等你確認要不要修規格」且 `hold: true`、不誤亮 F。
  - **測試補強（`scripts/precheck.test.mjs`）**：補上以上 8 條迴歸檢查、實跑 `ui/app.js` 真 `agent() + workflow()`（確認 `ok` 不笑不打綠勾）與 `todoBoard(ok)`，以及 `gate.mjs`、`todoBoard`、`--precheck found`、遺失 `noteFile` 與 `ui/app.js` 的真實英文（EN）執行驗證。
- **第一輪修正後檢查結果**：
  - `npm test`：28/28 支測試檔檢查全綠（含 `docsIndex`、`lang`/`_zhscan`、`skills`、`precheck`、`sensor`、`verify` 等；真的紀錄未多出測試檔）。
  - `npm run test:clean`：在乾淨複本（committed `HEAD` `a8b66ef`）跑完 27/27 支測試檔檢查全綠。

### 2026-11-23 — 危險清單判斷與 D 魔鬼教官第二輪
- **危險清單判斷（`--tier-checked "2.照建議"`）**：Oscar 確認 `skills/spec-precheck/SKILL.md` 維持留在程式區（`tiers.code`），不加入 `.agents/pipeline-stages.json` `tiers.danger`。
- **D 魔鬼教官第二輪（`--report D found`）**：只看第一輪之後改的 6 個檔（`lib/checklist.mjs`、`lib/cliFacts.mjs`、`lib/cliRerun.mjs`、`lib/rounds.mjs`、`lib/todo.mjs`、`scripts/precheck.test.mjs`，不派子 agent），找出並修正 **3 條缺陷**：
  1. `lib/cliFacts.mjs`（`stageFacts`）：共用工作區因 A 衝突換回 `sv` 時同步替換 `B`（`mineB`），避免 terminal `B.checklist` 仍印別的對話的規格清單（P2/R1）。
  2. `lib/checklist.mjs`、`lib/cliRerun.mjs`（`combineChecklists` / `roundOfPrecheck`）：多份規格中有檔案但缺 `分級／Tier` 行（`predictedTier: null`）時納入 `tierUnreadable`，未見最高級前一律回 `null` 並於 `--round precheck` 明講（R1）。
  3. `lib/rounds.mjs`（`roundView` `ownRep`）：加上 `session &&` 條件，讓工作區總覽卡（`session: null`）保留跨對話接力記的 `--report C/A`，僅於單對話檢視隔離他對話結論（P2/R1）。
- **第二輪修正後檢查結果**：
  - 補齊以上 3 條迴歸測試與多份缺分級 `--round precheck`（ZH／EN）測試於 `scripts/precheck.test.mjs`。
  - `npm test`：28/28 支測試檔檢查全綠（真的紀錄未多出測試檔、舊的地方也沒被搬走）。
  - `npm run test:clean`：在乾淨複本（committed `HEAD` `a8b66ef`）跑完 27/27 支測試檔檢查全綠。
  - **第三輪決策（`--decide D skip "不跑"`）**：Oscar 確認「不跑」，已依原話記錄。

### 2026-11-23 — E 驗收第一趟走查（`--report E ok`）
- **測試環境**：啟動本工作區兩組臨時本機伺服器（實機唯讀 `http://127.0.0.1:4325` ＋ `/tmp` 隔離範例 `http://127.0.0.1:4326`，走查完已停止並清除暫存資料夾），由內建 `browser` subagent 依 AC-1～AC-5 檢視中英文畫面。
- **逐條紀錄**：
  - `AC-1` 驗不了：規格寫完後自動觸發子 agent 預審屬於對話技能執行時機，靜態儀表板畫面上無法觸發。
  - `AC-2` 看到了：預審 `found`／`stale` 顯示下 `D 魔鬼教官` 維持「這一輪還沒跑」。
  - `AC-3` 看到了：實機「規格預審：沒有紀錄」、範例 `found + stale`（帶 2 條清單）、`ok`（`data-face="open"`、無 `✅`）、`no-report` 與白板 `等你決定`（F 工地主任未亮「只剩收尾」），無舊版服務黃條或例外字樣。
  - `AC-4` 驗不了：`gate.mjs` 屬於對話收工 Stop 門禁，儀表板畫面上無法直接觸發。
  - `AC-5` 看到了：`4326` 切到英文後白板與 `Spec precheck:` / `Not run yet this round` 均為英文且無紅線禁用字。
- **使用者驗收（`--clear E "驗收過了"`）**：Oscar 確認「驗收過了」，已依原話記錄。

上線版本：v0.3.0

## 明確不做

- **不在 `stages.json` 新增第六關或改動五關結構**：規格預審掛在 A 寫規格底下並以非關卡技能 `spec-precheck` 運作，不破壞現有五關與專案自訂 `stages.json`。
- **不讓規格預審自動修改規格檔**：預審嚴格唯讀，要不要採納哪幾條發現由你拍板，避免 AI 擅自改寫需求。
- **不做預審的自動多輪迴圈，也不新增 `--decide precheck skip`**：預審預設只自動跑一輪；修過規格後門禁不再重擋，要不要再預審由你在對話裡決定。
- **不替「照別的對話寫好的規格施工（`--spec`）」重跑預審**：該規格已是先前確認過的版本，施工對話直接進 B 並在完工後跑程式 D。
- **不混入 v0.2 其他獨立項目**（`PreInvocation` 動態分級升級注入、`ask_question` 決策卡解析、C/D 異質模型並行調度、Sidecar），維持每份規格一頁。
