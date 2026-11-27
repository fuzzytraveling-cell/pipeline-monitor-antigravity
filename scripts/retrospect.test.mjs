#!/usr/bin/env node
/**
 * retrospect.test.mjs —— 工地復盤官技能與近期卡關純事實盤點（retrospect-skill）。
 *
 * 釘住會安靜說謊或漏抓的幾件事：
 *   ① [P4] 整包 argv 檢查與早退分派，誤混寫檔旗標（--off／--lang／位置參數）一律回 1 且絕不寫檔
 *   ② [P8][P9] 中英已完成規格並存去重、竄改 mtime 仍依內文合法 YYYY-MM-DD 排序、缺夾／空夾／無權限、死法與教訓檔
 *   ③ [P3][R1] 分級四態、missingDanger 消失路徑、guard_asked 支援 dangerRuleFor 資料夾規則與分級非 ok 狀態
 *   ④ [P11] 獨立 worktree 落後 main 時標明身分並對照主資料夾已完成規格／死法／教訓／危險清單差異
 *   ⑤ [P5][R1] no-file／no-events 不印 0 次；noRecordsWithin 與結構化事件並存兩者照報；揭露壞行／已恢復故障／無心跳／退出記錄
 *   ⑥ [P6] 四類結構化事件純統計、noteFile 展開與遺失、單行截短不含「尚有 0 行」、壞關卡設定與歷史關卡代號
 *   ⑦ [P13] 零 commit 新專案、子目錄執行與非 git 目錄處理
 *   ⑧ [P2] 非關卡技能隔離：同回合讀技能檔不改五關／起點／門禁，新回合純問答 /retrospect 依約放行且不洗掉待補關卡
 *   ⑨ [P10] ZH／EN 雙語實跑零 CJK／全形空白殘留且不含紅線禁語
 */
import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, appendFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync,
  symlinkSync, chmodSync, utimesSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import {
  parseRetrospectArgs, collectRetrospectFacts, formatRetrospectLines,
  DEFAULT_RETROSPECT_SPEC_LIMIT, DEFAULT_RETROSPECT_GUARD_LIMIT,
} from '../lib/retrospect.mjs';
import { collectAll } from '../lib/collect.mjs';
import { decide } from '../gate.mjs';
import { safeName } from '../lib/events.mjs';
import { withLang } from '../lib/lang.mjs';
import { SENSOR_FILE, GATE_FILE, GUARD_FILE } from '../lib/faults.mjs';
import { CJK } from './_zhscan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).name;
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const T = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString();
const MIN = 60;
const DAY = 86400;
const CAN_CHMOD_TEST = typeof process.getuid === 'function' ? process.getuid() !== 0 : true;

function setupRepo({
  tier = { code: ['src/', 'lib/'], danger: ['src/danger.js', 'db/'] },
  files = {},
  commit = true,
} = {}) {
  const r = makeRepo({
    files: {
      'src/a.js': '1\n',
      'src/danger.js': 'd\n',
      'db/users.sql': 'select 1;\n',
      ...files,
    },
    commit,
  });
  const root = git(r.dir, 'rev-parse', '--show-toplevel');
  if (tier !== null) {
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'pipeline-stages.json'), JSON.stringify({ tiers: tier }, null, 2));
    if (commit) {
      git(root, 'add', '.agents/pipeline-stages.json');
      git(root, 'commit', '-qm', 'add tiers');
    }
  }
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-retro-data-'));
  mkdirSync(join(monitorDir, 'logs', 'reports'), { recursive: true });
  mkdirSync(join(monitorDir, 'checkpoints'), { recursive: true });
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-retro-home-'));
  mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(ROOT, join(home, '.gemini', 'config', 'plugins', PLUGIN));
  const log = join(monitorDir, 'logs', `${safeName(basename(root))}.jsonl`);
  return {
    r,
    root,
    monitorDir,
    home,
    log,
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

/* ════════════ 1. 整包 argv 與早退攔截寫檔旗標 ════════════ */

section('AC-2: parseRetrospectArgs 與 status.mjs 早退分派——誤混寫檔旗標或位置參數一律回 1 且絕不寫檔（P4）', 'P4');
{
  eq('合法：只帶 --retrospect', parseRetrospectArgs(['--retrospect']).ok, true);
  eq('合法：帶 --retrospect --all（順序不拘）', parseRetrospectArgs(['--all', '--retrospect']).ok, true);
  eq('必抓：多帶位置參數', parseRetrospectArgs(['--retrospect', 'foo']).ok, false);
  eq('必抓：前面出現位置參數', parseRetrospectArgs(['foo', '--retrospect']).ok, false);
  eq('必抓：混帶 --off', parseRetrospectArgs(['--retrospect', '--off']).ok, false);

  const s = setupRepo();
  const rOff = runCli(s.root, s.monitorDir, s.home, ['--retrospect', '--off']);
  eq('--retrospect --off 回傳 1', rOff.code, 1);
  check('--off 未寫入退出記號檔', !existsSync(join(s.root, '.agents', 'pipeline-monitor.off')));

  const rLang = runCli(s.root, s.monitorDir, s.home, ['--lang', 'en', '--retrospect'], { lang: 'zh' });
  eq('--lang en --retrospect 回傳 1', rLang.code, 1);
  eq('lang.json 未被偷改成 en', JSON.parse(readFileSync(join(s.monitorDir, 'lang.json'), 'utf8')).lang, 'zh');

  const rPos = runCli(s.root, s.monitorDir, s.home, ['extra', '--retrospect']);
  eq('位置參數排在 --retrospect 前一樣回傳 1', rPos.code, 1);
  check('錯誤訊息帶用法說明', rPos.out.includes('agy-pipeline --retrospect [--all]'), rPos.out);
  s.cleanup();
}

/* ════════════ 2. 中英已完成規格、竄改 mtime、缺夾／無權限、死法與教訓檔 ════════════ */

section('AC-2: 中英已完成規格並存去重、竄改 mtime 穩定排序、缺夾／空夾／無權限、死法與教訓檔（P8/P9）', 'P8');
{
  const s = setupRepo();
  mkdirSync(join(s.root, 'docs', '升級摘要'), { recursive: true });
  mkdirSync(join(s.root, 'docs', 'done'), { recursive: true });
  // 製造 12 份已完成規格（故意把舊日期檔案的 mtime 改成未來時間）
  for (let i = 1; i <= 11; i++) {
    const day = String(i).padStart(2, '0');
    const rel = i <= 6 ? join(s.root, 'docs', '升級摘要', `spec-${day}.md`) : join(s.root, 'docs', 'done', `spec-${day}.md`);
    writeFileSync(rel, `# Spec ${day}\n\n\`\`\`md\n2099-12-31 fake inside code fence\n\`\`\`\n\n- 2026-10-${day} 完成\n`);
    const fakeFuture = new Date(Date.now() + (20 - i) * DAY * 1000);
    utimesSync(rel, fakeFuture, fakeFuture);
  }
  // 跨資料夾同名與無日期規格
  writeFileSync(join(s.root, 'docs', '升級摘要', 'nodate.md'), '# No date spec\n');
  writeFileSync(join(s.root, 'docs', 'FAILURE-PATTERNS.md'), '# FP\n\n## P1　第一條\n\n## P2　第二條\n');
  mkdirSync(join(s.root, 'docs', 'references'), { recursive: true });
  writeFileSync(join(s.root, 'docs', 'references', 'LESSONS.md'), '# Lessons\n\n## L1　第一課\n\n## L2　第二課\n');

  const rDefault = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  eq('有文件可讀時回傳 0', rDefault.code, 0);
  check('依內文日期降冪排在最前的是 spec-11，無視 code fence 2099-12-31 與假未來 mtime',
    rDefault.out.indexOf('docs/done/spec-11.md (2026-10-11)') !== -1
    && rDefault.out.indexOf('docs/done/spec-11.md (2026-10-11)') < rDefault.out.indexOf('docs/done/spec-10.md (2026-10-10)'));
  check(`超過 ${DEFAULT_RETROSPECT_SPEC_LIMIT} 份時明報真實總數 12 份並截短（不印 nodate）`,
    rDefault.out.includes('共 12 份，列最近 10 份') && !rDefault.out.includes('nodate.md'));

  const rAll = runCli(s.root, s.monitorDir, s.home, ['--retrospect', '--all']);
  check('--all 展開全部 12 份含無日期規格', rAll.out.includes('docs/升級摘要/nodate.md（內文無日期）'));
  check('讀得到 FAILURE-PATTERNS.md 與相容路徑 docs/references/LESSONS.md',
    rDefault.out.includes('共 2 條（P1、P2）') && rDefault.out.includes('教訓紀錄（docs/references/LESSONS.md）：可讀（共 2 個 ## 段落）'));

  if (CAN_CHMOD_TEST) {
    const secret = join(s.root, 'docs', 'done', 'secret.md');
    writeFileSync(secret, '# Secret\n2026-11-01\n');
    chmodSync(secret, 0o000);
    const rUnreadable = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
    chmodSync(secret, 0o644);
    eq('個別規格檔無權限讀時照常回傳 0', rUnreadable.code, 0);
    check('無權限規格檔明講讀不到（未列入）', rUnreadable.out.includes('1 份規格檔讀不到（未列入）：docs/done/secret.md'), rUnreadable.out);
  }
  s.cleanup();

  // 空專案（缺 docs 資料夾、缺死法、缺教訓）
  const emptyRepo = setupRepo({ tier: null });
  const rEmpty = runCli(emptyRepo.root, emptyRepo.monitorDir, emptyRepo.home, ['--retrospect']);
  eq('缺 docs 文件仍正常回傳 0', rEmpty.code, 0);
  check('找不到已完成規格、死法清單與教訓檔各自明講',
    rEmpty.out.includes('找不到已完成規格資料夾')
    && rEmpty.out.includes('已知死法清單（docs/FAILURE-PATTERNS.md）：找不到')
    && rEmpty.out.includes('教訓紀錄（docs/LESSONS.md）：找不到'));
  emptyRepo.cleanup();
}

/* ════════════ 3. 分級四態、missingDanger 與 guard_asked 資料夾規則 ════════════ */

section('AC-2: 分級四態（unset/off/broken/ok+missingDanger）與 guard_asked 的 dangerRuleFor 資料夾規則（P3/R1）', 'P3');
{
  const s = setupRepo({ tier: { code: ['src/'], danger: ['db/', 'ghost/gone.js'] } });
  writeFileSync(s.log, [
    { ts: T(-2 * MIN), event: 'guard_asked', kind: 'danger', file: 'db/users.sql', rule: 'db/', cwd: s.root, session: 's1' },
    { ts: T(-1 * MIN), event: 'guard_asked', kind: 'danger', file: 'src/old.js', rule: 'src/old.js', cwd: s.root, session: 's1' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');

  const rOk = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('ok 分級印出 missingDanger 已不存在條目 ghost/gone.js', rOk.out.includes('ghost/gone.js') && rOk.out.includes('已經不存在'));
  check('db/users.sql 依 dangerRuleFor 命中資料夾規則 db/ 判為仍在危險清單',
    rOk.out.includes('db/users.sql × 1（仍在危險清單，規則：db/）'), rOk.out);
  check('已不在清單的 src/old.js 判為目前已不在危險清單',
    rOk.out.includes('src/old.js × 1（目前已不在危險清單）'), rOk.out);

  // 分級設定損壞（broken）→ 不可把 guard_asked 誤報成「目前已不在危險清單」
  writeFileSync(join(s.root, '.agents', 'pipeline-stages.json'), '{broken');
  const rBroken = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('分級 broken 照實明講讀不懂，不折成 T0 也不把 db/users.sql 寫成不在危險清單',
    rBroken.out.includes('設定檔讀不懂') && rBroken.out.includes('無法確認目前清單') && !rBroken.out.includes('目前已不在危險清單'));

  // 分級關閉（off）
  writeFileSync(join(s.root, '.agents', 'pipeline-stages.json'), JSON.stringify({ tiers: { off: true, why: '純文件練習' } }));
  const rOff = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('分級 off 照實呈現理由且 guard_asked 標為目前設為不分級',
    rOff.out.includes('設定成不分級（理由：純文件練習）') && rOff.out.includes('目前設為不分級'));

  // 分級未設定（unset）與空危險清單
  writeFileSync(join(s.root, '.agents', 'pipeline-stages.json'), JSON.stringify({}));
  const rUnset = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('分級 unset 照實明講還沒設定分級、絕不寫 T0，guard_asked 標為目前未設定分級',
    rUnset.out.includes('還沒設定分級') && !rUnset.out.includes('T0') && rUnset.out.includes('目前未設定分級'));

  writeFileSync(join(s.root, '.agents', 'pipeline-stages.json'), JSON.stringify({ tiers: { code: ['src/'], danger: [] } }));
  const rEmptyDanger = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('危險清單為空時明講「永遠不會出現第三級」', rEmptyDanger.out.includes('永遠不會出現第三級'));
  s.cleanup();
}

/* ════════════ 4. 獨立 worktree 落後 main 差異對照 ════════════ */

section('AC-2/AC-3: 獨立 worktree 落後 main 時標明身分並對照主資料夾差異與跨 worktree 事件（P11）', 'P11');
{
  const s = setupRepo({ tier: { code: ['src/'], danger: ['src/danger.js'] } });
  const wtDir = mkdtempSync(join(tmpdir(), 'pm-retro-wt-'));
  rmSync(wtDir, { recursive: true, force: true });
  git(s.root, 'worktree', 'add', '-q', '-b', 'wt-retro', wtDir);

  // mainRoot 新增已結案規格、老毛病 P99、LESSONS 段落與新的 danger 規則
  mkdirSync(join(s.root, 'docs', '升級摘要'), { recursive: true });
  writeFileSync(join(s.root, 'docs', '升級摘要', 'main-only.md'), '# Main Only\n2026-11-27\n');
  writeFileSync(join(s.root, 'docs', 'FAILURE-PATTERNS.md'), '# FP\n\n## P1　第一條\n\n## P99　主線新防線\n');
  writeFileSync(join(s.root, 'docs', 'LESSONS.md'), '# L\n\n## L1\n\n## L2\n');
  writeFileSync(join(s.root, '.agents', 'pipeline-stages.json'), JSON.stringify({ tiers: { code: ['src/'], danger: ['src/danger.js', 'src/a.js'] } }));
  mkdirSync(join(wtDir, 'docs'), { recursive: true });
  writeFileSync(join(wtDir, 'docs', 'FAILURE-PATTERNS.md'), '# FP\n\n## P1　第一條\n');
  writeFileSync(join(wtDir, 'docs', 'LESSONS.md'), '# L\n\n## L1\n');
  writeFileSync(s.log, `${JSON.stringify({ ts: T(-3 * MIN), event: 'guard_asked', kind: 'danger', file: 'src/a.js', rule: 'src/a.js', cwd: s.root, session: 's-main' })}\n`);

  const rWt = runCli(wtDir, s.monitorDir, s.home, ['--retrospect']);
  eq('獨立 worktree 執行回傳 0', rWt.code, 0);
  check('明標目前位於獨立 worktree 與主資料夾位置', rWt.out.includes('目前位於獨立 worktree') && rWt.out.includes(basename(s.root)));
  check('列出主資料夾尚未同步的規格、死法 P99、教訓段落數與 danger 項目 src/a.js',
    rWt.out.includes('main-only (2026-11-27)')
    && rWt.out.includes('P99 主線新防線')
    && rWt.out.includes('另有 1 個段落尚未同步到此 worktree')
    && rWt.out.includes('尚未同步到此 worktree：src/a.js'));
  check('跨 worktree 共用的 guard_asked(src/a.js) 標明主資料夾已在危險清單',
    rWt.out.includes('主資料夾已在危險清單'), rWt.out);

  // D-1 回歸 #3a：兩邊段落數相同（皆 2 段）但標題不同，仍抓得到 main 多出的段落
  writeFileSync(join(wtDir, 'docs', 'LESSONS.md'), '# L\n\n## L1\n\n## L3-wt-only\n');
  const rSameCount = runCli(wtDir, s.monitorDir, s.home, ['--retrospect']);
  check('worktree 與 main 同段落數但不同標題時，仍報出 main 另有 1 個段落未同步',
    rSameCount.out.includes('教訓紀錄另有 1 個段落尚未同步到此 worktree'), rSameCount.out);

  // D-1 回歸 #3b 與 D-2 回歸 #1：worktree 側 LESSONS.md、FAILURE-PATTERNS.md 與已完成規格資料夾／檔案無權限讀時不造假差數
  if (CAN_CHMOD_TEST) {
    chmodSync(join(wtDir, 'docs', 'LESSONS.md'), 0o000);
    const rUnreadableLesson = runCli(wtDir, s.monitorDir, s.home, ['--retrospect']);
    chmodSync(join(wtDir, 'docs', 'LESSONS.md'), 0o644);
    check('worktree LESSONS.md 無權限讀時明講無法比對，不編造差數',
      rUnreadableLesson.out.includes('無法比對兩邊段落差異') && !rUnreadableLesson.out.includes('另有 2 個段落'), rUnreadableLesson.out);

    chmodSync(join(wtDir, 'docs', 'FAILURE-PATTERNS.md'), 0o000);
    const rUnreadableFp = runCli(wtDir, s.monitorDir, s.home, ['--retrospect']);
    chmodSync(join(wtDir, 'docs', 'FAILURE-PATTERNS.md'), 0o644);
    check('worktree FAILURE-PATTERNS.md 無權限讀時明講無法比對，不把主資料夾全部條目講成尚未同步',
      rUnreadableFp.out.includes('無法比對兩邊條目差異') && !rUnreadableFp.out.includes('FAILURE-PATTERNS.md 另有'), rUnreadableFp.out);

    const wtSpecsDir = join(wtDir, 'docs', '升級摘要');
    mkdirSync(wtSpecsDir, { recursive: true });
    writeFileSync(join(wtSpecsDir, 'main-only.md'), '# Main Only\n2026-11-27\n');
    writeFileSync(join(wtSpecsDir, 'ok-wt.md'), '# Ok Wt\n2026-11-26\n');
    chmodSync(wtSpecsDir, 0o000);
    const rUnreadableSpecsDir = runCli(wtDir, s.monitorDir, s.home, ['--retrospect']);
    chmodSync(wtSpecsDir, 0o755);
    check('worktree 已完成規格資料夾無權限讀時明講無法比對，不把主資料夾規格誤報為尚未同步',
      rUnreadableSpecsDir.out.includes('無法比對兩邊規格差異') && !rUnreadableSpecsDir.out.includes('主資料夾另有'), rUnreadableSpecsDir.out);

    chmodSync(join(wtSpecsDir, 'main-only.md'), 0o000);
    const rPartialSpecs = runCli(wtDir, s.monitorDir, s.home, ['--retrospect']);
    chmodSync(join(wtSpecsDir, 'main-only.md'), 0o644);
    check('worktree 單一規格檔無權限讀時明講差異比對可能不完整，且不把該檔誤報為尚未同步',
      rPartialSpecs.out.includes('兩邊差異比對可能不完整') && !rPartialSpecs.out.includes('主資料夾另有'), rPartialSpecs.out);
  }

  // D-1 回歸 #4：worktree 分級設定 broken 時不把 main 整份危險清單誤報為尚未同步
  writeFileSync(join(wtDir, '.agents', 'pipeline-stages.json'), '{broken');
  const rBrokenTierWt = runCli(wtDir, s.monitorDir, s.home, ['--retrospect']);
  check('worktree 分級 broken 時報狀態不同，不誤印主資料夾整份危險清單尚未同步',
    rBrokenTierWt.out.includes('分級狀態不同') && !rBrokenTierWt.out.includes('主資料夾的危險清單另有'), rBrokenTierWt.out);

  git(s.root, 'worktree', 'remove', '--force', wtDir);
  s.cleanup();
}

/* ════════════ 5. no-file／no-events／noRecordsWithin 並存／故障與無心跳揭露 ════════════ */

section('AC-2: no-file／no-events 不印 0 次；noRecordsWithin 與結構化事件並存；揭露壞行／已恢復故障／無心跳／退出記錄（P5）', 'P5');
{
  // A. no-file
  const s = setupRepo();
  const rNoFile = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('no-file 明講沒有紀錄檔且不印四類 0 次',
    rNoFile.out.includes('這個專案還沒有紀錄檔') && !rNoFile.out.includes('共 0 筆'));

  // B. 全過期 (> 90 天) → readEvents 會掃空成 no-events
  writeFileSync(s.log, `${JSON.stringify({ ts: T(-95 * DAY), hook: 'PostToolUse', tool: 'read_file', cwd: s.root, session: 'old' })}\n`);
  const rExpired = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('全過期後明講近 90 天沒有事件紀錄且不印四類 0 次',
    rExpired.out.includes('近 90 天內沒有任何事件紀錄') && !rExpired.out.includes('共 0 筆'));

  // C. noRecordsWithin === true（零感測器 hook 事件）但仍有 Node 寫入的 stage_report／guard_asked，且含已恢復故障＋壞行＋無 guard 心跳＋退出記錄
  writeFileSync(s.log, [
    { ts: T(-10 * MIN), event: 'stage_report', stage: 'D', verdict: 'found', note: '找到 1 條\n- [P2] 實例', cwd: s.root, by_session: 's1', source: 'ai' },
    { ts: T(-5 * MIN), event: 'guard_asked', kind: 'danger', file: 'src/danger.js', rule: 'src/danger.js', cwd: s.root, session: 's1' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(s.monitorDir, 'logs', SENSOR_FILE), [
    JSON.stringify({ ts: T(-2 * DAY), event: 'gate_broken', why: 'boom', cwd: s.root }),
    'not-json-line',
  ].join('\n') + '\n');
  writeFileSync(join(s.monitorDir, 'logs', GATE_FILE), JSON.stringify({ ts: T(-1 * MIN), cwd: s.root, byCwd: { [s.root]: T(-1 * MIN) } }) + '\n');
  writeFileSync(join(s.root, '.agents', 'pipeline-monitor.off'), '');

  const rCoexist = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('無 hook 但有結構化事件時，同時印出「沒有任何感測器（hook）事件」警告與既有的 stage_report/guard_asked 統計（絕不吞掉事件）',
    rCoexist.out.includes('沒有任何感測器（hook）事件')
    && rCoexist.out.includes('D 魔鬼教官：found 1／ok 0')
    && rCoexist.out.includes('src/danger.js × 1'));
  check('揭露 _sensor.jsonl 壞行、已恢復 gate_broken、改檔把關從未跑過與退出記錄警告',
    rCoexist.out.includes('1 筆看不懂的故障記號')
    && rCoexist.out.includes('收工 hook') && rCoexist.out.includes('沒再記到出錯')
    && rCoexist.out.includes('改檔把關：還沒跑過')
    && rCoexist.out.includes('退出記錄（.agents/pipeline-monitor.off）'));
  s.cleanup();
}

/* ════════════ 6. 四類事件統計、noteFile 展開／遺失、壞關卡設定與歷史關卡 ════════════ */

section('AC-2: 四類事件統計、spec_precheck 與 stage_report 共用 noteFile、無「尚有 0 行」、壞關卡設定與歷史關卡代號（P6）', 'P6');
{
  const s = setupRepo();
  // 壞關卡設定（tiers 有效、stages 是錯的）
  writeFileSync(join(s.root, '.agents', 'pipeline-stages.json'), JSON.stringify({
    stages: 'broken',
    tiers: { code: ['src/'], danger: ['src/danger.js'] },
  }));
  const okNoteFile = join(s.monitorDir, 'logs', 'reports', 'ok-precheck.txt');
  writeFileSync(okNoteFile, '找到 2 條\n- [P2] 第一行細節\n- [P6] 第二行細節\n- [R1] 第三行細節\n- [P4] 第四行不該出現在預設前3行\n');
  const missingPrecheckFile = join(s.monitorDir, 'logs', 'reports', 'gone-precheck.txt');
  const missingStageFile = join(s.monitorDir, 'logs', 'reports', 'gone-stage.txt');
  const longSingle = `找到 1 條：${'X'.repeat(260)}`;

  const evs = [
    { ts: T(-40 * MIN), hook: 'UserPrompt', session: 's1', cwd: s.root, prompt: 'test' },
    { ts: T(-39 * MIN), event: 'spec_precheck', verdict: 'found', specs: ['docs/規劃中/a.md'], note: '找到 2 條', noteFile: okNoteFile, cwd: s.root },
    { ts: T(-38 * MIN), event: 'spec_precheck', verdict: 'found', note: '找到 1 條', noteFile: missingPrecheckFile, cwd: s.root },
    { ts: T(-37 * MIN), event: 'spec_precheck', verdict: 'ok', note: '沒對到已知死法', cwd: s.root },
    { ts: T(-36 * MIN), event: 'spec_precheck', verdict: 'weird', note: '異常狀態', cwd: s.root },
    { ts: T(-35 * MIN), event: 'stage_report', stage: 'D', verdict: 'found', note: longSingle, cwd: s.root },
    { ts: T(-34 * MIN), event: 'stage_report', stage: 'Z', verdict: 'found', note: '歷史關卡問題', noteFile: missingStageFile, cwd: s.root },
    { ts: T(-33 * MIN), event: 'stage_report', stage: 'D', verdict: 'ok', note: 'ok', cwd: s.root },
    { ts: T(-32 * MIN), event: 'gate_blocked', missing: ['D:ask', 'tests'], cwd: s.root, session: 's1' },
    { ts: T(-31 * MIN), event: 'gate_blocked', missing: ['D:ask'], cwd: s.root, session: 's1' },
    { ts: T(-30 * MIN), event: 'gate_blocked', missing: [], cwd: s.root, session: 's1' },
    { ts: T(-29 * MIN), event: 'guard_asked', kind: 'config_broken', file: 'src/a.js', cwd: s.root, session: 's1' },
  ];
  for (let i = 1; i <= 12; i++) {
    const cnt = 13 - i;
    for (let k = 0; k < cnt; k++) {
      evs.push({ ts: T(-20 * MIN + i), event: 'guard_asked', kind: 'danger', file: `src/f${String(i).padStart(2, '0')}.js`, cwd: s.root, session: 's1' });
    }
  }
  writeFileSync(s.log, evs.map((x) => JSON.stringify(x)).join('\n') + '\n');

  const rDef = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  eq('有各類複雜紀錄時回傳 0', rDef.code, 0);
  check('關卡設定損壞時印出 stagesBrokenLine', rDef.out.includes('裡的關卡讀不懂'));
  check('spec_precheck 保留異常值其他標記、缺 specs 明標未記規格路徑、noteFile 展開前 3 行且遺失明講找不到',
    rDef.out.includes('找到問題 found 2 筆、沒對到已知死法 ok 1 筆、其他標記 1 筆')
    && rDef.out.includes('未記規格路徑：找到 1 條')
    && rDef.out.includes('完整清單找不到：gone-precheck.txt 不見了')
    && !rDef.out.includes('第四行不該出現在預設前3行'));
  check('stage_report 保留歷史舊關卡代號 Z、單行過長截短絕不印「尚有 0 行」',
    rDef.out.includes('Z（已不在目前關卡清單）：found 1／ok 0')
    && rDef.out.includes('完整清單找不到：gone-stage.txt 不見了')
    && rDef.out.includes('單行過長已截短')
    && !rDef.out.includes('尚有 0 行'));
  check('gate_blocked 分開印出總擋 3 次與各缺項累計次數及未標缺項',
    rDef.out.includes('共擋 3 次（各缺項累計出現次數：D:ask × 2、tests × 1）（另有 1 次未標缺項種類）'));
  check(`guard_asked 超過 ${DEFAULT_RETROSPECT_GUARD_LIMIT} 檔時預設列前 10 檔並報總檔數 12`,
    rDef.out.includes('共涉及 12 個檔案，列前 10 個') && !rDef.out.includes('src/f12.js'));

  const rAll = runCli(s.root, s.monitorDir, s.home, ['--retrospect', '--all']);
  check('--all 展開完整 noteFile 內容與全部 12 個 guard_asked 檔案',
    rAll.out.includes('第四行不該出現在預設前3行') && rAll.out.includes('src/f12.js'));
  s.cleanup();
}

/* ════════════ 7. 零 commit 新專案、子目錄與非 git 目錄 ════════════ */

section('AC-2: 零 commit 新專案、子目錄執行與非 git 目錄處理（P13）', 'P13');
{
  const s = setupRepo({ commit: false });
  const sub = join(s.root, 'src');
  const rZero = runCli(sub, s.monitorDir, s.home, ['--retrospect']);
  eq('零 commit 的 git 子目錄跑 --retrospect 回傳 0', rZero.code, 0);
  check('輸出含專案名與兩塊盤點標題', rZero.out.includes('1. 專案文件與分級現況') && rZero.out.includes('2. 本專案近 90 天紀錄純統計'));
  s.cleanup();

  const nonGit = mkdtempSync(join(tmpdir(), 'pm-retro-nongit-'));
  const m = mkdtempSync(join(tmpdir(), 'pm-retro-m-'));
  const h = mkdtempSync(join(tmpdir(), 'pm-retro-h-'));
  const rNon = runCli(nonGit, m, h, ['--retrospect']);
  eq('非 git 目錄跑 --retrospect 回傳 1', rNon.code, 1);
  check('非 git 目錄講明不是 git 專案', rNon.out.includes('這裡看起來不是一個 git 專案'));
  rmSync(nonGit, { recursive: true, force: true });
  rmSync(m, { recursive: true, force: true });
  rmSync(h, { recursive: true, force: true });
}

/* ════════════ 8. 非關卡技能隔離與門禁契約（AC-1） ════════════ */

section('AC-1: 呼叫 retrospect 不影響五關／起點／收工門禁，新回合純問答 /retrospect 安靜放行且不洗掉待補關卡（P2）', 'P2');
{
  const s = setupRepo({ tier: { code: ['src/'], danger: ['src/danger.js'] } });
  writeFileSync(join(s.root, 'src/a.js'), 'edited\n');
  const past = new Date(Date.now() - 4 * MIN * 1000);
  utimesSync(join(s.root, 'src/a.js'), past, past);
  writeFileSync(s.log, [
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's1', cwd: s.root, prompt: '先幫我寫規格' },
    { ts: T(-9 * MIN), hook: 'PostToolUse', tool: 'read_file', skill: 'agy-pipeline:spec', session: 's1', cwd: s.root },
    { ts: T(-6 * MIN), hook: 'UserPrompt', session: 's1', cwd: s.root, prompt: '改一下 src/a.js' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js'), session: 's1', cwd: s.root },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');

  const snapshotView = () => {
    const sess = collectAll({ monitorDir: s.monitorDir, skillHome: s.home }).projects[0]?.sessions?.find((x) => x.id === 's1');
    return {
      stages: (sess?.stages ?? []).map((x) => ({ id: x.id, state: x.state, ranAt: x.ranAt ?? null })),
      roundFrom: sess?.roundFrom ?? null,
    };
  };
  const payload = { conversationId: 's1', cwd: s.root, executionNum: 0, continuationActive: false, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' };
  const before = snapshotView();
  const gateBefore = decide({ payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('基準：改了程式檔尚未跑 D → 收工門禁擋 D', gateBefore?.missing?.join(','), 'D');

  // 同回合 AI 讀取 retrospect SKILL.md
  appendFileSync(s.log, JSON.stringify({ ts: T(-3 * MIN), hook: 'PostToolUse', tool: 'read_file', skill: 'agy-pipeline:retrospect', session: 's1', cwd: s.root }) + '\n');
  const afterRead = snapshotView();
  const gateAfterRead = decide({ payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('同回合讀取 retrospect 技能後：五關狀態完全一致', JSON.stringify(afterRead.stages), JSON.stringify(before.stages));
  eq('……這一輪起點完全一致', afterRead.roundFrom, before.roundFrom);
  eq('……收工門禁判斷結果完全一致', gateAfterRead?.missing?.join(','), gateBefore?.missing?.join(','));

  // 新回合使用者手打 /retrospect 純唯讀問答（零改檔）→ gate.mjs 依契約 3 安靜放行；再改檔時仍需補 D
  appendFileSync(s.log, JSON.stringify({ ts: T(-2 * MIN), hook: 'UserPrompt', session: 's1', cwd: s.root, prompt: '/retrospect' }) + '\n');
  eq('新回合手打 /retrospect 純唯讀問答 → gate.mjs 安靜放行', decide({ payload, monitorDir: s.monitorDir, skillHome: s.home }), null);
  appendFileSync(s.log, JSON.stringify({ ts: T(-1 * MIN), hook: 'UserPrompt', session: 's1', cwd: s.root, prompt: '繼續改 src/a.js' }) + '\n');
  appendFileSync(s.log, JSON.stringify({ ts: T(-30), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js'), session: 's1', cwd: s.root }) + '\n');
  eq('之後再改程式檔，原本待補的 D 依然存在不被洗掉', decide({ payload, monitorDir: s.monitorDir, skillHome: s.home })?.missing?.join(','), 'D');
  s.cleanup();
}

/* ════════════ 9. ZH／EN 雙語實跑與零中文／禁語掃描 ════════════ */

section('AC-5: 英文模式下 --retrospect 全英文輸出、零 CJK／全形空白殘留且不含紅線禁語（P10）', 'P10');
{
  const s = setupRepo({ tier: { code: ['src/'], danger: ['src/danger.js', 'ghost/x.js'] } });
  mkdirSync(join(s.root, 'docs', 'done'), { recursive: true });
  writeFileSync(join(s.root, 'docs', 'done', 'en-spec.md'), '# English spec\n2026-11-26\n');
  writeFileSync(join(s.root, 'docs', 'FAILURE-PATTERNS.md'), '# FP\n\n## P1 First rule\n');
  writeFileSync(join(s.root, 'docs', 'LESSONS.md'), '# Lessons\n\n## L1 Lesson one\n');
  const noteFile = join(s.monitorDir, 'logs', 'reports', 'en-gone.txt');
  writeFileSync(s.log, [
    { ts: T(-10 * MIN), hook: 'UserPrompt', session: 's1', cwd: s.root, prompt: 'run retrospect' },
    { ts: T(-9 * MIN), event: 'spec_precheck', verdict: 'ok', note: 'ok', cwd: s.root },
    { ts: T(-8 * MIN), event: 'spec_precheck', verdict: 'found', specs: ['docs/planned/x.md'], note: 'Found 1', noteFile, cwd: s.root },
    { ts: T(-7 * MIN), event: 'stage_report', stage: 'D', verdict: 'found', note: 'Found 1\nline2\nline3\nline4', cwd: s.root },
    { ts: T(-6 * MIN), event: 'gate_blocked', missing: ['D:ask'], cwd: s.root, session: 's1' },
    { ts: T(-5 * MIN), event: 'guard_asked', kind: 'danger', file: 'src/danger.js', rule: 'src/danger.js', cwd: s.root, session: 's1' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');

  const rEn = runCli(s.root, s.monitorDir, s.home, ['--retrospect'], { lang: 'en' });
  eq('英文模式執行 --retrospect 回傳 0', rEn.code, 0);
  check('英文輸出零 CJK 與全形空白（U+3000）', !CJK.test(rEn.out), rEn.out);
  const FORBIDDEN = [/\bpassed\b/i, /\ball clear\b/i, /\bno problems\b/i, /\bsafe\b/i, /\bverified\b/i, /\bworks\b/i, /\bnot run\b/i, /\bnever ran\b/i];
  const hitForbidden = FORBIDDEN.find((re) => re.test(rEn.out));
  check('英文輸出不含任何紅線禁語', !hitForbidden, hitForbidden ? String(hitForbidden) : '');

  const rEnBad = runCli(s.root, s.monitorDir, s.home, ['--retrospect', '--unknown'], { lang: 'en' });
  eq('英文模式未知旗標回傳 1', rEnBad.code, 1);
  check('英文錯誤提示零 CJK 且含 Usage', !CJK.test(rEnBad.out) && rEnBad.out.includes('Usage: agy-pipeline --retrospect [--all]'), rEnBad.out);

  // 中文模式 collectRetrospectFacts + formatRetrospectLines 結構 sanity（傳入假 home 維持環境隔離，P8）
  const zhOut = withLang('zh', () => formatRetrospectLines(collectRetrospectFacts({
    project: basename(s.root),
    root: s.root,
    mainRoot: s.root,
    isGit: true,
    hasCommits: true,
  }, { monitorDir: s.monitorDir, logDir: join(s.monitorDir, 'logs'), home: s.home })).join('\n'));
  check('中文直接呼叫 formatRetrospectLines 含兩段標題', zhOut.includes('1. 專案文件與分級現況') && zhOut.includes('2. 本專案近 90 天紀錄純統計'));
  s.cleanup();
}

/* ════════════ 10. D 魔鬼教官第 1 輪回歸測試（P11/P3/P6/P2/R1） ════════════ */

section('D 魔鬼教官第 1 輪回歸：plugin 掛載/斷鏈、曾有紀錄拆感測器、已刪 worktree 恢復故障與 _subagent 口徑（P11/P2/P6）', 'P11');
{
  const s = setupRepo();

  // #1a：已裝好使用者層級 plugin 且尚無紀錄檔 → 絕不誤印「感測器：沒掛上」
  const rInstalled = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('已裝使用者層級 plugin（no-file）時不誤印「感測器：沒掛上」',
    !rInstalled.out.includes('感測器：沒掛上'), rInstalled.out);

  // #1b：plugin 捷徑斷鏈 → 印出 broken 紅燈與 mountFix
  const linkPath = join(s.home, '.gemini', 'config', 'plugins', PLUGIN);
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync('/nonexistent/agy-pipeline-gone', linkPath);
  const rDangling = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('plugin 捷徑斷鏈時偵測出 broken 並附修法',
    rDangling.out.includes('感測器：🔴 掛著') && rDangling.out.includes('--install'), rDangling.out);

  // #2：拆掉 plugin（空 home）但近 90 天已有感測器紀錄 → 不靜默跳過，照實走 sensorOffLine
  rmSync(linkPath, { recursive: true, force: true });
  writeFileSync(s.log, `${JSON.stringify({ ts: T(-10 * MIN), hook: 'PostToolUse', tool: 'read_file', cwd: s.root, session: 's1' })}\n`);
  const rUninstalledAfterLog = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('曾有紀錄但之後拆掉 plugin 時，透過 sensorOffLine 明講設定裡找不到',
    rUninstalledAfterLog.out.includes('感測器：設定裡找不到'), rUninstalledAfterLog.out);

  // #5：已刪除舊 worktree 的 90 天內已恢復故障仍須出現在帳單
  symlinkSync(ROOT, linkPath);
  const deletedWt = join(tmpdir(), `pm-retro-gone-wt-${Date.now()}`);
  writeFileSync(s.log, [
    { ts: T(-3 * DAY), hook: 'PostToolUse', tool: 'edit_file', cwd: deletedWt, session: 's-wt', file: join(deletedWt, 'src/a.js') },
    { ts: T(-10 * MIN), event: 'stage_report', stage: 'D', verdict: 'ok', note: 'ok', cwd: s.root, source: 'ai' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(s.monitorDir, 'logs', SENSOR_FILE), `${JSON.stringify({ ts: T(-2 * DAY), event: 'gate_broken', why: 'boom', cwd: deletedWt })}\n`);
  writeFileSync(join(s.monitorDir, 'logs', GATE_FILE), JSON.stringify({ ts: T(-1 * DAY), cwd: deletedWt, byCwd: { [deletedWt]: T(-1 * DAY) } }) + '\n');
  const rDeletedWtFault = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('已刪除舊 worktree 曾發生且已恢復的 gate_broken 仍照實呈現在帳單',
    rDeletedWtFault.out.includes('收工 hook') && rDeletedWtFault.out.includes('沒再記到出錯'), rDeletedWtFault.out);

  // #6：僅有 _subagent hook 事件 + 1 筆結構化事件 → sensorCount 為 0，與 noSensorWithin 口徑完全一致
  writeFileSync(join(s.monitorDir, 'logs', SENSOR_FILE), '');
  writeFileSync(s.log, [
    { ts: T(-10 * MIN), hook: 'PostToolUse', tool: 'read_file', subagent_parent: 's1', cwd: s.root, session: 'sub-1' },
    { ts: T(-5 * MIN), event: 'stage_report', stage: 'D', verdict: 'found', note: '找到 1 條', cwd: s.root, source: 'ai' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const rSubOnly = runCli(s.root, s.monitorDir, s.home, ['--retrospect']);
  check('僅有 _subagent hook 事件時，sensorCount 為 0 且與無感測器警告一致（不自相矛盾）',
    rSubOnly.out.includes('其中感測器 hook 事件 0 筆') && rSubOnly.out.includes('沒有任何感測器（hook）事件'), rSubOnly.out);

  s.cleanup();
}

process.exit(summary());
