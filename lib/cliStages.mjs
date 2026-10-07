/**
 * cliStages.mjs —— 終端機畫面的五關那一段與規格清單(不帶旗標時印)。
 * 規格:五關自動結案、施工對話認規格、多份規格與新資料夾的起點、終端機照指令拆開(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-07 從 status.mjs 原封不動搬過來。clProg、clDoneNote、linkLine、specNotes、checklistWhy 在網頁(ui/app.js)各有一份翻譯,
 * 改一邊要改另一邊——scripts/specLink.test.mjs 打開這支讀原文、兩邊真的各跑一次比一字不差(所以這幾個函式的寫法與開頭不要改)。
 * 不拿任何一支 cli*.mjs;cliRerun.mjs 拿這裡的 specNotes(「規格在哪」那句旁白,E 走一遍時講同一句)。
 */
import { ago } from './git.mjs';
import { RETAIN_DAYS } from './events.mjs';
import { sessionsOf, rerunLine, tookLine, unknownPromptsOf, unknownPromptLine, stagesBrokenLine, noRecordsWithin, noRecordLine } from './rounds.mjs';
import { faultNotes, sensorNow, roundStartFor } from './faults.mjs';
import { eLines } from './verify.mjs';
import { skillAvailable } from './skills.mjs';
import { mountState, mountFix, optOutState } from './mount.mjs';

/* ══════════════════════════ 關卡（需要感測器） ══════════════════════════ */

function renderStages(ctx, ev, facts, info = {}) {
  const { stages, perStage, cleared, sawAnyEventHere } = facts;
  if (!stages.length) return;

  const { state, events } = ev;
  const faults = info.faults ?? null;
  console.log('\n━━ 五關 ━━');
  // 專案自己寫的關卡讀不懂:退回內建的五關,但要講(跟儀表板同一句,lib/rounds.mjs)
  if (facts.stagesBroken) console.log(`   ${stagesBrokenLine(facts.stagesBroken)}`);

  // ⚠️ AC-1／AC-7:三種「看起來一樣」的情況必須分開講。
  // 感測器在這台電腦上記不到東西(故障記號,最上面那一行)的時候,「分不出來」不是真的——分得出來:是壞了
  // (規格:agent回報與故障記號 AC-3)。只有收工 hook 的故障、或感測器已經好了的,照舊講分不出來
  // 時好時壞(flaky)時「現在記不到」不是真的(最後一筆故障之後又記到了):「分不出來」照舊,另外講時好時壞(魔鬼教官第一輪)
  const now = sensorNow(faults);
  const shaky = now === 'flaky' ? '      這台電腦的感測器時好時壞（見最上面那一行），也可能是這個原因。' : null;
  if (state === 'no-file') {
    if (now === 'broken') {
      console.log('   🔍 這個專案還沒有任何感測器紀錄——這台電腦的感測器現在記不到東西（見最上面那一行）,');
      console.log('      所以不會說「五關都沒跑」。');
      return;
    }
    console.log('   🔍 這個專案還沒有任何感測器紀錄。');
    console.log('      可能是還沒裝感測器,也可能是裝了還沒跑過任何指令——**這兩種我分不出來**,');
    if (shaky) console.log(shaky);
    console.log('      所以不會說「五關都沒跑」。');
    return;
  }
  // 90 天內一筆都沒有(清完之後的空檔、或全部過期還沒清／清不掉):以前清完之後說「感測器可能沒在運作」、清的那一次說「沒有一筆來自這個 worktree」——
  // 多半其實是三個月沒用、照規矩清掉了。也不准反過來講死是過期:空檔看不出是清空的、還是從來沒寫進去,兩種都講。
  // 跟儀表板的對話那一區同一句(lib/rounds.mjs 的 noRecordLine;規格:90天清空之後的說法 AC-1、AC-2)
  if (noRecordsWithin(ev)) {
    // 感測器掛得怎樣跟儀表板看同一種證據(lib/mount.mjs):掛壞了、沒掛上就照講,不講「沒開過對話就沒事」
    const mount = mountState(ctx.root, ctx.mainRoot);
    console.log(`   🔍 ${noRecordLine({ now, here: '最上面那一行', optedOut: !!optOutState(ctx.root, ctx.mainRoot) || !!mount.optedOut,
                                       mount: mount.state === 'ok' ? null : mount.state, fix: mountFix(mount) })}`);
    console.log('      所以不會說「五關都沒跑」。');
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
    console.log(`   🔍 有紀錄,但 ${RETAIN_DAYS} 天內沒有一筆來自這個 worktree。`);
    console.log(`      （目前在 ${ctx.branch}）`);
    return;
  }

  // 這一輪跑到哪:stageFacts 算好的那一份(五關、分級、收工 hook 共用)
  const view = facts.view;
  if (view.roundStart) console.log(`   （這一輪從 ${ago(view.roundStart)}開始算：最近一次第一關、或蓋章）`);
  for (const st of view.stages) {
    const label = `${st.id} ${st.name}`.padEnd(10, '　');
    // B(對話本身):改到程式檔就算在動;最後一次改檔的時間要印出來。不數檔案——數量在改動體檢那段(git)
    if (st.type === 'main-conversation' && st.state !== 'main') {
      const cl = st.checklist;
      const prog = clProg(cl);
      const viaNote = st.via === 'git' ? '（感測器沒看到改檔,是 git 說的——可能是用 Bash 寫的）' : '';
      const extra = cl?.batchMissing?.length || cl?.preMarked ? `；${checklistWhy(cl)}` : '';
      console.log(st.state === 'current' ? `   ${label} ⏸ 最後一次改程式檔 ${ago(st.ranAt)}${viaNote}——現在在這一關${prog ? `（${prog}${extra}）` : ''}`
        : st.state === 'stale' ? `   ${label} 🔁 改過程式檔（最後一次 ${ago(st.ranAt)}）,${prog}——${checklistWhy(cl)},不算寫完`
        : st.state === 'done' ? `   ${label} ✅ 改過程式檔（最後一次 ${ago(st.ranAt)}）,${ago(st.doneAt)}Claude 對完清單${clDoneNote(cl)}`
        : `   ${label} ✓  改過程式檔（最後一次 ${ago(st.ranAt)}）${st.closedBy === 'checklist' ? `,Claude 對完清單${clDoneNote(cl)}` : ''}——已走過`);
      continue;
    }
    // E 驗收(瀏覽器那一關):三句話分開講——開過瀏覽器、Claude 說走了一遍、你說驗收過了(E 自動驗收 AC-7)。
    // 文案住 lib/verify.mjs,網頁同一份;要驗哪幾條跟 A 那格的清單同一份(AC-4)。「看到了」不打勾——那是 Claude 說的,不是驗收過了(R2)
    if (st.type === 'browser' && st.state !== 'none') {
      const el = eLines(st, { ago });   // 要驗哪幾條是 roundView 算好掛在這一格的(st.verify)
      const icon = { done: '✅', passed: '✓ ', current: '⏸', stale: '🔁', held: '⏸', seen: '👁' }[st.state] ?? '· ';
      console.log(`   ${label} ${icon} ${el.acts}`);
      console.log(`              ${el.walk}`);
      console.log(`              ${el.human}`);
      if (st.args) console.log(`              叫的時候說：「${st.args.slice(0, 46)}${st.args.length > 46 ? '…' : ''}」`);
      for (const it of el.items) {
        const body = `${it.id ? `${it.id} ` : ''}${it.body}`;
        console.log(`              ${it.mark} ${body.slice(0, 90)}${body.length > 90 ? '…' : ''}${it.note}`);
      }
      continue;
    }
    // 「被叫」的證據有兩種:你自己打的斜線指令(不經過 Skill 工具,L19)、或 Claude 自己去叫。字要跟證據一樣大:叫了,不是跑完了
    const verb = st.type === 'browser' ? `開瀏覽器跑過一輪${st.count ? `（${st.count} 個動作）` : ''}`
      : st.via === 'typed' ? `你叫了 /${st.calledAs}` : `Claude 叫了 /${st.calledAs ?? st.skill}`;
    // 結論會過期的關(D):「要不要再跑」那一句與「上一輪從叫到記結論幾分鐘」都從 lib/rounds.mjs 拿(D 多輪先問人 AC-9、AC-13),這裡只負責印。
    // 花了多久只在最後一次跑完時印——還在跑的那一次只講「N 分鐘前叫的」
    const took = st.rerun?.took?.latest ? `（${tookLine(st.rerun.took)}）` : '';
    const lastHead = String(st.report?.note ?? '').split('\n')[0].trim();
    // 上一次 Claude 說了什麼:只在「要不要再跑」與「你說不用再跑」時補——找到問題那一句本身就帶著結論(跟網頁同一條規則)
    const prev = (st.rerun?.state === 'ask' || st.rerun?.state === 'skipped') && lastHead ? ` · 上一次 Claude 說：${lastHead}` : '';
    switch (st.state) {
      case 'main':     console.log(`   ${label} ●  就是你在講話的那個對話（這一輪還沒改到程式檔）`); break;
      case 'notbuilt': console.log(`   ${label} ⚫ 未建`); break;
      case 'none': {
        // 「沒有紀錄」跟「這裡根本沒有這個指令」是兩件事(lib/skills.mjs);上一輪的只講一句,不畫線
        const av = st.skill ? skillAvailable(st.skill, ctx.root, ctx.mainRoot) : { found: null };
        console.log(av.found === false
          ? `   ${label} ⚪ 找不到 /${st.skill} 這個指令（這個專案的 .claude/ 和 ~/.claude 都沒有）`
          : `   ${label} ⚪ 這一輪還沒跑${st.prevRanAt ? `（上一輪 ${ago(st.prevRanAt)}跑過）` : ''}`);
        break;
      }
      // A 的結案是你點頭開工(之後第一次改到程式檔):講出來,不然像是憑空劃掉的
      case 'passed': {
        // 照別的對話寫的規格施工(施工對話認規格 AC-1):連結不是 A 的一次呼叫,沒有「叫了」的時間可講,講照哪份、誰說的
        if (st.closedBy === 'link' && st.link) {
          console.log(`   ${label} ✓  已走過：${linkLine(st.link)}`);
          break;
        }
        const head = String(st.report?.note ?? '').split('\n')[0].trim();
        const who = st.closedBy === 'nod' ? `,${ago(st.nodAt)}開始改程式檔,算你點頭開工了` : st.closedBy === 'claude' && head ? `,Claude 說：${head}` : st.closedBy === 'human' ? ',你說處理完了' : '';
        console.log(`   ${label} ✓  ${ago(st.ranAt)}${verb}${who}——已走過${took}`);
        // 已走過的關,結論的清單還是要列(C 的建議不能因為走過了就不見)
        for (const line of String(st.report?.note ?? '').split('\n').slice(1)) if (line.trim()) console.log(`              ${line.trim().slice(0, 90)}`);
        break;
      }
      // 結論會過期的關(D):D 之後又改了程式檔——要不要再跑由你決定(D 多輪先問人 AC-2),不是「要再跑」;叫了沒記結論也是這個樣子。不劃掉、不打勾
      case 'stale':    console.log(`   ${label} 🔁 ${ago(st.ranAt)}${verb},${st.rerun ? rerunLine(st.rerun, { ago }) : '之後又改了程式檔——要再跑一次'}${prev}${took}`); break;
      // 你說不用再跑(AC-4):附你在 D 之後說的最後一句(感測器記的)與時間。擱著——是你的決定,不是驗過了,所以不是 ✅
      case 'held':     console.log(`   ${label} ⏸ ${ago(st.ranAt)}${verb},${rerunLine(st.rerun, { ago })}${prev}${took}`); break;
      case 'seen': {
        // 開過瀏覽器 ≠ 驗收過。講得出去了哪,算不算驗收由人說(--clear E)
        const where = st.hosts?.length ? `,去了 ${st.hosts.slice(0, 3).join('、')}` : '';
        console.log(`   ${label} 👁 ${ago(st.ranAt)}開過瀏覽器（${st.count} 個動作${where}）——算不算驗收你說了算：pipeline-status --clear ${st.id}`);
        break;
      }
      default: {
        // current／done。沒有結案的,時間越久要越顯眼——所以天數一定印出來,而且用 ⏸ 不用 ✅。
        // 結案要說得出是誰說的(AC-11):Claude 說(記的結論)、你說(E 驗收、舊紀錄)。等結論的關講清楚在等誰
        const closed = st.state === 'done';
        const said = st.type === 'browser' ? '驗收過了' : '處理完了';
        const first = view.stages.find((v) => v.skill);
        let tail;
        const head = String(st.report?.note ?? '').split('\n')[0].trim();
        if (closed) tail = (st.closedBy === 'claude' ? `,${ago(st.doneAt)}Claude 說${head ? `：${head}` : '沒問題'}` : `,${ago(st.doneAt)}你說${said}`) + took;
        else if (st.report?.verdict === 'found') tail = `,Claude 說找到問題${head ? `：${head}` : ''}——還沒處理完${took}`;
        else if (st.type === 'browser') tail = `,還沒有人說${said}`;
        else if (first && st.id === first.id) tail = ',等你點頭開工';
        else tail = `,${st.rerun ? rerunLine(st.rerun, { ago }) : 'Claude 還沒記結論'}`;
        console.log(`   ${label} ${closed ? '✅' : '⏸'} ${ago(st.ranAt)}${verb}${tail}`);
        if (st.args) console.log(`              「${st.args.slice(0, 46)}${st.args.length > 46 ? '…' : ''}」`);
        // 結論的說明有清單(多行)時,一行一行印——C 的建議、D 的發現就住在這裡
        for (const line of String(st.report?.note ?? '').split('\n').slice(1)) if (line.trim()) console.log(`              ${line.trim().slice(0, 90)}`);
      }
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
  for (const { s, line } of odd) console.log(`\n   ${odd.length > 1 ? `（${s.title ?? s.id.slice(0, 8)}）` : ''}${line}`);

  if (firstTs) {
    console.log(`\n   ⚠️ 「沒有紀錄」不等於「沒跑過」——感測器從 ${ago(firstTs)}才開始記,`);
    console.log('      在那之前發生的事情它一輩子都不會知道。');
  }
  console.log('\n   ⚠️ 上面寫的是「叫了」,不是「通過」——感測器只看得到指令被叫,');
  console.log('      看不到結果。驗屋師傅來過,不等於房子修好了。');
  // 只有驗收那一關由人說;其他關由儀表板自動辨識,不用你按(五關自動結案 AC-10)。
  // ⚠️ 這一行 Claude 也讀得到:不寫成一句叫人照著跑的指令——Claude 替你記要附你的原話(E 自動驗收 AC-9)
  const e = view.stages.find((v) => v.type === 'browser' && v.state !== 'none' && v.state !== 'done' && v.state !== 'passed');
  if (e) console.log(`   驗收過了由你說：按儀表板 ${e.id} 那一格的按鈕，或在你自己的終端機跑 pipeline-status --clear ${e.id}（Claude 替你記要附你的原話）`);
}

/** 規格檔裡的 AC 清單(五關自動結案 AC-5)。給人看的是標題與白話那一句,不印技術那層。 */
function printChecklist(cl) {
  const rel = (f) => (typeof f === 'string' ? f.split('/').slice(-3).join('/') : '');
  const items = (c) => {
    for (const it of c.items) {
      const mark = it.state === 'checked' ? '✅' : it.state === 'pending' ? '⏳' : '○';
      console.log(`              ${mark} ${it.id} ${it.title}${it.state === 'pending' && it.note ? `（待討論：${it.note}）` : ''}${it.inBatch === false ? '（不在這一批）' : ''}`);
      if (it.plain) console.log(`                 ${it.plain.slice(0, 70)}${it.plain.length > 70 ? '…' : ''}`);
    }
  };
  // 一輪寫了好幾份(規格:多份規格與新資料夾的起點 AC-1、AC-2、AC-5):一份一段,各寫各的條數;總數只加讀得到的,讀不到的講出來。
  // 「全部 N 條」只在一份的時候出現——只算一份卻長得像全部,就是 2026-10-02 那個「全部 5 條其實 15 條」
  if (cl.multi) {
    console.log(`              這一輪寫了 ${cl.parts.length} 份規格，共 ${cl.total} 條${cl.unreadable?.length ? `（另有 ${cl.unreadable.length} 份讀不到，條數不在裡面）` : ''}`);
    for (const p of cl.parts) {
      const c = p.checklist;
      if (!c) continue;                                    // 不在這個工作區的那一份:在哪、為什麼,旁白(specNotes)講了
      if (!c.parsed) { console.log(`              ── ${p.name}：${c.missing ? '找不到規格檔' : '規格檔裡沒有照格式寫的 AC'}（${rel(c.file)}）`); continue; }
      console.log(`              ── ${p.name}：${clProg(c).replace(/^清單 /, '')}（這份 ${c.total} 條）`);
      items(c);
    }
    return;
  }
  if (cl.missing) { console.log(`              清單：找不到這一輪的規格檔${cl.file ? `（${rel(cl.file)}）` : ''}`); return; }
  if (!cl.parsed) { console.log(`              清單：規格檔裡沒有照格式寫的 AC（${rel(cl.file)}）${cl.head ? `,開頭是：${cl.head.slice(0, 60)}` : ''}`); return; }
  // 分批做的規格(施工對話認規格 AC-8):整份照畫,不在這一批的標出來——收工前只要求這一批
  if (cl.batch) console.log(`              這一批只對 ${cl.batch.join('、')}（全部 ${cl.allTotal} 條）`);
  if (cl.batchMissing?.length || cl.preMarked) console.log(`              ⚠️ ${checklistWhy(cl)}`);
  items(cl);
}

/**
 * B 的清單進度一句話:「清單 3/5 對過,1 條待討論,1 條還沒對」。沒有清單是 null。分批做的規格只數這一批(施工對話認規格 AC-8)。
 * 好幾份規格:講幾份、共幾條,讀不到的另外講(規格:多份規格與新資料夾的起點 AC-2、AC-5)。網頁(ui/app.js 的 clProg)是翻譯,改一邊要改另一邊
 */
function clProg(cl) {
  if (!cl?.parsed) return null;
  const tail = `${cl.pending ? `,${cl.pending} 條待討論` : ''}${cl.unmarked ? `,${cl.unmarked} 條還沒對` : ''}`;
  if (cl.multi) return `${cl.specs} 份規格共 ${cl.total} 條：${cl.checked} 條對過${tail}${cl.unreadable?.length ? `（另有 ${cl.unreadable.length} 份讀不到，條數不在裡面）` : ''}`;
  return `清單${cl.batch ? '這一批' : ''} ${cl.checked}/${cl.total} 對過${tail}`;
}

/** Claude 對完清單之後那一句的括號:好幾份規格才有——對完的是幾份、共幾條,讀不到的那份不算進「對完」(R2)。網頁同一句 */
function clDoneNote(cl) {
  return cl?.multi ? `（${cl.specs} 份規格共 ${cl.total} 條${cl.unreadable?.length ? `；另有 ${cl.unreadable.length} 份讀不到，條數不在裡面` : ''}）` : '';
}

/** 「照別的對話寫的規格 X（Claude 說的）」——終端機與網頁同一句(ui/app.js 的 linkLine 是翻譯,改一邊要改另一邊)。 */
function linkLine(link) {
  const how = link.how === 'only' ? '；沒記到對話代號，這個工作區只有這個對話' : '';
  return `照別的對話寫的規格 ${link.name}（Claude 說的${how}）`;
}

/** 寫規格那一關的旁白:規格在哪、另寫了一份、第一句話的提示、分不出是誰記的。都只是講,不算 A、不擋人(施工對話認規格)。 */
function specNotes(st) {
  const L = [];
  const lk = st.link;
  // 規格在哪(規格搬家 AC-3、AC-4):別的對話寫的連結、這個對話 A 寫的,兩條路都讀 specPlace 這一份——同一個地方判斷、同一句話
  const where = (at) => {
    // 資料夾不在了(worktree 清掉了):工作區裡沒辦法找,不准講成「都沒有同名的」(R1,魔鬼教官 2026-09-22)
    if (at?.gone) return at.found === 'main' ? `這個對話的資料夾已經不在了；規格在主資料夾：${at.rel ?? `${at.name}.md`}` : `這個對話的資料夾已經不在了，找不到記的規格檔（${at.given ?? `${at.name}.md`}）`;
    // 記在主資料夾的(worktree 的對話把規格寫進了主資料夾):講寫在那裡,不講「可能還沒併進來」
    if (at?.found === 'main') return at.recordedIn === 'main' ? `規格寫在主資料夾（${at.rel ?? `${at.name}.md`}），不在這個工作區——不會叫 Claude 去那裡打勾` : '規格在主資料夾，不在這個工作區（可能還沒併進來）——不會叫 Claude 去那裡打勾';
    if (at?.found === 'missing') return `找不到規格檔 ${at.name}.md${!at.given ? '' : at.recordedIn === 'main' ? `（記的是主資料夾的 ${at.given}；主資料夾的規劃中／進行中／升級摘要都沒有同名的）` : `（記的是 ${at.given}；規劃中／進行中／升級摘要都沒有同名的）`}`;
    // 同名的那一份比記的那份還舊:分不出是不是同一份,不拿它的勾(R2,魔鬼教官 2026-09-22);證據只到「比較舊」,不講「是別份」(第二輪)
    if (at?.found === 'older') return `記的規格檔 ${at.name}.md 不在記的位置（${at.given}）；工作區裡同名的 ${at.rel} 比記的那份還舊，分不出是不是同一份——不畫它的清單`;
    // 記的位置不在這個工作區、也不在主資料夾:不拿工作區裡同名的另一份頂替(P6,魔鬼教官 2026-09-22)
    if (at?.found === 'outside') return `記的規格檔 ${at.name}.md 不在這個工作區，也不在主資料夾——不會叫 Claude 去那裡打勾`;
    if (at?.found === 'ambiguous') return `工作區裡叫 ${at.name}.md 的規格不只一份（${(at.where ?? []).join('、')}），分不出是哪一份`;
    if (at?.moved) return `規格搬到了 ${at.rel}（記的是 ${at.given}）`;
    return null;
  };
  // 一次 A 寫了好幾份(規格:多份規格與新資料夾的起點 AC-5):一份一句,前面標是哪一份——讀不到的那份不准安靜消失
  const many = Array.isArray(st.specPlaces) && st.specPlaces.length > 1;
  for (const at of many ? st.specPlaces : [st.specPlace]) {
    const line = where(at);
    if (line) L.push(many ? `${at.name}：${line}` : line);
  }
  if (st.side) L.push(!st.side.name ? `${ago(st.side.ts)}又叫了寫規格那一關（寫了哪份看不到）；施工清單還是 ${lk?.name ?? '原本那份'}`
    : st.side.count > 1 ? `另寫了 ${st.side.count} 份規格 ${st.side.name}（等你點頭）` : `另寫了一份規格 ${st.side.name}（等你點頭）`);
  // 連著一份規格又記了另一份(AC-7):換掉可以,安靜換掉不行。這一輪自己叫 A 寫的被 --spec 換掉也一樣
  if (st.replaced) L.push(st.replaced.own ? `原本照 ${(st.replaced.fromNames ?? [st.replaced.from]).map((n) => `${n}.md`).join('、')}（這個對話叫 A 寫的），後來換成 ${st.replaced.to}.md`
    : `原本照 ${st.replaced.from}.md，後來換成 ${st.replaced.to}.md`);
  // 這一輪之前叫 A 寫的、還有沒對完的(同一個對話叫第二次 A,一輪從後來那次算):收工 hook 不會再要它的清單,講出來
  for (const e of st.earlierSpecs ?? []) L.push(`${e.name}.md 是這一輪之前叫 A 寫的，還有 ${e.unmarked} 條沒對——這一輪從後來那次 A 算起，收工 hook 不會要它的清單`);
  // 記過、現在哪裡都找不到的(改名、刪了):不算進這一輪的規格,講一句
  if (st.ghostSpecs?.length) L.push(`記過 ${st.ghostSpecs.map((n) => `${n}.md`).join('、')}，現在找不到（可能改名或刪了）——不算進這一輪的規格`);
  if (st.hint) L.push(`從你第一句話看，可能是照 ${st.hint.name} 施工（Claude 還沒確認${st.hint.cut ? '；感測器只記第一句話的開頭，後面有沒有提到別份看不到' : ''}）`);
  if (st.unsure) L.push(`有一筆規格連結（${st.unsure.name}）分不出是哪個對話記的——不算數`);
  if (st.shared) L.push('這個工作區這一輪有好幾個對話；規格連結只算記它的那個對話，看儀表板各對話的頁面');
  // 這一輪還動了別的規格檔、沒記到它是不是這一輪的(AC-6):講一句,不擋收工(Oscar 2026-10-05:會多講話,可以)
  if (st.extraSpecs?.length) L.push(`這一輪還動了 ${st.extraSpecs.map((n) => `${n}.md`).join('、')}，沒記到${st.extraSpecs.length > 1 ? '它們' : '它'}是不是這一輪的規格`);
  return L;
}

/** B 為什麼還不算寫完:清單還有沒對的、這一批記的代號對不上檔案、或勾都是連上之前就打好的(施工對話認規格)。終端機與網頁同一句 */
function checklistWhy(cl) {
  if (cl?.batchMissing?.length) return `這一批記的 ${cl.batchMissing.join('、')} 在規格裡找不到了（可能改過號），要重記 --spec`;
  // 連上之前就有的勾,分不出是誰打的:施工的對話常常先對清單、收工時才記 --spec(魔鬼教官第二輪 2026-09-22,R1)——不准斷言「這個對話沒對過」
  if (cl?.preMarked) return '清單的勾在連上這份之前就打好了，分不出是不是這個對話打的';
  return '清單沒對完';
}

// 給 cliRerun.mjs、status.mjs 拿。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  renderStages, specNotes,
};
