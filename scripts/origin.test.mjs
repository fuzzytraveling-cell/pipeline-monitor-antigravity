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
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, utimesSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { reflogOf, versionAt, changeBase, changeFacts } from '../lib/origin.mjs';
import { changeTimeOf } from '../lib/tier.mjs';
import { changeScope } from '../lib/scope.mjs';
import { changeHealth, checkpointRelation } from '../lib/git.mjs';

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

section('worktree 有自己的一份 reflog,建好那一刻就有一筆(app 一個對話開一個 worktree)');
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

process.exit(summary());
