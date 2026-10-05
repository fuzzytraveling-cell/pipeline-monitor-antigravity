/**
 * faults.mjs —— 故障記號(logs/_sensor.jsonl)讀成一句人話。規格:agent回報與故障記號(路徑看 CLAUDE.md 的表)
 *
 * 寫記號的有三支:hook.sh(找不到 jq → sensor_broken)、gate.sh(找不到 node → gate_broken)、gate.mjs(自己出錯 → gate_broken,帶那次的資料夾)。
 * 以前讀的那一端只數「回報過 N 次故障」,而且專案還沒有紀錄檔時連讀都不讀——jq 不在的新專案,終端機叫你開新的對話,
 * 照做永遠等不到;儀表板從來不講(老毛病 P3:記號寫了,讀的那一端沒讀)。
 *
 * ⚠️ 記號是全機一份:jq 不在時連是哪個專案都問不到,所以感測器的句子只講「這台電腦」,不講「這個專案」。
 * ⚠️ 句子只在這裡寫一份:終端機印它、伺服器把算好的放進 /api/status、畫面只畫(老毛病 P2;畫面不 import lib)。
 * ⚠️ 「感測器記到了」只算感測器自己寫的紀錄(有 hook 欄位的)——--report、儀表板的按鈕、收工 hook 擋人的紀錄,
 *    jq 不在照樣寫得進去;拿它們當「恢復了」,按一下結案紅燈就滅了(規格 AC-5)。
 * ⚠️ 程式的錯誤原文不上畫面(CLAUDE.md:不把內部值印給使用者看)——要查叫你把那句話給 Claude 看,它去讀這個檔。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ago } from './git.mjs';
import { sessionStartOf } from './appSessions.mjs';

/** 故障記號的檔案(hook.sh、gate.sh 也寫死這個名字)。它不是專案,讀專案清單時要跳過它——只跳它。 */
export const SENSOR_FILE = '_sensor.jsonl';
/** 收工 hook 的心跳:gate.mjs 每次跑都寫(先寫心跳、再判斷——出錯的那一次也有心跳)。沒有這個檔 = 它從沒跑過(L13)。 */
export const GATE_FILE = '_gate.json';
const DAY_MS = 86400_000;
const UNREADABLE = { ts: null, why: '看不懂的一行' };

export function gateHeartbeat(logDir) {
  try { return JSON.parse(readFileSync(join(logDir, GATE_FILE), 'utf8')); } catch { return null; }
}

/** _sensor.jsonl 的每一行,照檔案順序。看不懂的那一行照樣算一筆(時間不明)——丟掉就是把「壞了」講成「沒事」。 */
export function readFaults(logDir) {
  const file = join(logDir, SENSOR_FILE);
  if (!existsSync(file)) return [];
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return [UNREADABLE]; }   // 檔案在、讀不了:不是「沒有故障」
  return raw.split('\n').filter((l) => l.trim()).map((l) => {
    try { const x = JSON.parse(l); return x && typeof x === 'object' && !Array.isArray(x) ? x : UNREADABLE; } catch { return UNREADABLE; }
  });
}

/** 哪一種故障。時間讀不懂、或不認得的種類 → unreadable:不猜成任何一種(規格 AC-4)。 */
export function faultKind(f) {
  if (!f || !Number.isFinite(Date.parse(f.ts))) return 'unreadable';
  if (f.event === 'sensor_broken') return 'sensor';
  if (f.event === 'gate_broken') return f.why === '找不到 node' ? 'gate-node' : 'gate-error';
  return 'unreadable';
}

/**
 * 每個專案紀錄檔裡,感測器自己寫的那幾筆(有 hook 欄位)的時間,由舊到新。
 * ⚠️ 不經 readEvents:那裡會順手清檔(90 天清理),看一眼別的專案不該動到它的檔。只有真的有感測器故障時才會被叫。
 */
export function hookTimesIn(logDir) {
  const out = [];
  let files = [];
  try { files = readdirSync(logDir); } catch { return out; }
  for (const f of files) {
    if (f.startsWith('.') || f === SENSOR_FILE || !f.endsWith('.jsonl')) continue;   // 隱藏檔是清檔的暫存
    let raw = '';
    try { raw = readFileSync(join(logDir, f), 'utf8'); } catch { continue; }   // 讀不了的少算——少算只會讓燈更紅,不會假裝好了
    for (const l of raw.split('\n')) {
      if (!l.includes('"hook"')) continue;
      try { const e = JSON.parse(l); const t = Date.parse(e?.ts); if (e?.hook && Number.isFinite(t)) out.push(t); } catch { /* 壞行跳過 */ }
    }
  }
  return out.sort((a, b) => a - b);
}

/** 排好的時間裡,第一個比 t 晚的位置(二分搜尋:jq 不在時記號一個動作一筆,可以上千筆)。 */
function firstAfter(S, t) {
  let lo = 0, hi = S.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (S[m] > t) hi = m; else lo = m + 1; }
  return lo;
}
function lastBefore(S, t) {
  let lo = 0, hi = S.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (S[m] < t) lo = m + 1; else hi = m; }
  return lo > 0 ? S[lo - 1] : null;
}
const iso = (t) => (t === null ? null : new Date(t).toISOString());

/**
 * 感測器:還在壞、時好時壞、已經好了(規格 AC-5)。一段故障 = 中間沒夾著任何一筆感測器紀錄的連續記號。
 *   還在壞 = 最後一筆故障之後,感測器一筆都沒記到。從哪一刻算:最後一筆正常紀錄(lastGood)——
 *     不是最近一次故障:jq 不在時每個動作都會留一筆,那個時間永遠是剛剛,壞了三天也會被講成剛壞。
 *   時好時壞 = 故障出現過不只一段,中間夾著有記到的(例如有些對話找得到 jq、有些找不到)。
 *   已經好了 = 只有一段,之後都記到了。
 */
function sensorOf(F, sensorTimes) {
  if (!F.length) return null;
  const S = sensorTimes();   // 有故障才去讀:平常一筆故障都沒有,不多讀任何檔
  const runs = [[F[0]]];
  for (let i = 1; i < F.length; i++) {
    const k = firstAfter(S, F[i - 1].t);
    if (k < S.length && S[k] < F[i].t) runs.push([F[i]]); else runs.at(-1).push(F[i]);
  }
  const last = F.at(-1), lastRun = runs.at(-1);
  const why = last.why === 'jq 不存在' ? 'jq' : null;
  const base = { count: F.length, why };
  if (firstAfter(S, last.t) >= S.length) {
    // 次數只數這一段(「從 Y 之後……回報 N 次」講的是這一段;以前數的是 90 天內全部,魔鬼教官第一輪,R3)
    return { ...base, count: lastRun.length, state: 'broken', from: lastRun[0].ts, lastGood: iso(lastBefore(S, lastRun[0].t)) };
  }
  if (runs.length > 1) return { ...base, state: 'flaky', lastBad: last.ts };
  // next:故障結束之後第一筆感測器紀錄——「這一輪碰沒碰到」要用(在故障期間開始的對話,第一筆被記到的就是它附近,faultNotes)
  return { ...base, state: 'recovered', from: F[0].ts, to: last.ts, next: iso(S[firstAfter(S, last.t)]) };
}

/** 收工 hook 找不到 node:心跳是 gate.mjs 寫的(要有 node 才跑得起來),所以心跳比最後一次故障晚 = 之後找到 node 了。 */
function gateNodeOf(G, hb) {
  if (!G.length) return null;
  const hbT = Date.parse(hb?.ts);
  const last = G.at(-1);
  if (Number.isFinite(hbT) && hbT > last.t) return { state: 'recovered', count: G.length, from: G[0].ts, to: last.ts };
  const since = G.find((g) => !(Number.isFinite(hbT) && g.t < hbT)) ?? G[0];   // 這一次停擺從最後一次心跳之後的第一筆故障算
  return { state: 'broken', count: G.filter((g) => g.t >= since.t).length, from: since.ts };   // 次數只數這一段(R3)
}

/**
 * 收工 hook 自己出錯。心跳在判斷之前寫,出錯的那一次也有心跳(比故障早幾毫秒)——所以心跳比故障晚 = 之後又跑過一次。
 * 心跳只留最後一次、全機一份:最後一次跑在別的資料夾的話,出錯的那個資料夾之後有沒有跑過看不到——照實講看不到(unclear),不講好了。
 */
function gateErrorOf(E, hb) {
  if (!E.length) return null;
  const hbT = Date.parse(hb?.ts);
  const last = E.at(-1);
  const base = { count: E.length, last: last.ts, cwd: last.cwd };
  if (!(Number.isFinite(hbT) && hbT > last.t)) return { ...base, state: 'broken' };
  if (last.cwd && hb?.cwd === last.cwd) return { ...base, state: 'recovered', from: E[0].ts, to: last.ts };
  return { ...base, state: 'unclear' };
}

/**
 * 三種故障各自在哪一種狀態。只看保留期限內的(跟紀錄同一個期限:那段期間的紀錄畫面本來就不看);
 * 時間看不懂的不分新舊,只數筆數(unreadable),不亮燈。
 * @param sensorTimes 回感測器紀錄時間的函式——有感測器故障時才會被叫
 */
export function faultState({ faults = [], sensorTimes = () => [], heartbeat = null, now = Date.now(), retainDays }) {
  const cutoff = now - retainDays * DAY_MS;
  const by = { sensor: [], 'gate-node': [], 'gate-error': [] };
  let unreadable = 0;
  for (const f of faults) {
    const k = faultKind(f);
    if (k === 'unreadable') { unreadable++; continue; }
    const t = Date.parse(f.ts);
    if (t < cutoff) continue;
    by[k].push({ t, ts: f.ts, why: typeof f.why === 'string' ? f.why : null, cwd: typeof f.cwd === 'string' ? f.cwd : null });
  }
  for (const list of Object.values(by)) list.sort((a, b) => a.t - b.t);
  return {
    retainDays,
    sensor: sensorOf(by.sensor, sensorTimes),
    gateNode: gateNodeOf(by['gate-node'], heartbeat),
    gateError: gateErrorOf(by['gate-error'], heartbeat),
    unreadable,
  };
}

/** 這台電腦現在的故障狀態。終端機與伺服器都叫這一個(老毛病 P2)。 */
export function faultsNow(logDir, { retainDays, now = Date.now() }) {
  return faultState({ faults: readFaults(logDir), sensorTimes: () => hookTimesIn(logDir), heartbeat: gateHeartbeat(logDir), now, retainDays });
}

/* ────────────── 句子:只寫這一份 ────────────── */

const ASK = '把這句給 Claude 看';
const fixFor = (sensor) => (sensor.why === 'jq'
  ? `修法：裝 jq；已經裝了還出現，是 Claude Code 跑 hook 時找不到它——${ASK}。`
  : `修法：${ASK}（原因記在 pipeline-monitor 的 logs/_sensor.jsonl）。`);
const causeOf = (sensor) => (sensor.why === 'jq' ? '找不到 jq' : '感測器回報故障');
const NODE_FIX = `修法：裝 node；已經裝了還出現，是 Claude Code 跑 hook 時找不到它——${ASK}。`;
const GATE_FIX = `修法：${ASK}（原因記在 pipeline-monitor 的 logs/_sensor.jsonl）。`;
/** 「X 到 Y 之間」:兩頭講出來一樣(同一段時間裡)就只講一次 */
const span = (from, to) => (ago(from) === ago(to) ? ago(to) : `${ago(from)}到 ${ago(to)}之間`);

/**
 * 感測器現在是什麼樣子:'broken'(還在壞)、'flaky'(時好時壞)、null(沒事或已經好了)。
 * 終端機「要開新的對話才會開始記」「分不出來」那幾句:還在壞的時候不是真的(規格 AC-3),換掉;
 * 時好時壞的時候「現在記不到」也不是真的——最後一筆故障之後明明又記到了——那幾句照舊,另外講時好時壞(魔鬼教官第一輪,R1)。
 */
export function sensorNow(fs) {
  const st = fs?.sensor?.state;
  return st === 'broken' || st === 'flaky' ? st : null;
}

/**
 * 每一頁上方的橫條:只給還在壞(紅)跟時好時壞／看不到好了沒(黃)。已經好了的不上橫條——jq 斷了五分鐘,
 * 接下來 90 天每一頁都掛一條,真的紅燈出現在同一個位置也沒人看(CLAUDE.md:會亂叫的工具三天後就沒人看)。
 * @returns {{tone:'red'|'amber', text:string}[]}
 */
export function faultBanner(fs) {
  const out = [];
  const s = fs?.sensor, n = fs?.gateNode, g = fs?.gateError, days = fs?.retainDays;
  if (s?.state === 'broken') {
    out.push({ tone: 'red', text: `🔴 這台電腦的感測器記不到東西：${s.lastGood ? `最後一筆正常紀錄是 ${ago(s.lastGood)}，之後就沒記到` : `從 ${ago(s.from)}起就沒記到`}`
      + `（${causeOf(s)}，回報 ${s.count} 次）。那段期間跑的關、改的檔，這裡都看不到。${fixFor(s)}` });
  } else if (s?.state === 'flaky') {
    out.push({ tone: 'amber', text: `🟡 這台電腦的感測器時好時壞：有些對話記得到、有些記不到，最近一次記不到是 ${ago(s.lastBad)}`
      + `（${causeOf(s)}，${days} 天內 ${s.count} 次）。記不到的那幾段時間跑的關，這裡看不到。${fixFor(s)}` });
  }
  if (n?.state === 'broken') {
    out.push({ tone: 'red', text: `🔴 收工 hook 找不到 node：從 ${ago(n.from)}起回報 ${n.count} 次，那段期間收工 hook 沒檢查就放行了。${NODE_FIX}` });
  }
  if (g?.state === 'broken') {
    out.push({ tone: 'red', text: `🔴 收工 hook 自己出錯：最近一次 ${ago(g.last)}（${days} 天內 ${g.count} 次），那幾次可能沒檢查就放行了。${GATE_FIX}` });
  } else if (g?.state === 'unclear') {
    // 舊的記號沒記資料夾(這份規格之前寫的):只講得出「之後跑過」,講不出是不是同一個資料夾
    const after = g.cwd ? `之後只看得到別的資料夾跑過，${basename(g.cwd)} 之後有沒有跑過看不到` : '之後它跑過，但看不出是不是同一個資料夾';
    out.push({ tone: 'amber', text: `🟡 收工 hook ${ago(g.last)}${g.cwd ? `在 ${basename(g.cwd)} ` : ''}出錯過，那一次可能沒檢查就放行了；${after}。${GATE_FIX}` });
  }
  return out;
}

/**
 * 已經好了的故障:只掛在「這一輪」碰到那段期間的對話頁、與那個工作區的終端機,放在五關旁(規格 AC-5)——
 * 那段期間跑的關這裡看不到,「還沒跑」可能是沒記到(R1)。這一輪沒碰到那段期間的不講。
 * @param since     這一輪從哪一刻算起(roundView 的 origin.at);不知道 → 當成碰得到(寧可多講一句)
 * @param startKnown 那一刻是真的起點(A、章、對話的轉錄檔建立的時間),還是「感測器第一筆記到的」——後者在感測器壞掉期間開始的對話,
 *                  第一筆被記到的就在修好之後:「故障結束到這一輪起點之間,感測器一筆都沒記到」就當成碰得到(魔鬼教官第一輪,R1)。
 *                  ⚠️ 只套在感測器的故障上:收工 hook 壞掉不會吃掉對話的開頭——以前也套在它上面,拿最近一次心跳比,
 *                     收工 hook 壞過又好了之後,那一句掛在幾乎每一個對話上 90 天(魔鬼教官第二輪)
 * 起點與 startKnown 由 roundStartFor 算——終端機、對話頁同一個(P2)
 * @param until     這個對話你按結案的時間:結案在故障開始之前的,沒碰到(不然 19 天前結案的對話也被叫去懷疑)
 * @param cwd       這個對話／工作區的資料夾:收工 hook 出錯只講出錯的那個資料夾
 */
export function faultNotes(fs, { since = null, startKnown = true, until = null, cwd = null } = {}) {
  const out = [];
  const sinceMs = Date.parse(since), untilMs = Date.parse(until);
  const touches = (x, hidden = false) => !(Date.parse(x.from) > untilMs)
    && (!Number.isFinite(sinceMs) || Date.parse(x.to) >= sinceMs || (hidden && !startKnown && x.next != null && Date.parse(x.next) >= sinceMs));
  const s = fs?.sensor, n = fs?.gateNode, g = fs?.gateError, days = fs?.retainDays;
  if (s?.state === 'recovered' && touches(s, true)) {
    out.push(`⚠️ 感測器在 ${span(s.from, s.to)}記不到（${causeOf(s)}），那段時間跑的關這裡看不到——「還沒跑」可能是沒記到。`);
  }
  // 收工 hook 的心跳只留最後一次,分不出好幾次故障各是哪一段——不講「X 到 Y 之間」,講最近一次與次數(R3)
  if (n?.state === 'recovered' && touches(n)) out.push(`⚠️ 收工 hook 最近一次找不到 node 是 ${ago(n.to)}（${days} 天內 ${n.count} 次），那幾次它沒檢查就放行了。`);
  if (g?.state === 'recovered' && touches(g) && (!cwd || !g.cwd || g.cwd === cwd)) {
    out.push(`⚠️ 收工 hook ${ago(g.to)}在這裡出錯過，那一次可能沒檢查就放行了；之後在這裡跑過，沒再記到出錯。`);
  }
  return out;
}

/**
 * 這一輪從哪一刻算起、那一刻是不是真的起點(給 faultNotes)。終端機與對話頁都走這一個——以前只有對話頁看轉錄檔,
 * 同一個資料夾終端機講「感測器壞過」、對話頁不講(魔鬼教官第二輪,P2)。
 *   起點是 A 或章 → 是真的。
 *   起點是感測器第一筆記到的(prompt／arrival) → 看這一輪那幾個對話的轉錄檔建立的時間(最早那個);
 *     有一個拿不到、或建立的時間反而比第一筆紀錄晚(檔案被換過之類)→ 不知道真的起點,照 faultNotes 的保守規則。
 * @param sessions 這一輪在這裡的對話 [{id, cwd}]
 * @param bornOf   拿一個對話開始的時間(預設看轉錄檔;測試換掉它——檔案的建立時間不是每種系統都改得動,P8)
 */
export function roundStartFor({ since = null, how = null, sessions = [], transcriptsDir = undefined, bornOf = (x) => sessionStartOf(x.id, x.cwd, transcriptsDir) }) {
  if (how === 'A' || how === 'checkpoint') return { since, startKnown: true };
  const born = sessions.map(bornOf);
  if (!born.length || born.some((b) => !b)) return { since, startKnown: false };
  const first = born.sort()[0];
  return !since || first < since ? { since: first, startKnown: true } : { since, startKnown: false };
}

/** 時間或內容看不懂的記號:不亮燈、不上橫條,只在終端機講一句(規格 AC-4)。 */
export function unreadableLine(fs) {
  return fs?.unreadable ? `另有 ${fs.unreadable} 筆看不懂的故障記號（時間或內容讀不懂），沒算進上面——要查就${ASK}。` : null;
}
