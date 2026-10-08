/**
 * expiry.test.mjs —— 紀錄全部過期清空之後,畫面照實說「90 天內沒有紀錄」(規格:90天清空之後的說法,路徑看 CLAUDE.md 的表)
 *
 * 專案三個月沒用,紀錄照規矩清成空的——這是規矩,不是故障。釘的是會安靜說謊的地方:
 *   ① 終端機說「感測器可能沒在運作」、清的那一次說「沒有一筆來自這個 worktree」、感測器那一行說「還沒有來自這裡的紀錄」(R1,P5)
 *   ② 儀表板叫你去掛一個早就掛著的感測器、說「還沒有結案的對話」、沒有還原點的說「還沒有資料」(R1,P5)
 *   ③ 反過來講死「是過期清掉的,沒事」:空檔看不出是清空的、還是從來沒寫進去——那會把感測器壞了講成正常(P3)
 *   ④ 終端機與儀表板各講各的(P2);舊的服務少了新欄位,畫面壞掉或自己湊一句(L20)
 * 每一種都真的跑一次終端機(status.mjs)、真的算一次儀表板的資料(collectAll)、真的跑整支 ui/app.js 畫一次。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdtempSync, mkdirSync, rmSync, readFileSync, symlinkSync, copyFileSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { readEvents, safeName, RETAIN_DAYS } from '../lib/events.mjs';
import { noRecordLine } from '../lib/rounds.mjs';
import { noneHereLine, optedOutLine } from '../lib/faults.mjs';
import { stageLine } from '../lib/stageLines.mjs';
import { collectAll } from '../lib/collect.mjs';
import { optOut, mountFix } from '../lib/mount.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name;
// 「現在」只取一次(L18)
const NOW = Date.now();
const D = (days) => new Date(NOW - days * 86400_000).toISOString();
const H = (h) => new Date(NOW - h * 3600_000).toISOString();
const TERM = '最上面那一行', WEB = '最上面那一條';
const text = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/**
 * 一個專案、假的監視器資料夾、裝了 plugin 的假 home(感測器「已掛上」——清空之後它明明掛著)。
 * records:'expired' 最新一筆 91 天前(停了三個月的專案)、'fresh' 一小時前、'empty' 紀錄檔在但一行都沒有(從來沒寫進去)、'none' 沒有紀錄檔
 * stamp:蓋一顆三個月前的章(Forma Pro 就有一顆,9/16):有章,儀表板才知道那個資料夾在哪
 * plugin:'dangling' = 捷徑指空(pipeline-monitor 資料夾搬走了,2026-09-10 真的發生過):感測器掛壞了;'none' = 沒裝 plugin(拆掉了):感測器沒掛上
 */
function scene({ records = 'expired', stamp = true, plugin = 'ok' } = {}) {
  const r = makeRepo({ files: { 'a.js': '1\n' }, at: D(RETAIN_DAYS + 3) });
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: r.dir, encoding: 'utf8' }).trim();
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-xmon-'));
  const logDir = join(monitorDir, 'logs');
  mkdirSync(logDir); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-xhome-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  if (plugin !== 'none') symlinkSync(plugin === 'dangling' ? join(home, '搬走了') : ROOT, join(home, '.claude', 'skills', PLUGIN));
  // 轉錄資料夾給一個空的:不准去讀這台電腦真的 ~/.claude/projects(P8)
  const transcripts = mkdtempSync(join(tmpdir(), 'pm-xtr-'));
  const name = safeName(basename(root));
  const log = join(logDir, `${name}.jsonl`);
  const lines = (list) => list.map((x) => `${JSON.stringify(x)}\n`).join('');
  // 一個對話:叫了 D、你按了結案。days = 結案是幾天前
  const convo = (days) => [
    { ts: D(days + 1), hook: 'UserPromptSubmit', session: 's1', cwd: root, prompt: '修一下', title: '修首頁' },
    { ts: D(days + 1), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:chaos-check`, session: 's1', cwd: root },
    { ts: D(days), event: 'session_closed', session: 's1', cwd: root, source: 'human' },
  ];
  if (records === 'expired') writeFileSync(log, lines(convo(RETAIN_DAYS + 1)));
  if (records === 'fresh') writeFileSync(log, lines(convo(0.05)));
  if (records === 'empty') writeFileSync(log, '');   // hook.sh 先開檔才寫:jq 出錯就留下這種空檔
  if (stamp) {
    const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');   // 照真的分支名寫,不寫死 main(P8)
    writeFileSync(join(monitorDir, 'checkpoints', `${name}__${safeName(branch)}.json`),
      JSON.stringify({ commit: git('rev-parse', 'HEAD'), branch, worktree: root, at: D(RETAIN_DAYS + 2), checks: ['test'] }));
  }
  const append = (list) => appendFileSync(log, lines(list));
  const faults = (list) => writeFileSync(join(logDir, '_sensor.jsonl'), lines(list));
  const cli = () => {
    const { CLAUDE_CODE_SESSION_ID: _drop, ...env } = process.env;
    return execFileSync('node', [join(ROOT, 'status.mjs')], { cwd: root, encoding: 'utf8',
      env: { ...env, HOME: home, PIPELINE_MONITOR_HOME: monitorDir, PIPELINE_MONITOR_LOG_DIR: logDir } });
  };
  // 儀表板的資料。HOME 換成假的:感測器掛在哪看 ~/.claude,不能讓這台電腦裝的 plugin 影響結果(P8)
  const all = () => {
    const keep = { PIPELINE_MONITOR_LOG_DIR: process.env.PIPELINE_MONITOR_LOG_DIR, HOME: process.env.HOME };
    Object.assign(process.env, { PIPELINE_MONITOR_LOG_DIR: logDir, HOME: home });
    try { return collectAll({ monitorDir, skillHome: home, appTitles: new Map(), transcriptsDir: transcripts }); } finally {
      for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  const project = (a) => a.projects.find((x) => x.name === name) ?? null;
  const cleanup = () => { for (const d of [monitorDir, home, transcripts]) rmSync(d, { recursive: true, force: true }); r.cleanup(); };
  return { root, name, logDir, log, append, faults, cli, all, project, cleanup };
}

/** 真的跑整支 ui/app.js:只拿掉最上面的 import 與最下面的輪詢,DOM、計時器、網路換成假的;latest 換成給的資料 */
function uiOf(latest) {
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const body = src.replace(/^import .*$/m, '').replace(/^pollLoop\(\);$/m, '').replace(/^setInterval\(paintFreshness, 1000\);$/m, '');
  const noop = () => {};
  const el = () => ({ dataset: {}, classList: { toggle: noop }, innerHTML: '', textContent: '' });
  const document = { getElementById: el, addEventListener: noop, body: el(), activeElement: null };
  const make = new Function('describeFreshness', 'STALE_AFTER_SECONDS', 'document', 'window', 'localStorage', 'location', 'setTimeout', 'setInterval', 'fetch', '__LATEST',
    `${body}\nlatest = __LATEST;\nreturn { projectPage, sensorLine, workflow };`);
  return make(() => ({ label: '', state: 'fresh', dim: false }), 60, document, { addEventListener: noop }, { getItem: () => null, setItem: noop },
    { hash: '' }, noop, noop, () => Promise.reject(new Error('測試不連網路')), latest);
}

section('停了三個月的專案:清的那一次、清完之後——終端機講「90 天內沒有」,不講感測器可能沒在運作;儀表板不叫你去掛感測器、不說還沒有結案的對話', 'P5');
{
  const s = scene();
  const line = noRecordLine({ here: TERM });
  eq('讀之前:紀錄檔裡還有那 3 筆(都過期了)', readFileSync(s.log, 'utf8').split('\n').filter(Boolean).length, 3);
  // 清的那一次:讀的人順手清——這一次讀到的是「全部過期、還沒清」(ok 但 0 筆)
  const first = s.cli();
  eq('這一次讀就清了(紀錄檔是空的):讀到的確實是「全部過期、還沒清」', readFileSync(s.log, 'utf8'), '');
  check('清的那一次:五關印那一句', first.includes(line), first);
  check('清的那一次:不說「沒有一筆來自這個 worktree」', !first.includes('沒有一筆來自這個 worktree'), first);
  check(`清的那一次:感測器那一行說「${RETAIN_DAYS} 天內沒有」,不說「還沒有」(像剛裝好、從沒記過)`,
    first.includes(`${RETAIN_DAYS} 天內沒有來自這裡的紀錄`) && !first.includes('還沒有來自這裡的紀錄'), first);
  check('接著照舊講「所以不會說「五關都沒跑」」', first.includes('所以不會說「五關都沒跑」'), first);
  // 清完之後:紀錄檔在、裡面一行都沒有
  eq('清完之後讀:紀錄檔在、裡面沒有東西(no-events)', readEvents(s.logDir, basename(s.root)).state, 'no-events');
  const second = s.cli();
  check('清完之後:五關照樣印那一句', second.includes(line), second);
  check('清完之後:不說「感測器可能沒在運作」「裡面沒有東西」', !second.includes('感測器可能沒在運作') && !second.includes('裡面沒有東西'), second);
  check(`清完之後:感測器那一行照樣「${RETAIN_DAYS} 天內沒有」`, second.includes(`${RETAIN_DAYS} 天內沒有來自這裡的紀錄`) && !second.includes('還沒有來自這裡的紀錄'), second);

  const a = s.all(), p = s.project(a);
  check('儀表板:專案還列得出來(紀錄檔在、有章)', !!p);
  eq('儀表板:一個對話都不剩', p?.sessions?.length, 0);
  eq('儀表板:對話那一區那一句,跟終端機同一個函式出的', p?.emptyLine, noRecordLine({ here: WEB }));
  eq('儀表板:90 天內一筆都沒有(跟終端機同一個判斷)', p?.noRecords, true);
  const html = uiOf(a).projectPage(s.name);
  check('畫面:對話那一區印那一句', html.includes(noRecordLine({ here: WEB })), text(html));
  check('畫面:不叫你去掛感測器(它一直掛著)、不說「還沒有任何對話紀錄」', !html.includes('掛上感測器') && !html.includes('還沒有任何對話紀錄'), text(html));
  check(`畫面:已結案那欄「${RETAIN_DAYS} 天內沒有結案的對話」,不寫「還沒有結案的對話」(結過,那幾頁清掉了)`,
    html.includes(`${RETAIN_DAYS} 天內沒有結案的對話`) && !html.includes('還沒有結案的對話'), text(html));
  check('畫面:有章 → 中間那格照常講這個資料夾的還原點(不寫「也沒有還原點」)', html.includes('還原點') && !html.includes('也沒有還原點'), text(html));
  s.cleanup();
}

section('終端機與儀表板同一句:同一份紀錄,兩邊都真的跑——那一句、感測器那一行的開頭一字不差', 'P2');
{
  const s = scene();
  s.cli();   // 誰先讀誰清:這裡讓終端機先清
  const out = s.cli(), a = s.all(), p = s.project(a);
  const printed = out.split('\n').find((l) => l.includes('天內沒有任何對話紀錄'))?.replace(/^\s*🔍\s*/, '') ?? null;
  eq('那一句:終端機印的跟儀表板給的一字不差', printed, p?.emptyLine);
  const card = p?.cards?.find((c) => c.path === s.root);
  const sensorPrinted = out.split('\n').find((l) => l.includes('天內沒有來自這裡的紀錄'))?.trim() ?? '';
  eq('感測器那一行:儀表板給的是 noneHereLine 出的', card?.sensor?.noneLine, noneHereLine({ hasLog: true, days: RETAIN_DAYS }));
  check('感測器那一行:終端機印的開頭就是儀表板給的那一句', !!card?.sensor?.noneLine && sensorPrinted.startsWith(card.sensor.noneLine), `${sensorPrinted}\n${card?.sensor?.noneLine}`);
  s.cleanup();
}

section('紀錄的資料夾不能寫、清不掉:每一次讀都是「全部過期、還沒清」——照樣同一句,不說「沒有一筆來自這個 worktree」', 'P5');
{
  const s = scene();
  chmodSync(s.logDir, 0o555);
  let writable = false;
  try { writeFileSync(join(s.logDir, '.probe'), ''); writable = true; unlinkSync(join(s.logDir, '.probe')); } catch { /* 寫不進去:照規矩擋住了 */ }
  for (const what of ['第一次', '第二次']) {
    const out = s.cli();
    check(`清不掉,${what}讀:五關印那一句,不說「沒有一筆來自這個 worktree」`, out.includes(noRecordLine({ here: TERM })) && !out.includes('沒有一筆來自這個 worktree'), out);
  }
  if (writable) console.log('  · 這台電腦擋不住寫入（用 root 在跑），「真的沒清掉」這一條略過——那一句照樣驗過了');
  else eq('真的沒清掉(那 3 筆還在):讀到的一直是「全部過期、還沒清」', readFileSync(s.log, 'utf8').split('\n').filter(Boolean).length, 3);
  const p = s.project(s.all());
  eq('儀表板:照樣同一句', p?.emptyLine, noRecordLine({ here: WEB }));
  eq('儀表板:照樣算 90 天內一筆都沒有', p?.noRecords, true);
  chmodSync(s.logDir, 0o755);
  s.cleanup();
}

section('空的紀錄檔看不出是清空的、還是從來沒寫進去:兩種都講,不准講死「是過期清掉的,沒事」;感測器壞著、時好時壞照講', 'P3');
{
  const s = scene({ records: 'empty', stamp: false });
  const line = noRecordLine({ here: TERM });
  const out = s.cli();
  check('從來沒寫進東西的空檔:照樣印那一句(分不出來就兩種都講)', out.includes(line), out);
  check('那一句不准講死清掉了:後半句「有開過的話，是感測器沒記到」一定在', /有開過的話，是感測器沒記到/.test(line) && !/清掉了|過期了/.test(line), line);
  check('也不只講感測器那一種:不說「感測器可能沒在運作」', !out.includes('感測器可能沒在運作'), out);
  // 感測器現在壞著:最上面紅的那一行講了,那一句後面也要接著講
  s.faults([{ ts: H(1), event: 'sensor_broken', why: 'jq 不存在' }]);
  const broken = s.cli();
  check('感測器壞著:最上面講記不到東西,那一句後面加「這台電腦的感測器現在記不到東西（見最上面那一行）」',
    broken.includes('這台電腦的感測器記不到東西') && broken.includes(noRecordLine({ now: 'broken', here: TERM }))
      && noRecordLine({ now: 'broken', here: TERM }).endsWith('這台電腦的感測器現在記不到東西（見最上面那一行）。'), broken);
  eq('儀表板:同一句,見最上面那一條', s.project(s.all())?.emptyLine, noRecordLine({ now: 'broken', here: WEB }));
  const flaky = noRecordLine({ now: 'flaky', here: TERM });
  check('時好時壞:那一句後面講「也可能是這個原因」', flaky.endsWith('這台電腦的感測器時好時壞（見最上面那一行），也可能是這個原因。'), flaky);
  s.cleanup();
}

section('魔鬼教官第一輪:感測器掛壞了(資料夾搬走、捷徑指空)又過了 90 天——手上有「壞了」的證據,那一句不准講「沒開過對話就沒事」;終端機與儀表板同一句', 'P3');
{
  const s = scene({ plugin: 'dangling' });
  s.cli();   // 清掉
  const out = s.cli();
  const fix = mountFix({ state: 'broken', where: 'plugin', paths: [], dangling: true });
  check('終端機:感測器那一行是紅的(掛著,但它指向的檔案不存在)', out.includes('掛著,但它指向的檔案不存在'), out);
  const line = noRecordLine({ here: TERM, mount: 'broken', fix });
  check('五關:那一句講紀錄已經停了、附修法(跟感測器那一行同一句),不講「沒事」',
    out.includes(line) && line.includes('紀錄已經停了') && line.includes(fix) && !line.includes('沒事'), out);
  const a = s.all(), p = s.project(a);
  eq('儀表板:對話那一區同一句(卡上的感測器是掛壞了)', p?.emptyLine, noRecordLine({ here: WEB, mount: 'broken', fix }));
  const html = uiOf(a).projectPage(s.name);
  check('畫面:對話頁都清掉了、紅色那一行看不到——那一句照樣講感測器壞了、怎麼修', html.includes('紀錄已經停了') && html.includes('node status.mjs --install'), text(html));
  s.cleanup();
}

section('魔鬼教官第二輪:感測器根本沒掛上(plugin 拆掉了)又過了 90 天——同一件事的另一條路,一樣不准講「沒開過對話就沒事」', 'P6');
{
  const s = scene({ plugin: 'none' });
  s.cli();   // 清掉
  const out = s.cli();
  check('終端機:感測器那一行說沒掛上', out.includes('感測器：沒掛上'), out);
  const line = noRecordLine({ here: TERM, mount: 'off' });
  check('五關:那一句講沒掛上、記不到、怎麼掛,不講「沒事」', out.includes(line) && line.includes('感測器沒掛上') && line.includes('pipeline-status --on') && !line.includes('沒事'), out);
  const a = s.all(), p = s.project(a);
  eq('儀表板:對話那一區同一句(卡上的感測器是沒掛上)', p?.emptyLine, noRecordLine({ here: WEB, mount: 'off' }));
  check('畫面:那一句照印', uiOf(a).projectPage(s.name).includes(noRecordLine({ here: WEB, mount: 'off' })));
  // 你自己退出的(沒掛上是因為退出):照退出那一句講,不叫你去掛
  optOut(s.root, 'test');
  const opted = s.cli();
  check('退出記錄的:照退出那一句講,不叫你跑 --on', opted.includes(noRecordLine({ here: TERM, optedOut: true })) && !opted.includes('感測器沒掛上，在這裡開的對話都記不到'), opted);
  s.cleanup();
}

section('你退出記錄的專案:不叫你去問 Claude(之後的對話本來就不記);不准一直說「之前的紀錄還在」——舊的照樣滿 90 天清掉');
{
  const s = scene();
  optOut(s.root, 'test');   // 跟 --off、儀表板的按鈕同一個做法
  const line = noRecordLine({ here: TERM, optedOut: true });
  const out = s.cli();
  check('五關:講「你退出了記錄，之後的對話本來就不記」,不叫你把這句給 Claude 看',
    out.includes(line) && line.includes('你退出了記錄，之後的對話本來就不記') && !line.includes('把這句給 Claude 看'), out);
  check(`感測器那一行:不說「之前的紀錄還在」,說「之前記的照樣留到滿 ${RETAIN_DAYS} 天」`,
    !out.includes('之前的紀錄還在') && out.includes(`之前記的照樣留到滿 ${RETAIN_DAYS} 天`), out);
  const a = s.all(), p = s.project(a);
  eq('儀表板:對話那一區同一句', p?.emptyLine, noRecordLine({ here: WEB, optedOut: true }));
  check('儀表板:退出記錄那一條是伺服器照同一個函式給的', /已退出記錄/.test(p?.optedOutLine ?? '') && !!p?.optedOutLine?.includes(`之前記的照樣留到滿 ${RETAIN_DAYS} 天`), p?.optedOutLine);
  const html = uiOf(a).projectPage(s.name);
  check('畫面:退出記錄那一條照印,不寫「之前的紀錄還在」,按鈕還在',
    html.includes(`之前記的照樣留到滿 ${RETAIN_DAYS} 天`) && !html.includes('之前的紀錄還在') && html.includes('重新加入記錄'), text(html));
  s.cleanup();
}

section('只有一個資料夾過期(同一個專案別的資料夾昨天還在用):「沒有一筆來自這個 worktree」要講是 90 天內', 'P5');
{
  const s = scene();
  s.append([{ ts: H(20), hook: 'UserPromptSubmit', session: 's2', cwd: `${s.root}-wt`, prompt: '別的事' }]);
  const out = s.cli();
  check(`五關:「有紀錄,但 ${RETAIN_DAYS} 天內沒有一筆來自這個 worktree」`, out.includes(`有紀錄,但 ${RETAIN_DAYS} 天內沒有一筆來自這個 worktree`), out);
  check('專案別的資料夾還有紀錄:不印「這個專案 90 天內沒有任何對話紀錄」', !out.includes('天內沒有任何對話紀錄'), out);
  check(`感測器那一行:「${RETAIN_DAYS} 天內沒有來自這裡的紀錄」,不說「還沒有」`, out.includes(`${RETAIN_DAYS} 天內沒有來自這裡的紀錄`) && !out.includes('還沒有來自這裡的紀錄'), out);
  s.cleanup();
}

section('沒有還原點的專案清空之後,連資料夾在哪都不知道:中間那格不說「還沒有資料」', 'P5');
{
  const s = scene({ stamp: false });
  s.cli();   // 清掉
  const a = s.all(), p = s.project(a);
  eq('儀表板:一張卡都沒有(90 天內沒有紀錄、也沒有章)', p?.cards?.length, 0);
  const html = uiOf(a).projectPage(s.name);
  check(`中間那格:「${RETAIN_DAYS} 天內沒有紀錄，也沒有還原點」,不寫「還沒有資料」`,
    html.includes(`${RETAIN_DAYS} 天內沒有紀錄，也沒有還原點`) && !html.includes('還沒有資料'), text(html));
  check('對話那一區照樣印那一句', html.includes(noRecordLine({ here: WEB })), text(html));
  s.cleanup();
}

section('對照組:從來沒有紀錄檔(只有章)的照舊講「還沒有」、叫你掛感測器;90 天內有紀錄的一個字都不多');
{
  const none = scene({ records: 'none' });
  const out = none.cli();
  check('沒有紀錄檔:五關照舊「這個專案還沒有任何感測器紀錄」,不印那一句', out.includes('這個專案還沒有任何感測器紀錄') && !out.includes('天內沒有任何對話紀錄'), out);
  check('沒有紀錄檔:感測器那一行照舊「還沒有來自這裡的紀錄」', out.includes('還沒有來自這裡的紀錄'), out);
  const a = none.all(), p = none.project(a);
  check('儀表板:沒有紀錄檔 → 那一欄給 null(不是沒給)、不算「90 天內一筆都沒有」', !!p && 'emptyLine' in p && p.emptyLine === null && p.noRecords === false, JSON.stringify({ e: p?.emptyLine, n: p?.noRecords }));
  const html = uiOf(a).projectPage(none.name);
  check('畫面:照舊叫你掛感測器(真的從來沒記過)', html.includes('還沒有任何對話紀錄') && html.includes('pipeline-status --on'), text(html));
  none.cleanup();

  const fresh = scene({ records: 'fresh' });
  const o2 = fresh.cli();
  check('90 天內有紀錄:終端機一個字都不多(不印那一句、不印「N 天內沒有來自這裡」)',
    !o2.includes('天內沒有任何對話紀錄') && !o2.includes('天內沒有來自這裡的紀錄') && o2.includes('最後一筆來自這裡的紀錄'), o2);
  const a2 = fresh.all(), p2 = fresh.project(a2);
  check('儀表板:有對話 → 那一欄 null、不算 90 天內一筆都沒有', p2?.emptyLine === null && p2?.noRecords === false && p2?.sessions?.length === 1,
    JSON.stringify({ e: p2?.emptyLine, n: p2?.noRecords, s: p2?.sessions?.length }));
  const h2 = uiOf(a2).projectPage(fresh.name);
  check('畫面:結過的對話照常列在已結案,不寫「沒有結案的對話」', h2.includes('修首頁') && !h2.includes('沒有結案的對話'), text(h2));
  fresh.cleanup();
}

section('舊的服務(合併之後還沒 --serve-restart)少了新欄位:畫面不准壞,也不准自己湊一句——講服務還在跑舊的程式(L20)');
{
  const page = (p) => { try { return uiOf({ projects: [p], retainDays: RETAIN_DAYS }).projectPage(p.name); } catch (e) { return `畫面壞了：${e.message}`; } };
  const old = { name: 'x', displayName: 'x', mainRoot: '/x', optedOut: null, sensorState: 'no-events', cards: [], sessions: [], suggestions: [] };
  const h = page(old);
  check('對話那一區:講服務還在跑舊的程式、叫你重啟,不叫你去掛感測器', /還在跑舊的程式/.test(h) && /--serve-restart/.test(h) && !h.includes('掛上感測器') && !/畫面壞了/.test(h), text(h));
  const ho = page({ ...old, optedOut: { at: H(5) } });
  check('退出記錄那一條:舊的服務沒給那一句 → 講服務還在跑舊的程式,不寫「之前的紀錄還在」',
    /還在跑舊的程式/.test(ho) && !ho.includes('之前的紀錄還在') && ho.includes('重新加入記錄'), text(ho));
  const sl = uiOf({ projects: [], retainDays: RETAIN_DAYS }).sensorLine({ sensor: { mount: { state: 'ok', where: 'plugin', paths: [] }, lastSeen: null } });
  check('感測器那一行:舊的服務沒給那一句 → 不猜是還沒記過還是清掉了,講服務還在跑舊的程式', /還在跑舊的程式/.test(sl) && !sl.includes('還沒有來自這裡的紀錄'), sl);
}

section('「感測器沒有資料」那一格(實測走不到:清空之後一個對話都不剩)——照樣不准說謊;那幾句不准把 undefined 印到畫面上');
{
  // 那一句住 lib/stageLines.mjs(規格:終端機與網頁說同一句):伺服器把感測器那一句當成「沒有紀錄」時要講的,算好放進那一格;網頁照印
  const none = noneHereLine({ hasLog: true, days: RETAIN_DAYS });
  const st = { id: 'C', name: '打掃', skill: 'cleanup', state: 'none' };
  const line = stageLine(st, { noRecord: none });
  const ui = uiOf({ projects: [], retainDays: RETAIN_DAYS, sharedLines: 1 });
  const cell = ui.workflow({ path: '/x', stages: [{ ...st, line }], sensor: { state: 'no-events', noneLine: none } });
  check('紀錄檔讀不到東西的那一格:不寫「感測器沒有資料」,寫伺服器給的那一句', line === none && !cell.includes('感測器沒有資料') && cell.includes(`${RETAIN_DAYS} 天內沒有來自這裡的紀錄`), text(cell));
  check('noneHereLine 沒給天數:講「保留期限內」,不印 undefined', !/undefined|NaN/.test(noneHereLine({ hasLog: true })), noneHereLine({ hasLog: true }));
  check('optedOutLine 沒給天數、沒有時間:不印 undefined', !/undefined|NaN|null/.test(optedOutLine({ at: null })), optedOutLine({ at: null }));
}

process.exit(summary());
