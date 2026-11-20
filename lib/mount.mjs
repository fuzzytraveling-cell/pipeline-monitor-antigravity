/**
 * mount.mjs —— Antigravity 感測器怎麼掛到專案上、掛了沒、退出了沒
 *
 * 兩種掛法：
 *   ① plugin（正路）：裝在使用者層級（~/.gemini/config/plugins/agy-pipeline → 指向這個資料夾），
 *      每個專案都會記；不想記的專案放記號檔 .agents/pipeline-monitor.off（相容 .claude/pipeline-monitor.off）。
 *      ⚠️ ~/.gemini/config 受 Antigravity 沙盒保護，--install 須在終端機執行；若寫不進去（EACCES/EPERM）照實指路。
 *   ② 專案級掛載（--on）：把根目錄 hooks.json 的 named hooks 合併進該專案的 .agents/hooks.json。
 *      plugin 裝好之後要拆掉，不然會記兩次。
 *
 * 三個安全護欄：
 *   ① 合併，不是覆蓋——別人的 named hooks 原封不動留著；動檔前先備份
 *   ② .agents/hooks.json 沒被 gitignore → 要講出來，不默默裝下去
 *   ③ 裝完不宣稱「真的通了」——講明驗證方法（開新對話觸發一次工具呼叫）
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync,
  symlinkSync, lstatSync, readlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { codeHome, dataDir } from './paths.mjs';
import { zhEn, plural } from './lang.mjs';

const CODE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const HERE = codeHome(CODE_DIR);
export const PLUGIN_NAME = 'agy-pipeline';
/** 退出記號（優先寫 .agents/，讀與拆兼認 .claude/）。 */
export const OFF_MARKER = join('.agents', 'pipeline-monitor.off');
export const LEGACY_OFF_MARKER = join('.claude', 'pipeline-monitor.off');
const OFF_MARKERS = [OFF_MARKER, LEGACY_OFF_MARKER];

/** 根目錄 hooks.json 是接點清單的唯一一份（P2）。專案級掛載把相對路徑 `./<script>` 換成主資料夾的絕對路徑。 */
function loadPluginHooks(target = HERE) {
  const spec = JSON.parse(readFileSync(join(CODE_DIR, 'hooks.json'), 'utf8'));
  const rewriteCmd = (cmd) => String(cmd ?? '').replace(/\.\/([\w.-]+\.sh)\b/g, (_, s) => JSON.stringify(join(target, s)));
  const rewriteList = (arr) => arr.map((item) => {
    if (Array.isArray(item?.hooks)) {
      return { ...item, hooks: item.hooks.map((h) => ({ ...h, command: rewriteCmd(h.command) })) };
    }
    return { ...item, command: rewriteCmd(item.command) };
  });
  const out = {};
  for (const [name, cfg] of Object.entries(spec)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const copy = {};
    for (const [evt, val] of Object.entries(cfg)) {
      copy[evt] = Array.isArray(val) ? rewriteList(val) : val;
    }
    out[name] = copy;
  }
  return out;
}

const OUR_HOOK_NAMES = () => Object.keys(JSON.parse(readFileSync(join(CODE_DIR, 'hooks.json'), 'utf8')));
const isOurHookKey = (name, cfg) => name.startsWith('agy-pipeline')
  || JSON.stringify(cfg ?? '').includes('agy-pipeline')
  || JSON.stringify(cfg ?? '').includes('pipeline-monitor');

function projectHooksPath(root) { return join(root, '.agents', 'hooks.json'); }

function readHooksFile(p) {
  if (!existsSync(p)) return { data: {}, existed: false };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: null, existed: true, broken: 'not a JSON object' };
    }
    return { data: parsed, existed: true };
  } catch (e) {
    return { data: null, existed: true, broken: String(e.message) };
  }
}

function isIgnored(root, rel = '.agents/hooks.json') {
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', rel], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** 抽出某個 hooks.json 裡我們所有 command 指向的腳本絕對路徑（供 mountState 查斷鏈）。 */
function extractCommandPaths(cfg, baseDir) {
  const paths = [];
  const collect = (cmd) => {
    const s = String(cmd ?? '');
    const q = s.match(/"([^"]+\.sh)"/);
    if (q) { paths.push(q[1]); return; }
    const rel = s.match(/\.\/([\w.-]+\.sh)\b/);
    if (rel && baseDir) paths.push(join(baseDir, rel[1]));
  };
  for (const val of Object.values(cfg ?? {})) {
    if (!Array.isArray(val)) continue;
    for (const item of val) {
      if (Array.isArray(item?.hooks)) {
        for (const h of item.hooks) collect(h?.command);
      } else collect(item?.command);
    }
  }
  return paths;
}

/* ────────────────────────── 專案級掛載：.agents/hooks.json ────────────────────────── */

export function mount(root, target = HERE) {
  const out = [];
  const p = projectHooksPath(root);
  const { data, existed, broken } = readHooksFile(p);
  if (broken) {
    out.push(zhEn(`❌ ${p} 讀不懂（${broken}）。`, `❌ Can't read ${p} (${broken}).`));
    out.push(zhEn('   為了不弄壞你原本的設定,這次不動它。請先修好那個檔案。', '   To avoid breaking your existing settings, it\'s left alone this time. Please fix that file first.'));
    return { ok: false, out };
  }

  const wanted = loadPluginHooks(target);
  let added = 0, already = 0;
  for (const [name, cfg] of Object.entries(wanted)) {
    if (Object.hasOwn(data, name) && JSON.stringify(data[name]) === JSON.stringify(cfg)) {
      already++;
      continue;
    }
    data[name] = cfg;
    added++;
  }

  if (!added) {
    out.push(zhEn(`✅ 這個專案已經掛上了（${already} 個接點都在）。`, `✅ This project is already hooked up (all ${already} hook points are there).`));
    return { ok: true, out, already: true };
  }

  mkdirSync(dirname(p), { recursive: true });
  if (existed) {
    const bak = `${p}.bak-${Date.now()}`;
    copyFileSync(p, bak);
    out.push(zhEn(`   （原本的設定已備份到 ${bak.split('/').pop()}）`, `   (The original settings were backed up to ${bak.split('/').pop()})`));
  }
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');

  out.unshift(zhEn(`✅ 掛好了:加了 ${added} 組接點到 .agents/hooks.json`, `✅ Hooked up: added ${plural(added, 'hook group')} to .agents/hooks.json`));
  if (!isIgnored(root, '.agents/hooks.json')) {
    out.push('');
    out.push(zhEn('⚠️ 這個專案的 .agents/hooks.json **沒有被 gitignore**,', '⚠️ This project\'s .agents/hooks.json is **not gitignored**,'));
    out.push(zhEn('   裡面寫的是這台電腦的絕對路徑，會跟著程式一起被 commit 上去。', '   it holds this computer\'s absolute paths and will be committed along with your code.'));
    out.push(zhEn('   不想要的話,在那個專案的 .gitignore 加一行:  .agents/hooks.json', '   If you don\'t want that, add this line to that project\'s .gitignore:  .agents/hooks.json'));
  }
  out.push('');
  out.push(zhEn('⚠️ 我只能確認「設定寫進去了」,**不能確認 Antigravity 真的載入了**——', '⚠️ All I can confirm is "the settings were written", **not that Antigravity actually loaded them** —'));
  out.push(zhEn('   開一個新對話、讓 AI 執行一次工具（例如跑一次 agy-pipeline 或改一個檔），回來跑 agy-pipeline，',
    '   open a new conversation, have AI run a tool (for example run agy-pipeline or edit a file), then run agy-pipeline;'));
  out.push(zhEn('   感測器那一行出現「最後一筆來自這裡的紀錄:N 分鐘前」,就是真的通了。', '   if the sensor line shows "Last record from here: N minutes ago", it really works.'));
  return { ok: true, out };
}

export function unmount(root) {
  const out = [];
  const p = projectHooksPath(root);
  const { data, existed, broken } = readHooksFile(p);
  if (!existed) { out.push(zhEn('這個專案本來就沒掛上。', 'This project wasn\'t hooked up in the first place.')); return { ok: true, out }; }
  if (broken) { out.push(zhEn('❌ 設定檔讀不懂,不動它。', '❌ Can\'t read the settings file, so it\'s left alone.')); return { ok: false, out }; }

  const names = new Set(OUR_HOOK_NAMES());
  let removed = 0;
  for (const key of Object.keys(data)) {
    if (names.has(key) || isOurHookKey(key, data[key])) {
      delete data[key];
      removed++;
    }
  }
  if (!removed) { out.push(zhEn('沒找到我們裝的接點,沒有東西要拆。', 'No hook points of ours were found, so there\'s nothing to remove.')); return { ok: true, out }; }

  const bak = `${p}.bak-${Date.now()}`;
  copyFileSync(p, bak);
  if (Object.keys(data).length) writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  else rmSync(p);

  out.push(zhEn(`✅ 拆掉了 ${removed} 組接點。別人的 hook 沒有動。`, `✅ Removed ${plural(removed, 'hook group')}. Other hooks weren't touched.`));
  out.push(zhEn(`   （動手前已備份到 ${bak.split('/').pop()}）`, `   (Backed up to ${bak.split('/').pop()} first)`));
  out.push(zhEn('⚠️ 已經記下來的紀錄還在,不會因為拆掉就消失。', '⚠️ The records already made are still there; removing it doesn\'t make them disappear.'));
  out.push(zhEn(`   要一起清掉的話,刪 ${dataDir('logs')} 底下對應的檔案。`, `   To clear them too, delete the matching files under ${dataDir('logs')}.`));
  return { ok: true, out };
}

/** <dir>/.agents/hooks.json 或（使用者層級）<dir>/.gemini/config/hooks.json 裡，我們接點指向的腳本路徑。 */
export function hookPathsIn(dir, { userLevel = false } = {}) {
  const file = userLevel ? join(dir, '.gemini', 'config', 'hooks.json') : projectHooksPath(dir);
  let data = null;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const ours = [];
  for (const [k, v] of Object.entries(data)) {
    if (!isOurHookKey(k, v)) continue;
    ours.push(...extractCommandPaths(v, dirname(file)));
  }
  return ours;
}

/* ────────────────────────── plugin：裝在 ~/.gemini/config/plugins/agy-pipeline ────────────────────────── */

function pluginDir(home = homedir()) {
  return join(home, '.gemini', 'config', 'plugins', PLUGIN_NAME);
}

/**
 * Antigravity plugin 裝了沒：~/.gemini/config/plugins/agy-pipeline。
 * 捷徑在但目標不在 → dangling:true（搬家）；目標在但不是完整 agy-pipeline → foreign:true。
 */
export function pluginState(home = homedir()) {
  const dir = pluginDir(home);
  let linkExists = false;
  try { lstatSync(dir); linkExists = true; } catch { /* 沒有 */ }
  try {
    const m = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
    if (m?.name === PLUGIN_NAME) return { installed: true, via: 'plugins-dir', root: dir, dangling: false };
  } catch { /* 讀不到 */ }
  if (linkExists) return { installed: true, via: 'plugins-dir', root: dir, dangling: !existsSync(dir), foreign: existsSync(dir) };
  return { installed: false, via: null, root: null, dangling: false };
}

/** 把這個資料夾以 Antigravity plugin 身分裝到 ~/.gemini/config/plugins/agy-pipeline → 這裡。 */
export function installPlugin(home = homedir(), target = HERE) {
  const out = [];
  const dir = join(home, '.gemini', 'config', 'plugins');
  const link = join(dir, PLUGIN_NAME);
  try {
    mkdirSync(dir, { recursive: true });
    let replaced = null;
    try {
      const st = lstatSync(link);
      const cur = st.isSymbolicLink() ? readlinkSync(link) : null;
      if (cur === target) {
        out.push(zhEn(`✅ 已經裝好了：${link} → ${target}`, `✅ Already installed: ${link} → ${target}`));
        return { ok: true, out, already: true };
      }
      if (cur !== null && !existsSync(link)) {
        rmSync(link);
        replaced = cur;
      } else {
        out.push(zhEn(`❌ ${link} 已經存在（${cur ? `指向 ${cur}` : '是一個真的資料夾'}）,我不動它。`, `❌ ${link} already exists (${cur ? `pointing to ${cur}` : 'as a real folder'}), so I'm leaving it alone.`));
        out.push(zhEn('   想換成這一份,先把它移走再跑一次。', '   To switch to this copy, move it away first and run this again.'));
        return { ok: false, out };
      }
    } catch { /* 不存在，正常 */ }
    symlinkSync(target, link);
    out.push(replaced
      ? zhEn(`✅ 換好了：${link} 原本指向 ${replaced}（那個資料夾已經不在了），現在指向 ${target}`, `✅ Switched: ${link} used to point to ${replaced} (that folder is gone); now it points to ${target}`)
      : zhEn(`✅ 裝好了：${link} → ${target}`, `✅ Installed: ${link} → ${target}`));
  } catch (e) {
    // ~/.gemini/config 受 Antigravity 沙盒保護：寫不進去就照實講並給終端機指令，絕不假成功（R1/R2）
    if (e?.code === 'EACCES' || e?.code === 'EPERM' || e?.code === 'EROFS') {
      out.push(zhEn(`❌ 寫不進 ${dir}（系統保護或沒有權限）。`, `❌ Can't write to ${dir} (protected or no permission).`));
      out.push(zhEn(`   請在自己的終端機執行：node ${JSON.stringify(join(target, 'status.mjs'))} --install`,
        `   Run this in your own terminal: node ${JSON.stringify(join(target, 'status.mjs'))} --install`));
      out.push(zhEn('   （裝好 npm link 後可直接跑：agy-pipeline --install）', '   (or after npm link: agy-pipeline --install)'));
      return { ok: false, out };
    }
    out.push(zhEn(`❌ 安裝沒成功：${e?.message ?? e}`, `❌ Install failed: ${e?.message ?? e}`));
    return { ok: false, out };
  }
  out.push(zhEn('   ⚠️ 我只能確認「捷徑放好了」,**不能確認 Antigravity 真的載入了**。', '   ⚠️ All I can confirm is "the link is in place", **not that Antigravity actually loaded it**.'));
  out.push(zhEn('   下一個對話才會生效。驗證方法:', '   It takes effect from the next conversation. To check:'));
  out.push(zhEn('   隨便開一個 git 專案的新對話、讓 AI 執行一次工具（例如跑 agy-pipeline 或改一個檔），回來跑 agy-pipeline，',
    '   open a new conversation in any git project, have AI run a tool (for example agy-pipeline or editing a file), then run agy-pipeline;'));
  out.push(zhEn('   感測器那一行出現「最後一筆來自這裡的紀錄:N 分鐘前」,就是真的通了。', '   if the sensor line shows "Last record from here: N minutes ago", it really works.'));
  out.push(zhEn('   ⚠️ 之前用 --on 掛過 .agents/hooks.json 的專案會記兩次：到那個專案跑一次 agy-pipeline --on，會拆掉專案級掛載。',
    '   ⚠️ Projects hooked up earlier with --on in .agents/hooks.json will be recorded twice: run agy-pipeline --on once in each of them to remove the project-level hookup.'));
  return { ok: true, out };
}

export function uninstallPlugin(home = homedir()) {
  const link = pluginDir(home);
  try {
    if (!lstatSync(link).isSymbolicLink()) return { ok: false, out: [zhEn(`❌ ${link} 不是捷徑,不是我裝的,我不動它。`, `❌ ${link} isn't a link, so it wasn't installed by me, and I'm leaving it alone.`)] };
  } catch { return { ok: true, out: [zhEn('本來就沒裝。', 'It wasn\'t installed in the first place.')] }; }
  try {
    rmSync(link);
  } catch (e) {
    if (e?.code === 'EACCES' || e?.code === 'EPERM' || e?.code === 'EROFS') {
      return { ok: false, out: [zhEn(`❌ 拆不掉 ${link}（系統保護或沒有權限）——請在自己的終端機跑 agy-pipeline --uninstall。`, `❌ Can't remove ${link} (protected or no permission): run agy-pipeline --uninstall in your own terminal.`)] };
    }
    return { ok: false, out: [zhEn(`❌ 拆不掉 ${link}：${e?.message ?? e}`, `❌ Couldn't remove ${link}: ${e?.message ?? e}`)] };
  }
  return { ok: true, out: [zhEn(`✅ 拆掉了 ${link}。已經記下來的紀錄還在。`, `✅ Removed ${link}. The records already made are still there.`)] };
}

/** 退出記號：優先認 .agents/pipeline-monitor.off，相容 .claude/pipeline-monitor.off。 */
export function optOutState(root, mainRoot = null) {
  for (const d of [...new Set([root, mainRoot].filter(Boolean))]) {
    for (const rel of OFF_MARKERS) {
      const p = join(d, rel);
      if (!existsSync(p)) continue;
      let at = null;
      try { at = JSON.parse(readFileSync(p, 'utf8')).at ?? null; } catch { at = null; }
      return { path: p, at };
    }
  }
  return null;
}

/** 退出：放記號檔到主資料夾的 .agents/pipeline-monitor.off。 */
export function optOut(root, by = 'cli') {
  mkdirSync(join(root, '.agents'), { recursive: true });
  const p = join(root, OFF_MARKER);
  writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), by }) + '\n');
  return p;
}

/** 重新加入：把 .agents/ 與 .claude/ 的退出記號一併拿掉。 */
export function optIn(root, mainRoot = null) {
  const removed = [];
  for (const d of [...new Set([root, mainRoot].filter(Boolean))]) {
    for (const rel of OFF_MARKERS) {
      const p = join(d, rel);
      if (existsSync(p)) { rmSync(p); removed.push(p); }
    }
  }
  return removed;
}

/** 專案級／帳號級 hooks.json 掛載：這裡 → 主資料夾 → ~/.gemini/config。 */
function legacyMount(root, mainRoot, home) {
  const places = [
    ['here', root, false],
    ['main', mainRoot && mainRoot !== root ? mainRoot : null, false],
    ['user', home, true],
  ];
  for (const [where, dir, userLevel] of places) {
    if (!dir) continue;
    const ours = hookPathsIn(dir, { userLevel });
    if (!ours.length) continue;
    return { where, missing: [...new Set(ours.filter((p) => !existsSync(p)))] };
  }
  return null;
}

/** 檢查 plugin 目錄是否齊全（hooks.json 本身，加上其中接的每個腳本，以及 gate.sh/guard.sh 對應的 .mjs）。 */
function pluginMissingFiles(pluginRoot) {
  const hooksFile = join(pluginRoot, 'hooks.json');
  const { data, broken } = readHooksFile(hooksFile);
  if (!existsSync(hooksFile) || broken || !data) return [hooksFile];
  const required = new Set();
  for (const [k, v] of Object.entries(data)) {
    if (!isOurHookKey(k, v)) continue;
    for (const p of extractCommandPaths(v, pluginRoot)) {
      required.add(p);
      const base = basename(p);
      if (base === 'gate.sh') required.add(join(dirname(p), 'gate.mjs'));
      if (base === 'guard.sh') required.add(join(dirname(p), 'guard.mjs'));
    }
  }
  if (!required.size) return [hooksFile];
  return [...required].filter((p) => !existsSync(p));
}

/**
 * 掛上了沒——分三態（off / ok / broken），不准折成布林（P3）。
 */
export function mountState(root, mainRoot = null, home = homedir()) {
  const legacy = legacyMount(root, mainRoot, home);
  const plugin = pluginState(home);
  if (plugin.installed) {
    const alsoLegacy = legacy !== null;
    if (plugin.dangling || plugin.foreign) {
      return { state: 'broken', where: 'plugin', paths: [plugin.root], optedOut: null, alsoLegacy, dangling: plugin.dangling === true };
    }
    const off = optOutState(root, mainRoot);
    if (off) return { state: 'off', where: 'plugin', paths: [], optedOut: off, alsoLegacy };
    const missing = pluginMissingFiles(plugin.root);
    if (missing.length) return { state: 'broken', where: 'plugin', paths: missing, optedOut: null, alsoLegacy };
    return { state: 'ok', where: 'plugin', paths: [], optedOut: null, alsoLegacy };
  }
  if (!legacy) return { state: 'off', where: null, paths: [], optedOut: null, alsoLegacy: false };
  return legacy.missing.length
    ? { state: 'broken', where: legacy.where, paths: legacy.missing, optedOut: null, alsoLegacy: false }
    : { state: 'ok', where: legacy.where, paths: [], optedOut: null, alsoLegacy: false };
}

/** 感測器掛壞了要怎麼修：終端機、儀表板、--on 講同一句（老毛病 P2）。 */
export function mountFix(m) {
  if (m?.state !== 'broken') return null;
  if (m.where !== 'plugin') return zhEn('修法：在這個專案跑 agy-pipeline --on（會重新指到正確的位置）', 'To fix it: run agy-pipeline --on in this project (it points it back to the right place)');
  return m.dangling
    ? zhEn('修法：把 agy-pipeline 資料夾放回原位；或在它現在的資料夾裡在終端機跑 node status.mjs --install（會把捷徑換到現在的位置）',
      'To fix it: put the agy-pipeline folder back where it was, or run node status.mjs --install in your terminal from the folder where it is now (that moves the link to its current place)')
    : zhEn('修法：捷徑指向的資料夾不是完整的 agy-pipeline（找不到 plugin.json、hooks.json 或必要 hook 腳本），--install 不會動它——把這句給 AI 看',
      'To fix it: the folder the link points to isn\'t a complete agy-pipeline (plugin.json, hooks.json or required hook scripts can\'t be found), and --install won\'t touch it: show this line to AI');
}
