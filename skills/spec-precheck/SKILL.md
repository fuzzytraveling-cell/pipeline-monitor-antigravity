---
name: spec-precheck
description: A → D 規格預審（產線監視器 agy-pipeline 帶的非關卡技能）：寫完規格（A）後、動手寫程式（B）前，由魔鬼教官用獨立視角拿這個專案踩過的坑（docs/FAILURE-PATTERNS.md，沒有就用三條通用判準）對照規格本身跑一輪老毛病預審。只找問題、不改任何檔案、不自動重跑、也不佔用程式 D 輪次；收尾記進 agy-pipeline --precheck。使用者說「預審規格」「規格跑一下魔鬼教官」「spec precheck」時用，或由 A 寫規格在預測達最高級（預設 T2）時自動銜接。 English — Spec precheck (a non-stage skill in agy-pipeline): after writing a spec (A) and before writing code (B), check the spec itself against the project's known pitfalls (docs/FAILURE-PATTERNS.md, or the three general rules when there's none) from an independent perspective. It only finds problems, changes no files, never reruns automatically, and doesn't count as code D; record the conclusion with agy-pipeline --precheck. Use when the user says "spec precheck", "precheck the spec", or "chaos check the spec", or automatically after spec when the spec predicts the highest tier.
---

# A → D 規格預審（通用版）

你現在的任務是在**動手寫程式之前**，拿這個專案已經踩過的坑，來預審**規格本身**。
你不是去寫程式，也不是去幫建築師改圖——你只做一件事：**把規格裡已經埋進去的老毛病與會說謊的邊界挑出來，讓使用者在點頭開工前拍板。**

這一支**不是** `stages.json` 裡的關卡，**不屬於程式 D（`chaos-check`）**——預審紀錄只寫進 `--precheck`，絕不寫進 `--report D`，否則會搶走完工後的程式 D 輪次。

## 使用者講英文的時候（When the user writes in English）

- **用使用者講的語言回。** 講英文就用英文回、講中文就用中文回。這一支裡引號裡的中文（「看到了」「這是找過，不是通過」…）是**意思**，不是要照抄的字。
  Reply in the language the user writes in. The quoted Chinese in this skill is the meaning, not words to copy.
- `agy-pipeline` 印的字跟著它自己的語言設定（`agy-pipeline --lang`），不一定是使用者講的那一種：照它印的**意思**走。
  What `agy-pipeline` prints follows its own language setting, which may differ from the user's language: go by what it means.
- 講英文的時候，紅線那幾個字照這張表講（when speaking English, say the red-line words this way）：

<!-- 用語對照:跟 lib/lang.mjs 的 TERMS 逐字對(scripts/skills.test.mjs,老毛病 P2)。要改先改那裡,每一支技能一起改 -->
| 中文 | English | 不准說 (never say) |
|---|---|---|
| 叫了／跑過（記號 ⏸，一定帶過了多久） | called / ran (mark ⏸, always with how long ago) | passed, succeeded, done, ✓ |
| 找過（魔鬼教官的結論） | looked (the Chaos check conclusion) | passed, all clear, no problems |
| 沒對到已知死法 | didn't match any known failure pattern | passed, all clear, no problems, safe |
| 走過一遍（驗收那一支走的） | walked through (what the Acceptance skill does) | verified, accepted, passed, tested |
| 看到了／沒看到／驗不了 | seen / not seen / can't verify | passed, failed, verified |
| 驗收過了（只有使用者能說） | accepted (only the user can say it) | verified, tested, passed |
| 不用再跑／不用再走 | no need to run it again / no need to walk through it again | accepted, passed, done |
| 處理完了 | handled | fixed, resolved, passed |
| 沒有紀錄 | no record | not run, never ran, skipped |
| 問不到 | couldn't check | none, 0, no … |
| 看不全／看不到 | can't see all of it / can't see | no changes, none |
| 檢查全綠 | all checks green | works, passed, verified, safe |
| 先停下來問使用者 | stop and ask the user first | failed, error, blocked |
| 使用者說／AI 代記／分不出是誰 | the user said / AI recorded it for them / can't tell who | a guessed subject |
| 可能 | might | will, is |
| 前 N 個字 | the first N characters | words |

三條通用判準的英文那一份（the three general rules in English）：

- **R1 Never say "none" when you didn't get an answer**: would this sentence become a lie when the answer couldn't be obtained?
- **R2 Never say "passed" when it only ran**: what is the only thing this feedback proves? That a command was called, or that the thing actually worked?
- **R3 Never make up numbers**: is this number's denominator a fact you can look up, or made up?

英文的結論與結尾：
- 一條都沒對到：**This spec didn't match any known failure pattern.**——不說 passed、all clear、no problems、safe。
- 固定結尾：**This is "looked", not "passed": I only checked what's on the list; I can't see what isn't on it.**

## 產出什麼、不產出什麼

**產出**：
- 一份規格預審發現清單（上限 8 條），每一條都有對應判準、規格位置、具體觸發或老毛病形狀、將來使用者看得到的症狀、以及建議怎麼調整這份規格（供使用者決定）。
- 一句固定的結尾：**這是「找過」，不是「通過」——我只對了清單上的東西，清單上沒有的我看不到。**

**不產出**：
- **不改任何檔案。** 連修一個錯字或幫人改規格都不行——改動規格由使用者拍板後才做。
- 不宣稱通過、不打分數、不給百分比、不給「風險等級」。
- 不寫進 `--report D`、不自動重跑第二輪。

## 第一步：先跑 `agy-pipeline --round precheck`

跑 `agy-pipeline --round precheck`（沒有指令時用 `node "<agy-pipeline 的資料夾>/status.mjs" --round precheck`，那個資料夾就是 `~/.gemini/config/plugins/agy-pipeline` 指向的位置）。

它會一次告訴你：
1. 這一輪是第幾次規格預審（只算記過結論的；沒記結論的標示進行中）。
2. 這一輪的規格檔路徑（單份、多份、搬家後的新位置；讀不到的那份會明講，**不准編條目**，R1）。
3. 專案有沒有設定分級、規格有沒有預測到最高級（預設 `T2`）。
4. 這個專案找得到哪些清單（`docs/FAILURE-PATTERNS.md`、手冊 `AGENTS.md`/`GEMINI.md`/`CLAUDE.md`、`docs/LESSONS.md`）；沒有 `docs/FAILURE-PATTERNS.md` 就只對通用三條紅線 R1–R3，**並在回報裡明講**。
5. 這一次的跑法與收尾指令。

## 怎麼跑

- **第一次（全新腦袋）**：預設用 `invoke_subagent`（`TypeName: "research"`）派 **1 個獨立唯讀子 agent**，把規格檔路徑、`docs/FAILURE-PATTERNS.md`（若存在）、手冊裡寫著「刻意／不是 bug」的段落與三條通用紅線 R1–R3 直接交給它對照。
  - **明禁子 agent 讀取任何 `SKILL.md`（尤其不能讀 `chaos-check` 或這支 `SKILL.md`），也明禁它修改或建立任何檔案。**
  - 只有在環境無法派子 agent 時，才改由本對話自己讀規格對照，並在回報第一行明講「無法派獨立子 agent，本次由本對話自行對照」。
- **第二次以上（使用者主動點名再預審時）**：自己看改過的規格段落，**不派 agent**，也不會因為之後又改規格而自動再跑。

## 回報門檻與輸出格式（寧可少報，不要洪水）

每一條發現**必須同時**具備：
1. **判準**：專案 `docs/FAILURE-PATTERNS.md` 的代號或 R1／R2／R3。
2. **規格位置**：哪一份規格的哪一條 AC／段落（多份規格時標明檔名）。
3. **觸發與症狀**：如果照這份規格寫下去，將來什麼情況會踩到、使用者會看到什麼（或安靜壞在哪）。
4. **建議調整**：一句具體可選的改法，交給使用者決定要不要改。

確認沒有違反專案手冊裡寫著「刻意／不是 bug」的決定；已經在規格裡補好防護的就不報。**上限 8 條**，超過只留最嚴重的 8 條並說明砍掉幾條。
一條都沒對到是合法結論：寫「這份規格沒對到任何已知死法」（英文：`This spec didn't match any known failure pattern.`），**不是通過**。

最後固定兩行：
- **這是「找過」，不是「通過」**——我只對了清單上的東西，清單上沒有的我看不到。
- 我讀了哪些檔案、哪些找不到（找不到的話明講用的是通用判準 R1–R3）。

## 收尾（一定要做：記進獨立預審事件，絕不記進 `--report D`）

把結論記給儀表板：
- 沒對到已知死法 → `agy-pipeline --precheck ok "沒對到已知死法"`（英文：`agy-pipeline --precheck ok "didn't match any known failure pattern"`）
- 有發現 → `agy-pipeline --precheck found "找到 N 條
- [判準] 一句話"`（英文：`"Found N` 之後一樣一行一條 `- [criterion] one sentence`）

**還在等子 agent 回來時不准先記 ok 交差；記完就停，絕不自己重跑第二輪。** 之後使用者討論要求修改規格，也不自動再預審；只有使用者主動點名再跑時才跑。
