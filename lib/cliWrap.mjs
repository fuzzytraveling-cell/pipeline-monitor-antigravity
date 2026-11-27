/**
 * cliWrap.mjs —— --wrap <步驟> "<你的原話>":主任收尾(規格:主任動手收尾,路徑看 CLAUDE.md 的表)。
 * 你回了主任合成的那一個問題之後,那個對話照問題裡的順序,一步叫一次:
 *   merge    併進 main——在主資料夾只快轉,做完再問一次 main 指到哪(AC-2)
 *   push     推上 GitHub——推完當場問 GitHub 上的 main 是哪一個存檔,跟這台一樣才算(AC-3)
 *   restart  儀表板的服務——啟動之後它用到的程式改過才重啟,重啟完再問一次(AC-4)
 *   stamp    蓋章——還有一關的結論沒了結就不蓋(AC-5),之後照 --checkpoint 那一套,蓋完讀回來對
 * 每一步印一行:成了／不用／沒成／沒做／問不到——「成了」只在自己確認過之後印(R2)。每一行附你的原話,讓你自己對得出來(AC-7)。
 * 沒有你那句話不動手(AC-6):原話要在主任最後一次被叫之後、你打的話裡找得到;同一句話每一步只試一次——每試一次記一筆(event:'wrap')。
 * 不做真的合併、rebase、reset、force push;不按結案;不替別的對話收尾(規格「明確不做」)。順序、做哪幾步是技能的事(skills/director/SKILL.md)。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { uncommitted, ago } from './git.mjs';
import { logFileOf } from './events.mjs';
import { checkpointFor } from './checkpoint.mjs';
import { saidByHuman, skillCallsOf, isAskQuestion, isPromptCut, isAfterAnchor } from './rounds.mjs';
import { LOG_DIR, CHECKPOINT_DIR, sessionFromEnv, cutBytes } from './cliFacts.mjs';
import { doCheckpoint, rerunBlock } from './cliStamp.mjs';
import { restartService } from './service.mjs';
import { serveStateOf } from './cliTodo.mjs';
import { stepDispatch, stepCleanWorktree, stepArchive, normalizeWrapTarget } from './cliDispatch.mjs';
import { zhEn, plural } from './lang.mjs';

// 主任那一支技能(skills/director/SKILL.md):plugin 自己帶的,不是哪個專案的關——所以不住 stages.json,也不讓「這一輪」重新起算
const DIRECTOR = 'director';
// 感測器記你每句話的前 200 字(hook.sh 的 prompt 那一格)
const SENSOR_CUT = 200;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const short = (sha) => String(sha ?? '').slice(0, 7);
/** git 自己說的話,最後兩行。網址裡帶的帳號密碼拿掉(https://帳號:token@github.com 那種)——不印憑證 */
const tail = (s) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ').replace(/\/\/[^/@\s]+@/g, '//').slice(0, 240);

/**
 * 直接問 git,不走 lib/git.mjs 的 git():那一支在儀表板刷新時會記住答案,併之前、併之後要問的是兩個不同時刻的答案。
 * 回 {ok, out, status}:失敗時 out 是 git 自己說的話(拿來講原因)。
 */
function gitRun(args, cwd) {
  try {
    return { ok: true, out: execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), status: 0 };
  } catch (e) {
    return { ok: false, out: String(e.stderr ?? '').trim() || String(e.stdout ?? '').trim(), status: typeof e.status === 'number' ? e.status : null };
  }
}
const fresh = (args, cwd) => { const r = gitRun(args, cwd); return r.ok ? r.out : null; };
const mainRefOf = (dir) => ['main', 'master'].find((m) => fresh(['rev-parse', '--verify', '-q', `refs/heads/${m}`], dir)) ?? null;
/** 那個存檔的版本號(package.json 的 version),回報「(v0.40.0)」用;讀不到就不講 */
function versionAt(dir, sha) {
  const raw = fresh(['show', `${sha}:package.json`], dir);
  let v = null;
  try { v = JSON.parse(raw ?? '')?.version ?? null; } catch { v = null; }
  return typeof v === 'string' && v ? zhEn(`（v${v}）`, ` (v${v})`) : '';
}

/* ══════════════════════ 你說的那一句(AC-6) ══════════════════════ */

/**
 * 你在主任最後一次被叫之後說的話裡,有沒有這一句。只看感測器記的、只認你打的(saidByHuman,跟 --decide 同一套):
 * 別的對話傳來的、背景工作的通知、app 包在對話開頭的那一層(prompt_wrap)都不算你說的(老毛病 P7)。
 * 同一句說了兩次,認最後那一次——你再說一次就是再准一次(AC-6:要再推就再說一句)。
 * 主任再被叫一次,之前的話全部不算(只看最後一次被叫之後)。
 * @returns {{state:'ok', said:{ts, text}, cut:boolean} | {state:'no-director'} | {state:'not-found', since:string}}
 *   cut:你那句話超過感測器記的 200 字,只比對了前 200 字(回報要講明)
 */
export function findWords(events, sid, quote) {
  const mine = events.filter((e) => e.session === sid);
  const call = skillCallsOf(mine, DIRECTOR).at(-1) ?? null;
  if (!call) return { state: 'no-director' };
  const from = Date.parse(call.ts);
  const q = norm(quote);
  const matches = (raw, cutFlag) => {
    const p = norm(raw);
    if (!p) return null;
    if (p.includes(q)) return { text: raw, cut: false };
    if (cutFlag && q.startsWith(p)) return { text: raw, cut: true };
    return null;
  };
  for (const e of [...mine].reverse()) {
    if (!saidByHuman(e) || e.prompt_wrap || !isAfterAnchor(e, from, call.step ?? null)) continue;
    if (isAskQuestion(e) && Array.isArray(e.ask_answers)) {
      for (const ans of e.ask_answers) {
        if (typeof ans !== 'string') continue;
        const ahit = matches(ans, [...ans].length >= SENSOR_CUT);
        if (ahit) return { state: 'ok', said: { ts: e.ts, text: ahit.text, via: 'ask_question' }, cut: ahit.cut };
      }
    }
    const hit = matches(e.prompt, isPromptCut(e));
    if (hit) return { state: 'ok', said: { ts: e.ts, text: hit.text, via: e.via ?? null }, cut: hit.cut };
  }
  return { state: 'not-found', since: call.ts };
}

/** 這一句話是不是已經拿來做過這一步(AC-6:一句話每一步只試一次;帶目標步驟比對正規化後的 target)。回那一筆紀錄,沒有回 null */
export function triedBefore(events, sid, step, saidTs, target = null) {
  return events.filter((e) => e.event === 'wrap' && e.by_session === sid && e.step === step && e.said_ts === saidTs
    && (target ? (e.target ?? null) === target : true)).at(-1) ?? null;
}

/* ══════════════════════ 四步 ══════════════════════ */

/** 併進 main(AC-2):在主資料夾把 main 快轉到這條分支最後一個存檔。不做真的合併、不 rebase、不 reset */
function stepMerge(ctx) {
  const label = zhEn('併進 main', 'Merge into main');
  const no = (text) => ({ label, kind: 'not-done', text });
  if (!ctx.branch || ctx.branch === 'HEAD') return no(zhEn('這個資料夾不在任何一條分支上（脫離分支），分不出要併哪一條', 'this folder isn\'t on any branch (detached), so it can\'t tell which branch to merge'));
  const dirty = uncommitted(ctx.root);
  if (dirty === null) return no(zhEn('問不到這個資料夾的檔案存了沒', 'couldn\'t check whether this folder\'s files are committed'));
  if (dirty > 0) return no(zhEn(`這個資料夾還有 ${dirty} 個檔沒存——沒存的不會跟著過去，先存檔`, `this folder still has ${plural(dirty, 'file')} not committed, and uncommitted files don't go along; commit first`));
  const main = ctx.mainRoot ?? ctx.root;
  const ref = mainRefOf(main);
  if (!ref) return no(zhEn('這個專案找不到 main（也沒有 master）', 'this project has no main (and no master) branch'));
  if (ctx.branch === ref) return { label, kind: 'no-need', text: zhEn(`這個資料夾就在 ${ref} 上，沒有分支要併`, `this folder is on ${ref} itself, so there's no branch to merge`) };
  const at = fresh(['rev-parse', '--abbrev-ref', 'HEAD'], main);
  if (at !== ref) return no(zhEn(`主資料夾現在不在 ${ref} 上（${at ? `在 ${at}` : '問不到它在哪'}），不動它——回來問你`, `the main folder isn't on ${ref} right now (${at ? `it's on ${at}` : 'couldn\'t check where it is'}), so it's left alone; asking you first`));
  const mdirty = uncommitted(main);
  if (mdirty === null) return no(zhEn('問不到主資料夾的檔案存了沒', 'couldn\'t check whether the main folder\'s files are committed'));
  if (mdirty > 0) return no(zhEn(`主資料夾有 ${mdirty} 個檔還沒存，不動它——回來問你`, `the main folder has ${plural(mdirty, 'file')} not committed, so it's left alone; asking you first`));
  const tip = fresh(['rev-parse', 'HEAD'], ctx.root);
  const before = fresh(['rev-parse', `refs/heads/${ref}`], main);
  if (!tip || !before) return { label, kind: 'unknown', text: zhEn(`問不到這條分支或 ${ref} 現在是哪一個存檔`, `couldn't check which commit this branch or ${ref} is on`) };
  const ver = versionAt(ctx.root, tip);
  if (tip === before) return { label, kind: 'no-need', text: zhEn(`${ref} 已經就是這條分支最後一個存檔 ${short(tip)}${ver}`, `${ref} is already this branch's last commit, ${short(tip)}${ver}`) };
  // 快轉只有一種情況做得到:main 現在那一個存檔就在這條分支的歷史上。不是 → main 多了這條分支沒有的存檔(誰的分不出來,不講是別的對話的)
  const anc = gitRun(['merge-base', '--is-ancestor', before, tip], ctx.root);
  if (!anc.ok && anc.status !== 1) return { label, kind: 'unknown', text: zhEn(`問不到 ${ref} 跟這條分支的關係`, `couldn't check how ${ref} relates to this branch`) };
  if (!anc.ok) {
    const c = fresh(['rev-list', '--count', `${tip}..${before}`], ctx.root);
    const n = c === null ? null : Number(c);
    return no(zhEn(`${ref} 多了${Number.isFinite(n) ? ` ${n} 個` : ''}這條分支沒有的存檔，快轉不了——要先把 ${ref} 併進這條分支、再跑一次檢查，才能快轉；你說好才做`,
      `${ref} has ${Number.isFinite(n) ? plural(n, 'commit') : 'commits'} this branch doesn't have, so it can't fast-forward: ${ref} has to be merged into this branch and the checks run again first; only if you say so`));
  }
  const r = gitRun(['merge', '--ff-only', tip], main);
  const after = fresh(['rev-parse', `refs/heads/${ref}`], main);
  if (after === tip) return { label, kind: 'done', text: zhEn(`${ref} 現在就是這條分支最後一個存檔 ${short(tip)}${ver}`, `${ref} is now this branch's last commit, ${short(tip)}${ver}`) };
  return { label, kind: 'failed', text: zhEn(`${ref} 現在是 ${after ? short(after) : '（問不到）'}，不是 ${short(tip)}${r.ok ? '' : `——git 說：${tail(r.out)}`}`,
    `${ref} is now ${after ? short(after) : '(couldn\'t check)'}, not ${short(tip)}${r.ok ? '' : `; git says: ${tail(r.out)}`}`) };
}

/** git 設定的一格:{value} 有設、{unset} 沒設(git 用離開碼 1 回答)、{unknown} 問不到——沒問到不准當成沒設(R1) */
function configOf(dir, key) {
  const r = gitRun(['config', '--get', key], dir);
  return r.ok ? { value: r.out } : r.status === 1 ? { unset: true } : { unknown: true };
}

/** 推上 GitHub(AC-3):推的是整個 main;推完當場問那一邊的 main 是哪一個存檔。絕不加 --force(明確不做) */
function stepPush(ctx) {
  const main = ctx.mainRoot ?? ctx.root;
  const ref = mainRefOf(main);
  const labelOf = (dest) => zhEn(`推上 ${dest}`, `Push to ${dest}`);
  if (!ref) return { label: labelOf('GitHub'), kind: 'not-done', text: zhEn('這個專案找不到 main（也沒有 master）', 'this project has no main (and no master) branch') };
  const remote = configOf(main, `branch.${ref}.remote`), merge = configOf(main, `branch.${ref}.merge`);
  if (remote.unknown || merge.unknown) return { label: labelOf('GitHub'), kind: 'unknown', text: zhEn(`問不到 ${ref} 要推到哪裡`, `couldn't check where ${ref} pushes to`) };
  if (remote.unset || merge.unset) return { label: labelOf('GitHub'), kind: 'no-need', text: zhEn(`${ref} 沒有設定要推到哪裡（沒有上游），這一步不用做`, `${ref} isn't set up to push anywhere (no upstream), so this step isn't needed`) };
  const url = fresh(['remote', 'get-url', remote.value], main) ?? '';
  const dest = /github\.com/i.test(url) ? 'GitHub' : remote.value;
  const label = labelOf(dest);
  const local = fresh(['rev-parse', `refs/heads/${ref}`], main);
  if (!local) return { label, kind: 'unknown', text: zhEn(`問不到這台的 ${ref} 是哪一個存檔`, `couldn't check which commit ${ref} is on here`) };
  const r = gitRun(['push', remote.value, `refs/heads/${ref}:${merge.value}`], main);
  if (!r.ok) {
    // 那一邊有這台沒有的存檔:不硬推(明確不做),回來問
    if (/\[rejected\]|non-fast-forward|fetch first|stale info/i.test(r.out)) {
      return { label, kind: 'failed', text: zhEn(`${dest} 上有這台沒有的存檔，沒推（不硬推）——回來問你`, `${dest} has commits this machine doesn't, so it wasn't pushed (no force push); asking you first`) };
    }
    return { label, kind: 'failed', text: zhEn(`推不上去——git 說：${tail(r.out)}`, `couldn't push; git says: ${tail(r.out)}`) };
  }
  const line = fresh(['ls-remote', remote.value, merge.value], main);
  const theirs = line ? line.split(/\s+/)[0] : null;
  const ver = versionAt(main, local);
  if (!theirs) return { label, kind: 'unknown', text: zhEn(`推了，但問不到 ${dest} 上現在是哪一版——不說推上去了`, `pushed, but couldn't check which version ${dest} has now, so it isn't called pushed`) };
  if (theirs === local) return { label, kind: 'done', text: zhEn(`${dest} 上的 ${ref} 就是 ${short(local)}${ver}，跟這台一樣`, `${dest}'s ${ref} is ${short(local)}${ver}, the same as this machine`) };
  return { label, kind: 'failed', text: zhEn(`${dest} 上的 ${ref} 是 ${short(theirs)}，不是這台的 ${short(local)}`, `${dest}'s ${ref} is ${short(theirs)}, not this machine's ${short(local)}`) };
}

const few = (files) => zhEn(`${files.slice(0, 3).join('、')}${files.length > 3 ? ` 等 ${files.length} 個檔` : ''}`, `${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and others (${files.length} files)` : ''}`);

/** 重啟之後再問一次服務(AC-4)。--wrap restart 跟直接叫 --serve-restart 講同一句:只補一條,另一條照舊「回應中」就算重啟了(老毛病 P6) */
function confirmOf(s) {
  if (s.state === 'ok' && Array.isArray(s.changed) && !s.changed.length) {
    return { kind: 'done', text: zhEn(`服務${s.bootAt ? ` ${ago(s.bootAt)}` : ''}剛啟動，跑的是現在的程式`, `the service just started${s.bootAt ? ` (${ago(s.bootAt)})` : ''} and is running the current program`) };
  }
  if (s.state === 'ok' && Array.isArray(s.changed)) return { kind: 'failed', text: zhEn(`重啟之後服務還是說 ${few(s.changed)} 改過`, `after the restart the service still says ${few(s.changed)} changed`) };
  return { kind: 'unknown', text: zhEn('重啟了，但問不到它跑的是不是現在的程式', 'restarted, but couldn\'t check whether it\'s running the current program') };
}

/**
 * 重啟儀表板(AC-4):問服務啟動之後它用到的程式改過沒有(白板最上面那一句的同一個來源,lib/cliTodo.mjs 的 serveStateOf)——
 * 沒改過不重啟;改過(或服務舊到還不會回答)才重啟,重啟完再問一次。連不上不講「不用重啟」(R1)。
 */
export async function stepRestart(ctx, ev, { ask = serveStateOf, restart = restartService } = {}) {
  const label = zhEn('重啟儀表板', 'Restart the dashboard');
  const s0 = await ask();
  if (s0.state === 'down') return { label, kind: 'not-done', text: zhEn('連不上儀表板的服務，不知道要不要重啟', 'couldn\'t connect to the dashboard service, so it\'s unknown whether it needs a restart') };
  if (s0.state === 'slow') return { label, kind: 'not-done', text: zhEn(`儀表板的服務 ${s0.seconds} 秒內沒回答（可能正忙），不知道要不要重啟`, `the dashboard service didn't answer within ${s0.seconds} seconds (it might be busy), so it's unknown whether it needs a restart`) };
  if (s0.state === 'ok' && !Array.isArray(s0.changed)) return { label, kind: 'not-done', text: zhEn('問不到服務啟動之後程式有沒有改過', 'couldn\'t check whether the program changed after the service started') };
  if (s0.state === 'ok' && !s0.changed.length) {
    return { label, kind: 'no-need', text: zhEn(`服務${s0.bootAt ? ` ${ago(s0.bootAt)}` : ''}啟動之後，它用到的程式沒改過`, `the program the service uses hasn't changed since it started${s0.bootAt ? ` (${ago(s0.bootAt)})` : ''}`) };
  }
  const r = await restart();
  if (!r.ok) return { label, kind: 'failed', text: tail((r.out ?? []).join('\n')) };
  return { label, ...confirmOf(await ask()) };
}

/** 直接叫 --serve-restart:照舊重啟,之後補上同一個確認(AC-4)。ok 只在服務說跑的是現在的程式時成立 */
export async function restartConfirmed({ ask = serveStateOf, restart = restartService } = {}) {
  const r = await restart();
  if (!r.ok) return r;
  const c = confirmOf(await ask());
  return { ok: c.kind === 'done', out: [...r.out, `   ${c.kind === 'done' ? '' : '⚠️ '}${c.text}`] };
}

/** 蓋章(AC-5):還有一關的結論沒了結就不蓋(跟 --checkpoint 同一個檢查、同一句);蓋完把章讀回來,蓋在這個存檔上才說成了 */
async function stepStamp(ctx, ev) {
  const label = zhEn('蓋章', 'Stamp');
  const block = await rerunBlock(ctx, ev);
  if (block) {
    return { label, kind: 'not-done', text: zhEn(`還有一關的結論沒了結——${block.text}；蓋章會結掉這一輪，那一題就跟著不見`,
      `a stage's conclusion isn't settled yet: ${block.text}; stamping ends this round, and that question would disappear with it`) };
  }
  const code = await doCheckpoint(ctx, ev, { skipD: true });
  if (code !== 0) return { label, kind: 'failed', text: zhEn('沒蓋——原因在上面那幾行', 'not stamped; the reason is in the lines above') };
  const cp = checkpointFor({ dir: CHECKPOINT_DIR, project: ctx.project, root: ctx.root, branch: ctx.branch });
  return cp?.commit === ctx.head
    ? { label, kind: 'done', text: zhEn(`章蓋在 ${short(ctx.head)}，讀回來對得上`, `the stamp is on ${short(ctx.head)}, and reading it back matches`) }
    : { label, kind: 'unknown', text: zhEn('它說蓋了，但讀回來的章不是這一個存檔——當成沒有還原點', 'it says it stamped, but the stamp read back isn\'t on this commit; treat it as no restore point') };
}

export const TARGETED_STEPS = new Set(['dispatch', 'clean-worktree', 'archive']);
export const STEPS = {
  merge: stepMerge, push: stepPush, restart: stepRestart, stamp: stepStamp,
  dispatch: stepDispatch, 'clean-worktree': stepCleanWorktree, archive: stepArchive,
};
const LABELS = () => ({
  merge: zhEn('併進 main', 'Merge into main'), push: zhEn('推上 GitHub', 'Push to GitHub'),
  restart: zhEn('重啟儀表板', 'Restart the dashboard'), stamp: zhEn('蓋章', 'Stamp'),
  dispatch: zhEn('派工開新對話', 'Dispatch new conversation'),
  'clean-worktree': zhEn('清理舊 worktree', 'Clean old worktree'),
  archive: zhEn('歸檔舊對話', 'Archive conversation'),
});
const KIND = () => ({ done: zhEn('成了', 'done'), 'no-need': zhEn('不用', 'not needed'), 'not-done': zhEn('沒做', 'not done'), failed: zhEn('沒成', 'didn\'t go through'), unknown: zhEn('問不到', 'couldn\'t check') });
const lineOf = (res) => zhEn(`${res.label}：${KIND()[res.kind]}——${res.text}`, `${res.label}: ${KIND()[res.kind]}: ${res.text}`);

/* ══════════════════════ --wrap ══════════════════════ */

/**
 * --wrap <步驟> [<目標>] "<你的原話>"。回 0:成了或不用;回 1:沒做、沒成、問不到——技能照這個停(AC-1:第一個沒成的就停,後面的寫沒做)。
 * 依步驟類型分流解析無目標四步與帶目標三步（預審 #1，防止含空白路徑污染原話）。
 */
export async function doWrap(ctx, ev, args, {
  sid = sessionFromEnv(),
  steps = STEPS,
  env = process.env,
  fetchImpl = fetch,
  monitorDir,
  home,
  logDir = LOG_DIR,
} = {}) {
  const step = args[0];
  if (!step || !Object.hasOwn(steps, step)) {
    console.log(zhEn('用法：agy-pipeline --wrap <merge|push|restart|stamp> "<你在主任問完之後說的原話>"', 'Usage: agy-pipeline --wrap <merge|push|restart|stamp> "<what the user said after the site director asked, word for word>"'));
    console.log(zhEn('   或：agy-pipeline --wrap <dispatch|clean-worktree|archive> <目標> "<你在主任問完之後說的原話>"', '   or: agy-pipeline --wrap <dispatch|clean-worktree|archive> <target> "<what the user said after the site director asked, word for word>"'));
    console.log(zhEn('   merge 併進 main（只快轉）· push 推上 GitHub · restart 重啟儀表板（改過才重啟）· stamp 蓋章（最後做）',
      '   merge: into main (fast-forward only) · push: to GitHub · restart: the dashboard (only if changed) · stamp: last'));
    console.log(zhEn('   dispatch <taskId> 派工開新對話 · clean-worktree <path|branch> 安全移除已合併 worktree · archive <conversationId> 歸檔已結案對話',
      '   dispatch <taskId>: start a new conversation · clean-worktree <path|branch>: remove merged worktree · archive <conversationId>: archive closed conversation'));
    return 1;
  }
  const label = LABELS()[step];
  const not = (text) => { console.log(lineOf({ label, kind: 'not-done', text })); return 1; };
  const targeted = TARGETED_STEPS.has(step);
  const rawTarget = targeted ? String(args[1] ?? '').trim() : null;
  const quote = (targeted ? args.slice(2) : args.slice(1)).join(' ').trim();
  if (targeted && !rawTarget) {
    return not(zhEn(`這一步需要指定目標（例：--wrap ${step} <目標> "<原話>"）`, `This step needs a target (e.g. --wrap ${step} <target> "<words>")`));
  }
  if (!quote) return not(zhEn('要附上你在主任問完之後說的原話', 'attach what the user said after the site director asked, word for word'));
  if (!sid) return not(zhEn('拿不到這是哪個對話（不是從 Antigravity 跑的），找不到你說的話', 'can\'t tell which conversation this is (not run from Antigravity), so the user\'s words can\'t be found'));
  const events = ev?.events ?? [];
  const w = findWords(events, sid, quote);
  if (w.state === 'no-director') return not(zhEn('這個對話還沒叫過主任——收尾要先叫主任合成那一個問題，你回答之後才做', 'this conversation hasn\'t called the site director yet: the wrap-up waits for its one question and the user\'s answer'));
  if (w.state === 'not-found') {
    return not(zhEn(`找不到你在主任問完之後說的這句話：「${quote.slice(0, 60)}」（感測器只記你每句話的前 200 字）`,
      `can't find these words from the user after the site director asked: “${quote.slice(0, 60)}” (the sensor keeps only the first 200 characters of each message)`));
  }
  const normTarget = targeted ? normalizeWrapTarget(step, rawTarget, ctx) : null;
  const prev = triedBefore(events, sid, step, w.said.ts, normTarget);
  if (prev) {
    return not(zhEn(`你這一句已經拿來做過一次（${KIND()[prev.result] ?? prev.result}）——要再做一次，請你再說一句`,
      `these words were already used for this step once (${KIND()[prev.result] ?? prev.result}); to do it again, the user has to say so again`));
  }
  const res = await steps[step](ctx, ev, { target: rawTarget, normTarget, sid, env, fetchImpl, ...(monitorDir ? { monitorDir } : {}), ...(home ? { home } : {}), logDir });
  console.log(lineOf(res));
  const t = [...norm(w.said.text)].slice(0, 60).join('');
  if (w.said.via === 'ask_question') {
    console.log(zhEn(`   （照你在選項卡點的回覆「${t}」${w.cut ? '；那一題回覆只比對了前 200 字' : ''}）`,
      `   (going by your option-card reply: “${t}”${w.cut ? '; only the first 200 characters of that answer were compared' : ''})`));
  } else {
    console.log(zhEn(`   （照你說的「${t}」${w.cut ? '；你那句話只比對了感測器記的前 200 字' : ''}）`,
      `   (going by what the user said: “${t}”${w.cut ? '; only the first 200 characters the sensor keeps were compared' : ''})`));
  }
  try {
    appendFileSync(logFileOf(logDir, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'wrap', step, ...(normTarget ? { target: normTarget } : {}),
      result: res.kind, quote: cutBytes(quote, 600), said_ts: w.said.ts,
      by_session: sid, cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'ai',
    }) + '\n');
  } catch (e) {
    // 記不下來:這一步照樣做了,但「只試一次」看不到它——大聲講(跟蓋章同一邊:以為有、其實沒有,是害人的那一邊)
    console.log(zhEn(`   ⚠️ 這一步做了，但沒記下來（${e.message}）——同一句話之後會被當成還沒試過`, `   ⚠️ This step was done, but it couldn't be recorded (${e.message}); the same words will look untried afterwards`));
  }
  return res.kind === 'done' || res.kind === 'no-need' ? 0 : 1;
}
