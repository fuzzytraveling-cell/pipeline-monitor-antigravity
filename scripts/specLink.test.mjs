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
 *   ⑨ 規格搬家(另一份規格,路徑看 CLAUDE.md 的表):這個對話自己用 A 寫的規格開工搬到進行中,清單不見、收工 hook 安靜地不要求對清單(老毛病 P6);
 *      寫規格那一關的旁白終端機、網頁各抄一份,沒有對過(P2)
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
import { safeName, PROMPT_CAP } from '../lib/events.mjs';
import { linkOwner, roundOf, specContext, sessionView } from '../lib/rounds.mjs';
import { specHint, batchOf, parseChecklist, locateSpec } from '../lib/checklist.mjs';
import { specNotes, clProg, clDoneNote } from '../lib/stageLines.mjs';

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
  // 專案比劇本裡的每一句話都早存在(劇本從幾分鐘前開始):「這次改動」從這一輪的起點算,起點之前要有版本可比(規格:這一輪的起點)
  const r = makeRepo({ at: T(-60 * MIN), files: {
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
  // 跑真的 CLI。對話代號從環境變數給(Claude Code 給 Bash 的那一個);session=null 就拿掉,模擬拿不到代號。
  // ⚠️ HOME 一定要給這個假的(裝了 plugin 的那個):指令找「該跑哪個指令」會看家目錄,用真的家目錄的話,
  //    開發這台電腦裝了 plugin 就綠、GitHub 的機器沒裝就紅(2026-09-22 CI 紅過,LESSONS L24)
  const cli = (args, { session = 's1' } = {}) => {
    const { CLAUDE_CODE_SESSION_ID: _drop, ...env } = process.env;
    if (session) env.CLAUDE_CODE_SESSION_ID = session;
    try { return { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: root, encoding: 'utf8', env: { ...env, HOME: home, PIPELINE_MONITOR_HOME: monitorDir, PIPELINE_MONITOR_LOG_DIR: logDir } }) }; }
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
  const sub = (() => { try { return execFileSync('node', [join(ROOT, 'status.mjs'), '--spec', 'docs/規劃中/app建議卡.md'], { cwd: join(s.root, 'src'), encoding: 'utf8', env: { ...process.env, HOME: s.home, CLAUDE_CODE_SESSION_ID: 's1', PIPELINE_MONITOR_HOME: s.monitorDir, PIPELINE_MONITOR_LOG_DIR: join(s.monitorDir, 'logs') } }); } catch (e) { return `失敗：${e.stdout}`; } })();
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
  check('收工 hook 叫它回頭對一次,並講分不出是誰打的', (g?.missing ?? []).includes('checklist') && /連上之前就打好了，分不出是不是這個對話打的/.test(g?.reason ?? ''), g?.reason);
  const term = s.cli([], { session: 's1' }).out;
  check('終端機講「分不出是不是這個對話打的」', term.includes('清單的勾在連上這份之前就打好了，分不出是不是這個對話打的'), term.split('━━ 五關')[1]?.slice(0, 900));
  // 施工的對話常常先對清單、收工時才記 --spec:勾是誰打的分不出來,不准斷言「這個對話沒對過」(魔鬼教官第二輪 2026-09-22,R1)
  check('不講「這個對話還沒回頭對過」', !/還沒回頭對過/.test(term) && !/還沒回頭對過/.test(g?.reason ?? ''), term.split('━━ 五關')[1]?.slice(0, 900));
  // 網頁的 B 那一行是伺服器給的那一句(lib/stageLines.mjs,跟終端機同一句)——網頁自己不寫
  const bLine = s.by(s.sessionOf('s1')?.stages)?.B?.line ?? '';
  check('網頁也不講「還沒回頭對過」,跟終端機同一句', !/還沒回頭對過/.test(bLine) && bLine.includes('清單的勾在連上這份之前就打好了，分不出是不是這個對話打的'), bLine);
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
  try { out2 = execFileSync('node', [join(ROOT, 'status.mjs'), '--spec', 'docs/進行中/只在主資料夾.md'], { cwd: wt, encoding: 'utf8', env: { ...env, HOME: s.home, CLAUDE_CODE_SESSION_ID: 's1', PIPELINE_MONITOR_HOME: s.monitorDir, PIPELINE_MONITOR_LOG_DIR: join(s.monitorDir, 'logs') } }); } catch (e) { out2 = `失敗：${e.stdout}`; }
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

section('2026-09-21 實測:B 還沒改到程式檔時終端機不准當掉;只有連結的施工對話存檔之後,B 照樣認得改過程式(git 的存檔)');
{
  // A 寫完規格、還沒改程式(main 上的舊程式在這裡當掉:拿 B 的進度摘要去畫條目)
  const s = scene({ touch: null });
  s.write([{ ts: T(-5 * MIN), hook: 'UserPromptSubmit', session: 's1', prompt: '開工', prompt_id: 'p1' }]);
  s.cli(['--spec', 'docs/規劃中/app建議卡.md']);
  const term = s.cli([], { session: 's1' });
  check('B 還沒改到程式檔:終端機跑完、不印程式錯誤,A 的清單照畫', term.code === 0 && !/TypeError|at .*\.mjs/.test(term.out) && term.out.includes('○ AC-1 第 1 條') && /B 寫程式\s*●/.test(term.out), term.out.split('━━ 五關')[1]?.slice(0, 400));
  // 施工:用 Bash 改了程式(感測器沒記到)、存了檔 → git 的存檔就是證據
  writeFileSync(join(s.root, 'src/danger.js'), 'built\n');
  // 存檔時間明確寫在連結之後兩秒:git 的時間只到秒,同一秒內分不出先後(不靠測試跑得快慢,L18)
  const after = new Date(Date.parse(s.events().find((e) => e.event === 'spec_link').ts) + 2000).toISOString();
  execFileSync('git', ['commit', '-qam', '施工', '--date', after], { cwd: s.root, env: { ...process.env, GIT_COMMITTER_DATE: after } });
  const v = s.by(s.sessionOf('s1')?.stages);
  eq('存檔之後 B 照樣認得改過程式(git 說的),帶著清單進度', `${v.B?.state}|${v.B?.via}|${v.B?.checklist?.total}`, 'current|git|7');
  s.cleanup();
}

/* ────────────── 規格搬家(路徑看 CLAUDE.md 的表):這個對話自己用 A 寫的規格,開工照規矩搬到進行中 ────────────── */

/**
 * 同一個對話先跑 A 寫規格、你點頭、開工改到危險清單的檔。跟 2026-09-22 的真實紀錄同一個形狀:
 * Skill 叫 spec、Write 到規劃中、A 收尾 --report 記相對路徑(那筆紀錄沒有對話代號)。
 * bash=true:用 Bash 寫的規格——感測器沒有 Write,只剩 A 收尾記的那一行(L8)
 */
const aWrote = (root, { sid = 's1', spec = 'docs/規劃中/新功能.md', bash = false } = {}) => [
  { ts: T(-20 * MIN), hook: 'UserPromptSubmit', session: sid, prompt: '幫我寫一份規格：新功能', prompt_id: `${sid}-a` },
  { ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', session: sid, prompt_id: `${sid}-a` },
  ...(bash ? [] : [{ ts: T(-19 * MIN), hook: 'PostToolUse', tool: 'Write', session: sid, file: join(root, spec), prompt_id: `${sid}-a` }]),
  { ts: T(-18 * MIN), event: 'stage_report', stage: 'A', verdict: 'ok', note: spec, source: 'claude', session: undefined },
  { ts: T(-5 * MIN), hook: 'UserPromptSubmit', session: sid, prompt: '點頭，開工', prompt_id: `${sid}-p2` },
  { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', session: sid, file: join(root, 'src/danger.js'), prompt_id: `${sid}-p2` },
];
/**
 * 寫規格那一關的旁白只寫一份(lib/stageLines.mjs 的 specNotes;規格:終端機與網頁說同一句):終端機照預設印(指去儀表板);
 * 伺服器帶給網頁的是 notes 那一欄(網頁照印)——儀表板算出來的那一格就看那一欄,自己造的那一格照伺服器的做法算一次。ago 兩邊餵同一個
 */
const FAKE_AGO = (ts) => `〈${ts}〉`;
const webNotes = (st) => (Array.isArray(st?.notes) ? st.notes : specNotes(st, { ago: FAKE_AGO, seePages: '看各對話的頁面' }));
const cliNotes = (st) => specNotes(st, Array.isArray(st?.notes) ? {} : { ago: FAKE_AGO });
const fiveOf = (term) => term.split('━━ 五關')[1] ?? '';

section('規格搬家 AC-1、AC-2:這個對話用 A 寫的規格,開工照規矩搬到進行中 → 清單照畫、B 照樣帶進度、收工 hook 照樣要求對清單,而且指的是新位置', 'P6');
{
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/新功能.md'), specText('新功能', 3));
  s.write(aWrote(s.root));
  const before = s.by(s.sessionOf('s1')?.stages), gBefore = s.gate();
  eq('搬家之前:A 畫 3 條、B 帶著進度、收工 hook 要求對清單', `${before.A?.checklist?.total}|${before.B?.checklist?.unmarked}|${(gBefore?.missing ?? []).includes('checklist')}`, '3|3|true');
  eq('搬家之前:規格在這裡、沒搬(畫面不講「搬到了」)', `${before.A?.specPlace?.found}|${before.A?.specPlace?.moved}`, 'here|false');
  // 你點頭 → 照 CLAUDE.md「工作項的狀態就是路徑」搬到進行中。用 Bash 搬(mv／git mv),感測器看不到——找檔靠檔案系統,不靠紀錄
  renameSync(join(s.root, 'docs/規劃中/新功能.md'), join(s.root, 'docs/進行中/新功能.md'));
  const a = s.by(s.sessionOf('s1')?.stages), g = s.gate();
  eq('搬到進行中:A 照畫 3 條,不是「找不到這一輪的規格檔」', `${a.A?.checklist?.missing}|${a.A?.checklist?.total}|${String(a.A?.checklist?.file).endsWith('docs/進行中/新功能.md')}`, 'false|3|true');
  eq('B 照樣帶著進度 0/3,對完才劃掉', `${a.B?.checklist?.parsed}|${a.B?.checklist?.checked}/${a.B?.checklist?.total}|${a.B?.state}`, 'true|0/3|current');
  eq('規格在哪:在這個工作區、搬了、記的是規劃中那一份', `${a.A?.specPlace?.found}|${a.A?.specPlace?.moved}|${a.A?.specPlace?.rel}|${a.A?.specPlace?.given}`, 'here|true|docs/進行中/新功能.md|docs/規劃中/新功能.md');
  check('A 自己寫的規格不被畫成「別的對話寫的」:沒有連結、不是照連結走過、分級卡那一行不寫「規格是別的對話寫的」',
    a.A?.link === null && a.A?.closedBy !== 'link' && !/別的對話寫的/.test(JSON.stringify(s.sessionOf('s1')?.tier ?? {})), JSON.stringify({ link: a.A?.link, closedBy: a.A?.closedBy }));
  eq('收工 hook 缺的跟搬家之前一模一樣(對清單沒有安靜地消失)', (g?.missing ?? []).join(','), (gBefore?.missing ?? []).join(','));
  const line = (g?.reason ?? '').split('\n').find((l) => l.includes('對規格的清單')) ?? '';
  check('對清單那一行指的是新位置,不叫 Claude 去舊位置打勾', line.includes('docs/進行中/新功能.md') && !line.includes('docs/規劃中/新功能.md'), g?.reason);
  const five = fiveOf(s.cli([], { session: 's1' }).out);
  check('終端機:A 畫出清單、講「規格搬到了」,不說找不到', !/找不到(這一輪的)?規格檔/.test(five) && five.includes('規格搬到了 docs/進行中/新功能.md（記的是 docs/規劃中/新功能.md）') && five.includes('○ AC-1 第 1 條'), five.slice(0, 700));
  // 結案搬到升級摘要 → 還是讀得到(跟連結那條路一樣)
  renameSync(join(s.root, 'docs/進行中/新功能.md'), join(s.root, 'docs/升級摘要/新功能.md'));
  const done = s.by(s.sessionOf('s1')?.stages);
  eq('搬到升級摘要 → 照樣讀得到', `${done.A?.specPlace?.rel}|${done.A?.checklist?.total}`, 'docs/升級摘要/新功能.md|3');
  s.cleanup();
}
{
  // 用 Bash 寫的規格(只有 A 收尾記的相對路徑);搬家之前用 Edit 打了一個勾(感測器記在舊路徑上);搬家之後再用 Bash 打完剩下的
  const s = scene();
  const old = join(s.root, 'docs/規劃中/新功能.md'), now = join(s.root, 'docs/進行中/新功能.md');
  writeFileSync(old, specText('新功能', 3, { 1: ' ✅ 對過 2026-09-22' }));
  s.write(aWrote(s.root, { bash: true }));
  s.append([{ ts: T(-3 * MIN), hook: 'PostToolUse', tool: 'Edit', file: old, prompt_id: 's1-p2' }]);
  renameSync(old, now);
  let v = s.by(s.sessionOf('s1')?.stages);
  eq('只有 A 收尾記的相對路徑,搬家之後也找得到;搬家之前打的勾還在', `${v.A?.specPlace?.moved}|${v.A?.checklist?.checked}/${v.A?.checklist?.total}`, 'true|1/3');
  writeFileSync(now, specText('新功能', 3, { 1: ' ✅ 對過 2026-09-22', 2: ' ✅ 對過 2026-09-22', 3: ' ✅ 對過 2026-09-22' }));
  v = s.by(s.sessionOf('s1')?.stages);
  // 時間是感測器記到的最後一次改規格檔:搬家之前記在舊路徑上的那次也認。用 Bash 打的勾看不到(L8)——寧可早,不可晚(不看檔案的修改時間,見下一段)
  eq('對完清單:B 結案,時間是感測器記到的最後一次改規格檔(搬家之前記在舊路徑上的那次也認)', `${v.B?.closedBy}|${v.B?.doneAt}`, `checklist|${T(-3 * MIN)}`);
  check('收工 hook 不再要求對清單', !(s.gate()?.missing ?? []).includes('checklist'), s.gate()?.reason);
  s.cleanup();
}

section('規格搬家 AC-3:找到的位置跟記的不一樣,畫面講一句「搬到了」——自己寫的、別的對話寫的同一句;終端機跟網頁的旁白真的跑兩邊、一字不差', 'P2');
{
  // 別的對話寫的規格(--spec 連的)搬家:以前是靜默換掉路徑,現在跟 A 自己寫的那條路講同一句
  const s = scene();
  s.write(opening(s.root));
  s.cli(['--spec', 'docs/規劃中/app建議卡.md']);
  let a = s.by(s.sessionOf('s1')?.stages).A;
  eq('連結那條路、沒搬:不講「搬到了」', `${a?.specPlace?.found}|${a?.specPlace?.moved}|${(webNotes?.(a) ?? []).length}`, 'here|false|0');
  renameSync(join(s.root, 'docs/規劃中/app建議卡.md'), join(s.root, 'docs/進行中/app建議卡.md'));
  a = s.by(s.sessionOf('s1')?.stages).A;
  eq('連結那條路、搬到進行中:跟 A 自己寫的那條路同一個形狀', `${a?.specPlace?.found}|${a?.specPlace?.moved}|${a?.specPlace?.rel}|${a?.specPlace?.given}`, 'here|true|docs/進行中/app建議卡.md|docs/規劃中/app建議卡.md');
  const moved = '規格搬到了 docs/進行中/app建議卡.md（記的是 docs/規劃中/app建議卡.md）';
  const five = fiveOf(s.cli([], { session: 's1' }).out);
  check('終端機講「規格搬到了」', five.includes(moved), five.slice(0, 500));
  check('網頁的旁白(伺服器帶給網頁的那一份,網頁照印)講同一句', (webNotes?.(a) ?? []).includes(moved), JSON.stringify(webNotes?.(a)));
  s.cleanup();
}
{
  // 以前兩份旁白各抄一份(終端機、網頁);現在只住 lib/stageLines.mjs。每一種情況都餵兩邊(終端機那一種、帶給網頁那一種),輸出要一字不差
  const app = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8'), cli = readFileSync(join(ROOT, 'lib', 'cliStages.mjs'), 'utf8');
  check('旁白只有一份:網頁與終端機都不再自己寫(沒有自己的 specNotes),終端機從 lib/stageLines.mjs 拿',
    !/function specNotes\(/.test(app) && !/function specNotes\(/.test(cli) && /from '\.\/stageLines\.mjs'/.test(cli));
  const cases = {
    搬了: { specPlace: { found: 'here', name: 'x', rel: 'docs/進行中/x.md', given: 'docs/規劃中/x.md', moved: true } },
    沒搬: { specPlace: { found: 'here', name: 'x', rel: 'docs/規劃中/x.md', given: 'docs/規劃中/x.md', moved: false } },
    在主資料夾: { specPlace: { found: 'main', name: 'x', rel: 'docs/進行中/x.md', given: 'docs/規劃中/x.md', moved: false } },
    找不到: { specPlace: { found: 'missing', name: 'x', rel: null, given: 'docs/規劃中/x.md', moved: false } },
    找不到而且記的在工作區外: { specPlace: { found: 'missing', name: 'x', rel: null, given: null, moved: false } },
    同名兩份: { specPlace: { found: 'ambiguous', name: 'x', rel: null, given: 'docs/規劃中/x.md', where: ['docs/進行中/x.md', 'docs/升級摘要/x.md'], moved: false } },
    另寫一份: { link: { name: 'x' }, specPlace: { found: 'here', name: 'x', moved: false }, side: { name: 'y', ts: T(-60) } },
    另寫一份看不到名字: { link: { name: 'x' }, specPlace: { found: 'here', name: 'x', moved: false }, side: { name: null, ts: T(-60) } },
    第一句話的提示: { hint: { name: 'x', cut: false } },
    第一句話被截過: { hint: { name: 'x', cut: true } },
    分不出誰記的: { unsure: { name: 'x' } },
    資料夾不在了規格在主資料夾: { specPlace: { found: 'main', name: 'x', rel: 'docs/規劃中/x.md', given: 'docs/規劃中/x.md', gone: true } },
    資料夾不在了也找不到: { specPlace: { found: 'missing', name: 'x', rel: null, given: 'docs/規劃中/x.md', gone: true } },
    寫在主資料夾: { specPlace: { found: 'main', name: 'x', rel: 'docs/規劃中/x.md', given: 'docs/規劃中/x.md', recordedIn: 'main' } },
    寫在主資料夾但找不到: { specPlace: { found: 'missing', name: 'x', rel: null, given: 'docs/規劃中/x.md', recordedIn: 'main' } },
    同名的比這一輪還舊: { specPlace: { found: 'older', name: 'x', rel: 'docs/升級摘要/x.md', given: 'docs/規劃中/x.md' } },
    記的在工作區外: { specPlace: { found: 'outside', name: 'x', rel: null, given: null } },
    // 規格:多份規格與新資料夾的起點(AC-5、AC-7、AC-6、AC-1)
    好幾份規格一份搬了一份找不到: { specPlace: null, specPlaces: [
      { found: 'here', name: '甲', rel: 'docs/進行中/甲.md', given: 'docs/規劃中/甲.md', moved: true },
      { found: 'here', name: '乙', rel: 'docs/規劃中/乙.md', given: 'docs/規劃中/乙.md', moved: false },
      { found: 'missing', name: '丙', rel: null, given: 'docs/規劃中/丙.md', moved: false }] },
    另寫兩份: { link: { name: 'x' }, specPlace: { found: 'here', name: 'x', moved: false }, side: { name: 'y、z', count: 2, ts: T(-60) } },
    換掉連結: { link: { name: 'y' }, specPlace: { found: 'here', name: 'y', moved: false }, replaced: { from: 'x', to: 'y', ts: T(-60) } },
    還動了一份規格: { specPlace: { found: 'here', name: 'x', moved: false }, extraSpecs: ['戊'] },
    還動了兩份規格: { extraSpecs: ['戊', '己'] },
  };
  for (const [k, st] of Object.entries(cases)) eq(`${k}:終端機跟網頁一字不差`, JSON.stringify(webNotes?.(st) ?? null), JSON.stringify(cliNotes?.(st) ?? null));
  // 唯一刻意不一樣的一句:終端機要指去儀表板,網頁本身就是儀表板——講的事一樣
  const sh = { shared: 2 };
  check('好幾個對話共用工作區:兩邊講的是同一件事(終端機多指一句去儀表板)', [cliNotes?.(sh)?.[0], webNotes?.(sh)?.[0]].every((l) => typeof l === 'string' && l.includes('規格連結只算記它的那個對話')), JSON.stringify([cliNotes?.(sh), webNotes?.(sh)]));
  // 對照組:不然上面的「一字不差」可能只是兩邊都印空的
  check('對照組:搬了講一句、沒搬一句都不講', (cliNotes?.(cases.搬了) ?? []).length === 1 && (cliNotes?.(cases.沒搬) ?? []).length === 0, JSON.stringify([cliNotes?.(cases.搬了), cliNotes?.(cases.沒搬)]));
}

section('規格搬家 AC-4:A 自己寫的規格——同名不只一份不猜、都找不到照實說、只在主資料夾只講一句;三種都不畫清單、收工 hook 都不要求對清單');
{
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/新功能.md'), specText('新功能', 3));
  s.write(aWrote(s.root));
  renameSync(join(s.root, 'docs/規劃中/新功能.md'), join(s.root, 'docs/進行中/新功能.md'));
  writeFileSync(join(s.root, 'docs/升級摘要/新功能.md'), specText('新功能', 5));   // 同名的另一份
  let a = s.by(s.sessionOf('s1')?.stages);
  eq('同名兩份 → 分不出來:不畫清單、B 沒有要對的清單', `${a.A?.specPlace?.found}|${a.A?.checklist}|${a.B?.checklist}`, 'ambiguous|null|null');
  check('收工 hook 不叫 Claude 去猜的那一份打勾', !(s.gate()?.missing ?? []).includes('checklist'), s.gate()?.reason);
  let five = fiveOf(s.cli([], { session: 's1' }).out);
  check('終端機:同名不只一份,列出在哪', five.includes('工作區裡叫 新功能.md 的規格不只一份（docs/進行中/新功能.md、docs/升級摘要/新功能.md），分不出是哪一份'), five.slice(0, 500));
  // 都找不到
  rmSync(join(s.root, 'docs/進行中/新功能.md')); rmSync(join(s.root, 'docs/升級摘要/新功能.md'));
  a = s.by(s.sessionOf('s1')?.stages);
  eq('都找不到 → 找不到,不畫清單(不是「沒有清單」)', `${a.A?.specPlace?.found}|${a.A?.checklist}`, 'missing|null');
  const miss = '找不到規格檔 新功能.md（記的是 docs/規劃中/新功能.md；規劃中／進行中／升級摘要都沒有同名的）';
  five = fiveOf(s.cli([], { session: 's1' }).out);
  check('終端機:找不到規格檔,講記的位置跟找過哪裡', five.includes(miss), five.slice(0, 500));
  check('網頁講同一句', (webNotes?.(a.A) ?? []).includes(miss), JSON.stringify(webNotes?.(a.A)));
  check('找不到的時候不擋人:不要求對清單', !(s.gate()?.missing ?? []).includes('checklist'));
  s.cleanup();
}
{
  // 只在主資料夾(worktree 還沒併進來,或 Claude 寫錯了地方):只講在主資料夾,不給檔案,不叫 Claude 去那裡打勾
  const main = mkdtempSync(join(tmpdir(), 'pm-main-')), wt = mkdtempSync(join(tmpdir(), 'pm-wt-'));
  mkdirSync(join(main, 'docs', '進行中'), { recursive: true });
  writeFileSync(join(main, 'docs/進行中/新功能.md'), specText('新功能', 2));
  const v = sessionView([
    { ts: T(-300), hook: 'UserPromptSubmit', session: 's1', cwd: wt, prompt: '寫規格', prompt_id: 'a' },
    { ts: T(-300), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', session: 's1', cwd: wt, prompt_id: 'a' },
    { ts: T(-290), hook: 'PostToolUse', tool: 'Write', session: 's1', cwd: wt, file: join(wt, 'docs/規劃中/新功能.md'), prompt_id: 'a' },
  ], STAGES, 's1', null, wt, { mainRoot: main }).view;
  const a = v.stages.find((x) => x.id === 'A'), b = v.stages.find((x) => x.type === 'main-conversation');
  eq('A 寫的規格只在主資料夾 → found=main:不畫清單、B 沒有要對的清單', `${a.specPlace?.found}|${a.checklist}|${b.checklist}`, 'main|null|null');
  check('講「規格在主資料夾」', (webNotes?.(a) ?? []).some((l) => l.startsWith('規格在主資料夾')), JSON.stringify(webNotes?.(a)));
  // 記的位置在工作區外:只用檔名在工作區的三個資料夾找,不拿工作區外的那一份
  const out = mkdtempSync(join(tmpdir(), 'pm-out-'));
  mkdirSync(join(out, 'docs', '規劃中'), { recursive: true });
  writeFileSync(join(out, 'docs/規劃中/外面的.md'), specText('外面的', 2));
  const o = sessionView([
    { ts: T(-300), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', session: 's1', cwd: wt, prompt_id: 'a' },
    { ts: T(-290), hook: 'PostToolUse', tool: 'Write', session: 's1', cwd: wt, file: join(out, 'docs/規劃中/外面的.md'), prompt_id: 'a' },
  ], STAGES, 's1', null, wt, {}).view.stages.find((x) => x.id === 'A');
  eq('記的位置在工作區外 → 不讀那一份,照實講不在這個工作區', `${o.specPlace?.found}|${o.specPlace?.given}|${o.checklist}`, 'outside|null|null');
  check('講「不在這個工作區，也不在主資料夾」', (webNotes?.(o) ?? []).includes('記的規格檔 外面的.md 不在這個工作區，也不在主資料夾——不會叫 Claude 去那裡打勾'), JSON.stringify(webNotes?.(o)));
  for (const d of [main, wt, out]) rmSync(d, { recursive: true, force: true });
}
{
  // 記的位置怎麼換成相對工作區的:以前絕對路徑直接拿去 join,拼出一個不存在的位置,只是碰巧靠同名搜尋救回來
  const w = mkdtempSync(join(tmpdir(), 'pm-loc-'));
  mkdirSync(join(w, 'docs', '進行中'), { recursive: true });
  writeFileSync(join(w, 'docs/進行中/x.md'), specText('x', 1));
  const abs = locateSpec(join(w, 'docs/進行中/x.md'), { root: w });
  eq('絕對路徑、還在原位 → 就是它,沒搬', `${abs.found}|${abs.given}|${abs.moved}`, 'here|docs/進行中/x.md|false');
  const dot = locateSpec('./docs/進行中/x.md', { root: w });
  eq('「./」開頭的相對路徑 → 同一個位置,不誤報「搬到了」', `${dot.found}|${dot.given}|${dot.moved}`, 'here|docs/進行中/x.md|false');
  const up = locateSpec('../別的/docs/進行中/x.md', { root: w });
  eq('往上跳出工作區的相對路徑 → 工作區外,不拿工作區裡的同名檔頂替', `${up.found}|${up.given}|${up.rel}|${up.moved}`, 'outside|null|null|false');
  rmSync(w, { recursive: true, force: true });
}

section('規格搬家:魔鬼教官 2026-09-22 第一輪——記的位置有好幾種(工作區、它的 git 根、主資料夾、工作區外、資料夾已經不在),每一種都照記的地方找,不拿同名的另一份頂替', 'P6');
{
  // 同名的舊規格:上一輪做完、放在升級摘要,全部打勾,修改時間比這一輪早(worktree 建立時 git 寫出來的就是這樣)
  const s = scene();
  const prev = join(s.root, 'docs/升級摘要/新功能.md');
  writeFileSync(prev, specText('新功能', 4, { 1: ' ✅ 對過 2026-09-01', 2: ' ✅ 對過 2026-09-01', 3: ' ✅ 對過 2026-09-01', 4: ' ✅ 對過 2026-09-01' }));
  const longAgo = new Date(NOW - 3 * 86400_000);
  utimesSync(prev, longAgo, longAgo);
  writeFileSync(join(s.root, 'docs/規劃中/新功能.md'), specText('新功能', 3));
  s.write(aWrote(s.root));
  renameSync(join(s.root, 'docs/規劃中/新功能.md'), join(s.root, 'docs/進行中/新功能.md'));
  eq('搬到進行中、升級摘要有同名的舊規格 → 分不出來(AC-4,照舊)', s.by(s.sessionOf('s1')?.stages).A?.specPlace?.found, 'ambiguous');
  // 為了消掉「分不出來」把新的改名 → 工作區只剩上一輪那份同名的
  renameSync(join(s.root, 'docs/進行中/新功能.md'), join(s.root, 'docs/進行中/新功能-第二輪.md'));
  const v = s.by(s.sessionOf('s1')?.stages);
  eq('比記的那份還舊的同名檔分不出是不是同一份:不畫它的清單', `${v.A?.specPlace?.found}|${v.A?.specPlace?.rel}|${v.A?.checklist}`, 'older|docs/升級摘要/新功能.md|null');
  check('B 不拿別份的舊勾結案', v.B?.closedBy !== 'checklist' && v.B?.checklist === null, JSON.stringify({ closedBy: v.B?.closedBy, checklist: v.B?.checklist }));
  check('收工 hook 不叫 Claude 去已結案的規格補勾', !(s.gate()?.missing ?? []).includes('checklist'), s.gate()?.reason);
  const older = '記的規格檔 新功能.md 不在記的位置（docs/規劃中/新功能.md）；工作區裡同名的 docs/升級摘要/新功能.md 比記的那份還舊，分不出是不是同一份——不畫它的清單';
  const five = fiveOf(s.cli([], { session: 's1' }).out);
  check('終端機照實講', five.includes(older), five.slice(0, 600));
  check('網頁講同一句', (webNotes?.(v.A) ?? []).includes(older), JSON.stringify(webNotes?.(v.A)));
  s.cleanup();
}
{
  // 資料夾已經不在了(worktree 清掉了,規格已經併進主資料夾):真的走儀表板收集資料那條路——資料夾不在的卡沒有主資料夾,要用專案的
  const s = scene();
  const goneWt = join(s.root, '.claude', 'worktrees', '已經刪掉的');
  s.write([
    { ts: T(-20 * MIN), hook: 'UserPromptSubmit', session: 's2', cwd: goneWt, prompt: '寫規格', prompt_id: 's2-a' },
    { ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', session: 's2', cwd: goneWt, prompt_id: 's2-a' },
    { ts: T(-19 * MIN), hook: 'PostToolUse', tool: 'Write', session: 's2', cwd: goneWt, file: join(goneWt, 'docs/規劃中/app建議卡.md'), prompt_id: 's2-a' },
    { ts: T(-10 * MIN), hook: 'UserPromptSubmit', session: 's1', prompt: '看一下', prompt_id: 's1-p1' },
  ]);
  const a = s.by(s.sessionOf('s2')?.stages).A;
  eq('資料夾不在了、主資料夾有 → 講資料夾不在了、規格在主資料夾;不畫清單', `${a?.specPlace?.gone}|${a?.specPlace?.found}|${a?.checklist}`, 'true|main|null');
  check('句子:資料夾不在了、規格在主資料夾', (webNotes?.(a) ?? []).includes('這個對話的資料夾已經不在了；規格在主資料夾：docs/規劃中/app建議卡.md'), JSON.stringify(webNotes?.(a)));
  s.cleanup();
  // 不知道主資料夾在哪(專案裡沒有一張活著的卡):不准講「三個資料夾都沒有同名的」——根本沒辦法找
  const w = mkdtempSync(join(tmpdir(), 'pm-gone-')), gone = join(w, '不在了');
  const g = sessionView([
    { ts: T(-300), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', session: 's1', cwd: gone, prompt_id: 'a' },
    { ts: T(-290), hook: 'PostToolUse', tool: 'Write', session: 's1', cwd: gone, file: join(gone, 'docs/規劃中/新功能.md'), prompt_id: 'a' },
  ], STAGES, 's1', null, gone, {}).view.stages.find((x) => x.id === 'A');
  const gn = webNotes?.(g) ?? [];
  check('資料夾不在了、也不知道主資料夾 → 講資料夾不在了,不講「都沒有同名的」', gn.includes('這個對話的資料夾已經不在了，找不到記的規格檔（docs/規劃中/新功能.md）') && !gn.some((l) => l.includes('都沒有同名的')), JSON.stringify(gn));
  rmSync(w, { recursive: true, force: true });
}
{
  // worktree 的對話照第一句話把規格寫進了主資料夾;worktree 裡那一份是 git 帶過來的舊版——不准拿它頂替
  const main = mkdtempSync(join(tmpdir(), 'pm-main-')), wt = mkdtempSync(join(tmpdir(), 'pm-wt-'));
  for (const [d, n] of [[main, 5], [wt, 13]]) { mkdirSync(join(d, 'docs', '規劃中'), { recursive: true }); writeFileSync(join(d, 'docs/規劃中/D多輪.md'), specText('D多輪', n)); }
  const a = sessionView([
    { ts: T(-300), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', session: 's1', cwd: wt, prompt_id: 'a' },
    { ts: T(-290), hook: 'PostToolUse', tool: 'Write', session: 's1', cwd: wt, file: join(main, 'docs/規劃中/D多輪.md'), prompt_id: 'a' },
  ], STAGES, 's1', null, wt, { mainRoot: main }).view.stages.find((x) => x.id === 'A');
  eq('記在主資料夾 → 只在主資料夾找,不拿 worktree 裡同名的那一份(13 條的舊版)', `${a.specPlace?.found}|${a.specPlace?.recordedIn}|${a.checklist}`, 'main|main|null');
  check('講「規格寫在主資料夾」,不講「可能還沒併進來」', (webNotes?.(a) ?? []).includes('規格寫在主資料夾（docs/規劃中/D多輪.md），不在這個工作區——不會叫 Claude 去那裡打勾'), JSON.stringify(webNotes?.(a)));
  for (const d of [main, wt]) rmSync(d, { recursive: true, force: true });
}
{
  // 對話 cd 進了專案的子資料夾:感測器記的 cwd 跟著變,記的絕對路徑在 git 的根底下——舊程式照樣要求對清單,這裡也要
  const s = scene();
  const sub = join(s.root, 'src');
  writeFileSync(join(s.root, 'docs/規劃中/新功能.md'), specText('新功能', 3));
  s.write(aWrote(s.root).map((e) => ({ ...e, cwd: sub })));
  renameSync(join(s.root, 'docs/規劃中/新功能.md'), join(s.root, 'docs/進行中/新功能.md'));
  const a = s.sessionOf('s1')?.stages?.find((x) => x.id === 'A');
  eq('子資料夾的對話:照 git 的根找,搬到進行中也找得到', `${a?.specPlace?.found}|${a?.specPlace?.rel}|${a?.checklist?.total}`, 'here|docs/進行中/新功能.md|3');
  const d = decide({ payload: { session_id: 's1', cwd: sub, hook_event_name: 'Stop', stop_hook_active: false }, monitorDir: s.monitorDir, skillHome: s.home });
  check('收工 hook 照樣要求對清單,指的是新位置', (d?.missing ?? []).includes('checklist') && /docs\/進行中\/新功能\.md/.test(d?.reason ?? ''), d?.reason);
  s.cleanup();
}
{
  // 對完清單之後照規矩追加施作紀錄(用 Bash,感測器看不到;只有檔案的修改時間變成現在)——
  // B 不准變成這一輪的最後一步,D 的「找到問題」不准被畫成已走過(第二位審查員抓到:改看檔案修改時間的時候就會這樣)
  const s = scene();
  const f = join(s.root, 'docs/規劃中/新功能.md');
  writeFileSync(f, specText('新功能', 2));
  s.write(aWrote(s.root));
  writeFileSync(f, specText('新功能', 2, { 1: ' ✅ 對過 2026-09-22', 2: ' ✅ 對過 2026-09-22' }));
  s.append([
    { ts: T(-3 * MIN), hook: 'PostToolUse', tool: 'Edit', file: f, prompt_id: 's1-p2' },
    { ts: T(-2 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:chaos-check', prompt_id: 's1-p2' },
    { ts: T(-1 * MIN), event: 'stage_report', stage: 'D', verdict: 'found', note: '找到 1 條', source: 'claude', session: undefined },
  ]);
  appendFileSync(f, '\n## 施作紀錄\n追加一段\n');
  const v = s.by(s.sessionOf('s1')?.stages);
  eq('B 對完清單,時間照舊是打勾那一刻(不是追加紀錄的那一刻)', `${v.B?.closedBy}|${v.B?.doneAt}`, `checklist|${T(-3 * MIN)}`);
  eq('D 找到問題還是現在這一關,沒有被畫成已走過', `${v.D?.state}|${v.D?.report?.verdict}`, 'current|found');
  s.cleanup();
}

section('規格搬家:魔鬼教官 2026-09-22 第二輪——又叫了一次 A 但沒改規格檔,同一份規格搬家之後照樣找得到;沒有寫檔的紀錄可比時,只講分不出,不講是別份');
{
  // 第一次 A 用 Write 寫了規格(感測器記到);這一輪又叫了一次 A,Claude 看了說不用改,只記了位置;之後搬到進行中
  const w = mkdtempSync(join(tmpdir(), 'pm-rerun-'));
  for (const d of ['規劃中', '進行中', '升級摘要']) mkdirSync(join(w, 'docs', d), { recursive: true });
  const f = join(w, 'docs/規劃中/X.md');
  writeFileSync(f, specText('X', 2));
  const wroteAt = new Date(Math.floor((NOW - 3600_000) / 1000) * 1000);
  utimesSync(f, wroteAt, wroteAt);
  const again = [
    { ts: T(-600), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', session: 's1', cwd: w, prompt_id: 'a2' },
    { ts: T(-590), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/X.md', cwd: w, source: 'claude' },
  ];
  const withWrite = [
    { ts: T(-3601), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', session: 's1', cwd: w, prompt_id: 'a1' },
    { ts: wroteAt.toISOString(), hook: 'PostToolUse', tool: 'Write', session: 's1', cwd: w, file: f, prompt_id: 'a1' },
    ...again,
  ];
  renameSync(f, join(w, 'docs/進行中/X.md'));
  const a = sessionView(withWrite, STAGES, 's1', null, w, {}).view.stages.find((x) => x.id === 'A');
  eq('感測器記到第一次 A 寫了它 → 搬到進行中照樣找得到,清單照畫', `${a.specPlace?.found}|${a.specPlace?.moved}|${a.checklist?.total}`, 'here|true|2');
  // 兩次都是用 Bash 寫的(感測器沒有寫檔的紀錄):只剩這一次 A 的時間可比——比它還舊就只講分不出,不講是別份
  const b = sessionView(again, STAGES, 's1', null, w, {}).view.stages.find((x) => x.id === 'A');
  const bn = webNotes?.(b) ?? [];
  check('沒有寫檔紀錄可比 → 不畫清單,只講分不出是不是同一份,不講「不是這一輪寫的」', b.specPlace?.found === 'older' && b.checklist === null && bn.some((l) => l.includes('分不出是不是同一份')) && !bn.some((l) => /不是這一輪寫的/.test(l)), JSON.stringify(bn));
  rmSync(w, { recursive: true, force: true });
}

/** 網頁的五關:把 ui/app.js 的 workflow 與它用到的小函式**原封不動**拿出來跑(L20)。拿不出來就是 null,用到的地方會紅 */
const webWorkflow = (() => {
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const fn = (name) => src.match(new RegExp(`^function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const one = (name) => src.match(new RegExp(`^const ${name} = .*;$`, 'm'))?.[0] ?? null;
  // 那一句、旁白、清單的那幾句都是伺服器給的(規格:終端機與網頁說同一句):畫面只剩 workflow 與它的小幫手
  // (roundStage:這一輪走到哪一關;FACE／eyes／agent:畫工班——工地工班風畫面 AC-7、AC-8)
  const parts = [one('stageState'), one('OLD_LINE'), one('FACE'), fn('roundStage'), fn('eyes'), fn('agent'), fn('workflow')];
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return parts.every(Boolean) ? new Function('esc', 'ago', 'ROLE', 'foldOpen', `${parts.join('\n')}; return workflow;`)(esc, (t) => (t ? '5 分鐘前' : ''), {}, () => true) : null;
})();
/** 對話列與案件卡的「這一輪走到…」:ui/app.js 的 roundWhere 與它問「走到哪一關」的 roundStage 原封不動拿出來跑 */
const webRoundWhere = (() => {
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const parts = ['roundStage', 'roundWhere'].map((n) => src.match(new RegExp(`^function ${n}\\(stages\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null);
  return parts.every(Boolean) ? new Function(`${parts.join('\n')}; return roundWhere;`)() : null;
})();
const repA = (sec, note) => ({ ts: T(sec), event: 'stage_report', stage: 'A', verdict: 'ok', note, source: 'claude', by_session: 's1', session: undefined });

section('多份規格 AC-1～AC-4:一次 A 寫了兩份 → A 那格畫兩份、條數加起來;收工 hook、E 都要每一份(2026-10-02 實測:畫面「全部 5 條」其實 15 條,收工 hook 只要那 5 條)', 'P6');
{
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/甲.md'), specText('甲', 3));
  writeFileSync(join(s.root, 'docs/規劃中/乙.md'), specText('乙', 2));
  // TutorPod 那一次的樣子:叫了 A 之後,規格是在背景工作的通知那一回合寫的(prompt_id 跟 A 那次不同);Claude 收尾記了兩筆
  s.write([
    { ts: T(-30 * MIN), hook: 'UserPromptSubmit', prompt: '接著處理待辦', prompt_id: 'p1' },
    { ts: T(-30 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'p1' },
    { ts: T(-25 * MIN), hook: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>w1</task-id>', prompt_id: 'p2' },
    { ts: T(-24 * MIN), hook: 'PostToolUse', tool: 'Write', file: join(s.root, 'docs/規劃中/甲.md'), prompt_id: 'p2' },
    { ts: T(-24 * MIN), hook: 'PostToolUse', tool: 'Write', file: join(s.root, 'docs/規劃中/乙.md'), prompt_id: 'p2' },
    repA(-23 * MIN, 'docs/規劃中/甲.md'), repA(-23 * MIN + 0.08, 'docs/規劃中/乙.md'),
  ]);
  let a = s.by(s.sessionOf('s1')?.stages);
  eq('A 那格:兩份都在,條數加起來', `${a.A?.checklist?.multi}|${a.A?.checklist?.parts?.map((p) => `${p.name}:${p.checklist?.total}`).join(',')}|${a.A?.checklist?.total}`, 'true|甲:3,乙:2|5');
  // 你點頭 → 兩份都搬到進行中(用 Bash 搬,感測器看不到),Claude 又各記一筆新位置;開始改程式
  for (const n of ['甲', '乙']) renameSync(join(s.root, `docs/規劃中/${n}.md`), join(s.root, `docs/進行中/${n}.md`));
  s.append([repA(-6 * MIN, 'docs/進行中/甲.md'), repA(-6 * MIN + 0.08, 'docs/進行中/乙.md'),
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '要，開工', prompt_id: 'p3' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/danger.js'), prompt_id: 'p3' }]);
  a = s.by(s.sessionOf('s1')?.stages);
  eq('搬家、各記了兩次:還是兩份(同一份不重複算)', `${a.A?.checklist?.parts?.length}|${a.A?.checklist?.total}|${a.A?.specPlaces?.map((p) => `${p.name}:${p.found}`).join(',')}`, '2|5|甲:here,乙:here');
  eq('B 帶的是兩份加起來的進度', `${a.B?.checklist?.multi}|${a.B?.checklist?.specs}|${a.B?.checklist?.checked}/${a.B?.checklist?.total}|${a.B?.state}`, 'true|2|0/5|current');
  let g = s.gate();
  let cl = (g?.reason ?? '').split('\n').find((l) => l.includes('對規格的清單')) ?? '';
  check('收工 hook 兩份都要:各列各的條目,指的是新位置', cl.includes('這一輪 2 份規格') && cl.includes('docs/進行中/甲.md 的 AC-1、AC-2、AC-3') && cl.includes('docs/進行中/乙.md 的 AC-1、AC-2'), g?.reason);
  // 只對完甲 → 還要乙(以前拿第一份讀得出的清單,對完它就放行)
  writeFileSync(join(s.root, 'docs/進行中/甲.md'), specText('甲', 3, { 1: ' ✅ 對過 2026-10-05', 2: ' ✅ 對過 2026-10-05', 3: ' ✅ 對過 2026-10-05' }));
  g = s.gate();
  cl = (g?.reason ?? '').split('\n').find((l) => l.includes('對規格的清單')) ?? '';
  check('只對完甲 → 收工 hook 還要乙,不再列甲', (g?.missing ?? []).includes('checklist') && cl.includes('乙.md') && !cl.includes('甲.md'), g?.reason);
  const E = s.by(s.sessionOf('s1')?.stages).E;
  eq('E 要驗的是兩份的每一條,代號前面有規格名', `${E?.verify?.multi}|${E?.verify?.items?.length}|${E?.verify?.expected?.[0]}|${E?.verify?.expected?.at(-1)}`, 'true|5|甲 AC-1|乙 AC-2');
  const five = fiveOf(s.cli([], { session: 's1' }).out);
  check('終端機:講兩份共幾條、一份一段、各寫各的條數', five.includes('這一輪寫了 2 份規格，共 5 條') && five.includes('── 甲：3/3 對過（這份 3 條）') && five.includes('── 乙：0/2 對過,2 條還沒對（這份 2 條）'), five.slice(0, 1200));
  check('終端機:B 那一行講 2 份規格共 5 條', five.includes('2 份規格共 5 條：3 條對過,2 條還沒對'), five.slice(0, 1200));
  check('終端機:只算一份的「全部 N 條」不出現', !/全部 \d+ 條/.test(five), five.slice(0, 1200));
  const page = webWorkflow?.({ path: s.root, sensor: { state: 'ok' }, stages: s.sessionOf('s1')?.stages }) ?? '';
  check('網頁(真的跑 ui/app.js 的 workflow):一份一個清單、各寫各的條數、總數一句', page.includes('這一輪寫了 2 份規格，共 5 條') && page.includes('驗收清單 · 甲：3/3 對過（這份 3 條）') && page.includes('驗收清單 · 乙：0/2 對過,2 條還沒對（這份 2 條）'), page.slice(0, 3000));
  check('網頁:B 那一行講 2 份規格共 5 條;只算一份的「全部 N 條」不出現', page.includes('2 份規格共 5 條：3 條對過,2 條還沒對') && !/全部 \d+ 條/.test(page), page.slice(0, 3000));
  const round = s.cli(['--round', 'E'], { session: 's1' }).out;
  check('--round E:照這 2 份規格驗、回報每一行加規格名、條目帶規格名', round.includes('照這 2 份規格驗') && round.includes('回報每一行前面加規格名') && round.includes('乙 AC-2 第 2 條'), round);
  writeFileSync(join(s.root, 'docs/進行中/乙.md'), specText('乙', 2, { 1: ' ✅ 對過 2026-10-05', 2: ' ⏳ 待討論：要問人' }));
  check('兩份都標完(✅ 或 ⏳)→ 收工 hook 不再要求對清單', !(s.gate()?.missing ?? []).includes('checklist'), s.gate()?.reason);
  s.cleanup();
}
{
  // 只寫一份的對話:畫面跟以前一字不差——「全部 N 條」照舊在,沒有「這一輪寫了 N 份規格」
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/新功能.md'), specText('新功能', 3));
  s.write(aWrote(s.root));
  const st = s.sessionOf('s1')?.stages;
  const a = s.by(st);
  eq('一份規格:不是 multi,A 那格照舊畫那一份', `${a.A?.checklist?.multi ?? false}|${a.A?.checklist?.total}|${a.A?.specPlaces?.length}|${a.B?.checklist?.multi ?? false}`, 'false|3|0|false');
  const page = webWorkflow?.({ path: s.root, sensor: { state: 'ok' }, stages: st }) ?? '';
  check('網頁:一份的時候照舊寫「全部 3 條」', page.includes('（全部 3 條）') && !page.includes('份規格，共'), page.slice(0, 2000));
  s.cleanup();
}

section('多份規格 AC-5:記過的一份讀不到 → 那一份講一句、條數不算進總數、講另有幾份讀不到——終端機、網頁、對話列、E 都講;讀得到的對完,也不准講成全部對完', 'P5');
{
  // 讀不到的一種:檔案在,但裡面沒有照格式寫的 AC(scene 裡的「亂寫的.md」)。找不到的(改名、刪了)是另一種,見下一段
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/甲.md'), specText('甲', 3));
  s.write([
    { ts: T(-20 * MIN), hook: 'UserPromptSubmit', prompt: '寫兩份規格', prompt_id: 'p1' },
    { ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'p1' },
    repA(-19 * MIN, '寫了兩份\ndocs/規劃中/甲.md\ndocs/規劃中/亂寫的.md'),
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '開工', prompt_id: 'p2' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/danger.js'), prompt_id: 'p2' },
  ]);
  const a = s.by(s.sessionOf('s1')?.stages);
  eq('一筆結論寫兩行路徑 → 兩份;讀不到的那份條數不算', `${a.A?.checklist?.parts?.length}|${a.A?.checklist?.total}|${a.A?.checklist?.unreadable?.join(',')}`, '2|3|亂寫的');
  const five = fiveOf(s.cli([], { session: 's1' }).out);
  check('終端機:那一份講沒有照格式寫的 AC、總數旁邊講另有 1 份讀不到', five.includes('這一輪寫了 2 份規格，共 3 條（另有 1 份讀不到，條數不在裡面）') && five.includes('── 亂寫的：規格檔裡沒有照格式寫的 AC'), five.slice(0, 1200));
  check('終端機:B 那一行也講', five.includes('2 份規格共 3 條：0 條對過,3 條還沒對（另有 1 份讀不到，條數不在裡面）'), five.slice(0, 1200));
  let page = webWorkflow?.({ path: s.root, sensor: { state: 'ok' }, stages: s.sessionOf('s1')?.stages }) ?? '';
  check('網頁:A 那格的總數一句、B 那一行都講另有 1 份讀不到(魔鬼教官第一輪:網頁這兩句以前沒有測試釘住)',
    page.includes('這一輪寫了 2 份規格，共 3 條（另有 1 份讀不到，條數不在裡面）') && page.includes('2 份規格共 3 條：0 條對過,3 條還沒對（另有 1 份讀不到，條數不在裡面）') && page.includes('亂寫的：規格檔裡沒有照格式寫的 AC'), page.slice(0, 3000));
  // 讀得到的都對完:B 照樣結案,但那一句講另有一份讀不到——不准把「對完清單」講成全部都對完(R2)
  writeFileSync(join(s.root, 'docs/規劃中/甲.md'), specText('甲', 3, { 1: ' ✅ 對過 2026-10-05', 2: ' ✅ 對過 2026-10-05', 3: ' ✅ 對過 2026-10-05' }));
  const st = s.sessionOf('s1')?.stages;
  const five2 = fiveOf(s.cli([], { session: 's1' }).out);
  check('讀得到的都對完:B 講對完清單,括號講另有一份讀不到', s.by(st).B?.closedBy === 'checklist' && five2.includes('Claude 對完清單（2 份規格共 3 條；另有 1 份讀不到，條數不在裡面）'), five2.slice(0, 1200));
  page = webWorkflow?.({ path: s.root, sensor: { state: 'ok' }, stages: st }) ?? '';
  check('網頁:B 對完那一句也講另有一份讀不到', page.includes('Claude 對完清單（2 份規格共 3 條；另有 1 份讀不到，條數不在裡面）'), page.slice(0, 3000));
  const where = webRoundWhere?.(st) ?? '';
  check('對話列與案件卡「這一輪走到…」也講(以前只寫「處理完了」)', /另有 1 份規格讀不到/.test(where), where);
  check('收工 hook 不叫 Claude 去讀不到的那份打勾', !(s.gate()?.missing ?? []).includes('checklist'), s.gate()?.reason);
  // E:讀不到的那份不准在「N 條裡」消失;回報裡那一份的條目標「讀不到,對不了」,裡面的沒看到要講
  s.append([
    { ts: T(-2 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:verify', prompt_id: 'p3' },
    { ts: T(-1 * MIN), event: 'stage_report', stage: 'E', verdict: 'found', source: 'claude', by_session: 's1', session: undefined,
      note: '第 1 趟\n甲 AC-1 看到了：「一」\n甲 AC-2 看到了：「二」\n甲 AC-3 看到了：「三」\n亂寫的 AC-1 沒看到：應該有，畫面上沒有' },
  ]);
  const E = s.by(s.sessionOf('s1')?.stages).E;
  const walk = E?.elines?.walk ?? '';
  check('E:「3 條裡 3 條看到了」旁邊講另有 1 份規格讀不到', walk.includes('3 條裡 3 條看到了（另有 1 份規格讀不到，條數不在裡面）'), walk);
  check('E:讀不到那份的條目講對不了,裡面的「沒看到」沒有被埋掉', walk.includes('亂寫的 AC-1 是讀不到的那份規格的，對不了') && walk.includes('對不上的回報裡有 1 條寫「沒看到」'), walk);
  s.cleanup();
}
{
  // 找不到的一種:規格改名(Write 了 foo、用 mv 改成 bar、只記了 bar)——以前被算成「2 份規格(另有 1 份讀不到)」(魔鬼教官第一輪,R3)
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/bar.md'), specText('bar', 3));
  s.write([
    { ts: T(-20 * MIN), hook: 'UserPromptSubmit', prompt: '寫規格', prompt_id: 'p1' },
    { ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'p1' },
    { ts: T(-19 * MIN), hook: 'PostToolUse', tool: 'Write', file: join(s.root, 'docs/規劃中/foo.md'), prompt_id: 'p1' },
    repA(-18 * MIN, 'docs/規劃中/bar.md'),
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '開工', prompt_id: 'p2' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/danger.js'), prompt_id: 'p2' },
  ]);
  const a = s.by(s.sessionOf('s1')?.stages).A;
  eq('改名:只算找得到的那一份(不是「2 份規格」),照一份的樣子畫', `${a?.checklist?.multi ?? false}|${a?.checklist?.total}|${a?.specPlace?.name}`, 'false|3|bar');
  const ghost = '記過 foo.md，現在找不到（可能改名或刪了）——不算進這一輪的規格';
  check('另外講一句記過、現在找不到;終端機與網頁一字不差', (webNotes?.(a) ?? []).includes(ghost) && JSON.stringify(webNotes?.(a)) === JSON.stringify(cliNotes?.(a)), JSON.stringify([webNotes?.(a), cliNotes?.(a)]));
  check('不講「另有 1 份讀不到」', !fiveOf(s.cli([], { session: 's1' }).out).includes('讀不到'));
  s.cleanup();
}
{
  // 記過的全都找不到:照單份時的說法(「找不到規格檔」),不藏起來
  const s = scene();
  s.write([
    { ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'p1' },
    repA(-19 * MIN, 'docs/規劃中/不見了.md'),
  ]);
  const a = s.by(s.sessionOf('s1')?.stages).A;
  check('全都找不到:照舊講找不到規格檔,不講「記過、不算進」', (webNotes?.(a) ?? []).some((l) => l.startsWith('找不到規格檔 不見了.md')) && !(webNotes?.(a) ?? []).some((l) => l.includes('不算進這一輪')), JSON.stringify(webNotes?.(a)));
  s.cleanup();
}

section('多份規格 AC-6:這一輪還動了另一份規格、沒記到是不是這一輪的 → A 那格講一句、不擋收工、不猜它是不是;自己的規格搬家不算', 'P6');
{
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/新功能.md'), specText('新功能', 3));
  s.write(aWrote(s.root));
  let a = s.by(s.sessionOf('s1')?.stages).A;
  eq('只有自己記的那份:不多講', JSON.stringify(a?.extraSpecs), '[]');
  renameSync(join(s.root, 'docs/規劃中/新功能.md'), join(s.root, 'docs/進行中/新功能.md'));
  a = s.by(s.sessionOf('s1')?.stages).A;
  eq('自己的規格搬到進行中:不算「還動了另一份」', JSON.stringify(a?.extraSpecs), '[]');
  // Claude 用指令又寫了一份、沒記(感測器看不到,git 看得到)
  writeFileSync(join(s.root, 'docs/規劃中/戊.md'), specText('戊', 2));
  a = s.by(s.sessionOf('s1')?.stages).A;
  eq('git 看到多一份沒記到的 → 講出來', JSON.stringify(a?.extraSpecs), '["戊"]');
  check('旁白:這一輪還動了 戊.md,沒記到它是不是這一輪的規格', (webNotes?.(a) ?? []).includes('這一輪還動了 戊.md，沒記到它是不是這一輪的規格'), JSON.stringify(webNotes?.(a)));
  eq('清單照舊只有自己那份(不猜戊是不是)', a?.checklist?.total, 3);
  const g = s.gate();
  check('收工 hook 不因為它擋、也不提它', !/戊/.test(g?.reason ?? ''), g?.reason);
  check('終端機也講', fiveOf(s.cli([], { session: 's1' }).out).includes('這一輪還動了 戊.md'));
  s.cleanup();
}

section('多份規格 AC-7:施工對話連著一份又記另一份 → 終端機與 A 那格講原本照哪份、換成哪份;記了「無」再連不算換掉', 'P6');
{
  const s = scene();
  s.write(opening(s.root));
  s.cli(['--spec', 'docs/規劃中/app建議卡.md']);
  const rec = s.cli(['--spec', 'docs/進行中/pipeline-ui.md']);
  check('--spec 第二份:講原本照哪份、換成哪份', rec.code === 0 && rec.out.includes('原本照 app建議卡.md，換成照 pipeline-ui.md'), rec.out);
  let a = s.by(s.sessionOf('s1')?.stages).A;
  eq('清單是新的那份', `${a?.link?.name}|${a?.checklist?.total}`, 'pipeline-ui|4');
  check('A 那格講原本照 app建議卡.md,後來換成 pipeline-ui.md', (webNotes?.(a) ?? []).includes('原本照 app建議卡.md，後來換成 pipeline-ui.md'), JSON.stringify(webNotes?.(a)));
  const same = s.cli(['--spec', 'docs/進行中/pipeline-ui.md']);
  check('再記同一份:不講換掉', same.code === 0 && !same.out.includes('原本照'), same.out);
  s.cli(['--spec', '無']);
  const again = s.cli(['--spec', 'docs/規劃中/app建議卡.md']);
  a = s.by(s.sessionOf('s1')?.stages).A;
  check('記了「無」之後再連:不算換掉(Claude 自己說過不照那份了)', again.code === 0 && !again.out.includes('原本照') && !a?.replaced, again.out + JSON.stringify(a?.replaced));
  s.cleanup();
}

section('魔鬼教官第一輪:A 結論的說明只認規劃中／進行中的路徑——一行寫兩份兩份都認;順手提到的參考文件、做完的舊規格不算這一輪的', 'P2');
{
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/甲.md'), specText('甲', 3));
  writeFileSync(join(s.root, 'docs/規劃中/乙.md'), specText('乙', 2));
  s.write([
    { ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'p1' },
    repA(-19 * MIN, '寫好兩份：docs/規劃中/甲.md、docs/規劃中/乙.md\n格式照 docs/升級摘要/做完的.md\n讀了：CLAUDE.md、docs/LESSONS.md'),
  ]);
  const a = s.by(s.sessionOf('s1')?.stages).A;
  eq('同一行兩份都認;升級摘要的舊規格、讀過的文件都不算', `${a?.checklist?.parts?.map((p) => p.name).join(',')}|${a?.checklist?.total}|${(a?.checklist?.unreadable ?? []).length}`, '甲,乙|5|0');
  check('旁白沒有多出「找不到 LESSONS.md」「做完的」這種話', !(webNotes?.(a) ?? []).some((l) => /LESSONS|做完的/.test(l)), JSON.stringify(webNotes?.(a)));
  s.cleanup();
}
{
  // 只記一份、說明裡順手提到一份已經做完的規格:以前被當成第二份,舊的勾算進「對過」(R2)
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/甲.md'), specText('甲', 3));
  s.write([
    { ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'p1' },
    repA(-19 * MIN, 'docs/規劃中/甲.md\ndocs/升級摘要/做完的.md'),
  ]);
  const a = s.by(s.sessionOf('s1')?.stages).A;
  eq('做完的舊規格不算:照一份的樣子畫甲', `${a?.checklist?.multi ?? false}|${a?.checklist?.total}|${a?.checklist?.checked}`, 'false|3|0');
  s.cleanup();
}

section('魔鬼教官第一輪:同一個對話叫第二次 A 再寫一份 → 第一份掉出這一輪(一輪的定義不改),但不准說它「沒記到」;還有沒對完的要講出來', 'P6');
{
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/甲.md'), specText('甲', 3));
  writeFileSync(join(s.root, 'docs/規劃中/乙.md'), specText('乙', 2));
  s.write([
    { ts: T(-30 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'p1' },
    repA(-29 * MIN, 'docs/規劃中/甲.md'),
    { ts: T(-20 * MIN), hook: 'UserPromptSubmit', prompt: '再寫一份乙', prompt_id: 'p2' },
    { ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'p2' },
    repA(-19 * MIN, 'docs/規劃中/乙.md'),
  ]);
  const a = s.by(s.sessionOf('s1')?.stages).A;
  eq('這一輪從第二次 A 算:清單是乙', `${a?.specPlace?.name}|${a?.checklist?.total}`, '乙|2');
  const notes = webNotes?.(a) ?? [];
  check('甲:講是這一輪之前叫 A 寫的、還有 3 條沒對、收工 hook 不會要它的清單', notes.includes('甲.md 是這一輪之前叫 A 寫的，還有 3 條沒對——這一輪從後來那次 A 算起，收工 hook 不會要它的清單'), JSON.stringify(notes));
  check('不准說甲「沒記到」', !notes.some((l) => l.includes('沒記到')), JSON.stringify(notes));
  eq('終端機跟網頁一字不差', JSON.stringify(cliNotes?.(a)), JSON.stringify(notes));
  // 甲對完了:不再多講(不多話)
  writeFileSync(join(s.root, 'docs/規劃中/甲.md'), specText('甲', 3, { 1: ' ✅ 對過 2026-10-05', 2: ' ✅ 對過 2026-10-05', 3: ' ✅ 對過 2026-10-05' }));
  check('甲對完了 → 不再講', !(webNotes?.(s.by(s.sessionOf('s1')?.stages).A) ?? []).some((l) => l.startsWith('甲.md')));
  s.cleanup();
}
{
  // A 寫完自己那份、又 --spec 別的對話寫的那份:也是換掉——講出來,不准說自己那份「沒記到」
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/甲.md'), specText('甲', 3));
  s.write([
    { ts: T(-20 * MIN), hook: 'UserPromptSubmit', prompt: '寫規格', prompt_id: 'p1' },
    { ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'p1' },
    repA(-19 * MIN, 'docs/規劃中/甲.md'),
  ]);
  const rec = s.cli(['--spec', 'docs/規劃中/app建議卡.md']);
  check('--spec:講原本照自己叫 A 寫的甲、換成照 app建議卡', rec.code === 0 && rec.out.includes('原本照 甲.md（這個對話叫 A 寫的），換成照 app建議卡.md'), rec.out);
  const a = s.by(s.sessionOf('s1')?.stages).A;
  const notes = webNotes?.(a) ?? [];
  check('A 那格:原本照甲(這個對話叫 A 寫的),後來換成 app建議卡;不說甲沒記到', notes.includes('原本照 甲.md（這個對話叫 A 寫的），後來換成 app建議卡.md') && !notes.some((l) => l.includes('沒記到')), JSON.stringify(notes));
  eq('終端機跟網頁一字不差', JSON.stringify(cliNotes?.(a)), JSON.stringify(notes));
  s.cleanup();
}

section('魔鬼教官第一輪:分級卡的 A 那一行跟 A 那格講同一件事——寫了幾份就講幾份(以前只講最後一筆結論的那一份)', 'P2');
{
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/甲.md'), specText('甲', 3));
  writeFileSync(join(s.root, 'docs/規劃中/乙.md'), specText('乙', 2));
  s.write([
    { ts: T(-20 * MIN), hook: 'UserPromptSubmit', prompt: '寫兩份', prompt_id: 'p1' },
    { ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'p1' },
    repA(-19 * MIN, 'docs/規劃中/甲.md'), repA(-19 * MIN + 0.08, 'docs/規劃中/乙.md'),
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '開工', prompt_id: 'p2' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/danger.js'), prompt_id: 'p2' },
  ]);
  const reqA = s.sessionOf('s1')?.tier?.requirements?.find((r) => r.key === 'A');
  eq('分級卡(T2 列了 A):講寫了 2 份規格、是哪兩份', reqA?.detail, '跑過,Claude 說寫了 2 份規格：甲、乙');
  check('終端機的分級那一段也是同一句', s.cli([], { session: 's1' }).out.includes('寫了 2 份規格：甲、乙'));
  s.cleanup();
}

section('魔鬼教官第一輪:共用資料夾,另一個對話叫 A 寫的規格不算到這個對話頭上(只認同一個對話記的 A 結論)', 'P6');
{
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/甲.md'), specText('甲', 3));
  writeFileSync(join(s.root, 'docs/規劃中/乙.md'), specText('乙', 2));
  s.write([
    { ts: T(-30 * MIN), hook: 'UserPromptSubmit', prompt: '寫甲', prompt_id: 'a1', session: 's1' },
    { ts: T(-30 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'a1', session: 's1' },
    { ts: T(-29 * MIN), hook: 'UserPromptSubmit', prompt: '寫乙', prompt_id: 'b1', session: 's2' },
    { ts: T(-29 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'b1', session: 's2' },
    { ...repA(-28 * MIN, 'docs/規劃中/甲.md'), by_session: 's1' },
    { ...repA(-27 * MIN, 'docs/規劃中/乙.md'), by_session: 's2' },
  ]);
  const a1 = s.by(s.sessionOf('s1')?.stages).A, a2 = s.by(s.sessionOf('s2')?.stages).A;
  eq('s1 只認甲、s2 只認乙', `${a1?.specPlace?.name}|${a1?.checklist?.total}|${a2?.specPlace?.name}|${a2?.checklist?.total}`, '甲|3|乙|2');
  s.cleanup();
}

section('魔鬼教官第一輪:好幾份規格、有一條待討論 → B 不結案,B 那一行帶著「1 條待討論」(終端機與網頁)', 'P5');
{
  const s = scene();
  writeFileSync(join(s.root, 'docs/規劃中/甲.md'), specText('甲', 3, { 1: ' ✅ 對過 2026-10-05', 2: ' ✅ 對過 2026-10-05', 3: ' ✅ 對過 2026-10-05' }));
  writeFileSync(join(s.root, 'docs/規劃中/乙.md'), specText('乙', 2, { 1: ' ✅ 對過 2026-10-05', 2: ' ⏳ 待討論：要問人' }));
  s.write([
    { ts: T(-20 * MIN), hook: 'UserPromptSubmit', prompt: '寫兩份', prompt_id: 'p1' },
    { ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', prompt_id: 'p1' },
    repA(-19 * MIN, 'docs/規劃中/甲.md'), repA(-19 * MIN + 0.08, 'docs/規劃中/乙.md'),
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '開工', prompt_id: 'p2' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/danger.js'), prompt_id: 'p2' },
  ]);
  const st = s.sessionOf('s1')?.stages;
  check('B 不結案(有一條待討論)', s.by(st).B?.closedBy !== 'checklist', JSON.stringify(s.by(st).B));
  const line = '2 份規格共 5 條：4 條對過,1 條待討論';
  check('終端機的 B 那一行帶著 1 條待討論', fiveOf(s.cli([], { session: 's1' }).out).includes(line));
  check('網頁的 B 那一行帶著 1 條待討論', (webWorkflow?.({ path: s.root, sensor: { state: 'ok' }, stages: st }) ?? '').includes(line));
  s.cleanup();
}

section('「N 份規格共幾條」那一句只寫一份(lib/stageLines.mjs):終端機印的、伺服器帶給網頁的,是同一個函式;網頁照印,不自己算(規格:終端機與網頁說同一句 AC-1、AC-6)', 'P2');
{
  // 以前終端機一份、網頁一份(魔鬼教官第一輪抓到兩份要真的跑兩邊才對得起來);現在網頁不准再有自己的一份
  const app = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8'), cli = readFileSync(join(ROOT, 'lib', 'cliStages.mjs'), 'utf8');
  check('網頁與終端機都不再自己寫 clProg、clDoneNote、checklistWhy、linkLine', !/\b(const|function) (clProg|clDoneNote|checklistWhy|linkLine)\b/.test(app + cli));
  const cases = {
    一份: [{ parsed: true, checked: 3, total: 5, pending: 1, unmarked: 1 }, '清單 3/5 對過,1 條待討論,1 條還沒對', ''],
    分批: [{ parsed: true, batch: ['AC-1'], checked: 0, total: 1, pending: 0, unmarked: 1 }, '清單這一批 0/1 對過,1 條還沒對', ''],
    好幾份: [{ parsed: true, multi: true, specs: 2, checked: 4, total: 5, pending: 1, unmarked: 0, unreadable: [] }, '2 份規格共 5 條：4 條對過,1 條待討論', '（2 份規格共 5 條）'],
    好幾份有一份讀不到: [{ parsed: true, multi: true, specs: 2, checked: 3, total: 3, pending: 0, unmarked: 0, unreadable: ['丙'] },
      '2 份規格共 3 條：3 條對過（另有 1 份讀不到，條數不在裡面）', '（2 份規格共 3 條；另有 1 份讀不到，條數不在裡面）'],
    沒有清單: [{ parsed: false }, null, ''],
  };
  for (const [k, [cl, prog, done]] of Object.entries(cases)) {
    eq(`${k}:進度那一句`, clProg(cl), prog);
    eq(`${k}:對完那一句的括號`, clDoneNote(cl), done);
  }
  // 網頁照印伺服器給的那一句:給一句跟事實對不上的字,畫面就印那一句——證明它沒有自己再算一次(AC-6)
  const fake = '〈伺服器給的 B 那一句〉';
  const page = webWorkflow?.({ path: '/x', sensor: { state: 'ok' }, stages: [{ id: 'B', name: '寫程式', type: 'main-conversation', state: 'current', ranAt: T(-60),
    checklist: cases.好幾份[0], line: fake }] }) ?? '';
  check('網頁照印伺服器給的那一句,不從清單自己算', page.includes(fake) && !page.includes('2 份規格共 5 條'), page.slice(0, 800));
  // 舊的服務沒給那一句(合併之後還沒 --serve-restart):不自己拼、不空白、不壞(AC-5)
  const old = webWorkflow?.({ path: '/x', sensor: { state: 'ok' }, stages: [{ id: 'B', name: '寫程式', type: 'main-conversation', state: 'current', ranAt: T(-60), checklist: cases.好幾份[0] }] }) ?? '';
  check('舊的服務沒給那一句:講服務還在跑舊的程式,不自己拼「2 份規格共 5 條」,不印 undefined', /服務還在跑舊的程式/.test(old) && !old.includes('2 份規格共 5 條') && !/undefined|null/.test(old), old.slice(0, 800));
}

process.exit(summary());
