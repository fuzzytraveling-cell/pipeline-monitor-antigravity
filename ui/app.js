/**
 * app.js —— 畫面。規格:docs/進行中/pipeline-ui.md
 *
 * 兩層:  #/          案件列表(有哪些專案接上了)
 *        #/p/<名字>  那個案件的儀表板
 *
 * ⚠️ 不能妥協的還是 AC-1／AC-2:畫面必須隨時說出資料多新,斷線時整頁承認。
 *    判斷在 lib/freshness.mjs(純函式,被測試釘住),這裡只負責畫。
 */
import { describeFreshness } from '/freshness.mjs';

const POLL_MS = 5000;
let latest = null, connected = false;

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
       icon: I('<path d="M14.5 3.5 10 8"/><path d="m8.5 6.5 4 4"/><path d="M9.5 9.5 4 15v5h5l5.5-5.5z"/><path d="m6 14 4 4"/>') },
  D: { house: '驗屋師傅拿槌子敲牆', does: '不是看漂不漂亮,是找「哪裡是空心的」',
       icon: I('<path d="M13.5 3.5 20 10l-2.5 2.5-6.5-6.5z"/><path d="M11.5 8 4 15.5V20h4.5L16 12.5"/>') },
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
async function poll() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    latest = await r.json(); connected = true; render();
  } catch { connected = false; }   // AC-2:不准靜靜停止更新
  paintFreshness();
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
const stageState = (st) =>
  st.type === 'not-built' ? 'notbuilt' :
  st.type === 'main-conversation' ? 'main' :
  st.clearedAt ? 'done' : st.ranAt ? 'ran' : 'none';

/* ═══ 第一層:案件列表 ═══ */
function projectList() {
  if (!latest?.projects?.length) {
    return `<p class="muted">還沒有任何案件。<br>在一個 git 專案裡跑
      <code>pipeline-status --checkpoint</code> 就會出現在這裡。</p>`;
  }
  const cards = latest.projects.map((p) => {
    const c = p.cards[0];
    const mini = (c?.stages ?? []).filter((s) => !s.type)
      .map((s) => `<span data-s="${stageState(s)}"></span>`).join('');
    const cp = c?.checkpoint;
    return `<button class="pcard" data-go="${esc(p.name)}">
      <h3>${esc(p.name)}</h3>
      <div class="mini">${mini}</div>
      <div class="meta">${p.cards.length} 個工作區 ·
        ${cp ? `還原點 ${ago(cp.at)}` : '還沒有還原點'}</div>
    </button>`;
  }).join('');
  return `<div class="block">
      <h2 class="section serif">案件</h2>
      <p class="section-note">只列出<b>有證據</b>的專案（有紀錄或有還原點）。點一下進去看細節。</p>
      <div class="projects">${cards}</div>
    </div>`;
}

/* ═══ 三張狀態卡 ═══ */
function statRestore(c) {
  const cp = c.checkpoint;
  if (!cp) return `<div class="stat" data-tone="restore">
    <h3 class="ctitle">還原點</h3><div class="label">你回得去哪裡</div>
    <div class="big">還沒有</div>
    <div class="sub">這不代表你沒有好版本,只代表還沒看過你跑檢查。</div>
    <div class="hint">在那個資料夾跑 <code>pipeline-status --checkpoint</code></div></div>`;

  // ⚠️ 一定要帶 cd。少了它,這一行會在終端機**當下所在的資料夾**執行——
  // 而 `git reset --hard` 跑錯資料夾會毀掉另一個專案的東西,還沒有 undo。
  // Oscar 2026-09-10 實際貼了才發現,這是我漏掉的,而且是危險的那一種。
  const cmd = `cd ${JSON.stringify(c.path)} && git reset --hard ${cp.commit.slice(0, 7)}`;
  // ⚠️ 不再把 SHA 當標題。`a79e8d7` 對使用者沒有意義——時間與版本號才有。
  // SHA 只留在「複製回去的指令」裡,因為 git 需要它。
  const pills = cp.checks.map((k) => `<span class="pill ok">${esc(k)}</span>`).join('');
  return `<div class="stat" data-tone="restore">
    <h3 class="ctitle">還原點</h3><div class="label">你回得去哪裡</div>
    <div class="big">${esc(c.cpVersion ? `v${c.cpVersion}` : clock(cp.at))}</div>
    <div class="sub">${ago(cp.at)}存的${c.cpVersion ? `（${esc(clock(cp.at))}）` : ''}</div>
    <div class="pills">${pills}</div>
    <div class="hint">上面這幾項當時全綠。<span class="muted">⚠️ 檢查全綠不等於功能正確。</span></div>
    <button class="copy" data-copy="${esc(cmd)}">複製回去的指令</button>
    <div class="hint">⚠️ 這個網頁<b>不會</b>幫你還原。複製出來的指令<b>已經含 cd</b>,
      貼到終端機或直接貼給 Claude 都可以——貼給 Claude 的話它會先問過你才動手。
      <b>回去會丟掉還沒 commit 的東西。</b></div>
  </div>`;
}

function statLadder(c) {
  const L = c.ladder ?? {};
  // 每一階是一個膠囊;膠囊之間有一段會流動的連接線。
  // ⚠️ 三段的流動速度一樣,不隨狀態變——否則會被讀成「現在正在跑」。
  let cur = false;   // 第一個還沒完成的階梯 = 你現在在哪
  const cap = (n, ok, title, detail) => {
    const isCur = !ok && !cur;
    if (isCur) cur = true;
    return `<div class="cap" data-ok="${ok ? 'yes' : 'no'}" data-cur="${isCur ? 1 : 0}">
       <span class="capn">${n}</span>
       <span class="capt"><b>${title}</b><small>${detail}</small></span>
     </div>`;
  };

  const s1 = L.uncommitted === null ? cap(1, false, 'commit 存進這條分支', '問不到')
    : L.uncommitted === 0 ? cap(1, true, 'commit 存進這條分支', '都存好了')
    : cap(1, false, 'commit 存進這條分支', `還有 ${L.uncommitted} 個檔案沒存`);

  const s2 = L.unmerged === null ? cap(2, false, 'merge 併進主線', '問不到')
    : L.onMain ? cap(2, true, 'merge 併進主線', `你就在 ${esc(L.mainName ?? 'main')} 上,不用併`)
    : L.unmerged === 0 ? cap(2, true, `merge 併進 ${esc(L.mainName ?? 'main')}`, '已經併進去了')
    : cap(2, false, `merge 併進 ${esc(L.mainName ?? 'main')}`, `這條分支還多 ${L.unmerged} 個存檔沒併`);

  const s3 = !L.hasUpstream
    ? cap(3, false, 'push 推到 GitHub', '這條分支還沒有遠端 — 只存在你這台電腦上')
    : L.unpushed === null ? cap(3, false, 'push 推到 GitHub', '問不到')
    : L.unpushed === 0 ? cap(3, true, 'push 推到 GitHub', '已經同步了')
    : cap(3, false, 'push 推到 GitHub', `還有 ${L.unpushed} 個存檔沒推上去`);

  const allSafe = L.uncommitted === 0 && (L.onMain || L.unmerged === 0) && L.unpushed === 0;
  return `<div class="stat" data-tone="${allSafe ? 'safe' : 'alert'}">
    <h3 class="ctitle">三階梯</h3><div class="label">東西走到哪了</div>
    <div class="pipe">${s1}${s2}${s3}</div>
    ${L.webUrl ? `<div class="hint"><a class="ext" href="${esc(L.webUrl)}" target="_blank"
      rel="noreferrer">在 GitHub 上看這個 repo ↗</a></div>` : ''}
    <div class="hint muted">⚠️ 這三格顯示的是<b>現在的事實</b>,不是你走過的最遠距離——
      併完之後又動了新東西,它就會退回去。</div>
  </div>`;
}

function statChanges(c) {
  const f = c.files;
  if (!f) return `<div class="stat" data-tone="change"><h3 class="ctitle">未檢查清單</h3><div class="label">commit 後還沒被檢查的檔案</div>
    <div class="big">問不到</div></div>`;
  if (!f.total) return `<div class="stat" data-tone="change"><h3 class="ctitle">未檢查清單</h3><div class="label">commit 後還沒被檢查的檔案</div>
    <div class="big">沒有改動</div>
    <div class="sub">${c.checkpoint ? '蓋章之後' : '相對於上一個存檔'}沒有任何檔案被動過。</div></div>`;

  const groups = f.groups.map((g) => `<div class="fgroup">
      <div class="dir">${esc(g.dir)}/</div>
      <ul>${g.items.map((it) => `<li class="${it.isNew ? 'isnew' : ''}">${esc(it.name)}${
        it.isNew ? ' · 新檔案' : ''}</li>`).join('')}</ul>
    </div>`).join('');

  return `<div class="stat" data-tone="change">
    <h3 class="ctitle">未檢查清單</h3><div class="label">${c.checkpoint ? 'commit 後還沒被檢查的檔案' : '還沒存檔的改動'}</div>
    <div class="big">${f.total} 個檔案</div>
    ${f.newCount ? `<div class="sub">其中 ${f.newCount} 個是新建的。</div>` : ''}
    <div class="files">${groups}</div>
    ${c.scale ? `<div class="hint">參考:這個專案一次改動通常 ${c.scale.median} 個檔案,
      最多到過 ${c.scale.max} 個。</div>` : ''}
  </div>`;
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
    const status =
      s === 'notbuilt' ? '這一關還沒建'
      : s === 'main' ? '就是你在講話的那個對話'
      : s === 'done' ? `${ago(st.ranAt)}跑過,你說處理完了`
      : s === 'ran' ? `${ago(st.ranAt)}跑過,還沒有人說處理完了`
      : (c.sensor.state === 'ok' ? '沒有紀錄' : '感測器沒有資料');
    const said = st.args
      ? `<div class="said">「${esc(st.args.slice(0, 90))}${st.args.length > 90 ? '…' : ''}」</div>` : '';

    return `<div class="railcell" data-state="${s}">
        <span class="rlab">${esc(st.id)}</span>
        <span class="dot"></span>
        ${last ? '' : `<span class="link">
          <svg preserveAspectRatio="none" viewBox="0 0 12 100">
            <path d="M6 0 C4.4 18, 7.6 34, 5.6 52 C4 68, 7.2 84, 6 100"/>
          </svg></span>`}
      </div>
      <div class="acard" data-state="${s}">
        <span class="orb" data-id="${esc(st.id)}">${r.icon ?? ''}</span>
        <div class="abody">
          <div class="atitle">${esc(st.id)} ${esc(st.name)}
            <span class="ahouse">${esc(r.house)}</span></div>
          <div class="adoes">${esc(r.does)}</div>
          <div class="astatus">${esc(status)}</div>
          ${said}
        </div>
        <span class="lamp" title="${s === 'done' || s === 'ran' ? '有紀錄' : '沒有紀錄'}"></span>
      </div>`;
  }).join('');

  return `<div class="wf">${rows}</div>`;
}

/* ═══ 第二層:一個案件的儀表板 ═══ */
function dashboard(name) {
  const p = latest?.projects?.find((x) => x.name === name);
  if (!p) return `<p class="muted">找不到「${esc(name)}」這個案件。<a href="#/">回列表</a></p>`;

  return p.cards.map((c) => {
    if (c.gone) return `<div class="stat" data-tone="alert"><div class="label">資料夾不見了</div>
      <div class="sub">${esc(c.path)}</div>
      <div class="hint">這個工作區已經不在磁碟上。上面那些是舊資料,不是現在的狀態。</div></div>`;

    const sensorNote = c.sensor.state === 'ok' && c.sensor.firstSeen
      ? `感測器從 ${ago(c.sensor.firstSeen)}才開始記,在那之前發生的事情它一輩子都不會知道。`
      : '這個工作區還沒有感測器紀錄 — 可能是還沒裝,也可能是裝了還沒跑過指令。這兩種分不出來。';

    return `
      <div class="block">
        <h2 class="section serif">工地現況 · ${esc(c.branch ?? '沒有分支')}</h2>
        <p class="section-note">這三件事回答:我回得去哪裡、東西走到哪了、這次動了什麼。</p>
        <div class="stats">${statRestore(c)}${statLadder(c)}${statChanges(c)}</div>
      </div>

      <div class="block">
        <h2 class="section serif">My Agent work flow</h2>
        <p class="section-note">五個工班跑到哪了,工作進度監視。<br>
          ⚠️「跑過」不等於「通過」——感測器只看得到指令被呼叫,看不到結果。
          驗屋師傅來過,不等於房子修好了。</p>
        ${workflow(c)}
        <div class="note">${esc(sensorNote)}</div>
      </div>`;
  }).join('');
}

/* ═══ 路由 ═══ */
function route() {
  const m = location.hash.match(/^#\/p\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
function render() {
  const name = route();
  $crumb.innerHTML = name
    ? `<a href="#/">案件</a><span class="sep">/</span><span>${esc(name)}</span>`
    : `<span>案件</span>`;
  $app.innerHTML = name ? dashboard(name) : projectList();
}

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { location.hash = `#/p/${encodeURIComponent(go.dataset.go)}`; return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) {
    navigator.clipboard?.writeText(cp.dataset.copy);
    const old = cp.textContent; cp.textContent = '已複製到剪貼簿';
    setTimeout(() => { cp.textContent = old; }, 1600);
  }
});
window.addEventListener('hashchange', render);

poll();
setInterval(poll, POLL_MS);
setInterval(paintFreshness, 1000);
