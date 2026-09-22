/**
 * ui.test.mjs —— 只釘畫面「會安靜說謊」的那幾條（AC-1／AC-2／AC-8）
 *
 * ⚠️ 刻意**不測長相**。樣式壞了看得見;下面這幾條壞了畫面照跑、測試全綠,
 *    而使用者會照著三小時前的資料做決定。
 */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { describeFreshness, STALE_AFTER_SECONDS } from '../lib/freshness.mjs';
import { createApp } from '../server.mjs';
import { SUGGEST_TOOL } from '../lib/events.mjs';
import { changeScope } from '../lib/scope.mjs';
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
  writeFileSync(join(monitorDir, 'checkpoints', `${basename(root)}__main.json`), JSON.stringify({
    commit: out('rev-parse', 'HEAD'), branch: 'main', worktree: root, at: new Date().toISOString(), checks: ['test'],
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
  writeFileSync(join(monitorDir, 'checkpoints', `${name}__main.json`), JSON.stringify({
    commit: out('rev-parse', 'HEAD'), branch: 'main', worktree: root, at: new Date().toISOString(), checks: ['test'],
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
      `let latest = null, connected = false, bootVersion = null;\n${poll[0]}\n${loop[0]}\nreturn { pollLoop, connected: () => connected };`);
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
  return new Function('esc', 'ago', 'clock', 'foldOpen', 'latest', `${m[0]}; return suggestionsBlock;`)(esc, ago, clock, () => false, latest);
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
    check('講得出「Claude 叫了收回會標在卡上,但分不出是哪一張」', html.includes('分不出收回的是哪一張'), html.slice(0, 600));
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

section('分級卡與未檢查清單:只看得到還沒存的時候不畫「沒有改動」那張綠臉(真的跑 ui/app.js 的 statTier／statChanges;規格:這一輪的起點 AC-4、AC-5)', 'P5');
{
  // 跟 suggestionsBlock 同一種做法:原封不動拿出來跑,補上它們用到的外部名字。拿不出來要紅——不准安靜地跳過(L20)
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const pick = (name, sig) => src.match(new RegExp(`^function ${name}\\(${sig}\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))?.[0] ?? null;
  const code = [pick('scopeOfOldServer', 'c'), pick('statChanges', 'c'), pick('statTier', 'c, p')];
  check('從 ui/app.js 拿得出 scopeOfOldServer、statChanges、statTier(拿不出來這一段就什麼都沒測到)', code.every(Boolean));
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = (iso) => (iso ? '3 分鐘前' : '');
  const cpOk = (c) => !!c?.checkpoint && c?.checkpointRelation?.state === 'ok';
  const ui = code.every(Boolean) ? new Function('esc', 'ago', 'cpOk', `${code.join('\n')}; return { statChanges, statTier };`)(esc, ago, cpOk) : null;
  const empty = { total: 0, newCount: 0, uncommittedCount: 0, groups: [] };
  const blind = { path: '/x', files: empty, scope: changeScope({ kind: 'head', why: 'not-found', origin: null }, ago),
                  tier: { state: 'unseen', basis: { kind: 'head', why: 'not-found', origin: null } } };
  const tierHtml = ui?.statTier(blind, { name: 'p' }) ?? '';
  const filesHtml = ui?.statChanges(blind) ?? '';
  check('分級卡:看不全、不是安全的綠臉、不寫「沒有改動」', /看不全/.test(tierHtml) && !/data-tone="safe"/.test(tierHtml) && !/沒有改動/.test(tierHtml), tierHtml);
  check('未檢查清單:看不全、講存檔過的看不到', /看不全/.test(filesHtml) && /存檔過的看不到/.test(filesHtml) && !/沒有改動/.test(filesHtml), filesHtml);
  const own = changeScope({ kind: 'origin', why: null, origin: { at: '2026-09-22T01:00:00Z', from: 'prompt', sessions: 1 } }, ago);
  const ownHtml = ui?.statChanges({ path: '/x', scope: own, files: { total: 2, newCount: 0, uncommittedCount: 1,
    groups: [{ dir: 'src', items: [{ name: 'a.js', isNew: false, uncommitted: true }, { name: 'b.js', isNew: false, uncommitted: false }] }] } }) ?? '';
  check('從起點算:標「這一輪改過的檔案(含已存檔的)」、講從哪一刻算起,每個檔照舊標還沒存',
    /這一輪改過的檔案（含已存檔的）/.test(ownHtml) && /這個對話第一句話/.test(ownHtml) && /其中 <b>1 個還沒存/.test(ownHtml), ownHtml);
  const moved = { path: '/x', files: empty, scope: changeScope({ kind: 'origin', why: null, moved: true, origin: { at: '2026-09-22T01:00:00Z', from: 'prompt', sessions: 1 } }, ago) };
  const movedHtml = ui?.statChanges(moved) ?? '';
  check('這一輪中間切過分支、現在跟開始時一樣:看不全,不寫「沒有改動」', /看不全/.test(movedHtml) && /切過分支/.test(movedHtml) && !/沒有改動/.test(movedHtml), movedHtml);
  const eight = changeScope({ kind: 'origin', why: null, commits: 8, origin: { at: '2026-09-22T01:00:00Z', from: 'A' } }, ago);
  const scaleHtml = ui?.statChanges({ path: '/x', scope: eight, scale: { median: 2, max: 20 }, files: { total: 22, newCount: 0, uncommittedCount: 0, groups: [] } }) ?? '';
  check('比例尺講「一次存檔」,而且講這裡是 8 次存檔加起來的(L6)', /一次存檔（commit）通常 2 個/.test(scaleHtml) && /8 次存檔加起來/.test(scaleHtml), scaleHtml);
  // 案件首頁(Oscar 第一個看到的畫面)也不准把「看不全」講成「沒有待檢查的檔案」
  const ovSrc = [pick('focusOf', 'p'), pick('overview', 'p')];
  check('從 ui/app.js 拿得出 focusOf、overview', ovSrc.every(Boolean));
  const ov = ovSrc.every(Boolean) ? new Function('esc', 'ago', 'cpOk', `${ovSrc.join('\n')}; return overview;`)(esc, ago, cpOk) : null;
  const ovCard = { path: '/x', ladder: { uncommitted: 0 }, checkpoint: null, files: empty, scope: blind.scope };
  const ovHtml = ov?.({ name: 'p', mainRoot: '/x', cards: [ovCard], sessions: [{ id: 's1', title: '調標籤', lastTs: '2026-09-22T01:00:00Z', closedAt: null, card: ovCard }] }) ?? '';
  check('案件首頁:看不全,不寫「沒有待檢查的檔案」', /看不全/.test(ovHtml) && !/沒有待檢查的檔案/.test(ovHtml), ovHtml.slice(0, 600));
  // 常駐服務還沒重啟(舊的伺服器不給 scope):照當時的字畫,不當掉、不假裝知道這一輪
  const old = ui?.statChanges({ path: '/x', files: empty }) ?? '';
  check('舊的服務沒給 scope:照「還沒存檔的改動」畫,不當掉', /還沒存檔（commit）的改動/.test(old) && !/這一輪/.test(old), old);
  check('畫面不 import 新檔(常駐服務只送啟動那一刻白名單裡的檔案,多一個新檔,重啟之前整個畫面載不進來)',
    !/from '\/scope\.mjs'/.test(src) && [...src.matchAll(/^import .* from '([^']+)'/gm)].every((m) => m[1] === '/freshness.mjs'), [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).join(','));
}

process.exit(summary());
