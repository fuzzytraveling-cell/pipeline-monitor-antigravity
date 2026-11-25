/**
 * collect.mjs —— 把「這台機器上我知道的所有專案」整理成一份 JSON
 *
 * ⚠️ **只列出有證據的專案**(有紀錄檔或有還原點)。
 *    這是刻意的:它不去猜你電腦裡有哪些 git repo,也不掃你的硬碟。
 *    沒有證據就不出現——**不知道的事情就不要出現在畫面上**。
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitContext, changeHealth, changeScale, git, gitRaw, real, withGitMemo, withClock, uncommitted, dirtyPaths, unquotePath, checkpointRelation, backupBranchName, ago } from './git.mjs';
import { safeName, RETAIN_DAYS } from './events.mjs';
import { loadEvents } from './transcript.mjs';
import {
  loadStages, sessionsOf, sessionView, runsPerStage, roundView, editsOf, reportsIn, reportLogIn, decisionsIn, clearLogIn, perStageOfRound,
  suggestionsOf, cardState, firstPromptsOf, specContext, rerunLine, tookLine, rerunMapOf, unknownPromptsOf, unknownPromptLine, stagesBrokenLine,
  noRecordsWithin, noRecordLine, prechecksIn, skillCallsOf,
} from './rounds.mjs';
import { faultsNow, faultBanner, faultNotes, sensorNow, roundStartFor, gateHeartbeat, guardHeartbeat, escalateHeartbeat, SENSOR_FILE, sensorOffLine, noneHereLine, optedOutLine, sensorParts } from './faults.mjs';
import { eLines, eWhere } from './verify.mjs';
import { mountState, mountFix, optOutState } from './mount.mjs';
import { buildTier, readTierConfig, codeFileFn, gitCodeChanges, requirementStatus, fileTimeOf, tierLines } from './tier.mjs';
import { changeFacts, reflogOf, takeoverOf, tenureEvents, previousTenant, beforeTakeover } from './origin.mjs';
import { stampsIn, checkpointFor, stampBefore, lastStampOf } from './checkpoint.mjs';
import { changeScope, noStampYet, greenIsNotCorrect, stampBrokenReason, scaleLine, unsavedLine, unsavedUnknown,
         restoreUnsavedLine, unsavedWhether, stampHelp } from './scope.mjs';
import { specFilesOf } from './checklist.mjs';
import { dataDir, moveState } from './paths.mjs';
import { skillAvailable } from './skills.mjs';
import { stageLine, specNotes, checklistLines, calledIsNotPassed, precheckLine, precheckItems } from './stageLines.mjs';
import { zhEn, plural } from './lang.mjs';
import { detectConflicts, conflictsForWorktree } from './conflicts.mjs';

/** 紀錄住哪:lib/paths.mjs 的 dataDir,跟 hook.sh／status.mjs 同一條規則,否則寫的跟讀的不是同一份(老毛病 P2)。 */
function logDirOf(monitorDir) { return dataDir('logs', monitorDir); }

/** 網頁那一邊的「見哪裡」與「怎麼掛上」(終端機那一邊是「最上面那一行」「打 --on」;AC-4 各講各的那半句)。用到的那一刻才拿:語言照這一次輸出的 */
const topBar = () => zhEn('最上面那一條', 'the bar at the very top');
const notMountedHere = () => zhEn('。在那個資料夾跑 agy-pipeline --on。', '. Run agy-pipeline --on in that folder.');

/**
 * 一次刷新:裡面同一個 git 問題只問一次,這一次算完記憶就丟(lib/git.mjs 的 withGitMemo;規格:儀表板刷新少等git AC-3、AC-4)。
 * 只包儀表板這一條:收工 hook、終端機照舊每題各問(AC-6)。
 */
export function collectAll(opts) {
  // 「現在」整頁只取一次(withClock):同一個事件在兩格各印一次,秒數才不會一邊 7 一邊 8
  return withClock(() => withGitMemo(() => collectAllNow(opts)));
}

function collectAllNow({ monitorDir, skillHome = undefined, extraTranscripts = null, home = undefined }) {
  // 資料住在固定的家,不管儀表板是從哪個資料夾跑的(lib/paths.mjs 的 dataDir;規格:紀錄搬到固定的家);
  // 跟 hook.sh／status.mjs 同一條規則,否則寫的跟讀的不是同一份(老毛病 P2)
  const logDir = dataDir('logs', monitorDir);
  const cpDir = dataDir('checkpoints', monitorDir);
  // 這台電腦的故障(感測器找不到 jq、收工 hook 找不到 node 或自己出錯),加上搬家還沒搬完(AC-5)。全機一份,跟終端機同一個函式(lib/faults.mjs)
  const faults = faultsNow(logDir, { retainDays: RETAIN_DAYS, move: moveState(monitorDir) });

  // 證據來源一:感測器紀錄。來源二:還原點。兩邊的專案名取聯集。
  const names = new Set();
  for (const [dir, re] of [[logDir, /^(.+)\.jsonl$/], [cpDir, /^(.+?)__.+\.json$/]]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.') || f === SENSOR_FILE) continue;
      const m = f.match(re);
      const nm = m?.[1]?.trim();
      if (nm && nm !== '.' && nm !== '..') names.add(nm);
    }
  }

  // 每個專案的紀錄先各讀一次（合併 Antigravity transcript.jsonl 的真實人類發言與 subagent 歸屬）
  const sorted = [...names].sort();
  const loadOpts = { extraTranscripts, ...(home ? { home } : {}) };
  const evByName = new Map(sorted.map((name) => [name, loadEvents(logDir, name, loadOpts)]));
  const fpByName = new Map(sorted.map((name) => [name, firstPromptsOf(evByName.get(name).events)]));
  const firstPromptsFor = (own) => {
    const pool = new Map();   // 自己專案的排前面:兩邊都對得上時,先認自己這邊的
    for (const nm of [own, ...sorted.filter((x) => x !== own)]) {
      for (const [sid, fp] of fpByName.get(nm)) if (!pool.has(sid)) pool.set(sid, { ...fp, project: nm });
    }
    return pool;
  };

  const projects = [];
  for (const name of sorted) {
    const stamps = stampsIn(cpDir, name);
    const { state: evState, events: rawEvents } = evByName.get(name);
    // 建卡前先統一同一工作區的根目錄捷徑與子目錄路徑（stamps 排前以保留既有 cp.worktree 比對拼法），避免拆成兩張各缺一半事件的卡（P13/P6）
    const canon = buildPathCanonicalizer({
      paths: [...stamps.map((cp) => cp.worktree), ...rawEvents.map((e) => e?.cwd)],
      collapseRoot: false,
    });
    const worktrees = new Set();
    for (const cp of stamps) {
      if (typeof cp.worktree !== 'string' || !cp.worktree) continue;
      worktrees.add(canon(cp.worktree));
    }
    const events = applyCwdCanon(rawEvents, canon);
    for (const e of events) if (e.cwd && !e._subagent && e.event !== 'guard_asked' && e.event !== 'tier_notified') worktrees.add(e.cwd);

    const cards = [];
    for (const path of worktrees) {
      cards.push(buildCard({ path, name, events, evState, monitorDir, skillHome, sensorState: sensorNow(faults) }));
    }
    // 全部都不是 git 專案(hook 把這種資料夾全記進同一個桶)→ 沒有任何版本可講,整個案件不出現
    if (cards.length && cards.every((c) => c.notGit)) continue;

    // 對話層(Oscar 的真正工作單位)。每個對話掛在它自己的工作區上。
    const { stages } = loadStages(monitorDir, cards[0]?.path ?? '', cards[0]?.mainRoot ?? null);
    const live = cards.find((c) => !c.gone && !c.notGit);
    const mainRoot = live?.mainRoot ?? null;
    const tenure = new Map();
    const tenureOf = (card) => {
      if (!tenure.has(card.path)) {
        const ev = tenureEvents(events, card.path, card.takeover);
        tenure.set(card.path, { events: ev, sessions: sessionsOf(ev) });
      }
      return tenure.get(card.path);
    };
    const sessionsRaw = sessionsOf(events).map((s) => {
      // 標題不偷讀未驗證的內部檔（R1）：有紀錄標題用標題，否則 sessionsOf 已帶首句摘要，再否則畫面印「（還沒有標題）」
      const title = s.title ?? null;
      const card = cards.find((c) => c.path === s.cwd) ?? null;
      const available = (x) => card?.stages?.find((y) => y.id === x.id)?.available ?? null;
      if (card?.takeover && previousTenant(events, s.cwd, card.takeover, s.id)) {
        const view = previousView({ card, events, stages, session: s.id, cwd: s.cwd, monitorDir, project: name });
        const stagesS = screenStages(view.stages, { availableOf: available });
        return { ...s, sharesCwd: false, title, deletedAt: null, closedAt: s.closedAt ?? null, stages: stagesS, card, tier: null,
                 movedOn: { at: card.takeover.at }, unknownNote: unknownPromptLine(unknownPromptsOf(events, s.id)), roundFrom: view.origin?.at ?? null, roundHow: view.origin?.from ?? null };
      }
      const t = card?.takeover ? tenureOf(card) : null;
      const shared = t ? t.sessions.find((x) => x.id === s.id)?.sharesCwd === true : s.sharesCwd;
      const st = sessionTier({ card, events: t?.events ?? events, stages, session: s.id, cwd: s.cwd, shared, monitorDir, mainRoot });
      const stagesS = screenStages(st.view.stages, { availableOf: available, noRecord: card && !card.gone ? noRecordOf(card) : null });
      return { ...s, sharesCwd: shared, title, deletedAt: null, closedAt: s.closedAt ?? null, stages: stagesS, card, tier: st.tier, movedOn: null,
               unknownNote: unknownPromptLine(unknownPromptsOf(events, s.id)), roundFrom: st.view?.origin?.at ?? null, roundHow: st.view?.origin?.from ?? null };
    });

    // 跨 worktree 衝突偵測直接複用上面已算好的 cards 與 sessions，零額外 git 呼叫（P2）
    const conflicts = detectConflicts({ cards, sessions: sessionsRaw });
    const cardConflicts = new Map();
    for (const c of cards) {
      if (!c || c.gone || c.notGit) continue;
      const key = real(c.root ?? c.path);
      if (!cardConflicts.has(key)) cardConflicts.set(key, conflictsForWorktree(conflicts, key));
      c.conflicts = cardConflicts.get(key);
    }
    const sessions = sessionsRaw.map((s) => ({
      ...s,
      conflicts: s.movedOn || !s.card || s.card.gone || s.card.notGit
        ? null
        : (s.card.conflicts ?? conflictsForWorktree(conflicts, s.card.root ?? s.card.path)),
    }));

    const displayName = live?.project ?? name;
    const optedOut = mainRoot ? optOutState(mainRoot) : null;
    // 建議另開的對話（AI 用 agy-pipeline --suggest 放的）
    const suggestions = suggestionsOf(events, { firstPrompts: firstPromptsFor(name) });
    const mainCard = cards.find((c) => c.path === mainRoot && !c.gone && !c.notGit) ?? live;
    const m = mainCard?.sensor?.mount ?? null;
    const emptyLine = !sessions.length && evState !== 'no-file'
      ? noRecordLine({ now: sensorNow(faults), here: topBar(), optedOut: !!optedOut || !!m?.optedOut,
                       mount: m && m.state !== 'ok' ? m.state : null, fix: mainCard?.sensor?.fix ?? null })
      : null;
    projects.push({ name, displayName, mainRoot, optedOut, sensorState: evState, cards, sessions, suggestions, conflicts,
                    noRecords: noRecordsWithin(evByName.get(name)), emptyLine,
                    optedOutLine: optedOut ? optedOutLine({ at: optedOut.at, days: RETAIN_DAYS, ago }) : null });
  }

  // 建議卡要講的名字可能落在別的專案
  const sessionIndex = new Map();
  for (const p of projects) for (const s of p.sessions) sessionIndex.set(s.id, { title: s.title ?? zhEn('（還沒有標題）', '(no title yet)'), project: p.name, projectName: p.displayName });
  const projectAt = (path) => projects.find((p) => p.mainRoot === path || p.cards.some((c) => c.path === path)) ?? null;
  for (const p of projects) {
    p.suggestions = p.suggestions.map((sg) => {
      const started = sg.startedBy ? sessionIndex.get(sg.startedBy) ?? null : null;
      const from = sg.session ? sessionIndex.get(sg.session) ?? null : null;
      const pathCut = sg.cut.includes('cwd');
      const tp = sg.target && !pathCut ? projectAt(sg.target) : null;
      const openIn = !sg.target || tp === p ? null
        : pathCut ? { project: null, name: null }
        : { project: tp?.name ?? null, name: tp?.displayName ?? sg.target.split('/').filter(Boolean).pop() ?? null };
      return {
        ...sg,
        openIn,
        startedTitle: started?.title ?? null,
        startedProject: started && started.project !== p.name ? { project: started.project, name: started.projectName } : null,
        fromTitle: from?.title ?? null,
      };
    });
  }
  for (const p of projects) {
    p.incomingSuggestions = projects.filter((q) => q !== p).map((q) => ({
      project: q.name, name: q.displayName,
      count: q.suggestions.filter((sg) => sg.openIn?.project === p.name && cardState(sg) === 'open').length,
    })).filter((x) => x.count > 0);
  }
  const anyRecovered = [faults.sensor, faults.gateNode, faults.gateError, faults.guardNode, faults.guardError, faults.escalateNode, faults.escalateError]
    .some((x) => x?.state === 'recovered' || (Array.isArray(x?.recovered) && x.recovered.length > 0));
  for (const p of projects) {
    const evs = evByName.get(p.name)?.events ?? [];
    for (const s of p.sessions) {
      if (!anyRecovered) { s.faultNotes = []; continue; }
      const start = roundStartFor({ since: s.roundFrom, how: s.roundHow, sessions: [{ id: s.id, cwd: s.cwd }], events: evs, extraTranscripts, home });
      s.faultNotes = faultNotes(faults, { ...start, until: s.closedAt ?? null, cwd: s.cwd });
    }
  }
  return { generatedAt: Date.now(), retainDays: RETAIN_DAYS, projects, faults: { banner: faultBanner(faults), sensor: sensorNow(faults), moving: faults.move !== null },
           sharedLines: { calledNotPassed: calledIsNotPassed({ director: true }) }, stampHelp: stampHelp(), guardSupport: true, precheckSupport: true, escalateSupport: true, conflictSupport: true };
}

/**
 * 為同一專案建立兩階段路徑歸一器（預審 #3／D 第 1 輪，P1/P13/P6）：
 * 透過 gitContext 判斷而不以路徑前綴合併，避免把巢狀獨立 repo／worktree 混進同一工作區。
 * collapseRoot = false 時先記錄每個 real(ctx.root) 已出現的根目錄拼法（如 macOS /var/folders），
 * 讓同工作區底下的子目錄與根目錄捷徑全部對齊同一個拼法、不拆成兩張卡；collapseRoot = true 則一律收攏到 real(ctx.root)。
 */
function buildPathCanonicalizer({ paths = [], knownRoot = null, collapseRoot = false } = {}) {
  const topOf = new Map();
  const canonicalRoot = new Map();
  if (knownRoot) canonicalRoot.set(knownRoot, knownRoot);

  for (const p of paths) {
    if (typeof p !== 'string' || !p || topOf.has(p)) continue;
    let top = null;
    if (knownRoot && p === knownRoot) {
      top = knownRoot;
    } else if (existsSync(p)) {
      const ctx = gitContext(p);
      top = ctx.isGit ? real(ctx.root) : null;
    }
    topOf.set(p, top);
    if (top && !collapseRoot && real(p) === top && !canonicalRoot.has(top)) {
      canonicalRoot.set(top, p);
    }
  }

  return (p) => {
    if (typeof p !== 'string' || !p) return p;
    if (knownRoot && p === knownRoot) return knownRoot;
    const top = topOf.get(p);
    if (!top) return p;
    return collapseRoot ? top : (canonicalRoot.get(top) ?? top);
  };
}

function applyCwdCanon(events, canon) {
  if (!Array.isArray(events) || !events.length) return events;
  let changed = false;
  const out = events.map((e) => {
    const c = e?.cwd;
    if (typeof c !== 'string' || !c) return e;
    const norm = canon(c);
    if (norm === c) return e;
    changed = true;
    return { ...e, cwd: norm };
  });
  return changed ? out : events;
}

function normalizeProjectEventsCwd(events, opts = {}) {
  if (!Array.isArray(events) || !events.length) return events;
  const canon = buildPathCanonicalizer({ paths: events.map((e) => e?.cwd), ...opts });
  return applyCwdCanon(events, canon);
}

/**
 * 子目錄或 symlink 路徑的事件歸一到同一真實 git 工作區（D 第 1 輪 P1/P8/P13）：
 * hook.sh 記的是原始 payload.cwd，escalate.mjs 傳進來的 path 是解析後的 git 根目錄；
 * 若不對齊，buildCard / roundView / specContext / manualTier 的 e.cwd === path 會漏接子目錄／symlink 事件。
 * 只對真實存在且 rev-parse --show-toplevel 等於 gitRoot 的同 repo 路徑歸一，絕不把別的 worktree 或嵌套獨立 repo 混進來。
 */
export function normalizeEventsCwd(events, targetCwd, gitRoot) {
  if (!Array.isArray(events) || !events.length || !targetCwd || !gitRoot) return events;
  const seen = new Map();
  let changed = false;
  const out = events.map((e) => {
    const c = e?.cwd;
    if (typeof c !== 'string' || !c || c === targetCwd) return e;
    let ok = seen.get(c);
    if (ok === undefined) {
      if (existsSync(c)) {
        const top = git(['rev-parse', '--show-toplevel'], real(c));
        ok = Boolean(top && real(top) === gitRoot);
      } else {
        ok = false;
      }
      seen.set(c, ok);
    }
    if (!ok) return e;
    changed = true;
    return { ...e, cwd: targetCwd };
  });
  return changed ? out : events;
}

/**
 * 一張卡:給收工 hook(gate.mjs)與 --round/--decide 用——只算 AI 站的那個工作區,跟 collectAll 走同一個 buildCard(老毛病 P2)。
 * 不是 git 專案回 null。path 要用感測器記的那個 cwd,事件才對得上。
 */
export function cardFor({ monitorDir, path, skillHome = undefined, extraTranscripts = null, sessionId = null, home = undefined }) {
  const logDir = logDirOf(monitorDir);
  const ctx = gitContext(path);
  if (!ctx.isGit) return null;
  const { state: evState, events: rawEvents } = loadEvents(logDir, ctx.project, { extraTranscripts, sessionId, cwd: path, ...(home ? { home } : {}) });
  const events = normalizeEventsCwd(rawEvents, path, real(ctx.root));
  const card = buildCard({ path, name: safeName(ctx.project), events, evState, monitorDir, skillHome });
  const { stages } = loadStages(monitorDir, path, ctx.mainRoot);
  return { card, events: tenureEvents(events, path, card.takeover), stages, ctx, logDir, project: ctx.project };
}

/**
 * 終端機（status.mjs）單一工作區共用衝突偵測：僅看同一專案紀錄與還原點已知的兄弟工作區，
 * 複用當前工作區已算好的事實；單工作區專案直接早退，零額外 git 呼叫（AC-1 / AC-2 / P2）。
 */
export function projectConflictsFor({ monitorDir, ctx, ev, current = {}, skillHome = undefined }) {
  if (!ctx?.isGit) return detectConflicts({ cards: [], sessions: [] });
  const cpDir = dataDir('checkpoints', monitorDir);
  const name = safeName(ctx.project);
  const curKey = real(ctx.root);
  const events = normalizeProjectEventsCwd(ev?.events ?? [], { knownRoot: curKey, collapseRoot: true });
  const worktrees = new Set();
  for (const cp of stampsIn(cpDir, name)) {
    if (typeof cp.worktree !== 'string' || !cp.worktree) continue;
    if (cp.worktree === curKey) { worktrees.add(curKey); continue; }
    if (existsSync(cp.worktree)) {
      const cCtx = gitContext(cp.worktree);
      worktrees.add(cCtx.isGit ? real(cCtx.root) : cp.worktree);
    } else {
      worktrees.add(cp.worktree);
    }
  }
  for (const e of events) {
    if (e.cwd && !e._subagent && e.event !== 'guard_asked' && e.event !== 'tier_notified') worktrees.add(e.cwd);
  }
  const sibByKey = new Map();
  for (const p of worktrees) {
    if (p === curKey || !existsSync(p)) continue;
    const sCtx = gitContext(p);
    if (!sCtx.isGit) continue;
    const sk = real(sCtx.root);
    if (sk !== curKey && !sibByKey.has(sk)) sibByKey.set(sk, sk);
  }
  const siblings = [...sibByKey.values()];
  if (!siblings.length) return detectConflicts({ cards: [], sessions: [] });

  const curCard = {
    path: curKey,
    root: curKey,
    gone: false,
    notGit: false,
    project: ctx.project,
    mainRoot: ctx.mainRoot,
    branch: ctx.branch,
    hasCommits: current.hasCommits ?? ctx.hasCommits,
    takeover: current.takeover?.state === 'ok'
      ? { state: 'ok', at: current.takeover.at, cutMs: current.takeover.cutMs }
      : null,
    dirty: current.dirty ?? null,
    dirtyFiles: current.dirtyFiles ?? null,
    health: current.health ?? null,
    base: basisOf(current.base),
    scope: current.scope ?? null,
    ladder: current.base?.kind === 'checkpoint'
      ? (current.ladder ?? buildLadder(ctx.root, current.dirty))
      : null,
  };
  const cards = [
    curCard,
    ...siblings.map((path) => buildCard({ path, name, events, evState: ev?.state ?? 'no-file', monitorDir, skillHome })),
  ];
  const cardByPath = new Map(cards.map((c) => [c.path, c]));
  const sessions = sessionsOf(events).map((s) => {
    const card = cardByPath.get(s.cwd) ?? null;
    const moved = Boolean(card?.takeover && previousTenant(events, s.cwd, card.takeover, s.id));
    return { ...s, card, movedOn: moved ? { at: card.takeover.at } : null };
  });
  return conflictsForWorktree(detectConflicts({ cards, sessions }), curKey);
}

/**
 * 上一手的五關(規格:新對話接手舊資料夾 AC-5):照它自己當時的紀錄算——這個資料夾換人之前的紀錄,分界是那時候這裡最後一顆章。
 * 資料夾現在的 git 狀態不給它(那是下一手的):B 的證據只剩感測器記到的改檔。
 */
function previousView({ card, events, stages, session, cwd, monitorDir, project }) {
  const before = events.filter((e) => e.cwd !== cwd || beforeTakeover(e, cwd, card.takeover));
  const cp = stampBefore({ dir: dataDir('checkpoints', monitorDir), project, root: cwd, takeover: card.takeover });
  const cfg = readTierConfig(cwd, card.mainRoot ?? null, monitorDir);
  const isCode = codeFileFn(cwd, cfg.state === 'ok' ? cfg.config : null);
  return sessionView(before, stages, session, cp?.at ?? null, cwd, { isCode, mainRoot: card.mainRoot ?? null }).view;
}

function buildCard({ path, name = null, events: allEvents, evState, monitorDir, skillHome, sensorState = null }) {
  const cpDir = dataDir('checkpoints', monitorDir);
  const missing = !existsSync(path);
  // ⚠️ worktree 可能已經被刪掉了。照實說「資料夾不見了」,
  //    不要拿舊資料裝作它還在(R1)。分支問不到了,章只講得出它最後蓋的那一顆。
  if (missing) {
    return { path, gone: true, branch: null, checkpoint: name ? lastStampOf(cpDir, name, path) : null };
  }

  const ctx = gitContext(path);
  // 資料夾在,但不是 git 專案:沒有版本可講。給一張只說這件事的卡,欄位都空著——不要讓 undefined 漏到畫面上
  if (!ctx.isGit) {
    return {
      path, gone: false, notGit: true, project: null, branch: null, checkpoint: null, files: null, lines: cardLines({}),
      // 感測器那一行的字跟 git 專案那張卡同一套(lines;規格:終端機與網頁說同一句)。收工 hook 的心跳全機一份,這張卡也照實帶
      sensor: (() => {
        const mount = mountState(path), gate = gateHeartbeat(logDirOf(monitorDir)), guard = guardHeartbeat(logDirOf(monitorDir)), escalate = escalateHeartbeat(logDirOf(monitorDir));
        return { state: evState, firstSeen: null, lastSeen: null, mount, fix: mountFix(mount), gate, guard, escalate,
                 offLine: sensorOffLine({ mount, lastSeen: null, now: sensorState, here: topBar(), ago, days: RETAIN_DAYS }),
                 noneLine: noneHereLine({ hasLog: evState !== 'no-file', days: RETAIN_DAYS }),
                 lines: sensorParts({ mount, lastSeen: null, gate, guard, escalate, ago, notMountedHow: notMountedHere() }) };
      })(),
    };
  }
  // 這個資料夾最近一次換人(規格:新對話接手舊資料夾):app 把收掉的對話留下的資料夾換一條新分支給新對話——
  // 那之前記在這裡的(A／C／D／E、結論、規格連結、你說處理完了、調高的等級、章)是上一手的,這張卡只算這一手的(events)。
  // 「感測器活著嗎、從什麼時候開始記」講的是整個資料夾,照舊看全部(allEvents)
  const reflog = ctx.hasCommits ? reflogOf(path) : null;          // 一個存檔都沒有就沒有「換過分支」可講(跟終端機同一個條件)
  const takeover = takeoverOf({ reflog, events: allEvents, cwd: path });
  const events = tenureEvents(allEvents, path, takeover);
  // 章:這個資料夾、這條分支、換人之後蓋的那一顆(lib/checkpoint.mjs,終端機同一個函式)
  const cp = checkpointFor({ dir: cpDir, project: ctx.project, root: path, branch: ctx.branch, takeover });
  // ⚠️ L14:章指的版本不在這條分支上(歷史被改寫過)時,不能拿它當基準,更不能給回去的指令。
  //    跟終端機版用同一個判斷,兩邊才會說同一句話。
  const relation = cp ? checkpointRelation(path, cp.commit) : null;
  const since = relation?.state === 'ok' ? cp.commit : null;

  // 「還沒存進保險箱」只有一種算法,住在 lib/git.mjs(-uall:新資料夾裡一個檔案算一個;uncommitted() 數的也是這一份)。
  // 問一次、整張卡都用這一份:三階梯、還原點那一句、存檔與蓋章卡的數字與清單——同一刻四處講同一個數(規格:先講commit再講蓋章 AC-2)
  const dirtySet = dirtyPaths(path);
  const dirty = dirtySet === null ? null : dirtySet.size;

  // ⚠️ Oscar 2026-09-10 讀不懂「未存檔／保險箱」,而且把它讀成 git push。
  // 那是我的比喻沒講清楚:「存進保險箱」只是 commit。
  // 他自己畫過的三階梯(commit → merge → push)本來就在規劃裡,現在補上。
  const ladder = buildLadder(path, dirty);

  // ⚠️ Oscar:「代號無法閱讀,亂碼沒意義」。對——`a79e8d7` 對他沒有任何意義。
  // 版本號與時間才是他認得的東西。SHA 只留給「複製回去的指令」用。
  let version = null;
  try {
    const pk = join(path, 'package.json');
    if (existsSync(pk)) version = JSON.parse(readFileSync(pk, 'utf8')).version ?? null;
  } catch { /* 讀不到就沒有版本號,不要猜 */ }

  // 蓋章那一刻的版本號(從那個 commit 讀,不是現在的)
  let cpVersion = null;
  if (cp?.commit) {
    const raw = git(['show', `${cp.commit}:package.json`], path);
    try { cpVersion = raw ? JSON.parse(raw).version ?? null : null; } catch { cpVersion = null; }
  }

  const { stages, broken: stagesBroken = null, brokenFrom = null } = loadStages(monitorDir, path, ctx.mainRoot);
  const tierCfg = readTierConfig(path, ctx.mainRoot, monitorDir);   // 五關的「程式檔」判斷跟分級同一份
  // 只算感測器自己寫的(有 hook 欄位，且非轉錄檔補入／subagent):--report、按鈕、收工 hook 擋人的紀錄,感測器壞了照樣寫得進去
  const mineTs = allEvents.filter((e) => !e._subagent && !e._fromTranscript && !e._fromFallback && e.cwd === path && e.hook).map((e) => e.ts).filter(Boolean).sort();
  const firstSeen = mineTs[0] ?? null;
  const mount = mountState(path, ctx.mainRoot);
  const lastSeen = mineTs.at(-1) ?? null;   // 「活著嗎」的證據:最後一筆來自這個工作區的紀錄(誠實修補 D)
  const noneLine = lastSeen ? null : noneHereLine({ hasLog: evState !== 'no-file', days: RETAIN_DAYS });
  const gateHb = gateHeartbeat(logDirOf(monitorDir));
  const guardHb = guardHeartbeat(logDirOf(monitorDir));
  const escalateHb = escalateHeartbeat(logDirOf(monitorDir));
  const cleared = new Map();
  for (const e of events) if (e.event === 'stage_cleared' && e.cwd === path) cleared.set(e.stage, e);
  // Claude 記的結論、這一輪改到程式檔的事件:五關與分級共用(跟終端機的 stageFacts 同一份算法)
  const reports = reportsIn(events, (e) => e.cwd === path);
  const isCode = codeFileFn(path, tierCfg.state === 'ok' ? tierCfg.config : null);
  const edits = editsOf(events, (e) => e.cwd === path);
  // 這一輪跑到哪(lib/rounds.mjs 的 roundView):分界是最近一次第一關、或蓋章,取較晚的。
  // 五關、分級的「需要」、收工 hook 都吃這一份;B 的證據除了感測器,還有 git 說改了的檔案的修改時間(L8)
  const runs = runsPerStage(events, stages, (e) => e.cwd === path);
  const cpAtOk = relation?.state === 'ok' ? cp?.at ?? null : null;
  // 「這次改動」的基準(lib/origin.mjs):這一輪的起點由 roundView 算一次,算出來就照那個起點問 git——
  // 五關的 B、分級、存檔與蓋章卡都拿這同一份;沒章時存了幾次檔都從起點算(規格:這一輪的起點)
  // 從 main 併進來、這個資料夾沒動過的檔不算這一輪(規格:併進來的不算這一輪):章的時間、感測器記的改檔給它判斷「自己動過的」
  const change = changeFacts({ root: path, cpCommit: since, cpCommits: relation?.commitsAfter ?? null, cpAt: cpAtOk, hasCommits: ctx.hasCommits, isCode,
                               relationOf: (c) => checkpointRelation(path, c), healthOf: (s, skip) => changeHealth(path, s, { skip }), takeover, reflog, edits, mainRoot: ctx.mainRoot });
  // 規格連結(施工對話認規格):工作區層級只在「這個工作區只有一個對話在動」時套,否則連結只算記它的那個對話(lib/rounds.mjs 的 specContext)
  const here = (e) => e.cwd === path;
  const hereEvents = events.filter((e) => !e._subagent && here(e));
  const view = roundView({
    runs, stages, cleared, reports, edits, isCode, cpAt: cpAtOk,
    gitChanges: change.gitChanges, specFiles: change.specFiles,
    spec: specContext(events, { cwd: path, cpAt: cpAtOk }), root: path, mainRoot: ctx.mainRoot,
    // 結論會過期的關(D)要每一筆結論與決定,才配得出「叫 → 結論」、對得回你說的話(D 多輪先問人)
    reportLog: reportLogIn(events, here), decisions: decisionsIn(events, here), events,
    clearLog: clearLogIn(events, here), mtimeOf: fileTimeOf(path),
    prechecks: prechecksIn(events, here),
    precheckCalls: skillCallsOf(hereEvents, 'spec-precheck', { reportEvent: 'spec_precheck' }),
  });
  const perStage = perStageOfRound(view);
  const { base, health } = change.facts();

  // ⚠️ 他說「5 個檔案」這種數字對使用者沒幫助,要知道**是哪些檔案**。對的。
  // 數量回答不了「我該不該擔心」,檔名可以。跟分級看同一張單子(同一個基準)。
  const files = listChangedFiles(path, ctx.hasCommits ? base.since ?? 'HEAD' : null, dirtySet, health?.skipped ?? []);
  const scale = ctx.hasCommits ? changeScale(path) : null;

  const card = {
    path,
    root: real(ctx.root),
    gone: false,
    project: ctx.project,
    mainRoot: ctx.mainRoot,
    branch: ctx.branch,
    hasCommits: ctx.hasCommits,
    checkpoint: cp,
    // 這個資料夾最近一次換人(規格:新對話接手舊資料夾):對話清單靠它分這一手、上一手(AC-4、AC-5)。沒換過人是 null
    takeover: takeover.state === 'ok' ? { state: 'ok', at: takeover.at, cutMs: takeover.cutMs } : null,
    // 只有 state 是 'ok' 的章才准給回去的指令;章之後有存檔時附上備份分支名(L14)
    checkpointRelation: relation,
    backupBranch: relation?.commitsAfter ? backupBranchName() : null,
    dirty,
    dirtyFiles: dirtySet === null ? null : [...dirtySet].sort(),
    ladder,
    files,
    version,
    cpVersion,
    health,
    // 這個資料夾這一輪最後一次改程式檔(感測器＋檔案本身的時間):對話頁的 D 要不要再跑看它(共用資料夾時也看整個資料夾)
    lastEdit: view.lastEdit,
    // 這張卡的數字從哪裡算起,與要講的那幾句話(lib/scope.mjs;網頁照著畫,不自己寫)。版本代號不給畫面——那只給「回去」的指令用
    base: basisOf(base),
    scope: changeScope(basisOf(base), ago),
    head: ctx.head?.slice(0, 7) ?? null,
    // 分級:跟終端機同一份實作(lib/tier.mjs)。upgradable 是儀表板「調高」唯一准選的等級(比機器算的高)
    tier: withTierLines(buildTier({ root: path, mainRoot: ctx.mainRoot, monitorDir, health, stages, perStage, cleared, events, cwd: path,
                      cpUsable: relation?.state === 'ok', cpAt: cp?.at ?? null, head: ctx.head?.slice(0, 7) ?? null,
                      hasCommits: ctx.hasCommits, reports, spec: view.spec, basis: basisOf(base), rerun: rerunMapOf(view), ago })),
    scale,
    // 還原點與改動那兩段,終端機也講的那幾句(lib/scope.mjs;規格:終端機與網頁說同一句)。「回去」的指令不在這裡,網頁自己組(含 cd)
    lines: cardLines({ stamped: !!cp, relation, scale, commitsNote: changeScope(basisOf(base), ago).commitsNote, unsaved: files?.uncommittedCount ?? null, dirty }),
    // 收工 hook 的心跳(全機一份):沒有 = 從沒跑過。「掛著」不等於「活著」(L13)
    // fix:感測器掛壞了的修法,跟終端機同一句(lib/mount.mjs 的 mountFix;規格:agent回報與故障記號 AC-6)。
    // 故障記號不掛在卡上:全機一份,collectAll 的 faults 那一欄講(以前這裡數 brokenCount,畫面從來沒讀)
    // offLine:設定裡沒掛上的那兩種(退出了、找不到但紀錄還有)要講的那一句,跟終端機同一個函式(lib/faults.mjs 的 sensorOffLine;老毛病 P2)
    // noneLine:沒有來自這裡的紀錄時那一句(lib/faults.mjs 的 noneHereLine,跟終端機同一句)——記過的專案只講得出「N 天內沒有」(規格:90天清空之後的說法 AC-4)
    // lines:已掛上、最後一筆、掛壞了、收工 hook、沒掛上那幾句,跟終端機同一句(lib/faults.mjs 的 sensorParts;規格:終端機與網頁說同一句)。
    //   沒掛上那一句的「怎麼掛」:網頁叫你去那個資料夾跑(終端機給指令,AC-4)
    sensor: { state: evState, firstSeen, lastSeen, mount, fix: mountFix(mount), gate: gateHb, guard: guardHb, escalate: escalateHb,
              offLine: sensorOffLine({ mount, lastSeen, now: sensorState, here: topBar(), ago, days: RETAIN_DAYS }),
              noneLine,
              lines: sensorParts({ mount, lastSeen, gate: gateHb, guard: guardHb, escalate: escalateHb, ago, notMountedHow: notMountedHere() }) },
    // 專案自己寫的關卡讀不懂:退回內建的五關,這一句跟終端機同一句(lib/rounds.mjs)
    stagesNote: stagesBroken ? stagesBrokenLine(stagesBroken, brokenFrom) : null,
    // 「沒有紀錄」跟「這裡根本沒有這個指令」要分開講(lib/skills.mjs);沒有 skill 的關(B、E)不適用
    stages: screenStages(view.stages, { availableOf: (st) => (st.skill ? skillAvailable(st.skill, path, ctx.mainRoot, skillHome).found : null),
                                        noRecord: evState === 'ok' ? null : noneLine ?? zhEn('沒有紀錄', 'No record') }),
  };
  return card;
}

/**
 * 給畫面的那一格:「要不要再跑」那一句與「上一輪從叫到記結論幾分鐘」,伺服器照 lib/rounds.mjs 算好放進去——
 * 網頁不 import lib(常駐服務只送白名單裡的檔),自己再寫一份就是第二個真相來源(D 多輪先問人 AC-9、AC-13,老毛病 P2)。
 * 每一次叫的整份紀錄不送:畫面用不到,又大。took 只在最後一次跑完時給——還在跑的那一次照舊只講「N 分鐘前叫的」(AC-13)。
 * E 驗收那一格的三句話與逐條的清單(E 自動驗收 AC-7)也在這裡照 lib/verify.mjs 算好:要驗哪幾條跟 A 那格的清單同一份(AC-4)。
 * 你說驗收過了的那一筆只送畫面要講的(誰記的、你那句話),不送整筆紀錄。
 */
function forScreen(st) {
  if (!st.rerun && st.type !== 'browser') return st;
  const r = st.rerun;
  const out = { ...st };
  if (r) out.rerun = { state: r.state, estate: r.estate ?? null, line: rerunLine(r, { ago }), took: r.took?.latest ? tookLine(r.took, { unit: st.type === 'browser' ? 'walk' : 'round' }) : null };
  if (st.type === 'browser') {
    out.elines = eLines(st, { ago });   // 要驗哪幾條是 roundView 算好掛在這一格的(st.verify)
    out.ewhere = eWhere(st);
    const a = st.accept;
    out.accept = a ? { valid: a.valid, stale: a.stale, by: a.by ?? null, rejected: a.rejected?.why ?? null } : null;
    delete out.acceptDecision;   // 你那句話已經在三句話裡了;整筆決定的紀錄畫面用不到
  }
  return out;
}

/**
 * 給畫面的五關:每一格附上那一句(line)與寫規格那一關的旁白(notes),A 那格的清單附上它的那幾句(checklist.lines)——
 * 跟終端機同一個函式(lib/stageLines.mjs),網頁照印,不另寫一份(規格:終端機與網頁說同一句 AC-1;老毛病 P2)。
 * ⚠️ 舊的欄位一個都不拿掉:合併之後、分頁重新載入之前那幾秒,舊的畫面還拿這些欄位自己畫。
 * ⚠️ 那一句要拿**原本的** rerun 算(forScreen 會把它換成只剩給畫面的那幾欄)。
 * @param availableOf 這一關的指令找不找得到(沒有 skill 的關回 null)
 * @param noRecord    卡片的感測器讀不到東西時,還沒跑的那一格改講的那一句(實測走不到;規格:90天清空之後的說法 AC-3)
 */
export function screenStages(view, { availableOf = () => null, noRecord = null } = {}) {
  const first = view.find((v) => v.skill)?.id ?? null;
  return view.map((st) => {
    const available = availableOf(st);
    const out = { ...forScreen(st), available,
                  line: stageLine(st, { ago, first: st.id === first, available, noRecord }),
                  // 網頁本身就是儀表板:好幾個對話共用資料夾時不叫你「看儀表板」(AC-4)
                  notes: specNotes(st, { ago, seePages: zhEn('看各對話的頁面', 'see each conversation\'s page') }) };
    if (st.checklist && Array.isArray(st.checklist.items)) out.checklist = { ...st.checklist, lines: checklistLines(st.checklist) };
    if (st.precheck) {
      out.precheck = {
        state: st.precheck.state,
        stale: st.precheck.stale === true,
        line: precheckLine(st.precheck, { ago }),
        items: precheckItems(st.precheck),
        head: String(st.precheck.note ?? '').split('\n')[0].trim() || null,
      };
    }
    return out;
  });
}

/**
 * 還原點與改動那兩張卡要講的那幾句(lib/scope.mjs,終端機印同一句)。網頁照印;大字、檔案清單、複製回去的指令是網頁自己的版面。
 * @param stamped 有沒有章;relation:章跟現在的版本是什麼關係(問不到是 null——也算失效,L14);unsaved:改過的檔案裡還沒存的有幾個(問不到給 null)
 */
export function cardLines({ stamped = false, relation = null, scale = null, commitsNote = null, unsaved = null, dirty = null }) {
  return {
    notStamped: noStampYet(),
    green: greenIsNotCorrect(),
    broken: stamped && relation?.state !== 'ok' ? stampBrokenReason(relation) : null,
    scale: scale ? scaleLine(scale, commitsNote) : null,
    unsaved: unsaved ? unsavedLine(unsaved) : null,
    unsavedUnknown: unsavedUnknown(),
    // 還原點那一行(跟終端機「怎麼回去」同一句)、存檔與蓋章卡問不到時那一句(規格:先講commit再講蓋章 AC-6、AC-9)。
    // dirty 跟三階梯、卡片清單是同一份;上面兩欄舊的畫面還在用,只加不拿
    restoreUnsaved: restoreUnsavedLine(dirty),
    unsavedWhether: unsavedWhether(),
  };
}

/** 分級卡帶著它的那幾句給網頁(lib/tier.mjs 的 tierLines,終端機印同一句)。沒有分級(資料夾不在了)就照舊 */
const withTierLines = (t) => (t ? { ...t, lines: tierLines(t, { ago }) } : t);

/** 卡片的感測器讀不到東西時,還沒跑的那一格要講的那一句(網頁以前在畫面上自己判斷;照搬到這裡) */
const noRecordOf = (card) => (card?.sensor && card.sensor.state !== 'ok' ? card.sensor.noneLine ?? zhEn('沒有紀錄', 'No record') : null);

/** 卡片與分級要帶的基準:畫面只需要「哪一種、從哪裡算起、中間動過沒、存了幾次」,不需要版本代號 */
const basisOf = (b) => (b ? { kind: b.kind, why: b.why ?? null, origin: b.origin ?? null, moved: b.moved === true, commits: b.commits ?? null, merged: b.merged ?? 0 } : null);

/**
 * 一個對話的分級與「這次改動」——對話頁與收工 hook(gate.mjs)都只呼叫這裡,兩邊才說同一句話(老毛病 P2)。
 * 分級一個資料夾一份,就是卡片那份:共用資料夾時從最早開口的那個對話算起、明講含幾個對話(規格:這一輪的起點 AC-3)。
 *   ⚠️ 本來共用時按對話各算一份——魔鬼教官 2026-09-22 抓到它跟「調高」(按資料夾記、伺服器拿卡片驗)、終端機、案件首頁
 *      講不同的話:對話頁按調高沒反應、終端機跟收工 hook 等級不同。一個資料夾一份,多算的那一邊(別的對話存的檔)畫面照實講。
 * 寫規格那一行、結論會過期的關(D)那一行按**這個對話**算(施工對話認規格 AC-2、AC-7;D 多輪先問人 AC-9):
 *   規格連結只算記它的那個對話;D 要不要再跑,跟收工 hook 看同一個對話的叫與結論。
 * @returns {{ tier, health, base, files, scope, view }}  view 是這個對話的 roundView 結果(五關、規格線索)
 */
export function sessionTier({ card, events, stages, session, cwd, shared, monitorDir, mainRoot = null }) {
  const live = card && !card.gone && !card.notGit;
  const cfg = cwd ? readTierConfig(cwd, card?.mainRoot ?? null, monitorDir) : { state: 'unset' };
  const isCode = codeFileFn(cwd ?? '', cfg.state === 'ok' ? cfg.config : null);
  // 蓋章時間(一輪的分界之一)是工作區層級的事實,從卡片那份帶過來
  const cpAt = card?.checkpointRelation?.state === 'ok' ? card.checkpoint?.at ?? null : null;
  // git 說的改動是整個工作區的:這個工作區只有這一個對話時才算它在動的證據(用 Bash 寫檔感測器看不到,L8);共用時不猜是誰改的
  const gitChanges = !shared && live ? () => gitCodeChanges(cwd, card.health?.list ?? null, isCode) : [];
  // 這一輪動了的規格檔(A 那格講「這一輪還動了 X.md」):跟 gitChanges 同一條規則——共用資料夾時不猜是誰動的
  const specFiles = !shared && live ? () => specFilesOf(card.health?.list ?? null, cwd) : null;
  // 主資料夾:卡片知道就用卡片的;資料夾已經不在的卡沒有,用專案的(呼叫端給)——規格多半已經併進去了
  // D 要不要再跑看整個資料夾的最後一次改檔(卡片算的那一份):分級一個資料夾一份,別的對話在 D 之後改了也要問(D 多輪先問人 AC-9)
  const sv = sessionView(events, stages, session, cpAt, cwd, { isCode, gitChanges, specFiles, mainRoot: card?.mainRoot ?? mainRoot, folderEdit: card?.lastEdit ?? null,
                                                              mtimeOf: !shared && live ? fileTimeOf(cwd) : null });
  const specStage = stages.find((x) => x.skill);
  // 結論會過期的關(D)那一行也按這個對話算:跟收工 hook、對話頁的 D 那一格同一份判斷(D 多輪先問人 AC-9)
  const rerunKeys = new Set(stages.filter((x) => x.rerunAfterChange).map((x) => x.id));
  const t = card?.tier ?? null;
  // 「需要」那幾行換成這個對話的之後,分級卡的那幾句要照換過的重算(tier.lines;規格:終端機與網頁說同一句)
  const tier = t?.state === 'ok' && Array.isArray(t.requirements)
    ? withTierLines({ ...t, spec: sv.view.spec, requirements: t.requirements.map((r) => (r.key !== specStage?.id && !rerunKeys.has(r.key) ? r
        : requirementStatus([r.key], { stages, perStage: perStageOfRound(sv.view), cleared: sv.cleared, health: card.health, reports: sv.reports,
                                       spec: sv.view.spec, rerun: rerunMapOf(sv.view), ago })[0])) })
    : t;
  return { tier, health: card?.health ?? null, base: card?.base ?? null, files: card?.files ?? null, scope: card?.scope ?? null, view: sv.view };
}

/**
 * 「東西走到哪了」的三階梯——Oscar 自己畫的那張圖:
 *   ① commit 存進這條分支的歷史 → ② merge 併進 main → ③ push 推到 GitHub
 * ⚠️ 每一階都可能「問不到」,那時要回 null,呼叫端必須說「問不到」而不是「沒有」。
 */
function buildLadder(cwd, uncommittedCount = uncommitted(cwd)) {
  // 還沒存的個數:同一種算法(lib/git.mjs),不要在這裡再算一次——卡片那邊問過了就直接拿那一份(規格:先講commit再講蓋章 AC-2)

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const mainRef = ['main', 'master'].find((m) => git(['rev-parse', '--verify', '-q', m], cwd));
  // 已經在 main 上的話,「還沒併進 main」這個問題不成立——照實說,不要硬湊一個數字
  const onMain = branch === mainRef;
  // 「跟 main 沒有差別」有兩種:HEAD 就是 main 的尖端(空的分支),或 HEAD 落在 main 後面(早就併進去了)。分得出來就要分
  const atMainTip = mainRef ? git(['rev-parse', 'HEAD'], cwd) === git(['rev-parse', mainRef], cwd) : null;
  const unmerged = !mainRef ? null
    : onMain ? 0
    : Number(git(['rev-list', '--count', `${mainRef}..HEAD`], cwd) ?? NaN);

  // 快轉合併之後分支尖端跟 main 一模一樣,光看 ref 跟「剛開出來、什麼都沒做的空分支」分不出來
  // (Oscar 2026-09-15:「為什麼 merge 沒亮?」——老毛病 P5:一個 0 有兩種意思)。
  // git 的 reflog 留著證據:main 的紀錄會寫「merge <分支>: Fast-forward」;空分支自己的紀錄只有「Created from」那一筆。
  // 讀不到(reflog 關掉、過期)就是 null,呼叫端要說「分不出來」,不准猜。
  const lines = (o) => String(o ?? '').split('\n').filter(Boolean);
  const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mainLog = mainRef && !onMain ? lines(git(['reflog', 'show', '--format=%gs', mainRef], cwd)) : [];
  const mergedIntoMain = !mainLog.length ? null
    : mainLog.some((l) => new RegExp(`^merge ${escapeRe(branch ?? '')}(?::|\\s|$)`).test(l));
  const branchLog = branch && branch !== 'HEAD' ? lines(git(['reflog', 'show', '--format=%gs', branch], cwd)) : [];
  const branchMoved = !branchLog.length ? null : branchLog.some((l) => !/^branch: Created/.test(l));

  // push 那一格一律看 main,不看這條分支(Oscar 2026-09-15:「不要分分支還 main」)。
  // 他的工作方式是分支在本機併進 main、再推 main,分支本身從來不推——問「這條分支推了沒」永遠答不到他要的:
  // 併完之後分支跟 main 一模一樣,卡片說「還沒有東西可以 push」,而 main 上明明有 4 個存檔沒推。
  const mainUpstream = mainRef ? git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${mainRef}@{u}`], cwd) : null;
  const mainUnpushed = mainUpstream === null ? null
    : Number(git(['rev-list', '--count', `${mainRef}@{u}..${mainRef}`], cwd) ?? NaN);

  // GitHub 連結:把 remote 網址正規化成可以點的 https(SSH 形式也要能轉)
  const remote = git(['remote', 'get-url', 'origin'], cwd);
  let webUrl = null;
  if (remote) {
    const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (m) webUrl = `https://github.com/${m[1]}`;
  }

  const fields = {
    uncommitted: uncommittedCount,
    unmerged: Number.isFinite(unmerged) ? unmerged : null,
    onMain,
    atMainTip,
    mainName: mainRef ?? null,
    mergedIntoMain,
    branchMoved,
    mainHasUpstream: mainUpstream !== null,
    mainUnpushed: Number.isFinite(mainUnpushed) ? mainUnpushed : null,
    webUrl,
    branch,
  };
  return { ...fields, steps: ladderSteps(fields) };
}

/**
 * 三階梯每一格的狀態與文案(誠實修補 F,2026-09-11)。純函式,scripts/collect.test.mjs 釘住。
 * ⚠️ 「沒有東西要做」跟「做完了」是兩件事,不准畫成同一個亮燈。
 *    Oscar 開了一個新對話、一個字都沒改,三階梯就亮了兩格「都存好了／已經併進去了」——
 *    燈亮的意思是「有東西,而且走到這一步了」;空的分支什麼都沒走,一格都不該亮(LESSONS L16)。
 *    `unmerged === 0` 有兩種意思(沒有東西要併／早就併進去了),git 分不出來,所以文案照實說分不出來。
 * @returns {Array<{id:'commit'|'merge'|'push', state:'pending'|'done'|'none'|'unknown', text:string}>}
 *   只有 'done' 亮燈;'none' 是「沒有東西」,'unknown' 是「問不到」——四種刻意分開,畫面不准折成兩種。
 */
export function ladderSteps({ uncommitted, unmerged, onMain, mainName, mainHasUpstream, mainUnpushed, atMainTip = null,
                              mergedIntoMain = null, branchMoved = null }) {
  // 這條分支上有沒有 main 還沒有的東西。main 自己永遠算有;問不到的時候也當有(不要把「沒問到」講成「沒東西」)
  const hasWork = onMain || unmerged === null || unmerged > 0;
  const m = mainName ?? zhEn('主線', 'the main line');
  const merged = zhEn(`早就併進 ${m} 了（${m} 之後又往前走了）`, `merged into ${m} a while ago (${m} has moved on since)`);

  const commit = uncommitted === null ? { state: 'unknown', text: zhEn('問不到有沒有沒存的檔案', 'couldn\'t check for files not committed yet') }
    : uncommitted > 0 ? { state: 'pending', text: zhEn(`還有 ${uncommitted} 個檔案沒存`, `${plural(uncommitted, 'file')} not committed yet`) }
    : hasWork ? { state: 'done', text: zhEn('都存好了', 'all committed') }
    : { state: 'none', text: zhEn('還沒有任何改動要存', 'no changes to commit yet') };

  const merge = !mainName ? { state: 'unknown', text: zhEn('找不到 main／master 分支,不知道要併去哪', 'can\'t find a main/master branch, so there\'s nowhere known to merge into') }
    : onMain ? { state: 'none', text: zhEn(`你就在 ${m} 上,不用併`, `you're on ${m}, nothing to merge`) }
    : unmerged === null ? { state: 'unknown', text: zhEn(`問不到跟 ${m} 差幾個存檔`, `couldn't check how many commits this is apart from ${m}`) }
    : unmerged > 0 ? { state: 'pending', text: zhEn(`這條分支還多 ${unmerged} 個存檔沒併`, `this branch has ${plural(unmerged, 'commit')} not merged yet`) }
    // 差 0 個有兩種意思:空的分支(沒有東西要併),或這條的東西都併進去了(做完了)。光看 ref 分不出來,
    // 要問 reflog(老毛病 P5):main 的紀錄有「merge 這條分支」→ 併進去了;分支自己的紀錄只有「開出來」那一筆 → 空的。
    : mergedIntoMain === true ? { state: 'done', text: atMainTip === false ? merged : zhEn(`併進 ${m} 了（快轉,${m} 之後還沒動）`, `merged into ${m} (fast-forward; ${m} hasn't moved since)`) }
    : branchMoved === false ? { state: 'none', text: atMainTip === false ? zhEn(`這條分支是空的,${m} 自己往前走了——沒有東西要併`, `this branch is empty and ${m} has moved on by itself: nothing to merge`)
      : zhEn(`這條分支是空的,跟 ${m} 一模一樣——沒有東西要併`, `this branch is empty, identical to ${m}: nothing to merge`) }
    // 分支的存檔全在 main 上、main 又往前走了:不管怎麼進去的,這條分支現在的東西都在 main 上
    : atMainTip === false ? { state: 'done', text: merged }
    : { state: 'none', text: zhEn(`跟 ${m} 沒有差別——沒有東西要併,或早就併進去了,這次分不出來`, `no difference from ${m}: either there's nothing to merge or it was merged already; can't tell this time`) };

  // push 看的是 main,不管這張卡是哪條分支:分支在本機併、只推 main(Oscar 2026-09-15)。
  // 「main 沒連到 GitHub」是事實不是問不到,但也沒有東西可做,所以是 none、不亮燈(L16)
  const push = !mainName ? { state: 'unknown', text: zhEn('找不到 main／master 分支,不知道要推什麼', 'can\'t find a main/master branch, so it doesn\'t know what to push') }
    : !mainHasUpstream ? { state: 'none', text: zhEn(`${m} 沒有連到 GitHub,沒有地方可以 push`, `${m} isn't connected to GitHub, so there's nowhere to push`) }
    : mainUnpushed === null ? { state: 'unknown', text: zhEn(`問不到 ${m} 跟 GitHub 差幾個存檔`, `couldn't check how many commits ${m} is apart from GitHub`) }
    : mainUnpushed > 0 ? { state: 'pending', text: zhEn(`${m} 有 ${mainUnpushed} 個新存檔可以 push`, `${m} has ${plural(mainUnpushed, 'new commit')} to push`) }
    : { state: 'done', text: zhEn(`GitHub 上的跟 ${m} 一樣`, `GitHub matches ${m}`) };

  return [{ id: 'commit', ...commit }, { id: 'merge', ...merge }, { id: 'push', ...push }];
}

/** 改過哪些檔案——依資料夾分組。⚠️ 一定要含未追蹤的新檔案(LESSONS L2,踩過兩次)。
 *  dirtySet:還沒 commit 的是哪些(lib/git.mjs 的 dirtyPaths;呼叫端問過就傳進來,整張卡同一份) */
function listChangedFiles(cwd, base, dirtySet = dirtyPaths(cwd), skip = []) {
  // base 由呼叫端決定(章、起點的版本、或 HEAD);只有零 commit 的專案才會是 null
  // skip:從 main 併進來、這個資料夾沒動過的檔(changeHealth 拿掉的那幾個)——跟分級同一張單子,這裡也不列(規格:併進來的不算這一輪)
  // --no-renames:搬過家的檔新舊兩個路徑都列——只列新路徑的話,搬走危險清單上的檔,分級就看不到它(老毛病 P1,魔鬼教官 2026-09-22)。
  //   跟 changeHealth(lib/git.mjs)同一種問法,清單才會跟分級是同一張(P2)
  // 跟 git() 問的是同一題(同一次刷新裡共用答案),只是不切空白;檔名換回沒加引號的樣子,才對得上 dirtySet(lib/git.mjs 的 unquotePath)
  const ask = (args) => gitRaw(['-c', 'core.quotepath=false', ...args], cwd);
  const tracked = ask(['diff', '--name-only', '--no-renames', ...(base ? [base] : [])]);
  const untracked = ask(['ls-files', '--others', '--exclude-standard']);
  if (tracked === null && untracked === null) return null;   // 問不到 ≠ 沒有

  const namesOf = (out) => (out ?? '').split('\n').filter(Boolean).map(unquotePath);
  const newSet = new Set(namesOf(untracked));
  const drop = new Set(skip.map(unquotePath));
  const all = [...new Set([...namesOf(tracked).filter((f) => !drop.has(f)), ...newSet])].sort();
  // ⚠️ 「改過」跟「還沒存」是兩件事:蓋章之後 commit 過的檔案也算改過,但它已經存了。
  //    以前只列檔名,Oscar 把「蓋章後還沒檢查的 5 個」讀成「還沒 commit 的 5 個」(2026-09-15)。每個檔案都標清楚。
  const grouped = (paths) => {
    const groups = new Map();
    for (const f of paths) {
      const i = f.lastIndexOf('/');
      const dir = i === -1 ? zhEn('根目錄', '(top folder)') : f.slice(0, i);
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push({ name: i === -1 ? f : f.slice(i + 1), isNew: newSet.has(f), uncommitted: dirtySet ? dirtySet.has(f) : null });
    }
    return [...groups].map(([dir, items]) => ({ dir, items }));
  };
  // 存檔與蓋章卡先講 commit 了沒(規格:先講commit再講蓋章 AC-1~AC-3)。還沒 commit 的是 git status 的全部,
  // 不是上面這張單子裡標了還沒存的那幾個:改了、commit、又改回起點那時候的樣子的檔,不在「改過的」單子裡,三階梯卻算它(AC-2,老毛病 P2)。
  // 已經 commit 的 = 這張單子扣掉還沒 commit 的;問不到哪些還沒 commit,也就分不出哪些已經 commit
  const unsaved = dirtySet === null ? null : [...dirtySet].sort();
  const saved = dirtySet === null ? null : all.filter((f) => !dirtySet.has(f));
  return { total: all.length, newCount: newSet.size,
           uncommittedCount: dirtySet === null ? null : all.filter((f) => dirtySet.has(f)).length,
           groups: grouped(all),
           unsaved: unsaved && { count: unsaved.length, groups: grouped(unsaved) },
           saved: saved && { count: saved.length, groups: grouped(saved) } };
}
