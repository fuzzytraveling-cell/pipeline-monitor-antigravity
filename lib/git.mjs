/**
 * git.mjs —— 問 git 的小工具(與「幾分鐘前」):終端機(status.mjs)、儀表板(lib/collect.mjs)、收工 hook(gate.mjs)共用這一份
 *
 * ⚠️ 以前住在 status.mjs(指令本身)裡:lib/collect.mjs 要回頭 import 指令,status.mjs 只好用到才載入 collect.mjs(不然繞圈),
 *    收工 hook 每回合也得把整支指令載進來。2026-09-24 搬出來(只搬家,沒改寫)。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, realpathSync, accessSync, constants } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
// 「幾分鐘前」只有一份算法(lib/freshness.mjs,伺服器也把它送給瀏覽器):以前這裡自己寫一份,
// 60 秒內終端機講「0 分鐘前」、網頁講「30 秒前」——同一件事兩種說法,老毛病 P2 的形狀。
import { humanAge } from './freshness.mjs';
import { zhEn, langNow } from './lang.mjs';

/* ────────────────────────── 找真正的 git ──────────────────────────
 * Mac 的 /usr/bin/git 是轉介程式:每呼叫一次,先多花約 7 毫秒去找真正的那一支
 * (2026-10-25 量:儀表板刷新一次問 git 844 次,約 6 秒在等它。規格:儀表板刷新少等git AC-1)。
 * 用 `git --exec-path` 找到 git 自己那個資料夾裡的 git,再跟 'git' 各問一次版本:一字不差才用——同一支程式,答案才會一樣。
 * 找不到、版本對不上 → 照舊用 'git'(AC-2)。這個位置只記到程式結束;重啟服務就重新找。 */
let gitBin = null;   // null = 還沒找(或找到的那支不見了,下一次重新找)
function findGit() {
  try {
    const opt = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const cand = join(execFileSync('git', ['--exec-path'], opt).trim(), 'git');
    if (execFileSync(cand, ['--version'], opt) === execFileSync('git', ['--version'], opt)) return cand;
  } catch { /* 找不到就照舊 */ }
  return 'git';
}
const canRun = (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

function runGit(args, opts) {
  gitBin ??= findGit();
  try {
    return execFileSync(gitBin, args, opts);
  } catch (e) {
    // 找到的那支中途不見了、或執行不了(更新開發工具時)→ 這一次改問 'git',下一次重新找(AC-2)。
    // ⚠️ 資料夾不在了也是 ENOENT——那支還在就不是它的問題,照原樣丟回去(問不到就是問不到)。
    // git 自己的回答(離開碼 1、錯誤訊息)不退回再問:那是答案,不是「沒打通」。
    if (gitBin !== 'git' && (e.code === 'ENOENT' || e.code === 'EACCES') && !canRun(gitBin)) {
      gitBin = null;
      return execFileSync('git', args, opts);
    }
    throw e;
  }
}

/* ────────────────────────── 一次刷新裡,同一題只問一次 ──────────────────────────
 * 儀表板刷新一次,同一個資料夾的同一個問題會被不同的步驟各問一遍(2026-10-25 量:844 次裡 185 次是重複的。AC-3)。
 * 記憶只在 withGitMemo(fn) 跑的那一段裡有,跑完(含丟例外)就丟——下一次刷新一定重新問(AC-4)。
 * 只記問到的:問失敗的,同一輪再問到就再問一次(git 可能剛好被別的對話鎖住,AC-5)。
 * ⚠️ 只用在同步跑完的那一段:中間沒有別的工作插進來,所以記憶不會被別人拿到。 */
let memo = null;
export function withGitMemo(fn) {
  const prev = memo;
  memo = new Map();
  try { return fn(); } finally { memo = prev; }
}
function asked(key, ask, keep) {
  if (!memo) return ask();
  const k = JSON.stringify(key);
  if (memo.has(k)) return memo.get(k);
  const v = ask();
  if (keep(v)) memo.set(k, v);
  return v;
}

/**
 * git 的原文輸出(不切空白);問不到回 null。args 原樣給 git——要不要關 quotepath 由呼叫端決定,
 * 這裡不加,換過來之前問的是什麼、之後就問什麼(AC-1)。
 */
export function gitRaw(args, cwd, { maxBuffer } = {}) {
  return asked(['out', cwd ?? null, maxBuffer ?? null, args], () => {
    try {
      return runGit(args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...(maxBuffer ? { maxBuffer } : {}) });
    } catch {
      return null;
    }
  }, (v) => v !== null);
}

/* ────────────────────────── git：查不到就回 null ──────────────────────────
 * ⚠️ A1。回 null 的唯一意思是「這次沒問到」，**不是**「答案是沒有」。
 * 呼叫端必須自己決定「沒問到」要怎麼講，不准預設折成 0／false／空陣列。 */
export function git(args, cwd) {
  // ⚠️ core.quotepath=false:git 預設會把非 ASCII 檔名轉義成 "\350\246\217..." 這種東西。
  // 這個專案的資料夾叫「規劃中」「進行中」——不關掉的話,畫面上會出現一串八進位碼,
  // 而讀的人不是工程師。這跟 L7(null 漏到畫面上)是同一族:程式的內部表示不該外流。
  return gitRaw(['-c', 'core.quotepath=false', ...args], cwd)?.trim() ?? null;
}

/** 真實路徑;解析不了(不存在)就原樣回去。 */
export function real(p) {
  try { return realpathSync(p); } catch { return p; }
}

/** 這是不是一個 git 專案（AC-10：不是也不准當機） */
export function gitContext(cwd) {
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
    ?? zhEn('(還沒有分支)', '(no branch yet)');
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
/* ────────────────────────── 改動體檢（AC-7 / AC-8） ────────────────────────── */

/** 這個專案「平常改幾個檔案」——比例尺從自己的歷史算，不自己編門檻（AC-7）。 */
export function changeScale(cwd, sample = 30) {
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

export const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./;

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

export function changeHealth(cwd, since, { skip = null } = {}) {
  // ⚠️ 基準(since)不在這裡決定,在 lib/origin.mjs 的 changeBase():有章比章,沒章比這一輪起點那一刻的版本,
  //    起點問不到才是 null——只看還沒存檔的(HEAD)。以前沒章一律比 HEAD,Claude 一存檔「這次改動」就歸零(規格:這一輪的起點)。
  // 沒帶 HEAD 的 `git diff` 只看得到「還沒 git add」的改動——add 過的整個消失,
  // 畫面會同時寫「2 個檔案還沒存進保險箱」和「沒有改動」(2026-09-11 實測,老毛病 P1)。
  const base = since ?? 'HEAD';
  // skip:從 main 併進來、這個資料夾自己沒動過的檔(lib/origin.mjs 的 mergedIn;規格:併進來的不算這一輪)——清單、行數、既有測試、相依都不算它們。
  //   沒有的話一切照舊,連問 git 的方式都一樣(AC-9)。還沒追蹤的新檔一律算(AC-3:它們不可能是拿進來的)
  const drop = Array.isArray(skip) && skip.length ? new Set(skip) : null;
  const kept = (f) => !drop || !drop.has(unquotePath(f));
  // ⚠️ --no-renames:git 預設會把「刪一個、加一個」配成搬家,--name-only 只印新路徑——搬走危險清單上的檔,分級就看不到它,
  //    T2 掉成 T1(老毛病 P1,魔鬼教官 2026-09-22)。三個問法都關掉配對,行數、檔名、測試檔才是同一種算法
  //    有要拿掉的檔時,行數改問每個檔各幾行(--numstat),只加留下的——總數(--shortstat)分不出是哪幾個檔的
  const stat = drop ? null : git(['diff', '--shortstat', '--no-renames', base], cwd);
  const numstat = drop ? git(['diff', '--numstat', '--no-renames', base], cwd) : null;
  const allNames = git(['diff', '--name-only', '--no-renames', base], cwd);
  const names = allNames === null ? null : allNames.split('\n').filter(Boolean).filter(kept).join('\n');
  // ⚠️ AC-8：只認「被修改」的既有測試（M），不認新增（A）。
  // 寫新功能順便補新測試是好事,天天為它跳警告會讓人關掉這個工具。
  const modifiedTests = git(['diff', '--diff-filter=M', '--name-only', '--no-renames', base], cwd);
  // ⚠️ 不要用 diff 的 `+"lodash": "^4"` 去比對——那**假設 package.json 是一行一個相依**。
  // 壓成一行的 package.json 就完全認不到,而且是安靜地認不到。直接解析兩邊的鍵。
  // ⚠️ 這裡本來寫成 `since ? ... : depsNow`——沒有還原點的時候拿自己跟自己比,
  // 差集永遠是空的,**新增的相依一輩子不會被報出來**。測試抓到的。
  // 基準一律是呼叫端給的那個版本(沒給才是 HEAD),不是工作區自己。
  const pkgPath = join(cwd, 'package.json');
  const depsNow = readDeps(existsSync(pkgPath) ? readFileSync(pkgPath, 'utf8') : null);
  const depsBefore = readDeps(git(['show', `${since ?? 'HEAD'}:package.json`], cwd));

  // ⚠️ `git diff` **看不到還沒被 git 追蹤的新檔案**。
  // AI 生成最常見的產物就是新檔案,漏掉它們會讓改動看起來比實際小——
  // 而「看起來比較安全」正是最危險的錯誤方向。實測抓到:4 個檔案被報成 2 個。
  const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd);
  // 只算新增的,移除不算債務。package.json 是從 main 拿進來、自己沒動過的話,它新加的相依是別的對話加的;兩邊都動過就照算(寧可多算)
  const newDeps = drop?.has('package.json') ? [] : [...depsNow].filter((d) => !depsBefore.has(d));
  const tests = modifiedTests ? modifiedTests.split('\n').filter((f) => f && TEST_FILE.test(f) && kept(f)) : [];
  // 拿掉的是哪幾個(問得到才有):畫面講「另外 N 個從 main 併進來」,N 就是它的個數——要拿的檔裡,真的跟基準有差的那幾個
  const skipped = allNames === null ? [] : allNames.split('\n').filter(Boolean).filter((f) => !kept(f));
  // ⚠️ 問不到就是 null,不是 0(R1)。呼叫端要說「問不到改動」,不准印成「沒有改動」。
  if (names === null || untracked === null) {
    return { files: null, newFiles: null, list: null, touchedTests: null, added: null, removed: null, modifiedTests: tests, newDeps, skipped };
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
  // 有拿掉的檔時,一個檔一行(加、減、路徑),只加留下的;二進位檔寫「-」,跟 shortstat 一樣不算行數
  const lines = drop ? sumNumstat(numstat, kept) : null;
  const added = drop ? lines?.added ?? null : stat === null ? null : Number(stat.match(/(\d+) insertion/)?.[1] ?? 0);
  const removed = drop ? lines?.removed ?? null : stat === null ? null : Number(stat.match(/(\d+) deletion/)?.[1] ?? 0);
  return { files, newFiles, list, touchedTests, added, removed, modifiedTests: tests, newDeps, skipped };
}

/** `git diff --numstat` 的輸出,只加 keep 留下的那幾個檔。問不到(null)回 null——不是 0(R1) */
function sumNumstat(out, keep) {
  if (out === null) return null;
  let added = 0, removed = 0;
  for (const line of out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m || !keep(m[3])) continue;
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') removed += Number(m[2]);
  }
  return { added, removed };
}
/* ────────────────────────── 小工具 ────────────────────────── */

/**
 * 「現在」一次只取一次。同一個事件會在兩個地方各印一次(分級卡的 E 那一行、E 那一格——各自叫 eLines),
 * 改成有秒數之後,兩次叫 ago 差幾毫秒就可能一邊「7 秒前」一邊「8 秒前」(魔鬼教官 2026-10-27 抓到;L18 的形狀搬進正式程式)。
 * 儀表板一次刷新、終端機一次輸出,各包在 withClock 裡;沒包的照舊看現在。
 * ⚠️ 凍住的那一刻比這一批讀到的資料早:終端機記完一筆馬上回讀、儀表板刷新途中感測器剛寫的,都比它新。
 *    那種要講「剛剛」,不准講成「時間對不上」(魔鬼教官第二輪 2026-10-27 抓到,LESSONS L42)。
 */
let frozenNow = null;
export function withClock(fn) {
  const prev = frozenNow;
  frozenNow = Date.now();
  let out;
  try { out = fn(); } catch (e) { frozenNow = prev; throw e; }
  if (out && typeof out.then === 'function') return out.finally(() => { frozenNow = prev; });
  frozenNow = prev;
  return out;
}

export function ago(iso) {
  const t = new Date(iso).getTime();
  // 時鐘被調過(筆電睡醒)會算出負數:說對不上,不編一個看起來正常的數字。拿真的現在比,不拿凍住的那一刻
  if (!Number.isFinite(t) || Date.now() - t < 0) return zhEn('時間對不上', '(time doesn\'t line up)');
  // 凍住的那一刻之後才寫進來的:就是剛剛
  return humanAge(Math.round(Math.max(0, (frozenNow ?? Date.now()) - t) / 1000), langNow());
}

/** 還沒存進保險箱(commit)的檔案有幾個。**這是唯一的一份算法**,網頁那層也用它(老毛病 P2)。
 *  ⚠️ `-uall`:少了它,一個新資料夾不管裡面有幾個檔案都只算 1 行——
 *  「回去會丟掉 1 個檔案」實際是 3 個(2026-09-11 實測),而同畫面另一個數字用 ls-files 算會說 3。
 *  數的就是 dirtyPaths() 那一份的個數:儀表板列出「還沒 commit 的是哪些」,檔名跟這個數字永遠是同一份(規格:先講commit再講蓋章 AC-2) */
export function uncommitted(cwd) {
  const paths = dirtyPaths(cwd);
  return paths === null ? null : paths.size;     // null = 沒問到
}

/** 還沒存進保險箱的**是哪些檔案**(路徑)。問不到回 null。
 *  ⚠️ 不能走 git():它會 trim(),而 porcelain 第一行的開頭就是一個空白（" M a.js"）——
 *     trim 掉之後路徑就切錯位,第一個檔案永遠標不到(2026-09-15 測試抓到)。
 *  ⚠️ `-z`:不加的話,檔名有空白,git status 會加上引號("a b.txt"),改動清單(diff、ls-files)卻不加——
 *     同一個檔對不上,儀表板會把它同時列成「還沒 commit」和「已經 commit」(2026-10-29 寫存檔與蓋章卡時試出來的)。
 *     -z 一律不加引號、不跳脫,一筆一段;改名那一筆寫成「新路徑、舊路徑」兩段。 */
export function dirtyPaths(cwd) {
  const raw = gitRaw(['status', '--porcelain', '-uall', '-z'], cwd);
  if (raw === null) return null;
  const paths = new Set();
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;   // 最後那一段是空的
    const xy = e.slice(0, 2);
    paths.add(e.slice(3));
    // 改名、複製的那一筆後面多一段原本的路徑。改名的舊路徑也是還沒 commit 的改動(它被刪了)——
    // 跟改動清單的 --no-renames 一樣,新舊兩個都算(老毛病 P1);複製的那個原本的檔沒動,不算
    if (/[RC]/.test(xy)) {
      const orig = parts[++i];
      if (xy.includes('R') && orig) paths.add(orig);
    }
  }
  return paths;
}

/** git 一行一個檔名的輸出(diff --name-only、ls-files),替特殊字元加的引號拿掉,換回真的檔名——要跟 dirtyPaths() 那一份比對。
 *  檔名有雙引號、反斜線、tab 這種字元,就算 core.quotepath=false,git 照樣寫成 C 語言那樣:"q\"x.txt"、"a\tb.txt"、"\001.txt";
 *  沒換回來的話,這種檔還沒 commit,存檔與蓋章卡會把它同時列成「還沒 commit」和「已經 commit」(魔鬼教官 2026-10-29,LESSONS L44)。
 *  ⚠️ 八進位那種是位元組:整串收齊再用 UTF-8 解,不能一個一個換成字。沒加引號的照原樣 */
export function unquotePath(p) {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return p;
  const ESC = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const bytes = [];
  for (const m of p.slice(1, -1).matchAll(/\\([0-7]{3}|[\s\S])|[^\\]+/g)) {
    if (m[1] === undefined) bytes.push(...Buffer.from(m[0], 'utf8'));
    else if (/^[0-7]{3}$/.test(m[1])) bytes.push(parseInt(m[1], 8));
    else if (m[1] in ESC) bytes.push(ESC[m[1]]);
    else bytes.push(...Buffer.from(m[0], 'utf8'));   // 看不懂的跳脫照原樣留著,不猜
  }
  return Buffer.from(bytes).toString('utf8');
}

/** 跟 git() 一樣,但回的是**離開碼**——有些問題 git 是用離開碼回答的
 *  (`merge-base --is-ancestor`:0 是、1 不是、其他是「問不到」)。回 null = 跑不起來。 */
export function gitExit(args, cwd) {
  // 一次刷新裡只記 0 和 1——那是 git 的回答;其他離開碼與跑不起來都不記,同一輪再問到就再問(AC-5)
  return asked(['exit', cwd ?? null, args], () => {
    try {
      runGit(['-c', 'core.quotepath=false', ...args], { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
      return 0;
    } catch (e) {
      return typeof e.status === 'number' ? e.status : null;
    }
  }, (v) => v === 0 || v === 1);
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
export function checkpointRelation(cwd, commit) {
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

/** 備份分支的名字。只求看得懂、同一分鐘內不重複;git 對中文分支名沒意見。英文的時候用英文的名字(看得懂才是重點) */
export function backupBranchName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${zhEn('備份-', 'backup-')}${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}
