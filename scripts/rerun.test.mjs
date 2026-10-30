/**
 * rerun.test.mjs —— D 多輪先問人(路徑看 CLAUDE.md 的表)
 *
 * 第一輪 D 照分級自動跑;這一輪要再跑,先停下來問人;你說不用,記下你的話;再跑只看第一輪之後改的檔。釘的是會安靜說謊、安靜燒錢的地方:
 *   ① 背景工作的通知被當成你說的話:收工 hook 把回合的開始挪晚、放行;訊息數多算;通知被當成你說不用再跑的那句(AC-8,老毛病 P7)
 *   ② 「要不要再跑」四處各算一次、講不同的話;比的是結論時間不是 D 被叫的時間(AC-9,P2)
 *   ③ 收工 hook 同一件事擋很多次(迴圈)、或記不了紀錄還一直擋;叫了 D 沒記結論沒人提醒(AC-6、AC-7)
 *   ④ Claude 記「你說不用」卻沒問你:D 之後沒有你說的話也算數;你那句話之後又改的也被蓋掉(AC-4、AC-5)
 *   ⑤ 再跑卻重讀整批、或漏掉存過檔的改動;拿不到清單卻假裝只看了幾個(AC-10、AC-12,P1)
 *   ⑥ 花了多久估一個數字;還在跑的那一次也印時間(AC-3、AC-13,R3)
 *   ⑦ skill 裡又出現「處理完再跑一次」(AC-1)——那一句就是 9/17 自己連跑三輪的原因
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, utimesSync, readFileSync, symlinkSync, existsSync, appendFileSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { withLang } from '../lib/lang.mjs';
import { decide } from '../gate.mjs';
import { collectAll } from '../lib/collect.mjs';
import { safeName } from '../lib/events.mjs';
import { sessionsOf, firstPromptsOf, saidByHuman, promptKind, rerunOf, rerunLine, tookLine, pairRuns, runMode } from '../lib/rounds.mjs';
import { stageLine } from '../lib/stageLines.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name;
const MIN = 60;
// 測試裡的「現在」只取一次(LESSONS L18)
const NOW = Date.now();
const T = (sec) => new Date(NOW + sec * 1000).toISOString();
const at = (sec) => new Date(NOW + sec * 1000);
const out = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
// 真實紀錄裡的形狀(2026-09-22 07:20 那一筆):開頭是 <task-notification>,prompt_id 沿用前一句人話的
const NOTE = '<task-notification>\n<task-id>bzmadxzef</task-id>\n<tool-use-id>toolu_019PsbFpKLqvHrhpjNEVTu1g</tool-use-id>\n<output-file>/private/tmp/claude-501/x';

/**
 * 一個有分級設定的專案(src/ 是程式區,src/danger.js 在危險清單)、假的監視器資料夾(stages.json、logs/)、裝了 plugin 的假 home。
 * 專案比劇本裡的每一句話都早存在(一小時前),「這次改動」才有起點的版本可比(規格:這一輪的起點)。
 */
function scene({ danger = true, tiers = undefined } = {}) {
  // 分級設定跟著專案存進版本(真的專案就是這樣),不然它自己會被算成「這一輪改了的檔」
  const cfg = tiers === null ? {} : { '.claude/pipeline-stages.json': JSON.stringify({ tiers: tiers ?? { code: ['src/'], danger: danger ? ['src/danger.js'] : [] } }) };
  const r = makeRepo({ at: T(-60 * MIN), files: {
    'src/a.js': '1\n', 'src/c.js': 'c\n', 'src/old.js': 'old\n', 'src/danger.js': 'd\n', 'src/util/save.js': 's\n', 'docs/x.md': 'x\n', 'README.md': 'r\n', ...cfg,
  } });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-rerun-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(ROOT, join(home, '.claude', 'skills', PLUGIN));
  const logDir = join(monitorDir, 'logs');
  const log = join(logDir, `${safeName(basename(root))}.jsonl`);
  const head = () => out(root, 'rev-parse', '--short', 'HEAD');
  const line = (o) => JSON.stringify({ session: 's1', cwd: root, ...o });
  const write = (lines) => writeFileSync(log, lines.map(line).join('\n') + '\n');
  const append = (lines) => appendFileSync(log, lines.map(line).join('\n') + '\n');
  const events = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  /** 改一個檔,修改時間放在 sec 秒前/後(用 Bash 寫的:感測器看不到)。 */
  const touch = (f, sec, body = `changed ${sec}\n`) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), body); utimesSync(join(root, f), at(sec), at(sec)); };
  // 跑真的 CLI。HOME 一定要給這個假的(L24);對話代號從環境變數給,session=null 就拿掉
  const cli = (args, { session = 's1', cwd = root } = {}) => {
    const { CLAUDE_CODE_SESSION_ID: _drop, ...env } = process.env;
    if (session) env.CLAUDE_CODE_SESSION_ID = session;
    try { return { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...env, HOME: home, PIPELINE_MONITOR_HOME: monitorDir, PIPELINE_MONITOR_LOG_DIR: logDir } }) }; }
    catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
  };
  const gate = ({ sid = 's1', again = false, cwd = root } = {}) => decide({ payload: { session_id: sid, cwd, hook_event_name: 'Stop', stop_hook_active: again }, monitorDir, skillHome: home });
  const project = () => collectAll({ monitorDir, skillHome: home, appTitles: new Map() }).projects[0];
  const sessionOf = (sid = 's1') => project()?.sessions.find((s) => s.id === sid) ?? null;
  const dOf = (sid = 's1') => sessionOf(sid)?.stages?.find((x) => x.id === 'D') ?? null;
  const dRow = (sid = 's1') => sessionOf(sid)?.tier?.requirements?.find((x) => x.key === 'D') ?? null;
  const cleanup = () => { for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true }); r.cleanup(); };
  return { root, monitorDir, home, log, logDir, head, write, append, events, touch, cli, gate, project, sessionOf, dOf, dRow, cleanup };
}

/** D 被叫(Claude 走 Skill 工具)那一筆:帶著那一刻的版本(感測器記的 head)。 */
const callD = (sec, head, extra = {}) => ({ ts: T(sec), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:chaos-check`, head, ...extra });
const report = (sec, verdict = 'found', note = '找到 1 條', extra = {}) => ({ ts: T(sec), event: 'stage_report', stage: 'D', verdict, note, source: 'claude', ...extra });
const said = (sec, prompt, extra = {}) => ({ ts: T(sec), hook: 'UserPromptSubmit', prompt, prompt_id: `p${sec}`, ...extra });

section('AC-8:背景工作的通知不是你說的話——不重算回合、不算訊息數(9/22 07:20 那一筆的形狀)', 'P7');
{
  check('通知不是人說的', saidByHuman({ hook: 'UserPromptSubmit', prompt: NOTE }) === false);
  check('你打的字是', saidByHuman({ hook: 'UserPromptSubmit', prompt: '不用跑了' }) === true);
  check('空的一句也是你按的(不是系統塞的)', saidByHuman({ hook: 'UserPromptSubmit', prompt: '' }) === true);
  check('你貼一段通知進來問(開頭是你打的字)照樣算你說的', saidByHuman({ hook: 'UserPromptSubmit', prompt: `這是什麼？${NOTE}` }) === true);
  check('工具呼叫不是一句話', saidByHuman({ hook: 'PreToolUse', prompt: '不用跑了' }) === false);

  // 07:20 那一次:改完程式、D 過期,背景測試跑完的通知進來,收工 hook 把回合的開始當成通知 → 放行
  const s = scene();
  const h = s.head();
  s.write([
    said(-10 * MIN, '修一下'),
    callD(-9 * MIN, h),
    report(-8 * MIN),
    { ts: T(-3 * MIN), hook: 'UserPromptSubmit', prompt: NOTE, prompt_id: `p${-10 * MIN}` },
  ]);
  s.touch('src/danger.js', -7 * MIN);                                     // 用 Bash 修的:感測器看不到,只有檔案時間
  const d = s.gate();
  check('擋了:回合從你說的最後一句算,通知不算——修檔在通知之前也看得到', d !== null && d.missing.includes('D:ask'), JSON.stringify(d));
  // 對照:同一個時間點如果是你說了一句話,這一回合確實沒改程式,照規矩放行(契約 3)
  s.write([said(-10 * MIN, '修一下'), callD(-9 * MIN, h), report(-8 * MIN), said(-3 * MIN, '好')]);
  eq('換成你說的一句話 → 這一回合真的沒改程式,放行', s.gate(), null);
  eq('「N 則訊息」只數你說的(1 句話 + 1 則通知 = 1)', sessionsOf([said(-10 * MIN, '修一下'), { ts: T(-3 * MIN), hook: 'UserPromptSubmit', prompt: NOTE }].map((e) => ({ session: 's1', cwd: '/x', ...e })))[0].prompts, 1);
  const fp = firstPromptsOf([{ ts: T(-10 * MIN), hook: 'UserPromptSubmit', session: 's9', prompt: NOTE }, { ts: T(-9 * MIN), hook: 'UserPromptSubmit', session: 's9', prompt: '真正的第一句' }]);
  eq('第一句話不會是通知', fp.get('s9')?.prompt, '真正的第一句');
  s.cleanup();
}

section('AC-9:「要不要再跑」只算一次——比的是 D 被叫的時間,不是結論記下的時間;存檔不算改檔', 'P2');
{
  const call = { ts: T(-10 * MIN), session: 's1' };
  const late = rerunOf({ calls: [call], reports: [report(-2 * MIN, 'ok', '沒對到')], lastEdit: T(-5 * MIN) });
  eq('修完才記「沒問題」:改檔在 D 被叫之後 → 要不要再跑由你決定', late.state, 'ask');
  eq('改檔在 D 被叫之前 → Claude 說沒問題就是沒問題', rerunOf({ calls: [call], reports: [report(-2 * MIN, 'ok')], lastEdit: T(-11 * MIN) }).state, 'ok');
  eq('跟 D 被叫同一秒(兩秒誤差裡)的改檔不算之後——感測器的時間只到秒', rerunOf({ calls: [call], reports: [report(-2 * MIN, 'ok')], lastEdit: new Date(NOW - 10 * MIN * 1000 + 1500).toISOString() }).state, 'ok');
  eq('叫了還沒記結論 → no-report(不管之後有沒有改)', rerunOf({ calls: [call], reports: [], lastEdit: T(-5 * MIN) }).state, 'no-report');
  eq('這一輪沒叫過 → none', rerunOf({ calls: [], reports: [report(-2 * MIN)] }).state, 'none');

  // D 說沒問題之後你只說 commit:三處都還是沒問題(存檔不是改檔)
  const s = scene();
  s.touch('src/danger.js', -9 * MIN);
  s.write([said(-10 * MIN, '修一下'), callD(-8 * MIN, s.head()), report(-7 * MIN, 'ok', '沒對到已知死法'), said(-2 * MIN, 'commit')]);
  execFileSync('git', ['commit', '-qam', '存檔'], { cwd: s.root });
  eq('對話頁的 D:Claude 說沒問題(不是要不要再跑)', s.dOf()?.rerun?.state, 'ok');
  eq('分級卡那一行:ok', s.dRow()?.state, 'ok');
  check('收工 hook:不問 D(只缺別的關也不含 D)', !(s.gate()?.missing ?? []).some((k) => k.startsWith('D')), JSON.stringify(s.gate()));
  check('終端機的 D 那一行:Claude 說沒對到,沒有「要不要再跑」', /D 魔鬼教官.*Claude 說：沒對到已知死法/.test(s.cli([]).out) && !/要不要再跑/.test(s.cli([]).out), s.cli([]).out.split('━━ 五關')[1]?.slice(0, 600));
  s.cleanup();
}

section('AC-9:四處說同一句話——網頁的 D 那一格、分級卡那一行、終端機、收工 hook(真的各跑一次)', 'P2');
{
  const s = scene();
  const h = s.head();
  s.touch('src/danger.js', -9 * MIN);
  const base = [said(-10 * MIN, '修一下'), callD(-8 * MIN, h)];
  const cases = [
    ['叫了還沒記結論', [...base], null],
    ['D 之後又改了程式', [...base, report(-7 * MIN)], -6 * MIN],
    ['你說不用再跑', [...base, report(-7 * MIN), said(-3 * MIN, '不用跑了，先這樣')], -6 * MIN],
  ];
  for (const [name, lines, editSec] of cases) {
    s.write(lines);
    if (editSec !== null) s.touch('src/danger.js', editSec);
    if (name === '你說不用再跑') {
      const r = s.cli(['--decide', 'D', 'skip', '不用跑了'], { session: 's1' });
      check(`${name}:--decide 記得起來`, r.code === 0, r.out);
    }
    const st = s.dOf();
    const lineUi = st?.rerun?.line ?? '';
    check(`${name}:伺服器給網頁那一句(不是空的)`, lineUi.length > 0, JSON.stringify(st?.rerun));
    const row = s.dRow()?.detail ?? '';
    check(`${name}:分級卡那一行是同一句`, row.includes(lineUi), `${row}\n      ≠ ${lineUi}`);
    const term = s.cli([], { session: 's1' }).out;
    check(`${name}:終端機是同一句`, term.includes(lineUi), term.split('━━ 五關')[1]?.slice(0, 700));
    const g = s.gate();
    if (name === '叫了還沒記結論') check(`${name}:收工 hook 提醒記結論(它講給 Claude 聽的是怎麼做)`, (g?.missing ?? []).includes('D:report') && /還沒記結論/.test(g?.reason ?? ''), g?.reason);
    else if (name === 'D 之後又改了程式') check(`${name}:收工 hook 是同一句`, (g?.reason ?? '').includes(lineUi), `${g?.reason}\n      ≠ ${lineUi}`);
    else check(`${name}:收工 hook 不再問 D`, !(g?.missing ?? []).some((k) => k.startsWith('D')), g?.reason);
  }
  s.cleanup();
}

section('AC-6、AC-7:收工 hook——同一回合同一件事只擋一次,新的種類照擋;叫了沒記結論的,沒改檔的回合也提醒;記不了紀錄就不擋');
{
  const s = scene({ danger: false });                                     // T1:只要 D
  const h = s.head();
  const blocked = (sec, missing) => ({ ts: T(sec), event: 'gate_blocked', level: 'T1', missing, source: 'gate' });
  s.touch('src/a.js', -9 * MIN);
  const turn = [said(-10 * MIN, '改一下標籤'), { ts: T(-9 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }];
  s.write(turn);
  eq('第一次收工:缺 D(這一輪還沒跑)', s.gate()?.missing?.join(','), 'D');
  s.write([...turn, blocked(-8 * MIN, ['D']), callD(-7 * MIN, h)]);
  eq('擋過之後的收工(stop_hook_active):D 跑了沒記結論 → 新的種類「還沒記結論」照擋', s.gate({ again: true })?.missing?.join(','), 'D:report');
  s.write([...turn, blocked(-8 * MIN, ['D']), callD(-7 * MIN, h), blocked(-6 * MIN, ['D:report']), report(-5 * MIN)]);
  s.touch('src/a.js', -4 * MIN);                                          // 修了發現
  const ask = s.gate({ again: true });
  eq('記了、修了 → 再一種:「要不要再跑,先問人」', ask?.missing?.join(','), 'D:ask');
  s.write([...turn, blocked(-8 * MIN, ['D']), callD(-7 * MIN, h), blocked(-6 * MIN, ['D:report']), report(-5 * MIN), blocked(-3 * MIN, ['D:ask'])]);
  eq('問了 → 這一回合同一件事不再擋,放行', s.gate({ again: true }), null);
  s.write([...turn, callD(-7 * MIN, h), report(-5 * MIN)]);
  eq('擋過之後的收工、這一回合卻找不到擋過的紀錄(別的 hook 擋的)→ 照舊放行,防迴圈', s.gate({ again: true }), null);
  // 下一句話是新的回合:又改了,又問一次
  s.write([...turn, callD(-7 * MIN, h), report(-5 * MIN), blocked(-3 * MIN, ['D:ask']), said(-2 * MIN, '順便把按鈕改藍色')]);
  s.touch('src/a.js', -1 * MIN);
  eq('新的一句話、又改了程式 → 新的回合,再問一次', s.gate()?.missing?.join(','), 'D:ask');

  // 沒改檔的回合:只有「叫了還沒記結論」會擋(AC-6),其他照舊安靜
  s.write([...turn, callD(-7 * MIN, h), said(-2 * MIN, '這個怎麼用？')]);
  s.touch('src/a.js', -9 * MIN);
  const q = s.gate();
  check('回答問題的回合:D 叫了還沒記結論 → 提醒一次,講「還在跑就說還在跑,不准先記 ok」', q?.missing?.join(',') === 'D:report' && /還在背景跑就照實說還在跑/.test(q?.reason ?? '') && /不准先記 ok/.test(q?.reason ?? ''), q?.reason);
  s.append([report(-1 * MIN, 'ok', '沒對到')]);
  eq('記了結論 → 回答問題的回合安靜', s.gate(), null);

  // 整條路真的跑一次:擋過之後的收工、紀錄寫不進去 → 不擋(不然下一次看不到擋過什麼,會一直擋同一件事)
  s.write([...turn, blocked(-8 * MIN, ['D']), callD(-7 * MIN, h)]);
  chmodSync(s.log, 0o444);
  const env = { ...process.env, PIPELINE_MONITOR_HOME: s.monitorDir, PIPELINE_MONITOR_LOG_DIR: s.logDir, HOME: s.home };
  const run = (payload) => execFileSync('sh', [join(ROOT, 'gate.sh')], { input: JSON.stringify(payload), env, encoding: 'utf8' });
  const silent = run({ session_id: 's1', cwd: s.root, hook_event_name: 'Stop', stop_hook_active: true });
  eq('紀錄寫不進去、又是擋過之後的收工 → 一個字都不印(放行)', silent, '');
  check('寫不進去的事實記進 _sensor.jsonl(gate_broken)', /記不了 gate_blocked/.test(existsSync(join(s.logDir, '_sensor.jsonl')) ? readFileSync(join(s.logDir, '_sensor.jsonl'), 'utf8') : ''));
  // 帶那次的資料夾:心跳只留最後一次,沒有資料夾就分不出「出錯的那個之後又跑過了」還是「只是別的資料夾跑過」(規格:agent回報與故障記號 AC-5)
  const gb = existsSync(join(s.logDir, '_sensor.jsonl')) ? readFileSync(join(s.logDir, '_sensor.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1) : null;
  eq('故障記號帶著那次的資料夾', gb?.cwd, s.root);
  chmodSync(s.log, 0o644);
  s.cleanup();
}

section('AC-1、AC-11:第一次要求 D 的那段話照分級講跑法,並預先交代「修完不要自己重跑,先問人」');
{
  const t1 = scene({ danger: false });
  t1.touch('src/a.js', -4 * MIN);
  t1.write([said(-5 * MIN, '改一下')]);
  const r1 = t1.gate()?.reason ?? '';
  check('T1:你自己看,不派 agent', /你自己看，不派 agent/.test(r1) && !/可以派獨立 agent/.test(r1), r1);
  check('預先交代:修完不要自己再跑,要再跑先問使用者', /修完不要自己再跑這一關，要再跑先問使用者/.test(r1), r1);
  t1.cleanup();
  const t2 = scene();
  t2.touch('src/danger.js', -4 * MIN);
  t2.write([said(-5 * MIN, '改一下')]);
  const r2 = t2.gate()?.reason ?? '';
  check('T2 第一輪:可以派獨立 agent,回報第一行寫派了幾個', /可以派獨立 agent/.test(r2) && /派了 N 個 agent/.test(r2), r2);
  t2.cleanup();
}


section('英文那一份(規格:技能與寫給AI的話中英切換 AC-6):D 第二輪以上先問人——--round D 與收工 hook 都不叫 Claude 自己再跑;「不准」的字只查那一句', 'P4');
{
  const s = scene();
  const h = s.head();
  s.touch('src/danger.js', -30 * MIN);
  s.write([said(-40 * MIN, 'check it'), callD(-20 * MIN, h), report(-15 * MIN, 'found', 'Found 1'), said(-12 * MIN, 'fix it')]);
  s.touch('src/danger.js', -5 * MIN);
  const r = withLang('en', () => s.gate());
  const line = (r?.reason ?? '').split('\n').find((l) => l.startsWith('- D ')) ?? '';
  check('收工 hook:要不要再跑先問人(D:ask),不叫它跑', (r?.missing ?? []).includes('D:ask') && /Don't run it again on your own; stop and ask the user first/.test(line), line);
  check('……那一句不准叫它自己再跑(沒有 "run it again" 的命令句、沒有 → run 指令)', !/→ run \//.test(line) && !/^- D [^:]+: run /.test(line), line);
  const round = s.cli(['--round', 'D']);
  // 這一句是給 Claude 的英文(收工 hook、--round 跟著語言設定):只在英文的家裡跑才是英文——這裡直接看函式算的
  const mode = withLang('en', () => runMode({ nth: 2, levelId: 'T2', agents: true }).line);
  check('第 2 次的跑法:不論分級都自己看、只看第一次之後改的檔、不派 agent', /^time 2: whatever the tier, look yourself, only at the files changed after the first time, and don't send agents$/.test(mode), mode);
  // 老毛病 P4:「不准派 agent」那條檢查先寫兩個例子——必須抓到「可以派」、必須放過「不派」
  const allowsAgents = (t) => /you may send independent agents/.test(t);
  check('必須抓到:第一次、T2 可以派 agent 的那一句', allowsAgents(withLang('en', () => runMode({ nth: 1, levelId: 'T2', agents: true }).line)));
  check('必須放過:第 2 次那一句(講的是 don\'t send agents)', !allowsAgents(mode), mode);
  check('--round D(中文的家):照舊是中文那一份(測試的家沒設語言)', /第 2 次：不論分級都你自己看/.test(round.out), round.out);
  s.cleanup();
}

section('AC-4、AC-5:你說不用再跑——附你在 D 之後說的原話(感測器記的);D 之後沒有你說的話不算數;你那句話之後又改的不算在裡面', 'P7');
{
  const s = scene();
  const h = s.head();
  s.touch('src/danger.js', -9 * MIN);
  const flow = [said(-10 * MIN, '修一下匯出'), callD(-8 * MIN, h), report(-7 * MIN, 'found', '找到 3 條')];
  s.write(flow);
  s.touch('src/danger.js', -6 * MIN);                                     // 修了
  // 輸入畸形:回一句白話的錯誤、不記
  const bad = [['C', 'skip', '不用'], ['D', 'run', '跑'], ['D', 'skip']].map((a) => s.cli(['--decide', ...a]));
  check('不是結論會過期的關、不是 skip、沒附你的話 → 都失敗,各有白話', bad.every((x) => x.code !== 0) && /能用 --decide 的關：D 魔鬼教官/.test(bad[0].out) && /只有一種決定：skip/.test(bad[1].out) && /要附上使用者說的話/.test(bad[2].out), bad.map((x) => x.out).join('\n'));
  check('失敗的都沒記', !s.events().some((e) => e.event === 'stage_decision'));

  // D 之後只有背景工作的通知、沒有你說的話 → 記得起來,但不算數
  s.write([...flow, { ts: T(-4 * MIN), hook: 'UserPromptSubmit', prompt: NOTE, prompt_id: `p${-10 * MIN}` }]);
  const none = s.cli(['--decide', 'D', 'skip', '不用跑了']);
  check('D 之後沒有你說的話 → 講「這筆不算數」', none.code === 0 && /這筆不算數/.test(none.out) && /分不出是不是你說的/.test(none.out), none.out);
  check('畫面照實講分不出,還是要不要再跑由你決定', s.dOf()?.rerun?.state === 'stale' || /分不出是不是你說的/.test(s.dOf()?.rerun?.line ?? ''), JSON.stringify(s.dOf()?.rerun));
  check('收工 hook 也不認(照樣要先問)', (s.gate()?.missing ?? []).includes('D:ask'), s.gate()?.reason);

  // 叫 D 的那句斜線指令本身不算你說的「不用」
  s.write([said(-10 * MIN, '修一下匯出'), { ts: T(-8 * MIN), hook: 'UserPromptSubmit', prompt: `/${PLUGIN}:chaos-check`, head: h }, report(-7 * MIN)]);
  check('只有叫 D 的那句斜線指令 → 不算數', /這筆不算數/.test(s.cli(['--decide', 'D', 'skip', '不用跑了']).out));

  // 你真的說了
  s.write([...flow, said(-4 * MIN, '不用再跑了，先這樣')]);
  const ok = s.cli(['--decide', 'D', 'skip', '不用跑了']);
  check('記下了,而且講出儀表板會附哪一句', ok.code === 0 && /不用再跑了，先這樣/.test(ok.out), ok.out);
  const ev = s.events().filter((e) => e.event === 'stage_decision').at(-1);
  check('紀錄:stage_decision、source human、via claude、帶對話代號與 Claude 轉述的字', ev?.stage === 'D' && ev?.decision === 'skip' && ev?.source === 'human' && ev?.via === 'claude' && ev?.by_session === 's1' && ev?.quote === '不用跑了', JSON.stringify(ev));
  const d = s.dOf();
  eq('對話頁的 D:擱著(held)——不劃掉、不打勾', d?.state, 'held');
  check('那一句附的是感測器記的原話與時間(講明是 D 之後你說的最後一句),不是 Claude 轉述的', /Claude 記下：你說不用再跑（D 之後你說的最後一句：「不用再跑了，先這樣」，\d+ 分鐘前）/.test(d?.rerun?.line ?? ''), d?.rerun?.line);
  check('分級卡那一行:⏸ 跑過、你說不用再跑——不是 ok', s.dRow()?.state === 'ran' && /你說不用再跑/.test(s.dRow()?.detail ?? ''), JSON.stringify(s.dRow()));
  check('收工 hook 不再問 D', !(s.gate()?.missing ?? []).some((k) => k.startsWith('D')), s.gate()?.reason);

  // AC-5:你那句話之後又改了 → 那次改動不算在決定裡
  s.touch('src/danger.js', -1 * MIN);
  const after = s.dOf();
  check('你說之後又改了 → 又是「要不要再跑由你決定」,並講你說過什麼、那之後又改了',
    after?.state === 'stale' && /要不要再跑由你決定（Claude 記過你說不用再跑，那時 D 之後你說的最後一句：「不用再跑了，先這樣」，\d+ 分鐘前；那之後又改了）/.test(after?.rerun?.line ?? ''), after?.rerun?.line);
  check('收工 hook 又要問', (s.gate()?.missing ?? []).includes('D:ask'), s.gate()?.reason);
  s.cleanup();

  // 併發:拿不到對話代號、工作區有兩個對話 → 分不出是誰記的,不算數
  const w = scene();
  const hw = w.head();
  w.touch('src/danger.js', -6 * MIN);
  w.write([said(-10 * MIN, '修一下'), callD(-8 * MIN, hw), report(-7 * MIN), said(-5 * MIN, '看一下', { session: 's2' }), said(-4 * MIN, '不用跑了')]);
  const blind = w.cli(['--decide', 'D', 'skip', '不用跑了'], { session: null });
  check('沒代號、工作區有兩個對話 → 這筆不算數(分不出是哪個對話記的)', /這筆不算數/.test(blind.out) && /分不出是哪個對話記的/.test(blind.out), blind.out);
  w.cleanup();
}

section('AC-10、AC-12:--round D——第幾次、怎麼跑、第一次之後改了哪些檔(感測器 ∪ git;基準是那一次的版本,存過檔的也在)', 'P1');
{
  const s = scene();
  s.write([said(-12 * MIN, '修一下')]);
  s.touch('src/danger.js', -11 * MIN);                                    // 碰到危險清單:T2
  const first = s.cli(['--round', 'D']);
  check('還沒跑過:這是第一次;T2 可以派 agent;修完先問', /這一輪還沒有紀錄——這是第一次/.test(first.out) && /可以派獨立 agent/.test(first.out) && /要再跑先問使用者/.test(first.out), first.out);

  s.touch('src/a.js', -11 * MIN);                                         // 第一次 D 之前就改了、沒存:D 看過了,不列
  s.touch('src/danger.js', -11 * MIN);
  const h = s.head();
  s.write([said(-12 * MIN, '修一下'), callD(-10 * MIN, h)]);
  const running = s.cli(['--round', 'D']);
  check('叫了還沒記結論:這一輪第 1 次、就是現在這一次,看整批', /這一輪第 1 次（.*還沒記結論——就是現在這一次）/.test(running.out) && !/之後改了/.test(running.out), running.out);

  s.append([report(-9 * MIN, 'found', '找到 2 條'), { ts: T(-8 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/danger.js') }]);
  s.touch('src/danger.js', -8 * MIN);                                     // ① 感測器看得到的修法(危險清單)
  s.touch('src/b.test.js', -7 * MIN);                                     // ② 用 Bash 寫的新測試檔
  s.touch('src/c.js', -6 * MIN);                                          // ③ 修完存了檔:基準是 D 那一刻的版本,照樣看得到
  execFileSync('git', ['commit', '-qm', '修 c', '--', 'src/c.js'], { cwd: s.root });
  utimesSync(join(s.root, 'src/c.js'), at(-6 * MIN), at(-6 * MIN));
  execFileSync('git', ['rm', '-q', 'src/old.js'], { cwd: s.root });        // ④ 刪了一個檔
  s.touch('docs/x.md', -5 * MIN);                                         // ⑤ 文件:不在程式區
  const second = s.cli(['--round', 'D']);
  const o = second.out;
  check('都記了結論:已經跑完 1 次,再跑是第 2 次', /已經跑完 1 次（記了結論的）；再跑是第 2 次/.test(o), o);
  check('上一輪從叫到記結論花多久(紀錄算的),講明 tokens 看不到', /上一輪從叫到記結論 1 分鐘（紀錄算的/.test(o) && /tokens 這裡看不到/.test(o), o);
  check('列出第一次之後改的:危險清單的修法、Bash 寫的新測試檔、存過檔的、刪掉的', /src\/danger\.js　危險清單/.test(o) && /src\/b\.test\.js　測試檔/.test(o) && /src\/c\.js/.test(o) && /src\/old\.js　已刪/.test(o), o);
  check('第一次之前就改了的不列(D 看過了)', !/src\/a\.js/.test(o), o);
  check('不在程式區的另外講一行', /另外改了 1 個不在程式區的檔.*docs\/x\.md/.test(o), o);
  check('跑法:第 2 次自己看、只看這幾個,回報第一行照那句寫、不准講成全部看過', /第 2 次：不論分級都你自己看，只看第一次之後改的檔，不派 agent/.test(o) && /第 2 輪只看了第一輪之後改的 4 個檔/.test(o) && /不准講成全部看過/.test(o), o);
  check('問人的時候:標小修或建議再看、只准往上調、最後一行給建議、說不用就 --decide', /建議再看/.test(o) && /不准往下調/.test(o) && /我建議不跑/.test(o) && /--decide D skip/.test(o), o);
  check('這一輪有沒有動到測試檔:照實講', /這一輪有沒有動到測試檔：有/.test(o), o);
  s.cleanup();

  // 那一次的紀錄沒有版本(舊紀錄、或當時不是 git)→ 拿不到清單,照實講、看整批
  const n = scene();
  n.touch('src/danger.js', -8 * MIN);
  n.write([said(-12 * MIN, '修一下'), callD(-10 * MIN, undefined), report(-9 * MIN)]);
  const noHead = n.cli(['--round', 'D']).out;
  check('沒有版本 → 「拿不到第一次之後改了哪些檔」,回報第一行講看的是整批', /拿不到第一次之後改了哪些檔（那一次的紀錄沒有記版本）/.test(noHead) && /拿不到第一輪之後的清單，這次看的是整批/.test(noHead), noHead);
  n.cleanup();

  // 沒設定分級 → 不是當成最低那一級,是講明照最省的方式跑
  const u = scene({ tiers: null });
  u.write([said(-5 * MIN, '修一下')]);
  const unset = u.cli(['--round', 'D']).out;
  check('沒設定分級:照最省的方式跑,回報明講', /這個專案沒設定分級/.test(unset) && /照最省的方式跑/.test(unset) && !/可以派獨立 agent/.test(unset), unset);
  u.cleanup();

  // 危險清單空的 → 問人時講「硬門檻只剩蔓延」
  const e = scene({ danger: false });
  e.touch('src/a.js', -8 * MIN);
  e.write([said(-12 * MIN, '修一下'), callD(-10 * MIN, e.head()), report(-9 * MIN)]);
  check('危險清單空的:講硬門檻只剩「蔓延」那一條', /危險清單是空的，硬門檻只剩「蔓延」那一條/.test(e.cli(['--round', 'D']).out));
  e.cleanup();
  // C 打掃(有指令、結論不會過期):以前失敗,現在只給這一輪的範圍(規格:skill 範圍跟收工 hook 對齊 AC-2)。認不出的關照舊失敗、講能用哪幾關
  check('--round C → 給這一輪的範圍,不失敗', (() => { const x = scene(); const r = x.cli(['--round', 'C']); x.cleanup(); return r.code === 0 && /C 打掃：這一輪的範圍/.test(r.out); })());
  check('認不出的關 → 失敗,講能用的是哪幾關(含 C)', (() => { const x = scene(); const r = x.cli(['--round', 'Z']); x.cleanup(); return r.code !== 0 && /能用 --round 的關：.*C 打掃.*D 魔鬼教官/.test(r.out); })());
}

section('第一輪的範圍跟收工 hook 同一份:中途存過檔,--round D 第一次、--round C 照樣列存檔過的(規格:skill 範圍跟收工 hook 對齊 AC-1、AC-2、AC-4)', 'P1');
{
  const s = scene({ danger: false });                                     // T1:只要 D
  const h0 = s.head().slice(0, 7);
  s.write([said(-30 * MIN, '改兩個檔')]);
  s.touch('src/a.js', -20 * MIN);
  execFileSync('git', ['add', '-A'], { cwd: s.root });                     // 一輪中途存一次檔(Claude 常這樣)
  execFileSync('git', ['commit', '-qm', '存一次'], { cwd: s.root, env: { ...process.env, GIT_AUTHOR_DATE: T(-19 * MIN), GIT_COMMITTER_DATE: T(-19 * MIN) } });
  s.touch('src/c.js', -10 * MIN);                                          // 存檔之後又改一個(還沒存)
  writeFileSync(join(s.root, 'src', 'brand-new.js'), 'n\n');               // 還沒追蹤的新檔
  const d = s.cli(['--round', 'D']).out;
  check('D 第一次:講這一輪從哪算起、版本是開始那一刻的(不是現在的)、跟收工 hook 同一份', /這一輪的範圍：從這個對話第一句話/.test(d) && d.includes(`（版本 ${h0}）`) && /含已存檔的/.test(d), d);
  check('D 第一次:存檔過的 a.js、還沒存的 c.js、新檔都列,新檔標出來', /src\/a\.js/.test(d) && /src\/c\.js/.test(d) && /src\/brand-new\.js　新檔/.test(d), d);
  check('D 第一次:給拿改動的指令(git diff 開始那一刻的版本)', d.includes(`git diff ${h0} --`), d);
  const c = s.cli(['--round', 'C']);
  const scopeOf = (o) => o.split('\n').filter((l) => /^   這一輪的範圍：|^      src\//.test(l)).join('\n');   // 標題行各關不同,比內容
  check('C:同一份範圍(一字不差)', c.code === 0 && scopeOf(c.out) === scopeOf(d) && scopeOf(d).length > 0, `${scopeOf(c.out)}\n---\n${scopeOf(d)}`);
  const g = s.gate();
  check('收工 hook 擋的時候講同一個範圍(這一輪，含已存檔的)', g !== null && /這一輪，含已存檔的/.test(g.reason), g?.reason);
  s.cleanup();

  // 找不到這一輪的起點(一筆紀錄都沒有):只看得到還沒存檔的——照實講,而且叫 skill 在回報第一行寫出來
  const b = scene({ danger: false });
  b.touch('src/a.js', -5 * MIN);
  const bo = b.cli(['--round', 'C']).out;
  check('起點找不到 → 講只算還沒存檔的、回報第一行要寫「這一輪的起點找不到」', /只算還沒存檔的/.test(bo) && /回報第一行寫「這一輪的起點找不到，只看了還沒存檔的改動」/.test(bo), bo);
  b.cleanup();

  // skill 的字:第一輪照 --round 給的範圍;不准再把「沒參數 → git diff HEAD」當第一輪的預設(抓意圖:哪一句在、哪一句不在,P4)
  const dk = readFileSync(join(ROOT, 'skills', 'chaos-check', 'SKILL.md'), 'utf8');
  const ck = readFileSync(join(ROOT, 'skills', 'cleanup', 'SKILL.md'), 'utf8');
  check('chaos-check:第一次照 --round 印的「這一輪的範圍」拿改動', /第一次 → 它印的「這一輪的範圍」：`git diff <它給的版本> -- <它列的那幾個檔>`/.test(dk));
  check('chaos-check:沒有「沒參數 → git diff HEAD」當預設那一句', !/沒參數 → `git diff HEAD`/.test(dk));
  check('cleanup:先跑 --round C、照它的範圍,而且准用這個指令', /先跑 `pipeline-status --round C`/.test(ck) && /allowed-tools:.*Bash\(pipeline-status --round:\*\)/.test(ck));
  check('cleanup:沒有「沒參數 → git diff HEAD」當預設那一句', !/沒參數 → `git diff HEAD --name-only`/.test(ck));
}

section('AC-3、AC-13:從叫到記結論幾分鐘——紀錄算的、只算一次;還在跑的那一次不印時間;tokens 一個字都不印');
{
  const c1 = { ts: T(-30 * MIN), session: 's1' }, c2 = { ts: T(-20 * MIN), session: 's1' };
  const runs = pairRuns([c1, c2], [report(-27 * MIN, 'found', '第一筆'), report(-26 * MIN, 'found', '補記'), report(-18 * MIN, 'ok', '第二次')]);
  eq('第一次:內容看最後一筆(補記)', runs[0].report?.note, '補記');
  eq('第一次:時間看第一筆(3 分鐘)', Math.round(runs[0].minutes), 3);
  eq('第二次:2 分鐘', Math.round(runs[1].minutes), 2);
  eq('別的對話記的結論不配給這個對話的叫', pairRuns([c1], [report(-27 * MIN, 'ok', 'x', { by_session: 's2' })])[0].report, null);
  eq('不到 1 分鐘就說不到 1 分鐘', tookLine({ minutes: 0.8 }), '上一輪從叫到記結論 不到 1 分鐘');
  eq('算不出來就不講(不估)', tookLine(null), null);
  eq('一小時以上講小時(9/21 那一次卡在用量上限:從叫到記結論 286 分鐘)', tookLine({ minutes: 286 }), '上一輪從叫到記結論 4 小時 46 分鐘');

  const s = scene();
  s.touch('src/danger.js', -30 * MIN);
  s.write([said(-31 * MIN, '修一下'), callD(-29 * MIN, s.head())]);
  check('還在跑:D 那一格不印花了多久', s.dOf()?.rerun?.took === null, JSON.stringify(s.dOf()?.rerun));
  s.append([report(-17 * MIN, 'found', '找到 2 條')]);
  eq('記了結論:D 那一格印「上一輪從叫到記結論 12 分鐘」', s.dOf()?.rerun?.took, '上一輪從叫到記結論 12 分鐘');
  const term = s.cli([]).out;
  check('終端機同一句', /（上一輪從叫到記結論 12 分鐘）/.test(term), term.split('━━ 五關')[1]?.slice(0, 600));
  check('哪裡都不印 tokens 的數字', !/\d+\s*(萬\s*)?tokens/i.test(term + JSON.stringify(s.dOf())), term);
  s.cleanup();
}

section('D 那一格:擱著(held)的樣子、那一句與花了多久——句子住 lib/stageLines.mjs(終端機與伺服器同一個函式),網頁照印(真的跑 ui/app.js 的 workflow)');
{
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const fn = (name, sig) => src.match(new RegExp(`^function ${name}\\(${sig}\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const constLine = (name) => src.match(new RegExp(`^const ${name} = .*$`, 'm'))?.[0] ?? null;
  // 那一句、旁白都是伺服器給的(規格:終端機與網頁說同一句):畫面只剩 workflow 與它的小幫手
  // roundStage:這一輪走到哪一關;FACE／eyes／agent:畫工班(工地工班風畫面 AC-7、AC-8)
  const parts = [constLine('stageState'), constLine('OLD_LINE'), constLine('FACE'), fn('roundStage', 'stages'), fn('eyes', 'face, at'), fn('agent', 'st, s, here'), fn('workflow', 'c')];
  check('從 ui/app.js 拿得出 workflow 與它用到的那幾個(拿不出來這一段就什麼都沒測到)', parts.every(Boolean), parts.map((p, i) => (p ? '' : i)).join(','));
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = (iso) => (iso ? '5 分鐘前' : '');
  const wf = parts.every(Boolean) ? new Function('esc', 'ago', 'ROLE', 'foldOpen', `const zhEn = (zh) => zh; const many = (n, one, more = one + 's') => n + ' ' + (n === 1 ? one : more);\n${parts.join('\n')}; return workflow;`)(esc, ago, {}, () => true) : null;
  const D = (o) => ({ id: 'D', name: '魔鬼教官', skill: 'chaos-check', ranAt: T(-10 * MIN), via: 'skill', calledAs: `${PLUGIN}:chaos-check`, report: { verdict: 'found', note: '找到 3 條\n- [R1] 一條', ts: T(-9 * MIN) }, ...o });
  // 第一個指令關是寫規格那一關(A):D 不能是第一個,不然「還沒記結論」會被畫成「等你點頭開工」
  const card = (st) => ({ path: '/x', sensor: { state: 'ok' }, stages: [{ id: 'A', name: '寫規格', skill: 'spec', state: 'none', line: '這一輪還沒跑' }, st] });
  // 伺服器做的事:用原本的 rerun(決定、你說的話、花了多久)算那一句,放進 line——終端機印的是同一個函式算的同一句
  const screen = (st) => ({ ...st, line: stageLine(st, { ago }) });
  const raw = (state, rerun, o = {}) => D({ state, rerun: { stage: { id: 'D', verb: '跑' }, ...rerun }, ...o });
  const heldSt = raw('held', { state: 'skipped', decision: { said: { text: '不用跑了', ts: T(-3 * MIN) } }, concluded: true, took: { latest: true, minutes: 1 } });
  const heldLine = stageLine(heldSt, { ago });
  check('擱著那一句:附你在 D 之後說的最後一句、上一次 Claude 說了什麼、花了多久', /D 之後你說的最後一句：「不用跑了」/.test(heldLine) && /上一次 Claude 說：找到 3 條/.test(heldLine) && /上一輪從叫到記結論 1 分鐘/.test(heldLine), heldLine);
  const held = wf?.(card(screen(heldSt))) ?? '';
  check('擱著:data-state="held"、照印伺服器給的那一句', /data-state="held"/.test(held) && held.includes(esc(heldLine)), held);
  check('擱著的燈講「是你的決定,不是驗過了」', /是你的決定,不是驗過了/.test(held), held);
  const askLine = stageLine(raw('stale', { state: 'ask', decision: null }), { ago });
  check('要不要再跑:講「要不要再跑由你決定」,不是「要再跑一次」', /要不要再跑由你決定/.test(askLine) && !/要再跑一次/.test(askLine), askLine);
  const old = wf?.(card(D({ state: 'stale', report: null }))) ?? '';
  check('舊的服務沒給那一句:不自己拼(不寫「之後又改了程式檔——要再跑一次」)、不當掉、不印 undefined,講服務還在跑舊的程式',
    /服務還在跑舊的程式/.test(old) && !old.includes('之後又改了程式檔——要再跑一次') && !/undefined|null/.test(old), old);
  check('沒有 rerun 的那一格(舊紀錄):句子照舊「之後又改了程式檔——要再跑一次」', stageLine(D({ state: 'stale', report: null }), { ago }).includes('之後又改了程式檔——要再跑一次'));
  const runningLine = stageLine(raw('current', { state: 'no-report' }, { report: null }), { ago });
  check('還沒記結論:照實講可能還在跑、也可能忘了記,不印花了多久', /可能還在跑，也可能收尾忘了記/.test(runningLine) && !/從叫到記結論/.test(runningLine), runningLine);
}

section('AC-1:skill 裡不准再叫 Claude 自己重跑——修完先問人(先寫一句必須抓到、一句必須放過)', 'P4');
{
  const selfRerun = (t) => /處理完之後.{0,6}再跑一次這一關/.test(t);
  check('必須抓到:以前那一句「使用者或你處理完之後再跑一次這一關」', selfRerun('使用者或你處理完之後**再跑一次這一關**，說沒找到才算結案。'));
  check('必須放過:「使用者說跑 → 再叫這一關」(人決定之後才再叫)', !selfRerun('- 使用者說跑 → 再叫這一關（照第一步：第二次以上自己看、只看那幾個檔）。'));
  const skill = readFileSync(join(ROOT, 'skills', 'chaos-check', 'SKILL.md'), 'utf8');
  check('SKILL.md 沒有叫 Claude 自己重跑', !selfRerun(skill));
  check('SKILL.md 第一步先跑 --round、記完不准自己再叫、修完先問、說不用就 --decide',
    /pipeline-status --round D/.test(skill) && /不准自己再叫第二次/.test(skill) && /不准自己再叫這一關\*\*，先停下來問使用者/.test(skill) && /--decide D skip/.test(skill));
  check('SKILL.md 講「還在背景跑就照實說還在跑,不准先記 ok」', /還在背景跑.*照實說還在跑，不准先記 ok 交差/.test(skill));
  check('SKILL.md 准它跑 --round 不用每次問權限(唯讀)', /allowed-tools:.*Bash\(pipeline-status --round:\*\)/.test(skill));
}

section('結論記對話代號(by_session):「叫 → 結論」配對時不把別的對話的結論配給這個對話');
{
  const s = scene();
  s.write([said(-5 * MIN, '修一下')]);
  s.cli(['--report', 'D', 'ok', '沒對到'], { session: 's1' });
  s.cli(['--report', 'D', 'ok', '沒對到'], { session: null });
  const reps = s.events().filter((e) => e.event === 'stage_report');
  check('有代號就記(欄位叫 by_session,不叫 session)', reps[0]?.by_session === 's1' && !('session' in reps[0]), JSON.stringify(reps[0]));
  check('拿不到代號就不記——不猜一個填進去', reps[1] && !('by_session' in reps[1]), JSON.stringify(reps[1]));
  s.cleanup();
}

/* ────────────── 魔鬼教官第一輪(2026-09-22)抓到的,每一條一段 ────────────── */

// 用量上限重置後 app 替你送進來的那一句(真實紀錄 9/17、9/21 各一筆,一字不差)
const RESUMED = 'I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.';

section('第一輪:用量上限重置後 app 送進來的那句英文不是你說的——收工 hook 不放行、不能當成你說不用再跑', 'P7');
{
  check('那一句不是人說的', saidByHuman({ hook: 'UserPromptSubmit', prompt: RESUMED }) === false);
  const s = scene();
  const h = s.head();
  s.write([said(-10 * MIN, '修一下'), callD(-9 * MIN, h), report(-8 * MIN), { ts: T(-3 * MIN), hook: 'UserPromptSubmit', prompt: RESUMED, prompt_id: `p${-10 * MIN}` }]);
  s.touch('src/danger.js', -7 * MIN);
  check('收工 hook:回合從你說的最後一句算,那一句不算——之前修的看得到,照樣要先問', (s.gate()?.missing ?? []).includes('D:ask'), JSON.stringify(s.gate()));
  const r = s.cli(['--decide', 'D', 'skip', '不用跑了']);
  check('D 之後只有那一句 → 你說不用再跑不算數', /這筆不算數/.test(r.out), r.out);
  eq('「N 則訊息」不數它', sessionsOf([said(-10 * MIN, '修一下'), { ts: T(-3 * MIN), hook: 'UserPromptSubmit', prompt: RESUMED }].map((e) => ({ session: 's1', cwd: '/x', ...e })))[0].prompts, 1);
  s.cleanup();
}

// 真的紀錄裡的形狀(2026-10-05 bd87046e 那個對話,三筆):子 agent 做完時 Claude Code 送進對話的回報。只取開頭的形狀,不抄內容
const AGENT = '<agent-message from="general-purpose">\n[Subagent hand-back] 第一輪查完了';

section('子 agent 的回報不是你說的話——收工 hook 不為它重擋、不算訊息數、不當成你說不用再跑(規格:agent回報與故障記號 AC-1;bd87046e 那一段)', 'P7');
{
  eq('子 agent 的回報 → 認得的系統訊息', promptKind({ hook: 'UserPromptSubmit', prompt: AGENT }), 'system');
  check('不是人說的', saidByHuman({ hook: 'UserPromptSubmit', prompt: AGENT }) === false);
  // bd87046e:你說話 → 收工 hook 擋一次 D → 子 agent 回報進來 → Claude 收工。以前回合的開始被挪到回報上,「這一回合擋過 D」看不到了,又擋一次
  const s = scene({ danger: false });                                     // T1:只要 D
  const h = s.head();
  s.touch('src/a.js', -9 * MIN);
  const blocked = (sec, missing) => ({ ts: T(sec), event: 'gate_blocked', level: 'T1', missing, source: 'gate' });
  const turn = [said(-10 * MIN, '修完跑第二輪 D'), { ts: T(-9 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }];
  s.write([...turn, blocked(-8 * MIN, ['D'])]);
  eq('擋過 D 之後、還沒有 agent 回報 → 這一回合同一件事不再擋', s.gate({ again: true }), null);
  s.write([...turn, blocked(-8 * MIN, ['D']), { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: AGENT, prompt_id: 'pa1' }]);
  eq('子 agent 回報進來之後收工 → 還是同一個回合,不為同一件事重擋', s.gate(), null);
  s.append([{ ts: T(-3 * MIN), hook: 'UserPromptSubmit', prompt: AGENT, prompt_id: 'pa2' }]);
  eq('回報進來兩次也一樣', s.gate(), null);
  // bd87046e 真正的那一段:回報之後 Claude 又改了程式才收工。回報算你說的話時,回合從它重算、改檔落在新回合 → 又擋一次 D(以前就是這樣擋三次)
  s.append([{ ts: T(-2 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }]);
  s.touch('src/a.js', -2 * MIN);
  eq('回報之後又改了程式 → 還是同一個回合,擋過的 D 不再擋', s.gate(), null);
  eq('「N 則訊息」不數它', sessionsOf(s.events())[0].prompts, 1);
  // D 跑完、記了結論、之後又修了程式;D 之後只有 agent 的回報 → Claude 記「你說不用再跑」不算數
  s.write([said(-10 * MIN, '修一下'), callD(-9 * MIN, h), report(-8 * MIN), { ts: T(-4 * MIN), hook: 'UserPromptSubmit', prompt: AGENT, prompt_id: 'pa3' }]);
  s.touch('src/danger.js', -7 * MIN);
  const r = s.cli(['--decide', 'D', 'skip', '不用跑了']);
  check('D 之後只有 agent 的回報 → 你說不用再跑不算數', /這筆不算數/.test(r.out), r.out);
  s.cleanup();
}

section('沒見過的格式不猜成你說的,而且要講出來;收工 hook 取會擋的那一邊(規格:agent回報與故障記號 AC-2)', 'P7');
{
  const ODD = '<brand-new-notice id="1">某種新的系統訊息';
  eq('沒見過的 <標籤 → unknown', promptKind({ hook: 'UserPromptSubmit', prompt: ODD }), 'unknown');
  check('不算你說的', saidByHuman({ hook: 'UserPromptSubmit', prompt: ODD }) === false);
  // 你自己的動作照舊算你的(畫面、訊息數跟以前一樣)
  for (const [what, p] of [['你貼的', '<pasted_content id="a">一段</pasted_content> 這是什麼'], ['用 ! 跑的', '<bash-input>ls</bash-input>'],
                            ['! 跑完的輸出', '<bash-stdout>a</bash-stdout>'], ['9/11 以前前面被加了一段的', '<system-reminder>\nAs you answer']]) {
    eq(`${what} → 算你開口`, promptKind({ hook: 'UserPromptSubmit', prompt: p }), 'human');
  }
  check('不是 < 開頭、也不是一個標籤(<= 3)→ 照舊是你說的', saidByHuman({ hook: 'UserPromptSubmit', prompt: '< 3 秒就好' }) === true);

  const s = scene({ danger: false });
  s.touch('src/a.js', -9 * MIN);
  const blocked = (sec, missing) => ({ ts: T(sec), event: 'gate_blocked', level: 'T1', missing, source: 'gate' });
  const turn = [said(-10 * MIN, '改一下標籤'), { ts: T(-9 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }];
  // 「這一回合改了沒」從最後一句認得是你的算:改檔在沒見過的那則之前,照樣看得到(不會因為它安靜放行)
  s.write([...turn, { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: ODD, prompt_id: 'po1' }]);
  eq('沒見過的那則之前改的程式 → 照樣擋(回合不從它開始算)', s.gate()?.missing?.join(','), 'D');
  // 兩種讀法各算一次,任何一種要擋就擋:當成系統的 → 同一個回合、擋過的不再擋;當成你說的 → 新的回合、之後沒改程式就不擋
  // (魔鬼教官第一輪:以前一欄取一邊,每來一則就把擋過的整張再擋一次,連沒改程式的回合也擋)
  s.write([...turn, blocked(-8 * MIN, ['D']), { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: ODD, prompt_id: 'po2' }]);
  eq('擋過 D、之後來了一則沒見過的、之後沒改程式 → 兩種讀法都不擋,放行', s.gate(), null);
  s.append([{ ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }]);
  s.touch('src/a.js', -4 * MIN);
  eq('那則之後又改了程式 → 當成你說的那種讀法是新的回合,再擋一次(不漏擋)', s.gate()?.missing?.join(','), 'D');
  // 整個對話只有沒見過的:不當成「沒記到你說的話」放行
  s.write([{ ts: T(-10 * MIN), hook: 'UserPromptSubmit', prompt: ODD, prompt_id: 'po3' }, { ts: T(-9 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(s.root, 'src/a.js') }]);
  eq('整個對話只有沒見過的格式 → 照樣擋', s.gate()?.missing?.join(','), 'D');
  // 講出來:對話頁與終端機同一句,先講白話、附開頭、給動作
  s.write([...turn, { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: ODD, prompt_id: 'po4' }]);
  const note = s.sessionOf()?.unknownNote ?? '';
  check('對話頁:講「1 則開頭是 <x> 的訊息、認不出是誰送的」、不講成「不是你打的」(可能就是你打的)、叫你給 Claude 看',
    /1 則開頭是 <brand-new-notice> 的訊息，我認不出是誰送的/.test(note) && /也可能是你打的字/.test(note) && !/不是你打的/.test(note) && /給 Claude 看/.test(note), note);
  eq('「N 則訊息」不數它', s.sessionOf()?.prompts, 1);
  const out = s.cli([]).out;
  check('終端機:同一句', out.includes(note), out);
  // 代記不算數時:那段時間只有認不出的訊息 → 講「只有 N 則認不出的」,不講「紀錄裡沒有你說的話」(R1)
  const h0 = s.head();
  s.write([said(-10 * MIN, '修一下'), callD(-9 * MIN, h0), report(-8 * MIN), { ts: T(-4 * MIN), hook: 'UserPromptSubmit', prompt: '<button class="red">這顆還是灰的，D 不用再跑了', prompt_id: 'po9' }]);
  s.touch('src/danger.js', -7 * MIN);
  const r9 = s.cli(['--decide', 'D', 'skip', 'D 不用再跑了']);
  check('--decide:講「只有 1 則認不出是誰送的訊息，沒當成你的原話」,不講「紀錄裡沒有你說的話」', /只有 1 則認不出是誰送的訊息，沒當成你的原話/.test(r9.out) && !/紀錄裡沒有你說的話/.test(r9.out), r9.out);
  check('D 那格同一句', /只有 1 則認不出是誰送的訊息/.test(s.dOf()?.rerun?.line ?? ''), s.dOf()?.rerun?.line);
  // 認得的系統訊息不出聲
  s.write([...turn, { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: AGENT, prompt_id: 'pa9' }]);
  eq('子 agent 的回報是認得的 → 對話頁不多講一句', s.sessionOf()?.unknownNote ?? null, null);
  s.cleanup();
}

section('第一輪:只貼圖(空字串)、只用 ! 跑指令,不是「你說的話」;你說過的話後面接一張圖,照樣拿你說的那句', 'P7');
{
  const s = scene();
  const h = s.head();
  const flow = [said(-10 * MIN, '修一下'), callD(-9 * MIN, h), report(-8 * MIN)];
  s.touch('src/danger.js', -7 * MIN);
  s.write([...flow, said(-4 * MIN, '')]);
  check('D 之後只貼了一張圖 → 不算數', /這筆不算數/.test(s.cli(['--decide', 'D', 'skip', '不用跑了']).out));
  s.write([...flow, said(-4 * MIN, '<bash-input>pipeline-status --serve-restart</bash-input><bash-stdout>✅ 重啟了</bash-stdout>')]);
  check('D 之後只用 ! 跑了一行指令 → 不算數(系統輸出不准標成你說的)', /這筆不算數/.test(s.cli(['--decide', 'D', 'skip', '不用跑了']).out));
  s.write([...flow, said(-5 * MIN, '不用再跑了'), said(-4 * MIN, '')]);
  s.cli(['--decide', 'D', 'skip', '不用跑了']);
  check('你說了「不用再跑了」之後又貼一張圖 → 引號裡是你說的那句,不是空的', /D 之後你說的最後一句：「不用再跑了」/.test(s.dOf()?.rerun?.line ?? '') && s.dOf()?.state === 'held', s.dOf()?.rerun?.line);
  s.cleanup();
}

section('第一輪:同一個資料夾的另一個對話後來記一筆,不會把你說過的蓋掉');
{
  const s = scene();
  const h = s.head();
  s.touch('src/danger.js', -12 * MIN);
  s.write([said(-20 * MIN, '修一下'), callD(-15 * MIN, h), report(-14 * MIN), said(-10 * MIN, '不用再跑了')]);
  s.cli(['--decide', 'D', 'skip', '不用再跑了'], { session: 's1' });
  eq('s1 記了:擱著', s.dOf('s1')?.state, 'held');
  s.append([said(-6 * MIN, '看一下', { session: 's2' }), callD(-5 * MIN, h, { session: 's2' }), report(-4 * MIN, 'ok', '沒對到', { by_session: 's2' }), said(-3 * MIN, '這邊也不用', { session: 's2' })]);
  s.cli(['--decide', 'D', 'skip', '這邊也不用'], { session: 's2' });
  const d1 = s.dOf('s1');
  check('s2 記了自己的之後,s1 還是擱著、引號裡還是 s1 的話(認得出是別的對話記的)', d1?.state === 'held' && /「不用再跑了」/.test(d1?.rerun?.line ?? ''), d1?.rerun?.line);
  s.cleanup();
}

section('第一輪:D 說找到問題之後,後面的關動了也不劃掉——各處同一句「找到問題,還沒處理完」', 'P2');
{
  const s = scene();
  const h = s.head();
  s.touch('src/danger.js', -12 * MIN);
  s.write([said(-15 * MIN, '修一下'), callD(-10 * MIN, h), report(-9 * MIN, 'found', '找到 2 條'),
           { ts: T(-8 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:cleanup` }, { ts: T(-7 * MIN), event: 'stage_report', stage: 'C', verdict: 'ok', note: '沒東西可刪', source: 'claude' }]);
  const d = s.dOf();
  eq('D 不劃掉(要處理的樣子)', d?.state, 'stale');
  const line = d?.rerun?.line ?? '';
  eq('那一句', line, 'Claude 說找到問題：找到 2 條——還沒處理完');
  check('分級卡那一行同一句', (s.dRow()?.detail ?? '').includes(line), s.dRow()?.detail);
  check('終端機同一句,而且不寫「已走過」', s.cli([]).out.includes(line) && !/D 魔鬼教官.*已走過/.test(s.cli([]).out), s.cli([]).out.split('━━ 五關')[1]?.slice(0, 600));
  s.cleanup();
}

section('第一輪:共用資料夾——Claude 跑的終端機、--round、收工 hook 對 D 講同一件事(按這個對話算)', 'P2');
{
  const s = scene();
  const h = s.head();
  s.touch('src/danger.js', -3 * MIN);
  s.write([said(-30 * MIN, '修一下'), callD(-25 * MIN, h), report(-24 * MIN, 'ok', '沒對到'), said(-5 * MIN, '改標籤', { session: 's2' })]);
  const term = s.cli([], { session: 's2' }).out;
  check('s2 的終端機:D 這一輪還沒跑(s1 跑的不算 s2 的)', /D 魔鬼教官\s*⚪ 這一輪還沒跑/.test(term), term.split('━━ 五關')[1]?.slice(0, 600));
  check('s2 的 --round:這是第一次', /這一輪還沒有紀錄——這是第一次/.test(s.cli(['--round', 'D'], { session: 's2' }).out));
  const g = s.gate({ sid: 's2' });
  check('s2 的收工 hook:D 這一輪還沒跑 → 跑(不是先問人)', (g?.missing ?? []).includes('D') && /這一輪還沒跑 → 跑/.test(g?.reason ?? ''), g?.reason);
  s.cleanup();
}

section('第一輪:叫了 D 沒跑完(沒記結論)不算一輪——下一次還是第一次、看整批;第一輪之後的清單從跑完的那一次算', 'P5');
{
  const s = scene();
  const h0 = s.head();
  s.touch('src/danger.js', -40 * MIN);
  s.write([said(-45 * MIN, '修一下'), callD(-35 * MIN, h0), said(-10 * MIN, '繼續'), callD(-5 * MIN, h0)]);
  const o = s.cli(['--round', 'D']).out;
  check('沒跑完的那一次不算:這一輪第 1 次、就是現在這一次', /這一輪第 1 次（.*還沒記結論——就是現在這一次）/.test(o), o);
  check('講前面有一次叫了沒記結論、不算一輪', /前面有 1 次叫了沒記結論——可能沒跑完，不算一輪/.test(o), o);
  check('跑法是第一次(T2 可以派 agent),不是「只看第一次之後改的」', /第一次、分級 T2/.test(o) && !/之後改了/.test(o), o);
  s.append([report(-3 * MIN, 'found', '找到 1 條')]);
  s.touch('src/a.js', -20 * MIN);                                         // 兩次叫之間改的:跑完的那一次(第二次)看過了
  s.touch('src/c.js', -2 * MIN);                                          // 跑完之後改的
  const o2 = s.cli(['--round', 'D']).out;
  check('跑完之後:已經跑完 1 次,再跑是第 2 次', /已經跑完 1 次（記了結論的）；再跑是第 2 次/.test(o2), o2);
  check('清單從跑完的那一次算起:之後改的列、兩次叫之間改的不列(從沒跑完那一次算的話會列)', /^\s{6}src\/c\.js/m.test(o2) && !/^\s{6}src\/a\.js/m.test(o2) && !/^\s{6}src\/danger\.js/m.test(o2), o2);   // 只看清單那幾行(分級那一行本來就會提到危險檔)
  s.cleanup();
}

section('第一輪:叫了 D 沒記結論、你說不用跑了 → 你的決定算數:擱著,收工 hook 不再每一回合要結論');
{
  const s = scene();
  const h = s.head();
  s.touch('src/danger.js', -40 * MIN);
  s.write([said(-45 * MIN, '修一下'), callD(-35 * MIN, h), said(-5 * MIN, '不用跑了，先這樣')]);
  eq('記之前:還沒記結論,收工 hook 提醒', s.gate()?.missing?.includes('D:report'), true);
  const r = s.cli(['--decide', 'D', 'skip', '不用跑了']);
  check('--decide 講出會附哪一句', /不用跑了，先這樣/.test(r.out), r.out);
  const d = s.dOf();
  check('擱著,那一句講「那一次叫了沒記結論」', d?.state === 'held' && /那一次叫了沒記結論/.test(d?.rerun?.line ?? ''), JSON.stringify(d?.rerun));
  check('收工 hook 不再要結論', !(s.gate()?.missing ?? []).some((k) => k.startsWith('D')), s.gate()?.reason);
  s.cleanup();
}

section('第一輪:第一輪之後把檔搬進危險清單(搬家不改檔案時間)——--round 照樣列、標危險清單', 'P1');
{
  const s = scene({ tiers: { code: ['src/'], danger: ['src/store/'] } });
  s.touch('src/util/save.js', -50 * MIN, 's\n');                          // 內容跟存檔的一樣,只把修改時間放到 D 之前(搬家會帶著這個時間走)
  const h = s.head();
  s.write([said(-45 * MIN, '修一下'), callD(-20 * MIN, h), report(-19 * MIN, 'found', '找到 1 條')]);
  mkdirSync(join(s.root, 'src/store'), { recursive: true });
  execFileSync('git', ['mv', 'src/util/save.js', 'src/store/save.js'], { cwd: s.root });
  const o = s.cli(['--round', 'D']).out;
  check('搬進去的新位置列出來、標危險清單', /src\/store\/save\.js　危險清單/.test(o), o);
  check('舊位置照樣列(已刪)', /src\/util\/save\.js　已刪/.test(o), o);
  s.cleanup();
}

section('第一輪:對話開在專案的子資料夾——結論認得是這個對話記的(by_session),--round、收工 hook 說同一件事', 'P2');
{
  const s = scene();
  const h = s.head();
  const sub = join(s.root, 'src');
  s.touch('src/danger.js', -20 * MIN);
  s.write([{ ...said(-25 * MIN, '修一下'), cwd: sub }, { ...callD(-15 * MIN, h), cwd: sub }]);
  const rep = s.cli(['--report', 'D', 'found', '找到 1 條'], { cwd: sub });
  check('從子資料夾記結論', rep.code === 0, rep.out);
  const g = s.gate({ cwd: sub });
  check('收工 hook(子資料夾)不再說「還沒記結論」', !(g?.missing ?? []).includes('D:report'), g?.reason);
  check('--round(子資料夾)認得跑過 1 次', /已經跑完 1 次（記了結論的）/.test(s.cli(['--round', 'D'], { cwd: sub }).out), s.cli(['--round', 'D'], { cwd: sub }).out);
  s.cleanup();
}

section('第一輪:案件卡與對話清單的「走到哪」——D 在要不要再跑、擱著時不准寫「這一輪還沒有紀錄」(真的跑 ui/app.js 的 roundWhere)', 'P5');
{
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  // roundWhere 問「走到哪一關」的是 roundStage(五關發光的那一顆也問它,老毛病 P2),一起拿出來
  const code = ['roundStage', 'roundWhere'].map((n) => src.match(new RegExp(`^function ${n}\\(stages\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null);
  check('從 ui/app.js 拿得出 roundWhere 與 roundStage', code.every(Boolean));
  const rw = code.every(Boolean) ? new Function(`const zhEn = (zh) => zh; const many = (n, one, more = one + 's') => n + ' ' + (n === 1 ? one : more);\n${code.join('\n')}; return roundWhere;`)() : () => '';
  const st = (o) => [{ id: 'A', name: '寫規格', skill: 'spec', state: 'none' }, { id: 'B', name: '寫程式', type: 'main-conversation', state: 'passed' }, { id: 'D', name: '魔鬼教官', skill: 'chaos-check', ...o }];
  eq('要不要再跑', rw(st({ state: 'stale', rerun: { state: 'ask' } })), '這一輪走到 D 魔鬼教官（要不要再跑由你決定）');
  eq('你說不用再跑', rw(st({ state: 'held', rerun: { state: 'skipped' } })), '這一輪走到 D 魔鬼教官（你說不用再跑）');
  eq('找到問題還沒處理完', rw(st({ state: 'stale', rerun: { state: 'found' } })), '這一輪走到 D 魔鬼教官（找到問題，還沒處理完）');
  eq('真的一關都沒跑:才是還沒有紀錄', rw([{ id: 'A', name: '寫規格', skill: 'spec', state: 'none' }]), '這一輪還沒有紀錄');
}

process.exit(summary());
