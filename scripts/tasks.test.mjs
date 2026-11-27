#!/usr/bin/env node
/**
 * tasks.test.mjs —— 誠實任務板測試（規格：honest-task-board-director-dispatch AC-1、AC-2、AC-6）
 *
 * 釘住會安靜說謊的地方：
 *   - 五態任務設定檔（no-main / unset / unreadable / broken / ok）與空陣列（P5）
 *   - 循環相依、無效 spec 路徑、重複 ID、忽略手寫 status/percent（P2）
 *   - 6 欄狀態 + unknown 推導（認 main/master、worktree 未併不歸檔、已結案且 gone 不阻擋、在線 dirty===null 標 unknown、活 worktree 優先於主線舊規劃中、提前動工警示、ls-tree 失敗）（P5/P6/P8/P10/P11）
 *   - --tasks CLI 與 collectAll 單一真相來源一致性與 ZH/EN 雙語（P2）
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { check, eq, makeRepo, section, summary } from './_harness.mjs';
import { CJK } from './_zhscan.mjs';
import { collectAll } from '../lib/collect.mjs';
import { safeName } from '../lib/events.mjs';
import { withLang } from '../lib/lang.mjs';
import { deriveTaskBoard, formatTasksLines, normSpecSlug, readTasksConfig } from '../lib/tasks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).name;
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

function writeFile(dir, rel, content) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

section('AC-1：五態任務設定檔、spec slug 正規化、循環相依與手寫假狀態忽略', 'P5');
{
  const nm = readTasksConfig(null);
  eq('找不到主資料夾 → no-main（不折成 unset）', nm.state, 'no-main');

  const r = makeRepo({ files: { 'README.md': 'hi\n' } });
  const root = git(r.dir, 'rev-parse', '--show-toplevel');
  eq('未建立任務檔 → unset', readTasksConfig(root).state, 'unset');

  // 權限不可讀（unreadable）：於非 root 帳號驗證 EACCES
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    writeFile(root, '.agents/pipeline-tasks.json', JSON.stringify({ tasks: [] }));
    chmodSync(join(root, '.agents', 'pipeline-tasks.json'), 0o000);
    const un = readTasksConfig(root);
    eq('無權限讀任務檔 → unreadable（不折成 unset）', un.state, 'unreadable');
    chmodSync(join(root, '.agents', 'pipeline-tasks.json'), 0o600);
  }

  // 壞 JSON / 循環 / 非法 spec / 重複 ID
  writeFile(root, '.agents/pipeline-tasks.json', '{bad');
  eq('壞 JSON → broken', readTasksConfig(root).state, 'broken');

  writeFile(root, '.agents/pipeline-tasks.json', JSON.stringify({
    tasks: [
      { id: 'T1', title: '一', spec: 'docs/規劃中/a.md', dependsOn: ['T2'] },
      { id: 'T2', title: '二', dependsOn: ['T1'] },
    ],
  }));
  const brk = readTasksConfig(root);
  check('非法 spec 路徑＋循環相依 → broken 且逐條列錯', brk.state === 'broken' && brk.errors.some((e) => /slug/.test(e)) && brk.errors.some((e) => /循環/.test(e)), JSON.stringify(brk));

  eq('normSpecSlug 剝除 .md 尾碼', normSpecSlug('my-spec.md'), 'my-spec');
  eq('normSpecSlug 拒收路徑與 ..', normSpecSlug('../secret.md'), null);

  // 空陣列與手寫 status/percent 忽略
  writeFile(root, '.agents/pipeline-tasks.json', JSON.stringify({ status: 'done', tasks: [] }));
  const emptyTb = deriveTaskBoard({ project: { name: 'p', mainRoot: root, cards: [], sessions: [] }, desk: {}, events: [] });
  eq('tasks 空陣列 → empty', emptyTb.state, 'empty');
  eq('手寫 status 標註忽略', emptyTb.ignoredManualFields, true);

  // 相容 .claude/pipeline-tasks.json fallback
  rmSync(join(root, '.agents', 'pipeline-tasks.json'));
  writeFile(root, '.claude/pipeline-tasks.json', JSON.stringify({
    tasks: [{ id: 'T1', title: '第一張', spec: 'first.md', status: 'done', percent: 100 }],
  }));
  const fb = readTasksConfig(root);
  check('無 .agents 時退回讀取 .claude/pipeline-tasks.json 並忽略手寫 status', fb.state === 'ok' && fb.tasks[0].spec === 'first' && fb.ignoredManualFields === true, JSON.stringify(fb));

  r.cleanup();
}

section('AC-1/AC-2：6 欄與 unknown 推導（主線 master、worktree 優先、已結案且 gone 不擋歸檔、提前動工警示、ls-tree 失敗）', 'P6');
{
  const now = Date.now();
  const T = (m) => new Date(now - m * 60_000).toISOString();
  const r = makeRepo({ at: T(120), files: {
    '.agents/pipeline-stages.json': JSON.stringify({ tiers: { code: ['a.js'], danger: [] } }),
    '.agents/pipeline-tasks.json': JSON.stringify({
      tasks: [
        { id: 'T-DONE', title: '已歸檔任務', spec: 'done-spec.md' },
        { id: 'T-CLEANED', title: '已歸檔且清理 worktree', spec: 'cleaned-spec' },
        { id: 'T-DIRTY', title: '主線已歸檔但 worktree 未併', spec: 'dirty-spec' },
        { id: 'T-INPROG', title: '活 worktree 優先於主線規劃中', spec: 'live-spec' },
        { id: 'T-EARLY', title: '前置未歸檔卻提前動工', spec: 'early-spec', dependsOn: ['T-DIRTY'] },
        { id: 'T-LOCKED', title: '等待前置解鎖', dependsOn: ['T-DIRTY'] },
        { id: 'T-READY', title: '已解鎖可開工', dependsOn: ['T-DONE', 'T-CLEANED'], prompt: 'Run T-READY now' },
        { id: 'T-WAIT', title: '規格等點頭', spec: 'wait-spec' },
        { id: 'T-WRAP', title: '只剩收尾', spec: 'wrap-spec' },
      ],
    }),
    'docs/升級摘要/done-spec.md': '# done\n',
    'docs/升級摘要/cleaned-spec.md': '# cleaned\n',
    'docs/升級摘要/dirty-spec.md': '# dirty\n',
    'docs/規劃中/live-spec.md': '# live planned on main\n',
    'docs/規劃中/wait-spec.md': '# wait\n',
    'docs/進行中/wrap-spec.md': '# wrap\n',
  } });
  const mainRoot = git(r.dir, 'rev-parse', '--show-toplevel');
  const wtBox = mkdtempSync(join(tmpdir(), 'pm-task-wt-'));
  const wtDirty = join(wtBox, 'wt-dirty');
  const wtLive = join(wtBox, 'wt-live');
  const wtEarly = join(wtBox, 'wt-early');
  const wtWrap = join(wtBox, 'wt-wrap');
  git(mainRoot, 'worktree', 'add', '-q', '-b', 'feat-dirty', wtDirty);
  git(mainRoot, 'worktree', 'add', '-q', '-b', 'feat-live', wtLive);
  git(mainRoot, 'worktree', 'add', '-q', '-b', 'feat-early', wtEarly);
  git(mainRoot, 'worktree', 'add', '-q', '-b', 'feat-wrap', wtWrap);

  const baseHead = git(mainRoot, 'rev-parse', '--short', 'HEAD');
  writeFile(wtDirty, 'src.txt', 'uncommitted\n');
  writeFile(wtLive, 'docs/進行中/live-spec.md', '# live doing\n');
  writeFile(wtLive, 'a.js', 'console.log(1);\n');
  git(wtLive, 'add', '-A');
  git(wtLive, 'commit', '-qm', 'wip live');
  writeFile(wtEarly, 'docs/進行中/early-spec.md', '# early doing\n');
  writeFile(wtWrap, 'a.js', 'console.log("wrap");\n');
  const tWrapEdit = new Date(Date.parse(T(20)));
  utimesSync(join(wtWrap, 'a.js'), tWrapEdit, tWrapEdit);
  execFileSync('git', ['add', '-A'], { cwd: wtWrap, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'wrap ready'], { cwd: wtWrap, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: T(20), GIT_COMMITTER_DATE: T(20) } });

  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-task-mon-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const log = join(monitorDir, 'logs', `${safeName(basename(mainRoot))}.jsonl`);
  writeFileSync(log, [
    // cleaned-spec: 已結案且舊 worktree 已不存在 (gone)
    { ts: T(90), hook: 'UserPrompt', session: 's-cleaned', cwd: join(wtBox, 'gone-wt'), prompt: 'do cleaned' },
    { ts: T(85), hook: 'PostToolUse', session: 's-cleaned', tool: 'read_file', skill: `${PLUGIN}:spec`, cwd: join(wtBox, 'gone-wt') },
    { ts: T(80), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/升級摘要/cleaned-spec.md', by_session: 's-cleaned', cwd: join(wtBox, 'gone-wt'), source: 'ai' },
    { ts: T(75), event: 'session_closed', session: 's-cleaned', cwd: join(wtBox, 'gone-wt'), source: 'human' },
    // dirty-spec: 在 wtDirty 上尚未存檔
    { ts: T(60), hook: 'UserPrompt', session: 's-dirty', cwd: wtDirty, prompt: 'do dirty' },
    { ts: T(55), event: 'spec_link', spec: 'docs/升級摘要/dirty-spec.md', by_session: 's-dirty', cwd: wtDirty, source: 'ai' },
    // live-spec: 在 wtLive 進入施工（改了 a.js 需 D 尚未跑 D）
    { ts: T(50), hook: 'UserPrompt', session: 's-live', cwd: wtLive, prompt: 'do live' },
    { ts: T(45), event: 'spec_link', spec: 'docs/進行中/live-spec.md', by_session: 's-live', cwd: wtLive, source: 'ai' },
    { ts: T(42), hook: 'PostToolUse', session: 's-live', tool: 'write_file', file: join(wtLive, 'a.js'), cwd: wtLive },
    // early-spec: 前置沒歸檔卻已提前開工
    { ts: T(40), hook: 'UserPrompt', session: 's-early', cwd: wtEarly, prompt: 'do early' },
    // wrap-spec: 已寫完程式且過 D，只剩併與蓋章收尾
    { ts: T(30), hook: 'UserPrompt', session: 's-wrap', cwd: wtWrap, head: baseHead, prompt: 'do wrap' },
    { ts: T(25), event: 'spec_link', spec: 'docs/進行中/wrap-spec.md', by_session: 's-wrap', cwd: wtWrap, source: 'ai' },
    { ts: T(20), hook: 'PostToolUse', session: 's-wrap', tool: 'write_file', file: join(wtWrap, 'a.js'), cwd: wtWrap },
    { ts: T(15), hook: 'PostToolUse', session: 's-wrap', tool: 'read_file', skill: `${PLUGIN}:chaos-check`, cwd: wtWrap },
    { ts: T(12), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', by_session: 's-wrap', cwd: wtWrap, source: 'ai' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const all = collectAll({ monitorDir });
  const p = all.projects[0];
  eq('collectAll 附帶 taskBoardSupport', all.taskBoardSupport, true);
  const byId = Object.fromEntries(p.taskBoard.tasks.map((t) => [t.id, t]));
  eq('T-DONE 在 master 主線已歸檔 → archived', byId['T-DONE'].column, 'archived');
  eq('T-CLEANED 已結案且 worktree gone 不阻擋 → archived', byId['T-CLEANED'].column, 'archived');
  eq('T-DIRTY 雖主線有檔但工作區未存 → 不算歸檔', byId['T-DIRTY'].column === 'archived', false);
  eq('T-INPROG 活 worktree 優先於主線舊規劃中 → in-progress', byId['T-INPROG'].column, 'in-progress');
  check('T-EARLY 前置未歸檔卻提前動工 → 留 in-progress 並掛警告', byId['T-EARLY'].column === 'in-progress' && byId['T-EARLY'].warnings.some((w) => w.includes('T-DIRTY')), JSON.stringify(byId['T-EARLY']));
  eq('T-LOCKED 前置未歸檔且未動工 → blocked', byId['T-LOCKED'].column, 'blocked');
  eq('T-READY 前置皆已歸檔 → ready', byId['T-READY'].column, 'ready');
  eq('T-WAIT 僅規劃中有規格 → spec-waiting', byId['T-WAIT'].column, 'spec-waiting');
  eq('T-WRAP 有未蓋章 → wrap-up', byId['T-WRAP'].column, 'wrap-up');
  eq('已歸檔任務不給複製開工按鈕', byId['T-DONE'].canCopy, false);
  check('鎖定中任務複製交辦附前置未解鎖警告', byId['T-LOCKED'].canCopy && /前置/.test(byId['T-LOCKED'].copyPrompt), byId['T-LOCKED'].copyPrompt);

  // CLI --tasks 在不同步的 worktree 跑：共用推導且提示不同步（P2）
  writeFile(wtLive, '.agents/pipeline-tasks.json', JSON.stringify({ tasks: [] }));
  const cliOut = execFileSync('node', [join(ROOT, 'status.mjs'), '--tasks'], {
    cwd: wtLive,
    encoding: 'utf8',
    env: { ...process.env, AGY_PIPELINE_HOME: monitorDir, AGY_PIPELINE_LOG_DIR: join(monitorDir, 'logs') },
  });
  check('--tasks 在 worktree 任務檔不同步時誠實提醒以主資料夾為準', /不同步/.test(cliOut) && cliOut.includes('T-READY') && !cliOut.includes('%'), cliOut);

  // 英文輸出零中文與禁語（扣除測試資料自帶的中文標題／對話名）
  let enText = withLang('en', () => formatTasksLines(collectAll({ monitorDir }).projects[0].taskBoard, { displayName: 'demo' }).join('\n'));
  for (const dataTitle of p.taskBoard.tasks.map((t) => t.title)) enText = enText.split(dataTitle).join('');
  check('--tasks 英文輸出無中文與禁語', !CJK.test(enText) && !/\bpassed\b|\ball clear\b|\bverified\b/i.test(enText), enText);

  try { git(mainRoot, 'worktree', 'remove', '--force', wtDirty); } catch { /* ok */ }
  try { git(mainRoot, 'worktree', 'remove', '--force', wtLive); } catch { /* ok */ }
  try { git(mainRoot, 'worktree', 'remove', '--force', wtEarly); } catch { /* ok */ }
  try { git(mainRoot, 'worktree', 'remove', '--force', wtWrap); } catch { /* ok */ }
  rmSync(wtBox, { recursive: true, force: true });
  rmSync(monitorDir, { recursive: true, force: true });
  r.cleanup();
}

section('R1/P5：零 commit 新專案主線不可知 → 依賴主線任務標 unknown、無規格任務照常可開工', 'P5');
{
  const dir = mkdtempSync(join(tmpdir(), 'pm-task-nocommit-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFile(dir, '.agents/pipeline-tasks.json', JSON.stringify({
    tasks: [
      { id: 'T1', title: '依賴規格', spec: 's1' },
      { id: 'T2', title: '無規格直接開工' },
    ],
  }));
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-task-nocommit-mon-'));
  mkdirSync(join(monitorDir, 'logs'));
  const cliOut = execFileSync('node', [join(ROOT, 'status.mjs'), '--tasks'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, AGY_PIPELINE_HOME: monitorDir, AGY_PIPELINE_LOG_DIR: join(monitorDir, 'logs') },
  });
  check('零 commit 專案 --tasks 照常可執行，有 spec 者標問不到、無 spec 者標可開工', cliOut.includes('問不到／待釐清') && cliOut.includes('可開工'), cliOut);

  // D1 迴歸：無 hook 派工對話（task_dispatched）按結案（session_closed）後不再永遠卡在 in-progress（P2/P6）
  const tOpen = new Date(Date.now() - 600_000).toISOString();
  const tClose = new Date(Date.now() - 300_000).toISOString();
  const tbOpen = deriveTaskBoard({
    project: { name: 'nocommit', displayName: 'nocommit', mainRoot: dir, cards: [], sessions: [] },
    events: [{ ts: tOpen, event: 'task_dispatched', taskId: 'T2', conversationId: 'conv-zero-1', title: '[T2] 無規格直接開工', cwd: dir }],
  });
  const tbClosed = deriveTaskBoard({
    project: { name: 'nocommit', displayName: 'nocommit', mainRoot: dir, cards: [], sessions: [] },
    events: [
      { ts: tOpen, event: 'task_dispatched', taskId: 'T2', conversationId: 'conv-zero-1', title: '[T2] 無規格直接開工', cwd: dir },
      { ts: tClose, event: 'session_closed', session: 'conv-zero-1', cwd: dir, source: 'human' },
    ],
  });
  check('無 hook 派工對話未結案時為 in-progress、結案後回到 ready（P2/P6 迴歸）',
    tbOpen.tasks.find((x) => x.id === 'T2')?.column === 'in-progress'
    && tbClosed.tasks.find((x) => x.id === 'T2')?.column === 'ready',
    JSON.stringify({ open: tbOpen.tasks.find((x) => x.id === 'T2')?.column, closed: tbClosed.tasks.find((x) => x.id === 'T2')?.column }));

  rmSync(dir, { recursive: true, force: true });
  rmSync(monitorDir, { recursive: true, force: true });
}

process.exit(summary());
