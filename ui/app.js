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
async function poll() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    latest = await r.json(); connected = true;
    // 使用者正在分級表單裡打理由時,這一輪不重畫——重畫會把打到一半的字洗掉(2026-09-13 實測)。資料照抓,下一輪再畫。
    if (!document.activeElement?.closest?.('[data-tier-form]')) render();
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
  st.archivedAt ? 'archived' :          // 上一輪(蓋章前)的紀錄:劃掉,這一輪不用再看
  st.clearedAt ? 'done' : st.ranAt ? 'ran' : 'none';
/** 感測器看得到的關(有 skill 或 tools 的)。B 是你在講話的那個對話、未建的關,都不算分母。 */
const sensed = (st) => st.type !== 'main-conversation' && st.type !== 'not-built';

/* ═══ 第一層:案件列表 ═══ */
function projectList() {
  if (!latest?.projects?.length) {
    return `<p class="muted">還沒有任何案件。<br>在一個 git 專案裡跑
      <code>pipeline-status --checkpoint</code> 就會出現在這裡。</p>`;
  }
  const cards = latest.projects.map((p) => {
    // 挑一張還在的卡講(失效的舊章會留下一張「資料夾不見了」的卡)
    const c = p.cards.find((x) => !x.gone && !x.notGit) ?? p.cards[0];
    const mini = (c?.stages ?? []).filter(sensed)
      .map((s) => `<span data-s="${stageState(s)}"></span>`).join('');
    const cp = c?.checkpoint;
    return `<button class="pcard" data-go="${esc(p.name)}">
      <h3>${esc(p.displayName ?? p.name)}</h3>
      <div class="mini">${mini}</div>
      <div class="meta">${(p.sessions ?? []).filter((s) => !s.closedAt).length} 個進行中的對話 ·
        ${!cp ? '還沒有還原點' : cpOk(c) ? `還原點 ${ago(cp.at)}` : '還原點失效'}${
        p.optedOut ? ' · 已退出記錄' : ''}</div>
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
  if (!cp) return `<div class="stat" data-tone="restore">
    <h3 class="ctitle">還原點</h3><div class="label">你回得去哪裡</div>
    <div class="big">還沒有</div>
    <div class="sub">這不代表你沒有好版本,只代表還沒看過你跑檢查。</div>
    <div class="hint">在那個資料夾跑 <code>pipeline-status --checkpoint</code></div></div>`;

  // ⚠️ L14:章指的版本不在這條分支上(歷史被改寫過)時,這張卡**不給**回去的指令。
  //    2026-09-11 主資料夾就是這樣:章指著清歷史之前的版本,複製回去會跳到另一條歷史。
  const rel = c.checkpointRelation;
  if (!cpOk(c)) {
    const why = rel?.state === 'gone' ? '它指的版本已經不存在了。'
      : rel?.state === 'off-branch' ? '它指的版本不在目前這條分支的歷史上（歷史被改寫過，或分支換過）。'
      : '問不到它跟現在的版本是什麼關係。';
    return `<div class="stat" data-tone="restore">
    <h3 class="ctitle">還原點</h3><div class="label">你回得去哪裡</div>
    <div class="big">失效</div>
    <div class="sub">${ago(cp.at)}蓋的章已經不能用：${esc(why)}</div>
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
    <div class="hint">上面這幾項當時全綠。<span class="muted">⚠️ 檢查全綠不等於功能正確。</span></div>
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

function statChanges(c) {
  const f = c.files;
  // 「commit 後還沒被檢查」預設了有一個能用的章;沒有章(或章失效)時,這張卡講的是「還沒存檔的改動」
  const label = cpOk(c) ? 'commit後還沒被檢查的檔案' : '還沒存檔的改動';
  if (!f) return `<div class="stat" data-tone="change"><h3 class="ctitle">未檢查清單</h3><div class="label">${label}</div>
    <div class="big">問不到</div></div>`;
  if (!f.total) return `<div class="stat" data-tone="change"><h3 class="ctitle">未檢查清單</h3><div class="label">${label}</div>
    <div class="big">沒有改動</div>
    <div class="sub">${cpOk(c) ? '蓋章之後' : '相對於上一個存檔'}沒有任何檔案被動過。</div></div>`;

  const groups = f.groups.map((g) => `<div class="fgroup">
      <div class="dir">${esc(g.dir)}/</div>
      <ul>${g.items.map((it) => `<li class="${it.isNew ? 'isnew' : ''}">${esc(it.name)}${
        it.isNew ? ' · 新檔案' : ''}</li>`).join('')}</ul>
    </div>`).join('');

  return `<div class="stat" data-tone="change">
    <h3 class="ctitle">未檢查清單</h3><div class="label">${label}</div>
    <div class="big"><span class="num">${f.total}</span><span class="unit">個檔案</span></div>
    ${f.newCount ? `<div class="sub">其中 ${f.newCount} 個是新建的。</div>` : ''}
    <div class="files">${groups}</div>
    ${c.scale ? `<div class="hint">參考:這個專案一次改動通常 ${c.scale.median} 個檔案,
      最多到過 ${c.scale.max} 個。</div>` : ''}
  </div>`;
}

/* ═══ 分級:伺服器(lib/tier.mjs)算好,這裡只畫。跟終端機的 describeTier 說同一句話。 ═══ */
function statTier(c, p) {
  const t = c.tier;
  if (!t) return '';
  const card = (tone, big, sub, extra = '') => `<div class="stat" data-tone="${tone}">
    <h3 class="ctitle">分級</h3><div class="label">這次要多小心</div>
    <div class="big">${big}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${extra}</div>`;
  const hint = '在這個專案的對話裡說「<b>幫我設定分級</b>」，Claude 會提清單給你確認；不需要的話說「這個專案不用分級」。';
  // ⚠️ 沒設定 ≠ T0(R1);讀不懂 ≠ 沒設定。四種各自一張臉。
  if (t.state === 'unset') return card('change', '還沒設定', hint);
  if (t.state === 'off') return card('change', '不分級',
    `你${t.off?.at ? ago(t.off.at) : ''}說這個專案不用分級${t.off?.why ? `（${esc(t.off.why)}）` : ''}。要恢復：<code>pipeline-status --tier-init</code>`);
  if (t.state === 'broken') return card('alert', '讀不懂', `分級設定讀不懂：${esc(t.why ?? '')}。為了不亂分，這次不分級。`);
  if (t.state === 'no-base') return card('change', '沒有基準', '這個專案還沒有任何 commit，沒有基準可以算「這次改動」。先 git commit 一次。');
  if (t.state === 'unknown') return card('change', '問不到', '問不到改動，分不了級。');
  const emptyWarn = t.dangerEmpty
    ? `<div class="hint">⚠️ 危險清單是空的，所以永遠不會出現 ${esc(t.levels?.danger?.id ?? '第三級')}。在對話裡說「幫我設定分級」可以補。</div>` : '';
  if (t.state === 'no-change') return card('safe', '沒有改動', '這次沒有改動，沒有東西要分級。', emptyWarn);

  const { machine, manual, final } = t;
  const dh = machine.hits.danger;
  const why = machine.rank === 2 ? `碰到危險清單：${dh.slice(0, 3).map(esc).join('、')}${dh.length > 3 ? `…共 ${dh.length} 個` : ''}`
    : machine.rank === 1 ? `碰到程式區 ${machine.hits.code.length} 個檔` : '沒碰到程式區';
  const sub = manual
    ? `機器算 ${esc(machine.id)}（${why}），<b>你說 ${esc(manual.id)}</b>（理由：${esc(manual.why)}）· ${ago(manual.ts)}`
    : why;
  // ✅ 只代表「有紀錄而且你說處理完了」;⏸ 有紀錄沒結案;⚠️ 沒有紀錄;❔ 問不到／不適用。沒有「通過」這種狀態(R2)。
  const reqs = t.requirements.length
    ? `<ul class="reqs">${t.requirements.map((r) => {
        const mark = r.state === 'ok' ? '✅' : r.state === 'ran' ? '⏸' : r.state === 'missing' ? '⚠️' : '❔';
        return `<li data-state="${r.state}">${mark} ${esc(r.label)}：${r.ts ? ago(r.ts) : ''}${esc(r.detail)}</li>`;
      }).join('')}</ul>`
    : '';
  const cand = t.candidates.length
    ? `<div class="hint">⚠️ 這次動到的檔案裡，有 ${t.candidates.length} 個名字像會存東西、但不在危險清單：${
        t.candidates.slice(0, 3).map(esc).join('、')}。只是提醒，改錯會靜默丟資料的話再加進去。</div>` : '';
  const ignored = t.manualIgnored
    ? `<div class="hint">你${ago(t.manualIgnored.ts)}說的 ${esc(t.manualIgnored.id)} 沒有比機器算的高，不採用。</div>` : '';
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
    `${reqs}${ignored}${emptyWarn}${cand}
    <div class="hint muted">為了程式碼安全，分級只能往上調。</div>${control}`);
}

/** 感測器那一行(誠實修補 D3):「掛在哪」看設定,「活著嗎」看紀錄。跟終端機版說同一句話。 */
function sensorLine(c) {
  const m = c.sensor?.mount, seen = c.sensor?.lastSeen;
  const last = seen ? `最後一筆來自這裡的紀錄：${ago(seen)}` : '還沒有來自這裡的紀錄';
  if (m?.state === 'broken') {
    // ⚠️ 最危險的一種:設定看起來好好的,紀錄卻安靜地停了(LESSONS L13)。終端機講了,網頁以前沒講。
    return `<p class="section-note">🔴 感測器掛著,但它指向的檔案不存在——<b>紀錄已經停了,而且不會有任何徵兆</b>${
      seen ? `（${esc(last)}）` : ''}。修法：在那個資料夾跑 <code>pipeline-status --on</code>。</p>`;
  }
  if (m?.state === 'ok') {
    const where = m.where === 'main' ? '（用的是主資料夾的設定）' : m.where === 'user' ? '（用的是帳號層級的設定）' : '';
    return `<p class="section-note">感測器：已掛上${esc(where)} · ${esc(last)}</p>`;
  }
  // 設定裡找不到、紀錄裡卻有 → 它在記。證據在手上時不准說「沒掛上」(R1)。
  if (seen) return `<p class="section-note">感測器：設定裡找不到,但 ${esc(ago(seen))}還有來自這裡的紀錄——它在記,只是不知道是哪份設定在做。</p>`;
  return `<p class="section-note">感測器：沒掛上。在那個資料夾跑 <code>pipeline-status --on</code>。</p>`;
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
    // 瀏覽器那一關記的是「開了瀏覽器做動作」——12 個動作不等於驗收通過,文案只講跑過
    const verb = st.type === 'browser' ? `開瀏覽器跑過一輪${st.count ? `（${st.count} 個動作）` : ''}` : '跑過';
    const status =
      s === 'notbuilt' ? '這一關還沒建'
      : s === 'main' ? '就是你在講話的那個對話'
      : s === 'archived' ? `${ago(st.ranAt)}${verb}——上一輪的,${ago(st.archivedAt)}蓋章時已經檢查過`
      : s === 'done' ? `${ago(st.ranAt)}${verb},你說處理完了`
      : s === 'ran' ? `${ago(st.ranAt)}${verb},還沒有人說處理完了`
      // 「沒有紀錄」跟「這裡根本沒有這個指令」是兩件事——Forma Pro 沒有 /spec,那一關永遠不會有紀錄
      : st.available === false ? `找不到 /${st.skill ?? ''} 這個指令（這個專案的 .claude/ 和 ~/.claude 都沒有）`
      : (c.sensor.state === 'ok' ? '沒有紀錄' : '感測器沒有資料');
    const said = st.args
      ? `<div class="said">「${esc(st.args.slice(0, 90))}${st.args.length > 90 ? '…' : ''}」</div>` : '';

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
          <div class="astatus">${esc(status)}</div>
          ${said}
        </div>
        <span class="lamp" title="${s === 'archived' ? '上一輪' : s === 'done' || s === 'ran' ? '有紀錄' : '沒有紀錄'}"></span>
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
  // 一個案件可能有好幾張卡(主資料夾＋worktree),有些已經不在了。中間那格挑一張**還在**的講,
  // 不然一個失效的舊章會讓整個案件看起來像「資料夾不見了」
  const card = p.cards.find((c) => !c.gone && !c.notGit) ?? p.cards[0];

  const chip = (s) => `<a class="ochip" href="#/p/${encodeURIComponent(p.name)}/s/${encodeURIComponent(s.id)}">
      <span class="odot"></span>${esc((s.title ?? '（還沒有標題）').slice(0, 22))}</a>`;

  // ⚠️ 資料夾不見了的卡沒有任何數字——不能拿 undefined 印成「都存好了」(R1)
  const mid = card?.gone ? ['那個資料夾已經不在了'] : card?.notGit ? ['這個資料夾不是 git 專案'] : card ? [
    card.ladder?.uncommitted === null ? '問不到有沒有沒存的檔案'
      : card.ladder?.uncommitted ? `${card.ladder.uncommitted} 個檔案沒存` : '都存好了',
    !card.checkpoint ? '還沒有還原點' : cpOk(card) ? `還原點 ${ago(card.checkpoint.at)}` : '還原點失效',
    card.files?.total ? `${card.files.total} 個檔案還沒檢查` : '沒有待檢查的檔案',
  ] : ['還沒有資料'];

  return `<div class="ov">
    <div class="ov-col">
      <div class="ov-h">正在跑的對話</div>
      ${live.length ? live.map(chip).join('') : '<div class="muted">沒有進行中的對話</div>'}
    </div>
    <div class="ov-mid">
      <div class="ov-hub"><span></span><span></span><span></span></div>
      <div class="ov-state">${mid.map((t) => `<div>${esc(t)}</div>`).join('')}</div>
    </div>
    <div class="ov-col ov-right">
      <div class="ov-h">已結案</div>
      ${done.length ? done.map(chip).join('') : '<div class="muted">還沒有結案的對話</div>'}
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
    return `<div class="block"><p class="muted">這個案件還沒有任何對話紀錄。<br>
      在那個資料夾跑 <code>pipeline-status --on</code> 掛上感測器,
      之後的對話就會出現在這裡。</p></div>`;
  }
  const row = (s) => {
    const ran = s.stages.filter((x) => x.ranAt && !x.archivedAt).length;   // 上一輪的不算這一輪的紀錄
    const total = s.stages.filter(sensed).length;   // E 接上瀏覽器之後也算分母(A/C/D/E)
    return `<div class="srow ${s.closedAt ? 'closed' : ''}">
      <a class="sname" href="#/p/${encodeURIComponent(p.name)}/s/${encodeURIComponent(s.id)}">
        ${esc(s.title ?? '（還沒有標題）')}</a>
      <span class="smeta">${s.prompts} 則訊息 · 最後動作 ${ago(s.lastTs)}
        · 五關有紀錄 ${ran}/${total}${s.sharesCwd ? ' · ⚠️ 與其他對話共用工作區' : ''}</span>
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
    </div>` + sessionList(p);
}

/** 退出記錄／重新加入。plugin 每個專案都會記,「不要記這個」靠主資料夾的一個記號檔——按下去馬上生效。 */
function optOutLine(p) {
  if (!p.mainRoot) return '';
  if (p.optedOut) {
    return `<p class="section-note">這個專案已退出記錄${p.optedOut.at ? `（${esc(ago(p.optedOut.at))}）` : ''}。之前的紀錄還在。
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
  const c = s.card;
  if (!c) return `<p class="muted">這個對話的工作區找不到了（${esc(s.cwd ?? '?')}）。</p>`;

  const warn = s.sharesCwd
    ? `<p class="section-note">⚠️ 這個工作區還有別的對話在用,所以下面的 git 狀態是**共用的**——
       不是這個對話獨有。</p>` : '';

  return `
    <div class="block">
      <h2 class="section serif">${esc(s.title ?? '（還沒有標題）')}</h2>
      <p class="section-note">${esc(c.branch ?? '沒有分支')} · ${s.prompts} 則訊息 ·
        最後動作 ${ago(s.lastTs)}${s.closedAt ? ` · 已於 ${ago(s.closedAt)}結案` : ''}</p>
      ${warn}
      <div class="stats">${statRestore(c)}${statLadder(c)}${statChanges(c)}${statTier(c, p)}</div>
    </div>
    <div class="block">
      <h2 class="section serif">My Agent work flow</h2>
      <p class="section-note">五個工班跑到哪了,工作進度監視。<br>
        ⚠️「跑過」不等於「通過」——感測器只看得到指令被呼叫,看不到結果。</p>
      ${sensorLine(c)}
      ${workflow({ ...c, stages: s.stages })}
    </div>`;
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
    $app.innerHTML = projectList();
  } else if (r.view === 'project') {
    // 路由用的是檔名(safeName 過的);麵包屑給人看,要用真的資料夾名
    const p = latest?.projects?.find((x) => x.name === r.project);
    $crumb.innerHTML = link('#/', '案件') + `<span>${esc(p?.displayName ?? r.project)}</span>`;
    $app.innerHTML = projectPage(r.project);
  } else {
    const p = latest?.projects?.find((x) => x.name === r.project);
    const s = p?.sessions.find((x) => x.id === r.session);
    $crumb.innerHTML = link('#/', '案件')
      + link(`#/p/${encodeURIComponent(r.project)}`, p?.displayName ?? r.project)
      + `<span>${esc((s?.title ?? '對話').slice(0, 20))}</span>`;
    $app.innerHTML = sessionPage(r.project, r.session);
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
window.addEventListener('hashchange', render);

poll();
setInterval(poll, POLL_MS);
setInterval(paintFreshness, 1000);
