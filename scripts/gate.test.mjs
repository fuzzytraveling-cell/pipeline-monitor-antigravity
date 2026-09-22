/**
 * gate.test.mjs —— 收工 hook(gate.mjs / gate.sh)。規格:五關自動結案 AC-1(路徑看 CLAUDE.md 的表)
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

/**
 * 一個有分級設定、改了程式區檔案的專案,加一個假的監視器資料夾(stages.json、logs/、checkpoints/)。
 * at:專案的第一個 commit 的時間,不給就用 makeRepo 的預設(一小時前)——劇本從幾分鐘前開始,專案要比它早存在,
 * 「這次改動」才有起點的版本可比(規格:這一輪的起點)。⚠️ 以前這裡預設 null,把 makeRepo 的預設蓋回「現在」,
 * 有 7 段測試照樣綠、測的卻是「找不到起點」的退路(魔鬼教官 2026-09-22)。
 */
function scene({ danger = false, tests = false, at } = {}) {
  const r = makeRepo({ files: { 'src/a.js': '1\n', 'src/danger.js': 'd\n', 'docs/x.md': 'x\n', 'README.md': 'r\n' }, at });
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
  eq('缺的是 D(T1 只要 D;C 的價值跟改動大小成正比,碰到危險清單才要求)', (d?.missing ?? []).join(','), 'D');
  check('理由說這次至少 T1、碰到程式區的哪個檔', /T1/.test(d?.reason ?? '') && /src\/a\.js/.test(d?.reason ?? ''), d?.reason);
  check('理由指名 plugin 的 chaos-check,不叫 cleanup', (d?.reason ?? '').includes(`/${PLUGIN}:chaos-check`) && !(d?.reason ?? '').includes(`/${PLUGIN}:cleanup`), d?.reason);
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
  // 危險清單的檔跟只在程式區的檔分開列:以前全部掛在「碰到危險清單：」底下,程式區的檔也被講成危險(2026-09-22 收工 hook 自己印出來的)
  writeFileSync(join(s.root, 'src/a.js'), '也改了\n');
  const mixed = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home })?.reason ?? '';
  check('危險檔列在危險清單底下,程式區的只講幾個檔', /碰到危險清單：src\/danger\.js；另外碰到程式區 1 個檔/.test(mixed) && !/危險清單：[^；）]*src\/a\.js/.test(mixed), mixed);
  execFileSync('git', ['checkout', '-q', '--', 'src/a.js'], { cwd: s.root });
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
  check('留下 gate_blocked(source:gate),缺 D', blocked?.source === 'gate' && blocked?.missing?.join(',') === 'D', JSON.stringify(blocked));
  eq('放行(stop_hook_active):一個字都不印', run({ ...s.payload, stop_hook_active: true }), '');
  // 心跳:跑過就留時間,放行也留——「掛著」不等於「活著」(L13),沒有心跳的收工 hook跟沒裝一樣
  let hb = null; try { hb = JSON.parse(readFileSync(join(s.monitorDir, 'logs', '_gate.json'), 'utf8')); } catch { hb = null; }
  check('每次跑都留心跳 logs/_gate.json(含 cwd)', !!hb?.ts && hb?.cwd === s.root, JSON.stringify(hb));
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

section('沒章、收工前先存檔:該擋的照樣擋、缺的一樣——存檔只是放進保險箱,不是這件事做完了(規格:這一輪的起點 AC-1)', 'P5');
{
  const s = scene({ danger: true, at: T(-60 * MIN) });
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '改一下匯出' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/danger.js') },
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check' },
    { ts: T(-3 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'claude' },
  ]);
  const go = () => decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  const before = go();
  eq('存檔之前:擋(T2;D 在最後一次改檔之後跑過,缺 A、C、測試檔)', before?.missing?.join(','), 'A,C,tests');
  execFileSync('git', ['add', '-A'], { cwd: s.root });
  execFileSync('git', ['commit', '-qm', '收工前存檔'], { cwd: s.root });
  const after = go();
  check('存檔之後:照樣擋', after !== null, 'decide() 回 null——一存檔就放行,就是 2026-09-21 實測到的那件事');
  eq('缺的一模一樣(D 不會因為存檔變成「要再跑一次」:存檔不是改檔)', after?.missing?.join(','), 'A,C,tests');
  check('理由指名碰到的危險檔(存檔過的也算),並講「這一輪,含已存檔的」',
    /src\/danger\.js/.test(after?.reason ?? '') && /這一輪，含已存檔的/.test(after?.reason ?? ''), after?.reason);
  s.cleanup();
}

section('共用工作區:分級一個資料夾一份——收工 hook 跟對話頁、調高按鈕、終端機同一份,而且理由講含幾個對話(規格:這一輪的起點 AC-3)', 'P2');
{
  const s = scene();                                                        // 這個對話改的是程式區的 src/a.js(還沒存)
  // 另一個對話 s0 比較早開口,改了危險檔、在 40 分鐘前存了檔
  writeFileSync(join(s.root, 'src/danger.js'), 's0 的改動\n');
  execFileSync('git', ['commit', '-qm', 's0 存檔', '--', 'src/danger.js'], { cwd: s.root, env: { ...process.env, GIT_AUTHOR_DATE: T(-40 * MIN), GIT_COMMITTER_DATE: T(-40 * MIN) } });
  const past = new Date(Date.now() - 4 * MIN * 1000);
  utimesSync(join(s.root, 'src/a.js'), past, past);
  writeFileSync(s.log, [
    s.ev({ ts: T(-50 * MIN), hook: 'UserPromptSubmit', session: 's0', prompt: '改匯出' }),
    s.ev({ ts: T(-45 * MIN), hook: 'PostToolUse', tool: 'Edit', session: 's0', file: join(s.root, 'src/danger.js') }),
    s.ev({ ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '調一個標籤' }),
    s.ev({ ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }),
  ].join('\n') + '\n');
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('跟資料夾那張卡同一級(碰到 s0 存的危險檔)', d?.level, 'T2');
  check('理由講含 2 個對話的改動(多算的是別的對話的,照實講)', /含 2 個對話的改動/.test(d?.reason ?? '') && /src\/danger\.js/.test(d?.reason ?? ''), d?.reason);
  s.cleanup();
}

section('只刪檔的回合:刪掉的檔看它所在資料夾的時間——D 說沒問題之後刪了檔,收工 hook 要再要 D,不准安靜放行(魔鬼教官 2026-09-22)', 'P5');
{
  const s = scene();
  s.write([
    { ts: T(-10 * MIN), hook: 'UserPromptSubmit', prompt: '改一下' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') },
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check' },
    { ts: T(-3 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'claude' },
    { ts: T(-1 * MIN), hook: 'UserPromptSubmit', prompt: '把危險那支刪掉' },
  ]);
  execFileSync('git', ['rm', '-q', 'src/danger.js'], { cwd: s.root });   // 用 Bash 刪,感測器看不到
  execFileSync('git', ['commit', '-qm', '刪檔'], { cwd: s.root });
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  check('擋了(這一回合有改到:刪檔)', d !== null, '只刪檔的回合被當成沒改程式,安靜放行');
  check('要 D 再跑一次(刪檔在 D 之後)', (d?.missing ?? []).includes('D') && /最後一次改檔之後還沒再跑/.test(d?.reason ?? ''), d?.reason);
  eq('刪掉的是危險清單上的檔 → T2', d?.level, 'T2');
  s.cleanup();
}

section('git mv 搬走危險清單上的檔:新舊兩個路徑都算,不准掉成 T1(老毛病 P1,魔鬼教官 2026-09-22)', 'P1');
{
  const s = scene();
  execFileSync('git', ['checkout', '-q', '--', 'src/a.js'], { cwd: s.root });   // 這一段只看搬家
  mkdirSync(join(s.root, 'src', 'moved'), { recursive: true });
  execFileSync('git', ['mv', 'src/danger.js', 'src/moved/danger.js'], { cwd: s.root });
  execFileSync('git', ['commit', '-qm', '搬家'], { cwd: s.root });
  s.write([{ ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '整理資料夾' }]);
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('搬走危險檔 → T2(原本的路徑在危險清單上)', d?.level, 'T2');
  check('理由列得出原本的路徑', /src\/danger\.js/.test(d?.reason ?? ''), d?.reason);
  s.cleanup();
}

section('對話中途換進這個資料夾:起點是它在這裡的第一筆紀錄,不是之後才講的那一句(魔鬼教官 2026-09-22)', 'P6');
{
  const s = scene({ danger: true });
  // s1 先在別的資料夾開口,之後換進這裡改了危險檔、存了檔,在這裡一句話都還沒講就收工
  writeFileSync(s.log, [
    s.ev({ ts: T(-20 * MIN), hook: 'UserPromptSubmit', cwd: '/別的資料夾', prompt: '先看一下再進 worktree' }),
    s.ev({ ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/danger.js') }),
  ].join('\n') + '\n');
  execFileSync('git', ['commit', '-qam', '存檔'], { cwd: s.root });
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  check('擋了(存檔過的危險檔還在清單裡)', d !== null && d.level === 'T2', JSON.stringify(d?.missing));
  check('理由講從這一輪算、含已存檔的(不是「找不到起點」)', /這一輪，含已存檔的/.test(d?.reason ?? ''), d?.reason);
  s.cleanup();
}

process.exit(summary());
