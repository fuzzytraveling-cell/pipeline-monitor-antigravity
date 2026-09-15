/**
 * collect.test.mjs —— 網頁那一層跟終端機版要說同一句話
 *
 * ⚠️ 只釘會安靜說謊的兩條:
 *    章失效時不准當成能用(L14)——網頁的「複製回去的指令」是整個產品最危險的按鈕;
 *    add 過的改動不准消失(老毛病 P1)。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
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

section('F：三階梯不准把「沒有東西要做」畫成「做完了」');
{
  // 2026-09-11 Oscar:新開的分支一個字都沒改,三階梯亮了兩格。燈亮=「有東西,而且走到這一步」,空的分支一格都不該亮。
  const L = (o) => ({ uncommitted: 0, unmerged: 0, onMain: false, mainName: 'main', hasUpstream: false, unpushed: null, ...o });
  const fresh = ladderSteps(L({}));
  check('空的分支:沒有任何一格是 done', fresh.every((s) => s.state !== 'done'), JSON.stringify(fresh));
  check('merge 那格照實說「分不出來」', fresh[1].text.includes('分不出來'), fresh[1].text);
  const worked = ladderSteps(L({ unmerged: 2 }));
  eq('存了 2 次、工作區乾淨 → commit 是 done', worked[0].state, 'done');
  eq('還沒併 → merge 是 pending', worked[1].state, 'pending');
  eq('有東西、沒 push → push 是 pending', worked[2].state, 'pending');
  eq('有 3 個沒存 → commit 是 pending', ladderSteps(L({ uncommitted: 3 }))[0].state, 'pending');
  const main = ladderSteps(L({ onMain: true, hasUpstream: true, unpushed: 0 }));
  eq('在 main 上、乾淨 → commit done', main[0].state, 'done');
  eq('在 main 上 → merge 不適用(none),不是 done', main[1].state, 'none');
  eq('GitHub 一樣 → push done', main[2].state, 'done');
  const unknown = ladderSteps(L({ uncommitted: null, unmerged: null, mainName: null }));
  check('問不到 → unknown,不是 done 也不是 none', unknown[0].state === 'unknown' && unknown[1].state === 'unknown',
        JSON.stringify(unknown));

  // 真的 git:從主線開一條新分支、什麼都不做 → 卡片上的三格一格都不亮
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  r.git('checkout', '-q', '-b', 'feature');
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  const monitorDir = monitorWith(root, out(r.dir, 'rev-parse', 'HEAD'));   // 章在 HEAD,只是讓卡片出現
  const steps = collectAll({ monitorDir }).projects[0]?.cards?.[0]?.ladder?.steps;
  check('真的空分支:三格沒有 done', Array.isArray(steps) && steps.length === 3 && steps.every((s) => s.state !== 'done'),
        JSON.stringify(steps));
  rmSync(monitorDir, { recursive: true, force: true }); r.cleanup();
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

section('上一輪(蓋章前)的紀錄要劃掉;「沒有紀錄」跟「這裡沒有這個指令」要分開講');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(root, '.claude', 'commands', 'spec.md'), '# /spec\n');   // 這個專案有 /spec,沒有 /cleanup、/chaos-check
  const cpAt = new Date('2026-09-15T02:00:00Z');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'checkpoints')); mkdirSync(join(monitorDir, 'logs'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  writeFileSync(join(monitorDir, 'checkpoints', `${basename(root)}__main.json`), JSON.stringify({
    commit: out(r.dir, 'rev-parse', 'HEAD'), branch: 'main', worktree: root, at: cpAt.toISOString(), checks: ['test'],
  }));
  const before = new Date(cpAt.getTime() - 3600_000).toISOString(), after = new Date(cpAt.getTime() + 3600_000).toISOString();
  writeFileSync(join(monitorDir, 'logs', `${basename(root)}.jsonl`), [
    JSON.stringify({ ts: before, hook: 'PreToolUse', tool: 'Skill', skill: 'spec', session: 's1', cwd: root }),
    JSON.stringify({ ts: after, hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check', session: 's1', cwd: root }),
    JSON.stringify({ ts: after, hook: 'UserPromptSubmit', session: 's1', cwd: root, prompt: 'hi' }),
  ].join('\n') + '\n');
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));   // 空的假 home:這台機器的 plugin 不能影響結果
  const p = collectAll({ monitorDir, skillHome: home }).projects[0];
  const card = p.cards[0], byId = (arr) => Object.fromEntries(arr.map((s) => [s.id, s]));
  const cs = byId(card.stages), ss = byId(p.sessions[0].stages);
  eq('A 在蓋章前跑 → 上一輪(archivedAt = 蓋章時間)', cs.A.archivedAt, cpAt.toISOString());
  eq('D 在蓋章後跑 → 這一輪(沒有 archivedAt)', cs.D.archivedAt, null);
  eq('對話層也一樣:A 上一輪', ss.A.archivedAt, cpAt.toISOString());
  eq('對話層 D 這一輪', ss.D.archivedAt, null);
  eq('這個專案有 /spec → available true', cs.A.available, true);
  eq('沒有 /cleanup → available false(找不到)', cs.C.available, false);
  eq('B(對話本身)沒有指令 → null(不適用)', cs.B.available, null);
  eq('對話層帶著 skill 名,畫面才講得出「找不到 /cleanup」', ss.C.skill, 'cleanup');
  for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

process.exit(summary());
