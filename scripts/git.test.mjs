/**
 * git.test.mjs —— 怎麼叫 git(規格:儀表板刷新少等git)
 *
 * ⚠️ 只釘會安靜說謊的地方:
 *    換一支 git 叫,答案不准變;找不到、中途不見了,不准變成「問不到」(R1);
 *    一次刷新裡共用的答案不准活過那一次刷新、問失敗的不准被借去當答案(AC-4、AC-5);
 *    共用時不准把要原文的那一題切掉空白(老毛病 P1:第一個檔案會標不到)。
 *
 * 用一支假的 git 排在 PATH 最前面:它把每次被叫到記一行,再轉給真的 git。
 * 「找真正的 git」那一步問的 `--exec-path` 由它決定回哪個資料夾——這樣在 GitHub 那台不是 Mac 的機器上也照樣測得到(老毛病 P8)。
 * 「找到的那支」是程式裡記住的,一個行程只有一份:每個情境開一個新的 node 行程跑。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const REALGIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

/** 一個情境:假 git + 它的紀錄檔 + 「真正的 git」住的資料夾(core)。core 給 null = 找不到。 */
function scene({ core = 'link', fakeVersion = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pm-gitbin-'));
  const fake = join(dir, 'fake'); mkdirSync(fake);
  writeFileSync(join(fake, 'git'), [
    '#!/bin/sh',
    'echo x >> "$PM_LOG"',
    'if [ "$1" = "--exec-path" ]; then echo "$PM_CORE"; exit 0; fi',
    'if [ "$1" = "--version" ] && [ -n "$PM_FAKEVER" ]; then echo "$PM_FAKEVER"; exit 0; fi',
    'exec "$PM_REALGIT" "$@"', '',
  ].join('\n'));
  chmodSync(join(fake, 'git'), 0o755);
  const coreDir = join(dir, 'core');
  if (core === 'link') { mkdirSync(coreDir); symlinkSync(REALGIT, join(coreDir, 'git')); }
  const env = { ...process.env, PATH: `${fake}:${process.env.PATH}`, PM_LOG: join(dir, 'log'), PM_REALGIT: REALGIT,
                PM_CORE: core === 'link' ? coreDir : join(dir, 'nowhere'), PM_FAKEVER: fakeVersion };
  /** 在新行程裡跑一段程式;裡面有 git／gitRaw／gitExit／dirtyPaths／withGitMemo、calls()(假 git 被叫了幾次)、core(真正的 git 那個捷徑)。回它印的 JSON */
  const run = (body) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync, existsSync } from 'node:fs';
    const { git, gitRaw, gitExit, dirtyPaths, withGitMemo } = await import(${JSON.stringify(pathToFileURL(join(LIB, 'git.mjs')).href)});
    const calls = () => existsSync(process.env.PM_LOG) ? readFileSync(process.env.PM_LOG, 'utf8').split('\\n').filter(Boolean).length : 0;
    const core = ${JSON.stringify(join(coreDir, 'git'))};
    const out = await (async () => { ${body} })();
    console.log(JSON.stringify(out));
  `], { env, encoding: 'utf8' }));
  return { run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const r = makeRepo({ files: { 'a.js': '1\n', 'b.js': '1\n' } });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).trim();

section('AC-1 找得到真正的 git:之後直接叫它,不再經過 PATH 上那一支;答案一樣');
{
  const s = scene();
  const o = s.run(`
    const a = git(['rev-parse', 'HEAD'], ${JSON.stringify(r.dir)});
    const before = calls();
    const b = git(['rev-parse', 'HEAD'], ${JSON.stringify(r.dir)});
    return { a, b, before, after: calls() };`);
  eq('答案是這個專案的版本', o.a, head);
  eq('第二次也一樣', o.b, head);
  eq('找到之後,PATH 上那一支不再被叫(只有找的那兩次)', o.after, o.before);
  s.cleanup();
}

section('AC-1 版本對不上 → 不用它,照舊叫 PATH 上那一支');
{
  const s = scene({ fakeVersion: 'git version 0.0.0-假的' });
  const o = s.run(`
    git(['--version']);   // 第一次會先找真正的 git,那幾次不算
    const before = calls();
    const a = git(['rev-parse', 'HEAD'], ${JSON.stringify(r.dir)});
    return { a, n: calls() - before };`);
  eq('答案照樣對', o.a, head);
  eq('每一題都經過 PATH 上那一支', o.n, 1);
  s.cleanup();
}

section('AC-2 找不到真正的 git → 照以前的方式問,答案照樣問得到(不准變成「問不到」)');
{
  const s = scene({ core: null });
  const o = s.run(`return { a: git(['rev-parse', 'HEAD'], ${JSON.stringify(r.dir)}), x: gitExit(['merge-base', '--is-ancestor', 'HEAD', 'HEAD'], ${JSON.stringify(r.dir)}) };`);
  eq('答案照樣對', o.a, head);
  eq('離開碼的問題照樣答得出來', o.x, 0);
  s.cleanup();
}

section('AC-2 找到的那支中途不見了(更新開發工具)→ 那一次改問 PATH 上那一支,答案照樣問得到');
{
  const s = scene();
  const o = s.run(`
    const { rmSync } = await import('node:fs');
    const a = git(['rev-parse', 'HEAD'], ${JSON.stringify(r.dir)});
    rmSync(core);
    const before = calls();
    const b = git(['rev-parse', 'HEAD'], ${JSON.stringify(r.dir)});
    const raw = gitRaw(['rev-parse', 'HEAD'], ${JSON.stringify(r.dir)});
    return { a, b, raw, n: calls() - before };`);
  eq('不見之前問得到', o.a, head);
  eq('不見之後照樣問得到(不是 null)', o.b, head);
  eq('原文那一條也照樣問得到', o.raw?.trim(), head);
  check('不見之後改經過 PATH 上那一支', o.n >= 2, `經過了 ${o.n} 次`);
  s.cleanup();
}

section('AC-2 資料夾不在了 → 照實「問不到」,也不因此丟掉找到的那支');
{
  const s = scene();
  const o = s.run(`
    git(['rev-parse', 'HEAD'], ${JSON.stringify(r.dir)});
    const before = calls();
    const gone = git(['rev-parse', 'HEAD'], '/這個資料夾不存在-pm-test');
    const again = git(['rev-parse', 'HEAD'], ${JSON.stringify(r.dir)});
    return { gone, again, n: calls() - before };`);
  eq('不在的資料夾 → null(問不到)', o.gone, null);
  eq('之後照樣問得到', o.again, head);
  eq('沒有因此退回 PATH 上那一支(那支還在,是資料夾的問題)', o.n, 0);
  s.cleanup();
}

section('AC-3 一次刷新裡同一題只問一次;刷新以外照舊每次都問');
{
  const s = scene({ core: null });   // 全部經過假 git,才數得到
  const o = s.run(`
    const d = ${JSON.stringify(r.dir)};
    git(['--version']);   // 第一次會先找真正的 git,那幾次不算
    const c0 = calls();
    withGitMemo(() => { git(['rev-parse', 'HEAD'], d); git(['rev-parse', 'HEAD'], d); gitExit(['merge-base', '--is-ancestor', 'HEAD', 'HEAD'], d); gitExit(['merge-base', '--is-ancestor', 'HEAD', 'HEAD'], d); });
    const inRound = calls() - c0;
    const c1 = calls();
    git(['rev-parse', 'HEAD'], d); git(['rev-parse', 'HEAD'], d);
    return { inRound, outside: calls() - c1 };`);
  eq('一輪裡兩題各問兩遍 → git 只被叫 2 次', o.inRound, 2);
  eq('一輪以外問兩遍 → 叫 2 次(收工 hook、終端機照舊,AC-6)', o.outside, 2);
  s.cleanup();
}

section('AC-3 共用時,要原文的那一題不准拿到切掉空白的答案', 'P1');
{
  writeFileSync(join(r.dir, 'a.js'), '2\n');   // " M a.js":第一行開頭就是空白
  const s = scene();
  const o = s.run(`
    const d = ${JSON.stringify(r.dir)};
    return withGitMemo(() => {
      const trimmed = git(['status', '--porcelain', '-uall'], d);   // 先問切過空白的那一種
      return { trimmed, paths: [...(dirtyPaths(d) ?? [])] };
    });`);
  check('dirtyPaths 照樣標得到第一個檔案 a.js', o.paths.includes('a.js'), `拿到 ${JSON.stringify(o.paths)}`);
  check('git() 照樣是切過空白的', o.trimmed?.startsWith('M '), `拿到 ${JSON.stringify(o.trimmed)}`);
  execFileSync('git', ['checkout', '-q', 'a.js'], { cwd: r.dir });
}

section('AC-4 刷新結束就丟:下一次刷新一定重新問;中途出錯也一樣丟');
{
  const s = scene();
  const o = s.run(`
    const { execFileSync } = await import('node:child_process');
    const d = ${JSON.stringify(r.dir)};
    const first = withGitMemo(() => git(['rev-parse', 'HEAD'], d));
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'next'], { cwd: d });
    const second = withGitMemo(() => git(['rev-parse', 'HEAD'], d));
    let third = null;
    try { withGitMemo(() => { git(['rev-parse', 'HEAD'], d); throw new Error('中途出錯'); }); } catch {}
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'next2'], { cwd: d });
    third = git(['rev-parse', 'HEAD'], d);
    const fourth = withGitMemo(() => git(['rev-parse', 'HEAD'], d));
    return { first, second, third, fourth };`);
  check('存檔之後的下一輪看到新的版本', o.first !== o.second && o.second !== null, `${o.first} → ${o.second}`);
  check('出錯的那一輪之後,存檔看得到(刷新以外)', o.third !== o.second && o.third !== null);
  eq('下一輪也看得到', o.fourth, o.third);
  s.cleanup();
}

section('AC-5 問失敗的不共用:同一輪再問到就再問一次');
{
  const s = scene({ core: null });
  const o = s.run(`
    const d = ${JSON.stringify(r.dir)};
    git(['--version']);   // 第一次會先找真正的 git,那幾次不算
    const c0 = calls();
    const res = withGitMemo(() => [
      git(['rev-parse', '--verify', '-q', 'no-such-branch'], d), git(['rev-parse', '--verify', '-q', 'no-such-branch'], d),
      gitExit(['merge-base', '--is-ancestor', 'no-such', 'HEAD'], d), gitExit(['merge-base', '--is-ancestor', 'no-such', 'HEAD'], d),
    ]);
    return { res, n: calls() - c0 };`);
  eq('問不到的照實是 null', o.res[0], null);
  check('離開碼不是 0／1(問不到)', o.res[2] !== 0 && o.res[2] !== 1, `拿到 ${o.res[2]}`);
  eq('兩題各問兩遍 → 四次都真的問了', o.n, 4);
  s.cleanup();
}

r.cleanup();
process.exit(summary());
