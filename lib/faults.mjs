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
import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import process from 'node:process';
import { ago, real, git } from './git.mjs';
import { sessionStartOf } from './transcript.mjs';
import { zhEn, plural } from './lang.mjs';
import { makeDataDir } from './paths.mjs';

/** 故障記號的檔案(hook.sh、gate.sh 也寫死這個名字)。它不是專案,讀專案清單時要跳過它——只跳它。 */
export const SENSOR_FILE = '_sensor.jsonl';
/** 收工 hook 的心跳:gate.mjs 每次跑都寫(先寫心跳、再判斷——出錯的那一次也有心跳)。沒有這個檔 = 它從沒跑過(L13)。 */
export const GATE_FILE = '_gate.json';
/** 改檔把關的心跳:guard.mjs 每次跑都寫(先寫心跳、再判斷)。沒有這個檔 = 它從沒跑過(P3)。 */
export const GUARD_FILE = '_guard.json';
/** 分級通知的心跳:escalate.mjs 每次跑都寫(先寫心跳、再判斷)。沒有這個檔 = 它從沒跑過(P3)。 */
export const ESCALATE_FILE = '_escalate.json';
const DAY_MS = 86400_000;
const UNREADABLE = { ts: null, why: '看不懂的一行' };

export function gateHeartbeat(logDir) {
  try { return JSON.parse(readFileSync(join(logDir, GATE_FILE), 'utf8')); } catch { return null; }
}

export function guardHeartbeat(logDir) {
  try { return JSON.parse(readFileSync(join(logDir, GUARD_FILE), 'utf8')); } catch { return null; }
}

export function escalateHeartbeat(logDir) {
  try { return JSON.parse(readFileSync(join(logDir, ESCALATE_FILE), 'utf8')); } catch { return null; }
}

/**
 * 記下 hook 心跳：除了頂層 { ts, cwd }，同時在 byCwd[cwd] 各自記下每個資料夾的最後執行時間（P2/P3），
 * 避免切到 worktree 或別的專案後覆寫原本資料夾的證據，讓已恢復的舊黃燈在保留期內復活。
 * 寫入採同目錄隱藏暫存檔＋renameSync 原子替換（失敗靜默清掉暫存檔），絕不鎖死對話或編輯。
 */
export function recordHeartbeat(logDir, file, cwd = null, { retainDays = null, now = Date.now() } = {}) {
  const cleanCwd = typeof cwd === 'string' && cwd ? cwd : null;
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = Number.isFinite(retainDays) ? nowMs - retainDays * DAY_MS : -Infinity;
  const target = join(logDir, file);
  let existing = null;
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch { existing = null; }
  const byCwd = Object.create(null);
  const put = (k, isoStr) => {
    if (typeof k !== 'string' || !k || typeof isoStr !== 'string') return;
    const t = Date.parse(isoStr);
    if (!Number.isFinite(t) || t < cutoff) return;
    const prev = byCwd[k] ? Date.parse(byCwd[k]) : NaN;
    if (!Number.isFinite(prev) || t > prev) byCwd[k] = isoStr;
  };
  if (existing?.byCwd && typeof existing.byCwd === 'object' && !Array.isArray(existing.byCwd)) {
    for (const [k, v] of Object.entries(existing.byCwd)) put(k, v);
  } else if (typeof existing?.cwd === 'string' && existing.cwd && typeof existing?.ts === 'string') {
    put(existing.cwd, existing.ts);
  }
  if (cleanCwd) put(cleanCwd, nowIso);
  // 只有本次時間不早於既有頂層時間才一併更新頂層 { ts, cwd }，避免併發寫入錯配（預審 #3）
  const prevTopT = typeof existing?.ts === 'string' ? Date.parse(existing.ts) : NaN;
  const keepPrevTop = Number.isFinite(prevTopT) && prevTopT > nowMs;
  const topTs = keepPrevTop ? existing.ts : nowIso;
  const topCwd = keepPrevTop ? (typeof existing.cwd === 'string' && existing.cwd ? existing.cwd : null) : cleanCwd;
  const tmp = join(logDir, `.${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    makeDataDir(logDir);
    writeFileSync(tmp, JSON.stringify({ ts: topTs, cwd: topCwd, byCwd }) + '\n');
    renameSync(tmp, target);
  } catch {
    try { unlinkSync(tmp); } catch { /* 清理暫存檔失敗就略過 */ }
  }
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
function faultKind(f) {
  if (!f || !Number.isFinite(Date.parse(f.ts))) return 'unreadable';
  if (f.event === 'sensor_broken') return 'sensor';
  if (f.event === 'gate_broken') return f.why === '找不到 node' ? 'gate-node' : 'gate-error';
  if (f.event === 'guard_broken') return f.why === '找不到 node' ? 'guard-node' : 'guard-error';
  if (f.event === 'escalate_broken') return f.why === '找不到 node' ? 'escalate-node' : 'escalate-error';
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
 * 同一工作區判斷（P2/R1/P13）：gateErrorOf 與 faultNotes 共用同一套標準，
 * 僅在路徑完全相等、real() 相同，或兩者皆實際存在且 git rev-parse --show-toplevel 解析後相同時才算同一個，
 * 不再保留「路徑不存在時退回 true」與「父子路徑預篩」分支，避免已刪嵌套 worktree 誤判恢復或平級子資料夾漏記。
 */
function sameWorkspace(cwdA, cwdB) {
  if (!cwdA || !cwdB) return false;
  if (cwdA === cwdB) return true;
  const a = real(cwdA), b = real(cwdB);
  if (a === b) return true;
  if (existsSync(a) && existsSync(b)) {
    const ta = git(['rev-parse', '--show-toplevel'], a);
    const tb = git(['rev-parse', '--show-toplevel'], b);
    if (ta && tb) return real(ta) === real(tb);
  }
  return false;
}

/**
 * 拆出心跳檔的時間與各工作區紀錄（預審 #3）：
 * 只要檔案具備合法的 byCwd 物件，就只看 byCwd、絕不再退回讀頂層 { ts, cwd }，防止併發寫入錯配造假恢復；
 * 只有舊版無 byCwd 的心跳檔才相容退回頂層 { ts, cwd }。
 */
function heartbeatInfo(hb) {
  let maxT = Date.parse(hb?.ts);
  if (!Number.isFinite(maxT)) maxT = NaN;
  const hasByCwd = Boolean(hb && typeof hb === 'object' && !Array.isArray(hb) && hb.byCwd && typeof hb.byCwd === 'object' && !Array.isArray(hb.byCwd));
  const entries = [];
  if (hasByCwd) {
    for (const [cwd, ts] of Object.entries(hb.byCwd)) {
      if (typeof cwd !== 'string' || !cwd || typeof ts !== 'string') continue;
      const t = Date.parse(ts);
      if (!Number.isFinite(t)) continue;
      entries.push({ cwd, t });
      if (!Number.isFinite(maxT) || t > maxT) maxT = t;
    }
  } else if (typeof hb?.cwd === 'string' && hb.cwd && Number.isFinite(maxT)) {
    entries.push({ cwd: hb.cwd, t: maxT });
  }
  return { maxT, entries };
}

/**
 * 收工 hook／改檔把關／分級通知自己出錯。心跳在判斷之前寫，出錯的那一次也有心跳（比故障早幾毫秒），
 * 依故障各自的工作區（cwd）分組對照心跳檔 byCwd：
 *   - 只要該組最後一筆錯誤之後有同工作區心跳 → 該組已恢復，不論整體為 broken／unclear／recovered 一律帶出 recovered 陣列（預審 #1）
 *   - 沒記到任何晚於最後錯誤的全機心跳 → broken（紅燈），仍帶出先前已恢復組的 recovered
 *   - 全機最新心跳晚於最後錯誤、但仍有未恢復分組 → unclear（黃燈），依時間由新到舊帶出 unrecovered 陣列，互不蓋掉（AC-2）
 */
function gateErrorOf(E, hb) {
  if (!E.length) return null;
  const { maxT, entries } = heartbeatInfo(hb);
  const groups = [];
  for (const e of E) {
    let g = e.cwd
      ? groups.find((x) => x.cwd && sameWorkspace(x.cwd, e.cwd))
      : groups.find((x) => x.cwd === null);
    if (!g) {
      g = { cwd: e.cwd ?? null, from: e.ts, to: e.ts, lastT: e.t, count: 1 };
      groups.push(g);
    } else {
      if (e.cwd) g.cwd = e.cwd;
      g.to = e.ts;
      g.lastT = e.t;
      g.count++;
    }
  }
  const recovered = [];
  const unrecovered = [];
  for (const g of groups) {
    const ok = Boolean(g.cwd) && entries.some((h) => h.t > g.lastT && sameWorkspace(g.cwd, h.cwd));
    if (ok) recovered.push({ cwd: g.cwd, from: g.from, to: g.to, count: g.count });
    else unrecovered.push({ cwd: g.cwd, last: g.to, from: g.from, to: g.to, count: g.count, _t: g.lastT });
  }
  unrecovered.sort((a, b) => b._t - a._t);
  const cleanUnrec = unrecovered.map(({ _t, ...rest }) => rest);
  const last = E.at(-1);
  const base = { count: E.length, last: last.ts, cwd: last.cwd };
  if (!(Number.isFinite(maxT) && maxT > last.t)) {
    return { ...base, state: 'broken', recovered, unrecovered: cleanUnrec };
  }
  if (!cleanUnrec.length) {
    return { ...base, state: 'recovered', from: E[0].ts, to: last.ts, recovered, unrecovered: [] };
  }
  const head = cleanUnrec[0];
  return { count: E.length, last: head.last, cwd: head.cwd, state: 'unclear', unrecovered: cleanUnrec, recovered };
}

/**
 * 三種故障各自在哪一種狀態。只看保留期限內的(跟紀錄同一個期限:那段期間的紀錄畫面本來就不看);
 * 時間看不懂的不分新舊,只數筆數(unreadable),不亮燈。
 * @param sensorTimes 回感測器紀錄時間的函式——有感測器故障時才會被叫
 */
export function faultState({ faults = [], sensorTimes = () => [], heartbeat = null, guardHb = null, escalateHb = null, now = Date.now(), retainDays }) {
  const cutoff = now - retainDays * DAY_MS;
  const by = { sensor: [], 'gate-node': [], 'gate-error': [], 'guard-node': [], 'guard-error': [], 'escalate-node': [], 'escalate-error': [] };
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
    guardNode: gateNodeOf(by['guard-node'], guardHb),
    guardError: gateErrorOf(by['guard-error'], guardHb),
    escalateNode: gateNodeOf(by['escalate-node'], escalateHb),
    escalateError: gateErrorOf(by['escalate-error'], escalateHb),
    unreadable,
  };
}

/** 這台電腦現在的故障狀態。終端機與伺服器都叫這一個(老毛病 P2)。
 *  move:搬家還沒搬完的樣子(lib/paths.mjs 的 moveState;規格:紀錄搬到固定的家 AC-5)——呼叫端算好給,這裡只負責講。 */
export function faultsNow(logDir, { retainDays, now = Date.now(), move = null }) {
  return { ...faultState({ faults: readFaults(logDir), sensorTimes: () => hookTimesIn(logDir), heartbeat: gateHeartbeat(logDir), guardHb: guardHeartbeat(logDir), escalateHb: escalateHeartbeat(logDir), now, retainDays }), move, logDir };
}

/* ────────────── 句子:只寫這一份 ────────────── */
// 中英兩種並排(規格:儀表板與終端機中英切換)。用到的那一刻才拿(函式,不是載入時就定死的常數):語言照這一次輸出的

const ask = () => zhEn('把這句給 AI 看', 'show this line to the AI');
// 原因記在哪:用這一次真的讀的那個資料夾(faultsNow 帶出來的),不寫死——還沒搬成、或家指到別處時,寫死的那一個是錯的地方,
// AI 照著去讀會回你「沒有記原因」(魔鬼教官第一輪;R1)
const whereOf = (fs) => (fs?.logDir ? tilde(join(fs.logDir, SENSOR_FILE)) : zhEn(`紀錄資料夾的 ${SENSOR_FILE}`, `${SENSOR_FILE} in the records folder`));
const fixFor = (sensor, where) => (sensor.why === 'jq'
  ? zhEn(`修法：裝 jq；已經裝了還出現，是 Antigravity 跑 hook 時找不到它——${ask()}。`, `To fix it: install jq; if it's installed and this still shows up, Antigravity can't find it when it runs the hook: ${ask()}.`)
  : zhEn(`修法：${ask()}（原因記在 ${where}）。`, `To fix it: ${ask()} (the cause is recorded in ${where}).`));
const causeOf = (sensor) => (sensor.why === 'jq' ? zhEn('找不到 jq', 'can\'t find jq') : zhEn('感測器回報故障', 'the sensor reported a fault'));
const nodeFix = () => zhEn(`修法：裝 node；已經裝了還出現，是 Antigravity 跑 hook 時找不到它——${ask()}。`, `To fix it: install node; if it's installed and this still shows up, Antigravity can't find it when it runs the hook: ${ask()}.`);
const gateFix = (where) => zhEn(`修法：${ask()}（原因記在 ${where}）。`, `To fix it: ${ask()} (the cause is recorded in ${where}).`);
/** 搬不成的原因(錯誤代號)翻成白話;代號本身不上畫面。 */
const moveWhy = (code) => ({
  EXDEV: zhEn('舊的地方跟新家不在同一顆磁碟，沒辦法一次搬過去', 'the old place and the new home are on different disks, so it can\'t be moved in one go'),
  EACCES: zhEn('沒有權限', 'no permission'), EPERM: zhEn('沒有權限', 'no permission'), ENOSPC: zhEn('磁碟滿了', 'the disk is full'),
})[code] ?? zhEn('搬的時候出錯', 'something went wrong while moving');
const tilde = (p) => (p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);

/**
 * 搬家還沒搬完(規格:紀錄搬到固定的家 AC-5):紀錄明明在,畫面卻可能看起來像「還沒有任何案件」——一定要講。
 * both:新家也有東西,舊的那一份這裡讀不到;否則新家還沒有,讀寫照舊用舊的地方(看得到,只是還沒搬)。
 * @param m lib/paths.mjs 的 moveState 回的;null → null
 */
export function moveLine(m) {
  if (!m) return null;
  const what = m.kinds.map((k) => (k === 'logs' ? zhEn('紀錄', 'records') : zhEn('還原點', 'restore points'))).join(zhEn('與', ' and '));
  if (m.both) {
    return zhEn(`🟡 舊的${what}還有一部分留在 ${tilde(m.from)}，這裡看不到它們：新家（${tilde(m.to)}）也有同名的檔，`
      + `沒有自動合併，免得蓋掉任何一份。${ask()}。`,
    `🟡 Part of the old ${what} is still in ${tilde(m.from)}, and this can't see it: the new home (${tilde(m.to)}) has files with the same names, `
      + `and they weren't merged automatically so that nothing gets overwritten. ${capFirst(ask())}.`);
  }
  return zhEn(`🟡 ${what}還在舊的地方（${tilde(m.from)}），沒搬到新家（${tilde(m.to)}）${m.why ? `：${moveWhy(m.why)}` : ''}。`
    + `照樣在記、看得到；${ask()}。`,
  `🟡 The ${what} are still in the old place (${tilde(m.from)}), not moved to the new home (${tilde(m.to)})${m.why ? `: ${moveWhy(m.why)}` : ''}. `
    + `Still recording and visible; ${ask()}.`);
}

/** 「X 到 Y 之間」:兩頭講出來一樣(同一段時間裡)就只講一次 */
const span = (from, to) => (ago(from) === ago(to) ? ago(to) : zhEn(`${ago(from)}到 ${ago(to)}之間`, `between ${ago(from)} and ${ago(to)}`));
/** 英文句子開頭大寫 */
const capFirst = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

/**
 * 感測器現在是什麼樣子:'broken'(還在壞)、'flaky'(時好時壞)、null(沒事或已經好了)。
 * 終端機「要開新的對話才會開始記」「分不出來」那幾句:還在壞的時候不是真的(規格 AC-3),換掉;
 * 時好時壞的時候「現在記不到」也不是真的——最後一筆故障之後明明又記到了——那幾句照舊,另外講時好時壞(魔鬼教官第一輪,R1)。
 */
export function sensorNow(fs) {
  const st = fs?.sensor?.state;
  return st === 'broken' || st === 'flaky' ? st : null;
}

/** 「N 天內」:天數由呼叫端給(lib/events.mjs 的 RETAIN_DAYS)——這支不准 import events.mjs,那支已經 import 這支,會繞成圈。
 *  沒給天數也不准把 undefined 印到畫面上 */
const within = (days) => (Number.isFinite(days) ? zhEn(`${days} 天內`, `in the last ${days} days`) : zhEn('保留期限內', 'within the retention period'));

/**
 * 感測器那一行,沒有來自這個資料夾的紀錄時講哪一句(規格:90天清空之後的說法 AC-4)。終端機與儀表板同一句(老毛病 P2)。
 * 「還沒有」只在這個專案連紀錄檔都沒有(hasLog === false)時講——有紀錄檔就是記過,這裡的可能超過保留期限清掉了,
 * 只講得出「N 天內沒有」(R1:以前清空之後還說「還沒有」,像剛裝好、從沒記過)。不知道有沒有紀錄檔 → 講「N 天內沒有」:永遠是真的。
 */
export function noneHereLine({ hasLog, days } = {}) {
  return hasLog === false ? zhEn('還沒有來自這裡的紀錄', 'No records from here yet') : zhEn(`${within(days)}沒有來自這裡的紀錄`, `No records from here ${within(days)}`);
}

/**
 * 你退出記錄的那一句:終端機與對話頁的感測器那一行、儀表板的退出記錄那一條同一句(規格:90天清空之後的說法 AC-4;老毛病 P2)。
 * 以前寫「之前的紀錄還在」:退出之後感測器不再記,舊的照樣滿 90 天清掉——那句遲早變假的(R1)。
 */
export function optedOutLine({ at = null, days, ago: agoOf = ago } = {}) {
  return zhEn(`這個專案已退出記錄（${at ? agoOf(at) : '時間不明'}），之前記的照樣${Number.isFinite(days) ? `留到滿 ${days} 天` : '留到保留期限滿'}。`,
    `This project opted out of recording (${at ? agoOf(at) : 'time unknown'}); what was recorded before is still kept ${Number.isFinite(days) ? `until it's ${days} days old` : 'until the retention period ends'}.`);
}

/**
 * 感測器那一行,設定裡沒掛上的那兩種:你自己退出了、設定裡找不到但紀錄還有。終端機與儀表板講同一句——
 * 以前各寫一份,結尾已經不一樣(老毛病 P2;C 打掃 2026-10-05 留的建議)。here 是「見哪裡」:終端機在上面那一行、網頁在最上面那一條。
 * 回 null = 沒掛上、也沒有來自這裡的紀錄(怎麼掛各自講:終端機給指令、網頁叫你在那個資料夾跑)。不是 off 的(掛著、掛壞了)也回 null,各自那一段講。
 * ⚠️ 這台電腦的感測器現在記不到東西(now === 'broken')時,「它在記」只到最後那一筆為止——不准講成現在還在記(R1;規格:agent回報與故障記號 AC-3)。
 *    時好時壞(flaky)時它真的還在記,只是有些對話記不到——不講「之後記不到」。
 * @param days 紀錄留幾天(退出記錄那一句要講;呼叫端給 RETAIN_DAYS)
 */
export function sensorOffLine({ mount, lastSeen, now = null, here, ago: agoOf = ago, days }) {
  if (mount?.state !== 'off') return null;
  if (mount.optedOut) return zhEn(`感測器：${optedOutLine({ at: mount.optedOut.at, days, ago: agoOf })}`, `Sensor: ${optedOutLine({ at: mount.optedOut.at, days, ago: agoOf })}`);
  if (!lastSeen) return null;
  return now === 'broken'
    ? zhEn(`感測器：設定裡找不到,但 ${agoOf(lastSeen)}還有來自這裡的紀錄——那時候它在記,只是不知道是哪份設定在做；之後這台電腦的感測器記不到東西（見${here}）。`,
      `Sensor: not found in the settings, but there was a record from here ${agoOf(lastSeen)}: it was recording then, just not sure which settings were doing it; after that, this computer's sensor couldn't record anything (see ${here}).`)
    : zhEn(`感測器：設定裡找不到,但 ${agoOf(lastSeen)}還有來自這裡的紀錄——它在記,只是不知道是哪份設定在做${now === 'flaky' ? `（這台電腦的感測器時好時壞，見${here}）` : ''}。`,
      `Sensor: not found in the settings, but there was a record from here ${agoOf(lastSeen)}: it is recording, just not sure which settings are doing it${now === 'flaky' ? ` (this computer's sensor works on and off; see ${here})` : ''}.`);
}

/** 收工 hook 活著沒:看心跳,不看設定——「掛著」不等於「活著」(L13)。終端機與儀表板同一句(規格:終端機與網頁說同一句 表 12) */
export function gateLine(hb, { ago: agoOf = ago } = {}) {
  if (!hb?.ts) {
    return zhEn('收工 hook：還沒跑過（裝好 plugin 之後要開新對話;一直沒跑就是它沒被觸發,不是沒事）',
      'Closing hook: hasn\'t run yet (after installing the plugin you need to open a new conversation; if it never runs, it isn\'t being triggered, which doesn\'t mean all is well)');
  }
  return zhEn(`收工 hook：最後一次跑 ${agoOf(hb.ts)}`, `Closing hook: last ran ${agoOf(hb.ts)}`);
}

/** 改檔把關活著沒:看心跳,不看設定——終端機與儀表板同一句(P2/P3) */
export function guardLine(hb, { ago: agoOf = ago } = {}) {
  if (!hb?.ts) {
    return zhEn('改檔把關：還沒跑過（開新對話或下一個回合改檔案時會觸發；一直沒跑就是它沒被觸發）',
      'Edit guard: hasn\'t run yet (triggers when editing a file in a new conversation or next turn; if it never runs, it isn\'t being triggered)');
  }
  return zhEn(`改檔把關：最後一次跑 ${agoOf(hb.ts)}`, `Edit guard: last ran ${agoOf(hb.ts)}`);
}

/** 分級通知活著沒:看心跳,不看設定——終端機與儀表板同一句(P2/P3) */
export function escalateLine(hb, { ago: agoOf = ago } = {}) {
  if (!hb?.ts) {
    return zhEn('分級通知：還沒跑過（開新對話或下一個回合就會觸發；一直沒跑就是它沒被觸發）',
      'Tier notice: hasn\'t run yet (triggers in a new conversation or next turn; if it never runs, it isn\'t being triggered)');
  }
  return zhEn(`分級通知：最後一次跑 ${agoOf(hb.ts)}`, `Tier notice: last ran ${agoOf(hb.ts)}`);
}

/**
 * 感測器那一行的零件(誠實修補 D):終端機分好幾行印、儀表板接成一行,字是這一份(規格:終端機與網頁說同一句 表 11、13)。
 * 「掛在哪」看設定(mount),「活著嗎」看紀錄(lastSeen)與心跳(gate、guard、escalate)。設定裡沒掛上、但有紀錄或你退出了的那兩種,另見 sensorOffLine。
 * @param notMountedHow 沒掛上時「怎麼掛」那半句:終端機給指令,網頁叫你去那個資料夾跑(AC-4)
 * @returns {{ mounted, broken, em, seen, stopped, gate, guard, escalate, notMounted }}  em:掛壞了那一句裡要標出來的那一段(終端機用 ** 圍起來、網頁用粗體)
 */
export function sensorParts({ mount = null, lastSeen = null, gate = null, guard = null, escalate = null, ago: agoOf = ago, notMountedHow = zhEn('（打 agy-pipeline --on 掛上）', ' (type agy-pipeline --on to hook it up)') } = {}) {
  const where = mount?.where === 'plugin' ? zhEn('（plugin,每個專案都會記）', ' (plugin; every project gets recorded)')
    : mount?.where === 'main' ? zhEn('（用的是主資料夾的設定）', ' (using the main folder\'s settings)')
    : mount?.where === 'user' ? zhEn('（用的是你帳號層級的設定）', ' (using your account-level settings)') : '';
  const seen = lastSeen ? zhEn(`最後一筆來自這裡的紀錄：${agoOf(lastSeen)}`, `Last record from here: ${agoOf(lastSeen)}`) : null;
  return {
    mounted: zhEn(`感測器：已掛上${where}`, `Sensor: hooked up${where}`),
    // ⚠️ 最危險的一種:設定看起來好好的,但它指向的檔案不見了,而 hook 永遠靜默,紀錄只是安靜地停止增加(L13)
    broken: zhEn('感測器：🔴 掛著,但它指向的檔案不存在——紀錄已經停了,而且不會有任何徵兆', 'Sensor: 🔴 hooked up, but the file it points to doesn\'t exist — recording has stopped, and there won\'t be any sign of it'),
    em: zhEn('紀錄已經停了,而且不會有任何徵兆', 'recording has stopped, and there won\'t be any sign of it'),
    seen,
    stopped: seen ? zhEn(`${seen}——從那之後就沒有了`, `${seen}; nothing since then`) : null,
    gate: gateLine(gate, { ago: agoOf }),
    guard: guardLine(guard, { ago: agoOf }),
    escalate: escalateLine(escalate, { ago: agoOf }),
    notMounted: zhEn(`感測器：沒掛上${notMountedHow}`, `Sensor: not hooked up${notMountedHow}`),
  };
}

/**
 * 每一頁上方的橫條:只給還在壞(紅)跟時好時壞／看不到好了沒(黃)。已經好了的不上橫條——jq 斷了五分鐘,
 * 接下來 90 天每一頁都掛一條,真的紅燈出現在同一個位置也沒人看(CLAUDE.md:會亂叫的工具三天後就沒人看)。
 * @returns {{tone:'red'|'amber', text:string}[]}
 */
const unclearItemsOf = (x) => (Array.isArray(x?.unrecovered) && x.unrecovered.length ? x.unrecovered : [x]);
const unclearAfter = (cwd) => (cwd
  ? zhEn(`之後只看得到別的資料夾跑過，${basename(cwd)} 之後有沒有跑過看不到`, `after that only other folders can be seen running it; can't see whether it ran in ${basename(cwd)} after that`)
  : zhEn('之後它跑過，但看不出是不是同一個資料夾', 'it ran after that, but can\'t tell whether it was the same folder'));

export function faultBanner(fs) {
  const out = [];
  const mv = moveLine(fs?.move);
  if (mv) out.push({ tone: 'amber', text: mv });
  const s = fs?.sensor, n = fs?.gateNode, g = fs?.gateError, gn = fs?.guardNode, gg = fs?.guardError, en = fs?.escalateNode, ee = fs?.escalateError, days = fs?.retainDays;
  if (s?.state === 'broken') {
    out.push({ tone: 'red', text: zhEn(`🔴 這台電腦的感測器記不到東西：${s.lastGood ? `最後一筆正常紀錄是 ${ago(s.lastGood)}，之後就沒記到` : `從 ${ago(s.from)}起就沒記到`}`
      + `（${causeOf(s)}，回報 ${s.count} 次）。那段期間跑的關、改的檔，這裡都看不到。${fixFor(s, whereOf(fs))}`,
    `🔴 This computer's sensor can't record anything: ${s.lastGood ? `the last normal record was ${ago(s.lastGood)}, and nothing was recorded after that` : `nothing recorded since ${ago(s.from)}`}`
      + ` (${causeOf(s)}, reported ${plural(s.count, 'time')}). Stages run and files changed during that time can't be seen here. ${fixFor(s, whereOf(fs))}`) });
  } else if (s?.state === 'flaky') {
    out.push({ tone: 'amber', text: zhEn(`🟡 這台電腦的感測器時好時壞：有些對話記得到、有些記不到，最近一次記不到是 ${ago(s.lastBad)}`
      + `（${causeOf(s)}，${days} 天內 ${s.count} 次）。記不到的那幾段時間跑的關，這裡看不到。${fixFor(s, whereOf(fs))}`,
    `🟡 This computer's sensor works on and off: some conversations get recorded and some don't; the last miss was ${ago(s.lastBad)}`
      + ` (${causeOf(s)}, ${plural(s.count, 'time')} in the last ${days} days). Stages run during the missed stretches can't be seen here. ${fixFor(s, whereOf(fs))}`) });
  }
  if (n?.state === 'broken') {
    out.push({ tone: 'red', text: zhEn(`🔴 收工 hook 找不到 node：從 ${ago(n.from)}起回報 ${n.count} 次，那段期間收工 hook 沒檢查就放行了。${nodeFix()}`,
      `🔴 The closing hook can't find node: reported ${plural(n.count, 'time')} since ${ago(n.from)}; during that time the closing hook let things through without checking. ${nodeFix()}`) });
  }
  if (g?.state === 'broken') {
    out.push({ tone: 'red', text: zhEn(`🔴 收工 hook 自己出錯：最近一次 ${ago(g.last)}（${days} 天內 ${g.count} 次），那幾次可能沒檢查就放行了。${gateFix(whereOf(fs))}`,
      `🔴 The closing hook itself ran into errors: most recently ${ago(g.last)} (${plural(g.count, 'time')} in the last ${days} days); those times it might have let things through without checking. ${gateFix(whereOf(fs))}`) });
  } else if (g?.state === 'unclear') {
    for (const u of unclearItemsOf(g)) {
      out.push({ tone: 'amber', text: zhEn(`🟡 收工 hook ${ago(u.last)}${u.cwd ? `在 ${basename(u.cwd)} ` : ''}出錯過，那一次可能沒檢查就放行了；${unclearAfter(u.cwd)}。${gateFix(whereOf(fs))}`,
        `🟡 The closing hook ran into an error ${ago(u.last)}${u.cwd ? ` in ${basename(u.cwd)}` : ''}, and that time it might have let things through without checking; ${unclearAfter(u.cwd)}. ${gateFix(whereOf(fs))}`) });
    }
  }
  if (gn?.state === 'broken') {
    out.push({ tone: 'red', text: zhEn(`🔴 改檔把關找不到 node：從 ${ago(gn.from)}起回報 ${gn.count} 次，那段期間改危險檔可能沒跳出來問你。${nodeFix()}`,
      `🔴 The edit guard can't find node: reported ${plural(gn.count, 'time')} since ${ago(gn.from)}; during that time editing danger files might not have asked you first. ${nodeFix()}`) });
  }
  if (gg?.state === 'broken') {
    out.push({ tone: 'red', text: zhEn(`🔴 改檔把關自己出錯：最近一次 ${ago(gg.last)}（${days} 天內 ${gg.count} 次），那幾次改危險檔可能沒跳出來問你。${gateFix(whereOf(fs))}`,
      `🔴 The edit guard itself ran into errors: most recently ${ago(gg.last)} (${plural(gg.count, 'time')} in the last ${days} days); those times editing danger files might not have asked you first. ${gateFix(whereOf(fs))}`) });
  } else if (gg?.state === 'unclear') {
    for (const u of unclearItemsOf(gg)) {
      out.push({ tone: 'amber', text: zhEn(`🟡 改檔把關 ${ago(u.last)}${u.cwd ? `在 ${basename(u.cwd)} ` : ''}出錯過，那一次改危險檔可能沒跳出來問你；${unclearAfter(u.cwd)}。${gateFix(whereOf(fs))}`,
        `🟡 The edit guard ran into an error ${ago(u.last)}${u.cwd ? ` in ${basename(u.cwd)}` : ''}, and that time editing danger files might not have asked you first; ${unclearAfter(u.cwd)}. ${gateFix(whereOf(fs))}`) });
    }
  }
  if (en?.state === 'broken') {
    out.push({ tone: 'red', text: zhEn(`🔴 分級通知找不到 node：從 ${ago(en.from)}起回報 ${en.count} 次，那段期間分級往上升可能沒即時通知 AI。${nodeFix()}`,
      `🔴 The tier escalation notice can't find node: reported ${plural(en.count, 'time')} since ${ago(en.from)}; during that time tier escalations might not have notified the AI right away. ${nodeFix()}`) });
  }
  if (ee?.state === 'broken') {
    out.push({ tone: 'red', text: zhEn(`🔴 分級通知自己出錯：最近一次 ${ago(ee.last)}（${days} 天內 ${ee.count} 次），那幾次分級往上升可能沒即時通知 AI。${gateFix(whereOf(fs))}`,
      `🔴 The tier escalation notice itself ran into errors: most recently ${ago(ee.last)} (${plural(ee.count, 'time')} in the last ${days} days); those times tier escalations might not have notified the AI right away. ${gateFix(whereOf(fs))}`) });
  } else if (ee?.state === 'unclear') {
    for (const u of unclearItemsOf(ee)) {
      out.push({ tone: 'amber', text: zhEn(`🟡 分級通知 ${ago(u.last)}${u.cwd ? `在 ${basename(u.cwd)} ` : ''}出錯過，那一次分級往上升可能沒即時通知 AI；${unclearAfter(u.cwd)}。${gateFix(whereOf(fs))}`,
        `🟡 The tier escalation notice ran into an error ${ago(u.last)}${u.cwd ? ` in ${basename(u.cwd)}` : ''}, and that time a tier escalation might not have notified the AI right away; ${unclearAfter(u.cwd)}. ${gateFix(whereOf(fs))}`) });
    }
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
const recoveredItemsOf = (x) => {
  if (!x) return [];
  if (Array.isArray(x.recovered)) return x.recovered;
  return x.state === 'recovered' ? [x] : [];
};

export function faultNotes(fs, { since = null, startKnown = true, until = null, cwd = null } = {}) {
  const out = [];
  const sinceMs = Date.parse(since), untilMs = Date.parse(until);
  const touches = (x, hidden = false) => !(Date.parse(x.from) > untilMs)
    && (!Number.isFinite(sinceMs) || Date.parse(x.to) >= sinceMs || (hidden && !startKnown && x.next != null && Date.parse(x.next) >= sinceMs));
  const s = fs?.sensor, n = fs?.gateNode, g = fs?.gateError, gn = fs?.guardNode, gg = fs?.guardError, en = fs?.escalateNode, ee = fs?.escalateError, days = fs?.retainDays;
  if (s?.state === 'recovered' && touches(s, true)) {
    out.push(zhEn(`⚠️ 感測器在 ${span(s.from, s.to)}記不到（${causeOf(s)}），那段時間跑的關這裡看不到——「還沒跑」可能是沒記到。`,
      `⚠️ The sensor couldn't record ${span(s.from, s.to)} (${causeOf(s)}); stages run then can't be seen here, so "not run yet" might mean it wasn't recorded.`));
  }
  // 收工 hook 的心跳只留最後一次,分不出好幾次故障各是哪一段——不講「X 到 Y 之間」,講最近一次與次數(R3)
  if (n?.state === 'recovered' && touches(n)) {
    out.push(zhEn(`⚠️ 收工 hook 最近一次找不到 node 是 ${ago(n.to)}（${days} 天內 ${n.count} 次），那幾次它沒檢查就放行了。`,
      `⚠️ The last time the closing hook couldn't find node was ${ago(n.to)} (${plural(n.count, 'time')} in the last ${days} days); those times it let things through without checking.`));
  }
  for (const item of recoveredItemsOf(g)) {
    if (touches(item) && (!cwd || !item.cwd || sameWorkspace(item.cwd, cwd))) {
      out.push(zhEn(`⚠️ 收工 hook ${ago(item.to)}在這裡出錯過，那一次可能沒檢查就放行了；之後在這裡跑過，沒再記到出錯。`,
        `⚠️ The closing hook ran into an error here ${ago(item.to)}, and that time it might have let things through without checking; it has run here since, with no more errors recorded.`));
    }
  }
  if (gn?.state === 'recovered' && touches(gn)) {
    out.push(zhEn(`⚠️ 改檔把關最近一次找不到 node 是 ${ago(gn.to)}（${days} 天內 ${gn.count} 次），那幾次改危險檔可能沒跳出來問你。`,
      `⚠️ The last time the edit guard couldn't find node was ${ago(gn.to)} (${plural(gn.count, 'time')} in the last ${days} days); those times editing danger files might not have asked you first.`));
  }
  for (const item of recoveredItemsOf(gg)) {
    if (touches(item) && (!cwd || !item.cwd || sameWorkspace(item.cwd, cwd))) {
      out.push(zhEn(`⚠️ 改檔把關 ${ago(item.to)}在這裡出錯過，那一次改危險檔可能沒跳出來問你；之後在這裡跑過，沒再記到出錯。`,
        `⚠️ The edit guard ran into an error here ${ago(item.to)}, and that time editing danger files might not have asked you first; it has run here since, with no more errors recorded.`));
    }
  }
  if (en?.state === 'recovered' && touches(en)) {
    out.push(zhEn(`⚠️ 分級通知最近一次找不到 node 是 ${ago(en.to)}（${days} 天內 ${en.count} 次），那幾次分級往上升可能沒即時通知 AI。`,
      `⚠️ The last time the tier escalation notice couldn't find node was ${ago(en.to)} (${plural(en.count, 'time')} in the last ${days} days); those times tier escalations might not have notified the AI right away.`));
  }
  for (const item of recoveredItemsOf(ee)) {
    if (touches(item) && (!cwd || !item.cwd || sameWorkspace(item.cwd, cwd))) {
      out.push(zhEn(`⚠️ 分級通知 ${ago(item.to)}在這裡出錯過，那一次分級往上升可能沒即時通知 AI；之後在這裡跑過，沒再記到出錯。`,
        `⚠️ The tier escalation notice ran into an error here ${ago(item.to)}, and that time a tier escalation might not have notified the AI right away; it has run here since, with no more errors recorded.`));
    }
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
export function roundStartFor({ since = null, how = null, sessions = [], events = [], extraTranscripts = null, home = undefined, bornOf = (x) => sessionStartOf(x.id, events, { extraTranscripts, ...(home ? { home } : {}) }) }) {
  if (how === 'A' || how === 'checkpoint') return { since, startKnown: true };
  const born = sessions.map(bornOf);
  if (!born.length || born.some((b) => !b)) return { since, startKnown: false };
  const first = born.sort()[0];
  if (!since) return { since: first, startKnown: true };
  // Antigravity 轉錄檔 step 0 時間與第一句話（origin.at）同源相等，須允許 <=（也以 Date.parse 避開 .000Z vs Z 字串誤差；P3/P9）
  const tFirst = Date.parse(first), tSince = Date.parse(since);
  return Number.isFinite(tFirst) && Number.isFinite(tSince) && tFirst <= tSince
    ? { since: first, startKnown: true }
    : { since, startKnown: false };
}

/** 時間或內容看不懂的記號:不亮燈、不上橫條,只在終端機講一句(規格 AC-4)。 */
export function unreadableLine(fs) {
  return fs?.unreadable ? zhEn(`另有 ${fs.unreadable} 筆看不懂的故障記號（時間或內容讀不懂），沒算進上面——要查就${ask()}。`,
    `There are also ${plural(fs.unreadable, 'fault mark')} that can't be read (the time or content is unreadable), not counted above; to look into them, ${ask()}.`) : null;
}
