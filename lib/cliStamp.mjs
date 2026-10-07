/**
 * cliStamp.mjs —— 蓋章(--checkpoint):認這個專案有哪幾項檢查、一項一項跑、沒過時講清楚是「沒過」還是「沒跑起來」、全綠才寫章。
 * 規格:pipeline-status、誠實修補、終端機照指令拆開(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-07 從 status.mjs 原封不動搬過來。章住哪、怎麼寫在 lib/checkpoint.mjs(危險清單上);這裡只決定蓋不蓋、怎麼講。
 * 只從 cliFacts.mjs 拿東西。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { uncommitted } from './git.mjs';
import { writeCheckpoint } from './checkpoint.mjs';
import { CHECKPOINT_DIR } from './cliFacts.mjs';

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
    L.push(`\n❌ ${script} 跑不起來：找不到 npm。這不是「沒過」,是根本沒跑。`);
  } else if (fail.status === 127) {
    L.push(`\n❌ ${script} 跑不起來：它要用的指令找不到（通常是工具沒裝,先 npm install）。這不是「沒過」,是根本沒跑。`);
  } else {
    L.push(`\n❌ ${script} 跑了,沒過。不蓋章。`);
  }
  // 檢查工具自己的輸出——那是 npm／測試工具說的話,不是程式內部值;使用者要拿它去問 Claude。只給最後幾行。
  const tail = (fail.stderr.trim() || fail.stdout.trim()).split('\n').filter(Boolean).slice(-6);
  if (tail.length) {
    L.push('   它自己說的最後幾行（拿去問 Claude）：');
    for (const t of tail) L.push(`      │ ${t.slice(0, 160)}`);
  } else {
    L.push('   （它什麼都沒說。）');
  }
  L.push('   修好再跑一次。');
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

/** ⚠️ 這裡是整支程式最容易寫出假綠勾的地方。
 *  「檢查全綠」講的是**當下工作區**的狀態；章要蓋在**某個 commit** 上。
 *  工作區是髒的時候,這兩者不是同一份東西——蓋下去就是在說謊。 */
function doCheckpoint(ctx) {
  if (!ctx.hasCommits) {
    console.log('這個專案還沒有任何 commit,沒有東西可以蓋章。先 git commit 一次。');
    return 1;
  }
  const dirty = uncommitted(ctx.root);
  if (dirty === null) {
    console.log('⚠️ 問不到工作區狀態,為了不亂蓋章,這次不蓋。');   // A1：沒問到 ≠ 乾淨
    return 1;
  }
  if (dirty > 0) {
    console.log(`⚠️ 你有 ${dirty} 個檔案還沒 commit。`);
    console.log('   檢查跑出來的綠是「你桌上這一份」的綠,不屬於任何一個存檔點——');
    console.log('   現在蓋章等於把綠掛在一個沒被測過的版本上。');
    console.log('\n   先存檔再蓋章：  git add -A && git commit -m "你的訊息"');
    return 1;
  }

  const checks = detectChecks(ctx.root);
  if (!checks) {
    console.log('認不出這個專案要跑哪些檢查（找不到 package.json 或裡面沒有 lint/test/build）。');
    console.log('⚠️ 這是「我沒問到」,不是「這個專案沒有檢查」。');
    return 1;
  }

  console.log(`在 ${ctx.branch} 上跑 ${checks.length} 項檢查,全綠才蓋章：\n`);
  const passed = [];
  for (const s of checks) {
    process.stdout.write(`   ${s} … `);
    const fail = runCheck(ctx.root, s);
    if (!fail) { console.log('綠'); passed.push(s); continue; }
    console.log('紅');
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
    console.log(`\n❌ 章沒蓋成功：${e.message}`);
    console.log('   ⚠️ 你**沒有**還原點。不要以為有。');
    return 1;
  }
  console.log(`\n🟢 蓋章完成：${ctx.head.slice(0, 7)}（${passed.join(' / ')} 全綠）`);
  return 0;
}

// 給 status.mjs 拿;detectChecks、describeCheckFailure 也給測試釘文案用。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  detectChecks, describeCheckFailure, doCheckpoint,
};
