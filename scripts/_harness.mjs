/** 零相依的測試小工具。刻意不裝測試框架——見 CLAUDE.md「不加任何 npm 相依」。 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATTERNS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'FAILURE-PATTERNS.md');

let failed = 0, passed = 0;
// 這一段測試釘的是哪一個老毛病(docs/FAILURE-PATTERNS.md 的代號)。
// ⚠️ 那份文件自己不會被打開,所以接在這裡:紅的時候把對應那一行印在 ✗ 底下。
let pattern = null;

/** 找 docs/FAILURE-PATTERNS.md 裡 `## P1　…` 那一行。找不到回 null——呼叫端要把它當錯誤,不是當沒事。 */
function patternHeading(id) {
  try {
    const re = new RegExp(`^##\\s*${id}(?![0-9])`);
    return readFileSync(PATTERNS, 'utf8').split('\n').find((l) => re.test(l))?.replace(/^##\s*/, '') ?? null;
  } catch { return null; }
}

export function section(t, patternId = null) {
  console.log(`\n■ ${t}`);
  pattern = null;
  if (!patternId) return;
  const heading = patternHeading(patternId);
  // 標了一個文件裡沒有的代號 → 直接算失敗。文件跟測試脫節的那一刻就要紅,不能等有人發現。
  check(`老毛病 ${patternId} 在 docs/FAILURE-PATTERNS.md 裡有一條`, heading !== null,
        '先把它寫進 docs/FAILURE-PATTERNS.md,再在這裡標代號');
  pattern = heading ? { heading, shown: false } : null;
}

export function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  ok ? passed++ : failed++;
  if (!ok && pattern && !pattern.shown) {
    pattern.shown = true;
    console.log(`      ⚠️ 老毛病又來了:${pattern.heading}  → docs/FAILURE-PATTERNS.md`);
  }
}
export function eq(label, actual, expected) {
  check(label, Object.is(actual, expected), `expected: ${expected}\n      actual:   ${actual}`);
}
export function summary() {
  console.log(failed ? `\n❌ ${failed} 項失敗 / 共 ${failed + passed} 項\n`
                     : `\n✅ ${passed} 項全數通過\n`);
  return failed ? 1 : 0;
}

/** 造一個真的 git repo 當測試場。回傳路徑,呼叫端負責 cleanup()。 */
/**
 * at:第一個 commit 的時間(ISO),預設一小時前。劇本裡「這一輪開始」通常寫在幾分鐘前,專案要在那之前就存在——
 * 不然起點比 reflog 最早那一筆還早,「這次改動」照實退回只看還沒存檔的(規格:這一輪的起點 AC-4):測試照樣綠,
 * 測到的卻是退路,不是真的會走的那條路。reflog 那一筆的時間跟著 GIT_COMMITTER_DATE 走。
 */
export function makeRepo({ pkg = null, files = {}, commit = true, at = new Date(Date.now() - 3600_000).toISOString() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pm-test-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [p, body] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  if (commit) {
    g('add', '-A');
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir, stdio: 'ignore',
      env: at ? { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : process.env });
  }
  return { dir, git: g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
