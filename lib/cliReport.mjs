/**
 * cliReport.mjs —— 記一筆給儀表板:--report(Claude 記一關的結論)、--clear(你說的話)、--spec(照哪份規格)、--suggest(建議卡)。
 * 規格:五關自動結案、施工對話認規格、app建議卡、終端機照指令拆開(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-07 從 status.mjs 原封不動搬過來。寫進哪一個紀錄檔由 cliFacts.mjs 的 LOG_DIR 決定——不准在這裡另算一份。
 * 只從 cliFacts.mjs 拿東西。
 */
import { writeFileSync, appendFileSync } from 'node:fs';
import { makeDataDir } from './paths.mjs';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import process from 'node:process';
import { real, git, ago } from './git.mjs';
import { readEvents, safeName, logFileOf } from './events.mjs';
import { loadStages, runsPerStage, reportText, noWords } from './rounds.mjs';
import { eLines, parseWalk, walkSummary, summaryLine } from './verify.mjs';
import { readChecklist, locateSpec, specPathsInNote } from './checklist.mjs';
import { commandFor, pluginName } from './skills.mjs';
import { HERE, LOG_DIR, tenureOfCtx, gatherChange, stageFacts, sessionFromEnv, rerunFacts, MAX_NOTE_BYTES, cutBytes } from './cliFacts.mjs';
import { zhEn } from './lang.mjs';

/**
 * 人蓋的結案章(AC-9)。⚠️ 寫進同一份 append-only 紀錄,但標明 source:'human'。
 * Claude 替你記(E 自動驗收 AC-9):指令的環境有對話代號(CLAUDE_CODE_SESSION_ID)就是 Claude 在跑——一定要附你的原話,
 *   記 via:'claude'、對話代號與它給的原話;算不算數由讀取端對感測器記的、你在 E 之後說的最後一句(跟 --decide 同一套)。
 *   ⚠️ 以前 Claude 替你跑的跟你自己按的一模一樣(9/16 那一筆就是)。你自己的終端機沒有這個代號,照舊是你說的。
 */
async function doClear(ctx, args) {
  const [stageId, ...words] = args;
  const { stages } = loadStages(HERE, ctx.root, ctx.mainRoot);
  const st = stages.find((x) => x.id.toLowerCase() === String(stageId).toLowerCase());
  if (!st) {
    console.log(zhEn(`認不出關卡「${stageId}」。這個專案的關卡是：${stages.map((x) => x.id).join(' / ')}`, `Can't tell which stage "${stageId}" is. This project's stages are: ${stages.map((x) => x.id).join(' / ')}`));
    return 1;
  }
  // 只有驗收那一關由人說(五關自動結案 AC-10);其他關由儀表板自動辨識——A 你點頭開工、B 改程式、C／D 由 Claude 記結論
  if (st.type !== 'browser') {
    const e = stages.find((x) => x.type === 'browser');
    console.log(zhEn(`${st.id} ${st.name} 現在由儀表板自動辨識,不用你按。${e ? `只有 ${e.id} ${e.name} 由你說：  pipeline-status --clear ${e.id}` : ''}`,
      `The dashboard now recognizes ${st.id} ${st.name} by itself, so there's nothing for you to do.${e ? ` Only ${e.id} ${e.name} is yours to say:  pipeline-status --clear ${e.id}` : ''}`));
    return 1;
  }
  const sid = sessionFromEnv();
  const quote = words.join(' ').trim();
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'stage_cleared', stage: st.id,
      cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'human',
      // 在 Claude Code 裡跑的(環境有對話代號):Claude 代記,或你自己在對話框用 ! 跑的——這一刻分不出來,讀取端對感測器記的那一句分
      // (你用 ! 跑的,感測器會在指令跑完之後記下那一句;Claude 的工具呼叫不會)。欄位刻意不叫 session(讀紀錄的程式會把帶 session 的都當成那個對話的活動)
      ...(sid ? { via: 'claude', by_session: sid, ...(quote ? { quote: cutBytes(quote, 600) } : {}) } : {}),
    }) + '\n');
  } catch (e) {
    console.log(zhEn(`❌ 沒記成功：${e.message}`, `❌ Couldn't record it: ${e.message}`));
    return 1;
  }
  if (!sid) {
    console.log(zhEn(`✅ 記下了：你說 ${st.id} ${st.name}過了（${ctx.head?.slice(0, 7)}）`, `✅ Recorded: you said ${st.id} ${st.name} is accepted (${ctx.head?.slice(0, 7)})`));
    console.log(zhEn('   ⚠️ 這是「你說的」,不是系統驗證的——畫面上會照實這樣寫。', '   ⚠️ This is "what you said", not something the system checked — the screens will say exactly that.'));
    return 0;
  }
  if (!quote) {
    // 沒附原話:可能是你自己在對話框用 ! 跑的(魔鬼教官第一輪:以前一律拒收,擋到的是你自己),也可能是 Claude 沒照規矩——
    // 這一刻分不出來,不在這裡下結論:儀表板對感測器記的那一句,認得出是你就算你的,不然照實講不算數
    console.log(zhEn(`✅ 記下了：${st.id} ${st.name}過了（在對話裡跑的）。`, `✅ Recorded: ${st.id} ${st.name} accepted (run inside a conversation).`));
    console.log(zhEn('   是你自己在對話框用 ! 跑的：儀表板認得是你（感測器會記下你打的那一句），算你說的。',
      '   If you ran it yourself with ! in the chat box: the dashboard recognizes it\'s you (the sensor records the line you typed), so it counts as yours.'));
    console.log(zhEn(`   是 Claude 替使用者記的：要附上使用者的原話（pipeline-status --clear ${st.id} "使用者的原話"）——沒附、而且 ${st.id} 之後紀錄裡沒有他說的話，這筆不算數。`,
      `   If Claude recorded it for the user: the user's own words have to be attached (pipeline-status --clear ${st.id} "the user's own words"); without them, and with nothing the user said after ${st.id} in the records, this one doesn't count.`));
    return 0;
  }
  // 記完再算一次:講清楚這筆算不算數、畫面會附哪一句(跟 --decide 同一個做法)
  const f = await rerunFacts(ctx, readEvents(LOG_DIR, ctx.project));
  const a = f?.view.stages.find((x) => x.id === st.id)?.accept ?? null;
  console.log(zhEn(`✅ 記下了：使用者說 ${st.id} ${st.name}過了（Claude 代記）。`, `✅ Recorded: the user said ${st.id} ${st.name} is accepted (Claude recorded it for them).`));
  if (a?.valid && a.by === 'claude') {
    const t = `${String(a.said.text).replace(/\s+/g, ' ').slice(0, 60)}${a.said.text.length > 60 || a.said.cut ? '…' : ''}`;
    console.log(zhEn(`   儀表板附的是 ${st.id} 之後使用者說的最後一句：「${t}」——對得上就是他說的。`, `   The dashboard attaches the last thing the user said after ${st.id}: “${t}”; if it matches, that's what they said.`));
  } else if (a?.valid) console.log(zhEn(`   （這一輪 ${st.id} 已經有使用者自己說的驗收，照舊算那一筆。）`, `   (This round's ${st.id} already has an acceptance the user said themselves; that one still counts.)`));
  else if (a?.rejected) console.log(zhEn(`   ⚠️ 這筆不算數：${st.id} 之後，${noWords(a.rejected.odd)}——分不出是不是使用者說的。儀表板照實這樣講。`, `   ⚠️ This one doesn't count: after ${st.id}, ${noWords(a.rejected.odd)}, so it can't tell whether the user said it. The dashboard says exactly that.`));
  else console.log(zhEn('   ⚠️ 找不到這一輪從哪開始——這筆分不出是不是這一輪的，儀表板不會算它。', '   ⚠️ Can\'t find where this round started, so it can\'t tell whether this one belongs to this round; the dashboard won\'t count it.'));
  console.log(zhEn('   ⚠️ 這是「使用者說的、Claude 代記的」，不是系統驗證的——畫面上會照實這樣寫。', '   ⚠️ This is "what the user said, recorded by Claude", not something the system checked — the screens will say exactly that.'));
  return 0;
}

/**
 * --spec <規格檔> [AC-1 AC-2 …]:Claude 記一筆「這個對話照哪份規格施工」(施工對話認規格 AC-1、AC-4、AC-8)。
 * 規格在別的對話寫、點頭後另開對話施工——施工的對話記這一筆,儀表板的寫規格那一關才畫得出那份清單、收工 hook 才不叫它重寫規格。
 * --spec 無:這個對話沒有照別的對話寫的規格(第一句話來的提示會消失;分級要寫規格那一關的話,還是要跑)。
 * ⚠️ 這是「Claude 說的」:事件標 source:'claude',畫面照實標(R2)。連結不是寫規格那一關的一次呼叫,不算「跑過」。
 * ⚠️ 只收還沒做完的規格(AC-4):這個工作區 docs/規劃中/ 或 docs/進行中/ 的 .md、讀得出 AC、不是這個對話自己寫的。
 *    工作區沒有、只在主資料夾有(可能還沒併進來)→ 收,但講明:儀表板只寫一句「在主資料夾」,不叫 Claude 去那裡打勾(AC-6)。
 * 對話代號:Claude Code 給指令的環境變數 CLAUDE_CODE_SESSION_ID(2026-09-21 實測有給,跟感測器記的 session 一樣)。
 *   拿不到就不記,讀取端只在「這個工作區只有一個對話」時才歸給它(lib/rounds.mjs 的 linkOwner)——不猜一個填進去。
 */
function doSpec(ctx, ev, args) {
  const [target, ...rest] = args;
  if (!target?.trim()) {
    console.log('要一份規格檔：  pipeline-status --spec docs/進行中/<名字>.md');
    console.log('   只做其中幾條就在後面加代號（例：--spec docs/進行中/<名字>.md AC-1 AC-2）；沒有照哪份規格就 --spec 無');
    return 1;
  }
  const sid = sessionFromEnv();
  const { stages } = loadStages(HERE, ctx.root, ctx.mainRoot);
  const first = stages.find((x) => x.skill);
  const stageName = first ? `${first.id} ${first.name}` : '寫規格那一關';
  const record = (extra) => {
    try {
      appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
        ts: new Date().toISOString(), event: 'spec_link', ...extra, ...(sid ? { by_session: sid } : {}),
        cwd: ctx.root, main: ctx.mainRoot ?? null, head: ctx.head?.slice(0, 7), source: 'claude',
      }) + '\n');
      return true;
    } catch (e) { console.log(`❌ 沒記成功：${e.message}`); return false; }
  };
  const tail = () => { if (!sid) console.log('   （拿不到這個對話的代號：這個工作區只有一個對話時，儀表板才算得出是它記的；有別的對話來過就不歸給任何對話、也不擋。）'); };

  if (['無', 'none'].includes(target.trim())) {
    if (!record({ spec: null, none: true })) return 1;
    console.log('✅ 記下了：這個對話沒有照別的對話寫的規格施工（Claude 說的）。');
    console.log(`   從第一句話來的提示會消失；這次改動的分級要 ${stageName} 的話，收工前還是會要求跑。`);
    tail();
    return 0;
  }

  const notDone = `只收還沒做完的規格：這個工作區 docs/規劃中/ 或 docs/進行中/ 底下的 .md。`;
  // 工作區的根是 git 給的真實路徑;給的路徑也解析成真實路徑再比(macOS 的暫存資料夾、捷徑都會讓兩種拼法對不上)。
  // 檔案不在工作區(只在主資料夾)就解析它所在的資料夾。
  // 相對路徑先照指令列所在的位置解;解出來不在這個工作區的 docs/ 底下,再照工作區的根解——從子資料夾跑也認得(魔鬼教官 2026-09-21)
  const relOf = (p) => { const abs = real(p) !== p ? real(p) : join(real(dirname(p)), basename(p)); return relative(ctx.root, abs).split('\\').join('/'); };
  let rel = relOf(isAbsolute(target) ? target : resolve(process.cwd(), target));
  if (!isAbsolute(target) && !/^docs\//i.test(rel)) rel = relOf(resolve(ctx.root, target));
  if (/^docs\/升級摘要\/[^/]+\.md$/i.test(rel)) {
    console.log(`這份在 docs/升級摘要/，是已經做完的規格，不能拿來施工。${notDone}`);
    console.log(`   要照它再改一輪的話，另寫一份新規格（跑 ${stageName}）。`);
    return 1;
  }
  if (!/^docs\/(規劃中|進行中)\/[^/]+\.md$/i.test(rel)) { console.log(`認不得「${target}」。${notDone}`); return 1; }
  const loc = locateSpec(rel, { root: ctx.root, mainRoot: ctx.mainRoot });
  if (loc.found === 'missing') { console.log(`找不到 ${rel}（這個工作區和主資料夾的規劃中／進行中／升級摘要都沒有 ${basename(rel)}）。`); return 1; }
  if (loc.found === 'ambiguous') { console.log(`這個工作區裡叫 ${basename(rel)} 的規格不只一份：${loc.where.join('、')}。給完整路徑。`); return 1; }
  if (loc.found === 'main' && !loc.mainFile) { console.log(`主資料夾裡叫 ${basename(rel)} 的規格不只一份，分不出是哪一份。`); return 1; }
  // 名字對上了,但它已經搬到升級摘要(做完了)
  if (!/^docs\/(規劃中|進行中)\//i.test(loc.rel ?? '')) {
    console.log(`${basename(rel)} 已經搬到 docs/升級摘要/（做完了），不能拿來施工。${notDone}`);
    return 1;
  }
  const cl = readChecklist(loc.found === 'here' ? loc.file : loc.mainFile);
  if (!cl.parsed) {
    console.log(`${loc.rel} 裡讀不出任何一條 AC（要有「**AC-1　標題**」那種格式的行），不算規格。`);
    console.log(`   還沒有規格的話，跑 ${stageName}。`);
    return 1;
  }
  // 只做其中幾條(AC-8):代號要真的在這份裡——打錯一個字,收工 hook 就會要求一條不存在的 AC
  const acs = [];
  for (const a of rest) {
    const m = String(a).trim().match(/^AC-?(\d+)$/i);
    const id = m ? `AC-${Number(m[1])}` : null;
    if (!id || !cl.items.some((it) => it.id === id)) {
      console.log(`${loc.rel} 裡沒有「${a}」。這份的 AC 是：${cl.items.map((it) => it.id).join('、')}`);
      return 1;
    }
    if (!acs.includes(id)) acs.push(id);
  }
  // 這個對話自己寫的規格不收(AC-4):那是寫規格那一關的工作,跑那一關它會自己連上寫的檔。
  // 只看這一手的紀錄(規格:新對話接手舊資料夾):上一手不算「這個工作區還有別的對話」
  const self = writtenHere(ctx, { ...ev, events: tenureOfCtx(ctx, ev).events }, loc, sid, stages);
  if (self) {
    const cmd = first ? commandFor(first.skill, ctx.root, ctx.mainRoot, pluginName(HERE)) : null;
    console.log(`${loc.rel} 看起來是這個對話自己寫的（${self}）——那是 ${stageName} 的工作，${cmd ? `跑 ${cmd}` : `跑 ${stageName}`}（它會自己連上寫的那份）。`);
    return 1;
  }
  // 這個對話這一輪已經連著別份(AC-7,規格:多份規格與新資料夾的起點):一次只照一份,新記的會換掉舊的——換掉可以,安靜換掉不行。
  // 「現在連著哪一份」跟儀表板、收工 hook 同一個算法(stageFacts 的 roundView),不在這裡另算一份(老毛病 P2)
  //   這一輪自己叫 A 寫了規格、又 --spec 別份,也是換掉(魔鬼教官第一輪)。算不出來就不講(不猜有沒有換掉)
  let before = [], own = false;
  try {
    const v = stageFacts(ctx, ev, gatherChange(ctx, ev)).view;
    const a = v.stages.find((x) => x.skill);
    own = !v.link && !!a?.ranAt;
    before = v.link?.name ? [v.link.name] : !own ? [] : a.specPlaces?.length ? a.specPlaces.map((x) => x.name) : a.specPlace?.name ? [a.specPlace.name] : [];
  } catch { before = []; }
  if (!record({ spec: loc.rel, ...(acs.length ? { acs } : {}) })) return 1;
  const name = basename(loc.rel).replace(/\.md$/i, '');
  const replaced = before.length && !before.includes(name)
    ? `   ⚠️ 原本照 ${before.map((n) => `${n}.md`).join('、')}${own ? '（這個對話叫 A 寫的）' : ''}，換成照 ${name}.md——之後儀表板、收工 hook 只對 ${name} 的清單；一個對話一次只照一份規格。` : null;
  if (loc.found === 'main') {
    // 只在主資料夾:儀表板只寫一句、不畫清單、收工不要求打勾(AC-6)——第一行就照實講,不先說「會畫出 N 條」
    console.log(`✅ 記下了：這個對話照 ${name} 施工（Claude 說的）。`);
    console.log(`   ⚠️ 規格在主資料夾，不在這個工作區（可能還沒併進來）——儀表板只寫這一句、不畫那 ${cl.total} 條，收工時也不會叫你去主資料夾打勾。`);
  } else {
    console.log(`✅ 記下了：這個對話照 ${name} 施工（Claude 說的）。儀表板的 ${stageName} 會畫出那份的 ${cl.total} 條 AC。`);
    console.log(`   收工前在 ${loc.rel} 每條 AC 的標題行末尾標「✅ 對過 日期」或「⏳ 待討論：原因」。`);
  }
  if (replaced) console.log(replaced);
  if (acs.length) console.log(`   這一批只對 ${acs.join('、')}；其他條標「不在這一批」，收工前不要求。`);
  tail();
  return 0;
}

/**
 * 這份規格是不是這個對話自己寫的(施工對話認規格 AC-4)。是 → 回一句白話的證據;不是、或分不出來 → null。三種證據,任一種就算:
 *   ① 感測器記到這個對話在**這個工作區**Write 過同名的規格,而且在它第一次連上這份**之前**
 *      (連上之後的 Write 是打勾、搬家;別的資料夾的同名檔——例如審查員在暫存資料夾造的——都不算)
 *   ② 這個對話的寫規格那一關收尾記了這份(--report A ok <路徑>):用 Bash 寫的規格,這是紀錄裡看得到的線索
 *   ③ 這個工作區只有這個對話在用,而 main 上沒有這個名字的規格——那就是在這裡新寫出來的(還沒存,或只存在這條分支上)
 * ⚠️ 以前只看 Write:用 Bash 寫的自家規格會被收下,畫面還寫「別的對話寫的」;同名的暫存檔又會誤擋(魔鬼教官 2026-09-21,老毛病 P6、P4、L8)。
 * 分不出是哪個對話(沒有代號、工作區有好幾個對話)就不擋:寧可收下一份來歷不明的,也不擋掉別的對話寫好的那份——畫面標「Claude 說的」。
 */
function writtenHere(ctx, ev, loc, sid, stages) {
  if (loc.found !== 'here') return null;   // 只在主資料夾的:這個工作區裡沒有人寫它
  const name = basename(loc.rel);
  const here = ev.events.filter((e) => e.cwd === ctx.root);
  const sessions = new Set(here.filter((e) => e.hook && e.session).map((e) => e.session));
  const me = sid ?? (sessions.size === 1 ? [...sessions][0] : null);
  if (me) {
    const firstLink = here.filter((e) => e.event === 'spec_link' && e.by_session === me && basename(String(e.spec ?? '')) === name)
      .map((e) => Date.parse(e.ts)).sort((a, b) => a - b)[0] ?? Infinity;
    const inWs = (f) => typeof f === 'string' && f.startsWith(`${ctx.root}/docs/`) && basename(f) === name;
    if (ev.events.some((e) => e.session === me && e.hook === 'PostToolUse' && e.tool === 'Write' && inWs(e.file) && Date.parse(e.ts) < firstLink)) {
      return '感測器記到這個對話寫過它';
    }
    const first = stages.find((x) => x.skill);
    if (first) {
      // 一筆結論屬於它之前最後一次被叫的那一關(跟 roundView 認 A 寫了哪份同一種認法)
      const aRuns = runsPerStage(ev.events, stages, (e) => e.cwd === ctx.root).get(first.id) ?? [];
      for (const r of here.filter((e) => e.event === 'stage_report' && e.stage === first.id && typeof e.note === 'string')) {
        // 一次 A 寫了好幾份就記好幾份(規格:多份規格與新資料夾的起點 AC-1):說明裡每一個規劃中／進行中的路徑都看——
        // 跟 roundView 認「A 寫了哪幾份」同一個抽法(specPathsInNote);一個都抽不到才照以前的規則(整份說明就是一個 .md)
        const txt = reportText(r), named = specPathsInNote(txt);
        if (!(named.length ? named.some((x) => basename(x) === name) : basename(txt.trim()) === name)) continue;
        const run = aRuns.filter((x) => Date.parse(x.ts) <= Date.parse(r.ts)).at(-1);
        if (run?.session === me) return `這個對話的 ${first.id} ${first.name} 收尾記了它`;
      }
    }
  }
  if (sessions.size && [...sessions].every((x) => x === me)) {
    const mainRef = ['main', 'master'].find((m) => git(['rev-parse', '--verify', '-q', m], ctx.root));
    const tree = mainRef ? git(['ls-tree', '-r', '--name-only', mainRef, '--', 'docs'], ctx.root) : null;
    // 問不到 main 的內容就不下結論(R1:沒問到不當沒有)
    if (tree !== null && mainRef) {
      const onMain = tree.split('\n').some((f) => /^docs\/(規劃中|進行中|升級摘要)\//.test(f) && basename(f) === name);
      if (!onMain) return 'main 上沒有這份，是在這個工作區新寫出來的，而這個工作區只有這個對話在用';
    }
  }
  return null;
}

/**
 * --report <關> <ok|found> "<說明>":Claude 把一關的結論記給儀表板(五關自動結案 AC-7、AC-8)。
 * ⚠️ 這是「Claude 說的」,不是人驗證的——事件標 source:'claude',畫面照實標「Claude 說」(R2 在這個設計裡的位置)。
 *    ok = 沒問題／列好了(C 列了建議、D 沒找到) → 這關結案;found = 找到問題 → 還沒結案,修完再跑一次再記。
 */
async function doReport(ctx, stageId, verdict, note) {
  const { stages } = loadStages(HERE, ctx.root, ctx.mainRoot);
  const st = stages.find((x) => x.id.toLowerCase() === String(stageId ?? '').toLowerCase());
  if (!st) {
    console.log(`認不出關卡「${stageId ?? ''}」。這個專案的關卡是：${stages.map((x) => x.id).join(' / ')}`);
    return 1;
  }
  if (!st.skill) { console.log(`${st.id} ${st.name} 不是指令關,沒有結論可以記。`); return 1; }
  if (!['ok', 'found'].includes(verdict)) {
    console.log('結論只有兩種：ok（沒問題／列好了）或 found（找到問題）。例：  pipeline-status --report D found "找到 3 條"');
    return 1;
  }
  // 說明放得下一張清單(C 的建議、D 的發現,一行一條)。單行紀錄要遠小於 4096 bytes(感測器 AC-4)——
  // 算 bytes 不算字(中文一個字 3 bytes)。太長不截:整份另存一個檔,紀錄裡留第一行與檔名,「有幾條就列幾條」(Oscar 2026-09-16)
  let text = String(note ?? '').trim();
  // E 驗收(瀏覽器那一關):一行一條「AC-n 看到了／沒看到／驗不了」(E 自動驗收 AC-1)。有沒看到的卻記 ok,等於把「找到問題」講成「沒問題」——不收
  const walk = st.type === 'browser' ? parseWalk(text) : null;
  if (walk) {
    // 每一行都算:同一條先寫沒看到、後寫看到了,「沒看到」照樣算數(魔鬼教官第一輪:以前只看最後那一次,拒收被繞過)
    const miss = [...new Set(walk.all.filter((x) => x.verdict === 'missing').map((x) => x.id))];
    if (verdict === 'ok' && miss.length) {
      console.log(`${miss.join('、')} 寫的是「沒看到」——有沒看到的，結論要記 found：  pipeline-status --report ${st.id} found "…"`);
      return 1;
    }
  }
  let noteFile = null;
  if (Buffer.byteLength(text, 'utf8') > MAX_NOTE_BYTES) {
    try {
      const dir = join(LOG_DIR, 'reports');
      makeDataDir(dir);
      noteFile = join(dir, `${safeName(ctx.project)}__${Date.now().toString(36)}__${st.id}.txt`);
      writeFileSync(noteFile, text + '\n');
      text = cutBytes(text.split('\n')[0], 600);
    } catch (e) {
      console.log(`❌ 清單太長又存不了檔：${e.message}`);
      return 1;
    }
  }
  // 對話代號(Claude Code 給指令的環境變數):「叫 → 結論」配對時不把別的對話的結論配給這個對話(D 多輪先問人,Oscar 2026-09-22 決定記)。
  // 欄位刻意不叫 session:讀紀錄的程式會把帶 session 的每一筆都當成那個對話的活動(跟 --spec 同一個理由)
  const sid = sessionFromEnv();
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'stage_report', stage: st.id, verdict, note: text || null, noteFile, ...(sid ? { by_session: sid } : {}),
      cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'claude',
    }) + '\n');
  } catch (e) {
    console.log(`❌ 沒記成功：${e.message}`);
    return 1;
  }
  if (walk) {
    // E:講的是走了一遍、每條看到什麼,不是「沒問題」;驗收過了只有使用者能說(AC-3)。
    // 那一句跟儀表板 E 那一格同一句(記完再算一次,拿這一輪要驗的條目來對):以前這裡只數回報的行,漏報的那一條不見(魔鬼教官第一輪,P2)
    const f = await rerunFacts(ctx, readEvents(LOG_DIR, ctx.project)).catch(() => null);
    const ev2 = f?.view.stages.find((x) => x.id === st.id) ?? null;
    const el = ev2 ? eLines(ev2, { ago }) : null;
    console.log(`✅ 記下了：${el?.walk && /走了一遍/.test(el.walk) ? el.walk : `Claude 說 ${st.id} ${st.name}走了一遍（${summaryLine(walkSummary(walk))}）`}`);
    if (!walk.items.length) console.log('   ⚠️ 說明裡沒有一條照格式寫（AC-1 看到了：「畫面上的原文」／AC-2 沒看到：…／AC-3 驗不了：原因）——儀表板只能講「分不出看了哪幾條」。');
    const bare = walk.items.filter((x) => x.verdict === 'saw' && !x.quoted).map((x) => x.id);
    if (bare.length) console.log(`   ⚠️ ${bare.join('、')} 寫看到了，卻沒附畫面上的原文（「」裡的字）——儀表板會照實標「沒附畫面上的原文」。`);
    if (noteFile) console.log(`   清單很長,整份存在 ${noteFile.split('/').slice(-2).join('/')},儀表板會一條一條列出來。`);
    console.log('   ⚠️ 這是「Claude 說的」，不是驗收過了——驗收過了只有使用者能說（儀表板 E 那一格的按鈕）。');
    return 0;
  }
  console.log(`✅ 記下了：Claude 說 ${st.id} ${st.name} ${verdict === 'ok' ? '沒問題' : '找到問題'}${text ? `（${text.split('\n')[0]}）` : ''}`);
  if (noteFile) console.log(`   清單很長,整份存在 ${noteFile.split('/').slice(-2).join('/')},儀表板會一條一條列出來。`);
  console.log('   ⚠️ 這是「Claude 說的」,不是人驗證的——畫面上會照實標「Claude 說」。');
  return 0;
}

/**
 * --suggest "標題"(說明從標準輸入讀):Claude 建議「另開一個對話做這件事」,寫成一張卡放在儀表板上。
 * ⚠️ 儀表板開不了對話。卡片只能讓人複製說明、貼進新對話的第一句;「已開始」看的是有沒有對話真的這樣開頭。
 *    說明要限長:紀錄檔單行要遠小於 4096 bytes(AC-4),太長會跟感測器同時寫的那一筆交錯。
 */
function doSuggest(ctx, title, prompt) {
  if (!title?.trim()) { console.log('要一個標題：  pipeline-status --suggest "標題" < 說明檔'); return 1; }
  const body = String(prompt ?? '').trim();
  if (!body) { console.log('說明是空的。把說明餵進標準輸入：  pipeline-status --suggest "標題" <<\'EOF\' … EOF'); return 1; }
  // 算 bytes 不算字:中文一個字 3 bytes,以前用字數算,3000 個中文字就是 9000 bytes,早就超過單行的上限了
  const cut = Buffer.byteLength(body, 'utf8') > MAX_NOTE_BYTES;
  const kept = cut ? cutBytes(body, MAX_NOTE_BYTES) : body;
  const id = `sg-${Date.now().toString(36)}`;
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'suggestion', id, title: title.trim().slice(0, 80), prompt: kept,
      cwd: ctx.mainRoot ?? ctx.root, source: 'claude',
      // 截過要記在紀錄裡:儀表板才標得出「已截短」,不然半段說明會被當成全文(感測器記的 app 建議卡也有同一種記號)
      ...(cut ? { cut: true } : {}),
    }) + '\n');
  } catch (e) {
    console.log(`❌ 沒記成功：${e.message}`);
    return 1;
  }
  console.log(`✅ 放上儀表板了：「${title.trim().slice(0, 80)}」（${ctx.project} 的案件頁,「建議新增的對話」那一區）`);
  if (cut) console.log('   ⚠️ 說明太長,只留前面一段（單行紀錄有上限）。');
  return 0;
}

// 給 status.mjs 拿。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  doClear, doSpec, doReport, doSuggest,
};
