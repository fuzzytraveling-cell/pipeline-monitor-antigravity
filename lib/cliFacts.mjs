/**
 * cliFacts.mjs —— 終端機各指令共用的事實:紀錄與章住哪、這一手、這次改動、五關、分級、這個對話是誰、一句話截多長。
 * 規格:終端機照指令拆開(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-07 從 status.mjs 原封不動搬過來(只多了檔頭、import、最後的 export 清單;HERE 那一行往上一層)。
 * ⚠️ 這支在最底層:不准 import 任何一支 cli*.mjs——別支都從這裡拿,反過來拿就繞成一圈。
 * ⚠️ 三個地址(HERE 程式的資料夾、LOG_DIR、CHECKPOINT_DIR)只在這裡算一次,別支要用就 import——
 *    各算一份遲早指到不同地方:感測器寫在 A、畫面去 B 找(老毛病 P2、P3)。HERE 算錯的話,plugin 名字會安靜退回預設值、
 *    剛好跟真的一樣,畫面上看不出來。
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { changeHealth, ago, uncommitted, checkpointRelation } from './git.mjs';
import { cardFor, sessionTier } from './collect.mjs';
import {
  loadStages, lastRunPerStage, runsPerStage, roundView, editsOf, reportsIn, reportLogIn, decisionsIn, clearLogIn, perStageOfRound,
  specContext, sessionsOf, sessionView, rerunMapOf,
} from './rounds.mjs';
import { buildTier, readTierConfig, codeFileFn, fileTimeOf } from './tier.mjs';
import { changeFacts, reflogOf, takeoverOf, tenureEvents } from './origin.mjs';
import { checkpointFor } from './checkpoint.mjs';
import { dataDir } from './paths.mjs';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));   // lib/ 的上一層 = 程式的資料夾(stages.json、.claude-plugin 在這裡)
// 章與紀錄住哪:lib/paths.mjs 的 dataDir(固定的家 ~/.pipeline-monitor;這一版以前的紀錄還住在程式的主資料夾時照舊用舊的)。
// 寫的跟讀的必須看同一個地方,否則感測器記在 A、畫面去 B 找(老毛病 P2)。第一次問的時候順便搬家(規格:紀錄搬到固定的家),
// 所以這兩行在載入這支的那一刻就算——任何指令寫東西之前。
// ⚠️ 測試要在同一個程式裡載入這支(或 import 它的 cli*.mjs)的話,_harness.mjs 要排第一個 import:它先換上假的家。
const CHECKPOINT_DIR = dataDir('checkpoints', HERE);
const LOG_DIR = dataDir('logs', HERE);

/* ────────────────────────── 章（AC-1 / AC-4 / AC-6） ──────────────────────────
 * 章住哪、認哪一顆:lib/checkpoint.mjs(儀表板、收工 hook 同一個函式)。以前這裡照「專案__分支.json」找、儀表板照檔案裡的 worktree 找,
 * 各算一次——app 把舊資料夾換新分支給新對話用之後,兩邊講不同的話(規格:新對話接手舊資料夾 AC-3,老毛病 P2)。
 * 找不到 = 還不知道(AC-4),不是「沒綠過」;寫不進去要大聲(AC-6),跟感測器刻意相反。 */

/**
 * 這個資料夾這一手的事實(規格:新對話接手舊資料夾):最近一次換人、這一手的紀錄。gatherChange 跟 --spec 都從這裡拿,不各算一次。
 * 「感測器活著嗎、從什麼時候開始記」講的是整個資料夾,照舊看 ev.events(全部)。
 */
function tenureOfCtx(ctx, ev) {
  const reflog = ctx.hasCommits ? reflogOf(ctx.root) : null;
  const takeover = takeoverOf({ reflog, events: ev.events, cwd: ctx.root });
  return { reflog, takeover, events: tenureEvents(ev.events, ctx.root, takeover) };
}

/**
 * 還原點的事實。「這次改動」(h)與它的基準(base)在 stageFacts 裡跟五關一起算——起點是五關那一輪的起點(lib/origin.mjs),
 * 算完由 main() 放回這裡。畫面(render)與分級(--tier)都吃這一份,兩邊才不會各算各的(老毛病 P2)。
 */
function gatherChange(ctx, ev) {
  // 這一手(規格:新對話接手舊資料夾):資料夾換過人的話,上一手蓋的章、跑的關都不算這一輪的
  const tn = tenureOfCtx(ctx, ev);
  const cp = checkpointFor({ dir: CHECKPOINT_DIR, project: ctx.project, root: ctx.root, branch: ctx.branch, takeover: tn.takeover });
  const dirty = uncommitted(ctx.root);
  // ⚠️ L14:章只有在它指的版本還在這條分支的歷史上時才算數,詳見 checkpointRelation()。
  const rel = cp ? checkpointRelation(ctx.root, cp.commit) : null;
  const cpUsable = rel?.state === 'ok';
  return { cp, dirty, rel, cpUsable, tenure: tn, h: null, base: null };
}

/** 五關的事實,一次算好:關卡清單、每關最後一次紀錄、人蓋的結案。五關那段與分級那段共用。 */
function stageFacts(ctx, ev, info = {}) {
  const { stages, broken: stagesBroken = null } = loadStages(HERE, ctx.root, ctx.mainRoot);
  // 「有沒有任何一筆來自這裡」講的是感測器,看整個資料夾的紀錄;下面算這一輪的全部只看這一手的(規格:新對話接手舊資料夾)——
  // 資料夾換過人的話,上一手的 A、C、D、結論、你說處理完了、規格連結都不在 events 裡
  const { sawAnyEventHere } = lastRunPerStage(ev.events, stages, ctx.root);
  const tn = info.tenure ?? tenureOfCtx(ctx, ev);
  const events = tn.events;
  // 人蓋的「結案」事件(AC-9)。source:'human' 是刻意標的——
  // 它跟感測器觀察到的事實不同級,永遠不要混在一起。
  const cleared = new Map();
  for (const e of events) {
    if (e.event === 'stage_cleared' && e.cwd === ctx.root) cleared.set(e.stage, e);
  }
  // Claude 記的結論(stage_report,source:claude)也按工作區記;「程式檔」的判斷跟分級同一份
  const reports = reportsIn(events, (e) => e.cwd === ctx.root);
  const cfg = readTierConfig(ctx.root, ctx.mainRoot, HERE);
  const isCode = codeFileFn(ctx.root, cfg.state === 'ok' ? cfg.config : null);
  const edits = editsOf(events, (e) => e.cwd === ctx.root);
  // 這一輪跑到哪:五關、分級的「需要」、收工 hook 都吃這一份(老毛病 P2)。B 的證據除了感測器,還有 git 說改了的檔案的修改時間(L8)
  const runs = runsPerStage(events, stages, (e) => e.cwd === ctx.root);
  const cpAt = info.cpUsable ? info.cp?.at ?? null : null;
  // 規格連結(施工對話認規格):Claude 跑的(拿得到對話代號,而且這個對話在這裡動過)→ 用這個對話的連結,跟 --spec、收工 hook 同一個代號來源;
  // 人自己在終端機跑拿不到 → 工作區層級,這個工作區只有一個對話在動時等於它(lib/rounds.mjs 的 specContext)。
  // ⚠️ 以前一律用工作區層級:worktree 只要來過別的對話,剛記了連結的 Claude 自己一看就是「A 沒有紀錄」(魔鬼教官 2026-09-21,老毛病 P2)
  const sid = sessionFromEnv();
  const mine = sid && events.some((e) => e.session === sid && inWorkspace(ctx, e.cwd)) ? sid : null;
  // 「這次改動」的基準(lib/origin.mjs):roundView 算出這一輪的起點就照它問 git,改動體檢、分級、五關的 B 拿同一份(規格:這一輪的起點)。
  // 起點最早就是這個資料夾換人那一刻換過去的版本(規格:新對話接手舊資料夾)
  // 從 main 併進來、這個資料夾沒動過的檔不算這一輪(規格:併進來的不算這一輪):跟卡片同一個判斷,同樣給章的時間與感測器記的改檔
  const change = changeFacts({ root: ctx.root, cpCommit: info.cpUsable ? info.cp?.commit ?? null : null, cpCommits: info.rel?.commitsAfter ?? null,
                               cpAt, hasCommits: ctx.hasCommits, isCode,
                               relationOf: (c) => checkpointRelation(ctx.root, c), healthOf: (s, skip) => changeHealth(ctx.root, s, { skip }),
                               takeover: tn.takeover, reflog: tn.reflog, edits, mainRoot: ctx.mainRoot });
  // 起點跟儀表板那張卡同一個(工作區層級:共用資料夾時是最早開口的那個)——分級一個資料夾一份,「調高」也是按資料夾記的。
  // ⚠️ 以前拿這個對話的第一句話配整個資料夾的 A:共用資料夾時終端機跟收工 hook 講不同的等級(魔鬼教官 2026-09-22,P2)。規格連結照舊按這個對話
  const spec = specContext(events, { cwd: ctx.root, cpAt, session: mine });
  const here = (e) => e.cwd === ctx.root;
  const view = roundView({
    runs, stages, cleared, reports, edits, isCode, cpAt,
    gitChanges: change.gitChanges, specFiles: change.specFiles,
    spec: { ...spec, startHere: specContext(events, { cwd: ctx.root, cpAt }).startHere }, root: ctx.root, mainRoot: ctx.mainRoot,
    // 結論會過期的關(D):每一筆結論與決定,配得出「叫 → 結論」、對得回你說的話(D 多輪先問人;跟卡片同一種取法)
    reportLog: reportLogIn(events, here), decisions: decisionsIn(events, here), events,
    clearLog: clearLogIn(events, here), mtimeOf: fileTimeOf(ctx.root),
  });
  // 結論會過期的關(D):Claude 跑的時候按這個對話算——叫了幾次、你說了什麼看這個對話,改檔看整個資料夾——跟收工 hook、--round、對話頁同一份
  // (D 多輪先問人 AC-9)。以前這裡按整個資料夾數叫了幾次:共用資料夾時終端機說「要不要再跑由你決定」、--round 說「這是第一次」、
  // 收工 hook 說「去跑」(魔鬼教官第一輪,老毛病 P2)
  if (mine) {
    const sv = sessionView(events, stages, mine, cpAt, ctx.root, { isCode, gitChanges: [], mainRoot: ctx.mainRoot, folderEdit: view.lastEdit });
    view.stages = view.stages.map((st) => (st.rerunAfterChange ? sv.view.stages.find((x) => x.id === st.id) ?? st : st));
  }
  const { base, health } = change.facts();
  // events:這一手的紀錄——分級(調高的等級)與共用與否也只看它,跟五關同一份
  return { stages, stagesBroken, perStage: perStageOfRound(view), cleared, reports, view, sawAnyEventHere, base, health, events };
}

/** 這一筆紀錄的資料夾在不在這個工作區裡(就是工作區的根,或它底下的子資料夾——對話可以開在專案的子資料夾)。 */
function inWorkspace(ctx, cwd) {
  return typeof cwd === 'string' && (cwd === ctx.root || cwd.startsWith(`${ctx.root}/`));
}

/** Claude Code 給指令的環境變數裡的對話代號。沒有(舊版、或人自己在終端機跑)就是 null——不猜。 */
function sessionFromEnv() {
  const v = String(process.env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  return v && v.length <= 100 ? v : null;
}

/**
 * 這個資料夾(或這個對話)這一輪的五關與分級——--round、--decide 從這裡拿,跟收工 hook 走同一條路(老毛病 P2):
 *   Claude 跑的(拿得到對話代號,而且這個對話在這裡動過)→ lib/collect.mjs 的 cardFor → sessionTier,跟收工 hook、對話頁同一個函式;
 *   人自己在終端機跑 → 這個工作區那一份(跟終端機的五關、儀表板那張卡同一份)。
 * 回 null = 這個資料夾讀不到。
 */
async function rerunFacts(ctx, ev) {
  const sid = sessionFromEnv();
  // 對話開在子資料夾也算在這裡動過(魔鬼教官第一輪:以前只認 cwd 剛好等於根,子資料夾的對話永遠「這一輪還沒有 D 的紀錄」)
  const mine = sid && ev.events.some((e) => e.session === sid && inWorkspace(ctx, e.cwd)) ? sid : null;
  if (mine) {
    const got = cardFor({ monitorDir: HERE, path: ctx.root });
    if (!got || got.card.gone || got.card.notGit) return null;
    const shared = sessionsOf(got.events).find((s) => s.id === mine)?.sharesCwd === true;
    const t = sessionTier({ card: got.card, events: got.events, stages: got.stages, session: mine, cwd: ctx.root, shared, monitorDir: HERE });
    return { view: t.view, tier: t.tier, health: got.card.health, sid: mine, shared, events: got.events };
  }
  const info = gatherChange(ctx, ev);
  const facts = stageFacts(ctx, ev, info);
  info.h = facts.health; info.base = facts.base;
  // 共用與否只算這一手的對話(規格:新對話接手舊資料夾 AC-4):上一手已經撤場,不算跟它共用
  const shared = new Set(facts.events.filter((e) => e.cwd === ctx.root && e.hook && e.session).map((e) => e.session)).size > 1;
  return { view: facts.view, tier: tierOf(ctx, ev, info, facts), health: facts.health, sid: null, shared, events: facts.events };
}

/** 單行紀錄的說明上限(bytes)。整行還有其他欄位,留足夠的餘裕在 4096 之下(感測器 AC-4)。 */
const MAX_NOTE_BYTES = 2500;
/** 照 bytes 截字串,不切在一個中文字中間。 */
function cutBytes(str, max) {
  let out = '';
  for (const ch of String(str)) { if (Buffer.byteLength(out + ch, 'utf8') > max) break; out += ch; }
  return out;
}

function tierOf(ctx, ev, info, facts) {
  return buildTier({
    root: ctx.root, mainRoot: ctx.mainRoot, monitorDir: HERE, health: info.h,
    stages: facts.stages, perStage: facts.perStage, cleared: facts.cleared,
    // 調高的等級也只認這一手的(上一手調的 T2 不跟著新對話走;規格:新對話接手舊資料夾 AC-1)
    events: facts.events ?? ev.events, cwd: ctx.root, cpUsable: info.cpUsable, cpAt: info.cp?.at ?? null,
    head: ctx.head?.slice(0, 7) ?? null, reports: facts.reports, spec: facts.view.spec, rerun: rerunMapOf(facts.view), ago,
    basis: facts.base ? { kind: facts.base.kind, why: facts.base.why ?? null, origin: facts.base.origin ?? null,
                          moved: facts.base.moved === true, commits: facts.base.commits ?? null, merged: facts.base.merged ?? 0 } : null,
  });
}

// 給 cliView.mjs、cliTier.mjs、cliStamp.mjs、cliReport.mjs、cliRerun.mjs、status.mjs 拿。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  HERE, CHECKPOINT_DIR, LOG_DIR, tenureOfCtx, gatherChange, stageFacts, sessionFromEnv, rerunFacts, MAX_NOTE_BYTES, cutBytes, tierOf,
};
