/**
 * _realdata.mjs —— 跑完全部測試,查一次有沒有碰到這台電腦真的紀錄(規格:紀錄搬到固定的家 AC-7;老毛病 P8)。run-tests.mjs 用。
 * 只查得到兩種,最後那句也只講這兩種(R2):
 *   ① 多出測試的檔:測試做的資料夾都叫 pm-…(mkdtemp),專案名就是資料夾名——真的紀錄裡多出 pm- 開頭的檔,就是有一支漏給了假的家。
 *      只比多出來的檔名:比大小或修改時間會一直假紅——跑測試的同時,真的對話照樣在寫真的紀錄。
 *   ② 舊的地方被搬走:跑之前是真的資料夾、跑完變成捷徑或不見了 = 有一支用真的程式把真的紀錄搬進了它的假家(魔鬼教官第一輪)。
 *      正常搬家不算:合併那天,另一個對話剛好在跑測試的同時第一次搬,舊的位置會變成指向這台電腦真的新家的捷徑——
 *      那不是測試搬走的,紅了就是狼來了(D 第二輪順帶看到)。
 * 純函式、路徑由呼叫端給,測試才拿得假的資料夾來驗(scripts/home.test.mjs)。
 */
import { readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const KINDS = ['logs', 'checkpoints'];

/**
 * 跑之前、跑完各拍一次。
 * @param realHome   帳號真正的家目錄底下的 .pipeline-monitor-agy
 * @param legacy     這份程式的主資料夾
 * @param extraHomes 額外受保護的家目錄（例如原版 ~/.pipeline-monitor，確保測試絕不碰到）
 */
export function snapshot({ realHome, legacy, extraHomes = [] }) {
  const homes = [realHome, legacy, ...extraHomes].filter(Boolean);
  const names = new Set(homes.flatMap((h) => KINDS.map((k) => join(h, k))).flatMap((d) => {
    try { return readdirSync(d).filter((n) => n.startsWith('pm-')).map((n) => join(d, n)); } catch { return []; }
  }));
  const shape = Object.fromEntries(KINDS.map((k) => [k, shapeOf(join(legacy, k))]));
  return { names, shape };
}

/** 兩次比:回多出來的測試檔、被搬走的舊地方(都是完整路徑)。 */
export function compare(before, after, { realHome, legacy }) {
  const leaked = [...after.names].filter((p) => !before.names.has(p));
  const movedAway = KINDS
    .filter((k) => before.shape[k] === 'dir' && after.shape[k] !== 'dir' && !pointsTo(join(legacy, k), join(realHome, k)))
    .map((k) => join(legacy, k));
  return { leaked, movedAway };
}

function shapeOf(p) {
  try { const st = lstatSync(p); return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'other'; } catch { return 'none'; }
}

/** 舊的位置現在是不是一個指向真的新家的捷徑(正常搬家)。看不懂就當成不是——寧可多紅一次,也不要把真的被搬走講成沒事。 */
function pointsTo(link, target) {
  try { return lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(target); } catch { return false; }
}
