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
 */
import { execFileSync } from 'node:child_process';
import { gitCodeChanges } from './tier.mjs';

/**
 * HEAD 的 reflog,**舊到新**:[{ sha, sec }]。問不到回 null——不是空陣列,空陣列是「問到了,沒有任何一筆」。
 * ⚠️ 用 --date=unix:git 預設的時間帶本地時差(+08:00),拿去跟 UTC 的起點比字串會錯(魔鬼教官 2026-09-16 第四次抓過)。
 * 每個 worktree 有自己的一份;app 開 worktree 那一刻就有一筆(2026-09-22 實測)。
 */
export function reflogOf(root, { limit = 5000 } = {}) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'reflog', 'show', `-n${limit}`, '--date=unix', '--format=%H %gd', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{40,64}) \S*@\{(\d+)\}$/);
    if (m) list.push({ sha: m[1], sec: Number(m[2]) });
  }
  return list.reverse();
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
 * @returns {{kind:'checkpoint'|'origin'|'head', since:string|null, origin:object|null, why:string|null, moved?:boolean, commits:number|null}}
 *   since 是給 git diff 的版本,null = HEAD(只看還沒存檔的)。why 只有 head 才有:no-origin(沒有這一輪的紀錄)／not-found／no-commits
 *   commits:基準之後存了幾次檔(問不到是 null)——「這一輪 22 個檔」是好幾次存檔加起來的,旁邊的比例尺是一次存檔的,要講(L6)
 */
export function changeBase({ root, cpCommit = null, cpCommits = null, origin = null, relationOf, reflog }) {
  if (cpCommit) return { kind: 'checkpoint', since: cpCommit, origin, why: null, commits: cpCommits };
  if (!origin?.at) return { kind: 'head', since: null, origin: null, why: 'no-origin', commits: null };
  const v = versionAt(root, origin.at, { reflog });
  if (v.state !== 'ok') return { kind: 'head', since: null, origin, why: 'not-found', commits: null };
  let rel = null;
  try { rel = relationOf(v.commit); } catch { rel = null; }
  if (rel?.state !== 'ok') return { kind: 'head', since: null, origin, why: 'not-found', commits: null };
  return { kind: 'origin', since: v.commit, origin, why: null, moved: v.moved, commits: rel.commitsAfter ?? null };
}

/**
 * 給 roundView 的 gitChanges 用的一組。roundView 算出這一輪的起點後呼叫 gitChanges(origin):這裡照那個起點決定基準、問一次 git;
 * 呼叫端在 roundView 之後用 facts() 拿**同一份**(分級、改動體檢、未檢查清單)。
 * 起點只由 roundView 算一次——在外面另算一次,兩邊遲早對不上(老毛病 P2;lib/events.mjs 的 roundStartOf 那段說過同一件事)。
 *   healthOf(since)、relationOf(commit):lib/git.mjs 的 changeHealth／checkpointRelation,由呼叫端傳進來。
 */
export function changeFacts({ root, cpCommit = null, cpCommits = null, hasCommits = true, isCode, relationOf, healthOf }) {
  let got = null;
  const at = (origin) => {
    if (!got) {
      // 一個 commit 都沒有:沒有「存檔過的」可以看不到,不准講「存檔過的算不進來」(R1,魔鬼教官 2026-09-22)
      const base = hasCommits ? changeBase({ root, cpCommit, cpCommits, origin, relationOf })
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
