/**
 * specLink.test.mjs —— 施工對話認規格(路徑看 CLAUDE.md 的表)
 *
 * 規格在別的對話寫、點頭後另開對話施工:施工的 Claude 用 pipeline-status --spec 記「照哪份施工」,
 * 儀表板的寫規格那一關、B 的結案、分級卡、收工 hook 都認得那份。釘的是會安靜說謊的地方:
 *   ① 規格寫好了,收工 hook 還叫施工的對話重寫規格;沒連結時只給一條路(AC-7,老毛病 P6)
 *   ② 連結套到別的對話身上——乙被要求照甲的清單打勾(AC-2)
 *   ③ 第一句話的提示被當成證據——畫了清單、算了寫規格(AC-3,老毛病 P4:先寫一個必須抓、一個必須放過)
 *   ④ 做完的規格、筆記、讀不出 AC 的檔、自己剛寫的檔被收進來(AC-4)
 *   ⑤ 另寫一份新規格就把施工清單換掉、重算這一輪(AC-5)
 *   ⑥ 找不到規格檔講成「沒有清單」、叫 Claude 去主資料夾打勾(AC-6)
 *   ⑦ 分批做的規格要求整份打勾(AC-8)
 *   ⑧ 分級卡、五關、收工 hook 各算各的(老毛病 P2)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, utimesSync, readFileSync, symlinkSync, existsSync, renameSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { decide } from '../gate.mjs';
import { collectAll } from '../lib/collect.mjs';
import { safeName, linkOwner, roundOf, specContext, sessionView, PROMPT_CAP } from '../lib/events.mjs';
import { specHint, batchOf, parseChecklist, locateSpec } from '../lib/checklist.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name;
const STAGES = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
const MIN = 60;
// 測試裡的「現在」只取一次(LESSONS L18)
const NOW = Date.now();
const T = (offsetSec) => new Date(NOW + offsetSec * 1000).toISOString();
const out = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const specText = (title, n, marks = {}) => `# 功能：${title}\n\n## 驗收條件\n${
  Array.from({ length: n }, (_, i) => `**AC-${i + 1}　第 ${i + 1} 條**${marks[i + 1] ?? ''}\n> **白話**：白話 ${i + 1}\n`).join('')}`;

/**
 * 一個有分級設定的專案(碰到危險清單就是第三級)、兩份等點頭／施工中的規格、一份做完的規格,
 * 加一個假的監視器資料夾(stages.json、logs/、checkpoints/)與裝了 plugin 的假 home。
 * 危險清單的檔已經改過(修改時間 4 分鐘前),收工 hook 才有「這一回合改了程式」可以判斷。
 */
function scene({ touch = 'src/danger.js' } = {}) {
  const r = makeRepo({ files: {
    'src/a.js': '1\n', 'src/danger.js': 'd\n', 'README.md': 'r\n', 'docs/LESSONS.md': '# 教訓\n沒有 AC\n',
    'docs/規劃中/app建議卡.md': specText('app建議卡', 7),
    'docs/進行中/pipeline-ui.md': specText('pipeline-ui', 4),
    'docs/升級摘要/做完的.md': specText('做完的', 2),
    'docs/規劃中/亂寫的.md': '# 隨手筆記\n沒有照格式\n',
  } });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'pipeline-stages.json'), JSON.stringify({ tiers: { code: ['src/'], danger: ['src/danger.js'] } }));
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-spec-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(ROOT, join(home, '.claude', 'skills', PLUGIN));
  if (touch) {
    writeFileSync(join(root, touch), 'changed\n');
    const past = new Date(NOW - 4 * MIN * 1000);
    utimesSync(join(root, touch), past, past);
  }
  const logDir = join(monitorDir, 'logs');
  const log = join(logDir, `${safeName(basename(root))}.jsonl`);
  const line = (o) => JSON.stringify({ session: 's1', cwd: root, ...o });
  const write = (lines) => writeFileSync(log, lines.map(line).join('\n') + '\n');
  const append = (lines) => appendFileSync(log, lines.map(line).join('\n') + '\n');
  const events = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // 跑真的 CLI。對話代號從環境變數給(Claude Code 給 Bash 的那一個);session=null 就拿掉,模擬拿不到代號
  const cli = (args, { session = 's1' } = {}) => {
    const { CLAUDE_CODE_SESSION_ID: _drop, ...env } = process.env;
    if (session) env.CLAUDE_CODE_SESSION_ID = session;
    try { return { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: root, encoding: 'utf8', env: { ...env, PIPELINE_MONITOR_HOME: monitorDir, PIPELINE_MONITOR_LOG_DIR: logDir } }) }; }
    catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
  };
  const project = () => collectAll({ monitorDir, skillHome: home, appTitles: new Map() }).projects[0];
  const sessionOf = (sid) => project()?.sessions.find((s) => s.id === sid) ?? null;
  const by = (arr) => Object.fromEntries((arr ?? []).map((s) => [s.id, s]));
  const gate = (sid = 's1') => decide({ payload: { session_id: sid, cwd: root, hook_event_name: 'Stop', stop_hook_active: false }, monitorDir, skillHome: home });
  const cleanup = () => { for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true }); r.cleanup(); };
  return { r, root, monitorDir, home, log, write, append, events, cli, project, sessionOf, by, gate, cleanup };
}

/** 一個施工對話的開頭:第一句話、改了危險清單的檔(感測器看到的)。 */
const opening = (root, { sid = 's1', prompt = '開工', at = -5 * MIN } = {}) => [
  { ts: T(at), hook: 'UserPromptSubmit', session: sid, prompt, prompt_id: `${sid}-p1` },
  { ts: T(at + MIN), hook: 'PostToolUse', tool: 'Edit', session: sid, file: join(root, 'src/danger.js'), prompt_id: `${sid}-p1` },
];

section('AC-7:規格是別的對話寫的、Claude 記了照哪份施工 → 收工 hook 不叫重寫規格;沒記的話,兩條路都講', 'P6');
{
  const s = scene();
  s.write(opening(s.root, { prompt: '開工' }));
  const before = s.gate();
  const lineA = (before?.reason ?? '').split('\n').find((l) => l.startsWith('- A ')) ?? '';
  check('沒連結:還是要求寫規格那一關(這一輪沒有規格的證據)', (before?.missing ?? []).includes('A'), JSON.stringify(before?.missing));
  check('那一行講兩條路:規格寫好了就 --spec,還沒有才跑寫規格的指令', lineA.includes('pipeline-status --spec <規格檔>') && lineA.includes(`/${PLUGIN}:spec`) && /還沒有規格才跑/.test(lineA), lineA);
  check('理由裡沒有程式內部值', !/null|undefined|NaN/.test(before?.reason ?? ''), before?.reason);

  const rec = s.cli(['--spec', 'docs/規劃中/app建議卡.md']);
  check('--spec 記下了,講是 Claude 說的、會畫幾條', rec.code === 0 && rec.out.includes('Claude 說的') && rec.out.includes('app建議卡') && rec.out.includes('7 條'), rec.out);
  const link = s.events().find((e) => e.event === 'spec_link');
  check('紀錄:spec_link、路徑、這個對話的代號、source claude', link?.spec === 'docs/規劃中/app建議卡.md' && link?.by_session === 's1' && link?.source === 'claude', JSON.stringify(link));
  const after = s.gate();
  check('有連結:收工 hook 不再列寫規格那一關', !(after?.missing ?? []).includes('A'), JSON.stringify(after?.missing));
  check('……但改了程式、清單還沒對 → 叫它先對清單(五關 AC-6 照舊)', (after?.missing ?? []).includes('checklist') && /AC-1/.test(after?.reason ?? '') && /app建議卡\.md/.test(after?.reason ?? ''), after?.reason);
  const sess = s.sessionOf('s1');
  const reqA = sess?.tier?.requirements?.find((r) => r.key === 'A');
  eq('分級卡:A 是「規格是別的對話寫的」,不是 ✅ 也不是「沒有紀錄」', `${reqA?.state}|${reqA?.detail}`, 'linked|規格是別的對話寫的：app建議卡（Claude 說的）');
  s.cleanup();
}

section('AC-1:照別的對話寫的規格施工 → A 畫「已走過」加那份的清單;連結不移動一輪的開始、不參加現在這一關、不算你點頭');
{
  const s = scene();
  s.write([
    ...opening(s.root),
    { ts: T(-2 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1' },
  ]);
  s.cli(['--spec', 'docs/規劃中/app建議卡.md']);
  let v = s.by(s.sessionOf('s1')?.stages);
  eq('A:已走過,誰說的是連結(Claude 記的)', `${v.A?.state}|${v.A?.closedBy}`, 'passed|link');
  eq('A 沒有「叫了」的時間(連結不是 A 的一次呼叫)', v.A?.ranAt, null);
  eq('A 沒有「你點頭開工」', v.A?.nodAt, null);
  eq('A 帶那份的名字與找到的位置', `${v.A?.link?.name}|${v.A?.link?.found}`, 'app建議卡|here');
  check('A 的清單是那份的 7 條,白話讀得到', v.A?.checklist?.parsed && v.A.checklist.total === 7 && v.A.checklist.items[0].plain === '白話 1', JSON.stringify(v.A?.checklist));
  eq('現在這一關還是 D(連結不參加排序)', v.D?.state, 'current');
  eq('B:改了程式、清單沒對 → 不劃掉,帶著進度 0/7', `${v.B?.state}|${v.B?.checklist?.checked}/${v.B?.checklist?.total}`, 'stale|0/7');
  // 對了 4 條 → 4/7;全部對完 → B 劃掉,是 Claude 對完清單
  writeFileSync(join(s.root, 'docs/規劃中/app建議卡.md'), specText('app建議卡', 7, { 1: ' ✅ 對過 2026-09-21', 2: ' ✅ 對過 2026-09-21', 3: ' ✅ 對過 2026-09-21', 4: ' ✅ 對過 2026-09-21' }));
  v = s.by(s.sessionOf('s1')?.stages);
  eq('對了 4 條 → 清單 4/7,B 還不劃掉', `${v.B?.checklist?.checked}/${v.B?.checklist?.total}|${v.B?.state}`, '4/7|stale');
  const all = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i + 1, ' ✅ 對過 2026-09-21']));
  writeFileSync(join(s.root, 'docs/規劃中/app建議卡.md'), specText('app建議卡', 7, all));
  v = s.by(s.sessionOf('s1')?.stages);
  eq('全部對完 → B 劃掉,是 Claude 對完清單', `${v.B?.state === 'passed' || v.B?.state === 'done'}|${v.B?.closedBy}`, 'true|checklist');
  // 終端機跟網頁說同一句
  const term = s.cli([], { session: 's1' }).out;
  check('終端機:A 寫「已走過：照別的對話寫的規格 app建議卡（Claude 說的）」並列清單', term.includes('已走過：照別的對話寫的規格 app建議卡（Claude 說的）') && term.includes('✅ AC-1 第 1 條'), term.split('━━ 五關')[1]?.slice(0, 600));
  check('終端機的分級:A 那一行是 🔗 規格是別的對話寫的', /A 寫規格\s*🔗 規格是別的對話寫的：app建議卡（Claude 說的）/.test(term), term.split('━━ 分級')[1]?.slice(0, 400));
  s.cleanup();
}

section('AC-2:連結只算記它的那個對話——同一個工作區的乙不會被套上甲的清單;拿不到代號時用時間推,分不出來就不歸給任何人、不擋');
{
  const s = scene();
  // 甲(s1)跟乙(s2)在同一個資料夾(主資料夾常見)
  s.write([
    ...opening(s.root, { sid: 's1', at: -6 * MIN }),
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', session: 's2', prompt: '調一個小地方', prompt_id: 's2-p1' },
    { ts: T(-5 * MIN + 20), hook: 'PostToolUse', tool: 'Edit', session: 's2', file: join(s.root, 'src/danger.js'), prompt_id: 's2-p1' },
  ]);
  s.cli(['--spec', 'docs/規劃中/app建議卡.md'], { session: 's1' });
  const a = s.by(s.sessionOf('s1')?.stages), b = s.by(s.sessionOf('s2')?.stages);
  eq('甲:連上了', a.A?.closedBy, 'link');
  eq('乙:沒有連結、沒有清單', `${b.A?.link ?? null}|${b.A?.checklist ?? null}`, 'null|null');
  const gb = s.gate('s2');
  check('乙收工:不會被要求照甲的清單打勾', !(gb?.missing ?? []).includes('checklist'), gb?.reason);
  check('乙收工:乙自己沒有規格 → 還是要求寫規格那一關', (gb?.missing ?? []).includes('A'), JSON.stringify(gb?.missing));
  eq('乙的分級卡:A 還是沒有紀錄(甲的連結不算乙的)', s.sessionOf('s2')?.tier?.requirements?.find((r) => r.key === 'A')?.state, 'missing');
  s.cleanup();
}
{
  // 拿不到代號(舊版):用時間推。甲開口之後,乙也在動 → 分不出來
  const events = [
    { ts: T(-6 * MIN), hook: 'UserPromptSubmit', session: 's1', cwd: '/w', prompt: '開工' },
    { ts: T(-5 * MIN), hook: 'PostToolUse', tool: 'Edit', session: 's2', cwd: '/w', file: '/w/src/a.js' },
  ];
  const link = { ts: T(-4 * MIN), event: 'spec_link', spec: 'docs/規劃中/x.md', cwd: '/w' };
  const o = linkOwner(link, events);
  check('甲開口之後乙也在動 → 不歸給任何人,兩個都是可能的', o.session === null && o.candidates.includes('s1') && o.candidates.includes('s2'), JSON.stringify(o));
  const solo = linkOwner(link, [events[0]]);
  eq('這個工作區只有甲 → 歸給甲,而且標明是「只有這個對話」推的', `${solo.session}|${solo.how}`, 's1|only');
  const later = linkOwner(link, [events[0], { ts: T(-1 * MIN), hook: 'UserPromptSubmit', session: 's3', cwd: '/w', prompt: '後來的' }]);
  eq('記的那一刻之後才開口的對話,不影響「那一刻是誰記的」', later.session, 's1');
  const withId = linkOwner({ ...link, by_session: 's2' }, events);
  eq('有代號就用代號', `${withId.session}|${withId.how}`, 's2|id');
  // 分不出來:兩個對話的頁面都寫「分不出是哪個對話記的」,都不擋
  const ctx1 = specContext([...events, link], { cwd: '/w', session: 's1' });
  check('分不出來的連結:對甲是 unsure(不算數),不是它的連結', ctx1.links.length === 0 && ctx1.unsure.length === 1, JSON.stringify(ctx1));
  const view = sessionView([...events, link], STAGES, 's1', null, '/w').view;
  const a = view.stages.find((x) => x.id === 'A');
  check('A 寫「有一筆規格連結分不出是哪個對話記的」,沒有清單', a.unsure?.name === 'x' && a.checklist === null && a.closedBy !== 'link', JSON.stringify({ unsure: a.unsure, checklist: a.checklist, closedBy: a.closedBy }));
}
{
  // 真的走一遍拿不到代號的 CLI:只有甲在動 → 甲拿到連結,CLI 講明是用時間推
  const s = scene();
  s.write(opening(s.root, { sid: 's1' }));
  const rec = s.cli(['--spec', 'docs/規劃中/app建議卡.md'], { session: null });
  check('拿不到代號:照樣記,並講「只有一個對話時才算得出是它記的」', rec.code === 0 && /拿不到這個對話的代號/.test(rec.out) && /只有一個對話/.test(rec.out), rec.out);
  check('紀錄裡沒有編一個代號', !('by_session' in (s.events().find((e) => e.event === 'spec_link') ?? {})));
  const a = s.by(s.sessionOf('s1')?.stages).A;
  eq('這個工作區只有甲 → 甲連上了,標明是這樣推的', `${a?.closedBy}|${a?.link?.how}`, 'link|only');
  const term = s.cli([], { session: null }).out;
  check('畫面講「沒記到對話代號，這個工作區只有這個對話」', term.includes('沒記到對話代號，這個工作區只有這個對話'), term.split('━━ 五關')[1]?.slice(0, 300));
  s.cleanup();
}
{
  // 兩週後在同一個資料夾開新對話 → 舊連結不算;蓋章之後 → 舊連結過期
  const events = [
    { ts: T(-14 * 86400), hook: 'UserPromptSubmit', session: 'old', cwd: '/w', prompt: '開工' },
    { ts: T(-14 * 86400 + 60), event: 'spec_link', spec: 'docs/規劃中/x.md', cwd: '/w', by_session: 'old' },
    { ts: T(-60), hook: 'UserPromptSubmit', session: 'new', cwd: '/w', prompt: '別的事' },
  ];
  eq('兩週後的新對話:舊連結不是它的', specContext(events, { cwd: '/w', session: 'new' }).links.length, 0);
  eq('蓋章之後:舊對話自己的連結也過期了', specContext(events, { cwd: '/w', session: 'old', cpAt: T(-86400) }).links.length, 0);
  eq('工作區層級、這段時間有兩個對話 → 不套任何連結', specContext(events, { cwd: '/w' }).scope, 'shared');
}

section('AC-3:第一句話提到剛好一份規格 → 只當提示(不畫清單、不擋人、不算寫規格);兩份以上、升級摘要都不算', 'P4');
{
  // 規格寫的兩個例子:一個必須提示,一個必須放過
  eq('必須提示:照 docs/規劃中/app建議卡.md 開工(升級摘要那份是參考,不算)', specHint('照 docs/規劃中/app建議卡.md 開工。先讀 docs/升級摘要/pipeline-sensor.md 的 AC')?.name, 'app建議卡');
  eq('必須放過:兩份(進行中一份、規劃中一份)', specHint('先讀 docs/進行中/五關自動結案.md 與 docs/規劃中/E自動驗收.md'), null);
  eq('只提到升級摘要 → 不提示', specHint('先讀 docs/升級摘要/五關自動結案.md'), null);
  eq('同一份從規劃中搬到進行中各寫一次 → 算一份', specHint('從 docs/規劃中/x.md 搬到 docs/進行中/x.md')?.name, 'x');
  eq('沒寫 docs/ 的不猜', specHint('照 app建議卡.md 做'), null);
  eq('.mdx 不是 .md', specHint('照 docs/規劃中/x.mdx 做'), null);
  eq('句尾接中文標點也認得出檔名', specHint('照 docs/進行中/施工對話認規格.md。')?.path, 'docs/進行中/施工對話認規格.md');

  const s = scene();
  s.write(opening(s.root, { prompt: '照 docs/規劃中/app建議卡.md 開工。先讀 docs/升級摘要/pipeline-sensor.md 的 AC' }));
  let a = s.by(s.sessionOf('s1')?.stages).A;
  eq('A:可能是照 app建議卡 施工(還沒確認)', a?.hint?.name, 'app建議卡');
  eq('提示不畫清單、不算走過', `${a?.checklist ?? null}|${a?.state}`, 'null|none');
  const g = s.gate();
  const lineA = (g?.reason ?? '').split('\n').find((l) => l.startsWith('- A ')) ?? '';
  check('提示不算數:收工 hook 照樣要求寫規格那一關,但把提到的那份附上', (g?.missing ?? []).includes('A') && lineA.includes('從第一句話看，可能是 docs/規劃中/app建議卡.md'), lineA);
  check('提示不會變成清單要求', !(g?.missing ?? []).includes('checklist'), g?.reason);
  const term = s.cli([], { session: 's1' }).out;
  check('終端機:「從你第一句話看，可能是照 app建議卡 施工（Claude 還沒確認）」', term.includes('從你第一句話看，可能是照 app建議卡 施工（Claude 還沒確認）'), term.split('━━ 五關')[1]?.slice(0, 300));
  // Claude 說不是照別人的規格 → 提示消失
  const none = s.cli(['--spec', '無']);
  check('--spec 無:記下,講提示會消失、分級要的話還是要跑寫規格', none.code === 0 && /提示會消失/.test(none.out) && /還是會要求跑/.test(none.out), none.out);
  a = s.by(s.sessionOf('s1')?.stages).A;
  eq('--spec 無 之後:提示消失,也沒有連結', `${a?.hint ?? null}|${a?.link ?? null}`, 'null|null');
  check('--spec 無 之後:收工 hook 還是要求寫規格(沒有規格)', (s.gate()?.missing ?? []).includes('A'));
  s.cleanup();
}
{
  // 蓋章之後,第一句話講的是上一件事 → 不提示
  const ev = [{ ts: T(-3600), hook: 'UserPromptSubmit', session: 's1', cwd: '/w', prompt: '照 docs/規劃中/x.md 開工' }];
  const a = sessionView(ev, STAGES, 's1', T(-600), '/w').view.stages.find((x) => x.id === 'A');
  eq('第一句話比蓋章早 → 不提示', a.hint, null);
}

section('AC-4:--spec 只收「還沒做完的規格」——做完的、筆記、讀不出 AC 的、這個對話自己寫的、打錯的 AC 代號,都回一句白話、不記');
{
  const s = scene();
  s.write(opening(s.root));
  const bad = (args, why) => {
    const r = s.cli(args);
    const recorded = s.events().some((e) => e.event === 'spec_link');
    check(`${why} → 不記`, r.code === 1 && !recorded, r.out);
    check(`${why} → 說明是白話,沒有程式內部值`, !/null|undefined|NaN|Error|at .*\.mjs/.test(r.out), r.out);
    return r.out;
  };
  const done = bad(['--spec', 'docs/升級摘要/做完的.md'], '做完的規格(升級摘要)');
  check('講「已經做完的規格」', /已經做完的規格/.test(done), done);
  bad(['--spec', 'docs/LESSONS.md'], '筆記(不在規劃中／進行中)');
  const messy = bad(['--spec', 'docs/規劃中/亂寫的.md'], '讀不出任何一條 AC 的檔');
  check('講讀不出 AC', /讀不出任何一條 AC/.test(messy), messy);
  bad(['--spec', 'docs/規劃中/沒有這份.md'], '不存在的檔');
  const typo = bad(['--spec', 'docs/規劃中/app建議卡.md', 'AC-9'], '這份沒有的 AC 代號');
  check('把這份有的 AC 列出來', /AC-1、AC-2/.test(typo), typo);
  bad(['--spec', 'src/a.js'], '程式檔');
  // 這個對話自己寫的規格(感測器記到 Write)→ 那是寫規格那一關的工作
  mkdirSync(join(s.root, 'docs', '進行中'), { recursive: true });
  writeFileSync(join(s.root, 'docs/進行中/自己寫的.md'), specText('自己寫的', 2));
  s.append([{ ts: T(-30), hook: 'PostToolUse', tool: 'Write', session: 's1', file: join(s.root, 'docs/進行中/自己寫的.md') }]);
  const self = bad(['--spec', 'docs/進行中/自己寫的.md'], '這個對話自己剛寫的檔');
  check('指路:那是寫規格那一關的工作', self.includes('A 寫規格') && self.includes(`/${PLUGIN}:spec`), self);
  // 別的對話寫的同一份 → 收(那正是「規格在別的對話寫」)
  const other = s.cli(['--spec', 'docs/進行中/自己寫的.md'], { session: 's9' });
  eq('別的對話寫的 → 收', other.code, 0);
  s.cleanup();
}

section('AC-5:這一輪跑過 A 就不往第一句話猜;連著施工清單時另寫一份新規格,不換清單、不重算這一輪、不算點頭');
{
  // ① 這一輪有 A、連不到它寫的檔 → 說找不到,不退到第一句話
  const ev = [
    { ts: T(-600), hook: 'UserPromptSubmit', session: 's1', cwd: '/w', prompt: '/spec 照 docs/規劃中/x.md 的想法再寫一份', prompt_id: 'p1' },
  ];
  const a = sessionView(ev, STAGES, 's1', null, '/w').view.stages.find((x) => x.id === 'A');
  check('A 跑過、連不到檔 → 清單說找不到這一輪的規格檔', a.checklist?.missing === true && a.checklist?.parsed === false, JSON.stringify(a.checklist));
  eq('……而且不拿第一句話來猜', a.hint, null);
}
{
  const s = scene();
  s.write([...opening(s.root), { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1' }]);
  s.cli(['--spec', 'docs/規劃中/app建議卡.md']);
  // 連結的時間是 CLI 自己取的「現在」;之後的事件以它為基準排,不用檔案開頭取的 NOW——跑得慢就會排反(L18,魔鬼教官 2026-09-21)
  const lt = Date.parse(s.events().find((e) => e.event === 'spec_link').ts);
  const TL = (sec) => new Date(lt + sec * 1000).toISOString();
  // ② 同一個對話又叫 A,寫了另一份(D多輪)
  mkdirSync(join(s.root, 'docs', '規劃中'), { recursive: true });
  writeFileSync(join(s.root, 'docs/規劃中/D多輪.md'), specText('D多輪', 3));
  s.append([
    { ts: TL(10), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:spec`, session: 's1', prompt_id: 'p9' },
    { ts: TL(20), hook: 'PostToolUse', tool: 'Write', session: 's1', file: join(s.root, 'docs/規劃中/D多輪.md'), prompt_id: 'p9' },
  ]);
  const v = s.by(s.sessionOf('s1')?.stages);
  eq('A 還是照連結畫(已走過),施工清單還是 app建議卡', `${v.A?.closedBy}|${v.A?.link?.name}|${v.A?.checklist?.total}`, 'link|app建議卡|7');
  eq('A 另外講「另寫了一份規格 D多輪(等你點頭)」', v.A?.side?.name, 'D多輪');
  eq('不算你點頭開工', v.A?.nodAt, null);
  eq('不重算這一輪:D 還在這一輪裡(沒有被切到上一輪)', v.D?.ranAt ? 'in-round' : 'cut', 'in-round');
  check('收工 hook 照樣不叫重寫規格、照樣要對 app建議卡 的清單', !(s.gate()?.missing ?? []).includes('A') && /app建議卡\.md/.test(s.gate()?.reason ?? ''), s.gate()?.reason);
  const term = s.cli([], { session: 's1' }).out;
  check('終端機:另寫了一份規格 D多輪（等你點頭）', term.includes('另寫了一份規格 D多輪（等你點頭）'), term.split('━━ 五關')[1]?.slice(0, 500));
  s.cleanup();
}
{
  // 連著的時候 A 寫的就是連著的那份 → 那份變成這個對話自己的,照舊算新的一輪(連結跟著失效)
  const runs = new Map([['A', [{ ts: T(-100), prompt_id: 'p2', session: 's1' }]]]);
  const links = [{ ts: T(-200), spec: 'docs/規劃中/x.md', cwd: '/w' }];
  const same = roundOf(runs, STAGES, null, { links, specOfRun: () => '/w/docs/進行中/x.md' });
  eq('A 寫的就是連著那份(搬過資料夾也一樣)→ 新的一輪,連結失效', `${same.start}|${same.link}`, `${T(-100)}|null`);
  const other = roundOf(runs, STAGES, null, { links, specOfRun: () => '/w/docs/規劃中/y.md' });
  eq('A 寫的是別份 → 不移動分界,連結留著', `${other.start}|${other.link?.spec}|${other.side.length}`, 'null|docs/規劃中/x.md|1');
  const unknown = roundOf(runs, STAGES, null, { links, specOfRun: () => null });
  eq('A 寫了哪份看不到 → 當另寫一份(施工清單不被換掉)', `${unknown.start}|${unknown.link?.spec}`, 'null|docs/規劃中/x.md');
  // 感測器的時間只到秒,CLI 記到毫秒:同一秒的 A 排在連結前面(字串比大小會顛倒)
  const tie = roundOf(new Map([['A', [{ ts: '2026-09-21T08:00:00Z' }]]]), STAGES, null, { links: [{ ts: '2026-09-21T08:00:00.500Z', spec: 'docs/規劃中/x.md', cwd: '/w' }] });
  eq('同一秒:A 先、連結後 → 連結有效', tie.link?.spec, 'docs/規劃中/x.md');
}

section('AC-6:規格搬家了照樣找得到;只在主資料夾找到的,只講一句、不叫 Claude 去那裡打勾;都找不到要說「找不到」,不是「沒有清單」');
{
  const s = scene();
  s.write(opening(s.root));
  s.cli(['--spec', 'docs/規劃中/app建議卡.md']);
  // 開工後搬到進行中
  mkdirSync(join(s.root, 'docs', '進行中'), { recursive: true });
  renameSync(join(s.root, 'docs/規劃中/app建議卡.md'), join(s.root, 'docs/進行中/app建議卡.md'));
  let a = s.by(s.sessionOf('s1')?.stages).A;
  eq('搬到進行中 → 照樣讀到', `${a?.link?.found}|${a?.link?.rel}|${a?.checklist?.total}`, 'here|docs/進行中/app建議卡.md|7');
  // 結案搬到升級摘要 → 還是讀得到(做完的那份,清單照畫)
  renameSync(join(s.root, 'docs/進行中/app建議卡.md'), join(s.root, 'docs/升級摘要/app建議卡.md'));
  a = s.by(s.sessionOf('s1')?.stages).A;
  eq('搬到升級摘要 → 照樣讀到', a?.link?.rel, 'docs/升級摘要/app建議卡.md');
  // 都找不到 → 找不到規格檔 X.md
  rmSync(join(s.root, 'docs/升級摘要/app建議卡.md'));
  a = s.by(s.sessionOf('s1')?.stages).A;
  eq('都找不到 → found=missing,沒有清單物件冒充「沒有清單」', `${a?.link?.found}|${a?.checklist ?? null}`, 'missing|null');
  const term = s.cli([], { session: 's1' }).out;
  check('終端機:「找不到規格檔 app建議卡.md」', term.includes('找不到規格檔 app建議卡.md'), term.split('━━ 五關')[1]?.slice(0, 300));
  check('找不到的時候不擋人:不要求對清單', !(s.gate()?.missing ?? []).includes('checklist'));
  // 同名兩份 → 分不出來
  writeFileSync(join(s.root, 'docs/進行中/app建議卡.md'), specText('app建議卡', 7));
  writeFileSync(join(s.root, 'docs/升級摘要/app建議卡.md'), specText('app建議卡', 7));
  a = s.by(s.sessionOf('s1')?.stages).A;
  eq('工作區裡同名兩份 → 分不出來,不猜', a?.link?.found, 'ambiguous');
  s.cleanup();
}
{
  // 只在主資料夾(worktree 還沒併進來):locateSpec 只說在主資料夾,不給檔案
  const main = mkdtempSync(join(tmpdir(), 'pm-main-')), wt = mkdtempSync(join(tmpdir(), 'pm-wt-'));
  mkdirSync(join(main, 'docs', '進行中'), { recursive: true });
  writeFileSync(join(main, 'docs/進行中/x.md'), specText('x', 2));
  const loc = locateSpec('docs/進行中/x.md', { root: wt, mainRoot: main });
  eq('只在主資料夾 → found=main,不給工作區的檔案(不叫 Claude 去那裡改)', `${loc.found}|${loc.file}`, 'main|null');
  const v = sessionView([
    { ts: T(-300), hook: 'UserPromptSubmit', session: 's1', cwd: wt, prompt: '開工' },
    { ts: T(-200), event: 'spec_link', spec: 'docs/進行中/x.md', cwd: wt, by_session: 's1' },
  ], STAGES, 's1', null, wt, { mainRoot: main }).view;
  const a = v.stages.find((x) => x.id === 'A'), b = v.stages.find((x) => x.type === 'main-conversation');
  eq('A:連著、規格在主資料夾;沒有清單、B 也沒有要對的清單', `${a.closedBy}|${a.link?.found}|${a.checklist}|${b.checklist}`, 'link|main|null|null');
  for (const d of [main, wt]) rmSync(d, { recursive: true, force: true });
}

section('AC-8:一份規格分幾批做,只要求這一批的 AC;A 仍畫整份,其他條標「不在這一批」');
{
  const cl = batchOf(parseChecklist(specText('x', 4, { 1: ' ✅ 對過 2026-09-21' })), ['AC-1', 'AC-2']);
  eq('只數這一批:1/2 對過、1 條沒對;整份 4 條', `${cl.checked}/${cl.total}|${cl.unmarked}|${cl.allTotal}`, '1/2|1|4');
  eq('不在這一批的標出來', cl.items.map((it) => (it.inBatch ? 'i' : 'o')).join(''), 'iioo');
  eq('沒給代號 = 整份', batchOf(parseChecklist(specText('x', 3)), null).total, 3);

  const s = scene();
  s.write(opening(s.root));
  const rec = s.cli(['--spec', 'docs/進行中/pipeline-ui.md', 'AC-1', 'ac2']);
  check('--spec 帶代號:記下,講這一批只對哪幾條', rec.code === 0 && rec.out.includes('這一批只對 AC-1、AC-2'), rec.out);
  eq('紀錄裡帶這一批的代號(ac2 也認得)', JSON.stringify(s.events().find((e) => e.event === 'spec_link')?.acs), '["AC-1","AC-2"]');
  const g = s.gate();
  check('收工 hook 只要求標 AC-1、AC-2', /AC-1、AC-2 還沒標/.test(g?.reason ?? '') && !/AC-3/.test(g?.reason ?? ''), g?.reason);
  let v = s.by(s.sessionOf('s1')?.stages);
  check('A 畫整份 4 條,AC-3、AC-4 標不在這一批', v.A?.checklist?.items?.length === 4 && v.A.checklist.items[2].inBatch === false && v.A.checklist.allTotal === 4, JSON.stringify(v.A?.checklist?.items?.map((i) => [i.id, i.inBatch])));
  // 這一批標完 → 收工 hook 不再要求清單、B 劃掉;其他兩條沒標也不擋
  writeFileSync(join(s.root, 'docs/進行中/pipeline-ui.md'), specText('pipeline-ui', 4, { 1: ' ✅ 對過 2026-09-21', 2: ' ✅ 對過 2026-09-21' }));
  check('這一批標完 → 不再要求清單', !(s.gate()?.missing ?? []).includes('checklist'), s.gate()?.reason);
  v = s.by(s.sessionOf('s1')?.stages);
  eq('B:這一批對完就劃掉', v.B?.closedBy, 'checklist');
  const term = s.cli([], { session: 's1' }).out;
  check('終端機:這一批只對 AC-1、AC-2,其他條標(不在這一批)', term.includes('這一批只對 AC-1、AC-2（全部 4 條）') && term.includes('AC-3 第 3 條（不在這一批）'), term.split('━━ 五關')[1]?.slice(0, 700));
  s.cleanup();
}

section('分級卡、五關、收工 hook 用同一份按對話算的結果(不各算一份)', 'P2');
{
  const s = scene();
  s.write(opening(s.root));
  s.cli(['--spec', 'docs/規劃中/app建議卡.md']);
  const sess = s.sessionOf('s1');
  const five = s.by(sess?.stages).A?.closedBy === 'link';
  const tierCard = sess?.tier?.requirements?.find((r) => r.key === 'A')?.state === 'linked';
  const gateSays = !(s.gate()?.missing ?? []).includes('A');
  eq('五關、分級卡、收工 hook 三個說同一件事(規格是別的對話寫的)', `${five}|${tierCard}|${gateSays}`, 'true|true|true');
  // 工作區層級(終端機、工作區的卡):這個工作區只有這一個對話 → 跟對話頁同一份
  const card = s.project()?.cards?.find((c) => c.path === s.root);
  eq('工作區只有這一個對話:工作區的卡也認這個連結', s.by(card?.stages).A?.closedBy, 'link');
  s.cleanup();
}

section('魔鬼教官 2026-09-21 第一輪:「這個對話自己寫的」不只看 Write——用 Bash 寫的、A 收尾記的都認得;別處的同名檔、連上之後的打勾不誤擋', 'P6');
{
  // 只有這個對話在用的 worktree,用 Bash 寫了一份規格(感測器一筆都沒記到),main 上沒有 → 是它寫的
  const s = scene();
  s.write(opening(s.root));
  mkdirSync(join(s.root, 'docs', '進行中'), { recursive: true });
  writeFileSync(join(s.root, 'docs/進行中/bash寫的.md'), specText('bash寫的', 2));
  const r1 = s.cli(['--spec', 'docs/進行中/bash寫的.md']);
  check('Bash 寫的、main 上沒有、這個工作區只有這個對話 → 不收,講證據與該跑的指令', r1.code === 1 && /main 上沒有/.test(r1.out) && r1.out.includes(`/${PLUGIN}:spec`), r1.out);
  check('……畫面沒有被說成「別的對話寫的」(一筆連結都沒記)', !s.events().some((e) => e.event === 'spec_link'));
  // 這個對話的 A 收尾記了這份(用 Bash 寫檔時唯一的線索)→ 不收
  writeFileSync(join(s.root, 'docs/規劃中/新功能.md'), specText('新功能', 2));
  execFileSync('git', ['add', '-A'], { cwd: s.root }); execFileSync('git', ['commit', '-qm', 'spec'], { cwd: s.root });   // 存進版本、在 main 上(這個 repo 就在 main)
  s.append([
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:spec`, session: 's1', prompt_id: 'pa' },
    { ts: T(-3 * MIN + 30), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/新功能.md', cwd: s.root, source: 'claude' },
  ]);
  const r2 = s.cli(['--spec', 'docs/規劃中/新功能.md']);
  check('這個對話的 A 收尾記了這份 → 不收', r2.code === 1 && /收尾記了它/.test(r2.out), r2.out);
  eq('別的對話的 A 記的同一份 → 收(那正是規格在別的對話寫)', s.cli(['--spec', 'docs/規劃中/新功能.md'], { session: 's9' }).code, 0);
  s.cleanup();
}
{
  const s = scene();
  s.write(opening(s.root));
  // 審查員在暫存資料夾造了一個同名的檔(感測器記在同一個對話底下)→ 不是這個工作區的,不算
  s.append([{ ts: T(-2 * MIN), hook: 'PostToolUse', tool: 'Write', session: 's1', file: '/tmp/假的/docs/規劃中/app建議卡.md' }]);
  eq('別的資料夾的同名 Write 不算「這個對話寫的」', s.cli(['--spec', 'docs/規劃中/app建議卡.md']).code, 0);
  // 連上之後用 Write 打勾／搬家,再記下一批 → 照樣收
  s.append([{ ts: new Date(Date.now() + 1000).toISOString(), hook: 'PostToolUse', tool: 'Write', session: 's1', file: join(s.root, 'docs/規劃中/app建議卡.md') }]);
  const again = s.cli(['--spec', 'docs/規劃中/app建議卡.md', 'AC-3', 'AC-4']);
  check('連上之後的 Write(打勾、搬家)不擋下一批', again.code === 0, again.out);
  // 從子資料夾跑也認得(照工作區的根解)
  const sub = (() => { try { return execFileSync('node', [join(ROOT, 'status.mjs'), '--spec', 'docs/規劃中/app建議卡.md'], { cwd: join(s.root, 'src'), encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 's1', PIPELINE_MONITOR_HOME: s.monitorDir, PIPELINE_MONITOR_LOG_DIR: join(s.monitorDir, 'logs') } }); } catch (e) { return `失敗：${e.stdout}`; } })();
  check('從子資料夾跑 --spec docs/… 也認得', /記下了/.test(sub), sub);
  s.cleanup();
}

section('魔鬼教官 2026-09-21 第一輪:Claude 自己跑終端機要看得到自己的連結;工作區層級分不出來時講分不出,不講「沒有紀錄」', 'P2');
{
  const s = scene();
  // 這個 worktree 三天前來過別的對話(說了一句就走)
  s.write([
    { ts: T(-3 * 86400), hook: 'UserPromptSubmit', session: 'old', prompt: '收到' },
    ...opening(s.root),
  ]);
  s.cli(['--spec', 'docs/規劃中/app建議卡.md']);
  const term = s.cli([], { session: 's1' }).out;
  check('Claude(有代號)跑終端機:A 是「已走過：照別的對話寫的規格」,分級是 🔗', term.includes('已走過：照別的對話寫的規格 app建議卡') && /A 寫規格\s*🔗/.test(term), term.split('━━ 五關')[1]?.slice(0, 500));
  const human = s.cli([], { session: null }).out;
  check('人自己跑(沒代號)、工作區有兩個對話:分級那一行講分不出,不講「沒有紀錄」', /A 寫規格\s*❔ 這個工作區有好幾個對話/.test(human) && !/A 寫規格\s*⚠️ 沒有紀錄/.test(human), human.split('━━ 分級')[1]?.slice(0, 400));
  s.cleanup();
}
{
  // 對話頁的分級卡只換寫規格那一行:共用工作區、別的對話在 D 之後又改了程式 → D 那一行跟收工 hook 一樣說「要再跑一次」
  const s = scene({ touch: null });
  s.write([
    ...opening(s.root, { sid: 's1', at: -10 * MIN }),
    { ts: T(-8 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1' },
    { ts: T(-8 * MIN + 30), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', cwd: s.root, source: 'claude' },
    { ts: T(-3 * MIN), hook: 'UserPromptSubmit', session: 's2', prompt: '改一下' },
    { ts: T(-2 * MIN), hook: 'PostToolUse', tool: 'Edit', session: 's2', file: join(s.root, 'src/danger.js') },
  ]);
  writeFileSync(join(s.root, 'src/danger.js'), 'changed by s2\n');
  const card = s.project()?.cards?.find((c) => c.path === s.root);
  const cardD = card?.tier?.requirements?.find((r) => r.key === 'D')?.state;
  const pageD = s.sessionOf('s1')?.tier?.requirements?.find((r) => r.key === 'D')?.state;
  eq('對話頁的 D 跟工作區的卡同一份(不各算一份)', `${pageD}|${cardD}`, 'ran|ran');
  s.cleanup();
}

section('魔鬼教官 2026-09-21 第一輪:第一句話被感測器截斷時,「只提到一份」證明不了——截在路徑中間不提示,其他截過的要講,收工 hook 不交路徑', 'P4');
{
  // 感測器真的截在哪:讀取端知道的上限要跟 hook.sh 一樣(老毛病 P2:同一個數字住兩個地方)
  const logDir = mkdtempSync(join(tmpdir(), 'pm-cap-'));
  execFileSync('sh', [join(ROOT, 'hook.sh')], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'c1', cwd: tmpdir(), prompt: '字'.repeat(PROMPT_CAP + 50) }), env: { ...process.env, PIPELINE_MONITOR_LOG_DIR: logDir } });
  const rec = readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(logDir, f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l)).find((e) => e.session === 'c1');
  eq('hook.sh 截的長度 = 讀取端以為的上限', [...(rec?.prompt ?? '')].length, PROMPT_CAP);
  rmSync(logDir, { recursive: true, force: true });

  // 把第二份路徑剛好截在中間:第一份完整(到第 192 字)、第二份只剩「docs/」幾個字
  const cutMid = [...('命名一行。'.padEnd(170, '。') + '先讀 docs/進行中/五關自動結案.md 與 docs/規劃中/E自動驗收.md')].slice(0, PROMPT_CAP).join('');
  check('(這個例子真的只看得到第一份完整的路徑)', /五關自動結案\.md/.test(cutMid) && !/E自動驗收/.test(cutMid) && /docs\/[^.]*$/.test(cutMid), cutMid.slice(-40));
  eq('截在第二份路徑中間 → 不提示(第二份被截掉的樣子)', specHint(cutMid, { cap: PROMPT_CAP }), null);
  const cutAfter = [...('照 docs/進行中/施工對話認規格.md 施工。' + '說明'.repeat(200))].slice(0, PROMPT_CAP).join('');
  const h = specHint(cutAfter, { cap: PROMPT_CAP });
  eq('截在別處 → 照樣提示,但標明截過', `${h?.name}|${h?.cut}`, '施工對話認規格|true');
  eq('沒截到上限 → 標明沒截過', specHint('照 docs/規劃中/x.md 開工', { cap: PROMPT_CAP })?.cut, false);

  const s = scene();
  s.write(opening(s.root, { prompt: cutAfter }));
  const g = s.gate();
  const lineA = (g?.reason ?? '').split('\n').find((l) => l.startsWith('- A ')) ?? '';
  check('截過的第一句話:收工 hook 不把路徑交給 Claude(Claude 自己看得到完整的)', lineA.includes('pipeline-status --spec <規格檔>') && !lineA.includes('從第一句話看'), lineA);
  const term = s.cli([], { session: 's1' }).out;
  check('畫面講「感測器只記第一句話的開頭，後面有沒有提到別份看不到」', term.includes('感測器只記第一句話的開頭，後面有沒有提到別份看不到'), term.split('━━ 五關')[1]?.slice(0, 300));
  s.cleanup();
}

section('魔鬼教官 2026-09-21 第一輪:連上一份別的對話已經全部打勾的規格,不算這個對話對完——連上之後檔案被改過才算');
{
  const s = scene();
  const all = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [i + 1, ' ✅ 對過 2026-09-20']));
  writeFileSync(join(s.root, 'docs/進行中/pipeline-ui.md'), specText('pipeline-ui', 4, all));
  const past = new Date(NOW - 3600 * 1000); utimesSync(join(s.root, 'docs/進行中/pipeline-ui.md'), past, past);   // 昨天別的對話打的勾
  s.write(opening(s.root));
  s.cli(['--spec', 'docs/進行中/pipeline-ui.md']);
  let v = s.by(s.sessionOf('s1')?.stages);
  eq('勾都是連上之前打的 → B 不劃掉,講得出為什麼', `${v.B?.closedBy}|${v.B?.checklist?.preMarked}`, 'null|true');
  const g = s.gate();
  check('收工 hook 叫它回頭對一次', (g?.missing ?? []).includes('checklist') && /連上之前就打好的/.test(g?.reason ?? ''), g?.reason);
  const term = s.cli([], { session: 's1' }).out;
  check('終端機講「清單的勾都是連上這份之前就打好的」', term.includes('清單的勾都是連上這份之前就打好的'), term.split('━━ 五關')[1]?.slice(0, 900));
  // 這個對話回頭對了(改了檔案,重標日期)→ 才算對完
  writeFileSync(join(s.root, 'docs/進行中/pipeline-ui.md'), specText('pipeline-ui', 4, Object.fromEntries(Array.from({ length: 4 }, (_, i) => [i + 1, ' ✅ 對過 2026-09-21']))));
  const soon = new Date(Date.now() + 2000); utimesSync(join(s.root, 'docs/進行中/pipeline-ui.md'), soon, soon);
  v = s.by(s.sessionOf('s1')?.stages);
  eq('連上之後檔案改過 → B 是 Claude 對完清單', v.B?.closedBy, 'checklist');
  check('收工 hook 不再要求清單', !(s.gate()?.missing ?? []).includes('checklist'), s.gate()?.reason);
  s.cleanup();
}

section('魔鬼教官 2026-09-21 第一輪:拿不到代號時,只用 Bash 在做事的對話也算「在」——兩個對話就不歸給任何人');
{
  // 甲 30 分鐘前開口、之後只用 Bash(感測器一筆都沒有);乙 6 分鐘前開口、用 Edit 改了一下;連結沒有代號
  const events = [
    { ts: T(-30 * MIN), hook: 'UserPromptSubmit', session: 's1', cwd: '/w', prompt: '開工' },
    { ts: T(-6 * MIN), hook: 'UserPromptSubmit', session: 's2', cwd: '/w', prompt: '問一句' },
    { ts: T(-5 * MIN), hook: 'PostToolUse', tool: 'Edit', session: 's2', cwd: '/w', file: '/w/src/a.js' },
  ];
  const o = linkOwner({ ts: T(-4 * MIN), event: 'spec_link', spec: 'docs/規劃中/x.md', cwd: '/w' }, events);
  eq('不歸給剛好開口的乙(以前會),也不歸給甲', o.session, null);
  check('乙是可能的那幾個之一(它的頁面會講分不出、不擋)', o.candidates.includes('s2'), JSON.stringify(o));
}

section('魔鬼教官 2026-09-21 第一輪:連著時另寫了一份、再記 --spec 無 → 那次 A 回到一般的 A(這一輪從它開始、清單是它寫的那份),不卡住');
{
  const s = scene();
  s.write(opening(s.root));
  s.cli(['--spec', 'docs/規劃中/app建議卡.md']);
  const lt = Date.parse(s.events().find((e) => e.event === 'spec_link').ts);
  const TL = (sec) => new Date(lt + sec * 1000).toISOString();
  writeFileSync(join(s.root, 'docs/規劃中/Y.md'), specText('Y', 3));
  s.append([
    { ts: TL(10), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:spec`, session: 's1', prompt_id: 'py' },
    { ts: TL(20), hook: 'PostToolUse', tool: 'Write', session: 's1', file: join(s.root, 'docs/規劃中/Y.md'), prompt_id: 'py' },
    { ts: TL(30), event: 'spec_link', none: true, spec: null, by_session: 's1', cwd: s.root, source: 'claude' },
  ]);
  const v = s.by(s.sessionOf('s1')?.stages);
  eq('A 回到一般的 A:叫過的時間是那次、清單是 Y 的 3 條', `${v.A?.ranAt === TL(10)}|${v.A?.checklist?.total}|${v.A?.link}`, 'true|3|null');
  check('收工 hook 不再叫它「這一輪還沒跑」', !/A 寫規格：這一輪還沒跑/.test(s.gate()?.reason ?? ''), s.gate()?.reason);
  s.cleanup();
}

section('魔鬼教官 2026-09-21 第一輪:這一批記的代號在規格裡找不到了(改過號)→ 講出來、不結案、收工 hook 叫它重記', 'P5');
{
  const s = scene();
  s.write(opening(s.root));
  s.cli(['--spec', 'docs/進行中/pipeline-ui.md', 'AC-3', 'AC-4']);
  writeFileSync(join(s.root, 'docs/進行中/pipeline-ui.md'), specText('pipeline-ui', 2, { 1: ' ✅ 對過 2026-09-21', 2: ' ✅ 對過 2026-09-21' }));   // 改號:只剩兩條
  const v = s.by(s.sessionOf('s1')?.stages);
  eq('B 不結案,帶著對不上的代號', `${v.B?.closedBy}|${(v.B?.checklist?.batchMissing ?? []).join(',')}`, 'null|AC-3,AC-4');
  const g = s.gate();
  check('收工 hook 叫它重記 --spec', /這一批記的 AC-3、AC-4/.test(g?.reason ?? '') && /重記一次 pipeline-status --spec/.test(g?.reason ?? ''), g?.reason);
  const term = s.cli([], { session: 's1' }).out;
  check('終端機講「在規格裡找不到了（可能改過號）」', term.includes('在規格裡找不到了（可能改過號）'), term.split('━━ 五關')[1]?.slice(0, 700));
  s.cleanup();
}

section('魔鬼教官 2026-09-21 第一輪:只在主資料夾的規格,--spec 第一行就照實講(不先說「會畫出 N 條」);儀表板換版要自己重新載入');
{
  // 主資料夾有、worktree 沒有:用 git worktree 真的開一個
  const s = scene();
  const wt = join(mkdtempSync(join(tmpdir(), 'pm-wt-')), 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', wt], { cwd: s.root });
  mkdirSync(join(s.root, 'docs', '進行中'), { recursive: true });
  writeFileSync(join(s.root, 'docs/進行中/只在主資料夾.md'), specText('只在主資料夾', 3));   // 主資料夾還沒存,worktree 沒有
  const { CLAUDE_CODE_SESSION_ID: _d, ...env } = process.env;
  let out2 = '';
  try { out2 = execFileSync('node', [join(ROOT, 'status.mjs'), '--spec', 'docs/進行中/只在主資料夾.md'], { cwd: wt, encoding: 'utf8', env: { ...env, CLAUDE_CODE_SESSION_ID: 's1', PIPELINE_MONITOR_HOME: s.monitorDir, PIPELINE_MONITOR_LOG_DIR: join(s.monitorDir, 'logs') } }); } catch (e) { out2 = `失敗：${e.stdout}`; }
  const firstLine = out2.split('\n')[0];
  check('收下,第一行不說「會畫出」,接著講在主資料夾、不畫、不要求打勾', /記下了/.test(firstLine) && !/會畫出/.test(out2) && /規格在主資料夾/.test(out2) && /不畫那 3 條/.test(out2), out2);
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: s.root });
  s.cleanup();
}
{
  const { createApp } = await import('../server.mjs');
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const json = await fetch(`http://127.0.0.1:${server.address().port}/api/status`).then((r) => r.json());
  check('/api/status 帶畫面程式的版本(開著的分頁靠它發現換版、自己重新載入)', typeof json.appVersion === 'string' && json.appVersion.length > 0, String(json.appVersion));
  server.close();
  const app = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  check('畫面發現版本變了會重新載入', /appVersion !== bootVersion/.test(app) && /location\.reload\(\)/.test(app));
}

process.exit(summary());
