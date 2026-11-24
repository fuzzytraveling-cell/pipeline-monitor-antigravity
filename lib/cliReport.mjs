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
import { safeName, logFileOf } from './events.mjs';
import { loadEvents } from './transcript.mjs';
import { loadStages, runsPerStage, reportText, noWords, isWriteEvent, isAi } from './rounds.mjs';
import { eLines, parseWalk, walkSummary, summaryLine } from './verify.mjs';
import { readChecklist, locateSpec, specPathsInNote, isSpecPath } from './checklist.mjs';
import { commandFor, pluginName } from './skills.mjs';
import { HERE, LOG_DIR, tenureOfCtx, gatherChange, stageFacts, sessionFromEnv, rerunFacts, MAX_NOTE_BYTES, cutBytes } from './cliFacts.mjs';
import { zhEn, plural, SPEC_FOLDERS, specDirNames } from './lang.mjs';

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
    console.log(zhEn(`${st.id} ${st.name} 現在由儀表板自動辨識,不用你按。${e ? `只有 ${e.id} ${e.name} 由你說：  agy-pipeline --clear ${e.id}` : ''}`,
      `The dashboard now recognizes ${st.id} ${st.name} by itself, so there's nothing for you to do.${e ? ` Only ${e.id} ${e.name} is yours to say:  agy-pipeline --clear ${e.id}` : ''}`));
    return 1;
  }
  const sid = sessionFromEnv();
  const quote = words.join(' ').trim();
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'stage_cleared', stage: st.id,
      cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'human',
      ...(sid ? { via: 'ai', by_session: sid, ...(quote ? { quote: cutBytes(quote, 600) } : {}) } : {}),
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
    console.log(zhEn(`✅ 記下了：${st.id} ${st.name}過了（在對話裡跑的）。`, `✅ Recorded: ${st.id} ${st.name} accepted (run inside a conversation).`));
    console.log(zhEn('   是你自己在對話框用 ! 跑的：儀表板認得是你（感測器會記下你打的那一句），算你說的。',
      '   If you ran it yourself with ! in the chat box: the dashboard recognizes it\'s you (the sensor records the line you typed), so it counts as yours.'));
    console.log(zhEn(`   是 AI 替使用者記的：要附上使用者的原話（agy-pipeline --clear ${st.id} "使用者的原話"）——沒附、而且 ${st.id} 之後紀錄裡沒有他說的話，這筆不算數。`,
      `   If the AI recorded it for the user: the user's own words have to be attached (agy-pipeline --clear ${st.id} "the user's own words"); without them, and with nothing the user said after ${st.id} in the records, this one doesn't count.`));
    return 0;
  }
  // 記完再算一次:講清楚這筆算不算數、畫面會附哪一句(合併最新 transcript.jsonl)
  const f = await rerunFacts(ctx, loadEvents(LOG_DIR, ctx.project, { sessionId: sid, cwd: ctx.root }));
  const a = f?.view.stages.find((x) => x.id === st.id)?.accept ?? null;
  console.log(zhEn(`✅ 記下了：使用者說 ${st.id} ${st.name}過了（AI 代記）。`, `✅ Recorded: the user said ${st.id} ${st.name} is accepted (AI recorded it for them).`));
  if (a?.valid && isAi(a.by)) {
    const chars = [...String(a.said.text).replace(/\s+/g, ' ')];
    const t = `${chars.slice(0, 60).join('')}${chars.length > 60 || a.said.cut ? '…' : ''}`;
    if (a.said?.via === 'ask_question') {
      console.log(zhEn(`   儀表板附的是 ${st.id} 之後使用者在選項卡點的回覆：「${t}」——對得上就是他點的。`,
        `   The dashboard attaches the user's last option-card reply after ${st.id}: “${t}”; if it matches, that's what they chose.`));
    } else {
      console.log(zhEn(`   儀表板附的是 ${st.id} 之後使用者說的最後一句：「${t}」——對得上就是他說的。`, `   The dashboard attaches the last thing the user said after ${st.id}: “${t}”; if it matches, that's what they said.`));
    }
  } else if (a?.valid) console.log(zhEn(`   （這一輪 ${st.id} 已經有使用者自己說的驗收，照舊算那一筆。）`, `   (This round's ${st.id} already has an acceptance the user said themselves; that one still counts.)`));
  else if (a?.rejected) console.log(zhEn(`   ⚠️ 這筆不算數：${st.id} 之後，${noWords(a.rejected.odd)}——分不出是不是使用者說的。儀表板照實這樣講。`, `   ⚠️ This one doesn't count: after ${st.id}, ${noWords(a.rejected.odd)}, so it can't tell whether the user said it. The dashboard says exactly that.`));
  else console.log(zhEn('   ⚠️ 找不到這一輪從哪開始——這筆分不出是不是這一輪的，儀表板不會算它。', '   ⚠️ Can\'t find where this round started, so it can\'t tell whether this one belongs to this round; the dashboard won\'t count it.'));
  console.log(zhEn('   ⚠️ 這是「使用者說的、AI 代記的」，不是系統驗證的——畫面上會照實這樣寫。', '   ⚠️ This is "what the user said, recorded by AI", not something the system checked — the screens will say exactly that.'));
  return 0;
}

function doSpec(ctx, ev, args) {
  const [target, ...rest] = args;
  if (!target?.trim()) {
    console.log(zhEn('要一份規格檔：  agy-pipeline --spec docs/進行中/<名字>.md', 'Give a spec file:  agy-pipeline --spec docs/in-progress/<name>.md'));
    console.log(zhEn('   只做其中幾條就在後面加代號（例：--spec docs/進行中/<名字>.md AC-1 AC-2）；沒有照哪份規格就 --spec 無',
      '   To do only some items, add their IDs after it (e.g. --spec docs/in-progress/<name>.md AC-1 AC-2); if you aren\'t following any spec: --spec none'));
    return 1;
  }
  const sid = sessionFromEnv();
  const { stages } = loadStages(HERE, ctx.root, ctx.mainRoot);
  const first = stages.find((x) => x.skill);
  const stageName = first ? `${first.id} ${first.name}` : zhEn('寫規格那一關', 'the spec stage');
  const record = (extra) => {
    try {
      appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
        ts: new Date().toISOString(), event: 'spec_link', ...extra, ...(sid ? { by_session: sid } : {}),
        cwd: ctx.root, main: ctx.mainRoot ?? null, head: ctx.head?.slice(0, 7), source: 'ai',
      }) + '\n');
      return true;
    } catch (e) { console.log(notRecorded(e)); return false; }
  };
  const tail = () => {
    if (!sid) {
      console.log(zhEn('   （拿不到這個對話的代號：這個工作區只有一個對話時，儀表板才算得出是它記的；有別的對話來過就不歸給任何對話、也不擋。）',
        '   (No ID for this conversation: the dashboard can only work out that this conversation recorded it when this workspace has just one conversation; if another one has been here, it isn\'t credited to any conversation and nothing is blocked.)'));
    }
  };

  if (['無', 'none'].includes(target.trim())) {
    if (!record({ spec: null, none: true })) return 1;
    console.log(zhEn('✅ 記下了：這個對話沒有照別的對話寫的規格施工（AI 說的）。', '✅ Recorded: this conversation isn\'t following a spec another conversation wrote (AI says so).'));
    console.log(zhEn(`   從第一句話來的提示會消失；這次改動的分級要 ${stageName} 的話，收工前還是會要求跑。`,
      `   The hint from the first message goes away; if this change's tier needs ${stageName}, it will still be required before wrapping up.`));
    tail();
    return 0;
  }

  // 英文那一句兩套資料夾都講(兩套都收);中文那一句照舊(一字不差)
  const notDone = zhEn(`只收還沒做完的規格：這個工作區 docs/規劃中/ 或 docs/進行中/ 底下的 .md。`,
    `Only specs that aren't done yet: a .md under docs/planned/ or docs/in-progress/ (or docs/${SPEC_FOLDERS.planned.zh}/, docs/${SPEC_FOLDERS.doing.zh}/) in this workspace.`);
  // 工作區的根是 git 給的真實路徑;給的路徑也解析成真實路徑再比(macOS 的暫存資料夾、捷徑都會讓兩種拼法對不上)。
  // 檔案不在工作區(只在主資料夾)就解析它所在的資料夾。
  // 相對路徑先照指令列所在的位置解;解出來不在這個工作區的 docs/ 底下,再照工作區的根解——從子資料夾跑也認得(魔鬼教官 2026-09-21)
  const relOf = (p) => { const abs = real(p) !== p ? real(p) : join(real(dirname(p)), basename(p)); return relative(ctx.root, abs).split('\\').join('/'); };
  let rel = relOf(isAbsolute(target) ? target : resolve(process.cwd(), target));
  if (!isAbsolute(target) && !/^docs\//i.test(rel)) rel = relOf(resolve(ctx.root, target));
  // 規格資料夾中英兩套都認(規格:技能與寫給AI的話中英切換 AC-3;名字住 lib/lang.mjs 的 SPEC_FOLDERS)
  if (isSpecPath(rel, ['done'])) {
    // 資料夾照它真的在的那一個印(中英兩套都認):以前寫死 docs/升級摘要/,英文那一套的 docs/done/ 也會被講成在升級摘要(魔鬼教官第一輪,P2)
    console.log(zhEn(`這份在 ${dirname(rel)}/，是已經做完的規格，不能拿來施工。${notDone}`, `This one is in ${dirname(rel)}/, so it's a spec that's already done and can't be built from. ${notDone}`));
    console.log(zhEn(`   要照它再改一輪的話，另寫一份新規格（跑 ${stageName}）。`, `   To change things again based on it, write a new spec (run ${stageName}).`));
    return 1;
  }
  if (!isSpecPath(rel, ['planned', 'doing'])) { console.log(zhEn(`認不得「${target}」。${notDone}`, `Can't tell what "${target}" is. ${notDone}`)); return 1; }
  const loc = locateSpec(rel, { root: ctx.root, mainRoot: ctx.mainRoot });
  if (loc.found === 'missing') {
    console.log(zhEn(`找不到 ${rel}（這個工作區和主資料夾的規劃中／進行中／升級摘要都沒有 ${basename(rel)}）。`,
      `Can't find ${rel} (none of the spec folders in this workspace or the main folder, ${specDirNames().join('/')}, has ${basename(rel)}).`));
    return 1;
  }
  if (loc.found === 'ambiguous') {
    console.log(zhEn(`這個工作區裡叫 ${basename(rel)} 的規格不只一份：${loc.where.join('、')}。給完整路徑。`, `There's more than one spec called ${basename(rel)} in this workspace: ${loc.where.join(', ')}. Give the full path.`));
    return 1;
  }
  if (loc.found === 'main' && !loc.mainFile) {
    console.log(zhEn(`主資料夾裡叫 ${basename(rel)} 的規格不只一份，分不出是哪一份。`, `There's more than one spec called ${basename(rel)} in the main folder, so it can't tell which one.`));
    return 1;
  }
  // 名字對上了,但它已經搬到升級摘要(做完了)
  if (!isSpecPath(loc.rel, ['planned', 'doing'], { sub: true })) {
    const doneDir = `${dirname(String(loc.rel ?? ''))}/`;
    console.log(zhEn(`${basename(rel)} 已經搬到 ${doneDir}（做完了），不能拿來施工。${notDone}`, `${basename(rel)} has already moved to ${doneDir} (it's done), so it can't be built from. ${notDone}`));
    return 1;
  }
  const cl = readChecklist(loc.found === 'here' ? loc.file : loc.mainFile);
  if (!cl.parsed) {
    console.log(zhEn(`${loc.rel} 裡讀不出任何一條 AC（要有「**AC-1　標題**」那種格式的行），不算規格。`,
      `Not a single AC can be read from ${loc.rel} (it needs lines in the "**AC-1 Title**" format), so it doesn't count as a spec.`));
    console.log(zhEn(`   還沒有規格的話，跑 ${stageName}。`, `   If there's no spec yet, run ${stageName}.`));
    return 1;
  }
  // 只做其中幾條(AC-8):代號要真的在這份裡——打錯一個字,收工 hook 就會要求一條不存在的 AC
  const acs = [];
  for (const a of rest) {
    const m = String(a).trim().match(/^AC-?(\d+)$/i);
    const id = m ? `AC-${Number(m[1])}` : null;
    if (!id || !cl.items.some((it) => it.id === id)) {
      console.log(zhEn(`${loc.rel} 裡沒有「${a}」。這份的 AC 是：${cl.items.map((it) => it.id).join('、')}`, `${loc.rel} has no "${a}". This spec's ACs are: ${cl.items.map((it) => it.id).join(', ')}`));
      return 1;
    }
    if (!acs.includes(id)) acs.push(id);
  }
  // 這個對話自己寫的規格不收(AC-4):那是寫規格那一關的工作,跑那一關它會自己連上寫的檔。
  // 只看這一手的紀錄(規格:新對話接手舊資料夾):上一手不算「這個工作區還有別的對話」
  const self = writtenHere(ctx, { ...ev, events: tenureOfCtx(ctx, ev).events }, loc, sid, stages);
  if (self) {
    const cmd = first ? commandFor(first.skill, ctx.root, ctx.mainRoot, pluginName(HERE)) : null;
    console.log(zhEn(`${loc.rel} 看起來是這個對話自己寫的（${self}）——那是 ${stageName} 的工作，${cmd ? `跑 ${cmd}` : `跑 ${stageName}`}（它會自己連上寫的那份）。`,
      `${loc.rel} looks like this conversation wrote it itself (${self}). That's ${stageName}'s job: run ${cmd ?? stageName} (it links the spec it writes by itself).`));
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
    ? zhEn(`   ⚠️ 原本照 ${before.map((n) => `${n}.md`).join('、')}${own ? '（這個對話叫 A 寫的）' : ''}，換成照 ${name}.md——之後儀表板、收工 hook 只對 ${name} 的清單；一個對話一次只照一份規格。`,
      `   ⚠️ It was following ${before.map((n) => `${n}.md`).join(', ')}${own ? ' (written by this conversation\'s A)' : ''} and now follows ${name}.md: from now on the dashboard and the end-of-turn hook only check ${name}'s checklist; a conversation follows one spec at a time.`) : null;
  if (loc.found === 'main') {
    // 只在主資料夾:儀表板只寫一句、不畫清單、收工不要求打勾(AC-6)——第一行就照實講,不先說「會畫出 N 條」
    console.log(zhEn(`✅ 記下了：這個對話照 ${name} 施工（AI 說的）。`, `✅ Recorded: this conversation is building from ${name} (AI says so).`));
    console.log(zhEn(`   ⚠️ 規格在主資料夾，不在這個工作區（可能還沒併進來）——儀表板只寫這一句、不畫那 ${cl.total} 條，收工時也不會叫你去主資料夾打勾。`,
      `   ⚠️ The spec is in the main folder, not in this workspace (maybe not merged in yet): the dashboard only writes this line and doesn't draw those ${plural(cl.total, 'item')}, and wrapping up won't ask you to tick them in the main folder.`));
  } else {
    console.log(zhEn(`✅ 記下了：這個對話照 ${name} 施工（AI 說的）。儀表板的 ${stageName} 會畫出那份的 ${cl.total} 條 AC。`,
      `✅ Recorded: this conversation is building from ${name} (AI says so). The dashboard's ${stageName} will draw that spec's ${plural(cl.total, 'AC')}.`));
    console.log(zhEn(`   收工前在 ${loc.rel} 每條 AC 的標題行末尾標「✅ 對過 日期」或「⏳ 待討論：原因」。`,
      `   Before wrapping up, mark the end of every AC heading line in ${loc.rel} with "✅ ticked <date>" or "⏳ to discuss: <reason>".`));
  }
  if (replaced) console.log(replaced);
  if (acs.length) console.log(zhEn(`   這一批只對 ${acs.join('、')}；其他條標「不在這一批」，收工前不要求。`, `   This batch only checks ${acs.join(', ')}; the other items are marked "not in this batch" and aren't required before wrapping up.`));
  tail();
  return 0;
}

function writtenHere(ctx, ev, loc, sid, stages) {
  if (loc.found !== 'here') return null;   // 只在主資料夾的:這個工作區裡沒有人寫它
  const name = basename(loc.rel);
  const here = ev.events.filter((e) => !e._subagent && e.cwd === ctx.root);
  const sessions = new Set(here.filter((e) => e.hook && e.session).map((e) => e.session));
  const me = sid ?? (sessions.size === 1 ? [...sessions][0] : null);
  if (me) {
    const firstLink = here.filter((e) => e.event === 'spec_link' && e.by_session === me && basename(String(e.spec ?? '')) === name)
      .map((e) => Date.parse(e.ts)).sort((a, b) => a - b)[0] ?? Infinity;
    const inWs = (f) => typeof f === 'string' && f.startsWith(`${ctx.root}/docs/`) && basename(f) === name;
    if (ev.events.some((e) => e.session === me && isWriteEvent(e) && inWs(e.file) && Date.parse(e.ts) < firstLink)) {
      return zhEn('感測器記到這個對話寫過它', 'the sensor recorded this conversation writing it');
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
        if (run?.session === me) return zhEn(`這個對話的 ${first.id} ${first.name} 收尾記了它`, `this conversation's ${first.id} ${first.name} recorded it at the end`);
      }
    }
  }
  if (sessions.size && [...sessions].every((x) => x === me)) {
    const mainRef = ['main', 'master'].find((m) => git(['rev-parse', '--verify', '-q', m], ctx.root));
    const tree = mainRef ? git(['ls-tree', '-r', '--name-only', mainRef, '--', 'docs'], ctx.root) : null;
    // 問不到 main 的內容就不下結論(R1:沒問到不當沒有)
    if (tree !== null && mainRef) {
      const onMain = tree.split('\n').some((f) => isSpecPath(f, undefined, { sub: true }) && basename(f) === name);
      if (!onMain) return zhEn('main 上沒有這份，是在這個工作區新寫出來的，而這個工作區只有這個對話在用', 'main doesn\'t have it, so it was newly written in this workspace, and only this conversation uses this workspace');
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
    console.log(zhEn(`認不出關卡「${stageId ?? ''}」。這個專案的關卡是：${stages.map((x) => x.id).join(' / ')}`, `Can't tell which stage "${stageId ?? ''}" is. This project's stages are: ${stages.map((x) => x.id).join(' / ')}`));
    return 1;
  }
  if (!st.skill) { console.log(zhEn(`${st.id} ${st.name} 不是指令關,沒有結論可以記。`, `${st.id} ${st.name} isn't a command stage, so there's no conclusion to record.`)); return 1; }
  if (!['ok', 'found'].includes(verdict)) {
    console.log(zhEn('結論只有兩種：ok（沒問題／列好了）或 found（找到問題）。例：  agy-pipeline --report D found "找到 3 條"',
      'There are only two conclusions: ok (nothing found / the list is done) or found (problems found). Example:  agy-pipeline --report D found "Found 3"'));
    return 1;
  }
  let text = String(note ?? '').trim();
  const walk = st.type === 'browser' ? parseWalk(text) : null;
  if (walk) {
    const miss = [...new Set(walk.all.filter((x) => x.verdict === 'missing').map((x) => x.id))];
    if (verdict === 'ok' && miss.length) {
      console.log(zhEn(`${miss.join('、')} 寫的是「沒看到」——有沒看到的，結論要記 found：  agy-pipeline --report ${st.id} found "…"`,
        `${miss.join(', ')} ${miss.length === 1 ? 'says' : 'say'} "not seen": when anything wasn't seen, the conclusion must be found:  agy-pipeline --report ${st.id} found "…"`));
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
      console.log(zhEn(`❌ 清單太長又存不了檔：${e.message}`, `❌ The list is too long and couldn't be saved to a file: ${e.message}`));
      return 1;
    }
  }
  const sid = sessionFromEnv();
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'stage_report', stage: st.id, verdict, note: text || null, noteFile, ...(sid ? { by_session: sid } : {}),
      cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'ai',
    }) + '\n');
  } catch (e) {
    console.log(notRecorded(e));
    return 1;
  }
  if (walk) {
    const f = await rerunFacts(ctx, loadEvents(LOG_DIR, ctx.project, { sessionId: sid, cwd: ctx.root })).catch(() => null);
    const ev2 = f?.view.stages.find((x) => x.id === st.id) ?? null;
    const el = ev2 ? eLines(ev2, { ago }) : null;
    const sum = summaryLine(walkSummary(walk));
    console.log(el?.walk && el.walked ? zhEn(`✅ 記下了：${el.walk}`, `✅ Recorded: ${el.walk}`)
      : zhEn(`✅ 記下了：AI 說 ${st.id} ${st.name}走了一遍（${sum}）`, `✅ Recorded: AI says it walked through ${st.id} ${st.name} (${sum})`));
    if (!walk.items.length) {
      console.log(zhEn('   ⚠️ 說明裡沒有一條照格式寫（AC-1 看到了：「畫面上的原文」／AC-2 沒看到：…／AC-3 驗不了：原因）——儀表板只能講「分不出看了哪幾條」。',
        '   ⚠️ Not one line of the note is in the format (AC-1 seen: "the original text on the screen" / AC-2 not seen: … / AC-3 can\'t verify: reason), so the dashboard can only say it "can\'t tell which items were looked at".'));
    }
    const bare = walk.items.filter((x) => x.verdict === 'saw' && !x.quoted).map((x) => x.id);
    if (bare.length) {
      console.log(zhEn(`   ⚠️ ${bare.join('、')} 寫看到了，卻沒附畫面上的原文（「」裡的字）——儀表板會照實標「沒附畫面上的原文」。`,
        `   ⚠️ ${bare.join(', ')} ${bare.length === 1 ? 'says' : 'say'} seen but ${bare.length === 1 ? 'doesn\'t' : 'don\'t'} attach the original text from the screen (words in quotes), so the dashboard will mark ${bare.length === 1 ? 'it' : 'them'} "no original text from the screen attached".`));
    }
    if (noteFile) console.log(longNote(noteFile));
    console.log(zhEn('   ⚠️ 這是「AI 說的」，不是驗收過了——驗收過了只有使用者能說（儀表板 E 那一格的按鈕）。',
      '   ⚠️ This is "what AI says", not accepted: only the user can say it\'s accepted (the button in the dashboard\'s E cell).'));
    return 0;
  }
  const head = text ? text.split('\n')[0] : '';
  console.log(zhEn(`✅ 記下了：AI 說 ${st.id} ${st.name} ${verdict === 'ok' ? '沒問題' : '找到問題'}${text ? `（${head}）` : ''}`,
    `✅ Recorded: AI's conclusion for ${st.id} ${st.name} is ${verdict === 'ok' ? 'ok' : 'found problems'}${text ? ` (${head})` : ''}`));
  if (noteFile) console.log(longNote(noteFile));
  console.log(zhEn('   ⚠️ 這是「AI 說的」,不是人驗證的——畫面上會照實標「AI 說」。', '   ⚠️ This is "what AI says", not something a person checked: the screens will mark it "AI says" exactly that way.'));
  return 0;
}

/**
 * --precheck <ok|found> "<說明>":寫完規格後、寫程式前，魔鬼教官對規格本身跑一輪預審的獨立紀錄(event:'spec_precheck')。
 * 絕不寫入 stage_report，與程式 D 徹底隔離(P11)。ok 只證明「沒對到已知死法」，不說通過或沒問題(R2)。
 */
async function doPrecheck(ctx, ev, verdict, note) {
  if (!['ok', 'found'].includes(verdict)) {
    console.log(zhEn(
      '結論只有兩種：ok（沒對到已知死法）或 found（找到問題）。例：  agy-pipeline --precheck found "找到 2 條"',
      'There are only two conclusions: ok (didn\'t match any known failure pattern) or found (problems found). Example:  agy-pipeline --precheck found "Found 2"',
    ));
    return 1;
  }
  let text = String(note ?? '').trim();
  let noteFile = null;
  if (Buffer.byteLength(text, 'utf8') > MAX_NOTE_BYTES) {
    try {
      const dir = join(LOG_DIR, 'reports');
      makeDataDir(dir);
      noteFile = join(dir, `${safeName(ctx.project)}__${Date.now().toString(36)}__precheck.txt`);
      writeFileSync(noteFile, text + '\n');
      text = cutBytes(text.split('\n')[0], 600);
    } catch (e) {
      console.log(zhEn(`❌ 清單太長又存不了檔：${e.message}`, `❌ The list is too long and couldn't be saved to a file: ${e.message}`));
      return 1;
    }
  }
  let specs = null;
  try {
    const f = await rerunFacts(ctx, ev);
    const a = f?.view?.stages?.find((x) => x.skill) ?? null;
    const list = a?.specPlaces?.length
      ? a.specPlaces.map((p) => p.rel).filter(Boolean)
      : a?.specPlace?.rel ? [a.specPlace.rel]
      : a?.link?.rel ? [a.link.rel] : [];
    if (list.length) specs = list;
  } catch { specs = null; }
  const sid = sessionFromEnv();
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'spec_precheck', verdict, note: text || null, noteFile,
      ...(specs ? { specs } : {}), ...(sid ? { by_session: sid } : {}),
      cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'ai',
    }) + '\n');
  } catch (e) {
    console.log(notRecorded(e));
    return 1;
  }
  const head = text ? text.split('\n')[0] : '';
  console.log(zhEn(
    `✅ 記下了：AI 說 規格預審 ${verdict === 'ok' ? '沒對到已知死法' : '找到問題'}${text ? `（${head}）` : ''}`,
    `✅ Recorded: AI's conclusion for spec precheck is ${verdict === 'ok' ? 'didn\'t match any known failure pattern' : 'found problems'}${text ? ` (${head})` : ''}`,
  ));
  if (noteFile) console.log(longNote(noteFile));
  console.log(zhEn(
    '   ⚠️ 這是「AI 說的」，不是人驗證的——畫面上會照實標「AI 說」，也不算程式 D。',
    '   ⚠️ This is "what AI says", not something a person checked: the screens will mark it "AI says" and it doesn\'t count as code D.',
  ));
  return 0;
}

function doSuggest(ctx, title, prompt) {
  if (!title?.trim()) { console.log(zhEn('要一個標題：  agy-pipeline --suggest "標題" < 說明檔', 'Give a title:  agy-pipeline --suggest "title" < brief-file')); return 1; }
  const body = String(prompt ?? '').trim();
  if (!body) {
    console.log(zhEn('說明是空的。把說明餵進標準輸入：  agy-pipeline --suggest "標題" <<\'EOF\' … EOF', 'The brief is empty. Feed it through standard input:  agy-pipeline --suggest "title" <<\'EOF\' … EOF'));
    return 1;
  }
  const cut = Buffer.byteLength(body, 'utf8') > MAX_NOTE_BYTES;
  const kept = cut ? cutBytes(body, MAX_NOTE_BYTES) : body;
  const id = `sg-${Date.now().toString(36)}`;
  const sid = sessionFromEnv();
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'suggestion', id, title: title.trim().slice(0, 80), prompt: kept,
      cwd: ctx.mainRoot ?? ctx.root, ...(sid ? { by_session: sid } : {}), source: 'ai',
      ...(cut ? { cut: true } : {}),
    }) + '\n');
  } catch (e) {
    console.log(notRecorded(e));
    return 1;
  }
  const t = title.trim().slice(0, 80);
  console.log(zhEn(`✅ 放上儀表板了：「${t}」（${ctx.project} 的案件頁,「建議新增的對話」那一區）`, `✅ Put on the dashboard: “${t}” (${ctx.project}'s project page, in the "suggested new conversations" section)`));
  if (cut) console.log(zhEn('   ⚠️ 說明太長,只留前面一段（單行紀錄有上限）。', '   ⚠️ The brief is too long, so only the first part is kept (a single record line has a limit).'));
  return 0;
}

/** 記不了紀錄那一句(--spec、--report、--suggest 同一句;--clear 的照舊寫在它自己那裡)。e.message 是程式的錯誤原文,照舊印——記不成要大聲 */
const notRecorded = (e) => zhEn(`❌ 沒記成功：${e.message}`, `❌ Couldn't record it: ${e.message}`);
/** 清單太長、整份另存一個檔那一句 */
const longNote = (noteFile) => zhEn(`   清單很長,整份存在 ${noteFile.split('/').slice(-2).join('/')},儀表板會一條一條列出來。`,
  `   The list is long, so all of it is saved in ${noteFile.split('/').slice(-2).join('/')}; the dashboard lists it item by item.`);

// 給 status.mjs 拿。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  doClear, doSpec, doReport, doPrecheck, doSuggest,
};
