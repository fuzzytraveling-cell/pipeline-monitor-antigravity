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

process.exit(summary());
