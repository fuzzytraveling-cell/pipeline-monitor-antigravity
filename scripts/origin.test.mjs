/**
 * origin.test.mjs —— 「這次改動」從哪裡算起(lib/origin.mjs、lib/scope.mjs)。規格:這一輪的起點(路徑看 CLAUDE.md 的表)
 *
 * 釘的是「會安靜說謊」的那幾條:
 *   ① 沒章時收工前先存檔:從起點那一刻的版本算,存檔過的改動還在;git diff HEAD 看不到它們(老毛病 P1)
 *   ② 同一秒分不出先後:算這一輪的(改動只准看起來更大);worktree 剛建好那一筆例外
 *   ③ reflog 的時間跟起點換成同一個鐘再比(魔鬼教官 2026-09-16 第四次抓到的時差,換了地方還是要釘)
 *   ④ 找不到起點的版本、版本不在這條分支上、沒有起點:退回只看還沒存檔的,而且文案講「存檔過的看不到」,不講「沒有改動」(老毛病 P5)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, utimesSync, unlinkSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { reflogOf, versionAt, changeBase, changeFacts, takeoverOf, tenureEvents, previousTenant, commitOfHead } from '../lib/origin.mjs';
import { changeTimeOf } from '../lib/tier.mjs';
import { changeScope } from '../lib/scope.mjs';
import { changeHealth, checkpointRelation } from '../lib/git.mjs';
import { safeName } from '../lib/events.mjs';
import { sessionsOf } from '../lib/rounds.mjs';
import { cardFor } from '../lib/collect.mjs';

const out = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const NOW = Date.now();                                   // 「現在」只取一次(L18)
const T = (offsetSec) => new Date(NOW + offsetSec * 1000).toISOString();
const MIN = 60;
const commitAt = (dir, at, msg) => execFileSync('git', ['commit', '-qam', msg], { cwd: dir, stdio: 'ignore',
  env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
const relationOf = (dir) => (c) => checkpointRelation(dir, c);

section('沒章時收工前先存檔:從這一輪起點那一刻的版本算,存檔過的改動還在(git diff HEAD 看不到它們)', 'P1');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n', 'src/danger.js': 'd\n' }, at: T(-60 * MIN) });
  const init = out(r.dir, 'rev-parse', 'HEAD');
  writeFileSync(join(r.dir, 'src/danger.js'), 'changed\n');
  commitAt(r.dir, T(-2 * MIN), '收工前存檔');
  const origin = { at: T(-5 * MIN), from: 'prompt', sessions: 1 };
  eq('起點那一刻 HEAD 指的是一開始那個版本', versionAt(r.dir, origin.at).commit, init);
  const base = changeBase({ root: r.dir, origin, relationOf: relationOf(r.dir) });
  eq('基準是起點的版本(不是上一次存檔)', `${base.kind}|${base.since}`, `origin|${init}`);
  check('從起點算:存檔過的危險檔還在清單裡', changeHealth(r.dir, base.since).list.includes('src/danger.js'));
  eq('只比上一次存檔的話一個都看不到(以前的算法,就是它讓分級變「沒有改動」)', changeHealth(r.dir, null).list.length, 0);
  // 之後又存一次檔:起點不動,清單不變
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  commitAt(r.dir, T(-1 * MIN), '再存一次');
  const again = changeBase({ root: r.dir, origin, relationOf: relationOf(r.dir) });
  eq('再存一次檔,基準還是同一個版本', again.since, init);
  eq('清單是這一輪動過的全部', changeHealth(r.dir, again.since).list.sort().join(','), 'src/a.js,src/danger.js');
  r.cleanup();
}

section('同一秒分不出先後:算這一輪的——改動只准看起來更大;reflog 最早那一筆落在同一秒(worktree 剛建好)就用它');
{
  const rl = [{ sha: 'a'.repeat(40), sec: 100 }, { sha: 'b'.repeat(40), sec: 200 }];
  const at = (sec) => new Date(sec * 1000 + 400).toISOString();   // 起點記到毫秒(CLI);reflog 只到秒
  eq('起點在兩次移動之間 → 前一次移動之後的版本', versionAt('/x', at(150), { reflog: rl }).commit, 'a'.repeat(40));
  eq('跟第二次移動同一秒 → 那次移動算起點之後(拿它之前的版本,那次的改動算進這一輪)', versionAt('/x', at(200), { reflog: rl }).commit, 'a'.repeat(40));
  eq('起點之後 HEAD 沒動過 → 最新那一版', versionAt('/x', at(201), { reflog: rl }).commit, 'b'.repeat(40));
  eq('最早那一筆就在起點那一秒(worktree 剛建好) → 用它', versionAt('/x', at(100), { reflog: rl }).commit, 'a'.repeat(40));
  eq('起點比 reflog 最早那一筆還早 → 問不到,不猜', versionAt('/x', at(99), { reflog: rl }).state, 'none');
  eq('reflog 是空的 → 問不到', versionAt('/x', at(150), { reflog: [] }).state, 'none');
  eq('reflog 問不到(null) → 問不到', versionAt('/x', at(150), { reflog: null }).state, 'none');
  eq('起點的時間讀不懂 → 問不到', versionAt('/x', '不是時間', { reflog: rl }).state, 'none');
  // 有人手動改過存檔時間,reflog 的時間前後顛倒:照先後順序走,不照時間排——不會拿一筆「時間比較早、其實比較晚發生」的當起點
  const odd = [{ sha: 'c'.repeat(40), sec: 500 }, { sha: 'd'.repeat(40), sec: 100 }];
  eq('時間顛倒:第一筆就在起點之後 → 問不到(不會跳到後來那筆)', versionAt('/x', at(300), { reflog: odd }).state, 'none');
}

section('reflog 的時間跟起點換成同一個鐘再比:+08:00 的早上九點是 UTC 的一點(魔鬼教官 2026-09-16 第四次抓到的時差)');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n' }, at: '2026-09-10T00:00:00Z' });
  const init = out(r.dir, 'rev-parse', 'HEAD');
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  commitAt(r.dir, '2026-09-16T09:00:00+08:00', 'morning');
  const morning = out(r.dir, 'rev-parse', 'HEAD');
  eq('起點 UTC 05:00:早上那次存檔(01:00Z)在起點之前 → 起點的版本就是它', versionAt(r.dir, '2026-09-16T05:00:00Z').commit, morning);
  eq('起點 UTC 00:30:那次存檔在起點之後 → 起點的版本是它之前那一個', versionAt(r.dir, '2026-09-16T00:30:00Z').commit, init);
  r.cleanup();
}

section('git 自己開的 worktree 有自己的一份 reflog,建好那一刻就有一筆(app 10/1 起開的資料夾沒有這一筆,見後面「app 新開的資料夾」那段)');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n' }, at: T(-60 * MIN) });
  const wt = join(mkdtempSync(join(tmpdir(), 'pm-origin-wt-')), 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', wt], { cwd: r.dir, stdio: 'ignore' });
  const rl = reflogOf(wt);
  check('worktree 的 reflog 讀得到,至少一筆', Array.isArray(rl) && rl.length >= 1, JSON.stringify(rl));
  eq('起點在建好之後 → 起點的版本就是建好時那個版本', versionAt(wt, new Date(NOW + 3600_000).toISOString()).commit, out(wt, 'rev-parse', 'HEAD'));
  eq('不是 git 的資料夾 → 問不到(null,不是空陣列)', reflogOf(mkdtempSync(join(tmpdir(), 'pm-origin-nogit-'))), null);
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: r.dir, stdio: 'ignore' });
  r.cleanup();
}

section('找不到起點的版本、版本不在這條分支上、沒有起點:退回只看還沒存檔的,而且講出為什麼(不是「沒有改動」)', 'P5');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n' }, at: T(-60 * MIN) });
  const rel = relationOf(r.dir);
  eq('章能用 → 比章,不看起點', changeBase({ root: r.dir, cpCommit: 'abc', origin: { at: T(-5 * MIN) }, relationOf: rel }).kind, 'checkpoint');
  const none = changeBase({ root: r.dir, origin: null, relationOf: rel });
  eq('沒有起點(沒有這一輪的紀錄) → 只看還沒存檔的,why=no-origin', `${none.kind}|${none.since}|${none.why}`, 'head|null|no-origin');
  const early = changeBase({ root: r.dir, origin: { at: T(-120 * MIN) }, relationOf: rel });
  eq('起點比這個專案的第一筆紀錄還早 → 只看還沒存檔的,why=not-found', `${early.kind}|${early.why}`, 'head|not-found');
  // 起點之後改寫了歷史:起點的版本被 amend 掉,不在這條分支上了——跟失效的章同一個判斷
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  execFileSync('git', ['commit', '-qa', '--amend', '-m', 'rewrite'], { cwd: r.dir, stdio: 'ignore' });
  const off = changeBase({ root: r.dir, origin: { at: T(-5 * MIN) }, relationOf: rel });
  eq('起點的版本被改寫掉了 → 只看還沒存檔的,why=not-found', `${off.kind}|${off.why}`, 'head|not-found');
  eq('問「版本還在不在這條分支上」的那一步壞了 → 當成找不到,不當成能用', changeBase({ root: r.dir, origin: { at: T(-1) }, relationOf: () => { throw new Error('x'); } }).kind, 'head');
  r.cleanup();

  // 文案:兩種 0 不准同一張臉
  const ago = () => '5 分鐘前';
  const blind = changeScope({ kind: 'head', why: 'not-found', origin: { at: T(-5 * MIN) } }, ago);
  check('只看得到還沒存的:標 blind,空的那一句不說「沒有改動」、要說存檔過的看不到',
    blind.blind === true && !/沒有改動/.test(blind.empty) && /存檔過的看不到/.test(blind.empty) && /找不到這一輪開始時的版本/.test(blind.empty), JSON.stringify(blind));
  check('收工 hook 的括號講只算還沒存檔的', /只算還沒存檔的/.test(blind.short), blind.short);
  const noOrigin = changeScope({ kind: 'head', why: 'no-origin', origin: null }, ago);
  check('沒有這一輪的紀錄:講「沒有這一輪的紀錄」', /沒有這一輪的紀錄/.test(noOrigin.note) && noOrigin.blind, JSON.stringify(noOrigin));
  const own = changeScope({ kind: 'origin', why: null, origin: { at: T(-5 * MIN), from: 'prompt', sessions: 1 } }, ago);
  check('從起點算:講從哪一刻算起、含已存檔的,時間照紀錄',
    !own.blind && /這個對話第一句話（5 分鐘前）/.test(own.note) && /含已存檔的/.test(own.note) && /含已存檔的/.test(own.short), JSON.stringify(own));
  const many = changeScope({ kind: 'origin', why: null, origin: { at: T(-50 * MIN), from: 'prompt', sessions: 3 } }, ago);
  check('工作區有好幾個對話:明講含 N 個對話、從最早開口的那個算起(Oscar 2026-09-22)', /含 3 個對話的改動/.test(many.note) && /最早開口/.test(many.note), many.note);
  const a = changeScope({ kind: 'origin', why: null, origin: { at: T(-5 * MIN), from: 'A', sessions: null } }, ago);
  check('起點是 A:講「叫 A 寫規格」那一刻', /叫 A 寫規格/.test(a.note), a.note);
  eq('有章:標題照舊', changeScope({ kind: 'checkpoint' }, ago).title, '蓋章之後的改動');
  // 只查會印出來的那幾句(欄位值本身可以是 null——那是「沒有這一句」,不是印出來的字;老毛病 P4:抓意圖,不抓字面)
  const printed = (s) => [s.title, s.label, s.note, s.empty, s.short, s.commitsNote].filter((x) => x !== null).join('|');
  check('文案裡沒有程式內部值', ![blind, noOrigin, own, many, a].some((s) => /null|undefined|NaN/.test(printed(s))), [blind, noOrigin, own, many, a].map(printed).join('\n'));
}

section('基準只算一次:roundView 給的起點就是之後大家拿到的那一份;它沒給(中途壞了)就講沒有起點,不假裝有', 'P2');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n' }, at: T(-60 * MIN) });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  let asked = 0;
  const make = () => changeFacts({ root: r.dir, isCode: (f) => f.startsWith('src/'), relationOf: relationOf(r.dir),
                                                      healthOf: (s) => { asked++; return changeHealth(r.dir, s); } });
  const f = make();
  const got = f.gitChanges({ at: T(-5 * MIN), from: 'prompt', sessions: 1 });
  check('gitChanges 給 B 的證據(程式檔與修改時間)', got.length === 1 && got[0].file === 'src/a.js', JSON.stringify(got));
  eq('之後拿到的基準就是那個起點算的', f.facts().base.kind, 'origin');
  f.gitChanges({ at: T(-1), from: 'prompt', sessions: 1 });
  eq('同一組只問 git 一次(第二次叫也是同一份)', asked, 1);
  eq('roundView 沒叫到 → 當成沒有起點(只看還沒存檔的,而且會講)', make().facts().base.why, 'no-origin');
  r.cleanup();
}

section('0 有兩種意思:這一輪中間存到別的分支又切回來,現在跟開始時一樣——不准講「沒有任何檔案被動過」(魔鬼教官 2026-09-22)', 'P5');
{
  const rl = [{ sha: 'a'.repeat(40), sec: 100 }, { sha: 'f'.repeat(40), sec: 200 }, { sha: 'a'.repeat(40), sec: 300 }];
  const at = (sec) => new Date(sec * 1000 + 400).toISOString();
  const v = versionAt('/x', at(150), { reflog: rl });
  check('起點之後 HEAD 指到過別的版本 → moved', v.state === 'ok' && v.commit === 'a'.repeat(40) && v.moved === true, JSON.stringify(v));
  eq('起點之後 HEAD 沒動過 → 沒有 moved', versionAt('/x', at(301), { reflog: rl }).moved, false);
  // 真的 git:切分支存檔、再切回來
  const r = makeRepo({ files: { 'src/danger.js': 'd\n' }, at: T(-60 * MIN) });
  const main = out(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  execFileSync('git', ['checkout', '-q', '-b', 'feat'], { cwd: r.dir });
  writeFileSync(join(r.dir, 'src/danger.js'), 'feat\n');
  commitAt(r.dir, T(-2 * MIN), '存在 feat 上');
  execFileSync('git', ['checkout', '-q', main], { cwd: r.dir });
  const base = changeBase({ root: r.dir, origin: { at: T(-5 * MIN), from: 'prompt', sessions: 1 }, relationOf: relationOf(r.dir) });
  check('切回來之後:基準還是起點的版本,而且知道中間動過', base.kind === 'origin' && base.moved === true, JSON.stringify(base));
  eq('清單是 0(存到別的分支上的,現在這條線看不到)', changeHealth(r.dir, base.since).list.length, 0);
  const sc = changeScope(base, () => '5 分鐘前');
  check('空的那一句:講現在跟開始時一樣、但中間存過檔或切過分支,不講「沒有任何檔案被動過」',
    sc.emptyBlind === true && /一模一樣/.test(sc.empty) && /切過分支/.test(sc.empty) && !/沒有任何檔案被動過/.test(sc.empty), sc.empty);
  r.cleanup();
}

section('0 的時候只講證明得出來的:改了又收進 git stash,也是 0——不准講「沒有任何檔案被動過」(魔鬼教官 2026-09-22 第二輪)', 'P5');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n' }, at: T(-60 * MIN) });
  writeFileSync(join(r.dir, 'src/a.js'), 'changed\n');
  execFileSync('git', ['stash', '-q'], { cwd: r.dir });
  const base = changeBase({ root: r.dir, origin: { at: T(-5 * MIN), from: 'prompt', sessions: 1 }, relationOf: relationOf(r.dir) });
  eq('stash 之後:清單是 0、HEAD 沒動過', `${changeHealth(r.dir, base.since).list.length}|${base.moved}`, '0|false');
  const sc = changeScope(base, () => '5 分鐘前');
  check('只講「現在的檔案跟這一輪開始時一模一樣」,不講沒被動過', /一模一樣/.test(sc.empty) && !/沒有任何檔案被/.test(sc.empty), sc.empty);
  check('蓋章那張臉同一條規矩', !/沒有任何檔案被/.test(changeScope({ kind: 'checkpoint' }, () => '').empty));
  r.cleanup();
}

section('其他幾張臉:一次都沒存過檔、對話是換進這個資料夾的、好幾個對話、好幾次存檔加起來(魔鬼教官 2026-09-22)');
{
  const ago = () => '5 分鐘前';
  const none = changeScope({ kind: 'head', why: 'no-commits', origin: null, commits: 0 }, ago);
  check('一次都沒存過檔:不說「存檔過的看不到」(沒有存檔可以看不到),0 也不是「看不全」',
    !/存檔過的/.test(`${none.note}${none.empty}${none.short}`) && none.blind === false && none.emptyBlind === false, JSON.stringify(none));
  const arrival = changeScope({ kind: 'origin', why: null, origin: { at: T(-5 * MIN), from: 'arrival', sessions: 1 } }, ago);
  check('第一筆紀錄不是一句話(換進這個資料夾的):照實講「這個對話在這裡的第一筆紀錄」', /這個對話在這裡的第一筆紀錄/.test(arrival.note), arrival.note);
  const many = changeScope({ kind: 'origin', why: null, origin: { at: T(-50 * MIN), from: 'prompt', sessions: 2 } }, ago);
  check('好幾個對話:收工 hook 的括號也講含幾個對話', /含 2 個對話的改動/.test(many.short), many.short);
  const eight = changeScope({ kind: 'origin', why: null, origin: { at: T(-50 * MIN), from: 'A' }, commits: 8 }, ago);
  check('好幾次存檔加起來:講出來(比例尺是一次存檔的,L6)', /8 次存檔加起來/.test(eight.commitsNote ?? ''), eight.commitsNote);
  eq('只存了一次或沒存:不講', changeScope({ kind: 'origin', why: null, origin: { at: T(-5 * MIN), from: 'A' }, commits: 1 }, ago).commitsNote, null);
  const r = makeRepo({ files: { 'src/a.js': '1\n' }, at: T(-60 * MIN) });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n'); commitAt(r.dir, T(-3 * MIN), 'one');
  writeFileSync(join(r.dir, 'src/a.js'), '3\n'); commitAt(r.dir, T(-2 * MIN), 'two');
  eq('基準記得起點之後存了幾次', changeBase({ root: r.dir, origin: { at: T(-5 * MIN) }, relationOf: relationOf(r.dir) }).commits, 2);
  r.cleanup();
}

/**
 * app 重用資料夾的真實樣子(規格:新對話接手舊資料夾;2026-09-24 實測):主資料夾開 worktree(舊分支)→ 舊對話在上面存檔 →
 * app 收掉對話時脫離分支 → 別的對話的改動併進 main(碰到危險檔)→ 新對話來了,app 在同一個資料夾從 main 開新分支。
 * 時間都用 GIT_COMMITTER_DATE 控制——reflog 的時間跟著它走。
 */
function reusedFolder() {
  const r = makeRepo({ files: { 'src/a.js': '1\n', 'src/danger.js': 'd\n' }, at: T(-300 * MIN) });
  const wt = join(mkdtempSync(join(tmpdir(), 'pm-origin-reuse-')), 'wt');
  const g = (cwd, at, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  g(r.dir, T(-240 * MIN), 'worktree', 'add', '-q', '-b', 'old', wt);
  writeFileSync(join(wt, 'src/danger.js'), 'old conversation\n');
  g(wt, T(-230 * MIN), 'commit', '-qam', '舊對話存檔');
  g(wt, T(-200 * MIN), 'checkout', '-q', '--detach');                                   // app 收掉舊對話
  writeFileSync(join(r.dir, 'src/danger.js'), 'merged from another conversation\n');
  g(r.dir, T(-100 * MIN), 'commit', '-qam', '別的對話併進 main');
  const main = out(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  g(wt, T(-10 * MIN), 'checkout', '-q', '-b', 'new', main);                           // app 把資料夾換新分支給新對話
  const cleanup = () => { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: r.dir, stdio: 'ignore' }); r.cleanup(); };
  return { r, wt, g, switched: out(wt, 'rev-parse', 'HEAD'), cleanup };
}

section('換人:app 把舊資料夾換新分支給新對話——認得出來;脫離分支、同一個對話自己換分支、收掉的對話接回原分支、換過去還沒人動,都不算換人(規格:新對話接手舊資料夾 AC-1、AC-2)', 'P6');
{
  const h = (session, sec, cwd = '/w') => ({ ts: new Date(sec * 1000).toISOString(), hook: 'UserPromptSubmit', session, cwd });
  const sha = (c) => c.repeat(40);
  const rl = [
    { sha: sha('a'), sec: 1000, gs: '' },                                          // app 建 worktree
    { sha: sha('b'), sec: 2000, gs: 'commit: 舊對話存檔' },
    { sha: sha('b'), sec: 3000, gs: 'checkout: moving from old to HEAD' },         // app 收掉舊對話(脫離分支)
    { sha: sha('c'), sec: 4000, gs: `checkout: moving from ${sha('b')} to new` },  // app 換新分支給新對話
  ];
  const got = takeoverOf({ reflog: rl, events: [h('s0', 1500), h('s0', 2500), h('s1', 4001)], cwd: '/w' });
  eq('舊對話在前、新對話在後 → 換人,時間是換分支那一刻、版本是換過去的那一個', `${got.state}|${got.at}|${got.commit}|${got.to}`, `ok|${new Date(4000_000).toISOString()}|${sha('c')}|new`);
  eq('別的資料夾的紀錄不算', takeoverOf({ reflog: rl, events: [h('s0', 1500, '/x'), h('s1', 4001)], cwd: '/w' }).state, 'ok');
  eq('只有脫離分支、還沒人接手 → 不算換人(收掉的對話自己的頁面不准變成「資料夾換人了」)',
    takeoverOf({ reflog: rl.slice(0, 3), events: [h('s0', 1500), h('s0', 2500)], cwd: '/w' }).state, 'none');
  eq('同一個對話在換分支前後都有動作(自己換分支)→ 不算換人,之前做的照算',
    takeoverOf({ reflog: rl, events: [h('s0', 1500), h('s0', 4001)], cwd: '/w' }).state, 'none');
  const resume = [...rl.slice(0, 3), { sha: sha('b'), sec: 4000, gs: `checkout: moving from ${sha('b')} to old` }];
  eq('收掉的對話被 app 接回原分支(試驗場那個資料夾 9 月 15、17 日各一次)→ 不算換人',
    takeoverOf({ reflog: resume, events: [h('s0', 1500), h('s0', 4003)], cwd: '/w' }).state, 'none');
  eq('換過去之後還沒有人動 → 分不出是誰換的,不算(寧可多算)', takeoverOf({ reflog: rl, events: [h('s0', 1500)], cwd: '/w' }).state, 'none');
  eq('新對話的第一句話比換分支早一秒(同一秒內誰先記分不出來)→ 還是換人', takeoverOf({ reflog: rl, events: [h('s0', 1500), h('s1', 3999)], cwd: '/w' }).state, 'ok');
  eq('舊對話最後一個動作在換分支前三秒 → 還是上一手的', takeoverOf({ reflog: rl, events: [h('s0', 3997), h('s1', 4001)], cwd: '/w' }).state, 'ok');
  // 新對話接手之後自己又換了一次分支:那一次它橫跨(不是換人),往更早找到的才是它接手的那一刻
  const twice = [...rl, { sha: sha('d'), sec: 5000, gs: 'checkout: moving from new to feat' }];
  const t2 = takeoverOf({ reflog: twice, events: [h('s0', 1500), h('s1', 4001), h('s1', 5001)], cwd: '/w' });
  eq('接手之後自己又換了一次分支 → 接手的那一刻還是第一次換的那一筆', `${t2.state}|${t2.commit}`, `ok|${sha('c')}`);
  eq('reflog 問不到 → 分不出來(unknown),不說換過、也不說沒換過', takeoverOf({ reflog: null, events: [h('s1', 4001)], cwd: '/w' }).state, 'unknown');

  // 這一手的紀錄:這個資料夾換人之前的全部拿掉(感測器的、CLI 記的結論都算),別的資料夾的照留
  const ev = [
    { ...h('s0', 1500), hook: 'PreToolUse', tool: 'Skill', skill: 'spec' },
    { ts: new Date(1600_000).toISOString(), event: 'stage_report', stage: 'A', verdict: 'ok', cwd: '/w', source: 'claude' },
    { ts: new Date(2600_000).toISOString(), event: 'stage_cleared', stage: 'E', cwd: '/w', source: 'human' },
    { ts: '讀不懂的時間', event: 'stage_report', stage: 'C', cwd: '/w' },
    h('s9', 1500, '/x'),
    h('s1', 4001),
    // 換人之後你在儀表板上替上一手按了結案:帶著上一手的對話代號、記在這個資料夾——是上一手的,不是這一手的對話(魔鬼教官 2026-09-24)
    { ts: new Date(4100_000).toISOString(), event: 'session_closed', session: 's0', cwd: '/w', source: 'human' },
    { ts: new Date(4200_000).toISOString(), event: 'session_closed', session: 's0', cwd: '/x', source: 'human' },
  ];
  const kept = tenureEvents(ev, '/w', got);
  eq('留下的:別的資料夾的、換人之後的(時間讀不懂的分不出是不是這一手的,不留;換人之後替上一手按的結案也不留)',
    kept.map((e) => `${e.session ?? e.stage}${e.event === 'session_closed' ? '結案' : ''}`).join(','), 's9,s1,s0結案');
  eq('只剩這一手的對話(新對話不會又被算成跟上一手共用)', sessionsOf(kept).filter((x) => x.cwd === '/w').map((x) => x.id).join(','), 's1');
  eq('沒換過人 → 原封不動', tenureEvents(ev, '/w', { state: 'none' }).length, ev.length);
  eq('上一手:s0 是、s1 不是、只在別的資料夾動過的不是', [previousTenant(ev, '/w', got, 's0'), previousTenant(ev, '/w', got, 's1'), previousTenant(ev, '/w', got, 's9')].join(','), 'true,false,false');
}

section('換人之後的「這次改動」:從換過去的那個版本算——舊對話存的、別的對話併進 main 的都不算進來;同一秒、早一秒也一樣(規格:新對話接手舊資料夾 AC-1)', 'P1');
{
  const f = reusedFolder();
  // 新對話只改了程式區的 a.js,存了檔(reflog 在那之後才讀——同一份拿來找換人、算基準,跟程式裡一樣)
  writeFileSync(join(f.wt, 'src/a.js'), 'new conversation\n');
  commitAt(f.wt, T(-3 * MIN), '新對話存檔');
  const rl = reflogOf(f.wt);
  check('reflog 讀得到換分支那一筆的說明', rl.some((e) => /^checkout: moving from \S+ to new$/.test(e.gs)), JSON.stringify(rl.map((e) => e.gs)));
  const took = takeoverOf({ reflog: rl, cwd: f.wt, events: [
    { ts: T(-235 * MIN), hook: 'UserPromptSubmit', session: 's0', cwd: f.wt },
    { ts: T(-10 * MIN + 1), hook: 'UserPromptSubmit', session: 's1', cwd: f.wt },
  ] });
  eq('認得出換人,版本是換過去的那一個', `${took.state}|${took.commit}`, `ok|${f.switched}`);
  const rel = relationOf(f.wt);
  const base = changeBase({ root: f.wt, origin: { at: T(-10 * MIN + 1), from: 'prompt', sessions: 1 }, relationOf: rel, reflog: rl, takeover: took });
  eq('基準是換過去的那個版本', `${base.kind}|${base.since}`, `origin|${f.switched}`);
  eq('清單只有這個對話改的(別的對話併進 main 的危險檔不在裡面)', changeHealth(f.wt, base.since).list.join(','), 'src/a.js');
  // 以前的算法:舊對話的 A 當起點 → 舊的版本,危險檔被算成這個對話改的(9/24 的 T2)
  const old = changeBase({ root: f.wt, origin: { at: T(-235 * MIN), from: 'A', sessions: null }, relationOf: rel, reflog: rl });
  check('對照:從舊對話的 A 算,危險檔就混進來(這次要修的洞)', changeHealth(f.wt, old.since).list.includes('src/danger.js'), JSON.stringify(changeHealth(f.wt, old.since).list));
  // 新對話的第一句話跟換分支同一秒、甚至早一秒(同一秒內分不出先後):照「同一秒算之後」會拿到換之前的舊版本
  for (const [label, at] of [['同一秒', T(-10 * MIN)], ['早一秒', T(-10 * MIN - 1)]]) {
    const b = changeBase({ root: f.wt, origin: { at, from: 'prompt', sessions: 1 }, relationOf: rel, reflog: rl, takeover: took });
    eq(`第一句話跟換分支${label} → 還是換過去的那個版本`, b.since, f.switched);
  }
  // 換人之後一筆紀錄都還沒有:起點就是換人那一刻(git 的事實),不退回只看還沒存檔的
  const none = changeBase({ root: f.wt, origin: null, relationOf: rel, reflog: rl, takeover: took });
  eq('沒有這一輪的紀錄,但知道換人 → 從換人那一刻的版本算', `${none.kind}|${none.since}|${none.origin?.from}`, `origin|${f.switched}|takeover`);
  const sc = changeScope(none, () => '10 分鐘前');
  check('文案講「從這個資料夾換到這條分支（10 分鐘前）那一刻」', /從這個資料夾換到這條分支（10 分鐘前）那一刻的版本算起/.test(sc.note), sc.note);
  eq('換過去之後又存了檔 → 知道中間動過(0 的時候不准畫綠臉)', none.moved, true);
  f.cleanup();
}

section('刪掉的檔也有時間:看它所在資料夾的時間(上限,只會說得比實際晚)——以前沒有時間,只刪檔的回合收工 hook 安靜放行(魔鬼教官 2026-09-22)', 'P5');
{
  const root = mkdtempSync(join(tmpdir(), 'pm-origin-del-'));
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  writeFileSync(join(root, 'src', 'old.js'), 'x\n');
  writeFileSync(join(root, 'src', 'deep', 'gone.js'), 'x\n');
  const past = new Date(NOW - 3600_000);
  utimesSync(join(root, 'src', 'old.js'), past, past);
  eq('檔案在:它自己的修改時間', changeTimeOf(root, 'src/old.js'), statSync(join(root, 'src', 'old.js')).mtimeMs);
  unlinkSync(join(root, 'src', 'old.js'));
  eq('被刪了:所在資料夾的時間(刪的那一刻會更新)', changeTimeOf(root, 'src/old.js'), statSync(join(root, 'src')).mtimeMs);
  check('而且不會比刪之前那個修改時間早', changeTimeOf(root, 'src/old.js') >= past.getTime());
  rmSync(join(root, 'src', 'deep'), { recursive: true, force: true });
  eq('連資料夾都刪了:往上找還在的那一層', changeTimeOf(root, 'src/deep/gone.js'), statSync(join(root, 'src')).mtimeMs);
  eq('工作區本身都不在 → 問不到(null)', changeTimeOf(join(root, '沒有這個'), 'a.js'), null);
  rmSync(root, { recursive: true, force: true });
}

/**
 * 照 app 現在(2026-10-01 起)的做法開一個工作區:開資料夾那一刻不留 reflog——worktree 自己那份、分支那份都沒有,第一次存檔才有。
 * 10/2 實測 TutorPod 的兩個資料夾就是這樣(.git/worktrees/<名>/ 底下沒有 logs/)。
 */
function appWorktree(r, branch) {
  const wt = join(mkdtempSync(join(tmpdir(), 'pm-origin-app-')), 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', branch, wt], { cwd: r.dir, stdio: 'ignore' });
  rmSync(join(out(wt, 'rev-parse', '--absolute-git-dir'), 'logs'), { recursive: true, force: true });
  rmSync(join(r.dir, '.git', 'logs', 'refs', 'heads', branch), { force: true });
  return wt;
}

section('app 新開的資料夾沒有 reflog(2026-10-01 起實測):起點的版本看感測器在那一筆記的版本號——存檔之後,存過的改動照樣算得到(規格:多份規格與新資料夾的起點 AC-8、AC-9)', 'P1');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n' }, at: T(-60 * MIN) });
  const init = out(r.dir, 'rev-parse', 'HEAD');
  const wt = appWorktree(r, 'app-branch');
  eq('reflog 讀得到、但一筆都沒有(跟 10/2 那個資料夾一樣)', JSON.stringify(reflogOf(wt)), '[]');
  const short = init.slice(0, 7);
  const origin = { at: T(-5 * MIN), from: 'A', sessions: null, head: short, heads: [short] };
  const rel = relationOf(wt);
  const before = changeBase({ root: wt, origin, relationOf: rel });
  eq('還沒存檔:基準是感測器記的那個版本,不是只看還沒存檔的', `${before.kind}|${before.since}|${before.src}`, `origin|${init}|sensor`);
  eq('還沒存檔、HEAD 沒動過 → 沒有 moved', before.moved, false);
  // Claude 收工前先存檔:reflog 這時才有第一筆(存檔那一筆,比起點晚)
  writeFileSync(join(wt, 'src/a.js'), '2\n');
  commitAt(wt, T(-2 * MIN), '收工前存檔');
  const rl = reflogOf(wt);
  check('存檔之後 reflog 只有存檔那一筆,比起點晚(git 自己查不到起點的版本)', rl?.length === 1 && versionAt(wt, origin.at, { reflog: rl }).state === 'none', JSON.stringify(rl));
  const after = changeBase({ root: wt, origin, relationOf: rel });
  eq('存檔之後:基準還是起點那一刻的版本', `${after.kind}|${after.since}|${after.src}`, `origin|${init}|sensor`);
  check('存檔過的改動還在清單裡(以前這裡只看得到還沒存檔的:0 個,分級變「看不全」、收工 hook 放行)', changeHealth(wt, after.since).list.includes('src/a.js'), JSON.stringify(changeHealth(wt, after.since).list));
  eq('起點之後存過檔 → 中間動過', after.moved, true);
  eq('畫面拿到的起點不帶版本號(版本代號不給畫面)', Object.keys(after.origin).sort().join(','), 'at,from,sessions');
  const noHead = changeBase({ root: wt, origin: { at: origin.at, from: 'A', sessions: null }, relationOf: rel });
  eq('起點那一筆沒記到版本號 → 跟以前一樣只看還沒存檔的、講找不到(AC-10)', `${noHead.kind}|${noHead.why}`, 'head|not-found');
  check('那張臉照舊講「存檔過的看不到」,不講沒有改動', /存檔過的看不到/.test(changeScope(noHead, () => '').empty));
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: r.dir, stdio: 'ignore' });
  r.cleanup();
}

section('兩邊都查不到就照實講,不拿差不多的版本頂替;git 查得到的照舊用 git,算法一個字不改(AC-8、AC-10)', 'P5');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n' }, at: T(-60 * MIN) });
  const init = out(r.dir, 'rev-parse', 'HEAD');
  eq('短版本號 → 完整的版本', commitOfHead(r.dir, init.slice(0, 7)), init);
  for (const bad of ['', 'null', 'zzzzzzz', 'deadbee', '12', undefined]) eq(`認不出來的版本號(${JSON.stringify(bad)}) → null,不猜`, commitOfHead(r.dir, bad), null);
  // 別條分支上的版本:還在 repo 裡,但不在這條線上——跟失效的章同一個判斷(checkpointRelation)
  const main = out(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  execFileSync('git', ['checkout', '-q', '-b', 'side'], { cwd: r.dir });
  writeFileSync(join(r.dir, 'src/a.js'), 'side\n');
  commitAt(r.dir, T(-50 * MIN), '別條線');
  const side = out(r.dir, 'rev-parse', 'HEAD');
  execFileSync('git', ['checkout', '-q', main], { cwd: r.dir });
  const off = changeBase({ root: r.dir, origin: { at: T(-5 * MIN), from: 'A', head: side.slice(0, 7) }, relationOf: relationOf(r.dir), reflog: [] });
  eq('感測器記的版本不在這條線上 → 只看還沒存檔的、講找不到', `${off.kind}|${off.why}`, 'head|not-found');
  // reflog 查得到時照舊用 reflog,感測器記的版本號就算不一樣也不拿來換(今天的行為不變)
  const viaGit = changeBase({ root: r.dir, origin: { at: T(-5 * MIN), from: 'A', head: side.slice(0, 7) }, relationOf: relationOf(r.dir) });
  eq('reflog 查得到 → 用 reflog 那一個(不是感測器記的)', `${viaGit.kind}|${viaGit.since}|${viaGit.src}`, `origin|${init}|reflog`);
  r.cleanup();
}

section('「這一輪中間動過」也看感測器:沒有 reflog 的資料夾,起點之後記到別的版本號 → 0 的時候講看不全(AC-11,老毛病 P5 的第二個身體)', 'P5');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n' }, at: T(-60 * MIN) });
  const init = out(r.dir, 'rev-parse', 'HEAD');
  const wt = appWorktree(r, 'app-moved');
  const o = (heads) => ({ at: T(-5 * MIN), from: 'prompt', sessions: 1, head: init.slice(0, 7), heads });
  eq('感測器起點之後都記同一個版本 → 沒動過', changeBase({ root: wt, origin: o([init.slice(0, 7)]), relationOf: relationOf(wt) }).moved, false);
  const moved = changeBase({ root: wt, origin: o([init.slice(0, 7), 'abcdef1']), relationOf: relationOf(wt) });
  eq('感測器起點之後記到別的版本號 → 動過(git 一筆紀錄都沒有也一樣)', moved.moved, true);
  check('0 的時候那句話換臉:講中間存過檔或切過分支,不畫「沒有改動」', changeScope(moved, () => '').emptyBlind === true);
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: r.dir, stdio: 'ignore' });
  r.cleanup();
}

section('reflog 最早那一筆跟起點同一秒、而且是對話自己的存檔(app 10/1 起開的資料夾):不當成「資料夾剛建好」,交給感測器那條路(魔鬼教官第一輪,L31 的同一個前提)', 'P1');
{
  const at = (sec) => new Date(sec * 1000 + 400).toISOString();
  eq('最早那一筆是開資料夾那種(沒有說明)、同一秒 → 照舊用它', versionAt('/x', at(100), { reflog: [{ sha: 'a'.repeat(40), sec: 100, gs: '' }] }).commit, 'a'.repeat(40));
  const v = versionAt('/x', at(100), { reflog: [{ sha: 'b'.repeat(40), sec: 100, gs: 'commit: 收工前存檔' }] });
  eq('最早那一筆是存檔、同一秒 → 不拿存檔之後的版本(那樣這一輪的改動變 0)', `${v.state}|${v.why}`, 'none|before-history');
}

section('「這一輪中間動過」從真的紀錄算:沒有 reflog 的資料夾,起點之後感測器記到別的版本號 → 0 個改動時講看不全(魔鬼教官第一輪:以前只手寫 heads 餵進去)', 'P5');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n' }, at: T(-60 * MIN) });
  const init = out(r.dir, 'rev-parse', 'HEAD');
  const wt = appWorktree(r, 'app-heads');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-origin-mon-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  writeFileSync(join(monitorDir, 'stages.json'), readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'stages.json')));
  const log = join(monitorDir, 'logs', `${safeName(basename(r.dir))}.jsonl`);
  const ev = (o) => JSON.stringify({ session: 's1', cwd: wt, ...o });
  const write = (lines) => writeFileSync(log, lines.map(ev).join('\n') + '\n');
  const baseOf = () => cardFor({ monitorDir, path: wt })?.card;
  write([{ ts: T(-10 * MIN), hook: 'UserPromptSubmit', prompt: '開始', head: init.slice(0, 7) },
         { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '繼續', head: init.slice(0, 7) }]);
  let c = baseOf();
  eq('感測器起點之後都記同一個版本 → 沒動過,0 的時候講一模一樣', `${c?.base?.kind}|${c?.base?.moved}|${c?.scope?.emptyBlind}`, 'origin|false|false');
  // 中間 HEAD 被不留 reflog 的東西移走又移回來:感測器在那段時間記到別的版本號
  write([{ ts: T(-10 * MIN), hook: 'UserPromptSubmit', prompt: '開始', head: init.slice(0, 7) },
         { ts: T(-7 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(wt, 'src/a.js'), head: 'abcdef1' },
         { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '繼續', head: init.slice(0, 7) }]);
  c = baseOf();
  eq('感測器起點之後記到別的版本號 → 動過,0 的時候不畫「沒有改動」那張臉', `${c?.base?.kind}|${c?.base?.moved}|${c?.scope?.emptyBlind}`, 'origin|true|true');
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: r.dir, stdio: 'ignore' });
  rmSync(monitorDir, { recursive: true, force: true });
  r.cleanup();
}

process.exit(summary());
