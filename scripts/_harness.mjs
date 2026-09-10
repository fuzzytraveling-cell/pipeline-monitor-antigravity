/** 零相依的測試小工具。刻意不裝測試框架——見 CLAUDE.md「不加任何 npm 相依」。 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0, passed = 0;
export function section(t) { console.log(`\n■ ${t}`); }
export function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  ok ? passed++ : failed++;
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
export function makeRepo({ pkg = null, files = {}, commit = true } = {}) {
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
  if (commit) { g('add', '-A'); g('commit', '-qm', 'init'); }
  return { dir, git: g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
