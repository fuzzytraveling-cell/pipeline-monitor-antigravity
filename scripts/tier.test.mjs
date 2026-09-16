/**
 * tier.test.mjs —— 分級只釘「會安靜說謊」的地方:
 *   沒設定被折成 T0、危險清單空的被講成安全、「需要」被畫成通過、人調的往下或過期還掛著、
 *   sh(remind.sh)跟 node 對「設定了沒」的答案不一樣。
 */
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  readTierConfig, computeTier, manualTier, requirementStatus, candidateFiles, buildTier, proposeCodeArea, RANKS,
} from '../lib/tier.mjs';
import { describeTier } from '../status.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).tierLevels;
const cfgFile = (dir, obj) => {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'pipeline-stages.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
};

section('設定檔的狀態:沒設定／不分級／讀不懂／設好了——四種各自一張臉,不准折成有沒有');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  eq('沒有檔案 → unset', readTierConfig(r.dir, null, ROOT).state, 'unset');
  cfgFile(r.dir, { stages: [] });
  eq('有檔案但沒有 tiers → 還是 unset', readTierConfig(r.dir, null, ROOT).state, 'unset');
  cfgFile(r.dir, { tiers: { off: true, at: '2026-09-13T00:00:00Z', why: '純文件' } });
  const off = readTierConfig(r.dir, null, ROOT);
  check('明講不分級 → off,而且留著理由', off.state === 'off' && off.off.why === '純文件');
  cfgFile(r.dir, '{ 壞掉的');
  eq('讀不懂 → broken(不是 unset)', readTierConfig(r.dir, null, ROOT).state, 'broken');
  cfgFile(r.dir, { tiers: { code: [] } });
  eq('程式區空的 → broken', readTierConfig(r.dir, null, ROOT).state, 'broken');
  cfgFile(r.dir, { tiers: { code: ['src'] } });
  const ok = readTierConfig(r.dir, null, ROOT);
  check('設好了 → ok;程式區補上斜線;危險清單預設空;三級從 stages.json 來',
    ok.state === 'ok' && ok.config.code[0] === 'src/' && ok.config.danger.length === 0 && ok.config.levels.danger.id === LEVELS.danger.id,
    JSON.stringify(ok));
  cfgFile(r.dir, { tiers: { code: ['src/'], levels: { none: { id: '甲' }, code: { id: '乙', requires: ['D'] }, danger: { id: '丙' } } } });
  eq('專案自己的 levels 優先', readTierConfig(r.dir, null, ROOT).config.levels.code.id, '乙');
  // worktree 沒有自己的設定 → 找主資料夾
  const wt = makeRepo({ files: { 'a.js': '1\n' } });
  eq('自己沒有、主資料夾有 → 用主資料夾的', readTierConfig(wt.dir, r.dir, ROOT).state, 'ok');
  r.cleanup(); wt.cleanup();
}

const CFG = { code: ['src/'], danger: ['src/utils/store.js', 'src/data/'], levels: LEVELS };

section('機器算的那一級:只看檔案落在哪裡');
{
  eq('沒碰到程式區 → 第一級', computeTier(['README.md', 'docs/a.md'], CFG).rank, 0);
  const t1 = computeTier(['src/a.js', 'README.md'], CFG);
  check('碰到程式區 → 第二級,說得出是哪個檔', t1.rank === 1 && t1.hits.code[0] === 'src/a.js');
  const t2 = computeTier(['src/utils/store.js', 'src/a.js'], CFG);
  check('碰到危險清單 → 第三級,說得出是哪個檔', t2.rank === 2 && t2.hits.danger[0] === 'src/utils/store.js');
  eq('危險清單可以是整個資料夾', computeTier(['src/data/x.js'], CFG).rank, 2);
  eq('srcx/ 不算 src/(前綴要是資料夾)', computeTier(['srcx/a.js'], CFG).rank, 0);
  eq('等級的名字從設定來', computeTier(['src/a.js'], CFG).id, LEVELS.code.id);
}

section('人調高的:只准往上,基準換了就歸零');
{
  const T2 = LEVELS.danger.id, T0 = LEVELS.none.id;
  const ev = (o) => ({ cwd: '/x', ...o });
  const set = ev({ ts: '2026-09-13T01:00:00Z', event: 'tier_set', level: T2, why: '重寫', head: 'abc1234' });
  check('沒章、HEAD 沒動 → 還算數', manualTier([set], '/x', { cpUsable: false, head: 'abc1234' })?.id === T2);
  eq('沒章、存檔了(HEAD 換了) → 歸零', manualTier([set], '/x', { cpUsable: false, head: 'def5678' }), null);
  check('有章、章在調高之前 → 還算數', manualTier([set], '/x', { cpUsable: true, cpAt: '2026-09-13T00:00:00Z' })?.id === T2);
  eq('有章、蓋章在調高之後 → 歸零', manualTier([set], '/x', { cpUsable: true, cpAt: '2026-09-13T02:00:00Z' }), null);
  eq('收回 → 沒有', manualTier([set, ev({ ts: '2026-09-13T01:30:00Z', event: 'tier_retracted' })], '/x', { cpUsable: false, head: 'abc1234' }), null);
  eq('別的工作區的不算', manualTier([{ ...set, cwd: '/y' }], '/x', { cpUsable: false, head: 'abc1234' }), null);

  // 你說的沒有比機器算的高 → 不採用,但要講
  const r = makeRepo({ files: { 'src/a.js': '1\n' } });
  cfgFile(r.dir, { tiers: { code: ['src/'] } });
  const low = ev({ ts: '2026-09-13T01:00:00Z', event: 'tier_set', level: T0, why: '小改', head: 'abc1234' });
  const t = buildTier({ root: r.dir, mainRoot: null, monitorDir: ROOT, health: { files: 1, list: ['src/a.js'], touchedTests: 0 },
    stages: [], perStage: new Map(), cleared: new Map(), events: [{ ...low, cwd: r.dir }], cwd: r.dir, cpUsable: false, cpAt: null, head: 'abc1234' });
  check('你說 T0、機器算 T1 → manual 空、manualIgnored 有', t.manual === null && t.manualIgnored?.id === T0, JSON.stringify(t));
  check('upgradable 只有比機器高的', t.upgradable.length === 1 && t.upgradable[0] === T2);
  r.cleanup();
}

section('「需要」那幾項:只講有沒有紀錄,不講通過');
{
  const stages = [{ id: 'A', name: '寫規格', skill: 'spec' }, { id: 'B', name: '寫程式', type: 'main-conversation' },
                  { id: 'D', name: '魔鬼教官', skill: 'chaos-check' }, { id: 'E', name: '驗收', type: 'not-built' }];
  const perStage = new Map([['D', { ts: '2026-09-13T01:00:00Z' }], ['A', { ts: '2026-09-13T01:00:00Z' }]]);
  const cleared = new Map([['A', { ts: '2026-09-13T02:00:00Z' }]]);
  const rs = requirementStatus(['A', 'D', 'tests', 'B', 'E', 'Z'], { stages, perStage, cleared, health: { touchedTests: 0 } });
  const by = Object.fromEntries(rs.map((x) => [x.key, x]));
  eq('A 有紀錄且你說處理完了 → ok', by.A.state, 'ok');
  eq('D 有紀錄沒結案 → ran(不是 ok)', by.D.state, 'ran');
  eq('沒有測試檔 → missing', by.tests.state, 'missing');
  eq('有測試檔 → ok', requirementStatus(['tests'], { stages, perStage, cleared, health: { touchedTests: 2 } })[0].state, 'ok');
  eq('問不到改動 → unknown', requirementStatus(['tests'], { stages, perStage, cleared, health: null })[0].state, 'unknown');
  check('B(對話)／E(未建)／Z(沒這關) → unknown,各有說法', by.B.state === 'unknown' && by.E.state === 'unknown' && by.Z.state === 'unknown');
  check('沒有任何一項叫 passed', rs.every((x) => !('passed' in x)));
  // 五關自動結案:Claude 記的結論也算結案,但要說得出是 Claude 說的;結論會過期的關之後又改了程式檔就不算 ok
  const stagesD = [{ id: 'D', name: '魔鬼教官', skill: 'chaos-check', rerunAfterChange: true }, { id: 'C', name: '打掃', skill: 'cleanup' }];
  const ps = new Map([['D', { ts: '2026-09-16T01:00:00Z' }], ['C', { ts: '2026-09-16T01:00:00Z' }]]);
  const reports = new Map([['D', { ts: '2026-09-16T02:00:00Z', verdict: 'ok', note: '沒對到' }], ['C', { ts: '2026-09-16T02:00:00Z', verdict: 'ok', note: '列了 3 條' }]]);
  const rr = Object.fromEntries(requirementStatus(['D', 'C'], { stages: stagesD, perStage: ps, cleared: new Map(), health: null, reports }).map((x) => [x.key, x]));
  check('Claude 說沒問題 → ok,而且說是 Claude 說的', rr.D.state === 'ok' && rr.D.detail.includes('Claude 說'), rr.D.detail);
  const stale = Object.fromEntries(requirementStatus(['D', 'C'], { stages: stagesD, perStage: ps, cleared: new Map(), health: null, reports, lastEdit: '2026-09-16T03:00:00Z' }).map((x) => [x.key, x]));
  check('結論之後又改了程式檔 → D 不算 ok,說要再跑', stale.D.state === 'ran' && stale.D.detail.includes('再跑'), stale.D.detail);
  eq('C 沒標 rerunAfterChange → 還是 ok', stale.C.state, 'ok');
  const foundR = new Map([['D', { ts: '2026-09-16T02:00:00Z', verdict: 'found', note: '找到 2 條' }]]);
  const fr = requirementStatus(['D'], { stages: stagesD, perStage: ps, cleared: new Map(), health: null, reports: foundR })[0];
  check('Claude 說找到問題 → ran,講出來', fr.state === 'ran' && fr.detail.includes('找到問題'), fr.detail);
}

section('候選提醒:只提這次動到、在程式區、名字像會存東西、不在危險清單的');
{
  const c = candidateFiles(['src/services/specStore.ts', 'src/utils/store.js', 'src/components/Bar.tsx', 'docs/export.md'], CFG);
  check('specStore 提;store.js 已在清單不提;Bar 名字不像不提;docs 不在程式區不提', c.length === 1 && c[0] === 'src/services/specStore.ts', c.join(','));
}

section('describeTier:沒設定不准寫成最低那級;需要那幾行只有 ok 才打勾;空的危險清單要明講');
{
  const T0 = LEVELS.none.id, T1 = LEVELS.code.id, T2 = LEVELS.danger.id;
  const base = { state: 'ok', dangerEmpty: false, levels: LEVELS, candidates: [], manualIgnored: null };
  const unset = describeTier({ state: 'unset' }).join('\n');
  check('unset → 「還沒設定」,而且沒有 T0', unset.includes('還沒設定') && !unset.includes(T0), unset);
  const nobase = describeTier({ state: 'no-base' }).join('\n');
  check('還沒有 commit → 說「沒有基準」,不說「問不到」', nobase.includes('沒有基準') && !nobase.includes('問不到'), nobase);
  const broken = describeTier({ state: 'broken', why: 'x', from: 'f' }).join('\n');
  check('broken → 「讀不懂」「不分級」', broken.includes('讀不懂') && broken.includes('不分級'));
  const t1 = describeTier({ ...base, machine: { rank: 1, id: T1, hits: { code: ['src/a.js'], danger: [] } }, manual: null,
    final: { rank: 1, id: T1, requires: ['D'] },
    requirements: [{ key: 'D', label: 'D 魔鬼教官', state: 'missing', detail: '沒有紀錄' }], upgradable: [T2] }).join('\n');
  check(`機器算 → 「${T1}（碰到程式區」＋ D ⚠️ 沒有紀錄 ＋ 調高的指令`, t1.includes(`${T1}（碰到程式區`) && t1.includes('⚠️') && t1.includes(`--tier ${T2}`), t1);
  check('沒有 ✅(沒有任何一項是 ok)', !t1.includes('✅'));
  const t2 = describeTier({ ...base, machine: { rank: 1, id: T1, hits: { code: ['src/a.js'], danger: [] } },
    manual: { id: T2, rank: 2, why: '重寫', ts: new Date().toISOString() }, final: { rank: 2, id: T2, requires: ['A', 'tests'] },
    requirements: [{ key: 'A', label: 'A 寫規格', state: 'ok', ts: new Date().toISOString(), detail: '跑過,你說處理完了' },
                   { key: 'tests', label: '補測試', state: 'ok', detail: '這次有 1 個測試檔被新增或修改' }], upgradable: [T2] }).join('\n');
  check(`人調的 → 「機器算 ${T1},你說 ${T2}（理由：重寫）」＋ 收回`, t2.includes(`你說 ${T2}`) && t2.includes('重寫') && t2.includes('--tier-retract'), t2);
  const empty = describeTier({ ...base, dangerEmpty: true, machine: { rank: 0, id: T0, hits: { code: [], danger: [] } }, manual: null,
    final: { rank: 0, id: T0, requires: [] }, requirements: [], upgradable: [T1, T2] }).join('\n');
  check(`危險清單空的 → 明講「永遠不會出現 ${T2}」`, empty.includes(`永遠不會出現 ${T2}`), empty);
}

section('--tier-init 提議程式區:package.json 指向 → git 追蹤的程式檔 → 硬碟;認不出就 null');
{
  const a = makeRepo({ pkg: { name: 'x', main: 'lib/index.js' }, files: { 'lib/index.js': '1\n', 'src/a.js': '1\n', 'src/b.js': '1\n' } });
  check('package.json 的 main 優先', proposeCodeArea(a.dir)?.dirs[0] === 'lib/', JSON.stringify(proposeCodeArea(a.dir)));
  const b = makeRepo({ files: { 'app/a.js': '1\n', 'app/b.js': '1\n', 'scripts/x.js': '1\n', 'docs/y.js': '1\n' } });
  check('沒有指向 → git 追蹤最多的資料夾(scripts/docs 不算)', proposeCodeArea(b.dir)?.dirs[0] === 'app/', JSON.stringify(proposeCodeArea(b.dir)));
  const c = makeRepo({ files: { 'src/a.ts': '1\n', 'src/b.ts': '1\n' }, commit: false });
  check('零 commit → 看硬碟', proposeCodeArea(c.dir)?.dirs[0] === 'src/', JSON.stringify(proposeCodeArea(c.dir)));
  const d = makeRepo({ files: { 'README.md': '1\n' } });
  eq('什麼程式檔都沒有 → null(不硬湊)', proposeCodeArea(d.dir), null);
  a.cleanup(); b.cleanup(); c.cleanup(); d.cleanup();
}

section('整支 CLI:--tier-init 寫骨架、被 gitignore 要講;--tier 理由必填、只准往上;--tier-retract');
{
  const r = makeRepo({ pkg: { name: 'x', main: 'src/index.js' }, files: { 'src/index.js': '1\n', '.gitignore': '.claude/\n' } });
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-')), home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  const run = (...args) => {
    try {
      return { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PIPELINE_MONITOR_LOG_DIR: logDir, HOME: home } }) };
    } catch (e) { return { code: e.status, out: String(e.stdout ?? '') }; }
  };
  const init = run('--tier-init');
  check('寫出骨架,程式區 src/,危險清單空的', init.code === 0 && init.out.includes('src/') && init.out.includes('危險清單：空的'), init.out);
  check('被 gitignore → 明講不會進版控,並給那一行', init.out.includes('不會進版控') && init.out.includes('!.claude/pipeline-stages.json'), init.out);
  const cfg = JSON.parse(readFileSync(join(r.dir, '.claude', 'pipeline-stages.json'), 'utf8'));
  check('檔案裡真的是 code:[src/] danger:[]', cfg.tiers.code[0] === 'src/' && cfg.tiers.danger.length === 0);
  eq('再跑一次 → 只回報,不覆蓋', run('--tier-init').code, 0);

  writeFileSync(join(r.dir, 'src', 'index.js'), '2\n');   // 碰到程式區 → 機器算第二級
  const view = run().out;
  check(`畫面:${LEVELS.code.id}（碰到程式區 ＋ 危險清單空的警告`, view.includes(`${LEVELS.code.id}（碰到程式區`) && view.includes(`永遠不會出現 ${LEVELS.danger.id}`), view);
  eq('--tier 沒理由 → 失敗', run('--tier', LEVELS.danger.id).code, 1);
  check('--tier 不比機器高 → 失敗,說得出為什麼', run('--tier', LEVELS.none.id, '小改').out.includes('只能調到'));
  const set = run('--tier', LEVELS.danger.id, '重寫了整個上傳流程');
  check('--tier T2 理由 → 記下', set.code === 0 && set.out.includes('記下了'), set.out);
  check(`畫面:機器算 ${LEVELS.code.id},你說 ${LEVELS.danger.id}`, run().out.includes(`你說 ${LEVELS.danger.id}`));
  check('--tier-retract → 收回', run('--tier-retract').out.includes('收回了'));
  check('收回後畫面回到機器算的', run().out.includes(`${LEVELS.code.id}（碰到程式區`));
  check('--tier-off → 記下不分級', run('--tier-off', '純文件專案').out.includes('不分級'));
  check('畫面:已設定為不分級', run().out.includes('已設定為不分級'));
  for (const d of [logDir, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('remind.sh:只在對話開始、只在還沒設定分級時,給 Claude 一行;其他時候一個字都不出');
{
  const remind = (payload) => {
    try { return execFileSync('sh', [join(ROOT, 'remind.sh')], { input: JSON.stringify(payload), encoding: 'utf8' }); }
    catch (e) { return `EXIT ${e.status}`; }
  };
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const start = { hook_event_name: 'SessionStart', source: 'startup', cwd: r.dir };
  const out = remind(start);
  check('沒設定 → 剛好一行,提到「幫我設定分級」', out.trim().split('\n').length === 1 && out.includes('幫我設定分級'), out);
  eq('resume 不提', remind({ ...start, source: 'resume' }), '');
  eq('compact 不提', remind({ ...start, source: 'compact' }), '');
  eq('從子資料夾開對話也提', remind({ ...start, cwd: (mkdirSync(join(r.dir, 'src')), join(r.dir, 'src')) }).trim().split('\n').length, 1);
  cfgFile(r.dir, { tiers: { code: ['src/'] } });
  eq('設好了 → 不提', remind(start), '');
  cfgFile(r.dir, { tiers: { off: true } });
  eq('明講不分級 → 不提', remind(start), '');
  cfgFile(r.dir, '{ 壞掉的');
  eq('讀不懂 → 也不提(那是儀表板的事)', remind(start), '');
  rmSync(join(r.dir, '.claude', 'pipeline-stages.json'));
  writeFileSync(join(r.dir, '.claude', 'pipeline-monitor.off'), '{}');
  eq('退出記錄的專案 → 不提', remind(start), '');
  const plain = mkdtempSync(join(tmpdir(), 'pm-plain-'));
  eq('不是 git 專案 → 不提', remind({ ...start, cwd: plain }), '');
  rmSync(plain, { recursive: true, force: true }); r.cleanup();
}

process.exit(summary());
