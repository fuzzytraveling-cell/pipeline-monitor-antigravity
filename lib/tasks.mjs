/**
 * tasks.mjs —— 誠實任務板（規格：honest-task-board-director-dispatch AC-1、AC-2）
 *
 * 專案只在主資料夾 .agents/pipeline-tasks.json（相容 .claude/pipeline-tasks.json）記極輕量的結構：
 *   { tasks: [{ id, title, epic?, spec?, dependsOn?, prompt?, model? }] }
 * 6 欄狀態（鎖定中／可開工／規格等點頭／施工與檢查中／只剩收尾／已歸檔，另加誠實兜底「問不到／待釐清」）
 * 100% 由規格檔案路徑、主線 git ls-tree、工作區狀態、s.stages 與 todoBoard 白板即時推導，
 * 絕不存假百分比或可手寫的狀態（防 P2／R1／R2／R3）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { git, gitRaw, real } from './git.mjs';
import { specDirNames, zhEn, plural } from './lang.mjs';
import { startMatch } from './rounds.mjs';

export const COLUMNS = ['blocked', 'ready', 'spec-waiting', 'in-progress', 'wrap-up', 'archived', 'unknown'];

const MANUAL_KEYS = new Set(['status', 'column', 'percent', 'progress', 'done', 'completedAt']);

export function columnLabel(col) {
  switch (col) {
    case 'blocked': return zhEn('鎖定中', 'Blocked');
    case 'ready': return zhEn('可開工', 'Ready');
    case 'spec-waiting': return zhEn('規格等點頭', 'Spec waiting nod');
    case 'in-progress': return zhEn('施工與檢查中', 'In progress');
    case 'wrap-up': return zhEn('只剩收尾', 'Wrap-up only');
    case 'archived': return zhEn('已歸檔', 'Archived');
    default: return zhEn('問不到／待釐清', 'Unknown / clarify');
  }
}

/** 統一正規化 spec slug：剝除尾端 .md，拒絕含 /、\ 或 .. 的路徑片段。 */
export function normSpecSlug(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\.md$/i, '');
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return null;
  return trimmed;
}

/** 認得 main 或 master 作為主線分支（P8：測試與 GitHub CI 預設為 master）。 */
export function mainBranchOf(dir) {
  if (!dir) return null;
  return ['main', 'master'].find((m) => git(['rev-parse', '--verify', '-q', `refs/heads/${m}`], dir) !== null) ?? null;
}

/**
 * 讀取並驗證主資料夾的任務定義檔（五態：no-main / unset / unreadable / broken / ok）。
 * 手寫的 status／percent 等欄位一律忽略並註記 ignoredManualFields（防 P2）。
 */
export function readTasksConfig(mainRoot, { worktreeRoot = null } = {}) {
  if (!mainRoot) {
    return {
      state: 'no-main', path: null, relPath: null, tasks: [], errors: [],
      ignoredManualFields: false, worktreeDiffers: false,
      note: zhEn('找不到主資料夾，問不到任務清單。', 'Can\'t find the main folder, so the task list can\'t be checked.'),
    };
  }
  const candidates = [
    { rel: '.agents/pipeline-tasks.json', abs: join(mainRoot, '.agents', 'pipeline-tasks.json') },
    { rel: '.claude/pipeline-tasks.json', abs: join(mainRoot, '.claude', 'pipeline-tasks.json') },
  ];
  let chosen = null;
  let rawText = null;
  for (const c of candidates) {
    try {
      rawText = readFileSync(c.abs, 'utf8');
      chosen = c;
      break;
    } catch (e) {
      if (e?.code === 'ENOENT') continue;
      if (e?.code === 'EPERM' || e?.code === 'EACCES') {
        return {
          state: 'unreadable', path: c.abs, relPath: c.rel, tasks: [], errors: [],
          ignoredManualFields: false, worktreeDiffers: false,
          note: zhEn(`沒有權限讀取任務清單 ${c.rel}（問不到，不當成沒有設定）。`, `No permission to read task list ${c.rel} (couldn't check, not treated as unset).`),
        };
      }
      return {
        state: 'broken', path: c.abs, relPath: c.rel, tasks: [],
        errors: [zhEn(`讀取任務清單失敗：${e?.message ?? 'unknown'}`, `Failed to read task list: ${e?.message ?? 'unknown'}`)],
        ignoredManualFields: false, worktreeDiffers: false,
        note: zhEn(`任務清單 ${c.rel} 讀取失敗。`, `Couldn't read task list ${c.rel}.`),
      };
    }
  }
  if (!chosen) {
    return {
      state: 'unset', path: null, relPath: null, tasks: [], errors: [],
      ignoredManualFields: false, worktreeDiffers: false,
      note: zhEn('這個專案還沒建立 .agents/pipeline-tasks.json 任務清單。', 'This project hasn\'t set up .agents/pipeline-tasks.json yet.'),
    };
  }

  let worktreeDiffers = false;
  if (worktreeRoot && real(worktreeRoot) !== real(mainRoot)) {
    const wtAbs = join(worktreeRoot, chosen.rel);
    try {
      if (existsSync(wtAbs) && readFileSync(wtAbs, 'utf8') !== rawText) worktreeDiffers = true;
    } catch { /* ignore worktree diff read errors */ }
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    return {
      state: 'broken', path: chosen.abs, relPath: chosen.rel, tasks: [],
      errors: [zhEn(`JSON 格式錯誤：${e?.message ?? ''}`, `Invalid JSON: ${e?.message ?? ''}`)],
      ignoredManualFields: false, worktreeDiffers,
      note: zhEn(`任務清單 ${chosen.rel} 讀不懂。`, `Task list ${chosen.rel} can't be parsed.`),
    };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.tasks)) {
    return {
      state: 'broken', path: chosen.abs, relPath: chosen.rel, tasks: [],
      errors: [zhEn('頂層必須是包含 tasks 陣列的 JSON 物件。', 'Top level must be a JSON object with a tasks array.')],
      ignoredManualFields: false, worktreeDiffers,
      note: zhEn(`任務清單 ${chosen.rel} 結構不符。`, `Task list ${chosen.rel} has an invalid structure.`),
    };
  }

  let ignoredManualFields = Object.keys(data).some((k) => MANUAL_KEYS.has(k));
  const errors = [];
  const tasks = [];
  const seenIds = new Set();

  data.tasks.forEach((raw, idx) => {
    const at = `#${idx + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(zhEn(`第 ${idx + 1} 項不是物件。`, `Item ${at} is not an object.`));
      return;
    }
    if (Object.keys(raw).some((k) => MANUAL_KEYS.has(k))) ignoredManualFields = true;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || /\s/.test(id)) {
      errors.push(zhEn(`第 ${idx + 1} 項的 id 必須是非空白字串。`, `Item ${at} id must be a non-empty string without whitespace.`));
      return;
    }
    if (seenIds.has(id)) {
      errors.push(zhEn(`任務 id「${id}」重複。`, `Duplicate task id "${id}".`));
      return;
    }
    seenIds.add(id);
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) {
      errors.push(zhEn(`任務「${id}」缺少標題 title。`, `Task "${id}" is missing a title.`));
    }
    let spec = null;
    if (raw.spec !== undefined && raw.spec !== null) {
      spec = normSpecSlug(raw.spec);
      if (!spec) {
        errors.push(zhEn(`任務「${id}」的 spec 只能寫檔名或 slug（不可含 /、\\ 或 ..）。`, `Task "${id}" spec must be a plain filename or slug (no /, \\, or ..).`));
      }
    }
    let epic = null;
    if (raw.epic !== undefined && raw.epic !== null) {
      if (typeof raw.epic !== 'string') errors.push(zhEn(`任務「${id}」的 epic 必須是字串。`, `Task "${id}" epic must be a string.`));
      else if (raw.epic.trim()) epic = raw.epic.trim();
    }
    let prompt = null;
    if (raw.prompt !== undefined && raw.prompt !== null) {
      if (typeof raw.prompt !== 'string') errors.push(zhEn(`任務「${id}」的 prompt 必須是字串。`, `Task "${id}" prompt must be a string.`));
      else if (raw.prompt.trim()) prompt = raw.prompt.trim();
    }
    let model = null;
    if (raw.model !== undefined && raw.model !== null) {
      if (typeof raw.model !== 'string') errors.push(zhEn(`任務「${id}」的 model 必須是字串。`, `Task "${id}" model must be a string.`));
      else if (raw.model.trim()) model = raw.model.trim();
    }
    let dependsOn = [];
    if (raw.dependsOn !== undefined && raw.dependsOn !== null) {
      if (!Array.isArray(raw.dependsOn) || raw.dependsOn.some((d) => typeof d !== 'string' || !d.trim())) {
        errors.push(zhEn(`任務「${id}」的 dependsOn 必須是非空字串陣列。`, `Task "${id}" dependsOn must be an array of non-empty strings.`));
      } else {
        dependsOn = [...new Set(raw.dependsOn.map((d) => d.trim()))];
      }
    }
    tasks.push({ id, title, epic, spec, dependsOn, prompt, model });
  });

  // 檢查相依存在性、自我相依與循環相依
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d === t.id) errors.push(zhEn(`任務「${t.id}」不能相依於自己。`, `Task "${t.id}" cannot depend on itself.`));
      else if (!byId.has(d)) errors.push(zhEn(`任務「${t.id}」指向不存在的前置任務「${d}」。`, `Task "${t.id}" depends on unknown task "${d}".`));
    }
  }
  const color = new Map();
  const stack = [];
  const visit = (id) => {
    color.set(id, 1);
    stack.push(id);
    const t = byId.get(id);
    for (const d of t?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      if (color.get(d) === 1) {
        const cyc = [...stack.slice(stack.indexOf(d)), d].join(' -> ');
        errors.push(zhEn(`發現循環相依：${cyc}`, `Dependency cycle detected: ${cyc}`));
      } else if (!color.has(d)) {
        visit(d);
      }
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const t of tasks) if (!color.has(t.id)) visit(t.id);

  if (errors.length) {
    return {
      state: 'broken', path: chosen.abs, relPath: chosen.rel, tasks: [], errors,
      ignoredManualFields, worktreeDiffers,
      note: zhEn(`任務清單 ${chosen.rel} 設定有誤（${plural(errors.length, '項', 'items')}）。`, `Task list ${chosen.rel} has errors (${plural(errors.length, 'issue')}).`),
    };
  }
  return {
    state: 'ok', path: chosen.abs, relPath: chosen.rel, tasks, errors: [],
    ignoredManualFields, worktreeDiffers, note: null,
  };
}

/** 一次讀取主線分支的 docs/ 規格快照，零逐任務 git 查詢（P8：認 main/master）。 */
export function mainSpecSnapshot(mainRoot) {
  const mainRef = mainBranchOf(mainRoot);
  if (!mainRef) {
    return { state: 'unknown', mainRef: null, done: new Set(), doing: new Set(), planned: new Set() };
  }
  const out = gitRaw(['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', mainRef, '--', 'docs'], mainRoot);
  if (out === null) {
    return { state: 'unknown', mainRef, done: new Set(), doing: new Set(), planned: new Set() };
  }
  const doneDirs = new Set(specDirNames(['done']).map((x) => x.toLowerCase()));
  const doingDirs = new Set(specDirNames(['doing']).map((x) => x.toLowerCase()));
  const plannedDirs = new Set(specDirNames(['planned']).map((x) => x.toLowerCase()));
  const done = new Set(), doing = new Set(), planned = new Set();
  for (const line of out.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    const parts = p.split('/');
    if (parts.length !== 3 || parts[0].toLowerCase() !== 'docs' || !/\.md$/i.test(parts[2])) continue;
    const dir = parts[1].toLowerCase();
    const slug = parts[2].replace(/\.md$/i, '').toLowerCase();
    if (!slug) continue;
    if (doneDirs.has(dir)) done.add(slug);
    else if (doingDirs.has(dir)) doing.add(slug);
    else if (plannedDirs.has(dir)) planned.add(slug);
  }
  return { state: 'ok', mainRef, done, doing, planned };
}

/** 從專案事件紀錄抽出最新派工事件（依 taskId 索引，並共用同一份無 hook 結案判斷）。 */
export function dispatchesOf(events, projectSessions = []) {
  const byTask = new Map();
  const bySession = new Map();
  const lastClosedTs = new Map();
  const lastActiveTs = new Map();
  for (const e of events ?? []) {
    if (e?.session && typeof e.ts === 'string') {
      if (e.event === 'session_closed') {
        const prev = lastClosedTs.get(e.session);
        if (!prev || e.ts >= prev) lastClosedTs.set(e.session, e.ts);
      } else if (e.hook || e.event === 'session_reopened') {
        const prev = lastActiveTs.get(e.session);
        if (!prev || e.ts >= prev) lastActiveTs.set(e.session, e.ts);
      }
    }
    if (e?.event !== 'task_dispatched' || !e.taskId) continue;
    const rec = {
      taskId: e.taskId,
      conversationId: e.conversationId ?? null,
      title: e.title ?? null,
      ts: e.ts ?? null,
      verified: e.verified === true,
      cwd: e.cwd ?? null,
      model: e.model ?? null,
      closed: false,
    };
    byTask.set(e.taskId, rec);
    if (rec.conversationId) bySession.set(rec.conversationId, rec);
  }
  const pSessionMap = new Map((projectSessions ?? []).filter((s) => s?.id).map((s) => [s.id, s]));
  for (const rec of byTask.values()) {
    if (!rec.conversationId) continue;
    const ps = pSessionMap.get(rec.conversationId);
    if (ps) {
      rec.closed = Boolean(ps.closedAt);
      continue;
    }
    const closedTs = lastClosedTs.get(rec.conversationId);
    if (!closedTs) continue;
    if (rec.ts && closedTs < rec.ts) continue;
    const activeTs = lastActiveTs.get(rec.conversationId);
    rec.closed = !activeTs || closedTs >= activeTs;
  }
  return { byTask, bySession };
}

function liveWorktreeSpecs(cards, mainSnap) {
  const map = new Map(); // slugLower -> [{ kind, card }]
  const add = (slug, kind, card) => {
    const k = slug.toLowerCase();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ kind, card });
  };
  const groups = [
    ['done', specDirNames(['done'])],
    ['doing', specDirNames(['doing'])],
    ['planned', specDirNames(['planned'])],
  ];
  for (const c of cards ?? []) {
    if (!c || c.gone || c.notGit || !c.path) continue;
    const dirty = c.dirty;
    const mergeStep = c.ladder?.steps?.find((x) => x.id === 'merge');
    const hasWork = (dirty !== null && dirty > 0) || mergeStep?.state === 'pending';
    // 主資料夾若乾淨且已在主線，不重複當成額外 worktree 活動（由 mainSnap 代表）；有未存改動才視為活躍
    const isMain = c.ladder?.onMain && !hasWork;
    if (isMain) continue;
    for (const [kind, dirs] of groups) {
      for (const dir of dirs) {
        const full = join(c.path, 'docs', dir);
        if (!existsSync(full)) continue;
        let files = [];
        try { files = readdirSync(full); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith('.md')) continue;
          const slug = f.replace(/\.md$/i, '');
          // 若 main 已經歸檔同一 slug，worktree 繼承來的舊升級摘要檔不算新活動（P12）
          if (kind === 'done' && mainSnap.done.has(slug.toLowerCase())) continue;
          add(slug, kind, c);
        }
      }
    }
  }
  return map;
}

function sessionSpecSlugs(s) {
  const out = new Set();
  for (const st of s?.stages ?? []) {
    if (st.link?.name) {
      const slug = normSpecSlug(st.link.name);
      if (slug) out.add(slug.toLowerCase());
    }
    if (st.specPlace?.name) {
      const slug = normSpecSlug(st.specPlace.name);
      if (slug) out.add(slug.toLowerCase());
    }
    for (const p of st.specPlaces ?? []) {
      const slug = normSpecSlug(p?.name);
      if (slug) out.add(slug.toLowerCase());
    }
    if (st.checklist?.file) {
      const slug = normSpecSlug(basename(String(st.checklist.file)));
      if (slug) out.add(slug.toLowerCase());
    }
  }
  return out;
}

function firstPromptsMap(events) {
  const map = new Map();
  for (const e of events ?? []) {
    if (!e?.session || e._subagent) continue;
    if (e.hook === 'UserPrompt' || e.source === 'USER_EXPLICIT') {
      if (!map.has(e.session) && typeof e.prompt === 'string' && e.prompt.trim()) map.set(e.session, e.prompt);
    }
  }
  return map;
}

function topoOrder(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set();
  const ordered = [];
  const visit = (t) => {
    if (visited.has(t.id)) return;
    visited.add(t.id);
    for (const depId of t.dependsOn) {
      const dep = byId.get(depId);
      if (dep) visit(dep);
    }
    ordered.push(t);
  };
  for (const t of tasks) visit(t);
  return ordered;
}

function defaultCopyPrompt(t) {
  return zhEn(
    `請依照任務 ${t.id}「${t.title}」${t.spec ? `（對應規格：${t.spec}）` : ''} 開始處理。`,
    `Please start working on task ${t.id} "${t.title}"${t.spec ? ` (spec: ${t.spec})` : ''}.`,
  );
}

function hasPassedNod(s) {
  const a = (s?.stages ?? []).find((x) => x.skill && (x.id === 'A' || x.skill === 'spec'));
  const b = (s?.stages ?? []).find((x) => x.type === 'main-conversation');
  if (a?.link) return true;
  if (a?.closedBy === 'nod' || b?.nodAt || b?.ranAt) return true;
  if (a?.checklist?.parsed && (a.checklist.checked > 0 || a.checklist.pending > 0)) return true;
  return (s?.stages ?? []).some((x) => x !== a && x !== b && x.type !== 'not-built' && (x.ranAt || x.doneAt));
}

/**
 * 推導專案的誠實任務板。
 * 絕對單一真相來源：給 lib/collect.mjs（看板）、agy-pipeline --tasks、與 --wrap dispatch 共用（P2）。
 */
export function deriveTaskBoard({ project, desk = {}, events = [], worktreeRoot = null } = {}) {
  const mainRoot = project?.mainRoot ?? null;
  const cfg = readTasksConfig(mainRoot, { worktreeRoot });
  const mainSnap = mainRoot ? mainSpecSnapshot(mainRoot) : { state: 'unknown', mainRef: null, done: new Set(), doing: new Set(), planned: new Set() };
  const emptyCols = () => Object.fromEntries(COLUMNS.map((c) => [c, []]));

  if (cfg.state !== 'ok') {
    return {
      state: cfg.state, path: cfg.path, relPath: cfg.relPath,
      mainRef: mainSnap.mainRef, mainSnapState: mainSnap.state,
      errors: cfg.errors, ignoredManualFields: cfg.ignoredManualFields, worktreeDiffers: cfg.worktreeDiffers,
      note: cfg.note, columns: emptyCols(), counts: Object.fromEntries(COLUMNS.map((c) => [c, 0])),
      total: 0, tasks: [],
    };
  }
  if (!cfg.tasks.length) {
    return {
      state: 'empty', path: cfg.path, relPath: cfg.relPath,
      mainRef: mainSnap.mainRef, mainSnapState: mainSnap.state,
      errors: [], ignoredManualFields: cfg.ignoredManualFields, worktreeDiffers: cfg.worktreeDiffers,
      note: zhEn('任務清單裡目前沒有任何任務（tasks 為空）。', 'The task list is currently empty (no tasks defined).'),
      columns: emptyCols(), counts: Object.fromEntries(COLUMNS.map((c) => [c, 0])),
      total: 0, tasks: [],
    };
  }

  const sessions = project?.sessions ?? [];
  const sessionSpecs = new Map(sessions.map((s) => [s.id, sessionSpecSlugs(s)]));
  const dispatches = dispatchesOf(events, sessions);
  const firstPrompts = firstPromptsMap(events);
  const wtSpecMap = liveWorktreeSpecs(project?.cards ?? [], mainSnap);

  const ordered = topoOrder(cfg.tasks);
  const statusById = new Map();
  const resultById = new Map();

  for (const t of ordered) {
    const specKey = t.spec ? t.spec.toLowerCase() : null;
    const inMainDone = specKey ? mainSnap.done.has(specKey) : false;
    const inMainDoing = specKey ? mainSnap.doing.has(specKey) : false;
    const inMainPlanned = specKey ? mainSnap.planned.has(specKey) : false;
    const wtHits = specKey ? (wtSpecMap.get(specKey) ?? []) : [];
    const dispatch = dispatches.byTask.get(t.id) ?? null;
    const dispatchOpen = Boolean(dispatch && !dispatch.closed && !sessions.some((s) => s.id === dispatch.conversationId));

    // 單一來源匹配對話：s.stages A 關、dispatch、與可選 prompt startMatch（P2）
    const linked = sessions.filter((s) => {
      if (specKey && sessionSpecs.get(s.id)?.has(specKey)) return true;
      if (dispatch?.conversationId && s.id === dispatch.conversationId) return true;
      if (t.prompt && firstPrompts.has(s.id) && startMatch(firstPrompts.get(s.id), t.prompt) > 0) return true;
      return false;
    });
    const liveSessions = linked.filter((s) => !s.closedAt && !s.movedOn);
    const closedSessions = linked.filter((s) => !!s.closedAt);

    const unmetDeps = t.dependsOn.filter((d) => statusById.get(d) !== 'archived');
    const anyDepUnknown = t.dependsOn.some((d) => statusById.get(d) === 'unknown');

    let column = null;
    let reason = '';
    const warnings = [];
    if (!t.spec) {
      warnings.push(zhEn('未指定 spec 檔名，無法依主線升級摘要自動判定已歸檔與解鎖下游。', 'No spec slug set: cannot verify archival on the main branch to unlock downstream tasks.'));
    }

    // 1. 衝突與主線問不到檢查
    if (specKey && inMainDone && (inMainDoing || inMainPlanned)) {
      column = 'unknown';
      reason = zhEn(
        `主線 ${mainSnap.mainRef} 同時存在已完成與未完成資料夾裡的「${t.spec}.md」，分不出狀態`,
        `"${t.spec}.md" exists in both done and planned/in-progress folders on ${mainSnap.mainRef}`,
      );
    } else if (specKey && mainSnap.state === 'unknown') {
      column = 'unknown';
      reason = zhEn('問不到主線分支（main／master）或規格資料夾狀態', 'Couldn\'t check main/master branch or docs/ tree state');
    }

    // 2. 已歸檔檢查（預審 #4：已結案且 card.gone 不阻擋；在線問不到 dirty/merge 標 unknown）
    let activeFolderBlock = false;
    let folderUnknown = false;
    if (!column && specKey && inMainDone) {
      for (const s of linked) {
        if (!s.closedAt && !s.movedOn && (!s.card || s.card.gone)) {
          folderUnknown = true;
          reason = zhEn('主線已有升級摘要，但仍有未結案對話的工作區不在了，問不到是否已存已併', 'Archived spec is on main, but an unclosed conversation\'s folder is gone so uncommitted/unmerged changes can\'t be checked');
          break;
        }
        if (s.card && !s.card.gone && !s.card.notGit && !s.movedOn) {
          const mergeStep = s.card.ladder?.steps?.find((x) => x.id === 'merge');
          if (s.card.dirty === null || mergeStep?.state === 'unknown') {
            folderUnknown = true;
            reason = zhEn('主線已有升級摘要，但問不到關聯工作區是否還有未存或未併改動', 'Archived spec is on main, but couldn\'t check uncommitted/unmerged state of linked workspace');
            break;
          }
          if (s.card.dirty > 0 || mergeStep?.state === 'pending') {
            activeFolderBlock = true;
          }
        }
      }
      if (!folderUnknown && !activeFolderBlock) {
        for (const h of wtHits) {
          const c = h.card;
          const mergeStep = c.ladder?.steps?.find((x) => x.id === 'merge');
          if (c.dirty === null || mergeStep?.state === 'unknown') {
            folderUnknown = true;
            reason = zhEn('主線已有升級摘要，但問不到工作區是否還有未存或未併改動', 'Archived spec is on main, but couldn\'t check a workspace\'s uncommitted/unmerged state');
            break;
          }
          if (c.dirty > 0 || mergeStep?.state === 'pending') {
            activeFolderBlock = true;
          }
        }
      }
      if (folderUnknown) {
        column = 'unknown';
      } else if (!activeFolderBlock) {
        column = 'archived';
        reason = zhEn(`主線 ${mainSnap.mainRef} 已歸檔「${t.spec}.md」，且無未存或未併改動`, `Archived "${t.spec}.md" on ${mainSnap.mainRef} with no uncommitted or unmerged changes`);
      }
    }

    // 3. 進行中活動（只剩收尾 / 施工與檢查中 / 規格等點頭）— 活工作區與對話優先於主線舊規劃中（預審 #4）
    if (!column) {
      const deskHits = linked.map((s) => ({ s, d: desk[s.id] ?? null })).filter((x) => x.d);
      const wrapHit = deskHits.find(({ s, d }) => {
        if (!s.closedAt && (d.call || d.clear)) return true;
        if (s.closedAt && (d.items ?? []).some((i) => i.kind === 'todo' || i.kind === 'ask')) return true;
        return false;
      });
      const unknownDeskHit = deskHits.find(({ s, d }) => !s.closedAt && (d.items ?? []).some((i) => i.kind === 'unknown') && !d.call);

      if (wrapHit) {
        column = 'wrap-up';
        reason = wrapHit.d.call
          ? wrapHit.d.call
          : wrapHit.d.clear
            ? wrapHit.d.clear
            : zhEn('對話已結案但工作區尚有未存或未併改動', 'Conversation closed with uncommitted or unmerged changes');
      } else if (
        inMainDoing
        || wtHits.some((h) => h.kind === 'doing' || h.kind === 'done')
        || liveSessions.some((s) => hasPassedNod(s))
        || dispatchOpen
        || activeFolderBlock
      ) {
        column = 'in-progress';
        if (wtHits.some((h) => h.kind === 'doing' || h.kind === 'done') || inMainDoing) {
          reason = zhEn(`規格「${t.spec}.md」位於進行中（${wtHits.length ? 'worktree 施工中' : mainSnap.mainRef}）`, `Spec "${t.spec}.md" is in progress (${wtHits.length ? 'active worktree' : mainSnap.mainRef})`);
        } else if (dispatchOpen) {
          reason = zhEn(`主任已派工新對話（${dispatch.conversationId.slice(0, 8)}），等待首次工具動作紀錄`, `Director dispatched conversation (${dispatch.conversationId.slice(0, 8)}), waiting for first sensor record`);
        } else if (activeFolderBlock) {
          reason = zhEn('主線已有升級摘要，但關聯工作區仍有未存或未併改動', 'Archived spec is on main, but a linked workspace still has uncommitted or unmerged changes');
        } else {
          reason = zhEn('關聯對話已進入寫程式或檢查階段', 'Linked conversation has moved past spec nod into coding or checks');
        }
      } else if (
        liveSessions.some((s) => (desk[s.id]?.items ?? []).some((i) => i.hold))
        || wtHits.some((h) => h.kind === 'planned')
        || inMainPlanned
      ) {
        column = 'spec-waiting';
        reason = liveSessions.some((s) => (desk[s.id]?.items ?? []).some((i) => i.hold))
          ? zhEn('規格已寫好或預審中，等你確認或點頭開工', 'Spec written or prechecked, waiting for your confirmation/go-ahead')
          : zhEn(`規格「${t.spec}.md」位於規劃中，等待確認開工`, `Spec "${t.spec}.md" is in planned, waiting for go-ahead`);
      } else if (unknownDeskHit) {
        column = 'unknown';
        reason = unknownDeskHit.d.items.find((i) => i.kind === 'unknown')?.text ?? zhEn('關聯對話有項目問不到', 'Linked conversation has items that couldn\'t be checked');
      } else if (closedSessions.length > 0 && !inMainDone) {
        // 舊對話按過結案但主線尚無升級摘要（也無未存未併）→ 待釐清，不假裝沒開工也不假裝歸檔
        column = 'unknown';
        reason = zhEn('關聯對話已結案，但主線尚未看到對應的升級摘要，待釐清', 'Linked conversation is closed, but no archived spec was seen on main yet');
      }
    }

    // 4. 進行中但前置未歸檔 → 照實留在本欄並掛前置警告（R1/P6）
    if (column === 'spec-waiting' || column === 'in-progress' || column === 'wrap-up') {
      if (unmetDeps.length) {
        warnings.push(zhEn(
          `⚠️ 前置任務（${unmetDeps.join('、')}）尚未併入 ${mainSnap.mainRef ?? 'main'} 歸檔`,
          `⚠️ Upstream tasks (${unmetDeps.join(', ')}) aren't archived on ${mainSnap.mainRef ?? 'main'} yet`,
        ));
      }
    }

    // 5. 未開工任務：unknown / blocked / ready
    if (!column) {
      if (anyDepUnknown) {
        column = 'unknown';
        reason = zhEn('前置任務狀態問不到，暫無法判定是否解鎖', 'Upstream task state couldn\'t be checked, so unlock status is unknown');
      } else if (unmetDeps.length) {
        column = 'blocked';
        reason = zhEn(
          `等待前置任務併入 ${mainSnap.mainRef ?? 'main'} 歸檔：${unmetDeps.join('、')}`,
          `Waiting for upstream tasks to be archived on ${mainSnap.mainRef ?? 'main'}: ${unmetDeps.join(', ')}`,
        );
      } else {
        column = 'ready';
        reason = t.dependsOn.length
          ? zhEn(`前置任務（${t.dependsOn.join('、')}）皆已歸檔，可開工`, `All upstream tasks (${t.dependsOn.join(', ')}) archived; ready to start`)
          : zhEn('無前置相依，可開工', 'No upstream dependencies; ready to start');
      }
    }

    statusById.set(t.id, column);
    const primarySession = liveSessions[0] ?? linked[0] ?? null;
    const basePrompt = t.prompt ?? defaultCopyPrompt(t);
    const copyPrompt = column === 'blocked'
      ? `${zhEn(`⚠️ 注意：此任務前置（${unmetDeps.join('、')}）尚未歸檔解鎖。\n`, `⚠️ Note: upstream tasks (${unmetDeps.join(', ')}) are not archived yet.\n`)}${basePrompt}`
      : basePrompt;
    const canCopy = column !== 'archived';
    const copyLabel = column === 'blocked'
      ? zhEn('複製交辦（前置未解鎖）', 'Copy prompt (deps locked)')
      : zhEn('複製開工交辦', 'Copy handoff prompt');

    resultById.set(t.id, {
      id: t.id,
      title: t.title,
      epic: t.epic,
      spec: t.spec,
      dependsOn: t.dependsOn,
      model: t.model,
      column,
      columnLabel: columnLabel(column),
      reason,
      warnings,
      unmetDeps,
      sessionId: primarySession?.id ?? (dispatchOpen ? dispatch.conversationId : null),
      sessionTitle: primarySession?.title ?? (dispatchOpen ? dispatch.title : null),
      copyPrompt,
      copyLabel,
      canCopy,
    });
  }

  // 回歸原設定順序呈現，避免拓撲排序打亂使用者心智順序
  const tasks = cfg.tasks.map((t) => resultById.get(t.id));
  const columns = emptyCols();
  for (const t of tasks) columns[t.column].push(t);
  const counts = Object.fromEntries(COLUMNS.map((c) => [c, columns[c].length]));

  return {
    state: 'ok',
    path: cfg.path,
    relPath: cfg.relPath,
    mainRef: mainSnap.mainRef,
    mainSnapState: mainSnap.state,
    errors: [],
    ignoredManualFields: cfg.ignoredManualFields,
    worktreeDiffers: cfg.worktreeDiffers,
    note: null,
    columns,
    counts,
    total: tasks.length,
    tasks,
  };
}

/** 終端機 `agy-pipeline --tasks` 純事實輸出（與看板共用同一推導與雙語文案，P2）。 */
export function formatTasksLines(tb, { displayName = null } = {}) {
  const head = displayName
    ? zhEn(`誠實任務板（${displayName}）`, `Honest task board (${displayName})`)
    : zhEn('誠實任務板', 'Honest task board');
  const L = [head];
  if (tb.worktreeDiffers) {
    L.push(zhEn(
      `⚠️ 目前所在 worktree 的 ${tb.relPath} 與主資料夾不同步；任務板一律以主資料夾為準。`,
      `⚠️ This worktree's ${tb.relPath} differs from the main folder; the task board always reads from the main folder.`,
    ));
  }
  if (tb.ignoredManualFields) {
    L.push(zhEn(
      'ℹ️ 設定檔裡的手寫 status／percent 欄位已忽略——欄位狀態 100% 由真實檔案與紀錄推導。',
      'ℹ️ Manual status/percent fields in the config were ignored: column states are derived 100% from real files and records.',
    ));
  }
  if (tb.state === 'no-main' || tb.state === 'unset' || tb.state === 'unreadable' || tb.state === 'empty') {
    L.push(`   ${tb.note}`);
    return L;
  }
  if (tb.state === 'broken') {
    L.push(`   ⚠️ ${tb.note}`);
    for (const err of tb.errors) L.push(`   - ${err}`);
    return L;
  }
  const summaryParts = COLUMNS
    .filter((c) => c !== 'unknown' || tb.counts[c] > 0)
    .map((c) => `${columnLabel(c)} ${tb.counts[c]}`);
  L.push(zhEn(`共 ${tb.total} 項：${summaryParts.join(' · ')}`, `${plural(tb.total, 'task')} total: ${summaryParts.join(' · ')}`));
  for (const col of COLUMNS) {
    const list = tb.columns[col] ?? [];
    if (!list.length) continue;
    L.push('', zhEn(`▸ ${columnLabel(col)}（${list.length}）`, `▸ ${columnLabel(col)} (${list.length})`));
    for (const t of list) {
      const epic = t.epic ? `[${t.epic}] ` : '';
      const spec = t.spec ? ` (${t.spec})` : '';
      const sess = t.sessionId ? zhEn(` · 對話 ${t.sessionTitle ? `「${t.sessionTitle}」` : t.sessionId.slice(0, 8)}`, ` · conversation ${t.sessionTitle ? `"${t.sessionTitle}"` : t.sessionId.slice(0, 8)}`) : '';
      L.push(zhEn(`  ・${t.id}  ${epic}${t.title}${spec}${sess}`, `  - ${t.id}  ${epic}${t.title}${spec}${sess}`));
      L.push(`      ${t.reason}`);
      for (const w of t.warnings) L.push(`      ${w}`);
    }
  }
  return L;
}
