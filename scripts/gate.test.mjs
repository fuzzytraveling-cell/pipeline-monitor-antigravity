/**
 * gate.test.mjs —— Antigravity Stop 收工門禁（gate.mjs / gate.sh）。
 *
 * 釘的是「會安靜出錯」與「會無限迴圈」的那幾條：
 *   ① Antigravity Stop 契約：擋回 {"decision":"continue","reason":"..."}、放行回 {} 且永遠 exit 0
 *   ② 防迴圈紅線（階段 0 事實 #6）：executionNum > 0 必放行（即使 continuationActive 為 false！）
 *   ③ 非 NO_TOOL_CALL、error、fullyIdle === false、subagent、只讀不寫（read_file）一律放行
 *   ④ transcriptPath 直接提供人類 USER_EXPLICIT 發言，即使沒有 UserPromptSubmit hook 也抓得到這一回合改了程式
 *   ⑤ T1/T2 缺關、D 之後改檔先問人、清單未對完、存檔不繞過、新對話接手舊資料夾、危險清單新檔先問人
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, utimesSync, readFileSync, symlinkSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { decide } from '../gate.mjs';
import { withLang } from '../lib/lang.mjs';
import { collectAll, cardFor } from '../lib/collect.mjs';
import { safeName } from '../lib/events.mjs';
import { sessionsOf } from '../lib/rounds.mjs';
import { laterOf } from '../lib/tier.mjs';
import { readFaults, faultState, gateHeartbeat } from '../lib/faults.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).name;
const out = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const T = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString();
const MIN = 60;

function scene({ danger = false, tests = false, at } = {}) {
  const r = makeRepo({ files: { 'src/a.js': '1\n', 'src/danger.js': 'd\n', 'docs/x.md': 'x\n', 'README.md': 'r\n' }, at });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'pipeline-stages.json'), JSON.stringify({ tiers: { code: ['src/'], danger: ['src/danger.js'] } }));
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-gate-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(ROOT, join(home, '.gemini', 'config', 'plugins', PLUGIN));
  const changed = danger ? 'src/danger.js' : 'src/a.js';
  writeFileSync(join(root, changed), 'changed\n');
  const past = new Date(Date.now() - 4 * MIN * 1000);
  utimesSync(join(root, changed), past, past);
  if (tests) { writeFileSync(join(root, 'src', 'a.test.js'), 't\n'); utimesSync(join(root, 'src', 'a.test.js'), past, past); }
  const log = join(monitorDir, 'logs', `${safeName(basename(root))}.jsonl`);
  const ev = (o) => JSON.stringify({ session: 's1', cwd: root, ...o });
  const write = (lines) => writeFileSync(log, lines.map(ev).join('\n') + '\n');
  const payload = { conversationId: 's1', cwd: root, executionNum: 0, continuationActive: false, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' };
  const cleanup = () => { for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true }); r.cleanup(); };
  return { r, root, monitorDir, home, log, ev, write, payload, changed, cleanup };
}

section('Antigravity Stop 契約：executionNum > 0 防迴圈、非 NO_TOOL_CALL / error / fullyIdle:false / subagent / read_file 放行、transcriptPath 供 prompt', 'P3');
{
  const s = scene();
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPrompt', prompt: '幫我改一下' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') },
  ]);
  const go = (payload) => decide({ payload, monitorDir: s.monitorDir, skillHome: s.home });

  check('基準：executionNum=0、NO_TOOL_CALL、fullyIdle=true → 擋', go(s.payload)?.missing?.join(',') === 'D');
  eq('executionNum=1 且 continuationActive=false（階段 0 事實 #6）→ 必放行防迴圈',
    go({ ...s.payload, executionNum: 1, continuationActive: false }), null);
  eq('continuationActive=true → 放行', go({ ...s.payload, continuationActive: true }), null);
  eq('fullyIdle=false → 放行', go({ ...s.payload, fullyIdle: false }), null);
  eq('terminationReason=USER_CANCELED → 放行', go({ ...s.payload, terminationReason: 'USER_CANCELED' }), null);
  eq('有 error → 放行', go({ ...s.payload, error: { message: 'aborted' } }), null);

  // subagent transcript step 0 為 SYSTEM_MESSAGE 含 sender= → 放行
  const subTr = join(s.monitorDir, 'sub-tr.jsonl');
  writeFileSync(subTr, `${JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: T(-5 * MIN), content: 'sender=parent-1 task' })}\n`);
  eq('subagent（transcript step 0 含 sender=）→ 放行', go({ ...s.payload, transcriptPath: subTr }), null);

  // 只用 read_file 讀程式檔（沒有實際修改檔案）→ 不算編輯、放行
  execFileSync('git', ['checkout', '-q', '--', 'src/a.js'], { cwd: s.root });
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPrompt', prompt: '讀一下 src/a.js' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'read_file', file: join(s.root, 'src/a.js') },
  ]);
  eq('只用 read_file 讀檔 → 放行', go(s.payload), null);

  // Antigravity 真實路徑：log 裡只有 PostToolUse（沒有 UserPrompt），靠 Stop payload 的 transcriptPath 補出人類發言 → 照樣擋！
  writeFileSync(join(s.root, 'src/a.js'), 'changed via transcript\n');
  const mainTr = join(s.monitorDir, 'main-tr.jsonl');
  writeFileSync(mainTr, `${JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: T(-5 * MIN), content: '請幫我改 src/a.js' })}\n`);
  s.write([{ ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') }]);
  const viaTr = go({ ...s.payload, transcriptPath: mainTr });
  eq('log 只有 PostToolUse、靠 transcriptPath 補齊人類發言 → 照樣擋（缺 D）', viaTr?.missing?.join(','), 'D');
  s.cleanup();
}

section('T1 這一回合改了程式區、D 還沒跑 → 擋一次，理由指名該叫的指令');
{
  const s = scene();
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPrompt', prompt: '幫我改一下' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') },
  ]);
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  check('擋了', d !== null, JSON.stringify(d));
  eq('缺的是 D', (d?.missing ?? []).join(','), 'D');
  check('理由說這次至少 T1、碰到程式區的哪個檔', /T1/.test(d?.reason ?? '') && /src\/a\.js/.test(d?.reason ?? ''), d?.reason);
  check('理由指名 plugin 的 chaos-check，不叫 cleanup', (d?.reason ?? '').includes(`/${PLUGIN}:chaos-check`) && !(d?.reason ?? '').includes(`/${PLUGIN}:cleanup`), d?.reason);
  check('理由裡沒有程式內部值', !/null|undefined|NaN/.test(d?.reason ?? ''), d?.reason);

  s.write([
    { ts: T(-5 * MIN), hook: 'UserPrompt', prompt: '幫我改一下' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') },
    { ts: T(-3 * MIN), hook: 'PostToolUse', tool: 'read_file', skill: `${PLUGIN}:cleanup` },
    { ts: T(-2 * MIN), hook: 'PostToolUse', tool: 'read_file', skill: 'chaos-check' },
    { ts: T(-2 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'ai' },
  ]);
  eq('C、D 都在改檔之後跑過、D 記了結論 → 放行', decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home }), null);

  s.write([
    { ts: T(-5 * MIN), hook: 'UserPrompt', prompt: '幫我改一下' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') },
    { ts: T(-3 * MIN), hook: 'PostToolUse', tool: 'read_file', skill: 'cleanup' },
    { ts: T(-3 * MIN), hook: 'PostToolUse', tool: 'read_file', skill: 'chaos-check' },
    { ts: T(-3 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'found', note: '找到 1 條', source: 'ai' },
  ]);
  writeFileSync(join(s.root, 'src/a.js'), 'changed again\n');
  const again = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('D 之後又改了 → 只缺「D 先問人」', (again?.missing ?? []).join(','), 'D:ask');
  check('理由說要不要再跑由使用者決定、不要自己再跑、他說不用就 --decide',
    /要不要再跑由你決定/.test(again?.reason ?? '') && /不要自己再跑/.test(again?.reason ?? '') && /--decide D skip/.test(again?.reason ?? ''), again?.reason);
  check('最後那句不叫它「先把缺的跑完」', !/先把缺的跑完再收工/.test(again?.reason ?? '') && /先停下來問使用者/.test(again?.reason ?? ''), again?.reason);
  s.cleanup();
}

section('英文那一份：收工 hook 講「還沒跑 → 跑哪個指令」，不寫成 failed／error；D 過期了叫它先問人', 'P10');
{
  const s = scene();
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPrompt', prompt: 'please change it' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') },
  ]);
  const zh = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  const d = withLang('en', () => decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home }));
  eq('擋的種類跟中文一樣', (d?.missing ?? []).join(','), (zh?.missing ?? []).join(','));
  const head = (d?.reason ?? '').split('\n')[0], line = (d?.reason ?? '').split('\n').find((l) => l.startsWith('- D ')) ?? '';
  check('第一行英文正確', /^\[Pipeline Monitor\] This change is at least T1 \(touched the code area: src\/a\.js/.test(head) && /Still missing before wrapping up:$/.test(head), head);
  check('D 那一句含 plugin 的 chaos-check 與跑法', line.includes(`not run yet this round → run /${PLUGIN}:chaos-check`) && /look yourself, don't send agents/.test(line), line);
  check('不寫成 failed／error／passed', !/\bfail(ed|s)?\b|\berror\b|\bpass(ed)?\b/i.test(line), line);
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPrompt', prompt: 'please change it' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') },
    { ts: T(-3 * MIN), hook: 'PostToolUse', tool: 'read_file', skill: 'chaos-check' },
    { ts: T(-3 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'found', note: 'Found 1', source: 'ai' },
  ]);
  writeFileSync(join(s.root, 'src/a.js'), 'changed again\n');
  const again = withLang('en', () => decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home }));
  const ask = (again?.reason ?? '').split('\n').find((l) => l.startsWith('- D ')) ?? '';
  eq('D 之後又改了 → D:ask', (again?.missing ?? []).join(','), 'D:ask');
  check('英文 D:ask 講 --decide D skip', /whether to run it again is your call/.test(ask) && /--decide D skip "the user's own words"/.test(ask), ask);
  s.cleanup();
}

section('用終端機寫檔繞過感測器：靠檔案修改時間也認得出這一回合改了（L8）');
{
  const s = scene();
  writeFileSync(join(s.root, 'src/a.js'), 'shell wrote this\n');
  s.write([{ ts: T(-5 * MIN), hook: 'UserPrompt', prompt: '用終端機改' }]);
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  check('沒有 edit_file 事件也擋', d !== null && d.missing.includes('D'), JSON.stringify(d));
  s.cleanup();
}

section('不該擋的一律放行');
{
  const s = scene();
  const base = [{ ts: T(-5 * MIN), hook: 'UserPrompt', prompt: 'hi' }, { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') }];
  s.write(base);
  const go = (payload = s.payload, extra = {}) => decide({ payload, monitorDir: s.monitorDir, skillHome: s.home, ...extra });
  eq('payload 壞掉 → 放行', go('不是物件'), null);
  eq('沒有 conversationId → 放行', go({ cwd: s.root }), null);
  eq('cwd 不存在 → 放行', go({ ...s.payload, cwd: '/沒有這個資料夾' }), null);
  s.write([{ ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') }, { ts: T(-1 * MIN), hook: 'UserPrompt', prompt: '這個怎麼用?' }]);
  eq('這一回合只是回答問題 → 放行', go(), null);
  s.write([{ ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') }]);
  eq('沒有任何人類發言 → 放行', go(), null);
  writeFileSync(join(s.root, 'src/a.js'), '1\n');
  const old = new Date(Date.now() - 60 * MIN * 1000); utimesSync(join(s.root, 'src/a.js'), old, old);
  writeFileSync(join(s.root, 'docs/x.md'), 'docs only\n');
  s.write([{ ts: T(-5 * MIN), hook: 'UserPrompt', prompt: 'hi' }, { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'docs/x.md') }]);
  eq('只改到文件 → T0，放行', go(), null);
  writeFileSync(join(s.root, 'src/a.js'), 'changed\n');
  s.write(base);
  unlinkSync(join(s.root, '.agents', 'pipeline-stages.json'));
  eq('沒設定分級 → 放行', go(), null);
  writeFileSync(join(s.root, '.agents', 'pipeline-stages.json'), JSON.stringify({ tiers: { code: ['src/'], danger: [] } }));
  const emptyHome = mkdtempSync(join(tmpdir(), 'pm-home-empty-'));
  eq('指令不存在 → 放行', go(s.payload, { skillHome: emptyHome }), null);
  rmSync(emptyHome, { recursive: true, force: true });
  writeFileSync(join(s.root, '.agents', 'pipeline-monitor.off'), '{}');
  eq('退出記錄 → 放行', go(), null);
  unlinkSync(join(s.root, '.agents', 'pipeline-monitor.off'));
  s.cleanup();
}

section('T2：碰到危險清單 → 還要 A 與測試檔；專案自己有同名技能就叫它的');
{
  const s = scene({ danger: true });
  s.write([{ ts: T(-5 * MIN), hook: 'UserPrompt', prompt: 'hi' }, { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/danger.js') }]);
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('缺 A、C、D、測試檔', (d?.missing ?? []).join(','), 'A,C,D,tests');
  writeFileSync(join(s.root, 'src/a.js'), '也改了\n');
  const mixed = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home })?.reason ?? '';
  check('危險檔與程式區檔分開列', /碰到危險清單：src\/danger\.js；另外碰到程式區 1 個檔/.test(mixed) && !/危險清單：[^；）]*src\/a\.js/.test(mixed), mixed);
  execFileSync('git', ['checkout', '-q', '--', 'src/a.js'], { cwd: s.root });
  mkdirSync(join(s.root, '.agents', 'skills', 'chaos-check'), { recursive: true });
  writeFileSync(join(s.root, '.agents', 'skills', 'chaos-check', 'SKILL.md'), '# 自己的\n');
  const d2 = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  check('專案自己有 .agents/skills/chaos-check → 理由叫它的', /跑 \/chaos-check/.test(d2?.reason ?? '') && !(d2?.reason ?? '').includes(`/${PLUGIN}:chaos-check`), d2?.reason);
  s.cleanup();
}
{
  const s = scene({ danger: true, tests: true });
  s.write([
    { ts: T(-5 * MIN), hook: 'UserPrompt', prompt: `/${PLUGIN}:spec 做東西` },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/danger.js') },
    { ts: T(-3 * MIN), hook: 'PostToolUse', tool: 'read_file', skill: 'cleanup' },
    { ts: T(-3 * MIN), hook: 'PostToolUse', tool: 'read_file', skill: 'chaos-check' },
    { ts: T(-3 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'ai' },
  ]);
  eq('A 打過、C D 跑過、有測試檔 → 放行', decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home }), null);
  s.cleanup();
}

section('整條路真的跑一次：sh gate.sh → node gate.mjs。擋回 decision=continue；放行回 {} 且 exit 0', 'P3');
{
  const s = scene();
  s.write([{ ts: T(-5 * MIN), hook: 'UserPrompt', prompt: 'hi' }, { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') }]);
  const env = { ...process.env, AGY_PIPELINE_HOME: s.monitorDir, AGY_PIPELINE_LOG_DIR: join(s.monitorDir, 'logs'), HOME: s.home };
  const run = (payload) => execFileSync('sh', [join(ROOT, 'gate.sh')], { input: JSON.stringify(payload), env, encoding: 'utf8' });
  const outText = run(s.payload);
  let parsed = null; try { parsed = JSON.parse(outText); } catch { parsed = null; }
  check('擋：印出 JSON，decision=continue，reason 是白話', parsed?.decision === 'continue' && /收工前還缺/.test(parsed?.reason ?? ''), outText.slice(0, 200));
  const events = readFileSync(s.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const blocked = events.find((e) => e.event === 'gate_blocked');
  check('留下 gate_blocked（source:gate），缺 D', blocked?.source === 'gate' && blocked?.missing?.join(',') === 'D', JSON.stringify(blocked));
  eq('放行（executionNum=1）：印出 {}', run({ ...s.payload, executionNum: 1 }).trim(), '{}');
  let hb = null; try { hb = JSON.parse(readFileSync(join(s.monitorDir, 'logs', '_gate.json'), 'utf8')); } catch { hb = null; }
  check('每次跑都留心跳 logs/_gate.json（含 cwd）', !!hb?.ts && hb?.cwd === s.root, JSON.stringify(hb));
  eq('壞掉的輸入：印出 {}、不炸', run({}).trim(), '{}');
  check('壞掉的輸入不留故障記號', !existsSync(join(s.monitorDir, 'logs', '_sensor.jsonl')));
  s.cleanup();
}

section('有規格的輪次：清單未對完 → 擋；存檔不繞過；共用工作區同一級；刪檔／搬檔照抓');
{
  const s = scene();
  mkdirSync(join(s.root, 'docs', '規劃中'), { recursive: true });
  const spec = join(s.root, 'docs', '規劃中', 'x.md');
  writeFileSync(spec, '# 功能：x\n**AC-1　一**\n**AC-2　二** ✅ 對過 2026-11-20\n');
  s.write([
    { ts: T(-6 * MIN), hook: 'UserPrompt', prompt: `/${PLUGIN}:spec 做 x` },
    { ts: T(-6 * MIN), hook: 'PostToolUse', tool: 'write_file', file: spec },
    { ts: T(-5 * MIN), hook: 'UserPrompt', prompt: '好，開工' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s.root, 'src/a.js') },
    { ts: T(-3 * MIN), hook: 'PostToolUse', tool: 'read_file', skill: 'cleanup' },
    { ts: T(-3 * MIN), hook: 'PostToolUse', tool: 'read_file', skill: 'chaos-check' },
    { ts: T(-3 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'ai' },
  ]);
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  check('只剩清單沒對完 → 擋，點名 AC-1', d?.missing?.join(',') === 'checklist' && /AC-1/.test(d?.reason ?? '') && !/AC-2/.test(d?.reason ?? ''), d?.reason);
  writeFileSync(spec, '# 功能：x\n**AC-1　一** ⏳ 待討論：要問人\n**AC-2　二** ✅ 對過 2026-11-20\n');
  eq('都標了 → 放行', decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home }), null);
  s.cleanup();

  // 沒章存檔照樣擋
  const s2 = scene({ danger: true, at: T(-60 * MIN) });
  s2.write([
    { ts: T(-5 * MIN), hook: 'UserPrompt', prompt: '改一下匯出' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'edit_file', file: join(s2.root, 'src/danger.js') },
    { ts: T(-3 * MIN), hook: 'PostToolUse', tool: 'read_file', skill: 'chaos-check' },
    { ts: T(-3 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'ai' },
  ]);
  execFileSync('git', ['add', '-A'], { cwd: s2.root });
  execFileSync('git', ['commit', '-qm', '收工前存檔'], { cwd: s2.root });
  const after = decide({ payload: s2.payload, monitorDir: s2.monitorDir, skillHome: s2.home });
  eq('存檔之後照樣擋（缺 A,C,tests）', after?.missing?.join(','), 'A,C,tests');
  s2.cleanup();

  // git mv 搬走危險檔 → T2
  const s3 = scene();
  execFileSync('git', ['checkout', '-q', '--', 'src/a.js'], { cwd: s3.root });
  mkdirSync(join(s3.root, 'src', 'moved'), { recursive: true });
  execFileSync('git', ['mv', 'src/danger.js', 'src/moved/danger.js'], { cwd: s3.root });
  execFileSync('git', ['commit', '-qm', '搬家'], { cwd: s3.root });
  s3.write([{ ts: T(-5 * MIN), hook: 'UserPrompt', prompt: '整理資料夾' }]);
  eq('搬走危險檔 → T2', decide({ payload: s3.payload, monitorDir: s3.monitorDir, skillHome: s3.home })?.level, 'T2');
  s3.cleanup();
}

function reuseScene() {
  const cfg = JSON.stringify({ tiers: { code: ['src/'], danger: ['src/danger.js'] } });
  const r = makeRepo({ files: { 'src/a.js': '1\n', 'src/danger.js': 'd\n', 'README.md': 'r\n', '.agents/pipeline-stages.json': cfg }, at: T(-300 * MIN) });
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
  g(root, T(-200 * MIN), 'checkout', '-q', '--detach');
  writeFileSync(join(r.dir, 'src/danger.js'), '別的對話的改動\n');
  g(r.dir, T(-100 * MIN), 'commit', '-qam', '別的對話併進 main');
  g(root, T(-10 * MIN), 'checkout', '-q', '-b', 'new', main);
  writeFileSync(join(root, 'src/a.js'), 's1 的改動\n');
  const past = new Date(Date.now() - 4 * MIN * 1000);
  utimesSync(join(root, 'src/a.js'), past, past);
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(ROOT, join(home, '.gemini', 'config', 'plugins', PLUGIN));
  const log = join(monitorDir, 'logs', `${project}.jsonl`);
  const old = [
    { ts: T(-239 * MIN), hook: 'UserPrompt', session: 's0', prompt: '改匯出' },
    { ts: T(-238 * MIN), hook: 'PostToolUse', tool: 'read_file', session: 's0', skill: 'spec' },
    { ts: T(-236 * MIN), hook: 'PostToolUse', tool: 'edit_file', session: 's0', file: join(root, 'src/danger.js') },
    { ts: T(-235 * MIN), hook: 'PostToolUse', tool: 'read_file', session: 's0', skill: 'cleanup' },
    { ts: T(-234 * MIN), event: 'stage_report', stage: 'C', verdict: 'ok', note: '列了建議', source: 'ai' },
    { ts: T(-233 * MIN), hook: 'PostToolUse', tool: 'read_file', session: 's0', skill: 'chaos-check' },
    { ts: T(-232 * MIN), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'ai' },
  ];
  const write = (lines) => writeFileSync(log, [...old, ...lines].map((o) => JSON.stringify({ cwd: root, ...o })).join('\n') + '\n');
  const payload = { conversationId: 's1', cwd: root, executionNum: 0, continuationActive: false, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' };
  const env = { ...process.env, AGY_PIPELINE_HOME: monitorDir, AGY_PIPELINE_LOG_DIR: join(monitorDir, 'logs'), HOME: home, ANTIGRAVITY_CONVERSATION_ID: '' };
  const cli = () => execFileSync('node', [join(ROOT, 'status.mjs')], { cwd: root, encoding: 'utf8', env });
  const cleanup = () => {
    execFileSync('git', ['worktree', 'remove', '--force', root], { cwd: r.dir, stdio: 'ignore' });
    for (const d of [monitorDir, home, wtParent]) rmSync(d, { recursive: true, force: true });
    r.cleanup();
  };
  return { root, monitorDir, home, project, g, write, payload, cli, cleanup };
}

section('新對話接手舊資料夾：從接手那一刻算（T1、只要 D；上一手的章與關卡都不算）', 'P6');
{
  const s = reuseScene();
  const mine = [
    { ts: T(-10 * MIN + 1), hook: 'UserPrompt', session: 's1', prompt: '整理一下程式' },
    { ts: T(-5 * MIN), hook: 'PostToolUse', tool: 'edit_file', session: 's1', file: join(s.root, 'src/a.js') },
  ];
  s.write(mine);
  const d = decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home });
  eq('收工 hook：T1、只缺 D', `${d?.level}|${(d?.missing ?? []).join(',')}`, 'T1|D');
  const p = collectAll({ monitorDir: s.monitorDir, skillHome: s.home }).projects[0];
  const c = p?.cards.find((x) => x.path === s.root);
  eq('儀表板：還沒有還原點、1 個檔', `${c?.checkpoint}|${c?.files?.total}`, 'null|1');
  eq('收工 hook 紀錄裡只有這一手的對話',
    sessionsOf(cardFor({ monitorDir: s.monitorDir, path: s.root, skillHome: s.home }).events).filter((x) => x.cwd === s.root).map((x) => x.id).join(','), 's1');
  s.write([...mine,
    { ts: T(-2 * MIN), hook: 'PostToolUse', tool: 'read_file', session: 's1', skill: 'chaos-check' },
    { ts: T(-2 * MIN + 10), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'ai' },
  ]);
  eq('這一手跑了 D 記了結論 → 放行', decide({ payload: s.payload, monitorDir: s.monitorDir, skillHome: s.home }), null);
  s.cleanup();
}

function freshScene(opts = {}) {
  const s = scene(opts);
  execFileSync('git', ['add', '.agents/pipeline-stages.json'], { cwd: s.root });
  execFileSync('git', ['commit', '-qm', '設定分級'], { cwd: s.root, env: { ...process.env, GIT_AUTHOR_DATE: T(-30 * MIN), GIT_COMMITTER_DATE: T(-30 * MIN) } });
  writeFileSync(join(s.root, 'src', 'fresh.js'), 'f\n');
  const past = new Date(Date.now() - 4 * MIN * 1000);
  utimesSync(join(s.root, 'src', 'fresh.js'), past, past);
  const cli = (args, session = null) => {
    const { ANTIGRAVITY_CONVERSATION_ID: _drop, ...env } = process.env;
    if (session) env.ANTIGRAVITY_CONVERSATION_ID = session;
    try { return { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: s.root, encoding: 'utf8',
      env: { ...env, HOME: s.home, AGY_PIPELINE_HOME: s.monitorDir, AGY_PIPELINE_LOG_DIR: join(s.monitorDir, 'logs') } }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout ?? '') }; }
  };
  const go = (payload = s.payload) => decide({ payload, monitorDir: s.monitorDir, skillHome: s.home });
  const lines = () => readFileSync(s.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { ...s, cli, go, lines };
}

section('危險清單定好之後才新加的程式檔：收工 hook 先問人；判斷過／先不看（--tier-checked / --tier-later）', 'P9');
{
  const s = freshScene();
  const base = [
    { ts: T(-5 * MIN), hook: 'UserPrompt', prompt: '幫我加一個小功能' },
    { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'write_file', file: join(s.root, 'src/fresh.js') },
  ];
  s.write(base);
  const d = s.go();
  eq('擋：danger:ask 排第一，再來 D', (d?.missing ?? []).join(','), 'danger:ask,D');
  const r = d?.reason ?? '';
  check('理由指明 agy-pipeline --tier-review、--tier-checked、--tier-later',
    /先跑 agy-pipeline --tier-review/.test(r) && /agy-pipeline --tier-checked "使用者的原話"/.test(r) && /agy-pipeline --tier-later "使用者的原話"/.test(r), r);
  const skill = readFileSync(join(ROOT, 'skills', 'tier-setup', 'SKILL.md'), 'utf8');
  const cmds = [...new Set(r.match(/agy-pipeline --tier-[a-z]+ "使用者的原話"/g) ?? [])];
  check('收工 hook 叫的兩個指令，tier-setup skill 裡都有', cmds.length === 2 && cmds.every((c) => skill.includes(c)), JSON.stringify(cmds));

  // 沒人說過話 → --tier-later 不算數
  s.write([...base, { ts: T(-3 * MIN), event: 'gate_blocked', missing: ['danger:ask', 'D'], source: 'gate' }]);
  check('收工 hook 問了之後沒有人開口 → --tier-later 不算數', s.cli(['--tier-later', '先不看'], 's1').code !== 0);

  // 人說了「先不看」→ 算數，記為 via:'ai'
  s.write([...base, { ts: T(-3 * MIN), event: 'gate_blocked', missing: ['danger:ask', 'D'], source: 'gate' },
    { ts: T(-2 * MIN), hook: 'UserPrompt', prompt: '先不看吧，做完再說' }]);
  const okLater = s.cli(['--tier-later', '先不看，做完再說'], 's1');
  check('--tier-later 記下，via=ai', okLater.code === 0 && s.lines().find((e) => e.event === 'tier_later')?.via === 'ai', okLater.out);
  writeFileSync(join(s.root, 'src/a.js'), '再改一次\n');
  eq('這個對話不再問危險清單，只剩 D', (s.go()?.missing ?? []).join(','), 'D');
  eq('別的對話 s2 照樣不繼承 s1 的先不看', laterOf([...s.lines(), { ts: T(-1 * MIN), session: 's2', cwd: s.root, hook: 'UserPrompt', prompt: '繼續' }], { session: 's2', since: T(-20 * MIN) }).covered.size, 0);

  // --tier-checked 記下快照 → 存檔再改也不再問
  const ck = s.cli(['--tier-checked', 'fresh.js 只是排版，不危險'], 's1');
  check('--tier-checked 記下了', ck.code === 0 && /記下了/.test(ck.out), ck.out);
  execFileSync('git', ['add', 'src/fresh.js'], { cwd: s.root });
  execFileSync('git', ['commit', '-qm', '存檔'], { cwd: s.root });
  writeFileSync(join(s.root, 'src/fresh.js'), '存檔之後又改了\n');
  eq('判斷 → 存檔 → 再改：只剩 D，不再問', (s.go()?.missing ?? []).join(','), 'D');

  // 空字串 cwd="" 退回 workspacePaths[0]：_gate.json 心跳照記正確 cwd（P2）
  execFileSync('sh', [join(ROOT, 'gate.sh')], {
    input: JSON.stringify({ conversationId: 's1', cwd: '', workspacePaths: [s.root], terminationReason: 'NO_TOOL_CALL', fullyIdle: true, executionNum: 0 }),
    env: { ...process.env, AGY_PIPELINE_HOME: s.monitorDir },
    encoding: 'utf8',
  });
  const hb = JSON.parse(readFileSync(join(s.monitorDir, 'logs', '_gate.json'), 'utf8'));
  eq('gate.mjs 遇空 cwd 退回 workspacePaths[0] 寫進心跳', hb.cwd, s.root);
  s.cleanup();
}

section('收工 hook（gate.sh）按資料夾留心跳（byCwd）：切到別的專案不讓已恢復的 gate_broken 復活', 'P3');
{
  const s1 = scene();
  const r2 = makeRepo({ files: { 'b.js': '1\n' } });
  const logDir = join(s1.monitorDir, 'logs');
  writeFileSync(join(logDir, '_sensor.jsonl'),
    JSON.stringify({ ts: T(-120), event: 'gate_broken', why: 'boom', cwd: s1.root }) + '\n');
  const { ANTIGRAVITY_CONVERSATION_ID: _drop, ...baseEnv } = process.env;
  const env = { ...baseEnv, HOME: s1.home, AGY_PIPELINE_HOME: s1.monitorDir, AGY_PIPELINE_LOG_DIR: logDir, AGY_PIPELINE_CODE_HOME: ROOT };
  execFileSync('sh', [join(ROOT, 'gate.sh')], {
    input: JSON.stringify({ conversationId: 's1', cwd: s1.root, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, executionNum: 0 }),
    env, encoding: 'utf8',
  });
  execFileSync('sh', [join(ROOT, 'gate.sh')], {
    input: JSON.stringify({ conversationId: 's2', cwd: r2.dir, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, executionNum: 0 }),
    env, encoding: 'utf8',
  });
  const hb = gateHeartbeat(logDir);
  check('_gate.json 的 byCwd 同時保有兩個資料夾的心跳',
    Boolean(hb?.byCwd?.[s1.root]) && Boolean(hb?.byCwd?.[r2.dir]), JSON.stringify(hb));
  eq('切去 r2 跑完 gate.sh 後，s1.root 的 gateError 仍維持 recovered（不復活）',
    faultState({ faults: readFaults(logDir), heartbeat: hb, retainDays: 90 }).gateError?.state, 'recovered');
  r2.cleanup();
  s1.cleanup();
}

section('gate.sh 找不到 node 且 $LOGS 尚未建立：自動建 $LOGS 並記 gate_broken + 輸出 {}', 'P8');
{
  const noNodeDir = mkdtempSync(join(tmpdir(), 'pm-gate-nonode-'));
  const fakeBin = join(noNodeDir, 'bin');
  const freshLogs = join(noNodeDir, 'fresh', 'logs');
  mkdirSync(fakeBin, { recursive: true });
  for (const cmd of ['dirname', 'mkdir', 'date']) {
    const src = ['/usr/bin', '/bin'].map((d) => join(d, cmd)).find((p) => existsSync(p));
    if (src) symlinkSync(src, join(fakeBin, cmd));
  }
  const fakeSh = join(noNodeDir, 'gate.sh');
  const origSh = readFileSync(join(ROOT, 'gate.sh'), 'utf8')
    .replace('/opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node', '/nonexistent/no-node-here');
  writeFileSync(fakeSh, origSh, { mode: 0o755 });
  const res = spawnSync('/bin/sh', [fakeSh], {
    input: JSON.stringify({ cwd: noNodeDir }),
    env: { PATH: fakeBin, HOME: noNodeDir, AGY_PIPELINE_LOG_DIR: freshLogs },
    encoding: 'utf8',
  });
  eq('缺 node → exit 0', res.status, 0);
  eq('缺 node → 輸出 {}', (res.stdout || '').trim(), '{}');
  check('缺 node 且 $LOGS 不存在 → 自動建立 $LOGS 並記 gate_broken (why: 找不到 node)',
    existsSync(join(freshLogs, '_sensor.jsonl'))
    && readFaults(freshLogs).some((x) => x.event === 'gate_broken' && x.why === '找不到 node'));
  rmSync(noNodeDir, { recursive: true, force: true });
}

process.exit(summary());
