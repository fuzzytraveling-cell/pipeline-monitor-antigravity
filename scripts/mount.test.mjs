/**
 * mount.test.mjs —— 掛載是全專案風險最高的一段:它會動使用者既有的設定檔。
 * ⚠️ 這裡只釘一件事:**別人的東西一根寒毛都不能少**。
 */
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 舊接法的 hook 指向「程式的主資料夾」(lib/paths.mjs 的 codeHome)。在 worktree 裡跑測試時,主資料夾可能還沒有這條分支新加的腳本
// (2026-09-16 加 gate.sh 時撞到:掛好了卻說 broken,因為它指向主資料夾裡還不存在的 gate.sh)。
// 所以先把程式的位置指向這份程式碼自己,再載入 mount.mjs;「worktree 的主資料夾」這條規則本身由 collect.test 釘。
// (以前借 PIPELINE_MONITOR_HOME 指——那個變數現在只管資料的家,規格:紀錄搬到固定的家)
process.env.PIPELINE_MONITOR_CODE_HOME = ROOT;
const { mount, unmount, mountState, pluginState, installPlugin, uninstallPlugin, optOut, optIn } = await import('../lib/mount.mjs');

const settings = (dir) => JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
function withExisting(dir, obj) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(obj, null, 2));
}
// ⚠️ mountState 會退而找帳號層級的 ~/.claude——測試要用一個空的假 home,否則這台機器的設定會影響結果
const HOME = mkdtempSync(join(tmpdir(), 'pm-home-'));
const mounted = (dir) => mountState(dir, null, HOME).state !== 'off';

section('掛上:別人的 hook 與設定原封不動');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  withExisting(r.dir, {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo 別人的' }] }] },
    otherSetting: true, permissions: { allow: ['Bash(ls:*)'] },
  });
  mount(r.dir);
  const d = settings(r.dir);
  eq('otherSetting 沒被吃掉', d.otherSetting, true);
  check('permissions 沒被吃掉', Array.isArray(d.permissions?.allow) && d.permissions.allow.length === 1);
  const bash = d.hooks.PreToolUse.filter((e) => e.matcher === 'Bash');
  eq('別人的 Bash hook 還在', bash.length, 1);
  eq('別人的 hook 內容沒被改', bash[0].hooks[0].command, 'echo 別人的');
  check('我們的 Skill hook 加進去了',
    d.hooks.PreToolUse.some((e) => e.matcher === 'Skill'));
  check('動手前有備份',
    readdirSync(join(r.dir, '.claude')).some((f) => f.includes('.bak-')));
  r.cleanup();
}

section('重複掛不會愈加愈多');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  mount(r.dir);
  const n1 = settings(r.dir).hooks.PostToolUse.length;
  mount(r.dir); mount(r.dir);
  eq('掛三次跟掛一次一樣', settings(r.dir).hooks.PostToolUse.length, n1);
  r.cleanup();
}

section('拆下:只拆我們的,別人的一根都不能少');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  withExisting(r.dir, {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo 別人的' }] }] },
    otherSetting: 42,
  });
  mount(r.dir);
  check('掛上後是掛著的', mounted(r.dir));
  unmount(r.dir);
  const d = settings(r.dir);
  check('拆完是沒掛的', !mounted(r.dir));
  eq('別人的 hook 還在', d.hooks.PreToolUse.length, 1);
  eq('別人的 hook 內容沒被改', d.hooks.PreToolUse[0].hooks[0].command, 'echo 別人的');
  eq('otherSetting 還在', d.otherSetting, 42);
  r.cleanup();
}

section('設定檔壞掉時:停手,不准硬寫');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  mkdirSync(join(r.dir, '.claude'), { recursive: true });
  const bad = '{ 這不是合法的 JSON';
  writeFileSync(join(r.dir, '.claude', 'settings.local.json'), bad);
  const res = mount(r.dir);
  check('回報失敗', res.ok === false);
  eq('原本的檔案一個字都沒被動', readFileSync(join(r.dir, '.claude', 'settings.local.json'), 'utf8'), bad);
  check('訊息說得出為什麼', res.out.join('').includes('讀不懂'));
  r.cleanup();
}

section('沒有設定檔的全新專案也掛得上');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  check('掛之前是沒掛的', !mounted(r.dir));
  const res = mount(r.dir);
  check('掛得上', res.ok && mounted(r.dir));
  check('會提醒 .claude 沒被 gitignore', res.out.join('').includes('gitignore'));
  r.cleanup();
}

section('R1:不准宣稱「它真的會動」');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const txt = mount(r.dir).out.join('');
  // ⚠️ 我們只能確認「設定寫進去了」。宣稱它會動就是假成功。
  check('明講自己只確認了設定寫入', txt.includes('不能確認它真的會動'));
  check('給了驗證方法', txt.includes('驗證方法'));
  r.cleanup();
}

section('🔴 掛著 ≠ 活著:hook 指向的檔案不見了要看得出來', 'P3');
{
  // ⚠️ 2026-09-10 真的發生過:資料夾搬走 → hook 指向不存在的檔案 →
  //    紀錄靜默停止,設定看起來完全正常。這是這個專案最痛恨的失敗形狀。
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  mount(r.dir);
  eq('剛掛好 → ok', mountState(r.dir, null, HOME).state, 'ok');

  // 把設定裡的路徑改成一個不存在的地方,模擬「資料夾被搬走」。
  // ⚠️ 要改解析後的物件,不要對檔案文字做取代——檔案裡的引號是 JSON 跳脫過的。
  const f = join(r.dir, '.claude', 'settings.local.json');
  const cfg = JSON.parse(readFileSync(f, 'utf8'));
  for (const arr of Object.values(cfg.hooks)) {
    for (const e of arr) {
      for (const h of e.hooks ?? []) {
        if (String(h.command).includes('pipeline-monitor')) {
          h.command = 'sh "/tmp/被搬走了/pipeline-monitor/hook.sh"';
        }
      }
    }
  }
  writeFileSync(f, JSON.stringify(cfg, null, 2));

  const st = mountState(r.dir, null, HOME);
  eq('路徑失效 → broken(不是 ok,也不是 off)', st.state, 'broken');
  check('說得出是哪個路徑找不到', st.paths.some((p) => p.includes('被搬走了')), JSON.stringify(st.paths));
  check('仍然算掛著(它確實掛著)', mounted(r.dir));
  r.cleanup();
}

section('D1:worktree 沒有自己的設定,要往主資料夾與帳號層級找', 'P3');
{
  // ⚠️ 2026-09-11 實測:desktop app 開的 worktree 沒有 .claude/settings.local.json,
  //    hook 用主資料夾那份在跑,紀錄裡明明有它的事件,畫面卻說「沒掛上」。
  const main = makeRepo({ files: { 'a.js': '1\n' } });
  const wt = makeRepo({ files: { 'a.js': '1\n' } });   // 只需要一個沒有設定的資料夾
  eq('兩邊都沒有 → off', mountState(wt.dir, main.dir, HOME).state, 'off');
  mount(main.dir);
  const st = mountState(wt.dir, main.dir, HOME);
  eq('主資料夾有 → ok', st.state, 'ok');
  eq('而且說得出是主資料夾的設定', st.where, 'main');
  mount(wt.dir);
  eq('自己有的話優先算自己的', mountState(wt.dir, main.dir, HOME).where, 'here');

  // 帳號層級(~/.claude/settings.json):找得到,但路徑失效 → broken,而且說得出是帳號層級的
  const home2 = mkdtempSync(join(tmpdir(), 'pm-home2-'));
  mkdirSync(join(home2, '.claude'));
  writeFileSync(join(home2, '.claude', 'settings.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'sh "/tmp/沒有這個/pipeline-monitor/hook.sh"' }] }] },
  }));
  const bare = makeRepo({ files: { 'a.js': '1\n' } });
  const u = mountState(bare.dir, null, home2);
  eq('只有帳號層級有、路徑又失效 → broken／user', `${u.state}/${u.where}`, 'broken/user');
  rmSync(home2, { recursive: true, force: true });
  main.cleanup(); wt.cleanup(); bare.cleanup();
}

section('接點清單只有一份:舊接法接的事件 = plugin 的 hooks/hooks.json', 'P2');
{
  const spec = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  mount(r.dir);
  const d = settings(r.dir);
  for (const [evt, entries] of Object.entries(spec)) {
    for (const e of entries) {
      const script = e.hooks[0].command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/)?.[1];
      const mine = d.hooks[evt]?.find((x) => x.matcher === (e.matcher ?? '') && x.hooks?.[0]?.command?.includes('pipeline-monitor'));
      check(`${evt} matcher="${e.matcher ?? ''}" 舊接法也有,而且跑同一支腳本(${script})`,
        !!mine && mine.hooks[0].command.endsWith(`/${script}"`), mine?.hooks?.[0]?.command ?? '(沒有)');
    }
  }
  check('hooks.json 的指令都指向 ${CLAUDE_PLUGIN_ROOT}/<腳本>.sh(搬家不會斷)',
    Object.values(spec).flat().every((e) => e.hooks.every((h) => /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/[a-z]+\.sh"$/.test(h.command))));
  check('對話開始的提醒接在 SessionStart → remind.sh(跟感測器 hook.sh 是分開的兩支)',
    (spec.SessionStart ?? []).some((e) => e.hooks[0].command.endsWith('/remind.sh"')));
  check('E 驗收要接得到瀏覽器工具', (spec.PreToolUse ?? []).some((e) => /Claude_Browser/.test(e.matcher ?? '')));
  r.cleanup();
}

section('plugin:裝了沒、退出記號、舊接法會記兩次、捷徑斷了要看得出來', 'P3');
{
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  eq('沒裝 → installed=false', pluginState(home).installed, false);
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const inst = installPlugin(home, ROOT);
  check('裝得上(捷徑指到這個資料夾)', inst.ok, inst.out.join('\n'));
  eq('裝了 → via skills-dir', pluginState(home).via, 'skills-dir');
  // R1:裝完不宣稱會動,給驗證方法
  check('裝完明講「不能確認它真的載入」並給驗證方法',
    inst.out.join('').includes('不能確認') && inst.out.join('').includes('驗證方法'));
  eq('再裝一次 → 已經裝好,不出錯', installPlugin(home, ROOT).already, true);
  const st1 = mountState(r.dir, null, home);
  eq('plugin 裝了、專案沒退出 → ok／plugin', `${st1.state}/${st1.where}`, 'ok/plugin');

  const marker = optOut(r.dir, 'test');
  const st2 = mountState(r.dir, null, home);
  check('退出 → off,而且說得出記號檔在哪', st2.state === 'off' && st2.optedOut?.path === marker, JSON.stringify(st2));
  eq('重新加入 → 記號拿掉 1 個', optIn(r.dir).length, 1);
  eq('重新加入後 → ok', mountState(r.dir, null, home).state, 'ok');

  mount(r.dir);   // 舊接法還留在專案的設定檔裡
  check('plugin ＋ 舊接法 → alsoLegacy(會記兩次)', mountState(r.dir, null, home).alsoLegacy === true);

  // 捷徑在,但指向的資料夾被搬走了——L13 的形狀,要講 broken,不是「沒裝」
  const home2 = mkdtempSync(join(tmpdir(), 'pm-home2-'));
  mkdirSync(join(home2, '.claude', 'skills'), { recursive: true });
  symlinkSync(join(home2, '不存在的地方'), join(home2, '.claude', 'skills', 'pipeline-monitor'));
  const st3 = mountState(r.dir, null, home2);
  eq('捷徑斷了 → broken／plugin', `${st3.state}/${st3.where}`, 'broken/plugin');

  uninstallPlugin(home);
  eq('拆掉 → 沒裝', pluginState(home).installed, false);
  for (const d of [home, home2]) rmSync(d, { recursive: true, force: true });
  r.cleanup();
}

rmSync(HOME, { recursive: true, force: true });
process.exit(summary());
