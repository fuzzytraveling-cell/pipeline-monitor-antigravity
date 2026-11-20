/**
 * tier.test.mjs —— 分級設定與雙路徑（.agents/pipeline-stages.json 優先，.claude/ 相容 fallback）
 * 以及 remind.sh（Antigravity SessionStart injectSteps 契約）。
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, utimesSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  readTierConfig, computeTier, manualTier, requirementStatus, candidateFiles, buildTier, proposeCodeArea, staleLines, tierLines,
} from '../lib/tier.mjs';
import { describeTier } from '../lib/cliTier.mjs';
import { rerunOf } from '../lib/rounds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).tierLevels;
const cfgFile = (dir, obj, folder = '.agents') => {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, 'pipeline-stages.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
};

section('設定檔雙路徑：優先 .agents/pipeline-stages.json，相容 fallback .claude/pipeline-stages.json');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n', 'lib/b.js': '2\n' } });
  eq('兩邊都沒有 → unset', readTierConfig(r.dir, null, ROOT).state, 'unset');
  cfgFile(r.dir, { tiers: { code: ['lib/'] } }, '.claude');
  const fromClaude = readTierConfig(r.dir, null, ROOT);
  check('只有 .claude/pipeline-stages.json → fallback 讀得到', fromClaude.state === 'ok' && fromClaude.config.code[0] === 'lib/' && fromClaude.from.endsWith('.claude/pipeline-stages.json'), JSON.stringify(fromClaude));

  // --tier-checked 寫回既有的 .claude/pipeline-stages.json，不平白多建第二份檔
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-')), home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  execFileSync('node', [join(ROOT, 'status.mjs'), '--tier-checked', '維持舊檔'], { cwd: r.dir, env: { ...process.env, AGY_PIPELINE_LOG_DIR: logDir, HOME: home } });
  check('--tier-checked 寫回既有 .claude/pipeline-stages.json 且不另建 .agents/pipeline-stages.json',
    JSON.parse(readFileSync(join(r.dir, '.claude', 'pipeline-stages.json'), 'utf8')).tiers.checked?.said === '維持舊檔'
    && !existsSync(join(r.dir, '.agents', 'pipeline-stages.json')));

  // 兩邊同時存在時 .agents/ 優先
  cfgFile(r.dir, { tiers: { code: ['src/'] } }, '.agents');
  const fromAgents = readTierConfig(r.dir, null, ROOT);
  check('兩邊都在時 .agents/pipeline-stages.json 優先', fromAgents.state === 'ok' && fromAgents.config.code[0] === 'src/' && fromAgents.from.endsWith('.agents/pipeline-stages.json'));
  for (const d of [logDir, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('設定檔的狀態：沒設定／不分級／讀不懂／設好了——四種各自一張臉');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  eq('沒有檔案 → unset', readTierConfig(r.dir, null, ROOT).state, 'unset');
  cfgFile(r.dir, { stages: [] });
  eq('有檔案但沒有 tiers → 還是 unset', readTierConfig(r.dir, null, ROOT).state, 'unset');
  cfgFile(r.dir, { tiers: { off: true, at: '2026-11-13T00:00:00Z', why: '純文件' } });
  const off = readTierConfig(r.dir, null, ROOT);
  check('明講不分級 → off，而且留著理由', off.state === 'off' && off.off.why === '純文件');
  cfgFile(r.dir, '{ 壞掉的');
  eq('讀不懂 → broken', readTierConfig(r.dir, null, ROOT).state, 'broken');
  cfgFile(r.dir, { tiers: { code: [] } });
  eq('程式區空的 → broken', readTierConfig(r.dir, null, ROOT).state, 'broken');
  cfgFile(r.dir, { tiers: { code: ['src'] } });
  const ok = readTierConfig(r.dir, null, ROOT);
  check('設好了 → ok；補斜線；預設空 danger', ok.state === 'ok' && ok.config.code[0] === 'src/' && ok.config.danger.length === 0 && ok.config.levels.danger.id === LEVELS.danger.id);
  cfgFile(r.dir, { tiers: { code: ['src/'], levels: { none: { id: '甲' }, code: { id: '乙', requires: ['D'] }, danger: { id: '丙' } } } });
  eq('專案自己的 levels 優先', readTierConfig(r.dir, null, ROOT).config.levels.code.id, '乙');
  const lv = (requires) => ({ none: { id: '甲' }, code: { id: '乙', requires }, danger: { id: '丙' } });
  for (const [label, tiers] of [['程式區裡有一條是 null', { code: [null] }], ['危險清單裡有一條是數字', { code: ['src/'], danger: [3] }], ['要跑的關寫成數字', { code: ['src/'], levels: lv(5) }], ['要跑的關裡有 null', { code: ['src/'], levels: lv([null]) }]]) {
    cfgFile(r.dir, { tiers });
    const b = readTierConfig(r.dir, null, ROOT);
    check(`${label} → broken`, b.state === 'broken' && typeof b.why === 'string' && b.why.length > 0);
    writeFileSync(join(r.dir, 'a.js'), `${label}\n`);
    let term = '';
    try { term = execFileSync('node', [join(ROOT, 'status.mjs')], { cwd: r.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'pm-home-')), AGY_PIPELINE_LOG_DIR: mkdtempSync(join(tmpdir(), 'pm-log-')) } }); }
    catch (e) { term = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
    check(`${label} → 終端機不印程式錯誤，講讀不懂`, !/TypeError|at file:|Error:/.test(term) && term.includes(b.why ?? ''), term.slice(-500));
  }
  cfgFile(r.dir, { tiers: { code: ['src/'] } });
  const wt = makeRepo({ files: { 'a.js': '1\n' } });
  eq('worktree 沒有設定 → 找主資料夾', readTierConfig(wt.dir, r.dir, ROOT).state, 'ok');
  r.cleanup(); wt.cleanup();
}

const CFG = { code: ['src/'], danger: ['src/utils/store.js', 'src/data/'], levels: LEVELS };

section('機器算的那一級與人調高');
{
  eq('沒碰到程式區 → T0', computeTier(['README.md', 'docs/a.md'], CFG).rank, 0);
  const t1 = computeTier(['src/a.js', 'README.md'], CFG);
  check('碰到程式區 → T1', t1.rank === 1 && t1.hits.code[0] === 'src/a.js');
  const t2 = computeTier(['src/utils/store.js', 'src/a.js'], CFG);
  check('碰到危險清單 → T2', t2.rank === 2 && t2.hits.danger[0] === 'src/utils/store.js');
  eq('危險清單可以是整個資料夾', computeTier(['src/data/x.js'], CFG).rank, 2);
  eq('srcx/ 不算 src/', computeTier(['srcx/a.js'], CFG).rank, 0);

  const T2 = LEVELS.danger.id, T0 = LEVELS.none.id;
  const ev = (o) => ({ cwd: '/x', ...o });
  const set = ev({ ts: '2026-11-13T01:00:00Z', event: 'tier_set', level: T2, why: '重寫', head: 'abc1234' });
  check('沒章、HEAD 沒動 → 算數', manualTier([set], '/x', { cpUsable: false, head: 'abc1234' })?.id === T2);
  eq('沒章、存檔了且無起點 → 歸零', manualTier([set], '/x', { cpUsable: false, head: 'def5678' }), null);
  check('這一輪開始後調高、之後存檔 → 還算數', manualTier([set], '/x', { cpUsable: false, head: 'def5678', originAt: '2026-11-13T00:30:00Z' })?.id === T2);
  eq('有章、蓋章在調高之後 → 歸零', manualTier([set], '/x', { cpUsable: true, cpAt: '2026-11-13T02:00:00Z' }), null);
  eq('收回 → null', manualTier([set, ev({ ts: '2026-11-13T01:30:00Z', event: 'tier_retracted' })], '/x', { cpUsable: false, head: 'abc1234' }), null);

  const r = makeRepo({ files: { 'src/a.js': '1\n' } });
  cfgFile(r.dir, { tiers: { code: ['src/'] } });
  const low = ev({ ts: '2026-11-13T01:00:00Z', event: 'tier_set', level: T0, why: '小改', head: 'abc1234' });
  const t = buildTier({ root: r.dir, mainRoot: null, monitorDir: ROOT, health: { files: 1, list: ['src/a.js'], touchedTests: 0 },
    stages: [], perStage: new Map(), cleared: new Map(), events: [{ ...low, cwd: r.dir }], cwd: r.dir, cpUsable: false, cpAt: null, head: 'abc1234' });
  check('往下調不採用但記 manualIgnored', t.manual === null && t.manualIgnored?.id === T0);
  const blind = { kind: 'head', why: 'not-found', origin: null };
  const unseen = buildTier({ root: r.dir, mainRoot: null, monitorDir: ROOT, health: { files: 0, list: [], touchedTests: 0 },
    stages: [], perStage: new Map(), cleared: new Map(), events: [], cwd: r.dir, cpUsable: false, cpAt: null, head: 'abc1234', basis: blind });
  eq('只看得到未存檔且為 0 → unseen', unseen.state, 'unseen');
  r.cleanup();
}

section('「需要」那幾項：AI 說的標 AI 說，不講通過');
{
  const stagesD = [{ id: 'D', name: '魔鬼教官', skill: 'chaos-check', rerunAfterChange: true }, { id: 'C', name: '打掃', skill: 'cleanup' }];
  const ps = new Map([['D', { ts: '2026-11-16T01:00:00Z' }], ['C', { ts: '2026-11-16T01:00:00Z' }]]);
  const reports = new Map([['C', { ts: '2026-11-16T02:00:00Z', verdict: 'ok', note: '列了 3 條' }]]);
  const call = { ts: '2026-11-16T01:00:00Z', session: 's1' };
  const okRep = { ts: '2026-11-16T02:00:00Z', stage: 'D', verdict: 'ok', note: '沒對到' };
  const judged = (o) => new Map([['D', rerunOf({ calls: [call], reports: [okRep], ...o })]]);
  const R = (rerun) => Object.fromEntries(requirementStatus(['D', 'C'], { stages: stagesD, perStage: ps, cleared: new Map(), health: null, reports, rerun }).map((x) => [x.key, x]));
  const rr = R(judged({}));
  check('AI 說沒問題 → ok，且講 AI 說', rr.D.state === 'ok' && rr.D.detail.includes('AI 說'), rr.D.detail);
  const stale = R(judged({ lastEdit: '2026-11-16T03:00:00Z' }));
  check('D 之後改檔 → ran，說要不要再跑由你決定', stale.D.state === 'ran' && stale.D.detail.includes('要不要再跑由你決定'), stale.D.detail);
  eq('C 不因改檔過期 → ok', stale.C.state, 'ok');
  eq('候選提醒只提程式區裡像會存東西、不在清單的', candidateFiles(['src/services/specStore.ts', 'src/utils/store.js', 'src/components/Bar.tsx', 'docs/export.md'], CFG).join(','), 'src/services/specStore.ts');
}

section('整支 CLI：--tier-init 寫到 .agents/pipeline-stages.json、--tier、--tier-retract、--tier-off');
{
  const r = makeRepo({ pkg: { name: 'x', main: 'src/index.js' }, files: { 'src/index.js': '1\n', '.gitignore': '.agents/\n' } });
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-')), home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  const run = (...args) => {
    try { return { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, AGY_PIPELINE_LOG_DIR: logDir, HOME: home } }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout ?? '') }; }
  };
  const init = run('--tier-init');
  check('寫出骨架，程式區 src/，危險清單空的', init.code === 0 && init.out.includes('src/') && init.out.includes('危險清單：空的'), init.out);
  check('被 gitignore → 明講不會進版控，並給 !.agents/pipeline-stages.json', init.out.includes('不會進版控') && init.out.includes('!.agents/pipeline-stages.json'), init.out);
  const cfg = JSON.parse(readFileSync(join(r.dir, '.agents', 'pipeline-stages.json'), 'utf8'));
  check('檔案真的寫在 .agents/pipeline-stages.json', cfg.tiers.code[0] === 'src/' && cfg.tiers.danger.length === 0);
  writeFileSync(join(r.dir, 'src', 'index.js'), '2\n');
  eq('--tier 沒理由 → 失敗', run('--tier', LEVELS.danger.id).code, 1);
  check('--tier T2 理由 → 記下', run('--tier', LEVELS.danger.id, '重寫了整個上傳流程').out.includes('記下了'));
  check('--tier-retract → 收回', run('--tier-retract').out.includes('收回了'));
  check('--tier-off → 記下不分級', run('--tier-off', '純文件專案').out.includes('不分級'));
  for (const d of [logDir, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('危險清單會過期：.agents/ 與 .claude/ 兩條路都能查 git 歷史、判斷過記 by:ai / by:human 與快照', 'P3');
{
  const NOW = Date.now();
  const H = (h) => new Date(NOW - h * 3600_000).toISOString();
  for (const folder of ['.agents', '.claude']) {
    const relCfg = `${folder}/pipeline-stages.json`;
    const r = makeRepo({ at: H(10), files: { 'src/a.js': '1\n', 'src/store.js': 's\n', [relCfg]: JSON.stringify({ tiers: { code: ['src/'], danger: ['src/store.js'] } }) } });
    const commitAt = (h, msg) => {
      execFileSync('git', ['add', '-A'], { cwd: r.dir });
      execFileSync('git', ['commit', '-qm', msg], { cwd: r.dir, env: { ...process.env, GIT_AUTHOR_DATE: H(h), GIT_COMMITTER_DATE: H(h) } });
    };
    writeFileSync(join(r.dir, 'src', 'new.js'), 'n\n'); commitAt(8, '清單定好後新加');
    writeFileSync(join(r.dir, 'src', 'new.js'), 'n2\n');
    const logDir = mkdtempSync(join(tmpdir(), 'pm-log-')), home = mkdtempSync(join(tmpdir(), 'pm-home-'));
    const runAs = (session, ...args) => {
      const { ANTIGRAVITY_CONVERSATION_ID: _drop, ...env } = process.env;
      if (session) env.ANTIGRAVITY_CONVERSATION_ID = session;
      try { return execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: r.dir, encoding: 'utf8', env: { ...env, AGY_PIPELINE_LOG_DIR: logDir, HOME: home } }); }
      catch (e) { return String(e.stdout ?? ''); }
    };
    const out = runAs(null);
    check(`${relCfg}：抓得到 10 小時前清單定好之後的新檔 src/new.js`, /10 小時前，git 說的）之後才新加的程式檔：src\/new\.js/.test(out), out);
    runAs('s-ai', '--tier-checked', '都不危險');
    const cfgPath = join(r.dir, relCfg);
    check(`${relCfg}：在對話裡記 → by:ai 且 --tier-review 講「AI 代記」`,
      JSON.parse(readFileSync(cfgPath, 'utf8')).tiers.checked?.by === 'ai' && /AI 代記，附的話：「都不危險」/.test(runAs(null, '--tier-review')));
    runAs(null, '--tier-checked', '我自己看過了');
    check(`${relCfg}：自己在終端機記 → by:human`, JSON.parse(readFileSync(cfgPath, 'utf8')).tiers.checked?.by === 'human');
    for (const d of [logDir, home]) rmSync(d, { recursive: true, force: true });
    r.cleanup();
  }

  // 網頁 statTier 與終端機 describeTier 說同一句
  const s0 = { since: { at: H(3), how: 'git' }, fresh: ['src/x.js'], missing: [], unknown: null };
  const line = staleLines(s0, { dangerId: LEVELS.danger.id, ago: () => '3 小時前' })[0];
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const pick = (name, sig) => src.match(new RegExp(`^function ${name}\\(${sig}\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const one = (name) => src.match(new RegExp(`^const ${name} = .*;$`, 'm'))?.[0] ?? null;
  const code = [one('OLD_LINE'), one('mark'), pick('statTier', 'c, p')];
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const statTier = new Function('esc', 'ago', `const zhEn = (zh) => zh; const many = (n, one, more = one + 's') => n + ' ' + (n === 1 ? one : more);\n${code.join('\n')}; return statTier;`)(esc, () => '3 小時前');
  const t = { state: 'ok', machine: { rank: 1, id: LEVELS.code.id, hits: { danger: [], code: ['src/x.js'] } }, manual: null, basis: null,
    final: { id: LEVELS.code.id }, requirements: [], candidates: [], upgradable: [], staleNotes: [line] };
  const html = statTier({ path: '/x', tier: { ...t, lines: tierLines(t, { ago: () => '3 小時前' }) } }, { name: 'p' });
  check('網頁分級卡照印伺服器算好的同一句', html.includes(esc(line)) && html.includes('碰到程式區 1 個檔') && html.includes('為了程式碼安全，分級只能往上調。'));
  check('終端機分級卡同一句', describeTier(t).join('\n').includes('為了程式碼安全，分級只能往上調。'));
}

section('remind.sh：Antigravity SessionStart 契約——沒設定時回傳 injectSteps JSON，其餘回傳 {}');
{
  const home = mkdtempSync(join(tmpdir(), 'pm-rem-'));
  const remind = (payload) => {
    try { return execFileSync('sh', [join(ROOT, 'remind.sh')], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, AGY_PIPELINE_HOME: home } }); }
    catch (e) { return `EXIT ${e.status}`; }
  };
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const start = { conversationId: 'c1', cwd: r.dir };
  const raw = remind(start);
  const parsed = JSON.parse(raw);
  const msg = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage ?? '';
  check('沒設定 → 回傳 injectSteps JSON，含「幫我設定分級」且單行', msg.includes('幫我設定分級') && msg.split('\n').length === 1, raw);
  // subagent transcript step 0 含 sender= → 不打擾，回 {}
  const subTr = join(home, 'sub.jsonl');
  writeFileSync(subTr, `${JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'sender=parent-1' })}\n`);
  eq('subagent → 回 {}', remind({ ...start, transcriptPath: subTr }).trim(), '{}');
  // 子資料夾也提；空字串 cwd="" 退回 workspacePaths[0] 也提（P2）
  mkdirSync(join(r.dir, 'src'));
  check('從子資料夾開對話也提', !!JSON.parse(remind({ ...start, cwd: join(r.dir, 'src') }))?.injectSteps?.length);
  check('空字串 cwd 退回 workspacePaths[0] → 照提', !!JSON.parse(remind({ conversationId: 'c1', cwd: '', workspacePaths: [r.dir] }))?.injectSteps?.length);
  // .agents/pipeline-stages.json 存在但無 tiers 時停止往下找（不偷讀 .claude/pipeline-stages.json，與 readProjectConfig 一致）
  cfgFile(r.dir, { stages: [] }, '.agents');
  cfgFile(r.dir, { tiers: { code: ['src/'] } }, '.claude');
  check('.agents/ 存在但無 tiers → 停在第一份、照提（不偷讀 .claude/）', !!JSON.parse(remind(start))?.injectSteps?.length);
  rmSync(join(r.dir, '.claude', 'pipeline-stages.json'));
  // .agents/pipeline-stages.json 設好了 → 不提
  cfgFile(r.dir, { tiers: { code: ['src/'] } }, '.agents');
  eq('.agents/ 設好了 → 回 {}', remind(start).trim(), '{}');
  rmSync(join(r.dir, '.agents', 'pipeline-stages.json'));
  // 相容 .claude/pipeline-stages.json 設好了 → 不提
  cfgFile(r.dir, { tiers: { code: ['src/'] } }, '.claude');
  eq('.claude/ 設好了 → 回 {}', remind(start).trim(), '{}');
  cfgFile(r.dir, { tiers: { off: true } }, '.claude');
  eq('明講不分級 → 回 {}', remind(start).trim(), '{}');
  cfgFile(r.dir, '{ 壞掉的', '.claude');
  eq('讀不懂 → 回 {}', remind(start).trim(), '{}');
  rmSync(join(r.dir, '.claude', 'pipeline-stages.json'));
  // 退出記號（.agents 與 .claude 都認）
  writeFileSync(join(r.dir, '.agents', 'pipeline-monitor.off'), '{}');
  eq('.agents 退出記號 → 回 {}', remind(start).trim(), '{}');
  rmSync(join(r.dir, '.agents', 'pipeline-monitor.off'));
  writeFileSync(join(r.dir, '.claude', 'pipeline-monitor.off'), '{}');
  eq('.claude 退出記號 → 回 {}', remind(start).trim(), '{}');
  // 非 git 專案 → 回 {}
  const plain = mkdtempSync(join(tmpdir(), 'pm-plain-'));
  eq('不是 git 專案 → 回 {}', remind({ conversationId: 'c1', cwd: plain }).trim(), '{}');
  rmSync(plain, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  r.cleanup();
}

process.exit(summary());
