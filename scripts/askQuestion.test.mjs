#!/usr/bin/env node
/**
 * askQuestion.test.mjs —— ask_question 一鍵決策卡解析（規格: docs/進行中/ask-question-decision-cards.md）
 *
 * 釘住所有會安靜說謊的邊界：
 *   ① 只採認嚴格配對且 status==="DONE"、有非空 An: 回覆的選項卡（防 run_command 輸出與 AI 題目 args.questions 冒充人話，P7）
 *   ② 優先取 Completed At（絕不拿彈出時間 created_at 充數），缺則對同 (session, step) PostToolUse，秒級支援同秒 step>anchorStep（P9 / R1）
 *   ③ 四大指令（--decide / --clear / --tier-later / --wrap）採認並區分「你在選項卡點的回覆」與「說的最後一句」（P2 / P6）
 *   ④ 邊界守住不誤傷：gate.mjs 回合起點、specsOfRun、typedRun、BANG（! 親跑）、firstPromptsOf（P7 / P6）
 *   ⑤ 開放四支決策技能、rules/AGENTS.md 與門禁提示，E 驗收禁標 (Recommended)（R2 / P10）
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, symlinkSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  readTranscript, parseAskQuestionReply, enrichWithTranscripts, guessTranscriptPath, clearTranscriptCache,
} from '../lib/transcript.mjs';
import {
  promptKind, saidByHuman, runsPerStage, sessionView, firstPromptsOf, sessionsOf, rerunLine, matchAskQuote,
} from '../lib/rounds.mjs';
import { eLines } from '../lib/verify.mjs';
import { dangerAskLine, pendingRequirements } from '../lib/tier.mjs';
import { findWords } from '../lib/cliWrap.mjs';
import { safeName, PROMPT_CAP } from '../lib/events.mjs';
import { withLang } from '../lib/lang.mjs';
import { decide } from '../gate.mjs';
import { collectAll } from '../lib/collect.mjs';
import { CJK } from './_zhscan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).name;
const STAGES = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
const out = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

const NOW = Date.now();
const T = (sec) => new Date(NOW + sec * 1000).toISOString();
const wholeSec = (sec) => {
  const d = new Date(NOW + sec * 1000);
  d.setUTCMilliseconds(0);
  return d.toISOString().replace('.000Z', 'Z');
};
const at = (sec) => new Date(NOW + sec * 1000);
const MIN = 60;

/** 建立隔離測試環境：獨立 git repo + 獨立 AGY_PIPELINE_HOME + 獨立 transcript 檔案。 */
function scene({ levels = null, lang = 'zh' } = {}) {
  const tiers = {
    code: ['src/'],
    danger: ['src/danger.js'],
    ...(levels ? { levels } : {}),
  };
  const r = makeRepo({
    at: T(-120 * MIN),
    files: {
      'src/a.js': 'export const a = 1;\n',
      'src/danger.js': 'export const d = 1;\n',
      'package.json': JSON.stringify({ name: 'aq-demo', version: '1.0.0', scripts: { test: 'node -e ""' } }),
      '.agents/pipeline-stages.json': JSON.stringify({ tiers }),
    },
  });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-aq-mon-'));
  const logDir = join(monitorDir, 'logs');
  mkdirSync(logDir);
  mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang }));

  const home = mkdtempSync(join(tmpdir(), 'pm-aq-home-'));
  mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(ROOT, join(home, '.gemini', 'config', 'plugins', PLUGIN));

  const brainDir = join(home, '.gemini', 'antigravity', 'brain', 's1', '.system_generated', 'logs');
  mkdirSync(brainDir, { recursive: true });
  const trFull = join(brainDir, 'transcript_full.jsonl');
  const trCompact = join(brainDir, 'transcript.jsonl');

  const log = join(logDir, `${safeName(basename(root))}.jsonl`);
  const line = (o) => JSON.stringify(o.event ? { cwd: root, ...o } : { session: 's1', cwd: root, ...o });
  const write = (lines) => writeFileSync(log, lines.map(line).join('\n') + '\n');
  const append = (lines) => appendFileSync(log, lines.map(line).join('\n') + '\n');
  const touch = (f, sec, body = `// changed ${sec}\n`) => {
    const p = join(root, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    utimesSync(p, at(sec), at(sec));
  };
  const setLang = (l) => writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang: l }));

  const cli = (args, { session = 's1', cwd = root } = {}) => {
    const { ANTIGRAVITY_CONVERSATION_ID: _drop, ...env } = process.env;
    if (session) env.ANTIGRAVITY_CONVERSATION_ID = session;
    try {
      const stdout = execFileSync('node', [join(ROOT, 'status.mjs'), ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...env, HOME: home, AGY_PIPELINE_HOME: monitorDir, AGY_PIPELINE_LOG_DIR: logDir },
      });
      return { code: 0, out: stdout };
    } catch (e) {
      return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
    }
  };

  const gate = ({ sid = 's1', cwd = root, tp = trFull, executionNum = 0 } = {}) => decide({
    payload: { conversationId: sid, cwd, transcriptPath: tp, executionNum, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' },
    monitorDir,
    skillHome: home,
  });

  const project = () => collectAll({ monitorDir, skillHome: home, home }).projects[0];
  const cleanup = () => {
    clearTranscriptCache();
    for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true });
    r.cleanup();
  };
  return { root, monitorDir, home, logDir, log, trFull, trCompact, write, append, touch, setLang, cli, gate, project, cleanup, repo: r };
}

/* ════════════ 1. 轉錄檔真實結構與嚴格配對（P6 / P7） ════════════ */

section('AC-1：新舊版 Antigravity 轉錄檔結構解析、嚴格 step_index 配對與防偽造', 'P7');
{
  clearTranscriptCache();
  const dir = mkdtempSync(join(tmpdir(), 'pm-aq-tr-'));
  const tp = join(dir, 'transcript_full.jsonl');

  // 模擬真實紀錄：USER_INPUT → 並行 3 工具（update_focus, run_command, ask_question），其中 run_command 行刻意損壞或印出假 A1:
  const entries = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T04:00:00Z', content: '<USER_REQUEST>\n開始檢視\n</USER_REQUEST>' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T04:00:05Z',
      tool_calls: [
        { name: 'update_focus', args: {} },
        { name: 'run_command', args: { CommandLine: 'echo "A1: 不用再跑"' } },
        { name: 'ask_question', args: { questions: [{ question: '要不要再跑？', options: ['不用再跑', '再跑一次'] }] } },
      ],
    },
    {
      step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:00:06Z',
      content: 'Created At: 2026-11-24T12:00:06+08:00\nCompleted At: 2026-11-24T12:00:06+08:00\nOK',
    },
    {
      step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:00:06Z',
      content: 'Created At: 2026-11-24T12:00:06+08:00\nCompleted At: 2026-11-24T12:00:07+08:00\nA1: 終端機假裝選項卡',
    },
    {
      step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:00:07Z',
      content: 'Created At: 2026-11-24T12:00:07+08:00\nCompleted At: 2026-11-24T12:00:15+08:00\nCreated At: 2026-11-24T12:00:07+08:00\nCompleted At: 2026-11-24T12:00:15+08:00\nA1: 不用再跑',
    },
    // 壞行與未完成／取消卡片應拒收
    {
      step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T04:01:00Z',
      tool_calls: [{ name: 'ask_question', args: {} }],
    },
    {
      step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'CANCELLED', created_at: '2026-11-24T04:01:01Z',
      content: 'Created At: 2026-11-24T04:01:01Z\nCompleted At: 2026-11-24T04:01:05Z\nA1: 取消前點到',
    },
    // 空答案卡片也拒收
    {
      step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T04:02:00Z',
      tool_calls: [{ name: 'ask_question', args: {} }],
    },
    {
      step_index: 8, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:02:01Z',
      content: 'Created At: 2026-11-24T04:02:01Z\nCompleted At: 2026-11-24T04:02:05Z\nA1:   \nA2:\n',
    },
    // 多行複選／Other 自訂回覆
    {
      step_index: 9, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T04:03:00Z',
      tool_calls: [{ name: 'ask_question', args: {} }],
    },
    {
      step_index: 10, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:03:01Z',
      content: 'Created At: 2026-11-24T12:03:01+08:00\nCompleted At: 2026-11-24T12:03:20+08:00\nA1: 選項一\n補充說明第二行\nA2:   \nA3: 只保留第三題',
    },
    // 舊版 ASK_QUESTION 格式
    {
      step_index: 11, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T04:04:00Z',
      tool_calls: [{ name: 'ask_question', args: {} }],
    },
    {
      step_index: 12, source: 'MODEL', type: 'ASK_QUESTION', status: 'DONE', created_at: '2026-11-24T04:04:01Z',
      content: 'Created At: 2026-11-24T04:04:01Z\nCompleted At: 2026-11-24T04:04:10Z\nA1: 舊版也認得',
    },
  ];
  writeFileSync(tp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const res = readTranscript(tp);
  eq('讀取成功', res.ok, true);
  eq('應擷取 USER_INPUT + 3 筆合法 ask_question（共 4 筆，拒收 run_command 假輸出、CANCELLED 與空答案）', res.prompts.length, 4);
  eq('第 2 筆為 step 4 真正的 ask_question 回覆（非 step 3 的 run_command）', res.prompts[1]?.prompt, '不用再跑');
  eq('第 2 筆 via 標記 ask_question', res.prompts[1]?.via, 'ask_question');
  eq('第 2 筆時間正規化為 Completed At UTC ISO（12:00:15+08:00 → 04:00:15.000Z）', res.prompts[1]?.ts, '2026-11-24T04:00:15.000Z');
  eq('第 3 筆保留 A1 多行內容並略過空白的 A2', res.prompts[2]?.prompt, 'A1: 選項一\n補充說明第二行\nA3: 只保留第三題');
  eq('第 3 筆 askAnswers 陣列包含兩題非空答案', JSON.stringify(res.prompts[2]?.askAnswers), JSON.stringify(['選項一\n補充說明第二行', '只保留第三題']));
  eq('第 4 筆舊版 ASK_QUESTION 正確解析', res.prompts[3]?.prompt, '舊版也認得');

  // 壞行跳過防錯位（預審 #1）：把前面兩筆結果弄成壞 JSON 行，step 4 仍然只對到 tool_calls[2]
  const tpCorrupt = join(dir, 'corrupt.jsonl');
  const corruptLines = [
    JSON.stringify(entries[1]),
    '{bad json for step 2',
    JSON.stringify({ ...entries[3], step_index: 3 }), // run_command
    JSON.stringify(entries[4]), // step 4 -> offset 2 = ask_question
    // 另一組：run_command 在 step 12 緊跟壞行後冒充 offset
    JSON.stringify({ step_index: 10, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T04:05:00Z', tool_calls: [{ name: 'ask_question' }, { name: 'run_command' }] }),
    '{bad json at step 11',
    JSON.stringify({ step_index: 12, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:05:01Z', content: 'Created At: 2026-11-24T04:05:01Z\nCompleted At: 2026-11-24T04:05:05Z\nA1: 我是 run_command 冒充' }),
  ];
  writeFileSync(tpCorrupt, corruptLines.join('\n') + '\n');
  const rc = readTranscript(tpCorrupt);
  eq('壞行後 step_index 仍嚴格對齊：僅採認 step 4，拒收 step 12 的 run_command 冒充', rc.prompts.map((p) => p.prompt).join(','), '不用再跑');

  // 無 step_index 合成資料：筆數不符或有壞行即整組拒收
  const tpSeqBad = join(dir, 'seq_bad.jsonl');
  writeFileSync(tpSeqBad, [
    JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T04:06:00Z', tool_calls: [{ name: 'run_command' }, { name: 'ask_question' }] }),
    JSON.stringify({ source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:06:01Z', content: 'Created At: 2026-11-24T04:06:01Z\nCompleted At: 2026-11-24T04:06:05Z\nA1: 缺一筆不應誤對' }),
  ].join('\n') + '\n');
  eq('無 step_index 且結果筆數少於 tool_calls 時拒收', readTranscript(tpSeqBad).prompts.length, 0);

  // subagent transcript 絕不併入主對話
  const tpSub = join(dir, 'sub.jsonl');
  writeFileSync(tpSub, [
    JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'sender=main-1' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T04:00:00Z', tool_calls: [{ name: 'ask_question' }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:00:01Z', content: 'Created At: 2026-11-24T04:00:01Z\nCompleted At: 2026-11-24T04:00:05Z\nA1: 子 agent 回答' }),
  ].join('\n') + '\n');
  const enrichedSub = enrichWithTranscripts(
    [{ ts: '2026-11-24T04:00:02Z', hook: 'PostToolUse', session: 'sub-1', cwd: '/w', tool: 'read_file', transcript: tpSub }],
    { extraTranscripts: new Map([['sub-1', tpSub]]) },
  );
  eq('subagent 的 ask_question 不補入主事件流 UserPrompt', enrichedSub.filter((e) => e.hook === 'UserPrompt').length, 0);

  rmSync(dir, { recursive: true, force: true });
}

section('魔鬼教官第 1 輪回歸：GENERIC 先於 PLANNER_RESPONSE 寫入仍配對、tool_calls 截斷補讀（P6）', 'P6');
{
  clearTranscriptCache();
  const dir = mkdtempSync(join(tmpdir(), 'pm-aq-ooo-'));
  const tpOoo = join(dir, 'transcript_full.jsonl');
  // 實測 Antigravity 常見寫法：GENERIC (step 2/3) 與 CHECKPOINT (step 4) 比 PLANNER_RESPONSE (step 1) 先落地
  writeFileSync(tpOoo, [
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:10:02Z', content: 'Created At: 2026-11-24T04:10:02Z\nCompleted At: 2026-11-24T04:10:09Z\nA1: 提前落地也認得' }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:10:03Z', content: 'Created At: 2026-11-24T04:10:03Z\nCompleted At: 2026-11-24T04:10:04Z\nA1: 終端機假裝答案' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T04:10:01Z', tool_calls: [{ name: 'ask_question', args: {} }, { name: 'run_command', args: {} }] }),
    JSON.stringify({ step_index: 4, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: '2026-11-24T04:10:10Z', content: 'checkpoint' }),
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T04:10:00Z', content: '<USER_REQUEST>\n亂序開始\n</USER_REQUEST>' }),
  ].join('\n') + '\n');
  const rOoo = readTranscript(tpOoo);
  eq('亂序寫入時仍依 step_index 順序保留兩則且不誤採 run_command', rOoo.prompts.map((p) => p.prompt).join(','), '亂序開始,提前落地也認得');
  eq('亂序寫入時 step 2 仍正確標記 via: ask_question', rOoo.prompts[1]?.via, 'ask_question');

  // compact transcript.jsonl 的 PLANNER_RESPONSE 若 truncated_fields 含 tool_calls 且元件被裁短，仍能從同目錄 transcript_full.jsonl 補齊
  const brain = join(dir, 'brain');
  mkdirSync(brain, { recursive: true });
  const cPath = join(brain, 'transcript.jsonl');
  const fPath = join(brain, 'transcript_full.jsonl');
  writeFileSync(fPath, [
    JSON.stringify({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T04:20:00Z', tool_calls: [{ name: 'read_file' }, { name: 'ask_question' }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:20:01Z', content: 'Created At: 2026-11-24T04:20:01Z\nCompleted At: 2026-11-24T04:20:05Z\nA1: 補齊 tool_calls 後認得' }),
  ].join('\n') + '\n');
  writeFileSync(cPath, [
    JSON.stringify({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T04:20:00Z', truncated_fields: ['tool_calls'], tool_calls: [{ name: 'read_file' }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:20:01Z', content: 'Created At: 2026-11-24T04:20:01Z\nCompleted At: 2026-11-24T04:20:05Z\nA1: 補齊 tool_calls 後認得' }),
  ].join('\n') + '\n');
  clearTranscriptCache();
  eq('compact PLANNER_RESPONSE 截斷 tool_calls 時自動補讀完整清單配對 ask_question', readTranscript(cPath).prompts.map((p) => p.prompt).join(','), '補齊 tool_calls 後認得');

  rmSync(dir, { recursive: true, force: true });
}

/* ════════════ 2. 時間戳邊界、截斷補讀與 Unicode cut 一致性（P9 / P2 / R1） ════════════ */

section('AC-1/AC-2：缺 Completed At 不退回 created_at、截斷補讀 transcript_full 與 emoji 字元數 cut 一致', 'P9');
{
  clearTranscriptCache();
  // 缺 Completed At：parseAskQuestionReply 預設回 null，不拿 Created At 充數
  eq('無 Completed At 且無 fallbackTs 時回 null', parseAskQuestionReply('Created At: 2026-11-24T04:00:00Z\nA1: 不用再跑'), null);
  eq('無 Completed At 且允許缺省時 ts 為 null', parseAskQuestionReply('Created At: 2026-11-24T04:00:00Z\nA1: 不用再跑', { allowMissingTs: true })?.ts, null);

  const dir = mkdtempSync(join(tmpdir(), 'pm-aq-cap-'));
  const brain = join(dir, '.gemini', 'antigravity', 'brain', 'sess-cap', '.system_generated', 'logs');
  mkdirSync(brain, { recursive: true });
  const trCompact = join(brain, 'transcript.jsonl');
  const trFull = join(brain, 'transcript_full.jsonl');

  const noCompleted = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T04:00:00Z', content: '<USER_REQUEST>\n嗨\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T04:00:05Z', tool_calls: [{ name: 'ask_question' }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:00:05Z', content: 'Created At: 2026-11-24T04:00:05Z\nA1: 缺完成時間' },
  ];
  writeFileSync(trFull, noCompleted.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(trCompact, noCompleted.map((e, idx) => JSON.stringify(idx === 2 ? { ...e, truncated_fields: ['content'], content: 'Created At: ...' } : e)).join('\n') + '\n');

  eq('guessTranscriptPath 優先選 transcript_full.jsonl', basename(guessTranscriptPath('sess-cap', dir) ?? ''), 'transcript_full.jsonl');

  const noPostEv = enrichWithTranscripts(
    [{ ts: '2026-11-24T04:00:01Z', hook: 'PostToolUse', session: 'sess-cap', cwd: '/w', tool: 'read_file', transcript: trFull }],
  );
  eq('缺 Completed At 且無同 step PostToolUse(ask_question) → 不採納（不退回 created_at）', noPostEv.filter((e) => e.via === 'ask_question').length, 0);

  const withPostEv = enrichWithTranscripts(
    [
      { ts: '2026-11-24T04:00:01Z', hook: 'PostToolUse', session: 'sess-cap', cwd: '/w', tool: 'read_file', transcript: trFull },
      { ts: '2026-11-24T04:00:25Z', hook: 'PostToolUse', session: 'sess-cap', cwd: '/w', tool: 'ask_question', step: 2, transcript: trFull },
    ],
  );
  const gotAsk = withPostEv.find((e) => e.via === 'ask_question');
  eq('缺 Completed At 但對得上同 step PostToolUse → 採納 PostToolUse 時間戳', gotAsk?.ts, '2026-11-24T04:00:25Z');

  // transcript.jsonl 被截斷時，從同目錄 transcript_full.jsonl 補讀；移除 transcript_full.jsonl 則跳過
  const fullEmojiAns = `${'😀'.repeat(100)}${'a'.repeat(100)}`; // 200 Unicode chars, UTF-16 length = 300!
  const emojiEntries = [
    { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T04:00:00Z', tool_calls: [{ name: 'ask_question' }] },
    { step_index: 1, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T04:00:01Z', content: `Created At: 2026-11-24T04:00:01Z\nCompleted At: 2026-11-24T04:00:10Z\nA1: ${fullEmojiAns}` },
  ];
  writeFileSync(trFull, emojiEntries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(trCompact, [
    JSON.stringify(emojiEntries[0]),
    JSON.stringify({ ...emojiEntries[1], truncated_fields: ['content'], content: 'Created At: 2026-11-24T04:00:01Z\nCompleted At: ...' }),
  ].join('\n') + '\n');
  clearTranscriptCache();
  const recovered = readTranscript(trCompact);
  eq('compact 被截斷時自動從同目錄 transcript_full.jsonl 補回', recovered.prompts[0]?.cut, true);
  eq('截斷補讀依 Unicode 字元數恰好保留 200 字元', [...(recovered.prompts[0]?.prompt ?? '')].length, PROMPT_CAP);

  // 驗證剛好 150 個 emoji（UTF-16 長度 300 >= 200，但字元數 150 < 200）→ cut 應為 false！
  const emoji150 = '😀'.repeat(150);
  const parsed150 = parseAskQuestionReply(`Created At: 2026-11-24T04:00:01Z\nCompleted At: 2026-11-24T04:00:10Z\nA1: ${emoji150}`);
  eq('150 個 emoji（UTF-16=300，字元數=150）→ cut 為 false', parsed150?.cut, false);
  eq('matchAskQuote 對 150 個 emoji 也回 cut=false（與 transcript.mjs 口徑一致）', matchAskQuote({ via: 'ask_question', prompt: parsed150.prompt, prompt_cut: parsed150.cut }).cut, false);

  rmSync(trFull);
  clearTranscriptCache();
  eq('沒有 transcript_full.jsonl 且 compact 標示 content 截斷 → 略過不猜', readTranscript(trCompact).prompts.length, 0);
  rmSync(dir, { recursive: true, force: true });
}

/* ════════════ 3. 四大指令實跑 + 同秒/改檔邊界 + 雙語 + 純文字相容（P2 / P6 / P7 / P9） ════════════ */

section('AC-2：四大指令（--decide / --clear / --tier-later / --wrap）實跑選項卡回覆、拍板後改檔與雙語對照', 'P2');
{
  const s = scene({ levels: { none: { id: 'T0', requires: [] }, code: { id: 'T1', requires: ['D'] }, danger: { id: 'T2', requires: ['D', 'E'] } } });
  const h = out(s.root, 'rev-parse', '--short', 'HEAD');
  const readPlugin = (sk, sec, step) => ({ ts: T(sec), hook: 'PostToolUse', tool: 'read_file', skill: `${PLUGIN}:${sk}`, step, head: h, transcript: s.trFull });

  // 1) --decide D skip：支援選項卡 + 彈出與送出之間改檔不算之後改 + 送出後改檔重問 + 同秒 step > call.step
  const tOpen = wholeSec(-90);
  const tClick = wholeSec(-60); // 精確到秒
  // 先測：call D(-120) → 報 found(-110) → 彈卡 tOpen(-90) → 彈出後點擊前改檔(-75) → 點擊送出 Completed At(-60)
  writeFileSync(s.trFull, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: T(-300), content: '<USER_REQUEST>\n改程式\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: tOpen, tool_calls: [{ name: 'ask_question' }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: tOpen, content: `Created At: ${tOpen}\nCompleted At: ${tClick}\nA1: No need to run D again` }),
  ].join('\n') + '\n');

  s.write([
    readPlugin('chaos-check', -120, 1),
    { ts: T(-110), event: 'stage_report', stage: 'D', verdict: 'found', note: '找到 1 條', by_session: 's1', source: 'ai' },
  ]);
  s.touch('src/a.js', -75); // 在 tOpen(-90) 與 tClick(-60) 之間改檔：早於 Completed At(-60)，應被該決定蓋住！

  let r = s.cli(['--decide', 'D', 'skip', 'No need to run D again']);
  check('--decide D skip（ZH）採認選項卡並印出選項卡來源字樣',
    r.code === 0 && /D 被叫之後在選項卡點的回覆：「No need to run D again」/.test(r.out), r.out);
  let dStage = s.project()?.sessions?.find((x) => x.id === 's1')?.stages?.find((x) => x.id === 'D');
  eq('彈出後、點擊送出前（Completed At）改檔 → D 仍為 held（沒拿 created_at 充數）', dStage?.state, 'held');
  check('看板 rerun.line 顯示你在選項卡點的回覆', /D 之後你在選項卡點的回覆：「No need to run D again」/.test(dStage?.rerun?.line ?? ''), dStage?.rerun?.line);

  // 英文雙語檢查
  s.setLang('en');
  r = s.cli(['--decide', 'D', 'skip', 'No need to run D again']);
  check('--decide D skip（EN）印 your last option-card reply 且零中文',
    r.code === 0 && /your last option-card reply after D/.test(r.out) && !CJK.test(r.out), r.out);
  dStage = withLang('en', () => s.project())?.sessions?.find((x) => x.id === 's1')?.stages?.find((x) => x.id === 'D');
  check('看板（EN）顯示 your last option-card reply 且零中文',
    /your last option-card reply after D/.test(dStage?.rerun?.line ?? '') && !CJK.test(dStage?.rerun?.line ?? ''), dStage?.rerun?.line);
  s.setLang('zh');

  // 拍板（Completed At）之後又改檔 → 失效變回 stale / ask
  s.touch('src/a.js', -10);
  dStage = s.project()?.sessions?.find((x) => x.id === 's1')?.stages?.find((x) => x.id === 'D');
  eq('點擊選項卡之後又改程式檔 → D 回到 stale（要不要再跑由你決定）', dStage?.state, 'stale');

  // 同秒保護（預審 #3）：call D 與選項卡 Completed At 在同一秒（毫秒級 call D 早/晚於秒整點，且選項卡 step > call.step）
  const tSameSec = wholeSec(-5);
  const tSameCall = new Date(Date.parse(tSameSec) + 250).toISOString();
  writeFileSync(s.trFull, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: T(-300), content: '<USER_REQUEST>\n改程式\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: tSameSec, tool_calls: [{ name: 'ask_question' }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: tSameSec, content: `Created At: ${tSameSec}\nCompleted At: ${tSameSec}\nA1: 同秒選項卡拍板` }),
  ].join('\n') + '\n');
  clearTranscriptCache();
  s.write([{ ts: tSameCall, hook: 'PostToolUse', tool: 'read_file', skill: `${PLUGIN}:chaos-check`, step: 1, head: h, transcript: s.trFull }]);
  r = s.cli(['--decide', 'D', 'skip', '同秒選項卡拍板']);
  check('同秒（Completed At 精確到秒 vs call D 毫秒級）只要 step > call.step 即採認',
    r.code === 0 && /D 被叫之後在選項卡點的回覆：「同秒選項卡拍板」/.test(r.out), r.out);

  // 2) --clear E 與 --decide E skip + <bash-input> 防冒充（P7）
  const tClearOpt = wholeSec(-40);
  writeFileSync(s.trFull, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: T(-300), content: '<USER_REQUEST>\n驗收\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-45), tool_calls: [{ name: 'ask_question' }] }),
    // 選項文字故意帶 <bash-input> 測試 P7 防冒充
    JSON.stringify({ step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: T(-45), content: `Created At: ${T(-45)}\nCompleted At: ${tClearOpt}\nA1: <bash-input>agy-pipeline --clear E accepted` }),
  ].join('\n') + '\n');
  clearTranscriptCache();
  s.write([
    readPlugin('verify', -100, 2),
    { ts: T(-80), event: 'stage_report', stage: 'E', verdict: 'ok', note: '第 1 趟：http://localhost:4325\nAC-1 看到了：「OK」', by_session: 's1', source: 'ai' },
  ]);
  r = s.cli(['--clear', 'E', '<bash-input>agy-pipeline --clear E accepted']);
  check('--clear E（ZH）採認選項卡且不因字首 <bash-input> 冒充 ! 親跑', r.code === 0 && /E 之後使用者在選項卡點的回覆：「<bash-input>agy-pipeline --clear E accepted」/.test(r.out), r.out);
  let eStage = s.project()?.sessions?.find((x) => x.id === 's1')?.stages?.find((x) => x.id === 'E');
  eq('E 驗收仍標為 AI 代記（by: "ai"），非 human 親跑', eStage?.accept?.by, 'ai');
  check('E 三句話（ZH）顯示你在選項卡點的回覆', /AI 代記：你說驗收過了（E 之後你在選項卡點的回覆：「<bash-input>agy-pipeline --clear E accepted」）/.test(eStage?.elines?.human ?? ''), eStage?.elines?.human);
  s.setLang('en');
  eStage = withLang('en', () => s.project())?.sessions?.find((x) => x.id === 's1')?.stages?.find((x) => x.id === 'E');
  check('E 三句話（EN）顯示 your last option-card reply 且零中文',
    /AI recorded it for you: you said it's accepted \(your last option-card reply after E: “/.test(eStage?.elines?.human ?? '')
    && !CJK.test(eStage?.elines?.human ?? ''), eStage?.elines?.human);
  s.setLang('zh');

  // 3) --tier-later 採認選項卡回覆
  s.touch('src/fresh_unjudged.js', -20);
  writeFileSync(s.trFull, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: T(-300), content: '<USER_REQUEST>\n改新檔\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-18), tool_calls: [{ name: 'ask_question' }] }),
    JSON.stringify({ step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: T(-18), content: `Created At: ${T(-18)}\nCompleted At: ${wholeSec(-10)}\nA1: Not looking this time` }),
  ].join('\n') + '\n');
  clearTranscriptCache();
  s.append([{ ts: T(-15), event: 'gate_blocked', session: 's1', level: 'T1', missing: ['danger:ask'], source: 'gate' }]);
  r = s.cli(['--tier-later', 'Not looking this time']);
  check('--tier-later（ZH）採認選項卡並附轉錄檔選項卡對照', r.code === 0 && /轉錄檔記的、使用者在選項卡點的回覆是「Not looking this time」/.test(r.out), r.out);
  s.setLang('en');
  r = s.cli(['--tier-later', 'Not looking this time']);
  check('--tier-later（EN）印 option-card reply recorded in the transcript 且零中文',
    r.code === 0 && /option-card reply recorded in the transcript/.test(r.out) && !CJK.test(r.out), r.out);
  s.setLang('zh');

  // 4) --wrap 多題超長 (>200 字) 選項卡比對 + 單次點擊只試一次 + 純文字相容
  const q1Long = `第一題長說明_${'甲'.repeat(195)}`; // > 200 chars when merged with Q2
  const q2Choice = '照建議收尾：併進 main 並蓋章';
  const wrapEvents = [
    { ts: T(-100), hook: 'PostToolUse', tool: 'read_file', skill: `${PLUGIN}:director`, session: 's1', cwd: '/w', step: 7 },
    {
      ts: T(-50), hook: 'UserPrompt', session: 's1', cwd: '/w', step: 9,
      prompt: `A1: ${q1Long}`.slice(0, PROMPT_CAP),
      prompt_cut: true,
      via: 'ask_question',
      ask_answers: [q1Long.slice(0, PROMPT_CAP), q2Choice],
    },
  ];
  const fw = findWords(wrapEvents, 's1', q2Choice);
  eq('多題超長選項卡，第二題照建議收尾照樣對得到', fw.state, 'ok');
  eq('命中第二題時回傳該題文字而非截斷前段', fw.said?.text, q2Choice);
  eq('該題本身未超過 200 字 → cut 為 false', fw.cut, false);
  eq('保留 via: ask_question', fw.said?.via, 'ask_question');

  // 純文字相容：一般 UserPrompt 不標成選項卡
  const textEvents = [
    { ts: T(-100), hook: 'PostToolUse', tool: 'read_file', skill: `${PLUGIN}:director`, session: 's1', cwd: '/w', step: 7 },
    { ts: T(-50), hook: 'UserPrompt', session: 's1', cwd: '/w', step: 8, prompt: '照建議收尾' },
  ];
  const fwText = findWords(textEvents, 's1', '照建議收尾');
  eq('純文字回話 findWords 相容且 via 為 null', fwText.said?.via ?? null, null);

  // 實跑 status.mjs --wrap（在工作樹觸發真實 merge 檢查：未 commit 擋住但仍驗證通過選項卡且寫入 wrap 事件 + 防同句重試）
  const wrapRepo = scene();
  writeFileSync(wrapRepo.trFull, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: T(-300), content: '<USER_REQUEST>\n叫主任\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-60), tool_calls: [{ name: 'ask_question' }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: T(-60), content: `Created At: ${T(-60)}\nCompleted At: ${wholeSec(-30)}\nA1: ${q1Long}\nA2: ${q2Choice}` }),
  ].join('\n') + '\n');
  clearTranscriptCache();
  wrapRepo.write([{ ts: T(-90), hook: 'PostToolUse', tool: 'read_file', skill: `${PLUGIN}:director`, step: 1, transcript: wrapRepo.trFull }]);
  // 直接在 main 上測試 stepMerge 回「不用」（no-need），確認 exit 0 且寫入 wrap 紀錄！
  const wr1 = wrapRepo.cli(['--wrap', 'merge', q2Choice]);
  check('--wrap merge（ZH）對得上多題超長選項卡第二題並印選項卡來源', wr1.code === 0 && /照你在選項卡點的回覆「照建議收尾：併進 main 並蓋章」/.test(wr1.out), wr1.out);
  const wrDup = wrapRepo.cli(['--wrap', 'merge', q2Choice]);
  check('同一次選項卡點擊同一 step 第二次呼叫會擋下「已經拿來做過一次」', wrDup.code === 1 && /已經拿來做過一次/.test(wrDup.out), wrDup.out);
  wrapRepo.setLang('en');
  const wrEn = wrapRepo.cli(['--wrap', 'restart', q2Choice]);
  // restart 會說連不上服務（exit 1），但已經通過 findWords 才去執行並印出對照句（或先測試 stepMerge 前清空？用 push 無上游也印！）
  const wrPushEn = wrapRepo.cli(['--wrap', 'push', q2Choice]);
  check('--wrap push（EN）印 going by your option-card reply 且零中文',
    wrPushEn.code === 0 && /going by your option-card reply: “/.test(wrPushEn.out) && !CJK.test(wrPushEn.out.replace(q2Choice, '')), wrPushEn.out);
  wrapRepo.cleanup();
  s.cleanup();
}

/* ════════════ 4. 邊界保護：gate.mjs / specsOfRun / typedRun / promptKind / firstPromptsOf（P7 / P6） ════════════ */

section('AC-3：中途點選項卡不移收工門禁 turnStart、不截斷 A 寫規格、不冒充斜線指令或異常標籤', 'P7');
{
  const s = scene({ levels: { none: { id: 'T0', requires: [] }, code: { id: 'T1', requires: ['D'] }, danger: { id: 'T2', requires: ['A', 'D', 'tests'] } } });
  // 使用者打字要求改程式 → 改 src/a.js → 中途跳出選項卡確認細節並點選（之後沒再改檔）→ gate 必須照舊擋 D，且不能洗掉已擋紀錄！
  writeFileSync(s.trFull, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: T(-300), content: '<USER_REQUEST>\n幫我改 a.js\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T(-100), tool_calls: [{ name: 'ask_question' }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: T(-100), content: `Created At: ${T(-100)}\nCompleted At: ${wholeSec(-30)}\nA1: 用方案甲` }),
  ].join('\n') + '\n');
  clearTranscriptCache();
  s.write([
    { ts: T(-200), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js'), step: 1, transcript: s.trFull },
  ]);
  s.touch('src/a.js', -200);
  const g1 = s.gate({ executionNum: 0 });
  check('改完程式後中途點選項卡、之後沒改檔 → 收工門禁仍鎖定 USER_INPUT 照樣擋 D', g1 !== null && g1.missing.includes('D'), JSON.stringify(g1));

  // 模擬 gate_blocked 發生在選項卡之前（step 0 後擋過 D，中途點選項卡，again=true 不應重擋同一 key）
  s.append([{ ts: T(-150), event: 'gate_blocked', session: 's1', level: 'T1', missing: ['D'], source: 'gate' }]);
  const g2 = s.gate({ executionNum: 1 });
  eq('again 時中途點選項卡不洗掉同一回合的 blocked（不重複擋 D）', g2, null);

  // specsOfRun 中途點選項卡不截斷 A 寫的規格檔
  const specEvents = [
    { ts: T(-300), hook: 'UserPrompt', session: 's1', cwd: '/w', step: 0, prompt: '/spec 新功能' },
    { ts: T(-250), hook: 'PostToolUse', session: 's1', cwd: '/w', tool: 'read_file', skill: `${PLUGIN}:spec`, step: 1 },
    { ts: T(-200), hook: 'UserPrompt', session: 's1', cwd: '/w', step: 3, prompt: '要做這個範圍', via: 'ask_question' },
    { ts: T(-150), hook: 'PostToolUse', session: 's1', cwd: '/w', tool: 'write_file', file: '/w/docs/規劃中/feat.md', step: 4 },
  ];
  const sv = sessionView(specEvents, STAGES, 's1', null, '/w').view;
  const aStage = sv.stages.find((x) => x.id === 'A');
  eq('A 寫規格中途彈選項卡詢問後才 write_file → 仍連結得到 docs/規劃中/feat.md', aStage?.specPlace?.name, 'feat');

  // 選項文字開頭含 /chaos-check 或 <weird-tag> 的防護
  const slashOpt = { ts: T(-50), hook: 'UserPrompt', session: 's1', cwd: '/w', step: 5, prompt: '/chaos-check 請跑', via: 'ask_question' };
  const runs = runsPerStage([slashOpt], STAGES, (e) => e.session === 's1');
  eq('選項文字以 /chaos-check 開頭 → typedRun 不算呼叫 D', (runs.get('D') ?? []).length, 0);

  const tagOpt = { ts: T(-50), hook: 'UserPrompt', session: 's1', cwd: '/w', step: 6, prompt: '<option>保留原狀', via: 'ask_question' };
  eq('選項文字以 <option> 開頭 → promptKind 仍為 human（不誤判 unknown）', promptKind(tagOpt), 'human');
  eq('選項卡回覆不進入 firstPromptsOf（不頂替開頭第一句話）', firstPromptsOf([tagOpt, slashOpt]).size, 0);

  const sess = sessionsOf([
    { ts: T(-60), hook: 'UserPrompt', session: 's2', cwd: '/w', step: 1, prompt: '照選項點', via: 'ask_question' },
    { ts: T(-50), hook: 'PostToolUse', session: 's2', cwd: '/w', tool: 'read_file', step: 2 },
  ]);
  eq('只有選項卡回覆沒有打字第一句時，不拿選項卡文字當對話標題', sess[0]?.title, null);
  eq('選項卡回覆照實更新 lastSaidAt', sess[0]?.lastSaidAt, T(-60));
  s.cleanup();
}

/* ════════════ 5. 開放四支決策技能、常駐規則與門禁提示（AC-4 / R2 / P10） ════════════ */

section('AC-4：四支決策技能、rules/AGENTS.md 與門禁提示同步開放 ask_question，E 驗收禁標 (Recommended)', 'P2');
{
  const chaos = readFileSync(join(ROOT, 'skills', 'chaos-check', 'SKILL.md'), 'utf8');
  const verify = readFileSync(join(ROOT, 'skills', 'verify', 'SKILL.md'), 'utf8');
  const tierSetup = readFileSync(join(ROOT, 'skills', 'tier-setup', 'SKILL.md'), 'utf8');
  const director = readFileSync(join(ROOT, 'skills', 'director', 'SKILL.md'), 'utf8');
  const rules = readFileSync(join(ROOT, 'rules', 'AGENTS.md'), 'utf8');

  for (const [name, txt] of [['chaos-check', chaos], ['verify', verify], ['tier-setup', tierSetup], ['director', director], ['rules/AGENTS.md', rules]]) {
    check(`${name} 不再禁止選項卡（移除 v0.1 禁令）`, !/v0\.1 尚未接上選項卡/.test(txt) && !/\*\*不要用選項卡\*\*/.test(txt));
    check(`${name} 開放使用 ask_question 並保留純文字相容`, txt.includes('ask_question') && /純文字/.test(txt));
  }
  check('verify/SKILL.md 綁死 E 選項卡三防線（互斥、禁標 (Recommended)、不併入照建議收尾）',
    verify.includes('嚴禁把「驗收過了」標成 `(Recommended)`') && verify.includes('拆成互斥選項') && verify.includes('照建議收尾'));
  check('rules/AGENTS.md 守住 E 選項卡禁標 (Recommended) 與互斥',
    rules.includes('嚴禁將「驗收過了」標成 `(Recommended)`') && rules.includes('不得與「不用再走」混在同一選項'));

  const reqD = pendingRequirements({
    requires: ['D', 'E'],
    stages: STAGES,
    view: [
      { id: 'D', name: '魔鬼教官', skill: 'chaos-check', rerunAfterChange: true, rerun: { state: 'ask', last: { call: { ts: T(-100) } }, concluded: { verdict: 'ok' } } },
      { id: 'E', name: '驗收', type: 'browser', skill: 'verify', rerunAfterChange: true, estate: 'ask', rerun: { state: 'ask', estate: 'ask', last: { call: { ts: T(-100) } } } },
    ],
    commandFor: (sk) => `/${sk}`,
    ago: () => '1 分鐘前',
  });
  check('lib/tier.mjs D:ask 提示允許 ask_question 選項卡（ZH）', /ask_question/.test(reqD[0]?.gateLine ?? ''));
  check('lib/tier.mjs E:ask 提示允許選項卡且禁標 (Recommended)（ZH）', /ask_question/.test(reqD[1]?.gateLine ?? '') && /\(Recommended\)/.test(reqD[1]?.gateLine ?? ''));
  const dangerZh = dangerAskLine({ since: { at: T(-100), how: 'checked' }, fresh: ['src/new.js'] }, { dangerId: 'T2', ago: () => '1 分鐘前' });
  check('dangerAskLine（ZH）允許選項卡', /ask_question/.test(dangerZh));

  const dangerEn = withLang('en', () => dangerAskLine({ since: { at: T(-100), how: 'checked' }, fresh: ['src/new.js'] }, { dangerId: 'T2', ago: () => '1 minute ago' }));
  check('dangerAskLine（EN）允許選項卡且零中文', /ask_question option card/.test(dangerEn) && !CJK.test(dangerEn), dangerEn);
}

process.exit(summary());
