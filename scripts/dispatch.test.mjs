#!/usr/bin/env node
/**
 * dispatch.test.mjs —— F 工地主任對話內派工／清理 worktree／歸檔對話測試
 * （規格：honest-task-board-director-dispatch AC-3、AC-4、AC-6）
 *
 * 釘住會安靜說謊與撞車的地方：
 *   - --wrap 帶目標步驟引數分流（含空白路徑不污染原話）與 triedBefore 依 target 區分（P2/P6/P7）
 *   - dispatch 嚴格省略 environmentId、擋主資料夾髒檔/非主線/活躍對話/symlink 子目錄/optedOut/LS 失敗，
 *     部分失敗仍寫 task_dispatched 防隱形撞車，CSRF token 零寫入磁碟與零輸出（P1/P2/P6/R1/R2）
 *   - clean-worktree 擋主資料夾/自身 cwd/未存新檔/未合併/活躍對話，成功移除並安全 git branch -d（P1/P13/R2）
 *   - archive 擋未結案/復工/跨專案/未存未併，放行剛清完 worktree 的已結案對話，讀回確認（P2/P6/R2）
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { check, eq, makeRepo, section, summary } from './_harness.mjs';
import { CJK } from './_zhscan.mjs';
import { doWrap } from '../lib/cliWrap.mjs';
import { safeName } from '../lib/events.mjs';
import { gitContext, real } from '../lib/git.mjs';
import { withLang } from '../lib/lang.mjs';
import { loadEvents } from '../lib/transcript.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).name;
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

const NOW = Date.now();
const T = (sec) => new Date(NOW + sec * 1000).toISOString();
const MIN = 60;

async function startMockLS(handler) {
  const calls = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const method = req.url?.split('/').pop() ?? '';
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      calls.push({ method, body, csrf: req.headers['x-antigravity-csrf-token'] });
      const out = handler(method, body, req.headers);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    addr: `127.0.0.1:${srv.address().port}`,
    calls,
    close: () => new Promise((r) => srv.close(r)),
  };
}

function setupWorld({ tasks = [], extraWorktrees = [] } = {}) {
  const files = {
    'a.txt': 'base\n',
    '.agents/pipeline-tasks.json': JSON.stringify({ tasks }),
  };
  const r = makeRepo({ at: T(-120 * MIN), files });
  const mainDir = git(r.dir, 'rev-parse', '--show-toplevel');
  const box = mkdtempSync(join(tmpdir(), 'pm-disp-'));
  const wts = {};
  for (const name of extraWorktrees) {
    const p = join(box, `wt ${name}`); // 故意含空白路徑測引數分流（P13）
    git(mainDir, 'worktree', 'add', '-q', '-b', `br-${name}`, p);
    wts[name] = git(p, 'rev-parse', '--show-toplevel');
  }
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-disp-mon-'));
  const logDir = join(monitorDir, 'logs');
  mkdirSync(logDir); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-disp-home-'));
  mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(ROOT, join(home, '.gemini', 'config', 'plugins', PLUGIN));
  const log = join(logDir, `${safeName(basename(mainDir))}.jsonl`);
  const writeEvents = (list) => writeFileSync(log, list.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const cleanup = () => {
    for (const p of Object.values(wts)) {
      if (existsSync(p)) {
        try { git(mainDir, 'worktree', 'remove', '--force', p); } catch { /* ok */ }
      }
    }
    for (const d of [box, monitorDir, home]) rmSync(d, { recursive: true, force: true });
    r.cleanup();
  };
  return { mainDir, wts, monitorDir, logDir, home, log, writeEvents, cleanup };
}

async function runWrap(cwd, monitorDir, logDir, home, args, { sid = 's-dir', env = {} } = {}) {
  const ctx = gitContext(cwd);
  const ev = loadEvents(logDir, ctx.project, { sessionId: sid, cwd: ctx.root });
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(' '));
  let code = 1;
  try {
    code = await doWrap(ctx, ev, args, { sid, env: { ...process.env, ...env }, monitorDir, home, logDir });
  } finally {
    console.log = orig;
  }
  return { code, text: out.join('\n') };
}

section('AC-3：dispatch 省略 environmentId、主資料夾防撞車、token 零洩漏與部分失敗防隱形撞車', 'P6');
{
  const w = setupWorld({
    tasks: [
      { id: 'T-LOCKED', title: '被鎖', spec: 's1', dependsOn: ['T-NEXT'] },
      { id: 'T-NEXT', title: '下一步功能', spec: 'next-spec', prompt: 'Start T-NEXT' },
      { id: 'T-MODEL', title: '指定型號任務', model: 'pro' },
    ],
    extraWorktrees: ['one'],
  });
  const secret = 'super-secret-csrf-token-xyz';
  const convs = new Map();
  let mode = 'ok';
  const ls = await startMockLS((method, body) => {
    if (method === 'ListConversations') {
      if (mode === 'list-fail') return { status: 500, body: { message: `bad ${secret}` } };
      if (mode === 'ls-running') return { body: { conversations: [{ id: 'other-run', metadata: {}, annotations: { title: '正在跑的' }, state: { runState: 'RUN_STATE_RUNNING' } }] } };
      return { body: { conversations: [] } };
    }
    if (method === 'CreateConversation') {
      const id = `conv-${convs.size + 1}`;
      const title = mode === 'bad-title' ? 'wrong' : body.title;
      convs.set(id, { id, metadata: { projectId: body.projectId, ...(body.environmentId ? { environmentId: body.environmentId } : {}) }, annotations: { title }, state: { runState: 'RUN_STATE_IDLE' } });
      return { body: { conversation: convs.get(id) } };
    }
    if (method === 'GetConversation') {
      if (mode === 'get-fail') return { status: 500, body: { message: 'boom' } };
      return convs.has(body.conversationId) ? { body: convs.get(body.conversationId) } : { status: 404, body: { message: 'not found' } };
    }
    if (method === 'UpdateConversation') {
      const c = convs.get(body.conversationId);
      if (mode === 'bad-title') return { status: 500, body: { message: 'rename failed' } };
      if (c) c.annotations = { ...c.annotations, ...body.annotations };
      return { body: c ?? {} };
    }
    return { status: 404, body: {} };
  });

  const env = { ANTIGRAVITY_LS_ADDRESS: ls.addr, ANTIGRAVITY_CSRF_TOKEN: secret, ANTIGRAVITY_PROJECT_ID: 'proj-1' };
  const wtOne = w.wts.one;
  w.writeEvents([
    { ts: T(-20 * MIN), hook: 'UserPrompt', session: 's-dir', cwd: wtOne, prompt: '巡一圈' },
    { ts: T(-10 * MIN), hook: 'PostToolUse', session: 's-dir', tool: 'read_file', skill: `${PLUGIN}:director`, cwd: wtOne },
    { ts: T(-5 * MIN), hook: 'UserPrompt', session: 's-dir', cwd: wtOne, prompt: '同意派工 T-NEXT 與 T-MODEL' },
  ]);
  let stepSec = -5 * MIN + 5;
  const nextQuote = (q) => {
    appendFileSync(w.log, JSON.stringify({ ts: T(stepSec), hook: 'UserPrompt', session: 's-dir', cwd: wtOne, prompt: q }) + '\n');
    stepSec += 5;
    return q;
  };

  // 缺憑證 → 沒做
  const noCreds = await runWrap(wtOne, w.monitorDir, w.logDir, w.home, ['dispatch', 'T-NEXT', '同意派工'], { env: { ANTIGRAVITY_LS_ADDRESS: '', ANTIGRAVITY_CSRF_TOKEN: '', ANTIGRAVITY_PROJECT_ID: '' } });
  check('缺 LS 憑證 → 沒做', noCreds.code === 1 && /沒做/.test(noCreds.text), noCreds.text);

  // 鎖定中任務 → 沒做
  const locked = await runWrap(wtOne, w.monitorDir, w.logDir, w.home, ['dispatch', 'T-LOCKED', '同意派工'], { env });
  check('鎖定中任務 → 沒做', locked.code === 1 && /鎖定中/.test(locked.text), locked.text);

  // 主資料夾有未追蹤新檔 → 沒做（P1）
  writeFileSync(join(w.mainDir, 'untracked.txt'), 'dirty\n');
  const dirty = await runWrap(wtOne, w.monitorDir, w.logDir, w.home, ['dispatch', 'T-NEXT', nextQuote('重試派工 dirty')], { env });
  check('主資料夾有未追蹤新檔 → 沒做', dirty.code === 1 && /未追蹤/.test(dirty.text), dirty.text);
  rmSync(join(w.mainDir, 'untracked.txt'));

  // 主資料夾子目錄有其他活躍對話 → 沒做（P13）
  mkdirSync(join(w.mainDir, 'sub'), { recursive: true });
  appendFileSync(w.log, JSON.stringify({ ts: T(-4 * MIN), hook: 'UserPrompt', session: 's-main-sub', cwd: join(w.mainDir, 'sub'), prompt: 'busy in sub' }) + '\n');
  const busySub = await runWrap(wtOne, w.monitorDir, w.logDir, w.home, ['dispatch', 'T-NEXT', nextQuote('重試派工 busySub')], { env });
  check('主資料夾子目錄有其他活躍對話 → 沒做', busySub.code === 1 && /主資料夾還有其他未結案對話/.test(busySub.text), busySub.text);
  // 結案該子目錄對話後放行
  appendFileSync(w.log, JSON.stringify({ ts: T(-3 * MIN), event: 'session_closed', session: 's-main-sub', cwd: join(w.mainDir, 'sub'), source: 'human' }) + '\n');

  // 未掛感測器與已退出記錄（optedOut）→ 沒做（R1）
  const bareHome = mkdtempSync(join(tmpdir(), 'pm-disp-barehome-'));
  const unmounted = await runWrap(wtOne, w.monitorDir, w.logDir, bareHome, ['dispatch', 'T-NEXT', nextQuote('重試派工 unmounted')], { env });
  rmSync(bareHome, { recursive: true, force: true });
  check('未掛感測器 → 沒做', unmounted.code === 1 && /沒掛好|沒做/.test(unmounted.text), unmounted.text);

  writeFileSync(join(w.mainDir, '.agents', 'pipeline-monitor.off'), '{"at":"2026-11-27T00:00:00Z"}\n');
  const optedOutRes = await runWrap(wtOne, w.monitorDir, w.logDir, w.home, ['dispatch', 'T-NEXT', nextQuote('重試派工 optedOut')], { env });
  rmSync(join(w.mainDir, '.agents', 'pipeline-monitor.off'));
  check('已退出記錄（optedOut）→ 沒做', optedOutRes.code === 1 && /已退出記錄/.test(optedOutRes.text), optedOutRes.text);

  // LS ListConversations 報錯或看到執行中對話 → 沒做且不洩漏 secret
  mode = 'list-fail';
  const listFail = await runWrap(wtOne, w.monitorDir, w.logDir, w.home, ['dispatch', 'T-NEXT', nextQuote('重試派工 listFail')], { env });
  check('LS 列表失敗 → 沒做且絕不洩漏 CSRF token', listFail.code === 1 && /沒做/.test(listFail.text) && !listFail.text.includes(secret) && listFail.text.includes('[REDACTED]'), listFail.text);
  mode = 'ls-running';
  const lsRun = await runWrap(wtOne, w.monitorDir, w.logDir, w.home, ['dispatch', 'T-NEXT', nextQuote('重試派工 lsRun')], { env });
  check('LS 主資料夾有執行中對話 → 沒做', lsRun.code === 1 && /正在執行中的對話/.test(lsRun.text), lsRun.text);

  // 成功派工：嚴格省略 environmentId、未指定 model 時不送 model
  mode = 'ok';
  const okQuote = nextQuote('確認再派工 T-NEXT');
  const ok1 = await runWrap(wtOne, w.monitorDir, w.logDir, w.home, ['dispatch', 'T-NEXT', okQuote], { env });
  const createCall = ls.calls.find((c) => c.method === 'CreateConversation');
  check('dispatch 成功：成了、省略 environmentId 與未設 model、GetConversation 讀回確認',
    ok1.code === 0 && /成了/.test(ok1.text) && createCall && !('environmentId' in createCall.body) && !('model' in createCall.body) && /未指定型號/.test(ok1.text), ok1.text);

  // 同句原話對同一目標重試 → triedBefore 擋下
  const dup = await runWrap(wtOne, w.monitorDir, w.logDir, w.home, ['dispatch', 'T-NEXT', okQuote], { env });
  check('同一句原話同一目標重試 → 擋下', dup.code === 1 && /已經拿來做過一次/.test(dup.text), dup.text);

  // 先清掉前一筆派工的假未結案佔用（結案 conv-1），並驗證 T-NEXT 回到可開工且可重新派工（D1 P2/P6 迴歸）
  appendFileSync(w.log, JSON.stringify({ ts: new Date(Date.now() + 1000).toISOString(), event: 'session_closed', session: 'conv-1', cwd: w.mainDir, source: 'human' }) + '\n');
  const redispatch = await runWrap(wtOne, w.monitorDir, w.logDir, w.home, ['dispatch', 'T-NEXT', nextQuote('確認重派 T-NEXT')], { env });
  check('無 hook 派工對話結案後 T-NEXT 可重新派工（D1 迴歸）', redispatch.code === 0 && /conv-2/.test(redispatch.text), redispatch.text);
  appendFileSync(w.log, JSON.stringify({ ts: new Date(Date.now() + 2000).toISOString(), event: 'session_closed', session: 'conv-2', cwd: w.mainDir, source: 'human' }) + '\n');

  // 部分失敗（命名與讀回失敗）：仍記錄 task_dispatched(verified:false) 與對話 ID 防隱形撞車
  mode = 'bad-title';
  const partial = await runWrap(wtOne, w.monitorDir, w.logDir, w.home, ['dispatch', 'T-MODEL', '同意派工'], { env });
  const logRaw = readFileSync(w.log, 'utf8');
  check('CreateConversation 後命名讀回失敗 → 沒成且仍記 task_dispatched(verified:false) 與印出對話 ID',
    partial.code === 1 && /沒成/.test(partial.text) && /conv-3/.test(partial.text) && logRaw.includes('"verified":false') && !logRaw.includes(secret), partial.text);

  await ls.close();
  w.cleanup();
}

section('AC-4：clean-worktree（含空白路徑、防自砍、防未合併與髒檔、同句清兩個不同 worktree、安全 branch -d）', 'P13');
{
  const w = setupWorld({ extraWorktrees: ['alpha', 'beta', 'unmerged', 'self'] });
  const wtAlpha = w.wts.alpha;
  const wtBeta = w.wts.beta;
  const wtUnmerged = w.wts.unmerged;
  const wtSelf = w.wts.self;

  // unmerged 新增一個未併入的 commit
  writeFileSync(join(wtUnmerged, 'feature.txt'), 'unmerged\n');
  git(wtUnmerged, 'add', '-A');
  git(wtUnmerged, 'commit', '-qm', 'unmerged commit');

  w.writeEvents([
    { ts: T(-20 * MIN), hook: 'UserPrompt', session: 's-self', cwd: wtSelf, prompt: '收尾清理' },
    { ts: T(-15 * MIN), hook: 'PostToolUse', session: 's-self', tool: 'read_file', skill: `${PLUGIN}:director`, cwd: wtSelf },
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's-self', cwd: wtSelf, prompt: '照建議清理 alpha 與 beta' },
  ]);

  const selfBlock = await runWrap(wtSelf, w.monitorDir, w.logDir, w.home, ['clean-worktree', wtSelf, '照建議清理'], { sid: 's-self' });
  check('clean-worktree 拒絕移除自己正站著的 cwd', selfBlock.code === 1 && /自己正站著/.test(selfBlock.text), selfBlock.text);

  const mainBlock = await runWrap(wtSelf, w.monitorDir, w.logDir, w.home, ['clean-worktree', w.mainDir, '照建議清理'], { sid: 's-self' });
  check('clean-worktree 拒絕移除主資料夾', mainBlock.code === 1 && /主資料夾/.test(mainBlock.text), mainBlock.text);

  const unmBlock = await runWrap(wtSelf, w.monitorDir, w.logDir, w.home, ['clean-worktree', wtUnmerged, '照建議清理'], { sid: 's-self' });
  check('clean-worktree 拒絕移除未合併 worktree', unmBlock.code === 1 && /還沒併進/.test(unmBlock.text), unmBlock.text);

  // 同一個原話依序清理含空白路徑的 alpha 與 beta（預審 #1）
  const okAlpha = await runWrap(wtSelf, w.monitorDir, w.logDir, w.home, ['clean-worktree', wtAlpha, '照建議清理'], { sid: 's-self' });
  const okBeta = await runWrap(wtSelf, w.monitorDir, w.logDir, w.home, ['clean-worktree', 'br-beta', '照建議清理'], { sid: 's-self' });
  const branchesLeft = git(w.mainDir, 'branch');
  check('同句確認話清理兩個不同目標（含空白路徑＋分支名）均成了並安全刪除分支',
    okAlpha.code === 0 && /成了/.test(okAlpha.text) && !existsSync(wtAlpha)
    && okBeta.code === 0 && /成了/.test(okBeta.text) && !existsSync(wtBeta)
    && !branchesLeft.includes('br-alpha') && !branchesLeft.includes('br-beta'),
    `${okAlpha.text}\n${okBeta.text}\n${branchesLeft}`);

  // 同目標重試仍擋下
  const dupAlpha = await runWrap(wtSelf, w.monitorDir, w.logDir, w.home, ['clean-worktree', wtAlpha, '照建議清理'], { sid: 's-self' });
  check('對同一 worktree 重試 → 擋下', dupAlpha.code === 1 && /已經拿來做過一次/.test(dupAlpha.text), dupAlpha.text);

  w.cleanup();
}

section('AC-4/AC-6：archive（拒未結案與復工、放行剛清理的 gone worktree、讀回確認與英文零中文）', 'P2');
{
  const w = setupWorld({ extraWorktrees: ['a', 'b'] });
  const convs = new Map([
    ['s-open', { id: 's-open', metadata: { projectId: 'proj-1' }, annotations: { title: 'open' }, state: { runState: 'RUN_STATE_IDLE' } }],
    ['s-reopened', { id: 's-reopened', metadata: { projectId: 'proj-1' }, annotations: { title: 'reopened' }, state: { runState: 'RUN_STATE_IDLE' } }],
    ['s-gone-closed', { id: 's-gone-closed', metadata: { projectId: 'proj-1' }, annotations: { title: 'gone closed' }, state: { runState: 'RUN_STATE_IDLE' } }],
    ['s-other-proj', { id: 's-other-proj', metadata: { projectId: 'proj-OTHER' }, annotations: { title: 'other' }, state: { runState: 'RUN_STATE_IDLE' } }],
  ]);
  const ls = await startMockLS((method, body) => {
    if (method === 'GetConversation') return convs.has(body.conversationId) ? { body: convs.get(body.conversationId) } : { status: 404, body: {} };
    if (method === 'UpdateConversation') {
      const c = convs.get(body.conversationId);
      if (c) c.annotations = { ...c.annotations, ...body.annotations };
      return { body: c ?? {} };
    }
    return { body: {} };
  });
  const env = { ANTIGRAVITY_LS_ADDRESS: ls.addr, ANTIGRAVITY_CSRF_TOKEN: 'tok-123', ANTIGRAVITY_PROJECT_ID: 'proj-1' };
  const wtB = w.wts.b;
  const gonePath = join(w.mainDir, '..', 'already-cleaned-wt');

  w.writeEvents([
    { ts: T(-40 * MIN), hook: 'UserPrompt', session: 's-open', cwd: w.wts.a, prompt: 'still open' },
    { ts: T(-35 * MIN), hook: 'UserPrompt', session: 's-reopened', cwd: w.wts.a, prompt: 'first' },
    { ts: T(-30 * MIN), event: 'session_closed', session: 's-reopened', cwd: w.wts.a, source: 'human' },
    { ts: T(-25 * MIN), hook: 'UserPrompt', session: 's-reopened', cwd: w.wts.a, prompt: 'reopened!' },
    { ts: T(-28 * MIN), hook: 'UserPrompt', session: 's-gone-closed', cwd: gonePath, prompt: 'finished and cleaned' },
    { ts: T(-26 * MIN), event: 'session_closed', session: 's-gone-closed', cwd: gonePath, source: 'human' },
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's-dir', cwd: wtB, prompt: 'wrap' },
    { ts: T(-8 * MIN), hook: 'PostToolUse', session: 's-dir', tool: 'read_file', skill: `${PLUGIN}:director`, cwd: wtB },
    { ts: T(-5 * MIN), hook: 'UserPrompt', session: 's-dir', cwd: wtB, prompt: 'archive them' },
  ]);

  const openRes = await runWrap(wtB, w.monitorDir, w.logDir, w.home, ['archive', 's-open', 'archive them'], { sid: 's-dir', env });
  check('未結案對話 → 拒絕歸檔', openRes.code === 1 && /還沒按結案/.test(openRes.text), openRes.text);

  const reopRes = await runWrap(wtB, w.monitorDir, w.logDir, w.home, ['archive', 's-reopened', 'archive them'], { sid: 's-dir', env });
  check('結案後復工對話 → sessionsOf 重設 closedAt，拒絕歸檔', reopRes.code === 1 && /還沒按結案/.test(reopRes.text), reopRes.text);

  const otherRes = await runWrap(wtB, w.monitorDir, w.logDir, w.home, ['archive', 's-other-proj', 'archive them'], { sid: 's-dir', env });
  check('別的專案對話 → 拒絕歸檔', otherRes.code === 1 && /別的專案/.test(otherRes.text), otherRes.text);

  const enRes = await withLang('en', () => runWrap(wtB, w.monitorDir, w.logDir, w.home, ['archive', 's-gone-closed', 'archive them'], { sid: 's-dir', env }));
  check('已結案且 worktree 已移除 → 放行歸檔、讀回確認、英文零中文',
    enRes.code === 0 && /Archive conversation: done:/.test(enRes.text) && convs.get('s-gone-closed')?.annotations?.archived === true && !CJK.test(enRes.text), enRes.text);

  await ls.close();
  w.cleanup();
}

process.exit(summary());
