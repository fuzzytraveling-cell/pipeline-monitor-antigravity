/**
 * merged.test.mjs —— 從 main 併進來、別的對話寫的檔,不算成「這一輪改的」(lib/origin.mjs 的 mergedIn)。規格:併進來的不算這一輪(路徑看 CLAUDE.md 的表)
 *
 * 兩個方向都釘,都會安靜說謊:
 *   ① 算多了:快轉、合併進來的別人的檔被算成這一輪的——分級被拉高、收工 hook 叫人決定 D 要不要再跑、C 和 D 去看別人的程式
 *      (2026-10-30 兩次;2026-11-03 一個檔都沒改的對話,快轉之後說 22 個檔、T1 要 D)
 *   ② 算少了(更危險,老毛病 P1):自己改過、main 也改過的檔;還沒存的、還沒追蹤的;紀錄斷一截、從別條分支拿進來、rebase——都不准拿掉
 * 每一段的劇本都是真的 git:真的 worktree、真的快轉與合併,移動紀錄是 git 自己寫的(時間照 GIT_COMMITTER_DATE 走)。
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, symlinkSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { mergedIn, reflogOf, changeFacts } from '../lib/origin.mjs';
import { changeHealth, checkpointRelation } from '../lib/git.mjs';
import { changeScope } from '../lib/scope.mjs';
import { tierLines } from '../lib/tier.mjs';
import { decide } from '../gate.mjs';
import { collectAll } from '../lib/collect.mjs';
import { safeName } from '../lib/events.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name;
const out = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const NOW = Date.now();                                   // 「現在」只取一次(L18)
const T = (sec) => new Date(NOW + sec * 1000).toISOString();
const MIN = 60;

/**
 * 主資料夾(main)加一個對話的資料夾(worktree,分支 work)。專案兩小時前就在,對話的資料夾 110 分鐘前開——劇本裡「這一輪開始」都在那之後,
 * 起點的版本才查得到(不然測到的是「只看還沒存檔的」那條退路)。src/ 是程式區、src/danger.js 在危險清單。
 */
function scene() {
  const r = makeRepo({ at: T(-120 * MIN), files: {
    'src/a.js': 'a\n', 'src/b.js': 'b1\nb2\nb3\nb4\nb5\n', 'src/danger.js': 'd\n', 'src/t.test.js': 't\n', 'docs/x.md': 'x\n',
    'package.json': JSON.stringify({ name: 'p', dependencies: { left: '1' } }),
    '.claude/pipeline-stages.json': JSON.stringify({ tiers: { code: ['src/'], danger: ['src/danger.js'] } }),
  } });
  const main = out(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD');            // 測試的 git 用 GitHub 機器的預設名字(master,老毛病 P8)
  const made = join(mkdtempSync(join(tmpdir(), 'pm-merged-')), 'wt');
  const env = (sec) => ({ ...process.env, GIT_AUTHOR_DATE: T(sec), GIT_COMMITTER_DATE: T(sec) });
  const g = (cwd, sec, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore', env: env(sec) });
  g(r.dir, -110 * MIN, 'worktree', 'add', '-q', '-b', 'work', made);
  // 用 git 給的真實路徑:Mac 的暫存資料夾 /var 是 /private/var 的捷徑,終端機認的是真的那一個——紀錄寫捷徑那一個,就變成「沒有來自這裡的紀錄」
  const wt = out(made, 'rev-parse', '--show-toplevel');
  const put = (dir, files) => { for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body); } };
  const commit = (dir, sec, files, msg) => { put(dir, files); g(dir, sec, 'add', '-A'); g(dir, sec, 'commit', '-qm', msg); };
  const onMain = (sec, files, msg = '別的對話的存檔') => commit(r.dir, sec, files, msg);
  const onWork = (sec, files, msg = '這個對話的存檔') => commit(wt, sec, files, msg);
  const ff = (sec) => g(wt, sec, 'merge', '-q', '--ff-only', main);       // 快轉跟上 main(git 記「merge master: Fast-forward」)
  // 終端機與儀表板都走的那一條:changeFacts 照這一輪的起點決定基準、拿掉併進來的(lib/origin.mjs)
  const facts = (originSec, { edits = [], mainRoot = null } = {}) => {
    const origin = { at: T(originSec), from: 'prompt', sessions: 1 };
    const c = changeFacts({ root: wt, hasCommits: true, isCode: (f) => f.startsWith('src/'), relationOf: (x) => checkpointRelation(wt, x),
      healthOf: (s, skip) => changeHealth(wt, s, { skip }), reflog: reflogOf(wt), edits, mainRoot });
    c.gitChanges(origin);
    return c.facts();
  };
  const cleanup = () => {
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: r.dir, stdio: 'ignore' }); } catch { /* 已經不在 */ }
    r.cleanup(); rmSync(dirname(wt), { recursive: true, force: true });
  };
  return { r, main, wt, g, put, onMain, onWork, ff, facts, cleanup };
}

section('AC-1、AC-8:快轉跟上 main 之後,main 帶進來、這個對話沒動過的檔不算這一輪;檔數、新相依、既有測試、幾次存檔都只算自己的(11/03 那一次的形狀)', 'P12');
{
  const s = scene();
  s.onMain(-90 * MIN, { 'src/b.js': 'b1\nb2\nb3\nb4\nb5\nmain\n', 'src/new.js': 'n\n', 'src/danger.js': 'main\n', 'src/t.test.js': 'main\n',
    'package.json': JSON.stringify({ name: 'p', dependencies: { left: '1', right: '1' } }) });
  s.ff(-80 * MIN);
  check('git 自己寫的移動紀錄:快轉', reflogOf(s.wt).some((e) => /^merge \S+: Fast-forward$/.test(e.gs)), JSON.stringify(reflogOf(s.wt).map((e) => e.gs)));
  const { base, health, merged } = s.facts(-100 * MIN);
  eq('拿掉的就是 main 帶進來的 5 個', health.skipped.join(','), 'package.json,src/b.js,src/danger.js,src/new.js,src/t.test.js');
  eq('這一輪自己的清單是空的', health.list.length, 0);
  eq('拿進來的存檔 1 次,「幾次存檔加起來」扣掉之後是 0', `${merged.commits}|${base.commits}`, '1|0');
  eq('跟著基準走的個數(畫面那幾句讀它)', base.merged, 5);
  check('新相依、既有測試都不算 main 的', health.newDeps.length === 0 && health.modifiedTests.length === 0, JSON.stringify(health));
  // 對照:以前的算法(不拿掉)就是 11/03 終端機印的那個樣子
  const old = changeHealth(s.wt, base.since);
  check('對照:以前的算法把 5 個都算成這一輪的、還說動到既有測試、多了新相依', old.list.length === 5 && old.modifiedTests.length === 1 && old.newDeps.includes('right'), JSON.stringify(old));
  const sc = changeScope(base, () => '10 分鐘前');
  check('0 的時候不講「一模一樣」(檔案已經不一樣了),講這一輪自己沒有改動、另外 5 個從 main 併進來',
    /這一輪自己沒有改動；另外 5 個檔是從 main 併進來的，這個對話沒動過，不算這一輪/.test(sc.empty) && !/一模一樣/.test(sc.empty), sc.empty);
  check('收工 hook 理由裡那個括號講不含幾個', /這一輪，含已存檔的，不含從 main 併進來的 5 個檔/.test(sc.short), sc.short);
  // 起點之後每一次移動都是從 main 拿進來的:「中間動過」就是那一次,沒有藏在別條線上的自己的存檔——不講看不全
  eq('每一次移動都是拿進來的 → 不算「這一輪中間動過」', `${merged.explained}|${base.moved}`, 'true|false');
  check('這一句不加「現在這條線上」(沒有看不到的)', !/這條線上/.test(sc.empty), sc.empty);
  const tl = tierLines({ state: 'no-change', basis: base }, { ago: () => '10 分鐘前' });
  check('分級:這一輪自己沒有改動、沒有東西要分級,另外 5 個從 main 併進來', /這一輪自己沒有改動，沒有東西要分級；另外 5 個檔是從 main 併進來的/.test(tl.main), tl.main);
  s.cleanup();
}
{
  // 對照(老毛病 P5):自己存過檔又改回去,之後才快轉 main——0 可能是「改了又改回去」,中間有自己的移動,照舊講「現在這條線上」
  const s = scene();
  s.onWork(-97 * MIN, { 'src/a.js': 'mine\n' });
  s.onWork(-96 * MIN, { 'src/a.js': 'a\n' }, '改回去');
  s.g(s.r.dir, -94 * MIN, 'merge', '-q', '--ff-only', 'work');
  s.onMain(-90 * MIN, { 'src/b.js': 'main\n' });
  s.ff(-80 * MIN);
  const { base, health, merged } = s.facts(-100 * MIN);
  eq('清單空的、拿掉 b.js、中間有自己的移動', `${health.list.length}|${health.skipped.join(',')}|${merged.explained}|${base.moved}`, '0|src/b.js|false|true');
  check('只講這條線上看得到的', /^現在這條線上，這一輪自己沒有改動；另外 1 個檔是從 main 併進來的/.test(changeScope(base, () => '').empty), changeScope(base, () => '').empty);
  s.cleanup();
}
{
  // app 的「跟上 main」併的是上一次抓到的 origin/main,本機的 main 還沒跟上(也沒設上游):照樣認得是 main 的
  const s = scene();
  const bare = mkdtempSync(join(tmpdir(), 'pm-merged-origin-'));
  execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore' });
  s.g(s.r.dir, -100 * MIN, 'remote', 'add', 'origin', bare);
  s.g(s.r.dir, -100 * MIN, 'push', '-q', 'origin', s.main);
  const other = join(mkdtempSync(join(tmpdir(), 'pm-merged-clone-')), 'c');
  execFileSync('git', ['clone', '-q', bare, other], { stdio: 'ignore' });
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T']]) execFileSync('git', ['config', k, v], { cwd: other });
  writeFileSync(join(other, 'src/b.js'), 'pushed from another machine\n');
  s.g(other, -85 * MIN, 'commit', '-qam', '別台推上去的');
  s.g(other, -85 * MIN, 'push', '-q', 'origin', s.main);
  s.g(s.r.dir, -84 * MIN, 'fetch', '-q', 'origin');
  s.g(s.wt, -80 * MIN, 'merge', '-q', '--ff-only', `origin/${s.main}`);
  const { health } = s.facts(-100 * MIN);
  eq('從 origin/main 快轉進來的 b.js 拿掉', `${health.list.join(',')}|${health.skipped.join(',')}`, '|src/b.js');
  rmSync(bare, { recursive: true, force: true }); rmSync(dirname(other), { recursive: true, force: true });
  s.cleanup();
}

section('AC-2:自己改過的檔,main 也改過,照樣算——快轉的、合併出存檔的、自己解衝突的、感測器記到的都一樣', 'P1');
{
  // 10/30 第二次的形狀:這個對話存了 a.js、b.js,這條分支先併進 main(收尾),main 之後又多了別的對話改 b.js、加 c.js,這條分支再快轉跟上
  const s = scene();
  s.onWork(-95 * MIN, { 'src/a.js': 'mine\n', 'src/b.js': 'mine\nb2\nb3\nb4\nb5\n' });
  s.g(s.r.dir, -94 * MIN, 'merge', '-q', '--ff-only', 'work');
  s.onMain(-90 * MIN, { 'src/b.js': 'mine\nb2\nb3\nb4\nmain\n', 'src/c.js': 'c\n' });
  s.ff(-80 * MIN);
  const { base, health } = s.facts(-100 * MIN);
  eq('清單:自己存的 a.js、兩邊都改過的 b.js', health.list.join(','), 'src/a.js,src/b.js');
  eq('拿掉的只有 main 加的 c.js', health.skipped.join(','), 'src/c.js');
  eq('幾次存檔加起來:自己的 1 次', base.commits, 1);
  s.cleanup();
}
{
  // 真的合併(兩邊都有新存檔,不能快轉):自己改 a.js、main 改 b.js
  const s = scene();
  s.onWork(-95 * MIN, { 'src/a.js': 'mine\n' });
  s.onMain(-90 * MIN, { 'src/b.js': 'main\n' });
  s.g(s.wt, -80 * MIN, 'merge', '-q', '--no-edit', s.main);
  check('git 自己寫的移動紀錄:合併出一個存檔', reflogOf(s.wt).some((e) => /^merge \S+: Merge made by /.test(e.gs)), JSON.stringify(reflogOf(s.wt).map((e) => e.gs)));
  const { base, health } = s.facts(-100 * MIN);
  eq('清單只有自己的 a.js、拿掉 main 的 b.js', `${health.list.join(',')}|${health.skipped.join(',')}`, 'src/a.js|src/b.js');
  eq('幾次存檔加起來:自己的 1 次(main 的那一次、合併那一個都扣掉)', base.commits, 1);
  // 行數只加留下的:a.js 一行換一行;main 把 b.js 五行換成一行,不算(以前的總數是 +2 −6)
  eq('加減行數只算自己的 a.js', `+${health.added} −${health.removed}`, '+1 −1');
  const old = changeHealth(s.wt, base.since);
  eq('對照:以前的總數連 main 的也加進去', `+${old.added} −${old.removed}`, '+2 −6');
  s.cleanup();
}
{
  // 有衝突、自己解的:兩邊都改 a.js 同一行,解成第三種;同一個合併裡 main 另外改的 b.js 照樣拿掉
  const s = scene();
  s.onWork(-95 * MIN, { 'src/a.js': 'mine\n' });
  s.onMain(-90 * MIN, { 'src/a.js': 'main\n', 'src/b.js': 'main\n' });
  try { s.g(s.wt, -80 * MIN, 'merge', '-q', '--no-edit', s.main); } catch { /* 有衝突:git 停下來等人解 */ }
  writeFileSync(join(s.wt, 'src/a.js'), 'both\n');
  s.g(s.wt, -79 * MIN, 'add', 'src/a.js');
  s.g(s.wt, -79 * MIN, 'commit', '-q', '--no-edit');
  check('git 自己寫的移動紀錄:存那個合併', reflogOf(s.wt).some((e) => /^commit \(merge\): /.test(e.gs)), JSON.stringify(reflogOf(s.wt).map((e) => e.gs)));
  const { health } = s.facts(-100 * MIN);
  eq('自己解的 a.js 照算、main 的 b.js 拿掉', `${health.list.join(',')}|${health.skipped.join(',')}`, 'src/a.js|src/b.js');
  s.cleanup();
}
{
  // 感測器記到這個對話改過 a.js(後來改回去了,git 看不出來),main 也改了 a.js 再快轉進來 → 照算
  const s = scene();
  s.onMain(-90 * MIN, { 'src/a.js': 'main\n' });
  s.ff(-80 * MIN);
  const edits = [{ ts: T(-95 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.wt, 'src/a.js'), cwd: s.wt }];
  eq('感測器記到改過的 a.js 照算', s.facts(-100 * MIN, { edits }).health.list.join(','), 'src/a.js');
  eq('對照:感測器沒記到就拿掉', s.facts(-100 * MIN).health.skipped.join(','), 'src/a.js');
  s.cleanup();
}
{
  // 魔鬼教官第一輪:對話(資料夾是 worktree)用 Edit 改了**主資料夾**的 a.js、在主資料夾存檔,再把自己的分支快轉跟上 main——
  // 那是它自己改的。感測器記的路徑在主資料夾底下,以前只認這個資料夾底下的路徑,a.js 就被當成從 main 拿進來的拿掉
  const s = scene();
  s.onMain(-90 * MIN, { 'src/a.js': 'this conversation, in the main folder\n', 'src/c.js': 'c\n' });
  s.ff(-80 * MIN);
  const edits = [{ ts: T(-95 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.r.dir, 'src/a.js'), cwd: s.wt }];
  const { health } = s.facts(-100 * MIN, { edits, mainRoot: s.r.dir });
  eq('改在主資料夾的 a.js 照算、別的 c.js 拿掉', `${health.list.join(',')}|${health.skipped.join(',')}`, 'src/a.js|src/c.js');
  s.cleanup();
}

section('AC-3:還沒存的、還沒被 git 追蹤的新檔一律照算;合併到一半(還沒存那個合併)時,main 帶進來的也照算', 'P1');
{
  const s = scene();
  s.onMain(-90 * MIN, { 'src/b.js': 'main\n', 'src/c.js': 'c\n' });
  s.ff(-80 * MIN);
  writeFileSync(join(s.wt, 'src/b.js'), 'main\nmine, not committed\n');
  writeFileSync(join(s.wt, 'src/fresh.js'), 'new\n');
  const { health } = s.facts(-100 * MIN);
  eq('清單:沒存的 b.js(main 也改過)、沒加進 git 的 fresh.js', [...health.list].sort().join(','), 'src/b.js,src/fresh.js');
  eq('拿掉的只剩 c.js', health.skipped.join(','), 'src/c.js');
  s.cleanup();
}
{
  const s = scene();
  s.onWork(-95 * MIN, { 'src/a.js': 'mine\n' });
  s.onMain(-90 * MIN, { 'src/a.js': 'main\n', 'src/b.js': 'main\n' });
  try { s.g(s.wt, -80 * MIN, 'merge', '-q', '--no-edit', s.main); } catch { /* 衝突:合併停在一半 */ }
  const { health } = s.facts(-100 * MIN);
  check('合併停在一半:main 帶進來的 b.js 還沒存,照算', health.list.includes('src/b.js') && health.list.includes('src/a.js'), JSON.stringify(health.list));
  eq('一個都沒拿掉', health.skipped.length, 0);
  s.cleanup();
}

section('AC-4:分不出來就照算——從別條分支拿進來的、移動紀錄斷一截、rebase、脫離分支、紀錄讀不到、這裡就是 main 本身', 'P1');
{
  // 從別條分支(還沒結案的另一個對話)快轉進來:它不在 main 的歷史上,可能還沒人檢查過
  const s = scene();
  s.g(s.r.dir, -92 * MIN, 'checkout', '-q', '-b', 'other');
  s.onMain(-90 * MIN, { 'src/b.js': 'other conversation\n' });
  s.g(s.r.dir, -89 * MIN, 'checkout', '-q', s.main);
  s.g(s.wt, -80 * MIN, 'merge', '-q', '--ff-only', 'other');
  const { health } = s.facts(-100 * MIN);
  eq('別條分支帶進來的 b.js 照算', `${health.list.join(',')}|${health.skipped.length}`, 'src/b.js|0');
  s.cleanup();
}
{
  // 移動紀錄斷了一截:自己存 a.js 那一筆不見了,main 之後也改了 a.js 再快轉進來——斷掉的那一截算自己的,a.js 不准拿掉
  const s = scene();
  s.onWork(-95 * MIN, { 'src/a.js': 'mine\n' });
  s.g(s.r.dir, -94 * MIN, 'merge', '-q', '--ff-only', 'work');
  s.onMain(-90 * MIN, { 'src/a.js': 'mine\nmain\n', 'src/c.js': 'c\n' });
  s.ff(-80 * MIN);
  const p = out(s.wt, 'rev-parse', '--git-path', 'logs/HEAD');
  const file = isAbsolute(p) ? p : join(s.wt, p);
  const lines = readFileSync(file, 'utf8').split('\n');
  writeFileSync(file, lines.filter((l) => !/\tcommit: /.test(l)).join('\n'));
  check('紀錄真的少了那一筆', !reflogOf(s.wt).some((e) => /^commit: /.test(e.gs)), JSON.stringify(reflogOf(s.wt).map((e) => e.gs)));
  const { health } = s.facts(-100 * MIN);
  eq('a.js 照算(斷掉的那一截是自己的)、c.js 拿掉', `${health.list.join(',')}|${health.skipped.join(',')}`, 'src/a.js|src/c.js');
  s.cleanup();
}
{
  // rebase 把自己的存檔搬到 main 後面:git 不寫「快轉」「合併」,認不出拿進來的 → 照算(寧可多算)
  const s = scene();
  s.onWork(-95 * MIN, { 'src/a.js': 'mine\n' });
  s.onMain(-90 * MIN, { 'src/b.js': 'main\n' });
  s.g(s.wt, -80 * MIN, 'rebase', '-q', s.main);
  eq('rebase:main 的 b.js 照算', s.facts(-100 * MIN).health.list.join(','), 'src/a.js,src/b.js');
  s.cleanup();
}
{
  const s = scene();
  const init = out(s.wt, 'rev-parse', 'HEAD');
  s.onMain(-90 * MIN, { 'src/b.js': 'main\n' });
  s.ff(-80 * MIN);
  const from = Date.parse(T(-100 * MIN));
  eq('紀錄讀不到 → 分不出來', mergedIn({ root: s.wt, since: init, fromMs: from, reflog: null }).state, 'unknown');
  s.g(s.wt, -70 * MIN, 'checkout', '-q', '--detach');
  eq('脫離分支 → 分不出來', mergedIn({ root: s.wt, since: init, fromMs: from, reflog: reflogOf(s.wt) }).state, 'unknown');
  // 主資料夾本身:把對話的分支快轉進 main 是別的對話做完的事——照算,還原點、未檢查都要看得到
  s.g(s.wt, -60 * MIN, 'checkout', '-q', 'work');
  s.onWork(-50 * MIN, { 'src/a.js': 'mine\n' });
  s.g(s.r.dir, -40 * MIN, 'merge', '-q', '--ff-only', 'work');
  check('主資料夾的紀錄裡有快轉', reflogOf(s.r.dir).some((e) => /^merge work: Fast-forward$/.test(e.gs)), JSON.stringify(reflogOf(s.r.dir).map((e) => e.gs)));
  eq('這裡就是 main 本身 → 不算「從 main 拿進來」', mergedIn({ root: s.r.dir, since: init, fromMs: from, reflog: reflogOf(s.r.dir) }).state, 'none');
  s.cleanup();
}

section('AC-9:沒有從 main 拿進來的,一切照舊、一個 git 都不多問', 'P2');
{
  const said = [{ sha: 'b'.repeat(40), sec: Math.floor(NOW / 1000) + 1, gs: 'commit: 自己存的' }];
  eq('紀錄裡沒有快轉、合併 → none(連資料夾都不必在:一個 git 都沒問)', mergedIn({ root: '/no/such/folder', since: 'a'.repeat(40), fromMs: NOW, reflog: said }).state, 'none');
  eq('起點之前的快轉不看', mergedIn({ root: '/no/such/folder', since: 'a'.repeat(40), fromMs: NOW, reflog: [{ sha: 'c'.repeat(40), sec: Math.floor(NOW / 1000) - 10, gs: 'merge main: Fast-forward' }] }).state, 'none');
  const s = scene();
  s.onWork(-95 * MIN, { 'src/a.js': 'mine\n' });
  const { health, merged, base } = s.facts(-100 * MIN);
  eq('沒拿進來:清單照舊、沒有拿掉任何一個', `${merged.state}|${health.list.join(',')}|${health.skipped.length}|${base.merged}`, 'none|src/a.js|0|0');
  const plain = changeHealth(s.wt, base.since);
  eq('跟不給要拿掉的檔時一字不差(多的只有空的 skipped)', JSON.stringify({ ...health, skipped: undefined }), JSON.stringify({ ...plain, skipped: undefined }));
  const sc = changeScope(base, () => '1 分鐘前');
  check('畫面那幾句不講併進來', sc.merged === 0 && sc.mergedNote === null && !/main/.test(sc.short), JSON.stringify(sc));
  s.cleanup();
}

/* ── 收工 hook、儀表板、--round:真的跑一次(假的監視器資料夾、裝了 plugin 的假 home) ── */

function world() {
  const s = scene();
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-merged-mon-'));
  const logDir = join(monitorDir, 'logs');
  mkdirSync(logDir); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(ROOT, join(home, '.claude', 'skills', PLUGIN));             // 裝了 plugin:三支指令都在,收工 hook 才要得了 D
  const log = join(logDir, `${safeName(basename(s.r.dir))}.jsonl`);       // worktree 算主資料夾那個專案
  const write = (lines) => writeFileSync(log, lines.map((o) => JSON.stringify({ session: 's1', cwd: s.wt, ...o })).join('\n') + '\n');
  const cli = (args) => {
    const { CLAUDE_CODE_SESSION_ID: _drop, ...env } = process.env;
    try { return execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: s.wt, encoding: 'utf8',
      env: { ...env, CLAUDE_CODE_SESSION_ID: 's1', HOME: home, PIPELINE_MONITOR_HOME: monitorDir, PIPELINE_MONITOR_LOG_DIR: logDir } }); }
    catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? ''); }
  };
  const gate = () => decide({ payload: { session_id: 's1', cwd: s.wt, hook_event_name: 'Stop', stop_hook_active: false }, monitorDir, skillHome: home });
  const session = () => collectAll({ monitorDir, skillHome: home, appTitles: new Map() }).projects[0]?.sessions.find((x) => x.id === 's1') ?? null;
  const cleanup = () => { for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true }); s.cleanup(); };
  return { ...s, monitorDir, home, log, write, cli, gate, session, cleanup };
}
const said = (sec, prompt) => ({ ts: T(sec), hook: 'UserPromptSubmit', prompt, prompt_id: `p${sec}` });
const callD = (sec, head) => ({ ts: T(sec), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:chaos-check`, head });
const reportD = (sec) => ({ ts: T(sec), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'claude' });

section('AC-6、AC-7:D 跑完之後才併 main(10/30 兩次的形狀)——收工 hook 不叫人決定要不要再跑、D 那一格不寫要不要再跑、--round 不列 main 的檔、危險清單那一題不問', 'P12');
{
  const w = world();
  // 這個對話改了 a.js(感測器看得到)、存了檔,叫 D、記了結論
  writeFileSync(join(w.wt, 'src/a.js'), 'mine\n');
  const edited = new Date(Date.parse(T(-28 * MIN)));
  utimesSync(join(w.wt, 'src/a.js'), edited, edited);
  w.g(w.wt, -27 * MIN, 'commit', '-qam', '這個對話的修改');
  w.g(w.r.dir, -26 * MIN, 'merge', '-q', '--ff-only', 'work');            // 這條分支先併進 main(上一次收尾),之後才有別人的存檔
  const h = out(w.wt, 'rev-parse', '--short', 'HEAD');
  w.write([
    said(-30 * MIN, '修一下'),
    { ts: T(-28 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(w.wt, 'src/a.js') },
    callD(-25 * MIN, h), reportD(-24 * MIN),
    said(-12 * MIN, '跟上 main'),
  ]);
  // 之後 main 多了別的對話的存檔:碰到危險清單、加了一支新的程式檔;這一回合把它快轉進來(檔案是現在才寫進資料夾的,修改時間就是現在)
  w.onMain(-20 * MIN, { 'src/b.js': 'main\n', 'src/danger.js': 'main\n', 'src/new.js': 'n\n' });
  w.ff(-11 * MIN);

  const d = w.gate();
  eq('收工 hook 放行:main 帶進來的不算「D 之後又改了程式」,也不問危險清單', d, null);
  const dCell = w.session()?.stages?.find((x) => x.id === 'D');
  eq('對話頁 D 那一格:照舊是 Claude 說沒問題,不是「要不要再跑由你決定」', dCell?.rerun?.state, 'ok');
  const tier = w.session()?.tier;
  check('分級只算自己的 a.js:不因為 main 碰到危險清單變最高那一級、不問 main 新加的那支', tier?.state === 'ok'
    && (tier.machine?.hits?.danger ?? []).length === 0 && (tier.machine?.hits?.code ?? []).join(',') === 'src/a.js' && (tier.stale?.fresh ?? []).length === 0, JSON.stringify(tier?.machine?.hits ?? tier));

  const round = w.cli(['--round', 'D']);
  check('--round D:第一次之後沒有改到程式區,另外講 3 個從 main 併進來、D 不用看',
    /之後沒有改到程式區或測試檔/.test(round) && /另外 3 個檔是從 main 併進來的，這個對話沒動過，D 不用看/.test(round) && !/src\/b\.js/.test(round), round);
  const scope = w.cli(['--round', 'C']);
  check('--round C 的範圍:只有自己的 a.js,另外講 3 個 C 不用看(打掃不去清別的對話的程式)',
    /這一輪改過的 1 個要看的檔/.test(scope) && /src\/a\.js/.test(scope) && /另外 3 個檔是從 main 併進來的，這個對話沒動過，C 不用看/.test(scope) && !/src\/danger\.js/.test(scope), scope);
  const view = w.cli([]);
  check('終端機「這一輪的改動」:1 個檔,底下講另外 3 個從 main 併進來、不算這一輪',
    /━━ 這一輪的改動 ━━[\s\S]*1 個檔案[\s\S]*另外 3 個檔是從 main 併進來的，這個對話沒動過，不算這一輪。/.test(view), view);

  // 對照:這一回合這個對話自己又改了 a.js → 照舊先停下來問 D 要不要再跑(拿掉的只有 main 的,自己的一個都沒少)
  writeFileSync(join(w.wt, 'src/a.js'), 'mine again\n');
  const again = w.gate();
  check('自己又改了程式 → 收工 hook 照舊先問 D 要不要再跑', (again?.missing ?? []).includes('D:ask'), JSON.stringify(again));
  check('理由的括號講不含從 main 併進來的 3 個檔', /不含從 main 併進來的 3 個檔/.test(again?.reason ?? ''), again?.reason);
  w.cleanup();
}

section('魔鬼教官第一輪:D 之前自己改過、D 之後被 main 改寫的檔——收工 hook 先問要不要再跑,--round D 也列得出它(兩處講同一件事)', 'P2');
{
  const w = world();
  writeFileSync(join(w.wt, 'src/b.js'), 'mine\nb2\nb3\nb4\nb5\n');
  const edited = new Date(Date.parse(T(-28 * MIN)));
  utimesSync(join(w.wt, 'src/b.js'), edited, edited);
  w.g(w.wt, -27 * MIN, 'commit', '-qam', '這個對話改 b.js 第一行');
  w.g(w.r.dir, -26 * MIN, 'merge', '-q', '--ff-only', 'work');
  const h = out(w.wt, 'rev-parse', '--short', 'HEAD');
  w.write([
    said(-30 * MIN, '修一下'),
    { ts: T(-28 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(w.wt, 'src/b.js') },
    callD(-25 * MIN, h), reportD(-24 * MIN),
    said(-12 * MIN, '跟上 main'),
  ]);
  w.onMain(-20 * MIN, { 'src/b.js': 'mine\nb2\nb3\nb4\nmain\n', 'src/c.js': 'c\n' });   // 別的對話改 b.js 最後一行、加 c.js
  w.ff(-11 * MIN);
  const d = w.gate();
  check('收工 hook:兩邊都動過的 b.js 在 D 之後被改寫 → 先問 D 要不要再跑', (d?.missing ?? []).includes('D:ask'), JSON.stringify(d));
  const round = w.cli(['--round', 'D']);
  check('--round D 列得出 b.js(D 看過你的那一版,沒看過跟 main 的放在一起),只拿掉 c.js',
    /之後改了 1 個要看的檔：\n\s+src\/b\.js/.test(round) && /另外 1 個檔是從 main 併進來的，這個對話沒動過，D 不用看/.test(round) && !/src\/c\.js/.test(round), round);
  w.cleanup();
}

process.exit(summary());
