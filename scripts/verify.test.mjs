/**
 * verify.test.mjs —— E 自動驗收(路徑看 CLAUDE.md 的表)
 *
 * Claude 照規格在畫面上走一遍、每條記看到了／沒看到／驗不了,人做第二次查核。釘的是會安靜說謊的地方:
 *   ① 讀不懂的行、規格裡有卻沒回報的條目,被算成沒問題;摘要的數字照 Claude 自己寫的(AC-1、AC-2,R1、R3)
 *   ② 開瀏覽器的動作被當成「走一趟」,或 verify 的呼叫被數成一個瀏覽器動作(AC-7)
 *   ③ Claude 走完一遍,E 就被劃掉、打勾、寫「Claude 說沒問題」(AC-3,R2)
 *   ④ 走過之後、或你說驗收過了之後又改了程式,畫面照樣說過了;收工 hook 叫它自己再走(AC-6)
 *   ⑤ Claude 替你記「驗收過了」,沒有你的話也算數;記一筆不算數的,把你按的那一筆蓋掉(AC-9,老毛病 P7 的鏡像)
 *   ⑥ 有「沒看到」卻記 ok(AC-1);照哪份規格、怎麼跑起來由 skill 自己猜(AC-4、AC-5,P2)
 *   ⑦ 分級預設就要求 E;要求 E 時叫使用者去按(AC-8)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, utimesSync, readFileSync, symlinkSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { decide } from '../gate.mjs';
import { collectAll } from '../lib/collect.mjs';
import { safeName } from '../lib/events.mjs';
import { sessionView, lastRunPerStage, acceptOf, rerunLine } from '../lib/rounds.mjs';
import { parseWalk, walkSummary, summaryLine, walkItems, eLines } from '../lib/verify.mjs';
import { withLang } from '../lib/lang.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name;
const STAGES = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8'));
const MIN = 60;
// 測試裡的「現在」只取一次(LESSONS L18)
const NOW = Date.now();
const T = (sec) => new Date(NOW + sec * 1000).toISOString();
const at = (sec) => new Date(NOW + sec * 1000);
const out = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const ago = (iso) => (iso ? '幾分鐘前' : '');

const SPEC = `# 功能：示範

## 驗收條件

**AC-1　首頁有標題**
> **白話**：一打開就看到標題。

**AC-2　按鈕是藍色的**
> **白話**：按鈕顏色對。

**AC-3　要穩定**
> **白話**：不會壞。
`;

/** 事件的樣子:感測器記的(瀏覽器動作、Skill、你說的話、改檔)、CLI 記的(結論、驗收、決定、規格連結)。 */
const callV = (sec, extra = {}) => ({ ts: T(sec), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:verify`, ...extra });
const act = (sec, tool = 'mcp__Claude_Browser__navigate', extra = {}) => ({ ts: T(sec), hook: 'PreToolUse', tool, url_host: 'localhost:5173', ...extra });
const rep = (sec, verdict, note, extra = {}) => ({ ts: T(sec), event: 'stage_report', stage: 'E', verdict, note, source: 'claude', by_session: 's1', ...extra });
const said = (sec, prompt, extra = {}) => ({ ts: T(sec), hook: 'UserPromptSubmit', prompt, prompt_id: `p${sec}`, ...extra });
const edit = (sec, file) => ({ ts: T(sec), hook: 'PostToolUse', tool: 'Edit', file });
const clear = (sec, extra = {}) => ({ ts: T(sec), event: 'stage_cleared', stage: 'E', source: 'human', ...extra });
const ALL_SEEN = '第 1 趟：http://localhost:5173\nAC-1 看到了：首頁寫著「歡迎回來」\nAC-2 看到了：按鈕是藍色的，寫著「送出」\nAC-3 驗不了：畫面上看不出來';

/** 用 sessionView 算一次(五關、分級卡、收工 hook 都走這一個),回 E 那一格。 */
function viewOf(events, { cwd = '/x', stages = STAGES.stages } = {}) {
  const evs = events.map((e) => ({ session: e.event ? undefined : 's1', cwd, ...e }));
  const v = sessionView(evs, stages, 's1', null, cwd, {}).view;
  return { v, E: v.stages.find((s) => s.id === 'E'), D: v.stages.find((s) => s.id === 'D') };
}

/**
 * 一個有分級設定的專案(src/ 是程式區,src/danger.js 在危險清單)、一份進行中的規格、假的監視器資料夾、裝了 plugin 的假 home。
 * levels 給了就寫進專案自己的分級設定(AC-8:專案可以把 E 放進清單)。
 */
function scene({ levels = null } = {}) {
  const tiers = { code: ['src/'], danger: ['src/danger.js'], ...(levels ? { levels } : {}) };
  const r = makeRepo({ at: T(-90 * MIN), files: {
    'src/a.js': '1\n', 'src/danger.js': 'd\n', 'docs/進行中/demo.md': SPEC, '.claude/pipeline-stages.json': JSON.stringify({ tiers }),
  } });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-verify-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(ROOT, join(home, '.claude', 'skills', PLUGIN));
  const logDir = join(monitorDir, 'logs');
  const log = join(logDir, `${safeName(basename(root))}.jsonl`);
  const head = () => out(root, 'rev-parse', '--short', 'HEAD');
  const line = (o) => JSON.stringify(o.event ? { cwd: root, ...o } : { session: 's1', cwd: root, ...o });
  const write = (lines) => writeFileSync(log, lines.map(line).join('\n') + '\n');
  const append = (lines) => appendFileSync(log, lines.map(line).join('\n') + '\n');
  const events = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  /** 改一個檔,修改時間放在 sec 秒前/後(用 Bash 寫的:感測器看不到)。 */
  const touch = (f, sec, body = `changed ${sec}\n`) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), body); utimesSync(join(root, f), at(sec), at(sec)); };
  // 跑真的 CLI。HOME 一定要給這個假的(L24);對話代號從環境變數給,session=null 就拿掉(= 你自己在終端機跑)
  const cli = (args, { session = 's1', cwd = root } = {}) => {
    const { CLAUDE_CODE_SESSION_ID: _drop, ...env } = process.env;
    if (session) env.CLAUDE_CODE_SESSION_ID = session;
    try { return { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...env, HOME: home, PIPELINE_MONITOR_HOME: monitorDir, PIPELINE_MONITOR_LOG_DIR: logDir } }) }; }
    catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
  };
  const gate = ({ sid = 's1', cwd = root } = {}) => decide({ payload: { session_id: sid, cwd, hook_event_name: 'Stop', stop_hook_active: false }, monitorDir, skillHome: home });
  const project = () => collectAll({ monitorDir, skillHome: home, appTitles: new Map() }).projects[0];
  const sessionOf = (sid = 's1') => project()?.sessions.find((s) => s.id === sid) ?? null;
  const eOf = (sid = 's1') => sessionOf(sid)?.stages?.find((x) => x.id === 'E') ?? null;
  const link = (sec, extra = {}) => ({ ts: T(sec), event: 'spec_link', spec: 'docs/進行中/demo.md', by_session: 's1', source: 'claude', ...extra });
  const cleanup = () => { for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true }); r.cleanup(); };
  return { root, monitorDir, home, log, head, write, append, events, touch, cli, gate, project, sessionOf, eOf, link, cleanup, repo: r };
}

section('AC-1:每條三種結果分開;讀不懂的行照原文列、規格裡有卻沒回報的講「沒有結果」,都不算進任何一種;數字從行數來,不採信摘要', 'P5');
{
  const w = parseWalk(`${ALL_SEEN.replace('AC-2 看到了：按鈕是藍色的，寫著「送出」', 'AC-2 沒看到：應該是藍色，畫面上是灰色')}\n這一行看不懂`);
  eq('第一行是摘要', w.head, '第 1 趟：http://localhost:5173');
  eq('三條', w.items.length, 3);
  eq('看到了／沒看到／驗不了分開', w.items.map((x) => x.verdict).join(','), 'saw,missing,blocked');
  eq('看不懂的那一行照原文留著', w.odd[0], '這一行看不懂');
  const s = walkSummary(w, ['AC-1', 'AC-2', 'AC-3', 'AC-4']);
  eq('規格裡有、沒回報的 → 沒有結果', s.noResult.join(','), 'AC-4');
  const line = summaryLine(s);
  check('一句話:4 條裡各幾條、AC-4 沒有結果、1 行看不懂', /4 條裡 1 條看到了、1 條沒看到、1 條驗不了/.test(line) && /AC-4 沒有結果/.test(line) && /1 行看不懂/.test(line), line);
  eq('清單記號、代號寫法、第一行就是一條(忘了寫摘要)都認得', parseWalk('- AC-01 看到了：「x」').items[0]?.id, 'AC-1');
  eq('第一行就是一條時沒有摘要', parseWalk('AC-1 看到了：「x」').head, null);
  eq('同一條寫兩次算最後那一次(更正)', parseWalk('AC-1 沒看到：x\nAC-1 看到了：「y」').items.map((x) => x.verdict).join(','), 'saw');
  const extra = walkSummary(parseWalk('AC-1 看到了：「x」\nAC-9 看到了：「z」'), ['AC-1']);
  check('規格裡沒有的條目照列、標出來,不算進規格那幾條', extra.extra.join(',') === 'AC-9' && extra.saw === 1 && extra.total === 1, JSON.stringify(extra));
  // R3:Claude 在摘要裡寫「8 條都看到了」,行數說的是另一回事——照行數講
  const brag = summaryLine(walkSummary(parseWalk('8 條裡 8 條看到了\nAC-1 沒看到：沒有標題')));
  check('摘要的數字不採信:照行數講「1 條裡 1 條沒看到」', /1 條裡 1 條沒看到/.test(brag) && !/8 條/.test(brag), brag);
  // P5:一條都沒照格式寫,不是「0 條沒看到」——是分不出看了哪幾條
  eq('一條都沒照格式寫 → 分不出看了哪幾條(不是「都沒問題」)', summaryLine(walkSummary(parseWalk('走了一遍，都看到了'))), '沒有逐條的結果——分不出看了哪幾條');
  const items = walkItems(w, ['AC-1', 'AC-2', 'AC-3', 'AC-4']);
  check('逐條的清單:照規格的順序,沒有結果的補一行,看不懂的排最後', items.map((x) => x.verdict).join(',') === 'saw,missing,blocked,none,odd', JSON.stringify(items.map((x) => x.verdict)));
  check('記號不用打勾(看到了是 Claude 說的,不是驗收過了)', !items.some((x) => /✅|✓/.test(x.mark)), items.map((x) => x.mark).join(''));
}

section('AC-2:「看到了」要附畫面上的原文;沒附的照實標出來');
{
  const w = parseWalk('AC-1 看到了：首頁寫著「歡迎回來」\nAC-2 看到了：有');
  eq('有「」的算附了原文', w.items[0].quoted, true);
  eq('沒有「」的不算', w.items[1].quoted, false);
  eq('摘要講哪幾條沒附', walkSummary(w).unquoted.join(','), 'AC-2');
  eq('清單上那一條標出來', walkItems(w)[1].unquoted, true);
}

section('Claude 用英文回報 E(seen／not seen／can\'t verify):跟中文寫的同一份,三種結果、沒有結果、看不懂的行、有沒有附原文都一樣(規格:技能與寫給AI的話中英切換 AC-3)', 'P5');
{
  const zh = '第 1 趟：http://localhost:5173\nAC-1 看到了：首頁寫著「歡迎回來」\nAC-2 沒看到：應該是藍色，畫面上是灰色\nAC-3 驗不了：要登入\nAC-5 看到了：有\n這一行看不懂';
  const enRep = 'Walk 1: http://localhost:5173\nAC-1 seen: the home page says "Welcome back"\nAC-2 not seen: should be blue, the screen shows grey\nAC-3 can\'t verify: needs a login\nAC-5 seen: yes\nI could not read this line';
  const shape = (note) => {
    const w = parseWalk(note), s = walkSummary(w, ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5']);
    return { items: w.items.map((x) => `${x.id}:${x.verdict}:${x.quoted}`).join(','), odd: w.odd.length, head: !!w.head,
      sum: `${s.total}|${s.saw}|${s.missing}|${s.blocked}|${s.noResult.join('+')}|${s.unquoted.join('+')}|${s.odd}`,
      list: walkItems(w, ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5']).map((x) => x.verdict).join(',') };
  };
  const a = shape(zh), b = shape(enRep);
  eq('每一條的結果、有沒有附原文:英文跟中文一樣', b.items, a.items);
  eq('……摘要(幾條看到了、沒看到、驗不了、沒有結果、沒附原文、看不懂的行):一樣', b.sum, a.sum);
  eq('……逐條的清單:一樣', b.list, a.list);
  eq('……看不懂的行、第一行是摘要:一樣', `${b.odd}|${b.head}`, `${a.odd}|${a.head}`);
  // 老毛病 P4:先寫一句必須抓到、一句必須放過
  eq('必須抓到:not seen 是「沒看到」,不是被當成 seen', parseWalk('AC-1 not seen: no button').items[0]?.verdict, 'missing');
  eq('必須放過:原文裡剛好有 not seen 的 seen 照樣是「看到了」', parseWalk('AC-2 seen: "…was not seen before…"').items[0]?.verdict, 'saw');
  eq('大小寫、彎撇號(can’t)也認', parseWalk('AC-1 Not Seen: x\nAC-2 Can’t verify: login').items.map((x) => x.verdict).join(','), 'missing,blocked');
  const saw = parseWalk('Walk 1\nAC-1 saw it');
  eq('沒照格式寫的(AC-1 saw it)照舊是看不懂的一行,不猜成看到了', `${saw.items.length}|${saw.odd.join('')}`, '0|AC-1 saw it');
  eq('英文的引號("…" 或 “…”)算附了原文', parseWalk('AC-1 seen: “Save”\nAC-2 seen: "Export"\nAC-3 seen: there is a button').items.map((x) => x.quoted).join(','), 'true,true,false');
  eq('中英混著寫(同一份裡兩種都有)都認', parseWalk('AC-1 看到了：「x」\nAC-2 not seen: y').items.map((x) => x.verdict).join(','), 'saw,missing');
}

section('AC-7:兩種證據分開算——瀏覽器動作只是「開過」,verify 的呼叫才是「走一趟」;你打的斜線指令也算', 'P6');
{
  const base = [said(-40 * MIN, '看一下首頁'), act(-30 * MIN), act(-29 * MIN, 'mcp__Claude_Browser__computer'), act(-28 * MIN, 'mcp__Claude_Browser__computer')];
  let { E } = viewOf(base);
  eq('只開過瀏覽器 → seen(不亮、不算走到)', E.state, 'seen');
  eq('開過 3 個動作', E.count, 3);
  eq('這一輪沒有走一趟', E.rerun.count, 0);
  ({ E } = viewOf([...base, callV(-10 * MIN), act(-9 * MIN), act(-8 * MIN, 'mcp__Claude_Browser__get_page_text')]));
  eq('叫了 verify → 走了一趟', E.rerun.count, 1);
  eq('verify 的呼叫不算一個瀏覽器動作(5 個動作,不是 6 個)', E.count, 5);
  eq('叫了還沒記結論,而且是最後一步 → 現在這一關(亮)', E.state, 'current');
  ({ E } = viewOf([...base, said(-5 * MIN, `/${PLUGIN}:verify 看首頁的標籤有沒有對齊`)]));
  eq('你自己打的斜線指令也算走一趟(L19)', E.rerun.count, 1);
  eq('打的時候說的話留著(沒有規格時照它驗)', E.args, '看首頁的標籤有沒有對齊');
  eq('是你叫的', E.via, 'typed');
  const run = lastRunPerStage([act(-3 * MIN), callV(-2 * MIN), act(-1 * MIN)].map((e) => ({ session: 's1', cwd: '/x', ...e })), STAGES.stages, '/x').perStage.get('E');
  eq('lastRunPerStage 的動作數也不算 verify 的呼叫', run.count, 2);
}

section('AC-3:Claude 走完一遍,E 不劃掉、不打勾、不寫「Claude 說沒問題」——只有你說驗收過了才算過');
{
  let { v, E } = viewOf([said(-40 * MIN, '驗收一下'), callV(-20 * MIN), act(-19 * MIN), rep(-15 * MIN, 'ok', ALL_SEEN)]);
  eq('走完、記了 ok → 亮著等你查核(current),不是 done', E.state, 'current');
  eq('沒有結案時間', E.doneAt, null);
  eq('不是「Claude 說」結案', E.closedBy, null);
  eq('E 這一輪在哪:Claude 走過一遍', E.estate, 'ok');
  const el = eLines(E, { ago });
  check('第二句講 Claude 走了一遍、每種幾條', /Claude 說走了一遍：3 條裡 2 條看到了、1 條驗不了/.test(el.walk), el.walk);
  eq('第三句:還沒有人說驗收過了', el.human, '還沒有人說驗收過了');
  check('三句話裡沒有「沒問題」「通過」,也沒有把 Claude 說的講成驗收過了', ![el.acts, el.walk].some((l) => /沒問題|通過|驗收過了/.test(l)), JSON.stringify(el));
  eq('有「沒看到」→ found,照樣亮著等你看', viewOf([callV(-20 * MIN), rep(-15 * MIN, 'found', 'x\nAC-1 沒看到：沒有標題')]).E.state, 'current');
  // 走完之後又叫了 C(沒改程式):E 不能被劃成「已走過」——還在等你查核
  ({ v, E } = viewOf([callV(-20 * MIN), rep(-15 * MIN, 'ok', ALL_SEEN), callV(-5 * MIN, { skill: `${PLUGIN}:cleanup` })]));
  eq('後面的關又動了 → 不劃掉(stale),不是 passed', E.state, 'stale');
  eq('C 是現在這一關', v.stages.find((s) => s.id === 'C').state, 'current');
}

section('AC-6:走過之後、或你說驗收過了之後又改了程式——要不要再走由你決定;你說不用就擱著');
{
  const walk = [said(-40 * MIN, '驗收一下'), callV(-20 * MIN), act(-19 * MIN), rep(-15 * MIN, 'ok', ALL_SEEN)];
  let { E } = viewOf([...walk, edit(-10 * MIN, '/x/src/a.js')]);
  eq('走過之後又改了程式 → 要不要再走由你決定(ask)', E.estate, 'ask');
  eq('要處理的樣子,不劃掉', E.state, 'stale');
  const line = rerunLine(E.rerun, { ago });
  check('那一句講「再走」,不講 D 的「再跑」', /要不要再走由你決定/.test(line) && !/再跑/.test(line), line);
  ({ E } = viewOf([...walk, edit(-10 * MIN, '/x/src/a.js'), said(-6 * MIN, '不用再走了'),
    { ts: T(-5 * MIN), event: 'stage_decision', stage: 'E', decision: 'skip', quote: '不用再走了', by_session: 's1', source: 'human', via: 'claude' }]));
  eq('你說不用再走 → 擱著(held)', E.state, 'held');
  check('畫面附的是你在 E 之後說的最後一句', /E 之後你說的最後一句：「不用再走了」/.test(rerunLine(E.rerun, { ago })), rerunLine(E.rerun, { ago }));
  // 你說驗收過了(按鈕)
  ({ E } = viewOf([...walk, clear(-12 * MIN)]));
  eq('你說驗收過了 → done', E.state, 'done');
  eq('是你說的', E.closedBy, 'human');
  ({ E } = viewOf([...walk, edit(-13 * MIN, '/x/src/a.js'), clear(-12 * MIN)]));
  eq('你說之前改的,蓋在你的驗收裡 → 照樣 done', E.state, 'done');
  ({ E } = viewOf([...walk, clear(-12 * MIN), edit(-10 * MIN, '/x/src/a.js')]));
  eq('你說驗收過了之後又改了程式 → 不是 done(你的驗收講的是改之前的版本)', E.estate, 'accepted-stale');
  eq('要處理的樣子', E.state, 'stale');
  check('第三句講「之後又改了程式檔——要不要再走由你決定」', /之後又改了程式檔——要不要再走由你決定/.test(eLines(E, { ago }).human), eLines(E, { ago }).human);
  // 沒走過 verify、你自己驗的那條路一樣
  ({ E } = viewOf([act(-30 * MIN), clear(-20 * MIN), edit(-10 * MIN, '/x/src/a.js')]));
  eq('只開過瀏覽器、你說驗收過了、之後又改了 → 一樣不是 done', E.estate, 'accepted-stale');
}

section('AC-9:Claude 代記「你說驗收過了」要對得回你在 E 之後說的話;記一筆不算數的不蓋掉你按的', 'P7');
{
  const since = T(-20 * MIN);
  const evs = [said(-30 * MIN, '驗收一下'), said(-5 * MIN, '看過了，可以')].map((e) => ({ session: 's1', cwd: '/x', ...e }));
  const byClaude = (sec, extra = {}) => clear(sec, { via: 'claude', by_session: 's1', quote: '看過了', ...extra });
  let a = acceptOf({ clears: [byClaude(-2 * MIN)], since, events: evs });
  eq('E 之後你說了話 → Claude 代記算數', a.valid, true);
  eq('是 Claude 代記的', a.by, 'claude');
  eq('附的是感測器記的那一句,不是 Claude 轉述的', a.said?.text, '看過了，可以');
  eq('蓋到你那句話那一刻,不是 Claude 記下的那一刻', a.coverTs, T(-5 * MIN));
  a = acceptOf({ clears: [byClaude(-2 * MIN)], since, events: evs.slice(0, 1) });
  check('E 之後沒有你說的話 → 不算數,講得出為什麼', a.valid === false && a.rejected?.why === 'no-words', JSON.stringify(a));
  const note = { session: 's1', cwd: '/x', ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>x</task-id>' };
  eq('背景工作的通知不是你說的話(P7)', acceptOf({ clears: [byClaude(-2 * MIN)], since, events: [evs[0], note] }).valid, false);
  // 規格:agent回報與故障記號 AC-1、AC-2——子 agent 的回報、沒見過的格式、9/11 以前只剩系統那一段的,都不准當成「你說驗收過了」的原話
  const say = (prompt) => ({ session: 's1', cwd: '/x', ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt });
  eq('子 agent 的回報不是你說的話', acceptOf({ clears: [byClaude(-2 * MIN)], since, events: [evs[0], say('<agent-message from="verify">[Subagent hand-back] 看過了，可以')] }).valid, false);
  eq('沒見過的格式不猜成你說的', acceptOf({ clears: [byClaude(-2 * MIN)], since, events: [evs[0], say('<new-system-thing>看過了，可以')] }).valid, false);
  eq('開頭被系統加了一段、截掉之後只剩系統的字(9/11 以前記的)→ 不當原話', acceptOf({ clears: [byClaude(-2 * MIN)], since, events: [evs[0], say('<system-reminder>\nAs you answer the user')] }).valid, false);
  eq('你貼的一段(<pasted_content>)照舊是你說的', acceptOf({ clears: [byClaude(-2 * MIN)], since, events: [evs[0], say('<pasted_content id="x">截圖說明</pasted_content> 看過了，可以')] }).valid, true);
  eq('分不出是哪個對話記的 → 不算數', acceptOf({ clears: [byClaude(-2 * MIN, { by_session: undefined })], since, events: evs }).rejected?.why, 'owner');
  a = acceptOf({ clears: [clear(-4 * MIN), byClaude(-2 * MIN)], since, events: evs.slice(0, 1) });
  check('你按了按鈕、之後 Claude 又記一筆不算數的 → 你的照樣算,另外講那一筆不算', a.valid && a.by === 'human' && a.rejected?.why === 'no-words', JSON.stringify(a));
  eq('E 這一輪沒動過 → 之前的驗收講的是上一輪', acceptOf({ clears: [clear(-4 * MIN)], since: null, events: evs }), null);
  eq('E 最後一次動作之前記的 → 不算(講的是之前那一次)', acceptOf({ clears: [clear(-25 * MIN)], since, events: evs }), null);

  // 真的跑 CLI(L24:自己的假家目錄):在對話裡跑的 --clear E(環境有對話代號)——Claude 代記要附原話;沒有你的話,記了也不算數
  const s = scene();
  s.write([said(-30 * MIN, '驗收一下'), callV(-20 * MIN), act(-19 * MIN), rep(-15 * MIN, 'ok', ALL_SEEN)]);
  let r = s.cli(['--clear', 'E']);
  check('在對話裡跑、沒附原話 → 記下,但講明:Claude 替你記要附原話,你自己用 ! 跑的儀表板認得', r.code === 0 && /要附上使用者的原話/.test(r.out) && /用 ! 跑的/.test(r.out), r.out);
  check('記成在對話裡跑的(via claude、對話代號)', s.events().filter((e) => e.event === 'stage_cleared').at(-1)?.via === 'claude');
  eq('沒有你的話、也不是你用 ! 跑的 → 儀表板:E 不是 done', s.eOf()?.state === 'done', false);
  r = s.cli(['--clear', 'E', '使用者說驗收過了']);
  check('附了原話 → 記下,但講明這筆不算數(E 之後沒有使用者說的話)', r.code === 0 && /不算數/.test(r.out), r.out);
  const rec = s.events().filter((e) => e.event === 'stage_cleared').at(-1);
  check('記成 Claude 代記(via claude、對話代號),決定照舊是使用者的', rec?.via === 'claude' && rec?.by_session === 's1' && rec?.source === 'human', JSON.stringify(rec));
  let e = s.eOf();
  check('儀表板:E 不是 done,第三句講「不算數」', e?.state !== 'done' && /不算數/.test(e?.elines?.human ?? ''), JSON.stringify(e?.elines));
  s.append([said(-2 * MIN, '看過了，可以')]);
  r = s.cli(['--clear', 'E', '看過了，可以']);
  check('使用者在 E 之後說了話 → 算數,講出畫面附的那一句', r.code === 0 && /看過了，可以/.test(r.out) && !/不算數/.test(r.out), r.out);
  e = s.eOf();
  eq('儀表板:E done', e?.state, 'done');
  check('第三句:Claude 代記,附你在 E 之後說的最後一句', /Claude 代記：你說驗收過了（E 之後你說的最後一句：「看過了，可以」）/.test(e?.elines?.human ?? ''), e?.elines?.human);
  // 你自己在終端機跑(環境沒有對話代號):照舊是你說的
  s.write([said(-30 * MIN, '驗收一下'), callV(-20 * MIN), rep(-15 * MIN, 'ok', ALL_SEEN)]);
  r = s.cli(['--clear', 'E'], { session: null });
  check('你自己的終端機 → 記下,是你說的', r.code === 0 && !s.events().filter((x) => x.event === 'stage_cleared').at(-1)?.via, r.out);
  eq('儀表板:E done', s.eOf()?.state, 'done');
  s.cleanup();
}

section('AC-1:--report E 有「沒看到」卻記 ok 不收;講「走了一遍」,不講「沒問題」');
{
  const s = scene();
  s.write([said(-30 * MIN, '驗收一下'), callV(-20 * MIN)]);
  let r = s.cli(['--report', 'E', 'ok', '第 1 趟\nAC-1 沒看到：沒有標題']);
  check('有沒看到的卻記 ok → 不收', r.code === 1 && /found/.test(r.out), r.out);
  eq('沒有記下結論', s.events().filter((e) => e.event === 'stage_report').length, 0);
  r = s.cli(['--report', 'E', 'found', '第 1 趟\nAC-1 沒看到：沒有標題\nAC-2 看到了：按鈕是藍色的']);
  check('found 收下;講走了一遍與每種幾條(跟儀表板同一句),不講「找到問題」「沒問題」', r.code === 0 && /走了一遍：2 條裡 1 條看到了、1 條沒看到/.test(r.out) && !/沒問題/.test(r.out), r.out);
  check('沒附原文的「看到了」當場講出來', /AC-2 寫看到了，卻沒附畫面上的原文/.test(r.out), r.out);
  check('提醒:驗收過了只有使用者能說', /驗收過了只有使用者能說/.test(r.out), r.out);
  r = s.cli(['--report', 'E', 'ok', '走了一遍，都看到了']);
  check('一條都沒照格式寫 → 收下,但講明儀表板分不出看了哪幾條', r.code === 0 && /沒有一條照格式寫/.test(r.out), r.out);
  s.cleanup();
}

section('AC-4、AC-5:--round E 給照哪份規格、要驗哪幾條、怎麼跑起來——skill 不自己找(P2)', 'P2');
{
  const s = scene();
  const h = s.head();
  s.write([said(-30 * MIN, '照規格驗收'), s.link(-29 * MIN), callV(-20 * MIN, { head: h })]);
  let r = s.cli(['--round', 'E']);
  check('照 A 那格的同一份規格(--spec 連上的那份)', /照這份規格驗：docs\/進行中\/demo\.md/.test(r.out), r.out);
  check('列出要驗的每一條與白話', /AC-1 首頁有標題 —— 一打開就看到標題。/.test(r.out) && /AC-3 要穩定/.test(r.out), r.out);
  check('第一趟、就是現在這一趟', /第 1 趟（.*還沒記結論——就是現在這一趟）/.test(r.out), r.out);
  check('沒有 launch.json、也沒有 package.json → 看起來沒有畫面可以開,不硬走', /沒有畫面可以開/.test(r.out), r.out);
  check('驗自己開起來的那一份,不是已經在跑的那一份', /驗的是你自己開起來的那一份/.test(r.out), r.out);
  check('不准替使用者說驗收過了', /「驗收過了」只有使用者能說/.test(r.out), r.out);
  // 分批做:只驗這一批
  s.write([said(-30 * MIN, '照規格驗收'), s.link(-29 * MIN, { acs: ['AC-1', 'AC-3'] }), callV(-20 * MIN, { head: h })]);
  r = s.cli(['--round', 'E']);
  check('分批做的只列這一批', /這一批只驗 AC-1、AC-3/.test(r.out) && !/AC-2 按鈕是藍色的/.test(r.out), r.out);
  // 沒有規格:照你叫它時講的話;沒講就先問,不自己編
  s.write([said(-5 * MIN, `/${PLUGIN}:verify 看首頁的標籤有沒有對齊`)]);
  r = s.cli(['--round', 'E']);
  check('沒有規格 → 照叫的時候說的那句驗', /這一輪沒有規格/.test(r.out) && /叫 \/pipeline-monitor:verify 時說：「看首頁的標籤有沒有對齊」/.test(r.out), r.out);
  s.write([said(-6 * MIN, '驗收一下'), callV(-5 * MIN)]);
  r = s.cli(['--round', 'E']);
  check('叫的時候什麼都沒說 → 照對話裡交代的事驗,沒講就先問,不自己編步驟', /不自己編步驟/.test(r.out), r.out);
  // 怎麼跑起來:從專案自己讀
  mkdirSync(join(s.root, '.claude'), { recursive: true });
  writeFileSync(join(s.root, '.claude', 'launch.json'), JSON.stringify({ version: '0.0.1', configurations: [{ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 5173 }] }));
  r = s.cli(['--round', 'E']);
  check('有 launch.json → 照它的設定開,講名字與埠', /怎麼跑起來：\.claude\/launch\.json/.test(r.out) && /web：埠 5173/.test(r.out), r.out);
  writeFileSync(join(s.root, '.claude', 'launch.json'), '{ 壞掉');
  r = s.cli(['--round', 'E']);
  check('launch.json 讀不懂 → 講讀不懂,不當成沒有(R1)、不印例外訊息', /讀不懂（不是正確的 JSON）/.test(r.out) && !/Unexpected|SyntaxError/.test(r.out), r.out);
  rmSync(join(s.root, '.claude', 'launch.json'));
  writeFileSync(join(s.root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', test: 'x' } }));
  r = s.cli(['--round', 'E']);
  check('沒有 launch.json、package.json 有 dev → 照它補一份,回報講明', /package\.json 有 dev（vite）/.test(r.out) && /我補了 launch\.json/.test(r.out), r.out);
  s.cleanup();
}

section('AC-4、AC-5:worktree 沒有自己的 launch.json 時看主資料夾的(.claude/* 多半不跟著 checkout)');
{
  const s = scene();
  mkdirSync(join(s.root, '.claude'), { recursive: true });
  writeFileSync(join(s.root, '.claude', 'launch.json'), JSON.stringify({ configurations: [{ name: 'main-web', port: 4319 }] }));
  const wtParent = mkdtempSync(join(tmpdir(), 'pm-wt-'));
  const wt = join(wtParent, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'side'], { cwd: s.root, stdio: 'ignore' });
  const r = s.cli(['--round', 'E'], { cwd: wt, session: null });
  check('用主資料夾的設定,講明這個工作區沒有、要補一份', /這個工作區沒有，這是主資料夾的/.test(r.out) && /main-web：埠 4319/.test(r.out), r.out);
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: s.root, stdio: 'ignore' });
  rmSync(wtParent, { recursive: true, force: true });
  s.cleanup();
}

section('AC-6:第二趟之前,--round E 給上一趟花多久(紀錄算的)、第一趟之後改了哪些檔——要不要再走由使用者決定');
{
  const s = scene();
  const h = s.head();
  s.write([said(-40 * MIN, '驗收一下'), callV(-30 * MIN, { head: h }), rep(-25 * MIN, 'ok', ALL_SEEN)]);
  s.touch('src/a.js', -10 * MIN);
  const r = s.cli(['--round', 'E']);
  check('已經走完 1 趟;再走是第 2 趟', /已經走完 1 趟（記了結論的）；再走是第 2 趟/.test(r.out), r.out);
  check('上一趟從叫到記結論 5 分鐘(紀錄算的,不估)', /上一趟從叫到記結論 5 分鐘/.test(r.out), r.out);
  check('第一趟之後改了哪些檔', /之後改了 1 個程式檔：src\/a\.js/.test(r.out), r.out);
  check('問人的時候怎麼講、使用者說不用怎麼記、說可以怎麼記', /--decide E skip/.test(r.out) && /--clear E "使用者的原話"/.test(r.out), r.out);
  s.cleanup();
}

section('AC-8:分級預設不要求 E;專案把 E 放進清單時,收工 hook 要的是「Claude 走過一遍」,不是叫人按', 'P2');
{
  const levels = Object.entries(STAGES.tierLevels);
  check('stages.json 的三級預設都不放 E(Oscar 2026-09-23)', levels.every(([, l]) => !(l.requires ?? []).includes('E')), JSON.stringify(STAGES.tierLevels));
  const E = STAGES.stages.find((x) => x.id === 'E');
  check('E 認 verify 這支指令、結論會過期,瀏覽器工具照舊認', E.skill === 'verify' && E.rerunAfterChange === true && E.type === 'browser' && /Claude_Browser/.test(E.tools), JSON.stringify(E));

  // 預設的分級:碰到危險清單(T2),E 這一輪一次都沒走——收工 hook 不提 E
  let s = scene();
  s.write([said(-5 * MIN, '改一下')]);
  s.touch('src/danger.js', -2 * MIN);
  let d = s.gate();
  check('預設分級:收工 hook 擋的東西裡沒有 E', d !== null && !d.missing.some((k) => String(k).startsWith('E')), JSON.stringify(d?.missing));
  s.cleanup();

  // 專案自己的分級把 E 放進 T2
  const only = { none: { id: 'T0', requires: [] }, code: { id: 'T1', requires: [] }, danger: { id: 'T2', requires: ['E'] } };
  s = scene({ levels: only });
  s.write([said(-5 * MIN, '改一下')]);
  s.touch('src/danger.js', -2 * MIN);
  d = s.gate();
  check('還沒走 → 要 Claude 跑 verify', d?.missing.includes('E') && d.reason.includes(`/${PLUGIN}:verify`), d?.reason);
  check('講明「驗收過了」只有使用者能說,不叫它去按', /「驗收過了」只有使用者能說/.test(d?.reason ?? '') && !/按儀表板/.test(d?.reason ?? ''), d?.reason);
  // 走完、記了結論(不管看到了幾條)→ 這一級要的做到了,不叫人按
  s.write([said(-10 * MIN, '改一下'), callV(-4 * MIN), rep(-1 * MIN, 'ok', ALL_SEEN)]);
  s.touch('src/danger.js', -6 * MIN);
  eq('Claude 走過一遍(等使用者查核)→ 放行', s.gate(), null);
  // 叫了沒記結論:回答問題的回合也提醒(跟 D 同一條)
  s.write([said(-10 * MIN, '驗收一下'), callV(-9 * MIN), said(-3 * MIN, '好了嗎')]);
  d = s.gate();
  check('叫了還沒記結論 → 提醒(沒改程式的回合也要)', d?.missing.includes('E:report') && /還在走就照實說還在走/.test(d.reason), JSON.stringify(d));
  // 走過之後又改了程式:不叫它自己再走,叫它先問人
  s.write([said(-40 * MIN, '驗收一下'), callV(-30 * MIN), rep(-25 * MIN, 'ok', ALL_SEEN), said(-10 * MIN, '順便改一下')]);
  s.touch('src/danger.js', -5 * MIN);
  d = s.gate();
  check('走過之後又改了 → 先問人(E:ask),不叫它再走', d?.missing.includes('E:ask') && /不要自己再走/.test(d.reason) && /--decide E skip/.test(d.reason), d?.reason);
  // 使用者說驗收過了、之後沒再改 → 不要求
  s.write([said(-40 * MIN, '驗收一下'), callV(-30 * MIN), rep(-25 * MIN, 'ok', ALL_SEEN), said(-10 * MIN, '順便改一下'), clear(-1 * MIN)]);
  eq('你說驗收過了(在改完之後)→ 放行', s.gate(), null);
  // 使用者說驗收過了,之後又改了 → 先問人
  s.write([said(-40 * MIN, '驗收一下'), callV(-30 * MIN), rep(-25 * MIN, 'ok', ALL_SEEN), clear(-20 * MIN), said(-10 * MIN, '順便改一下')]);
  d = s.gate();
  check('你說驗收過了之後又改了 → 先問人,講明是你的驗收之後改的', d?.missing.includes('E:ask') && /使用者說驗收過了之後，又改了程式檔/.test(d.reason), d?.reason);
  s.cleanup();
}


section('英文那一份(規格:技能與寫給AI的話中英切換 AC-6):收工 hook 要 E 的那幾句——驗收過了只有使用者能說;「不用再走」(no need to walk through again)不是「驗收過了」(accepted),不准記成 --clear;不叫 Claude 自己再走', 'P7');
{
  const only = { none: { id: 'T0', requires: [] }, code: { id: 'T1', requires: [] }, danger: { id: 'T2', requires: ['E'] } };
  const s = scene({ levels: only });
  const eLine = (d) => (d?.reason ?? '').split('\n').find((l) => l.startsWith('- E ')) ?? '';
  s.write([said(-5 * MIN, 'change it')]);
  s.touch('src/danger.js', -2 * MIN);
  let d = withLang('en', () => s.gate()), l = eLine(d);
  check('還沒走 → 要 Claude 跑 verify,每條記 seen／not seen／can\'t verify', d?.missing.includes('E') && l.includes(`/${PLUGIN}:verify`) && /seen \(with the original text from the screen\) \/ not seen \/ can't verify/.test(l), l);
  check('……講明「accepted」只有使用者能說,不叫它去按儀表板', /only the user can say "accepted"/.test(l) && !/press the dashboard|dashboard's button/.test(l), l);
  check('……那一句不准把走一遍講成 verified／passed', !/\bverified\b|\bpass(ed)?\b/i.test(l), l);
  s.write([said(-40 * MIN, 'walk through it'), callV(-30 * MIN), rep(-25 * MIN, 'ok', ALL_SEEN), said(-10 * MIN, 'also change this')]);
  s.touch('src/danger.js', -5 * MIN);
  d = withLang('en', () => s.gate()); l = eLine(d);
  check('走過之後又改了 → 先停下來問人(E:ask),不叫它自己再走', d?.missing.includes('E:ask') && /Don't walk through it again on your own; stop and ask the user first/.test(l), l);
  check('……「不用再走」不是「驗收過了」:那一句照講,不准記成 --clear', /"No need to walk through again" isn't "accepted": never record it as --clear/.test(l), l);
  const skip = l.indexOf('--decide E skip'), looked = l.indexOf('Only if they say they\'ve looked and it\'s fine'), clr = l.indexOf('--clear E');
  check('……說不用 → --decide;說看過了、可以 → 才 --clear(--clear 只掛在「看過了、可以」那一句後面)', skip > 0 && looked > skip && clr > looked, l);
  // --round E 英文那一份:同一條紅線
  const enHome = s.monitorDir;
  writeFileSync(join(enHome, 'lang.json'), JSON.stringify({ lang: 'en' }));
  const r = s.cli(['--round', 'E']).out;
  check('--round E:只有使用者能說 accepted、不准按儀表板的按鈕', /Only the user can say "accepted": never press the dashboard's button/.test(r), r);
  check('……要不要再走:說不用 → --decide、看過了說可以 → 才 --clear;「不用再走」不是「驗收過了」', /If they say no need: pipeline-status --decide E skip/.test(r) && /"No need to walk through again" isn't "accepted": never record it as --clear/.test(r), r);
  check('……走完不要自己再走', /After walking through it, don't walk through it again on your own/.test(r), r);
  const rec = s.cli(['--report', 'E', 'ok', 'Walk 1: http://localhost:5173\nAC-1 seen: "Welcome back"\nAC-2 seen: "Send"\nAC-3 can\'t verify: not visible on the screen']).out;
  check('--report E:講 Claude 說走了一遍,不是 accepted;只有使用者能說', /^✅ Recorded: /.test(rec) && /walked through/.test(rec) && /This is "what Claude says", not accepted: only the user can say it's accepted/.test(rec), rec);
  check('……第一行不准講成 verified／passed／accepted', !/\bverified\b|\bpass(ed)?\b|\baccepted\b/i.test(rec.split('\n')[0]), rec.split('\n')[0]);
  s.cleanup();
}

section('收尾:skill 自己不准替你說驗收過了、不准自己再走一趟;第一步先問 --round E(AC-3、AC-6、AC-9)——先寫必須抓到、必須放過的句子', 'P4');
{
  const skill = readFileSync(join(ROOT, 'skills', 'verify', 'SKILL.md'), 'utf8');
  check('第一步:先跑 pipeline-status --round E', /跑 `pipeline-status --round E`/.test(skill));
  check('不按儀表板上的「你說驗收過了」', /不按儀表板上的「你說驗收過了」/.test(skill));
  check('使用者親口說了才記,而且附原話', /--clear E "使用者的原話"/.test(skill) && /親口說了/.test(skill));
  check('「不用再走」不是「驗收過了」', /「不用再走」不是「驗收過了」/.test(skill));
  check('記完就停、不准自己再走一趟;要再走先問人', /不准自己再走一趟/.test(skill) && /不准自己再走\*\*，先停下來問使用者/.test(skill));
  // 9/17 D 自己連跑三輪,就是 skill 裡那一句「處理完之後再跑一次這一關」。E 版的同一句不准寫進來(魔鬼教官第一輪:以前那條檢查只認一種寫法)
  const selfRewalk = (t) => /(處理|修|改)(完|好)[^。\n]{0,14}?再(走|跑|驗)[^。\n]{0,4}?(一次|一趟|一遍)/.test(t);
  for (const bad of ['使用者或你修完之後再走一趟，說都看到了才算結案。', '處理完再走一遍這一關', '改完再走一次這一關', '修完再走一趟。']) {
    check(`必須抓到:「${bad}」`, selfRewalk(bad));
  }
  check('必須放過:「使用者說走 → 再叫這一關」(人決定之後才再叫)', !selfRewalk('- 使用者說走 → 再叫這一關。'));
  check('skill 裡沒有叫它自己再走一趟的句子', !selfRewalk(skill), (skill.match(/(處理|修|改)(完|好)[^。\n]{0,14}?再(走|跑|驗)[^。\n]{0,4}?(一次|一趟|一遍)/) ?? [''])[0]);
}

section('畫面:E 那一格畫三句話與逐條的清單;Claude 走完沒有打勾、按鈕還在;你說驗收過了之後按鈕才收起來(真的跑 ui/app.js 的 workflow,L20)');
{
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const fn = (name) => src.match(new RegExp(`^function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const one = (name) => src.match(new RegExp(`^const ${name} = .*;$`, 'm'))?.[0] ?? null;
  // 那一句、旁白、清單的那幾句都是伺服器給的(規格:終端機與網頁說同一句):畫面只剩 workflow 與它的小幫手
  // (roundStage:這一輪走到哪一關;FACE／eyes／agent:畫工班——工地工班風畫面 AC-7、AC-8)
  const parts = [one('stageState'), one('OLD_LINE'), one('FACE'), fn('roundStage'), fn('eyes'), fn('agent'), fn('workflow')];
  check('從 ui/app.js 拿得出 workflow 與它用到的小函式(拿不出來這一段就什麼都沒測到)', parts.every(Boolean), parts.map((p, i) => (p ? '' : i)).join(','));
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const wf = parts.every(Boolean) ? new Function('esc', 'ago', 'ROLE', 'foldOpen', `const zhEn = (zh) => zh; const many = (n, one, more = one + 's') => n + ' ' + (n === 1 ? one : more);\n${parts.join('\n')}; return workflow;`)(esc, ago, {}, () => true) : null;
  const s = scene();
  s.write([said(-30 * MIN, '驗收一下'), callV(-20 * MIN), act(-19 * MIN), rep(-15 * MIN, 'found', '第 1 趟\nAC-1 看到了：首頁寫著「歡迎回來」\nAC-2 沒看到：應該是藍色，畫面上是灰色')]);
  const card = s.project()?.cards?.[0];
  let html = '';
  try { html = wf?.(card) ?? ''; } catch (e) { html = `畫面壞了：${e.message}`; }
  const eCard = html.slice(html.lastIndexOf('<div class="acard"'));
  check('三句話都在:開過瀏覽器、Claude 說走了一遍、還沒有人說驗收過了', /開過瀏覽器（1 個動作/.test(eCard) && /Claude 說走了一遍：2 條裡 1 條看到了、1 條沒看到/.test(eCard) && /還沒有人說驗收過了/.test(eCard), eCard.slice(0, 900));
  check('逐條列出來,看到了用 👁 不用打勾', /👁/.test(eCard) && /沒看到：應該是藍色/.test(eCard) && !/✅/.test(eCard), eCard.slice(0, 900));
  check('按鈕「你說驗收過了」還在', /data-clear="E"/.test(eCard), eCard.slice(-400));
  s.append([clear(-1 * MIN)]);
  html = wf?.(s.project()?.cards?.[0]) ?? '';
  const done = html.slice(html.lastIndexOf('<div class="acard"'));
  check('你說驗收過了之後:第三句是你說的,按鈕收起來', /你說驗收過了/.test(done) && !/data-clear="E"/.test(done), done.slice(0, 900));
  s.cleanup();
}

section('魔鬼教官第一輪:你說的驗收不綁在開瀏覽器上——之後開一下瀏覽器、先看一眼再代記、這一輪沒開過瀏覽器你自己記的,都照樣算', 'P2');
{
  const walk = [said(-40 * MIN, '驗收一下'), callV(-20 * MIN), act(-19 * MIN), rep(-15 * MIN, 'ok', ALL_SEEN)];
  let { E } = viewOf([...walk, clear(-12 * MIN), act(-5 * MIN, 'mcp__Claude_Browser__computer')]);
  eq('你按了驗收之後 Claude 開瀏覽器截一張圖(沒改程式) → 照樣 done', E.state, 'done');
  ({ E } = viewOf([...walk, said(-10 * MIN, '看過了，可以'), act(-8 * MIN), clear(-5 * MIN, { via: 'claude', by_session: 's1', quote: '看過了，可以' })]));
  check('你說了可以、Claude 先開瀏覽器看一眼才代記 → 算數,附你那句話', E.state === 'done' && E.accept?.by === 'claude' && E.accept?.said?.text === '看過了，可以', JSON.stringify(E.accept));
  ({ E } = viewOf([said(-40 * MIN, '改一下標籤'), clear(-10 * MIN)]));
  eq('這一輪 Claude 沒開過瀏覽器、你自己驗過記了驗收 → done', E.state, 'done');
  ({ E } = viewOf([callV(-40 * MIN, { skill: `${PLUGIN}:spec` }), clear(-45 * MIN), said(-30 * MIN, '開工')]));
  eq('這一輪開始之前記的驗收 → 不算(講的是上一件事)', E.accept, null);
  // 同一個資料夾的另一個對話開了一下瀏覽器:案件卡(資料夾層級)也不能因此作廢你的驗收
  const s = scene();
  s.write([said(-40 * MIN, '驗收一下'), callV(-20 * MIN), rep(-15 * MIN, 'ok', ALL_SEEN), clear(-12 * MIN), act(-5 * MIN, 'mcp__Claude_Browser__navigate', { session: 's2' })]);
  eq('案件卡:別的對話開瀏覽器之後,E 照樣 done', s.project()?.cards?.[0]?.stages?.find((x) => x.id === 'E')?.state, 'done');
  s.cleanup();
}

section('魔鬼教官第一輪:沒走過 verify、你驗收過、之後又改了程式——「不用再走」記得下來,不會被逼成「驗收過了」', 'P6');
{
  const s = scene({ levels: { none: { id: 'T0', requires: [] }, code: { id: 'T1', requires: [] }, danger: { id: 'T2', requires: ['E'] } } });
  const h = s.head();
  s.write([said(-40 * MIN, '看一下首頁'), act(-30 * MIN), clear(-20 * MIN, { head: h }), said(-12 * MIN, '順便改一下')]);
  s.touch('src/danger.js', -10 * MIN);
  let e = s.eOf();
  eq('你的驗收之後又改了程式 → accepted-stale', e?.rerun?.estate ?? e?.estate, 'accepted-stale');
  let r = s.cli(['--round', 'E']);
  check('--round E 講你的驗收、之後改了哪些檔(從你那一刻的版本比)', /使用者說驗收過了（.*），之後又改了程式檔/.test(r.out) && /使用者說驗收過了（.*）之後改了 1 個程式檔：src\/danger\.js/.test(r.out), r.out);
  check('--round E 講明「不用再走」不是「驗收過了」', /「不用再走」不是「驗收過了」/.test(r.out), r.out);
  let d = s.gate();
  check('收工 hook:先問人,不准把「不用再走」記成 --clear', d?.missing.includes('E:ask') && /不准記成 --clear/.test(d.reason), d?.reason);
  s.append([said(-3 * MIN, '不用再走了')]);
  r = s.cli(['--decide', 'E', 'skip', '不用再走了']);
  check('--decide E skip 收得下(錨在你的驗收),講出畫面附的那一句', r.code === 0 && /說驗收過了之後說的最後一句：「不用再走了」/.test(r.out), r.out);
  e = s.eOf();
  eq('E 擱著(你說不用再走),不是 done', e?.state, 'held');
  check('第三句講你的驗收是改之前的、你說不用再走,不寫「驗收過了」成立', /之後又改了程式檔；Claude 記下：你說不用再走（E 之後你說的最後一句：「不用再走了」/.test(e?.elines?.human ?? ''), e?.elines?.human);
  eq('收工 hook 不再擋', s.gate(), null);
  s.cleanup();
}

section('魔鬼教官第一輪:分級卡那一行跟 E 那一格同一句——Claude 代記不講成「你說」、漏報的條目照樣列「沒有結果」;--report E 回的也是這一句', 'P2');
{
  const s = scene({ levels: { none: { id: 'T0', requires: [] }, code: { id: 'T1', requires: [] }, danger: { id: 'T2', requires: ['E'] } } });
  s.write([said(-40 * MIN, '驗收一下'), s.link(-39 * MIN), callV(-20 * MIN)]);
  s.touch('src/danger.js', -30 * MIN);
  const r = s.cli(['--report', 'E', 'ok', '第 1 趟\nAC-1 看到了：首頁寫著「歡迎回來」\nAC-2 看到了：按鈕寫著「送出」']);
  check('--report E 回的那句拿這一輪的規格對:3 條裡 2 條看到了、AC-3 沒有結果', /3 條裡 2 條看到了；AC-3 沒有結果/.test(r.out), r.out);
  check('記完馬上回讀的那一筆講「剛剛」,不講「時間對不上」(魔鬼教官第二輪,LESSONS L42)', /記下了：剛剛Claude 說走了一遍/.test(r.out) && !/對不上/.test(r.out), r.out);
  const rowOf = (sess) => sess?.tier?.requirements?.find((x) => x.key === 'E') ?? null;
  const row = () => rowOf(s.sessionOf());
  // 兩句要從同一次算出來的拿:「幾分鐘前」有秒數,各算一次差一秒就不等(L18:測試裡的「現在」只准取一次)
  const sess = s.sessionOf();
  const e = sess?.stages?.find((x) => x.id === 'E') ?? null;
  check('分級卡:跟 E 那一格同一句(含 AC-3 沒有結果、還沒有人說驗收過了),不打勾', rowOf(sess)?.state === 'ran' && rowOf(sess)?.detail === `${e?.elines?.walk}——${e?.elines?.human}` && /AC-3 沒有結果/.test(rowOf(sess)?.detail ?? ''), JSON.stringify(rowOf(sess)));
  s.append([said(-2 * MIN, '看過了，可以'), clear(-1 * MIN, { via: 'claude', by_session: 's1', quote: '看過了，可以' })]);
  check('Claude 代記 → 分級卡寫 Claude 代記與你那句話,不寫成「你說」', row()?.state === 'ok' && /Claude 代記：你說驗收過了（E 之後你說的最後一句：「看過了，可以」）/.test(row()?.detail ?? ''), JSON.stringify(row()));
  eq('對話列那一句也講是 Claude 代記', s.eOf()?.ewhere, 'Claude 代記：你說驗收過了');
  s.cleanup();
}

section('魔鬼教官第一輪:--round E 講規格的話跟 A 那格同一份;規格只在主資料夾時照那份讀,漏報的條目照樣列「沒有結果」', 'P5');
{
  let s = scene();
  writeFileSync(join(s.root, 'docs', '進行中', 'plan.md'), '# 計畫\n\n先做首頁，再做設定頁。\n');
  s.write([said(-40 * MIN, '照計畫驗收'), s.link(-39 * MIN, { spec: 'docs/進行中/plan.md' }), callV(-20 * MIN)]);
  let r = s.cli(['--round', 'E']);
  check('規格在、讀不出條目 → 講規格檔在但沒有照格式寫的 AC,不講「沒有規格」', /規格檔在（.*plan\.md），但裡面沒有照格式寫的 AC/.test(r.out) && !/這一輪沒有規格/.test(r.out), r.out);
  mkdirSync(join(s.root, 'docs', '升級摘要'), { recursive: true });
  writeFileSync(join(s.root, 'docs', '升級摘要', 'demo.md'), SPEC);
  s.write([said(-40 * MIN, '照規格驗收'), s.link(-39 * MIN, { spec: 'docs/規劃中/demo.md' }), callV(-20 * MIN)]);
  r = s.cli(['--round', 'E']);
  check('同名不只一份 → 講 A 那格的那一句(分不出是哪一份),不講「找不到」', /規格：工作區裡叫 demo\.md 的規格不只一份/.test(r.out) && !/找不到這一輪的規格檔/.test(r.out), r.out);
  s.cleanup();
  // 規格只在主資料夾(還沒併進這條分支):worktree 裡照主資料夾那份讀要驗哪幾條
  s = scene();
  writeFileSync(join(s.root, 'docs', '進行中', 'only-main.md'), SPEC);
  const wtParent = mkdtempSync(join(tmpdir(), 'pm-wt-'));
  execFileSync('git', ['worktree', 'add', '-q', join(wtParent, 'wt'), '-b', 'side'], { cwd: s.root, stdio: 'ignore' });
  const wt = out(join(wtParent, 'wt'), 'rev-parse', '--show-toplevel');   // 真實路徑(macOS 的暫存資料夾有兩種拼法),感測器記的就是它
  const inWt = (o) => ({ ...o, cwd: wt });
  s.write([inWt(said(-40 * MIN, '照規格驗收')), inWt(s.link(-39 * MIN, { spec: 'docs/進行中/only-main.md', main: s.root })), inWt(callV(-20 * MIN)),
           inWt(rep(-10 * MIN, 'ok', '第 1 趟\nAC-1 看到了：首頁寫著「歡迎回來」\nAC-2 看到了：按鈕寫著「送出」'))]);
  r = s.cli(['--round', 'E'], { cwd: wt });
  check('--round E:規格在主資料夾,照那份讀(只讀),列出三條', /規格在主資料夾，不在這個工作區——照那份讀/.test(r.out) && /AC-3 要穩定/.test(r.out), r.out);
  const e = s.sessionOf()?.stages?.find((x) => x.id === 'E');
  check('E 那一格:3 條裡 2 條看到了、AC-3 沒有結果(漏報的不會安靜消失)', /3 條裡 2 條看到了；AC-3 沒有結果/.test(e?.elines?.walk ?? ''), e?.elines?.walk);
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: s.root, stdio: 'ignore' });
  rmSync(wtParent, { recursive: true, force: true });
  s.cleanup();
}

section('魔鬼教官第一輪:共用資料夾時,另一個對話的 Claude 代記不會劃掉這個對話的 E(跟 --decide 同一套)', 'P2');
{
  const evs = [said(-40 * MIN, '驗收一下'), callV(-20 * MIN), rep(-15 * MIN, 'found', 'x\nAC-1 沒看到：沒有標題'),
               said(-5 * MIN, '設定頁看過了，可以', { session: 's2' }), clear(-2 * MIN, { via: 'claude', by_session: 's2', quote: '設定頁看過了，可以' })]
    .map((e) => ({ session: e.event ? undefined : 's1', cwd: '/x', ...e }));
  const s1 = sessionView(evs, STAGES.stages, 's1', null, '/x', {}).view.stages.find((x) => x.id === 'E');
  check('這個對話(s1)的 E 不被劃掉', s1.state !== 'done' && !s1.accept?.valid, JSON.stringify({ state: s1.state, accept: s1.accept }));
  const s2 = sessionView(evs, STAGES.stages, 's2', null, '/x', {}).view.stages.find((x) => x.id === 'E');
  eq('記它的那個對話(s2)自己算數', s2.accept?.valid, true);
}

section('魔鬼教官第一輪:你自己在對話框用 ! 跑 --clear E,認得是你——不是 Claude 代記', 'P7');
{
  const walk = [said(-40 * MIN, '驗收一下'), callV(-20 * MIN), rep(-15 * MIN, 'ok', ALL_SEEN)];
  const bang = (sec, cmd) => ({ ts: T(sec), hook: 'UserPromptSubmit', prompt: `<bash-input>${cmd}</bash-input>`, prompt_id: `b${sec}` });
  let { E } = viewOf([...walk, clear(-5 * MIN, { via: 'claude', by_session: 's1' }), bang(-5 * MIN + 1, 'pipeline-status --clear E')]);
  check('感測器記到你打的那一句 ! 指令 → 算你按的', E.state === 'done' && E.accept?.by === 'human' && E.accept?.bang === true, JSON.stringify(E.accept));
  eq('第三句:你說驗收過了(不寫 Claude 代記)', /^.*你說驗收過了$/.test(eLines(E, { ago }).human) && !/Claude 代記/.test(eLines(E, { ago }).human), true);
  ({ E } = viewOf([...walk, clear(-5 * MIN, { via: 'claude', by_session: 's1' }), bang(-5 * MIN + 1, 'pipeline-status --serve-restart')]));
  eq('別的 ! 指令不算', E.accept?.valid ?? false, false);
  // 真的跑 CLI:對話框的 ! 帶著對話代號、沒附原話 → 以前一律拒收;現在記下,感測器那一句進來就算你的
  const s = scene();
  s.write(walk);
  const r = s.cli(['--clear', 'E']);
  check('在對話裡跑、沒附原話 → 記下(不拒收)', r.code === 0 && s.events().some((x) => x.event === 'stage_cleared'), r.out);
  // 感測器在指令跑完之後才記下那一句:時間接在記下那一筆之後(測試跑到這裡離 NOW 已經過了好一段,不能用 NOW 算)
  const recAt = Date.parse(s.events().filter((x) => x.event === 'stage_cleared').at(-1).ts);
  s.append([{ ...bang(0, 'pipeline-status --clear E'), ts: new Date(recAt + 1000).toISOString() }]);
  eq('感測器記下你打的那一句之後 → 儀表板 E done', s.eOf()?.state, 'done');
  s.cleanup();
}

section('魔鬼教官第一輪:你驗收之後用 Bash 把改動還原(git 說跟起點沒差),E 不再照樣寫你說驗收過了', 'P1');
{
  const s = scene();
  s.write([said(-60 * MIN, '改一下'), edit(-45 * MIN, join(s.root, 'src', 'a.js')), callV(-40 * MIN), rep(-35 * MIN, 'ok', ALL_SEEN), clear(-30 * MIN)]);
  s.touch('src/a.js', -45 * MIN, 'new\n');
  eq('驗收之後沒再動 → done', s.eOf()?.state, 'done');
  s.touch('src/a.js', -5 * MIN, '1\n');   // 用 Bash 還原成起點的內容:git diff 看不到它了
  eq('(git 說這個檔跟起點沒差)', out(s.root, 'status', '--porcelain', '--', 'src/a.js'), '');
  const e = s.eOf();
  check('還原之後 → 你的驗收講的是改之前的版本:要不要再走由你決定', e?.state === 'stale' && (e?.rerun?.estate ?? e?.estate) === 'accepted-stale', JSON.stringify({ state: e?.state, estate: e?.rerun?.estate }));
  s.cleanup();
}

section('魔鬼教官第一輪:--report E 同一條寫兩次,先寫的「沒看到」不准安靜消失');
{
  const w = parseWalk('AC-1 沒看到：沒有標題\nAC-1 看到了：「歡迎」');
  eq('講出哪一條寫了兩次', w.dups.map((d) => d.id).join(','), 'AC-1');
  check('一句話裡講「寫了不只一次」', /AC-1 寫了不只一次（照最後一次算）/.test(summaryLine(walkSummary(w))), summaryLine(walkSummary(w)));
  const s = scene();
  s.write([said(-30 * MIN, '驗收一下'), callV(-20 * MIN)]);
  const r = s.cli(['--report', 'E', 'ok', '第 1 趟\nAC-1 沒看到：沒有標題\nAC-1 看到了：「歡迎」']);
  check('有一行寫沒看到卻記 ok → 不收(後面再寫看到了也一樣)', r.code === 1, r.out);
  s.cleanup();
}

section('魔鬼教官第二輪:收工 hook 的「這一回合改了沒」跟五關同一份——用 Bash 還原也看得到,D 過期就叫 Claude 先問', 'P2');
{
  const s = scene({ levels: { none: { id: 'T0', requires: [] }, code: { id: 'T1', requires: [] }, danger: { id: 'T2', requires: ['D'] } } });
  const h = s.head();
  const callD = (sec) => ({ ts: T(sec), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:chaos-check`, head: h });
  const repD = (sec) => ({ ts: T(sec), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'claude', by_session: 's1' });
  s.write([said(-60 * MIN, '改一下'), edit(-50 * MIN, join(s.root, 'src', 'a.js')), callD(-40 * MIN), repD(-35 * MIN), said(-10 * MIN, '把 a.js 剛剛那個改回去')]);
  s.touch('src/danger.js', -50 * MIN);            // 還留著的改動:這次還是 T2
  s.touch('src/a.js', -50 * MIN, 'new\n');
  s.touch('src/a.js', -5 * MIN, '1\n');            // 這一回合用 Bash 還原:git 說它跟起點沒差,感測器也沒看到
  const d = s.gate();
  check('這一回合只有 Bash 還原 → 收工 hook 照樣看得到,叫 Claude 先問要不要再跑 D', d?.missing.includes('D:ask'), JSON.stringify(d?.missing));
  s.cleanup();
}

section('魔鬼教官第二輪:網頁對話列那一句,Claude 代記的驗收講是 Claude 代記(真的跑 ui/app.js 的 roundWhere)', 'P2');
{
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  // roundWhere 問「走到哪一關」的是 roundStage(五關發光的那一顆也問它,老毛病 P2),一起拿出來
  const code = ['roundStage', 'roundWhere'].map((n) => src.match(new RegExp(`^function ${n}\\(stages\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null);
  check('從 ui/app.js 拿得出 roundWhere 與 roundStage(拿不出來這一段就什麼都沒測到)', code.every(Boolean));
  const rw = code.every(Boolean) ? new Function(`const zhEn = (zh) => zh; const many = (n, one, more = one + 's') => n + ' ' + (n === 1 ? one : more);\n${code.join('\n')}; return roundWhere;`)() : () => '';
  const e = (o) => ({ id: 'E', name: '驗收', type: 'browser', skill: 'verify', ...o });
  eq('Claude 代記 → 講 Claude 代記', rw([e({ state: 'done', ewhere: 'Claude 代記：你說驗收過了' })]), '這一輪走到 E 驗收（Claude 代記：你說驗收過了）');
  eq('你自己按的 → 你說驗收過了', rw([e({ state: 'done', ewhere: '你說驗收過了' })]), '這一輪走到 E 驗收（你說驗收過了）');
  eq('舊的服務沒給那一句 → 照舊', rw([e({ state: 'done' })]), '這一輪走到 E 驗收（你說驗收過了）');
}

section('魔鬼教官第二輪:共用資料夾時,你在另一個對話用 ! 自己記的驗收,這個對話也認(跟按鈕一樣);別的指令帶著 --clear 字樣不算', 'P7');
{
  const clearAt = -5 * MIN;
  const evs = (cmd) => [said(-40 * MIN, '驗收一下'), callV(-20 * MIN), rep(-15 * MIN, 'ok', ALL_SEEN),
    clear(clearAt, { via: 'claude', by_session: 's2' }), { ts: T(clearAt + 1), hook: 'UserPromptSubmit', prompt: `<bash-input>${cmd}</bash-input>`, prompt_id: 'b1', session: 's2' }]
    .map((e) => ({ session: e.event ? undefined : 's1', cwd: '/x', ...e }));
  const E1 = sessionView(evs('pipeline-status --clear E'), STAGES.stages, 's1', null, '/x', {}).view.stages.find((x) => x.id === 'E');
  check('另一個對話你自己用 ! 記的 → 這個對話也算你說驗收過了', E1.state === 'done' && E1.accept?.bang === true, JSON.stringify(E1.accept));
  const E2 = sessionView(evs('npx jest --clear-cache'), STAGES.stages, 's1', null, '/x', {}).view.stages.find((x) => x.id === 'E');
  eq('別的指令帶著 --clear 字樣 → 不算', E2.accept?.valid ?? false, false);
}

section('好幾份規格的 E:兩份都有 AC-1,代號前面加規格名才分得開;只寫 AC-1 的不猜是哪一份(規格:多份規格與新資料夾的起點 AC-4)', 'P2');
{
  const expected = ['甲 AC-1', '甲 AC-2', '乙 AC-1'];
  const w = parseWalk('第 1 趟\n甲 AC-1 看到了：「一」\n- 乙.md AC-1 沒看到：應該是藍色，畫面上是灰色\ndocs/進行中/甲.md AC-02 驗不了：跑不起來\nAC-1 看到了：「這是哪一份？」');
  eq('規格名、檔名、整個路徑都認成同一個樣子', w.items.map((x) => x.id).join('|'), '甲 AC-1|乙 AC-1|甲 AC-2|AC-1');
  const sum = walkSummary(w, expected);
  eq('三種各一條;只寫 AC-1 的不算進任何一份', `${sum.total}|${sum.saw}|${sum.missing}|${sum.blocked}|${sum.unnamed.join(',')}|${sum.extra.join(',')}|${sum.noResult.join(',')}`, '3|1|1|1|AC-1||');
  const line = summaryLine(sum);
  check('一句話:三條各一種,只寫 AC-1 的講沒寫是哪一份(不講成不在這一輪的規格裡)', line.startsWith('3 條裡 1 條看到了、1 條沒看到、1 條驗不了') && line.includes('AC-1 沒寫是哪一份規格（不猜是哪一份）') && !line.includes('不在這一輪的規格裡'), line);
  const rows = walkItems(w, expected, new Map([['甲 AC-1', '第 1 條'], ['甲 AC-2', '第 2 條'], ['乙 AC-1', '第 1 條']]));
  eq('逐條:照要驗的順序,只寫 AC-1 的排最後、標「沒寫是哪一份規格」', rows.map((r) => `${r.id}:${r.verdict}${r.note}`).join('|'), '甲 AC-1:saw|甲 AC-2:blocked|乙 AC-1:missing|AC-1:saw（沒寫是哪一份規格，不猜）');
  // 只有一份規格的輪次:照今天的格式,一個字不變
  const one = walkSummary(parseWalk('第 1 趟\nAC-1 看到了：「一」\n1 看到了：「沒有規格的輪次」'), ['AC-1']);
  eq('一份規格:AC-1 照舊算看到了;沒有一條講「沒寫是哪一份」', `${one.saw}|${one.unnamed.length}|${one.extra.join(',')}`, '1|0|1');
  eq('沒有規格的輪次:數字編號照舊', walkSummary(parseWalk('第 1 趟\n1 看到了：「a」\n2 驗不了：b'), null).total, 2);
}

section('一條都對不上不是「沒有結果」:改格式之前走的那一趟,回報有 15 行、一條都對不上規格名(2026-10-05 實測)', 'P5');
{
  // 改格式之前走的那一趟(2026-10-02 TutorPod 實測):一份寫「語音 AC-1」、一份只寫「AC-1」——一條都對不上,但不是沒有結果
  const old = summaryLine(walkSummary(parseWalk('第 1 趟\n語音 AC-1 看到了：「x」\nAC-1 看到了：「y」'), ['甲 AC-1', '乙 AC-1']));
  check('一條都對不上、但回報有照格式寫的行 → 講「沒有一條對得上」,不講「沒有一條有結果」(讀起來像什麼都沒驗)', old.startsWith('2 條裡 沒有一條對得上') && !old.includes('沒有一條有結果'), old);
  eq('回報真的一行都沒有 → 照舊講沒有一條有結果', summaryLine(walkSummary(parseWalk('第 1 趟'), ['甲 AC-1'])).startsWith('1 條裡 沒有一條有結果'), true);
}

section('E 回報帶了規格名:只有一份規格時,寫的就是那一份的名字 → 照常算;名字對不上(自己取的暱稱)不准講成「不在這一輪的規格裡」,裡面的「沒看到」不准被埋掉(魔鬼教官第一輪)', 'P4');
{
  const w1 = parseWalk('第 1 趟\nreport-row-time AC-1 看到了：「x」\nreport-row-time AC-2 沒看到：應該是 y');
  const one = walkSummary(w1, ['AC-1', 'AC-2'], { single: 'report-row-time' });
  eq('一份規格、前面寫了那份的名字 → 兩條都對上', `${one.saw}|${one.missing}|${one.extra.length}|${one.misnamed.length}`, '1|1|0|0');
  check('一句話:2 條裡 1 條看到了、1 條沒看到(不講不在這一輪的規格裡)', summaryLine(one) === '2 條裡 1 條看到了、1 條沒看到', summaryLine(one));
  const other = walkSummary(parseWalk('第 1 趟\n別份 AC-1 沒看到：z'), ['AC-1'], { single: 'report-row-time' });
  check('一份規格、前面寫的是別的名字 → 規格名對不上,而且講有一條寫沒看到', summaryLine(other).includes('別份 AC-1 前面的規格名對不上這一輪的規格') && summaryLine(other).includes('對不上的回報裡有 1 條寫「沒看到」'), summaryLine(other));
  // 兩份規格、Claude 自己取暱稱(10/2 那一趟真的這樣寫)
  const w2 = parseWalk('第 1 趟\n語音 AC-1 沒看到：應該有紅字\n甲 AC-1 看到了：「一」');
  const two = walkSummary(w2, ['甲 AC-1', '乙 AC-1'], { names: ['甲', '乙'], unreadable: [] });
  const line = summaryLine(two);
  check('暱稱:講前面的規格名對不上(不是「不在這一輪的規格裡」),沒看到那一條要講', line.includes('語音 AC-1 前面的規格名對不上這一輪的規格') && !line.includes('不在這一輪的規格裡') && line.includes('對不上的回報裡有 1 條寫「沒看到」'), line);
  const rows = walkItems(w2, ['甲 AC-1', '乙 AC-1'], null, { names: ['甲', '乙'], unreadable: [] });
  eq('逐條:暱稱那一條標規格名對不上', rows.find((r) => r.id === '語音 AC-1')?.note, '（前面的規格名對不上這一輪的規格）');
  // 好幾份、名字對、但規格裡沒有這一條 → 那才是「不在這一輪的規格裡」
  eq('名字對、規格裡沒有這一條 → 不在這一輪的規格裡', walkSummary(parseWalk('第 1 趟\n甲 AC-9 看到了：「?」'), ['甲 AC-1'], { names: ['甲'], unreadable: [] }).extra.join(','), '甲 AC-9');
}

process.exit(summary());
