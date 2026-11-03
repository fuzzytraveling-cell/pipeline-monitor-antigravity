---
name: verify
description: E 驗收這一關（產線監視器 pipeline-monitor 帶的通用版）：照這一輪的規格，把每條驗收條件在畫面上走一遍，每條記「看到了（附畫面上的原文）／沒看到／驗不了（附原因）」，給人做第二次查核。只看、不改程式、不說驗收過了——那句只有使用者能說。使用者說「驗收一下」「幫我在畫面上走一遍」「verify」時用；專案自己也有 /verify 時，使用者叫哪個就跑哪個，不要自作主張換。 English — the Acceptance stage (the general version that comes with Pipeline Monitor) follows this round's spec and walks through each acceptance criterion on the screen, recording each one as seen (with the original text from the screen), not seen, or can't verify (with the reason), for the user to check a second time. It only looks; it changes no code and never says it's accepted, because only the user can say that. Use it when the user says "walk through it", "walk through it on the screen", "verify", "check it on the screen"; if the project has its own /verify too, run whichever one the user asks for.
argument-hint: "[沒有規格時：要看什麼] / [with no spec: what to look at]"
allowed-tools: Bash(pipeline-status --round:*), Bash(git status:*), Bash(git diff:*), Bash(git ls-files:*), Bash(ls:*)
---

# E —— 驗收（通用版）

你是**驗屋師傅**：照驗收單一條一條在畫面上看，每條寫下看到什麼。你**不是**屋主——「驗收過了」只有使用者能說。

這一支裝在使用者層級，任何專案都叫得到，所以它**不知道你這個專案的畫面長什麼樣**。
要看什麼只從這一輪的規格來（沒有規格就從使用者的話來），**不自己編步驟**。

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

英文的回報格式與結尾（下面每一處中文的格式，英文都照這一份）：
- 每條：`AC-3 seen: "the original text on the screen"`／`AC-4 not seen: expected "…", the screen shows "…"`／`AC-5 can't verify: reason`；沒有規格的輪次 `1 seen: "…"`；好幾份規格 `report-row-time AC-1 seen: "…"`。
  原文用 `"…"` 或 `“…”` 引起來（中文是「」）。`saw it`、`checked` 這種不在格式裡的字，儀表板認不得，那一條會變成「沒有結果」。
- 固定結尾：**This is a walk-through, not an acceptance.**——不說 verified、accepted、passed。

## 產出什麼、不產出什麼

**產出**：
- 每條一個結果：**看到了**（附畫面上的原文）／**沒看到**（應該看到什麼、實際是什麼）／**驗不了**（原因）。
- 記給儀表板的一筆結論（見「收尾」）。
- 給使用者的一段話：每條看到什麼、請他查核什麼。

**不產出**：
- **不改程式檔。** 看到問題就回報，修是寫程式那一關的事。唯一例外：專案沒有 `.claude/launch.json`，照 `package.json` 補一份（回報第一行講明）。
- 不說「驗收過了」「通過」，不打分數、不給百分比。
- 不存截圖。要看顏色、位置可以截圖自己看，不存檔（使用者 2026-09-23 決定）。

## 絕對不做（先讀這段）

- **不輸入任何密碼、金鑰、信用卡號、個資。** 畫面要登入 → 那幾條標「驗不了：要登入」。
- **不按收不回來的按鈕**（送出、刪除、付款、寄信、發布、結案……）→ 標「驗不了：要你自己按」。
- **不按儀表板上的「你說驗收過了」**，也不自己跑 `pipeline-status --clear E`——使用者在對話裡親口說了驗收過了，才照他的原話記（見「收尾」）。
- **不用 Claude in Chrome**（使用者自己的 Chrome，登入的帳號都在）——用 app 內建的瀏覽器；使用者那一次明說要用 Chrome 才用。
- 不派 agent 去走：瀏覽器只有一個。
- 驗不了不准寫成沒看到；沒看到不准寫成驗不了。

## 第一步：先問這一輪照什麼驗、怎麼跑起來（一定要做）

跑 `pipeline-status --round E`（沒有這個指令的話：`node "<pipeline-monitor 的資料夾>/status.mjs" --round E`，
那個資料夾就是 `~/.claude/skills/pipeline-monitor` 指向的位置）。它講這一輪第幾趟、照哪份規格、要驗哪幾條、專案怎麼跑起來。照它說的走：

| 它說（中文／English） | 你怎麼做 |
|---|---|
| 照這份規格驗：<路徑>（照這 N 份規格驗）／Verify against this spec: <path>（Verify against these N specs） | 打開那份，每條讀標題、白話、「會發生的情況」——照「會發生的情況」在畫面上找（英文的規格：In plain words、What happens） |
| 分批做：這一批只驗 …／Done in batches: this batch only verifies … | 只驗那幾條 |
| 規格在主資料夾／the spec is in the main folder | 照那份讀，只讀、不在那裡改任何東西 |
| 這一輪沒有規格、或找不到規格檔／This round has no spec、can't find this round's spec file | 照使用者叫你時講的話驗（它印出來的那句，或對話裡他交代的那件事），條目用數字編號；他沒講要看什麼就先問，問不到就回報「沒有東西可以照著驗」（There's nothing to verify against）——**不自己編步驟** |
| 第 2 趟以上／walk-through 2 or later（walking through it again would be number N） | 預設整份再走；使用者說只看哪幾條就只看那幾條，回報第一行寫清楚 |

## 第二步：把專案跑起來——驗的是這個工作區的程式

- 照它的「怎麼跑起來」：有 `.claude/launch.json` → 用 app 的預覽照設定的名字開起來（不要用 Bash 開伺服器）。
  只有主資料夾有、或只有 `package.json` 的 dev／start／preview → 照它在這個工作區補一份 launch.json，回報第一行講明「我補了 launch.json」。
- 等多久交給預覽工具。它說起不來 → 每條標「驗不了：專案跑不起來（預覽工具說：…）」——**跑不起來不等於功能壞了**，不准寫成沒看到。
- 沒有畫面可以開（指令列工具、純函式庫）→ 每條標「驗不了：沒有畫面可以開」，不硬走。
- 這裡沒有 app 內建的瀏覽器 → 每條標「驗不了：這裡沒有內建的瀏覽器」。
- **驗你自己開起來的那一份。** 已經在跑的那一份不算——例如產線監視器的常駐儀表板跑的是主資料夾的舊程式，看它等於驗還沒改的版本。回報寫網址。

## 第三步：一條一條看

每條：
1. 把「會發生的情況」翻成畫面上要看到的一件事（一句話）。
2. 用最少的動作走到那個畫面（開網址、點不會改資料的連結與分頁）。
3. **先讀文字**（找元素、讀頁面內容）；要看顏色、位置、排版才截圖，截圖只給自己看。
4. 記一行：
   - 看到了 → `AC-3 看到了：「畫面上的原文」`——照抄畫面上的字，使用者打開同一頁就對得出來；看的是顏色或位置，就寫你看到的是什麼（「按鈕是藍色的，在標題右邊」）。
   - 沒看到 → `AC-4 沒看到：應該看到「…」，畫面上是「…」`
   - 驗不了 → `AC-5 驗不了：原因`
   - 沒有規格的輪次，代號用數字：`1 看到了：「…」`
   - 這一輪有**好幾份規格**（`--round E` 會說「照這 N 份規格驗」）：兩份都有 AC-1，每一行前面加規格名（`--round E` 列的那個名字）：
     `report-row-time AC-1 看到了：「…」`。只寫「AC-1」的分不出是哪一份，儀表板不猜，那一條會變成「沒有結果」。

AC 寫得抽象（「要穩定」「要快」）→ `驗不了：畫面上看不出來`。不要硬湊一個步驟假裝驗過。

## 收尾（一定要做：這是這一關唯一的證據）

把結論記給儀表板，儀表板會照實標「Claude 說」。說明第一行是摘要（第幾趟、網址、有沒有補 launch.json），之後一行一條，格式跟第三步一樣：
- 沒有「沒看到」的 → `pipeline-status --report E ok "第 1 趟：http://localhost:5173（這個工作區的程式）
AC-1 看到了：「…」
AC-2 驗不了：要登入"`
- 有任何一條沒看到 → 用 `found`（有沒看到的卻記 ok，指令會拒收）
- 英文的回報：原文的 `"` 會跟指令的引號打架，整段用 heredoc 傳：
  ```
  pipeline-status --report E ok "$(cat <<'EOF'
  Walk 1: http://localhost:5173 (this workspace's code)
  AC-1 seen: "Welcome back"
  AC-2 can't verify: needs a login
  EOF
  )"
  ```

沒有 `pipeline-status` 這個指令的話：`node "<pipeline-monitor 的資料夾>/status.mjs" --report E …`。

**還在走就照實說還在走，不准先記結論交差。** 走完才記。**記完就停：不准自己再走一趟。**

然後用一般的對話跟使用者說（不要用選項卡）：
- 每條的結果（跟記的一樣）。
- 請他做第二次查核：我說看到了的，照原文抽查幾條；我說沒看到、驗不了的，他決定是不是問題。
- 「驗收過了」由他說：按儀表板 E 那一格的按鈕；或跟你說，你照他的原話記：`pipeline-status --clear E "使用者的原話"`。
  儀表板附的是感測器記的、他在 E 之後說的最後一句——他沒開口，記了也不算數。

固定結尾一行：**這是「走過一遍」，不是「驗收過了」。**（英文：**This is a walk-through, not an acceptance.**）

## 之後又改了程式：要不要再走，先問人

這一輪已經走過、之後又改了程式（修了沒看到的、或使用者又交代了別的）→ **不准自己再走**，先停下來問使用者。
問之前跑 `pipeline-status --round E` 拿事實，用白話＋舉例講：走過之後改了什麼、可能影響哪幾條、
上一趟從叫到記結論花了多久（它給的數字；給不出就說「紀錄裡看不到」，**不准估**）、不再走的風險；最後一行給建議。
用一般的對話問，**不要用選項卡**——選項卡的回答感測器看不到，你記下的會變成「分不出是不是使用者說的」。
- 使用者說走 → 再叫這一關。
- 說不用再走 → `pipeline-status --decide E skip "使用者的原話"`。**「不用再走」不是「驗收過了」**（no need to walk through it again ≠ accepted）——不准記成 `--clear`。
- 說看過了、可以（驗收現在這一版）→ `pipeline-status --clear E "使用者的原話"`。

這一輪沒走過 verify、使用者自己驗過說可以，之後又改了程式——一樣先問；上面三條照用（`--decide` 這時錨在他的驗收）。

## 邊界

- 專案自己也有 `/verify` → 兩個並存，使用者叫哪個就跑哪個。產線監視器把兩種名字都算成 E 這一關。
