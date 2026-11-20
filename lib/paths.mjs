/**
 * paths.mjs —— 「程式在哪」跟「資料在哪」不准綁在一起（Antigravity 專用版）
 *
 * 資料一律住在固定的家 ~/.pipeline-monitor-agy/（logs/、checkpoints/、lang.json），
 * 與程式所在資料夾完全分離，也不碰原版 Claude 的 ~/.pipeline-monitor/。
 * 程式的主資料夾（codeHome）只給「要指向程式」的地方用：plugin 捷徑、專案級掛載、背景服務。
 *
 * 環境變數：
 *   AGY_PIPELINE_HOME      覆寫資料家目錄（預設 ~/.pipeline-monitor-agy）
 *   AGY_PIPELINE_LOG_DIR   覆寫紀錄資料夾（預設 <資料家>/logs）
 *   AGY_PIPELINE_CODE_HOME 只給測試：在 worktree 裡跑測試時指定程式位置
 */
import { existsSync, statSync, realpathSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 這支程式自己的資料夾（lib/ 的上一層）。 */
const CODE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** 資料的家底下的兩種資料夾。 */
export const KINDS = ['logs', 'checkpoints'];

/**
 * 這份程式碼所屬 repo 的主資料夾。不是 worktree（或不在 git 裡）就是它自己。
 * 只給「要指向程式」的地方用：worktree 是暫時的，刪掉之後指過去的 hook、捷徑、背景服務會靜默失效（L13）。
 */
export function codeHome(codeDir = CODE_DIR) {
  const forced = process.env.AGY_PIPELINE_CODE_HOME;
  if (forced) return forced;
  const dotGit = join(codeDir, '.git');
  try { if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return codeDir; } catch { return codeDir; }
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'],
      { cwd: codeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return common ? dirname(resolve(codeDir, common)) : codeDir;
  } catch {
    return codeDir;
  }
}

const real = (p) => { try { return realpathSync(p); } catch { return null; } };
let programDirs = null;
function isProgramDir(dir) {
  programDirs ??= [real(CODE_DIR), real(codeHome(CODE_DIR))].filter(Boolean);
  const r = real(dir);
  return r !== null && programDirs.includes(r);
}

/**
 * 資料的家：呼叫端給的資料夾（測試的暫存資料夾）> AGY_PIPELINE_HOME > ~/.pipeline-monitor-agy。
 * 程式自己的資料夾永遠不是資料的家。hook.sh 看同一個 AGY_PIPELINE_HOME（老毛病 P2）。
 */
export function dataHome(dir = CODE_DIR) {
  if (dir && !isProgramDir(dir)) return dir;
  return process.env.AGY_PIPELINE_HOME || join(homedir(), '.pipeline-monitor-agy');
}

/**
 * 現在該讀寫哪一個資料夾（kind: 'logs' | 'checkpoints'）。
 * AGY_PIPELINE_LOG_DIR 只管紀錄，跟 hook.sh 看同一個變數。
 */
export function dataDir(kind, dir = CODE_DIR) {
  if (kind === 'logs' && process.env.AGY_PIPELINE_LOG_DIR) return process.env.AGY_PIPELINE_LOG_DIR;
  return join(dataHome(dir), kind);
}

/** 寫之前把資料夾建起來。新建的只給擁有者讀寫（紀錄裡有使用者打的字）；已存在的不動原權限。 */
export function makeDataDir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
}

/** Antigravity 專用版從乾淨新家 ~/.pipeline-monitor-agy 起步，不搬舊資料，恆回 null。 */
export function moveState() {
  return null;
}
