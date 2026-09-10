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

/**
 * @returns {{state:'no-file'|'no-events'|'ok', events:Array, broken:Array}}
 *   state 刻意分三種,呼叫端不准折成布林。
 */
export function readEvents(logDir, project) {
  const file = join(logDir, `${project}.jsonl`);
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
  const brokenFile = join(logDir, '_sensor.jsonl');
  const broken = existsSync(brokenFile)
    ? readFileSync(brokenFile, 'utf8').split('\n').filter(Boolean)
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
