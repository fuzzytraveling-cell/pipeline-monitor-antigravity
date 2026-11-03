---
description: 設定或調整這個專案的「分級」（產線監視器 pipeline-monitor 的功能：這次改動要多小心）。使用者說「幫我設定分級」「幫我看危險清單」「這個專案不用分級」「這次算 T2」「分級」「危險清單」時用；收工 hook 擋下來問危險清單時也用。 English — set up or adjust this project's tiers (a Pipeline Monitor feature for how careful this change needs to be). Use it when the user says "set up tiers", "set up tiers for me", "look at my danger list", "this project doesn't need tiers", "this change counts as T2", "tiers", "danger list"; also when the end-of-turn hook stops to ask about the danger list.
---

# 分級設定（產線監視器）

分級回答「**這一次改動**要多小心」：看這次改的檔案落在哪裡，對兩張**人寫的**清單查表，決定五關裡哪幾關必須有紀錄。
清單住在專案的 `.claude/pipeline-stages.json` 的 `tiers`：

```json
{
  "tiers": {
    "code":   ["src/"],
    "danger": ["src/services/export/exporters.ts"]
  }
}
```

- `code`（程式區）：程式住的資料夾。碰到 → 第二級。
- `danger`（危險清單）：改錯了**不會馬上看見、幾天後才發現使用者的東西壞了**的檔案（路徑相對專案根目錄；以 `/` 結尾代表整個資料夾）。碰到 → 第三級。
- 三級的名字與需要的關預設是 T0／T1（需要 D）／T2（需要 A、D、這次要有測試檔）；專案可加 `levels` 覆寫。

指令 `pipeline-status` 沒有的話，用 `node "<pipeline-monitor 的資料夾>/status.mjs"`——那個資料夾就是 `~/.claude/skills/pipeline-monitor` 指向的位置。

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

英文那幾句（下面每一處中文的說法，英文都照這一份）：
- 挑危險清單的三個問題：Does it read or write things the user made (their data, their files)? Does it touch storage, the cloud, a database, or someone else's source files?
  If it goes wrong, does the user see it on the screen right away, or find out days later? — only "days later" goes on the list.
- 清單空的時候：the third level will never come up（不要講成「設定好了」）。
- `--tier-checked` 只記判斷過了（judged），不是清單是對的；`--tier-later` 只記這個對話先不問（not this time），不是判斷過了。

## 「幫我設定分級」（"set up tiers"）

1. 在專案根目錄跑 `pipeline-status --tier-init`。它會提議程式區、寫出骨架（危險清單是空的），並說明檔案有沒有進版控。
   程式區提議得不對，直接改 `tiers.code`（可以列多個）。
2. 讀程式區裡的檔案，用三個問題挑**危險清單**：
   - 這個檔案會**讀寫使用者做出來的東西**嗎？（他們的資料、他們的檔案）
   - 它會碰**儲存、雲端、資料庫、別人的原始檔**嗎？
   - 改錯了，使用者是**當場在畫面上看到**，還是**幾天後才發現**？——「幾天後」才進清單。
   畫面按鈕、排版、文案改錯了當場看得見，**不進**清單。
3. **先把清單列給使用者確認，每一個檔案附一句為什麼。等他說好才寫。** 決定是他的，不是你的。
4. 寫進 `tiers.danger`（其他鍵原封不動），然後照使用者確認時的原話跑 `pipeline-status --tier-checked "使用者的原話"`——
   記下「危險清單是這一刻判斷過的」，之後分級卡只問這一刻之後才新加的程式檔。最後跑 `pipeline-status` 看「分級」那段有沒有出現。
5. 清單空的時候，畫面會明講「永遠不會出現第三級」——不要把「空的」講成「設定好了」。

## 「幫我看危險清單」（"look at my danger list"）

分級卡講「這一輪碰到 N 個危險清單定好之後才新加的程式檔」或「危險清單裡有 N 個已經不在了」時，使用者會這樣說
（英文的分級卡：This round touched N code files added after the danger list was …／N entries in the danger list are gone）。

1. 跑 `pipeline-status --tier-review`：清單定好（或上一次判斷）之後才新加、不在清單上的程式檔（整個專案），與清單裡已經不在的那幾條。
2. 新加的檔：每一個用上面那三個問題判斷，**列給使用者確認，每一個附一句為什麼**；不在了的那幾條：找得到新名字就提「換成新名字」，找不到就提「拿掉」。
3. 使用者說加才加、說刪才刪、說都不用就都不動。**決定是他的。** 只判斷了一部分的話，照下面「收工 hook 問危險清單時」第 4 步先講清楚再讓他選。
4. 照他確認時的原話跑 `pipeline-status --tier-checked "使用者的原話"`——沒附原話不收。沒跑這一行的話，分級卡不知道判斷過了，會照舊問（清單改了還沒存檔時，會講分不出來）。
   它會記下這一刻的版本與還沒存檔的程式檔：判斷過的檔之後存檔、再改，都不會再被當成新的。

## 收工 hook 問危險清單時（when the end-of-turn hook asks about the danger list）

收工 hook 擋下來說「這一輪碰到 N 個危險清單定好之後才新加、還沒人判斷過的程式檔」（英文：Danger list: this round touched N code files added after the danger list was … that nobody has judged yet）時：

1. **不要自己決定，也不要先跑其他缺的關。** 他的答案會改這一輪的等級（加進清單就變最高那一級，收工前要補那一級要的關）。
2. 先跑 `pipeline-status --tier-review`，**它列的每一個檔都要問**（不只收工 hook 列的、這一輪碰到的那幾個）——`--tier-checked` 記的是「整份清單判斷過了」，
   只問一部分就記，沒給使用者看過的新檔也會一起被當成判斷過。停下來問使用者（白話＋舉例）：每個檔用上面那三個問題，附一句為什麼；講清楚加進清單的代價；最後一行給建議。
3. 每一個都判斷了：照「幫我看危險清單」第 3、4 步——說加才加進 `tiers.danger`，再照他的原話跑 `pipeline-status --tier-checked "使用者的原話"`。
   它會列出這一筆算判斷過的是哪幾個——有沒問過的，告訴使用者。
4. 只判斷了一部分：先跟他講清楚——**清單一改、一存檔，沒判斷的那幾個就算清單考慮過了，之後不會再問**；讓他選一起判斷完（照第 3 步），或清單這次先不動。
   他說這次先不看：清單不動、**不跑 `--tier-checked`**；照他的原話跑 `pipeline-status --tier-later "使用者的原話"`。
   這個對話的收工 hook 就不再為這一輪碰到的那幾個檔問；換一個對話碰到它們，會再問一次。
   **沒問就不准記**：收工 hook 問了之後、這一筆之前，沒有使用者說的話，這筆不算數，收工 hook 照樣問。它會附上使用者說的最後一句給你對照。

## 「這個專案不用分級」（"this project doesn't need tiers"）

跑 `pipeline-status --tier-off "理由"`。設定檔會記下來，對話開始時不再提醒。要恢復：`--tier-init`。

## 「這次算 T2，因為…」（"this change counts as T2, because …"）

跑 `pipeline-status --tier T2 "理由"`。只准往上（比機器算的高），理由必填；收回是 `--tier-retract`。
往下沒有指令——要改設定檔，不方便是故意的。

## 規矩

- 工具不猜危險清單；你可以提，決定是使用者的。
- 「需要」那幾關只講有沒有紀錄，不講通過。不擋蓋章。
- 之後新加了會寫檔的功能，要提醒使用者把它加進 `danger`——寫出資料的程式碼跟這一行清單，是同一個動作的兩半。
- `--tier-checked` 只記「判斷過了」，不代表清單是對的：工具不知道哪個檔危險，只知道哪些檔是判斷之後才出現的。
- `--tier-later` 只記「這個對話先不問」，不是判斷過了：分級卡照舊講那幾個檔還沒有人判斷。
