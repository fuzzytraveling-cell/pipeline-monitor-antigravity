/**
 * contextScale.test.mjs —— 對話 Context Token 真實量表與本專案歷史比例尺測試
 * 規格：context-token-scale（路徑看 AGENTS.md 的表）
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';   // 排第一個：換上假家目錄（P8）
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { clearTranscriptCache, readTranscript, transcriptPathOf, enrichWithTranscripts } from '../lib/transcript.mjs';
import {
  MIN_SCALE_SAMPLE, MAX_SCALE_SAMPLE, formatTokens, formatExactTokens, safeAgo,
  projectContextScale, sessionContextView, resolveCliContext,
} from '../lib/contextScale.mjs';
import { collectAll } from '../lib/collect.mjs';
import { withClock, ago } from '../lib/git.mjs';
import { withLang } from '../lib/lang.mjs';
import { safeName, logFileOf } from '../lib/events.mjs';
import { CJK } from './_zhscan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATUS = join(ROOT, 'status.mjs');
const NOW = Date.now();
const T = (sec) => new Date(NOW + sec * 1000).toISOString();
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

function runCli(cwd, { dataHome, fakeHome, env = {} }) {
  return execFileSync(process.execPath, [STATUS], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGY_PIPELINE_HOME: dataHome,
      HOME: fakeHome,
      ANTIGRAVITY_CONVERSATION_ID: '',
      ...env,
    },
  });
}

function uiSessionHarness(latest, { lang = 'zh' } = {}) {
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const body = src
    .replace(/^import .*$/m, '')
    .replace(/^pollLoop\(\);$/m, '')
    .replace(/^setInterval\(paintFreshness, 1000\);$/m, '');
  const noop = () => {};
  const els = {};
  const el = (id) => (els[id] ??= {
    dataset: {}, classList: { toggle: noop }, innerHTML: '', textContent: '', style: { setProperty: noop },
    querySelectorAll: () => [], attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); },
  });
  const document = {
    getElementById: el, addEventListener: noop, body: el('body'), activeElement: null,
    documentElement: { dataset: { lang, theme: 'night' } },
  };
  const make = new Function(
    'describeFreshness', 'STALE_AFTER_SECONDS', 'document', 'window', 'localStorage', 'sessionStorage', 'location',
    'setTimeout', 'setInterval', 'fetch', 'performance', 'console', '__LATEST',
    `${body}\nlatest = __LATEST;\nreturn { contextScaleCard, sessionPage, oldServerBanner, OLD_LINE };`,
  );
  return make(
    () => ({ label: '', state: 'fresh', dim: false }), 60, document, { addEventListener: noop },
    { getItem: () => null, setItem: noop }, { getItem: () => null, setItem: noop, removeItem: noop },
    { hash: '', reloads: 0, reload: noop }, noop, noop,
    () => Promise.reject(new Error('測試不連網路')), { now: () => 0 }, { ...console, error: noop }, latest,
  );
}

/* ════════════ 1. AC-1：跨模型加總、亂序 step_index、混合舊新步驟 ════════════ */

section('AC-1：跨模型 input_tokens + cache_read_tokens 加總、亂序 step_index 與混合舊新步驟', 'P6');
{
  const dir = mkdtempSync(join(tmpdir(), 'pm-ctx-tr-'));
  clearTranscriptCache();
  try {
    const pGemini = join(dir, 'gemini.jsonl');
    // 故意亂序寫入 step_index（step 20 寫在 step 33 前或後、且含無欄位舊步驟 + 進行中步驟）
    writeFileSync(pGemini, jsonl([
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: T(-600), content: '<USER_REQUEST>hello</USER_REQUEST>' },
      { step_index: 33, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-120), model: 'gemini-4-neon-xhigh', input_tokens: 3861, cache_read_tokens: 98849, output_tokens: 136 },
      { step_index: 12, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-400), model: 'gemini-4-neon-xhigh', input_tokens: 20000, cache_read_tokens: 0, output_tokens: 220 },
      { step_index: 20, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-300), model: 'gemini-4-neon-xhigh', input_tokens: 40000, cache_read_tokens: 110000, output_tokens: 410 },
      { step_index: 40, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'RUNNING', created_at: T(-30), model: 'gemini-4-neon-xhigh', input_tokens: 1, cache_read_tokens: 1 },
    ]));
    const tg = readTranscript(pGemini);
    eq('Gemini 讀取成功', tg.ok, true);
    eq('取最後一個已 DONE 合法 step（step 33，不因寫檔順序被 step 20 蓋過，不採 RUNNING）', tg.usage.latest?.step, 33);
    eq('真實用量等於 input_tokens + cache_read_tokens', tg.usage.latest?.contextTokens, 3861 + 98849);
    eq('output_tokens 分開記錄不混入 contextTokens', tg.usage.latest?.outputTokens, 136);
    eq('記錄曾經到達的最高值 peakTokens（step 20 的 150k）', tg.usage.peakTokens, 150000);
    eq('記錄最高值時刻 peakAt', tg.usage.peakAt, T(-300));

    const pClaude = join(dir, 'claude.jsonl');
    writeFileSync(pClaude, jsonl([
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-500) },   // 混合舊格式無 token 欄
      { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-90), model: 'claude-opus-5-5-high', input_tokens: 9111, cache_read_tokens: 31985, output_tokens: 376 },
    ]));
    const tc = readTranscript(pClaude);
    eq('Claude 混合舊新格式仍讀出最新合法步', tc.usage.latest?.contextTokens, 9111 + 31985);
    eq('保留完整模型名', tc.usage.latest?.model, 'claude-opus-5-5-high');
    eq('計算總 plannerSteps 與 readableSteps', `${tc.usage.plannerSteps}/${tc.usage.readableSteps}`, '2/1');

    const pUnstepped = join(dir, 'unstepped.jsonl');
    writeFileSync(pUnstepped, jsonl([
      { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-60), model: 'gemini-4-hydrogen-high', input_tokens: 12000, cache_read_tokens: 48000, output_tokens: 90 },
    ]));
    const tu = readTranscript(pUnstepped);
    eq('無 step_index 合成資料同樣可讀', tu.usage.latest?.contextTokens, 60000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ════════════ 2. AC-1 / 預審 #7 & #4：壓縮偵測、截斷補讀、不混算 token、null 時間戳 ════════════ */

section('AC-1 & 預審 #7/#4：現代與舊版 CHECKPOINT 壓縮偵測、truncated_fields 補讀、null 時間戳不印 1970 假時間', 'P9');
{
  const dir = mkdtempSync(join(tmpdir(), 'pm-ctx-cp-'));
  clearTranscriptCache();
  try {
    const compact = join(dir, 'transcript.jsonl');
    const full = join(dir, 'transcript_full.jsonl');
    writeFileSync(compact, jsonl([
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-900), model: 'gemini-4-neon-xhigh', input_tokens: 510000, cache_read_tokens: 0, output_tokens: 500 },
      // 舊版 CHECKPOINT 且 content 在精簡版被截斷，須懶載入 transcript_full.jsonl 才判得出
      { step_index: 2, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: T(-700), input_tokens: 999999, cache_read_tokens: 0, content: '{{ CHECKPOINT 1 }}', truncated_fields: ['content'] },
      // 現代版壓縮標記但故意缺 created_at：lastCompactionAt 必須覆寫成 null，絕不沿用前一次或傳入 ago(null)
      { step_index: 3, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', content: '# Resuming from a compaction\n\nSummary...' },
      { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-180), model: 'gemini-4-neon-xhigh', input_tokens: 24000, cache_read_tokens: 0, output_tokens: 180 },
    ]));
    writeFileSync(full, jsonl([
      { step_index: 2, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: T(-700), content: '{{ CHECKPOINT 1 }}\n**The earlier parts of this conversation have been truncated due to its long length.**' },
    ]));
    const t = readTranscript(compact);
    eq('現代 + 舊版截斷補讀共計 2 次壓縮', t.usage.compactions, 2);
    eq('CHECKPOINT 自帶的 999999 token 絕不混入 PLANNER_RESPONSE 最高值', t.usage.peakTokens, 510000);
    eq('最近一次壓縮缺 created_at 時覆寫為 null（不沿用前次時間）', t.usage.lastCompactionAt, null);

    const view = withClock(() => sessionContextView({ sessionId: 's1', extraTranscripts: { s1: compact } }));
    check('compactionLine 明標壓縮 2 次與「時間未記錄」，絕不出現 1970 或上萬天前',
      view.compactionLine?.includes('已壓縮 2 次') && view.compactionLine?.includes('時間未記錄') && !/1970|\d{4,}\s*天前/.test(view.compactionLine), view.compactionLine);
    eq('safeAgo(null) 回傳 null（絕不交給 ago(null)）', safeAgo(null, ago), null);
    eq('safeAgo("bad") 回傳 null', safeAgo('not-a-date', ago), null);
    check('壓縮後數字變小時併顯 peakNote', view.peakNote?.includes('510k tokens'), view.peakNote);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ════════════ 3. AC-1 / 預審 #5 & #3：missing vs unreadable、缺欄不折 0、extraTranscripts 優先序 ════════════ */

section('AC-1 & 預審 #5/#3：missing vs unreadable、缺欄不折成 0、extraTranscripts 優先於 e.transcript', 'P2');
{
  const dir = mkdtempSync(join(tmpdir(), 'pm-ctx-err-'));
  clearTranscriptCache();
  const locked = join(dir, 'locked.jsonl');
  try {
    const missingRes = readTranscript(join(dir, 'does-not-exist.jsonl'));
    eq('不存在的檔案回 reason: missing', missingRes.ok === false && missingRes.reason, 'missing');

    const emptyView = sessionContextView({ sessionId: 's-missing', extraTranscripts: { 's-missing': join(dir, 'does-not-exist.jsonl') } });
    eq('missing 對應 state: no-file', emptyView.state, 'no-file');
    check('missing 不折成 0 tokens', !/\b0\s*tokens/i.test(`${emptyView.headline} ${emptyView.summaryLine}`), emptyView.summaryLine);

    writeFileSync(locked, jsonl([{ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-60), input_tokens: 100, cache_read_tokens: 0 }]));
    chmodSync(locked, 0o000);
    // 若以 root 執行 chmod 000 仍可讀時退回模擬 read
    let unreadableRes = readTranscript(locked);
    if (unreadableRes.ok) unreadableRes = { ok: false, reason: 'unreadable' };
    eq('無讀取權限的檔案回 reason: unreadable', unreadableRes.ok === false && unreadableRes.reason, 'unreadable');
    const unreadableView = sessionContextView({ sessionId: 's-lock', extraTranscripts: { 's-lock': 'fake-locked' }, read: () => ({ ok: false, reason: 'unreadable' }) });
    eq('unreadable 對應 state: unreadable', unreadableView.state, 'unreadable');
    check('unreadable 講沒有權限或無法讀取，不講找不到檔', /沒有權限|無法讀取/.test(unreadableView.summaryLine) && !/找不到/.test(unreadableView.summaryLine), unreadableView.summaryLine);

    const noCache = join(dir, 'nocache.jsonl');
    writeFileSync(noCache, jsonl([
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-120), model: 'gemini-4-neon-high', input_tokens: 12000 },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-60), input_tokens: 0, cache_read_tokens: 0 },
    ]));
    const noTokView = sessionContextView({ sessionId: 's-nocache', extraTranscripts: { 's-nocache': noCache } });
    eq('缺 cache_read_tokens 或加總為 0 回 state: no-tokens（絕不折成 0）', noTokView.state, 'no-tokens');
    check('no-tokens 不含 0 tokens', !/\b0\s*tokens/i.test(`${noTokView.headline} ${noTokView.summaryLine}`), noTokView.summaryLine);

    const runningOnly = join(dir, 'running-only.jsonl');
    writeFileSync(runningOnly, jsonl([
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'RUNNING', created_at: T(-10), model: 'gemini-4-neon-xhigh' },
    ]));
    const runningTr = readTranscript(runningOnly);
    eq('只有 RUNNING 步驟時 plannerSteps 為 0 且 latest 為 null', runningTr.ok && runningTr.usage.plannerSteps === 0 && runningTr.usage.latest === null, true);
    const runningView = sessionContextView({ sessionId: 's-running', extraTranscripts: { 's-running': runningOnly } });
    eq('只有 RUNNING 步驟回 state: no-tokens', runningView.state, 'no-tokens');
    check('只有 RUNNING 步驟講「尚未有已完成的模型回應紀錄」不誤判為舊版缺欄位（P5 / R1）',
      runningView.summaryLine.includes('尚未有已完成的模型回應紀錄') && !/舊版|沒有記錄 token 用量欄位/.test(runningView.summaryLine),
      runningView.summaryLine);

    const noModel = join(dir, 'nomodel.jsonl');
    writeFileSync(noModel, jsonl([
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-60), input_tokens: 5500, cache_read_tokens: 500 },
    ]));
    const noModelView = withClock(() => sessionContextView({ sessionId: 's-nomodel', extraTranscripts: { 's-nomodel': noModel } }));
    eq('缺 model 時明標未記錄模型、不印 null/undefined', noModelView.metaLine?.includes('未記錄模型') && !/null|undefined/i.test(noModelView.metaLine), true);

    const picked = transcriptPathOf('s-prio', [{ session: 's-prio', transcript: '/real/host/machine/transcript.jsonl' }], { extraTranscripts: { 's-prio': noModel } });
    eq('transcriptPathOf 維持 extraTranscripts 優先於 e.transcript（P8）', picked, noModel);

    // E 第 1 趟實機回歸：browser subagent 的 webview_browser 歸屬回主對話時，絕不可用 subagent 的 e.transcript 蓋掉主對話轉錄檔（P6 / R1）
    const mainWv = join(dir, 'main-wv.jsonl');
    const subWv = join(dir, 'sub-wv.jsonl');
    writeFileSync(mainWv, jsonl([
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: T(-300), content: '<USER_REQUEST>check browser</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-120), model: 'gemini-4-neon-xhigh', input_tokens: 40000, cache_read_tokens: 160000, output_tokens: 200 },
    ]));
    writeFileSync(subWv, jsonl([
      { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: T(-60), content: 'sender=main-wv' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-30), model: 'gemini-flash-worker-agy', input_tokens: 5000, cache_read_tokens: 0, output_tokens: 50 },
    ]));
    const wvEnriched = enrichWithTranscripts([
      { ts: T(-120), hook: 'PostToolUse', tool: 'read_file', session: 'main-wv', cwd: dir, transcript: mainWv },
      { ts: T(-30), hook: 'PostToolUse', tool: 'webview_browser', session: 'sub-wv', cwd: dir, transcript: subWv },
    ], { home: dir });
    const wvAttr = wvEnriched.find((e) => e.session === 'main-wv' && e._fromSubagent === 'sub-wv');
    eq('歸屬回主對話的 _fromSubagent 瀏覽器事件不再夾帶 subagent transcript', Boolean(wvAttr) && wvAttr.transcript === undefined, true);
    eq('transcriptPathOf(main-wv) 不被較新的瀏覽器歸屬事件蓋成 subagent 路徑', transcriptPathOf('main-wv', wvEnriched, { home: dir }), mainWv);
    const wvMainView = withClock(() => sessionContextView({ sessionId: 'main-wv', events: wvEnriched, home: dir }));
    eq('主對話即使最後動作來自瀏覽器 subagent 仍正確顯示 200k tokens（不落入 subagent-no-parent）',
      wvMainView.state === 'ok' && wvMainView.fromSubagent === false && wvMainView.contextTokens === 200000, true);
    eq('transcriptPathOf(sub-wv) 仍保留 subagent 自身路徑（不誤擋 _subagent）', transcriptPathOf('sub-wv', wvEnriched, { home: dir }), subWv);
    const wvSubView = withClock(() => sessionContextView({ sessionId: 'sub-wv', events: wvEnriched, home: dir }));
    eq('從 subagent 內查詢仍可正確追回主對話 200k tokens',
      wvSubView.state === 'ok' && wvSubView.fromSubagent === true && wvSubView.contextTokens === 200000, true);
  } finally {
    try { chmodSync(locked, 0o644); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ════════════ 4. AC-2 / 預審 #1 & #2：歷史比例尺邊界（0 / 不足 5 / >= 5 / > 30 / 重開 / subagent） ════════════ */

section('AC-2 & 預審 #1/#2：專案歷史比例尺（no-file vs 90天無結案、未滿5、滿5採 peakTokens、超過30拆清未掃描、排除重開與 subagent）', 'P5');
{
  const makeSessionEvents = (ids, { closed = true } = {}) => ids.flatMap((id, idx) => ([
    { ts: T(-10000 + idx * 100), hook: 'UserPrompt', session: id, cwd: '/w', prompt: `msg ${id}` },
    ...(closed ? [{ ts: T(-5000 + idx * 100), event: 'session_closed', session: id, cwd: '/w', source: 'human' }] : []),
  ]));
  const fakeReadOf = (peaks, { subagents = new Set(), missing = new Set(), unreadable = new Set() } = {}) => (tp) => {
    const id = tp.replace(/^tp:/, '');
    if (missing.has(id)) return { ok: false, reason: 'missing' };
    if (unreadable.has(id)) return { ok: false, reason: 'unreadable' };
    if (subagents.has(id)) return { ok: true, isSubagent: true, parentId: 'main-0', usage: { peakTokens: 999999 } };
    const pk = peaks.get(id);
    if (!pk) return { ok: true, isSubagent: false, usage: { latest: null, peakTokens: null, plannerSteps: 1, readableSteps: 0, compactions: 0 } };
    return {
      ok: true,
      isSubagent: false,
      usage: {
        latest: { step: 5, at: T(-60), model: 'gemini-4-neon-xhigh', contextTokens: Math.min(pk, 50000), inputTokens: 10000, cacheReadTokens: 40000, outputTokens: 100 },
        peakTokens: pk,
        peakAt: T(-120),
        plannerSteps: 5,
        readableSteps: 5,
        compactions: pk > 100000 ? 1 : 0,
        lastCompactionAt: pk > 100000 ? T(-90) : null,
      },
    };
  };
  const extraOf = (ids) => Object.fromEntries(ids.map((id) => [id, `tp:${id}`]));

  const noFileScale = projectContextScale({ events: [], evState: 'no-file', retainDays: 90 });
  eq('no-file 狀態未就緒', noFileScale.ready, false);
  check('no-file 明講尚未建立對話紀錄檔', noFileScale.line.includes('尚未建立對話紀錄檔'), noFileScale.line);

  const clearedScale = projectContextScale({ events: [], evState: 'ok', retainDays: 90 });
  check('90 天清空後明講 90 天內沒有已結案對話（紀錄只留 90 天）', clearedScale.line.includes('90 天內沒有已結案對話') && clearedScale.line.includes('紀錄只留 90 天'), clearedScale.line);

  // 4 個可讀樣本（不足 5 個，不得給中位數與最大值）
  const fourIds = ['c1', 'c2', 'c3', 'c4'];
  const fourPeaks = new Map(fourIds.map((id, i) => [id, (i + 1) * 100000]));
  const fourScale = projectContextScale({ events: makeSessionEvents(fourIds), extraTranscripts: extraOf(fourIds), read: fakeReadOf(fourPeaks) });
  eq('4 個樣本 ready 为 false', fourScale.ready, false);
  eq('4 個樣本 median 與 max 皆為 null', fourScale.median === null && fourScale.max === null, true);
  check('4 個樣本明確說只有 4 個、滿 5 個才給', fourScale.line.includes('只有 4 個') && fourScale.line.includes('滿 5 個'), fourScale.line);

  // 5 個可讀 + 1 個結案後又活動（算回進行中不納入）+ 1 個 subagent（排除）+ 1 個讀不到
  const mixIds = ['m1', 'm2', 'm3', 'm4', 'm5', 'reopened', 'sub1', 'miss1'];
  const mixEvents = [
    ...makeSessionEvents(mixIds),
    { ts: T(-100), hook: 'PostToolUse', tool: 'Read', session: 'reopened', cwd: '/w' },   // 結案後又有動作
  ];
  const mixPeaks = new Map([['m1', 100000], ['m2', 200000], ['m3', 300000], ['m4', 400000], ['m5', 520000], ['reopened', 950000]]);
  const mixScale = projectContextScale({
    events: mixEvents,
    extraTranscripts: extraOf(mixIds),
    read: fakeReadOf(mixPeaks, { subagents: new Set(['sub1']), missing: new Set(['miss1']) }),
  });
  eq('5 個可讀樣本即 ready', mixScale.ready, true);
  eq('排除重開對話與 subagent 後樣本數為 5', mixScale.sample, 5);
  eq('中位數依 peakTokens 計算為 300k（非壓縮後 50k）', mixScale.median, 300000);
  eq('最大值為 520k（未納入重開對話的 950k 或 subagent 的 999k）', mixScale.max, 520000);
  eq('已掃描範圍讀不到為 1（miss1）', mixScale.unreadInScanned, 1);
  check('文案帶出已掃描範圍另有 1 個讀不到', mixScale.line.includes('已掃描範圍另有 1 個讀不到'), mixScale.line);

  // 33 個已結案對話（前 30 個皆可讀）：停在 30，並將剩下 3 個標為未掃描（預審 #2）
  const manyIds = Array.from({ length: 33 }, (_, i) => `s-${String(i).padStart(2, '0')}`);
  const manyPeaks = new Map(manyIds.map((id, i) => [id, 100000 + i * 1000]));
  const manyScale = projectContextScale({ events: makeSessionEvents(manyIds), extraTranscripts: extraOf(manyIds), read: fakeReadOf(manyPeaks) });
  eq('樣本上限為 30', manyScale.sample, MAX_SCALE_SAMPLE);
  eq('unscanned 精確為 3', manyScale.unscanned, 3);
  eq('unreadInScanned 為 0（未掃描的 3 個不誣指為讀不到）', manyScale.unreadInScanned, 0);
  check('文案明標「另有 3 個更早的已結案對話未掃描」', manyScale.line.includes('另有 3 個更早的已結案對話未掃描'), manyScale.line);
}

/* ════════════ 5. AC-3 / 預審 #6 & #8：CLI 實跑多情境、!hasCommits 子目錄、subagent 追回、換手全專案 ════════════ */

section('AC-3 & 預審 #6/#8：CLI 實跑四種會話識別、subagent 追回 parentId、!ctx.hasCommits 子目錄與換手比例尺一致', 'P6');
{
  const dataHome = mkdtempSync(join(tmpdir(), 'pm-ctx-data-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'pm-ctx-home-'));
  const repo = makeRepo({ files: { 'a.js': 'const a = 1;\n' } });
  const wtB = mkdtempSync(join(tmpdir(), 'pm-ctx-wtb-'));
  rmSync(wtB, { recursive: true, force: true });
  const wtC = mkdtempSync(join(tmpdir(), 'pm-ctx-wtc-'));
  rmSync(wtC, { recursive: true, force: true });
  const noCommitDir = mkdtempSync(join(tmpdir(), 'pm-ctx-nocommit-'));
  clearTranscriptCache();

  try {
    repo.git('worktree', 'add', '-b', 'feat-b', wtB);
    repo.git('worktree', 'add', '-b', 'feat-c', wtC);
    const rootA = realpathSync(repo.dir);
    const rootB = realpathSync(wtB);
    const rootC = realpathSync(wtC);

    const writeBrainTr = (sid, rows) => {
      const p = join(fakeHome, '.gemini', 'antigravity', 'brain', sid, '.system_generated', 'logs', 'transcript.jsonl');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, jsonl(rows));
      return p;
    };

    // 主對話 s-a1 與 subagent s-sub（尚未寫 hook event 的首回合情境也一起測）
    writeBrainTr('sess-main-a1', [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: T(-300), content: '<USER_REQUEST>main</USER_REQUEST>' },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-60), model: 'gemini-4-neon-xhigh', input_tokens: 45000, cache_read_tokens: 155000, output_tokens: 300 },
    ]);
    writeBrainTr('sess-sub-1', [
      { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: T(-100), content: 'sender=sess-main-a1' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-50), model: 'gemini-flash-worker-agy', input_tokens: 5000, cache_read_tokens: 0, output_tokens: 50 },
    ]);
    writeBrainTr('sess-a2', [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: T(-200), content: '<USER_REQUEST>second</USER_REQUEST>' },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-30), model: 'claude-opus-5-5-high', input_tokens: 10000, cache_read_tokens: 80000, output_tokens: 120 },
    ]);
    writeBrainTr('sess-b1', [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: T(-180), content: '<USER_REQUEST>wt-b</USER_REQUEST>' },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-40), model: 'gemini-4-hydrogen-xhigh', input_tokens: 320000, cache_read_tokens: 0, output_tokens: 200 },
    ]);

    // 5 個已結案歷史對話（含 1 個落在同一 worktree 的早期結案，用來驗證換手後比例尺仍吃全專案）
    const closedIds = ['old-1', 'old-2', 'old-3', 'old-4', 'old-5'];
    for (let i = 0; i < closedIds.length; i++) {
      writeBrainTr(closedIds[i], [
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-5000 + i * 100), model: 'gemini-4-neon-xhigh', input_tokens: 100000 + i * 50000, cache_read_tokens: 0, output_tokens: 100 },
      ]);
    }

    const logDir = join(dataHome, 'logs');
    mkdirSync(logDir, { recursive: true });
    const projName = safeName(rootA.split('/').pop());
    const logFile = logFileOf(logDir, projName);
    writeFileSync(logFile, jsonl([
      ...closedIds.flatMap((id, i) => [
        { ts: T(-6000 + i * 100), hook: 'UserPrompt', session: id, cwd: rootA, prompt: id },
        { ts: T(-5500 + i * 100), event: 'session_closed', session: id, cwd: rootA, source: 'human' },
      ]),
      // rootA 共用兩個進行中對話：sess-main-a1 與較新的 sess-a2
      { ts: T(-300), hook: 'UserPrompt', session: 'sess-main-a1', cwd: rootA, prompt: '主對話一', title: '主對話一' },
      { ts: T(-200), hook: 'UserPrompt', session: 'sess-a2', cwd: rootA, prompt: '主對話二', title: '主對話二' },
      // rootB 有一個進行中對話 sess-b1；rootC 沒有進行中對話
      { ts: T(-180), hook: 'UserPrompt', session: 'sess-b1', cwd: rootB, prompt: 'B 工作區', title: 'B 工作區' },
    ]));

    // 1. 帶 ANTIGRAVITY_CONVERSATION_ID=sess-main-a1
    const outDirect = runCli(rootA, { dataHome, fakeHome, env: { ANTIGRAVITY_CONVERSATION_ID: 'sess-main-a1' } });
    check('帶主對話 ID 直接讀到 200k tokens', outDirect.includes('200k tokens') && outDirect.includes('過往 5 個可讀已結案對話'), outDirect);

    // 2. 帶 subagent ID 追回主對話 sess-main-a1
    const outSub = runCli(rootA, { dataHome, fakeHome, env: { ANTIGRAVITY_CONVERSATION_ID: 'sess-sub-1' } });
    check('在 subagent 內執行追回主對話顯示 200k tokens（不印 subagent 的 5k）且明標目前位於 subagent',
      outSub.includes('目前位於 subagent 對話') && outSub.includes('200k tokens') && !outSub.includes('5k tokens'), outSub);

    // 3. 獨立終端機在共用 worktree rootA 執行：列出「2 個進行中的對話」並顯示較新的 sess-a2 (90k)
    const outShared = runCli(rootA, { dataHome, fakeHome });
    check('獨立終端機在共用工作區提示 2 個進行中對話並顯示最近有動作的 90k tokens',
      outShared.includes('2 個進行中的對話') && outShared.includes('90k tokens'), outShared);

    // 4. 獨立終端機在 rootC（0 個進行中對話）執行：絕不混入 rootB 的 320k
    const outNone = runCli(rootC, { dataHome, fakeHome });
    check('獨立終端機在無進行中對話的 rootC 顯示紀錄裡無進行中對話，絕不偷顯示別的 worktree 的 320k',
      outNone.includes('紀錄裡這個工作區目前沒有進行中的對話') && outNone.includes('獨立終端機未帶對話代號') && !outNone.includes('320k'), outNone);

    // 4b. 全新專案尚未建立對話紀錄檔（evState === 'no-file'）時，區分尚未建立紀錄檔與真的無進行中對話（R1 / P3）
    const noFileZh = withLang('zh', () => resolveCliContext({ ctx: { root: '/fresh' }, events: [], evState: 'no-file', sessionId: null }));
    check('evState=no-file 中文版明講尚未建立對話紀錄檔且不講「目前沒有進行中的對話」',
      noFileZh.summaryLine.includes('尚未建立對話紀錄檔') && !noFileZh.summaryLine.includes('目前沒有進行中的對話'),
      noFileZh.summaryLine);
    const noFileEn = withLang('en', () => resolveCliContext({ ctx: { root: '/fresh' }, events: [], evState: 'no-file', sessionId: null }));
    check('evState=no-file 英文版明講 no conversation log file yet 且零中文',
      noFileEn.summaryLine.includes('no conversation log file yet') && !CJK.test(noFileEn.summaryLine),
      noFileEn.summaryLine);

    // 5. 零 commit (!ctx.hasCommits) 且從子目錄 sub/ 執行（預審 #6a）
    execFileSync('git', ['init', '-q'], { cwd: noCommitDir });
    const subDir = join(noCommitDir, 'sub');
    mkdirSync(subDir, { recursive: true });
    const noCommitRoot = realpathSync(noCommitDir);
    const ncLog = logFileOf(logDir, safeName(noCommitRoot.split('/').pop()));
    writeBrainTr('sess-nocommit', [
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-30), model: 'gemini-4-neon-xhigh', input_tokens: 33000, cache_read_tokens: 17000, output_tokens: 90 },
    ]);
    writeFileSync(ncLog, jsonl([
      { ts: T(-120), hook: 'UserPrompt', session: 'sess-nocommit', cwd: join(noCommitRoot, 'sub'), prompt: 'init', title: '零存檔子目錄' },
    ]));
    const outNc = runCli(subDir, { dataHome, fakeHome });
    check('!ctx.hasCommits 從子目錄執行經路徑歸一後仍讀出 50k tokens', outNc.includes('50k tokens'), outNc);

    // 6. CLI 與 collectAll 比例尺一字不差（P2）
    const prevHome = process.env.AGY_PIPELINE_HOME;
    process.env.AGY_PIPELINE_HOME = dataHome;
    const all = withLang('zh', () => collectAll({ monitorDir: ROOT, home: fakeHome }));
    process.env.AGY_PIPELINE_HOME = prevHome;
    const proj = all.projects.find((p) => p.name === projName);
    check('collectAll 帶 contextScaleSupport: true 且專案與 CLI 比例尺一字不差',
      all.contextScaleSupport === true && Boolean(proj?.contextScale?.line) && outDirect.includes(proj.contextScale.line),
      `proj.line=${proj?.contextScale?.line}`);
  } finally {
    rmSync(dataHome, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(noCommitDir, { recursive: true, force: true });
    rmSync(wtB, { recursive: true, force: true });
    rmSync(wtC, { recursive: true, force: true });
    repo.cleanup();
  }
}

/* ════════════ 6. AC-3 & AC-4：網頁照印伺服器、舊服務黃條、gone/movedOn、英文無中文與零禁語 ════════════ */

section('AC-3 & AC-4：網頁照印伺服器、舊服務防護、gone/movedOn 頁面、中英雙語零中文與零百分比／禁語', 'P4');
{
  const fakeWorld = {
    generatedAt: NOW,
    retainDays: 90,
    lang: 'zh',
    contextScaleSupport: true,
    contextGaugeSupport: true,
    sharedLines: { calledNotPassed: '五關寫的是「叫了」' },
    projects: [{
      name: 'p1',
      displayName: 'p1',
      sessions: [
        {
          id: 's-ok',
          title: '活躍對話',
          prompts: 3,
          lastTs: T(-60),
          closedAt: null,
          cwd: '/w',
          card: { path: '/w', branch: 'main', sensor: { state: 'ok' }, stages: [] },
          stages: [],
          context: {
            state: 'ok',
            headline: 'FAKE_HEADLINE_999',
            metaLine: 'FAKE_META_LINE',
            compactionLine: 'FAKE_COMPACTION_LINE',
            peakNote: 'FAKE_PEAK_NOTE',
            scaleLine: 'FAKE_SCALE_LINE',
            breakdownLines: ['FAKE_BREAKDOWN_1'],
            honestNote: 'FAKE_HONEST_NOTE',
          },
        },
        {
          id: 's-gone',
          title: '已刪工作區',
          prompts: 2,
          lastTs: T(-200),
          closedAt: T(-100),
          cwd: '/gone',
          card: { path: '/gone', gone: true, sensor: { state: 'ok' }, stages: [] },
          stages: [],
          context: { state: 'no-file', headline: '問不到', summaryLine: 'FAKE_GONE_CTX', scaleLine: 'FAKE_SCALE_LINE', breakdownLines: [], honestNote: 'FAKE_HONEST' },
        },
        {
          id: 's-moved',
          title: '換手對話',
          prompts: 2,
          lastTs: T(-200),
          closedAt: T(-100),
          movedOn: { at: T(-150) },
          cwd: '/w',
          card: { path: '/w', branch: 'other', sensor: { state: 'ok' }, stages: [] },
          stages: [],
          context: { state: 'no-tokens', headline: '看不到', summaryLine: 'FAKE_MOVED_CTX', scaleLine: 'FAKE_SCALE_LINE', breakdownLines: [], honestNote: 'FAKE_HONEST' },
        },
      ],
    }],
  };

  const ui = uiSessionHarness(fakeWorld, { lang: 'zh' });
  const okHtml = ui.sessionPage('p1', 's-ok');
  check('網頁照印伺服器提供的假記憶量表字串（不自己重算，P2）',
    ['FAKE_HEADLINE_999', 'FAKE_META_LINE', 'FAKE_COMPACTION_LINE', 'FAKE_PEAK_NOTE', 'FAKE_SCALE_LINE', 'FAKE_BREAKDOWN_1', 'FAKE_HONEST_NOTE']
      .every((x) => okHtml.includes(x)), okHtml);
  check('c.gone 與 s.movedOn 對話頁仍顯示對話記憶量表',
    ui.sessionPage('p1', 's-gone').includes('FAKE_GONE_CTX') && ui.sessionPage('p1', 's-moved').includes('FAKE_MOVED_CTX'));

  // 舊服務（缺 contextScaleSupport）→ 頁頂黃條＋量表位置顯示 OLD_LINE
  const oldUi = uiSessionHarness({
    generatedAt: NOW,
    sharedLines: {},
    stampHelp: {},
    todo: { projects: [] },
    guardSupport: true,
    precheckSupport: true,
    escalateSupport: true,
    conflictSupport: true,
    brief: { clear: true, groups: [] },
    projects: fakeWorld.projects,
  }, { lang: 'zh' });
  check('缺少 contextScaleSupport 時 oldServerBanner 亮黃條', /--serve-restart/.test(oldUi.oldServerBanner()));
  check('缺少 contextScaleSupport 時 contextScaleCard 顯示 OLD_LINE（不空白、不當沒事）', oldUi.contextScaleCard(fakeWorld.projects[0].sessions[0]).includes(oldUi.OLD_LINE));

  // 英文版輸出（lib/contextScale.mjs 實際產出 + ui/app.js 渲染）：零中文、零全形空白、零 %、零禁語（P4 / P10）
  const enDir = mkdtempSync(join(tmpdir(), 'pm-ctx-en-'));
  clearTranscriptCache();
  try {
    const tr = join(enDir, 'en.jsonl');
    writeFileSync(tr, jsonl([
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-300), model: 'gemini-4-neon-xhigh', input_tokens: 480000, cache_read_tokens: 0, output_tokens: 400 },
      { step_index: 2, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: T(-200), content: '# Resuming from a compaction' },
      { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-60), model: 'gemini-4-neon-xhigh', input_tokens: 25000, cache_read_tokens: 15000, output_tokens: 100 },
    ]));
    const enOut = withLang('en', () => withClock(() => {
      const closed = ['e1', 'e2', 'e3', 'e4', 'e5'];
      const evs = closed.flatMap((id) => [
        { ts: T(-1000), hook: 'UserPrompt', session: id, cwd: '/w', prompt: id },
        { ts: T(-500), event: 'session_closed', session: id, cwd: '/w', source: 'human' },
      ]);
      const sc = projectContextScale({
        events: evs,
        extraTranscripts: Object.fromEntries(closed.map((id) => [id, tr])),
      });
      const cv = sessionContextView({ sessionId: 'cur', events: evs, projectScale: sc, extraTranscripts: { cur: tr } });
      return { sc, cv };
    }));
    const enCardHtml = uiSessionHarness({ generatedAt: NOW, contextScaleSupport: true, contextGaugeSupport: true }, { lang: 'en' })
      .contextScaleCard({ id: 'cur', context: enOut.cv });
    const textOnly = enCardHtml.replace(/<[^>]*>/g, ' ');
    const allEn = `${enOut.sc.line} ${enOut.cv.summaryLine} ${enOut.cv.compactionLine} ${enOut.cv.peakNote} ${enOut.cv.honestNote} ${enOut.cv.gauge.ariaLabel} ${textOnly}`;
    check('英文版零中文與零全形空白', !CJK.test(allEn) && !allEn.includes('\u3000'), allEn);
    check('英文與網頁無百分比 / % / 禁語 / 美元 / <progress>（P4 / P10）',
      !/%|進度|百分比|\$\d|\bpassed\b|\ball clear\b|\bverified\b|\bsafe\b|✓|✅|<progress\b/i.test(allEn) && !/<progress\b/i.test(enCardHtml), allEn);
    check('formatTokens 與 formatExactTokens 格式正確', formatTokens(1250000) === '1.25M' && formatExactTokens(12345) === '12,345', true);
  } finally {
    rmSync(enDir, { recursive: true, force: true });
  }
}

/* ════════════ 7. 視覺化記憶量表（context-token-visual-gauge）：三態、碰撞、畸形、三層舊服務與雙主題 SVG ════════════ */

section('視覺化記憶量表（context-token-visual-gauge）：scale/no-scale/unavailable 優先序、壓縮殘影、超出最高、畸形防呆與三層舊服務', 'P2');
{
  const fakeScaleReady = {
    ready: true, sample: 14, totalClosed: 14, effectiveClosed: 14, scanned: 14, unscanned: 0, unreadInScanned: 0,
    median: 511000, max: 554200,
    line: '參考：這個專案過往 14 個可讀已結案對話，最高用量通常到 511k tokens，最多到過 554.2k tokens',
  };
  const fakeScaleNotReady = {
    ready: false, sample: 3, totalClosed: 3, effectiveClosed: 3, scanned: 3, unscanned: 0, unreadInScanned: 0,
    median: null, max: null,
    line: '這個專案目前只有 3 個可讀的已結案對話（滿 5 個才給歷史比例尺）',
  };
  const mkRead = (usage) => () => ({ ok: true, isSubagent: false, usage });

  // 1. scale 態：壓縮回落（peak > current）＋緊貼值（511k / 550.5k / 554.2k）＋日夜雙圖層＋四項圖例
  const compView = withClock(() => sessionContextView({
    sessionId: 's-comp',
    projectScale: fakeScaleReady,
    extraTranscripts: { 's-comp': 'tp-comp' },
    read: mkRead({
      latest: { step: 8, at: T(-60), model: 'gemini-4-neon-xhigh', contextTokens: 97600, input_tokens: 17600, cache_read_tokens: 80000, inputTokens: 17600, cacheReadTokens: 80000, outputTokens: 250 },
      peakTokens: 550500, peakAt: T(-300), compactions: 2, lastCompactionAt: T(-240), plannerSteps: 8, readableSteps: 8,
    }),
  }));
  eq('scale 態：mode 為 scale', compView.gauge.mode, 'scale');
  eq('scale 態：domainMax 取三者最大 554.2k', compView.gauge.domainMax, 554200);
  eq('scale 態：exceedsHistoryMax 為 false', compView.gauge.exceedsHistoryMax, false);
  eq('scale 態：peak.aboveCurrent 為 true', compView.gauge.peak.aboveCurrent, true);
  eq('scale 態：compactionBadge 為 壓縮 2 次', compView.gauge.compactionBadge, '壓縮 2 次');

  const uiNow = uiSessionHarness({ generatedAt: NOW, contextScaleSupport: true, contextGaugeSupport: true }, { lang: 'zh' });
  const compHtml = uiNow.contextScaleCard({ id: 's-comp', context: compView });
  check('SVG 同時內嵌日間手繪圖層與夜間賽博圖層、含壓縮章與四項圖例實數且零 %',
    compHtml.includes('class="ctx-g-night"')
    && compHtml.includes('class="ctx-g-day"')
    && compHtml.includes('壓縮 2 次')
    && compHtml.includes('97.6k')
    && compHtml.includes('550.5k')
    && compHtml.includes('511k')
    && compHtml.includes('554.2k')
    && !compHtml.includes('%')
    && !/<progress\b/i.test(compHtml), compHtml);

  // 2. 超出專案過往最高（exceedsHistoryMax）＋ 極小非零值（1 token）＋ 四點完全重合（current === peak === max）
  const exceedView = withClock(() => sessionContextView({
    sessionId: 's-exc',
    projectScale: fakeScaleReady,
    extraTranscripts: { 's-exc': 'tp-exc' },
    read: mkRead({
      latest: { step: 2, at: T(-30), model: 'gemini-4-neon-xhigh', contextTokens: 640000, inputTokens: 40000, cacheReadTokens: 600000, outputTokens: 100 },
      peakTokens: 640000, peakAt: T(-30), compactions: 0, lastCompactionAt: null, plannerSteps: 2, readableSteps: 2,
    }),
  }));
  eq('超出過往最高時 domainMax 動態延展為 640k', exceedView.gauge.domainMax, 640000);
  check('超出過往最高時 exceedsHistoryMax 為 true 且 historyMax.ratio < 1',
    exceedView.gauge.exceedsHistoryMax === true && exceedView.gauge.historyMax.ratio < 1, exceedView.gauge.historyMax.ratio);
  const excHtml = uiNow.contextScaleCard({ id: 's-exc', context: exceedView });
  check('超出過往最高顯示中性標籤且不含紅燈警語', excHtml.includes('高於過往最高') && !excHtml.includes('ctx-warn'), excHtml);

  const tinyView = withClock(() => sessionContextView({
    sessionId: 's-tiny',
    projectScale: fakeScaleReady,
    extraTranscripts: { 's-tiny': 'tp-tiny' },
    read: mkRead({
      latest: { step: 1, at: T(-10), model: 'gemini-4-neon-xhigh', contextTokens: 1, inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 },
      peakTokens: 1, peakAt: T(-10), compactions: 0, lastCompactionAt: null, plannerSteps: 1, readableSteps: 1,
    }),
  }));
  check('極小非零值（1 token）於 ratio > 0 時保底畫出可見最小寬度', tinyView.gauge.current.ratio > 0 && uiNow.contextScaleCard({ id: 's-tiny', context: tinyView }).includes('width="4"'), true);

  // 3. no-scale 與 unavailable 優先序（預審 #2）：state !== 'ok' 且樣本 < 5 時優先出 unavailable；projectScale: null 時自帶原因
  const unavailPriority = sessionContextView({
    sessionId: 's-miss',
    projectScale: fakeScaleNotReady,
    extraTranscripts: { 's-miss': '/nonexistent/path.jsonl' },
  });
  eq('樣本未滿 5 個且轉錄檔遺失時優先回 mode: unavailable（不冒充 no-scale，P5）', unavailPriority.gauge.mode, 'unavailable');

  const noScaleNull = withClock(() => sessionContextView({
    sessionId: 's-noscale-null',
    projectScale: null,
    extraTranscripts: { 's-noscale-null': 'tp-ns' },
    read: mkRead({
      latest: { step: 1, at: T(-20), model: 'gemini-4-neon-xhigh', contextTokens: 80000, inputTokens: 80000, cacheReadTokens: 0, outputTokens: 50 },
      peakTokens: 120000, peakAt: T(-20), compactions: 1, lastCompactionAt: T(-15), plannerSteps: 1, readableSteps: 1,
    }),
  }));
  check('projectScale 為 null 時 mode 為 no-scale 且自帶原因', noScaleNull.gauge.mode === 'no-scale' && Boolean(noScaleNull.gauge.reason), noScaleNull.gauge);
  const nsHtml = uiNow.contextScaleCard({ id: 's-noscale-null', context: noScaleNull });
  check('no-scale 不畫實心比例長條（ctx-g-night 僅虛線空框）且印出未校準原因與壓縮章',
    nsHtml.includes('ctx-gauge-empty') && nsHtml.includes('尚未提供專案歷史比例尺') && nsHtml.includes('壓縮 1 次') && !nsHtml.includes('ctx-legend'), nsHtml);

  // 舊格式無 token 但有壓縮紀錄（unavailable 仍保留壓縮章）
  const oldFmtView = sessionContextView({
    sessionId: 's-oldfmt',
    projectScale: fakeScaleReady,
    extraTranscripts: { 's-oldfmt': 'tp-oldfmt' },
    read: mkRead({ latest: null, peakTokens: null, peakAt: null, compactions: 3, lastCompactionAt: T(-50), plannerSteps: 4, readableSteps: 0 }),
  });
  check('舊格式無 token 紀錄但有壓縮時 mode 為 unavailable 且帶壓縮 3 次徽章',
    oldFmtView.gauge.mode === 'unavailable' && oldFmtView.gauge.compactionBadge === '壓縮 3 次', oldFmtView.gauge);

  // 4. 畸形數值防呆（預審 #1）：NaN/-1/Infinity 整組降級不印 null tokens；peak < current 正規化；median > max 降級 no-scale
  const nanView = sessionContextView({
    sessionId: 's-nan',
    projectScale: fakeScaleReady,
    extraTranscripts: { 's-nan': 'tp-nan' },
    read: mkRead({
      latest: { step: 1, at: T(-10), model: 'gemini-4-neon-xhigh', contextTokens: Number.NaN, inputTokens: 0, cacheReadTokens: 0, outputTokens: null },
      peakTokens: -5, peakAt: null, compactions: 0, lastCompactionAt: null, plannerSteps: 1, readableSteps: 1,
    }),
  });
  check('contextTokens 為 NaN 時整組降級為 no-tokens（絕不印 null tokens，R1）',
    nanView.state === 'no-tokens' && nanView.gauge.mode === 'unavailable' && !/null\s*tokens/i.test(nanView.headline), nanView);

  const normPeakView = withClock(() => sessionContextView({
    sessionId: 's-norm',
    projectScale: { ...fakeScaleReady, median: 600000, max: 500000 }, // median > max 畸形歷史
    extraTranscripts: { 's-norm': 'tp-norm' },
    read: mkRead({
      latest: { step: 1, at: T(-10), model: 'gemini-4-neon-xhigh', contextTokens: 150000, inputTokens: 50000, cacheReadTokens: 100000, outputTokens: 50 },
      peakTokens: 100000, // 畸形：peak < current
      peakAt: T(-10), compactions: 0, lastCompactionAt: null, plannerSteps: 1, readableSteps: 1,
    }),
  }));
  check('peakTokens < contextTokens 時統一正規化為 150000 且不於文字與圖表打架（P2）',
    normPeakView.peakTokens === 150000 && normPeakView.gauge.peak.tokens === 150000 && normPeakView.peakNote === null, normPeakView);
  eq('median > max 畸形歷史比例尺降級為 no-scale', normPeakView.gauge.mode, 'no-scale');
  const normHtml = uiNow.contextScaleCard({ id: 's-norm', context: normPeakView });
  check('畸形歷史比例尺渲染不出「需滿 5 個可讀已結案對話」、照實印數值異常（P5 / R1）',
    normHtml.includes('歷史比例尺數值異常') && !normHtml.includes('需滿 5 個可讀已結案對話'), normHtml);

  // 5. 三層舊服務／缺 gauge 分流（預審 #3）與 gone/movedOn 頁視覺量表
  const v16OldUi = uiSessionHarness({
    generatedAt: NOW, sharedLines: {}, stampHelp: {}, todo: { projects: [] },
    guardSupport: true, precheckSupport: true, escalateSupport: true, conflictSupport: true,
    brief: { clear: true, groups: [] }, contextScaleSupport: true, taskBoardSupport: true, taskEntryMergeSupport: true,
  }, { lang: 'zh' });
  check('缺少 contextGaugeSupport 時 oldServerBanner 亮黃條', /--serve-restart/.test(v16OldUi.oldServerBanner()));
  const v16CardHtml = v16OldUi.contextScaleCard({ id: 's-comp', context: compView });
  check('v0.16 舊服務：保留既有文字（97.6k tokens）、於量表區顯示 OLD_LINE 且不於前端自拼 ctx-compact-badge（P2）',
    v16CardHtml.includes('97.6k tokens') && v16CardHtml.includes(v16OldUi.OLD_LINE) && !v16CardHtml.includes('ctx-compact-badge'), v16CardHtml);

  const fakeBadgeHtml = uiNow.contextScaleCard({
    id: 's-fake-badge',
    context: { ...compView, gauge: { ...compView.gauge, compactionBadge: 'FAKE_BADGE_99' } },
  });
  check('網頁照印伺服器給的假 compactionBadge 字串（不自己重算，P2）',
    fakeBadgeHtml.includes('FAKE_BADGE_99'), fakeBadgeHtml);

  const missingGaugeHtml = uiNow.contextScaleCard({ id: 's-nogauge', context: { state: 'ok', headline: '50k tokens', metaLine: 'm' } });
  check('已有 contextGaugeSupport 但缺 s.context.gauge → 顯示問不到量表，不誤報舊服務（P5）',
    missingGaugeHtml.includes('問不到視覺量表資料') && !missingGaugeHtml.includes(uiNow.OLD_LINE), missingGaugeHtml);

  const goneUi = uiSessionHarness({
    generatedAt: NOW, contextScaleSupport: true, contextGaugeSupport: true, sharedLines: { calledNotPassed: '叫了' },
    projects: [{
      name: 'p1', displayName: 'p1',
      sessions: [{ id: 'g1', title: '已刪', prompts: 1, lastTs: T(-20), closedAt: T(-10), cwd: '/g', card: { path: '/g', gone: true, sensor: { state: 'ok' }, stages: [] }, stages: [], context: compView }],
    }],
  }, { lang: 'zh' });
  check('c.gone 對話頁一樣畫出視覺記憶量表 SVG', goneUi.sessionPage('p1', 'g1').includes('class="ctx-gauge-svg"'));
}

process.exit(summary());
