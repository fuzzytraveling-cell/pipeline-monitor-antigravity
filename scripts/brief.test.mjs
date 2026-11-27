#!/usr/bin/env node
/**
 * brief.test.mjs —— 定時工地巡檢晨報（agy-pipeline --brief / --brief --quiet-if-clear）。
 * 釘的是會安靜說謊的地方：問不到講成沒事（R1/P5）、安靜模式誤靜音（P3/P5）、跨專案卡漏掉或算兩次（P2/P6）、
 * 拼錯參數靜默放行（P4）、偷跑重複 git、測試偷用本機環境（P8）、英文殘留中文或講禁語（P10）。
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { briefReport, parseBriefArgs, BRIEF_CARD_CAP } from '../lib/brief.mjs';
import { todoBoard, serveDownLine, serveSlowLine, serveOldLine } from '../lib/todo.mjs';
import { collectAll } from '../lib/collect.mjs';
import { doBrief } from '../lib/cliTodo.mjs';
import { withLang } from '../lib/lang.mjs';
import { describeFreshness } from '../lib/freshness.mjs';
import { createApp } from '../server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGO = () => '3 分鐘前';

/* ── 假資料：與 collectAll 回傳形狀一致 ── */
const step = (id, state, text) => ({ id, state, text });
const ladder = ({ commit = ['done', '都存好了'], merge = ['done', '併進 main 了（快轉,main 之後還沒動）'], push = ['done', 'GitHub 上的跟 main 一樣'] } = {}) =>
  ({ steps: [step('commit', ...commit), step('merge', ...merge), step('push', ...push)] });
const card = (o = {}) => ({ path: '/w/a', gone: false, notGit: false, ladder: ladder(), checkpoint: { commit: 'abc' }, checkpointRelation: { state: 'ok', commitsAfter: 0 }, stagesNote: null, ...o });
const stagesOf = (o = {}) => [
  { id: 'A', name: '寫規格', skill: 'spec', state: 'passed', doneBy: 'claude', doneAt: '2026-11-01T01:00:00.000Z',
    checklist: { parsed: true, total: 3, checked: 3, unmarked: 0, pending: 0 }, ...(o.A ?? {}) },
  { id: 'B', name: '寫程式', type: 'main-conversation', state: 'main', closedBy: 'checklist', nodAt: '2026-11-01T02:00:00Z', ...(o.B ?? {}) },
  { id: 'C', name: '打掃', skill: 'cleanup', state: 'none', rerun: null, ...(o.C ?? {}) },
  { id: 'D', name: '魔鬼教官', skill: 'chaos-check', state: 'done', doneBy: 'claude', ranAt: '2026-11-01T02:30:00Z',
    rerun: { state: 'ok', line: 'Claude 說：沒對到已知死法' }, ...(o.D ?? {}) },
  { id: 'E', name: '驗收', type: 'browser', state: 'none', rerun: { state: 'none', estate: 'none', line: '這一輪還沒走' }, ewhere: null, ...(o.E ?? {}) },
];
const MARK = { ok: '✅', ran: '⏸', missing: '⚠️', linked: '🔗' };
const req = (key, label, state, text) => ({ key, label, state, mark: MARK[state] ?? '❔', text });
const tierOk = (reqs = [], o = {}) => ({ state: 'ok', lines: { reqs, main: null, setupHint: '在這個專案的對話裡說「幫我設定分級」' }, staleNotes: [], ...o });
const D_OK = req('D', 'D 魔鬼教官', 'ok', '5 分鐘前跑過,Claude 說：沒對到已知死法');
const sess = (o = {}) => ({
  id: 's1', title: '做某件事', cwd: '/w/a', lastTs: '2026-11-01T03:00:00Z', lastSaidAt: '2026-11-01T01:30:00Z',
  closedAt: null, deletedAt: null, movedOn: null, unknownNote: null,
  stages: stagesOf(), tier: tierOk([D_OK]), card: card(), ...o,
});
const proj = (sessions, o = {}) => ({
  name: 'p', displayName: 'P 專案', mainRoot: '/w/main', optedOut: null, optedOutLine: null,
  emptyLine: null, cards: [card({ path: '/w/main' })], sessions, suggestions: [], conflicts: { items: [] }, ...o,
});
const makeAll = (projects, faults = {}) => ({
  projects,
  faults: { banner: [], sensor: null, moving: false, unreadableLine: null, ...faults },
});
const runBrief = (all, { restart = null, langState = 'ok', cardCap = BRIEF_CARD_CAP } = {}) =>
  briefReport(all, todoBoard(all, { restart, ago: AGO }), { langState, ago: AGO, cardCap });

section('AC-1:六大分區濃縮與單一真相來源——不重寫 git 查詢、跨專案建議卡只列一次、規格異常進問不到區', 'P2');
{
  const src = readFileSync(join(ROOT, 'lib', 'brief.mjs'), 'utf8');
  const gitImport = src.match(/import\s*\{([^}]+)\}\s*from\s*'\.\/git\.mjs'/)?.[1] ?? '';
  check('lib/brief.mjs 只從 ./git.mjs 匯入 ago，不直接呼叫任何 git 查詢／外部指令',
    /\bago\b/.test(gitImport) && !/gitContext|dirtyPaths|uncommitted|changeHealth|\bgit\b|\bgitRaw\b/.test(gitImport) && !/execFile|spawn/.test(src), gitImport);

  const closedDirty = sess({
    id: 'c1', title: '舊收尾', closedAt: '2026-11-01T04:00:00Z', cwd: '/w/c',
    card: card({ path: '/w/c', ladder: ladder({ commit: ['pending', '還有 1 個檔案沒存'] }) }),
  });
  const askAndTodo = sess({
    id: 's1', title: '修白板',
    stages: stagesOf({ D: { state: 'stale', rerun: { state: 'ask', line: '之後又改了程式檔，還沒再跑——要不要再跑由你決定' } } }),
    tier: tierOk([req('C', 'C 打掃', 'missing', '沒有紀錄'), D_OK], {
      staleNotes: ['⚠️ 這一輪碰到 1 個危險清單定好之後才新加的程式檔：lib/x.mjs——危不危險還沒有人判斷。'],
    }),
    card: card({ ladder: ladder({ commit: ['pending', '還有 2 個檔案沒存'] }) }),
  });
  const badSpecSess = sess({
    id: 's2', title: '規格失蹤中', cwd: '/w/b',
    stages: stagesOf({
      A: {
        state: 'done', doneBy: 'claude', doneAt: '2026-11-01T01:00:00Z',
        specPlace: { name: 'lost-spec', found: 'missing', given: 'docs/規劃中/lost-spec.md' },
        checklist: { parsed: false, missing: true, file: null, head: null },
      },
    }),
    tier: tierOk([]),
    card: card({ path: '/w/b', stagesNote: '⚠️ .agents/pipeline-stages.json 讀不懂，退回內建五關' }),
  });
  const sharedOlder = sess({
    id: 's3', title: '同資料夾較舊', cwd: '/w/d', lastTs: '2026-11-01T01:00:00Z',
    card: card({ path: '/w/d' }), tier: tierOk([]),
  });
  const sharedNewer = sess({
    id: 's4', title: '同資料夾較新', cwd: '/w/d', lastTs: '2026-11-01T02:00:00Z',
    card: card({ path: '/w/d' }), tier: tierOk([]),
  });

  const p1 = proj([closedDirty, askAndTodo, badSpecSess, sharedOlder, sharedNewer], {
    cards: [
      card({ path: '/w/main', ladder: ladder({ push: ['pending', 'main 有 3 個新存檔可以 push'] }) }),
      badSpecSess.card,
    ],
    conflicts: { items: [{ kind: 'ask', text: '「修白板」（feat）與「另一支」（other）都動到 lib/todo.mjs' }] },
    suggestions: [
      { id: 'k1', title: '接上階段三', ts: '2026-11-01T03:00:00Z', openIn: { project: null, name: '新專案資料夾' }, cut: [] },
      { id: 'k2', title: '已經開始的不列', ts: '2026-11-01T02:00:00Z', startedBy: 's1', cut: [] },
    ],
  });
  const r = runBrief(makeAll([p1], {
    banner: [{ tone: 'red', text: '🔴 這台電腦的感測器記不到東西' }],
    unreadableLine: '另有 2 筆看不懂的故障記號（時間或內容讀不懂）',
  }), { restart: '⚠️ 儀表板的服務還在跑舊程式——跑 agy-pipeline --serve-restart' });

  eq('有事項時 clear 為 false', r.clear, false);
  check('第 1 區包含故障橫條、unreadableLine、重啟與 stagesNote',
    r.sections.system.some((t) => t.includes('感測器記不到東西'))
    && r.sections.system.some((t) => t.includes('另有 2 筆看不懂的故障記號'))
    && r.sections.system.some((t) => t.includes('--serve-restart'))
    && r.sections.system.some((t) => t.includes('退回內建五關')));
  check('第 2 區包含已結案未存、跨 worktree 衝突與 main 未推',
    r.sections.loss.some((t) => t.includes('舊收尾') && t.includes('還有 1 個檔案沒存'))
    && r.sections.loss.some((t) => t.includes('都動到 lib/todo.mjs'))
    && r.sections.loss.some((t) => t.includes('main 有 3 個新存檔可以 push')));
  check('第 3 區包含等你決定與過期危險清單',
    r.sections.ask.some((t) => t.includes('要不要再跑由你決定'))
    && r.sections.ask.some((t) => t.includes('lib/x.mjs——危不危險還沒有人判斷')));
  check('第 4 區包含規格失蹤，且「規格失蹤中」不被誤列為可按結案',
    r.sections.unknown.some((t) => t.includes('規格失蹤') && t.includes('找不到規格檔 lost-spec.md'))
    && !r.sections.todo.some((t) => t.includes('規格失蹤中') && t.includes('可以按結案')));
  check('第 5 區濃縮進行中待辦且不印純說明「資料夾的事見……」',
    r.sections.todo.some((t) => t.includes('修白板') && t.includes('C 打掃：沒有紀錄') && t.includes('還有 2 個檔案沒存'))
    && !r.sections.todo.some((t) => t.includes('資料夾的事見')));
  check('第 6 區保留 openIn.project === null 的跨專案卡、排除已開始的卡，且指路對應專案資料夾',
    r.sections.cards.some((t) => t.includes('接上階段三') && t.includes('新專案資料夾'))
    && !r.sections.cards.some((t) => t.includes('已經開始的不列'))
    && r.sections.cards.some((t) => t.includes('在對應專案資料夾執行 agy-pipeline --cards')));

  // 建議卡超過上限時截短並附總張數
  const manyCards = Array.from({ length: 7 }, (_, idx) => ({ id: `m${idx}`, title: `待辦卡 ${idx + 1}`, ts: '2026-11-01T03:00:00Z', cut: [] }));
  const capped = runBrief(makeAll([proj([], { cards: [card({ path: '/w/main' })], suggestions: manyCards })]));
  check(`建議卡超過上限時只列前 ${BRIEF_CARD_CAP} 張並明講總數 7 張`,
    capped.sections.cards.length === BRIEF_CARD_CAP + 1 && capped.sections.cards[BRIEF_CARD_CAP].includes('共 7 張'),
    JSON.stringify(capped.sections.cards));
}

section('AC-2:安靜模式必抓（R1/P5）——任何問不到、壞掉或盲區都不准靜音', 'P5');
{
  const cleanClosed = sess({ id: 'done1', closedAt: '2026-11-01T04:00:00Z' });
  const mustWarn = [
    ['全機 0 個專案', makeAll([]), {}],
    ['儀表板連不上（serveDownLine）', makeAll([proj([cleanClosed])]), { restart: serveDownLine() }],
    ['儀表板忙碌逾時（serveSlowLine）', makeAll([proj([cleanClosed])]), { restart: serveSlowLine(10, '--brief') }],
    ['儀表板跑舊版（serveOldLine）', makeAll([proj([cleanClosed])]), { restart: serveOldLine() }],
    ['故障檔有看不懂的行（unreadableLine）', makeAll([proj([cleanClosed])], { unreadableLine: '另有 1 筆看不懂的故障記號' }), {}],
    ['語言設定讀不懂（broken）', makeAll([proj([cleanClosed])]), { langState: 'broken' }],
    ['語言設定無權限讀（unreadable）', makeAll([proj([cleanClosed])]), { langState: 'unreadable' }],
    ['專案感測器掛壞', makeAll([proj([], { cards: [card({ path: '/w/main', sensor: { mount: { state: 'broken' } } })] })]), {}],
    ['專案手動退出記錄（Oscar 拍板 #3）', makeAll([proj([], { optedOut: { at: '2026-11-01T00:00:00Z' }, optedOutLine: '這個專案已退出記錄' })]), {}],
    ['專案 emptyLine（未退出但無紀錄）', makeAll([proj([], { emptyLine: '90 天內沒有來自這裡的紀錄' })]), {}],
    ['孤兒已刪資料夾專案（無活卡無對話）', makeAll([proj([], { cards: [card({ path: '/w/gone', gone: true })] })]), {}],
    ['專案 stagesNote（stages.json 讀不懂）', makeAll([proj([], { cards: [card({ path: '/w/main', stagesNote: '⚠️ stages 讀不懂' })] })]), {}],
    ['進行中對話資料夾不在', makeAll([proj([sess({ card: card({ gone: true }) })])]), {}],
    ['進行中對話分級未設定', makeAll([proj([sess({ tier: { state: 'unset', lines: { setupHint: '幫我設定分級' } } })])]), {}],
    ['進行中對話分級讀不懂', makeAll([proj([sess({ tier: { state: 'broken', lines: { main: '讀不懂' } } })])]), {}],
    ['進行中對話三階梯問不到', makeAll([proj([sess({ card: card({ ladder: ladder({ commit: ['unknown', '問不到有沒有沒存的檔案'] }) }) })])]), {}],
    ['進行中對話章問不到', makeAll([proj([sess({ card: card({ checkpointRelation: { state: 'unknown' } }) })])]), {}],
    ['進行中對話含 unknownNote', makeAll([proj([sess({ unknownNote: '有 1 則訊息格式沒見過，沒算進你說的話' })])]), {}],
    ['進行中對話規格未解析出 AC（parsed: false）', makeAll([proj([sess({
      stages: stagesOf({ A: { state: 'done', doneBy: 'claude', doneAt: '2026-11-01T01:00:00Z', checklist: { parsed: false, missing: false, file: 'docs/規劃中/x.md', head: '# 標題' } } }),
      tier: tierOk([]),
    })])]), {}],
    ['跨 worktree 衝突檢查不全', makeAll([proj([cleanClosed], { conflicts: { items: [{ kind: 'unknown', text: '⚠️ 有工作區問不到改動，衝突檢查不全' }] } })]), {}],
    ['main 推了沒問不到', makeAll([proj([cleanClosed], { cards: [card({ path: '/w/main', ladder: ladder({ push: ['unknown', '問不到 main 跟 GitHub 差幾個存檔'] }) })] })]), {}],
    ['已結案對話還有檔案沒存', makeAll([proj([sess({ closedAt: '2026-11-01T04:00:00Z', card: card({ ladder: ladder({ commit: ['pending', '還有 1 個檔案沒存'] }) }) })])]), {}],
    ['進行中對話已無待辦可按結案（仍算有事）', makeAll([proj([sess({ tier: tierOk([]) })])]), {}],
  ];

  for (const [label, all, opt] of mustWarn) {
    const r = runBrief(all, opt);
    check(`必抓（不可靜音）：${label}`, r.clear === false && r.lines.length > 1, JSON.stringify(r));
  }
}

section('AC-2:安靜模式必放與拍板行為——純建議卡與 goneHidden 不單獨打破靜音，非安靜時照實列出', 'P3');
{
  const cleanClosed = sess({ id: 'c1', closedAt: '2026-11-01T04:00:00Z' });
  const pureClear = makeAll([proj([cleanClosed])]);
  const r0 = runBrief(pureClear);
  eq('至少 1 個專案且第 1～5 區皆空、服務在線 → clear === true', r0.clear, true);
  check('一般 --brief 在 clear 時印出已檢查專案數，不講通過／安全', r0.lines.join('\n').includes('已檢查 1 個專案') && !/通過|安全|passed|all clear|safe|✅|✓/i.test(r0.lines.join('\n')), r0.lines.join('\n'));

  // 只有還沒開始的建議卡（拍板 #2）→ clear 仍為 true（--quiet-if-clear 靜音），一般 --brief 照列建議卡
  const onlyCard = makeAll([proj([cleanClosed], {
    suggestions: [{ id: 'k1', title: '下週再做的點子', ts: '2026-11-01T03:00:00Z', cut: [] }],
  })]);
  const rCard = runBrief(onlyCard);
  eq('只有還沒開始的建議卡 → clear 仍為 true（不單獨打破靜音）', rCard.clear, true);
  check('……不帶 --quiet-if-clear 時照常列出那張建議卡', rCard.lines.join('\n').includes('下週再做的點子'), rCard.lines.join('\n'));

  const unusedDir = mkdtempSync(join(tmpdir(), 'pm-unused-'));
  const outQuiet = [];
  const codeQuiet = await doBrief(['--brief', '--quiet-if-clear'], {
    monitorDir: unusedDir,
    ask: async () => null,
    write: (l) => outQuiet.push(l),
  });
  rmSync(unusedDir, { recursive: true, force: true });
  // 用 briefReport 直接驗證 goneHidden（拍板 #4）
  const goneClosed = sess({ id: 'g1', closedAt: '2026-11-01T04:00:00Z', card: card({ path: '/w/gone', gone: true }) });
  const rGone = runBrief(makeAll([proj([cleanClosed, goneClosed])]));
  eq('有已結案且資料夾已刪（goneHidden）→ 不單獨打破靜音（clear === true）', rGone.clear, true);
  check('……一般 --brief 照實附註「資料夾已經不在的看不到」', rGone.lines.join('\n').includes('資料夾已經不在的看不到'), rGone.lines.join('\n'));
  check('doBrief 測試防呆輔助執行完成（0 專案不靜音）', codeQuiet === 0 && outQuiet.some((l) => l.includes('還看不到任何案件')));
}

section('AC-1.3:參數防呆正反向測試（P4）——只允許 --brief 與 --quiet-if-clear，拒收拼錯參數與 --lang', 'P4');
{
  const ok1 = parseBriefArgs(['--brief']);
  const ok2 = parseBriefArgs(['--brief', '--quiet-if-clear']);
  const ok3 = parseBriefArgs(['--quiet-if-clear', '--brief']);
  check('必放：--brief、--brief --quiet-if-clear、順序互換皆合法', ok1.ok && !ok1.quietIfClear && ok2.ok && ok2.quietIfClear && ok3.ok && ok3.quietIfClear);

  for (const bad of [['--brief', '--quiet'], ['--brief', '-q'], ['--brief', 'quiet-if-clear'], ['--brief', '--lang', 'en'], ['--brief', 'extra']]) {
    const res = parseBriefArgs(bad);
    check(`必抓：${bad.join(' ')} 應拒收並給錯誤訊息`, !res.ok && res.errorLine.includes('--quiet-if-clear'), JSON.stringify(res));
  }
}

section('AC-4:真實 CLI 與真實 git repo 整合測試（P8）——獨立假家目錄、非 git 可跑、0 bytes 靜音與不重複警示', 'P8');
{
  const home = mkdtempSync(join(tmpdir(), 'pm-brief-home-'));
  const dataHome = join(home, 'data');
  mkdirSync(join(dataHome, 'logs'), { recursive: true });
  mkdirSync(join(dataHome, 'checkpoints'), { recursive: true });

  // 起一個假的 /api/serve-state 回傳沒改過（changed: []）
  const srv = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      if (req.url === '/api/serve-state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ bootAt: new Date().toISOString(), changed: [] }));
      } else {
        res.writeHead(404); res.end();
      }
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = String(srv.address().port);
  const runCli = (args, cwd = home) => new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, 'status.mjs'), ...args], {
      cwd,
      env: { ...process.env, HOME: home, AGY_PIPELINE_HOME: dataHome, AGY_PIPELINE_PORT: port },
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });

  // 1. 0 專案且在非 git 目錄執行
  const zeroOut = await runCli(['--brief', '--quiet-if-clear'], tmpdir());
  eq('0 專案在非 git 目錄跑 --brief --quiet-if-clear：正常回 0', zeroOut.status, 0);
  check('……絕不靜音，照實講看不到任何案件', zeroOut.stdout.includes('還看不到任何案件'), zeroOut.stdout + zeroOut.stderr);

  // 2. 拼錯參數：--brief --quiet 與 --brief --lang en 不得執行也不得寫入 lang.json
  const badArg = await runCli(['--brief', '--lang', 'en']);
  eq('--brief --lang en 應回傳結束碼 1', badArg.status, 1);
  check('……印出不認得參數提示且沒寫 lang.json', badArg.stdout.includes('不認得'));
  check('……確實沒有建立 lang.json', (() => { try { readFileSync(join(dataHome, 'lang.json')); return false; } catch { return true; } })());

  // 3. 真實 repo：有未存新檔時必報；存檔並結案、無待辦時 --quiet-if-clear 輸出 0 bytes
  const repo = makeRepo({ files: { 'a.txt': 'x\n' } });
  writeFileSync(join(repo.dir, 'new.txt'), 'untracked\n');
  const logFile = join(dataHome, 'logs', `${basename(repo.dir)}.jsonl`);
  const t0 = new Date(Date.now() - 600_000).toISOString();
  const t1 = new Date(Date.now() - 300_000).toISOString();
  writeFileSync(logFile, [
    JSON.stringify({ ts: t0, hook: 'UserPromptSubmit', session: 's-real', cwd: repo.dir, prompt: '做一個測試' }),
    JSON.stringify({ ts: t1, hook: 'PostToolUse', tool: 'Write', session: 's-real', cwd: repo.dir, file: join(repo.dir, 'new.txt') }),
  ].join('\n') + '\n');

  const dirtyBrief = await runCli(['--brief', '--quiet-if-clear']);
  eq('真實 repo 有未存新檔：--brief --quiet-if-clear 不靜音', dirtyBrief.status, 0);
  check('……照實列出還有 1 個檔案沒存', dirtyBrief.stdout.includes('還有 1 個檔案沒存'), dirtyBrief.stdout);

  repo.git('add', '-A');
  repo.git('commit', '-qm', 'add new');
  appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: 'session_closed', session: 's-real', cwd: repo.dir, source: 'human' }) + '\n');

  const clearQuiet = await runCli(['--brief', '--quiet-if-clear']);
  eq('真實 repo 已存檔、無遠端、已結案、服務在線：--brief --quiet-if-clear 回傳 0', clearQuiet.status, 0);
  eq('……stdout 確實為 0 bytes 空輸出', clearQuiet.stdout, '');

  const clearNormal = await runCli(['--brief']);
  eq('同狀態不帶 --quiet-if-clear：回傳 0', clearNormal.status, 0);
  check('……誠實印出已檢查 1 個專案', clearNormal.stdout.includes('已檢查 1 個專案'), clearNormal.stdout);

  // 4. 真實 _sensor.jsonl 含壞行時絕不靜音
  writeFileSync(join(dataHome, 'logs', '_sensor.jsonl'), '{bad json line\n');
  const badFault = await runCli(['--brief', '--quiet-if-clear']);
  check('真實 _sensor.jsonl 含壞行：絕不靜音且印出看不懂的故障記號', badFault.status === 0 && badFault.stdout.includes('看不懂的故障記號'), badFault.stdout);
  rmSync(join(dataHome, 'logs', '_sensor.jsonl'), { force: true });

  // 5. lang.json 損壞時只印一次警告、不重複且不靜音
  writeFileSync(join(dataHome, 'lang.json'), '{broken');
  const brokenLang = await runCli(['--brief', '--quiet-if-clear']);
  eq('lang.json 損壞時 --brief --quiet-if-clear 只印一次語言警告且不靜音',
    (brokenLang.stdout.match(/語言設定讀不懂/g) ?? []).length, 1);

  await new Promise((r) => srv.close(r));
  repo.cleanup();
  rmSync(home, { recursive: true, force: true });
}

section('AC-3:中英雙語與三條紅線禁語（P10）——英文全段零中文、零全形空白、不含禁語', 'P10');
{
  const enAll = withLang('en', () => {
    const agoEn = () => '3 minutes ago';
    const closedDirty = sess({
      id: 'c1', title: 'Old task', closedAt: '2026-11-01T04:00:00Z', cwd: '/w/c',
      card: card({ path: '/w/c', ladder: ladder({ commit: ['pending', '1 file not committed yet'] }) }),
    });
    const openTask = sess({
      id: 's1', title: 'Fix board',
      stages: stagesOf({ D: { state: 'stale', name: 'Chaos check', rerun: { state: 'ask', line: 'whether to run it again is your call' } } }),
      tier: tierOk([req('C', 'C Cleanup', 'missing', 'no record')]),
      card: card({ ladder: ladder({ commit: ['pending', '2 files not committed yet'] }) }),
    });
    const all1 = makeAll([proj([closedDirty, openTask], {
      displayName: 'P',
      cards: [card({ path: '/w/main', ladder: ladder({ push: ['pending', 'main has 2 new commits to push'] }) })],
      suggestions: [{ id: 'k1', title: 'Next feature', ts: '2026-11-01T03:00:00Z', openIn: { project: 'q', name: 'Q' }, cut: [] }],
    })], { banner: [{ tone: 'red', text: '🔴 Sensor cannot record' }], unreadableLine: 'There is also 1 fault mark that can\'t be read' });
    const b1 = todoBoard(all1, { restart: serveSlowLine(10, '--brief'), ago: agoEn });
    const r1 = briefReport(all1, b1, { langState: 'broken', ago: agoEn });

    const allClear = makeAll([proj([
      sess({ id: 'c2', closedAt: '2026-11-01T04:00:00Z' }),
      sess({ id: 'g2', closedAt: '2026-11-01T04:00:00Z', card: card({ path: '/w/g', gone: true }) }),
    ], { displayName: 'P' })]);
    const b2 = todoBoard(allClear, { restart: null, ago: agoEn });
    const r2 = briefReport(allClear, b2, { langState: 'ok', ago: agoEn });
    const badArg = parseBriefArgs(['--brief', '--quiet']);
    return { t1: r1.lines.join('\n'), t2: r2.lines.join('\n'), bad: badArg.errorLine };
  });

  const combined = `${enAll.t1}\n${enAll.t2}\n${enAll.bad}`;
  check('英文輸出沒有中文與全形空白', !/[\u4e00-\u9fff\u3000]/.test(combined), combined);
  check('英文清零摘要與提示不含禁語（passed / all clear / verified / safe / ✓ / ✅）',
    !/\bpassed\b|\ball clear\b|\bverified\b|\bsafe\b|✓|✅/i.test(enAll.t2), enAll.t2);
  check('英文 serveSlowLine 指向 --brief', enAll.t1.includes('agy-pipeline --brief'), enAll.t1);
  check('英文清零含 goneHidden 附註', enAll.t2.includes('folders are gone can\'t be seen'), enAll.t2);
}

/* ════════════ 儀表板首頁工地晨報卡（方案 A，規格：dashboard-brief-card） ════════════ */

function uiOf(latest, { lang = 'zh', hash = '', fold = new Map() } = {}) {
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const body = src.replace(/^import .*$/m, '').replace(/^pollLoop\(\);$/m, '').replace(/^setInterval\(paintFreshness, 1000\);$/m, '');
  const noop = () => {};
  const els = {};
  const el = (id) => (els[id] ??= { dataset: {}, classList: { toggle: noop }, innerHTML: '', textContent: '', style: { setProperty: noop }, querySelectorAll: () => [],
    setAttribute: noop });
  const document = { getElementById: el, addEventListener: noop, body: el('body'), activeElement: null, documentElement: { dataset: { lang, theme: 'night' } } };
  const loc = { hash, reloads: 0, reload() { this.reloads++; } };
  const ls = {
    getItem: (k) => (k === 'pm-fold' ? JSON.stringify(Object.fromEntries(fold)) : null),
    setItem: (k, v) => { if (k === 'pm-fold') { const o = JSON.parse(v); fold.clear(); for (const [x, y] of Object.entries(o)) fold.set(x, y); } },
  };
  const ss = { getItem: () => null, setItem: noop, removeItem: noop };
  const make = new Function('describeFreshness', 'STALE_AFTER_SECONDS', 'document', 'window', 'localStorage', 'sessionStorage', 'location', 'setTimeout', 'setInterval', 'fetch', 'performance', 'console', '__LATEST',
    `${body}\nlatest = __LATEST;\nreturn { briefCard, projectList, render, oldServerBanner };`);
  const api = make(describeFreshness, 60, document, { addEventListener: noop }, ls, ss, loc, noop, noop,
    () => Promise.reject(new Error('測試不連網路')), { now: () => 0 }, { ...console, error: noop }, latest);
  return { ...api, els, loc, fold };
}

const escH = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

section('首頁晨報卡（AC-1～AC-4）:伺服器同步帶出 brief、與終端機同一份來源（P2）、頁頂項省略與 topOnly／建議卡不互斥（P5）', 'P2');
{
  const pSrc = proj([
    sess({ id: 's-ask', title: '有待拍板 <script>"x"</script>', stages: stagesOf({ D: { state: 'stale', rerun: { state: 'ask', line: '要不要再跑由你決定' } } }), tier: tierOk([D_OK]) }),
    sess({ id: 's-gone', title: '舊對話', closedAt: '2026-11-01T04:00:00Z', cwd: '/w/g', card: card({ path: '/w/g', gone: true }) }),
  ], {
    name: 'proj a',
    displayName: 'Proj A',
    cards: [
      card({ path: '/w/main', ladder: ladder({ push: ['pending', 'main 有 2 個新存檔可以 push'] }), stagesNote: '⚠️ stages 讀不懂' }),
    ],
    suggestions: [
      { id: 'sg1', title: '跨專案建議', ts: '2026-11-01T03:00:00Z', openIn: { project: 'proj-b', name: 'Proj B' }, cut: [] },
    ],
  });
  const all = makeAll([pSrc], {
    banner: [{ tone: 'red', text: '🔴 全機感測器壞了' }],
    unreadableLine: '另有 1 筆看不懂的故障記號',
  });
  const br = runBrief(all, { restart: '⚠️ 儀表板要重啟', langState: 'broken' });

  eq('copyText 與 lines.join("\\n") 完全一致', br.copyText, br.lines.join('\n'));
  check('結構化 groups 帶出正確 project／sessionId／onTopBanner／summary',
    br.groups.find((g) => g.id === 'system')?.items.some((i) => i.onTopBanner && i.text.includes('全機感測器壞了'))
    && br.groups.find((g) => g.id === 'system')?.items.some((i) => !i.onTopBanner && i.text.includes('看不懂的故障記號'))
    && br.groups.find((g) => g.id === 'ask')?.items.some((i) => i.project === 'proj a' && i.sessionId === 's-ask')
    && br.groups.find((g) => g.id === 'cards')?.items.some((i) => i.project === 'proj a' && !i.summary)
    && br.groups.find((g) => g.id === 'cards')?.items.some((i) => i.summary && !i.project));

  // 真實執行 ui/app.js：首頁看得到晨報卡在案件列表前；專案頁／對話頁不畫
  const homeUi = uiOf({ generatedAt: Date.now(), projects: [{ name: 'proj a', displayName: 'Proj A', cards: [], sessions: [], suggestions: [] }], brief: br }, { hash: '#/' });
  homeUi.render();
  const homeHtml = homeUi.els.app.innerHTML;
  check('首頁把晨報卡畫在案件列表上面', homeHtml.indexOf('class="brief-card"') !== -1 && homeHtml.indexOf('class="brief-card"') < homeHtml.indexOf('class="projects"'));
  check('複製鈕帶的是完整 copyText（含頁頂全機項）', homeHtml.includes(`data-copy="${escH(br.copyText)}"`));
  check('必抓:頁頂已畫的橫條（感測器壞了、語言設定、重啟）不在網頁晨報卡裡重複列出',
    !homeHtml.slice(homeHtml.indexOf('<div class="brief-body">')).includes('全機感測器壞了')
    && !homeHtml.slice(homeHtml.indexOf('<div class="brief-body">')).includes('語言設定讀不懂')
    && !homeHtml.slice(homeHtml.indexOf('<div class="brief-body">')).includes('儀表板要重啟'));
  check('頁頂沒畫的 unreadableLine 與 stagesNote 照樣保留在網頁晨報卡',
    homeHtml.includes('另有 1 筆看不懂的故障記號') && homeHtml.includes('stages 讀不懂'));
  check('對話條目連到 #/p/<proj>/s/<sid>、建議卡連回來源專案 #/p/<proj>、特殊字元安全跳脫',
    homeHtml.includes('href="#/p/proj%20a/s/s-ask"')
    && homeHtml.includes('href="#/p/proj%20a"')
    && !homeHtml.includes('<script>"x"</script>')
    && homeHtml.includes('&lt;script&gt;&quot;x&quot;&lt;/script&gt;'));
  check('建議卡尾行不掛連結', !/<li class="brief-sum"><a/.test(homeHtml));
  check('!clear 且有 goneHidden 時，卡片底部照印 goneNote', homeHtml.includes(escH(br.goneNote)));
  check('有非建議卡待留意項時，預設展開（open）', /<details class="brief-details" data-fold="home\|brief" open>/.test(homeHtml));

  // 使用者手動收起後存在 localStorage，重畫不跳回展開
  const foldUi = uiOf({ generatedAt: Date.now(), projects: [], brief: br }, { fold: new Map([['home|brief', false]]) });
  check('手動收起記在 localStorage 後，重畫照舊收起', !/<details class="brief-details" data-fold="home\|brief" open>/.test(foldUi.briefCard()));

  // 專案頁與對話頁不畫晨報卡
  homeUi.loc.hash = '#/p/proj%20a';
  homeUi.render();
  check('專案頁不重複畫晨報卡', !homeUi.els.app.innerHTML.includes('class="brief-card"'));

  // 僅有頁頂提醒（topOnly）時：印出 topOnlyLine、不畫空框、預設收起
  const topOnlyBr = runBrief(makeAll([proj([sess({ id: 'c1', closedAt: '2026-11-01T04:00:00Z' })])], {
    banner: [{ tone: 'amber', text: '🟡 僅頁頂橫條' }],
  }));
  const topOnlyHtml = uiOf({ generatedAt: Date.now(), projects: [], brief: topOnlyBr }).briefCard();
  check('僅剩頁頂橫條時：印出 topOnlyLine、預設收起、不畫空框',
    topOnlyHtml.includes(escH(topOnlyBr.topOnlyLine)) && !/<details class="brief-details"[^>]* open>/.test(topOnlyHtml), topOnlyHtml);

  // clear === true 但有建議卡（預審 #1）：同時印 clearLine 與建議卡、預設收起、無綠燈與禁語
  const clearWithCardBr = runBrief(makeAll([proj([sess({ id: 'c1', closedAt: '2026-11-01T04:00:00Z' })], {
    suggestions: [{ id: 'sg2', title: '待開工卡', ts: '2026-11-01T03:00:00Z', cut: [] }],
  })]));
  const clearCardHtml = uiOf({ generatedAt: Date.now(), projects: [], brief: clearWithCardBr }).briefCard();
  check('clear === true 且有建議卡時：同時印出 clearLine 與建議卡（不互斥）',
    clearCardHtml.includes(escH(clearWithCardBr.clearLine)) && clearCardHtml.includes('待開工卡') && !/<details class="brief-details"[^>]* open>/.test(clearCardHtml), clearCardHtml);
  check('清零狀態無綠燈與禁語（green/mint/agent-c/passed/all clear/safe/✓/✅）',
    !/green|mint|agent-c|passed|all clear|safe|✓|✅/i.test(clearCardHtml));

  // !latest / 舊服務無 brief / brief: null（預審 #3）
  eq('latest 為 null 時 briefCard 回空字串不爆錯', uiOf(null).briefCard(), '');
  const noBriefHtml = uiOf({ generatedAt: Date.now(), projects: [] }).briefCard();
  const nullBriefHtml = uiOf({ generatedAt: Date.now(), projects: [], brief: null }).briefCard();
  check('舊服務缺 brief 或 brief 為 null 時明講服務還在跑舊的程式',
    /--serve-restart/.test(noBriefHtml) && /--serve-restart/.test(nullBriefHtml), noBriefHtml + nullBriefHtml);

  // 真實 createApp() /api/status 回傳 brief
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-brief-srv-'));
  mkdirSync(join(monitorDir, 'logs'));
  const srv = createApp({ monitorDir, statusShareMs: 0 });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const srvPort = srv.address().port;
  const statusJson = await new Promise((resolve, reject) => {
    const rq = httpRequest({ host: '127.0.0.1', port: srvPort, method: 'GET', path: '/api/status', headers: { host: `127.0.0.1:${srvPort}` } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b)));
    });
    rq.on('error', reject); rq.end();
  });
  check('/api/status 帶有結構完整的 brief 欄位',
    !!statusJson.brief && typeof statusJson.brief.copyText === 'string' && Array.isArray(statusJson.brief.groups), JSON.stringify(statusJson.brief));
  await new Promise((r) => srv.close(r));
  rmSync(monitorDir, { recursive: true, force: true });
}

section('軟整併 AC-4/AC-2：晨報第 6 區收錄任務板 ready、真實總數徽章、與任務板異常/unknown 打破安靜（預審 #2/#3）', 'P2');
{
  const cleanClosed = sess({ id: 'c1', closedAt: '2026-11-01T04:00:00Z' });
  // 僅任務板 ready 任務：第 6 區標題／尾行／徽章皆指誠實任務板，clear 仍為 true
  const taskOnlyAll = makeAll([proj([cleanClosed], {
    name: 'tb-only',
    displayName: 'TB Only',
    taskBoard: {
      state: 'ok',
      entryMode: 'task-board',
      total: 1,
      counts: { ready: 1, unknown: 0 },
      columns: { ready: [{ id: 'T-10', epic: 'UI', title: '升級任務板', spec: 'up' }] },
    },
  })]);
  const rTaskOnly = runBrief(taskOnlyAll);
  eq('僅有任務板可開工任務 → clear 仍為 true（不單獨打破靜音）', rTaskOnly.clear, true);
  check('僅任務板可開工 → 標題、尾行指路 --tasks 且列出任務',
    rTaskOnly.lines.join('\n').includes('【可開工的待辦項目（誠實任務板）】')
    && rTaskOnly.lines.join('\n').includes('T-10 [UI] 「升級任務板」（任務板可開工）')
    && rTaskOnly.lines.join('\n').includes('agy-pipeline --tasks 查看詳情'), rTaskOnly.lines.join('\n'));
  const taskBadgeHtml = uiOf({ generatedAt: Date.now(), projects: [], brief: rTaskOnly }).briefCard();
  check('首頁 briefCard 徽章顯示「可開工任務 1 項」', taskBadgeHtml.includes('可開工任務 1 項'), taskBadgeHtml);

  // 任務板 ready + 建議卡並存超過 BRIEF_CARD_CAP（5）：總數為 7（任務 4、建議卡 3），briefCard 徽章不得被截短成 5
  const mixedTasks = Array.from({ length: 4 }, (_, i) => ({ id: `T-${i + 1}`, title: `任務 ${i + 1}` }));
  const mixedCards = Array.from({ length: 3 }, (_, i) => ({ id: `sg-${i + 1}`, title: `建議卡 ${i + 1}`, ts: '2026-11-01T03:00:00Z', cut: [] }));
  const mixedAll = makeAll([proj([cleanClosed], {
    name: 'tb-mix',
    displayName: 'TB Mix',
    taskBoard: {
      state: 'ok',
      entryMode: 'task-board',
      total: 4,
      counts: { ready: 4, unknown: 0 },
      columns: { ready: mixedTasks },
    },
    suggestions: mixedCards,
  })]);
  const rMixed = runBrief(mixedAll);
  check('並存超過上限時只列前 5 筆並印總數 7 項（任務 4 項、建議卡 3 張）',
    rMixed.sections.cards.length === BRIEF_CARD_CAP + 1
    && rMixed.sections.cards[BRIEF_CARD_CAP].includes('共 7 項（任務 4 項、建議卡 3 張'), JSON.stringify(rMixed.sections.cards));
  const mixedHtml = uiOf({ generatedAt: Date.now(), projects: [], brief: rMixed }).briefCard();
  check('首頁 briefCard 徽章顯示真實總數 7（不被截短為 5）',
    mixedHtml.includes('可開工 7 項（任務 4、建議卡 3）'), mixedHtml);

  // 任務板 broken / unreadable / no-main / counts.unknown > 0 → 進問不到區且打破靜音（clear === false）
  for (const [label, tb] of [
    ['broken', { state: 'broken', entryMode: 'unknown', note: 'JSON 壞掉' }],
    ['unreadable', { state: 'unreadable', entryMode: 'unknown', note: '無權限讀' }],
    ['no-main', { state: 'no-main', entryMode: 'unknown', note: '找不到主資料夾' }],
    ['counts.unknown > 0', { state: 'ok', entryMode: 'task-board', total: 1, counts: { ready: 0, unknown: 1 }, columns: { ready: [] } }],
  ]) {
    const r = runBrief(makeAll([proj([cleanClosed], { taskBoard: tb })]));
    check(`任務板 ${label} → 進 unknown 區且禁止靜音（clear === false）`,
      r.clear === false && r.sections.unknown.some((t) => t.includes('誠實任務板')), JSON.stringify(r));
  }
}

section('D1 回歸（P8）：真實 collectAll() 下已結案刪檔專案與 90 天清空空檔不誤報為 no-main 任務板異常', 'P8');
{
  const monDir = mkdtempSync(join(tmpdir(), 'pm-brief-nomain-'));
  try {
    mkdirSync(join(monDir, 'logs'), { recursive: true });
    mkdirSync(join(monDir, 'checkpoints'), { recursive: true });
    const t = new Date(Date.now() - 60_000).toISOString();

    // 1. 已結案且資料夾已刪（goneHidden）→ mainRoot === null, taskBoard.state === 'no-main'，但不得打破靜音或誤報任務板異常
    const goneClosedDir = join(monDir, 'gone-closed-repo');
    writeFileSync(join(monDir, 'logs', 'old-closed.jsonl'), [
      JSON.stringify({ ts: t, hook: 'UserPromptSubmit', session: 's-gc', cwd: goneClosedDir, prompt: '舊專案收尾' }),
      JSON.stringify({ ts: t, event: 'session_closed', session: 's-gc', cwd: goneClosedDir, source: 'human' }),
    ].join('\n') + '\n');
    const allGc = collectAll({ monitorDir: monDir, home: monDir, skillHome: monDir });
    eq('old-closed 在真實 collectAll() 下確實推導為 no-main', allGc.projects[0]?.taskBoard?.state, 'no-main');
    const brGc = briefReport(allGc, todoBoard(allGc, { ago: AGO }), { ago: AGO });
    check('已結案且資料夾已刪（old-closed）→ 不打破靜音（clear === true）、不誤報任務板異常、保留 goneHidden 說明',
      brGc.clear === true && brGc.goneHidden === true && brGc.sections.unknown.length === 0
      && brGc.lines.join('\n').includes('已結案且資料夾已經不在的看不到'), JSON.stringify(brGc));

    // 2. 90 天清空空檔（emptyLine）→ clear === false 只印 90 天說明，不重複印誠實任務板異常
    rmSync(join(monDir, 'logs', 'old-closed.jsonl'), { force: true });
    writeFileSync(join(monDir, 'logs', 'expired-empty.jsonl'), '');
    const allExp = collectAll({ monitorDir: monDir, home: monDir, skillHome: monDir });
    const brExp = briefReport(allExp, todoBoard(allExp, { ago: AGO }), { ago: AGO });
    check('90 天清空空檔（expired-empty）→ 保留 90 天說明且不重複印誠實任務板異常',
      brExp.clear === false
      && brExp.sections.unknown.some((u) => u.includes('90 天內沒有任何對話紀錄'))
      && !brExp.sections.unknown.some((u) => u.includes('誠實任務板')), JSON.stringify(brExp));

    // 3. 仍有未結案進行中對話但資料夾已刪（active-gone）→ 照樣進 unknown 並保持 clear === false
    rmSync(join(monDir, 'logs', 'expired-empty.jsonl'), { force: true });
    const activeGoneDir = join(monDir, 'active-gone-repo');
    writeFileSync(join(monDir, 'logs', 'active-gone.jsonl'),
      JSON.stringify({ ts: t, hook: 'UserPromptSubmit', session: 's-ag', cwd: activeGoneDir, prompt: '進行中但資料夾不見' }) + '\n');
    const allAg = collectAll({ monitorDir: monDir, home: monDir, skillHome: monDir });
    const brAg = briefReport(allAg, todoBoard(allAg, { ago: AGO }), { ago: AGO });
    check('有未結案對話且資料夾已刪（active-gone）→ 仍告警且 clear === false',
      brAg.clear === false && brAg.sections.unknown.some((u) => u.includes('誠實任務板')), JSON.stringify(brAg));

    // 4. 孤兒已刪資料夾（只有 checkpoint、無紀錄檔無對話）→ 保留「找不到還在的資料夾」，不重複列誠實任務板異常
    rmSync(join(monDir, 'logs', 'active-gone.jsonl'), { force: true });
    const orphanDir = join(monDir, 'orphan-gone-repo');
    writeFileSync(join(monDir, 'checkpoints', 'orphan-gone__main.json'),
      JSON.stringify({ worktree: orphanDir, commit: 'abc1234', branch: 'main' }));
    const allOrp = collectAll({ monitorDir: monDir, home: monDir, skillHome: monDir });
    const brOrp = briefReport(allOrp, todoBoard(allOrp, { ago: AGO }), { ago: AGO });
    check('孤兒已刪資料夾（無活卡無對話）→ 只報找不到還在的資料夾，不重複列誠實任務板異常',
      brOrp.clear === false
      && brOrp.sections.unknown.some((u) => u.includes('找不到還在的資料夾'))
      && !brOrp.sections.unknown.some((u) => u.includes('誠實任務板')), JSON.stringify(brOrp));
  } finally {
    rmSync(monDir, { recursive: true, force: true });
  }
}

process.exit(summary());
