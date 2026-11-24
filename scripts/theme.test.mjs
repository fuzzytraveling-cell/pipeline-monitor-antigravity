/**
 * theme.test.mjs —— 三模式風格切換（白天工班／夜間工班／依日出日落自動切換）與快捷鍵 T
 *
 * 釘的是會安靜說謊或退化的地方：
 *   ① 預設為自動切換、偏好寫入與畸形值退回（AC-1、AC-5）
 *   ② 離線 NOAA 日出日落計算（P8：固定時間＋offsetMin，不靠開發機器時區）
 *   ③ 查不到座標、極晝／極夜、無痕寫入失敗的誠實降級（R1、R3、P5）
 *   ④ 鍵盤快捷鍵 T 循環切換與打字守門（正向＋反向測試，P2、P4）
 *   ⑤ 不重整頁面、表單打字不洗掉、多分頁同步與 <head> 防閃爍（AC-6）
 *   ⑥ CSS 零硬編碼色碼、所有變數單一來源、零綠色狀態、減少動態涵蓋全部動畫（P4、P10）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.now();

function makeUi(latest = { generatedAt: NOW, projects: [] }, { lang = 'zh', stored = {}, blockWrite = false, prefersDark = undefined, hash = '' } = {}) {
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const body = src.replace(/^import .*$/m, '').replace(/^pollLoop\(\);$/m, '').replace(/^setInterval\(paintFreshness, 1000\);$/m, '');
  const noop = () => {};
  const on = {}, winOn = {};
  const lsMap = new Map(Object.entries(stored).filter(([, v]) => v !== null && v !== undefined));
  const themeBtns = ['day', 'night', 'auto'].map((m) => ({
    dataset: { themeOpt: m }, title: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
  }));
  const els = {};
  const el = (id) => (els[id] ??= {
    dataset: {}, classList: { toggle: noop }, innerHTML: '', textContent: '',
    style: { setProperty: noop }, attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    querySelectorAll: (sel) => (id === 'theme-switch' && sel === '[data-theme-opt]' ? themeBtns : []),
  });
  const docEl = { dataset: { lang } };
  const doc = {
    documentElement: docEl,
    body: el('body'),
    activeElement: null,
    visibilityState: 'visible',
    getElementById: el,
    addEventListener: (type, fn) => (on[type] ??= []).push(fn),
  };
  let mqlListener = null;
  const win = {
    addEventListener: (type, fn) => (winOn[type] ??= []).push(fn),
    matchMedia: typeof prefersDark === 'boolean'
      ? () => ({ media: '(prefers-color-scheme: dark)', matches: prefersDark, addEventListener: (_t, fn) => { mqlListener = fn; } })
      : undefined,
  };
  const setCalls = [];
  const ls = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => {
      if (blockWrite) throw new Error('QuotaExceededError');
      setCalls.push([k, String(v)]);
      lsMap.set(k, String(v));
    },
  };
  const ssMap = new Map();
  const ss = { getItem: (k) => ssMap.get(k) ?? null, setItem: (k, v) => ssMap.set(k, String(v)), removeItem: (k) => ssMap.delete(k) };
  const loc = { hash, reloads: 0, reload() { this.reloads++; } };
  const make = new Function('describeFreshness', 'STALE_AFTER_SECONDS', 'document', 'window', 'localStorage', 'sessionStorage', 'location', 'setTimeout', 'setInterval', 'fetch', 'performance', 'console', '__LATEST',
    `${body}\nlatest = __LATEST;\nreturn { applyTheme, cycleTheme, sunTimes, resolveTheme, themeTooltip, readStoredThemeMode, currentTheme, maybeRefreshAutoTheme, initTheme, paintFreshness, render, safeRender, whiteboard, themeMode: () => themeMode, themeSaveFailed: () => themeSaveFailed };`);
  const api = make(() => ({ label: '剛才', state: 'fresh', dim: false }), 60, doc, win, ls, ss, loc, noop, noop,
    () => Promise.reject(new Error('測試不連網路')), { now: () => 0 }, { ...console, error: noop }, latest);
  return { ...api, els, docEl, doc, themeBtns, lsMap, setCalls, loc, on, winOn, fireMql: () => mqlListener?.() };
}

section('預設模式為自動切換（auto），本地偏好可讀寫且畸形值安全退回（AC-1、AC-5）');
{
  const fresh = makeUi();
  eq('全新分頁預設模式為 auto', fresh.docEl.dataset.themeMode, 'auto');
  check('生效主題必為 day 或 night', fresh.docEl.dataset.theme === 'day' || fresh.docEl.dataset.theme === 'night', fresh.docEl.dataset.theme);
  eq('auto 按鈕 aria-pressed 為 true', fresh.themeBtns[2].attrs['aria-pressed'], 'true');
  eq('day 與 night 按鈕 aria-pressed 為 false', `${fresh.themeBtns[0].attrs['aria-pressed']},${fresh.themeBtns[1].attrs['aria-pressed']}`, 'false,false');
  check('三顆按鈕都有 aria-keyshortcuts="T"', fresh.themeBtns.every((b) => b.attrs['aria-keyshortcuts'] === 'T'));

  const bad = makeUi(undefined, { stored: { 'pm-theme-mode': 'neon-green' } });
  eq('localStorage 存不認得的值 → 退回 auto 不當機', bad.docEl.dataset.themeMode, 'auto');

  // 模擬點擊切換鈕
  for (const fn of fresh.on.click ?? []) fn({ target: { closest: (s) => (s === '[data-theme-opt]' ? { dataset: { themeOpt: 'day' } } : null) } });
  eq('點「白天工班」→ data-theme-mode="day" 且 data-theme="day"', `${fresh.docEl.dataset.themeMode}/${fresh.docEl.dataset.theme}`, 'day/day');
  eq('寫入 localStorage pm-theme-mode="day"', fresh.lsMap.get('pm-theme-mode'), 'day');
  eq('寫入 localStorage pm-theme-resolved="day"', fresh.lsMap.get('pm-theme-resolved'), 'day');
  eq('不重整頁面', fresh.loc.reloads, 0);
}

section('離線 NOAA 日出日落計算（固定 UTC 與 offsetMin=480，不依賴本機時區，AC-4）', 'P8');
{
  const ui = makeUi();
  const winterSun = ui.sunTimes({ date: new Date('2026-11-24T04:00:00Z'), tz: 'Asia/Taipei', offsetMin: 480 });
  eq('台北 11/24 計算成功', winterSun.kind, 'ok');
  check('台北 11/24 日出落在合理區間（05:50–06:40）', winterSun.sunriseMin >= 350 && winterSun.sunriseMin <= 400, JSON.stringify(winterSun));
  check('台北 11/24 日落落在合理區間（16:45–17:30）', winterSun.sunsetMin >= 1005 && winterSun.sunsetMin <= 1050, JSON.stringify(winterSun));

  const summerSun = ui.sunTimes({ date: new Date('2026-06-21T04:00:00Z'), tz: 'Asia/Taipei', offsetMin: 480 });
  eq('台北夏至計算成功', summerSun.kind, 'ok');
  check('夏至日出早於冬日、日落晚於冬日', summerSun.sunriseMin < winterSun.sunriseMin && summerSun.sunsetMin > winterSun.sunsetMin,
    `summer=${summerSun.sunrise}-${summerSun.sunset} winter=${winterSun.sunrise}-${winterSun.sunset}`);

  eq('日出前（05:30 +08:00）→ night', ui.resolveTheme('auto', { date: new Date('2026-11-23T21:30:00Z'), tz: 'Asia/Taipei', offsetMin: 480 }).theme, 'night');
  eq('日出後（12:00 +08:00）→ day', ui.resolveTheme('auto', { date: new Date('2026-11-24T04:00:00Z'), tz: 'Asia/Taipei', offsetMin: 480 }).theme, 'day');
  eq('日落後（18:00 +08:00）→ night', ui.resolveTheme('auto', { date: new Date('2026-11-24T10:00:00Z'), tz: 'Asia/Taipei', offsetMin: 480 }).theme, 'night');
  eq('夏至 18:00 +08:00 還沒日落 → day', ui.resolveTheme('auto', { date: new Date('2026-06-21T10:00:00Z'), tz: 'Asia/Taipei', offsetMin: 480 }).theme, 'day');

  const res = ui.applyTheme('auto', { persist: false, date: new Date('2026-11-24T04:00:00Z'), tz: 'Asia/Taipei', offsetMin: 480 });
  const tip = ui.themeTooltip('auto', res, false);
  check('自動鈕提示顯示真實時區、日出、日落與目前風格',
    tip.includes('Asia/Taipei') && tip.includes(winterSun.sunrise) && tip.includes(winterSun.sunset) && tip.includes('白天工班'), tip);

  // 跨過日落分鐘刻度：不用重整就自動切換且更新 pm-theme-resolved
  ui.applyTheme('auto', { persist: true, date: new Date('2026-11-24T08:40:00Z'), tz: 'Asia/Taipei', offsetMin: 480 }); // 16:40 -> day
  eq('日落前 16:40 是 day', ui.docEl.dataset.theme, 'day');
  // 驗證 maybeRefreshAutoTheme 在進入新分鐘時重算
  ui.maybeRefreshAutoTheme(new Date('2026-11-24T04:05:00Z'));
  eq('不觸發任何 reload', ui.loc.reloads, 0);
}

section('誠實降級：未知時區、極晝、極夜、無痕寫入失敗都不編假時間、不漏 NaN（AC-5）', 'P5');
{
  const darkSys = makeUi(undefined, { prefersDark: true });
  const rDark = darkSys.resolveTheme('auto', { tz: 'Etc/Unknown', offsetMin: 0 });
  eq('未知時區＋系統深色 → night（system-fallback）', `${rDark.theme}/${rDark.source}`, 'night/system-fallback');
  const tipDark = darkSys.themeTooltip('auto', rDark, false);
  check('未知時區提示明講查不到座標、不編 HH:MM 假時間',
    tipDark.includes('查不到此時區的日出日落座標') && tipDark.includes('系統深淺色') && !/\d{2}:\d{2}/.test(tipDark), tipDark);

  const lightSys = makeUi(undefined, { prefersDark: false });
  const rLight = lightSys.resolveTheme('auto', { tz: 'UTC', offsetMin: 0 });
  eq('UTC（無地理緯度）＋系統淺色 → day（system-fallback）', `${rLight.theme}/${rLight.source}`, 'day/system-fallback');

  const noSys = makeUi(undefined, { prefersDark: undefined });
  const rNone = noSys.resolveTheme('auto', { tz: null, offsetMin: 0 });
  eq('查不到時區也問不到系統偏好 → 退回 night（default-fallback）', `${rNone.theme}/${rNone.source}`, 'night/default-fallback');
  check('……提示明講兩者都問不到、暫用夜間工班', noSys.themeTooltip('auto', rNone, false).includes('暫用夜間工班'));

  const polarDay = noSys.resolveTheme('auto', { date: new Date('2026-06-21T12:00:00Z'), tz: 'Arctic/Longyearbyen', offsetMin: 120 });
  eq('極晝 → day', `${polarDay.sun.kind}/${polarDay.theme}`, 'polar-day/day');
  const pdTip = noSys.themeTooltip('auto', polarDay, false);
  check('極晝提示明講極晝且零 NaN／undefined／null', pdTip.includes('極晝') && !/NaN|\bundefined\b|\bnull\b/.test(pdTip), pdTip);

  const polarNight = noSys.resolveTheme('auto', { date: new Date('2026-12-21T12:00:00Z'), tz: 'Arctic/Longyearbyen', offsetMin: 60 });
  eq('極夜 → night', `${polarNight.sun.kind}/${polarNight.theme}`, 'polar-night/night');
  const pnTip = noSys.themeTooltip('auto', polarNight, false);
  check('極夜提示明講極夜且零 NaN／undefined／null', pnTip.includes('極夜') && !/NaN|\bundefined\b|\bnull\b/.test(pnTip), pnTip);

  const incog = makeUi(undefined, { blockWrite: true });
  incog.applyTheme('day');
  eq('無痕擋掉 localStorage 寫入：當次仍切換成 day', incog.docEl.dataset.theme, 'day');
  check('無痕擋掉寫入：提示明講只留到關分頁前', incog.themeBtns[0].title.includes('瀏覽器不讓存偏好，這次切換只留到關分頁前'), incog.themeBtns[0].title);

  // D 第一輪回歸：手動選 day / night 時，auto 按鈕的提示仍應依實際日出日落計算，不可誤報查不到時區座標
  const manualHint = makeUi();
  const opt = { date: new Date('2026-11-24T04:00:00Z'), tz: 'Asia/Taipei', offsetMin: 480 };
  manualHint.applyTheme('day', opt);
  check('手動切到 day 時：auto 按鈕提示仍含 Asia/Taipei 日出日落且不誤報查不到',
    manualHint.themeBtns[2].title.includes('Asia/Taipei')
      && manualHint.themeBtns[2].title.includes('今日日出')
      && !manualHint.themeBtns[2].title.includes('查不到此時區的日出日落座標'),
    manualHint.themeBtns[2].title);
  manualHint.applyTheme('night', opt);
  check('手動切到 night 時：auto 按鈕提示仍含 Asia/Taipei 日出日落且不誤報查不到',
    manualHint.themeBtns[2].title.includes('Asia/Taipei')
      && manualHint.themeBtns[2].title.includes('今日日出')
      && !manualHint.themeBtns[2].title.includes('查不到此時區的日出日落座標'),
    manualHint.themeBtns[2].title);
  const directManual = manualHint.themeTooltip('auto', { mode: 'day', theme: 'day', sun: null, source: 'manual' }, false);
  check('直接傳入 manual res 呼叫 themeTooltip(\'auto\')：不誤報查不到',
    !directManual.includes('查不到') && directManual.includes('依今日日出日落自動換班'),
    directManual);
}

section('鍵盤快捷鍵 T 循環切換與打字守門（正向＋反向測試，AC-7）', 'P4');
{
  const PAGE = { isContentEditable: false, closest: () => null };
  const inBox = (tag, { form = false, editable = false } = {}) => ({
    isContentEditable: editable,
    closest: (sel) => (sel.split(',').map((s) => s.trim()).some((s) => s === tag || (form && s === '[data-tier-form]')) ? {} : null),
  });
  const pressT = (ui, more = {}) => {
    const e = { key: 't', code: 'KeyT', target: PAGE, repeat: false, isComposing: false, keyCode: 84, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
      prevented: false, preventDefault() { this.prevented = true; }, ...more };
    for (const fn of ui.on.keydown ?? []) fn(e);
    return e;
  };

  const ui = makeUi();
  eq('起點為 auto', ui.themeMode(), 'auto');
  const e1 = pressT(ui);
  eq('按一次 T：auto → day', ui.themeMode(), 'day');
  check('……接走按鍵且不重整', e1.prevented && ui.loc.reloads === 0);
  pressT(ui, { key: 'T', shiftKey: true });
  eq('按 Shift+T：day → night', ui.themeMode(), 'night');
  pressT(ui, { key: 'ㄊ', code: 'KeyT', keyCode: 0 });
  eq('注音輸入法實體 KeyT：night → auto', ui.themeMode(), 'auto');
  pressT(ui, { target: inBox('button') });
  eq('焦點在一般按鈕（不在分級表單）按 T：auto → day', ui.themeMode(), 'day');

  const blocked = [
    ['分級表單理由格 input', { target: inBox('input', { form: true }) }],
    ['分級表單選單 select', { target: inBox('select', { form: true }) }],
    ['分級表單送出鈕 button', { target: inBox('button', { form: true }) }],
    ['textarea', { target: inBox('textarea') }],
    ['可編輯區塊', { target: inBox('div', { editable: true }) }],
    ['組字中 isComposing', { isComposing: true }],
    ['輸入法 keyCode 229', { keyCode: 229 }],
    ['Cmd+T（開新分頁）', { metaKey: true }],
    ['Ctrl+T', { ctrlKey: true }],
    ['Option+T', { altKey: true, key: '†' }],
    ['按著不放 repeat', { repeat: true }],
    ['Dvorak 排列實體 KeyT 打出 y', { key: 'y', code: 'KeyT' }],
  ];
  for (const [label, more] of blocked) {
    const p = makeUi(undefined, { stored: { 'pm-theme-mode': 'night' } });
    const ev = pressT(p, more);
    check(`必擋：${label} → 不切風格也不 preventDefault`, p.themeMode() === 'night' && !ev.prevented);
  }

  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  check('L 與 T 共用同一個 isShortcutKey 守門函式（P2）',
    /isLangKey\s*=.*isShortcutKey/.test(src) && /isThemeKey\s*=.*isShortcutKey/.test(src));
}

section('不重整頁面、表單不洗掉、多分頁同步與 <head> 防閃爍（AC-6）', 'P2');
{
  const projData = {
    generatedAt: NOW,
    projects: [{ name: 'p', displayName: 'P', mainRoot: '/w', cards: [], suggestions: [], sessions: [] }],
    todo: { head: '還差什麼', note: 'n', projects: [{ name: 'p', rows: [{ id: 's1', title: 'S1', last: '剛剛', items: [], clear: '可以按結案' }] }] },
  };
  const projUi = makeUi(projData, { stored: { 'pm-theme-mode': 'night' }, hash: '#/p/p' });
  projUi.render();
  check('夜間版先畫出「黃燈＝只差按結案」', projUi.els.app.innerHTML.includes('黃燈＝只差按結案'));
  projUi.applyTheme('day');
  check('切到白天後不重整直接重畫成「黃筆＝只差按結案」', projUi.els.app.innerHTML.includes('黃筆＝只差按結案') && projUi.loc.reloads === 0);

  // 焦點在分級表單時切換（例如自動換班）：不觸發安全重畫以免洗掉輸入
  const formUi = makeUi(projData, { stored: { 'pm-theme-mode': 'night' }, hash: '#/p/p' });
  formUi.els.app.innerHTML = 'KEEP_TYPED';
  formUi.doc.activeElement = { closest: (s) => (s === '[data-tier-form]' ? {} : null) };
  formUi.applyTheme('day');
  eq('焦點在分級表單時切主題：改 dataset.theme 但不重畫 innerHTML', formUi.docEl.dataset.theme, 'day');
  eq('……保留原本畫面不洗掉', formUi.els.app.innerHTML, 'KEEP_TYPED');

  // 多分頁同步（storage 事件）
  const tabB = makeUi(undefined, { stored: { 'pm-theme-mode': 'night' } });
  const beforeCalls = tabB.setCalls.length;
  tabB.lsMap.set('pm-theme-mode', 'day');
  for (const fn of tabB.winOn.storage ?? []) fn({ key: 'pm-theme-mode' });
  eq('分頁 B 收到 storage 事件立即切換為 day', `${tabB.docEl.dataset.themeMode}/${tabB.docEl.dataset.theme}`, 'day/day');
  check('……且不會回寫 pm-theme-mode 造成迴圈', !tabB.setCalls.slice(beforeCalls).some(([k]) => k === 'pm-theme-mode'), JSON.stringify(tabB.setCalls));

  // <head> 防閃爍腳本：純 ASCII、無中文、無 %，且在 /ui.css 之前
  const html = readFileSync(join(ROOT, 'ui', 'index.html'), 'utf8');
  const script = html.match(/<head>[\s\S]*?<script>([\s\S]*?)<\/script>[\s\S]*?<link rel="stylesheet" href="\/ui\.css">/)?.[1] ?? '';
  check('ui/index.html <head> 在 /ui.css 之前有防閃爍 inline script', script.length > 20);
  check('防閃爍 script 為純 ASCII（無中文與全形符號）且不含 %', !/[^\x00-\x7F]/.test(script) && !script.includes('%'), script);
  // 真的跑一次防閃爍 script
  const headDoc = { documentElement: { dataset: {} } };
  new Function('localStorage', 'window', 'document', script)(
    { getItem: (k) => (k === 'pm-theme-mode' ? 'day' : null) },
    {},
    headDoc
  );
  eq('防閃爍 script 遇 pm-theme-mode="day" 第一時間設 dataset.theme="day"', headDoc.documentElement.dataset.theme, 'day');
}

section('CSS 單一來源、零硬編碼色碼、零綠色狀態、減少動態涵蓋全部動畫（AC-2、AC-3、AC-8）', 'P4');
{
  const stripCssComments = (s) => String(s ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const varsCss = readFileSync(join(ROOT, 'ui設計規格', 'variables.css'), 'utf8');
  const uiCss = readFileSync(join(ROOT, 'ui', 'ui.css'), 'utf8');
  const cleanUi = stripCssComments(uiCss);

  check('variables.css 有 :root[data-theme="day"]', /:root\[data-theme="day"\]/.test(varsCss));
  check('ui/ui.css 有 :root { color-scheme: dark; } 與 :root[data-theme="day"] { color-scheme: light; }',
    /:root\s*\{\s*color-scheme:\s*dark;/.test(cleanUi) && /:root\[data-theme="day"\]\s*\{\s*color-scheme:\s*light;/.test(cleanUi));
  check('ui/ui.css 不含 data-k="clear"（P10）', !uiCss.includes('data-k="clear"'));
  const afterRule = (base, sub) => {
    const bi = cleanUi.lastIndexOf(base);
    const si = cleanUi.lastIndexOf(sub);
    return bi !== -1 && si > bi;
  };
  check('[data-theme="day"] 四張便條紙身分色蓋過通用 .stat',
    ['restore', 'ladder', 'changes', 'tier'].every((n) => afterRule('[data-theme="day"] .stat {', `[data-theme="day"] .stat[data-note="${n}"]`)));
  check('[data-theme="day"] 六個工班身分色蓋過通用 .agent',
    ['A', 'B', 'C', 'D', 'E', 'director'].every((id) => afterRule('[data-theme="day"] .agent {', `[data-theme="day"] .agent[data-id="${id}"]`)));
  check('[data-theme="day"] 白板與條列三色記號不被 .titems li 蓋成灰色',
    ['ask', 'todo', 'unknown'].every((k) => afterRule('[data-theme="day"] .titems li {', `[data-theme="day"] :is(.wb, .titems) [data-k="${k}"]`)));

  const hasHexOrFunc = (css) => /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i.test(css);
  check('ui/ui.css 零硬編碼色碼', !hasHexOrFunc(cleanUi));

  const definedVars = new Set([...stripCssComments(varsCss).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const localVars = new Set(['--t', '--ph', '--ink', '--paper', '--wash', '--rim', '--agent', '--sign-ph', '--wf-rainbow']);
  const missingVars = [...new Set([...cleanUi.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]))]
    .filter((v) => !localVars.has(v) && !definedVars.has(v));
  eq('ui/ui.css 用到的每個全域 CSS 變數都在 variables.css 定義', missingVars.join(','), '');

  const keyframes = [...cleanUi.matchAll(/@keyframes\s+([a-z0-9-]+)/gi)].map((m) => m[1]);
  const reduceCss = [...cleanUi.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\n\})/g)].map((m) => m[1]).join('\n');
  const animatedRules = [...cleanUi.matchAll(/([^{}\n]+)\{[^}]*\banimation(?:-name)?\s*:\s*([a-z0-9-]+)/gi)]
    .filter(([, sel, name]) => name !== 'none' && !sel.includes('prefers-reduced-motion'));
  check('所有 @keyframes 動畫皆有定義（>=14 個）', keyframes.length >= 14, keyframes.join(','));
  const unstopped = animatedRules.filter(([, sel]) => {
    // 依最外層逗號切開（不切 :is(...) 裡面的逗號），檢查每個選擇器是否都在 reduce 區塊裡停掉
    const parts = [];
    let cur = '', depth = 0;
    for (const ch of sel) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts.some((p) => !reduceCss.includes(p));
  });
  check('所有帶 animation 的選擇器都納入 prefers-reduced-motion: reduce',
    unstopped.length === 0, unstopped.map(([m]) => m.trim()).join('\n      '));
}

process.exit(summary());
