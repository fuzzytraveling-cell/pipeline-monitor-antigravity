---
name: chaos-check
description: D 魔鬼教官這一關（產線監視器 agy-pipeline 帶的通用版）：拿這個專案自己踩過的坑（docs/FAILURE-PATTERNS.md，沒有就用三條通用判準）逐條對照這次的改動，找出正在重蹈的已知死法。只找問題、不改任何檔案、不宣稱通過。使用者說「檢查一下有沒有踩到老毛病」「魔鬼教官」「chaos check」時用；專案自己也有 chaos-check 技能時，使用者叫哪個就跑哪個，不要自作主張換。 English — the Chaos check stage (the general version that comes with Pipeline Monitor for Antigravity) compares this change, item by item, against the pitfalls this project has already hit (docs/FAILURE-PATTERNS.md, or the three general rules when there's none) to find known failure patterns being repeated. It only finds problems; it changes no files and never claims a pass. Use it when the user says "chaos check", "run the chaos check", "check whether this hits any known failure pattern", "look for old mistakes"; if the project has its own chaos-check skill too, run whichever one the user asks for.
---

# D —— 魔鬼教官（通用版）

你現在的任務**不是**一般的 code review，也不是找語法或風格問題。你只做一件事：
**拿這個專案已經踩過的坑，來對照這次的改動。**

這一支裝在使用者層級，任何專案都叫得到，所以它**不知道你這個專案踩過什麼坑**。
那份清單只住在那個專案自己的檔案裡——讀到就用它的，讀不到就說讀不到，
**不准把「沒有清單」講成「沒有已知死法」**。

## 使用者講英文的時候（When the user writes in English）

- **用使用者講的語言回。** 講英文就用英文回、講中文就用中文回。這一支裡引號裡的中文（「看到了」「這是找過，不是通過」…）是**意思**，不是要照抄的字。
  Reply in the language the user writes in. The quoted Chinese in this skill is the meaning, not words to copy.
- `agy-pipeline` 印的字跟著它自己的語言設定（`agy-pipeline --lang`），不一定是使用者講的那一種：照它印的**意思**走——下面照它的字分路的表，中英兩種都列了。
  What `agy-pipeline` prints follows its own language setting, which may differ from the user's language: go by what it means. The tables below that route on its words list both languages.
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

英文的結論與結尾（下面每一處中文的說法，英文都照這一份）：
- 一條都沒對到：**This change didn't match any known failure pattern.**——不說 passed、all clear、no problems、safe。
- 固定結尾：**This is "looked", not "passed": I only checked what's on the list; I can't see what isn't on it.**
- 第一行那幾句：`Sent N agents`／`Sent no agents`、`Couldn't get the list after the first round, so this time I looked at the whole batch`、
  `Round N only looked at the N files changed after the first round: …`（照 `--round D` 印的那一句）、
  `<the reason it gives>, so I ran it the cheapest way`（原因照 `--round D` 印的那一句，例如 `This project's tier setting can't be read, so I ran it the cheapest way`）。
- 每條發現的欄位：**Where**、**Trigger**、**Symptom**、**Criterion**、**Existing fix**。

## 產出什麼、不產出什麼

**產出**：
- 一份發現清單（上限 8 條），每一條都有具體觸發條件、使用者看得到的症狀、對應的判準。
- 一段「這次沒問題但值得知道」（可選，最多 3 條）。
- 一句固定的結尾：**這是「找過」，不是「通過」。**

**不產出**：
- **不改任何檔案。** 連修一個錯字都不行——你一動手，就沒有人是「沒寫過這段程式的腦袋」了。
- 不宣稱通過、不打分數、不給百分比、不給「風險等級」。
- 不做風格、命名、排版的評論。

## 專案專屬的東西從哪裡來

| 要知道的 | 去哪讀 | 沒有的話 |
|---|---|---|
| 已知死法（判準清單） | `docs/FAILURE-PATTERNS.md`——有觸發表就用觸發表挑，沒有就通讀挑對得上的 | 只對下面三條通用判準，**並在結論裡明說**「這個專案沒有自己的死法清單，我只對了通用的三條」 |
| 教訓全文 | `docs/LESSONS.md` 或 `docs/references/LESSONS.md`（按標題搜關鍵字，不要從頭讀） | 略過 |
| 刻意的決定（看起來像 bug、其實不是） | 專案手冊（`AGENTS.md`／`GEMINI.md`／`CLAUDE.md`）裡寫著「刻意」「不是 bug」的段落 | 沒有就沒有 |
| 覆蓋最稀、最常出事的地方 | `FAILURE-PATTERNS.md` 或專案手冊有寫才有 | 問 git：這次動到的每個檔案**有沒有對應的測試**——回報裡明講有／沒有，不要猜 |
| 使用者是誰、症狀長什麼樣 | `README.md`、`AGENTS.md`、`GEMINI.md`、`CLAUDE.md` | 當成不是工程師來寫 |

**三條通用判準**（不論改動內容一律檢查；專案有自己的紅線時兩邊都要過）：

- **R1 不准把「沒問到」講成「沒有」**——任何回傳 `null`／`0`／`false`／空陣列表示失敗的地方，逐字檢查：
  這句話在沒拿到答案時會不會變成謊話？判準不是「有沒有處理錯誤」，是「沒問到跟沒有分不分得出來」。
- **R2 不准把「跑過」講成「通過」**——任何綠勾、`success`、「完成」：它唯一能證明的是什麼？指令被呼叫了？還是事情真的成了？
- **R3 不准自己編數字**——任何門檻、百分比、「太多／太久」：分母是查得到的事實，還是編的？

## 第一步：先問這是這一輪第幾次、該怎麼跑（一定要做）

跑 `agy-pipeline --round D`（沒有這個指令的話：`node "<agy-pipeline 的資料夾>/status.mjs" --round D`，
那個資料夾就是 `~/.gemini/config/plugins/agy-pipeline` 指向的位置）。它的「跑法」那一行怎麼說就怎麼跑：

| 它說（中文／English） | 你怎麼跑 |
|---|---|
| 第一次、可以派獨立 agent（只有分級設定允許的那一級才會這樣說）／first time, tier …: you may send independent agents | 可以用 `invoke_subagent`（`TypeName: "research"`）派獨立 subagent 多角度看，派幾個你判斷；回報第一行寫「派了 N 個 agent」（沒派就寫「沒派 agent」） |
| 第一次、你自己看／first time, tier …: look yourself, don't send agents | 你自己看整批改動，**不派 agent** |
| 第一次、<原因>：照最省的方式跑／first time, <reason>: run it the cheapest way——原因是這四種之一：這個專案沒設定分級、這個專案的分級設定讀不懂、這個專案設定成不分級、這次分不了級（this project hasn't set up tiers、this project's tier setting can't be read、this project is set to not use tiers、the tier couldn't be worked out this time） | 你自己看，回報第一行照它給的那句寫：「<它講的原因>，我照最省的方式跑」——原因照它講，不准一律寫成「沒設定分級」：讀不懂、設定成不分級、這次分不了級講成沒設定，就是把「沒問到」講成「沒有」（R1）。不是當成最低那一級，是成本上取最省的那條 |
| 第二次以上／time 2 (or later): whatever the tier, look yourself | 不論分級都你自己看，**只看它列的那幾個檔**（第一次之後改的），不派 agent；回報第一行照它給的那句寫 |
| 拿不到第一次之後的清單／Can't get which files changed after the first time、或這個指令不存在 | 看整批，回報第一行寫「拿不到第一輪之後的清單，這次看的是整批」 |

第一次它也會印「這一輪的範圍」（This round's scope）：從哪一刻的版本算起、這一輪改過的檔——跟收工 hook、儀表板說的「這一輪」同一份。步驟 1 照它拿改動。
不論第一輪或第二輪以上，`--round D` 也會即時附上這次要看的檔案在舊規格（`docs/升級摘要/`／`docs/done/`）與 `docs/FAILURE-PATTERNS.md` 的純字面反查結果（及讀不到的來源）：**僅列字面上點名過該檔路徑的歷史紀錄，沒列到的不代表無關**。步驟 2 請先速讀這些過往刻意決定；若第一輪 T2 派獨立子 agent，一併把這些相關舊規格與死法出處交給子 agent 對照。

如果 `--round D` 印出「提醒分流」（`Split reminder`：這一輪有規格檔、還沒改到程式檔），先停下來向使用者確認是要審規格（改跑 `spec-precheck` 並記 `agy-pipeline --precheck`）還是確實要跑程式 D，**絕不把規格預審記進 `--report D`**。

第二次以上只看那幾個檔，代價是：修法跟沒重讀的那些檔之間的交互，這一次看不到——所以回報**不准**講成「全部看過」。

**交給獨立 subagent 跑也一樣要先在這個對話叫這一關**（儀表板只看得到這裡叫過），收尾一定由你記結論。
派出去的 subagent 把要對照的清單與改動直接交給它們，**不要叫它們再讀這支 SKILL.md 或再叫這一關**——那會被算成這一輪又跑了一次。

## 步驟

1. **拿改動**——範圍照 `--round D` 給的，不自己決定（自己用 `git diff HEAD` 的話，這一輪中途存過檔的那一半看不到，照樣回報「跑過」）：
   - 第一次 → 它印的「這一輪的範圍」：`git diff <它給的版本> -- <它列的那幾個檔>`，標「新檔」的整份讀。一輪中途存過檔的也在裡面。
     它說起點找不到、只看得到還沒存檔的 → 照它說的拿，回報第一行照它給的那句寫。
   - 第二次以上 → 只拿 `--round` 列的那幾個檔：`git diff <它給的版本> -- <那幾個檔>`，新檔整份讀。基準是第一次那一刻的版本，第一輪之後存過檔的改動才看得到。
   - 使用者若指定了 git ref → `git diff <ref>`
   - `--round` 沒給範圍（這個指令不存在、或是舊版沒有這一段）→ `git diff HEAD`；空的話 → `git diff main...HEAD`（沒有 main 就 master）。
     回報第一行寫「拿不到這一輪的範圍，這次看的是 <你實際用的那個 git 指令>」。
   - ⚠️ **`git diff` 看不到還沒被 git 追蹤的新檔案，而新檔案是 AI 最常見的產物。** 一律再跑
     `git ls-files --others --exclude-standard`，新檔案整份讀。漏掉的方向永遠是讓改動看起來比實際小——那是危險的那一邊。
   - 拿不到（不是 git 專案、指令失敗）→ 說「拿不到改動」，**不是**「沒有改動」。
2. **讀這個專案的死法清單**（上表）與 `--round D` 列出的相關舊規格出處（速讀過往刻意決定；第一輪 T2 派子 agent 時一併附上）。
3. **挑對得上的幾條**（通常 3–5 條，不要全部跑）。三條通用判準不論內容一律檢查。
4. **需要上下文就讀被改動檔案的相關段落**——只有 diff 通常不足以判斷。
5. **每一條發現先確認有沒有已被別處擋掉**——守住了就不報。

## 回報門檻（重要——寧可少報，不要洪水）

一個被告知「去找問題」的檢查一定找得到問題。**沒有門檻的清單等於沒有清單。** 每一條發現**必須同時**具備：

1. **具體觸發條件**——什麼輸入／狀態／時序會走到它。答不出來就丟掉。
2. **使用者看得到的症狀**——「理論上不安全」不算症狀，丟掉。
3. **對應的判準**——專案清單的編號與已發生次數，或 R1／R2／R3。
4. **是否已被別處擋掉**——先確認。

**上限 8 條。** 超過就只留最嚴重的 8 條，並說明砍掉了幾條。
**一條都沒有也是合法的結論**——但寫法是「這次的改動我沒對到任何已知死法」（英文：This change didn't match any known failure pattern），**不是「通過」**（不是 passed、all clear）。
你能證明的只有「我找過、沒找到」。

## 輸出格式

先一行結論，然後每條發現：

```
### [判準編號] 一句話講清楚問題　(已發生 N 次／通用判準)
**位置**：檔案:行號
**觸發**：什麼情況會走到這裡
**症狀**：使用者會看到什麼
**判準**：那一條的那句問題，以及這次的答案
**現成解法**：那一條有列既有實作的話，指出來
```

再一段 **「這次沒問題但值得知道」**（可選，≤3 條）：改動碰到某個模式的範圍，但這次寫對了——講一句它為什麼對。

最後固定兩行：
- **這是「找過」，不是「通過」**——我只對了清單上的東西，清單上沒有的我看不到。
- 我讀了哪些檔案、哪些找不到（找不到的話：用的是通用判準）。

## 收尾（一定要做：這是這一關結案的唯一證據）

把結論記給儀表板，儀表板會照實標「AI 說」。說明第一行是結論（第一步那一行：派了幾個 agent、或第幾輪只看了哪幾個檔），之後一行一條發現（一句話就好，儀表板會一條一條列出來）：
- 沒對到任何已知死法 → `agy-pipeline --report D ok "沒對到已知死法"`（英文：`agy-pipeline --report D ok "didn't match any known failure pattern"`）
- 有發現 → `agy-pipeline --report D found "找到 N 條
- [判準] 一句話
- [判準] 一句話"`（英文：`"Found N` 之後一樣一行一條 `- [criterion] one sentence`）

沒有 `agy-pipeline` 這個指令的話：`node "<agy-pipeline 的資料夾>/status.mjs" --report D …`——
那個資料夾就是 `~/.gemini/config/plugins/agy-pipeline` 指向的位置。

**還在背景跑（交給 subagent 了、還沒回來）就照實說還在跑，不准先記 ok 交差。** 跑完才記。

**記完就停：這一關不准自己再叫第二次。** 被叫去找問題的檢查每一輪都找得到東西，自己一直重跑會沒完沒了（2026-09-17：同一件事連跑三輪，用量上限就是這樣燒掉的）。

## 修完之後：要不要再跑，先問人

這一輪已經有這一關的結論、之後又改了程式檔（修了發現、或使用者又交代了別的）→ **不准自己再叫這一關**，先停下來問使用者。
問之前跑 `agy-pipeline --round D` 拿事實，然後用白話＋舉例講四件事：

1. **第一輪之後改了什麼**——它列的那幾個檔。
2. **每條修法標「小修」或「建議再看」**：改到危險清單的檔、或改的檔比第一輪指出的位置多（修法蔓延到別處）→ 建議再看；
   其餘是小修，照實講有沒有測試守著（它那一行「這一輪有沒有動到測試檔」）。你只准把小修往上調成建議再看（寫理由），**不准往下調**。
3. **上一輪從叫到記結論花了多久**——它給的數字；給不出就說「紀錄裡看不到」，**不准估**。用了多少 tokens 看不到，不講。
4. **不跑的風險**：沒再看的那幾個修法，哪裡可能出事、使用者會看到什麼。

最後一行給建議：全部小修 →「我建議不跑」；有任何一條建議再看 →「我建議跑」。
英文：每條標 small fix 或 worth another look；最後一行是 "I recommend not running it" 或 "I recommend running it"。
可用精簡的選項卡（`ask_question`，單題聚焦、選項精簡在 200 字內）或一般對話問，兩種方式感測器與轉錄檔都對得回使用者的原話（保留純文字回話完全相容）。
**使用者的決定才算數**：
- 使用者說跑 → 再叫這一關（照第一步：第二次以上自己看、只看那幾個檔）。
- 使用者說不用 → `agy-pipeline --decide D skip "使用者的原話"`。儀表板附的是感測器與轉錄檔記的、使用者在這一關被叫之後說的最後一句（或在選項卡點的回覆），不是你轉述的；
  畫面照實寫「你說不用再跑」，不打勾。

### 結案升版與 D 的順序提醒（Version bump & D order）

- 若本輪結案預計升版並改動 `tiers.danger`（或 `tiers.code`）上的版本檔（例如 `plugin.json`），**先完成升版與規格搬移，再執行最後一輪 D，或再請使用者決定 `--decide D skip`**（D 尚無紀錄時不可 `--decide`）。
- 原因：D 過期比的是 D 被叫的時間，`--decide D skip` 也只覆蓋**使用者說話（或點選項卡）那一刻之前**的改檔；詢問使用者之後或記完決策才改版本檔，會讓 D 重新過期並再次觸發 `D:ask` 收工門禁擋下。
- English: If wrapping up this round includes bumping the version in a file on `tiers.danger` (or `tiers.code`, e.g., `plugin.json`), finish the version bump and spec move **before** running the final D round or asking the user for `--decide D skip` (when D has no record yet, `--decide` cannot be used). Because `--decide D skip` only covers edits made **before the user spoke or replied**, editing a tracked version file afterwards marks D stale again and re-triggers the `D:ask` stop gate.

這一輪從哪算起：到下一次寫規格（A）或蓋章為止都是同一輪——使用者回「修掉吧」之後，你修完也一樣先問，不自動再跑。

## 檢查完之後

發現了清單上**沒有**的新死法形狀 → 說出來，並建議它該進教訓（`docs/LESSONS.md`，記事件）還是模式（`docs/FAILURE-PATTERNS.md`，會重複的形狀）。
專案還沒有這兩份 → 建議開一份，**不要替它開**——這一關不動檔案。

## 邊界

- 專案自己也有 `chaos-check` 技能 → 兩個並存，使用者叫哪個就跑哪個。產線監視器把兩種名字都算成 D 這一關。
- 寫完規格後、動手寫程式前的規格預審由 `spec-precheck`（記 `--precheck`）負責，與程式 D（`chaos-check`，記 `--report D`）徹底分開。
