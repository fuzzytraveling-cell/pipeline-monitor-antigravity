/**
 * status.test.mjs —— 釘住「不准說謊」的那幾條
 *
 * ⚠️ 這裡刻意**不測長相**,只測**會安靜說謊的地方**:
 *    數量算錯、把「沒問到」當成「沒有」、拿雜訊當基準。
 *    純視覺的東西壞了看得見;這幾條壞了測試全綠、畫面照跑。
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';   // 排第一個:它先換上假的家,下面的 cli*.mjs 一載入就問家在哪
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { detectChecks, describeCheckFailure } from '../lib/cliStamp.mjs';
import { describeCheckpoint, describeSensor } from '../lib/cliView.mjs';
import { loseUnsavedLine, UNSAVED_WHETHER } from '../lib/scope.mjs';
import { gitContext, changeScale, changeHealth, ago, withClock, uncommitted, checkpointRelation } from '../lib/git.mjs';
import { RETAIN_DAYS } from '../lib/events.mjs';
import { humanAge } from '../lib/freshness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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

section('搬家(git mv)的檔新舊兩個路徑都算:只列新路徑的話,搬走危險清單上的檔分級就看不到(魔鬼教官 2026-09-22)', 'P1');
{
  const r = makeRepo({ files: { 'lib/events.mjs': 'x\n'.repeat(20) } });
  mkdirSync(join(r.dir, 'lib', 'events'), { recursive: true });
  r.git('mv', 'lib/events.mjs', 'lib/events/index.mjs');
  const staged = changeHealth(r.dir, null);
  check('還沒存:新舊兩個路徑都在清單裡', staged.list.includes('lib/events.mjs') && staged.list.includes('lib/events/index.mjs'), JSON.stringify(staged.list));
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).trim();
  r.git('commit', '-qm', '搬家');
  const committed = changeHealth(r.dir, before);
  check('存檔之後從起點算:新舊兩個路徑都還在', committed.list.includes('lib/events.mjs') && committed.list.includes('lib/events/index.mjs'), JSON.stringify(committed.list));
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
  // 「會丟掉幾個」「問不到」跟儀表板還原點那一行同一句(lib/scope.mjs;規格:先講commit再講蓋章 AC-9、AC-11)
  check('有 3 個沒 commit → 終端機講的就是 lib 那一句', okDirty.includes(`⚠️ ${loseUnsavedLine(3)}。想留著先打：`), okDirty);
  const okBoth = text({ rel: { state: 'ok', commitsAfter: 2 }, dirty: 3, files: 3 });
  check('之後也有存檔 → 「也會丟掉」照舊', okBoth.includes(`⚠️ ${loseUnsavedLine(3, true)}。想留著先打：`) && loseUnsavedLine(3, true).startsWith('回去也會丟掉'), okBoth);
  check('問不到 → 終端機講的就是 lib 那一句', okNull.includes(`⚠️ ${UNSAVED_WHETHER}。保險起見先打：`), okNull);
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

section('D：感測器那一行——「掛在哪」看設定,「活著嗎」看紀錄', 'P3');
{
  const t = (o) => describeSensor(o).join('\n');
  const now = new Date().toISOString();
  const off = t({ mount: { state: 'off', where: null, paths: [] }, lastSeen: now });
  check('設定裡找不到、紀錄裡卻有 → 說「它在記」,不准說「沒掛上」', off.includes('它在記') && !off.includes('沒掛上'), off);
  const offNone = t({ mount: { state: 'off', where: null, paths: [] }, lastSeen: null });
  check('設定沒有、紀錄也沒有 → 沒掛上', offNone.includes('沒掛上'), offNone);
  const okMain = t({ mount: { state: 'ok', where: 'main', paths: [] }, lastSeen: now });
  check('用主資料夾的設定 → 講明,而且給最後一筆', okMain.includes('主資料夾') && okMain.includes('最後一筆'), okMain);
  // 「還沒有」只在這個專案連紀錄檔都沒有時講;有紀錄檔就是記過,這裡的可能超過保留期限清掉了(規格:90天清空之後的說法 AC-4)
  const okNone = t({ mount: { state: 'ok', where: 'here', paths: [] }, lastSeen: null, hasLog: false });
  check('掛上了、這個專案連紀錄檔都沒有 → 說「還沒有來自這裡的紀錄」,不說在記', okNone.includes('還沒有來自這裡的紀錄'), okNone);
  const okGone = t({ mount: { state: 'ok', where: 'here', paths: [] }, lastSeen: null, hasLog: true });
  check(`掛上了、紀錄檔在、這裡 ${RETAIN_DAYS} 天內沒有 → 「${RETAIN_DAYS} 天內沒有」,不說「還沒有」(更早的可能清掉了)`,
    okGone.includes(`${RETAIN_DAYS} 天內沒有來自這裡的紀錄`) && !okGone.includes('還沒有'), okGone);
  const okUnknown = t({ mount: { state: 'ok', where: 'here', paths: [] }, lastSeen: null });
  check('不知道有沒有紀錄檔 → 講永遠是真的那句(N 天內沒有)', okUnknown.includes(`${RETAIN_DAYS} 天內沒有來自這裡的紀錄`), okUnknown);
  const broken = t({ mount: { state: 'broken', where: 'here', paths: ['/x/hook.sh'] }, lastSeen: now });
  check('壞掉 → 紀錄已經停了 + 找不到的路徑 + 最後一筆之後就沒了',
        broken.includes('紀錄已經停了') && broken.includes('/x/hook.sh') && broken.includes('從那之後'), broken);
}

section('E2：「沒跑起來」跟「跑了沒過」要分開講');
{
  const t = (fail) => describeCheckFailure('lint', { status: null, code: null, stderr: '', stdout: '', ...fail }).join('\n');
  const noNpm = t({ code: 'ENOENT' });
  check('找不到 npm → 跑不起來,不是「沒過」', noNpm.includes('跑不起來') && !noNpm.includes('跑了,沒過'), noNpm);
  const noTool = t({ status: 127, stderr: 'sh: eslint: command not found' });
  check('127 → 跑不起來(工具沒裝),而且把它說的話印出來',
        noTool.includes('跑不起來') && noTool.includes('command not found'), noTool);
  const red = t({ status: 1, stderr: 'a\nb\nc\nd\ne\nf\ng\n真正的錯誤在這' });
  check('跑了沒過 → 說沒過,只給最後幾行(最後一行在,第一行不在)',
        red.includes('跑了,沒過') && red.includes('真正的錯誤在這') && !red.includes('│ a'), red);
  const mute = t({ status: 1 });
  check('什麼都沒印 → 照實說它什麼都沒說', mute.includes('什麼都沒說'), mute);
}

section('D2：整支 CLI 跑一次——故障記號不蓋掉紀錄;設定找不到但紀錄有 → 說在記', 'P3');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: r.dir, encoding: 'utf8' }).trim();
  const logDir = mkdtempSync(join(tmpdir(), 'pm-cli-'));
  const ts = new Date(Date.now() - 120_000).toISOString();
  writeFileSync(join(logDir, `${basename(root)}.jsonl`), [
    JSON.stringify({ ts, hook: 'UserPromptSubmit', session: 's1', cwd: root, prompt: 'hi' }),
    JSON.stringify({ ts, hook: 'PreToolUse', session: 's1', cwd: root, tool: 'Skill', skill: 'chaos-check', args: '看一下' }),
  ].join('\n') + '\n');
  // 故障比紀錄晚一分鐘:那之後一筆都沒記到(同一秒的話分不出先後,照「之後沒記到」講)
  writeFileSync(join(logDir, '_sensor.jsonl'), JSON.stringify({ ts: new Date(Date.parse(ts) + 60_000).toISOString(), event: 'sensor_broken', why: 'jq 不存在' }) + '\n');
  // HOME 換成空的:mountState 會退而找 ~/.claude,不能讓這台機器的設定影響結果
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  const out = execFileSync('node', [join(ROOT, 'status.mjs')], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PIPELINE_MONITOR_LOG_DIR: logDir, HOME: home },
  });
  // 故障在最後一筆紀錄之後(之後一筆都沒記到)= 還在壞:最上面講「記不到東西」,從最後一筆正常紀錄算起(規格:agent回報與故障記號 AC-5)
  check('故障記號 → 最上面一行講感測器記不到,五關照畫(D 有「⏸ 跑過」)',
    out.includes('這台電腦的感測器記不到東西') && out.includes('最後一筆正常紀錄是') && out.includes('⏸'), out);
  check('不再把整區蓋成「紀錄檔存在,但裡面沒有東西」', !out.includes('裡面沒有東西'), out);
  check('設定裡沒掛、紀錄裡有 → 感測器那行說那時候它在記,不說它現在在記(現在記不到)', out.includes('那時候它在記') && out.includes('之後這台電腦的感測器記不到東西'), out);
  for (const d of [logDir, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('C2：在子資料夾跑,專案名不准變成上一層', 'P2');
{
  // git 從子資料夾回的 --git-common-dir 是相對於**執行位置**的 '../.git';以前接在 root 後面 → 變上一層的名字
  const r = makeRepo({ files: { 'src/a.js': '1\n' } });
  const expect = basename(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: r.dir, encoding: 'utf8' }).trim());
  eq('根目錄 → 專案名 = 資料夾名', gitContext(r.dir).project, expect);
  eq('src/ 裡 → 一樣(不是上一層)', gitContext(join(r.dir, 'src')).project, expect);
  // worktree 的子資料夾走另一條路(--git-common-dir 回絕對路徑),也要對
  const wtParent = mkdtempSync(join(tmpdir(), 'pm-wt-'));
  const wt = join(wtParent, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'side'], { cwd: r.dir, stdio: 'ignore' });
  eq('worktree 的 src/ 裡 → 仍是主專案的名字', gitContext(join(wt, 'src')).project, expect);
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: r.dir, stdio: 'ignore' });
  rmSync(wtParent, { recursive: true, force: true }); r.cleanup();
}

section('E1：透過捷徑(symlink)執行也要有輸出——L1 的同一族', 'P3');
{
  // npm link／npx 就是這種方式:argv[1] 是捷徑,import.meta.url 是真實路徑,直接比對永遠 false → 零輸出零錯誤
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const bin = mkdtempSync(join(tmpdir(), 'pm-bin-'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  symlinkSync(join(ROOT, 'status.mjs'), join(bin, 'pipeline-status'));
  const out = execFileSync('node', [join(bin, 'pipeline-status')],
    { cwd: r.dir, encoding: 'utf8', env: { ...process.env, HOME: home } });
  check('有印東西(不是安靜地什麼都不做)', out.includes('━━'), JSON.stringify(out.slice(0, 80)));
  for (const d of [bin, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('ago()：不准把壞掉的時間印成數字;「幾分鐘前」終端機跟網頁只有一份算法', 'P2');
{
  check('看不懂的時間 → 說「時間對不上」,不編一個數字', ago('not-a-date').includes('對不上'));
  check('時鐘被調過(未來的時間) → 一樣說對不上,不印負數', ago(new Date(Date.now() + 60_000).toISOString()).includes('對不上'));
  // 以前終端機自己算,60 秒內印「0 分鐘前」,網頁同一刻印「30 秒前」——同一件事兩種說法
  check('剛剛 → 「剛剛」或幾秒前,不印「0 分鐘前」', /^(剛剛|\d+ 秒前)$/.test(ago(new Date().toISOString())), ago(new Date().toISOString()));
  check('3 分鐘前 → 3 分鐘前', ago(new Date(Date.now() - 3 * 60_000).toISOString()) === '3 分鐘前');
  check('跟網頁那份(lib/freshness.mjs 的 humanAge)算出來一字不差', ago(new Date(Date.now() - 90 * 60_000).toISOString()) === humanAge(90 * 60));
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  // 凍住的那一刻之後才寫進來的那一筆(終端機記完一筆馬上回讀):是剛剛,不是時鐘對不上(魔鬼教官第二輪 2026-10-27,LESSONS L42)
  const late = withClock(() => { sleep(30); return ago(new Date().toISOString()); });
  check('withClock 裡:凍住之後才寫進來的那一筆 → 剛剛,不講「時間對不上」', late === '剛剛', late);
  check('withClock 裡:真的在未來(時鐘被調過) → 照舊說對不上', withClock(() => ago(new Date(Date.now() + 60_000).toISOString())).includes('對不上'));
  // 同一個事件在同一次刷新印兩次:「現在」只取一次(withClock),隔 1.2 秒再問也一字不差;沒包的照舊走(魔鬼教官 2026-10-27 抓到)
  const ev = new Date(Date.now() - 5_000).toISOString();
  const frozen = withClock(() => { const a = ago(ev); sleep(1200); return [a, ago(ev)]; });
  check('withClock 裡:隔 1.2 秒再問,同一個事件同一句', frozen[0] === frozen[1] && /秒前$/.test(frozen[0]), frozen.join(' / '));
  const free = [ago(ev), (sleep(1200), ago(ev))];
  check('withClock 外:時間照舊會走(不是把時鐘停掉)', free[0] !== free[1], free.join(' / '));
  // 時鐘沒放開的話,這裡會拿 2.4 秒前凍住的那一刻算,講成 3 秒前
  const five = ago(new Date(Date.now() - 5_000).toISOString());
  check('withClock 結束之後時鐘放開', five === '5 秒前', five);
}

process.exit(summary());
