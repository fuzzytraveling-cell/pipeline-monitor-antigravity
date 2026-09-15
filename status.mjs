#!/usr/bin/env node
/**
 * status.mjs —— 「我在哪、我回得去哪、這次動了多少」
 *
 * 規格：<專案>/docs/進行中/pipeline-status.md（AC 編號在下面各段落標出）
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
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { appendFileSync } from 'node:fs';
import { readEvents, loadStages, lastRunPerStage, runsPerStage, roundView, safeName, logFileOf } from './lib/events.mjs';
import { buildTier, readTierConfig, writeTierConfig, proposeCodeArea } from './lib/tier.mjs';
import { monitorHome } from './lib/paths.mjs';
import { skillAvailable } from './lib/skills.mjs';
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
  uncommitted, checkpointRelation, backupBranchName, restoreAdvice, describeCheckpoint,
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
function renderSensor(ctx, ev) {
  console.log(`━━ ${ctx.project} · ${ctx.branch} ━━`);
  const mine = ev.events.filter((e) => e.cwd === ctx.root).map((e) => e.ts).filter(Boolean).sort();
  const lines = describeSensor({ mount: mountState(ctx.root, ctx.mainRoot), lastSeen: mine.at(-1) ?? null });
  for (const line of lines) console.log(line);
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
function stageFacts(ctx, ev) {
  const { stages } = loadStages(HERE, ctx.root, ctx.mainRoot);
  const { perStage, sawAnyEventHere } = lastRunPerStage(ev.events, stages, ctx.root);
  // 人蓋的「結案」事件(AC-9)。source:'human' 是刻意標的——
  // 它跟感測器觀察到的事實不同級,永遠不要混在一起。
  const cleared = new Map();
  for (const e of ev.events) {
    if (e.event === 'stage_cleared' && e.cwd === ctx.root) cleared.set(e.stage, e);
  }
  return { stages, perStage, cleared, sawAnyEventHere };
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
  const view = roundView({
    runs: runsPerStage(events, stages, (e) => e.cwd === ctx.root), stages, cleared,
    cpAt: info.cpUsable ? info.cp?.at ?? null : null,
  });
  if (view.roundStart) console.log(`   （這一輪從 ${ago(view.roundStart)}開始算：最近一次第一關、或蓋章）`);
  let anyOpen = false;
  for (const st of view.stages) {
    const label = `${st.id} ${st.name}`.padEnd(10, '　');
    const verb = st.type === 'browser' ? `開瀏覽器跑過一輪${st.count ? `（${st.count} 個動作）` : ''}` : '跑過';
    switch (st.state) {
      case 'main':     console.log(`   ${label} ●  就是你在講話的那個對話`); break;
      case 'notbuilt': console.log(`   ${label} ⚫ 未建`); break;
      case 'none': {
        // 「沒有紀錄」跟「這裡根本沒有這個指令」是兩件事(lib/skills.mjs);上一輪的只講一句,不畫線
        const av = st.skill ? skillAvailable(st.skill, ctx.root, ctx.mainRoot) : { found: null };
        console.log(av.found === false
          ? `   ${label} ⚪ 找不到 /${st.skill} 這個指令（這個專案的 .claude/ 和 ~/.claude 都沒有）`
          : `   ${label} ⚪ 這一輪還沒跑${st.prevRanAt ? `（上一輪 ${ago(st.prevRanAt)}跑過）` : ''}`);
        break;
      }
      case 'passed':   console.log(`   ${label} ✓  ${ago(st.ranAt)}${verb}——已走過`); break;
      default: {
        // current／done。AC-9:沒有結案的,時間越久要越顯眼——所以天數一定印出來,而且用 ⏸ 不用 ✅
        const closed = st.state === 'done';
        console.log(`   ${label} ${closed ? '✅' : '⏸'} ${ago(st.ranAt)}${verb}`
          + (closed ? `,${ago(st.clearedAt)}你說處理完了` : ',還沒有人說處理完了'));
        if (st.args) console.log(`              「${st.args.slice(0, 46)}${st.args.length > 46 ? '…' : ''}」`);
        if (!closed) anyOpen = true;
      }
    }
  }

  if (firstTs) {
    console.log(`\n   ⚠️ 「沒有紀錄」不等於「沒跑過」——感測器從 ${ago(firstTs)}才開始記,`);
    console.log('      在那之前發生的事情它一輩子都不會知道。');
  }
  console.log('\n   ⚠️ 上面寫的是「跑過」,不是「通過」——感測器只看得到指令被呼叫,');
  console.log('      看不到結果。驗屋師傅來過,不等於房子修好了。');
  if (anyOpen) console.log('   處理完了要留紀錄：  pipeline-status --clear <關卡代號>   例如 --clear D');
}

/** 人蓋的結案章(AC-9)。⚠️ 寫進同一份 append-only 紀錄,但標明 source:'human'。 */
function doClear(ctx, stageId) {
  const { stages } = loadStages(HERE, ctx.root, ctx.mainRoot);
  const st = stages.find((x) => x.id.toLowerCase() === String(stageId).toLowerCase());
  if (!st) {
    console.log(`認不出關卡「${stageId}」。這個專案的關卡是：${stages.map((x) => x.id).join(' / ')}`);
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
  console.log(`✅ 記下了：你說 ${st.id} ${st.name} 處理完了（${ctx.head?.slice(0, 7)}）`);
  console.log('   ⚠️ 這是「你說的」,不是系統驗證的——畫面上會照實這樣寫。');
  return 0;
}

/* ══════════════════════════ 分級（lib/tier.mjs 算,這裡只印與寫） ══════════════════════════ */

function tierOf(ctx, ev, info, facts) {
  return buildTier({
    root: ctx.root, mainRoot: ctx.mainRoot, monitorDir: HERE, health: info.h,
    stages: facts.stages, perStage: facts.perStage, cleared: facts.cleared,
    events: ev.events, cwd: ctx.root, cpUsable: info.cpUsable, cpAt: info.cp?.at ?? null,
    head: ctx.head?.slice(0, 7) ?? null,
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
      // ✅ 只代表「有紀錄而且你說處理完了」;⏸ 有紀錄沒結案;⚠️ 沒有紀錄;❔ 問不到／不適用
      const mark = r.state === 'ok' ? '✅' : r.state === 'ran' ? '⏸' : r.state === 'missing' ? '⚠️' : '❔';
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
  if (at('--checkpoint') !== -1) return doCheckpoint(ctx);

  // 事實各算一次,三段畫面共用
  const info = gatherChange(ctx);
  const facts = stageFacts(ctx, ev);
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
