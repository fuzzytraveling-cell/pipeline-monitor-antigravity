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

console.log('\n■ 版本號：結案一件升一碼，每份結案的規格寫得出它在哪一版上線');
// 號碼只住 package.json 一個地方(儀表板的還原點直接讀它);規則在 CLAUDE.md「工作項的狀態就是路徑」。
// ⚠️ 2026-09-24 之前,version 從第一次存檔起就停在 0.1.0:97 次存檔、結案 15 件沒人動過,還原點的大字一直寫 v0.1.0——
//    沒人維護、看起來卻有意義的數字。靠記得升版遲早又停住,所以由這裡檢查:結案了沒寫上線版本、寫了卻沒升 package.json、
//    兩個對話同時結案搶到同一個號碼,都會紅。
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const cmpVersion = (a, b) => {
  const [x, y] = [a, b].map((v) => v.match(SEMVER).slice(1).map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
const VERSION_START = '0.15.0';   // 開始編號時的版本(當時已結案 15 件);之後結案的第一份是 0.16.0
// 開始編號之前結案的不回頭補號——當時沒有版本,補了就是編的(R3)。這份清單只會變短,不會變長
const BEFORE_VERSIONING = new Set([
  'D多輪先問人.md', 'E自動驗收.md', 'app建議卡.md', 'pipeline-sensor.md', 'pipeline-status.md', 'pipeline-ui.md', 'plugin.md',
  'sensor-install.md', '五關自動結案.md', '分級.md', '施工對話認規格.md', '規格搬家.md', '誠實修補.md', '這一輪的起點.md', '通用三關.md',
]);
const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const pkgOk = typeof pkgVersion === 'string' && SEMVER.test(pkgVersion);
check(`package.json 的 version 是 X.Y.Z（目前 ${pkgVersion}）`, pkgOk);
if (pkgOk) check(`package.json 的 version 沒有比開始編號時（${VERSION_START}）舊`, cmpVersion(pkgVersion, VERSION_START) >= 0);
const shipped = new Map();
for (const d of docs.filter((x) => x.startsWith('docs/升級摘要/'))) {
  const m = readFileSync(join(ROOT, d), 'utf8').match(/上線版本[：:]\s*v(\d+\.\d+\.\d+)/);
  if (!m) {
    if (BEFORE_VERSIONING.has(d.split('/').pop())) continue;   // 開始編號之前結案的,不補號
    check(`${d} 寫了上線版本`, false, '結案時在施作紀錄最後加一行「上線版本：vX.Y.Z」，並把 package.json 升到那一版');
    continue;
  }
  const v = m[1];
  check(`${d} 的 v${v} 比開始編號時（${VERSION_START}）新`, cmpVersion(v, VERSION_START) > 0, '開始編號之後結案的第一份是 v0.16.0');
  check(`${d} 的 v${v} 沒有比 package.json（${pkgVersion}）新`, pkgOk && cmpVersion(v, pkgVersion) <= 0, '寫了上線版本，package.json 卻沒升上去');
  check(`v${v} 只有一份規格在用`, !shipped.has(v), `${shipped.get(v)} 也寫 v${v}——兩個對話同時結案搶到同一個號碼，改掉其中一份（package.json 跟著升）`);
  shipped.set(v, d);
}

console.log(
  failed
    ? `\n────────────────────────\n❌ ${failed} 項失敗\n`
    : `\n────────────────────────\n✅ 全部通過（${docs.length} 份文件）\n`
);
process.exit(failed ? 1 : 0);
