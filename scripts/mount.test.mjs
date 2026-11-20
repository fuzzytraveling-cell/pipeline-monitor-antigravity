/**
 * mount.test.mjs —— 掛載與安裝（Antigravity 版）：
 *   1. 全域 plugin 安裝至 ~/.gemini/config/plugins/agy-pipeline（不碰原版 ~/.claude/skills/pipeline-monitor）
 *   2. 專案級掛載將根目錄 hooks.json 的 named hook groups 合併進 .agents/hooks.json（合併不覆蓋、動手前備份、拆下只拆我們的）
 *   3. 退出記號支援 .agents/pipeline-monitor.off 與相容 .claude/pipeline-monitor.off
 */
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.AGY_PIPELINE_CODE_HOME = ROOT;
const { mount, unmount, mountState, pluginState, installPlugin, uninstallPlugin, optOut, optIn } = await import('../lib/mount.mjs');

const hooksFile = (dir) => JSON.parse(readFileSync(join(dir, '.agents', 'hooks.json'), 'utf8'));
function withExisting(dir, obj) {
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'hooks.json'), JSON.stringify(obj, null, 2));
}
const HOME = mkdtempSync(join(tmpdir(), 'pm-home-'));
const mounted = (dir) => mountState(dir, null, HOME).state !== 'off';

section('掛上（.agents/hooks.json）：別人的 named hook groups 與設定原封不動');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  withExisting(r.dir, {
    'other-tool': { PostToolUse: [{ type: 'command', command: 'echo 別人的' }] },
  });
  mount(r.dir);
  const d = hooksFile(r.dir);
  check('別人的 named hook group 還在', d['other-tool']?.PostToolUse?.[0]?.command === 'echo 別人的');
  check('我們的 SessionStart hook（agy-pipeline-remind）加進去了',
    d['agy-pipeline-remind']?.SessionStart?.some((e) => String(e.command).includes('remind.sh')));
  check('我們的 PostToolUse hook（agy-pipeline-sensor）加進去了',
    d['agy-pipeline-sensor']?.PostToolUse?.some((e) => e.hooks?.some((h) => String(h.command).includes('hook.sh'))));
  check('我們的 Stop hook（agy-pipeline-gate）加進去了',
    d['agy-pipeline-gate']?.Stop?.some((e) => String(e.command).includes('gate.sh')));
  check('動手前有備份', readdirSync(join(r.dir, '.agents')).some((f) => f.includes('.bak-')));
  r.cleanup();
}

section('重複掛不會愈加愈多');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  mount(r.dir);
  const n1 = Object.keys(hooksFile(r.dir)).length;
  const second = mount(r.dir);
  eq('第二次回 already=true', second.already, true);
  eq('掛兩次跟掛一次一樣多組', Object.keys(hooksFile(r.dir)).length, n1);
  r.cleanup();
}

section('拆下：只拆我們的，別人的一根都不能少');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  withExisting(r.dir, {
    'other-tool': { PostToolUse: [{ type: 'command', command: 'echo 別人的' }] },
  });
  mount(r.dir);
  check('掛上後是掛著的', mounted(r.dir));
  unmount(r.dir);
  const d = hooksFile(r.dir);
  check('拆完是沒掛的', !mounted(r.dir));
  eq('只剩別人的那一組', Object.keys(d).join(','), 'other-tool');
  eq('別人的 hook 內容沒被改', d['other-tool'].PostToolUse[0].command, 'echo 別人的');
  r.cleanup();
}

section('設定檔壞掉時：停手，不准硬寫');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  mkdirSync(join(r.dir, '.agents'), { recursive: true });
  const bad = '{ 這不是合法的 JSON';
  writeFileSync(join(r.dir, '.agents', 'hooks.json'), bad);
  const res = mount(r.dir);
  check('回報失敗', res.ok === false);
  eq('原本的檔案一個字都沒被動', readFileSync(join(r.dir, '.agents', 'hooks.json'), 'utf8'), bad);
  check('訊息說得出為什麼', res.out.join('').includes('讀不懂'));
  r.cleanup();
}

section('沒有設定檔的全新專案也掛得上');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  check('掛之前是沒掛的', !mounted(r.dir));
  const res = mount(r.dir);
  check('掛得上', res.ok && mounted(r.dir));
  check('會提醒 .agents/hooks.json 沒被 gitignore', res.out.join('').includes('gitignore'));
  r.cleanup();
}

section('R1：不准宣稱「它真的會動」');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const txt = mount(r.dir).out.join('');
  check('明講自己只確認了設定寫入，不能確認 Antigravity 真的載入', txt.includes('不能確認 Antigravity 真的載入了'), txt);
  check('給了驗證步驟（開新對話跑一次再回來跑 agy-pipeline）', txt.includes('開一個新對話') && txt.includes('最後一筆來自這裡的紀錄'), txt);
  r.cleanup();
}

section('🔴 掛著 ≠ 活著：hook 指向的檔案不見了要看得出來', 'P3');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  mount(r.dir);
  eq('剛掛好 → ok', mountState(r.dir, null, HOME).state, 'ok');

  const f = join(r.dir, '.agents', 'hooks.json');
  const cfg = JSON.parse(readFileSync(f, 'utf8'));
  cfg['agy-pipeline-remind'].SessionStart[0].command = 'sh "/tmp/被搬走了/agy-pipeline/remind.sh"';
  writeFileSync(f, JSON.stringify(cfg, null, 2));

  const st = mountState(r.dir, null, HOME);
  eq('路徑失效 → broken', st.state, 'broken');
  check('說得出是哪個路徑找不到', st.paths.some((p) => p.includes('被搬走了')), JSON.stringify(st.paths));
  check('仍然算掛著', mounted(r.dir));
  r.cleanup();
}

section('worktree 沒有自己的設定，要往主資料夾與使用者層級找', 'P3');
{
  const main = makeRepo({ files: { 'a.js': '1\n' } });
  const wt = makeRepo({ files: { 'a.js': '1\n' } });
  eq('兩邊都沒有 → off', mountState(wt.dir, main.dir, HOME).state, 'off');
  mount(main.dir);
  const st = mountState(wt.dir, main.dir, HOME);
  eq('主資料夾有 → ok', st.state, 'ok');
  eq('而且說得出是主資料夾的設定', st.where, 'main');
  mount(wt.dir);
  eq('自己有的話優先算自己的', mountState(wt.dir, main.dir, HOME).where, 'here');

  // 使用者層級 ~/.gemini/config/hooks.json 路徑失效 → broken/user
  const home2 = mkdtempSync(join(tmpdir(), 'pm-home2-'));
  mkdirSync(join(home2, '.gemini', 'config'), { recursive: true });
  writeFileSync(join(home2, '.gemini', 'config', 'hooks.json'), JSON.stringify({
    'agy-pipeline-sensor': { PostToolUse: [{ type: 'command', command: 'sh "/tmp/沒有這個/agy-pipeline/hook.sh"' }] },
  }));
  const bare = makeRepo({ files: { 'a.js': '1\n' } });
  const u = mountState(bare.dir, null, home2);
  eq('只有帳號層級有、路徑又失效 → broken／user', `${u.state}/${u.where}`, 'broken/user');
  rmSync(home2, { recursive: true, force: true });
  main.cleanup(); wt.cleanup(); bare.cleanup();
}

section('接點清單只有一份：根目錄 hooks.json 與專案級掛載跑同一組腳本', 'P2');
{
  const spec = JSON.parse(readFileSync(join(ROOT, 'hooks.json'), 'utf8'));
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  mount(r.dir);
  const d = hooksFile(r.dir);
  for (const name of Object.keys(spec)) {
    check(`named hook group「${name}」在專案級掛載也有`, !!d[name]);
  }
  const allCmds = Object.values(spec).flatMap((grp) => Object.values(grp).flatMap((arr) =>
    arr.flatMap((e) => (Array.isArray(e.hooks) ? e.hooks.map((h) => h.command) : [e.command]))));
  check('hooks.json 的指令都是相對路徑 sh ./<腳本>.sh（搬家不會斷）',
    allCmds.length > 0 && allCmds.every((c) => /^sh \.\/[a-z]+\.sh$/.test(c)), JSON.stringify(allCmds));
  check('SessionStart → remind.sh', spec['agy-pipeline-remind']?.SessionStart?.[0]?.command === 'sh ./remind.sh');
  check('PostToolUse → hook.sh（感測器不碰 PreToolUse）',
    !!spec['agy-pipeline-sensor']?.PostToolUse?.length && !spec['agy-pipeline-sensor']?.PreToolUse);
  check('PreToolUse → guard.sh（agy-pipeline-guard）',
    spec['agy-pipeline-guard']?.PreToolUse?.[0]?.hooks?.[0]?.command === 'sh ./guard.sh' && !spec['agy-pipeline-guard']?.PostToolUse);
  check('Stop → gate.sh', spec['agy-pipeline-gate']?.Stop?.[0]?.command === 'sh ./gate.sh');
  r.cleanup();
}

section('plugin 目錄缺 guard.sh 或 guard.mjs 時 mountState 回 broken（P3）', 'P3');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  for (const drop of ['guard.sh', 'guard.mjs']) {
    const home = mkdtempSync(join(tmpdir(), 'pm-mhome-'));
    const fakePlugin = mkdtempSync(join(tmpdir(), 'pm-mplugin-'));
    for (const f of ['plugin.json', 'hooks.json', 'hook.sh', 'remind.sh', 'gate.sh', 'gate.mjs', 'guard.sh', 'guard.mjs']) {
      if (f === drop) continue;
      copyFileSync(join(ROOT, f), join(fakePlugin, f));
    }
    mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true });
    symlinkSync(fakePlugin, join(home, '.gemini', 'config', 'plugins', 'agy-pipeline'));
    const st = mountState(r.dir, null, home);
    check(`缺少 ${drop} → broken/plugin`, st.state === 'broken' && st.where === 'plugin' && st.paths.some((p) => p.endsWith(drop)), JSON.stringify(st));
    rmSync(home, { recursive: true, force: true });
    rmSync(fakePlugin, { recursive: true, force: true });
  }
  r.cleanup();
}

section('Antigravity plugin：~/.gemini/config/plugins/agy-pipeline 安裝、退出記號、雙掛偵測、捷徑斷裂、EACCES 友善提示', 'P3');
{
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  eq('沒裝 → installed=false', pluginState(home).installed, false);
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const inst = installPlugin(home, ROOT);
  check('裝得上（捷徑指到這個資料夾）', inst.ok, inst.out.join('\n'));
  eq('裝了 → via plugins-dir', pluginState(home).via, 'plugins-dir');
  check('裝完明講「不能確認 Antigravity 真的載入」並給驗證方法',
    inst.out.join('').includes('不能確認') && inst.out.join('').includes('驗證方法'));
  eq('再裝一次 → 已經裝好，不出錯', installPlugin(home, ROOT).already, true);
  const st1 = mountState(r.dir, null, home);
  eq('plugin 裝了、專案沒退出 → ok／plugin', `${st1.state}/${st1.where}`, 'ok/plugin');

  const marker = optOut(r.dir, 'test');
  check('退出記號寫在 .agents/pipeline-monitor.off', marker.endsWith('.agents/pipeline-monitor.off'), marker);
  const st2 = mountState(r.dir, null, home);
  check('退出 → off，而且說得出記號檔在哪', st2.state === 'off' && st2.optedOut?.path === marker, JSON.stringify(st2));
  eq('重新加入 → 記號拿掉 1 個', optIn(r.dir).length, 1);
  eq('重新加入後 → ok', mountState(r.dir, null, home).state, 'ok');

  mkdirSync(join(r.dir, '.claude'), { recursive: true });
  writeFileSync(join(r.dir, '.claude', 'pipeline-monitor.off'), 'legacy\n');
  eq('舊版 .claude/pipeline-monitor.off 一樣認得出退出', mountState(r.dir, null, home).state, 'off');
  eq('optIn 也會把舊版記號一併清掉', optIn(r.dir).length, 1);

  mount(r.dir);
  check('plugin ＋ 專案級掛載 → alsoLegacy（會記兩次）', mountState(r.dir, null, home).alsoLegacy === true);

  const home2 = mkdtempSync(join(tmpdir(), 'pm-home2-'));
  mkdirSync(join(home2, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(join(home2, '不存在的地方'), join(home2, '.gemini', 'config', 'plugins', 'agy-pipeline'));
  const st3 = mountState(r.dir, null, home2);
  eq('捷徑斷了 → broken／plugin', `${st3.state}/${st3.where}`, 'broken/plugin');

  const home3 = mkdtempSync(join(tmpdir(), 'pm-home3-'));
  const pluginsDir = join(home3, '.gemini', 'config', 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  chmodSync(pluginsDir, 0o500);
  const ro = installPlugin(home3, ROOT);
  check('寫不進 plugins 目錄時不噴 stack trace，回 ok:false 並提示在終端機執行', ro.ok === false && ro.out.join('').includes('終端機'), ro.out.join('\n'));
  chmodSync(pluginsDir, 0o700);

  uninstallPlugin(home);
  eq('拆掉 → 沒裝', pluginState(home).installed, false);
  for (const d of [home, home2, home3]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

rmSync(HOME, { recursive: true, force: true });
process.exit(summary());
