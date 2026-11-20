# agy-pipeline（Pipeline Monitor for Antigravity）

一個指令看完：**我在哪、我回得去哪、這次動了多少。**

本版本為專職 Google Antigravity 的獨立產線監視器（CLI 指令 `agy-pipeline`、儀表板 `http://127.0.0.1:4320`、資料家目錄 `~/.pipeline-monitor-agy/`），與原版 Claude Code `pipeline-monitor`（埠號 4319、`~/.pipeline-monitor/`）完全隔離、互不干擾。

規格與開發地圖：看 [`AGENTS.md`](AGENTS.md)「動手前該讀哪一份」那張表。那張表有測試守著；這裡不另抄一份路徑，抄了會靜默過期。

## 安裝（一行，加到 `~/.zshrc`）

```sh
alias agy-pipeline='node "/Users/oscarhsieh/Desktop/pipeline-monitor for antigravty/status.mjs"'
```

存檔後開新終端機（或 `source ~/.zshrc`）。

> 為什麼不用 `npm link`：這台機器的 npm 全域目錄是 `/usr/local`，寫入要 sudo。
> 一個「看狀態」的小工具不值得動到系統目錄。

## 用法

```sh
agy-pipeline              # 看現況（還原點 + 改動體檢 + 五關）
agy-pipeline --checkpoint # 跑完整檢查，全綠就蓋一個還原點
agy-pipeline --clear E    # 記下「E 驗收過了」（A 到 D 由儀表板自動辨識）；AI 替你記要附你的原話：--clear E "你的原話"
agy-pipeline --spec <規格檔>  # 照別的對話寫好的規格施工：AI 在施工的對話裡記一筆照哪份（--spec 無＝沒有照哪份）
agy-pipeline --round D    # D 這一輪第幾次、怎麼跑、第一次之後改了哪些檔（AI 跑 D 的第一步；問你要不要再跑之前也看它）
agy-pipeline --decide D skip "你的原話"   # 你說這一輪不用再跑 D：AI 代記，儀表板附你在 D 之後說的最後一句
agy-pipeline --round E    # E 驗收這一輪照哪份規格、要驗哪幾條、第幾趟、專案怎麼跑起來（AI 跑 verify 的第一步）
agy-pipeline --report E ok|found "…"   # AI 記下走一遍的結論：第一行摘要，之後一行一條（AC-1 看到了：「原文」／沒看到／驗不了）
agy-pipeline --todo       # 還差什麼：所有專案的對話各還差什麼（在 Antigravity 終端機裡跑時，那個對話那一行標「← 這個對話」）
agy-pipeline --cards      # 這個專案的每一張新對話建議卡：還沒開始、已開始、你說不做了（主任開卡之前查有沒有了）
agy-pipeline --suggest "標題"  # 放一張「建議另開對話」的卡片到儀表板（內容從 stdin 讀）
agy-pipeline --wrap merge|push|restart|stamp "你的原話"   # 主任收尾：你回答之後一步一次（併進 main 只快轉、推完當場問 GitHub、改過才重啟、D 沒了結不蓋章），每一步講成了沒
agy-pipeline --on         # 把感測器掛到**這個**專案的 .agents/hooks.json（--off 拆掉；已裝 plugin 時改控制退出記錄）
agy-pipeline --tier-init  # 設定分級的骨架（程式區）；危險清單在對話裡說「幫我設定分級」
agy-pipeline --tier T2 "理由"   # 這次調高（只准往上）；收回是 --tier-retract
agy-pipeline --serve-install  # 儀表板裝成背景服務（見「網頁版」）
agy-pipeline --lang en    # 換成英文（--lang zh 換回中文；不帶字講現在是哪一種）。儀表板右上角那顆按鈕、在儀表板上按 L，改的都是同一份
```

### 裝感測器與技能（Antigravity plugin，在終端機裝一次就好）

```sh
agy-pipeline --install
```

它在 `~/.gemini/config/plugins/agy-pipeline` 放一個捷徑指向這個資料夾，Antigravity 會一次載入：
- **Hooks**（`hooks.json`）：`SessionStart`（`remind.sh`）、`PreToolUse`（`guard.sh`／`guard.mjs`：改危險清單前強制彈窗問你確認）、`PostToolUse`（`hook.sh`）、`Stop`（`gate.sh`）
- **常駐規則**（`rules/AGENTS.md`）：五關紀律、三條紅線、何時跑 `agy-pipeline` 指令
- **6 支通用技能**（`skills/*/SKILL.md`）：`spec`、`cleanup`、`chaos-check`、`verify`、`tier-setup`、`director`

拆掉用 `agy-pipeline --uninstall`。

> ⚠️ `~/.gemini/config` 受沙盒保護，請在**你自己的終端機**執行 `--install`／`--uninstall`。
> 工具只能確認「捷徑放好了」，**不能確認 Antigravity 真的載入了**——重開新對話才會生效。
> 驗證方法：開一個 git 專案的新對話做一次工具動作，回來跑 `agy-pipeline`，
> 感測器那一行出現「最後一筆來自這裡的紀錄：N 分鐘前」就是通了。

**不想記某個專案**：在那個資料夾跑 `agy-pipeline --off`，或按儀表板上那個專案的「退出記錄」。
它會在主資料夾放一個記號檔 `.agents/pipeline-monitor.off`（同時相容 `.claude/pipeline-monitor.off`），hook 看到就不記，**按下去馬上生效**；回來用 `--on` 或「重新加入記錄」。

「掛在哪」看設定，「活著嗎」看紀錄——兩件事分開講，證據跟設定打架時證據贏。

### plugin 帶的 6 支技能（通用版）

| 技能 | 做什麼 | 不做什麼 |
|---|---|---|
| `spec` | A 寫規格：一句需求 → 一頁可以打勾的驗收條件，寫到 `docs/規劃中/`，停下來等你點頭 | 不寫程式、不改既有檔案 |
| `cleanup` | C 打掃：只刪證明得出來是死的東西，其餘出建議清單 | 不碰測試檔、不改控制流 |
| `chaos-check` | D 魔鬼教官：拿這個專案自己的 `docs/FAILURE-PATTERNS.md` 對照這次改動 | 不改檔案、**不說「通過」** |
| `verify` | E 驗收：照這一輪的規格在畫面上走一遍（透過 Antigravity 內建 `browser` subagent），每條記看到了（附畫面原文）／沒看到／驗不了 | 不改程式、不存截圖、**不說「驗收過了」**（那句只有你能說） |
| `tier-setup` | 分級設定與危險清單維護 | 不替你決定危險清單 |
| `director` | F 工地主任：讀 `agy-pipeline --todo`，給**一個**下一步，把收尾合成一個問題，你回答後才用 `--wrap` 一步一步做 | 不給選單、不替你按結案 |

它們是**通用版**：不知道你的專案的任何事。專案專屬的內容（死法清單、教訓、規格範本、分級、要跑的檢查）
一律從那個專案自己的檔案讀（`AGENTS.md`／`GEMINI.md`／`CLAUDE.md`／`README.md`／`docs/`）；讀不到就退回三條紅線（R1 沒問到≠沒有、R2 跑過≠通過、R3 不編數字），並在回覆裡說用的是哪一套。

## 分級：這次要多小心

分級是**這一次改動**的屬性，每次看都重新算。依據是這次改的檔案落在哪裡，對兩張**人寫的**清單查表（優先讀專案的 `.agents/pipeline-stages.json`，相容 fallback 讀 `.claude/pipeline-stages.json`）：

| 清單 | 意思 |
|---|---|
| 程式區 `tiers.code` | 程式住的資料夾；碰到 → 第二級（預設 T1，需要 D） |
| 危險清單 `tiers.danger` | 改錯了**不會馬上看見、幾天後才發現使用者的東西壞了**的檔案；碰到 → 第三級（預設 T2，需要 A、D、這次要有測試檔） |

三級的名字與「需要哪幾關」預設在 `stages.json` 的 `tierLevels`，專案可用 `tiers.levels` 覆寫。

- **沒有清單就不分級。** 畫面說「還沒設定」，不會預設最低那級。對話開始時會提醒一次；說「這個專案不用分級」就不再提。
- **危險清單工具不猜。** 在對話裡說「幫我設定分級」，AI 讀程式提清單、你確認。清單空的時候畫面明講「永遠不會出現第三級」。
- **給的是下限。** 只准往上調（`--tier T2 "理由"`，或儀表板的「調高」，理由必填），收回只收回你自己調的；往下要改設定檔。
- 「需要」那幾行只講**有沒有紀錄**，不講通過。不擋蓋章，只標紅。

## 網頁版

```sh
agy-pipeline --serve-install   # 裝成背景服務：開機自動起、掛了自動重啟，http://127.0.0.1:4320 永遠在
agy-pipeline --open            # 用瀏覽器打開
agy-pipeline --serve-restart   # 更新程式（git pull／merge）之後要重啟，它才會跑新的
agy-pipeline --serve-status    # 裝了沒、載入了沒、活著沒——三件事分開講
npm start                      # 不裝服務的話：這個視窗開著它就活著
```

⚠️ 服務跟 `npm start` 不能同時開（同一個埠 `4320`，可用 `AGY_PIPELINE_PORT` 覆寫）。背景服務標籤為 `com.pipeline-monitor-agy.dashboard`，輸出在 `~/Library/Logs/pipeline-monitor-agy/dashboard.log`。

⚠️ **只綁 127.0.0.1，而且刻意不提供對外的開關。** 同時阻擋非本機 Host、跨站寫入請求與 iframe 嵌入（LESSONS L28）。

⚠️ **畫面隨時會說出「這些資料是什麼時候的」，斷線時整頁會承認。**

## 感測器與即時把關（PreToolUse ＋ PostToolUse ＋ Transcript 補齊）

`hook.sh` 掛在 Antigravity 的 `PostToolUse` hook 上，工具動作一發生就記一行到 `~/.pipeline-monitor-agy/logs/<專案>.jsonl`；獨立的 `guard.sh`／`guard.mjs` 掛在 `PreToolUse` 上，只在寫／改檔工具即將動到 `tiers.danger` 危險清單上的檔案（或分級設定檔讀不懂）時回傳 `force_ask` 強制跳出確認視窗（不受「總是允許」快取影響），其餘情況與出錯一律 0 bytes 空輸出＋`exit 0` 交回 Antigravity 原本權限、絕不回 `"allow"`。改檔把關守的是寫／改檔工具，用終端機指令繞道改檔它看不到，收工前仍由 `Stop` 門禁依 git 事實查核。

- 熱路徑是 **`/bin/sh` + `jq`**，不是 node；單筆 `< 4096 bytes`，**失敗一律靜默、永遠 `exit 0` 並輸出 `{}`**，絕不影響對話。
- 同時支援 Antigravity 新版工具（`read_file`、`write_file`、`edit_file`、`run_command`、`ask_question`、`send_message`、`invoke_subagent`）與舊版別名（`view_file`、`write_to_file`、`replace_file_content`、`multi_replace_file_content`）。
- 讀取端（`lib/transcript.mjs`）會搭配 Antigravity 的 `transcript.jsonl` 補齊人類真實發言（`source: USER_EXPLICIT`）並辨識 subagent（不把子 agent 算成另一個人類對話，且把 `browser` subagent 的活動歸回主對話 E 關）。
- **只記「跑過」，不記「通過」。** 關卡清單只住在 `stages.json` 一份；專案可用 `.agents/pipeline-stages.json`（相容 `.claude/pipeline-stages.json`）覆寫。
- 紀錄**每個專案一份**，保留三個月。

## 紀錄放哪

紀錄、還原點與語言設定住在 `~/.pipeline-monitor-agy/`（`logs/<專案>.jsonl`、`checkpoints/<專案>__<分支>.json`、`lang.json`），權限 `0700`（只有你自己的帳號讀得到），與程式資料夾分離。

章是**本機事實**：它記的是「在這台電腦上跑過檢查」。換一台電腦那句話就不成立，所以不進版控。
