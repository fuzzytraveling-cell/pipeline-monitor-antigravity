/**
 * events.mjs —— 讀感測器寫下的事件。規格:<專案>/docs/進行中/pipeline-sensor.md
 *
 * ⚠️ 這支檔案存在的唯一理由,是**分清楚三件長得一樣的事**(AC-1 / AC-7):
 *     ① 紀錄檔不存在        → 感測器還沒裝,或這個專案還沒用過 → 「還不知道」
 *     ② 紀錄檔存在但沒有事件 → 感測器裝了但沒收到東西       → 「感測器可能沒在運作」
 *     ③ 有事件,但沒有這一關   → 這一關**真的**沒跑過          → 「沒跑過」
 *   把①②講成③就是謊話,而且會害人重跑已經跑過的檢查,或以為驗過了其實沒有。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RETAIN_DAYS = 90;   // AC-5:保留三個月(2026-09-09 Oscar 決定)
/** 感測器自己回報故障的檔案(hook.sh 也寫死這個名字)。它不是專案,讀專案清單時要跳過它——只跳它。 */
export const SENSOR_FILE = '_sensor.jsonl';

/**
 * 專案名 → 檔名。⚠️ 這是 hook.sh 那條 `LC_ALL=C tr -c 'A-Za-z0-9._-' '_'` 的 JS 翻譯,
 * 兩邊必須**逐位元組**一樣:hook 寫的是 `TutorPod_AI_v4.jsonl`,讀取端拿 `TutorPod AI v4` 去找
 * 就永遠「還沒有紀錄」(誠實修補 C1,2026-09-11)。
 * 逐位元組不是逐字元:中文一個字 3 bytes → 3 個底線,跟 tr 一樣。
 * 兩份實作的唯一共識來源是 scripts/sensor.test.mjs——它真的跑 hook.sh,對兩邊的答案。改任何一邊它會紅。
 */
export function safeName(name) {
  return Array.from(Buffer.from(String(name), 'utf8'), (b) => {
    const ch = String.fromCharCode(b);
    return /[A-Za-z0-9._-]/.test(ch) ? ch : '_';
  }).join('');
}

/** 某個專案的紀錄檔在哪。讀(readEvents)跟寫(--clear)都從這裡拿,不准各自拼字串(老毛病 P2)。 */
export function logFileOf(logDir, project) {
  return join(logDir, `${safeName(project)}.jsonl`);
}

/**
 * @returns {{state:'no-file'|'no-events'|'ok', events:Array, broken:Array}}
 *   state 刻意分三種,呼叫端不准折成布林。
 */
export function readEvents(logDir, project) {
  const file = logFileOf(logDir, project);
  if (!existsSync(file)) return { state: 'no-file', events: [], broken: [] };

  const events = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // ⚠️ AC-4:兩個 worktree 同時寫,萬一還是交錯了,壞行**跳過就好**,
      // 不得讓整份紀錄變成不可讀——一筆壞掉不該害死其他幾千筆。
    }
  }
  // 感測器自己回報的故障(例如 jq 不在)。這是 AC-1 的第二個來源。
  // ⚠️ 它是全機一份、不分專案——所以只能當「那幾次可能漏記」的警告,
  //    不能拿來蓋掉整區紀錄(誠實修補 D2:以前一有故障,幾千筆紀錄都被講成「裡面沒有東西」)。
  const brokenFile = join(logDir, SENSOR_FILE);
  const broken = existsSync(brokenFile)
    ? readFileSync(brokenFile, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return { ts: null, why: '看不懂的一行' }; }
      })
    : [];

  if (!events.length) return { state: 'no-events', events: [], broken };
  return { state: 'ok', events: rotate(file, events), broken };
}

/** AC-5:超過保留期限的丟掉。⚠️ 丟掉的是真的沒了——呼叫端問到更早的期間
 *  要回答「超過保留期限」,不是「沒跑過」。 */
function rotate(file, events) {
  const cutoff = Date.now() - RETAIN_DAYS * 86400_000;
  const kept = events.filter((e) => {
    const t = new Date(e.ts).getTime();
    return !Number.isFinite(t) || t >= cutoff;   // 時間讀不出來的**留著**,不要因為看不懂就刪
  });
  if (kept.length !== events.length) {
    try {
      writeFileSync(file, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } catch { /* 寫不回去不影響這次顯示,下次再試 */ }
  }
  return kept;
}

/** 專案的關卡定義。專案自己的覆寫優先(AC-6:清單只有一份,但可以換一份)。 */
export function loadStages(monitorDir, projectRoot) {
  const override = join(projectRoot, '.claude', 'pipeline-stages.json');
  const src = existsSync(override) ? override : join(monitorDir, 'stages.json');
  try {
    return { stages: JSON.parse(readFileSync(src, 'utf8')).stages ?? [], from: src };
  } catch {
    return { stages: [], from: null };
  }
}

/**
 * 每一關**最後一次**被呼叫是什麼時候。
 * ⚠️ AC-3:這裡算的是「跑過」。**沒有任何欄位代表「通過」**,因為感測器沒記,
 *    也不該記——它無從得知。
 */
export function lastRunPerStage(events, stages, cwd) {
  const mine = events.filter((e) => e.cwd === cwd);
  const out = new Map();
  for (const s of stages) {
    if (!s.skill) continue;
    const runs = mine.filter((e) => e.skill === s.skill && e.hook === 'PreToolUse');
    out.set(s.id, runs.length ? runs[runs.length - 1] : null);
  }
  return { perStage: out, sawAnyEventHere: mine.length > 0 };
}

/** AC-10:這一輪(prompt_id)動過哪些檔案。只有路徑,沒有內容。 */
export function filesByTurn(events, cwd) {
  const turns = new Map();
  for (const e of events) {
    if (e.cwd !== cwd || !e.file) continue;
    if (!turns.has(e.prompt_id)) turns.set(e.prompt_id, new Set());
    turns.get(e.prompt_id).add(e.file);
  }
  return turns;
}

export { RETAIN_DAYS };


/**
 * 把事件切成「一個對話一組」。
 *
 * ⚠️ Oscar 2026-09-10 指出:他習慣**一個功能開一個對話**,而每個對話跑在自己的
 *    worktree／分支上。所以「對話」才是他真正的工作單位,不是「專案」。
 *    我原本用專案當單位是錯的——那讓他七個對話擠成一張卡。
 *
 * ⚠️ 但要誠實:對話與工作區**通常**是一對一,不保證。
 *    同一個資料夾開兩個對話時,它們共用 git 狀態——那件事必須講出來,
 *    不然使用者會以為那是兩套獨立的東西。
 */
export function sessionsOf(events) {
  const map = new Map();
  for (const e of events) {
    if (!e.session) continue;
    let s = map.get(e.session);
    if (!s) {
      s = { id: e.session, title: null, cwd: e.cwd ?? null,
            firstTs: e.ts, lastTs: e.ts, prompts: 0, closedAt: null };
      map.set(e.session, s);
    }
    if (e.title) s.title = e.title;           // session_title 會隨對話改名而更新,取最後一個
    if (e.cwd) s.cwd = e.cwd;
    if (e.hook === 'UserPromptSubmit') s.prompts++;
    if (e.event === 'session_closed') s.closedAt = e.ts;
    if (e.ts < s.firstTs) s.firstTs = e.ts;
    if (e.ts > s.lastTs) s.lastTs = e.ts;
  }
  const list = [...map.values()];
  // 同一個工作區有幾個對話——用來講「這兩個對話共用 git 狀態」
  const perCwd = new Map();
  for (const s of list) perCwd.set(s.cwd, (perCwd.get(s.cwd) ?? 0) + 1);
  for (const s of list) s.sharesCwd = (perCwd.get(s.cwd) ?? 1) > 1;
  return list.sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
}

/** 某一個對話跑過哪幾關（只看這個對話自己的事件） */
export function stagesOfSession(events, stages, sessionId) {
  const mine = events.filter((e) => e.session === sessionId);
  const cleared = new Map();
  for (const e of mine) if (e.event === 'stage_cleared') cleared.set(e.stage, e);
  return stages.map((st) => {
    if (!st.skill) return { id: st.id, name: st.name, type: st.type ?? null, ranAt: null, args: null, clearedAt: null };
    const runs = mine.filter((e) => e.skill === st.skill && e.hook === 'PreToolUse');
    const run = runs.length ? runs[runs.length - 1] : null;
    const clr = cleared.get(st.id) ?? null;
    return {
      id: st.id, name: st.name, type: st.type ?? null,
      ranAt: run?.ts ?? null, args: run?.args ?? null,
      clearedAt: clr && run && new Date(clr.ts) >= new Date(run.ts) ? clr.ts : null,
    };
  });
}
