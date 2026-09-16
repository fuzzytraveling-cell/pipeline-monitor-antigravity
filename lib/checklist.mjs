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
import { readFileSync, existsSync } from 'node:fs';

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

/** 讀一份規格檔並解析。檔案不在就說不在(missing),不當成「沒有清單」。 */
export function readChecklist(file) {
  if (!file || !existsSync(file)) return { file, missing: true, parsed: false, items: [], checked: 0, pending: 0, unmarked: 0, total: 0, head: null };
  try { return { file, missing: false, ...parseChecklist(readFileSync(file, 'utf8')) }; }
  catch { return { file, missing: true, parsed: false, items: [], checked: 0, pending: 0, unmarked: 0, total: 0, head: null }; }
}
