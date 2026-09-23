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
import { readEvents, loadStages, safeName, sessionsOf, lastRunPerStage, runsPerStage, roundView, stagesOfSession, suggestionsOf, firstPromptsOf, perStageOfRound, SUGGEST_TOOL, WITHDRAW_TOOL } from '../lib/events.mjs';
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

section('E3：記的是使用者說的話,不是系統塞在前面的說明', 'P7');
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

/** Claude 在 app 的對話裡叫「建議新開對話」的卡時,Claude Code 餵給 PreToolUse hook 的東西(形狀照真的對話紀錄裡的呼叫)。 */
const CARD_PROMPT = '在這個專案裡,把 README 最上面的徽章換成新的網址。先讀 CLAUDE.md,改完跑 npm test,不要動別的檔案。\n\n背景:舊網址上個月就失效了。';
// 代號用真的長度(對話與 prompt 是 UUID、工具呼叫是 toolu_ 加 24 個字):整行的空間是跟這些沒截的舊欄位一起分的,
// 用短代號量出來的行長會比真的少一百多 bytes,AC-4 那條就量不準
const SRC = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CARD = (over = {}, input = {}) => ({
  hook_event_name: 'PreToolUse', session_id: SRC, prompt_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', permission_mode: 'default', transcript_path: '/x/t.jsonl',
  tool_name: SUGGEST_TOOL, tool_use_id: 'toolu_01CardCardCardCardCardCa',
  tool_input: { title: '修 README 的徽章', tldr: '剛剛看到徽章指到舊的網址。新對話會把它換掉。', prompt: CARD_PROMPT, ...input },
  ...over,
});

section('app 建議卡(AC-1、AC-6):Claude 在 app 裡叫建議卡,感測器記一行、讀取端當成一張卡,而且照舊不影響對話（真的跑 hook.sh）', 'P6');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const out = runHook(CARD({ cwd: r.dir }), { keep: true });
  eq('離開碼 0', out.code, 0);
  eq('不輸出任何東西', out.stdout, '');
  eq('記了一行', out.lines.length, 1);
  const rec = JSON.parse(out.lines[0]);
  eq('標題記到了', rec.in_title, '修 README 的徽章');
  eq('一句說明記到了', rec.in_tldr, '剛剛看到徽章指到舊的網址。新對話會把它換掉。');
  eq('要貼的話整段記到了(含換行)', rec.in_prompt, CARD_PROMPT);
  check('沒被截的卡沒有 in_cut', !('in_cut' in rec), JSON.stringify(rec.in_cut));
  // 撞名:title／prompt 這兩個欄位已經是「對話標題」跟「使用者說的話」,卡的內容寫進去的話對話會被改名
  check('沒有寫進 title／prompt 這兩個欄位', !('title' in rec) && !('prompt' in rec), Object.keys(rec).join(','));
  const named = sessionsOf([{ ts: rec.ts, hook: 'UserPromptSubmit', session: SRC, cwd: r.dir, prompt: 'hi', title: '原本的對話標題' }, rec]);
  eq('對話不會被改名成卡的標題', named[0].title, '原本的對話標題');
  check('沒有 success／tool_response(感測器 AC-3 不變)', !('success' in rec) && !('tool_response' in rec));
  // 讀取端:從紀錄檔讀回來就是一張卡
  const back = readEvents(out.logDir, r.dir.split('/').pop());
  eq('紀錄檔讀得回來', back.events.length, 1);
  const cards = suggestionsOf(back.events);
  eq('一張卡', cards.length, 1);
  eq('代號用感測器記的 use_id', cards[0].id, 'toolu_01CardCardCardCardCardCa');
  eq('來源標 app(AC-5)', cards[0].source, 'app');
  eq('標題、說明、要貼的話都在', `${cards[0].title}|${cards[0].tldr}|${cards[0].prompt === CARD_PROMPT}`, '修 README 的徽章|剛剛看到徽章指到舊的網址。新對話會把它換掉。|true');
  eq('知道是哪個對話提的', cards[0].session, SRC);
  // 要開在別的資料夾的卡(真的卡有一半是這種):記下來,畫面才講得出「要開在哪」
  const away = JSON.parse(runHook(CARD({ cwd: r.dir }, { cwd: '/somewhere/other-repo' })).lines[0]);
  eq('卡指定的資料夾記在 in_cwd', away.in_cwd, '/somewhere/other-repo');
  eq('對話自己的 cwd 不受影響', away.cwd, r.dir);
  eq('讀取端:target 是卡要開的地方', suggestionsOf([away])[0].target, '/somewhere/other-repo');
  // 一次對話跳好幾張:每張一行、各自有代號,不合併
  const three = ['toolu_a', 'toolu_b', 'toolu_c'].flatMap((id) => runHook(CARD({ cwd: r.dir, tool_use_id: id })).lines).map((l) => JSON.parse(l));
  eq('三張卡 → 三張,不合併', suggestionsOf(three).length, 3);
  rmSync(out.logDir, { recursive: true, force: true }); r.cleanup();
}

section('app 建議卡(AC-4):一張卡不能把紀錄檔寫壞——再長、再怪的內容,那一行都小於 4096 bytes、讀得回來、標了已截短（真的跑 hook.sh）');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const jbytes = (s) => Buffer.byteLength(JSON.stringify(s));
  // 四段全部超長(連「要開在哪」的路徑都是):這是這一行最胖的樣子
  const long = { title: '標'.repeat(500), tldr: '說'.repeat(2000), prompt: '貼'.repeat(5000), cwd: `/${'夾'.repeat(400)}` };
  const out = runHook(CARD({ cwd: r.dir }, long));
  eq('超長的卡還是記了一行', out.lines.length, 1);
  const bytes = Buffer.byteLength(out.lines[0]);
  check(`超長的中文卡:實測 ${bytes} bytes < 4096`, bytes < 4096);
  // 這一行還有沒截的舊欄位(對話的 cwd):四段同時截滿之後剩下的空間,要放得下一條很長的路徑(這裡要求還剩 400 bytes 以上)
  check(`四段同時截滿,離 4096 還有 ${4096 - bytes} bytes(留給沒截的 cwd)`, 4096 - bytes >= 400);
  const rec = JSON.parse(out.lines[0]);
  check('三段留下來的都是原文的開頭(沒有切在一個字中間)',
    long.title.startsWith(rec.in_title) && long.tldr.startsWith(rec.in_tldr) && long.prompt.startsWith(rec.in_prompt));
  eq('被截的四段都標了(畫面才標得出「已截短」)', JSON.stringify(rec.in_cut), JSON.stringify(['title', 'tldr', 'prompt', 'cwd']));
  eq('讀取端:cut 帶著哪幾段被截', JSON.stringify(suggestionsOf([rec])[0].cut), JSON.stringify(['title', 'tldr', 'prompt', 'cwd']));
  // 照 bytes 截、不是照字數:中文(3 bytes)跟英文(1 byte)留下來的 bytes 要一樣多,差不到一個字。
  // 照字數截的話英文只留得下三分之一;二分法沒收斂的話兩邊會差很多
  const ascii = JSON.parse(runHook(CARD({ cwd: r.dir }, { prompt: 'x'.repeat(9000) })).lines[0]);
  check(`中文留 ${jbytes(rec.in_prompt)} bytes、英文留 ${jbytes(ascii.in_prompt)} bytes:差不到一個中文字`,
    Math.abs(jbytes(rec.in_prompt) - jbytes(ascii.in_prompt)) < 3);
  check('英文留下來的字數是中文的快三倍(同樣的空間,不浪費)', ascii.in_prompt.length > rec.in_prompt.length * 2.9);
  // 最會撐破一行的內容:emoji 一個 4 bytes、控制字元寫出來一個 6 bytes、引號與換行一個 2 bytes
  const nasty = { 'emoji': '\u{1F600}'.repeat(5000), '控制字元': ''.repeat(5000), '引號與換行': '"\n\\'.repeat(3000), '混著來': '中\u{1F600}a"\n'.repeat(1500) };
  for (const [label, text] of Object.entries(nasty)) {
    const o = runHook(CARD({ cwd: r.dir }, { title: text, tldr: text, prompt: text }));
    const b = o.lines.length === 1 ? Buffer.byteLength(o.lines[0]) : Infinity;
    let parsed = null; try { parsed = JSON.parse(o.lines[0]); } catch { parsed = null; }
    check(`${label}:${b} bytes < 4096,讀得回來,而且是原文的開頭`, b < 4096 && !!parsed && text.startsWith(parsed.in_prompt) && parsed.in_prompt.length > 0);
  }
  r.cleanup();
}

section('app 建議卡(AC-7):Claude 叫了收回,感測器記代號跟理由;讀取端只列在同一個對話、收回之前提的卡上,不配對、不自動收（真的跑 hook.sh）', 'P6');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  // 形狀照真的呼叫(2026-09-17 從對話紀錄量的):參數只有 task_id 跟 reason,task_id 13 個字,理由最長 235 bytes
  const WD = (over = {}, input = {}) => ({
    hook_event_name: 'PreToolUse', session_id: SRC, prompt_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', permission_mode: 'default', transcript_path: '/x/t.jsonl',
    tool_name: WITHDRAW_TOOL, tool_use_id: 'toolu_01WithdrawWithdrawWith', tool_input: { task_id: 'task_cc1bbc82', reason: '前提已被推翻：同一把金鑰今天成功了，401 的原因是金鑰被連貼兩次。', ...input }, ...over,
  });
  const out = runHook(WD({ cwd: r.dir }));
  eq('離開碼 0、零輸出', `${out.code}/${out.stdout}`, '0/');
  const rec = JSON.parse(out.lines[0]);
  eq('代號記到了', rec.in_task, 'task_cc1bbc82');
  eq('理由記到了', rec.in_reason, '前提已被推翻：同一把金鑰今天成功了，401 的原因是金鑰被連貼兩次。');
  check('沒被截的收回沒有 in_cut(不然畫面每個理由後面都會多一個「…」)', !('in_cut' in rec), JSON.stringify(rec.in_cut));
  check('沒有卡的欄位(收回不是一張卡)', !('in_title' in rec) && !('in_prompt' in rec) && !('title' in rec) && !('prompt' in rec), Object.keys(rec).join(','));
  // 一行最胖的樣子:六段(卡的四段＋收回的兩段)全部超長。hook.sh 不認工具名,所以要照「任何工具都可能帶這六個鍵」來量
  const fat = runHook(CARD({ cwd: r.dir }, { title: '標'.repeat(500), tldr: '說'.repeat(2000), prompt: '貼'.repeat(5000), cwd: `/${'夾'.repeat(400)}`, task_id: '代'.repeat(300), reason: '因'.repeat(2000) }));
  const fatBytes = fat.lines.length === 1 ? Buffer.byteLength(fat.lines[0]) : Infinity;
  check(`六段同時截滿:實測 ${fatBytes} bytes,離 4096 還有 ${4096 - fatBytes} bytes(至少要留 200 給沒截的 cwd)`, 4096 - fatBytes >= 200);
  eq('六段都標了已截短', JSON.stringify(JSON.parse(fat.lines[0]).in_cut), JSON.stringify(['title', 'tldr', 'prompt', 'cwd', 'task', 'reason']));
  r.cleanup();

  // 讀取端
  const T = (m) => new Date(Date.UTC(2026, 8, 17, 3, m)).toISOString();
  const card = (id, m, o = {}) => ({ ts: T(m), hook: 'PreToolUse', tool: SUGGEST_TOOL, session: 'src', cwd: '/x', use_id: id, in_title: id, in_prompt: `${id} 的說明,要夠長才比得出開頭,所以多寫幾個字湊到六十個字以上,再多寫一點點。`, ...o });
  const wd = (m, o = {}) => ({ ts: T(m), hook: 'PreToolUse', tool: WITHDRAW_TOOL, session: 'src', cwd: '/x', use_id: `toolu_wd${m}`, in_task: `task_${m}`, in_reason: `第 ${m} 分鐘收回`, ...o });
  const by = (ev) => Object.fromEntries(suggestionsOf(ev).map((s) => [s.id, s]));
  // 真的發生過的順序(Forma Pro 9/16):先收回一張舊的,十幾秒後才提新的 → 新的那張不該被標
  let c = by([card('old', 1), wd(2), card('new', 3)]);
  eq('收回之前提的卡 → 標上那次收回', c.old.withdrawals.length, 1);
  eq('收回之後才提的卡 → 不標(收回的不可能是它)', c.new.withdrawals.length, 0);
  eq('標上的是 Claude 說的理由', c.old.withdrawals[0].reason, '第 2 分鐘收回');
  // 真的發生過的順序(pipeline-monitor 9/17):提了新的、五秒後收回舊的(換一張)→ 兩張都在收回之前,都標,分不出是哪一張
  c = by([card('v1', 1), card('v2', 2), wd(2)]);
  eq('換一張:兩張都在收回之前 → 兩張都標(不猜是哪一張)', `${c.v1.withdrawals.length}/${c.v2.withdrawals.length}`, '1/1');
  eq('同一秒的收回也算(感測器的時間只到秒,分不出先後)', by([card('same', 2), wd(2)]).same.withdrawals.length, 1);
  eq('別的對話叫的收回 → 不標', by([card('mine', 1), wd(2, { session: 'other' })]).mine.withdrawals.length, 0);
  eq('同一個 task_id 記到兩次(plugin 跟舊接法同時掛著)→ 算一次', by([card('dup', 1), wd(2), wd(2, { use_id: 'toolu_again' })]).dup.withdrawals.length, 1);
  eq('沒有 task_id:用 use_id 分,兩次不同的收回照樣算兩次', by([card('noid', 1), wd(2, { in_task: undefined }), wd(3, { in_task: undefined })]).noid.withdrawals.length, 2);
  eq('什麼代號都沒有:每一筆各算一次(寧可多算,不准把兩次併成一次)', by([card('bare', 1), wd(2, { in_task: undefined, use_id: undefined }), wd(2, { in_task: undefined, use_id: undefined })]).bare.withdrawals.length, 2);
  eq('沒寫理由 → reason 是 null(畫面講「沒寫理由」,不編)', by([card('noreason', 1), wd(2, { in_reason: '' })]).noreason.withdrawals[0].reason, null);
  eq('理由被截過 → 帶著記號', by([card('long', 1), wd(2, { in_cut: ['reason'] })]).long.withdrawals[0].cut, true);
  eq('時間讀不出來 → 列著(看不懂不等於比較早)', by([card('badts', 1), wd(2, { ts: '壞掉的時間' })]).badts.withdrawals.length, 1);
  const order = by([card('ord', 1), wd(5), wd(3)]).ord.withdrawals.map((w) => w.reason);
  eq('卡上的收回照時間排(紀錄檔裡的順序不一定是時間順序)', order.join('／'), '第 3 分鐘收回／第 5 分鐘收回');
  eq('代號被截過:不拿來分(開頭一樣的長代號截完會撞在一起),改用那次呼叫的代號', by([card('longid', 1), wd(2, { in_task: 'task_同樣的開頭', in_cut: ['task'] }), wd(3, { in_task: 'task_同樣的開頭', in_cut: ['task'] })]).longid.withdrawals.length, 2);
  // --suggest 的卡平常沒有對話代號;故意給一個,確認擋住它的是「來源不是 app」,不是剛好沒有代號
  const withSuggest = by([{ ts: T(1), event: 'suggestion', id: 'sg-1', title: 't', prompt: 'p', cwd: '/x', source: 'claude', session: 'src' }, wd(2)]);
  eq('--suggest 放的卡不標(收回的工具只收得回 app 的卡)', withSuggest['sg-1'].withdrawals.length, 0);
  const all = by([card('a1', 1), wd(2), card('a2', 3), { ts: T(4), event: 'suggestion_dismissed', id: 'a1', source: 'human' }]);
  eq('收回不會把卡收起來:只有你按的「不做了」會', `${all.a1.dismissedAt}/${all.a2.dismissedAt}`, `${T(4)}/null`);
}

section('app 建議卡(輸入畸形):prompt 不是字串、是空的、整個 tool_input 不見 → 記 null,還是一張卡(「沒有內容」不等於「沒有這張卡」)');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const odd = { 'prompt 是數字': { prompt: 42 }, 'prompt 是物件': { prompt: { a: 1 } }, 'prompt 是空字串': { prompt: '' }, '三段都是 null': { title: null, tldr: null, prompt: null } };
  for (const [label, input] of Object.entries(odd)) {
    const o = runHook(CARD({ cwd: r.dir }, input));
    const rec = o.lines.length === 1 ? JSON.parse(o.lines[0]) : null;
    const cards = rec ? suggestionsOf([rec]) : [];
    check(`${label}:照樣記一行、in_prompt 不猜(沒有這個欄位)、讀取端還是一張卡而且 prompt 是空的`,
      !!rec && !('in_prompt' in rec) && cards.length === 1 && cards[0].prompt === '', JSON.stringify(rec));
  }
  const bare = runHook({ ...CARD({ cwd: r.dir }), tool_input: undefined });
  eq('整個 tool_input 不見:還是一張卡', suggestionsOf(bare.lines.map((l) => JSON.parse(l))).length, 1);
  eq('沒有標題的卡,標題照實說沒有', suggestionsOf(bare.lines.map((l) => JSON.parse(l)))[0].title, '（沒有標題）');
  r.cleanup();
}

section('app 建議卡:讀取端認的兩個工具名(提卡、收回),感測器真的有接(hooks.json 對得上);hook.sh 自己不認工具名', 'P2');
{
  // 這個工具名住兩個地方(hooks.json 的 matcher、lib/events.mjs 的 SUGGEST_TOOL)。對不上的話卡一張都進不來,而且沒有任何東西會紅
  const pre = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse;
  const hits = (tool) => pre.filter((e) => new RegExp(`^(?:${e.matcher})$`).test(tool));
  eq('PreToolUse 剛好一筆接得到它(兩筆就會記兩次)', hits(SUGGEST_TOOL).length, 1);
  check('那一筆跑的是感測器 hook.sh', hits(SUGGEST_TOOL)[0]?.hooks?.[0]?.command?.endsWith('/hook.sh"') === true);
  // 舊接法靠「事件＋matcher 字串」認掛過了沒:併進既有的 matcher = 改了那個字串 = 舊的那筆留著、瀏覽器動作記兩次
  eq('獨立的一筆,不是併進別的 matcher', hits(SUGGEST_TOOL)[0]?.matcher, SUGGEST_TOOL);
  check('瀏覽器那一筆的 matcher 沒被動到', pre.some((e) => e.matcher === 'mcp__Claude_Browser__.*|mcp__claude-in-chrome__.*'));
  check('hook.sh 裡沒有寫死這個工具名(哪個工具算建議卡,只有讀取端說了算)', !readFileSync(join(ROOT, 'hook.sh'), 'utf8').includes(SUGGEST_TOOL));
  // 收回卡的工具(不是 app 的叉叉——叉叉是人按的,沒有工具呼叫)同一套規矩:剛好一筆、獨立、跑 hook.sh、hook.sh 不寫死它的名字
  eq('收回卡的工具:PreToolUse 剛好一筆接得到它', hits(WITHDRAW_TOOL).length, 1);
  eq('收回卡的工具:獨立的一筆', hits(WITHDRAW_TOOL)[0]?.matcher, WITHDRAW_TOOL);
  check('收回卡的工具:那一筆跑的是感測器 hook.sh', hits(WITHDRAW_TOOL)[0]?.hooks?.[0]?.command?.endsWith('/hook.sh"') === true);
  check('hook.sh 裡也沒有寫死收回卡的工具名', !readFileSync(join(ROOT, 'hook.sh'), 'utf8').includes(WITHDRAW_TOOL));
  check('提卡那一筆不會順便接到收回(兩個工具各記各的,不會一次記兩筆)', hits(SUGGEST_TOOL)[0] !== hits(WITHDRAW_TOOL)[0]);
}

section('app 建議卡(AC-2、AC-3、AC-5):只有儀表板的「不做了」收得掉它;對話真的照說明開了才算已開始,對不上、分不出來都不收');
{
  const T = (h, m = 0) => new Date(Date.UTC(2026, 8, 17, h, m)).toISOString();
  const card = (o = {}) => ({ ts: T(2), hook: 'PreToolUse', tool: SUGGEST_TOOL, session: 'src', cwd: '/x', use_id: 'toolu_1', in_title: '修徽章', in_tldr: '一句說明', in_prompt: CARD_PROMPT, ...o });
  const says = (h, session, prompt) => ({ ts: T(h), hook: 'UserPromptSubmit', session, cwd: '/x', prompt });
  const one = (ev, opt) => suggestionsOf(ev, opt).find((s) => s.id === 'toolu_1');

  // AC-2:你在 app 按叉叉不會留下任何事件,卡當然還在。Claude 自己叫了收回(AC-7)也不准拿來收卡——
  // 它帶的是另一種代號(task_…),跟 use_id 對不起來,硬配會收錯張;只准列在卡上
  const withdrawn = [card(), { ts: T(3), hook: 'PreToolUse', tool: WITHDRAW_TOOL, session: 'src', cwd: '/x', use_id: 'toolu_2', in_task: 'task_aaaa1111', in_reason: '已經在這個對話裡做完' }];
  eq('同一個對話裡 Claude 叫過收回 → 這張還在(不亂配對、不自動收)', `${one(withdrawn).dismissedAt}/${one(withdrawn).startedBy}`, 'null/null');
  eq('…但卡上帶著那次收回(AC-7)', one(withdrawn).withdrawals.length, 1);
  eq('儀表板的「不做了」→ 收起來,記的是那一筆的時間', one([card(), { ts: T(4), event: 'suggestion_dismissed', id: 'toolu_1', source: 'human' }]).dismissedAt, T(4));

  // AC-3:新對話的第一句話開頭對得上 → 已開始;對不上 → 還沒開始,不猜
  eq('新對話第一句話就是那段要貼的話 → 已開始', one([card(), says(3, 'new1', CARD_PROMPT)]).startedBy, 'new1');
  eq('開頭一樣、後面被感測器截掉 → 還是已開始', one([card(), says(3, 'new1', CARD_PROMPT.slice(0, 70))]).startedBy, 'new1');
  eq('第一句話前面多了別的字 → 還沒開始(不猜)', one([card(), says(3, 'new1', `請幫我做這件事:${CARD_PROMPT}`)]).startedBy, null);
  eq('只有第二句話對得上 → 還沒開始(只認第一句)', one([card(), says(3, 'new1', '先聊別的'), says(4, 'new1', CARD_PROMPT)]).startedBy, null);
  // Oscar 習慣先打一行「這個對話命名為…」再貼說明(2026-09-17 實測:這個功能自己那張卡就因此一直掛著)→ 從某一行的開頭開始也認
  eq('先打一行別的、下一行才是說明 → 已開始', one([card(), says(3, 'new1', `這個對話命名為:修徽章\n${CARD_PROMPT}`)]).startedBy, 'new1');
  eq('說明夾在一句話中間(不是一行的開頭)→ 還沒開始', one([card(), says(3, 'new1', `你之前建議「${CARD_PROMPT}」是什麼意思`)]).startedBy, null);
  // 同一個對話提的兩張卡,開頭同一段前言(超過 60 字)、後面才分岔:照其中一張開對話,只准收那一張——另一張安靜消失就是弄丟
  const PRE = '這個專案的背景:它是一個給不寫程式的人用的工具,所有給人看的字都要白話,改任何東西之前先讀 CLAUDE.md 的三條紅線,改完一定要跑 npm test。';
  const two = [card({ use_id: 'toolu_1', in_prompt: `${PRE}這一張要做的事:換掉 README 的徽章。` }), card({ use_id: 'toolu_2', in_prompt: `${PRE}另一張要做的事:刪掉舊的部署腳本。` })];
  check('前言真的超過 60 字(不然這條測不到東西)', PRE.length > 60, String(PRE.length));
  const afterOne = Object.fromEntries(suggestionsOf([...two, says(3, 'new1', `${PRE}這一張要做的事:換掉 README 的徽章。`)]).map((s) => [s.id, s.startedBy]));
  eq('開頭一樣的兩張卡,照第一張開 → 只收第一張', `${afterOne.toolu_1}/${afterOne.toolu_2}`, 'new1/null');
  // 同一件事放了兩次(app 一張、--suggest 一張,說明一字不差——真的發生過)→ 兩張是同一個建議,一起收
  const twin = [card(), { ts: T(2), event: 'suggestion', id: 'sg-twin', title: '修徽章', prompt: CARD_PROMPT, cwd: '/x', source: 'claude' }, says(3, 'new1', CARD_PROMPT)];
  eq('說明一字不差的兩張 → 都算已開始', suggestionsOf(twin).map((s) => s.startedBy).join('/'), 'new1/new1');
  // 兩張卡的說明前 200 字一樣、後面不同:感測器只記得到第一句話的前 200 字,分不出是照哪一張開的 → 都不收(寧可多掛一張)
  const SAME200 = '同'.repeat(220);
  const tie = [card({ use_id: 'toolu_1', in_prompt: `${SAME200}甲` }), card({ use_id: 'toolu_2', in_prompt: `${SAME200}乙` }), says(3, 'new1', SAME200.slice(0, 200))];
  eq('分不出是照哪一張開的 → 兩張都留著', suggestionsOf(tie).map((s) => String(s.startedBy)).join('/'), 'null/null');
  // 比這張卡早的對話不可能是照這張卡開的:認了的話卡一出生就被當成已開始收掉,等於弄丟
  eq('同樣開頭、但比卡早的對話 → 不算', one([says(1, 'old', CARD_PROMPT), card()]).startedBy, null);
  eq('早的不算,晚的才算', one([says(1, 'old', CARD_PROMPT), card(), says(3, 'new1', CARD_PROMPT)]).startedBy, 'new1');
  // 整條走一次:app 開的 worktree 對話,第一句話前面有系統塞的 <system-reminder>——感測器剝掉之後要對得上（真的跑 hook.sh）
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const cardLine = JSON.parse(runHook(CARD({ cwd: r.dir, tool_use_id: 'toolu_1' })).lines[0]);
  const pre = '<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>\n';
  const firstLine = JSON.parse(runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'new-wt', prompt_id: 'p1', cwd: r.dir, prompt: `${pre}${CARD_PROMPT}` }).lines[0]);
  eq('兩行都是 hook.sh 寫的:worktree 對話照樣認得出已開始', one([cardLine, firstLine]).startedBy, 'new-wt');
  r.cleanup();
  // 要開在別的專案的卡:那個新對話記在別的專案的紀錄檔裡。collect 會把所有專案的第一句話湊成一份給進來
  const elsewhere = new Map([...firstPromptsOf([card(), says(1, 'src', '原本的對話')]), ['other-s', { prompt: CARD_PROMPT, ts: T(5), project: 'other-repo' }]]);
  const far = one([card(), says(1, 'src', '原本的對話')], { firstPrompts: elsewhere });
  eq('別的專案裡有對話這樣開頭 → 已開始,而且說得出在哪個專案', `${far.startedBy}/${far.startedIn}`, 'other-s/other-repo');

  // AC-5:兩種來源長得一樣、分得出來;--suggest 截過的也標得出來
  const both = suggestionsOf([card(), { ts: T(1), event: 'suggestion', id: 'sg-1', title: 't', prompt: 'p', cwd: '/x', source: 'claude', cut: true }]);
  eq('來源:app 與 claude', both.map((s) => s.source).sort().join(','), 'app,claude');
  eq('兩種卡的欄位一樣(畫面用同一種畫法)', JSON.stringify(Object.keys(both[0]).sort()), JSON.stringify(Object.keys(both[1]).sort()));
  eq('--suggest 截過的說明也帶著記號', JSON.stringify(both.find((s) => s.source === 'claude').cut), '["prompt"]');

  // 輸入畸形:沒有 use_id 也要是一張卡,而且代號每次讀都一樣(「不做了」才指得回來);同一個 use_id 記了兩次是同一張
  const noId = [card({ use_id: undefined, in_title: '甲' }), card({ use_id: undefined, in_title: '乙' })];
  const ids = suggestionsOf(noId).map((s) => s.id);
  eq('沒有 use_id 的兩張卡 → 兩張,代號不一樣', new Set(ids).size, 2);
  eq('再讀一次,代號一樣', JSON.stringify(suggestionsOf(noId).map((s) => s.id)), JSON.stringify(ids));
  const gone = suggestionsOf([...noId, { ts: T(4), event: 'suggestion_dismissed', id: ids[0], source: 'human' }]);
  eq('用那個代號按「不做了」,收掉的就是那一張', gone.filter((s) => s.dismissedAt).map((s) => s.id).join(','), ids[0]);
  eq('同一個 use_id 記了兩次(plugin 跟舊接法同時掛著)→ 一張', suggestionsOf([card(), card()]).length, 1);
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

section('你自己打的斜線指令不經過 Skill 工具:訊息開頭是 /spec 或 /pipeline-monitor:spec 也算被叫(L19)', 'P6');
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
  const withD = [...ev, { ts: T(3), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1', cwd: dir },
                 { ts: new Date(Date.UTC(2026, 8, 16, 3, 30)).toISOString(), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到', cwd: dir, source: 'claude' }];
  v = by(stagesOfSession(withD, stages, 's1', null, dir));
  eq('D 跑了、清單還沒對:B 不劃掉(要處理的樣子),D 現在(Claude 說沒問題)', `${v.B.state}/${v.D.state}`, 'stale/done');
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
  // 「找不到」住在規格在哪(specPlace)那一份,終端機與網頁從那裡講同一句;清單只在找得到的時候才有(規格搬家 AC-3、AC-4)
  check('規格檔不見了 → 說找不到(記的位置、三個資料夾都沒有),不當成沒有清單',
    v.A.specPlace?.found === 'missing' && v.A.specPlace?.given === 'docs/規劃中/沒有.md' && v.A.checklist === null,
    JSON.stringify({ place: v.A.specPlace, checklist: v.A.checklist }));
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
  // 舊的那份不拿來用;這一輪跑過 A、連不到它寫的檔 → 照實說找不到(施工對話認規格 AC-5 ①),不是什麼都不說
  check('比這次 A 還早的 report 不算:不拿那份,說「找不到這一輪的規格檔」', stale.A.checklist?.missing === true && stale.A.checklist?.parsed === false && !stale.A.checklist?.file, JSON.stringify(stale.A.checklist));
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

section('--report 的清單再長都整份留著:太長另存檔、紀錄單行仍小於 4096 bytes、讀回來一條不少(有幾條就列幾條)');
{
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const logDir = mkdtempSync(join(tmpdir(), 'pm-log-'));
  const lines = ['建議 40 條'].concat(Array.from({ length: 40 }, (_, i) => `- src/檔案${i}.js:${i + 1} —— 這一段看起來多餘，但要人判斷才知道能不能拿掉`));
  execFileSync('node', [join(ROOT, 'status.mjs'), '--report', 'C', 'ok', lines.join('\n')], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PIPELINE_MONITOR_LOG_DIR: logDir } });
  const f = readdirSync(logDir).find((x) => x.endsWith('.jsonl'));
  const raw = readFileSync(join(logDir, f), 'utf8').trim().split('\n').find((l) => l.includes('stage_report'));
  check('那一行小於 4096 bytes', Buffer.byteLength(raw, 'utf8') < 4096, `${Buffer.byteLength(raw, 'utf8')} bytes`);
  const rep = JSON.parse(raw);
  check('紀錄裡留第一行與檔名', rep.note === '建議 40 條' && typeof rep.noteFile === 'string' && existsSync(rep.noteFile), JSON.stringify({ note: rep.note, noteFile: rep.noteFile }));
  const ev = [
    { ts: new Date(Date.now() - 60000).toISOString(), hook: 'PreToolUse', tool: 'Skill', skill: 'cleanup', session: 's1', cwd: r.dir },
    { ...rep, cwd: r.dir },
  ];
  const v = Object.fromEntries(stagesOfSession(ev, stages, 's1', null, r.dir).map((s) => [s.id, s]));
  eq('讀回來 41 行,一條不少', v.C.report?.note.split('\n').length, 41);
  rmSync(rep.noteFile); 
  const v2 = Object.fromEntries(stagesOfSession(ev, stages, 's1', null, r.dir).map((s) => [s.id, s]));
  check('檔案不見了 → 說完整清單找不到,不當成只有一行', /完整清單找不到/.test(v2.C.report?.note ?? ''), v2.C.report?.note);
  rmSync(logDir, { recursive: true, force: true }); r.cleanup();
}

process.exit(summary());
