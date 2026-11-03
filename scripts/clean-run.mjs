#!/usr/bin/env node
/**
 * clean-run.mjs —— 推上 GitHub 之前,在乾淨的副本跑一次全部測試(npm run test:clean;規格:主任動手收尾 AC-8,教訓 L24 與它的第二、三次)。
 * 本機全綠、GitHub 上紅的那幾次,都是測試偷偷用了這台電腦的環境(老毛病 P8)。所以這裡把學到的環境一次給齊:
 *   從存檔 clone 一份(不是這個資料夾本身:沒存的檔、紀錄、章都不跟過去)、空的家目錄、UTC 時區、清掉環境變數(Claude Code 的、PIPELINE_MONITOR_* 的)、
 *   不讀系統的 git 設定(GIT_CONFIG_NOSYSTEM:L24 第二次,預設分支在系統層)、短的暫存路徑(長路徑讓「六段同時截滿」那一條多出幾個字)。
 * 用法:npm run test:clean [-- <版本>]——不給版本就是這個資料夾現在的存檔(HEAD)。
 *   紅了:在快轉之前的 main 上再跑一次(npm run test:clean -- <那個版本>),紅的一樣(同一條、同樣的數字)是環境的事,不是這次改的。
 * 跑完把副本刪掉。離開碼跟 npm test 一樣;版本認不出來、clone 不了回 2(不是「紅了」,是根本沒跑)。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 跑測試用的環境:只給這幾個,其他一個都不沿用——這台電腦的家目錄、Claude Code 的變數、PIPELINE_MONITOR_HOME 都不跟過去(L24)。
 * PATH 只放 node 所在的資料夾與系統的幾個:jq、git、sh 都在那裡
 */
export function cleanEnv(home, execPath = process.execPath) {
  return {
    PATH: [dirname(execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home, TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1',
  };
}

/**
 * 從存檔 clone 一份到短的暫存路徑(tmp 底下;macOS 給的暫存資料夾很長),切到那個版本。回 {sha, base, copy}——base 用完由呼叫端刪。
 * 認不出版本、clone 不了 → 丟出去,訊息給人看(沒跑,不是紅了)。
 * ⚠️ 在 worktree 裡問 --git-common-dir 回的是絕對路徑,一般資料夾回的是相對路徑(.git)——用 resolve,不用 join:
 *    join 會把兩段硬接成一條不存在的路,在 worktree 裡一次都跑不起來(寫的時候真的跑一次才踩到;lib/git.mjs 的 gitContext 講過同一件事)
 */
export function cloneAt(root, ref = 'HEAD', { tmp = '/tmp' } = {}) {
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let sha;
  try { sha = git(['rev-parse', '--verify', `${ref}^{commit}`], root); } catch { throw new Error(`認不出版本「${ref}」`); }
  const common = resolve(root, git(['rev-parse', '--git-common-dir'], root));
  // 真實路徑:Mac 的 /tmp 是 /private/tmp 的捷徑,GitHub 的機器沒有——照真的那一個給,比對路徑的測試才跟那裡一樣
  const base = realpathSync(mkdtempSync(join(tmp, 'pmc-')));
  // 副本的資料夾照專案的名字取,跟 GitHub 的機器一樣(…/pipeline-monitor/pipeline-monitor):舊接法認「是不是我們的接點」看指令裡有沒有
  // pipeline-monitor 這幾個字(lib/mount.mjs 的 isOurs),資料夾叫別的名字,掛感測器那一支就紅一整片——第一次叫 repo,真的紅了(寫的時候踩到)
  const copy = join(base, basename(dirname(common)));
  try {
    git(['clone', '-q', common, copy], base);
    git(['checkout', '-q', '--detach', sha], copy);
  } catch (e) {
    rmSync(base, { recursive: true, force: true });
    throw new Error(`clone 不了（${String(e.stderr ?? e.message).trim().split('\n').at(-1)}）`);
  }
  return { sha, base, copy };
}

function main() {
  const ref = process.argv[2] ?? 'HEAD';
  let c;
  try { c = cloneAt(ROOT, ref); } catch (e) {
    console.log(`❌ ${e.message}——沒跑。`);
    return 2;
  }
  const { sha, base, copy } = c;
  const home = join(base, 'home');
  mkdirSync(home);
  try {
    const npm = existsSync(join(dirname(process.execPath), 'npm')) ? join(dirname(process.execPath), 'npm') : 'npm';
    console.log(`在乾淨的副本跑 npm test（${sha.slice(0, 7)}；空的家目錄、UTC、清掉環境變數、不讀系統的 git 設定）\n`);
    const r = spawnSync(npm, ['test'], { cwd: copy, env: cleanEnv(home), stdio: 'inherit' });
    const code = typeof r.status === 'number' ? r.status : 1;
    console.log(code === 0
      ? `\n乾淨副本（${sha.slice(0, 7)}）：npm test 全綠。`
      : `\n乾淨副本（${sha.slice(0, 7)}）：npm test 紅了（離開碼 ${code}），紅的那幾條在上面。在快轉之前的 main 上再跑一次比對：npm run test:clean -- <那個版本>`);
    return code;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const isMain = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? ''); } catch { return false; } })();
if (isMain) process.exit(main());
