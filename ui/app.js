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
const WHO = {
  A: { x: 1407, y: 139, w: 128, h: 267, alt: '建築師攤開藍圖' },
  B: { x: 2583, y: 482, w: 166, h: 242, alt: '工班在鋸木頭' },
  C: { x: 1567, y: 453, w: 213, h: 271, alt: '收尾清場,拿滾筒和油漆桶' },
  D: { x: 2245, y: 453, w: 103, h: 271, alt: '驗屋師傅拿槌子' },
  E: { x: 2240, y: 130, w: 115, h: 278, alt: '戴白色安全帽的人拿板夾巡視' },
};
const who = (id) => {
  const w = WHO[id];
  if (!w) return '';
  return `<div class="who" role="img" aria-label="${esc(w.alt)}"
    style="--x:${w.x};--y:${w.y};--w:${w.w};--h:${w.h}"></div>`;
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
    <div class="label">還原點</div>
    <div class="big">還沒有</div>
    <div class="sub">這不代表你沒有好版本,只代表還沒看過你跑檢查。</div>
    <div class="hint">在那個資料夾跑 <code>pipeline-status --checkpoint</code></div></div>`;

  const n = c.changedSince;
  const cmd = `git reset --hard ${cp.commit.slice(0, 7)}`;
  return `<div class="stat" data-tone="restore">
    <div class="label">還原點 · 你回得去哪裡</div>
    <div class="big">${esc(cp.commit.slice(0, 7))}</div>
    <div class="sub">${ago(cp.at)},這幾項檢查全綠：${esc(cp.checks.join(' / '))}<br>
      <span class="muted">⚠️ 檢查全綠不等於功能正確。</span></div>
    <div class="hint">${n ? `這是你<b>最後一個確定跑過檢查</b>的版本。之後改的 ${n} 個檔案不在裡面。`
      : '從那之後沒有任何檔案被改過。'}</div>
    <button class="copy" data-copy="${esc(cmd)}">複製回去的指令</button>
    <div class="hint">⚠️ 這個網頁<b>不會</b>幫你還原——指令複製到終端機自己貼。
      回去會丟掉還沒 commit 的東西。</div>
  </div>`;
}

function statLadder(c) {
  const L = c.ladder ?? {};
  const step = (n, ok, title, detail) =>
    `<div class="step" data-ok="${ok ? 'yes' : 'no'}"><span class="n">${n}</span>
      <span class="txt"><b>${title}</b><small>${detail}</small></span></div>`;

  const s1 = L.uncommitted === null ? step(1, false, 'commit', '問不到')
    : L.uncommitted === 0 ? step(1, true, 'commit 存進這條分支', '都存好了')
    : step(1, false, 'commit 存進這條分支', `還有 ${L.uncommitted} 個檔案沒存`);

  const s2 = L.unmerged === null ? step(2, false, 'merge 併進主線', '問不到')
    : L.onMain ? step(2, true, 'merge 併進主線', `你就在 ${esc(L.mainName ?? 'main')} 上,不用併`)
    : L.unmerged === 0 ? step(2, true, `merge 併進 ${esc(L.mainName ?? 'main')}`, '已經併進去了')
    : step(2, false, `merge 併進 ${esc(L.mainName ?? 'main')}`, `這條分支還多 ${L.unmerged} 個存檔沒併`);

  const s3 = !L.hasUpstream
    ? step(3, false, 'push 推到 GitHub', '這條分支還沒有遠端 — 只存在你這台電腦上')
    : L.unpushed === null ? step(3, false, 'push 推到 GitHub', '問不到')
    : L.unpushed === 0 ? step(3, true, 'push 推到 GitHub', '已經同步了')
    : step(3, false, 'push 推到 GitHub', `還有 ${L.unpushed} 個存檔沒推上去`);

  const allSafe = L.uncommitted === 0 && (L.onMain || L.unmerged === 0) && L.unpushed === 0;
  return `<div class="stat" data-tone="${allSafe ? 'safe' : 'alert'}">
    <div class="label">東西走到哪了</div>
    <div class="ladder">${s1}${s2}${s3}</div>
    ${L.webUrl ? `<div class="hint"><a class="ext" href="${esc(L.webUrl)}" target="_blank"
      rel="noreferrer">在 GitHub 上看這個 repo ↗</a></div>` : ''}
  </div>`;
}

function statChanges(c) {
  const f = c.files;
  if (!f) return `<div class="stat" data-tone="change"><div class="label">改了哪些檔案</div>
    <div class="big">問不到</div></div>`;
  if (!f.total) return `<div class="stat" data-tone="change"><div class="label">改了哪些檔案</div>
    <div class="big">沒有改動</div>
    <div class="sub">${c.checkpoint ? '蓋章之後' : '相對於上一個存檔'}沒有任何檔案被動過。</div></div>`;

  const groups = f.groups.map((g) => `<div class="fgroup">
      <div class="dir">${esc(g.dir)}/</div>
      <ul>${g.items.map((it) => `<li class="${it.isNew ? 'isnew' : ''}">${esc(it.name)}${
        it.isNew ? ' · 新檔案' : ''}</li>`).join('')}</ul>
    </div>`).join('');

  return `<div class="stat" data-tone="change">
    <div class="label">${c.checkpoint ? '蓋章之後改了哪些檔案' : '還沒存檔的改動'}</div>
    <div class="big">${f.total} 個檔案</div>
    ${f.newCount ? `<div class="sub">其中 ${f.newCount} 個是新建的。</div>` : ''}
    <div class="files">${groups}</div>
    ${c.scale ? `<div class="hint">參考:這個專案一次改動通常 ${c.scale.median} 個檔案,
      最多到過 ${c.scale.max} 個。</div>` : ''}
  </div>`;
}

/* ═══ 流程總覽 ═══ */
function flow(c) {
  const nodes = c.stages.map((st) => {
    const s = stageState(st);
    const when =
      s === 'notbuilt' ? '<span class="when q">這一關還沒建</span>'
      : s === 'main' ? '<span class="when q">就是你在講話的那個對話</span>'
      : s === 'done' ? `<span class="when">${ago(st.ranAt)}跑過<br>你說處理完了</span>`
      : s === 'ran' ? `<span class="when">${ago(st.ranAt)}跑過<br>還沒有人說處理完了</span>`
      : `<span class="when q">${c.sensor.state === 'ok' ? '沒有紀錄' : '感測器沒有資料'}</span>`;
    return `<div class="node" data-state="${s}" data-cur="${s === 'ran' ? 1 : 0}">
      ${who(st.id)}
      <span class="tag">${esc(st.id)} ${esc(st.name)}</span>
      ${when}</div>`;
  }).join('');

  return `<div class="flow">
    <div class="flow-line"><svg preserveAspectRatio="none" viewBox="0 0 100 2">
      <line class="base" x1="2" y1="1" x2="98" y2="1"></line>
      <line class="move" x1="2" y1="1" x2="98" y2="1"></line></svg></div>
    <div class="flow-track">${nodes}</div>
  </div>`;
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
        <h2 class="section serif">五個工班跑到哪了</h2>
        <p class="section-note">「跑過」不等於「通過」——感測器只看得到指令被呼叫,看不到結果。
          驗屋師傅來過,不等於房子修好了。</p>
        ${flow(c)}
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
