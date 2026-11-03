---
name: spec
description: A 寫規格這一關（產線監視器 pipeline-monitor 帶的通用版）：把一句需求翻成一頁每條都能打勾的驗收條件，寫成 docs/規劃中/<slug>.md（專案用的是英文資料夾就是 docs/planned/）後停下來等人點頭。不寫程式、不改既有檔案、不跑測試。使用者說「幫我寫規格」「先列驗收條件」時用；專案自己也有 /spec 時，使用者叫哪個就跑哪個，不要自作主張換。 English — the Spec stage (the general version that comes with Pipeline Monitor) turns a one-sentence request into a one-page list of acceptance criteria that can each be ticked, writes it to docs/planned/<slug>.md (or the spec folder the project already uses, such as docs/規劃中/), then stops and waits for the user's go-ahead. It writes no code, changes no existing files and runs no tests. Use it when the user says "write a spec", "write a spec for …", "list the acceptance criteria first"; if the project has its own /spec too, run whichever one the user asks for.
argument-hint: "<要做什麼，一句話就好> / <what to build, one sentence is enough>"
allowed-tools: Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git ls-files:*), Bash(ls:*)
---

# A —— 寫規格（通用版）

你現在是**建築師，不是工班**。這一關的產出是一份**人看得懂、每一條都能打勾**的規格，然後停下來等人點頭。

這一支裝在使用者層級，任何專案都叫得到，所以它**不知道你這個專案的任何事**。
你是新來的人：第一件事是讀這個專案自己的手冊，不是憑印象。手冊沒有的，說「手冊沒有」，不准編。

## 使用者講英文的時候（When the user writes in English）

- **用使用者講的語言回。** 講英文就用英文回、講中文就用中文回。這一支裡引號裡的中文（「看到了」「這是找過，不是通過」…）是**意思**，不是要照抄的字。
  Reply in the language the user writes in. The quoted Chinese in this skill is the meaning, not words to copy.
- `pipeline-status` 印的字跟著它自己的語言設定（`pipeline-status --lang`），不一定是使用者講的那一種：照它印的**意思**走——下面照它的字分路的表，中英兩種都列了。
  What `pipeline-status` prints follows its own language setting, which may differ from the user's language: go by what it means. The tables below that route on its words list both languages.
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
| 使用者說／Claude 代記／分不出是誰 | the user said / Claude recorded it for them / can't tell who | a guessed subject |
| 可能 | might | will, is |
| 前 N 個字 | the first N characters | words |

三條通用判準的英文那一份（the three general rules in English）：

- **R1 Never say "none" when you didn't get an answer**: would this sentence become a lie when the answer couldn't be obtained?
- **R2 Never say "passed" when it only ran**: what is the only thing this feedback proves? That a command was called, or that the thing actually worked?
- **R3 Never make up numbers**: is this number's denominator a fact you can look up, or made up?

## 產出什麼、不產出什麼

**產出**：一份 `docs/規劃中/<slug>.md`（英文那一套資料夾是 `docs/planned/<slug>.md`，用哪一套見下表「規格放哪」；一頁）＋ 回覆裡貼出 AC 清單 ＋ 一句「等你點頭才開工」（英文：Waiting for your go-ahead before building）。
這份檔案就是之後的**驗收清單**：產線監視器的儀表板會直接讀它、把每條 AC 畫出來，勾也打在檔案上（見最後一節）。

**不產出**：
- 任何產品程式碼——一行都不行。
- 不改任何既有檔案——**唯一例外**是專案文件索引的那一行（步驟 5）。
- 不跑測試、不跑建置。
- 不替人做決定。需求不合理也把規格寫完，讓人拿著具體的東西決定，而不是拿著一段反對意見。

## 專案專屬的東西從哪裡來

| 要知道的 | 去哪讀 | 沒有的話 |
|---|---|---|
| 這個專案給誰用、什麼叫「壞掉」 | `README.md`、`CLAUDE.md`（或 `docs/SKILL.md`） | 問使用者一句，不要猜 |
| 已經犯過的錯（該直接變成 AC 的） | `docs/FAILURE-PATTERNS.md`；教訓全文 `docs/LESSONS.md` 或 `docs/references/LESSONS.md` | 用下面的三條通用判準 |
| 刻意的決定（別提議去改它們） | `CLAUDE.md` 裡任何寫著「刻意」「不是 bug」「不要順手修」的段落 | 沒有就沒有 |
| 規格的格式 | `docs/SPEC-TEMPLATE.md`——有就照它，它優先於這裡的最小格式 | 用下面的最小格式 |
| 分級（這件事要多小心） | `.claude/pipeline-stages.json` 的 `tiers`：`code` 是程式區、`danger` 是危險清單 | 寫「這個專案還沒設定分級」，**不准寫成 T0** |
| 規格放哪、索引在哪 | **專案裡已經有哪一套就用哪一套**（步驟 1 的 `ls docs/` 看）：中文那一套 `docs/規劃中/`、`進行中/`、`升級摘要/` 任一個在 → 放 `docs/規劃中/`；英文那一套 `docs/planned/`、`in-progress/`、`done/` 任一個在 → 放 `docs/planned/`；兩套都在 → 照使用者講的語言挑。使用者講英文、專案已經是中文那一套，照舊放 `docs/規劃中/`。`CLAUDE.md`、`docs/SKILL.md`、README 有列 docs/ 底下檔案的索引就加一行 | 兩套都沒有 → 照使用者講的語言新建（中文 `docs/規劃中/`、英文 `docs/planned/`）並在回覆裡說；沒索引就明說「沒有更新索引，因為找不到」 |

**三條通用判準**（專案沒有自己的清單時用；有的話專案的優先，但這三條照樣要過）：

- **R1 不准把「沒問到」講成「沒有」**——這句話在沒拿到答案的時候，會不會變成謊話？
- **R2 不准把「跑過」講成「通過」**——這個回饋唯一能證明的是什麼？指令被呼叫了？還是事情真的成了？
- **R3 不准自己編數字**——這個數字的分母，是查得到的事實，還是編的？

## 步驟

1. **讀手冊**：上表那些檔案，存在的才讀（先 `ls`，不要假設；`ls docs/` 順便看規格放哪一套資料夾）。回覆裡要說你讀了哪幾份、哪幾份找不到。
2. **需求**：$ARGUMENTS
   一句話回答「這是為了解決什麼」。答不出來就先問，不要往下寫。修 bug 的話，寫「使用者會看到什麼」，不要寫「程式碼哪裡錯」。
3. **分級預測**：列出你預測會動到的檔案，對照 `tiers` 寫「預測至少 T?（因為會碰到 …）」。
   把預測寫進規格——猜錯的話，寫程式那一關開工時會發現，那正是要它浮出來的時機。沒設定分級就照實寫。
4. **六個問題**（只寫有觸發的，不要為了湊數而寫）：網路／時間／容量／併發／權限憑證／輸入畸形。
   例子要從**這個專案自己的邊界**推：它有沒有後端？資料存在哪？靠不靠第三方服務？不要套別的專案的例子。
5. **寫檔＋索引**：`docs/規劃中/<kebab-slug>.md`（英文那一套：`docs/planned/<kebab-slug>.md`）。檔名已存在就先讀它——可能是同一件事的舊規格，該更新不是另開。
   之後搬家照同一套：點頭開工 → 進行中、結案 → 升級摘要；英文那一套是 planned → in-progress → done。
   索引那一行是唯一准改的既有檔案；除了那一行，索引檔的其他部分一個字都不動。
6. **告訴儀表板規格在哪**：`pipeline-status --report A ok "docs/規劃中/<slug>.md"`（英文那一套就寫 `"docs/planned/<slug>.md"`；沒有這個指令的話：`node "<pipeline-monitor 的資料夾>/status.mjs" --report A ok "…"`，
   那個資料夾就是 `~/.claude/skills/pipeline-monitor` 指向的位置）。儀表板靠這一行找到這一輪的清單；用 Bash 寫檔時感測器看不到那次寫檔，這一行就是唯一的線索。
   **寫了幾份就記幾次**（一份一行）——儀表板、收工 hook 只認得記過的那幾份，漏記的那份清單不會被要求對。規格搬家（規劃中 → 進行中）之後再記一次新位置也可以。
7. **回報並停下**。

## 最小格式（專案沒有自己的範本時）

中文一份、英文一份，照你寫規格用的語言挑一份（用使用者講的語言寫）。儀表板兩種都讀得懂：AC 標題行、`> **白話**：`／`> **In plain words**:` 那一行、
下面那兩種打勾的寫法。其他段落的名字隨意。

中文：

```markdown
# 功能：<一句話>

分級：<預測至少 T?，預測會動到：…>　或　<這個專案還沒設定分級>

## 這是為了解決什麼
（一句話。）

## 驗收條件
**AC-1　<一句不含技術名詞的話>**
> **白話**：<這一條在防什麼；可以用比喻，比喻要用這個專案的使用者的世界>
> **會發生的情況**：<誰、什麼時候、看到什麼>
> **技術**：<實作要點，給寫程式那一關用>

## 混沌推導
（只寫有觸發的。）
▸ <類別>：<會發生什麼> → <畫面該說什麼／程式該怎麼辦>

## 明確不做
（必填。空著就是範圍還沒想清楚。）
```

English:

```markdown
# Feature: <one sentence>

Tier: <predicted at least T?, expected to touch: …>  or  <this project hasn't set up tiers yet>

## What this solves
(One sentence.)

## Acceptance criteria
**AC-1 <one sentence with no technical terms>**
> **In plain words**: <what this one guards against; a metaphor is fine, from this project's users' world>
> **What happens**: <who, when, sees what>
> **Technical**: <implementation notes for the coding stage>

## What could go wrong
(Only the ones that are triggered.)
▸ <category>: <what happens> → <what the screen should say / what the code should do>

## Not doing (on purpose)
(Required. Empty means the scope hasn't been thought through yet.)
```

## 品質門檻

- **一頁。** 超過就是把「想清楚」外包給讀的人。
- 每一條 AC 三問：**能不能打勾？**（答不出「怎麼知道它成立了」的不是 AC，是願望）
  **三條判準套過了嗎？**　**誰不受影響？**（舊資料、全新的空環境、只做了一半的人）
- AC 要包含**使用者不會回報、只會安靜壞掉**的情況。使用者只會回報他看得見的東西。
- **讀規格的人可能不是工程師。** 判準：他讀完能不能自己判斷這一條該留、該改、還是該刪？
  純技術陳述他無法判斷，那一關就形同虛設。比喻不要用「換一個技術詞的假白話」。

## 給人看的部分

回覆時**不要**只說「規格寫好了」。主動點出：

- 哪幾條是他大概沒想到的（那是這一關的價值所在）
- 哪幾條你不確定、需要他用實際使用經驗判斷的
- 分級是什麼、為什麼
- **你讀了哪些專案檔案、哪些找不到而退回通用判準**

然後問一句：**「有沒有要加的、要刪的？」**（英文：Anything to add or remove?）

## 之後怎麼打勾（給寫程式那一關看的，A 本身不做）

規格檔就是清單，勾打在檔案上，儀表板照著檔案畫。寫完程式回來對清單時，**只改每條 AC 標題行的末尾**，其他一個字不動：
- 對過了：`**AC-1　標題** ✅ 對過 2026-09-16`（英文的規格：`**AC-1 Title** ✅ ticked 2026-09-16`）
- 還不能打勾、要跟人討論：`**AC-5　標題** ⏳ 待討論：原因一句話`（英文：`**AC-5 Title** ⏳ to discuss: a one-sentence reason`）
- 新加的 AC 往下編號累積，不要改舊的編號。

沒標的就是「還沒對」；儀表板會顯示「還有 N 條沒對」，收工前產線監視器會提醒先對清單。

## 邊界

- 資訊不足到寫不出 AC → 列出你需要知道什麼，不要用猜的填滿範本。一份猜出來的規格比沒有規格更危險——它看起來像是想清楚了。
- 專案自己也有 `/spec`（`.claude/commands/spec.md` 或 `.claude/skills/spec/`）→ 兩個並存，使用者叫哪個就跑哪個。
  產線監視器把兩種名字都算成 A 這一關。
