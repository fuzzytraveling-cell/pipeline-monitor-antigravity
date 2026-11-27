# ROADMAP —— Antigravity 專用產線監視器（`agy-pipeline`）路線圖

> ⚠️ **這份不是規格，是總路線圖與設計邊界。沒有驗收條件，因為那住在各自的規格裡。**
> 「一份猜出來的規格比沒有規格更危險，它看起來像是想清楚了。」
> **每一攤開工前先寫規格**，產出放 `docs/規劃中/`，點頭開工才搬進 `docs/進行中/`，結案升版後歸檔進 `docs/升級摘要/`。
>
> **歷史分叉脈絡**：本產品源自原版 Claude Code `pipeline-monitor`（2026-09-08 起草，先後經歷 `TutorPod` 試驗場、獨立 repo 與 `v0.1`–`v0.41` 演進）；**2026-11-20 起正式分叉為專職 Google Antigravity 的獨立產線監視器（`agy-pipeline`）**，指令、背景服務（`127.0.0.1:4320`）與本機資料家（`~/.pipeline-monitor-agy/`）全面隔離並行，零外部 npm 相依。

---

## 一句話目標與核心哲學

**讓「我在哪、我回得去哪、這次動了多少」不必靠記憶、也不必往上捲對話。**

使用者（Oscar）不是傳統工程師，不該需要讀懂 stack trace。**最壞的失敗不是當機，是工具自己說謊**——沒有儀表板只是資訊不足，假資料會主動阻止人懷疑。

### 三條紅線（每次對話與每行文案都適用）

| 代號 | 紅線 | 一句話判準 |
|---|---|---|
| **R1** | 不准把「**沒問到**」講成「**沒有**」 | 沒拿到答案或讀不到權限時明講問不到／看不到 |
| **R2** | 不准把「**跑過**」講成「**通過**」 | 「跑過」用 `⏸` 並印出過了多久；「驗收過了」只有人能說 |
| **R3** | 不准**自己編數字** | 沒有查得到根據的分母，不給進度百分比、不估耗時、不編門檻 |

### 三層架構（順序不能顛倒）

```
  ① 感測器＋轉錄檔補齊（hook.sh / guard / escalate / gate / remind / transcript.mjs）
        ↓  記下誰在什麼時候呼叫了什麼（不記成功旗標）
  ② 大腦（status.mjs + lib/*.mjs）
        ↓  把紀錄 × git 事實 × 規格清單 算成人話，不猜測
  ③ 畫面與任務調度（server.mjs 4320 看板 + 8 支通用技能 + F 工地主任）
```

---

## Vibe Coder 的六個結構性死法（優先序來源）

| 代號 | 死法 | 產線監視器提供的真實事實 |
|---|---|---|
| **V1** | **「我回不去了」** | 還原點（`--checkpoint`）：最後一次檢查全綠且已 commit 的版本＋附 `cd` 與備份分支的還原指令 |
| **V2** | **改動範圍失控** | 改動體檢：這一輪實際動了幾支檔、幾行（依專案歷史比例尺，樣本 `< 5` 不給比例尺） |
| **V3** | **有東西被安靜刪掉** | 淨減行數顯著呈現（`git diff --stat`） |
| **V4** | **測試被改成配合實作** | 同一輪同時改到測試檔與被測程式時主動標示 |
| **V5** | **線上跑的不是這一份** | 預留給有遠端部署檢查需求的專案另外寫規格驗證 |
| **V6** | **相依越裝越多** | 監看 `package.json` 相依變動（本產品自身堅守零外部相依） |

### 按「會不會說謊」分級的功能地圖

- **🟢 第一級（純事實，不可能說謊）**：三階梯（commit / merge / push）、`規劃中/` 與 `進行中/`（上限 2 個）規格數、分支與 HEAD、還原點、誠實任務板 6 欄狀態推導。
- **🟡 第二級（帶時間戳的事件）**：A／C／D／E 最後呼叫與結論時間戳、對話標題與首句摘要、本輪動過的檔案路徑、跨 worktree 同檔衝突警示。
- **🟠 第三級（必須配時間戳與邊界，否則會過期）**：Context Token 真實量表與歷史比例尺、測試／D／E 結論「之後又改了 N 個檔案」。
- **🔴 第四級（絕對不做）**：「整體進度 87%」假百分比、「執行中」假燈號、「E ✅ 通過／安全」假綠勾。

---

## Antigravity 專用版已上線里程碑（`v0.1.0` – `v0.15.0`）

| 版本 | 里程碑 | 規格摘要 |
|---|---|---|
| **v0.1.0** | **Antigravity 原生地基**：獨立門牌（`agy-pipeline`／`4320`／`~/.pipeline-monitor-agy/`）、`.agents/` 雙路徑、`PostToolUse` 感測器、`transcript.jsonl` 解析（人話與 subagent 歸屬）、`SessionStart`＋`Stop` 門禁、6 支原生技能與 `rules/AGENTS.md` | [antigravity-v01-foundation](升級摘要/antigravity-v01-foundation.md) |
| **v0.2.0** | **危險清單即時把關**：`PreToolUse`（`guard.sh`／`guard.mjs`）改寫 `tiers.danger` 前強制 `force_ask` 彈窗確認 | [danger-guard-force-ask](升級摘要/danger-guard-force-ask.md) |
| **v0.3.0** | **A → D 規格預審**：寫完預測最高級規格後、動手前先由魔鬼教官獨立對照已知死法，紀錄與程式 D 徹底隔離 | [spec-chaos-precheck](升級摘要/spec-chaos-precheck.md) |
| **v0.4.0** | **動態分級升級通知**：`PreInvocation`（`escalate.sh`／`escalate.mjs`）在改到危險檔升至最高級時即時通知 AI 補齊關卡 | [tier-escalation-notify](升級摘要/tier-escalation-notify.md) |
| **v0.5.0 – v0.6.0** | **夜間工班霓虹與三模式風格切換**：暗色霓虹主視覺＋白天／夜間／離線日出日落自動換班（快捷鍵 `T`） | [night-shift-ui-theme](升級摘要/night-shift-ui-theme.md)、[dashboard-theme-toggle](升級摘要/dashboard-theme-toggle.md) |
| **v0.7.0 – v0.7.1** | **多資料夾獨立心跳與門禁兜底**：`byCwd` 原子心跳不讓舊黃燈復活、補齊 `gate.sh` 缺 node 建目錄防護 | [per-cwd-heartbeat](升級摘要/per-cwd-heartbeat.md) |
| **v0.8.0** | **`ask_question` 一鍵決策卡解析**：讓 D／E／F／分級決策支援選項卡一鍵拍板且保留純文字完全相容 | [ask-question-decision-cards](升級摘要/ask-question-decision-cards.md) |
| **v0.9.0** | **多 worktree 並發衝突偵測**：提早標出多個活躍對話同時修改同一支檔案，避免合併時才撞牆 | [worktree-conflict-detection](升級摘要/worktree-conflict-detection.md) |
| **v0.10.0 – v0.11.0** | **定時工地晨報與首頁晨報卡**：唯讀 `agy-pipeline --brief`（搭原生 `/schedule`）與首頁共源晨報卡 | [brief-patrol-command](升級摘要/brief-patrol-command.md)、[dashboard-brief-card](升級摘要/dashboard-brief-card.md) |
| **v0.12.0** | **Context Token 真實量表**：從本機轉錄檔讀取實際 token 用量與本專案結案對話比例尺 | [context-token-scale](升級摘要/context-token-scale.md) |
| **v0.13.0** | **舊規格與已知死法即時反查**：`--context` 與 `--round precheck`/`--round D` 零快取字面反查過往刻意決定 | [legacy-spec-lookup](升級摘要/legacy-spec-lookup.md) |
| **v0.14.0 – v0.14.1** | **工地復盤官技能（`retrospect`）與結案升版順序提醒**：唯讀盤點近 90 天卡關紀錄提煉防線提案；對齊升版與最後一輪 D 順序 | [retrospect-skill](升級摘要/retrospect-skill.md) |
| **v0.15.0** | **誠實任務板＋F 主任調度整合＋新版 Antigravity ROADMAP**：專案輕量 `.agents/pipeline-tasks.json` 推導 6 欄狀態（`--tasks`＋案件頁看板與一鍵複製交辦）、F 主任對話內經確認後執行 `--wrap dispatch`/`clean-worktree`/`archive`，並翻新 Antigravity 專用總路線圖 | [honest-task-board-director-dispatch](升級摘要/honest-task-board-director-dispatch.md) |

（更早期的分叉前設計規格保留於 `docs/升級摘要/` 作為架構脈絡參考，例如 [五關自動結案](升級摘要/五關自動結案.md)、[還差什麼總表](升級摘要/還差什麼總表.md)、[主任技能](升級摘要/主任技能.md)、[主任動手收尾](升級摘要/主任動手收尾.md)、[儀表板與終端機中英切換](升級摘要/儀表板與終端機中英切換.md)。）

---

## 當前進度與後續方向

### 後續探索方向（⚠️ 探索構想，未寫規格與未點頭前都不算承諾）

- **跨專案「分享給別人」打包檢核**：公開版 repo、MIT 授權與陌生人雙語首次安裝體驗（確保無本機路徑殘留）。
- **Antigravity 獨立新 worktree 派工介面支援**：若未來 Antigravity `ConversationService` 開放可程式化建立隔離 worktree 的環境參數，再行實機驗證後接上隔離派工路徑。
- **任務定義輔助產生**：由 A 寫規格或復盤技能協助整理專案任務相依表草稿（仍須人點頭）。

---

## 明確不做

- **不做「執行中」亮燈、假進度百分比與假門檻**。
- **不做會自己存第二份狀態的儀表板或索引快取**（防 P2）。
- **不將 `ANTIGRAVITY_CSRF_TOKEN` 落地給常駐 `server.mjs` 使用**，也不在網頁放直開對話／刪 worktree／強制合併按鈕。
- **不引入任何外部 npm 相依**，不把 Antigravity 監視器與原版 `~/.pipeline-monitor/` 混寫。
- **不做無人值守自動寫碼、自動合併、`git push --force`、`git worktree remove --force` 或代使用者按「結案」**。
