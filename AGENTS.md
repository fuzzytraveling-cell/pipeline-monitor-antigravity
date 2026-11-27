# AGENTS.md — 動手之前先讀這一頁

> **這一頁是「指標」，不是「事實」。** 具體內容住在別的檔案裡，這裡只負責告訴你
> **什麼時候該去讀哪一份**。任何在這裡被複製一次的事實，都會變成第二個真相來源
> 然後靜默過期。**發現這裡寫錯了，優先考慮把那句話刪掉，而不是更新它。**

---

## 這是什麼

一個給 **vibe coder**（不是工程師）用的產線監視器（**Antigravity 專用版**）。一個指令（`agy-pipeline`）回答三件事：
**我在哪、我回得去哪、這次動了多少。**

它與原版 Claude Code `pipeline-monitor` 完全隔離並行：
- 指令名：`agy-pipeline`
- 儀表板預設埠：`4320`（只綁 `127.0.0.1`）
- 資料家目錄：`~/.pipeline-monitor-agy/`
- Plugin 安裝位置：`~/.gemini/config/plugins/agy-pipeline`

它不依賴 TutorPod 或原版 `~/.pipeline-monitor/` 的任何東西。

**慣例**：註解、文件、commit 訊息一律繁體中文；註解偏重寫**為什麼**而不是做什麼。

## 使用者是誰，最壞的失敗是什麼

**Oscar 不是工程師。** 他看不懂 stack trace，也不該需要看懂。
任何把程式內部值（`null`、`undefined`、例外訊息）漏到畫面上的行為，都等於沒有畫面。

**最壞的失敗不是當機，是這個工具自己說謊。**

它存在的全部意義，就是讓人不必猜。**一個會說謊的儀表板，比沒有儀表板糟**——
沒有儀表板只是資訊不足，**假資料會主動阻止使用者去懷疑**。

---

## 三條紅線（不論你在改什麼，每次都適用）

| | 紅線 | 一句話判準 |
|---|---|---|
| **R1** | 不准把「**沒問到**」講成「**沒有**」 | 我這句話，在沒拿到答案的時候會不會變成謊話？ |
| **R2** | 不准把「**跑過**」講成「**通過**」 | 這個回饋唯一能證明的是什麼？指令被呼叫了？還是事情真的成了？ |
| **R3** | 不准**自己編數字** | 這個數字的分母，是查得到的事實，還是我編的？ |

**R1 是這個專案的頭號死法**（見 `docs/LESSONS.md` L2／L7／L8）。
其中兩次是同一個機制：**`git diff` 看不到還沒被 git 追蹤的新檔案。**

> 🔴 **改任何「數幾個檔案」的程式碼之前，先問：新檔案算進去了嗎？**
> `git diff` 不算。要 `git ls-files --others --exclude-standard`。
> 漏掉的方向永遠是**讓改動看起來比實際小**——那是危險的那一邊。

---

## 刻意的決定 —— 這些不是 bug，不要「順手修好」

**每一條看起來都剛好像你該修的東西。** 想改任何一條之前，先讀它後面的理由。

- **熱路徑（`hook.sh`）用 `/bin/sh` + `jq`，不用 node** —— node 啟動較慢，而它每個工具呼叫都要跑一次。
  **最不能壞的那一段，就該是沒有東西可以壞的那一段。**
- **感測器（`hook.sh`）只掛 `PostToolUse`、失敗一律輸出 `{}` 並靜默 `exit 0`；改檔把關由獨立的 `guard.sh`／`guard.mjs`（`PreToolUse`）負責，只在命中危險清單／設定讀不懂時回傳 `force_ask`，其餘與任何錯誤一律 0 bytes 空輸出＋`exit 0` 交回預設權限、絕不回 `"allow"`；但蓋章失敗必須大聲。**
  ⚠️ 感測器、改檔把關與蓋章看起來矛盾，是刻意的：**代價不對稱**。感測器漏記一筆只是少一行紀錄；把關若報錯或印出非空輸出會直接鎖死編輯；而「我以為我有還原點、其實沒有」會在最需要的時候害到人。
- **`hook.sh` 不過濾哪些 skill 算關卡，全部照記。**
  關卡清單只住在 `stages.json` 一份。兩個地方各自判斷，遲早給出不同答案。
- **不記代理成功旗標（`error`／`success`／`duration_ms`）。**
  那只代表工具或指令檔跑完，不代表「通過」，寫進去遲早會被畫成綠勾。
- **檔案數量一律用 git 算，不准用 hook 的紀錄算。**
  用終端機指令寫檔案（heredoc、`sed`）會繞過改檔工具。hook 的改檔紀錄只用來把檔案連回時間與對話；且 `read_file` 絕不當成改檔。
- **「跑過」用 `⏸` 不用 `✅`，而且一定印出過了多久。**
  未結案的事，時間越久要**越顯眼**，不是越像完成。
- **不自己編任何「太多／太大／太久」的門檻。** 比例尺一律從**那個專案自己的歷史**算。
- **樣本少於 5 次改動就不給比例尺。** 兩三個 commit 算出來的「平常」是雜訊，卻長得像有依據的基準。
- **`checkpoints/` 與 `logs/` 不進版控。** 章記的是「**在這台電腦上**跑過檢查」，換一台機器那句話就不成立。
- **`mountState` 分三態：`off` / `ok` / `broken`，不准折成布林。**
  「掛著」不等於「活著」——搬走資料夾後，hook 路徑指空會完全靜默地停止記錄。
- **五支 hook 契約分明：`hook.sh`（`PostToolUse`）永遠靜默輸出 `{}`；`guard.sh`／`guard.mjs`（`PreToolUse`）只在命中危險清單或設定讀不懂時回傳 `decision:"force_ask"`，其餘與出錯一律 0 bytes 空輸出＋`exit 0`；`escalate.sh`／`escalate.mjs`（`PreInvocation`）只在該輪首度升到最高級且有缺項時回傳純 `injectSteps`（`systemMessage`，絕不帶 `metadata.user_markdown`），其餘與出錯一律輸出 `{}`＋`exit 0`；`remind.sh`（`SessionStart`）只在對話開始、還沒設定分級時注入一行；`gate.sh`／`gate.mjs`（`Stop`）只在該跑的沒跑時回傳 `decision:"continue"` 一次。**
- **沒有清單就不分級；工具不猜危險清單。** 「改錯了會不會靜默丟資料」只有人判斷得了。
  沒設定要說「還沒設定」，不准折成最低那一級——那是 R1。危險清單空的要明講「永遠不會出現第三級」。
- **儀表板靠 launchd 常駐（`--serve-install`），不靠任何對話活著。** 更新程式之後要 `--serve-restart`。
- **未建的關照實說「未建」。** 一份把不存在的關卡畫得像存在的畫面，本身就是假回饋。
- **`lib/events.mjs` 只放紀錄的檔名、讀、90 天清理；讀出來之後的判斷放 `lib/rounds.mjs`、transcript 解析放 `lib/transcript.mjs`。** 前者在危險清單上，後兩者不在。

---

## 動手前該讀哪一份

| 情況 | 讀這個 |
|---|---|
| 整體要往哪走、六個死法是什麼 | [ROADMAP](docs/ROADMAP.md) |
| 「為什麼要寫成這樣？」 | [LESSONS](docs/LESSONS.md)——先搜關鍵字再問 |
| 犯過的錯**又**出現、想知道有哪些老毛病 | [FAILURE-PATTERNS](docs/FAILURE-PATTERNS.md)——測試的 `section()` 用它的代號標記，紅的時候會印出來 |
| 要動使用者看得到的文案 | 上面三條紅線，逐條套過一次；終端機與網頁都會講的句子只寫一份、住哪：[終端機與網頁說同一句](docs/升級摘要/終端機與網頁說同一句.md) |
| 做畫面／碰顏色、字體、間距 | [DESIGN](docs/DESIGN.md)（token 在 `ui設計規格/`，**畫面直接 import，不抄數值進程式碼**）；畫面做什麼、不做什麼：[pipeline-ui](docs/升級摘要/pipeline-ui.md)；便條紙、圓球工班、說明分層：[工地工班風畫面](docs/升級摘要/工地工班風畫面.md)；Antigravity 夜間工班暗色霓虹：[night-shift-ui-theme](docs/升級摘要/night-shift-ui-theme.md)；白天／夜間／自動切換：[dashboard-theme-toggle](docs/升級摘要/dashboard-theme-toggle.md) |
| 改還原點、改動體檢、「回去」指令、專案名→檔名；終端機哪個指令住哪一支 | [pipeline-status](docs/升級摘要/pipeline-status.md)、[誠實修補](docs/升級摘要/誠實修補.md)、[終端機照指令拆開](docs/升級摘要/終端機照指令拆開.md)；網頁第三張卡（commit 了沒、蓋章了沒）與還原點那句警告：[先講commit再講蓋章](docs/升級摘要/先講commit再講蓋章.md) |
| 改感測器（`hook.sh`、`lib/events.mjs`）、90 天清理 | [pipeline-sensor](docs/升級摘要/pipeline-sensor.md)、[90天清理不丟紀錄](docs/升級摘要/90天清理不丟紀錄.md)、[紀錄與判斷分家](docs/升級摘要/紀錄與判斷分家.md)；清完之後畫面怎麼講：[90天清空之後的說法](docs/升級摘要/90天清空之後的說法.md) |
| 裝到新的專案 | 裝成 plugin 一次就好（`agy-pipeline --install`），不想記的專案 `--off`：[plugin](docs/升級摘要/plugin.md)；舊接法：[sensor-install](docs/升級摘要/sensor-install.md) |
| 分享給別人（紀錄搬家、雙語、公開、上架、非 Claude） | [ROADMAP](docs/ROADMAP.md)「分享給別人」；第 1 段：[紀錄搬到固定的家](docs/升級摘要/紀錄搬到固定的家.md)；第 2 段雙語：[儀表板與終端機中英切換](docs/升級摘要/儀表板與終端機中英切換.md)、[技能與寫給AI的話中英切換](docs/升級摘要/技能與寫給AI的話中英切換.md)；鍵盤切中英：[dashboard-language-shortcut](docs/升級摘要/dashboard-language-shortcut.md) |
| 改收工 hook（`gate.mjs`）、五關怎麼辨識與結案 | [五關自動結案](docs/升級摘要/五關自動結案.md) |
| plugin 帶的 A／C／D skill；C、D 看哪些檔 | [通用三關](docs/升級摘要/通用三關.md)、[skill範圍跟收工hook對齊](docs/升級摘要/skill範圍跟收工hook對齊.md) |
| D 要不要再跑；A 寫完規格後 D 先預審 | [D多輪先問人](docs/升級摘要/D多輪先問人.md)；[spec-chaos-precheck](docs/升級摘要/spec-chaos-precheck.md) |
| E 驗收 | [E自動驗收](docs/升級摘要/E自動驗收.md) |
| 「這一輪」從哪算起、新對話接手舊資料夾、從 main 併進來的算不算 | [這一輪的起點](docs/升級摘要/這一輪的起點.md)、[新對話接手舊資料夾](docs/升級摘要/新對話接手舊資料夾.md)、[多份規格與新資料夾的起點](docs/升級摘要/多份規格與新資料夾的起點.md)；從 main 併進來、別的對話寫的檔：[併進來的不算這一輪](docs/升級摘要/併進來的不算這一輪.md) |
| 這一輪照哪份規格（別的對話寫的、搬過家、一輪好幾份） | [施工對話認規格](docs/升級摘要/施工對話認規格.md)、[規格搬家](docs/升級摘要/規格搬家.md)、[多份規格與新資料夾的起點](docs/升級摘要/多份規格與新資料夾的起點.md) |
| 分級、危險清單 | [分級](docs/升級摘要/分級.md)（沒有清單就不分級，工具不猜危險清單）、[危險清單會過期](docs/升級摘要/危險清單會過期.md)、[收工hook問危險清單](docs/升級摘要/收工hook問危險清單.md)；改危險檔前即時 `force_ask` 把關（v0.2）：[danger-guard-force-ask](docs/升級摘要/danger-guard-force-ask.md)；改到一半碰到危險檔動態升級通知 AI：[tier-escalation-notify](docs/升級摘要/tier-escalation-notify.md) |
| 誰說的話才算你說的、感測器或收工 hook 壞了 | [agent回報與故障記號](docs/升級摘要/agent回報與故障記號.md)；各資料夾各自留心跳不讓舊黃燈復活：[per-cwd-heartbeat](docs/升級摘要/per-cwd-heartbeat.md)；`ask_question` 一鍵決策卡解析：[ask-question-decision-cards](docs/升級摘要/ask-question-decision-cards.md) |
| 儀表板刷新慢、改怎麼叫 git | [儀表板刷新少等git](docs/升級摘要/儀表板刷新少等git.md) |
| 歷史：Claude Desktop app 建議卡規格（歸檔參考） | [app建議卡](docs/升級摘要/app建議卡.md)、[app建議卡換工具](docs/升級摘要/app建議卡換工具.md)、[建議卡開的對話認得出已開始](docs/升級摘要/建議卡開的對話認得出已開始.md)、[當場問的卡也收進來](docs/升級摘要/當場問的卡也收進來.md) |
| 案件頁的「還差什麼」白板、F 工地主任、`--todo`；主任（建議下一步、開卡、收尾） | [還差什麼總表](docs/升級摘要/還差什麼總表.md)；主任技能（第二段）：[主任技能](docs/升級摘要/主任技能.md)；主任動手收尾（第三段）：[主任動手收尾](docs/升級摘要/主任動手收尾.md)；F 那一格改條列、寫規格時不亮燈、工班戴工地帽：[主任條列與工地帽](docs/升級摘要/主任條列與工地帽.md) |
| Antigravity 專用版（方案 B）移植與地基 | v0.1 地基（感測器、收工門禁、看板、rules、6 支 skill）：[antigravity-v01-foundation](docs/升級摘要/antigravity-v01-foundation.md) |
| 多 worktree 並發改動衝突偵測 | [worktree-conflict-detection](docs/升級摘要/worktree-conflict-detection.md) |
| 定時工地巡檢晨報（`--brief`／`--quiet-if-clear`）與首頁晨報卡 | [brief-patrol-command](docs/升級摘要/brief-patrol-command.md)；儀表板首頁晨報卡：[dashboard-brief-card](docs/升級摘要/dashboard-brief-card.md) |
| 對話 Context Token 真實量表與歷史比例尺 | [context-token-scale](docs/升級摘要/context-token-scale.md) |
| 舊規格與已知死法即時反查（`--round precheck`／`--round D`／`--context`） | [legacy-spec-lookup](docs/升級摘要/legacy-spec-lookup.md) |
| 工地復盤官技能（`retrospect`）與近期卡關純事實盤點（`--retrospect`） | [retrospect-skill](docs/升級摘要/retrospect-skill.md) |

每一列只寫「什麼情況、讀哪一份」。結案日期、實況還沒看過、還待你決定的事，寫在那份規格自己的施作紀錄裡——
寫在這裡就是第二個真相來源，而且這一頁每個對話都會整份讀一次。新的規格放進最貼近的那一列；找不到才開新的一列。

## 工作項的狀態就是路徑

```
決定要做  → docs/規劃中/<功能>.md
開工了    → 搬到 docs/進行中/     ⚠️ 上限 2 個，測試會擋
完成      → 搬到 docs/升級摘要/   ＋ 升版（見下）
```

**搬檔案騙不了人**，所以不要另開 LOG 檔、不要在 front matter 放 `status:` 欄位。
施作紀錄**往同一個檔案下面追加**。

**完成那一刻順便升版**：`package.json`（與 `plugin.json`）的 version 中間那碼 +1，施作紀錄最後寫一行「上線版本：vX.Y.Z」；
沒寫規格的小修只升最後那碼；第一碼等「別人要裝」那天才動。號碼只住 `package.json`（儀表板的還原點直接讀它），
不另開 CHANGELOG——升級摘要就是。忘了升、或兩個對話同時結案搶到同一個號碼，`npm test` 會紅。

⚠️ **新增或搬動 `docs/` 底下的檔案，必須同步改 `AGENTS.md` 上面那張表**，
否則 `npm test` 會紅。這兩件事是同一個動作的兩半——**只做前一半，測試就是紅的**。

## 改完之後

```bash
npm test        # 文件索引 + status 的誠實不變條件 + Antigravity 感測器／門禁契約
```

**推上 GitHub 之前**：`npm run test:clean`——在乾淨的副本再跑一次（為什麼見 LESSONS L24）。

⚠️ **測試刻意只釘「會安靜說謊」的地方**，**不釘長相**。長相壞了看得見；這幾條壞了測試全綠、畫面照跑。

- **改到使用者看得到的文案**：三條紅線逐條套一次
- **踩到新坑**：寫進 `docs/LESSONS.md`（門檻是能回答「下次什麼情況會再犯」）
- **同一類錯誤犯第二次**：寫進 [`docs/FAILURE-PATTERNS.md`](docs/FAILURE-PATTERNS.md)，
  **並把釘它的測試 `section()` 標上那個代號**——測試紅的時候會把老毛病印在 ✗ 底下。

---

## 絕對不要做

- ❌ **在文件裡寫量測值**（「現在約 400 行」）—— 判準是「這個數字會影響任何決策嗎？」
- ❌ **把程式的內部值印給使用者看**（`null`、例外訊息、檔案路徑以外的技術名詞）
- ❌ **讓 `hook.sh` 回傳非零、或輸出 `{}` 以外的任何東西** —— 它會拖累使用者跟 Antigravity 的對話
- ❌ **依賴 TutorPod 或原版 `~/.pipeline-monitor/` 的任何檔案、腳本或設定**
- ❌ **在 `status.mjs` 與 `lib/cli*.mjs` 裡寫死任何專案專屬的字串**（`spec`／`cleanup`／`chaos-check` 只准出現在 `stages.json`）
