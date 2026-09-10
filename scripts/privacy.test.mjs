/**
 * privacy.test.mjs —— 擋住「程式產生的私人資料被 commit 上去」
 *
 * ⚠️ 2026-09-10 真的發生過:`.gitignore` 寫了 checkpoints/ 卻漏了 logs/,
 *    而 logs/ 裡有使用者打的每一則訊息。推上 GitHub 才發現。
 *    **這種錯不會有任何徵兆**——git 不會抱怨,測試不會紅,功能完全正常。
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, summary } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 程式自己會寫出來的資料夾。**新增任何會寫檔的功能時,要同步加進這個清單。**
const MUST_NEVER_BE_TRACKED = ['logs', 'checkpoints'];

section('程式產生的私人資料絕不准進版控');
for (const dir of MUST_NEVER_BE_TRACKED) {
  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files', dir], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { /* 不是 git repo 就跳過 */ }
  check(`${dir}/ 沒有被 git 追蹤`, tracked === '',
    `這些檔案已經在版控裡:\n      ${tracked.split('\n').join('\n      ')}`);

  let ignored = false;
  try {
    execFileSync('git', ['check-ignore', '-q', `${dir}/x`], { cwd: ROOT, stdio: 'ignore' });
    ignored = true;
  } catch { ignored = false; }
  check(`${dir}/ 有寫進 .gitignore`, ignored, '否則下一個新檔案又會被 commit 進去');
}

process.exit(summary());
