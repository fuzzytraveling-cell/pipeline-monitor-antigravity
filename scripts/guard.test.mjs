/**
 * guard.test.mjs —— 改檔前即時 force_ask 把關（guard.sh / guard.mjs）。
 * 規格:danger-guard-force-ask（路徑看 AGENTS.md 的表）
 *
 * 釘的是：
 *   1. 命中危險清單（單檔、資料夾舊檔、資料夾尚不存在的新檔）→ force_ask，reason 帶檔名、等級名與必跑關卡（不寫死 T2）
 *   2. 非命中（一般程式檔、文件、工作區外 /tmp、非 git、unset、off、空危險清單、退出記號、非改檔工具）與壞輸入 →
 *      嚴格 0 bytes 空輸出＋exit 0（階段 0 實測契約：絕不印 {} 也絕不印 "allow"）
 *   3. 跨 worktree、worktree 改主資料夾、跨專案改檔、相對路徑、符號連結、.agents/ 優先與 .claude/ 相容（P2/P13）
 *   4. 設定檔讀不懂（broken）→ force_ask 明講讀不懂（R1）；每次跑寫 _guard.json 心跳（P3）；寫 _sensor.jsonl（guard_broken）；
 *      寫 guard_asked（< 4096 bytes、無 hook／transcript 欄位、拒絕的子 agent 不會長假對話卡；logs 不可寫時仍照常 force_ask）
 *   5. 中英切換同步（英文零中文與全形空白，P2）
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync,
  symlinkSync, chmodSync, existsSync, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { real } from '../lib/git.mjs';
import { safeName, readEvents } from '../lib/events.mjs';
import { readFaults, faultState, guardHeartbeat } from '../lib/faults.mjs';
import { loadEvents } from '../lib/transcript.mjs';
import { sessionsOf, noRecordsWithin, lastRunPerStage, loadStages } from '../lib/rounds.mjs';
import { collectAll } from '../lib/collect.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { evaluate } = await import('../guard.mjs');
const { readLang, withLang } = await import('../lib/lang.mjs');

function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), 'pm-guard-home-'));
  const data = mkdtempSync(join(tmpdir(), 'pm-guard-data-'));
  const logDir = join(data, 'logs');
  mkdirSync(logDir, { recursive: true });
  const { ANTIGRAVITY_CONVERSATION_ID: _drop, ...rest } = process.env;
  const env = {
    ...rest,
    HOME: home,
    AGY_PIPELINE_HOME: data,
    AGY_PIPELINE_LOG_DIR: logDir,
    AGY_PIPELINE_CODE_HOME: ROOT,
  };
  const run = (payload, script = join(ROOT, 'guard.sh'), customEnv = env) => spawnSync(
    '/bin/sh',
    [script],
    {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env: customEnv,
      encoding: 'utf8',
    },
  );
  const cleanup = () => {
    for (const d of [home, data]) rmSync(d, { recursive: true, force: true });
  };
  return { home, data, logDir, env, run, cleanup };
}

function writeTierCfg(dir, obj, sub = '.agents') {
  mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, sub, 'pipeline-stages.json'), JSON.stringify(obj, null, 2));
}

section('AC-1：命中危險清單（單檔、資料夾舊檔、尚不存在的新檔、5 種寫改工具與 3 種路徑欄位）→ force_ask，不寫死 T2', 'P2');
{
  const e = makeEnv();
  const r = makeRepo({
    files: {
      'src/safe.js': '1\n',
      'core/db.js': '1\n',
      'vault/existing.js': '1\n',
      'README.md': '# hi\n',
    },
  });
  writeTierCfg(r.dir, {
    tiers: {
      code: ['src/', 'core/', 'vault/'],
      danger: ['core/db.js', 'vault/'],
      levels: {
        none: { id: 'L0', requires: [] },
        code: { id: 'L1', requires: ['D'] },
        danger: { id: 'L3', requires: ['A', 'C', 'D', 'tests'] },
      },
    },
  });

  // 5 種工具名 + 3 種路徑參數鍵
  const variants = [
    ['write_file', { Path: join(r.dir, 'core/db.js') }, 'core/db.js'],
    ['edit_file', { TargetFile: join(r.dir, 'vault/existing.js') }, 'vault/existing.js'],
    ['write_to_file', { AbsolutePath: join(r.dir, 'vault/brand-new/sub.js') }, 'vault/brand-new/sub.js'],
    ['replace_file_content', { TargetFile: 'core/db.js' }, 'core/db.js'],
    ['multi_replace_file_content', { Path: './vault/another-new.js' }, 'vault/another-new.js'],
  ];
  for (const [tool, args, expectedRel] of variants) {
    const out = e.run({ conversationId: 's1', cwd: r.dir, toolCall: { name: tool, args } });
    eq(`${tool} 命中 → exit 0`, out.status, 0);
    let parsed = null;
    try { parsed = JSON.parse(out.stdout); } catch { parsed = null; }
    check(`${tool} 回 decision=force_ask`, parsed?.decision === 'force_ask', out.stdout);
    check(`${tool} 的 reason 含檔名 ${expectedRel}、自訂等級 L3（不寫死 T2）與必跑關卡`,
      parsed?.reason?.includes(expectedRel)
      && parsed?.reason?.includes('L3')
      && !parsed?.reason?.includes('T2')
      && parsed?.reason?.includes('A 寫規格')
      && parsed?.reason?.includes('D 魔鬼教官')
      && parsed?.reason?.includes('補測試'),
      parsed?.reason);
  }

  r.cleanup();
  e.cleanup();
}

section('AC-2：非危險檔、文件、工作區外、非 git、unset、off、空危險清單、退出記號、非改檔工具 → 嚴格 0 bytes 空輸出＋exit 0（絕不回 allow 或 {}）', 'P2');
{
  const e = makeEnv();
  const r = makeRepo({ files: { 'src/safe.js': '1\n', 'core/db.js': '1\n', 'README.md': 'hi\n' } });
  writeTierCfg(r.dir, { tiers: { code: ['src/', 'core/'], danger: ['core/db.js'] } });

  const outsideTmp = join(tmpdir(), `pm-outside-${Date.now()}.txt`);
  const nonGit = mkdtempSync(join(tmpdir(), 'pm-nongit-'));
  writeFileSync(join(nonGit, 'a.js'), '1\n');

  const cases = [
    ['程式區非危險檔', { cwd: r.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(r.dir, 'src/safe.js') } } }],
    ['文件檔', { cwd: r.dir, toolCall: { name: 'write_file', args: { Path: join(r.dir, 'README.md') } } }],
    ['工作區外 /tmp 檔', { cwd: r.dir, toolCall: { name: 'write_file', args: { Path: outsideTmp } } }],
    ['非 git 資料夾', { cwd: nonGit, toolCall: { name: 'write_file', args: { Path: join(nonGit, 'a.js') } } }],
    ['非改檔工具 read_file', { cwd: r.dir, toolCall: { name: 'read_file', args: { Path: join(r.dir, 'core/db.js') } } }],
    ['終端機工具 run_command', { cwd: r.dir, toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }],
  ];
  for (const [label, payload] of cases) {
    const out = e.run(payload);
    eq(`${label}: exit 0`, out.status, 0);
    eq(`${label}: stdout 嚴格為 0 bytes 空字串`, out.stdout, '');
  }

  // 空危險清單 / tiers.off / unset / 退出記號 (.agents 與 .claude)
  const rEmpty = makeRepo({ files: { 'a.js': '1\n' } });
  writeTierCfg(rEmpty.dir, { tiers: { code: ['a.js'], danger: [] } });
  eq('空危險清單 → 0 bytes', e.run({ cwd: rEmpty.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(rEmpty.dir, 'a.js') } } }).stdout, '');

  const rOff = makeRepo({ files: { 'a.js': '1\n' } });
  writeTierCfg(rOff.dir, { tiers: { off: true } });
  eq('tiers.off → 0 bytes', e.run({ cwd: rOff.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(rOff.dir, 'a.js') } } }).stdout, '');

  const rUnset = makeRepo({ files: { 'a.js': '1\n' } });
  eq('未設分級 unset → 0 bytes', e.run({ cwd: rUnset.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(rUnset.dir, 'a.js') } } }).stdout, '');

  // 退出記號：.agents/pipeline-monitor.off 與 .claude/pipeline-monitor.off 都放行
  writeFileSync(join(r.dir, '.agents', 'pipeline-monitor.off'), '{}');
  eq('.agents/pipeline-monitor.off → 0 bytes', e.run({ cwd: r.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(r.dir, 'core/db.js') } } }).stdout, '');
  rmSync(join(r.dir, '.agents', 'pipeline-monitor.off'));
  mkdirSync(join(r.dir, '.claude'), { recursive: true });
  writeFileSync(join(r.dir, '.claude', 'pipeline-monitor.off'), '{}');
  eq('.claude/pipeline-monitor.off → 0 bytes', e.run({ cwd: r.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(r.dir, 'core/db.js') } } }).stdout, '');

  for (const d of [r, rEmpty, rOff, rUnset]) d.cleanup();
  rmSync(nonGit, { recursive: true, force: true });
  e.cleanup();
}

section('AC-3：跨 worktree、worktree 改主資料夾、跨專案、符號連結與 .agents/.claude 優先序（P2/P13）', 'P13');
{
  const e = makeEnv();
  const main = makeRepo({ files: { 'core/db.js': '1\n', 'src/a.js': '1\n' } });
  writeTierCfg(main.dir, { tiers: { code: ['src/', 'core/'], danger: ['core/db.js'] } });

  const wtParent = mkdtempSync(join(tmpdir(), 'pm-guard-wt-'));
  const wt = join(wtParent, 'wt1');
  execFileSync('git', ['-C', main.dir, 'worktree', 'add', '-q', '-b', 'feat', wt]);

  // 1. worktree 裡改自己的危險檔（從主資料夾繼承設定檔）
  const outWt = e.run({ cwd: wt, toolCall: { name: 'edit_file', args: { TargetFile: join(wt, 'core/db.js') } } });
  check('worktree 改危險檔（讀主資料夾設定）→ force_ask', JSON.parse(outWt.stdout || '{}').decision === 'force_ask', outWt.stdout);

  // 2. worktree 對話裡改主資料夾的危險檔
  const outCrossMain = e.run({ cwd: wt, toolCall: { name: 'edit_file', args: { TargetFile: join(main.dir, 'core/db.js') } } });
  check('worktree 裡改主資料夾的危險檔 → force_ask', JSON.parse(outCrossMain.stdout || '{}').decision === 'force_ask', outCrossMain.stdout);

  // 3. 跨專案：cwd 在 main，但修改專案 B 的檔案 → 查專案 B 自己的設定
  const projB = makeRepo({ files: { 'secret/key.js': '1\n' } });
  writeTierCfg(projB.dir, { tiers: { code: ['secret/'], danger: ['secret/key.js'] } }, '.claude');
  const outB = e.run({ cwd: main.dir, toolCall: { name: 'write_file', args: { Path: join(projB.dir, 'secret/key.js') } } });
  check('跨專案改專案 B（相容 .claude/ 設定）→ force_ask', JSON.parse(outB.stdout || '{}').decision === 'force_ask', outB.stdout);

  // 4. .agents/ 優先於 .claude/
  const projBoth = makeRepo({ files: { 'only-claude.js': '1\n', 'only-agents.js': '1\n' } });
  writeTierCfg(projBoth.dir, { tiers: { code: ['only-claude.js', 'only-agents.js'], danger: ['only-claude.js'] } }, '.claude');
  writeTierCfg(projBoth.dir, { tiers: { code: ['only-claude.js', 'only-agents.js'], danger: ['only-agents.js'] } }, '.agents');
  eq('.agents/ 優先：只列在 .claude/ 的不彈', e.run({ cwd: projBoth.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(projBoth.dir, 'only-claude.js') } } }).stdout, '');
  check('.agents/ 優先：列在 .agents/ 的必彈', JSON.parse(e.run({ cwd: projBoth.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(projBoth.dir, 'only-agents.js') } } }).stdout || '{}').decision === 'force_ask');

  // 5. 符號連結指向危險檔 → 照真實路徑認得出來
  const symDir = mkdtempSync(join(tmpdir(), 'pm-guard-sym-'));
  const symFile = join(symDir, 'alias-db.js');
  symlinkSync(join(main.dir, 'core/db.js'), symFile);
  const outSym = e.run({ cwd: symDir, toolCall: { name: 'edit_file', args: { TargetFile: symFile } } });
  check('透過符號連結修改危險檔 → force_ask', JSON.parse(outSym.stdout || '{}').decision === 'force_ask', outSym.stdout);

  // 6. 空字串 cwd 退回 workspacePaths[0]
  const outEmptyCwd = e.run({ cwd: '', workspacePaths: [main.dir], toolCall: { name: 'edit_file', args: { TargetFile: 'core/db.js' } } });
  check('空字串 cwd 退回 workspacePaths[0] → force_ask', JSON.parse(outEmptyCwd.stdout || '{}').decision === 'force_ask', outEmptyCwd.stdout);

  rmSync(symDir, { recursive: true, force: true });
  rmSync(wtParent, { recursive: true, force: true });
  main.cleanup();
  projB.cleanup();
  projBoth.cleanup();
  e.cleanup();
}

section('AC-4 & AC-5：設定檔讀不懂照問（R1）、壞輸入／缺 node 不鎖死、心跳與 guard_asked 紀錄（不含 hook 欄位）', 'P3');
{
  const e = makeEnv();
  const r = makeRepo({ files: { 'src/a.js': '1\n', 'core/db.js': '1\n' } });

  // 1. 設定檔格式壞掉 → force_ask 明講讀不懂
  mkdirSync(join(r.dir, '.agents'), { recursive: true });
  writeFileSync(join(r.dir, '.agents', 'pipeline-stages.json'), '{ 壞掉的 JSON');
  const outBroken = e.run({ conversationId: 's-brk', cwd: r.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(r.dir, 'src/a.js') } } });
  const parsedBroken = JSON.parse(outBroken.stdout || '{}');
  check('設定檔讀不懂 → force_ask 並講明讀不懂', parsedBroken.decision === 'force_ask' && /讀不懂/.test(parsedBroken.reason ?? ''), outBroken.stdout);

  // 2. 壞 JSON stdin → 0 bytes 放行（exit 0）＋ 寫 guard_broken 到 _sensor.jsonl
  const outBadIn = e.run('{壞掉的輸入');
  eq('壞 stdin → exit 0', outBadIn.status, 0);
  eq('壞 stdin → stdout 0 bytes', outBadIn.stdout, '');
  const sensorLines = readFileSync(join(e.logDir, '_sensor.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('壞 stdin → 記一筆 guard_broken 到 _sensor.jsonl', sensorLines.some((x) => x.event === 'guard_broken'), JSON.stringify(sensorLines));

  // 3. 找不到 node 時 guard.sh → 寫 guard_broken (why: 找不到 node) 並 0 bytes exit 0
  //    用只連 dirname/mkdir/date 的暫存 bin 當 PATH，不靠 /usr/bin 裡剛好沒有 node（P8：Linux／GitHub CI 常裝在 /usr/bin/node）
  const noNodeDir = mkdtempSync(join(tmpdir(), 'pm-guard-nonode-'));
  const fakeBin = join(noNodeDir, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  for (const cmd of ['dirname', 'mkdir', 'date']) {
    const src = ['/usr/bin', '/bin'].map((d) => join(d, cmd)).find((p) => existsSync(p));
    if (src) symlinkSync(src, join(fakeBin, cmd));
  }
  const fakeSh = join(noNodeDir, 'guard.sh');
  const origSh = readFileSync(join(ROOT, 'guard.sh'), 'utf8')
    .replace('/opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node', '/nonexistent/no-node-here');
  writeFileSync(fakeSh, origSh, { mode: 0o755 });
  const noNodeEnv = { ...e.env, PATH: fakeBin };
  const outNoNode = e.run({ cwd: r.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(r.dir, 'core/db.js') } } }, fakeSh, noNodeEnv);
  eq('缺 node → exit 0', outNoNode.status, 0);
  eq('缺 node → stdout 0 bytes', outNoNode.stdout, '');
  const sensor2 = readFileSync(join(e.logDir, '_sensor.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('缺 node → 記下 event=guard_broken why=找不到 node', sensor2.some((x) => x.event === 'guard_broken' && x.why === '找不到 node'), JSON.stringify(sensor2));
  rmSync(noNodeDir, { recursive: true, force: true });

  // 4. 正常設定 → 心跳 _guard.json 與 guard_asked 事件（用獨立 repo 避免與上面 s-brk 共用同一份 log）
  const rSub = makeRepo({ files: { 'core/db.js': '1\n' } });
  writeTierCfg(rSub.dir, { tiers: { code: ['core/'], danger: ['core/db.js'] } });
  const subTranscriptDir = mkdtempSync(join(tmpdir(), 'pm-guard-tr-'));
  const subTranscript = join(subTranscriptDir, 'transcript.jsonl');
  writeFileSync(subTranscript, [
    JSON.stringify({ step_index: 0, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', created_at: '2026-11-20T07:00:00Z', content: 'sender=main-conv-1' }),
  ].join('\n') + '\n');

  const outOk = e.run({
    conversationId: 'sub-conv-rejected',
    cwd: rSub.dir,
    transcriptPath: subTranscript,
    toolCall: { name: 'edit_file', args: { TargetFile: join(rSub.dir, 'core/db.js') } },
  });
  check('正常命中 → force_ask', JSON.parse(outOk.stdout || '{}').decision === 'force_ask');

  const hb = JSON.parse(readFileSync(join(e.logDir, '_guard.json'), 'utf8'));
  check('每次跑都寫心跳 logs/_guard.json（含 ts 與 cwd）', !!hb?.ts && hb?.cwd === rSub.dir, JSON.stringify(hb));

  const projLog = join(e.logDir, `${safeName(basename(rSub.dir))}.jsonl`);
  const logRaw = readFileSync(projLog, 'utf8').trim().split('\n');
  const asked = logRaw.map((l) => JSON.parse(l)).find((x) => x.event === 'guard_asked');
  check('guard_asked 記下目標 repo cwd、檔名、規則與等級，無 transcript 與 hook 欄位',
    asked?.source === 'guard' && asked?.cwd === real(rSub.dir)
    && asked?.file === 'core/db.js' && asked?.rule === 'core/db.js' && asked?.level === 'T2'
    && !('transcript' in asked) && !('hook' in asked),
    JSON.stringify(asked));
  check('guard_asked 單行小於 4096 bytes', Buffer.byteLength(logRaw.find((l) => l.includes('guard_asked')), 'utf8') < 4096);

  // 被拒絕的子 agent 只留 guard_asked（沒有 PostToolUse）時，enrichWithTranscripts + sessionsOf 絕不長出假對話卡
  const loaded = loadEvents(e.logDir, basename(rSub.dir), { home: e.home });
  eq('被拒絕的子 agent 經 loadEvents + sessionsOf 不長出假人類對話卡', sessionsOf(loaded.events).length, 0);

  // 5. logs 目錄不可寫時（唯讀）：仍照常輸出 force_ask，不因日誌寫失敗取消保護
  chmodSync(e.logDir, 0o500);
  const outRo = e.run({ conversationId: 's-ro', cwd: rSub.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(rSub.dir, 'core/db.js') } } });
  chmodSync(e.logDir, 0o700);
  check('logs 目錄不可寫時仍回 force_ask', JSON.parse(outRo.stdout || '{}').decision === 'force_ask', outRo.stdout);

  rmSync(subTranscriptDir, { recursive: true, force: true });
  rSub.cleanup();
  r.cleanup();
  e.cleanup();
}

section('AC-6：切換英文（lang.json）後 force_ask 理由全為英文、無中文與全形空白', 'P2');
{
  const e = makeEnv();
  const r = makeRepo({ files: { 'core/db.js': '1\n' } });
  writeTierCfg(r.dir, { tiers: { code: ['core/'], danger: ['core/db.js'] } });
  writeFileSync(join(e.data, 'lang.json'), JSON.stringify({ lang: 'en' }));

  const out = e.run({ conversationId: 's-en', cwd: r.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(r.dir, 'core/db.js') } } });
  const parsed = JSON.parse(out.stdout || '{}');
  check('英文模式回 force_ask', parsed.decision === 'force_ask', out.stdout);
  check('英文 reason 無中文與全形空白', !/[\u4e00-\u9fff\u3000]/.test(parsed.reason ?? ''), parsed.reason);
  check('英文 reason 含級別與檔名', parsed.reason.includes('core/db.js') && parsed.reason.includes('T2') && parsed.reason.includes('Chaos check'), parsed.reason);

  // 直接測 evaluate 在 withLang('en') 下的 config_broken 訊息也無中文
  mkdirSync(join(r.dir, '.agents'), { recursive: true });
  writeFileSync(join(r.dir, '.agents', 'pipeline-stages.json'), '{ broken');
  const enBroken = withLang('en', () => evaluate({
    payload: { cwd: r.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(r.dir, 'core/db.js') } } },
    monitorDir: ROOT,
  }));
  check('英文模式設定檔讀不懂 → force_ask 且無中文', enBroken?.decision === 'force_ask' && !/[\u4e00-\u9fff\u3000]/.test(enBroken.reason), enBroken?.reason);

  // 也確認 readLang 沒漏讀設定
  eq('lang.json 確為 en', readLang(e.data).lang, 'en');

  r.cleanup();
  e.cleanup();
}

section('魔鬼教官第 1 輪回歸測試：跨專案不污染、斷鏈符號連結不漏抓、僅 guard_asked 不誤判感測器有紀錄、缺 transcript 子 agent 不長假卡', 'P6');
{
  const e = makeEnv();
  mkdirSync(join(e.data, 'checkpoints'), { recursive: true });
  const collectIsolated = () => {
    const keep = {
      AGY_PIPELINE_HOME: process.env.AGY_PIPELINE_HOME,
      AGY_PIPELINE_LOG_DIR: process.env.AGY_PIPELINE_LOG_DIR,
      HOME: process.env.HOME,
    };
    Object.assign(process.env, { AGY_PIPELINE_HOME: e.data, AGY_PIPELINE_LOG_DIR: e.logDir, HOME: e.home });
    try {
      return collectAll({ monitorDir: ROOT, skillHome: e.home, home: e.home });
    } finally {
      for (const [k, v] of Object.entries(keep)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  // 1a. 跨專案（projA 改 projB 的危險檔）：projB.jsonl 的 cwd 記 projB 根目錄、不把 projA 或 transcript 拉進 projB
  const projA = makeRepo({ files: { 'a.js': '1\n' } });
  const projB = makeRepo({ files: { 'secret/key.js': '1\n' } });
  writeTierCfg(projB.dir, { tiers: { code: ['secret/'], danger: ['secret/key.js'] } });
  const realA = real(projA.dir);
  const realB = real(projB.dir);
  const trDir = mkdtempSync(join(tmpdir(), 'pm-guard-cross-tr-'));
  const trA = join(trDir, 'conv-a.jsonl');
  writeFileSync(trA, [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: new Date().toISOString(), content: '只有專案 A 看得到的秘辛' }),
  ].join('\n') + '\n');
  const logB = join(e.logDir, `${safeName(basename(projB.dir))}.jsonl`);
  writeFileSync(logB, JSON.stringify({
    ts: new Date(Date.now() - 60_000).toISOString(),
    hook: 'UserPromptSubmit',
    session: 'conv-b',
    cwd: realB,
    prompt: '專案 B 自己的對話',
  }) + '\n');

  const outCross = e.run({
    conversationId: 'conv-a',
    cwd: projA.dir,
    transcriptPath: trA,
    toolCall: { name: 'edit_file', args: { TargetFile: join(projB.dir, 'secret/key.js') } },
  });
  check('跨專案改危險檔 → force_ask', JSON.parse(outCross.stdout || '{}').decision === 'force_ask', outCross.stdout);
  const askedCross = readFileSync(logB, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.event === 'guard_asked');
  check('跨專案 guard_asked 記目標專案 cwd 與 caller_cwd，且不含 transcript/hook',
    askedCross?.cwd === realB && askedCross?.caller_cwd === realA && !('transcript' in askedCross) && !('hook' in askedCross),
    JSON.stringify(askedCross));

  const allCross = collectIsolated();
  const pB = allCross.projects.find((p) => p.name === safeName(basename(projB.dir)));
  check('跨專案：專案 B 存在且名稱沒被 projA 蓋掉', !!pB && pB.displayName === basename(projB.dir), pB?.displayName);
  eq('跨專案：專案 B 卡片只列 projB 工作區（不含 projA）', pB?.cards?.map((c) => c.path).join(','), realB);
  eq('跨專案：專案 B 對話只有 conv-b（不含 conv-a）', pB?.sessions?.map((s) => s.id).join(','), 'conv-b');
  check('跨專案：conv-a 的 transcript 內容絕不外洩到專案 B', !JSON.stringify(pB).includes('只有專案 A 看得到的秘辛'));

  // 1b. 非 git 資料夾（如 /tmp）改 projB2 的危險檔（且 projB2 無其他紀錄）：collectAll 不能被 notGit 整案隱藏
  const nonGitCaller = mkdtempSync(join(tmpdir(), 'pm-guard-tmpcaller-'));
  const projB2 = makeRepo({ files: { 'core/db.js': '1\n' } });
  writeTierCfg(projB2.dir, { tiers: { code: ['core/'], danger: ['core/db.js'] } });
  const realB2 = real(projB2.dir);
  const outFromTmp = e.run({
    conversationId: 'conv-tmp',
    cwd: nonGitCaller,
    toolCall: { name: 'write_file', args: { Path: join(projB2.dir, 'core/db.js') } },
  });
  check('非 git 目錄改 projB2 危險檔 → force_ask', JSON.parse(outFromTmp.stdout || '{}').decision === 'force_ask', outFromTmp.stdout);
  const allTmp = collectIsolated();
  const pB2 = allTmp.projects.find((p) => p.name === safeName(basename(projB2.dir)));
  check('非 git 目錄觸發 guard_asked 後專案 B2 仍列得出來（不變 notGit 被整案藏掉）、不長假對話、仍算 noRecords',
    !!pB2 && pB2.sessions.length === 0 && pB2.noRecords === true && pB2.cards.length === 0,
    JSON.stringify(pB2));

  // 2. 斷鏈符號連結（指向尚不存在的危險檔或危險資料夾）與符號連結循環
  const rSym = makeRepo({ files: { 'safe/keep.js': '1\n' } });
  mkdirSync(join(rSym.dir, 'vault'), { recursive: true });
  writeTierCfg(rSym.dir, { tiers: { code: ['safe/', 'core/', 'vault/'], danger: ['core/', 'vault/'] } });
  symlinkSync('../core/new-db.js', join(rSym.dir, 'safe/alias.js'));
  symlinkSync('../vault/newsub', join(rSym.dir, 'safe/linkdir'));
  symlinkSync('loop2', join(rSym.dir, 'safe/loop1'));
  symlinkSync('loop1', join(rSym.dir, 'safe/loop2'));

  const outDanglingFile = e.run({ cwd: rSym.dir, toolCall: { name: 'write_file', args: { Path: join(rSym.dir, 'safe/alias.js') } } });
  const pDanglingFile = JSON.parse(outDanglingFile.stdout || '{}');
  check('斷鏈檔案符號連結指向尚不存在的 core/new-db.js → force_ask 並顯示真實目標路徑',
    pDanglingFile.decision === 'force_ask' && pDanglingFile.reason?.includes('core/new-db.js'),
    outDanglingFile.stdout);

  const outDanglingDir = e.run({ cwd: rSym.dir, toolCall: { name: 'write_file', args: { Path: join(rSym.dir, 'safe/linkdir/secret.js') } } });
  const pDanglingDir = JSON.parse(outDanglingDir.stdout || '{}');
  check('斷鏈資料夾符號連結指向尚不存在的 vault/newsub/secret.js → force_ask 並顯示真實目標路徑',
    pDanglingDir.decision === 'force_ask' && pDanglingDir.reason?.includes('vault/newsub/secret.js'),
    outDanglingDir.stdout);

  const outLoop1 = e.run({ cwd: rSym.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(rSym.dir, 'safe/loop1') } } });
  const outLoop2 = e.run({ cwd: rSym.dir, toolCall: { name: 'write_file', args: { Path: join(rSym.dir, 'safe/loop1/x.js') } } });
  eq('符號連結循環（直指 loop1）不無窮迴圈，安全 exit 0 且 0 bytes', `${outLoop1.status}|${outLoop1.stdout}`, '0|');
  eq('符號連結循環（穿越 loop1/x.js）不無窮迴圈，安全 exit 0 且 0 bytes', `${outLoop2.status}|${outLoop2.stdout}`, '0|');

  // 3. 只有 guard_asked、沒有任何 hook 事件：noRecordsWithin 仍為 true，status.mjs 與同專案空 worktree 不誤判有感測器紀錄
  const rOnlyGuard = makeRepo({ files: { 'core/db.js': '1\n' } });
  writeTierCfg(rOnlyGuard.dir, { tiers: { code: ['core/'], danger: ['core/db.js'] } });
  const realOnly = real(rOnlyGuard.dir);
  const outOnly = e.run({ conversationId: 's-only-guard', cwd: rOnlyGuard.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(rOnlyGuard.dir, 'core/db.js') } } });
  check('只有 guard_asked 的專案觸發 force_ask', JSON.parse(outOnly.stdout || '{}').decision === 'force_ask', outOnly.stdout);
  const evOnly = readEvents(e.logDir, basename(rOnlyGuard.dir));
  eq('只有 guard_asked（無 hook 事件）時 noRecordsWithin 仍為 true', noRecordsWithin(evOnly), true);
  const stagesOnly = loadStages(ROOT, realOnly, realOnly).stages;
  eq('只有 guard_asked 時 lastRunPerStage.sawAnyEventHere 仍為 false', lastRunPerStage(evOnly.events, stagesOnly, realOnly).sawAnyEventHere, false);
  const cliOnly = execFileSync('node', [join(ROOT, 'status.mjs')], { cwd: rOnlyGuard.dir, encoding: 'utf8', env: e.env });
  check('只有 guard_asked 時 status.mjs 照實印「90 天內沒有任何對話紀錄」，不誤印「⚪ 這一輪還沒跑」',
    cliOnly.includes('90 天內沒有任何對話紀錄') && cliOnly.includes('所以不會說「五關都沒跑」') && !cliOnly.includes('這一輪還沒跑'),
    cliOnly);

  // 同一個專案：主資料夾有 hook 事件，但另一個 worktree B 只有 guard_asked → worktree B 的 sawAnyEventHere 仍為 false
  const wtParent = mkdtempSync(join(tmpdir(), 'pm-guard-wt-only-'));
  const wtB = join(wtParent, 'wtb');
  execFileSync('git', ['-C', rOnlyGuard.dir, 'worktree', 'add', '-q', '-b', 'wtb', wtB]);
  const realWtB = real(wtB);
  appendFileSync(join(e.logDir, `${safeName(basename(rOnlyGuard.dir))}.jsonl`), JSON.stringify({
    ts: new Date().toISOString(),
    hook: 'UserPromptSubmit',
    session: 's-main-hook',
    cwd: realOnly,
    prompt: '主工作區有 hook',
  }) + '\n');
  const outWtB = e.run({ conversationId: 's-wtb', cwd: wtB, toolCall: { name: 'edit_file', args: { TargetFile: join(wtB, 'core/db.js') } } });
  check('worktree B 觸發 guard_asked → force_ask', JSON.parse(outWtB.stdout || '{}').decision === 'force_ask', outWtB.stdout);
  const evWt = readEvents(e.logDir, basename(rOnlyGuard.dir));
  eq('主工作區有 hook、worktree B 僅有 guard_asked → worktree B 的 sawAnyEventHere 仍為 false',
    lastRunPerStage(evWt.events, stagesOnly, realWtB).sawAnyEventHere, false);

  // 4. 被拒絕的子 agent 完全沒給 transcriptPath，且場上已有真實人類對話 → 不長假對話卡、不誤標 sharesCwd
  const rNoTr = makeRepo({ files: { 'core/db.js': '1\n', 'src/a.js': '1\n' } });
  writeTierCfg(rNoTr.dir, { tiers: { code: ['src/', 'core/'], danger: ['core/db.js'] } });
  const realNoTr = real(rNoTr.dir);
  writeFileSync(join(e.logDir, `${safeName(basename(rNoTr.dir))}.jsonl`), JSON.stringify({
    ts: new Date(Date.now() - 30_000).toISOString(),
    hook: 'PostToolUse',
    tool: 'edit_file',
    session: 's-human',
    cwd: realNoTr,
    file: join(realNoTr, 'src/a.js'),
  }) + '\n');
  const outNoTr = e.run({
    conversationId: 'sub-no-tr',
    cwd: rNoTr.dir,
    toolCall: { name: 'edit_file', args: { TargetFile: join(rNoTr.dir, 'core/db.js') } },
  });
  check('無 transcriptPath 的子 agent 改危險檔仍回 force_ask', JSON.parse(outNoTr.stdout || '{}').decision === 'force_ask', outNoTr.stdout);
  const loadedNoTr = loadEvents(e.logDir, basename(rNoTr.dir), { home: e.home });
  const sessNoTr = sessionsOf(loadedNoTr.events);
  eq('無 transcriptPath 的 guard_asked 不長假對話卡，只剩 s-human', sessNoTr.map((s) => s.id).join(','), 's-human');
  eq('不因無 transcript 的 guard_asked 誤判成 sharesCwd', sessNoTr[0]?.sharesCwd, false);

  for (const d of [trDir, nonGitCaller, wtParent]) rmSync(d, { recursive: true, force: true });
  for (const r of [projA, projB, projB2, rSym, rOnlyGuard, rNoTr]) r.cleanup();
  e.cleanup();
}

section('魔鬼教官第 2 輪回歸測試：符號連結工作區配 ../ 不漏抓、guard_asked 失敗與心跳 cwd 口徑一致可恢復', 'P8');
{
  const e = makeEnv();
  const r = makeRepo({ files: { 'vault/sub/keep.js': '1\n', 'vault/secret.js': '1\n' } });
  writeTierCfg(r.dir, { tiers: { code: ['vault/'], danger: ['vault/'] } });

  // 1. 工作區 cwd 本身是符號連結（指向 repo 子資料夾）＋ 相對路徑 ../secret.js → 仍命中危險清單（P6/R1）
  const symHost = mkdtempSync(join(tmpdir(), 'pm-guard-symcwd-'));
  const symCwd = join(symHost, 'work');
  symlinkSync(join(r.dir, 'vault/sub'), symCwd);
  const outSymRel = e.run({ cwd: symCwd, toolCall: { name: 'edit_file', args: { TargetFile: '../secret.js' } } });
  const pSymRel = JSON.parse(outSymRel.stdout || '{}');
  check('符號連結工作區搭配相對路徑 ../secret.js → force_ask 並顯示真實目標 vault/secret.js',
    pSymRel.decision === 'force_ask' && pSymRel.reason?.includes('vault/secret.js'),
    outSymRel.stdout);

  // 2. 在子資料夾執行時 guard_asked 寫失敗（用同名目錄模擬 EISDIR），之後同子資料夾再跑 → guardError 應為 recovered（不是 unclear，P2/P11）
  const rErr = makeRepo({ files: { 'sub/keep.js': '1\n', 'core/db.js': '1\n' } });
  writeTierCfg(rErr.dir, { tiers: { code: ['sub/', 'core/'], danger: ['core/db.js'] } });
  const subCwd = join(rErr.dir, 'sub');
  const blockedLog = join(e.logDir, `${safeName(basename(rErr.dir))}.jsonl`);
  mkdirSync(blockedLog);
  const outFailLog = e.run({ conversationId: 's-err', cwd: subCwd, toolCall: { name: 'edit_file', args: { TargetFile: join(rErr.dir, 'core/db.js') } } });
  check('單一專案紀錄檔寫不了時仍照常 force_ask', JSON.parse(outFailLog.stdout || '{}').decision === 'force_ask', outFailLog.stdout);
  const errRec = readFaults(e.logDir).filter((x) => x.event === 'guard_broken').at(-1);
  eq('guard_asked 寫失敗記的 cwd 與 _guard.json 心跳一致（都是呼叫端 cwd）', errRec?.cwd, subCwd);

  rmSync(blockedLog, { recursive: true, force: true });
  // 確保下一次心跳時間嚴格晚於剛才的故障時間（即使在同一毫秒內）
  const beforeNext = Date.parse(errRec?.ts ?? '') || Date.now();
  while (Date.now() <= beforeNext) { /* 等 1ms */ }
  const outRecover = e.run({ conversationId: 's-err', cwd: subCwd, toolCall: { name: 'edit_file', args: { TargetFile: join(rErr.dir, 'core/db.js') } } });
  check('移除故障後同子資料夾再跑 → force_ask', JSON.parse(outRecover.stdout || '{}').decision === 'force_ask', outRecover.stdout);
  const fsNow = faultState({ faults: readFaults(e.logDir), guardHb: guardHeartbeat(e.logDir), retainDays: 90 });
  eq('子資料夾恢復後 guardError 轉為 recovered（不卡在 unclear 黃燈）', fsNow.guardError?.state, 'recovered');

  // 3. 恢復後再切到另一個專案（或 worktree）觸發 guard.sh → byCwd 同時保有兩者，不會讓 subCwd 復活成 unclear（P3）
  const rOther2 = makeRepo({ files: { 'x.js': '1\n' } });
  writeTierCfg(rOther2.dir, { tiers: { code: ['x.js'], danger: ['x.js'] } });
  const outOther2 = e.run({ conversationId: 's-other2', cwd: rOther2.dir, toolCall: { name: 'edit_file', args: { TargetFile: join(rOther2.dir, 'x.js') } } });
  check('切去別的專案照樣觸發 force_ask', JSON.parse(outOther2.stdout || '{}').decision === 'force_ask', outOther2.stdout);
  const hbAfter = guardHeartbeat(e.logDir);
  check('切去別的專案後 _guard.json 的 byCwd 同時保有原資料夾與新資料夾',
    Boolean(hbAfter?.byCwd?.[subCwd]) && Boolean(hbAfter?.byCwd?.[rOther2.dir]), JSON.stringify(hbAfter));
  eq('切去別的專案後重算 guardError 仍維持 recovered（不復活）',
    faultState({ faults: readFaults(e.logDir), guardHb: hbAfter, retainDays: 90 }).guardError?.state, 'recovered');

  rmSync(symHost, { recursive: true, force: true });
  r.cleanup();
  rErr.cleanup();
  rOther2.cleanup();
  e.cleanup();
}

process.exit(summary());
