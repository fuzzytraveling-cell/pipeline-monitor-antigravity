#!/usr/bin/env node
/**
 * precheck.test.mjs —— 寫規格後、動手前由魔鬼教官預審規格（spec-chaos-precheck）。
 *
 * 釘住會安靜說謊或壞掉的六件事：
 *   ① [P4] predictedTierOf / predictsDanger 跳過 code fence 與括號附註（不把 T1 誤判成 T2）
 *   ② [P11] 規格預審與程式 D 徹底隔離（不佔 D 輪次、不移動 roundStart、程式 D 第 1 輪仍是第 1 輪）
 *   ③ [P2][P1][P9] precheckLine／screenStages／cliStages／ui/app.js／todoBoard 單一真相來源；開工後不誤報過期、長清單遺失誠實講
 *   ④ [P10] ok 不打綠勾／不笑；no-report／found 時 F 工地主任不誤亮；舊服務缺 precheckSupport 亮黃條
 *   ⑤ [P6][P7] gate.mjs 只在「已設定分級專案＋預測最高級＋剛寫完規格還沒動工」擋一次；T1／未設定／澄清／已預審改規格／已開工／--spec 不擋
 *   ⑥ [P2] 中英雙語零中文殘留且守住紅線禁用字；--round precheck 與 --round D 分流提示
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, symlinkSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { predictedTierOf, predictsDanger, parseChecklist, combineChecklists } from '../lib/checklist.mjs';
import { precheckOf, prechecksIn, roundView, sessionView, runsPerStage, reportsIn } from '../lib/rounds.mjs';
import { precheckLine, precheckItems } from '../lib/stageLines.mjs';
import { collectAll, screenStages } from '../lib/collect.mjs';
import { todoBoard } from '../lib/todo.mjs';
import { safeName } from '../lib/events.mjs';
import { withLang } from '../lib/lang.mjs';
import { decide } from '../gate.mjs';
import { CJK } from './_zhscan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).name;
const out = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const T = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString();
const MIN = 60;

const T2_SPEC = `# 功能：測試預審規格

分級：預測至少 **T2**（因為會碰到危險清單）

## 這是為了解決什麼
測試寫完規格後的預審。

## 驗收條件
**AC-1　第一條**
> **白話**：測試白話
`;

const T1_SPEC = `# Feature: small fix

Tier: predicted at least T1 (only touches code area, not T2 danger list)

## What this solves
Small UI tweak.

## Acceptance criteria
**AC-1 First item**
> **In plain words**: plain text
`;

function setupProject({ tier = { code: ['src/'], danger: ['src/danger.js'] }, spec = T2_SPEC, specPath = 'docs/規劃中/feat.md', extraFiles = {} } = {}) {
  const r = makeRepo({
    files: {
      'src/a.js': '1\n',
      'src/danger.js': 'd\n',
      'docs/FAILURE-PATTERNS.md': '## P1\n',
      ...extraFiles,
    },
  });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  if (tier !== null) {
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'pipeline-stages.json'), JSON.stringify({ tiers: tier }));
  }
  if (spec !== null && specPath) {
    mkdirSync(join(root, dirname(specPath)), { recursive: true });
    writeFileSync(join(root, specPath), spec);
  }
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-pc-data-'));
  mkdirSync(join(monitorDir, 'logs'));
  mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-pc-home-'));
  mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(ROOT, join(home, '.gemini', 'config', 'plugins', PLUGIN));
  const log = join(monitorDir, 'logs', `${safeName(basename(root))}.jsonl`);
  return {
    root, monitorDir, home, log,
    cleanup() {
      rmSync(monitorDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      r.cleanup();
    },
  };
}

function runCli(root, monitorDir, home, args, { sid = 's1', lang = 'zh' } = {}) {
  if (lang === 'en') writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang: 'en' }));
  else if (lang === 'zh') writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang: 'zh' }));
  const env = { ...process.env, HOME: home, AGY_PIPELINE_HOME: monitorDir, AGY_PIPELINE_LOG_DIR: join(monitorDir, 'logs') };
  if (sid) env.ANTIGRAVITY_CONVERSATION_ID = sid;
  else delete env.ANTIGRAVITY_CONVERSATION_ID;
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(ROOT, 'status.mjs'), ...args], { cwd: root, encoding: 'utf8', env }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/* ════════════ 1. predictedTierOf / predictsDanger ════════════ */

section('AC-1/AC-4: predictedTierOf 與 predictsDanger 跳過 code fence 與括號附註（P4）', 'P4');
{
  eq('中文粗體 T2（帶括號說明）→ T2', predictedTierOf(T2_SPEC), 'T2');
  eq('英文 T1（括號提到 T2 不誤中）→ T1', predictedTierOf(T1_SPEC), 'T1');
  eq('自訂等級 L3', predictedTierOf('# Feature: x\n\nTier: at least L3; touches core\n'), 'L3');
  eq('還沒設定分級 → null', predictedTierOf('分級：這個專案還沒設定分級\n'), null);
  eq('英文 hasn\'t set up tiers → null', predictedTierOf('Tier: this project hasn\'t set up tiers yet\n'), null);
  eq('範本佔位符 → null', predictedTierOf('分級：<預測至少 T?，預測會動到：…>\n'), null);
  const fenced = '```markdown\n分級：預測至少 T2\n```\n\n分級：預測至少 T1\n';
  eq('跳過 code fence 裡的範本 → T1', predictedTierOf(fenced), 'T1');

  const c2 = parseChecklist(T2_SPEC);
  const c1 = parseChecklist(T1_SPEC);
  const cUnset = parseChecklist('分級：這個專案還沒設定分級\n\n**AC-1　一條**\n');
  eq('T2 規格命中 dangerId=T2 → true', predictsDanger(c2, 'T2'), true);
  eq('T1 規格命中 dangerId=T2 → false（括號裡的 T2 不誤抓）', predictsDanger(c1, 'T2'), false);
  eq('讀不出預測分級 → null（不折成 false，R1）', predictsDanger(cUnset, 'T2'), null);
  const multi = combineChecklists([
    { name: 'a', place: {}, checklist: c1 },
    { name: 'b', place: {}, checklist: c2 },
  ]);
  eq('多份規格只要任一份預測 T2 → true', predictsDanger(multi, 'T2'), true);

  const cNoAcT2 = parseChecklist('# Draft\n\n分級：預測至少 T2\n');
  const multiNoAc = combineChecklists([
    { name: 'a', place: {}, checklist: c1 },
    { name: 'b', place: {}, checklist: { ...cNoAcT2, missing: false } },
  ]);
  eq('多份規格裡無 AC 標題但預測 T2 → 仍判 true（P6/R1）', predictsDanger(multiNoAc, 'T2'), true);

  const multiMissing = combineChecklists([
    { name: 'a', place: {}, checklist: c1 },
    { name: 'missing', place: {}, checklist: { missing: true, parsed: false, items: [], predictedTier: null } },
  ]);
  eq('多份規格含 T1 ＋讀不到的一份 → null（不折成未達最高級，R1）', predictsDanger(multiMissing, 'T2'), null);

  const cNoTier = parseChecklist('# Draft without tier\n\n**AC-1 item**\n');
  const multiNoTier = combineChecklists([
    { name: 'a', place: {}, checklist: c1 },
    { name: 'notier', place: {}, checklist: { ...cNoTier, missing: false } },
  ]);
  eq('多份規格含 T1 ＋有檔但沒寫分級的一份 → null（R1）', predictsDanger(multiNoTier, 'T2'), null);
  eq('多份規格含 T2 ＋沒寫分級的一份 → 仍判 true', predictsDanger(combineChecklists([
    { name: 'a', place: {}, checklist: c2 },
    { name: 'notier', place: {}, checklist: { ...cNoTier, missing: false } },
  ]), 'T2'), true);
}

/* ════════════ 2. 預審與程式 D 徹底隔離 ════════════ */

section('AC-2: 規格預審與程式 D 徹底隔離，不佔 D 輪次、不重設一輪、程式 D 仍從第 1 輪起算', 'P11');
{
  const s = setupProject();
  try {
    const ev = (o) => JSON.stringify({ session: 's1', cwd: s.root, ...o });
    writeFileSync(s.log, [
      ev({ ts: T(-30 * MIN), hook: 'UserPrompt', prompt: '寫一份規格' }),
      ev({ ts: T(-29 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec/SKILL.md'), skill: `${PLUGIN}:spec` }),
      ev({ ts: T(-28 * MIN), hook: 'PostToolUse', tool: 'write_file', file: join(s.root, 'docs/規劃中/feat.md') }),
      ev({ ts: T(-27 * MIN), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/feat.md', source: 'ai', by_session: 's1' }),
      ev({ ts: T(-25 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec-precheck/SKILL.md'), skill: `${PLUGIN}:spec-precheck` }),
    ].join('\n') + '\n');

    const res = runCli(s.root, s.monitorDir, s.home, ['--precheck', 'found', '找到 1 條\n- [P6] 第二條路還沒寫進 AC']);
    eq('--precheck found 離開碼為 0', res.code, 0);
    check('--precheck 回傳明確註記不算程式 D', res.out.includes('不算程式 D'), res.out);

    const all = collectAll({ monitorDir: s.monitorDir, home: s.home });
    const proj = all.projects.find((p) => p.name === basename(s.root));
    const sess = proj?.sessions.find((x) => x.id === 's1');
    const a = sess?.stages.find((x) => x.id === 'A');
    const d = sess?.stages.find((x) => x.id === 'D');
    eq('A 底下的預審狀態為 found', a?.precheck?.state, 'found');
    eq('開工前程式 D 維持 none（還沒跑）', d?.state, 'none');
    eq('程式 D 的 rerun 輪次為 0', d?.rerun?.rounds ?? 0, 0);

    // 點名再預審一次：不重設 roundStart
    const roundBefore = sess?.roundFrom;
    const pc2 = runCli(s.root, s.monitorDir, s.home, ['--precheck', 'ok', '沒對到已知死法']);
    eq('--precheck ok 離開碼為 0', pc2.code, 0);
    check('--precheck ok 不寫「沒問題」或通過（R2）', pc2.out.includes('沒對到已知死法') && !/沒問題/.test(pc2.out), pc2.out);

    // 還沒改程式前跑 --round D → 印出分流提醒
    const rdBeforeCode = runCli(s.root, s.monitorDir, s.home, ['--round', 'D']);
    eq('--round D 離開碼為 0', rdBeforeCode.code, 0);
    check('還沒改程式檔就跑 --round D 會提醒分流到 spec-precheck / --precheck',
      rdBeforeCode.out.includes('提醒分流') && rdBeforeCode.out.includes('--precheck'), rdBeforeCode.out);

    // 開始改危險清單程式檔 → 程式 D 仍是第 1 輪（可派 agent）、且 A 的預審不再誤報過期
    writeFileSync(join(s.root, 'src/danger.js'), 'changed\n');
    writeFileSync(join(s.root, 'docs/規劃中/feat.md'), `${T2_SPEC}\n**AC-1　第一條** ✅ 對過 2026-11-23\n`);
    const lines = readFileSync(s.log, 'utf8').trimEnd().split('\n');
    lines.push(ev({ ts: T(-5 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/danger.js') }));
    writeFileSync(s.log, lines.join('\n') + '\n');

    const rdAfterCode = runCli(s.root, s.monitorDir, s.home, ['--round', 'D']);
    check('改完危險檔後程式 D 仍是「這是第一次」且 T2 可派獨立 agent',
      rdAfterCode.out.includes('這是第一次') && rdAfterCode.out.includes('可以派獨立 agent'), rdAfterCode.out);

    const allAfter = collectAll({ monitorDir: s.monitorDir, home: s.home });
    const sessAfter = allAfter.projects.find((p) => p.name === basename(s.root))?.sessions.find((x) => x.id === 's1');
    eq('重複預審不重設 roundStart', sessAfter?.roundFrom, roundBefore);
    eq('進入 B 打勾 AC 後，預審不誤報過期（stale === false）', sessAfter?.stages.find((x) => x.id === 'A')?.precheck?.stale, false);

    // 收工門禁此時仍要求程式 D（與 C、測試）
    const g = decide({ payload: { cwd: s.root, conversationId: 's1', terminationReason: 'NO_TOOL_CALL' }, monitorDir: s.monitorDir, skillHome: s.home });
    check('改完危險檔後 gate.mjs 仍要求程式 D', g && g.missing.includes('D'), JSON.stringify(g));
  } finally {
    s.cleanup();
  }
}

/* ════════════ 3. 單一真相來源與文案 / 開工前過期 / 長清單遺失 ════════════ */

section('AC-3: 單一真相來源（終端機、collect、ui/app.js）與開工前改規格過期／長清單遺失（P2/P1/P9）', 'P2');
{
  const s = setupProject();
  try {
    const ev = (o) => JSON.stringify({ session: 's1', cwd: s.root, ...o });
    const past = new Date(Date.now() - 10 * MIN * 1000);
    utimesSync(join(s.root, 'docs/規劃中/feat.md'), past, past);
    writeFileSync(s.log, [
      ev({ ts: T(-20 * MIN), hook: 'UserPrompt', prompt: '寫規格' }),
      ev({ ts: T(-19 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec/SKILL.md'), skill: `${PLUGIN}:spec` }),
      ev({ ts: T(-18 * MIN), hook: 'PostToolUse', tool: 'write_file', file: join(s.root, 'docs/規劃中/feat.md') }),
      ev({ ts: T(-17 * MIN), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/feat.md', source: 'ai', by_session: 's1' }),
      ev({ ts: T(-15 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec-precheck/SKILL.md'), skill: `${PLUGIN}:spec-precheck` }),
    ].join('\n') + '\n');

    // 長清單寫入 logs/reports/
    const big = `找到 2 條\n- [P2] ${'很長的發現一'.repeat(120)}\n- [P6] ${'很長的發現二'.repeat(120)}`;
    const bigRes = runCli(s.root, s.monitorDir, s.home, ['--precheck', 'found', big]);
    eq('超長預審清單寫入成功', bigRes.code, 0);
    check('提示整份存在 reports/', bigRes.out.includes('reports/'), bigRes.out);

    // 預審後（開工前）改動規格檔 → stale = true
    writeFileSync(join(s.root, 'docs/規劃中/feat.md'), `${T2_SPEC}\n<!-- edited -->\n`);

    const cliOut = runCli(s.root, s.monitorDir, s.home, []).out;
    const all = collectAll({ monitorDir: s.monitorDir, home: s.home });
    const proj = all.projects.find((p) => p.name === basename(s.root));
    const sess = proj?.sessions.find((x) => x.id === 's1');
    const a = sess?.stages.find((x) => x.id === 'A');
    eq('collect 回傳帶 precheckSupport: true', all.precheckSupport, true);
    eq('開工前預審後改動規格 → stale === true', a?.precheck?.stale, true);
    check('終端機與儀表板說同一句預審狀態與過期提醒',
      cliOut.includes('預審之後規格有改動（要不要再預審由你決定）')
      && a?.precheck?.line?.includes('預審之後規格有改動（要不要再預審由你決定）'),
      `cli:\n${cliOut}\nui:\n${a?.precheck?.line}`);
    check('長清單兩條都在 items 裡', a?.precheck?.items?.length === 2, JSON.stringify(a?.precheck?.items));

    // ui/app.js 的 agent() + workflow() + oldServerBanner() 真的在 ZH / EN 下跑過（不把 agent stub 成空字串）
    const appSrc = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
    const roleMatch = appSrc.match(/const ROLE = \{[\s\S]*?\n\};/)?.[0];
    const hatMatch = appSrc.match(/^function hat\([\s\S]*?\n\}\n/m)?.[0];
    const faceMatch = appSrc.match(/const FACE = \{[^\n]+\};/)?.[0];
    const eyesMatch = appSrc.match(/^function eyes\([\s\S]*?\n\}\n/m)?.[0];
    const agentMatch = appSrc.match(/^function agent\([\s\S]*?\n\}\n/m)?.[0];
    const wfMatch = appSrc.match(/^function workflow\(c\) \{\n[\s\S]*?\n\}\n/m)?.[0];
    const bannerMatch = appSrc.match(/^function oldServerBanner\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
    check('從 ui/app.js 拿得出 agent / workflow / oldServerBanner', Boolean(roleMatch && hatMatch && faceMatch && eyesMatch && agentMatch && wfMatch && bannerMatch));
    if (roleMatch && hatMatch && faceMatch && eyesMatch && agentMatch && wfMatch && bannerMatch) {
      const renderWf = (cardObj, stageList, lang = 'zh') => {
        const zhEn = lang === 'en' ? ((_z, e) => e) : ((z) => z);
        const escFn = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
        const fn = new Function('ROLE_SRC', 'esc', 'stageState', 'roundStage', 'foldOpen', 'directorRow', 'OLD_LINE', 'zhEn',
          `${roleMatch}\n${hatMatch}\n${faceMatch}\n${eyesMatch}\n${agentMatch}\n${wfMatch}\nreturn workflow;`);
        return fn({}, escFn, (x) => x.state, (id) => ({ st: stageList.find((x) => x.id === id) ?? { id, state: 'none' } }), () => false, () => '', 'OLD', zhEn)(cardObj);
      };
      const html = renderWf(sess, sess.stages, 'zh');
      check('ui/app.js workflow 畫出預審行與清單', html.includes('預審之後規格有改動') && html.includes('很長的發現一'), html);

      // 驗證 precheck.state === 'ok' 送進真實 agent() + workflow() 不打綠勾、工班不笑眼（P10）
      const stOk = {
        id: 'A', name: '寫規格', skill: 'spec', state: 'done', doneBy: 'ai', doneAt: T(-10 * MIN),
        precheck: { state: 'ok', line: precheckLine({ state: 'ok', reportedAt: T(-60), calledAt: T(-120), took: { minutes: 1, latest: true }, stale: false }), items: [] },
      };
      const okHtml = renderWf({ ...sess, stages: [stOk] }, [stOk], 'zh');
      check('ui/app.js ok 不給假綠勾、不畫笑臉（data-face="open"，無 happy、無 ✅）',
        okHtml.includes('data-face="open"') && !okHtml.includes('data-face="happy"') && !okHtml.includes('✅'), okHtml);

      // EN workflow + oldServerBanner 檢查零中文且守住禁詞（用純英文 stage 欄位測 workflow 預審 EN 輸出）
      const enA = {
        id: 'A', name: 'Write a spec', skill: 'spec', state: 'done', doneBy: 'ai', doneAt: T(-10 * MIN),
        line: '10m ago AI called spec', notes: [], checklist: null,
        precheck: {
          state: 'found',
          line: withLang('en', () => precheckLine({ state: 'found', reportedAt: T(-60), calledAt: T(-120), took: { minutes: 1, latest: true }, stale: true })),
          items: ['- [P2] Missing branch'],
        },
      };
      const enHtml = renderWf({ ...sess, stages: [enA] }, [enA], 'en');
      check('ui/app.js workflow（en）零中文且畫出預審行與項目',
        !CJK.test(enHtml) && enHtml.includes('the spec changed after the precheck') && enHtml.includes('Missing branch'), enHtml);

      const bannerEn = new Function('latest', 'zhEn', `${bannerMatch}\nreturn oldServerBanner();`)({ sharedLines: true, stampHelp: true, todo: true, guardSupport: true }, (_z, e) => e);
      check('oldServerBanner（en）缺 precheckSupport 時亮黃條且零中文',
        !CJK.test(bannerEn) && bannerEn.includes('agy-pipeline --serve-restart'), bannerEn);
    }

    // 刪掉 reports 檔 → 讀不到要明講「完整清單找不到」（R1）；ZH 與 EN 皆檢查
    const repDir = join(s.monitorDir, 'logs', 'reports');
    rmSync(repDir, { recursive: true, force: true });
    const missingNote = collectAll({ monitorDir: s.monitorDir, home: s.home })
      .projects.find((p) => p.name === basename(s.root))
      ?.sessions.find((x) => x.id === 's1')?.stages.find((x) => x.id === 'A')?.precheck;
    check('reports 遺失時誠實講「完整清單找不到」', missingNote?.items?.some((x) => x.includes('完整清單找不到')), JSON.stringify(missingNote));
    const missingNoteEn = withLang('en', () => collectAll({ monitorDir: s.monitorDir, home: s.home })
      .projects.find((p) => p.name === basename(s.root))
      ?.sessions.find((x) => x.id === 's1')?.stages.find((x) => x.id === 'A')?.precheck);
    check('reports 遺失（en）零中文且誠實講讀不到完整清單',
      missingNoteEn?.items?.some((x) => !CJK.test(x) && /full list|couldn't be found/i.test(x)), JSON.stringify(missingNoteEn));
  } finally {
    s.cleanup();
  }
}

section('D 第一輪迴歸：同回合重叫／共用工作區隔離／stageFacts 衝突／同秒毫秒 stale（P1/P2/P6/P9/R1）', 'P2');
{
  // 1. 同回合 --precheck 後重叫 spec-precheck：sessionView 與 roundView fallback 皆切出第 2 次 no-report
  const s = setupProject();
  try {
    const ev = (o) => JSON.stringify({ session: 's1', cwd: s.root, ...o });
    const t0 = Date.now() - 10 * MIN * 1000;
    const iso = (ms) => new Date(ms).toISOString();
    writeFileSync(s.log, [
      ev({ ts: iso(t0), hook: 'UserPrompt', prompt: '寫規格' }),
      ev({ ts: iso(t0 + 1000), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec/SKILL.md'), skill: `${PLUGIN}:spec` }),
      ev({ ts: iso(t0 + 2000), hook: 'PostToolUse', tool: 'write_file', file: join(s.root, 'docs/規劃中/feat.md') }),
      ev({ ts: iso(t0 + 3000), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/feat.md', source: 'ai', by_session: 's1' }),
      ev({ ts: iso(t0 + 4000), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec-precheck/SKILL.md'), skill: `${PLUGIN}:spec-precheck` }),
      JSON.stringify({ ts: iso(t0 + 5000), cwd: s.root, event: 'spec_precheck', verdict: 'found', note: 'gap 1', source: 'ai', by_session: 's1' }),
      ev({ ts: iso(t0 + 6000), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec-precheck/SKILL.md'), skill: `${PLUGIN}:spec-precheck` }),
    ].join('\n') + '\n');

    const readLog = (f) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const events = readLog(s.log);
    const stageList = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
    const sv = sessionView(events, stageList, 's1', null, s.root);
    const rvFallback = roundView({
      events,
      runs: runsPerStage(events, stageList, (e) => !e._subagent && e.session === 's1'),
      cleared: new Map(),
      reports: reportsIn(events, (e) => !e._subagent && (!e.by_session || e.by_session === 's1')),
      stages: stageList,
      session: 's1',
      root: s.root,
    });
    const pcCard = collectAll({ monitorDir: s.monitorDir, home: s.home }).projects.find((p) => p.name === basename(s.root))?.cards[0]?.stages.find((x) => x.id === 'A')?.precheck;
    const pcSv = sv.view.stages.find((x) => x.id === 'A')?.precheck;
    const pcRv = rvFallback.stages.find((x) => x.id === 'A')?.precheck;
    eq('同回合重叫：sessionView 為 no-report / count=2 / rounds=1', `${pcSv?.state}/${pcSv?.count}/${pcSv?.rounds}`, 'no-report/2/1');
    eq('同回合重叫：roundView fallback 與 sessionView 一致', `${pcRv?.state}/${pcRv?.count}/${pcRv?.rounds}`, 'no-report/2/1');
    check('同回合重叫：工作區 card 與對話一致（no-report）', pcCard?.state === 'no-report' && pcCard?.line?.includes('還沒記結論'), JSON.stringify(pcCard));
    const gRep = decide({ payload: { cwd: s.root, conversationId: 's1', terminationReason: 'NO_TOOL_CALL' }, monitorDir: s.monitorDir, skillHome: s.home });
    check('同回合重叫沒記結論：gate.mjs 擋 A:precheck:report', gRep?.missing?.includes('A:precheck:report'), JSON.stringify(gRep));

    // 2. 共用工作區：沒有 by_session 的 spec_precheck 不冒領進 s1；precheckOf 無 calls 回 none
    eq('precheckOf 無 calls 只給 report → none（R2）',
      precheckOf({ calls: [], reports: [{ event: 'spec_precheck', verdict: 'ok', ts: iso(t0 + 1000) }] }).state, 'none');

    writeFileSync(s.log, [
      ev({ ts: iso(t0), hook: 'UserPrompt', prompt: '寫 s1 規格' }),
      ev({ ts: iso(t0 + 1000), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec/SKILL.md'), skill: `${PLUGIN}:spec` }),
      ev({ ts: iso(t0 + 2000), hook: 'PostToolUse', tool: 'write_file', file: join(s.root, 'docs/規劃中/feat.md') }),
      ev({ ts: iso(t0 + 3000), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/feat.md', source: 'ai', by_session: 's1' }),
      JSON.stringify({ session: 's2', cwd: s.root, ts: iso(t0 + 4000), hook: 'UserPrompt', prompt: 's2 在同工作區' }),
      JSON.stringify({ cwd: s.root, ts: iso(t0 + 5000), event: 'spec_precheck', verdict: 'ok', note: 'unowned from terminal', source: 'ai' }),
    ].join('\n') + '\n');
    const svShared = sessionView(readLog(s.log), JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages, 's1', null, s.root);
    eq('共用工作區：未標對話的 spec_precheck 不會讓 s1 冒領成 ok', svShared.view.stages.find((x) => x.id === 'A')?.precheck?.state, 'none');
    const gUnowned = decide({ payload: { cwd: s.root, conversationId: 's1', terminationReason: 'NO_TOOL_CALL' }, monitorDir: s.monitorDir, skillHome: s.home });
    check('共用工作區：s1 仍被 gate 擋 A:precheck', gUnowned?.missing?.includes('A:precheck'), JSON.stringify(gUnowned));

    // 3. 共用工作區 stageFacts：Case A（s2 未寫規格見 s1 問題）、Case B（s1 不串到 s2 規格）、Case B2（s2 不繼承 s1 ok）
    writeFileSync(join(s.root, 'docs/規劃中/feat2.md'), T2_SPEC);
    writeFileSync(s.log, [
      ev({ ts: iso(t0), hook: 'UserPrompt', prompt: '寫 s1 規格' }),
      ev({ ts: iso(t0 + 1000), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec/SKILL.md'), skill: `${PLUGIN}:spec` }),
      ev({ ts: iso(t0 + 2000), hook: 'PostToolUse', tool: 'write_file', file: join(s.root, 'docs/規劃中/feat.md') }),
      ev({ ts: iso(t0 + 3000), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/feat.md', source: 'ai', by_session: 's1' }),
      ev({ ts: iso(t0 + 4000), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec-precheck/SKILL.md'), skill: `${PLUGIN}:spec-precheck` }),
      JSON.stringify({ ts: iso(t0 + 5000), cwd: s.root, event: 'spec_precheck', verdict: 'found', note: '找到 2 條', source: 'ai', by_session: 's1' }),
      JSON.stringify({ session: 's2', cwd: s.root, ts: iso(t0 + 6000), hook: 'UserPrompt', prompt: 's2 只查看狀態' }),
    ].join('\n') + '\n');
    const s2CaseA = runCli(s.root, s.monitorDir, s.home, [], { sid: 's2' });
    check('共用工作區 Case A：沒寫規格的 s2 仍看得到 s1 預審找到的問題', s2CaseA.out.includes('找到 2 條'), s2CaseA.out);

    const logB = readFileSync(s.log, 'utf8').trimEnd().split('\n');
    logB.push(
      JSON.stringify({ session: 's2', cwd: s.root, ts: iso(t0 + 7000), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec/SKILL.md'), skill: `${PLUGIN}:spec` }),
      JSON.stringify({ session: 's2', cwd: s.root, ts: iso(t0 + 8000), hook: 'PostToolUse', tool: 'write_file', file: join(s.root, 'docs/規劃中/feat2.md') }),
      JSON.stringify({ cwd: s.root, ts: iso(t0 + 9000), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/feat2.md', source: 'ai', by_session: 's2' }),
    );
    writeFileSync(s.log, logB.join('\n') + '\n');
    const s2CaseB2 = runCli(s.root, s.monitorDir, s.home, [], { sid: 's2' });
    check('共用工作區 Case B2：s2 的 feat2.md 顯示規格預審還沒跑，不冒領 s1 結論',
      s2CaseB2.out.includes('feat2.md') && !s2CaseB2.out.includes('找到 2 條') && s2CaseB2.out.includes('還沒跑'), s2CaseB2.out);

    // Case B + B.checklist 同步：s2 把 feat2.md 唯一一條打勾 ✅ 並開始改程式，s1 的 B 不得誤顯示 s2 已對完清單
    writeFileSync(join(s.root, 'docs/規劃中/feat2.md'), `${T2_SPEC}\n**AC-1　第一條** ✅ 對過 2026-11-23\n`);
    writeFileSync(join(s.root, 'src/a.js'), 'edited by s2\n');
    logB.push(JSON.stringify({ session: 's2', cwd: s.root, ts: iso(t0 + 9500), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') }));
    writeFileSync(s.log, logB.join('\n') + '\n');
    const s1CaseB = runCli(s.root, s.monitorDir, s.home, [], { sid: 's1' });
    check('共用工作區 Case B：s1 看到自己的 feat.md 與預審結果，B 也不誤顯 feat2.md 已對完清單',
      s1CaseB.out.includes('feat.md') && s1CaseB.out.includes('找到 2 條') && !s1CaseB.out.includes('feat2.md') && !s1CaseB.out.includes('AI 對完清單'), s1CaseB.out);

    // 共用工作區總覽卡（session null）：s1 叫 C、s2 接力記 --report C ok，總覽卡 C 不被 ownRep 洗成未記結論
    writeFileSync(s.log, [
      ev({ ts: iso(t0), hook: 'UserPrompt', prompt: 's1 cleanup' }),
      ev({ ts: iso(t0 + 1000), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/cleanup/SKILL.md'), skill: `${PLUGIN}:cleanup` }),
      JSON.stringify({ session: 's2', cwd: s.root, ts: iso(t0 + 2000), hook: 'UserPrompt', prompt: 's2 report C' }),
      JSON.stringify({ cwd: s.root, ts: iso(t0 + 3000), event: 'stage_report', stage: 'C', verdict: 'ok', note: '已改 0 項', source: 'ai', by_session: 's2' }),
    ].join('\n') + '\n');
    const wsCard = collectAll({ monitorDir: s.monitorDir, home: s.home }).projects.find((p) => p.name === basename(s.root))?.cards[0];
    const wsC = wsCard?.stages?.find((x) => x.id === 'C');
    check('共用工作區總覽卡（session null）保留跨對話接力記的 C 結論',
      wsC?.doneBy === 'ai' && (wsC?.state === 'done' || wsC?.state === 'passed') && wsC?.line?.includes('已改 0 項'), JSON.stringify(wsC));

    // 4. 同一秒內「hook 秒精度（Z）」配「mtime 毫秒（.900Z）」不因字串排序丟掉 stale（P9）
    const baseSec = Math.floor((Date.now() - 120_000) / 1000) * 1000;
    const callTs = new Date(baseSec + 500).toISOString();
    const repTs = new Date(baseSec + 600).toISOString();
    const hookSecIso = new Date(baseSec + 2000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const repEv = { event: 'stage_report', stage: 'A', ts: repTs, verdict: 'ok', note: 'docs/規劃中/feat.md', by_session: 's1', cwd: s.root };
    const rvStale = roundView({
      events: [],
      stages: JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages,
      runs: new Map([['A', [{ ts: new Date(baseSec).toISOString(), session: 's1', via: 'skill', cwd: s.root }]]]),
      cleared: new Map(),
      reports: new Map([['A', repEv]]),
      reportLog: [repEv],
      edits: [{ ts: hookSecIso, tool: 'edit_file', file: join(s.root, 'docs/規劃中/feat.md'), session: 's1' }],
      isCode: () => false,
      root: s.root,
      mtimeOf: () => baseSec + 2900,
      prechecks: [{ ts: repTs, verdict: 'ok', note: 'ok', by_session: 's1' }],
      precheckCalls: [{ ts: callTs, session: 's1', via: 'skill' }],
    });
    eq('同秒混合精度（02Z vs 02.900Z）比對毫秒後正確判為 stale === true（P9）', rvStale.stages.find((x) => x.id === 'A')?.precheck?.stale, true);
  } finally {
    s.cleanup();
  }

  // 5. 未設分級專案、git 已改到程式檔（沒有感測器改檔事件）→ --round D 不誤印「還沒改到程式檔」
  const sNoTier = setupProject({ tier: null });
  try {
    const ev = (o) => JSON.stringify({ session: 's1', cwd: sNoTier.root, ...o });
    writeFileSync(sNoTier.log, [
      ev({ ts: T(-20 * MIN), hook: 'UserPrompt', prompt: '寫規格' }),
      ev({ ts: T(-19 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(sNoTier.home, '.gemini/config/plugins', PLUGIN, 'skills/spec/SKILL.md'), skill: `${PLUGIN}:spec` }),
      ev({ ts: T(-18 * MIN), hook: 'PostToolUse', tool: 'write_file', file: join(sNoTier.root, 'docs/規劃中/feat.md') }),
      ev({ ts: T(-17 * MIN), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/feat.md', source: 'ai', by_session: 's1' }),
    ].join('\n') + '\n');
    writeFileSync(join(sNoTier.root, 'src/a.js'), 'edited outside sensor\n');
    const rdNoTier = runCli(sNoTier.root, sNoTier.monitorDir, sNoTier.home, ['--round', 'D']);
    check('未設分級＋git 有程式改動時，--round D 不誤印分流提醒（R1）', !rdNoTier.out.includes('提醒分流'), rdNoTier.out);
  } finally {
    sNoTier.cleanup();
  }
}

/* ════════════ 4. 白板、F 工地主任與 no-record/ok/found/no-report（P10） ════════════ */

section('AC-3: 白板與 F 工地主任不因預審沒記結論或找到問題而誤亮「只剩收尾」，ok 不給假綠勾（P10）', 'P10');
{
  const card = { path: '/w/pc', gone: false, notGit: false, ladder: { steps: [{ id: 'commit', state: 'done', text: '都存好了' }, { id: 'merge', state: 'none', text: '不用併' }, { id: 'push', state: 'none', text: '無遠端' }] }, checkpoint: { commit: 'abc' }, checkpointRelation: { state: 'ok', commitsAfter: 0 } };
  const baseStage = (precheck) => [
    { id: 'A', name: '寫規格', skill: 'spec', state: 'done', doneBy: 'ai', doneAt: '2026-11-23T01:00:00Z',
      checklist: { parsed: true, total: 1, checked: 0, unmarked: 1, pending: 0 }, precheck },
    { id: 'B', name: '寫程式', type: 'main-conversation', state: 'main' },
  ];
  const makeAll = (precheck) => ({
    projects: [{
      name: 'pc', displayName: 'pc', cards: [card], mainRoot: '/w/pc', suggestions: [], incomingSuggestions: [],
      sessions: [{
        id: 's1', title: '寫規格中', cwd: '/w/pc', lastTs: '2026-11-23T01:10:00Z', lastSaidAt: '2026-11-23T00:50:00Z',
        closedAt: null, deletedAt: null, movedOn: null, card,
        tier: { state: 'no-change', lines: { reqs: [] }, staleNotes: [] },
        stages: baseStage(precheck),
      }],
    }],
  });

  const tbNoRep = todoBoard(makeAll({ state: 'no-report', line: precheckLine({ state: 'no-report', calledAt: T(-120) }) }));
  const rowNoRep = tbNoRep.projects[0].rows[0];
  check('預審叫了沒記結論 → 列為還差（todo）', rowNoRep.items.some((i) => i.kind === 'todo' && i.text.includes('還沒記結論')), JSON.stringify(rowNoRep.items));
  eq('預審叫了沒記結論 → F 工地主任不亮（call === null）', rowNoRep.call, null);

  const tbFound = todoBoard(makeAll({ state: 'found', head: '找到 2 條', line: precheckLine({ state: 'found', reportedAt: T(-60), note: '找到 2 條' }) }));
  const rowFound = tbFound.projects[0].rows[0];
  check('預審找到問題等點頭 → 等你決定含預審問題且 F 工地主任不亮',
    rowFound.items.some((i) => i.kind === 'ask' && i.text.includes('規格預審找到問題')) && rowFound.call === null,
    JSON.stringify(rowFound));

  // waitingNod === false 時（例如寫完規格後使用者追問過一句、尚未動程式，而且規格尚無 AC 標題＋只剩存檔）：found 絕不從白板消失、F 不亮、不誤說可結案（P10）
  const spokenAfterDone = makeAll({ state: 'found', head: '找到 2 條', note: '找到 2 條' });
  spokenAfterDone.projects[0].cards[0].ladder.steps[0] = { id: 'commit', state: 'pending', text: '有改動還沒存檔' };
  spokenAfterDone.projects[0].sessions[0].lastSaidAt = '2026-11-23T01:05:00Z';
  spokenAfterDone.projects[0].sessions[0].stages[0].checklist = null;
  const tbSpoken = todoBoard(spokenAfterDone);
  const rowSpoken = tbSpoken.projects[0].rows[0];
  check('waitingNod === false（已追問、無 AC、還沒存檔）→ 白板仍列預審問題、F 不亮、不誤說可以結案',
    rowSpoken.items.some((i) => i.kind === 'ask' && i.text.includes('規格預審找到問題')) && rowSpoken.call === null && rowSpoken.clear === null,
    JSON.stringify(rowSpoken));

  // --spec 連結規格後手動跑預審找到問題（doneAt === null）
  const linkedFound = makeAll({ state: 'found', head: '找到 1 條', note: '找到 1 條' });
  linkedFound.projects[0].sessions[0].stages[0].doneAt = null;
  linkedFound.projects[0].sessions[0].stages[0].doneBy = null;
  linkedFound.projects[0].sessions[0].stages[0].checklist = null;
  const tbLinked = todoBoard(linkedFound);
  const rowLinked = tbLinked.projects[0].rows[0];
  check('--spec 連結後預審 found → 白板列問題、F 不亮、clear === null',
    rowLinked.items.some((i) => i.kind === 'ask' && i.text.includes('規格預審找到問題')) && rowLinked.call === null && rowLinked.clear === null,
    JSON.stringify(rowLinked));

  // state === 'ok' 送進 todoBoard 不出現假綠勾（P10）
  const tbOk = todoBoard(makeAll({ state: 'ok', reportedAt: T(-60), line: precheckLine({ state: 'ok', reportedAt: T(-60), note: '沒對到已知死法' }) }));
  const rowOk = tbOk.projects[0].rows[0];
  check('預審 state === ok 進 todoBoard 不出現 ✅（P10）', !JSON.stringify(rowOk).includes('✅'), JSON.stringify(rowOk));

  // EN 版 todoBoard 覆蓋 no-report / found（waitingNod true 與 false）零中文
  withLang('en', () => {
    const enCard = {
      path: '/w/pc', gone: false, notGit: false,
      ladder: { steps: [{ id: 'commit', state: 'done', text: 'All committed' }, { id: 'merge', state: 'none', text: 'Nothing to merge' }, { id: 'push', state: 'none', text: 'No remote' }] },
      checkpoint: { commit: 'abc' }, checkpointRelation: { state: 'ok', commitsAfter: 0 },
    };
    const makeEnAll = (precheck, overrides = {}) => ({
      projects: [{
        name: 'pc', displayName: 'pc', cards: [enCard], mainRoot: '/w/pc', suggestions: [], incomingSuggestions: [],
        sessions: [{
          id: 's1', title: 'Writing spec', cwd: '/w/pc', lastTs: '2026-11-23T01:10:00Z', lastSaidAt: '2026-11-23T00:50:00Z',
          closedAt: null, deletedAt: null, movedOn: null, card: enCard,
          tier: { state: 'no-change', lines: { reqs: [] }, staleNotes: [] },
          stages: [
            { id: 'A', name: 'Write a spec', skill: 'spec', state: 'done', doneBy: 'ai', doneAt: '2026-11-23T01:00:00Z',
              checklist: { parsed: true, total: 1, checked: 0, unmarked: 1, pending: 0 }, precheck },
            { id: 'B', name: 'Build', type: 'main-conversation', state: 'main' },
          ],
          ...overrides,
        }],
      }],
    });
    for (const st of [
      { state: 'no-report', calledAt: T(-120), line: precheckLine({ state: 'no-report', calledAt: T(-120) }) },
      { state: 'found', head: 'Found 2', reportedAt: T(-60), note: 'Found 2', line: precheckLine({ state: 'found', reportedAt: T(-60), note: 'Found 2' }) },
    ]) {
      const tbEn1 = todoBoard(makeEnAll(st));
      const tbEn2 = todoBoard(makeEnAll(st, {
        lastSaidAt: '2026-11-23T01:05:00Z',
        stages: [
          { id: 'A', name: 'Write a spec', skill: 'spec', state: 'done', doneBy: 'ai', doneAt: '2026-11-23T01:00:00Z', checklist: null, precheck: st },
          { id: 'B', name: 'Build', type: 'main-conversation', state: 'main' },
        ],
      }));
      const txt = JSON.stringify([tbEn1.projects[0].rows[0], tbEn2.projects[0].rows[0]]);
      check(`todoBoard(${st.state}, en) 零中文殘留`, !CJK.test(txt), txt);
    }
  });
}

/* ════════════ 5. gate.mjs 只在已設定分級專案＋預測最高級＋剛寫完規格擋一次 ════════════ */

section('AC-4: gate.mjs 只在已設定分級專案＋預測最高級＋還沒動工擋一次，其餘一律放行（P6/P7）', 'P6');
{
  const runGateCase = (label, opts, buildEvents, { executionNum = 0, expectMissing = null } = {}) => {
    const s = setupProject(opts);
    try {
      const ev = (o) => JSON.stringify({ session: 's1', cwd: s.root, ...o });
      writeFileSync(s.log, buildEvents(s, ev).join('\n') + '\n');
      const d = decide({
        payload: { cwd: s.root, conversationId: 's1', terminationReason: 'NO_TOOL_CALL', executionNum },
        monitorDir: s.monitorDir,
        skillHome: s.home,
      });
      if (expectMissing === null) {
        eq(`${label} → 放行（null）`, d, null);
      } else {
        check(`${label} → 擋 [${expectMissing.join(',')}]`, d && JSON.stringify(d.missing) === JSON.stringify(expectMissing), JSON.stringify(d));
      }
      return d;
    } finally {
      s.cleanup();
    }
  };

  const baseSpecEvs = (s, ev, { report = true, precheckCall = false, precheckReport = null, extra = [] } = {}) => [
    ev({ ts: T(-20 * MIN), hook: 'UserPrompt', prompt: '幫我寫規格' }),
    ev({ ts: T(-19 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec/SKILL.md'), skill: `${PLUGIN}:spec` }),
    ev({ ts: T(-18 * MIN), hook: 'PostToolUse', tool: 'write_file', file: join(s.root, 'docs/規劃中/feat.md') }),
    ...(report ? [ev({ ts: T(-17 * MIN), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/feat.md', source: 'ai', by_session: 's1' })] : []),
    ...(precheckCall ? [ev({ ts: T(-16 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec-precheck/SKILL.md'), skill: `${PLUGIN}:spec-precheck` })] : []),
    ...(precheckReport ? [ev({ ts: T(-15 * MIN), event: 'spec_precheck', verdict: precheckReport, note: '結論', source: 'ai', by_session: 's1' })] : []),
    ...extra.map((fn) => fn(s, ev)),
  ];

  // ① T2 規格寫完忘記預審 → 擋一次 A:precheck
  runGateCase('已設定分級＋預測 T2＋寫完沒預審', {}, (s, ev) => baseSpecEvs(s, ev), { expectMissing: ['A:precheck'] });

  // ② 同回合已擋過 A:precheck（executionNum > 0）→ 放行不重擋
  runGateCase('同回合已擋過 A:precheck（防迴圈）', {}, (s, ev) => baseSpecEvs(s, ev, {
    extra: [(s2, e2) => e2({ ts: T(-16 * MIN), event: 'gate_blocked', missing: ['A:precheck'], source: 'gate' })],
  }), { executionNum: 1, expectMissing: null });

  // ③ 叫了 spec-precheck 沒記結論 → 擋一次 A:precheck:report
  runGateCase('叫了 spec-precheck 沒記結論', {}, (s, ev) => baseSpecEvs(s, ev, { precheckCall: true }), { expectMissing: ['A:precheck:report'] });

  // ④ 已有 spec_precheck 結論後，後續再改規格（純修規格）→ 不重擋
  runGateCase('已有預審結論後再改規格', {}, (s, ev) => baseSpecEvs(s, ev, {
    precheckCall: true,
    precheckReport: 'found',
    extra: [
      (s2, e2) => e2({ ts: T(-10 * MIN), hook: 'UserPrompt', prompt: '改一下 AC-1' }),
      (s2, e2) => e2({ ts: T(-9 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s2.root, 'docs/規劃中/feat.md') }),
    ],
  }), { expectMissing: null });

  // ⑤ T1 規格（即使括號提到 T2）→ 不擋 A:precheck
  runGateCase('預測 T1 規格（括號提到 T2）', { spec: T1_SPEC }, (s, ev) => baseSpecEvs(s, ev), { expectMissing: null });

  // ⑥ 未設定分級（unset）、設成不分級（tiers.off）、退出記錄 → 一律不擋
  runGateCase('未設定分級專案（tiers unset）', { tier: null }, (s, ev) => baseSpecEvs(s, ev), { expectMissing: null });
  runGateCase('設定成不分級（tiers.off）', { tier: { off: true, at: T(-100 * MIN) } }, (s, ev) => baseSpecEvs(s, ev), { expectMissing: null });
  runGateCase('退出記錄的專案', { extraFiles: { '.agents/pipeline-monitor.off': '{}' } }, (s, ev) => baseSpecEvs(s, ev), { expectMissing: null });

  // ⑦ A 還在澄清需求，還沒寫出規格檔 → 不擋
  runGateCase('A 只問問題還沒寫出規格檔', { spec: null }, (s, ev) => [
    ev({ ts: T(-20 * MIN), hook: 'UserPrompt', prompt: '幫我寫規格' }),
    ev({ ts: T(-19 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec/SKILL.md'), skill: `${PLUGIN}:spec` }),
  ], { expectMissing: null });

  // ⑧ 已經開始改程式（B 已啟動）→ 不擋 A:precheck（會交給既有程式 D 門禁）
  const dCode = runGateCase('已開始改程式（B 已啟動）不擋 A:precheck', {}, (s, ev) => {
    writeFileSync(join(s.root, 'src/a.js'), 'edited\n');
    return baseSpecEvs(s, ev, {
      extra: [(s2, e2) => e2({ ts: T(-10 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s2.root, 'src/a.js') })],
    });
  }, { expectMissing: ['checklist', 'D'] });
  check('……只要求 D，不含 A:precheck', dCode && !dCode.missing.includes('A:precheck'), JSON.stringify(dCode));

  // ⑨ 照別的對話寫好的規格施工（--spec 連結）→ 不擋 A:precheck，且 --round precheck 不印「自動跑一輪」
  runGateCase('照別的對話規格施工（spec_link）', {}, (s, ev) => [
    ev({ ts: T(-20 * MIN), hook: 'UserPrompt', prompt: '照規格做' }),
    ev({ ts: T(-19 * MIN), event: 'spec_link', spec: 'docs/規劃中/feat.md', by_session: 's1', source: 'ai' }),
  ], { expectMissing: null });

  const sLink = setupProject();
  try {
    const ev = (o) => JSON.stringify({ session: 's1', cwd: sLink.root, ...o });
    writeFileSync(sLink.log, [
      ev({ ts: T(-20 * MIN), hook: 'UserPrompt', prompt: '照規格做' }),
      ev({ ts: T(-19 * MIN), event: 'spec_link', spec: 'docs/規劃中/feat.md', by_session: 's1', source: 'ai' }),
    ].join('\n') + '\n');
    const rdLink = runCli(sLink.root, sLink.monitorDir, sLink.home, ['--round', 'precheck']);
    check('--spec 連結 T2 規格時，--round precheck 不印自動跑一輪',
      rdLink.out.includes('不自動跑預審') && !rdLink.out.includes('寫完規格後自動跑一輪預審'), rdLink.out);
  } finally {
    sLink.cleanup();
  }

  // 多份規格中有一份未寫分級（T1 ＋ 沒寫分級）→ --round precheck 明講「分不清」，不折成未達最高級（ZH / EN）
  const sMulti = setupProject({ spec: T1_SPEC });
  try {
    writeFileSync(join(sMulti.root, 'docs/規劃中/part2.md'), '# Draft\n\n**AC-1 item**\n');
    const ev = (o) => JSON.stringify({ session: 's1', cwd: sMulti.root, ...o });
    writeFileSync(sMulti.log, [
      ev({ ts: T(-20 * MIN), hook: 'UserPrompt', prompt: '寫兩份規格' }),
      ev({ ts: T(-19 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(sMulti.home, '.gemini/config/plugins', PLUGIN, 'skills/spec/SKILL.md'), skill: `${PLUGIN}:spec` }),
      ev({ ts: T(-18 * MIN), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/feat.md、docs/規劃中/part2.md', source: 'ai', by_session: 's1' }),
    ].join('\n') + '\n');
    const rdMultiZh = runCli(sMulti.root, sMulti.monitorDir, sMulti.home, ['--round', 'precheck'], { lang: 'zh' });
    check('多份規格缺分級（zh）→ --round precheck 講分不清是否達最高級（R1）', rdMultiZh.out.includes('分不清是否預測達最高級') && rdMultiZh.out.includes('part2'), rdMultiZh.out);
    const rdMultiEn = runCli(sMulti.root, sMulti.monitorDir, sMulti.home, ['--round', 'precheck'], { lang: 'en' });
    const stripM = (t) => t.replace(/docs\/規劃中\/[^\s）)]+/g, 'docs/spec.md');
    check('多份規格缺分級（en）→ --round precheck 零中文且講 lacked a readable predicted tier',
      !CJK.test(stripM(rdMultiEn.out)) && rdMultiEn.out.includes('lacked a readable predicted tier'), rdMultiEn.out);
  } finally {
    sMulti.cleanup();
  }
}

/* ════════════ 6. 雙語模式：英文零中文殘留、不含紅線禁詞 ════════════ */

section('AC-5: 雙語模式（--lang en）零中文殘留、不含紅線禁詞，--round precheck 與 --round D 分流齊全', 'P2');
{
  const s = setupProject();
  try {
    const ev = (o) => JSON.stringify({ session: 's1', cwd: s.root, ...o });
    writeFileSync(s.log, [
      ev({ ts: T(-20 * MIN), hook: 'UserPrompt', prompt: 'write a spec' }),
      ev({ ts: T(-19 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec/SKILL.md'), skill: `${PLUGIN}:spec` }),
      ev({ ts: T(-18 * MIN), hook: 'PostToolUse', tool: 'write_file', file: join(s.root, 'docs/規劃中/feat.md') }),
      ev({ ts: T(-17 * MIN), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/feat.md', source: 'ai', by_session: 's1' }),
    ].join('\n') + '\n');

    // gate.mjs EN 模式：A:precheck 與 A:precheck:report 零中文
    const gPreEn = withLang('en', () => decide({ payload: { cwd: s.root, conversationId: 's1', terminationReason: 'NO_TOOL_CALL' }, monitorDir: s.monitorDir, skillHome: s.home }));
    check('gate.mjs（en）擋 A:precheck 零中文且含強制指令',
      Boolean(gPreEn?.missing?.includes('A:precheck')) && !CJK.test(JSON.stringify(gPreEn)), JSON.stringify(gPreEn));

    const logEn = readFileSync(s.log, 'utf8').trimEnd().split('\n');
    logEn.push(ev({ ts: T(-16 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec-precheck/SKILL.md'), skill: `${PLUGIN}:spec-precheck` }));
    writeFileSync(s.log, logEn.join('\n') + '\n');
    const gRepEn = withLang('en', () => decide({ payload: { cwd: s.root, conversationId: 's1', terminationReason: 'NO_TOOL_CALL' }, monitorDir: s.monitorDir, skillHome: s.home }));
    check('gate.mjs（en）擋 A:precheck:report 零中文',
      Boolean(gRepEn?.missing?.includes('A:precheck:report')) && !CJK.test(JSON.stringify(gRepEn)), JSON.stringify(gRepEn));

    const rPre = runCli(s.root, s.monitorDir, s.home, ['--round', 'precheck'], { lang: 'en' });
    eq('--round precheck（en）離開碼 0', rPre.code, 0);
    // 排除規格路徑與檔案內容的中文（如 docs/規劃中）後檢查英文輸出
    const stripPaths = (t) => t.replace(/docs\/規劃中\/[^\s）)]+/g, 'docs/spec.md');
    check('--round precheck（en）沒有中文', !CJK.test(stripPaths(rPre.out)), rPre.out);
    check('--round precheck（en）講到 T2 自動觸發與清單', rPre.out.includes('highest tier (T2)') && rPre.out.includes('FAILURE-PATTERNS.md'), rPre.out);

    const rD = runCli(s.root, s.monitorDir, s.home, ['--round', 'D'], { lang: 'en' });
    check('--round D（en）未改程式時印出 Split reminder', rD.out.includes('Split reminder') && rD.out.includes('spec-precheck'), rD.out);

    const rFound = runCli(s.root, s.monitorDir, s.home, ['--precheck', 'found', 'Found 1 issue\n- [P6] second path missing'], { lang: 'en' });
    eq('--precheck found（en）離開碼 0', rFound.code, 0);
    check('--precheck found（en）零中文且不含禁詞', !CJK.test(rFound.out) && !/\b(?:passed|all clear|no problems|safe|verified)\b/i.test(rFound.out), rFound.out);

    const rRec = runCli(s.root, s.monitorDir, s.home, ['--precheck', 'ok', 'didn\'t match any known failure pattern'], { lang: 'en' });
    eq('--precheck ok（en）離開碼 0', rRec.code, 0);
    check('--precheck ok（en）沒有中文且不含禁詞', !CJK.test(rRec.out) && !/\b(?:passed|all clear|no problems|safe|verified)\b/i.test(rRec.out), rRec.out);

    const rStatus = runCli(s.root, s.monitorDir, s.home, [], { lang: 'en' });
    const pcStatusLine = rStatus.out.split('\n').find((l) => l.includes('Spec precheck:')) ?? '';
    check('status（en）預審行沒有中文且守住紅線用詞',
      Boolean(pcStatusLine) && !CJK.test(pcStatusLine)
      && pcStatusLine.includes('didn\'t match any known failure pattern')
      && !/\b(?:passed|all clear|no problems|safe|verified)\b/i.test(pcStatusLine),
      rStatus.out);

    // withLang('en') 對所有 precheckLine 狀態掃一遍
    withLang('en', () => {
      for (const st of [
        { state: 'none' },
        { state: 'no-report', calledAt: T(-120) },
        { state: 'ok', reportedAt: T(-60), calledAt: T(-120), took: { minutes: 1, latest: true }, stale: true },
        { state: 'found', reportedAt: T(-60), calledAt: T(-120), note: 'Found 1\n- [P2] sample', took: { minutes: 2, latest: true }, stale: false },
      ]) {
        const line = precheckLine(st);
        check(`precheckLine(${st.state}, en) 沒有中文與禁詞`,
          !CJK.test(line) && !/\b(?:passed|all clear|no problems|safe|verified)\b/i.test(line), line);
      }
      eq('precheckItems 拆出行數正確', precheckItems({ note: 'Found 1\n- item 1\n- item 2' }).length, 2);
    });
  } finally {
    s.cleanup();
  }
}

process.exit(summary());
