/**
 * collect.mjs —— 把「這台機器上我知道的所有專案」整理成一份 JSON
 *
 * ⚠️ **只列出有證據的專案**(有紀錄檔或有還原點)。
 *    這是刻意的:它不去猜你電腦裡有哪些 git repo,也不掃你的硬碟。
 *    沒有證據就不出現——**不知道的事情就不要出現在畫面上**。
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitContext, changeHealth, changeScale, git, uncommitted, checkpointRelation, backupBranchName } from '../status.mjs';
import { readEvents, loadStages, lastRunPerStage, sessionsOf, stagesOfSession, SENSOR_FILE } from './events.mjs';
import { mountState, optOutState } from './mount.mjs';
import { buildTier } from './tier.mjs';
import { monitorHome } from './paths.mjs';

export function collectAll({ monitorDir }) {
  // 資料住在 repo 的主資料夾,不管儀表板是從哪個 worktree 跑的(lib/paths.mjs);
  // 紀錄位置跟 hook.sh／status.mjs 看同一個環境變數,否則寫的跟讀的不是同一份(老毛病 P2)
  const home = monitorHome(monitorDir);
  const logDir = process.env.PIPELINE_MONITOR_LOG_DIR ?? join(home, 'logs');
  const cpDir = join(home, 'checkpoints');

  // 證據來源一:感測器紀錄。來源二:還原點。兩邊的專案名取聯集。
  const names = new Set();
  for (const [dir, re] of [[logDir, /^(.+)\.jsonl$/], [cpDir, /^(.+?)__.+\.json$/]]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      // ⚠️ 隱藏檔要跳過。L4 那個「專案名算成 `.`」的 bug 留下的檔案叫 `.__main.json`,
      // 它是隱藏檔,所以 `ls` 看不到——而畫面上會多出一個叫「.」的專案。
      // 資料清掉不算修好:程式本身不准讓一個爛檔名變成畫面上的一張卡。
      // ⚠️ 以前這裡連 `_` 開頭的都跳過(想跳的只是 _sensor.jsonl)——結果中文名的專案 safeName 之後全是底線,
      //    整個案件在網頁上消失(2026-09-11 實測,誠實修補 C3)。要跳的是那一個檔,不是那一種開頭。
      if (f.startsWith('.') || f === SENSOR_FILE) continue;
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
    // 全部都不是 git 專案(hook 把這種資料夾全記進同一個桶)→ 沒有任何版本可講,整個案件不出現
    if (cards.length && cards.every((c) => c.notGit)) continue;

    // 對話層(Oscar 的真正工作單位)。每個對話掛在它自己的工作區上。
    const { stages } = loadStages(monitorDir, cards[0]?.path ?? '', cards[0]?.mainRoot ?? null);
    const sessions = sessionsOf(events).map((s) => ({
      ...s,
      stages: stagesOfSession(events, stages, s.id),
      card: cards.find((c) => c.path === s.cwd) ?? null,
    }));

    // name 是檔名(safeName 過的,「TutorPod_AI_v4」),當路由跟鍵用;給人看要用真的資料夾名
    const live = cards.find((c) => !c.gone && !c.notGit);
    const displayName = live?.project ?? name;
    // 退出記號放在主資料夾,整個案件(含 worktree)一起退出;儀表板的按鈕靠 mainRoot 找到它
    const mainRoot = live?.mainRoot ?? null;
    const optedOut = mainRoot ? optOutState(mainRoot) : null;
    projects.push({ name, displayName, mainRoot, optedOut, sensorState: evState, cards, sessions });
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
  // 資料夾在,但不是 git 專案:沒有版本可講。給一張只說這件事的卡,欄位都空著——不要讓 undefined 漏到畫面上
  if (!ctx.isGit) {
    return {
      path, gone: false, notGit: true, project: null, branch: null, checkpoint: null, files: null,
      sensor: { state: evState, brokenCount: broken.length, firstSeen: null, lastSeen: null, mount: mountState(path) },
    };
  }
  const cp = seed.checkpoint ?? null;
  // ⚠️ L14:章指的版本不在這條分支上(歷史被改寫過)時,不能拿它當基準,更不能給回去的指令。
  //    跟終端機版用同一個判斷,兩邊才會說同一句話。
  const relation = cp ? checkpointRelation(path, cp.commit) : null;
  const since = relation?.state === 'ok' ? cp.commit : null;
  // 沒有章(或章不能用)時,基準是上一次存檔(HEAD)——沒帶 HEAD 的 git diff 看不到 add 過的改動(老毛病 P1)。
  const base = since ?? (ctx.hasCommits ? 'HEAD' : null);

  let changedSince = null;
  if (since) {
    const d = git(['diff', '--name-only', since], path);
    const u = git(['ls-files', '--others', '--exclude-standard'], path);
    // 同一個坑踩過兩次(LESSONS L2):git diff 看不到未追蹤的新檔案。
    changedSince = d === null ? null
      : new Set([...d.split('\n'), ...(u ?? '').split('\n')].filter(Boolean)).size;
  }

  // 「還沒存進保險箱」只有一種算法,住在 status.mjs(-uall:新資料夾裡一個檔案算一個)
  const dirty = uncommitted(path);

  // ⚠️ Oscar 2026-09-10 讀不懂「未存檔／保險箱」,而且把它讀成 git push。
  // 那是我的比喻沒講清楚:「存進保險箱」只是 commit。
  // 他自己畫過的三階梯(commit → merge → push)本來就在規劃裡,現在補上。
  const ladder = buildLadder(path);

  // ⚠️ 他說「5 個檔案」這種數字對使用者沒幫助,要知道**是哪些檔案**。對的。
  // 數量回答不了「我該不該擔心」,檔名可以。
  const files = listChangedFiles(path, base);

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

  const { stages } = loadStages(monitorDir, path, ctx.mainRoot);
  const { perStage } = lastRunPerStage(events, stages, path);
  const mineTs = events.filter((e) => e.cwd === path).map((e) => e.ts).filter(Boolean).sort();
  const firstSeen = mineTs[0] ?? null;
  const lastSeen = mineTs.at(-1) ?? null;   // 「活著嗎」的證據:最後一筆來自這個工作區的紀錄(誠實修補 D)
  const cleared = new Map();
  for (const e of events) if (e.event === 'stage_cleared' && e.cwd === path) cleared.set(e.stage, e);
  const health = ctx.hasCommits ? changeHealth(path, since) : null;

  return {
    path,
    gone: false,
    project: ctx.project,
    mainRoot: ctx.mainRoot,
    branch: ctx.branch,
    hasCommits: ctx.hasCommits,
    checkpoint: cp,
    // 只有 state 是 'ok' 的章才准給回去的指令;章之後有存檔時附上備份分支名(L14)
    checkpointRelation: relation,
    backupBranch: relation?.commitsAfter ? backupBranchName() : null,
    changedSince,
    dirty,
    ladder,
    files,
    version,
    cpVersion,
    health,
    head: ctx.head?.slice(0, 7) ?? null,
    // 分級:跟終端機同一份實作(lib/tier.mjs)。upgradable 是儀表板「調高」唯一准選的等級(比機器算的高)
    tier: buildTier({ root: path, mainRoot: ctx.mainRoot, monitorDir, health, stages, perStage, cleared, events, cwd: path,
                      cpUsable: relation?.state === 'ok', cpAt: cp?.at ?? null, head: ctx.head?.slice(0, 7) ?? null,
                      hasCommits: ctx.hasCommits }),
    scale: ctx.hasCommits ? changeScale(path) : null,
    sensor: { state: evState, brokenCount: broken.length, firstSeen, lastSeen, mount: mountState(path, ctx.mainRoot) },
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
  const uncommittedCount = uncommitted(cwd);   // 同一種算法(status.mjs),不要在這裡再算一次

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

  const fields = {
    uncommitted: uncommittedCount,
    unmerged: Number.isFinite(unmerged) ? unmerged : null,
    onMain,
    mainName: mainRef ?? null,
    hasUpstream: upstream !== null,
    unpushed: Number.isFinite(unpushed) ? unpushed : null,
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
export function ladderSteps({ uncommitted, unmerged, onMain, mainName, hasUpstream, unpushed }) {
  // 這條分支上有沒有 main 還沒有的東西。main 自己永遠算有;問不到的時候也當有(不要把「沒問到」講成「沒東西」)
  const hasWork = onMain || unmerged === null || unmerged > 0;
  const m = mainName ?? '主線';

  const commit = uncommitted === null ? { state: 'unknown', text: '問不到有沒有沒存的檔案' }
    : uncommitted > 0 ? { state: 'pending', text: `還有 ${uncommitted} 個檔案沒存` }
    : hasWork ? { state: 'done', text: '都存好了' }
    : { state: 'none', text: '還沒有任何改動要存' };

  const merge = !mainName ? { state: 'unknown', text: '找不到 main／master 分支,不知道要併去哪' }
    : onMain ? { state: 'none', text: `你就在 ${m} 上,不用併` }
    : unmerged === null ? { state: 'unknown', text: `問不到跟 ${m} 差幾個存檔` }
    : unmerged > 0 ? { state: 'pending', text: `這條分支還多 ${unmerged} 個存檔沒併` }
    : { state: 'none', text: `跟 ${m} 沒有差別——沒有東西要併,或早就併進去了,這兩種我分不出來` };

  const push = !hasUpstream
    ? (hasWork ? { state: 'pending', text: '這條分支還沒有 push 到 GitHub — 只存在你這台電腦上' }
               : { state: 'none', text: '還沒有東西可以 push' })
    : unpushed === null ? { state: 'unknown', text: '問不到跟 GitHub 差幾個存檔' }
    : unpushed > 0 ? { state: 'pending', text: `還有 ${unpushed} 個存檔沒推上去` }
    : { state: 'done', text: 'GitHub 上的跟這裡一樣' };

  return [{ id: 'commit', ...commit }, { id: 'merge', ...merge }, { id: 'push', ...push }];
}

/** 改過哪些檔案——依資料夾分組。⚠️ 一定要含未追蹤的新檔案(LESSONS L2,踩過兩次)。 */
function listChangedFiles(cwd, base) {
  // base 由呼叫端決定(章、或 HEAD);只有零 commit 的專案才會是 null
  const tracked = git(['diff', '--name-only', ...(base ? [base] : [])], cwd);
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
