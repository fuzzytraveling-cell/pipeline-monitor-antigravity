/**
 * lang.mjs —— 人看的字用哪一種語言（中文／英文）：這台電腦一份，儀表板的按鈕與終端機的 --lang 改的是同一份。
 * 規格:儀表板與終端機中英切換（路徑看 AGENTS.md 的表）
 *
 * 入口（status.mjs、server.mjs、gate.mjs）讀一次，用 withLang 包起來，裡面的 zhEn 都照那一種給。
 * 只讀寫 ~/.pipeline-monitor-agy/lang.json，紀錄與章一個位元組都不碰。
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { dataHome, makeDataDir } from './paths.mjs';

export const LANGS = ['zh', 'en'];
const FILE = 'lang.json';

export function langFile(dir) {
  return join(dataHome(dir), FILE);
}

/**
 * 現在選的是哪一種。state: 'unset' 從來沒選過、'ok' 選過、'unreadable' 沒權限讀（如沙盒）、'broken' 讀不懂。
 */
export function readLang(dir) {
  let text;
  try { text = readFileSync(langFile(dir), 'utf8'); }
  catch (e) {
    if (e?.code === 'ENOENT') return { lang: 'zh', state: 'unset' };
    if (e?.code === 'EPERM' || e?.code === 'EACCES') return { lang: 'zh', state: 'unreadable' };
    return { lang: 'zh', state: 'broken' };
  }
  try {
    const v = JSON.parse(text)?.lang;
    return LANGS.includes(v) ? { lang: v, state: 'ok' } : { lang: 'zh', state: 'broken' };
  } catch { return { lang: 'zh', state: 'broken' }; }
}

/**
 * 換成另一種。先寫暫存檔再改名，一次到位。
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

/* ────────────── 這一次輸出用哪一種（withLang） ────────────── */

let current = 'zh';

export function withLang(lang, fn) {
  const prev = current;
  current = lang === 'en' ? 'en' : 'zh';
  let out;
  try { out = fn(); } catch (e) { current = prev; throw e; }
  if (out && typeof out.then === 'function') return out.finally(() => { current = prev; });
  current = prev;
  return out;
}

export function langNow() {
  return current;
}

export function zhEn(zh, en) {
  return current === 'en' ? en : zh;
}

export function plural(n, one, more = `${one}s`) {
  return `${n} ${n === 1 ? one : more}`;
}

/* ────────────── 兩種都要的：AI 寫的格式、技能裡的用語對照 ────────────── */

export function both(zh, en) {
  return { zh, en };
}

export const SPEC_FOLDERS = { planned: both('規劃中', 'planned'), doing: both('進行中', 'in-progress'), done: both('升級摘要', 'done') };
export const PLAIN_LABEL = both('白話', 'In plain words');
export const PENDING_LABEL = both('待討論', 'to discuss');
export const WALK_WORDS = { saw: both('看到了', 'seen'), missing: both('沒看到', 'not seen'), blocked: both('驗不了', 'can\'t verify') };
export const TIER_LABEL = both('分級', 'Tier');
const TIER_PREFIXES = [both('預測至少', 'predicted at least'), both('預測為', 'predicted'), both('預測', 'at least'), both('至少', 'predicted')];
const TIER_UNSET_WORDS = [
  both('還沒設定分級', 'hasn\'t set up tiers'), both('不分級', 'not use tiers'), both('待定', 'not using tiers'),
  both('未定', 'TBD'), both('未知', 'unknown'), both('不知道', 'undecided'), both('無法判斷', 'undecided'), both('還沒決定', 'TBD'),
];

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anyOf = (words) => `(?:${words.map((w) => reEsc(w).replace(/'/g, '[\'’]')).join('|')})`;

export function specDirNames(kinds = ['planned', 'doing', 'done']) {
  return [...kinds.map((k) => SPEC_FOLDERS[k].zh), ...kinds.map((k) => SPEC_FOLDERS[k].en)];
}
export function specDirRe(kinds = ['planned', 'doing', 'done']) {
  return anyOf(specDirNames(kinds));
}
export const PLAIN_LINE = new RegExp(`^>\\s*\\*\\*${anyOf([PLAIN_LABEL.zh, PLAIN_LABEL.en])}(?:\\*\\*[:\\uFF1A]|[:\\uFF1A]\\*\\*)\\s*(.*)$`, 'i');
export const PENDING_HEAD = new RegExp(`⏳\\s*${anyOf([PENDING_LABEL.zh, PENDING_LABEL.en])}?\\s*[:\\uFF1A]?\\s*`, 'i');
export const TIER_LINE = new RegExp(`^\\s*\\*{0,2}${anyOf([TIER_LABEL.zh, TIER_LABEL.en])}\\*{0,2}\\s*[:\\uFF1A]\\s*(.+)$`, 'i');
export const TIER_PREFIX_RE = new RegExp(
  `^${anyOf([...new Set(TIER_PREFIXES.flatMap((x) => [x.zh, x.en]))].sort((a, b) => b.length - a.length)).replace(/\s+/g, '\\s+')}\\s*`,
  'i',
);
export const TIER_UNSET_RE = new RegExp(
  `(?:^<|${anyOf([...new Set(TIER_UNSET_WORDS.flatMap((x) => [x.zh, x.en]))].sort((a, b) => b.length - a.length)).replace(/\s+/g, '\\s+')})`,
  'i',
);
export function walkWordRe() {
  return anyOf(Object.values(WALK_WORDS).flatMap((w) => [w.zh, w.en]).sort((a, b) => b.length - a.length));
}

/**
 * 用語對照：AI 用英文跟使用者講話時，紅線那幾個字照這張表講。
 * 每一支技能裡的那張表與這裡逐字對齊（scripts/skills.test.mjs，老毛病 P2）。
 */
export const TERMS = [
  { ...both('叫了／跑過（記號 ⏸，一定帶過了多久）', 'called / ran (mark ⏸, always with how long ago)'), not: 'passed, succeeded, done, ✓' },
  { ...both('找過（魔鬼教官的結論）', 'looked (the Chaos check conclusion)'), not: 'passed, all clear, no problems' },
  { ...both('沒對到已知死法', 'didn\'t match any known failure pattern'), not: 'passed, all clear, no problems, safe' },
  { ...both('走過一遍（驗收那一支走的）', 'walked through (what the Acceptance skill does)'), not: 'verified, accepted, passed, tested' },
  { ...both('看到了／沒看到／驗不了', 'seen / not seen / can\'t verify'), not: 'passed, failed, verified' },
  { ...both('驗收過了（只有使用者能說）', 'accepted (only the user can say it)'), not: 'verified, tested, passed' },
  { ...both('不用再跑／不用再走', 'no need to run it again / no need to walk through it again'), not: 'accepted, passed, done' },
  { ...both('處理完了', 'handled'), not: 'fixed, resolved, passed' },
  { ...both('沒有紀錄', 'no record'), not: 'not run, never ran, skipped' },
  { ...both('問不到', 'couldn\'t check'), not: 'none, 0, no …' },
  { ...both('看不全／看不到', 'can\'t see all of it / can\'t see'), not: 'no changes, none' },
  { ...both('檢查全綠', 'all checks green'), not: 'works, passed, verified, safe' },
  { ...both('先停下來問使用者', 'stop and ask the user first'), not: 'failed, error, blocked' },
  { ...both('使用者說／AI 代記／分不出是誰', 'the user said / AI recorded it for them / can\'t tell who'), not: 'a guessed subject' },
  { ...both('可能', 'might'), not: 'will, is' },
  { ...both('前 N 個字', 'the first N characters'), not: 'words' },
];
export function termsTable() {
  const head = both('中文', 'Chinese'), never = both('不准說', 'never say');
  return [`| ${head.zh} | English | ${never.zh} (${never.en}) |`, '|---|---|---|', ...TERMS.map((t) => `| ${t.zh} | ${t.en} | ${t.not} |`)];
}
export const RED_LINES_EN = [
  '- **R1 Never say "none" when you didn\'t get an answer**: would this sentence become a lie when the answer couldn\'t be obtained?',
  '- **R2 Never say "passed" when it only ran**: what is the only thing this feedback proves? That a command was called, or that the thing actually worked?',
  '- **R3 Never make up numbers**: is this number\'s denominator a fact you can look up, or made up?',
];

export function walkWordOf(word) {
  const w = String(word ?? '').toLowerCase().replace(/’/g, '\'');
  return Object.entries(WALK_WORDS).find(([, x]) => x.zh === w || x.en.toLowerCase() === w)?.[0] ?? null;
}

export function langBrokenLine() {
  return zhEn('⚠️ 語言設定讀不懂，先用中文（Couldn\'t read the language setting, so this is in Chinese for now: agy-pipeline --lang en）',
    '⚠️ Couldn\'t read the language setting, so this is in Chinese for now: agy-pipeline --lang en');
}

export function langUnreadableLine() {
  return zhEn('⚠️ 沒有權限讀語言設定，先用中文（No permission to read the language setting, so this is in Chinese for now）',
    '⚠️ No permission to read the language setting, so this is in Chinese for now');
}

/* ────────────── agy-pipeline --lang ────────────── */

const whyNot = (code) => ({ EACCES: zhEn('沒有權限', 'no permission'), EPERM: zhEn('沒有權限', 'no permission'), ENOSPC: zhEn('磁碟滿了', 'the disk is full'),
  EROFS: zhEn('那裡是唯讀的', 'that place is read-only') })[code] ?? null;

export function doLang(arg, dir) {
  const now = readLang(dir);
  const want = typeof arg === 'string' ? arg.trim().toLowerCase() : '';
  if (!want) {
    if (now.state === 'unreadable') {
      withLang(now.lang, () => console.log(zhEn(`沒有權限讀語言設定（${langFile(dir)}），分不出現在設的是中文還是英文。請在自己的終端機跑 agy-pipeline --lang。`,
        `No permission to read the language setting (${langFile(dir)}), so I can't tell whether it's Chinese or English. Run agy-pipeline --lang in your own terminal.`)));
      return 1;
    }
    withLang(now.lang, () => console.log(now.state === 'broken' ? langBrokenLine()
      : zhEn(`現在是中文${now.state === 'unset' ? '（從來沒選過，就是中文）' : ''}。要換成英文：agy-pipeline --lang en`,
        'Currently English. To switch to Chinese: agy-pipeline --lang zh')));
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
    console.log(zhEn('改成中文了。agy-pipeline 下一次就是中文；開著的儀表板下一次更新（5 秒內）跟著換。',
      'Switched to English. agy-pipeline is in English from the next run; an open dashboard follows at its next refresh (within 5 seconds).'));
    console.log(zhEn('（儀表板的服務還在跑舊的程式的話，它不會跟著換——先跑 agy-pipeline --serve-restart）',
      '(If the dashboard service is still running the old program, it won\'t follow: run agy-pipeline --serve-restart first)'));
  });
  return 0;
}
