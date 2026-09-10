/** 跑 scripts/ 底下所有 *.test.mjs。任何一支紅就整個紅。 */
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();
let bad = 0;
for (const f of files) {
  console.log(`\n${'═'.repeat(48)}\n▸ ${f}`);
  try { execFileSync('node', [join(here, f)], { stdio: 'inherit' }); }
  catch { bad++; }
}
console.log(`\n${'═'.repeat(48)}`);
console.log(bad ? `❌ ${bad}/${files.length} 支測試檔失敗` : `✅ ${files.length}/${files.length} 支測試檔全數通過`);
process.exit(bad ? 1 : 0);
