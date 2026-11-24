/**
 * verify.mjs —— E 驗收:Claude 照規格在畫面上走一遍的結論怎麼讀、E 那一格的三句話怎麼講。規格:E 自動驗收(路徑看 CLAUDE.md 的表)
 *
 * 三種證據分開講(AC-7):開過瀏覽器(感測器記的動作)、Claude 說走了一遍(verify 記的結論)、你說驗收過了(只有你能說)。
 * 文案只住這裡:終端機(status.mjs)、網頁(伺服器照這裡算好放進資料,lib/collect.mjs)、分級卡(lib/tier.mjs)共用(老毛病 P2)。
 * ⚠️ 「看到了」是 Claude 說的,不是驗收通過(R2):這裡沒有任何一句話會把它講成「過了」,記號也不用打勾。
 * ⚠️ 讀不懂的行照原文列,不算進任何一種(R1):少算一條看起來就像那一條沒問題。
 * 中英兩種並排(規格:儀表板與終端機中英切換):「看到了／沒看到／驗不了」在 Claude 的回報裡是格式,中英兩種都認
 *   (seen／not seen／can't verify;規格:技能與寫給AI的話中英切換 AC-3,字住 lib/lang.mjs 的 WALK_WORDS);
 *   畫面上那一條的字是這裡給的,照這一次輸出的語言(lib/lang.mjs 的 zhEn)。Claude 回報裡寫的原文照原文印。
 */
import { rerunLine, tookLine, noWords, isAi } from './rounds.mjs';
import { zhEn, plural, walkWordRe, walkWordOf } from './lang.mjs';

/**
 * 一行一條的格式(AC-1):`AC-3 看到了：「原文」`、`AC-4 沒看到：…`、`AC-5 驗不了：原因`;英文 `AC-3 seen: "original text"`、`AC-4 not seen: …`、`AC-5 can't verify: reason`。
 *   結果那個字要緊接在代號後面:原文裡剛好有 not seen(`AC-2 seen: "…was not seen before…"`)照樣是 seen(老毛病 P4)。
 * 沒有規格、照你叫它時講的話驗的輪次,條目用數字編號(`1 看到了：…`)。前面的「- 」「• 」是清單記號,拿掉再認。
 * 這一輪有好幾份規格時(規格:多份規格與新資料夾的起點 AC-4),兩份都有 AC-1——代號前面加規格名:`report-row-time AC-1 看到了：…`。
 *   規格名寫成檔名(帶 .md)、或整個路徑也認(只取最後那一段)。只寫「AC-1」的不猜是哪一份:對不上這一輪要驗的任何一條,照原文列出來。
 */
const ITEM_HEAD = /^(?:[-•*]\s*)?(?:([^\s：:，,、]+?)\s+(?=AC-?\d))?(AC-?\d+|\d+)\s*[.．、:：]?\s*/;
const ITEM_TAIL = /\s*[：:]?\s*(.*)$/;
const ITEM = new RegExp(`${ITEM_HEAD.source}(${walkWordRe()})${ITEM_TAIL.source}`, 'i');
/** 「看到了」要附畫面上的原文(AC-2):「」裡要有字;英文寫的用 "…" 或 “…”。只看有沒有,不看對不對——對不對是你第二次查核的事 */
const QUOTED = /「[^」]+」|"[^"]+"|“[^”]+”/;

/** AC-01、ac-1、AC1 都是 AC-1;純數字(沒有規格的輪次)照原樣。前面有規格名的:「規格名 AC-1」(跟 roundView 給的要驗的代號同一個樣子) */
function normId(raw, spec = null) {
  const m = String(raw).match(/^AC-?(\d+)$/i);
  const id = m ? `AC-${Number(m[1])}` : String(Number(raw));
  const name = spec ? String(spec).split('/').filter(Boolean).at(-1)?.replace(/\.md$/i, '') : '';
  return name ? `${name} ${id}` : id;
}

/**
 * 讀一份結論(--report E 的說明)。第一行是 Claude 寫的摘要——第一行本身就是一條的話(忘了寫摘要),它也算一條。
 * 同一條寫了兩次,算最後那一次(補記、更正),但要講出來(dups):前面那一次「沒看到」不准安靜消失——
 *   代號打錯(AC-2 寫成 AC-1)時,「沒看到」會悄悄變成「看到了」(魔鬼教官第一輪)。all 是每一行照原樣(--report E 拒收「有沒看到卻記 ok」看它)。
 * @returns {{ head, items: Array<{id, verdict:'saw'|'missing'|'blocked', text, quoted}>, all: Array, dups: Array<{id, verdicts}>, odd: string[] }}
 */
export function parseWalk(note) {
  const lines = String(note ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const byId = new Map();
  const all = [];
  const odd = [];
  let head = null;
  lines.forEach((line, i) => {
    const m = line.match(ITEM);
    if (!m) {
      if (i === 0) head = line;
      else odd.push(line);
      return;
    }
    const verdict = walkWordOf(m[3]);
    const text = m[4].trim();
    const id = normId(m[2], m[1] ?? null);
    const row = { id, verdict, text, quoted: QUOTED.test(text) };
    all.push(row);
    byId.delete(id);   // 同一條記兩次:算最後那一次,排在它最後出現的位置
    byId.set(id, row);
  });
  const dups = [...byId.keys()].map((id) => ({ id, verdicts: all.filter((x) => x.id === id).map((x) => x.verdict) })).filter((d) => d.verdicts.length > 1);
  return { head, items: [...byId.values()], all, dups, odd };
}

/**
 * 這一輪要驗的是哪幾份規格(roundView 給的 verify)。回報的代號前面帶了規格名時,拿它分得出是哪一份、是不是讀不到的那份、
 * 還是名字對不上(規格:多份規格與新資料夾的起點 AC-4、AC-5)。single:只有一份規格時那一份的名字。
 */
function specsOfVerify(verify) {
  if (!verify) return { single: null, names: [], unreadable: [] };
  if (verify.multi) {
    const specs = verify.specs ?? [];
    return { single: null, names: specs.filter((x) => x.where).map((x) => x.name), unreadable: specs.filter((x) => !x.where).map((x) => x.name) };
  }
  return { single: verify.name ?? null, names: [], unreadable: [] };
}

/** 代號前面的規格名(「甲 AC-1」的「甲」);沒有是 null */
const prefixOf = (id) => String(id).match(/^(.+) (AC-\d+)$/)?.[1] ?? null;

/**
 * 回報的每一條跟這一輪要驗的條目對(魔鬼教官第一輪:以前不在要驗的裡面的一律講「不在這一輪的規格裡」——
 * 只有一份規格、Claude 照好幾份的格式在前面加了它的名字,或自己取了暱稱「語音 AC-1」,那句話都是錯的,裡面的「沒看到」還被埋掉):
 *   只有一份規格時,前面寫的就是那一份的名字 → 拿掉名字再比(照好幾份的格式寫不算錯)
 *   不在要驗的裡面的,分四種:unnamed(好幾份時只寫「AC-1」,分不出是哪一份,不猜)、blind(前面是讀不到的那份規格的名字,對不了)、
 *   misnamed(前面的規格名對不上這一輪的任何一份)、extra(規格裡沒有這一條)
 * 拿掉名字之後同一條寫了兩次,算最後那一次(跟 parseWalk 同一條規則)。
 */
function matcher(walk, expected, ctx = {}) {
  const want = Array.isArray(expected) && expected.length ? expected : null;
  const named = !!want && want.some((id) => /\s/.test(String(id)));
  const align = (id) => (ctx.single && !named && prefixOf(id) === ctx.single ? String(id).slice(ctx.single.length + 1) : id);
  const byId = new Map();
  for (const x of walk?.items ?? []) { const id = align(x.id); byId.delete(id); byId.set(id, { ...x, id }); }
  const kind = (id) => {
    if (!want || want.includes(id)) return null;
    const pre = prefixOf(id);
    if (!pre) return named && /^AC-\d+$/.test(String(id)) ? 'unnamed' : 'extra';
    if ((ctx.unreadable ?? []).includes(pre)) return 'blind';
    return named && (ctx.names ?? []).includes(pre) ? 'extra' : 'misnamed';
  };
  return { want, items: [...byId.values()], byId, kind };
}

/**
 * 跟這一輪要驗的條目對(AC-1):expected 是規格裡要驗的代號(分批做的只有這一批);沒有規格是 null。ctx 是 specsOfVerify 給的。
 * 規格裡有、回報沒有 → 「沒有結果」,不算進任何一種(R1)。回報有、規格裡沒有 → 照列,標出是哪一種對不上(見 matcher)。
 * @returns {{ total, saw, missing, blocked, noResult: string[], extra: string[], unnamed: string[], misnamed: string[], blind: string[],
 *             strayMissing: number, unreadableSpecs: string[], odd: number, unquoted: string[], dups: string[] }}
 */
export function walkSummary(walk, expected = null, ctx = {}) {
  const { want, items, kind } = matcher(walk, expected, ctx);
  const got = new Set(items.map((x) => x.id));
  const count = (v) => items.filter((x) => x.verdict === v && (!want || want.includes(x.id))).length;
  const of = (k) => items.filter((x) => kind(x.id) === k).map((x) => x.id);
  return {
    total: want ? want.length : items.length,
    saw: count('saw'), missing: count('missing'), blocked: count('blocked'),
    noResult: want ? want.filter((id) => !got.has(id)) : [],
    extra: of('extra'), unnamed: of('unnamed'), misnamed: of('misnamed'), blind: of('blind'),
    // 對不上的那幾條裡寫「沒看到」的:不准因為對不上就安靜埋掉(R1)
    strayMissing: items.filter((x) => kind(x.id) !== null && x.verdict === 'missing').length,
    unreadableSpecs: ctx.unreadable ?? [],
    odd: (walk?.odd ?? []).length,
    unquoted: items.filter((x) => x.verdict === 'saw' && !x.quoted).map((x) => x.id),
    dups: (walk?.dups ?? []).map((d) => d.id),
  };
}

const list = (ids, n = 5) => zhEn(`${ids.slice(0, n).join('、')}${ids.length > n ? ` 等 ${ids.length} 條` : ''}`,
  `${ids.slice(0, n).join(', ')}${ids.length > n ? ` and others (${ids.length} items)` : ''}`);

/** 「8 條裡 6 條看到了、1 條沒看到、1 條驗不了；AC-8 沒有結果」——數字全部從回報的行數出來,不採信 Claude 摘要裡的數字(R3) */
export function summaryLine(s) {
  if (!s || (!s.total && !s.odd)) return zhEn('沒有逐條的結果——分不出看了哪幾條', 'No item-by-item results: can\'t tell which items were looked at');
  const parts = [['saw', zhEn('看到了', 'saw it')], ['missing', zhEn('沒看到', 'didn\'t see it')], ['blocked', zhEn('驗不了', 'couldn\'t check')]]
    .filter(([k]) => s[k] > 0).map(([k, w]) => zhEn(`${s[k]} 條${w}`, `${s[k]} ${w}`));
  const tail = [
    s.noResult.length ? zhEn(`${list(s.noResult)} 沒有結果`, `${list(s.noResult)}: no result`) : null,
    s.extra.length ? zhEn(`${list(s.extra)} 不在這一輪的規格裡`, `${list(s.extra)}: not in this round's spec`) : null,
    s.misnamed?.length ? zhEn(`${list(s.misnamed)} 前面的規格名對不上這一輪的規格`, `${list(s.misnamed)}: the spec name in front doesn't match this round's spec`) : null,
    s.unnamed?.length ? zhEn(`${list(s.unnamed)} 沒寫是哪一份規格（不猜是哪一份）`, `${list(s.unnamed)}: doesn't say which spec (not guessing which one)`) : null,
    s.blind?.length ? zhEn(`${list(s.blind)} 是讀不到的那份規格的，對不了`, `${list(s.blind)}: belong to the spec that couldn't be read, so they can't be matched`) : null,
    s.strayMissing ? zhEn(`對不上的回報裡有 ${s.strayMissing} 條寫「沒看到」——看下面的原文`, `${s.strayMissing} of the unmatched lines say "didn't see it": see the original text below`) : null,
    s.odd ? zhEn(`${s.odd} 行看不懂（照原文列在下面）`, `${plural(s.odd, 'line')} couldn't be read (listed below as written)`) : null,
    s.dups?.length ? zhEn(`${list(s.dups)} 寫了不只一次（照最後一次算）`, `${list(s.dups)}: written more than once (the last one counts)`) : null,
  ].filter(Boolean);
  // 一條都沒對上、但回報有照格式寫的行:不是「沒有結果」,是「對不上」——講成沒有結果,讀起來像 Claude 什麼都沒驗
  // (2026-10-05 實測:兩份規格以前的回報寫「語音 AC-1」「AC-1」,15 行全對不上)
  const unmatched = ['extra', 'misnamed', 'unnamed', 'blind'].reduce((n, k) => n + (s[k]?.length ?? 0), 0);
  // 這一輪有一份規格讀不到:「N 條裡」的 N 不含它,要講(AC-5;魔鬼教官第一輪:A、B 都講了,E 沒講)
  const nu = s.unreadableSpecs?.length ?? 0;
  const unread = nu ? zhEn(`（另有 ${nu} 份規格讀不到，條數不在裡面）`, ` (${nu} more ${nu === 1 ? 'spec' : 'specs'} couldn't be read; their items aren't counted)`) : '';
  const none = unmatched ? zhEn('沒有一條對得上（回報寫的代號對不上這一輪的規格）', 'not one matches (the IDs in the report don\'t match this round\'s spec)')
    : zhEn('沒有一條有結果', 'not one has a result');
  const head = s.total
    ? zhEn(`${s.total} 條裡 ${parts.length ? parts.join('、') : none}${unread}`, `Of ${plural(s.total, 'item')}: ${parts.length ? parts.join(', ') : none}${unread}`)
    : zhEn('沒有一條照格式寫', 'Not one is written in the format');
  return `${head}${tail.length ? zhEn(`；${tail.join('；')}`, `; ${tail.join('; ')}`) : ''}`;
}

const MARK = { saw: '👁', missing: '✗', blocked: '？', none: '○', odd: '·' };
// 畫面上的字:照這一次輸出的語言,所以每次用的時候才拿(不在載入的那一刻定死)
const WORD = () => ({ saw: zhEn('看到了', 'saw it'), missing: zhEn('沒看到', 'didn\'t see it'), blocked: zhEn('驗不了', 'couldn\'t check'),
  none: zhEn('沒有結果', 'no result'), odd: zhEn('看不懂的一行', 'a line I couldn\'t read') });
const STRAY = () => ({ extra: zhEn('（不在這一輪的規格裡）', ' (not in this round\'s spec)'), misnamed: zhEn('（前面的規格名對不上這一輪的規格）', ' (the spec name in front doesn\'t match this round\'s spec)'),
  unnamed: zhEn('（沒寫是哪一份規格，不猜）', ' (doesn\'t say which spec; not guessing)'), blind: zhEn('（這份規格讀不到，對不了）', ' (this spec couldn\'t be read, so it can\'t be matched)') });

/**
 * 一條一行的清單(畫面與終端機都照這份畫):照規格的順序,規格裡有、回報沒有的補一行「沒有結果」;規格外的、看不懂的排最後。
 * titles:代號 → 規格裡那一條的標題(有規格才有)。ctx:specsOfVerify 給的(哪幾份規格、哪一份讀不到)。
 * 每一行的字也在這裡寫好(AC-7:文案只寫一份):body 是代號後面那一段,note 是括號註記——終端機與網頁照印,不各寫一份。
 */
export function walkItems(walk, expected = null, titles = null, ctx = {}) {
  const { want, items, byId, kind } = matcher(walk, expected, ctx);
  const W = WORD(), S = STRAY();
  const row = (id, x) => {
    const verdict = x?.verdict ?? 'none';
    const text = x?.text ?? '', title = titles?.get?.(id) ?? null;
    const k = x ? kind(id) : null;
    const unquoted = verdict === 'saw' && !x.quoted, extra = !!k;
    // 驗不了的記號是全形問號:英文那一頁不准有全形符號,換成半形
    return { id, verdict, mark: verdict === 'blocked' ? zhEn(MARK.blocked, '?') : MARK[verdict], word: W[verdict], text, title, unquoted, extra,
             body: verdict === 'none' ? `${W.none}${title ? zhEn(`（${title}）`, ` (${title})`) : ''}` : `${W[verdict]}${text ? zhEn(`：${text}`, `: ${text}`) : ''}`,
             note: `${unquoted ? zhEn('（沒附畫面上的原文）', ' (no original text from the screen attached)') : ''}${k ? S[k] : ''}` };
  };
  const out = want ? want.map((id) => row(id, byId.get(id))) : [];
  for (const x of items) if (!want || !want.includes(x.id)) out.push(row(x.id, x));
  for (const line of walk?.odd ?? []) {
    out.push({ id: null, verdict: 'odd', mark: MARK.odd, word: W.odd, text: line, title: null, unquoted: false, extra: false, body: zhEn(`${W.odd}：${line}`, `${W.odd}: ${line}`), note: '' });
  }
  return out;
}

function titlesOf(list) {
  return new Map((list?.items ?? []).map((it) => [it.id, it.title]));
}

/**
 * E 那一格的三句話(AC-7):開過瀏覽器、Claude 說、你說。v 是 roundView 算好的那一關;expected 是這一輪要驗的條目。
 * 這一輪 E 一點動靜都沒有(state none)→ null,畫面照舊講「這一輪還沒跑」。
 * @returns {{ acts: string, walk: string, walked: boolean, human: string, items: Array, summary: object|null } | null}
 */
export function eLines(v, { ago = (t) => String(t ?? ''), expected = v?.verify?.expected ?? null, titles = titlesOf(v?.verify), ctx = specsOfVerify(v?.verify) } = {}) {
  if (!v || v.type !== 'browser' || (v.state === 'none' && !v.ranAt && !v.accept)) return null;
  const hosts = v.hosts?.length ? zhEn(`，去了 ${v.hosts.slice(0, 3).join('、')}`, `, went to ${v.hosts.slice(0, 3).join(', ')}`) : '';
  // 感測器只看得到 AI 用的瀏覽器工具——「沒有紀錄」不講成「沒開過」(L3 的說法)
  const acts = v.count && v.actAt ? zhEn(`${ago(v.actAt)}開過瀏覽器（${v.count} 個動作${hosts}）`, `A browser was opened ${ago(v.actAt)} (${plural(v.count, 'action')}${hosts})`)
    : zhEn('這一輪沒有 AI 開瀏覽器的紀錄', 'No record this round of the AI opening a browser');

  const r = v.rerun ?? null;
  const es = v.estate ?? r?.estate ?? r?.state ?? 'none';
  const walk = v.report ? parseWalk(v.report.note) : null;
  const sum = walk ? walkSummary(walk, expected, ctx) : null;
  const took = r?.took?.latest ? zhEn(`（${tookLine(r.took, { unit: 'walk' })}）`, ` (${tookLine(r.took, { unit: 'walk' })})`) : '';
  // 指令名照 stages.json,不寫死。誰叫的:你打的才講你;其他的中文沒有主詞,英文也不補一個猜的(用被動)
  const cmd = `/${v.calledAs ?? v.skill ?? ''}`, at = ago(r?.last?.call?.ts);
  const called = zhEn(`${at}${v.via === 'typed' ? '你' : ''}叫了 ${cmd}`, v.via === 'typed' ? `you called ${cmd} ${at}` : `${cmd} was called ${at}`);
  let walkLine;
  if (!r || r.state === 'none') walkLine = zhEn('這一輪沒有 AI 照規格走一遍的紀錄', 'No record this round of the AI walking through the spec');
  else if (r.state === 'no-report') walkLine = zhEn(`${called}，${rerunLine(r, { ago })}`, `${called}; ${rerunLine(r, { ago })}`);
  else if (r.state === 'ask' || r.state === 'skipped') {
    walkLine = `${rerunLine(r, { ago })}${sum ? zhEn(`（上一趟 AI 說走了一遍：${summaryLine(sum)}）`, ` (last time, AI said it walked through: ${summaryLine(sum)})`) : ''}`;
  } else {
    const when = ago(v.report?.ts ?? r.last?.call?.ts);
    walkLine = zhEn(`${when}AI 說走了一遍：${summaryLine(sum)}${took}`, `AI said ${when} that it walked through: ${summaryLine(sum)}${took}`);
  }

  const a = v.accept ?? null;
  const quoteOf = (s) => {
    const t = `${String(s?.text ?? '').replace(/\s+/g, ' ').trim()}${s?.cut ? '…' : ''}`;
    return zhEn(`「${t}」`, `“${t}”`);
  };
  const by = isAi(a?.by)
    ? (a?.said?.via === 'ask_question'
      ? zhEn(`AI 代記：你說驗收過了（E 之後你在選項卡點的回覆：${quoteOf(a.said)}）`, `AI recorded it for you: you said it's accepted (your last option-card reply after E: ${quoteOf(a.said)})`)
      : zhEn(`AI 代記：你說驗收過了（E 之後你說的最後一句：${quoteOf(a.said)}）`, `AI recorded it for you: you said it's accepted (the last thing you said after E: ${quoteOf(a.said)})`))
    : zhEn('你說驗收過了', 'You said it\'s accepted');
  const rejected = !a?.rejected ? '' : a.rejected.why === 'no-words'
    ? zhEn(`AI 記了你說驗收過了，但 E 之後${noWords(a.rejected.odd)}——不算數；`, `AI recorded that you said it's accepted, but after E ${noWords(a.rejected.odd)}, so it doesn't count; `)
    : zhEn('AI 記了你說驗收過了，但分不出是哪個對話記的——不算數；', 'AI recorded that you said it\'s accepted, but can\'t tell which conversation recorded it, so it doesn\'t count; ');
  let human;
  const when = a ? ago(a.coverTs ?? a.ts) : '';
  if (es === 'accepted') human = zhEn(`${when}${by}`, `${by} (${when})`);
  // 你後來說不用再走(--decide):錨在你的驗收的那一筆講你那句話;錨在走一趟的,第二句已經講了——這裡只講你的驗收是改之前的
  else if (a?.valid && a.stale) {
    const d = v.acceptDecision?.covered ? v.acceptDecision : null;
    const skip = d ? zhEn(`；${rerunLine({ state: 'skipped', decision: d, concluded: true, stage: { id: v.id ?? 'E', verb: 'walk' } }, { ago })}`,
      `; ${rerunLine({ state: 'skipped', decision: d, concluded: true, stage: { id: v.id ?? 'E', verb: 'walk' } }, { ago })}`) : '';
    human = zhEn(`${when}${by}，之後又改了程式檔${d || es === 'skipped' ? skip : '——要不要再走由你決定'}`,
      `${by} (${when}), then code files changed again${d || es === 'skipped' ? skip : ': whether to walk through it again is your call'}`);
  } else human = zhEn(`${rejected}還沒有人說驗收過了`, `${rejected}Nobody has said it's accepted yet`);

  const walked = !!r && r.state !== 'none' && r.state !== 'no-report' && (!(r.state === 'ask' || r.state === 'skipped') || !!sum);
  return { acts, walk: walkLine, walked, human, items: walk ? walkItems(walk, expected, titles, ctx) : [], summary: sum };
}

/** 一句話講 E 這一輪到哪(案件卡、對話清單的「這一輪走到…」後面那個括號)。null = 不用補 */
export function eWhere(v) {
  const es = v?.estate ?? v?.rerun?.estate ?? v?.rerun?.state ?? null;
  return es === 'accepted' ? (isAi(v?.accept?.by) ? zhEn('AI 代記：你說驗收過了', 'AI recorded it for you: you said it\'s accepted') : zhEn('你說驗收過了', 'you said it\'s accepted'))
    : es === 'accepted-stale' ? zhEn('你說驗收過了之後又改了程式，要不要再走由你決定', 'code changed after you said it\'s accepted; whether to walk through it again is your call')
    : es === 'ask' ? zhEn('要不要再走由你決定', 'whether to walk through it again is your call')
    : es === 'skipped' ? zhEn('你說不用再走', 'you said no need to walk through it again')
    : es === 'no-report' ? zhEn('AI 還沒記結論', 'AI hasn\'t recorded a conclusion yet')
    : es === 'ok' || es === 'found' ? zhEn('AI 走過一遍，等你查核', 'AI walked through it; waiting for you to check')
    : null;
}
