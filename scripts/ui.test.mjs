/**
 * ui.test.mjs —— 只釘畫面「會安靜說謊」的那幾條（AC-1／AC-2／AC-8）
 *
 * ⚠️ 刻意**不測長相**。樣式壞了看得見;下面這幾條壞了畫面照跑、測試全綠,
 *    而使用者會照著三小時前的資料做決定。
 */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { describeFreshness, STALE_AFTER_SECONDS } from '../lib/freshness.mjs';
import { createApp } from '../server.mjs';
import { SUGGEST_TOOL, sessionView } from '../lib/rounds.mjs';
import { changeScope, STAMP_HELP, GREEN_IS_NOT_CORRECT } from '../lib/scope.mjs';
import { tierLines } from '../lib/tier.mjs';
import { cardLines, screenStages } from '../lib/collect.mjs';
import { stageLine } from '../lib/stageLines.mjs';
import { RETAIN_DAYS } from '../lib/events.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = new Date('2026-09-10T10:00:00Z').getTime();

section('AC-1：畫面必須隨時說出「這些資料是什麼時候的」');
{
  const fresh = describeFreshness({ generatedAt: T0, now: T0 + 3000, connected: true });
  eq('剛拿到 → fresh', fresh.state, 'fresh');
  check('說得出幾秒前', fresh.label.includes('3 秒前'), fresh.label);
  check('fresh 不變灰', fresh.dim === false);

  const stale = describeFreshness({
    generatedAt: T0, now: T0 + (STALE_AFTER_SECONDS + 1) * 1000, connected: true });
  eq(`超過 ${STALE_AFTER_SECONDS} 秒 → stale`, stale.state, 'stale');
  check('明講「可能過期了」', stale.label.includes('過期'), stale.label);
  check('stale 要變灰', stale.dim === true);
}

section('AC-1：沒有時間戳的時候不准假裝資料是新的');
{
  const u = describeFreshness({ generatedAt: NaN, now: T0, connected: true });
  eq('沒有時間戳 → unknown(不是 fresh)', u.state, 'unknown');
  check('說「不知道」', u.label.includes('不知道'), u.label);
  check('要變灰', u.dim === true);
}

section('AC-1：時鐘被調過(筆電睡醒)不准印出負數的「-5 秒前」');
{
  const back = describeFreshness({ generatedAt: T0, now: T0 - 60_000, connected: true });
  eq('時間倒退 → unknown', back.state, 'unknown');
  check('說「時間對不上」,不編一個看起來正常的數字', back.label.includes('對不上'), back.label);
}

section('AC-2：斷線時整頁都要承認,不准靜靜停止更新');
{
  const d = describeFreshness({ generatedAt: T0, now: T0 + 9000, connected: false });
  eq('連不上 → disconnected', d.state, 'disconnected');
  check('文案明講「連不上了」', d.label.includes('連不上'), d.label);
  check('而且要說出那份舊資料是什麼時候的', /\d\d:\d\d/.test(d.label), d.label);
  check('要變灰', d.dim === true);
  // ⚠️ 最重要的一條:斷線時**絕對不准**回 fresh。
  check('斷線時永遠不可能是 fresh',
    ['fresh'].includes(d.state) === false);
}

section('AC-8：畫面不准把「進度百分比」秀給使用者看', 'P4');
{
  // ⚠️ L10 第 3 次的修正:第一版掃到 `width: 100%`、`border-radius: 50%`、
  //    漸層的 `70%`——**那些是版面長度,不是給人看的進度**。
  //    CSS 的百分比一律不算違規;要抓的是「輸出到畫面上的字串裡有百分比」
  //    以及 <progress> 這種元件。
  const violates = (line) => {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return false;
    if (/<progress\b/i.test(line)) return true;
    // 只看字串字面量與樣板字串裡的百分比(那才會被印給人看)
    for (const m of line.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      if (/\d\s*%|\$\{[^}]*\}\s*%|進度|百分比/.test(m[2])) return true;
    }
    return false;
  };
  for (const f of ['ui/app.js', 'ui/index.html']) {
    const hits = readFileSync(join(ROOT, f), 'utf8').split('\n')
      .map((l, i) => [i + 1, l]).filter(([, l]) => violates(l));
    check(`${f} 沒有把進度百分比印給使用者`, hits.length === 0,
      hits.map(([n, l]) => `${n}: ${l.trim()}`).join('\n      '));
  }
  // 反向確認:這條檢查抓得到真的違規,也不會誤殺 CSS 長度
  check('會抓到 `完成 87%` 這種字串', violates('el.textContent = "完成 87%";'));
  check('會抓到樣板字串算出來的百分比', violates('html += `${pct}% 完成`;'));
  check('不會誤殺 width: 100%', !violates('  width: 100%;'));
  check('不會誤殺漸層的 70%', !violates('background: radial-gradient(circle, var(--x), transparent 70%);'));
}

section('AC-7：伺服器只綁 127.0.0.1');
{
  const src = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  check("HOST 寫死 127.0.0.1", /const HOST = '127\.0\.0\.1'/.test(src));
  check('沒有對外綁定的開關(不准有 0.0.0.0)', !src.includes('0.0.0.0'));
}

section('只綁 127.0.0.1 不夠(L28):網址不是 127.0.0.1／localhost 的不理(擋 DNS 重新綁定);按鈕只收這一頁自己送的;不准被別的網頁框起來', 'P3');
{
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'logs'));
  const server = createApp({ monitorDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  // fetch 不准自己改 Host(瀏覽器也不准)——假冒別的網址只能用 node:http 直接送,跟 DNS 重新綁定之後瀏覽器送出來的一樣
  const send = (method, path, headers, body = null) => new Promise((resolve, reject) => {
    const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: b }));
    });
    rq.on('error', reject);
    if (body) rq.write(body);
    rq.end();
  });
  const evil = await send('GET', '/api/status', { host: `evil.example:${port}` });
  eq('別的網址(Host: evil.example)要資料 → 403', evil.code, 403);
  check('……而且一個字的資料都沒給', !evil.body.includes('projects'), evil.body.slice(0, 80));
  eq('別的網址要首頁 → 403', (await send('GET', '/', { host: `evil.example:${port}` })).code, 403);
  eq('用 127.0.0.1 打開 → 200', (await send('GET', '/api/status', { host: `127.0.0.1:${port}` })).code, 200);
  eq('用 localhost 打開 → 200', (await send('GET', '/', { host: `localhost:${port}` })).code, 200);

  const close = (origin, host = `127.0.0.1:${port}`) => send('POST', '/api/close',
    { host, 'content-type': 'application/json', ...(origin ? { origin } : {}) }, JSON.stringify({ project: 'p', session: 's1' }));
  const logged = () => existsSync(join(monitorDir, 'logs', 'p.jsonl'));
  eq('同一台電腦別的埠(localhost:5173,像開發伺服器)送來的按鈕 → 403', (await close('http://localhost:5173')).code, 403);
  eq('外部網站送來的按鈕 → 403', (await close('https://evil.example')).code, 403);
  eq('沙盒裡的網頁(Origin: null)送來的 → 403', (await close('null')).code, 403);
  check('被擋下的一筆都沒寫進紀錄', !logged());
  const own = await close(`http://127.0.0.1:${port}`);
  eq('這一頁自己送的 → 200', own.code, 200);
  check('……真的記下了', logged());
  eq('用 localhost 打開的這一頁送的也算自己 → 200', (await close(`http://localhost:${port}`, `localhost:${port}`)).code, 200);
  eq('按鈕的回覆有標 JSON(以前 content-type 被 Node 當成狀態列的字)', own.headers['content-type'], 'application/json; charset=utf-8');

  const home = await send('GET', '/', { host: `127.0.0.1:${port}` });
  eq('不准被別的網頁框起來(X-Frame-Options)', home.headers['x-frame-options'], 'DENY');
  check("……新的瀏覽器看的那一條也有(frame-ancestors 'none')", /frame-ancestors 'none'/.test(home.headers['content-security-policy'] ?? ''), home.headers['content-security-policy']);
  eq('不准瀏覽器自己猜檔案類型', home.headers['x-content-type-options'], 'nosniff');
  server.close();
  rmSync(monitorDir, { recursive: true, force: true });
}

section('API 回的東西一定要帶伺服器產生的時間戳(AC-1 的來源)');
{
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port, address } = server.address();
  eq('實際綁定位址是 127.0.0.1', address, '127.0.0.1');
  const res = await fetch(`http://127.0.0.1:${port}/api/status`);
  const json = await res.json();
  eq('HTTP 200', res.status, 200);
  check('有 generatedAt,而且是伺服器給的數字',
    Number.isFinite(json.generatedAt) && Math.abs(Date.now() - json.generatedAt) < 60_000);
  check('有 projects 陣列', Array.isArray(json.projects));
  server.close();
}

section('退出按鈕只准對儀表板列得出來的專案動手（root 是瀏覽器送來的字串）');
{
  // 造一個假的 monitor 資料夾,裡面一個案件(靠章讓它出現)
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const out = (...a) => execFileSync('git', a, { cwd: r.dir, encoding: 'utf8' }).trim();
  const root = out('rev-parse', '--show-toplevel');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'checkpoints'));
  const branch = out('rev-parse', '--abbrev-ref', 'HEAD');   // 章照真的分支名寫,不寫死 main(GitHub 的機器預設 master,L24 的第二次)
  writeFileSync(join(monitorDir, 'checkpoints', `${basename(root)}__${branch}.json`), JSON.stringify({
    commit: out('rev-parse', 'HEAD'), branch, worktree: root, at: new Date().toISOString(), checks: ['test'],
  }));
  const server = createApp({ monitorDir });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/optout`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const stranger = mkdtempSync(join(tmpdir(), 'pm-stranger-'));
  eq('不認識的資料夾 → 400,不寫檔', (await post({ root: stranger })).status, 400);
  check('陌生資料夾裡真的沒被放東西', !existsSync(join(stranger, '.claude')));
  eq('認識的專案 → 200', (await post({ root })).status, 200);
  check('記號檔真的放了', existsSync(join(root, '.claude', 'pipeline-monitor.off')));
  eq('重新加入 → 200', (await post({ root, undo: true })).status, 200);
  check('記號檔拿掉了', !existsSync(join(root, '.claude', 'pipeline-monitor.off')));
  server.close();
  for (const d of [monitorDir, stranger]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('調高分級的按鈕:只准對認識的工作區、只准往上、理由必填;收回只收回自己調的');
{
  const r = makeRepo({ pkg: { name: 'x' }, files: { 'src/a.js': '1\n', 'README.md': 'r\n' } });
  const out = (...a) => execFileSync('git', a, { cwd: r.dir, encoding: 'utf8' }).trim();
  const root = out('rev-parse', '--show-toplevel');
  const name = basename(root);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'pipeline-stages.json'), JSON.stringify({ tiers: { code: ['src/'], danger: [] } }));
  writeFileSync(join(root, 'src', 'a.js'), '2\n');   // 碰到程式區 → 機器算第二級
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'checkpoints')); mkdirSync(join(monitorDir, 'logs'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));   // 三級的預設值住在這裡
  const branch = out('rev-parse', '--abbrev-ref', 'HEAD');   // 章照真的分支名寫,不寫死 main(GitHub 的機器預設 master,L24 的第二次)
  writeFileSync(join(monitorDir, 'checkpoints', `${name}__${branch}.json`), JSON.stringify({
    commit: out('rev-parse', 'HEAD'), branch, worktree: root, at: new Date().toISOString(), checks: ['test'],
  }));
  const server = createApp({ monitorDir });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/tier`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const tier = async () => (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json())
    .projects.find((x) => x.name === name)?.cards?.[0]?.tier;
  eq('機器算第二級(碰到程式區)', (await tier())?.machine?.id, 'T1');
  eq('不認識的工作區 → 400', (await post({ project: name, cwd: '/不存在', level: 'T2', why: 'x' })).status, 400);
  eq('沒理由 → 400', (await post({ project: name, cwd: root, level: 'T2', why: '  ' })).status, 400);
  eq('調到不比機器高的 → 400', (await post({ project: name, cwd: root, level: 'T1', why: 'x' })).status, 400);
  eq('T2 ＋ 理由 → 200', (await post({ project: name, cwd: root, level: 'T2', why: '重寫了整個上傳流程' })).status, 200);
  const after = await tier();
  check('畫面上變成「你說 T2」,機器算的還是 T1', after?.manual?.id === 'T2' && after?.machine?.id === 'T1', JSON.stringify(after?.manual));
  eq('收回 → 200', (await post({ project: name, cwd: root, retract: true })).status, 200);
  eq('收回後沒有你說的', (await tier())?.manual, null);
  eq('再收回一次 → 400(沒有東西可以收)', (await post({ project: name, cwd: root, retract: true })).status, 400);
  const log = readFileSync(join(monitorDir, 'logs', `${name}.jsonl`), 'utf8');
  check('紀錄裡兩行都是 source:human', log.includes('"event":"tier_set"') && log.includes('"event":"tier_retracted"') && !log.includes('"source":"sensor"'));
  check('沒有寫進真的 logs/', !existsSync(join(ROOT, 'logs', `${name}.jsonl`)));
  server.close();
  rmSync(monitorDir, { recursive: true, force: true });
  r.cleanup();
}

section('「你說驗收過了」按鈕:只准認識的工作區、只准驗收那一關(其他關自動辨識,AC-10);「不做了」只准認識的建議');
{
  const r = makeRepo({ pkg: { name: 'x' }, files: { 'a.js': '1\n' } });
  const out = (...a) => execFileSync('git', a, { cwd: r.dir, encoding: 'utf8' }).trim();
  const root = out('rev-parse', '--show-toplevel');
  const name = basename(root);
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'logs'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const ts = new Date().toISOString();
  writeFileSync(join(monitorDir, 'logs', `${name}.jsonl`), [
    JSON.stringify({ ts, hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1', cwd: root }),
    JSON.stringify({ ts, hook: 'PreToolUse', tool: 'mcp__Claude_Browser__navigate', session: 's1', cwd: root }),
    JSON.stringify({ ts, event: 'suggestion', id: 'sg-9', title: 't', prompt: 'p', cwd: root, source: 'claude' }),
    // app 對話裡叫出來的建議卡(感測器記的 PreToolUse):代號是 use_id,「不做了」也要收得掉它
    JSON.stringify({ ts, hook: 'PreToolUse', tool: SUGGEST_TOOL, use_id: 'toolu_9', session: 's1', cwd: root, in_title: 'app 的卡', in_tldr: '說明', in_prompt: '要貼的話' }),
  ].join('\n') + '\n');
  const server = createApp({ monitorDir });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  eq('不認識的工作區 → 400', (await post('/api/clear', { project: name, cwd: '/沒有', stage: 'D' })).status, 400);
  eq('B(對話本身)不能按 → 400', (await post('/api/clear', { project: name, cwd: root, stage: 'B' })).status, 400);
  eq('D 不能按 → 400(由儀表板自動辨識)', (await post('/api/clear', { project: name, cwd: root, stage: 'D' })).status, 400);
  eq('E → 200', (await post('/api/clear', { project: name, cwd: root, stage: 'E' })).status, 200);
  const st = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).projects.find((x) => x.name === name).cards[0].stages.find((s) => s.id === 'E');
  eq('按完 E 是 done(你說驗收過了)', st.state, 'done');
  eq('不認識的建議 → 400', (await post('/api/suggest-dismiss', { project: name, id: 'sg-x' })).status, 400);
  eq('認識的建議 → 200', (await post('/api/suggest-dismiss', { project: name, id: 'sg-9' })).status, 200);
  const sgs = async () => Object.fromEntries((await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).projects.find((x) => x.name === name).suggestions.map((s) => [s.id, s]));
  let sg = await sgs();
  check('建議標成不做了', !!sg['sg-9']?.dismissedAt);
  check('app 的建議卡也在清單上,而且還沒被收(在 app 按取消不會傳到這裡,只有這個按鈕會收)', sg.toolu_9?.source === 'app' && sg.toolu_9?.dismissedAt === null, JSON.stringify(sg.toolu_9));
  eq('app 的建議卡用 use_id 按「不做了」→ 200', (await post('/api/suggest-dismiss', { project: name, id: 'toolu_9' })).status, 200);
  sg = await sgs();
  check('app 的建議卡標成不做了,而且還在清單上(收起來不是刪掉)', !!sg.toolu_9?.dismissedAt);
  server.close();
  rmSync(monitorDir, { recursive: true, force: true }); r.cleanup();
}

section('兩個分頁同時開著也不准卡死:伺服器幾秒內算過的整頁資料共用一份(generatedAt 照實是那一次的),按了按鈕馬上作廢(2026-09-22 實測:兩個分頁各自每五秒要一次,回應一次要 15～19 秒)');
{
  const r = makeRepo({ pkg: { name: 'x' }, files: { 'a.js': '1\n' } });
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: r.dir, encoding: 'utf8' }).trim();
  const name = basename(root);
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'logs'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  writeFileSync(join(monitorDir, 'logs', `${name}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), hook: 'UserPromptSubmit', session: 's1', cwd: root, prompt: 'hi' }) + '\n');
  const server = createApp({ monitorDir });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async () => (await fetch(`${base}/api/status`)).json();
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const a = await get();
  const again = await get();
  eq('幾秒內再要一次 → 同一份(generatedAt 是那一次算的,不是現在)', again.generatedAt, a.generatedAt);
  const many = await Promise.all(Array.from({ length: 5 }, get));
  check('五個分頁同時要 → 共用同一份,不各算一次', many.every((x) => x.generatedAt === a.generatedAt), many.map((x) => x.generatedAt).join(','));
  eq('按鈕寫入被擋下(400:不認得的工作區)不作廢', (await post('/api/clear', { project: name, cwd: '/沒有這個工作區', stage: 'E' })).status, 400);
  eq('……之後拿到的還是同一份', (await get()).generatedAt, a.generatedAt);
  eq('按鈕寫入成功(結案這個對話)→ 200', (await post('/api/close', { project: name, session: 's1', cwd: root })).status, 200);
  const after = await get();
  check('寫入成功之後馬上重算:按了看得到(對話已結案),不是幾秒前那份', after.generatedAt > a.generatedAt && !!after.projects.find((x) => x.name === name)?.sessions.find((x) => x.id === 's1')?.closedAt, JSON.stringify({ g: after.generatedAt, a: a.generatedAt }));
  server.close();
  const quick = createApp({ monitorDir, statusShareMs: 30 });
  await new Promise((res) => quick.listen(0, '127.0.0.1', res));
  const qb = `http://127.0.0.1:${quick.address().port}`;
  const q1 = await (await fetch(`${qb}/api/status`)).json();
  await new Promise((res) => setTimeout(res, 80));
  const q2 = await (await fetch(`${qb}/api/status`)).json();
  check('過了共用的時間就重算(不會一直給舊的)', q2.generatedAt > q1.generatedAt, `${q1.generatedAt} → ${q2.generatedAt}`);
  quick.close();
  rmSync(monitorDir, { recursive: true, force: true }); r.cleanup();
}

section('畫面的輪詢:上一次回來才要下一次(不疊著要);伺服器卡住要放棄、照實說連不上,之後還要再問(真的跑 ui/app.js 的 poll／pollLoop)');
{
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  check('不再用 setInterval 固定每幾秒要一次(不管上一次回來了沒)', !/setInterval\(\s*poll\b/.test(src));
  const loop = loadPollLoop();
  check('從 ui/app.js 拿得出 poll 與 pollLoop(拿不出來這一段就什麼都沒測到)', typeof loop === 'function');
  if (typeof loop === 'function') {
    // 伺服器慢(每次 40 毫秒才回),畫面每 5 毫秒就想問一次:同一時間在路上的請求不准超過一個
    const slow = await loop({ mode: 'slow', POLL_MS: 5, GIVE_UP_MS: 1000, runMs: 400 });
    eq('伺服器慢的時候,同一時間最多一個請求在路上', slow.maxInflight, 1);
    check('……而且一直有在問(不是問一次就停)', slow.calls >= 4, `問了 ${slow.calls} 次`);
    check('……拿到資料就是連得上', slow.connectedSeen.includes(true));
    // 伺服器卡住、永遠不回:等到盡頭就放棄,說連不上,然後繼續問(伺服器好了才接得回來)
    const hung = await loop({ mode: 'hung', POLL_MS: 5, GIVE_UP_MS: 30, runMs: 200 });
    check('伺服器不回 → 放棄那一次,說連不上', hung.connectedSeen.includes(false), JSON.stringify(hung));
    check('……放棄之後還會再問(不會停在那裡)', hung.calls >= 3, `問了 ${hung.calls} 次`);
    eq('……同一時間也最多一個請求在路上', hung.maxInflight, 1);
  }
}

/**
 * 把 ui/app.js 的 poll 與 pollLoop **原封不動**拿出來,配上假的 fetch 與計時器跑一段時間(L20:畫面的程式跑在瀏覽器裡,測試沒真的跑過就等於沒測)。
 * mode:slow = 每次 40 毫秒才回;hung = 永遠不回,只有被放棄(abort)才結束。回:問了幾次、同一時間最多幾個在路上、看過哪些連線狀態。
 */
function loadPollLoop() {
  const text = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const poll = text.match(/^async function poll\(\) \{\n[\s\S]*?\n\}\n/m);
  const loop = text.match(/^async function pollLoop\(\) \{\n[\s\S]*?\n\}\n/m);
  if (!poll || !loop) return null;
  return async ({ mode, POLL_MS, GIVE_UP_MS, runMs }) => {
    let calls = 0, inflight = 0, maxInflight = 0, stop = false;
    const connectedSeen = [];
    const fakeFetch = (url, { signal } = {}) => new Promise((resolve, reject) => {
      calls++; inflight++; maxInflight = Math.max(maxInflight, inflight);
      let settled = false;
      const end = (fn) => { if (settled) return; settled = true; inflight--; fn(); };
      signal?.addEventListener('abort', () => end(() => reject(new Error('放棄了'))));
      if (mode === 'slow') setTimeout(() => end(() => resolve({ ok: true, json: async () => ({ generatedAt: Date.now(), projects: [] }) })), 40);
    });
    const later = (fn, ms) => (stop ? 0 : setTimeout(fn, ms));
    const make = new Function('POLL_MS', 'GIVE_UP_MS', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController', 'document', 'location', 'safeRender', 'paintFreshness',
      `const zhEn = (zh) => zh;\nconst LANG = 'zh';\nlet latest = null, connected = false, bootVersion = null;\n${poll[0]}\n${loop[0]}\nreturn { pollLoop, connected: () => connected };`);
    let api;
    const paint = () => connectedSeen.push(api?.connected());
    api = make(POLL_MS, GIVE_UP_MS, fakeFetch, later, clearTimeout, AbortController, { activeElement: null }, { reload() {} }, () => {}, paint);
    api.pollLoop();
    await new Promise((res) => setTimeout(res, runMs));
    stop = true;
    await new Promise((res) => setTimeout(res, Math.max(60, GIVE_UP_MS + 20)));
    return { calls, maxInflight, connectedSeen: [...new Set(connectedSeen)] };
  };
}

/**
 * 把 ui/app.js 裡的 suggestionsBlock **原封不動**拿出來跑(L20:畫面的程式跑在瀏覽器裡,十幾支測試全綠也沒有一支真的畫過)。
 * 這個函式不碰 DOM,補上它用到的五個外部名字就能在 node 裡跑。拿不出來要紅——不准安靜地跳過。
 * ⚠️ 不把它搬成獨立的檔案給兩邊 import:常駐的儀表板服務只送它啟動那一刻白名單裡的檔案,多一個新檔,更新後沒重啟的那段時間整個畫面會載不進來。
 */
function loadSuggestionsBlock(latest) {
  const m = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8').match(/^function suggestionsBlock\(p\) \{\n[\s\S]*?\n\}\n/m);
  if (!m) return null;
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = (iso) => (iso ? '3 分鐘前' : '');
  const clock = (iso) => (Number.isFinite(new Date(iso).getTime()) ? '9/17 12:00' : '時間對不上');
  return new Function('esc', 'ago', 'clock', 'foldOpen', 'latest', `const zhEn = (zh) => zh;\n${m[0]}; return suggestionsBlock;`)(esc, ago, clock, () => false, latest);
}
const TS = '2026-09-17T04:00:00Z';
const sgCard = (o) => ({ id: 'toolu_1', ts: TS, source: 'app', title: '修徽章', tldr: '一句說明', prompt: '要貼的話', cwd: '/x', session: 's1', target: null, cut: [],
  dismissedAt: null, startedBy: null, startedIn: null, openIn: null, startedTitle: null, startedProject: null, fromTitle: '提建議的對話', ...o });

section('建議新增的對話:一張卡都沒有也要畫這一區;伺服器沒回答不准講成「沒有」;要開在這裡的卡掛在別頁要指路（真的跑 ui/app.js 的 suggestionsBlock）', 'P5');
{
  const block = loadSuggestionsBlock({ retainDays: 90 });
  check('從 ui/app.js 拿得出 suggestionsBlock(拿不出來這一段就什麼都沒測到)', typeof block === 'function');
  if (typeof block === 'function') {
    const empty = block({ name: 'x', suggestions: [], appCardsSince: null, incomingSuggestions: [] });
    check('一張都沒有也畫這一區(沒有卡跟根本沒在記長得一樣,不准整區不見)', empty.includes('建議新增的對話'), empty.slice(0, 80));
    check('而且講「不代表沒跳過」,三種可能都講(含保留期限,天數是伺服器給的)', empty.includes('不代表沒跳過') && empty.includes('還沒重開的對話') && empty.includes('90 天'), empty);
    // 常駐服務跑的是它啟動那一刻的程式:更新後沒重啟,這支新畫面配到的是不認得 app 建議卡的舊資料(沒有 appCardsSince 這個欄位)
    const stale = loadSuggestionsBlock({})({ name: 'x', suggestions: [] });
    check('伺服器沒回答這一題(舊程式)→ 講真正的原因與下一步(--serve-restart)', stale.includes('--serve-restart'), stale);
    check('而且不准講成「紀錄裡沒有…不代表沒跳過」那三個理由——那三個都不是原因', !stale.includes('不代表沒跳過'), stale);
    const some = block({ name: 'x', suggestions: [sgCard()], appCardsSince: TS, incomingSuggestions: [] });
    check('有紀錄之後也要帶「還沒重開的對話裡跳的看不到」那半句', some.includes('開始有紀錄') && some.includes('還沒重開的對話'), some);
    const pointed = block({ name: 'x', suggestions: [], appCardsSince: null, incomingSuggestions: [{ project: 'other_repo', name: 'other repo', count: 2 }] });
    check('別的專案掛著 2 張要開在這裡的卡 → 這一頁指路過去', pointed.includes('2 張要開在這裡') && pointed.includes('#/p/other_repo'), pointed);
    // 程式的內部值漏到畫面上等於沒有畫面:缺欄位、怪欄位都餵一次
    const odd = [
      { name: 'x' }, { name: 'x', suggestions: null, appCardsSince: null },
      { name: 'x', suggestions: [{ id: 'a' }], appCardsSince: null },
      { name: 'x', suggestions: [sgCard({ title: undefined, tldr: null, prompt: '', ts: undefined, fromTitle: null, session: null })], appCardsSince: '壞掉的時間' },
      { name: 'x', suggestions: [sgCard({ cut: ['title', 'tldr', 'prompt', 'cwd'], openIn: { project: null, name: null } }), sgCard({ id: 'b', source: 'claude', tldr: null, session: null, fromTitle: null })], appCardsSince: TS },
      { name: 'x', suggestions: [sgCard({ startedBy: 's9', startedTitle: null })], appCardsSince: TS, incomingSuggestions: [{ project: 'o', name: null, count: 1 }] },
      { name: 'x', suggestions: [sgCard({ withdrawals: [{}, { ts: null, reason: undefined }] }), sgCard({ id: 'w2', withdrawals: null })], appCardsSince: TS },
    ];
    const leaks = odd.map((o) => block(o)).filter((html) => /undefined|NaN|\bnull\b|\[object/.test(html));
    check('缺欄位、怪欄位都不會把 undefined／NaN／null 印到畫面上', leaks.length === 0, leaks.map((h) => h.match(/.{30}(undefined|NaN|null|\[object).{30}/s)?.[0]).join('\n      '));
  }
}

section('建議新增的對話:app 換過做卡的工具、記到認不得的工具,畫面照紀錄裡的時間講;服務沒回答不准講成沒換過(規格:app建議卡換工具 AC-4、AC-5、AC-8)', 'P5');
{
  const OLD = '2026-10-13T00:00:00Z', NEW = '2026-10-26T00:00:00Z';
  const page = (tools, o = {}) => loadSuggestionsBlock({ retainDays: 90, appCardTools: tools })({ name: 'x', suggestions: [sgCard()], appCardsSince: TS, incomingSuggestions: [], ...o });
  const both = page({ oldLast: OLD, newFirst: NEW, unknown: [] });
  check('舊的、新的都記到過 → 講中間那段可能沒記到', both.includes('最後一次記到舊的是') && both.includes('第一次記到新的是') && both.includes('中間跳的卡可能沒記到'), both);
  const onlyOld = page({ oldLast: OLD, newFirst: null, unknown: [] });
  check('還沒記到新的 → 講「感測器還沒記到新的那一種」,不講成沒有新卡', onlyOld.includes('感測器還沒記到新的那一種') && onlyOld.includes('之後跳的卡可能都沒記到'), onlyOld);
  const never = page({ oldLast: null, newFirst: NEW, unknown: [] });
  check('從來沒用過舊工具的電腦 → 不講換工具', !never.includes('換過做建議卡的工具'), never);
  const empty = loadSuggestionsBlock({ retainDays: 90, appCardTools: { oldLast: null, newFirst: null, unknown: [] } })({ name: 'x', suggestions: [], appCardsSince: null, incomingSuggestions: [] });
  check('一張都沒有:「不代表沒跳過」多一個原因——app 換了做卡的工具、感測器還沒接上', empty.includes('不代表沒跳過') && empty.includes('app 換了做卡的工具而感測器還沒接上時跳的'), empty);
  const odd = page({ oldLast: null, newFirst: NEW, unknown: [{ tool: 'mcp__ccd_session__<b>propose</b>', first: NEW, count: 3 }] });
  check('記到認不得的工具 → 講名字、第一次的時間、可能是又換了工具', odd.includes('認不得的工具') && odd.includes('propose') && odd.includes('可能是 app 又換了做建議卡的工具'), odd);
  check('工具名是紀錄裡的字:一律跳脫', !odd.includes('<b>propose</b>'), odd);
  // 常駐的服務跑的是舊程式(有 appCardsSince、沒有 appCardTools):講服務的事,不准什麼都不說(看起來像沒換過工具)
  const stale = page(undefined);
  check('服務沒給這一欄 → 講服務還在跑舊的程式、講修法', stale.includes('服務還在跑舊的程式') && stale.includes('--serve-restart') && !stale.includes('換過做建議卡的工具：'), stale);
  // AC-4:照你的話開了先前提的某一張 → 卡上一行,不收卡
  const opened = page({ oldLast: null, newFirst: NEW, unknown: [] }, { suggestions: [sgCard({ opens: [{ ts: NEW }] })] });
  const line = opened.match(/<span class="smeta">⚠️[^<]*<\/span>/)?.[0] ?? '';
  check('卡上講「照你的話叫過 1 次開…」——分不出是不是這一張、看不到有沒有開成;不准寫成「開過」(記到的只是叫了,R2)', line.includes('照你的話叫過 1 次開') && line.includes('分不出要開的是不是這一張') && line.includes('看不到有沒有開成') && !line.includes('開過'), line || opened);
  check('卡照樣掛著、「不做了」還在,還掛著的才叫人按', opened.includes('data-dismiss=') && line.includes('按「不做了」'), line);
  const startedOpen = page({ oldLast: null, newFirst: NEW, unknown: [] }, { suggestions: [sgCard({ startedBy: 's9', startedTitle: '新對話', opens: [{ ts: NEW }] })] });
  const sLine = startedOpen.match(/<span class="smeta">⚠️[^<]*<\/span>/)?.[0] ?? '';
  check('已經收起來的卡:卡上不叫人去按一顆不存在的「不做了」', sLine.includes('照你的話叫過') && !sLine.includes('不做了'), sLine || startedOpen);
  const leaks = [page({}), page({ oldLast: '壞掉', newFirst: undefined, unknown: null }), page({ oldLast: null, newFirst: null, unknown: [{}] }), page(null, { suggestions: [sgCard({ opens: null })] })]
    .filter((html) => /undefined|NaN|\bnull\b|\[object/.test(html));
  check('缺欄位、怪欄位都不會把 undefined／NaN／null 印到畫面上', leaks.length === 0, leaks.map((h) => h.match(/.{30}(undefined|NaN|null|\[object).{30}/s)?.[0]).join('\n      '));
}

section('建議新增的對話:這一區看不到的那幾條路,畫面要明講;收起來的數字要自洽（真的跑 ui/app.js 的 suggestionsBlock）', 'P6');
{
  const block = loadSuggestionsBlock({ retainDays: 90 });
  check('從 ui/app.js 拿得出 suggestionsBlock', typeof block === 'function');
  if (typeof block === 'function') {
    const html = block({ name: 'x', appCardsSince: TS, incomingSuggestions: [], suggestions: [
      sgCard({ id: 'open1' }),
      sgCard({ id: 'both', startedBy: 's9', startedTitle: '照著開的對話', dismissedAt: TS }),   // 既已開始、又按過不做了:只能算一次
      sgCard({ id: 'gone', dismissedAt: TS }),
    ] });
    check('講得出「卡在 app 裡怎麼不見的(你按掉、被新卡擠掉),這裡看不到」', html.includes('你按掉、或被後來的新卡擠掉'), html.slice(0, 400));
    check('講得出「Claude 叫了收回會標在卡上,但分不出是哪一張」', html.includes('分不出是哪一張'), html.slice(0, 600));
    check('卡上不寫「你已取消」(AC-2:感測器看不到 app 的叉叉,那句話沒有任何證據)', !html.includes('取消'));
    check('收起來的 2 張 = 已開始 1 ＋ 你說不做了 1(同一張卡不算兩次)', html.includes('收起來的 2 張（已開始 1、你說不做了 1）'), html.match(/收起來的[^<]*/)?.[0]);
    check('還沒處理的那張有「不做了」按鈕,收起來的沒有', (html.match(/data-dismiss=/g) ?? []).length === 1);
    check('兩種來源各有一小行(AC-5)', block({ name: 'x', appCardsSince: TS, suggestions: [sgCard(), sgCard({ id: 'c', source: 'claude' })] }).includes('Claude 在對話裡提的建議卡')
      && block({ name: 'x', appCardsSince: TS, suggestions: [sgCard({ id: 'c', source: 'claude' })] }).includes('Claude 用 --suggest 放的'));
    check('被截短的卡標「已截短」,而且講完整的在哪(AC-4)', block({ name: 'x', appCardsSince: TS, suggestions: [sgCard({ cut: ['prompt'] })] }).includes('已截短'));
    // AC-7:Claude 叫過收回 → 卡上一行,附理由,不收卡、不說「已收回」「已取消」(記到的只是叫了收回)
    const wdHtml = block({ name: 'x', appCardsSince: TS, suggestions: [sgCard({ withdrawals: [{ ts: TS, reason: '已經在<b>這裡</b>做完', cut: true }, { ts: TS, reason: null, cut: false }] })] });
    check('卡上講「Claude 後來在這個對話裡叫過 2 次收回」', wdHtml.includes('叫過 2 次收回'), wdHtml);
    check('附 Claude 說的理由(被截的加…、沒寫的講沒寫)', wdHtml.includes('已經在&lt;b&gt;這裡&lt;/b&gt;做完…') && wdHtml.includes('（沒寫理由）'), wdHtml);
    check('理由是 Claude 寫的字:一律跳脫,不准變成網頁上的標籤', !wdHtml.includes('<b>這裡</b>'));
    check('講「分不出收回的是不是這一張」,不講「已收回」「已取消」', wdHtml.includes('分不出收回的是不是這一張') && !wdHtml.includes('已收回') && !wdHtml.includes('已取消'), wdHtml);
    check('卡照樣掛著、「不做了」還在(收回不會替你收)', wdHtml.includes('data-dismiss=') && !wdHtml.includes('收起來的'));
    const startedWd = block({ name: 'x', appCardsSince: TS, suggestions: [sgCard({ startedBy: 's9', startedTitle: '照著開的對話', withdrawals: [{ ts: TS, reason: '做完了', cut: false }] })] });
    // 只看卡上那一行(區塊上方的說明文字本來就講「按不做了」,那是給還掛著的卡看的)
    const wdLine = startedWd.match(/<span class="smeta">⚠️[^<]*<\/span>/)?.[0] ?? '';
    check('已經收起來的卡也標收回,但卡上不叫人去按一顆不存在的「不做了」', wdLine.includes('叫過 1 次收回') && !wdLine.includes('不做了') && !startedWd.includes('data-dismiss='), wdLine || startedWd);
    const openLine = wdHtml.match(/<span class="smeta">⚠️[^<]*<\/span>/)?.[0] ?? '';
    check('還掛著的卡,卡上那一行才叫人按「不做了」', openLine.includes('按「不做了」'), openLine);
    const many = block({ name: 'x', appCardsSince: TS, suggestions: [sgCard({ withdrawals: [1, 2, 3, 4, 5].map((n) => ({ ts: TS, reason: `理由${n}`, cut: false })) })] });
    check('收回很多次:只列前 3 個理由,講共幾次', many.includes('叫過 5 次收回') && many.includes('理由3') && !many.includes('理由4') && many.includes('等 5 次'), many);
    const dismissedWd = block({ name: 'x', appCardsSince: TS, suggestions: [sgCard({ dismissedAt: TS, withdrawals: [{ ts: TS, reason: '做完了', cut: false }] })] });
    const dismissedLine = dismissedWd.match(/<span class="smeta">⚠️[^<]*<\/span>/)?.[0] ?? '';
    check('你按過「不做了」的卡也一樣:卡上不叫你再去按一次', dismissedLine.includes('叫過 1 次收回') && !dismissedLine.includes('不做了'), dismissedLine || dismissedWd);
    check('空的卡講「這張卡沒有內容」,不是不畫(混沌推導:輸入畸形)', block({ name: 'x', appCardsSince: TS, suggestions: [sgCard({ tldr: null, prompt: '' })] }).includes('這張卡沒有內容'));
  }
}

section('當場問的卡(規格:當場問的卡也收進來 AC-1、AC-2、AC-4、AC-5、AC-6):卡上的字只講看得到的——不寫「問過你」、看不到你按了哪個鈕就講看不到、湊的那段不寫成 Claude 寫的;收起來的數字自洽（真的跑 ui/app.js 的 suggestionsBlock）', 'P10');
{
  const block = loadSuggestionsBlock({ retainDays: 90, appCardTools: { oldLast: '2026-10-13T00:00:00Z', newFirst: '2026-10-25T00:00:00Z', unknown: [] } });
  check('從 ui/app.js 拿得出 suggestionsBlock', typeof block === 'function');
  if (typeof block === 'function') {
    const SAID = { ts: TS, text: 'JPG 報告卡那一條\n幫我開一張建議卡', cut: false };
    const COMPOSED = '學生頁：JPG 報告卡還在傳\n\n這件事原本在「提建議的對話」那個對話裡提過。\n你那時說：「JPG 報告卡那一條 幫我開一張建議卡」';
    const offer = (o = {}) => sgCard({ id: 'toolu_offer', ask: 'offer', title: '學生頁：JPG 報告卡還在傳', tldr: null, prompt: COMPOSED, said: SAID, brief: null, workedAfter: null, supersededAt: null, ...o });
    const one = (o) => block({ name: 'x', appCardsSince: TS, incomingSuggestions: [], suggestions: [offer(o)] });
    const bare = one();
    check('卡上寫「Claude 叫了當場問你要不要開的卡」,不寫「問過你」(app 可能根本沒跳出來,R2)', bare.includes('Claude 叫了當場問你要不要開的卡') && !bare.includes('問過你'), bare);
    check('看不到你按了哪個鈕 → 講看不到;不寫「你沒回答」「你取消了」', bare.includes('看不到你按了哪個鈕') && !bare.includes('你沒回答') && !bare.includes('取消'), bare);
    check('…也講看不到卡有沒有真的跳出來(app 可能拒絕,D 第一輪,R2)', bare.includes('也看不到卡有沒有真的跳出來'), bare);
    check('附你那時說的話(換行壓成空白)', bare.includes('你那時說：「JPG 報告卡那一條 幫我開一張建議卡」'), bare);
    check('湊的那段講明是監視器湊的,不是 Claude 寫的說明;不冒充「要貼的話」', bare.includes('監視器照標題湊的，不是 Claude 寫的說明') && !bare.includes('要貼的話：'), bare);
    check('複製拿到的就是伺服器湊的那段(畫面不自己湊)', bare.includes(`data-copy="${COMPOSED}"`) && bare.includes('複製監視器湊的話'), bare);
    check('還掛著:有「不做了」', bare.includes('data-dismiss='));
    const cut = one({ said: { ts: TS, text: '字'.repeat(200), cut: true } });
    check('你那時說的話被截過 → 加…', cut.includes('…」'), cut);
    const noSaid = one({ said: null });
    check('紀錄裡看不到你那時說的話 → 講看不到,不印空的引號', noSaid.includes('紀錄裡看不到你在那之前說的話') && !noSaid.includes('「」'), noSaid);
    // AC-2:有下文、找不到照它開的對話
    const follow = one({ brief: { ts: TS, via: 'followup' }, tldr: '背景說明', prompt: '補說明要貼的話' });
    check('補了說明、找不到照它開的對話 → 照實講,卡照樣掛著', follow.includes('Claude 補了開新對話的說明，但找不到照它開的對話') && follow.includes('data-dismiss='), follow);
    check('…有下文就不講湊的那段,要貼的話照補說明', !follow.includes('監視器照標題湊的') && follow.includes('要貼的話：補說明要貼的話') && follow.includes('複製說明'), follow);
    const same = one({ brief: { ts: TS, via: 'same-title' }, tldr: '背景說明', prompt: '直接開的要貼的話' });
    check('後來同名直接開、找不到照它開的對話 → 照實講', same.includes('Claude 後來叫了同名的卡、直接開對話，但找不到照它開的對話'), same);
    const started = one({ brief: { ts: TS, via: 'followup' }, tldr: '背景說明', prompt: '補說明要貼的話', startedBy: 's9', startedTitle: '照卡開的對話' });
    check('認得出已開始 → 收起來,不講「找不到」', started.includes('已開始：') && !started.includes('找不到照它開的對話') && !started.includes('data-dismiss='), started);
    // AC-5:接著動工只是提示
    const worked = one({ workedAfter: TS });
    check('Claude 接著動了工 → 講「可能是你選了在這裡做」,卡照樣掛著', worked.includes('可能是你選了在這裡做') && worked.includes('data-dismiss='), worked);
    check('…收起來的卡不講這一句', !one({ workedAfter: TS, dismissedAt: TS }).includes('可能是你選了在這裡做'));
    // 收起來的數字:每張只算一種(已開始 → 後來又提了同名的卡 → 你說不做了)
    const html = block({ name: 'x', appCardsSince: TS, incomingSuggestions: [], suggestions: [
      offer({ id: 'o1' }),
      offer({ id: 'o2', supersededAt: TS }),
      offer({ id: 'o3', supersededAt: TS, dismissedAt: TS }),   // 後來同名、又按過不做了:只算一次
      offer({ id: 'o4', startedBy: 's9', startedTitle: '照卡開的對話', supersededAt: TS }),
      sgCard({ id: 'g1', dismissedAt: TS }),
    ] });
    check('收起來的 4 張 = 已開始 1 ＋ 後來又提了同名的卡 2 ＋ 你說不做了 1', html.includes('收起來的 4 張（已開始 1、後來又提了同名的卡 2、你說不做了 1）'), html.match(/收起來的[^<]*/)?.[0]);
    check('後來同名的那張:卡上講看那一張,沒有「不做了」按鈕', html.includes('後來同一個對話又提了一張同名的卡') && (html.match(/data-dismiss=/g) ?? []).length === 1, html.match(/data-dismiss="[^"]*"/g)?.join(','));
    check('沒有同名的時候,摘要不多一個 0', !block({ name: 'x', appCardsSince: TS, suggestions: [sgCard({ dismissedAt: TS })] }).includes('後來又提了同名的卡'));
    // AC-6:卡區的說明
    check('「這一區看不到的」講當場問的卡也在這裡、看不到你按了哪個鈕、選了在這裡做要自己按不做了', html.includes('當場問你要不要開的卡也在這裡，但看不到你按了哪個鈕；選了在這裡做的，要自己按<b>不做了</b>'), html);
    check('換過工具那一句補半句:那時已經開著、之後沒重開的對話裡跳的也可能沒記到', html.includes('那時已經開著、之後沒重開的對話裡跳的，也可能沒記到'), html);
    // 怪的值(舊的服務、壞掉的欄位):不准印出內部值;沒有湊好的那段就不提「複製」
    const odd = [offer({ said: {} }), offer({ said: { text: 42 } }), offer({ brief: {} }), offer({ said: undefined, brief: undefined, workedAfter: undefined, supersededAt: undefined }), offer({ prompt: undefined })];
    const leaks = odd.map((o) => block({ name: 'x', appCardsSince: TS, suggestions: [o] })).filter((h) => /undefined|NaN|\bnull\b|\[object/.test(h));
    check('缺欄位、怪欄位都不會把 undefined／NaN／null 印到畫面上', leaks.length === 0, leaks.map((h) => h.match(/.{30}(undefined|NaN|null|\[object).{30}/s)?.[0]).join('\n      '));
    const noPrompt = block({ name: 'x', appCardsSince: TS, suggestions: [offer({ prompt: '' })] });
    check('沒有湊好的那段(舊的服務)→ 沒有複製鈕,也不講「複製拿到的…」', !noPrompt.includes('data-copy=') && !noPrompt.includes('「複製」拿到'), noPrompt);
  }
}

section('分級卡與存檔與蓋章卡:只看得到還沒存的時候不畫「沒有改動」那張綠臉(真的跑 ui/app.js 的 statTier／statChanges;規格:這一輪的起點 AC-4、AC-5,先講commit再講蓋章 AC-5)', 'P5');
{
  // 跟 suggestionsBlock 同一種做法:原封不動拿出來跑,補上它們用到的外部名字。拿不出來要紅——不准安靜地跳過(L20)
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const pick = (name, sig) => src.match(new RegExp(`^function ${name}\\(${sig}\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const one = (name) => src.match(new RegExp(`^const ${name} = .*;$`, 'm'))?.[0] ?? null;
  const code = [one('OLD_LINE'), one('mark'), pick('statChanges', 'c'), pick('statTier', 'c, p')];
  check('從 ui/app.js 拿得出 statChanges、statTier(拿不出來這一段就什麼都沒測到)', code.every(Boolean));
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = (iso) => (iso ? '3 分鐘前' : '');
  const cpOk = (c) => !!c?.checkpoint && c?.checkpointRelation?.state === 'ok';
  // foldOpen:檔名清單收起來的記憶(工地工班風畫面 AC-13),這裡一律當沒記過;latest:最上層的 stampHelp(commit 跟蓋章差在哪),照伺服器的做法給
  const ui = code.every(Boolean) ? new Function('esc', 'ago', 'cpOk', 'foldOpen', 'latest', `const zhEn = (zh) => zh;\n${code.join('\n')}; return { statChanges, statTier };`)(esc, ago, cpOk, () => false, { stampHelp: STAMP_HELP }) : null;
  const empty = { total: 0, newCount: 0, uncommittedCount: 0, groups: [], unsaved: { count: 0, groups: [] }, saved: { count: 0, groups: [] } };
  // 分級卡的那幾句是伺服器照 lib/tier.mjs 的 tierLines 算好的(lines;規格:終端機與網頁說同一句)——這裡照伺服器的做法附上
  const unseen = { state: 'unseen', basis: { kind: 'head', why: 'not-found', origin: null } };
  const blind = { path: '/x', files: empty, scope: changeScope({ kind: 'head', why: 'not-found', origin: null }, ago),
                  tier: { ...unseen, lines: tierLines(unseen, { ago }) } };
  const tierHtml = ui?.statTier(blind, { name: 'p' }) ?? '';
  const filesHtml = ui?.statChanges(blind) ?? '';
  check('分級卡:看不全、不是安全的綠臉、不寫「沒有改動」', /看不全/.test(tierHtml) && !/data-tone="safe"/.test(tierHtml) && !/沒有改動/.test(tierHtml), tierHtml);
  check('存檔與蓋章卡:都 commit 了,但 commit 過、還沒蓋章的看不到——講看不到,不寫「沒有改動」',
    /<div class="big">都 commit 了<\/div>/.test(filesHtml) && /這裡看不到（找不到這一輪開始時的版本）/.test(filesHtml) && !/沒有改動/.test(filesHtml), filesHtml);
  const moved = { path: '/x', files: empty, scope: changeScope({ kind: 'origin', why: null, moved: true, origin: { at: '2026-09-22T01:00:00Z', from: 'prompt', sessions: 1 } }, ago) };
  const movedHtml = ui?.statChanges(moved) ?? '';
  check('這一輪中間切過分支、現在跟開始時一樣:看不全,不寫「沒有改動」', /看不全/.test(movedHtml) && /切過分支/.test(movedHtml) && !/沒有改動/.test(movedHtml), movedHtml);
  const eight = changeScope({ kind: 'origin', why: null, commits: 8, origin: { at: '2026-09-22T01:00:00Z', from: 'A' } }, ago);
  const scaleHtml = ui?.statChanges({ path: '/x', scope: eight, scale: { median: 2, max: 20 }, lines: cardLines({ scale: { median: 2, max: 20 }, commitsNote: eight.commitsNote, dirty: 0 }),
    files: { total: 22, newCount: 0, uncommittedCount: 0, groups: [], unsaved: { count: 0, groups: [] }, saved: { count: 22, groups: [] } } }) ?? '';
  check('比例尺講「一次存檔」,而且講這裡是 8 次存檔加起來的(L6);收在「commit 跟蓋章差在哪？」裡',
    /<details class="why"[^>]*><summary>commit 跟蓋章差在哪？<\/summary>[\s\S]*一次存檔（commit）通常 2 個[\s\S]*8 次存檔加起來[\s\S]*<\/details>/.test(scaleHtml), scaleHtml);
  // 案件首頁(Oscar 第一個看到的畫面)也不准把「看不全」講成「沒有待檢查的檔案」
  const ovSrc = [pick('focusOf', 'p'), pick('overview', 'p')];
  check('從 ui/app.js 拿得出 focusOf、overview', ovSrc.every(Boolean));
  // overview 要讀伺服器給的保留天數(「N 天內沒有結案的對話」;規格:90天清空之後的說法 AC-3)
  // foldOpen:已結案收起來的記憶(工地工班風畫面 AC-1),這裡一律當沒記過
  const ov = ovSrc.every(Boolean) ? new Function('esc', 'ago', 'cpOk', 'latest', 'foldOpen', `const zhEn = (zh) => zh;\n${ovSrc.join('\n')}; return overview;`)(esc, ago, cpOk, { retainDays: RETAIN_DAYS }, () => false) : null;
  const ovCard = { path: '/x', ladder: { uncommitted: 0 }, checkpoint: null, files: empty, scope: blind.scope };
  const ovHtml = ov?.({ name: 'p', mainRoot: '/x', cards: [ovCard], sessions: [{ id: 's1', title: '調標籤', lastTs: '2026-09-22T01:00:00Z', closedAt: null, card: ovCard }] }) ?? '';
  check('案件首頁:看不全,不寫「沒有待檢查的檔案」', /看不全/.test(ovHtml) && !/沒有待檢查的檔案/.test(ovHtml), ovHtml.slice(0, 600));
  // 常駐服務還沒重啟(這一版以前的伺服器不給「還沒 commit 的是哪些」):不拿標了還沒存的那幾個硬湊(那一份會漏),講服務還在跑舊的程式
  const old = ui?.statChanges({ path: '/x', files: { total: 3, newCount: 0, uncommittedCount: 1, groups: [] }, scope: blind.scope }) ?? '';
  check('舊的服務沒給還沒 commit 的那一份:講服務還在跑舊的程式,不當掉、不湊數字(規格:先講commit再講蓋章 AC-10)',
    /服務還在跑舊的程式/.test(old) && !/class="num"/.test(old) && !/undefined|NaN|\bnull\b/.test(old), old);
  check('畫面不 import 新檔(常駐服務只送啟動那一刻白名單裡的檔案,多一個新檔,重啟之前整個畫面載不進來)',
    !/from '\/scope\.mjs'/.test(src) && [...src.matchAll(/^import .* from '([^']+)'/gm)].every((m) => m[1] === '/freshness.mjs'), [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).join(','));
}

section('存檔與蓋章卡:先講 commit 了沒,都 commit 了才講還沒蓋章;問不到不講成都 commit 了;不打勾、不變綠(真的跑 ui/app.js 的 statChanges;規格:先講commit再講蓋章 AC-1、AC-3~AC-8)', 'P10');
{
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const pick = (name, sig) => src.match(new RegExp(`^function ${name}\\(${sig}\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const one = (name) => src.match(new RegExp(`^const ${name} = .*;$`, 'm'))?.[0] ?? null;
  const code = [one('OLD_LINE'), one('mark'), pick('statChanges', 'c')];
  check('從 ui/app.js 拿得出 statChanges(拿不出來這一段就什麼都沒測到)', code.every(Boolean));
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = (iso) => (iso ? '3 分鐘前' : '');
  const draw = code.every(Boolean) ? new Function('esc', 'ago', 'foldOpen', 'latest', `const zhEn = (zh) => zh;\n${code.join('\n')}; return statChanges;`)(esc, ago, () => false, { stampHelp: STAMP_HELP }) : () => '';
  const g = (dir, ...names) => ({ dir, items: names.map((n) => ({ name: n, isNew: n.startsWith('new'), uncommitted: null })) });
  const many = (n, p = 'f') => Array.from({ length: n }, (_, i) => `${p}${i}.md`);
  const fl = ({ total, unsaved, saved }) => ({ total, newCount: 0, uncommittedCount: null, groups: [], unsaved, saved });
  const stamped = changeScope({ kind: 'checkpoint', why: null, origin: null, commits: 4 }, ago);
  const card = (scope, files, dirty) => draw({ path: '/x', scope, files, lines: cardLines({ dirty }) });
  // Oscar 10/29 第一張截圖那一刻:蓋章之後改過 23 個,其中 3 個沒 commit
  const p1 = card(stamped, fl({ total: 23, unsaved: { count: 3, groups: [g('根目錄', 'config.json'), g('suite', 'a.py', 'new-b.py')] }, saved: { count: 20, groups: [g('docs', ...many(20))] } }), 3);
  check('AC-7:標題「存檔與蓋章」、小字「commit 了沒、蓋章了沒」;「未檢查清單」與舊的小標都不見了',
    /<h3 class="ctitle">存檔與蓋章<\/h3><div class="label">commit 了沒、蓋章了沒<\/div>/.test(p1) && !/未檢查清單|還沒重新檢查的檔案|含已存檔的/.test(p1), p1);
  check('AC-1:大字是還沒 commit 的 3 個', /<span class="num">3<\/span><span class="unit">個檔案還沒 commit<\/span>/.test(p1), p1);
  const fold = p1.match(/<details class="more" data-fold="saved\|\/x">[\s\S]*?<\/details>/)?.[0] ?? '';
  const outside = p1.replace(fold, '');
  check('AC-1:清單列那 3 個,新檔照舊標;已經 commit 的不混在外面', ['config.json', 'a.py', 'new-b.py · 新檔案'].every((n) => outside.includes(n)) && !outside.includes('f0.md'), outside);
  check('AC-1:「其中 N 個還沒存進保險箱」那一行不再出現', !/其中|保險箱/.test(p1), p1);
  check('AC-3:「另外 20 個已經 commit、還沒蓋章」收著(沒有 open),點開列那 20 個',
    /<summary>另外 20 個已經 commit、還沒蓋章<\/summary>/.test(fold) && !/data-fold="saved\|\/x" open/.test(fold) && fold.includes('f19.md'), fold || p1);
  const only = card(stamped, fl({ total: 3, unsaved: { count: 3, groups: [g('src', 'a', 'b', 'c')] }, saved: { count: 0, groups: [] } }), 3);
  check('AC-3:已經 commit 的是 0 → 那一行不出現', !/另外/.test(only), only);
  // 第二張截圖那一刻:都 commit 了,蓋章之後改過 23 個
  const p2 = card(stamped, fl({ total: 23, unsaved: { count: 0, groups: [] }, saved: { count: 23, groups: [g('docs', ...many(23))] } }), 0);
  check('AC-4:都 commit 了 → 大字「23 個檔案還沒蓋章」,底下講是蓋章之後改的、在那個資料夾跑哪個指令',
    /<span class="num">23<\/span><span class="unit">個檔案還沒蓋章<\/span>/.test(p2) && /都 commit 了，這些是蓋章之後改的。要蓋章：在那個資料夾跑 <code>pipeline-status --checkpoint<\/code>/.test(p2), p2);
  check('AC-4:清單照舊只露前 5 個,其餘收進「還有 18 個檔案」', /<summary>還有 18 個檔案<\/summary>/.test(p2) && p2.includes('f4.md'), p2);
  const again = card(stamped, fl({ total: 0, unsaved: { count: 0, groups: [] }, saved: { count: 0, groups: [] } }), 0);
  check('AC-4:重新蓋章之後照舊「沒有改動」「現在的檔案跟蓋章時一模一樣」', /<div class="big">沒有改動<\/div>/.test(again) && /現在的檔案跟蓋章時一模一樣/.test(again), again);
  check('P10:三種都不打勾、不畫安全的綠', [p1, p2, again].every((h) => !/✅|✓|data-tone="safe"/.test(h) && /data-tone="change"/.test(h)));
  // AC-5:沒有能用的章、找得到這一輪的起點
  const own = changeScope({ kind: 'origin', why: null, origin: { at: '2026-09-22T01:00:00Z', from: 'prompt', sessions: 1 } }, ago);
  const o1 = card(own, fl({ total: 2, unsaved: { count: 1, groups: [g('src', 'a.js')] }, saved: { count: 1, groups: [g('src', 'b.js')] } }), 1);
  check('AC-5:沒有能用的章、還有沒 commit 的 →「另外 1 個已經 commit、還沒蓋章(只算這一輪改的)」', /另外 1 個已經 commit、還沒蓋章（只算這一輪改的）/.test(o1), o1);
  const o2 = card(own, fl({ total: 2, unsaved: { count: 0, groups: [] }, saved: { count: 2, groups: [g('src', 'a.js', 'b.js')] } }), 0);
  check('AC-5:沒有能用的章、都 commit 了 → 講還沒有能用的章、只算這一輪', /個檔案還沒蓋章/.test(o2) && /都 commit 了，還沒有能用的章；這裡只算這一輪改的/.test(o2), o2);
  check('AC-8:從哪一刻算起收在說明裡', /<details class="why"[\s\S]*這個對話第一句話[\s\S]*<\/details>/.test(o2), o2);
  // AC-5:找不到這一輪的起點、還有沒 commit 的;一個 commit 都沒有
  const lost = changeScope({ kind: 'head', why: 'not-found', origin: null }, ago);
  const b1 = card(lost, fl({ total: 2, unsaved: { count: 2, groups: [g('src', 'a.js', 'b.js')] }, saved: { count: 0, groups: [] } }), 2);
  check('AC-5:找不到起點 → 講 commit 過、還沒蓋章的看不到,不寫「另外 0 個」',
    /commit 過、還沒蓋章的有哪些，這裡看不到（找不到這一輪開始時的版本）/.test(b1) && !/另外/.test(b1), b1);
  const none = changeScope({ kind: 'head', why: 'no-commits', origin: null }, ago);
  const n1 = card(none, fl({ total: 2, unsaved: { count: 2, groups: [g('src', 'a.js', 'b.js')] }, saved: { count: 0, groups: [] } }), 2);
  check('AC-5:一個 commit 都沒有 → 加一句還沒有東西可以蓋章', /還沒有任何 commit，所以也還沒有東西可以蓋章/.test(n1), n1);
  // AC-6:問不到哪些還沒 commit
  const unk = card(stamped, fl({ total: 5, unsaved: null, saved: null }), null);
  check('AC-6:問不到 → 大字問不到、講問不到;不講都 commit 了、也不講還沒蓋章',
    /<div class="big">問不到<\/div>/.test(unk) && /問不到你有沒有還沒 commit 的檔案。/.test(unk) && !/都 commit 了|個檔案還沒蓋章|個檔案還沒 commit/.test(unk), unk);
  // AC-8:最下面收著「commit 跟蓋章差在哪？」
  const help = p1.match(/<details class="why" data-fold="why\|\/x\|changes">[\s\S]*?<\/details>/)?.[0] ?? '';
  check('AC-8:「commit 跟蓋章差在哪？」預設收著,三句說明照伺服器給的印,蓋章的指令標成指令、接著講全綠不等於功能正確',
    /<summary>commit 跟蓋章差在哪？<\/summary>/.test(help) && help.includes(STAMP_HELP.commit) && help.includes(STAMP_HELP.order)
      && help.includes('蓋章（<code>pipeline-status --checkpoint</code>）') && help.includes(GREEN_IS_NOT_CORRECT), help || p1);
  check('AC-8:全部改了幾個收在裡面(蓋章之後的改動:23 個)', help.includes('蓋章之後的改動：23 個檔案。'), help);
  const leaks = [p1, only, p2, again, o1, o2, b1, n1, unk].filter((h) => /undefined|NaN|\bnull\b|\[object/.test(h));
  check('每一種都不把 undefined／null／NaN 印到畫面上', leaks.length === 0, leaks.join('\n---\n'));
}

section('還原點那一行照實講:有沒 commit 的才說會丟掉幾個、問不到講問不到、一個都沒有不掛 ⚠️;舊的服務沒給那一句照以前提醒(真的跑 ui/app.js 的 statRestore;規格:先講commit再講蓋章 AC-9、AC-10)', 'P10');
{
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const pick = (name, sig) => src.match(new RegExp(`^function ${name}\\(${sig}\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const one = (name) => src.match(new RegExp(`^const ${name} = .*;$`, 'm'))?.[0] ?? null;
  const code = [one('OLD_LINE'), one('cpOk'), pick('statRestore', 'c')];
  check('從 ui/app.js 拿得出 statRestore(拿不出來這一段就什麼都沒測到)', code.every(Boolean));
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const draw = code.every(Boolean) ? new Function('esc', 'ago', 'clock', 'foldOpen', `const zhEn = (zh) => zh;\n${code.join('\n')}; return statRestore;`)(esc, () => '17 小時前', () => '10/28 16:55', () => false) : () => '';
  const base = { path: '/x', checkpoint: { commit: 'a'.repeat(40), at: '2026-10-28T08:55:00Z', checks: ['lint', 'test'] },
                 checkpointRelation: { state: 'ok', commitsAfter: 4 }, backupBranch: '備份-2026-10-29-0931', cpVersion: null };
  const at = (dirty, lines = cardLines({ stamped: true, relation: base.checkpointRelation, dirty })) => draw({ ...base, dirty, lines });
  const three = at(3);
  check('3 個沒 commit → ⚠️ 回去會丟掉你還沒 commit 的 3 個檔案', /<div class="hint warn">⚠️ 回去會丟掉你還沒 commit 的 3 個檔案<\/div>/.test(three), three);
  const zero = at(0);
  check('0 個 →「現在沒有還沒 commit 的檔案」,不帶 ⚠️、不說會丟掉',
    /<div class="hint">現在沒有還沒 commit 的檔案<\/div>/.test(zero) && !/會丟掉/.test(zero), zero);
  const unknown = at(null);
  check('問不到 → ⚠️ 問不到你有沒有還沒 commit 的檔案(問不到 ≠ 沒有)', /<div class="hint warn">⚠️ 問不到你有沒有還沒 commit 的檔案<\/div>/.test(unknown), unknown);
  check('複製回去的指令照舊在(含 cd、先留備份分支)', /data-copy="cd &quot;\/x&quot; &amp;&amp; git branch 備份-2026-10-29-0931 &amp;&amp; git reset --hard aaaaaaa"/.test(zero), zero);
  const { restoreUnsaved, unsavedWhether, ...oldLines } = cardLines({ stamped: true, relation: base.checkpointRelation, dirty: 0 });
  const old = at(0, oldLines);
  check('舊的服務沒給那一句 → 不知道有沒有,照以前提醒;不印 undefined', /⚠️ 回去會丟掉還沒 commit 的東西/.test(old) && !/undefined|\bnull\b/.test(old), old);
  // 頁面最上面那一條:這一版以前的服務有 sharedLines、沒有 stampHelp——只看 sharedLines 認不出來(AC-10)
  const banner = src.match(/^function oldServerBanner\(\) \{\n[\s\S]*?\n\}\n/m)?.[0] ?? null;
  const bannerOf = (latest) => (banner ? new Function('latest', `const zhEn = (zh) => zh;\n${banner}; return oldServerBanner();`)(latest) : '');
  check('從 ui/app.js 拿得出 oldServerBanner', !!banner);
  check('上一版的服務(有 sharedLines、沒有 stampHelp)→ 最上面講服務還在跑舊的程式', /--serve-restart/.test(bannerOf({ projects: [], sharedLines: {} })));
  check('這一版的服務 → 不講', bannerOf({ projects: [], sharedLines: {}, stampHelp: STAMP_HELP }) === '');
}

section('上一手的對話頁:講明資料夾換人了,不畫資料夾現在的分支、還原點、改動、分級;五關那一格不給按資料夾記的按鈕(真的跑 ui/app.js 的 sessionPage;規格:新對話接手舊資料夾 AC-5)', 'P6');
{
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const code = src.match(/^function sessionPage\(name, sid\) \{\n[\s\S]*?\n\}\n/m)?.[0] ?? null;
  check('從 ui/app.js 拿得出 sessionPage(拿不出來這一段就什麼都沒測到)', !!code);
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = (iso) => (iso ? '2 天前' : '');
  const stub = (n) => () => `<${n}>`;
  const card = { path: '/w', branch: 'claude/new', project: 'p', stages: [] };
  const sess = (o) => ({ id: 's0', title: '舊對話', prompts: 3, lastTs: '2026-09-22T07:45:00Z', closedAt: '2026-09-22T07:45:00Z', stages: [], card, cwd: '/w', ...o });
  const latest = { projects: [{ name: 'p', sessions: [
    sess({ movedOn: { at: '2026-09-24T01:52:43Z' }, sharesCwd: false }),
    sess({ id: 's1', title: '新對話', closedAt: null, movedOn: null, sharesCwd: false }),
  ] }] };
  // workflow 換成會講出它拿到哪個資料夾的替身:E 那一格「你說驗收過了」的按鈕是按資料夾記的,path 在就會畫
  const oldLine = src.match(/^const OLD_LINE = .*;$/m)?.[0] ?? '';   // 「叫了不等於通過」那一句是伺服器給的;舊的服務沒給時用這一句
  const page = code ? new Function('latest', 'esc', 'ago', 'workflow', 'statRestore', 'statLadder', 'statChanges', 'statTier', 'sensorLine', 'stagesNoteLine',
    `const zhEn = (zh) => zh;\n${oldLine}\n${code}; return sessionPage;`)(latest, esc, ago, (c) => `<workflow path=${c.path}>`, stub('restore'), stub('ladder'), stub('changes'), stub('tier'), stub('sensor'), stub('stagesNote')) : null;
  const old = page?.('p', 's0') ?? '';
  check('上一手:講這個資料夾 N 前換到另一條分支、給別的對話用了', /2 天前換到另一條分支、給別的對話用了/.test(old), old);
  check('上一手:不畫還原點、三階梯、改動、分級(那是下一手的)', !/<restore>|<ladder>|<changes>|<tier>/.test(old), old);
  check('上一手:不寫資料夾現在的分支名', !old.includes('claude/new'), old);
  check('上一手:五關照畫,但沒有資料夾(按鈕不畫——在這一頁按,記到的是下一手)', /<workflow path=null>/.test(old), old);
  const cur = page?.('p', 's1') ?? '';
  check('這一手:照舊畫四張卡、寫分支名、不說跟別的對話共用', /<restore>/.test(cur) && /<tier>/.test(cur) && cur.includes('claude/new') && !/還有別的對話在用/.test(cur), cur);
}

section('五關的工班:笑眼只給「你說處理完了」——Claude 自己回報 ok、Claude 對完清單、照開始改程式算你點頭的都不笑(真的跑 ui/app.js 的 workflow;規格:工地工班風畫面 AC-8)', 'P10');
{
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const fn = (name) => src.match(new RegExp(`^function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const one = (name) => src.match(new RegExp(`^const ${name} = .*;$`, 'm'))?.[0] ?? null;
  const parts = [one('stageState'), one('OLD_LINE'), one('FACE'), fn('roundStage'), fn('eyes'), fn('agent'), fn('workflow')];
  check('從 ui/app.js 拿得出 workflow 與畫工班的小函式(拿不出來這一段就什麼都沒測到)', parts.every(Boolean), parts.map((p, i) => (p ? '' : i)).join(','));
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const wf = parts.every(Boolean) ? new Function('esc', 'ago', 'ROLE', 'foldOpen', `const zhEn = (zh) => zh;\n${parts.join('\n')}; return workflow;`)(esc, () => '5 分鐘前', {}, () => false) : null;
  // 這一輪走到的那一關是 done(處理完了):誰說的決定給不給笑眼
  const face = (st) => (wf?.({ path: '/x', sensor: { state: 'ok' }, stages: [{ line: '處理完了', ...st }] }) ?? '')
    .match(new RegExp(`class="agent" data-id="${st.id}" data-face="([a-z]+)"`))?.[1] ?? null;
  // 誰說處理完了是伺服器給的 doneBy(lib/rounds.mjs);closedBy 是憑什麼劃掉,照伺服器會給的一起放
  check('D:Claude 自己回報 ok(doneBy:claude)→ 不是笑眼', face({ id: 'D', name: '魔鬼教官', skill: 'chaos-check', state: 'done', closedBy: 'claude', doneBy: 'claude' }) === 'open');
  check('B:Claude 對完清單(doneBy:claude)→ 不是笑眼', face({ id: 'B', name: '寫程式', type: 'main-conversation', state: 'done', closedBy: 'checklist', doneBy: 'claude' }) === 'open');
  check('A:算你點頭開工、處理完了是 Claude 回報的(closedBy:nod、doneBy:claude)→ 不是笑眼', face({ id: 'A', name: '寫規格', skill: 'spec', state: 'done', closedBy: 'nod', doneBy: 'claude' }) === 'open');
  check('沒寫是誰說的 → 不是笑眼(分不出來就不替它高興)', face({ id: 'C', name: '打掃', skill: 'cleanup', state: 'done' }) === 'open');
  check('E:你說驗收過了(doneBy:human)→ 笑眼', face({ id: 'E', name: '驗收', type: 'browser', skill: 'verify', state: 'done', closedBy: 'human', doneBy: 'human' }) === 'happy');
  check('叫了(current)→ 睜眼看著那一行字,不是笑眼', face({ id: 'D', name: '魔鬼教官', skill: 'chaos-check', state: 'current' }) === 'look');
}

section('誰說處理完了只算一次(lib/rounds.mjs 的 doneBy):那一格的字(伺服器照 lib/stageLines.mjs 算,終端機同一句)與工班的臉(ui/app.js 的 agent)讀同一個——A 由 Claude 回報 ok、之後才開始改程式檔,不准寫成「你說處理完了」(先寫一個必須抓到、一個必須放過)', 'P2');
{
  // 2026-10-27 實例(ai-english-course「查證語音備援模型 11 月下架的影響」):Claude 叫了 A → 開始改程式檔(算你點頭開工)→
  // 最後 Claude 才記 A 的結論(規格搬到升級摘要之後再記一次),A 又是這一輪最新的那一步(done)。「點頭開工」把 closedBy 蓋成 nod,
  // 那一句只分 claude 跟「其他一律你說」,寫成「17 天前你說處理完了」;臉看的是「是不是 human」,睜著眼——同一件事,字跟臉各猜一個
  const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  const T = (h) => new Date(Date.UTC(2026, 9, 8, h)).toISOString();
  const start = [
    { ts: T(1), hook: 'PreToolUse', tool: 'Skill', skill: 'pipeline-monitor:spec', session: 's1', cwd: '/x' },
    { ts: T(2), hook: 'PostToolUse', tool: 'Edit', session: 's1', cwd: '/x', file: '/x/src/a.js' },   // 開始改程式檔:算你點頭開工
  ];
  const claudeSaid = [...start, { ts: T(3), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/升級摘要/y.md', cwd: '/x', source: 'claude' }];
  const youSaid = [...start, { ts: T(3), event: 'stage_cleared', stage: 'A', cwd: '/x', source: 'human' }];   // 舊紀錄:以前 A 也能按「處理完了」
  // 伺服器做的事:算這一輪、每一格附上那一句(screenStages)。網頁拿到的就是這幾格
  const screenOf = (events) => screenStages(sessionView(events, stages, 's1', null, '/x').view.stages);
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const fn = (name) => src.match(new RegExp(`^function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const one = (name) => src.match(new RegExp(`^const ${name} = .*;$`, 'm'))?.[0] ?? null;
  const parts = [one('stageState'), one('OLD_LINE'), one('FACE'), fn('roundStage'), fn('eyes'), fn('agent'), fn('workflow')];
  check('從 ui/app.js 拿得出 workflow 與畫工班的小函式(拿不出來這一段就什麼都沒測到)', parts.every(Boolean), parts.map((p, i) => (p ? '' : i)).join(','));
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const wf = parts.every(Boolean) ? new Function('esc', 'ago', 'ROLE', 'foldOpen', `const zhEn = (zh) => zh;\n${parts.join('\n')}; return workflow;`)(esc, () => '5 分鐘前', {}, () => false) : null;
  const paint = (screen) => wf?.({ path: '/x', sensor: { state: 'ok' }, stages: screen }) ?? '';
  const faceOf = (html, id) => html.match(new RegExp(`class="agent" data-id="${id}" data-face="([a-z]+)"`))?.[1] ?? null;

  const c = screenOf(claudeSaid), cA = c.find((s) => s.id === 'A'), cHtml = paint(c);
  check('必須抓到的那個樣子:A 是這一輪最新的那一步(done),憑什麼劃掉被蓋成點頭開工(nod)', cA?.state === 'done' && cA?.closedBy === 'nod', JSON.stringify({ state: cA?.state, closedBy: cA?.closedBy }));
  check('必須抓到:那一句寫 Claude 說(帶它記的那一句),不寫「你說處理完了」', /Claude 說：docs\/升級摘要\/y\.md/.test(cA?.line ?? '') && !/你說/.test(cA?.line ?? ''), cA?.line);
  eq('必須抓到:工班睜著眼,不是笑眼', faceOf(cHtml, 'A'), 'open');
  check('網頁照印伺服器給的那一句', cHtml.includes(esc(cA?.line)), cHtml.slice(0, 300));

  // 舊的臉在這裡也錯(睜著眼)——字跟臉各猜一個,錯在相反的兩邊
  const y = screenOf(youSaid), yA = y.find((s) => s.id === 'A'), yHtml = paint(y);
  check('必須放過:真的是你說的(舊紀錄),A 一樣被蓋成點頭開工 → 那一句照舊寫「你說處理完了」', yA?.state === 'done' && yA?.closedBy === 'nod' && /你說處理完了/.test(yA?.line ?? '') && !/Claude 說/.test(yA?.line ?? ''), yA?.line);
  eq('必須放過:工班笑眼', faceOf(yHtml, 'A'), 'happy');

  // 字跟臉是同一個事實:這一輪每一格處理完了的,笑眼 ⇔ 那一句寫你說
  const pairs = [[c, cHtml], [y, yHtml]].flatMap(([screen, html]) => screen.filter((s) => s.state === 'done').map((s) => ({ id: s.id, line: s.line, face: faceOf(html, s.id) })));
  check('處理完了的每一格:笑眼的才寫你說、寫你說的才笑眼', pairs.length === 2 && pairs.every((p) => (p.face === 'happy') === /你說/.test(p.line)), JSON.stringify(pairs));

  // 分不出是誰說的(誰說的那一欄沒有):不替你說、也不替 Claude 說(R1);臉也不笑
  const unknown = { ...cA, doneBy: undefined };
  const uLine = stageLine(unknown, { ago: () => '3 天前' });
  check('分不出是誰說的:不寫你說、也不寫 Claude 說,照講分不出', !/你說|Claude 說/.test(uLine) && /分不出是誰說的/.test(uLine), uLine);
  eq('分不出是誰說的:工班不笑', faceOf(paint(c.map((s) => (s.id === 'A' ? { ...unknown, line: uLine } : s))), 'A'), 'open');
  // 網頁不自己從 closedBy 猜:舊的服務(合併之後還沒 --serve-restart)只給 closedBy:human、沒給 doneBy,也不笑——笑不笑只看伺服器算好的那一個
  eq('舊的服務只給 closedBy:human、沒給 doneBy → 不笑(網頁不自己猜)', faceOf(paint(y.map((s) => (s.id === 'A' ? { ...s, closedBy: 'human', doneBy: undefined } : s))), 'A'), 'open');
}

process.exit(summary());
