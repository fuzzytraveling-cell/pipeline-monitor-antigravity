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
 */
import { describeFreshness, STALE_AFTER_SECONDS } from '/freshness.mjs';

const POLL_MS = 5000;
let latest = null, connected = false;
// 這一頁載入時的畫面程式版本(伺服器給的 appVersion)。之後變了 = 服務換了新程式,這一頁還是舊畫面 → 自己重新載入
let bootVersion = null;

const $app = document.getElementById('app');
const $fresh = document.getElementById('freshness');
const $crumb = document.getElementById('crumb');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ═══ 角色:同一份 agent.svg,五個裁切窗（座標是從 SVG 量出來的，不是猜的） ═══ */
/* 每一關在做什麼——用 Oscar 自己那張「蓋房子」對照表的白話。
   icon 用 inline SVG 不用 emoji:emoji 在不同系統長得不一樣,而且跟這套設計格格不入。 */
const I = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
     stroke-linecap="round" stroke-linejoin="round">${d}${extra}</svg>`;
const ROLE = {
  A: { house: '建築師畫圖', does: '把需求翻成一條條可以打勾的驗收條件',
       icon: I('<path d="M4 5h9l4 4v10H4z"/><path d="M13 5v4h4"/><path d="M18.5 13.5 21 16l-4.5 4.5H14v-2.5z"/>') },
  B: { house: '工班施工', does: '照圖蓋,蓋到每條都打勾',
       icon: I('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 10 3 2.5-3 2.5"/><path d="M12.5 15.5H17"/>') },
  C: { house: '收尾清場', does: '清掉施工留下的鷹架、暫時變數、複製貼上',
       // 掃把:一根斜柄 + 綁繩 + 散開的鬃毛
       icon: I('<path d="M17.5 3 11 9.5"/><path d="M12.5 8 8 12.5l3.5 3.5L16 11.5z"/>'
             + '<path d="M8 12.5 4 20"/><path d="m10 14.5-3.2 6.2"/><path d="m12 16.5-1.5 4.5"/>') },
  D: { house: '驗屋師傅拿槌子敲牆', does: '不是看漂不漂亮,是找「哪裡是空心的」',
       // 鐵錘:方形錘頭 + 拔釘爪 + 長柄
       icon: I('<path d="M6.5 5.5h8v4h-8z"/><path d="M6.5 7.5C4.5 7.5 3.5 6.5 3.5 5"/>'
             + '<path d="M6.5 7.5c-2 0-3 1-3 2.5"/><path d="M11 9.5 9.5 20"/>') },
  E: { house: '你自己走進去住一晚', does: '真的開門、開燈、沖馬桶,確認能住人',
       icon: I('<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 3.5v17"/><path d="m12 11 1.8 1.8L17 9.5"/>') },
};

/* ═══ 新鮮度(AC-1／AC-2) ═══ */
function paintFreshness() {
  const f = describeFreshness({ generatedAt: latest?.generatedAt ?? NaN, now: Date.now(), connected });
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

function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return '時間對不上';
  if (s < 60) return `${Math.max(0, s)} 秒前`;
  const m = Math.round(s / 60); if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60); return h < 48 ? `${h} 小時前` : `${Math.round(h / 24)} 天前`;
}
const clock = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? `${String(d.getMonth() + 1)}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
    : '時間對不上';
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
const OLD_LINE = '（服務還在跑舊的程式）';
/** 伺服器給的句子裡把一段標起來(粗體、指令的樣子)。找不到那一段就照原樣——只影響長相,不影響字 */
const mark = (text, part, tag = 'b') => { const t = esc(text), m = esc(part ?? ''); return m && t.includes(m) ? t.replace(m, () => `<${tag}>${m}</${tag}>`) : t; };
/** 舊的服務一頁講一次怎麼修;每個缺字的地方只放上面那句短的 */
function oldServerBanner() {
  return latest && !('sharedLines' in latest)
    ? '<p class="fault" data-tone="amber">🟡 儀表板的服務還在跑舊的程式，有幾句畫不出來——跑 <code>pipeline-status --serve-restart</code></p>' : '';
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

/** 這一輪走到哪,一句話。對話列與案件卡共用,兩邊才說同一句。 */
function roundWhere(stages) {
  const list = stages ?? [];
  const cur = list.find((x) => x.state === 'current' || x.state === 'done');
  if (cur) {
    // E 驗收:伺服器照 lib/verify.mjs 算好的那一句(Claude 走過一遍,等你查核……);舊的服務沒給就照舊
    // 已經驗收也照這一句:Claude 代記的要講是 Claude 代記(魔鬼教官第二輪:以前 done 寫死「你說驗收過了」,第一輪那條只修了一半)
    // 好幾份規格、有一份讀不到:B 對完的只是讀得到的那幾份,這一句也要講(魔鬼教官第一輪:B 那一行講了,對話列與案件卡沒講)
    const unread = cur.type === 'main-conversation' && cur.checklist?.unreadable?.length ? `另有 ${cur.checklist.unreadable.length} 份規格讀不到` : '';
    const tail = cur.type === 'browser' && cur.ewhere ? `（${cur.ewhere}）` : cur.state === 'done' ? (cur.type === 'browser' ? '（你說驗收過了）' : `（處理完了${unread ? `；${unread}` : ''}）`) : unread ? `（${unread}）` : '';
    return `這一輪走到 ${cur.id} ${cur.name}${tail}`;
  }
  // 最後一步是結論會過期的關、而它在「要處理」或「擱著」:不是沒有紀錄(魔鬼教官第一輪,老毛病 P5:這個「找不到」有兩種意思)。
  // B 清單沒對完的樣子也是 stale,但它不會是最後一步——後面的關動了它才變 stale,所以只看有 skill 的關
  const open = [...list].reverse().find((x) => (x.state === 'stale' || x.state === 'held') && x.skill);
  if (open) {
    const why = open.type === 'browser' && open.ewhere ? open.ewhere : open.state === 'held' ? '你說不用再跑' : open.rerun?.state === 'ask' ? '要不要再跑由你決定'
      : open.rerun?.state === 'found' ? '找到問題，還沒處理完' : open.rerun?.state === 'no-report' ? 'Claude 還沒記結論' : '要處理';
    return `這一輪走到 ${open.id} ${open.name}（${why}）`;
  }
  return '這一輪還沒有紀錄';
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

/* ═══ 第一層:案件列表 ═══ */
function projectList() {
  if (!latest?.projects?.length) {
    return `<p class="muted">還沒有任何案件。<br>在一個 git 專案裡跑
      <code>pipeline-status --checkpoint</code> 就會出現在這裡。</p>`;
  }
  const cards = latest.projects.map((p) => {
    // 小格子畫的是「最近在動的那個對話」這一輪走到哪,而且把它的名字寫出來(focusOf)。
    // 還原點是每個工作區各一個,放在案件卡上說不清是誰的——拿掉,點進去看。
    const { session, liveCount } = focusOf(p);
    const off = p.optedOut ? ' · 已退出記錄' : '';
    const body = session
      ? `<div class="mini">${session.stages.filter(sensed).map((s) => `<span data-s="${stageState(s)}"></span>`).join('')}</div>
      <div class="meta focus">最近在動：${esc(session.title ?? '（還沒有標題）')}</div>
      <div class="meta">${esc(roundWhere(session.stages))} · 共 ${liveCount} 個進行中的對話${off}</div>`
      : `<div class="meta">${liveCount ? `${liveCount} 個進行中的對話（它們的工作區都不在了）` : '沒有進行中的對話'}${off}</div>`;
    return `<button class="pcard" data-go="${esc(p.name)}">
      <h3>${esc(p.displayName ?? p.name)}</h3>
      ${body}
    </button>`;
  }).join('');
  return `<div class="block">
      <h2 class="section serif">案件</h2>
      <p class="section-note">只列出<b>有證據</b>的專案（有紀錄或有還原點）。點一下進去看細節。</p>
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
  if (!cp) return `<div class="stat" data-tone="restore">
    <h3 class="ctitle">還原點</h3><div class="label">你回得去哪裡</div>
    <div class="big">還沒有</div>
    <div class="sub">${say(q?.notStamped)}</div>
    <div class="hint">在那個資料夾跑 <code>pipeline-status --checkpoint</code></div></div>`;

  // ⚠️ L14:章指的版本不在這條分支上(歷史被改寫過)時,這張卡**不給**回去的指令。
  //    2026-09-11 主資料夾就是這樣:章指著清歷史之前的版本,複製回去會跳到另一條歷史。
  const rel = c.checkpointRelation;
  if (!cpOk(c)) {
    return `<div class="stat" data-tone="restore">
    <h3 class="ctitle">還原點</h3><div class="label">你回得去哪裡</div>
    <div class="big">失效</div>
    <div class="sub">${ago(cp.at)}蓋的章已經不能用：${say(q?.broken)}</div>
    <div class="hint">⚠️ 所以這裡<b>不給</b>回去的指令。重新蓋一個：<code>pipeline-status --checkpoint</code></div></div>`;
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
  return `<div class="stat" data-tone="restore">
    <h3 class="ctitle">還原點</h3><div class="label">你回得去哪裡</div>
    <div class="big">${esc(c.cpVersion ? `v${c.cpVersion}` : clock(cp.at))}</div>
    <div class="sub">${ago(cp.at)}存的${c.cpVersion ? `（${esc(clock(cp.at))}）` : ''}</div>
    <div class="pills">${pills}</div>
    <div class="hint">上面這幾項當時全綠。<span class="muted">${say(q?.green)}</span></div>
    <button class="copy" data-copy="${esc(cmd)}">複製回去的指令</button>
    <div class="hint">⚠️ 這個網頁<b>不會</b>幫你還原。複製出來的指令<b>已經含 cd</b>,
      貼到終端機或直接貼給 Claude 都可以——貼給 Claude 的話它會先問過你才動手。
      ${rel.commitsAfter ? `<b>蓋章之後你存了 ${rel.commitsAfter} 次</b>,指令會先把它們留在分支
      <code>${esc(c.backupBranch ?? '')}</code> 上再回去。` : ''}
      <b>回去會丟掉還沒 commit 的東西。</b></div>
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
  const TITLE = { commit: 'commit 存進這條分支', merge: `merge 併進 ${esc(L.mainName ?? '主線')}`, push: 'push 推到 GitHub' };
  const steps = L.steps ?? ['commit', 'merge', 'push'].map((id) => ({ id, state: 'unknown', text: '問不到' }));
  const caps = steps.map((st, i) => cap(i + 1, st.state === 'done', TITLE[st.id] ?? esc(st.id), esc(st.text))).join('');

  // 沒有任何一格是「還有東西沒做」或「問不到」,才算安全——空的分支也算安全,它沒有東西會丟
  const allSafe = steps.every((st) => st.state === 'done' || st.state === 'none');
  return `<div class="stat" data-tone="${allSafe ? 'safe' : 'alert'}">
    <h3 class="ctitle">三階梯</h3><div class="label">東西走到哪了</div>
    <div class="pipe">${caps}</div>
    ${L.webUrl ? `<div class="hint"><a class="ext" href="${esc(L.webUrl)}" target="_blank"
      rel="noreferrer">在 GitHub 上看這個 repo ↗</a></div>` : ''}
    <div class="hint muted">⚠️ 這三格顯示的是<b>現在的事實</b>,不是你走過的最遠距離——
      併完之後又動了新東西,它就會退回去。</div>
  </div>`;
}

/** 舊的服務(還沒 --serve-restart)沒給 scope:那時它的「改動」有章比章、沒章比上一次存檔,照當時的字畫,不假裝知道這一輪 */
function scopeOfOldServer(c) {
  return cpOk(c)
    ? { label: '蓋章之後改過、還沒重新檢查的檔案', note: null, empty: '現在的檔案跟蓋章時一模一樣。', short: '蓋章之後', blind: false, emptyBlind: false, commitsNote: null }
    : { label: '還沒存檔（commit）的改動', note: null, empty: '現在的檔案跟上一個存檔一模一樣。', short: '', blind: false, emptyBlind: false, commitsNote: null };
}

function statChanges(c) {
  const f = c.files;
  // 有章:講的是「蓋章之後改過、還沒重新檢查」——它們多半已經 commit 了,不是「還沒 commit」。
  // 以前寫「commit後還沒被檢查的檔案」,Oscar 讀成「還沒 commit 的檔案」(2026-09-15)。
  // 沒有章:講的是這一輪改過的(含已存檔的);找不到這一輪的起點才只講還沒存的。
  // 字是伺服器用 lib/scope.mjs 算好的(c.scope),終端機與收工 hook 同一句——這裡不 import 那支:常駐服務只送它啟動那一刻白名單裡的檔案,
  // 多一個新檔,更新後還沒重啟的那段時間整個畫面會載不進來。舊的服務沒給 scope,那時它算的就是「還沒存檔的」,照舊的字畫
  const sc = c.scope ?? scopeOfOldServer(c);
  // 還沒存的有幾個、比例尺:伺服器照 lib/scope.mjs 算好的那一句(c.lines),跟終端機同一句;舊的服務沒給 → 講舊的程式
  const q = c.lines ?? null;
  const say = (v) => esc(q ? v ?? '' : OLD_LINE);
  const label = sc.label;
  const note = sc.note ? `<div class="hint">${esc(sc.note)}。</div>` : '';
  if (!f) return `<div class="stat" data-tone="change"><h3 class="ctitle">未檢查清單</h3><div class="label">${label}</div>
    <div class="big">問不到</div></div>`;
  // 只看得到還沒存的、或這一輪中間 HEAD 動過的時候,0 不是「沒有改動」(老毛病 P5):存檔過的看不到
  if (!f.total) return `<div class="stat" data-tone="change"><h3 class="ctitle">未檢查清單</h3><div class="label">${label}</div>
    <div class="big">${sc.emptyBlind ? '看不全' : '沒有改動'}</div>
    <div class="sub">${esc(sc.empty)}</div>${sc.emptyBlind ? '' : note}</div>`;

  const groups = f.groups.map((g) => `<div class="fgroup">
      <div class="dir">${esc(g.dir)}/</div>
      <ul>${g.items.map((it) => `<li class="${it.isNew ? 'isnew' : ''}">${esc(it.name)}${
        it.isNew ? ' · 新檔案' : ''}${it.uncommitted ? ' · <b>還沒存</b>' : ''}</li>`).join('')}</ul>
    </div>`).join('');

  return `<div class="stat" data-tone="change">
    <h3 class="ctitle">未檢查清單</h3><div class="label">${label}</div>
    <div class="big"><span class="num">${f.total}</span><span class="unit">個檔案</span></div>
    ${note}
    ${f.uncommittedCount === null ? `<div class="sub">${say(q?.unsavedUnknown)}</div>`
      : f.uncommittedCount > 0 ? `<div class="sub">${q ? `${mark(q.unsaved ?? '', `${f.uncommittedCount} 個還沒存進保險箱（commit）`)}${f.newCount ? `,${f.newCount} 個是新建的` : ''}。` : say()}</div>`
      : `<div class="sub">都已經存了（commit）${cpOk(c) ? ',只是蓋章之後改的,還沒重新檢查。要檢查：<code>pipeline-status --checkpoint</code>' : ''}。</div>`}
    <div class="files">${groups}</div>
    ${c.scale ? `<div class="hint">${q ? `參考:${esc(q.scale ?? '')}。` : say()}</div>` : ''}
  </div>`;
}

/* ═══ 分級:伺服器(lib/tier.mjs)算好,這裡只畫。那幾句是伺服器照 tierLines 算好的(tier.lines),跟終端機的 describeTier 同一句 ═══ */
function statTier(c, p) {
  const t = c.tier;
  if (!t) return '';
  const q = t.lines ?? null;   // 舊的服務沒給 → 每一句講舊的程式,不自己拼(規格:終端機與網頁說同一句 AC-5)
  const say = (v) => esc(q ? v ?? '' : OLD_LINE);
  const card = (tone, big, sub, extra = '') => `<div class="stat" data-tone="${tone}">
    <h3 class="ctitle">分級</h3><div class="label">這次要多小心</div>
    <div class="big">${big}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${extra}</div>`;
  // ⚠️ 沒設定 ≠ T0(R1);讀不懂 ≠ 沒設定。四種各自一張臉——大字是畫面自己的,底下那句是伺服器給的
  if (t.state === 'unset') return card('change', '還沒設定', q ? mark(q.setupHint, '幫我設定分級') : say());
  if (t.state === 'off') return card('change', '不分級', q ? mark(q.main, 'pipeline-status --tier-init', 'code') : say());
  if (t.state === 'broken') return card('alert', '讀不懂', q ? esc(`${q.main}。${q.tail}`) : say());
  if (t.state === 'no-base') return card('change', '沒有基準', say(q?.main));
  if (t.state === 'unknown') return card('change', '問不到', say(q?.main));
  const emptyWarn = q?.emptyWarn ? `<div class="hint">${esc(q.emptyWarn)}</div>` : '';
  if (t.state === 'no-change') return card('safe', '沒有改動', say(q?.main), emptyWarn);
  // 同一個 0 的另一種意思(老毛病 P5):只看得到還沒存的,而還沒存的沒有——不是那張安全的綠臉(規格:這一輪的起點 AC-4)
  if (t.state === 'unseen') return card('change', '看不全', q ? esc(`${q.main}${q.tail}`) : say());
  if (t.state !== 'ok') return card('change', '讀不懂', say(q?.main));

  const { manual, final } = t;
  // 機器為什麼算這一級／你調高的那一句;只算得到還沒存的:存檔過的看不到,實際可能更高——都是伺服器給的那一句
  const sub = !q ? say() : manual ? mark(q.main, `你說 ${manual.id}`) : esc(q.why);
  const blind = q?.blind ? `<div class="hint">${esc(q.blind)}</div>` : '';
  // ✅ 有紀錄而且結案了(Claude 說／你說);⏸ 有紀錄沒結案;⚠️ 沒有紀錄;❔ 問不到／不適用;🔗 規格是別的對話寫的(Claude 說照哪份施工)。沒有「通過」這種狀態(R2)。
  const reqs = q?.reqs?.length
    ? `<ul class="reqs">${q.reqs.map((r) => `<li data-state="${esc(r.state)}">${esc(r.mark)} ${esc(r.label)}：${esc(r.text)}</li>`).join('')}</ul>`
    : '';
  const cand = q?.candidates ? `<div class="hint">${esc(q.candidates)}</div>` : '';
  // 危險清單可能過期了(規格:危險清單會過期):句子是伺服器算好的(lib/tier.mjs,跟終端機同一句),這裡只畫。舊的服務沒給就不畫
  const stale = (t.staleNotes ?? []).map((x) => `<div class="hint">${esc(x)}</div>`).join('');
  const ignored = q?.ignored ? `<div class="hint">${esc(q.ignored)}</div>` : '';
  // 調高:只列比機器算的高的等級,理由必填。收回:只收回你自己調的,回到機器算的——沒有任何按鈕能低於機器算的。
  const control = manual
    ? `<button class="mini-btn" data-tier-retract data-proj="${esc(p.name)}" data-cwd="${esc(c.path)}">收回</button>`
    : t.upgradable.length
      ? `<form class="tierform" data-tier-form data-proj="${esc(p.name)}" data-cwd="${esc(c.path)}">
          <select name="level">${t.upgradable.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('')}</select>
          <input name="why" placeholder="理由（必填）" required maxlength="200">
          <button class="mini-btn" type="submit">調高</button></form>`
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
  const restart = '（儀表板的服務還在跑舊的程式，重啟它：<code>pipeline-status --serve-restart</code>）';
  if (m?.state === 'broken') {
    // ⚠️ 最危險的一種:設定看起來好好的,紀錄卻安靜地停了(LESSONS L13)
    if (!q) return `<p class="section-note">🔴 感測器掛著,但它指向的檔案不存在${restart}。</p>`;
    return `<p class="section-note">${mark(q.broken, q.em)}${q.stopped ? `（${esc(q.stopped)}）` : ''}。${esc(c.sensor?.fix ?? '')}</p>`;
  }
  if (m?.state === 'ok') {
    if (!q || !('noneLine' in c.sensor)) return `<p class="section-note">感測器：已掛上${restart}</p>`;
    // 收工 hook 活著沒:看心跳,不看設定——「掛著」不等於「活著」(L13)
    return `<p class="section-note">${esc(q.mounted)} · ${esc(q.seen ?? c.sensor.noneLine ?? '')} · ${esc(q.gate)}</p>`;
  }
  // 設定裡沒掛上的那兩種(你退出了、設定裡找不到但紀錄還有 → 它在記):伺服器照終端機同一個函式算好給的那一句(lib/faults.mjs 的 sensorOffLine)
  if (c.sensor && 'offLine' in c.sensor && (c.sensor.offLine || q)) {
    return `<p class="section-note">${c.sensor.offLine ? esc(c.sensor.offLine) : mark(q.notMounted, 'pipeline-status --on', 'code')}</p>`;
  }
  return `<p class="section-note">感測器：設定裡找不到——細節跑 <code>pipeline-status</code> 看${restart}。</p>`;
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
  const rows = c.stages.map((st, i) => {
    const s = stageState(st);
    const r = ROLE[st.id] ?? { icon: '·', house: '', does: '' };
    const last = i === c.stages.length - 1;
    const said = st.type === 'browser' ? '驗收過了' : '處理完了';
    // 只有驗收那一關有按鈕(五關自動結案 AC-10):其他關由儀表板自動辨識——按鈕多了會被忽略跳過(Oscar)。跟 CLI 的 --clear 同一種紀錄(source:human)
    // E 還沒被你說驗收過(只開過瀏覽器、Claude 走過一遍等你查核、你說過了之後又改了程式、你說不用再走)都給按鈕;按了是你說的(source:human)
    const stamp = st.type === 'browser' && ['seen', 'ran', 'stale', 'held'].includes(s) && c.path
      ? `<button class="mini-btn" data-clear="${esc(st.id)}" data-proj="${esc(c.project ?? '')}" data-cwd="${esc(c.path)}">你說${said}</button>` : '';
    // E 驗收:三句話分開講——開過瀏覽器、Claude 說走了一遍、你說驗收過了(E 自動驗收 AC-7)。文案是伺服器照 lib/verify.mjs 算好的,這裡只畫;
    // 「看到了」不劃掉、不打勾(那是 Claude 說的,R2)。舊的服務沒給 elines 就照舊畫一行
    const el = st.type === 'browser' ? st.elines ?? null : null;
    const eList = el?.items?.length
      ? `<ul class="acl">${el.items.map((it) => `<li data-verdict="${esc(it.verdict)}"><span class="mark">${esc(it.mark)}</span>
          <span>${it.id ? `<b>${esc(it.id)}</b> ` : ''}${esc(it.body)}${it.note ? `<span class="muted">${esc(it.note)}</span>` : ''}</span></li>`).join('')}</ul>` : '';
    // 那一句是伺服器照 lib/stageLines.mjs 算好的,跟終端機同一句(B 改到程式檔沒、A 等你點頭、D 要不要再跑由你決定…)。這裡只畫
    const status = 'line' in st ? st.line ?? '' : OLD_LINE;
    const saidArgs = st.args
      ? `<div class="said">「${esc(st.args.slice(0, 90))}${st.args.length > 90 ? '…' : ''}」</div>` : '';
    // 寫規格那一關的旁白(規格在哪、另寫了一份…):伺服器給的,跟終端機同一句。舊的服務沒給:那一格的狀態列已經講了舊的程式
    const notes = (Array.isArray(st.notes) ? st.notes : []).map((n) => `<div class="said">${esc(n)}</div>`).join('');
    // A 的清單就是規格檔裡的 AC,照檔案畫(AC-5)。解析不了就照原文、找不到就說找不到——不假裝
    // 只有 A 帶完整的清單(有 items);B 只帶進度摘要,進度已經寫在狀態列,這裡不畫——畫下去就是 undefined 的 .map(2026-09-16 實際炸過一次)
    const cl = st.checklist && Array.isArray(st.checklist.items) ? st.checklist : null;
    const aclItems = (x) => `<ul class="acl">${x.items.map((it) => `<li data-state="${esc(it.state)}"${it.inBatch === false ? ' data-batch="out"' : ''}><span class="mark">${it.state === 'checked' ? '✅' : it.state === 'pending' ? '⏳' : '○'}</span>
          <span><b>${esc(it.id)}</b> ${esc(it.title)}${it.state === 'pending' && it.note ? `<span class="muted">（待討論：${esc(it.note)}）</span>` : ''}${it.inBatch === false ? '<span class="muted">（不在這一批）</span>' : ''}${
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
          : aclBox(`${c.path ?? ''}|${st.id}|${p.name}`, `驗收清單 · ${esc(lineOf(L?.parts?.[i]))}`, aclItems(p.checklist)))).join('')
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

    return `<div class="railcell" data-state="${s}">
        <span class="rlab">${esc(st.id)}</span>
        <span class="dot"></span>

      </div>
      <div class="acard" data-state="${s}">
        <span class="orb" data-id="${esc(st.id)}">${r.icon ?? ''}</span>
        <div class="abody">
          <div class="atitle">${esc(st.id)} ${esc(st.name)}
            <span class="ahouse">${esc(r.house)}</span></div>
          <div class="adoes">${esc(r.does)}</div>
          <div class="astatus">${el ? [el.acts, el.walk, el.human].map(esc).join('<br>') : esc(status)}</div>
          ${saidArgs}${notes}${clHtml}${noteHtml}${eList}${stamp}
        </div>
        <span class="lamp" title="${st.type === 'browser' && st.ewhere ? esc(st.ewhere) : s === 'passed' ? '已走過' : s === 'done' || s === 'ran' ? '現在這一關'
          : s === 'stale' ? (st.type === 'main-conversation' ? '清單沒對完' : !st.rerun ? '結論過期,要再跑一次'
            : st.rerun.state === 'no-report' ? 'Claude 還沒記結論' : st.rerun.state === 'found' ? 'Claude 說找到問題,還沒處理完' : '改過程式檔,要不要再跑由你決定')
          : s === 'held' ? 'Claude 記下你說不用再跑——是你的決定,不是驗過了' : s === 'seen' ? '開過瀏覽器' : '這一輪還沒跑'}"></span>
      </div>`;
  }).join('');

  // ⚠️ 一條貫穿 A→E 的線,絕對定位在整個左欄上——不是每一格各畫一段。
  // 分段畫的話,卡片高度不同就會在接縫處斷開。
  return `<div class="wf">
    <svg class="wf-line" preserveAspectRatio="none" viewBox="0 0 10 1000">
      <path d="M5 6 C2.6 130, 7.8 250, 4.6 372 C1.8 480, 8 600, 5.2 720
               C3 820, 7.4 900, 5 994"/>
    </svg>${rows}</div>`;
}

/* ═══ Overview:左邊在跑的、中間這個專案的狀態、右邊已結案的 ═══ */
function overview(p) {
  const live = p.sessions.filter((s) => !s.closedAt);
  const done = p.sessions.filter((s) => s.closedAt);
  // 中間那格講的是哪個工作區要說出來:最近在動的對話的工作區,沒有的話是主資料夾(focusOf)
  const { session: focus, card } = focusOf(p);
  const subject = focus ? `最近在動：${(focus.title ?? '（還沒有標題）').slice(0, 16)}` : card ? '主資料夾' : null;

  // 「N 天內」:紀錄只留這麼久(天數只住 lib/events.mjs,伺服器給)。更早結案的對話、更早的紀錄已經清掉——不准講成「還沒有」(規格:90天清空之後的說法 AC-3)
  const within = Number.isFinite(latest?.retainDays) ? `${latest.retainDays} 天內` : '';
  const chip = (s) => `<a class="ochip" href="#/p/${encodeURIComponent(p.name)}/s/${encodeURIComponent(s.id)}">
      <span class="odot"></span>${esc((s.title ?? '（還沒有標題）').slice(0, 22))}</a>`;

  // ⚠️ 資料夾不見了的卡沒有任何數字——不能拿 undefined 印成「都存好了」(R1)
  // 一張卡都沒有、90 天內一筆紀錄都沒有:連資料夾在哪都不知道——是清空了,不是「還沒有資料」(AC-3)。其他找不到卡的情況照舊
  const mid = card?.gone ? ['那個資料夾已經不在了'] : card?.notGit ? ['這個資料夾不是 git 專案'] : card ? [
    card.ladder?.uncommitted === null ? '問不到有沒有沒存的檔案'
      : card.ladder?.uncommitted ? `${card.ladder.uncommitted} 個檔案沒存` : '都存好了',
    !card.checkpoint ? '還沒有還原點' : cpOk(card) ? `還原點 ${ago(card.checkpoint.at)}` : '還原點失效',
    // 0 有兩種意思(老毛病 P5):存檔過的看不到的時候,不准寫「沒有待檢查的檔案」——對話頁那張卡寫的是「看不全」
    card.files?.total ? `${card.files.total} 個檔案還沒檢查` : card.scope?.emptyBlind ? '看不全：這一輪存檔過的看不到' : '沒有待檢查的檔案',
  ] : [p.noRecords && !p.cards?.length && within ? `${within}沒有紀錄，也沒有還原點` : '還沒有資料'];

  return `<div class="ov">
    <div class="ov-col">
      <div class="ov-h">正在跑的對話</div>
      ${live.length ? live.map(chip).join('') : '<div class="muted">沒有進行中的對話</div>'}
    </div>
    <div class="ov-mid">
      <div class="ov-hub"><span></span><span></span><span></span></div>
      <div class="ov-state">${subject ? `<div class="ov-subject">${esc(subject)}</div>` : ''}${mid.map((t) => `<div>${esc(t)}</div>`).join('')}</div>
    </div>
    <div class="ov-col ov-right">
      <div class="ov-h">已結案</div>
      ${done.length ? done.map(chip).join('') : `<div class="muted">${within}沒有結案的對話</div>`}
    </div>
    <svg class="ov-wires" preserveAspectRatio="none" viewBox="0 0 100 100">
      ${[22, 38, 50, 62, 78].map((y) =>
        `<path d="M2 ${y} C24 ${y}, 32 50, 48 50"/>`).join('')}
      ${[30, 44, 56, 70].map((y) =>
        `<path class="out" d="M52 50 C68 50, 76 ${y}, 98 ${y}"/>`).join('')}
    </svg>
  </div>`;
}

/* ═══ 第二層:一個案件底下的對話清單 ═══ */
function sessionList(p) {
  if (!p.sessions.length) {
    // 紀錄檔在、90 天內沒有任何對話(多半是三個月沒用、照規矩清掉了):伺服器照終端機五關同一句算好給的(lib/rounds.mjs 的 noRecordLine)。
    // 以前一律寫「還沒有任何對話紀錄,去掛上感測器」——清空之後感測器明明掛著(規格:90天清空之後的說法 AC-3)。
    // 舊的服務沒給這一欄 → 不自己湊一句,講服務還在跑舊的程式(AC-5,跟 appCardsSince 同一個做法)
    if (!('emptyLine' in p)) {
      return `<div class="block"><p class="muted">這個專案沒有對話可以列——儀表板的服務還在跑舊的程式，分不出是從來沒記過、還是超過保留期限清掉了。
        重啟它：<code>pipeline-status --serve-restart</code></p></div>`;
    }
    if (p.emptyLine) return `<div class="block"><p class="muted">${esc(p.emptyLine)}</p></div>`;
    return `<div class="block"><p class="muted">這個案件還沒有任何對話紀錄。<br>
      在那個資料夾跑 <code>pipeline-status --on</code> 掛上感測器,
      之後的對話就會出現在這裡。</p></div>`;
  }
  const row = (s) => {
    // 這一輪走到哪:現在這一關的名字,比「x/4」更像人話
    const seen = s.stages.find((x) => x.state === 'seen');
    const where = roundWhere(s.stages) + (seen ? ' · 開過瀏覽器,還沒有人說驗收過' : '');
    return `<div class="srow ${s.closedAt ? 'closed' : ''}">
      <a class="sname" href="#/p/${encodeURIComponent(p.name)}/s/${encodeURIComponent(s.id)}">
        ${esc(s.title ?? '（還沒有標題）')}</a>
      <span class="smeta">${s.prompts} 則訊息 · 最後動作 ${ago(s.lastTs)}
        · ${esc(where)}${s.sharesCwd ? ' · ⚠️ 與其他對話共用工作區' : ''}${s.movedOn ? ' · 資料夾已換給別的對話' : ''}${
        s.reopenedByActivity ? ` · 結案後又有動作（${ago(s.reopenedByActivity)}）,算回進行中` : ''}</span>
      ${s.deletedAt
        ? `<span class="muted">已在 app 裡刪除</span>`
        : `<button class="mini-btn" data-close="${esc(s.id)}" data-proj="${esc(p.name)}"
        data-cwd="${esc(s.cwd ?? '')}" data-undo="${s.closedAt ? 1 : 0}">
        ${s.closedAt ? '取消結案' : '結案'}</button>`}
    </div>`;
  };
  return `<div class="block">
      <h2 class="section serif">對話</h2>
      <p class="section-note">一個功能開一個對話,各自獨立。點進去看那個對話的完整狀況。</p>
      <div class="slist">${p.sessions.map(row).join('')}</div>
    </div>`;
}

function projectPage(name) {
  const p = latest?.projects?.find((x) => x.name === name);
  if (!p) return `<p class="muted">找不到「${esc(name)}」。<a href="#/">回列表</a></p>`;
  return `<div class="block">
      <h2 class="section serif">Overview</h2>
      <p class="section-note">左邊在跑的、中間這個專案現在的狀態、右邊已結案的。</p>
      ${overview(p)}
      ${optOutLine(p)}
    </div>` + suggestionsBlock(p) + sessionList(p);
}

/**
 * 建議另開的對話。兩條路來的卡長得一樣,卡上寫是哪條(app建議卡 AC-5):Claude 用 --suggest 放的、或 Claude 在 app 的對話裡提的建議卡。
 * ⚠️ 儀表板開不了對話——只能讓你複製說明、貼進新對話的第一句。
 * ⚠️ 儀表板也看不到 app 的叉叉:在 app 把卡按掉,這裡那張還在,卡上不准寫「你已取消」(AC-2)。
 *    Claude 自己在對話裡叫了收回(做完了、前提變了、換一張新的):對不回是哪一張,
 *    所以標在**那個對話、收回之前提的每一張**卡上,附 Claude 說的理由,卡照樣掛著——撕不撕你決定(app建議卡 AC-7)。
 *    app 那條記到的是「Claude 叫了這張卡」,不是「卡真的跳出來了」——文案只講 Claude 提了(R2)。
 * ⚠️ 一張卡都沒有也要畫這一區:「沒有建議」跟「感測器根本沒記到」長得一樣(老毛病 P5),那句「不代表沒跳過」就是為這種時候寫的。
 */
function suggestionsBlock(p) {
  const all = p.suggestions ?? [];
  // 已開始的從清單拿掉——那個對話會出現在「對話」裡,留著就是同一件事出現兩次(Oscar 2026-09-15)。
  // 拿掉不是刪掉:跟「不做了」的一起收在最下面。一張卡不見了,要查得到它是被認成已開始、還是你按了不做了——不然跟弄丟分不出來
  const open = all.filter((s) => !s.dismissedAt && !s.startedBy);
  const folded = all.filter((s) => s.dismissedAt || s.startedBy);
  const sessionHref = (proj, sid) => `#/p/${encodeURIComponent(proj)}/s/${encodeURIComponent(sid)}`;
  const row = (s) => {
    const cut = new Set(s.cut ?? []);
    const prompt = String(s.prompt ?? '');
    const firstLine = prompt.split('\n').find((l) => l.trim()) ?? '';
    const from = s.source === 'app' && s.session && s.fromTitle
      ? ` · 來自 <a href="${sessionHref(p.name, s.session)}">${esc(s.fromTitle)}</a>` : '';
    const source = s.source === 'app' ? `Claude 在對話裡提的建議卡 · ${ago(s.ts)}${from}` : `Claude 用 --suggest 放的 · ${ago(s.ts)}`;
    // 說明(app 的卡才有)與要貼的話。空的要講「沒有內容」,不是不畫這張卡(R1)
    const lines = [];
    if (s.tldr) lines.push(`說明：${esc(s.tldr)}${cut.has('tldr') ? '…（已截短）' : ''}`);
    if (prompt.trim()) lines.push(`要貼的話：${esc(firstLine.slice(0, 80))}${firstLine.length > 80 || prompt.trim() !== firstLine.trim() ? '…' : ''}`);
    else lines.push(s.tldr ? '這張卡沒有要貼的話' : '這張卡沒有內容');
    if (cut.has('prompt')) {
      lines.push(`已截短：要貼的話太長,紀錄只留得下前面一段${s.source === 'app' ? `;完整的在原本那個對話裡${s.fromTitle ? `（${esc(s.fromTitle)}）` : ''}` : ''}`);
    }
    if (s.openIn) {
      lines.push(s.openIn.project ? `要開在別的專案：<a href="#/p/${encodeURIComponent(s.openIn.project)}">${esc(s.openIn.name ?? s.openIn.project)}</a>`
        : s.openIn.name ? `要開在別的資料夾：${esc(s.openIn.name)}` : '要開在別的資料夾（路徑太長,沒記完整）');
    }
    // Claude 後來在這個對話裡叫過收回(AC-7):分不出是不是這一張,照實講,附它說的理由。記到的是「叫了收回」,不是「收回成功」(R2)
    const wd = Array.isArray(s.withdrawals) ? s.withdrawals : [];
    if (wd.length) {
      const reasons = wd.slice(0, 3).map((w) => (w.reason ? `「${esc(w.reason)}${w.cut ? '…' : ''}」` : '（沒寫理由）')).join('、');
      // 已經收起來的卡(已開始、你說不做了)沒有「不做了」按鈕,不叫人去按一顆不存在的按鈕
      const next = s.dismissedAt || s.startedBy ? '' : '，過時的話按「不做了」';
      lines.push(`⚠️ Claude 後來在這個對話裡叫過 ${wd.length} 次收回建議卡，理由：${reasons}${wd.length > 3 ? ` 等 ${wd.length} 次` : ''}——分不出收回的是不是這一張${next}`);
    }
    // 收起來的理由:看得到的事實優先(真的有對話這樣開頭),再來才是你按的
    if (s.startedBy) {
      const where = s.startedProject ? `（在 ${esc(s.startedProject.name ?? s.startedProject.project)}）` : '';
      const link = s.startedTitle
        ? `<a href="${sessionHref(s.startedProject?.project ?? p.name, s.startedBy)}">${esc(s.startedTitle)}</a>${where}`
        : '有對話這樣開頭了,但那個對話不在儀表板列得出來的專案裡';
      lines.push(`已開始：${link}${s.dismissedAt ? ` · 你 ${ago(s.dismissedAt)}按過「不做了」` : ''}`);
    } else if (s.dismissedAt) {
      lines.push(`你 ${ago(s.dismissedAt)}說不做了`);
    }
    const copy = prompt.trim()
      ? `<button class="copy" data-copy="${esc(prompt)}">${cut.has('prompt') ? '複製前面這一段' : '複製說明'}</button>` : '';
    const dismiss = s.dismissedAt || s.startedBy ? ''
      : `<button class="mini-btn" data-dismiss="${esc(s.id)}" data-proj="${esc(p.name)}">不做了</button>`;
    return `<div class="srow ${s.dismissedAt || s.startedBy ? 'closed' : ''}">
      <span class="sname">${esc(s.title)}${cut.has('title') ? '…' : ''}</span>
      <span class="smeta">${source}</span>
      ${lines.map((l) => `<span class="smeta">${l}</span>`).join('')}
      <span class="sact">${copy}${dismiss}</span>
    </div>`;
  };
  // app 的建議卡從什麼時候開始有紀錄(L3):更早跳過的這裡一輩子不會知道,不准讓這一區看起來像「全部都在這裡」。
  // 接點是對話開始時讀的,所以接上之前就開著的對話,之後跳的卡照樣記不到——兩種說法都要帶這半句。
  // 紀錄裡一張都沒有的時候,分不出是沒跳過、沒接上、還是超過保留期限被丟掉了:三種都講,不挑一種
  const days = Number.isFinite(latest?.retainDays) ? `（${latest.retainDays} 天）` : '';
  // ⚠️ appCardsSince 這個欄位**不在**(undefined)跟**是 null** 是兩件事:不在 = 伺服器沒回答這一題——常駐的儀表板服務跑的是它啟動那一刻的程式,
  //    更新之後沒重啟的話,這支新畫面配的是不認得 app 建議卡的舊資料。那時講「紀錄裡沒有」就是把沒問到講成沒有(R1),要講真正的原因跟下一步
  const since = p.appCardsSince === undefined
    ? '⚠️ 儀表板的服務還在跑舊的程式,它不認得 app 對話裡的建議卡——那種卡就算記到了,這裡現在也看不到。跑一次 <code>pipeline-status --serve-restart</code>,再重新整理這一頁。'
    : p.appCardsSince
      ? `app 對話裡的建議卡從 ${clock(p.appCardsSince)} 開始有紀錄;更早跳過的、還沒重開的對話裡跳的,這裡不會有。`
      : `紀錄裡沒有 app 對話裡的建議卡——不代表沒跳過:接上這個功能之前跳的、還沒重開的對話裡跳的、超過保留期限${days}的,這裡都看不到。`;
  // 卡掛在提建議的那個專案那一頁;要開在**這個**專案的卡,在這一頁指路——不然這一頁說沒有,別頁卻掛著要開在這裡的卡(P5)
  const incoming = (p.incomingSuggestions ?? []).map((x) =>
    `別的專案的對話提了 ${x.count} 張要開在這裡的建議卡,掛在 <a href="#/p/${encodeURIComponent(x.project)}">${esc(x.name ?? x.project)}</a> 那一頁。`).join('');
  const incomingNote = incoming ? `<p class="section-note">${incoming}</p>` : '';
  if (!all.length) {
    return `<div class="block">
      <h2 class="section serif">建議新增的對話</h2>
      <p class="section-note">Claude 覺得該另開一個對話做的事會放在這裡。這個專案的對話提的建議,紀錄裡現在一張都沒有。${since}</p>
      ${incomingNote}
    </div>`;
  }
  const started = folded.filter((s) => s.startedBy).length;
  const foldKey = `sg-fold|${p.name}`;
  const foldedBox = folded.length
    ? `<details class="acl-box sg-fold" data-fold="${esc(foldKey)}"${foldOpen(foldKey, false) ? ' open' : ''}>
        <summary>收起來的 ${folded.length} 張（已開始 ${started}、你說不做了 ${folded.length - started}）</summary>
        <div class="slist">${folded.map(row).join('')}</div>
      </details>` : '';
  return `<div class="block">
      <h2 class="section serif">建議新增的對話</h2>
      <p class="section-note">Claude 覺得該另開一個對話做的事。這裡開不了對話——<b>複製說明</b>，在 app 開新對話，貼進第一句。
        有對話真的照這段說明開了，這張會自己收到最下面（點開看得到是哪個對話）；不想做了按<b>不做了</b>。</p>
      <p class="section-note">這一區看不到卡在 app 裡是怎麼不見的（你按掉、或被後來的新卡擠掉）——那種卡在這裡會繼續掛著。
        Claude 自己在對話裡叫了收回（做完了、前提變了、換了一張新的），會標在那個對話先前提的卡上，但分不出收回的是哪一張；過時的要自己按「不做了」。${since}</p>
      ${incomingNote}
      ${open.length ? `<div class="slist">${open.map(row).join('')}</div>` : '<p class="section-note">現在沒有還沒處理的建議。</p>'}
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
      : `這個專案已退出記錄${p.optedOut.at ? `（${esc(ago(p.optedOut.at))}）` : ''}。（儀表板的服務還在跑舊的程式，重啟它：<code>pipeline-status --serve-restart</code>）`;
    return `<p class="section-note">${line}
      <button class="mini-btn" data-optout="${esc(p.mainRoot)}" data-undo="1">重新加入記錄</button></p>`;
  }
  return `<p class="section-note">感測器會記這個專案的每個對話（只在這台電腦上）。
    <button class="mini-btn" data-optout="${esc(p.mainRoot)}" data-undo="0">退出記錄</button></p>`;
}

/* ═══ 第三層:一個對話 ═══ */
function sessionPage(name, sid) {
  const p = latest?.projects?.find((x) => x.name === name);
  const s = p?.sessions.find((x) => x.id === sid);
  if (!s) return `<p class="muted">找不到這個對話。<a href="#/p/${encodeURIComponent(name)}">回對話清單</a></p>`;
  // 伺服器算好的兩種旁白(規格:agent回報與故障記號 AC-2、AC-5),跟終端機同一句,這裡只畫:
  // 沒算成你說的話的訊息(沒見過的格式)、這一輪碰到的那段「感測器或收工 hook 壞過」
  const notes = [s.unknownNote, ...(s.faultNotes ?? [])].filter(Boolean).map((t) => `<p class="section-note">${esc(t)}</p>`).join('');
  const c = s.card;
  if (!c) return `<p class="muted">這個對話的工作區找不到了（${esc(s.cwd ?? '?')}）。</p>`;
  // 工作區的資料夾已經不在了(worktree 被刪):git 那三張卡沒有東西可講,五關的紀錄還在,照畫。
  // ⚠️ 以前這裡照樣去讀 c.sensor.state → 整頁炸掉 → 被當成「斷線」(2026-09-15 Oscar 點進去就斷)。
  if (c.gone) {
    return `
    <div class="block">
      <h2 class="section serif">${esc(s.title ?? '（還沒有標題）')}</h2>
      <p class="section-note">${s.prompts} 則訊息 · 最後動作 ${ago(s.lastTs)}</p>${notes}
      <p class="section-note">⚠️ 這個對話的工作區資料夾已經不在了（${esc(s.cwd ?? '')}）——
        還原點、三階梯、改動都沒有東西可講。下面五關的紀錄還在。</p>
    </div>
    <div class="block">
      <h2 class="section serif">My Agent work flow</h2>
      ${workflow({ ...c, sensor: { state: 'ok' }, stages: s.stages })}
    </div>`;
  }
  // 資料夾換人了(規格:新對話接手舊資料夾 AC-5):app 把這個對話留下的資料夾換一條新分支給別的對話用。
  // 資料夾現在的分支、還原點、改動、分級都是那個對話的——畫在這裡就是把別人的進度講成這個對話的。跟「資料夾不在了」同一個樣子:只畫五關。
  // ⚠️ 五關那裡把 path 拿掉:E 那一格的「你說驗收過了」是按資料夾記的——在這一頁按,記到的是現在在這個資料夾做事的那個對話(R2)
  if (s.movedOn) {
    return `
    <div class="block">
      <h2 class="section serif">${esc(s.title ?? '（還沒有標題）')}</h2>
      <p class="section-note">${s.prompts} 則訊息 · 最後動作 ${ago(s.lastTs)}${s.closedAt ? ` · 已於 ${ago(s.closedAt)}結案` : ''}</p>${notes}
      <p class="section-note">⚠️ 這個資料夾 ${ago(s.movedOn.at)}換到另一條分支、給別的對話用了——
        分支、還原點、改動、分級是那個對話的，這裡不畫。下面五關是這個對話當時的紀錄。</p>
    </div>
    <div class="block">
      <h2 class="section serif">My Agent work flow</h2>
      ${workflow({ ...c, path: null, sensor: { state: 'ok' }, stages: s.stages })}
    </div>`;
  }

  // 共用工作區:改動與分級一個資料夾一份(lib/collect.mjs 的 sessionTier),別的對話改的也算在裡面——講清楚,不讓人以為那些都是這個對話做的
  const warn = s.sharesCwd
    ? `<p class="section-note">⚠️ 這個工作區還有別的對話在用,所以下面的 git 狀態與分級是<b>共用的</b>——
       不是這個對話獨有：別的對話改的也算在裡面。</p>` : '';

  return `
    <div class="block">
      <h2 class="section serif">${esc(s.title ?? '（還沒有標題）')}</h2>
      <p class="section-note">${esc(c.branch ?? '沒有分支')} · ${s.prompts} 則訊息 ·
        最後動作 ${ago(s.lastTs)}${s.closedAt ? ` · 已於 ${ago(s.closedAt)}結案` : ''}</p>
      ${notes}${warn}
      <div class="stats">${statRestore(c)}${statLadder(c)}${statChanges(c)}${statTier({ ...c, tier: s.tier ?? c.tier }, p)}</div>
    </div>
    <div class="block">
      <h2 class="section serif">My Agent work flow</h2>
      <p class="section-note">五個工班跑到哪了,工作進度監視。<br>
        ${esc(latest?.sharedLines?.calledNotPassed ?? OLD_LINE)}</p>
      ${sensorLine(c)}
      ${stagesNoteLine(c)}
      ${workflow({ ...c, stages: s.stages })}
    </div>`;
}

/**
 * 故障橫條(規格:agent回報與故障記號 AC-3):還在壞(紅)、時好時壞／看不到好了沒(黃)的才上,每一頁最上面都有。
 * 句子是伺服器算好的(lib/faults.mjs,跟終端機最上面那一行一字不差),這裡只畫。
 * 舊的服務不給這一欄 → 講出來,不當成沒有故障(L20:合併之後還沒 --serve-restart,新畫面拿到的是舊伺服器的資料)。
 */
function faultBanner() {
  if (!latest) return '';
  if (!latest.faults) return '<p class="fault" data-tone="amber">🟡 儀表板的服務還在跑舊的程式，感測器跟收工 hook 有沒有壞這裡看不到——跑 <code>pipeline-status --serve-restart</code></p>';
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
  if (r.view === 'projects') {
    $crumb.innerHTML = '<span>案件</span>';
    $app.innerHTML = faultBanner() + oldServerBanner() + projectList();
  } else if (r.view === 'project') {
    // 路由用的是檔名(safeName 過的);麵包屑給人看,要用真的資料夾名
    const p = latest?.projects?.find((x) => x.name === r.project);
    $crumb.innerHTML = link('#/', '案件') + `<span>${esc(p?.displayName ?? r.project)}</span>`;
    $app.innerHTML = faultBanner() + oldServerBanner() + projectPage(r.project);
  } else {
    const p = latest?.projects?.find((x) => x.name === r.project);
    const s = p?.sessions.find((x) => x.id === r.session);
    $crumb.innerHTML = link('#/', '案件')
      + link(`#/p/${encodeURIComponent(r.project)}`, p?.displayName ?? r.project)
      + `<span>${esc((s?.title ?? '對話').slice(0, 20))}</span>`;
    $app.innerHTML = faultBanner() + oldServerBanner() + sessionPage(r.project, r.session);
  }
}

document.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { location.hash = `#/p/${encodeURIComponent(go.dataset.go)}`; return; }

  const cp = e.target.closest('[data-copy]');
  if (cp) {
    navigator.clipboard?.writeText(cp.dataset.copy);
    const old = cp.textContent; cp.textContent = '已複製到剪貼簿';
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
      await poll();
    } catch { clr.disabled = false; }
    return;
  }
  const dm = e.target.closest('[data-dismiss]');
  if (dm) {
    dm.disabled = true;
    try {
      await fetch('/api/suggest-dismiss', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: dm.dataset.proj, id: dm.dataset.dismiss }) });
      await poll();
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
      await poll();
    } catch { cl.disabled = false; }
  }

  const oo = e.target.closest('[data-optout]');
  if (oo) {
    oo.disabled = true;
    try {
      await fetch('/api/optout', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: oo.dataset.optout, undo: oo.dataset.undo === '1' }) });
      await poll();
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
    await poll();
  } catch { btn.disabled = false; }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tier-retract]');
  if (!b) return;
  b.disabled = true;
  try {
    await fetch('/api/tier', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: b.dataset.proj, cwd: b.dataset.cwd, retract: true }) });
    await poll();
  } catch { b.disabled = false; }
});
// ⚠️ 畫面自己壞掉(某一頁的程式錯)跟資料斷線是兩件事。以前 render 一丟例外就被 poll 的 catch 接走,
//    右上角寫「斷線」——那是把儀表板自己的 bug 講成別人的問題。這裡接住、照實說是畫面壞了,資料照常。
function safeRender() {
  try { render(); }
  catch (e) {
    console.error('畫面壞了', e);
    $app.innerHTML = `<p class="muted">這一頁的畫面壞了（是儀表板自己的問題,不是資料斷線）。
      <a href="#/">回案件列表</a>，然後把這件事告訴 Claude。</p>`;
  }
}
window.addEventListener('hashchange', safeRender);

pollLoop();
setInterval(paintFreshness, 1000);
