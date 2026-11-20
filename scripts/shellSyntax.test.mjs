/**
 * hook 的殼（根目錄 hooks.json 接的每一支 .sh）讀得懂：這台的 sh 讀一次，有 dash 再用 dash 讀一次。只讀（sh -n），不執行。
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, summary } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 接了哪幾支，從根目錄 hooks.json 讀：清單只住那一份（老毛病 P2）
const hooks = readFileSync(join(ROOT, 'hooks.json'), 'utf8');
const shells = [...new Set([...hooks.matchAll(/(?:\.\/|\/)([\w.-]+\.sh)/g)].map((m) => m[1]))].sort();
const dash = ['/bin/dash', '/usr/bin/dash'].find((p) => existsSync(p)) ?? null;

/** 用某一種 sh 讀一次、不執行。讀得懂 → null；讀不懂 → 它說的錯誤。 */
function parseError(sh, file) {
  try { execFileSync(sh, ['-n', join(ROOT, file)], { stdio: ['ignore', 'ignore', 'pipe'] }); return null; }
  catch (e) { return String(e.stderr || e.message).trim() || `${sh} 讀不懂`; }
}

section('根目錄 hooks.json 接的每一支 .sh 都讀得懂：這台的 sh 讀一次，有 dash 再用 dash 讀一次', 'P8');
{
  check(`從 hooks.json 讀到接了哪幾支：${shells.join('、') || '一支都沒有'}`, shells.length > 0);
  check('包含 hook.sh、remind.sh、gate.sh', ['gate.sh', 'hook.sh', 'remind.sh'].every((s) => shells.includes(s)), shells.join('、'));
  for (const f of shells) {
    check(`${f} 在`, existsSync(join(ROOT, f)));
    const shErr = parseError('sh', f);
    check(`${f}:這台的 sh 讀得懂`, shErr === null, shErr ?? '');
    if (dash) {
      const dashErr = parseError(dash, f);
      check(`${f}:dash 讀得懂`, dashErr === null, dashErr ?? '');
    }
  }
  if (!dash) console.log('  ⚠️ 這台沒有 dash:只用這台的 sh 讀了一次,GitHub 上的 sh 讀不讀得懂,這裡看不到');
}

process.exit(summary());
