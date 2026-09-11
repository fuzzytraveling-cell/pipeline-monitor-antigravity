/**
 * mount.test.mjs —— 掛載是全專案風險最高的一段:它會動使用者既有的設定檔。
 * ⚠️ 這裡只釘一件事:**別人的東西一根寒毛都不能少**。
 */
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { mount, unmount, mountState } from '../lib/mount.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

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
  main.cleanup(); wt.cleanup(); bare.cleanup();
}

process.exit(summary());
