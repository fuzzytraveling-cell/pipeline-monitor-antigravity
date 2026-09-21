/**
 * collect.mjs —— 把「這台機器上我知道的所有專案」整理成一份 JSON
 *
 * ⚠️ **只列出有證據的專案**(有紀錄檔或有還原點)。
 *    這是刻意的:它不去猜你電腦裡有哪些 git repo,也不掃你的硬碟。
 *    沒有證據就不出現——**不知道的事情就不要出現在畫面上**。
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitContext, changeHealth, changeScale, git, uncommitted, dirtyPaths, checkpointRelation, backupBranchName } from '../status.mjs';
import { readEvents, loadStages, sessionsOf, sessionView, runsPerStage, roundView, editsOf, reportsIn, perStageOfRound, gateHeartbeat, suggestionsOf, firstPromptsOf, specContext, safeName, SENSOR_FILE, RETAIN_DAYS } from './events.mjs';
import { mountState, optOutState } from './mount.mjs';
import { buildTier, readTierConfig, codeFileFn, gitCodeChanges, requirementStatus } from './tier.mjs';
import { monitorHome } from './paths.mjs';
import { readAppTitles, deletedAt } from './appSessions.mjs';
import { skillAvailable } from './skills.mjs';

/** 紀錄住哪:跟 hook.sh／status.mjs 看同一個環境變數,否則寫的跟讀的不是同一份(老毛病 P2)。 */
function logDirOf(monitorDir) { return process.env.PIPELINE_MONITOR_LOG_DIR ?? join(monitorHome(monitorDir), 'logs'); }

export function collectAll({ monitorDir, appTitles = readAppTitles(), transcriptsDir = undefined, skillHome = undefined }) {
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

  // 每個專案的紀錄先各讀一次:建議卡的「已開始」要拿**所有專案**的對話第一句話來比——
  // app 的卡實測有一半是要開在別的專案,那個新對話記在別的專案的紀錄檔裡,只看自己這份永遠對不到(會一直說「還沒開始」)
  const sorted = [...names].sort();
  const evByName = new Map(sorted.map((name) => [name, readEvents(logDir, name)]));
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
    // 一個專案可能有好幾個 worktree,每個 worktree 一張卡(AC-5)。
    const worktrees = new Map();

    for (const f of existsSync(cpDir) ? readdirSync(cpDir) : []) {
      if (!f.startsWith(`${name}__`)) continue;
      try {
        const cp = JSON.parse(readFileSync(join(cpDir, f), 'utf8'));
        worktrees.set(cp.worktree, { checkpoint: cp });
      } catch { /* 讀不到就當沒有,不要讓一個壞檔害死整頁 */ }
    }

    const { state: evState, events, broken } = evByName.get(name);
    for (const e of events) if (e.cwd && !worktrees.has(e.cwd)) worktrees.set(e.cwd, {});

    const cards = [];
    for (const [path, seed] of worktrees) {
      cards.push(buildCard({ path, seed, name, events, evState, broken, monitorDir, skillHome }));
    }
    // 全部都不是 git 專案(hook 把這種資料夾全記進同一個桶)→ 沒有任何版本可講,整個案件不出現
    if (cards.length && cards.every((c) => c.notGit)) continue;

    // 對話層(Oscar 的真正工作單位)。每個對話掛在它自己的工作區上。
    const { stages } = loadStages(monitorDir, cards[0]?.path ?? '', cards[0]?.mainRoot ?? null);
    const sessions = sessionsOf(events).map((s) => {
      // 標題:app 的索引優先(它就是側欄上那個字),再退回感測器記到的,再退回沒有(畫面印「（還沒有標題）」)
      const title = appTitles.get(s.id) ?? s.title ?? null;
      // 在 app 裡刪掉的對話不准畫成「進行中」——當成結案,而且標明是刪除,不是你按的結案
      const deleted = deletedAt(s.id, s.cwd, transcriptsDir);
      const card = cards.find((c) => c.path === s.cwd) ?? null;
      // 蓋章時間(一輪的分界之一)與「這裡有沒有這個指令」都是工作區層級的事實,從卡片那份帶過來
      const cpAt = card?.checkpointRelation?.state === 'ok' ? card.checkpoint?.at ?? null : null;
      // B 有沒有在動、A 是不是開工了:改到「程式檔」才算,判斷跟分級同一份(五關自動結案 AC-3、AC-4)
      const cfgS = s.cwd ? readTierConfig(s.cwd, card?.mainRoot ?? null, monitorDir) : { state: 'unset' };
      const isCode = codeFileFn(s.cwd ?? '', cfgS.state === 'ok' ? cfgS.config : null);
      // git 說的改動是整個工作區的:這個工作區只有這一個對話時才算它的(用 Bash 寫檔感測器看不到,L8);共用時不猜是誰改的。
      // 給函式:從哪個時間點往後找(一輪的分界)由 roundView 自己算,跟五關用同一個分界
      const gitChanges = !s.sharesCwd && card && !card.gone && !card.notGit
        ? (since) => gitCodeChanges(s.cwd, card.health?.list ?? null, isCode, { since }) : [];
      const sv = sessionView(events, stages, s.id, cpAt, s.cwd, { isCode, gitChanges, mainRoot: card?.mainRoot ?? null });
      const stagesS = sv.view.stages.map((st) => ({
        ...st, available: card?.stages?.find((x) => x.id === st.id)?.available ?? null,
      }));
      // 分級卡的寫規格那一行按**這個對話**算(施工對話認規格 AC-2、AC-7):規格連結只算記它的那個對話——
      // 工作區層級的卡在兩個對話共用時會把甲的連結套到乙身上,收工 hook 也是按對話看這一行。
      // ⚠️ 只換這一行。其他行(C、D、補測試)照舊用工作區那份:整張卡都按對話重算的話,共用工作區時 D 那一行會跟收工 hook 講相反的話
      //    (收工 hook 的「最後一次改檔」一律看工作區的 git,對話頁共用時不拿 git 的證據——魔鬼教官 2026-09-21,老毛病 P2)
      const specStage = stages.find((x) => x.skill);
      const tier = card?.tier?.state === 'ok' && Array.isArray(card.tier.requirements)
        ? { ...card.tier, spec: sv.view.spec, requirements: card.tier.requirements.map((r) => (r.key !== specStage?.id ? r
            : requirementStatus([r.key], { stages, perStage: perStageOfRound(sv.view), cleared: sv.cleared, health: card.health, reports: sv.reports, lastEdit: sv.view.lastEdit, spec: sv.view.spec })[0])) }
        : card?.tier ?? null;
      return { ...s, title, deletedAt: deleted, closedAt: s.closedAt ?? deleted, stages: stagesS, card, tier };
    });

    // name 是檔名(safeName 過的,「TutorPod_AI_v4」),當路由跟鍵用;給人看要用真的資料夾名
    const live = cards.find((c) => !c.gone && !c.notGit);
    const displayName = live?.project ?? name;
    // 退出記號放在主資料夾,整個案件(含 worktree)一起退出;儀表板的按鈕靠 mainRoot 找到它
    const mainRoot = live?.mainRoot ?? null;
    const optedOut = mainRoot ? optOutState(mainRoot) : null;
    // 建議另開的對話(Claude 用 --suggest 放的、或 app 對話裡叫出來的建議卡)。給人看的那幾個名字等所有專案都算完再補(下面)
    const suggestions = suggestionsOf(events, { firstPrompts: firstPromptsFor(name) });
    projects.push({ name, displayName, mainRoot, optedOut, sensorState: evState, cards, sessions, suggestions });
  }

  // 建議卡要講的三個名字都可能落在**別的專案**:是哪個對話開始的、(app 的卡)是哪個對話提的、要開在哪個專案。
  const sessionIndex = new Map();
  for (const p of projects) for (const s of p.sessions) sessionIndex.set(s.id, { title: s.title ?? '（還沒有標題）', project: p.name, projectName: p.displayName });
  const projectAt = (path) => projects.find((p) => p.mainRoot === path || p.cards.some((c) => c.path === path)) ?? null;
  for (const p of projects) {
    p.suggestions = p.suggestions.map((sg) => {
      const started = sg.startedBy ? sessionIndex.get(sg.startedBy) ?? null : null;
      const from = sg.session ? sessionIndex.get(sg.session) ?? null : null;
      // 要開在哪(openIn):沒指定、或就是這個專案 → null,不用講。儀表板認得那個資料夾就給專案(可以連過去),不認得就只給資料夾名。
      // 路徑被截過的不拿來認、也不拿來顯示——半截路徑的最後一段是一個錯的名字
      const pathCut = sg.cut.includes('cwd');
      const tp = sg.target && !pathCut ? projectAt(sg.target) : null;
      const openIn = !sg.target || tp === p ? null
        : pathCut ? { project: null, name: null }
        : { project: tp?.name ?? null, name: tp?.displayName ?? sg.target.split('/').filter(Boolean).pop() ?? null };
      return {
        ...sg,
        openIn,
        // 已開始的那個對話:列得出來就給標題、在別的專案就說是哪個;列不出來(那個資料夾不在儀表板上)只說已開始,不給連結
        startedTitle: started?.title ?? null,
        startedProject: started && started.project !== p.name ? { project: started.project, name: started.projectName } : null,
        // app 的卡是哪個對話提的(說明被截短的時候,完整的只有那個對話裡有)
        fromTitle: from?.title ?? null,
      };
    });
    // app 的建議卡從什麼時候開始有紀錄(L3:感測器有開始的日期,更早跳過的這裡一輩子不會知道)。
    // null = 紀錄裡一張都沒有——沒跳過、感測器沒接上、還是超過保留期限被丟掉了,從這裡分不出來,畫面要照這樣講(P5)。
    // ⚠️ 一定要給值(null 也是值):畫面靠「這個欄位在不在」分辨伺服器是不是還在跑不認得 app 建議卡的舊程式
    p.appCardsSince = p.suggestions.filter((sg) => sg.source === 'app').map((sg) => sg.ts).filter(Boolean).sort()[0] ?? null;
  }
  // 卡留在提建議的那個專案那一頁;要開的那個專案那一頁只指路——不然那一頁說「一張都沒有」,而別頁明明掛著要開在這裡的卡(P5:這個 0 有兩種意思)
  for (const p of projects) {
    p.incomingSuggestions = projects.filter((q) => q !== p).map((q) => ({
      project: q.name, name: q.displayName,
      count: q.suggestions.filter((sg) => sg.openIn?.project === p.name && !sg.dismissedAt && !sg.startedBy).length,
    })).filter((x) => x.count > 0);
  }
  // retainDays:紀錄留幾天(數字只住 lib/events.mjs 一處)。畫面講「超過保留期限的這裡看不到」時要用
  return { generatedAt: Date.now(), retainDays: RETAIN_DAYS, projects };
}

/**
 * 一張卡:給收工 hook(gate.mjs)用——它只關心 Claude 站的那個工作區,每回合都跑,不能把全機的專案都算一遍。
 * 跟 collectAll 走同一個 buildCard,擋不擋、缺什麼,才會跟儀表板說同一句話(老毛病 P2)。
 * 不是 git 專案回 null。path 要用感測器記的那個 cwd(hook 的 payload 給的),事件才對得上。
 */
export function cardFor({ monitorDir, path, skillHome = undefined }) {
  const home = monitorHome(monitorDir);
  const logDir = process.env.PIPELINE_MONITOR_LOG_DIR ?? join(home, 'logs');
  const cpDir = join(home, 'checkpoints');
  const ctx = gitContext(path);
  if (!ctx.isGit) return null;
  const name = safeName(ctx.project);
  let seed = {};
  if (existsSync(cpDir)) {
    for (const f of readdirSync(cpDir)) {
      if (!f.startsWith(`${name}__`)) continue;
      try {
        const cp = JSON.parse(readFileSync(join(cpDir, f), 'utf8'));
        if (cp.worktree === path) seed = { checkpoint: cp };
      } catch { /* 壞檔當沒有,不要讓一個壞檔害死收工 */ }
    }
  }
  const { state: evState, events, broken } = readEvents(logDir, ctx.project);
  const card = buildCard({ path, seed, events, evState, broken, monitorDir, skillHome });
  const { stages } = loadStages(monitorDir, path, ctx.mainRoot);
  return { card, events, stages, ctx, logDir, project: ctx.project };
}

function buildCard({ path, seed, events, evState, broken, monitorDir, skillHome }) {
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
  const tierCfg = readTierConfig(path, ctx.mainRoot, monitorDir);   // 五關的「程式檔」判斷跟分級同一份
  const mineTs = events.filter((e) => e.cwd === path).map((e) => e.ts).filter(Boolean).sort();
  const firstSeen = mineTs[0] ?? null;
  const lastSeen = mineTs.at(-1) ?? null;   // 「活著嗎」的證據:最後一筆來自這個工作區的紀錄(誠實修補 D)
  const cleared = new Map();
  for (const e of events) if (e.event === 'stage_cleared' && e.cwd === path) cleared.set(e.stage, e);
  // Claude 記的結論、這一輪改到程式檔的事件:五關與分級共用(跟終端機的 stageFacts 同一份算法)
  const reports = reportsIn(events, (e) => e.cwd === path);
  const isCode = codeFileFn(path, tierCfg.state === 'ok' ? tierCfg.config : null);
  const edits = editsOf(events, (e) => e.cwd === path);
  const health = ctx.hasCommits ? changeHealth(path, since) : null;
  // 這一輪跑到哪(lib/events.mjs 的 roundView):分界是最近一次第一關、或蓋章,取較晚的。
  // 五關、分級的「需要」、收工 hook 都吃這一份;B 的證據除了感測器,還有 git 說改了的檔案的修改時間(L8)
  const runs = runsPerStage(events, stages, (e) => e.cwd === path);
  const cpAtOk = relation?.state === 'ok' ? cp?.at ?? null : null;
  // 規格連結(施工對話認規格):工作區層級只在「這個工作區只有一個對話在動」時套,否則連結只算記它的那個對話(lib/events.mjs 的 specContext)
  const view = roundView({
    runs, stages, cleared, reports, edits, isCode, cpAt: cpAtOk,
    gitChanges: (since) => gitCodeChanges(path, health?.list ?? null, isCode, { since }),
    spec: specContext(events, { cwd: path, cpAt: cpAtOk }), root: path, mainRoot: ctx.mainRoot,
  });
  const perStage = perStageOfRound(view);

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
                      hasCommits: ctx.hasCommits, reports, lastEdit: view.lastEdit, spec: view.spec }),
    scale: ctx.hasCommits ? changeScale(path) : null,
    // 收工 hook 的心跳(全機一份):沒有 = 從沒跑過。「掛著」不等於「活著」(L13)
    sensor: { state: evState, brokenCount: broken.length, firstSeen, lastSeen, mount: mountState(path, ctx.mainRoot), gate: gateHeartbeat(logDirOf(monitorDir)) },
    stages: view.stages.map((st) => ({
      ...st,
      // 「沒有紀錄」跟「這裡根本沒有這個指令」要分開講(lib/skills.mjs);沒有 skill 的關(B、E)不適用
      available: st.skill ? skillAvailable(st.skill, path, ctx.mainRoot, skillHome).found : null,
    })),
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
  const m = mainName ?? '主線';

  const commit = uncommitted === null ? { state: 'unknown', text: '問不到有沒有沒存的檔案' }
    : uncommitted > 0 ? { state: 'pending', text: `還有 ${uncommitted} 個檔案沒存` }
    : hasWork ? { state: 'done', text: '都存好了' }
    : { state: 'none', text: '還沒有任何改動要存' };

  const merge = !mainName ? { state: 'unknown', text: '找不到 main／master 分支,不知道要併去哪' }
    : onMain ? { state: 'none', text: `你就在 ${m} 上,不用併` }
    : unmerged === null ? { state: 'unknown', text: `問不到跟 ${m} 差幾個存檔` }
    : unmerged > 0 ? { state: 'pending', text: `這條分支還多 ${unmerged} 個存檔沒併` }
    // 差 0 個有兩種意思:空的分支(沒有東西要併),或這條的東西都併進去了(做完了)。光看 ref 分不出來,
    // 要問 reflog(老毛病 P5):main 的紀錄有「merge 這條分支」→ 併進去了;分支自己的紀錄只有「開出來」那一筆 → 空的。
    : mergedIntoMain === true ? { state: 'done', text: atMainTip === false ? `早就併進 ${m} 了（${m} 之後又往前走了）` : `併進 ${m} 了（快轉,${m} 之後還沒動）` }
    : branchMoved === false ? { state: 'none', text: atMainTip === false ? `這條分支是空的,${m} 自己往前走了——沒有東西要併` : `這條分支是空的,跟 ${m} 一模一樣——沒有東西要併` }
    // 分支的存檔全在 main 上、main 又往前走了:不管怎麼進去的,這條分支現在的東西都在 main 上
    : atMainTip === false ? { state: 'done', text: `早就併進 ${m} 了（${m} 之後又往前走了）` }
    : { state: 'none', text: `跟 ${m} 沒有差別——沒有東西要併,或早就併進去了,這次分不出來` };

  // push 看的是 main,不管這張卡是哪條分支:分支在本機併、只推 main(Oscar 2026-09-15)。
  // 「main 沒連到 GitHub」是事實不是問不到,但也沒有東西可做,所以是 none、不亮燈(L16)
  const push = !mainName ? { state: 'unknown', text: '找不到 main／master 分支,不知道要推什麼' }
    : !mainHasUpstream ? { state: 'none', text: `${m} 沒有連到 GitHub,沒有地方可以 push` }
    : mainUnpushed === null ? { state: 'unknown', text: `問不到 ${m} 跟 GitHub 差幾個存檔` }
    : mainUnpushed > 0 ? { state: 'pending', text: `${m} 有 ${mainUnpushed} 個新存檔可以 push` }
    : { state: 'done', text: `GitHub 上的跟 ${m} 一樣` };

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
  // ⚠️ 「改過」跟「還沒存」是兩件事:蓋章之後 commit 過的檔案也算改過,但它已經存了。
  //    以前只列檔名,Oscar 把「蓋章後還沒檢查的 5 個」讀成「還沒 commit 的 5 個」(2026-09-15)。每個檔案都標清楚。
  const dirtySet = dirtyPaths(cwd);   // 住在 status.mjs:porcelain 的第一行不能 trim,那裡有說明

  const groups = new Map();
  for (const f of all) {
    const i = f.lastIndexOf('/');
    const dir = i === -1 ? '根目錄' : f.slice(0, i);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push({ name: i === -1 ? f : f.slice(i + 1), isNew: newSet.has(f), uncommitted: dirtySet ? dirtySet.has(f) : null });
  }
  return { total: all.length, newCount: newSet.size,
           uncommittedCount: dirtySet === null ? null : all.filter((f) => dirtySet.has(f)).length,
           groups: [...groups].map(([dir, items]) => ({ dir, items })) };
}
