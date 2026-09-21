#!/usr/bin/env node
/**
 * status.mjs —— 「我在哪、我回得去哪、這次動了多少」
 *
 * 規格：pipeline-status（路徑看 CLAUDE.md 的表；AC 編號在下面各段落標出）
 *
 * 這支程式最重要的性質是**它不准說謊**。所以整份程式碼裡沒有任何一句
 * 「確定能動」「應該沒問題」「太多了」——只有數字、時間戳，以及查不到時的「不知道」。
 *
 * ⚠️ 三個最容易犯的錯，都寫成註解釘在對應的地方了：
 *   1. 查不到 ≠ 沒有（A1）——`git()` 回 null 代表「沒問到」，呼叫端不准折成 false
 *   2. 檢查全綠 ≠ 功能正確（A2, AC-5）——文案永遠寫「檢查全綠」不寫「能動」
 *   3. 自己編門檻會讓工具變成狼來了（AC-7）——比例尺一律從這個專案自己的歷史算
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { appendFileSync } from 'node:fs';
import { readEvents, loadStages, lastRunPerStage, runsPerStage, roundView, editsOf, reportsIn, perStageOfRound, gateHeartbeat, safeName, logFileOf, specContext } from './lib/events.mjs';
import { readChecklist, locateSpec } from './lib/checklist.mjs';
import { buildTier, readTierConfig, writeTierConfig, proposeCodeArea, codeFileFn, gitCodeChanges } from './lib/tier.mjs';
import { monitorHome } from './lib/paths.mjs';
import { skillAvailable, commandFor, pluginName } from './lib/skills.mjs';
import { installService, uninstallService, restartService, describeService, openDashboard } from './lib/service.mjs';
import {
  mount, unmount, mountState, pluginState, installPlugin, uninstallPlugin, optIn, optOut, hookPathsIn,
} from './lib/mount.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 資料住在 repo 的主資料夾,不管這支程式是從哪個 worktree 跑的(lib/paths.mjs,2026-09-15 實測踩到)
const HOME_DIR = monitorHome(HERE);
const CHECKPOINT_DIR = join(HOME_DIR, 'checkpoints');
// 紀錄位置可以用環境變數換掉——跟 hook.sh 的 PIPELINE_MONITOR_LOG_DIR 是**同一個**變數。
// 寫的跟讀的必須看同一個地方,否則感測器記在 A、畫面去 B 找(老毛病 P2)。
const LOG_DIR = process.env.PIPELINE_MONITOR_LOG_DIR ?? join(HOME_DIR, 'logs');

/* ────────────────────────── git：查不到就回 null ──────────────────────────
 * ⚠️ A1。回 null 的唯一意思是「這次沒問到」，**不是**「答案是沒有」。
 * 呼叫端必須自己決定「沒問到」要怎麼講，不准預設折成 0／false／空陣列。 */
function git(args, cwd) {
  try {
    // ⚠️ core.quotepath=false:git 預設會把非 ASCII 檔名轉義成 "\350\246\217..." 這種東西。
    // 這個專案的資料夾叫「規劃中」「進行中」——不關掉的話,畫面上會出現一串八進位碼,
    // 而讀的人不是工程師。這跟 L7(null 漏到畫面上)是同一族:程式的內部表示不該外流。
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** 真實路徑;解析不了(不存在)就原樣回去。 */
function real(p) {
  try { return realpathSync(p); } catch { return p; }
}

/** 這是不是一個 git 專案（AC-10：不是也不准當機） */
function gitContext(cwd) {
  const commonDir = git(['rev-parse', '--git-common-dir'], cwd);
  if (commonDir === null) return { isGit: false };

  // 專案身分用 --git-common-dir：worktree 會解析到主 repo 的 .git，
  // 所以三個 worktree 算同一個專案（它們本來就是）。
  const root = git(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
  // ⚠️ 一般 repo 的 --git-common-dir 回的是**相對路徑**,而且是相對於**執行的位置**,不是專案根目錄:
  // 在根目錄跑是 '.git',在 src/ 裡跑是 '../.git'。第一版把它接在 root 後面,從子資料夾跑就變成
  // 上一層的名字(「TutorPod AI v4」,2026-09-11 實測,誠實修補 C2)。只有 worktree 才回絕對路徑。
  // 解析完再走一次 realpath:root 是 git 給的真實路徑,兩邊拼法要一致,mountState 才分得出「這裡」跟「主資料夾」。
  const absCommon = real(resolve(cwd, commonDir));
  const head = git(['rev-parse', 'HEAD'], cwd);          // null = 一個 commit 都還沒有
  // ⚠️ 一個 commit 都沒有時 `rev-parse --abbrev-ref HEAD` 會失敗 → 我們回 null,
  // 而 null 直接印到畫面上就是「━━ empty · null ━━」。實測踩到。
  // symbolic-ref 在零 commit 時仍答得出 HEAD 指向哪條分支,拿它當備援。
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    ?? git(['symbolic-ref', '--short', 'HEAD'], cwd)
    ?? '(還沒有分支)';
  return {
    isGit: true,
    root,
    mainRoot: dirname(absCommon),   // worktree 所屬的主資料夾;不是 worktree 的話就是 root 自己
    project: basename(dirname(absCommon)) || basename(root),
    head,
    // detached HEAD 時 branch 會是 'HEAD'——那是狀態不是名字，照實說
    branch: branch === 'HEAD' ? '(detached HEAD)' : branch,
    hasCommits: head !== null,
  };
}

/* ────────────────────────── 章（AC-1 / AC-4 / AC-6） ────────────────────────── */

function checkpointPath(ctx) {
  // 跟紀錄檔同一條規則(safeName)。網頁拿紀錄檔名跟章檔名對專案——規則不同,中文名的專案就變兩張卡(誠實修補 C3)
  return join(CHECKPOINT_DIR, `${safeName(ctx.project)}__${safeName(ctx.branch)}.json`);
}

function readCheckpoint(ctx) {
  const p = checkpointPath(ctx);
  if (!existsSync(p)) return null;              // AC-4：不存在 = 還不知道，不是「沒綠過」
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** ⚠️ AC-6：這裡跟感測器**刻意相反**——寫不進去要大聲。
 *  「我以為我有退路，其實沒有」會在最需要的時候害到人。 */
function writeCheckpoint(ctx, data) {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  writeFileSync(checkpointPath(ctx), JSON.stringify(data, null, 2));
}

/* ────────────────────────── 要跑哪幾項檢查 ──────────────────────────
 * ⚠️ AC-10 可攜性：不准寫死 TutorPod 的四項。
 * 從專案自己的 package.json scripts 認，認不到就說認不到。 */
const CANDIDATE_SCRIPTS = ['lint', 'test', 'test:unit', 'build'];

function detectChecks(root) {
  const p = join(root, 'package.json');
  if (!existsSync(p)) return null;              // 不是 npm 專案 → 沒問到，不是「沒有檢查」
  try {
    const scripts = JSON.parse(readFileSync(p, 'utf8')).scripts ?? {};
    const found = CANDIDATE_SCRIPTS.filter((s) => scripts[s]);
    return found.length ? found : null;
  } catch {
    return null;
  }
}

/* ────────────────────────── 改動體檢（AC-7 / AC-8） ────────────────────────── */

/** 這個專案「平常改幾個檔案」——比例尺從自己的歷史算，不自己編門檻（AC-7）。 */
function changeScale(cwd, sample = 30) {
  const out = git(['log', '-n', String(sample), '--format=%h', '--name-only'], cwd);
  if (out === null) return null;
  const counts = [];
  let n = 0;
  for (const line of out.split('\n')) {
    if (/^[0-9a-f]{7,}$/.test(line.trim())) { if (n) counts.push(n); n = 0; }
    else if (line.trim()) n++;
  }
  if (n) counts.push(n);
  // ⚠️ 兩三個 commit 算出來的「平常」是雜訊不是基準。
  // 寧可不給比例尺,也不要給一個看起來有依據的假數字（AC-7 的精神）。
  if (counts.length < 5) return null;
  counts.sort((a, b) => a - b);
  return { median: counts[Math.floor(counts.length / 2)], max: counts[counts.length - 1], sample: counts.length };
}

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./;

/** package.json 的相依名稱集合。讀不到就回空集合——呼叫端只拿它做「新增了什麼」的差集,
 *  讀不到時差集是空的,不會憑空報出新相依（A1:沒問到不要變成一個答案）。 */
function readDeps(text) {
  if (!text) return new Set();
  try {
    const j = JSON.parse(text);
    return new Set([...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}

function changeHealth(cwd, since) {
  // ⚠️ 基準只在這裡決定一次:有章比章,沒章比上一次存檔(HEAD)。
  // 沒帶 HEAD 的 `git diff` 只看得到「還沒 git add」的改動——add 過的整個消失,
  // 畫面會同時寫「2 個檔案還沒存進保險箱」和「沒有改動」(2026-09-11 實測,老毛病 P1)。
  const base = since ?? 'HEAD';
  const stat = git(['diff', '--shortstat', base], cwd);
  const names = git(['diff', '--name-only', base], cwd);
  // ⚠️ AC-8：只認「被修改」的既有測試（M），不認新增（A）。
  // 寫新功能順便補新測試是好事,天天為它跳警告會讓人關掉這個工具。
  const modifiedTests = git(['diff', '--diff-filter=M', '--name-only', base], cwd);
  // ⚠️ 不要用 diff 的 `+"lodash": "^4"` 去比對——那**假設 package.json 是一行一個相依**。
  // 壓成一行的 package.json 就完全認不到,而且是安靜地認不到。直接解析兩邊的鍵。
  // ⚠️ 這裡本來寫成 `since ? ... : depsNow`——沒有還原點的時候拿自己跟自己比,
  // 差集永遠是空的,**新增的相依一輩子不會被報出來**。測試抓到的。
  // 沒有還原點時,「改動」的基準是 HEAD(＝還沒 commit 的東西),不是工作區自己。
  const pkgPath = join(cwd, 'package.json');
  const depsNow = readDeps(existsSync(pkgPath) ? readFileSync(pkgPath, 'utf8') : null);
  const depsBefore = readDeps(git(['show', `${since ?? 'HEAD'}:package.json`], cwd));

  // ⚠️ `git diff` **看不到還沒被 git 追蹤的新檔案**。
  // AI 生成最常見的產物就是新檔案,漏掉它們會讓改動看起來比實際小——
  // 而「看起來比較安全」正是最危險的錯誤方向。實測抓到:4 個檔案被報成 2 個。
  const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd);
  const newDeps = [...depsNow].filter((d) => !depsBefore.has(d));   // 只算新增的,移除不算債務
  const tests = modifiedTests ? modifiedTests.split('\n').filter((f) => f && TEST_FILE.test(f)) : [];
  // ⚠️ 問不到就是 null,不是 0(R1)。呼叫端要說「問不到改動」,不准印成「沒有改動」。
  if (names === null || untracked === null) {
    return { files: null, newFiles: null, list: null, touchedTests: null, added: null, removed: null, modifiedTests: tests, newDeps };
  }
  const newList = untracked.split('\n').filter(Boolean);
  // 這次動到的每一個檔案(已追蹤的 diff ＋ 新檔案)。分級只看這份清單落在哪裡(lib/tier.mjs)。
  const list = [...new Set([...names.split('\n').filter(Boolean), ...newList])];
  const newFiles = newList.length;
  const files = names.split('\n').filter(Boolean).length + newFiles;
  // 「補測試」要的是這次有沒有**新增或修改**任何測試檔(A 或 M,含還沒追蹤的)——跟只認 M 的 modifiedTests 不同
  const touchedTests = list.filter((f) => TEST_FILE.test(f)).length;
  // ⚠️ 加減分開讀。只刪不加時 shortstat 沒有「insertion」字樣,
  // 兩個塞在同一條規則裡就整個對不上,印成 +0 −0(2026-09-11 實測)。
  const added = stat === null ? null : Number(stat.match(/(\d+) insertion/)?.[1] ?? 0);
  const removed = stat === null ? null : Number(stat.match(/(\d+) deletion/)?.[1] ?? 0);
  return { files, newFiles, list, touchedTests, added, removed, modifiedTests: tests, newDeps };
}

/* ────────────────────────── 小工具 ────────────────────────── */

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '時間對不上';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小時前`;
  return `${Math.round(h / 24)} 天前`;
}

/** 還沒存進保險箱(commit)的檔案有幾個。**這是唯一的一份算法**,網頁那層也用它(老毛病 P2)。
 *  ⚠️ `-uall`:少了它,一個新資料夾不管裡面有幾個檔案都只算 1 行——
 *  「回去會丟掉 1 個檔案」實際是 3 個(2026-09-11 實測),而同畫面另一個數字用 ls-files 算會說 3。 */
function uncommitted(cwd) {
  const out = git(['status', '--porcelain', '-uall'], cwd);
  if (out === null) return null;                 // 沒問到
  return out.split('\n').filter(Boolean).length;
}

/** 還沒存進保險箱的**是哪些檔案**(路徑)。問不到回 null。
 *  ⚠️ 不能走 git():它會 trim(),而 porcelain 第一行的開頭就是一個空白（" M a.js"）——
 *     trim 掉之後路徑就切錯位,第一個檔案永遠標不到(2026-09-15 測試抓到)。 */
function dirtyPaths(cwd) {
  let raw;
  try {
    raw = execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  return new Set(raw.split('\n').filter((l) => l.length > 3).map((l) => {
    const p = l.slice(3);
    // 改名的一行長 "R  舊 -> 新",要的是新的那個
    return p.includes(' -> ') ? p.split(' -> ').pop() : p;
  }));
}

/** 跟 git() 一樣,但回的是**離開碼**——有些問題 git 是用離開碼回答的
 *  (`merge-base --is-ancestor`:0 是、1 不是、其他是「問不到」)。回 null = 跑不起來。 */
function gitExit(args, cwd) {
  try {
    execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : null;
  }
}

/**
 * 章指的版本,跟現在的 HEAD 是什麼關係(L14)。
 * ⚠️ 章只有在「它指的版本還在目前這條分支的歷史上」才算數。
 *    歷史被改寫過(2026-09-10 清掉被 commit 的紀錄時就發生了)之後,舊的 SHA 還在倉庫裡,
 *    `git diff <章>` 照樣算得出數字——畫面看起來完全正常,回去的指令卻會把人帶到另一條歷史。
 *    整整一天都這樣顯示,沒有任何徵兆。
 * @returns {{state:'ok', commitsAfter:number} | {state:'off-branch'|'gone'|'unknown'}}
 *   四種刻意分開,呼叫端不准折成布林;**只有 'ok' 才准給回去的指令**。
 */
function checkpointRelation(cwd, commit) {
  const exists = gitExit(['rev-parse', '--verify', '-q', `${commit}^{commit}`], cwd);
  if (exists === 1) return { state: 'gone' };
  if (exists !== 0) return { state: 'unknown' };
  const anc = gitExit(['merge-base', '--is-ancestor', commit, 'HEAD'], cwd);
  if (anc === 1) return { state: 'off-branch' };
  if (anc !== 0) return { state: 'unknown' };
  // ⚠️ 先看 null 再轉數字:Number(null) 是 0,會把「問不到」變成「之後 0 次存檔」。
  const out = git(['rev-list', '--count', `${commit}..HEAD`], cwd);
  if (out === null || !/^\d+$/.test(out)) return { state: 'unknown' };
  return { state: 'ok', commitsAfter: Number(out) };
}

/** 備份分支的名字。只求看得懂、同一分鐘內不重複;git 對中文分支名沒意見。 */
function backupBranchName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `備份-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** 怎麼回去(AC-3):先講會失去什麼、想留著先打什麼,**指令一定放最後**。 */
function restoreAdvice({ commit, commitsAfter = 0, dirty = 0, now = new Date() }) {
  const L = [''];
  let warned = false;
  if (commitsAfter > 0) {
    // ⚠️ L14:reset 會把章之後的存檔從分支上拿掉。git 其實還留著,但要工程師才救得回來——
    //    對這個工具的使用者來說等於沒了。所以先留一條備份分支,跟 stash 那步同一個節奏。
    L.push(`   ⚠️ 回去會丟掉蓋章之後的 ${commitsAfter} 次存檔(commit)。想留著先打：`);
    L.push(`        git branch ${backupBranchName(now)}`);
    warned = true;
  }
  if (dirty === null) {
    // R1:問不到 ≠ 沒有。不知道有沒有沒存的東西,就當成有。
    L.push('   ⚠️ 問不到你有沒有還沒存的檔案。保險起見先打：');
    L.push('        git stash push -u -m 我的備份');
    warned = true;
  } else if (dirty > 0) {
    L.push(`   ⚠️ 回去${warned ? '也' : ''}會丟掉你還沒存的 ${dirty} 個檔案。想留著先打：`);
    L.push('        git stash push -u -m 我的備份');
    warned = true;
  }
  L.push(warned ? '      確定要回去：' : '      要回到那個版本：');
  L.push(`        git reset --hard ${commit.slice(0, 7)}`);
  return L;
}

/**
 * 還原點那一段的文案(AC-2／AC-3／AC-4／AC-5／L14)。純函式,一行一個字串——
 * 因為這是整支程式**唯一會給出破壞性指令**的地方,所以抽出來讓 scripts/status.test.mjs 釘住:
 * 章不能用的時候,輸出裡不准出現 `reset --hard`。
 * @param files 蓋章之後改了幾個檔案;null = 問不到
 */
function describeCheckpoint({ cp, rel, dirty, files, now = new Date() }) {
  const L = [];
  const short = cp.commit.slice(0, 7);

  if (rel.state !== 'ok') {
    L.push(`⚠️ 有一個還原點（${short}，${ago(cp.at)}，${cp.checks.join(' / ')} 全綠），但它已經失效：`);
    if (rel.state === 'gone') L.push('   它指的版本已經不存在了。');
    else if (rel.state === 'off-branch') {
      L.push('   它指的版本不在目前這條分支的歷史上（歷史被改寫過，或分支換過）。');
      L.push('   照它回去會跳到另一條歷史，所以這次不給回去的指令。');
    } else {
      L.push('   問不到它跟現在的版本是什麼關係。為了不亂給指令，這次不給。');
    }
    L.push('', '   重新蓋一個：  pipeline-status --checkpoint');
    if (dirty === null) L.push('', '   ⚠️ 另外:問不到你有幾個檔案還沒存進保險箱(git commit)。');
    else if (dirty) L.push('', `   ⚠️ 另外:你有 ${dirty} 個檔案還沒存進保險箱(git commit)。`);
    return L;
  }

  // AC-5：永遠寫「檢查全綠」,永遠不寫「確定能動」
  L.push(`🟢 最後一次檢查全綠：${short}（${ago(cp.at)}）`);
  L.push(`   通過的是：${cp.checks.join(' / ')}`);
  L.push('   ⚠️ 檢查全綠不等於功能正確——測試沒測到的地方它不知道。');

  if (files === null) L.push('', '   ⚠️ 問不到「蓋章之後改了什麼」。');
  else if (files > 0) {
    L.push('', `   ⚠️ 之後有 ${files} 個檔案被改過,這 ${files} 個沒有被檢查過。`);
    if (rel.commitsAfter) L.push(`   其中包含蓋章之後的 ${rel.commitsAfter} 次存檔(commit)。`);
  }
  else if (rel.commitsAfter) L.push('', `   ⚠️ 蓋章之後存了 ${rel.commitsAfter} 次,但現在的檔案內容跟章一模一樣。`);
  else L.push('', '   ✅ 蓋章之後沒有任何檔案被改過。');

  if (dirty === null) L.push('   ⚠️ 問不到有幾個還沒存進保險箱(git commit)。');
  else if (dirty) L.push(`   ⚠️ 其中 ${dirty} 個還沒存進保險箱(git commit)。`);

  if (files || rel.commitsAfter) {
    L.push(...restoreAdvice({ commit: cp.commit, commitsAfter: rel.commitsAfter, dirty, now }));
  }
  return L;
}

/**
 * 感測器那一行(誠實修補 D)。純函式,兩件事**分開講**:
 *   「掛在哪」看設定檔(mountState),「活著嗎」看紀錄(lastSeen = 最後一筆來自這個工作區的事件)。
 * ⚠️ 設定裡找不到、紀錄裡卻有——那就是在記(2026-09-11 這個 worktree 就是這樣)。
 *    證據在手上的時候,不准說「沒掛上」(R1)。證據跟設定打架時,證據贏。
 * @param lastSeen ISO 時間,或 null
 */
function describeSensor({ mount, lastSeen }) {
  const L = [];
  const seen = lastSeen ? `最後一筆來自這裡的紀錄：${ago(lastSeen)}` : null;
  if (mount.state === 'off' && mount.optedOut) {
    // 人自己按的退出。照實說「退出了」,不說「沒掛上」——那是兩件事
    L.push(`感測器：這個專案已退出記錄（${mount.optedOut.at ? ago(mount.optedOut.at) : '時間不明'}）,之前的紀錄還在。`);
    if (seen) L.push(`         ${seen}`);
    L.push('         重新加入：pipeline-status --on,或儀表板的「重新加入記錄」按鈕');
  } else if (mount.state === 'broken') {
    // ⚠️ 這一種最危險:設定看起來好好的,但它指向的檔案不見了,而 hook 永遠靜默,紀錄只是安靜地停止增加。
    L.push('感測器：🔴 掛著,但它指向的檔案不存在——**紀錄已經停了,而且不會有任何徵兆**');
    for (const p of mount.paths) L.push(`         找不到：${p}`);
    if (seen) L.push(`         ${seen}——從那之後就沒有了`);
    L.push(mount.where === 'plugin'
      ? '         修法：把 pipeline-monitor 資料夾放回去,或在它現在的位置跑 pipeline-status --install'
      : '         修法：pipeline-status --on（會重新指到正確的位置）');
  } else if (mount.state === 'ok') {
    const where = mount.where === 'plugin' ? '（plugin,每個專案都會記）'
      : mount.where === 'main' ? '（用的是主資料夾的設定）'
      : mount.where === 'user' ? '（用的是你帳號層級的設定）' : '';
    L.push(`感測器：已掛上${where}`);
    L.push(`         ${seen ?? '還沒有來自這裡的紀錄（設定是對話開始時讀的,掛上之後要開新的對話才會開始記）'}`);
    if (mount.alsoLegacy) L.push('         ⚠️ 這個專案的設定檔裡還有舊的接法,會記兩次。拆掉：pipeline-status --on');
  } else if (seen) {
    L.push(`感測器：設定裡找不到,但 ${ago(lastSeen)}還有來自這裡的紀錄——它在記,只是我不知道是哪份設定在做。`);
  } else {
    L.push('感測器：沒掛上（打 pipeline-status --on 掛上）');
  }
  L.push('');
  return L;
}

/**
 * 檢查跑失敗時要講什麼(誠實修補 E2)。純函式。
 * ⚠️ 「紅」有兩種:跑了沒過、根本沒跑起來。混在一起講成「沒過,修好再跑」,
 *    使用者會去修一個根本沒被檢查的東西——那是 R2 的鏡像。
 * @param fail {status, code, stderr, stdout}  runCheck() 失敗時回的東西
 */
function describeCheckFailure(script, fail) {
  const L = [];
  if (fail.code === 'ENOENT') {
    L.push(`\n❌ ${script} 跑不起來：找不到 npm。這不是「沒過」,是根本沒跑。`);
  } else if (fail.status === 127) {
    L.push(`\n❌ ${script} 跑不起來：它要用的指令找不到（通常是工具沒裝,先 npm install）。這不是「沒過」,是根本沒跑。`);
  } else {
    L.push(`\n❌ ${script} 跑了,沒過。不蓋章。`);
  }
  // 檢查工具自己的輸出——那是 npm／測試工具說的話,不是程式內部值;使用者要拿它去問 Claude。只給最後幾行。
  const tail = (fail.stderr.trim() || fail.stdout.trim()).split('\n').filter(Boolean).slice(-6);
  if (tail.length) {
    L.push('   它自己說的最後幾行（拿去問 Claude）：');
    for (const t of tail) L.push(`      │ ${t.slice(0, 160)}`);
  } else {
    L.push('   （它什麼都沒說。）');
  }
  L.push('   修好再跑一次。');
  return L;
}

export {
  git, gitContext, changeScale, changeHealth, detectChecks, ago, TEST_FILE,
  uncommitted, dirtyPaths, checkpointRelation, backupBranchName, restoreAdvice, describeCheckpoint,
  describeSensor, describeCheckFailure, describeTier,
};

/* ══════════════════════════ 蓋章：--checkpoint（AC-1） ══════════════════════════ */

/** 跑一項檢查。成功回 null;失敗回離開碼與輸出,讓 describeCheckFailure() 分辨「沒過」跟「沒跑起來」。 */
function runCheck(cwd, script) {
  try {
    execFileSync('npm', ['run', '--silent', script],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return null;
  } catch (e) {
    return {
      status: typeof e.status === 'number' ? e.status : null,
      code: e.code ?? null,
      stderr: String(e.stderr ?? ''),
      stdout: String(e.stdout ?? ''),
    };
  }
}

/** ⚠️ 這裡是整支程式最容易寫出假綠勾的地方。
 *  「檢查全綠」講的是**當下工作區**的狀態；章要蓋在**某個 commit** 上。
 *  工作區是髒的時候,這兩者不是同一份東西——蓋下去就是在說謊。 */
function doCheckpoint(ctx) {
  if (!ctx.hasCommits) {
    console.log('這個專案還沒有任何 commit,沒有東西可以蓋章。先 git commit 一次。');
    return 1;
  }
  const dirty = uncommitted(ctx.root);
  if (dirty === null) {
    console.log('⚠️ 問不到工作區狀態,為了不亂蓋章,這次不蓋。');   // A1：沒問到 ≠ 乾淨
    return 1;
  }
  if (dirty > 0) {
    console.log(`⚠️ 你有 ${dirty} 個檔案還沒 commit。`);
    console.log('   檢查跑出來的綠是「你桌上這一份」的綠,不屬於任何一個存檔點——');
    console.log('   現在蓋章等於把綠掛在一個沒被測過的版本上。');
    console.log('\n   先存檔再蓋章：  git add -A && git commit -m "你的訊息"');
    return 1;
  }

  const checks = detectChecks(ctx.root);
  if (!checks) {
    console.log('認不出這個專案要跑哪些檢查（找不到 package.json 或裡面沒有 lint/test/build）。');
    console.log('⚠️ 這是「我沒問到」,不是「這個專案沒有檢查」。');
    return 1;
  }

  console.log(`在 ${ctx.branch} 上跑 ${checks.length} 項檢查,全綠才蓋章：\n`);
  const passed = [];
  for (const s of checks) {
    process.stdout.write(`   ${s} … `);
    const fail = runCheck(ctx.root, s);
    if (!fail) { console.log('綠'); passed.push(s); continue; }
    console.log('紅');
    // ⚠️ E2:「沒跑起來」跟「跑了沒過」要分開講,而且要把檢查自己說的話給出來
    for (const line of describeCheckFailure(s, fail)) console.log(line);
    return 1;
  }

  try {
    writeCheckpoint(ctx, {
      commit: ctx.head, branch: ctx.branch, worktree: ctx.root,
      at: new Date().toISOString(), checks: passed,
    });
  } catch (e) {
    // ⚠️ AC-6：跟感測器相反,這裡不准安靜。
    console.log(`\n❌ 章沒蓋成功：${e.message}`);
    console.log('   ⚠️ 你**沒有**還原點。不要以為有。');
    return 1;
  }
  console.log(`\n🟢 蓋章完成：${ctx.head.slice(0, 7)}（${passed.join(' / ')} 全綠）`);
  return 0;
}

/* ══════════════════════════ 畫面 ══════════════════════════ */

/** 標題＋感測器那一行。零 commit 的路徑跟正常路徑都要它——以前抄了兩份,各自過期(老毛病 P2)。 */
/** 收工 hook 活著沒:看心跳檔,不看設定(L13:「掛著」不等於「活著」)。 */
function describeGate(logDir = LOG_DIR) {
  const hb = gateHeartbeat(logDir);
  if (!hb?.ts) return '收工 hook：還沒跑過（裝好 plugin 之後要開新對話;一直沒跑就是它沒被觸發,不是沒事）';
  return `收工 hook：最後一次跑 ${ago(hb.ts)}`;
}

function renderSensor(ctx, ev) {
  console.log(`━━ ${ctx.project} · ${ctx.branch} ━━`);
  const mine = ev.events.filter((e) => e.cwd === ctx.root).map((e) => e.ts).filter(Boolean).sort();
  const lines = describeSensor({ mount: mountState(ctx.root, ctx.mainRoot), lastSeen: mine.at(-1) ?? null });
  for (const line of lines) console.log(line);
  console.log(`         ${describeGate()}`);
}

/** 還原點與改動的事實,一次算好。畫面(render)與分級(--tier)都吃這一份——兩邊才不會各算各的(老毛病 P2)。 */
function gatherChange(ctx) {
  const cp = readCheckpoint(ctx);
  const dirty = uncommitted(ctx.root);
  // ⚠️ L14:章只有在它指的版本還在這條分支的歷史上時才算數,詳見 checkpointRelation()。
  const rel = cp ? checkpointRelation(ctx.root, cp.commit) : null;
  const cpUsable = rel?.state === 'ok';
  // 改動的基準只在這裡決定一次,下面全部沿用:章能用就比章,不能用就比上一次存檔(HEAD)。
  // 以前這裡算了兩次(一次給還原點那段、一次給改動體檢),兩個數字有機會不一樣(老毛病 P2)。
  const since = cpUsable ? cp.commit : undefined;
  return { cp, dirty, rel, cpUsable, since, h: changeHealth(ctx.root, since) };
}

function render(ctx, ev, info) {
  renderSensor(ctx, ev);
  const { cp, dirty, rel, cpUsable, since, h } = info;

  /* ── 還原點（AC-2 / AC-3 / AC-4 / AC-5 / L14） ── */
  if (!cp) {
    // AC-4：說「還不知道」,不說「你沒有能動的版本」
    console.log('🔍 還沒有還原點——這個工具還沒看過你跑檢查,所以**還不知道**哪個版本是綠的。');
    console.log('   （這不代表你沒有好版本,只代表我沒問到。）');
    console.log('\n   建立第一個：  pipeline-status --checkpoint');
    // AC-5 的「還沒進保險箱」跟有沒有章無關——沒章的時候一樣該講。
    if (dirty === null) console.log('\n   ⚠️ 另外:問不到你有幾個檔案還沒存進保險箱(git commit)。');
    else if (dirty) console.log(`\n   ⚠️ 另外:你有 ${dirty} 個檔案還沒存進保險箱(git commit)。`);
  } else {
    // 文案在 describeCheckpoint():純函式,被測試釘住「章不能用時不准出現 reset --hard」
    for (const line of describeCheckpoint({ cp, rel, dirty, files: h.files })) console.log(line);
  }

  /* ── 改動體檢（AC-7 / AC-8）：只報數字,不下判斷 ── */
  const scale = changeScale(ctx.root);
  console.log(`\n━━ ${since ? '蓋章之後的改動' : '尚未提交的改動'} ━━`);
  if (cp && !cpUsable) console.log('   （章失效了,所以這裡比的是上一次存檔,不是章。）');
  if (h.files === null) {
    console.log('   問不到改動。');                // R1:沒問到 ≠ 沒有改動
  } else if (!h.files) {
    console.log('   沒有改動。');
  } else {
    console.log(`   ${h.files} 個檔案${h.newFiles ? `(其中 ${h.newFiles} 個是新檔案)` : ''}`);
    // 新檔案還沒被 git 追蹤,算不出增減行數。照實說涵蓋範圍,不要給一個看起來完整的假總數。
    if (h.added === null) console.log('   已存在的檔案:行數問不到');
    else console.log(`   已存在的檔案:+${h.added} −${h.removed} 行`);
    // ⚠️ AC-7：比例尺來自這個專案自己的歷史。沒有「太多」這種話。
    if (scale) console.log(`   （這個專案平常 ${scale.median} 個檔案,最多到過 ${scale.max} 個）`);
    if (h.newDeps.length) {
      console.log(`   ⚠️ 新增相依 ${h.newDeps.length} 個：${h.newDeps.join(', ')}`);
      console.log('      （每一個都是以後都要跟著你的東西,裝的時候只花三秒。）');
    }
    if (h.modifiedTests.length) {
      console.log(`   ⚠️ 這次動到 ${h.modifiedTests.length} 個**既有**的測試檔：`);
      for (const f of h.modifiedTests.slice(0, 5)) console.log(`        ${f}`);
      console.log('      （新增測試不會列在這裡。既有測試被改,值得你確認一下是不是');
      console.log('        程式沒過測試、於是測試被改成配合程式。）');
    }
  }
  return 0;
}

/* ══════════════════════════ 關卡（需要感測器） ══════════════════════════ */

/** 五關的事實,一次算好:關卡清單、每關最後一次紀錄、人蓋的結案。五關那段與分級那段共用。 */
function stageFacts(ctx, ev, info = {}) {
  const { stages } = loadStages(HERE, ctx.root, ctx.mainRoot);
  const { sawAnyEventHere } = lastRunPerStage(ev.events, stages, ctx.root);
  // 人蓋的「結案」事件(AC-9)。source:'human' 是刻意標的——
  // 它跟感測器觀察到的事實不同級,永遠不要混在一起。
  const cleared = new Map();
  for (const e of ev.events) {
    if (e.event === 'stage_cleared' && e.cwd === ctx.root) cleared.set(e.stage, e);
  }
  // Claude 記的結論(stage_report,source:claude)也按工作區記;「程式檔」的判斷跟分級同一份
  const reports = reportsIn(ev.events, (e) => e.cwd === ctx.root);
  const cfg = readTierConfig(ctx.root, ctx.mainRoot, HERE);
  const isCode = codeFileFn(ctx.root, cfg.state === 'ok' ? cfg.config : null);
  const edits = editsOf(ev.events, (e) => e.cwd === ctx.root);
  // 這一輪跑到哪:五關、分級的「需要」、收工 hook 都吃這一份(老毛病 P2)。B 的證據除了感測器,還有 git 說改了的檔案的修改時間(L8)
  const runs = runsPerStage(ev.events, stages, (e) => e.cwd === ctx.root);
  const cpAt = info.cpUsable ? info.cp?.at ?? null : null;
  // 規格連結(施工對話認規格):Claude 跑的(拿得到對話代號,而且這個對話在這裡動過)→ 用這個對話的連結,跟 --spec、收工 hook 同一個代號來源;
  // 人自己在終端機跑拿不到 → 工作區層級,這個工作區只有一個對話在動時等於它(lib/events.mjs 的 specContext)。
  // ⚠️ 以前一律用工作區層級:worktree 只要來過別的對話,剛記了連結的 Claude 自己一看就是「A 沒有紀錄」(魔鬼教官 2026-09-21,老毛病 P2)
  const sid = sessionFromEnv();
  const mine = sid && ev.events.some((e) => e.cwd === ctx.root && e.session === sid) ? sid : null;
  const view = roundView({
    runs, stages, cleared, reports, edits, isCode, cpAt,
    gitChanges: (since) => gitCodeChanges(ctx.root, info.h?.list ?? null, isCode, { since }),
    spec: specContext(ev.events, { cwd: ctx.root, cpAt, session: mine }), root: ctx.root, mainRoot: ctx.mainRoot,
  });
  return { stages, perStage: perStageOfRound(view), cleared, reports, view, sawAnyEventHere };
}

function renderStages(ctx, ev, facts, info = {}) {
  const { stages, perStage, cleared, sawAnyEventHere } = facts;
  if (!stages.length) return;

  const { state, events, broken } = ev;
  console.log('\n━━ 五關 ━━');

  // ⚠️ AC-1／AC-7:三種「看起來一樣」的情況必須分開講。
  if (state === 'no-file') {
    console.log('   🔍 這個專案還沒有任何感測器紀錄。');
    console.log('      可能是還沒裝感測器,也可能是裝了還沒跑過任何指令——**這兩種我分不出來**,');
    console.log('      所以不會說「五關都沒跑」。');
    return;
  }
  if (state === 'no-events') {
    console.log('   ⚠️ 感測器可能沒在運作:紀錄檔存在,但裡面沒有東西。');
    if (broken.length) console.log(`      感測器自己回報過 ${broken.length} 次故障。`);
    console.log('      ⚠️ 這**不是**「五關都沒跑」——是我沒問到。');
    return;
  }
  // ⚠️ D2:故障記號是全機一份,而且只代表「那幾次沒記到」。以前它一出現就把整區蓋成
  //    「紀錄檔裡沒有東西」,幾千筆紀錄也一樣。現在降成一行警告,紀錄照畫。
  if (broken.length) {
    const last = broken.map((b) => b.ts).filter(Boolean).sort().at(-1);
    console.log(`   ⚠️ 感測器回報過 ${broken.length} 次故障${last ? `（最近一次 ${ago(last)}）` : ''},那段期間可能有漏記。`);
  }

  // ⚠️ 感測器**有一個開始的日期**。在那之前跑過的事情它一輩子都不會知道。
  // 把那段期間講成「沒跑過」就是 A1:把「沒問到」編碼成「答案是沒有」。
  // 實測就是這樣抓到的:/spec 今天稍早真的跑過,但感測器是之後才裝的,
  // 畫面卻理直氣壯寫著「A 沒跑過」。
  const firstTs = events.filter((e) => e.cwd === ctx.root).map((e) => e.ts).sort()[0];
  if (!sawAnyEventHere) {
    console.log('   🔍 有紀錄,但沒有一筆來自這個 worktree。');
    console.log(`      （目前在 ${ctx.branch}）`);
    return;
  }

  // 這一輪跑到哪(lib/events.mjs 的 roundView):分界是最近一次第一關、或蓋章,取較晚的
  // 這一輪跑到哪:stageFacts 算好的那一份(五關、分級、收工 hook 共用)
  const view = facts.view;
  if (view.roundStart) console.log(`   （這一輪從 ${ago(view.roundStart)}開始算：最近一次第一關、或蓋章）`);
  for (const st of view.stages) {
    const label = `${st.id} ${st.name}`.padEnd(10, '　');
    // B(對話本身):改到程式檔就算在動;最後一次改檔的時間要印出來。不數檔案——數量在改動體檢那段(git)
    if (st.type === 'main-conversation' && st.state !== 'main') {
      const cl = st.checklist;
      const prog = cl?.parsed ? `清單${cl.batch ? '這一批' : ''} ${cl.checked}/${cl.total} 對過${cl.pending ? `,${cl.pending} 條待討論` : ''}${cl.unmarked ? `,${cl.unmarked} 條還沒對` : ''}` : null;
      const viaNote = st.via === 'git' ? '（感測器沒看到改檔,是 git 說的——可能是用 Bash 寫的）' : '';
      const extra = cl?.batchMissing?.length || cl?.preMarked ? `；${checklistWhy(cl)}` : '';
      console.log(st.state === 'current' ? `   ${label} ⏸ 最後一次改程式檔 ${ago(st.ranAt)}${viaNote}——現在在這一關${prog ? `（${prog}${extra}）` : ''}`
        : st.state === 'stale' ? `   ${label} 🔁 改過程式檔（最後一次 ${ago(st.ranAt)}）,${prog}——${checklistWhy(cl)},不算寫完`
        : st.state === 'done' ? `   ${label} ✅ 改過程式檔（最後一次 ${ago(st.ranAt)}）,${ago(st.doneAt)}Claude 對完清單`
        : `   ${label} ✓  改過程式檔（最後一次 ${ago(st.ranAt)}）${st.closedBy === 'checklist' ? ',Claude 對完清單' : ''}——已走過`);
      continue;
    }
    // 「被叫」的證據有兩種:你自己打的斜線指令(不經過 Skill 工具,L19)、或 Claude 自己去叫。字要跟證據一樣大:叫了,不是跑完了
    const verb = st.type === 'browser' ? `開瀏覽器跑過一輪${st.count ? `（${st.count} 個動作）` : ''}`
      : st.via === 'typed' ? `你叫了 /${st.calledAs}` : `Claude 叫了 /${st.calledAs ?? st.skill}`;
    switch (st.state) {
      case 'main':     console.log(`   ${label} ●  就是你在講話的那個對話（這一輪還沒改到程式檔）`); break;
      case 'notbuilt': console.log(`   ${label} ⚫ 未建`); break;
      case 'none': {
        // 「沒有紀錄」跟「這裡根本沒有這個指令」是兩件事(lib/skills.mjs);上一輪的只講一句,不畫線
        const av = st.skill ? skillAvailable(st.skill, ctx.root, ctx.mainRoot) : { found: null };
        console.log(av.found === false
          ? `   ${label} ⚪ 找不到 /${st.skill} 這個指令（這個專案的 .claude/ 和 ~/.claude 都沒有）`
          : `   ${label} ⚪ 這一輪還沒跑${st.prevRanAt ? `（上一輪 ${ago(st.prevRanAt)}跑過）` : ''}`);
        // 寫規格那一關的三種旁白(施工對話認規格):都不算 A、不畫清單、不擋人
        for (const line of specNotes(st)) console.log(`              ${line}`);
        break;
      }
      // A 的結案是你點頭開工(之後第一次改到程式檔):講出來,不然像是憑空劃掉的
      case 'passed': {
        // 照別的對話寫的規格施工(施工對話認規格 AC-1):連結不是 A 的一次呼叫,沒有「叫了」的時間可講,講照哪份、誰說的
        if (st.closedBy === 'link' && st.link) {
          console.log(`   ${label} ✓  已走過：${linkLine(st.link)}`);
          for (const line of specNotes(st)) console.log(`              ${line}`);
          break;
        }
        const head = String(st.report?.note ?? '').split('\n')[0].trim();
        const who = st.closedBy === 'nod' ? `,${ago(st.nodAt)}開始改程式檔,算你點頭開工了` : st.closedBy === 'claude' && head ? `,Claude 說：${head}` : st.closedBy === 'human' ? ',你說處理完了' : '';
        console.log(`   ${label} ✓  ${ago(st.ranAt)}${verb}${who}——已走過`);
        // 已走過的關,結論的清單還是要列(C 的建議不能因為走過了就不見)
        for (const line of String(st.report?.note ?? '').split('\n').slice(1)) if (line.trim()) console.log(`              ${line.trim().slice(0, 90)}`);
        break;
      }
      // 結論會過期的關:之後又改了程式檔,要再跑一次(AC-9)。不劃掉、不打勾
      case 'stale':    console.log(`   ${label} 🔁 ${ago(st.ranAt)}${verb},之後又改了程式檔——要再跑一次`); break;
      case 'seen': {
        // 開過瀏覽器 ≠ 驗收過。講得出去了哪,算不算驗收由人說(--clear E)
        const where = st.hosts?.length ? `,去了 ${st.hosts.slice(0, 3).join('、')}` : '';
        console.log(`   ${label} 👁 ${ago(st.ranAt)}開過瀏覽器（${st.count} 個動作${where}）——算不算驗收你說了算：pipeline-status --clear ${st.id}`);
        break;
      }
      default: {
        // current／done。沒有結案的,時間越久要越顯眼——所以天數一定印出來,而且用 ⏸ 不用 ✅。
        // 結案要說得出是誰說的(AC-11):Claude 說(記的結論)、你說(E 驗收、舊紀錄)。等結論的關講清楚在等誰
        const closed = st.state === 'done';
        const said = st.type === 'browser' ? '驗收過了' : '處理完了';
        const first = view.stages.find((v) => v.skill);
        let tail;
        const head = String(st.report?.note ?? '').split('\n')[0].trim();
        if (closed) tail = st.closedBy === 'claude' ? `,${ago(st.doneAt)}Claude 說${head ? `：${head}` : '沒問題'}` : `,${ago(st.doneAt)}你說${said}`;
        else if (st.report?.verdict === 'found') tail = `,Claude 說找到問題${head ? `：${head}` : ''}——還沒處理完`;
        else if (st.type === 'browser') tail = `,還沒有人說${said}`;
        else if (first && st.id === first.id) tail = ',等你點頭開工';
        else tail = ',Claude 還沒記結論';
        console.log(`   ${label} ${closed ? '✅' : '⏸'} ${ago(st.ranAt)}${verb}${tail}`);
        if (st.args) console.log(`              「${st.args.slice(0, 46)}${st.args.length > 46 ? '…' : ''}」`);
        // 結論的說明有清單(多行)時,一行一行印——C 的建議、D 的發現就住在這裡
        for (const line of String(st.report?.note ?? '').split('\n').slice(1)) if (line.trim()) console.log(`              ${line.trim().slice(0, 90)}`);
      }
    }
    // A 的清單就是規格檔裡的 AC,照檔案畫(AC-5):✅ 對過、⏳ 待討論、○ 還沒對。解析不了就照原文,找不到就說找不到
    if (st.checklist) printChecklist(st.checklist);
  }

  if (firstTs) {
    console.log(`\n   ⚠️ 「沒有紀錄」不等於「沒跑過」——感測器從 ${ago(firstTs)}才開始記,`);
    console.log('      在那之前發生的事情它一輩子都不會知道。');
  }
  console.log('\n   ⚠️ 上面寫的是「叫了」,不是「通過」——感測器只看得到指令被叫,');
  console.log('      看不到結果。驗屋師傅來過,不等於房子修好了。');
  // 只有驗收那一關由人說;其他關由儀表板自動辨識,不用你按(五關自動結案 AC-10)
  const e = view.stages.find((v) => v.type === 'browser' && v.state === 'seen');
  if (e) console.log(`   驗收過了要留紀錄：  pipeline-status --clear ${e.id}`);
}

/** 規格檔裡的 AC 清單(五關自動結案 AC-5)。給人看的是標題與白話那一句,不印技術那層。 */
function printChecklist(cl) {
  const rel = (f) => (typeof f === 'string' ? f.split('/').slice(-3).join('/') : '');
  if (cl.missing) { console.log(`              清單：找不到這一輪的規格檔${cl.file ? `（${rel(cl.file)}）` : ''}`); return; }
  if (!cl.parsed) { console.log(`              清單：規格檔裡沒有照格式寫的 AC（${rel(cl.file)}）${cl.head ? `,開頭是：${cl.head.slice(0, 60)}` : ''}`); return; }
  // 分批做的規格(施工對話認規格 AC-8):整份照畫,不在這一批的標出來——收工前只要求這一批
  if (cl.batch) console.log(`              這一批只對 ${cl.batch.join('、')}（全部 ${cl.allTotal} 條）`);
  if (cl.batchMissing?.length || cl.preMarked) console.log(`              ⚠️ ${checklistWhy(cl)}`);
  for (const it of cl.items) {
    const mark = it.state === 'checked' ? '✅' : it.state === 'pending' ? '⏳' : '○';
    console.log(`              ${mark} ${it.id} ${it.title}${it.state === 'pending' && it.note ? `（待討論：${it.note}）` : ''}${it.inBatch === false ? '（不在這一批）' : ''}`);
    if (it.plain) console.log(`                 ${it.plain.slice(0, 70)}${it.plain.length > 70 ? '…' : ''}`);
  }
}

/** 「照別的對話寫的規格 X（Claude 說的）」——終端機與網頁同一句(ui/app.js 的 linkLine 是翻譯,改一邊要改另一邊)。 */
function linkLine(link) {
  const how = link.how === 'only' ? '；沒記到對話代號，這個工作區只有這個對話' : '';
  return `照別的對話寫的規格 ${link.name}（Claude 說的${how}）`;
}

/** 寫規格那一關的旁白:規格在哪、另寫了一份、第一句話的提示、分不出是誰記的。都只是講,不算 A、不擋人(施工對話認規格)。 */
function specNotes(st) {
  const L = [];
  const lk = st.link;
  if (lk?.found === 'main') L.push('規格在主資料夾，不在這個工作區（可能還沒併進來）——不會叫 Claude 去那裡打勾');
  else if (lk?.found === 'missing') L.push(`找不到規格檔 ${lk.name}.md`);
  else if (lk?.found === 'ambiguous') L.push(`工作區裡叫 ${lk.name}.md 的規格不只一份（${(lk.where ?? []).join('、')}），分不出是哪一份`);
  if (st.side) L.push(st.side.name ? `另寫了一份規格 ${st.side.name}（等你點頭）` : `${ago(st.side.ts)}又叫了寫規格那一關（寫了哪份看不到）；施工清單還是 ${lk?.name ?? '原本那份'}`);
  if (st.hint) L.push(`從你第一句話看，可能是照 ${st.hint.name} 施工（Claude 還沒確認${st.hint.cut ? '；感測器只記第一句話的開頭，後面有沒有提到別份看不到' : ''}）`);
  if (st.unsure) L.push(`有一筆規格連結（${st.unsure.name}）分不出是哪個對話記的——不算數`);
  if (st.shared) L.push('這個工作區這一輪有好幾個對話；規格連結只算記它的那個對話，看儀表板各對話的頁面');
  return L;
}

/** B 為什麼還不算寫完:清單還有沒對的、這一批記的代號對不上檔案、或勾都是連上之前就打好的(施工對話認規格)。終端機與網頁同一句 */
function checklistWhy(cl) {
  if (cl?.batchMissing?.length) return `這一批記的 ${cl.batchMissing.join('、')} 在規格裡找不到了（可能改過號），要重記 --spec`;
  if (cl?.preMarked) return '清單的勾都是連上這份之前就打好的，這個對話還沒回頭對過';
  return '清單沒對完';
}

/** 人蓋的結案章(AC-9)。⚠️ 寫進同一份 append-only 紀錄,但標明 source:'human'。 */
function doClear(ctx, stageId) {
  const { stages } = loadStages(HERE, ctx.root, ctx.mainRoot);
  const st = stages.find((x) => x.id.toLowerCase() === String(stageId).toLowerCase());
  if (!st) {
    console.log(`認不出關卡「${stageId}」。這個專案的關卡是：${stages.map((x) => x.id).join(' / ')}`);
    return 1;
  }
  // 只有驗收那一關由人說(五關自動結案 AC-10);其他關由儀表板自動辨識——A 你點頭開工、B 改程式、C／D 由 Claude 記結論
  if (st.type !== 'browser') {
    const e = stages.find((x) => x.type === 'browser');
    console.log(`${st.id} ${st.name} 現在由儀表板自動辨識,不用你按。${e ? `只有 ${e.id} ${e.name} 由你說：  pipeline-status --clear ${e.id}` : ''}`);
    return 1;
  }
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'stage_cleared', stage: st.id,
      cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'human',
    }) + '\n');
  } catch (e) {
    console.log(`❌ 沒記成功：${e.message}`);
    return 1;
  }
  console.log(`✅ 記下了：你說 ${st.id} ${st.name} ${st.type === 'browser' ? '驗收過了' : '處理完了'}（${ctx.head?.slice(0, 7)}）`);
  console.log('   ⚠️ 這是「你說的」,不是系統驗證的——畫面上會照實這樣寫。');
  return 0;
}

/**
 * --spec <規格檔> [AC-1 AC-2 …]:Claude 記一筆「這個對話照哪份規格施工」(施工對話認規格 AC-1、AC-4、AC-8)。
 * 規格在別的對話寫、點頭後另開對話施工——施工的對話記這一筆,儀表板的寫規格那一關才畫得出那份清單、收工 hook 才不叫它重寫規格。
 * --spec 無:這個對話沒有照別的對話寫的規格(第一句話來的提示會消失;分級要寫規格那一關的話,還是要跑)。
 * ⚠️ 這是「Claude 說的」:事件標 source:'claude',畫面照實標(R2)。連結不是寫規格那一關的一次呼叫,不算「跑過」。
 * ⚠️ 只收還沒做完的規格(AC-4):這個工作區 docs/規劃中/ 或 docs/進行中/ 的 .md、讀得出 AC、不是這個對話自己寫的。
 *    工作區沒有、只在主資料夾有(可能還沒併進來)→ 收,但講明:儀表板只寫一句「在主資料夾」,不叫 Claude 去那裡打勾(AC-6)。
 * 對話代號:Claude Code 給指令的環境變數 CLAUDE_CODE_SESSION_ID(2026-09-21 實測有給,跟感測器記的 session 一樣)。
 *   拿不到就不記,讀取端只在「這個工作區只有一個對話」時才歸給它(lib/events.mjs 的 linkOwner)——不猜一個填進去。
 */
function doSpec(ctx, ev, args) {
  const [target, ...rest] = args;
  if (!target?.trim()) {
    console.log('要一份規格檔：  pipeline-status --spec docs/進行中/<名字>.md');
    console.log('   只做其中幾條就在後面加代號（例：--spec docs/進行中/<名字>.md AC-1 AC-2）；沒有照哪份規格就 --spec 無');
    return 1;
  }
  const sid = sessionFromEnv();
  const { stages } = loadStages(HERE, ctx.root, ctx.mainRoot);
  const first = stages.find((x) => x.skill);
  const stageName = first ? `${first.id} ${first.name}` : '寫規格那一關';
  const record = (extra) => {
    try {
      appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
        ts: new Date().toISOString(), event: 'spec_link', ...extra, ...(sid ? { by_session: sid } : {}),
        cwd: ctx.root, main: ctx.mainRoot ?? null, head: ctx.head?.slice(0, 7), source: 'claude',
      }) + '\n');
      return true;
    } catch (e) { console.log(`❌ 沒記成功：${e.message}`); return false; }
  };
  const tail = () => { if (!sid) console.log('   （拿不到這個對話的代號：這個工作區只有一個對話時，儀表板才算得出是它記的；有別的對話來過就不歸給任何對話、也不擋。）'); };

  if (['無', 'none'].includes(target.trim())) {
    if (!record({ spec: null, none: true })) return 1;
    console.log('✅ 記下了：這個對話沒有照別的對話寫的規格施工（Claude 說的）。');
    console.log(`   從第一句話來的提示會消失；這次改動的分級要 ${stageName} 的話，收工前還是會要求跑。`);
    tail();
    return 0;
  }

  const notDone = `只收還沒做完的規格：這個工作區 docs/規劃中/ 或 docs/進行中/ 底下的 .md。`;
  // 工作區的根是 git 給的真實路徑;給的路徑也解析成真實路徑再比(macOS 的暫存資料夾、捷徑都會讓兩種拼法對不上)。
  // 檔案不在工作區(只在主資料夾)就解析它所在的資料夾。
  // 相對路徑先照指令列所在的位置解;解出來不在這個工作區的 docs/ 底下,再照工作區的根解——從子資料夾跑也認得(魔鬼教官 2026-09-21)
  const relOf = (p) => { const abs = real(p) !== p ? real(p) : join(real(dirname(p)), basename(p)); return relative(ctx.root, abs).split('\\').join('/'); };
  let rel = relOf(isAbsolute(target) ? target : resolve(process.cwd(), target));
  if (!isAbsolute(target) && !/^docs\//i.test(rel)) rel = relOf(resolve(ctx.root, target));
  if (/^docs\/升級摘要\/[^/]+\.md$/i.test(rel)) {
    console.log(`這份在 docs/升級摘要/，是已經做完的規格，不能拿來施工。${notDone}`);
    console.log(`   要照它再改一輪的話，另寫一份新規格（跑 ${stageName}）。`);
    return 1;
  }
  if (!/^docs\/(規劃中|進行中)\/[^/]+\.md$/i.test(rel)) { console.log(`認不得「${target}」。${notDone}`); return 1; }
  const loc = locateSpec(rel, { root: ctx.root, mainRoot: ctx.mainRoot });
  if (loc.found === 'missing') { console.log(`找不到 ${rel}（這個工作區和主資料夾的規劃中／進行中／升級摘要都沒有 ${basename(rel)}）。`); return 1; }
  if (loc.found === 'ambiguous') { console.log(`這個工作區裡叫 ${basename(rel)} 的規格不只一份：${loc.where.join('、')}。給完整路徑。`); return 1; }
  if (loc.found === 'main' && !loc.mainFile) { console.log(`主資料夾裡叫 ${basename(rel)} 的規格不只一份，分不出是哪一份。`); return 1; }
  // 名字對上了,但它已經搬到升級摘要(做完了)
  if (!/^docs\/(規劃中|進行中)\//i.test(loc.rel ?? '')) {
    console.log(`${basename(rel)} 已經搬到 docs/升級摘要/（做完了），不能拿來施工。${notDone}`);
    return 1;
  }
  const cl = readChecklist(loc.found === 'here' ? loc.file : loc.mainFile);
  if (!cl.parsed) {
    console.log(`${loc.rel} 裡讀不出任何一條 AC（要有「**AC-1　標題**」那種格式的行），不算規格。`);
    console.log(`   還沒有規格的話，跑 ${stageName}。`);
    return 1;
  }
  // 只做其中幾條(AC-8):代號要真的在這份裡——打錯一個字,收工 hook 就會要求一條不存在的 AC
  const acs = [];
  for (const a of rest) {
    const m = String(a).trim().match(/^AC-?(\d+)$/i);
    const id = m ? `AC-${Number(m[1])}` : null;
    if (!id || !cl.items.some((it) => it.id === id)) {
      console.log(`${loc.rel} 裡沒有「${a}」。這份的 AC 是：${cl.items.map((it) => it.id).join('、')}`);
      return 1;
    }
    if (!acs.includes(id)) acs.push(id);
  }
  // 這個對話自己寫的規格不收(AC-4):那是寫規格那一關的工作,跑那一關它會自己連上寫的檔
  const self = writtenHere(ctx, ev, loc, sid, stages);
  if (self) {
    const cmd = first ? commandFor(first.skill, ctx.root, ctx.mainRoot, pluginName(HERE)) : null;
    console.log(`${loc.rel} 看起來是這個對話自己寫的（${self}）——那是 ${stageName} 的工作，${cmd ? `跑 ${cmd}` : `跑 ${stageName}`}（它會自己連上寫的那份）。`);
    return 1;
  }
  if (!record({ spec: loc.rel, ...(acs.length ? { acs } : {}) })) return 1;
  const name = basename(loc.rel).replace(/\.md$/i, '');
  if (loc.found === 'main') {
    // 只在主資料夾:儀表板只寫一句、不畫清單、收工不要求打勾(AC-6)——第一行就照實講,不先說「會畫出 N 條」
    console.log(`✅ 記下了：這個對話照 ${name} 施工（Claude 說的）。`);
    console.log(`   ⚠️ 規格在主資料夾，不在這個工作區（可能還沒併進來）——儀表板只寫這一句、不畫那 ${cl.total} 條，收工時也不會叫你去主資料夾打勾。`);
  } else {
    console.log(`✅ 記下了：這個對話照 ${name} 施工（Claude 說的）。儀表板的 ${stageName} 會畫出那份的 ${cl.total} 條 AC。`);
    console.log(`   收工前在 ${loc.rel} 每條 AC 的標題行末尾標「✅ 對過 日期」或「⏳ 待討論：原因」。`);
  }
  if (acs.length) console.log(`   這一批只對 ${acs.join('、')}；其他條標「不在這一批」，收工前不要求。`);
  tail();
  return 0;
}

/**
 * 這份規格是不是這個對話自己寫的(施工對話認規格 AC-4)。是 → 回一句白話的證據;不是、或分不出來 → null。三種證據,任一種就算:
 *   ① 感測器記到這個對話在**這個工作區**Write 過同名的規格,而且在它第一次連上這份**之前**
 *      (連上之後的 Write 是打勾、搬家;別的資料夾的同名檔——例如審查員在暫存資料夾造的——都不算)
 *   ② 這個對話的寫規格那一關收尾記了這份(--report A ok <路徑>):用 Bash 寫的規格,這是紀錄裡看得到的線索
 *   ③ 這個工作區只有這個對話在用,而 main 上沒有這個名字的規格——那就是在這裡新寫出來的(還沒存,或只存在這條分支上)
 * ⚠️ 以前只看 Write:用 Bash 寫的自家規格會被收下,畫面還寫「別的對話寫的」;同名的暫存檔又會誤擋(魔鬼教官 2026-09-21,老毛病 P6、P4、L8)。
 * 分不出是哪個對話(沒有代號、工作區有好幾個對話)就不擋:寧可收下一份來歷不明的,也不擋掉別的對話寫好的那份——畫面標「Claude 說的」。
 */
function writtenHere(ctx, ev, loc, sid, stages) {
  if (loc.found !== 'here') return null;   // 只在主資料夾的:這個工作區裡沒有人寫它
  const name = basename(loc.rel);
  const here = ev.events.filter((e) => e.cwd === ctx.root);
  const sessions = new Set(here.filter((e) => e.hook && e.session).map((e) => e.session));
  const me = sid ?? (sessions.size === 1 ? [...sessions][0] : null);
  if (me) {
    const firstLink = here.filter((e) => e.event === 'spec_link' && e.by_session === me && basename(String(e.spec ?? '')) === name)
      .map((e) => Date.parse(e.ts)).sort((a, b) => a - b)[0] ?? Infinity;
    const inWs = (f) => typeof f === 'string' && f.startsWith(`${ctx.root}/docs/`) && basename(f) === name;
    if (ev.events.some((e) => e.session === me && e.hook === 'PostToolUse' && e.tool === 'Write' && inWs(e.file) && Date.parse(e.ts) < firstLink)) {
      return '感測器記到這個對話寫過它';
    }
    const first = stages.find((x) => x.skill);
    if (first) {
      // 一筆結論屬於它之前最後一次被叫的那一關(跟 roundView 認 A 寫了哪份同一種認法)
      const aRuns = runsPerStage(ev.events, stages, (e) => e.cwd === ctx.root).get(first.id) ?? [];
      for (const r of here.filter((e) => e.event === 'stage_report' && e.stage === first.id && typeof e.note === 'string')) {
        if (basename(r.note.trim().split('\n')[0].trim()) !== name) continue;
        const run = aRuns.filter((x) => Date.parse(x.ts) <= Date.parse(r.ts)).at(-1);
        if (run?.session === me) return `這個對話的 ${first.id} ${first.name} 收尾記了它`;
      }
    }
  }
  if (sessions.size && [...sessions].every((x) => x === me)) {
    const mainRef = ['main', 'master'].find((m) => git(['rev-parse', '--verify', '-q', m], ctx.root));
    const tree = mainRef ? git(['ls-tree', '-r', '--name-only', mainRef, '--', 'docs'], ctx.root) : null;
    // 問不到 main 的內容就不下結論(R1:沒問到不當沒有)
    if (tree !== null && mainRef) {
      const onMain = tree.split('\n').some((f) => /^docs\/(規劃中|進行中|升級摘要)\//.test(f) && basename(f) === name);
      if (!onMain) return 'main 上沒有這份，是在這個工作區新寫出來的，而這個工作區只有這個對話在用';
    }
  }
  return null;
}

/** Claude Code 給指令的環境變數裡的對話代號。沒有(舊版、或人自己在終端機跑)就是 null——不猜。 */
function sessionFromEnv() {
  const v = String(process.env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  return v && v.length <= 100 ? v : null;
}

/**
 * --report <關> <ok|found> "<說明>":Claude 把一關的結論記給儀表板(五關自動結案 AC-7、AC-8)。
 * ⚠️ 這是「Claude 說的」,不是人驗證的——事件標 source:'claude',畫面照實標「Claude 說」(R2 在這個設計裡的位置)。
 *    ok = 沒問題／列好了(C 列了建議、D 沒找到) → 這關結案;found = 找到問題 → 還沒結案,修完再跑一次再記。
 */
function doReport(ctx, stageId, verdict, note) {
  const { stages } = loadStages(HERE, ctx.root, ctx.mainRoot);
  const st = stages.find((x) => x.id.toLowerCase() === String(stageId ?? '').toLowerCase());
  if (!st) {
    console.log(`認不出關卡「${stageId ?? ''}」。這個專案的關卡是：${stages.map((x) => x.id).join(' / ')}`);
    return 1;
  }
  if (!st.skill) { console.log(`${st.id} ${st.name} 不是指令關,沒有結論可以記。`); return 1; }
  if (!['ok', 'found'].includes(verdict)) {
    console.log('結論只有兩種：ok（沒問題／列好了）或 found（找到問題）。例：  pipeline-status --report D found "找到 3 條"');
    return 1;
  }
  // 說明放得下一張清單(C 的建議、D 的發現,一行一條)。單行紀錄要遠小於 4096 bytes(感測器 AC-4)——
  // 算 bytes 不算字(中文一個字 3 bytes)。太長不截:整份另存一個檔,紀錄裡留第一行與檔名,「有幾條就列幾條」(Oscar 2026-09-16)
  let text = String(note ?? '').trim();
  let noteFile = null;
  if (Buffer.byteLength(text, 'utf8') > MAX_NOTE_BYTES) {
    try {
      const dir = join(LOG_DIR, 'reports');
      mkdirSync(dir, { recursive: true });
      noteFile = join(dir, `${safeName(ctx.project)}__${Date.now().toString(36)}__${st.id}.txt`);
      writeFileSync(noteFile, text + '\n');
      text = cutBytes(text.split('\n')[0], 600);
    } catch (e) {
      console.log(`❌ 清單太長又存不了檔：${e.message}`);
      return 1;
    }
  }
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'stage_report', stage: st.id, verdict, note: text || null, noteFile,
      cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'claude',
    }) + '\n');
  } catch (e) {
    console.log(`❌ 沒記成功：${e.message}`);
    return 1;
  }
  console.log(`✅ 記下了：Claude 說 ${st.id} ${st.name} ${verdict === 'ok' ? '沒問題' : '找到問題'}${text ? `（${text.split('\n')[0]}）` : ''}`);
  if (noteFile) console.log(`   清單很長,整份存在 ${noteFile.split('/').slice(-2).join('/')},儀表板會一條一條列出來。`);
  console.log('   ⚠️ 這是「Claude 說的」,不是人驗證的——畫面上會照實標「Claude 說」。');
  return 0;
}

/** 單行紀錄的說明上限(bytes)。整行還有其他欄位,留足夠的餘裕在 4096 之下(感測器 AC-4)。 */
const MAX_NOTE_BYTES = 2500;
/** 照 bytes 截字串,不切在一個中文字中間。 */
function cutBytes(str, max) {
  let out = '';
  for (const ch of String(str)) { if (Buffer.byteLength(out + ch, 'utf8') > max) break; out += ch; }
  return out;
}

/**
 * --suggest "標題"(說明從標準輸入讀):Claude 建議「另開一個對話做這件事」,寫成一張卡放在儀表板上。
 * ⚠️ 儀表板開不了對話。卡片只能讓人複製說明、貼進新對話的第一句;「已開始」看的是有沒有對話真的這樣開頭。
 *    說明要限長:紀錄檔單行要遠小於 4096 bytes(AC-4),太長會跟感測器同時寫的那一筆交錯。
 */
function doSuggest(ctx, title, prompt) {
  if (!title?.trim()) { console.log('要一個標題：  pipeline-status --suggest "標題" < 說明檔'); return 1; }
  const body = String(prompt ?? '').trim();
  if (!body) { console.log('說明是空的。把說明餵進標準輸入：  pipeline-status --suggest "標題" <<\'EOF\' … EOF'); return 1; }
  // 算 bytes 不算字:中文一個字 3 bytes,以前用字數算,3000 個中文字就是 9000 bytes,早就超過單行的上限了
  const cut = Buffer.byteLength(body, 'utf8') > MAX_NOTE_BYTES;
  const kept = cut ? cutBytes(body, MAX_NOTE_BYTES) : body;
  const id = `sg-${Date.now().toString(36)}`;
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'suggestion', id, title: title.trim().slice(0, 80), prompt: kept,
      cwd: ctx.mainRoot ?? ctx.root, source: 'claude',
      // 截過要記在紀錄裡:儀表板才標得出「已截短」,不然半段說明會被當成全文(感測器記的 app 建議卡也有同一種記號)
      ...(cut ? { cut: true } : {}),
    }) + '\n');
  } catch (e) {
    console.log(`❌ 沒記成功：${e.message}`);
    return 1;
  }
  console.log(`✅ 放上儀表板了：「${title.trim().slice(0, 80)}」（${ctx.project} 的案件頁,「建議新增的對話」那一區）`);
  if (cut) console.log('   ⚠️ 說明太長,只留前面一段（單行紀錄有上限）。');
  return 0;
}

/* ══════════════════════════ 分級（lib/tier.mjs 算,這裡只印與寫） ══════════════════════════ */

function tierOf(ctx, ev, info, facts) {
  return buildTier({
    root: ctx.root, mainRoot: ctx.mainRoot, monitorDir: HERE, health: info.h,
    stages: facts.stages, perStage: facts.perStage, cleared: facts.cleared,
    events: ev.events, cwd: ctx.root, cpUsable: info.cpUsable, cpAt: info.cp?.at ?? null,
    head: ctx.head?.slice(0, 7) ?? null, reports: facts.reports, lastEdit: facts.view.lastEdit, spec: facts.view.spec,
  });
}

const SETUP_HINT = '在這個專案的對話裡說「幫我設定分級」,Claude 會提清單給你確認;不需要的話說「這個專案不用分級」。';

/**
 * 分級那一段的文案。純函式,吃 buildTier() 的物件,被 scripts/tier.test.mjs 釘住。
 * ⚠️ 三條紅線逐條套過:沒設定＝「還沒設定」不是「T0」(R1);「需要」那幾行只講有沒有紀錄,不講通過(R2);
 *    每個數字都是 git 或紀錄檔查得到的(R3)。
 */
function describeTier(t) {
  const L = [];
  const emptyWarn = () => `   ⚠️ 危險清單是空的,所以永遠不會出現 ${t.levels?.danger?.id ?? '第三級'}。${SETUP_HINT}`;
  if (t.state === 'unset') {
    L.push('   還沒設定分級。', `   ${SETUP_HINT}`, '   （或自己來：pipeline-status --tier-init）');
    return L;
  }
  if (t.state === 'off') {
    const when = t.off?.at ? `（${ago(t.off.at)}${t.off.why ? `,${t.off.why}` : ''}）` : '';
    L.push(`   已設定為不分級${when}。要恢復：pipeline-status --tier-init`);
    return L;
  }
  if (t.state === 'broken') {
    L.push(`   ⚠️ 分級設定讀不懂（${t.from ?? '.claude/pipeline-stages.json'}）：${t.why ?? ''}`);
    L.push('      為了不亂分,這次不分級。');   // R1:讀不懂 ≠ 沒設定 ≠ T0
    return L;
  }
  if (t.state === 'no-base') { L.push('   這個專案還沒有任何 commit,沒有基準可以算「這次改動」。先 git commit 一次。'); return L; }
  if (t.state === 'unknown') { L.push('   問不到改動,分不了級。'); return L; }
  if (t.state === 'no-change') {
    L.push('   這次沒有改動,沒有東西要分級。');
    if (t.dangerEmpty) L.push(emptyWarn());
    return L;
  }

  const { machine, manual, final } = t;
  const dangerHits = machine.hits.danger;
  const why = machine.rank === 2
    ? `碰到危險清單：${dangerHits.slice(0, 3).join('、')}${dangerHits.length > 3 ? `…共 ${dangerHits.length} 個` : ''}`
    : machine.rank === 1 ? `碰到程式區 ${machine.hits.code.length} 個檔` : '沒碰到程式區';
  if (manual) L.push(`   機器算 ${machine.id}（${why}）,你說 ${manual.id}（理由：${manual.why}）· ${ago(manual.ts)}`);
  else L.push(`   ${final.id}（${why}）`);
  if (t.manualIgnored) {
    L.push(`   （你 ${ago(t.manualIgnored.ts)}說的 ${t.manualIgnored.id} 沒有比機器算的高,不採用。）`);
  }

  if (t.requirements.length) {
    L.push('   需要：');
    for (const r of t.requirements) {
      // ✅ 有紀錄而且結案了(Claude 說／你說);⏸ 有紀錄沒結案;⚠️ 沒有紀錄;❔ 問不到／不適用;🔗 規格是別的對話寫的(Claude 說照哪份施工)
      const mark = r.state === 'ok' ? '✅' : r.state === 'ran' ? '⏸' : r.state === 'missing' ? '⚠️' : r.state === 'linked' ? '🔗' : '❔';
      const when = r.ts ? `${ago(r.ts)}` : '';
      L.push(`        ${r.label.padEnd(8, '　')} ${mark} ${when}${r.detail}`);
    }
  }
  if (t.dangerEmpty) L.push(emptyWarn());
  if (t.candidates.length) {
    L.push(`   ⚠️ 這次動到的檔案裡,有 ${t.candidates.length} 個名字像會存東西、但不在危險清單：`);
    for (const f of t.candidates.slice(0, 5)) L.push(`        ${f}`);
    L.push('      （只是提醒。改錯會靜默丟資料的話,加進 .claude/pipeline-stages.json 的 tiers.danger。）');
  }
  L.push('   為了程式碼安全,分級只能往上調。');
  if (manual) L.push('   收回你調的：pipeline-status --tier-retract');
  else if (t.upgradable.length) L.push(`   要調高：pipeline-status --tier ${t.upgradable[0]} "理由"`);
  return L;
}

function renderTier(ctx, ev, info, facts) {
  console.log('\n━━ 分級 ━━');
  for (const line of describeTier(tierOf(ctx, ev, info, facts))) console.log(line);
}

/** 人蓋的章(結案、調高分級),全部走這裡:同一份 append-only 紀錄,標明 source:'human'。 */
function appendHuman(ctx, obj) {
  appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
    ts: new Date().toISOString(), ...obj, cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'human',
  }) + '\n');
}

const isIgnored = (root, file) => gitExit(['check-ignore', '-q', file], root) === 0;

/** --tier-init [資料夾…]:提議程式區、寫出骨架(危險清單空的)。已經設定過就只回報。 */
function doTierInit(ctx, dirs) {
  const cfg = readTierConfig(ctx.root, ctx.mainRoot, HERE);
  if (cfg.state === 'broken') {
    console.log(`⚠️ 分級設定讀不懂（${cfg.from}）：${cfg.why}。先修好那個檔案,這次不動它。`);
    return 1;
  }
  if (cfg.state === 'ok') {
    console.log(`已經設定過了（${cfg.from}）：程式區 ${cfg.config.code.join('、')}；危險清單 ${cfg.config.danger.length} 個。`);
    if (!cfg.config.danger.length) console.log(`⚠️ 危險清單是空的,所以永遠不會出現 ${cfg.config.levels.danger.id}。${SETUP_HINT}`);
    return 0;
  }
  const proposal = dirs.length
    ? { dirs: dirs.map((d) => `${d.replace(/^\.\//, '').replace(/\/+$/, '')}/`), why: '你指定的' }
    : proposeCodeArea(ctx.root);
  if (!proposal) {
    console.log('認不出這個專案的程式區（package.json 沒指向哪裡、也找不到放程式檔的資料夾）。');
    console.log('   自己指定：  pipeline-status --tier-init src/');
    return 1;
  }
  const r = writeTierConfig(ctx.root, { code: proposal.dirs, danger: [] });
  if (!r.ok) { console.log(`❌ ${r.why}（${r.path}）`); return 1; }
  console.log(`✅ 寫好了：${r.path}`);
  console.log(`   程式區：${proposal.dirs.join('、')}（${proposal.why}）——不對的話直接改那個檔的 tiers.code`);
  console.log('   危險清單：空的。⚠️ 所以永遠不會出現第三級——只有人判斷得了「改錯會不會靜默丟資料」。');
  console.log(`   ${SETUP_HINT}`);
  if (isIgnored(ctx.root, '.claude/pipeline-stages.json')) {
    console.log('\n⚠️ 這個檔案被 .gitignore 擋著,**不會進版控**——換一台電腦、或在 worktree 裡,分級就不見了。');
    console.log('   分級是專案的政策,建議進版控：在 .gitignore 加一行  !.claude/pipeline-stages.json');
  }
  return 0;
}

function doTierOff(ctx, why) {
  const r = writeTierConfig(ctx.root, { off: true, at: new Date().toISOString(), why: why || null });
  if (!r.ok) { console.log(`❌ ${r.why}（${r.path}）`); return 1; }
  console.log(`✅ 記下了：這個專案不分級${why ? `（${why}）` : ''}。對話開始時不會再提醒。`);
  console.log('   要恢復：  pipeline-status --tier-init');
  return 0;
}

/** --tier <等級> "<理由>":只准往上。理由必填——沒理由的調高跟誤按分不出來。 */
function doTierSet(ctx, ev, info, facts, id, why) {
  const t = tierOf(ctx, ev, info, facts);
  if (t.state !== 'ok') { for (const line of describeTier(t)) console.log(line); return 1; }
  if (!id) { console.log(`要調到哪一級？  pipeline-status --tier ${t.upgradable[0] ?? '<等級>'} "理由"`); return 1; }
  if (!why) { console.log('理由必填：  pipeline-status --tier ' + id + ' "為什麼這次要更小心"'); return 1; }
  if (!t.upgradable.includes(id)) {
    console.log(`只能調到比機器算的（${t.machine.id}）高的等級${t.upgradable.length ? `：${t.upgradable.join(' / ')}` : '——已經是最高了'}。`);
    console.log('   往下調沒有指令,要改 .claude/pipeline-stages.json——不方便是故意的。');
    return 1;
  }
  try {
    appendHuman(ctx, { event: 'tier_set', level: id, why: why.slice(0, 200) });
  } catch (e) {
    console.log(`❌ 沒記成功：${e.message}`);
    return 1;
  }
  console.log(`✅ 記下了：你說這次算 ${id}（${why.slice(0, 200)}）。機器算的是 ${t.machine.id}。`);
  console.log('   ⚠️ 這是「你說的」,畫面上會照實這樣寫。基準換了（蓋章,或沒章時存檔）就歸零。');
  return 0;
}

function doTierRetract(ctx, ev, info, facts) {
  const t = tierOf(ctx, ev, info, facts);
  if (t.state !== 'ok' || !t.manual) { console.log('沒有你調高的等級可以收回。'); return 1; }
  try {
    appendHuman(ctx, { event: 'tier_retracted' });
  } catch (e) {
    console.log(`❌ 沒記成功：${e.message}`);
    return 1;
  }
  console.log(`✅ 收回了：回到機器算的 ${t.machine.id}。`);
  return 0;
}

/* ══════════════════════════ main ══════════════════════════ */

/**
 * --on / --off。plugin 裝好之後,這兩個指令只管「退出記號」跟「拆舊接法」;沒裝 plugin 才走舊接法(寫進設定檔)。
 * ⚠️ 兩種掛法同時存在會記兩次,所以 plugin 在的時候,--on 跟 --off 都順手把舊接法拆掉。
 */
function doMount(ctx, on) {
  const plugin = pluginState();
  if (!plugin.installed) {
    console.log(`${on ? '掛上' : '拆下'}（舊接法,寫進這個專案的設定檔）：${ctx.root}\n`);
    const r = on ? mount(ctx.root) : unmount(ctx.root);
    for (const line of r.out) console.log(line);
    console.log('\n💡 裝成 plugin 就不用每個專案掛：pipeline-status --install');
    return r.ok ? 0 : 1;
  }
  const legacy = hookPathsIn(ctx.root).length ? unmount(ctx.root) : null;
  if (on) {
    const removed = optIn(ctx.root, ctx.mainRoot);
    console.log(removed.length
      ? `✅ 重新加入記錄：拿掉了 ${removed.join(', ')}`
      : '✅ 這個專案本來就在記錄中（plugin 每個專案都會記）。');
  } else {
    const p = optOut(ctx.mainRoot ?? ctx.root, 'cli');
    console.log(`✅ 已退出記錄：放了 ${p}`);
    console.log('   從現在起 hook 看到這個檔就不記（不用開新對話）。之前的紀錄還在;想回來就 --on,或按儀表板的按鈕。');
  }
  if (legacy) {
    console.log('\n舊接法（設定檔裡的 hook）一併拆掉,不然會記兩次：');
    for (const line of legacy.out) console.log(`   ${line}`);
  }
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const at = (flag) => argv.indexOf(flag);
  // 旗標後面的自由文字(理由、資料夾),遇到下一個旗標就停
  const after = (flag) => argv.slice(at(flag) + 1).filter((a) => !a.startsWith('--'));

  // 儀表板的背景服務(launchd):裝／拆／重啟／狀態,以及用瀏覽器打開。都不需要站在 git 專案裡
  const serveFlag = ['--serve-install', '--serve-uninstall', '--serve-restart', '--serve-status'].find((f) => at(f) !== -1);
  if (serveFlag) {
    const r = serveFlag === '--serve-install' ? await installService()
      : serveFlag === '--serve-uninstall' ? uninstallService()
      : serveFlag === '--serve-restart' ? await restartService()
      : await describeService();
    for (const line of r.out) console.log(line);
    return r.ok ? 0 : 1;
  }
  if (at('--open') !== -1) {
    const r = await openDashboard();
    for (const line of r.out) console.log(line);
    return r.ok ? 0 : 1;
  }
  // plugin 的裝／拆不需要站在 git 專案裡
  if (at('--install') !== -1 || at('--uninstall') !== -1) {
    const r = at('--install') !== -1 ? installPlugin() : uninstallPlugin();
    for (const line of r.out) console.log(line);
    return r.ok ? 0 : 1;
  }
  const cwd = process.cwd();
  const ctx = gitContext(cwd);
  if (!ctx.isGit) {                             // AC-10
    console.log('這裡看起來不是一個 git 專案,所以沒有版本可以參照。');
    console.log(`（目前位置：${cwd}）`);
    return 0;
  }
  if (at('--on') !== -1 || at('--off') !== -1) return doMount(ctx, at('--on') !== -1);
  // 分級的設定不需要有 commit
  if (at('--tier-init') !== -1) return doTierInit(ctx, after('--tier-init'));
  if (at('--tier-off') !== -1) return doTierOff(ctx, after('--tier-off').join(' '));

  // 紀錄只讀一次:感測器那行(活著嗎)、五關那段(跑過什麼)、分級(人調的)共用同一份
  const ev = readEvents(LOG_DIR, ctx.project);
  if (!ctx.hasCommits && at('--checkpoint') === -1) {
    renderSensor(ctx, ev);
    console.log('這個專案還沒有任何 commit,所以還沒有版本可以回去。');
    return 0;
  }

  if (at('--clear') !== -1) return doClear(ctx, argv[at('--clear') + 1]);
  if (at('--spec') !== -1) return doSpec(ctx, ev, after('--spec'));
  if (at('--report') !== -1) { const [id, verdict, ...note] = after('--report'); return doReport(ctx, id, verdict, note.join(' ')); }
  if (at('--suggest') !== -1) {
    let stdin = '';
    try { stdin = readFileSync(0, 'utf8'); } catch { stdin = ''; }
    return doSuggest(ctx, after('--suggest').join(' '), stdin);
  }
  if (at('--checkpoint') !== -1) return doCheckpoint(ctx);

  // 事實各算一次,三段畫面共用
  const info = gatherChange(ctx);
  const facts = stageFacts(ctx, ev, info);
  if (at('--tier-retract') !== -1) return doTierRetract(ctx, ev, info, facts);
  if (at('--tier') !== -1) {
    const [id, ...why] = after('--tier');
    return doTierSet(ctx, ev, info, facts, id, why.join(' '));
  }

  render(ctx, ev, info);
  renderStages(ctx, ev, facts, info);
  renderTier(ctx, ev, info, facts);
  return 0;
}

// ⚠️ 不要寫成 `import.meta.url === \`file://${process.argv[1]}\``——
// import.meta.url 是百分號編碼的（路徑裡的空白會變 %20）,而 argv[1] 不是。
// 使用者的路徑只要有一個空白,這個判斷就永遠 false,而程式**安靜地什麼都不做**。
// 實測就是這樣:「TutorPod AI」有空白,第一次執行零輸出零錯誤。
// 這正是本專案 R1 在講的形狀——沒壞掉的樣子,但什麼都沒發生。
// ⚠️ 第二次(2026-09-11,誠實修補 E1):透過捷徑(symlink、npm link、npx)執行時,argv[1] 是捷徑的路徑,
// import.meta.url 是真實路徑——同一個形狀,換了一個原因。所以兩邊都解析成真實路徑再比(老毛病 P3)。
function isMain() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? ''); }
  catch { return false; }
}
if (isMain()) main().then((code) => process.exit(code));
