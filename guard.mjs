#!/usr/bin/env node
/**
 * guard.mjs —— 改檔前把關（PreToolUse）。規格:danger-guard-force-ask（路徑看 AGENTS.md 的表）
 *
 * AI 呼叫寫／改檔工具（write_file、edit_file 等）前，依目標檔自己所屬的 git 專案查分級與危險清單：
 *   - 命中 tiers.danger → 回傳 {"decision":"force_ask","reason":"..."}（不受「總是允許」快取影響），並記一筆 guard_asked。
 *   - 分級設定檔讀不懂（broken）→ 同樣回傳 force_ask 講明讀不懂（R1），避免設定壞掉時靜默失去保護。
 *   - 其餘（非危險檔、專案外、非 git、unset、off、空危險清單、已退出記錄）或任何內部錯誤 →
 *     輸出 0 bytes（空輸出）並 exit 0，交回 Antigravity 原本權限（階段 0 實測確認：不可印 {}，也絕不印 "allow"）。
 *
 * ⚠️ 熱路徑原則：只問目標檔所屬 repo 的 rev-parse 與讀設定檔；絕不跑 git log、dangerSince、readTranscript 或 cardFor。
 */
import { readFileSync, appendFileSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { git, real } from './lib/git.mjs';
import { EDIT_TOOLS, loadStages } from './lib/rounds.mjs';
import { readTierConfig, computeTier, dangerRuleFor } from './lib/tier.mjs';
import { optOutState } from './lib/mount.mjs';
import { logFileOf, RETAIN_DAYS } from './lib/events.mjs';
import { GUARD_FILE, SENSOR_FILE, recordHeartbeat } from './lib/faults.mjs';
import { codeHome, dataDir, makeDataDir } from './lib/paths.mjs';
import { zhEn, readLang, withLang } from './lib/lang.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_DIR = codeHome(HERE);
const logDir = () => dataDir('logs', HERE);

function noteBroken(why, dir = logDir(), cwd = null) {
  try {
    makeDataDir(dir);
    appendFileSync(join(dir, SENSOR_FILE), JSON.stringify({
      ts: new Date().toISOString(),
      event: 'guard_broken',
      why: String(why).slice(0, 200),
      ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
    }) + '\n');
  } catch { /* 連記都記不了就靜默交回原權限，不鎖死編輯 */ }
}

function cutBytes(s, max) {
  if (typeof s !== 'string' || !s) return null;
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  const chars = [...s];
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(chars.slice(0, mid).join(''), 'utf8') <= max) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('');
}

const MAX_SYMLINK_HOPS = 40;

function lstatOrNull(p) {
  try { return lstatSync(p); } catch { return null; }
}

/**
 * 解析目標路徑（含既有檔、尚不存在的新檔、以及指向尚不存在目標的斷鏈符號連結，P6/R1）：
 * 往上找最近一個在檔案系統上存在（含斷鏈 symlink 本身）的節點；若是 symlink 就展開後重走（最多 40 跳防循環）。
 */
function resolveTargetPath(absTarget) {
  let current = resolve(absTarget);
  for (let hops = 0; hops <= MAX_SYMLINK_HOPS; hops++) {
    let cur = current;
    const tail = [];
    let st = lstatOrNull(cur);
    while (!st) {
      const parent = dirname(cur);
      if (parent === cur) return null;
      tail.unshift(basename(cur));
      cur = parent;
      st = lstatOrNull(cur);
    }
    if (st.isSymbolicLink()) {
      if (hops === MAX_SYMLINK_HOPS) return null;
      let linkTarget;
      try { linkTarget = readlinkSync(cur); } catch { return null; }
      const baseParent = real(dirname(cur));
      const nextBase = isAbsolute(linkTarget) ? resolve(linkTarget) : resolve(baseParent, linkTarget);
      current = tail.length ? join(nextBase, ...tail) : nextBase;
      continue;
    }
    const realBase = real(cur);
    let probeDir = dirname(realBase);
    try { if (statSync(realBase).isDirectory()) probeDir = realBase; } catch { /* 退回上層目錄 */ }
    const realTarget = tail.length ? join(realBase, ...tail) : realBase;
    return { realTarget, probeDir };
  }
  return null;
}

/** 依目標路徑所在目錄查它自己所屬的 git 專案（區分一般 repo 相對 .git 與 worktree 絕對路徑，P13）。 */
function repoOf(probeDir) {
  const commonDir = git(['rev-parse', '--git-common-dir'], probeDir);
  const top = git(['rev-parse', '--show-toplevel'], probeDir);
  if (!commonDir || !top) return null;
  const root = real(top);
  const absCommon = real(resolve(probeDir, commonDir));
  const mainRoot = dirname(absCommon);
  return {
    root,
    mainRoot,
    project: basename(mainRoot) || basename(root),
  };
}

function cfgDisplay(from, repo) {
  if (!from) return '.agents/pipeline-stages.json';
  const rFrom = real(from);
  for (const base of [repo.root, repo.mainRoot]) {
    const rel = relative(base, rFrom).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }
  return basename(from);
}

/**
 * 純判斷函式（不寫檔，供測試直接呼叫）：回 null 表示交回預設權限；
 * 否則回傳 { decision: 'force_ask', kind, reason, file, rule, level, project, root, cwd, callerCwd, session }。
 */
export function evaluate({ payload, monitorDir = MONITOR_DIR }) {
  if (!payload || typeof payload !== 'object') return null;
  const tool = payload.toolCall?.name;
  if (typeof tool !== 'string' || !EDIT_TOOLS.has(tool)) return null;
  const args = payload.toolCall?.args;
  const rawFile = args?.Path ?? args?.TargetFile ?? args?.AbsolutePath;
  if (typeof rawFile !== 'string' || !rawFile.trim()) return null;

  const cwd = (typeof payload.cwd === 'string' && payload.cwd) ? payload.cwd
    : (Array.isArray(payload.workspacePaths) && typeof payload.workspacePaths[0] === 'string' && payload.workspacePaths[0]) ? payload.workspacePaths[0] : null;
  const realCallerCwd = cwd ? real(cwd) : null;
  const absTarget = isAbsolute(rawFile) ? resolve(rawFile) : (realCallerCwd ? resolve(realCallerCwd, rawFile) : null);
  if (!absTarget) return null;

  const resolved = resolveTargetPath(absTarget);
  if (!resolved) return null;

  const repo = repoOf(resolved.probeDir);
  if (!repo) return null;

  const rel = relative(repo.root, resolved.realTarget).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;

  if (optOutState(repo.root, repo.mainRoot)) return null;

  const cfg = readTierConfig(repo.root, repo.mainRoot, monitorDir);
  const sid = typeof payload.conversationId === 'string' && payload.conversationId ? payload.conversationId
    : (typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null);

  if (cfg.state === 'unset' || cfg.state === 'off') return null;
  if (cfg.state === 'broken') {
    const cfgLabel = cfgDisplay(cfg.from, repo);
    const reason = zhEn(
      `[產線監視器] ${cfgLabel} 讀不懂，無法確認 ${rel} 是否在危險清單上。請確認是否允許這次修改，或先修好分級設定檔。`,
      `[Pipeline Monitor] Can't read ${cfgLabel}, so it's unknown whether ${rel} is on the danger list. Confirm whether to allow this edit, or fix the tier settings file first.`,
    );
    return {
      decision: 'force_ask',
      kind: 'config_broken',
      reason,
      file: rel,
      rule: null,
      level: null,
      project: repo.project,
      root: repo.root,
      cwd: repo.root,
      callerCwd: realCallerCwd,
      session: sid,
    };
  }
  if (cfg.state !== 'ok') return null;
  if (!cfg.config.danger.length) return null;

  const computed = computeTier([rel], cfg.config);
  if (!computed.hits.danger.length) return null;

  const rule = dangerRuleFor(rel, cfg.config.danger);
  const levelId = cfg.config.levels.danger.id;
  const stages = loadStages(monitorDir, repo.root, repo.mainRoot).stages;
  const reqIds = Array.isArray(cfg.config.levels.danger.requires) ? cfg.config.levels.danger.requires : [];
  const reqNames = reqIds.map((id) => {
    if (id === 'tests') return zhEn('補測試', 'add tests');
    const st = stages.find((s) => s.id === id);
    return st ? `${st.id} ${st.name}` : id;
  });
  const reqText = reqNames.join(zhEn('、', ', '));
  const reason = reqText
    ? zhEn(
        `[產線監視器] ${rel} 在危險清單上（${rule}），這次改動會升到 ${levelId}（收工前要求：${reqText}）。確認要讓 AI 改這個檔案嗎？`,
        `[Pipeline Monitor] ${rel} is on the danger list (${rule}), so this change goes up to ${levelId} (required before wrapping up: ${reqText}). Allow the AI to edit this file?`,
      )
    : zhEn(
        `[產線監視器] ${rel} 在危險清單上（${rule}），這次改動會升到 ${levelId}。確認要讓 AI 改這個檔案嗎？`,
        `[Pipeline Monitor] ${rel} is on the danger list (${rule}), so this change goes up to ${levelId}. Allow the AI to edit this file?`,
      );

  return {
    decision: 'force_ask',
    kind: 'danger',
    reason,
    file: rel,
    rule,
    level: levelId,
    project: repo.project,
    root: repo.root,
    cwd: repo.root,
    callerCwd: realCallerCwd,
    session: sid,
  };
}

function main() {
  // 階段 0 實測契約：非命中與錯誤一律 0 bytes 空輸出＋exit 0，絕不印 {} 或 "allow"
  const pass = () => 0;
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    noteBroken('輸入不是合法 JSON');
    return pass();
  }
  const cwd = (typeof payload?.cwd === 'string' && payload.cwd) ? payload.cwd
    : (typeof payload?.workspacePaths?.[0] === 'string' && payload.workspacePaths[0]) ? payload.workspacePaths[0] : null;
  try {
    recordHeartbeat(logDir(), GUARD_FILE, cwd, { retainDays: RETAIN_DAYS });
  } catch { /* 心跳寫不了不影響把關 */ }

  let res = null;
  try {
    res = withLang(readLang().lang, () => evaluate({ payload }));
  } catch (e) {
    noteBroken(e?.message ?? e, undefined, cwd);
    return pass();
  }
  if (!res) return pass();

  try {
    const entry = {
      ts: new Date().toISOString(),
      event: 'guard_asked',
      kind: res.kind,
      session: cutBytes(res.session, 150),
      cwd: cutBytes(res.root, 300),
      ...(res.callerCwd && res.callerCwd !== res.root ? { caller_cwd: cutBytes(res.callerCwd, 300) } : {}),
      file: cutBytes(res.file, 300),
      ...(res.rule ? { rule: cutBytes(res.rule, 200) } : {}),
      ...(res.level ? { level: res.level } : {}),
      source: 'guard',
    };
    const dir = logDir();
    makeDataDir(dir);
    appendFileSync(logFileOf(dir, res.project), JSON.stringify(entry) + '\n');
  } catch (e) {
    noteBroken(`記不了 guard_asked：${e?.message ?? e}`, undefined, cwd);
  }
  process.stdout.write(JSON.stringify({ decision: 'force_ask', reason: res.reason }) + '\n');
  return 0;
}

function isMain() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? ''); } catch { return false; }
}
if (isMain()) process.exit(main());
