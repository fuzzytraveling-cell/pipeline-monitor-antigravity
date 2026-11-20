/**
 * home.test.mjs —— Antigravity 版資料家目錄 ~/.pipeline-monitor-agy/ 隔離與權限測試。
 *
 * 釘四件會安靜壞掉的事：
 *   ① 家在哪：預設 ~/.pipeline-monitor-agy，絕不碰原版 ~/.pipeline-monitor，也不跟程式資料夾綁一起
 *   ② 感測器（hook.sh）跟 node（lib/paths.mjs）選同一個家，新建家權限 0700
 *   ③ 搬家提示與故障橫條路徑不寫死
 *   ④ _realdata.mjs 能同時監控 ~/.pipeline-monitor-agy 與原版 ~/.pipeline-monitor，任何測試漏給假家立刻紅
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';   // 排第一個：先換上假的家
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, symlinkSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { dataHome, dataDir, makeDataDir, moveState } from '../lib/paths.mjs';
import { moveLine, faultBanner, faultsNow } from '../lib/faults.mjs';
import { snapshot, compare } from './_realdata.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const mode = (p) => (statSync(p).mode & 0o777).toString(8);

section('家在哪：預設 ~/.pipeline-monitor-agy；測試一律用假的家（AGY_PIPELINE_HOME）', 'P8');
{
  const fake = process.env.AGY_PIPELINE_HOME;
  check('測試共用的那支給了假的家（不是這台電腦真的家）', !!fake && !fake.startsWith(join(homedir(), '.pipeline-monitor')), String(fake));
  eq('程式自己的資料夾 → 指定的家', dataHome(ROOT), fake);
  const plain = tmp('pm-plain-');
  eq('呼叫端給的暫存資料夾照用', dataHome(plain), plain);
  eq('Antigravity 版不搬舊資料，moveState 恆回 null', moveState(ROOT), null);
  check('紀錄跟章都落在假的家裡', dataDir('logs', ROOT).startsWith(fake) && dataDir('checkpoints', ROOT).startsWith(fake),
    `${dataDir('logs', ROOT)}／${dataDir('checkpoints', ROOT)}`);

  const keep = { home: process.env.AGY_PIPELINE_HOME, log: process.env.AGY_PIPELINE_LOG_DIR };
  delete process.env.AGY_PIPELINE_HOME;
  delete process.env.AGY_PIPELINE_LOG_DIR;
  try {
    eq('沒指定家 → 家目錄底下的 .pipeline-monitor-agy', dataHome(ROOT), join(homedir(), '.pipeline-monitor-agy'));
    process.env.AGY_PIPELINE_LOG_DIR = plain;
    eq('只指定 AGY_PIPELINE_LOG_DIR → logs 走該目錄', dataDir('logs', ROOT), plain);
  } finally {
    process.env.AGY_PIPELINE_HOME = keep.home;
    if (keep.log === undefined) delete process.env.AGY_PIPELINE_LOG_DIR; else process.env.AGY_PIPELINE_LOG_DIR = keep.log;
  }
  const freshDir = join(plain, 'sub');
  makeDataDir(freshDir);
  eq('makeDataDir 新建的資料夾權限 0700', mode(freshDir), '700');
  rmSync(plain, { recursive: true, force: true });
}

section('感測器（hook.sh）跟 node 選同一個家：新建家權限 0700、不碰原版 ~/.pipeline-monitor', 'P2');
{
  const target = makeRepo({ files: { 'b.js': '1\n' } });
  const project = basename(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: target.dir, encoding: 'utf8' }).trim());
  const fakeHome = tmp('pm-home-');
  const env = { ...process.env, HOME: fakeHome };
  delete env.AGY_PIPELINE_HOME;
  delete env.AGY_PIPELINE_LOG_DIR;

  const out = execFileSync('sh', [join(ROOT, 'hook.sh')], {
    input: JSON.stringify({
      conversationId: 'c1',
      cwd: target.dir,
      lastUserInput: '幫我改 b.js',
      toolCall: { id: 'tc1', name: 'edit_file', args: { Path: join(target.dir, 'b.js') } },
      stepIdx: 1,
    }),
    env,
    encoding: 'utf8',
  });
  eq('hook.sh 回傳 {}', out.trim(), '{}');
  const agyHome = join(fakeHome, '.pipeline-monitor-agy');
  eq('感測器寫在 ~/.pipeline-monitor-agy/logs/<專案>.jsonl', lines(join(agyHome, 'logs', `${project}.jsonl`)).length, 1);
  eq('感測器新建的家權限 0700', mode(agyHome), '700');
  check('完全沒建也沒有碰原版 ~/.pipeline-monitor', !existsSync(join(fakeHome, '.pipeline-monitor')));
  check('沒有在 repo 裡長出 logs/', !existsSync(join(ROOT, 'logs')));

  // 指定 AGY_PIPELINE_HOME 時跟著走
  const customHome = tmp('pm-custom-');
  execFileSync('sh', [join(ROOT, 'hook.sh')], {
    input: JSON.stringify({
      conversationId: 'c2',
      cwd: target.dir,
      lastUserInput: '第二次',
      toolCall: { id: 'tc2', name: 'write_file', args: { Path: join(target.dir, 'c.js') } },
      stepIdx: 2,
    }),
    env: { ...env, AGY_PIPELINE_HOME: customHome },
    encoding: 'utf8',
  });
  eq('有 AGY_PIPELINE_HOME → 寫到該家目錄', lines(join(customHome, 'logs', `${project}.jsonl`)).length, 1);

  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(customHome, { recursive: true, force: true });
  target.cleanup();
}

section('紅色橫條叫 AI 去看的地方，是這一次真的讀的那個資料夾（不寫死）', 'P3');
{
  const g = { gateError: { state: 'broken', last: Date.now(), count: 1 }, retainDays: 90 };
  const t = faultBanner({ ...g, logDir: join(homedir(), 'Desktop', 'pm', 'logs') })[0]?.text ?? '';
  check('講的是真的讀的那一個（~ 開頭）', t.includes('~/Desktop/pm/logs/_sensor.jsonl'), t);
  const u = faultBanner(g)[0]?.text ?? '';
  check('不知道讀的是哪裡 → 講「紀錄資料夾的」，不編一個路徑', u.includes('紀錄資料夾的 _sensor.jsonl') && !u.includes('~/.pipeline-monitor'), u);
}

section('還沒搬完的畫面提示（保留純函式相容）：不講成「沒有」；錯誤代號不上畫面', 'P5');
{
  const m = { from: join(homedir(), 'Desktop', 'pm'), to: join(homedir(), '.pipeline-monitor-agy'), kinds: ['logs'], why: 'EXDEV', both: false };
  const s = moveLine(m);
  check('講出還在舊的地方、照樣看得到', s.includes('還在舊的地方') && s.includes('看得到'), s);
  check('原因翻成白話，代號不上畫面', s.includes('不在同一顆磁碟') && !s.includes('EXDEV'), s);
  check('路徑用 ~ 開頭', s.includes('~/Desktop/pm') && s.includes('~/.pipeline-monitor-agy'), s);
  const b = moveLine({ ...m, why: null, both: true, kinds: ['logs', 'checkpoints'] });
  check('兩邊都有：講這裡看不到、沒有自動合併', b.includes('這裡看不到') && b.includes('沒有自動合併') && b.includes('紀錄與還原點'), b);
  eq('沒有要講的 → null', moveLine(null), null);
  const banner = faultBanner({ move: m });
  eq('上方橫條第一條就是它', banner[0]?.text, s);
  eq('黃色不是紅色', banner[0]?.tone, 'amber');
  const logDir = tmp('pm-log-');
  eq('faultsNow 把它帶出去給兩邊畫', faultsNow(logDir, { retainDays: 90, move: m }).move, m);
  eq('…沒有就是 null', faultsNow(logDir, { retainDays: 90 }).move, null);
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8').match(/^function projectList\(\) \{\n[\s\S]*?\n\}\n/m);
  check('從 ui/app.js 拿得出 projectList', !!src);
  if (src) {
    const list = (latest) => new Function('latest', `const zhEn = (zh) => zh; const many = (n, one, more = one + 's') => n + ' ' + (n === 1 ? one : more);\n${src[0]}; return projectList();`)(latest);
    const moving = list({ projects: [], faults: { moving: true } });
    check('還沒搬完 → 不准說「還沒有任何案件」', !moving.includes('還沒有任何案件') && moving.includes('還沒搬過來'), moving);
    check('真的沒有 → 照舊說還沒有任何案件', list({ projects: [], faults: { moving: false } }).includes('還沒有任何案件'));
  }
  rmSync(logDir, { recursive: true, force: true });
}

section('跑完全部測試那道檢查：同時守 ~/.pipeline-monitor-agy 與原版 ~/.pipeline-monitor', 'P8');
{
  const realHome = join(tmp('pm-h-'), '.pipeline-monitor-agy');
  const origHome = join(tmp('pm-orig-'), '.pipeline-monitor');
  const legacy = tmp('pm-old-');
  const elsewhere = tmp('pm-else-');
  const where = { realHome, legacy, extraHomes: [origHome] };
  for (const k of ['logs', 'checkpoints']) {
    mkdirSync(join(legacy, k));
    mkdirSync(join(realHome, k), { recursive: true });
    mkdirSync(join(origHome, k), { recursive: true });
    mkdirSync(join(elsewhere, k));
  }
  const before = snapshot(where);
  rmSync(join(legacy, 'logs'), { recursive: true });
  symlinkSync(join(realHome, 'logs'), join(legacy, 'logs'));
  eq('指向新家的捷徑 → 不算被搬走', compare(before, snapshot(where), where).movedAway.length, 0);
  rmSync(join(legacy, 'logs'));
  symlinkSync(join(elsewhere, 'logs'), join(legacy, 'logs'));
  eq('指向別處的捷徑 → 算被搬走', compare(before, snapshot(where), where).movedAway.join(), join(legacy, 'logs'));
  rmSync(join(legacy, 'checkpoints'), { recursive: true });
  check('不見了 → 算被搬走', compare(before, snapshot(where), where).movedAway.includes(join(legacy, 'checkpoints')));
  writeFileSync(join(realHome, 'logs', 'pm-test-x.jsonl'), '{}\n');
  writeFileSync(join(origHome, 'logs', 'pm-test-orig.jsonl'), '{}\n');
  const leaked = compare(before, snapshot(where), where).leaked;
  check('新版家與原版家漏進 pm- 測試檔都抓得到', leaked.includes(join(realHome, 'logs', 'pm-test-x.jsonl')) && leaked.includes(join(origHome, 'logs', 'pm-test-orig.jsonl')), leaked.join(', '));
  for (const d of [dirname(realHome), dirname(origHome), legacy, elsewhere]) rmSync(d, { recursive: true, force: true });
}

process.exit(summary());
