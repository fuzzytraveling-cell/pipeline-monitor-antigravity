/**
 * status.test.mjs —— 釘住「不准說謊」的那幾條
 *
 * ⚠️ 這裡刻意**不測長相**,只測**會安靜說謊的地方**:
 *    數量算錯、把「沒問到」當成「沒有」、拿雜訊當基準。
 *    純視覺的東西壞了看得見;這幾條壞了測試全綠、畫面照跑。
 */
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { gitContext, changeScale, changeHealth, detectChecks, ago } from '../status.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

section('L2 回歸：改動計數必須看得到「還沒被 git 追蹤的新檔案」');
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
  const head = r.git('rev-parse', 'HEAD');
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
