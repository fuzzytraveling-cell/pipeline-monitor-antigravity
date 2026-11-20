/**
 * docsIndex.test.mjs —— 讓文件腐爛的時候有東西會變紅
 *
 * ⚠️ **這支測試是整個文件結構的前提，不是附贈品。**
 * 釘的是**路徑**不是檔名，且同時守 AGENTS.md 的索引與 package.json／plugin.json 版本一致性。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const handbook = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
// AGENTS.md 裡提到的所有 docs/ 路徑（連結或行內碼都算；排除 <功能>.md 佔位符）
const referenced = new Set(
  [...handbook.matchAll(/docs\/[^\s`)\]"'）】]+\.md/g)]
    .map((m) => m[0])
    .filter((r) => !r.includes('<'))
);

console.log('\n■ 每一份文件都在 AGENTS.md 的索引裡（雙向）');
for (const d of docs) {
  check(`索引裡找得到 ${d}`, referenced.has(d), '在 AGENTS.md 的「動手前該讀哪一份」加一行');
}
for (const r of referenced) {
  check(`${r} 真的存在`, existsSync(join(ROOT, r)), '索引指向一個不存在的檔案');
}

console.log('\n■ 工作項標的資料夾＝它實際所在的資料夾');
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

console.log('\n■ 版本號：package.json 與 plugin.json 一致，且 Antigravity 版新結案規格不撞號');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const cmpVersion = (a, b) => {
  const [x, y] = [a, b].map((v) => v.match(SEMVER).slice(1).map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
// 分叉前（原版 Claude pipeline-monitor）已封存於 docs/升級摘要/ 的歷史規格，保留參考但不與 Antigravity 版 0.1.0 起算線混比
const BEFORE_VERSIONING = new Set([
  'D多輪先問人.md', 'E自動驗收.md', 'app建議卡.md', 'pipeline-sensor.md', 'pipeline-status.md', 'pipeline-ui.md', 'plugin.md',
  'sensor-install.md', '五關自動結案.md', '分級.md', '施工對話認規格.md', '規格搬家.md', '誠實修補.md', '這一輪的起點.md', '通用三關.md',
]);
const PRE_FORK_ARCHIVE = new Set([
  '90天清理不丟紀錄.md', '90天清空之後的說法.md', 'agent回報與故障記號.md', 'app建議卡換工具.md', 'dashboard-language-shortcut.md',
  'skill範圍跟收工hook對齊.md', '主任技能.md', '主任動手收尾.md', '主任條列與工地帽.md', '儀表板刷新少等git.md',
  '儀表板與終端機中英切換.md', '先講commit再講蓋章.md', '併進來的不算這一輪.md', '危險清單會過期.md',
  '多份規格與新資料夾的起點.md', '工地工班風畫面.md', '建議卡開的對話認得出已開始.md', '技能與寫給AI的話中英切換.md',
  '收工hook問危險清單.md', '新對話接手舊資料夾.md', '當場問的卡也收進來.md', '紀錄搬到固定的家.md',
  '紀錄與判斷分家.md', '終端機照指令拆開.md', '終端機與網頁說同一句.md', '還差什麼總表.md',
]);

const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const pluginVersion = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).version;
const pkgOk = typeof pkgVersion === 'string' && SEMVER.test(pkgVersion);
check(`package.json 的 version 是 X.Y.Z（目前 ${pkgVersion}）`, pkgOk);
check(`plugin.json 的 version 與 package.json 一致（${pluginVersion} === ${pkgVersion}）`, pluginVersion === pkgVersion);

const shippedPre = new Map();
const shippedAgy = new Map();
for (const d of docs.filter((x) => x.startsWith('docs/升級摘要/'))) {
  const base = d.split('/').pop();
  const m = readFileSync(join(ROOT, d), 'utf8').match(/上線版本[：:]\s*v(\d+\.\d+\.\d+)/);
  if (!m) {
    if (BEFORE_VERSIONING.has(base)) continue;
    check(`${d} 寫了上線版本`, false, '結案時在施作紀錄最後加一行「上線版本：vX.Y.Z」，並把 package.json 與 plugin.json 升到那一版');
    continue;
  }
  const v = m[1];
  if (PRE_FORK_ARCHIVE.has(base)) {
    check(`封存歷史規格 ${d} 的 v${v} 不重複`, !shippedPre.has(v), `${shippedPre.get(v)} 也寫 v${v}`);
    shippedPre.set(v, d);
    continue;
  }
  check(`${d} 的 v${v} 沒有比 package.json（${pkgVersion}）新`, pkgOk && cmpVersion(v, pkgVersion) <= 0, '寫了上線版本，package.json 卻沒升上去');
  check(`Antigravity 版 v${v} 只有一份規格在用`, !shippedAgy.has(v), `${shippedAgy.get(v)} 也寫 v${v}`);
  shippedAgy.set(v, d);
}

console.log(
  failed
    ? `\n────────────────────────\n❌ ${failed} 項失敗\n`
    : `\n────────────────────────\n✅ 全部通過（${docs.length} 份文件）\n`
);
process.exit(failed ? 1 : 0);
