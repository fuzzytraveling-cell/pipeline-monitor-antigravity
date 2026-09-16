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
    if (!document.activeElement?.closest?.('[data-tier-form]')) safeRender();
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
// 狀態是伺服器算好的(lib/events.mjs 的 roundView):main／notbuilt／none／passed／current／done。
// 畫面上 current 沿用「ran」的樣式(亮),passed 是劃掉變淡,done 是劃掉但深色(你說處理完了)。
const stageState = (st) => st.state === 'current' ? 'ran' : (st.state ?? 'none');   // stale(結論過期,要再跑)照原樣給 CSS
/** 清單收合的狀態:key 是「工作區|關」。沒記過就是展開;記在 localStorage,重新整理也記得。畫面每幾秒重畫一次,不能靠 DOM 記 */
const FOLD_KEY = 'pm-fold';
function foldStore() { try { return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}'); } catch { return {}; } }
function foldOpen(key) { const v = foldStore()[key]; return v === undefined ? true : v === true; }
function rememberFold(key, open) { try { const all = foldStore(); all[key] = open; localStorage.setItem(FOLD_KEY, JSON.stringify(all)); } catch { /* 存不了就只記這一次 */ } }
// <details> 的 toggle 事件不會冒泡,用捕捉階段在 document 上接
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d instanceof HTMLDetailsElement && d.dataset.fold) rememberFold(d.dataset.fold, d.open);
}, true);
/** 結論說明的第一行(清單放在後面幾行) */
const noteHead = (st) => String(st.report?.note ?? '').split('\n')[0].trim();
/** B 的清單進度一句話:「3/5 對過,1 條待討論,1 條還沒對」。沒有清單就空字串 */
const clProg = (cl) => cl?.parsed ? `清單 ${cl.checked}/${cl.total} 對過${cl.pending ? `,${cl.pending} 條待討論` : ''}${cl.unmarked ? `,${cl.unmarked} 條還沒對` : ''}` : '';
/** 感測器看得到的關(有 skill 或 tools 的)。B 是你在講話的那個對話、未建的關,都不算分母。 */
const sensed = (st) => st.type !== 'main-conversation' && st.type !== 'not-built';

/** 這一輪走到哪,一句話。對話列與案件卡共用,兩邊才說同一句。 */
function roundWhere(stages) {
  const cur = (stages ?? []).find((x) => x.state === 'current' || x.state === 'done');
  if (!cur) return '這一輪還沒有紀錄';
  const tail = cur.state === 'done' ? (cur.type === 'browser' ? '（你說驗收過了）' : '（處理完了）') : '';
  return `這一輪走到 ${cur.id} ${cur.name}${tail}`;
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
  // 有章:講的是「蓋章之後改過、還沒重新檢查」——它們多半已經 commit 了,不是「還沒 commit」。
  // 以前寫「commit後還沒被檢查的檔案」,Oscar 讀成「還沒 commit 的檔案」(2026-09-15)。沒有章:講的是還沒存的改動。
  const label = cpOk(c) ? '蓋章之後改過、還沒重新檢查的檔案' : '還沒存檔（commit）的改動';
  if (!f) return `<div class="stat" data-tone="change"><h3 class="ctitle">未檢查清單</h3><div class="label">${label}</div>
    <div class="big">問不到</div></div>`;
  if (!f.total) return `<div class="stat" data-tone="change"><h3 class="ctitle">未檢查清單</h3><div class="label">${label}</div>
    <div class="big">沒有改動</div>
    <div class="sub">${cpOk(c) ? '蓋章之後' : '相對於上一個存檔'}沒有任何檔案被動過。</div></div>`;

  const groups = f.groups.map((g) => `<div class="fgroup">
      <div class="dir">${esc(g.dir)}/</div>
      <ul>${g.items.map((it) => `<li class="${it.isNew ? 'isnew' : ''}">${esc(it.name)}${
        it.isNew ? ' · 新檔案' : ''}${it.uncommitted ? ' · <b>還沒存</b>' : ''}</li>`).join('')}</ul>
    </div>`).join('');

  return `<div class="stat" data-tone="change">
    <h3 class="ctitle">未檢查清單</h3><div class="label">${label}</div>
    <div class="big"><span class="num">${f.total}</span><span class="unit">個檔案</span></div>
    ${f.uncommittedCount === null ? '<div class="sub">問不到哪些還沒存。</div>'
      : f.uncommittedCount > 0 ? `<div class="sub">其中 <b>${f.uncommittedCount} 個還沒存進保險箱（commit）</b>${f.newCount ? `,${f.newCount} 個是新建的` : ''}。</div>`
      : `<div class="sub">都已經存了（commit）${cpOk(c) ? ',只是蓋章之後改的,還沒重新檢查。要檢查：<code>pipeline-status --checkpoint</code>' : ''}。</div>`}
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
    // 收工 hook 活著沒:看心跳,不看設定——「掛著」不等於「活著」(L13)
    const gate = c.sensor?.gate?.ts ? `收工 hook 最後一次跑 ${ago(c.sensor.gate.ts)}` : '收工 hook 還沒跑過（要開新對話;一直沒跑就是沒被觸發,不是沒事）';
    return `<p class="section-note">感測器：已掛上${esc(where)} · ${esc(last)} · ${esc(gate)}</p>`;
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
    // 「被叫」的證據有兩種:你自己打的斜線指令(不經過 Skill 工具,L19)、或 Claude 自己去叫。字要跟證據一樣大:叫了,不是跑完了
    const verb = st.type === 'browser' ? `開瀏覽器跑過一輪${st.count ? `（${st.count} 個動作）` : ''}`
      : st.via === 'typed' ? `你叫了 /${esc(st.calledAs ?? '')}` : `Claude 叫了 /${esc(st.calledAs ?? st.skill ?? '')}`;
    const said = st.type === 'browser' ? '驗收過了' : '處理完了';
    // 只有驗收那一關有按鈕(五關自動結案 AC-10):其他關由儀表板自動辨識——按鈕多了會被忽略跳過(Oscar)。跟 CLI 的 --clear 同一種紀錄(source:human)
    const stamp = st.type === 'browser' && s === 'seen' && c.path
      ? `<button class="mini-btn" data-clear="${esc(st.id)}" data-proj="${esc(c.project ?? '')}" data-cwd="${esc(c.path)}">你說${said}</button>` : '';
    const status =
      // B(對話本身):改到程式檔就算在動,印最後一次改檔的時間;不數檔案——那要看 git(未檢查清單那張卡)
      st.type === 'main-conversation'
        ? (s === 'ran' ? `最後一次改程式檔 ${ago(st.ranAt)}${st.via === 'git' ? '（感測器沒看到改檔,是 git 說的——可能是用 Bash 寫的）' : ''}——現在在這一關${clProg(st.checklist) ? `（${clProg(st.checklist)}）` : ''}`
          // 清單沒對完:不劃掉,用「要處理」的樣子(AC-6)
          : s === 'stale' ? `改過程式檔（最後一次 ${ago(st.ranAt)}）,${clProg(st.checklist)}——清單沒對完,不算寫完`
          : s === 'done' ? `改過程式檔（最後一次 ${ago(st.ranAt)}）,${ago(st.doneAt)}Claude 對完清單`
          : s === 'passed' ? `改過程式檔（最後一次 ${ago(st.ranAt)}）${st.closedBy === 'checklist' ? ',Claude 對完清單' : ''}——已走過`
          : '就是你在講話的那個對話（這一輪還沒改到程式檔）')
      : s === 'notbuilt' ? '這一關還沒建'
      // A 的結案是你點頭開工(之後第一次改到程式檔):講出來,不然像是憑空劃掉的
      // 已走過的關,結論還是要講一句(誰說的、說了什麼),不然像是憑空劃掉的
      : s === 'passed' ? `${ago(st.ranAt)}${verb}${st.closedBy === 'nod' ? `,${ago(st.nodAt)}開始改程式檔,算你點頭開工了` : st.closedBy === 'claude' && noteHead(st) ? `,Claude 說：${noteHead(st)}` : st.closedBy === 'human' ? `,你說${said}` : ''}——已走過`
      // 結論會過期的關(D):之後又改了程式檔,要再跑一次(AC-9)。不劃掉、不打勾
      : s === 'stale' ? `${ago(st.ranAt)}${verb},之後又改了程式檔——要再跑一次`
      // 結案要說得出是誰說的(AC-11):Claude 記的結論、或你說(E 驗收、舊紀錄)
      : s === 'done' ? `${ago(st.ranAt)}${verb},${ago(st.doneAt ?? st.clearedAt)}${st.closedBy === 'claude' ? `Claude 說${noteHead(st) ? `：${noteHead(st)}` : '沒問題'}` : `你說${said}`}`
      : s === 'ran' ? `${ago(st.ranAt)}${verb},${st.report?.verdict === 'found' ? `Claude 說找到問題${noteHead(st) ? `：${noteHead(st)}` : ''}——還沒處理完`
          : st.type === 'browser' ? `還沒有人說${said}` : (c.stages.find((v) => v.skill)?.id === st.id ? '等你點頭開工' : 'Claude 還沒記結論')}`
      // 開過瀏覽器 ≠ 驗收過(Oscar 2026-09-15:截圖儀表板也會讓 E 亮)。講去了哪,不亮,算不算由人按
      : s === 'seen' ? `${ago(st.ranAt)}開過瀏覽器（${st.count} 個動作${st.hosts?.length ? `,去了 ${st.hosts.slice(0, 3).join('、')}` : ''}）——算不算驗收你說了算`
      // 「沒有紀錄」跟「這裡根本沒有這個指令」是兩件事——Forma Pro 沒有 /spec,那一關永遠不會有紀錄
      : st.available === false ? `找不到 /${st.skill ?? ''} 這個指令（這個專案的 .claude/ 和 ~/.claude 都沒有）`
      // 上一輪的不畫線,只講一句——線多了會干擾判斷(Oscar 2026-09-15)
      : st.prevRanAt ? `這一輪還沒跑（上一輪 ${ago(st.prevRanAt)}跑過）`
      : (c.sensor?.state === 'ok' ? '這一輪還沒跑' : '感測器沒有資料');
    const saidArgs = st.args
      ? `<div class="said">「${esc(st.args.slice(0, 90))}${st.args.length > 90 ? '…' : ''}」</div>` : '';
    // A 的清單就是規格檔裡的 AC,照檔案畫(AC-5)。解析不了就照原文、找不到就說找不到——不假裝
    // 只有 A 帶完整的清單(有 items);B 只帶進度摘要,進度已經寫在狀態列,這裡不畫——畫下去就是 undefined 的 .map(2026-09-16 實際炸過一次)
    const cl = st.checklist && Array.isArray(st.checklist.items) ? st.checklist : null;
    const clHtml = !cl ? ''
      : cl.missing ? `<div class="acl muted">清單：找不到這一輪的規格檔（${esc(String(cl.file ?? '').split('/').slice(-3).join('/'))}）</div>`
      : !cl.parsed ? `<div class="acl muted">清單：規格檔裡沒有照格式寫的 AC${cl.head ? `，開頭是：${esc(cl.head.slice(0, 80))}` : ''}</div>`
      // 可收折、預設收起(Oscar 2026-09-16):摘要一行講進度,展開才看每一條;對過的劃掉
      // 預設展開;你收起來就記住,資料每幾秒重畫一次也不會蓋掉你的選擇(Oscar 2026-09-16:一重畫就縮回去,很干擾)
      : `<details class="acl-box" data-fold="${esc(`${c.path ?? ''}|${st.id}`)}"${foldOpen(`${c.path ?? ''}|${st.id}`) ? ' open' : ''}><summary>驗收清單：${clProg(cl).replace(/^清單 /, '')}（全部 ${cl.total} 條）</summary>
        <ul class="acl">${cl.items.map((it) => `<li data-state="${esc(it.state)}"><span class="mark">${it.state === 'checked' ? '✅' : it.state === 'pending' ? '⏳' : '○'}</span>
          <span><b>${esc(it.id)}</b> ${esc(it.title)}${it.state === 'pending' && it.note ? `<span class="muted">（待討論：${esc(it.note)}）</span>` : ''}${
          it.plain ? `<div class="plain">${esc(it.plain)}</div>` : ''}</span></li>`).join('')}</ul></details>`;
    // 結論的說明有清單(多行)時,一行一條列在卡上——C 的建議、D 的發現就住在這裡
    const noteLines = String(st.report?.note ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    // 已走過的關也要列(C 已走過,它的建議還是要看得到——「有幾條就列幾條」)
    const noteHtml = noteLines.length > 1 && (s === 'done' || s === 'ran' || s === 'stale' || s === 'passed')
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
          <div class="astatus">${esc(status)}</div>
          ${saidArgs}${clHtml}${noteHtml}${stamp}
        </div>
        <span class="lamp" title="${s === 'passed' ? '已走過' : s === 'done' || s === 'ran' ? '現在這一關' : s === 'stale' ? '結論過期,要再跑一次' : s === 'seen' ? '開過瀏覽器' : '這一輪還沒跑'}"></span>
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
      <div class="ov-state">${subject ? `<div class="ov-subject">${esc(subject)}</div>` : ''}${mid.map((t) => `<div>${esc(t)}</div>`).join('')}</div>
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
    // 這一輪走到哪:現在這一關的名字,比「x/4」更像人話
    const seen = s.stages.find((x) => x.state === 'seen');
    const where = roundWhere(s.stages) + (seen ? ' · 開過瀏覽器,還沒有人說驗收過' : '');
    return `<div class="srow ${s.closedAt ? 'closed' : ''}">
      <a class="sname" href="#/p/${encodeURIComponent(p.name)}/s/${encodeURIComponent(s.id)}">
        ${esc(s.title ?? '（還沒有標題）')}</a>
      <span class="smeta">${s.prompts} 則訊息 · 最後動作 ${ago(s.lastTs)}
        · ${esc(where)}${s.sharesCwd ? ' · ⚠️ 與其他對話共用工作區' : ''}${
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

/** Claude 建議另開的對話。⚠️ 儀表板開不了對話——只能讓你複製說明、貼進新對話的第一句。 */
function suggestionsBlock(p) {
  // 已開始的直接拿掉,不劃線留著——那個對話會出現在下面的「對話」裡,留著就是同一件事出現兩次(Oscar 2026-09-15)
  const open = (p.suggestions ?? []).filter((s) => !s.dismissedAt && !s.startedBy);
  if (!open.length) return '';
  const rows = open.map((s) => {
    const firstLine = esc(s.prompt.split('\n').find((l) => l.trim()) ?? '');
    const state = `<button class="copy" data-copy="${esc(s.prompt)}">複製說明</button>
         <button class="mini-btn" data-dismiss="${esc(s.id)}" data-proj="${esc(p.name)}">不做了</button>`;
    return `<div class="srow">
      <span class="sname">${esc(s.title)}</span>
      <span class="smeta">Claude ${ago(s.ts)}建議 · ${firstLine.slice(0, 80)}${firstLine.length > 80 ? '…' : ''}</span>
      <span class="sact">${state}</span>
    </div>`;
  }).join('');
  return `<div class="block">
      <h2 class="section serif">建議新增的對話</h2>
      <p class="section-note">Claude 覺得該另開一個對話做的事。這裡開不了對話——<b>複製說明</b>，在 app 開新對話，貼進第一句。
        對話真的這樣開頭了，這張會自己拿掉（那個對話會出現在下面的「對話」裡）。</p>
      <div class="slist">${rows}</div>
    </div>`;
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
  // 工作區的資料夾已經不在了(worktree 被刪):git 那三張卡沒有東西可講,五關的紀錄還在,照畫。
  // ⚠️ 以前這裡照樣去讀 c.sensor.state → 整頁炸掉 → 被當成「斷線」(2026-09-15 Oscar 點進去就斷)。
  if (c.gone) {
    return `
    <div class="block">
      <h2 class="section serif">${esc(s.title ?? '（還沒有標題）')}</h2>
      <p class="section-note">${s.prompts} 則訊息 · 最後動作 ${ago(s.lastTs)}</p>
      <p class="section-note">⚠️ 這個對話的工作區資料夾已經不在了（${esc(s.cwd ?? '')}）——
        還原點、三階梯、改動都沒有東西可講。下面五關的紀錄還在。</p>
    </div>
    <div class="block">
      <h2 class="section serif">My Agent work flow</h2>
      ${workflow({ ...c, sensor: { state: 'ok' }, stages: s.stages })}
    </div>`;
  }

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

poll();
setInterval(poll, POLL_MS);
setInterval(paintFreshness, 1000);
