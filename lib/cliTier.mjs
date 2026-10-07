/**
 * cliTier.mjs —— 分級:畫面最下面的分級卡,與 --tier-init／--tier-off／--tier-review／--tier-checked／--tier-later／--tier／--tier-retract。
 * 規格:分級、危險清單會過期、收工hook問危險清單、終端機照指令拆開(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-07 從 status.mjs 原封不動搬過來。分級怎麼算在 lib/tier.mjs,這裡只印與寫。這一輪的分級(tierOf)住 cliFacts.mjs:
 * 「要不要再跑」也要它,放在這裡就會跟 cliFacts 繞成一圈。只從 cliFacts.mjs 拿東西。
 */
import { appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gitExit, ago } from './git.mjs';
import { readEvents, logFileOf } from './events.mjs';
import { readProjectConfig } from './rounds.mjs';
import {
  readTierConfig, writeTierConfig, proposeCodeArea, codeFileFn, computeTier, dangerSince, addedSince, missingDanger, checkSnapshot,
  laterOf, committedDanger,
} from './tier.mjs';
import { changeScope } from './scope.mjs';
import { HERE, LOG_DIR, sessionFromEnv, rerunFacts, cutBytes, tierOf } from './cliFacts.mjs';

/* ══════════════════════════ 分級（lib/tier.mjs 算,這裡只印與寫） ══════════════════════════ */

const SETUP_HINT = '在這個專案的對話裡說「幫我設定分級」,Claude 會提清單給你確認;不需要的話說「這個專案不用分級」。';

/**
 * 分級那一段的文案。純函式,吃 buildTier() 的物件,被 scripts/tier.test.mjs 釘住。
 * ⚠️ 三條紅線逐條套過:沒設定＝「還沒設定」不是「T0」(R1);「需要」那幾行只講有沒有紀錄,不講通過(R2);
 *    每個數字都是 git 或紀錄檔查得到的(R3)。
 */
function describeTier(t) {
  const L = [];
  const emptyWarn = () => `   ⚠️ 危險清單是空的,所以永遠不會出現 ${t.levels?.danger?.id ?? '第三級'}。${SETUP_HINT}`;
  if (t.state === 'unset') {
    L.push('   還沒設定分級。', `   ${SETUP_HINT}`, '   （或自己來：pipeline-status --tier-init）');
    return L;
  }
  if (t.state === 'off') {
    const when = t.off?.at ? `（${ago(t.off.at)}${t.off.why ? `,${t.off.why}` : ''}）` : '';
    L.push(`   已設定為不分級${when}。要恢復：pipeline-status --tier-init`);
    return L;
  }
  if (t.state === 'broken') {
    L.push(`   ⚠️ 分級設定讀不懂（${t.from ?? '.claude/pipeline-stages.json'}）：${t.why ?? ''}`);
    L.push('      為了不亂分,這次不分級。');   // R1:讀不懂 ≠ 沒設定 ≠ T0
    return L;
  }
  if (t.state === 'no-base') { L.push('   這個專案還沒有任何 commit,沒有基準可以算「這次改動」。先 git commit 一次。'); return L; }
  if (t.state === 'unknown') { L.push('   問不到改動,分不了級。'); return L; }
  if (t.state === 'no-change') {
    L.push('   這次沒有改動,沒有東西要分級。');
    if (t.dangerEmpty) L.push(emptyWarn());
    return L;
  }
  // 同一個 0 的另一種意思(老毛病 P5):只看得到還沒存檔的,而還沒存檔的沒有——存檔過的看不到,不准講成「沒有改動」
  if (t.state === 'unseen') {
    L.push(`   ${changeScope(t.basis, ago).empty}`);
    L.push('   所以這次分不了級。');
    return L;
  }

  const { machine, manual, final } = t;
  const dangerHits = machine.hits.danger;
  const why = machine.rank === 2
    ? `碰到危險清單：${dangerHits.slice(0, 3).join('、')}${dangerHits.length > 3 ? `…共 ${dangerHits.length} 個` : ''}`
    : machine.rank === 1 ? `碰到程式區 ${machine.hits.code.length} 個檔` : '沒碰到程式區';
  if (manual) L.push(`   機器算 ${machine.id}（${why}）,你說 ${manual.id}（理由：${manual.why}）· ${ago(manual.ts)}`);
  else L.push(`   ${final.id}（${why}）`);
  // 只算得到還沒存檔的:存檔過的看不到,實際可能更高(規格:這一輪的起點 AC-4)
  if (t.basis?.kind === 'head') L.push(`   ⚠️ ${changeScope(t.basis, ago).short}。存檔過的看不到,實際可能更高。`);
  if (t.manualIgnored) {
    L.push(`   （你 ${ago(t.manualIgnored.ts)}說的 ${t.manualIgnored.id} 沒有比機器算的高,不採用。）`);
  }

  if (t.requirements.length) {
    L.push('   需要：');
    for (const r of t.requirements) {
      // ✅ 有紀錄而且結案了(Claude 說／你說);⏸ 有紀錄沒結案;⚠️ 沒有紀錄;❔ 問不到／不適用;🔗 規格是別的對話寫的(Claude 說照哪份施工)
      const mark = r.state === 'ok' ? '✅' : r.state === 'ran' ? '⏸' : r.state === 'missing' ? '⚠️' : r.state === 'linked' ? '🔗' : '❔';
      const when = r.ts ? `${ago(r.ts)}` : '';
      L.push(`        ${r.label.padEnd(8, '　')} ${mark} ${when}${r.detail}`);
    }
  }
  if (t.dangerEmpty) L.push(emptyWarn());
  if (t.candidates.length) {
    L.push(`   ⚠️ 這次動到的檔案裡,有 ${t.candidates.length} 個名字像會存東西、但不在危險清單：`);
    for (const f of t.candidates.slice(0, 5)) L.push(`        ${f}`);
    L.push('      （只是提醒。改錯會靜默丟資料的話,加進 .claude/pipeline-stages.json 的 tiers.danger。）');
  }
  // 危險清單可能過期了(規格:危險清單會過期):句子在 lib/tier.mjs 算好,網頁照印同一句(老毛病 P2)
  for (const line of t.staleNotes ?? []) L.push(`   ${line}`);
  L.push('   為了程式碼安全,分級只能往上調。');
  if (manual) L.push('   收回你調的：pipeline-status --tier-retract');
  else if (t.upgradable.length) L.push(`   要調高：pipeline-status --tier ${t.upgradable[0]} "理由"`);
  return L;
}

function renderTier(ctx, ev, info, facts) {
  console.log('\n━━ 分級 ━━');
  for (const line of describeTier(tierOf(ctx, ev, info, facts))) console.log(line);
}

/** 人蓋的章(結案、調高分級),全部走這裡:同一份 append-only 紀錄,標明 source:'human'。 */
function appendHuman(ctx, obj) {
  appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
    ts: new Date().toISOString(), ...obj, cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'human',
  }) + '\n');
}

const isIgnored = (root, file) => gitExit(['check-ignore', '-q', file], root) === 0;

/** --tier-init [資料夾…]:提議程式區、寫出骨架(危險清單空的)。已經設定過就只回報。 */
function doTierInit(ctx, dirs) {
  const cfg = readTierConfig(ctx.root, ctx.mainRoot, HERE);
  if (cfg.state === 'broken') {
    console.log(`⚠️ 分級設定讀不懂（${cfg.from}）：${cfg.why}。先修好那個檔案,這次不動它。`);
    return 1;
  }
  if (cfg.state === 'ok') {
    console.log(`已經設定過了（${cfg.from}）：程式區 ${cfg.config.code.join('、')}；危險清單 ${cfg.config.danger.length} 個。`);
    if (!cfg.config.danger.length) console.log(`⚠️ 危險清單是空的,所以永遠不會出現 ${cfg.config.levels.danger.id}。${SETUP_HINT}`);
    return 0;
  }
  const proposal = dirs.length
    ? { dirs: dirs.map((d) => `${d.replace(/^\.\//, '').replace(/\/+$/, '')}/`), why: '你指定的' }
    : proposeCodeArea(ctx.root);
  if (!proposal) {
    console.log('認不出這個專案的程式區（package.json 沒指向哪裡、也找不到放程式檔的資料夾）。');
    console.log('   自己指定：  pipeline-status --tier-init src/');
    return 1;
  }
  const r = writeTierConfig(ctx.root, { code: proposal.dirs, danger: [] });
  if (!r.ok) { console.log(`❌ ${r.why}（${r.path}）`); return 1; }
  console.log(`✅ 寫好了：${r.path}`);
  console.log(`   程式區：${proposal.dirs.join('、')}（${proposal.why}）——不對的話直接改那個檔的 tiers.code`);
  console.log('   危險清單：空的。⚠️ 所以永遠不會出現第三級——只有人判斷得了「改錯會不會靜默丟資料」。');
  console.log(`   ${SETUP_HINT}`);
  if (isIgnored(ctx.root, '.claude/pipeline-stages.json')) {
    console.log('\n⚠️ 這個檔案被 .gitignore 擋著,**不會進版控**——換一台電腦、或在 worktree 裡,分級就不見了。');
    console.log('   分級是專案的政策,建議進版控：在 .gitignore 加一行  !.claude/pipeline-stages.json');
  }
  return 0;
}

function doTierOff(ctx, why) {
  const r = writeTierConfig(ctx.root, { off: true, at: new Date().toISOString(), why: why || null });
  if (!r.ok) { console.log(`❌ ${r.why}（${r.path}）`); return 1; }
  console.log(`✅ 記下了：這個專案不分級${why ? `（${why}）` : ''}。對話開始時不會再提醒。`);
  console.log('   要恢復：  pipeline-status --tier-init');
  return 0;
}

/** 分級設定還沒好的時候,危險清單的兩個指令講同一句(不准當成「清單沒過期」)。 */
function tierNotReady(cfg) {
  console.log(cfg.state === 'unset' ? `還沒設定分級,沒有危險清單可以看。${SETUP_HINT}`
    : cfg.state === 'off' ? '這個專案設定成不分級,沒有危險清單可以看。要恢復：pipeline-status --tier-init'
    : `分級設定讀不懂（${cfg.from ?? '.claude/pipeline-stages.json'}）：${cfg.why ?? ''}——沒有危險清單可以看。`);
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
  console.log('━━ 危險清單 ━━');
  console.log(c.danger.length ? `   清單上 ${c.danger.length} 條：${c.danger.join('、')}` : `   清單是空的——永遠不會出現 ${top}。`);
  const since = dangerSince(cfg.from, c);
  if (!since) {
    console.log('   沒記下是什麼時候定的（設定檔沒進版控、改了還沒存檔、或也沒記過判斷時間）——之後新加了哪些,這裡分不出來。');
  } else {
    // Claude 代記的,附的話是 Claude 打的——不准講成「使用者說」(老毛病 P7;--decide、--clear E 同一套標法)
    const who = since.by === 'human' ? '你自己記的' : 'Claude 代記';
    console.log(since.how === 'checked'
      ? `   上一次判斷：${ago(since.at)}（${who}${since.said ? `，附的話：「${since.said}」` : ''}）`
      : `   清單定好：${ago(since.at)}（git 說的：危險清單那一段從這次存檔起就是這樣）`);
    const fresh = freshInProject(ctx, c, since);
    if (fresh === null) console.log('   問不到 git——之後新加了哪些,這裡分不出來。');
    else if (!fresh.length) console.log('   之後沒有新加不在清單上的程式檔。');
    else {
      console.log(`   之後才新加、不在清單上的程式檔 ${fresh.length} 個（清單不可能考慮過,危不危險還沒有人判斷）：`);
      for (const f of fresh) console.log(`      ${f}`);
    }
  }
  const missing = missingDanger(ctx.root, c.danger);
  if (missing.length) {
    console.log(`   清單裡已經不在的 ${missing.length} 條（改了名或搬了家的話,新的名字不在清單上,碰到它也不會是 ${top}）：`);
    for (const f of missing) console.log(`      ${f}`);
  }
  console.log('   判斷完（使用者說了哪些要加、哪些要刪、或都不用）：pipeline-status --tier-checked "使用者的原話"——之後只問那一刻之後新加的。');
  return 0;
}

/**
 * --tier-checked "<使用者的原話>":記下危險清單判斷過了(規格:危險清單會過期 AC-3)。寫進設定檔的 tiers.checked = { at, said, by, commit, files },
 * 其他鍵原封不動;寫回讀出來的那一份(worktree 沒有自己的設定檔時,是主資料夾那一份)。判斷是使用者的——沒附原話不收。
 * commit、files 是那一刻的快照(規格:收工hook問危險清單 AC-2):那時的版本、那時還沒存檔的程式檔——判斷過的就是這些,
 * 之後存檔、再改都還是判斷過的。以前只記時間,判斷過的新檔一存檔就又被講成沒人判斷過(老毛病 P9)。
 */
function doTierChecked(ctx, words) {
  const said = String(words ?? '').trim();
  if (!said) {
    console.log('要附使用者的原話：pipeline-status --tier-checked "使用者的原話"——哪些檔危險是使用者判斷的,不是 Claude。');
    return 1;
  }
  const cfg = readTierConfig(ctx.root, ctx.mainRoot, HERE);
  if (cfg.state !== 'ok') return tierNotReady(cfg);
  const { data } = readProjectConfig(ctx.root, ctx.mainRoot);
  const at = new Date().toISOString();
  // 在對話裡跑的(環境帶著對話代號)= Claude 代記;你自己在終端機跑的 = 你記的。你在對話框用 ! 跑的也會被標成 Claude 代記——往保守那邊錯
  const by = sessionFromEnv() ? 'claude' : 'human';
  // 這一筆記的是「整份清單判斷過了」:寫之前先算出它會蓋掉哪幾個(上一次之後新加、--tier-review 列的那一份),記完照實講——
  // 只問了這一輪碰到的就記,別的、沒給使用者看過的新檔也會一起被當成判斷過(魔鬼教官第一輪,R1)
  let prev = dangerSince(cfg.from, cfg.config);
  // 清單剛改過、還沒存檔,之前又沒判斷過:git 對不上現在這份,prev 就沒有——照上一次存檔的那份清單算(--tier-review 在改之前列的就是那一份)。
  // 不算的話,最常見的那條路(看完清單、改清單、記判斷)反而不講這一筆蓋掉哪幾個(魔鬼教官第二輪)
  if (!prev) {
    const before = committedDanger(cfg.from);
    if (before) prev = dangerSince(cfg.from, { ...cfg.config, danger: before });
  }
  const covers = prev ? freshInProject(ctx, cfg.config, prev) : null;
  // 快照照這個工作區拍(判斷看的就是它);問不到就只記時間——之後退回用時間算,多問,不少問
  const snap = checkSnapshot(ctx.root, cfg.config);
  const r = writeTierConfig(dirname(dirname(cfg.from)), { ...data.tiers, checked: { at, said: said.slice(0, 200), by, ...(snap ?? {}) } });
  if (!r.ok) { console.log(`❌ ${r.why}（${r.path}）`); return 1; }
  console.log(`✅ 記下了：危險清單判斷過（${by === 'claude' ? 'Claude 代記' : '你自己記的'}，附的話：「${said.slice(0, 200)}」）。之後只問這一刻之後才新加的程式檔。`);
  if (covers?.length) {
    console.log(`   這一筆把 ${covers.length} 個之後才新加的程式檔算成判斷過了：${covers.slice(0, 10).join('、')}${covers.length > 10 ? ` 等 ${covers.length} 個` : ''}`);
    console.log('   ——每一個都要問過使用者才算數；有沒問過的，告訴使用者，請他看過之後再記一次。');
  }
  if (snap?.files.length) console.log(`   這一刻還沒存檔的程式檔 ${snap.files.length} 個也算判斷過了——之後存檔、再改都不會再被當成新的。`);
  if (!snap) console.log('   ⚠️ 這一刻的版本問不到，只記了時間——之後存檔的新檔可能會被當成判斷之後才新加的，再問一次。');
  console.log(`   寫在 ${r.path}——設定檔進版控的話,記得一起存檔。`);
  return 0;
}

/**
 * --tier-later "<使用者的原話>":使用者說這次先不看危險清單(規格:收工hook問危險清單 AC-3)。
 * 記一筆事件(這一輪碰到、還沒人判斷過的那幾個檔＋原話＋對話代號),這個對話的收工 hook 不再為這幾個檔問;分級卡照舊講它們沒人判斷(本來就是事實)。
 * 算不算數跟收工 hook 同一個函式(lib/tier.mjs 的 laterOf):收工 hook 問了之後、這筆之前沒有使用者說的話 → 不算(老毛病 P7)。
 * 「先不看」不是判斷過了——不寫設定檔。
 */
async function doTierLater(ctx, ev, words) {
  const quote = String(words ?? '').trim();
  if (!quote) {
    console.log('要附使用者的原話：pipeline-status --tier-later "使用者的原話"——「這次先不看」是使用者說的,不是 Claude 決定的。');
    return 1;
  }
  const sid = sessionFromEnv();
  if (!sid) {
    console.log('「這次先不看」只對一個對話有用,要在那個對話裡由 Claude 代記（拿不到對話代號）。要判斷的話：pipeline-status --tier-review');
    return 1;
  }
  const f = await rerunFacts(ctx, ev);
  const t = f?.tier ?? null;
  if (!t || t.state !== 'ok') {
    const cfg = readTierConfig(ctx.root, ctx.mainRoot, HERE);
    if (cfg.state !== 'ok') return tierNotReady(cfg);
    console.log('這一輪的分級算不出來（讀不到這一輪的改動）——沒有東西可以先不看。');
    return 1;
  }
  const fresh = t.stale?.fresh ?? [];
  if (!fresh.length) {
    console.log('這一輪沒有碰到危險清單定好之後才新加、沒人判斷過的程式檔——沒有東西可以先不看。');
    return 1;
  }
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'tier_later', files: fresh, quote: cutBytes(quote, 600),
      by_session: sid, cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'human', via: 'claude',
    }) + '\n');
  } catch (e) {
    console.log(`❌ 沒記成功：${e.message}`);
    return 1;
  }
  // 記完再算一次:講清楚這筆算不算數(跟收工 hook 同一個函式、同一個起點)
  const later = laterOf(readEvents(LOG_DIR, ctx.project).events, { session: sid, since: f.view?.origin?.at ?? null });
  const few = `${fresh.slice(0, 3).join('、')}${fresh.length > 3 ? ` 等 ${fresh.length} 個` : ''}`;
  if (!fresh.every((x) => later.covered.has(x))) {
    console.log(`⚠️ 記了，但這筆不算數：收工 hook 問了之後（還沒問過就是這一輪開始之後）、這筆之前，這個對話沒有使用者說的話——分不出是不是使用者說的。收工 hook 照樣會為 ${few} 問。`);
    return 1;
  }
  console.log(`✅ 記下了：使用者說這次先不看 ${few}（Claude 代記，附的話：「${quote.replace(/\s+/g, ' ').slice(0, 60)}${quote.length > 60 ? '…' : ''}」）。`);
  // 「有說話」不等於「說了先不看」:附上感測器記的、使用者在那之後說的最後一句,給人對照(跟 --decide 同一套;魔鬼教官第一輪,P7)
  const said = later.recs.at(-1)?.said ?? null;
  if (said) console.log(`   對照：感測器記的、使用者說的最後一句是「${said.replace(/\s+/g, ' ').slice(0, 60)}${said.length > 60 ? '…' : ''}」——對得上「先不看」才是使用者說的。`);
  console.log('   這個對話的收工 hook 不再為這幾個檔問；之後碰到別的新檔，只問新的那幾個；換一個對話碰到它們，會再問一次。');
  console.log('   ⚠️ 這是「先不看」，不是判斷過了——分級卡照舊講它們危不危險還沒有人判斷。');
  return 0;
}

/** --tier <等級> "<理由>":只准往上。理由必填——沒理由的調高跟誤按分不出來。 */
function doTierSet(ctx, ev, info, facts, id, why) {
  const t = tierOf(ctx, ev, info, facts);
  if (t.state !== 'ok') { for (const line of describeTier(t)) console.log(line); return 1; }
  if (!id) { console.log(`要調到哪一級？  pipeline-status --tier ${t.upgradable[0] ?? '<等級>'} "理由"`); return 1; }
  if (!why) { console.log('理由必填：  pipeline-status --tier ' + id + ' "為什麼這次要更小心"'); return 1; }
  if (!t.upgradable.includes(id)) {
    console.log(`只能調到比機器算的（${t.machine.id}）高的等級${t.upgradable.length ? `：${t.upgradable.join(' / ')}` : '——已經是最高了'}。`);
    console.log('   往下調沒有指令,要改 .claude/pipeline-stages.json——不方便是故意的。');
    return 1;
  }
  try {
    appendHuman(ctx, { event: 'tier_set', level: id, why: why.slice(0, 200) });
  } catch (e) {
    console.log(`❌ 沒記成功：${e.message}`);
    return 1;
  }
  console.log(`✅ 記下了：你說這次算 ${id}（${why.slice(0, 200)}）。機器算的是 ${t.machine.id}。`);
  // 歸零規則跟 lib/tier.mjs 的 manualTier 同一條(存檔不算新的一輪——規格:這一輪的起點);這句以前還寫「沒章時存檔就歸零」(魔鬼教官 2026-09-22,P2)
  console.log('   ⚠️ 這是「你說的」,畫面上會照實這樣寫。它跟著這一輪走:有章時蓋章之後、沒章時下一次 A 開始新的一輪才歸零,存檔不算');
  console.log('      (找不到這一輪起點的時候,存檔就歸零)。');
  return 0;
}

function doTierRetract(ctx, ev, info, facts) {
  const t = tierOf(ctx, ev, info, facts);
  if (t.state !== 'ok' || !t.manual) { console.log('沒有你調高的等級可以收回。'); return 1; }
  try {
    appendHuman(ctx, { event: 'tier_retracted' });
  } catch (e) {
    console.log(`❌ 沒記成功：${e.message}`);
    return 1;
  }
  console.log(`✅ 收回了：回到機器算的 ${t.machine.id}。`);
  return 0;
}

// 給 status.mjs 拿;describeTier 也給測試釘文案用。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  describeTier, renderTier, doTierInit, doTierOff, doTierReview, doTierChecked, doTierLater, doTierSet, doTierRetract,
};
