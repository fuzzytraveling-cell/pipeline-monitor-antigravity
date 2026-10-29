/**
 * lang.test.mjs —— 儀表板與終端機中英切換(規格:儀表板與終端機中英切換,路徑看 CLAUDE.md 的表)
 *
 * 釘的是會安靜說謊的那幾種,不釘長相:
 *   ① 新加一句只寫中文(或英文那一份空著)——掃程式字串,中文只准住在 zhEn(中文, English) 裡(AC-4,老毛病 P2)
 *   ② 英文那一頁有一角還是中文,包括看不見的全形空白(AC-3)
 *   ③ 英文翻得太好聽:「叫了」翻成 passed、「沒有紀錄」翻成 not run(AC-5)——「不准」的字只查那一格,不掃整頁(P4)
 *   ④ 按了不等於換了:連不上、舊的服務、寫不進去都要照實講(AC-7,R2)
 *   ⑤ 測試偷看這台電腦真的選擇(AC-9,P8)
 */
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, symlinkSync, existsSync, chmodSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { scanSource, CJK } from './_zhscan.mjs';
import { readLang, writeLang, withLang, langFile, LANGS } from '../lib/lang.mjs';
import { describeFreshness, humanAge } from '../lib/freshness.mjs';
import { ago, withClock, backupBranchName } from '../lib/git.mjs';
import { cardLines, ladderSteps } from '../lib/collect.mjs';
import { changeScope, noStampYet, greenIsNotCorrect } from '../lib/scope.mjs';
import { tierLines, requirementStatus, emptyDangerLine } from '../lib/tier.mjs';
import { stageLine, specNotes, clProg, clDoneNote, checklistWhy, checklistHead, checklistPartLine, checklistLines, linkLine, calledIsNotPassed } from '../lib/stageLines.mjs';
import { rerunLine, tookLine, noRecordLine, stagesBrokenLine, unknownPromptLine, noWords, loadStages } from '../lib/rounds.mjs';
import { eLines, eWhere, summaryLine, walkItems, walkSummary, parseWalk } from '../lib/verify.mjs';
import { faultBanner, faultNotes, sensorParts, sensorOffLine, gateLine, moveLine, noneHereLine, optedOutLine, unreadableLine } from '../lib/faults.mjs';
import { createApp } from '../server.mjs';
import { decide } from '../gate.mjs';
import { safeName } from '../lib/events.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name;
const NOW = Date.now();   // 測試裡的「現在」只取一次(L18)
const T = (sec) => new Date(NOW + sec * 1000).toISOString();
const MIN = 60;
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

/* ════════════ 共用:英文那一頁不准有中文(資料照原文的那幾種除外) ════════════ */

// 資料照原文印(規格「哪些字算這一份的」):規格住的資料夾名(另一份規格才翻)、按鈕要切過去的那一種(英文的時候寫「中文」,AC-1)
const DATA_ZH = ['規劃中', '進行中', '升級摘要'];
const stripData = (t, extra = []) => [...DATA_ZH, ...extra].reduce((x, d) => x.split(d).join(''), String(t ?? ''));
/** 一段英文裡的中文字與全形符號(含 U+3000)。資料照原文的拿掉再找;回傳找到的那幾個字與前後文,方便看是哪一句 */
function zhIn(text, extra = []) {
  const t = stripData(text, extra);
  const hits = [];
  for (const m of t.matchAll(new RegExp(CJK.source, 'g'))) {
    if (hits.length >= 3) break;
    hits.push(JSON.stringify(t.slice(Math.max(0, m.index - 30), m.index + 30)));
  }
  return hits;
}
function noZh(label, text, extra = []) {
  const hits = zhIn(text, extra);
  check(label, hits.length === 0, hits.join('\n      '));
}
const en = (fn) => withLang('en', fn);
const strip = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

/* ════════════ AC-4:中英寫在同一個地方;只寫中文,測試紅 ════════════ */

/**
 * Claude 那一側:Claude 讀的、Claude 寫的字,另一份規格「技能與寫給AI的話中英切換」才翻(AC-8)。整段跳過——那一份做完,這張表要清空。
 * '*' = 整支。名字是那支檔最外層宣告的名字(function／const)。
 */
const CLAUDE_SIDE = {
  'lib/cliRerun.mjs': ['*'],                       // --round、--decide
  'lib/cliReport.mjs': ['doSpec', 'writtenHere', 'doReport', 'doSuggest'],
  'lib/cliTier.mjs': ['doTierInit', 'doTierOff', 'tierNotReady', 'freshInProject', 'doTierReview', 'doTierChecked', 'doTierLater'],
  'lib/rounds.mjs': ['runMode', 'offerPrompt'],    // D 怎麼跑(寫給 Claude 的);照標題湊的那段要貼給新對話(Claude 讀的,也拿來比對「已開始」)
  'lib/tier.mjs': ['dangerAskLine', 'proposeCodeArea'],   // 收工 hook 叫 Claude 先停下來問的那一段;--tier-init 提議的程式區
};
/**
 * 照原文認的中文:不是給人看的句子,是資料的格式。那個字面一字不差才放過(換了字就要重新判斷)。
 */
const CODES = {
  // hook.sh／gate.sh 寫進紀錄的故障代號(sh 那一端不改),與讀不懂的那一行的內部記號(不上畫面)
  'lib/faults.mjs': ['jq 不存在', '找不到 node', '看不懂的一行'],
  // 規格檔的格式(**AC-1　標題**、> **白話**：、⏳ 待討論、資料夾名):照中文認,另一份規格才加英文的
  'lib/checklist.mjs': ['^\\*\\*(AC-\\d+)[\\s　]+(.+?)\\*\\*\\s*(.*)$', '^>\\s*\\*\\*白話\\*\\*[：:]\\s*(.*)$', '⏳\\s*(待討論)?\\s*[：:]?\\s*',
    '[\\s、，,；;：:（）()「」『』"\'`<>]+', '[。！？!?]+$', '(^|\\/)docs\\/(規劃中|進行中)\\/[^/]+\\.md$', '^docs\\/(規劃中|進行中)\\/[^/]+\\.md$',
    '規劃中', '進行中', '升級摘要', 'docs\\/(?:規劃中|進行中)\\/([^\\s\\/`\'"<>()（）「」『』【】，。、；：！？]+?\\.md)(?![A-Za-z0-9_])'],
  // Claude 回報 E 的格式(AC-1 看到了：…):另一份規格才翻
  'lib/verify.mjs': ['^(?:[-•*]\\s*)?(?:([^\\s：:，,、]+?)\\s+(?=AC-?\\d))?(AC-?\\d+|\\d+)\\s*[.．、:：]?\\s*(看到了|沒看到|驗不了)\\s*[：:]?\\s*(.*)$', '「[^」]+」', '？'],
  'lib/rounds.mjs': ['(^|\\/)docs\\/(規劃中|進行中)\\/[^/]+\\.md$'],
  // 資料夾名(設計數值住的地方)
  'server.mjs': ['ui設計規格'],
  // 寫進 .git/info/exclude 的註解行(檔案裡的字,不上畫面);危險清單上的檔,這次一個字不改
  'lib/paths.mjs': ['# pipeline-monitor:紀錄搬到 ~/.pipeline-monitor 之後,舊的位置留下的捷徑\\n'],
};
const FILES = [...readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => `lib/${f}`), 'ui/app.js', 'status.mjs', 'server.mjs'];

section('AC-4:中文只准住在 zhEn(中文, English) 裡——lib、ui/app.js、status.mjs、server.mjs 新加一句只寫中文、或英文是空的,這裡紅', 'P2');
{
  let total = 0;
  for (const f of FILES) {
    const skip = CLAUDE_SIDE[f] ?? [];
    const bad = scanSource(readFileSync(join(ROOT, f), 'utf8'), { skip, codes: new Set(CODES[f] ?? []), noTopLevel: f !== 'ui/app.js' });
    total += bad.length;
    check(`${f}:沒有只寫中文的字串`, bad.length === 0, bad.slice(0, 8).map((b) => `${f}:${b.line} ${b.why}:${b.text}`).join('\n      '));
  }
  check('掃到的檔不是零支(拿不到檔案就什麼都沒測到)', FILES.length > 20, String(FILES.length));
  check('Claude 那一側、資料格式這兩張表寫的檔都還在(檔改名了,表要跟著改)',
    [...Object.keys(CLAUDE_SIDE), ...Object.keys(CODES)].every((f) => existsSync(join(ROOT, f))));
}

section('AC-4 的反向測試(老毛病 P4):先寫兩個例子——一個必須抓到、一個必須放過', 'P4');
{
  const scan = (src, codes = []) => scanSource(src, { codes: new Set(codes), noTopLevel: true });
  check('必須抓到:out.push(\'新加的一句\')', scan("function f(out) { out.push('新加的一句'); }").length === 1);
  check('必須抓到:樣板字串裡的中文(`${n} 個檔案`)', scan('function f(n) { return `${n} 個檔案`; }').length === 1);
  check('必須抓到:英文那一份是空的(zhEn(\'一句\', \'\'))', scan("function f() { return zhEn('一句', ''); }").some((b) => /空的/.test(b.why)));
  check('必須抓到:英文那一份裡有中文', scan("function f() { return zhEn('一句', 'one 句'); }").some((b) => /英文那一份裡有中文/.test(b.why)));
  check('必須抓到:只給一種的 zhEn', scan("function f() { return zhEn('一句'); }").some((b) => /只給了一種/.test(b.why)));
  check('必須抓到:拿全形空白對齊(padEnd(10, \'　\'))', scan("function f(s) { return s.padEnd(10, '　'); }").length === 1);
  check('必須抓到:在中文句子上切字的正則(replace(/^清單 /))', scan("function f(s) { return s.replace(/^清單 /, ''); }").length === 1);
  check('必須抓到:載入的那一刻就定死的一句(const X = zhEn(…) 在最外層:永遠是中文)', scan("const X = zhEn('一句', 'a line');").length === 1);
  check('必須放過:註解(// 中文、/* 中文 */)', scan("// 這是註解\n/* 也是註解 */\nfunction f() { return 1; }").length === 0);
  check('必須放過:中英並排的那一句', scan("function f(n) { return zhEn(`${n} 個檔案`, `${n} files`); }").length === 0);
  check('必須放過:英文裡有算式、沒有字面的(zhEn(20, 32))', scan('function f() { return zhEn(20, 32); }').length === 0);
  check("必須放過:'jq 不存在' 這種代號(寫進紀錄的格式)", scan("function f(x) { return x.why === 'jq 不存在'; }", ['jq 不存在']).length === 0);
  check('必須放過:包在函式裡的一句(用到的那一刻才定)', scan("const X = () => zhEn('一句', 'a line');").length === 0);
}

/* ════════════ AC-1:一顆按鈕、終端機同一個選擇;不跟 LANG 走 ════════════ */

section('語言設定:從來沒選過＝中文;寫了就讀得回來;讀不懂先用中文但講出來(AC-1、AC-7);不跟 LANG 走');
{
  const home = mkdtempSync(join(tmpdir(), 'pm-lang-'));
  eq('從來沒選過:中文', readLang(home).lang, 'zh');
  eq('……而且講得出是「從來沒選過」,不是讀不懂', readLang(home).state, 'unset');
  eq('寫英文:成功(回 null)', writeLang('en', home), null);
  eq('讀回來是英文', readLang(home).lang, 'en');
  check('只寫了它自己那一個檔(lang.json),沒有留下暫存檔', readdirSync(home).join(',') === 'lang.json', readdirSync(home).join(','));
  check('設定檔只有自己讀得到(權限 600)', (statSync(langFile(home)).mode & 0o777) === 0o600, (statSync(langFile(home)).mode & 0o777).toString(8));
  eq('寫不認得的語言:不寫', writeLang('fr', home), 'unknown-lang');
  eq('……原本的選擇還在', readLang(home).lang, 'en');
  writeFileSync(langFile(home), '{壞掉');
  eq('被改壞:先用中文', readLang(home).lang, 'zh');
  eq('……講得出是讀不懂(不是從來沒選過)', readLang(home).state, 'broken');
  writeFileSync(langFile(home), JSON.stringify({ lang: 'fr' }));
  eq('寫了不認得的語言:先用中文、讀不懂', `${readLang(home).lang}/${readLang(home).state}`, 'zh/broken');
  // 不跟 LANG 走:Claude 跑的指令裡 LANG 是空的、背景服務裡也沒有——跟它走的話,同一台電腦會各講各的
  const keep = process.env.LANG;
  process.env.LANG = 'en_US.UTF-8';
  writeFileSync(langFile(home), JSON.stringify({ lang: 'zh' }));
  eq('系統語言是英文、設定是中文 → 照設定(中文)', readLang(home).lang, 'zh');
  rmSync(langFile(home));
  eq('系統語言是英文、從來沒選過 → 照樣中文', readLang(home).lang, 'zh');
  if (keep === undefined) delete process.env.LANG; else process.env.LANG = keep;
  eq('LANGS 只有兩種(不加第三種)', LANGS.join(','), 'zh,en');
  rmSync(home, { recursive: true, force: true });
}

section('pipeline-status --lang:不帶字講現在是哪一種;換了用新的那一種講;不認得的不改;讀不懂照講(AC-1、AC-7)');
{
  const home = mkdtempSync(join(tmpdir(), 'pm-lang-'));
  const run = (...args) => {
    try { return { code: 0, out: execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PIPELINE_MONITOR_HOME: home, LANG: 'en_US.UTF-8' } }) }; }
    catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') }; }
  };
  const first = run('--lang');
  check('從來沒選過:講現在是中文、怎麼換成英文', /現在是中文（從來沒選過/.test(first.out) && first.out.includes('--lang en'), first.out);
  const fr = run('--lang', 'fr');
  check('--lang fr:講只有 zh、en 兩種,沒有改', fr.code === 1 && /只有 zh（中文）、en（英文）兩種/.test(fr.out) && /沒有改/.test(fr.out), fr.out);
  check('……真的沒有寫任何東西', !existsSync(join(home, 'lang.json')));
  const toEn = run('--lang', 'en');
  check('--lang en:印出來的那句用新的語言(英文)講', toEn.code === 0 && /^Switched to English/.test(toEn.out), toEn.out);
  noZh('……整段沒有中文', toEn.out);
  check('……照實講儀表板要等它下一次更新、舊的服務不會跟(按了不等於換了,R2)', /next refresh/.test(toEn.out) && /old program/.test(toEn.out), toEn.out);
  eq('……設定檔寫了英文', JSON.parse(readFileSync(join(home, 'lang.json'), 'utf8')).lang, 'en');
  const now = run('--lang');
  check('--lang(英文的時候):講現在是英文、怎麼換回中文', /^Currently English/.test(now.out) && now.out.includes('--lang zh'), now.out);
  const frEn = run('--lang', 'xx');
  check('英文的時候 --lang xx:用英文講只有兩種', frEn.code === 1 && /There are only zh \(Chinese\) and en \(English\)/.test(frEn.out), frEn.out);
  const notGit = run();
  check('英文的時候在不是 git 專案的地方跑:用英文講', /doesn't look like a git project/.test(notGit.out), notGit.out);
  noZh('……整段沒有中文', notGit.out);
  const toZh = run('--lang', 'zh');
  check('--lang zh:用中文講', /^改成中文了/.test(toZh.out), toZh.out);
  writeFileSync(join(home, 'lang.json'), '壞掉了');
  const broken = run('--lang');
  check('設定檔讀不懂:講「語言設定讀不懂，先用中文」', broken.out.includes('語言設定讀不懂，先用中文'), broken.out);
  const brokenView = run();
  check('……一般的指令最上面也講一句(不默默用)', brokenView.out.startsWith('⚠️ 語言設定讀不懂，先用中文'), brokenView.out);
  check('……而且照中文講其他的', brokenView.out.includes('這裡看起來不是一個 git 專案'), brokenView.out);
  // 寫不進去:家是一個不能寫的資料夾
  const ro = mkdtempSync(join(tmpdir(), 'pm-lang-ro-'));
  chmodSync(ro, 0o500);
  let cant;
  try { cant = execFileSync('node', [join(ROOT, 'status.mjs'), '--lang', 'en'], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PIPELINE_MONITOR_HOME: ro } }); }
  catch (e) { cant = String(e.stdout ?? ''); }
  check('寫不進去:講寫不進去、沒有切換,不印程式的錯誤代號', /寫不進去/.test(cant) && /沒有切換/.test(cant) && !/EACCES|Error/.test(cant), cant);
  chmodSync(ro, 0o700);
  rmSync(ro, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

/* ════════════ AC-1、AC-7:按鈕走伺服器 ════════════ */

section('伺服器:首頁照語言送(第一眼就是對的語言);按鈕跟其他按鈕同一套擋法;換了作廢共用的那份;資料帶著它是哪一種(AC-1、AC-7)', 'P3');
{
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'logs'));
  const server = createApp({ monitorDir, statusShareMs: 60_000 });   // 共用的那份放很久:看得出按鈕有沒有作廢它
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const send = (method, path, headers = {}, body = null) => new Promise((resolve, reject) => {
    const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: b }));
    });
    rq.on('error', reject);
    if (body) rq.write(body);
    rq.end();
  });
  const post = (lang, origin = `http://127.0.0.1:${port}`, host = undefined) => send('POST', '/api/lang',
    { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(host ? { host } : {}) }, JSON.stringify({ lang }));
  const status = async () => JSON.parse((await send('GET', '/api/status')).body);

  const zhPage = (await send('GET', '/')).body;
  check('從來沒選過:首頁是中文、<html lang="zh-Hant" data-lang="zh">', zhPage.includes('<html lang="zh-Hant" data-lang="zh">') && zhPage.includes('<title data-en="Pipeline Monitor">產線監視器</title>'), zhPage.slice(0, 300));
  check('……按鈕寫「English」(寫成要切過去的那一種)', />English<\/button>/.test(zhPage), zhPage);
  const s1 = await status();
  eq('資料帶著「這份是哪一種」:中文', s1.lang, 'zh');
  eq('……讀得懂就沒有那一句', s1.langNote, null);

  eq('別的網站送來的按鈕 → 403', (await post('en', 'https://evil.example')).code, 403);
  eq('同一台電腦別的埠送來的 → 403', (await post('en', 'http://localhost:5173')).code, 403);
  eq('假的網址(DNS 重新綁定)→ 403', (await post('en', null, `evil.example:${port}`)).code, 403);
  check('被擋下的一個都沒寫(還是從來沒選過)', !existsSync(join(monitorDir, 'lang.json')));
  const bad = await post('fr');
  eq('不認得的語言 → 400', bad.code, 400);
  eq('……回現在是哪一種(畫面照舊)', JSON.parse(bad.body).lang, 'zh');

  const ok = await post('en');
  eq('這一頁自己送的 → 200', ok.code, 200);
  eq('……回「現在是英文」(畫面等這一句才換)', JSON.parse(ok.body).lang, 'en');
  eq('……設定檔寫的是英文', JSON.parse(readFileSync(join(monitorDir, 'lang.json'), 'utf8')).lang, 'en');
  const s2 = await status();
  eq('換了之後共用的那份作廢了:下一次就是英文(不用等它過期)', s2.lang, 'en');
  const enPage = (await send('GET', '/')).body;
  check('首頁:<html lang="en" data-lang="en">', enPage.includes('<html lang="en" data-lang="en">'), enPage.slice(0, 200));
  check('首頁:標題、載入中、正在連線換成英文', enPage.includes('<title data-en="Pipeline Monitor">Pipeline Monitor</title>') && enPage.includes('>Loading…</p>') && enPage.includes('>Connecting…</span>'), enPage);
  check('首頁:按鈕寫「中文」', />中文<\/button>/.test(enPage), enPage);
  noZh('首頁(拿掉標籤):除了按鈕那個「中文」,沒有中文', strip(enPage), ['中文']);

  // 終端機切了(直接改設定檔,共用的那份還沒過期):下一次就要是新的那一種,不准拿舊語言的那份
  writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang: 'zh' }));
  eq('設定檔被別人改回中文(終端機 --lang zh)、共用的那份還沒過期 → 照樣給中文的', (await status()).lang, 'zh');
  writeFileSync(join(monitorDir, 'lang.json'), '{壞掉');
  const s3 = await status();
  eq('設定檔讀不懂 → 用中文', s3.lang, 'zh');
  check('……而且帶一句「語言設定讀不懂，先用中文」給最上面那一條', String(s3.langNote).includes('語言設定讀不懂，先用中文'), s3.langNote);
  eq('沒有這個位址(英文的時候)→ 404 的那一句也是英文', (writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang: 'en' })), (await send('GET', '/nope')).body), 'No such address');
  server.close();
  // 寫不進去:家是一個不能寫的資料夾——回 500 write,不假裝換了
  const ro = mkdtempSync(join(tmpdir(), 'pm-monitor-ro-'));
  mkdirSync(join(ro, 'logs'));
  chmodSync(ro, 0o500);
  const s2v = createApp({ monitorDir: ro });
  await new Promise((r) => s2v.listen(0, '127.0.0.1', r));
  const p2 = s2v.address().port;
  const cant = await new Promise((resolve) => {
    const rq = httpRequest({ host: '127.0.0.1', port: p2, method: 'POST', path: '/api/lang', headers: { host: `127.0.0.1:${p2}`, 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    rq.end(JSON.stringify({ lang: 'en' }));
  });
  eq('寫不進去 → 500', cant.code, 500);
  eq('……回 write(畫面講寫不進去)', JSON.parse(cant.body).error, 'write');
  eq('……現在還是中文', JSON.parse(cant.body).lang, 'zh');
  s2v.close();
  chmodSync(ro, 0o700);
  rmSync(ro, { recursive: true, force: true });
  rmSync(monitorDir, { recursive: true, force: true });
}

/* ════════════ ui/app.js:整支真的跑(只換掉 DOM、網路、計時器) ════════════ */

/**
 * 真的跑整支 ui/app.js(L20:畫面的程式沒真的跑過就等於沒測)。lang:<html data-lang> 寫的那一種;fetch 換成給的那一支。
 * 回傳畫面上會叫的那幾個函式,與按鈕旁那一格(langNote)、重新載入了幾次(reloads)。
 */
function uiOf(latest, { lang = 'zh', fetch = () => Promise.reject(new Error('測試不連網路')) } = {}) {
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const body = src.replace(/^import .*$/m, '').replace(/^pollLoop\(\);$/m, '').replace(/^setInterval\(paintFreshness, 1000\);$/m, '');
  const noop = () => {};
  const els = {};
  const el = (id) => (els[id] ??= { dataset: {}, classList: { toggle: noop }, innerHTML: '', textContent: '', style: { setProperty: noop }, querySelectorAll: () => [] });
  const document = { getElementById: el, addEventListener: noop, body: el('body'), activeElement: null, documentElement: { dataset: { lang } } };
  const loc = { hash: '', reloads: 0, reload() { this.reloads++; } };
  const store = new Map();
  const sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const make = new Function('describeFreshness', 'STALE_AFTER_SECONDS', 'document', 'window', 'localStorage', 'sessionStorage', 'location', 'setTimeout', 'setInterval', 'fetch', 'performance', 'console', '__LATEST',
    `${body}\nlatest = __LATEST;\nreturn { workflow, roundWhere, sensorLine, faultBanner, oldServerBanner, langBanner, render, safeRender, switchLang, poll, ago, clock, OLD_LINE, ROLE,
      statRestore, statLadder, statChanges, statTier, projectList, overview, sessionList, projectPage, suggestionsBlock, optOutLine, sessionPage,
      setLatest: (x) => { latest = x; }, connected: () => connected, LANG };`);
  const api = make(describeFreshness, 60, document, { addEventListener: noop }, { getItem: () => null, setItem: noop }, sessionStorage, loc, noop, noop, fetch,
    { now: () => 0 }, { ...console, error: noop }, latest);   // 壞掉的那一頁會往主控台印錯誤:這裡不看那一行
  return { ...api, els, loc, store };
}

section('畫面:按了中英切換,等伺服器回「現在是另一種」才整頁換;連不上、舊的服務、寫不進去都照實講、照舊原本那一種(AC-7,R2)');
{
  const btn = { disabled: false };
  const reply = (code, obj) => async () => ({ ok: code === 200, status: code, json: async () => obj });
  const ui = (fetch, lang = 'zh') => uiOf({ generatedAt: NOW, projects: [] }, { lang, fetch });

  const down = ui(() => Promise.reject(new Error('連不上')));
  await down.switchLang(btn);
  eq('連不上 → 按鈕旁講「連不上，沒有切換」', down.els['lang-note'].textContent, '連不上，沒有切換');
  eq('……沒有重新載入(照舊原本那一種)', down.loc.reloads, 0);
  eq('……按鈕可以再按', btn.disabled, false);

  const old = ui(async () => ({ ok: false, status: 404, json: async () => { throw new Error('不是 JSON'); } }));
  await old.switchLang(btn);
  check('舊的服務(沒有這個位址,回的是一行字)→ 講服務還在跑舊的程式、重啟之後才能切換', /服務還在跑舊的程式，重啟之後才能切換/.test(old.els['lang-note'].textContent), old.els['lang-note'].textContent);
  eq('……照舊中文,不半中半英(沒有重新載入)', old.loc.reloads, 0);

  const cant = ui(reply(500, { error: 'write', lang: 'zh' }));
  await cant.switchLang(btn);
  check('寫不進去 → 講寫不進去、沒有切換', /寫不進去，沒有切換/.test(cant.els['lang-note'].textContent), cant.els['lang-note'].textContent);
  eq('……沒有重新載入', cant.loc.reloads, 0);

  let sent = null;
  const good = ui(async (url, opt) => { sent = { url, body: JSON.parse(opt.body) }; return { ok: true, status: 200, json: async () => ({ ok: true, lang: 'en' }) }; });
  await good.switchLang(btn);
  eq('換得成 → 送的是「換成英文」', sent?.body?.lang, 'en');
  eq('……伺服器回「現在是英文」之後才整頁重新載入', good.loc.reloads, 1);

  const enUi = ui(async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }), 'en');
  await enUi.switchLang(btn);
  check('英文的時候按、遇到舊的服務:用英文講(這一頁是英文)', /still running the old program/.test(enUi.els['lang-note'].textContent), enUi.els['lang-note'].textContent);
  noZh('……沒有中文', enUi.els['lang-note'].textContent);
}

section('畫面:一頁的語言只有一個來源——資料說是另一種就整頁重新載入;舊的服務沒給 lang ＝ 中文;同一種不載(AC-7)');
{
  const data = (extra) => async () => ({ ok: true, status: 200, json: async () => ({ generatedAt: NOW, projects: [], ...extra }) });
  const same = uiOf(null, { lang: 'zh', fetch: data({ lang: 'zh' }) });
  await same.poll();
  eq('首頁是中文、資料也是中文 → 不重新載入', same.loc.reloads, 0);
  const oldSrv = uiOf(null, { lang: 'zh', fetch: data({}) });
  await oldSrv.poll();
  eq('舊的服務沒給 lang(只會中文)→ 當成中文,不重新載入', oldSrv.loc.reloads, 0);
  const other = uiOf(null, { lang: 'zh', fetch: data({ lang: 'en' }) });
  await other.poll();
  eq('別的分頁按了／終端機切了(資料變成英文)→ 整頁重新載入', other.loc.reloads, 1);
  await other.poll();
  eq('……十秒內還是對不上就不再載(不准一直重新載入、整頁看不到東西)', other.loc.reloads, 1);
}

/* ════════════ AC-3、AC-5:五關與最上面那一條,英文 ════════════ */

// 英文的資料:檔名、規格、你說的話、Claude 的結論、分支名都用英文(AC-3 的技術那一段)
const SAID = 'please build the export button';
const ST = (o) => ({ id: 'D', name: 'Chaos check', skill: 'chaos-check', state: 'none', ...o });

section('五關那一句(lib/stageLines.mjs):每一種狀態英文都沒有中文;「叫了」是 called／ran 加過了多久,不是 passed(AC-3、AC-5)', 'P10');
{
  withClock(() => en(() => {
    const t = T(-5 * MIN);
    const cl = { parsed: true, total: 5, checked: 3, pending: 1, unmarked: 1, items: [] };
    const multi = { parsed: true, multi: true, specs: 2, total: 9, checked: 9, pending: 0, unmarked: 0, unreadable: ['gone-spec'], parts: [] };
    const cases = [
      ['B 現在這一關(清單、git 說的)', { id: 'B', name: 'Code', type: 'main-conversation', state: 'current', ranAt: t, via: 'git', checklist: { ...cl, batchMissing: ['AC-9'] } }],
      ['B 清單沒對完', { id: 'B', name: 'Code', type: 'main-conversation', state: 'stale', ranAt: t, checklist: { ...cl, preMarked: true } }],
      ['B Claude 對完清單(好幾份、一份讀不到)', { id: 'B', name: 'Code', type: 'main-conversation', state: 'done', ranAt: t, doneAt: t, checklist: multi }],
      ['B 已走過', { id: 'B', name: 'Code', type: 'main-conversation', state: 'passed', ranAt: t, closedBy: 'checklist', checklist: cl }],
      ['B 就是你在講話的對話', { id: 'B', name: 'Code', type: 'main-conversation', state: 'main' }],
      ['這一關還沒建', ST({ state: 'notbuilt' })],
      ['找不到指令', ST({ state: 'none' }), { available: false }],
      ['這一輪還沒跑(上一輪跑過)', ST({ state: 'none', prevRanAt: T(-3 * 86400) })],
      ['這一輪還沒跑', ST({ state: 'none' })],
      ['已走過:照別的對話寫的規格', ST({ id: 'A', name: 'Spec', skill: 'spec', state: 'passed', closedBy: 'link', link: { name: 'export-button', how: 'only' } })],
      ['已走過:算你點頭開工', ST({ id: 'A', name: 'Spec', skill: 'spec', state: 'passed', ranAt: t, nodAt: t, closedBy: 'nod', calledAs: 'spec' })],
      ['已走過:Claude 說', ST({ state: 'passed', ranAt: t, closedBy: 'claude', report: { note: 'no known failure patterns matched' } })],
      ['已走過:你說處理完了', ST({ state: 'passed', ranAt: t, closedBy: 'human', via: 'typed', calledAs: 'chaos-check' })],
      ['要不要再跑由你決定', ST({ state: 'stale', ranAt: t, rerun: { state: 'ask', stage: { id: 'D', verb: 'run' } }, report: { note: 'found 2 issues' } })],
      ['要再跑(沒有判斷)', ST({ state: 'stale', ranAt: t })],
      ['你說不用再跑', ST({ state: 'held', ranAt: t, rerun: { state: 'skipped', decision: { said: { text: SAID, ts: t } }, concluded: true, stage: { id: 'D', verb: 'run' } } })],
      ['開過瀏覽器', { id: 'E', name: 'Acceptance', type: 'browser', state: 'seen', ranAt: t, count: 12, hosts: ['localhost:3000'] }, { clearHint: ': pipeline-status --clear E' }],
      ['等你點頭開工', ST({ id: 'A', name: 'Spec', skill: 'spec', state: 'current', ranAt: t, calledAs: 'spec' }), { first: true }],
      ['Claude 還沒記結論', ST({ state: 'current', ranAt: t })],
      ['Claude 說找到問題', ST({ state: 'current', ranAt: t, report: { verdict: 'found', note: 'found 2 issues\n- a\n- b' } })],
      ['還沒有人說驗收過了', { id: 'E', name: 'Acceptance', type: 'browser', state: 'current', ranAt: t, count: 3 }],
      ['Claude 說處理完了(花了多久)', ST({ state: 'done', ranAt: t, doneAt: t, doneBy: 'claude', report: { note: '' }, rerun: { state: 'ok', took: { latest: true, minutes: 75 } } })],
      ['你說處理完了', ST({ state: 'done', ranAt: t, doneAt: t, doneBy: 'human' })],
      ['分不出是誰說的', ST({ state: 'done', ranAt: t, doneAt: t, doneBy: null })],
      ['讀不懂的狀態', ST({ state: 'weird' })],
    ];
    for (const [label, st, opt] of cases) noZh(`英文:${label}`, stageLine(st, { ago, ...opt }));

    const line = (st, opt) => stageLine(ST(st), { ago, ...opt });
    const called = line({ state: 'current', ranAt: t });
    check('叫了 → called,加過了多久(minutes ago)', /Claude called \/chaos-check/.test(called) && /5 minutes ago/.test(called), called);
    check('……那一格不准是 passed／succeeded／done／✓', !/passed|succeeded|\bdone\b|✓/i.test(called), called);
    const moved = line({ state: 'passed', ranAt: t, closedBy: 'next' });
    check('已走過 → moved on', /moved on/.test(moved), moved);
    check('……那一格不准是 passed／complete', !/passed|complete/i.test(moved), moved);
    const handled = line({ state: 'done', ranAt: t, doneAt: t, doneBy: 'human' });
    check('你說處理完了 → you said it\'s handled', /you said it's handled/.test(handled), handled);
    check('……不准是 fixed／resolved／passed', !/fixed|resolved|passed/i.test(handled), handled);
    const accepted = stageLine({ id: 'E', name: 'Acceptance', type: 'browser', state: 'done', ranAt: t, doneAt: t, doneBy: 'human' }, { ago });
    check('你說驗收過了 → accepted', /accepted/.test(accepted), accepted);
    check('……不准是 verified／tested', !/verified|tested/i.test(accepted), accepted);
    const notYet = line({ state: 'none' });
    eq('這一輪還沒跑 → Not run yet this round(感測器有在記才講)', notYet, 'Not run yet this round');
    const noRec = line({ state: 'none' }, { noRecord: 'No record' });
    check('沒有紀錄 → no record', /no record/i.test(noRec), noRec);
    check('……那一格不准是 not run／never ran／skipped', !/not run|never ran|skipped/i.test(noRec), noRec);
    const nb = line({ state: 'notbuilt' });
    check('這一關還沒建 → not built yet', /not built yet/.test(nb), nb);
    check('……不准是 no record／not run(是工具沒有這一關,不是你沒跑)', !/no record|not run/i.test(nb), nb);
    const nod = stageLine(ST({ id: 'A', name: 'Spec', skill: 'spec', state: 'passed', ranAt: t, nodAt: t, closedBy: 'nod' }), { ago });
    check('算你點頭開工了 → counted as your go-ahead', /counted as your go-ahead/.test(nod), nod);
    check('……不准是 you approved(是推算的,不是你說的,P7)', !/you approved/i.test(nod), nod);
    const who = line({ state: 'done', ranAt: t, doneAt: t, doneBy: null });
    check('分不出是誰說的 → can\'t tell who,不補一個猜的主詞', /can't tell who said it/.test(who) && !/you said|Claude said/i.test(who), who);
    const claude = line({ state: 'done', ranAt: t, doneAt: t, doneBy: 'claude', report: { note: 'no issues found' } });
    check('Claude 說 → Claude said(主詞照中文)', /Claude said/.test(claude) && !/you said/i.test(claude), claude);
  }));
}

section('最上面那一條:講資料多新、連不上整頁承認、時鐘被調過不印負數——英文(「pipeline-ui」AC-1、AC-2 那幾題;AC-5)');
{
  const fresh = describeFreshness({ generatedAt: NOW - 3000, now: NOW, connected: true, lang: 'en' });
  check('新的:Data from HH:MM (3 seconds ago)', /^Data from \d\d:\d\d \(3 seconds ago\)$/.test(fresh.label), fresh.label);
  const stale = describeFreshness({ generatedAt: NOW - 120_000, now: NOW, connected: true, lang: 'en' });
  check('過期:講可能過期(might be out of date),不講成新的', /might be out of date/.test(stale.label) && stale.dim, stale.label);
  const down = describeFreshness({ generatedAt: NOW - 60_000, now: NOW, connected: false, lang: 'en' });
  check('連不上:整頁承認(Disconnected)、講是幾點的資料', /^Disconnected\. What you see is the data from \d\d:\d\d \(1 minute ago\)$/.test(down.label) && down.state === 'disconnected', down.label);
  const skew = describeFreshness({ generatedAt: NOW + 60_000, now: NOW, connected: true, lang: 'en' });
  check('時鐘被調過:講對不上,不印負數', /don't line up/.test(skew.label) && !/-\d/.test(skew.label), skew.label);
  const none = describeFreshness({ generatedAt: NaN, now: NOW, connected: true, lang: 'en' });
  check('沒有時間戳:講不知道,不當成新的', /Can't tell/.test(none.label) && none.state === 'unknown', none.label);
  for (const f of [fresh, stale, down, skew, none]) noZh(`英文:${f.state}`, f.label);
  eq('單複數:1 minute ago', humanAge(60, 'en'), '1 minute ago');
  eq('單複數:2 hours ago', humanAge(7200, 'en'), '2 hours ago');
  eq('中文照舊(沒給語言):3 分鐘前', humanAge(180), '3 分鐘前');
  const clockSkewed = withClock(() => en(() => ago(new Date(Date.now() + 120_000).toISOString())));
  check('lib 的幾分鐘前:時鐘被調過也不印負數(英文)', !/-\d/.test(clockSkewed) && /line up/.test(clockSkewed), clockSkewed);
}

section('五關的其他句子:要不要再跑、花了多久、規格在哪、清單、E 的三句、感測器、故障橫條——英文每一種都沒有中文(AC-3)');
{
  withClock(() => en(() => {
    const t = T(-10 * MIN);
    const said = { text: SAID, ts: t, cut: true };
    const R = (o) => rerunLine({ stage: { id: 'D', verb: 'run' }, ...o }, { ago });
    const W = (o) => rerunLine({ stage: { id: 'E', verb: 'walk' }, ...o }, { ago });
    const lines = [
      R({ state: 'none' }), W({ state: 'none' }),
      R({ state: 'no-report', decision: { why: 'no-words', odd: 2 } }), R({ state: 'no-report', decision: { why: 'owner' } }),
      R({ state: 'skipped', decision: { said }, concluded: false }), W({ state: 'skipped', decision: { said }, concluded: true }),
      R({ state: 'ask', decision: { said } }), W({ state: 'ask' }), R({ state: 'found', concluded: { note: 'found 2 issues\n- x' } }), R({ state: 'found' }),
      tookLine({ minutes: 0.5 }), tookLine({ minutes: 46 }), tookLine({ minutes: 286 }, { unit: 'walk' }),
      noWords(0), noWords(3),
      noRecordLine({ here: 'the bar at the very top' }), noRecordLine({ here: 'x', optedOut: true }), noRecordLine({ here: 'x', now: 'broken' }),
      noRecordLine({ here: 'x', now: 'flaky', mount: 'broken', fix: 'To fix it: show this line to Claude' }), noRecordLine({ here: 'x', mount: 'off' }),
      stagesBrokenLine('"stages" is empty'),
      unknownPromptLine({ count: 4, tags: ['a', 'b', 'c', 'd'] }),
      calledIsNotPassed(),
      linkLine({ name: 'export-button', how: 'only' }),
      clProg({ parsed: true, multi: true, specs: 2, total: 7, checked: 3, pending: 2, unmarked: 2, unreadable: ['x'] }),
      clProg({ parsed: true, batch: ['AC-1'], total: 3, checked: 1, pending: 0, unmarked: 2 }),
      clDoneNote({ multi: true, specs: 2, total: 7, unreadable: ['x'] }),
      checklistWhy({ batchMissing: ['AC-9'] }), checklistWhy({ preMarked: true }), checklistWhy({}),
      checklistHead({ multi: true, parts: [1, 2], total: 7, unreadable: ['x'] }), checklistHead({ missing: true, file: '/r/docs/進行中/export-button.md' }),
      checklistHead({ parsed: false, file: '/r/docs/進行中/export-button.md', head: '# Feature: export button' }),
      checklistPartLine({ name: 'export-button', checklist: { parsed: false, missing: true, file: '/r/docs/進行中/export-button.md' } }),
      checklistPartLine({ name: 'export-button', checklist: { parsed: true, total: 4, checked: 4, pending: 0, unmarked: 0 } }),
      ...Object.values(checklistLines({ parsed: true, batch: ['AC-1', 'AC-2'], allTotal: 6, total: 2, checked: 1, pending: 1, unmarked: 0, preMarked: true })).flat(),
      ...specNotes({ specPlace: { gone: true, found: 'main', name: 'export-button', rel: 'docs/進行中/export-button.md' } }),
      ...specNotes({ specPlace: { gone: true, name: 'export-button', given: 'docs/規劃中/export-button.md' } }),
      ...specNotes({ specPlace: { found: 'main', recordedIn: 'main', name: 'export-button', rel: 'docs/進行中/export-button.md' } }),
      ...specNotes({ specPlace: { found: 'main', name: 'export-button' } }),
      ...specNotes({ specPlace: { found: 'missing', name: 'export-button', given: 'docs/規劃中/export-button.md', recordedIn: 'main' } }),
      ...specNotes({ specPlace: { found: 'missing', name: 'export-button', given: 'docs/規劃中/export-button.md' } }),
      ...specNotes({ specPlace: { found: 'older', name: 'export-button', given: 'a.md', rel: 'docs/進行中/export-button.md' } }),
      ...specNotes({ specPlace: { found: 'outside', name: 'export-button' } }),
      ...specNotes({ specPlace: { found: 'ambiguous', name: 'export-button', where: ['docs/規劃中/export-button.md', 'docs/進行中/export-button.md'] } }),
      ...specNotes({ specPlace: { moved: true, rel: 'docs/進行中/export-button.md', given: 'docs/規劃中/export-button.md' } }),
      ...specNotes({ specPlaces: [{ found: 'outside', name: 'a' }, { found: 'outside', name: 'b' }] }),
      ...specNotes({ side: { name: null, ts: t }, link: { name: 'export-button' } }), ...specNotes({ side: { name: 'a, b', count: 2 } }), ...specNotes({ side: { name: 'a', count: 1 } }),
      ...specNotes({ replaced: { own: true, fromNames: ['a', 'b'], to: 'c' } }), ...specNotes({ replaced: { from: 'a', to: 'c' } }),
      ...specNotes({ earlierSpecs: [{ name: 'old-spec', unmarked: 2 }], ghostSpecs: ['gone', 'lost'], hint: { name: 'export-button', cut: true }, unsure: { name: 'x' }, shared: true, extraSpecs: ['notes'] }),
      ...specNotes({ extraSpecs: ['a', 'b'] }),
      ...faultBanner({ logDir: '/x/logs', retainDays: 90, sensor: { state: 'broken', from: t, count: 3, why: 'jq' }, gateNode: { state: 'broken', from: t, count: 2 }, gateError: { state: 'broken', last: t, count: 1 },
        move: { kinds: ['logs', 'checkpoints'], from: '/old', to: '/new', why: 'EXDEV' } }).map((b) => b.text),
      ...faultBanner({ retainDays: 90, sensor: { state: 'broken', lastGood: t, count: 1 }, gateError: { state: 'unclear', last: t, cwd: '/r/app' }, move: { kinds: ['logs'], from: '/o', to: '/n', both: true } }).map((b) => b.text),
      ...faultBanner({ retainDays: 90, sensor: { state: 'flaky', lastBad: t, count: 4 }, gateError: { state: 'unclear', last: t }, move: { kinds: ['logs'], from: '/o', to: '/n', why: 'EWHAT' } }).map((b) => b.text),
      ...faultNotes({ retainDays: 90, sensor: { state: 'recovered', from: T(-3 * 3600), to: T(-3600) }, gateNode: { state: 'recovered', to: t, count: 2 }, gateError: { state: 'recovered', to: t } }),
      unreadableLine({ unreadable: 2 }),
      ...Object.values(sensorParts({ mount: { where: 'plugin' }, lastSeen: t, gate: { ts: t } })).filter(Boolean),
      sensorParts({ mount: { where: 'main' } }).mounted, sensorParts({ mount: { where: 'user' } }).mounted, sensorParts({}).gate, sensorParts({}).notMounted,
      sensorOffLine({ mount: { state: 'off', optedOut: { at: t } }, days: 90, ago }), sensorOffLine({ mount: { state: 'off', optedOut: {} } }),
      sensorOffLine({ mount: { state: 'off' }, lastSeen: t, now: 'broken', here: 'the bar at the very top', ago }), sensorOffLine({ mount: { state: 'off' }, lastSeen: t, now: 'flaky', here: 'x', ago }),
      gateLine(null), gateLine({ ts: t }), noneHereLine({ hasLog: false }), noneHereLine({ hasLog: true, days: 90 }), noneHereLine({}),
      optedOutLine({ at: t, days: 90 }), optedOutLine({}),
    ];
    for (const l of lines) noZh(`英文:${String(l).slice(0, 60)}`, l);
    const ask = R({ state: 'ask' });
    check('要不要再跑由你決定 → whether to run it again is your call(不是「要再跑」)', /whether to run it again is your call/.test(ask), ask);
    const noRep = R({ state: 'no-report' });
    check('Claude 還沒記結論:講可能還在跑(might),不比證據說得更確定', /might still be running it/.test(noRep), noRep);
    const why = rerunLine({ state: 'ask', decision: { said }, stage: { id: 'D', verb: 'run' } }, { ago });
    check('你說的話照原文、用英文的引號', why.includes(`“${SAID}…”`), why);
  }));
}

section('E 驗收那一格的三句(lib/verify.mjs):開過瀏覽器、Claude 說走了一遍、你說——英文;主詞照中文,Claude 代記不講成你說(AC-3、AC-5)', 'P7');
{
  withClock(() => en(() => {
    const t = T(-20 * MIN);
    const note = ['AC-1 看到了：「Export」button on the toolbar', 'AC-2 沒看到：no download started', 'AC-3 驗不了：needs a real account', 'other-spec AC-1 看到了：x', 'AC-1 看到了：again', 'weird line'].join('\n');
    const base = { id: 'E', name: 'Acceptance', type: 'browser', skill: 'verify', calledAs: 'verify', count: 6, actAt: t, hosts: ['localhost:3000'],
      verify: { expected: ['AC-1', 'AC-2', 'AC-3', 'AC-4'], items: [{ id: 'AC-4', title: 'Shows the file name' }] } };
    const variants = [
      { ...base, state: 'current', ranAt: t, rerun: { state: 'none' } },
      { ...base, state: 'current', ranAt: t, count: 0, rerun: { state: 'no-report', last: { call: { ts: t } } } },
      { ...base, state: 'current', ranAt: t, via: 'typed', rerun: { state: 'no-report', last: { call: { ts: t } } } },
      { ...base, state: 'stale', ranAt: t, report: { note, ts: t }, rerun: { state: 'ask', estate: 'ask' } },
      { ...base, state: 'current', ranAt: t, report: { note, ts: t }, rerun: { state: 'ok', estate: 'ok', took: { latest: true, minutes: 12 } } },
      { ...base, state: 'done', ranAt: t, report: { note, ts: t }, rerun: { state: 'ok', estate: 'accepted' }, accept: { by: 'claude', said: { text: 'looks good, accepted', cut: false }, ts: t } },
      { ...base, state: 'done', ranAt: t, report: { note, ts: t }, rerun: { state: 'ok', estate: 'accepted' }, accept: { by: 'human', ts: t } },
      { ...base, state: 'stale', ranAt: t, report: { note, ts: t }, rerun: { state: 'ok', estate: 'accepted-stale' }, accept: { by: 'human', ts: t, valid: true, stale: true } },
      { ...base, state: 'stale', ranAt: t, report: { note, ts: t }, rerun: { state: 'ok', estate: 'skipped' }, accept: { by: 'human', ts: t, valid: true, stale: true },
        acceptDecision: { covered: true, said: { text: 'no need to walk through again', ts: t } } },
      { ...base, state: 'current', ranAt: t, rerun: { state: 'ok', estate: 'ok' }, report: { note, ts: t }, accept: { rejected: { why: 'no-words', odd: 1 } } },
      { ...base, state: 'current', ranAt: t, rerun: { state: 'ok', estate: 'ok' }, report: { note, ts: t }, accept: { rejected: { why: 'owner' } } },
    ];
    for (const v of variants) {
      const el = eLines(v, { ago });
      for (const k of ['acts', 'walk', 'human']) noZh(`英文:E ${v.rerun?.estate ?? v.rerun?.state}·${k}`, el[k]);
      for (const it of el.items) noZh(`英文:E 一條 ${it.id ?? '(看不懂的)'}`, `${it.mark} ${it.body}${it.note}`, ['看到了', '沒看到', '驗不了']);
      noZh(`英文:E 這一輪到哪 ${v.rerun?.estate}`, eWhere(v) ?? '');
    }
    const claude = eLines(variants[5], { ago }).human;
    check('Claude 代記 → Claude recorded it for you,附你說的原話', /^Claude recorded it for you: you said it's accepted/.test(claude) && claude.includes('“looks good, accepted”'), claude);
    const human = eLines(variants[6], { ago }).human;
    check('你說的 → You said it\'s accepted', /^You said it's accepted/.test(human), human);
    check('……不准是 verified／tested', !/verified|tested/i.test(`${claude} ${human}`), `${claude} ${human}`);
    const walk = eLines(variants[4], { ago }).walk;
    check('Claude 說走了一遍:數字從回報的行數出來,講「Of 4 items」', /Of 4 items: 1 saw it, 1 didn't see it, 1 couldn't check/.test(walk), walk);
    const typed = eLines(variants[2], { ago }).walk;
    check('你自己叫的才講 you;Claude 叫的不補主詞(被動)', /you called \/verify/.test(typed) && /\/verify was called/.test(eLines(variants[1], { ago }).walk), `${typed}\n      ${eLines(variants[1], { ago }).walk}`);
    const items = walkItems(parseWalk(note), base.verify.expected, new Map([['AC-4', 'Shows the file name']]));
    check('驗不了的記號:英文用半形問號,不用全形', items.find((x) => x.id === 'AC-3')?.mark === '?', JSON.stringify(items.find((x) => x.id === 'AC-3')));
    noZh('沒有逐條的結果那一句', summaryLine(walkSummary(parseWalk(''))));
  }));
}

section('畫面(真的跑 ui/app.js,英文那一頁):五關、這一輪走到哪、感測器那一行、最上面那幾條、壞掉的那一頁——沒有中文(AC-3)');
{
  const t = T(-30 * MIN);
  const stages = await en(async () => withClock(() => {
    const L = (st, o) => ({ ...st, line: stageLine(st, { ago, ...o }) });
    return [
      L({ id: 'A', name: 'Spec', skill: 'spec', state: 'passed', ranAt: t, closedBy: 'nod', nodAt: t, calledAs: 'spec', args: SAID,
        notes: ['The spec moved to docs/進行中/export-button.md (recorded as docs/規劃中/export-button.md)'],
        checklist: { parsed: true, total: 2, checked: 1, pending: 1, unmarked: 0, items: [{ id: 'AC-1', title: 'Export button', state: 'checked', plain: 'one click' }, { id: 'AC-2', title: 'File name', state: 'pending', note: 'ask Oscar' }],
          lines: checklistLines({ parsed: true, total: 2, checked: 1, pending: 1, unmarked: 0 }) } }),
      L({ id: 'B', name: 'Code', type: 'main-conversation', state: 'current', ranAt: t }),
      L({ id: 'C', name: 'Cleanup', skill: 'cleanup', state: 'none' }),
      L({ id: 'D', name: 'Chaos check', skill: 'chaos-check', state: 'stale', ranAt: t, rerun: { state: 'ask', stage: { id: 'D', verb: 'run' } }, report: { note: 'found 2 issues\n- one\n- two' } }),
      { id: 'E', name: 'Acceptance', type: 'browser', skill: 'verify', state: 'seen', ranAt: t, count: 4, line: stageLine({ id: 'E', name: 'Acceptance', type: 'browser', state: 'seen', ranAt: t, count: 4 }, { ago }),
        ewhere: eWhere({ estate: 'ok' }), elines: eLines({ id: 'E', type: 'browser', state: 'seen', ranAt: t, count: 4, actAt: t, rerun: { state: 'none' } }, { ago }) },
    ];
  }));
  const latest = { generatedAt: NOW, projects: [], sharedLines: { calledNotPassed: en(() => calledIsNotPassed()) }, stampHelp: {}, faults: { banner: [], blind: false }, lang: 'en', langNote: null };
  const ui = uiOf(latest, { lang: 'en' });
  eq('這一頁是英文(<html data-lang="en">)', ui.LANG, 'en');
  const wf = ui.workflow({ path: '/r/app', project: 'app', stages });
  noZh('五關(拿掉標籤之後)', strip(wf));
  check('……title 那幾個燈的說明也是英文(看不見,但滑鼠移上去看得到)', !CJK.test(stripData([...wf.matchAll(/title="([^"]*)"/g)].map((m) => m[1]).join(' '))), [...wf.matchAll(/title="([^"]*)"/g)].map((m) => m[1]).join(' | '));
  check('E 那一格有「你說驗收過了」的按鈕,英文寫 You say it\'s accepted', wf.includes("You say it's accepted"), strip(wf).slice(0, 200));
  check('工班說明是英文(The architect draws the plans)', wf.includes('The architect draws the plans'), strip(wf).slice(0, 200));
  for (const s of [stages, [{ ...stages[3], state: 'held' }], [{ ...stages[3], rerun: { state: 'found' } }], [{ ...stages[3], rerun: { state: 'no-report' } }], [{ ...stages[1], state: 'done', checklist: { unreadable: ['x'] } }], [{ ...stages[4], state: 'done' }], []]) {
    noZh(`這一輪走到哪:${ui.roundWhere(s)}`, ui.roundWhere(s));
  }
  const sensors = [
    { sensor: { mount: { state: 'broken' } } },
    { sensor: { mount: { state: 'broken' }, lines: en(() => sensorParts({ lastSeen: t })), fix: 'To fix it: show this line to Claude' } },
    { sensor: { mount: { state: 'ok' } } },
    { sensor: { mount: { state: 'ok' }, noneLine: null, lines: en(() => withClock(() => sensorParts({ mount: { where: 'plugin' }, lastSeen: t, gate: null }))) } },
    { sensor: { mount: { state: 'off' }, offLine: null, lines: en(() => sensorParts({ notMountedHow: '. Run pipeline-status --on in that folder.' })) } },
    { sensor: {} },
  ];
  for (const c of sensors) noZh(`感測器那一行(${c.sensor.mount?.state ?? '設定裡找不到'})`, strip(ui.sensorLine(c)));
  noZh('舊的服務:故障那一條看不到', strip(uiOf({ projects: [] }, { lang: 'en' }).faultBanner()));
  noZh('舊的服務:有幾句畫不出來', strip(uiOf({ projects: [] }, { lang: 'en' }).oldServerBanner()));
  noZh('畫面講「服務還在跑舊的程式」的那一格', ui.OLD_LINE);
  for (const r of Object.values(ui.ROLE)) noZh(`工班:${r.house}`, `${r.house} ${r.does}`);
  noZh('幾分鐘前、時鐘對不上', `${ui.ago(T(-30))} ${ui.ago(T(-7200))} ${ui.ago('not a time')} ${ui.clock('not a time')}`);
  // 壞掉的那一頁:畫面自己的錯,照實講(英文)
  const broken = uiOf({ generatedAt: NOW, projects: [{ name: 'x', sessions: null }], lang: 'en' }, { lang: 'en' });
  broken.loc.hash = '#/p/x';
  broken.safeRender();
  noZh('這一頁的畫面壞了(英文)', strip(broken.els.app.innerHTML));
  check('……講是儀表板自己的問題,不是資料斷線', /not a lost connection/.test(broken.els.app.innerHTML), broken.els.app.innerHTML);
}

section('終端機(真的跑 status.mjs,英文):五關那一段沒有中文、不准出現全形空白;資料照原文(AC-3)');
{
  const r = makeRepo({ at: T(-60 * MIN), files: { 'src/app.js': '1\n', 'docs/進行中/export-button.md': '# Feature: export button\n\n**AC-1　Export button** ✅ 對過 2026-10-29\n> **白話**：one click\n\n**AC-2　File name**\n' } });
  const root = git(r.dir, 'rev-parse', '--show-toplevel');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-lang-data-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(ROOT, join(home, '.claude', 'skills', PLUGIN));
  const log = join(monitorDir, 'logs', `${safeName(basename(root))}.jsonl`);
  const ev = (o) => JSON.stringify({ session: 's1', cwd: root, ...o });
  writeFileSync(log, [
    ev({ ts: T(-50 * MIN), hook: 'UserPromptSubmit', prompt: `${SAID} (see docs/進行中/export-button.md)` }),
    ev({ ts: T(-49 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:spec` }),
    ev({ ts: T(-40 * MIN), event: 'stage_report', stage: 'A', verdict: 'ok', note: 'docs/進行中/export-button.md', source: 'claude' }),
    ev({ ts: T(-30 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(root, 'src/app.js') }),
    ev({ ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:chaos-check` }),
    ev({ ts: T(-15 * MIN), event: 'stage_report', stage: 'D', verdict: 'found', note: 'found 1 issue\n- the export button ignores errors', source: 'claude' }),
    ev({ ts: T(-10 * MIN), hook: 'PreToolUse', tool: 'mcp__Claude_Browser__navigate', in_url: 'http://localhost:3000/' }),
  ].join('\n') + '\n');
  writeFileSync(join(root, 'src/app.js'), '2\n');
  writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang: 'en' }));
  const run = () => {
    const { CLAUDE_CODE_SESSION_ID: _drop, ...env } = process.env;
    try { return execFileSync('node', [join(ROOT, 'status.mjs')], { cwd: root, encoding: 'utf8', env: { ...env, HOME: home, PIPELINE_MONITOR_HOME: monitorDir, PIPELINE_MONITOR_LOG_DIR: join(monitorDir, 'logs') } }); }
    catch (e) { return `失敗：${e.stdout}${e.stderr}`; }
  };
  const out = run();
  // 五關那一段:到下一段(分級)的標題為止——分級那一段是第 ③ 段的事
  const from = out.indexOf('━━ Five stages ━━');
  const next = out.indexOf('\n━━ ', from + 5);
  const stagesPart = out.slice(from, next === -1 ? undefined : next);
  check('有英文的五關那一段', out.includes('━━ Five stages ━━'), out);
  noZh('五關那一段沒有中文(資料夾名照原文)', stagesPart);
  check('……沒有全形空白(U+3000)', !stagesPart.includes('\u3000'), stagesPart);
  check('……關卡用英文的名字(A Spec、D Chaos check、E Acceptance,不叫 Verify)', /A Spec/.test(stagesPart) && /D Chaos check/.test(stagesPart) && /E Acceptance/.test(stagesPart) && !/\bVerify\b/.test(stagesPart), stagesPart);
  check('……Claude 的結論照原文', stagesPart.includes('found 1 issue'), stagesPart);
  writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang: 'zh' }));
  const zh = run();
  check('換回中文:五關那一段照舊是中文', zh.includes('━━ 五關 ━━') && zh.includes('D 魔鬼教官'), zh);
  for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('關卡的英文名(stages.json 的 nameEn):五關照 Oscar 點頭的那五個;專案自己覆寫的關卡名照它寫的印(資料,不翻)');
{
  const names = en(() => loadStages(ROOT, tmpdir()).stages.map((s) => `${s.id} ${s.name}`).join(' / '));
  eq('五關的英文名', names, 'A Spec / B Code / C Cleanup / D Chaos check / E Acceptance');
  eq('中文照舊', loadStages(ROOT, tmpdir()).stages.map((s) => s.name).join('、'), '寫規格、寫程式、打掃、魔鬼教官、驗收');
  const proj = mkdtempSync(join(tmpdir(), 'pm-proj-'));
  mkdirSync(join(proj, '.claude'));
  writeFileSync(join(proj, '.claude', 'pipeline-stages.json'), JSON.stringify({ stages: [{ id: 'A', name: '寫需求', skill: 'spec' }, { id: 'Z', name: 'Ship', nameEn: 'Ship it', skill: 'ship' }] }));
  eq('專案自己覆寫的:英文的時候照它寫的印;它自己寫了 nameEn 才換', en(() => loadStages(ROOT, proj).stages.map((s) => s.name).join(' / ')), '寫需求 / Ship it');
  rmSync(proj, { recursive: true, force: true });
}

/* ════════════ 第二段:儀表板其餘的卡(還原點、三階梯、存檔與蓋章、分級、案件、對話、建議卡) ════════════ */

/** 英文的整頁資料:檔名、分支、標題、你說的話、Claude 的結論都用英文;伺服器那幾句照 lib 在英文底下算(跟真的伺服器一樣) */
function enWorld() {
  return en(() => withClock(() => {
    const t = (min) => T(-min * MIN);
    const stages = loadStages(ROOT, tmpdir()).stages;
    const scope = changeScope({ kind: 'origin', origin: { at: t(90), from: 'prompt', sessions: 2 }, commits: 3 }, ago);
    const files = {
      total: 5,
      unsaved: { count: 3, groups: [{ dir: 'src', items: [{ name: 'export.js', isNew: true }, { name: 'button.js' }, { name: 'menu.js' }] }] },
      saved: { count: 2, groups: [{ dir: en(() => '(top folder)'), items: [{ name: 'README.md' }, { name: 'package.json' }] }] },
    };
    const reqs = requirementStatus(['A', 'C', 'D', 'tests'], { stages, ago, health: { touchedTests: 2 },
      perStage: new Map([['A', { ts: t(80) }], ['C', { ts: t(40) }]]), cleared: new Map(),
      reports: new Map([['A', { ts: t(70), verdict: 'ok', note: 'docs/進行中/export-button.md' }]]),
      rerun: new Map([['D', { state: 'ask', last: { call: { ts: t(30) } }, stage: { id: 'D', verb: 'run' } }]]) });
    const tierOk = { state: 'ok', levels: { danger: { id: 'T2' } }, basis: { kind: 'head', why: 'no-origin' }, dangerEmpty: true,
      machine: { id: 'T1', rank: 1, hits: { code: ['src/export.js', 'src/button.js'], danger: [] } }, manual: { id: 'T2', why: 'touches saving', ts: t(20) },
      manualIgnored: { id: 'T1', ts: t(50) }, final: { id: 'T2', requires: ['A', 'C', 'D', 'tests'] }, requirements: reqs,
      candidates: ['src/save.js', 'src/sync.js', 'src/store.js', 'src/db.js'], staleNotes: [], upgradable: [] };
    const sensor = { mount: { state: 'ok', where: 'plugin' }, noneLine: null, lines: sensorParts({ mount: { where: 'plugin' }, lastSeen: t(5), gate: { ts: t(4) } }) };
    const card = {
      path: '/work/export-app', project: 'export-app', branch: 'feature/export-button', gone: false, notGit: false,
      checkpoint: { at: t(180), commit: 'abc1234def', checks: ['test', 'lint'] }, checkpointRelation: { state: 'ok', commitsAfter: 2 },
      backupBranch: backupBranchName(), cpVersion: '1.4.0', dirty: 3,
      ladder: { mainName: 'main', uncommitted: 3, webUrl: 'https://github.com/x/export-app',
        steps: ladderSteps({ uncommitted: 3, unmerged: 2, onMain: false, mainName: 'main', mainHasUpstream: true, mainUnpushed: 1 }) },
      files, scope, scale: { median: 4, max: 18 },
      lines: cardLines({ stamped: true, relation: { state: 'ok' }, scale: { median: 4, max: 18 }, commitsNote: scope.commitsNote, unsaved: 3, dirty: 3 }),
      tier: { ...tierOk, lines: tierLines(tierOk, { ago }) }, sensor, stages: [],
    };
    const sess = (o) => ({ id: 's1', title: 'Export button', prompts: 12, lastTs: t(3), closedAt: null, cwd: card.path, card, stages: [], tier: null, ...o });
    const cards = [
      { id: 'c1', ts: t(60), source: 'claude', title: 'Write the README', prompt: 'Write a README for the export button\nsecond line', cut: [] },
      { id: 'c2', ts: t(55), source: 'app', session: 's1', fromTitle: 'Export button', title: 'Check the old exporter', tldr: 'see if anything still uses it', prompt: 'Check whether the old exporter is still used', cut: ['prompt', 'tldr', 'title'],
        openIn: { project: 'other-app', name: 'other-app' }, withdrawals: [{ reason: 'done already' }, { reason: null }, { reason: 'premise changed', cut: true }, { reason: 'x' }], opens: [{}] },
      { id: 'c3', ts: t(50), source: 'app', ask: 'offer', session: 's1', fromTitle: 'Export button', title: 'Clean up the CSS', prompt: 'Clean up the CSS\n\nraised in another conversation', said: { text: 'please tidy the styles later', cut: true }, workedAfter: true },
      { id: 'c4', ts: t(45), source: 'app', ask: 'offer', session: 's1', title: 'Add a dark mode', prompt: '', said: null, brief: { via: 'same-title' } },
      { id: 'c5', ts: t(44), source: 'app', ask: 'offer', session: 's1', title: 'Add icons', prompt: 'x', brief: { via: 'brief' }, openIn: { name: 'icons-folder' } },
      { id: 'c6', ts: t(40), source: 'claude', title: 'Started one', prompt: 'p', startedBy: 's9', startedTitle: 'Started conversation', startedProject: { project: 'other-app', name: 'other-app' }, dismissedAt: t(30) },
      { id: 'c7', ts: t(39), source: 'claude', title: 'Started elsewhere', prompt: 'p', startedBy: 's8' },
      { id: 'c8', ts: t(38), source: 'app', ask: 'offer', title: 'Superseded', prompt: 'p', supersededAt: t(20), dismissedAt: t(10) },
      { id: 'c9', ts: t(37), source: 'claude', title: 'Dropped', prompt: '', tldr: 'nothing to paste', dismissedAt: t(5) },
      { id: 'c10', ts: t(36), source: 'claude', title: 'Empty', prompt: '' },
      { id: 'c11', ts: t(35), source: 'app', title: 'Open elsewhere', prompt: 'p', openIn: {} },
    ];
    const project = {
      name: 'export-app', displayName: 'export-app', mainRoot: '/work/export-app', optedOut: null, cards: [card], appCardsSince: t(2000),
      incomingSuggestions: [{ project: 'other-app', name: 'other-app', count: 2 }, { project: 'third', count: 1 }],
      sessions: [
        sess({ sharesCwd: true, reopenedByActivity: t(2), tier: card.tier }),
        sess({ id: 's2', title: null, card: { ...card, gone: true }, closedAt: t(500) }),
        sess({ id: 's3', title: 'Handed over', movedOn: { at: t(300) }, closedAt: t(400) }),
        sess({ id: 's4', title: 'Deleted one', deletedAt: t(100), closedAt: t(100) }),
        ...[5, 6, 7, 8, 9, 10].map((n) => sess({ id: `s${n}`, title: `Closed conversation number ${n} with a long title`, closedAt: t(n * 100) })),
      ],
      suggestions: cards,
    };
    const empty = { name: 'quiet-app', displayName: 'quiet-app', mainRoot: '/work/quiet-app', optedOut: { at: t(9000) }, optedOutLine: optedOutLine({ at: t(9000), days: 90 }),
      cards: [], sessions: [], suggestions: [], emptyLine: noRecordLine({ here: 'the bar at the very top', optedOut: true }), noRecords: true, appCardsSince: null };
    const oldOne = { name: 'old-app', displayName: 'old-app', mainRoot: '/work/old-app', optedOut: { at: null }, cards: [], sessions: [], suggestions: [] };
    return { generatedAt: NOW, retainDays: 90, lang: 'en', langNote: null, projects: [project, empty, oldOne], faults: { banner: [], blind: false },
      sharedLines: { calledNotPassed: calledIsNotPassed() }, stampHelp: { commit: 'commit: …', stamp: 'stamp (pipeline-status --checkpoint): …', order: 'Always commit before stamping' },
      appCardTools: { oldLast: t(3000), newFirst: t(2500), unknown: [{ tool: 'mcp__ccd_session__brand_new', first: t(100) }] } };
  }));
}

section('英文那一頁(真的跑 ui/app.js):案件列表、專案頁、對話頁、建議卡、退出記錄——每一頁都沒有中文(AC-3)');
{
  const world = enWorld();
  const ui = uiOf(world, { lang: 'en' });
  const pages = ['#/', '#/p/export-app', '#/p/export-app/s/s1', '#/p/export-app/s/s2', '#/p/export-app/s/s3', '#/p/quiet-app', '#/p/old-app', '#/p/nope', '#/p/export-app/s/nope'];
  for (const h of pages) {
    ui.loc.hash = h;
    ui.render();
    noZh(`英文:${h}(頁面)`, strip(`${ui.els.crumb.innerHTML} ${ui.els.app.innerHTML}`));
    const attrs = [...ui.els.app.innerHTML.matchAll(/(?:title|placeholder)="([^"]*)"/g)].map((m) => m[1]).join(' | ');
    noZh(`英文:${h}(滑鼠移上去看得到的字、輸入框的提示)`, attrs);
  }
  // 舊的服務(沒給新欄位)那幾種:講服務還在跑舊的程式,英文
  const olds = uiOf({ generatedAt: NOW, projects: [{ name: 'p', mainRoot: '/p', optedOut: { at: T(-60) }, cards: [], sessions: [], suggestions: [] }], lang: 'en' }, { lang: 'en' });
  olds.loc.hash = '#/p/p';
  olds.render();
  noZh('英文:舊的服務(沒有 emptyLine、appCardsSince、optedOutLine、appCardTools)', strip(olds.els.app.innerHTML));
  ui.loc.hash = '#/';
  noZh('英文:還沒有任何案件', strip(uiOf({ generatedAt: NOW, projects: [], lang: 'en' }, { lang: 'en' }).projectList()));
  noZh('英文:舊的紀錄還沒搬過來', strip(uiOf({ generatedAt: NOW, projects: [], faults: { moving: true }, lang: 'en' }, { lang: 'en' }).projectList()));
}

section('還原點、三階梯、存檔與蓋章、分級:每一種狀態英文都沒有中文;用語對照那幾列(AC-3、AC-5)', 'P5');
{
  const world = enWorld();
  const ui = uiOf(world, { lang: 'en' });
  const card = world.projects[0].cards[0];
  const p = world.projects[0];
  const L = (o) => en(() => withClock(() => cardLines({ stamped: true, relation: { state: 'ok' }, ...o })));
  // 還原點
  const restores = {
    none: ui.statRestore({ ...card, checkpoint: null, lines: L({ stamped: false }) }),
    broken: ui.statRestore({ ...card, checkpointRelation: { state: 'off-branch' }, lines: L({ relation: { state: 'off-branch' } }) }),
    gone: ui.statRestore({ ...card, checkpointRelation: { state: 'gone' }, lines: L({ relation: { state: 'gone' } }) }),
    unknown: ui.statRestore({ ...card, checkpointRelation: null, lines: L({ relation: null }) }),
    ok: ui.statRestore(card),
    clean: ui.statRestore({ ...card, dirty: 0, lines: L({ dirty: 0 }) }),
    dunno: ui.statRestore({ ...card, dirty: null, lines: L({ dirty: null }) }),
    old: ui.statRestore({ ...card, lines: null }),
  };
  for (const [k, h] of Object.entries(restores)) noZh(`英文:還原點 ${k}`, strip(h));
  check('還沒有還原點 → 「doesn\'t mean you have no good version, only that I haven\'t asked」(AC-5)', restores.none.includes(en(() => noStampYet())) && /haven't asked/.test(restores.none), strip(restores.none));
  check('還原點那一格不准叫 backup／safe version(標題與小字)', !/backup|safe version/i.test(strip(restores.ok).split('Copy')[0].replace(/backup-\d/g, '')), strip(restores.ok));
  check('檢查全綠 → all checks green 那一句照講不等於功能正確', restores.ok.includes(en(() => greenIsNotCorrect())), strip(restores.ok));
  const greenOnly = strip(restores.ok).replace(en(() => greenIsNotCorrect()), '');
  check('……全綠那一行(拿掉「不等於功能正確」那一句)不准講 works／passed／verified／safe(P4:否定的那一句要放過)', !/\bworks\b|passed|verified|\bsafe\b/i.test(greenOnly), greenOnly);
  check('一個都沒有就不掛 ⚠️(P10)', !/⚠️ There are no uncommitted/.test(restores.clean) && /There are no uncommitted files right now/.test(restores.clean), strip(restores.clean));
  check('問不到照樣掛 ⚠️、講 couldn\'t check(問不到 ≠ 沒有)', /⚠️ Couldn't check whether you have files not committed yet/.test(strip(restores.dunno)), strip(restores.dunno));
  // 三階梯
  const ladders = [
    { uncommitted: null, unmerged: null, onMain: false, mainName: null },
    { uncommitted: 0, unmerged: 0, onMain: true, mainName: 'main', mainHasUpstream: false },
    { uncommitted: 0, unmerged: 0, onMain: false, mainName: 'main', mainHasUpstream: true, mainUnpushed: null, mergedIntoMain: true, atMainTip: false },
    { uncommitted: 0, unmerged: 0, onMain: false, mainName: 'main', mainHasUpstream: true, mainUnpushed: 0, mergedIntoMain: true, atMainTip: true },
    { uncommitted: 0, unmerged: 0, onMain: false, mainName: 'main', mainHasUpstream: true, mainUnpushed: 0, branchMoved: false, atMainTip: false },
    { uncommitted: 0, unmerged: 0, onMain: false, mainName: 'main', mainHasUpstream: true, mainUnpushed: 0, branchMoved: false, atMainTip: true },
    { uncommitted: 0, unmerged: 0, onMain: false, mainName: 'main', mainHasUpstream: true, mainUnpushed: 0, atMainTip: false },
    { uncommitted: 0, unmerged: 0, onMain: false, mainName: 'main', mainHasUpstream: true, mainUnpushed: 0 },
    { uncommitted: 0, unmerged: null, onMain: false, mainName: 'main', mainHasUpstream: true, mainUnpushed: 2 },
  ];
  for (const [i, a] of ladders.entries()) noZh(`英文:三階梯 ${i}`, strip(ui.statLadder({ ...card, ladder: { mainName: a.mainName, steps: en(() => ladderSteps(a)) } })));
  noZh('英文:三階梯(舊的服務沒給)', strip(ui.statLadder({ ...card, ladder: {} })));
  check('還沒 commit → not committed yet,不准 unsaved', /3 files not committed yet/.test(strip(ui.statLadder(card))) && !/unsaved/i.test(strip(ui.statLadder(card))), strip(ui.statLadder(card)));
  // 存檔與蓋章卡(先講commit再講蓋章那幾種狀況)
  const sc = (o) => en(() => withClock(() => changeScope(o, ago)));
  const f0 = { total: 0, unsaved: { count: 0, groups: [] }, saved: { count: 0, groups: [] } };
  const stamped = sc({ kind: 'checkpoint', commits: 4 });
  const changes = {
    '還有沒 commit 的(另外 2 個收著)': ui.statChanges(card),
    '還有沒 commit 的(看不到 commit 過的)': ui.statChanges({ ...card, scope: sc({ kind: 'head', why: 'no-origin' }) }),
    '都 commit 了、還沒蓋章': ui.statChanges({ ...card, scope: stamped, files: { total: 2, unsaved: { count: 0, groups: [] }, saved: card.files.saved } }),
    '沒有能用的章(只算這一輪)': ui.statChanges({ ...card, files: { total: 2, unsaved: { count: 0, groups: [] }, saved: card.files.saved } }),
    '找不到這一輪的起點': ui.statChanges({ ...card, scope: sc({ kind: 'head', why: 'not-found' }), files: f0 }),
    '一個 commit 都沒有': ui.statChanges({ ...card, scope: sc({ kind: 'head', why: 'no-commits' }), files: f0 }),
    '問不到': ui.statChanges({ ...card, files: { total: 0, unsaved: null, saved: null } }),
    '重新蓋章之後(跟章一模一樣)': ui.statChanges({ ...card, scope: stamped, files: f0 }),
    '中間存過檔、切過分支(看不全)': ui.statChanges({ ...card, scope: sc({ kind: 'origin', moved: true, origin: { at: T(-60), from: 'A' } }), files: f0 }),
    '連改動都問不到': ui.statChanges({ ...card, files: null }),
    '舊的服務': ui.statChanges({ ...card, files: { total: 1 } }),
  };
  for (const [k, h] of Object.entries(changes)) noZh(`英文:存檔與蓋章 ${k}`, strip(h));
  check('標題固定 Commit & stamp,小字固定 Committed? Stamped?(Oscar 10/29 點頭)', Object.values(changes).every((h) => h.includes('Commit &amp; stamp') && h.includes('Committed? Stamped?')));
  const dunno = strip(changes['問不到']);
  check('問不到 → couldn\'t check;不准出現 everything is committed、not stamped yet(AC-5)', /Couldn't check/.test(dunno) && !/everything is committed|all committed|not stamped yet/i.test(dunno), dunno);
  check('還有沒 commit 的:大字講 3 files not committed yet,收著的講 2 more files committed, not stamped yet', /3 files not committed yet/.test(strip(changes['還有沒 commit 的(另外 2 個收著)']))
    && /2 more files committed, not stamped yet/.test(strip(changes['還有沒 commit 的(另外 2 個收著)'])), strip(changes['還有沒 commit 的(另外 2 個收著)']));
  check('都 commit 了:講 not stamped yet,不准 approved／certified', /2 files not stamped yet/.test(strip(changes['都 commit 了、還沒蓋章'])) && !/approved|certified/i.test(Object.values(changes).map(strip).join(' ')), strip(changes['都 commit 了、還沒蓋章']));
  check('看不全 → can\'t see all of it(P5:0 不是沒有改動)', /Can't see all of it/.test(strip(changes['中間存過檔、切過分支(看不全)'])), strip(changes['中間存過檔、切過分支(看不全)']));
  check('存檔與蓋章卡不准講 unsaved(檔案在你電腦上是存了的,L45)', !/unsaved/i.test(Object.values(changes).map(strip).join(' ')));
  // 分級卡
  const tl = (t) => ({ ...t, lines: en(() => withClock(() => tierLines(t, { ago }))) });
  const tiers = {
    unset: tl({ state: 'unset' }), off: tl({ state: 'off', off: { at: T(-3600), why: 'docs only' } }), broken: tl({ state: 'broken', from: '/w/.claude/pipeline-stages.json', why: 'x' }),
    noBase: tl({ state: 'no-base' }), unknown: tl({ state: 'unknown' }), noChange: tl({ state: 'no-change', dangerEmpty: true, levels: { danger: { id: 'T2' } } }),
    unseen: tl({ state: 'unseen', basis: { kind: 'head', why: 'not-found' } }), weird: tl({ state: 'weird' }), ok: card.tier,
    machine: tl({ ...card.tier, manual: null, manualIgnored: null, upgradable: ['T2'], machine: { id: 'T2', rank: 2, hits: { code: [], danger: ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'] } } }),
  };
  for (const [k, t] of Object.entries(tiers)) noZh(`英文:分級卡 ${k}`, strip(ui.statTier({ ...card, tier: t }, p)));
  noZh('英文:分級卡(舊的服務沒給那幾句)', strip(ui.statTier({ ...card, tier: { ...card.tier, lines: null } }, p)));
  const unset = strip(ui.statTier({ ...card, tier: tiers.unset }, p));
  check('還沒設定 → Not set up yet,不准變成 T0(R1)', /Not set up yet/.test(unset) && !/T0/.test(unset), unset);
  const noChange = strip(ui.statTier({ ...card, tier: tiers.noChange }, p));
  check('危險清單是空的 → 講明永遠不會出現第三級(will never come up)', /danger list is empty, so T2 will never come up/.test(noChange), noChange);
  const ok = strip(ui.statTier({ ...card, tier: tiers.ok }, p));
  check('你調高的 → you said T2(主詞照中文);機器算的 → the machine worked out', /you said T2/.test(ok) && /machine worked out T1/.test(ok), ok);
  check('「需要」那幾行:跑過講 ran 加多久,Claude 說的講 Claude said,不准 passed', /ran [^;]+ ago; Claude said/.test(ok) && !/passed/i.test(ok.replace(/"called", not "passed"/g, '')), ok);
  check('只看得到還沒 commit 的:講實際可能更高(might)', /might really be higher/.test(ok), ok);
  check('分級卡英文的「需要」:補測試 → Add tests', /Add tests/.test(ok), ok);
  check('調高的表單:理由的提示是英文', /placeholder="Reason \(required\)"/.test(ui.statTier({ ...card, tier: tiers.machine }, p)), ui.statTier({ ...card, tier: tiers.machine }, p));
}

section('建議卡那一區(英文):誰叫的、看不到的、已開始、收回、你說不做了——主詞照中文,不補猜的(AC-3、AC-5)', 'P7');
{
  const world = enWorld();
  const ui = uiOf(world, { lang: 'en' });
  const p = world.projects[0];
  const html = ui.suggestionsBlock(p);
  noZh('英文:建議卡那一區', strip(html));
  check('當場問的卡:講 Claude raised,不講 you were asked／you answered(看不到你按了哪個鈕)', /Claude raised a card asking you on the spot/.test(html) && !/you answered|you were asked|you cancel/i.test(strip(html)), strip(html).slice(0, 400));
  check('你那時說的話照原文、用英文的引號', html.includes('“please tidy the styles later…”'), strip(html));
  check('Claude 叫了收回:講 tried to withdraw、分不出是不是這一張(不講成收回成功)', /tried to withdraw a suggestion card 4 times/.test(html) && /Can't tell whether it was this card/.test(html), strip(html));
  check('湊的那段講明是監視器湊的,不是 Claude 寫的', /put together by the monitor from the title, not written by Claude/.test(html), strip(html));
  const none = (since) => strip(ui.suggestionsBlock({ ...p, suggestions: [], appCardsSince: since }));
  for (const v of [undefined, null, T(-600)]) noZh(`英文:一張建議卡都沒有(appCardsSince=${v})`, none(v));
  check('一張都沒有:講「不代表沒跳過」那幾種(which doesn\'t mean none popped up)', /doesn't mean none popped up/.test(none(null)), none(null));
}

/* ════════════ 第三段:終端機(你自己會打的每個指令,英文) ════════════ */

section('終端機(真的跑 status.mjs,英文):現況、--checkpoint、--clear、--tier、--on／--off、--install、--serve-status——每一種結果都沒有中文、沒有全形空白(AC-3)');
{
  const r = makeRepo({ at: T(-90 * MIN), pkg: { name: 'export-app', scripts: { test: 'node -e "process.exit(0)"' } }, files: { 'src/app.js': '1\n', 'src/save.js': 's\n',
    '.claude/pipeline-stages.json': JSON.stringify({ tiers: { code: ['src/'], danger: ['src/save.js'] } }) } });
  const root = git(r.dir, 'rev-parse', '--show-toplevel');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-lang-data-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang: 'en' }));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  writeFileSync(join(monitorDir, 'logs', `${safeName(basename(root))}.jsonl`), [
    { ts: T(-60 * MIN), hook: 'UserPromptSubmit', prompt: SAID },
    { ts: T(-50 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(root, 'src/app.js') },
    { ts: T(-20 * MIN), hook: 'PreToolUse', tool: 'mcp__Claude_Browser__navigate', in_url: 'http://localhost:3000/' },
  ].map((o) => JSON.stringify({ session: 's1', cwd: root, ...o })).join('\n') + '\n');
  const run = (args, { cwd = root, sid = null, env = {} } = {}) => {
    const { CLAUDE_CODE_SESSION_ID: _drop, ...base } = process.env;
    const e = { ...base, HOME: home, PIPELINE_MONITOR_HOME: monitorDir, PIPELINE_MONITOR_LOG_DIR: join(monitorDir, 'logs'), ...(sid ? { CLAUDE_CODE_SESSION_ID: sid } : {}), ...env };
    try { return execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd, encoding: 'utf8', env: e, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (x) { return `${x.stdout ?? ''}${x.stderr ?? ''}`; }
  };
  const outs = {};
  writeFileSync(join(root, 'src/app.js'), '2\n');
  outs['現況(沒有還原點、有沒 commit 的檔)'] = run([]);
  outs['--checkpoint(還有沒 commit 的)'] = run(['--checkpoint']);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'export button');
  outs['--checkpoint(全綠,蓋章)'] = run(['--checkpoint']);
  writeFileSync(join(root, 'src/save.js'), 'changed\n');
  writeFileSync(join(root, 'src/new.js'), 'n\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'more');
  writeFileSync(join(root, 'src/app.js'), '3\n');
  outs['現況(章之後又 commit、又改了,碰到危險清單)'] = run([]);
  outs['--tier(沒給等級)'] = run(['--tier']);
  outs['--tier T1(比機器算的低)'] = run(['--tier', 'T1', 'just because']);
  outs['--clear D(不是驗收那一關)'] = run(['--clear', 'D']);
  outs['--clear X(認不出)'] = run(['--clear', 'X']);
  outs['--clear E(你自己的終端機)'] = run(['--clear', 'E']);
  outs['--clear E(在對話裡跑、沒附話)'] = run(['--clear', 'E'], { sid: 's1' });
  outs['--clear E(Claude 代記、附了話)'] = run(['--clear', 'E', 'looks good, accepted'], { sid: 's1' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'export-app', scripts: { test: 'node -e "console.error(\'boom\'); process.exit(1)"' } }));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'break the test');
  outs['--checkpoint(跑了沒過)'] = run(['--checkpoint']);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'export-app', scripts: {} }));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'no checks');
  outs['--checkpoint(認不出要跑哪些檢查)'] = run(['--checkpoint']);
  outs['--off(沒裝 plugin:舊接法)'] = run(['--off']);
  outs['--on(沒裝 plugin:舊接法)'] = run(['--on']);
  outs['--on(再一次:已經掛上了)'] = run(['--on']);
  outs['--install'] = run(['--install']);
  outs['--install(再一次)'] = run(['--install']);
  outs['--off(plugin 裝好了:退出記錄)'] = run(['--off']);
  outs['現況(退出記錄之後)'] = run([]);
  outs['--on(plugin 裝好了:重新加入)'] = run(['--on']);
  outs['--uninstall'] = run(['--uninstall']);
  outs['--uninstall(再一次)'] = run(['--uninstall']);
  outs['--serve-status(假的家:沒裝)'] = run(['--serve-status']);
  const bare = mkdtempSync(join(tmpdir(), 'pm-bare-'));
  execFileSync('git', ['init', '-q'], { cwd: bare });
  outs['一個 commit 都沒有的專案'] = run([], { cwd: bare });
  outs['一個 commit 都沒有的專案 --checkpoint'] = run(['--checkpoint'], { cwd: bare });
  outs['不是 git 專案'] = run([], { cwd: tmpdir() });
  for (const [k, o] of Object.entries(outs)) {
    noZh(`英文:${k}`, o);
    check(`……${k}:沒有全形空白(U+3000)`, !o.includes('　'));
    check(`……${k}:不印程式的錯誤(TypeError、undefined、null)`, !/TypeError|ReferenceError|\bundefined\b|\bnull\b/.test(o), o.slice(0, 400));
  }
  const v = outs['現況(章之後又 commit、又改了,碰到危險清單)'];
  check('還原點:Last time all checks were green,講不等於功能正確;不講 passed／works', /Last time all checks were green/.test(v) && v.includes(en(() => greenIsNotCorrect())), v);
  check('……「通過的是」不翻成 passed(檢查全綠不准翻成 passed)', !/The ones that passed|passed:/.test(v), v);
  check('……回去的指令照舊在(章之後有 commit:先留備份分支,英文的名字)', /git branch backup-\d{4}-/.test(v) && /git reset --hard/.test(v), v);
  check('……還沒 commit 的那一句:not committed yet,不准 unsaved', /not committed yet/.test(v) && !/unsaved/i.test(v), v);
  check('分級:碰到危險清單 → T2,「需要」那幾行英文(Needs:),不准 passed', /T2/.test(v) && /Needs:/.test(v) && !/passed/i.test(v.slice(v.indexOf('━━ Tier'))), v.slice(v.indexOf('━━ Tier')));
  check('--checkpoint 跑了沒過:講 ran and failed,不蓋章', /ran and failed\. No stamp\./.test(outs['--checkpoint(跑了沒過)']), outs['--checkpoint(跑了沒過)']);
  check('--checkpoint 認不出檢查:講是我沒問到,不是沒有檢查', /"I couldn't find out", not "this project has no checks"/.test(outs['--checkpoint(認不出要跑哪些檢查)']), outs['--checkpoint(認不出要跑哪些檢查)']);
  check('--clear E(你自己的終端機):講你說的,不是系統驗證的', /Recorded: you said E Acceptance is accepted/.test(outs['--clear E(你自己的終端機)']) && /not something the system checked/.test(outs['--clear E(你自己的終端機)']), outs['--clear E(你自己的終端機)']);
  check('--clear E(Claude 代記):主詞是 the user、講 Claude recorded it for them(不講成你自己按的)', /the user said E Acceptance is accepted \(Claude recorded it for them\)/.test(outs['--clear E(Claude 代記、附了話)']), outs['--clear E(Claude 代記、附了話)']);
  check('--install:只講捷徑放好了,不講 Claude Code 已經載入了(R2)', /not that Claude Code actually loaded it/.test(outs['--install']), outs['--install']);
  for (const d of [monitorDir, home, bare]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

/* ════════════ AC-8:Claude 那一側不換 ════════════ */

section('Claude 那一側這一份不換:設成英文之後,Claude 替你跑的指令照舊整句中文,跟中文的時候一字不差(AC-8)');
{
  const r = makeRepo({ at: T(-60 * MIN), files: { 'src/app.js': '1\n' } });
  const root = git(r.dir, 'rev-parse', '--show-toplevel');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-lang-data-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(ROOT, join(home, '.claude', 'skills', PLUGIN));
  writeFileSync(join(monitorDir, 'logs', `${safeName(basename(root))}.jsonl`), [
    { ts: T(-20 * MIN), hook: 'UserPromptSubmit', prompt: SAID },
    { ts: T(-19 * MIN), hook: 'PreToolUse', tool: 'Skill', skill: `${PLUGIN}:chaos-check` },
  ].map((o) => JSON.stringify({ session: 's1', cwd: root, ...o })).join('\n') + '\n');
  const run = (args) => {
    const env = { ...process.env, HOME: home, PIPELINE_MONITOR_HOME: monitorDir, PIPELINE_MONITOR_LOG_DIR: join(monitorDir, 'logs'), CLAUDE_CODE_SESSION_ID: 's1' };
    try { return execFileSync('node', [join(ROOT, 'status.mjs'), ...args], { cwd: root, encoding: 'utf8', env }); } catch (e) { return `失敗(${e.status})：${e.stdout}`; }
  };
  const cmds = [['--round', 'D'], ['--round', 'E'], ['--round', 'A'], ['--report', 'X', 'ok'], ['--decide', 'D', 'nope'], ['--spec'], ['--tier-review'], ['--tier-later']];
  const zh = cmds.map((c) => run(c));
  writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang: 'en' }));
  const enOut = cmds.map((c) => run(c));
  cmds.forEach((c, i) => {
    // 「幾分鐘前」跨分鐘差一格就不準:兩次跑之間不到一秒,照字比
    eq(`${c.join(' ')}:設成英文跟中文的時候一字不差`, enOut[i], zh[i]);
  });
  check('……而且真的是中文(不是兩邊都壞掉、都空的)', zh.every((o) => CJK.test(o)), zh.join('\n---\n').slice(0, 300));
  for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('收工 hook 這一份不換:設成英文之後擋下來的那段話,跟中文的時候一字不差(AC-8)');
{
  // 同一個劇本做兩份(收工 hook 擋過會記下來,同一份不能擋第二次):一份家裡寫了英文,一份從來沒選過
  const once = (lang) => {
    const r = makeRepo({ at: T(-60 * MIN), files: { 'src/a.js': '1\n', 'src/danger.js': 'd\n',
      '.claude/pipeline-stages.json': JSON.stringify({ tiers: { code: ['src/'], danger: ['src/danger.js'] } }) } });
    const root = git(r.dir, 'rev-parse', '--show-toplevel');
    const monitorDir = mkdtempSync(join(tmpdir(), 'pm-lang-gate-'));
    mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
    copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
    if (lang) writeFileSync(join(monitorDir, 'lang.json'), JSON.stringify({ lang }));
    const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(ROOT, join(home, '.claude', 'skills', PLUGIN));
    writeFileSync(join(root, 'src/danger.js'), 'changed\n');
    writeFileSync(join(monitorDir, 'logs', `${safeName(basename(root))}.jsonl`), [
      { ts: T(-5 * MIN), hook: 'UserPromptSubmit', prompt: 'please change the saving code' },
      { ts: T(-4 * MIN), hook: 'PostToolUse', tool: 'Edit', file: join(root, 'src/danger.js') },
    ].map((o) => JSON.stringify({ session: 's1', cwd: root, ...o })).join('\n') + '\n');
    const keep = process.env.PIPELINE_MONITOR_HOME;
    process.env.PIPELINE_MONITOR_HOME = monitorDir;
    let d;
    try { d = decide({ payload: { session_id: 's1', cwd: root, hook_event_name: 'Stop', stop_hook_active: false }, monitorDir, skillHome: home }); }
    finally { process.env.PIPELINE_MONITOR_HOME = keep; }
    for (const x of [monitorDir, home]) rmSync(x, { recursive: true, force: true });
    r.cleanup();
    return { reason: String(d?.reason ?? '').split(root).join('<root>'), missing: d?.missing ?? null };
  };
  const zh = once(null), enOnce = once('en');
  check('收工 hook 有擋(不然什麼都沒比到)', zh.reason.length > 0, JSON.stringify(zh));
  eq('設成英文:擋下來的那段話跟中文的時候一字不差', enOnce.reason, zh.reason);
  check('……而且是中文(另一份規格才翻)', CJK.test(enOnce.reason), enOnce.reason.slice(0, 200));
}

process.exit(summary());
