#!/usr/bin/env node
/**
 * director.test.mjs —— 主任技能(規格:主任技能,路徑看 CLAUDE.md 的表)。主任是一支技能,它照終端機印的字分路;
 * 這裡釘的是會讓它安靜講錯的地方:分不出哪一行是「這個對話」就照標題猜(R1)、看不到建議卡就重開一張(P5)、
 * 「還沒開始」的判斷三份各說各話(P2)、技能照著分路的字跟指令印的字對不上(P2)、叫主任挪動了這一輪(P2)。長相不釘。
 */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { todoBoard, boardText, hereLine, cardsText } from '../lib/todo.mjs';
import { doTodo, doCards } from '../lib/cliTodo.mjs';
import { cardState } from '../lib/rounds.mjs';
import { collectAll } from '../lib/collect.mjs';
import { withLang } from '../lib/lang.mjs';
import { CJK } from './_zhscan.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGO = () => '3 分鐘前';

/* ── 假資料:長得跟 collectAll 給的一樣(真的跑一次在 AC-6、AC-7、AC-8 那幾段) ── */
const step = (id, state, text) => ({ id, state, text });
const ladder = () => ({ steps: [step('commit', 'done', '都存好了'), step('merge', 'done', '併進 main 了'), step('push', 'done', 'GitHub 上的跟 main 一樣')] });
const card = (o = {}) => ({ path: '/w/a', gone: false, notGit: false, ladder: ladder(), checkpoint: { commit: 'abc' }, checkpointRelation: { state: 'ok', commitsAfter: 2 }, ...o });
const stages = () => [
  { id: 'A', name: '寫規格', skill: 'spec', state: 'passed', doneBy: 'claude', doneAt: '2026-11-01T01:00:00Z', checklist: { parsed: true, total: 1, checked: 1, unmarked: 0, pending: 0 } },
  { id: 'B', name: '寫程式', type: 'main-conversation', state: 'main', closedBy: 'checklist', nodAt: '2026-11-01T02:00:00Z' },
];
const tier = { state: 'ok', lines: { reqs: [], main: null }, staleNotes: [] };
const sess = (o = {}) => ({ id: 's1', title: '做某件事', cwd: '/w/a', lastTs: '2026-11-01T03:00:00Z', lastSaidAt: '2026-11-01T01:30:00Z',
  closedAt: null, deletedAt: null, movedOn: null, stages: stages(), tier, card: card(), ...o });
const proj = (sessions, o = {}) => ({ name: 'p', displayName: 'P 專案', mainRoot: '/w/main', cards: [card({ path: '/w/main' })], sessions, suggestions: [], ...o });
const board = (projects, ago = AGO) => todoBoard({ projects }, { ago });
const sg = (o = {}) => ({ id: 'k', title: '一張卡', ts: '2026-11-01T00:00:00Z', source: 'claude', session: null, prompt: '照規格做第二段。\n第二行', cut: [], ask: null, brief: null,
  dismissedAt: null, startedBy: null, supersededAt: null, openIn: null, startedTitle: null, startedProject: null, fromTitle: null, ...o });

/** 真的跑整支 ui/app.js(L20):只拿掉最上面的 import 與最下面的輪詢,DOM、計時器、網路換成假的 */
function uiOf(latest, { lang = 'zh' } = {}) {
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const body = src.replace(/^import .*$/m, '').replace(/^pollLoop\(\);$/m, '').replace(/^setInterval\(paintFreshness, 1000\);$/m, '');
  const noop = () => {};
  const el = () => ({ dataset: {}, classList: { toggle: noop }, innerHTML: '', textContent: '', setAttribute: noop });
  // 一頁的語言是伺服器寫在 <html data-lang> 的那一種(ui/app.js 最上面讀它)
  const document = { getElementById: el, addEventListener: noop, body: el(), activeElement: null, documentElement: { dataset: { lang } } };
  const make = new Function('describeFreshness', 'STALE_AFTER_SECONDS', 'document', 'window', 'localStorage', 'location', 'setTimeout', 'setInterval', 'fetch', '__LATEST',
    `${body}\nlatest = __LATEST;\nreturn { workflow, directorOf, cardFolded };`);
  return make(() => ({ label: '', state: 'fresh', dim: false }), 60, document, { addEventListener: noop }, { getItem: () => null, setItem: noop },
    { hash: '' }, noop, noop, () => Promise.reject(new Error('測試不連網路')), latest);
}

/** F 工地主任那一格「細節」以外的那一段(規格:主任條列與工地帽 AC-1、AC-2):外面該留的但書要在這一段找得到。拿不到回 null */
function outsideOf(html) {
  const at = html.indexOf('class="acard adirector"');
  const end = at < 0 ? -1 : html.indexOf('<details class="amore"', at);
  return end < 0 ? null : html.slice(at, end);
}

/** 印到終端機的每一行收起來(doTodo、doCards 直接 console.log) */
async function printed(fn) {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try { await fn(); } finally { console.log = orig; }
  return out;
}

/** 一個真的資料夾、真的紀錄檔:events 寫進 monitorDir/logs/<資料夾名>.jsonl */
function realSetup(events) {
  const repo = makeRepo({ files: { 'a.txt': 'x\n' } });
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  const log = join(monitorDir, 'logs', `${basename(repo.dir)}.jsonl`);
  writeFileSync(log, events(repo.dir).map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { repo, monitorDir, home, log, cleanup: () => { repo.cleanup(); rmSync(monitorDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}
const base = Date.now();
const T = (m) => new Date(base - m * 60_000).toISOString();

section('AC-6:終端機的白板標出「這個對話」——照代號標,不照標題;拿不到代號不標;不在白板上要講為什麼,不准一行都不標', 'P5');
{
  // 必抓:兩個對話同名(還沒有標題的對話很常見),標的是對的那一個
  const a = sess({ id: 'a', title: '同一個名字', cwd: '/w/a' });
  const b2 = sess({ id: 'b', title: '同一個名字', cwd: '/w/b', card: card({ path: '/w/b' }) });
  const closed = sess({ id: 'c', title: '收好的', cwd: '/w/c', closedAt: '2026-11-01T05:00:00Z', card: card({ path: '/w/c', checkpointRelation: { state: 'ok', commitsAfter: 0 } }) });
  const bd = board([proj([a, b2, closed])]);
  const lines = boardText(bd, { here: 'b' });
  const marked = lines.filter((l) => l.includes('← 這個對話'));
  eq('只有一行標了箭頭', marked.length, 1);
  check('……標的是代號對得上的那一個(第二個同名的),不是先出現的那一個', lines.indexOf(marked[0]) > lines.findIndex((l) => l.includes('同一個名字')), lines.join('\n'));
  check('拿不到對話代號(人自己在終端機跑)→ 一行都不標,最上面也不講', !boardText(bd).some((l) => l.includes('← ')), boardText(bd).join('\n'));
  eq('……hereLine 也是 null', hereLine(bd, null), null);
  const shut = hereLine(bd, 'c');
  check('這個對話按過結案、白板上不列 → 最上面講它已結案、附 F 那一關那一句', /← 這個對話（已結案）不在白板上：資料夾裡沒有沒存、沒併的東西/.test(shut ?? ''), shut);
  check('……那一句真的印在白板最上面', boardText(bd, { here: 'c' }).slice(0, 4).includes(shut));
  const lost = hereLine(bd, 'zzz');
  check('必抓:紀錄裡找不到這個對話 → 照講,分不出哪一行是它(不准安靜地一行都不標)', /紀錄裡找不到這個對話/.test(lost ?? '') && /分不出白板上哪一行是它/.test(lost ?? ''), lost);
  eq('在白板上的那一個 → 不另外講', hereLine(bd, 'a'), null);

  // 真的資料:環境給的對話代號(Claude Code 的 CLAUDE_CODE_SESSION_ID)就是它認的那一個
  const r = realSetup((dir) => [
    { ts: T(10), hook: 'UserPromptSubmit', session: 's1', cwd: dir, prompt: '做一件事' },
    { ts: T(9), hook: 'UserPromptSubmit', session: 's2', cwd: dir, prompt: '做另一件事' },
  ]);
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 's1';
  const out = await printed(() => doTodo({ monitorDir: r.monitorDir, ask: async () => null }));
  if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev;
  eq('真的跑 --todo:環境給 s1 → 標一行', out.filter((l) => l.includes('← 這個對話')).length, 1);
  const out2 = await printed(() => doTodo({ monitorDir: r.monitorDir, ask: async () => null, here: null }));
  check('真的跑 --todo:沒有對話代號 → 不標', !out2.some((l) => l.includes('← ')), out2.join('\n'));
  r.cleanup();
}

section('AC-7:建議卡「還沒開始」終端機、伺服器、網頁同一個判斷——cardState 跟網頁的 cardFolded 逐種對', 'P2');
{
  const ui = uiOf({ projects: [] });
  let n = 0;
  for (const startedBy of [null, 'x']) for (const supersededAt of [null, '2026-11-01T00:00:00Z']) for (const dismissedAt of [null, '2026-11-01T00:00:00Z']) {
    const s = sg({ startedBy, supersededAt, dismissedAt });
    check(`開始了 ${!!startedBy}、被取代 ${!!supersededAt}、不做了 ${!!dismissedAt}:兩邊都說${ui.cardFolded(s) ? '收起來了' : '還沒開始'}`, (cardState(s) !== 'open') === ui.cardFolded(s), cardState(s));
    n++;
  }
  eq('八種都比過(不然上面什麼都沒比到)', n, 8);
  eq('開始了又按過不做了 → 算已開始(看得到的事實優先,跟網頁那一區講的理由一樣)', cardState(sg({ startedBy: 'x', dismissedAt: '2026-11-01T00:00:00Z' })), 'started');
}

section('AC-7:--todo 每個專案一行還沒開始的建議卡;沒有對話要列、卻有卡的專案照樣自己一段,不收進「沒有進行中的對話」那一句', 'P5');
{
  const p1 = proj([sess()], { suggestions: [sg(), sg({ id: 'k2', startedBy: 'x' }), sg({ id: 'k3', dismissedAt: '2026-11-01T00:00:00Z' })] });
  eq('只數還沒開始的(已開始、不做了的不算)', board([p1]).projects[0].cards?.match(/還沒開始的建議卡 (\d+) 張/)?.[1], '1');
  const inc = board([proj([], { name: 'q', displayName: 'Q', suggestions: [], incomingSuggestions: [{ project: 'p', name: 'P', count: 2 }] })]).projects[0];
  check('必抓:自己這邊 0 張、別的專案有 2 張要開在這裡 → 講出來(這個 0 有兩種意思)', /別的專案還有 2 張要開在這裡/.test(inc.cards ?? ''), inc.cards);
  eq('一張都沒有 → 不講這一行', board([proj([sess()])]).projects[0].cards, null);
  const lonely = proj([], { name: 'q', displayName: '只剩卡的專案', suggestions: [sg()] });
  const quiet = proj([], { name: 'r', displayName: '沒事的專案' });
  const b = board([lonely, quiet]);
  const text = boardText(b);
  check('沒有對話要列、卻有還沒開始的卡 → 自己一段,卡那一行在裡面', text.includes('【只剩卡的專案】') && text.some((l) => l.includes('還沒開始的建議卡 1 張')), text.join('\n'));
  check('……那一段照樣寫為什麼沒有對話要列(不准空著)', text.some((l) => l.includes('沒有進行中的對話')), text.join('\n'));
  check('……不收進最後「其他 N 個專案沒事」那一句;真的沒事的才收', !(b.quiet ?? '').includes('只剩卡的專案') && (b.quiet ?? '').includes('沒事的專案'), b.quiet);
}

section('AC-7:--cards 印這個專案每一張卡——四種狀態各一區,還沒開始的講哪來的、要貼的話;一張都沒有不准講沒有', 'P5');
{
  const p = proj([], { suggestions: [
    sg({ id: 'o1', title: '當場問的', ask: 'offer', source: 'app', session: 's9', fromTitle: '前一個對話', prompt: '監視器湊的' }),
    sg({ id: 'o2', title: '對話裡提的', source: 'app', session: 's9', fromTitle: '前一個對話', openIn: { project: 'q', name: 'Q 專案' } }),
    sg({ id: 'o3', title: '指令放的' }),
    sg({ id: 'd1', title: '開始了的', startedBy: 's7', startedTitle: '照卡開的對話' }),
    sg({ id: 'd2', title: '不做了的', dismissedAt: '2026-11-01T00:00:00Z' }),
    sg({ id: 'd3', title: '被取代的', supersededAt: '2026-11-01T00:00:00Z' }),
  ] });
  const q = proj([], { name: 'q', displayName: 'Q 專案', suggestions: [sg({ id: 'x1', title: '要開在 P 的卡', openIn: { project: 'p', name: 'P 專案' } }), sg({ id: 'x2', title: '要開在 P、已開始', openIn: { project: 'p' }, startedBy: 'z' })] });
  const L = cardsText({ projects: [p, q] }, 'p', { ago: AGO }).join('\n');
  check('還沒開始的一區,張數照數', L.includes('還沒開始（3 張）'), L);
  check('當場問的卡講是當場問的,而且講要貼的那段是監視器湊的(不是 Claude 寫的)', L.includes('當場問你要不要開的卡 · 3 分鐘前 · 來自「前一個對話」') && L.includes('Claude 沒寫說明'), L);
  check('對話裡提的卡講來自哪個對話、要開在哪', L.includes('對話裡提的卡 · 3 分鐘前 · 來自「前一個對話」') && L.includes('要開在「Q 專案」'), L);
  check('必抓:--suggest 放的分不出是哪個對話放的 → 照講,不算到誰頭上(P7)', L.includes('--suggest 放的 · 3 分鐘前 · 分不出是哪個對話放的'), L);
  check('還沒開始的附要貼的話的第一行(後面還有就加…)', L.includes('要貼的話：照規格做第二段。…'), L);
  check('已開始講是哪個對話照它開的', L.includes('已開始（1 張）') && L.includes('開始了的 → 「照卡開的對話」'), L);
  check('你說不做了的照講(主任看到就不准再開)', L.includes('你說不做了（1 張）') && L.includes('不做了的（你 3 分鐘前按了「不做了」）'), L);
  check('被同名的取代的照講', L.includes('被同一個對話後來提的同名卡取代（1 張）'), L);
  check('別的專案提、要開在這裡、還沒開始的指過去;已開始的不算', L.includes('別的專案提、要開在這裡、還沒開始的（1 張）') && L.includes('要開在 P 的卡　在「Q 專案」的案件頁') && !L.includes('要開在 P、已開始'), L);
  check('最後一句講紀錄裡沒有的卡不代表沒有', L.includes('紀錄裡沒有的卡不代表沒有'), L);
  const empty = cardsText({ projects: [proj([])] }, 'p', { ago: AGO }).join('\n');
  check('必抓:一張都沒有 → 講紀錄裡沒有、不代表沒跳過,不講「沒有建議卡」(P5)', empty.includes('紀錄裡沒有這個專案的建議卡——不代表沒跳過'), empty);
  const missing = cardsText({ projects: [] }, 'p', { ago: AGO }).join('\n');
  check('紀錄裡找不到這個專案 → 講看不到,不講沒有', missing.includes('紀錄裡找不到這個專案') && missing.includes('看不到它的建議卡'), missing);

  // 真的資料:--suggest 寫的那一筆,照紀錄檔名認專案(safeName),--cards 印得出來
  const r = realSetup((dir) => [
    { ts: T(10), hook: 'UserPromptSubmit', session: 's1', cwd: dir, prompt: '做一件事' },
    { ts: T(5), event: 'suggestion', id: 'sg-1', title: '下一段：真的那張', prompt: '照規格做下一段', cwd: dir, source: 'claude' },
  ]);
  const out = (await printed(() => doCards({ project: basename(r.repo.dir) }, { monitorDir: r.monitorDir }))).join('\n');
  check('真的跑 --cards:紀錄裡那張印出來,算還沒開始', out.includes('還沒開始（1 張）') && out.includes('下一段：真的那張'), out);
  r.cleanup();
}

section('AC-8:叫主任不算任何一關,也不挪動「這一輪」——叫之前、叫之後,五關與這一輪的起點一樣', 'P2');
{
  const r = realSetup((dir) => [
    { ts: T(60), hook: 'UserPromptSubmit', session: 's1', cwd: dir, prompt: '寫規格' },
    { ts: T(55), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', session: 's1', cwd: dir },
    { ts: T(40), hook: 'PostToolUse', tool: 'Write', session: 's1', cwd: dir, file: join(dir, 'a.txt') },
    { ts: T(30), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:chaos-check', session: 's1', cwd: dir },
  ]);
  const view = () => {
    const s = collectAll({ monitorDir: r.monitorDir, skillHome: r.home, appTitles: new Map() }).projects[0]?.sessions?.find((x) => x.id === 's1');
    return { stages: (s?.stages ?? []).map((x) => ({ id: x.id, state: x.state, ranAt: x.ranAt ?? null, line: x.line ?? null })), roundFrom: s?.roundFrom ?? null };
  };
  const before = view();
  check('叫之前:A 與 D 都有紀錄(不然下面比的是兩個空的)', before.stages.some((x) => x.id === 'A' && x.state !== 'none') && before.stages.some((x) => x.id === 'D' && x.state !== 'none'), JSON.stringify(before));
  appendFileSync(r.log, JSON.stringify({ ts: T(5), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:director', session: 's1', cwd: r.repo.dir }) + '\n');
  appendFileSync(r.log, JSON.stringify({ ts: T(4), hook: 'PreToolUse', tool: 'Skill', skill: 'director', session: 's1', cwd: r.repo.dir }) + '\n');
  const after = view();
  eq('叫主任之後:五關每一格一樣', JSON.stringify(after.stages), JSON.stringify(before.stages));
  eq('……這一輪的起點一樣', after.roundFrom, before.roundFrom);
  const st = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  check('主任不在 stages.json 裡(第一段定的:F 不是關)', !st.some((x) => x.skill === 'director' || x.id === 'F'), JSON.stringify(st.map((x) => x.id)));
  r.cleanup();
}

section('技能照指令的字分路:找「這個對話」的那幾句、建議卡那一行、照哪份規格,真的是指令印的字——指令改了字、技能沒跟上,這裡紅', 'P2');
{
  const skill = readFileSync(join(ROOT, 'skills', 'director', 'SKILL.md'), 'utf8');
  for (const lang of ['zh', 'en']) {
    // 白板要在那一種語言裡算:已結案那幾個字是算白板的時候就定了的
    const bd = withLang(lang, () => board([proj([sess({ id: 'c', closedAt: '2026-11-01T05:00:00Z', card: card({ checkpointRelation: { state: 'ok', commitsAfter: 0 } }) })])]));
    const [mark, shut, lost, cards] = withLang(lang, () => [
      boardText(board([proj([sess()])]), { here: 's1' }).find((l) => /←/.test(l)) ?? '',
      hereLine(bd, 'c') ?? '', hereLine(bd, 'zzz') ?? '',
      board([proj([sess()], { suggestions: [sg()] })]).projects[0].cards ?? '']);
    const keys = lang === 'zh' ? ['← 這個對話', '← 這個對話（已結案）不在白板上', '← 紀錄裡找不到這個對話', 'pipeline-status --cards']
      : ['← this conversation', '← This conversation (closed) isn\'t on the board', '← This conversation isn\'t in the records', 'pipeline-status --cards'];
    [mark, shut, lost, cards].forEach((printedLine, i) => {
      check(`技能的表有「${keys[i]}」(${lang}),而且是指令真的會印的字`, skill.includes(keys[i]) && printedLine.includes(keys[i]), printedLine);
    });
  }
  // --round E 講「照哪份規格」有好幾種說法:技能每一種都要列——只認一份的話,好幾份只讀一份的「接下來」、找不到被當成沒有(魔鬼教官第一輪,P2／R1)
  const src = readFileSync(join(ROOT, 'lib', 'cliRerun.mjs'), 'utf8').replace(/\\'/g, '\'');
  for (const k of ['照這份規格驗：', 'Verify against this spec: ', 'Verify against these ', '讀不到', 'can\'t be read', '規格：找不到這一輪的規格檔', 'Spec: can\'t find this round\'s spec file', '這一輪沒有規格', 'This round has no spec']) {
    check(`技能找這一輪的規格靠「${k.trim()}」,那是 --round E 真的會印的字`, skill.includes(k.trim()) && src.includes(k), k);
  }
  check('技能找這一輪的規格靠「照這 N 份規格驗」,那是 --round E 真的會印的字', /照這 N 份規格驗/.test(skill) && /照這 \$\{vl\.specs\.length\} 份規格驗/.test(src));
}

section('實況走一遍:白板上一個箭頭都沒有,有兩種意思——拿不到對話代號、或 pipeline-status 是還不會標的舊版;技能兩種都講,不照標題猜', 'P5');
{
  // 2026-11-03 照技能自己走一遍時真的碰到:pipeline-status 指著主資料夾,那時還是舊版,環境明明有對話代號,白板一個箭頭都沒有
  const skill = readFileSync(join(ROOT, 'skills', 'director', 'SKILL.md'), 'utf8');
  const row = skill.split('\n').find((l) => l.startsWith('| 一個箭頭都沒有')) ?? '';
  check('那一列兩種原因都列(拿不到對話代號、還不會標箭頭的舊版)', row.includes('拿不到對話代號') && row.includes('還不會標箭頭的舊版'), row);
  check('……而且講分不出是哪一種、不照標題猜', row.includes('分不出是哪一種') && skill.includes('都不照標題猜'), row);
}

section('AC-10、AC-4(主任動手收尾 AC-1、AC-6、AC-7 改過):回答之前不動手,回答之後只走 --wrap、只做問題裡的;「照建議收尾」不准拿來繞過 D 要不要再跑');
{
  const skill = readFileSync(join(ROOT, 'skills', 'director', 'SKILL.md'), 'utf8');
  const tools = skill.match(/^allowed-tools:(.*)$/m)?.[1] ?? '';
  check('先許可的指令裡有讀總表、查卡、收尾那一支(不然主任每次都要問)', tools.includes('pipeline-status --todo') && tools.includes('pipeline-status --cards') && tools.includes('pipeline-status --wrap'), tools);
  // 併、推、重啟、蓋章只准走 --wrap:它先在紀錄裡找你的原話、做完自己確認。直接叫的那幾個不先許可。git merge-base 只讀(查存檔在不在 main 上),不算併
  for (const [bad, re] of [['git merge', /git merge(?!-base)/], ['git push', /git push/], ['--serve-restart', /--serve-restart/], ['--checkpoint', /--checkpoint/], ['--decide', /--decide/], ['git commit', /git commit/]]) {
    check(`先許可的指令裡沒有「${bad}」(直接叫就少了找原話、自己確認那兩道)`, !re.test(tools), tools);
  }
  check('回答之後每一步走哪一個指令都寫了', ['merge', 'push', 'restart', 'stamp'].every((s) => skill.includes(`pipeline-status --wrap ${s} "<原話>"`)), skill.slice(-2500));
  check('不是照做的回答 → 一步都不做;第一個不是成了、不用的就停;不准把沒成、問不到講成成了',
    skill.includes('**一步都不做**') && skill.includes('第一個不是「成了」「不用」的就停') && skill.includes('不准把沒成、問不到講成成了'));
  check('說明裡講明「照建議收尾」是在回答它,不是叫它', /「照建議收尾」是在回答它，不是叫它/.test(skill) && /that's an answer to it, not a call for it/.test(skill));
  check('D 修完要再問、蓋章不准拿來跳過這一題', skill.includes('修完會再問你一次要不要再跑；蓋章等你回答之後才蓋') && skill.includes('不准拿蓋章跳過這一題'));
  check('「驗收過了」只有使用者能說,不包進照建議收尾', skill.includes('「驗收過了」只有使用者能說') && skill.includes('照建議收尾不算這一句'));
  check('開卡之前先查,說不做了的不准再開', skill.includes('pipeline-status --cards') && skill.includes('不准再開'));
}

section('魔鬼教官第一輪:主任開卡的來源不把對話開頭別的對話、app 包進來的說明當成使用者說的(寫這份技能的對話,第一則就是另一個 Claude 寫的)', 'P7');
{
  const skill = readFileSync(join(ROOT, 'skills', 'director', 'SKILL.md'), 'utf8');
  check('技能點名那兩種包裝(Background／Task from the session that started this one),寫明不算使用者說的', skill.includes('Background (from the session that started this one)')
    && skill.includes('Task (from the session that started this one)') && skill.includes('**不算他說的**'));
  check('……包進來的說明裡講到的決定,要在規格施作紀錄找得到他的原話才算', skill.includes('要在規格的施作紀錄裡找得到他的原話，才算'));
}

section('AC-1:F 工地主任那一列講怎麼叫主任;已結案的對話沒有收尾要合成,不畫');
{
  const wfStages = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, name: id, line: '這一輪還沒跑', state: 'none', ...(id === 'B' ? { type: 'main-conversation', state: 'main' } : id === 'E' ? { type: 'browser' } : { skill: id.toLowerCase() }) }));
  const live = sess({ id: 'l' });
  const shut = sess({ id: 'c', cwd: '/w/c', closedAt: '2026-11-01T05:00:00Z', card: card({ path: '/w/c', checkpointRelation: { state: 'ok', commitsAfter: 0 } }) });
  const latest = { projects: [{ name: 'p', suggestions: [] }], todo: board([proj([live, shut])]) };
  const ui = uiOf(latest);
  const html = (sid) => ui.workflow({ path: '/w/a', sensor: { state: 'ok' }, stages: wfStages, director: ui.directorOf(latest.projects[0], { id: sid }) });
  // 斜線指令搬進「細節」了(規格:主任條列與工地帽 AC-1):外面那一條只講在對話裡說「主任」
  check('進行中的對話:F 那一列講在對話裡說「主任」,斜線指令在細節裡', html('l').includes('在對話裡說「主任」') && outsideOf(html('l')) !== null
    && !outsideOf(html('l')).includes('/pipeline-monitor:director') && html('l').includes('/pipeline-monitor:director'), html('l').slice(-900));
  check('已結案的對話:不畫這一行', !html('c').includes('在對話裡說「主任」') && !html('c').includes('/pipeline-monitor:director'), html('c').slice(-700));
}

section('主任條列與工地帽 AC-1、AC-2、AC-4:F 那一格外面是條列重點,說明在「細節」;「不代表沒跳過」這種但書留在外面——剪掉就讀成「沒有建議卡」', 'P5');
{
  const wfStages = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, name: id, line: '這一輪還沒跑', state: 'none', ...(id === 'B' ? { type: 'main-conversation', state: 'main' } : id === 'E' ? { type: 'browser' } : { skill: id.toLowerCase() }) }));
  const s = sess({ id: 'l' });
  const page = (suggestions) => {
    const latest = { projects: [{ name: 'p', suggestions }], todo: board([proj([s])]) };
    const ui = uiOf(latest);
    return ui.workflow({ path: '/w/a', sensor: { state: 'ok' }, stages: wfStages, director: ui.directorOf(latest.projects[0], { id: 'l' }) });
  };
  const none = page([]);
  const out = outsideOf(none);
  check('拿得出 F 那一格「細節」以外的那一段(拿不出來下面什麼都沒比到)', out !== null, none.slice(-900));
  check('必抓:一張建議卡都沒記到 → 外面那一條照樣寫「不代表沒跳過」,不准只寫「沒有」', (out ?? '').includes('建議卡：紀錄裡沒有（不代表沒跳過）'), out);
  check('主任做什麼、建議卡為什麼可能看不到 → 在細節裡,不在外面', !(out ?? '').includes('看這個對話還有哪些沒收尾') && none.includes('看這個對話還有哪些沒收尾')
    && !(out ?? '').includes('有些卡這裡看不到') && none.includes('有些卡這裡看不到'), out);
  const loose = outsideOf(page([sg({ id: 'x1' }), sg({ id: 'x2' })])) ?? '';
  check('案件頁有分不出是誰放的卡 → 外面照樣列幾張', loose.includes('另有 2 張建議卡分不出是哪個對話放的'), loose);
  const mine = outsideOf(page([sg({ id: 'm1', session: 'l' }), sg({ id: 'm2', session: 'l', dismissedAt: '2026-11-01T00:00:00Z' })])) ?? '';
  check('這個對話提的卡:外面講還沒開始幾張', mine.includes('建議卡：還沒開始 1 張'), mine);
  // 不是還差的事的那幾條,記號是說明的那一種(data-k="note"):紅藍灰點是等你決定／還差／看不到(AC-4)
  const kinds = [...(out ?? '').matchAll(/<li data-k="([a-z]+)"[^>]*>([^<]*)</g)].filter(([, , t]) => /^(建議卡|另有|叫主任|現在可以叫主任)/.test(t)).map(([, k]) => k);
  check('建議卡、叫主任那幾條都是說明的記號,不借還差的事的', kinds.length >= 2 && kinds.every((k) => k === 'note'), kinds.join(','));
}

section('主任條列與工地帽 AC-10:切成英文——F 那一格外面、細節、亮燈那一句都沒有中文(英文那一頁的測試沒畫到 F 這一格)', 'P2');
{
  const wfStages = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, name: id, line: 'Not run yet this round', state: 'none', ...(id === 'B' ? { type: 'main-conversation', state: 'main' } : id === 'E' ? { type: 'browser' } : { skill: id.toLowerCase() }) }));
  const wrapLadder = () => ({ steps: [step('commit', 'done', 'all committed'), step('merge', 'pending', 'this branch has 2 commits not merged'), step('push', 'done', 'GitHub matches main')] });
  const fOf = (html) => { const at = html.indexOf('class="acard adirector"'); return at < 0 ? '' : html.slice(at); };
  const enHtml = (s, suggestions) => withLang('en', () => {
    const latest = { projects: [{ name: 'p', suggestions }], todo: board([proj([s])], () => '3 minutes ago') };
    const ui = uiOf(latest, { lang: 'en' });
    return fOf(ui.workflow({ path: '/w/a', sensor: { state: 'ok' }, stages: wfStages, director: ui.directorOf(latest.projects[0], { id: s.id }) }));
  });
  const lit = enHtml(sess({ id: 'l', card: card({ ladder: wrapLadder() }) }), [sg({ id: 'x1' })]);
  const mine = enHtml(sess({ id: 'm' }), [sg({ id: 'm1', session: 'm' }), sg({ id: 'm2', session: 'm', startedBy: 'x' })]);
  const none = enHtml(sess({ id: 'n' }), []);
  check('畫得出 F 那一格(不然下面什麼都沒比到)', [lit, mine, none].every((h) => h.includes('Site director')), lit.slice(0, 300));
  for (const [name, h] of [['亮燈、分不出是誰放的卡', lit], ['這個對話提的卡', mine], ['一張都沒記到', none]]) {
    check(`英文:${name} → F 那一格沒有中文`, !CJK.test(h.replace(/<[^>]*>/g, '')), h.replace(/<[^>]*>/g, ' ').match(/.{0,40}[一-鿿　-〿＀-￯].{0,40}/)?.[0]);
  }
  check('英文:一張都沒記到 → 照樣講「不代表沒跳過」那一句', none.includes('that doesn&#39;t mean none came up') || none.includes('that doesn\'t mean none came up'), none.slice(0, 600));
}

section('AC-9:切成英文——標這個對話、不在白板上、建議卡那一行、--cards 的字都是英文', 'P2');
{
  const en = withLang('en', () => {
    const p = proj([sess({ title: 'Do a thing' })], { displayName: 'P', suggestions: [sg({ title: 'Next part', prompt: 'Build the next part' }), sg({ id: 'k2', title: 'Old one', dismissedAt: '2026-11-01T00:00:00Z' }),
      sg({ id: 'k3', title: 'Started one', startedBy: 's7', startedTitle: 'Its conversation' }), sg({ id: 'k4', title: 'Asked one', ask: 'offer', source: 'app', session: 's9', fromTitle: 'Earlier' })] });
    const enAgo = () => '3 minutes ago';   // 「幾分鐘前」的英文是 lib/git.mjs 的 ago 給的,這裡換成英文的假的
    const bd = board([p, proj([], { name: 'q', displayName: 'Q', incomingSuggestions: [{ project: 'p', name: 'P', count: 1 }] })], enAgo);
    const shut = board([proj([sess({ id: 'c', title: 'Closed one', closedAt: '2026-11-01T05:00:00Z' })], { displayName: 'P' })], enAgo);
    return [...boardText(bd, { here: 's1' }), hereLine(shut, 'c'), hereLine(bd, 'zzz'),
      ...cardsText({ projects: [p, proj([], { name: 'q', displayName: 'Q', suggestions: [sg({ title: 'For P', openIn: { project: 'p' } })] })] }, 'p', { ago: () => '3 minutes ago' }),
      ...cardsText({ projects: [proj([], { displayName: 'P' })] }, 'p', { ago: enAgo }), ...cardsText({ projects: [] }, 'nowhere')].join('\n');
  });
  check('英文:這一段新的字沒有中文', !CJK.test(en), en.match(/.*[一-鿿　-〿＀-￯].*/)?.[0]);
  check('英文:箭頭、不在白板上、找不到、建議卡那一行、--cards 的幾區都在', ['← this conversation', 'isn\'t on the board', 'isn\'t in the records', 'Suggestion cards not started yet: 2', 'Not started yet (2)', 'Started (1)', 'You said you\'re not doing it (1)'].every((k) => en.includes(k)), en);
}

section('主任動手收尾 AC-9:這一輪該做的都有結論、只剩收尾 → F 那一格亮起來;還在做、等你點頭、待討論、問不到、沒有還差的事 → 不亮', 'P2');
{
  const wrapLadder = () => ({ steps: [step('commit', 'done', '都存好了'), step('merge', 'pending', '這條分支還多 2 個存檔沒併'), step('push', 'done', 'GitHub 上的跟 main 一樣')] });
  const deskOf = (s) => board([proj([s])]).desk[s.id];
  const only = deskOf(sess({ card: card({ ladder: wrapLadder() }) }));
  // 那一句變短了(規格:主任條列與工地帽 AC-3):叫了之後會怎樣搬進網頁 F 那一格的「細節」
  check('只剩存檔、併、章(這裡是還沒併、蓋章之後又存了) → 亮,件數照那一格列的數', /^現在可以叫主任：只剩收尾，能一起做的 2 件——在對話裡說「主任」$/.test(only?.call ?? ''), JSON.stringify(only));
  const dAsk = { id: 'D', name: '魔鬼教官', skill: 'chaos-check', state: 'stale', rerunAfterChange: true, rerun: { state: 'ask', line: '之後又改了程式檔，還沒再跑——要不要再跑由你決定' } };
  const withD = deskOf(sess({ stages: [...stages(), dAsk], card: card({ ladder: wrapLadder() }) }));
  check('D 要不要再跑等你決定 + 收尾 → 亮(主任會把這個決定合進同一個問題)', /能一起做的 3 件/.test(withD?.call ?? ''), JSON.stringify(withD));
  // 魔鬼教官第一輪:「驗收過了」只有你能說,主任不把它包進那一個問題——件數不算它;只剩它就沒有東西可以合成,不亮(老毛病 P2)
  const eWalked = { id: 'E', name: '驗收', type: 'browser', state: 'ran', ewhere: 'Claude 走過一遍，等你查核', rerun: { state: 'ok', estate: 'ok', line: 'Claude 走過一遍' } };
  const withE = deskOf(sess({ stages: [...stages(), eWalked], card: card({ ladder: wrapLadder() }) }));
  check('E 走過一遍、等你查核 + 收尾 → 亮,件數不算 E(主任另外講驗收過了只有你能說)', /能一起做的 2 件/.test(withE?.call ?? '') && withE.items.some((i) => /等你查核/.test(i.text)), JSON.stringify(withE));
  const eOnly = deskOf(sess({ stages: [...stages(), eWalked], card: card({ checkpointRelation: { state: 'ok', commitsAfter: 0 } }) }));
  eq('只剩「等你查核」→ 不亮(沒有東西可以合成)', eOnly.call, null);
  const eAgain = { ...eWalked, rerun: { state: 'ask', estate: 'ask', line: '之後又改了程式檔，還沒再走——要不要再走由你決定' } };
  check('E「要不要再走由你決定」跟 D 一樣算進件數', /能一起做的 3 件/.test(deskOf(sess({ stages: [...stages(), eAgain], card: card({ ladder: wrapLadder() }) })).call ?? ''));
  const dFound = { ...dAsk, rerun: { state: 'found', line: 'Claude 說找到問題，還沒處理完' } };
  eq('D 找到的還沒處理完(Claude 的事) → 不亮', deskOf(sess({ stages: [...stages(), dFound], card: card({ ladder: wrapLadder() }) })).call, null);
  const unmarked = stages().map((x) => (x.id === 'A' ? { ...x, checklist: { parsed: true, total: 2, checked: 1, unmarked: 1, pending: 0 } } : x));
  eq('清單還沒對完 → 不亮', deskOf(sess({ stages: unmarked, card: card({ ladder: wrapLadder() }) })).call, null);
  const pending = stages().map((x) => (x.id === 'A' ? { ...x, checklist: { parsed: true, total: 2, checked: 1, unmarked: 0, pending: 1 } } : x));
  eq('清單有待討論的 → 不亮(那要跟你談,不是收尾)', deskOf(sess({ stages: pending, card: card({ ladder: wrapLadder() }) })).call, null);
  const nod = stages().map((x) => (x.id === 'A' ? { ...x, doneAt: '2026-11-01T02:30:00Z' } : x.id === 'B' ? { ...x, closedBy: null, nodAt: null } : x));
  const waiting = deskOf(sess({ stages: nod, card: card({ ladder: wrapLadder() }) }));
  check('規格寫好、在等你點頭開工 → 不亮(那是開工,不是收尾)', waiting.call === null && waiting.items.some((i) => /等你點頭開工/.test(i.text)), JSON.stringify(waiting));
  eq('問不到檔案存了沒、併了沒 → 不亮(R1)', deskOf(sess({ card: card({ ladder: null }) })).call, null);
  eq('問不到分級 → 不亮', deskOf(sess({ tier: null, card: card({ ladder: wrapLadder() }) })).call, null);
  const done = deskOf(sess({ card: card({ checkpointRelation: { state: 'ok', commitsAfter: 0 } }) }));
  check('沒有還差的事 → 不亮,照舊「可以按結案」', done.call === null && /可以按結案/.test(done.clear ?? ''), JSON.stringify(done));

  // 網頁:F 那一格照伺服器算好的那一句印,亮的時候換掉平常那一行
  const wfStages = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, name: id, line: '這一輪還沒跑', state: 'none', ...(id === 'B' ? { type: 'main-conversation', state: 'main' } : id === 'E' ? { type: 'browser' } : { skill: id.toLowerCase() }) }));
  const lit = sess({ id: 'l', card: card({ ladder: wrapLadder() }) });
  const busy = sess({ id: 'b', stages: unmarked, card: card({ ladder: wrapLadder() }) });
  const latest = { projects: [{ name: 'p', suggestions: [] }], todo: board([proj([lit, busy])]) };
  const ui = uiOf(latest);
  const html = (sid) => ui.workflow({ path: '/w/a', sensor: { state: 'ok' }, stages: wfStages, director: ui.directorOf(latest.projects[0], { id: sid }) });
  check('只剩收尾的對話:F 那一格亮起來(class call),寫現在可以叫主任', /<li data-k="note" class="call">現在可以叫主任：只剩收尾/.test(html('l')) && !html('l').includes('叫主任：在對話裡說'), html('l').slice(-900));
  check('……叫了之後會怎樣、亮燈不是做完了,在細節裡', /<details class="amore"[^>]*>[\s\S]*你回一句，它才照順序做[\s\S]*不是做完了/.test(html('l')), html('l').slice(-900));
  check('還在做的對話:照舊平常那一條(叫主任：在對話裡說「主任」),不亮', html('b').includes('叫主任：在對話裡說「主任」') && !html('b').includes('class="call"'), html('b').slice(-900));
  // 左邊那一顆圓點(規格:主任條列與工地帽 AC-6):不借五關的樣子,亮不亮只看那一句在不在
  const rail = (h) => h.match(/<div class="railcell" data-state="([a-z]+)" data-lit="([01])">\s*<span class="rlab">F</)?.slice(1).join(',') ?? null;
  eq('只剩收尾:F 的圓點是主任自己的樣子、亮', rail(html('l')), 'director,1');
  eq('還在做(F 那一格有還差的事):F 的圓點不亮,也不借「叫了」的藍(data-state 不是 ran)', rail(html('b')), 'director,0');
  const en = withLang('en', () => board([proj([sess({ card: card({ ladder: wrapLadder() }) })])]).desk.s1?.call ?? '');
  check('英文:亮燈那一句沒有中文,講 site director', /^Now's a good time to call the site director: only wrap-up is left/.test(en) && !CJK.test(en), en);
}

section('主任條列與工地帽 AC-5:寫規格這一關還沒走完、這一輪什麼都還沒做 → F 不亮;白板對 A 講的跟 A 那一格同一句(2026-11-03 實況:規格寫到一半 F 亮「只剩收尾」)', 'P10');
{
  // 長得跟 2026-11-03 那一次一樣:A 叫了、還沒記結論,一個檔都還沒改(分級說沒有改動),資料夾還沒蓋過章
  const aLine = '5 分鐘前Claude 叫了 /pipeline-monitor:spec,等你點頭開工';
  const writing = () => [{ id: 'A', name: '寫規格', skill: 'spec', state: 'current', ranAt: '2026-11-03T08:59:00Z', doneAt: null, doneBy: null, line: aLine },
    { id: 'B', name: '寫程式', type: 'main-conversation', state: 'main', closedBy: null, nodAt: null }];
  const fresh = (o = {}) => sess({ stages: writing(), tier: { state: 'no-change' }, card: card({ checkpoint: null, checkpointRelation: null }), lastSaidAt: '2026-11-03T08:58:00Z', ...o });
  const deskOf = (s) => board([proj([s])]).desk[s.id];
  const w = deskOf(fresh());
  eq('必抓:規格還在寫、只剩「還沒蓋過章」→ 不亮', w.call, null);
  check('……白板列出 A 那一件,句子就是 A 那一格那一句,算等你決定、不算收尾', w.items[0]?.text === `等你決定（A 寫規格）：${aLine}` && w.items[0]?.hold === true && w.items.some((i) => i.text === '還沒蓋過章'), JSON.stringify(w.items));
  check('……終端機的 --todo 也印這一句(跟網頁同一份)', boardText(board([proj([fresh()])])).some((l) => l.includes(`等你決定（A 寫規格）：${aLine}`)));
  const talk = deskOf(fresh({ lastSaidAt: '2026-11-03T09:01:00Z' }));
  check('必抓:寫到一半你插話(你在 A 被叫之後說了話)→ A 那一件照樣在、照樣不亮', talk.call === null && talk.items.some((i) => i.hold), JSON.stringify(talk.items));
  const noLine = deskOf(fresh({ stages: writing().map((x) => (x.id === 'A' ? { ...x, line: undefined } : x)) }));
  check('舊的資料沒帶那一句:照 lib/stageLines.mjs 同一個函式算,照樣講等你點頭開工', /等你決定（A 寫規格）：.*等你點頭開工/.test(noLine.items[0]?.text ?? ''), noLine.items[0]?.text);
  const found = deskOf(fresh({ stages: writing().map((x) => (x.id === 'A' ? { ...x, report: { verdict: 'found' }, line: '5 分鐘前Claude 叫了 /pipeline-monitor:spec,Claude 說找到問題——還沒處理完' } : x)) }));
  check('A 記了「找到問題」→ 那是 Claude 的事,算還差、不亮', found.call === null && found.items[0]?.kind === 'todo', JSON.stringify(found.items));
  const blank = [{ id: 'A', name: '寫規格', skill: 'spec', state: 'none' }, { id: 'B', name: '寫程式', type: 'main-conversation', state: 'main', closedBy: null, nodAt: null }];
  const newbie = deskOf(fresh({ stages: blank }));
  check('必抓:新開的對話(一關都沒叫、一個檔都沒改、只剩還沒蓋過章)→ 不亮,「還沒蓋過章」照樣列', newbie.call === null && newbie.items.length === 1 && newbie.items[0].text === '還沒蓋過章', JSON.stringify(newbie));
  // 必放過:沒有改動不等於沒有收尾——之前存的檔還沒併,照樣亮
  const unmerged = deskOf(fresh({ stages: blank, card: card({ ladder: { steps: [step('commit', 'done', '都存好了'), step('merge', 'pending', '這條分支還多 2 個存檔沒併'), step('push', 'done', 'GitHub 上的跟 main 一樣')] }, checkpointRelation: { state: 'ok', commitsAfter: 0 } }) }));
  check('必放過:一個檔都沒改、但之前存的還沒併 → 照樣亮(只剩章才不亮)', /^現在可以叫主任：只剩收尾，能一起做的 1 件/.test(unmerged.call ?? ''), JSON.stringify(unmerged));
  const stamped = deskOf(fresh({ stages: blank, tier, card: card({ checkpoint: null, checkpointRelation: null }) }));
  check('必放過:有改動(分級讀得到)、只剩還沒蓋過章 → 照樣亮(那是收尾)', /^現在可以叫主任：只剩收尾，能一起做的 1 件/.test(stamped.call ?? ''), JSON.stringify(stamped));
}

process.exit(summary());
