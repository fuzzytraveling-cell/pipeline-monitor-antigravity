#!/usr/bin/env node
/**
 * history.test.mjs —— 舊規格與已知死法即時反查（legacy-spec-lookup）。
 *
 * 釘住會安靜說謊或漏抓的幾件事：
 *   ① [P4] 路徑左右邊界與單層 {a,b} 展開（status.mjs 不誤中 lib/status.mjs、tiers.code 不混入目標檔、未閉合／超限不展開）
 *   ② [P2][P5] 中英資料夾（docs/升級摘要/*.md、docs/done/*.md）兼認與並存去重；缺夾／空夾／無權限讀檔／缺死法清單各自明講
 *   ③ [P8][P9] 竄改檔案 mtime 仍依內文最新合法 YYYY-MM-DD（跳過 code fence）＋相對路徑穩定排序；超過上限必報真實總數
 *   ④ [P2][P6] --round precheck（多份含遺失 ghostSpecs、主資料夾 mainFile、--spec 連結、危險檔優先截前 8 檔）與 --round D（第 1／2 輪）共用清單
 *   ⑤ [P4][P6][P8][P13] --context（零 commit＋無權限家目錄、子目錄相對／根相對、macOS /tmp 符號連結＋新檔、工作區外／.／目錄拒收、--all）與 ZH／EN 零 CJK／禁詞
 */
import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, symlinkSync, chmodSync, utimesSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import {
  expandBraces, expandBraceText, pathRegexFor, latestDateIn, parseFailurePatterns,
  normalizeTargetPath, extractSpecTargetPaths, lookupHistory, formatHistoryLines,
  MAX_BRACE_ITEMS,
} from '../lib/history.mjs';
import { withLang } from '../lib/lang.mjs';
import { safeName } from '../lib/events.mjs';
import { CJK } from './_zhscan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).name;

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const T = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString();
const MIN = 60;
const CAN_CHMOD_TEST = typeof process.getuid === 'function' ? process.getuid() !== 0 : true;

function setupRepo({ tier = { code: ['src/', 'lib/'], danger: ['src/danger.js', 'lib/danger.mjs'] }, files = {} } = {}) {
  const r = makeRepo({
    files: {
      'src/a.js': '1\n',
      'src/danger.js': 'd\n',
      'lib/danger.mjs': 'd\n',
      ...files,
    },
  });
  const root = git(r.dir, 'rev-parse', '--show-toplevel');
  if (tier !== null) {
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'pipeline-stages.json'), JSON.stringify({ tiers: tier }));
    git(root, 'add', '.agents/pipeline-stages.json');
    git(root, 'commit', '-qm', 'add tiers');
  }
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-hist-data-'));
  mkdirSync(join(monitorDir, 'logs'));
  mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-hist-home-'));
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

function runCli(cwd, monitorDir, home, args, { sid = 's1', lang = 'zh', extraEnv = {} } = {}) {
  if (lang === 'en') writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang: 'en' }));
  else if (lang === 'zh') writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang: 'zh' }));
  const { ANTIGRAVITY_CONVERSATION_ID: _drop, ...baseEnv } = process.env;
  const env = {
    ...baseEnv,
    HOME: home,
    AGY_PIPELINE_HOME: monitorDir,
    AGY_PIPELINE_LOG_DIR: join(monitorDir, 'logs'),
    ...(sid ? { ANTIGRAVITY_CONVERSATION_ID: sid } : {}),
    ...extraEnv,
  };
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(ROOT, 'status.mjs'), ...args], { cwd, encoding: 'utf8', env }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/* ════════════ 1. P4 路徑邊界與單層 {a,b} 展開 ════════════ */

section('AC-1: pathRegexFor 路徑邊界與 expandBraces 單層展開（含正反測試，P4）', 'P4');
{
  const reA = pathRegexFor('lib/a.js');
  check('必須命中：反引號包裹的 `lib/a.js`', reA.test('修改 `lib/a.js` 與其他檔'));
  check('必須命中：./lib/a.js 與 ../../lib/a.js', reA.test('./lib/a.js') && reA.test('[a](../../lib/a.js)'));
  check('必須命中：後面緊接中文句號 lib/a.js。', reA.test('改動 lib/a.js。'));
  check('必須命中：單層 {a,b} 展開後字串', reA.test(expandBraceText('觸及 lib/{a,b}.js')));
  check('必須放過：lib/a.json 與 lib/a.js.bak', !reA.test('讀取 lib/a.json') && !reA.test('備份 lib/a.js.bak'));
  check('必須放過：other/lib/a.js 與 mylib/a.js', !reA.test('other/lib/a.js') && !reA.test('mylib/a.js'));

  const reStatus = pathRegexFor('status.mjs');
  check('必須命中：根目錄檔案 status.mjs', reStatus.test('更新 status.mjs 分派'));
  check('必須放過：lib/status.mjs 與 my-status.mjs', !reStatus.test('lib/status.mjs') && !reStatus.test('my-status.mjs'));

  eq('巢狀技能路徑大括號展開', JSON.stringify(expandBraces('skills/{spec,chaos-check}/SKILL.md')), JSON.stringify(['skills/spec/SKILL.md', 'skills/chaos-check/SKILL.md']));
  eq('未閉合大括號不展開', JSON.stringify(expandBraces('lib/{a,b.js')), JSON.stringify(['lib/{a,b.js']));
  eq('巢狀大括號不展開', JSON.stringify(expandBraces('lib/{a,{b,c}}.js')), JSON.stringify(['lib/{a,{b,c}}.js']));
  const tooMany = `lib/{${Array.from({ length: MAX_BRACE_ITEMS + 1 }, (_, i) => `f${i}`).join(',')}}.js`;
  eq(`超過 ${MAX_BRACE_ITEMS} 項不展開`, JSON.stringify(expandBraces(tooMany)), JSON.stringify([tooMany]));
}

/* ════════════ 2. 中英資料夾、並存去重、來源異常與 FAILURE-PATTERNS 解析 ════════════ */

section('AC-1/AC-2: 中英已完成規格資料夾、並存去重、缺夾/空夾/無權限與死法清單狀態（P2/P5）', 'P2');
{
  const s = setupRepo({
    files: {
      'status.mjs': '1\n',
      'docs/升級摘要/zh-spec.md': '# 中文舊規格\n\n> 2026-10-01\n修改 `status.mjs` 與 `skills/{spec,chaos-check}/SKILL.md`\n',
      'docs/done/en-spec.md': '# English spec\n\n> 2026-10-05\nTouches `./status.mjs`\n',
      'docs/FAILURE-PATTERNS.md': [
        '# FAILURE-PATTERNS',
        '```markdown',
        '## P99 範例裡不該算進去',
        'status.mjs',
        '```',
        '## P2　同一個事實在兩個地方各算一次',
        '見 `status.mjs` 說明',
        '## custom-pitfall: Custom pitfall heading',
        'See `skills/chaos-check/SKILL.md`',
      ].join('\n'),
    },
  });
  try {
    const res = lookupHistory({ root: s.root, targets: ['status.mjs', 'skills/chaos-check/SKILL.md', 'not-mentioned.mjs'] });
    eq('兼認中英資料夾共 2 份', res.specs.totalDocs, 2);
    eq('status.mjs 命中 2 份規格（EN 較新排前）', JSON.stringify(res.items[0].specs.map((x) => x.rel)), JSON.stringify(['docs/done/en-spec.md', 'docs/升級摘要/zh-spec.md']));
    eq('跳過 code fence 內假 ## P99，status.mjs 僅命中 P2', JSON.stringify(res.items[0].fps.map((x) => x.id)), JSON.stringify(['P2']));
    eq('英文自訂分段標題命中 skills/chaos-check/SKILL.md', JSON.stringify(res.items[1].fps.map((x) => x.id)), JSON.stringify(['custom-pitfall']));
    eq('未點名檔總數為 0', res.items[2].totalSpecs + res.items[2].totalFp, 0);

    const linesZh = withLang('zh', () => formatHistoryLines(res)).join('\n');
    check('ZH 輸出含邊界聲明與未見字面點名', linesZh.includes('僅列字面上點名過該檔路徑的歷史紀錄，沒列到的不代表無關') && linesZh.includes('未見字面點名'), linesZh);

    // 同一檔在 docs/done 與 docs/升級摘要 不互相覆蓋、同一資料夾只讀一次無重複
    const emptyProj = setupRepo();
    try {
      const noDir = lookupHistory({ root: emptyProj.root, targets: ['src/a.js'] });
      eq('缺資料夾狀態為 no-dir', noDir.specs.state, 'no-dir');
      eq('缺死法清單狀態為 missing', noDir.fp.state, 'missing');
      const enNoDir = withLang('en', () => formatHistoryLines(noDir)).join('\n');
      check('EN 缺資料夾提示零中文且不含禁詞（R1/P4）',
        !CJK.test(enNoDir) && enNoDir.includes('completed-specs folder') && !/\b(?:passed|all clear|no problems|safe|verified)\b/i.test(enNoDir), enNoDir);

      mkdirSync(join(emptyProj.root, 'docs', 'done'), { recursive: true });
      writeFileSync(join(emptyProj.root, 'docs', 'FAILURE-PATTERNS.md'), '# Empty FP\nno sections here\n');
      const emptyRes = lookupHistory({ root: emptyProj.root, targets: ['src/a.js'] });
      eq('空資料夾狀態為 empty', emptyRes.specs.state, 'empty');
      eq('無 ## 分段狀態為 no-sections', emptyRes.fp.state, 'no-sections');

      if (CAN_CHMOD_TEST) {
        const lockedSpec = join(emptyProj.root, 'docs', 'done', 'locked.md');
        writeFileSync(lockedSpec, '# Locked\n2026-10-10\nsrc/a.js\n');
        writeFileSync(join(emptyProj.root, 'docs', 'done', 'ok.md'), '# OK\n2026-10-09\nsrc/a.js\n');
        chmodSync(lockedSpec, 0o000);
        chmodSync(join(emptyProj.root, 'docs', 'FAILURE-PATTERNS.md'), 0o000);
        try {
          const permRes = lookupHistory({ root: emptyProj.root, targets: ['src/a.js'] });
          eq('部分讀不到時狀態仍為 ok 且列出不可讀檔案', JSON.stringify(permRes.specs.unreadableFiles), JSON.stringify(['docs/done/locked.md']));
          eq('FAILURE-PATTERNS.md 無權限時為 unreadable', permRes.fp.state, 'unreadable');
          eq('單側失敗時另一側仍正常反查 ok.md', permRes.items[0].totalSpecs, 1);
          const permMsg = withLang('zh', () => formatHistoryLines(permRes)).join('\n');
          check('誠實列出讀不到的舊規格檔名與死法清單狀態', permMsg.includes('docs/done/locked.md') && permMsg.includes('讀不到 docs/FAILURE-PATTERNS.md'), permMsg);
        } finally {
          chmodSync(lockedSpec, 0o644);
          chmodSync(join(emptyProj.root, 'docs', 'FAILURE-PATTERNS.md'), 0o644);
        }
      }
    } finally {
      emptyProj.cleanup();
    }
  } finally {
    s.cleanup();
  }
}

/* ════════════ 3. mtime 竄改仍依內文日期＋檔名穩定排序與報總數 ════════════ */

section('AC-1: 竄改 mtime 仍依內文日期（跳過 code fence）＋相對路徑穩定排序並報總數（P8/P9）', 'P9');
{
  const s = setupRepo({
    files: {
      'docs/升級摘要/b-same-day.md': '# B\n2026-11-10\nsrc/a.js\n',
      'docs/升級摘要/a-same-day.md': '# A\n2026-11-10\nsrc/a.js\n',
      'docs/升級摘要/old-but-touched.md': '# Old\n2026-11-01\n```md\n2099-12-31\n```\nsrc/a.js\n',
      'docs/升級摘要/newest.md': '# Newest\n2026-11-20\n2026-02-31\nsrc/a.js\n',
      'docs/升級摘要/no-date.md': '# NoDate\nsrc/a.js\n',
    },
  });
  try {
    eq('latestDateIn 跳過 code fence 與無效 2026-02-31', latestDateIn('```md\n2099-12-31\n```\n2026-02-31\n2026-11-20\n'), '2026-11-20');
    const oldFile = join(s.root, 'docs/升級摘要/old-but-touched.md');
    const newFile = join(s.root, 'docs/升級摘要/newest.md');
    const future = new Date(Date.now() + 3600_000);
    const past = new Date(Date.now() - 3600_000);
    utimesSync(oldFile, future, future);
    utimesSync(newFile, past, past);

    const res = lookupHistory({ root: s.root, targets: ['src/a.js'], specLimit: 3 });
    eq('共命中 5 份且僅顯示前 3 份', [res.items[0].totalSpecs, res.items[0].specs.length].join('/'), '5/3');
    eq('排序：最新日期 → 同日字碼 a 先於 b（無視 mtime 與無日期排後）',
      JSON.stringify(res.items[0].specs.map((x) => x.rel)),
      JSON.stringify(['docs/升級摘要/newest.md', 'docs/升級摘要/a-same-day.md', 'docs/升級摘要/b-same-day.md']));
    const line = withLang('zh', () => formatHistoryLines(res)).join('\n');
    check('超限必報總數 5 份與列最近 3 份', line.includes('共 5 份，列最近 3 份'), line);
  } finally {
    s.cleanup();
  }
}

/* ════════════ 4. extractSpecTargetPaths 合併抽取、展開與防護 ════════════ */

section('AC-3: extractSpecTargetPaths 合併抽取分級與技術行、展開 {a,b} 並過濾 tiers.code（P4）', 'P4');
{
  const s = setupRepo({ files: { 'status.mjs': '1\n', 'lib/a.mjs': '1\n' } });
  try {
    const spec = [
      '# 功能：測試',
      '',
      '分級：預測至少 **T2**（碰到 `plugin.json`、落在 `tiers.code`、見 `docs/升級摘要/old.md`）',
      '',
      '```markdown',
      '分級：預測至少 T2（碰到 `fake/in-fence.mjs`）',
      '> **技術**：`fake/tech-fence.mjs`',
      '```',
      '',
      '**AC-1　第一條**',
      '> **技術**：修改 `lib/{a,b}.mjs` 與 `status.mjs`，參考 https://example.com/path/to/x.js',
      '',
      '## 明確不做',
      '> **技術**：`never/touch-this.mjs`',
    ].join('\n');
    const extracted = extractSpecTargetPaths(spec, { root: s.root, excludePaths: ['docs/規劃中/self.md'] });
    eq('同時抽出分級行與技術行、展開 {a,b}、保留實存 status.mjs、跳過 fence/明確不做/tiers.code/URL/舊規格',
      JSON.stringify(extracted), JSON.stringify(['lib/a.mjs', 'lib/b.mjs', 'status.mjs']));
  } finally {
    s.cleanup();
  }
}

/* ════════════ 5. --round precheck 與 --round D 整合 ════════════ */

section('AC-3: --round precheck（多份含 ghostSpecs、主資料夾 mainFile、--spec 連結、>8 檔危險優先）與 --round D', 'P6');
{
  const s = setupRepo({
    files: {
      'status.mjs': '1\n',
      'lib/f1.mjs': '1\n', 'lib/f2.mjs': '1\n', 'lib/f3.mjs': '1\n', 'lib/f4.mjs': '1\n',
      'lib/f5.mjs': '1\n', 'lib/f6.mjs': '1\n', 'lib/f7.mjs': '1\n', 'lib/f8.mjs': '1\n',
      'docs/升級摘要/old-danger.md': '# Old danger\n2026-11-15\n改 `lib/danger.mjs`\n',
      'docs/FAILURE-PATTERNS.md': '## P1　git 缺漏\n`lib/danger.mjs` 注意\n',
    },
  });
  try {
    const bigSpec = [
      '# 功能：多檔預審',
      '分級：預測至少 **T2**（碰到 `lib/f1.mjs`、`lib/f2.mjs`、`lib/f3.mjs`、`lib/f4.mjs`、`lib/f5.mjs`、`lib/f6.mjs`、`lib/f7.mjs`、`lib/f8.mjs`）',
      '**AC-1　第一條**',
      '> **技術**：同步改 `lib/danger.mjs`',
    ].join('\n');
    mkdirSync(join(s.root, 'docs/規劃中'), { recursive: true });
    writeFileSync(join(s.root, 'docs/規劃中/part1.md'), bigSpec);

    const ev = (o) => JSON.stringify({ session: 's1', cwd: s.root, ...o });
    writeFileSync(s.log, [
      ev({ ts: T(-30 * MIN), hook: 'UserPrompt', prompt: '寫兩份規格' }),
      ev({ ts: T(-29 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/spec/SKILL.md'), skill: `${PLUGIN}:spec` }),
      ev({ ts: T(-28 * MIN), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/part1.md、docs/規劃中/ghost.md', source: 'ai', by_session: 's1' }),
    ].join('\n') + '\n');

    const pre = runCli(s.root, s.monitorDir, s.home, ['--round', 'precheck']);
    eq('--round precheck 離開碼 0', pre.code, 0);
    check('超過 8 檔時危險清單 lib/danger.mjs 優先列前且明報另有 1 個檔未展開',
      pre.out.includes('▸ lib/danger.mjs（危險清單）') && pre.out.includes('另有 1 個檔未展開反查'), pre.out);
    check('遺失的 ghost.md 附註未納入自動反查（P5/R1）',
      pre.out.includes('另有 1 份規格讀不到，未納入自動反查：ghost'), pre.out);
    check('列出命中 old-danger.md 與 P1', pre.out.includes('docs/升級摘要/old-danger.md') && pre.out.includes('P1'), pre.out);

    // 英文模式下零 CJK（排除規格檔案中的中文路徑與專案自訂的死法標題原文）
    const preEn = runCli(s.root, s.monitorDir, s.home, ['--round', 'precheck'], { lang: 'en' });
    const stripData = (t) => t.replace(/docs\/(?:規劃中|進行中|升級摘要)\/[^\s）),]+/g, 'docs/spec.md').replace(/git 缺漏/g, 'git missing');
    check('--round precheck（en）零中文殘留且無禁詞',
      !CJK.test(stripData(preEn.out)) && !/\b(?:passed|all clear|no problems|safe|verified)\b/i.test(preEn.out), preEn.out);

    // worktree 下規格只在主資料夾 + --spec 連結情境（mainFile）
    const wt = mkdtempSync(join(tmpdir(), 'pm-hist-wt-'));
    git(s.root, 'worktree', 'add', '-q', '-b', 'wt_branch', wt);
    try {
      const wtRoot = git(wt, 'rev-parse', '--show-toplevel');
      writeFileSync(join(s.root, 'docs/規劃中/main-only.md'), '# Main only\n分級：預測至少 **T2**\n> **技術**：`lib/danger.mjs`\n');
      writeFileSync(s.log, [
        JSON.stringify({ session: 's2', cwd: wtRoot, ts: T(-10 * MIN), hook: 'UserPrompt', prompt: '照主資料夾規格施工' }),
        JSON.stringify({ session: 's2', cwd: wtRoot, ts: T(-9 * MIN), event: 'spec_link', spec: 'docs/規劃中/main-only.md', by_session: 's2', source: 'ai' }),
      ].join('\n') + '\n');
      const wtPre = runCli(wtRoot, s.monitorDir, s.home, ['--round', 'precheck'], { sid: 's2', lang: 'zh' });
      check('worktree --spec 連結只在主資料夾的規格也能透過 mainFile 抽出並反查',
        wtPre.out.includes('▸ lib/danger.mjs（危險清單）') && wtPre.out.includes('docs/升級摘要/old-danger.md'), wtPre.out);
    } finally {
      try { git(s.root, 'worktree', 'remove', '--force', wt); } catch { rmSync(wt, { recursive: true, force: true }); }
    }

    // --round D 第 1 輪與第 2 輪
    writeFileSync(join(s.root, 'lib/danger.mjs'), 'edited 1\n');
    writeFileSync(join(s.root, 'src/a.js'), 'edited 1\n');
    writeFileSync(s.log, [
      ev({ ts: T(-20 * MIN), hook: 'UserPrompt', prompt: '修一下' }),
      ev({ ts: T(-19 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'lib/danger.mjs') }),
      ev({ ts: T(-18 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') }),
    ].join('\n') + '\n');
    const rd1 = runCli(s.root, s.monitorDir, s.home, ['--round', 'D']);
    check('--round D 第 1 輪附上歷史反查', rd1.out.includes('▸ lib/danger.mjs（危險清單）') && rd1.out.includes('docs/升級摘要/old-danger.md'), rd1.out);

    const head = git(s.root, 'rev-parse', '--short', 'HEAD');
    writeFileSync(s.log, [
      ev({ ts: T(-20 * MIN), hook: 'UserPrompt', prompt: '修一下' }),
      ev({ ts: T(-19 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'lib/danger.mjs') }),
      ev({ ts: T(-18 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/chaos-check/SKILL.md'), skill: `${PLUGIN}:chaos-check`, head }),
      ev({ ts: T(-17 * MIN), event: 'stage_report', stage: 'D', verdict: 'found', note: '找到 1 條', source: 'ai', by_session: 's1' }),
      ev({ ts: T(-5 * MIN), hook: 'UserPrompt', prompt: '修 src/a.js' }),
      ev({ ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') }),
    ].join('\n') + '\n');
    utimesSync(join(s.root, 'src/a.js'), new Date(Date.now() - 4 * MIN * 1000), new Date(Date.now() - 4 * MIN * 1000));
    utimesSync(join(s.root, 'lib/danger.mjs'), new Date(Date.now() - 19 * MIN * 1000), new Date(Date.now() - 19 * MIN * 1000));

    const rd2 = runCli(s.root, s.monitorDir, s.home, ['--round', 'D']);
    check('--round D 第 2 輪只反查第一輪之後改的 src/a.js', rd2.out.includes('▸ src/a.js') && !rd2.out.includes('▸ lib/danger.mjs'), rd2.out);

    // 第 2 輪紀錄缺 head 時退回整批並附註
    writeFileSync(s.log, [
      ev({ ts: T(-20 * MIN), hook: 'UserPrompt', prompt: '修一下' }),
      ev({ ts: T(-18 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.home, '.gemini/config/plugins', PLUGIN, 'skills/chaos-check/SKILL.md'), skill: `${PLUGIN}:chaos-check` }),
      ev({ ts: T(-17 * MIN), event: 'stage_report', stage: 'D', verdict: 'found', note: '找到 1 條', source: 'ai', by_session: 's1' }),
    ].join('\n') + '\n');
    const rd2Fallback = runCli(s.root, s.monitorDir, s.home, ['--round', 'D']);
    check('--round D 第 2 輪拿不到清單時依整批反查並明講',
      rd2Fallback.out.includes('改依這一輪整批要看的檔反查') && rd2Fallback.out.includes('▸ lib/danger.mjs'), rd2Fallback.out);
  } finally {
    s.cleanup();
  }
}

/* ════════════ 6. --context 唯讀指令與路徑邊界（P6/P8/P13） ════════════ */

section('AC-4: --context 零 commit／無權限家目錄、子目錄、/tmp 新檔、無效路徑拒收與 --all（P6/P8/P13）', 'P13');
{
  const bare = mkdtempSync(join(tmpdir(), 'pm-ctx-bare-'));
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-ctx-data-'));
  const home = mkdtempSync(join(tmpdir(), 'pm-ctx-home-'));
  try {
    git(bare, 'init', '-q');
    mkdirSync(join(bare, 'lib'), { recursive: true });
    mkdirSync(join(bare, 'docs/升級摘要'), { recursive: true });
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(bare, `docs/升級摘要/spec-${i}.md`), `# Spec ${i}\n2026-11-0${i}\n改 \`lib/mod.mjs\` 與 \`lib/planned-new.mjs\`\n`);
    }
    writeFileSync(join(bare, 'lib/mod.mjs'), '1\n');
    writeFileSync(join(bare, 'docs/FAILURE-PATTERNS.md'), '## P13　git 路徑\n`lib/mod.mjs` 出事\n');

    // 即使 AGY_PIPELINE_HOME 不可存取、且零 commit，--context 仍可執行（證明在 loadEvents 之前分派，P6/P3）
    const lockedHome = mkdtempSync(join(tmpdir(), 'pm-ctx-locked-'));
    if (CAN_CHMOD_TEST) chmodSync(lockedHome, 0o000);
    try {
      const bareRes = runCli(bare, monitorDir, home, ['--context', 'lib/mod.mjs'], {
        sid: null, lang: null, extraEnv: { AGY_PIPELINE_HOME: lockedHome, AGY_PIPELINE_LOG_DIR: join(lockedHome, 'logs') },
      });
      eq('零 commit＋無權限家目錄執行 --context 離開碼 0', bareRes.code, 0);
      check('預設列最近 5 份並報共 6 份', bareRes.out.includes('共 6 份，列最近 5 份') && bareRes.out.includes('P13'), bareRes.out);
    } finally {
      if (CAN_CHMOD_TEST) chmodSync(lockedHome, 0o755);
      rmSync(lockedHome, { recursive: true, force: true });
    }

    const allRes = runCli(bare, monitorDir, home, ['--context', 'lib/mod.mjs', '--all']);
    eq('--all 離開碼 0', allRes.code, 0);
    check('--all 展開全部 6 份', allRes.out.includes('spec-1.md') && allRes.out.includes('（共 6 份）'), allRes.out);

    // 子目錄執行：相對於子目錄、相對於工作區根目錄、與未建新檔的 /tmp 符號連結皆可歸一（P8/P13）
    const sub = join(bare, 'lib');
    const tmpUnresolvedNew = join(bare, 'lib/planned-new.mjs'); // 在 macOS 上為 /var/folders/... 或 /tmp/...
    const subRes = runCli(sub, monitorDir, home, ['--context', 'mod.mjs', 'lib/planned-new.mjs', tmpUnresolvedNew]);
    eq('子目錄執行 --context 離開碼 0', subRes.code, 0);
    check('子目錄相對路徑、根相對路徑與尚未建立的新檔皆能正確歸一並反查',
      subRes.out.includes('▸ lib/mod.mjs') && subRes.out.includes('▸ lib/planned-new.mjs'), subRes.out);

    // 模擬 /tmp/...（若 tmpdir 與 realpath 不同，測 symlink 路徑）
    const normNew = normalizeTargetPath(join(bare, 'lib/planned-new.mjs'), { root: git(bare, 'rev-parse', '--show-toplevel'), cwd: sub });
    eq('realOf 上溯父目錄：尚未建立的新檔正確歸一', normNew.rel, 'lib/planned-new.mjs');

    // 錯誤與拒收情境
    const missArg = runCli(bare, monitorDir, home, ['--context']);
    eq('缺參數回傳 1', missArg.code, 1);
    const badFlag = runCli(bare, monitorDir, home, ['--context', 'lib/mod.mjs', '--bogus']);
    eq('未知旗標回傳 1', badFlag.code, 1);
    const badOnly = runCli(bare, monitorDir, home, ['--context', '../outside.mjs', '.', 'lib/']);
    eq('全部為工作區外／根目錄／目錄時回傳 1', badOnly.code, 1);
    check('各自印出白話拒絕原因（R1/P4）',
      badOnly.out.includes('不在這個專案工作區內') && badOnly.out.includes('工作區根目錄本身') && badOnly.out.includes('資料夾'), badOnly.out);

    const mixedEn = runCli(bare, monitorDir, home, ['--context', '../outside.mjs', 'lib/mod.mjs'], { lang: 'en' });
    eq('混合有效與無效路徑仍回傳 0 並警告跳過', mixedEn.code, 0);
    const stripData = (t) => t.replace(/docs\/(?:規劃中|進行中|升級摘要)\/[^\s）),]+/g, 'docs/spec.md').replace(/git 路徑/g, 'git path');
    check('EN --context 零中文殘留且無禁詞',
      !CJK.test(stripData(mixedEn.out)) && mixedEn.out.includes('outside this project workspace') && !/\b(?:passed|all clear|no problems|safe|verified)\b/i.test(mixedEn.out), mixedEn.out);
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(monitorDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

process.exit(summary());
