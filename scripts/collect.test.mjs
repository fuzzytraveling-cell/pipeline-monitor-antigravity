/**
 * collect.test.mjs —— 網頁那一層跟終端機版要說同一句話
 *
 * ⚠️ 只釘會安靜說謊的兩條:
 *    章失效時不准當成能用(L14)——網頁的「複製回去的指令」是整個產品最危險的按鈕;
 *    add 過的改動不准消失(老毛病 P1)。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { collectAll, ladderSteps } from '../lib/collect.mjs';
import { monitorHome } from '../lib/paths.mjs';
import { readAppTitles, deletedAt, transcriptDirName } from '../lib/appSessions.mjs';
import { safeName } from '../lib/events.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 造一個只有一個章的假 monitor 資料夾,章指向 repo 的某個 commit */
function monitorWith(root, commit) {
  const dir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(dir, 'checkpoints'));
  writeFileSync(join(dir, 'checkpoints', `${basename(root)}__main.json`), JSON.stringify({
    commit, branch: 'main', worktree: root, at: new Date().toISOString(), checks: ['test'],
  }));
  return dir;
}
const out = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

section('L14：網頁的還原點卡也要知道章失效了');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  const c1 = out(r.dir, 'rev-parse', 'HEAD');
  r.git('commit', '--amend', '-qm', 'rewritten');           // 歷史改寫:c1 還在倉庫裡,但不在分支上
  writeFileSync(join(r.dir, 'a.js'), '1\n2\n'); r.git('add', 'a.js');   // add 過的改動

  const monitorDir = monitorWith(root, c1);
  const card = collectAll({ monitorDir }).projects[0]?.cards?.[0];
  check('有這張卡', !!card);
  eq('章的關係是 off-branch(不是 ok)', card?.checkpointRelation?.state, 'off-branch');
  eq('章不能用 → 沒有備份分支名(沒有指令可以附)', card?.backupBranch, null);
  eq('add 過的改動有算進去(不是「沒有改動」)', card?.files?.total, 1);
  eq('「還沒存進保險箱」也是 1 個——兩個數字要一樣', card?.dirty, 1);
  rmSync(monitorDir, { recursive: true, force: true }); r.cleanup();
}

section('未檢查清單:每個檔案標清楚「還沒存」,蓋章之後 commit 過的不准被讀成沒 commit');
{
  const r = makeRepo({ files: { 'a.js': '1\n', 'b.js': '1\n' } });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  const c1 = out(r.dir, 'rev-parse', 'HEAD');
  writeFileSync(join(r.dir, 'a.js'), '2\n'); r.git('add', '-A'); r.git('commit', '-qm', '蓋章之後存的');   // a.js:改過、已存
  writeFileSync(join(r.dir, 'b.js'), '2\n');                                                          // b.js:改過、還沒存
  const monitorDir = monitorWith(root, c1);
  const files = collectAll({ monitorDir }).projects[0]?.cards?.[0]?.files;
  const items = Object.fromEntries(files.groups.flatMap((g) => g.items).map((it) => [it.name, it]));
  eq('兩個都算改過', files.total, 2);
  eq('其中 1 個還沒存', files.uncommittedCount, 1);
  check('a.js 已存、b.js 還沒存,各自標對', items['a.js'].uncommitted === false && items['b.js'].uncommitted === true, JSON.stringify(items));
  rmSync(monitorDir, { recursive: true, force: true }); r.cleanup();
}

section('L14：章之後有存檔 → 卡片帶備份分支名');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  const c1 = out(r.dir, 'rev-parse', 'HEAD');
  writeFileSync(join(r.dir, 'b.js'), '2\n'); r.git('add', '-A'); r.git('commit', '-qm', 'c2');

  const monitorDir = monitorWith(root, c1);
  const card = collectAll({ monitorDir }).projects[0]?.cards?.[0];
  eq('關係 ok,之後 1 次存檔', card?.checkpointRelation?.commitsAfter, 1);
  check('備份分支名以「備份-」開頭', typeof card?.backupBranch === 'string' && card.backupBranch.startsWith('備份-'),
        String(card?.backupBranch));
  rmSync(monitorDir, { recursive: true, force: true }); r.cleanup();
}

section('F：三階梯不准把「沒有東西要做」畫成「做完了」,也不准反過來', 'P5');
{
  // 2026-09-11 Oscar:新開的分支一個字都沒改,三階梯亮了兩格。燈亮=「有東西,而且走到這一步」,空的分支一格都不該亮。
  const L = (o) => ({ uncommitted: 0, unmerged: 0, onMain: false, mainName: 'main', mainHasUpstream: false, mainUnpushed: null, ...o });
  const fresh = ladderSteps(L({}));
  check('空的分支:沒有任何一格是 done', fresh.every((s) => s.state !== 'done'), JSON.stringify(fresh));
  check('merge 那格照實說「分不出來」', fresh[1].text.includes('分不出來'), fresh[1].text);
  const worked = ladderSteps(L({ unmerged: 2 }));
  eq('存了 2 次、工作區乾淨 → commit 是 done', worked[0].state, 'done');
  eq('還沒併 → merge 是 pending', worked[1].state, 'pending');
  // push 一律看 main(Oscar 2026-09-15:分支在本機併進 main、只推 main):分支的卡上也要看得到 main 有東西沒推
  eq('main 沒連到 GitHub → push 是 none(沒地方可推,不是問不到)', worked[2].state, 'none');
  const behind = ladderSteps(L({ mainHasUpstream: true, mainUnpushed: 4 }));
  check('main 有 4 個沒推 → 分支的卡也說 main 可以 push', behind[2].state === 'pending' && behind[2].text.includes('main') && behind[2].text.includes('4'), behind[2].text);
  eq('main 問不到 → unknown', ladderSteps(L({ mainHasUpstream: true, mainUnpushed: null }))[2].state, 'unknown');
  eq('有 3 個沒存 → commit 是 pending', ladderSteps(L({ uncommitted: 3 }))[0].state, 'pending');
  const merged = ladderSteps(L({ atMainTip: false }));
  eq('差 0 個但 main 往前走了 → 早就併進去了(done)', merged[1].state, 'done');
  // 2026-09-15 Oscar:「為什麼 merge 沒亮?」——快轉合併之後分支尖端=main 尖端,跟空分支長得一樣。證據在 reflog,不在 ref
  const tip = ladderSteps(L({ atMainTip: true }));
  check('差 0 個、就是 main 的尖端、沒有別的證據 → 照實說分不出來(none)', tip[1].state === 'none' && tip[1].text.includes('分不出來'), tip[1].text);
  const empty = ladderSteps(L({ atMainTip: true, branchMoved: false }));
  check('分支自己的紀錄只有「開出來」那筆 → 空的分支(none),不說分不出來', empty[1].state === 'none' && empty[1].text.includes('空') && !empty[1].text.includes('分不出來'), empty[1].text);
  const ff = ladderSteps(L({ atMainTip: true, mergedIntoMain: true, branchMoved: true }));
  check('main 的紀錄有「merge 這條分支」→ 併進去了(done),而且說是快轉', ff[1].state === 'done' && ff[1].text.includes('快轉'), ff[1].text);
  const emptyBehind = ladderSteps(L({ atMainTip: false, branchMoved: false }));
  eq('空的分支、main 自己往前走了 → 還是 none,不是 done', emptyBehind[1].state, 'none');
  const main = ladderSteps(L({ onMain: true, mainHasUpstream: true, mainUnpushed: 0 }));
  eq('在 main 上、乾淨 → commit done', main[0].state, 'done');
  eq('在 main 上 → merge 不適用(none),不是 done', main[1].state, 'none');
  eq('GitHub 一樣 → push done', main[2].state, 'done');
  const unknown = ladderSteps(L({ uncommitted: null, unmerged: null, mainName: null }));
  check('問不到 → unknown,不是 done 也不是 none', unknown[0].state === 'unknown' && unknown[1].state === 'unknown',
        JSON.stringify(unknown));

  // 真的 git:從主線開一條新分支、什麼都不做 → 卡片上的三格一格都不亮
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const base = out(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD');   // main 或 master,看這台機器的 git 設定
  r.git('checkout', '-q', '-b', 'feature');
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  const monitorDir = monitorWith(root, out(r.dir, 'rev-parse', 'HEAD'));   // 章在 HEAD,只是讓卡片出現
  const steps = collectAll({ monitorDir }).projects[0]?.cards?.[0]?.ladder?.steps;
  check('真的空分支:三格沒有 done', Array.isArray(steps) && steps.length === 3 && steps.every((s) => s.state !== 'done'),
        JSON.stringify(steps));
  check('真的空分支:merge 那格說它是空的,不說分不出來', !!steps?.[1]?.text.includes('空') && !steps?.[1]?.text.includes('分不出來'), steps?.[1]?.text);
  // 真的 git:分支存了一筆、快轉併進 main、回到分支 → 尖端跟 main 一樣,但 merge 那格要亮「併進去了」
  writeFileSync(join(r.dir, 'b.js'), '2\n'); r.git('add', '-A'); r.git('commit', '-qm', 'work');
  r.git('checkout', '-q', base); r.git('merge', '-q', '--ff-only', 'feature'); r.git('checkout', '-q', 'feature');
  const monitorDir2 = monitorWith(root, out(r.dir, 'rev-parse', 'HEAD'));
  const ffSteps = collectAll({ monitorDir: monitorDir2 }).projects[0]?.cards?.[0]?.ladder?.steps;
  check('真的快轉合併:merge 那格是 done,而且說是快轉', ffSteps?.[1]?.state === 'done' && ffSteps?.[1]?.text.includes('快轉'), JSON.stringify(ffSteps?.[1]));
  rmSync(monitorDir, { recursive: true, force: true }); rmSync(monitorDir2, { recursive: true, force: true }); r.cleanup();
}

section('C3：中文名的專案在網頁上要找得到,而且顯示真的名字', 'P2');
{
  // safeName 之後全是底線 → 以前被「跳過 _ 開頭」那條規則整個吃掉;顯示也要用真的資料夾名,不是檔名
  const parent = mkdtempSync(join(tmpdir(), 'pm-c3-'));
  const name = '示範 專案';
  const dir = join(parent, name);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  const root = out(dir, 'rev-parse', '--show-toplevel');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'logs'));
  writeFileSync(join(monitorDir, 'logs', `${safeName(name)}.jsonl`),
    JSON.stringify({ ts: new Date().toISOString(), hook: 'UserPromptSubmit', session: 's1', cwd: root, prompt: 'hi' }) + '\n');
  const all = collectAll({ monitorDir }).projects;
  const p = all.find((x) => x.name === safeName(name));
  check('案件有出現(不是被 _ 開頭的規則吃掉)', !!p, JSON.stringify(all.map((x) => x.name)));
  eq('顯示的是真的資料夾名', p?.displayName, name);
  eq('對話掛在它的卡上', p?.sessions?.[0]?.card?.path, root);
  rmSync(monitorDir, { recursive: true, force: true }); rmSync(parent, { recursive: true, force: true });
}

section('L17：程式從 worktree 跑,資料還是主資料夾的那一份', 'P3');
{
  // 2026-09-15:app 把儀表板重開在 worktree 裡,畫面說「還沒有任何案件」——資料都在主資料夾。
  const repo = makeRepo({ files: { 'a.js': '1\n' } });          // 假裝這是 pipeline-monitor 自己的 repo
  const main = out(repo.dir, 'rev-parse', '--show-toplevel');
  const wtParent = mkdtempSync(join(tmpdir(), 'pm-wt-'));
  const wt = join(wtParent, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'side'], { cwd: repo.dir, stdio: 'ignore' });
  eq('主資料夾的 home 是自己', monitorHome(main), main);
  eq('worktree 的 home 是主資料夾', monitorHome(wt), main);
  const plain = mkdtempSync(join(tmpdir(), 'pm-plain-'));
  eq('不在 git 裡的資料夾 → 自己', monitorHome(plain), plain);

  // 主資料夾放一份章,從 worktree 跑 collectAll 也要看得到
  const target = makeRepo({ files: { 'b.js': '1\n' } });
  const troot = out(target.dir, 'rev-parse', '--show-toplevel');
  mkdirSync(join(main, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(wt, 'stages.json'));
  writeFileSync(join(main, 'checkpoints', `${basename(troot)}__main.json`), JSON.stringify({
    commit: out(target.dir, 'rev-parse', 'HEAD'), branch: 'main', worktree: troot, at: new Date().toISOString(), checks: ['test'],
  }));
  const seen = collectAll({ monitorDir: wt }).projects.map((p) => p.name);
  check('從 worktree 跑,看得到主資料夾的案件', seen.includes(basename(troot)), JSON.stringify(seen));
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo.dir, stdio: 'ignore' });
  for (const d of [wtParent, plain]) rmSync(d, { recursive: true, force: true });
  repo.cleanup(); target.cleanup();
}

section('對話標題從 app 的索引來;在 app 裡刪掉的對話不准畫成「進行中」');
{
  // 假的 app 索引:<a>/<b>/local_*.json,只認 title + cliSessionId;壞檔跳過;沒有 title 的不算
  const idx = mkdtempSync(join(tmpdir(), 'pm-appidx-'));
  mkdirSync(join(idx, 'w1', 's1'), { recursive: true });
  writeFileSync(join(idx, 'w1', 's1', 'local_a.json'), JSON.stringify({ cliSessionId: 'sess-1', title: '履歷轉換系統重構', model: 'x', permissionMode: 'y' }));
  writeFileSync(join(idx, 'w1', 's1', 'local_b.json'), '{ 壞掉的');
  writeFileSync(join(idx, 'w1', 's1', 'local_c.json'), JSON.stringify({ cliSessionId: 'sess-3', title: '   ' }));
  const titles = readAppTitles(idx);
  eq('讀到標題', titles.get('sess-1'), '履歷轉換系統重構');
  eq('壞檔跳過、空標題不算 → 只有 1 筆', titles.size, 1);
  eq('索引資料夾不存在 → 空的,不當機', readAppTitles(join(idx, '沒有')).size, 0);

  eq('轉錄資料夾命名:非英數全換成 -', transcriptDirName('/Users/x/Desktop/Forma Pro/.claude'), '-Users-x-Desktop-Forma-Pro--claude');
  const tr = mkdtempSync(join(tmpdir(), 'pm-tr-'));
  const cwd = '/Users/x/Desktop/Forma Pro';
  mkdirSync(join(tr, transcriptDirName(cwd)));
  writeFileSync(join(tr, transcriptDirName(cwd), 'sess-1.desktop-released.json'), JSON.stringify({ v: 1, releasedAt: '2026-09-15T01:34:40Z', reason: 'delete' }));
  writeFileSync(join(tr, transcriptDirName(cwd), 'sess-2.desktop-released.json'), JSON.stringify({ v: 1, releasedAt: '2026-09-15T01:34:40Z', reason: 'other' }));
  eq('reason=delete → 刪除時間', deletedAt('sess-1', cwd, tr), '2026-09-15T01:34:40Z');
  eq('別的 reason → null', deletedAt('sess-2', cwd, tr), null);
  eq('沒有檔 → null', deletedAt('sess-9', cwd, tr), null);

  // 整條走一次:紀錄裡兩個對話,一個在 app 裡刪了 → 標題對上、刪掉的算結案且標 deletedAt
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'logs'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const ts = new Date().toISOString();
  writeFileSync(join(monitorDir, 'logs', `${basename(root)}.jsonl`), [
    JSON.stringify({ ts, hook: 'UserPromptSubmit', session: 'sess-1', cwd: root, prompt: 'hi' }),
    JSON.stringify({ ts, hook: 'UserPromptSubmit', session: 'sess-2', cwd: root, prompt: 'yo', title: '感測器記的' }),
  ].join('\n') + '\n');
  mkdirSync(join(tr, transcriptDirName(root)), { recursive: true });
  writeFileSync(join(tr, transcriptDirName(root), 'sess-1.desktop-released.json'), JSON.stringify({ releasedAt: ts, reason: 'delete' }));
  const p = collectAll({ monitorDir, appTitles: titles, transcriptsDir: tr }).projects[0];
  const s1 = p.sessions.find((s) => s.id === 'sess-1'), s2 = p.sessions.find((s) => s.id === 'sess-2');
  eq('app 的標題接上了', s1?.title, '履歷轉換系統重構');
  eq('app 沒有的退回感測器記的', s2?.title, '感測器記的');
  check('在 app 裡刪掉的 → 算結案,而且標明 deletedAt', !!s1?.closedAt && s1?.deletedAt === ts, JSON.stringify(s1));
  check('沒刪的還是進行中', !s2?.closedAt);
  for (const d of [idx, tr, monitorDir]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('這一輪跑到哪:最近一次第一關或蓋章是分界;現在這一關亮、走過的劃掉、上一輪只講一句;找不到指令要分開講');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(root, '.claude', 'commands', 'spec.md'), '# /spec\n');   // 這個專案有 /spec,沒有 /cleanup、/chaos-check
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'checkpoints')); mkdirSync(join(monitorDir, 'logs'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));   // 空的假 home:這台機器的 plugin 不能影響結果
  const T = (h) => new Date(Date.UTC(2026, 8, 15, h)).toISOString();
  const ev = (h, o) => JSON.stringify({ ts: T(h), hook: 'PreToolUse', tool: 'Skill', session: 's1', cwd: root, ...o });
  const log = join(monitorDir, 'logs', `${basename(root)}.jsonl`);
  const byId = (arr) => Object.fromEntries(arr.map((s) => [s.id, s]));

  // 第一輪:A(1 時)→ D(2 時)→ E 瀏覽器(3 時,兩個動作)。E 是現在這一關,A、D 已走過
  writeFileSync(log, [
    ev(1, { skill: 'spec' }), ev(2, { skill: 'chaos-check' }),
    ev(3, { tool: 'mcp__Claude_Browser__navigate' }), ev(3, { tool: 'mcp__Claude_Browser__computer' }),
    JSON.stringify({ ts: T(3), hook: 'UserPromptSubmit', session: 's1', cwd: root, prompt: 'hi' }),
  ].join('\n') + '\n');
  let p = collectAll({ monitorDir, skillHome: home }).projects[0];
  let cs = byId(p.cards[0].stages), ss = byId(p.sessions[0].stages);
  eq('開過瀏覽器 → E 只是 seen(不亮、不算走到)', cs.E.state, 'seen');
  eq('D 是現在這一關', cs.D.state, 'current');
  eq('A 已走過', cs.A.state, 'passed');
  eq('C 這一輪沒跑', cs.C.state, 'none');
  eq('E 兩個動作', cs.E.count, 2);
  eq('對話層一樣:E seen', ss.E.state, 'seen');
  eq('這個專案有 /spec → available true', cs.A.available, true);
  eq('沒有 /cleanup → available false(找不到)', cs.C.available, false);
  eq('B(對話本身)沒有指令 → null(不適用)', cs.B.available, null);

  // 第二輪:A 又被叫(5 時)→ 新的一輪從頭開始:A 現在、D/E 變成「這一輪還沒跑(上一輪跑過)」,不畫線
  writeFileSync(log, readFileSync(log, 'utf8') + ev(5, { skill: 'spec', args: '第二個功能' }) + '\n');
  p = collectAll({ monitorDir, skillHome: home }).projects[0];
  cs = byId(p.cards[0].stages); ss = byId(p.sessions[0].stages);
  eq('新的一輪:A 現在', cs.A.state, 'current');
  eq('D 回到沒跑', cs.D.state, 'none');
  eq('但記得上一輪 D 跑過的時間', cs.D.prevRanAt, T(2));
  eq('E 回到沒跑', cs.E.state, 'none');
  eq('對話層也從頭', ss.E.state, 'none');
  eq('列表上「這一輪走到」= A', p.sessions[0].stages.find((x) => x.state === 'current')?.id, 'A');

  // 蓋章也是分界:章在 6 時,A(5 時)在章之前 → 這一輪空的;D 在 7 時跑 → 現在這一關
  writeFileSync(join(monitorDir, 'checkpoints', `${basename(root)}__main.json`), JSON.stringify({
    commit: out(r.dir, 'rev-parse', 'HEAD'), branch: 'main', worktree: root, at: T(6), checks: ['test'],
  }));
  writeFileSync(log, readFileSync(log, 'utf8') + ev(7, { skill: 'chaos-check' }) + '\n');
  p = collectAll({ monitorDir, skillHome: home }).projects[0];
  cs = byId(p.cards[0].stages);
  eq('蓋章之後:A(章之前)這一輪沒跑', cs.A.state, 'none');
  eq('蓋章之後:D(章之後)現在', cs.D.state, 'current');
  for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

process.exit(summary());
