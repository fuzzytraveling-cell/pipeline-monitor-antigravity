/**
 * faults.test.mjs —— 感測器或收工 hook 壞了,畫面講對(規格:agent回報與故障記號,路徑看 CLAUDE.md 的表)
 *
 * 釘的是會安靜說謊的地方:
 *   ① 記號寫了、讀的那一端沒讀:新專案沒有紀錄檔就不讀記號,叫你開新的對話——照做永遠等不到;儀表板從來不講(AC-3,老毛病 P3)
 *   ② 把「還在壞」講成「好了」:拿 --report、按鈕、收工 hook 寫的紀錄當成感測器恢復了;從「最近一次故障」起算,壞三天講成剛壞(AC-5)
 *   ③ 講錯是誰壞了、把程式的錯誤原文印到畫面上(AC-4)
 *   ④ 終端機跟儀表板各講各的(P2);舊的服務不給那一欄,畫面當成沒有故障(L20)
 *   ⑤ 外掛的捷徑壞了:照畫面的修法做,什麼都沒變;--on 回「本來就在記錄中」(AC-6)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, readFileSync, symlinkSync, readlinkSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { faultState, faultsNow, faultBanner, faultNotes, sensorNow, unreadableLine, hookTimesIn, roundStartFor, sensorOffLine, sensorParts, guardHeartbeat, guardLine, escalateHeartbeat, escalateLine, recordHeartbeat } from '../lib/faults.mjs';
import { readEvents, safeName, RETAIN_DAYS } from '../lib/events.mjs';
import { collectAll } from '../lib/collect.mjs';
import { real } from '../lib/git.mjs';
import { installPlugin, mountState, mountFix, mount, hookPathsIn } from '../lib/mount.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).name;
// 「現在」只取一次(L18)。時間都放在幾小時前:ago() 照小時四捨五入,終端機與伺服器各算一次也不會剛好跨過邊界
const NOW = Date.now();
const H = (h) => new Date(NOW - h * 3600_000).toISOString();
const ms = (h) => NOW - h * 3600_000;
const jq = (h) => ({ ts: H(h), event: 'sensor_broken', why: 'jq 不存在' });
const state = (faults, times = [], heartbeat = null) => faultState({ faults, sensorTimes: () => times.map(ms), heartbeat, now: NOW, retainDays: RETAIN_DAYS });
const texts = (fs) => faultBanner(fs).map((b) => b.text).join('\n');

section('AC-5:還在壞、時好時壞、已經好了分開講;還在壞從最後一筆正常紀錄算,不從最近一次故障算', 'P3');
{
  // jq 不在時每個動作都留一筆:最近一次永遠是剛剛。壞了 5 小時,要講 5 小時,不准講成剛壞
  const broken = state([jq(5), jq(3), jq(1)], [6]);
  eq('最後一筆故障之後一筆都沒記到 → 還在壞', broken.sensor?.state, 'broken');
  const b = faultBanner(broken);
  check('紅燈;從最後一筆正常紀錄(6 小時前)算起,不寫最近一次故障(1 小時前)',
    b[0]?.tone === 'red' && /最後一筆正常紀錄是 6 小時前，之後就沒記到/.test(b[0]?.text) && !/1 小時前/.test(b[0]?.text), b[0]?.text);
  check('講是找不到 jq、給修法(裝了還出現就是 Claude Code 找不到它)', /找不到 jq/.test(b[0]?.text) && /裝 jq；已經裝了還出現/.test(b[0]?.text), b[0]?.text);
  const never = faultBanner(state([jq(5), jq(1)], []))[0]?.text ?? '';
  check('之前一筆正常紀錄都沒有(全新電腦)→ 從第一筆故障算', /從 5 小時前起就沒記到/.test(never), never);
  eq('還在壞 → sensorNow 是 broken(終端機那幾句「開新的對話」「分不出來」不再是真的)', sensorNow(broken), 'broken');
  // 壞過一段、好了、又壞:「從 Y 之後……回報 N 次」的 N 只數這一段(魔鬼教官第一輪,R3)
  const again = state([jq(50), jq(48), jq(5), jq(3), jq(1)], [60, 40, 6]);
  check('壞過一段又壞 → 次數只數這一段(3 次,不是 90 天內的 5 次)', again.sensor?.state === 'broken' && /回報 3 次/.test(texts(again)) && !/回報 5 次/.test(texts(again)), texts(again));

  const flaky = state([jq(10), jq(8)], [9, 7]);
  eq('故障出現過兩段,中間夾著有記到的,之後又記到了 → 時好時壞', flaky.sensor?.state, 'flaky');
  const f = faultBanner(flaky)[0];
  check('黃燈:有些對話記得到、有些記不到,講最近一次記不到是什麼時候', f?.tone === 'amber' && /有些對話記得到、有些記不到/.test(f.text) && /最近一次記不到是 8 小時前/.test(f.text), f?.text);
  eq('時好時壞 → sensorNow 是 flaky(不是「現在記不到」:最後一筆故障之後又記到了)', sensorNow(flaky), 'flaky');

  const ok = state([jq(10), jq(9)], [11, 8, 2]);
  eq('只有一段,之後都記到了 → 已經好了', ok.sensor?.state, 'recovered');
  eq('已經好了 → 不上橫條(不然 90 天每一頁都掛一條,真的紅燈也沒人看)', faultBanner(ok).length, 0);
  eq('已經好了 → sensorNow 是 null', sensorNow(ok), null);
  const note = faultNotes(ok, { since: H(12) });
  check('這一輪碰到那段期間 → 五關旁講「那段時間跑的關這裡看不到——還沒跑可能是沒記到」',
    note.length === 1 && /感測器在 10 小時前到 9 小時前之間記不到/.test(note[0]) && /「還沒跑」可能是沒記到/.test(note[0]), note.join('|'));
  eq('這一輪從那段期間之後才開始 → 不講', faultNotes(ok, { since: H(3) }).length, 0);
  eq('不知道這一輪從哪開始 → 講(寧可多講一句)', faultNotes(ok, { since: null }).length, 1);
  // 這一輪的起點是感測器第一筆記到的(不是 A、章、轉錄檔):在故障期間開始的對話,第一筆被記到的就在修好之後(魔鬼教官第一輪,R1)
  check('起點是修好之後的第一筆紀錄、不知道真的起點 → 可能在故障期間就開始了,講', faultNotes(ok, { since: H(8), startKnown: false }).length === 1);
  eq('起點之前感測器還記到過別的(修好之後) → 起點是真的晚於故障,不講', faultNotes(ok, { since: H(2), startKnown: false }).length, 0);
  eq('起點是真的(A、章)而且在故障之後 → 不講', faultNotes(ok, { since: H(8), startKnown: true }).length, 0);
  eq('對話在故障開始之前就結案了 → 不講(不叫你去懷疑一份完整的紀錄)', faultNotes(ok, { since: H(20), until: H(15) }).length, 0);

  eq('超過保留期限的故障不算(那段期間的紀錄畫面本來就不看)', state([jq(24 * (RETAIN_DAYS + 1))], []).sensor, null);
}

section('AC-5:「感測器記到了」只算感測器自己寫的——jq 不在時你按結案、Claude 記結論,紅燈不准滅', 'P3');
{
  const dir = mkdtempSync(join(tmpdir(), 'pm-fault-'));
  writeFileSync(join(dir, '_sensor.jsonl'), JSON.stringify(jq(3)) + '\n');
  const old = JSON.stringify({ ts: new Date(NOW - (RETAIN_DAYS + 30) * 86400_000).toISOString(), hook: 'UserPromptSubmit', session: 's0', cwd: '/p', prompt: '很久以前' });
  writeFileSync(join(dir, 'p.jsonl'), [
    old,
    JSON.stringify({ ts: H(4), hook: 'UserPromptSubmit', session: 's1', cwd: '/p', prompt: '修一下' }),
    JSON.stringify({ ts: H(2), event: 'stage_report', stage: 'D', verdict: 'ok', note: 'hook', source: 'claude' }),   // CLI 寫的:不需要 jq(說明剛好寫著 hook 也不算)
    JSON.stringify({ ts: H(1), event: 'session_closed', session: 's1', source: 'human' }),                               // 儀表板的按鈕寫的
  ].join('\n') + '\n');
  const before = readFileSync(join(dir, 'p.jsonl'), 'utf8');
  const fs = faultsNow(dir, { retainDays: RETAIN_DAYS, now: NOW });
  eq('故障之後只有結論與結案(不是感測器寫的)→ 還在壞', fs.sensor?.state, 'broken');
  check('從最後一筆感測器紀錄(4 小時前)算起', /最後一筆正常紀錄是 4 小時前/.test(texts(fs)), texts(fs));
  eq('看別的專案的紀錄不經 readEvents:不會順手清檔(過期的那一行還在)', readFileSync(join(dir, 'p.jsonl'), 'utf8'), before);
  eq('hookTimesIn 只數有 hook 欄位的', hookTimesIn(dir).length, 2);
  rmSync(dir, { recursive: true, force: true });
}

section('AC-4:講對是誰壞了、後果、修法;程式的錯誤原文不上畫面;看不懂的記號只數筆數', 'P3');
{
  const node = (h) => ({ ts: H(h), event: 'gate_broken', why: '找不到 node' });
  const err = (h, cwd) => ({ ts: H(h), event: 'gate_broken', why: "TypeError: Cannot read properties of undefined (reading 'x')", ...(cwd ? { cwd } : {}) });
  let fs = state([node(3)], [], { ts: H(5), cwd: '/a' });
  check('收工 hook 找不到 node、之後沒心跳 → 紅燈,後果是「沒檢查就放行」,修法是裝 node',
    /收工 hook 找不到 node/.test(texts(fs)) && /沒檢查就放行了/.test(texts(fs)) && /裝 node/.test(texts(fs)) && !/感測器/.test(texts(fs)), texts(fs));
  eq('只有收工 hook 的故障 → sensorNow 是 null(「開新的對話」那句照舊是真的)', sensorNow(fs), null);
  fs = state([node(50), node(3)], [], { ts: H(10), cwd: '/a' });
  check('收工 hook 找不到 node 壞過一段又壞 → 從最後一次心跳之後算、次數只數這一段', /從 3 小時前起回報 1 次/.test(texts(fs)), texts(fs));
  fs = state([node(3)], [], { ts: H(1), cwd: '/a' });
  eq('之後有心跳(要有 node 才跑得起來)→ 好了,不上橫條', faultBanner(fs).length, 0);
  const nn = faultNotes(fs, { since: H(4) })[0] ?? '';
  check('好了的那一句:講最近一次與次數,不講「X 到 Y 之間」(心跳只留最後一次,分不出各是哪一段)', /最近一次找不到 node 是 3 小時前/.test(nn) && !/之間/.test(nn), nn);

  fs = state([err(3, '/w/a')], [], { ts: H(3.001), cwd: '/w/a' });   // 出錯的那一次自己的心跳在故障之前
  const t = texts(fs);
  check('收工 hook 自己出錯、之後沒再跑 → 紅燈「可能沒檢查就放行」,叫你把這句給 AI 看', /收工 hook 自己出錯/.test(t) && /可能沒檢查就放行/.test(t) && /給 AI 看/.test(t), t);
  check('錯誤原文不上畫面(CLAUDE.md:不把內部值印給使用者看)', !/TypeError|Cannot read|undefined/.test(t), t);
  fs = state([err(3, '/w/a')], [], { ts: H(1), cwd: '/w/a' });
  eq('之後在同一個資料夾跑過 → 好了,不上橫條', faultBanner(fs).length, 0);
  check('好了 → 只在那個資料夾的頁面講', faultNotes(fs, { cwd: '/w/a' }).length === 1 && faultNotes(fs, { cwd: '/w/b' }).length === 0);
  fs = state([err(3, '/w/a')], [], { ts: H(1), cwd: '/w/b' });
  const u = faultBanner(fs)[0];
  check('之後只有別的資料夾跑過 → 黃燈「出錯的那個之後有沒有跑過看不到」,不講好了',
    u?.tone === 'amber' && /a 之後有沒有跑過看不到/.test(u.text) && !/好了|恢復/.test(u.text), u?.text);
  const legacy = faultBanner(state([err(3)], [], { ts: H(1), cwd: '/w/b' }))[0];
  check('舊的記號沒記資料夾 → 講看不出是不是同一個資料夾', /看不出是不是同一個資料夾/.test(legacy?.text ?? ''), legacy?.text);

  fs = state([{ ts: null, why: '看不懂的一行' }, { ts: 'x', event: 'sensor_broken' }, { ts: H(1), event: '沒見過的種類' }], [1]);
  eq('時間或種類看不懂 → 只數筆數', fs.unreadable, 3);
  eq('看不懂的不亮燈、不上橫條(不然是一盞修不掉的紅燈)', faultBanner(fs).length, 0);
  check('終端機附一句「另有 N 筆看不懂的故障記號」', /另有 3 筆看不懂的故障記號/.test(unreadableLine(fs) ?? ''), unreadableLine(fs));
}

/** 一個專案(或沒有任何紀錄的新專案)、假的監視器資料夾、裝了 plugin 的假 home。 */
function scene({ records = true } = {}) {
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: r.dir, encoding: 'utf8' }).trim();
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-fmon-'));
  const logDir = join(monitorDir, 'logs');
  mkdirSync(logDir); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-fhome-'));
  mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(ROOT, join(home, '.gemini', 'config', 'plugins', PLUGIN));
  const log = join(logDir, `${safeName(basename(root))}.jsonl`);
  /** 別的專案的感測器紀錄(只用來證明「那時候感測器記得到」) */
  const other = (times) => writeFileSync(join(logDir, 'other.jsonl'), times.map((ts) => JSON.stringify({ ts, hook: 'UserPrompt', session: 'o1', cwd: '/elsewhere', prompt: 'x' })).join('\n') + '\n');
  if (records) {
    writeFileSync(log, [
      JSON.stringify({ ts: H(12), hook: 'UserPrompt', session: 's1', cwd: root, prompt: '修一下' }),
      JSON.stringify({ ts: H(11), hook: 'PostToolUse', tool: 'read_file', skill: `${PLUGIN}:chaos-check`, session: 's1', cwd: root }),
    ].join('\n') + '\n');
  }
  const faults = (list) => writeFileSync(join(logDir, '_sensor.jsonl'), list.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const append = (o) => writeFileSync(log, `${readFileSync(log, 'utf8')}${JSON.stringify(o)}\n`);
  const cli = (args = []) => {
    const { ANTIGRAVITY_CONVERSATION_ID: _drop, ...env } = process.env;
    try { return { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: root, encoding: 'utf8', env: { ...env, HOME: home, AGY_PIPELINE_HOME: monitorDir, AGY_PIPELINE_LOG_DIR: logDir } }) }; }
    catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
  };
  const all = () => {
    const keep = process.env.AGY_PIPELINE_LOG_DIR;
    process.env.AGY_PIPELINE_LOG_DIR = logDir;
    try { return collectAll({ monitorDir, skillHome: home, home }); } finally {
      if (keep === undefined) delete process.env.AGY_PIPELINE_LOG_DIR; else process.env.AGY_PIPELINE_LOG_DIR = keep;
    }
  };
  const cleanup = () => { for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true }); r.cleanup(); };
  return { root, monitorDir, logDir, home, log, faults, append, other, cli, all, cleanup };
}

section('AC-3:jq 不在的新專案(一筆紀錄都沒有)——終端機講故障,不叫你開新的對話、不說分不出來;儀表板沒有任何卡也講', 'P3');
{
  const s = scene({ records: false });
  s.faults([jq(5), jq(1)]);
  eq('讀紀錄:專案沒有紀錄檔也讀得到故障記號', readEvents(s.logDir, basename(s.root)).broken.length, 2);
  const { out } = s.cli();
  check('最上面:這台電腦的感測器記不到東西、找不到 jq、修法', /這台電腦的感測器記不到東西/.test(out) && /找不到 jq/.test(out) && /裝 jq/.test(out), out);
  check('不再寫「要開新的對話才會開始記」(照做永遠等不到)', !/要開新的對話才會開始記/.test(out), out);
  check('感測器那一行:還沒有來自這裡的紀錄——感測器現在記不到東西,開新的對話也不會開始記', /開新的對話也不會開始記/.test(out), out);
  check('五關:不說「分不出來」,講是感測器記不到', !/這兩種我分不出來/.test(out) && /這台電腦的感測器現在記不到東西/.test(out), out);
  const a = s.all();
  eq('儀表板:一張專案卡都沒有', a.projects.length, 0);
  check('儀表板:照樣給故障那一欄(紅燈)', a.faults?.banner?.[0]?.tone === 'red', JSON.stringify(a.faults));
  // 收工 hook 的故障、或感測器已經好了 → 那幾句照舊是真的,照舊講
  s.faults([{ ts: H(3), event: 'gate_broken', why: '找不到 node' }]);
  const g = s.cli().out;
  check('只有收工 hook 的故障 → 照舊講「開新的對話才會開始記」「分不出來」,另外講收工 hook 壞了',
    /要開新的對話才會開始記/.test(g) && /這兩種我分不出來/.test(g) && /收工 hook 找不到 node/.test(g), g);
  s.cleanup();
}

section('終端機跟儀表板同一句:橫條、這一輪碰到的那段期間、沒見過的格式(真的跑 CLI 與 collectAll,同一份紀錄)', 'P2');
{
  // 用對話代號找,不靠排序(多了一個「別的專案」之後,第一個專案就不是它了)
  const s1Of = (a) => a.projects.flatMap((p) => p.sessions).find((x) => x.id === 's1');
  const cardOf = (a) => a.projects.find((p) => p.sessions.some((x) => x.id === 's1'))?.cards?.[0];
  const s = scene();
  // 早就好了:修好之後(15 小時前)別的專案就記到了,這個對話 12 小時前才開始 → 這一輪沒碰到,不講。
  // (要是修好之後第一筆就是這個對話的,分不出它是不是在故障期間就開始了,會講——見上面 AC-5 那段)
  s.other([H(15)]);
  s.faults([jq(30), jq(20)]);
  let a = s.all(), out = s.cli().out;
  eq('已經好了、這一輪之前的 → 儀表板不上橫條', a.faults.banner.length, 0);
  eq('已經好了、這一輪之前的 → 對話頁不講', s1Of(a).faultNotes.length, 0);
  check('已經好了、這一輪之前的 → 終端機也不講', !/記不到/.test(out), out);
  s.faults([jq(11.5)]);         // 這一輪裡壞過一次,之後(11 小時前)有記到
  a = s.all(); out = s.cli().out;
  const note = s1Of(a).faultNotes[0] ?? '';
  check('這一輪碰到那段期間 → 對話頁講', /感測器在 .*記不到/.test(note), note);
  check('終端機五關旁同一句', note && out.includes(note), out);
  s.faults([jq(10), jq(2)]);    // 最後一筆紀錄 11 小時前,之後一直壞
  // 之後 Claude 在這裡記了一筆結論(CLI 寫的,不需要 jq):不准被當成「感測器最後一筆來自這裡的紀錄」
  s.append({ ts: H(1), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到', source: 'claude', cwd: s.root, by_session: 's1' });
  a = s.all(); out = s.cli().out;
  const banner = a.faults.banner.map((b) => b.text);
  check('還在壞:儀表板有橫條', banner.length === 1, JSON.stringify(banner));
  check('終端機最上面一字不差', banner.every((t) => out.includes(t)), `${banner.join('\n')}\n---\n${out}`);
  eq('儀表板:感測器記不到 → sensor 是 broken(感測器那一行不准再講「它在記」)', a.faults.sensor, 'broken');
  check('對話頁的「最後一筆來自這裡的紀錄」只算感測器寫的(之後那筆結論不算)', cardOf(a).sensor.lastSeen === H(11), cardOf(a).sensor.lastSeen);
  check('終端機的感測器那一行同樣不算那筆結論(不寫「最後一筆來自這裡的紀錄：1 小時前」)', !/最後一筆來自這裡的紀錄：1 小時前/.test(out), out);
  s.cleanup();

  // 設定裡沒掛感測器(拿掉 plugin)、紀錄卻有,感測器現在又記不到:儀表板與終端機那一句是同一個函式算的,只差「見哪裡」
  // (老毛病 P2:以前兩邊各寫一份,結尾已經不一樣——C 打掃 2026-10-05 留的建議)
  const u = scene();
  rmSync(join(u.home, '.gemini', 'config', 'plugins', PLUGIN), { force: true });
  u.faults([jq(10), jq(2)]);
  // 「掛在哪」看家目錄的設定:儀表板這邊也要給假的家目錄,不然吃到跑測試那台電腦的(這台 Mac 裝了 plugin 就是「已掛上」,老毛病 P8)
  const keepHome = process.env.HOME;
  process.env.HOME = u.home;
  let ua;
  try { ua = u.all(); } finally { process.env.HOME = keepHome; }
  const uout = u.cli().out;
  const offLine = cardOf(ua)?.sensor?.offLine ?? '';
  check('設定裡沒掛、紀錄卻有 → 儀表板那一句是伺服器算好給的:那時候它在記、之後記不到(見最上面那一條)',
    /那時候它在記/.test(offLine) && /之後這台電腦的感測器記不到東西（見最上面那一條）/.test(offLine), offLine);
  check('終端機那一行跟它一字不差(只差「見上面那一行」)', !!offLine && uout.includes(offLine.replace('見最上面那一條', '見上面那一行')), `${offLine}\n---\n${uout}`);
  u.cleanup();
}

section('畫面:每一頁最上面畫伺服器給的那一句;舊的服務沒給那一欄 → 講出來,不當成沒有故障;對話頁的旁白照畫(真的跑 ui/app.js)', 'P2');
{
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const pick = (name, sig) => src.match(new RegExp(`^function ${name}\\(${sig}\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = () => '3 小時前';
  const code = pick('faultBanner', '');
  check('從 ui/app.js 拿得出 faultBanner(拿不出來這一段就什麼都沒測到)', !!code);
  const banner = (latest) => (code ? new Function('latest', 'esc', `const zhEn = (zh) => zh; const many = (n, one, more = one + 's') => n + ' ' + (n === 1 ? one : more);\n${code}; return faultBanner;`)(latest, esc)() : '');
  check('舊的服務(沒有 faults 這一欄)→ 講服務還在跑舊的程式、叫你重啟', /還在跑舊的程式/.test(banner({ projects: [] })) && /--serve-restart/.test(banner({ projects: [] })));
  eq('新的服務、沒有故障 → 什麼都不畫', banner({ projects: [], faults: { banner: [] } }), '');
  const red = banner({ projects: [], faults: { banner: [{ tone: 'red', text: '🔴 這台電腦的感測器記不到東西 <x>' }] } });
  check('有故障 → 照伺服器給的那一句畫(紅),跳脫特殊字元', /data-tone="red"/.test(red) && red.includes('記不到東西 &lt;x&gt;'), red);

  const sp = pick('sessionPage', 'name, sid');
  check('從 ui/app.js 拿得出 sessionPage', !!sp);
  const stub = (n) => () => `<${n}>`;
  const s1 = { id: 's1', title: 't', prompts: 1, lastTs: H(1), closedAt: null, stages: [], cwd: '/w', sharesCwd: false, movedOn: null,
               card: { path: '/w', branch: 'b', stages: [] }, unknownNote: '⚠️ 這個對話有 1 則不是你打的 <x>', faultNotes: ['⚠️ 感測器在 3 小時前記不到'] };
  const oldLine = src.match(/^const OLD_LINE = .*;$/m)?.[0] ?? '';   // 「叫了不等於通過」那一句是伺服器給的;舊的服務沒給時用這一句
  // directorOf:F 工地主任要的那一份(規格:還差什麼總表 AC-12),這裡只看對話頁上面那幾行,給一個替身
  const page = sp ? new Function('latest', 'esc', 'ago', 'workflow', 'statRestore', 'statLadder', 'statChanges', 'statTier', 'sensorLine', 'stagesNoteLine', 'directorOf', `const zhEn = (zh) => zh; const many = (n, one, more = one + 's') => n + ' ' + (n === 1 ? one : more);\n${oldLine}\n${sp}; return sessionPage;`)(
    { projects: [{ name: 'p', sessions: [s1] }] }, esc, ago, stub('workflow'), stub('r'), stub('l'), stub('c'), stub('t'), stub('sensor'), stub('stagesNote'), () => null) : null;
  const html = page?.('p', 's1') ?? '';
  check('對話頁畫「沒算成你說的話」那一句與「感測器記不到」那一句(跳脫過)', html.includes('1 則不是你打的 &lt;x&gt;') && html.includes('感測器在 3 小時前記不到'), html);

  const sl = pick('sensorLine', 'c');
  const markSrc = src.match(/^const mark = .*;$/m)?.[0] ?? null;
  check('從 ui/app.js 拿得出 sensorLine(與標粗體的小幫手)', !!sl && !!markSrc);
  const line = (c, latest = { faults: { banner: [], blind: false } }) => (sl && markSrc ? new Function('latest', 'esc', 'ago', `const zhEn = (zh) => zh; const many = (n, one, more = one + 's') => n + ' ' + (n === 1 ? one : more);\n${markSrc}\n${sl}; return sensorLine;`)(latest, esc, ago)(c) : '');
  // 伺服器做的事:已掛上、最後一筆、掛壞了、沒掛上那幾句照 lib/faults.mjs 的 sensorParts 算好放進 lines(終端機同一句;規格:終端機與網頁說同一句)
  const linesOf = (mount, lastSeen) => sensorParts({ mount, lastSeen, gate: null, ago, notMountedHow: '。在那個資料夾跑 agy-pipeline --on。' });
  const dangling = { state: 'broken', where: 'plugin', paths: ['/h/.gemini/config/plugins/agy-pipeline'], dangling: true };
  const out = line({ sensor: { mount: dangling, lastSeen: H(2), fix: mountFix(dangling), lines: linesOf(dangling, H(2)) } });
  check('捷徑壞了 → 畫伺服器給的修法(跟終端機同一句),不再叫你跑 --on', out.includes('node status.mjs --install') && !out.includes('--on'), out);
  check('捷徑壞了 → 紀錄已經停了(粗體)、最後一筆之後就沒有了', out.includes('<b>紀錄已經停了,而且不會有任何徵兆</b>') && out.includes('從那之後就沒有了'), out);
  const oldBroken = line({ sensor: { mount: dangling, lastSeen: H(2), fix: mountFix(dangling) } });
  check('舊的服務沒給那幾句:照講掛壞了、講服務還在跑舊的程式,不自己拼', /指向的檔案不存在/.test(oldBroken) && /還在跑舊的程式/.test(oldBroken) && !/從那之後/.test(oldBroken), oldBroken);
  // 設定裡沒掛上的那兩種:網頁照印伺服器算好的那一句(lib/faults.mjs 的 sensorOffLine,跟終端機同一個函式)——以前網頁自己拼一份,結尾跟終端機不一樣(P2)
  const offMount = { state: 'off', where: null, paths: [] };
  const offLineOf = (now, mount = offMount) => sensorOffLine({ mount, lastSeen: H(2), now, here: '最上面那一條', ago });
  const offSeen = line({ sensor: { mount: offMount, lastSeen: H(2), offLine: offLineOf('broken') } });
  check('感測器現在記不到 → 照印伺服器那一句:「它在記」只到最後那一筆為止', /那時候它在記/.test(offSeen) && /之後這台電腦的感測器記不到東西（見最上面那一條）/.test(offSeen), offSeen);
  const offFlaky = line({ sensor: { mount: offMount, lastSeen: H(2), offLine: offLineOf('flaky') } });
  check('時好時壞 → 照舊「它在記」,附一句時好時壞(不講「之後記不到」)', /它在記/.test(offFlaky) && /時好時壞/.test(offFlaky) && !/之後這台電腦的感測器記不到/.test(offFlaky), offFlaky);
  // 你退出記錄的專案:以前網頁照樣講「它在記」,終端機講「已退出」——現在同一句
  const opted = { state: 'off', where: null, paths: [], optedOut: { at: H(5) } };
  const optedLine = line({ sensor: { mount: opted, lastSeen: H(2), offLine: offLineOf(null, opted) } });
  check('退出記錄的專案 → 講已經退出,不講「它在記」', /已退出記錄/.test(optedLine) && !/它在記/.test(optedLine), optedLine);
  // 舊的服務沒給那一句 → 不自己拼(那就是第二份),講服務還在跑舊的程式、叫你重啟
  const oldSrv = line({ sensor: { mount: offMount, lastSeen: H(2) } });
  check('舊的服務沒給那一句 → 不自己拼「它在記」,叫你重啟服務', !/它在記/.test(oldSrv) && /還在跑舊的程式/.test(oldSrv) && /--serve-restart/.test(oldSrv), oldSrv);
  // 已掛上那一行:網頁照印伺服器給的那幾段(掛在哪、最後一筆、收工 hook)——給一句跟事實對不上的字,畫面就印那一句,證明它沒有自己再拼一次(規格:終端機與網頁說同一句 AC-6)
  const okMount = { state: 'ok', where: 'plugin', paths: [] };
  const okLines = { ...linesOf(okMount, H(2)), mounted: '〈伺服器給的掛在哪〉', gate: '〈伺服器給的收工 hook〉' };
  const okLine = line({ sensor: { mount: okMount, lastSeen: H(2), noneLine: null, lines: okLines } });
  check('已掛上:照印伺服器給的那幾段,不自己拼', okLine.includes('〈伺服器給的掛在哪〉') && okLine.includes('最後一筆來自這裡的紀錄：3 小時前') && okLine.includes('〈伺服器給的收工 hook〉'), okLine);
  const okReal = line({ sensor: { mount: okMount, lastSeen: H(2), noneLine: null, lines: linesOf(okMount, H(2)) } });
  check('已掛上:跟終端機同一句(plugin 那半句、「收工 hook：」)', okReal.includes('感測器：已掛上（plugin,每個專案都會記）') && okReal.includes('收工 hook：還沒跑過（裝好 plugin 之後要開新對話'), okReal);
  const none = line({ sensor: { mount: offMount, lastSeen: null, offLine: null, lines: linesOf(offMount, null) } });
  check('沒掛上、也沒有紀錄 → 沒掛上,叫你在那個資料夾跑 --on(終端機那一半給指令)', /感測器：沒掛上。在那個資料夾跑 <code>agy-pipeline --on<\/code>。/.test(none), none);
}

section('AC-6:外掛的捷徑壞了——照畫面那句修法做一次就修好;--on 不准回「本來就在記錄中」', 'P3');
{
  const home = mkdtempSync(join(tmpdir(), 'pm-fhome2-'));
  const plugins = join(home, '.gemini', 'config', 'plugins');
  mkdirSync(plugins, { recursive: true });
  const link = join(plugins, PLUGIN);
  symlinkSync(join(home, '搬走了'), link);   // 資料夾搬走了:捷徑還在,指向的地方不在
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const st = mountState(r.dir, null, home);
  check('捷徑壞了 → broken／plugin,標明是捷徑指空(不是裡面少了 hook.sh)', st.state === 'broken' && st.where === 'plugin' && st.dangling === true, JSON.stringify(st));
  check('修法:在現在的資料夾跑 node status.mjs --install(agy-pipeline 那個簡寫多半也指著舊位置)', /node status\.mjs --install/.test(mountFix(st) ?? ''), mountFix(st));

  // --on:拿掉退出記號也記不到 → 講感測器是壞的,附同一句修法,不准回「本來就在記錄中」
  const { ANTIGRAVITY_CONVERSATION_ID: _drop, ...env } = process.env;
  let on;
  try { on = { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), '--on'], { cwd: r.dir, encoding: 'utf8', env: { ...env, HOME: home } }) }; }
  catch (e) { on = { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
  check('--on:講感測器是壞的、附修法,不說「本來就在記錄中」,離開碼不是 0',
    /感測器是壞的/.test(on.out) && on.out.includes(mountFix(st)) && !/本來就在記錄中/.test(on.out) && on.code !== 0, on.out);

  // 照那句修法做一次:捷徑換到現在的位置,感測器那一行變成已掛上
  const inst = installPlugin(home, ROOT);
  check('--install:換掉指空的捷徑,講原本指向哪、現在指向哪', inst.ok && /換好了/.test(inst.out.join('\n')) && inst.out.join('\n').includes('搬走了'), inst.out.join('\n'));
  eq('捷徑現在指向這一份', readlinkSync(link), ROOT);
  eq('感測器那一行變成已掛上', mountState(r.dir, null, home).state, 'ok');

  // 指向別的、還在的資料夾:不是我們能判斷的,照舊不動
  const other = mkdtempSync(join(tmpdir(), 'pm-other-'));
  const home3 = mkdtempSync(join(tmpdir(), 'pm-fhome3-'));
  mkdirSync(join(home3, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(other, join(home3, '.gemini', 'config', 'plugins', PLUGIN));
  const keep = installPlugin(home3, ROOT);
  check('捷徑指向別的、還在的資料夾 → 不動它', !keep.ok && readlinkSync(join(home3, '.gemini', 'config', 'plugins', PLUGIN)) === other, keep.out.join('\n'));
  for (const d of [home, home3, other]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('魔鬼教官第一輪:時好時壞不是「現在記不到」;看不懂的記號終端機講一句;「感測器從 X 才開始記」只算感測器寫的', 'P3');
{
  const s = scene({ records: false });
  s.other([H(100), H(20), H(1)]);              // 別的專案:故障之間、之後都有記到
  s.faults([jq(240), jq(30)]);                 // 兩段故障,中間夾著有記到的 → 時好時壞
  writeFileSync(join(s.logDir, '_sensor.jsonl'), `${readFileSync(join(s.logDir, '_sensor.jsonl'), 'utf8')}{壞行\n`);
  const out = s.cli().out;
  check('最上面黃燈:時好時壞', /時好時壞/.test(out), out);
  check('不講「現在記不到」「開新的對話也不會開始記」(最後一筆故障之後明明又記到了)', !/現在記不到東西/.test(out) && !/開新的對話也不會開始記/.test(out), out);
  check('「分不出來」照舊,附一句時好時壞也可能是原因', /這兩種我分不出來/.test(out) && /也可能是這個原因/.test(out), out);
  check('終端機:另有 1 筆看不懂的故障記號', /另有 1 筆看不懂的故障記號/.test(out), out);
  s.cleanup();

  // Claude 在感測器記到任何一筆之前就記了一筆結論(--report 不需要 jq):「感測器從 X 才開始記」不准從那一筆算
  const t = scene();
  t.append({ ts: H(20), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到', source: 'claude', cwd: t.root });
  const o2 = t.cli().out;
  check('「感測器從 12 小時前才開始記」(第一筆感測器紀錄),不是 20 小時前(那筆結論)', /感測器從 12 小時前才開始記/.test(o2) && !/感測器從 20 小時前才開始記/.test(o2), o2);
  t.cleanup();
}

section('魔鬼教官第一輪:收工 hook 自己出錯那條路(專案設定寫壞)——記下資料夾;畫面講可能沒檢查就放行,不印錯誤原文', 'P6');
{
  const s = scene();
  // 收工 hook 判斷到一半丟例外——任何錯誤一律放行,記一筆故障。
  // 以前拿「專案自己的關卡設定寫壞(一關是 null)」觸發;那條路修好了(退回內建的五關、講出來,不再丟例外,修小洞 2026-10-06),
  // 改成監視器自己的關卡清單壞掉——那是程式內部的錯,正是這條路要接住的
  const builtin = readFileSync(join(s.monitorDir, 'stages.json'), 'utf8');
  writeFileSync(join(s.monitorDir, 'stages.json'), JSON.stringify({ ...JSON.parse(builtin), stages: [null] }));
  mkdirSync(join(s.root, '.claude'), { recursive: true });
  writeFileSync(join(s.root, '.claude', 'pipeline-stages.json'), JSON.stringify({ tiers: { code: ['a.js'], danger: [] } }));
  const { ANTIGRAVITY_CONVERSATION_ID: _drop, ...base } = process.env;
  // 收工 hook 從「程式的主資料夾」讀內建的關卡清單:指到這個假的資料夾,它才讀得到上面寫壞的那一份。
  const env = { ...base, HOME: s.home, AGY_PIPELINE_HOME: s.monitorDir, AGY_PIPELINE_LOG_DIR: s.logDir, AGY_PIPELINE_CODE_HOME: s.monitorDir };
  const said = execFileSync('sh', [join(ROOT, 'gate.sh')], { input: JSON.stringify({ conversationId: 's1', cwd: s.root, executionNum: 0, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }), env, encoding: 'utf8' });
  eq('出錯 → 輸出 {}（放行）', said.trim(), '{}');
  const last = readFileSync(join(s.logDir, '_sensor.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  check('記下一筆 gate_broken,帶著那次的資料夾', last?.event === 'gate_broken' && last?.cwd === s.root, JSON.stringify(last));
  // 改回來再看畫面
  writeFileSync(join(s.monitorDir, 'stages.json'), builtin);
  rmSync(join(s.root, '.claude', 'pipeline-stages.json'));
  const out = s.cli().out;
  check('最上面紅燈:收工 hook 自己出錯、可能沒檢查就放行、叫你給 AI 看', /收工 hook 自己出錯/.test(out) && /可能沒檢查就放行/.test(out) && /給 AI 看/.test(out), out);
  check('錯誤原文不上畫面', !/TypeError|Cannot read|null \(reading/.test(out), out);
  s.cleanup();
}

section('魔鬼教官第一輪:捷徑指向一個還在、但不是 agy-pipeline 的資料夾——不叫你跑 --install(它不會動);--on 不拆舊接法', 'P2');
{
  const home = mkdtempSync(join(tmpdir(), 'pm-fhome4-'));
  const other = mkdtempSync(join(tmpdir(), 'pm-notpm-'));
  mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(other, join(home, '.gemini', 'config', 'plugins', PLUGIN));
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const st = mountState(r.dir, null, home);
  check('壞了,但不是指空 → broken、dangling 不成立', st.state === 'broken' && st.dangling === false, JSON.stringify(st));
  check('修法不叫你跑 --install(它不會動這條捷徑),叫你給 AI 看', !/跑 node status\.mjs --install/.test(mountFix(st)) && /給 AI 看/.test(mountFix(st)), mountFix(st));
  eq('--install 果然不動它', installPlugin(home, ROOT).ok, false);

  // 捷徑指空、專案設定檔裡還有舊接法(它可能是唯一還在記的那一條):--on 不准先拆掉它
  const home2 = mkdtempSync(join(tmpdir(), 'pm-fhome5-'));
  mkdirSync(join(home2, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(join(home2, '搬走了'), join(home2, '.gemini', 'config', 'plugins', PLUGIN));
  mount(r.dir);
  const before = hookPathsIn(r.dir).length;
  const { ANTIGRAVITY_CONVERSATION_ID: _drop, ...env } = process.env;
  let on;
  try { on = { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), '--on'], { cwd: r.dir, encoding: 'utf8', env: { ...env, HOME: home2 } }) }; }
  catch (e) { on = { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
  check('--on:講感測器是壞的,而且說舊接法沒拆', /感測器是壞的/.test(on.out) && /舊接法沒拆/.test(on.out), on.out);
  check('舊接法真的還在', before > 0 && hookPathsIn(r.dir).length === before, `${before} → ${hookPathsIn(r.dir).length}`);
  for (const d of [home, home2, other]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('魔鬼教官第一輪:三種頁面最上面都接了故障橫條(真的跑 ui/app.js 的 render)', 'P3');
{
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const pick = (name) => src.match(new RegExp(`^function ${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const code = [pick('route'), pick('render')];
  check('從 ui/app.js 拿得出 route、render', code.every(Boolean));
  const $app = { innerHTML: '' }, $crumb = { innerHTML: '' }, location = { hash: '' };
  const stub = (n) => () => `<${n}>`;
  // 舊的服務那一條(規格:終端機與網頁說同一句 AC-5)也在每一頁最上面,接在故障橫條後面。
  // paint 是把整頁換上去的那一支(內容一樣就不換,工地工班風畫面 AC-3);這裡要看的是 render 交給它的那一整頁
  const paint = (html) => { $app.innerHTML = html; };
  // restartBanner:要重啟那一句(規格:還差什麼總表 AC-7)——接在故障橫條、舊的服務那一條後面,這裡只看它沒擠到最上面
  const render = code.every(Boolean) ? new Function('$app', '$crumb', 'location', 'latest', 'esc', 'briefCard', 'projectList', 'projectPage', 'sessionPage', 'faultBanner', 'oldServerBanner', 'paint', 'langBanner', 'restartBanner',
    `const zhEn = (zh) => zh; const many = (n, one, more = one + 's') => n + ' ' + (n === 1 ? one : more);\n${code.join('\n')}; return render;`)($app, $crumb, location, { projects: [] }, (v) => String(v ?? ''), stub('brief'), stub('list'), stub('project'), stub('session'), stub('BANNER'), stub('OLD'), paint, () => '', stub('TODO')) : null;
  for (const [hash, what] of [['', '案件列表'], ['#/p/x', '對話清單'], ['#/p/x/s/s1', '對話頁']]) {
    location.hash = hash;
    render?.();
    check(`${what}:最上面是故障橫條,接著是舊的服務那一條`, $app.innerHTML.startsWith('<BANNER><OLD>'), $app.innerHTML);
  }
}

section('魔鬼教官第二輪:收工 hook 壞過又好了——不准掛在之後才開始的對話上;「這一輪從哪開始」終端機與對話頁同一個算法', 'P2');
{
  const node = state([{ ts: H(120), event: 'gate_broken', why: '找不到 node' }], [], { ts: H(0.02), cwd: '/w' });
  eq('收工 hook 5 天前找不到 node、之後好了;昨天才開始的對話(起點是感測器第一筆記到的)→ 不講', faultNotes(node, { since: H(24), startKnown: false }).length, 0);
  eq('那段時間就在的對話 → 講', faultNotes(node, { since: H(200), startKnown: false }).length, 1);
  const err = state([{ ts: H(120), event: 'gate_broken', why: 'x', cwd: '/w' }], [], { ts: H(0.02), cwd: '/w' });
  eq('收工 hook 出錯 5 天前、之後好了;昨天才開始的對話 → 不講', faultNotes(err, { since: H(24), startKnown: false, cwd: '/w' }).length, 0);
  // 感測器的故障照舊:在故障期間開始的對話,第一筆被記到的就在修好之後
  const sens = state([jq(10), jq(9)], [11, 8, 2]);
  eq('感測器壞過又好了;起點是修好之後的第一筆、不知道真的起點 → 講', faultNotes(sens, { since: H(8), startKnown: false }).length, 1);

  // 起點:A、章是真的;感測器第一筆記到的 → 看對話開始的時間(換掉讀轉錄檔那一步:建立時間不是每種系統都改得動,P8)
  eq('起點是 A → 是真的起點', roundStartFor({ since: H(5), how: 'A', sessions: [{ id: 's1', cwd: '/w' }], bornOf: () => null }).startKnown, true);
  const early = roundStartFor({ since: H(5), how: 'prompt', sessions: [{ id: 's1', cwd: '/w' }], bornOf: () => H(9) });
  check('起點是第一句話、對話其實 9 小時前就開始了 → 起點改成 9 小時前,是真的', early.since === H(9) && early.startKnown === true, JSON.stringify(early));
  eq('拿不到對話開始的時間 → 不知道真的起點', roundStartFor({ since: H(5), how: 'prompt', sessions: [{ id: 's1', cwd: '/w' }], bornOf: () => null }).startKnown, false);
  eq('對話開始的時間反而比第一筆紀錄晚(檔案被換過之類)→ 不採信,不知道真的起點', roundStartFor({ since: H(5), how: 'prompt', sessions: [{ id: 's1', cwd: '/w' }], bornOf: () => H(1) }).startKnown, false);
  // Antigravity 轉錄檔 step 0 時間與 origin.at 相等（含 Z vs .000Z）→ 仍是真的起點（P3/P9）
  const same = roundStartFor({ since: H(5), how: 'prompt', sessions: [{ id: 's1', cwd: '/w' }], bornOf: () => H(5).replace('.000Z', 'Z') });
  eq('轉錄檔 step 0 與第一句話相等 → startKnown=true，修好後新對話不誤報舊故障', `${same.startKnown}|${faultNotes(sens, { ...same }).length}`, 'true|0');
  eq('好幾個對話、有一個拿不到 → 不知道真的起點', roundStartFor({ since: H(5), how: 'arrival', sessions: [{ id: 'a' }, { id: 'b' }], bornOf: (x) => (x.id === 'a' ? H(9) : null) }).startKnown, false);

  // 終端機與對話頁同一個算法:收工 hook 幾天前壞過、好了,這個對話之後才開始 → 兩邊都不講
  const s = scene();
  s.faults([{ ts: H(120), event: 'gate_broken', why: '找不到 node' }]);
  writeFileSync(join(s.logDir, '_gate.json'), JSON.stringify({ ts: H(0.5), cwd: s.root }) + '\n');
  const a = s.all(), out = s.cli().out;
  eq('對話頁不講', a.projects.flatMap((p) => p.sessions).find((x) => x.id === 's1')?.faultNotes?.length, 0);
  check('終端機也不講', !/找不到 node/.test(out), out);
  s.cleanup();
}

section('改檔把關故障（guard_broken）與心跳（_guard.json / guardLine）：缺 node、出錯、unclear、recovered，錯誤原文不上畫面', 'P3');
{
  const gNode = (h) => ({ ts: H(h), event: 'guard_broken', why: '找不到 node' });
  const gErr = (h, cwd) => ({ ts: H(h), event: 'guard_broken', why: 'ReferenceError: bad secret', ...(cwd ? { cwd } : {}) });
  const gState = (faults, guardHb = null) => faultState({ faults, sensorTimes: () => [], heartbeat: null, guardHb, now: NOW, retainDays: RETAIN_DAYS });

  const fsNode = gState([gNode(3)], { ts: H(5), cwd: '/a' });
  check('改檔把關找不到 node → 紅燈「改檔把關找不到 node」「改危險檔可能沒跳出來問你」',
    /改檔把關找不到 node/.test(texts(fsNode)) && /改危險檔可能沒跳出來問你/.test(texts(fsNode)), texts(fsNode));

  const fsErr = gState([gErr(3, '/w/a')], { ts: H(3.001), cwd: '/w/a' });
  const errText = texts(fsErr);
  check('改檔把關自己出錯 → 紅燈且錯誤原文不上畫面',
    /改檔把關自己出錯/.test(errText) && /改危險檔可能沒跳出來問你/.test(errText) && !/ReferenceError|bad secret/.test(errText), errText);

  const fsUnclear = gState([gErr(3, '/w/a')], { ts: H(1), cwd: '/w/b' });
  check('之後只有別的資料夾跑過 → 黃燈「a 之後有沒有跑過看不到」',
    faultBanner(fsUnclear)[0]?.tone === 'amber' && /改檔把關/.test(texts(fsUnclear)) && /a 之後有沒有跑過看不到/.test(texts(fsUnclear)), texts(fsUnclear));

  const fsRec = gState([gErr(3, '/w/a'), gNode(4)], { ts: H(1), cwd: '/w/a' });
  eq('改檔把關恢復後 → 不上橫條', faultBanner(fsRec).length, 0);
  const notes = faultNotes(fsRec, { since: H(5), cwd: '/w/a' });
  check('改檔把關恢復後 → 五關旁講最近一次或在此出錯過', notes.length === 2 && notes.every((x) => /改檔把關/.test(x)), JSON.stringify(notes));

  check('guardLine 沒心跳 → 還沒跑過', /改檔把關：還沒跑過/.test(guardLine(null)));
  check('guardLine 有心跳 → 最後一次跑', /改檔把關：最後一次跑/.test(guardLine({ ts: H(1) })));

  const tmpLog = mkdtempSync(join(tmpdir(), 'pm-ghb-'));
  eq('沒有 _guard.json → null', guardHeartbeat(tmpLog), null);
  writeFileSync(join(tmpLog, '_guard.json'), JSON.stringify({ ts: H(1), cwd: '/x' }));
  eq('讀得到 _guard.json', guardHeartbeat(tmpLog)?.cwd, '/x');
  rmSync(tmpLog, { recursive: true, force: true });
}

section('分級通知故障（escalate_broken）與心跳（_escalate.json / escalateLine）、collect.mjs anyRecovered 與 notGit', 'P3');
{
  const eNode = (h) => ({ ts: H(h), event: 'escalate_broken', why: '找不到 node' });
  const eErr = (h, cwd) => ({ ts: H(h), event: 'escalate_broken', why: 'TypeError: bad secret', ...(cwd ? { cwd } : {}) });
  const eState = (faults, escalateHb = null) => faultState({ faults, sensorTimes: () => [], heartbeat: null, guardHb: null, escalateHb, now: NOW, retainDays: RETAIN_DAYS });

  const fsNode = eState([eNode(3)], { ts: H(5), cwd: '/a' });
  check('分級通知找不到 node → 紅燈且說明可能沒即時通知 AI',
    /分級通知找不到 node/.test(texts(fsNode)) && /分級往上升可能沒即時通知 AI/.test(texts(fsNode)), texts(fsNode));

  const fsErr = eState([eErr(3, '/w/a')], { ts: H(3.001), cwd: '/w/a' });
  const errText = texts(fsErr);
  check('分級通知自己出錯 → 紅燈且錯誤原文不上畫面',
    /分級通知自己出錯/.test(errText) && /分級往上升可能沒即時通知 AI/.test(errText) && !/TypeError|bad secret/.test(errText), errText);

  const fsUnclear = eState([eErr(3, '/w/a')], { ts: H(1), cwd: '/w/b' });
  check('之後只有別的資料夾跑過 → 黃燈「a 之後有沒有跑過看不到」',
    faultBanner(fsUnclear)[0]?.tone === 'amber' && /分級通知/.test(texts(fsUnclear)) && /a 之後有沒有跑過看不到/.test(texts(fsUnclear)), texts(fsUnclear));

  const fsRec = eState([eErr(3, '/w/a'), eNode(4)], { ts: H(1), cwd: '/w/a' });
  eq('分級通知恢復後 → 不上橫條', faultBanner(fsRec).length, 0);
  const notes = faultNotes(fsRec, { since: H(5), cwd: '/w/a' });
  check('分級通知恢復後 → 五關旁講最近一次或在此出錯過', notes.length === 2 && notes.every((x) => /分級通知/.test(x)), JSON.stringify(notes));

  check('escalateLine 沒心跳 → 還沒跑過', /分級通知：還沒跑過/.test(escalateLine(null)));
  check('escalateLine 有心跳 → 最後一次跑', /分級通知：最後一次跑/.test(escalateLine({ ts: H(1) })));

  const tmpLog = mkdtempSync(join(tmpdir(), 'pm-ehb-'));
  eq('沒有 _escalate.json → null', escalateHeartbeat(tmpLog), null);
  writeFileSync(join(tmpLog, '_escalate.json'), JSON.stringify({ ts: H(1), cwd: '/x' }));
  eq('讀得到 _escalate.json', escalateHeartbeat(tmpLog)?.cwd, '/x');
  rmSync(tmpLog, { recursive: true, force: true });

  // collectAll 真實整合：僅 escalateNode 恢復／僅 escalateError 恢復時 anyRecovered 必亮 faultNotes；notGit 卡片（含同專案內混合）實測帶 escalate 與 lines.escalate
  const m = mkdtempSync(join(tmpdir(), 'pm-col-esc-'));
  const logDir = join(m, 'logs');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(join(m, 'checkpoints'), { recursive: true });
  copyFileSync(join(ROOT, 'stages.json'), join(m, 'stages.json'));
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const nonGit = mkdtempSync(join(tmpdir(), 'pm-nongit-'));
  const escTs = new Date(Date.now() - 30 * 60_000).toISOString();
  writeFileSync(join(logDir, '_escalate.json'), JSON.stringify({ ts: escTs, cwd: r.dir }) + '\n');
  writeFileSync(join(logDir, '_sensor.jsonl'), JSON.stringify({ ts: new Date(Date.now() - 60 * 60_000).toISOString(), event: 'escalate_broken', why: '找不到 node' }) + '\n');
  writeFileSync(join(logDir, `${safeName(basename(r.dir))}.jsonl`), [
    JSON.stringify({ ts: new Date(Date.now() - 90 * 60_000).toISOString(), hook: 'UserPrompt', session: 's1', cwd: r.dir, prompt: 'hi' }),
    JSON.stringify({ ts: new Date(Date.now() - 40 * 60_000).toISOString(), hook: 'PostToolUse', session: 's2', cwd: nonGit, tool: 'read_file' }),
  ].join('\n') + '\n');
  const prevLog = process.env.AGY_PIPELINE_LOG_DIR;
  const prevHome = process.env.AGY_PIPELINE_HOME;
  process.env.AGY_PIPELINE_LOG_DIR = logDir;
  process.env.AGY_PIPELINE_HOME = m;
  try {
    const all = collectAll({ monitorDir: m });
    const sess = all.projects.flatMap((p) => p.sessions).find((x) => x.id === 's1');
    check('collectAll：只有 escalateNode 恢復時對話 faultNotes 照講（anyRecovered）',
      sess?.faultNotes?.some((n) => /分級通知最近一次找不到 node/.test(n)), JSON.stringify(sess?.faultNotes));
    const ngCard = all.projects.flatMap((p) => p.cards).find((c) => c.path === nonGit);
    check('collectAll：notGit 卡片實測產生且 sensor / lines 帶 escalate（絕不短路跳過）',
      Boolean(ngCard) && ngCard.notGit === true && ngCard.sensor?.escalate?.cwd === r.dir && /分級通知：最後一次跑/.test(ngCard.sensor?.lines?.escalate ?? ''),
      JSON.stringify(ngCard));
    const gitCard = all.projects.flatMap((p) => p.cards).find((c) => c.path === r.dir);
    check('collectAll：git 卡片 sensor.lines.escalate 顯示最後一次跑',
      /分級通知：最後一次跑/.test(gitCard?.sensor?.lines?.escalate ?? ''), JSON.stringify(gitCard?.sensor?.lines));

    // 僅 escalateError 恢復時（非找不到 node）anyRecovered 也照樣觸發 faultNotes
    writeFileSync(join(logDir, '_sensor.jsonl'),
      JSON.stringify({ ts: new Date(Date.now() - 60 * 60_000).toISOString(), event: 'escalate_broken', why: 'TypeError: boom', cwd: r.dir }) + '\n');
    const allErr = collectAll({ monitorDir: m });
    const sessErr = allErr.projects.flatMap((p) => p.sessions).find((x) => x.id === 's1');
    check('collectAll：只有 escalateError 恢復時對話 faultNotes 照講（anyRecovered）',
      sessErr?.faultNotes?.some((n) => /分級通知.*在這裡出錯過/.test(n)) && !/TypeError|boom/.test(JSON.stringify(sessErr?.faultNotes)),
      JSON.stringify(sessErr?.faultNotes));
  } finally {
    if (prevLog === undefined) delete process.env.AGY_PIPELINE_LOG_DIR; else process.env.AGY_PIPELINE_LOG_DIR = prevLog;
    if (prevHome === undefined) delete process.env.AGY_PIPELINE_HOME; else process.env.AGY_PIPELINE_HOME = prevHome;
    rmSync(m, { recursive: true, force: true });
    rmSync(nonGit, { recursive: true, force: true });
    r.cleanup();
  }

  // D 第 1 輪 #5 回歸：子目錄或 symlink cwd 恢復的故障，網頁對話頁（symSub）與終端機（ctx.root）一致亮 faultNotes；跨 repo／嵌套獨立 git repo 不互混
  const rSub = makeRepo({ files: { 'sub/a.js': '1\n' } });
  const rOther = makeRepo({ files: { 'o.js': '1\n' } });
  const subRoot = real(rSub.dir);
  const symHost = mkdtempSync(join(tmpdir(), 'pm-flt-sym-'));
  const symSub = join(symHost, 'sublink');
  symlinkSync(join(subRoot, 'sub'), symSub);
  const nestedDir = join(subRoot, 'nested-repo');
  mkdirSync(nestedDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: nestedDir });
  const fsSymRec = eState([eErr(3, symSub)], { ts: H(1), cwd: symSub });
  check('D 第 1 輪 #5：symlink 子目錄恢復之 escalateError，網頁（symSub）與終端機（ctx.root）同亮 faultNotes',
    faultNotes(fsSymRec, { since: H(5), cwd: symSub }).length === 1 && faultNotes(fsSymRec, { since: H(5), cwd: subRoot }).length === 1,
    JSON.stringify({ ui: faultNotes(fsSymRec, { since: H(5), cwd: symSub }), cli: faultNotes(fsSymRec, { since: H(5), cwd: subRoot }) }));
  const fsRootRec = eState([eErr(3, subRoot)], { ts: H(1), cwd: subRoot });
  eq('D 第 1 輪 #5：別的 repo 不誤收 faultNotes', faultNotes(fsSymRec, { since: H(5), cwd: real(rOther.dir) }).length, 0);
  eq('D 第 1 輪 #5：嵌套獨立 git repo 不誤收外層 repo 之 faultNotes', faultNotes(fsRootRec, { since: H(5), cwd: real(nestedDir) }).length, 0);
  rmSync(symHost, { recursive: true, force: true });
  rOther.cleanup();
  rSub.cleanup();
}

section('各資料夾各自留心跳（byCwd）：跨 worktree 不復活、多資料夾部分恢復／紅燈不掩蓋、舊格式遷移與併發配對不造假', 'P3');
{
  // 1. 跨 worktree 與跨專案不復活（AC-1）
  const hbDir = mkdtempSync(join(tmpdir(), 'pm-hb-'));
  const rA = makeRepo({ files: { 'a.js': '1\n', 'sub1/x.js': '1\n', 'sub2/y.js': '1\n' } });
  const rB = makeRepo({ files: { 'b.js': '1\n' } });
  const wtHost = mkdtempSync(join(tmpdir(), 'pm-hb-wt-'));
  const wtA = join(wtHost, 'wt-a');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt-a', wtA], { cwd: rA.dir });
  const gErr = (h, cwd) => ({ ts: H(h), event: 'guard_broken', why: 'boom', ...(cwd ? { cwd } : {}) });

  recordHeartbeat(hbDir, '_guard.json', rA.dir, { retainDays: RETAIN_DAYS, now: ms(3) });
  recordHeartbeat(hbDir, '_guard.json', wtA, { retainDays: RETAIN_DAYS, now: ms(2) });
  recordHeartbeat(hbDir, '_guard.json', rB.dir, { retainDays: RETAIN_DAYS, now: ms(1) });
  const fsKeep = faultState({ faults: [gErr(5, rA.dir)], guardHb: guardHeartbeat(hbDir), now: NOW, retainDays: RETAIN_DAYS });
  eq('A 恢復後切到同 repo 的 worktree 與別的專案，A 不會復活成 unclear', fsKeep.guardError?.state, 'recovered');
  eq('已恢復切去別處 → 不亮橫條', faultBanner(fsKeep).length, 0);

  // 2. A 自最後一次錯誤後沒再跑過，就算 worktree 與 B 一直跑仍維持 unclear（R1）
  recordHeartbeat(hbDir, '_guard.json', wtA, { retainDays: RETAIN_DAYS, now: ms(0.2) });
  recordHeartbeat(hbDir, '_guard.json', rB.dir, { retainDays: RETAIN_DAYS, now: ms(0.1) });
  const fsStillUnclear = faultState({ faults: [gErr(0.5, rA.dir)], guardHb: guardHeartbeat(hbDir), now: NOW, retainDays: RETAIN_DAYS });
  eq('A 在較晚的錯誤後從沒跑過 → 維持 unclear', fsStillUnclear.guardError?.state, 'unclear');
  check('黃燈指名未恢復的 A', faultBanner(fsStillUnclear).some((b) => b.tone === 'amber' && b.text.includes(basename(rA.dir))), texts(fsStillUnclear));

  // 3. 統一 sameWorkspace（預審 #2）：平級子資料夾認得同一 repo、symlink 認同、已刪嵌套 worktree 不混算
  const hbDir2 = mkdtempSync(join(tmpdir(), 'pm-hb2-'));
  recordHeartbeat(hbDir2, '_guard.json', join(rA.dir, 'sub2'), { retainDays: RETAIN_DAYS, now: ms(2) });
  const fsSibling = faultState({ faults: [gErr(4, join(rA.dir, 'sub1'))], guardHb: guardHeartbeat(hbDir2), now: NOW, retainDays: RETAIN_DAYS });
  eq('同 repo 平級子資料夾（sub1 出錯、sub2 跑過）→ recovered', fsSibling.guardError?.state, 'recovered');
  eq('同 repo 平級子資料夾 faultNotes 也認得出', faultNotes(fsSibling, { since: H(5), cwd: join(rA.dir, 'sub2') }).length, 1);
  eq('終端機傳 repo root 也認得出', faultNotes(fsSibling, { since: H(5), cwd: real(rA.dir) }).length, 1);

  const symHost = mkdtempSync(join(tmpdir(), 'pm-hb-sym-'));
  const symA = join(symHost, 'link-a');
  symlinkSync(rA.dir, symA);
  const hbDirSym = mkdtempSync(join(tmpdir(), 'pm-hbsym-'));
  recordHeartbeat(hbDirSym, '_guard.json', symA, { retainDays: RETAIN_DAYS, now: ms(2) });
  eq('symlink 指向同一工作區 → 認得出已恢復',
    faultState({ faults: [gErr(4, rA.dir)], guardHb: guardHeartbeat(hbDirSym), now: NOW, retainDays: RETAIN_DAYS }).guardError?.state, 'recovered');

  const nestedWt = join(rA.dir, '.nested-wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt-nested', nestedWt], { cwd: rA.dir });
  const hbDirNested = mkdtempSync(join(tmpdir(), 'pm-hbnest-'));
  recordHeartbeat(hbDirNested, '_guard.json', nestedWt, { retainDays: RETAIN_DAYS, now: ms(2) });
  execFileSync('git', ['worktree', 'remove', '--force', nestedWt], { cwd: rA.dir });
  const fsDeletedNested = faultState({ faults: [gErr(4, rA.dir)], guardHb: guardHeartbeat(hbDirNested), now: NOW, retainDays: RETAIN_DAYS });
  eq('已刪除的嵌套 worktree 心跳絕不誤判主資料夾已恢復（R1）', fsDeletedNested.guardError?.state, 'unclear');
  eq('主資料夾恢復時，已刪除的嵌套 worktree 絕不誤收主資料夾的 faultNotes（P2/R1）',
    faultNotes(faultState({ faults: [gErr(4, rA.dir)], guardHb: { ts: H(2), cwd: rA.dir, byCwd: { [rA.dir]: H(2) } }, now: NOW, retainDays: RETAIN_DAYS }), { since: H(5), cwd: nestedWt }).length, 0);

  // 4. 多資料夾部分恢復、全部恢復與他處紅燈（AC-2、預審 #1）
  const hbDir3 = mkdtempSync(join(tmpdir(), 'pm-hb3-'));
  recordHeartbeat(hbDir3, '_guard.json', wtA, { retainDays: RETAIN_DAYS, now: ms(0.5) });
  const twoErrs = [gErr(5, rA.dir), gErr(2, rB.dir)];
  const fsBoth = faultState({ faults: twoErrs, guardHb: guardHeartbeat(hbDir3), now: NOW, retainDays: RETAIN_DAYS });
  eq('A 與 B 都還沒恢復時 → 各自輸出一條黃燈（共 2 條）', faultBanner(fsBoth).length, 2);
  check('多筆黃燈依時間由新到舊排列（B 在前、A 在後）',
    faultBanner(fsBoth)[0].text.includes(basename(rB.dir)) && faultBanner(fsBoth)[1].text.includes(basename(rA.dir)), texts(fsBoth));

  recordHeartbeat(hbDir3, '_guard.json', rB.dir, { retainDays: RETAIN_DAYS, now: ms(0.3) });
  const fsPartial = faultState({ faults: twoErrs, guardHb: guardHeartbeat(hbDir3), now: NOW, retainDays: RETAIN_DAYS });
  eq('只修好後出錯的 B，前面沒跑過的 A 仍維持 unclear 黃燈（AC-2）', fsPartial.guardError?.state, 'unclear');
  eq('只剩 1 條黃燈', faultBanner(fsPartial).length, 1);
  check('剩下那一條黃燈指名 A、不指 B', faultBanner(fsPartial)[0].text.includes(basename(rA.dir)) && !faultBanner(fsPartial)[0].text.includes(basename(rB.dir)), texts(fsPartial));
  eq('整體 unclear 期間，已恢復的 B 在五關旁照亮註記（預審 #1）', faultNotes(fsPartial, { since: H(6), cwd: rB.dir }).length, 1);
  eq('還沒恢復的 A 不會誤收 B 的恢復註記', faultNotes(fsPartial, { since: H(6), cwd: rA.dir }).length, 0);

  recordHeartbeat(hbDir3, '_guard.json', rA.dir, { retainDays: RETAIN_DAYS, now: ms(0.2) });
  const fsAllOk = faultState({ faults: twoErrs, guardHb: guardHeartbeat(hbDir3), now: NOW, retainDays: RETAIN_DAYS });
  eq('A 與 B 都恢復 → 0 條橫條', faultBanner(fsAllOk).length, 0);
  eq('全部恢復時各自保留獨立時段：B 在 B 出錯前（3 小時前）已結案的對話不誤掛 A 的時段（預審 #1）',
    faultNotes(fsAllOk, { since: H(6), until: H(3), cwd: rB.dir }).length, 0);
  eq('B 在出錯期間內的對話照樣亮註記', faultNotes(fsAllOk, { since: H(6), until: H(1), cwd: rB.dir }).length, 1);

  const fsBrokenWithRec = faultState({ faults: [...twoErrs, gErr(0.1, rB.dir)], guardHb: guardHeartbeat(hbDir3), now: NOW, retainDays: RETAIN_DAYS });
  eq('B 再出新錯使整體為 broken（紅燈）時，先恢復的 A 仍保有 recovered（預審 #1）', fsBrokenWithRec.guardError?.state, 'broken');
  eq('整體 broken 時 A 對話頁五關旁照亮註記', faultNotes(fsBrokenWithRec, { since: H(6), cwd: rA.dir }).length, 1);
  eq('整體 broken 時出錯中的 B 不亮恢復註記', faultNotes(fsBrokenWithRec, { since: H(6), cwd: rB.dir }).length, 0);

  const fsWithLegacy = faultState({ faults: [gErr(6), gErr(4, rA.dir)], guardHb: guardHeartbeat(hbDir3), now: NOW, retainDays: RETAIN_DAYS });
  eq('有 cwd 的 A 恢復後，無 cwd 的舊記號仍留 unclear', fsWithLegacy.guardError?.state, 'unclear');
  check('無 cwd 舊記號維持既有文案', /看不出是不是同一個資料夾/.test(texts(fsWithLegacy)) && !texts(fsWithLegacy).includes(basename(rA.dir)), texts(fsWithLegacy));

  // collectAll 整合實測：整體 unclear 與整體 broken 時，anyRecovered 照樣讓已恢復工作區的對話帶出 faultNotes（預審 #1）
  const colMon = mkdtempSync(join(tmpdir(), 'pm-col-rec-'));
  const colLogs = join(colMon, 'logs');
  mkdirSync(colLogs, { recursive: true });
  mkdirSync(join(colMon, 'checkpoints'), { recursive: true });
  copyFileSync(join(ROOT, 'stages.json'), join(colMon, 'stages.json'));
  const curMs = Date.now();
  const curH = (h) => new Date(curMs - h * 3600_000).toISOString();
  recordHeartbeat(colLogs, '_guard.json', rA.dir, { retainDays: RETAIN_DAYS, now: curMs - 1 * 3600_000 });
  recordHeartbeat(colLogs, '_guard.json', wtA, { retainDays: RETAIN_DAYS, now: curMs - 0.5 * 3600_000 });
  writeFileSync(join(colLogs, '_sensor.jsonl'), [
    JSON.stringify({ ts: curH(5), event: 'guard_broken', why: 'boom-a', cwd: rA.dir }),
    JSON.stringify({ ts: curH(2), event: 'guard_broken', why: 'boom-b', cwd: rB.dir }),
  ].join('\n') + '\n');
  writeFileSync(join(colLogs, `${safeName(basename(rA.dir))}.jsonl`),
    JSON.stringify({ ts: curH(6), hook: 'UserPrompt', session: 'sa1', cwd: rA.dir, prompt: 'hi' }) + '\n');
  const keepHomeCol = process.env.AGY_PIPELINE_HOME;
  const keepLogCol = process.env.AGY_PIPELINE_LOG_DIR;
  process.env.AGY_PIPELINE_HOME = colMon;
  process.env.AGY_PIPELINE_LOG_DIR = colLogs;
  try {
    const resUnclear = collectAll({ monitorDir: colMon });
    const saUnclear = resUnclear.projects.flatMap((p) => p.sessions).find((x) => x.id === 'sa1');
    check('collectAll：整體 unclear（B 未恢復）時，已恢復的 A 對話仍帶出 faultNotes',
      saUnclear?.faultNotes?.some((n) => /改檔把關.*在這裡出錯過/.test(n)), JSON.stringify(saUnclear?.faultNotes));
    writeFileSync(join(colLogs, '_sensor.jsonl'), [
      JSON.stringify({ ts: curH(5), event: 'guard_broken', why: 'boom-a', cwd: rA.dir }),
      JSON.stringify({ ts: curH(0.1), event: 'guard_broken', why: 'boom-b', cwd: rB.dir }),
    ].join('\n') + '\n');
    const resBroken = collectAll({ monitorDir: colMon });
    const saBroken = resBroken.projects.flatMap((p) => p.sessions).find((x) => x.id === 'sa1');
    check('collectAll：整體 broken（B 新出錯）時，已恢復的 A 對話仍帶出 faultNotes',
      saBroken?.faultNotes?.some((n) => /改檔把關.*在這裡出錯過/.test(n)), JSON.stringify(saBroken?.faultNotes));
  } finally {
    if (keepHomeCol === undefined) delete process.env.AGY_PIPELINE_HOME; else process.env.AGY_PIPELINE_HOME = keepHomeCol;
    if (keepLogCol === undefined) delete process.env.AGY_PIPELINE_LOG_DIR; else process.env.AGY_PIPELINE_LOG_DIR = keepLogCol;
    rmSync(colMon, { recursive: true, force: true });
  }

  // 5. 舊格式遷移、壞檔自癒、90 天清理、空 cwd、原型鍵、併發配對、寫入失敗容錯（AC-3、預審 #3）
  const hbDir4 = mkdtempSync(join(tmpdir(), 'pm-hb4-'));
  writeFileSync(join(hbDir4, '_guard.json'), JSON.stringify({ ts: H(2), cwd: '/legacy/old' }));
  recordHeartbeat(hbDir4, '_guard.json', '/legacy/new', { retainDays: RETAIN_DAYS, now: NOW });
  const migrated = guardHeartbeat(hbDir4);
  check('舊格式心跳檔自動遷移舊 cwd 進 byCwd，且同時寫入新 cwd',
    migrated?.byCwd?.['/legacy/old'] === H(2) && migrated?.byCwd?.['/legacy/new'] === new Date(NOW).toISOString(), JSON.stringify(migrated));

  writeFileSync(join(hbDir4, '_guard.json'), '{壞掉的 json');
  recordHeartbeat(hbDir4, '_guard.json', '/healed', { retainDays: RETAIN_DAYS, now: NOW });
  const healed = guardHeartbeat(hbDir4);
  eq('損毀心跳檔下次寫入自癒覆寫', healed?.cwd, '/healed');
  eq('原子替換後不殘留 .tmp 暫存檔', readdirSync(hbDir4).filter((f) => f.endsWith('.tmp')).length, 0);

  writeFileSync(join(hbDir4, '_guard.json'), JSON.stringify({
    ts: H(1), cwd: '/keep', byCwd: { '/old91': H(91 * 24), '/keep89': H(89 * 24) },
  }));
  recordHeartbeat(hbDir4, '_guard.json', '/keep', { retainDays: RETAIN_DAYS, now: NOW });
  const pruned = guardHeartbeat(hbDir4);
  check('寫入時自動清理超過保留期限（90 天）的過期鍵、保留 89 天前鍵',
    !('/old91' in (pruned?.byCwd ?? {})) && pruned?.byCwd?.['/keep89'] === H(89 * 24), JSON.stringify(pruned));

  recordHeartbeat(hbDir4, '_guard.json', '', { retainDays: RETAIN_DAYS, now: NOW });
  recordHeartbeat(hbDir4, '_guard.json', null, { retainDays: RETAIN_DAYS, now: NOW });
  const afterEmpty = guardHeartbeat(hbDir4);
  check('空 cwd 不寫入空鍵且保留既有 byCwd',
    !('' in (afterEmpty?.byCwd ?? {})) && afterEmpty?.byCwd?.['/keep89'] === H(89 * 24), JSON.stringify(afterEmpty));

  writeFileSync(join(hbDir4, '_guard.json'), '{"ts":"' + H(1) + '","cwd":"/x","byCwd":{"__proto__":"' + H(2) + '","constructor":"' + H(2) + '"}}');
  recordHeartbeat(hbDir4, '_guard.json', '__proto__', { retainDays: RETAIN_DAYS, now: NOW });
  eq('原型鍵 __proto__／constructor 不污染 Object.prototype', ({}).polluted === undefined && typeof ({}).toString === 'function', true);

  const hbDirConc = mkdtempSync(join(tmpdir(), 'pm-hb-conc-'));
  recordHeartbeat(hbDirConc, '_guard.json', '/A', { retainDays: RETAIN_DAYS, now: ms(1) });
  recordHeartbeat(hbDirConc, '_guard.json', '/B', { retainDays: RETAIN_DAYS, now: ms(4) });
  const conc = guardHeartbeat(hbDirConc);
  check('併發寫入時間較舊者不蓋掉較新頂層 ts/cwd 配對（預審 #3）',
    conc?.ts === H(1) && conc?.cwd === '/A' && conc?.byCwd?.['/A'] === H(1) && conc?.byCwd?.['/B'] === H(4), JSON.stringify(conc));

  const mismatched = { ts: H(1), cwd: '/B', byCwd: { '/A': H(1), '/B': H(5) } };
  eq('已有合法 byCwd 時不退回讀頂層 cwd，防止假恢復（預審 #3）',
    faultState({ faults: [gErr(3, '/B')], guardHb: mismatched, now: NOW, retainDays: RETAIN_DAYS }).guardError?.state, 'unclear');

  const blockedDir = mkdtempSync(join(tmpdir(), 'pm-hb-blk-'));
  const notADir = join(blockedDir, 'file-not-dir');
  writeFileSync(notADir, 'x');
  let threw = false;
  try { recordHeartbeat(notADir, '_guard.json', '/A', { retainDays: RETAIN_DAYS, now: NOW }); } catch { threw = true; }
  eq('寫入失敗時靜默不拋錯（不鎖死對話／編輯）', threw, false);

  for (const d of [hbDir, hbDir2, hbDirSym, hbDirNested, hbDir3, hbDir4, hbDirConc, blockedDir, wtHost, symHost]) rmSync(d, { recursive: true, force: true });
  rA.cleanup(); rB.cleanup();
}

section('各資料夾心跳：終端機與儀表板多資料夾橫條一字不差', 'P2');
{
  const s = scene();
  s.faults([
    { ts: H(5), event: 'guard_broken', why: 'err-1', cwd: s.root },
    { ts: H(3), event: 'guard_broken', why: 'err-2', cwd: '/elsewhere/projB' },
  ]);
  recordHeartbeat(s.logDir, '_guard.json', '/other/projC', { retainDays: RETAIN_DAYS, now: NOW });
  const a = s.all();
  const out = s.cli().out;
  eq('儀表板多資料夾橫條 2 條', a.faults.banner.length, 2);
  check('終端機最上面與儀表板每一條橫條一字不差',
    a.faults.banner.every((b) => out.includes(b.text)), `${JSON.stringify(a.faults.banner)}\n---\n${out}`);
  s.cleanup();
}

process.exit(summary());
