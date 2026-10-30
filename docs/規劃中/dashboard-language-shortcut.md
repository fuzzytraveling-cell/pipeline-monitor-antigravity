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

**AC-1 Pressing L does exactly what the language button does — including when it can't switch**
> **In plain words**: A second light switch wired to the same circuit, not a second circuit. When the bulb doesn't come on, it says so the same way the first switch does.
> **What happens**: On any dashboard page, pressing L (nothing else held) switches Chinese → English or English → Chinese, like clicking the button. The page changes only after the server answers that the setting really changed.
> If it didn't (no connection, the service still running an older program, the setting couldn't be written), the button's own sentence appears next to the button and the page stays as it was.
> Like the button, it changes the one language setting: `pipeline-status` in the terminal and the messages Pipeline Monitor gives Claude switch too.
> **Technical**: The key calls the existing `switchLang(button)` — no second copy of the request or the sentences (P2, P6). It asks for the language written on the button (`en`/`zh`), never "the other one":
> if another tab or the terminal already switched, a toggle would undo that. `/api/lang` already exists; if `server.mjs` stays untouched, open tabs load the new `app.js` by themselves (they reload when it changes).

**AC-2 Typing an L in a box types an L**
> **In plain words**: Writing a word with an L in it must not flip the whole wall — or throw away what you were writing.
> **What happens**: While the cursor is somewhere you type — today that's the box for the reason when you raise the tier, and the tier picker next to it — L does what it normally does there.
> Nothing switches and what you typed stays. Same while a Chinese input method is still composing characters.
> **Technical**: Ignore the key when focus is in `input`, `textarea`, `select` or anything editable, and while `isComposing` (or `keyCode` 229). Test both directions (P4): L in the reason box → no request; L with focus on the page → one request.

**AC-3 The browser's own shortcuts with L stay the browser's**
> **What happens**: Cmd+L (jump to the address bar) and any L pressed together with Cmd, Ctrl or Option do only what the browser does; the language doesn't change. Shift+L, or L with Caps Lock on, still counts as L.
> **Technical**: Ignore when `metaKey`, `ctrlKey` or `altKey` is held.

**AC-4 One press, one switch: holding L doesn't make the page flicker**
> **In plain words**: Leaning on the switch must not make the lights blink on and off.
> **What happens**: Holding L down switches once; the reloaded page doesn't switch back while the key is still down. Pressing L again before the server has answered does nothing extra. Once the page has switched, pressing L again switches back.
> **Technical**: Ignore `event.repeat` (the reloaded page also gets the held key's repeats). Ignore while the button is disabled — the guard clicks already have. `switchLang` already clears the reload guard, so a quick switch back works; a test should show it.

**AC-5 You can find out about the shortcut, in the language you'd switch to**
> **In plain words**: A shortcut nobody knows about doesn't exist. And the note has to be readable by the one who needs it: the person who can't read the current language.
> **What happens**: Hovering over the button shows "Switch to English (shortcut: L)" on the Chinese page and 「切換成中文（快速鍵：L）」 (Chinese for "Switch to Chinese (shortcut: L)") on the English page — the same rule as the button's own label.
> Screen readers announce the key too. `README.md` gets one line next to `--lang`.
> **Technical**: `title` and `aria-keyshortcuts="L"` on the button. `pageIn` only swaps the text between tags, not attributes: set them from `app.js`, or teach `pageIn` (then the service needs `--serve-restart`).
> The tests that look for Chinese on the English page get this note as one more named exception next to the button's 「中文」 — not a looser rule (P4).

**AC-6 If you never press L, nothing is different**
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
