/**
 * contextScale.mjs —— 對話 Context Token 真實量表與本專案歷史比例尺（單一真相來源，P2）
 * 規格：context-token-scale（路徑看 AGENTS.md 的表）
 *
 * 三條紅線：
 *   R1 找不到／讀不到／無 token 欄位一律明講「問不到／看不到／讀不到」，絕不折成 0；區分 90 天內無結案與尚未建檔、拆清未掃描樣本數。
 *   R2 不畫綠燈、不打勾、不宣稱安全。
 *   R3 比例尺只用本專案自己的已結案對話（peakTokens，滿 5 個可讀樣本才算中位數與最大值）；嚴禁編造百分比、固定門檻或花費金額。
 *   P9 null／非法時間戳絕不直接傳入 ago()（會算出 1970 年假時間），一律顯示「時間未記錄」。
 */
import { homedir } from 'node:os';
import { ago } from './git.mjs';
import { RETAIN_DAYS } from './events.mjs';
import { readTranscript, transcriptPathOf } from './transcript.mjs';
import { sessionsOf } from './rounds.mjs';
import { tenureEvents, previousTenant } from './origin.mjs';
import { zhEn, plural } from './lang.mjs';

export const MIN_SCALE_SAMPLE = 5;
export const MAX_SCALE_SAMPLE = 30;

/** 精簡格式化 token 數（例如 14.7k、511.7k、1.05M）；不合法數回 null。 */
export function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const v = Math.round(n);
  if (v < 1000) return String(v);
  if (v < 999_950) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

/** 精確千分位格式（供細節拆解顯示）。 */
export function formatExactTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n).toLocaleString('en-US');
}

/** 安全時間差包裝：null／空字串／非法日期絕不傳入 ago()，避免算出 1970 年假時間（P9 / R1）。 */
export function safeAgo(iso, agoFn = ago) {
  if (typeof iso !== 'string' || !iso.trim() || !Number.isFinite(Date.parse(iso))) return null;
  return agoFn(iso);
}

/**
 * 計算單一專案過往已結案非 subagent 對話的 Context 歷史比例尺。
 * 採每個結案對話的最高用量 peakTokens（避免壓縮後收尾數字拉低基準），由新到舊掃描至滿 30 個可讀樣本即停。
 */
export function projectContextScale({
  events = [],
  sessions = null,
  evState = 'ok',
  retainDays = RETAIN_DAYS,
  extraTranscripts = null,
  read = readTranscript,
  home = homedir(),
} = {}) {
  const list = Array.isArray(sessions) ? sessions : sessionsOf(events);
  const closed = list
    .filter((s) => Boolean(s?.closedAt))
    .sort((a, b) => {
      const tb = Date.parse(b.closedAt) || Date.parse(b.lastTs) || 0;
      const ta = Date.parse(a.closedAt) || Date.parse(a.lastTs) || 0;
      return (tb - ta) || String(a.id).localeCompare(String(b.id));
    });

  const peaks = [];
  let iterated = 0;
  let scanned = 0;
  let missingCount = 0;
  let unreadableCount = 0;
  let noTokensCount = 0;
  let subagentSkipped = 0;

  for (const s of closed) {
    iterated++;
    const tp = transcriptPathOf(s.id, events, { extraTranscripts, home });
    if (!tp) {
      scanned++;
      missingCount++;
      continue;
    }
    const t = read(tp);
    if (!t?.ok) {
      scanned++;
      if (t?.reason === 'unreadable') unreadableCount++;
      else missingCount++;
      continue;
    }
    if (t.isSubagent) {
      subagentSkipped++;
      continue;
    }
    scanned++;
    const peak = t.usage?.peakTokens;
    if (typeof peak === 'number' && Number.isFinite(peak) && peak > 0) {
      peaks.push(peak);
      if (peaks.length >= MAX_SCALE_SAMPLE) break;
    } else {
      noTokensCount++;
    }
  }

  const totalClosed = closed.length;
  const effectiveClosed = totalClosed - subagentSkipped;
  const unscanned = Math.max(0, totalClosed - iterated);
  const unreadInScanned = missingCount + unreadableCount + noTokensCount;
  const sample = peaks.length;
  const ready = sample >= MIN_SCALE_SAMPLE;

  let median = null;
  let max = null;
  if (ready) {
    const sorted = [...peaks].sort((a, b) => a - b);
    median = sorted[Math.floor(sorted.length / 2)];
    max = sorted[sorted.length - 1];
  }

  const notes = [];
  if (unreadInScanned > 0) {
    notes.push(zhEn(
      `已掃描範圍另有 ${unreadInScanned} 個讀不到 token 紀錄`,
      `${unreadInScanned} more in the scanned range had no readable token record`,
    ));
  }
  if (unscanned > 0) {
    notes.push(zhEn(
      `另有 ${unscanned} 個更早的已結案對話未掃描`,
      `${unscanned} earlier closed ${unscanned === 1 ? 'conversation wasn\'t' : 'conversations weren\'t'} scanned`,
    ));
  }
  const noteText = notes.length ? notes.join(zhEn('；', '; ')) : null;

  let line;
  if (ready) {
    const tail = noteText ? zhEn(`（${noteText}）`, ` (${noteText})`) : '';
    line = zhEn(
      `參考：這個專案過往 ${sample} 個可讀已結案對話，最高用量通常到 ${formatTokens(median)} tokens，最多到過 ${formatTokens(max)} tokens${tail}`,
      `For reference: across ${plural(sample, 'readable closed conversation')} in this project, peak context usually reached ${formatTokens(median)} tokens, at most ${formatTokens(max)} tokens${tail}`,
    );
  } else if (effectiveClosed === 0) {
    line = evState === 'no-file'
      ? zhEn(
        `這個專案尚未建立對話紀錄檔，尚無歷史比例尺（累積滿 ${MIN_SCALE_SAMPLE} 個可讀已結案對話才給基準）`,
        `This project has no conversation log file yet, so there's no historical scale yet (needs at least ${MIN_SCALE_SAMPLE} readable closed conversations)`,
      )
      : zhEn(
        `這個專案 ${retainDays} 天內沒有已結案對話（紀錄只留 ${retainDays} 天），尚無歷史比例尺（滿 ${MIN_SCALE_SAMPLE} 個可讀已結案對話才給基準）`,
        `No closed conversations in this project in the last ${retainDays} days (records are kept for ${retainDays} days), so there's no historical scale yet (needs at least ${MIN_SCALE_SAMPLE} readable closed conversations)`,
      );
  } else {
    const tail = noteText ? zhEn(`；${noteText}`, `; ${noteText}`) : '';
    line = zhEn(
      `這個專案目前只有 ${sample} 個可讀的已結案對話（滿 ${MIN_SCALE_SAMPLE} 個才給歷史比例尺${tail}）`,
      `This project currently has only ${plural(sample, 'readable closed conversation')} (needs at least ${MIN_SCALE_SAMPLE} for a historical scale${tail})`,
    );
  }

  return {
    ready,
    sample,
    totalClosed,
    effectiveClosed,
    scanned,
    unscanned,
    unreadInScanned,
    missingCount,
    unreadableCount,
    noTokensCount,
    subagentSkipped,
    median,
    max,
    coverageNote: noteText,
    line,
  };
}

/** 共用誠實註記：明講只呈現實測數與專案歷史對照，不推算剩餘比例也不設固定警戒線。 */
function honestNoteText() {
  return zhEn(
    '這裡只呈現轉錄檔裡實際量到的 token 數與本專案過往結案對話的歷史對照，不推算剩餘空間比例，也不自設固定警戒線。',
    'Shows only token counts measured in the local transcript alongside this project\'s own closed-conversation history — no estimated remaining ratio and no invented danger threshold.',
  );
}

/**
 * 產生單一對話的 Context Token 真實量表檢視模型（供終端機與儀表板對話頁共用，一字不差，P2）。
 */
export function sessionContextView({
  sessionId = null,
  events = [],
  evState = 'ok',
  projectScale = null,
  agoFn = ago,
  extraTranscripts = null,
  read = readTranscript,
  home = homedir(),
  subjectNote = null,
} = {}) {
  const scaleLine = projectScale?.line ?? null;
  const honestNote = honestNoteText();
  const baseEmpty = (state, headline, summaryLine, extra = {}) => ({
    state,
    sessionId: extra.sessionId ?? sessionId ?? null,
    headline,
    metaLine: null,
    summaryLine,
    subjectNote: subjectNote ?? null,
    subagentNote: extra.subagentNote ?? null,
    compactionLine: extra.compactionLine ?? null,
    peakNote: null,
    scaleLine,
    breakdownLines: [],
    honestNote,
    contextTokens: null,
    inputTokens: null,
    cacheReadTokens: null,
    outputTokens: null,
    peakTokens: extra.peakTokens ?? null,
    peakAt: extra.peakAt ?? null,
    model: null,
    measuredAt: null,
    compactions: extra.compactions ?? 0,
    lastCompactionAt: extra.lastCompactionAt ?? null,
    fromSubagent: extra.fromSubagent ?? false,
  });

  if (!sessionId) {
    const summaryLine = evState === 'no-file'
      ? zhEn(
        '這個專案尚未建立對話紀錄檔（且獨立終端機未帶對話代號），看不到目前是否有進行中的對話或 context 用量。',
        'This project has no conversation log file yet (and no conversation ID in this standalone terminal), so whether a conversation is active or its context usage can\'t be seen.',
      )
      : zhEn(
        '紀錄裡這個工作區目前沒有進行中的對話（獨立終端機未帶對話代號），問不到目前的 context 用量。',
        'No active conversation for this workspace was found in the records (no conversation ID in this standalone terminal), so current context usage couldn\'t be checked.',
      );
    return baseEmpty(
      'no-session',
      zhEn('問不到', 'Couldn\'t check'),
      summaryLine,
    );
  }

  let targetId = sessionId;
  let tp = transcriptPathOf(targetId, events, { extraTranscripts, home });
  let t = tp ? read(tp) : { ok: false, reason: 'missing' };
  let fromSubagent = false;
  let subagentNote = null;

  // 若環境在 subagent 對話內，追回對應主對話（最多 5 層防循環，P6 / R1）
  if (t?.ok && t.isSubagent) {
    fromSubagent = true;
    const seen = new Set([targetId]);
    let cur = t;
    let resolvedId = null;
    for (let i = 0; i < 5 && cur?.ok && cur.isSubagent; i++) {
      const pid = typeof cur.parentId === 'string' && cur.parentId.trim() ? cur.parentId.trim() : null;
      if (!pid || seen.has(pid)) { cur = null; resolvedId = null; break; }
      seen.add(pid);
      resolvedId = pid;
      tp = transcriptPathOf(pid, events, { extraTranscripts, home });
      cur = tp ? read(tp) : { ok: false, reason: 'missing' };
    }
    if (!resolvedId || (cur?.ok && cur.isSubagent)) {
      return baseEmpty(
        'subagent-no-parent',
        zhEn('問不到', 'Couldn\'t check'),
        zhEn('目前位於 subagent 對話，找不到對應主對話的轉錄檔，看不到主對話的 context 用量。', 'Currently inside a subagent conversation; couldn\'t find the parent conversation\'s transcript, so its context usage can\'t be seen.'),
        { sessionId: null, fromSubagent: true, subagentNote: zhEn('目前位於 subagent 對話。', 'Currently inside a subagent conversation.') },
      );
    }
    targetId = resolvedId;
    t = cur;
    subagentNote = zhEn(
      '目前位於 subagent 對話，以下顯示對應主對話的記憶用量。',
      'Currently inside a subagent conversation; showing the parent conversation\'s context usage below.',
    );
  }

  if (!tp || (!t?.ok && t?.reason !== 'unreadable')) {
    return baseEmpty(
      'no-file',
      zhEn('問不到', 'Couldn\'t check'),
      zhEn('找不到這個對話的轉錄檔，問不到目前的 context 用量。', 'Couldn\'t find this conversation\'s transcript file, so current context usage couldn\'t be checked.'),
      { sessionId: targetId, fromSubagent, subagentNote },
    );
  }

  if (!t?.ok && t?.reason === 'unreadable') {
    return baseEmpty(
      'unreadable',
      zhEn('讀不到', 'Can\'t read it'),
      zhEn('沒有權限或無法讀取這個對話的轉錄檔，看不到目前的 context 用量。', 'Couldn\'t read this conversation\'s transcript file (permission or I/O failure), so current context usage can\'t be seen.'),
      { sessionId: targetId, fromSubagent, subagentNote },
    );
  }

  const u = t.usage ?? {};
  const compactions = u.compactions ?? 0;
  const lastCompactionAt = u.lastCompactionAt ?? null;
  const compactionWhen = safeAgo(lastCompactionAt, agoFn) ?? zhEn('時間未記錄', 'time not recorded');
  const compactionLine = compactions > 0
    ? zhEn(
      `⚠️ 這個對話已壓縮 ${compactions} 次（最近一次：${compactionWhen}）——更早的對話細節可能已被摘要省略。`,
      `⚠️ This conversation has compacted ${plural(compactions, 'time')} (latest: ${compactionWhen}) — earlier details might have been summarized away.`,
    )
    : null;

  if (!u.latest) {
    const summaryLine = (u.plannerSteps ?? 0) > 0
      ? zhEn('這個對話的轉錄檔沒有記錄 token 用量欄位（可能是舊版轉錄格式），看不到目前的 context 用量。', 'This conversation\'s transcript doesn\'t include token usage fields (possibly an older format), so current context usage can\'t be seen.')
      : zhEn('這個對話尚未有已完成的模型回應紀錄，還看不到 context 用量。', 'This conversation has no completed model response with token usage yet, so context usage can\'t be seen yet.');
    return baseEmpty(
      'no-tokens',
      zhEn('看不到', 'Can\'t see'),
      summaryLine,
      { sessionId: targetId, fromSubagent, subagentNote, compactionLine, compactions, lastCompactionAt },
    );
  }

  const l = u.latest;
  const tokStr = formatTokens(l.contextTokens);
  const exactStr = formatExactTokens(l.contextTokens);
  const when = safeAgo(l.at, agoFn) ?? zhEn('時間未記錄', 'time not recorded');
  const modelLabel = l.model ?? zhEn('未記錄模型', 'model not recorded');
  const peakWhen = safeAgo(u.peakAt, agoFn) ?? zhEn('時間未記錄', 'time not recorded');
  const peakNote = u.peakTokens && (u.peakTokens > l.contextTokens || compactions > 0)
    ? zhEn(
      `本對話最高曾達 ${formatTokens(u.peakTokens)} tokens（${peakWhen}）`,
      `Peak in this conversation: ${formatTokens(u.peakTokens)} tokens (${peakWhen})`,
    )
    : null;

  const breakdownLines = [
    zhEn(
      `輸入拆解：新輸入 ${formatExactTokens(l.inputTokens)} + 快取讀取 ${formatExactTokens(l.cacheReadTokens)} = ${exactStr} tokens`,
      `Input breakdown: uncached ${formatExactTokens(l.inputTokens)} + cache read ${formatExactTokens(l.cacheReadTokens)} = ${exactStr} tokens`,
    ),
    l.outputTokens !== null
      ? zhEn(`該步輸出：${formatExactTokens(l.outputTokens)} tokens`, `Step output: ${formatExactTokens(l.outputTokens)} tokens`)
      : zhEn('該步輸出：未記錄', 'Step output: not recorded'),
    peakNote ?? zhEn(
      `本對話最高：${formatTokens(u.peakTokens)} tokens（${peakWhen}）`,
      `Conversation peak: ${formatTokens(u.peakTokens)} tokens (${peakWhen})`,
    ),
  ];

  return {
    state: 'ok',
    sessionId: targetId,
    headline: `${tokStr} tokens`,
    metaLine: zhEn(`${modelLabel} · ${when}量得`, `${modelLabel} · measured ${when}`),
    summaryLine: zhEn(
      `目前記憶用量：${tokStr} tokens（${exactStr} · ${modelLabel} · ${when}量得）`,
      `Current context: ${tokStr} tokens (${exactStr} · ${modelLabel} · measured ${when})`,
    ),
    subjectNote: subjectNote ?? null,
    subagentNote,
    compactionLine,
    peakNote,
    scaleLine,
    breakdownLines,
    honestNote,
    contextTokens: l.contextTokens,
    inputTokens: l.inputTokens,
    cacheReadTokens: l.cacheReadTokens,
    outputTokens: l.outputTokens,
    peakTokens: u.peakTokens ?? l.contextTokens,
    peakAt: u.peakAt ?? l.at,
    model: l.model,
    measuredAt: l.at,
    compactions,
    lastCompactionAt,
    fromSubagent,
  };
}

/**
 * 終端機 `agy-pipeline` 專用解析入口：
 *   - 比例尺一律吃未經 tenureEvents 裁切的全專案 events（與儀表板一致，P2）。
 *   - 具 ANTIGRAVITY_CONVERSATION_ID 時直接讀該對話（subagent 會追回 parentId，P6）。
 *   - 獨立終端機無代號時只看本工作區這一手（s.cwd === ctx.root 且非 previousTenant）進行中的對話（P6）。
 */
export function resolveCliContext({
  ctx,
  events = [],
  evState = 'ok',
  takeover = null,
  sessionId = null,
  retainDays = RETAIN_DAYS,
  agoFn = ago,
  extraTranscripts = null,
  read = readTranscript,
  home = homedir(),
} = {}) {
  const projectScale = projectContextScale({ events, evState, retainDays, extraTranscripts, read, home });
  if (sessionId) {
    return sessionContextView({ sessionId, events, projectScale, agoFn, extraTranscripts, read, home });
  }
  const tenEvents = ctx?.root ? tenureEvents(events, ctx.root, takeover) : events;
  const active = sessionsOf(tenEvents).filter((s) => (
    s.cwd === ctx?.root
    && !s.closedAt
    && !(takeover?.state === 'ok' && previousTenant(events, ctx.root, takeover, s.id))
  ));
  if (!active.length) {
    return sessionContextView({ sessionId: null, events, evState, projectScale, agoFn, extraTranscripts, read, home });
  }
  let subjectNote = null;
  if (active.length > 1) {
    const title = active[0].title;
    const shortId = active[0].id.slice(0, 8);
    subjectNote = zhEn(
      `這個工作區有 ${active.length} 個進行中的對話，以下為最近有動作的 ${title ? `「${title}」` : shortId}（其他請看儀表板各對話頁）`,
      `This workspace has ${active.length} conversations in progress; showing the most recently active one ${title ? `"${title}"` : shortId} (see each conversation's page on the dashboard for the others)`,
    );
  }
  return sessionContextView({ sessionId: active[0].id, events, projectScale, agoFn, extraTranscripts, read, home, subjectNote });
}
