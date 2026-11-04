/**
 * app.js —— 畫面。規格:pipeline-ui(路徑看 CLAUDE.md 的表)
 *
 * 兩層:  #/          案件列表(有哪些專案接上了)
 *        #/p/<名字>  那個案件的儀表板
 *
 * ⚠️ 不能妥協的還是 AC-1／AC-2:畫面必須隨時說出資料多新,斷線時整頁承認。
 *    判斷在 lib/freshness.mjs(純函式,被測試釘住),這裡只負責畫。
 * ⚠️ 終端機也講的句子,這裡不寫第二份:句子住 lib,伺服器算好帶過來,這裡照印(規格:終端機與網頁說同一句;老毛病 P2)。
 *    這裡只管放在哪、粗體、大字、按鈕。舊的服務沒給那一句時講服務還在跑舊的程式,不自己拼。
 * ⚠️ 中英切換(規格:儀表板與終端機中英切換):這裡自己的字一律寫成 zhEn(中文, English),兩種並排——只寫中文,測試會紅(AC-4)。
 *    一頁只有一種語言,來源只有一個:伺服器送 index.html 時寫在 <html data-lang> 的那一種(第一眼就是對的語言)。
 *    資料回來說是另一種(終端機切了、別的分頁按了)就整頁重新載入——不在同一頁裡換一半(AC-7)。舊的服務不寫 data-lang、資料也沒有 lang＝中文。
 */
import { describeFreshness, STALE_AFTER_SECONDS } from '/freshness.mjs';

const LANG = document.documentElement?.dataset?.lang === 'en' ? 'en' : 'zh';
const zhEn = (zh, en) => (LANG === 'en' ? en : zh);
/** 英文的單複數(1 file／2 files):數字是句子的一部分。只在英文那一份裡用 */
const many = (n, one, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;

const POLL_MS = 5000;
let latest = null, connected = false;
// 上一次換上去的畫面(paint):一樣就不換,動畫才不會每 5 秒從頭來過
let lastHtml = null;
// 這一頁載入時的畫面程式版本(伺服器給的 appVersion)。之後變了 = 服務換了新程式,這一頁還是舊畫面 → 自己重新載入
let bootVersion = null;

const $app = document.getElementById('app');
const $fresh = document.getElementById('freshness');
const $crumb = document.getElementById('crumb');
const $langNote = document.getElementById('lang-note');
const $langBtn = document.getElementById('lang-switch');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ═══ 五個工班:五種形狀加兩隻眼睛,像 Grok 那樣——不畫人、不畫嘴(Oscar 2026-10-27;工地工班風畫面 AC-7) ═══ */
/* 2026-11-03 起六個角色都戴工地帽、眼睛一律黑色,顏色照 Oscar 給的校色參考圖(規格:主任條列與工地帽 AC-7、AC-8、AC-12)。
   每一關在做什麼——用 Oscar 自己那張「蓋房子」對照表的白話。
   形狀畫在 64×66 的格子裡(底下留兩格給影子);eye 是兩隻眼睛中間那一點;hat 是帽緣的中間那一點——尖頂的形狀,帽子要蓋住尖端。
   顏色在 ui.css,跟著 data-id 走,永遠是那一關的顏色 */
const ROLE = {
  A: { house: zhEn('建築師畫圖', 'The architect draws the plans'), does: zhEn('把需求翻成一條條可以打勾的驗收條件', 'Turns the request into acceptance criteria you can tick off one by one'),
       // 墨水滴:建築師畫圖用的墨
       shape: '<path d="M32 7C27 15 13 27 13 39c0 11 8.5 18 19 18s19-7 19-18C51 27 37 15 32 7z"/>', eye: [32, 40], hat: [32, 14] },
  B: { house: zhEn('工班施工', 'The crew builds'), does: zhEn('照圖蓋,蓋到每條都打勾', 'Builds to the plans until every item is ticked'),
       // 圓球:就是你在講話的那個對話
       shape: '<circle cx="32" cy="34" r="22"/>', eye: [32, 33], hat: [32, 14.5] },
  C: { house: zhEn('收尾清場', 'Site cleanup'), does: zhEn('清掉施工留下的鷹架、暫時變數、複製貼上', 'Clears away the scaffolding left from building: temporary variables, copy-paste'),
       // 雲朵:清乾淨之後的泡泡
       shape: '<path d="M20 52c-8 0-12-5.5-11-11 1-5 5.5-8 10-7.5C19.5 25.5 25.5 20 33 20c6.5 0 11.5 4 13 9.5 6-.5 11 4.5 10.5 11S51 52 45 52z"/>', eye: [33, 41], hat: [33, 22.5] },
  D: { house: zhEn('驗屋師傅拿槌子敲牆', 'The inspector taps the walls with a hammer'), does: zhEn('不是看漂不漂亮,是找「哪裡是空心的」', 'Not checking whether it looks nice — looking for where it\'s hollow'),
       // 六角螺帽:敲敲看有沒有鎖緊
       shape: '<path d="M32 10l19.9 11.5v23L32 56 12.1 44.5v-23z"/>', eye: [32, 34], hat: [32, 15.5] },
  E: { house: zhEn('你自己走進去住一晚', 'You move in for a night'), does: zhEn('真的開門、開燈、沖馬桶,確認能住人', 'Really open the doors, turn on the lights, flush the toilet: make sure people can live there'),
       // 小房子:你要住進去的那一間
       shape: '<path d="M32 9l22 18v27H10V27z"/>', eye: [32, 40], hat: [32, 14.5] },
  // 工地主任(規格:還差什麼總表 AC-11、AC-12):第六個角色,不是 stages.json 的關——收工 hook、分級、感測器都不認它,只畫在畫面上。
  // 鍵不用字母:專案自己的關卡哪天多一個 F,也不會撞在一起。
  // 戴工地帽的等腰三角形,尖的朝上、帽子蓋住尖端,帽子正面寫 AI(Oscar 2026-11-03 給的參考圖;以前是直角三角形的三角板、更早是三角錐)
  director: { house: zhEn('工地主任巡一圈', 'The site director walks the site'), does: zhEn('看這個對話還有哪些沒收尾：等你決定的、還差的、看不到的', 'Checks what this conversation hasn\'t wrapped up: what\'s waiting for you, what\'s still to do, what can\'t be seen'),
       shape: '<path d="M32 15L55.5 56H8.5z"/>', eye: [32, 42], hat: [32, 21], ai: true },
};
/**
 * 工地帽(規格:主任條列與工地帽 AC-7、AC-8):六個角色同一頂——圓頂、帽緣、頂上一道稜,戴在 ROLE 的 hat 那一點;
 * 顏色是身體的淺一號(ui.css 的 .ag-hat),不跟狀態變。只有主任那一頂正面有 AI(ai)。
 * AI 用線畫、不用 <text>:字小到這樣,有的瀏覽器會照「最小字級」把它放大,撐出帽子。
 * 放在帽子這一組、不放在眼睛那一組:這一輪走到的那一關眼睛會眨,字不能跟著眨
 */
function hat(at, ai = false) {
  const [x, y] = at;
  // 以帽緣中間為原點畫,再搬到那一點:六頂一樣大(參考圖上帽子大小差不多,身體才不一樣)。帽緣下那一道影子讓帽子跟身體分得開
  const letters = 'M-2.1 -3.4L-0.7 -6.6L0.7 -3.4M-1.55 -4.5H0.15M2.1 -6.6V-3.4';
  return `<g class="ag-hat" transform="translate(${x} ${y}) scale(1.15)"><ellipse class="hat-shade" cx="0" cy="1.6" rx="10.5" ry="1.8"/>`
    + '<path class="hat-dome" d="M-8 -1.5C-8 -11.5 8 -11.5 8 -1.5z"/><rect class="hat-ridge" x="-1.6" y="-9.8" width="3.2" height="3.6" rx="1.6"/>'
    + '<rect class="hat-brim" x="-11" y="-2.6" width="22" height="3.6" rx="1.8"/>'
    + `${ai ? `<path class="hat-ai-edge" d="${letters}"/><path class="hat-ai" d="${letters}"/>` : ''}</g>`;
}
/**
 * 表情只講感測器知道的事,不替結果背書(工地工班風畫面 AC-8):感測器只知道這一關被叫過,不知道做得好不好——
 * 笑眼只給「你說處理完了」(done 而且 doneBy 是 human,見 agent);叫了(ran)是睜眼看著右邊那一行字。
 * 畫面不認得的狀態給問號眼,不借「還沒跑」的睡臉(R1)
 */
const FACE = { none: 'sleep', passed: 'rest', ran: 'look', main: 'open', done: 'happy', stale: 'worry', held: 'half', seen: 'side', notbuilt: 'blank' };
function eyes(face, at) {
  const [x, y] = at;
  const two = (f) => f(x - 7) + f(x + 7);
  const pill = (dx, dy = 0) => two((ex) => `<rect x="${ex + dx - 3}" y="${y + dy - 6}" width="6" height="12" rx="3"/>`);
  if (face === 'open') return pill(0);
  if (face === 'look') return pill(3);        // 看著右邊那一行字
  if (face === 'side') return pill(-3, -1);   // 往旁邊瞄
  if (face === 'happy') return two((ex) => `<path class="ln" d="M${ex - 4} ${y + 2}Q${ex} ${y - 5} ${ex + 4} ${y + 2}"/>`);
  if (face === 'sleep' || face === 'rest') return two((ex) => `<path class="ln" d="M${ex - 4} ${y}H${ex + 4}"/>`);
  if (face === 'worry') return two((ex) => `<circle cx="${ex}" cy="${y}" r="4.5"/>`);
  if (face === 'half') return two((ex) => `<path d="M${ex - 3.5} ${y - 1}h7v2a3.5 3.5 0 0 1-7 0z"/>`);   // 半睜眼:擱著
  if (face === 'blank') return '';
  return two((ex) => `<text x="${ex}" y="${y + 4}" text-anchor="middle">?</text>`);
}
/**
 * 一個工班。這一輪走到的那一關(here)身後有藍色光暈向外暈開。五顆都輕輕上下漂浮、速度一樣——
 * 漂浮不跟狀態變,不代表在做事(AC-9:感測器不知道現在還在不在跑,不做「工作中」的動作)
 */
function agent(st, s, here) {
  const r = ROLE[st.id];
  // 誰說處理完了只讀伺服器給的 doneBy(lib/rounds.mjs 算一次,那一格的字也讀它),不自己從 closedBy 猜——closedBy 是憑什麼劃掉,
  // A 會被「點頭開工」換掉,以前拿它猜,字說你說、臉說 Claude 說(2026-10-27,老毛病 P2)。
  // Claude 自己回報 ok、Claude 對完清單也是 done——那些是 Claude 說的,只睜著眼;舊的服務沒給 doneBy 也只睜著眼(分不出來就不替它高興)。
  // 給笑眼的話,D 記下「沒對到已知死法」那一刻,魔鬼教官就笑著發光,看起來像說通過了(魔鬼教官第一輪,R2)
  const face = s === 'done' && st.doneBy !== 'human' ? 'open' : FACE[s] ?? 'ask';
  const extra = face === 'sleep' ? '<text class="ag-z" x="49" y="15">z</text>'
    : face === 'worry' ? '<path class="ag-sweat" d="M52 11c-2 4-3.5 6-3.5 8a3.5 3.5 0 0 0 7 0c0-2-1.5-4-3.5-8z"/>' : '';
  return `<span class="agent" data-id="${esc(st.id)}" data-face="${face}"${here ? ' data-here="1"' : ''}>${here ? '<span class="halo"></span><span class="halo"></span>' : ''}
    <svg viewBox="0 0 64 66" aria-hidden="true"><ellipse class="ag-ground" cx="32" cy="62" rx="14" ry="2.5"/>
      <g class="ag-float"><g class="ag-body">${r?.shape ?? '<circle cx="32" cy="34" r="22"/>'}</g>${hat(r?.hat ?? [32, 14], !!r?.ai)}<g class="ag-face">${eyes(face, r?.eye ?? [32, 33])}</g>${extra}</g></svg></span>`;
}

/* ═══ 新鮮度(AC-1／AC-2) ═══ */
function paintFreshness() {
  const f = describeFreshness({ generatedAt: latest?.generatedAt ?? NaN, now: Date.now(), connected, lang: LANG });
  $fresh.textContent = f.label;
  $fresh.dataset.state = f.state;
  document.body.classList.toggle('dim', f.dim);
}
/** 等多久沒回來就不等了、照實說連不上:跟「資料可能過期了」同一條線(lib/freshness.mjs),不另訂一個數字 */
const GIVE_UP_MS = STALE_AFTER_SECONDS * 1000;
async function poll() {
  // 伺服器卡住、一直不回的話,這一次要有個盡頭:不然輪詢停在這裡,伺服器好了也不會再問(AC-2:不准靜靜停止更新)
  const ctl = new AbortController();
  const giveUp = setTimeout(() => ctl.abort(), GIVE_UP_MS);
  try {
    const r = await fetch('/api/status', { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error(String(r.status));
    latest = await r.json(); connected = true;
    // 合併之後重啟服務,開著的分頁跑的還是舊畫面:每幾秒拿新資料用舊的畫法畫,會把新欄位畫錯(魔鬼教官 2026-09-21,L20 的形狀)
    if (latest?.appVersion) {
      if (bootVersion === null) bootVersion = latest.appVersion;
      else if (latest.appVersion !== bootVersion) { location.reload(); return; }
    }
    // 資料是另一種語言(終端機 --lang 切了、別的分頁按了):整頁重新載入,首頁跟資料才是同一種(AC-7)。舊的服務沒給這一欄＝中文
    const dataLang = latest?.lang === 'en' ? 'en' : 'zh';
    if (dataLang !== LANG && reloadForLang(dataLang)) return;
    // 使用者正在分級表單裡打理由時,這一輪不重畫——重畫會把打到一半的字洗掉(2026-09-13 實測)。資料照抓,下一輪再畫。
    if (!document.activeElement?.closest?.('[data-tier-form]')) safeRender();
  } catch { connected = false; }   // AC-2:不准靜靜停止更新
  finally { clearTimeout(giveUp); }
  paintFreshness();
}
/**
 * 輪詢:上一次回來(或放棄)之後,才排下一次。
 * ⚠️ 以前用 setInterval 每五秒固定要一次,不管上一次回來了沒——伺服器算一次將近 3 秒、一次只能算一個,
 *    兩個分頁同時開著,請求就疊起來越排越長,整頁「連不上」(2026-09-22 實測)。
 */
async function pollLoop() {
  await poll();
  setTimeout(pollLoop, POLL_MS);
}
/**
 * 換語言就重新載入一次。⚠️ 十秒內已經為了換成「同一種」重新載入過、還是對不上,就不再載——不該發生(首頁跟資料每次都重讀同一個設定),
 * 但真的發生時寧可這一頁照舊、等下一次,也不准一直重新載入、整頁什麼都看不到。
 * 記的是時間加上「為了換成哪一種」:別的分頁(或終端機)十秒內又換回去,那是新的一次切換,不是對不上。以前只記時間,這一頁會被擋著不載,
 * 照另一種語言的資料畫出半中半英,十秒後才換(規格:dashboard-language-shortcut,魔鬼教官第一輪;按 L 來回比就碰得到)。
 */
function reloadForLang(want) {
  let last = null;
  try { last = JSON.parse(sessionStorage.getItem('pm-lang-reload')); } catch { /* 記不了、讀不懂就當沒載過 */ }
  if (last?.lang === want && Date.now() - last.at < 10_000) return false;
  try { sessionStorage.setItem('pm-lang-reload', JSON.stringify({ at: Date.now(), lang: want })); } catch { /* 記不了也照樣載這一次 */ }
  location.reload();
  return true;
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return zhEn('時間對不上', '(time doesn\'t line up)');
  // 英文的單複數是句子的一部分
  const en = (n, one) => `${n} ${one}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return zhEn(`${Math.max(0, s)} 秒前`, en(Math.max(0, s), 'second'));
  const m = Math.round(s / 60); if (m < 60) return zhEn(`${m} 分鐘前`, en(m, 'minute'));
  const h = Math.round(m / 60); return h < 48 ? zhEn(`${h} 小時前`, en(h, 'hour')) : zhEn(`${Math.round(h / 24)} 天前`, en(Math.round(h / 24), 'day'));
}
const clock = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? `${String(d.getMonth() + 1)}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
    : zhEn('時間對不上', '(time doesn\'t line up)');
};
// 狀態是伺服器算好的(lib/rounds.mjs 的 roundView):main／notbuilt／none／passed／current／done／stale／held／seen。
// 畫面上 current 沿用「ran」的樣式(亮),passed 是劃掉變淡,done 是劃掉但深色(你說處理完了)。
// stale(要處理:D 之後又改了程式、要不要再跑你決定;B 清單沒對完)與 held(你說不用再跑:擱著,不劃掉、不打勾)照原樣給 CSS
const stageState = (st) => st.state === 'current' ? 'ran' : (st.state ?? 'none');
/**
 * 終端機也講的句子(五關每一格那一句、寫規格那一關的旁白、清單的那幾句…)都是伺服器照 lib 算好帶過來的,這裡只畫——
 * 以前這裡各寫一份翻譯,改一邊要記得改另一邊(老毛病 P2;規格:終端機與網頁說同一句)。
 * 舊的服務(合併之後還沒 --serve-restart)沒給那一句:不自己拼、不留空白,講服務還在跑舊的程式(AC-5)。
 */
const OLD_LINE = zhEn('（服務還在跑舊的程式）', '(the service is still running the old program)');
/** 伺服器給的句子裡把一段標起來(粗體、指令的樣子)。找不到那一段就照原樣——只影響長相,不影響字 */
const mark = (text, part, tag = 'b') => { const t = esc(text), m = esc(part ?? ''); return m && t.includes(m) ? t.replace(m, () => `<${tag}>${m}</${tag}>`) : t; };
/** 舊的服務一頁講一次怎麼修;每個缺字的地方只放上面那句短的。
 *  stampHelp 是存檔與蓋章卡那一版才有的(規格:先講commit再講蓋章 AC-10)——那一版以前的服務有 sharedLines,只看它認不出來。
 *  todo 是「還差什麼」那一版才有的(規格:還差什麼總表 AC-7):要重啟那一句是服務自己講的,舊的服務講不出來——
 *  不算進來的話,併進去、還沒重啟的那段時間,只有點進案件頁的白板才看得到要重啟,首頁一句都不講(魔鬼教官第二輪,R1) */
function oldServerBanner() {
  return latest && (!('sharedLines' in latest) || !('stampHelp' in latest) || !('todo' in latest))
    ? zhEn('<p class="fault" data-tone="amber">🟡 儀表板的服務還在跑舊的程式，有幾句畫不出來——跑 <code>pipeline-status --serve-restart</code></p>',
      '<p class="fault" data-tone="amber">🟡 The dashboard service is still running the old program, so a few lines can\'t be drawn: run <code>pipeline-status --serve-restart</code></p>') : '';
}
/** 語言設定讀不懂(被改壞、寫了不認得的語言):先用中文,但每一頁最上面講一句,不默默用(AC-7)。句子是伺服器給的,跟終端機同一句 */
function langBanner() {
  return latest?.langNote ? `<p class="fault" data-tone="amber">${esc(latest.langNote)}</p>` : '';
}
/** 清單收合的狀態:key 是「工作區|關」。沒記過就用 dflt(驗收清單預設展開;收起來的建議卡預設收著);記在 localStorage,重新整理也記得。畫面每幾秒重畫一次,不能靠 DOM 記 */
const FOLD_KEY = 'pm-fold';
function foldStore() { try { return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}'); } catch { return {}; } }
function foldOpen(key, dflt = true) { const v = foldStore()[key]; return v === undefined ? dflt : v === true; }
function rememberFold(key, open) { try { const all = foldStore(); all[key] = open; localStorage.setItem(FOLD_KEY, JSON.stringify(all)); } catch { /* 存不了就只記這一次 */ } }
// <details> 的 toggle 事件不會冒泡,用捕捉階段在 document 上接
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d instanceof HTMLDetailsElement && d.dataset.fold) rememberFold(d.dataset.fold, d.open);
}, true);
/** 感測器看得到的關(有 skill 或 tools 的)。B 是你在講話的那個對話、未建的關,都不算分母。 */
const sensed = (st) => st.type !== 'main-conversation' && st.type !== 'not-built';

/**
 * 這一輪走到哪一關。對話列、案件卡那一句(roundWhere)跟五關裡發光的那一顆(workflow)都從這裡拿——同一個判斷,不各算一次(老毛病 P2)。
 * 先找現在這一關(叫了、或處理完了);沒有的話,看最後一步是不是結論會過期的關、而它在「要處理」或「擱著」:那不是沒有紀錄
 * (魔鬼教官第一輪,老毛病 P5:這個「找不到」有兩種意思)。B 清單沒對完的樣子也是 stale,但它不會是最後一步——後面的關動了它才變 stale,所以只看有 skill 的關
 */
function roundStage(stages) {
  const list = stages ?? [];
  const cur = list.find((x) => x.state === 'current' || x.state === 'done');
  if (cur) return { st: cur, open: false };
  const open = [...list].reverse().find((x) => (x.state === 'stale' || x.state === 'held') && x.skill);
  return open ? { st: open, open: true } : null;
}
/** 這一輪走到哪,一句話。對話列與案件卡共用,兩邊才說同一句。 */
function roundWhere(stages) {
  const at = roundStage(stages);
  const cur = at && !at.open ? at.st : null;
  if (cur) {
    // E 驗收:伺服器照 lib/verify.mjs 算好的那一句(Claude 走過一遍,等你查核……);舊的服務沒給就照舊
    // 已經驗收也照這一句:Claude 代記的要講是 Claude 代記(魔鬼教官第二輪:以前 done 寫死「你說驗收過了」,第一輪那條只修了一半)
    // 好幾份規格、有一份讀不到:B 對完的只是讀得到的那幾份,這一句也要講(魔鬼教官第一輪:B 那一行講了,對話列與案件卡沒講)
    const n = cur.type === 'main-conversation' ? cur.checklist?.unreadable?.length ?? 0 : 0;
    const unread = n ? zhEn(`另有 ${n} 份規格讀不到`, `${n} more ${n === 1 ? 'spec' : 'specs'} couldn't be read`) : '';
    const tail = cur.type === 'browser' && cur.ewhere ? zhEn(`（${cur.ewhere}）`, ` (${cur.ewhere})`)
      : cur.state === 'done' ? (cur.type === 'browser' ? zhEn('（你說驗收過了）', ' (you said accepted)') : zhEn(`（處理完了${unread ? `；${unread}` : ''}）`, ` (handled${unread ? `; ${unread}` : ''})`))
      : unread ? zhEn(`（${unread}）`, ` (${unread})`) : '';
    return zhEn(`這一輪走到 ${cur.id} ${cur.name}${tail}`, `This round is at ${cur.id} ${cur.name}${tail}`);
  }
  const open = at?.open ? at.st : null;
  if (open) {
    const why = open.type === 'browser' && open.ewhere ? open.ewhere : open.state === 'held' ? zhEn('你說不用再跑', 'you said no need to run it again')
      : open.rerun?.state === 'ask' ? zhEn('要不要再跑由你決定', 'whether to run it again is your call')
      : open.rerun?.state === 'found' ? zhEn('找到問題，還沒處理完', 'found problems, not handled yet')
      : open.rerun?.state === 'no-report' ? zhEn('Claude 還沒記結論', 'Claude hasn\'t recorded a conclusion yet') : zhEn('要處理', 'needs attention');
    return zhEn(`這一輪走到 ${open.id} ${open.name}（${why}）`, `This round is at ${open.id} ${open.name} (${why})`);
  }
  return zhEn('這一輪還沒有紀錄', 'No record yet this round');
}

/**
 * 案件層級要講「哪一個」:最近在動、而且工作區還在的那個進行中對話;沒有的話講主資料夾那張卡。
 * ⚠️ 一個案件底下有好幾個對話與工作區。以前隨手挑清單上第一個還在的工作區來畫,而且不說是誰——
 *    ai-english-course 案件卡上亮著的 C,是 5 天前另一個對話的紀錄,Oscar 看不懂(2026-09-15)。
 */
function focusOf(p) {
  const live = (p.sessions ?? []).filter((s) => !s.closedAt);   // 伺服器已經依最後動作排好
  const session = live.find((s) => s.card && !s.card.gone && !s.card.notGit) ?? null;
  const card = session?.card ?? p.cards.find((c) => c.path === p.mainRoot && !c.gone && !c.notGit) ?? null;
  return { session, card, liveCount: live.length };
}

/* ═══ 還差什麼(規格:還差什麼總表):每一頁最上面那一句、案件頁的白板、工地主任 ═══ */
/** 要重啟那一句(AC-7):講的是整個儀表板,跟故障、語言那幾條一起放在每一頁最上面。是服務自己講的(lib/todo.mjs),這裡只畫 */
function restartBanner() {
  const t = latest?.todo?.restart;
  return t ? `<p class="fault" data-tone="amber">${esc(t)}</p>` : '';
}
/**
 * 建議卡收起來了沒:開始了、你說不做了、被同名的新卡取代了。「建議另開的對話」那一區跟 F 工地主任共用這一個判斷(老毛病 P2)。
 * 終端機(--todo、--cards)與伺服器用的是 lib/rounds.mjs 的 cardState——瀏覽器拿不到 lib,這裡是第二份,scripts/director.test.mjs 逐種對兩邊
 */
function cardFolded(s) {
  return !!(s.dismissedAt || s.startedBy || s.supersededAt);
}
/** 幾件:等你決定、還差、看不到各幾件(白板的圈旁、F 那一行)。只數伺服器給的那幾件,不另判斷。k 是那幾件的種類,白板照它上色 */
function countParts(r) {
  const n = (k) => (r?.items ?? []).filter((i) => i.kind === k).length;
  return [['ask', zhEn('等你決定', 'Your call')], ['todo', zhEn('還差', 'Still to do')], ['unknown', zhEn('看不到', 'Can\'t see')]]
    .map(([k, w]) => ({ k, c: n(k), w })).filter((x) => x.c > 0).map(({ k, c, w }) => ({ k, text: zhEn(`${w} ${c} 件`, `${w}: ${c}`) }));
}
function countsOf(r) {
  return countParts(r).map((x) => x.text).join(' · ');
}
/** 那一件用哪一色筆:圈旁的件數、展開後每一件、main 推了沒那一行、筆槽亮哪幾支,都照這一張(老毛病 P2) */
const INK = { ask: 'red', todo: 'blue', unknown: 'gray', clear: 'yellow' };
/**
 * 馬克筆的顏色照最急的那一件(AC-10):紅＝等你決定、藍＝還差、灰＝看不到、黃＝只差按結案(沒有還差的事,工地主任的黃;Oscar 2026-11-02 從黑改黃)。
 * 沒有還差的事不准是綠色(P10),看不到不准跟沒事同色(P5)。顏色照 INK 那一張拿,不另寫一份——黑改黃那天兩份要一起改(老毛病 P2)
 */
function inkOf(r) {
  const k = new Set((r?.items ?? []).map((i) => i.kind));
  return INK[['ask', 'todo', 'unknown'].find((x) => k.has(x)) ?? 'clear'];
}
/**
 * 工地主任的表情(AC-11):只看那幾件的種類,照五個工班的表情借——有事等你決定是擔心的圓眼、還差是看著那一串、看不到是問號眼(FACE 沒有這一種)、
 * 沒有還差的事是睜著眼、全都結案了是休息。不笑:笑眼只給「你說處理完了」,總表沒有人驗過(P10)
 */
function bossMood(rows) {
  const k = new Set(rows.flatMap((r) => (r?.items ?? []).map((i) => i.kind)));
  if (k.has('ask')) return 'stale';
  if (k.has('todo')) return 'ran';
  if (k.has('unknown')) return 'unknown';
  return rows.length && rows.every((r) => r?.closed) ? 'passed' : 'main';
}
/**
 * 案件頁 Overview 下面的「還差什麼」白板(AC-1、AC-10、AC-11):一個對話一個彩色筆圈,預設收起,點開才看每一件、結案鈕、到那個對話頁。
 * 每一句都是伺服器照 lib/todo.mjs 算好的,終端機 --todo 印的是同一份(規格:終端機與網頁說同一句);這裡只畫。
 * ⚠️ 顏色之外圈旁一定有字(幾件),筆槽每一支筆旁寫那一色的意思——不只靠顏色(DESIGN:警示膠帶那一條的道理)。
 * ⚠️ 舊的服務沒有 todo 這一欄:講服務還在跑舊的程式,不准畫成一塊空白板——空的看起來就是「都沒事」(老毛病 P5)。
 * 結案鈕跟對話列那一顆是同一個(data-close:同一個點擊處理、同一個 /api/close);已結案、還有檔案沒存沒併的不給鈕。
 */
function whiteboard(p) {
  if (!latest) return '';
  if (!('todo' in latest)) {
    return zhEn('<div class="block"><p class="fault" data-tone="amber">🟡 儀表板的服務還在跑舊的程式，「還差什麼」白板畫不出來——跑 <code>pipeline-status --serve-restart</code></p></div>',
      '<div class="block"><p class="fault" data-tone="amber">🟡 The dashboard service is still running the old program, so the "What\'s left" board can\'t be drawn: run <code>pipeline-status --serve-restart</code></p></div>');
  }
  const t = latest.todo;
  const sec = (t.projects ?? []).find((x) => x.name === p.name);
  // 服務給的總表裡沒有這個案件:講找不到,不畫成沒事,也不猜原因(R1)
  if (!sec) return `<div class="block"><p class="muted">${zhEn('「還差什麼」裡找不到這個案件，這塊白板畫不出來。', 'This project can\'t be found in "What\'s left", so this board can\'t be drawn.')}</p></div>`;
  const task = (r) => {
    const key = `wb|${p.name}|${r.id}`;
    // 件數一種一色(紅圈裡也可能有還差的事):收起來的時候,筆槽亮的每一支筆在圈旁都找得到那一色
    const parts = countParts(r);
    const count = parts.length ? parts.map((x) => `<span data-k="${x.k}">${esc(x.text)}</span>`).join(' · ')
      : r.clear ? `<span>${esc(zhEn('沒有還差的事了', 'Nothing left'))}</span>` : '';   // 不上色:黃字看不清楚,也不替「沒事」另外上色(P10)
    return `<li class="wb-item"><details class="wb-task" data-ink="${inkOf(r)}" data-fold="${esc(key)}"${foldOpen(key, false) ? ' open' : ''}>
        <summary><span class="wb-ring">${esc(r.title)}</span>${count ? ` <span class="wb-count">${count}</span>` : ''}
          <span class="smeta">${r.closedNote ? `${esc(r.closedNote)} · ` : ''}${esc(r.last)}</span></summary>
        <ul class="titems">${r.items.map((i) => `<li data-k="${esc(i.kind)}">${esc(i.text)}</li>`).join('')}${r.clear ? `<li data-k="clear">${esc(r.clear)}</li>` : ''}</ul>
        <div class="wb-acts"><a href="#/p/${encodeURIComponent(p.name)}/s/${encodeURIComponent(r.id)}">${zhEn('到這個對話頁 →', 'Open this conversation →')}</a>
          ${r.closed ? '' : `<button class="mini-btn" data-close="${esc(r.id)}" data-proj="${esc(p.name)}" data-cwd="${esc(r.cwd ?? '')}" data-undo="0">${zhEn('結案', 'Close')}</button>`}</div>
      </details></li>`;
  };
  // main 推了沒那一行:還沒推是還差、問不到是看不到。舊的服務沒給 pushKind → 分不出是哪一種,畫看不到(R1)
  const pushKind = sec.push ? (INK[sec.pushKind] ? sec.pushKind : 'unknown') : null;
  // 筆槽(Oscar 2026-11-02):四支筆跟它的意思排在一起,白板上畫到哪一色,那一支的筆頭就亮。
  // 算的是白板上畫出來的每一處顏色——圈、圈旁的件數、展開後每一件、推了沒那一行——不只看圈:紅圈裡也有還差的事,藍筆不亮就是把「有」講成「沒有」(R1)。
  // 白板畫不出來(上面那兩種)就走不到這裡:不畫四支都不亮的筆槽——那看起來就是「都沒事」(老毛病 P5)。
  // 最上面那一行(感測器掛壞了、退出記錄)講的是新的對話記不到:算看不到、畫灰點、灰筆亮。
  // 以前沒算:字說紀錄可能不全,灰筆卻說白板上沒有看不到的(魔鬼教官第 3 輪,P10 那一種)
  const used = new Set(sec.rows.flatMap((r) => [inkOf(r), ...r.items.map((i) => INK[i.kind]), r.clear ? INK.clear : null]));
  if (pushKind) used.add(INK[pushKind]);
  if (sec.note) used.add(INK.unknown);
  const pens = [['red', zhEn('紅筆＝等你決定', 'Red = your call')], ['blue', zhEn('藍筆＝還差什麼', 'Blue = what\'s still to do')],
    ['gray', zhEn('灰筆＝看不到', 'Gray = can\'t see')], ['yellow', zhEn('黃筆＝只差按結案', 'Yellow = only closing left')]];
  const tray = pens.map(([ink, label]) => `<span class="wb-pen" data-ink="${ink}" data-lit="${used.has(ink) ? 1 : 0}" title="${used.has(ink)
    ? zhEn('筆頭亮著：白板上有這一色', 'Lit: this color is on the board') : zhEn('筆頭沒亮：白板上沒有這一色', 'Off: this color isn\'t on the board')}"><i></i>${esc(label)}</span>`).join('');
  return `<div class="block">
    <div class="wb">
      <div class="wb-head">
        <div><h2 class="section serif">${esc(t.head)}</h2><p class="section-note">${esc(t.note)}</p></div>
        <span class="wb-boss">${agent({ id: 'director' }, bossMood(sec.rows), false)}<span class="wb-boss-name">${zhEn('工地主任', 'Site director')}</span></span>
      </div>
      ${sec.note ? `<p class="wb-line" data-k="unknown">${esc(sec.note)}</p>` : ''}
      ${sec.push ? `<p class="wb-line" data-k="${pushKind}">${esc(sec.push)}</p>` : ''}
      ${sec.rows.length ? `<ul class="wb-tasks">${sec.rows.map(task).join('')}</ul>` : ''}
      ${sec.quiet ? `<p class="wb-line">${esc(sec.quiet)}</p>` : ''}
      <div class="wb-tray">${tray}</div>
    </div>
  </div>`;
}

/* ═══ 第一層:案件列表 ═══ */
function projectList() {
  if (!latest?.projects?.length) {
    // 舊的紀錄還沒搬過來(上面那一條會講):這時候說「還沒有任何案件」就是把「沒讀到」講成「沒有」(R1;規格:紀錄搬到固定的家 AC-5)
    if (latest?.faults?.moving) return zhEn('<p class="muted">這裡還看不到案件：舊的紀錄還沒搬過來（看上面那一條）。</p>', '<p class="muted">No projects can be seen here yet: the old records haven\'t been moved over (see the bar above).</p>');
    return zhEn(`<p class="muted">還沒有任何案件。<br>在一個 git 專案裡跑
      <code>pipeline-status --checkpoint</code> 就會出現在這裡。</p>`, `<p class="muted">No projects yet.<br>Run
      <code>pipeline-status --checkpoint</code> in a git project and it will show up here.</p>`);
  }
  const cards = latest.projects.map((p) => {
    // 小格子畫的是「最近在動的那個對話」這一輪走到哪,而且把它的名字寫出來(focusOf)。
    // 還原點是每個工作區各一個,放在案件卡上說不清是誰的——拿掉,點進去看。
    const { session, liveCount } = focusOf(p);
    const off = p.optedOut ? zhEn(' · 已退出記錄', ' · opted out of recording') : '';
    const body = session
      ? `<div class="mini">${session.stages.filter(sensed).map((s) => `<span data-s="${stageState(s)}"></span>`).join('')}</div>
      <div class="meta focus">${zhEn('最近在動：', 'Recently active: ')}${esc(session.title ?? zhEn('（還沒有標題）', '(no title yet)'))}</div>
      <div class="meta">${esc(roundWhere(session.stages))}${zhEn(` · 共 ${liveCount} 個進行中的對話`, ` · ${many(liveCount, 'conversation')} in progress`)}${off}</div>`
      : `<div class="meta">${liveCount ? zhEn(`${liveCount} 個進行中的對話（它們的工作區都不在了）`, `${many(liveCount, 'conversation')} in progress (their workspaces are all gone)`)
        : zhEn('沒有進行中的對話', 'No conversations in progress')}${off}</div>`;
    return `<button class="pcard" data-go="${esc(p.name)}">
      <h3>${esc(p.displayName ?? p.name)}</h3>
      ${body}
    </button>`;
  }).join('');
  return `<div class="block">
      <h2 class="section serif">${zhEn('案件', 'Projects')}</h2>
      <p class="section-note">${zhEn('只列有紀錄或有還原點的專案。', 'Only projects with records or a restore point are listed.')}</p>
      <div class="projects">${cards}</div>
    </div>`;
}

/* ═══ 三張狀態卡 ═══ */
/** 章能不能用:有章、而且它指的版本還在這條分支的歷史上(L14)。伺服器算好的,這裡只讀。 */
const cpOk = (c) => !!c?.checkpoint && c?.checkpointRelation?.state === 'ok';

function statRestore(c) {
  const cp = c.checkpoint;
  // 終端機也講的那幾句是伺服器照 lib/scope.mjs 算好的(c.lines);舊的服務沒給 → 講舊的程式(規格:終端機與網頁說同一句)
  const q = c.lines ?? null;
  const say = (v) => esc(q ? v ?? '' : OLD_LINE);
  const head = zhEn('<h3 class="ctitle">還原點</h3><div class="label">你回得去哪裡</div>', '<h3 class="ctitle">Restore point</h3><div class="label">Where you can go back to</div>');
  if (!cp) return `<div class="stat" data-note="restore" data-tone="restore">
    ${head}
    <div class="big">${zhEn('還沒有', 'None yet')}</div>
    <div class="sub">${say(q?.notStamped)}</div>
    <div class="hint">${zhEn('在那個資料夾跑 <code>pipeline-status --checkpoint</code>', 'Run <code>pipeline-status --checkpoint</code> in that folder')}</div></div>`;

  // ⚠️ L14:章指的版本不在這條分支上(歷史被改寫過)時,這張卡**不給**回去的指令。
  //    2026-09-11 主資料夾就是這樣:章指著清歷史之前的版本,複製回去會跳到另一條歷史。
  const rel = c.checkpointRelation;
  if (!cpOk(c)) {
    return `<div class="stat" data-note="restore" data-tone="restore">
    ${head}
    <div class="big">${zhEn('失效', 'Unusable')}</div>
    <div class="sub">${zhEn(`${ago(cp.at)}蓋的章已經不能用：${say(q?.broken)}`, `The stamp from ${ago(cp.at)} can't be used anymore: ${say(q?.broken)}`)}</div>
    <div class="hint">${zhEn('⚠️ 所以這裡<b>不給</b>回去的指令。重新蓋一個：<code>pipeline-status --checkpoint</code>',
      '⚠️ So this <b>doesn\'t</b> give a command to go back. Stamp again: <code>pipeline-status --checkpoint</code>')}</div></div>`;
  }

  // ⚠️ 一定要帶 cd。少了它,這一行會在終端機**當下所在的資料夾**執行——
  // 而 `git reset --hard` 跑錯資料夾會毀掉另一個專案的東西,還沒有 undo。
  // Oscar 2026-09-10 實際貼了才發現,這是我漏掉的,而且是危險的那一種。
  // 章之後有存檔 → 先留一條備份分支再回去(L14)。用 && 串:備份沒成功就不會走到 reset。
  const backup = rel.commitsAfter && c.backupBranch ? `git branch ${c.backupBranch} && ` : '';
  const cmd = `cd ${JSON.stringify(c.path)} && ${backup}git reset --hard ${cp.commit.slice(0, 7)}`;
  // ⚠️ 不再把 SHA 當標題。`a79e8d7` 對使用者沒有意義——時間與版本號才有。
  // SHA 只留在「複製回去的指令」裡,因為 git 需要它。
  const pills = cp.checks.map((k) => `<span class="pill ok">${esc(k)}</span>`).join('');
  // 說明分三層(工地工班風畫面 AC-10):會害你丟東西、誤會結果的那兩句留在外面(全綠不等於功能正確、回去會丟掉沒存的),
  // 解釋「為什麼」的收進「為什麼？」——收起來的字還在網頁上,不是刪掉
  const whyKey = `why|${c.path}|restore`;
  // 回去會丟掉什麼,照實講(規格:先講commit再講蓋章 AC-9):以前這一行永遠掛著,都 commit 了也照樣說「會丟掉」——
  // Oscar 以為還有東西沒存、別張卡算錯了(2026-10-29)。句子跟終端機「怎麼回去」那一段同一句(伺服器照 lib/scope.mjs 算好的 c.lines),
  // 個數跟三階梯、存檔與蓋章卡同一份。一個都沒有才拿掉 ⚠️——問不到 ≠ 沒有。舊的服務沒給那一句:不知道有沒有,照以前那樣提醒
  const lose = q && 'restoreUnsaved' in q
    ? (c.dirty === 0 ? `<div class="hint">${esc(q.restoreUnsaved)}</div>` : `<div class="hint warn">⚠️ ${esc(q.restoreUnsaved)}</div>`)
    : zhEn('<div class="hint warn">⚠️ 回去會丟掉還沒 commit 的東西</div>', '<div class="hint warn">⚠️ Going back will lose anything not committed yet</div>');
  const n = rel.commitsAfter;
  return `<div class="stat" data-note="restore" data-tone="restore">
    ${head}
    <div class="big">${esc(c.cpVersion ? `v${c.cpVersion}` : clock(cp.at))}</div>
    <div class="sub">${zhEn(`${ago(cp.at)}存的${c.cpVersion ? `（${esc(clock(cp.at))}）` : ''}`, `stamped ${ago(cp.at)}${c.cpVersion ? ` (${esc(clock(cp.at))})` : ''}`)}</div>
    <div class="pills">${pills}</div>
    <div class="hint">${zhEn('當時這幾項全綠。', 'These checks were all green at the time. ')}${say(q?.green)}</div>
    <button class="copy" data-copy="${esc(cmd)}">${zhEn('複製回去的指令', 'Copy the command to go back')}</button>
    ${lose}
    <details class="why" data-fold="${esc(whyKey)}"${foldOpen(whyKey, false) ? ' open' : ''}><summary>${zhEn('為什麼？', 'Why?')}</summary>
      <p>${zhEn('這個網頁<b>不會</b>幫你還原，按鈕只是複製指令。指令<b>已經含 cd</b>，貼到終端機、或直接貼給 Claude 都可以——貼給 Claude 的話，它會先問過你才動手。',
        'This page <b>won\'t</b> restore anything for you; the button only copies the command. The command <b>already includes cd</b>, so you can paste it into a terminal or straight to Claude; if you paste it to Claude, it will ask you before doing anything.')}</p>
      ${n ? zhEn(`<p>蓋章之後你存了 ${n} 次：指令會先把它們留在分支 <code>${esc(c.backupBranch ?? '')}</code> 上，再回去。</p>`,
        `<p>You committed ${many(n, 'time')} after the stamp: the command first keeps ${n === 1 ? 'that commit' : 'those commits'} on the branch <code>${esc(c.backupBranch ?? '')}</code>, then goes back.</p>`) : ''}
    </details>
  </div>`;
}

function statLadder(c) {
  const L = c.ladder ?? {};
  // 每一階是一個膠囊;膠囊之間有一段會流動的連接線。
  // ⚠️ 三段的流動速度一樣,不隨狀態變——否則會被讀成「現在正在跑」。
  // ⚠️ 暈染標的是「**這一階已經完成**」,不是「卡在哪」。
  // 我上一版做反了——Oscar:「我的顏色要顯示在已完成的階梯上」。
  const cap = (n, ok, title, detail) => {
    return `<div class="cap" data-ok="${ok ? 'yes' : 'no'}">
       <span class="capn">${n}</span>
       <span class="capt"><b>${title}</b><small>${detail}</small></span>
     </div>`;
  };

  // 狀態與文案是伺服器算好的(lib/collect.mjs 的 ladderSteps,被測試釘住);這裡只畫。
  // ⚠️ 只有 done 亮燈。none(沒有東西)跟 unknown(問不到)都不亮——
  //    空的分支曾經亮了兩格「都存好了／已經併進去了」,Oscar 一眼就看出那是假的(LESSONS L16)。
  const TITLE = { commit: zhEn('commit 存進這條分支', 'commit to this branch'), merge: zhEn(`merge 併進 ${esc(L.mainName ?? '主線')}`, `merge into ${esc(L.mainName ?? 'the main line')}`),
                  push: zhEn('push 推到 GitHub', 'push to GitHub') };
  const steps = L.steps ?? ['commit', 'merge', 'push'].map((id) => ({ id, state: 'unknown', text: zhEn('問不到', 'couldn\'t check') }));
  const caps = steps.map((st, i) => cap(i + 1, st.state === 'done', TITLE[st.id] ?? esc(st.id), esc(st.text))).join('');

  // 沒有任何一格是「還有東西沒做」或「問不到」,才算安全——空的分支也算安全,它沒有東西會丟
  const allSafe = steps.every((st) => st.state === 'done' || st.state === 'none');
  return `<div class="stat" data-note="ladder" data-tone="${allSafe ? 'safe' : 'alert'}">
    ${zhEn('<h3 class="ctitle">三階梯</h3><div class="label">東西走到哪了</div>', '<h3 class="ctitle">Three steps</h3><div class="label">How far things have got</div>')}
    <div class="pipe">${caps}</div>
    ${L.webUrl ? `<div class="hint"><a class="ext" href="${esc(L.webUrl)}" target="_blank"
      rel="noreferrer">${zhEn('在 GitHub 上看 ↗', 'See it on GitHub ↗')}</a></div>` : ''}
    <details class="why" data-fold="${esc(`why|${c.path}|ladder`)}"${foldOpen(`why|${c.path}|ladder`, false) ? ' open' : ''}><summary>${zhEn('為什麼會退回去？', 'Why does it go back?')}</summary>
      <p>${zhEn('這三格是<b>現在的事實</b>，不是你走過的最遠距離：併完之後又動了新東西，它就會退回去。',
        'These three are <b>the facts right now</b>, not the furthest you\'ve ever got: if something new changes after merging, they go back.')}</p></details>
  </div>`;
}

function statChanges(c) {
  // 先講 commit 了沒,都 commit 了才講還沒蓋章(規格:先講commit再講蓋章)。以前大字是「改過幾個」、還沒 commit 的放小字,
  // 標題又寫死「未檢查清單」:Oscar 每次都要猜這張卡在講 commit 還是蓋章,還沒 commit 的 3 個只有 1 個露在外面(2026-10-29);
  // 9/15 也把「commit 後還沒被檢查」讀成「還沒 commit」。標題只講主題、不講狀態(AC-7),狀態寫在大字與它底下那一行。
  // 範圍那幾句(從哪裡算起、看不到哪些)是伺服器用 lib/scope.mjs 算好的(c.scope)——這裡不 import 那支:常駐服務只送它啟動那一刻白名單裡的檔案,
  // 多一個新檔,更新後還沒重啟的那段時間整個畫面會載不進來
  const f = c.files;
  const sc = c.scope ?? {};
  const q = c.lines ?? {};
  // 標題固定(「Commit & stamp」,Oscar 2026-10-29 點頭)、灰色小字固定;大字可以換行,不准被切掉(規格:儀表板與終端機中英切換 AC-6)
  const card = (body) => `<div class="stat" data-note="changes" data-tone="change">
    ${zhEn('<h3 class="ctitle">存檔與蓋章</h3><div class="label">commit 了沒、蓋章了沒</div>', '<h3 class="ctitle">Commit &amp; stamp</h3><div class="label">Committed? Stamped?</div>')}${body}</div>`;
  if (!f) return card(`<div class="big">${zhEn('問不到', 'Couldn\'t check')}</div>`);
  // 舊的服務(還沒 --serve-restart)沒給「還沒 commit 的是哪些」:不拿「改過的單子裡標了還沒存的」硬湊——那一份會漏(AC-2),講服務還在跑舊的程式(AC-10)
  if (!('unsaved' in f)) return card(`<div class="sub">${OLD_LINE}</div>`);

  const groupsOf = (gs) => gs.map((g) => `<div class="fgroup">
      <div class="dir">${esc(g.dir)}/</div>
      <ul>${g.items.map((it) => `<li class="${it.isNew ? 'isnew' : ''}">${esc(it.name)}${it.isNew ? zhEn(' · 新檔案', ' · new file') : ''}</li>`).join('')}</ul>
    </div>`).join('');
  // 檔名只露前 5 個,其餘收在「還有 N 個檔案」(工地工班風畫面 AC-13):改動一多,五關就被擠出第一屏。N 是收起來的真的個數
  const listOf = (gs) => {
    const shown = [], rest = [];
    let room = 5;
    for (const g of gs) {
      const head = g.items.slice(0, Math.max(0, room));
      room -= head.length;
      if (head.length) shown.push({ ...g, items: head });
      if (head.length < g.items.length) rest.push({ ...g, items: g.items.slice(head.length) });
    }
    const restCount = rest.reduce((n, g) => n + g.items.length, 0);
    const key = `files|${c.path ?? ''}`;
    return `<div class="files">${groupsOf(shown)}${restCount
      ? `<details class="more" data-fold="${esc(key)}"${foldOpen(key, false) ? ' open' : ''}><summary>${zhEn(`還有 ${restCount} 個檔案`, many(restCount, 'more file'))}</summary>${groupsOf(rest)}</details>` : ''}</div>`;
  };
  // 最下面收起來的:commit 跟蓋章差在哪(每一頁都一樣,伺服器放在最上層)、全部改了幾個、比例尺、從哪裡算起(AC-8)。
  // 「全綠不等於功能正確」、比例尺、從哪裡算起是終端機也講的那幾句,照印
  const H = latest?.stampHelp ?? null;
  const whyKey = `why|${c.path ?? ''}|changes`;
  const help = `<details class="why" data-fold="${esc(whyKey)}"${foldOpen(whyKey, false) ? ' open' : ''}><summary>${zhEn('commit 跟蓋章差在哪？', 'What\'s the difference between commit and stamp?')}</summary>
      ${H ? `<p>${esc(H.commit)}</p><p>${mark(H.stamp, 'pipeline-status --checkpoint', 'code')}${q.green ? `<br>${esc(q.green)}` : ''}</p><p>${esc(H.order)}</p>` : `<p>${OLD_LINE}</p>`}
      ${f.total ? zhEn(`<p>${esc(sc.title ?? '')}：${f.total} 個檔案。${c.scale && q.scale ? `參考：${esc(q.scale)}。` : ''}${sc.note ? `${esc(sc.note)}。` : ''}</p>`,
        `<p>${esc(sc.title ?? '')}: ${many(f.total, 'file')}.${c.scale && q.scale ? ` For reference: ${esc(q.scale)}.` : ''}${sc.note ? ` (${esc(sc.note)})` : ''}</p>`) : ''}
    </details>`;

  const u = f.unsaved;
  // 從 main 併進來、這一輪沒算的檔(規格:併進來的不算這一輪 AC-5):清單底下講幾個,句子是伺服器照 lib/scope.mjs 給的。舊的服務沒給就不講(照舊)
  const merged = sc.mergedNote ? `<div class="hint">${esc(sc.mergedNote)}${zhEn('。', '.')}</div>` : '';
  // 問不到 ≠ 沒有(R1):問不到哪些還沒 commit,就不往下講「都 commit 了」「N 個還沒蓋章」(AC-6)
  if (u === null) return card(`<div class="big">${zhEn('問不到', 'Couldn\'t check')}</div><div class="sub">${q.unsavedWhether ? `${esc(q.unsavedWhether)}${zhEn('。', '.')}` : OLD_LINE}</div>${help}`);

  // 還有東西沒 commit:大字是還沒 commit 幾個、清單只列它們(AC-1)。已經 commit、還沒蓋章的不消失,收成一行(AC-3)——
  // 不留的話,commit 完最後幾個,大字會一下從 3 跳成 23。看不到 commit 過的是哪些,就講看不到(AC-5)
  if (u.count > 0) {
    const savedKey = `saved|${c.path ?? ''}`;
    const others = sc.unseen ? `<div class="hint">${esc(sc.unseen)}${zhEn('。', '.')}</div>`
      : f.saved?.count && sc.savedTail ? `<details class="more" data-fold="${esc(savedKey)}"${foldOpen(savedKey, false) ? ' open' : ''}><summary>${zhEn(`另外 ${f.saved.count} 個${esc(sc.savedTail)}`, `${many(f.saved.count, 'more file')} ${esc(sc.savedTail)}`)}</summary>${groupsOf(f.saved.groups)}</details>`
      : '';
    return card(`<div class="big"><span class="num">${u.count}</span><span class="unit">${zhEn('個檔案還沒 commit', u.count === 1 ? 'file not committed yet' : 'files not committed yet')}</span></div>
    ${listOf(u.groups)}${others}${merged}${help}`);
  }
  // 都 commit 了,但看不到 commit 過的是哪些:不畫「沒有改動」(老毛病 P5),講看不到
  if (sc.blind) return card(`<div class="big">${zhEn('都 commit 了', 'All committed')}</div><div class="sub">${sc.unseen ? `${esc(sc.unseen)}${zhEn('。', '.')}` : ''}</div>${help}`);
  // 都 commit 了、跟起點一樣:這一輪中間存過檔或切過分支的話,0 不是「沒有改動」(P5),照伺服器給的那一句講
  const s = f.saved;
  // 只有從 main 併進來的:不是「沒有改動」(檔案已經跟開始時不一樣),是這一輪自己沒有改動——底下那一句講拿掉幾個(併進來的不算這一輪 AC-5)
  if (!s?.count) return card(`<div class="big">${sc.merged ? zhEn('這一輪沒有改動', 'No changes this round') : sc.emptyBlind ? zhEn('看不全', 'Can\'t see all of it') : zhEn('沒有改動', 'No changes')}</div><div class="sub">${esc(sc.empty ?? '')}</div>${help}`);
  // 都 commit 了:改講還沒蓋章(AC-4)。不加綠色、不打勾——蓋過章也只代表檢查全綠(老毛病 P10)
  return card(`<div class="big"><span class="num">${s.count}</span><span class="unit">${zhEn('個檔案還沒蓋章', s.count === 1 ? 'file not stamped yet' : 'files not stamped yet')}</span></div>
    <div class="sub">${sc.allSaved ? `${esc(sc.allSaved)}${zhEn('。', '. ')}` : ''}${zhEn('要蓋章：在那個資料夾跑 <code>pipeline-status --checkpoint</code>', 'To stamp: run <code>pipeline-status --checkpoint</code> in that folder')}</div>
    ${listOf(s.groups)}${merged}${help}`);
}

/* ═══ 分級:伺服器(lib/tier.mjs)算好,這裡只畫。那幾句是伺服器照 tierLines 算好的(tier.lines),跟終端機的 describeTier 同一句 ═══ */
function statTier(c, p) {
  const t = c.tier;
  if (!t) return '';
  const q = t.lines ?? null;   // 舊的服務沒給 → 每一句講舊的程式,不自己拼(規格:終端機與網頁說同一句 AC-5)
  const say = (v) => esc(q ? v ?? '' : OLD_LINE);
  const card = (tone, big, sub, extra = '') => `<div class="stat" data-note="tier" data-tone="${tone}">
    ${zhEn('<h3 class="ctitle">分級</h3><div class="label">這次要多小心</div>', '<h3 class="ctitle">Tier</h3><div class="label">How careful to be this time</div>')}
    <div class="big">${big}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${extra}</div>`;
  // ⚠️ 沒設定 ≠ T0(R1);讀不懂 ≠ 沒設定。四種各自一張臉——大字是畫面自己的,底下那句是伺服器給的
  if (t.state === 'unset') return card('change', zhEn('還沒設定', 'Not set up yet'), q ? mark(q.setupHint, zhEn('幫我設定分級', 'set up tiers for me')) : say());
  if (t.state === 'off') return card('change', zhEn('不分級', 'No tiers'), q ? mark(q.main, 'pipeline-status --tier-init', 'code') : say());
  if (t.state === 'broken') return card('alert', zhEn('讀不懂', 'Can\'t read it'), q ? esc(zhEn(`${q.main}。${q.tail}`, `${q.main}. ${q.tail}`)) : say());
  if (t.state === 'no-base') return card('change', zhEn('沒有基準', 'No baseline'), say(q?.main));
  if (t.state === 'unknown') return card('change', zhEn('問不到', 'Couldn\'t check'), say(q?.main));
  const emptyWarn = q?.emptyWarn ? `<div class="hint">${esc(q.emptyWarn)}</div>` : '';
  if (t.state === 'no-change') return card('safe', zhEn('沒有改動', 'No changes'), say(q?.main), emptyWarn);
  // 同一個 0 的另一種意思(老毛病 P5):只看得到還沒存的,而還沒存的沒有——不是那張安全的綠臉(規格:這一輪的起點 AC-4)
  if (t.state === 'unseen') return card('change', zhEn('看不全', 'Can\'t see all of it'), q ? esc(zhEn(`${q.main}${q.tail}`, `${q.main} ${q.tail}`)) : say());
  if (t.state !== 'ok') return card('change', zhEn('讀不懂', 'Can\'t read it'), say(q?.main));

  const { manual, final } = t;
  // 機器為什麼算這一級／你調高的那一句;只算得到還沒存的:存檔過的看不到,實際可能更高——都是伺服器給的那一句
  const sub = !q ? say() : manual ? mark(q.main, zhEn(`你說 ${manual.id}`, `you said ${manual.id}`)) : esc(q.why);
  const blind = q?.blind ? `<div class="hint">${esc(q.blind)}</div>` : '';
  // ✅ 有紀錄而且結案了(Claude 說／你說);⏸ 有紀錄沒結案;⚠️ 沒有紀錄;❔ 問不到／不適用;🔗 規格是別的對話寫的(Claude 說照哪份施工)。沒有「通過」這種狀態(R2)。
  const reqs = q?.reqs?.length
    ? `<ul class="reqs">${q.reqs.map((r) => `<li data-state="${esc(r.state)}">${esc(r.mark)} ${esc(r.label)}${zhEn('：', ': ')}${esc(r.text)}</li>`).join('')}</ul>`
    : '';
  const cand = q?.candidates ? `<div class="hint">${esc(q.candidates)}</div>` : '';
  // 危險清單可能過期了(規格:危險清單會過期):句子是伺服器算好的(lib/tier.mjs,跟終端機同一句),這裡只畫。舊的服務沒給就不畫
  const stale = (t.staleNotes ?? []).map((x) => `<div class="hint">${esc(x)}</div>`).join('');
  const ignored = q?.ignored ? `<div class="hint">${esc(q.ignored)}</div>` : '';
  // 調高:只列比機器算的高的等級,理由必填。收回:只收回你自己調的,回到機器算的——沒有任何按鈕能低於機器算的。
  const control = manual
    ? `<button class="mini-btn" data-tier-retract data-proj="${esc(p.name)}" data-cwd="${esc(c.path)}">${zhEn('收回', 'Take back')}</button>`
    : t.upgradable.length
      ? `<form class="tierform" data-tier-form data-proj="${esc(p.name)}" data-cwd="${esc(c.path)}">
          <select name="level">${t.upgradable.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('')}</select>
          <input name="why" placeholder="${zhEn('理由（必填）', 'Reason (required)')}" required maxlength="200">
          <button class="mini-btn" type="submit">${zhEn('調高', 'Raise')}</button></form>`
      : '';
  const tone = t.requirements.some((r) => r.state === 'missing') ? 'alert' : 'safe';
  return card(tone, esc(manual ? manual.id : final.id), sub,
    `${blind}${reqs}${ignored}${emptyWarn}${cand}${stale}
    <div class="hint muted">${say(q?.upOnly)}</div>${control}`);
}

/**
 * 感測器那一行(誠實修補 D3):「掛在哪」看設定,「活著嗎」看紀錄。字都是伺服器給的,跟終端機同一句——
 * 已掛上、最後一筆、掛壞了、收工 hook、沒掛上(c.sensor.lines,lib/faults.mjs 的 sensorParts)、沒有紀錄(noneLine)、設定裡沒掛上的那兩種(offLine)、修法(fix)。
 * 舊的服務沒給:不在這裡猜(證據在手上時不准說「沒掛上」,R1),講服務還在跑舊的程式(規格:終端機與網頁說同一句 AC-5)。
 */
function sensorLine(c) {
  const m = c.sensor?.mount, q = c.sensor?.lines ?? null;
  const restart = zhEn('（儀表板的服務還在跑舊的程式，重啟它：<code>pipeline-status --serve-restart</code>）',
    ' (the dashboard service is still running the old program; restart it: <code>pipeline-status --serve-restart</code>)');
  if (m?.state === 'broken') {
    // ⚠️ 最危險的一種:設定看起來好好的,紀錄卻安靜地停了(LESSONS L13)
    if (!q) return zhEn(`<p class="section-note">🔴 感測器掛著,但它指向的檔案不存在${restart}。</p>`, `<p class="section-note">🔴 The sensor is hooked up, but the file it points to doesn't exist${restart}.</p>`);
    return `<p class="section-note">${mark(q.broken, q.em)}${q.stopped ? zhEn(`（${esc(q.stopped)}）`, ` (${esc(q.stopped)})`) : ''}${zhEn('。', '. ')}${esc(c.sensor?.fix ?? '')}</p>`;
  }
  if (m?.state === 'ok') {
    if (!q || !('noneLine' in c.sensor)) return zhEn(`<p class="section-note">感測器：已掛上${restart}</p>`, `<p class="section-note">Sensor: hooked up${restart}</p>`);
    // 收工 hook 活著沒:看心跳,不看設定——「掛著」不等於「活著」(L13)。
    // 三件事各放一顆小標籤,字照伺服器給的、一段都不拆(終端機同一句;工地工班風畫面 AC-10)
    return `<p class="section-note chips">${[q.mounted, q.seen ?? c.sensor.noneLine ?? '', q.gate].map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</p>`;
  }
  // 設定裡沒掛上的那兩種(你退出了、設定裡找不到但紀錄還有 → 它在記):伺服器照終端機同一個函式算好給的那一句(lib/faults.mjs 的 sensorOffLine)
  if (c.sensor && 'offLine' in c.sensor && (c.sensor.offLine || q)) {
    return `<p class="section-note">${c.sensor.offLine ? esc(c.sensor.offLine) : mark(q.notMounted, 'pipeline-status --on', 'code')}</p>`;
  }
  return zhEn(`<p class="section-note">感測器：設定裡找不到——細節跑 <code>pipeline-status</code> 看${restart}。</p>`,
    `<p class="section-note">Sensor: not found in the settings. For details, run <code>pipeline-status</code>${restart}.</p>`);
}

/** 專案自己寫的關卡讀不懂、先照內建的五關畫:伺服器給的那一句(跟終端機同一句,lib/rounds.mjs)。沒有就不畫 */
function stagesNoteLine(c) {
  return c.stagesNote ? `<p class="section-note">${esc(c.stagesNote)}</p>` : '';
}

/* ═══ My Agent work flow:左邊架構圖,右邊五張說明卡 ═══ */
function workflow(c) {
  // ⚠️ 左邊的軌道與右邊的卡片放在**同一個 grid 的同一列**,
  // 這樣 A–E 的對應是**版面結構保證的**,不是靠我調數字對齊——
  // 靠調數字的話,卡片內容一長就會錯開,而錯開的對應圖比沒有圖更糟。
  // 這一輪走到的那一關:工班發光、整張攤開。跟對話列「這一輪走到 X」同一個判斷(roundStage,老毛病 P2)
  const hereId = roundStage(c.stages)?.st.id ?? null;
  const rows = c.stages.map((st) => {
    const s = stageState(st);
    const r = ROLE[st.id] ?? { house: '', does: '' };
    const said = st.type === 'browser' ? zhEn('驗收過了', 'accepted') : zhEn('處理完了', 'handled');
    // 只有驗收那一關有按鈕(五關自動結案 AC-10):其他關由儀表板自動辨識——按鈕多了會被忽略跳過(Oscar)。跟 CLI 的 --clear 同一種紀錄(source:human)
    // E 還沒被你說驗收過(只開過瀏覽器、Claude 走過一遍等你查核、你說過了之後又改了程式、你說不用再走)都給按鈕;按了是你說的(source:human)
    const stamp = st.type === 'browser' && ['seen', 'ran', 'stale', 'held'].includes(s) && c.path
      ? `<button class="mini-btn" data-clear="${esc(st.id)}" data-proj="${esc(c.project ?? '')}" data-cwd="${esc(c.path)}">${zhEn(`你說${said}`, `You say it's ${said}`)}</button>` : '';
    // E 驗收:三句話分開講——開過瀏覽器、Claude 說走了一遍、你說驗收過了(E 自動驗收 AC-7)。文案是伺服器照 lib/verify.mjs 算好的,這裡只畫;
    // 「看到了」不劃掉、不打勾(那是 Claude 說的,R2)。舊的服務沒給 elines 就照舊畫一行
    const el = st.type === 'browser' ? st.elines ?? null : null;
    const eList = el?.items?.length
      ? `<ul class="acl">${el.items.map((it) => `<li data-verdict="${esc(it.verdict)}"><span class="mark">${esc(it.mark)}</span>
          <span>${it.id ? `<b>${esc(it.id)}</b> ` : ''}${esc(it.body)}${it.note ? `<span class="muted">${esc(it.note)}</span>` : ''}</span></li>`).join('')}</ul>` : '';
    // 那一句是伺服器照 lib/stageLines.mjs 算好的,跟終端機同一句(B 改到程式檔沒、A 等你點頭、D 要不要再跑由你決定…)。這裡只畫
    const status = 'line' in st ? st.line ?? '' : OLD_LINE;
    const saidArgs = st.args
      ? `<div class="said">${zhEn(`「${esc(st.args.slice(0, 90))}${st.args.length > 90 ? '…' : ''}」`, `“${esc(st.args.slice(0, 90))}${st.args.length > 90 ? '…' : ''}”`)}</div>` : '';
    // 寫規格那一關的旁白(規格在哪、另寫了一份…):伺服器給的,跟終端機同一句。舊的服務沒給:那一格的狀態列已經講了舊的程式
    const notes = (Array.isArray(st.notes) ? st.notes : []).map((n) => `<div class="said">${esc(n)}</div>`).join('');
    // A 的清單就是規格檔裡的 AC,照檔案畫(AC-5)。解析不了就照原文、找不到就說找不到——不假裝
    // 只有 A 帶完整的清單(有 items);B 只帶進度摘要,進度已經寫在狀態列,這裡不畫——畫下去就是 undefined 的 .map(2026-09-16 實際炸過一次)
    const cl = st.checklist && Array.isArray(st.checklist.items) ? st.checklist : null;
    const aclItems = (x) => `<ul class="acl">${x.items.map((it) => `<li data-state="${esc(it.state)}"${it.inBatch === false ? ' data-batch="out"' : ''}><span class="mark">${it.state === 'checked' ? '✅' : it.state === 'pending' ? '⏳' : '○'}</span>
          <span><b>${esc(it.id)}</b> ${esc(it.title)}${it.state === 'pending' && it.note ? `<span class="muted">${zhEn(`（待討論：${esc(it.note)}）`, ` (pending discussion: ${esc(it.note)})`)}</span>` : ''}${it.inBatch === false ? `<span class="muted">${zhEn('（不在這一批）', ' (not in this batch)')}</span>` : ''}${
          it.plain ? `<div class="plain">${esc(it.plain)}</div>` : ''}</span></li>`).join('')}</ul>`;
    // 可收折、預設收起(Oscar 2026-09-16):摘要一行講進度,展開才看每一條;對過的劃掉
    // 預設展開;你收起來就記住,資料每幾秒重畫一次也不會蓋掉你的選擇(Oscar 2026-09-16:一重畫就縮回去,很干擾)
    const aclBox = (key, summary, inner) => `<details class="acl-box" data-fold="${esc(key)}"${foldOpen(key) ? ' open' : ''}><summary>${summary}</summary>
        ${inner}</details>`;
    // 清單上面那一句、收合的標題、為什麼還不算寫完、好幾份時每一份那一句:伺服器照 lib/stageLines.mjs 算好的(cl.lines),跟終端機同一句
    const L = cl?.lines ?? null;
    const lineOf = (v) => (L ? v ?? '' : OLD_LINE);
    const clHtml = !cl ? ''
      // 一輪寫了好幾份(規格:多份規格與新資料夾的起點 AC-1、AC-2、AC-5):一份一個清單,各寫各的條數;總數只加讀得到的,讀不到的講出來。
      // 不在這個工作區的那一份,在哪、為什麼,旁白講了
      : cl.multi ? `<div class="acl">${esc(lineOf(L?.head))}</div>`
        + cl.parts.map((p, i) => (!p.checklist ? ''
          : !p.checklist.parsed ? `<div class="acl muted">${esc(lineOf(L?.parts?.[i]))}</div>`
          : aclBox(`${c.path ?? ''}|${st.id}|${p.name}`, zhEn(`驗收清單 · ${esc(lineOf(L?.parts?.[i]))}`, `Acceptance checklist · ${esc(lineOf(L?.parts?.[i]))}`), aclItems(p.checklist)))).join('')
      : cl.missing || !cl.parsed ? `<div class="acl muted">${esc(lineOf(L?.head))}</div>`
      // 分批做的規格(施工對話認規格 AC-8):整份照畫,不在這一批的標出來、淡一點——收工前只要求這一批
      : aclBox(`${c.path ?? ''}|${st.id}`, esc(lineOf(L?.title)),
        `${L?.why ? `<div class="said">⚠️ ${esc(L.why)}</div>` : ''}
        ${aclItems(cl)}`);
    // 結論的說明有清單(多行)時,一行一條列在卡上——C 的建議、D 的發現就住在這裡
    const noteLines = String(st.report?.note ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    // 已走過的關也要列(C 已走過,它的建議還是要看得到——「有幾條就列幾條」)
    const noteHtml = !el && noteLines.length > 1 && (s === 'done' || s === 'ran' || s === 'stale' || s === 'passed' || s === 'held')
      ? `<ul class="rnote">${noteLines.slice(1).map((l) => `<li>${esc(l.replace(/^[-•]\s*/, ''))}</li>`).join('')}</ul>` : '';

    // 不是走到的那一關就縮成一行(名字＋狀態那一行),點「細節」才攤開,重新整理也記得(工地工班風畫面 AC-15)。
    // 要處理的、有「你說驗收過了」按鈕的不縮——縮起來就看不到了
    const here = st.id === hereId;
    const foldKey = `stage|${c.path ?? ''}|${st.id}`;
    const detail = `<div class="adoes">${esc(r.does)}</div>${saidArgs}${notes}${clHtml}${noteHtml}${eList}`;
    const body = here || s === 'stale' || stamp ? `${detail}${stamp}`
      : `<details class="amore" data-fold="${esc(foldKey)}"${foldOpen(foldKey, false) ? ' open' : ''}><summary>${zhEn('細節', 'Details')}</summary>${detail}</details>`;

    return `<div class="railcell" data-state="${s}">
        <span class="rlab">${esc(st.id)}</span>
        <span class="dot"></span>
      </div>
      <div class="acard" data-state="${s}"${here ? ' data-here="1"' : ''}>
        ${agent(st, s, here)}
        <div class="abody">
          <div class="atitle">${esc(st.id)} ${esc(st.name)}
            <span class="ahouse">${esc(r.house)}</span></div>
          <div class="astatus">${el ? [el.acts, el.walk, el.human].map(esc).join('<br>') : esc(status)}</div>
          ${body}
        </div>
        <span class="lamp" title="${st.type === 'browser' && st.ewhere ? esc(st.ewhere) : s === 'passed' ? zhEn('已走過', 'moved on') : s === 'done' || s === 'ran' ? zhEn('現在這一關', 'current stage')
          : s === 'stale' ? (st.type === 'main-conversation' ? zhEn('清單沒對完', 'checklist not fully checked') : !st.rerun ? zhEn('結論過期,要再跑一次', 'the conclusion is out of date; run it again')
            : st.rerun.state === 'no-report' ? zhEn('Claude 還沒記結論', 'Claude hasn\'t recorded a conclusion yet') : st.rerun.state === 'found' ? zhEn('Claude 說找到問題,還沒處理完', 'Claude says it found problems, not handled yet')
            : zhEn('改過程式檔,要不要再跑由你決定', 'code files changed; whether to run it again is your call'))
          : s === 'held' ? zhEn('Claude 記下你說不用再跑——是你的決定,不是驗過了', 'Claude recorded that you said no need to run it again: your decision, not a check')
          : s === 'seen' ? zhEn('開過瀏覽器', 'browser was opened') : zhEn('這一輪還沒跑', 'not run yet this round')}"></span>
      </div>`;
  }).join('');

  // ⚠️ 一條貫穿 A→E 的線,絕對定位在整個左欄上——不是每一格各畫一段。
  // 分段畫的話,卡片高度不同就會在接縫處斷開。
  return `<div class="wf">
    <svg class="wf-line" preserveAspectRatio="none" viewBox="0 0 10 1000">
      <path d="M5 6 C2.6 130, 7.8 250, 4.6 372 C1.8 480, 8 600, 5.2 720
               C3 820, 7.4 900, 5 994"/>
    </svg>${rows}${c.director ? directorRow(c) : ''}</div>`;
}

/** F 工地主任要的那一份:這個對話在總表裡的收尾狀況(lib/todo.mjs 的 desk)、它提的建議卡。舊的服務沒有 todo → 那一列講服務是舊的 */
function directorOf(p, s) {
  // loose:記不到是哪個對話放的卡(終端機 --suggest 放的沒有對話代號)——算不到這個對話頭上,也不准因此講成沒有(R1、P7)
  const all = p?.suggestions ?? [];
  return { id: s.id, hasTodo: !!latest && 'todo' in latest, desk: latest?.todo?.desk?.[s.id] ?? null,
           cards: all.filter((x) => x.session === s.id), loose: all.filter((x) => !x.session && !cardFolded(x)).length };
}
/**
 * F 工地主任(規格:還差什麼總表 AC-12):五關下面多一列,提醒這個對話收尾了沒、有沒有它提的新對話建議卡。
 * ⚠️ 不是 stages.json 的關:收工 hook、分級、感測器都不認它,只是畫面上的一列;字母照最後一關的下一個排(不寫死,也不會跟真的關撞名)。
 * 每一件的字是伺服器照 lib/todo.mjs 算好的,跟案件頁白板、終端機 --todo 同一句;建議卡「還沒開始」跟「建議新增的對話」那一區同一個判斷(cardFolded)。
 * ⚠️ 一張卡都沒記到要講「不代表沒跳過」,不講「沒有」(老毛病 P5)
 * 最後一行講怎麼叫主任(規格:主任技能 AC-1):主任是對話裡的一支技能,這一列只照總表講、不會自己給建議。已結案的對話沒有收尾要合成,不畫。
 * 只剩收尾的時候那一行亮起來(規格:主任動手收尾 AC-9):亮不亮與那一句是伺服器照總表算好的(lib/todo.mjs 的 callLine),這裡只照印——用主任的黃,不用綠、不打勾
 * 外面只講重點:狀態一句、一串條列(每一件、建議卡、分不出是誰放的卡、叫主任),說明收進「細節」(規格:主任條列與工地帽 AC-1)。
 * ⚠️ 會讓人誤會的但書留在外面,縮短就好:「紀錄裡沒有」後面的「不代表沒跳過」剪掉,就讀成「沒有建議卡」(AC-2,R1、老毛病 P5)。
 * 左邊那一顆圓點不借五關的樣子(實心藍是「這一輪走到這一關」):平常空心,那一行亮的時候才塗主任的黃,跟那一行同一個判斷(AC-6,老毛病 P2)
 */
function directorRow(c) {
  const d = c.director, e = d.desk;
  const last = c.stages[c.stages.length - 1];
  const letter = /^[A-Y]$/.test(last?.id ?? '') ? String.fromCharCode(last.id.charCodeAt(0) + 1) : '+';
  const r = ROLE.director ?? { house: '', does: '' };
  const mood = !d.hasTodo || !e ? 'unknown' : bossMood([e]);
  const status = !d.hasTodo ? OLD_LINE
    : !e ? zhEn('總表裡還找不到這個對話——等下一次更新', 'This conversation isn\'t in the summary yet: wait for the next update')
    : e.clear ?? [e.closed ? e.closedNote : null, countsOf(e)].filter(Boolean).join(' · ');
  const n = d.cards.length, open = d.cards.filter((x) => !cardFolded(x)).length;
  const cards = open ? zhEn(`建議卡：還沒開始 ${open} 張（在案件頁）`, `Suggestion cards: ${open} not started yet (on the project page)`)
    : n ? zhEn(`建議卡：提過 ${n} 張，都開始了、不做了或被取代了`, `Suggestion cards: ${n === 1 ? '1 raised; it was' : `${n} raised; all were`} started, set aside, or replaced`)
    : zhEn('建議卡：紀錄裡沒有（不代表沒跳過）', 'Suggestion cards: none in the records (that doesn\'t mean none came up)');
  const loose = d.loose ? zhEn(`另有 ${d.loose} 張建議卡分不出是哪個對話放的（在案件頁）`, `${d.loose === 1 ? '1 more suggestion card' : `${d.loose} more suggestion cards`}: which conversation placed ${d.loose === 1 ? 'it' : 'them'} can't be told (on the project page)`) : '';
  const call = !e || e.closed ? '' : e.call ?? zhEn('叫主任：在對話裡說「主任」', 'To call the site director: say "site director" in the conversation');
  // 每一件照伺服器那一句(跟白板、終端機 --todo 同一句,AC-3);後面那幾條不是還差的事,記號用說明的那一種(AC-4,data-k="note")
  const list = [...(e?.items ?? []).map((i) => `<li data-k="${esc(i.kind)}">${esc(i.text)}</li>`),
    `<li data-k="note">${esc(cards)}</li>`, loose ? `<li data-k="note">${esc(loose)}</li>` : '',
    call ? `<li data-k="note"${e.call ? ' class="call"' : ''}>${esc(call)}</li>` : ''].join('');
  const foldKey = `director|${c.path ?? ''}|${d.id ?? ''}`;
  const why = [r.does,
    e && !e.closed ? zhEn('叫了之後：它給一個下一步，把這個對話能一起做的收尾合成一個問題；你回一句，它才照順序做（併進 main、推上 GitHub、要的話重啟、最後蓋章），每一步講成了沒。按結案留給你。也可以打 /pipeline-monitor:director 叫它。',
      'After you call it: it gives one next step and puts this conversation\'s wrap-up that can go together into one question; only after your one reply does it do them in order (merge into main, push to GitHub, restart if needed, stamp last), saying for each step whether it went through. Close is left to you. You can also type /pipeline-monitor:director to call it.') : '',
    e?.call ? zhEn('那一行亮黃燈只表示現在可以叫主任，不是做完了：白板看不到 Claude 這一回合做完了沒。', 'The yellow line only means you can call the site director now, not that the work is done: the board can\'t see whether Claude has finished this turn.') : '',
    zhEn('建議卡在案件頁「建議新增的對話」那一區；有些卡這裡看不到，原因寫在那一區的說明。', 'Suggestion cards are in "Suggested new conversations" on the project page; some cards can\'t be seen here, and why is explained in that section.'),
    d.loose ? zhEn('分不出是哪個對話放的那幾張，紀錄裡沒記是誰放的（例如在終端機用 --suggest 放的）：算不到這個對話頭上，也不能當成沒有。', 'For the cards whose conversation can\'t be told, the records don\'t say who placed them (for example, ones placed with --suggest in the terminal): they can\'t be counted for this conversation, and can\'t be taken as none either.') : '',
  ].filter(Boolean).map((t) => `<div class="said">${esc(t)}</div>`).join('');
  return `<div class="railcell" data-state="director" data-lit="${e?.call ? 1 : 0}">
        <span class="rlab">${esc(letter)}</span>
        <span class="dot"></span>
      </div>
      <div class="acard adirector" data-state="${mood}">
        ${agent({ id: 'director' }, mood, false)}
        <div class="abody">
          <div class="atitle">${esc(letter)} ${zhEn('工地主任', 'Site director')}
            <span class="ahouse">${esc(r.house)}</span></div>
          <div class="astatus">${esc(status)}</div>
          <ul class="titems">${list}</ul>
          <details class="amore" data-fold="${esc(foldKey)}"${foldOpen(foldKey, false) ? ' open' : ''}><summary>${zhEn('細節', 'Details')}</summary>${why}</details>
        </div>
      </div>`;
}

/* ═══ Overview:左邊在跑的、中間這個專案的狀態、右邊已結案的 ═══ */
function overview(p) {
  const live = p.sessions.filter((s) => !s.closedAt);
  const done = p.sessions.filter((s) => s.closedAt);
  // 中間那格講的是哪個工作區要說出來:最近在動的對話的工作區,沒有的話是主資料夾(focusOf)
  const { session: focus, card } = focusOf(p);
  const subject = focus ? `${zhEn('最近在動：', 'Recently active: ')}${focus.title ?? zhEn('（還沒有標題）', '(no title yet)')}` : card ? zhEn('主資料夾', 'Main folder') : null;

  // 「N 天內」:紀錄只留這麼久(天數只住 lib/events.mjs,伺服器給)。更早結案的對話、更早的紀錄已經清掉——不准講成「還沒有」(規格:90天清空之後的說法 AC-3)
  const days = Number.isFinite(latest?.retainDays) ? latest.retainDays : null;
  const within = days !== null ? zhEn(`${days} 天內`, ` in the last ${days} days`) : '';
  // 標題太長就截;截掉的話,滑鼠移上去看得到全名(工地工班風畫面 AC-16)。英文一個字比較窄,放得比較多(那是版面,規格 AC-6)
  const room = zhEn(22, 32);
  const chip = (s) => {
    const t = s.title ?? zhEn('（還沒有標題）', '(no title yet)');
    return `<a class="ochip" href="#/p/${encodeURIComponent(p.name)}/s/${encodeURIComponent(s.id)}"${t.length > room ? ` title="${esc(t)}"` : ''}>
      <span class="odot"></span>${esc(t.slice(0, room))}</a>`;
  };
  // 已結案只露最近有動作的 5 個(伺服器已經依最後動作排好),其餘收在「還有 N 個」:收起來不是刪掉,N 是真的個數(工地工班風畫面 AC-1)
  const doneKey = `ov-done|${p.name}`, doneAll = foldOpen(doneKey, false), doneMore = done.length - 5;
  const doneChips = (doneAll ? done : done.slice(0, 5)).map(chip).join('')
    + (doneMore > 0 ? `<button class="ochip ov-more" data-ovfold="${esc(doneKey)}">${doneAll ? zhEn('收起 ▴', 'Show fewer ▴') : zhEn(`還有 ${doneMore} 個 ▾`, `${doneMore} more ▾`)}</button>` : '');

  // ⚠️ 資料夾不見了的卡沒有任何數字——不能拿 undefined 印成「都存好了」(R1)
  // 一張卡都沒有、90 天內一筆紀錄都沒有:連資料夾在哪都不知道——是清空了,不是「還沒有資料」(AC-3)。其他找不到卡的情況照舊
  const mid = card?.gone ? [zhEn('那個資料夾已經不在了', 'That folder is gone')] : card?.notGit ? [zhEn('這個資料夾不是 git 專案', 'This folder isn\'t a git project')] : card ? [
    card.ladder?.uncommitted === null ? zhEn('問不到有沒有沒存的檔案', 'Couldn\'t check for files not committed yet')
      : card.ladder?.uncommitted ? zhEn(`${card.ladder.uncommitted} 個檔案沒存`, `${many(card.ladder.uncommitted, 'file')} not committed yet`) : zhEn('都存好了', 'All committed'),
    !card.checkpoint ? zhEn('還沒有還原點', 'No restore point yet') : cpOk(card) ? zhEn(`還原點 ${ago(card.checkpoint.at)}`, `Restore point from ${ago(card.checkpoint.at)}`) : zhEn('還原點失效', 'Restore point unusable'),
    // 0 有兩種意思(老毛病 P5):存檔過的看不到的時候,不准寫「沒有待檢查的檔案」——對話頁那張卡寫的是「看不全」。
    // 從 main 併進來、這一輪沒算的:個數照講,0 的時候不講成資料夾沒變(規格:併進來的不算這一輪 AC-5)
    card.files?.total ? zhEn(`${card.files.total} 個檔案還沒檢查${card.scope?.merged ? `（另外 ${card.scope.merged} 個從 main 併進來）` : ''}`,
        `${many(card.files.total, 'file')} not checked yet${card.scope?.merged ? ` (${card.scope.merged} more came in from main)` : ''}`)
      : card.scope?.merged ? zhEn(`這一輪沒有待檢查的檔案；另外 ${card.scope.merged} 個從 main 併進來`, `No files of this round waiting to be checked; ${card.scope.merged} came in from main`)
      : card.scope?.emptyBlind ? zhEn('看不全：這一輪存檔過的看不到', 'Can\'t see all of it: this round\'s commits can\'t be seen') : zhEn('沒有待檢查的檔案', 'No files waiting to be checked'),
  ] : [p.noRecords && !p.cards?.length && within ? zhEn(`${within}沒有紀錄，也沒有還原點`, `No records${within}, and no restore point`) : zhEn('還沒有資料', 'No data yet')];

  return `<div class="ov">
    <div class="ov-col">
      <div class="ov-h">${zhEn('正在跑的對話', 'Conversations in progress')}</div>
      ${live.length ? live.map(chip).join('') : `<div class="muted">${zhEn('沒有進行中的對話', 'No conversations in progress')}</div>`}
    </div>
    <div class="ov-mid">
      <div class="ov-hub"><span></span><span></span><span></span></div>
      <div class="ov-state">${subject ? `<div class="ov-subject"${subject.length > zhEn(21, 30) ? ` title="${esc(subject)}"` : ''}>${esc(subject.slice(0, zhEn(21, 30)))}</div>` : ''}${mid.map((t) => `<div>${esc(t)}</div>`).join('')}</div>
    </div>
    <div class="ov-col ov-right">
      <div class="ov-h">${zhEn('已結案', 'Closed')}</div>
      ${done.length ? doneChips : `<div class="muted">${zhEn(`${within}沒有結案的對話`, `No closed conversations${within}`)}</div>`}
    </div>
    <svg class="ov-wires" aria-hidden="true"></svg>
  </div>`;
}

/* ═══ 第二層:一個案件底下的對話清單 ═══ */
function sessionList(p) {
  if (!p.sessions.length) {
    // 紀錄檔在、90 天內沒有任何對話(多半是三個月沒用、照規矩清掉了):伺服器照終端機五關同一句算好給的(lib/rounds.mjs 的 noRecordLine)。
    // 以前一律寫「還沒有任何對話紀錄,去掛上感測器」——清空之後感測器明明掛著(規格:90天清空之後的說法 AC-3)。
    // 舊的服務沒給這一欄 → 不自己湊一句,講服務還在跑舊的程式(AC-5,跟 appCardsSince 同一個做法)
    if (!('emptyLine' in p)) {
      return zhEn(`<div class="block"><p class="muted">這個專案沒有對話可以列——儀表板的服務還在跑舊的程式，分不出是從來沒記過、還是超過保留期限清掉了。
        重啟它：<code>pipeline-status --serve-restart</code></p></div>`, `<div class="block"><p class="muted">No conversations to list for this project: the dashboard service is still running the old program, so it can't tell whether nothing was ever recorded or the records were cleared after the retention period.
        Restart it: <code>pipeline-status --serve-restart</code></p></div>`);
    }
    if (p.emptyLine) return `<div class="block"><p class="muted">${esc(p.emptyLine)}</p></div>`;
    return zhEn(`<div class="block"><p class="muted">這個案件還沒有任何對話紀錄。<br>
      在那個資料夾跑 <code>pipeline-status --on</code> 掛上感測器,
      之後的對話就會出現在這裡。</p></div>`, `<div class="block"><p class="muted">This project has no conversation records yet.<br>
      Run <code>pipeline-status --on</code> in that folder to hook up the sensor,
      and later conversations will show up here.</p></div>`);
  }
  const row = (s) => {
    // 這一輪走到哪:現在這一關的名字,比「x/4」更像人話
    const seen = s.stages.find((x) => x.state === 'seen');
    const where = roundWhere(s.stages) + (seen ? zhEn(' · 開過瀏覽器,還沒有人說驗收過', ' · a browser was opened, nobody has said it\'s accepted yet') : '');
    return `<div class="srow ${s.closedAt ? 'closed' : ''}">
      <a class="sname" href="#/p/${encodeURIComponent(p.name)}/s/${encodeURIComponent(s.id)}">
        ${esc(s.title ?? zhEn('（還沒有標題）', '(no title yet)'))}</a>
      <span class="smeta">${zhEn(`${s.prompts} 則訊息 · 最後動作 ${ago(s.lastTs)}`, `${many(s.prompts, 'message')} · last activity ${ago(s.lastTs)}`)}
        · ${esc(where)}${s.sharesCwd ? zhEn(' · ⚠️ 與其他對話共用工作區', ' · ⚠️ shares its workspace with other conversations') : ''}${s.movedOn ? zhEn(' · 資料夾已換給別的對話', ' · the folder was handed to another conversation') : ''}${
        s.reopenedByActivity ? zhEn(` · 結案後又有動作（${ago(s.reopenedByActivity)}）,算回進行中`, ` · activity after closing (${ago(s.reopenedByActivity)}), counted as in progress again`) : ''}</span>
      ${s.deletedAt
        ? `<span class="muted">${zhEn('已在 app 裡刪除', 'Deleted in the app')}</span>`
        : `<button class="mini-btn" data-close="${esc(s.id)}" data-proj="${esc(p.name)}"
        data-cwd="${esc(s.cwd ?? '')}" data-undo="${s.closedAt ? 1 : 0}">
        ${s.closedAt ? zhEn('取消結案', 'Reopen') : zhEn('結案', 'Close')}</button>`}
    </div>`;
  };
  // 進行中的全部列出;已結案的排在後面,跟 Overview 一樣只露最近有動作的 5 個,其餘收在「還有 N 個」(工地工班風畫面 AC-17)
  const live = p.sessions.filter((s) => !s.closedAt), closed = p.sessions.filter((s) => s.closedAt);
  const key = `sl-done|${p.name}`, all = foldOpen(key, false), more = closed.length - 5;
  return `<div class="block">
      <h2 class="section serif">${zhEn('對話', 'Conversations')}</h2>
      <div class="slist">${[...live, ...(all ? closed : closed.slice(0, 5))].map(row).join('')}</div>
      ${more > 0 ? `<button class="mini-btn sl-more" data-ovfold="${esc(key)}">${all ? zhEn('收起已結案的對話 ▴', 'Hide closed conversations ▴')
        : zhEn(`還有 ${more} 個已結案的對話 ▾`, `${more} more closed ${more === 1 ? 'conversation' : 'conversations'} ▾`)}</button>` : ''}
    </div>`;
}

function projectPage(name) {
  const p = latest?.projects?.find((x) => x.name === name);
  if (!p) return zhEn(`<p class="muted">找不到「${esc(name)}」。<a href="#/">回列表</a></p>`, `<p class="muted">Can't find "${esc(name)}". <a href="#/">Back to the list</a></p>`);
  return `<div class="block">
      <h2 class="section serif">Overview</h2>
      ${overview(p)}
      ${optOutLine(p)}
    </div>` + whiteboard(p) + suggestionsBlock(p) + sessionList(p);
}

/**
 * 建議另開的對話。兩條路來的卡長得一樣,卡上寫是哪條(app建議卡 AC-5):Claude 用 --suggest 放的、或 Claude 在 app 的對話裡提的建議卡。
 * ⚠️ 儀表板開不了對話——只能讓你複製說明、貼進新對話的第一句。
 * ⚠️ 儀表板也看不到 app 的叉叉:在 app 把卡按掉,這裡那張還在,卡上不准寫「你已取消」(AC-2)。
 *    Claude 自己在對話裡叫了收回(做完了、前提變了、換一張新的):對不回是哪一張,
 *    所以標在**那個對話、收回之前提的每一張**卡上,附 Claude 說的理由,卡照樣掛著——撕不撕你決定(app建議卡 AC-7)。
 *    app 那條記到的是「Claude 叫了這張卡」,不是「卡真的跳出來了」——文案只講 Claude 提了(R2)。
 * ⚠️ 當場問你要不要開的卡(ask 是 'offer',規格:當場問的卡也收進來)也畫在這裡:看不到你按了哪個鈕,就講看不到——
 *    不寫「問過你」(app 可能根本沒跳出來)、不寫「你沒回答」「你取消了」(AC-5)。沒有下文的,要貼的話是伺服器照標題湊的那段,
 *    卡上講明不是 Claude 寫的(AC-4);畫面照印,不自己湊。
 * ⚠️ 一張卡都沒有也要畫這一區:「沒有建議」跟「感測器根本沒記到」長得一樣(老毛病 P5),那句「不代表沒跳過」就是為這種時候寫的。
 */
function suggestionsBlock(p) {
  const all = p.suggestions ?? [];
  // 已開始的從清單拿掉——那個對話會出現在「對話」裡,留著就是同一件事出現兩次(Oscar 2026-09-15)。
  // 拿掉不是刪掉:跟「不做了」的一起收在最下面。一張卡不見了,要查得到它是被認成已開始、還是你按了不做了——不然跟弄丟分不出來。
  // 當場問的卡後來在同一個對話又提了同名的卡(supersededAt):跟著後來那一張,這張也收到最下面
  const isFolded = cardFolded;   // 跟 F 工地主任「還沒開始幾張」同一個判斷(老毛病 P2)
  const open = all.filter((s) => !isFolded(s));
  const folded = all.filter(isFolded);
  const sessionHref = (proj, sid) => `#/p/${encodeURIComponent(proj)}/s/${encodeURIComponent(sid)}`;
  const row = (s) => {
    const cut = new Set(s.cut ?? []);
    const prompt = String(s.prompt ?? '');
    const firstLine = prompt.split('\n').find((l) => l.trim()) ?? '';
    const offer = s.ask === 'offer';
    const composed = offer && !s.brief;
    const from = s.source === 'app' && s.session && s.fromTitle
      ? `${zhEn(' · 來自 ', ' · from ')}<a href="${sessionHref(p.name, s.session)}">${esc(s.fromTitle)}</a>` : '';
    const source = offer ? zhEn(`Claude 叫了當場問你要不要開的卡 · ${ago(s.ts)}${from}`, `Claude raised a card asking you on the spot whether to start it · ${ago(s.ts)}${from}`)
      : s.source === 'app' ? zhEn(`Claude 在對話裡提的建議卡 · ${ago(s.ts)}${from}`, `A suggestion card Claude raised in a conversation · ${ago(s.ts)}${from}`)
      : zhEn(`Claude 用 --suggest 放的 · ${ago(s.ts)}`, `Placed by Claude with --suggest · ${ago(s.ts)}`);
    // 說明(app 的卡才有)與要貼的話。空的要講「沒有內容」,不是不畫這張卡(R1)
    const lines = [];
    if (offer) {
      // 你在那之前說的最後一句(伺服器挑的:同一個對話、比提卡早、系統塞的字不算)。感測器只記前面一段,記滿了加…
      const said = s.said && typeof s.said.text === 'string' ? s.said.text.replace(/\s+/g, ' ').trim() : '';
      const t = said ? `${esc(said.slice(0, 80))}${said.length > 80 || s.said.cut ? '…' : ''}` : '';
      lines.push(said ? zhEn(`你那時說：「${t}」`, `You said then: “${t}”`) : zhEn('紀錄裡看不到你在那之前說的話', 'The records don\'t show what you said before that'));
    }
    if (s.tldr) lines.push(zhEn(`說明：${esc(s.tldr)}${cut.has('tldr') ? '…（已截短）' : ''}`, `Summary: ${esc(s.tldr)}${cut.has('tldr') ? '… (shortened)' : ''}`));
    if (composed) {
      // 記到的只是 Claude 叫了:app 也可能拒絕、根本沒讓它跳出來(〈app建議卡換工具〉記過這條路,D 第一輪)
      lines.push(zhEn('看不到你按了哪個鈕（開新對話、在這裡做、還是沒按就傳了新訊息），也看不到卡有沒有真的跳出來',
        'Can\'t see which button you pressed (new conversation, do it here, or a new message without pressing either), or whether the card actually popped up'));
      lines.push(prompt.trim() ? zhEn('Claude 沒寫說明。「複製」拿到的這段是監視器照標題湊的，不是 Claude 寫的說明', 'Claude didn\'t write a description. What "Copy" gives you was put together by the monitor from the title, not written by Claude')
        : zhEn('Claude 沒寫說明', 'Claude didn\'t write a description'));
    } else if (prompt.trim()) {
      const t = `${esc(firstLine.slice(0, 80))}${firstLine.length > 80 || prompt.trim() !== firstLine.trim() ? '…' : ''}`;
      lines.push(zhEn(`要貼的話：${t}`, `To paste: ${t}`));
    } else lines.push(s.tldr ? zhEn('這張卡沒有要貼的話', 'This card has nothing to paste') : zhEn('這張卡沒有內容', 'This card has no content'));
    if (cut.has('prompt')) {
      lines.push(zhEn(`已截短：要貼的話太長,紀錄只留得下前面一段${s.source === 'app' ? `;完整的在原本那個對話裡${s.fromTitle ? `（${esc(s.fromTitle)}）` : ''}` : ''}`,
        `Shortened: the text to paste was too long, so the records only kept the first part${s.source === 'app' ? `; the full text is in the original conversation${s.fromTitle ? ` (${esc(s.fromTitle)})` : ''}` : ''}`));
    }
    if (s.openIn) {
      lines.push(s.openIn.project ? `${zhEn('要開在別的專案：', 'To be opened in another project: ')}<a href="#/p/${encodeURIComponent(s.openIn.project)}">${esc(s.openIn.name ?? s.openIn.project)}</a>`
        : s.openIn.name ? zhEn(`要開在別的資料夾：${esc(s.openIn.name)}`, `To be opened in another folder: ${esc(s.openIn.name)}`)
        : zhEn('要開在別的資料夾（路徑太長,沒記完整）', 'To be opened in another folder (the path was too long to record in full)'));
    }
    // 當場問的卡有下文、但找不到照它開的對話(AC-2):照實講是哪一種下文,卡照樣掛著
    if (offer && s.brief && !s.startedBy) {
      lines.push(s.brief.via === 'same-title' ? zhEn('Claude 後來叫了同名的卡、直接開對話，但找不到照它開的對話', 'Claude later raised a card with the same name and started a conversation directly, but no conversation started from it can be found')
        : zhEn('Claude 補了開新對話的說明，但找不到照它開的對話', 'Claude added a description for starting a new conversation, but no conversation started from it can be found'));
    }
    // 提卡之後、你下一句話之前 Claude 接著動了工(AC-5):只是提示——接著動工也有別的原因(L25),不收卡
    if (offer && s.workedAfter && !isFolded(s)) {
      lines.push(zhEn('之後 Claude 接著在這個對話動了工，可能是你選了在這裡做；做完了就按「不做了」', 'After that Claude kept working in this conversation; maybe you chose to do it here. When it\'s done, press "Not doing it"'));
    }
    // Claude 後來在這個對話裡叫過收回(AC-7):分不出是不是這一張,照實講,附它說的理由。記到的是「叫了收回」,不是「收回成功」(R2)
    const wd = Array.isArray(s.withdrawals) ? s.withdrawals : [];
    if (wd.length) {
      const reasons = wd.slice(0, 3).map((w) => (w.reason ? zhEn(`「${esc(w.reason)}${w.cut ? '…' : ''}」`, `“${esc(w.reason)}${w.cut ? '…' : ''}”`) : zhEn('（沒寫理由）', '(no reason given)'))).join(zhEn('、', ', '));
      // 已經收起來的卡(已開始、你說不做了、跟著同名的那張)沒有「不做了」按鈕,不叫人去按一顆不存在的按鈕
      const next = isFolded(s) ? '' : zhEn('，過時的話按「不做了」', '; if it\'s out of date, press "Not doing it"');
      lines.push(zhEn(`⚠️ Claude 後來在這個對話裡叫過 ${wd.length} 次收回建議卡，理由：${reasons}${wd.length > 3 ? ` 等 ${wd.length} 次` : ''}——分不出收回的是不是這一張${next}`,
        `⚠️ Claude later tried to withdraw a suggestion card ${many(wd.length, 'time')} in this conversation; reasons: ${reasons}${wd.length > 3 ? ` and others (${wd.length} in all)` : ''}. Can't tell whether it was this card${next}`));
    }
    // Claude 後來在這個對話裡照你的話開了之前提的某一張(只帶代號的那一次,規格:app建議卡換工具 AC-4):一樣分不出是哪一張,照實講、不收卡。
    // 記到的是「Claude 叫了開卡」,不是「開成了」(R2)
    const op = Array.isArray(s.opens) ? s.opens : [];
    if (op.length) {
      const next = isFolded(s) ? '' : zhEn('，是這一張的話按「不做了」', '; if it was this one, press "Not doing it"');
      lines.push(zhEn(`⚠️ Claude 後來在這個對話裡照你的話叫過 ${op.length} 次開先前提的建議卡——分不出要開的是不是這一張、也看不到有沒有開成${next}`,
        `⚠️ Claude later, at your word, tried ${many(op.length, 'time')} to start a suggestion card raised earlier in this conversation. Can't tell whether it was this card, or whether it got started${next}`));
    }
    // 收起來的理由:看得到的事實優先(真的有對話這樣開頭),再來才是你按的
    if (s.startedBy) {
      const where = s.startedProject ? zhEn(`（在 ${esc(s.startedProject.name ?? s.startedProject.project)}）`, ` (in ${esc(s.startedProject.name ?? s.startedProject.project)})`) : '';
      const link = s.startedTitle
        ? `<a href="${sessionHref(s.startedProject?.project ?? p.name, s.startedBy)}">${esc(s.startedTitle)}</a>${where}`
        : zhEn('有對話這樣開頭了,但那個對話不在儀表板列得出來的專案裡', 'A conversation started this way, but it isn\'t in any project the dashboard can list');
      const pressed = s.dismissedAt ? zhEn(` · 你 ${ago(s.dismissedAt)}按過「不做了」`, ` · you pressed "Not doing it" ${ago(s.dismissedAt)}`) : '';
      lines.push(`${zhEn('已開始：', 'Started: ')}${link}${pressed}`);
    } else if (s.supersededAt) {
      const pressed = s.dismissedAt ? zhEn(` · 你 ${ago(s.dismissedAt)}按過「不做了」`, ` · you pressed "Not doing it" ${ago(s.dismissedAt)}`) : '';
      lines.push(zhEn(`後來同一個對話又提了一張同名的卡（${ago(s.supersededAt)}），看那一張${pressed}`, `The same conversation later raised a card with the same name (${ago(s.supersededAt)}); see that one${pressed}`));
    } else if (s.dismissedAt) {
      lines.push(zhEn(`你 ${ago(s.dismissedAt)}說不做了`, `You said you're not doing it ${ago(s.dismissedAt)}`));
    }
    const copy = prompt.trim()
      ? `<button class="copy" data-copy="${esc(prompt)}">${composed ? zhEn('複製監視器湊的話', 'Copy what the monitor put together') : cut.has('prompt') ? zhEn('複製前面這一段', 'Copy the first part') : zhEn('複製說明', 'Copy the description')}</button>` : '';
    const dismiss = isFolded(s) ? ''
      : `<button class="mini-btn" data-dismiss="${esc(s.id)}" data-proj="${esc(p.name)}">${zhEn('不做了', 'Not doing it')}</button>`;
    return `<div class="srow ${isFolded(s) ? 'closed' : ''}">
      <span class="sname">${esc(s.title)}${cut.has('title') ? '…' : ''}</span>
      <span class="smeta">${source}</span>
      ${lines.map((l) => `<span class="smeta">${l}</span>`).join('')}
      <span class="sact">${copy}${dismiss}</span>
    </div>`;
  };
  // app 的建議卡從什麼時候開始有紀錄(L3):更早跳過的這裡一輩子不會知道,不准讓這一區看起來像「全部都在這裡」。
  // 接點是對話開始時讀的,所以接上之前就開著的對話,之後跳的卡照樣記不到——兩種說法都要帶這半句。
  // 紀錄裡一張都沒有的時候,分不出是沒跳過、沒接上、還是超過保留期限被丟掉了:三種都講,不挑一種
  const days = Number.isFinite(latest?.retainDays) ? zhEn(`（${latest.retainDays} 天）`, ` (${latest.retainDays} days)`) : '';
  // ⚠️ appCardsSince 這個欄位**不在**(undefined)跟**是 null** 是兩件事:不在 = 伺服器沒回答這一題——常駐的儀表板服務跑的是它啟動那一刻的程式,
  //    更新之後沒重啟的話,這支新畫面配的是不認得 app 建議卡的舊資料。那時講「紀錄裡沒有」就是把沒問到講成沒有(R1),要講真正的原因跟下一步
  const since = p.appCardsSince === undefined
    ? zhEn('⚠️ 儀表板的服務還在跑舊的程式,它不認得 app 對話裡的建議卡——那種卡就算記到了,這裡現在也看不到。跑一次 <code>pipeline-status --serve-restart</code>,再重新整理這一頁。',
      '⚠️ The dashboard service is still running the old program and doesn\'t recognize suggestion cards from app conversations: even if such cards were recorded, they can\'t be seen here now. Run <code>pipeline-status --serve-restart</code> once, then reload this page.')
    : p.appCardsSince
      ? zhEn(`app 對話裡的建議卡從 ${clock(p.appCardsSince)} 開始有紀錄;更早跳過的、還沒重開的對話裡跳的,這裡不會有。`,
        `Suggestion cards from app conversations have been recorded since ${clock(p.appCardsSince)}; earlier ones, and ones from conversations not reopened since, won't be here.`)
      : zhEn(`紀錄裡沒有 app 對話裡的建議卡——不代表沒跳過:接上這個功能之前跳的、還沒重開的對話裡跳的、app 換了做卡的工具而感測器還沒接上時跳的、超過保留期限${days}的,這裡都看不到。`,
        `There are no suggestion cards from app conversations in the records, which doesn't mean none popped up: cards from before this feature was hooked up, from conversations not reopened since, from when the app changed its card tool before the sensor caught up, or older than the retention period${days}, can't be seen here.`);
  // app 換過做卡的工具(2026-10-25 實際發生:新卡安靜地一張都進不來)、或記到認不得的 app 對話工具(下次再換的時候):照紀錄裡查得到的時間講,不編換工具的日期(R3)。
  // 兩個日期是整台電腦所有專案一起算的(換工具是整個 app 的事)。欄位不在 = 服務還在跑舊的程式,講不出這一段——照實說(規格:app建議卡換工具 AC-5、AC-8)
  const tools = latest?.appCardTools;
  const toolNote = p.appCardsSince === undefined ? ''
    : tools === undefined ? zhEn('（app 換過做卡的工具那一段，服務還在跑舊的程式、講不出來：跑一次 <code>pipeline-status --serve-restart</code>）',
      ' (the part about the app changing its card tool can\'t be told: the service is still running the old program; run <code>pipeline-status --serve-restart</code> once)')
    : !tools || typeof tools !== 'object' ? ''
    : [tools.oldLast && tools.newFirst ? zhEn(`app 換過做建議卡的工具：這台電腦最後一次記到舊的是 ${clock(tools.oldLast)}、第一次記到新的是 ${clock(tools.newFirst)}，中間跳的卡可能沒記到；那時已經開著、之後沒重開的對話裡跳的，也可能沒記到。`,
        `The app changed the tool it uses for suggestion cards: this computer last recorded the old one at ${clock(tools.oldLast)} and first recorded the new one at ${clock(tools.newFirst)}; cards in between might not have been recorded, and neither might cards from conversations already open then and not reopened since.`)
        : tools.oldLast ? zhEn(`app 換過做建議卡的工具，感測器還沒記到新的那一種：最後一次記到舊的是 ${clock(tools.oldLast)}，之後跳的卡可能都沒記到。`,
          `The app changed the tool it uses for suggestion cards, and the sensor hasn't recorded the new one yet: the old one was last recorded at ${clock(tools.oldLast)}, and cards after that might not have been recorded.`) : '',
       ...(Array.isArray(tools.unknown) ? tools.unknown : []).map((u) =>
         zhEn(`⚠️ 感測器記到 app 一個認不得的工具 <code>${esc(u.tool)}</code>（第一次 ${clock(u.first)}）——可能是 app 又換了做建議卡的工具，那種卡這裡看不到。`,
           `⚠️ The sensor recorded an app tool it doesn't recognize, <code>${esc(u.tool)}</code> (first at ${clock(u.first)}); the app might have changed its suggestion-card tool again, and those cards can't be seen here.`))].join('');
  // 卡掛在提建議的那個專案那一頁;要開在**這個**專案的卡,在這一頁指路——不然這一頁說沒有,別頁卻掛著要開在這裡的卡(P5)
  const incoming = (p.incomingSuggestions ?? []).map((x) => {
    const a = `<a href="#/p/${encodeURIComponent(x.project)}">${esc(x.name ?? x.project)}</a>`;
    return zhEn(`別的專案的對話提了 ${x.count} 張要開在這裡的建議卡,掛在 ${a} 那一頁。`,
      `Conversations in another project raised ${many(x.count, 'suggestion card')} to be opened here; ${x.count === 1 ? 'it is' : 'they are'} on the ${a} page.`);
  }).join('');
  const incomingNote = incoming ? `<p class="section-note">${incoming}</p>` : '';
  if (!all.length) {
    return `<div class="block">
      <h2 class="section serif">${zhEn('建議新增的對話', 'Suggested new conversations')}</h2>
      <p class="section-note">${zhEn('Claude 覺得該另開一個對話做的事會放在這裡。這個專案的對話提的建議,紀錄裡現在一張都沒有。',
        'Things Claude thinks should get their own conversation show up here. There are no suggestions from this project\'s conversations in the records right now. ')}${since}${toolNote}</p>
      ${incomingNote}
    </div>`;
  }
  // 每一張只算一種,跟卡上那一行同一個先後:已開始 → 後來又提了同名的卡 → 你說不做了(加起來就是收起來的張數)
  const started = folded.filter((s) => s.startedBy).length;
  const later = folded.filter((s) => !s.startedBy && s.supersededAt).length;
  const foldKey = `sg-fold|${p.name}`;
  const foldedBox = folded.length
    ? `<details class="acl-box sg-fold" data-fold="${esc(foldKey)}"${foldOpen(foldKey, false) ? ' open' : ''}>
        <summary>${zhEn(`收起來的 ${folded.length} 張（已開始 ${started}${later ? `、後來又提了同名的卡 ${later}` : ''}、你說不做了 ${folded.length - started - later}）`,
          `${many(folded.length, 'folded card')} (started: ${started}${later ? `; a card with the same name raised later: ${later}` : ''}; you said not doing it: ${folded.length - started - later})`)}</summary>
        <div class="slist">${folded.map(row).join('')}</div>
      </details>` : '';
  // 說明分三層(工地工班風畫面 AC-10):外面一句講怎麼用;一直都成立的那幾句說明收進「這一區看不到的」——收起來的字還在網頁上。
  // 會讓你誤會「沒有卡」的那兩句留在外面:服務還在跑舊的程式(app 的卡現在全看不到)、app 換過做卡的工具(中間的卡可能沒記到)
  const oldSince = p.appCardsSince === undefined ? since : '';
  const whyKey = `why|sg|${p.name}`;
  return `<div class="block">
      <h2 class="section serif">${zhEn('建議新增的對話', 'Suggested new conversations')}</h2>
      <p class="section-note">${zhEn('Claude 覺得該另開一個對話做的事。這裡開不了對話：<b>複製說明</b>，在 app 開新對話貼進第一句。',
        'Things Claude thinks should get their own conversation. You can\'t start a conversation from here: <b>copy the description</b> and paste it as the first message of a new conversation in the app. ')}${oldSince}${toolNote}</p>
      <details class="why" data-fold="${esc(whyKey)}"${foldOpen(whyKey, false) ? ' open' : ''}><summary>${zhEn('這一區看不到的', 'What this section can\'t see')}</summary>
        ${zhEn(`<p>有對話真的照這段說明開了，這張會自己收到最下面（點開看得到是哪個對話）；不想做了按<b>不做了</b>。</p>
        <p>當場問你要不要開的卡也在這裡，但看不到你按了哪個鈕；選了在這裡做的，要自己按<b>不做了</b>。</p>
        <p>這一區看不到卡在 app 裡是怎麼不見的（你按掉、或被後來的新卡擠掉）——那種卡在這裡會繼續掛著。
        Claude 自己在對話裡叫了收回（做完了、前提變了、換了一張新的）、或照你的話叫了開先前提的某一張，會標在那個對話先前提的卡上，但分不出是哪一張；過時的要自己按「不做了」。${oldSince ? '' : since}</p>`,
        `<p>When a conversation really starts from a card's description, the card folds away to the bottom by itself (open it to see which conversation); if you don't want to do it, press <b>Not doing it</b>.</p>
        <p>Cards that asked you on the spot whether to start them are here too, but which button you pressed can't be seen; if you chose to do it here, press <b>Not doing it</b> yourself.</p>
        <p>This section can't see how a card disappeared in the app (you dismissed it, or a newer card pushed it out): such cards stay here.
        When Claude itself withdraws a card in a conversation (done, the premise changed, replaced by a new one), or, at your word, starts one raised earlier, that's marked on the cards that conversation raised earlier, but it can't tell which one; press "Not doing it" yourself on the out-of-date ones. ${oldSince ? '' : since}</p>`)}
      </details>
      ${incomingNote}
      ${open.length ? `<div class="slist">${open.map(row).join('')}</div>` : `<p class="section-note">${zhEn('現在沒有還沒處理的建議。', 'No suggestions waiting right now.')}</p>`}
      ${foldedBox}
    </div>`;
}

/** 退出記錄／重新加入。plugin 每個專案都會記,「不要記這個」靠主資料夾的一個記號檔——按下去馬上生效。 */
function optOutLine(p) {
  if (!p.mainRoot) return '';
  if (p.optedOut) {
    // 那一句是伺服器給的,跟終端機感測器那一行同一句(lib/faults.mjs 的 optedOutLine)。以前寫「之前的紀錄還在」——
    // 退出之後不再記,舊的照樣滿 90 天清掉,那句遲早變假的(規格:90天清空之後的說法 AC-4)。舊的服務沒給 → 講服務還在跑舊的程式(AC-5)
    const line = 'optedOutLine' in p ? esc(p.optedOutLine ?? '')
      : zhEn(`這個專案已退出記錄${p.optedOut.at ? `（${esc(ago(p.optedOut.at))}）` : ''}。（儀表板的服務還在跑舊的程式，重啟它：<code>pipeline-status --serve-restart</code>）`,
        `This project opted out of recording${p.optedOut.at ? ` (${esc(ago(p.optedOut.at))})` : ''}. (The dashboard service is still running the old program; restart it: <code>pipeline-status --serve-restart</code>)`);
    return `<p class="section-note">${line}
      <button class="mini-btn" data-optout="${esc(p.mainRoot)}" data-undo="1">${zhEn('重新加入記錄', 'Start recording again')}</button></p>`;
  }
  return `<p class="section-note">${zhEn('感測器會記這個專案的每個對話（只在這台電腦上）。', 'The sensor records every conversation in this project (only on this computer).')}
    <button class="mini-btn" data-optout="${esc(p.mainRoot)}" data-undo="0">${zhEn('退出記錄', 'Stop recording')}</button></p>`;
}

/* ═══ 第三層:一個對話 ═══ */
function sessionPage(name, sid) {
  const p = latest?.projects?.find((x) => x.name === name);
  const s = p?.sessions.find((x) => x.id === sid);
  if (!s) return zhEn(`<p class="muted">找不到這個對話。<a href="#/p/${encodeURIComponent(name)}">回對話清單</a></p>`, `<p class="muted">Can't find this conversation. <a href="#/p/${encodeURIComponent(name)}">Back to the conversation list</a></p>`);
  // 伺服器算好的兩種旁白(規格:agent回報與故障記號 AC-2、AC-5),跟終端機同一句,這裡只畫:
  // 沒算成你說的話的訊息(沒見過的格式)、這一輪碰到的那段「感測器或收工 hook 壞過」
  const notes = [s.unknownNote, ...(s.faultNotes ?? [])].filter(Boolean).map((t) => `<p class="section-note">${esc(t)}</p>`).join('');
  const c = s.card;
  if (!c) return zhEn(`<p class="muted">這個對話的工作區找不到了（${esc(s.cwd ?? '?')}）。</p>`, `<p class="muted">This conversation's workspace can't be found (${esc(s.cwd ?? '?')}).</p>`);
  const title = esc(s.title ?? zhEn('（還沒有標題）', '(no title yet)'));
  const meta = zhEn(`${s.prompts} 則訊息 · 最後動作 ${ago(s.lastTs)}`, `${many(s.prompts, 'message')} · last activity ${ago(s.lastTs)}`);
  const closed = s.closedAt ? zhEn(` · 已於 ${ago(s.closedAt)}結案`, ` · closed ${ago(s.closedAt)}`) : '';
  // 工作區的資料夾已經不在了(worktree 被刪):git 那三張卡沒有東西可講,五關的紀錄還在,照畫。
  // ⚠️ 以前這裡照樣去讀 c.sensor.state → 整頁炸掉 → 被當成「斷線」(2026-09-15 Oscar 點進去就斷)。
  if (c.gone) {
    return `
    <div class="block">
      <h2 class="section serif">${title}</h2>
      <p class="section-note">${meta}</p>${notes}
      <p class="section-note">${zhEn(`⚠️ 這個對話的工作區資料夾已經不在了（${esc(s.cwd ?? '')}）——
        還原點、三階梯、改動都沒有東西可講。下面五關的紀錄還在。`, `⚠️ This conversation's workspace folder is gone (${esc(s.cwd ?? '')}), so
        the restore point, the three steps and the changes have nothing to show. The five stages' records below are still there.`)}</p>
    </div>
    <div class="block">
      <h2 class="section serif">My Agent work flow</h2>
      ${workflow({ ...c, sensor: { state: 'ok' }, stages: s.stages, director: directorOf(p, s) })}
    </div>`;
  }
  // 資料夾換人了(規格:新對話接手舊資料夾 AC-5):app 把這個對話留下的資料夾換一條新分支給別的對話用。
  // 資料夾現在的分支、還原點、改動、分級都是那個對話的——畫在這裡就是把別人的進度講成這個對話的。跟「資料夾不在了」同一個樣子:只畫五關。
  // ⚠️ 五關那裡把 path 拿掉:E 那一格的「你說驗收過了」是按資料夾記的——在這一頁按,記到的是現在在這個資料夾做事的那個對話(R2)
  if (s.movedOn) {
    return `
    <div class="block">
      <h2 class="section serif">${title}</h2>
      <p class="section-note">${meta}${closed}</p>${notes}
      <p class="section-note">${zhEn(`⚠️ 這個資料夾 ${ago(s.movedOn.at)}換到另一條分支、給別的對話用了——
        分支、還原點、改動、分級是那個對話的，這裡不畫。下面五關是這個對話當時的紀錄。`, `⚠️ This folder switched to another branch ${ago(s.movedOn.at)} and was handed to another conversation:
        the branch, restore point, changes and tier belong to that conversation, so they aren't drawn here. The five stages below are this conversation's records from back then.`)}</p>
    </div>
    <div class="block">
      <h2 class="section serif">My Agent work flow</h2>
      ${workflow({ ...c, path: null, sensor: { state: 'ok' }, stages: s.stages, director: directorOf(p, s) })}
    </div>`;
  }

  // 共用工作區:改動與分級一個資料夾一份(lib/collect.mjs 的 sessionTier),別的對話改的也算在裡面——講清楚,不讓人以為那些都是這個對話做的
  const warn = s.sharesCwd
    ? zhEn(`<p class="section-note">⚠️ 這個工作區還有別的對話在用,所以下面的 git 狀態與分級是<b>共用的</b>——
       不是這個對話獨有：別的對話改的也算在裡面。</p>`, `<p class="section-note">⚠️ Other conversations are also using this workspace, so the git status and tier below are <b>shared</b>,
       not this conversation's alone: changes made by the other conversations count too.</p>`) : '';

  // 「叫了不等於通過」那一句是伺服器給的(終端機同一句),字不改;破折號前面那半句是重點、後面小字(工地工班風畫面 AC-10)
  const called = String(latest?.sharedLines?.calledNotPassed ?? OLD_LINE);
  const dash = zhEn('——', ' — ');
  const cut = called.indexOf(dash);
  const calledHtml = cut > 0 ? `<b>${esc(called.slice(0, cut))}</b><span class="tail">${esc(called.slice(cut + dash.length))}</span>` : esc(called);

  return `
    <div class="block">
      <h2 class="section serif">${title}</h2>
      <p class="section-note"><span class="mono">${esc(c.branch ?? zhEn('沒有分支', 'no branch'))}</span> · ${meta}${closed}</p>
      ${notes}${warn}
      <div class="stats">${statRestore(c)}${statLadder(c)}${statChanges(c)}${statTier({ ...c, tier: s.tier ?? c.tier }, p)}</div>
    </div>
    <div class="block">
      <h2 class="section serif">My Agent work flow</h2>
      <p class="callout">${calledHtml}</p>
      ${sensorLine(c)}
      ${stagesNoteLine(c)}
      ${workflow({ ...c, stages: s.stages, director: directorOf(p, s) })}
    </div>`;
}

/**
 * 故障橫條(規格:agent回報與故障記號 AC-3):還在壞(紅)、時好時壞／看不到好了沒(黃)的才上,每一頁最上面都有。
 * 句子是伺服器算好的(lib/faults.mjs,跟終端機最上面那一行一字不差),這裡只畫。
 * 舊的服務不給這一欄 → 講出來,不當成沒有故障(L20:合併之後還沒 --serve-restart,新畫面拿到的是舊伺服器的資料)。
 */
function faultBanner() {
  if (!latest) return '';
  if (!latest.faults) {
    return zhEn('<p class="fault" data-tone="amber">🟡 儀表板的服務還在跑舊的程式，感測器跟收工 hook 有沒有壞這裡看不到——跑 <code>pipeline-status --serve-restart</code></p>',
      '<p class="fault" data-tone="amber">🟡 The dashboard service is still running the old program, so this page can\'t see whether the sensor or the closing hook is broken: run <code>pipeline-status --serve-restart</code></p>');
  }
  return (latest.faults.banner ?? []).map((b) => `<p class="fault" data-tone="${b.tone === 'red' ? 'red' : 'amber'}">${esc(b.text)}</p>`).join('');
}

/* ═══ 路由 ═══ */
function route() {
  const m = location.hash.match(/^#\/p\/([^/]+)(?:\/s\/(.+))?$/);
  if (!m) return { view: 'projects' };
  return { view: m[2] ? 'session' : 'project',
           project: decodeURIComponent(m[1]),
           session: m[2] ? decodeURIComponent(m[2]) : null };
}
function render() {
  const r = route();
  const link = (href, t) => `<a href="${href}">${esc(t)}</a><span class="sep">/</span>`;
  const cases = zhEn('案件', 'Projects');
  if (r.view === 'projects') {
    $crumb.innerHTML = `<span>${cases}</span>`;
    paint(faultBanner() + langBanner() + oldServerBanner() + restartBanner() + projectList());
  } else if (r.view === 'project') {
    // 路由用的是檔名(safeName 過的);麵包屑給人看,要用真的資料夾名
    const p = latest?.projects?.find((x) => x.name === r.project);
    $crumb.innerHTML = link('#/', cases) + `<span>${esc(p?.displayName ?? r.project)}</span>`;
    paint(faultBanner() + langBanner() + oldServerBanner() + restartBanner() + projectPage(r.project));
  } else {
    const p = latest?.projects?.find((x) => x.name === r.project);
    const s = p?.sessions.find((x) => x.id === r.session);
    // 對話標題照字數截:英文一個字比較窄,放得比較多(規格 AC-6:那是版面)
    const t = s?.title ?? zhEn('對話', 'Conversation');
    const room = zhEn(20, 32);
    $crumb.innerHTML = link('#/', cases)
      + link(`#/p/${encodeURIComponent(r.project)}`, p?.displayName ?? r.project)
      + `<span${t.length > room ? ` title="${esc(t)}"` : ''}>${esc(t.slice(0, room))}</span>`;
    paint(faultBanner() + langBanner() + oldServerBanner() + restartBanner() + sessionPage(r.project, r.session));
  }
}
/**
 * 換上新的畫面。內容跟上一次一樣就不換:整頁換掉的話,每個動畫都從頭來過(畫面每 5 秒更新一次)。
 * 要換的時候,把「這一頁開了幾秒」交給 CSS(--t):新長出來的動畫從該在的位置接著演,不跳回起點(工地工班風畫面 AC-3)。
 */
function paint(html) {
  if (html === lastHtml) return;
  lastHtml = html;
  $app.style.setProperty('--t', (performance.now() / 1000).toFixed(3));
  $app.innerHTML = html;
  drawWires();
}
/**
 * Overview 的虛線:從左邊每一顆膠囊的中心,經過中間那顆球,流到右邊每一顆看得到的膠囊中心(工地工班風畫面 AC-2)。
 * 膠囊排好才量得到位置,所以畫面換上去之後才畫;視窗大小變了重畫。每條線一樣快、一樣顏色——不跟任何狀態變。
 */
function drawWires() {
  for (const ov of $app.querySelectorAll('.ov')) {
    const svg = ov.querySelector('.ov-wires'), hub = ov.querySelector('.ov-hub');
    if (!svg || !hub) continue;
    const box = ov.getBoundingClientRect();
    const mid = (el) => { const b = el.getBoundingClientRect(); return [b.left + b.width / 2 - box.left, b.top + b.height / 2 - box.top]; };
    const h = mid(hub);
    const curve = ([ax, ay], [bx, by]) => { const k = ((ax + bx) / 2).toFixed(1); return `M${ax.toFixed(1)} ${ay.toFixed(1)} C${k} ${ay.toFixed(1)}, ${k} ${by.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`; };
    const into = [...ov.querySelectorAll('.ov-col:not(.ov-right) .ochip')].map((el) => curve(mid(el), h));
    const out = [...ov.querySelectorAll('.ov-right .ochip')].map((el) => curve(h, mid(el)));
    svg.setAttribute('viewBox', `0 0 ${Math.round(box.width)} ${Math.round(box.height)}`);
    svg.style.setProperty('--t', (performance.now() / 1000).toFixed(3));   // 重畫的線接著流,不跳回起點(AC-3)
    svg.innerHTML = [...into, ...out].map((d) => `<path d="${d}"/>`).join('');
  }
}
// 視窗大小變了,膠囊跟著換位置:線要重畫。一個畫格只畫一次
let wiresQueued = false;
window.addEventListener('resize', () => {
  if (wiresQueued) return;
  wiresQueued = true;
  requestAnimationFrame(() => { wiresQueued = false; drawWires(); });
});

/** 按了按鈕之後一定重畫一次:內容沒變的話不重畫,按下去變灰的那顆按鈕就會一直灰著 */
async function refresh() { lastHtml = null; await poll(); }

document.addEventListener('click', async (e) => {
  // 中英切換(AC-1、AC-7):等伺服器回「現在是另一種」才整頁換——按了不等於換了(R2)。換不成就在按鈕旁講換不成,這一頁照舊
  const ls = e.target.closest('[data-lang-switch]');
  if (ls) { await switchLang(ls); return; }
  const go = e.target.closest('[data-go]');
  if (go) { location.hash = `#/p/${encodeURIComponent(go.dataset.go)}`; return; }

  // 已結案的「還有 N 個／收起」:記住你的選擇,馬上重畫(工地工班風畫面 AC-1、AC-17)
  const of = e.target.closest('[data-ovfold]');
  if (of) { rememberFold(of.dataset.ovfold, !foldOpen(of.dataset.ovfold, false)); lastHtml = null; safeRender(); return; }

  const cp = e.target.closest('[data-copy]');
  if (cp) {
    navigator.clipboard?.writeText(cp.dataset.copy);
    const old = cp.textContent; cp.textContent = zhEn('已複製到剪貼簿', 'Copied to the clipboard');
    setTimeout(() => { cp.textContent = old; }, 1600);
    return;
  }

  // 「你說處理完了／驗收過了」與「不做了」:都只是多記一行(source:human)
  const clr = e.target.closest('[data-clear]');
  if (clr) {
    clr.disabled = true;
    try {
      await fetch('/api/clear', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: clr.dataset.proj, cwd: clr.dataset.cwd, stage: clr.dataset.clear }) });
      await refresh();
    } catch { clr.disabled = false; }
    return;
  }
  const dm = e.target.closest('[data-dismiss]');
  if (dm) {
    dm.disabled = true;
    try {
      await fetch('/api/suggest-dismiss', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: dm.dataset.proj, id: dm.dataset.dismiss }) });
      await refresh();
    } catch { dm.disabled = false; }
    return;
  }
  const cl = e.target.closest('[data-close]');
  if (cl) {
    cl.disabled = true;
    try {
      await fetch('/api/close', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: cl.dataset.proj, session: cl.dataset.close,
                               cwd: cl.dataset.cwd, undo: cl.dataset.undo === '1' }) });
      await refresh();
    } catch { cl.disabled = false; }
  }

  const oo = e.target.closest('[data-optout]');
  if (oo) {
    oo.disabled = true;
    try {
      await fetch('/api/optout', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: oo.dataset.optout, undo: oo.dataset.undo === '1' }) });
      await refresh();
    } catch { oo.disabled = false; }
  }
});
// 調高分級(表單:等級＋理由)／收回。兩個都只是多記一行,伺服器會擋掉不認識的工作區與不比機器高的等級。
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-tier-form]');
  if (!f) return;
  e.preventDefault();
  const btn = f.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await fetch('/api/tier', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: f.dataset.proj, cwd: f.dataset.cwd, level: f.level.value, why: f.why.value }) });
    document.activeElement?.blur?.();   // 游標還在表單裡的話,poll() 會為了不洗掉打到一半的字而跳過重畫——送出了就該畫
    await refresh();
  } catch { btn.disabled = false; }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tier-retract]');
  if (!b) return;
  b.disabled = true;
  try {
    await fetch('/api/tier', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: b.dataset.proj, cwd: b.dataset.cwd, retract: true }) });
    await refresh();
  } catch { b.disabled = false; }
});
/**
 * 按了中英切換。換成了 → 整頁重新載入(首頁跟資料都照新的那一種送);換不成照實講,這一頁照舊原本那一種(AC-7):
 *   連不上 → 「連不上，沒有切換」;舊的服務沒有這個位址(回的是一行字,不是 JSON)→ 重啟之後才能切換;寫不進去 → 照講。
 */
async function switchLang(btn) {
  const want = LANG === 'en' ? 'zh' : 'en';
  const say = (t) => { if ($langNote) $langNote.textContent = t; btn.disabled = false; };
  btn.disabled = true;
  if ($langNote) $langNote.textContent = '';
  let r;
  try {
    r = await fetch('/api/lang', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lang: want }) });
  } catch { return say(zhEn('連不上，沒有切換', 'Couldn\'t connect, so nothing switched')); }
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  if (!body) return say(zhEn('服務還在跑舊的程式，重啟之後才能切換：pipeline-status --serve-restart', 'The service is still running the old program; you can switch after restarting it: pipeline-status --serve-restart'));
  if (body.error === 'write') return say(zhEn('語言設定寫不進去，沒有切換', 'Couldn\'t write the language setting, so nothing switched'));
  if (!r.ok || body.lang !== want) return say(zhEn('沒有切換', 'Nothing switched'));
  // 這一次是自己按的:不算「為了語言重新載入過」,下一次資料對不上照樣會載
  try { sessionStorage.removeItem('pm-lang-reload'); } catch { /* 沒記過就算了 */ }
  location.reload();
}
/**
 * 鍵盤切中英(規格:dashboard-language-shortcut):按 L 跟按那顆按鈕走同一條路——叫同一個 switchLang,
 * 送什麼、等不等伺服器、換不成講哪一句都只有一份(老毛病 P2:兩份遲早講得不一樣)。
 * 這一下按鍵不算「按了 L」的:
 *   正在打字(分級表單的理由、選等級,連送出那顆也算——打到一半的理由不准被整頁重新載入洗掉,AC-2)、輸入法還在組字;
 *   按著 Cmd／Ctrl／Option(那是瀏覽器的:Cmd+L 是跳到網址列,AC-3);
 *   一直按著不放(換完重新載入的新頁面照樣收到同一顆鍵,不擋就會中英來回換,AC-4)。
 * 認打出來的字 l／L;打出來的不是英文字母(注音之類的輸入法、非英文的鍵盤排列)才改認實體的 L 鍵——Dvorak 在那個位置打出來的是 n,不算。
 */
function isLangKey(e) {
  if (e.repeat || e.isComposing || e.keyCode === 229) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.target?.isContentEditable || e.target?.closest?.('input, textarea, select, [data-tier-form]')) return false;
  if (e.key === 'l' || e.key === 'L') return true;
  return e.code === 'KeyL' && !/^[a-z]$/i.test(e.key ?? '');
}
document.addEventListener('keydown', (e) => {
  // 上一次還在等伺服器(按鈕變灰)、或已經換成了正在重新載入:跟滑鼠點一樣不再送——一下按鍵只換一次(AC-4)
  if (!$langBtn || $langBtn.disabled || !isLangKey(e)) return;
  e.preventDefault();
  switchLang($langBtn);
});
// 按鈕的提示(AC-5):跟按鈕上的字同一條規矩,寫成要切過去的那一種——中文的畫面寫英文、英文的畫面寫中文,看不懂現在這一種的人才看得懂
// (所以英文的畫面這一句刻意是中文,測試照原文放過它)。跟按鍵在同一支、同一刻裝上:這支程式沒跑起來、按 L 沒用的時候,提示也不會出現
if ($langBtn) {
  $langBtn.title = LANG === 'en' ? '切換成中文（快速鍵：L）' : 'Switch to English (shortcut: L)';
  $langBtn.setAttribute('aria-keyshortcuts', 'L');
}

// ⚠️ 畫面自己壞掉(某一頁的程式錯)跟資料斷線是兩件事。以前 render 一丟例外就被 poll 的 catch 接走,
//    右上角寫「斷線」——那是把儀表板自己的 bug 講成別人的問題。這裡接住、照實說是畫面壞了,資料照常。
function safeRender() {
  try { render(); }
  catch (e) {
    console.error(zhEn('畫面壞了', 'this page failed to draw'), e);
    lastHtml = null;   // 下一次畫得出來就換掉這一句,就算跟壞掉之前那一頁一模一樣
    $app.innerHTML = zhEn(`<p class="muted">這一頁的畫面壞了（是儀表板自己的問題,不是資料斷線）。
      <a href="#/">回案件列表</a>，然後把這件事告訴 Claude。</p>`, `<p class="muted">This page failed to draw (a problem in the dashboard itself, not a lost connection).
      <a href="#/">Back to the project list</a>, then tell Claude about it.</p>`);
  }
}
window.addEventListener('hashchange', safeRender);

pollLoop();
setInterval(paintFreshness, 1000);
