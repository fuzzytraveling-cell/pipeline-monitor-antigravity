/**
 * escalate.test.mjs —— 分級動態往上升級通知（PreInvocation：escalate.sh / escalate.mjs）與共用 pendingRequirements。
 * 規格:tier-escalation-notify（路徑看 AGENTS.md 的表）
 *
 * 釘的是：
 *   1. AC-1：改動危險檔（edit/新檔/git mv/run_command）、手動 --tier 調高、或兩者併發使分級升至最高級 →
 *      回傳純 {"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}（絕不帶 metadata.user_markdown），不寫死 T2；
 *      與 gate.mjs 共用 pendingRequirements（T1→T2 過期 D、no-report、found、unknown 不折成已具備）。
 *   2. AC-2：同輪去重、補跑 /spec 不二度洗版、新輪/新章/--tier-retract 同 cwd 重設（跨 worktree 不重設）、
 *      子目錄與 symlink ctx.root 對齊、inv=0 帶 extraTranscripts 換手隔離、force_ask 被拒／併入／T1／不設分級／全部完成不通知、
 *      subagent 過濾（真 ENOENT+空輸入與 step 0 sender= 放行，缺欄位或 EACCES 不吞人類通知）、SYSTEM_SDK 不混為人話、
 *      tier_notified 寫失敗略過注入防迴圈且不汙染 sessionsOf/collectAll/noRecordsWithin。
 *   3. AC-3 / AC-4：缺 node 自建 $LOGS 寫 escalate_broken、壞 JSON 心跳 _escalate.json、英文零中文且守住紅線禁用字。
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync,
  symlinkSync, existsSync, utimesSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { real } from '../lib/git.mjs';
import { safeName, readEvents } from '../lib/events.mjs';
import { readFaults, faultState, escalateHeartbeat } from '../lib/faults.mjs';
import { readTranscript, loadEvents, clearTranscriptCache } from '../lib/transcript.mjs';
import { sessionsOf, noRecordsWithin } from '../lib/rounds.mjs';
import { collectAll } from '../lib/collect.mjs';
import { pendingRequirements } from '../lib/tier.mjs';
import { decide } from '../gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).name;
const { evaluate, isPreInvocationSubagent } = await import('../escalate.mjs');
const { withLang } = await import('../lib/lang.mjs');

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const T = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString();
const MIN = 60;

function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), 'pm-esc-home-'));
  const data = mkdtempSync(join(tmpdir(), 'pm-esc-data-'));
  const logDir = join(data, 'logs');
  const cpDir = join(data, 'checkpoints');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(cpDir, { recursive: true });
  mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(ROOT, join(home, '.gemini', 'config', 'plugins', PLUGIN));
  const { ANTIGRAVITY_CONVERSATION_ID: _drop, ...rest } = process.env;
  const prev = { home: process.env.AGY_PIPELINE_HOME, log: process.env.AGY_PIPELINE_LOG_DIR, code: process.env.AGY_PIPELINE_CODE_HOME };
  process.env.AGY_PIPELINE_HOME = data;
  process.env.AGY_PIPELINE_LOG_DIR = logDir;
  process.env.AGY_PIPELINE_CODE_HOME = ROOT;
  const env = {
    ...rest,
    HOME: home,
    AGY_PIPELINE_HOME: data,
    AGY_PIPELINE_LOG_DIR: logDir,
    AGY_PIPELINE_CODE_HOME: ROOT,
  };
  const run = (payload, script = join(ROOT, 'escalate.sh'), customEnv = env) => spawnSync(
    '/bin/sh',
    [script],
    {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env: customEnv,
      encoding: 'utf8',
    },
  );
  const cleanup = () => {
    if (prev.home === undefined) delete process.env.AGY_PIPELINE_HOME; else process.env.AGY_PIPELINE_HOME = prev.home;
    if (prev.log === undefined) delete process.env.AGY_PIPELINE_LOG_DIR; else process.env.AGY_PIPELINE_LOG_DIR = prev.log;
    if (prev.code === undefined) delete process.env.AGY_PIPELINE_CODE_HOME; else process.env.AGY_PIPELINE_CODE_HOME = prev.code;
    for (const d of [home, data]) rmSync(d, { recursive: true, force: true });
  };
  return { home, data, logDir, cpDir, env, run, cleanup };
}

function writeTierCfg(dir, obj, sub = '.agents') {
  mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, sub, 'pipeline-stages.json'), JSON.stringify(obj, null, 2));
}

function writeLog(logDir, repoDir, events, extra = {}) {
  const root = real(repoDir);
  const proj = basename(root);
  const p = join(logDir, `${safeName(proj)}.jsonl`);
  const lines = events.map((o) => JSON.stringify({ cwd: root, ...extra, ...o }));
  writeFileSync(p, lines.join('\n') + (lines.length ? '\n' : ''));
  return p;
}

section('AC-1：改動危險檔、新檔、git mv、run_command、手動調高與兩者併發 → 注入純 systemMessage（無 user_markdown），不寫死 T2', 'P2');
{
  const e = makeEnv();
  const past = new Date(Date.now() - 4 * MIN * 1000);
  const r = makeRepo({
    files: { 'src/safe.js': '1\n', 'core/db.js': '1\n', 'vault/keep.js': '1\n', 'README.md': '# hi\n' },
    at: new Date(Date.now() - 20 * MIN * 1000),
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

  // 1. 經 sh escalate.sh 真實觸發（無規格且改動 core/db.js）
  writeFileSync(join(r.dir, 'core/db.js'), '2\n');
  utimesSync(join(r.dir, 'core/db.js'), past, past);
  writeLog(e.logDir, r.dir, [
    { ts: T(-5 * MIN), hook: 'UserPrompt', session: 's1', prompt: '先幫我改 core/db.js' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', session: 's1', tool: 'edit_file', file: join(real(r.dir), 'core/db.js') },
  ]);
  const res1 = e.run({
    conversationId: 's1',
    cwd: r.dir,
    lastUserInput: '先幫我改 core/db.js',
    invocationNum: 1,
  });
  eq('sh escalate.sh → exit 0', res1.status, 0);
  const parsed1 = JSON.parse(res1.stdout || '{}');
  const sm1 = parsed1.injectSteps?.[0]?.systemMessage;
  check('回傳純 injectSteps.systemMessage.systemMessage 且絕無 metadata/user_markdown',
    Array.isArray(parsed1.injectSteps) && parsed1.injectSteps.length === 1
    && typeof sm1?.systemMessage === 'string' && !('metadata' in (sm1 ?? {})),
    res1.stdout);
  check('通知寫明專案等級 L3（不寫死 T2）、命中檔名、缺項與先停下來問使用者補規格／--spec',
    sm1.systemMessage.includes('L3') && sm1.systemMessage.includes('core/db.js')
    && sm1.systemMessage.includes('補測試') && sm1.systemMessage.includes('先停下來') && sm1.systemMessage.includes('--spec'),
    sm1.systemMessage);

  const hb = escalateHeartbeat(e.logDir);
  check('每次跑寫下心跳 _escalate.json（含 ts 與 cwd）', !!hb?.ts && hb?.cwd === r.dir, JSON.stringify(hb));

  const evs1 = readEvents(e.logDir, basename(real(r.dir))).events;
  const tn1 = evs1.find((x) => x.event === 'tier_notified');
  check('寫入 tier_notified（source:escalate、無 hook 欄位、trigger:danger、hadSpec:false）',
    tn1?.source === 'escalate' && !('hook' in (tn1 ?? {})) && tn1?.trigger === 'danger' && tn1?.hadSpec === false && tn1?.level === 'L3',
    JSON.stringify(tn1));

  // 2. 危險資料夾底下新建未追蹤新檔（無 edit_file 事件也可）、git mv 危險檔、run_command 改檔
  git(r.dir, 'checkout', '-q', '--', 'core/db.js');
  writeFileSync(join(r.dir, 'vault/new-secret.js'), 's\n');
  writeLog(e.logDir, r.dir, [
    { ts: T(-5 * MIN), hook: 'UserPrompt', session: 's-new', prompt: '加新檔' },
  ]);
  const evalNew = evaluate({ payload: { conversationId: 's-new', cwd: r.dir, lastUserInput: '加新檔' }, monitorDir: ROOT, skillHome: e.home });
  check('危險資料夾內未追蹤新檔（無 edit_file）→ 觸發通知', evalNew?.trigger === 'danger' && evalNew?.files?.includes('vault/new-secret.js'), JSON.stringify(evalNew));

  rmSync(join(r.dir, 'vault/new-secret.js'));
  git(r.dir, 'mv', 'core/db.js', 'src/moved-db.js');
  const evalMv = evaluate({ payload: { conversationId: 's-mv', cwd: r.dir, lastUserInput: '搬家' }, monitorDir: ROOT, skillHome: e.home });
  check('git mv 搬走危險檔（P1）→ 照樣升至 L3 觸發通知', evalMv?.trigger === 'danger' && evalMv?.files?.includes('core/db.js'), JSON.stringify(evalMv));
  git(r.dir, 'reset', '-q', '--hard', 'HEAD');

  // 3. 一般程式區 + 手動 --tier L3（manual），以及 --spec 連結時不再叫 AI 問補規格
  writeFileSync(join(r.dir, 'src/safe.js'), '2\n');
  utimesSync(join(r.dir, 'src/safe.js'), past, past);
  mkdirSync(join(r.dir, 'docs'), { recursive: true });
  writeFileSync(join(r.dir, 'docs/spec-a.md'), '# spec\n');
  writeLog(e.logDir, r.dir, [
    { ts: T(-6 * MIN), hook: 'UserPrompt', session: 's-man', prompt: '照 docs/spec-a.md 做' },
    { ts: T(-5 * MIN), event: 'spec_link', session: 's-man', spec: 'docs/spec-a.md', source: 'ai' },
    { ts: T(-4 * MIN), event: 'tier_set', level: 'L3', why: '改了關鍵流程', source: 'human' },
    { ts: T(-3 * MIN), hook: 'PostToolUse', session: 's-man', tool: 'edit_file', file: join(real(r.dir), 'src/safe.js') },
  ]);
  const evalManual = evaluate({ payload: { conversationId: 's-man', cwd: r.dir, lastUserInput: '照做' }, monitorDir: ROOT, skillHome: e.home });
  check('手動 --tier L3 + 已有 --spec 連結 → trigger=manual，hadSpec=true，不重複要求 A 也不叫先停下來補規格',
    evalManual?.trigger === 'manual' && evalManual?.hadSpec === true && evalManual?.message?.includes('改了關鍵流程')
    && !evalManual?.message?.includes('先停下來告訴使用者這一輪已經升到'),
    evalManual?.message);

  // 4. 危險檔與手動調高同時存在時，機器已達最高級 → trigger=danger（與 buildTier manualIgnored 一致）
  writeFileSync(join(r.dir, 'core/db.js'), '3\n');
  const evalBoth = evaluate({ payload: { conversationId: 's-man', cwd: r.dir, lastUserInput: '兩者' }, monitorDir: ROOT, skillHome: e.home });
  eq('同時命中危險檔與手動調高 → trigger=danger', evalBoth?.trigger, 'danger');

  r.cleanup();
  e.cleanup();
}

section('預審 #1：與 gate.mjs 共用 pendingRequirements——T1→T2 過期 D、no-report、found、unknown 不折成已具備', 'P2');
{
  const e = makeEnv();
  const past4 = new Date(Date.now() - 4 * MIN * 1000);
  const past2 = new Date(Date.now() - 2 * MIN * 1000);
  const r = makeRepo({
    files: { 'src/a.js': '1\n', 'core/db.js': '1\n', 'docs/s.md': '# s\n' },
    at: new Date(Date.now() - 30 * MIN * 1000),
  });
  writeTierCfg(r.dir, { tiers: { code: ['src/', 'core/'], danger: ['core/db.js'] } });
  const root = real(r.dir);

  // 先改 src/a.js → 跑完 A/C/D（T1 時代 D 記 ok），之後改了 core/db.js → D 過期成 ask、tests=0
  writeFileSync(join(root, 'src/a.js'), '2\n');
  utimesSync(join(root, 'src/a.js'), past4, past4);
  writeFileSync(join(root, 'core/db.js'), '2\n');
  utimesSync(join(root, 'core/db.js'), past2, past2);
  writeLog(e.logDir, root, [
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's1', prompt: '做功能' },
    { ts: T(-9 * MIN), event: 'spec_link', session: 's1', spec: 'docs/s.md', source: 'ai' },
    { ts: T(-8 * MIN), hook: 'PostToolUse', session: 's1', tool: 'read_file', skill: `${PLUGIN}:cleanup`, file: '/p/skills/cleanup/SKILL.md' },
    { ts: T(-7 * MIN), event: 'stage_report', stage: 'C', verdict: 'ok', by_session: 's1', source: 'ai' },
    { ts: T(-6 * MIN), hook: 'PostToolUse', session: 's1', tool: 'read_file', skill: `${PLUGIN}:chaos-check`, file: '/p/skills/chaos-check/SKILL.md' },
    { ts: T(-5 * MIN), event: 'stage_report', stage: 'D', verdict: 'ok', by_session: 's1', source: 'ai' },
    { ts: T(-2 * MIN), hook: 'PostToolUse', session: 's1', tool: 'edit_file', file: join(root, 'core/db.js') },
  ]);
  const evAsk = evaluate({ payload: { conversationId: 's1', cwd: root, lastUserInput: '繼續' }, monitorDir: ROOT, skillHome: e.home });
  const gateAsk = decide({ payload: { conversationId: 's1', cwd: root, executionNum: 0, continuationActive: false, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }, monitorDir: ROOT, skillHome: e.home });
  check('T1 跑過 D 後改危險檔升 T2 → D 變成 ask，escalate 與 gate 同時列出 D（先停下來問使用者）與補測試',
    evAsk?.message?.includes('魔鬼教官') && evAsk?.message?.includes('先停下來問使用者') && evAsk?.message?.includes('補測試')
    && gateAsk?.missing?.includes('D:ask') && gateAsk?.missing?.includes('tests'),
    `esc=${evAsk?.message}\ngate=${JSON.stringify(gateAsk?.missing)}`);

  // D 跑完卻是 found、C 是 found、補測試補上時 → escalate 仍列出 found、不靜默放行
  writeFileSync(join(root, 'src/a.test.js'), 't\n');
  utimesSync(join(root, 'src/a.test.js'), past2, past2);
  writeLog(e.logDir, root, [
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's1', prompt: '做功能' },
    { ts: T(-9 * MIN), event: 'spec_link', session: 's1', spec: 'docs/s.md', source: 'ai' },
    { ts: T(-8 * MIN), hook: 'PostToolUse', session: 's1', tool: 'read_file', skill: `${PLUGIN}:cleanup`, file: '/p/skills/cleanup/SKILL.md' },
    { ts: T(-7 * MIN), event: 'stage_report', stage: 'C', verdict: 'found', note: '有死碼', by_session: 's1', source: 'ai' },
    { ts: T(-2 * MIN), hook: 'PostToolUse', session: 's1', tool: 'edit_file', file: join(root, 'core/db.js') },
    { ts: T(-1 * MIN), hook: 'PostToolUse', session: 's1', tool: 'read_file', skill: `${PLUGIN}:chaos-check`, file: '/p/skills/chaos-check/SKILL.md' },
    { ts: T(-30), event: 'stage_report', stage: 'D', verdict: 'found', note: '有問題', by_session: 's1', source: 'ai' },
  ]);
  const evFound = evaluate({ payload: { conversationId: 's1', cwd: root, lastUserInput: '繼續' }, monitorDir: ROOT, skillHome: e.home });
  check('C 與 D 皆為 found 未結案 → 不把「跑過」當「已具備」，照樣通知並標出找到問題還沒處理完',
    evFound?.message?.includes('打掃') && evFound?.message?.includes('魔鬼教官') && evFound?.message?.includes('還沒處理完'),
    evFound?.message);

  // A 連結、C ok、D ok、測試檔也有 → 全部確實具備 → 安靜放行
  writeLog(e.logDir, root, [
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's1', prompt: '做功能' },
    { ts: T(-9 * MIN), event: 'spec_link', session: 's1', spec: 'docs/s.md', source: 'ai' },
    { ts: T(-8 * MIN), hook: 'PostToolUse', session: 's1', tool: 'read_file', skill: `${PLUGIN}:cleanup`, file: '/p/skills/cleanup/SKILL.md' },
    { ts: T(-7 * MIN), event: 'stage_report', stage: 'C', verdict: 'ok', by_session: 's1', source: 'ai' },
    { ts: T(-2 * MIN), hook: 'PostToolUse', session: 's1', tool: 'edit_file', file: join(root, 'core/db.js') },
    { ts: T(-1 * MIN), hook: 'PostToolUse', session: 's1', tool: 'read_file', skill: `${PLUGIN}:chaos-check`, file: '/p/skills/chaos-check/SKILL.md' },
    { ts: T(-30), event: 'stage_report', stage: 'D', verdict: 'ok', by_session: 's1', source: 'ai' },
  ]);
  eq('A/C/D/測試檔全部確實具備 → null（輸出 {}）',
    evaluate({ payload: { conversationId: 's1', cwd: root, lastUserInput: '繼續' }, monitorDir: ROOT, skillHome: e.home }), null);

  // 4. pendingRequirements 對 touchedTests:null 與 spec.unsure 不折成已具備（R1）
  const unkPending = pendingRequirements({
    requires: ['A', 'tests'],
    stages: [{ id: 'A', name: '寫規格', skill: 'spec' }],
    view: [{ id: 'A', name: '寫規格', skill: 'spec', unsure: { name: 'foo' } }],
    health: { touchedTests: null },
    commandFor: () => '/agy-pipeline:spec',
  });
  check('pendingRequirements：spec.unsure 與 touchedTests:null 均維持 status=unknown，不折成已具備（R1）',
    unkPending.length === 2 && unkPending.every((x) => x.status === 'unknown'),
    JSON.stringify(unkPending));

  r.cleanup();
  e.cleanup();
}

section('不該通知的一律安靜（{}）：force_ask 被拒、main 併入（P12）、T0/T1、unset/off/broken/退出/非 git', 'P12');
{
  const e = makeEnv();
  const past = new Date(Date.now() - 4 * MIN * 1000);
  const r = makeRepo({ files: { 'src/a.js': '1\n', 'core/db.js': '1\n', 'README.md': '# hi\n' } });
  const root = real(r.dir);
  const baseBranch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  writeTierCfg(root, { tiers: { code: ['src/', 'core/'], danger: ['core/db.js'] } });

  // 1. force_ask 被使用者拒絕：只有 guard_asked、檔案未動
  writeLog(e.logDir, root, [
    { ts: T(-5 * MIN), hook: 'UserPrompt', session: 's1', prompt: '試改' },
    { ts: T(-4 * MIN), event: 'guard_asked', kind: 'danger', session: 's1', file: 'core/db.js', level: 'T2', source: 'guard' },
  ]);
  eq('force_ask 被拒、檔案未改 → null', evaluate({ payload: { conversationId: 's1', cwd: root, lastUserInput: '試改' }, monitorDir: ROOT, skillHome: e.home }), null);

  // 2. 只改文件（T0）與一般程式檔（T1）→ null
  writeFileSync(join(root, 'README.md'), '# hi 2\n');
  eq('T0（只改文件）→ null', evaluate({ payload: { conversationId: 's1', cwd: root, lastUserInput: '改文件' }, monitorDir: ROOT, skillHome: e.home }), null);
  git(root, 'checkout', '-q', '--', 'README.md');
  writeFileSync(join(root, 'src/a.js'), '2\n');
  eq('T1（只改一般程式檔）→ null', evaluate({ payload: { conversationId: 's1', cwd: root, lastUserInput: '改程式' }, monitorDir: ROOT, skillHome: e.home }), null);
  git(root, 'checkout', '-q', '--', 'src/a.js');

  // 3. 從 main 併入的危險檔、本對話沒改過 → null（P12，用真 worktree 模擬）
  const rMain = makeRepo({ at: T(-120 * MIN), files: { 'src/a.js': '1\n', 'core/db.js': '1\n', 'README.md': '# hi\n' } });
  const mainRoot = real(rMain.dir);
  const wtHost = mkdtempSync(join(tmpdir(), 'pm-esc-wt-'));
  const wtDir = join(wtHost, 'wt');
  const gitAt = (dir, sec, ...a) => execFileSync('git', a, {
    cwd: dir, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: T(sec), GIT_COMMITTER_DATE: T(sec) },
  });
  gitAt(mainRoot, -110 * MIN, 'worktree', 'add', '-q', '-b', 'feat', wtDir);
  const wt = real(wtDir);
  writeTierCfg(wt, { tiers: { code: ['src/', 'core/'], danger: ['core/db.js'] } });
  writeLog(e.logDir, mainRoot, [
    { ts: T(-30 * MIN), cwd: wt, hook: 'UserPrompt', session: 's-merge', prompt: '在 worktree 開始' },
  ]);
  writeFileSync(join(mainRoot, 'core/db.js'), 'from-main\n');
  gitAt(mainRoot, -10 * MIN, 'add', 'core/db.js');
  gitAt(mainRoot, -10 * MIN, 'commit', '-q', '-m', 'main touched danger');
  gitAt(wt, -5 * MIN, 'merge', '-q', '--ff-only', git(mainRoot, 'rev-parse', '--abbrev-ref', 'HEAD'));
  eq('快轉從 main 併入的危險檔、本對話沒動過 → null（P12）',
    evaluate({ payload: { conversationId: 's-merge', cwd: wt, lastUserInput: '併完' }, monitorDir: ROOT, skillHome: e.home }), null);
  try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: mainRoot, stdio: 'ignore' }); } catch {}
  rmSync(wtHost, { recursive: true, force: true });
  rMain.cleanup();

  // 4. 退出、unset、off、broken、非 git → null
  writeFileSync(join(root, 'core/db.js'), 'edited\n');
  utimesSync(join(root, 'core/db.js'), past, past);
  writeFileSync(join(root, '.agents/pipeline-monitor.off'), JSON.stringify({ at: T(-1) }));
  eq('已退出記錄 → null', evaluate({ payload: { conversationId: 's-off', cwd: root, lastUserInput: 'x' }, monitorDir: ROOT, skillHome: e.home }), null);
  rmSync(join(root, '.agents/pipeline-monitor.off'));

  writeTierCfg(root, { tiers: { off: true } });
  eq('tiers.off → null', evaluate({ payload: { conversationId: 's-off', cwd: root, lastUserInput: 'x' }, monitorDir: ROOT, skillHome: e.home }), null);
  writeTierCfg(root, {});
  eq('unset → null', evaluate({ payload: { conversationId: 's-off', cwd: root, lastUserInput: 'x' }, monitorDir: ROOT, skillHome: e.home }), null);
  writeFileSync(join(root, '.agents/pipeline-stages.json'), '{ bad');
  eq('broken 設定檔 → null', evaluate({ payload: { conversationId: 's-off', cwd: root, lastUserInput: 'x' }, monitorDir: ROOT, skillHome: e.home }), null);

  const nonGit = mkdtempSync(join(tmpdir(), 'pm-esc-nongit-'));
  eq('非 git 資料夾 → null', evaluate({ payload: { conversationId: 's-ng', cwd: nonGit, lastUserInput: 'x' }, monitorDir: ROOT, skillHome: e.home }), null);
  rmSync(nonGit, { recursive: true, force: true });

  r.cleanup();
  e.cleanup();
}

section('預審 #2/#3/#4：去重、依通知補寫 /spec 不二度洗版、--tier-retract 同 cwd 重設、子目錄與 symlink ctx.root、inv=0 換手隔離', 'P6');
{
  const e = makeEnv();
  const past = new Date(Date.now() - 4 * MIN * 1000);
  const r = makeRepo({ files: { 'sub/keep.js': '1\n', 'core/db.js': '1\n', 'vault/k.js': '1\n' }, at: new Date(Date.now() - 30 * MIN * 1000) });
  const root = real(r.dir);
  writeTierCfg(root, { tiers: { code: ['sub/', 'core/', 'vault/'], danger: ['core/db.js', 'vault/'] } });

  // 1. 同輪去重＋緊接著依通知跑 /spec 不二度洗版（預審 #3）
  writeFileSync(join(root, 'core/db.js'), '2\n');
  utimesSync(join(root, 'core/db.js'), past, past);
  const logPath = writeLog(e.logDir, root, [
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's1', prompt: '先改 core/db.js' },
    { ts: T(-9 * MIN), hook: 'PostToolUse', session: 's1', tool: 'edit_file', file: join(root, 'core/db.js') },
  ]);
  const resA = e.run({ conversationId: 's1', cwd: root, lastUserInput: '先改', invocationNum: 0 });
  check('第一次升 T2 → 注入通知', !!JSON.parse(resA.stdout || '{}').injectSteps?.length);
  const resB = e.run({ conversationId: 's1', cwd: root, lastUserInput: '先改', invocationNum: 1 });
  eq('同輪下一步（inv=1）→ 回 {} 不洗版', resB.stdout.trim(), '{}');

  // AI 照通知啟動 /spec（origin.at 被推進到 A.ts），期間未再改新危險檔 → 不在寫規格中途二度注入
  appendFileSync(logPath, JSON.stringify({
    ts: T(5), hook: 'PostToolUse', cwd: root, session: 's1', tool: 'read_file', skill: `${PLUGIN}:spec`, file: '/p/skills/spec/SKILL.md',
  }) + '\n');
  eq('依通知啟動 /spec 推進 origin.at 到 A → 不於 /spec 中途二度洗版',
    evaluate({ payload: { conversationId: 's1', cwd: root, lastUserInput: '好我來補規格' }, monitorDir: ROOT, skillHome: e.home }), null);

  // 2. 第二次開啟新一輪 /spec（中間有新的人話，a2 在 a1 之後，不與 a1 合併）→ 重設去重、通知新一輪
  appendFileSync(logPath, JSON.stringify({
    ts: T(12), hook: 'UserPrompt', cwd: root, session: 's1', prompt: '再開第二輪新規格',
  }) + '\n');
  appendFileSync(logPath, JSON.stringify({
    ts: T(20), hook: 'PostToolUse', cwd: root, session: 's1', tool: 'read_file', skill: `${PLUGIN}:spec`, file: '/p/skills/spec/SKILL.md',
  }) + '\n');
  const afterSecondA = evaluate({ payload: { conversationId: 's1', cwd: root, lastUserInput: '開第二輪規格' }, monitorDir: ROOT, skillHome: e.home });
  check('開第二輪 /spec（a2 > a1）→ 重設去重並通知新一輪', !!afterSecondA?.message, String(afterSecondA));

  // 3. 子目錄與 symlink cwd 解析成真實 git root，且對得到 --tier / --tier-retract（預審 #4，P13）
  const rSub = makeRepo({ files: { 'sub/keep.js': '1\n', 'core/db.js': '1\n' }, at: new Date(Date.now() - 30 * MIN * 1000) });
  const subRoot = real(rSub.dir);
  writeTierCfg(subRoot, { tiers: { code: ['sub/', 'core/'], danger: ['core/db.js'] } });
  const symHost = mkdtempSync(join(tmpdir(), 'pm-esc-sym-'));
  const symSub = join(symHost, 'sublink');
  symlinkSync(join(subRoot, 'sub'), symSub);
  writeFileSync(join(subRoot, 'sub/keep.js'), '2\n');
  utimesSync(join(subRoot, 'sub/keep.js'), past, past);
  const subLog = writeLog(e.logDir, subRoot, [
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's-sub', cwd: symSub, prompt: '在子目錄做' },
    { ts: T(-8 * MIN), event: 'tier_set', level: 'T2', why: '子目錄也要高標準', source: 'human' },
    { ts: T(-7 * MIN), hook: 'PostToolUse', session: 's-sub', cwd: symSub, tool: 'edit_file', file: join(symSub, 'keep.js') },
  ]);
  const resSym = e.run({ conversationId: 's-sub', cwd: symSub, lastUserInput: '繼續' });
  const parsedSym = JSON.parse(resSym.stdout || '{}');
  check('從 symlink 子目錄執行（hook 記原始 symSub）→ 解析到真實 ctx.root 並對得到 --tier T2',
    parsedSym.injectSteps?.[0]?.systemMessage?.systemMessage?.includes('子目錄也要高標準'),
    resSym.stdout);
  const lastTn = readEvents(e.logDir, basename(subRoot)).events.filter((x) => x.event === 'tier_notified').at(-1);
  check('tier_notified 的 cwd 記真實 git root（與 --tier 一致），caller_cwd 記來源目錄',
    lastTn?.cwd === subRoot && lastTn?.caller_cwd === real(symSub), JSON.stringify(lastTn));

  // 別的 worktree 按 --tier-retract 不應重設當前 worktree；同 cwd 按 --tier-retract 再 --tier 才重設
  appendFileSync(subLog, JSON.stringify({ ts: T(5), event: 'tier_retracted', cwd: '/other/worktree', source: 'human' }) + '\n');
  eq('別的 worktree --tier-retract → 不重設本 worktree 去重',
    evaluate({ payload: { conversationId: 's-sub', cwd: symSub, lastUserInput: '繼續' }, monitorDir: ROOT, skillHome: e.home }), null);
  appendFileSync(subLog, JSON.stringify({ ts: T(10), event: 'tier_retracted', cwd: subRoot, source: 'human' }) + '\n');
  appendFileSync(subLog, JSON.stringify({ ts: T(11), event: 'tier_set', cwd: subRoot, level: 'T2', why: '再調回來', source: 'human' }) + '\n');
  const afterRetract = evaluate({ payload: { conversationId: 's-sub', cwd: symSub, lastUserInput: '再升' }, monitorDir: ROOT, skillHome: e.home });
  check('同 cwd --tier-retract 後再升 T2 → 重新通知', !!afterRetract?.message?.includes('再調回來'), String(afterRetract?.message));

  // 3b. D 第 1 輪 #2 回歸：symlink 子目錄改危險檔後已 git commit（工作區乾淨），hook.sh 記 symSub 仍找得到起點、不漏發 T2（P1/P8/P13）
  const rSymC = makeRepo({ files: { 'sub/a.js': '1\n', 'core/db.js': '1\n' }, at: new Date(Date.now() - 30 * MIN * 1000) });
  const symRootC = real(rSymC.dir);
  writeTierCfg(symRootC, { tiers: { code: ['sub/', 'core/'], danger: ['core/db.js'] } });
  const symHostC = mkdtempSync(join(tmpdir(), 'pm-esc-symc-'));
  const symSubC = join(symHostC, 'sublink');
  symlinkSync(join(symRootC, 'sub'), symSubC);
  const symHeadC = git(symRootC, 'rev-parse', '--short', 'HEAD');
  writeLog(e.logDir, symRootC, [
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's-symc', cwd: symSubC, head: symHeadC, prompt: '在 symlink 子目錄改危險檔並 commit' },
    { ts: T(-8 * MIN), hook: 'PostToolUse', session: 's-symc', cwd: symSubC, head: symHeadC, tool: 'edit_file', file: join(symRootC, 'core/db.js') },
  ]);
  writeFileSync(join(symRootC, 'core/db.js'), '2\n');
  git(symRootC, 'add', 'core/db.js');
  git(symRootC, 'commit', '-q', '-m', 'edit danger inside symSub');
  const symCommitRes = evaluate({ payload: { conversationId: 's-symc', cwd: symSubC, lastUserInput: '存完檔下一步' }, monitorDir: ROOT, skillHome: e.home });
  check('D 第 1 輪 #2：hook 記 symSub 且危險檔已 commit（工作區乾淨）→ 仍照起點通知 T2',
    !!symCommitRes?.message?.includes('core/db.js'), String(symCommitRes?.message));

  // 3c. D 第 1 輪 #1 回歸：共用工作區裡另一對話 s1 先叫了 /spec，不讓 s2 補寫自己第一份 /spec 時被洗版（P2/P6）
  const rSh = makeRepo({ files: { 'core/db.js': '1\n' }, at: new Date(Date.now() - 30 * MIN * 1000) });
  const shRoot = real(rSh.dir);
  writeTierCfg(shRoot, { tiers: { code: ['core/'], danger: ['core/db.js'] } });
  writeFileSync(join(shRoot, 'core/db.js'), '2\n');
  utimesSync(join(shRoot, 'core/db.js'), past, past);
  const shLog = writeLog(e.logDir, shRoot, [
    { ts: T(-12 * MIN), hook: 'UserPrompt', session: 's1', prompt: '對話一在做事' },
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's2', prompt: '對話二改危險檔' },
    { ts: T(-8 * MIN), hook: 'PostToolUse', session: 's2', tool: 'edit_file', file: join(shRoot, 'core/db.js') },
  ]);
  const shNotify = e.run({ conversationId: 's2', cwd: shRoot, lastUserInput: '先改', invocationNum: 0 });
  check('D 第 1 輪 #1 前置：s2 收到首次通知', !!JSON.parse(shNotify.stdout || '{}').injectSteps?.length);
  appendFileSync(shLog, JSON.stringify({
    ts: T(2), hook: 'PostToolUse', cwd: shRoot, session: 's1', tool: 'read_file', skill: `${PLUGIN}:spec`, file: '/p/skills/spec/SKILL.md',
  }) + '\n');
  appendFileSync(shLog, JSON.stringify({
    ts: T(5), hook: 'PostToolUse', cwd: shRoot, session: 's2', tool: 'read_file', skill: `${PLUGIN}:spec`, file: '/p/skills/spec/SKILL.md',
  }) + '\n');
  eq('D 第 1 輪 #1：共用工作區另一對話 s1 先叫 /spec → s2 依通知補寫自己第一份 /spec 不二度洗版',
    evaluate({ payload: { conversationId: 's2', cwd: shRoot, lastUserInput: '補規格中' }, monitorDir: ROOT, skillHome: e.home }), null);

  // 3d. D 第 1 輪 #3 回歸（兩條路）：hadSpec:false 通知後、/spec 前再改第 2 個危險檔，或一次命中 >= 13 個危險檔 → 開 /spec 不二度洗版（P2/P6）
  const rMore = makeRepo({ files: { 'core/db.js': '1\n', 'vault/k.js': '1\n' }, at: new Date(Date.now() - 30 * MIN * 1000) });
  const moreRoot = real(rMore.dir);
  writeTierCfg(moreRoot, { tiers: { code: ['core/', 'vault/'], danger: ['core/db.js', 'vault/'] } });
  writeFileSync(join(moreRoot, 'core/db.js'), '2\n');
  utimesSync(join(moreRoot, 'core/db.js'), past, past);
  const moreLog = writeLog(e.logDir, moreRoot, [
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's-more', prompt: '先改一檔' },
    { ts: T(-8 * MIN), hook: 'PostToolUse', session: 's-more', tool: 'edit_file', file: join(moreRoot, 'core/db.js') },
  ]);
  const resMore1 = e.run({ conversationId: 's-more', cwd: moreRoot, lastUserInput: '先改一檔' });
  check('D 第 1 輪 #3a 前置：首次通知（1 檔，hadSpec:false）', !!JSON.parse(resMore1.stdout || '{}').injectSteps?.length);
  writeFileSync(join(moreRoot, 'vault/k.js'), '2\n');
  utimesSync(join(moreRoot, 'vault/k.js'), past, past);
  appendFileSync(moreLog, JSON.stringify({ ts: T(1), hook: 'PostToolUse', session: 's-more', cwd: moreRoot, tool: 'edit_file', file: join(moreRoot, 'vault/k.js') }) + '\n');
  appendFileSync(moreLog, JSON.stringify({ ts: T(3), hook: 'PostToolUse', session: 's-more', cwd: moreRoot, tool: 'read_file', skill: `${PLUGIN}:spec`, file: '/p/skills/spec/SKILL.md' }) + '\n');
  eq('D 第 1 輪 #3a：通知後、/spec 前再改第 2 個危險檔 → 啟動 /spec 中途不二度洗版',
    evaluate({ payload: { conversationId: 's-more', cwd: moreRoot, lastUserInput: '補寫規格中' }, monitorDir: ROOT, skillHome: e.home }), null);

  const manyFiles = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`core/f${String(i + 1).padStart(2, '0')}.js`, '1\n']));
  const rMany = makeRepo({ files: manyFiles, at: new Date(Date.now() - 30 * MIN * 1000) });
  const manyRoot = real(rMany.dir);
  writeTierCfg(manyRoot, { tiers: { code: ['core/'], danger: ['core/'] } });
  for (const name of Object.keys(manyFiles)) {
    writeFileSync(join(manyRoot, name), '2\n');
    utimesSync(join(manyRoot, name), past, past);
  }
  const manyLog = writeLog(e.logDir, manyRoot, [
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's-many', prompt: '一次改 13 檔' },
    { ts: T(-8 * MIN), hook: 'PostToolUse', session: 's-many', tool: 'edit_file', file: join(manyRoot, 'core/f01.js') },
  ]);
  const resMany1 = e.run({ conversationId: 's-many', cwd: manyRoot, lastUserInput: '一次改 13 檔' });
  const manyTn = readEvents(e.logDir, basename(manyRoot)).events.filter((x) => x.event === 'tier_notified').at(-1);
  check('D 第 1 輪 #3b 前置：13 檔首次通知成功且記錄截斷為 12 檔',
    !!JSON.parse(resMany1.stdout || '{}').injectSteps?.length && manyTn?.files?.length === 12 && manyTn?.hadSpec === false,
    JSON.stringify(manyTn));
  appendFileSync(manyLog, JSON.stringify({ ts: T(3), hook: 'PostToolUse', session: 's-many', cwd: manyRoot, tool: 'read_file', skill: `${PLUGIN}:spec`, file: '/p/skills/spec/SKILL.md' }) + '\n');
  eq('D 第 1 輪 #3b：命中 13 個危險檔（截斷 >12）後啟動 /spec → 中途不二度洗版',
    evaluate({ payload: { conversationId: 's-many', cwd: manyRoot, lastUserInput: '補寫規格中' }, monitorDir: ROOT, skillHome: e.home }), null);

  rmSync(symHostC, { recursive: true, force: true });
  for (const x of [rSymC, rSh, rMore, rMany]) x.cleanup();

  // 4. 新對話接手舊資料夾（inv=0 只有轉錄檔，無 hook 事件，預審 #2）：傳入 extraTranscripts + sessionId，不混入上一手危險檔
  const rTake = makeRepo({ files: { 'src/a.js': '1\n', 'core/db.js': '1\n' }, at: new Date(Date.now() - 40 * MIN * 1000) });
  const takeRoot = real(rTake.dir);
  writeTierCfg(takeRoot, { tiers: { code: ['src/', 'core/'], danger: ['core/db.js'] } });
  const trDir = mkdtempSync(join(tmpdir(), 'pm-esc-tr-'));
  const trNew = join(trDir, 'new-s.jsonl');
  writeLog(e.logDir, takeRoot, [
    { ts: T(-20 * MIN), hook: 'UserPrompt', session: 's-prev', prompt: '上一手做危險檔' },
    { ts: T(-15 * MIN), hook: 'PostToolUse', session: 's-prev', tool: 'edit_file', file: join(takeRoot, 'core/db.js') },
  ]);
  writeFileSync(join(takeRoot, 'core/db.js'), 'prev-dirty\n');
  git(takeRoot, 'add', 'core/db.js');
  git(takeRoot, 'commit', '-q', '-m', 'prev commit');
  git(takeRoot, 'checkout', '-q', '-b', 'new-branch');
  writeFileSync(join(takeRoot, 'src/a.js'), 'new-work\n');
  utimesSync(join(takeRoot, 'src/a.js'), past, past);
  writeFileSync(trNew, JSON.stringify({
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: T(10), content: '<USER_REQUEST>\n我只改 src/a.js\n</USER_REQUEST>',
  }) + '\n');
  eq('inv=0 新對話接手舊資料夾（只改 src/a.js）：因帶入 extraTranscripts 認出換人，不把上一手危險檔混進來通知',
    evaluate({ payload: { conversationId: 's-new-takeover', cwd: takeRoot, transcriptPath: trNew, lastUserInput: '我只改 src/a.js' }, monitorDir: ROOT, skillHome: e.home }),
    null);

  // 5. Fallback origin 在 inv=0 之後才冒出來（originFrom: null → 'prompt'）→ 不二度洗版（預審 #2）
  const rFb = makeRepo({ files: { 'core/db.js': '1\n' }, at: new Date(Date.now() - 20 * MIN * 1000) });
  const fbRoot = real(rFb.dir);
  writeTierCfg(fbRoot, { tiers: { code: ['core/'], danger: ['core/db.js'] } });
  writeFileSync(join(fbRoot, 'core/db.js'), '2\n');
  utimesSync(join(fbRoot, 'core/db.js'), past, past);
  const fbLog = writeLog(e.logDir, fbRoot, []);
  const fb1 = evaluate({ payload: { conversationId: 's-fb', cwd: fbRoot, lastUserInput: '無轉錄' }, monitorDir: ROOT, skillHome: e.home });
  check('originAt 為 null 的第一次通知仍正常發出', !!fb1?.message);
  appendFileSync(fbLog, JSON.stringify({
    ts: T(0), event: 'tier_notified', session: 's-fb', cwd: fbRoot, level: 'T2', trigger: 'danger', files: ['core/db.js'], hadSpec: true, source: 'escalate',
  }) + '\n');
  appendFileSync(fbLog, JSON.stringify({
    ts: T(2), hook: 'PostToolUse', session: 's-fb', cwd: fbRoot, tool: 'edit_file', file: join(fbRoot, 'core/db.js'), prompt: '無轉錄',
  }) + '\n');
  eq('PostToolUse 之後補出 fallback UserPrompt origin → 不重設同輪通知',
    evaluate({ payload: { conversationId: 's-fb', cwd: fbRoot, lastUserInput: '無轉錄' }, monitorDir: ROOT, skillHome: e.home }), null);

  rmSync(symHost, { recursive: true, force: true });
  rmSync(trDir, { recursive: true, force: true });
  for (const x of [r, rSub, rTake, rFb]) x.cleanup();
  e.cleanup();
}

section('預審 #6 與 P7：subagent inv=0 真 ENOENT 放行、缺欄位/EACCES 不吞人話、SYSTEM_SDK 不混為人類發言', 'P7');
{
  const e = makeEnv();
  const r = makeRepo({ files: { 'core/db.js': '1\n' }, at: new Date(Date.now() - 20 * MIN * 1000) });
  const root = real(r.dir);
  writeTierCfg(root, { tiers: { code: ['core/'], danger: ['core/db.js'] } });
  writeFileSync(join(root, 'core/db.js'), '2\n');
  const trDir = mkdtempSync(join(tmpdir(), 'pm-esc-sub-'));

  // 1. subagent inv=0：transcriptPath 尚未落地（ENOENT）+ lastUserInput === '' → true（輸出 {}）
  const notCreated = join(trDir, 'not-created-yet.jsonl');
  eq('subagent inv=0（ENOENT + lastUserInput:""）→ isPreInvocationSubagent=true',
    isPreInvocationSubagent({ conversationId: 'sub0', cwd: root, transcriptPath: notCreated, lastUserInput: '' }), true);
  eq('subagent inv=0 跑 evaluate → null',
    evaluate({ payload: { conversationId: 'sub0', cwd: root, transcriptPath: notCreated, lastUserInput: '' }, monitorDir: ROOT, skillHome: e.home }), null);

  // 2. 非 ENOENT（如 EACCES）或缺少 transcriptPath 時，即使 lastUserInput === '' 也不吞掉人類對話
  eq('缺 transcriptPath + lastUserInput:"" → false（不當成子 agent）',
    isPreInvocationSubagent({ conversationId: 'h1', cwd: root, lastUserInput: '' }), false);
  eq('EACCES + lastUserInput:"" → false（預審 #6：不吞人類通知）',
    isPreInvocationSubagent(
      { conversationId: 'h2', cwd: root, transcriptPath: notCreated, lastUserInput: '' },
      { stat: () => { const err = new Error('denied'); err.code = 'EACCES'; throw err; } },
    ),
    false);

  // 3. subagent inv=1：transcript 已寫出 step 0（SYSTEM_MESSAGE 含 sender=）→ true（放行）
  const subTr = join(trDir, 'sub1.jsonl');
  writeFileSync(subTr, JSON.stringify({
    step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: T(-60), content: 'sender=main-1 task',
  }) + '\n');
  eq('subagent inv=1（step 0 含 sender=）→ null',
    evaluate({ payload: { conversationId: 'sub1', cwd: root, transcriptPath: subTr, lastUserInput: '' }, monitorDir: ROOT, skillHome: e.home }), null);

  // 4. 人類對話 transcript 含 PreInvocation 注入的 SYSTEM_SDK / SYSTEM_MESSAGE → readTranscript 與 loadEvents 絕不算成人話（P7）
  const humanTr = join(trDir, 'human-with-sdk.jsonl');
  writeFileSync(humanTr, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: T(-120), content: '<USER_REQUEST>\n請修改 core/db.js\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', created_at: T(-110), content: '<SYSTEM_MESSAGE>\n[產線監視器] 這一輪的分級已經升到 T2\n</SYSTEM_MESSAGE>' }),
  ].join('\n') + '\n');
  clearTranscriptCache();
  const parsedTr = readTranscript(humanTr);
  eq('readTranscript 只收 1 則 USER_EXPLICIT 人話，不把 SYSTEM_SDK 算進去', parsedTr.prompts.length, 1);
  eq('readTranscript 不把有 SYSTEM_SDK 的對話誤判成 subagent', parsedTr.isSubagent, false);

  rmSync(trDir, { recursive: true, force: true });
  r.cleanup();
  e.cleanup();
}

section('預審 #5、寫失敗防迴圈與隔離：tier_notified 寫失敗不注入、不汙染其他模組、缺 node 先建 $LOGS、壞 JSON、中英切換', 'P3');
{
  const e = makeEnv();
  const past = new Date(Date.now() - 4 * MIN * 1000);
  const r = makeRepo({ files: { 'core/db.js': '1\n' }, at: new Date(Date.now() - 20 * MIN * 1000) });
  const root = real(r.dir);
  writeTierCfg(root, { tiers: { code: ['core/'], danger: ['core/db.js'] } });
  writeFileSync(join(root, 'core/db.js'), '2\n');
  utimesSync(join(root, 'core/db.js'), past, past);

  // 1. tier_notified 寫失敗（設檔案唯讀 0444 讓讀過、寫失敗觸發 EACCES）→ 必回 {}（不注入防洗版）且記 escalate_broken
  const blockedProjLog = writeLog(e.logDir, root, [
    { ts: T(-5 * MIN), hook: 'UserPrompt', session: 's-fw', prompt: '寫失敗測試' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', session: 's-fw', tool: 'edit_file', file: join(root, 'core/db.js') },
  ]);
  chmodSync(blockedProjLog, 0o444);
  const resFailWrite = e.run({ conversationId: 's-fw', cwd: root, lastUserInput: '寫失敗測試' });
  chmodSync(blockedProjLog, 0o600);
  eq('tier_notified 寫失敗 → exit 0', resFailWrite.status, 0);
  eq('tier_notified 寫失敗 → 輸出 {} 不注入（防每步洗版）', resFailWrite.stdout.trim(), '{}');
  const brk = readFaults(e.logDir).filter((x) => x.event === 'escalate_broken').at(-1);
  check('tier_notified 寫失敗 → 留下 escalate_broken 且記呼叫端 cwd', brk?.why?.includes('記不了 tier_notified') && brk?.cwd === root, JSON.stringify(brk));

  // 2. tier_notified 隔離性：只有 tier_notified（沒有任何 hook 事件）不汙染 sessionsOf / noRecordsWithin / collectAll
  writeLog(e.logDir, root, [
    { ts: T(-60), event: 'tier_notified', session: 's-only-tn', level: 'T2', trigger: 'danger', files: ['core/db.js'], source: 'escalate' },
  ]);
  const loaded = loadEvents(e.logDir, basename(root), { home: e.home });
  eq('只有 tier_notified → sessionsOf 不長假對話卡', sessionsOf(loaded.events).length, 0);
  eq('只有 tier_notified → noRecordsWithin 仍為 true（P5）', noRecordsWithin(loaded), true);
  const all = collectAll({ monitorDir: ROOT, home: e.home });
  const proj = all.projects.find((p) => p.name === safeName(basename(root)));
  check('只有 tier_notified 時 collectAll 專案沒有假對話卡也沒有錯算 worktrees', !!proj && proj.sessions.length === 0 && proj.cards.length === 0, JSON.stringify(proj));

  // 3. 壞 JSON stdin → 輸出 {}＋exit 0 且記 escalate_broken
  const badIn = e.run('{壞掉');
  eq('壞 JSON stdin → exit 0', badIn.status, 0);
  eq('壞 JSON stdin → 輸出 {}', badIn.stdout.trim(), '{}');
  check('壞 JSON stdin → 記 escalate_broken', readFaults(e.logDir).some((x) => x.event === 'escalate_broken' && x.why === '輸入不是合法 JSON'));

  // 4. 找不到 node 且 $LOGS 尚未建立（預審 #5 / P8）→ 自動建 $LOGS 並記 escalate_broken + 輸出 {}
  const noNodeDir = mkdtempSync(join(tmpdir(), 'pm-esc-nonode-'));
  const fakeBin = join(noNodeDir, 'bin');
  const freshLogs = join(noNodeDir, 'fresh', 'logs');
  mkdirSync(fakeBin, { recursive: true });
  for (const cmd of ['dirname', 'mkdir', 'date']) {
    const src = ['/usr/bin', '/bin'].map((d) => join(d, cmd)).find((p) => existsSync(p));
    if (src) symlinkSync(src, join(fakeBin, cmd));
  }
  const fakeSh = join(noNodeDir, 'escalate.sh');
  const origSh = readFileSync(join(ROOT, 'escalate.sh'), 'utf8')
    .replace('/opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node', '/nonexistent/no-node-here');
  writeFileSync(fakeSh, origSh, { mode: 0o755 });
  const outNoNode = e.run({ cwd: root }, fakeSh, { ...e.env, PATH: fakeBin, AGY_PIPELINE_LOG_DIR: freshLogs });
  eq('缺 node → exit 0', outNoNode.status, 0);
  eq('缺 node → 輸出 {}', outNoNode.stdout.trim(), '{}');
  check('缺 node 且 $LOGS 不存在 → 自動建立 $LOGS 並記 escalate_broken (why: 找不到 node)',
    existsSync(join(freshLogs, '_sensor.jsonl'))
    && readFaults(freshLogs).some((x) => x.event === 'escalate_broken' && x.why === '找不到 node'));
  rmSync(noNodeDir, { recursive: true, force: true });

  // 5. 中英雙語切換（P2）：英文注入全英文、無中文與全形空白、無紅線禁用字
  writeFileSync(join(e.data, 'lang.json'), JSON.stringify({ lang: 'en' }));
  writeLog(e.logDir, root, [
    { ts: T(-5 * MIN), hook: 'UserPrompt', session: 's-en', prompt: 'edit danger' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', session: 's-en', tool: 'edit_file', file: join(root, 'core/db.js') },
  ]);
  const resEn = e.run({ conversationId: 's-en', cwd: root, lastUserInput: 'edit danger' });
  const msgEn = JSON.parse(resEn.stdout || '{}').injectSteps?.[0]?.systemMessage?.systemMessage ?? '';
  check('英文模式正常注入', msgEn.includes('T2') && msgEn.includes('core/db.js'), resEn.stdout);
  check('英文通知無中文與全形空白', !/[\u4e00-\u9fff\u3000]/.test(msgEn), msgEn);
  check('英文通知不出現紅線禁用字（passed／all clear／no problems／verified／works／not run）',
    !/\b(passed|all clear|no problems|verified|works|not run)\b/i.test(msgEn), msgEn);

  r.cleanup();
  e.cleanup();
}

section('分級通知（escalate.sh）按資料夾留心跳（byCwd）：切到別的專案不讓已恢復的 escalate_broken 復活', 'P3');
{
  const e2 = makeEnv();
  const rA = makeRepo({ files: { 'a.js': '1\n' } });
  const rB = makeRepo({ files: { 'b.js': '1\n' } });
  writeFileSync(join(e2.logDir, '_sensor.jsonl'),
    JSON.stringify({ ts: T(-120), event: 'escalate_broken', why: 'boom', cwd: rA.dir }) + '\n');
  const resA = e2.run({ conversationId: 's-a', cwd: rA.dir, lastUserInput: 'hi' });
  eq('rA 正常跑完 escalate.sh → exit 0', resA.status, 0);
  const resB = e2.run({ conversationId: 's-b', cwd: rB.dir, lastUserInput: 'hi' });
  eq('rB 正常跑完 escalate.sh → exit 0', resB.status, 0);
  const hb = escalateHeartbeat(e2.logDir);
  check('_escalate.json 的 byCwd 同時保有兩個資料夾的心跳',
    Boolean(hb?.byCwd?.[rA.dir]) && Boolean(hb?.byCwd?.[rB.dir]), JSON.stringify(hb));
  eq('切去 rB 跑完 escalate.sh 後，rA.dir 的 escalateError 仍維持 recovered（不復活）',
    faultState({ faults: readFaults(e2.logDir), escalateHb: hb, retainDays: 90 }).escalateError?.state, 'recovered');
  rA.cleanup();
  rB.cleanup();
  e2.cleanup();
}

process.exit(summary());
