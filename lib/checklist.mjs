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
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';

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

/** 規格住的三個資料夾。搬家只會在這三個之間(工作項的狀態就是路徑,CLAUDE.md)。 */
export const SPEC_DIRS = ['規劃中', '進行中', '升級摘要'];

/**
 * 找一份規格檔(施工對話認規格 AC-6)。rel 是相對工作區的路徑(記連結那一刻的位置)。
 *   ① 工作區裡那個路徑還在 → 就是它,找到就停
 *   ② 不在 → 在工作區的規劃中／進行中／升級摘要找同名檔:剛好一份就是它(規格開工、結案會搬家);不只一份 → 分不出來,不猜
 *   ③ 工作區都沒有 → 主資料夾有的話只說「在主資料夾」(可能還沒併進來),**不給檔案**——不叫 Claude 去主資料夾打勾
 *   ④ 都找不到 → missing。呼叫端要講「找不到規格檔 X.md」,不准講成「沒有清單」(R1)
 * @returns {{found:'here'|'ambiguous'|'main'|'missing', file:string|null, rel:string|null, name:string, mainFile?:string|null, where?:string[]}}
 */
export function locateSpec(rel, { root, mainRoot = null }) {
  const name = basename(String(rel ?? ''));
  const look = (base) => {
    const exact = join(base, rel);
    if (existsSync(exact)) return [exact];
    return SPEC_DIRS.map((d) => join(base, 'docs', d, name)).filter((f) => existsSync(f));
  };
  if (!name || !root) return { found: 'missing', file: null, rel: null, name };
  const here = look(root);
  if (here.length === 1) return { found: 'here', file: here[0], rel: relative(root, here[0]), name };
  if (here.length > 1) return { found: 'ambiguous', file: null, rel: null, name, where: here.map((f) => relative(root, f)) };
  if (mainRoot && mainRoot !== root) {
    const main = look(mainRoot);
    if (main.length) return { found: 'main', file: null, rel: main.length === 1 ? relative(mainRoot, main[0]) : null, name, mainFile: main.length === 1 ? main[0] : null };
  }
  return { found: 'missing', file: null, rel: null, name };
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
