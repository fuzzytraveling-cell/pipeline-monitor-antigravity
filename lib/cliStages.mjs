/**
 * cliStages.mjs —— 終端機畫面的五關那一段與規格清單(不帶旗標時印)。
 * 規格:五關自動結案、施工對話認規格、多份規格與新資料夾的起點、終端機照指令拆開(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-07 從 status.mjs 原封不動搬過來。每一格那一句、清單的那幾句、寫規格那一關的旁白住 lib/stageLines.mjs——
 * 伺服器算好帶給網頁的是同一份(規格:終端機與網頁說同一句);這裡只管燈號、縮排、哪幾行印在哪。
 * 不拿任何一支 cli*.mjs。
 * 中英兩種並排(規格:儀表板與終端機中英切換):這一段的字照這一次輸出的語言(status.mjs 讀一次設定、用 withLang 包起來)。
 */
import { ago } from './git.mjs';
import { zhEn, plural } from './lang.mjs';
import { RETAIN_DAYS } from './events.mjs';
import { sessionsOf, unknownPromptsOf, unknownPromptLine, stagesBrokenLine, noRecordsWithin, noRecordLine } from './rounds.mjs';
import { faultNotes, sensorNow, roundStartFor } from './faults.mjs';
import { eLines } from './verify.mjs';
import { skillAvailable } from './skills.mjs';
import { stageLine, specNotes, checklistWhy, checklistHead, checklistPartLine, calledIsNotPassed } from './stageLines.mjs';
import { mountState, mountFix, optOutState } from './mount.mjs';

/* ══════════════════════════ 關卡（需要感測器） ══════════════════════════ */

/** 每一格前面的燈號(終端機才有;網頁用顏色)。✓ 與 ● 後面多一格,跟以前對齊 */
const ICON = { main: '● ', notbuilt: '⚫', none: '⚪', passed: '✓ ', stale: '🔁', held: '⏸', seen: '👁', current: '⏸', done: '✅' };

function renderStages(ctx, ev, facts, info = {}) {
  const { stages, perStage, cleared, sawAnyEventHere } = facts;
  if (!stages.length) return;

  const { state, events } = ev;
  const faults = info.faults ?? null;
  console.log(zhEn('\n━━ 五關 ━━', '\n━━ Five stages ━━'));
  // 專案自己寫的關卡讀不懂:退回內建的五關,但要講(跟儀表板同一句,lib/rounds.mjs)
  if (facts.stagesBroken) console.log(`   ${stagesBrokenLine(facts.stagesBroken)}`);

  // ⚠️ AC-1／AC-7:三種「看起來一樣」的情況必須分開講。
  // 感測器在這台電腦上記不到東西(故障記號,最上面那一行)的時候,「分不出來」不是真的——分得出來:是壞了
  // (規格:agent回報與故障記號 AC-3)。只有收工 hook 的故障、或感測器已經好了的,照舊講分不出來
  // 時好時壞(flaky)時「現在記不到」不是真的(最後一筆故障之後又記到了):「分不出來」照舊,另外講時好時壞(魔鬼教官第一輪)
  const now = sensorNow(faults);
  const shaky = now === 'flaky' ? zhEn('      這台電腦的感測器時好時壞（見最上面那一行），也可能是這個原因。', '      This computer\'s sensor works on and off (see the line at the very top); that might be why too.') : null;
  const noClaim = zhEn('      所以不會說「五關都沒跑」。', '      so I won\'t say "none of the stages ran".');
  if (state === 'no-file') {
    if (now === 'broken') {
      console.log(zhEn('   🔍 這個專案還沒有任何感測器紀錄——這台電腦的感測器現在記不到東西（見最上面那一行）,',
        '   🔍 This project has no sensor records yet — this computer\'s sensor can\'t record anything right now (see the line at the very top),'));
      console.log(noClaim);
      return;
    }
    console.log(zhEn('   🔍 這個專案還沒有任何感測器紀錄。', '   🔍 This project has no sensor records yet.'));
    console.log(zhEn('      可能是還沒裝感測器,也可能是裝了還沒跑過任何指令——**這兩種我分不出來**,',
      '      Maybe the sensor isn\'t installed yet, or it is but no command has run yet — **I can\'t tell these two apart**,'));
    if (shaky) console.log(shaky);
    console.log(noClaim);
    return;
  }
  // 90 天內一筆都沒有(清完之後的空檔、或全部過期還沒清／清不掉):以前清完之後說「感測器可能沒在運作」、清的那一次說「沒有一筆來自這個 worktree」——
  // 多半其實是三個月沒用、照規矩清掉了。也不准反過來講死是過期:空檔看不出是清空的、還是從來沒寫進去,兩種都講。
  // 跟儀表板的對話那一區同一句(lib/rounds.mjs 的 noRecordLine;規格:90天清空之後的說法 AC-1、AC-2)
  if (noRecordsWithin(ev)) {
    // 感測器掛得怎樣跟儀表板看同一種證據(lib/mount.mjs):掛壞了、沒掛上就照講,不講「沒開過對話就沒事」
    const mount = mountState(ctx.root, ctx.mainRoot);
    console.log(`   🔍 ${noRecordLine({ now, here: zhEn('最上面那一行', 'the line at the very top'), optedOut: !!optOutState(ctx.root, ctx.mainRoot) || !!mount.optedOut,
                                       mount: mount.state === 'ok' ? null : mount.state, fix: mountFix(mount) })}`);
    console.log(noClaim);
    return;
  }
  // ⚠️ D2:故障記號是全機一份,而且只代表「那幾次沒記到」,不准把整區蓋成「紀錄檔裡沒有東西」——紀錄照畫。
  //    還在壞的已經在最上面那一行;這裡只講「已經好了、但這一輪碰到那段期間」的(AC-5),跟對話頁同一句。
  //    這一輪的起點是 A／章 才是真的起點;從感測器第一筆紀錄算的(prompt／arrival),真正的開始可能被故障吃掉了(魔鬼教官第一輪)
  const origin = facts.view?.origin ?? null;
  // 起點跟對話頁同一個算法(roundStartFor):這一輪在這裡動過的對話,看它們的轉錄檔建立的時間(魔鬼教官第二輪,P2)
  const active = sessionsOf(events).filter((x) => x.cwd === ctx.root && (!origin?.at || x.lastTs >= origin.at)).map((x) => ({ id: x.id, cwd: x.cwd }));
  const start = roundStartFor({ since: origin?.at ?? null, how: origin?.from ?? null, sessions: active });
  for (const note of faultNotes(faults, { ...start, cwd: ctx.root })) console.log(`   ${note}`);

  // ⚠️ 感測器**有一個開始的日期**。在那之前跑過的事情它一輩子都不會知道。
  // 把那段期間講成「沒跑過」就是 A1:把「沒問到」編碼成「答案是沒有」。
  // 實測就是這樣抓到的:/spec 今天稍早真的跑過,但感測器是之後才裝的,
  // 畫面卻理直氣壯寫著「A 沒跑過」。
  // 只算感測器自己寫的(有 hook 欄位):--report、按鈕記的那一筆不代表感測器從那時候就在記
  const firstTs = events.filter((e) => e.cwd === ctx.root && e.hook).map((e) => e.ts).sort()[0];
  // 「沒有一筆」只講得出保留期限內的:這個資料夾更早的紀錄可能過期清掉了,不是從來沒記過(規格:90天清空之後的說法 AC-2)
  if (!sawAnyEventHere) {
    console.log(zhEn(`   🔍 有紀錄,但 ${RETAIN_DAYS} 天內沒有一筆來自這個 worktree。`, `   🔍 There are records, but none from this worktree in the last ${RETAIN_DAYS} days.`));
    console.log(zhEn(`      （目前在 ${ctx.branch}）`, `      (currently on ${ctx.branch})`));
    return;
  }

  // 這一輪跑到哪:stageFacts 算好的那一份(五關、分級、收工 hook 共用)
  const view = facts.view;
  if (view.roundStart) console.log(zhEn(`   （這一輪從 ${ago(view.roundStart)}開始算：最近一次第一關、或蓋章）`, `   (This round counts from ${ago(view.roundStart)}: the latest first stage, or the latest stamp)`));
  const first = view.stages.find((v) => v.skill);
  for (const st of view.stages) {
    // 中文拿全形空白對齊(一個全形空白佔兩格);英文用半形空白,英文那一頁不准有全形符號
    const label = zhEn(`${st.id} ${st.name}`.padEnd(10, '　'), `${st.id} ${st.name}`.padEnd(14, ' '));
    // E 驗收(瀏覽器那一關):三句話分開講——開過瀏覽器、Claude 說走了一遍、你說驗收過了(E 自動驗收 AC-7)。
    // 文案住 lib/verify.mjs,網頁同一份;要驗哪幾條跟 A 那格的清單同一份(AC-4)。「看到了」不打勾——那是 Claude 說的,不是驗收過了(R2)
    if (st.type === 'browser' && st.state !== 'none') {
      const el = eLines(st, { ago });   // 要驗哪幾條是 roundView 算好掛在這一格的(st.verify)
      const icon = { done: '✅', passed: '✓ ', current: '⏸', stale: '🔁', held: '⏸', seen: '👁' }[st.state] ?? '· ';
      console.log(`   ${label} ${icon} ${el.acts}`);
      console.log(`              ${el.walk}`);
      console.log(`              ${el.human}`);
      if (st.args) {
        const said = `${st.args.slice(0, 46)}${st.args.length > 46 ? '…' : ''}`;
        console.log(zhEn(`              叫的時候說：「${said}」`, `              said when calling it: “${said}”`));
      }
      for (const it of el.items) {
        const body = `${it.id ? `${it.id} ` : ''}${it.body}`;
        console.log(`              ${it.mark} ${body.slice(0, 90)}${body.length > 90 ? '…' : ''}${it.note}`);
      }
      continue;
    }
    // 那一句住 lib/stageLines.mjs(網頁印的是同一句);這裡只管燈號。沒有結案的用 ⏸ 不用 ✅,而且天數一定印出來
    // 「沒有紀錄」跟「這裡根本沒有這個指令」是兩件事(lib/skills.mjs):只有還沒跑的那一格要問
    const available = st.state === 'none' && st.skill ? skillAvailable(st.skill, ctx.root, ctx.mainRoot).found : null;
    const line = stageLine(st, { ago, first: st.id === first?.id, available, clearHint: zhEn(`：pipeline-status --clear ${st.id}`, `: pipeline-status --clear ${st.id}`) });
    console.log(`   ${label} ${ICON[st.state] ?? '· '} ${line}`);
    // B(對話本身)只有那一行:不數檔案——數量在改動體檢那段(git)
    if (st.type === 'main-conversation' && st.state !== 'main') continue;
    const noteLines = () => { for (const l of String(st.report?.note ?? '').split('\n').slice(1)) if (l.trim()) console.log(`              ${l.trim().slice(0, 90)}`); };
    // 已走過的關,結論的清單還是要列(C 的建議不能因為走過了就不見)
    if (st.state === 'passed' && !(st.closedBy === 'link' && st.link)) noteLines();
    if (st.state === 'current' || st.state === 'done') {
      if (st.args) {
        const said = `${st.args.slice(0, 46)}${st.args.length > 46 ? '…' : ''}`;
        console.log(zhEn(`              「${said}」`, `              “${said}”`));
      }
      // 結論的說明有清單(多行)時,一行一行印——C 的建議、D 的發現就住在這裡
      noteLines();
    }
    // 寫規格那一關的旁白(施工對話認規格、規格搬家):規格在哪、另寫了一份、第一句話的提示、分不出是誰記的。都不算 A、不擋人。
    // 每一種狀態都印——以前只在「還沒跑」跟「照連結走過」印,A 自己寫的規格搬家了(現在這一關／已走過)就一句都沒有。別的關沒有這些欄位,印出來是空的
    for (const line of specNotes(st)) console.log(`              ${line}`);
    // A 的清單就是規格檔裡的 AC,照檔案畫(AC-5):✅ 對過、⏳ 待討論、○ 還沒對。解析不了就照原文,找不到就說找不到。
    // ⚠️ 只畫帶條目的那份(A 的)。B 只帶進度摘要——以前 B 還沒改到程式檔時也走到這裡,拿摘要去畫條目,整支當掉印出程式錯誤
    //    (2026-09-21 實測,main 上 9/16 起就有;網頁同一個洞 9/16 修過,L20)
    if (st.checklist && Array.isArray(st.checklist.items)) printChecklist(st.checklist);
  }

  // 沒見過的格式(規格:agent回報與故障記號 AC-2):這一輪在這裡動過的對話,有沒算成你說的話的訊息就講出來——跟對話頁同一句。
  // 好幾個對話都有才各標一句是哪個對話(只有一個的時候「這個對話」就夠清楚)
  const since = facts.view?.origin?.at ?? null;
  const here = sessionsOf(events).filter((s) => s.cwd === ctx.root && (!since || s.lastTs >= since));
  const odd = here.map((s) => ({ s, line: unknownPromptLine(unknownPromptsOf(events, s.id)) })).filter((x) => x.line);
  for (const { s, line } of odd) console.log(`\n   ${odd.length > 1 ? zhEn(`（${s.title ?? s.id.slice(0, 8)}）`, `(${s.title ?? s.id.slice(0, 8)}) `) : ''}${line}`);

  if (firstTs) {
    console.log(zhEn(`\n   ⚠️ 「沒有紀錄」不等於「沒跑過」——感測器從 ${ago(firstTs)}才開始記,`, `\n   ⚠️ "No record" doesn't mean "didn't run" — the sensor only started recording ${ago(firstTs)},`));
    console.log(zhEn('      在那之前發生的事情它一輩子都不會知道。', '      and it will never know what happened before that.'));
  }
  console.log(`\n   ${calledIsNotPassed()}`);   // 跟儀表板同一句(lib/stageLines.mjs)
  // 只有驗收那一關由人說;其他關由儀表板自動辨識,不用你按(五關自動結案 AC-10)。
  // ⚠️ 這一行 Claude 也讀得到:不寫成一句叫人照著跑的指令——Claude 替你記要附你的原話(E 自動驗收 AC-9)
  const e = view.stages.find((v) => v.type === 'browser' && v.state !== 'none' && v.state !== 'done' && v.state !== 'passed');
  if (e) {
    console.log(zhEn(`   驗收過了由你說：按儀表板 ${e.id} 那一格的按鈕，或在你自己的終端機跑 pipeline-status --clear ${e.id}（Claude 替你記要附你的原話）`,
      `   Saying it's accepted is up to you: press the button in ${e.id} on the dashboard, or run pipeline-status --clear ${e.id} in your own terminal (if Claude records it for you, it has to attach your own words)`));
  }
}

/** 規格檔裡的 AC 清單(五關自動結案 AC-5)。給人看的是標題與白話那一句,不印技術那層。上面那一句、每一份那一句住 lib/stageLines.mjs(網頁同一句) */
function printChecklist(cl) {
  const items = (c) => {
    for (const it of c.items) {
      const mark = it.state === 'checked' ? '✅' : it.state === 'pending' ? '⏳' : '○';
      const pend = it.state === 'pending' && it.note ? zhEn(`（待討論：${it.note}）`, ` (pending discussion: ${it.note})`) : '';
      console.log(`              ${mark} ${it.id} ${it.title}${pend}${it.inBatch === false ? zhEn('（不在這一批）', ' (not in this batch)') : ''}`);
      if (it.plain) console.log(`                 ${it.plain.slice(0, 70)}${it.plain.length > 70 ? '…' : ''}`);
    }
  };
  const head = checklistHead(cl);
  if (head) console.log(`              ${head}`);
  // 一輪寫了好幾份(規格:多份規格與新資料夾的起點 AC-1、AC-2、AC-5):一份一段,各寫各的條數
  if (cl.multi) {
    for (const p of cl.parts) {
      const line = checklistPartLine(p);
      if (!line) continue;                                 // 不在這個工作區的那一份:在哪、為什麼,旁白(specNotes)講了
      console.log(`              ── ${line}`);
      if (p.checklist.parsed) items(p.checklist);
    }
    return;
  }
  if (cl.missing || !cl.parsed) return;
  // 分批做的規格(施工對話認規格 AC-8):整份照畫,不在這一批的標出來——收工前只要求這一批
  if (cl.batch) console.log(zhEn(`              這一批只對 ${cl.batch.join('、')}（全部 ${cl.allTotal} 條）`, `              This batch only covers ${cl.batch.join(', ')} (${plural(cl.allTotal, 'item')} in all)`));
  if (cl.batchMissing?.length || cl.preMarked) console.log(`              ⚠️ ${checklistWhy(cl)}`);
  items(cl);
}

// 給 status.mjs 拿。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  renderStages,
};
