/**
 * collect.mjs —— 把「這台機器上我知道的所有專案」整理成一份 JSON
 *
 * ⚠️ **只列出有證據的專案**(有紀錄檔或有還原點)。
 *    這是刻意的:它不去猜你電腦裡有哪些 git repo,也不掃你的硬碟。
 *    沒有證據就不出現——**不知道的事情就不要出現在畫面上**。
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitContext, changeHealth, changeScale, git } from '../status.mjs';
import { readEvents, loadStages, lastRunPerStage, sessionsOf, stagesOfSession } from './events.mjs';
import { mountState } from './mount.mjs';

export function collectAll({ monitorDir }) {
  const logDir = join(monitorDir, 'logs');
  const cpDir = join(monitorDir, 'checkpoints');

  // 證據來源一:感測器紀錄。來源二:還原點。兩邊的專案名取聯集。
  const names = new Set();
  for (const [dir, re] of [[logDir, /^(.+)\.jsonl$/], [cpDir, /^(.+?)__.+\.json$/]]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      // ⚠️ 隱藏檔要跳過。L4 那個「專案名算成 `.`」的 bug 留下的檔案叫 `.__main.json`,
      // 它是隱藏檔,所以 `ls` 看不到——而畫面上會多出一個叫「.」的專案。
      // 資料清掉不算修好:程式本身不准讓一個爛檔名變成畫面上的一張卡。
      if (f.startsWith('.') || f.startsWith('_')) continue;
      const m = f.match(re);
      const nm = m?.[1]?.trim();
      if (nm && nm !== '.' && nm !== '..') names.add(nm);
    }
  }

  const projects = [];
  for (const name of [...names].sort()) {
    // 一個專案可能有好幾個 worktree,每個 worktree 一張卡(AC-5)。
    const worktrees = new Map();

    for (const f of existsSync(cpDir) ? readdirSync(cpDir) : []) {
      if (!f.startsWith(`${name}__`)) continue;
      try {
        const cp = JSON.parse(readFileSync(join(cpDir, f), 'utf8'));
        worktrees.set(cp.worktree, { checkpoint: cp });
      } catch { /* 讀不到就當沒有,不要讓一個壞檔害死整頁 */ }
    }

    const { state: evState, events, broken } = readEvents(logDir, name);
    for (const e of events) if (e.cwd && !worktrees.has(e.cwd)) worktrees.set(e.cwd, {});

    const cards = [];
    for (const [path, seed] of worktrees) {
      cards.push(buildCard({ path, seed, name, events, evState, broken, monitorDir }));
    }

    // 對話層(Oscar 的真正工作單位)。每個對話掛在它自己的工作區上。
    const { stages } = loadStages(monitorDir, cards[0]?.path ?? '');
    const sessions = sessionsOf(events).map((s) => ({
      ...s,
      stages: stagesOfSession(events, stages, s.id),
      card: cards.find((c) => c.path === s.cwd) ?? null,
    }));

    projects.push({ name, sensorState: evState, cards, sessions });
  }
  return { generatedAt: Date.now(), projects };
}

function buildCard({ path, seed, events, evState, broken, monitorDir }) {
  const missing = !existsSync(path);
  // ⚠️ worktree 可能已經被刪掉了。照實說「資料夾不見了」,
  //    不要拿舊資料裝作它還在(R1)。
  if (missing) {
    return { path, gone: true, branch: null, checkpoint: seed.checkpoint ?? null };
  }

  const ctx = gitContext(path);
  const cp = seed.checkpoint ?? null;
  const since = cp?.commit ?? null;

  let changedSince = null;
  if (since) {
    const d = git(['diff', '--name-only', since], path);
    const u = git(['ls-files', '--others', '--exclude-standard'], path);
    // 同一個坑踩過兩次(LESSONS L2):git diff 看不到未追蹤的新檔案。
    changedSince = d === null ? null
      : new Set([...d.split('\n'), ...(u ?? '').split('\n')].filter(Boolean)).size;
  }

  const dirtyOut = git(['status', '--porcelain'], path);
  const dirty = dirtyOut === null ? null : dirtyOut.split('\n').filter(Boolean).length;

  // ⚠️ Oscar 2026-09-10 讀不懂「未存檔／保險箱」,而且把它讀成 git push。
  // 那是我的比喻沒講清楚:「存進保險箱」只是 commit。
  // 他自己畫過的三階梯(commit → merge → push)本來就在規劃裡,現在補上。
  const ladder = buildLadder(path);

  // ⚠️ 他說「5 個檔案」這種數字對使用者沒幫助,要知道**是哪些檔案**。對的。
  // 數量回答不了「我該不該擔心」,檔名可以。
  const files = listChangedFiles(path, since);

  // ⚠️ Oscar:「代號無法閱讀,亂碼沒意義」。對——`a79e8d7` 對他沒有任何意義。
  // 版本號與時間才是他認得的東西。SHA 只留給「複製回去的指令」用。
  let version = null;
  try {
    const pk = join(path, 'package.json');
    if (existsSync(pk)) version = JSON.parse(readFileSync(pk, 'utf8')).version ?? null;
  } catch { /* 讀不到就沒有版本號,不要猜 */ }

  // 蓋章那一刻的版本號(從那個 commit 讀,不是現在的)
  let cpVersion = null;
  if (seed.checkpoint?.commit) {
    const raw = git(['show', `${seed.checkpoint.commit}:package.json`], path);
    try { cpVersion = raw ? JSON.parse(raw).version ?? null : null; } catch { cpVersion = null; }
  }

  const { stages } = loadStages(monitorDir, path);
  const { perStage } = lastRunPerStage(events, stages, path);
  const firstSeen = events.filter((e) => e.cwd === path).map((e) => e.ts).sort()[0] ?? null;
  const cleared = new Map();
  for (const e of events) if (e.event === 'stage_cleared' && e.cwd === path) cleared.set(e.stage, e);

  return {
    path,
    gone: false,
    project: ctx.project,
    branch: ctx.branch,
    hasCommits: ctx.hasCommits,
    checkpoint: cp,
    changedSince,
    dirty,
    ladder,
    files,
    version,
    cpVersion,
    health: ctx.hasCommits ? changeHealth(path, since) : null,
    scale: ctx.hasCommits ? changeScale(path) : null,
    sensor: { state: evState, brokenCount: broken.length, firstSeen, mount: mountState(path) },
    stages: stages.map((s) => {
      const run = perStage.get(s.id) ?? null;
      const clr = cleared.get(s.id) ?? null;
      return {
        id: s.id, name: s.name, type: s.type ?? null,
        ranAt: run?.ts ?? null, args: run?.args ?? null,
        clearedAt: clr && run && new Date(clr.ts) >= new Date(run.ts) ? clr.ts : null,
      };
    }),
  };
}

/**
 * 「東西走到哪了」的三階梯——Oscar 自己畫的那張圖:
 *   ① commit 存進這條分支的歷史 → ② merge 併進 main → ③ push 推到 GitHub
 * ⚠️ 每一階都可能「問不到」,那時要回 null,呼叫端必須說「問不到」而不是「沒有」。
 */
function buildLadder(cwd) {
  const dirtyOut = git(['status', '--porcelain'], cwd);
  const uncommitted = dirtyOut === null ? null : dirtyOut.split('\n').filter(Boolean).length;

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const mainRef = ['main', 'master'].find((m) => git(['rev-parse', '--verify', '-q', m], cwd));
  // 已經在 main 上的話,「還沒併進 main」這個問題不成立——照實說,不要硬湊一個數字
  const onMain = branch === mainRef;
  const unmerged = !mainRef ? null
    : onMain ? 0
    : Number(git(['rev-list', '--count', `${mainRef}..HEAD`], cwd) ?? NaN);

  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
  const unpushed = upstream === null ? null
    : Number(git(['rev-list', '--count', '@{u}..HEAD'], cwd) ?? NaN);

  // GitHub 連結:把 remote 網址正規化成可以點的 https(SSH 形式也要能轉)
  const remote = git(['remote', 'get-url', 'origin'], cwd);
  let webUrl = null;
  if (remote) {
    const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (m) webUrl = `https://github.com/${m[1]}`;
  }

  return {
    uncommitted,
    unmerged: Number.isFinite(unmerged) ? unmerged : (unmerged === null ? null : null),
    onMain,
    mainName: mainRef ?? null,
    hasUpstream: upstream !== null,
    unpushed: Number.isFinite(unpushed) ? unpushed : null,
    webUrl,
    branch,
  };
}

/** 改過哪些檔案——依資料夾分組。⚠️ 一定要含未追蹤的新檔案(LESSONS L2,踩過兩次)。 */
function listChangedFiles(cwd, since) {
  const tracked = git(['diff', '--name-only', ...(since ? [since] : [])], cwd);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd);
  if (tracked === null && untracked === null) return null;   // 問不到 ≠ 沒有

  const newSet = new Set((untracked ?? '').split('\n').filter(Boolean));
  const all = [...new Set([...(tracked ?? '').split('\n'), ...newSet].filter(Boolean))].sort();

  const groups = new Map();
  for (const f of all) {
    const i = f.lastIndexOf('/');
    const dir = i === -1 ? '根目錄' : f.slice(0, i);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push({ name: i === -1 ? f : f.slice(i + 1), isNew: newSet.has(f) });
  }
  return { total: all.length, newCount: newSet.size,
           groups: [...groups].map(([dir, items]) => ({ dir, items })) };
}
