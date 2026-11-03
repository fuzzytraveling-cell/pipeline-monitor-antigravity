/**
 * origin.mjs —— 「這次改動」從哪裡算起。規格:這一輪的起點(路徑看 CLAUDE.md 的表)
 *
 * ⚠️ 2026-09-21 實測:沒有還原點的工作區,基準是「上一次存檔」(HEAD)——Claude 收工前先 commit,這一輪做的事就全部落到
 *    基準後面:分級說「沒有改動」、收工 hook 放行、你調高的等級消失。拿剛存好的版本當基準,就是拿自己跟自己比(LESSONS L11 的第二次)。
 *    存檔只是把東西放進保險箱,不是這件事做完了。所以沒章時,基準是**這一輪開始那一刻** HEAD 指的版本:之後存幾次檔都一樣。
 *
 * 基準只在 changeBase() 決定一次;五關的 B、分級、收工 hook、改動體檢、未檢查清單都吃同一份(老毛病 P2):
 *   有章而且能用 → 比章(跟以前一樣)
 *   沒章 → 比起點那一刻的版本(reflog)。「起點」是 roundView 算的(lib/rounds.mjs):A／蓋章,沒有就是這個對話在這裡的第一筆紀錄
 *   起點問不到、或那個版本已經不在這條分支上 → 只看還沒存檔的(HEAD),而且畫面要講出來——存檔過的看不到 ≠ 沒有(R1)
 *
 * ⚠️ 2026-09-24 實測:app 會把收掉的對話留下的資料夾,換一條新分支給下一個新對話用(pipeline-monitor 5 個工作區有 3 個、TutorPod 3 個全部)。
 *    沒發現換了人,上一個對話的 A、C、章就被算成這一輪的:終端機說 A、C 跑過,儀表板拿舊章當基準、收工 hook 照 T2 要 A、C——
 *    其實這個對話只改了 19 個檔、T1。所以一輪多一個分界:**換人**(takeoverOf)。那一刻之前記在這個資料夾的,都是上一手的(tenureEvents);
 *    起點最早就是換過去的那個版本。規格:新對話接手舊資料夾(路徑看 CLAUDE.md 的表)
 *
 * ⚠️ 2026-10-02 實測:app 新開的資料夾**不再**在開資料夾那一刻留 reflog(9/22 開的有;10/1、10/2 開的連 logs/ 都沒有,第一次存檔才有)。
 *    只靠 reflog 的話,起點的版本查不到,只看得到還沒存檔的——一存檔,這一輪的改動就從分級與收工 hook 眼前消失(L11 換一條路回來)。
 *    所以 reflog 查不到時,看**感測器自己記的**:hook.sh 每一筆都記 `head`(那一刻的版本號),起點那一筆記的就是起點的版本。
 *    app 的行為不是我們定的(L29);我們自己記的證據,不會因為它改做法就不見。規格:多份規格與新資料夾的起點(路徑看 CLAUDE.md 的表)
 *
 * ⚠️ 2026-11-03 實測:對話把 main 的新東西拿進自己的分支(快轉或合併)之後,`git diff <基準>` 把別的對話寫的檔也算成這一輪改的——
 *    一個檔都沒改的對話,終端機說「22 個檔、T1 要 D」;10/30 兩次是 D 跑完才併,收工 hook 叫人決定 D 要不要再跑。
 *    所以基準之後「從 main 拿進來、這個資料夾自己沒動過」的檔,不算這一輪(mergedIn)。只拿掉證明得出來的,分不出來照算。
 *    規格:併進來的不算這一輪(路徑看 CLAUDE.md 的表)
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { gitRaw, git, gitExit, dirtyPaths, unquotePath } from './git.mjs';
import { gitCodeChanges } from './tier.mjs';
import { SKEW_MS } from './rounds.mjs';
import { specFilesOf } from './checklist.mjs';

/**
 * HEAD 的 reflog,**舊到新**:[{ sha, sec, gs }](gs 是那一筆的說明,例如「checkout: moving from a to b」,可能是空的)。
 * 問不到回 null——不是空陣列,空陣列是「問到了,沒有任何一筆」。
 * ⚠️ 用 --date=unix:git 預設的時間帶本地時差(+08:00),拿去跟 UTC 的起點比字串會錯(魔鬼教官 2026-09-16 第四次抓過)。
 * 每個 worktree 有自己的一份。⚠️ 「app 開 worktree 那一刻就有一筆」只到 2026-09-22 成立:10/1 起 app 開的資料夾一筆都沒有,
 *   第一次存檔才有(這時回空陣列)——查不到起點的版本,changeBase 改看感測器記的版本號(commitOfHead)。
 */
export function reflogOf(root, { limit = 5000 } = {}) {
  const out = gitRaw(['-C', root, 'reflog', 'show', `-n${limit}`, '--date=unix', '--format=%H %gd %gs', 'HEAD']);
  if (out === null) return null;
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
 *    但 app 10/1 起開資料夾不留那一筆,最早那一筆可能是對話自己的**存檔**——同一秒的話,用它就是拿存檔之後的版本當起點,
 *    這一輪的改動變 0(魔鬼教官第一輪,L31 的同一個前提)。所以最早那一筆是存檔(commit 開頭)就不套這個例外,交給感測器那條路。
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
  if (list[0].sec === sec && !/^commit/.test(list[0].gs ?? '')) return at(list[0].sha, 1);
  return { state: 'none', why: 'before-history' };
}

/**
 * 「這次改動」的基準。**只在這裡決定一次**(規格 AC-2)。
 * origin:roundView 算的這一輪的起點 { at, from, sessions, head, heads }(from:A／checkpoint／prompt／arrival)。
 *   head:感測器在起點那一筆記的版本號;heads:起點之後這個資料夾的紀錄記到的版本號(都可能沒有)。
 * relationOf(commit):那個版本跟現在的關係——就是 lib/git.mjs 的 checkpointRelation,傳進來,不在這裡另寫一份
 *   (「版本還在不在這條分支上」只准有一種算法;歷史改寫過(rebase)的版本不能當基準,跟失效的章同一個判斷)。
 * takeover:這個資料夾最近一次換人(takeoverOf)。起點最早就是換過去的那個版本(規格:新對話接手舊資料夾 AC-1)——
 *   起點落在換人那一秒或更早,版本就是換過去的那一個,不照 versionAt 的「同一秒算之後」拿換人之前的舊版本
 *   (那樣又把 main 上別人的改動算進來:9/24 那個資料夾會從 19 個檔變回 40 個)。
 *   換人之後一筆紀錄都還沒有 → 起點就是換人那一刻(from:'takeover'),不退回只看還沒存檔的。
 * reflog 查不到起點的版本(沒有紀錄、或紀錄比起點晚才開始)→ 改看感測器在起點那一筆記下的版本號(origin.head,commitOfHead)。
 *   reflog 查得到的照舊用 reflog,一個字不改(規格:多份規格與新資料夾的起點 AC-8);兩邊都查不到才退回只看還沒存檔的(AC-10)。
 * @returns {{kind:'checkpoint'|'origin'|'head', since:string|null, origin:object|null, why:string|null, moved?:boolean, commits:number|null, src?:string}}
 *   since 是給 git diff 的版本,null = HEAD(只看還沒存檔的)。why 只有 head 才有:no-origin(沒有這一輪的紀錄)／not-found／no-commits
 *   commits:基準之後存了幾次檔(問不到是 null)——「這一輪 22 個檔」是好幾次存檔加起來的,旁邊的比例尺是一次存檔的,要講(L6)
 *   src:起點的版本是從哪一條查到的(reflog／takeover／sensor)——只給測試與除錯,畫面不講
 */
export function changeBase({ root, cpCommit = null, cpCommits = null, origin = null, relationOf, reflog, takeover = null }) {
  if (cpCommit) return { kind: 'checkpoint', since: cpCommit, origin: shown(origin), why: null, commits: cpCommits };
  const took = takeover?.state === 'ok' ? takeover : null;
  const o = origin?.at ? origin : took ? { at: took.at, from: 'takeover', sessions: null } : null;
  if (!o?.at) return { kind: 'head', since: null, origin: null, why: 'no-origin', commits: null };
  const list = reflog === undefined ? reflogOf(root) : reflog;
  let v = took && Math.floor(Date.parse(o.at) / 1000) <= took.sec
    ? { state: 'ok', commit: took.commit, moved: (list ?? []).slice(took.index + 1).some((e) => e.sha !== took.commit), src: 'takeover' }
    : { ...versionAt(root, o.at, { reflog: list }), src: 'reflog' };
  // reflog 查不到(app 新開的資料夾沒有那一筆、或紀錄比起點晚才開始):看感測器在起點那一筆記下的版本號。
  // 時間讀不懂(bad-time)不走這條——起點本身就不可信,不拿它的版本號當基準
  if (v.state !== 'ok' && (v.why === 'no-reflog' || v.why === 'before-history')) {
    const commit = commitOfHead(root, o.head);
    if (commit) v = { state: 'ok', commit, moved: movedSince(list, o, commit), src: 'sensor' };
  }
  if (v.state !== 'ok') return { kind: 'head', since: null, origin: shown(o), why: 'not-found', commits: null };
  let rel = null;
  try { rel = relationOf(v.commit); } catch { rel = null; }
  if (rel?.state !== 'ok') return { kind: 'head', since: null, origin: shown(o), why: 'not-found', commits: null };
  return { kind: 'origin', since: v.commit, origin: shown(o), why: null, moved: v.moved, commits: rel.commitsAfter ?? null, src: v.src };
}

/**
 * 畫面要的起點只有三樣:什麼時候、哪一種起點、含幾個對話。感測器記的版本號只拿來找基準,不往外送——
 * 版本代號對 Oscar 沒有意義,只留給「回去」的指令用(lib/collect.mjs 的 basisOf 那段說過同一件事)。
 */
function shown(o) {
  return o ? { at: o.at ?? null, from: o.from ?? null, sessions: o.sessions ?? null } : null;
}

/**
 * 感測器記下的版本號(hook.sh 每一筆都記 `head`:那一刻 `git rev-parse --short HEAD`)換成完整的版本。
 * 認不出來回 null——不是版本號的樣子(空的、舊紀錄沒有)、短版本號撞名(對到不只一個)、這個版本已經不在 repo 裡:
 * 都不往前後找「最接近的一筆」,那是猜(規格:多份規格與新資料夾的起點 AC-10)。
 */
export function commitOfHead(root, head) {
  const h = typeof head === 'string' ? head.trim() : '';
  if (!root || !/^[0-9a-f]{4,64}$/i.test(h)) return null;
  const out = gitRaw(['-C', root, 'rev-parse', '--verify', '-q', `${h}^{commit}`])?.trim() ?? '';
  return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
}

/**
 * 起點之後 HEAD 有沒有指到過別的版本(AC-11):reflog 裡起點那一秒或之後的每一筆、或感測器起點之後任何一筆記的版本號,
 * 任一邊看到跟基準不同就算——改動是 0 的時候要講「看不全」,不畫「沒有改動」(老毛病 P5 的第二個身體)。
 * 同一秒的算之後:分不出先後時往「動過」那邊倒。o.heads 是 roundView 給的、起點之後這個資料夾記到的版本號(短的,比前綴)。
 */
function movedSince(list, o, commit) {
  const sec = Math.floor(Date.parse(o.at) / 1000);
  const byGit = (list ?? []).some((e) => e.sec >= sec && e.sha !== commit);
  const bySensor = (Array.isArray(o.heads) ? o.heads : []).some((h) => typeof h === 'string' && h.trim() && !commit.startsWith(h.trim()));
  return byGit || bySensor;
}

/* ────────────── 從 main 併進來的(規格:併進來的不算這一輪) ────────────── */

// 移動紀錄裡「從別的地方拿進來」的兩種說明,是 git 自己寫的(2026-11-03 在假專案試過):快轉、合併出一個存檔(有衝突的話是存那個合併時寫的)。
// 其他每一種(commit、amend、cherry-pick、rebase、reset、checkout、讀不懂的)都當成這個資料夾自己動的(AC-2、AC-4)
const FF_MOVE = /^(merge|pull)\b.*: Fast-forward$/;
const MERGE_MOVE = /^((merge|pull)\b.*: Merge made by |commit \(merge\): )/;

/**
 * 資料夾自己的移動紀錄(git 的 logs/HEAD),每一行的前後兩個版本:[{ old, new, sec, gs }],舊到新。讀不到回 null。
 * reflogOf 只給得出「後」——中間斷了一截(前一筆的「後」對不上下一筆的「前」)只有這一份看得出來,斷掉的那一截要算自己的(AC-4)。
 * 名字與信箱裡不會有 < >(git 不准),說明裡可能有,所以從第一個 > 切。
 */
function moveLog(root) {
  const p = git(['rev-parse', '--git-path', 'logs/HEAD'], root);
  if (!p) return null;
  let text;
  try { text = readFileSync(isAbsolute(p) ? p : join(root, p), 'utf8'); } catch { return null; }
  const list = [];
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [^<]*<[^>]*> (\d+) [+-]\d{4}(?:\t(.*))?$/.exec(line);
    if (m) list.push({ old: m[1], new: m[2], sec: Number(m[3]), gs: m[4] ?? '' });
  }
  return list;
}

/**
 * 感測器記到這個資料夾、某一刻之後改過的檔(相對路徑)。感測器記的是絕對路徑;不在這個資料夾裡的不算。
 * 「自己動過的」的一部分(AC-2):改了又改回去、git 看不出來的,感測器記得。
 */
export function editedSince(edits, root, fromMs) {
  const out = new Set();
  for (const e of Array.isArray(edits) ? edits : []) {
    const t = Date.parse(e?.ts);
    if (typeof e?.file !== 'string' || !Number.isFinite(t) || t < fromMs - SKEW_MS) continue;
    const rel = isAbsolute(e.file) ? relative(root, e.file) : e.file;
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) out.add(rel.split('\\').join('/'));
  }
  return [...out];
}

/**
 * 基準(since,完整的版本)之後,「從 main 拿進來、這個資料夾自己沒動過」的檔(規格:併進來的不算這一輪 AC-1～AC-4)。
 *   併進來的:fromMs 那一秒或之後(同一秒算之後,跟 versionAt 同一條),移動紀錄說明是快轉 → 前後兩個版本之間改到的檔;
 *     是合併出一個存檔 → 那個存檔帶進來、內容跟另一邊一模一樣的檔。帶進來的那一邊要在 main 的歷史上(本機的 main／master 與它的上游)——
 *     從別條分支(例如還沒結案的另一個對話)拿進來的照算,那些可能還沒人檢查過。
 *   自己動過的:其他每一筆移動改到的檔、合併時跟每一邊都不一樣的檔(自己解的衝突)、中間斷掉的那一截、還沒存的、還沒追蹤的、
 *     own(感測器記到的)。拿掉的只有「併進來的」減掉「自己動過的」。
 * reflog:呼叫端已經讀好的那一份(reflogOf)——裡面沒有「拿進來」那兩種說明,就直接回 none,一個 git 都不多問(AC-9)。
 * @returns {{state:'none'} | {state:'ok', files:string[], commits:number, explained:boolean} | {state:'unknown', why:string}}
 *   none:沒有從 main 拿進來的(或這裡就是 main 本身——併進 main 的是別的對話做完的事,照算);
 *   ok:files 是要拿掉的(沒加引號的路徑),commits 是拿進來的存檔數(含合併那一個存檔,「幾次存檔加起來」要扣掉);
 *     explained:起點之後每一次移動都是從 main 拿進來的(沒有自己的存檔、沒有斷掉的一截)——「這一輪中間動過」就是拿進來那幾次,
 *     沒有藏在別條線上的自己的存檔,0 的時候不必講看不全(changeFacts 照它改 moved);
 *   unknown:分不出來(紀錄讀不到、git 問不到、沒有 main、脫離分支)——呼叫端一個都不准拿掉(AC-4)
 */
export function mergedIn({ root, since, fromMs, reflog, own = [] }) {
  if (!root || !since || !Number.isFinite(fromMs)) return { state: 'none' };
  if (!Array.isArray(reflog)) return { state: 'unknown', why: 'no-reflog' };
  const fromSec = Math.floor(fromMs / 1000);
  const brings = (gs) => FF_MOVE.test(gs ?? '') || MERGE_MOVE.test(gs ?? '');
  if (!reflog.some((e) => e.sec >= fromSec && brings(e.gs))) return { state: 'none' };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const mainRef = ['main', 'master'].find((m) => git(['rev-parse', '--verify', '-q', `refs/heads/${m}`], root));
  if (!branch || !mainRef) return { state: 'unknown', why: 'no-main' };
  if (branch === mainRef) return { state: 'none' };
  if (branch === 'HEAD') return { state: 'unknown', why: 'detached' };
  // main 的歷史:本機的 main、它設定的上游,與上一次抓到的 origin 那一條——app 的「跟上 main」併的是 origin/main,本機的 main 不一定跟上了
  const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${mainRef}@{u}`], root);
  const remote = git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${mainRef}`], root) ? `refs/remotes/origin/${mainRef}` : null;
  const tips = [...new Set([mainRef, up, remote].filter(Boolean))];
  const onMain = (sha) => tips.some((t) => gitExit(['merge-base', '--is-ancestor', sha, t], root) === 0);
  const log = moveLog(root);
  if (!log) return { state: 'unknown', why: 'no-log' };

  let bad = false;
  // 兩個版本之間改到的檔(搬家拆成刪一個、加一個,跟 changeHealth 同一種問法);問不到就整個算分不出來
  const names = (a, b) => {
    const o = git(['diff', '--name-only', '--no-renames', a, b], root);
    if (o === null) { bad = true; return []; }
    return o.split('\n').filter(Boolean).map(unquotePath);
  };
  const count = (range) => { const n = Number(git(['rev-list', '--count', range], root) ?? NaN); if (!Number.isFinite(n)) bad = true; return n; };
  const theirs = new Set(), mine = new Set(own);
  const addAll = (set, list) => { for (const f of list) set.add(f); };
  let brought = 0, prev = since, explained = true;
  // 自己的一次移動:那一次改到的檔是自己的,而且「中間動過」不再全是拿進來的
  const ownMove = (a, b) => { addAll(mine, names(a, b)); explained = false; };
  for (const e of log.filter((x) => x.sec >= fromSec)) {
    if (/^0+$/.test(e.old)) { ownMove(prev, e.new); prev = e.new; continue; }              // 紀錄從這一筆才開始(資料夾剛建):當自己的
    if (e.old !== prev) ownMove(prev, e.old);                                                // 中間斷了一截:那一截算自己的
    if (FF_MOVE.test(e.gs) && onMain(e.new)) {
      addAll(theirs, names(e.old, e.new));
      brought += count(`${e.old}..${e.new}`);
    } else if (MERGE_MOVE.test(e.gs)) {
      const parents = (git(['rev-list', '--parents', '-n', '1', e.new], root) ?? '').split(' ').slice(1);
      if (parents.length < 2 || parents[0] !== e.old) ownMove(e.old, e.new);                 // 認不出是哪兩邊合的:當自己的
      else {
        const others = parents.slice(1);
        const fromMain = others.map(onMain);
        const differs = others.map((p) => new Set(names(p, e.new)));    // 合併的結果跟那一邊不一樣的檔
        for (const f of names(parents[0], e.new)) {
          // 內容跟 main 那一邊一模一樣 → 拿進來的;跟每一邊都不一樣(自己解的衝突)、或只跟不在 main 上的那一邊一樣 → 自己的
          (others.some((p, i) => fromMain[i] && !differs[i].has(f)) ? theirs : mine).add(f);
        }
        if (fromMain.some(Boolean)) brought += count(`${parents[0]}..${e.new}`);
        else explained = false;                                                              // 合的是別條分支:那一次不是從 main 拿進來的
      }
    } else ownMove(e.old, e.new);
    prev = e.new;
  }
  const head = git(['rev-parse', 'HEAD'], root);
  if (!head) bad = true;
  else if (head !== prev) ownMove(prev, head);                                               // 最後一筆之後又動過、沒留紀錄:當自己的
  // 還沒存的、還沒追蹤的一律是自己的(AC-3):合併到一半(還沒存那個合併)時,main 帶進來的也在這裡,照算
  const dirty = dirtyPaths(root);
  if (dirty === null) bad = true; else addAll(mine, dirty);
  if (bad) return { state: 'unknown', why: 'git' };
  return { state: 'ok', files: [...theirs].filter((f) => !mine.has(f)).sort(), commits: brought, explained };
}

/**
 * 給 roundView 的 gitChanges 用的一組。roundView 算出這一輪的起點後呼叫 gitChanges(origin):這裡照那個起點決定基準、問一次 git;
 * 呼叫端在 roundView 之後用 facts() 拿**同一份**(分級、改動體檢、未檢查清單)。
 * 起點只由 roundView 算一次——在外面另算一次,兩邊遲早對不上(老毛病 P2;lib/rounds.mjs 的 roundView「可以給函式」那段說過同一件事)。
 *   healthOf(since, skip)、relationOf(commit):lib/git.mjs 的 changeHealth／checkpointRelation,由呼叫端傳進來。
 *   takeover、reflog:這個資料夾最近一次換人,與算它用的那一份 reflog(同一份,不再讀一次)——roundView 看到的紀錄已經是這一手的(tenureEvents)。
 *   cpAt、edits:章蓋的時間(基準是章的時候,從那一刻看移動紀錄)、這個資料夾感測器記的改檔——算「從 main 併進來的」用(mergedIn)。
 * facts() 另給 merged:mergedIn 的結果。拿掉的檔是 health.skipped(畫面講「另外 N 個從 main 併進來」用的就是它的個數);
 *   base.commits 扣掉拿進來的存檔(「這裡是 N 次存檔加起來的」只數自己的,AC-8)——「回去會丟掉幾次存檔」不讀它,照舊算全部。
 */
export function changeFacts({ root, cpCommit = null, cpCommits = null, cpAt = null, hasCommits = true, isCode, relationOf, healthOf, takeover = null, reflog, edits = [] }) {
  let got = null;
  const at = (origin) => {
    if (!got) {
      // 一個 commit 都沒有:沒有「存檔過的」可以看不到,不准講「存檔過的算不進來」(R1,魔鬼教官 2026-09-22)
      const base = hasCommits ? changeBase({ root, cpCommit, cpCommits, origin, relationOf, reflog, takeover })
        : { kind: 'head', since: null, origin: shown(origin), why: 'no-commits', commits: 0 };
      // 從 main 併進來、這個資料夾沒動過的檔不算這一輪(規格:併進來的不算這一輪)。只看得到還沒存檔的(head)時本來就看不到它們
      const fromMs = base.kind === 'checkpoint' ? Date.parse(cpAt) : base.kind === 'origin' ? Date.parse(base.origin?.at) : NaN;
      const merged = hasCommits && base.since
        ? mergedIn({ root, since: base.since, fromMs, reflog, own: editedSince(edits, root, fromMs) }) : { state: 'none' };
      const skip = merged.state === 'ok' ? merged.files : [];
      if (merged.state === 'ok' && Number.isFinite(base.commits)) base.commits = base.commits - merged.commits >= 0 ? base.commits - merged.commits : null;
      // 起點之後每一次移動都是從 main 拿進來的:「中間動過」就是那幾次,沒有藏在別條線上的自己的存檔——0 的時候講「這一輪自己沒有改動」,不講看不全
      if (merged.state === 'ok' && merged.explained && base.moved) base.moved = false;
      const health = hasCommits ? healthOf(base.since, skip) : null;
      // 拿掉了幾個,跟著基準走:畫面那幾句(lib/scope.mjs)、收工 hook、分級卡拿到的都是同一個數(AC-5)。問不到改動就不講
      base.merged = health?.skipped?.length ?? 0;
      got = { base, health, merged };
    }
    return got;
  };
  return {
    gitChanges: (origin) => gitCodeChanges(root, at(origin).health?.list ?? null, isCode),
    // 這一輪動了的規劃中／進行中規格檔(同一個起點、同一份清單):A 那格講「這一輪還動了 X.md」用(規格:多份規格與新資料夾的起點 AC-6)
    specFiles: (origin) => specFilesOf(at(origin).health?.list ?? null, root),
    // roundView 一定會叫 gitChanges;真的沒叫到(它中途壞了),當成沒有起點——只看還沒存檔的,而且會講
    facts: () => got ?? at(null),
  };
}
