/**
 * cliTier.mjs —— 分級:畫面最下面的分級卡,與 --tier-init／--tier-off／--tier-review／--tier-checked／--tier-later／--tier／--tier-retract。
 * 規格:分級、危險清單會過期、收工hook問危險清單、終端機照指令拆開(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-07 從 status.mjs 原封不動搬過來。分級怎麼算在 lib/tier.mjs,這裡只印與寫。這一輪的分級(tierOf)住 cliFacts.mjs:
 * 「要不要再跑」也要它,放在這裡就會跟 cliFacts 繞成一圈。只從 cliFacts.mjs 拿東西。
 * 中英切換(規格:儀表板與終端機中英切換、技能與寫給AI的話中英切換):每一個指令都照這一次輸出的語言——
 * 分級卡、--tier、--tier-retract 是你自己看的;--tier-init／off／review／checked／later 是 Claude 替你跑的,Claude 讀的字也跟著換。
 */
import { appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gitExit, ago } from './git.mjs';
import { logFileOf } from './events.mjs';
import { loadEvents } from './transcript.mjs';
import { readProjectConfig, isAi } from './rounds.mjs';
import {
  readTierConfig, writeTierConfig, proposeCodeArea, codeFileFn, computeTier, dangerSince, addedSince, missingDanger, checkSnapshot,
  laterOf, committedDanger, setupHint, emptyDangerLine, tierLines,
} from './tier.mjs';
import { HERE, LOG_DIR, sessionFromEnv, rerunFacts, cutBytes, tierOf } from './cliFacts.mjs';
import { zhEn, plural } from './lang.mjs';

/* ══════════════════════════ 分級（lib/tier.mjs 算,這裡只印與寫） ══════════════════════════ */

/**
 * 分級那一段。純函式,吃 buildTier() 的物件,被 scripts/tier.test.mjs 釘住。
 * 字住 lib/tier.mjs 的 tierLines(儀表板的分級卡印同一句;規格:終端機與網頁說同一句),這裡只管縮排、「需要：」那一欄、調高與收回的指令(AC-4)。
 */
function describeTier(t) {
  const q = tierLines(t, { ago });
  const L = [];
  if (t.state === 'unset') {
    L.push(zhEn('   還沒設定分級。', '   Tiers aren\'t set up yet.'), `   ${q.setupHint}`, zhEn('   （或自己來：agy-pipeline --tier-init）', '   (or do it yourself: agy-pipeline --tier-init)'));
    return L;
  }
  if (t.state === 'broken') {
    L.push(`   ⚠️ ${q.main}`, `      ${q.tail}`);   // R1:讀不懂 ≠ 沒設定 ≠ T0
    return L;
  }
  if (t.state !== 'ok') {
    for (const line of [q.main, q.tail, q.emptyWarn]) if (line) L.push(`   ${line}`);
    return L;
  }
  const { manual, final } = t;
  L.push(manual ? `   ${q.main}` : zhEn(`   ${final.id}（${q.why}）`, `   ${final.id} (${q.why})`));
  for (const line of [q.blind, q.ignored]) if (line) L.push(`   ${line}`);
  if (q.reqs.length) {
    L.push(zhEn('   需要：', '   Needs:'));
    // 中文拿全形空白對齊;英文用半形空白,英文那一頁不准有全形符號
    for (const r of q.reqs) L.push(`        ${zhEn(r.label.padEnd(8, '　'), r.label.padEnd(16, ' '))} ${r.mark} ${r.text}`);
  }
  for (const line of [q.emptyWarn, q.candidates]) if (line) L.push(`   ${line}`);
  // 危險清單可能過期了(規格:危險清單會過期):句子在 lib/tier.mjs 算好,網頁照印同一句(老毛病 P2)
  for (const line of t.staleNotes ?? []) L.push(`   ${line}`);
  L.push(`   ${q.upOnly}`);
  if (manual) L.push(zhEn('   收回你調的：agy-pipeline --tier-retract', '   To take back what you raised: agy-pipeline --tier-retract'));
  else if (t.upgradable.length) L.push(zhEn(`   要調高：agy-pipeline --tier ${t.upgradable[0]} "理由"`, `   To raise it: agy-pipeline --tier ${t.upgradable[0]} "reason"`));
  return L;
}

function renderTier(ctx, ev, info, facts) {
  console.log(zhEn('\n━━ 分級 ━━', '\n━━ Tier ━━'));
  for (const line of describeTier(tierOf(ctx, ev, info, facts))) console.log(line);
}

/** 人蓋的章(結案、調高分級),全部走這裡:同一份 append-only 紀錄,標明 source:'human'。 */
function appendHuman(ctx, obj) {
  appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
    ts: new Date().toISOString(), ...obj, cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'human',
  }) + '\n');
}

const isIgnored = (root, file) => gitExit(['check-ignore', '-q', file], root) === 0;

/** 設定檔寫不進去那一句(--tier-init／off／checked 同一句)。原因是 writeTierConfig 給的 */
const writeFailed = (r) => zhEn(`❌ ${r.why}（${r.path}）`, `❌ ${r.why} (${r.path})`);

/** --tier-init [資料夾…]:提議程式區、寫出骨架(危險清單空的)。已經設定過就只回報。 */
function doTierInit(ctx, dirs) {
  const cfg = readTierConfig(ctx.root, ctx.mainRoot, HERE);
  if (cfg.state === 'broken') {
    console.log(zhEn(`⚠️ 分級設定讀不懂（${cfg.from}）：${cfg.why}。先修好那個檔案,這次不動它。`,
    `⚠️ Can't read the tier setting (${cfg.from}): ${cfg.why}. Fix that file first; it's left alone this time.`));
    return 1;
  }
  if (cfg.state === 'ok') {
    console.log(zhEn(`已經設定過了（${cfg.from}）：程式區 ${cfg.config.code.join('、')}；危險清單 ${cfg.config.danger.length} 個。`,
      `Already set up (${cfg.from}): code area ${cfg.config.code.join(', ')}; ${plural(cfg.config.danger.length, 'file')} on the danger list.`));
    if (!cfg.config.danger.length) console.log(emptyDangerLine(cfg.config.levels.danger.id));   // 跟分級卡同一句(lib/tier.mjs)
    return 0;
  }
  const proposal = dirs.length
    ? { dirs: dirs.map((d) => `${d.replace(/^\.\//, '').replace(/\/+$/, '')}/`), why: zhEn('你指定的', 'you chose it') }
    : proposeCodeArea(ctx.root);
  if (!proposal) {
    console.log(zhEn('認不出這個專案的程式區（package.json 沒指向哪裡、也找不到放程式檔的資料夾）。',
      'Can\'t tell where this project\'s code area is (package.json doesn\'t point anywhere, and no folder of code files was found).'));
    console.log(zhEn('   自己指定：  agy-pipeline --tier-init src/', '   Choose it yourself:  agy-pipeline --tier-init src/'));
    return 1;
  }
  const existingInRoot = !existsSync(join(ctx.root, '.agents', 'pipeline-stages.json')) && existsSync(join(ctx.root, '.claude', 'pipeline-stages.json'))
    ? join(ctx.root, '.claude', 'pipeline-stages.json') : null;
  const r = writeTierConfig(ctx.root, { code: proposal.dirs, danger: [] }, existingInRoot);
  if (!r.ok) { console.log(writeFailed(r)); return 1; }
  console.log(zhEn(`✅ 寫好了：${r.path}`, `✅ Written: ${r.path}`));
  console.log(zhEn(`   程式區：${proposal.dirs.join('、')}（${proposal.why}）——不對的話直接改那個檔的 tiers.code`,
    `   Code area: ${proposal.dirs.join(', ')} (${proposal.why}); if that's wrong, edit tiers.code in that file directly`));
  console.log(zhEn('   危險清單：空的。⚠️ 所以永遠不會出現第三級——只有人判斷得了「改錯會不會靜默丟資料」。',
    '   Danger list: empty. ⚠️ So the third level will never come up: only a person can judge "would a mistake here silently lose data".'));
  console.log(`   ${setupHint()}`);
  const relCfg = existingInRoot ? '.claude/pipeline-stages.json' : '.agents/pipeline-stages.json';
  if (isIgnored(ctx.root, relCfg)) {
    console.log(zhEn('\n⚠️ 這個檔案被 .gitignore 擋著,**不會進版控**——換一台電腦、或在 worktree 裡,分級就不見了。',
      '\n⚠️ This file is blocked by .gitignore, so it **won\'t be in version control**: on another computer, or in a worktree, the tiers disappear.'));
    console.log(zhEn(`   分級是專案的政策,建議進版控：在 .gitignore 加一行  !${relCfg}`,
      `   Tiers are the project's policy, so putting them in version control is recommended: add this line to .gitignore  !${relCfg}`));
  }
  return 0;
}

function doTierOff(ctx, why) {
  const existingInRoot = !existsSync(join(ctx.root, '.agents', 'pipeline-stages.json')) && existsSync(join(ctx.root, '.claude', 'pipeline-stages.json'))
    ? join(ctx.root, '.claude', 'pipeline-stages.json') : null;
  const r = writeTierConfig(ctx.root, { off: true, at: new Date().toISOString(), why: why || null }, existingInRoot);
  if (!r.ok) { console.log(writeFailed(r)); return 1; }
  console.log(zhEn(`✅ 記下了：這個專案不分級${why ? `（${why}）` : ''}。對話開始時不會再提醒。`,
    `✅ Recorded: this project doesn't use tiers${why ? ` (${why})` : ''}. There won't be a reminder at the start of conversations any more.`));
  console.log(zhEn('   要恢復：  agy-pipeline --tier-init', '   To bring them back:  agy-pipeline --tier-init'));
  return 0;
}

/** 分級設定還沒好的時候,危險清單的兩個指令講同一句(不准當成「清單沒過期」)。 */
function tierNotReady(cfg) {
  console.log(cfg.state === 'unset' ? zhEn(`還沒設定分級,沒有危險清單可以看。${setupHint()}`, `Tiers aren't set up yet, so there's no danger list to look at. ${setupHint()}`)
    : cfg.state === 'off' ? zhEn('這個專案設定成不分級,沒有危險清單可以看。要恢復：agy-pipeline --tier-init',
      'This project is set to not use tiers, so there\'s no danger list to look at. To bring them back: agy-pipeline --tier-init')
    : zhEn(`分級設定讀不懂（${cfg.from ?? '.agents/pipeline-stages.json'}）：${cfg.why ?? ''}——沒有危險清單可以看。`,
      `Can't read the tier setting (${cfg.from ?? '.agents/pipeline-stages.json'}): ${cfg.why ?? ''}, so there's no danger list to look at.`));
  return 1;
}

/**
 * 整個專案:清單定好(或上一次判斷)之後才新加、不在清單上、現在還在的程式檔。問不到 git → null。
 * --tier-review 列的、--tier-checked 講「這一筆算判斷過的是哪幾個」,是同一份(老毛病 P2)。
 */
function freshInProject(ctx, c, since) {
  const added = addedSince(ctx.root, since);
  if (added === null) return null;
  const inArea = codeFileFn(ctx.root, c);
  return [...added].filter((f) => inArea(f) && computeTier([f], c).rank === 1 && existsSync(join(ctx.root, f))).sort();
}

/**
 * --tier-review:危險清單判斷用的事實(規格:危險清單會過期 AC-3)——清單定好(或判斷過)之後才新加、不在清單上的程式檔(整個專案,不只這一輪)、
 * 清單裡已經不在的。只列,不判斷:哪個危險是使用者決定(tier-setup 那個 skill 拿這份去問)。
 */
function doTierReview(ctx) {
  const cfg = readTierConfig(ctx.root, ctx.mainRoot, HERE);
  if (cfg.state !== 'ok') return tierNotReady(cfg);
  const c = cfg.config;
  const top = c.levels.danger.id;
  console.log(zhEn('━━ 危險清單 ━━', '━━ Danger list ━━'));
  console.log(c.danger.length ? zhEn(`   清單上 ${c.danger.length} 條：${c.danger.join('、')}`, `   ${plural(c.danger.length, 'entry', 'entries')} on the list: ${c.danger.join(', ')}`)
    : zhEn(`   清單是空的——永遠不會出現 ${top}。`, `   The list is empty, so ${top} will never come up.`));
  const since = dangerSince(cfg.from, c);
  if (!since) {
    console.log(zhEn('   沒記下是什麼時候定的（設定檔沒進版控、改了還沒存檔、或也沒記過判斷時間）——之後新加了哪些,這裡分不出來。',
    '   When it was set wasn\'t recorded (the setting isn\'t in version control, it was changed and not committed yet, or no judgment time was recorded either), so it can\'t tell here which files were added after.'));
  } else {
    // AI 代記的,附的話是 AI 打的——不准講成「使用者說」(老毛病 P7;--decide、--clear E 同一套標法)
    const who = since.by === 'human' ? zhEn('你自己記的', 'you recorded it yourself') : zhEn('AI 代記', 'AI recorded it for you');
    console.log(since.how === 'checked'
      ? zhEn(`   上一次判斷：${ago(since.at)}（${who}${since.said ? `，附的話：「${since.said}」` : ''}）`, `   Last judged: ${ago(since.at)} (${who}${since.said ? `, with the words: “${since.said}”` : ''})`)
      : zhEn(`   清單定好：${ago(since.at)}（git 說的：危險清單那一段從這次存檔起就是這樣）`, `   List set: ${ago(since.at)} (according to git: the danger list part has been this way since that commit)`));
    const fresh = freshInProject(ctx, c, since);
    if (fresh === null) console.log(zhEn('   問不到 git——之後新加了哪些,這裡分不出來。', '   Couldn\'t check with git, so it can\'t tell here which files were added after.'));
    else if (!fresh.length) console.log(zhEn('   之後沒有新加不在清單上的程式檔。', '   No code files that aren\'t on the list were added after that.'));
    else {
      console.log(zhEn(`   之後才新加、不在清單上的程式檔 ${fresh.length} 個（清單不可能考慮過,危不危險還沒有人判斷）：`,
        `   ${plural(fresh.length, 'code file')} added after that and not on the list (the list can't have considered them; nobody has judged whether they're dangerous yet):`));
      for (const f of fresh) console.log(`      ${f}`);
    }
  }
  const missing = missingDanger(ctx.root, c.danger);
  if (missing.length) {
    console.log(zhEn(`   清單裡已經不在的 ${missing.length} 條（改了名或搬了家的話,新的名字不在清單上,碰到它也不會是 ${top}）：`,
      `   ${plural(missing.length, 'entry', 'entries')} on the list no longer there (if renamed or moved, the new name isn't on the list, so touching it won't make it ${top}):`));
    for (const f of missing) console.log(`      ${f}`);
  }
  console.log(zhEn('   判斷完（使用者說了哪些要加、哪些要刪、或都不用）：agy-pipeline --tier-checked "使用者的原話"——之後只問那一刻之後新加的。',
    '   Once judged (the user said which to add, which to remove, or none): agy-pipeline --tier-checked "the user\'s own words"; after that, only files added after that moment are asked about.'));
  return 0;
}

function doTierChecked(ctx, words) {
  const said = String(words ?? '').trim();
  if (!said) {
    console.log(zhEn('要附使用者的原話：agy-pipeline --tier-checked "使用者的原話"——哪些檔危險是使用者判斷的,不是 AI。',
    'Attach the user\'s own words: agy-pipeline --tier-checked "the user\'s own words". Which files are dangerous is the user\'s judgment, not the AI\'s.'));
    return 1;
  }
  const cfg = readTierConfig(ctx.root, ctx.mainRoot, HERE);
  if (cfg.state !== 'ok') return tierNotReady(cfg);
  const { data } = readProjectConfig(ctx.root, ctx.mainRoot);
  const at = new Date().toISOString();
  // 在對話裡跑的(環境帶著對話代號)= AI 代記;你自己在終端機跑的 = 你記的
  const by = sessionFromEnv() ? 'ai' : 'human';
  let prev = dangerSince(cfg.from, cfg.config);
  if (!prev) {
    const before = committedDanger(cfg.from);
    if (before) prev = dangerSince(cfg.from, { ...cfg.config, danger: before });
  }
  const covers = prev ? freshInProject(ctx, cfg.config, prev) : null;
  const snap = checkSnapshot(ctx.root, cfg.config);
  // 寫回原本讀到的那一份 cfg.from（AC-2：不分裂成 .agents/ 與 .claude/ 兩份）
  const r = writeTierConfig(dirname(dirname(cfg.from)), { ...data.tiers, checked: { at, said: said.slice(0, 200), by, ...(snap ?? {}) } }, cfg.from);
  if (!r.ok) { console.log(writeFailed(r)); return 1; }
  console.log(zhEn(`✅ 記下了：危險清單判斷過（${isAi(by) ? 'AI 代記' : '你自己記的'}，附的話：「${said.slice(0, 200)}」）。之後只問這一刻之後才新加的程式檔。`,
    `✅ Recorded: the danger list was judged (${isAi(by) ? 'AI recorded it for you' : 'you recorded it yourself'}, with the words: “${said.slice(0, 200)}”). From now on, only code files added after this moment are asked about.`));
  if (covers?.length) {
    console.log(zhEn(`   這一筆把 ${covers.length} 個之後才新加的程式檔算成判斷過了：${covers.slice(0, 10).join('、')}${covers.length > 10 ? ` 等 ${covers.length} 個` : ''}`,
      `   This record counts ${plural(covers.length, 'code file')} added after that as judged: ${covers.slice(0, 10).join(', ')}${covers.length > 10 ? ` and others (${covers.length} in all)` : ''}`));
    console.log(zhEn('   ——每一個都要問過使用者才算數；有沒問過的，告訴使用者，請他看過之後再記一次。',
      '   Each one only counts if the user was asked about it; if any weren\'t, tell the user and ask them to look before recording it again.'));
  }
  if (snap?.files.length) {
    console.log(zhEn(`   這一刻還沒存檔的程式檔 ${snap.files.length} 個也算判斷過了——之後存檔、再改都不會再被當成新的。`,
      `   ${plural(snap.files.length, 'uncommitted code file')} at this moment count as judged too: committing or changing them later won't make them count as new again.`));
  }
  if (!snap) {
    console.log(zhEn('   ⚠️ 這一刻的版本問不到，只記了時間——之後存檔的新檔可能會被當成判斷之後才新加的，再問一次。',
      '   ⚠️ Couldn\'t check this moment\'s version, so only the time was recorded: new files committed later might count as added after the judgment and be asked about again.'));
  }
  console.log(zhEn(`   寫在 ${r.path}——設定檔進版控的話,記得一起存檔。`, `   Written in ${r.path}; if the setting is in version control, remember to commit it too.`));
  return 0;
}

async function doTierLater(ctx, ev, words) {
  const quote = String(words ?? '').trim();
  if (!quote) {
    console.log(zhEn('要附使用者的原話：agy-pipeline --tier-later "使用者的原話"——「這次先不看」是使用者說的,不是 AI 決定的。',
    'Attach the user\'s own words: agy-pipeline --tier-later "the user\'s own words". "Not looking this time" is something the user said, not something the AI decided.'));
    return 1;
  }
  const sid = sessionFromEnv();
  if (!sid) {
    console.log(zhEn('「這次先不看」只對一個對話有用,要在那個對話裡由 AI 代記（拿不到對話代號）。要判斷的話：agy-pipeline --tier-review',
    '"Not looking this time" only works for one conversation, and the AI has to record it inside that conversation (no conversation ID here). To judge them: agy-pipeline --tier-review'));
    return 1;
  }
  const f = await rerunFacts(ctx, ev);
  const t = f?.tier ?? null;
  if (!t || t.state !== 'ok') {
    const cfg = readTierConfig(ctx.root, ctx.mainRoot, HERE);
    if (cfg.state !== 'ok') return tierNotReady(cfg);
    console.log(zhEn('這一輪的分級算不出來（讀不到這一輪的改動）——沒有東西可以先不看。',
    'This round\'s tier can\'t be worked out (this round\'s changes can\'t be read), so there\'s nothing to put off.'));
    return 1;
  }
  const fresh = t.stale?.fresh ?? [];
  if (!fresh.length) {
    console.log(zhEn('這一輪沒有碰到危險清單定好之後才新加、沒人判斷過的程式檔——沒有東西可以先不看。',
    'This round didn\'t touch any code file added after the danger list was set that nobody has judged, so there\'s nothing to put off.'));
    return 1;
  }
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'tier_later', files: fresh, quote: cutBytes(quote, 600),
      by_session: sid, cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'human', via: 'ai',
    }) + '\n');
  } catch (e) {
    console.log(zhEn(`❌ 沒記成功：${e.message}`,
    `❌ Couldn't record it: ${e.message}`));
    return 1;
  }
  // 記完再算一次:講清楚這筆算不算數(合併最新 transcript.jsonl)
  const later = laterOf(loadEvents(LOG_DIR, ctx.project, { sessionId: sid, cwd: ctx.root }).events, { session: sid, since: f.view?.origin?.at ?? null });
  const few = zhEn(`${fresh.slice(0, 3).join('、')}${fresh.length > 3 ? ` 等 ${fresh.length} 個` : ''}`, `${fresh.slice(0, 3).join(', ')}${fresh.length > 3 ? ` and others (${fresh.length} in all)` : ''}`);
  if (!fresh.every((x) => later.covered.has(x))) {
    console.log(zhEn(`⚠️ 記了，但這筆不算數：收工 hook 問了之後（還沒問過就是這一輪開始之後）、這筆之前，這個對話沒有使用者說的話——分不出是不是使用者說的。收工 hook 照樣會為 ${few} 問。`,
      `⚠️ Recorded, but this one doesn't count: between the end-of-turn hook asking (or, if it hasn't asked yet, the start of this round) and this record, nothing the user said is in this conversation, so it can't tell whether the user said it. The end-of-turn hook will still ask about ${few}.`));
    return 1;
  }
  const q = `${quote.replace(/\s+/g, ' ').slice(0, 60)}${quote.length > 60 ? '…' : ''}`;
  console.log(zhEn(`✅ 記下了：使用者說這次先不看 ${few}（AI 代記，附的話：「${q}」）。`, `✅ Recorded: the user said not to look at ${few} this time (AI recorded it for them, with the words: “${q}”).`));
  const said = later.recs.at(-1)?.said ?? null;
  if (said) {
    const t = `${said.replace(/\s+/g, ' ').slice(0, 60)}${said.length > 60 ? '…' : ''}`;
    console.log(zhEn(`   對照：感測器記的、使用者說的最後一句是「${t}」——對得上「先不看」才是使用者說的。`,
      `   To compare: the last thing the user said, as the sensor recorded it, is “${t}”; only if it matches "not this time" did the user say it.`));
  }
  console.log(zhEn('   這個對話的收工 hook 不再為這幾個檔問；之後碰到別的新檔，只問新的那幾個；換一個對話碰到它們，會再問一次。',
    '   This conversation\'s end-of-turn hook won\'t ask about these files again; if other new files are touched later, it asks about only those; if another conversation touches these, it will ask again.'));
  console.log(zhEn('   ⚠️ 這是「先不看」，不是判斷過了——分級卡照舊講它們危不危險還沒有人判斷。',
    '   ⚠️ This is "not this time", not a judgment: the tier card still says nobody has judged whether they\'re dangerous.'));
  return 0;
}

/** --tier <等級> "<理由>":只准往上。理由必填——沒理由的調高跟誤按分不出來。 */
function doTierSet(ctx, ev, info, facts, id, why) {
  const t = tierOf(ctx, ev, info, facts);
  if (t.state !== 'ok') { for (const line of describeTier(t)) console.log(line); return 1; }
  if (!id) { console.log(zhEn(`要調到哪一級？  agy-pipeline --tier ${t.upgradable[0] ?? '<等級>'} "理由"`, `Raise it to which level?  agy-pipeline --tier ${t.upgradable[0] ?? '<level>'} "reason"`)); return 1; }
  if (!why) { console.log(zhEn(`理由必填：  agy-pipeline --tier ${id} "為什麼這次要更小心"`, `A reason is required:  agy-pipeline --tier ${id} "why this change needs more care"`)); return 1; }
  if (!t.upgradable.includes(id)) {
    console.log(zhEn(`只能調到比機器算的（${t.machine.id}）高的等級${t.upgradable.length ? `：${t.upgradable.join(' / ')}` : '——已經是最高了'}。`,
      `You can only raise it above the level the machine worked out (${t.machine.id})${t.upgradable.length ? `: ${t.upgradable.join(' / ')}` : ', and it\'s already the highest'}.`));
    console.log(zhEn('   往下調沒有指令,要改 .agents/pipeline-stages.json——不方便是故意的。', '   There\'s no command to lower it; you\'d have to edit .agents/pipeline-stages.json, and the inconvenience is on purpose.'));
    return 1;
  }
  try {
    appendHuman(ctx, { event: 'tier_set', level: id, why: why.slice(0, 200) });
  } catch (e) {
    console.log(zhEn(`❌ 沒記成功：${e.message}`, `❌ Couldn't record it: ${e.message}`));
    return 1;
  }
  console.log(zhEn(`✅ 記下了：你說這次算 ${id}（${why.slice(0, 200)}）。機器算的是 ${t.machine.id}。`, `✅ Recorded: you said this change counts as ${id} (${why.slice(0, 200)}). The machine worked out ${t.machine.id}.`));
  // 歸零規則跟 lib/tier.mjs 的 manualTier 同一條(存檔不算新的一輪——規格:這一輪的起點);這句以前還寫「沒章時存檔就歸零」(魔鬼教官 2026-09-22,P2)
  console.log(zhEn('   ⚠️ 這是「你說的」,畫面上會照實這樣寫。它跟著這一輪走:有章時蓋章之後、沒章時下一次 A 開始新的一輪才歸零,存檔不算',
    '   ⚠️ This is "what you said", and the screens will say exactly that. It goes with this round: with a stamp, it resets after the next stamp; without one, when the next A starts a new round. Committing doesn\'t count'));
  console.log(zhEn('      (找不到這一輪起點的時候,存檔就歸零)。', '      (when this round\'s start can\'t be found, committing resets it).'));
  return 0;
}

function doTierRetract(ctx, ev, info, facts) {
  const t = tierOf(ctx, ev, info, facts);
  if (t.state !== 'ok' || !t.manual) { console.log(zhEn('沒有你調高的等級可以收回。', 'There\'s no level you raised to take back.')); return 1; }
  try {
    appendHuman(ctx, { event: 'tier_retracted' });
  } catch (e) {
    console.log(zhEn(`❌ 沒記成功：${e.message}`, `❌ Couldn't record it: ${e.message}`));
    return 1;
  }
  console.log(zhEn(`✅ 收回了：回到機器算的 ${t.machine.id}。`, `✅ Taken back: it's back to ${t.machine.id}, the level the machine worked out.`));
  return 0;
}

// 給 status.mjs 拿;describeTier 也給測試釘文案用。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  describeTier, renderTier, doTierInit, doTierOff, doTierReview, doTierChecked, doTierLater, doTierSet, doTierRetract,
};
