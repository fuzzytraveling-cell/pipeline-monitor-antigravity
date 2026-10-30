/**
 * _zhscan.mjs —— 掃程式裡的字串:有中文的,只准出現在中英並排的寫法 zhEn(中文, English) 裡(規格:儀表板與終端機中英切換 AC-4)。
 *
 * 零相依,所以自己切字:註解、字串、樣板字串(含 ${} 裡面)、正則。只認這一份程式碼自己的寫法——
 * 不是一個完整的 JavaScript 解析器;切錯的時候寧可多報(會紅、有人看),不准少報(安靜放過一句只寫中文的話)。
 * ⚠️ 註解不算(註解照舊用中文);中文只看字串、樣板字串的字、正則。
 */

/** 中文字與全形符號(含拿來對齊的全形空白 U+3000)。英文那一份連一個都不准有 */
export const CJK = /[⺀-⿟　-〿぀-ヿ㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]/;

/** 中英並排的寫法:zhEn 照這一次輸出挑一種,both 兩種都要(lib/lang.mjs)。掃的規矩一樣 */
const PAIRS = new Set(['zhEn', 'both']);

const KEYWORD_BEFORE_REGEX = /^(return|typeof|case|do|else|in|of|new|delete|void|throw|instanceof|yield|await)$/;

/**
 * 切成一串記號。字面上的東西(字串 str、樣板字串的字 chunk、正則 re)帶著它的原文(v)與位置(at:第幾個字元)。
 * 樣板字串的開頭與結尾、${ 與它的 },都當成括號(bt-open／bt-close、sub-open／sub-close)——算參數的時候,裡面的逗號不會被當成分隔。
 */
export function tokenize(src) {
  const toks = [];
  let i = 0;
  if (src.startsWith('#!')) i = src.indexOf('\n') + 1;
  const push = (t, v, at) => toks.push({ t, v, at });
  const prev = () => toks[toks.length - 1];
  const regexOk = () => {
    const p = prev();
    if (!p) return true;
    if (p.t === 'num' || p.t === 'str' || p.t === 're' || p.t === 'bt-close') return false;
    if (p.t === 'id') return KEYWORD_BEFORE_REGEX.test(p.v);
    if (p.t === 'punct') return !/^[)\]}]$/.test(p.v);
    return true;
  };

  function readString(q) {
    const at = i;
    i++;
    let v = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') { v += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
      v += src[i++];
    }
    i++;
    push('str', v, at);
  }

  function readRegex() {
    const at = i;
    i++;
    let v = '', cls = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { v += c + (src[i + 1] ?? ''); i += 2; continue; }
      if (c === '\n') break;
      if (cls) { if (c === ']') cls = false; }
      else if (c === '[') cls = true;
      else if (c === '/') break;
      v += c; i++;
    }
    i++;
    while (i < src.length && /[a-z]/i.test(src[i])) i++;
    push('re', v, at);
  }

  function readTemplate() {
    push('bt-open', '`', i);
    i++;
    let at = i, v = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { v += c + (src[i + 1] ?? ''); i += 2; continue; }
      if (c === '`') { if (v) push('chunk', v, at); push('bt-close', '`', i); i++; return; }
      if (c === '$' && src[i + 1] === '{') {
        if (v) push('chunk', v, at);
        push('sub-open', '${', i);
        i += 2;
        readCode(true);
        at = i; v = '';
        continue;
      }
      v += c; i++;
    }
  }

  /** 讀程式碼,直到檔尾;inSub = 在 ${ 裡面,讀到跟它配對的 } 就回去 */
  function readCode(inSub) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i], d = src[i + 1];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e; continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
      if (c === '\'' || c === '"') { readString(c); continue; }
      if (c === '`') { readTemplate(); continue; }
      if (c === '/' && regexOk()) { readRegex(); continue; }
      if (/[A-Za-z_$]/.test(c)) { const m = src.slice(i).match(/^[A-Za-z_$][\w$]*/)[0]; push('id', m, i); i += m.length; continue; }
      if (/[0-9]/.test(c)) { const m = src.slice(i).match(/^[0-9][\w.]*/)[0]; push('num', m, i); i += m.length; continue; }
      if (c === '{') depth++;
      if (c === '}') {
        if (inSub && depth === 0) { push('sub-close', '}', i); i++; return; }
        depth--;
      }
      push('punct', c, i);
      i++;
    }
  }

  readCode(false);
  return toks;
}

const OPEN = new Set(['(', '[', '{']), CLOSE = new Set([')', ']', '}']);
const opens = (k) => (k.t === 'punct' && OPEN.has(k.v)) || k.t === 'bt-open' || k.t === 'sub-open';
const closes = (k) => (k.t === 'punct' && CLOSE.has(k.v)) || k.t === 'bt-close' || k.t === 'sub-close';
const literal = (k) => k.t === 'str' || k.t === 'chunk' || k.t === 're';

/** 第 at 個字元在第幾行 */
export function lineOf(src, at) {
  let n = 1;
  for (let j = 0; j < at && j < src.length; j++) if (src[j] === '\n') n++;
  return n;
}

/**
 * 最外層的宣告(function／const／let／export…,寫在一行最前面的那種)各佔哪一段:{ name, from, to }(第幾個記號)。
 * 給「這一整段是 Claude 那一側、另一份規格才翻」的那幾個名字用。
 */
export function topDecls(src, toks) {
  const starts = [];
  for (let j = 0; j < toks.length; j++) {
    const k = toks[j];
    if (k.t !== 'id' || !/^(export|function|async|const|let|var|class)$/.test(k.v)) continue;
    if (k.at > 0 && src[k.at - 1] !== '\n') continue;   // 只認寫在一行最前面的
    if (j > 0 && toks[j - 1].t === 'id' && /^(export|async)$/.test(toks[j - 1].v)) continue;
    let n = j;
    while (n < toks.length && toks[n].t === 'id' && /^(export|default|async|function|const|let|var|class)$/.test(toks[n].v)) n++;
    starts.push({ name: toks[n]?.t === 'id' ? toks[n].v : null, from: j });
  }
  return starts.map((s, x) => ({ ...s, to: (starts[x + 1]?.from ?? toks.length) - 1 }));
}

/**
 * 掃一支檔。回傳每一個不合規矩的地方:{ line, why, text }。
 * @param skip   這幾個最外層宣告的名字整段不看('*' = 整支不看):Claude 那一側,另一份規格才翻
 * @param codes  照原文認的中文(紀錄裡寫死的代號、規格檔的格式、資料夾名):那個字面一字不差才放過
 * @param noTopLevel  最外層宣告裡、不在任何函式裡的 zhEn 也報:那一句在載入的那一刻就定死了(lib 的語言是每一次輸出才定的,
 *                    載入的那一刻永遠是中文)。畫面(ui/app.js)不用:一頁的語言在載入之前就定了
 */
export function scanSource(src, { skip = [], codes = new Set(), noTopLevel = false } = {}) {
  if (skip.includes('*')) return [];
  const toks = tokenize(src);
  const out = [];
  const skipped = new Set();
  const decls = topDecls(src, toks);
  for (const d of decls) if (d.name && skip.includes(d.name)) for (let j = d.from; j <= d.to; j++) skipped.add(j);
  // 這個記號之前(同一個最外層宣告裡)有沒有函式:function、或 =>(箭頭)。沒有 = 載入的那一刻就跑
  const inFunction = (j) => {
    const d = decls.find((x) => j >= x.from && j <= x.to);
    if (!d) return true;   // 不在宣告裡(if (isMain()) {…} 這種):跑的時候才跑
    for (let x = d.from; x < j; x++) {
      const k = toks[x];
      if (k.t === 'id' && k.v === 'function') return true;
      if (k.t === 'punct' && k.v === '=' && toks[x + 1]?.t === 'punct' && toks[x + 1].v === '>' && toks[x + 1].at === k.at + 1) return true;
    }
    return false;
  };

  // 每一個 zhEn(…) 的參數:前一個是中文那一份(裡面的中文都放過),最後一個是英文那一份。
  // both(…) 同一條規矩(lib/lang.mjs:兩種都要的那一對——Claude 寫的格式、技能裡的對照表),只是它不挑語言,放在最外層也不算定死
  const allowed = new Set();
  const enArgs = [];
  for (let j = 0; j < toks.length - 1; j++) {
    const k = toks[j];
    if (k.t !== 'id' || !PAIRS.has(k.v) || toks[j + 1].t !== 'punct' || toks[j + 1].v !== '(') continue;
    if (toks[j - 1]?.t === 'id' && toks[j - 1].v === 'function') continue;   // 定義它的那一行
    const args = [];
    let depth = 0, from = j + 2, end = -1;
    for (let x = j + 1; x < toks.length; x++) {
      const t = toks[x];
      if (opens(t)) depth++;
      else if (closes(t)) { depth--; if (depth === 0) { args.push([from, x - 1]); end = x; break; } }
      else if (depth === 1 && t.t === 'punct' && t.v === ',') { args.push([from, x - 1]); from = x + 1; }
    }
    const real = args.filter(([a, b]) => b >= a);
    if (end === -1 || real.length < 2) {
      out.push({ line: lineOf(src, k.at), why: `${k.v} 只給了一種(要中文、英文各一份)`, text: src.slice(k.at, k.at + 80) });
      continue;
    }
    if (noTopLevel && k.v === 'zhEn' && !skipped.has(j) && !inFunction(j)) {
      out.push({ line: lineOf(src, k.at), why: '這一句在載入的那一刻就定死了(放進函式裡,用到的那一刻才拿)', text: src.slice(k.at, k.at + 80) });
    }
    const zh = real[real.length - 2], en = real[real.length - 1];
    for (let x = zh[0]; x <= zh[1]; x++) allowed.add(x);
    enArgs.push({ at: k.at, en });
  }
  for (const { at, en } of enArgs) {
    const lits = [];
    for (let x = en[0]; x <= en[1]; x++) if (literal(toks[x])) lits.push(x);
    // 英文那一份只有空字串(zhEn('中文', '')、zhEn('中文', ``))就是沒寫;有算式的(數字、變數、${…})看不出來,不算
    const onlyText = toks.slice(en[0], en[1] + 1).every((k) => k.t === 'str' || k.t === 'chunk' || k.t === 'bt-open' || k.t === 'bt-close');
    if (onlyText && !lits.some((x) => toks[x].v.trim())) {
      out.push({ line: lineOf(src, at), why: '英文那一份是空的', text: src.slice(at, at + 80) });
    }
    for (const x of lits) {
      if (!allowed.has(x) && CJK.test(toks[x].v) && !codes.has(toks[x].v)) {
        out.push({ line: lineOf(src, toks[x].at), why: '英文那一份裡有中文', text: toks[x].v.slice(0, 80) });
      }
    }
  }
  for (let x = 0; x < toks.length; x++) {
    const k = toks[x];
    if (!literal(k) || !CJK.test(k.v) || allowed.has(x) || skipped.has(x) || codes.has(k.v)) continue;
    if (enArgs.some(({ en }) => x >= en[0] && x <= en[1])) continue;   // 上面已經報過
    out.push({ line: lineOf(src, k.at), why: k.t === 're' ? '正則裡有中文(在中文句子上切字?英文要整句寫)' : '只寫了中文', text: k.v.slice(0, 80) });
  }
  return out.sort((a, b) => a.line - b.line);
}
