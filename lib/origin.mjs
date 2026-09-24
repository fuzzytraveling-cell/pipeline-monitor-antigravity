/**
 * origin.mjs —— 「這次改動」從哪裡算起。規格:這一輪的起點(路徑看 CLAUDE.md 的表)
 *
 * ⚠️ 2026-09-21 實測:沒有還原點的工作區,基準是「上一次存檔」(HEAD)——Claude 收工前先 commit,這一輪做的事就全部落到
 *    基準後面:分級說「沒有改動」、收工 hook 放行、你調高的等級消失。拿剛存好的版本當基準,就是拿自己跟自己比(LESSONS L11 的第二次)。
 *    存檔只是把東西放進保險箱,不是這件事做完了。所以沒章時,基準是**這一輪開始那一刻** HEAD 指的版本:之後存幾次檔都一樣。
 *
 * 基準只在 changeBase() 決定一次;五關的 B、分級、收工 hook、改動體檢、未檢查清單都吃同一份(老毛病 P2):
 *   有章而且能用 → 比章(跟以前一樣)
 *   沒章 → 比起點那一刻的版本(reflog)。「起點」是 roundView 算的(lib/events.mjs):A／蓋章,沒有就是這個對話在這裡的第一筆紀錄
 *   起點問不到、或那個版本已經不在這條分支上 → 只看還沒存檔的(HEAD),而且畫面要講出來——存檔過的看不到 ≠ 沒有(R1)
 *
 * ⚠️ 2026-09-24 實測:app 會把收掉的對話留下的資料夾,換一條新分支給下一個新對話用(pipeline-monitor 5 個工作區有 3 個、TutorPod 3 個全部)。
 *    沒發現換了人,上一個對話的 A、C、章就被算成這一輪的:終端機說 A、C 跑過,儀表板拿舊章當基準、收工 hook 照 T2 要 A、C——
 *    其實這個對話只改了 19 個檔、T1。所以一輪多一個分界:**換人**(takeoverOf)。那一刻之前記在這個資料夾的,都是上一手的(tenureEvents);
 *    起點最早就是換過去的那個版本。規格:新對話接手舊資料夾(路徑看 CLAUDE.md 的表)
 */
import { execFileSync } from 'node:child_process';
import { gitCodeChanges } from './tier.mjs';
import { SKEW_MS } from './events.mjs';

/**
 * HEAD 的 reflog,**舊到新**:[{ sha, sec, gs }](gs 是那一筆的說明,例如「checkout: moving from a to b」,可能是空的)。
 * 問不到回 null——不是空陣列,空陣列是「問到了,沒有任何一筆」。
 * ⚠️ 用 --date=unix:git 預設的時間帶本地時差(+08:00),拿去跟 UTC 的起點比字串會錯(魔鬼教官 2026-09-16 第四次抓過)。
 * 每個 worktree 有自己的一份;app 開 worktree 那一刻就有一筆(2026-09-22 實測)。
 */
export function reflogOf(root, { limit = 5000 } = {}) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'reflog', 'show', `-n${limit}`, '--date=unix', '--format=%H %gd %gs', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{40,64}) \S*@\{(\d+)\}(?: (.*))?$/);
    if (m) list.push({ sha: m[1], sec: Number(m[2]), gs: m[3] ?? '' });
  }
  return list.reverse();
}

/**
 * 這個資料夾最近一次「換人」(規格:新對話接手舊資料夾 AC-1、AC-2)。
 * app 把收掉的對話留下的資料夾換一條新分支給新對話時,reflog 留一筆「checkout: moving from <舊的> to <新分支>」
 * (2026-09-24 實測四次:前面那一筆是 app 收掉對話時的「脫離分支」,換到 HEAD 或某個版本)。
 * 換人要三件都成立:
 *   ① 那一筆是換到**某條分支**。換到 HEAD／某個版本是脫離分支(app 收掉對話),不算——不然收掉還沒人接手的資料夾,
 *      上一個對話自己的頁面就變成「資料夾換人了」
 *   ② **沒有**任何對話在那一筆之前、之後都有紀錄。有的話是同一個對話自己換分支、或收掉的對話被 app 接回原分支
 *      (TutorPod 的 agent-dashboard 資料夾 9/15、9/17 各一次,同一個對話)——之前做的照算。當成換人的話,之前做的從帳上消失,
 *      改動看起來比實際小:危險的那一邊(老毛病 P1 的方向)。橫跨的就往更早找。
 *   ③ 換過去之後**有對話來動了**。還沒有人動之前分不出是誰換的——可能就是同一個對話用 Bash 切了分支、還沒下一個動作——
 *      照舊不分(寧可多算)。app 接手的那一種,新對話的第一句話一秒後就到了。
 * 「之前」不含那一筆前面 SKEW_MS 之內:app 換分支跟新對話第一句話實測差 1 秒,感測器與 reflog 都只到秒——同一秒、差一兩秒的算之後。
 * 只看感測器記到的對話動作(hook 那種、有對話代號的);CLI 記的結論沒有對話代號,分不出是誰的。
 * @param reflog reflogOf() 的結果;null = 問不到
 * @returns {{state:'ok', at:string, sec:number, cutMs:number, commit:string, from:string, to:string, index:number} | {state:'none'} | {state:'unknown'}}
 *   cutMs:早於這一刻的紀錄是上一手的(tenureEvents);commit:換過去的那個版本;index:那一筆在 reflog(舊到新)的位置。
 *   unknown:reflog 問不到——分不出有沒有換過人,呼叫端照舊、什麼都不分(AC-6:寧可多算,也不宣稱換過或沒換過)
 */
export function takeoverOf({ reflog, events = [], cwd }) {
  if (reflog === null || reflog === undefined) return { state: 'unknown' };
  // 在這個資料夾動過的對話,每一筆的時間(時間讀不懂的不算——看不懂不等於比較早)
  const acts = [];
  for (const e of events) {
    if (!e?.hook || !e.session || e.cwd !== cwd) continue;
    const t = Date.parse(e.ts);
    if (Number.isFinite(t)) acts.push({ s: e.session, t });
  }
  for (let i = reflog.length - 1; i >= 0; i--) {
    const m = /^checkout: moving from (\S+) to (\S+)$/.exec(reflog[i].gs ?? '');
    if (!m || m[1] === m[2]) continue;
    const to = m[2];
    if (to === 'HEAD' || /^[0-9a-f]{7,64}$/.test(to)) continue;     // 脫離分支(app 收掉對話),不是換人(①)
    const cutMs = reflog[i].sec * 1000 - SKEW_MS;
    const before = new Set(acts.filter((a) => a.t < cutMs).map((a) => a.s));
    const after = new Set(acts.filter((a) => a.t >= cutMs).map((a) => a.s));
    if ([...after].some((s) => before.has(s))) continue;              // 有對話橫跨這一筆:不是換人(②),往更早找
    if (!after.size) continue;                                         // 換過去之後還沒有人動:分不出是誰換的(③)
    return { state: 'ok', at: new Date(reflog[i].sec * 1000).toISOString(), sec: reflog[i].sec, cutMs, commit: reflog[i].sha, from: m[1], to, index: i };
  }
  return { state: 'none' };
}

/** 這一筆紀錄是不是這個資料夾換人之前的(上一手的)。時間讀不懂的也算之前:分不出是不是這一手的,不拿來當這一輪的證據(R2)。 */
export function beforeTakeover(e, cwd, takeover) {
  if (takeover?.state !== 'ok' || e?.cwd !== cwd) return false;
  const t = Date.parse(e.ts);
  return !Number.isFinite(t) || t < takeover.cutMs;
}

/**
 * 這一手的紀錄:這個資料夾換人之前記的(A／C／D／E 的呼叫與結論、規格連結、你說處理完了、調高的等級、--decide)全部拿掉,
 * 別的資料夾的照留。沒換過人(none／unknown)原封不動。五關、分級、收工 hook、共用與否都吃這一份——只在這裡分一次(老毛病 P2)。
 * 上一手的對話(換人之前在這裡有動作的;照換人的定義,它換人之後沒有動作)在換人之後留在這裡的紀錄也拿掉——
 *   你在儀表板上替它按的結案／取消結案帶著它的對話代號:留著的話,新對話又被算成「跟別的對話共用」(魔鬼教官 2026-09-24,老毛病 P6)。
 * ⚠️ 「感測器活著嗎」「從什麼時候開始記」講的是整個資料夾,不要拿這一份算(那是感測器的事實,不是這一輪的)。
 */
export function tenureEvents(events, cwd, takeover) {
  if (takeover?.state !== 'ok') return events;
  const prev = new Set();
  for (const e of events) if (e?.hook && e.session && beforeTakeover(e, cwd, takeover)) prev.add(e.session);
  return events.filter((e) => !beforeTakeover(e, cwd, takeover) && !(e?.cwd === cwd && (prev.has(e.session) || prev.has(e.by_session))));
}

/**
 * 這個對話是不是這個資料夾的上一手:它在這裡的動作全在換人之前(AC-5)。上一手的頁面不畫資料夾現在的還原點、改動、分級——那是下一手的。
 * 它在這裡一筆動作都沒有(只在別的資料夾動過)→ 不是。
 */
export function previousTenant(events, cwd, takeover, session) {
  if (takeover?.state !== 'ok' || !session) return false;
  let seen = false;
  for (const e of events) {
    if (!e?.hook || e.session !== session || e.cwd !== cwd) continue;
    if (!beforeTakeover(e, cwd, takeover)) return false;
    seen = true;
  }
  return seen;
}

/**
 * 起點那一刻 HEAD 指的版本。照 reflog 的**先後順序**走(不照時間排序:有人手動改過存檔時間的話,時間會前後顛倒)。
 * ⚠️ 感測器與 reflog 的時間都只到秒:跟起點同一秒的移動分不出先後,一律算**起點之後**——這一輪的改動只會看起來比實際大,
 *    不會比實際小(小的那一邊才危險,規格 AC-7)。
 * ⚠️ 例外:reflog 最早那一筆就落在起點那一秒——那是 worktree 剛建好(app 建 worktree 跟對話第一句話常常只差一兩秒,2026-09-22 實測)。
 *    它之前這個工作區沒有任何版本,就用它。
 * @returns {{state:'ok', commit:string, moved:boolean} | {state:'none', why:string}}
 *   none:時間讀不懂、reflog 問不到或是空的、起點比 reflog 最早那一筆還早(過期了、或這個資料夾是後來才變成 git 的)
 *   moved:起點之後 HEAD 曾經指到別的版本(存檔、切分支、改寫存檔)。改動是 0 的時候要看它——
 *     0 可能是「沒動過」,也可能是「動過、但存到別的分支上又切回來」(老毛病 P5,魔鬼教官 2026-09-22 抓到)
 */
export function versionAt(root, atIso, { reflog } = {}) {
  const ms = Date.parse(atIso);
  if (!Number.isFinite(ms)) return { state: 'none', why: 'bad-time' };
  const list = reflog === undefined ? reflogOf(root) : reflog;
  if (!list?.length) return { state: 'none', why: 'no-reflog' };
  const sec = Math.floor(ms / 1000);
  const k = list.findIndex((e) => e.sec >= sec);   // 第一筆落在起點那一秒或之後的移動
  const at = (commit, from) => ({ state: 'ok', commit, moved: list.slice(from).some((e) => e.sha !== commit) });
  if (k === -1) return at(list.at(-1).sha, list.length);   // 起點之後 HEAD 沒動過
  if (k > 0) return at(list[k - 1].sha, k);
  if (list[0].sec === sec) return at(list[0].sha, 1);
  return { state: 'none', why: 'before-history' };
}

/**
 * 「這次改動」的基準。**只在這裡決定一次**(規格 AC-2)。
 * origin:roundView 算的這一輪的起點 { at, from, sessions }(from:A／checkpoint／prompt／arrival)。
 * relationOf(commit):那個版本跟現在的關係——就是 lib/git.mjs 的 checkpointRelation,傳進來,不在這裡另寫一份
 *   (「版本還在不在這條分支上」只准有一種算法;歷史改寫過(rebase)的版本不能當基準,跟失效的章同一個判斷)。
 * takeover:這個資料夾最近一次換人(takeoverOf)。起點最早就是換過去的那個版本(規格:新對話接手舊資料夾 AC-1)——
 *   起點落在換人那一秒或更早,版本就是換過去的那一個,不照 versionAt 的「同一秒算之後」拿換人之前的舊版本
 *   (那樣又把 main 上別人的改動算進來:9/24 那個資料夾會從 19 個檔變回 40 個)。
 *   換人之後一筆紀錄都還沒有 → 起點就是換人那一刻(from:'takeover'),不退回只看還沒存檔的。
 * @returns {{kind:'checkpoint'|'origin'|'head', since:string|null, origin:object|null, why:string|null, moved?:boolean, commits:number|null}}
 *   since 是給 git diff 的版本,null = HEAD(只看還沒存檔的)。why 只有 head 才有:no-origin(沒有這一輪的紀錄)／not-found／no-commits
 *   commits:基準之後存了幾次檔(問不到是 null)——「這一輪 22 個檔」是好幾次存檔加起來的,旁邊的比例尺是一次存檔的,要講(L6)
 */
export function changeBase({ root, cpCommit = null, cpCommits = null, origin = null, relationOf, reflog, takeover = null }) {
  if (cpCommit) return { kind: 'checkpoint', since: cpCommit, origin, why: null, commits: cpCommits };
  const took = takeover?.state === 'ok' ? takeover : null;
  const o = origin?.at ? origin : took ? { at: took.at, from: 'takeover', sessions: null } : null;
  if (!o?.at) return { kind: 'head', since: null, origin: null, why: 'no-origin', commits: null };
  const list = reflog === undefined ? reflogOf(root) : reflog;
  const v = took && Math.floor(Date.parse(o.at) / 1000) <= took.sec
    ? { state: 'ok', commit: took.commit, moved: (list ?? []).slice(took.index + 1).some((e) => e.sha !== took.commit) }
    : versionAt(root, o.at, { reflog: list });
  if (v.state !== 'ok') return { kind: 'head', since: null, origin: o, why: 'not-found', commits: null };
  let rel = null;
  try { rel = relationOf(v.commit); } catch { rel = null; }
  if (rel?.state !== 'ok') return { kind: 'head', since: null, origin: o, why: 'not-found', commits: null };
  return { kind: 'origin', since: v.commit, origin: o, why: null, moved: v.moved, commits: rel.commitsAfter ?? null };
}

/**
 * 給 roundView 的 gitChanges 用的一組。roundView 算出這一輪的起點後呼叫 gitChanges(origin):這裡照那個起點決定基準、問一次 git;
 * 呼叫端在 roundView 之後用 facts() 拿**同一份**(分級、改動體檢、未檢查清單)。
 * 起點只由 roundView 算一次——在外面另算一次,兩邊遲早對不上(老毛病 P2;lib/events.mjs 的 roundStartOf 那段說過同一件事)。
 *   healthOf(since)、relationOf(commit):lib/git.mjs 的 changeHealth／checkpointRelation,由呼叫端傳進來。
 *   takeover、reflog:這個資料夾最近一次換人,與算它用的那一份 reflog(同一份,不再讀一次)——roundView 看到的紀錄已經是這一手的(tenureEvents)。
 */
export function changeFacts({ root, cpCommit = null, cpCommits = null, hasCommits = true, isCode, relationOf, healthOf, takeover = null, reflog }) {
  let got = null;
  const at = (origin) => {
    if (!got) {
      // 一個 commit 都沒有:沒有「存檔過的」可以看不到,不准講「存檔過的算不進來」(R1,魔鬼教官 2026-09-22)
      const base = hasCommits ? changeBase({ root, cpCommit, cpCommits, origin, relationOf, reflog, takeover })
        : { kind: 'head', since: null, origin: origin ?? null, why: 'no-commits', commits: 0 };
      got = { base, health: hasCommits ? healthOf(base.since) : null };
    }
    return got;
  };
  return {
    gitChanges: (origin) => gitCodeChanges(root, at(origin).health?.list ?? null, isCode),
    // roundView 一定會叫 gitChanges;真的沒叫到(它中途壞了),當成沒有起點——只看還沒存檔的,而且會講
    facts: () => got ?? at(null),
  };
}
