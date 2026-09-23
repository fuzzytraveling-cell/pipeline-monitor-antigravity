# pipeline-monitor

一個指令看完：**我在哪、我回得去哪、這次動了多少。**

規格在哪：看 [`CLAUDE.md`](CLAUDE.md)「動手前該讀哪一份」那張表。那張表有測試守著；這裡不另抄一份路徑，抄了會靜默過期。

## 安裝（一行，加到 `~/.zshrc`）

```sh
alias pipeline-status='node "/Users/oscarhsieh/Desktop/pipeline-monitor/status.mjs"'
```

存檔後開新終端機（或 `source ~/.zshrc`）。

> 為什麼不用 `npm link`：這台機器的 npm 全域目錄是 `/usr/local`，寫入要 sudo。
> 一個「看狀態」的小工具不值得動到系統目錄。

## 用法

```sh
pipeline-status              # 看現況（還原點 + 改動體檢 + 五關）
pipeline-status --checkpoint # 跑完整檢查,全綠就蓋一個還原點
pipeline-status --clear E    # 記下「E 驗收過了」（A 到 D 由儀表板自動辨識,不用你按）
pipeline-status --spec <規格檔>  # 照別的對話寫好的規格施工：Claude 在施工的對話裡記一筆照哪份（--spec 無＝沒有照哪份）
pipeline-status --round D    # D 這一輪第幾次、怎麼跑、第一次之後改了哪些檔（Claude 跑 D 的第一步；問你要不要再跑之前也看它）
pipeline-status --decide D skip "你的原話"   # 你說這一輪不用再跑 D：Claude 代記，儀表板附你在 D 之後說的最後一句
pipeline-status --on         # 把感測器掛到**這個**專案（--off 拆掉）
pipeline-status --tier-init  # 設定分級的骨架（程式區）；危險清單在對話裡說「幫我設定分級」
pipeline-status --tier T2 "理由"   # 這次調高（只准往上）；收回是 --tier-retract
pipeline-status --serve-install  # 儀表板裝成背景服務（見「網頁版」）
```

### 裝感測器（plugin，裝一次就好）

```sh
pipeline-status --install
```

它在 `~/.claude/skills/pipeline-monitor` 放一個捷徑指向這個資料夾，Claude Code 會把它當 plugin 載入：
**之後每個專案都自動記**，不用再到各專案掛。拆掉用 `--uninstall`。

⚠️ 它只能確認「捷徑放好了」，**不能確認 Claude Code 真的載入了**——
下一個對話才會生效（現有的對話打 `/reload-plugins`）。
驗證方法：隨便開一個 git 專案的新對話打一句話，回來跑 `pipeline-status`，
感測器那一行出現「最後一筆來自這裡的紀錄：N 分鐘前」就是通了。

**不想記某個專案**：在那個資料夾跑 `pipeline-status --off`，或按儀表板上那個專案的「退出記錄」。
它只是在主資料夾放一個記號檔 `.claude/pipeline-monitor.off`，hook 看到就不記，**按下去馬上生效**；
之前的紀錄還在。回來用 `--on` 或「重新加入記錄」。

⚠️ plugin 之前用 `--on` 掛過的專案會**記兩次**——到那個專案跑一次 `pipeline-status --on`，會把舊接法拆掉。
沒裝 plugin 的話 `--on`／`--off` 還是走舊接法（寫進那個專案的 `.claude/settings.local.json`，合併不覆蓋、動手前備份）。

「掛在哪」看設定，「活著嗎」看紀錄——兩件事分開講，證據跟設定打架時證據贏。

### plugin 帶的三關指令（通用版）

裝了 plugin 之後，每個專案都多三支指令，對應五關的 A／C／D：

| 指令 | 做什麼 | 不做什麼 |
|---|---|---|
| `/pipeline-monitor:spec` | A 寫規格：一句需求 → 一頁可以打勾的驗收條件，寫到 `docs/規劃中/`，停下來等你點頭 | 不寫程式、不改既有檔案 |
| `/pipeline-monitor:cleanup` | C 打掃：只刪證明得出來是死的東西，其餘出建議清單 | 不碰測試檔、不改控制流 |
| `/pipeline-monitor:chaos-check` | D 魔鬼教官：拿這個專案自己的 `docs/FAILURE-PATTERNS.md` 對照這次改動 | 不改檔案、**不說「通過」** |

它們是**通用版**：不知道你的專案的任何事。專案專屬的內容（死法清單、教訓、規格範本、分級、要跑的檢查）
一律從那個專案自己的檔案讀；讀不到就退回三條紅線（沒問到≠沒有、跑過≠通過、不編數字），並且會在回覆裡說用的是哪一套。

**專案自己有同名指令時兩邊並存**（例如 TutorPod 的 `/spec` 跟 `/pipeline-monitor:spec`）：你叫哪個就跑哪個，誰也不會蓋掉誰。
感測器記到的名字不一樣（`spec` 與 `pipeline-monitor:spec`），但讀取端**兩種都算同一關**——五關的 A 不會因為你叫的是 plugin 版就沒亮。

⚠️ 跟感測器一樣，工具只能確認「檔案在 plugin 裡」，不能確認 Claude Code 載入了——新對話才會生效（現有的打 `/reload-plugins`）。
差異表與規格：通用三關（路徑看 `CLAUDE.md` 的表）。

## 分級：這次要多小心

分級不是專案的屬性，是**這一次改動**的屬性，每次看都重新算。依據只有一個問題——這次改的檔案落在哪裡——
對兩張**人寫的**清單查表（住在那個專案的 `.claude/pipeline-stages.json`）：

| 清單 | 意思 |
|---|---|
| 程式區 `tiers.code` | 程式住的資料夾；碰到 → 第二級（預設 T1，需要 D） |
| 危險清單 `tiers.danger` | 改錯了**不會馬上看見、幾天後才發現使用者的東西壞了**的檔案；碰到 → 第三級（預設 T2，需要 A、D、這次要有測試檔） |

三級的名字與「需要哪幾關」預設在 `stages.json` 的 `tierLevels`，專案可用 `tiers.levels` 覆寫。

- **沒有清單就不分級。** 畫面說「還沒設定」，不會預設最低那級。對話開始時 Claude 會提醒一次；說「這個專案不用分級」就不再提。
- **危險清單工具不猜。** 在對話裡說「幫我設定分級」，Claude 讀程式提清單、你確認。清單空的時候畫面明講「永遠不會出現第三級」。
- **給的是下限。** 檔名看不出你改了一個字還是重寫。只准往上調（`--tier T2 "理由"`，或儀表板的「調高」，理由必填），
  收回只收回你自己調的；往下要改設定檔。調高跟著這一輪走：有章時蓋章之後、沒章時下一次 A 開始新的一輪才歸零，存檔不算
  （找不到這一輪起點的時候，存檔就歸零）。
- 「需要」那幾行只講**有沒有紀錄**，不講通過。不擋蓋章，只標紅。

## 網頁版

```sh
pipeline-status --serve-install   # 裝成背景服務：開機自動起、掛了自動重啟，http://127.0.0.1:4319 永遠在
pipeline-status --open            # 用瀏覽器打開
pipeline-status --serve-restart   # 更新程式（git pull／merge）之後要重啟，它才會跑新的
pipeline-status --serve-status    # 裝了沒、載入了沒、活著沒——三件事分開講
npm start                         # 不裝服務的話：這個視窗開著它就活著
```

它是一個網頁，不是一個 app。想要像 app 一樣點圖示：Safari 打開那個網址 → 「檔案」→「加入 Dock」。
⚠️ 服務跟 `npm start` 不能同時開（同一個埠）。服務自己的輸出在 `~/Library/Logs/pipeline-monitor/dashboard.log`。

一頁看完**這台機器上所有有紀錄的專案**。它只列出**有證據的**專案
（有紀錄檔或有還原點的），不去掃你的硬碟猜你有哪些 repo。

⚠️ **只綁 127.0.0.1，而且刻意不提供對外的開關。** 這個畫面看得到你所有專案的
路徑、分支、你打過的字。

⚠️ **畫面隨時會說出「這些資料是什麼時候的」，斷線時整頁會承認。**
終端機版天生誠實（你剛打完指令）；網頁開三小時卻長得一模一樣——
那是這個產品唯一有能力安靜騙人的地方，所以那段邏輯抽成純函式並被測試釘住。

## 感測器（五關的時間戳）

`hook.sh` 掛在 Claude Code 的 hook 上，指令一被呼叫就記一行到 `logs/<專案>.jsonl`。

- 熱路徑是 **`/bin/sh` + `jq`**，不是 node——最不能壞的那一段就該是沒有東西可以壞的那一段。
- **失敗一律靜默、永遠 `exit 0`**，絕不影響你跟 Claude 講話。
- **只記「跑過」，不記「通過」。** `tool_response.success` 與 `duration_ms`
  刻意不取——前者只代表指令檔讀進來了，後者只是載入時間。
- 關卡清單只住在 `stages.json` 一份；**hook 本身不過濾**，全部照記。
  專案可用 `.claude/pipeline-stages.json` 覆寫。
- 紀錄**每個專案一份**，保留三個月。

### 感測器有一個「開始的日期」

它裝好之前發生的事情，**一輩子都不會知道**。所以畫面寫的是「沒有紀錄」而不是
「沒跑過」——這兩件事不一樣，混為一談就會害你重跑已經跑過的檢查，或以為驗過了其實沒有。

在**任何 git 專案的資料夾裡**都可以跑，不限 TutorPod。
要跑哪些檢查是從那個專案自己的 `package.json` 認的（`lint` / `test` / `test:unit` / `build`
有哪些就跑哪些），**沒有寫死任何 TutorPod 專屬的東西**。

## 它刻意不做的事

- **不說「這個版本確定能動」**，只說「這幾項檢查全綠」。
  檢查全綠不等於功能正確——TutorPod v4.15.4 的 `commitLesson` 就是測試全綠但整堂課靜默消失。
- **不自己編「改太多／太久」的門檻。** 只報數字，並拿**這個專案自己的歷史**當比例尺。
  一個會亂叫的工具，你三天後就不看了。
- **不幫你 commit、不幫你 reset、不幫你 push。** 只印出指令，按下去的是你。
- **工作區是髒的時候不准蓋章。** 那時候的綠是「你桌上這一份」的綠，
  不屬於任何一個存檔點——蓋下去就是把綠掛在一個沒被測過的版本上。

## 紀錄放哪

`checkpoints/<專案>__<分支>.json`，已 gitignore。

章是**本機事實**：它記的是「在這台電腦上跑過檢查」。換一台電腦那句話就不成立，
所以不進版控。
