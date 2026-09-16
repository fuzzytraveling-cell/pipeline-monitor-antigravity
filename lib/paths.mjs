/**
 * paths.mjs —— 「程式在哪」跟「資料在哪」不准綁在一起
 *
 * ⚠️ 2026-09-15 實測:app 把儀表板重開在一個 worktree 裡,程式碼一模一樣,但 logs/ 與 checkpoints/
 *    住在主資料夾——worktree 裡沒有,畫面就照實說「還沒有任何案件」。Oscar 以為斷線了。
 *    資料是這台電腦的事實,只有一份;程式碼可以有好幾個 worktree。所以資料一律住在這個 repo 的
 *    **主資料夾**(git 的 common dir 所在),不管 status.mjs／server.mjs 是從哪個 worktree 跑的。
 *    hook.sh 有同一條規則的 sh 版本(看 .git 是不是一個檔案——是的話就是 worktree)。
 */
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';

/** 這份程式碼所屬 repo 的主資料夾。不是 worktree(或根本不在 git 裡)就是它自己。 */
export function monitorHome(codeDir) {
  // 「家」可以用環境變數換掉——這是設定不是後門:測試要能在自己的暫存資料夾裡跑(gate.mjs 每回合都跑、
  // mount 的接點要指向有腳本的地方),真的也有人會想把資料放別處。hook.sh 看同一個變數,寫的跟讀的才是同一個家(老毛病 P2)。
  const forced = process.env.PIPELINE_MONITOR_HOME;
  if (forced) return forced;
  const dotGit = join(codeDir, '.git');
  // worktree 的 .git 是一個**檔案**(裡面寫 gitdir: …);主資料夾的 .git 是資料夾。
  // 只在是檔案時才問 git——主資料夾那條路完全不花錢。
  try { if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return codeDir; } catch { return codeDir; }
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'],
      { cwd: codeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return common ? dirname(resolve(codeDir, common)) : codeDir;
  } catch {
    return codeDir;   // 問不到就留在原地——至少不會指到一個不存在的地方
  }
}
