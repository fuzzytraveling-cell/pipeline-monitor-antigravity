/**
 * tier.test.mjs —— 分級只釘「會安靜說謊」的地方:
 *   沒設定被折成 T0、危險清單空的被講成安全、「需要」被畫成通過、人調的往下或過期還掛著、
 *   sh(remind.sh)跟 node 對「設定了沒」的答案不一樣。
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';   // 排第一個:它先換上假的家,下面的 cli*.mjs 一載入就問家在哪
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, copyFileSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  readTierConfig, computeTier, manualTier, requirementStatus, candidateFiles, buildTier, proposeCodeArea, RANKS, staleLines, tierLines,
} from '../lib/tier.mjs';
import { describeTier } from '../lib/cliTier.mjs';
import { rerunOf } from '../lib/rounds.mjs';

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
  // 清單裡不是路徑、要跑的關不是清單:以前終端機直接印出程式的錯誤訊息,或把 null 當成程式區照樣分級(修小洞,2026-10-06)——讀不懂就講讀不懂
  const lv = (requires) => ({ none: { id: '甲' }, code: { id: '乙', requires }, danger: { id: '丙' } });
  for (const [label, tiers] of [
    ['程式區裡有一條是 null', { code: [null] }],
    ['危險清單裡有一條是數字', { code: ['src/'], danger: [3] }],
    ['要跑的關寫成數字', { code: ['src/'], levels: lv(5) }],
    ['要跑的關裡有 null', { code: ['src/'], levels: lv([null]) }],
  ]) {
    cfgFile(r.dir, { tiers });
    const b = readTierConfig(r.dir, null, ROOT);
    check(`${label} → broken,講得出哪裡讀不懂`, b.state === 'broken' && typeof b.why === 'string' && b.why.length > 0, JSON.stringify(b));
    writeFileSync(join(r.dir, 'a.js'), `${label}\n`);
    let term = '';
    try { term = execFileSync('node', [join(ROOT, 'status.mjs')], { cwd: r.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'pm-home-')), PIPELINE_MONITOR_LOG_DIR: mkdtempSync(join(tmpdir(), 'pm-log-')) } }); }
    catch (e) { term = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
    check(`${label} → 終端機不印程式的錯誤,分級那段講讀不懂`, !/TypeError|at file:|Error:/.test(term) && term.includes(b.why ?? '（沒有理由）'), term.slice(-500));
  }
  cfgFile(r.dir, { tiers: { code: ['src/'] } });                 // 改回好的,下一條要拿它當主資料夾的設定
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

section('沒章時你調高的等級跟著這一輪走:存檔不是新的一輪,這一輪開始之前說的才歸零;同一個 0 的兩種意思不准同一張臉(規格:這一輪的起點 AC-1、AC-4)', 'P5');
{
  const T2 = LEVELS.danger.id;
  const set = { cwd: '/x', ts: '2026-09-22T01:10:00Z', event: 'tier_set', level: T2, why: '這次會動到匯出', head: 'abc1234' };
  check('這一輪開始之後說的、之後 Claude 存了檔(HEAD 換了) → 還算數',
    manualTier([set], '/x', { cpUsable: false, head: 'def5678', originAt: '2026-09-22T01:00:00Z' })?.id === T2);
  eq('這一輪開始之前說的(上一件事的) → 歸零', manualTier([set], '/x', { cpUsable: false, head: 'abc1234', originAt: '2026-09-22T01:20:00Z' }), null);
  eq('起點問不到 → 退回舊規則:存檔了就歸零(那時畫面也只看還沒存檔的,兩邊同一個基準)',
    manualTier([set], '/x', { cpUsable: false, head: 'def5678', originAt: null }), null);
  check('有章 → 照舊看蓋章時間,不看起點', manualTier([set], '/x', { cpUsable: true, cpAt: '2026-09-22T01:05:00Z', originAt: '2026-09-22T01:20:00Z' })?.id === T2);

  const r = makeRepo({ files: { 'src/a.js': '1\n' } });
  cfgFile(r.dir, { tiers: { code: ['src/'] } });
  const tierWith = (basis, list = []) => buildTier({ root: r.dir, mainRoot: null, monitorDir: ROOT, health: { files: list.length, list, touchedTests: 0 },
    stages: [], perStage: new Map(), cleared: new Map(), events: [], cwd: r.dir, cpUsable: false, cpAt: null, head: 'abc1234', basis });
  const fromPrompt = { kind: 'origin', why: null, origin: { at: '2026-09-22T01:00:00Z', from: 'prompt', sessions: 1 } };
  const blind = { kind: 'head', why: 'not-found', origin: null };
  eq('從起點算、真的沒有改動 → no-change', tierWith(fromPrompt).state, 'no-change');
  eq('只看得到還沒存檔的、而且沒有 → unseen(存檔過的看不到,不是 no-change)', tierWith(blind).state, 'unseen');
  eq('沒給基準(舊的呼叫端) → 照舊 no-change', tierWith(null).state, 'no-change');
  eq('從起點算、沒有改動,但這一輪中間 HEAD 動過(切過分支) → unseen(魔鬼教官 2026-09-22)', tierWith({ ...fromPrompt, moved: true }).state, 'unseen');
  const L = describeTier(tierWith(blind)).join('\n');
  check('終端機:unseen 不說「沒有改動」,講存檔過的看不到、分不了級', !/沒有改動/.test(L) && /存檔過的看不到/.test(L) && /分不了級/.test(L), L);
  const partial = tierWith(blind, ['src/a.js']);
  const L2 = describeTier(partial).join('\n');
  check('只算得到還沒存檔的:等級旁邊講「實際可能更高」', partial.state === 'ok' && /只算還沒存檔的/.test(L2) && /實際可能更高/.test(L2), L2);
  check('從起點算的:不多那一句', !/實際可能更高/.test(describeTier(tierWith(fromPrompt, ['src/a.js'])).join('\n')));
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
  // 五關自動結案:Claude 記的結論也算結案,但要說得出是 Claude 說的。結論會過期的關(D)只讀 roundView 算好的「要不要再跑」
  // (lib/rounds.mjs 的 rerunOf),這裡不另外比時間——以前這裡比結論時間、收工 hook 比被叫的時間(D 多輪先問人 AC-9)
  const stagesD = [{ id: 'D', name: '魔鬼教官', skill: 'chaos-check', rerunAfterChange: true }, { id: 'C', name: '打掃', skill: 'cleanup' }];
  const ps = new Map([['D', { ts: '2026-09-16T01:00:00Z' }], ['C', { ts: '2026-09-16T01:00:00Z' }]]);
  const reports = new Map([['C', { ts: '2026-09-16T02:00:00Z', verdict: 'ok', note: '列了 3 條' }]]);
  const call = { ts: '2026-09-16T01:00:00Z', session: 's1' };
  const okRep = { ts: '2026-09-16T02:00:00Z', stage: 'D', verdict: 'ok', note: '沒對到' };
  const judged = (o) => new Map([['D', rerunOf({ calls: [call], reports: [okRep], ...o })]]);
  const R = (rerun) => Object.fromEntries(requirementStatus(['D', 'C'], { stages: stagesD, perStage: ps, cleared: new Map(), health: null, reports, rerun }).map((x) => [x.key, x]));
  const rr = R(judged({}));
  check('Claude 說沒問題 → ok,而且說是 Claude 說的', rr.D.state === 'ok' && rr.D.detail.includes('Claude 說'), rr.D.detail);
  const stale = R(judged({ lastEdit: '2026-09-16T03:00:00Z' }));
  check('D 被叫之後又改了程式檔 → D 不算 ok,說要不要再跑由你決定(不是「要再跑」)', stale.D.state === 'ran' && stale.D.detail.includes('要不要再跑由你決定'), stale.D.detail);
  eq('C 沒標 rerunAfterChange → 還是 ok', stale.C.state, 'ok');
  const fr = R(judged({ reports: [{ ...okRep, verdict: 'found', note: '找到 2 條' }] })).D;
  check('Claude 說找到問題 → ran,講出來', fr.state === 'ran' && fr.detail.includes('找到問題'), fr.detail);
  const late = R(judged({ reports: [{ ...okRep, ts: '2026-09-16T04:00:00Z' }], lastEdit: '2026-09-16T03:00:00Z' })).D;
  check('修完才記「沒問題」也算 D 之後改過(比的是 D 被叫的時間,不是結論記下的時間)', late.state === 'ran' && late.detail.includes('要不要再跑'), late.detail);
  eq('沒給「要不要再跑」的判斷 → 問不到,不猜', R(new Map()).D.state, 'unknown');
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

section('危險清單會過期:清單定好之後才新加的程式檔、清單裡已經不在的,分級卡講出來;判斷過記得下來(規格:危險清單會過期)', 'P3');
{
  // 「現在」只取一次(L18);存檔的時間照劇本給(GIT_COMMITTER_DATE),「清單定好」看的是存檔時間
  const NOW = Date.now();
  const H = (h) => new Date(NOW - h * 3600_000).toISOString();
  const tiers = (danger) => ({ code: ['src/'], danger });
  const r = makeRepo({ at: H(10), files: { 'src/a.js': '1\n', 'src/store.js': 's\n', '.claude/pipeline-stages.json': JSON.stringify({ tiers: tiers(['src/store.js']) }) } });
  const commitAt = (h, msg) => {
    execFileSync('git', ['add', '-A'], { cwd: r.dir });
    execFileSync('git', ['commit', '-qm', msg], { cwd: r.dir, env: { ...process.env, GIT_AUTHOR_DATE: H(h), GIT_COMMITTER_DATE: H(h) } });
  };
  const cfgPath = join(r.dir, '.claude', 'pipeline-stages.json');
  writeFileSync(join(r.dir, 'src', 'new.js'), 'n\n'); commitAt(8, '清單定好之後新加一個檔');
  // 6 小時前設定檔又存了一次,改的不是危險清單——不准當成「清單定好」(pipeline-monitor 9/23 那次就是)
  writeFileSync(cfgPath, JSON.stringify({ _說明: '只是說明', tiers: tiers(['src/store.js']) })); commitAt(6, '設定檔加一句說明');
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-')), home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  const run = (...args) => {
    try { return { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PIPELINE_MONITOR_LOG_DIR: logDir, HOME: home } }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout ?? '') }; }
  };
  const staleLine = (o) => o.split('\n').find((l) => l.includes('之後才新加的程式檔')) ?? '';
  const goneLine = (o) => o.split('\n').find((l) => l.includes('已經不在了')) ?? '';

  writeFileSync(join(r.dir, 'src', 'new.js'), 'n2\n'); writeFileSync(join(r.dir, 'src', 'a.js'), '2\n');   // 這一輪:改一個新檔、一個舊檔
  let out = run().out;
  check('碰到清單定好(10 小時前,git 說的)之後才新加的 → 講出來、點名那個檔、講如果危險其實是哪一級、怎麼判斷',
    /這一輪碰到 1 個危險清單定好（10 小時前，git 說的）之後才新加的程式檔：src\/new\.js/.test(staleLine(out)) && staleLine(out).includes(`其實是 ${LEVELS.danger.id}`) && /幫我看危險清單/.test(staleLine(out)), out);
  check('清單定好時就在的舊檔不講', !staleLine(out).includes('src/a.js'), staleLine(out));
  check(`等級照舊(${LEVELS.code.id}),不自動升`, out.includes(`${LEVELS.code.id}（碰到程式區`), out);

  writeFileSync(join(r.dir, 'src', 'fresh.js'), 'f\n');                                                       // 還沒存檔的新檔也算
  out = run().out;
  check('還沒存檔的新檔也算', /碰到 2 個/.test(staleLine(out)) && staleLine(out).includes('src/fresh.js'), staleLine(out));
  const rev = run('--tier-review');
  check('--tier-review:清單、定好的時間、之後才新加的(整個專案)、怎麼記判斷',
    rev.code === 0 && rev.out.includes('清單上 1 條：src/store.js') && /清單定好：10 小時前/.test(rev.out) && rev.out.includes('src/new.js') && rev.out.includes('src/fresh.js')
      && !rev.out.includes('src/a.js') && /--tier-checked "使用者的原話"/.test(rev.out), rev.out);

  eq('--tier-checked 沒附原話 → 不收', run('--tier-checked').code, 1);
  utimesSync(join(r.dir, 'src', 'fresh.js'), new Date(NOW - 60_000), new Date(NOW - 60_000));                 // 判斷的時候它已經在了
  const ck = run('--tier-checked', '兩個都只是畫面，不危險');
  check('附了原話 → 記下', ck.code === 0 && /記下了/.test(ck.out), ck.out);
  const saved = JSON.parse(readFileSync(cfgPath, 'utf8'));
  check('寫進 tiers.checked(時間、原話),其他鍵原封不動', saved.tiers.checked?.said === '兩個都只是畫面，不危險' && Number.isFinite(Date.parse(saved.tiers.checked?.at))
    && saved._說明 === '只是說明' && saved.tiers.danger[0] === 'src/store.js' && saved.tiers.code[0] === 'src/', JSON.stringify(saved));
  eq('判斷之前就在的(存檔過的、還沒存檔的)不再問', staleLine(run().out), '');
  writeFileSync(join(r.dir, 'src', 'later.js'), 'l\n');                                                       // 判斷之後才新建
  check('判斷之後才新加的照樣問,講「判斷過(N 前)」', /危險清單判斷過（[^）]*）之後才新加的程式檔：src\/later\.js/.test(staleLine(run().out)), staleLine(run().out));

  // 中文檔名(魔鬼教官第一輪):git 預設把非 ASCII 檔名轉義,跟改動清單對不上——以前這種新檔永遠不會被講出來,--tier-review 還說「之後沒有新加」
  writeFileSync(join(r.dir, 'src', '報告時間.js'), 'z\n');
  out = run().out;
  check('中文檔名的新檔照樣講出來(不是一串轉義碼)', staleLine(out).includes('src/報告時間.js') && !/\\\d{3}/.test(staleLine(out)), staleLine(out));
  check('--tier-review 也列出中文檔名', run('--tier-review').out.includes('src/報告時間.js'));
  rmSync(join(r.dir, 'src', '報告時間.js'));
  // 誰記的(魔鬼教官第一輪,P7):在對話裡跑的(環境帶著對話代號)是 Claude 代記——附的話是 Claude 打的,不准講成「使用者說」;
  // 你自己在終端機跑的才是你記的。環境變數一律在這裡給,不吃跑測試那台電腦的(P8)
  const runAs = (session, ...args) => {
    const { CLAUDE_CODE_SESSION_ID: _drop, ...env } = process.env;
    if (session) env.CLAUDE_CODE_SESSION_ID = session;
    try { return execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: r.dir, encoding: 'utf8', env: { ...env, PIPELINE_MONITOR_LOG_DIR: logDir, HOME: home } }); }
    catch (e) { return String(e.stdout ?? ''); }
  };
  runAs('s-claude', '--tier-checked', '都不危險');
  check('在對話裡記的 → 設定檔寫 by:claude,--tier-review 講「Claude 代記」、不講「使用者說」',
    JSON.parse(readFileSync(cfgPath, 'utf8')).tiers.checked?.by === 'claude' && /Claude 代記，附的話：「都不危險」/.test(runAs(null, '--tier-review')) && !/（使用者說：/.test(runAs(null, '--tier-review')));
  runAs(null, '--tier-checked', '我自己看過了');
  check('自己在終端機記的 → by:human,講「你自己記的」', JSON.parse(readFileSync(cfgPath, 'utf8')).tiers.checked?.by === 'human' && /你自己記的，附的話：「我自己看過了」/.test(runAs(null, '--tier-review')));

  // 危險清單上的檔改了名(git mv,還沒存檔):舊名字講不在了,新名字算新加的
  execFileSync('git', ['mv', 'src/store.js', 'src/storage.js'], { cwd: r.dir });
  out = run().out;
  check('清單裡已經不在的 → 講出來,講新名字不在清單上、碰到它也不會是最高那一級',
    /危險清單裡有 1 個已經不在了：src\/store\.js/.test(goneLine(out)) && goneLine(out).includes(`也不會是 ${LEVELS.danger.id}`), out);
  check('改了名的新名字(add 過、還沒存檔)算新加的,要有人看過', staleLine(out).includes('src/storage.js'), staleLine(out));
  for (const d of [logDir, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();

  // 危險清單後來改過:從改的那一次存檔算起(那之前新加的已經被考慮過)
  const r2 = makeRepo({ at: H(10), files: { 'src/store.js': 's\n', '.claude/pipeline-stages.json': JSON.stringify({ tiers: tiers(['src/store.js']) }) } });
  const commit2 = (h, msg) => {
    execFileSync('git', ['add', '-A'], { cwd: r2.dir });
    execFileSync('git', ['commit', '-qm', msg], { cwd: r2.dir, env: { ...process.env, GIT_AUTHOR_DATE: H(h), GIT_COMMITTER_DATE: H(h) } });
  };
  writeFileSync(join(r2.dir, 'src', 'eight.js'), '8\n'); commit2(8, '8 小時前新加');
  writeFileSync(join(r2.dir, '.claude', 'pipeline-stages.json'), JSON.stringify({ tiers: tiers(['src/store.js', 'src/other/']) })); commit2(6, '危險清單加一條');
  writeFileSync(join(r2.dir, 'src', 'five.js'), '5\n'); commit2(5, '5 小時前新加');
  writeFileSync(join(r2.dir, 'src', 'eight.js'), '8b\n'); writeFileSync(join(r2.dir, 'src', 'five.js'), '5b\n');
  const out2 = execFileSync('node', [join(ROOT, 'status.mjs')], { cwd: r2.dir, encoding: 'utf8', env: { ...process.env, PIPELINE_MONITOR_LOG_DIR: mkdtempSync(join(tmpdir(), 'pm-log-')), HOME: mkdtempSync(join(tmpdir(), 'pm-home-')) } });
  check('危險清單 6 小時前改過 → 從那次算:5 小時前新加的要問,8 小時前的不問',
    /定好（6 小時前，git 說的）之後才新加的程式檔：src\/five\.js/.test(staleLine(out2)) && !staleLine(out2).includes('eight.js'), staleLine(out2));
  check('清單裡的資料夾(src/other/)不在 → 也講', goneLine(out2).includes('src/other/'), goneLine(out2));
  r2.cleanup();

  // 設定檔沒進版控、也沒記過判斷時間(或記的時間讀不懂)→ 分不出來,不講成「沒有新檔」(R1)
  for (const checked of [undefined, { at: '不是時間', said: 'x' }]) {
    const r3 = makeRepo({ at: H(10), files: { 'src/old.js': 'o\n', '.gitignore': '.claude/\n' } });
    cfgFile(r3.dir, { tiers: { ...tiers([]), ...(checked ? { checked } : {}) } });
    writeFileSync(join(r3.dir, 'src', 'old.js'), 'o2\n');
    const out3 = execFileSync('node', [join(ROOT, 'status.mjs')], { cwd: r3.dir, encoding: 'utf8', env: { ...process.env, PIPELINE_MONITOR_LOG_DIR: mkdtempSync(join(tmpdir(), 'pm-log-')), HOME: mkdtempSync(join(tmpdir(), 'pm-home-')) } });
    check(`設定檔沒進版控${checked ? '、判斷時間讀不懂' : ''} → 講分不出哪些是之後才新加的`, /危險清單沒記下是什麼時候定的/.test(out3) && !staleLine(out3), out3);
    r3.cleanup();
  }

  // 這次已經是最高那一級:不講「其實是」那半句;句子終端機與網頁同一句(網頁照印伺服器給的)
  const s0 = { since: { at: H(3), how: 'git' }, fresh: ['src/x.js'], missing: [], unknown: null };
  check('已經是最高那一級 → 不講「這次其實是」', !staleLines(s0, { dangerId: LEVELS.danger.id, already: true, ago: () => '3 小時前' })[0].includes('其實是'));
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const pick = (name, sig) => src.match(new RegExp(`^function ${name}\\(${sig}\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const one = (name) => src.match(new RegExp(`^const ${name} = .*;$`, 'm'))?.[0] ?? null;
  const code = [one('OLD_LINE'), one('mark'), pick('statTier', 'c, p')];
  check('從 ui/app.js 拿得出 statTier(與它的小幫手)', code.every(Boolean));
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const statTier = code.every(Boolean) ? new Function('esc', 'ago', `const zhEn = (zh) => zh; const many = (n, one, more = one + 's') => n + ' ' + (n === 1 ? one : more);\n${code.join('\n')}; return statTier;`)(esc, () => '3 小時前') : null;
  const line = staleLines(s0, { dangerId: LEVELS.danger.id, ago: () => '3 小時前' })[0];
  const t = { state: 'ok', machine: { rank: 1, id: LEVELS.code.id, hits: { danger: [], code: ['src/x.js'] } }, manual: null, basis: null,
    final: { id: LEVELS.code.id }, requirements: [], candidates: [], upgradable: [], staleNotes: [line] };
  // 伺服器做的事:分級卡的那幾句照 lib/tier.mjs 的 tierLines 算好放進 lines(終端機同一句;規格:終端機與網頁說同一句)
  const html = statTier?.({ path: '/x', tier: { ...t, lines: tierLines(t, { ago: () => '3 小時前' }) } }, { name: 'p' }) ?? '';
  check('網頁的分級卡照印伺服器算好的那一句(跟終端機同一句)', html.includes(esc(line)) && html.includes('碰到程式區 1 個檔') && html.includes('為了程式碼安全，分級只能往上調。'), html);
  // 終端機印的是同一個函式的同一句
  const term = describeTier(t).join('\n');
  check('終端機的分級卡:機器為什麼算這一級、只能往上調,跟網頁同一句', term.includes(`${LEVELS.code.id}（碰到程式區 1 個檔）`) && term.includes('為了程式碼安全，分級只能往上調。'), term);
  // 舊的服務沒給那幾句(合併之後還沒 --serve-restart):不自己拼、不壞(AC-5)
  const old = statTier?.({ path: '/x', tier: t }, { name: 'p' }) ?? '';
  check('舊的服務沒給那幾句:講服務還在跑舊的程式,不自己拼「碰到程式區」', /還在跑舊的程式/.test(old) && !old.includes('碰到程式區'), old);
}

section('判斷過的新檔,之後存檔、再改都還是判斷過的——不拿存檔的時間當新增的時間(規格:收工hook問危險清單 AC-2)', 'P9');
{
  // 照真的會發生的順序走:Claude 新增一個檔 → 你判斷 → Claude 存檔 → 再改。以前只測到「判斷之後還沒存檔」(L35)
  const NOW = Date.now();
  const H = (h) => new Date(NOW - h * 3600_000).toISOString();
  const r = makeRepo({ at: H(10), files: { 'src/a.js': '1\n', 'src/store.js': 's\n', '.claude/pipeline-stages.json': JSON.stringify({ tiers: { code: ['src/'], danger: ['src/store.js'] } }) } });
  const cfgPath = join(r.dir, '.claude', 'pipeline-stages.json');
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-')), home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  // 環境一律在這裡給(P8):對話代號拿掉 → 你自己記的,不吃跑測試那台電腦的
  const run = (...args) => {
    const { CLAUDE_CODE_SESSION_ID: _drop, ...env } = process.env;
    try { return execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: r.dir, encoding: 'utf8', env: { ...env, PIPELINE_MONITOR_LOG_DIR: logDir, HOME: home } }); }
    catch (e) { return String(e.stdout ?? ''); }
  };
  const staleLine = (o) => o.split('\n').find((l) => l.includes('之後才新加的程式檔')) ?? '';
  const commit = (msg) => { execFileSync('git', ['add', '-A'], { cwd: r.dir }); execFileSync('git', ['commit', '-qm', msg], { cwd: r.dir }); };

  writeFileSync(join(r.dir, 'src', 'new.js'), 'n\n');                     // Claude 新增的檔,還沒存檔
  check('判斷之前:新檔要問', staleLine(run()).includes('src/new.js'), staleLine(run()));
  run('--tier-checked', 'new.js 只是排版，不危險');
  const ck = JSON.parse(readFileSync(cfgPath, 'utf8')).tiers.checked ?? {};
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).trim();
  check('--tier-checked 記下那一刻的快照:那時的版本、那時還沒存檔的程式檔', ck.commit === head && JSON.stringify(ck.files) === '["src/new.js"]', JSON.stringify(ck));
  commit('存檔');                                                           // 你判斷完,Claude 存檔
  check('存檔之後 --tier-review 不再列它(以前存檔的時間晚於判斷,就被當成判斷之後才新加的)', !run('--tier-review').includes('src/new.js'), run('--tier-review'));
  writeFileSync(join(r.dir, 'src', 'new.js'), 'n2\n');                    // 存檔之後又改了一次:這一輪碰到它
  eq('存檔之後再改:分級卡不再講它沒人判斷過', staleLine(run()), '');
  writeFileSync(join(r.dir, 'src', 'later.js'), 'l\n');                   // 判斷之後才新建的
  check('判斷之後才新加的照樣問,判斷過的不在裡面', staleLine(run()).includes('src/later.js') && !staleLine(run()).includes('src/new.js'), staleLine(run()));
  rmSync(join(r.dir, 'src', 'later.js'));

  // 舊的判斷紀錄(v0.20.0 寫的,只有時間)照舊用時間算;快照寫壞、記的版本找不到 → 也退回用時間算(多問,不少問),不准當成「都判斷過了」
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  for (const [label, extra] of [['舊紀錄只有時間', {}], ['快照的版本寫壞', { commit: '不是版本號', files: [] }], ['記的版本找不到了', { commit: 'f'.repeat(40), files: [] }]]) {
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, tiers: { ...cfg.tiers, checked: { at: H(1), said: '舊的', by: 'human', ...extra } } }));
    commit(`${label}`);
    writeFileSync(join(r.dir, 'src', 'old.js'), 'o\n'); commit('判斷之後才存檔的新檔');   // 存檔時間在判斷之後
    writeFileSync(join(r.dir, 'src', 'old.js'), 'o2\n'); writeFileSync(join(r.dir, 'src', 'a.js'), `${label}\n`);   // 也碰一個判斷之前就存檔的舊檔
    check(`${label} → 照時間算:判斷之後存檔新增的照樣問,判斷之前就在的舊檔不問(不是全部當成新的)`,
      staleLine(run()).includes('src/old.js') && !staleLine(run()).includes('src/a.js'), staleLine(run()));
    execFileSync('git', ['rm', '-qf', 'src/old.js'], { cwd: r.dir }); commit('拿掉');
  }
  for (const d of [logDir, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();

  // git 說的那一次也照版本比,不拿它的存檔時間比修改時間:rebase、amend 會把那次存檔的時間往後推(存檔的時間不是清單定好的時間)。
  // 以前:還沒存檔的新檔,修改時間比「被改寫過的存檔時間」早,就被當成清單定好之前就在了——漏問(危險的那一邊)
  const r4 = makeRepo({ at: H(10), files: { 'src/a.js': '1\n', '.claude/pipeline-stages.json': JSON.stringify({ tiers: { code: ['src/'], danger: [] } }) } });
  writeFileSync(join(r4.dir, 'src', 'draft.js'), 'd\n');
  utimesSync(join(r4.dir, 'src', 'draft.js'), new Date(NOW - 5 * 3600_000), new Date(NOW - 5 * 3600_000));   // 清單定好之後(10 小時前之後)才新建的
  execFileSync('git', ['commit', '-q', '--amend', '--no-edit'], { cwd: r4.dir, env: { ...process.env, GIT_COMMITTER_DATE: H(1) } });   // 改寫:存檔時間變成 1 小時前
  writeFileSync(join(r4.dir, 'src', 'a.js'), '2\n');
  const out4 = execFileSync('node', [join(ROOT, 'status.mjs'), '--tier-review'], { cwd: r4.dir, encoding: 'utf8', env: { ...process.env, PIPELINE_MONITOR_LOG_DIR: mkdtempSync(join(tmpdir(), 'pm-log-')), HOME: mkdtempSync(join(tmpdir(), 'pm-home-')) } });
  check('清單那次存檔被改寫過(存檔時間往後推)→ 之後新建、還沒存檔的檔照樣列出來', out4.includes('src/draft.js') && !out4.includes('src/a.js'), out4);
  r4.cleanup();
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
