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
import { availableParallelism, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { codeHome } from '../lib/paths.mjs';
import { snapshot, compare } from './_realdata.mjs';

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

// ⚠️ 跑完檢查一次:有沒有測試碰到這台電腦真的紀錄(老毛病 P8)，同時守護新版 ~/.pipeline-monitor-agy 與原版 ~/.pipeline-monitor。
const where = {
  realHome: join(userInfo().homedir, '.pipeline-monitor-agy'),
  legacy: codeHome(join(here, '..')),
  extraHomes: [join(userInfo().homedir, '.pipeline-monitor')],
};
const before = snapshot(where);

const queue = [...files];
let bad = 0;
async function worker() {
  while (queue.length) if (!(await run(queue.shift()))) bad++;
}
await Promise.all(Array.from({ length: Math.min(availableParallelism(), files.length) }, worker));

const { leaked, movedAway } = compare(before, snapshot(where), where);
console.log(`\n${'═'.repeat(48)}\n▸ 測試有沒有碰到這台電腦真的紀錄（同時守 ~/.pipeline-monitor-agy 與原版 ~/.pipeline-monitor）`);
if (leaked.length) {
  bad++;
  console.log(`  ✗ 真的紀錄裡多了測試的東西(老毛病 P8):\n      ${leaked.join('\n      ')}`);
  console.log('      哪一支測試沒用假的家?(_harness.mjs 給的 AGY_PIPELINE_HOME)');
} else console.log('  ✓ 沒有多出測試的檔(pm- 開頭)');
if (movedAway.length) {
  bad++;
  console.log(`  ✗ 舊的地方被搬走了(老毛病 P8):${movedAway.join('、')}`);
} else console.log('  ✓ 程式資料夾裡的目錄沒有被動到');

console.log(`\n${'═'.repeat(48)}`);
console.log(bad ? `❌ ${bad} 項失敗（${files.length} 支測試檔＋跑完那兩項檢查）` : `✅ ${files.length}/${files.length} 支測試檔全數通過；真的紀錄沒多出測試的檔、舊的地方也沒被搬走（只查得到這兩種）`);
process.exit(bad ? 1 : 0);
