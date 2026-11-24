# 功能：心跳改按資料夾各自記，避免切換 worktree 或專案讓已恢復的舊黃燈復活

分級：預測至少 **T2**（因為會碰到危險清單上的 `guard.mjs`、`escalate.mjs` 與結案升版的 `plugin.json`；另會動到程式區的 `gate.mjs`、`lib/faults.mjs`、`lib/collect.mjs` 與測試檔 `scripts/faults.test.mjs`、`scripts/guard.test.mjs`、`scripts/gate.test.mjs`、`scripts/escalate.test.mjs`、`scripts/lang.test.mjs`，以及索引檔 `AGENTS.md`）。T2 要求 A、C、D 與補測試。

> 2026-11-24 規劃（起因：儀表板上方持續顯示 4 天前 `guard.mjs` 開發期間於主資料夾留下的 `guard_broken` 黃燈，查出原因是 `_guard.json` 全機只留最後一筆 `{ ts, cwd }`，每次切到 worktree 或別的專案就會把主資料夾心跳覆寫，讓舊黃燈在 90 天保留期內反覆復活）。
> 讀了：`AGENTS.md`、`README.md`、`docs/FAILURE-PATTERNS.md`、`docs/LESSONS.md`（搜尋關鍵字）、`docs/升級摘要/agent回報與故障記號.md`、`docs/升級摘要/danger-guard-force-ask.md`、`.agents/pipeline-stages.json`、`guard.mjs`、`gate.mjs`、`escalate.mjs`、`status.mjs`、`lib/{faults,events,collect,cliView,checklist}.mjs`、`scripts/{faults,docsIndex}.test.mjs`。找不到 `docs/SPEC-TEMPLATE.md`（改用技能最小格式）。

## 這是為了解決什麼

任一支 hook（改檔把關、收工 hook、分級通知）曾在某個資料夾出錯後，只要使用者切換到別的專案或同專案的 worktree 繼續作業，原本只記全機最後一次的心跳檔會被覆寫，導致「出錯那個資料夾之後有沒有跑過看不到」的黃燈在 90 天內反覆掛在監視器每一頁上方撤不掉。

## 驗收條件

**AC-1　出錯過的資料夾之後正常跑過，切去別的資料夾或 worktree 也不會讓舊黃燈復活** ✅ 對過 2026-11-24
> **白話**：像整棟大樓每個門禁各有自己的巡檢簽到格，而不是全棟共用一格——A 門禁修好簽到過之後，警衛再去 B 門禁刷卡不會把 A 的簽到擦掉，門口的黃色警告就不會一直重亮。
> **會發生的情況**：改檔把關、收工 hook 或分級通知任一支曾在資料夾 A 出錯；之後在 A 正常跑過一次，上方黃燈撤下；接著在別的專案或同專案的另一個 worktree 觸發同一支機制，儀表板每一頁與終端機 `agy-pipeline` 上方都**不會**再出現 A 的「之後有沒有跑過看不到」黃燈。反之，若 A 自出錯後從沒再跑過，就算別的資料夾跑了再多次，黃燈仍照實掛著（不把沒跑過講成已恢復，R1）。同一工作區透過系統捷徑或子資料夾再跑認得出是同一個；但不同的 worktree、別的專案或嵌套的獨立 git 專案（包含已刪除的嵌套 worktree）絕不混算成同一個資料夾。
> **技術**：在 `lib/faults.mjs` 抽出共用函式 `recordHeartbeat(logDir, file, cwd, { retainDays, now })`（P2），由 `guard.mjs`、`gate.mjs`、`escalate.mjs` 共同呼叫。心跳檔（`_guard.json`、`_gate.json`、`_escalate.json`）保留既有頂層 `{ ts, cwd }` 並新增 `byCwd: { [cwd]: ts }` 記錄各資料夾最近一次執行時間（由呼叫端傳入 `lib/events.mjs` 的 `RETAIN_DAYS`，寫入時順手清掉超過保留期限的過期鍵，不自編門檻 R3）。`gateErrorOf()` 與 `faultNotes()` 共用同一支工作區比對函式 `sameWorkspace()`（預審 #2：移除父子前綴預篩與路徑不存在時退回 `true` 的寬鬆分支，僅在完全相等、`real()` 相同，或兩者皆實際存在且 `git rev-parse --show-toplevel` 相同才算同一工作區，防已刪嵌套 worktree 誤判恢復與平級子資料夾漏記）；`gateErrorOf()` 查 `byCwd`，且僅在缺乏合法 `byCwd`（舊版心跳檔）時才退回讀頂層 `{ ts, cwd }`（預審 #3）。

**AC-2　不同資料夾先後出錯時，只修好後面那一個，前面沒跑過的那一個不會被靜默蓋掉** ✅ 對過 2026-11-24
> **白話**：如果一樓和三樓的警報都壞過，只去三樓測試正常，螢幕不能就以為整棟樓都沒事——一樓還沒測過，門口還要留著一樓的提醒。
> **會發生的情況**：保留期限內同一支機制先在資料夾 A 出錯、後來又在資料夾 B 出錯；之後只在 B 正常跑過，A 從未再跑過。此時儀表板與終端機仍會亮黃燈提醒 A「之後有沒有跑過看不到」，不會因為最後出錯的 B 跑過就把警告整條撤掉；若 A 與 B 都還沒在出錯後再跑過（只有 C 跑過），A 與 B 會各自列出一條黃燈，哪個資料夾跑過就單獨撤掉那一條。至於已正常跑過的那個資料夾（例如 B），它對應時間段的對話頁與終端機五關旁仍照實附上「X 前在這裡出錯過；之後在這裡跑過，沒再記到出錯」。
> **技術**：`gateErrorOf(E, hb)` 依故障 `cwd` 分組（含無 `cwd` 的舊記號獨立一組），各組檢查該組最後一筆錯誤之後是否已有同工作區心跳；不論最終 `state` 是 `broken`（全機最新心跳仍不晚於最後一筆錯誤）、`unclear` 或 `recovered`，只要有任何 `cwd` 分組已恢復即一律帶出各組獨立 `{ cwd, from, to, count }` 的 `recovered` 陣列，未恢復分組則帶出 `unrecovered` 陣列（由新到舊，無 `cwd` 的舊記號保留既有「看不出是不是同一個資料夾」文案）。`faultBanner()` 對每個未恢復項以既有中英句子各輸出一條黃燈（單筆時字句與既有測試一字不差）；`faultNotes()` 與 `lib/collect.mjs` 的 `anyRecovered` 不分整體 `state` 一併讀取 `recovered` 陣列（預審 #1：避免全部恢復或他處紅燈期間蓋掉已恢復工作區註記，R1、P2），並向下相容既有測試直接傳入的單一物件形狀。

**AC-3　舊版心跳檔、壞掉的心跳檔或多個對話同時寫入，都不會讓畫面誤報「還沒跑過」或鎖死編輯** ✅ 對過 2026-11-24
> **白話**：兩個工班同時在簽到簿上簽名不會把簿子撕破變成空白頁；升級前留下的舊格式簽到紙也能直接讀懂並平滑接上新格式。
> **會發生的情況**：升級前留下的舊格式心跳檔（只有 `ts` 與 `cwd`、沒有 `byCwd`），儀表板與終端機照常顯示「最後一次跑 X 前」並正確判斷恢復狀態；下一次任何資料夾觸發時，會自動把原本那筆舊心跳一起保留進新格式，不會一升級就弄丟上一筆資料夾紀錄。多個對話或子 agent 同時觸發寫入時，讀取端不會讀到寫到一半的空檔而誤報「還沒跑過」；若心跳檔原本損毀或無法解析，下次寫入會直接以合法新內容覆蓋自癒；若寫入遇權限不足失敗，仍靜默交回原流程，絕不鎖死編輯或對話。
> **技術**：`recordHeartbeat()` 先寫入同目錄隱藏暫存檔（`.<file>.<pid>.<rand>.tmp`）再以 `renameSync` 原子替換（失敗時盡力刪除暫存檔並吞錯）；讀既有檔時若缺 `byCwd` 則自動遷移既有的 `{ ts, cwd }`；組裝 `byCwd` 用 `Object.create(null)` 防原型鍵污染，非法日期／非字串／空 `cwd` 皆安全略過並保留既有 `byCwd`（不寫入空鍵）；併發時同鍵保留較新時間，且僅在 `now >= 既有頂層 ts` 時才一併更新頂層 `{ ts, cwd }`，否則沿用原檔頂層的 `ts` 與 `cwd` 配對不倒退（預審 #3）。暫存檔以 `.` 開頭，避免被 `collect.mjs` 與 `hookTimesIn()` 誤掃。

**AC-4　終端機、網頁儀表板與中英雙語完全一致，不動任何 UI 檔案且既有測試全數相容** ✅ 對過 2026-11-24
> **白話**：終端機跟網頁看板說的每一句都一模一樣、切到英文不會殘留中文或講過頭，而且這次純改底層紀錄與判斷，完全不碰網頁畫面檔，不干擾正在進行的介面改版。
> **會發生的情況**：同一份故障與多資料夾心跳資料下，終端機 `agy-pipeline` 最上方印出的橫條與網頁儀表板 `/api/status` 的 `faults.banner` 一字不差；切換 `--lang en` 時，單／多資料夾黃燈與五關旁註記全部為自然英文且零中文殘留、不觸犯紅線禁用字；感測器列的三支心跳顯示（收工 hook／改檔把關／分級通知）維持既有「最後一次跑 X 前」。
> **技術**：所有文案維持單一真相來源住在 `lib/faults.mjs` 的 `zhEn()`（P2），不改動 `ui/` 任何檔案、不改 `server.mjs` 回傳結構。補齊 `scripts/faults.test.mjs`、`scripts/guard.test.mjs`、`scripts/gate.test.mjs`、`scripts/escalate.test.mjs`、`scripts/lang.test.mjs` 回歸測試並標記老毛病代號（P2、P3、P13），覆蓋跨 worktree 不復活、未跑過維持黃燈、多資料夾部分恢復不掩蓋、symlink／子資料夾認同與嵌套／已刪 worktree 隔離、舊格式遷移與壞檔自癒、保留期限過期鍵清理、以及終端機與儀表板中英一致性。

## 混沌推導

▸ 併發：多個對話或子 agent 同時觸發 `guard.mjs`／`gate.mjs`／`escalate.mjs` 寫入同一個心跳檔 → 採同目錄隱藏暫存檔＋`renameSync` 原子替換，避免讀取端看到寫到一半的空檔；若極罕見撞上同毫秒 read-modify-write 導致其中一個 `cwd` 漏記，誤差方向是維持較保守的 `unclear` 而非誤稱恢復，且下一次觸發即自動補齊。
▸ 容量：長期開關許多暫時 worktree 使 `byCwd` 鍵數累積、拖慢 `PreToolUse`／`PreInvocation` 熱路徑 → 每次寫入依既有的 `RETAIN_DAYS`（90 天，與故障讀取視窗一致）自動清除過期鍵，維持小檔不膨脹。
▸ 輸入畸形：舊格式心跳檔無 `byCwd`、檔案 JSON 損毀、`byCwd` 非物件、鍵名為 `__proto__`／`constructor`、時間戳無效、或 hook payload 缺 `cwd` → 讀取端相容舊格式並略過壞值；寫入端以 `Object.create(null)` 建表、遷移舊頂層 `cwd`、遇壞檔自癒覆寫、無 `cwd` 時保留既有 `byCwd` 而不寫入空鍵。
▸ 權限憑證：紀錄資料夾唯讀或沙盒 `EPERM` 無法建暫存檔或更名 → 盡力清理暫存檔並靜默吞錯，絕不破壞三支 hook 的放行與把關契約。
▸ 時間：同一毫秒內心跳與錯誤先後寫入，或兩進程寫入順序微幅交錯 → 恢復條件維持嚴格晚於（`hbT > errT`）不把同毫秒出錯誤判恢復；合併時同鍵與頂層 `ts` 皆取較新時間避免倒退。

## 明確不做

- **不自動修改或清空現有 `~/.pipeline-monitor-agy/logs/_sensor.jsonl`**：是否清理 2026-11-20 開發期間那筆舊紀錄由使用者自行決定；本功能上線後只要在主資料夾正常觸發一次改檔把關，該黃燈就會正式撤下且日後切換到 worktree 或其他專案不再復活。
- **不把「別的 worktree 跑過」當成「主資料夾已恢復」**：各 worktree 各自有獨立的分支、檔案與 `.agents/pipeline-stages.json`，在 worktree 跑過不能證明主資料夾沒問題（守住 R1）。
- **不自動把「已刪除資料夾」的舊故障直接判成已恢復**：資料夾已刪除不等於 hook 的問題已修好（R1）；若未來實際碰到臨時 worktree 出錯後刪除、黃燈停留 90 天的困擾，再另開規格討論專用語句或手動歸檔方式。
- **不動 `ui/` 畫面與 `server.mjs` 介面、不動 `hook.sh`／`guard.sh`／`gate.sh`／`escalate.sh`、不改感測器找不到 `jq` 的紅黃燈判定規則**：與正在進行的 UI 改版保持零檔案重疊。

## 施作紀錄

- 2026-11-24（A 寫規格＋A → D 規格預審）：
  - 寫成規格並跑一輪唯讀 `spec-precheck`（找出 3 條：全部恢復或他處紅燈保留 `recovered` 陣列、`gateErrorOf` 與 `faultNotes` 共用嚴格版 `sameWorkspace`、併發配對頂層 `{ ts, cwd }` 且有合法 `byCwd` 時不退回讀頂層）。
  - 開工移至 `docs/進行中/per-cwd-heartbeat.md` 並將以上 3 條預審補強納入 AC-1～AC-3 技術段落。
- 2026-11-24（B 寫程式完成＋對過 AC-1～AC-4）：
  - `lib/faults.mjs`：新增 `recordHeartbeat()`（以 `Object.create(null)` 維護 `byCwd`、遷移舊頂層 `{ ts, cwd }`、依呼叫端傳入的 `RETAIN_DAYS` 清過期鍵、併發保留較新頂層 `{ ts, cwd }` 成對配對、採同目錄隱藏暫存檔＋`renameSync` 原子寫入並吞錯清暫存）；統一 `sameWorkspace()`（移除父子前綴預篩與不存在退回 `true` 的寬鬆分支）給 `gateErrorOf()` 與 `faultNotes()` 共用；新增 `heartbeatInfo()` 與分組版 `gateErrorOf()`，不論最終為 `broken`／`unclear`／`recovered` 皆帶出各組獨立時段的 `recovered` 與依新到舊排序的 `unrecovered` 陣列；更新 `faultBanner()` 與 `faultNotes()` 並相容舊測試物件形狀。
  - `lib/collect.mjs`：`anyRecovered` 一併檢查各故障物件的 `recovered` 陣列。
  - `guard.mjs`、`gate.mjs`、`escalate.mjs`：改呼叫 `recordHeartbeat(..., { retainDays: RETAIN_DAYS })`（`guard.mjs`、`escalate.mjs` 經使用者確認 `force_ask` 後改寫）。
  - 回歸測試：補齊 `scripts/faults.test.mjs`、`scripts/guard.test.mjs`、`scripts/gate.test.mjs`、`scripts/escalate.test.mjs`、`scripts/lang.test.mjs`；全套 `npm test` 29/29 支測試檔檢查全綠（含真實資料守護檢查無外洩），未觸碰 `ui/` 與 `server.mjs`。
- 2026-11-24（C 打掃＋D 魔鬼教官第 1／2 輪＋結案升版）：
  - C 打掃（`--report C ok`）：已改 0 項、建議 2 條、因規則放過 2 條。
  - D 魔鬼教官第 1 輪（派 2 位獨立唯讀 subagent，`--report D ok`）與第 2 輪（覆看第 1 輪後改動之 10 檔，`--report D ok`）：均沒對到任何已知死法。
  - 併齊 `main`（`v0.6.0`）後搬入 `docs/升級摘要/` 並升版至 `v0.7.0`。

上線版本：v0.7.0
