/**
 * status.test.mjs —— 釘住「不准說謊」的那幾條
 *
 * ⚠️ 這裡刻意**不測長相**,只測**會安靜說謊的地方**:
 *    數量算錯、把「沒問到」當成「沒有」、拿雜訊當基準。
 *    純視覺的東西壞了看得見;這幾條壞了測試全綠、畫面照跑。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import {
  gitContext, changeScale, changeHealth, detectChecks, ago,
  uncommitted, checkpointRelation, describeCheckpoint,
} from '../status.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const sha = (dir, ref = 'HEAD') => execFileSync('git', ['rev-parse', ref], { cwd: dir, encoding: 'utf8' }).trim();

section('L2 回歸：改動計數必須看得到「還沒被 git 追蹤的新檔案」', 'P1');
{
  // ⚠️ 這個 bug 踩過 2 次(docs/LESSONS.md L2)。漏掉的方向固定是
  //    讓改動看起來比實際小——也就是危險的那一邊。
  const r = makeRepo({ pkg: { name: 'x' }, files: { 'a.js': 'x\n' } });
  writeFileSync(join(r.dir, 'a.js'), 'x\ny\n');   // 改一個已追蹤的
  writeFileSync(join(r.dir, 'brand-new.js'), 'z\n'); // 加一個沒追蹤的
  const h = changeHealth(r.dir, null);
  eq('2 個檔案(1 改 + 1 新),不是 1 個', h.files, 2);
  eq('其中 1 個是新檔案', h.newFiles, 1);
  r.cleanup();
}

section('L2 第三次：git 的某一種問法看不到某一類改動', 'P1');
{
  // B1:git add 過的改動,沒帶 HEAD 的 git diff 完全看不到 → 畫面說「沒有改動」
  const r = makeRepo({ files: { 'a.js': 'x\n' } });
  writeFileSync(join(r.dir, 'a.js'), 'x\ny\n');
  r.git('add', 'a.js');
  eq('add 過的改動也算改動(不是「沒有改動」)', changeHealth(r.dir, null).files, 1);
  // B2:整個新資料夾要一個檔案算一個,不是整個資料夾算 1
  mkdirSync(join(r.dir, 'new'));
  for (const f of ['1', '2', '3']) writeFileSync(join(r.dir, `new/${f}.js`), `${f}\n`);
  eq('新資料夾裡 3 個檔案 → 還沒存進保險箱的是 4 個,不是 2 個', uncommitted(r.dir), 4);
  // B3:只刪不加,shortstat 沒有「insertion」字樣
  const r2 = makeRepo({ files: { 'a.js': '1\n2\n3\n' } });
  writeFileSync(join(r2.dir, 'a.js'), '1\n');
  const h2 = changeHealth(r2.dir, null);
  eq('只刪不加:刪了 2 行(不是 0)', h2.removed, 2);
  eq('只刪不加:加了 0 行', h2.added, 0);
  r.cleanup(); r2.cleanup();
}

section('同一個畫面上的兩個數字必須一樣', 'P2');
{
  // 「還沒存進保險箱」跟「改動」以前是兩種問法算的,3 大於 2 那種畫面就是這樣來的
  const r = makeRepo({ files: { 'a.js': 'x\n', 'b.js': 'y\n' } });
  writeFileSync(join(r.dir, 'a.js'), 'x\nz\n'); r.git('add', 'a.js');   // add 過的
  writeFileSync(join(r.dir, 'b.js'), 'y\nw\n');                          // 還沒 add 的
  mkdirSync(join(r.dir, 'new'));                                          // 新資料夾
  for (const f of ['1', '2', '3']) writeFileSync(join(r.dir, `new/${f}.js`), `${f}\n`);
  const h = changeHealth(r.dir, null);
  eq('「還沒存進保險箱」＝「改動」的檔案數', uncommitted(r.dir), h.files);
  eq('而且是 5 個', h.files, 5);
  eq('其中 3 個是新檔案', h.newFiles, 3);
  r.cleanup();
}

section('L14：章跟現在的 HEAD 是什麼關係,決定能不能給回去的指令');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const c1 = sha(r.dir);
  const same = checkpointRelation(r.dir, c1);
  check('章就是現在 → ok,之後 0 次存檔', same.state === 'ok' && same.commitsAfter === 0, JSON.stringify(same));
  for (let i = 0; i < 2; i++) {
    writeFileSync(join(r.dir, `f${i}.js`), `${i}\n`); r.git('add', '-A'); r.git('commit', '-qm', `c${i}`);
  }
  const after = checkpointRelation(r.dir, c1);
  check('章之後存了 2 次 → ok 且 commitsAfter=2', after.state === 'ok' && after.commitsAfter === 2, JSON.stringify(after));
  // 歷史被改寫:amend 之後舊的 SHA 還在倉庫裡,但已經不在分支上——git diff 對它照樣算得出數字
  const c3 = sha(r.dir);
  r.git('commit', '--amend', '-qm', 'rewritten');
  eq('歷史改寫過 → off-branch(不是 ok,也不是 gone)', checkpointRelation(r.dir, c3).state, 'off-branch');
  eq('根本不存在的版本 → gone', checkpointRelation(r.dir, '0000000000000000000000000000000000000000').state, 'gone');
  r.cleanup();
}

section('L14：章不能用的時候,畫面上不准出現 reset --hard');
{
  const cp = { commit: 'abcdef0123456789', at: new Date().toISOString(), checks: ['test'] };
  const text = (args) => describeCheckpoint({ cp, dirty: 0, files: 5, ...args }).join('\n');

  const off = text({ rel: { state: 'off-branch' } });
  check('off-branch → 沒有 reset --hard', !off.includes('reset --hard'), off);
  check('off-branch → 說「失效」,並給重蓋的指令', off.includes('失效') && off.includes('--checkpoint'), off);
  check('gone → 沒有 reset --hard', !text({ rel: { state: 'gone' } }).includes('reset --hard'));
  check('問不到關係 → 沒有 reset --hard(沒問到不准當成沒事)',
        !text({ rel: { state: 'unknown' } }).includes('reset --hard'));

  const ok2 = text({ rel: { state: 'ok', commitsAfter: 2 }, files: 3, now: new Date(2026, 8, 11, 9, 5) });
  check('之後有 2 次存檔 → 講明會丟掉 2 次', ok2.includes('2 次存檔'), ok2);
  check('先給備份分支(含日期時間),再給 reset',
        ok2.includes('git branch 備份-2026-09-11-0905') && ok2.indexOf('git branch') < ok2.indexOf('reset --hard'), ok2);
  const okDirty = text({ rel: { state: 'ok', commitsAfter: 0 }, dirty: 3, files: 3 });
  check('有 3 個沒存的 → stash 在 reset 前面',
        okDirty.includes('stash') && okDirty.indexOf('stash') < okDirty.indexOf('reset --hard'), okDirty);
  const okNull = text({ rel: { state: 'ok', commitsAfter: 0 }, dirty: null, files: 3 });
  check('問不到有沒有沒存的 → 說問不到,而且還是先給 stash', okNull.includes('問不到') && okNull.includes('stash'), okNull);
  const clean = text({ rel: { state: 'ok', commitsAfter: 0 }, files: 0 });
  check('章就是現在、什麼都沒改 → 沒有回去的指令(沒有地方可以回)', !clean.includes('reset --hard'), clean);
}

section('AC-7：樣本太少就不給比例尺（雜訊不能當基準）');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });   // 只有 1 個 commit
  check('1 個 commit → null,不給比例尺', changeScale(r.dir) === null);
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(r.dir, `f${i}.js`), `${i}\n`);
    r.git('add', '-A'); r.git('commit', '-qm', `c${i}`);
  }
  const s = changeScale(r.dir);
  check('7 個 commit → 給得出中位數與最大值', s !== null && s.median >= 1 && s.max >= 1,
        JSON.stringify(s));
  r.cleanup();
}

section('R1：「沒問到」不准變成「沒有」');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });   // 沒有 package.json
  check('沒有 package.json → detectChecks 回 null(不是空陣列)',
        detectChecks(r.dir) === null,
        '空陣列會被讀成「這個專案沒有檢查」——那是編出來的答案');
  const r2 = makeRepo({ pkg: { name: 'x', scripts: {} }, files: { 'a.js': '1\n' } });
  check('有 package.json 但沒有那幾支 script → 一樣回 null', detectChecks(r2.dir) === null);
  const r3 = makeRepo({ pkg: { name: 'x', scripts: { lint: 'true', build: 'true' } } });
  const d = detectChecks(r3.dir);
  check('認得出實際有的那幾支(不是寫死 TutorPod 的四項)',
        Array.isArray(d) && d.length === 2 && d.includes('lint') && d.includes('build'),
        JSON.stringify(d));
  r.cleanup(); r2.cleanup(); r3.cleanup();
}

section('AC-10：不是 git／零 commit／detached HEAD 都不准當機');
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const plain = mkdtempSync(join(tmpdir(), 'pm-plain-'));
  eq('不是 git 專案 → isGit=false,不丟例外', gitContext(plain).isGit, false);
  rmSync(plain, { recursive: true, force: true });

  const empty = makeRepo({ commit: false });
  const ctx = gitContext(empty.dir);
  eq('零 commit → hasCommits=false', ctx.hasCommits, false);
  check('零 commit 時分支名不是 null(不准把內部值印給人看)',
        ctx.branch !== null && ctx.branch !== 'null', `branch=${ctx.branch}`);
  empty.cleanup();
}

section('AC-8：只點名「被修改」的既有測試,不點名新增的');
{
  const r = makeRepo({ pkg: { name: 'x' }, files: { 'tests/old.test.js': 'a\n', 'app.js': 'a\n' } });
  writeFileSync(join(r.dir, 'tests/old.test.js'), 'b\n');   // 改既有測試
  writeFileSync(join(r.dir, 'tests/new.test.js'), 'c\n');   // 新增測試
  const h = changeHealth(r.dir, null);
  eq('只有 1 個既有測試被點名', h.modifiedTests.length, 1);
  check('點名的是 old 不是 new', h.modifiedTests[0].includes('old'), h.modifiedTests.join(','));
  r.cleanup();
}

section('相依偵測不靠 package.json 的排版（L5）');
{
  const r = makeRepo({ pkg: { name: 'x', dependencies: { a: '^1.0.0' } } });
  // 壓成一行,沒有換行也沒有縮排——舊版的正則在這裡會安靜地認不到
  writeFileSync(join(r.dir, 'package.json'),
    JSON.stringify({ name: 'x', dependencies: { a: '^1.0.0', lodash: '^4.0.0' } }));
  const h = changeHealth(r.dir, null);
  check('壓成一行也認得出新增的 lodash', h.newDeps.includes('lodash'), JSON.stringify(h.newDeps));
  check('原本就有的 a 不算新增', !h.newDeps.includes('a'));
  r.cleanup();
}

section('沒有 package.json 也不准當機（AC-10 可攜性）');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });   // 完全沒有 package.json
  writeFileSync(join(r.dir, 'b.js'), '2\n');
  let threw = null;
  try { changeHealth(r.dir, null); } catch (e) { threw = e.message; }
  check('不是 npm 專案 → changeHealth 不丟例外', threw === null, threw ?? '');
  r.cleanup();
}

section('ago()：不准把壞掉的時間印成數字');
{
  check('看不懂的時間 → 說「時間對不上」,不編一個數字', ago('not-a-date').includes('對不上'));
  check('剛剛 → 分鐘', ago(new Date().toISOString()).includes('分鐘'));
}

process.exit(summary());
