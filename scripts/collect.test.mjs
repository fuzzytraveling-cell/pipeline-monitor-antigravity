/**
 * collect.test.mjs —— 網頁那一層跟終端機版要說同一句話
 *
 * ⚠️ 只釘會安靜說謊的兩條:
 *    章失效時不准當成能用(L14)——網頁的「複製回去的指令」是整個產品最危險的按鈕;
 *    add 過的改動不准消失(老毛病 P1)。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import process from 'node:process';
import { collectAll } from '../lib/collect.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

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

process.exit(summary());
