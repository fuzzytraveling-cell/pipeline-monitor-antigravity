/**
 * sensor.test.mjs —— 感測器的三條命
 *   ① 絕不影響 Claude(AC-2)   ② 只記「跑過」(AC-3)   ③ 三種空狀態要分得開(AC-1/AC-7)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, rmSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { readEvents, loadStages, safeName, sessionsOf, lastRunPerStage, runsPerStage, roundView, stagesOfSession, suggestionsOf, perStageOfRound } from '../lib/events.mjs';
import { parseChecklist } from '../lib/checklist.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 把 payload 餵給 hook.sh,在自己的暫存 logs 資料夾裡跑,回傳 {stdout, code, lines, logDir}。
 *  keep=true 時不刪暫存資料夾(呼叫端要自己看檔名),用完自己 rm。 */
function runHook(payload, { keep = false } = {}) {
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
  if (!keep) rmSync(logDir, { recursive: true, force: true });
  return { stdout, code, lines, logDir };
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

section('C1：專案名有空白和中文,hook 寫的檔名跟讀取端找的要一樣（真的跑 hook.sh）', 'P2');
{
  // hook.sh 用 tr 把不安全字元換成 _(逐位元組);讀取端以前拿原名去找 → 永遠「還沒有紀錄」。
  // 這條測試是 sh 跟 node 兩邊唯一的共識來源:改任何一邊,這裡會紅。
  const parent = mkdtempSync(join(tmpdir(), 'pm-c1-'));
  const name = 'TutorPod AI 規劃中';
  const dir = join(parent, name);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const out = runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt_id: 'p1', cwd: dir, prompt: 'hi' },
                      { keep: true });
  const written = readdirSync(out.logDir);
  eq('hook 寫出的檔名 = safeName(專案名) + .jsonl', written[0], `${safeName(name)}.jsonl`);
  const r = readEvents(out.logDir, name);
  eq('讀取端拿原名去找,找得到(不是 no-file)', r.state, 'ok');
  eq('而且就是那一筆', r.events.length, 1);
  eq('中文一個字換成 3 個底線(逐位元組,跟 LC_ALL=C 的 tr 一樣)', safeName('中'), '___');
  rmSync(out.logDir, { recursive: true, force: true }); rmSync(parent, { recursive: true, force: true });
}

section('結案／取消結案：最後一筆說了算');
{
  // 2026-09-11 Oscar:按了「取消結案」沒有恢復。伺服器有寫 session_reopened,讀取端沒認。
  // ⚠️ 「現在」只取一次(L18):每次呼叫都問 Date.now() 的話,造事件的 t(2) 跟斷言的 t(2) 隔著幾毫秒,
  //    機器一忙就對不起來——整套 npm test 跑到這裡偶爾紅,單獨跑永遠綠。
  const base = Date.now();
  const t = (n) => new Date(base + n * 1000).toISOString();
  const ev = (o) => ({ session: 's1', cwd: '/x', ...o });
  const closedOnly = sessionsOf([ev({ ts: t(0), hook: 'UserPromptSubmit' }), ev({ ts: t(1), event: 'session_closed' })]);
  check('結案 → closedAt 有值', !!closedOnly[0].closedAt);
  const reopened = sessionsOf([
    ev({ ts: t(0), hook: 'UserPromptSubmit' }), ev({ ts: t(1), event: 'session_closed' }), ev({ ts: t(2), event: 'session_reopened' }),
  ]);
  eq('取消結案 → closedAt 清掉', reopened[0].closedAt, null);
  const again = sessionsOf([
    ev({ ts: t(0), hook: 'UserPromptSubmit' }), ev({ ts: t(1), event: 'session_closed' }),
    ev({ ts: t(2), event: 'session_reopened' }), ev({ ts: t(3), event: 'session_closed' }),
  ]);
  check('再結案一次 → 又是結案', !!again[0].closedAt);
  // 結案之後對話又有動作 → 自動算回進行中,而且標明是這樣來的;按鈕本身不算「最後動作」
  const active = sessionsOf([
    ev({ ts: t(0), hook: 'UserPromptSubmit' }), ev({ ts: t(1), event: 'session_closed' }), ev({ ts: t(2), hook: 'PostToolUse', tool: 'Edit' }),
  ]);
  check('結案後又有感測器紀錄 → closedAt 清掉、reopenedByActivity 有值', active[0].closedAt === null && active[0].reopenedByActivity === t(2));
  const btn = sessionsOf([ev({ ts: t(0), hook: 'UserPromptSubmit' }), ev({ ts: t(9), event: 'session_reopened' })]);
  eq('按「取消結案」不算最後動作(lastTs 還是對話最後一筆)', btn[0].lastTs, t(0));
}

section('plugin 帶的 skill 名字有前綴(pipeline-monitor:spec),同一關兩種名字都要認');
{
  const stages = [{ id: 'A', name: '寫規格', skill: 'spec' }];
  const ev = [
    { ts: '2026-09-15T01:00:00Z', hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', session: 's1', cwd: '/x' },
  ];
  eq('pipeline-monitor:spec 算 A', lastRunPerStage(ev, stages, '/x').perStage.get('A')?.skill, 'pipeline-monitor:spec');
  eq('respec 不算 A(只認冒號前綴,不認任何尾巴)', lastRunPerStage([{ ...ev[0], skill: 'respec' }], stages, '/x').perStage.get('A'), null);
}

section('退出記號：專案根目錄有 .claude/pipeline-monitor.off 就一筆都不記,而且馬上生效');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  mkdirSync(join(r.dir, '.claude'), { recursive: true });
  writeFileSync(join(r.dir, '.claude', 'pipeline-monitor.off'), '{}');
  eq('有記號 → 沒有任何一行', runHook(SAMPLE({ cwd: r.dir })).lines.length, 0);
  eq('有記號 → 離開碼還是 0(AC-2 不變)', runHook(SAMPLE({ cwd: r.dir })).code, 0);
  mkdirSync(join(r.dir, 'src'));
  eq('從子資料夾呼叫也看得到根目錄的記號', runHook(SAMPLE({ cwd: join(r.dir, 'src') })).lines.length, 0);
  rmSync(join(r.dir, '.claude', 'pipeline-monitor.off'));
  eq('拿掉記號 → 下一筆馬上記(不用開新對話)', runHook(SAMPLE({ cwd: r.dir })).lines.length, 1);
  r.cleanup();
}

section('plugin 的呼叫方式：hooks.json 裡那一行 sh "${CLAUDE_PLUGIN_ROOT}/hook.sh" 真的跑得起來');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-'));
  const cmd = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command;
  execFileSync('sh', ['-c', cmd], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt_id: 'p1', cwd: r.dir, prompt: 'hi' }),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, PIPELINE_MONITOR_LOG_DIR: logDir },
  });
  eq('用 hooks.json 裡的指令呼叫,寫出一筆', readdirSync(logDir).length, 1);
  rmSync(logDir, { recursive: true, force: true }); r.cleanup();
}

section('瀏覽器工具記主機名(url_host),不記整個網址;沒有網址也不會吃掉整筆');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const nav = runHook(SAMPLE({ cwd: r.dir, tool_name: 'mcp__Claude_Browser__navigate', tool_input: { url: 'http://localhost:5173/lesson?x=1#a' } }));
  eq('只記主機名', JSON.parse(nav.lines[0]).url_host, 'localhost:5173');
  const click = runHook(SAMPLE({ cwd: r.dir, tool_name: 'mcp__Claude_Browser__computer', tool_input: { action: 'left_click' } }));
  check('沒有網址的動作照樣記到一整筆', click.lines.length === 1 && !('url_host' in JSON.parse(click.lines[0])));
  r.cleanup();
}

section('E 驗收：認瀏覽器工具的事件,講「開瀏覽器跑過一輪（N 個動作）」,不講通過');
{
  const stages = [{ id: 'E', name: '驗收', type: 'browser', tools: '^mcp__(Claude_Browser|claude-in-chrome)__' }];
  const t = (n) => new Date(Date.now() + n * 1000).toISOString();
  const ev = [
    { ts: t(0), hook: 'PreToolUse', tool: 'mcp__Claude_Browser__navigate', session: 's1', cwd: '/x' },
    { ts: t(1), hook: 'PreToolUse', tool: 'mcp__Claude_Browser__computer', session: 's1', cwd: '/x' },
    { ts: t(2), hook: 'PreToolUse', tool: 'Bash', session: 's1', cwd: '/x' },
    { ts: t(3), hook: 'PreToolUse', tool: 'mcp__claude-in-chrome__computer', session: 's1', cwd: '/x' },
  ];
  const run = lastRunPerStage(ev, stages, '/x').perStage.get('E');
  check('最後一筆是瀏覽器動作', run?.tool === 'mcp__claude-in-chrome__computer', JSON.stringify(run));
  eq('這一輪 3 個動作(Bash 不算)', run?.count, 3);
  eq('對話層也算得出動作數', stagesOfSession(ev, stages, 's1')[0].count, 3);
  check('沒有任何欄位叫 passed／success(R2:感測器無從得知)', run && !('passed' in run) && !('success' in run));
}

section('L17：hook.sh 從 worktree 被呼叫,紀錄還是寫進主資料夾', 'P3');
{
  // 沒設 PIPELINE_MONITOR_LOG_DIR 時 hook.sh 寫到 <自己所在 repo 的主資料夾>/logs。做一個假的 repo 放一份 hook.sh 副本,
  // 從它的 worktree 裡呼叫,紀錄要出現在主資料夾。
  const repo = makeRepo({ files: { 'a.txt': '1\n' } });
  const main = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo.dir, encoding: 'utf8' }).trim();
  execFileSync('cp', [join(ROOT, 'hook.sh'), join(main, 'hook.sh')]);
  execFileSync('git', ['add', '-A'], { cwd: main, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'hook'], { cwd: main, stdio: 'ignore' });
  const wtParent = mkdtempSync(join(tmpdir(), 'pm-wt-'));
  const wt = join(wtParent, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'side'], { cwd: main, stdio: 'ignore' });
  const target = makeRepo({ files: { 'b.js': '1\n' } });
  const env = { ...process.env }; delete env.PIPELINE_MONITOR_LOG_DIR;
  execFileSync('sh', [join(wt, 'hook.sh')], { input: JSON.stringify(SAMPLE({ cwd: target.dir })), env, encoding: 'utf8' });
  check('紀錄寫在主資料夾的 logs/', readdirSync(join(main, 'logs')).length === 1, '主資料夾的 logs/ 是空的');
  check('worktree 裡沒有 logs/', !existsSync(join(wt, 'logs')));
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: main, stdio: 'ignore' });
  rmSync(wtParent, { recursive: true, force: true }); repo.cleanup(); target.cleanup();
}

section('開過瀏覽器 ≠ 驗收過:E 只算「看過」,不亮、不算走到;人說驗收過了才算');
{
  const stages = [{ id: 'A', name: '寫規格', skill: 'spec' }, { id: 'D', name: '魔鬼教官', skill: 'chaos-check' },
                  { id: 'E', name: '驗收', type: 'browser', tools: '^mcp__Claude_Browser__' }];
  const t = (n) => new Date(Date.UTC(2026, 8, 15, n)).toISOString();
  const ev = [
    { ts: t(1), hook: 'PreToolUse', tool: 'Skill', skill: 'spec', session: 's1', cwd: '/x' },
    { ts: t(2), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1', cwd: '/x' },
    { ts: t(3), hook: 'PreToolUse', tool: 'mcp__Claude_Browser__navigate', url_host: '127.0.0.1:4319', session: 's1', cwd: '/x' },
    { ts: t(3), hook: 'PreToolUse', tool: 'mcp__Claude_Browser__computer', session: 's1', cwd: '/x' },
  ];
  const by = (arr) => Object.fromEntries(arr.map((s) => [s.id, s]));
  const v1 = by(stagesOfSession(ev, stages, 's1'));
  eq('開過瀏覽器 → seen,不是 current', v1.E.state, 'seen');
  eq('D 還是現在這一關(瀏覽器不算走到)', v1.D.state, 'current');
  check('講得出去了哪', v1.E.hosts.length === 1 && v1.E.hosts[0] === '127.0.0.1:4319', JSON.stringify(v1.E.hosts));
  const v2 = by(stagesOfSession([...ev, { ts: t(4), event: 'stage_cleared', stage: 'E', session: 's1', cwd: '/x', source: 'human' }], stages, 's1'));
  eq('人說驗收過了 → E done', v2.E.state, 'done');
  eq('這時 D 才變成已走過', v2.D.state, 'passed');
  // CLI 的 --clear 沒有對話代號,只有 cwd:對話頁也要認同工作區的結案
  const v3 = by(stagesOfSession([...ev, { ts: t(4), event: 'stage_cleared', stage: 'E', cwd: '/x', source: 'human' }], stages, 's1', null, '/x'));
  eq('工作區層級的結案,對話頁也認 → E done', v3.E.state, 'done');
}

section('建議新增的對話:寫進紀錄、不做了、對話真的這樣開頭就算已開始');
{
  const ev = [
    { ts: '2026-09-15T01:00:00Z', event: 'suggestion', id: 'sg-1', title: '做三關', prompt: '在 pipeline-monitor 裡把 A／C／D 做成 plugin 的 skill,先讀 CLAUDE.md', cwd: '/x', source: 'claude' },
    { ts: '2026-09-15T01:00:00Z', event: 'suggestion', id: 'sg-2', title: '另一件', prompt: '別的事', cwd: '/x', source: 'claude' },
    { ts: '2026-09-15T02:00:00Z', event: 'suggestion_dismissed', id: 'sg-2', source: 'human' },
    { ts: '2026-09-15T03:00:00Z', hook: 'UserPromptSubmit', session: 'new1', cwd: '/x', prompt: '在 pipeline-monitor 裡把 A／C／D 做成 plugin 的 skill,先讀 CLAUDE.md（開頭一樣,後面被截掉了' },
  ];
  const sg = Object.fromEntries(suggestionsOf(ev).map((s) => [s.id, s]));
  eq('第一張:對話真的這樣開頭 → 已開始', sg['sg-1'].startedBy, 'new1');
  check('第二張:不做了', !!sg['sg-2'].dismissedAt && sg['sg-2'].startedBy === null);
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

section('你自己打的斜線指令不經過 Skill 工具:訊息開頭是 /spec 或 /pipeline-monitor:spec 也算被叫(L19)');
{
  // 2026-09-15 Forma Pro 第一次真的叫 /pipeline-monitor:spec:規格寫出來了,Skill 事件零筆,儀表板 A 卻「這一輪還沒跑」。
  // 打了不等於跑起來(Unknown command 那次感測器一樣只看到你打了),所以 via 要分開,文案才講得出「你叫了」。
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const T = (h) => new Date(Date.UTC(2026, 8, 15, h)).toISOString();
  const say = (h, prompt) => ({ ts: T(h), hook: 'UserPromptSubmit', session: 's1', cwd: '/x', prompt });
  const ev = [
    say(1, '/pipeline-monitor:spec 把清單變短'),
    say(2, '你跑過 /spec 了嗎'),                 // 提到,不是叫
    say(3, '/specs 是什麼'),                      // 名字沒整個對上
    { ts: T(4), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1', cwd: '/x' },
    say(5, '  /cleanup'),
  ];
  const runs = runsPerStage(ev, stages, (e) => e.cwd === '/x');
  eq('A:只有第一句算(提到的、名字沒對上的都不算)', runs.get('A').length, 1);
  eq('A:記的是打的那個名字', runs.get('A')[0].skill, 'pipeline-monitor:spec');
  eq('A:指令後面的字當 args', runs.get('A')[0].args, '把清單變短');
  eq('A:證據種類是 typed', runs.get('A')[0].via, 'typed');
  eq('D:Skill 工具那條路還在,證據種類是 skill', runs.get('D')[0].via, 'skill');
  eq('C:前面有空白也認,沒有 args', runs.get('C')[0].args, null);
  const by = Object.fromEntries(roundView({ runs, stages, cleared: new Map() }).stages.map((s) => [s.id, s]));
  eq('這一輪:C 是現在這一關', by.C.state, 'current');
  eq('A 已走過,而且帶著它是怎麼被叫的', `${by.A.state}/${by.A.via}/${by.A.calledAs}`, 'passed/typed/pipeline-monitor:spec');
  eq('lastRunPerStage 走同一種認法(老毛病 P2)', lastRunPerStage(ev, stages, '/x').perStage.get('A')?.via, 'typed');
}

section('五關自動結案:B 改到程式檔就亮、A 在第一次改程式檔之後算你點頭開工(AC-3、AC-4)');
{
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const T = (h) => new Date(Date.UTC(2026, 8, 16, h)).toISOString();
  const by = (arr) => Object.fromEntries(arr.map((s) => [s.id, s]));
  const ev = [
    { ts: T(1), hook: 'UserPromptSubmit', session: 's1', cwd: '/x', prompt: '/spec 做東西' },
    { ts: T(1), hook: 'PostToolUse', tool: 'Write', session: 's1', cwd: '/x', file: '/x/docs/規劃中/y.md' },   // A 自己寫的規格檔:不算開工
  ];
  let v = by(stagesOfSession(ev, stages, 's1'));
  eq('A 寫完規格檔:A 還是現在這一關(規格檔不是程式檔)', v.A.state, 'current');
  eq('B 還沒改程式檔:就是你在講話的那個對話', v.B.state, 'main');
  ev.push({ ts: T(2), hook: 'PostToolUse', tool: 'Edit', session: 's1', cwd: '/x', file: '/x/src/a.js' });
  v = by(stagesOfSession(ev, stages, 's1'));
  eq('改了程式檔:B 現在這一關', v.B.state, 'current');
  eq('A 已走過,而且是「你點頭開工」', `${v.A.state}/${v.A.closedBy}`, 'passed/nod');
  eq('A 的點頭時間 = 第一次改程式檔', v.A.nodAt, T(2));
  ev.push({ ts: T(3), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1', cwd: '/x' });
  v = by(stagesOfSession(ev, stages, 's1'));
  eq('D 跑了:D 現在、B 已走過(後面的關開始了)', `${v.D.state}/${v.B.state}/${v.B.closedBy}`, 'current/passed/next');
  ev.push({ ts: T(4), hook: 'PostToolUse', tool: 'Edit', session: 's1', cwd: '/x', file: '/x/src/a.js' });
  v = by(stagesOfSession(ev, stages, 's1'));
  eq('D 之後又改了程式檔:B 又是現在、D 的結論過期(要再跑一次,不劃掉)', `${v.B.state}/${v.D.state}`, 'current/stale');
  // 有分級設定時「程式檔」照程式區判:README 不在程式區 → 不算 B 在動、A 也不算開工
  const isCode = (f) => /\/src\//.test(f);
  const v2 = by(stagesOfSession([ev[0], { ts: T(2), hook: 'PostToolUse', tool: 'Edit', session: 's1', cwd: '/x', file: '/x/README.md' }], stages, 's1', null, null, { isCode }));
  eq('改 README(不在程式區)→ B 不亮、A 不算開工', `${v2.B.state}/${v2.A.state}`, 'main/current');
}

section('五關自動結案:Claude 記的結論決定 C／D 結案(AC-7、8),之後又改了程式檔就過期(AC-9),每個勾都說得出誰說的(AC-11)');
{
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const T = (h) => new Date(Date.UTC(2026, 8, 16, h)).toISOString();
  const by = (arr) => Object.fromEntries(arr.map((s) => [s.id, s]));
  const base = [
    { ts: T(1), hook: 'UserPromptSubmit', session: 's1', cwd: '/x', prompt: '/spec 做東西' },
    { ts: T(2), hook: 'PostToolUse', tool: 'Edit', session: 's1', cwd: '/x', file: '/x/src/a.js' },
    { ts: T(3), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1', cwd: '/x' },
  ];
  let v = by(stagesOfSession(base, stages, 's1', null, '/x'));
  eq('D 跑了、還沒記結論 → 現在這一關,沒有 doneAt', `${v.D.state}/${v.D.doneAt}`, 'current/null');
  // 結論是按工作區記的(CLI 沒有對話代號),所以 cwd 對得上就認
  const found = [...base, { ts: T(4), event: 'stage_report', stage: 'D', verdict: 'found', note: '找到 2 條', cwd: '/x', source: 'claude' }];
  v = by(stagesOfSession(found, stages, 's1', null, '/x'));
  eq('Claude 說找到問題 → 還是現在這一關,帶著結論', `${v.D.state}/${v.D.report?.verdict}/${v.D.report?.note}`, 'current/found/找到 2 條');
  const fixed = [...found, { ts: T(5), hook: 'PostToolUse', tool: 'Edit', session: 's1', cwd: '/x', file: '/x/src/a.js' }];
  v = by(stagesOfSession(fixed, stages, 's1', null, '/x'));
  eq('修了程式 → D 過期(要再跑),B 現在', `${v.D.state}/${v.B.state}`, 'stale/current');
  const again = [...fixed,
    { ts: T(6), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1', cwd: '/x' },
    { ts: T(7), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', cwd: '/x', source: 'claude' }];
  v = by(stagesOfSession(again, stages, 's1', null, '/x'));
  eq('再跑一次、Claude 說沒找到 → D 結案,是 Claude 說的', `${v.D.state}/${v.closedBy ?? v.D.closedBy}/${v.D.doneAt}`, 'done/claude/' + T(7));
  eq('B 已走過(後面的關結案了)', v.B.state, 'passed');
  const cOnly = [...base.slice(0, 2),
    { ts: T(3), hook: 'PreToolUse', tool: 'Skill', skill: 'cleanup', session: 's1', cwd: '/x' },
    { ts: T(4), event: 'stage_report', stage: 'C', verdict: 'ok', note: '列了 5 條建議', cwd: '/x', source: 'claude' },
    { ts: T(5), hook: 'PostToolUse', tool: 'Edit', session: 's1', cwd: '/x', file: '/x/src/a.js' }];
  v = by(stagesOfSession(cOnly, stages, 's1', null, '/x'));
  eq('C 列了建議就結案;之後改檔不會讓 C 過期(沒標 rerunAfterChange)', `${v.C.state}/${v.C.closedBy}`, 'passed/claude');
  // 上一次跑之前的舊結論不算這一次的
  const oldRep = [...base.slice(0, 2), { ts: T(2), event: 'stage_report', stage: 'D', verdict: 'ok', cwd: '/x', source: 'claude' }, base[2]];
  v = by(stagesOfSession(oldRep, stages, 's1', null, '/x'));
  eq('結論比這次跑還早 → 不算', `${v.D.state}/${v.D.report}`, 'current/null');
  // 舊紀錄裡人按的「處理完了」還是認,而且說是你說的
  const human = [...base, { ts: T(4), event: 'stage_cleared', stage: 'D', cwd: '/x', source: 'human' }];
  v = by(stagesOfSession(human, stages, 's1', null, '/x'));
  eq('人說處理完了(舊紀錄)→ done,是你說的', `${v.D.state}/${v.D.closedBy}`, 'done/human');
}

section('--report:Claude 把結論記給儀表板;只認指令關、只有 ok／found 兩種');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-'));
  const run = (...args) => {
    try { return { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PIPELINE_MONITOR_LOG_DIR: logDir } }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout ?? '') }; }
  };
  const ok = run('--report', 'D', 'found', '找到', '3', '條');
  check('D found → 記下,而且說是 Claude 說的', ok.code === 0 && ok.out.includes('Claude 說') && ok.out.includes('找到 3 條'), ok.out);
  const files = readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
  const ev = readFileSync(join(logDir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.event === 'stage_report');
  check('紀錄:stage_report、verdict found、note、source claude', ev?.stage === 'D' && ev?.verdict === 'found' && ev?.note === '找到 3 條' && ev?.source === 'claude', JSON.stringify(ev));
  eq('B(對話本身)沒有結論可記 → 失敗', run('--report', 'B', 'ok').code, 1);
  eq('結論不是 ok／found → 失敗', run('--report', 'D', 'maybe').code, 1);
  eq('認不出的關 → 失敗', run('--report', 'Z', 'ok').code, 1);
  rmSync(logDir, { recursive: true, force: true }); r.cleanup();
}

section('五關自動結案:A 的清單就是規格檔裡的 AC(AC-5),B 對完清單才結案、有沒對的不劃掉(AC-6)');
{
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const T = (h) => new Date(Date.UTC(2026, 8, 16, h)).toISOString();
  const by = (arr) => Object.fromEntries(arr.map((s) => [s.id, s]));
  const dir = mkdtempSync(join(tmpdir(), 'pm-spec-'));
  mkdirSync(join(dir, 'docs', '規劃中'), { recursive: true });
  const spec = join(dir, 'docs', '規劃中', 'y.md');
  const write = (marks) => writeFileSync(spec, `# 功能：y\n\n## 驗收條件\n**AC-1　第一條**${marks[0]}\n> **白話**：一句白話\n**AC-2　第二條**${marks[1]}\n**AC-3　第三條**${marks[2]}\n`);
  write(['', '', '']);
  const ev = [
    { ts: T(1), hook: 'UserPromptSubmit', session: 's1', cwd: dir, prompt_id: 'p1', prompt: '/spec 做 y' },
    { ts: T(1), hook: 'PostToolUse', tool: 'Write', session: 's1', cwd: dir, prompt_id: 'p1', file: spec },
    { ts: T(2), hook: 'PostToolUse', tool: 'Edit', session: 's1', cwd: dir, prompt_id: 'p2', file: join(dir, 'src', 'a.js') },
  ];
  let v = by(stagesOfSession(ev, stages, 's1', null, dir));
  check('A 帶著清單:三條、都還沒對、白話那句有讀到', v.A.checklist?.parsed && v.A.checklist.total === 3 && v.A.checklist.unmarked === 3 && v.A.checklist.items[0].plain === '一句白話', JSON.stringify(v.A.checklist));
  eq('B 改了程式、清單沒對:現在這一關,帶著進度', `${v.B.state}/${v.B.checklist?.unmarked}`, 'current/3');
  const withD = [...ev, { ts: T(3), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1', cwd: dir }];
  v = by(stagesOfSession(withD, stages, 's1', null, dir));
  eq('D 跑了、清單還沒對:B 不劃掉(要處理的樣子),D 現在', `${v.B.state}/${v.D.state}`, 'stale/current');
  write([' ✅ 對過 2026-09-16', ' ⏳ 待討論：不確定要不要', ' ✅ 對過 2026-09-16']);
  const marked = [...withD, { ts: T(4), hook: 'PostToolUse', tool: 'Edit', session: 's1', cwd: dir, prompt_id: 'p3', file: spec }];
  v = by(stagesOfSession(marked, stages, 's1', null, dir));
  check('有一條待討論:B 還是不算寫完,進度講得出 2/3、1 條待討論', v.B.state === 'stale' && v.B.checklist.checked === 2 && v.B.checklist.pending === 1, JSON.stringify(v.B.checklist));
  eq('待討論的原因帶在清單上', v.A.checklist.items[1].note, '不確定要不要');
  write([' ✅ 對過 2026-09-16', ' ✅ 對過 2026-09-16', ' ✅ 對過 2026-09-16']);
  const all = [...withD, { ts: T(5), hook: 'PostToolUse', tool: 'Edit', session: 's1', cwd: dir, prompt_id: 'p3', file: spec }];
  v = by(stagesOfSession(all, stages, 's1', null, dir));
  eq('全部 ✅:B 結案,是 Claude 對完清單,時間 = 最後一次改規格檔', `${v.B.state}/${v.B.closedBy}/${v.B.doneAt}`, `done/checklist/${T(5)}`);
  eq('D 變成已走過', v.D.state, 'passed');
  // 找不到規格檔:照實說
  const gone = ev.map((e) => (e.file === spec ? { ...e, file: join(dir, 'docs', '規劃中', '沒有.md') } : e));
  v = by(stagesOfSession(gone, stages, 's1', null, dir));
  check('規格檔不見了 → 清單說找不到,不當成沒有清單', v.A.checklist?.missing === true, JSON.stringify(v.A.checklist));
  // 規格檔沒照格式:解析不了就說解析不了
  writeFileSync(spec, '# 隨便寫的\n沒有 AC\n');
  v = by(stagesOfSession(ev, stages, 's1', null, dir));
  check('沒有 AC → parsed=false,給開頭幾行', v.A.checklist?.parsed === false && /隨便寫的/.test(v.A.checklist?.head ?? ''), JSON.stringify(v.A.checklist));
  eq('沒有可用的清單 → B 照舊規則(改了程式就是現在)', v.B.state, 'current');
  rmSync(dir, { recursive: true, force: true });
}

section('魔鬼教官 2026-09-16 抓到的:B 要認 git 說的改動(Bash 寫檔感測器看不到,L8)、清單跳過 fence 裡的範例、分級看這一輪');
{
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const T = (h) => new Date(Date.UTC(2026, 8, 16, h)).toISOString();
  const by = (v) => Object.fromEntries(v.stages.map((s) => [s.id, s]));
  const runs = runsPerStage([{ ts: T(1), hook: 'UserPromptSubmit', session: 's1', cwd: '/x', prompt: '/spec 做東西' }], stages, () => true);
  // 感測器一筆改檔都沒有,但 git 說 src/a.js 改過(修改時間在 A 之後)
  const v = by(roundView({ runs, stages, cleared: new Map(), gitChanges: [{ file: 'src/a.js', mtime: T(2) }] }));
  eq('B 亮,而且說是 git 說的', `${v.B.state}/${v.B.via}/${v.B.ranAt}`, `current/git/${T(2)}`);
  eq('A 也算你點頭開工了(第一個比 A 晚的修改時間)', `${v.A.state}/${v.A.closedBy}/${v.A.nodAt}`, `passed/nod/${T(2)}`);
  const old = by(roundView({ runs, stages, cleared: new Map(), gitChanges: [{ file: 'src/a.js', mtime: T(0) }] }));
  eq('git 的改動比這一輪還早 → 不算這一輪的', `${old.B.state}/${old.A.state}`, 'main/current');
  // 兩種證據都有:取較晚的,via 說是感測器
  const both = by(roundView({ runs, stages, cleared: new Map(), gitChanges: [{ file: 'src/a.js', mtime: T(3) }],
    edits: [{ ts: T(2), hook: 'PostToolUse', file: '/x/src/a.js' }] }));
  eq('感測器跟 git 都有 → 最後一次改檔取較晚的、via 是 hook', `${both.B.via}/${both.B.ranAt}`, `hook/${T(3)}`);
  // 清單:fence 裡的範例不算
  const fenced = parseChecklist('# 功能\n```markdown\n**AC-1　<一句話>**\n> **白話**：<…>\n```\n**AC-1　真的第一條**\n> **白話**：真的白話\n');
  eq('fence 裡的假 AC 不算,只有真的那一條', `${fenced.total}/${fenced.items[0].title}/${fenced.items[0].plain}`, '1/真的第一條/真的白話');
  // 分級的「需要」看這一輪:perStageOfRound 只有這一輪跑過的關
  const two = runsPerStage([
    { ts: T(1), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1', cwd: '/x' },
    { ts: T(2), hook: 'UserPromptSubmit', session: 's1', cwd: '/x', prompt: '/spec 第二輪' },
  ], stages, () => true);
  const ps = perStageOfRound(roundView({ runs: two, stages, cleared: new Map() }));
  check('上一輪的 D 不在這一輪的清單裡;這一輪的 A 在', !ps.has('D') && ps.get('A')?.ts === T(2), JSON.stringify([...ps]));
}

section('用 Bash 寫的規格檔:A 收尾 --report A ok "<路徑>" 指路,儀表板照樣找得到清單;說明放得下整張清單');
{
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const T = (h) => new Date(Date.UTC(2026, 8, 16, h)).toISOString();
  const by = (arr) => Object.fromEntries(arr.map((s) => [s.id, s]));
  const dir = mkdtempSync(join(tmpdir(), 'pm-spec-'));
  mkdirSync(join(dir, 'docs', '規劃中'), { recursive: true });
  writeFileSync(join(dir, 'docs', '規劃中', 'z.md'), '# 功能：z\n**AC-1　一** ✅ 對過 2026-09-16\n**AC-2　二**\n');
  // 沒有任何 Write 事件(Bash 寫的),只有 A 的 report 指路(相對路徑,cwd 是那筆紀錄的)
  const ev = [
    { ts: T(1), hook: 'UserPromptSubmit', session: 's1', cwd: dir, prompt_id: 'p1', prompt: '/spec 做 z' },
    { ts: T(1), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/規劃中/z.md', cwd: dir, source: 'claude' },
  ];
  const v = by(stagesOfSession(ev, stages, 's1', null, dir));
  check('A 的清單來自 report 指的那份檔案:2 條、1 對過', v.A.checklist?.parsed && v.A.checklist.total === 2 && v.A.checklist.checked === 1, JSON.stringify(v.A.checklist));
  // report 比 A 早(上一輪的)不算
  const stale = by(stagesOfSession([{ ...ev[1], ts: T(0) }, ev[0]], stages, 's1', null, dir));
  eq('比這次 A 還早的 report 不算', stale.A.checklist, null);
  rmSync(dir, { recursive: true, force: true });

  // --report 的說明:多行清單原封不動記下來
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-'));
  const note = '列了 2 條建議\n- lib/x.mjs:10 —— 白話一句\n- lib/y.mjs:20 —— 白話另一句';
  execFileSync('node', [join(ROOT, 'status.mjs'), '--report', 'C', 'ok', note], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PIPELINE_MONITOR_LOG_DIR: logDir } });
  const f = readdirSync(logDir).find((x) => x.endsWith('.jsonl'));
  const rep = readFileSync(join(logDir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.event === 'stage_report');
  eq('多行說明原封不動', rep?.note, note);
  rmSync(logDir, { recursive: true, force: true }); r.cleanup();
}

process.exit(summary());
