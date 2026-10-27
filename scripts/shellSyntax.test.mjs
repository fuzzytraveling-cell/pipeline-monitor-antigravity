/**
 * hook 的殼(hooks/hooks.json 接的每一支 .sh)讀得懂:這台的 sh 讀一次,有 dash 再用 dash 讀一次。只讀(sh -n),不執行。
 *
 * 為什麼放在這裡、不寫在 CI 的設定檔:檢查放進 npm test,本機才會先紅(L10;ci.yml 開頭也這樣寫)。
 * 2026-10-27 還多一個理由:改 ci.yml 要 GitHub token 有 workflow 權限,這台 Mac 的沒有,推不上去。
 *
 * ⚠️ 這台 Mac 的 sh 是 bash 扮的,GitHub 的 sh 是 dash:bash 讀得懂的寫法(陣列、<<<…)dash 不一定讀得懂。
 *    本機有 dash 就再讀一次,GitHub 上紅之前本機先紅(老毛病 P8)。
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, summary } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 接了哪幾支,從 hooks.json 讀:清單只住那一份(老毛病 P2),以後多接一支這裡自動跟上
const hooks = readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8');
const shells = [...new Set([...hooks.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w.-]+\.sh)/g)].map((m) => m[1]))].sort();
const dash = ['/bin/dash', '/usr/bin/dash'].find((p) => existsSync(p)) ?? null;

/** 用某一種 sh 讀一次、不執行。讀得懂 → null;讀不懂 → 它說的錯誤。 */
function parseError(sh, file) {
  try { execFileSync(sh, ['-n', join(ROOT, file)], { stdio: ['ignore', 'ignore', 'pipe'] }); return null; }
  catch (e) { return String(e.stderr || e.message).trim() || `${sh} 讀不懂`; }
}

section('hooks.json 接的每一支 .sh 都讀得懂:這台的 sh 讀一次,有 dash 再用 dash 讀一次(GitHub 的 sh 就是 dash)', 'P8');
{
  // 一支都沒讀到是「沒問到」,不是「沒有要檢查的」(R1)
  check(`從 hooks.json 讀到接了哪幾支：${shells.join('、') || '一支都沒有'}`, shells.length > 0);
  for (const f of shells) {
    check(`${f} 在`, existsSync(join(ROOT, f)));
    const shErr = parseError('sh', f);
    check(`${f}:這台的 sh 讀得懂`, shErr === null, shErr ?? '');
    if (dash) {
      const dashErr = parseError(dash, f);
      check(`${f}:dash 讀得懂(GitHub 的 sh)`, dashErr === null, dashErr ?? '');
    }
  }
  if (!dash) console.log('  ⚠️ 這台沒有 dash:只用這台的 sh 讀了一次,GitHub 上的 sh 讀不讀得懂,這裡看不到');
}

process.exit(summary());
