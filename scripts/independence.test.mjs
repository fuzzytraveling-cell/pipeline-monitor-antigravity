/**
 * independence.test.mjs —— 「不准依賴 TutorPod」的機械檢查
 *
 * ⚠️ 這支的歷史本身就是教訓(LESSONS L10,已發生 2 次):
 *    第一版寫在 CI 的 YAML 裡,規則是「grep 到 TutorPod 就紅」。
 *    結果連續兩次為了完全正當的理由變紅——一次是解釋為什麼的**註解**,
 *    一次是測試的**標題字串**。
 *
 * 要禁止的是**相依**(import 它、或寫死一條指向它的路徑),
 * 不是**提到**它。註解與說明文字提到它是好事,那是在解釋為什麼。
 *
 * ⚠️ 而且這支刻意搬進 npm test,不留在 CI 的 YAML 裡——
 *    **檢查要能在本機先紅**,不然它第一次紅一定是在 CI 上,而那時你人已經走了。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, summary } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// ⚠️ .claude 要跳過:底下有 desktop app 開的 worktree 副本(.claude/worktrees/*),掃進去會把別的分支的
//    測試檔當成自己的——2026-09-11 實測:主資料夾 npm test 紅、CI 綠(誠實修補 E4)。
const SKIP = new Set(['node_modules', '.git', '.claude', 'logs', 'checkpoints', 'docs', 'ui設計規格']);

/** 路徑形狀的參照:名字後面接斜線,或出現在 import／require 裡。 */
const DEPENDENCY = [
  /(?:from|require\s*\(|import\s*\()\s*['"`][^'"`]*ai-english-course/i,
  /['"`][^'"`]*ai-english-course\//i,
  /['"`][^'"`]*TutorPod[^'"`]*\//i,
];

// ⚠️ 這支檔案自己要跳過:它**必須**包含幾行「長得像違規」的字串,
// 否則沒辦法證明這個檢查真的抓得到東西。掃自己會永遠紅。
const SELF = fileURLToPath(import.meta.url);

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(mjs|js|sh|json)$/.test(e) && full !== SELF) acc.push(full);
  }
  return acc;
}

section('程式碼不准相依 TutorPod（提到它沒關係，指向它才有關係）');
const offenders = [];
for (const f of walk(ROOT)) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const bare = line.trim();
    if (bare.startsWith('*') || bare.startsWith('//') || bare.startsWith('#')) return;
    if (DEPENDENCY.some((re) => re.test(line))) {
      offenders.push(`${relative(ROOT, f)}:${i + 1}  ${bare.slice(0, 90)}`);
    }
  });
}
check('沒有任何 import／路徑指向 TutorPod', offenders.length === 0, offenders.join('\n      '));

// 反向確認:這支檢查本身抓得到真的違規,不是永遠綠的裝飾品。
section('這支檢查自己是有效的（不是永遠綠）');
check('一行假的 import 會被抓到',
  DEPENDENCY.some((re) => re.test(`import x from '../ai-english-course/src/a.js'`)));
check('一行寫死的路徑會被抓到',
  DEPENDENCY.some((re) => re.test(`const p = "/Users/x/TutorPod AI/v4/thing"`)));
check('註解裡提到 TutorPod 不算違規',
  !offenders.some((o) => o.includes('LESSONS') || o.includes('//')));

process.exit(summary());
