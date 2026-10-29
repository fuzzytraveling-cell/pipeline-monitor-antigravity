/**
 * collect.test.mjs —— 網頁那一層跟終端機版要說同一句話
 *
 * ⚠️ 只釘會安靜說謊的兩條:
 *    章失效時不准當成能用(L14)——網頁的「複製回去的指令」是整個產品最危險的按鈕;
 *    add 過的改動不准消失(老毛病 P1)。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { collectAll, ladderSteps } from '../lib/collect.mjs';
import { unquotePath } from '../lib/git.mjs';
import { codeHome, dataHome } from '../lib/paths.mjs';
import { readAppTitles, deletedAt, transcriptDirName } from '../lib/appSessions.mjs';
import { safeName } from '../lib/events.mjs';
import { stagesBrokenLine } from '../lib/rounds.mjs';
import { decide } from '../gate.mjs';
import { SUGGEST_TOOL } from '../lib/rounds.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 造一個只有一個章的假 monitor 資料夾,章指向 repo 的某個 commit。
 * 章記的是蓋章時那條分支:照這個 repo 真的分支名寫,不寫死 main——章要資料夾、分支都對得上才算(規格:新對話接手舊資料夾 AC-3),
 * 寫死 main 的話,在預設分支叫 master 的機器(GitHub)上它是別條分支的章(2026-09-24,LESSONS L24 的第二次)
 */
function monitorWith(root, commit) {
  const dir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(dir, 'checkpoints'));
  const branch = out(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  writeFileSync(join(dir, 'checkpoints', `${basename(root)}__${branch}.json`), JSON.stringify({
    commit, branch, worktree: root, at: new Date().toISOString(), checks: ['test'],
  }));
  return dir;
}
const out = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

section('測試裡新開的 git 專案,分支名跟 GitHub 上的機器一樣(master)——這台電腦的系統設定是 main,假章寫死 main 會本機綠、推上去紅', 'P8');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  eq('makeRepo 開的專案在 master 上(_harness.mjs 給 git 的預設分支名)', out(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'master');
  r.cleanup();
}

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

section('還沒 commit 幾個:三階梯、還原點那一句、存檔與蓋章卡的大字與清單同一份——改了、commit、又改回蓋章那時候的樣子的檔也算;檔名有空白、雙引號、tab 也對得上(規格:先講commit再講蓋章 AC-1、AC-2、AC-3)', 'P2');
{
  // 檔名:空白——git status 不加 -z 會加引號,diff／ls-files 不加;雙引號、tab——diff／ls-files 也會加引號(LESSONS L44,魔鬼教官 2026-10-29)
  const odd = ['c d.md', 'q"x.md', 'tab\tname.md'];
  const r = makeRepo({ files: Object.fromEntries(['a.js', 'b.js', ...odd].map((f) => [f, '1\n'])) });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  const c1 = out(r.dir, 'rev-parse', 'HEAD');
  for (const f of ['a.js', 'b.js', ...odd]) writeFileSync(join(r.dir, f), '2\n');
  r.git('add', '-A'); r.git('commit', '-qm', '蓋章之後存的');   // 全部都是蓋章之後改過、已經 commit
  writeFileSync(join(r.dir, 'a.js'), '1\n');                    // a.js 又改回蓋章那時候的樣子,還沒 commit:不在「改過的」單子裡,三階梯卻算它
  writeFileSync(join(r.dir, 'c d.md'), '3\n');                  // 檔名有空白、還沒 commit
  writeFileSync(join(r.dir, 'q"x.md'), '3\n');                  // 檔名有雙引號、還沒 commit
  writeFileSync(join(r.dir, 'new e.js'), '1\n');                // 新檔,檔名也有空白
  const monitorDir = monitorWith(root, c1);
  const card = collectAll({ monitorDir }).projects[0]?.cards?.[0];
  const names = (x) => (x?.groups ?? []).flatMap((g) => g.items.map((it) => (g.dir === '根目錄' ? '' : `${g.dir}/`) + it.name)).sort();
  eq('還沒 commit 的:a.js(改回去了也算)、c d.md、new e.js、q"x.md', names(card?.files?.unsaved).join(','), 'a.js,c d.md,new e.js,q"x.md');
  eq('大字的數字就是清單的長度', card?.files?.unsaved?.count, 4);
  eq('三階梯第一格同一個數', card?.ladder?.uncommitted, 4);
  eq('還原點那一行用的個數同一個數', card?.dirty, 4);
  eq('還原點那一句(跟終端機同一句)', card?.lines?.restoreUnsaved, '回去會丟掉你還沒 commit 的 4 個檔案');
  eq('已經 commit、還沒蓋章的:b.js 與 tab 那個(檔名照原樣);空白、雙引號那兩個沒被算成已經 commit', names(card?.files?.saved).join(','), 'b.js,tab\tname.md');
  check('新檔照舊標出來', card?.files?.unsaved?.groups.flatMap((g) => g.items).find((it) => it.name === 'new e.js')?.isNew === true);
  rmSync(monitorDir, { recursive: true, force: true }); r.cleanup();
  // git 加的引號拿掉,換回真的檔名;沒加引號的照原樣
  eq('雙引號', unquotePath('"q\\"x.txt"'), 'q"x.txt');
  eq('tab', unquotePath('"a\\tb.txt"'), 'a\tb.txt');
  eq('反斜線', unquotePath('"back\\\\slash.txt"'), 'back\\slash.txt');
  eq('八進位(中文被寫成位元組時)要整串用 UTF-8 解', unquotePath('"\\346\\226\\207 \\001.txt"'), '文 \u0001.txt');
  eq('沒加引號的照原樣(空白、中文)', unquotePath('規劃中/a b.md'), '規劃中/a b.md');
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

section('L17：程式從哪個資料夾跑,資料都是同一個家', 'P11');
{
  // 2026-09-15:app 把儀表板重開在 worktree 裡,畫面說「還沒有任何案件」——資料都在主資料夾。
  // 2026-10-28 起資料連主資料夾都不住了(規格:紀錄搬到固定的家):程式從哪裡跑,家都是同一個。
  // 「程式的主資料夾」那條規則還在,給要指向程式的地方用(plugin 捷徑、舊接法、背景服務)。
  const repo = makeRepo({ files: { 'a.js': '1\n' } });          // 假裝這是 pipeline-monitor 自己的 repo
  const main = out(repo.dir, 'rev-parse', '--show-toplevel');
  const wtParent = mkdtempSync(join(tmpdir(), 'pm-wt-'));
  const wt = join(wtParent, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'side'], { cwd: repo.dir, stdio: 'ignore' });
  eq('主資料夾的主資料夾是自己', codeHome(main), main);
  eq('worktree 的主資料夾是主資料夾', codeHome(wt), main);
  const plain = mkdtempSync(join(tmpdir(), 'pm-plain-'));
  eq('不在 git 裡的資料夾 → 自己', codeHome(plain), plain);

  // 這支程式自己的資料夾(正式的呼叫都給它)不是資料的家:家是指定的那一個(測試共用的那支給的假家)
  eq('程式自己的資料夾 → 資料的家是指定的那一個', dataHome(ROOT), process.env.PIPELINE_MONITOR_HOME);
  eq('呼叫端給的資料夾(測試的暫存資料夾)照用', dataHome(plain), plain);

  // 家裡放一份章,用程式自己的資料夾跑 collectAll(儀表板的預設)要看得到
  const target = makeRepo({ files: { 'b.js': '1\n' } });
  const troot = out(target.dir, 'rev-parse', '--show-toplevel');
  const cpDir = join(process.env.PIPELINE_MONITOR_HOME, 'checkpoints');
  mkdirSync(cpDir, { recursive: true });
  const tbranch = out(target.dir, 'rev-parse', '--abbrev-ref', 'HEAD');   // 照真的分支名寫,不寫死 main(見 monitorWith)
  const cpFile = join(cpDir, `${basename(troot)}__${tbranch}.json`);
  writeFileSync(cpFile, JSON.stringify({
    commit: out(target.dir, 'rev-parse', 'HEAD'), branch: tbranch, worktree: troot, at: new Date().toISOString(), checks: ['test'],
  }));
  const seen = collectAll({ monitorDir: ROOT, appTitles: new Map() }).projects.map((p) => p.name);
  check('用程式自己的資料夾跑,看得到家裡的案件', seen.includes(basename(troot)), JSON.stringify(seen));
  rmSync(cpFile, { force: true });
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
  // 這個劇本的時間寫死在 2026-09-15:專案要比劇本早存在(init 那個 commit 與它的 reflog 都在劇本之前),劇本才成立——
  // 以前 init 是「現在」,會被當成這一輪之後的存檔;後來用 amend 往前撥,reflog 卻還留著「現在」那一筆,起點的版本找不到、走退路(規格:這一輪的起點)
  const r = makeRepo({ files: { 'a.js': '1\n' }, at: '2026-09-14T00:00:00Z' });
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
  const branch = out(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD');   // 照真的分支名寫,不寫死 main(見 monitorWith)
  writeFileSync(join(monitorDir, 'checkpoints', `${basename(root)}__${branch}.json`), JSON.stringify({
    commit: out(r.dir, 'rev-parse', 'HEAD'), branch, worktree: root, at: T(6), checks: ['test'],
  }));
  writeFileSync(log, readFileSync(log, 'utf8') + ev(7, { skill: 'chaos-check' }) + '\n');
  p = collectAll({ monitorDir, skillHome: home }).projects[0];
  cs = byId(p.cards[0].stages);
  eq('蓋章之後:A(章之前)這一輪沒跑', cs.A.state, 'none');
  eq('蓋章之後:D(章之後)現在', cs.D.state, 'current');
  for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

section('對話頁的 B 也要認 git 說的改動(Bash 寫檔感測器看不到,L8);工作區有兩個對話時不猜是誰改的');
{
  const r = makeRepo({ files: { 'src/a.js': '1\n' }, at: '2026-09-15T00:00:00Z' });   // 比劇本(09-16)早存在
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'pipeline-stages.json'), JSON.stringify({ tiers: { code: ['src/'], danger: [] } }));
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'checkpoints')); mkdirSync(join(monitorDir, 'logs'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const T = (h) => new Date(Date.UTC(2026, 8, 16, h)).toISOString();
  const log = join(monitorDir, 'logs', `${basename(root)}.jsonl`);
  // 一個對話:叫了 A,之後用 Bash 改了 src/a.js(沒有任何 Edit 事件),git 看得到
  writeFileSync(log, JSON.stringify({ ts: T(1), hook: 'UserPromptSubmit', session: 's1', cwd: root, prompt: '/spec x' }) + '\n');
  writeFileSync(join(root, 'src', 'a.js'), 'bash wrote\n');
  let p = collectAll({ monitorDir }).projects[0];
  let ss = Object.fromEntries(p.sessions[0].stages.map((s) => [s.id, s]));
  eq('對話頁:B 亮,而且說是 git 說的', `${ss.B.state}/${ss.B.via}`, 'current/git');
  // 第二個對話進同一個工作區 → 兩個都不猜
  writeFileSync(log, readFileSync(log, 'utf8') + JSON.stringify({ ts: T(2), hook: 'UserPromptSubmit', session: 's2', cwd: root, prompt: 'hi' }) + '\n');
  p = collectAll({ monitorDir }).projects[0];
  const s1 = p.sessions.find((x) => x.id === 's1');
  ss = Object.fromEntries(s1.stages.map((s) => [s.id, s]));
  eq('工作區共用:B 不認 git 的改動(不知道是誰改的)', `${s1.sharesCwd}/${ss.B.state}`, 'true/main');
  rmSync(monitorDir, { recursive: true, force: true }); r.cleanup();
}

section('存檔(commit)之後 B 的證據不能消失:這一輪開始之後的 commit 動到的程式檔也算(git 說的)');
{
  // 專案在這一輪開始(一分鐘前)之前就存在——以前這裡的 repo 比 A 還晚建,現實中不會有(規格:這一輪的起點)
  const r = makeRepo({ files: { 'src/a.js': '1\n' }, at: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'pipeline-stages.json'), JSON.stringify({ tiers: { code: ['src/'], danger: [] } }));
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'checkpoints')); mkdirSync(join(monitorDir, 'logs'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const log = join(monitorDir, 'logs', `${basename(root)}.jsonl`);
  // A 在「一分鐘前」被叫;之後用 Bash 改了 src/a.js 並 commit(工作區乾淨,git diff 看不到)
  const aTs = new Date(Date.now() - 60 * 1000).toISOString();
  writeFileSync(log, JSON.stringify({ ts: aTs, hook: 'UserPromptSubmit', session: 's1', cwd: root, prompt: '/spec x' }) + '\n');
  writeFileSync(join(root, 'src', 'a.js'), 'committed change\n');
  r.git('add', '-A'); r.git('commit', '-qm', 'work');
  const p = collectAll({ monitorDir }).projects[0];
  const cs = Object.fromEntries(p.cards[0].stages.map((s) => [s.id, s]));
  eq('工作區乾淨,但這一輪之後有 commit 動到程式檔 → B 亮,是 git 說的', `${cs.B.state}/${cs.B.via}`, 'current/git');
  eq('未檢查清單是 0(沒有沒存的檔),兩件事不衝突', p.cards[0].dirty, 0);
  rmSync(monitorDir, { recursive: true, force: true }); r.cleanup();
}

section('app 建議卡:要開在別的專案的卡,那邊的對話開始了也認得出來(不然永遠說「還沒開始」);要開在哪、誰提的、從什麼時候開始有紀錄都講得出來');
{
  // 真的卡有一半是「在甲專案的對話裡提、要開在乙專案」:新對話記在乙的紀錄檔裡,只看甲那一份永遠對不到
  const a = makeRepo({ files: { 'a.js': '1\n' } }), b = makeRepo({ files: { 'b.js': '1\n' } });
  const rootA = out(a.dir, 'rev-parse', '--show-toplevel'), rootB = out(b.dir, 'rev-parse', '--show-toplevel');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'logs'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  // 時間用「現在往回算」,而且「現在」只取一次(L18):collectAll 會把超過保留期限的事件丟掉,日期寫死的話這一段過幾個月會無故變紅
  const base = Date.now();
  const T = (h) => new Date(base - (10 - h) * 3600_000).toISOString();
  const PROMPT = '到那個專案把三支指令改成薄殼:先讀它的 CLAUDE.md,只改 .claude/commands/ 底下的檔案,改完跑它自己的測試,其他一律不動。';
  const card = (o) => JSON.stringify({ ts: T(2), hook: 'PreToolUse', tool: SUGGEST_TOOL, session: 'src', cwd: rootA, in_title: '標題', in_tldr: '說明', ...o });
  writeFileSync(join(monitorDir, 'logs', `${basename(rootA)}.jsonl`), [
    JSON.stringify({ ts: T(1), hook: 'UserPromptSubmit', session: 'src', cwd: rootA, prompt: '原本在聊別的', title: '提建議的那個對話' }),
    card({ use_id: 'toolu_far', in_prompt: PROMPT, in_cwd: rootB }),
    card({ use_id: 'toolu_far2', in_prompt: '另一張也要開在那個專案、但還沒有人照著開的卡。說明要夠長才比得出開頭,所以多寫幾個字湊滿六十個字以上。', in_cwd: rootB }),
    card({ use_id: 'toolu_here', in_prompt: '這一張就開在這個專案,沒有指定資料夾,而且還沒有人照著開。說明要夠長才比得出開頭。' }),
    card({ use_id: 'toolu_lost', in_prompt: '這一張要開在儀表板不認得的資料夾。說明要夠長才比得出開頭,所以多寫幾個字。', in_cwd: '/somewhere/unknown-repo' }),
    card({ use_id: 'toolu_cutpath', in_prompt: '這一張的路徑太長被截過。說明要夠長才比得出開頭,所以多寫幾個字湊滿。', in_cwd: '/somewhere/half-a-na', in_cut: ['cwd'] }),
  ].join('\n') + '\n');
  writeFileSync(join(monitorDir, 'logs', `${basename(rootB)}.jsonl`),
    JSON.stringify({ ts: T(3), hook: 'UserPromptSubmit', session: 'started', cwd: rootB, prompt: PROMPT.slice(0, 200), title: '照著卡開的新對話' }) + '\n');
  const ps = collectAll({ monitorDir, appTitles: new Map() }).projects;
  const pA = ps.find((p) => p.name === safeName(basename(rootA))), pB = ps.find((p) => p.name === safeName(basename(rootB)));
  const sg = Object.fromEntries((pA?.suggestions ?? []).map((s) => [s.id, s]));
  eq('五張卡都在提建議的那個專案底下', Object.keys(sg).length, 5);
  eq('別的專案裡有對話照著開了 → 已開始', sg.toolu_far?.startedBy, 'started');
  eq('說得出是哪個對話、在哪個專案(連結才連得過去)', `${sg.toolu_far?.startedTitle}/${sg.toolu_far?.startedProject?.project}`, `照著卡開的新對話/${pB?.name}`);
  eq('要開在哪:儀表板認得的專案', `${sg.toolu_far?.openIn?.project}/${sg.toolu_far?.openIn?.name}`, `${pB?.name}/${pB?.displayName}`);
  eq('知道是哪個對話提的(說明被截短時,完整的只有那裡有)', sg.toolu_far?.fromTitle, '提建議的那個對話');
  eq('沒指定資料夾的卡:不講要開在哪', sg.toolu_here?.openIn, null);
  eq('沒有人照著開 → 還沒開始', sg.toolu_here?.startedBy, null);
  eq('儀表板不認得的資料夾:只給資料夾名,不給連結', `${sg.toolu_lost?.openIn?.project}/${sg.toolu_lost?.openIn?.name}`, 'null/unknown-repo');
  eq('路徑被截過:不拿半截路徑的最後一段當名字', `${sg.toolu_cutpath?.openIn?.project}/${sg.toolu_cutpath?.openIn?.name}`, 'null/null');
  eq('乙專案那一頁不重複出現這張卡', (pB?.suggestions ?? []).length, 0);
  // …但乙那一頁不能只說「一張都沒有」:要開在乙、還沒處理的卡掛在甲那一頁,要指路過去(已開始的那張不算,它處理完了)
  eq('乙那一頁知道別頁有幾張要開在這裡、還沒處理的卡(1 張:另一張已開始,不算)', JSON.stringify(pB?.incomingSuggestions), JSON.stringify([{ project: pA?.name, name: pA?.displayName, count: 1 }]));
  eq('甲那一頁沒有別人要開在這裡的卡', JSON.stringify(pA?.incomingSuggestions), JSON.stringify([]));
  eq('app 的建議卡從什麼時候開始有紀錄(L3)', pA?.appCardsSince, T(2));
  eq('一張都沒記到過的專案 → null(畫面要說「不代表沒跳過」)', pB?.appCardsSince, null);
  rmSync(monitorDir, { recursive: true, force: true }); a.cleanup(); b.cleanup();
}

/** 沒章的專案,比劇本早存在;分級設定跟著第一個 commit 進去(才不會變成一個「還沒存的新檔案」混進清單) */
function originScene(base) {
  const T = (sec) => new Date(base + sec * 1000).toISOString();
  const cfg = JSON.stringify({ tiers: { code: ['src/'], danger: ['src/danger.js'] } });
  const r = makeRepo({ files: { 'src/a.js': '1\n', 'src/danger.js': 'd\n', '.claude/pipeline-stages.json': cfg }, at: T(-3600) });
  const root = out(r.dir, 'rev-parse', '--show-toplevel');
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'checkpoints')); mkdirSync(join(monitorDir, 'logs'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const log = join(monitorDir, 'logs', `${basename(root)}.jsonl`);
  const L = (o) => JSON.stringify({ session: 's1', cwd: root, ...o });
  const write = (lines) => writeFileSync(log, lines.map(L).join('\n') + '\n');
  const bashWrite = (f, body, agoSec) => { writeFileSync(join(root, f), body); const t = new Date(base - agoSec * 1000); utimesSync(join(root, f), t, t); };
  const commit = (msg, at = null) => { execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', msg], { cwd: root, env: at ? { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : process.env }); };
  const cleanup = () => { rmSync(monitorDir, { recursive: true, force: true }); r.cleanup(); };
  return { T, root, monitorDir, write, bashWrite, commit, cleanup };
}

section('沒章:收工前先存檔,未檢查清單、分級、五關的 B 與 D 存檔前後一模一樣——存檔不是改檔(規格:這一輪的起點 AC-2、AC-6)', 'P2');
{
  const s = originScene(Date.now());
  // A 6 分鐘前(這一輪的分界——以前就是有分界,才會去翻存檔紀錄、拿存檔時間當改檔時間);
  // 用 Bash 改了危險檔(感測器沒記到),4 分鐘前;D 3 分鐘前跑過、說沒問題
  s.bashWrite('src/danger.js', 'changed\n', 240);
  s.write([
    { ts: s.T(-420), hook: 'UserPromptSubmit', prompt: '改匯出' },
    { ts: s.T(-360), hook: 'PreToolUse', tool: 'Skill', skill: 'spec' },
    { ts: s.T(-180), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check' },
    { ts: s.T(-170), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'claude' },
  ]);
  const look = () => {
    const p = collectAll({ monitorDir: s.monitorDir }).projects[0];
    const c = p.cards[0], ses = p.sessions[0];
    const st = Object.fromEntries(c.stages.map((x) => [x.id, x]));
    const sv = Object.fromEntries(ses.stages.map((x) => [x.id, x]));
    return { files: c.files?.total, hits: [...(c.tier?.machine?.hits?.danger ?? []), ...(c.tier?.machine?.hits?.code ?? [])].join(','),
             level: c.tier?.final?.id ?? c.tier?.state, B: `${st.B.state}|${st.B.via}|${st.B.ranAt}`, D: st.D.state,
             pageLevel: ses.tier?.final?.id ?? ses.tier?.state, pageD: sv.D.state, scope: c.scope?.title };
  };
  const before = look();
  eq('存檔之前:清單 1 個檔,分級碰到的就是它,D 結案', `${before.files}|${before.hits}|${before.D}`, '1|src/danger.js|done');
  s.commit('收工前存檔');
  const after = look();
  eq('存檔之後:清單、分級、B、D、對話頁,全部跟存檔之前一樣', JSON.stringify(after), JSON.stringify(before));
  check('D 沒有變成「之後又改了程式檔,要再跑一次」(存檔的時間不算改檔)', after.D === 'done' && after.pageD === 'done', JSON.stringify(after));
  eq('標題講這一輪的改動(含已存檔的)', after.scope, '這一輪的改動');
  s.cleanup();
}

section('找不到這一輪開始時的版本:只看得到還沒存的,而且沒有 → 講「看不全」,不講「沒有改動」(規格:這一輪的起點 AC-4)', 'P5');
{
  const s = originScene(Date.now());
  // 劇本的第一句話寫在專案建立之前(兩小時前)——reflog 裡沒有那一刻的版本
  s.write([{ ts: s.T(-7200), hook: 'UserPromptSubmit', prompt: '很久以前的一句話' }]);
  const c = collectAll({ monitorDir: s.monitorDir }).projects[0].cards[0];
  eq('分級是 unseen(存檔過的看不到),不是 no-change', c.tier?.state, 'unseen');
  check('卡片的字:看不全、存檔過的看不到', c.scope?.blind === true && /存檔過的看不到/.test(c.scope?.empty ?? '') && !/沒有改動/.test(c.scope?.empty ?? ''), JSON.stringify(c.scope));
  eq('未檢查清單照實是 0(只看得到還沒存的)', c.files?.total, 0);
  s.cleanup();
}

section('共用工作區:分級一個資料夾一份——專案卡、每個對話頁、調高按鈕看同一份,從最早開口的那個算起、明講含幾個對話(規格:這一輪的起點 AC-3,Oscar 2026-09-22)', 'P2');
{
  const s = originScene(Date.now());
  // s0 50 分鐘前開口,改了危險檔、40 分鐘前存了檔;s1 5 分鐘前開口,用 Bash 改了程式區的 a.js(還沒存)
  s.bashWrite('src/danger.js', 's0\n', 2700);
  s.commit('s0 存檔', s.T(-2400));
  s.bashWrite('src/a.js', 's1\n', 240);
  s.write([
    { ts: s.T(-3000), hook: 'UserPromptSubmit', session: 's0', prompt: '改匯出' },
    { ts: s.T(-2700), hook: 'PostToolUse', tool: 'Edit', session: 's0', file: join(s.root, 'src/danger.js') },
    { ts: s.T(-300), hook: 'UserPromptSubmit', prompt: '調一個標籤' },
  ]);
  const p = collectAll({ monitorDir: s.monitorDir }).projects[0];
  const c = p.cards[0];
  const s1 = p.sessions.find((x) => x.id === 's1'), s0 = p.sessions.find((x) => x.id === 's0');
  const T2 = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).tierLevels.danger.id;
  eq('專案卡:從最早開口的那個算,碰到危險清單', c.tier?.final?.id, T2);
  check('專案卡明講含 2 個對話、從最早開口的那個算起', /含 2 個對話/.test(c.scope?.note ?? '') && /最早開口/.test(c.scope?.note ?? ''), c.scope?.note);
  eq('s1、s0 的對話頁:跟專案卡同一級', `${s1?.tier?.final?.id}|${s0?.tier?.final?.id}`, `${T2}|${T2}`);
  // 調高按鈕照對話頁的分級畫、伺服器拿卡片驗——兩份一樣,按下去才不會安靜地沒反應(魔鬼教官 2026-09-22)
  eq('對話頁能調的等級 = 伺服器驗的那一份(卡片)', JSON.stringify(s1?.tier?.upgradable), JSON.stringify(c.tier?.upgradable));
  s.cleanup();
}

section('切到別的分支存檔、再切回來:現在跟開始時一樣,但不准畫成「沒有改動」的綠臉(魔鬼教官 2026-09-22)', 'P5');
{
  const s = originScene(Date.now());
  const main = out(s.root, 'rev-parse', '--abbrev-ref', 'HEAD');
  s.write([{ ts: s.T(-600), hook: 'UserPromptSubmit', prompt: '開個分支改匯出' }]);
  execFileSync('git', ['checkout', '-q', '-b', 'feat'], { cwd: s.root });
  s.bashWrite('src/danger.js', 'feat\n', 300);
  s.commit('存在 feat 上');
  execFileSync('git', ['checkout', '-q', main], { cwd: s.root });
  const c = collectAll({ monitorDir: s.monitorDir }).projects[0].cards[0];
  eq('分級是 unseen(看不全),不是 no-change', c.tier?.state, 'unseen');
  check('卡片的字:現在跟開始時一樣、但中間存過檔或切過分支', c.scope?.emptyBlind === true && /切過分支/.test(c.scope?.empty ?? ''), JSON.stringify(c.scope));
  s.cleanup();
}

section('只刪檔的回合:D 說沒問題之後刪了程式檔,D 要回到「要再跑一次」(刪掉的檔看所在資料夾的時間;魔鬼教官 2026-09-22)', 'P5');
{
  const s = originScene(Date.now());
  s.bashWrite('src/a.js', 'changed\n', 240);
  s.write([
    { ts: s.T(-420), hook: 'UserPromptSubmit', prompt: '改一下' },
    { ts: s.T(-360), hook: 'PreToolUse', tool: 'Skill', skill: 'spec' },
    { ts: s.T(-180), hook: 'PreToolUse', tool: 'Skill', skill: 'chaos-check' },
    { ts: s.T(-170), event: 'stage_report', stage: 'D', verdict: 'ok', note: '沒對到已知死法', source: 'claude' },
  ]);
  const before = Object.fromEntries(collectAll({ monitorDir: s.monitorDir }).projects[0].cards[0].stages.map((x) => [x.id, x]));
  eq('刪之前:D 結案', before.D.state, 'done');
  execFileSync('git', ['rm', '-q', 'src/danger.js'], { cwd: s.root });
  s.commit('刪檔');
  const c = collectAll({ monitorDir: s.monitorDir }).projects[0].cards[0];
  const after = Object.fromEntries(c.stages.map((x) => [x.id, x]));
  eq('刪之後:D 要再跑一次', after.D.state, 'stale');
  check('分級卡的 D 那一行也說要再跑', /再跑/.test(c.tier?.requirements?.find((r) => r.key === 'D')?.detail ?? ''), JSON.stringify(c.tier?.requirements));
  s.cleanup();
}

section('專案自己寫的關卡讀不懂:不准讓整頁儀表板不見、不准在終端機印程式的錯誤;退回內建的五關,而且講出來(終端機與儀表板同一句)');
{
  // ⚠️ 以前一關寫成 null:終端機印出程式的錯誤訊息,儀表板整頁算不出來——連別的專案一起不見;空的,五關整段消失;不是清單,安安靜靜用內建的
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'checkpoints')); mkdirSync(join(monitorDir, 'logs'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));     // 空的假 home(P8)
  const now = new Date().toISOString();
  const mk = (stages) => {
    const r = makeRepo({ files: { 'a.js': '1\n' } });
    const root = out(r.dir, 'rev-parse', '--show-toplevel');
    mkdirSync(join(root, '.claude'), { recursive: true });
    if (stages !== undefined) writeFileSync(join(root, '.claude', 'pipeline-stages.json'), JSON.stringify({ stages }));
    writeFileSync(join(monitorDir, 'logs', `${basename(root)}.jsonl`), JSON.stringify({ ts: now, hook: 'UserPromptSubmit', prompt: 'hi', session: 's1', cwd: root }) + '\n');
    return { r, root };
  };
  const env = { ...process.env, HOME: home, PIPELINE_MONITOR_HOME: monitorDir, PIPELINE_MONITOR_LOG_DIR: join(monitorDir, 'logs') };
  const good = mk(undefined);                                // 沒覆寫:照內建的,不講任何一句
  const cases = [
    [[null], '第 1 個不是一關'],
    ['x', '「stages」不是一張清單'],
    [[], '「stages」是空的'],
    [[{ name: '沒有代號' }], '第 1 個沒有代號（id）'],
    [[{ id: 'A', name: '寫規格' }, { id: 'A', name: '又一個' }], '代號 A 出現兩次'],
    [[{ id: 'A' }], 'A 沒有名字（name）'],
    [[{ id: 'E', name: '驗收', tools: '(' }], 'E 的工具名規則（tools）讀不懂'],
  ];
  for (const [stages, why] of cases) {
    const bad = mk(stages);
    const label = JSON.stringify(stages);
    let all = null, err = null;
    try { all = collectAll({ monitorDir, skillHome: home }); } catch (e) { err = e; }
    const cardOf = (root) => all?.projects.flatMap((p) => p.cards ?? []).find((c) => c.path === root);
    check(`${label}:儀表板照樣算得出來,別的專案也還在`, !err && !!cardOf(good.root) && !!cardOf(bad.root), String(err?.message ?? ''));
    check(`${label}:那張卡帶著那一句(${why}),照內建的五關畫`, cardOf(bad.root)?.stagesNote === stagesBrokenLine(why) && cardOf(bad.root)?.stages?.length === 5,
      JSON.stringify(cardOf(bad.root)?.stagesNote ?? null));
    let term = '';
    try { term = execFileSync('node', [join(ROOT, 'status.mjs')], { cwd: bad.root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { term = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
    check(`${label}:終端機不印程式的錯誤,五關照畫、上面講同一句`, !/TypeError|SyntaxError|at file:|Error:/.test(term) && term.includes(stagesBrokenLine(why)) && term.includes('━━ 五關 ━━'), term.slice(0, 400));
    let threw = null;
    try { decide({ payload: { session_id: 's1', cwd: bad.root, hook_event_name: 'Stop', stop_hook_active: false }, monitorDir, skillHome: home }); } catch (e) { threw = e; }
    check(`${label}:收工 hook 也不出錯`, !threw, String(threw?.message ?? ''));
    bad.r.cleanup();
  }
  const goodCard = collectAll({ monitorDir, skillHome: home }).projects.flatMap((p) => p.cards ?? []).find((c) => c.path === good.root);
  eq('沒覆寫的專案:沒有那一句', goodCard ? goodCard.stagesNote : '找不到這張卡', null);
  // 選填的欄位寫成 null 就是「沒有」:舊程式照常照專案自己寫的關卡跑——不准講成讀不懂、退回內建的(魔鬼教官第一輪,R1)
  const nul = mk([{ id: 'A', name: '寫規格', skill: 'spec' }, { id: 'B', name: '寫程式', type: 'main-conversation', skill: null, tools: null }]);
  const nulCard = collectAll({ monitorDir, skillHome: home }).projects.flatMap((p) => p.cards ?? []).find((c) => c.path === nul.root);
  check('skill／tools 寫成 null → 照專案自己寫的兩關,不講讀不懂', nulCard?.stagesNote === null && nulCard?.stages?.length === 2, JSON.stringify({ note: nulCard?.stagesNote, n: nulCard?.stages?.length }));
  nul.r.cleanup();
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const code = src.match(/^function stagesNoteLine\(c\) \{\n[\s\S]*?\n\}\n/m)?.[0] ?? null;
  check('從 ui/app.js 拿得出 stagesNoteLine(拿不出來這一段就什麼都沒測到)', !!code);
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const note = code ? new Function('esc', `const zhEn = (zh) => zh;\n${code}; return stagesNoteLine;`)(esc) : () => '';
  check('網頁照印伺服器給的那一句(跳脫過);沒有就不畫', note({ stagesNote: '⚠️ <x>' }).includes('⚠️ &lt;x&gt;') && note({ stagesNote: null }) === '');
  good.r.cleanup();
  for (const d of [monitorDir, home]) rmSync(d, { recursive: true, force: true });
}

process.exit(summary());
