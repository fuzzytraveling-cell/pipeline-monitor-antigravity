/**
 * todo.mjs —— 「還差什麼」總表(規格:還差什麼總表)。首頁最上面那一張、終端機 --todo 那一張,每一句都從這裡出
 * (規格:終端機與網頁說同一句)。第二段的主任讀的就是終端機那一張,所以這裡的字就是它看到的字。
 *
 * ⚠️ 只讀 collectAll 已經算好的東西(每個對話的卡、分級、五關、章),不另問 git——刷新不能因此變慢(規格:儀表板刷新少等git),
 *    同一件事也不能在兩個地方各算一次(老毛病 P2)。句子也一樣:三階梯、清單、五關、分級卡那幾句都拿現成的,不重寫一份。
 * ⚠️ 三條紅線:問不到的講問不到,那一行就不准變成「沒有還差的事」(R1、P5);
 *    「沒有還差的事」只是總表上沒有要做的,不替結論背書——Claude 說的照寫是 Claude 說的,不打勾、不變綠(R2、P10)。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { zhEn, plural } from './lang.mjs';
import { ago as agoNow } from './git.mjs';
import { clProg, checklistWhy, stageLine } from './stageLines.mjs';
import { cardState } from './rounds.mjs';

/** 一行裡的一件事。kind:ask 等你決定、todo 還差、unknown 問不到／看不到、note 只是說明(資料夾的事見哪一行)——note 不擋「沒有還差的事」 */
const item = (kind, text) => ({ kind, text });

/**
 * 整張總表。all 是 collectAll 的結果;restart 是「要不要重啟」那一句(網頁那一張由服務自己講,終端機那一張問服務,見 lib/cliTodo.mjs)。
 * @returns {{ head, note, restart, projects: {name, displayName, note, push, pushKind, rows}[], quiet, empty }}
 *   pushKind:push 那一行是還差(todo,還沒推)還是看不到(unknown,問不到);沒有 push 就是 null
 *   rows:{ id, title, cwd, last, closed, closedNote, items, clear }——clear 是「沒有還差的事了」那一句,有任何一件事要做或問不到就是 null
 */
export function todoBoard(all, { restart = null, ago = agoNow } = {}) {
  // 每個專案都給一段(網頁一頁只看一個案件,那個案件沒事也要有一句為什麼,不准空著);desk:每個對話的收尾狀況,F 工地主任那一關用(AC-12)
  const desk = {};
  const projects = (all?.projects ?? []).map((p) => projectSection(p, { ago, desk }));
  // 終端機一次看所有專案:沒事的那幾個併成一句。還有沒開始的建議卡的照樣自己一段——主任挑下一步、開卡之前要知道(規格:主任技能 AC-7)
  const still = projects.filter((x) => x.quiet && !x.cards);
  return {
    head: zhEn('還差什麼', 'What\'s left'),
    note: zhEn('每個還沒結案的對話一個；已結案的，只在檔案還沒存、還沒併的時候出現。', 'One for each conversation that isn\'t closed; closed ones only show up while files aren\'t committed or merged yet.'),
    restart, projects, desk,
    quiet: still.length ? quietLine(still.map((x) => x.displayName), still.some((x) => x.goneHidden)) : null,
    // 一個案件都看不到:不准留一張空表(空的看起來就是都沒事,P5)。只講「看不到」——可能是還沒有,也可能是舊的紀錄還沒搬過來(最上面那一條會講)
    empty: (all?.projects ?? []).length ? null : zhEn('這裡還看不到任何案件（只列有紀錄或有還原點的專案）。', 'No projects can be seen here yet (only projects with records or a restore point are listed).'),
  };
}

function quietLine(names, goneHidden) {
  const n = names.length;
  return zhEn(`其他 ${n} 個專案沒有進行中的對話，已結案的對話資料夾裡也沒有沒存、沒併的東西${goneHidden ? '（資料夾已經不在的看不到）' : ''}：${names.join('、')}`,
    `${n === 1 ? '1 other project has' : `${n} other projects have`} no conversations in progress, and the closed conversations' folders have nothing uncommitted or unmerged${goneHidden ? ' (folders that are gone can\'t be seen)' : ''}: ${names.join(', ')}`);
}

/** 一個案件沒有任何要列的:為什麼(AC-1:不准空著)。已結案、資料夾不在的這一段不另問 git,講看不到它們,不講成都沒事(R1) */
function quietOne(goneHidden) {
  return zhEn(`沒有進行中的對話，已結案的對話資料夾裡也沒有沒存、沒併的東西${goneHidden ? '（資料夾已經不在的看不到）' : ''}`,
    `No conversations in progress, and the closed conversations' folders have nothing uncommitted or unmerged${goneHidden ? ' (folders that are gone can\'t be seen)' : ''}`);
}

/** 一個專案那一段:推了沒(一個專案講一次,AC-5)、每個還沒結案的對話一個、已結案還有檔案沒存沒併的排最後(AC-6) */
function projectSection(p, { ago, desk = {} }) {
  const sessions = p.sessions ?? [];
  const owner = ownersOf(sessions);
  const rows = [];
  for (const s of sessions) {
    const row = rowOf(s, owner, { ago });
    if (row) rows.push(row);
    desk[s.id] = row ?? closedDesk(s, owner, { ago });
  }
  rows.sort((a, b) => Number(a.closed) - Number(b.closed));   // 伺服器已經依最後動作排好;sort 不打亂同一組的先後
  // push 那一格看的是 main,每一張卡都一樣(lib/collect.mjs 的 ladderSteps):主資料夾那張優先,沒有就拿任何一張還在的
  const live = (p.cards ?? []).filter((c) => c && !c.gone && !c.notGit);
  const card = live.find((c) => c.path === p.mainRoot) ?? live[0] ?? null;
  const step = card?.ladder?.steps?.find((x) => x.id === 'push') ?? null;
  let push = step && (step.state === 'pending' || step.state === 'unknown') ? step.text : null;
  // 有對話要列、卻一張還在的卡都沒有:推了沒問不到,也要講(R1)
  if (!step && rows.length) push = zhEn('找不到還在的資料夾，問不到 main 推了沒', 'Can\'t find a folder that\'s still there, so couldn\'t check whether main was pushed');
  // 白板那一行用哪一色筆:還沒推是還差(藍)、問不到是看不到(灰)。筆槽的筆亮不亮也算它(ui/app.js 的 whiteboard)
  const pushKind = !push ? null : step?.state === 'pending' ? 'todo' : 'unknown';
  const notes = [];
  if (p.optedOut && p.optedOutLine) notes.push(p.optedOutLine);
  if (card?.sensor?.mount?.state === 'broken') {
    notes.push(zhEn('⚠️ 這個專案的感測器掛壞了，下面的紀錄可能不全——看它的對話頁感測器那一行', '⚠️ This project\'s sensor hookup is broken, so the records below might be incomplete: see the sensor line on its conversation pages'));
  }
  const note = notes.join(' ') || null;
  // 有提醒(感測器掛壞了、退出記錄)的專案不准算沒事:它新的對話根本沒被記,「沒有進行中的對話」可能是沒記到(R1、P3;魔鬼教官第一輪)
  const goneHidden = sessions.some((s) => s.closedAt && (!s.card || s.card.gone));
  const quiet = !rows.length && !push && !note ? quietOne(goneHidden) : null;
  // 建議卡還沒開始幾張:終端機那一張每個專案講一行(規格:主任技能 AC-7)。網頁白板不畫——案件頁下面就是「建議新增的對話」那一區
  const open = (p.suggestions ?? []).filter((sg) => cardState(sg) === 'open').length;
  const incoming = (p.incomingSuggestions ?? []).reduce((n, x) => n + (x.count ?? 0), 0);
  return { name: p.name, displayName: p.displayName ?? p.name, note, push, pushKind, rows, quiet, goneHidden, cards: cardsLine(open, incoming) };
}

/**
 * 還沒開始的建議卡那一行。0 張不講(那一區自己會講「不代表沒跳過」);別的專案提、要開在這裡的另外講——
 * 卡住在提的那個專案,只數自己這邊的話,這一行說 0、別頁明明掛著要開在這裡的卡(P5:這個 0 有兩種意思)
 */
function cardsLine(open, incoming) {
  if (!open && !incoming) return null;
  const more = zhEn(`別的專案還有 ${incoming} 張要開在這裡`, `${incoming === 1 ? '1 more card raised in another project is' : `${incoming} more cards raised in other projects are`} to be opened here`);
  const where = zhEn('案件頁「建議新增的對話」；在這個專案跑 pipeline-status --cards 看每一張', '"Suggested new conversations" on the project page; run pipeline-status --cards in this project to see each one');
  return !open
    ? zhEn(`還沒開始的建議卡：${more}（${where}）`, `Suggestion cards not started yet: ${more} (${where})`)
    : zhEn(`還沒開始的建議卡 ${open} 張${incoming ? `；${more}` : ''}（${where}）`, `Suggestion cards not started yet: ${open}${incoming ? `; ${more}` : ''} (${where})`);
}

/**
 * 已結案、白板上不列的那幾個:F 工地主任那一關還是要講為什麼不列——不列不等於沒事(R1)。
 * 資料夾不在了 → 看不到;資料夾是別的對話的 → 見那一個;都在 → 資料夾裡沒有沒存、沒併的東西
 */
function closedDesk(s, owner, { ago }) {
  const o = owner.get(s.cwd);
  const items = !folderOk(s.card) ? [item('unknown', zhEn('資料夾不在了，看不到檔案存了沒、併了沒', 'The folder is gone, so can\'t see whether files are committed and merged'))]
    : s.movedOn ? [item('note', zhEn('資料夾已換給別的對話，資料夾的事不算這一個的', 'The folder was handed to another conversation, so the folder\'s things aren\'t this one\'s'))]
    : o && o.id !== s.id ? [item('note', zhEn(`資料夾的事見「${titleOf(o)}」`, `For the folder's things, see "${titleOf(o)}"`))]
    : [item('note', zhEn('資料夾裡沒有沒存、沒併的東西', 'Nothing uncommitted or unmerged in the folder'))];
  return { id: s.id, title: titleOf(s), cwd: s.cwd ?? null, last: zhEn(`最後動作 ${ago(s.lastTs)}`, `last activity ${ago(s.lastTs)}`),
           closed: true, closedNote: s.deletedAt ? zhEn('已在 app 裡刪除', 'deleted in the app') : zhEn('已結案', 'closed'), items, clear: null };
}

/**
 * 資料夾的事(存檔、併、章)只掛在一個對話上:同一個資料夾好幾個對話時,掛在最近動過、還沒結案的那一個(都結案了就最近動過的那一個)。
 * 資料夾換過人的上一手(movedOn)不算——資料夾現在是下一手的(規格:新對話接手舊資料夾)。不講兩次,也不漏講
 */
function ownersOf(sessions) {
  const owner = new Map();
  for (const s of sessions) {                  // 已經依最後動作排好(新的在前)
    if (!s.cwd || s.movedOn) continue;
    const cur = owner.get(s.cwd);
    if (!cur || (cur.closedAt && !s.closedAt)) owner.set(s.cwd, s);
  }
  return owner;
}

const titleOf = (s) => s.title ?? zhEn('（還沒有標題）', '(no title yet)');
const folderOk = (card) => !!card && !card.gone && !card.notGit;

function rowOf(s, owner, { ago }) {
  const base = { id: s.id, title: titleOf(s), cwd: s.cwd ?? null, last: zhEn(`最後動作 ${ago(s.lastTs)}`, `last activity ${ago(s.lastTs)}`), closedNote: null };
  const own = !s.movedOn && owner.get(s.cwd)?.id === s.id;
  if (s.closedAt) {
    // 已結案(或在 app 裡刪掉的):關卡的事算你決定了,只講會丟東西的——檔案沒存、沒併(AC-6)。資料夾不在了的不列(這一段不另問 git)
    if (!own || !folderOk(s.card)) return null;
    const items = folderItems(s.card, { stamp: false });
    if (!items.length) return null;
    return { ...base, closed: true, closedNote: s.deletedAt ? zhEn('已在 app 裡刪除', 'deleted in the app') : zhEn('已結案', 'closed'), items, clear: null };
  }
  // 資料夾不在了:檔案、分級都看不到,只講看不到(AC-3)。舊的關卡紀錄不列——那個資料夾的東西不是不見了就是早就併走了
  if (!folderOk(s.card)) {
    const why = !s.card ? zhEn('找不到這個對話的資料夾，看不到它還差什麼', 'Can\'t find this conversation\'s folder, so can\'t see what\'s left')
      : s.card.gone ? zhEn('資料夾不在了，看不到它還差什麼', 'The folder is gone, so can\'t see what\'s left')
      : zhEn('這個資料夾不是 git 專案，看不到它還差什麼', 'This folder isn\'t a git project, so can\'t see what\'s left');
    return { ...base, closed: false, items: [item('unknown', why)], clear: null };
  }
  const stage = stageItems(s, { ago });
  const items = [...stage];
  if (s.movedOn) items.push(item('note', zhEn('資料夾已換給別的對話，資料夾的事不算這一個的', 'The folder was handed to another conversation, so the folder\'s things aren\'t this one\'s')));
  else if (!own && owner.get(s.cwd)) items.push(item('note', zhEn(`資料夾的事見「${titleOf(owner.get(s.cwd))}」`, `For the folder's things, see "${titleOf(owner.get(s.cwd))}"`)));
  else items.push(...folderItems(s.card, { stamp: true }));
  return { ...base, closed: false, items, clear: items.some((i) => i.kind !== 'note') ? null : clearLine(s),
           call: callLine(stage, items, { noChange: s.tier?.state === 'no-change' }) };
}

/**
 * F 工地主任那一格亮燈的那一句(規格:主任動手收尾 AC-9):這一輪該做的都有結論、只剩收尾——剩下的只有等你決定的(D 要不要再跑、
 * 驗收過了沒、危險清單)與存檔、併、章。主任讀的就是這一張白板,所以亮不亮也只照它算,不另算一份(老毛病 P2)。
 * 不亮(null):還有 Claude 該做的(還差的關、清單沒對)、在等你點頭開工或清單有待討論的(hold:那不是收尾)、任何一件問不到(R1)、
 *   一件都沒有(那是「可以按結案」)、只剩只有你能說的(onlyYou:驗收過了沒)。⚠️ 白板看不到 Claude 這一回合做完了沒,所以只講「可以叫」,不講「做完了」(R2)
 * 這一輪一個檔都沒改、只剩章(新開的對話,資料夾還沒蓋過章)也不亮:什麼都還沒做,沒有「收尾」可言——每個新對話一開始就亮,亮著等於沒亮
 * (規格:主任條列與工地帽 AC-5;以前寫規格寫到一半也亮,P10)。
 * 叫了之後會怎樣(合成一個問題、你回一句它才照順序做)住在網頁 F 那一格的「細節」(那是網頁自己的說明,ui/app.js 的 directorRow);這一句只講現在可以叫
 */
function callLine(stage, all, { noChange = false } = {}) {
  const live = all.filter((i) => i.kind !== 'note');
  if (!live.length || live.some((i) => i.kind === 'unknown' || i.hold) || stage.some((i) => i.kind === 'todo')) return null;
  if (noChange && live.every((i) => i.stamp)) return null;
  // 件數只算主任會包進那一個問題的:只有你能說的(onlyYou)它另外講,算進來數字就跟主任真的問的對不上;只剩那一種就沒有東西可以合成,不亮
  // (魔鬼教官第一輪,老毛病 P2:哪幾件包進問題,技能跟這裡各算一次)
  const n = live.filter((i) => !i.onlyYou).length;
  if (!n) return null;
  return zhEn(`現在可以叫主任：只剩收尾，能一起做的 ${n} 件——在對話裡說「主任」`,
    `Now's a good time to call the site director: only wrap-up is left, ${n === 1 ? '1 item' : `${n} items`} that can go together. Say "site director" in the conversation`);
}

/**
 * 沒有還差的事的那一句(AC-4)。有幾關的結論是 Claude 說的就照寫——「沒有還差的事」只是總表上沒有要做的,不是有人驗過了(R2、P10)
 */
function clearLine(s) {
  const t = s.tier;
  const byClaude = t?.state === 'ok'
    ? (t.lines?.reqs ?? []).filter((r) => r.state === 'linked' || (r.state === 'ok' && (s.stages ?? []).find((x) => x.id === r.key)?.doneBy === 'claude')).map((r) => r.key)
    : [];
  return zhEn(`這個對話沒有還差的事了${byClaude.length ? `（${byClaude.join('、')} 的結論是 Claude 說的）` : ''}——可以按結案`,
    `Nothing left on the list for this conversation${byClaude.length ? ` (the conclusions for ${byClaude.join(', ')} are what Claude says)` : ''}: you can press Close`);
}

/**
 * 一個對話卡在哪幾關、哪幾件等你決定:等你決定的排前面,然後是還差的關(AC-2)。
 * 句子跟對話頁同一句:分級卡「需要」那幾行(tierLines 的 reqs)、五關那一格的 rerun 那一句、清單進度(clProg)、危險清單那幾句(staleNotes)。
 */
const needs = (r) => !!r && r.state !== 'ok' && r.state !== 'linked';
const reqItem = (r) => item(r.state === 'unknown' ? 'unknown' : 'todo', zhEn(`${r.mark} ${r.label}：${r.text}`, `${r.mark} ${r.label}: ${r.text}`));
const askLine = (label, text) => item('ask', zhEn(`等你決定（${label}）：${text}`, `Your call (${label}): ${text}`));

/**
 * 一個指令關(瀏覽器那一關以外)在白板上是哪一件:等你決定(D 要不要再跑)、還差(找到問題還沒處理完、叫了沒記結論、分級要它卻還沒跑)、或沒有(null)。
 * 白板(stageItems)跟蓋章前的檢查(lib/cliStamp.mjs,規格:主任動手收尾 AC-5)都問這一個——卡在哪一句,兩邊講同一句(老毛病 P2)。
 * reqs:分級卡「需要」那幾行(分級讀不到就是空的:不知道要不要這一關,這裡不擋——白板另外講「不知道該跑哪幾關」)
 */
export function stageItemOf(x, { reqs = [], ago = agoNow } = {}) {
  const label = `${x.id} ${x.name}`;
  const rr = x.rerun ?? null;
  if (rr) {
    // 結論會過期的關(D):五關那一格的那一句(rerunLine)。你說不用再跑是你的決定,不列——但它也不是「通過」,所以只是不列,不講成沒事(R2)
    if (rr.state === 'ask') return askLine(label, rr.line);
    // ⏸ 一定印出過了多久(CLAUDE.md 刻意的決定):停了 47 天的「找到問題」跟剛剛找到的,不能長一樣
    if (rr.state === 'found' || rr.state === 'no-report') return item('todo', zhEn(`${label}：${x.ranAt ? ago(x.ranAt) : ''}${rr.line}`, `${label}: ${rr.line}${x.ranAt ? ` (${ago(x.ranAt)})` : ''}`));
    if (rr.state === 'skipped' || x.state === 'held') return null;
  }
  const r = reqs.find((q) => q.key === x.id) ?? null;
  return needs(r) ? reqItem(r) : null;
}

function stageItems(s, { ago }) {
  const ask = [], todo = [];
  const stages = s.stages ?? [];
  const t = s.tier ?? null;
  const reqs = t?.state === 'ok' ? (t.lines?.reqs ?? []) : [];
  const reqOf = (id) => reqs.find((r) => r.key === id) ?? null;

  // 寫規格那一關:第一個指令關(跟一輪的分界同一個認法,不寫死代號);B:就是這個對話本身
  const spec = stages.find((x) => x.skill) ?? null;
  const b = stages.find((x) => x.type === 'main-conversation') ?? null;
  const cl = stages.find((x) => x.checklist?.parsed)?.checklist ?? null;
  // 規格記好了、這一輪還沒改到程式檔,而且記好之後你還沒說過話 → 等你點頭。
  // ⚠️ 工具認不得你點頭了沒,只知道「還沒改到程式檔」:你說了「開工」、Claude 還沒動手的那段時間,不准還講「等你點頭」——
  //    那是把 Claude 的回合講成你的(老毛病 P7 那一類)。所以看的是記好之後你有沒有說過話:說了,球就在 Claude 那邊
  const doneAt = Date.parse(spec?.doneAt ?? '');
  const saidAt = Date.parse(s.lastSaidAt ?? '');
  const waitingNod = !!spec && spec.doneBy === 'claude' && Number.isFinite(doneAt) && !!b && !b.closedBy && !b.nodAt
    && !(Number.isFinite(saidAt) && saidAt > doneAt);
  const specOpen = !!spec && spec.state === 'current' && !Number.isFinite(doneAt) && !!b && !b.closedBy && !b.nodAt;
  if (waitingNod) {
    const name = cl?.multi ? zhEn(`${cl.specs} 份規格`, plural(cl.specs, 'spec')) : cl?.file ? basename(cl.file, '.md') : null;
    // hold:等你決定,但不是收尾——F 不因為它亮燈(callLine)
    ask.push({ ...askLine(`${spec.id} ${spec.name}`, zhEn(`規格寫好了，等你點頭開工${name ? `（${name}）` : ''}`, `the spec is written, waiting for your go-ahead${name ? ` (${name})` : ''}`)), hold: true });
  } else if (specOpen) {
    // 寫規格那一關叫了、還沒記結論、B 也還沒開始(規格:主任條列與工地帽 AC-5):A 那一格講「叫了…等你點頭開工」,白板照同一句列——
    // 以前一件都不列,白板上只剩「還沒蓋過章」,F 就亮「只剩收尾」(2026-11-03 實況:規格還在寫)。句子是 A 那一格那一句(老毛病 P2)。
    // ⚠️ 不看你說過話沒:寫到一半你插話(像那次插播),A 那一格照樣講等你點頭,這一件就照樣在。Claude 說找到問題是 Claude 的事,算還差
    const said = spec.line ?? stageLine(spec, { ago, first: true });
    if (spec.report?.verdict === 'found') todo.push(item('todo', zhEn(`${spec.id} ${spec.name}：${said}`, `${spec.id} ${spec.name}: ${said}`)));
    else ask.push({ ...askLine(`${spec.id} ${spec.name}`, said), hold: true });
  } else if (cl) {
    // 清單:⏳ 待討論的那幾條要跟你談,算等你決定;還沒對的是 Claude 的事。句子跟 B 那一行同一句(clProg、checklistWhy)
    const label = b ? `${b.id} ${b.name}` : spec ? `${spec.id} ${spec.name}` : '';
    if (cl.batchMissing?.length || cl.preMarked) todo.push(item('todo', zhEn(`${label}：${checklistWhy(cl)}`, `${label}: ${checklistWhy(cl)}`)));
    else if (cl.pending) ask.push({ ...askLine(label, clProg(cl)), hold: true });
    else if (cl.unmarked) todo.push(item('todo', zhEn(`${label}：${clProg(cl)}`, `${label}: ${clProg(cl)}`)));
    else if (cl.unreadable?.length) todo.push(item('unknown', zhEn(`${label}：${clProg(cl)}`, `${label}: ${clProg(cl)}`)));
  }

  for (const x of stages) {
    if (x === spec || x === b || x.type === 'not-built' || (!x.skill && x.type !== 'browser')) continue;
    const label = `${x.id} ${x.name}`;
    const r = reqOf(x.id);
    const rr = x.rerun ?? null;
    if (x.type === 'browser') {
      // E:看的是 Claude 照規格走過一遍之後在哪(伺服器照 lib/verify.mjs 算好的那一句,對話列、案件卡同一句)。
      // 你說驗收過了、你說不用再走 → 你決定了,不列;走過一遍等你查核、你驗收之後又改了程式 → 等你決定;只開過瀏覽器不算走過
      const es = rr ? (rr.estate ?? rr.state) : null;
      const said = x.ewhere ?? rr?.line ?? null;
      if (es === 'accepted' || es === 'skipped') continue;
      // onlyYou:走過一遍、等你查核——「驗收過了」只有你能說,主任不把它包進那一個問題、另外講(F 亮燈的件數不算它,callLine)。
      // 「要不要再走由你決定」(之後又改了程式、你驗收之後又改了)跟 D 一樣可以包進去
      if (said && (es === 'ok' || es === 'found' || es === 'accepted-stale' || rr?.state === 'ask')) ask.push({ ...askLine(label, said), ...(es === 'ok' || es === 'found' ? { onlyYou: true } : {}) });
      else if (said && es === 'no-report') todo.push(item('todo', zhEn(`${label}：${said}`, `${label}: ${said}`)));
      else if (needs(r)) todo.push(reqItem(r));
      continue;
    }
    const it = stageItemOf(x, { reqs, ago });
    if (it) (it.kind === 'ask' ? ask : todo).push(it);
  }
  // 補測試不是一關,分級要的時候才出現
  const tests = reqOf('tests');
  if (needs(tests)) todo.push(reqItem(tests));
  // 危險清單:定好之後才新加、沒人判斷過的檔,或清單裡已經不在了的——只有你判斷得了(規格:危險清單會過期)
  // 那幾句本來就以 ⚠️ 開頭(分級卡上它自己是一行警告);接在「等你決定」後面只拿掉那個記號,字一個不改
  for (const note of t?.staleNotes ?? []) {
    const line = String(note).replace(/^⚠️\s*/u, '');
    ask.push(item('ask', zhEn(`等你決定：${line}`, `Your call: ${line}`)));
  }

  // 不知道要哪幾關,就不准講沒事:沒設定 ≠ 不用跑(R1);原因照分級卡那一句。設定成不分級、這次沒有改動 → 本來就沒有要跑的關
  const unk = [];
  if (!t) unk.push(item('unknown', zhEn('問不到分級，不知道該跑哪幾關', 'Couldn\'t check the tier, so don\'t know which stages are needed')));
  else if (t.state !== 'ok' && t.state !== 'off' && t.state !== 'no-change') {
    const why = t.state === 'unset' ? t.lines?.setupHint : t.lines?.main;
    unk.push(item('unknown', zhEn(`不知道該跑哪幾關${why ? `：${why}` : ''}`, `Don't know which stages are needed${why ? `: ${why}` : ''}`)));
  }
  return [...ask, ...todo, ...unk];
}

/**
 * 資料夾的事:存了沒、併了沒(三階梯前兩格那一句,原封不動),與章(stamp 為 true 時)。推了沒是整個專案的事,不在這裡(AC-5)
 */
function folderItems(card, { stamp }) {
  const steps = card?.ladder?.steps ?? null;
  if (!steps) return [item('unknown', zhEn('問不到檔案存了沒、併了沒', 'Couldn\'t check whether files are committed and merged'))];
  const out = [];
  for (const step of steps) {
    if (step.id === 'push') continue;
    if (step.state === 'pending') out.push(item('todo', step.text));
    else if (step.state === 'unknown') out.push(item('unknown', step.text));
  }
  if (stamp) out.push(...stampItems(card));
  return out;
}

/**
 * 章:這條分支最新的存檔蓋了沒。章只有在它指的版本還在這條分支的歷史上才算數(lib/git.mjs 的 checkpointRelation,L14),四種狀態不准折成兩種。
 * stamp:這一件是章的事——一個檔都沒改、只剩它的時候,F 不亮(callLine)
 */
function stampItems(card) {
  const st = (text) => ({ ...item('todo', text), stamp: true });
  if (!card.checkpoint) return [st(zhEn('還沒蓋過章', 'Never stamped'))];
  const rel = card.checkpointRelation ?? null;
  if (rel?.state === 'ok') return rel.commitsAfter > 0 ? [st(zhEn(`蓋章之後又存了 ${rel.commitsAfter} 次`, `${plural(rel.commitsAfter, 'commit')} since the last stamp`))] : [];
  if (rel?.state === 'off-branch') return [st(zhEn('章指的版本不在這條分支上，回不去', 'The stamp points to a version that isn\'t on this branch, so it can\'t be gone back to'))];
  if (rel?.state === 'gone') return [st(zhEn('章指的版本已經不在了，回不去', 'The stamp points to a version that no longer exists, so it can\'t be gone back to'))];
  return [item('unknown', zhEn('問不到章跟現在差幾次存檔', 'Couldn\'t check how many commits there are since the stamp'))];
}

/* ════════════ 儀表板的服務要不要重啟(AC-7) ════════════ */

/**
 * 服務用到的程式:server.mjs 與 lib/ 底下的 .mjs。修改時間比服務啟動那一刻晚的,就是它還沒讀進來的。
 * 畫面那兩個檔(ui/app.js、ui/ui.css)每次都重新讀、開著的分頁自己會重新載入;文件、測試服務不讀——都不算。
 * 讀不到回 null:讀不到 ≠ 沒改過(R1)
 */
export function programChanges(dir, bootMs) {
  let files;
  try { files = ['server.mjs', ...readdirSync(join(dir, 'lib')).filter((f) => f.endsWith('.mjs')).sort().map((f) => `lib/${f}`)]; }
  catch { return null; }
  return files.filter((f) => {
    try { return statSync(join(dir, f)).mtimeMs > bootMs; }
    catch { return true; }                     // 列得到、讀不到:就在這一刻被換掉了,算改過
  });
}

/** 要重啟的那一句。沒改過 → null(不講);問不到 → 講問不到,不准當成不用重啟 */
export function restartLine({ bootAt = null, changed = null } = {}, { ago = agoNow } = {}) {
  if (!Array.isArray(changed)) return zhEn('⚠️ 問不到儀表板的服務啟動之後程式有沒有改過', '⚠️ Couldn\'t check whether the program changed after the dashboard service started');
  if (!changed.length) return null;
  const n = changed.length;
  const few = zhEn(`${changed.slice(0, 3).join('、')}${n > 3 ? ` 等 ${n} 個檔` : ''}`, `${changed.slice(0, 3).join(', ')}${n > 3 ? ` and others (${n} files)` : ''}`);
  const when = bootAt ? ago(bootAt) : null;
  return zhEn(`⚠️ 儀表板的服務還在跑${when ? ` ${when}` : ''}啟動時的程式，之後 ${few} 改過——跑 pipeline-status --serve-restart`,
    `⚠️ The dashboard service is still running the program from when it started${when ? ` (${when})` : ''}, and ${few} changed since: run pipeline-status --serve-restart`);
}

/** 終端機那一張才用得到的幾句:連不上服務、服務太久沒回、服務是舊的(還不會回答)。都不准講成「不用重啟」(R1) */
export function serveDownLine() {
  return zhEn('⚠️ 連不上儀表板的服務（沒在跑，或連不上），不知道它要不要重啟——看是哪一種：pipeline-status --serve-status',
    '⚠️ Couldn\'t connect to the dashboard service (not running, or can\'t connect), so it\'s unknown whether it needs a restart. To see which: pipeline-status --serve-status');
}
/** 連得上、等不到:服務一次只能做一件事,正在替開著的分頁算整頁(要好幾秒)時,這一題就排在後面——不准講成沒在跑(魔鬼教官第一輪,R1) */
export function serveSlowLine(seconds) {
  return zhEn(`⚠️ 儀表板的服務 ${seconds} 秒內沒回答（可能正忙著替開著的分頁算整頁），不知道它要不要重啟——再跑一次 pipeline-status --todo`,
    `⚠️ The dashboard service didn't answer within ${seconds} seconds (it might be busy working out a full page for an open tab), so it's unknown whether it needs a restart. Run pipeline-status --todo again`);
}
export function serveOldLine() {
  return zhEn('⚠️ 儀表板的服務還在跑舊的程式（它還不會回答啟動之後程式有沒有改過）——跑 pipeline-status --serve-restart',
    '⚠️ The dashboard service is still running an old program (it can\'t yet answer whether the program changed after it started): run pipeline-status --serve-restart');
}

/* ════════════ 終端機的版面(AC-8)——字跟網頁同一份,只有排法是終端機的 ════════════ */

/**
 * faults:collectAll 的 faults.banner(每一頁上方那幾條,終端機印在最上面)。
 * here:跑這個指令的對話(Claude 跑的時候環境給的對話代號,lib/cliFacts.mjs 的 sessionFromEnv)——那一行標「← 這個對話」,
 *   主任才知道要把哪一行的收尾合成一個問題(規格:主任技能 AC-6)。照代號標,不照標題:同名的、還沒有標題的對話很常見
 */
export function boardText(b, { faults = [], here = null } = {}) {
  const L = [zhEn(`${b.head}（所有專案）`, `${b.head} (all projects)`), b.note];
  for (const f of faults) L.push(f.text);
  if (b.restart) L.push(b.restart);
  const hl = hereLine(b, here);
  if (hl) L.push(hl);
  if (b.empty) L.push('', b.empty);
  const mark = zhEn('　← 這個對話', '  ← this conversation');
  for (const p of b.projects) {
    if (p.quiet && !p.cards) continue;        // 沒事的併在最後那一句;還有沒開始的建議卡的自己一段(AC-7)
    L.push('', zhEn(`【${p.displayName}】`, `[${p.displayName}]`));
    if (p.note) L.push(`  ${p.note}`);
    if (p.quiet) L.push(`  ${p.quiet}`);
    if (p.push) L.push(`  ${p.push}`);
    if (p.cards) L.push(`  ${p.cards}`);
    for (const r of p.rows) {
      const me = here && r.id === here ? mark : '';
      L.push(zhEn(`  ・${r.title}　${r.closedNote ? `${r.closedNote} · ` : ''}${r.last}${me}`, `  - ${r.title}  ${r.closedNote ? `${r.closedNote} · ` : ''}${r.last}${me}`));
      for (const i of r.items) L.push(`      ${i.text}`);
      if (r.clear) L.push(`      ${r.clear}`);
    }
  }
  if (b.quiet) L.push('', b.quiet);
  return L;
}

/**
 * 「這個對話」不在白板上的那一句(規格:主任技能 AC-6)。here 沒有(人自己在終端機跑、環境沒給代號)→ 不講,也不標。
 * 在白板上 → 那一行自己標,這裡不講;不在 → 講為什麼——按過結案(附 F 工地主任那一關的那一句)、或紀錄裡根本找不到它。
 * ⚠️ 不准安靜地一行都不標:主任看不到箭頭,就會照標題猜,猜錯就把別的對話的收尾排給你(R1)
 */
export function hereLine(b, here) {
  if (!here) return null;
  if ((b?.projects ?? []).some((p) => p.rows.some((r) => r.id === here))) return null;
  const d = b?.desk?.[here];
  if (d?.closed) {
    const why = d.items?.[0]?.text ?? null;
    return zhEn(`← 這個對話（${d.closedNote}）不在白板上${why ? `：${why}` : ''}`, `← This conversation (${d.closedNote}) isn't on the board${why ? `: ${why}` : ''}`);
  }
  return zhEn('← 紀錄裡找不到這個對話（感測器沒記到它，或它的專案退出記錄了），分不出白板上哪一行是它',
    '← This conversation isn\'t in the records (the sensor didn\'t record it, or its project stopped recording), so which line on the board is it can\'t be told');
}

/* ════════════ --cards:這個專案的建議卡(規格:主任技能 AC-7) ════════════ */

/**
 * 主任開卡之前拿它查「同一件事有沒有卡了」:還沒開始、已開始、你說不做了、被同名的取代,都算有。狀態只照 cardState 一個判斷。
 * 每一張的說明是網頁那一區的精簡版——那一區有連結、截短記號、收回與開卡的提示,這裡只留查有沒有要用的:標題、哪一種、多久前、哪個對話提的、要貼的話的第一行。
 * ⚠️ 一張都沒有不准講「沒有」:紀錄裡沒有 ≠ 沒跳過(P5)。有些卡這裡看不到,原因寫在案件頁那一區,不在這裡另抄一份
 * @param name collectAll 的專案名(紀錄檔名那一個,lib/events.mjs 的 safeName)
 */
export function cardsText(all, name, { ago = agoNow } = {}) {
  const projects = all?.projects ?? [];
  const p = projects.find((x) => x.name === name);
  if (!p) return [zhEn(`紀錄裡找不到這個專案（${name}），看不到它的建議卡`, `This project (${name}) isn't in the records, so its suggestion cards can't be seen`)];
  const L = [zhEn(`建議卡（${p.displayName ?? p.name}）`, `Suggestion cards (${p.displayName ?? p.name})`)];
  const head = {
    open: zhEn('還沒開始', 'Not started yet'), started: zhEn('已開始', 'Started'),
    dismissed: zhEn('你說不做了', 'You said you\'re not doing it'), superseded: zhEn('被同一個對話後來提的同名卡取代', 'Replaced by a card with the same name raised later in the same conversation'),
  };
  const all4 = p.suggestions ?? [];
  for (const k of ['open', 'started', 'dismissed', 'superseded']) {
    const list = all4.filter((sg) => cardState(sg) === k);
    if (!list.length) continue;
    L.push('', zhEn(`${head[k]}（${list.length} 張）`, `${head[k]} (${list.length})`));
    for (const sg of list) L.push(...cardLines(sg, k, { ago }));
  }
  // 別的專案提、要開在這裡、還沒開始的:卡住在提的那個專案那一頁,這裡只指路(跟網頁同一個做法)
  const incoming = projects.filter((q) => q !== p).flatMap((q) => (q.suggestions ?? [])
    .filter((sg) => sg.openIn?.project === p.name && cardState(sg) === 'open').map((sg) => ({ sg, q })));
  if (incoming.length) {
    L.push('', zhEn(`別的專案提、要開在這裡、還沒開始的（${incoming.length} 張）`, `Raised in other projects, to be opened here, not started yet (${incoming.length})`));
    for (const { sg, q } of incoming) L.push(zhEn(`  ・${sg.title}　在「${q.displayName ?? q.name}」的案件頁 · ${ago(sg.ts)}`, `  - ${sg.title}  on the "${q.displayName ?? q.name}" project page · ${ago(sg.ts)}`));
  }
  if (!all4.length && !incoming.length) L.push('', zhEn('紀錄裡沒有這個專案的建議卡——不代表沒跳過。', 'There are no suggestion cards for this project in the records; that doesn\'t mean none came up.'));
  L.push('', zhEn('紀錄裡沒有的卡不代表沒有：有些卡這裡看不到，原因在案件頁「建議新增的對話」那一區的說明。',
    'A card missing from the records doesn\'t mean there wasn\'t one: some cards can\'t be seen here; why is explained in "Suggested new conversations" on the project page.'));
  return L;
}

/** 一張卡那幾行。還沒開始的多兩行(哪來的、要貼的話的第一行),其他狀態一行講到收起來的理由為止 */
function cardLines(sg, k, { ago }) {
  const t = `${sg.title ?? zhEn('（沒有標題）', '(no title)')}${(sg.cut ?? []).includes('title') ? '…' : ''}`;
  if (k === 'started') {
    const where = sg.startedProject ? zhEn(`（在 ${sg.startedProject.name ?? sg.startedProject.project}）`, ` (in ${sg.startedProject.name ?? sg.startedProject.project})`) : '';
    return [sg.startedTitle ? zhEn(`  ・${t} → 「${sg.startedTitle}」${where}`, `  - ${t} → "${sg.startedTitle}"${where}`)
      : zhEn(`  ・${t} → 有對話這樣開頭了，但那個對話不在列得出來的專案裡`, `  - ${t} → a conversation started this way, but it isn't in any project that can be listed`)];
  }
  if (k === 'dismissed') return [zhEn(`  ・${t}（你 ${ago(sg.dismissedAt)}按了「不做了」）`, `  - ${t} (you pressed "Not doing it" ${ago(sg.dismissedAt)})`)];
  if (k === 'superseded') return [zhEn(`  ・${t}（${ago(sg.supersededAt)}又提了同名的卡）`, `  - ${t} (a card with the same name was raised ${ago(sg.supersededAt)})`)];
  // 還沒開始:哪來的。--suggest 放的沒有對話代號,分不出是哪個對話放的——照講,不算到誰頭上(P7)
  const from = sg.session ? (sg.fromTitle ? zhEn(`來自「${sg.fromTitle}」`, `from "${sg.fromTitle}"`) : zhEn('提它的對話不在列得出來的專案裡', 'the conversation that raised it isn\'t in any project that can be listed'))
    : zhEn('分不出是哪個對話放的', 'which conversation placed it can\'t be told');
  const kind = sg.ask === 'offer' ? zhEn('當場問你要不要開的卡', 'a card asking you on the spot') : sg.source === 'app' ? zhEn('對話裡提的卡', 'a card raised in a conversation') : zhEn('--suggest 放的', 'placed with --suggest');
  const out = [zhEn(`  ・${t}`, `  - ${t}`), `      ${kind} · ${ago(sg.ts)} · ${from}`];
  if (sg.openIn) out.push(`      ${sg.openIn.name ? zhEn(`要開在「${sg.openIn.name}」`, `to be opened in "${sg.openIn.name}"`) : zhEn('要開在別的資料夾（路徑沒記完整）', 'to be opened in another folder (the path wasn\'t recorded in full)')}`);
  // 要貼的話的第一行。當場問的卡沒有下文時,那段是監視器照標題湊的,不是 Claude 寫的(跟網頁那一區同一個認法)
  const prompt = String(sg.prompt ?? '');
  const first = prompt.split('\n').find((l) => l.trim()) ?? '';
  if (sg.ask === 'offer' && !sg.brief) out.push(`      ${zhEn('Claude 沒寫說明（要貼的那段是監視器照標題湊的）', 'Claude didn\'t write a description (the text to paste was put together by the monitor from the title)')}`);
  else if (first.trim()) out.push(`      ${zhEn('要貼的話：', 'To paste: ')}${first.slice(0, 80)}${first.length > 80 || prompt.trim() !== first.trim() ? '…' : ''}`);
  else out.push(`      ${zhEn('這張卡沒有要貼的話', 'This card has nothing to paste')}`);
  return out;
}
