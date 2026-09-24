/**
 * 跑 scripts/ 底下所有 *.test.mjs。任何一支紅就整個紅。
 *
 * 同時跑,一次最多「這台電腦的核心數」支:2026-09-24 量過,一支一支排隊要 2.5～4.7 分鐘,同時跑 45 秒——
 * 每一次改完都要等它,慢一倍就是每個對話都多等幾分鐘。
 * ⚠️ 同時跑的前提是**每支測試都用自己的暫存資料夾與埠**(mkdtemp、listen(0)),彼此不共用任何檔案。新測試也要照這樣寫,
 *    不然會變成「單獨跑綠、一起跑偶爾紅」。懷疑是互相干擾的時候,單獨跑那一支:node scripts/<那一支>.test.mjs
 * 每支的輸出等它跑完再整段印,不會交錯。
 */
import { readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

function run(f) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(here, f)], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      console.log(`\n${'═'.repeat(48)}\n▸ ${f}`);
      process.stdout.write(stdout);
      if (stderr) process.stdout.write(stderr);
      resolve(!err);
    });
  });
}

const queue = [...files];
let bad = 0;
async function worker() {
  while (queue.length) if (!(await run(queue.shift()))) bad++;
}
await Promise.all(Array.from({ length: Math.min(availableParallelism(), files.length) }, worker));

console.log(`\n${'═'.repeat(48)}`);
console.log(bad ? `❌ ${bad}/${files.length} 支測試檔失敗` : `✅ ${files.length}/${files.length} 支測試檔全數通過`);
process.exit(bad ? 1 : 0);
