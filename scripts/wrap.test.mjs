#!/usr/bin/env node
/**
 * wrap.test.mjs —— 主任收尾(規格:主任動手收尾,路徑看 CLAUDE.md 的表):pipeline-status --wrap 那四步、蓋章前的檢查、重啟完的確認、乾淨副本。
 * 釘的是會安靜說謊的地方:沒有你那句話就動手(AC-6)、沒確認就說成了(R2)、快轉不了就硬併、那一邊有新存檔就硬推、
 * 還有一關的結論沒了結照樣蓋章——直接叫 --checkpoint 那條路也要擋(P6)、測試偷用這台電腦的環境(P8)。長相不釘。
 * 每一段的 git 都是真的:真的 worktree、真的快轉、真的推到一個本機的 bare repo(當成 GitHub)。
 * ⚠️ 重啟只用假的服務測(stepRestart 換掉 ask／restart):用真的指令叫,會把這台電腦的儀表板重啟。
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, symlinkSync, utimesSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { findWords, stepRestart, restartConfirmed } from '../lib/cliWrap.mjs';
import { cleanEnv, cloneAt } from './clean-run.mjs';
import { safeName } from '../lib/events.mjs';
import { withLang } from '../lib/lang.mjs';
import { CJK } from './_zhscan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).name;
const out = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const NOW = Date.now();                                   // 「現在」只取一次(L18)
const T = (sec) => new Date(NOW + sec * 1000).toISOString();
const MIN = 60;

const said = (sec, prompt, o = {}) => ({ ts: T(sec), hook: 'UserPrompt', prompt, prompt_id: `p${sec}`, ...o });
const callDirector = (sec) => ({ ts: T(sec), hook: 'PostToolUse', tool: 'read_file', skill: `${PLUGIN}:director` });
const callD = (sec, head) => ({ ts: T(sec), hook: 'PostToolUse', tool: 'read_file', skill: `${PLUGIN}:chaos-check`, head });
const reportD = (sec) => ({ ts: T(sec), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'ai' });

/**
 * 一個專案:主資料夾(master,上游是一個本機的 bare repo)+ 這個對話的 worktree(work 分支)+ 假的紀錄的家。
 * tiers:有分級設定(src/ 是程式區 → 改了就要 D);scripts:package.json 的 scripts(蓋章要跑的檢查)
 */
function world({ tiers = true, scripts = { test: 'node -e ""' } } = {}) {
  const files = { 'src/a.js': 'a\n', 'package.json': JSON.stringify({ name: 'p', version: '1.2.0', scripts }) };
  if (tiers) files['.claude/pipeline-stages.json'] = JSON.stringify({ tiers: { code: ['src/'], danger: [] } });
  const r = makeRepo({ at: T(-120 * MIN), files });
  const mainDir = out(r.dir, 'rev-parse', '--show-toplevel');       // 真實路徑(Mac 的 /var 是 /private/var 的捷徑)
  const main = out(mainDir, 'rev-parse', '--abbrev-ref', 'HEAD');     // 測試的 git 用 master(老毛病 P8)
  const env = (sec) => ({ ...process.env, GIT_AUTHOR_DATE: T(sec), GIT_COMMITTER_DATE: T(sec) });
  const g = (cwd, sec, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore', env: env(sec) });
  const box = mkdtempSync(join(tmpdir(), 'pm-wrap-'));
  g(mainDir, -110 * MIN, 'worktree', 'add', '-q', '-b', 'work', join(box, 'wt'));
  const wt = out(join(box, 'wt'), 'rev-parse', '--show-toplevel');
  const remote = join(box, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  g(mainDir, -105 * MIN, 'remote', 'add', 'origin', remote);
  g(mainDir, -105 * MIN, 'push', '-q', '-u', 'origin', main);
  const commit = (dir, sec, files2, msg) => {
    for (const [p, body] of Object.entries(files2)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body); }
    g(dir, sec, 'add', '-A'); g(dir, sec, 'commit', '-qm', msg);
  };
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-wrap-mon-'));
  const logDir = join(monitorDir, 'logs');
  mkdirSync(logDir); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-wrap-home-'));
  mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(ROOT, join(home, '.gemini', 'config', 'plugins', PLUGIN));
  const log = join(logDir, `${safeName(basename(r.dir))}.jsonl`);
  const line = (o) => JSON.stringify({ session: 's1', cwd: wt, ...o });
  const write = (lines) => writeFileSync(log, lines.map(line).join('\n') + '\n');
  const add = (lines) => appendFileSync(log, lines.map(line).join('\n') + '\n');
  const cli = (args, { sid = 's1' } = {}) => {
    const { ANTIGRAVITY_CONVERSATION_ID: _drop, ...rest } = process.env;
    const e = { ...rest, HOME: home, AGY_PIPELINE_HOME: monitorDir, AGY_PIPELINE_LOG_DIR: logDir, ...(sid ? { ANTIGRAVITY_CONVERSATION_ID: sid } : {}) };
    try { return { code: 0, text: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: wt, encoding: 'utf8', env: e }) }; }
    catch (x) { return { code: typeof x.status === 'number' ? x.status : 1, text: String(x.stdout ?? '') + String(x.stderr ?? '') }; }
  };
  const stamps = () => readdirSync(join(monitorDir, 'checkpoints'));
  const cleanup = () => {
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: mainDir, stdio: 'ignore' }); } catch { /* 已經不在 */ }
    for (const d of [monitorDir, home, box]) rmSync(d, { recursive: true, force: true });
    r.cleanup();
  };
  return { mainDir, main, wt, remote, g, commit, write, add, cli, stamps, cleanup };
}

section('AC-6:沒有你那句話不動手——只認主任最後一次被叫之後、你打的話', 'P7');
{
  const ev = (list) => list.map((o) => ({ session: 's1', ...o }));
  eq('主任還沒被叫過 → 不動手', findWords(ev([said(-5 * MIN, '照建議收尾')]), 's1', '照建議收尾').state, 'no-director');
  eq('你那句話在主任被叫之前 → 找不到', findWords(ev([said(-9 * MIN, '照建議收尾'), callDirector(-8 * MIN)]), 's1', '照建議收尾').state, 'not-found');
  const ok = findWords(ev([callDirector(-8 * MIN), said(-5 * MIN, '好，照建議收尾吧')]), 's1', '照建議收尾');
  check('主任問完之後你說的 → 找得到(你那句話裡有這幾個字就算)', ok.state === 'ok' && ok.said.ts === T(-5 * MIN) && ok.cut === false, JSON.stringify(ok));
  eq('app 包在對話開頭的那一層(別的對話交代的)不算你說的', findWords(ev([callDirector(-8 * MIN), said(-5 * MIN, '照建議收尾', { prompt_wrap: 'task' })]), 's1', '照建議收尾').state, 'not-found');
  eq('背景工作的通知不算你說的', findWords(ev([callDirector(-8 * MIN), said(-5 * MIN, '<task-notification>照建議收尾</task-notification>')]), 's1', '照建議收尾').state, 'not-found');
  eq('別的對話裡說的不算', findWords([callDirector(-8 * MIN), said(-5 * MIN, '照建議收尾')].map((o, i) => ({ session: i ? 's2' : 's1', ...o })), 's1', '照建議收尾').state, 'not-found');
  eq('主任又被叫了一次:之前的話全部不算', findWords(ev([callDirector(-9 * MIN), said(-8 * MIN, '照建議收尾'), callDirector(-6 * MIN)]), 's1', '照建議收尾').state, 'not-found');
  const twice = findWords(ev([callDirector(-9 * MIN), said(-8 * MIN, '照建議收尾'), said(-3 * MIN, '照建議收尾')]), 's1', '照建議收尾');
  eq('同一句說了兩次:認最後那一次(你再說一次就是再准一次)', twice.said?.ts, T(-3 * MIN));
  const long = `照建議收尾，${'另外再看一下'.repeat(40)}`;
  const kept = [...long].slice(0, 200).join('');                     // 感測器只記前 200 字
  const lw = findWords(ev([callDirector(-8 * MIN), said(-5 * MIN, kept)]), 's1', long);
  check('你那句話很長:原話以感測器記的那 200 字開頭就算,標出只比對了前 200 字', lw.state === 'ok' && lw.cut === true, JSON.stringify(lw));
  eq('……開頭對不上就不算', findWords(ev([callDirector(-8 * MIN), said(-5 * MIN, kept)]), 's1', `先不要${long}`).state, 'not-found');
}

section('AC-6:你自己打斜線指令叫主任,也算主任被叫過(叫主任有兩條路,兩條都認)', 'P6');
{
  const ev = (list) => list.map((o) => ({ session: 's1', ...o }));
  eq('打的那一句之後你說的 → 找得到', findWords(ev([said(-8 * MIN, `/${PLUGIN}:director`), said(-5 * MIN, '照建議收尾')]), 's1', '照建議收尾').state, 'ok');
  eq('……打的那一句本身不是你的回答', findWords(ev([said(-8 * MIN, `/${PLUGIN}:director 照建議收尾`)]), 's1', '照建議收尾').state, 'not-found');
}

section('AC-2、AC-6:併進 main 只快轉,做完再問一次 main 指到哪;同一句話同一步只試一次');
{
  const w = world();
  w.commit(w.wt, -60 * MIN, { 'src/a.js': 'mine\n' }, '這個對話的存檔');
  const tip = out(w.wt, 'rev-parse', 'HEAD');
  w.write([callDirector(-10 * MIN), said(-5 * MIN, '照建議收尾')]);
  const none = w.cli(['--wrap', 'merge', '照建議收尾'], { sid: null });
  check('拿不到對話代號(不是從 Claude Code 跑的)→ 沒做', none.code === 1 && /併進 main：沒做——拿不到這是哪個對話/.test(none.text), none.text);
  const miss = w.cli(['--wrap', 'merge', '先併再說']);
  check('原話在紀錄裡找不到 → 沒做,main 沒動', miss.code === 1 && /找不到你在主任問完之後說的這句話/.test(miss.text) && out(w.mainDir, 'rev-parse', w.main) !== tip, miss.text);
  const r1 = w.cli(['--wrap', 'merge', '照建議收尾']);
  check('成了:main 現在就是這條分支最後一個存檔(附版本號與你的原話)', r1.code === 0
    && /併進 main：成了——master 現在就是這條分支最後一個存檔 [0-9a-f]{7}（v1\.2\.0）/.test(r1.text) && /照你說的「照建議收尾」/.test(r1.text), r1.text);
  eq('……真的:主資料夾的 master 指到分支尖端', out(w.mainDir, 'rev-parse', w.main), tip);
  const r2 = w.cli(['--wrap', 'merge', '照建議收尾']);
  check('同一句話再叫一次 → 沒做,要你再說一句', r2.code === 1 && /已經拿來做過一次（成了）——要再做一次，請你再說一句/.test(r2.text), r2.text);
  w.add([said(-1 * MIN, '再併一次')]);
  const r3 = w.cli(['--wrap', 'merge', '再併一次']);
  check('你再說一句 → 再試一次;main 已經就是它 → 不用', r3.code === 0 && /併進 main：不用——master 已經就是這條分支最後一個存檔/.test(r3.text), r3.text);
  w.cleanup();
}
{
  const w = world();
  w.commit(w.wt, -60 * MIN, { 'src/a.js': 'mine\n' }, '存檔');
  writeFileSync(join(w.wt, 'src/b.js'), 'not saved\n');
  const before = out(w.mainDir, 'rev-parse', w.main);
  w.write([callDirector(-10 * MIN), said(-5 * MIN, '照建議收尾')]);
  const r = w.cli(['--wrap', 'merge', '照建議收尾']);
  check('這個資料夾還有沒存的檔 → 沒做(沒存的不會跟著過去),main 沒動', r.code === 1 && /沒做——這個資料夾還有 1 個檔沒存/.test(r.text) && out(w.mainDir, 'rev-parse', w.main) === before, r.text);
  w.cleanup();
}
{
  const w = world();
  w.commit(w.wt, -60 * MIN, { 'src/a.js': 'mine\n' }, '存檔');
  w.commit(w.mainDir, -50 * MIN, { 'src/c.js': 'other\n' }, 'main 上這條分支沒有的存檔');
  const before = out(w.mainDir, 'rev-parse', w.main);
  w.write([callDirector(-10 * MIN), said(-5 * MIN, '照建議收尾')]);
  const r = w.cli(['--wrap', 'merge', '照建議收尾']);
  check('main 多了這條分支沒有的存檔 → 快轉不了、沒做、回來問;不講那是誰的存檔(證明不了)', r.code === 1
    && /master 多了 1 個這條分支沒有的存檔，快轉不了——要先把 master 併進這條分支/.test(r.text) && !/別的對話/.test(r.text), r.text);
  eq('……main 沒動、沒有多出合併的存檔', out(w.mainDir, 'rev-parse', w.main), before);
  w.cleanup();
}
{
  const w = world();
  w.commit(w.wt, -60 * MIN, { 'src/a.js': 'mine\n' }, '存檔');
  writeFileSync(join(w.mainDir, 'src/a.js'), 'dirty in main\n');
  w.write([callDirector(-10 * MIN), said(-5 * MIN, '收尾吧'), said(-4 * MIN, '主資料夾整理好了，併吧')]);
  const r = w.cli(['--wrap', 'merge', '收尾吧']);
  check('主資料夾有沒存的改動 → 不動它、沒做', r.code === 1 && /主資料夾有 1 個檔還沒存，不動它/.test(r.text), r.text);
  execFileSync('git', ['checkout', '--', '.'], { cwd: w.mainDir });
  execFileSync('git', ['checkout', '-q', '-b', 'side'], { cwd: w.mainDir });
  const r2 = w.cli(['--wrap', 'merge', '併吧']);
  check('主資料夾不在 main 上 → 不動它、沒做', r2.code === 1 && /主資料夾現在不在 master 上（在 side）/.test(r2.text), r2.text);
  w.cleanup();
}

section('AC-3:推完當場問那一邊,對得上才說推上去了;那一邊有這台沒有的存檔就不硬推');
{
  const w = world();
  w.commit(w.mainDir, -50 * MIN, { 'src/a.js': 'merged\n' }, '併進來的存檔');
  const local = out(w.mainDir, 'rev-parse', w.main);
  w.write([callDirector(-10 * MIN), said(-5 * MIN, '照建議收尾')]);
  const r = w.cli(['--wrap', 'push', '照建議收尾']);
  check('成了:推完問那一邊,它的 master 跟這台一樣(上游不是 github.com 就照它的名字講)', r.code === 0
    && /推上 origin：成了——origin 上的 master 就是 [0-9a-f]{7}（v1\.2\.0），跟這台一樣/.test(r.text), r.text);
  eq('……真的:那一邊的 master', out(w.remote, 'rev-parse', w.main), local);
  w.cleanup();
}
{
  const w = world();
  // 別台電腦先推了一個存檔上去
  const other = join(mkdtempSync(join(tmpdir(), 'pm-wrap-other-')), 'c');
  execFileSync('git', ['clone', '-q', w.remote, other]);
  writeFileSync(join(other, 'src/z.js'), 'z\n');
  execFileSync('git', ['-c', 'user.email=o@o', '-c', 'user.name=O', 'commit', '-qam', 'x', '--allow-empty'], { cwd: other });
  execFileSync('git', ['add', '-A'], { cwd: other });
  execFileSync('git', ['-c', 'user.email=o@o', '-c', 'user.name=O', 'commit', '-qm', '別台的存檔'], { cwd: other });
  execFileSync('git', ['push', '-q', 'origin', w.main], { cwd: other });
  const theirs = out(w.remote, 'rev-parse', w.main);
  w.commit(w.mainDir, -50 * MIN, { 'src/a.js': 'mine\n' }, '這台的存檔');
  w.write([callDirector(-10 * MIN), said(-5 * MIN, '照建議收尾')]);
  const r = w.cli(['--wrap', 'push', '照建議收尾']);
  check('那一邊有這台沒有的存檔 → 沒成、不硬推、回來問', r.code === 1 && /推上 origin：沒成——origin 上有這台沒有的存檔，沒推（不硬推）/.test(r.text), r.text);
  eq('……那一邊沒被蓋掉', out(w.remote, 'rev-parse', w.main), theirs);
  rmSync(dirname(other), { recursive: true, force: true });
  w.cleanup();
}
{
  const w = world();
  execFileSync('git', ['branch', '--unset-upstream', w.main], { cwd: w.mainDir });
  w.write([callDirector(-10 * MIN), said(-5 * MIN, '照建議收尾')]);
  const r = w.cli(['--wrap', 'push', '照建議收尾']);
  check('main 沒有設定要推到哪裡 → 不用,不說推上去了', r.code === 0 && /不用——master 沒有設定要推到哪裡（沒有上游）/.test(r.text) && !/成了/.test(r.text), r.text);
  w.cleanup();
}

section('AC-4:服務用的程式改過才重啟;重啟完再問一次,跑的是現在的程式才說成了——直接叫 --serve-restart 也講同一句', 'P6');
{
  let restarts = 0;
  const restart = (ok = true) => async () => { restarts++; return ok ? { ok: true, out: ['✅ 重啟了'] } : { ok: false, out: ['沒裝背景服務。裝：pipeline-status --serve-install'] }; };
  const seq = (...states) => { let i = 0; return async () => states[Math.min(i++, states.length - 1)]; };
  const fresh = { state: 'ok', bootAt: T(-3), changed: [] };
  const old = { state: 'ok', bootAt: T(-3600), changed: ['lib/a.mjs'] };
  let r = await stepRestart(null, null, { ask: seq({ ...fresh, bootAt: T(-3600) }), restart: restart() });
  check('沒改過 → 不用,沒有重啟', r.kind === 'no-need' && /啟動之後，它用到的程式沒改過/.test(r.text) && restarts === 0, JSON.stringify(r));
  r = await stepRestart(null, null, { ask: seq(old, fresh), restart: restart() });
  check('改過 → 重啟,再問一次說跑的是現在的程式 → 成了', r.kind === 'done' && /剛啟動，跑的是現在的程式/.test(r.text) && restarts === 1, JSON.stringify(r));
  r = await stepRestart(null, null, { ask: seq(old, { ...old, bootAt: T(-3) }), restart: restart() });
  check('重啟之後服務還是說改過 → 沒成,講是哪幾個檔', r.kind === 'failed' && /重啟之後服務還是說 lib\/a\.mjs 改過/.test(r.text), JSON.stringify(r));
  r = await stepRestart(null, null, { ask: seq(old, { state: 'down' }), restart: restart() });
  check('重啟了、之後問不到 → 問不到,不說成了', r.kind === 'unknown' && /重啟了，但問不到它跑的是不是現在的程式/.test(r.text), JSON.stringify(r));
  const before = restarts;
  r = await stepRestart(null, null, { ask: seq({ state: 'down' }), restart: restart() });
  check('連不上服務 → 沒做,不說「不用重啟」,也不亂重啟', r.kind === 'not-done' && /連不上儀表板的服務，不知道要不要重啟/.test(r.text) && restarts === before, JSON.stringify(r));
  r = await stepRestart(null, null, { ask: seq({ state: 'slow', seconds: 10 }), restart: restart() });
  check('服務太久沒回答 → 沒做(可能正忙),不講成沒在跑', r.kind === 'not-done' && /10 秒內沒回答（可能正忙）/.test(r.text), JSON.stringify(r));
  r = await stepRestart(null, null, { ask: seq({ state: 'ok', bootAt: T(-60), changed: null }), restart: restart() });
  check('服務問不到程式改過沒 → 沒做,不當成沒改過', r.kind === 'not-done' && /問不到服務啟動之後程式有沒有改過/.test(r.text), JSON.stringify(r));
  r = await stepRestart(null, null, { ask: seq({ state: 'old' }, fresh), restart: restart() });
  check('服務舊到還不會回答 → 重啟,重啟完它答得出來 → 成了', r.kind === 'done', JSON.stringify(r));
  r = await stepRestart(null, null, { ask: seq(old), restart: restart(false) });
  check('沒裝背景服務 → 沒成,照它的話講', r.kind === 'failed' && /沒裝背景服務/.test(r.text), JSON.stringify(r));
  const c = await restartConfirmed({ ask: seq(fresh), restart: restart() });
  check('直接叫 --serve-restart:重啟完補上同一句(跑的是現在的程式)', c.ok && c.out.some((l) => /剛啟動，跑的是現在的程式/.test(l)), JSON.stringify(c));
  const c2 = await restartConfirmed({ ask: seq({ state: 'down' }), restart: restart() });
  check('……問不到就不算成了(ok 是 false),講問不到', !c2.ok && c2.out.some((l) => /⚠️ 重啟了，但問不到它跑的是不是現在的程式/.test(l)), JSON.stringify(c2));
  const en = await withLang('en', () => stepRestart(null, null, { ask: seq(old, fresh), restart: restart() }));
  check('英文那一句沒有中文', en.kind === 'done' && !CJK.test(`${en.label} ${en.text}`), JSON.stringify(en));
}

section('AC-5:還有一關的結論沒了結就不蓋章——主任收尾那一步、直接叫 --checkpoint 都擋,講白板上那一句', 'P6');
{
  // 改了程式(分級要 D)、叫了 D、記了結論,之後又改了程式 → D「要不要再跑由你決定」
  const w = world();
  w.commit(w.wt, -36 * MIN, { 'src/a.js': 'v1\n' }, '第一版');
  const h = out(w.wt, 'rev-parse', '--short', 'HEAD');
  w.commit(w.wt, -20 * MIN, { 'src/a.js': 'v2\n' }, 'D 之後又改');
  const after = new Date(Date.parse(T(-20 * MIN)));
  utimesSync(join(w.wt, 'src/a.js'), after, after);
  w.write([said(-40 * MIN, '修一下'), callD(-30 * MIN, h), reportD(-29 * MIN), callDirector(-10 * MIN), said(-5 * MIN, '照建議收尾')]);
  const cp = w.cli(['--checkpoint']);
  // 整句都要對:只比開頭的話,後面印出 undefined 也照樣綠(寫的時候就是這樣漏過去的)
  check('直接叫 --checkpoint → 不蓋,講白板上那一句(等你決定 D 要不要再跑)', cp.code === 1
    && /⚠️ 不蓋章：還有一關的結論沒了結——等你決定（D [^）]+）：[^\n]*要不要再跑由你決定/.test(cp.text) && /蓋章會結掉這一輪/.test(cp.text) && !/undefined|null/.test(cp.text), cp.text);
  eq('……沒有寫出任何一顆章', w.stamps().length, 0);
  const ws = w.cli(['--wrap', 'stamp', '照建議收尾']);
  check('主任收尾那一步 → 沒做,講同一句', ws.code === 1 && /蓋章：沒做——還有一關的結論沒了結——等你決定（D [^）]+）：[^\n]*要不要再跑由你決定/.test(ws.text) && !/undefined|null/.test(ws.text), ws.text);
  // 你在 D 之後說不用再跑(Claude 照原話代記)→ 結了;你再說一句蓋章 → 蓋,讀回來對得上
  w.add([said(-2 * MIN, 'D 不用再跑'), said(-1 * MIN, '好，蓋章')]);
  w.cli(['--decide', 'D', 'skip', 'D 不用再跑']);
  const ok = w.cli(['--wrap', 'stamp', '好，蓋章']);
  check('D 的事了結了 → 跑檢查、蓋章,讀回來對得上才說成了', ok.code === 0 && /🟢 蓋章完成/.test(ok.text) && /蓋章：成了——章蓋在 [0-9a-f]{7}，讀回來對得上/.test(ok.text), ok.text);
  eq('……真的寫了一顆章', w.stamps().length, 1);
  w.cleanup();
}
{
  // 改了程式、分級要 D,D 一次都沒跑
  const w = world();
  w.commit(w.wt, -36 * MIN, { 'src/a.js': 'v1\n' }, '改程式');
  w.write([said(-40 * MIN, '修一下')]);
  const cp = w.cli(['--checkpoint']);
  check('分級要 D、D 還沒跑 → 不蓋,講分級卡上那一句', cp.code === 1 && /⚠️ 不蓋章：還有一關的結論沒了結——.*D 魔鬼教官/.test(cp.text)
    && !/undefined|null/.test(cp.text) && w.stamps().length === 0, cp.text);
  w.cleanup();
}
{
  // 沒設定分級:不知道要不要 D,這裡不擋(白板另外講「不知道該跑哪幾關」)——照舊跑檢查、蓋章
  const w = world({ tiers: false });
  w.commit(w.wt, -36 * MIN, { 'src/a.js': 'v1\n' }, '改程式');
  w.write([said(-40 * MIN, '修一下')]);
  const cp = w.cli(['--checkpoint']);
  check('沒設定分級 → 不擋,照舊蓋章', cp.code === 0 && /🟢 蓋章完成/.test(cp.text) && !/不蓋章/.test(cp.text), cp.text);
  w.cleanup();
}

section('魔鬼教官第一輪:D 找到問題、之後沒再改程式(你決定那幾條不修)——蓋章不擋,跟收工 hook 講同一件事;擋了就沒有出口', 'P2');
{
  const w = world();
  w.commit(w.wt, -36 * MIN, { 'src/a.js': 'v1\n' }, '改程式');
  const h = out(w.wt, 'rev-parse', '--short', 'HEAD');
  const before = new Date(Date.parse(T(-36 * MIN)));
  utimesSync(join(w.wt, 'src/a.js'), before, before);                  // 改在叫 D 之前:之後沒再改
  w.write([said(-40 * MIN, '修一下'), callD(-30 * MIN, h), { ...reportD(-29 * MIN), verdict: 'found', note: '找到 1 條' }, said(-20 * MIN, '那一條不修')]);
  const cp = w.cli(['--checkpoint']);
  check('直接叫 --checkpoint → 照舊跑檢查、蓋章,不講「不蓋章」', cp.code === 0 && /🟢 蓋章完成/.test(cp.text) && !/不蓋章/.test(cp.text), cp.text);
  eq('……真的寫了一顆章', w.stamps().length, 1);
  w.cleanup();
}

section('英文:--wrap 那幾行沒有中文', 'P2');
{
  const w = world();
  w.commit(w.wt, -60 * MIN, { 'src/a.js': 'mine\n' }, 'commit');
  w.write([callDirector(-10 * MIN), said(-5 * MIN, 'wrap up as suggested')]);
  w.cli(['--lang', 'en']);
  const r = w.cli(['--wrap', 'merge', 'wrap up as suggested']);
  check('英文:併進 main 成了那一行與附的原話', r.code === 0 && /Merge into main: done: master is now this branch's last commit, [0-9a-f]{7} \(v1\.2\.0\)/.test(r.text)
    && /going by what the user said: “wrap up as suggested”/.test(r.text), r.text);
  check('……整段沒有中文', !CJK.test(r.text), r.text);
  const no = w.cli(['--wrap', 'push']);
  check('英文:沒附原話 → 沒做', no.code === 1 && /Push to GitHub: not done: attach what the user said/.test(no.text) && !CJK.test(no.text), no.text);
  const noTarget = w.cli(['--wrap', 'dispatch']);
  check('帶目標步驟沒給目標 → 沒做', noTarget.code === 1 && /Dispatch new conversation: not done: This step needs a target/.test(noTarget.text) && !CJK.test(noTarget.text), noTarget.text);
  w.cleanup();
}

section('AC-8:推之前在乾淨副本跑一次測試——環境照 L24 給齊,一個都不沿用這台電腦的', 'P8');
{
  const env = cleanEnv('/tmp/x-home', '/opt/node/bin/node');
  eq('只給這幾個環境變數', Object.keys(env).sort().join(','), 'GIT_CONFIG_NOSYSTEM,HOME,PATH,TZ');
  check('家目錄是給的空資料夾、UTC、不讀系統的 git 設定', env.HOME === '/tmp/x-home' && env.TZ === 'UTC' && env.GIT_CONFIG_NOSYSTEM === '1', JSON.stringify(env));
  eq('PATH 第一個是 node 所在的資料夾(npm 跟它放一起)', env.PATH.split(':')[0], '/opt/node/bin');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  eq('npm run test:clean 指到這一支', pkg.scripts?.['test:clean'], 'node scripts/clean-run.mjs');
  check('手冊(AGENTS.md)寫了推上 GitHub 之前跑它', /推上 GitHub 之前[\s\S]{0,40}npm run test:clean/.test(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')));
  check('主任技能:手冊寫「推之前」要做的,排在推的前一步', readFileSync(join(ROOT, 'skills', 'director', 'SKILL.md'), 'utf8').includes('手冊寫「推之前」要做的'));
}

section('AC-8:乾淨副本在 worktree 裡也 clone 得起來——git 給的共用資料夾在 worktree 裡是絕對路徑,硬接就是一條不存在的路', 'P13');
{
  // 寫的時候真的跑一次才發現:在 worktree 裡一次都 clone 不起來(共用資料夾的路徑接錯)。worktree 正是 app 給每個對話的那一種資料夾
  const w = world();
  let c = null, err = null;
  try { c = cloneAt(w.wt, 'HEAD'); } catch (e) { err = e.message; }
  check('在 worktree 裡也 clone 得出來,版本就是那個存檔', !!c && out(c.copy, 'rev-parse', 'HEAD') === out(w.wt, 'rev-parse', 'HEAD'), err ?? '');
  check('……副本在短的暫存路徑底下(真實路徑:不走 /tmp 那個捷徑)', /^\/(private\/)?tmp\/pmc-/.test(c?.base ?? ''), c?.base ?? err);
  // 第一次叫 repo:舊接法認自己的接點看指令裡有沒有專案的名字,掛感測器那一支紅一整片(GitHub 的機器上資料夾就叫專案的名字)
  eq('……副本的資料夾照專案的名字取(跟 GitHub 的機器一樣)', basename(c?.copy ?? ''), basename(w.mainDir));
  if (c) rmSync(c.base, { recursive: true, force: true });
  let why = null;
  try { cloneAt(w.wt, 'no-such-version'); } catch (e) { why = e.message; }
  check('認不出的版本 → 講認不出(沒跑,不是紅了)', /認不出版本「no-such-version」/.test(why ?? ''), why);
  w.cleanup();
}

process.exit(summary());
