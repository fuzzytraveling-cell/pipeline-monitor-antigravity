# 功能：做成 plugin —— 裝一次，每個專案自動記；不想記的按一下退出

> 2026-09-11 開工。Oscar 的決定：**預設全記、可退出**，退出做成儀表板上的按鈕。
> 對應 [`../ROADMAP.md`](../ROADMAP.md)「怎麼做到裝到任何專案都能用」，
> 以及 [`../升級摘要/sensor-install.md`](../升級摘要/sensor-install.md) 當初想做的「同意單」（方向反過來）。

## 這是為了解決什麼

現在每個專案要跑一次 `--on`，把 hook 的**絕對路徑**寫進那個專案的設定檔：
搬家會靜默失效（L13）、worktree 沒有自己的設定（L13 第二次）、第二個專案要再裝一次。

Claude Code 的 plugin 裝在使用者層級，hook 在每個專案都跑，路徑用 `${CLAUDE_PLUGIN_ROOT}` 指向 plugin 自己——
三個問題一起消失。「綁定新專案」變成**什麼都不用做**。

## 驗收條件

**AC-1　裝一次就好**
> `pipeline-status --install` 把捷徑放到 `~/.claude/skills/pipeline-monitor`，下一個對話開始記。
> ⚠️ 工具只能確認「捷徑放好了」，**不能確認 Claude Code 真的載入了**（R1）——驗證方法照 README：
> 開一個新對話打一句話，感測器那一行出現「最後一筆來自這裡的紀錄」。

**AC-2　退出馬上生效，之前的紀錄還在**
> 主資料夾有 `.claude/pipeline-monitor.off` 就一筆都不記。hook 每次呼叫都看它，所以按下去不用開新對話。
> 從子資料夾、worktree 呼叫也看得到（往根目錄與主資料夾找）。

**AC-3　舊接法要拆，不然會記兩次**
> plugin 裝了、專案設定檔裡還有舊 hook → 畫面說「會記兩次」；`--on`／`--off` 順手拆掉舊接法。

**AC-4　按鈕只能對認識的專案動手**
> `/api/optout` 的 `root` 是瀏覽器送來的字串，只准是儀表板現在列得出來的主資料夾；其他一律 400、不寫檔。

**AC-5　E 驗收從「未建」變成「有紀錄」——但永遠不是「通過」**
> 感測器多接瀏覽器工具（`mcp__Claude_Browser__*`、`mcp__claude-in-chrome__*`），
> E 顯示「N 前開瀏覽器跑過一輪（M 個動作）」。跟 A／C／D 一樣是「跑過」（R2）。
> 真正的驗收證據帳是下一份規格的事。

**AC-6　接點清單只有一份**
> 舊接法從 `hooks/hooks.json` 讀，兩種掛法接一樣的事件（老毛病 P2）。

## 刻意不做

- 不做 marketplace：一個人用，捷徑就夠；要分享時再包。
- 不在 plugin 裡放 A／C／D 的 skill：流程要能換（ROADMAP 說的最大設計風險），另開規格。
- 不做 `/pipeline-monitor:status` 指令：先讓感測器對，指令是甜點。

## 如果捷徑那條路不通

這台機器的 Claude Code 是桌面 app 內建的，我查不到它的版本。「`~/.claude/skills/` 底下的資料夾自動當 plugin 載入」
是較新的功能；萬一新對話沒有開始記，備案是用 `/plugin` 從本機 marketplace 安裝——
在這個 repo 加一個 `.claude-plugin/marketplace.json` 指向自己，然後 `/plugin marketplace add <路徑>`、`/plugin install pipeline-monitor`。
hooks.json 兩條路都適用。

---

## 施作紀錄

### 2026-09-11　第一版（commit `77d00d1`＋收尾）

- `.claude-plugin/plugin.json`、`hooks/hooks.json`：接點清單只有這一份；舊接法（`--on`）改從它讀，測試釘住兩邊一致。
  PreToolUse 多接 `mcp__Claude_Browser__.*|mcp__claude-in-chrome__.*`，E 驗收因此有紀錄。
- `hook.sh`：算完專案身分後先看 `.claude/pipeline-monitor.off`（cwd、根目錄、主資料夾三處），有就 `exit 0`。
  測試：有記號一筆都不記、子資料夾也看得到、拿掉馬上又記；用 hooks.json 裡那一行指令（`${CLAUDE_PLUGIN_ROOT}`）真的跑一次。
- `lib/mount.mjs`：`pluginState`（捷徑／marketplace 兩種裝法；捷徑斷了 = `dangling`，畫面講 broken 不講「沒裝」）、
  `installPlugin`／`uninstallPlugin`（只放／只拆自己放的捷徑，別的東西一律不動）、`optOut`／`optIn`／`optOutState`。
  `mountState` 回 `where:'plugin'`、`optedOut`、`alsoLegacy`。
- `status.mjs`：`--install`／`--uninstall`；plugin 在時 `--on`＝拿掉記號＋拆舊接法、`--off`＝放記號＋拆舊接法。
  感測器那一行多三種話：「已掛上（plugin,每個專案都會記）」「已退出記錄（N 前）」「設定檔裡還有舊接法,會記兩次」。
- `server.mjs`：`/api/optout`，root 只准是儀表板列得出來的主資料夾（測試：陌生資料夾 400、不寫檔）。
- `ui/app.js`：案件頁一行「感測器會記這個專案的每個對話 [退出記錄]」／「已退出記錄（N 前）[重新加入記錄]」；
  五關的 E 顯示「N 前開瀏覽器跑過一輪（M 個動作）」。
- `.gitignore`／privacy 測試補 `.claude/pipeline-monitor.off`。

**這台機器上的安裝**：`pipeline-status --install` 放了 `~/.claude/skills/pipeline-monitor → ~/Desktop/pipeline-monitor`；
四個之前用 `--on` 掛過的地方（pipeline-monitor 主資料夾、TutorPod 主資料夾與兩個 worktree）都跑過 `--on` 把舊接法拆掉（各有備份）。
儀表板上按「退出記錄」→ 主資料夾出現記號檔、API 回 optedOut；按「重新加入」→ 記號消失。

⚠️ **還沒驗證的**：Claude Code 是否真的把捷徑當 plugin 載入——要開一個新對話才知道（AC-1 的 R1 保留）。
沒通的話走「如果捷徑那條路不通」那段的備案。
