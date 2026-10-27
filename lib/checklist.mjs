/**
 * checklist.mjs —— A 的清單就是規格檔裡的 AC,勾也打在檔案上(五關自動結案 AC-5)
 *
 * 規格檔是事實(第一級:檔案系統),儀表板照著檔案畫,不另外存一份(老毛病 P2)。
 * 約定(skills/spec/SKILL.md 也寫了同一份):
 *   **AC-1　標題**                      ← 還沒對
 *   **AC-2　標題** ✅ 對過 2026-09-16    ← 對過了
 *   **AC-3　標題** ⏳ 待討論：原因        ← 留著,要跟人討論
 *   下一行 > **白話**：… 是給人看的那一句。
 * ⚠️ 解析不了(沒有任何一條 AC)就說解析不了,把開頭幾行照原文給畫面——不假裝解析成功(R1)。
 */
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, basename, dirname, relative, isAbsolute, normalize, sep } from 'node:path';

const HEAD = /^\*\*(AC-\d+)[\s　]+(.+?)\*\*\s*(.*)$/;
const PLAIN = /^>\s*\*\*白話\*\*[：:]\s*(.*)$/;

/** 解析一段文字(不讀檔)。回 { parsed, items, checked, pending, unmarked, head }。 */
export function parseChecklist(text) {
  const lines = String(text ?? '').split('\n');
  const items = [];
  // code fence 裡的是範例,不是 AC(魔鬼教官 2026-09-16 抓到:規格引用格式範本,假的 AC-1 會被當真,收工 hook 一直要求標它——老毛病 P4)
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(HEAD);
    if (!m) continue;
    const [, id, title, tail] = m;
    let state = 'none', note = null;
    if (/✅/.test(tail)) { state = 'checked'; note = tail.replace(/✅\s*/, '').trim() || null; }
    else if (/⏳/.test(tail)) { state = 'pending'; note = tail.replace(/⏳\s*(待討論)?\s*[：:]?\s*/, '').trim() || null; }
    // 下面幾行內找「白話」那一句(跳過空行)
    let plain = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const p = lines[j].match(PLAIN);
      if (p) { plain = p[1].trim(); break; }
      if (HEAD.test(lines[j])) break;
    }
    items.push({ id, title: title.trim(), state, note, plain });
  }
  const count = (s) => items.filter((x) => x.state === s).length;
  return {
    parsed: items.length > 0, items,
    checked: count('checked'), pending: count('pending'), unmarked: count('none'), total: items.length,
    head: items.length ? null : lines.filter((l) => l.trim()).slice(0, 3).join(' / ').slice(0, 160),
  };
}

/** 讀一份規格檔並解析。檔案不在就說不在(missing),不當成「沒有清單」。
 *  mtime 是檔案最後一次被改的時間:勾打在檔案上,「這個對話連上之後有沒有回頭對過」就看它(施工對話認規格,魔鬼教官 2026-09-21)。
 *  用 Bash 改的感測器看不到(L8),檔案系統看得到。讀不到就是 null,不猜。 */
export function readChecklist(file) {
  if (!file || !existsSync(file)) return { file, missing: true, parsed: false, items: [], checked: 0, pending: 0, unmarked: 0, total: 0, head: null, mtime: null };
  let mtime = null;
  try { mtime = new Date(statSync(file).mtimeMs).toISOString(); } catch { mtime = null; }
  try { return { file, missing: false, mtime, ...parseChecklist(readFileSync(file, 'utf8')) }; }
  catch { return { file, missing: true, parsed: false, items: [], checked: 0, pending: 0, unmarked: 0, total: 0, head: null, mtime: null }; }
}

/**
 * 一份規格分幾批做,這一批只驗其中幾條(施工對話認規格 AC-8)。acs 是 null／空 → 整份都是這一批。
 * 每一條標 inBatch;checked／pending／unmarked／total 只數這一批(B 的結案、收工 hook 的「沒標就擋」都吃這幾個數),
 * allTotal 是整份幾條——A 仍畫整份,不在這一批的標出來,不藏起來。
 */
export function batchOf(cl, acs) {
  if (!cl || !cl.parsed) return cl;
  const want = Array.isArray(acs) && acs.length ? new Set(acs) : null;
  const items = cl.items.map((it) => ({ ...it, inBatch: !want || want.has(it.id) }));
  const inB = items.filter((it) => it.inBatch);
  const count = (st) => inB.filter((x) => x.state === st).length;
  // 記的代號在檔案裡找不到了(規格改過號、刪了條)——這一批不是「0 條要做」,是對不上(老毛病 P5):
  // 要講出來、不准結案,收工 hook 叫它重記(魔鬼教官 2026-09-21)
  const batchMissing = want ? [...want].filter((id) => !cl.items.some((it) => it.id === id)) : [];
  return { ...cl, items, batch: want ? [...want] : null, batchMissing, allTotal: items.length,
           checked: count('checked'), pending: count('pending'), unmarked: count('none'), total: inB.length };
}

/**
 * 一輪寫了好幾份規格(規格:多份規格與新資料夾的起點 AC-1、AC-2、AC-5):每一份各一張清單,合起來給 B、收工 hook 一份總數。
 * 條數只加讀得到的(R3):讀不到的那份(找不到、只在主資料夾、同名不只一份、沒有照格式寫的 AC)列在 unreadable,條數不算進來,
 * 畫面要講「另有 N 份讀不到」——不准讓只算一部分的數字長得像全部(以前一次寫兩份,畫面寫「全部 5 條」其實 15 條)。
 * parts:[{ name, place, checklist }],checklist 是 readChecklist 的結果,不在這個工作區的是 null。
 * items 每一條帶 spec(哪一份):兩份都有 AC-1,只看代號分不開。
 */
export function combineChecklists(parts) {
  const read = parts.filter((p) => p.checklist?.parsed);
  const sum = (k) => read.reduce((n, p) => n + (p.checklist[k] ?? 0), 0);
  const mtimes = read.map((p) => p.checklist.mtime).filter(Boolean).sort();
  return {
    multi: true, file: null, missing: false, parsed: read.length > 0,
    items: read.flatMap((p) => p.checklist.items.map((it) => ({ ...it, spec: p.name }))),
    checked: sum('checked'), pending: sum('pending'), unmarked: sum('unmarked'), total: sum('total'),
    head: null, mtime: mtimes.at(-1) ?? null,
    parts: parts.map((p) => ({ name: p.name, file: p.checklist?.file ?? null, rel: p.place?.rel ?? null, checklist: p.checklist ?? null })),
    unreadable: parts.filter((p) => !p.checklist?.parsed).map((p) => p.name),
  };
}

/**
 * 一筆 A 結論(--report A ok "…")的說明裡記的規格路徑(規格:多份規格與新資料夾的起點 AC-1)。
 * 只認 docs/規劃中、docs/進行中 底下的 .md——跟感測器那條線索、--spec 收的同一條規則:順手提到的參考文件、
 * 已經做完的規格(升級摘要)不算這一輪寫的(魔鬼教官第一輪:以前整行以 .md 結尾就收,舊規格的勾被算進「對過」)。
 * 一行可以寫好幾份(空白、頓號、逗號隔開都認);整個路徑有空白被切開時,從 docs/ 那一段算(相對工作區的根)。
 */
export function specPathsInNote(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/[\s、，,；;：:（）()「」『』"'`<>]+/)) {
    let t = raw.replace(/^[-•*]+/, '').replace(/[。！？!?]+$/, '').replace(/(\.md)\.$/i, '$1');
    if (!t.startsWith('/') && t.includes('docs/')) t = t.slice(t.indexOf('docs/'));
    if (/(^|\/)docs\/(規劃中|進行中)\/[^/]+\.md$/i.test(t)) out.push(t);
  }
  return out;
}

/**
 * 改動清單(lib/git.mjs changeHealth 的 list:相對 git 根的路徑,含新檔)裡、規劃中／進行中、而且現在還在的規格檔。
 * 刪掉的不算——那是搬走(開工、結案)的舊位置,不是「這一輪動了一份規格」。規格:多份規格與新資料夾的起點 AC-6
 */
export function specFilesOf(list, root) {
  return (Array.isArray(list) ? list : []).filter((f) => /^docs\/(規劃中|進行中)\/[^/]+\.md$/i.test(String(f)) && !!root && existsSync(join(root, f)));
}

/** 規格住的三個資料夾。搬家只會在這三個之間(工作項的狀態就是路徑,CLAUDE.md)。 */
const SPEC_DIRS = ['規劃中', '進行中', '升級摘要'];

/**
 * 一個絕對路徑換成真實路徑(捷徑、macOS 的 /tmp 其實是 /private/tmp)。檔案搬走了就從還在的那一層換,後面照接回去。
 * 只拿來判斷「在不在這個資料夾底下」,不拿來讀檔。
 */
function realOf(p) {
  const rest = [];
  for (let d = p; ; ) {
    try { return join(realpathSync(d), ...rest); } catch { /* 這一層不在(搬走了),往上一層再換 */ }
    const up = dirname(d);
    if (up === d) return p;
    rest.unshift(basename(d));
    d = up;
  }
}

/**
 * 記下來的位置換成「相對某個資料夾」的路徑(規格搬家 AC-1)。
 * 感測器記的寫檔是絕對路徑,連結與 --report 記的是相對路徑——以前絕對路徑直接拿去 join,拼出一個不存在的位置,只是碰巧靠同名搜尋救回來。
 * 不在那個資料夾底下(相對路徑往上跳出去也算)→ null。字面比不出來,再用真實路徑比一次:同一個資料夾有兩種拼法時,不准講成「不在這裡」。
 */
function inWorkspace(p, dir) {
  const inside = (r) => (!r || r === '.' || isAbsolute(r) || r === '..' || r.startsWith(`..${sep}`) ? null : r.split(sep).join('/'));
  if (!isAbsolute(p)) return inside(normalize(p));
  return inside(relative(dir, p)) ?? inside(relative(realOf(dir), realOf(p)));
}

/** 往上找 git 的根(有 .git 的那一層;worktree 的 .git 是一個檔案)。找不到是 null。不叫 git:每一頁都會跑好幾次 */
function gitTopOf(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return null;
  }
}

/** 「比這一次 A 還舊」留的餘裕:檔案時間到毫秒,感測器的時間只到秒(截掉的) */
const OLDER_SKEW_MS = 2000;

/**
 * 找一份規格檔(施工對話認規格 AC-6)。「這一輪的規格在哪」的兩條路——別的對話寫的連結、這個對話自己用 A 寫的——都用這一個函式找
 * (規格搬家 AC-1:以前只有連結那條會跟著搬家找,老毛病 P6)。
 * rel 是記下來的位置:相對工作區的路徑(連結、--report 記的),或絕對路徑(感測器記的寫檔)。先認它記在哪:
 *   這個工作區 → 下面 ①②③④;對話 cd 進了專案的子資料夾 → 工作區是它的 git 根,不是 cwd;
 *   記在主資料夾(worktree 的對話把規格寫進了主資料夾)→ 只在主資料夾找,工作區裡同名的那一份不是它寫的(found='main' 或 'missing');
 *   都不是 → found='outside',什麼都不給。
 *   ⚠️ 以前記的位置不在工作區,就只憑檔名在工作區找——工作區剛好有同名的另一份,就安靜換成那一份(魔鬼教官 2026-09-22,老毛病 P6)
 *   ① 工作區裡那個路徑還在 → 就是它,找到就停
 *   ② 不在 → 在工作區的規劃中／進行中／升級摘要找同名檔:剛好一份就是它(規格開工、結案會搬家);不只一份 → 分不出來,不猜
 *   ③ 工作區都沒有 → 主資料夾有的話只說「在主資料夾」(可能還沒併進來),**不給檔案**——不叫 Claude 去主資料夾打勾
 *   ④ 都找不到 → missing。呼叫端要講「找不到規格檔 X.md」,不准講成「沒有清單」(R1)
 * given 是記的位置(相對它記在的那個資料夾)。moved = 在工作區找到了、但不在記的位置——「搬到了」只在這裡判斷一次,
 * 呼叫端不自己再比(規格搬家 AC-3)。
 * notBefore(A 自己寫的那條路給:記的那份最後一次被寫的時間,記不到就用這一次 A 被叫的時間):記的那份,修改時間不會比它早(搬家不改修改時間,打勾只會更晚)。
 *   記的位置不在、同名找到的那一份比它還舊 → 分不出是不是同一份(可能是上一輪做完、放在升級摘要的同名規格;worktree 建立時 git 寫出來的那一份)
 *   → found='older',不給檔案。拿它當這一輪的清單,B 會拿別份的舊勾結案、收工 hook 會叫 Claude 去已結案的規格補勾(R2,魔鬼教官 2026-09-22)。
 *   只講「分不出」,不講「是別份」:證據只證明它比記的那份舊(魔鬼教官第二輪)。連結那條路不給:別的對話寫好的規格本來就比連結早。
 * gone = 這個對話的資料夾已經不在了(worktree 清掉了):工作區裡找不到不是「都沒有」,是沒辦法找(R1),畫面要講資料夾不在了。
 * recordedIn = 記的位置在哪:'here'(這個工作區,或它的 git 根)、'main'(主資料夾)、null(都不是)——畫面講「寫在主資料夾」還是「可能還沒併進來」靠它。
 * @returns {{found:'here'|'ambiguous'|'main'|'older'|'outside'|'missing', file:string|null, rel:string|null, name:string, given:string|null, moved:boolean, gone:boolean, recordedIn:'here'|'main'|null, mainFile?:string|null, where?:string[]}}
 */
export function locateSpec(rel, { root, mainRoot = null, notBefore = null }) {
  const raw = String(rel ?? '');
  const name = basename(raw);
  if (!name || !root) return { found: 'missing', file: null, rel: null, name, given: null, moved: false, gone: false, recordedIn: null };
  const gone = !existsSync(root);
  const other = mainRoot && mainRoot !== root ? mainRoot : null;
  let base = root, given = inWorkspace(raw, root), inMain = false;
  if (given === null && isAbsolute(raw)) {
    const top = gone ? null : gitTopOf(root);
    const g = top && top !== root ? inWorkspace(raw, top) : null;
    if (g !== null) { base = top; given = g; }
    else if (other) { given = inWorkspace(raw, other); inMain = given !== null; }
  }
  if (given === null) return { found: 'outside', file: null, rel: null, name, given: null, moved: false, gone, recordedIn: null };
  const recordedIn = inMain ? 'main' : 'here';
  const look = (dir) => {
    const exact = join(dir, given);
    if (existsSync(exact)) return [exact];
    return SPEC_DIRS.map((d) => join(dir, 'docs', d, name)).filter((f) => existsSync(f));
  };
  const relOf = (dir, f) => relative(dir, f).split(sep).join('/');
  const inMainFolder = () => {
    const main = look(other);
    return main.length ? { found: 'main', file: null, rel: main.length === 1 ? relOf(other, main[0]) : null, name, given, moved: false, gone, recordedIn, mainFile: main.length === 1 ? main[0] : null } : null;
  };
  if (inMain) return inMainFolder() ?? { found: 'missing', file: null, rel: null, name, given, moved: false, gone, recordedIn };
  const here = look(base);
  if (here.length === 1) {
    const at = relOf(base, here[0]);
    const moved = at !== given;
    if (moved && Number.isFinite(notBefore)) {
      let m = NaN;
      try { m = statSync(here[0]).mtimeMs; } catch { m = NaN; }
      if (Number.isFinite(m) && m < notBefore - OLDER_SKEW_MS) return { found: 'older', file: null, rel: at, name, given, moved: false, gone, recordedIn };
    }
    return { found: 'here', file: here[0], rel: at, name, given, moved, gone, recordedIn };
  }
  if (here.length > 1) return { found: 'ambiguous', file: null, rel: null, name, given, moved: false, gone, recordedIn, where: here.map((f) => relOf(base, f)) };
  if (other && other !== base) { const m = inMainFolder(); if (m) return m; }
  return { found: 'missing', file: null, rel: null, name, given, moved: false, gone, recordedIn };
}

/**
 * 第一句話提到哪一份規格(施工對話認規格 AC-3)。**只是提示**:不畫清單、不擋人、不算 A。
 * 只認 docs/規劃中/ 或 docs/進行中/ 的路徑——升級摘要是做完的參考,不算;沒寫 docs/ 的也不猜。
 * 同一份提到兩次(或從規劃中搬到進行中各寫一次)算一份;兩份以上 → 不提示(分不出是照哪一份)。
 * 例子(規格寫的):必須提示「照 docs/規劃中/app建議卡.md 開工。先讀 docs/升級摘要/pipeline-sensor.md 的 AC」;
 *                 必須放過「先讀 docs/進行中/五關自動結案.md 與 docs/規劃中/E自動驗收.md」(兩份)。
 */
const SPEC_MENTION = /docs\/(?:規劃中|進行中)\/([^\s\/`'"<>()（）「」『』【】，。、；：！？]+?\.md)(?![A-Za-z0-9_])/g;
/**
 * cap:感測器記第一句話的上限(字數,lib/events.mjs 的 PROMPT_CAP)。記下的剛好到上限 → 後面被截掉了,「只提到一份」證明不了(魔鬼教官 2026-09-21:
 *   Oscar 先打命名、再列參考,第二份路徑落在截斷點之後,提示就指到當參考的那一份)。所以:
 *   截在一個路徑中間(最後一個 docs 後面還沒出現 .md)→ 第二份被截掉的樣子,不提示;
 *   其他截過的 → 照樣提示,但 cut=true,畫面要講「後面有沒有提到別份看不到」,收工 hook 也不把路徑交給 Claude。
 */
export function specHint(prompt, { cap = null } = {}) {
  const text = String(prompt ?? '');
  const cut = cap !== null && [...text].length >= cap;
  if (cut) {
    const tail = text.slice(-80), at = tail.lastIndexOf('docs');
    if (at >= 0 && !/\.md/i.test(tail.slice(at))) return null;
  }
  const byName = new Map();
  for (const m of text.matchAll(SPEC_MENTION)) byName.set(m[1], m[0]);
  if (byName.size !== 1) return null;
  const [[file, path]] = [...byName];
  return { name: file.replace(/\.md$/i, ''), path, cut };
}
