/**
 * cliTodo.mjs —— --todo:終端機那一張「還差什麼」(規格:還差什麼總表 AC-8)。第二段的主任讀的就是這一張;
 * --cards:這個專案的每一張建議卡,主任開卡之前查有沒有了(規格:主任技能 AC-7)。
 * 句子全從 lib/todo.mjs 來,跟首頁那一張同一份(規格:終端機與網頁說同一句);資料也是同一個 collectAll,所有專案一起。
 * 這裡只多做一件網頁不用做的事:問常駐的服務要不要重啟——網頁那一張是服務自己講的,終端機不是服務,只能去問它。
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAll } from './collect.mjs';
import { todoBoard, boardText, cardsText, restartLine, serveDownLine, serveSlowLine, serveOldLine } from './todo.mjs';
import { URL } from './service.mjs';
import { sessionFromEnv } from './cliFacts.mjs';
import { safeName } from './events.mjs';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));   // lib/ 的上一層 = 程式的資料夾(跟 cliFacts、儀表板同一個 monitorDir)

/** here:跑這個指令的對話(Claude 跑的時候環境給的代號;人自己在終端機跑就沒有)——那一行標「← 這個對話」(主任技能 AC-6) */
export async function doTodo({ monitorDir = HERE, ask = askServe, here = sessionFromEnv() } = {}) {
  const all = collectAll({ monitorDir });
  const restart = await ask();
  for (const line of boardText(todoBoard(all, { restart }), { faults: all.faults?.banner ?? [], here })) console.log(line);
  return 0;
}

/**
 * --cards:這個專案的建議卡。資料是同一個 collectAll、所有專案一起算——「已開始」要拿所有專案的對話來比,要開在這裡的卡住在別的專案;只印這一個。
 * 專案名照紀錄檔名那一個認(safeName):儀表板的案件就是照它分的
 */
export function doCards(ctx, { monitorDir = HERE } = {}) {
  const all = collectAll({ monitorDir });
  for (const line of cardsText(all, safeName(ctx.project))) console.log(line);
  return 0;
}

/**
 * 問常駐的服務:它哪一刻開始跑、之後它用到的程式改過哪幾支(server.mjs 的 /api/serve-state)。
 * 連不上 → 講連不上;等太久 → 講沒回答(可能在忙);舊的服務沒有這個網址 → 講它是舊的。都不准講成「不用重啟」(R1)
 * ⚠️ 等 10 秒,不是 3 秒:服務一次只能做一件事,開著的分頁每 5 秒叫它算一次整頁(3～5 秒),這一題常排在後面——
 *    以前等 3 秒,實測 10 次有 2 次等不到,被講成「沒在跑，或連不上」(魔鬼教官第一輪)
 */
export async function askServe({ url = URL, ms = 10_000 } = {}) {
  let r;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { r = await fetch(`${url}api/serve-state`, { signal: c.signal }); }
  catch { return c.signal.aborted ? serveSlowLine(Math.round(ms / 1000)) : serveDownLine(); }
  finally { clearTimeout(t); }
  if (!r.ok) return serveOldLine();
  const j = await r.json().catch(() => null);
  if (!j || !('changed' in j)) return serveOldLine();
  return restartLine(j);
}
