/**
 * mount.mjs —— 把感測器掛到一個專案上 / 拆下來
 *
 * ⚠️ 這支會**動使用者既有的設定檔**,是整個專案風險最高的一段。
 *    規格 docs/規劃中/sensor-install.md 列了三個必須處理的坑,全部在這裡:
 *      ① 那個檔案可能已經有別人的 hook → **合併,不是覆蓋**。弄丟別人的 hook 不可接受
 *      ② `.claude/` 在別的專案不一定 gitignore → 要講出來,不要默默裝下去
 *      ③ 裝完要**真的驗證**,不能印一句「安裝成功」就算——那是 R1 的假成功
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
export const HOOK_PATH = join(HERE, 'hook.sh');

/** 我們的 hook 長什麼樣。用完整路徑當指紋,`--off` 只拆掉這一種。 */
const command = () => `sh ${JSON.stringify(HOOK_PATH)}`;
const WIRING = [
  ['UserPromptSubmit', ''],
  ['PreToolUse', 'Skill'],
  ['PostToolUse', 'Skill'],
  ['PostToolUse', 'Edit|Write|NotebookEdit'],
];

const isOurs = (entry) =>
  (entry?.hooks ?? []).some((h) => typeof h?.command === 'string' && h.command.includes('pipeline-monitor'));

function settingsPath(root) { return join(root, '.claude', 'settings.local.json'); }

function readSettings(root) {
  const p = settingsPath(root);
  if (!existsSync(p)) return { data: {}, existed: false };
  try {
    return { data: JSON.parse(readFileSync(p, 'utf8')), existed: true };
  } catch (e) {
    // ⚠️ 讀不懂就**停手**。硬寫下去會把使用者原本的設定整個蓋掉。
    return { data: null, existed: true, broken: String(e.message) };
  }
}

/** `.claude/` 有沒有被 gitignore——沒有的話這個檔案會進版控,要講出來（坑②） */
function isIgnored(root) {
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '.claude/settings.local.json'],
      { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

export function mount(root) {
  const out = [];
  const { data, existed, broken } = readSettings(root);
  if (broken) {
    out.push(`❌ ${settingsPath(root)} 讀不懂（${broken}）。`);
    out.push('   為了不弄壞你原本的設定,這次不動它。請先修好那個檔案。');
    return { ok: false, out };
  }

  data.hooks ??= {};
  let added = 0, already = 0;
  for (const [evt, matcher] of WIRING) {
    data.hooks[evt] ??= [];
    // ⚠️ 合併不是覆蓋:別人的 hook 原封不動留著,我們只**加**自己的那一筆
    const dup = data.hooks[evt].some((e) => e.matcher === matcher && isOurs(e));
    if (dup) { already++; continue; }
    data.hooks[evt].push({ matcher, hooks: [{ type: 'command', command: command() }] });
    added++;
  }

  if (!added) {
    out.push(`✅ 這個專案已經掛上了（${already} 個接點都在）。`);
    return { ok: true, out, already: true };
  }

  mkdirSync(dirname(settingsPath(root)), { recursive: true });
  if (existed) {
    // 先備份。動別人的檔案之前一定要留退路。
    const bak = `${settingsPath(root)}.bak-${Date.now()}`;
    copyFileSync(settingsPath(root), bak);
    out.push(`   （原本的設定已備份到 ${bak.split('/').pop()}）`);
  }
  writeFileSync(settingsPath(root), JSON.stringify(data, null, 2) + '\n');

  out.unshift(`✅ 掛好了:加了 ${added} 個接點到 .claude/settings.local.json`);
  if (!isIgnored(root)) {
    // 坑②:講出來,不要默默裝下去
    out.push('');
    out.push('⚠️ 這個專案的 .claude/settings.local.json **沒有被 gitignore**,');
    out.push('   所以它會跟著你的程式一起被 commit 上去。');
    out.push('   不想要的話,在那個專案的 .gitignore 加一行:  .claude/settings.local.json');
  }
  out.push('');
  out.push('⚠️ 我只能確認「設定寫進去了」,**不能確認它真的會動**——');
  out.push('   Claude Code 讀不讀得到要它自己說了算(設定是對話開始時讀的,要開新的對話)。驗證方法:');
  out.push('   在那個資料夾開一個新對話、隨便打一句話,然後回來跑 pipeline-status,');
  out.push('   感測器那一行出現「最後一筆來自這裡的紀錄:N 分鐘前」,就是真的通了。');
  return { ok: true, out };
}

export function unmount(root) {
  const out = [];
  const { data, existed, broken } = readSettings(root);
  if (!existed) { out.push('這個專案本來就沒掛上。'); return { ok: true, out }; }
  if (broken) { out.push(`❌ 設定檔讀不懂,不動它。`); return { ok: false, out }; }

  let removed = 0;
  for (const evt of Object.keys(data.hooks ?? {})) {
    const before = data.hooks[evt].length;
    // ⚠️ 只拆掉指向 pipeline-monitor 的那幾筆,別人的一律不碰
    data.hooks[evt] = data.hooks[evt].filter((e) => !isOurs(e));
    removed += before - data.hooks[evt].length;
    if (!data.hooks[evt].length) delete data.hooks[evt];
  }
  if (!Object.keys(data.hooks ?? {}).length) delete data.hooks;

  if (!removed) { out.push('沒找到我們裝的接點,沒有東西要拆。'); return { ok: true, out }; }
  const bak = `${settingsPath(root)}.bak-${Date.now()}`;
  copyFileSync(settingsPath(root), bak);
  writeFileSync(settingsPath(root), JSON.stringify(data, null, 2) + '\n');
  out.push(`✅ 拆掉了 ${removed} 個接點。別人的 hook 沒有動。`);
  out.push(`   （動手前已備份到 ${bak.split('/').pop()}）`);
  out.push('⚠️ 已經記下來的紀錄還在,不會因為拆掉就消失。');
  out.push('   要一起清掉的話,刪 pipeline-monitor/logs/ 底下對應的檔案。');
  return { ok: true, out };
}

/**
 * 掛上了沒——而且**掛著不等於活著**。
 *
 * ⚠️ 2026-09-10 實測:把 pipeline-monitor 資料夾搬走之後,設定裡的 hook 路徑
 *    就指向一個不存在的檔案。而 hook.sh 刻意設計成「永不打擾 Claude」,
 *    所以它會**完全靜默地停止記錄**——設定看起來好好的,紀錄卻再也不會增加。
 *    那是這個專案最痛恨的那種失敗:看起來一切正常。
 *    所以這裡分三種狀態,呼叫端不准折成布林。
 *
 * ⚠️ 2026-09-11 第二次(方向相反):desktop app 開的 worktree **沒有自己的設定檔**,
 *    hook 是用主資料夾那份在跑,紀錄裡明明有這個工作區的事件,畫面卻說「沒掛上」(R1)。
 *    所以設定要往三個地方找:這個資料夾 → 主資料夾 → 帳號層級(~/.claude),找到哪一份就照實說。
 *    ⚠️ 但這只回答得了「掛在哪」,回答不了「活著嗎」——活著要看紀錄(status.mjs 的 describeSensor)。
 *
 * @param root      這個工作區
 * @param mainRoot  它所屬的主資料夾(不是 worktree 的話跟 root 一樣,可省略)
 * @param home      帳號層級設定所在(預設 ~;測試要傳一個空的假 home,否則這台機器的設定會影響結果)
 * @returns {{state:'off'|'ok'|'broken', where:'here'|'main'|'user'|null, paths:string[]}}
 */
export function mountState(root, mainRoot = null, home = homedir()) {
  const places = [
    ['here', root],
    ['main', mainRoot && mainRoot !== root ? mainRoot : null],
    ['user', home],
  ];
  for (const [where, dir] of places) {
    if (!dir) continue;
    const ours = hookPathsIn(dir);
    if (!ours.length) continue;
    const missing = [...new Set(ours.filter((p) => !existsSync(p)))];
    return missing.length ? { state: 'broken', where, paths: missing } : { state: 'ok', where, paths: [] };
  }
  return { state: 'off', where: null, paths: [] };
}

/** <dir>/.claude/ 底下兩份設定裡,我們的 hook 指向的檔案路徑。讀不到、讀不懂的檔案當沒有。 */
function hookPathsIn(dir) {
  const ours = [];
  for (const f of ['settings.local.json', 'settings.json']) {
    let data = null;
    try { data = JSON.parse(readFileSync(join(dir, '.claude', f), 'utf8')); } catch { continue; }
    for (const arr of Object.values(data?.hooks ?? {})) {
      for (const e of arr ?? []) {
        if (!isOurs(e)) continue;
        for (const h of e.hooks ?? []) {
          const m = String(h.command ?? '').match(/"([^"]+)"/);
          if (m) ours.push(m[1]);
        }
      }
    }
  }
  return ours;
}

export function isMounted(root, mainRoot = null, home = homedir()) {
  return mountState(root, mainRoot, home).state !== 'off';
}
