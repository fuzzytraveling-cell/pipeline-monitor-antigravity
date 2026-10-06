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
import { collectAll, cardFor } from '../lib/collect.mjs';
import { safeName } from '../lib/events.mjs';
import { sessionsOf } from '../lib/rounds.mjs';
import { laterOf } from '../lib/tier.mjs';

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

  // C 跟 D 在最後一次改檔之後都跑過、D 記了結論 → 放行
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '幫我改一下' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') },
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:cleanup` },
    { ts: T(-2 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check' },
    { ts: T(-2 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'claude' },
  ]);
  eq('C、D 都在改檔之後跑過、D 記了結論 → 放行', decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home }), null);

  // D 跑過、記了結論,但之後又改了檔(檔案修改時間比 D 晚)→ 不叫它再跑,叫它先問人(D 多輪先問人 AC-1、AC-9)
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '幫我改一下' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') },
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'cleanup' },
    { ts: T(-3 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check' },
    { ts: T(-3 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'found', note: '找到 1 條', source: 'claude' },
  ]);
  writeFileSync(join(s.root, 'src/a.js'), 'changed again\n');          // 現在改的,mtime = 現在,比 D 晚
  const again = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  // C 是列建議,這一輪跑過就算;D 標了 rerunAfterChange(stages.json),改了之後是「要不要再跑,先問人」
  eq('D 之後又改了 → 只缺「D 先問人」(C 這一輪列過就算)', (again?.missing ?? []).join(','), 'D:ask');
  check('理由說要不要再跑由使用者決定、不要自己再跑、他說不用就 --decide',
    /要不要再跑由你決定/.test(again?.reason ?? '') && /不要自己再跑/.test(again?.reason ?? '') && /--decide D skip/.test(again?.reason ?? ''), again?.reason);
  check('最後那句不叫它「先把缺的跑完」(跟「不要自己再跑」打架,AC-7)', !/先把缺的跑完再收工/.test(again?.reason ?? '') && /先停下來問使用者/.test(again?.reason ?? ''), again?.reason);
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
    { ts: T(-3 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'claude' },
  ]);
  eq('A 打過、C D 跑過(D 記了結論)、有測試檔 → 放行', decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home }), null);
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
    { ts: T(-3 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'claude' },
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

section('只刪檔的回合:刪掉的檔看它所在資料夾的時間——D 說沒問題之後刪了檔,收工 hook 要問要不要再跑,不准安靜放行(魔鬼教官 2026-09-22)', 'P5');
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
  check('要問要不要再跑 D(刪檔在 D 之後;D 多輪先問人:不叫它自己再跑)', (d?.missing ?? []).includes('D:ask') && /要不要再跑由你決定/.test(d?.reason ?? ''), d?.reason);
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

/**
 * 新對話接手舊資料夾(規格:新對話接手舊資料夾;2026-09-24 那個資料夾的縮小版)。
 * 主資料夾開 worktree(舊分支 old)→ 舊對話 s0 在裡面叫 A、C、D,改危險檔、存檔、蓋章 → app 收掉(脫離分支)→
 * 別的對話的改動併進 main(碰到危險檔)→ app 在同一個資料夾從 main 開新分支 new,給新對話 s1;s1 只改程式區的 a.js(還沒存)。
 * 時間用 GIT_COMMITTER_DATE 控制(reflog 跟著它走)。
 */
function reuseScene() {
  const cfg = JSON.stringify({ tiers: { code: ['src/'], danger: ['src/danger.js'] } });
  const r = makeRepo({ files: { 'src/a.js': '1\n', 'src/danger.js': 'd\n', 'README.md': 'r\n', '.claude/pipeline-stages.json': cfg }, at: T(-300 * MIN) });
  const main = out(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const g = (cwd, at, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  const wtParent = mkdtempSync(join(tmpdir(), 'pm-gate-reuse-'));
  g(r.dir, T(-240 * MIN), 'worktree', 'add', '-q', '-b', 'old', join(wtParent, 'wt'));
  const root = out(join(wtParent, 'wt'), 'rev-parse', '--show-toplevel');
  writeFileSync(join(root, 'src/danger.js'), 's0 的改動\n');
  g(root, T(-231 * MIN), 'commit', '-qam', 's0 存檔');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-gate-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const project = safeName(basename(out(r.dir, 'rev-parse', '--show-toplevel')));
  writeFileSync(join(monitorDir, 'checkpoints', `${project}__old.json`), JSON.stringify({
    commit: out(root, 'rev-parse', 'HEAD'), branch: 'old', worktree: root, at: T(-230 * MIN), checks: ['test'] }));
  g(root, T(-200 * MIN), 'checkout', '-q', '--detach');                                  // app 收掉 s0
  writeFileSync(join(r.dir, 'src/danger.js'), '別的對話的改動\n');
  g(r.dir, T(-100 * MIN), 'commit', '-qam', '別的對話併進 main');
  g(root, T(-10 * MIN), 'checkout', '-q', '-b', 'new', main);                            // app 把資料夾換新分支給 s1
  writeFileSync(join(root, 'src/a.js'), 's1 的改動\n');
  const past = new Date(Date.now() - 4 * MIN * 1000);
  utimesSync(join(root, 'src/a.js'), past, past);
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(ROOT, join(home, '.claude', 'skills', PLUGIN));
  const log = join(monitorDir, 'logs', `${project}.jsonl`);
  // 上一手 s0 的紀錄:A、C、D 都跑過,C、D 記了結論(CLI 記的,沒有對話代號)
  const old = [
    { ts: T(-239 * MIN), hook: 'UserPromptSubmit', session: 's0', prompt: '改匯出' },
    { ts: T(-238 * MIN), hook: 'PreToolUse', tool: 'Skill', session: 's0', skill: 'spec' },
    { ts: T(-236 * MIN), hook: 'PostToolUse', tool: 'Edit', session: 's0', file: join(root, 'src/danger.js') },
    { ts: T(-235 * MIN), hook: 'PreToolUse', tool: 'Skill', session: 's0', skill: 'cleanup' },
    { ts: T(-234 * MIN), event: 'stage_report', stage: 'C', verdict: 'ok', note: '列了建議', source: 'claude' },
    { ts: T(-233 * MIN), hook: 'PreToolUse', tool: 'Skill', session: 's0', skill: 'chaos-check' },
    { ts: T(-232 * MIN), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'claude' },
  ];
  const write = (lines) => writeFileSync(log, [...old, ...lines].map((o) => JSON.stringify({ cwd: root, ...o })).join('\n') + '\n');
  const payload = { session_id: 's1', cwd: root, hook_event_name: 'Stop', stop_hook_active: false };
  // 終端機:人自己跑的那種(沒有對話代號)——看的是這個資料夾那一份,跟專案卡同一份
  const env = { ...process.env, PIPELINE_MONITOR_HOME: monitorDir, PIPELINE_MONITOR_LOG_DIR: join(monitorDir, 'logs'), HOME: home, CLAUDE_CODE_SESSION_ID: '' };
  const cli = () => execFileSync('node', [join(ROOT, 'status.mjs')], { cwd: root, encoding: 'utf8', env });
  const cleanup = () => {
    execFileSync('git', ['worktree', 'remove', '--force', root], { cwd: r.dir, stdio: 'ignore' });
    for (const d of [monitorDir, home, wtParent]) rmSync(d, { recursive: true, force: true });
    r.cleanup();
  };
  return { root, monitorDir, home, project, g, write, payload, cli, cleanup };
}

section('新對話接手舊資料夾:收工 hook、儀表板、終端機都從接手那一刻算——T1、只要 D;上一手的 A、C、章都不算(規格:新對話接手舊資料夾 AC-1、AC-3、AC-4、AC-5)', 'P6');
{
  const s = reuseScene();
  const mine = [
    { ts: T(-10 * MIN + 1), hook: 'UserPromptSubmit', session: 's1', prompt: '整理一下程式' },
    { ts: T(-5 * MIN), hook: 'PostToolUse', tool: 'Edit', session: 's1', file: join(s.root, 'src/a.js') },
  ];
  s.write(mine);
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('收工 hook:T1(上一手、別的對話碰過的危險檔不算這個對話的)', d?.level, 'T1');
  eq('收工 hook:只缺 D——不叫補 A、C(上一手跑的不算這一手的;T1 也不要)', (d?.missing ?? []).join(','), 'D');
  const p = collectAll({ monitorDir: s.monitorDir, skillHome: s.home }).projects[0];
  const c = p?.cards.find((x) => x.path === s.root);
  const s1 = p?.sessions.find((x) => x.id === 's1'), s0 = p?.sessions.find((x) => x.id === 's0');
  eq('儀表板:還沒有還原點(上一手在舊分支蓋的章不算)', c?.checkpoint, null);
  eq('儀表板:這一輪 1 個檔(不是從舊章算出來的一堆)', c?.files?.total, 1);
  check('儀表板:從這個對話第一句話算起', /這個對話第一句話/.test(c?.scope?.note ?? ''), c?.scope?.note);
  eq('對話頁:T1、不說跟別的對話共用(上一手已經撤場)、不是上一手', `${s1?.tier?.final?.id}|${s1?.sharesCwd}|${s1?.movedOn}`, 'T1|false|null');
  check('上一手的頁面:講明資料夾換人了、不給它資料夾現在的分級', !!s0?.movedOn?.at && s0?.tier === null, JSON.stringify({ movedOn: s0?.movedOn, tier: s0?.tier }));
  const txt = s.cli();
  check('終端機:還沒有還原點、1 個檔案、T1', /還沒有還原點/.test(txt) && /\n {3}1 個檔案/.test(txt) && /\n {3}T1（/.test(txt), txt);
  check('終端機:A、C 這一輪還沒跑(上一手跑的不算成這一輪的)', /A 寫規格\s+⚪ 這一輪還沒跑/.test(txt) && /C 打掃\s+⚪ 這一輪還沒跑/.test(txt), txt);
  // 換人之後你在儀表板上替上一手按了結案:那一筆帶著上一手的對話代號、記在這個資料夾(魔鬼教官 2026-09-24 重現)
  s.write([...mine, { ts: T(-1 * MIN), event: 'session_closed', session: 's0', cwd: s.root, source: 'human' }]);
  const p2 = collectAll({ monitorDir: s.monitorDir, skillHome: s.home }).projects[0];
  eq('替上一手按了結案之後:新對話照舊不說共用、上一手照舊是上一手',
    `${p2?.sessions.find((x) => x.id === 's1')?.sharesCwd}|${!!p2?.sessions.find((x) => x.id === 's0')?.movedOn}`, 'false|true');
  eq('收工 hook 拿到的紀錄裡也只有這一手的對話(它的「共用」從這裡算)',
    sessionsOf(cardFor({ monitorDir: s.monitorDir, path: s.root, skillHome: s.home }).events).filter((x) => x.cwd === s.root).map((x) => x.id).join(','), 's1');
  // 這一手自己跑了 D、記了結論 → 放行
  s.write([...mine,
    { ts: T(-2 * MIN), hook: 'PreToolUse', tool: 'Skill', session: 's1', skill: 'chaos-check' },
    { ts: T(-2 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'claude' },
  ]);
  eq('這一手跑了 D、記了結論 → 放行', decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home }), null);
  s.cleanup();
}

section('同一個資料夾兩顆章:終端機跟儀表板認同一顆——這條分支、接手之後蓋的;不看檔名排序的運氣(規格:新對話接手舊資料夾 AC-3)', 'P2');
{
  const s = reuseScene();
  s.g(s.root, T(-3 * MIN), 'commit', '-qam', 's1 存檔');
  const head = out(s.root, 'rev-parse', 'HEAD');
  // 「new」排在「old」前面:以前儀表板照檔名的順序讀,後讀到的(old,上一手的)蓋掉先讀到的
  writeFileSync(join(s.monitorDir, 'checkpoints', `${s.project}__new.json`), JSON.stringify({
    commit: head, branch: 'new', worktree: s.root, at: T(-2 * MIN), checks: ['test'] }));
  s.write([{ ts: T(-10 * MIN + 1), hook: 'UserPromptSubmit', session: 's1', prompt: '整理一下程式' }]);
  const c = collectAll({ monitorDir: s.monitorDir, skillHome: s.home }).projects[0]?.cards.find((x) => x.path === s.root);
  eq('儀表板認這條分支、接手之後蓋的那一顆', `${c?.checkpoint?.branch}|${c?.checkpoint?.commit}`, `new|${head}`);
  const txt = s.cli();
  check('終端機認同一顆', txt.includes(`最後一次檢查全綠：${head.slice(0, 7)}`), txt.slice(0, 400));
  s.cleanup();
}

section('同一個對話自己中途換分支:不算換人,之前做的照算——改動只准看起來比實際大(規格:新對話接手舊資料夾 AC-2)', 'P1');
{
  const s = scene({ danger: true });                                        // s1 改了危險檔
  const at = (t) => ({ ...process.env, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t });
  execFileSync('git', ['commit', '-qam', 's1 存檔'], { cwd: s.root, stdio: 'ignore', env: at(T(-8 * MIN)) });
  execFileSync('git', ['checkout', '-q', '-b', 'feat'], { cwd: s.root, stdio: 'ignore', env: at(T(-6 * MIN)) });   // 用 Bash 開新分支繼續做
  writeFileSync(join(s.root, 'src/a.js'), 'feat 上的改動\n');
  s.write([
    { ts: T(-10 * MIN), hook: 'UserPromptSubmit', prompt: '改匯出' },
    { ts: T(-9 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/danger.js') },
    { ts: T(-6 * MIN + 1), hook: 'PostToolUse', tool: 'Bash' },            // 開分支那一個 Bash 動作的收尾:換分支之後 s1 還在
    { ts: T(-5 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') },
  ]);
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('還是 T2:換分支之前改的危險檔照算(當成換人的話會掉成 T1——危險的那一邊)', d?.level, 'T2');
  check('缺的照 T2 要(A、C 都在)', ['A', 'C'].every((k) => (d?.missing ?? []).includes(k)), JSON.stringify(d?.missing));
  s.cleanup();
}

section('app 新開的資料夾沒有 reflog、Claude 收工前先存檔:收工 hook 照樣要 D——起點的版本看感測器記的版本號(規格:多份規格與新資料夾的起點 AC-9)', 'P1');
{
  // 照 app 現在(2026-10-01 起)的做法開工作區:開資料夾那一刻不留 reflog,第一次存檔才有(10/2 TutorPod 實測)
  const s = scene();
  const init = out(s.root, 'rev-parse', 'HEAD');
  execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: s.root });   // 主資料夾不留改動:這一段只看工作區
  const wt = join(mkdtempSync(join(tmpdir(), 'pm-gate-app-')), 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'claude/app-new', wt], { cwd: s.root, stdio: 'ignore' });
  rmSync(join(out(wt, 'rev-parse', '--absolute-git-dir'), 'logs'), { recursive: true, force: true });
  rmSync(join(s.root, '.git', 'logs', 'refs', 'heads', 'claude', 'app-new'), { force: true });
  const head = init.slice(0, 7);
  const line = (o) => JSON.stringify({ session: 's1', cwd: wt, head, ...o });
  writeFileSync(s.log, [
    { ts: T(-10 * MIN), hook: 'UserPromptSubmit', prompt: '幫我改一下' },
    { ts: T(-9 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(wt, 'src/a.js') },
  ].map(line).join('\n') + '\n');
  writeFileSync(join(wt, 'src/a.js'), 'changed\n');
  const past = new Date(Date.now() - 9 * MIN * 1000);
  utimesSync(join(wt, 'src/a.js'), past, past);
  const payload = { session_id: 's1', cwd: wt, hook_event_name: 'Stop', stop_hook_active: false };
  const before = decide({ payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('還沒存檔:擋,缺 D(T1)', `${before?.level}|${(before?.missing ?? []).join(',')}`, 'T1|D');
  // Claude 收工前先存檔——reflog 這時才有第一筆,比這一輪的起點晚
  execFileSync('git', ['commit', '-qam', '收工前存檔'], { cwd: wt, stdio: 'ignore' });
  const after = decide({ payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('存檔之後:照樣擋、缺的一樣(以前這裡分級變「看不全」,收工 hook 放行)', `${after?.level}|${(after?.missing ?? []).join(',')}`, 'T1|D');
  check('理由講從這一輪算、含已存檔的,不講「只算還沒存檔的」', /含已存檔的/.test(after?.reason ?? '') && !/只算還沒存檔的/.test(after?.reason ?? ''), after?.reason);
  const card = cardFor({ monitorDir: s.monitorDir, path: wt, skillHome: s.home })?.card;
  eq('儀表板那張卡:分級 T1、從這一輪的起點算(不是「看不全」)', `${card?.tier?.state}|${card?.tier?.final?.id}|${card?.base?.kind}`, 'ok|T1|origin');
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: s.root, stdio: 'ignore' });
  s.cleanup();
}

section('app 新開的資料夾、這一輪從「叫 A」開始(真的那個 TutorPod 對話走的路):存檔之後收工 hook 照樣要 D,起點是叫 A 那一刻(魔鬼教官第一輪:這條路以前沒有測試)', 'P1');
{
  const s = scene();
  const init = out(s.root, 'rev-parse', 'HEAD');
  execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: s.root });
  const wt = join(mkdtempSync(join(tmpdir(), 'pm-gate-appA-')), 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'claude/app-a', wt], { cwd: s.root, stdio: 'ignore' });
  rmSync(join(out(wt, 'rev-parse', '--absolute-git-dir'), 'logs'), { recursive: true, force: true });
  rmSync(join(s.root, '.git', 'logs', 'refs', 'heads', 'claude', 'app-a'), { force: true });
  const head = init.slice(0, 7);
  const line = (o) => JSON.stringify({ session: 's1', cwd: wt, head, ...o });
  // 第一句話的版本號故意記成別的:起點是 A,拿的必須是 A 那一筆的版本號,不是第一句話的
  writeFileSync(s.log, [
    { ts: T(-20 * MIN), hook: 'UserPromptSubmit', prompt: '幫我寫規格', head: 'fffffff' },
    { ts: T(-19 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:spec` },
    { ts: T(-10 * MIN), hook: 'UserPromptSubmit', prompt: '開工' },
    { ts: T(-9 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(wt, 'src/a.js') },
  ].map(line).join('\n') + '\n');
  writeFileSync(join(wt, 'src/a.js'), 'changed\n');
  const past = new Date(Date.now() - 9 * MIN * 1000);
  utimesSync(join(wt, 'src/a.js'), past, past);
  execFileSync('git', ['commit', '-qam', '收工前存檔'], { cwd: wt, stdio: 'ignore' });
  const payload = { session_id: 's1', cwd: wt, hook_event_name: 'Stop', stop_hook_active: false };
  const d = decide({ payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('存檔之後:照樣擋,T1 缺 D', `${d?.level}|${(d?.missing ?? []).join(',')}`, 'T1|D');
  const card = cardFor({ monitorDir: s.monitorDir, path: wt, skillHome: s.home })?.card;
  eq('卡片:從叫 A 那一刻的版本算起(不是「看不全」)', `${card?.tier?.state}|${card?.base?.kind}|${card?.base?.origin?.from}`, 'ok|origin|A');
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: s.root, stdio: 'ignore' });
  s.cleanup();
}

/**
 * 危險清單那幾段共用:設定檔在 30 分鐘前存進去(git 才說得出清單哪一次定的),這一輪新增 src/fresh.js(還沒存檔)。
 * 指令一律給齊環境(P8):假的家目錄、監視器資料夾、紀錄位置;對話代號照劇本給,不吃跑測試那台電腦的。
 */
function freshScene(opts = {}) {
  const s = scene(opts);
  execFileSync('git', ['add', '.claude/pipeline-stages.json'], { cwd: s.root });
  execFileSync('git', ['commit', '-qm', '設定分級'], { cwd: s.root, env: { ...process.env, GIT_AUTHOR_DATE: T(-30 * MIN), GIT_COMMITTER_DATE: T(-30 * MIN) } });
  writeFileSync(join(s.root, 'src', 'fresh.js'), 'f\n');
  const past = new Date(Date.now() - 4 * MIN * 1000);
  utimesSync(join(s.root, 'src', 'fresh.js'), past, past);
  const cli = (args, session = null) => {
    const { CLAUDE_CODE_SESSION_ID: _drop, ...env } = process.env;
    if (session) env.CLAUDE_CODE_SESSION_ID = session;
    try { return { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: s.root, encoding: 'utf8',
      env: { ...env, HOME: s.home, PIPELINE_MONITOR_HOME: s.monitorDir, PIPELINE_MONITOR_LOG_DIR: join(s.monitorDir, 'logs') } }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout ?? '') }; }
  };
  const go = (payload = s.payload) => decide({ payload, monitorDir: s.monitorDir, skillHome: s.home });
  const lines = () => readFileSync(s.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { ...s, cli, go, lines };
}

section('危險清單定好之後才新加、沒人判斷過的程式檔:收工 hook 擋一次叫 Claude 先問人;判斷過、存檔、再改都不再問(規格:收工hook問危險清單 AC-1、AC-2、AC-4)', 'P9');
{
  const s = freshScene();
  const base = [
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '幫我加一個小功能' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Write', file: join(s.root, 'src/fresh.js') },
  ];
  s.write(base);
  const d = s.go();
  eq('擋:缺「危險清單先問人」與 D,危險清單那一項排第一(他的答案會改這一輪的等級)', (d?.missing ?? []).join(','), 'danger:ask,D');
  const r = d?.reason ?? '';
  check('理由點名那個新檔、講清單哪時定的、如果危險其實是 T2', /這一輪碰到 1 個危險清單定好（[^）]*git 說的）之後才新加、還沒人判斷過的程式檔：src\/fresh\.js/.test(r) && /其實是 T2/.test(r), r);
  check('理由叫它不要自己決定、先停下來問、三個問題、講加進清單的代價、給建議', /不要自己決定，先停下來問使用者/.test(r) && /幾天後才發現/.test(r) && /這一輪就變 T2/.test(r) && /最後一行給建議/.test(r), r);
  check('理由給兩條路:判斷了 --tier-checked、這次先不看 --tier-later(都要附原話)', /--tier-checked "使用者的原話"/.test(r) && /--tier-later "使用者的原話"/.test(r), r);
  // --tier-checked 記的是整份清單判斷過了:只問這一輪碰到的就記,沒給你看過的新檔會一起被當成判斷過(魔鬼教官第一輪,R1)
  check('理由叫它先跑 --tier-review、每一個都問,只判斷了一部分不跑 --tier-checked',
    /先跑 pipeline-status --tier-review，它列的每一個都要問/.test(r) && /整份清單判斷過了/.test(r) && /只判斷了一部分[^；]*不跑 --tier-checked/.test(r), r);
  // 只判斷了一部分:清單一改、一存檔,沒判斷的就算清單考慮過了——不替他決定,講清楚讓他選(魔鬼教官第二輪,R1)
  check('只判斷了一部分:先講清楚清單一改一存檔沒判斷的就不再問,讓他選一起判斷完或清單先不動',
    /只判斷了一部分：先跟他講清楚「清單一改、一存檔，沒判斷的那幾個就算清單考慮過了，之後不會再問」/.test(r) && /清單這次先不動/.test(r) && /清單不動、不跑 --tier-checked/.test(r), r);
  check('最後那句:「不要自己決定」那一項是先問人,不叫它先把缺的跑完', /「不要自己決定」的那一項是要你先停下來問使用者/.test(r) && !/先把缺的跑完再收工/.test(r), r);
  check('理由裡沒有程式內部值', !/null|undefined|NaN|danger:ask/.test(r), r);
  // skill 跟收工 hook 講同一套(AC-5):收工 hook 叫 Claude 跑的每一個指令,tier-setup skill 裡都有、而且有「收工 hook 問危險清單時」那一段
  const skill = readFileSync(join(ROOT, 'skills', 'tier-setup', 'SKILL.md'), 'utf8');
  const cmds = [...new Set(r.match(/pipeline-status --tier-[a-z]+ "使用者的原話"/g) ?? [])];
  check('收工 hook 叫的兩個指令,skill 裡都有;skill 有「收工 hook 問危險清單時」那一段', cmds.length === 2 && cmds.every((c) => skill.includes(c)) && /## 收工 hook 問危險清單時/.test(skill), JSON.stringify(cmds));
  const gateFlow = skill.split('## 收工 hook 問危險清單時')[1]?.split('\n## ')[0] ?? '';
  check('skill 那一段也叫它先跑 --tier-review、每一個都問,只判斷一部分不跑 --tier-checked、先講清楚存檔之後不會再問',
    /--tier-review/.test(gateFlow) && /每一個檔都要問/.test(gateFlow) && /不跑 `--tier-checked`/.test(gateFlow) && /沒判斷的那幾個就算清單考慮過了/.test(gateFlow), gateFlow);

  // 同一回合擋過了 → 不再擋(AC-7 那一條照舊);你還沒回答、下一回合又改了程式 → 再問一次
  const blocked = { ts: T(-3 * MIN), event: 'gate_blocked', missing: ['danger:ask', 'D'], source: 'gate' };
  s.write([...base, blocked]);
  eq('同一回合擋過了 → 不再擋', s.go({ ...s.payload, stop_hook_active: true }), null);
  s.write([...base, blocked, { ts: T(-2 * MIN), hook: 'UserPromptSubmit', prompt: '那個檔是做什麼的？' }]);
  eq('下一回合只是回答問題、沒改程式 → 不擋(契約 3)', s.go(), null);
  s.write([...base, blocked, { ts: T(-2 * MIN), hook: 'UserPromptSubmit', prompt: '繼續做' }, { ts: T(-1 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }]);
  writeFileSync(join(s.root, 'src/a.js'), '這一回合又改了\n');
  check('還沒回答、下一回合又改了程式 → 再問一次', (s.go()?.missing ?? []).includes('danger:ask'));

  // 判斷了:照原話記 → 不再問;判斷 → 存檔 → 再改,也不再問(以前一存檔就又變成「判斷之後才新加的」,L35)
  const ck = s.cli(['--tier-checked', 'fresh.js 只是排版，不危險'], 's1');
  check('--tier-checked 記下了', ck.code === 0 && /記下了/.test(ck.out), ck.out);
  eq('判斷過 → 只剩 D', (s.go()?.missing ?? []).join(','), 'D');
  check('判斷過了、這一輪沒有沒人判斷的新檔 → --tier-later 沒有東西可以先不看', (() => { const x = s.cli(['--tier-later', '先不看'], 's1'); return x.code === 1 && /沒有東西可以先不看/.test(x.out); })());
  execFileSync('git', ['add', 'src/fresh.js'], { cwd: s.root });
  execFileSync('git', ['commit', '-qm', '存檔'], { cwd: s.root });
  writeFileSync(join(s.root, 'src/fresh.js'), '存檔之後又改了\n');
  eq('判斷 → 存檔 → 再改:照樣只剩 D,不再問', (s.go()?.missing ?? []).join(','), 'D');
  s.cleanup();

  // 判斷結果改不了這一輪的時候安靜(AC-4):已經是最高那一級;分不出清單哪時定的
  const t2 = freshScene({ danger: true });
  t2.write([{ ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '改匯出' }, { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(t2.root, 'src/danger.js') }]);
  const dt2 = t2.go();
  check('已經是 T2(碰到危險清單)→ 照樣擋 T2 缺的,但不問危險清單', dt2 !== null && !(dt2.missing ?? []).includes('danger:ask') && dt2.level === 'T2', JSON.stringify(dt2?.missing));
  t2.cleanup();
  const blind = scene();                                                    // 設定檔沒進版控、也沒記過判斷時間 → 分不出來
  writeFileSync(join(blind.root, 'src', 'fresh.js'), 'f\n');
  blind.write([{ ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '加功能' }, { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Write', file: join(blind.root, 'src/fresh.js') }]);
  eq('分不出清單哪時定的 → 不問危險清單(分級卡照舊講分不出來)', (decide({ payload: blind.payload, monitorDir: blind.monitorDir, skillHome: blind.home })?.missing ?? []).join(','), 'D');
  blind.cleanup();
}

section('--tier-checked 記的是整份清單:記之前算出它會蓋掉哪幾個、照實列出來——收工 hook 只列這一輪碰到的,別的新檔不准不聲不響被當成判斷過(魔鬼教官第一輪,R1)');
{
  const s = freshScene();
  // 另一個新檔在這一輪開始之前就存了檔(清單定好之後才新加):這一輪沒碰到它,收工 hook 不會列它,--tier-review 會
  writeFileSync(join(s.root, 'src', 'older.js'), 'o\n');
  execFileSync('git', ['add', 'src/older.js'], { cwd: s.root });
  execFileSync('git', ['commit', '-qm', '上一輪新加的'], { cwd: s.root, env: { ...process.env, GIT_AUTHOR_DATE: T(-20 * MIN), GIT_COMMITTER_DATE: T(-20 * MIN) } });
  s.write([{ ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '加功能' }, { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Write', file: join(s.root, 'src/fresh.js') }]);
  const line = (s.go()?.reason ?? '').split('\n').find((l) => l.startsWith('- 危險清單')) ?? '';
  check('收工 hook 只列這一輪碰到的 fresh.js', /程式檔：src\/fresh\.js——/.test(line) && !line.includes('older.js'), line);
  check('--tier-review 兩個都列', /src\/older\.js/.test(s.cli(['--tier-review']).out) && /src\/fresh\.js/.test(s.cli(['--tier-review']).out));
  const ck = s.cli(['--tier-checked', '只看了 fresh.js'], 's1');
  check('--tier-checked 照實列出這一筆算判斷過的(兩個都在,含收工 hook 沒列的 older.js),並交代沒問過的要告訴使用者',
    /這一筆把 2 個之後才新加的程式檔算成判斷過了：src\/fresh\.js、src\/older\.js/.test(ck.out) && /有沒問過的，告訴使用者/.test(ck.out), ck.out);
  s.cleanup();

  // 最常見的那條路:看完清單、把 older.js 加進危險清單(還沒存檔)、記判斷——之前沒判斷過,git 又對不上剛改的清單。
  // 照上一次存檔的那份清單算:蓋掉的是 fresh.js(older.js 已經在清單上),這一行照樣要出現(魔鬼教官第二輪)
  const e = freshScene();
  writeFileSync(join(e.root, 'src', 'older.js'), 'o\n');
  execFileSync('git', ['add', 'src/older.js'], { cwd: e.root });
  execFileSync('git', ['commit', '-qm', '上一輪新加的'], { cwd: e.root, env: { ...process.env, GIT_AUTHOR_DATE: T(-20 * MIN), GIT_COMMITTER_DATE: T(-20 * MIN) } });
  const cfgPath = join(e.root, '.claude', 'pipeline-stages.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, tiers: { ...cfg.tiers, danger: [...cfg.tiers.danger, 'src/older.js'] } }));
  const ck2 = e.cli(['--tier-checked', 'older.js 加進去，fresh.js 不危險'], 's1');
  check('清單剛改過、之前沒判斷過 → 照上一次存檔的清單算,照樣列出這一筆蓋掉的(只有 fresh.js;older.js 已經在清單上)',
    /這一筆把 1 個之後才新加的程式檔算成判斷過了：src\/fresh\.js/.test(ck2.out), ck2.out);
  e.cleanup();
}

section('「這次先不看」:這個對話不再問;收工 hook 問了之後沒有你說的話,這筆不算(規格:收工hook問危險清單 AC-3)', 'P7');
{
  const s = freshScene();
  const asked = [
    { ts: T(-10 * MIN), hook: 'UserPromptSubmit', prompt: '幫我加一個小功能' },
    { ts: T(-9 * MIN), hook: 'PostToolUse', tool: 'Write', file: join(s.root, 'src/fresh.js') },
    { ts: T(-8 * MIN), event: 'gate_blocked', missing: ['danger:ask', 'D'], source: 'gate' },
  ];
  // 收工 hook 問了之後,這個對話還沒有你說的話(只有系統通知):Claude 先記了「先不看」→ 不算,照樣問
  s.write([...asked, { ts: T(-7 * MIN), hook: 'UserPromptSubmit', prompt: '<task-notification>背景工作做完了</task-notification>' }]);
  const none = s.cli(['--tier-later', '先不看'], 's1');
  check('沒有你說的話 → 記了但講「這筆不算數」、不回 0', none.code !== 0 && /這筆不算數/.test(none.out), none.out);
  // 同一回合擋過就不再擋(契約 2),所以接著你開口、下一回合又改了程式:那筆不算數的蓋不掉,照樣問
  const bad = { ...s.lines().find((e) => e.event === 'tier_later'), ts: T(-6 * MIN) };
  s.write([...asked, { ts: T(-7 * MIN), hook: 'UserPromptSubmit', prompt: '<task-notification>背景工作做完了</task-notification>' }, bad,
    { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '繼續做' }, { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }]);
  writeFileSync(join(s.root, 'src/a.js'), '又改了\n');
  check('不算數的那筆蓋不掉:下一回合照樣問', (s.go()?.missing ?? []).includes('danger:ask'));

  // 你說了「先不看」之後 Claude 才記 → 算數:這個對話不再問;紀錄是 Claude 代記、附原話、記下哪幾個檔
  s.write([...asked, { ts: T(-7 * MIN), hook: 'UserPromptSubmit', prompt: '先不看吧，做完再說' }]);
  const ok = s.cli(['--tier-later', '先不看，做完再說'], 's1');
  check('--tier-later 記下了,講這個對話不再問、換對話會再問、不是判斷過了', ok.code === 0 && /記下了/.test(ok.out) && /換一個對話/.test(ok.out) && /不是判斷過了/.test(ok.out), ok.out);
  // 「有說話」不等於「說了先不看」:附上感測器記的那一句(不是 Claude 轉述的),給人對照(魔鬼教官第一輪,P7)
  check('附上感測器記的、你說的最後一句給人對照(不是 Claude 附的那句)', /對照：感測器記的、使用者說的最後一句是「先不看吧，做完再說」/.test(ok.out), ok.out);
  const rec = s.lines().find((e) => e.event === 'tier_later');
  check('紀錄:Claude 代記、這個對話、原話、那幾個檔', rec?.via === 'claude' && rec?.by_session === 's1' && rec?.quote === '先不看，做完再說' && JSON.stringify(rec?.files) === '["src/fresh.js"]', JSON.stringify(rec));
  writeFileSync(join(s.root, 'src/a.js'), '再改一次\n');
  eq('這個對話之後又改了程式 → 不再問危險清單,只剩 D', (s.go()?.missing ?? []).join(','), 'D');
  check('設定檔沒被寫(先不看不是判斷過了)', !('checked' in (JSON.parse(readFileSync(join(s.root, '.claude', 'pipeline-stages.json'), 'utf8')).tiers ?? {})));

  // 之後又碰到別的新檔:只問新的那幾個,講另有幾個你說先不看
  writeFileSync(join(s.root, 'src', 'another.js'), 'n\n');
  const more = (s.go()?.reason ?? '').split('\n').find((l) => l.startsWith('- 危險清單')) ?? '';
  check('又來一個新檔 → 只問新的,講另有 1 個先不看', /程式檔：src\/another\.js（另有 1 個使用者說這次先不看）/.test(more) && !/src\/fresh\.js/.test(more), more);
  rmSync(join(s.root, 'src', 'another.js'));

  // 別的對話、拿不到對話代號、沒附原話、沒有東西可以先不看
  const all = s.lines();
  // 別的對話(s2)自己也開了口:s1 記的「先不看」照樣不算到 s2 頭上(不看是哪個對話記的話,s2 的那句會被拿來當它的原話)
  const s2said = { ts: T(-1 * MIN), session: 's2', cwd: s.root, hook: 'UserPromptSubmit', prompt: '我這邊繼續' };
  eq('別的對話記的不算到這個對話頭上(那個對話自己有開口也一樣)', laterOf([...all, s2said], { session: 's2', since: T(-20 * MIN) }).covered.size, 0);
  check('拿不到對話代號 → 不收,講要在對話裡由 Claude 代記', (() => { const x = s.cli(['--tier-later', '先不看'], null); return x.code === 1 && /拿不到對話代號/.test(x.out); })());
  eq('沒附原話 → 不收', s.cli(['--tier-later'], 's1').code, 1);
  s.cleanup();

  // 還沒擋過就先說了(Claude 在收工前就問了你):這一輪開始之後有你說的話就算;這一輪開始之前的話不算
  const ev = (o) => ({ session: 's1', ...o });
  const rec2 = { ts: T(-1 * MIN), event: 'tier_later', files: ['src/x.js'], quote: '先不看', by_session: 's1' };
  eq('沒擋過、這一輪開始之後有你說的話 → 算', laterOf([ev({ ts: T(-3 * MIN), hook: 'UserPromptSubmit', prompt: '先不看' }), rec2], { session: 's1', since: T(-5 * MIN) }).covered.has('src/x.js'), true);
  eq('沒擋過、你的話在這一輪開始之前 → 不算', laterOf([ev({ ts: T(-9 * MIN), hook: 'UserPromptSubmit', prompt: '先不看' }), rec2], { session: 's1', since: T(-5 * MIN) }).covered.size, 0);
}

process.exit(summary());
