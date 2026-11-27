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
import { join, dirname, basename } from 'node:path';
import { readEvents, PROMPT_CAP } from './events.mjs';

const CACHE_LIMIT = 200;
const cache = new Map();
const SENDER_RE = /\bsender=([A-Za-z0-9._-]+)/;
// Antigravity 不同前端（2.0 / CLI / IDE）的對話腦區目錄，只在紀錄裡還沒記到 transcriptPath 時備援找
const BRAIN_ROOTS = ['antigravity', 'antigravity-cli', 'antigravity-ide'];
const HEADER_TS_RE = /^(Created|Completed)\s+At:\s*(.+)$/i;
const ASK_ANSWER_RE = /^A(\d+):(?:\s*(.*))?$/;
const COMPACTION_MODERN_RE = /^\s*#\s*Resuming from a compaction\b/i;
const COMPACTION_LEGACY_RE = /^\s*\{\{\s*CHECKPOINT\s+\d+\s*\}\}[\s\S]{0,240}truncated due to its long length/i;

const isNonNegFinite = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function parseValidIso(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  return Number.isFinite(Date.parse(v.trim())) ? v.trim() : null;
}
function isCompactionContent(text) {
  if (typeof text !== 'string' || !text) return false;
  return COMPACTION_MODERN_RE.test(text) || COMPACTION_LEGACY_RE.test(text);
}

/** 清空記憶體快取（供測試重設）。 */
export function clearTranscriptCache() {
  cache.clear();
}

/** 依 Unicode 字元數截斷至 PROMPT_CAP，並標記是否觸及上限（與既有 transcript 截斷口徑一致，P2）。 */
function capByChars(text) {
  const chars = [...String(text ?? '')];
  return { text: chars.slice(0, PROMPT_CAP).join(''), cut: chars.length >= PROMPT_CAP };
}

/**
 * 解析 Antigravity ask_question 工具結果內容（`source:"MODEL"` + `type:"GENERIC"` 配對 `ask_question` 或舊版 `type:"ASK_QUESTION"`）。
 *   - 剝除開頭 1–2 組 `Created At:` / `Completed At:` 標頭，優先取最後一個合法 `Completed At` 轉 UTC ISO（真正送出時刻）。
 *   - 絕不拿 `Created At`（彈出時間）充數；無 `Completed At` 時僅在給了 `fallbackTs` 或 `allowMissingTs` 時繼續（R1 / P9）。
 *   - 標頭後首個非空行必須為 `An:`，並聚合其後多行續行（複選／多行 Other），全空或格式不符回 null（P7）。
 */
export function parseAskQuestionReply(content, { fallbackTs = null, allowMissingTs = false } = {}) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let completedTs = null;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) { i++; continue; }
    const hm = trimmed.match(HEADER_TS_RE);
    if (!hm) break;
    if (hm[1].toLowerCase() === 'completed') {
      const ms = Date.parse(hm[2].trim());
      if (Number.isFinite(ms)) completedTs = new Date(ms).toISOString();
    }
    i++;
  }
  let ts = completedTs;
  if (!ts && typeof fallbackTs === 'string' && fallbackTs.trim()) {
    const ms = Date.parse(fallbackTs.trim());
    if (Number.isFinite(ms)) ts = new Date(ms).toISOString();
  }
  if (!ts && !allowMissingTs) return null;

  const answers = [];
  let cur = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!cur && !line.trim()) continue;
    const am = line.match(ASK_ANSWER_RE);
    if (am) {
      if (cur) answers.push(cur);
      cur = { num: am[1], parts: [am[2] ?? ''] };
    } else if (cur) {
      cur.parts.push(line);
    } else {
      return null;
    }
  }
  if (cur) answers.push(cur);

  const nonEmpty = answers
    .map((a) => ({ num: a.num, text: a.parts.join('\n').trim() }))
    .filter((a) => a.text.length > 0);
  if (!nonEmpty.length) return null;

  if (nonEmpty.length === 1) {
    const c = capByChars(nonEmpty[0].text);
    return { ts, prompt: c.text, cut: c.cut, askAnswers: [c.text] };
  }
  const combined = nonEmpty.map((a) => `A${a.num}: ${a.text}`).join('\n');
  const c = capByChars(combined);
  const askAnswers = nonEmpty.map((a) => capByChars(a.text).text);
  return { ts, prompt: c.text, cut: c.cut, askAnswers };
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
 * 讀單一 transcript.jsonl / transcript_full.jsonl。按 (mtimeMs, size) 快取。
 * @returns {{ ok: true, isSubagent: boolean, parentId: string|null, startedAt: string|null, prompts: Array<{step:number|null, ts:string|null, prompt:string, cut:boolean, via?:string, askAnswers?:string[]}> } | { ok: false }}
 */
export function readTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return { ok: false, reason: 'missing' };
  let st;
  try { st = statSync(transcriptPath); } catch (e) {
    return { ok: false, reason: e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  }
  if (!st.isFile()) return { ok: false, reason: 'unreadable' };
  const fullFallbackPath = basename(transcriptPath) === 'transcript.jsonl'
    ? join(dirname(transcriptPath), 'transcript_full.jsonl') : null;
  let fullSig = '';
  if (fullFallbackPath) {
    try {
      const fst = statSync(fullFallbackPath);
      if (fst.isFile()) fullSig = `|${fst.mtimeMs}:${fst.size}`;
    } catch { /* 同目錄無 transcript_full.jsonl，必要時略過截斷筆 */ }
  }
  const sig = `${st.mtimeMs}:${st.size}${fullSig}`;
  const hit = cache.get(transcriptPath);
  if (hit && hit.sig === sig) return hit.val;

  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch (e) {
    return { ok: false, reason: e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  }
  const prompts = [];
  let first = null;
  let isSubagent = false;
  let parentId = null;

  // 若讀 compact 版 transcript.jsonl 遇到 content / tool_calls 被截斷，懶載入同目錄 transcript_full.jsonl 補齊（不靠猜，R1）
  let fullByStep = null;
  const loadFullStep = (stepIdx) => {
    if (typeof stepIdx !== 'number') return null;
    if (fullByStep === null) {
      fullByStep = new Map();
      if (fullFallbackPath && existsSync(fullFallbackPath)) {
        try {
          const fullRaw = readFileSync(fullFallbackPath, 'utf8');
          for (const fl of fullRaw.split('\n')) {
            if (!fl.trim()) continue;
            try {
              const fe = JSON.parse(fl);
              if (fe && typeof fe === 'object' && typeof fe.step_index === 'number') fullByStep.set(fe.step_index, fe);
            } catch { /* skip malformed line */ }
          }
        } catch { /* ignore */ }
      }
    }
    return fullByStep.get(stepIdx) ?? null;
  };

  const extractAsk = (entry, hasStep) => {
    let content = typeof entry.content === 'string' ? entry.content : null;
    if (Array.isArray(entry.truncated_fields) && entry.truncated_fields.includes('content')) {
      const fullEntry = hasStep ? loadFullStep(entry.step_index) : null;
      const fullOk = fullEntry && !(Array.isArray(fullEntry.truncated_fields) && fullEntry.truncated_fields.includes('content')) && typeof fullEntry.content === 'string';
      content = fullOk ? fullEntry.content : null;
    }
    const parsed = content ? parseAskQuestionReply(content, { allowMissingTs: true }) : null;
    if (!parsed) return null;
    return {
      step: hasStep ? entry.step_index : null,
      ts: parsed.ts,
      prompt: parsed.prompt,
      cut: parsed.cut,
      via: 'ask_question',
      askAnswers: parsed.askAnswers,
    };
  };

  // Pass 1：拆開具 step_index 的真實記錄與無 step_index 的合成資料（真實 Antigravity 常把完成的 GENERIC 寫在所屬 PLANNER_RESPONSE 之前，P6）
  const stepped = [];
  const unstepped = [];
  const lines = raw.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { unstepped.push({ bad: true, idx }); continue; }
    if (!entry || typeof entry !== 'object') { unstepped.push({ bad: true, idx }); continue; }
    if (typeof entry.step_index === 'number') stepped.push({ entry, idx });
    else unstepped.push({ entry, idx });
  }
  stepped.sort((a, b) => (a.entry.step_index - b.entry.step_index) || (a.idx - b.idx));

  const firstUnstepped = unstepped.find((x) => !x.bad) ?? null;
  first = (stepped[0] && (stepped[0].entry.step_index === 0 || !firstUnstepped || stepped[0].idx < firstUnstepped.idx))
    ? stepped[0].entry
    : (firstUnstepped?.entry ?? null);
  if (first && (first.type === 'SYSTEM_MESSAGE' || first.source === 'SYSTEM')) {
    const m = String(first.content ?? '').match(SENDER_RE);
    if (m) { isSubagent = true; parentId = m[1]; }
  }

  const pushUserInput = (entry) => {
    const content = unwrapUserRequest(typeof entry.content === 'string' ? entry.content : '');
    const chars = [...content];
    prompts.push({
      step: typeof entry.step_index === 'number' ? entry.step_index : null,
      ts: entry.created_at,
      prompt: chars.slice(0, PROMPT_CAP).join(''),
      cut: chars.length >= PROMPT_CAP,
    });
  };
  const readToolsOf = (entry, hasStep) => {
    let tcs = entry.tool_calls;
    const truncatedTc = Array.isArray(entry.truncated_fields) && entry.truncated_fields.includes('tool_calls');
    if (truncatedTc && hasStep) {
      const fullEntry = loadFullStep(entry.step_index);
      if (fullEntry && Array.isArray(fullEntry.tool_calls)) tcs = fullEntry.tool_calls;
    }
    return Array.isArray(tcs) ? tcs.map((tc) => (typeof tc?.name === 'string' ? tc.name : null)) : null;
  };

  // Pass 2a：依 step_index 嚴格順序配對 PLANNER_RESPONSE 與 TOOL 結果（不因寫檔先後錯漏或位移錯配，P6 / P7）
  let plannerStep = null;
  let plannerTools = null;
  const seenAskSteps = new Set();
  for (const { entry } of stepped) {
    if (entry.source === 'USER_EXPLICIT' && entry.type === 'USER_INPUT' && typeof entry.created_at === 'string' && Number.isFinite(Date.parse(entry.created_at))) {
      pushUserInput(entry);
      plannerStep = null;
      plannerTools = null;
      continue;
    }
    if (entry.type === 'SYSTEM_MESSAGE' || entry.source === 'SYSTEM' || entry.type === 'USER_INPUT') {
      plannerStep = null;
      plannerTools = null;
      continue;
    }
    if (entry.source === 'MODEL' && entry.type === 'PLANNER_RESPONSE') {
      plannerStep = entry.step_index;
      plannerTools = readToolsOf(entry, true);
      continue;
    }
    if (entry.source === 'MODEL' && entry.status === 'DONE') {
      let pairedTool = null;
      if (typeof plannerStep === 'number' && Array.isArray(plannerTools)) {
        const offset = entry.step_index - plannerStep - 1;
        if (offset >= 0 && offset < plannerTools.length) pairedTool = plannerTools[offset];
      }
      if ((entry.type === 'ASK_QUESTION' || (entry.type === 'GENERIC' && pairedTool === 'ask_question'))
          && !seenAskSteps.has(entry.step_index)) {
        const item = extractAsk(entry, true);
        if (item) {
          prompts.push(item);
          seenAskSteps.add(entry.step_index);
        }
      }
    }
  }

  // Pass 2b：無 step_index 的合成資料退回整組順序對位；只有整組筆數相符且無壞行才採認，否則拒收（P7）
  let seqTools = null;
  let seqResults = [];
  let seqBad = false;
  const flushSeqGroup = () => {
    if (Array.isArray(seqTools) && !seqBad && seqResults.length === seqTools.length) {
      for (let k = 0; k < seqResults.length; k++) {
        if (seqTools[k] !== 'ask_question') continue;
        const parsed = parseAskQuestionReply(seqResults[k].content, { allowMissingTs: true });
        if (!parsed) continue;
        prompts.push({
          step: null,
          ts: parsed.ts,
          prompt: parsed.prompt,
          cut: parsed.cut,
          via: 'ask_question',
          askAnswers: parsed.askAnswers,
        });
      }
    }
    seqTools = null;
    seqResults = [];
    seqBad = false;
  };
  for (const row of unstepped) {
    if (row.bad) { seqBad = true; continue; }
    const entry = row.entry;
    if (entry.source === 'USER_EXPLICIT' && entry.type === 'USER_INPUT' && typeof entry.created_at === 'string' && Number.isFinite(Date.parse(entry.created_at))) {
      flushSeqGroup();
      pushUserInput(entry);
      continue;
    }
    if (entry.type === 'SYSTEM_MESSAGE' || entry.source === 'SYSTEM' || entry.type === 'USER_INPUT') {
      flushSeqGroup();
      continue;
    }
    if (entry.source === 'MODEL' && entry.type === 'PLANNER_RESPONSE') {
      flushSeqGroup();
      seqTools = readToolsOf(entry, false);
      continue;
    }
    if (entry.source === 'MODEL') {
      if (entry.type === 'ASK_QUESTION' && entry.status === 'DONE') {
        const item = extractAsk(entry, false);
        if (item) prompts.push(item);
      } else if (Array.isArray(seqTools)) {
        if (entry.type === 'GENERIC') {
          let content = typeof entry.content === 'string' ? entry.content : null;
          if (Array.isArray(entry.truncated_fields) && entry.truncated_fields.includes('content')) content = null;
          seqResults.push({ content: entry.status === 'DONE' ? content : null });
        } else {
          seqBad = true;
        }
      }
    }
  }
  flushSeqGroup();

  // 統計真實 Context Token 用量與壓縮紀錄（階段 0 實證：input_tokens 不含 cache_read_tokens；CHECKPOINT 僅記壓縮次數不混算 token）
  let latest = null;
  let peakTokens = null;
  let peakAt = null;
  let plannerSteps = 0;
  let readableSteps = 0;
  let compactions = 0;
  let lastCompactionAt = null;
  const usageSeq = [
    ...stepped.map((x) => ({ entry: x.entry, hasStep: true })),
    ...unstepped.filter((r) => !r.bad).map((r) => ({ entry: r.entry, hasStep: false })),
  ];
  for (const { entry, hasStep } of usageSeq) {
    if (entry.source === 'SYSTEM' && entry.type === 'CHECKPOINT' && entry.status === 'DONE') {
      let matched = isCompactionContent(entry.content);
      // 精簡轉錄檔若因 truncated_fields 含 content 導致尚未判出壓縮標記，僅對該步驟懶補讀完整轉錄檔（P6 / R1）
      if (!matched && hasStep && Array.isArray(entry.truncated_fields) && entry.truncated_fields.includes('content')) {
        const fullEntry = loadFullStep(entry.step_index);
        if (fullEntry && !(Array.isArray(fullEntry.truncated_fields) && fullEntry.truncated_fields.includes('content'))) {
          matched = isCompactionContent(fullEntry.content);
        }
      }
      if (matched) {
        compactions++;
        // 缺合法時間戳直接覆寫為 null，不沿用前一次時間或造假（P9）
        lastCompactionAt = parseValidIso(entry.created_at);
      }
      continue;
    }
    if (entry.source === 'MODEL' && entry.type === 'PLANNER_RESPONSE') {
      // 只算已 DONE 的回應步，避免新對話第一回合還在 RUNNING 時誤判為「舊版無 token 欄位」（P5 / R1）
      if (entry.status !== 'DONE') continue;
      plannerSteps++;
      const at = parseValidIso(entry.created_at);
      if (!at || !isNonNegFinite(entry.input_tokens) || !isNonNegFinite(entry.cache_read_tokens)) continue;
      const inputTokens = Math.round(entry.input_tokens);
      const cacheReadTokens = Math.round(entry.cache_read_tokens);
      const contextTokens = inputTokens + cacheReadTokens;
      if (contextTokens <= 0) continue;
      const outputTokens = isNonNegFinite(entry.output_tokens) ? Math.round(entry.output_tokens) : null;
      const model = typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : null;
      readableSteps++;
      latest = {
        step: hasStep ? entry.step_index : null,
        at,
        model,
        contextTokens,
        inputTokens,
        cacheReadTokens,
        outputTokens,
      };
      if (peakTokens === null || contextTokens > peakTokens) {
        peakTokens = contextTokens;
        peakAt = at;
      }
    }
  }
  const usage = { latest, peakTokens, peakAt, plannerSteps, readableSteps, compactions, lastCompactionAt };

  const firstTs = typeof first?.created_at === 'string' && Number.isFinite(Date.parse(first.created_at)) ? first.created_at : null;
  const birthTs = st.birthtimeMs > 0 ? new Date(st.birthtimeMs).toISOString() : null;
  const val = { ok: true, isSubagent, parentId, startedAt: firstTs ?? birthTs, prompts, usage };

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(transcriptPath, { sig, val });
  return val;
}

/**
 * 若紀錄裡尚未出現這個對話的 transcript 路徑（例如新對話第一回合還沒寫進 jsonl），
 * 依 Antigravity 標準路徑試找實際存在的完整或精簡轉錄檔；找不到就回 null（不猜，R1）。
 */
export function guessTranscriptPath(sessionId, home = homedir()) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{4,120}$/.test(sessionId)) return null;
  for (const dir of BRAIN_ROOTS) {
    for (const file of ['transcript_full.jsonl', 'transcript.jsonl']) {
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
 *   1. 有可讀 transcript 的人類對話 → 補入真實 USER_EXPLICIT / USER_INPUT（及已配對 DONE 的 ask_question 回覆）成為 hook:'UserPrompt' 事件（以 (session, step) 去重）。
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
  const askPostTs = new Map();

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
      if (e.hook === 'PostToolUse' && e.tool === 'ask_question' && typeof e.step === 'number'
          && typeof e.ts === 'string' && Number.isFinite(Date.parse(e.ts))) {
        askPostTs.set(`${e.session}\0${e.step}`, e.ts);
      }
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
        // 歸屬回主對話時拿掉 subagent 自己的 transcript，避免蓋過主對話轉錄檔（P6 / R1）
        const { transcript: _subTranscript, ...rest } = e;
        out.push({
          ...rest,
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

  // 從可讀 transcript 補入真實人類發言與 ask_question 點選回覆（每則配對該對話當下所在資料夾，不鎖死第一筆）
  for (const [sid, t] of parsed) {
    if (t.isSubagent) continue;
    for (const p of t.prompts) {
      let ts = p.ts;
      if (p.via === 'ask_question' && !ts) {
        // 缺 Completed At 時絕不拿 created_at 充數；僅對上同 (session, step) PostToolUse(ask_question) 時間戳才採納（R1 / P9）
        const postTs = p.step !== null ? askPostTs.get(`${sid}\0${p.step}`) : null;
        if (!postTs || !Number.isFinite(Date.parse(postTs))) continue;
        ts = postTs;
      }
      if (!ts || !Number.isFinite(Date.parse(ts))) continue;
      if (p.step !== null && seenStep.has(`${sid}\0${p.step}`)) continue;
      if (seenPromptTs.has(`${sid}\0${ts}\0${p.prompt}`)) continue;
      if (p.step !== null) seenStep.add(`${sid}\0${p.step}`);
      seenPromptTs.add(`${sid}\0${ts}\0${p.prompt}`);
      const pCwd = cwdAt(sid, ts);
      out.push({
        ts,
        hook: 'UserPrompt',
        session: sid,
        ...(pCwd ? { cwd: pCwd } : {}),
        ...(p.step !== null ? { step: p.step } : {}),
        prompt: p.prompt,
        ...(p.cut ? { prompt_cut: true } : {}),
        ...(p.via ? { via: p.via } : {}),
        ...(Array.isArray(p.askAnswers) && p.askAnswers.length ? { ask_answers: p.askAnswers } : {}),
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
 * 找出指定對話的轉錄檔路徑：優先 extraTranscripts（供測試隔離，P8）→ 紀錄中最新 e.transcript → 標準路徑猜測。
 * 與 enrichWithTranscripts 維持同一優先順序（P2），找不到時回 null（R1）。
 */
export function transcriptPathOf(sessionId, events = [], { extraTranscripts = null, home = homedir() } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  const extra = extraTranscripts instanceof Map ? extraTranscripts.get(sessionId) : extraTranscripts?.[sessionId];
  if (typeof extra === 'string' && extra.trim()) return extra;
  let recorded = null;
  for (const e of Array.isArray(events) ? events : []) {
    // 瀏覽器等 subagent 歸屬回主對話的事件不可覆蓋主對話自己的轉錄檔路徑，僅保留 subagent 自身事件（_subagent）供追回 parentId（P6 / R1）
    if (e?._fromSubagent) continue;
    if (e?.session === sessionId && typeof e.transcript === 'string' && e.transcript.trim()) recorded = e.transcript;
  }
  return recorded ?? guessTranscriptPath(sessionId, home);
}

/**
 * 這個對話真正開始的時間：讀 transcript step 0 的 created_at（或檔建立時間）。
 * 找不到或讀不到回 null（R1：不猜）。
 */
export function sessionStartOf(sessionId, events = [], { extraTranscripts = null, read = readTranscript, home = homedir() } = {}) {
  if (!sessionId) return null;
  const tp = transcriptPathOf(sessionId, events, { extraTranscripts, home });
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
