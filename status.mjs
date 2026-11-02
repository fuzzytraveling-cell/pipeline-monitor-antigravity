#!/usr/bin/env node
/**
 * status.mjs —— 「我在哪、我回得去哪、這次動了多少」
 *
 * 規格：pipeline-status（路徑看 CLAUDE.md 的表；AC 編號標在 lib/cli*.mjs 各段落）
 *
 * 這支程式最重要的性質是**它不准說謊**。所以整份程式碼裡沒有任何一句
 * 「確定能動」「應該沒問題」「太多了」——只有數字、時間戳，以及查不到時的「不知道」。
 *
 * ⚠️ 三個最容易犯的錯，都寫成註解釘在對應的地方了：
 *   1. 查不到 ≠ 沒有（A1）——`git()`（lib/git.mjs）回 null 代表「沒問到」，呼叫端不准折成 false
 *   2. 檢查全綠 ≠ 功能正確（A2, AC-5）——文案永遠寫「檢查全綠」不寫「能動」
 *   3. 自己編門檻會讓工具變成狼來了（AC-7）——比例尺一律從這個專案自己的歷史算
 *
 * 這支只做分派：哪個旗標交給誰（規格：終端機照指令拆開）。每個指令住 lib/ 底下 cli 開頭的那幾支——
 *   cliView（畫面上半）、cliStages（五關那一段）、cliTier（分級卡與 --tier-*）、cliStamp（--checkpoint）、
 *   cliReport（--report／--clear／--spec／--suggest）、cliRerun（--round／--decide）、cliOnOff（--on／--off）；大家共用的事實在 cliFacts。
 *   新指令的程式放進對應的那一支（或新開一支），這裡只加轉接的那一行——以前全部擠在這一支，改一個指令要讀整支、兩個對話一起改就撞。
 * 別的檔案不准 import 這支（以前 lib/collect.mjs 回頭 import 指令，跟這支繞成一圈）；要用什麼，去它住的那一支拿。
 * 中英切換(規格:儀表板與終端機中英切換、技能與寫給AI的話中英切換):語言設定在這裡讀一次,整個指令用同一種(lib/lang.mjs 的 withLang)——
 *   句子不自己讀設定,你在一個指令跑到一半的那一刻切了,也不會半中半英。Claude 替你跑的那幾個指令(--round、--report…)也一樣照設定:
 *   以前它們照舊中文,等技能一起換(技能照那幾句分路);現在技能兩種都寫了,一起換。
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { gitContext, withClock } from './lib/git.mjs';
import { readEvents, RETAIN_DAYS } from './lib/events.mjs';
import { faultsNow } from './lib/faults.mjs';
import { installService, uninstallService, restartService, describeService, openDashboard } from './lib/service.mjs';
import { installPlugin, uninstallPlugin } from './lib/mount.mjs';
import { moveState } from './lib/paths.mjs';
import { LOG_DIR, gatherChange, stageFacts } from './lib/cliFacts.mjs';
import { renderSensor, render } from './lib/cliView.mjs';
import { renderStages } from './lib/cliStages.mjs';
import { renderTier, doTierInit, doTierOff, doTierReview, doTierChecked, doTierLater, doTierSet, doTierRetract } from './lib/cliTier.mjs';
import { doCheckpoint } from './lib/cliStamp.mjs';
import { doClear, doSpec, doReport, doSuggest } from './lib/cliReport.mjs';
import { doRound, doDecide } from './lib/cliRerun.mjs';
import { doMount } from './lib/cliOnOff.mjs';
import { doTodo } from './lib/cliTodo.mjs';
import { readLang, withLang, zhEn, langBrokenLine, doLang } from './lib/lang.mjs';

/* ══════════════════════════ main ══════════════════════════ */

async function main(L = { lang: 'zh', state: 'ok' }) {
  const argv = process.argv.slice(2);
  const at = (flag) => argv.indexOf(flag);
  // 旗標後面的自由文字(理由、資料夾),遇到下一個旗標就停
  const after = (flag) => argv.slice(at(flag) + 1).filter((a) => !a.startsWith('--'));

  // 換語言:不需要站在 git 專案裡。它自己講現在是哪一種(含讀不懂),不用再印一次下面那一句
  if (at('--lang') !== -1) return doLang(after('--lang')[0]);
  // 語言設定讀不懂:先用中文,但最上面講一句,不默默用(AC-7)
  if (L.state === 'broken') console.log(langBrokenLine());

  // 還差什麼:所有專案一起看,不需要站在 git 專案裡(規格:還差什麼總表 AC-8)
  if (at('--todo') !== -1) return doTodo();

  // 儀表板的背景服務(launchd):裝／拆／重啟／狀態,以及用瀏覽器打開。都不需要站在 git 專案裡
  const serveFlag = ['--serve-install', '--serve-uninstall', '--serve-restart', '--serve-status'].find((f) => at(f) !== -1);
  if (serveFlag) {
    const r = serveFlag === '--serve-install' ? await installService()
      : serveFlag === '--serve-uninstall' ? uninstallService()
      : serveFlag === '--serve-restart' ? await restartService()
      : await describeService();
    for (const line of r.out) console.log(line);
    return r.ok ? 0 : 1;
  }
  if (at('--open') !== -1) {
    const r = await openDashboard();
    for (const line of r.out) console.log(line);
    return r.ok ? 0 : 1;
  }
  // plugin 的裝／拆不需要站在 git 專案裡
  if (at('--install') !== -1 || at('--uninstall') !== -1) {
    const r = at('--install') !== -1 ? installPlugin() : uninstallPlugin();
    for (const line of r.out) console.log(line);
    return r.ok ? 0 : 1;
  }
  const cwd = process.cwd();
  const ctx = gitContext(cwd);
  if (!ctx.isGit) {                             // AC-10
    console.log(zhEn('這裡看起來不是一個 git 專案,所以沒有版本可以參照。', 'This doesn\'t look like a git project, so there are no versions to refer to.'));
    console.log(zhEn(`（目前位置：${cwd}）`, `(current location: ${cwd})`));
    return 0;
  }
  if (at('--on') !== -1 || at('--off') !== -1) return doMount(ctx, at('--on') !== -1);
  // 分級的設定不需要有 commit
  if (at('--tier-init') !== -1) return doTierInit(ctx, after('--tier-init'));
  if (at('--tier-off') !== -1) return doTierOff(ctx, after('--tier-off').join(' '));
  if (at('--tier-review') !== -1) return doTierReview(ctx);
  if (at('--tier-checked') !== -1) return doTierChecked(ctx, after('--tier-checked').join(' '));

  // 紀錄只讀一次:感測器那行(活著嗎)、五關那段(跑過什麼)、分級(人調的)共用同一份
  const ev = readEvents(LOG_DIR, ctx.project);
  // 這台電腦的故障(全機一份,儀表板同一個函式):最上面那一行、感測器那一行、五關那段共用。
  // 搬家還沒搬完也算在這裡,跟故障同一個位置講(規格:紀錄搬到固定的家 AC-5)
  const faults = faultsNow(LOG_DIR, { retainDays: RETAIN_DAYS, move: moveState() });
  if (!ctx.hasCommits && at('--checkpoint') === -1) {
    renderSensor(ctx, ev, faults);
    console.log(zhEn('這個專案還沒有任何 commit,所以還沒有版本可以回去。', 'This project has no commits yet, so there\'s no version to go back to.'));
    return 0;
  }

  if (at('--clear') !== -1) return doClear(ctx, after('--clear'));
  if (at('--spec') !== -1) return doSpec(ctx, ev, after('--spec'));
  if (at('--report') !== -1) { const [id, verdict, ...note] = after('--report'); return doReport(ctx, id, verdict, note.join(' ')); }
  if (at('--decide') !== -1) return doDecide(ctx, ev, after('--decide'));
  if (at('--tier-later') !== -1) return doTierLater(ctx, ev, after('--tier-later').join(' '));
  if (at('--round') !== -1) return doRound(ctx, ev, argv[at('--round') + 1]);
  if (at('--suggest') !== -1) {
    let stdin = '';
    try { stdin = readFileSync(0, 'utf8'); } catch { stdin = ''; }
    return doSuggest(ctx, after('--suggest').join(' '), stdin);
  }
  if (at('--checkpoint') !== -1) return doCheckpoint(ctx);

  // 事實各算一次,三段畫面共用。「這次改動」從五關那一輪的起點算,所以跟五關一起算完才放回 info
  const info = gatherChange(ctx, ev);
  const facts = stageFacts(ctx, ev, info);
  info.h = facts.health; info.base = facts.base;
  if (at('--tier-retract') !== -1) return doTierRetract(ctx, ev, info, facts);
  if (at('--tier') !== -1) {
    const [id, ...why] = after('--tier');
    return doTierSet(ctx, ev, info, facts, id, why.join(' '));
  }

  info.faults = faults;
  render(ctx, ev, info);
  renderStages(ctx, ev, facts, info);
  renderTier(ctx, ev, info, facts);
  return 0;
}

// ⚠️ 不要寫成 `import.meta.url === \`file://${process.argv[1]}\``——
// import.meta.url 是百分號編碼的（路徑裡的空白會變 %20）,而 argv[1] 不是。
// 使用者的路徑只要有一個空白,這個判斷就永遠 false,而程式**安靜地什麼都不做**。
// 實測就是這樣:「TutorPod AI」有空白,第一次執行零輸出零錯誤。
// 這正是本專案 R1 在講的形狀——沒壞掉的樣子,但什麼都沒發生。
// ⚠️ 第二次(2026-09-11,誠實修補 E1):透過捷徑(symlink、npm link、npx)執行時,argv[1] 是捷徑的路徑,
// import.meta.url 是真實路徑——同一個形狀,換了一個原因。所以兩邊都解析成真實路徑再比(老毛病 P3)。
function isMain() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? ''); }
  catch { return false; }
}
// 一次輸出只取一次「現在」:五關那一行跟分級卡那一行講同一個事件,秒數才不會一邊 7 一邊 8(lib/git.mjs 的 withClock)
// 語言也只讀一次(withLang)
if (isMain()) {
  const L = readLang();
  withLang(L.lang, () => withClock(() => main(L))).then((code) => process.exit(code));
}
