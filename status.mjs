#!/usr/bin/env node
/**
 * status.mjs —— 「我在哪、我回得去哪、這次動了多少」
 *
 * 規格：<專案>/docs/進行中/pipeline-status.md（AC 編號在下面各段落標出）
 *
 * 這支程式最重要的性質是**它不准說謊**。所以整份程式碼裡沒有任何一句
 * 「確定能動」「應該沒問題」「太多了」——只有數字、時間戳，以及查不到時的「不知道」。
 *
 * ⚠️ 三個最容易犯的錯，都寫成註解釘在對應的地方了：
 *   1. 查不到 ≠ 沒有（A1）——`git()` 回 null 代表「沒問到」，呼叫端不准折成 false
 *   2. 檢查全綠 ≠ 功能正確（A2, AC-5）——文案永遠寫「檢查全綠」不寫「能動」
 *   3. 自己編門檻會讓工具變成狼來了（AC-7）——比例尺一律從這個專案自己的歷史算
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { appendFileSync } from 'node:fs';
import { readEvents, loadStages, lastRunPerStage } from './lib/events.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKPOINT_DIR = join(HERE, 'checkpoints');
const LOG_DIR = join(HERE, 'logs');

/* ────────────────────────── git：查不到就回 null ──────────────────────────
 * ⚠️ A1。回 null 的唯一意思是「這次沒問到」，**不是**「答案是沒有」。
 * 呼叫端必須自己決定「沒問到」要怎麼講，不准預設折成 0／false／空陣列。 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** 這是不是一個 git 專案（AC-10：不是也不准當機） */
function gitContext(cwd) {
  const commonDir = git(['rev-parse', '--git-common-dir'], cwd);
  if (commonDir === null) return { isGit: false };

  // 專案身分用 --git-common-dir：worktree 會解析到主 repo 的 .git，
  // 所以三個 worktree 算同一個專案（它們本來就是）。
  const root = git(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
  // ⚠️ 一般 repo 的 --git-common-dir 回的是**相對路徑** '.git',只有 worktree 才回絕對路徑。
  // 直接拿去算 basename 會得到 '.'——實測踩到。統一解析成絕對路徑再算。
  const absCommon = commonDir.startsWith('/') ? commonDir : join(root, commonDir);
  const head = git(['rev-parse', 'HEAD'], cwd);          // null = 一個 commit 都還沒有
  // ⚠️ 一個 commit 都沒有時 `rev-parse --abbrev-ref HEAD` 會失敗 → 我們回 null,
  // 而 null 直接印到畫面上就是「━━ empty · null ━━」。實測踩到。
  // symbolic-ref 在零 commit 時仍答得出 HEAD 指向哪條分支,拿它當備援。
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    ?? git(['symbolic-ref', '--short', 'HEAD'], cwd)
    ?? '(還沒有分支)';
  return {
    isGit: true,
    root,
    project: basename(dirname(absCommon)) || basename(root),
    head,
    // detached HEAD 時 branch 會是 'HEAD'——那是狀態不是名字，照實說
    branch: branch === 'HEAD' ? '(detached HEAD)' : branch,
    hasCommits: head !== null,
  };
}

/* ────────────────────────── 章（AC-1 / AC-4 / AC-6） ────────────────────────── */

function checkpointPath(ctx) {
  const safe = `${ctx.project}__${ctx.branch}`.replace(/[^\w.-]+/g, '_');
  return join(CHECKPOINT_DIR, `${safe}.json`);
}

function readCheckpoint(ctx) {
  const p = checkpointPath(ctx);
  if (!existsSync(p)) return null;              // AC-4：不存在 = 還不知道，不是「沒綠過」
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** ⚠️ AC-6：這裡跟感測器**刻意相反**——寫不進去要大聲。
 *  「我以為我有退路，其實沒有」會在最需要的時候害到人。 */
function writeCheckpoint(ctx, data) {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  writeFileSync(checkpointPath(ctx), JSON.stringify(data, null, 2));
}

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

/* ────────────────────────── 改動體檢（AC-7 / AC-8） ────────────────────────── */

/** 這個專案「平常改幾個檔案」——比例尺從自己的歷史算，不自己編門檻（AC-7）。 */
function changeScale(cwd, sample = 30) {
  const out = git(['log', '-n', String(sample), '--format=%h', '--name-only'], cwd);
  if (out === null) return null;
  const counts = [];
  let n = 0;
  for (const line of out.split('\n')) {
    if (/^[0-9a-f]{7,}$/.test(line.trim())) { if (n) counts.push(n); n = 0; }
    else if (line.trim()) n++;
  }
  if (n) counts.push(n);
  // ⚠️ 兩三個 commit 算出來的「平常」是雜訊不是基準。
  // 寧可不給比例尺,也不要給一個看起來有依據的假數字（AC-7 的精神）。
  if (counts.length < 5) return null;
  counts.sort((a, b) => a - b);
  return { median: counts[Math.floor(counts.length / 2)], max: counts[counts.length - 1], sample: counts.length };
}

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./;

/** package.json 的相依名稱集合。讀不到就回空集合——呼叫端只拿它做「新增了什麼」的差集,
 *  讀不到時差集是空的,不會憑空報出新相依（A1:沒問到不要變成一個答案）。 */
function readDeps(text) {
  if (!text) return new Set();
  try {
    const j = JSON.parse(text);
    return new Set([...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}

function changeHealth(cwd, since) {
  const range = since ? [since] : [];
  const stat = git(['diff', '--shortstat', ...range], cwd);
  const names = git(['diff', '--name-only', ...range], cwd);
  // ⚠️ AC-8：只認「被修改」的既有測試（M），不認新增（A）。
  // 寫新功能順便補新測試是好事,天天為它跳警告會讓人關掉這個工具。
  const modifiedTests = git(['diff', '--diff-filter=M', '--name-only', ...range], cwd);
  // ⚠️ 不要用 diff 的 `+"lodash": "^4"` 去比對——那**假設 package.json 是一行一個相依**。
  // 壓成一行的 package.json 就完全認不到,而且是安靜地認不到。直接解析兩邊的鍵。
  // ⚠️ 這裡本來寫成 `since ? ... : depsNow`——沒有還原點的時候拿自己跟自己比,
  // 差集永遠是空的,**新增的相依一輩子不會被報出來**。測試抓到的。
  // 沒有還原點時,「改動」的基準是 HEAD(＝還沒 commit 的東西),不是工作區自己。
  const pkgPath = join(cwd, 'package.json');
  const depsNow = readDeps(existsSync(pkgPath) ? readFileSync(pkgPath, 'utf8') : null);
  const depsBefore = readDeps(git(['show', `${since ?? 'HEAD'}:package.json`], cwd));

  // ⚠️ `git diff` **看不到還沒被 git 追蹤的新檔案**。
  // AI 生成最常見的產物就是新檔案,漏掉它們會讓改動看起來比實際小——
  // 而「看起來比較安全」正是最危險的錯誤方向。實測抓到:4 個檔案被報成 2 個。
  const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd);
  const newFiles = untracked ? untracked.split('\n').filter(Boolean).length : 0;
  const files = (names ? names.split('\n').filter(Boolean).length : 0) + newFiles;
  const m = stat?.match(/(\d+) insertion.*?(\d+) deletion/) ?? stat?.match(/(\d+) insertion/) ?? null;
  return {
    files,
    newFiles,
    added: m ? Number(m[1]) : 0,
    removed: m && m[2] ? Number(m[2]) : 0,
    modifiedTests: modifiedTests ? modifiedTests.split('\n').filter((f) => f && TEST_FILE.test(f)) : [],
    // 只算新增的,移除不算債務
    newDeps: [...depsNow].filter((d) => !depsBefore.has(d)),
  };
}

/* ────────────────────────── 小工具 ────────────────────────── */

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '時間對不上';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小時前`;
  return `${Math.round(h / 24)} 天前`;
}

function uncommitted(cwd) {
  const out = git(['status', '--porcelain'], cwd);
  if (out === null) return null;                 // 沒問到
  return out.split('\n').filter(Boolean).length;
}

export { git, gitContext, changeScale, changeHealth, detectChecks, ago, TEST_FILE };

/* ══════════════════════════ 蓋章：--checkpoint（AC-1） ══════════════════════════ */

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
    try {
      execFileSync('npm', ['run', '--silent', s], { cwd: ctx.root, stdio: ['ignore', 'ignore', 'ignore'] });
      console.log('綠');
      passed.push(s);
    } catch {
      console.log('紅');
      console.log(`\n❌ ${s} 沒過,不蓋章。修好再跑一次。`);
      return 1;
    }
  }

  try {
    writeCheckpoint(ctx, {
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

/* ══════════════════════════ 畫面 ══════════════════════════ */

function render(ctx) {
  console.log(`━━ ${ctx.project} · ${ctx.branch} ━━\n`);

  const cp = readCheckpoint(ctx);
  const dirty = uncommitted(ctx.root);

  /* ── 還原點（AC-2 / AC-4 / AC-5） ── */
  if (!cp) {
    // AC-4：說「還不知道」,不說「你沒有能動的版本」
    console.log('🔍 還沒有還原點——這個工具還沒看過你跑檢查,所以**還不知道**哪個版本是綠的。');
    console.log('   （這不代表你沒有好版本,只代表我沒問到。）');
    console.log('\n   建立第一個：  pipeline-status --checkpoint');
    // AC-5 的「還沒進保險箱」跟有沒有章無關——沒章的時候一樣該講。
    if (dirty) console.log(`\n   ⚠️ 另外:你有 ${dirty} 個檔案還沒存進保險箱(git commit)。`);
  } else {
    // AC-5：永遠寫「檢查全綠」,永遠不寫「確定能動」
    console.log(`🟢 最後一次檢查全綠：${cp.commit.slice(0, 7)}（${ago(cp.at)}）`);
    console.log(`   通過的是：${cp.checks.join(' / ')}`);
    console.log('   ⚠️ 檢查全綠不等於功能正確——測試沒測到的地方它不知道。');

    // ⚠️ 又是它:`git diff` 看不到未追蹤的新檔案。
    // 這裡漏掉的話會印出「之後有 2 個檔案被改過 / 其中 3 個還沒存進保險箱」——
    // 3 大於 2,一眼就看得出是假的,而**一個算術對不起來的儀表板,你不會再信它第二次**。
    const changed = git(['diff', '--name-only', cp.commit], ctx.root);
    const untracked = git(['ls-files', '--others', '--exclude-standard'], ctx.root);
    const n = changed === null ? null
      : new Set([...changed.split('\n'), ...(untracked ?? '').split('\n')].filter(Boolean)).size;
    if (n === null) console.log('\n   ⚠️ 問不到「蓋章之後改了什麼」。');
    else if (n === 0) console.log('\n   ✅ 蓋章之後沒有任何檔案被改過。');
    else console.log(`\n   ⚠️ 之後有 ${n} 個檔案被改過,這 ${n} 個沒有被檢查過。`);

    if (dirty) console.log(`   ⚠️ 其中 ${dirty} 個還沒存進保險箱(git commit)。`);

    /* ── 怎麼回去（AC-3）：先講會失去什麼,再給指令 ── */
    if (n) {
      console.log('');
      if (dirty) {
        console.log(`   ⚠️ 回去會丟掉你還沒存的 ${dirty} 個檔案。想留著先打：`);
        console.log('        git stash push -u -m 我的備份');
        console.log('      確定要回去：');
      } else {
        console.log('      要回到那個版本：');
      }
      console.log(`        git reset --hard ${cp.commit.slice(0, 7)}`);
    }
  }

  /* ── 改動體檢（AC-7 / AC-8）：只報數字,不下判斷 ── */
  const since = cp?.commit;
  const h = changeHealth(ctx.root, since);
  const scale = changeScale(ctx.root);
  console.log(`\n━━ ${since ? '蓋章之後的改動' : '尚未提交的改動'} ━━`);
  if (!h.files) {
    console.log('   沒有改動。');
  } else {
    console.log(`   ${h.files} 個檔案${h.newFiles ? `(其中 ${h.newFiles} 個是新檔案)` : ''}`);
    // 新檔案還沒被 git 追蹤,算不出增減行數。照實說涵蓋範圍,不要給一個看起來完整的假總數。
    console.log(`   已存在的檔案:+${h.added} −${h.removed} 行`);
    // ⚠️ AC-7：比例尺來自這個專案自己的歷史。沒有「太多」這種話。
    if (scale) console.log(`   （這個專案平常 ${scale.median} 個檔案,最多到過 ${scale.max} 個）`);
    if (h.newDeps.length) {
      console.log(`   ⚠️ 新增相依 ${h.newDeps.length} 個：${h.newDeps.join(', ')}`);
      console.log('      （每一個都是以後都要跟著你的東西,裝的時候只花三秒。）');
    }
    if (h.modifiedTests.length) {
      console.log(`   ⚠️ 這次動到 ${h.modifiedTests.length} 個**既有**的測試檔：`);
      for (const f of h.modifiedTests.slice(0, 5)) console.log(`        ${f}`);
      console.log('      （新增測試不會列在這裡。既有測試被改,值得你確認一下是不是');
      console.log('        程式沒過測試、於是測試被改成配合程式。）');
    }
  }
  return 0;
}

/* ══════════════════════════ 關卡（需要感測器） ══════════════════════════ */

function renderStages(ctx) {
  const { stages } = loadStages(HERE, ctx.root);
  if (!stages.length) return;

  const { state, events, broken } = readEvents(LOG_DIR, ctx.project);
  console.log('\n━━ 五關 ━━');

  // ⚠️ AC-1／AC-7:三種「看起來一樣」的情況必須分開講。
  if (state === 'no-file') {
    console.log('   🔍 這個專案還沒有任何感測器紀錄。');
    console.log('      可能是還沒裝感測器,也可能是裝了還沒跑過任何指令——**這兩種我分不出來**,');
    console.log('      所以不會說「五關都沒跑」。');
    return;
  }
  if (state === 'no-events' || broken.length) {
    console.log('   ⚠️ 感測器可能沒在運作:紀錄檔存在,但裡面沒有東西。');
    if (broken.length) console.log(`      感測器自己回報過 ${broken.length} 次故障。`);
    console.log('      ⚠️ 這**不是**「五關都沒跑」——是我沒問到。');
    return;
  }

  const { perStage, sawAnyEventHere } = lastRunPerStage(events, stages, ctx.root);
  // ⚠️ 感測器**有一個開始的日期**。在那之前跑過的事情它一輩子都不會知道。
  // 把那段期間講成「沒跑過」就是 A1:把「沒問到」編碼成「答案是沒有」。
  // 實測就是這樣抓到的:/spec 今天稍早真的跑過,但感測器是之後才裝的,
  // 畫面卻理直氣壯寫著「A 沒跑過」。
  const firstTs = events.filter((e) => e.cwd === ctx.root).map((e) => e.ts).sort()[0];
  if (!sawAnyEventHere) {
    console.log('   🔍 有紀錄,但沒有一筆來自這個 worktree。');
    console.log(`      （目前在 ${ctx.branch}）`);
    return;
  }

  // 人蓋的「結案」事件(AC-9)。source:'human' 是刻意標的——
  // 它跟感測器觀察到的事實不同級,永遠不要混在一起。
  const cleared = new Map();
  for (const e of events) {
    if (e.event === 'stage_cleared' && e.cwd === ctx.root) cleared.set(e.stage, e);
  }

  let anyOpen = false;
  for (const st of stages) {
    const label = `${st.id} ${st.name}`.padEnd(10, '　');
    if (st.type === 'main-conversation') { console.log(`   ${label} ●  就是你在講話的那個對話`); continue; }
    if (st.type === 'not-built')        { console.log(`   ${label} ⚫ 未建`); continue; }

    const run = perStage.get(st.id);
    if (!run) { console.log(`   ${label} ⚪ 沒有紀錄`); continue; }

    const clear = cleared.get(st.id);
    const closed = clear && new Date(clear.ts) >= new Date(run.ts);
    // AC-9:沒有結案的,時間越久要越顯眼——所以天數一定印出來,而且用 ⏸ 不用 ✅
    console.log(`   ${label} ${closed ? '✅' : '⏸'} ${ago(run.ts)}跑過`
      + (closed ? `,${ago(clear.ts)}你說處理完了` : ',還沒有人說處理完了'));
    if (run.args) console.log(`              「${run.args.slice(0, 46)}${run.args.length > 46 ? '…' : ''}」`);
    if (!closed) anyOpen = true;
  }

  if (firstTs) {
    console.log(`\n   ⚠️ 「沒有紀錄」不等於「沒跑過」——感測器從 ${ago(firstTs)}才開始記,`);
    console.log('      在那之前發生的事情它一輩子都不會知道。');
  }
  console.log('\n   ⚠️ 上面寫的是「跑過」,不是「通過」——感測器只看得到指令被呼叫,');
  console.log('      看不到結果。驗屋師傅來過,不等於房子修好了。');
  if (anyOpen) console.log('   處理完了要留紀錄：  pipeline-status --clear <關卡代號>   例如 --clear D');
}

/** 人蓋的結案章(AC-9)。⚠️ 寫進同一份 append-only 紀錄,但標明 source:'human'。 */
function doClear(ctx, stageId) {
  const { stages } = loadStages(HERE, ctx.root);
  const st = stages.find((x) => x.id.toLowerCase() === String(stageId).toLowerCase());
  if (!st) {
    console.log(`認不出關卡「${stageId}」。這個專案的關卡是：${stages.map((x) => x.id).join(' / ')}`);
    return 1;
  }
  try {
    appendFileSync(join(LOG_DIR, `${ctx.project}.jsonl`), JSON.stringify({
      ts: new Date().toISOString(), event: 'stage_cleared', stage: st.id,
      cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'human',
    }) + '\n');
  } catch (e) {
    console.log(`❌ 沒記成功：${e.message}`);
    return 1;
  }
  console.log(`✅ 記下了：你說 ${st.id} ${st.name} 處理完了（${ctx.head?.slice(0, 7)}）`);
  console.log('   ⚠️ 這是「你說的」,不是系統驗證的——畫面上會照實這樣寫。');
  return 0;
}

/* ══════════════════════════ main ══════════════════════════ */

function main() {
  const cwd = process.cwd();
  const ctx = gitContext(cwd);
  if (!ctx.isGit) {                             // AC-10
    console.log('這裡看起來不是一個 git 專案,所以沒有版本可以參照。');
    console.log(`（目前位置：${cwd}）`);
    return 0;
  }
  if (!ctx.hasCommits && !process.argv.includes('--checkpoint')) {
    console.log(`━━ ${ctx.project} · ${ctx.branch} ━━\n`);
    console.log('這個專案還沒有任何 commit,所以還沒有版本可以回去。');
    return 0;
  }
  const clearAt = process.argv.indexOf('--clear');
  if (clearAt !== -1) return doClear(ctx, process.argv[clearAt + 1]);
  if (process.argv.includes('--checkpoint')) return doCheckpoint(ctx);
  const code = render(ctx);
  renderStages(ctx);
  return code;
}

// ⚠️ 不要寫成 `import.meta.url === \`file://${process.argv[1]}\``——
// import.meta.url 是百分號編碼的（路徑裡的空白會變 %20）,而 argv[1] 不是。
// 使用者的路徑只要有一個空白,這個判斷就永遠 false,而程式**安靜地什麼都不做**。
// 實測就是這樣:「TutorPod AI」有空白,第一次執行零輸出零錯誤。
// 這正是本專案 R1 在講的形狀——沒壞掉的樣子,但什麼都沒發生。
if (fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
