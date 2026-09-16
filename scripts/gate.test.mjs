/**
 * gate.test.mjs —— 收工 hook(gate.mjs / gate.sh)。規格:docs/進行中/五關自動結案.md AC-1
 *
 * 釘的是「會安靜出錯」的那幾條:
 *   ① 該擋的要擋(T1 缺 C、D;T2 缺 A、測試檔),理由要指名該叫哪個指令
 *   ② 不該擋的一律放行:已經跑過、這一回合沒改程式、stop_hook_active、沒設定分級、不是 git、指令不存在、payload 壞掉
 *   ③ 用 Bash 寫檔繞過感測器時,靠檔案修改時間也認得出「這一回合改了」(L8)
 *   ④ 整條路(sh gate.sh → node gate.mjs)真的跑一次:擋的時候印 JSON、留 gate_blocked;放行時一個字都不印
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, utimesSync, readFileSync, symlinkSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { decide } from '../gate.mjs';
import { safeName } from '../lib/events.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name;
const out = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const T = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString();
const MIN = 60;

/** 一個有分級設定、改了程式區檔案的專案,加一個假的監視器資料夾(stages.json、logs/、checkpoints/)。 */
function scene({ danger = false, tests = false } = {}) {
  const r = makeRepo({ files: { 'src/a.js': '1\n', 'src/danger.js': 'd\n', 'docs/x.md': 'x\n', 'README.md': 'r\n' } });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'pipeline-stages.json'), JSON.stringify({ tiers: { code: ['src/'], danger: ['src/danger.js'] } }));
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-gate-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(ROOT, join(home, '.claude', 'skills', PLUGIN));           // 裝了 plugin:三支指令都在
  // 這一輪改的檔:程式區(或危險清單)一個檔,修改時間放在「4 分鐘前」,測試才控制得了時間
  const changed = danger ? 'src/danger.js' : 'src/a.js';
  writeFileSync(join(root, changed), 'changed\n');
  const past = new Date(Date.now() - 4 * MIN * 1000);
  utimesSync(join(root, changed), past, past);
  // 測試檔也在程式區裡,它的修改時間一樣算「最後一次改檔」——跟其他改動一起放到 4 分鐘前,才測得到「之後都跑過」
  if (tests) { writeFileSync(join(root, 'src', 'a.test.js'), 't\n'); utimesSync(join(root, 'src', 'a.test.js'), past, past); }
  const log = join(monitorDir, 'logs', `${safeName(basename(root))}.jsonl`);
  const ev = (o) => JSON.stringify({ session: 's1', cwd: root, ...o });
  const write = (lines) => writeFileSync(log, lines.map(ev).join('\n') + '\n');
  const payload = { session_id: 's1', cwd: root, hook_event_name: 'Stop', stop_hook_active: false };
  const cleanup = () => { for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true }); r.cleanup(); };
  return { r, root, monitorDir, home, log, ev, write, payload, changed, cleanup };
}

section('T1 這一回合改了程式區、C 與 D 還沒跑 → 擋一次,理由指名該叫的指令');
{
  const s = scene();
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '幫我改一下' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') },
  ]);
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  check('擋了', d !== null, JSON.stringify(d));
  eq('缺的是 C 跟 D', (d?.missing ?? []).join(','), 'C,D');
  check('理由說這次至少 T1、碰到程式區的哪個檔', /T1/.test(d?.reason ?? '') && /src\/a\.js/.test(d?.reason ?? ''), d?.reason);
  check('理由指名 plugin 的兩支指令', (d?.reason ?? '').includes(`/${PLUGIN}:cleanup`) && (d?.reason ?? '').includes(`/${PLUGIN}:chaos-check`), d?.reason);
  check('理由裡沒有程式內部值', !/null|undefined|NaN/.test(d?.reason ?? ''), d?.reason);

  // C 跟 D 在最後一次改檔之後都跑過 → 放行
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '幫我改一下' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') },
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:cleanup` },
    { ts: T(-2 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check' },
  ]);
  eq('C、D 都在改檔之後跑過 → 放行', decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home }), null);

  // D 跑過,但之後又改了檔(檔案修改時間比 D 晚)→ 要再跑一次(AC-9)
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '幫我改一下' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') },
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'cleanup' },
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check' },
  ]);
  writeFileSync(join(s.root, 'src/a.js'), 'changed again\n');          // 現在改的,mtime = 現在,比 D 晚
  const again = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  // C 是列建議,這一輪跑過就算;D 標了 rerunAfterChange(stages.json),改了之後要再跑
  eq('D 之後又改了 → 只缺 D(C 這一輪列過就算)', (again?.missing ?? []).join(','), 'D');
  check('理由說「最後一次改檔之後還沒再跑」', /之後還沒再跑/.test(again?.reason ?? ''), again?.reason);
  s.cleanup();
}

section('用 Bash 寫檔繞過感測器:只有檔案修改時間當證據,也認得出這一回合改了(L8)');
{
  const s = scene();
  writeFileSync(join(s.root, 'src/a.js'), 'bash wrote this\n');        // mtime = 現在,沒有任何 Edit 事件
  s.write([{ ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '用 bash 改' }]);
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  check('沒有 Edit 事件也擋', d !== null && d.missing.includes('D'), JSON.stringify(d));
  s.cleanup();
}

section('不該擋的一律放行');
{
  const s = scene();
  const base = [{ ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: 'hi' }, { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }];
  s.write(base);
  const go = (payload = s.payload, extra = {}) => decide({ payload, monitorDir: s.monitorDir, skillHome: s.home, ...extra });
  eq('stop_hook_active → 放行(同一個 prompt 只擋一次)', go({ ...s.payload, stop_hook_active: true }), null);
  eq('payload 壞掉 → 放行', go('不是物件'), null);
  eq('沒有 session → 放行', go({ cwd: s.root }), null);
  eq('cwd 不存在 → 放行', go({ ...s.payload, cwd: '/沒有這個資料夾' }), null);
  // 這一回合沒改程式:最後一句話在改檔之後
  s.write([{ ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }, { ts: T(-1 * MIN), hook: 'UserPromptSubmit', prompt: '這個怎麼用?' }]);
  eq('這一回合只是回答問題(改檔在上一句話之前)→ 放行', go(), null);
  // 感測器沒記到這個對話的任何一句話 → 不知道回合從哪開始 → 放行
  s.write([{ ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }]);
  eq('沒有任何 UserPromptSubmit → 放行(沒問到不當沒有)', go(), null);
  // 只改文件
  s.write(base);
  writeFileSync(join(s.root, 'src/a.js'), '1\n');                       // 把程式區改回去
  const old = new Date(Date.now() - 60 * MIN * 1000); utimesSync(join(s.root, 'src/a.js'), old, old);
  writeFileSync(join(s.root, 'docs/x.md'), 'docs only\n');
  s.write([{ ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: 'hi' }, { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'docs/x.md') }]);
  eq('只改到文件 → T0,放行', go(), null);
  // 沒設定分級
  writeFileSync(join(s.root, 'src/a.js'), 'changed\n');
  s.write(base);
  unlinkSync(join(s.root, '.claude', 'pipeline-stages.json'));
  eq('沒設定分級 → 放行', go(), null);
  writeFileSync(join(s.root, '.claude', 'pipeline-stages.json'), JSON.stringify({ tiers: { code: ['src/'], danger: [] } }));
  // 指令不存在(沒裝 plugin、專案也沒有)
  const emptyHome = mkdtempSync(join(tmpdir(), 'pm-home-empty-'));
  eq('指令不存在 → 要求了也做不到,放行', go(s.payload, { skillHome: emptyHome }), null);
  rmSync(emptyHome, { recursive: true, force: true });
  // 退出記錄的專案
  writeFileSync(join(s.root, '.claude', 'pipeline-monitor.off'), '{}');
  eq('退出記錄 → 放行', go(), null);
  unlinkSync(join(s.root, '.claude', 'pipeline-monitor.off'));
  s.cleanup();
}

section('T2:碰到危險清單 → 還要 A 與測試檔;專案自己有同名指令就叫它的');
{
  const s = scene({ danger: true });
  s.write([{ ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: 'hi' }, { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/danger.js') }]);
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('缺 A、C、D、測試檔', (d?.missing ?? []).join(','), 'A,C,D,tests');
  check('理由說 T2、碰到危險清單、要補測試', /T2/.test(d?.reason ?? '') && /危險清單/.test(d?.reason ?? '') && /測試檔/.test(d?.reason ?? ''), d?.reason);
  mkdirSync(join(s.root, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(s.root, '.claude', 'commands', 'chaos-check.md'), '# 自己的\n');
  const d2 = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  check('專案自己有 /chaos-check → 理由叫它的,不叫 plugin 的', /跑 \/chaos-check/.test(d2?.reason ?? '') && !(d2?.reason ?? '').includes(`/${PLUGIN}:chaos-check`), d2?.reason);
  s.cleanup();
}
{
  const s = scene({ danger: true, tests: true });
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '/pipeline-monitor:spec 做東西' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/danger.js') },
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'cleanup' },
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check' },
  ]);
  eq('A 打過、C D 跑過、有測試檔 → 放行', decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home }), null);
  s.cleanup();
}

section('整條路真的跑一次:sh gate.sh → node gate.mjs。擋的時候印 JSON 並留紀錄;放行時一個字都不印', 'P3');
{
  const s = scene();
  s.write([{ ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: 'hi' }, { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }]);
  const env = { ...process.env, PIPELINE_MONITOR_HOME: s.monitorDir, PIPELINE_MONITOR_LOG_DIR: join(s.monitorDir, 'logs'), HOME: s.home };
  const run = (payload) => execFileSync('sh', [join(ROOT, 'gate.sh')], { input: JSON.stringify(payload), env, encoding: 'utf8' });
  const outText = run(s.payload);
  let parsed = null; try { parsed = JSON.parse(outText); } catch { parsed = null; }
  check('擋:印出一行 JSON,decision=block,reason 是白話', parsed?.decision === 'block' && /收工前還缺/.test(parsed?.reason ?? ''), outText.slice(0, 200));
  const events = readFileSync(s.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const blocked = events.find((e) => e.event === 'gate_blocked');
  check('留下 gate_blocked(source:gate),缺 C、D', blocked?.source === 'gate' && blocked?.missing?.join(',') === 'C,D', JSON.stringify(blocked));
  eq('放行(stop_hook_active):一個字都不印', run({ ...s.payload, stop_hook_active: true }), '');
  eq('壞掉的輸入:一個字都不印、不炸', run({}), '');
  check('壞掉的輸入不留故障記號(那是「沒東西」,不是「壞了」)', !existsSync(join(s.monitorDir, 'logs', '_sensor.jsonl')));
  s.cleanup();
}

section('有規格的輪次:改了程式、清單還有沒標的 → 先對清單(AC-6)');
{
  const s = scene();
  mkdirSync(join(s.root, 'docs', '規劃中'), { recursive: true });
  const spec = join(s.root, 'docs', '規劃中', 'x.md');
  writeFileSync(spec, '# 功能：x\n**AC-1　一**\n**AC-2　二** ✅ 對過 2026-09-16\n');
  s.write([
    { ts: T(-6 * MIN), hook: 'UserPromptSubmit', prompt: '/pipeline-monitor:spec 做 x', prompt_id: 'p1' },
    { ts: T(-6 * MIN), hook: 'PostToolUse', tool: 'Write', file: spec, prompt_id: 'p1' },
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '好,開工', prompt_id: 'p2' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js'), prompt_id: 'p2' },
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'cleanup' },
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check' },
  ]);
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  check('C、D 都跑過,只剩清單 → 擋,理由點名 AC-1 跟檔案', d?.missing?.join(',') === 'checklist' && /AC-1/.test(d?.reason ?? '') && /x\.md/.test(d?.reason ?? '') && !/AC-2/.test(d?.reason ?? ''), d?.reason);
  writeFileSync(spec, '# 功能：x\n**AC-1　一** ⏳ 待討論：要問人\n**AC-2　二** ✅ 對過 2026-09-16\n');
  eq('都標了(⏳ 也算標了,那是要跟人談)→ 放行', decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home }), null);
  s.cleanup();
}

process.exit(summary());
