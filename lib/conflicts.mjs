/**
 * conflicts.mjs —— 多 worktree 並發改動衝突偵測的單一真相來源。
 * 規格：worktree-conflict-detection（路徑看 AGENTS.md 的表）
 *
 * ⚠️ 零額外 git 呼叫：只消費 collect.mjs／cliFacts.mjs 已經算好的 cards 與 sessions（P2）。
 * ⚠️ 三條紅線：
 *   R1 任一可能參與的工作區問不到改動、問不到未存檔、看不全已存改動、或蓋章後仍有未併主線存檔 → 明講衝突檢查不全。
 *   R2 全部問得到且沒有重疊時安靜不顯示，絕不貼「無衝突／安全」綠燈或打勾（P10）。
 *   P1/P12/P13 先依 real(root ?? path) 去重並排除已刪／非 git／已結案無未存／main 併入檔；只對 health.list 跑 unquotePath。
 */
import { real, unquotePath } from './git.mjs';
import { zhEn, plural } from './lang.mjs';

/**
 * 檔名過多時沿用「前 3 支＋等 N 支檔」口徑（與 tier.mjs／todo.mjs 相同節奏，不洗版）。
 */
function fewFiles(files) {
  const n = files.length;
  return zhEn(
    `${files.slice(0, 3).join('、')}${n > 3 ? ` 等 ${n} 支檔` : ''}`,
    `${files.slice(0, 3).join(', ')}${n > 3 ? ` and others (${plural(n, 'file')})` : ''}`,
  );
}

/** 串起多個參與工作區名稱：2 個用「與／and」、3 個以上用頓號／牛津逗號。 */
function joinWho(labels) {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return zhEn(`${labels[0]} 與 ${labels[1]}`, `${labels[0]} and ${labels[1]}`);
  return zhEn(
    `${labels.slice(0, -1).join('、')} 與 ${labels.at(-1)}`,
    `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`,
  );
}

function emptyResult() {
  return { overlaps: [], incomplete: [], incompleteLines: [], items: [], participantKeys: [] };
}

function cardScore(card, key) {
  return (real(card.path ?? '') === key ? 4 : 0)
    + (Array.isArray(card.health?.list) ? 2 : 0)
    + (Array.isArray(card.dirtyFiles) ? 1 : 0);
}

function latestTsOf(list) {
  let max = 0;
  for (const s of list) {
    const t = Date.parse(s?.lastTs ?? '');
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

function sortSessionsNewest(list) {
  return [...list].sort((a, b) => (Date.parse(b?.lastTs ?? '') || 0) - (Date.parse(a?.lastTs ?? '') || 0));
}

/**
 * 組裝給人看的參與工作區標籤：絕不印出 null／undefined，也絕不在無標題時重複印兩次分支名（預審 #7）。
 */
function participantLabel({ card, openSessions, closedSessions, dirty }) {
  const branch = typeof card.branch === 'string' && card.branch.trim() ? card.branch.trim() : null;
  if (openSessions.length > 0) {
    const s0 = openSessions[0];
    const title = typeof s0.title === 'string' && s0.title.trim() ? s0.title.trim() : null;
    if (title) {
      const more = openSessions.length > 1
        ? zhEn(` 等 ${openSessions.length} 個對話`, ` and ${openSessions.length - 1} more`)
        : '';
      return branch
        ? zhEn(`「${title}」${more}（${branch}）`, `"${title}"${more} (${branch})`)
        : zhEn(`「${title}」${more}`, `"${title}"${more}`);
    }
    if (branch) {
      return openSessions.length > 1
        ? zhEn(`${branch}（等 ${openSessions.length} 個對話）`, `${branch} (${plural(openSessions.length, 'conversation')})`)
        : branch;
    }
    const more = openSessions.length > 1
      ? zhEn(` 等 ${openSessions.length} 個對話`, ` and ${openSessions.length - 1} more`)
      : '';
    return zhEn(`（還沒有標題）${more}`, `(no title yet)${more}`);
  }
  if (closedSessions.length > 0) {
    const s0 = closedSessions[0];
    const title = typeof s0.title === 'string' && s0.title.trim() ? s0.title.trim() : null;
    const note = dirty === null
      ? zhEn('已結案、問不到有無未存檔', 'closed, couldn\'t check uncommitted files')
      : zhEn('已結案但仍有未存改動', 'closed with uncommitted changes');
    if (title) {
      const br = branch ? zhEn(`${branch}，`, `${branch}, `) : '';
      return zhEn(`「${title}」（${br}${note}）`, `"${title}" (${br}${note})`);
    }
    const head = branch ?? zhEn('（還沒有標題）', '(no title yet)');
    return zhEn(`${head}（${note}）`, `${head} (${note})`);
  }
  const note = dirty === null
    ? zhEn('無對話紀錄、問不到有無未存檔', 'no conversation record, couldn\'t check uncommitted files')
    : zhEn('無對話紀錄但仍有未存改動', 'no conversation record, has uncommitted changes');
  const head = branch ?? card.path;
  return zhEn(`${head}（${note}）`, `${head} (${note})`);
}

function incompleteBucket(reason) {
  return reason === 'unreadable' || reason === 'dirty-unknown' ? 'cant-check' : reason;
}

function incompleteSentence(bucket, who) {
  if (bucket === 'cant-check') {
    return zhEn(
      `⚠️ 有工作區問不到改動，衝突檢查不全（${who}）`,
      `⚠️ Couldn't check changes in some workspaces, so conflict detection is incomplete (${who})`,
    );
  }
  if (bucket === 'blind') {
    return zhEn(
      `⚠️ 有工作區看不全已存改動（只看得到未存檔），衝突檢查不全（${who}）`,
      `⚠️ Can't see all committed changes in some workspaces (only uncommitted files are visible), so conflict detection is incomplete (${who})`,
    );
  }
  if (bucket === 'checkpoint-unmerged-unknown') {
    return zhEn(
      `⚠️ 有工作區僅比對蓋章後的改動，問不到有沒有未併回主線的存檔，衝突檢查不全（${who}）`,
      `⚠️ Some workspaces are only compared since their last stamp and couldn't check whether there are commits not merged into the main line, so conflict detection is incomplete (${who})`,
    );
  }
  return zhEn(
    `⚠️ 有工作區僅比對蓋章後的改動，尚有未併回主線的存檔未納入比對，衝突檢查不全（${who}）`,
    `⚠️ Some workspaces are only compared since their last stamp and still have commits not merged into the main line, so conflict detection is incomplete (${who})`,
  );
}

function buildIncompleteLines(incomplete) {
  const buckets = new Map();
  for (const item of incomplete) {
    const b = incompleteBucket(item.reason);
    if (!buckets.has(b)) buckets.set(b, new Map());
    if (!buckets.get(b).has(item.key)) buckets.get(b).set(item.key, item.label);
  }
  const out = [];
  for (const b of ['cant-check', 'blind', 'checkpoint-unmerged', 'checkpoint-unmerged-unknown']) {
    const map = buckets.get(b);
    if (!map || !map.size) continue;
    const keys = [...map.keys()];
    const labels = [...map.values()];
    out.push({ reason: b, keys, text: incompleteSentence(b, joinWho(labels)) });
  }
  return out;
}

/**
 * 偵測同一專案底下多個工作區之間的檔案改動交集與檢查不全狀態。
 * 完全純函式，直接吃 collect.mjs 已組裝好的 cards 與 sessions，不執行任何 git 指令。
 */
export function detectConflicts({ cards = [], sessions = [] } = {}) {
  const cardByKey = new Map();
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c || c.gone || c.notGit || !c.path) continue;
    const key = real(c.root ?? c.path);
    const prev = cardByKey.get(key);
    if (!prev || cardScore(c, key) > cardScore(prev, key)) cardByKey.set(key, c);
  }
  if (cardByKey.size < 2) return emptyResult();

  const sessByKey = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    // 已換給別人的舊對話（movedOn）不能再掛回這個工作區，以免掛出舊租戶標題（預審 #7）
    if (!s || s.movedOn) continue;
    const raw = s.card?.root ?? s.card?.path ?? s.cwd;
    if (!raw) continue;
    const key = real(raw);
    if (!cardByKey.has(key)) continue;
    if (!sessByKey.has(key)) sessByKey.set(key, { open: [], closed: [] });
    const box = sessByKey.get(key);
    if (s.closedAt) box.closed.push(s);
    else box.open.push(s);
  }

  const participants = [];
  for (const [key, card] of cardByKey) {
    const box = sessByKey.get(key) ?? { open: [], closed: [] };
    const openSessions = sortSessionsNewest(box.open);
    const closedSessions = sortSessionsNewest(box.closed);
    // dirtyFiles 來自 git status -z（已去引號），若傳了 dirty===0 且沒帶陣列視為無未存檔；若 dirty>0 卻沒陣列視為問不到（R1）
    const dirtyFiles = Array.isArray(card.dirtyFiles) ? card.dirtyFiles
      : card.dirty === 0 && card.dirtyFiles !== null ? [] : null;
    const dirty = typeof card.dirty === 'number' ? card.dirty
      : card.dirty === null || card.dirtyFiles === null ? null
      : dirtyFiles ? dirtyFiles.length : null;
    const active = openSessions.length > 0;
    if (!active && dirty !== null && dirty <= 0) continue;

    const label = participantLabel({ card, openSessions, closedSessions, dirty });
    const fileSet = new Set();
    let reason = null;

    if (active) {
      if (card.hasCommits === false) {
        if (dirty === null || !Array.isArray(dirtyFiles)) reason = 'dirty-unknown';
        else for (const f of dirtyFiles) fileSet.add(f);
      } else {
        if (Array.isArray(card.health?.list)) {
          // health.list 來自 git diff / ls-files，可能帶有 C 語言引號跳脫；只對它做 unquotePath（預審 #1）
          for (const f of card.health.list) fileSet.add(unquotePath(f));
        }
        if (Array.isArray(dirtyFiles)) {
          for (const f of dirtyFiles) fileSet.add(f);
        }
        if (!Array.isArray(card.health?.list)) reason = 'unreadable';
        else if (dirty === null || !Array.isArray(dirtyFiles)) reason = 'dirty-unknown';
        else if (card.scope?.blind === true || (card.base?.kind === 'head' && card.base?.why !== 'no-commits')) reason = 'blind';
        else if (card.base?.kind === 'checkpoint' && !card.ladder?.onMain) {
          if (!Number.isFinite(card.ladder?.unmerged)) reason = 'checkpoint-unmerged-unknown';
          else if (card.ladder.unmerged > 0) reason = 'checkpoint-unmerged';
        }
      }
    } else {
      // 已結案或僅有還原點工作區只依未存檔參與，不誤觸活躍工作區的 blind／checkpoint-unmerged（預審 #4）
      if (dirty === null || !Array.isArray(dirtyFiles)) reason = 'dirty-unknown';
      else for (const f of dirtyFiles) fileSet.add(f);
    }

    participants.push({
      key,
      active,
      lastTs: Math.max(latestTsOf(openSessions), latestTsOf(closedSessions)),
      label,
      files: fileSet,
      reason,
    });
  }

  // 必須先去重並篩選完再判 >= 2，單一參與工作區不跳跨工作區檢查不全（預審 #7）
  if (participants.length < 2) return emptyResult();

  participants.sort((a, b) => Number(b.active) - Number(a.active) || b.lastTs - a.lastTs || a.key.localeCompare(b.key));
  const byKey = new Map(participants.map((p) => [p.key, p]));
  const order = new Map(participants.map((p, i) => [p.key, i]));

  const fileOwners = new Map();
  for (const p of participants) {
    for (const f of p.files) {
      if (!fileOwners.has(f)) fileOwners.set(f, []);
      fileOwners.get(f).push(p.key);
    }
  }

  const groups = new Map();
  for (const [file, keys] of fileOwners) {
    if (keys.length < 2) continue;
    const sortedKeys = [...keys].sort((a, b) => order.get(a) - order.get(b));
    const gk = sortedKeys.join('\0');
    if (!groups.has(gk)) groups.set(gk, { keys: sortedKeys, files: [] });
    groups.get(gk).files.push(file);
  }

  const overlaps = [...groups.values()]
    .map((g) => {
      const files = [...g.files].sort();
      const labels = g.keys.map((k) => byKey.get(k).label);
      const who = joinWho(labels);
      const few = fewFiles(files);
      const line = zhEn(
        `⚠️ 檔案重疊：${who}都動到 ${few}`,
        `⚠️ Overlapping edits: ${who} ${g.keys.length === 2 ? 'both' : 'all'} touched ${few}`,
      );
      return { keys: g.keys, labels, files, line };
    })
    .sort((a, b) => b.keys.length - a.keys.length || order.get(a.keys[0]) - order.get(b.keys[0]) || b.files.length - a.files.length);

  const incomplete = participants
    .filter((p) => p.reason !== null)
    .map((p) => ({ key: p.key, label: p.label, reason: p.reason }));
  const incompleteLines = buildIncompleteLines(incomplete);

  const items = [
    ...overlaps.map((o) => ({ kind: 'ask', text: o.line, keys: o.keys })),
    ...incompleteLines.map((l) => ({ kind: 'unknown', text: l.text, reason: l.reason, keys: l.keys })),
  ];

  return {
    overlaps,
    incomplete,
    incompleteLines,
    items,
    participantKeys: participants.map((p) => p.key),
  };
}

/**
 * 篩出屬於單一工作區（對話頁與 agy-pipeline）的衝突與檢查不全訊息，與專案層級共用完全同一批句子（P2）。
 */
export function conflictsForWorktree(projectConflicts, worktreeKey) {
  if (!projectConflicts || !worktreeKey) return emptyResult();
  const key = real(worktreeKey);
  const participantKeys = projectConflicts.participantKeys ?? [];
  if (!participantKeys.includes(key)) return emptyResult();

  const overlaps = (projectConflicts.overlaps ?? []).filter((o) => o.keys.includes(key));
  const incomplete = projectConflicts.incomplete ?? [];
  const incompleteLines = projectConflicts.incompleteLines ?? [];
  const items = [
    ...overlaps.map((o) => ({ kind: 'ask', text: o.line, keys: o.keys })),
    ...incompleteLines.map((l) => ({ kind: 'unknown', text: l.text, reason: l.reason, keys: l.keys })),
  ];

  return {
    overlaps,
    incomplete,
    incompleteLines,
    items,
    participantKeys,
  };
}
