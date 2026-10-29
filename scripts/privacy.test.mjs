/**
 * privacy.test.mjs —— 擋住「程式產生的私人資料被 commit 上去」
 *
 * ⚠️ 2026-09-10 真的發生過:`.gitignore` 寫了 checkpoints/ 卻漏了 logs/,
 *    而 logs/ 裡有使用者打的每一則訊息。推上 GitHub 才發現。
 *    **這種錯不會有任何徵兆**——git 不會抱怨,測試不會紅,功能完全正常。
 * ⚠️ 2026-09-11 第二次:`--on` 寫進本 repo 的 .claude/settings.local.json 沒被 ignore,
 *    主資料夾因此永遠「有一個檔案還沒 commit」而蓋不了章。
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 程式自己會寫出來的東西(資料夾以 / 結尾)。**新增任何會寫檔的功能時,要同步加進這個清單。**
const MUST_NEVER_BE_TRACKED = [
  'logs/', 'checkpoints/', '.claude/settings.local.json', '.claude/pipeline-monitor.off',
  'logs', 'checkpoints',   // 搬過家的電腦,舊的位置是一個指向新家的捷徑(不是資料夾):也要擋(規格:紀錄搬到固定的家)
  '.claude/settings.local.json.bak-*',   // --on/--off 留的備份;2026-09-11 它讓主資料夾又蓋不了章
];

/**
 * 這個路徑會不會被 git 忽略。資料夾要拿一個假想的檔案去問,git 才會回答「這底下的東西會被忽略」;萬用字元也換成一個具體的名字。
 * ⚠️ 問的那個資料夾是捷徑時(搬過家的電腦,主資料夾的 logs、checkpoints),git 拒絕回答捷徑底下的路徑(結束碼 128)——
 *    那不是「沒有忽略」,是沒問到(R1):以前把它當成沒忽略,主資料夾一搬家,蓋章就被這兩條擋下來(2026-10-29,LESSONS L46)。
 *    改問捷徑本身:git 不會跟著捷徑進去,捷徑本身被忽略,底下的東西就不可能被存進去。
 */
function ignoredIn(root, p) {
  const ask = (q) => {
    try { execFileSync('git', ['check-ignore', '-q', q], { cwd: root, stdio: 'ignore' }); return 0; } catch (e) { return e?.status ?? -1; }
  };
  const code = ask(p.endsWith('/') ? `${p}x` : p.replace('*', 'x'));
  if (code === 0) return true;
  if (code === 1 || !p.endsWith('/')) return false;   // 1 = 真的沒忽略;不是資料夾的就沒有別的問法
  return ask(p.slice(0, -1)) === 0;   // 問不到(捷徑底下):改問捷徑本身
}

section('程式產生的私人資料絕不准進版控', 'P3');
for (const p of MUST_NEVER_BE_TRACKED) {
  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files', p], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { /* 不是 git repo 就跳過 */ }
  check(`${p} 沒有被 git 追蹤`, tracked === '',
    `這些檔案已經在版控裡:\n      ${tracked.split('\n').join('\n      ')}`);

  check(`${p} 有寫進 .gitignore`, ignoredIn(ROOT, p), '否則下一個新檔案又會被 commit 進去');
}

section('搬過家的電腦:logs 是指向新家的捷徑時,照樣問得出「有沒有被忽略」,而且跟 git status 說的一樣', 'P8');
{
  // 在 worktree、在 GitHub 上跑都沒有那個捷徑,只有搬過家的主資料夾有——蓋章正是在那裡跑(LESSONS L46)
  const target = mkdtempSync(join(tmpdir(), 'pm-target-'));
  const untracked = (dir) => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).split('\n').filter((l) => /logs/.test(l));
  const ok = makeRepo({ files: { '.gitignore': '/logs\n' } });
  symlinkSync(target, join(ok.dir, 'logs'));
  check('.gitignore 寫 /logs、logs 是捷徑 → 算有忽略(git 拒答捷徑底下的路徑時改問捷徑本身)', ignoredIn(ok.dir, 'logs/'));
  eq('…git status 也看不到它', untracked(ok.dir).join(' | '), '');
  const bad = makeRepo({ files: { '.gitignore': 'logs/\n' } });
  symlinkSync(target, join(bad.dir, 'logs'));
  check('.gitignore 只寫 logs/(只認資料夾)、logs 是捷徑 → 抓得到沒忽略(不是一律算過)', !ignoredIn(bad.dir, 'logs/'));
  check('…git status 也照實列出它', untracked(bad.dir).length === 1, JSON.stringify(untracked(bad.dir)));
  ok.cleanup(); bad.cleanup(); rmSync(target, { recursive: true, force: true });
}

process.exit(summary());
