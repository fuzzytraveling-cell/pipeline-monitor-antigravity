/**
 * lang.mjs —— 人看的字用哪一種語言(中文／英文):這台電腦一份,儀表板的按鈕與終端機的 --lang 改的是同一份。
 * 規格:儀表板與終端機中英切換(路徑看 CLAUDE.md 的表)
 *
 * ⚠️ 不跟 LANG(系統語言)走:Claude 替你跑的指令裡它是空的,儀表板的背景服務(launchd)的設定裡也沒有(2026-10-29 在這台看過)——
 *    跟它走的話,同一台電腦你打的 pipeline-status 跟 Claude 打的、終端機跟儀表板,會各講各的語言。
 * ⚠️ 從來沒選過＝中文(只對這台電腦成立:新裝的人第一次看到哪一種,留給一句話安裝那一段)。
 *    設定檔讀不懂(被改壞、寫了不認得的語言)也先用中文,但要講出來(langBrokenLine)——讀不懂不等於沒選過,不准默默用(R1)。
 * ⚠️ 句子不自己讀這個檔:入口(status.mjs、server.mjs)讀一次,用 withLang 把這一次輸出包起來,裡面的 zhEn 都照那一種給——
 *    跟 lib/git.mjs 的 withClock 同一個做法。句子各自讀的話,你在一個指令跑到一半的那一刻切了,同一頁就半中半英。
 *    沒包的照舊是中文:收工 hook、Claude 替你跑的那幾個指令(另一份規格才翻)就是靠這個一個字不變。
 * 這支只讀寫它自己那一個檔:改錯了是畫面講錯語言,看得見;紀錄與章一個位元組都不碰。
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { dataHome, makeDataDir } from './paths.mjs';

/** 只有這兩種。不加第三種(規格的明確不做)。 */
export const LANGS = ['zh', 'en'];
const FILE = 'lang.json';

/** 設定檔在哪:資料的家(lib/paths.mjs 的 dataHome)底下。dir 只給測試與伺服器(跟 dataHome 同一個意思) */
export function langFile(dir) {
  return join(dataHome(dir), FILE);
}

/**
 * 現在選的是哪一種。state:'unset' 從來沒選過、'ok' 選過、'broken' 讀不懂(壞掉、不認得的語言、沒有權限讀)。
 * 讀不懂跟沒選過一樣先用中文,呼叫端要講一句(langBrokenLine)。
 * @returns {{lang:'zh'|'en', state:'unset'|'ok'|'broken'}}
 */
export function readLang(dir) {
  let text;
  try { text = readFileSync(langFile(dir), 'utf8'); }
  catch (e) { return { lang: 'zh', state: e?.code === 'ENOENT' ? 'unset' : 'broken' }; }
  try {
    const v = JSON.parse(text)?.lang;
    return LANGS.includes(v) ? { lang: v, state: 'ok' } : { lang: 'zh', state: 'broken' };
  } catch { return { lang: 'zh', state: 'broken' }; }
}

/**
 * 換成另一種。先寫暫存檔再改名,一次到位:同一刻讀的人(儀表板每 5 秒讀一次)不會讀到寫一半的檔、把它講成讀不懂。
 * @returns {string|null}  null = 寫成了;失敗回錯誤代碼(EACCES 之類,沒有就是 'error'),呼叫端講「寫不進去,沒有切換」
 */
export function writeLang(lang, dir) {
  if (!LANGS.includes(lang)) return 'unknown-lang';
  const file = langFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    makeDataDir(dataHome(dir));
    writeFileSync(tmp, `${JSON.stringify({ lang })}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return null;
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 沒寫出來就沒有暫存檔 */ }
    return typeof e?.code === 'string' ? e.code : 'error';
  }
}

/* ────────────── 這一次輸出用哪一種(withLang) ────────────── */

let current = 'zh';

/** 這一次輸出(一個指令、儀表板一次算資料)用哪一種。fn 回 promise 也等它結束才換回來。 */
export function withLang(lang, fn) {
  const prev = current;
  current = lang === 'en' ? 'en' : 'zh';
  let out;
  try { out = fn(); } catch (e) { current = prev; throw e; }
  if (out && typeof out.then === 'function') return out.finally(() => { current = prev; });
  current = prev;
  return out;
}

/** 現在這一次輸出是哪一種。給要把語言帶給別人的地方用(lib/freshness.mjs、伺服器回應的 lang 欄)——句子本身用 zhEn */
export function langNow() {
  return current;
}

/**
 * 中文、英文並排寫在一起,照這一次輸出的語言給一種。⚠️ 兩種都要寫:scripts/lang.test.mjs 掃程式字串,
 * 中文只准出現在這裡面(前一個參數),後一個參數不准有中文、不准是空的。英文要整句寫,不從中文切出來或拼出來。
 */
export function zhEn(zh, en) {
  return current === 'en' ? en : zh;
}

/** 英文的單複數:1 file／2 files。數字是句子的一部分,一起給 */
export function plural(n, one, more = `${one}s`) {
  return `${n} ${n === 1 ? one : more}`;
}

/* ────────────── 兩種都要的:Claude 寫的格式、技能裡的用語對照(規格:技能與寫給AI的話中英切換,路徑看 CLAUDE.md 的表) ────────────── */

/**
 * 中文、英文一對,兩種都要的時候用——不是照這一次輸出挑一種:Claude 用哪一種寫,讀的那一端都認(AC-3);技能裡的對照表兩欄都印(AC-2)。
 * ⚠️ 跟 zhEn 同一條規矩:scripts/_zhscan.mjs 把它當成 zhEn 掃——中文只准住在前一個參數,後一個不准有中文、不准是空的。
 */
export function both(zh, en) {
  return { zh, en };
}

/**
 * 規格住的三個資料夾(工作項的狀態就是路徑):中文一套、英文一套,兩套都認——同一個專案兩套都有也都認(AC-3)。
 * 寫進哪一套是寫規格那一支的事:專案裡已經有哪一套就用哪一套,都沒有才照使用者講的語言(AC-4)。
 * 讀的那幾處(lib/checklist.mjs、lib/rounds.mjs、lib/cliReport.mjs)都從這裡拿,不各寫一份正則(老毛病 P2)。
 */
export const SPEC_FOLDERS = { planned: both('規劃中', 'planned'), doing: both('進行中', 'in-progress'), done: both('升級摘要', 'done') };
/** AC 底下給人看的那一句的標籤:> **白話**：…／> **In plain words**: … */
export const PLAIN_LABEL = both('白話', 'In plain words');
/** 還不能打勾、要跟人討論:⏳ 待討論：原因／⏳ to discuss: reason */
export const PENDING_LABEL = both('待討論', 'to discuss');
/** E 回報每一條的三種結果:AC-1 看到了：「原文」／AC-1 seen: "original text" */
export const WALK_WORDS = { saw: both('看到了', 'seen'), missing: both('沒看到', 'not seen'), blocked: both('驗不了', 'can\'t verify') };

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 正則裡「其中一個字」那一段(不捕捉)。英文的撇號兩種都認:' 跟自動換成的彎撇號 ’ */
const anyOf = (words) => `(?:${words.map((w) => reEsc(w).replace(/'/g, '[\'’]')).join('|')})`;

/** 規格資料夾的名字:kinds 那幾種狀態('planned'／'doing'／'done'),中文的在前、英文的在後 */
export function specDirNames(kinds = ['planned', 'doing', 'done']) {
  return [...kinds.map((k) => SPEC_FOLDERS[k].zh), ...kinds.map((k) => SPEC_FOLDERS[k].en)];
}
/** 「docs/<規格資料夾>/」中間那一段的正則片段:kinds 那幾種狀態、兩種語言都認 */
export function specDirRe(kinds = ['planned', 'doing', 'done']) {
  return anyOf(specDirNames(kinds));
}
/** 規格檔裡「白話」那一行(兩種標籤都認);是的話第 1 組是那一句 */
export const PLAIN_LINE = new RegExp(`^>\\s*\\*\\*${anyOf([PLAIN_LABEL.zh, PLAIN_LABEL.en])}\\*\\*[:\\uFF1A]\\s*(.*)$`, 'i');
/** AC 標題行末尾 ⏳ 後面那一段的開頭(待討論：／to discuss:),拿掉之後剩下的是原因 */
export const PENDING_HEAD = new RegExp(`⏳\\s*${anyOf([PENDING_LABEL.zh, PENDING_LABEL.en])}?\\s*[:\\uFF1A]?\\s*`, 'i');
/** E 回報那三種結果的正則片段(兩種語言)。長的排前面:not seen 要比 seen 先比(老毛病 P4) */
export function walkWordRe() {
  return anyOf(Object.values(WALK_WORDS).flatMap((w) => [w.zh, w.en]).sort((a, b) => b.length - a.length));
}
/** 回報裡寫的那個字是哪一種結果('saw'／'missing'／'blocked');認不得回 null */
export function walkWordOf(word) {
  const w = String(word ?? '').toLowerCase().replace(/’/g, '\'');
  return Object.entries(WALK_WORDS).find(([, x]) => x.zh === w || x.en.toLowerCase() === w)?.[0] ?? null;
}

/** 設定檔讀不懂時,最上面那一條(儀表板)與最上面那一行(終端機)講的那一句。讀不懂一定是用中文,所以附一句英文給看不懂中文的人 */
export function langBrokenLine() {
  return zhEn('⚠️ 語言設定讀不懂，先用中文（Couldn\'t read the language setting, so this is in Chinese for now: pipeline-status --lang en）',
    '⚠️ Couldn\'t read the language setting, so this is in Chinese for now: pipeline-status --lang en');
}

/* ────────────── pipeline-status --lang ────────────── */

/** 寫不進去的原因(錯誤代號)翻成白話;代號本身不印給人看 */
const whyNot = (code) => ({ EACCES: zhEn('沒有權限', 'no permission'), EPERM: zhEn('沒有權限', 'no permission'), ENOSPC: zhEn('磁碟滿了', 'the disk is full'),
  EROFS: zhEn('那裡是唯讀的', 'that place is read-only') })[code] ?? null;

/**
 * --lang:不帶字講現在是哪一種;zh／en 換過去,印出來的那句用新的那一種講;其他的講只有這兩種、不改(AC-1)。
 * 換成了只代表設定檔寫好了:開著的儀表板要等它下一次更新,儀表板的服務還在跑舊的程式就不會跟——照實講(R2)。
 * @returns {number} 結束碼:換不成、不認得是 1
 */
export function doLang(arg, dir) {
  const now = readLang(dir);
  const want = typeof arg === 'string' ? arg.trim().toLowerCase() : '';
  if (!want) {
    withLang(now.lang, () => console.log(now.state === 'broken' ? langBrokenLine()
      : zhEn(`現在是中文${now.state === 'unset' ? '（從來沒選過，就是中文）' : ''}。要換成英文：pipeline-status --lang en`,
        'Currently English. To switch to Chinese: pipeline-status --lang zh')));
    return 0;
  }
  if (!LANGS.includes(want)) {
    withLang(now.lang, () => console.log(zhEn(`只有 zh（中文）、en（英文）兩種，不認得「${arg}」，沒有改。`,
      `There are only zh (Chinese) and en (English); "${arg}" isn't one of them, so nothing changed.`)));
    return 1;
  }
  const err = writeLang(want, dir);
  if (err) {
    withLang(now.lang, () => {
      const why = whyNot(err);
      console.log(zhEn(`語言設定寫不進去（${langFile(dir)}${why ? `：${why}` : ''}），沒有切換。`,
        `Couldn't write the language setting (${langFile(dir)}${why ? `: ${why}` : ''}), so nothing switched.`));
    });
    return 1;
  }
  withLang(want, () => {
    console.log(zhEn('改成中文了。pipeline-status 下一次就是中文；開著的儀表板下一次更新（5 秒內）跟著換。',
      'Switched to English. pipeline-status is in English from the next run; an open dashboard follows at its next refresh (within 5 seconds).'));
    console.log(zhEn('（儀表板的服務還在跑舊的程式的話，它不會跟著換——先跑 pipeline-status --serve-restart）',
      '(If the dashboard service is still running the old program, it won\'t follow: run pipeline-status --serve-restart first)'));
  });
  return 0;
}
