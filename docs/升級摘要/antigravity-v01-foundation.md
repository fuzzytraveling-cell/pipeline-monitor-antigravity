# 功能：pipeline-monitor Antigravity 專用版 v0.1 地基

分級：預測至少 **T2**——會動到危險清單上的 `hook.sh`、`hooks/hooks.json`（遷移為根目錄 `hooks.json`）、`lib/events.mjs`、`lib/paths.mjs`、`lib/mount.mjs`、`lib/checkpoint.mjs`，外加 `gate.mjs`、`gate.sh`、`remind.sh`、`server.mjs`、`status.mjs`、`stages.json`、`package.json`、`plugin.json`、`rules/AGENTS.md`、`AGENTS.md`、`lib/`（新增 `lib/transcript.mjs` 與各模組對齊）、`ui/app.js`、`skills/` 6 支技能與 `scripts/` 全套測試。T2 收工要求 A、C、D 與補測試。

> 2026-11-20 規劃。採用方案 B：將此克隆體打造成乾淨專職的 Antigravity 版本，與原版 Claude 版本完全並行隔離。
> 基於本機階段 0 已實測確認的 8 項事實（工具名與參數、`PostToolUse` 完整 payload、`ask_question` 記於 transcript、人類與 subagent 辨識特徵、`SessionStart` 注入格式、`Stop` 擋收工與 `executionNum > 0` 防迴圈、終端機原生環境變數 `ANTIGRAVITY_CONVERSATION_ID` 與 `ANTIGRAVITY_AGENT=1`、`~/.gemini/config` 系統保護）。
> 讀了：`CLAUDE.md`、`docs/ROADMAP.md`、`docs/FAILURE-PATTERNS.md`、`docs/升級摘要/plugin.md`、`docs/升級摘要/紀錄搬到固定的家.md`、`package.json`、`stages.json`、`hooks/hooks.json`、`hook.sh`、`remind.sh`、`gate.sh`、`gate.mjs`、`server.mjs`、`status.mjs`、`.claude/pipeline-stages.json`、`.claude-plugin/plugin.json`、`.gitignore`、`lib/` 核心模組、`skills/` 6 支技能、`scripts/` 測試套件，以及 Antigravity 內建定制系統規範（`agy-customizations`、`plugin`）。找不到 `docs/SPEC-TEMPLATE.md`（照既定最小規格格式）。

## 這是為了解決什麼

把現有為 Claude Code 設計的 `pipeline-monitor` 完整移植為乾淨專職的 Antigravity 原生版本（v0.1 地基），讓 Antigravity 裡的每個對話都能自動記錄、守住收工門禁、在獨立看板上即時看見「我在哪、我回得去哪、這次動了多少」，且與原本的 Claude 版和平共存、互不干擾，同時為下一階段 v0.2 主動式工作站打好資料與架構地基。

## 驗收條件

**AC-1　獨立門牌與雙軌並行：指令、看板、資料家、背景服務完全不跟原版打架** ✅ 對過 2026-11-20
> **白話**：替 Antigravity 蓋一間有自己門牌、自己帳本、自己電錶的新工地辦公室，跟原本 Claude 那一間各管各的，兩邊同時開工也不會把對方的紀錄寫花或搶同一個門號。
> **會發生的情況**：在終端機跑 `agy-pipeline` 操作的是 Antigravity 專用版；儀表板預設跑在 `http://127.0.0.1:4320/`（背景服務獨立註冊，與原版 `4319` 可同時活著）；紀錄、還原點、語言設定全住在 `~/.pipeline-monitor-agy/`（只給自己讀寫）。克隆體裡殘留的舊 Claude 專有檔案（含指向原版 `~/.pipeline-monitor/` 的捷徑）都清乾淨，不論跑程式或跑測試都絕不碰原版資料夾。
> **技術**：`package.json` `bin` 改為 `agy-pipeline`；預設埠 `4320`（`AGY_PIPELINE_PORT` 優先於 `PORT`）；`lib/service.mjs` `LABEL` 改為 `com.pipeline-monitor-agy.dashboard`、log 改至 `~/Library/Logs/pipeline-monitor-agy/dashboard.log`；`lib/paths.mjs` 預設資料家改為 `~/.pipeline-monitor-agy`（環境變數 `AGY_PIPELINE_HOME` / `AGY_PIPELINE_LOG_DIR` / `AGY_PIPELINE_CODE_HOME` / `AGY_PIPELINE_TEST_REAL_HOME`，權限 `0700`）；移除 `.claude-plugin/`、`hooks/hooks.json`、`.claude/settings.local.json*`、`.claude/launch.json` 及根目錄指向原版 `~/.pipeline-monitor/` 的 `logs`/`checkpoints` 捷徑；本專案分級設定搬為 `.agents/pipeline-stages.json` 並更新 `tiers.code`／`tiers.danger`。

**AC-2　專案設定優先讀 `.agents/`，舊專案的 `.claude/` 照樣相容且不分裂** ✅ 對過 2026-11-20
> **白話**：新工地一律把規矩掛在 `.agents/` 門口；老工地原本掛在 `.claude/` 的規矩照樣認得、不用逼每個舊專案搬家，但要改規矩時改原本那一張，不偷偷生出兩張打架。
> **會發生的情況**：同一個專案若同時有 `.agents/pipeline-stages.json` 與 `.claude/pipeline-stages.json`，系統讀 `.agents/` 那一份；只有 `.claude/` 時照常讀得到（工作區優先於主資料夾）。跑 `--tier-checked` 更新既有設定時寫回讀到的那一份；全新專案跑 `--tier-init` 或 `--tier-off` 建立在 `.agents/pipeline-stages.json`。退出記錄放 `.agents/pipeline-monitor.off`，舊專案的 `.claude/pipeline-monitor.off` 一樣生效，按「重新加入」兩處一併清除。
> **技術**：`lib/rounds.mjs` `readProjectConfig` 依序查 `[root/.agents, root/.claude, mainRoot/.agents, mainRoot/.claude]`；`lib/tier.mjs` `writeTierConfig` 支援寫回原檔 `cfg.from`、新建時寫 `.agents/pipeline-stages.json`；`dangerSince` 與 `committedDanger` 從實際 `from` 算出相對路徑（不再寫死 `.claude/pipeline-stages.json`，避開 P2/R1）；`hook.sh`、`remind.sh`、`gate.mjs`、`lib/mount.mjs` 退出記號雙路徑皆認。

**AC-3　Antigravity 原生 Plugin 與安裝：裝一次全機自動記，權限受阻就誠實指路** ✅ 對過 2026-11-20
> **白話**：按 Antigravity 自己的規格打包，終端機跑一次 `--install` 就全機自動監測；因為系統鎖著設定資料夾，萬一在 AI 裡跑寫不進去，就明白告訴你改到自己終端機跑，絕不口頭宣稱裝好了。
> **會發生的情況**：在終端機跑 `agy-pipeline --install` 會在 `~/.gemini/config/plugins/agy-pipeline` 建立指向本資料夾的捷徑，並照實說明「只能確認捷徑放好了，要開新對話並讓 AI 執行一次工具呼叫才算通」。若因權限受阻（例如從 AI 沙盒呼叫），印出明確原因與給使用者在自己終端機執行的指令，不回傳成功。未裝 plugin 時，`--on` / `--off` 可安全合併／拆解該專案的 `.agents/hooks.json`（先備份、不動別人的 hook，沒被 gitignore 會提醒）；已裝 plugin 時 `--on` / `--off` 管理退出記號。捷徑斷裂或指到殘缺資料夾時，狀態分明為 `broken` 並給出修法。
> **技術**：根目錄建立 Antigravity 原生 `plugin.json`（只用官方白名單欄位：`name`、`displayName`、`version`、`description`、`author`、`suggestedPrompts`）與根目錄 `hooks.json`（頂層 named hook 結構，`SessionStart`/`Stop` 為扁平 handler 陣列，`PostToolUse` 帶 `matcher` 群組，指令用相對路徑 `sh ./hook.sh`、`sh ./remind.sh`、`sh ./gate.sh`）；`lib/mount.mjs` 與 `lib/skills.mjs` 全面對齊 `~/.gemini/config/plugins/` 與 `.agents/`（並相容 `.claude/skills`、`.claude/commands`）；`mountState` 維持 `off` / `ok` / `broken` 三態（P3）。

**AC-4　感測器全掛 `PostToolUse`：零權限干擾、相容新舊工具名、不誤把讀檔當改檔** ✅ 對過 2026-11-20
> **白話**：攝影機只裝在「動作做完之後」，絕不卡住你按同意、也不拖慢對話；不管 Antigravity 用新版還是舊版工具名稱都認得出來，而且「看一眼檔案」絕不會被記成「改了程式」。
> **會發生的情況**：所有感測都掛在 `PostToolUse`（v0.1 不掛 `PreToolUse`）。寫檔、改檔、跑指令、開技能、開瀏覽器、問問題都會記進 `~/.pipeline-monitor-agy/logs/<專案>.jsonl`，單行嚴格低於 4096 bytes，不記檔案內容也不記代理「成功」旗標（R2）。AI 只是讀一般程式碼，不會灌爆紀錄檔，更不會讓看板誤判「B 改過程式檔」或讓收工門禁誤擋；在本專案自己資料夾裡讀取原始碼的 `skills/*/SKILL.md` 不會誤算成呼叫了該關卡；使用者自己打 `/chaos-check` 後 AI 接著讀 `SKILL.md`，合算成同一次呼叫，不會多出一筆「上次沒跑完」。
> **技術**：`hook.sh`（`/bin/sh` + `jq`）一律輸出 `{}` 並 `exit 0`（含退出、缺 `jq`、壞 JSON）；寫改 matcher 接 `write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content`（路徑取 `.toolCall.args.Path // .toolCall.args.TargetFile // .toolCall.args.AbsolutePath`）；讀檔 matcher 接 `read_file|view_file`，只對安裝於 `.gemini/config/`、`.agents/skills/`、`.agent/skills/`、`.claude/skills/`、`.claude/commands/` 底下的技能檔寫紀錄並擷取 `skill`（不過濾關卡名，守住 AC-6），其餘檔案直接快速輸出 `{}` 退出；另有 `run_command`（記截短 `CommandLine` 並遮蔽網址內憑證）、`ask_question`、`send_message`、瀏覽器工具與 `invoke_subagent`（記 `subagent_type`）。`lib/rounds.mjs` 抽出單一真相來源 `isEditEvent` / `isWriteEvent` 給 `editsOf`、`gate.mjs`、`cliRerun.mjs`、`cliReport.mjs` 共用（P2），並合併同回合 `typed`＋`SKILL.md` 讀取（及連續分段讀取同一 `SKILL.md`）為單次關卡呼叫。

**AC-5　讀懂 Antigravity 對話紀錄：分得出人話跟子 agent，剛講的話馬上算數** ✅ 對過 2026-11-20
> **白話**：工頭翻得到 Antigravity 真正的對話速記本：你剛打完「不用再跑了」或「照建議收尾」，AI 立刻去記帳就對得上你那句話；而 AI 派出去的助手（subagent）不會被錯當成「又多了一個你在跟它講話的對話」。
> **會發生的情況**：你在主對話說完「不用再跑了」，AI 馬上跑 `agy-pipeline --decide D skip "不用再跑了"`（或 `--clear E`、`--wrap`、`--tier-later`），系統當場對得到你那句真實發言與精準時間戳。AI 派出的 `research`／`browser` 等子 agent 不會在看板上多長出一張獨立對話卡、不會把單人工作區誤講成「多個對話共用」、不會觸發收工門禁；但 `browser` 子 agent 做的瀏覽器動作會歸回主對話的 E 驗收（照舊只講「開過瀏覽器」，不講驗收通過，R2）。你在自己終端機跑 `--clear E` 算你說的，AI 在對話裡跑（環境帶 `ANTIGRAVITY_CONVERSATION_ID`）算 AI 代記。
> **技術**：新增 `lib/transcript.mjs`（取代 Claude 專屬 `lib/appSessions.mjs`），依感測器記的 `transcript` 路徑（按 mtime+size 快取，讀不到照實降級不猜，R1）解析 `source:"USER_EXPLICIT"` / `type:"USER_INPUT"` 轉成標準人類發言（以 `(session, step)` 去重）與 `sessionStartOf`（取 step 0 `created_at` 或檔建立時間）；依 `lastUserInput === ""`＋step 0 `type:"SYSTEM_MESSAGE"` 含 `sender=<主ID>` 判定 subagent 與歸屬 `parentId`；`lib/cliFacts.mjs` `sessionFromEnv()` 改讀 `ANTIGRAVITY_CONVERSATION_ID`；`stages.json` E 關改認 Antigravity 瀏覽器工具與 `subagentTypes: ["browser"]`；移除 Claude Desktop 專屬 `mcp__ccd_session__*` 卡片工具與 `appCardTools` 殘留，保留 `--suggest` 與 `--cards`。

**AC-6　對話開場提醒（`SessionStart`）與收工門禁（`Stop`）符合 Antigravity 契約且絕不死迴圈** ✅ 對過 2026-11-20
> **白話**：新對話一開，還沒設分級就輕輕提一句、不打斷正事；要收工時，該跑的關還沒跑或新檔危不危險還沒問你，門禁才攔一次——如果你自己按了取消、背景工作還在跑、或門禁自己出錯，一律立刻放行，而且絕不會卡死一直重複攔。
> **會發生的情況**：在未設定分級的 git 專案開新對話，AI 會收到一行注入提示（中英照 `lang.json`）；已設分級、已退出、非 git 或子 agent 對話都安靜不打擾。收工時若本回合改了程式區且缺分級要求的關／清單沒對／結論未記／有未判斷的新危險檔，Antigravity 會收到攔阻理由並繼續把缺項補完（或停下問人）；同一回合同一項最多攔一次；使用者按取消、發生系統錯誤、背景任務還沒結束、或子 agent 結束時一律不攔。
> **技術**：`remind.sh` 依階段 0 實測契約輸出 `{"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}`（不提醒或任何錯誤一律輸出 `{}`＋`exit 0`），並略過 step 0 含 `sender=` 的 subagent。`gate.sh`＋`gate.mjs` 攔阻輸出 `{"decision":"continue","reason":"..."}`、放行與任何錯誤輸出 `{}`＋`exit 0`（維持 `_gate.json` 心跳與 `gate_broken` 記錄）。`decide()` 讀 camelCase 欄位（`conversationId`、`cwd`、`workspacePaths`、`transcriptPath`、`executionNum`、`continuationActive`、`fullyIdle`、`terminationReason`、`error`）；非 `"NO_TOOL_CALL"`、有 `error`、`fullyIdle === false`、subagent 一律放行；防迴圈判定改為 `Number(payload.executionNum) > 0 || payload.continuationActive === true`（對齊實測事實 #6），沿用「同回合同 key 不重擋，且 `again` 查無 `gate_blocked` 必放行」底線。

**AC-7　看板與終端機全套可用、中英雙語且零 Claude 殘留文案** ✅ 對過 2026-11-20
> **白話**：終端機打 `agy-pipeline` 跟打開 `http://127.0.0.1:4320/` 看到的每一句話還是同一份、照樣能一鍵切中英，畫面上的六個工地帽角色、三階梯、白板都好好的，但裡面不再出現「Claude」「pipeline-status」這種舊名字。
> **會發生的情況**：`agy-pipeline` 全部既有子指令（檢視、`--todo`、`--cards`、`--checkpoint`、`--report`、`--clear`、`--spec`、`--round`、`--decide`、`--suggest`、`--wrap`、`--tier*`、`--lang`、`--serve-*`、`--open`、`--install`/`--uninstall`、`--on`/`--off`）與本機網頁看板完整運作；中英切換即時同步，英文畫面不含任何中文與全形空白，三條紅線與禁用美化詞全守住。對話標題不偷讀未驗證的內部檔，紀錄無標題時以首句摘要顯示（R1）。
> **技術**：全站文案由 `pipeline-status`／`Claude` 改為 `agy-pipeline`／`AI`／`Antigravity`（全部住 `zhEn()`，且事件紀錄新寫 `source:'ai'`／`via:'ai'`／`by:'ai'`、讀取端相容 `'claude'`）；`server.mjs` 維持只綁 `127.0.0.1`、`Host`／`Origin`／`CSP` 防護與 4 秒共享快取；`ui/app.js` 移除 Claude Desktop 舊建議卡文案，保留 `--suggest` 建議卡區塊。

**AC-8　常駐規則 `rules/AGENTS.md` 與 6 支 Antigravity 原生 Skill 齊備** ✅ 對過 2026-11-20
> **白話**：裝上這個外掛，Antigravity 不只拿到 6 份標準作業手冊（寫規格、打掃、魔鬼教官、驗收、分級、工地主任），頭頂還會常駐一張簡短總則，隨時記得三條紅線、何時記結論、被收工門禁攔住怎麼辦。
> **會發生的情況**：`rules/AGENTS.md` 隨 plugin 自動載入，簡明覆蓋三條紅線、工作流紀律、收工門禁配合與 subagent 守則。6 支 skill（`spec`、`cleanup`、`chaos-check`、`verify`、`tier-setup`、`director`）中英雙語觸發都叫得到；E 驗收改用本工作區背景伺服器加上 Antigravity 內建 `browser` subagent 走畫面；F 工地主任改用 `agy-pipeline --suggest` 開卡與 `--wrap` 逐站收尾；D 與 E 在 v0.1 先維持一般對話問人（不搶跑 v0.2 的 `ask_question` 一鍵卡）。本專案自己的開發手冊轉成根目錄 `AGENTS.md`。
> **技術**：新增 `rules/AGENTS.md`（無 YAML frontmatter，嚴控低於 Antigravity 24,000 bytes 上限）；6 支 `skills/<name>/SKILL.md` 全具 `name`＋中英 `description`（均在 1,536 字元內，補齊 `tier-setup` 的 `name`）、清掉 Claude 專有 frontmatter 鍵、指令全換 `agy-pipeline`、專案手冊查找 `AGENTS.md`/`GEMINI.md`/`CLAUDE.md`/`README.md`、設定檔優先 `.agents/pipeline-stages.json`、用語表與 `lib/lang.mjs` `TERMS`／`RED_LINES_EN` 逐字對齊（`skills.test.mjs` 釘死）；根目錄 `CLAUDE.md` 轉型為 `AGENTS.md`，`docsIndex.test.mjs` 改讀 `AGENTS.md`。

**AC-9　全套自動化測試（含 Antigravity 真實 hook 契約）全綠且零外洩** ✅ 對過 2026-11-20
> **白話**：不只原本的防說謊測試全部過關，還要把 Antigravity 新的感測器、對話速記本、子 agent、開場提醒、收工門禁、雙路徑設定全部真的跑過一遍測試，確認沒有漏記、沒有誤擋、沒有死迴圈，也沒有偷偷動到這台電腦上真的紀錄。
> **會發生的情況**：在本機跑 `npm test` 與乾淨副本 `npm run test:clean` 全數通過；所有 `.sh` 腳本都通過語法檢查；跑完測試檢查 `~/.pipeline-monitor-agy/` 與原版 `~/.pipeline-monitor/` 兩邊都沒有多出任何測試殘留檔或被搬動。
> **技術**：更新全套既有測試並補齊 Antigravity 契約測試（`PostToolUse` 新舊工具名、`read_file` 不誤計改檔、同回合 `typed`＋`SKILL.md` 合併、`transcript.jsonl` 解析與 subagent 歸屬、`SessionStart` JSON 注入、`Stop` `decision:"continue"` 與 `executionNum > 0` 防迴圈、`fullyIdle`/`USER_CANCELED` 放行、`.agents/` 優先與 `.claude/` fallback、`rules/AGENTS.md` 上限檢查、`skills.test.mjs` 同步對字）；`shellSyntax.test.mjs` 改掃根目錄 `hooks.json`；`privacy.test.mjs` 補守 `.agents/pipeline-monitor.off` 與 `.agents/hooks.json.bak-*`；`scripts/_realdata.mjs` 與 `scripts/run-tests.mjs` 同時守護 `~/.pipeline-monitor-agy` 與 `~/.pipeline-monitor`。版本號線：歷史 `docs/升級摘要/` 歸檔標記為分叉前紀錄，本 repo `package.json` 與 `plugin.json` 自 Antigravity 專用版 `0.1.0` 起算（待 Oscar 確認，亦見施作前確認點）。

## 混沌推導

▸ **併發**：主對話同時派多個 `research`/`browser` subagent，或多個工作區同時觸發 `PostToolUse` → 單行維持 `< 4096 bytes` 保障 O_APPEND 原子性；subagent 以 step 0 `sender=` 識別，不汙染主對話清單與收工門禁；90 天清理沿用三步換檔補撈機制不掉行。
▸ **時間**：使用者送出「不用再跑了」後 AI 立刻在同回合第一步跑 `run_command("agy-pipeline --decide ...")`（此時該 `run_command` 的 `PostToolUse` 尚未觸發）→ 讀取端直接讀 `transcript.jsonl` 裡已寫入的 `USER_EXPLICIT`/`USER_INPUT` 與精準 `created_at`，立刻對得上；儀表板 5 秒輪詢按 `(mtimeMs, size)` 快取 transcript 解析，避免長對話拖慢刷新。
▸ **容量**：長對話的 `transcript.jsonl` 達數 MB 或 `CommandLine` 含長輸出參數 → `hook.sh` 熱路徑絕不讀 `transcript.jsonl`、只記路徑並以位元組截短 `CommandLine`（200 bytes）；讀取端只掃 `USER_INPUT` 與第 0 行並快取；超長 `--report` 說明沿用另存 `logs/reports/`。
▸ **權限憑證**：`~/.gemini/config` 受系統沙盒保護 → `--install` 若遇 `EACCES`/`EPERM` 誠實回報並給終端機指令，不假裝成功；`CommandLine` 若含 `https://user:pass@host` 類內嵌憑證於 `hook.sh` 寫入前濾除；`server.mjs` 照舊只綁 `127.0.0.1` 並檢核 `Host`/`Origin`/`CSP`。
▸ **輸入畸形**：Antigravity 未來改名工具欄位、送空 `cwd`、缺 `transcriptPath`、壞 JSON、`transcript.jsonl` 被刪或含截斷壞行 → `hook.sh` 與 `remind.sh` 永遠輸出 `{}` 並 `exit 0`；`gate.mjs` 一律放行並記 `gate_broken`；`lib/transcript.mjs` 跳過壞行、讀不到檔時照實退回感測器 `prompt` 欄位不報錯不編造（R1）。
▸ **網路**：`server.mjs` 與背景服務全程純本機，不依賴外網；`agy-pipeline --wrap push` 若離線或遠端拒絕，維持現有誠實回報「沒成」並停手。

## 明確不做

- **v0.2 主動式工作站功能一律不做**（留待 v0.1 確認可用後另開規格）：
  - 不做分級自動伸縮
  - 不做 A/D 單輪預審機制
  - 不做 C/D 並行異質模型調度
  - 不做 `ask_question` 一鍵決策卡解析與取代文字回覆（v0.1 僅於 `PostToolUse` 留輕量工具事件麵包屑，人話採認仍以文字輸入為準）
  - 不做 Sidecar／`agentapi` 與雙向即時控制
  - 不做 `PreToolUse` 危險清單即時 `force_ask` 攔截（v0.1 零 `PreToolUse` hook）
- **不沿用 Claude Desktop App 專有整合**：不接 `mcp__ccd_session__*` 建議卡工具、不讀 `~/Library/Application Support/Claude` 與 `~/.claude/projects/`、不保留 `.claude/settings.local.json` 舊掛法。
- **不偷讀未驗證的 Antigravity 內部資料庫**：不為了拿對話標題或刪除狀態去猜測未實測的內部檔案（R1）。
- **不破壞既有誠實原則與零相依**：不加任何 npm 相依、不做「執行中」亮燈、不做百分比進度條、不把「跑過」講成「通過」（R2）。
- **不碰 `角色/` 資料夾與原版 `~/.pipeline-monitor/` 資料**；克隆體中未進版控的 `.claude/worktrees/` 舊工作區副本不在未確認前擅自刪除。

## 施作紀錄

- 2026-11-20（開工＋v0.1 地基完成，待 Oscar 本機終端機安裝實測後結案搬至 `docs/升級摘要/`）：
  - **獨立門牌與隔離**：指令 `agy-pipeline`、儀表板 `127.0.0.1:4320`（`com.pipeline-monitor-agy.dashboard`）、資料家 `~/.pipeline-monitor-agy/`（權限 `0700`）、Plugin 位置 `~/.gemini/config/plugins/agy-pipeline`；移除原克隆殘留 `.claude-plugin/`、`hooks/hooks.json`、`.claude/`、`CLAUDE.md`、`lib/appSessions.mjs`，保留 `角色/` 不動，且原版 `~/Desktop/pipeline-monitor` 與 `~/.pipeline-monitor/` 完全未動。
  - **設定雙路徑**：專案設定優先讀 `.agents/pipeline-stages.json`、相容 fallback 讀 `.claude/pipeline-stages.json`；`--tier-checked` 寫回原檔，新建寫 `.agents/`；退出記號 `.agents/pipeline-monitor.off` 與 `.claude/pipeline-monitor.off` 皆認。
  - **Antigravity 原生感測器＋轉錄檔＋門禁**：
    - `hook.sh`（`/bin/sh` + `jq`）全掛 `PostToolUse`，支援新舊工具名、遮蔽 `run_command` URL 帳密與 Bearer/API_KEY 憑證、只為技能檔的 `read_file`/`view_file` 留紀錄，一律輸出 `{}` 並 `exit 0`。
    - 新增 `lib/transcript.mjs` 解析 `transcript.jsonl`（`USER_EXPLICIT`/`USER_INPUT`、mtime+size 快取、step 0 `SYSTEM_MESSAGE` `sender=` subagent 識別與瀏覽器動作歸屬主對話）；`lib/rounds.mjs` 統一 `isEditEvent`/`isWriteEvent` 與同回合 `typed`＋`SKILL.md` 合併。
    - `remind.sh` 實作 `SessionStart` `injectSteps` JSON 注入；`gate.sh`＋`gate.mjs` 實作 `Stop` `decision:"continue"` 與 `executionNum > 0` 防迴圈、以及 `fullyIdle`/`USER_CANCELED`/`error`/subagent 放行。
  - **常駐規則與 6 支技能**：新增 `rules/AGENTS.md`（低於上限）、根目錄 `AGENTS.md`、重寫 `skills/{spec,cleanup,chaos-check,verify,tier-setup,director}/SKILL.md`，用語表與 `lib/lang.mjs` `TERMS`／`RED_LINES_EN` 逐字對齊。
  - **自檢修補（魔鬼教官自查）**：發現並修補 `lib/origin.mjs`（`takeoverOf`／`tenureEvents`／`previousTenant`）與 `lib/rounds.mjs`（`originHeads`）在切分支後未忽略 `_subagent` 可能誤判換人的問題，補齊回歸測試；並修正 `stages.json`、`hooks.json`、`lib/transcript.mjs` 瀏覽器工具名比對相容大小寫 `[Bb]rowser`。
  - **本機安裝與實機驗證（2026-11-20）**：
    - 已連結 `~/.local/bin/agy-pipeline -> status.mjs`（`/usr/local/lib/node_modules` 需 root 權限，改用已在 `PATH` 的 `~/.local/bin` 免 sudo），執行 `agy-pipeline --install`（建 `~/.gemini/config/plugins/agy-pipeline`）與 `agy-pipeline --serve-install`（裝 `com.pipeline-monitor-agy.dashboard`，`http://127.0.0.1:4320/` 回應）。
    - **實機抓到並修補 3 個真實環境細節（補回歸測試於 `scripts/sensor.test.mjs`）**：
      1. Antigravity 真實轉錄檔以 `<USER_REQUEST>...</USER_REQUEST>`＋`<ADDITIONAL_METADATA>` 包裹 `USER_INPUT` → `lib/transcript.mjs` 補 `unwrapUserRequest()`，並於 `guessTranscriptPath` 兼查 `transcript_full.jsonl`。
      2. Antigravity 內建 `browser` subagent 真實工具名為 `webview_browser` → 補入 `hooks.json`、`hook.sh`（從 `script`/`intention` 抽去帳密的 `url_host`）、`stages.json`、`lib/transcript.mjs`；重啟後實機驗證主對話 `E 驗收` 已即時看到 `browser` subagent 歸屬回來的「開過瀏覽器」紀錄，且未多長假對話卡。
      3. 在 Antigravity 預設沙盒內呼叫 `agy-pipeline` / `--serve-install` 遇 `EPERM` 不再漏出 Node stack trace，也不把 `EPERM` 誤講成「語言設定讀不懂」（修 `lib/lang.mjs`、`lib/service.mjs`、`status.mjs`）。
    - **已實機確認**：`PostToolUse` 感測器寫入、`Stop` 收工門禁觸發並正確放行 subagent 與實機攔阻主對話缺項、`http://127.0.0.1:4320/` 看板總覽／專案頁／對話頁／中英切換正常；**尚未實機確認**：全新人類對話的 `SessionStart` 提醒（須開新對話實測），以及 commit 後的 `npm run test:clean`。
  - **第一輪 C 打掃＋D 魔鬼教官（2 獨立 agent）修補與安全整理（2026-11-20）**：
    - 移除原版 `git remote origin`，防誤推原 repo。
    - 依 Oscar 決定更新 `.agents/pipeline-stages.json` 危險清單（加入 `lib/transcript.mjs` 與 `plugin.json`，`rules/AGENTS.md` 留程式區）並記 `--tier-checked`。
    - 一次修補魔鬼教官第一輪全部 7 條發現＋`remind.sh` 停止規則對齊，並補齊回歸測試：
      1. `lib/rounds.mjs` `coalesceRuns` 合併同回合 `typed`＋`SKILL.md` 時承接 `cur.head`（P6/R1）。
      2. `lib/rounds.mjs` `firstEventAt` 與 `roundView` 在起點為無 `head` 的轉錄檔 `UserPrompt` 時承接最早感測器 `head`（P1/P6）。
      3. `lib/rounds.mjs` `noRecordsWithin` 與 `lastRunPerStage` 排除 `_fromTranscript`／`_fromFallback`（R1/P5/P2）。
      4. `hook.sh`、`remind.sh`、`gate.mjs:291` 修補空字串 `cwd: ""` 退回 `workspacePaths[0]`（P2/R1）。
      5. `lib/transcript.mjs` 依時間軸 `cwdTimeline` 配對每則轉錄檔人話的當下 `cwd`，對話中途換 worktree 不拉回舊資料夾（P6/R1）。
      6. `lib/faults.mjs` `roundStartFor` 改用 `Date.parse(first) <= Date.parse(since)`（P3/P9）。
      7. `lib/lang.mjs` 新增 `langUnreadableLine()` 並接入 `status.mjs` 與 `server.mjs`（含快取 key，R1/P2）。
      8. `remind.sh` 改為命中第一份設定檔即停，與 `readProjectConfig` 一致（P2）。
  - **魔鬼教官第 2 輪（2026-11-20）**：只檢視第一輪後修改的 15 個檔案，未對到任何已知死法，已記結論；`npm test` 26/26 全綠；乾淨副本 `npm run test:clean`（`a90a919`，空家目錄＋UTC＋清環境變數＋不讀系統 git 設定）26/26 全綠；`http://127.0.0.1:4320/` 已重啟至最新程式。
  - **上線版本：v0.1.0**
  - **接下來**：開新規格進入 v0.2 主動式工作站（分級自動伸縮、A/D 單輪預審、C/D 並行異質模型、`ask_question` 一鍵決策卡、Sidecar／`agentapi`、危險清單即時 `force_ask`）。
