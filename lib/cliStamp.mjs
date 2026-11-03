/**
 * cliStamp.mjs —— 蓋章(--checkpoint):認這個專案有哪幾項檢查、一項一項跑、沒過時講清楚是「沒過」還是「沒跑起來」、全綠才寫章。
 * 規格:pipeline-status、誠實修補、終端機照指令拆開(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-07 從 status.mjs 原封不動搬過來。章住哪、怎麼寫在 lib/checkpoint.mjs(危險清單上);這裡只決定蓋不蓋、怎麼講。
 * 共用的事實從 cliFacts.mjs 拿;D 的事了結了沒,跟白板問同一個函式、講同一句(lib/todo.mjs 的 stageItemOf,規格:主任動手收尾 AC-5)。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { uncommitted, ago } from './git.mjs';
import { writeCheckpoint } from './checkpoint.mjs';
import { CHECKPOINT_DIR, rerunFacts } from './cliFacts.mjs';
import { stageItemOf } from './todo.mjs';
import { screenStages } from './collect.mjs';
import { tierLines } from './tier.mjs';
import { zhEn, plural } from './lang.mjs';

/* ────────────────────────── 要跑哪幾項檢查 ──────────────────────────
 * ⚠️ AC-10 可攜性：不准寫死 TutorPod 的四項。
 * 從專案自己的 package.json scripts 認，認不到就說認不到。 */
const CANDIDATE_SCRIPTS = ['lint', 'test', 'test:unit', 'build'];

function detectChecks(root) {
  const p = join(root, 'package.json');
  if (!existsSync(p)) return null;              // 不是 npm 專案 → 沒問到，不是「沒有檢查」
  try {
    const scripts = JSON.parse(readFileSync(p, 'utf8')).scripts ?? {};
    const found = CANDIDATE_SCRIPTS.filter((s) => scripts[s]);
    return found.length ? found : null;
  } catch {
    return null;
  }
}

/**
 * 檢查跑失敗時要講什麼(誠實修補 E2)。純函式。
 * ⚠️ 「紅」有兩種:跑了沒過、根本沒跑起來。混在一起講成「沒過,修好再跑」,
 *    使用者會去修一個根本沒被檢查的東西——那是 R2 的鏡像。
 * @param fail {status, code, stderr, stdout}  runCheck() 失敗時回的東西
 */
function describeCheckFailure(script, fail) {
  const L = [];
  if (fail.code === 'ENOENT') {
    L.push(zhEn(`\n❌ ${script} 跑不起來：找不到 npm。這不是「沒過」,是根本沒跑。`, `\n❌ ${script} couldn't run: can't find npm. This isn't "failed"; it didn't run at all.`));
  } else if (fail.status === 127) {
    L.push(zhEn(`\n❌ ${script} 跑不起來：它要用的指令找不到（通常是工具沒裝,先 npm install）。這不是「沒過」,是根本沒跑。`,
      `\n❌ ${script} couldn't run: a command it needs can't be found (usually a tool isn't installed; run npm install first). This isn't "failed"; it didn't run at all.`));
  } else {
    L.push(zhEn(`\n❌ ${script} 跑了,沒過。不蓋章。`, `\n❌ ${script} ran and failed. No stamp.`));
  }
  // 檢查工具自己的輸出——那是 npm／測試工具說的話,不是程式內部值;使用者要拿它去問 Claude。只給最後幾行。
  const tail = (fail.stderr.trim() || fail.stdout.trim()).split('\n').filter(Boolean).slice(-6);
  if (tail.length) {
    L.push(zhEn('   它自己說的最後幾行（拿去問 Claude）：', '   The last few lines it printed itself (take them to Claude):'));
    for (const t of tail) L.push(`      │ ${t.slice(0, 160)}`);
  } else {
    L.push(zhEn('   （它什麼都沒說。）', '   (It didn\'t say anything.)'));
  }
  L.push(zhEn('   修好再跑一次。', '   Fix it and run again.'));
  return L;
}

/* ══════════════════════════ 蓋章：--checkpoint（AC-1） ══════════════════════════ */

/** 跑一項檢查。成功回 null;失敗回離開碼與輸出,讓 describeCheckFailure() 分辨「沒過」跟「沒跑起來」。 */
function runCheck(cwd, script) {
  try {
    execFileSync('npm', ['run', '--silent', script],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return null;
  } catch (e) {
    return {
      status: typeof e.status === 'number' ? e.status : null,
      code: e.code ?? null,
      stderr: String(e.stderr ?? ''),
      stdout: String(e.stdout ?? ''),
    };
  }
}

/**
 * 蓋章會結掉這一輪:結論會過期的關(D)的事還沒了結——分級要它卻還沒跑、叫了沒記結論、要不要再跑等你決定——就不蓋,
 * 蓋下去那一題就跟著這一輪不見(規格:主任動手收尾 AC-5)。回白板上那一件(stageItemOf,講同一句),沒卡住回 null。
 * ⚠️ 「找到問題、之後沒再改程式」不擋:收工 hook 對它說不用再要求(gate.mjs),而且它沒有出口——你說不用再跑,要之後改過程式才算數;
 *    擋了它,你決定那幾條不修,這一輪就永遠蓋不了章(魔鬼教官第一輪,老毛病 P2)。白板照舊把它列成還差的事。
 * 直接叫 --checkpoint 跟主任收尾的 --wrap stamp 都問這裡:只擋其中一條,Claude 照老習慣直接蓋章就繞過去了(老毛病 P6)。
 * 分級讀不到(不知道要不要 D)不擋,白板另外講「不知道該跑哪幾關」;資料夾讀不到也不擋,下面的步驟自己會講。
 */
async function rerunBlock(ctx, ev) {
  if (!ev) return null;
  const f = await rerunFacts(ctx, ev);
  if (!f) return null;
  const t = f.tier;
  // Claude 跑的時候分級那幾行已經照這個對話算好(lib/collect.mjs 的 sessionTier);你自己在終端機跑的那一條沒有,照同一個函式補算
  const lines = t?.state === 'ok' ? (t.lines ?? tierLines(t, { ago })) : null;
  // 每一關先照畫面那一套算好那一句(screenStages,白板拿的就是這一份)——沒算的那一份沒有那一句,會把 undefined 印給你(寫的時候踩到)
  for (const x of screenStages(f.view?.stages ?? [])) {
    if (!x.rerunAfterChange || x.type === 'browser' || x.rerun?.state === 'found') continue;
    const it = stageItemOf(x, { reqs: lines?.reqs ?? [], ago });
    if (it) return it;
  }
  return null;
}

/** 卡住的那兩行(--checkpoint 印的;主任收尾那一步另外講一行,lib/cliWrap.mjs)。關卡的名字照白板那一件自己帶的,不寫死代號 */
function rerunBlockLines(it) {
  return [zhEn(`⚠️ 不蓋章：還有一關的結論沒了結——${it.text}`, `⚠️ No stamp: a stage's conclusion isn't settled yet: ${it.text}`),
    zhEn('   蓋章會結掉這一輪，那一題就跟著不見。先照那一句了結它，再蓋。', '   Stamping ends this round, and that question would disappear with it. Settle it as that line says first, then stamp.')];
}

/** ⚠️ 這裡是整支程式最容易寫出假綠勾的地方。
 *  「檢查全綠」講的是**當下工作區**的狀態；章要蓋在**某個 commit** 上。
 *  工作區是髒的時候,這兩者不是同一份東西——蓋下去就是在說謊。
 *  ev:這個專案的紀錄(D 的事了結了沒要用);skipD:呼叫端剛問過 rerunBlock(主任收尾),不再問一次 */
async function doCheckpoint(ctx, ev = null, { skipD = false } = {}) {
  if (!ctx.hasCommits) {
    console.log(zhEn('這個專案還沒有任何 commit,沒有東西可以蓋章。先 git commit 一次。', 'This project has no commits yet, so there\'s nothing to stamp. Run git commit once first.'));
    return 1;
  }
  const dirty = uncommitted(ctx.root);
  if (dirty === null) {
    console.log(zhEn('⚠️ 問不到工作區狀態,為了不亂蓋章,這次不蓋。', '⚠️ Couldn\'t check the state of the working folder, so no stamp this time rather than stamping blindly.'));   // A1：沒問到 ≠ 乾淨
    return 1;
  }
  if (dirty > 0) {
    console.log(zhEn(`⚠️ 你有 ${dirty} 個檔案還沒 commit。`, `⚠️ You have ${plural(dirty, 'file')} not committed yet.`));
    console.log(zhEn('   檢查跑出來的綠是「你桌上這一份」的綠,不屬於任何一個存檔點——', '   Green checks now would be green for "the copy on your desk", which doesn\'t belong to any commit —'));
    console.log(zhEn('   現在蓋章等於把綠掛在一個沒被測過的版本上。', '   stamping now would hang the green on a version that was never tested.'));
    console.log(zhEn('\n   先存檔再蓋章：  git add -A && git commit -m "你的訊息"', '\n   Commit first, then stamp:  git add -A && git commit -m "your message"'));
    return 1;
  }
  // 沒存的先講(便宜、而且先存檔才談得上蓋);存好了才看還有沒有一關的結論沒了結
  const block = skipD ? null : await rerunBlock(ctx, ev);
  if (block) {
    for (const line of rerunBlockLines(block)) console.log(line);
    return 1;
  }

  const checks = detectChecks(ctx.root);
  if (!checks) {
    console.log(zhEn('認不出這個專案要跑哪些檢查（找不到 package.json 或裡面沒有 lint/test/build）。', 'Can\'t tell which checks this project runs (no package.json, or no lint/test/build in it).'));
    console.log(zhEn('⚠️ 這是「我沒問到」,不是「這個專案沒有檢查」。', '⚠️ This means "I couldn\'t find out", not "this project has no checks".'));
    return 1;
  }

  console.log(zhEn(`在 ${ctx.branch} 上跑 ${checks.length} 項檢查,全綠才蓋章：\n`, `Running ${plural(checks.length, 'check')} on ${ctx.branch}; stamping only if all are green:\n`));
  const passed = [];
  for (const s of checks) {
    process.stdout.write(`   ${s} … `);
    const fail = runCheck(ctx.root, s);
    if (!fail) { console.log(zhEn('綠', 'green')); passed.push(s); continue; }
    console.log(zhEn('紅', 'red'));
    // ⚠️ E2:「沒跑起來」跟「跑了沒過」要分開講,而且要把檢查自己說的話給出來
    for (const line of describeCheckFailure(s, fail)) console.log(line);
    return 1;
  }

  try {
    writeCheckpoint(CHECKPOINT_DIR, ctx, {
      commit: ctx.head, branch: ctx.branch, worktree: ctx.root,
      at: new Date().toISOString(), checks: passed,
    });
  } catch (e) {
    // ⚠️ AC-6：跟感測器相反,這裡不准安靜。
    console.log(zhEn(`\n❌ 章沒蓋成功：${e.message}`, `\n❌ The stamp didn't go through: ${e.message}`));
    console.log(zhEn('   ⚠️ 你**沒有**還原點。不要以為有。', '   ⚠️ You do **not** have a restore point. Don\'t assume you do.'));
    return 1;
  }
  console.log(zhEn(`\n🟢 蓋章完成：${ctx.head.slice(0, 7)}（${passed.join(' / ')} 全綠）`, `\n🟢 Stamped: ${ctx.head.slice(0, 7)} (${passed.join(' / ')} all green)`));
  return 0;
}

// 給 status.mjs 拿;detectChecks、describeCheckFailure 也給測試釘文案用。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  detectChecks, describeCheckFailure, doCheckpoint, rerunBlock,
};
