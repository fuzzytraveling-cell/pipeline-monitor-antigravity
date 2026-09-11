/**
 * privacy.test.mjs —— 擋住「程式產生的私人資料被 commit 上去」
 *
 * ⚠️ 2026-09-10 真的發生過:`.gitignore` 寫了 checkpoints/ 卻漏了 logs/,
 *    而 logs/ 裡有使用者打的每一則訊息。推上 GitHub 才發現。
 *    **這種錯不會有任何徵兆**——git 不會抱怨,測試不會紅,功能完全正常。
 * ⚠️ 2026-09-11 第二次:`--on` 寫進本 repo 的 .claude/settings.local.json 沒被 ignore,
 *    主資料夾因此永遠「有一個檔案還沒 commit」而蓋不了章。
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, summary } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 程式自己會寫出來的東西(資料夾以 / 結尾)。**新增任何會寫檔的功能時,要同步加進這個清單。**
const MUST_NEVER_BE_TRACKED = ['logs/', 'checkpoints/', '.claude/settings.local.json'];

section('程式產生的私人資料絕不准進版控', 'P3');
for (const p of MUST_NEVER_BE_TRACKED) {
  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files', p], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { /* 不是 git repo 就跳過 */ }
  check(`${p} 沒有被 git 追蹤`, tracked === '',
    `這些檔案已經在版控裡:\n      ${tracked.split('\n').join('\n      ')}`);

  // 資料夾要拿一個假想的檔案去問,git 才會回答「這底下的東西會被忽略」
  const probe = p.endsWith('/') ? `${p}x` : p;
  let ignored = false;
  try {
    execFileSync('git', ['check-ignore', '-q', probe], { cwd: ROOT, stdio: 'ignore' });
    ignored = true;
  } catch { ignored = false; }
  check(`${p} 有寫進 .gitignore`, ignored, '否則下一個新檔案又會被 commit 進去');
}

process.exit(summary());
