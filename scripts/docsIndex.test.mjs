/**
 * docsIndex.test.mjs —— 讓文件腐爛的時候有東西會變紅
 *
 * ⚠️ **這支測試是整個文件結構的前提，不是附贈品。**
 * 文件腐爛沒有任何徵兆:程式照跑、功能正常。沒有機械檢查的索引，
 * 只是一份「看起來很嚴謹」的東西——而這個工具存在的全部意義，
 * 就是不做看起來很嚴謹的事。
 *
 * ⚠️ 釘的是**路徑**不是檔名。TutorPod 2026-09-04 出過事:
 * 索引只比對檔名，結果工作項被標在錯的狀態資料夾，而測試全綠。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIP_LIMIT = 2;
let failed = 0;

function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failed++;
}

/** docs/ 底下所有 .md（.gitkeep 之類不算文件） */
function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (e.endsWith('.md')) acc.push(relative(ROOT, full));
  }
  return acc;
}

const docs = walk(join(ROOT, 'docs')).sort();
const claudeMd = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
// CLAUDE.md 裡提到的所有 docs/ 路徑（連結或行內碼都算）
const referenced = new Set(
  // ⚠️ 排除 <功能>.md 這種佔位符——它是說明文字,不是引用。
  // 沒排除的話,一份寫得好的說明反而會把測試弄紅。
  [...claudeMd.matchAll(/docs\/[^\s`)\]"'）】]+\.md/g)]
    .map((m) => m[0])
    .filter((r) => !r.includes('<'))
);

console.log('\n■ 每一份文件都在 CLAUDE.md 的索引裡（雙向）');
for (const d of docs) {
  check(`索引裡找得到 ${d}`, referenced.has(d), '在 CLAUDE.md 的「動手前該讀哪一份」加一行');
}
for (const r of referenced) {
  check(`${r} 真的存在`, existsSync(join(ROOT, r)), '索引指向一個不存在的檔案');
}

console.log('\n■ 工作項標的資料夾＝它實際所在的資料夾');
// ⚠️ 這一條就是 TutorPod 踩過的那個坑:只比檔名的話，這裡永遠是綠的。
for (const d of docs) {
  const m = d.match(/^docs\/(規劃中|進行中|升級摘要)\//);
  if (!m) continue;
  const wrong = [...referenced].filter(
    (r) => r.endsWith('/' + d.split('/').pop()) && r !== d
  );
  check(`${d} 沒有被標在別的資料夾`, wrong.length === 0, `索引寫的是 ${wrong.join(', ')}`);
}

console.log('\n■ 同時開工的工作項不超過上限');
const wip = docs.filter((d) => d.startsWith('docs/進行中/'));
check(`進行中/ 不超過 ${WIP_LIMIT} 個（目前 ${wip.length}）`, wip.length <= WIP_LIMIT, wip.join(', '));

console.log('\n■ 文件之間的互相引用都指得到東西');
for (const d of docs) {
  const body = readFileSync(join(ROOT, d), 'utf8');
  for (const m of body.matchAll(/\]\(([^)]+\.md)\)/g)) {
    const target = m[1];
    if (target.startsWith('http')) continue;
    const abs = join(ROOT, dirname(d), target);
    check(`${d} → ${target}`, existsSync(abs), '連到一個不存在的檔案');
  }
}

console.log(
  failed
    ? `\n────────────────────────\n❌ ${failed} 項失敗\n`
    : `\n────────────────────────\n✅ 全部通過（${docs.length} 份文件）\n`
);
process.exit(failed ? 1 : 0);
