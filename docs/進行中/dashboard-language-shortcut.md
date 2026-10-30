# Feature: Press L to switch the dashboard between English and Chinese

Tier: predicted at least **T1** — expected to touch `ui/app.js`, maybe `ui/index.html` (both in the program area), plus tests in `scripts/` and one line of `README.md` (not in it).
Nothing on the danger list. T1 asks for a Chaos check (D).

> Written 2026-10-30 with `/pipeline-monitor:spec`, in English because the person asking reads English, not Chinese. It builds on [the language button](../升級摘要/儀表板與終端機中英切換.md).
> Read: `CLAUDE.md`, `README.md`, `docs/FAILURE-PATTERNS.md` (P2, P4, P6), `docs/升級摘要/分級.md`, `docs/升級摘要/工地工班風畫面.md` (AC-16: hover text is already used here), `.claude/pipeline-stages.json`, `stages.json`;
> code: `ui/app.js` (`switchLang`, the click handler, the tier form), `ui/index.html`, `ui/ui.css` (the top bar stays on screen when you scroll), `server.mjs` (`/api/lang`, `pageIn`, `appVersion`), `gate.mjs`, `remind.sh`, `status.mjs` (all read the same setting);
> tests: `scripts/lang.test.mjs` (the button's tests, the `uiOf` harness), `scripts/docsIndex.test.mjs`. Nothing in `docs/` about keyboard shortcuts. No `docs/SPEC-TEMPLATE.md`: used the skill's English format.

## What this solves

Switching languages from the keyboard, without hunting for the small button in the top-right corner — handy when flipping back and forth to compare, or when showing the dashboard to someone who reads the other language.

## Acceptance criteria

**AC-1 Pressing L does exactly what the language button does — including when it can't switch** ✅ ticked 2026-10-30
> **In plain words**: A second light switch wired to the same circuit, not a second circuit. When the bulb doesn't come on, it says so the same way the first switch does.
> **What happens**: On any dashboard page, pressing L (nothing else held) switches Chinese → English or English → Chinese, like clicking the button. The page changes only after the server answers that the setting really changed.
> If it didn't (no connection, the service still running an older program, the setting couldn't be written), the button's own sentence appears next to the button and the page stays as it was.
> Like the button, it changes the one language setting: `pipeline-status` in the terminal and the messages Pipeline Monitor gives Claude switch too.
> **Technical**: The key calls the existing `switchLang(button)` — no second copy of the request or the sentences (P2, P6). It asks for the language written on the button (`en`/`zh`), never "the other one":
> if another tab or the terminal already switched, a toggle would undo that. `/api/lang` already exists; if `server.mjs` stays untouched, open tabs load the new `app.js` by themselves (they reload when it changes).

**AC-2 Typing an L in a box types an L** ✅ ticked 2026-10-30
> **In plain words**: Writing a word with an L in it must not flip the whole wall — or throw away what you were writing.
> **What happens**: While the cursor is somewhere you type — today that's the box for the reason when you raise the tier, and the tier picker next to it — L does what it normally does there.
> Nothing switches and what you typed stays. Same while a Chinese input method is still composing characters.
> **Technical**: Ignore the key when focus is in `input`, `textarea`, `select` or anything editable, and while `isComposing` (or `keyCode` 229). Test both directions (P4): L in the reason box → no request; L with focus on the page → one request.

**AC-3 The browser's own shortcuts with L stay the browser's** ✅ ticked 2026-10-30
> **What happens**: Cmd+L (jump to the address bar) and any L pressed together with Cmd, Ctrl or Option do only what the browser does; the language doesn't change. Shift+L, or L with Caps Lock on, still counts as L.
> **Technical**: Ignore when `metaKey`, `ctrlKey` or `altKey` is held.

**AC-4 One press, one switch: holding L doesn't make the page flicker** ✅ ticked 2026-10-30
> **In plain words**: Leaning on the switch must not make the lights blink on and off.
> **What happens**: Holding L down switches once; the reloaded page doesn't switch back while the key is still down. Pressing L again before the server has answered does nothing extra. Once the page has switched, pressing L again switches back.
> **Technical**: Ignore `event.repeat` (the reloaded page also gets the held key's repeats). Ignore while the button is disabled — the guard clicks already have. `switchLang` already clears the reload guard, so a quick switch back works; a test should show it.

**AC-5 You can find out about the shortcut, in the language you'd switch to** ✅ ticked 2026-10-30
> **In plain words**: A shortcut nobody knows about doesn't exist. And the note has to be readable by the one who needs it: the person who can't read the current language.
> **What happens**: Hovering over the button shows "Switch to English (shortcut: L)" on the Chinese page and 「切換成中文（快速鍵：L）」 (Chinese for "Switch to Chinese (shortcut: L)") on the English page — the same rule as the button's own label.
> Screen readers announce the key too. `README.md` gets one line next to `--lang`.
> **Technical**: `title` and `aria-keyshortcuts="L"` on the button. `pageIn` only swaps the text between tags, not attributes: set them from `app.js`, or teach `pageIn` (then the service needs `--serve-restart`).
> The tests that look for Chinese on the English page get this note as one more named exception next to the button's 「中文」 — not a looser rule (P4).

**AC-6 If you never press L, nothing is different** ✅ ticked 2026-10-30
> **What happens**: Apart from the hover note, every page reads and looks as before in both languages. The terminal, the hooks and the records are untouched.
> **Technical**: The existing tests stay green without changing what they expect. The test harness's fake page throws event listeners away (`addEventListener: noop` in `uiOf`); it has to keep them so a test can press a key.

## What could go wrong

▸ Network: the server is down, or still running an older program, when you press L → the button's sentence next to the button, page unchanged (AC-1).
▸ Concurrency: two tabs open, or `--lang` in the terminal at the same moment → the key asks for the language on its button, so it never undoes the other change; the other tab follows on its next refresh (already so today). Two presses before the answer → one request (AC-4).
▸ Time: a held key keeps repeating, including on the freshly reloaded page → ignored (AC-4).
▸ Malformed input: with the Mac's Chinese input method on, or a non-US keyboard layout, the browser might report something other than "l" for the L key → also accept the physical L key, and try it in a real browser with the Chinese input method on (E) — a test can't show this.
  A browser extension that already uses L might take the key first; the page can't prevent that, and the button still works.
▸ Permissions: the language setting can't be written → the button's sentence (AC-1).

## Not doing (on purpose)

- No dashboard-only language. L flips the same single setting as the button, so the terminal and Claude's messages switch too; a separate page language would be a second source that can disagree with the first.
- No terminal shortcut: `pipeline-status --lang en` / `--lang zh` already does it.
- No other shortcuts, no list of shortcuts, no setting to change or turn off L. Accessibility guidelines (WCAG 2.1.4) ask that single-key shortcuts can be turned off, mainly for people who use voice control or hit keys by accident — revisit before the dashboard is shared publicly (ROADMAP "分享給別人").
- No new sentence when the switch works (the page reloads, as with the button); no change to the button's look or place; the note is hover-only, no key printed on the button.
- No third language.

## 施作紀錄

### 2026-10-30　B 寫程式（同一個對話：A 寫完，Oscar 點頭就接著做）

- Oscar 點頭的原話：「好，開工」（回「照這份規格開工嗎？」）。照英文寫的這一份做，沒改寫成中文。
- 開工前看過：pipeline-monitor 另外 10 個資料夾都沒有還沒存檔的改動，也沒有比 main 新的存檔；main 還在 375f8a3（這個分支開的地方）。
  規格搬到進行中，索引跟著改。
- 用量（量的）：開工時這週 92%（12 分鐘後重算）、五小時 52%。
- 做了什麼：
  - `ui/app.js`：按 L 叫按鈕原本那一個 `switchLang`，送的、等伺服器、換不成講的那一句都沒有第二份。`isLangKey` 判斷這一下算不算：
    在格子裡（輸入框、下拉選單、多行的格子、可以直接編輯的區塊，整個分級表單連送出那顆也算）、輸入法還在組字（isComposing、keyCode 229）、
    按著 Cmd／Ctrl／Option、按著不放（repeat）都不算；認打出來的 l／L，打出來的不是英文字母時才認實體的 L 鍵。按鈕灰著（還在等伺服器、或換成了正在重新載入）就不再送。
    提示（title）與 aria-keyshortcuts="L" 由 app.js 跟按鍵同一刻裝上：中文的畫面寫 Switch to English (shortcut: L)、英文的畫面寫「切換成中文（快速鍵：L）」。
    `server.mjs`、`ui/index.html`、`ui/ui.css` 一行沒動。
  - `README.md`：改 `--lang` 那一行（「儀表板右上角那顆按鈕、在儀表板上按 L，改的都是同一份」），沒有另加一行。
  - 測試 `scripts/lang.test.mjs`：真的跑整支 app.js 按鍵——走同一條路（標 P2）、不該換的十三種與該換的四種（標 P4）、按兩下只送一次、剛為了語言載過照樣換、提示兩種語言。
    假頁面以前把掛上去的事件丟掉，現在留著（AC-6 寫的）；`scripts/expiry.test.mjs` 的假元素補 setAttribute。英文的畫面刻意寫中文的那一句，
    在掃中文字串的測試裡照原文列成例外（另開一張小表，不放進「資料格式」那張）。
  - 故意弄壞六種（不擋分級表單、不擋按著不放、實體 L 鍵一律認、不看按鈕灰不灰、Cmd／Option 不擋、提示不照要切過去的那一種），每一種都讓對應的那一題當場紅；放回去全綠。
- 預覽（另一個埠、讀紀錄的複本、語言設定寫在複本裡；常駐的儀表板與真的紀錄沒碰，真的那一份語言設定前後一個位元組沒變；用完關掉、暫時的預覽設定拿掉、複本刪掉）：
  - 按 L：中文 → 英文 → 中文，整頁換，按鈕上的字與提示跟著換；主控台、伺服器沒有錯誤。
  - 分級表單的理由格按三次 L：三個 l 留在格子裡、沒有換；游標停在表單的送出（Raise）上按 L：沒有換；移出表單再按：換。
  - 沒在真的瀏覽器裡按過、只有測試演過的：Cmd／Ctrl／Option + L（預覽的窗格可能自己接走 Cmd+L）、按著不放、注音輸入法開著。注音那一種要你自己試一次。
  - 滑鼠移上去的提示是作業系統畫的，截圖拍不到；那一段字是從畫面上的按鈕讀出來的。
- D 魔鬼教官第一輪（T1，沒派 agent，我自己看；從叫到記結論 4 分鐘）：找到 1 條，修了。
  - [P2] 開著兩個分頁、在其中一個十秒內來回切兩次（按 L 來回比就是這樣），另一個分頁被「十秒內不重複載」那一道擋住，照另一種語言的資料畫出半中半英，十秒後才換。
    只有按鈕的時候就有，只是要很快點兩下；在測試的假頁面裡重現過。規格「What could go wrong ▸ Concurrency」那一句（另一個分頁下一次更新就跟著換）修之前並不總是對。
  - 修法：那一道記下「為了換成哪一種」，只擋同一種又來一次（`ui/app.js` 的 reloadForLang 與叫它的那一行）。測試多一段（標 P2）：新的一次要載、真的對不上要擋、舊的程式記的只有時間就當成沒載過；
    把修法拿掉，新的一次與舊的記號那兩題當場紅。
  - 預覽兩個分頁演過：先擺好「剛為了中文載過」（還在十秒內），另一頁切成英文，這一頁照樣跟著換成英文。只靠自然的時間差試的那一次，離上一次載入已經 12 秒，新舊寫法都會載，分不出來——所以才擺前提。
  - FAILURE-PATTERNS 的 P2 補一例、教訓 L50。
- `npm test` 22 支全綠（D 修完之後再跑一次也是）。
- 清單對過（每一條怎麼對的）：
  - AC-1 ✅：測試——按 L 送到同一個地方、伺服器回了才重新載入、換不成的三種講的跟按鈕同一句、app.js 送換語言的只有一處；預覽——案件列表頁、對話頁按 L 都換了。
    終端機與給 Claude 的話跟著換，是因為讀同一個設定檔（這次沒動那幾支），沒有另外試。
  - AC-2 ✅：測試（輸入框、下拉選單、分級表單的送出、多行的格子、可編輯的區塊、組字、keyCode 229）；預覽（理由格、送出那顆）。組字只有測試。
  - AC-3 ✅：測試（Cmd、Ctrl、Option）。真的瀏覽器裡沒按。
  - AC-4 ✅：測試（按著不放、還在等伺服器又按、換成了正在重新載入又按、剛為了語言載過馬上又按）；預覽裡來回切過兩次。按著不放沒在真的瀏覽器試。
  - AC-5 ✅：測試與預覽都讀到兩種語言的提示、aria-keyshortcuts 是 L；README 改了 `--lang` 那一行。
  - AC-6 ✅：舊的測試期待的字一個沒改（只補了假頁面的 setAttribute、留著掛上去的事件），22 支全綠；`server.mjs`、`ui/index.html`、`ui/ui.css`、終端機、hook、紀錄都沒動。
    唯一跟以前不一樣的：D 那一條修好之後，別的分頁十秒內換回去會跟著換，不再畫半中半英。
- 用量（量的）：做到這裡，這週那一格重算過了是 0%、五小時 61%（同一段時間別的對話也在跑，不全是這一份用的）。
- 刻意沒做：打了理由、游標移到格子外再按 L，整頁重新載入、理由不見——按按鈕本來就這樣，規格沒列，這次不改。
