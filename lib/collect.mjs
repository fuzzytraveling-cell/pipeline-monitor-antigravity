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
import { readEvents, loadStages, lastRunPerStage } from './events.mjs';

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
    projects.push({ name, sensorState: evState, cards });
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
    health: ctx.hasCommits ? changeHealth(path, since) : null,
    scale: ctx.hasCommits ? changeScale(path) : null,
    sensor: { state: evState, brokenCount: broken.length, firstSeen },
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
