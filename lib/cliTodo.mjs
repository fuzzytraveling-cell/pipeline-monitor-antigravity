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
import { briefReport, parseBriefArgs } from './brief.mjs';
import { readTasksConfig, deriveTaskBoard, formatTasksLines } from './tasks.mjs';
import { real, withGitMemo } from './git.mjs';
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
 * --brief [--quiet-if-clear]:全機巡檢晨報(規格:brief-patrol-command)。
 * 只讀 collectAll 與 todoBoard 的既有事實;只有真正零待辦、零故障、零問不到時(clear === true),--quiet-if-clear 才靜音。
 */
export async function doBrief(argv = [], { monitorDir = HERE, ask = () => askServe({ cmd: '--brief' }), langState = 'ok', write = (line) => console.log(line) } = {}) {
  const parsed = parseBriefArgs(argv);
  if (!parsed.ok) {
    write(parsed.errorLine);
    return 1;
  }
  const all = collectAll({ monitorDir });
  const restart = await ask();
  const board = todoBoard(all, { restart });
  const report = briefReport(all, board, { langState });
  if (parsed.quietIfClear && report.clear) return 0;
  for (const line of report.lines) write(line);
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
 * --tasks:這個專案的誠實任務板。有紀錄時共用 collectAll 算好的推導結果（P2）；
 * 尚無紀錄的新專案仍依 ctx.mainRoot ?? ctx.root 即時推導（不把新專案講成沒有設定）。
 */
export function doTasks(ctx, { monitorDir = HERE, write = (line) => console.log(line) } = {}) {
  const all = collectAll({ monitorDir });
  const name = safeName(ctx.project);
  const p = all.projects.find((x) => x.name === name) ?? null;
  let tb;
  if (p?.taskBoard) {
    tb = p.taskBoard;
    if (ctx.root && p.mainRoot && real(ctx.root) !== real(p.mainRoot)) {
      const wtCfg = readTasksConfig(p.mainRoot, { worktreeRoot: ctx.root });
      tb = { ...tb, worktreeDiffers: wtCfg.worktreeDiffers };
    }
  } else {
    const mainRoot = ctx.mainRoot ?? ctx.root;
    tb = withGitMemo(() => deriveTaskBoard({
      project: { name, displayName: ctx.project, mainRoot, cards: [], sessions: [] },
      desk: {},
      events: [],
      worktreeRoot: ctx.root,
    }));
  }
  for (const line of formatTasksLines(tb, { displayName: p?.displayName ?? ctx.project })) write(line);
  return 0;
}

/**
 * 問常駐的服務:它哪一刻開始跑、之後它用到的程式改過哪幾支(server.mjs 的 /api/serve-state)。
 * 連不上 → 講連不上;等太久 → 講沒回答(可能在忙);舊的服務沒有這個網址 → 講它是舊的。都不准講成「不用重啟」(R1)
 * ⚠️ 等 10 秒,不是 3 秒:服務一次只能做一件事,開著的分頁每 5 秒叫它算一次整頁(3～5 秒),這一題常排在後面——
 *    以前等 3 秒,實測 10 次有 2 次等不到,被講成「沒在跑，或連不上」(魔鬼教官第一輪)
 */
export async function askServe({ url = URL, ms = 10_000, cmd = '--todo' } = {}) {
  const s = await serveStateOf({ url, ms });
  return s.state === 'slow' ? serveSlowLine(s.seconds, cmd) : s.state === 'down' ? serveDownLine() : s.state === 'old' ? serveOldLine() : restartLine(s);
}

/**
 * 服務自己說的狀態,不翻成句子:{state:'ok', bootAt, changed} | {state:'slow', seconds} | {state:'down'} | {state:'old'}。
 * 白板那一句(askServe)跟主任收尾的重啟(lib/cliWrap.mjs,規格:主任動手收尾 AC-4)都從這裡問——要不要重啟只有一個來源(老毛病 P2)
 */
export async function serveStateOf({ url = URL, ms = 10_000 } = {}) {
  let r;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { r = await fetch(`${url}api/serve-state`, { signal: c.signal }); }
  catch { return c.signal.aborted ? { state: 'slow', seconds: Math.round(ms / 1000) } : { state: 'down' }; }
  finally { clearTimeout(t); }
  if (!r.ok) return { state: 'old' };
  const j = await r.json().catch(() => null);
  if (!j || !('changed' in j)) return { state: 'old' };
  return { state: 'ok', bootAt: j.bootAt ?? null, changed: j.changed };
}
