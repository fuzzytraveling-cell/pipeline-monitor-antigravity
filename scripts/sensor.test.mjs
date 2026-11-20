/**
 * sensor.test.mjs —— Antigravity 感測器（hook.sh + lib/events.mjs + lib/transcript.mjs + lib/rounds.mjs）
 *
 * 釘的是會安靜壞掉的契約：
 *   ① 絕不影響 Antigravity：永遠輸出 {} 且 exit 0（含壞 JSON、缺欄位、無 jq）
 *   ② 只記「跑過」，不記「通過」（絕不存 error / success / duration_ms）
 *   ③ 新舊工具名相容（read_file/write_file/edit_file/run_command/ask_question/send_message/invoke_subagent
 *      ＋ view_file/write_to_file/replace_file_content/multi_replace_file_content）、read_file 僅記已安裝 skill 檔、
 *      開發本 repo 的 skills/<name>/SKILL.md 不誤計、run_command 憑證去敏、單行 < 4096 bytes
 *   ④ lib/transcript.mjs 合併 USER_EXPLICIT/USER_INPUT、辨識 subagent（SYSTEM_MESSAGE 含 sender=）並歸屬 browser subagent
 *   ⑤ 90 天清理原子換檔不丟紀錄、五關自動結案、清單解析與長報告另存檔
 */
import { execFileSync } from 'node:child_process';
import {
  writeFileSync, mkdtempSync, readFileSync, rmSync, mkdirSync, readdirSync, existsSync,
  appendFileSync, chmodSync, utimesSync, statSync, openSync, writeSync, readSync, closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { readEvents, safeName, prepareSweep, finishSweep, drainSweep } from '../lib/events.mjs';
import { readTranscript, enrichWithTranscripts, loadEvents, clearTranscriptCache, unwrapUserRequest } from '../lib/transcript.mjs';
import {
  loadStages, sessionsOf, lastRunPerStage, runsPerStage, roundView, sessionView,
  suggestionsOf, perStageOfRound, isEditEvent, noRecordsWithin,
} from '../lib/rounds.mjs';
import { collectAll } from '../lib/collect.mjs';
import { parseChecklist } from '../lib/checklist.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const stagesOfSession = (...a) => sessionView(...a).view.stages;

/** 把 Antigravity PostToolUse payload 餵給 hook.sh，在暫存 logs 資料夾裡跑。 */
function runHook(payload, { keep = false } = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-'));
  let code = 0, stdout = '';
  try {
    stdout = execFileSync('sh', [join(ROOT, 'hook.sh')], {
      input: JSON.stringify(payload), encoding: 'utf8',
      env: { ...process.env, AGY_PIPELINE_LOG_DIR: logDir },
    });
  } catch (e) {
    code = e.status ?? 1;
    stdout = e.stdout ?? '';
  }
  const lines = readdirSync(logDir)
    .flatMap((f) => readFileSync(join(logDir, f), 'utf8').split('\n'))
    .filter(Boolean);
  if (!keep) rmSync(logDir, { recursive: true, force: true });
  return { stdout, code, lines, logDir };
}

const SAMPLE = (over = {}) => ({
  conversationId: 's1',
  stepIdx: 3,
  lastUserInput: '請幫我檢查這一段',
  toolCall: {
    id: 'tc1',
    name: 'read_file',
    args: { Path: '/Users/x/.gemini/config/plugins/agy-pipeline/skills/chaos-check/SKILL.md' },
  },
  error: null,
  ...over,
});

section('Antigravity PostToolUse 契約：永遠輸出 {} 且 exit 0，絕不影響對話');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const out = runHook(SAMPLE({ cwd: r.dir }));
  eq('離開碼永遠是 0', out.code, 0);
  eq('stdout 必須是 {}', out.stdout.trim(), '{}');
  const broken = runHook({ 完全不是預期的形狀: true });
  eq('餵它壞掉的 payload：離開碼還是 0、輸出 {}', `${broken.code}/${broken.stdout.trim()}`, '0/{}');
  eq('無 toolCall 不寫垃圾行', broken.lines.length, 0);
  r.cleanup();
}

section('只記「跑過」，不記「通過」（R2）；單行 < 4096 bytes');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const out = runHook(SAMPLE({
    cwd: r.dir,
    lastUserInput: '字'.repeat(5000),
    error: { message: 'boom' },
    toolCall: {
      id: 'tc-long',
      name: 'write_file',
      args: { Path: join(r.dir, 'a'.repeat(800) + '.js'), Content: 'x'.repeat(20000) },
    },
  }));
  eq('寫出一筆', out.lines.length, 1);
  const rec = JSON.parse(out.lines[0]);
  const bytes = Buffer.byteLength(out.lines[0]);
  check(`實測 ${bytes} bytes < 4096`, bytes < 4096, `bytes=${bytes}`);
  check('沒有 error／success／duration_ms／Content', !('error' in rec) && !('success' in rec) && !('duration_ms' in rec) && !('Content' in rec), Object.keys(rec).join(','));
  check('prompt 截成最多 200 字', rec.prompt.length <= 200, String(rec.prompt.length));
  r.cleanup();
}

section('真實工具與舊版別名：write/edit 記檔名、read_file 僅記已安裝 skill（忽略源碼與本 repo skills/）、run_command 去敏、ask_question/send_message/invoke_subagent 皆記', 'P2');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n' } });
  // 新舊寫檔/改檔工具與不同參數名
  const editTools = [
    ['write_file', { Path: join(r.dir, 'src/a.js') }],
    ['edit_file', { Path: join(r.dir, 'src/a.js') }],
    ['write_to_file', { TargetFile: join(r.dir, 'src/a.js') }],
    ['replace_file_content', { TargetFile: join(r.dir, 'src/a.js') }],
    ['multi_replace_file_content', { AbsolutePath: join(r.dir, 'src/a.js') }],
  ];
  for (const [name, args] of editTools) {
    const out = runHook({ conversationId: 's1', cwd: r.dir, toolCall: { id: 'tc', name, args } });
    const rec = JSON.parse(out.lines[0] ?? '{}');
    check(`${name} 記得到 file 且 isEditEvent 為 true`, rec.tool === name && rec.file === join(r.dir, 'src/a.js') && isEditEvent(rec), JSON.stringify(rec));
  }

  // read_file / view_file：一般檔案忽略；本 repo 開發中的 skills/*/SKILL.md 忽略；已安裝技能檔記為 skill 且不算 edit
  eq('read_file 一般源碼檔 → 不寫入（防灌爆紀錄）',
    runHook({ conversationId: 's1', cwd: r.dir, toolCall: { id: 'r1', name: 'read_file', args: { Path: join(r.dir, 'src/a.js') } } }).lines.length, 0);
  eq('view_file 本 repo 開發中的 skills/spec/SKILL.md → 不寫入（不誤計關卡）',
    runHook({ conversationId: 's1', cwd: r.dir, toolCall: { id: 'r2', name: 'view_file', args: { AbsolutePath: join(r.dir, 'skills/spec/SKILL.md') } } }).lines.length, 0);

  const skillPaths = [
    ['/Users/o/.gemini/config/plugins/agy-pipeline/skills/chaos-check/SKILL.md', 'agy-pipeline:chaos-check'],
    [join(r.dir, '.agents/skills/spec/SKILL.md'), 'spec'],
    [join(r.dir, '.claude/skills/cleanup/SKILL.md'), 'cleanup'],
    [join(r.dir, '.claude/commands/verify.md'), 'verify'],
  ];
  for (const [p, wantSkill] of skillPaths) {
    const out = runHook({ conversationId: 's1', cwd: r.dir, toolCall: { id: 'rs', name: 'read_file', args: { Path: p } } });
    const rec = JSON.parse(out.lines[0] ?? '{}');
    check(`read_file ${wantSkill} → 記到 skill=${wantSkill} 且不算 edit`, rec.skill === wantSkill && !isEditEvent(rec), JSON.stringify(rec));
  }

  // run_command 憑證去敏
  const cmdOut = runHook({
    conversationId: 's1', cwd: r.dir,
    toolCall: { id: 'rc', name: 'run_command', args: { CommandLine: 'curl -H "Authorization: Bearer sk-12345" https://u:p@api.example.com/v1 && SECRET_TOKEN=topsecret npm test' } },
  });
  const cmdRec = JSON.parse(cmdOut.lines[0]);
  check('run_command 遮掉 Bearer、URL 密碼、SECRET_TOKEN',
    !cmdRec.cmd.includes('sk-12345') && !cmdRec.cmd.includes('u:p@') && !cmdRec.cmd.includes('topsecret') && cmdRec.cmd.includes('[REDACTED]'), cmdRec.cmd);

  // ask_question / send_message / invoke_subagent 麵包屑
  const askRec = JSON.parse(runHook({ conversationId: 's1', cwd: r.dir, stepIdx: 12, toolCall: { id: 'aq', name: 'ask_question', args: {} } }).lines[0]);
  eq('ask_question 記 tool 與 step', `${askRec.tool}/${askRec.step}`, 'ask_question/12');
  const msgRec = JSON.parse(runHook({ conversationId: 's1', cwd: r.dir, stepIdx: 13, toolCall: { id: 'sm', name: 'send_message', args: {} } }).lines[0]);
  eq('send_message 記 tool 與 step', `${msgRec.tool}/${msgRec.step}`, 'send_message/13');
  const subRec = JSON.parse(runHook({ conversationId: 's1', cwd: r.dir, toolCall: { id: 'is', name: 'invoke_subagent', args: { TypeName: 'browser' } } }).lines[0]);
  eq('invoke_subagent 記 subagent_type', `${subRec.tool}/${subRec.subagent_type}`, 'invoke_subagent/browser');

  // 瀏覽器工具記 url_host，不記整個 query string
  const navRec = JSON.parse(runHook({ conversationId: 's1', cwd: r.dir, toolCall: { id: 'b1', name: 'browser_navigate', args: { Url: 'http://localhost:5173/lesson?token=abc#top' } } }).lines[0]);
  eq('瀏覽器工具只記 url_host', navRec.url_host, 'localhost:5173');
  const clickRec = JSON.parse(runHook({ conversationId: 's1', cwd: r.dir, toolCall: { id: 'b2', name: 'browser_click', args: { x: 10 } } }).lines[0]);
  check('沒有網址的瀏覽器動作照記', clickRec.tool === 'browser_click' && !('url_host' in clickRec));
  r.cleanup();
}

section('lib/transcript.mjs：合併 USER_EXPLICIT 人類發言、過濾 subagent、歸屬 browser subagent 回主對話', 'P6');
{
  clearTranscriptCache();
  const dir = mkdtempSync(join(tmpdir(), 'pm-tr-'));
  const mainTr = join(dir, 'main.jsonl');
  const subTr = join(dir, 'sub.jsonl');
  const t = (m) => new Date(Date.UTC(2026, 10, 20, 10, m)).toISOString();

  writeFileSync(mainTr, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: t(0), content: '請幫我做一個新按鈕' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: t(1), content: '好的' }),
    '{壞掉的一行不該炸掉整份',
    JSON.stringify({ step_index: 5, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: t(5), content: '驗收看起來可以，沒問題' }),
  ].join('\n') + '\n');
  writeFileSync(subTr, [
    JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: t(2), content: 'Subagent started sender=main-1 role=Browser' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: t(3), content: 'Opening page' }),
  ].join('\n') + '\n');

  const pMain = readTranscript(mainTr);
  check('主對話 transcript 解析出 2 則人類發言，不是 subagent', pMain.ok && !pMain.isSubagent && pMain.prompts.length === 2, JSON.stringify(pMain));
  const pSub = readTranscript(subTr);
  check('subagent transcript 辨識出 isSubagent=true 且 parentId=main-1', pSub.ok && pSub.isSubagent && pSub.parentId === 'main-1', JSON.stringify(pSub));
  eq('不存在的 transcript 回 { ok: false }', readTranscript(join(dir, 'nope.jsonl')).ok, false);

  const rawEvents = [
    { ts: t(1), hook: 'PostToolUse', session: 'main-1', cwd: '/proj', tool: 'edit_file', file: '/proj/src/a.js', transcript: mainTr },
    { ts: t(3), hook: 'PostToolUse', session: 'sub-1', cwd: '/proj', tool: 'browser_navigate', url_host: 'localhost:4325', transcript: subTr },
    { ts: t(4), hook: 'PostToolUse', session: 'sub-1', cwd: '/proj', tool: 'browser_click', transcript: subTr },
  ];
  const merged = enrichWithTranscripts(rawEvents);
  const humanPrompts = merged.filter((e) => e.hook === 'UserPrompt' && e.session === 'main-1');
  eq('合併進主對話的 2 則真實人類發言', humanPrompts.length, 2);
  eq('sessionsOf 只列主對話 main-1（不把 sub-1 當成獨立人類對話）', sessionsOf(merged).map((s) => s.id).join(','), 'main-1');
  eq('沒有顯式標題時以第一句人話作摘要', sessionsOf(merged)[0].title, '請幫我做一個新按鈕');

  // browser subagent 動作已歸屬回主對話 E 關
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const view = Object.fromEntries(stagesOfSession(merged, stages, 'main-1', null, '/proj').map((s) => [s.id, s]));
  eq('主對話 E 關看到 subagent 的 2 個瀏覽器動作（狀態為 seen）', `${view.E.state}/${view.E.count}`, 'seen/2');
  eq('主對話 E 關看得到瀏覽器去的主機', view.E.hosts.join(','), 'localhost:4325');

  // 感測器存活度不被 _fromTranscript 假造（R1）
  const mon = mkdtempSync(join(tmpdir(), 'pm-liveness-'));
  mkdirSync(join(mon, 'logs')); mkdirSync(join(mon, 'checkpoints'));
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const proj = basename(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: r.dir, encoding: 'utf8' }).trim());
  const logFile = join(mon, 'logs', `${safeName(proj)}.jsonl`);
  writeFileSync(logFile, '');   // 空紀錄檔：hook 沒寫過任何一筆
  const loaded = loadEvents(join(mon, 'logs'), proj, { extraTranscripts: { 'main-1': mainTr }, sessionId: 'main-1', cwd: r.dir });
  check('loadEvents 補入的 UserPrompt 標記 _fromTranscript=true（不偽裝成感測器活著）', loaded.events.every((e) => e._fromTranscript === true));

  rmSync(dir, { recursive: true, force: true });
  rmSync(mon, { recursive: true, force: true });
  r.cleanup();
}

section('同回合斜線指令＋讀取 SKILL.md 合併成一次呼叫（不重複計兩次）', 'P6');
{
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const t = (s) => new Date(Date.UTC(2026, 10, 20, 1, 0, s)).toISOString();
  const ev = [
    { ts: t(0), hook: 'UserPrompt', session: 's1', cwd: '/x', prompt: '/chaos-check' },
    { ts: t(2), hook: 'PostToolUse', session: 's1', cwd: '/x', tool: 'read_file', skill: 'agy-pipeline:chaos-check' },
    { ts: t(5), hook: 'PostToolUse', session: 's1', cwd: '/x', tool: 'read_file', skill: 'agy-pipeline:chaos-check' },
  ];
  const runs = runsPerStage(ev, stages, (e) => e.session === 's1');
  eq('同一回合打 /chaos-check ＋ 兩次讀 SKILL.md → 合併成 1 次 D', runs.get('D').length, 1);
  // 若中間有 stage_report（已結案），下一次再讀 SKILL.md 才算第二次
  const twoRounds = [
    ...ev,
    { ts: t(10), event: 'stage_report', stage: 'D', verdict: 'found', note: '找到 1 條', cwd: '/x', by_session: 's1', source: 'ai' },
    { ts: t(20), hook: 'PostToolUse', session: 's1', cwd: '/x', tool: 'read_file', skill: 'agy-pipeline:chaos-check' },
  ];
  eq('中間有 stage_report 分隔 → 兩次 D', runsPerStage(twoRounds, stages, (e) => e.session === 's1').get('D').length, 2);
}

section('三種「看起來一樣」的空狀態必須分得開；壞行跳過；超過 90 天清理但保留壞時間');
{
  const d = mkdtempSync(join(tmpdir(), 'pm-ev-'));
  eq('紀錄檔不存在 → no-file', readEvents(d, 'proj').state, 'no-file');
  writeFileSync(join(d, 'proj.jsonl'), '');
  eq('檔案存在但沒事件 → no-events', readEvents(d, 'proj').state, 'no-events');
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 200 * 86400_000).toISOString();
  writeFileSync(join(d, 'proj.jsonl'), [
    JSON.stringify({ ts: old, hook: '太舊' }),
    '{這行是壞的',
    JSON.stringify({ ts: now, hook: '新的' }),
    JSON.stringify({ ts: '看不懂', hook: '時間壞掉' }),
  ].join('\n') + '\n');
  const r = readEvents(d, 'proj');
  eq('有事件 → ok', r.state, 'ok');
  const kept = r.events.map((e) => e.hook);
  check('200 天前丟掉、新的與壞時間留著、壞行不害死整份', !kept.includes('太舊') && kept.includes('新的') && kept.includes('時間壞掉'), kept.join(','));
  rmSync(d, { recursive: true, force: true });
}

const DAY = 86400_000;

section('90 天清理（AC-1）：讀完之後、換上去之前別人寫進來的，一行都不准不見（真的跑 hook.sh）');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const logDir = mkdtempSync(join(tmpdir(), 'pm-sweep1-'));
  const name = basename(r.dir);
  const file = join(logDir, `${safeName(name)}.jsonl`);
  const now = Date.now();
  const ago = (days) => new Date(now - days * DAY).toISOString();
  writeFileSync(file, `${JSON.stringify({ ts: ago(100), hook: '太舊' })}\n${JSON.stringify({ ts: ago(1), hook: '留著' })}\n`);
  const p = prepareSweep(file, now);
  check('有過期的 → 暫存檔寫好了，原檔還沒動', p !== null && readFileSync(file, 'utf8').includes('太舊'));
  execFileSync('sh', [join(ROOT, 'hook.sh')], {
    input: JSON.stringify({ conversationId: '中間寫的-感測器', cwd: r.dir, toolCall: { id: 't1', name: 'edit_file', args: { Path: join(r.dir, 'a.js') } } }),
    env: { ...process.env, AGY_PIPELINE_LOG_DIR: logDir },
  });
  appendFileSync(file, `${JSON.stringify({ ts: new Date(now).toISOString(), event: 'stage_cleared', stage: 'E', source: 'human', session: '中間寫的-按鈕' })}\n`);
  eq('換上去之前再看一眼：檔案變長了 → 這次不清', finishSweep(p), false);
  const mid = readFileSync(file, 'utf8');
  check('感測器中間寫的那一行與按鈕那一行都在', mid.includes('中間寫的-感測器') && mid.includes('中間寫的-按鈕'), mid);
  eq('暫存檔收掉了', readdirSync(logDir).join(','), `${safeName(name)}.jsonl`);
  const back = readEvents(logDir, name);
  const after = readFileSync(file, 'utf8');
  check('沒人再寫 → 下一次讀照樣清掉過期的，中間寫的兩行都還在',
    !after.includes('太舊') && after.includes('中間寫的-感測器') && after.includes('中間寫的-按鈕') && after.includes('留著'), after);
  eq('讀出來三筆', back.events.length, 3);
  rmSync(logDir, { recursive: true, force: true }); r.cleanup();
}

section('90 天清理（AC-2～AC-5）：並發停手、滿一週才清、寫不進去不擋讀、保留原格式、換檔後補寫、清光不等一週');
{
  // AC-4 並發停手（長度湊成一樣也看得出 inode 換過）
  const d = mkdtempSync(join(tmpdir(), 'pm-sweep4-'));
  const file = join(d, 'p.jsonl');
  const now = Date.now();
  const old = JSON.stringify({ ts: new Date(now - 100 * DAY).toISOString(), hook: '太舊', pad: 'y'.repeat(200) });
  writeFileSync(file, `${old}\n${JSON.stringify({ ts: new Date(now - DAY).toISOString(), hook: '留著' })}\n`);
  const size0 = statSync(file).size;
  const p1 = prepareSweep(file, now);
  const p2 = prepareSweep(file, now);
  eq('第一個換上去', finishSweep(p1), true);
  const later = (pad) => JSON.stringify({ ts: new Date(now).toISOString(), event: 'stage_cleared', session: '後來寫的', pad });
  appendFileSync(file, `${later('z'.repeat(Buffer.byteLength(old) - Buffer.byteLength(later(''))))}\n`);
  eq('檔案長度故意湊一樣', statSync(file).size, size0);
  eq('第二個停手', finishSweep(p2), false);
  drainSweep(p1, { last: true });
  check('後來寫的還在', readFileSync(file, 'utf8').includes('後來寫的'));
  rmSync(d, { recursive: true, force: true });

  // AC-2 過期不滿一週只在記憶體濾；滿一週清到 90 天；全過期立即清
  const d2 = mkdtempSync(join(tmpdir(), 'pm-sweep2-'));
  const f2 = join(d2, 'p.jsonl');
  const ago = (days) => new Date(now - days * DAY).toISOString();
  const body = `${JSON.stringify({ ts: ago(93), hook: '過期三天' })}\n${JSON.stringify({ ts: ago(1), hook: '新的' })}\n`;
  writeFileSync(f2, body);
  const r1 = readEvents(d2, 'p');
  eq('不滿一週檔案不動', readFileSync(f2, 'utf8'), body);
  check('記憶體裡濾掉過期', !r1.events.some((e) => e.hook === '過期三天'));
  writeFileSync(f2, `${JSON.stringify({ ts: ago(98), hook: '過期八天' })}\n${body}`);
  readEvents(d2, 'p');
  check('滿一週一次清到 90 天', !readFileSync(f2, 'utf8').includes('過期八天') && !readFileSync(f2, 'utf8').includes('過期三天'));
  writeFileSync(f2, `${JSON.stringify({ ts: ago(92), hook: '全過期' })}\n`);
  readEvents(d2, 'p');
  eq('全過期不等一週直接清 → no-events', readEvents(d2, 'p').state, 'no-events');
  rmSync(d2, { recursive: true, force: true });

  // AC-3 暫存檔不變專案、兩小時前殘檔收掉
  const mon = mkdtempSync(join(tmpdir(), 'pm-sweep3-'));
  const ld = join(mon, 'logs');
  mkdirSync(ld);
  const f3 = join(ld, 'p.jsonl');
  writeFileSync(f3, `${JSON.stringify({ ts: ago(100), hook: '太舊' })}\n${JSON.stringify({ ts: ago(1), hook: '新的' })}\n`);
  chmodSync(ld, 0o555);
  let blocked = false;
  try { writeFileSync(join(ld, 'probe'), ''); } catch { blocked = true; }
  if (blocked) eq('唯讀資料夾不清但不擋讀', prepareSweep(f3, now), null);
  chmodSync(ld, 0o755);
  const killed = prepareSweep(f3, now);
  const busy = prepareSweep(f3, now);
  utimesSync(killed.tmp, (now - 2 * 3600_000) / 1000, (now - 2 * 3600_000) / 1000);
  const prev = { home: process.env.AGY_PIPELINE_HOME, log: process.env.AGY_PIPELINE_LOG_DIR };
  Object.assign(process.env, { AGY_PIPELINE_HOME: mon, AGY_PIPELINE_LOG_DIR: ld });
  const names = collectAll({ monitorDir: mon }).projects.map((x) => x.name);
  for (const [k, v] of [['AGY_PIPELINE_HOME', prev.home], ['AGY_PIPELINE_LOG_DIR', prev.log]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  eq('儀表板數專案：半成品不會變成一個專案', names.join(','), 'p');
  check('兩小時前殘檔收掉、剛寫的不動', !existsSync(killed.tmp) && existsSync(busy.tmp));
  for (const x of [killed, busy]) closeSync(x.fd);
  rmSync(mon, { recursive: true, force: true });

  // drainSweep 換檔後補寫
  const d6 = mkdtempSync(join(tmpdir(), 'pm-sweep6-'));
  const f6 = join(d6, 'p.jsonl');
  const b6 = `${JSON.stringify({ ts: ago(100), hook: '太舊' })}\n${JSON.stringify({ ts: ago(1), hook: '留著' })}\n`;
  writeFileSync(f6, b6);
  const ino0 = statSync(f6).ino;
  const before = openSync(f6, 'r');
  const late = openSync(f6, 'a');
  const p6 = prepareSweep(f6, now);
  eq('整份換掉', finishSweep(p6), true);
  writeSync(late, `${JSON.stringify({ ts: new Date(now).toISOString(), event: 'stage_cleared', session: '補進新檔' })}\n`);
  closeSync(late);
  drainSweep(p6, { last: true });
  const buf = Buffer.alloc(Buffer.byteLength(b6));
  readSync(before, buf, 0, buf.length, 0);
  closeSync(before);
  check('換檔後補進新檔且原檔未被原地修改', readFileSync(f6, 'utf8').includes('補進新檔') && buf.toString('utf8') === b6 && statSync(f6).ino !== ino0);
  rmSync(d6, { recursive: true, force: true });
}

section('專案關卡清單優先 .agents/pipeline-stages.json，相容 fallback .claude/pipeline-stages.json');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const base = loadStages(ROOT, r.dir);
  check('沒有覆寫時用內建的 stages.json', base.stages.length > 0 && base.from.includes('stages.json'));
  mkdirSync(join(r.dir, '.claude'), { recursive: true });
  writeFileSync(join(r.dir, '.claude', 'pipeline-stages.json'), JSON.stringify({ stages: [{ id: '舊', name: '相容舊檔', skill: 'x' }] }));
  eq('只有 .claude/pipeline-stages.json 時 fallback 讀到', loadStages(ROOT, r.dir).stages[0].id, '舊');
  mkdirSync(join(r.dir, '.agents'), { recursive: true });
  writeFileSync(join(r.dir, '.agents', 'pipeline-stages.json'), JSON.stringify({ stages: [{ id: '新', name: '優先新檔', skill: 'y' }] }));
  eq('兩者都在時優先讀 .agents/pipeline-stages.json', loadStages(ROOT, r.dir).stages[0].id, '新');
  r.cleanup();
}

section('C1：專案名有空白和中文，hook.sh 寫的檔名跟 safeName() 一致', 'P2');
{
  const parent = mkdtempSync(join(tmpdir(), 'pm-c1-'));
  const name = 'My App 規劃中';
  const dir = join(parent, name);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const out = runHook({ conversationId: 's1', cwd: dir, toolCall: { id: 't1', name: 'edit_file', args: { Path: join(dir, 'a.js') } } }, { keep: true });
  eq('hook 寫出的檔名 = safeName(專案名) + .jsonl', readdirSync(out.logDir)[0], `${safeName(name)}.jsonl`);
  eq('讀取端拿原名找得到', readEvents(out.logDir, name).state, 'ok');
  eq('中文一個字換成 3 個底線', safeName('中'), '___');
  rmSync(out.logDir, { recursive: true, force: true }); rmSync(parent, { recursive: true, force: true });
}

section('退出記號：.agents/pipeline-monitor.off 與相容 .claude/pipeline-monitor.off 皆馬上生效');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  for (const dirName of ['.agents', '.claude']) {
    mkdirSync(join(r.dir, dirName), { recursive: true });
    const marker = join(r.dir, dirName, 'pipeline-monitor.off');
    writeFileSync(marker, '{}');
    const res = runHook(SAMPLE({ cwd: r.dir }));
    eq(`${dirName}/pipeline-monitor.off → 不記任何一行且回 {}`, `${res.lines.length}/${res.code}/${res.stdout.trim()}`, '0/0/{}');
    mkdirSync(join(r.dir, 'sub'), { recursive: true });
    eq(`從子資料夾呼叫也看得到 ${dirName} 記號`, runHook(SAMPLE({ cwd: join(r.dir, 'sub') })).lines.length, 0);
    rmSync(marker);
    eq(`拿掉 ${dirName} 記號 → 下一筆馬上記`, runHook(SAMPLE({ cwd: r.dir })).lines.length, 1);
  }
  r.cleanup();
}

section('根目錄 hooks.json 裡的指令 sh ./hook.sh 真的跑得起來');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-'));
  const cmd = JSON.parse(readFileSync(join(ROOT, 'hooks.json'), 'utf8'))['agy-pipeline-sensor'].PostToolUse[0].hooks[0].command;
  const out = execFileSync('sh', ['-c', cmd], {
    cwd: ROOT,
    input: JSON.stringify({ conversationId: 's1', cwd: r.dir, toolCall: { id: 't1', name: 'edit_file', args: { Path: join(r.dir, 'a.js') } } }),
    env: { ...process.env, AGY_PIPELINE_LOG_DIR: logDir },
    encoding: 'utf8',
  });
  eq('輸出 {} 且寫出一筆紀錄', `${out.trim()}/${readdirSync(logDir).length}`, '{}/1');
  rmSync(logDir, { recursive: true, force: true }); r.cleanup();
}

section('結案／取消結案：最後一筆說了算；斜線指令與 plugin 前綴（agy-pipeline:spec）都認');
{
  const base = Date.now();
  const t = (n) => new Date(base + n * 1000).toISOString();
  const ev = (o) => ({ session: 's1', cwd: '/x', ...o });
  const reopened = sessionsOf([ev({ ts: t(0), hook: 'UserPrompt', prompt: 'hi' }), ev({ ts: t(1), event: 'session_closed' }), ev({ ts: t(2), event: 'session_reopened' })]);
  eq('取消結案 → closedAt 清掉', reopened[0].closedAt, null);
  const active = sessionsOf([ev({ ts: t(0), hook: 'UserPrompt', prompt: 'hi' }), ev({ ts: t(1), event: 'session_closed' }), ev({ ts: t(2), hook: 'PostToolUse', tool: 'edit_file' })]);
  check('結案後又有動作 → 算回進行中', active[0].closedAt === null && active[0].reopenedByActivity === t(2));

  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  eq('agy-pipeline:spec 算 A', lastRunPerStage([{ ts: t(0), hook: 'PostToolUse', tool: 'read_file', skill: 'agy-pipeline:spec', session: 's1', cwd: '/x' }], stages, '/x').perStage.get('A')?.skill, 'agy-pipeline:spec');
  eq('respec 不算 A', lastRunPerStage([{ ts: t(0), hook: 'PostToolUse', tool: 'read_file', skill: 'respec', session: 's1', cwd: '/x' }], stages, '/x').perStage.get('A'), null);
  eq('斜線指令 /agy-pipeline:spec 算 typed', runsPerStage([{ ts: t(0), hook: 'UserPrompt', session: 's1', cwd: '/x', prompt: '/agy-pipeline:spec 寫規格' }], stages, () => true).get('A')[0]?.via, 'typed');
}

section('建議卡（--suggest）：寫入、不做了、有新對話照開頭開就算已開始');
{
  const ev = [
    { ts: '2026-11-15T01:00:00Z', event: 'suggestion', id: 'sg-1', title: '做 v0.2', prompt: '在 agy-pipeline 裡接上 v0.2 主動式工作站功能，先讀 AGENTS.md 與規格再動手', cwd: '/x', source: 'ai' },
    { ts: '2026-11-15T01:00:00Z', event: 'suggestion', id: 'sg-2', title: '另一件', prompt: '別的事', cwd: '/x', source: 'ai' },
    { ts: '2026-11-15T02:00:00Z', event: 'suggestion_dismissed', id: 'sg-2', source: 'human' },
    { ts: '2026-11-15T03:00:00Z', hook: 'UserPrompt', session: 'new1', cwd: '/x', prompt: '在 agy-pipeline 裡接上 v0.2 主動式工作站功能，先讀 AGENTS.md 與規格再動手（開頭一樣）' },
  ];
  const sg = Object.fromEntries(suggestionsOf(ev).map((s) => [s.id, s]));
  eq('第一張：對話照開頭開 → 已開始', sg['sg-1'].startedBy, 'new1');
  check('第二張：不做了', !!sg['sg-2'].dismissedAt && sg['sg-2'].startedBy === null);
}

section('五關自動結案、清單解析與 --report（含相容舊紀錄 source:claude 與長報告另存檔）');
{
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const T = (h) => new Date(Date.UTC(2026, 10, 16, h)).toISOString();
  const by = (arr) => Object.fromEntries(arr.map((s) => [s.id, s]));
  const dir = mkdtempSync(join(tmpdir(), 'pm-spec-'));
  mkdirSync(join(dir, 'docs', '規劃中'), { recursive: true });
  const spec = join(dir, 'docs', '規劃中', 'y.md');
  const write = (marks) => writeFileSync(spec, `# 功能：y\n\n## 驗收條件\n**AC-1　第一條**${marks[0]}\n> **白話**：一句白話\n**AC-2　第二條**${marks[1]}\n`);
  write(['', '']);
  const ev = [
    { ts: T(1), hook: 'UserPrompt', session: 's1', cwd: dir, prompt: '/spec 做 y' },
    { ts: T(1), hook: 'PostToolUse', tool: 'write_file', session: 's1', cwd: dir, file: spec },
    { ts: T(2), hook: 'PostToolUse', tool: 'edit_file', session: 's1', cwd: dir, file: join(dir, 'src', 'a.js') },
    { ts: T(3), hook: 'PostToolUse', tool: 'read_file', skill: 'agy-pipeline:chaos-check', session: 's1', cwd: dir },
    { ts: T(4), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', cwd: dir, source: 'ai' },
  ];
  let v = by(stagesOfSession(ev, stages, 's1', null, dir));
  eq('A 帶著 2 條清單，B 未對完為 stale，D 結案且 doneBy=ai', `${v.A.checklist?.total}/${v.B.state}/${v.D.state}/${v.D.doneBy}`, '2/stale/done/ai');
  write([' ✅ 對過 2026-11-20', ' ✅ 對過 2026-11-20']);
  v = by(stagesOfSession([...ev, { ts: T(5), hook: 'PostToolUse', tool: 'edit_file', session: 's1', cwd: dir, file: spec }], stages, 's1', null, dir));
  eq('全部 ✅：B 結案（checklist）、D 變 passed', `${v.B.state}/${v.B.closedBy}/${v.D.state}`, 'done/checklist/passed');
  // 舊紀錄 source:'claude' 一樣認得出 AI 結論
  const legacyRep = by(stagesOfSession([...ev.slice(0, 4), { ts: T(4), event: 'stage_report', stage: 'D', verdict: 'ok', note: '舊版記的', cwd: dir, source: 'claude' }], stages, 's1', null, dir));
  eq('相容舊紀錄 source:claude → doneBy=ai', legacyRep.D.doneBy, 'ai');
  // fence 裡的範例不算 AC
  const fenced = parseChecklist('# 功能\n```markdown\n**AC-1　<範例>**\n```\n**AC-1　真的**\n> **白話**：真的白話\n');
  eq('fence 裡的假 AC 不算', `${fenced.total}/${fenced.items[0].title}`, '1/真的');
  // perStageOfRound 只看這一輪
  const two = runsPerStage([
    { ts: T(1), hook: 'PostToolUse', tool: 'read_file', skill: 'chaos-check', session: 's1', cwd: '/x' },
    { ts: T(2), hook: 'UserPrompt', session: 's1', cwd: '/x', prompt: '/spec 第二輪' },
  ], stages, () => true);
  const ps = perStageOfRound(roundView({ runs: two, stages, cleared: new Map() }));
  check('上一輪的 D 不在這一輪的 perStageOfRound 裡', !ps.has('D') && ps.get('A')?.ts === T(2));
  rmSync(dir, { recursive: true, force: true });

  // --report 寫入 source:'ai' 且長報告另存檔保持單行 < 4096 bytes
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-'));
  const lines = ['建議 40 條'].concat(Array.from({ length: 40 }, (_, i) => `- src/檔案${i}.js:${i + 1} —— 這一段看起來多餘，但要人判斷才知道能不能拿掉`));
  execFileSync('node', [join(ROOT, 'status.mjs'), '--report', 'C', 'ok', lines.join('\n')], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, AGY_PIPELINE_LOG_DIR: logDir } });
  const f = readdirSync(logDir).find((x) => x.endsWith('.jsonl'));
  const raw = readFileSync(join(logDir, f), 'utf8').trim().split('\n').find((l) => l.includes('stage_report'));
  check('長報告那一行 < 4096 bytes', Buffer.byteLength(raw, 'utf8') < 4096);
  const rep = JSON.parse(raw);
  check('source 為 ai 且另存 noteFile', rep.source === 'ai' && typeof rep.noteFile === 'string' && existsSync(rep.noteFile), JSON.stringify(rep));
  const vLong = by(stagesOfSession([{ ts: new Date(Date.now() - 60000).toISOString(), hook: 'PostToolUse', tool: 'read_file', skill: 'cleanup', session: 's1', cwd: r.dir }, { ...rep, cwd: r.dir }], stages, 's1', null, r.dir));
  eq('讀回來 41 行一條不少', vLong.C.report?.note.split('\n').length, 41);
  rmSync(rep.noteFile);
  const vMiss = by(stagesOfSession([{ ts: new Date(Date.now() - 60000).toISOString(), hook: 'PostToolUse', tool: 'read_file', skill: 'cleanup', session: 's1', cwd: r.dir }, { ...rep, cwd: r.dir }], stages, 's1', null, r.dir));
  check('noteFile 不見了 → 講完整清單找不到', /完整清單找不到/.test(vMiss.C.report?.note ?? ''));
  rmSync(logDir, { recursive: true, force: true }); r.cleanup();
}

section('D2：故障記號不覆蓋有效紀錄');
{
  const d = mkdtempSync(join(tmpdir(), 'pm-ev4-'));
  writeFileSync(join(d, 'p.jsonl'), JSON.stringify({ ts: new Date().toISOString(), hook: 'PostToolUse' }) + '\n');
  writeFileSync(join(d, '_sensor.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'sensor_broken', why: 'jq 不存在' }) + '\n{壞行\n');
  const r = readEvents(d, 'p');
  eq('有事件就是 ok，故障記號 2 筆', `${r.state}/${r.broken.length}`, 'ok/2');
  rmSync(d, { recursive: true, force: true });
}

section('實機回歸：transcript 拆 <USER_REQUEST> 外框、webview_browser 抽主機並歸屬回主對話 E 關');
{
  // 1. unwrapUserRequest 拆掉 Antigravity 真實 USER_INPUT 外框，不動一般字與其他系統 XML
  eq('完整 <USER_REQUEST>＋<ADDITIONAL_METADATA>',
    unwrapUserRequest('<USER_REQUEST>\n不用再跑了\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-20.\n</ADDITIONAL_METADATA>'),
    '不用再跑了');
  eq('精簡版截斷（沒收尾標籤）也能拆',
    unwrapUserRequest('<USER_REQUEST>\n接手開發任務…'),
    '接手開發任務…');
  eq('純文字原樣保留', unwrapUserRequest('好，開工'), '好，開工');
  eq('其他系統標籤原樣保留（交給後續系統訊息過濾）', unwrapUserRequest('<system-reminder>hi</system-reminder>'), '<system-reminder>hi</system-reminder>');

  // 2. hook.sh 認得 Antigravity 內建 browser subagent 工具 webview_browser，抽 url_host 且去帳密
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const logDir = mkdtempSync(join(tmpdir(), 'pm-wv-'));
  const tDir = mkdtempSync(join(tmpdir(), 'pm-wvt-'));
  const subTp = join(tDir, 'sub.jsonl');
  const mainTp = join(tDir, 'main.jsonl');
  writeFileSync(mainTp, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-20T05:30:00Z', content: '<USER_REQUEST>\n驗收一下\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>' }),
  ].join('\n') + '\n');
  writeFileSync(subTp, [
    JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: '2026-11-20T05:33:51Z', content: '[Message] sender=main-wv content=inspect' }),
  ].join('\n') + '\n');
  const out = execFileSync('sh', [join(ROOT, 'hook.sh')], {
    input: JSON.stringify({
      conversationId: 'sub-wv', cwd: r.dir, stepIdx: 2, transcriptPath: subTp, lastUserInput: '',
      toolCall: { id: 'wv1', name: 'webview_browser', args: { intention: 'Check dashboard', script: "await page.goto('http://user:pw@127.0.0.1:4320/api', { waitUntil: 'domcontentloaded' });" } },
    }),
    env: { ...process.env, AGY_PIPELINE_LOG_DIR: logDir },
    encoding: 'utf8',
  });
  eq('hook.sh 處理 webview_browser 永遠回 {}', out.trim(), '{}');
  const raw = readEvents(logDir, basename(r.dir));
  eq('hook.sh 記下 webview_browser 且抽出純主機（去帳密）', raw.events[0]?.tool, 'webview_browser');
  eq('url_host 去帳密後為 127.0.0.1:4320', raw.events[0]?.url_host, '127.0.0.1:4320');

  clearTranscriptCache();
  const merged = enrichWithTranscripts([
    { ts: '2026-11-20T05:30:05Z', hook: 'PostToolUse', session: 'main-wv', cwd: r.dir, tool: 'invoke_subagent', subagent_type: 'browser', transcript: mainTp },
    ...raw.events,
  ]);
  const humanMsg = merged.find((e) => e.hook === 'UserPrompt' && e.session === 'main-wv');
  eq('拆框後的人話不帶 <USER_REQUEST>', humanMsg?.prompt, '驗收一下');
  const attr = merged.find((e) => e.session === 'main-wv' && e.tool === 'webview_browser' && e._fromSubagent === 'sub-wv');
  check('subagent 的 webview_browser 歸屬回主對話並帶 url_host', attr?.url_host === '127.0.0.1:4320', JSON.stringify(attr));
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const runs = runsPerStage(merged, stages, (e) => e.session === 'main-wv');
  check('主對話的 E 關看得到 webview_browser 動作', (runs.get('E') ?? []).some((x) => x.tool === 'webview_browser'));
  rmSync(logDir, { recursive: true, force: true });
  rmSync(tDir, { recursive: true, force: true });
  r.cleanup();
}

section('魔鬼教官第一輪回歸：coalesceRuns 保留 head、_fromTranscript 不遮蔽空紀錄、空 cwd 退回 workspacePaths、換 worktree 貼對 cwd', 'P6');
{
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const t = (s) => new Date(Date.UTC(2026, 10, 20, 6, 0, s)).toISOString();

  // 1. coalesceRuns 合併無 head 的 typed（轉錄檔）＋有 head 的 SKILL.md（PostToolUse）→ 保留 head
  const mergedRuns = runsPerStage([
    { ts: t(0), hook: 'UserPrompt', session: 's1', cwd: '/w', prompt: '/chaos-check', _fromTranscript: true },
    { ts: t(2), hook: 'PostToolUse', session: 's1', cwd: '/w', tool: 'read_file', skill: 'agy-pipeline:chaos-check', head: 'abc1234' },
  ], stages, (e) => e.session === 's1');
  eq('合併同回合 typed＋SKILL.md 仍保留 1 筆且承接 head', `${mergedRuns.get('D').length}/${mergedRuns.get('D')[0]?.head}`, '1/abc1234');

  // 2. _fromTranscript 不遮蔽 noRecordsWithin 與 sawAnyEventHere（R1/P5/P2）
  const synthOnly = [{ ts: t(0), hook: 'UserPrompt', session: 's1', cwd: '/w', prompt: 'hi', _fromTranscript: true }];
  eq('空紀錄檔補入 _fromTranscript 後仍為 noRecordsWithin', noRecordsWithin({ state: 'no-events', events: synthOnly }), true);
  eq('本 worktree 僅有 _fromTranscript → sawAnyEventHere 仍為 false', lastRunPerStage(synthOnly, stages, '/w').sawAnyEventHere, false);

  // 3. hook.sh 收到空字串 cwd="" 且 workspacePaths[0] 有值 → 退回 workspacePaths[0]（不寫進外掛目錄）
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const logDir = mkdtempSync(join(tmpdir(), 'pm-emptycwd-'));
  execFileSync('sh', [join(ROOT, 'hook.sh')], {
    cwd: ROOT,
    input: JSON.stringify({
      conversationId: 'c-empty-cwd', cwd: '', workspacePaths: [r.dir],
      toolCall: { id: 'e1', name: 'edit_file', args: { Path: join(r.dir, 'a.js') } },
    }),
    env: { ...process.env, AGY_PIPELINE_LOG_DIR: logDir },
  });
  const got = readEvents(logDir, basename(r.dir));
  eq('空 cwd 退回 workspacePaths[0] 寫到正確專案且帶正確 cwd', `${got.events.length}/${got.events[0]?.cwd}`, `1/${r.dir}`);
  rmSync(logDir, { recursive: true, force: true });
  r.cleanup();

  // 4. 對話中途從主資料夾換到 worktree → 每個轉錄檔 UserPrompt 配對該時刻所在資料夾
  const tDir = mkdtempSync(join(tmpdir(), 'pm-wtcwd-'));
  const tp = join(tDir, 'tr.jsonl');
  writeFileSync(tp, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: t(0), content: '<USER_REQUEST>\n先在主資料夾看\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: t(20), content: '<USER_REQUEST>\n/chaos-check\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 4, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: t(40), content: '<USER_REQUEST>\n收到\n</USER_REQUEST>' }),
  ].join('\n') + '\n');
  clearTranscriptCache();
  const moved = enrichWithTranscripts([
    { ts: t(5), hook: 'PostToolUse', session: 's-mv', cwd: '/proj', tool: 'run_command', cmd: 'ls', transcript: tp },
    { ts: t(25), hook: 'PostToolUse', session: 's-mv', cwd: '/proj/.wt', tool: 'edit_file', file: '/proj/.wt/a.js', transcript: tp },
  ]);
  const ps = moved.filter((e) => e.hook === 'UserPrompt' && e.session === 's-mv');
  eq('第一句在主資料夾、第二句切進 worktree、第三句留在 worktree',
    ps.map((p) => `${p.prompt}@${p.cwd}`).join('|'),
    '先在主資料夾看@/proj|/chaos-check@/proj/.wt|收到@/proj/.wt');
  eq('sessionsOf 最後所在仍是 worktree（不被最後一句拉回主資料夾）', sessionsOf(moved).find((s) => s.id === 's-mv')?.cwd, '/proj/.wt');
  rmSync(tDir, { recursive: true, force: true });
}

process.exit(summary());
