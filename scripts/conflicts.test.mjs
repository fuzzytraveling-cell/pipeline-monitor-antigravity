#!/usr/bin/env node
/**
 * conflicts.test.mjs —— 多 worktree 並發改動衝突偵測（規格：worktree-conflict-detection）
 *
 * 只釘會安靜說謊與各處講不同話的地方：
 *   ① P1 / P12 / P13：含未追蹤新檔、git mv 新舊兩路徑、特殊字元檔名（不重複去引號）、排除 gone／已結案無未存／main 併入檔、納入已結案有未存檔、子目錄與捷徑去重
 *   ② R1 / P5：問不到改動、問不到未存檔、看不全已存改動（blind）、蓋章後仍有未併主線存檔（checkpoint-unmerged）不折成「沒衝突」
 *   ③ P2 / P10：collectAll、todoBoard/boardText、ui/app.js（白板與對話頁）、status.mjs（含零 commit）四處字句一字不差；紅灰筆槽亮燈；F 主任黃燈不滅；舊服務提醒
 *   ④ 零重複 git 查詢與雙語同步（英文零中文與紅線禁語）
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, copyFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { detectConflicts, conflictsForWorktree } from '../lib/conflicts.mjs';
import { collectAll, projectConflictsFor } from '../lib/collect.mjs';
import { todoBoard, boardText } from '../lib/todo.mjs';
import { gitContext, real, withGitMemo, ago } from '../lib/git.mjs';
import { safeName } from '../lib/events.mjs';
import { withLang } from '../lib/lang.mjs';
import { changeScope } from '../lib/scope.mjs';
import { gatherChange, stageFacts } from '../lib/cliFacts.mjs';
import { loadEvents } from '../lib/transcript.mjs';
import { CJK } from './_zhscan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.now();
const T = (sec) => new Date(NOW + sec * 1000).toISOString();
const MIN = 60;
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const gitRun = (dir, ...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
const gitAt = (dir, at, ...a) => execFileSync('git', a, {
  cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
});
const unesc = (s) => String(s ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function uiOf(latest, lang = 'zh') {
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const body = src.replace(/^import .*$/m, '').replace(/^pollLoop\(\);$/m, '').replace(/^setInterval\(paintFreshness, 1000\);$/m, '');
  const noop = () => {};
  const el = () => ({ dataset: {}, classList: { toggle: noop }, innerHTML: '', textContent: '', setAttribute: noop });
  const document = { documentElement: { dataset: { lang, theme: 'night' } }, getElementById: el, addEventListener: noop, body: el(), activeElement: null };
  const ls = { getItem: () => 'night', setItem: noop };
  const make = new Function('describeFreshness', 'STALE_AFTER_SECONDS', 'document', 'window', 'localStorage', 'location', 'setTimeout', 'setInterval', 'fetch', '__LATEST',
    `${body}\nlatest = __LATEST;\nreturn { whiteboard, sessionPage, oldServerBanner, bossMood };`);
  return make(() => ({ label: '', state: 'fresh', dim: false }), 60, document, { addEventListener: noop }, ls,
    { hash: '' }, noop, noop, () => Promise.reject(new Error('測試不連網路')), latest);
}

function makeWorktreeEnv() {
  const r = makeRepo({ at: T(-120 * MIN), files: {
    'src/shared.js': 'v1\n', 'src/move-old.js': 'm1\n', 'src/main-only.js': 'mo1\n',
    'src/a.js': 'a1\n', 'src/b.js': 'b1\n', 'src/c.js': 'c1\n', 'src/d.js': 'd1\n',
    'src/q "name".txt': 'q1\n', 'src/中文 檔.js': 'z1\n', 'README.md': 'r\n',
  } });
  const main = real(git(r.dir, 'rev-parse', '--show-toplevel'));
  const wtParent = mkdtempSync(join(tmpdir(), 'pm-conf-wt-'));
  const wtA = join(wtParent, 'wt-a');
  const wtB = join(wtParent, 'wt-b');
  const wtC = join(wtParent, 'wt-c');
  const wtClosedClean = join(wtParent, 'wt-closed-clean');
  const wtClosedDirty = join(wtParent, 'wt-closed-dirty');
  const wtGone = join(wtParent, 'wt-gone');
  const wtOrphan = join(wtParent, 'wt-orphan');
  const tWt = T(-110 * MIN);
  gitAt(main, tWt, 'worktree', 'add', '-q', '-b', 'feat-a', wtA);
  gitAt(main, tWt, 'worktree', 'add', '-q', '-b', 'feat-b', wtB);
  gitAt(main, tWt, 'worktree', 'add', '-q', '-b', 'feat-c', wtC);
  gitAt(main, tWt, 'worktree', 'add', '-q', '-b', 'closed-clean', wtClosedClean);
  gitAt(main, tWt, 'worktree', 'add', '-q', '-b', 'closed-dirty', wtClosedDirty);
  gitAt(main, tWt, 'worktree', 'add', '-q', '-b', 'gone-br', wtGone);
  gitAt(main, tWt, 'worktree', 'add', '-q', '--orphan', '-b', 'orphan-br', wtOrphan);

  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-conf-mon-'));
  mkdirSync(join(monitorDir, 'logs'));
  mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-conf-home-'));
  const log = join(monitorDir, 'logs', `${safeName(basename(main))}.jsonl`);

  const runCli = (cwd, lang = null) => {
    const { ANTIGRAVITY_CONVERSATION_ID: _drop, AGY_PIPELINE_HOME: _h, AGY_PIPELINE_LOG_DIR: _l, ...env } = process.env;
    if (lang) writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang }));
    else rmSync(join(monitorDir, 'lang.json'), { force: true });
    return execFileSync('node', [join(ROOT, 'status.mjs')], {
      cwd, encoding: 'utf8',
      env: { ...env, HOME: home, AGY_PIPELINE_HOME: monitorDir, AGY_PIPELINE_LOG_DIR: join(monitorDir, 'logs') },
    });
  };

  const cleanup = () => {
    for (const wt of [wtA, wtB, wtC, wtClosedClean, wtClosedDirty, wtGone, wtOrphan]) {
      try { gitRun(main, 'worktree', 'remove', '--force', wt); } catch {}
    }
    rmSync(wtParent, { recursive: true, force: true });
    rmSync(monitorDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    r.cleanup();
  };

  return {
    main, wtA: real(wtA), wtB: real(wtB), wtC: real(wtC),
    wtClosedClean: real(wtClosedClean), wtClosedDirty: real(wtClosedDirty),
    wtGone, wtOrphan: real(wtOrphan),
    monitorDir, home, log, runCli, cleanup,
  };
}

section('AC-1：多 worktree 檔案重疊（含新檔、git mv、特殊字元、前 3 支口徑、排除 gone／已結案無未存／main 併入、納入已結案有未存與零 commit）', 'P1');
{
  const e = makeWorktreeEnv();
  // 在 main 上模擬別的對話已提交 main-only.js（之後快轉併進 wtB，P12 不得算進 wtB 衝突）
  writeFileSync(join(e.main, 'src/main-only.js'), 'from-main\n');
  gitAt(e.main, T(-90 * MIN), 'add', 'src/main-only.js');
  gitAt(e.main, T(-90 * MIN), 'commit', '-q', '-m', 'main update');

  // wtA（活躍）：改 a/b/c/d（4 支與 wtB 撞）、改 move-old.js、改帶引號與中文檔名、改 main-only.js（A 自己真的改了），還加新未追蹤檔 brand-new.js
  writeFileSync(join(e.wtA, 'src/a.js'), 'a-A\n');
  writeFileSync(join(e.wtA, 'src/b.js'), 'b-A\n');
  writeFileSync(join(e.wtA, 'src/c.js'), 'c-A\n');
  writeFileSync(join(e.wtA, 'src/d.js'), 'd-A\n');
  writeFileSync(join(e.wtA, 'src/move-old.js'), 'touch-old-A\n');
  writeFileSync(join(e.wtA, 'src/q "name".txt'), 'q-A\n');
  writeFileSync(join(e.wtA, 'src/中文 檔.js'), 'zh-A\n');
  writeFileSync(join(e.wtA, 'src/main-only.js'), 'A-edited-main-only\n');
  writeFileSync(join(e.wtA, 'src/brand-new.js'), 'new-A\n');
  gitAt(e.wtA, T(-45 * MIN), 'add', 'src/a.js', 'src/b.js');
  gitAt(e.wtA, T(-45 * MIN), 'commit', '-q', '-m', 'wtA work');

  // wtB（活躍）：先快轉併入 main（帶進 src/main-only.js，P12 不該算衝突）；改 a/b/c/d、git mv move-old.js → move-new.js、改 q "name".txt 與 中文 檔.js、加同名新檔 brand-new.js
  gitAt(e.wtB, T(-42 * MIN), 'merge', '--ff-only', '-q', 'master');
  writeFileSync(join(e.wtB, 'src/a.js'), 'a-B\n');
  writeFileSync(join(e.wtB, 'src/b.js'), 'b-B\n');
  writeFileSync(join(e.wtB, 'src/c.js'), 'c-B\n');
  writeFileSync(join(e.wtB, 'src/d.js'), 'd-B\n');
  gitRun(e.wtB, 'mv', 'src/move-old.js', 'src/move-new.js');
  writeFileSync(join(e.wtB, 'src/q "name".txt'), 'q-B\n');
  writeFileSync(join(e.wtB, 'src/中文 檔.js'), 'zh-B\n');
  writeFileSync(join(e.wtB, 'src/brand-new.js'), 'new-B\n');

  // wtC（活躍）：只動 src/shared.js（與主線／其他未衝突）以及 src/only-c.js
  writeFileSync(join(e.wtC, 'src/only-c.js'), 'c-only\n');

  // wtClosedClean（已結案且無未存檔，雖然有已 commit 的 src/shared.js 改動，不得參與衝突）
  writeFileSync(join(e.wtClosedClean, 'src/shared.js'), 'clean-closed\n');
  gitAt(e.wtClosedClean, T(-33 * MIN), 'add', 'src/shared.js');
  gitAt(e.wtClosedClean, T(-33 * MIN), 'commit', '-q', '-m', 'closed clean');

  // wtClosedDirty（已結案：結案前已 commit README.md（不該拿來撞）、但還留著未存改動 src/shared.js）
  writeFileSync(join(e.wtClosedDirty, 'README.md'), 'dirty-closed-commit\n');
  gitAt(e.wtClosedDirty, T(-28 * MIN), 'add', 'README.md');
  gitAt(e.wtClosedDirty, T(-28 * MIN), 'commit', '-q', '-m', 'closed committed readme');
  writeFileSync(join(e.wtClosedDirty, 'src/shared.js'), 'dirty-uncommitted\n');

  // wtGone（改過 src/shared.js 後整個資料夾被刪掉，不得參與）
  writeFileSync(join(e.wtGone, 'src/shared.js'), 'gone-dirty\n');

  // wtOrphan（零 commit：只有未追蹤新檔 src/only-c.js，與 wtC 撞車；以及 README.md 不應與 wtClosedDirty 的已 commit README.md 撞車）
  mkdirSync(join(e.wtOrphan, 'src'), { recursive: true });
  writeFileSync(join(e.wtOrphan, 'src/only-c.js'), 'orphan-new\n');
  writeFileSync(join(e.wtOrphan, 'README.md'), 'orphan-readme\n');

  // 記錄各工作區對話事件；wtGone 先寫紀錄再移除目錄
  writeFileSync(e.log, [
    { ts: T(-50 * MIN), hook: 'UserPrompt', session: 'sA', cwd: e.wtA, prompt: '開發功能 A', title: '開發功能 A' },
    { ts: T(-49 * MIN), hook: 'PostToolUse', session: 'sA', cwd: e.wtA, tool: 'write_file', file: join(e.wtA, 'src/a.js') },
    { ts: T(-45 * MIN), hook: 'UserPrompt', session: 'sB', cwd: e.wtB, prompt: '開發功能 B', title: '開發功能 B' },
    { ts: T(-44 * MIN), hook: 'PostToolUse', session: 'sB', cwd: e.wtB, tool: 'edit_file', file: join(e.wtB, 'src/a.js') },
    { ts: T(-40 * MIN), hook: 'UserPrompt', session: 'sC', cwd: e.wtC, prompt: '功能 C 獨立檔', title: '功能 C 獨立檔' },
    { ts: T(-35 * MIN), hook: 'UserPrompt', session: 'sCC', cwd: e.wtClosedClean, prompt: '乾淨結案', title: '乾淨結案' },
    { ts: T(-34 * MIN), event: 'session_closed', session: 'sCC', cwd: e.wtClosedClean, source: 'human' },
    { ts: T(-30 * MIN), hook: 'UserPrompt', session: 'sCD', cwd: e.wtClosedDirty, prompt: '留未存結案', title: '留未存結案' },
    { ts: T(-29 * MIN), event: 'session_closed', session: 'sCD', cwd: e.wtClosedDirty, source: 'human' },
    { ts: T(-25 * MIN), hook: 'UserPrompt', session: 'sGone', cwd: e.wtGone, prompt: '已拆掉', title: '已拆掉' },
    { ts: T(-20 * MIN), hook: 'UserPrompt', session: 'sOrph', cwd: e.wtOrphan, prompt: '零存檔分支', title: '零存檔分支' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');

  gitRun(e.main, 'worktree', 'remove', '--force', e.wtGone);

  // wtC 自己也動一下 src/shared.js，這樣 wtC 與 wtClosedDirty（未存檔）正好在 src/shared.js 撞車
  writeFileSync(join(e.wtC, 'src/shared.js'), 'c-shared\n');

  const all = collectAll({ monitorDir: e.monitorDir, skillHome: e.home, home: e.home });
  const proj = all.projects.find((p) => p.name === safeName(basename(e.main)));
  const conf = proj?.conflicts;

  eq('collectAll 頂層帶 conflictSupport: true', all.conflictSupport, true);
  check('抓到「開發功能 A」與「開發功能 B」的重疊組', conf?.overlaps?.some((o) =>
    o.labels.some((l) => l.includes('開發功能 A')) && o.labels.some((l) => l.includes('開發功能 B'))));
  const ab = conf?.overlaps?.find((o) => o.labels.some((l) => l.includes('開發功能 A')) && o.labels.some((l) => l.includes('開發功能 B')));
  check('A+B 重疊含未追蹤新檔 src/brand-new.js', ab?.files?.includes('src/brand-new.js'), JSON.stringify(ab?.files));
  check('A+B 重疊含 git mv 舊路徑 src/move-old.js（P1）', ab?.files?.includes('src/move-old.js'), JSON.stringify(ab?.files));
  check('A+B 重疊含帶雙引號與空白檔名 src/q "name".txt（P1）', ab?.files?.includes('src/q "name".txt'), JSON.stringify(ab?.files));
  check('A+B 重疊含中文檔名 src/中文 檔.js（P1）', ab?.files?.includes('src/中文 檔.js'), JSON.stringify(ab?.files));
  check('P12：僅從 main 併入 wtB 的 src/main-only.js 不算在 A+B 重疊內', !ab?.files?.includes('src/main-only.js'), JSON.stringify(ab?.files));
  check('A+B 重疊超過 3 支檔時文案沿用「等 N 支檔」口徑', /等 8 支檔/.test(ab?.line ?? ''), ab?.line);

  // 已結案有未存改動參與（只看未存檔 src/shared.js，不計已 commit 的 README.md）
  const cCd = conf?.overlaps?.find((o) => o.labels.some((l) => l.includes('留未存結案')) && o.labels.some((l) => l.includes('功能 C 獨立檔')));
  check('已結案仍有未存改動的工作區與 wtC 撞到 src/shared.js，且標示「已結案但仍有未存改動」',
    Boolean(cCd) && cCd.files.includes('src/shared.js') && cCd.labels.some((l) => l.includes('已結案但仍有未存改動')),
    JSON.stringify(cCd));
  check('已結案無未存改動（乾淨結案）與 gone（已拆掉）不出現於重疊',
    !JSON.stringify(conf).includes('乾淨結案') && !JSON.stringify(conf).includes('已拆掉'), JSON.stringify(conf));

  // 零 commit（wtOrphan）與 wtC 撞到 src/only-c.js，且不跟 wtClosedDirty 已 commit 的 README.md 撞車
  const cOrph = conf?.overlaps?.find((o) => o.labels.some((l) => l.includes('零存檔分支')) && o.labels.some((l) => l.includes('功能 C 獨立檔')));
  check('零 commit worktree（wtOrphan）與 wtC 撞到 src/only-c.js，且不混入已結案者結案前的 README.md',
    Boolean(cOrph) && cOrph.files.includes('src/only-c.js') && !JSON.stringify(conf).includes('README.md'),
    JSON.stringify(conf));

  // P2：驗證四處輸出（案件頁 p.conflicts、對話頁 s.conflicts、todoBoard/boardText、ui/app.js、status.mjs 含零 commit）一字不差
  const board = todoBoard(all);
  const todoLines = boardText(board).join('\n');
  const sec = board.projects.find((x) => x.name === proj.name);
  const ui = uiOf({ ...all, todo: board });
  const wbHtml = unesc(ui.whiteboard(proj));
  const sessA = proj.sessions.find((s) => s.id === 'sA');
  const pageA = unesc(ui.sessionPage(proj.name, 'sA'));
  const pageC = unesc(ui.sessionPage(proj.name, 'sC'));
  const pageOrph = unesc(ui.sessionPage(proj.name, 'sOrph'));
  const cliA = e.runCli(e.wtA);
  const cliC = e.runCli(e.wtC);
  const cliOrph = e.runCli(e.wtOrphan);

  eq('案件頁 sec.conflicts 與 proj.conflicts.items 一字不差', JSON.stringify(sec?.conflicts), JSON.stringify(conf?.items));
  for (const item of conf?.items ?? []) {
    check(`--todo 印出衝突句：${item.text.slice(0, 32)}`, todoLines.includes(item.text), todoLines);
    check(`案件頁白板畫出衝突句：${item.text.slice(0, 32)}`, wbHtml.includes(item.text), wbHtml);
  }
  for (const item of sessA?.conflicts?.items ?? []) {
    check(`對話頁 sA 畫出自身衝突句：${item.text.slice(0, 32)}`, pageA.includes(item.text), pageA);
    check(`終端機 wtA 印出自身衝突句：${item.text.slice(0, 32)}`, cliA.includes(item.text), cliA);
  }
  check('對話頁 sA 與終端機 wtA 不印無關的 wtC+wtOrphan 條目',
    !pageA.includes('零存檔分支') && !cliA.includes('零存檔分支'), cliA);
  check('對話頁 sC 與終端機 wtC 只印含自己的條目（不含 A+B）',
    pageC.includes(cOrph.line) && cliC.includes(cOrph.line) && !pageC.includes('開發功能 A') && !cliC.includes('開發功能 A'), cliC);
  check('零 commit worktree 終端機（!ctx.hasCommits 分支）與對話頁 sOrph 照常印出與 wtC 的衝突',
    cliOrph.includes(cOrph.line) && pageOrph.includes(cOrph.line), cliOrph);
  check('白板筆槽：重疊亮紅筆（ask → red data-lit="1"）', /data-ink="red" data-lit="1"/.test(wbHtml), wbHtml);

  // 驗證 ui/app.js sessionPage 在 gone 與 movedOn 早退時不畫衝突
  const fakeMoved = { ...proj, sessions: [{ ...sessA, movedOn: { at: T(-10 * MIN) } }] };
  const fakeGone = { ...proj, sessions: [{ ...sessA, card: { ...sessA.card, gone: true } }] };
  check('movedOn 舊租戶對話頁不顯示工作區衝突', !uiOf({ ...all, todo: board, projects: [fakeMoved] }).sessionPage(proj.name, 'sA').includes('檔案重疊'));
  check('gone 對話頁不顯示工作區衝突', !uiOf({ ...all, todo: board, projects: [fakeGone] }).sessionPage(proj.name, 'sA').includes('檔案重疊'));

  // 驗證：設定好分級且 D 已結案、只剩收尾時，即使專案有檔案重疊，F 工地主任黃燈仍照亮（決策 2）
  const dirProj = {
    ...proj,
    sessions: [
      {
        ...sessA,
        stages: [
          { id: 'A', name: '寫規格', skill: 'spec', state: 'none', rerun: null },
          { id: 'B', name: '寫程式', type: 'main-conversation', state: 'main' },
          { id: 'C', name: '打掃', skill: 'cleanup', state: 'none', rerun: null },
          { id: 'D', name: '魔鬼教官', skill: 'chaos-check', state: 'done', doneBy: 'ai', ranAt: T(-10 * MIN), rerun: { state: 'ok', line: 'AI 說：沒對到已知死法' } },
          { id: 'E', name: '驗收', type: 'browser', state: 'none', rerun: { state: 'none', estate: 'none', line: '這一輪還沒走' } },
        ],
        tier: { state: 'ok', lines: { reqs: [{ key: 'D', label: 'D 魔鬼教官', state: 'ok', mark: '✅', text: '10 分鐘前跑過' }], main: null } },
      },
    ],
  };
  const dirBoard = todoBoard({ projects: [dirProj] });
  const dirSec = dirBoard.projects[0];
  check('有衝突時 F 工地主任黃燈照亮（不關掉）',
    Boolean(dirSec?.conflicts?.length) && /現在可以叫主任：只剩收尾/.test(dirSec?.rows?.[0]?.call ?? ''),
    JSON.stringify(dirSec?.rows?.[0]));

  e.cleanup();
}

section('P13／P6：子目錄與 symlink 歸一去重（不自我衝突、不把單工作區報成檢查不全）、sharesCwd 多活對話、嵌套獨立 repo 不誤併', 'P13');
{
  const r = makeRepo({ at: T(-60 * MIN), files: { 'sub/keep.js': '1\n', 'outside.js': '1\n' } });
  const root = real(git(r.dir, 'rev-parse', '--show-toplevel'));
  const sub = join(root, 'sub');
  const symHost = mkdtempSync(join(tmpdir(), 'pm-conf-sym-'));
  const symSub = join(symHost, 'sublink');
  const symRoot = join(symHost, 'rootlink');
  symlinkSync(sub, symSub);
  symlinkSync(root, symRoot);

  // 在子目錄外新建一個未追蹤檔：若 e.cwd 沒先歸一就跑 ls-files，會漏掉 outside.js 且 sub/keep.js 缺前綴
  writeFileSync(join(root, 'outside.js'), 'changed-outside\n');
  writeFileSync(join(root, 'sub/brand-new-sub.js'), 'new-sub\n');

  // 建一個嵌套獨立 git repo，確認不會被外層吞掉
  const nested = join(root, 'nested-repo');
  mkdirSync(nested, { recursive: true });
  gitRun(nested, 'init', '-q');
  gitRun(nested, 'config', 'user.email', 't@t');
  gitRun(nested, 'config', 'user.name', 'T');
  writeFileSync(join(nested, 'outside.js'), 'nested-file\n');
  gitRun(nested, 'add', '-A');
  gitRun(nested, 'commit', '-q', '-m', 'nested init');

  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-conf-p13-'));
  mkdirSync(join(monitorDir, 'logs'));
  mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-conf-p13h-'));

  // 兩個活躍對話分別在 sub 與 symSub（同一個實體工作區），加上 rootlink（也指同一個實體工作區）→ 去重後只有 1 個工作區！
  const log = join(monitorDir, 'logs', `${safeName(basename(root))}.jsonl`);
  writeFileSync(log, [
    { ts: T(-15 * MIN), hook: 'UserPrompt', session: 's1', cwd: sub, prompt: '子目錄一', title: '子目錄一' },
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's2', cwd: symSub, prompt: '子目錄捷徑二', title: '子目錄捷徑二' },
    { ts: T(-5 * MIN), hook: 'UserPrompt', session: 's3', cwd: symRoot, prompt: '根捷徑三' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');

  const all = collectAll({ monitorDir, skillHome: home, home });
  const proj = all.projects.find((p) => p.name === safeName(basename(root)));
  const card = proj?.cards?.[0];
  check('子目錄 e.cwd 歸一後，health.list 完整抓到子目錄外 outside.js 與完整路徑 sub/brand-new-sub.js',
    card?.health?.list?.includes('outside.js') && card?.health?.list?.includes('sub/brand-new-sub.js'),
    JSON.stringify(card?.health?.list));
  eq('同實體工作區不同子目錄／捷徑去重後不會誤報成自我衝突', proj?.conflicts?.overlaps?.length, 0);
  eq('去重後參與者只剩 1 個時不會誤觸跨工作區檢查不全', proj?.conflicts?.incomplete?.length, 0);

  // 現在加一個真正的兄弟 worktree，驗證 sharesCwd 合併標籤與嵌套獨立 repo 不會混入
  const wtParent = mkdtempSync(join(tmpdir(), 'pm-conf-p13wt-'));
  const wt2 = join(wtParent, 'wt2');
  gitAt(root, T(-50 * MIN), 'worktree', 'add', '-q', '-b', 'sib2', wt2);
  writeFileSync(join(wt2, 'sub/brand-new-sub.js'), 'new-sub-from-wt2\n');
  appendFileSync(log, JSON.stringify({ ts: T(-4 * MIN), hook: 'PostToolUse', session: 's4', cwd: real(wt2), tool: 'write_file', file: join(real(wt2), 'sub/brand-new-sub.js') }) + '\n');

  const all2 = collectAll({ monitorDir, skillHome: home, home });
  const proj2 = all2.projects.find((p) => p.name === safeName(basename(root)));
  const ov2 = proj2?.conflicts?.overlaps?.[0];
  check('同實體工作區多對話合併成「代表對話 等 3 個對話」並與兄弟工作區偵測出 sub/brand-new-sub.js 撞車',
    Boolean(ov2) && ov2.files.includes('sub/brand-new-sub.js') && ov2.labels.some((l) => l.includes('等 3 個對話')),
    JSON.stringify(ov2));
  check('無標題的兄弟對話 s4 直接顯示分支名 sib2，絕不重複印成 sib2（sib2）',
    ov2?.labels?.includes('sib2') && !ov2?.labels?.some((l) => l.includes('sib2（sib2）')),
    JSON.stringify(ov2?.labels));

  // 嵌套獨立 repo 有自己的專案名（nested-repo），不混入外層 repo
  const nestedLog = join(monitorDir, 'logs', `${safeName(basename(nested))}.jsonl`);
  writeFileSync(nestedLog, JSON.stringify({ ts: T(-2 * MIN), hook: 'UserPrompt', session: 'sn', cwd: nested, prompt: '嵌套' }) + '\n');
  const all3 = collectAll({ monitorDir, skillHome: home, home });
  const outerProj = all3.projects.find((p) => p.name === safeName(basename(root)));
  check('嵌套獨立 git repo 不被誤併進外層專案', !outerProj?.cards?.some((c) => c.path === real(nested)));

  try { gitRun(root, 'worktree', 'remove', '--force', wt2); } catch {}
  for (const d of [wtParent, symHost, monitorDir, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('D 第 1 輪回歸（P13／P6／P2）：symlink 根與子目錄不拆兩卡；子目錄對話跑 agy-pipeline 與儀表板／兄弟 worktree 一致', 'P13');
{
  // 1. P13/P6：同對話先在 symlink 根發訊息、再在子目錄動作 → collectAll 只產出 1 張卡且保留全部事件
  const r1 = makeRepo({ at: T(-60 * MIN), files: { 'sub/a.js': '1\n', 'outside.js': '1\n' } });
  const root1 = real(git(r1.dir, 'rev-parse', '--show-toplevel'));
  const symHost = mkdtempSync(join(tmpdir(), 'pm-conf-d3sym-'));
  const symRoot = join(symHost, 'rootlink');
  symlinkSync(root1, symRoot);
  writeFileSync(join(root1, 'outside.js'), 'changed\n');

  const mon1 = mkdtempSync(join(tmpdir(), 'pm-conf-d3mon-'));
  mkdirSync(join(mon1, 'logs'));
  mkdirSync(join(mon1, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(mon1, 'stages.json'));
  const home1 = mkdtempSync(join(tmpdir(), 'pm-conf-d3h-'));
  const log1 = join(mon1, 'logs', `${safeName(basename(root1))}.jsonl`);
  writeFileSync(log1, [
    { ts: T(-20 * MIN), hook: 'UserPrompt', session: 'sMix', cwd: symRoot, prompt: '根目錄開口', title: '混合路徑對話' },
    { ts: T(-10 * MIN), hook: 'PostToolUse', session: 'sMix', cwd: join(symRoot, 'sub'), tool: 'edit_file', file: join(symRoot, 'sub/a.js') },
    { ts: T(-5 * MIN), hook: 'UserPrompt', session: 'sMix', cwd: join(symRoot, 'sub'), prompt: '子目錄續寫' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');

  const allMix = collectAll({ monitorDir: mon1, skillHome: home1, home: home1 });
  const projMix = allMix.projects.find((p) => p.name === safeName(basename(root1)));
  eq('symlink 根與子目錄混用只產出 1 張工作區卡（不拆兩張）', projMix?.cards?.length, 1);
  eq('同對話兩處訊息皆保留在同一張卡上（prompts === 2）', projMix?.sessions?.[0]?.prompts, 2);
  check('合併後的唯一卡抓得到根目錄外的 outside.js 且不誤報檢查不全',
    projMix?.cards?.[0]?.health?.list?.includes('outside.js') && projMix?.conflicts?.items?.length === 0,
    JSON.stringify({ cards: projMix?.cards?.length, list: projMix?.cards?.[0]?.health?.list, conflicts: projMix?.conflicts }));

  rmSync(symHost, { recursive: true, force: true });
  rmSync(mon1, { recursive: true, force: true });
  rmSync(home1, { recursive: true, force: true });
  r1.cleanup();

  // 2. P2/P13：A 的對話事件記在子目錄 sub、且已 commit src/shared.js；在 wtA（含 sub）跑 agy-pipeline 必須與儀表板／--todo／wtB 講同一句
  const e = makeWorktreeEnv();
  mkdirSync(join(e.wtA, 'sub'), { recursive: true });
  writeFileSync(join(e.wtA, 'src/shared.js'), 'A-committed\n');
  gitAt(e.wtA, T(-40 * MIN), 'add', 'src/shared.js');
  gitAt(e.wtA, T(-40 * MIN), 'commit', '-q', '-m', 'A committed shared');
  writeFileSync(join(e.wtB, 'src/shared.js'), 'B-dirty\n');

  writeFileSync(e.log, [
    { ts: T(-50 * MIN), hook: 'UserPrompt', session: 'sSubA', cwd: join(e.wtA, 'sub'), prompt: '子目錄施工 A', title: '子目錄施工 A' },
    { ts: T(-45 * MIN), hook: 'PostToolUse', session: 'sSubA', cwd: join(e.wtA, 'sub'), tool: 'edit_file', file: join(e.wtA, 'src/shared.js') },
    { ts: T(-30 * MIN), hook: 'UserPrompt', session: 'sMainB', cwd: e.wtB, prompt: '主目錄施工 B', title: '主目錄施工 B' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');

  const allSub = collectAll({ monitorDir: e.monitorDir, skillHome: e.home, home: e.home });
  const projSub = allSub.projects.find((p) => p.name === safeName(basename(e.main)));
  const expectedLine = projSub?.conflicts?.overlaps?.find((o) => o.files.includes('src/shared.js'))?.line ?? '';
  const todoSub = boardText(todoBoard(allSub)).join('\n');
  const cliSubB = e.runCli(e.wtB);
  const cliSubA = e.runCli(e.wtA);
  const cliSubAInSub = e.runCli(join(e.wtA, 'sub'));

  check('子目錄對話在儀表板與 --todo 測出 src/shared.js 重疊',
    Boolean(expectedLine) && todoSub.includes(expectedLine), JSON.stringify({ expectedLine, todoSub }));
  check('兄弟 worktree B、工作區 A 與工作區 A 子目錄三處終端機皆印出完全相同的重疊句，且不誤報 blind',
    cliSubB.includes(expectedLine) && cliSubA.includes(expectedLine) && cliSubAInSub.includes(expectedLine)
    && !cliSubA.includes('看不全已存改動') && !cliSubAInSub.includes('看不全已存改動'),
    JSON.stringify({ expectedLine, cliSubA, cliSubAInSub, cliSubB }));

  e.cleanup();
}

section('R1／P5／P10：問不到改動、dirty===null、blind、蓋章後未併主線（checkpoint-unmerged）與無衝突安靜不貼綠燈', 'P5');
{
  // 1. 單元級驗證各種檢查不全狀態與無重複 git 查詢
  const baseCard = (path, branch, extra = {}) => ({
    path, root: path, gone: false, notGit: false, branch, hasCommits: true,
    dirty: 0, dirtyFiles: [], health: { list: [] }, base: { kind: 'origin' }, scope: { blind: false },
    ladder: { steps: [{ id: 'commit', state: 'done' }, { id: 'merge', state: 'none' }, { id: 'push', state: 'none' }], unmerged: 0 },
    ...extra,
  });
  const sess = (id, cwd, title, extra = {}) => ({ id, cwd, title, lastTs: T(-60), closedAt: null, movedOn: null, ...extra });

  // 1a. health.list === null
  const cUnreadable = detectConflicts({
    cards: [baseCard('/w/1', 'b1', { health: { list: null } }), baseCard('/w/2', 'b2')],
    sessions: [sess('s1', '/w/1', '一'), sess('s2', '/w/2', '二')],
  });
  check('health.list === null → 顯示「有工作區問不到改動，衝突檢查不全」並點名「一」',
    cUnreadable.items.some((i) => i.kind === 'unknown' && i.text.includes('有工作區問不到改動，衝突檢查不全') && i.text.includes('一')),
    JSON.stringify(cUnreadable));

  // 1b. 已結案工作區 dirty === null，且無可用起點（blind=true）→ 標示「已結案、問不到有無未存檔」，絕不寫「仍有未存改動」且不誤觸 blind
  const cClosedNull = detectConflicts({
    cards: [
      baseCard('/w/1', 'b1'),
      baseCard('/w/2', 'b2', { dirty: null, dirtyFiles: null, scope: { blind: true }, base: { kind: 'head', why: 'no-origin' } }),
    ],
    sessions: [sess('s1', '/w/1', '進行中一'), sess('s2', '/w/2', '已結案二', { closedAt: T(-10) })],
  });
  check('已結案 dirty === null → 標成「已結案、問不到有無未存檔」，絕不寫「仍有未存改動」也不誤觸 blind（R1/P5）',
    cClosedNull.items.length === 1
    && cClosedNull.items[0].text.includes('已結案、問不到有無未存檔')
    && !cClosedNull.items[0].text.includes('仍有未存改動')
    && cClosedNull.incomplete.every((x) => x.reason === 'dirty-unknown'),
    JSON.stringify(cClosedNull));

  // 1c. 已結案有未存改動（dirty > 0）且無起點（scope.blind === true）→ 不誤觸 blind，完全可檢查
  const cClosedBlind = detectConflicts({
    cards: [
      baseCard('/w/1', 'b1', { health: { list: ['x.js'] } }),
      baseCard('/w/2', 'b2', { dirty: 1, dirtyFiles: ['y.js'], scope: { blind: true }, base: { kind: 'head', why: 'no-origin' } }),
    ],
    sessions: [sess('s1', '/w/1', '一'), sess('s2', '/w/2', '二', { closedAt: T(-10) })],
  });
  eq('已結案 dirty > 0 不誤觸 blind，且無重疊時回傳空清單', cClosedBlind.items.length, 0);

  // 1d. 活躍工作區 scope.blind === true + 另有重疊 → 兩邊同時呈現
  const cBoth = detectConflicts({
    cards: [
      baseCard('/w/1', 'b1', { health: { list: ['a.js'] }, dirty: 1, dirtyFiles: ['a.js'] }),
      baseCard('/w/2', 'b2', { health: { list: ['a.js'] }, dirty: 1, dirtyFiles: ['a.js'], scope: { blind: true } }),
    ],
    sessions: [sess('s1', '/w/1', '一'), sess('s2', '/w/2', '二')],
  });
  check('既有重疊又有看不全已存改動（blind）→ 兩邊同時顯示',
    cBoth.items.some((i) => i.kind === 'ask' && i.text.includes('a.js'))
    && cBoth.items.some((i) => i.kind === 'unknown' && i.text.includes('看不全已存改動')),
    JSON.stringify(cBoth));

  // 1e. 活躍工作區 checkpoint + unmerged > 0 → 顯示檢查不全警告；單工作區不觸發
  const cCp = detectConflicts({
    cards: [
      baseCard('/w/1', 'b1', { base: { kind: 'checkpoint' }, ladder: { unmerged: 2 } }),
      baseCard('/w/2', 'b2'),
    ],
    sessions: [sess('s1', '/w/1', '蓋過章的'), sess('s2', '/w/2', '另一條')],
  });
  check('活躍分支蓋章後尚有 unmerged > 0 → 顯示僅比對蓋章後改動、衝突檢查不全',
    cCp.items.some((i) => i.kind === 'unknown' && i.text.includes('僅比對蓋章後的改動') && i.text.includes('蓋過章的')),
    JSON.stringify(cCp));

  // 1e2. D 第 1 輪 R1/P5：蓋章後 ladder.unmerged === null 或 ladder === null（非 main 分支）不得靜默放行；onMain: true 則正常
  const cCpNull = detectConflicts({
    cards: [
      baseCard('/w/1', 'feat-cp-null', { base: { kind: 'checkpoint' }, ladder: { onMain: false, unmerged: null } }),
      baseCard('/w/2', 'feat-other'),
    ],
    sessions: [sess('s1', '/w/1', '問不到未併的'), sess('s2', '/w/2', '另一條')],
  });
  check('蓋章後 ladder.unmerged === null → 報「問不到有沒有未併回主線的存檔，衝突檢查不全」（R1/P5）',
    cCpNull.items.some((i) => i.kind === 'unknown' && i.text.includes('問不到有沒有未併回主線的存檔') && i.text.includes('問不到未併的')),
    JSON.stringify(cCpNull));
  const cCpMissingLadder = detectConflicts({
    cards: [
      baseCard('/w/1', 'feat-cp-noladder', { base: { kind: 'checkpoint' }, ladder: null }),
      baseCard('/w/2', 'feat-other'),
    ],
    sessions: [sess('s1', '/w/1', '無階梯'), sess('s2', '/w/2', '另一條')],
  });
  check('蓋章後 ladder === null → 同樣報「問不到有沒有未併回主線的存檔，衝突檢查不全」',
    cCpMissingLadder.items.some((i) => i.kind === 'unknown' && i.text.includes('問不到有沒有未併回主線的存檔') && i.text.includes('無階梯')),
    JSON.stringify(cCpMissingLadder));
  const cCpOnMain = detectConflicts({
    cards: [
      baseCard('/w/1', 'main', { base: { kind: 'checkpoint' }, ladder: { onMain: true, unmerged: 0 } }),
      baseCard('/w/2', 'feat-other'),
    ],
    sessions: [sess('s1', '/w/1', '在主線上'), sess('s2', '/w/2', '另一條')],
  });
  eq('在主線上（onMain: true）蓋章且無重疊 → 不誤報未併存檔警告', cCpOnMain.items.length, 0);

  // 1f. 僅有還原點（無任何對話紀錄）工作區
  const cStampOnly = detectConflicts({
    cards: [
      baseCard('/w/1', 'b1', { health: { list: ['x.js'] } }),
      baseCard('/w/2', 'b2', { dirty: 1, dirtyFiles: ['x.js'] }),
    ],
    sessions: [sess('s1', '/w/1', '對話一')],
  });
  check('僅有還原點工作區（無對話紀錄）標明「無對話紀錄但仍有未存改動」並抓出重疊',
    cStampOnly.overlaps.length === 1 && cStampOnly.overlaps[0].labels.some((l) => l.includes('無對話紀錄但仍有未存改動')),
    JSON.stringify(cStampOnly));

  // 1g. 白板無重疊但有檢查不全時：不收進 quiet、灰筆亮燈、不貼安全綠勾
  const pMock = {
    name: 'p', displayName: 'P', mainRoot: '/w/1', cards: [baseCard('/w/1', 'b1'), baseCard('/w/2', 'b2')],
    sessions: [], suggestions: [], conflicts: cUnreadable,
  };
  const bMock = todoBoard({ projects: [pMock] });
  const wbGray = uiOf({ projects: [pMock], todo: bMock, sharedLines: {}, stampHelp: {}, guardSupport: true, precheckSupport: true, escalateSupport: true, conflictSupport: true }).whiteboard(pMock);
  eq('有檢查不全時專案不收進 quiet', bMock.quiet, null);
  check('檢查不全時白板灰筆亮燈、紅筆不亮、絕不出現「無衝突」或「安全」字樣',
    /data-ink="gray" data-lit="1"/.test(wbGray) && /data-ink="red" data-lit="0"/.test(wbGray) && !/無衝突|安全|✅/.test(wbGray),
    wbGray);

  // 1h. 全部問得到且零重疊 → 安靜不顯示，不出現「無衝突／安全」
  const cClean = detectConflicts({
    cards: [baseCard('/w/1', 'b1', { health: { list: ['x.js'] } }), baseCard('/w/2', 'b2', { health: { list: ['y.js'] } })],
    sessions: [sess('s1', '/w/1', '一'), sess('s2', '/w/2', '二')],
  });
  eq('全問得到且無重疊 → items 空陣列', cClean.items.length, 0);
  check('全問得到且無重疊時白板不出現衝突或無衝突文字', !/檔案重疊|衝突檢查不全|無衝突/.test(boardText(todoBoard({ projects: [{ ...pMock, conflicts: cClean }] })).join('\n')));

  // 1i. movedOn 排除：舊租戶不被掛到衝突標籤上
  const cMoved = detectConflicts({
    cards: [baseCard('/w/1', 'b1', { health: { list: ['x.js'] } }), baseCard('/w/2', 'b2', { health: { list: ['x.js'] } })],
    sessions: [
      sess('sOld', '/w/1', '舊租戶', { movedOn: { at: T(-30) } }),
      sess('sNew', '/w/1', '新租戶'),
      sess('s2', '/w/2', '工作區二'),
    ],
  });
  check('movedOn 舊租戶標題不會出現在衝突標籤中',
    cMoved.overlaps.length === 1 && !JSON.stringify(cMoved).includes('舊租戶') && JSON.stringify(cMoved).includes('新租戶'),
    JSON.stringify(cMoved));

  // 1j. 三個工作區同撞 1 支檔：合併成 1 條 3 方條目，絕不展開成 3 組兩兩重疊
  const c3Way = detectConflicts({
    cards: [
      baseCard('/w/1', 'b1', { health: { list: ['core.js'] } }),
      baseCard('/w/2', 'b2', { health: { list: ['core.js'] } }),
      baseCard('/w/3', 'b3', { health: { list: ['core.js'] } }),
    ],
    sessions: [
      sess('s1', '/w/1', '對話一'),
      sess('s2', '/w/2', '對話二'),
      sess('s3', '/w/3', '對話三'),
    ],
  });
  eq('3 個工作區同撞 core.js 合併為 1 條重疊（不展開成 3 組 pair）', c3Way.overlaps.length, 1);
  check('3 方重疊條目同時列出三個對話並使用頓號與「與」',
    /「對話一」（b1）、「對話二」（b2） 與 「對話三」（b3）都動到 core\.js/.test(c3Way.overlaps[0]?.line ?? ''),
    c3Way.overlaps[0]?.line);
}

section('效能與隔離：lib/conflicts.mjs 零 git 呼叫，單工作區專案 projectConflictsFor 零額外 git 呼叫', 'P2');
{
  const conflictsSrc = readFileSync(join(ROOT, 'lib/conflicts.mjs'), 'utf8');
  check('lib/conflicts.mjs 不引入 child_process 或執行 git 的函式（只純粹消費現成資料）',
    !/child_process|execFile|spawn|\bgit\(|\bgitRaw\(|\bdirtyPaths\(/.test(conflictsSrc));

  const r = makeRepo({ at: T(-30 * MIN), files: { 'a.js': '1\n' } });
  const root = real(git(r.dir, 'rev-parse', '--show-toplevel'));
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-conf-perf-'));
  mkdirSync(join(monitorDir, 'logs'));
  mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const log = join(monitorDir, 'logs', `${safeName(basename(root))}.jsonl`);
  writeFileSync(log, JSON.stringify({ ts: T(-10 * MIN), hook: 'UserPrompt', session: 's1', cwd: root, prompt: '單工作區' }) + '\n');

  const traceFile = join(monitorDir, 'git-trace.log');
  const prevTrace = process.env.GIT_TRACE;
  process.env.GIT_TRACE = traceFile;
  try {
    withGitMemo(() => {
      const ctx = gitContext(root);
      const ev = loadEvents(join(monitorDir, 'logs'), ctx.project, { cwd: root });
      const info = gatherChange(ctx, ev);
      const facts = stageFacts(ctx, ev, info);
      const beforeBytes = statSync(traceFile).size;
      const out = projectConflictsFor({
        monitorDir, ctx, ev,
        current: { health: facts.health, base: facts.base, scope: changeScope(facts.base, ago), dirty: info.dirty, dirtyFiles: info.dirtyFiles },
      });
      const afterBytes = statSync(traceFile).size;
      eq('單工作區專案 projectConflictsFor 回傳空 items', out.items.length, 0);
      eq('單工作區專案 projectConflictsFor 執行期間 GIT_TRACE 零新增 git 呼叫', afterBytes, beforeBytes);
    });
  } finally {
    if (prevTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = prevTrace;
    rmSync(monitorDir, { recursive: true, force: true });
    r.cleanup();
  }
}

section('雙語同步（EN）：英文模式四處一致、無中文殘留、無紅線禁語、title===null 不重複分支名', 'P2');
{
  const e = makeWorktreeEnv();
  writeFileSync(join(e.wtA, 'src/a.js'), 'a-A\n');
  writeFileSync(join(e.wtA, 'src/b.js'), 'b-A\n');
  writeFileSync(join(e.wtA, 'src/c.js'), 'c-A\n');
  writeFileSync(join(e.wtA, 'src/d.js'), 'd-A\n');
  writeFileSync(join(e.wtB, 'src/a.js'), 'a-B\n');
  writeFileSync(join(e.wtB, 'src/b.js'), 'b-B\n');
  writeFileSync(join(e.wtB, 'src/c.js'), 'c-B\n');
  writeFileSync(join(e.wtB, 'src/d.js'), 'd-B\n');

  writeFileSync(e.log, [
    { ts: T(-20 * MIN), hook: 'UserPrompt', session: 'sA', cwd: e.wtA, prompt: 'Task A', title: 'Task A' },
    // sB 故意不給 title，測 EN 下也不會重複印成 feat-b (feat-b)
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 'sB', cwd: e.wtB, prompt: 'do work' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  // 寫假轉錄檔讓 sB 也沒有 title（沒有 transcript 就用 prompt 摘要；若連 prompt 也空就 title===null）
  writeFileSync(e.log, [
    { ts: T(-20 * MIN), hook: 'UserPrompt', session: 'sA', cwd: e.wtA, prompt: 'Task A', title: 'Task A' },
    { ts: T(-10 * MIN), hook: 'PostToolUse', session: 'sB', cwd: e.wtB, tool: 'edit_file', file: join(e.wtB, 'src/a.js') },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');

  const enAll = withLang('en', () => collectAll({ monitorDir: e.monitorDir, skillHome: e.home, home: e.home }));
  const enProj = enAll.projects.find((p) => p.name === safeName(basename(e.main)));
  const enBoard = withLang('en', () => todoBoard(enAll));
  const enTodo = withLang('en', () => boardText(enBoard).join('\n'));
  const enUi = uiOf({ ...enAll, todo: enBoard }, 'en');
  const enWb = unesc(enUi.whiteboard(enProj));
  const enPageA = unesc(enUi.sessionPage(enProj.name, 'sA'));
  const enCliA = e.runCli(e.wtA, 'en');

  const enText = enProj?.conflicts?.items?.map((x) => x.text).join('\n') ?? '';
  check('英文重疊文案採 Overlapping edits + and others (4 files)',
    enText.includes('Overlapping edits:') && enText.includes('and others (4 files)'), enText);
  check('英文無標題對話直用分支名 feat-b，不重複印成 feat-b (feat-b)',
    enText.includes('feat-b') && !enText.includes('feat-b (feat-b)'), enText);

  for (const item of enProj?.conflicts?.items ?? []) {
    check('EN 四處文案一字不差（collect / todo / whiteboard / sessionPage / CLI）',
      enTodo.includes(item.text) && enWb.includes(item.text) && enPageA.includes(item.text) && enCliA.includes(item.text),
      JSON.stringify({ item: item.text, wb: enWb, cli: enCliA }));
  }

  // 再測英文檢查不全幾種原因（cant-check / blind / checkpoint-unmerged / checkpoint-unmerged-unknown）
  const enIncomplete = withLang('en', () => detectConflicts({
    cards: [
      { path: '/w/1', root: '/w/1', gone: false, notGit: false, branch: 'b1', hasCommits: true, dirty: null, dirtyFiles: null, health: { list: [] } },
      { path: '/w/2', root: '/w/2', gone: false, notGit: false, branch: 'b2', hasCommits: true, dirty: 0, dirtyFiles: [], health: { list: [] }, scope: { blind: true } },
      { path: '/w/3', root: '/w/3', gone: false, notGit: false, branch: 'b3', hasCommits: true, dirty: 0, dirtyFiles: [], health: { list: [] }, base: { kind: 'checkpoint' }, ladder: { unmerged: 2 } },
      { path: '/w/4', root: '/w/4', gone: false, notGit: false, branch: 'b4', hasCommits: true, dirty: 0, dirtyFiles: [], health: { list: [] }, base: { kind: 'checkpoint' }, ladder: { onMain: false, unmerged: null } },
    ],
    sessions: [
      { id: 's1', cwd: '/w/1', title: 'One', lastTs: T(-40) },
      { id: 's2', cwd: '/w/2', title: 'Two', lastTs: T(-30) },
      { id: 's3', cwd: '/w/3', title: 'Three', lastTs: T(-20) },
      { id: 's4', cwd: '/w/4', title: 'Four', lastTs: T(-10) },
    ],
  }));
  const incText = enIncomplete.items.map((x) => x.text).join('\n');
  check('EN 檢查不全遵守 TERMS 用字（Couldn\'t check / Can\'t see all / not merged / unmerged-unknown）',
    incText.includes('Couldn\'t check') && incText.includes('Can\'t see all')
    && incText.includes('still have commits not merged into the main line')
    && incText.includes('couldn\'t check whether there are commits not merged into the main line'), incText);

  const cliConflictLines = enCliA.split('\n').filter((l) => /^⚠️ (Overlapping|Couldn't check|Can't see all|Some workspaces)/.test(l)).join('\n');
  const combinedEn = [enText, cliConflictLines, incText].join('\n');
  check('英文輸出完全無中文與全形空白', !CJK.test(combinedEn), combinedEn);
  check('英文輸出不出現紅線禁用詞（no conflicts / all clear / no problems / passed / verified / safe / works / not run）',
    !/\b(no conflicts|all clear|no problems|passed|verified|safe|works|not run)\b/i.test(combinedEn), combinedEn);

  e.cleanup();
}

process.exit(summary());
