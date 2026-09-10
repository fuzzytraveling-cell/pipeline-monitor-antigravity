/**
 * app.js —— 畫面。規格:docs/進行中/pipeline-ui.md
 *
 * ⚠️ 這支唯一不能妥協的責任是 **AC-1／AC-2**:
 *    畫面必須隨時說出資料多新,斷線時必須整頁承認。
 *    判斷邏輯在 lib/freshness.mjs(純函式、被測試釘住),這裡只負責畫。
 */
import { describeFreshness } from '/freshness.mjs';

const POLL_MS = 5000;
let latest = null;          // 最後一次成功拿到的資料
let connected = false;      // 最近一次抓資料成功了嗎

const $app = document.getElementById('app');
const $fresh = document.getElementById('freshness');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** AC-1:每秒重算,不是每次抓資料才更新。這樣「幾秒前」才會自己往上跳。 */
function paintFreshness() {
  const f = describeFreshness({
    generatedAt: latest?.generatedAt ?? NaN,
    now: Date.now(),
    connected,
  });
  $fresh.textContent = f.label;
  $fresh.dataset.state = f.state;
  document.body.classList.toggle('dim', f.dim);   // 顏色只是輔助,文字才是主要載體(AC-4)
}

async function poll() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    latest = await r.json();
    connected = true;
    render();
  } catch {
    // ⚠️ AC-2:抓不到就是抓不到。**不准靜靜地停止更新然後讓舊資料看起來像現在的。**
    connected = false;
  }
  paintFreshness();
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return '時間對不上';
  if (s < 60) return `${Math.max(0, s)} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} 小時前` : `${Math.round(h / 24)} 天前`;
}

function stageLine(st, sensorState, firstSeen) {
  // 未建的關照實說「未建」——把不存在的關卡畫得像存在,本身就是假回饋
  if (st.type === 'not-built') return row('⚫', st, '未建', 'muted');
  if (st.type === 'main-conversation') return row('●', st, '就是你在講話的那個對話', 'muted');

  if (!st.ranAt) {
    // ⚠️ AC-1:感測器沒紀錄 ≠ 沒跑過。文案不准寫「沒跑過」。
    const why = sensorState === 'ok' ? '沒有紀錄' : '感測器沒有資料';
    return row('⚪', st, why, 'muted');
  }
  // ⚠️ AC-3:「跑過」永遠不准畫成 ✅。只有人親口說處理完了才算結案。
  return st.clearedAt
    ? row('✅', st, `${ago(st.ranAt)}跑過,${ago(st.clearedAt)}你說處理完了`, '')
    : row('⏸', st, `${ago(st.ranAt)}跑過,還沒有人說處理完了`, 'warn');
}
const row = (mark, st, text, cls) =>
  `<div class="stage"><span class="mark">${mark}</span>` +
  `<span class="id">${esc(st.id)} ${esc(st.name)}</span>` +
  `<span class="${cls}">${esc(text)}</span></div>`;

function card(c) {
  if (c.gone) {
    return `<div class="card gone"><div class="branch">資料夾不見了</div>
      <div class="muted">${esc(c.path)}</div>
      <div class="note">這個 worktree 已經不在磁碟上了。上面那些是舊資料,不是現在的狀態。</div></div>`;
  }
  const cp = c.checkpoint;
  const rows = [];

  rows.push(cp
    ? line('還原點', `${esc(cp.commit.slice(0, 7))} · ${ago(cp.at)}檢查全綠（${esc(cp.checks.join(' / '))}）`, 'accent')
    : line('還原點', '還沒有 — 這不代表你沒有好版本,只代表還沒看過你跑檢查', 'muted'));

  if (cp) {
    rows.push(c.changedSince === null ? line('之後', '問不到', 'muted')
      : c.changedSince === 0 ? line('之後', '沒有任何檔案被改過', '')
      : line('之後', `${c.changedSince} 個檔案被改過,這些沒有被檢查過`, 'warn'));
  }
  rows.push(c.dirty === null ? line('未存檔', '問不到', 'muted')
    : c.dirty === 0 ? line('未存檔', '全部都存進保險箱了', '')
    : line('未存檔', `${c.dirty} 個檔案還沒 git commit`, 'warn'));

  if (c.health?.files) {
    const extra = c.health.newFiles ? `（其中 ${c.health.newFiles} 個是新檔案）` : '';
    // ⚠️ AC-8:只報數字,不給百分比、不給進度條。比例尺來自這個專案自己的歷史。
    const scale = c.scale ? ` · 這個專案平常 ${c.scale.median} 個,最多到過 ${c.scale.max} 個` : '';
    rows.push(line('這次改動', `${c.health.files} 個檔案${extra}${scale}`, ''));
    if (c.health.newDeps?.length) rows.push(line('新增相依', c.health.newDeps.join(', '), 'warn'));
    if (c.health.modifiedTests?.length)
      rows.push(line('既有測試', `${c.health.modifiedTests.length} 個被改過`, 'warn'));
  }

  const stages = c.stages.map((s) => stageLine(s, c.sensor.state, c.sensor.firstSeen)).join('');
  const sensorNote = c.sensor.state === 'ok' && c.sensor.firstSeen
    ? `感測器從 ${ago(c.sensor.firstSeen)}才開始記,在那之前發生的事情它一輩子都不會知道。`
    : '這個專案還沒有感測器紀錄 — 可能是還沒裝,也可能是裝了還沒跑過指令。這兩種分不出來。';

  return `<div class="card">
    <div class="branch">${esc(c.branch ?? '（沒有分支）')}</div>
    ${rows.join('')}
    <div style="margin-top:14px">${stages}</div>
    <div class="note">${esc(sensorNote)}<br>
      「跑過」不等於「通過」— 感測器只看得到指令被呼叫,看不到結果。</div>
  </div>`;
}
const line = (k, v, cls) =>
  `<div class="row"><span class="k">${esc(k)}</span><span class="v ${cls}">${esc(v)}</span></div>`;

function render() {
  if (!latest?.projects?.length) {
    $app.innerHTML = `<p class="muted">還沒有任何專案的資料。<br>
      在一個 git 專案裡跑 <code>pipeline-status --checkpoint</code> 就會出現。</p>`;
    return;
  }
  $app.innerHTML = latest.projects.map((p) => `
    <section class="project">
      <h2>${esc(p.name)}</h2>
      <div class="cards">${p.cards.map(card).join('')}</div>
    </section>`).join('');
}

poll();
setInterval(poll, POLL_MS);
setInterval(paintFreshness, 1000);   // AC-1:秒數自己跳,不等下一次抓資料
