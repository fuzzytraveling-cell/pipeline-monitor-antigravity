/**
 * home.test.mjs —— 紀錄與章住在固定的家(規格:紀錄搬到固定的家,路徑看 CLAUDE.md 的表)。
 * 只釘會安靜壞掉的地方:
 *   ① 家在哪:跟程式住哪無關;測試一律用假的家,舊的地方(這台電腦真的紀錄)一律不碰(AC-1、AC-7)
 *   ② 選哪個資料夾的規則;感測器(sh)跟 node 選同一個(AC-2)
 *   ③ 搬家一筆不少、可以重跑、不覆蓋任何一份;新家只給自己讀寫(AC-3、AC-6)
 *   ④ 搬的那一刻正在寫的那一行也到新家——真的一邊密集寫、一邊搬(AC-4)
 *   ⑤ 還沒搬完時畫面講得出來,不講成「沒有」(AC-5)
 * ⚠️ 拿掉家的設定(讓 hook.sh 去看舊的地方)只准配「假的程式資料夾」:真的 hook.sh 的舊的地方是這台電腦真的紀錄。
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';   // 排第一個:它先換上假的家
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, lstatSync, readlinkSync, statSync, chmodSync, symlinkSync,
  renameSync, utimesSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { dataHome, legacyHome, dataDir, pickDir, moveData } from '../lib/paths.mjs';
import { moveLine, faultBanner, faultsNow } from '../lib/faults.mjs';
import { pathToFileURL } from 'node:url';
import { snapshot, compare } from './_realdata.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一個假的程式資料夾(放一份 hook.sh)、一個要被記的專案、一個假的家目錄。env 拿掉家的設定、假裝假的家目錄就是真的
 *  (PIPELINE_MONITOR_TEST_REAL_HOME):hook.sh 才會看「舊的地方」=這個假的程式資料夾。 */
function fakeProgram() {
  const prog = makeRepo({ files: { 'x.txt': '1\n' } });
  execFileSync('cp', [join(ROOT, 'hook.sh'), join(prog.dir, 'hook.sh')]);
  const target = makeRepo({ files: { 'b.js': '1\n' } });
  const project = basename(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: target.dir, encoding: 'utf8' }).trim());
  const fakeHome = tmp('pm-home-');
  const env = { ...process.env, HOME: fakeHome, PIPELINE_MONITOR_TEST_REAL_HOME: fakeHome };
  delete env.PIPELINE_MONITOR_HOME; delete env.PIPELINE_MONITOR_LOG_DIR;
  const home = join(fakeHome, '.pipeline-monitor');
  const say = (prompt, session = 's1') => execFileSync('sh', [join(prog.dir, 'hook.sh')], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: target.dir, prompt }), env, encoding: 'utf8' });
  const cleanup = () => { prog.cleanup(); target.cleanup(); rmSync(fakeHome, { recursive: true, force: true }); };
  return { prog: prog.dir, target: target.dir, project, fakeHome, home, env, say, cleanup };
}

section('家在哪:跟程式住哪無關;測試一律用假的家,舊的地方一律不碰', 'P8');
{
  const fake = process.env.PIPELINE_MONITOR_HOME;
  check('測試共用的那支給了假的家(不是這台電腦真的家)', !!fake && !fake.startsWith(join(homedir(), '.pipeline-monitor')), String(fake));
  eq('程式自己的資料夾 → 指定的家', dataHome(ROOT), fake);
  const plain = tmp('pm-plain-');
  eq('呼叫端給的資料夾(測試的暫存資料夾)照用', dataHome(plain), plain);
  check('有指定家 → 沒有舊家:真的紀錄一律不碰', legacyHome(ROOT) === null);
  check('紀錄跟章都落在假的家裡', dataDir('logs', ROOT).startsWith(fake) && dataDir('checkpoints', ROOT).startsWith(fake),
    `${dataDir('logs', ROOT)}／${dataDir('checkpoints', ROOT)}`);
  // 沒指定家時的預設。只看 dataHome / legacyHome(純計算),不叫 dataDir——那會去看真的舊地方、順手搬家
  const keep = { home: process.env.PIPELINE_MONITOR_HOME, log: process.env.PIPELINE_MONITOR_LOG_DIR };
  delete process.env.PIPELINE_MONITOR_HOME;
  try {
    eq('沒指定家 → 家目錄底下的 .pipeline-monitor', dataHome(ROOT), join(homedir(), '.pipeline-monitor'));
    process.env.PIPELINE_MONITOR_LOG_DIR = plain;
    check('只指定紀錄位置也算有人指定了 → 舊的地方不碰', legacyHome(ROOT) === null);
  } finally {
    process.env.PIPELINE_MONITOR_HOME = keep.home;
    if (keep.log === undefined) delete process.env.PIPELINE_MONITOR_LOG_DIR; else process.env.PIPELINE_MONITOR_LOG_DIR = keep.log;
  }
  rmSync(plain, { recursive: true, force: true });
}

section('規則:新家有就新家;還沒搬(舊的是真的資料夾)就照舊用舊的;搬過(舊的是捷徑)就新家');
{
  const home = join(tmp('pm-h-'), '.pipeline-monitor'), legacy = tmp('pm-old-');
  eq('兩邊都沒有 → 新家', pickDir({ kind: 'logs', home, legacy }), join(home, 'logs'));
  mkdirSync(join(legacy, 'logs'));
  eq('只有舊的(還沒搬)→ 舊的', pickDir({ kind: 'logs', home, legacy }), join(legacy, 'logs'));
  eq('沒有舊家 → 新家', pickDir({ kind: 'logs', home, legacy: null }), join(home, 'logs'));
  mkdirSync(join(home, 'logs'), { recursive: true });
  eq('兩邊都有 → 新家', pickDir({ kind: 'logs', home, legacy }), join(home, 'logs'));
  rmSync(join(legacy, 'logs'), { recursive: true });
  symlinkSync(join(home, 'logs'), join(legacy, 'logs'));
  eq('舊的是指向新家的捷徑(搬過了)→ 新家', pickDir({ kind: 'logs', home, legacy }), join(home, 'logs'));
  rmSync(join(home, 'logs'), { recursive: true });
  eq('捷徑指著已經不見的新家 → 新家(不回頭寫舊的)', pickDir({ kind: 'logs', home, legacy }), join(home, 'logs'));
}

section('感測器(sh)跟 node 選同一個地方:還沒搬、搬過、全新的電腦', 'P2');
{
  const f = fakeProgram();
  const file = (dir) => join(dir, `${f.project}.jsonl`);
  // 還沒搬:舊的地方有真的資料夾
  mkdirSync(join(f.prog, 'logs'));
  let expect = pickDir({ kind: 'logs', home: f.home, legacy: f.prog });
  f.say('還沒搬');
  eq('還沒搬:node 說舊的地方', expect, join(f.prog, 'logs'));
  eq('還沒搬:感測器也寫在舊的地方', lines(file(join(f.prog, 'logs'))).length, 1);
  check('還沒搬:新家沒有被建起來(不然就是兩邊各一半)', !existsSync(f.home));
  // 搬過:舊的位置是捷徑
  moveData({ from: f.prog, to: f.home });
  expect = pickDir({ kind: 'logs', home: f.home, legacy: f.prog });
  f.say('搬過');
  eq('搬過:node 說新家', expect, join(f.home, 'logs'));
  eq('搬過:感測器寫在新家(搬過去的那一筆加這一筆)', lines(file(join(f.home, 'logs'))).length, 2);
  f.cleanup();
  // 全新的電腦:兩邊都沒有
  const g = fakeProgram();
  eq('全新:node 說新家', pickDir({ kind: 'logs', home: g.home, legacy: g.prog }), join(g.home, 'logs'));
  g.say('全新');
  eq('全新:感測器寫在新家', lines(join(g.home, 'logs', `${g.project}.jsonl`)).length, 1);
  check('全新:程式的資料夾沒有長出 logs/', !existsSync(join(g.prog, 'logs')));
  eq('全新:感測器建的家只有自己讀寫得到(AC-6)', mode(g.home), '700');
  g.cleanup();
}

section('搬家:一筆不少、搬完舊的位置是捷徑、可以重跑;新家只給自己讀寫');
{
  const from = tmp('pm-old-'), to = join(tmp('pm-h-'), '.pipeline-monitor');
  mkdirSync(join(from, 'logs', 'reports'), { recursive: true });
  mkdirSync(join(from, 'checkpoints'));
  writeFileSync(join(from, 'logs', 'A.jsonl'), '{"n":1}\n{"n":2}\n');
  writeFileSync(join(from, 'logs', 'B.jsonl'), '{"n":3}\n');
  writeFileSync(join(from, 'logs', '_gate.json'), '{"ts":"x"}\n');
  writeFileSync(join(from, 'logs', 'reports', 'A__1__D.txt'), '很長的清單\n');
  for (const n of ['A__main.json', 'B__main.json', 'B__side.json']) writeFileSync(join(from, 'checkpoints', n), '{"at":"2026-10-01T00:00:00Z"}');
  const r = moveData({ from, to });
  eq('兩種都搬了', [...r.moved].sort().join(','), 'checkpoints,logs');
  eq('沒有搬不成的', r.pending.length, 0);
  eq('紀錄的行數跟搬之前一樣', lines(join(to, 'logs', 'A.jsonl')).length + lines(join(to, 'logs', 'B.jsonl')).length, 3);
  eq('章的個數跟搬之前一樣', readdirSync(join(to, 'checkpoints')).length, 3);
  check('收工 hook 的心跳、太長的清單也跟著搬', existsSync(join(to, 'logs', '_gate.json')) && existsSync(join(to, 'logs', 'reports', 'A__1__D.txt')));
  check('舊的位置是指向新家的捷徑(還在跑舊程式的服務照著它走)',
    lstatSync(join(from, 'logs')).isSymbolicLink() && readlinkSync(join(from, 'logs')) === join(to, 'logs'));
  eq('新建的家只有自己讀寫得到(AC-6)', mode(to), '700');
  const again = moveData({ from, to });
  eq('重跑:沒有東西要搬、也沒有搬不成的', again.moved.length + again.pending.length, 0);
  eq('重跑:行數沒有變多(不重複)', lines(join(to, 'logs', 'A.jsonl')).length + lines(join(to, 'logs', 'B.jsonl')).length, 3);
  // 已經存在的家:權限不動(那是使用者自己的決定)
  const to2 = tmp('pm-h-'), from2 = tmp('pm-old-');
  chmodSync(to2, 0o755);
  mkdirSync(join(from2, 'logs'));
  writeFileSync(join(from2, 'logs', 'C.jsonl'), '{}\n');
  moveData({ from: from2, to: to2 });
  eq('已經存在的家,權限照舊', mode(to2), '755');
  eq('…紀錄照樣搬過去', lines(join(to2, 'logs', 'C.jsonl')).length, 1);
}

section('兩邊都有(不該發生,除非有人手動放了東西):不覆蓋任何一份,留在原地的記下來給畫面講');
{
  const from = tmp('pm-old-'), to = tmp('pm-h-');
  for (const d of [from, to]) { mkdirSync(join(d, 'logs')); mkdirSync(join(d, 'checkpoints')); }
  writeFileSync(join(from, 'logs', 'X.jsonl'), '{"from":"old"}\n');
  writeFileSync(join(to, 'logs', 'X.jsonl'), '{"from":"new"}\n');
  writeFileSync(join(from, 'logs', 'Y.jsonl'), '{"y":1}\n');
  writeFileSync(join(from, 'checkpoints', 'P__main.json'), JSON.stringify({ at: '2026-10-20T00:00:00Z', which: 'old-but-newer' }));
  writeFileSync(join(to, 'checkpoints', 'P__main.json'), JSON.stringify({ at: '2026-10-01T00:00:00Z', which: 'new-but-older' }));
  const r = moveData({ from, to });
  check('新家沒有的搬過去了', existsSync(join(to, 'logs', 'Y.jsonl')) && !existsSync(join(from, 'logs', 'Y.jsonl')));
  eq('同名的紀錄兩份都在、各自沒被動',
    readFileSync(join(from, 'logs', 'X.jsonl'), 'utf8') + readFileSync(join(to, 'logs', 'X.jsonl'), 'utf8'), '{"from":"old"}\n{"from":"new"}\n');
  check('留在原地的記在回傳值裡', r.pending.some((p) => p.kind === 'logs' && p.why === 'both' && p.left.includes('X.jsonl')), JSON.stringify(r.pending));
  eq('同一顆章:留時間新的', JSON.parse(readFileSync(join(to, 'checkpoints', 'P__main.json'), 'utf8')).which, 'old-but-newer');
  const older = readdirSync(join(to, 'checkpoints')).find((n) => n.startsWith('P__main.json.older-'));
  check('舊的那顆改名留著(不以 .json 結尾,不會被當成一顆章)',
    !!older && JSON.parse(readFileSync(join(to, 'checkpoints', older), 'utf8')).which === 'new-but-older');
  check('章都處理完了 → 舊的位置變捷徑', lstatSync(join(from, 'checkpoints')).isSymbolicLink());
  check('紀錄還有留下的 → 舊的位置還是真的資料夾(沒有假裝搬完)', lstatSync(join(from, 'logs')).isDirectory() && !lstatSync(join(from, 'logs')).isSymbolicLink());
}

section('搬的那一刻正在寫:四個對話一邊密集寫、一邊搬,一筆不少、每個對話自己的先後不亂');
{
  const f = fakeProgram();
  const oldFile = join(f.prog, 'logs', `${f.project}.jsonl`);
  mkdirSync(join(f.prog, 'logs'));
  const SEED = 5, W = 4, N = 40;
  writeFileSync(oldFile, Array.from({ length: SEED }, (_, i) => JSON.stringify({ seed: i })).join('\n') + '\n');
  // 每個寫的人:同一個對話代號、提示編號 1..N 依序寫,跟真的感測器一樣一次叫一支 hook.sh
  const loop = `i=1; while [ $i -le ${N} ]; do printf '{"hook_event_name":"UserPromptSubmit","session_id":"w%s","cwd":"%s","prompt":"%s"}' "$W" "$T" "$i" | sh "$H"; i=$((i+1)); done`;
  const kids = Array.from({ length: W }, (_, w) =>
    spawn('sh', ['-c', loop], { env: { ...f.env, W: String(w), T: f.target, H: join(f.prog, 'hook.sh') }, stdio: 'ignore' }));
  const done = Promise.all(kids.map((k) => new Promise((r) => k.on('exit', r))));
  // 等舊的那一份長到一半再搬——要真的撞上「正在寫」,不然這一段什麼都沒測到
  const t0 = Date.now();
  while (lines(oldFile).length < SEED + (W * N) / 2 && Date.now() - t0 < 30000) await sleep(5);
  const atMove = lines(oldFile).length;
  const r = moveData({ from: f.prog, to: f.home });
  await done;
  check('搬的時候真的有人正在寫(不然這一段什麼都沒測到)', atMove > SEED && atMove < SEED + W * N, `搬的那一刻有 ${atMove} 行`);
  check('搬了:舊的位置變成指向新家的捷徑', r.moved.includes('logs') && lstatSync(join(f.prog, 'logs')).isSymbolicLink());
  const got = lines(join(f.home, 'logs', `${f.project}.jsonl`)).map((l) => JSON.parse(l));
  eq('一筆不少(搬之前的、搬的那一刻的、搬之後的)', got.length, SEED + W * N);
  const want = Array.from({ length: N }, (_, i) => String(i + 1)).join(',');
  const bad = Array.from({ length: W }, (_, w) => w).filter((w) => got.filter((e) => e.session === `w${w}`).map((e) => e.prompt).join(',') !== want);
  check('每個對話自己的先後沒亂(讀的人照檔案裡的先後算「最後一次」)', bad.length === 0, `亂掉的:${bad.join(',')}`);
  f.cleanup();
}

section('搬家那一刻的空檔:舊的資料夾剛改名、捷徑還沒放好,正要寫的那一筆重新選一次地方(不准掉)');
{
  // 上一段的密集寫入幾乎撞不到這個空檔(幾微秒),所以把時間停在這裡:hook.sh 先選好地方(舊的)、才去讀輸入——
  // 它在等輸入的時候,把舊的資料夾改名到新家、故意不放捷徑,再把輸入給它。它要寫的舊位置已經不在了。
  const f = fakeProgram();
  mkdirSync(join(f.prog, 'logs'));
  const kid = spawn('sh', [join(f.prog, 'hook.sh')], { env: f.env, stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise((r) => kid.on('exit', r));
  await sleep(500);   // 開 sh、選地方只要幾毫秒;之後它停在讀輸入
  mkdirSync(f.home, { recursive: true });
  renameSync(join(f.prog, 'logs'), join(f.home, 'logs'));   // 只改名、不放捷徑:就是那個空檔
  kid.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: f.target, prompt: '空檔裡的那一筆' }));
  eq('感測器照常結束(不出聲、不回錯)', await exited, 0);
  eq('那一筆寫進了新家', lines(join(f.home, 'logs', `${f.project}.jsonl`)).length, 1);
  check('舊的位置沒有被重新長出來(長出來就是兩邊各一半)', !existsSync(join(f.prog, 'logs')));
  f.cleanup();
}

section('家目錄被換掉了(測試、拿假的家目錄試一台全新的電腦):舊的地方一律不碰——不然真的紀錄會被搬進用完就丟的地方', 'P8');
{
  // node:不叫 dataDir(那會順手搬家),只看 legacyHome。家目錄是假的 → 沒有舊家
  const keep = { home: process.env.PIPELINE_MONITOR_HOME, HOME: process.env.HOME };
  const fakeHome = tmp('pm-home-');
  delete process.env.PIPELINE_MONITOR_HOME;
  process.env.HOME = fakeHome;
  try { check('node:家目錄是假的 → 不看舊的地方', legacyHome(ROOT) === null); }
  finally { process.env.PIPELINE_MONITOR_HOME = keep.home; process.env.HOME = keep.HOME; }
  rmSync(fakeHome, { recursive: true, force: true });
  // 感測器:假的程式資料夾有舊的 logs/,但沒假裝家目錄是真的 → 寫新家,舊的一筆都不多
  const f = fakeProgram();
  mkdirSync(join(f.prog, 'logs'));
  const env = { ...f.env }; delete env.PIPELINE_MONITOR_TEST_REAL_HOME;
  execFileSync('sh', [join(f.prog, 'hook.sh')], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: f.target, prompt: '假的家目錄' }), env, encoding: 'utf8' });
  eq('感測器:家目錄是假的 → 寫在新家', lines(join(f.home, 'logs', `${f.project}.jsonl`)).length, 1);
  eq('感測器:舊的地方一筆都沒多', readdirSync(join(f.prog, 'logs')).length, 0);
  f.cleanup();
}

section('同一刻只准一個程式搬:有人正在搬就不動;拿著鎖當掉的,一分鐘後收掉再搬');
{
  const make = () => {
    const from = tmp('pm-old-'), to = tmp('pm-h-');
    mkdirSync(join(from, 'checkpoints'));
    writeFileSync(join(from, 'checkpoints', 'P__main.json'), '{"at":"2026-10-01T00:00:00Z"}');
    return { from, to };
  };
  const a = make();
  mkdirSync(join(a.to, '.moving'));   // 別的程式剛拿了鎖
  const busy = moveData({ from: a.from, to: a.to });
  check('有人正在搬 → 這一次不動、講得出是因為別人在搬', busy.busy === true && busy.moved.length === 0 && lstatSync(join(a.from, 'checkpoints')).isDirectory());
  const b = make();
  mkdirSync(join(b.to, '.moving'));
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(join(b.to, '.moving'), old, old);   // 五分鐘前拿的鎖:拿著它的程式搬到一半當掉了
  const stale = moveData({ from: b.from, to: b.to });
  check('放了很久的鎖 → 收掉再搬', stale.moved.includes('checkpoints') && lstatSync(join(b.from, 'checkpoints')).isSymbolicLink());
  check('搬完把鎖收掉', !existsSync(join(b.to, '.moving')));
}

section('六個程式同一刻第一次搬家(魔鬼教官第一輪重現過:章全部被改名藏起來、收工 hook 的心跳不見)', 'P5');
{
  // 每一輪:六個程式各自等同一面旗子,旗子一出現就一起叫 moveData。真的開六個程式,不在同一個程式裡假裝
  const dir = tmp('pm-race-');
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, `import { moveData } from ${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'paths.mjs')).href)};
import { existsSync } from 'node:fs';
const [from, to, go] = process.argv.slice(2);
while (!existsSync(go)) { /* 等旗子 */ }
moveData({ from, to });
`);
  const ROUNDS = 12, K = 6, CPS = 10;
  const bad = [];
  for (let r = 0; r < ROUNDS; r++) {
    const base = tmp('pm-rd-');
    const from = join(base, 'old'), to = join(base, 'home', '.pipeline-monitor'), go = join(base, 'GO');
    mkdirSync(join(from, 'logs'), { recursive: true }); mkdirSync(join(from, 'checkpoints'));
    writeFileSync(join(from, 'logs', 'A.jsonl'), '{"n":1}\n');
    writeFileSync(join(from, 'logs', '_gate.json'), '{"ts":"x"}\n');
    for (let i = 0; i < CPS; i++) writeFileSync(join(from, 'checkpoints', `P${i}__main.json`), '{"at":"2026-10-01T00:00:00Z"}');
    const kids = Array.from({ length: K }, () => spawn(process.execPath, [worker, from, to, go], { stdio: 'ignore' }));
    const done = Promise.all(kids.map((k) => new Promise((res) => k.on('exit', res))));
    await sleep(200);
    writeFileSync(go, '1');
    await done;
    const cps = existsSync(join(to, 'checkpoints')) ? readdirSync(join(to, 'checkpoints')) : [];
    const live = cps.filter((n) => n.endsWith('.json')).length, hidden = cps.filter((n) => n.includes('.older-')).length;
    const gate = existsSync(join(to, 'logs', '_gate.json'));
    if (live !== CPS || hidden || !gate || !lstatSync(join(from, 'checkpoints')).isSymbolicLink()) bad.push(`第 ${r + 1} 輪:章 ${live} 顆、被藏起來 ${hidden} 顆、心跳${gate ? '在' : '不見'}`);
    rmSync(base, { recursive: true, force: true });
  }
  check(`${ROUNDS} 輪都一顆章不少、沒有被藏起來的、心跳還在`, bad.length === 0, bad.join('；'));
  rmSync(dir, { recursive: true, force: true });
}

section('搬完留在舊位置的捷徑,不准變成那個 repo「還沒存的檔」(退回這次以前的版本也一樣)', 'P3');
{
  const f = fakeProgram();   // 假的程式資料夾是一個 git repo,而且沒有 .gitignore——跟退回這次以前的版本一樣擋不住捷徑
  mkdirSync(join(f.prog, 'logs'));
  writeFileSync(join(f.prog, 'logs', 'A.jsonl'), '{"n":1}\n');
  moveData({ from: f.prog, to: f.home });
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: f.prog, encoding: 'utf8' }).split('\n').filter((l) => /logs|checkpoints/.test(l));
  eq('git 看不到那個捷徑(寫進了這台電腦自己的 .git/info/exclude)', dirty.join(' | '), '');
  moveData({ from: f.prog, to: f.home });
  eq('重跑不會一直往裡面加', readFileSync(join(f.prog, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === '/logs').length, 1);
  f.cleanup();
}

section('紅色橫條叫 Claude 去看的地方,是這一次真的讀的那個資料夾(不寫死)', 'P3');
{
  const g = { gateError: { state: 'broken', last: Date.now(), count: 1 }, retainDays: 90 };
  const t = faultBanner({ ...g, logDir: join(homedir(), 'Desktop', 'pm', 'logs') })[0]?.text ?? '';
  check('講的是真的讀的那一個(~ 開頭)', t.includes('~/Desktop/pm/logs/_sensor.jsonl'), t);
  const u = faultBanner(g)[0]?.text ?? '';
  check('不知道讀的是哪裡 → 講「紀錄資料夾的」,不編一個路徑', u.includes('紀錄資料夾的 _sensor.jsonl') && !u.includes('~/.pipeline-monitor'), u);
}

section('還沒搬完:畫面講得出來,不講成「沒有」;錯誤代號不上畫面', 'P5');
{
  const m = { from: join(homedir(), 'Desktop', 'pm'), to: join(homedir(), '.pipeline-monitor'), kinds: ['logs'], why: 'EXDEV', both: false };
  const s = moveLine(m);
  check('講出還在舊的地方、照樣看得到', s.includes('還在舊的地方') && s.includes('看得到'), s);
  check('原因翻成白話,代號不上畫面', s.includes('不在同一顆磁碟') && !s.includes('EXDEV'), s);
  check('路徑用 ~ 開頭', s.includes('~/Desktop/pm') && s.includes('~/.pipeline-monitor'), s);
  const b = moveLine({ ...m, why: null, both: true, kinds: ['logs', 'checkpoints'] });
  check('兩邊都有:講這裡看不到、沒有自動合併', b.includes('這裡看不到') && b.includes('沒有自動合併') && b.includes('紀錄與還原點'), b);
  eq('沒有要講的 → null', moveLine(null), null);
  const banner = faultBanner({ move: m });
  eq('上方橫條第一條就是它(終端機與儀表板同一句)', banner[0]?.text, s);
  eq('黃色不是紅色:紀錄還在,只是還沒搬', banner[0]?.tone, 'amber');
  const logDir = tmp('pm-log-');
  eq('faultsNow 把它帶出去給兩邊畫', faultsNow(logDir, { retainDays: 90, move: m }).move, m);
  eq('…沒有就是 null', faultsNow(logDir, { retainDays: 90 }).move, null);
  // 儀表板一個案件都沒有、但還沒搬完:照 ui/app.js 的 projectList 原封不動跑一次(L20:畫面的程式沒真的跑過就等於沒測)
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8').match(/^function projectList\(\) \{\n[\s\S]*?\n\}\n/m);
  check('從 ui/app.js 拿得出 projectList(拿不出來這一段就什麼都沒測到)', !!src);
  if (src) {
    const list = (latest) => new Function('latest', `const zhEn = (zh) => zh; const many = (n, one, more = one + 's') => n + ' ' + (n === 1 ? one : more);\n${src[0]}; return projectList();`)(latest);
    const moving = list({ projects: [], faults: { moving: true } });
    check('還沒搬完 → 不准說「還沒有任何案件」', !moving.includes('還沒有任何案件') && moving.includes('還沒搬過來'), moving);
    check('真的沒有 → 照舊說還沒有任何案件', list({ projects: [], faults: { moving: false } }).includes('還沒有任何案件'));
  }
  rmSync(logDir, { recursive: true, force: true });
}

section('跑完全部測試那道檢查:正常搬家不算「被測試搬走」;搬去別處、不見了、多出測試的檔才算', 'P8');
{
  // 合併那天,另一個對話剛好在跑測試的同時第一次搬家:舊的位置變成指向真的新家的捷徑——那不是測試搬走的,紅了就是狼來了
  const realHome = join(tmp('pm-h-'), '.pipeline-monitor'), legacy = tmp('pm-old-'), elsewhere = tmp('pm-else-');
  const where = { realHome, legacy };
  for (const k of ['logs', 'checkpoints']) { mkdirSync(join(legacy, k)); mkdirSync(join(realHome, k), { recursive: true }); mkdirSync(join(elsewhere, k)); }
  const before = snapshot(where);
  rmSync(join(legacy, 'logs'), { recursive: true });
  symlinkSync(join(realHome, 'logs'), join(legacy, 'logs'));
  eq('舊的位置變成指向真的新家的捷徑(正常搬家)→ 不算被搬走', compare(before, snapshot(where), where).movedAway.length, 0);
  rmSync(join(legacy, 'logs'));
  symlinkSync(join(elsewhere, 'logs'), join(legacy, 'logs'));
  eq('變成指向別處(測試的假家)的捷徑 → 算被搬走', compare(before, snapshot(where), where).movedAway.join(), join(legacy, 'logs'));
  rmSync(join(legacy, 'checkpoints'), { recursive: true });
  check('不見了 → 算被搬走', compare(before, snapshot(where), where).movedAway.includes(join(legacy, 'checkpoints')));
  writeFileSync(join(realHome, 'logs', 'pm-test-x.jsonl'), '{}\n');
  eq('真的紀錄裡多出測試的檔(pm- 開頭)→ 抓得到', compare(before, snapshot(where), where).leaked.join(), join(realHome, 'logs', 'pm-test-x.jsonl'));
  for (const d of [dirname(realHome), legacy, elsewhere]) rmSync(d, { recursive: true, force: true });
}

process.exit(summary());
