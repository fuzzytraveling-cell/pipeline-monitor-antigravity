/**
 * sensor.test.mjs —— 感測器的三條命
 *   ① 絕不影響 Claude(AC-2)   ② 只記「跑過」(AC-3)   ③ 三種空狀態要分得開(AC-1/AC-7)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { readEvents, loadStages } from '../lib/events.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 把 payload 餵給 hook.sh,在自己的暫存 logs 資料夾裡跑,回傳 {stdout, code, lines} */
function runHook(payload) {
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-'));
  let code = 0, stdout = '';
  try {
    stdout = execFileSync('sh', [join(ROOT, 'hook.sh')], {
      input: JSON.stringify(payload), encoding: 'utf8',
      env: { ...process.env, PIPELINE_MONITOR_LOG_DIR: logDir },
    });
  } catch (e) {
    code = e.status ?? 1;
    stdout = e.stdout ?? '';
  }
  const lines = readdirSync(logDir)
    .flatMap((f) => readFileSync(join(logDir, f), 'utf8').split('\n'))
    .filter(Boolean);
  rmSync(logDir, { recursive: true, force: true });
  return { stdout, code, lines };
}

const SAMPLE = (over = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 's1', prompt_id: 'p1',
  tool_name: 'Skill', tool_use_id: 'tu1',
  tool_input: { skill: 'chaos-check', args: 'x'.repeat(5000) },
  tool_response: { success: true }, duration_ms: 8, ...over,
});

section('AC-2：感測器絕不影響 Claude');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const out = runHook(SAMPLE({ cwd: r.dir }));
  eq('離開碼永遠是 0', out.code, 0);
  eq('不准輸出任何東西到 stdout', out.stdout, '');
  const broken = runHook({ 完全不是預期的形狀: true });
  eq('餵它壞掉的 payload,離開碼還是 0', broken.code, 0);
  r.cleanup();
}

section('AC-3：只記「跑過」,不記「通過」');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const out = runHook(SAMPLE({ cwd: r.dir }));
  const rec = JSON.parse(out.lines[0]);
  eq('記到了指令名', rec.skill, 'chaos-check');
  check('沒有 success 欄位', !('success' in rec), JSON.stringify(rec).slice(0, 120));
  check('沒有 duration_ms 欄位', !('duration_ms' in rec));
  check('沒有 tool_response', !('tool_response' in rec));
  r.cleanup();
}

section('AC-4：單行必須遠小於 4096 bytes(否則同時寫會交錯)');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const out = runHook(SAMPLE({ cwd: r.dir }));   // args 是 5000 個字
  const bytes = Buffer.byteLength(out.lines[0]);
  check(`實測 ${bytes} bytes < 4096`, bytes < 4096, `args 沒有被截斷?`);
  check('args 有被截斷', JSON.parse(out.lines[0]).args.length <= 200);
  r.cleanup();
}

section('AC-1／AC-7：三種「看起來一樣」的空狀態必須分得開');
{
  const d = mkdtempSync(join(tmpdir(), 'pm-ev-'));
  eq('紀錄檔不存在 → no-file(還不知道)', readEvents(d, 'proj').state, 'no-file');
  writeFileSync(join(d, 'proj.jsonl'), '');
  eq('檔案存在但沒事件 → no-events(感測器可能壞了)', readEvents(d, 'proj').state, 'no-events');
  writeFileSync(join(d, 'proj.jsonl'), JSON.stringify({ ts: new Date().toISOString(), hook: 'X' }) + '\n');
  eq('有事件 → ok', readEvents(d, 'proj').state, 'ok');
  rmSync(d, { recursive: true, force: true });
}

section('AC-4：壞掉的一行不准害死其他幾千筆');
{
  const d = mkdtempSync(join(tmpdir(), 'pm-ev2-'));
  const good = JSON.stringify({ ts: new Date().toISOString(), hook: 'A' });
  writeFileSync(join(d, 'p.jsonl'), `${good}\n{這行是壞的\n${good}\n`);
  const r = readEvents(d, 'p');
  eq('壞行跳過,好的兩筆都讀得到', r.events.length, 2);
  rmSync(d, { recursive: true, force: true });
}

section('AC-5：超過保留期限的丟掉,但看不懂的時間要留著');
{
  const d = mkdtempSync(join(tmpdir(), 'pm-ev3-'));
  const old = new Date(Date.now() - 200 * 86400_000).toISOString();
  const now = new Date().toISOString();
  writeFileSync(join(d, 'p.jsonl'), [
    JSON.stringify({ ts: old, hook: '太舊' }),
    JSON.stringify({ ts: now, hook: '新的' }),
    JSON.stringify({ ts: '看不懂', hook: '時間壞掉' }),
  ].join('\n') + '\n');
  const r = readEvents(d, 'p');
  const kept = r.events.map((e) => e.hook);
  check('200 天前的被丟掉', !kept.includes('太舊'), kept.join(','));
  check('新的留著', kept.includes('新的'));
  check('⚠️ 時間看不懂的**留著**(不要因為看不懂就刪人家的資料)', kept.includes('時間壞掉'));
  rmSync(d, { recursive: true, force: true });
}

section('AC-6：關卡清單專案可以覆寫');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const base = loadStages(ROOT, r.dir);
  check('沒有覆寫時用內建的', base.stages.length > 0 && base.from.includes('stages.json'));
  mkdirSync(join(r.dir, '.claude'), { recursive: true });
  writeFileSync(join(r.dir, '.claude', 'pipeline-stages.json'),
    JSON.stringify({ stages: [{ id: '甲', name: '只有一關', skill: 'x' }] }));
  const over = loadStages(ROOT, r.dir);
  eq('專案有覆寫時,關卡數換成它的', over.stages.length, 1);
  eq('關卡代號也換了', over.stages[0].id, '甲');
  r.cleanup();
}

section('E3：記的是使用者說的話,不是系統塞在前面的說明');
{
  // 2026-09-11 實測:worktree 對話的第一則訊息被記成「<system-reminder>\nYou are operating in…」,
  // 使用者真正打的「測試pipeline-status」在 200 字之外,整個不見。
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const pre = '<system-reminder>\nYou are operating in a git worktree.\nWorktree path: /x\n</system-reminder>\n';
  const base = { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt_id: 'p1', cwd: r.dir };
  const out = runHook({ ...base, prompt: `${pre}測試pipeline-status` });
  eq('剝掉 system-reminder 之後才截 200 字', JSON.parse(out.lines[0]).prompt, '測試pipeline-status');
  const plain = runHook({ ...base, prompt: '沒有前綴的訊息' });
  eq('沒有前綴的照舊', JSON.parse(plain.lines[0]).prompt, '沒有前綴的訊息');
  r.cleanup();
}

section('D2：故障記號是警告,不是把整區蓋掉的理由');
{
  const d = mkdtempSync(join(tmpdir(), 'pm-ev4-'));
  writeFileSync(join(d, 'p.jsonl'), JSON.stringify({ ts: new Date().toISOString(), hook: 'A' }) + '\n');
  writeFileSync(join(d, '_sensor.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), event: 'sensor_broken', why: 'jq 不存在' }) + '\n{壞行\n');
  const r = readEvents(d, 'p');
  eq('有事件就是 ok,故障記號不會把它變成 no-events', r.state, 'ok');
  eq('故障記號兩筆(壞行也算一次故障)', r.broken.length, 2);
  check('故障記號被解析成物件,讀得到時間', typeof r.broken[0] === 'object' && !!r.broken[0].ts);
  rmSync(d, { recursive: true, force: true });
}

process.exit(summary());
