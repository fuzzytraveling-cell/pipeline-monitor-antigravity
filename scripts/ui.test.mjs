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
    check('講得出「你在 app 把卡按掉,這裡看不到」', html.includes('app 把建議卡按掉'), html.slice(0, 400));
    check('講得出「Claude 自己把卡收回,這裡也看不到」(實測大半的卡被收回過)', html.includes('收回'), html.slice(0, 400));
    check('卡上不寫「你已取消」(AC-2:感測器看不到 app 的叉叉,那句話沒有任何證據)', !html.includes('取消'));
    check('收起來的 2 張 = 已開始 1 ＋ 你說不做了 1(同一張卡不算兩次)', html.includes('收起來的 2 張（已開始 1、你說不做了 1）'), html.match(/收起來的[^<]*/)?.[0]);
    check('還沒處理的那張有「不做了」按鈕,收起來的沒有', (html.match(/data-dismiss=/g) ?? []).length === 1);
    check('兩種來源各有一小行(AC-5)', block({ name: 'x', appCardsSince: TS, suggestions: [sgCard(), sgCard({ id: 'c', source: 'claude' })] }).includes('Claude 在對話裡提的建議卡')
      && block({ name: 'x', appCardsSince: TS, suggestions: [sgCard({ id: 'c', source: 'claude' })] }).includes('Claude 用 --suggest 放的'));
    check('被截短的卡標「已截短」,而且講完整的在哪(AC-4)', block({ name: 'x', appCardsSince: TS, suggestions: [sgCard({ cut: ['prompt'] })] }).includes('已截短'));
    check('空的卡講「這張卡沒有內容」,不是不畫(混沌推導:輸入畸形)', block({ name: 'x', appCardsSince: TS, suggestions: [sgCard({ tldr: null, prompt: '' })] }).includes('這張卡沒有內容'));
  }
}

process.exit(summary());
