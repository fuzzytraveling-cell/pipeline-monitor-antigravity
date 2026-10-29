/**
 * cliView.mjs —— 終端機不帶旗標那份畫面的上半:標題、故障橫條、感測器與收工 hook 那兩行、還原點與改動體檢。
 * 規格:pipeline-status、誠實修補、終端機照指令拆開(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-07 從 status.mjs 原封不動搬過來。五關那一段在 cliStages.mjs、分級卡在 cliTier.mjs,三段由 status.mjs 的 main() 依序叫。
 * 只從 cliFacts.mjs 拿東西(cli 之間只准單向,cliFacts 在最底層)。
 */
import { changeScale, ago, backupBranchName } from './git.mjs';
import { RETAIN_DAYS } from './events.mjs';
import { faultBanner, sensorNow, unreadableLine, gateHeartbeat, sensorOffLine, noneHereLine, sensorParts, gateLine } from './faults.mjs';
import { changeScope, NO_STAMP_YET, GREEN_IS_NOT_CORRECT, stampBrokenReason, scaleLine, unsavedLine, UNSAVED_UNKNOWN,
         loseUnsavedLine, UNSAVED_WHETHER } from './scope.mjs';
import { mountState, mountFix } from './mount.mjs';
import { LOG_DIR } from './cliFacts.mjs';

/** 怎麼回去(AC-3):先講會失去什麼、想留著先打什麼,**指令一定放最後**。 */
function restoreAdvice({ commit, commitsAfter = 0, dirty = 0, now = new Date() }) {
  const L = [''];
  let warned = false;
  if (commitsAfter > 0) {
    // ⚠️ L14:reset 會把章之後的存檔從分支上拿掉。git 其實還留著,但要工程師才救得回來——
    //    對這個工具的使用者來說等於沒了。所以先留一條備份分支,跟 stash 那步同一個節奏。
    L.push(`   ⚠️ 回去會丟掉蓋章之後的 ${commitsAfter} 次存檔(commit)。想留著先打：`);
    L.push(`        git branch ${backupBranchName(now)}`);
    warned = true;
  }
  // 「問不到」「會丟掉幾個」跟儀表板還原點那一行同一句(lib/scope.mjs;規格:先講commit再講蓋章 AC-9)。「先打什麼」是終端機自己的
  if (dirty === null) {
    // R1:問不到 ≠ 沒有。不知道有沒有沒存的東西,就當成有。
    L.push(`   ⚠️ ${UNSAVED_WHETHER}。保險起見先打：`);
    L.push('        git stash push -u -m 我的備份');
    warned = true;
  } else if (dirty > 0) {
    L.push(`   ⚠️ ${loseUnsavedLine(dirty, warned)}。想留著先打：`);
    L.push('        git stash push -u -m 我的備份');
    warned = true;
  }
  L.push(warned ? '      確定要回去：' : '      要回到那個版本：');
  L.push(`        git reset --hard ${commit.slice(0, 7)}`);
  return L;
}

/**
 * 還原點那一段的文案(AC-2／AC-3／AC-4／AC-5／L14)。純函式,一行一個字串——
 * 因為這是整支程式**唯一會給出破壞性指令**的地方,所以抽出來讓 scripts/status.test.mjs 釘住:
 * 章不能用的時候,輸出裡不准出現 `reset --hard`。
 * @param files 蓋章之後改了幾個檔案;null = 問不到
 */
function describeCheckpoint({ cp, rel, dirty, files, now = new Date() }) {
  const L = [];
  const short = cp.commit.slice(0, 7);

  if (rel.state !== 'ok') {
    L.push(`⚠️ 有一個還原點（${short}，${ago(cp.at)}，${cp.checks.join(' / ')} 全綠），但它已經失效：`);
    // 原因跟儀表板同一句(lib/scope.mjs);「所以不給指令」這半句是終端機自己的(網頁另有一句)
    L.push(`   ${stampBrokenReason(rel)}${rel.state === 'gone' || rel.state === 'off-branch' ? '' : '為了不亂給指令，這次不給。'}`);
    if (rel.state === 'off-branch') L.push('   照它回去會跳到另一條歷史，所以這次不給回去的指令。');
    L.push('', '   重新蓋一個：  pipeline-status --checkpoint');
    if (dirty === null) L.push('', '   ⚠️ 另外:問不到你有幾個檔案還沒存進保險箱（commit）。');
    else if (dirty) L.push('', `   ⚠️ 另外:你有 ${dirty} 個檔案還沒存進保險箱（commit）。`);
    return L;
  }

  // AC-5：永遠寫「檢查全綠」,永遠不寫「確定能動」
  L.push(`🟢 最後一次檢查全綠：${short}（${ago(cp.at)}）`);
  L.push(`   通過的是：${cp.checks.join(' / ')}`);
  L.push(`   ${GREEN_IS_NOT_CORRECT}`);   // 跟儀表板同一句(lib/scope.mjs)

  if (files === null) L.push('', '   ⚠️ 問不到「蓋章之後改了什麼」。');
  else if (files > 0) {
    L.push('', `   ⚠️ 之後有 ${files} 個檔案被改過,這 ${files} 個沒有被檢查過。`);
    if (rel.commitsAfter) L.push(`   其中包含蓋章之後的 ${rel.commitsAfter} 次存檔(commit)。`);
  }
  else if (rel.commitsAfter) L.push('', `   ⚠️ 蓋章之後存了 ${rel.commitsAfter} 次,但現在的檔案內容跟章一模一樣。`);
  // 只講證明得出來的:差 0 不代表沒動過(改了又改回去、git stash 都是 0;魔鬼教官 2026-09-22 第二輪)
  else L.push('', '   ✅ 現在的檔案跟蓋章時一模一樣。');

  if (dirty === null) L.push(`   ⚠️ ${UNSAVED_UNKNOWN}`);
  else if (dirty) L.push(`   ⚠️ ${unsavedLine(dirty)}。`);

  if (files || rel.commitsAfter) {
    L.push(...restoreAdvice({ commit: cp.commit, commitsAfter: rel.commitsAfter, dirty, now }));
  }
  return L;
}

/**
 * 感測器那一行(誠實修補 D)。純函式,兩件事**分開講**:
 *   「掛在哪」看設定檔(mountState),「活著嗎」看紀錄(lastSeen = 最後一筆來自這個工作區的事件)。
 * ⚠️ 設定裡找不到、紀錄裡卻有——那就是在記(2026-09-11 這個 worktree 就是這樣)。
 *    證據在手上的時候,不准說「沒掛上」(R1)。證據跟設定打架時,證據贏。
 * @param lastSeen ISO 時間,或 null(只算感測器自己寫的紀錄——--report、按鈕寫的不算,見 renderSensor)
 * @param now      這台電腦的感測器現在怎樣(lib/faults.mjs 的 sensorNow):'broken' 時「掛上之後要開新的對話才會開始記」不是真的,
 *                 照做永遠等不到(規格:agent回報與故障記號 AC-3);'flaky' 時那句照舊,另外講時好時壞(魔鬼教官第一輪)
 * @param hasLog   這個專案有沒有紀錄檔(readEvents 不是 no-file)。有的話就是記過——這裡沒有紀錄可能是超過保留期限清掉了,
 *                 只講得出「N 天內沒有」,不准講「還沒有」;不知道就照「N 天內沒有」講(lib/faults.mjs 的 noneHereLine;規格:90天清空之後的說法 AC-4)
 */
function describeSensor({ mount, lastSeen, now = null, hasLog }) {
  const L = [];
  // 掛在哪、最後一筆、掛壞了、沒掛上那幾句:跟儀表板同一句(lib/faults.mjs 的 sensorParts;規格:終端機與網頁說同一句)
  const q = sensorParts({ mount, lastSeen, ago });
  const seen = q.seen;
  if (mount.state === 'off' && mount.optedOut) {
    // 人自己按的退出。照實說「退出了」,不說「沒掛上」——那是兩件事
    L.push(sensorOffLine({ mount, lastSeen, now, here: '上面那一行', days: RETAIN_DAYS }));
    if (seen) L.push(`         ${seen}`);
    L.push('         重新加入：pipeline-status --on,或儀表板的「重新加入記錄」按鈕');
  } else if (mount.state === 'broken') {
    // ⚠️ 這一種最危險:設定看起來好好的,但它指向的檔案不見了,而 hook 永遠靜默,紀錄只是安靜地停止增加。
    L.push(q.broken.replace(q.em, `**${q.em}**`));
    for (const p of mount.paths) L.push(`         找不到：${p}`);
    if (q.stopped) L.push(`         ${q.stopped}`);
    // 修法跟儀表板、--on 同一句(lib/mount.mjs;規格:agent回報與故障記號 AC-6)
    L.push(`         ${mountFix(mount)}`);
  } else if (mount.state === 'ok') {
    L.push(q.mounted);
    // 「還沒有」還是「N 天內沒有」:跟儀表板同一句(lib/faults.mjs);後面的說明只有終端機有
    const none = noneHereLine({ hasLog, days: RETAIN_DAYS });
    L.push(`         ${seen ?? (now === 'broken' ? `${none}——這台電腦的感測器現在記不到東西（原因與修法見上面那一行），開新的對話也不會開始記`
      : `${none}（設定是對話開始時讀的,掛上之後要開新的對話才會開始記${now === 'flaky' ? '；這台電腦的感測器時好時壞，開了也不一定記得到，見上面那一行' : ''}）`)}`);
    if (mount.alsoLegacy) L.push('         ⚠️ 這個專案的設定檔裡還有舊的接法,會記兩次。拆掉：pipeline-status --on');
  } else if (seen) {
    // 設定裡找不到、紀錄卻有 → 它在記(感測器現在記不到的話只到最後那一筆為止,R1)。跟儀表板同一句(lib/faults.mjs)
    L.push(sensorOffLine({ mount, lastSeen, now, here: '上面那一行', days: RETAIN_DAYS }));
  } else {
    L.push(q.notMounted);
  }
  L.push('');
  return L;
}

/* ══════════════════════════ 畫面 ══════════════════════════ */

/** 收工 hook 活著沒:看心跳檔,不看設定(L13:「掛著」不等於「活著」)。 */
function describeGate(logDir = LOG_DIR) {
  return gateLine(gateHeartbeat(logDir), { ago });   // 跟儀表板同一句(lib/faults.mjs)
}

/**
 * 標題＋故障橫條＋感測器那一行。零 commit 的路徑跟正常路徑都要它——以前抄了兩份,各自過期(老毛病 P2)。
 * 故障橫條跟儀表板每一頁上方那條同一句(lib/faults.mjs;規格:agent回報與故障記號 AC-3):還在壞的才印。
 */
function renderSensor(ctx, ev, faults) {
  console.log(`━━ ${ctx.project} · ${ctx.branch} ━━`);
  for (const b of faultBanner(faults)) console.log(b.text);
  const odd = unreadableLine(faults);
  if (odd) console.log(odd);
  // 「最後一筆來自這裡的紀錄」只算感測器自己寫的(有 hook 欄位):--report、按鈕寫的紀錄,感測器壞了照樣寫得進去(AC-5)
  const mine = ev.events.filter((e) => e.cwd === ctx.root && e.hook).map((e) => e.ts).filter(Boolean).sort();
  const lines = describeSensor({ mount: mountState(ctx.root, ctx.mainRoot), lastSeen: mine.at(-1) ?? null, now: sensorNow(faults), hasLog: ev.state !== 'no-file' });
  for (const line of lines) console.log(line);
  console.log(`         ${describeGate()}`);
}

function render(ctx, ev, info) {
  renderSensor(ctx, ev, info.faults);
  const { cp, dirty, rel, cpUsable, h, base } = info;

  /* ── 還原點（AC-2 / AC-3 / AC-4 / AC-5 / L14） ── */
  if (!cp) {
    // AC-4：說「還不知道」,不說「你沒有能動的版本」
    console.log('🔍 還沒有還原點——這個工具還沒看過你跑檢查,所以**還不知道**哪個版本是綠的。');
    console.log(`   （${NO_STAMP_YET}）`);   // 跟儀表板同一句(lib/scope.mjs)
    console.log('\n   建立第一個：  pipeline-status --checkpoint');
    // AC-5 的「還沒進保險箱」跟有沒有章無關——沒章的時候一樣該講。
    if (dirty === null) console.log('\n   ⚠️ 另外:問不到你有幾個檔案還沒存進保險箱（commit）。');
    else if (dirty) console.log(`\n   ⚠️ 另外:你有 ${dirty} 個檔案還沒存進保險箱（commit）。`);
  } else {
    // 文案在 describeCheckpoint():純函式,被測試釘住「章不能用時不准出現 reset --hard」
    for (const line of describeCheckpoint({ cp, rel, dirty, files: h.files })) console.log(line);
  }

  /* ── 改動體檢（AC-7 / AC-8）：只報數字,不下判斷 ── */
  const scale = changeScale(ctx.root);
  // 從哪裡算起(規格:這一輪的起點 AC-5):文案住在 lib/scope.mjs,網頁與收工 hook 講同一句
  const scope = changeScope(base, ago);
  console.log(`\n━━ ${scope.title} ━━`);
  if (scope.note) console.log(`   （${scope.note}。）`);
  if (cp && !cpUsable) console.log('   （章失效了,所以這裡不是從章算。）');
  if (h.files === null) {
    console.log('   問不到改動。');                // R1:沒問到 ≠ 沒有改動
  } else if (!h.files) {
    // 只看得到還沒存檔的、或這一輪中間 HEAD 動過的時候,0 不是「沒有改動」(老毛病 P5)
    console.log(`   ${scope.emptyBlind ? scope.empty : '沒有改動。'}`);
  } else {
    console.log(`   ${h.files} 個檔案${h.newFiles ? `(其中 ${h.newFiles} 個是新檔案)` : ''}`);
    // 新檔案還沒被 git 追蹤,算不出增減行數。照實說涵蓋範圍,不要給一個看起來完整的假總數。
    if (h.added === null) console.log('   已存在的檔案:行數問不到');
    else console.log(`   已存在的檔案:+${h.added} −${h.removed} 行`);
    // ⚠️ AC-7：比例尺來自這個專案自己的歷史。沒有「太多」這種話。
    //    比例尺是「一次存檔」的;這裡是好幾次存檔加起來的時候要講,不然 22 個配「最多到過 20 個」讀起來像有史以來最大的一次(L6,魔鬼教官 2026-09-22)
    if (scale) console.log(`   （${scaleLine(scale, scope.commitsNote)}）`);   // 跟儀表板同一句(lib/scope.mjs)
    if (h.newDeps.length) {
      console.log(`   ⚠️ 新增相依 ${h.newDeps.length} 個：${h.newDeps.join(', ')}`);
      console.log('      （每一個都是以後都要跟著你的東西,裝的時候只花三秒。）');
    }
    if (h.modifiedTests.length) {
      console.log(`   ⚠️ 這次動到 ${h.modifiedTests.length} 個**既有**的測試檔：`);
      for (const f of h.modifiedTests.slice(0, 5)) console.log(`        ${f}`);
      console.log('      （新增測試不會列在這裡。既有測試被改,值得你確認一下是不是');
      console.log('        程式沒過測試、於是測試被改成配合程式。）');
    }
  }
  return 0;
}

// 給 status.mjs 拿;describeCheckpoint、describeSensor 也給測試釘文案用。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  describeCheckpoint, describeSensor, renderSensor, render,
};
