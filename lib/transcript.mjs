/**
 * transcript.mjs —— 讀取 Antigravity 原生對話轉錄檔（transcript.jsonl）
 *
 * 階段 0 本機實測確認的事實：
 *   - 人類發言記為 source:"USER_EXPLICIT" / type:"USER_INPUT"（含 step_index、created_at、content）
 *   - subagent 的 lastUserInput 為 ""，且 step 0 為 type:"SYSTEM_MESSAGE" 含 sender=<主對話ID>
 *   - PostToolUse / Stop payload 皆帶 transcriptPath；hook.sh 熱路徑不讀大檔，只記路徑，由這裡讀並快取。
 *
 * 設計重點：
 *   1. 只讀、按 (path, mtimeMs, size) 快取，儀表板每 5 秒刷新不重讀未變動的長對話。
 *   2. 讀不到、檔案被刪、壞行一律靜默跳過或回 { ok: false }，絕不害畫面或收工門禁掛掉（R1）。
 *   3. 補上「剛說完話就執行 run_command」的時序差：Antigravity 呼叫模型前就寫進 transcript，
 *      所以 --decide / --clear / --wrap / --tier-later 與 Stop 門禁當場就能對到使用者剛講的話。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEvents, PROMPT_CAP } from './events.mjs';

const CACHE_LIMIT = 200;
const cache = new Map();
const SENDER_RE = /\bsender=([A-Za-z0-9._-]+)/;
// Antigravity 不同前端（2.0 / CLI / IDE）的對話腦區目錄，只在紀錄裡還沒記到 transcriptPath 時備援找
const BRAIN_ROOTS = ['antigravity', 'antigravity-cli', 'antigravity-ide'];

/** 清空記憶體快取（供測試重設）。 */
export function clearTranscriptCache() {
  cache.clear();
}

/**
 * 拆掉 Antigravity transcript 裡包裹人類發言的 <USER_REQUEST>...</USER_REQUEST>（與後方 <ADDITIONAL_METADATA>）。
 * 實測確認：Antigravity 寫進 transcript.jsonl / transcript_full.jsonl 的 USER_INPUT 皆帶此系統外框；
 * 若不拆框，後續系統標籤檢查會把每句真話誤判成「開頭是 <USER_REQUEST> 的不明訊息」。
 * 不帶此外框的字串原樣保留（含其他系統 XML 標籤，維持原過濾機制）。
 */
export function unwrapUserRequest(content) {
  if (typeof content !== 'string') return '';
  const trimmed = content.trim();
  if (!trimmed.startsWith('<USER_REQUEST>')) return content;
  let inner = trimmed.slice('<USER_REQUEST>'.length);
  const end = inner.indexOf('</USER_REQUEST>');
  if (end !== -1) inner = inner.slice(0, end);
  return inner.trim();
}

/**
 * 讀單一 transcript.jsonl。按 (mtimeMs, size) 快取。
 * @returns {{ ok: true, isSubagent: boolean, parentId: string|null, startedAt: string|null, prompts: Array<{step:number|null, ts:string, prompt:string, cut:boolean}> } | { ok: false }}
 */
export function readTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return { ok: false };
  let st;
  try { st = statSync(transcriptPath); } catch { return { ok: false }; }
  if (!st.isFile()) return { ok: false };
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(transcriptPath);
  if (hit && hit.sig === sig) return hit.val;

  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return { ok: false }; }
  const prompts = [];
  let first = null;
  let isSubagent = false;
  let parentId = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    if (!first) {
      first = entry;
      if (entry.type === 'SYSTEM_MESSAGE' || entry.source === 'SYSTEM') {
        const m = String(entry.content ?? '').match(SENDER_RE);
        if (m) { isSubagent = true; parentId = m[1]; }
      }
    }
    if (entry.source === 'USER_EXPLICIT' && entry.type === 'USER_INPUT' && typeof entry.created_at === 'string' && Number.isFinite(Date.parse(entry.created_at))) {
      const content = unwrapUserRequest(typeof entry.content === 'string' ? entry.content : '');
      const chars = [...content];
      const cut = chars.length >= PROMPT_CAP;
      prompts.push({
        step: typeof entry.step_index === 'number' ? entry.step_index : null,
        ts: entry.created_at,
        prompt: chars.slice(0, PROMPT_CAP).join(''),
        cut,
      });
    }
  }

  const firstTs = typeof first?.created_at === 'string' && Number.isFinite(Date.parse(first.created_at)) ? first.created_at : null;
  const birthTs = st.birthtimeMs > 0 ? new Date(st.birthtimeMs).toISOString() : null;
  const val = { ok: true, isSubagent, parentId, startedAt: firstTs ?? birthTs, prompts };

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(transcriptPath, { sig, val });
  return val;
}

/**
 * 若紀錄裡尚未出現這個對話的 transcript 路徑（例如新對話第一回合還沒寫進 jsonl），
 * 依 Antigravity 標準路徑試找實際存在的 transcript.jsonl；找不到就回 null（不猜，R1）。
 */
export function guessTranscriptPath(sessionId, home = homedir()) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{4,120}$/.test(sessionId)) return null;
  for (const dir of BRAIN_ROOTS) {
    for (const file of ['transcript.jsonl', 'transcript_full.jsonl']) {
      const p = join(home, '.gemini', dir, 'brain', sessionId, '.system_generated', 'logs', file);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** 這個工具是不是瀏覽器動作（供把 browser subagent 動作歸屬回主對話）。 */
const BROWSER_TOOL = /^(?:browser_|webview_browser$|mcp__(?:chrome[-_]?devtools|.*[Bb]rowser.*))/;

/**
 * 把原始感測器事件與 Antigravity transcript.jsonl 合併成讀取端統一事件流：
 *   1. 有可讀 transcript 的人類對話 → 補入真實 USER_EXPLICIT / USER_INPUT 成為 hook:'UserPrompt' 事件（以 (session, step) 去重）。
 *   2. 沒有可讀 transcript（例如純事件測試或轉錄檔已刪除）且沒有既有 UserPrompt/UserPromptSubmit 的對話 →
 *      退回從 PostToolUse 的 prompt（lastUserInput）在內容變化時補一筆 UserPrompt（同回合重複呼叫不重算起點）。
 *   3. 偵測到 subagent（transcript step 0 為 SYSTEM_MESSAGE 含 sender=<parentId>，或事件自帶 subagent_parent）→
 *      原事件標 _subagent:true（不成為獨立人類對話卡、不觸發收工門禁），其中的瀏覽器工具事件歸屬一份回 parentId（保留原時間與 url_host）。
 *
 * 純函式，不修改呼叫端傳入陣列或物件。
 */
export function enrichWithTranscripts(events, { extraTranscripts = null, read = readTranscript, home = homedir(), sessionId = null, cwd = null } = {}) {
  const list = Array.isArray(events) ? events : [];
  // 收集每個對話的 transcript 路徑與帶時間戳的 cwd 歷程（避免對話中途換 worktree 後全貼上舊 cwd，P6/R1）
  const pathBySession = new Map();
  const fallbackCwd = new Map();
  const cwdTimeline = new Map();
  const hasExplicitPrompt = new Set();
  const explicitParent = new Map();

  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (e.event === 'guard_asked' || e.event === 'tier_notified') continue;
    if (typeof e.session === 'string' && e.session) {
      if (typeof e.transcript === 'string' && e.transcript) pathBySession.set(e.session, e.transcript);
      if (typeof e.cwd === 'string' && e.cwd) {
        if (!fallbackCwd.has(e.session)) fallbackCwd.set(e.session, e.cwd);
        const t = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN;
        if (Number.isFinite(t)) {
          if (!cwdTimeline.has(e.session)) cwdTimeline.set(e.session, []);
          cwdTimeline.get(e.session).push({ t, cwd: e.cwd });
        }
      }
      if (e.hook === 'UserPrompt' || e.hook === 'UserPromptSubmit') hasExplicitPrompt.add(e.session);
      if (typeof e.subagent_parent === 'string' && e.subagent_parent) explicitParent.set(e.session, e.subagent_parent);
    }
  }
  for (const arr of cwdTimeline.values()) arr.sort((a, b) => a.t - b.t);
  if (sessionId && cwd && !fallbackCwd.has(sessionId)) fallbackCwd.set(sessionId, cwd);

  /** 依時間戳配對該對話當下所在資料夾：優先取該時刻之後最早一次動作的 cwd（同回合工具所在），沒有就取之前最近一次，最後才退回預設。 */
  const cwdAt = (sid, ts) => {
    const arr = cwdTimeline.get(sid);
    const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
    if (arr?.length && Number.isFinite(t)) {
      const next = arr.find((x) => x.t >= t);
      if (next) return next.cwd;
      return arr[arr.length - 1].cwd;
    }
    return fallbackCwd.get(sid) ?? null;
  };
  if (extraTranscripts) {
    for (const [sid, tp] of extraTranscripts instanceof Map ? extraTranscripts : Object.entries(extraTranscripts)) {
      if (sid && typeof tp === 'string' && tp) pathBySession.set(sid, tp);
    }
  }
  if (sessionId && !pathBySession.has(sessionId)) {
    const guessed = guessTranscriptPath(sessionId, home);
    if (guessed) pathBySession.set(sessionId, guessed);
  }

  // 解析每份 transcript
  const parsed = new Map();
  const subagentParent = new Map(explicitParent);
  for (const [sid, tp] of pathBySession) {
    const t = read(tp);
    if (!t?.ok) continue;
    parsed.set(sid, t);
    if (t.isSubagent && t.parentId) subagentParent.set(sid, t.parentId);
  }

  // 解析主對話鏈（萬一 subagent 再派 subagent，追到最上層主對話，防循環限 5 層）
  const rootParentOf = (sid) => {
    let cur = sid;
    for (let i = 0; i < 5 && subagentParent.has(cur); i++) cur = subagentParent.get(cur);
    return cur === sid ? null : cur;
  };

  // 先建立原始事件輸出（subagent 事件標記 _subagent:true，瀏覽器動作歸屬回主對話）
  const out = [];
  const lastFallbackPrompt = new Map();
  const seenStep = new Set();
  const seenPromptTs = new Set();

  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const sid = typeof e.session === 'string' ? e.session : null;
    const parent = sid ? rootParentOf(sid) : null;
    if (parent) {
      out.push({ ...e, _subagent: true, _parent: parent });
      if (e.hook === 'PostToolUse' && typeof e.tool === 'string' && BROWSER_TOOL.test(e.tool)) {
        out.push({
          ...e,
          session: parent,
          cwd: cwdAt(parent, e.ts) ?? e.cwd,
          _fromSubagent: sid,
        });
      }
      continue;
    }
    if (sid && (e.hook === 'UserPrompt' || e.hook === 'UserPromptSubmit')) {
      if (typeof e.step === 'number') seenStep.add(`${sid}\0${e.step}`);
      if (typeof e.ts === 'string') seenPromptTs.add(`${sid}\0${e.ts}\0${e.prompt ?? ''}`);
    }
    out.push(e);

    // 備援：沒有可讀 transcript 且沒有既有 UserPrompt 事件時，從 PostToolUse.prompt 變化合成 UserPrompt
    if (sid && e.hook === 'PostToolUse' && !parsed.has(sid) && !hasExplicitPrompt.has(sid)
        && typeof e.prompt === 'string' && e.prompt !== '') {
      if (lastFallbackPrompt.get(sid) !== e.prompt) {
        lastFallbackPrompt.set(sid, e.prompt);
        out.push({
          ts: e.ts,
          hook: 'UserPrompt',
          session: sid,
          cwd: e.cwd,
          head: e.head ?? null,
          prompt: e.prompt,
          _fromFallback: true,
        });
      }
    }
  }

  // 從可讀 transcript 補入真實人類發言（每則發言配對該對話當下所在資料夾，不鎖死第一筆）
  for (const [sid, t] of parsed) {
    if (t.isSubagent) continue;
    for (const p of t.prompts) {
      if (p.step !== null && seenStep.has(`${sid}\0${p.step}`)) continue;
      if (seenPromptTs.has(`${sid}\0${p.ts}\0${p.prompt}`)) continue;
      if (p.step !== null) seenStep.add(`${sid}\0${p.step}`);
      seenPromptTs.add(`${sid}\0${p.ts}\0${p.prompt}`);
      const pCwd = cwdAt(sid, p.ts);
      out.push({
        ts: p.ts,
        hook: 'UserPrompt',
        session: sid,
        ...(pCwd ? { cwd: pCwd } : {}),
        ...(p.step !== null ? { step: p.step } : {}),
        prompt: p.prompt,
        ...(p.cut ? { prompt_cut: true } : {}),
        _fromTranscript: true,
      });
    }
  }

  // 依時間穩定排序（無效時間放後面保持原相對順序）
  return out
    .map((e, idx) => ({ e, idx, t: typeof e?.ts === 'string' ? Date.parse(e.ts) : NaN }))
    .sort((a, b) => {
      const fa = Number.isFinite(a.t), fb = Number.isFinite(b.t);
      if (fa && fb && a.t !== b.t) return a.t - b.t;
      return a.idx - b.idx;
    })
    .map((x) => x.e);
}

/**
 * 讀專案事件並合併 transcript（cli / collect / gate 共用單一入口，老毛病 P2）。
 * lib/events.mjs 保持只管儲存與清理，不依賴本模組。
 */
export function loadEvents(logDir, project, opts = {}) {
  const ev = readEvents(logDir, project, opts);
  return { ...ev, events: enrichWithTranscripts(ev.events, opts) };
}

/**
 * 這個對話真正開始的時間：讀 transcript step 0 的 created_at（或檔建立時間）。
 * 找不到或讀不到回 null（R1：不猜）。
 */
export function sessionStartOf(sessionId, events = [], { extraTranscripts = null, read = readTranscript, home = homedir() } = {}) {
  if (!sessionId) return null;
  let tp = extraTranscripts instanceof Map ? extraTranscripts.get(sessionId) : extraTranscripts?.[sessionId];
  if (!tp) {
    for (const e of Array.isArray(events) ? events : []) {
      if (e?.session === sessionId && typeof e.transcript === 'string' && e.transcript) { tp = e.transcript; break; }
    }
  }
  tp ??= guessTranscriptPath(sessionId, home);
  if (!tp) return null;
  const t = read(tp);
  return t?.ok ? t.startedAt : null;
}

/**
 * 快速判斷某個對話是不是 subagent（給 gate.mjs 在 Stop hook 使用）。
 * 依階段 0 事實 #4：lastUserInput 為 "" 且 transcript step 0 為 SYSTEM_MESSAGE 含 sender=。
 */
export function isSubagentPayload(payload, { read = readTranscript } = {}) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.transcriptPath === 'string' && payload.transcriptPath) {
    const t = read(payload.transcriptPath);
    if (t?.ok) return t.isSubagent === true;
  }
  return false;
}
