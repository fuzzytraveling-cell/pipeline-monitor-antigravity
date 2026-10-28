/**
 * paths.mjs —— 「程式在哪」跟「資料在哪」不准綁在一起
 *
 * ⚠️ 2026-09-15 實測:app 把儀表板重開在一個 worktree 裡,程式碼一模一樣,但 logs/ 與 checkpoints/
 *    住在主資料夾——worktree 裡沒有,畫面就照實說「還沒有任何案件」。Oscar 以為斷線了(LESSONS L17)。
 * ⚠️ 2026-10-28(規格:紀錄搬到固定的家):資料連主資料夾都不住了,改住固定的 ~/.pipeline-monitor。
 *    別人從 marketplace 裝的時候,程式是一個版本一個資料夾、更新後舊的會被清掉——紀錄跟著程式住,就會跟著舊版本安靜地消失。
 *    程式的主資料夾(codeHome)只剩「要指向程式」的地方用:plugin 捷徑、舊接法的 hook 路徑、背景服務。
 *
 * 搬家(這一版以前的紀錄住在程式的主資料夾):
 *   - 還沒搬之前,寫的跟讀的都照舊用舊的地方(pickDir;hook.sh 有同一條規則的 sh 版本)。新版要是先寫新家、舊的還沒搬,
 *     就是兩邊各一半——而讀的人照檔案裡的先後算「最後一次」,事後把舊的接在新檔尾巴,舊紀錄會被當成最新的。
 *   - 搬 = 整個資料夾一次改名到新家(同一顆磁碟上一次到位),然後在舊的位置放一個指向新家的捷徑:
 *     還在跑舊程式的儀表板服務、改名那一刻正要寫進舊位置的感測器,都照著捷徑寫進新家(AC-4)。
 *   - 只有 node 這一端會搬;感測器只照規則選地方,熱路徑不做搬家這種事。
 *   - 只在「預設的家」才搬、才看舊的地方:有人用環境變數指定了家或紀錄位置(測試一律會,_harness.mjs)、
 *     或呼叫端給了自己的資料夾,舊的地方一律不碰——在 worktree 裡跑測試時,「舊的地方」就是這台電腦真的紀錄(AC-7)。
 *     家目錄被換掉了(測試、拿 HOME=$(mktemp -d) 試一台全新的電腦)也不碰:新家會落在暫存資料夾裡,這時候搬,
 *     就是把真的紀錄整個搬進一個用完就丟的地方(魔鬼教官第一輪抓到)。
 *   - 同一刻只准一個程式搬(新家裡的 .moving 鎖):兩個一起搬,後到的那個透過捷徑讀到新家自己,
 *     把每一顆章當成「同名的兩份」改名藏起來——還原點全部看不見,上方也不講(魔鬼教官第一輪,重跑 30 次有 6 次出事)。
 */
import {
  existsSync, statSync, lstatSync, realpathSync, mkdirSync, renameSync, symlinkSync, readdirSync, rmdirSync,
  linkSync, unlinkSync, readFileSync, appendFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 這支程式自己的資料夾(lib/ 的上一層)。 */
const CODE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** 資料的家底下的兩種資料夾。 */
export const KINDS = ['logs', 'checkpoints'];

/**
 * 這份程式碼所屬 repo 的主資料夾。不是 worktree(或根本不在 git 裡)就是它自己。
 * 只給「要指向程式」的地方用:worktree 是暫時的,刪掉之後指過去的 hook、捷徑、背景服務就靜默失效(L13 的形狀)。
 * PIPELINE_MONITOR_CODE_HOME 只給測試:在 worktree 裡跑測試時,主資料夾可能還沒有這條分支新加的腳本(LESSONS L17 的第二次)。
 */
export function codeHome(codeDir = CODE_DIR) {
  const forced = process.env.PIPELINE_MONITOR_CODE_HOME;
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

const real = (p) => { try { return realpathSync(p); } catch { return null; } };
let programDirs = null;   // 這支程式自己的資料夾與它的主資料夾;一個程式裡不會變,只算一次(主資料夾要問 git)
function isProgramDir(dir) {
  programDirs ??= [real(CODE_DIR), real(codeHome(CODE_DIR))].filter(Boolean);
  const r = real(dir);
  return r !== null && programDirs.includes(r);
}

/**
 * 資料的家:呼叫端給的資料夾(測試的暫存資料夾)> PIPELINE_MONITOR_HOME > ~/.pipeline-monitor。
 * 正式的呼叫給的都是這支程式自己的資料夾(或不給)——程式自己的資料夾永遠不是資料的家。
 * PIPELINE_MONITOR_HOME 是**設定**不是測試專用後門:真的有人會想把紀錄放別處。hook.sh 看同一個變數(老毛病 P2)。
 */
export function dataHome(dir = CODE_DIR) {
  if (dir && !isProgramDir(dir)) return dir;
  return process.env.PIPELINE_MONITOR_HOME || join(homedir(), '.pipeline-monitor');
}

/**
 * 帳號真正的家目錄(不看 HOME:測試、試驗會換掉它)。
 * PIPELINE_MONITOR_TEST_REAL_HOME 只給測試:假裝那個假的家目錄就是真的,才測得到「舊的地方」那條路。
 * ⚠️ 只准配假的程式資料夾(scripts/home.test.mjs 的 fakeProgram)——配真的程式,舊的地方就是這台電腦真的紀錄。hook.sh 看同一個變數。
 */
function accountHome() {
  if (process.env.PIPELINE_MONITOR_TEST_REAL_HOME) return process.env.PIPELINE_MONITOR_TEST_REAL_HOME;
  try { return userInfo().homedir; } catch { return null; }
}

/** 這一版以前資料住的地方(程式的主資料夾)。只有預設的家才有舊家;指定了家或紀錄位置、呼叫端給了資料夾、家目錄被換掉了 → null,舊的地方一律不碰。 */
export function legacyHome(dir = CODE_DIR) {
  if (process.env.PIPELINE_MONITOR_HOME || process.env.PIPELINE_MONITOR_LOG_DIR) return null;
  if (dir && !isProgramDir(dir)) return null;
  const acct = accountHome();
  if (!acct || real(homedir()) === null || real(homedir()) !== real(acct)) return null;
  const old = codeHome(CODE_DIR);
  const r = real(old);
  return r !== null && r === real(dataHome(dir)) ? null : old;   // 有人把程式本身放在家裡:舊家就是新家,沒得搬
}

/** 是一個真的資料夾(不是捷徑、不是檔案)。舊的位置搬過之後是一個捷徑,那就不算舊家還在。 */
function isRealDir(p) {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

/**
 * 規則本身:新家有就用新家;新家還沒有、舊的地方是真的資料夾(還沒搬)→ 照舊用舊的;都沒有 → 新家。
 * hook.sh 的 pick_log_dir 是同一條規則的 sh 版本——測試拿這個函式跟它對答案(AC-2)。
 */
export function pickDir({ kind, home, legacy = null }) {
  const neu = join(home, kind);
  if (existsSync(neu)) return neu;
  if (legacy && isRealDir(join(legacy, kind))) return join(legacy, kind);
  return neu;
}

/**
 * 現在該讀寫哪一個資料夾(kind:'logs'|'checkpoints')。PIPELINE_MONITOR_LOG_DIR 只管紀錄,跟 hook.sh 看同一個變數。
 * 第一次問的時候順便搬家(settle):搬得成就是新家;搬不成照舊用舊的,畫面講(moveState、AC-5)。
 * 讀的、寫的都要叫這一個——各算一次,遲早一個寫 A、一個去 B 找(老毛病 P2、P3)。
 */
export function dataDir(kind, dir = CODE_DIR) {
  if (kind === 'logs' && process.env.PIPELINE_MONITOR_LOG_DIR) return process.env.PIPELINE_MONITOR_LOG_DIR;
  const legacy = legacyHome(dir);
  if (legacy) settle(legacy, dataHome(dir));
  return pickDir({ kind, home: dataHome(dir), legacy });
}

/** 寫之前把資料夾建起來。新建的只給自己讀寫(AC-6:紀錄裡有使用者打的字);已經存在的不動它的權限。 */
export function makeDataDir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
}

/* ────────────────────────── 搬家 ────────────────────────── */

const settled = new Map();   // 一個程式只試搬一次;結果留著,畫面講得出搬不成的原因
function settle(from, to) {
  const key = `${from}\n${to}`;
  if (!settled.has(key)) settled.set(key, moveData({ from, to }));
  return settled.get(key);
}

/**
 * 把舊家(from)的 logs/、checkpoints/ 搬到新家(to)。可以重跑:搬過的(舊的位置已經是捷徑)不會再搬,一筆都不會重複。
 * 新家還沒有那一種 → 整個資料夾改名過去、舊的位置放捷徑。新家已經有(不該發生,除非有人手動放了東西)→ 不覆蓋任何一份:
 * 新家沒有的搬過去;同名的 .json(章、收工 hook 的心跳)留時間新的、舊的改名留著;同名的紀錄留在原地,畫面講(AC-3、AC-5)。
 * 任何錯誤都吞掉、記在回傳值裡:搬不成就照舊用舊的地方,收工 hook 也照常放行。
 * @returns {{moved:string[], pending:{kind:string, why:string, left?:string[]}[], busy?:true}}  busy:別的程式正在搬,這一次沒動
 */
export function moveData({ from, to }) {
  const moved = [], pending = [];
  const todo = KINDS.filter((k) => isRealDir(join(from, k)));
  if (!todo.length) return { moved, pending };   // 沒有要搬的(沒有舊的、或已經是捷徑):連鎖都不用拿
  try { makeDataDir(to); } catch (e) { return { moved, pending: todo.map((kind) => ({ kind, why: codeOf(e) })) }; }
  // 同一刻只准一個程式搬。搶不到 = 別人正在搬:這一次不搬,讀寫照規則選(搬完之前是舊的、搬完之後是新的),不會兩邊各一半
  if (!takeLock(to)) return { moved, pending, busy: true };
  try {
    for (const kind of KINDS) moveKind(kind, from, to, moved, pending);
    if (moved.length) excludeInGit(from);
  } finally {
    dropLock(to);
  }
  return { moved, pending };
}

const codeOf = (e) => (typeof e?.code === 'string' ? e.code : 'error');
const LOCK = '.moving';
const STALE_LOCK_MS = 60_000;   // 搬一次只要幾毫秒;一分鐘還在,就是拿著它的程式搬到一半當掉了

/** 在新家建鎖(建資料夾是一次到位的:只有一個程式建得起來)。舊的鎖放太久 → 收掉再搶一次;搶不到就算了,下一次再搬。 */
function takeLock(to) {
  const lock = join(to, LOCK);
  try { mkdirSync(lock); return true; } catch (e) { if (e?.code !== 'EEXIST') return false; }
  try {
    if (Date.now() - statSync(lock).mtimeMs < STALE_LOCK_MS) return false;
    rmdirSync(lock);
    mkdirSync(lock);
    return true;
  } catch { return false; }
}
function dropLock(to) {
  try { rmdirSync(join(to, LOCK)); } catch { /* 收不掉就留著,一分鐘後別人會收 */ }
}

/** 搬一種(logs 或 checkpoints)。拿到鎖之後才看舊的還在不在——上一個拿鎖的可能剛搬完,這裡看到的就是捷徑,不准再碰。 */
function moveKind(kind, from, to, moved, pending) {
  const src = join(from, kind), dst = join(to, kind);
  if (!isRealDir(src)) return;
  try {
    if (!existsSync(dst)) {
      // 一次到位:改名之前就打開了舊檔的人,寫的還是同一份(檔案跟著資料夾一起過去);改名之後才要打開的,走下面那個捷徑
      renameSync(src, dst);
      pointBack(dst, src);
      moved.push(kind);
      return;
    }
    const left = mergeInto(src, dst);
    if (left.length) { pending.push({ kind, why: 'both', left }); return; }
    rmdirSync(src);   // 空了才刪得掉;這一刻又有人寫進來就丟錯,下一次再搬
    pointBack(dst, src);
    moved.push(kind);
  } catch (e) {
    pending.push({ kind, why: codeOf(e) });
  }
}

/**
 * 舊的位置留下的捷徑,不准變成那個 repo「還沒存的檔」:寫進這台電腦自己的 .git/info/exclude(不進版控,每個版本、每個 worktree 都看)。
 * 退回這次以前的版本時,那時候的 .gitignore 只擋資料夾、擋不住捷徑——主資料夾蓋不了章,照工具的建議 git add -A 就存進去、
 * stash 就收走,舊版畫面看起來歷史全沒了(魔鬼教官第一輪)。不是一個 repo 的主資料夾就不動;寫不進去就算了。
 */
function excludeInGit(repo) {
  const dotGit = join(repo, '.git');
  if (!isRealDir(dotGit)) return;
  const f = join(dotGit, 'info', 'exclude');
  let text = '';
  try { text = readFileSync(f, 'utf8'); } catch { /* 沒有就建 */ }
  const have = new Set(text.split('\n').map((l) => l.trim()));
  const want = KINDS.map((k) => `/${k}`).filter((l) => !have.has(l));
  if (!want.length) return;
  try {
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, `${text && !text.endsWith('\n') ? '\n' : ''}# pipeline-monitor:紀錄搬到 ~/.pipeline-monitor 之後,舊的位置留下的捷徑\n${want.join('\n')}\n`);
  } catch { /* 見上 */ }
}

/** 在舊的位置放一個指向新家的捷徑。放不了(別人先放了、或那一刻又長出一個資料夾)就算了:下一次當成兩邊都有處理。 */
function pointBack(dst, src) {
  try { symlinkSync(dst, src, 'dir'); } catch { /* 見上 */ }
}

/** 搬一個檔或資料夾,絕不蓋掉新家已經有的:檔案用 link(對方有了就失敗),資料夾用改名。 */
function moveNoClobber(a, b) {
  if (isRealDir(a)) { renameSync(a, b); return; }
  linkSync(a, b);
  unlinkSync(a);
}

/** 兩個路徑是不是同一個檔(透過捷徑讀到新家自己的時候就是)。 */
function sameFile(a, b) {
  try { const x = statSync(a), y = statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
}

/** 章、心跳這種一整份的 .json:留時間新的,舊的改名留著(不以 .json 結尾:讀的人不會把它當成一顆章)。同一個檔不准當成兩份。 */
function keepNewer(a, b) {
  if (sameFile(a, b)) return;
  const timeOf = (p) => {
    try { const at = Date.parse(JSON.parse(readFileSync(p, 'utf8')).at); if (Number.isFinite(at)) return at; } catch { /* 改看檔案時間 */ }
    return statSync(p).mtimeMs;
  };
  const older = `${b}.older-${Date.now()}`;
  if (timeOf(a) > timeOf(b)) { renameSync(b, older); moveNoClobber(a, b); } else moveNoClobber(a, older);
}

/** 兩邊都有的時候,一個一個搬。回留在原地的名字(相對 src)。兩邊其實是同一個資料夾(捷徑)就什麼都不做。 */
function mergeInto(src, dst) {
  const left = [];
  if (real(src) !== null && real(src) === real(dst)) return left;
  for (const name of readdirSync(src)) {
    const a = join(src, name), b = join(dst, name);
    try {
      if (!existsSync(b)) { moveNoClobber(a, b); continue; }
      if (isRealDir(a) && isRealDir(b)) {
        const sub = mergeInto(a, b);
        if (sub.length) left.push(...sub.map((s) => join(name, s))); else rmdirSync(a);
        continue;
      }
      if (name.endsWith('.json') && !isRealDir(a) && !isRealDir(b)) { keepNewer(a, b); continue; }
      left.push(name);   // 同名的紀錄(.jsonl):兩份都有人在寫,接起來先後會亂——不合併,畫面講
    } catch {
      left.push(name);
    }
  }
  return left;
}

/**
 * 搬家還沒搬完的話,是什麼樣子(AC-5:畫面不准說「還沒有任何案件」)。沒有舊家、或舊家已經搬乾淨 → null。
 * 看的是磁碟上的事實,不是這個程式記得的結果——別的程式後來搬成了,這裡就不再講還沒搬。
 * @returns {{from:string, to:string, kinds:string[], why:string|null, both:boolean}|null}
 *   both:新家也有(還沒搬的那一份這裡讀不到);否則新家還沒有,讀寫照舊用舊的地方
 */
export function moveState(dir = CODE_DIR) {
  const legacy = legacyHome(dir);
  if (!legacy) return null;
  const home = dataHome(dir);
  const kinds = KINDS.filter((k) => isRealDir(join(legacy, k)) && hasData(join(legacy, k)));
  if (!kinds.length) return null;
  const run = settled.get(`${legacy}\n${home}`);
  const why = run?.pending.find((p) => kinds.includes(p.kind) && p.why !== 'both')?.why ?? null;
  return { from: legacy, to: home, kinds, why, both: kinds.some((k) => existsSync(join(home, k))) };
}

/** 資料夾裡有沒有東西(`.` 開頭的暫存檔不算)。 */
function hasData(d) {
  try { return readdirSync(d).some((n) => !n.startsWith('.')); } catch { return false; }
}
