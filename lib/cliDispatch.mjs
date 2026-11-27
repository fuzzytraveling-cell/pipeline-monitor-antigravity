/**
 * cliDispatch.mjs —— F 工地主任的對話內真派工與真收尾清理（規格：honest-task-board-director-dispatch AC-3、AC-4）
 *
 * 三個受 findWords + triedBefore 保護的 --wrap 步驟：
 *   dispatch <taskId>              確認可開工與主資料夾安全後，呼叫 ConversationService/CreateConversation 開新對話並讀回驗證
 *   clean-worktree <path|branch>   嚴格確認非主資料夾、非自身 cwd、0 未存檔、已併入主線、無活躍對話後，以非強制 git worktree remove 移除
 *   archive <conversationId>       確認同專案、已按結案（sessionsOf closedAt 非空）且無未存未併風險後，呼叫 UpdateConversation 歸檔並讀回驗證
 *
 * ⚠️ 安全底線：ANTIGRAVITY_CSRF_TOKEN 僅從執行期環境變數讀取、記憶體傳遞，絕不寫入任何磁碟檔案或印進輸出。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { uncommitted, real, gitContext } from './git.mjs';
import { logFileOf, safeName } from './events.mjs';
import { collectAll, buildPathCanonicalizer, applyCwdCanon } from './collect.mjs';
import { optOutState, mountState } from './mount.mjs';
import { deriveTaskBoard, mainBranchOf, dispatchesOf, columnLabel } from './tasks.mjs';
import { LOG_DIR, sessionFromEnv } from './cliFacts.mjs';
import { zhEn, plural } from './lang.mjs';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));

function gitRun(args, cwd) {
  try {
    return {
      ok: true,
      out: execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
      status: 0,
    };
  } catch (e) {
    return {
      ok: false,
      out: String(e.stderr ?? '').trim() || String(e.stdout ?? '').trim(),
      status: typeof e.status === 'number' ? e.status : null,
    };
  }
}

const fresh = (args, cwd) => { const r = gitRun(args, cwd); return r.ok ? r.out : null; };

/** 移除任何可能出現的 CSRF token 或內嵌 URL 帳密（零憑證外洩）。 */
export function redactSecret(text, secret) {
  let out = String(text ?? '').replace(/\/\/[^/@\s]+@/g, '//');
  if (typeof secret === 'string' && secret) out = out.split(secret).join('[REDACTED]');
  return out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ').slice(0, 240);
}

/** 呼叫本機 Antigravity ConversationService（Connect HTTP+JSON）。 */
async function callLS(method, body, { env = process.env, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const addr = String(env.ANTIGRAVITY_LS_ADDRESS ?? '').trim();
  const csrf = String(env.ANTIGRAVITY_CSRF_TOKEN ?? '');
  if (!addr || !csrf) {
    return { ok: false, missingCreds: true, message: zhEn('缺少 ANTIGRAVITY_LS_ADDRESS 或 ANTIGRAVITY_CSRF_TOKEN', 'Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN') };
  }
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://${addr}/product.v1.ConversationService/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-antigravity-csrf-token': csrf,
      },
      body: JSON.stringify(body ?? {}),
      signal: c.signal,
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
    if (!res.ok) {
      const detail = redactSecret(data?.message ?? text, csrf);
      return { ok: false, status: res.status, message: detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}` };
    }
    if (data === null) return { ok: false, status: res.status, message: zhEn('LS 回應格式讀不懂', 'Unreadable response from LS') };
    return { ok: true, status: res.status, data };
  } catch (e) {
    const msg = c.signal.aborted
      ? zhEn(`連線逾時（${Math.round(timeoutMs / 1000)} 秒）`, `Request timed out (${Math.round(timeoutMs / 1000)}s)`)
      : redactSecret(e?.message ?? String(e), csrf);
    return { ok: false, status: null, message: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 git worktree list --porcelain 名冊。 */
export function parseWorktreeList(mainRoot) {
  const raw = fresh(['worktree', 'list', '--porcelain'], mainRoot);
  if (raw === null) return null;
  const list = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      if (cur) { list.push(cur); cur = null; }
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur);
      cur = { path: line.slice(9).trim(), head: null, branch: null, bare: false, prunable: false };
    } else if (cur) {
      if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
      else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
      else if (line === 'bare') cur.bare = true;
      else if (line.startsWith('prunable')) cur.prunable = true;
    }
  }
  if (cur) list.push(cur);
  return list;
}

function activeSessionsOnPath(targetPath, { projectSessions = [], rawEvents = [], excludeSessionId = null } = {}) {
  const targetReal = real(targetPath);
  const canon = buildPathCanonicalizer({ paths: [targetPath, ...rawEvents.map((e) => e?.cwd)], collapseRoot: true });
  const normEvents = applyCwdCanon(rawEvents, canon);
  const active = new Map();
  const belongsToTarget = (cwd) => {
    if (!cwd) return false;
    if (real(cwd) === targetReal) return true;
    if (existsSync(cwd)) {
      const g = gitContext(cwd);
      return Boolean(g.isGit && real(g.root) === targetReal);
    }
    return false;
  };
  for (const s of projectSessions) {
    if (!s || s.closedAt || s.movedOn || s.id === excludeSessionId) continue;
    if (belongsToTarget(s.cwd)) active.set(s.id, s.title ?? s.id);
  }
  const closedSet = new Set(projectSessions.filter((s) => s.closedAt || s.movedOn).map((s) => s.id));
  for (const e of normEvents) {
    if (!e?.session || e._subagent || e.session === excludeSessionId || closedSet.has(e.session)) continue;
    if (!e.hook) continue;
    if (belongsToTarget(e.cwd)) active.set(e.session, e.title ?? e.session);
  }
  return [...active.entries()].map(([id, title]) => ({ id, title }));
}

export function normalizeWrapTarget(step, rawTarget, ctx) {
  const t = String(rawTarget ?? '').trim();
  if (!t) return null;
  if (step === 'clean-worktree') {
    const base = ctx?.mainRoot ?? ctx?.root ?? '.';
    const resolved = resolve(base, t);
    return existsSync(resolved) ? real(resolved) : t;
  }
  return t;
}

/* ══════════════════════ --wrap dispatch ══════════════════════ */

export async function stepDispatch(ctx, ev, {
  target: taskId,
  sid = sessionFromEnv(),
  env = process.env,
  fetchImpl = fetch,
  monitorDir = HERE,
  home = undefined,
  logDir = LOG_DIR,
} = {}) {
  const label = zhEn('派工開新對話', 'Dispatch new conversation');
  const no = (text) => ({ label, kind: 'not-done', text });
  const addr = String(env.ANTIGRAVITY_LS_ADDRESS ?? '').trim();
  const csrf = String(env.ANTIGRAVITY_CSRF_TOKEN ?? '');
  const projectId = String(env.ANTIGRAVITY_PROJECT_ID ?? '').trim();
  if (!addr || !csrf || !projectId) {
    return no(zhEn(
      '拿不到 Antigravity 本機連線資訊（需要 ANTIGRAVITY_LS_ADDRESS、ANTIGRAVITY_CSRF_TOKEN 與 ANTIGRAVITY_PROJECT_ID）',
      'Missing Antigravity local connection env vars (ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN, and ANTIGRAVITY_PROJECT_ID)',
    ));
  }
  if (!taskId) return no(zhEn('要指定任務 ID（例：--wrap dispatch T-2 "確認派工"）', 'Specify a task ID (e.g. --wrap dispatch T-2 "confirm dispatch")'));

  const mainRoot = ctx.mainRoot ?? ctx.root;
  const projName = safeName(ctx.project);
  const all = collectAll({ monitorDir, ...(home ? { home } : {}) });
  const p = all.projects.find((x) => x.name === projName) ?? null;

  // 預審 #2：若專案已退出記錄或感測器失效，看不到主資料夾活躍狀態，不准派工（R1）
  const optedOut = p?.optedOut ?? optOutState(mainRoot);
  if (optedOut) {
    return no(zhEn('這個專案已退出記錄，感測器看不到主資料夾有沒有其他對話在動——先重新加入記錄或改由手動開對話', 'This project opted out of recording, so the sensor can\'t see whether another conversation is active in the main folder'));
  }
  if (all.faults?.sensor?.state === 'broken') {
    return no(zhEn('這台電腦的感測器現在故障，看不到主資料夾有沒有其他對話在動——先修好感測器', 'The sensor on this machine is broken, so active conversations in the main folder can\'t be checked'));
  }
  const mount = mountState(mainRoot, null, home);
  if (mount?.state === 'broken' || mount?.state === 'off') {
    return no(zhEn('這個專案的感測器沒掛好或已拆掉，看不到主資料夾有沒有其他對話在動——先跑 agy-pipeline --on 或 --install', 'This project\'s sensor isn\'t mounted cleanly, so active conversations in the main folder can\'t be checked'));
  }

  const tb = p?.taskBoard ?? deriveTaskBoard({
    project: { name: projName, displayName: ctx.project, mainRoot, cards: [], sessions: [] },
    desk: {},
    events: ev?.events ?? [],
  });
  if (tb.state !== 'ok') {
    return no(tb.note ?? zhEn('問不到任務清單狀態', 'Couldn\'t check task list state'));
  }
  const task = tb.tasks.find((t) => t.id === taskId);
  if (!task) {
    return no(zhEn(`任務清單裡找不到「${taskId}」`, `Task "${taskId}" was not found in the task list`));
  }
  if (task.column !== 'ready') {
    return no(zhEn(
      `任務「${task.id}」目前在「${columnLabel(task.column)}」（${task.reason}），只有「${columnLabel('ready')}」才能派工`,
      `Task "${task.id}" is currently "${columnLabel(task.column)}" (${task.reason}); only "${columnLabel('ready')}" tasks can be dispatched`,
    ));
  }

  // 階段 0 實測防撞車：省略 environmentId 會開在主資料夾，開工前必檢主資料夾乾淨且無其他活躍對話
  const mainRef = mainBranchOf(mainRoot);
  if (!mainRef) return no(zhEn('找不到主資料夾的 main／master 分支，不能確定主資料夾安全', 'Couldn\'t find a main/master branch in the main folder'));
  const at = fresh(['rev-parse', '--abbrev-ref', 'HEAD'], mainRoot);
  if (at !== mainRef) {
    return no(zhEn(
      `主資料夾現在不在 ${mainRef} 上（${at ? `在 ${at}` : '問不到它在哪'}）——新對話會開在主資料夾，先切回 ${mainRef} 再派工`,
      `The main folder isn't on ${mainRef} right now (${at ? `it's on ${at}` : 'couldn\'t check where it is'}); new conversations open in the main folder, so switch back to ${mainRef} first`,
    ));
  }
  const mdirty = uncommitted(mainRoot);
  if (mdirty === null) return { label, kind: 'unknown', text: zhEn('問不到主資料夾有沒有沒存的檔案', 'Couldn\'t check whether the main folder has uncommitted files') };
  if (mdirty > 0) {
    return no(zhEn(
      `主資料夾還有 ${mdirty} 個沒存（或未追蹤）的檔案——新對話會開在主資料夾，先清乾淨或存檔再派工`,
      `The main folder has ${plural(mdirty, 'uncommitted or untracked file')}; new conversations open in the main folder, so clean or commit first`,
    ));
  }

  const activeMain = activeSessionsOnPath(mainRoot, {
    projectSessions: p?.sessions ?? [],
    rawEvents: ev?.events ?? [],
    excludeSessionId: sid,
  });
  if (activeMain.length) {
    const names = zhEn(
      activeMain.map((x) => `「${x.title}」`).join('、'),
      activeMain.map((x) => `"${x.title}"`).join(', '),
    );
    return no(zhEn(
      `主資料夾還有其他未結案對話正在活動（${names}）——避免在同一資料夾撞車，先結案或等它收尾`,
      `Another unclosed conversation is active in the main folder (${names}); finish or close it first to avoid colliding`,
    ));
  }

  const dispatches = dispatchesOf(ev?.events ?? [], p?.sessions ?? []);
  for (const d of dispatches.byTask.values()) {
    if (!d.conversationId || d.conversationId === sid || d.closed) continue;
    if (d.cwd && real(d.cwd) === real(mainRoot)) {
      return no(zhEn(
        `主資料夾已有未結案的派工對話（${d.taskId}：${d.conversationId.slice(0, 8)}）——先等它結案或開到獨立 worktree`,
        `The main folder already has an unclosed dispatched conversation (${d.taskId}: ${d.conversationId.slice(0, 8)}); wait until it closes first`,
      ));
    }
  }

  // 同時詢問 LS 活躍對話列表，補齊「剛開在主資料夾、還沒觸發任何 hook 工具」的對話（預審 #2）
  const listRes = await callLS('ListConversations', { projectId, pageSize: 50, includeArchived: false }, { env, fetchImpl });
  if (!listRes.ok) {
    return no(zhEn(
      `問不到 Antigravity 目前有哪些執行中的對話（${listRes.message}），為防主資料夾撞車先不動手`,
      `Couldn't list running Antigravity conversations (${listRes.message}), so holding off to avoid colliding in the main folder`,
    ));
  }
  const runningMain = (listRes.data?.conversations ?? []).filter((c) => c?.id && c.id !== sid && !c.metadata?.environmentId && c.state?.runState === 'RUN_STATE_RUNNING');
  if (runningMain.length) {
    const first = runningMain[0];
    return no(zhEn(
      `Antigravity 主資料夾還有正在執行中的對話（${first.annotations?.title ?? first.id.slice(0, 8)}），先等它停下再派工`,
      `An Antigravity conversation is currently running in the main folder (${first.annotations?.title ?? first.id.slice(0, 8)}); wait until it finishes first`,
    ));
  }

  const wantTitle = `[${task.id}] ${task.title}`;
  const createBody = {
    projectId,
    title: wantTitle,
    tags: ['agy-pipeline', `task:${task.id}`],
    prompt: [{ text: task.copyPrompt }],
    ...(task.model ? { model: task.model } : {}),
  };
  const created = await callLS('CreateConversation', createBody, { env, fetchImpl });
  const newId = created.data?.conversation?.id ?? null;
  if (!created.ok || !newId) {
    return { label, kind: 'failed', text: zhEn(`開新對話沒成功——${created.message}`, `Couldn't create conversation: ${created.message}`) };
  }

  // 讀回確認（必要時補命名重讀）；不論是否讀回成功，只要建出 newId 一律記錄 task_dispatched（預審 #7）
  let checkRes = await callLS('GetConversation', { conversationId: newId }, { env, fetchImpl });
  if (checkRes.ok && checkRes.data?.annotations?.title !== wantTitle) {
    await callLS('UpdateConversation', { conversationId: newId, annotations: { title: wantTitle } }, { env, fetchImpl });
    checkRes = await callLS('GetConversation', { conversationId: newId }, { env, fetchImpl });
  }
  const verified = Boolean(checkRes.ok && checkRes.data?.id === newId && checkRes.data?.annotations?.title === wantTitle);

  try {
    appendFileSync(logFileOf(logDir, ctx.project), JSON.stringify({
      ts: new Date().toISOString(),
      event: 'task_dispatched',
      taskId: task.id,
      conversationId: newId,
      title: wantTitle,
      model: task.model ?? null,
      cwd: mainRoot,
      verified,
      ...(sid ? { by_session: sid } : {}),
      source: 'ai',
    }) + '\n');
  } catch { /* ignore log write failure after printing conversationId below */ }

  const modelNote = task.model
    ? zhEn(`型號：${task.model}`, `model: ${task.model}`)
    : zhEn('未指定型號（沿用 Antigravity 預設）', 'no model specified (Antigravity default)');

  if (verified) {
    return {
      label,
      kind: 'done',
      text: zhEn(
        `已在主資料夾建立並命名新對話「${wantTitle}」（${newId}；${modelNote}），讀回確認相符`,
        `Created and titled "${wantTitle}" in the main folder (${newId}; ${modelNote}), confirmed via GetConversation`,
      ),
    };
  }
  return {
    label,
    kind: 'failed',
    text: zhEn(
      `⚠️ 主資料夾已建立對話 ${newId}，但命名或讀回驗證未通過（${checkRes.ok ? `標題為「${checkRes.data?.annotations?.title ?? ''}」` : checkRes.message}）——請先確認該對話狀態，勿重複派工`,
      `⚠️ Created conversation ${newId} in the main folder, but title/readback check failed (${checkRes.ok ? `title is "${checkRes.data?.annotations?.title ?? ''}"` : checkRes.message}); check it before dispatching again`,
    ),
  };
}

/* ══════════════════════ --wrap clean-worktree ══════════════════════ */

export async function stepCleanWorktree(ctx, ev, {
  target,
  sid = sessionFromEnv(),
  monitorDir = HERE,
  home = undefined,
} = {}) {
  const label = zhEn('清理舊 worktree', 'Clean old worktree');
  const no = (text) => ({ label, kind: 'not-done', text });
  if (!target) return no(zhEn('要指定 worktree 路徑或分支名', 'Specify a worktree path or branch name'));

  const mainRoot = ctx.mainRoot ?? ctx.root;
  const list = parseWorktreeList(mainRoot);
  if (!list) return { label, kind: 'unknown', text: zhEn('問不到 git worktree 名冊', 'Couldn\'t read git worktree list') };

  const targetResolved = real(resolve(mainRoot, target));
  const byPath = list.filter((w) => real(w.path) === targetResolved || w.path === target);
  const byBranch = byPath.length ? [] : list.filter((w) => w.branch === target);
  const matches = byPath.length ? byPath : byBranch;
  if (!matches.length) {
    return no(zhEn(`git worktree 名冊裡找不到「${target}」`, `"${target}" isn't in git worktree list`));
  }
  if (matches.length > 1) {
    return no(zhEn(`「${target}」對到 ${matches.length} 個 worktree，改用完整路徑指定`, `"${target}" matched ${matches.length} worktrees; pass the exact path`));
  }
  const wt = matches[0];
  if (real(wt.path) === real(mainRoot)) {
    return no(zhEn('不能移除專案主資料夾', 'Cannot remove the project\'s main folder'));
  }
  if (real(wt.path) === real(ctx.root)) {
    return no(zhEn('不能移除這個對話自己正站著的 worktree', 'Cannot remove the worktree this conversation is currently running in'));
  }
  if (!existsSync(wt.path)) {
    return no(zhEn(`worktree 資料夾已不存在於磁碟（${wt.path}），不動它`, `Worktree folder doesn't exist on disk (${wt.path}), leaving it alone`));
  }

  const dirty = uncommitted(wt.path);
  if (dirty === null) return { label, kind: 'unknown', text: zhEn('問不到這個 worktree 還有沒有未存或未追蹤檔案', 'Couldn\'t check whether this worktree has uncommitted or untracked files') };
  if (dirty > 0) {
    return no(zhEn(`這個 worktree 還有 ${dirty} 個未存或未追蹤的檔案，不動它（不使用 --force）`, `This worktree still has ${plural(dirty, 'uncommitted or untracked file')}; leaving it alone (never --force)`));
  }

  const mainRef = mainBranchOf(mainRoot);
  if (!mainRef) return { label, kind: 'unknown', text: zhEn('找不到 main／master 分支，不能確定這個 worktree 是否已合併', 'Couldn\'t find a main/master branch to verify merge status') };
  const wtHead = fresh(['rev-parse', 'HEAD'], wt.path);
  const mainTip = fresh(['rev-parse', `refs/heads/${mainRef}`], mainRoot);
  if (!wtHead || !mainTip) return { label, kind: 'unknown', text: zhEn(`問不到 worktree 或 ${mainRef} 的版本`, `Couldn't check commits of the worktree or ${mainRef}`) };

  const anc = gitRun(['merge-base', '--is-ancestor', wtHead, mainTip], mainRoot);
  if (!anc.ok) {
    if (anc.status === 1) {
      return no(zhEn(`這個 worktree 的存檔還沒併進 ${mainRef}，不移除`, `This worktree has commits not merged into ${mainRef}; leaving it alone`));
    }
    return { label, kind: 'unknown', text: zhEn(`問不到這個 worktree 是否已併入 ${mainRef}`, `Couldn't check whether this worktree is merged into ${mainRef}`) };
  }

  const all = collectAll({ monitorDir, ...(home ? { home } : {}) });
  const p = all.projects.find((x) => x.name === safeName(ctx.project)) ?? null;
  const active = activeSessionsOnPath(wt.path, {
    projectSessions: p?.sessions ?? [],
    rawEvents: ev?.events ?? [],
    excludeSessionId: sid,
  });
  if (active.length) {
    const names = zhEn(
      active.map((x) => `「${x.title}」`).join('、'),
      active.map((x) => `"${x.title}"`).join(', '),
    );
    return no(zhEn(`這個 worktree 還有未結案對話正在使用（${names}），先結案再清理`, `Another unclosed conversation is still using this worktree (${names}); close it first`));
  }

  const rm = gitRun(['worktree', 'remove', wt.path], mainRoot);
  if (!rm.ok) {
    return { label, kind: 'failed', text: zhEn(`移除沒成——git 說：${redactSecret(rm.out)}`, `Couldn't remove worktree: git says: ${redactSecret(rm.out)}`) };
  }
  const after = parseWorktreeList(mainRoot);
  const stillListed = after ? after.some((w) => real(w.path) === real(wt.path)) : true;
  if (stillListed || existsSync(wt.path)) {
    return { label, kind: 'failed', text: zhEn('執行了 worktree remove，但資料夾或名冊還在，不講成已清理', 'Ran worktree remove, but the folder or listing is still present') };
  }

  // 若原分支非主線且未在其他 worktree 檢出，嘗試安全 git branch -d（嚴禁 -D）
  let branchNote = '';
  if (wt.branch && wt.branch !== mainRef) {
    const usedElsewhere = after.some((w) => w.branch === wt.branch);
    if (!usedElsewhere) {
      const br = gitRun(['branch', '-d', wt.branch], mainRoot);
      branchNote = br.ok
        ? zhEn(`；已安全刪除分支 ${wt.branch}`, `; safely deleted branch ${wt.branch}`)
        : zhEn(`；分支 ${wt.branch} 保留未刪（git branch -d 回：${redactSecret(br.out)}）`, `; kept branch ${wt.branch} (git branch -d: ${redactSecret(br.out)})`);
    }
  }

  return {
    label,
    kind: 'done',
    text: zhEn(`已移除 worktree ${wt.path}，重查名冊確認消失${branchNote}`, `Removed worktree ${wt.path} and confirmed it is gone from the list${branchNote}`),
  };
}

/* ══════════════════════ --wrap archive ══════════════════════ */

export async function stepArchive(ctx, ev, {
  target: convId,
  env = process.env,
  fetchImpl = fetch,
  monitorDir = HERE,
  home = undefined,
} = {}) {
  const label = zhEn('歸檔舊對話', 'Archive conversation');
  const no = (text) => ({ label, kind: 'not-done', text });
  const projectId = String(env.ANTIGRAVITY_PROJECT_ID ?? '').trim();
  if (!String(env.ANTIGRAVITY_LS_ADDRESS ?? '').trim() || !String(env.ANTIGRAVITY_CSRF_TOKEN ?? '') || !projectId) {
    return no(zhEn(
      '拿不到 Antigravity 本機連線資訊（需要 ANTIGRAVITY_LS_ADDRESS、ANTIGRAVITY_CSRF_TOKEN 與 ANTIGRAVITY_PROJECT_ID）',
      'Missing Antigravity local connection env vars (ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN, and ANTIGRAVITY_PROJECT_ID)',
    ));
  }
  if (!convId) return no(zhEn('要指定對話 ID', 'Specify a conversation ID'));

  const g0 = await callLS('GetConversation', { conversationId: convId }, { env, fetchImpl });
  if (!g0.ok || !g0.data?.id) {
    return { label, kind: 'failed', text: zhEn(`找不到對話 ${convId}（${g0.message}）`, `Couldn't get conversation ${convId} (${g0.message})`) };
  }
  if (g0.data.metadata?.projectId && g0.data.metadata.projectId !== projectId) {
    return no(zhEn(`對話 ${convId} 屬於別的專案，不能在這裡歸檔`, `Conversation ${convId} belongs to another project and cannot be archived here`));
  }
  if (g0.data.annotations?.archived === true) {
    return { label, kind: 'no-need', text: zhEn(`對話 ${convId} 已經是歸檔狀態`, `Conversation ${convId} is already archived`) };
  }

  const all = collectAll({ monitorDir, ...(home ? { home } : {}) });
  const p = all.projects.find((x) => x.name === safeName(ctx.project)) ?? null;
  const s = p?.sessions?.find((x) => x.id === convId) ?? null;
  if (!s) {
    return no(zhEn(`本專案紀錄裡找不到對話 ${convId}，不能確認是否已按結案`, `Conversation ${convId} wasn't found in this project's records, so closed status can't be confirmed`));
  }
  if (!s.closedAt) {
    return no(zhEn(`對話「${s.title ?? convId}」還沒按結案（或結案後又有新活動），不代人歸檔`, `Conversation "${s.title ?? convId}" isn't closed yet (or had new activity since closing); won't archive`));
  }

  // 預審 #5：工作區已移除（剛清理過 worktree）或已換手不阻擋；若工作區仍在磁碟，必驗 0 未存且已併主線
  if (s.cwd && existsSync(s.cwd) && !s.movedOn) {
    const dirty = uncommitted(s.cwd);
    if (dirty === null) return no(zhEn('工作區還在但問不到有沒有未存檔，暫不歸檔', 'Workspace still exists and uncommitted state couldn\'t be checked; holding off archive'));
    if (dirty > 0) return no(zhEn(`工作區還有 ${dirty} 個未存檔，先存再歸檔`, `Workspace still has ${plural(dirty, 'uncommitted file')}; commit before archiving`));
    const mainRoot = ctx.mainRoot ?? ctx.root;
    const mainRef = mainBranchOf(mainRoot);
    if (!mainRef) return no(zhEn('找不到主線分支，無法確認工作區是否已併入主線', 'Couldn\'t find main/master branch to verify merge before archiving'));
    const tip = fresh(['rev-parse', 'HEAD'], s.cwd);
    const mainTip = fresh(['rev-parse', `refs/heads/${mainRef}`], mainRoot);
    if (!tip || !mainTip) return no(zhEn(`問不到工作區或 ${mainRef} 的版本`, `Couldn't check commits for workspace or ${mainRef}`));
    const anc = gitRun(['merge-base', '--is-ancestor', tip, mainTip], mainRoot);
    if (!anc.ok) return no(zhEn(`工作區的存檔還沒併進 ${mainRef}（或問不到），先併完再歸檔`, `Workspace commits aren't merged into ${mainRef} yet (or couldn't check)`));
  }

  const upd = await callLS('UpdateConversation', { conversationId: convId, annotations: { archived: true } }, { env, fetchImpl });
  if (!upd.ok) {
    return { label, kind: 'failed', text: zhEn(`歸檔沒成——${upd.message}`, `Archive failed: ${upd.message}`) };
  }
  const g1 = await callLS('GetConversation', { conversationId: convId }, { env, fetchImpl });
  if (!g1.ok || g1.data?.annotations?.archived !== true) {
    return { label, kind: 'failed', text: zhEn(`送出了歸檔請求，但讀回驗證沒看到 archived=true（${g1.ok ? '仍為 false' : g1.message}）`, `Sent archive request, but GetConversation didn't confirm archived=true (${g1.ok ? 'still false' : g1.message})`) };
  }
  return {
    label,
    kind: 'done',
    text: zhEn(`已歸檔對話「${s.title ?? convId}」（${convId}），讀回確認相符`, `Archived conversation "${s.title ?? convId}" (${convId}), confirmed via GetConversation`),
  };
}
