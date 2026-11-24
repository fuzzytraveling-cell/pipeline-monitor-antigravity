#!/usr/bin/env node
/**
 * escalate.mjs —— 分級動態往上升級通知（PreInvocation）。規格:tier-escalation-notify（路徑看 AGENTS.md 的表）
 *
 * 每次模型呼叫前檢查：若這一輪已設定分級且未退出記錄，因實際改動危險清單上的檔案或手動調高而升至最高級（預設 T2），
 * 且這一級要求的關卡／項目仍有未補齊（或問不到）者 → 於本輪第一次升上時寫入 tier_notified 並以純 systemMessage 注入提示，
 * 讓 AI 在下一步動手前即時知悉，不必拖到收工門禁才發現返工。
 *
 * ⚠️ 階段 0 本機實測契約：
 *   - 只輸出 {"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}，絕不帶 metadata.user_markdown（實測會被靜默丟棄）。
 *   - 子 agent inv=0 時 transcriptPath 尚未落地（ENOENT）且 lastUserInput === ""；僅真 ENOENT＋空輸入或 step 0 含 sender= 才放行。
 *   - 先寫入 tier_notified 成功才輸出 injectSteps；寫入失敗記 escalate_broken 並回 {}（防每步重複注入洗版）。
 *   - 非命中與任何錯誤一律輸出 {} 並 exit 0，絕不阻擋對話。
 */
import { readFileSync, appendFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { cardFor, sessionTier } from './lib/collect.mjs';
import { git, real, ago } from './lib/git.mjs';
import { logFileOf, RETAIN_DAYS } from './lib/events.mjs';
import { sessionsOf, runsPerStage } from './lib/rounds.mjs';
import { readTranscript } from './lib/transcript.mjs';
import { readTierConfig, RANKS, pendingRequirements } from './lib/tier.mjs';
import { optOutState } from './lib/mount.mjs';
import { commandFor as findCommand, pluginName } from './lib/skills.mjs';
import { ESCALATE_FILE, SENSOR_FILE, recordHeartbeat } from './lib/faults.mjs';
import { codeHome, dataDir, makeDataDir } from './lib/paths.mjs';
import { zhEn, readLang, withLang } from './lib/lang.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_DIR = codeHome(HERE);
const logDir = () => dataDir('logs', HERE);
const PLUGIN = pluginName(HERE);

function noteBroken(why, dir = logDir(), cwd = null) {
  try {
    makeDataDir(dir);
    appendFileSync(join(dir, SENSOR_FILE), JSON.stringify({
      ts: new Date().toISOString(),
      event: 'escalate_broken',
      why: String(why).slice(0, 200),
      ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
    }) + '\n');
  } catch { /* 連記都記不了就安靜放行，絕不鎖死對話 */ }
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

const fewFiles = (xs) => zhEn(
  xs.slice(0, 3).join('、') + (xs.length > 3 ? ` 等 ${xs.length} 個` : ''),
  xs.slice(0, 3).join(', ') + (xs.length > 3 ? ` and others (${xs.length} in all)` : ''),
);

/**
 * PreInvocation 專用的 subagent 過濾（階段 0 實測＋預審 #6，P6/P7/R1）：
 *   - transcriptPath 存在且為一般檔 → 讀 step 0 含 SYSTEM_MESSAGE ＋ sender= 才判為 subagent。
 *   - 明確捕捉 statSync 的 ENOENT 且 payload.lastUserInput === '' → subagent inv=0 轉錄檔尚未寫出，放行。
 *   - 缺 transcriptPath 或非 ENOENT 錯誤（如 EACCES）一律不誤判成 subagent，避免吞掉人類對話通知。
 */
export function isPreInvocationSubagent(payload, { read = readTranscript, stat = statSync } = {}) {
  if (!payload || typeof payload !== 'object') return false;
  const tp = typeof payload.transcriptPath === 'string' && payload.transcriptPath.trim() ? payload.transcriptPath.trim() : null;
  if (!tp) return false;
  let st;
  try {
    st = stat(tp);
  } catch (err) {
    return err?.code === 'ENOENT' && payload.lastUserInput === '';
  }
  if (!st?.isFile?.()) return false;
  const t = read(tp);
  return Boolean(t?.ok && t.isSubagent === true);
}

/** 解析工作區或子目錄／symlink 所屬的真實 git 根目錄（與 --tier／guard.mjs 一致，P2/P13）。 */
function repoOf(rawCwd) {
  if (typeof rawCwd !== 'string' || !rawCwd || !existsSync(rawCwd)) return null;
  const probeDir = real(rawCwd);
  const top = git(['rev-parse', '--show-toplevel'], probeDir);
  if (!top) return null;
  const root = real(top);
  const commonDir = git(['rev-parse', '--git-common-dir'], probeDir);
  const mainRoot = commonDir ? dirname(real(resolve(probeDir, commonDir))) : root;
  return { root, mainRoot, callerCwd: probeDir };
}

function pendingLine(m) {
  if (m.status === 'missing') {
    if (m.key === 'tests') {
      return zhEn('- 補測試（這一輪還沒新增或修改任何測試檔）', '- Add tests (no test file has been added or changed yet this round)');
    }
    if (m.isSpec) {
      return zhEn(`- ${m.label}（這一輪還沒有紀錄；可用 ${m.cmd} 寫規格，或用 agy-pipeline --spec <規格檔> 連結既有規格）`,
        `- ${m.label} (no record yet this round; run ${m.cmd} to write a spec, or agy-pipeline --spec <spec file> to link an existing one)`);
    }
    return zhEn(`- ${m.label}（這一輪還沒有紀錄 → 跑 ${m.cmd}）`,
      `- ${m.label} (no record yet this round → run ${m.cmd})`);
  }
  if (m.status === 'no-report') {
    const id = m.key.split(':')[0];
    return zhEn(`- ${m.label}（已叫過但還沒記結論，跑完請記 agy-pipeline --report ${id} ok|found "…"）`,
      `- ${m.label} (called, no conclusion recorded yet; when done, record with agy-pipeline --report ${id} ok|found "…")`);
  }
  if (m.status === 'ask') {
    return zhEn(`- ${m.label}（${m.why}；不要自己重跑，先停下來問使用者）`,
      `- ${m.label} (${m.why}; don't run again on your own, stop and ask the user first)`);
  }
  if (m.status === 'found') {
    return zhEn(`- ${m.label}（之前記了找到問題，還沒處理完）`,
      `- ${m.label} (recorded problems earlier, not handled yet)`);
  }
  if (m.key === 'tests') {
    return zhEn('- 補測試（問不到這次有沒有改到測試檔）', '- Add tests (couldn\'t check whether any test file changed this time)');
  }
  if (m.isSpec) {
    return zhEn(`- ${m.label}（有一筆規格連結分不出是哪個對話記的）`, `- ${m.label} (a spec link can't be traced to a conversation)`);
  }
  return zhEn(`- ${m.label}（問不到狀態）`, `- ${m.label} (couldn't check status)`);
}

/**
 * 純判斷函式（不寫檔，供測試直接呼叫）：回 null 表示不注入（輸出 {}）；
 * 否則回傳 { message, level, trigger, files, hadSpec, cpAt, originFrom, project, root, callerCwd, session, logDir }。
 */
export function evaluate({ payload, monitorDir = MONITOR_DIR, skillHome = undefined, home = undefined, read = readTranscript, stat = statSync } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  if (isPreInvocationSubagent(payload, { read, stat })) return null;

  const rawCwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd
    : (Array.isArray(payload.workspacePaths) && typeof payload.workspacePaths[0] === 'string' && payload.workspacePaths[0]) ? payload.workspacePaths[0] : null;
  const sid = typeof payload.conversationId === 'string' && payload.conversationId ? payload.conversationId
    : (typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null);
  if (!rawCwd || !sid) return null;

  const repo = repoOf(rawCwd);
  if (!repo) return null;
  const { root, mainRoot, callerCwd } = repo;
  if (optOutState(root, mainRoot)) return null;

  const cfg = readTierConfig(root, mainRoot, monitorDir);
  if (cfg.state !== 'ok') return null;

  const tp = typeof payload.transcriptPath === 'string' && payload.transcriptPath.trim() ? payload.transcriptPath.trim() : null;
  const extraTranscripts = tp ? new Map([[sid, tp]]) : null;
  const got = cardFor({ monitorDir, path: root, skillHome, extraTranscripts, sessionId: sid, ...(home ? { home } : {}) });
  if (!got || got.card.gone || got.card.notGit) return null;

  const shared = sessionsOf(got.events).find((s) => s.id === sid)?.sharesCwd === true;
  const mineNow = sessionTier({ card: got.card, events: got.events, stages: got.stages, session: sid, cwd: root, shared, monitorDir, mainRoot });
  const tier = mineNow.tier;
  if (!tier || tier.state !== 'ok') return null;
  if ((tier.final?.rank ?? 0) < RANKS.length - 1) return null;

  const dangerHits = tier.machine?.hits?.danger ?? [];
  const dangerId = tier.levels?.danger?.id ?? tier.final.id;
  const manualTop = tier.manual && tier.manual.id === dangerId ? tier.manual : null;
  const trigger = dangerHits.length ? 'danger' : manualTop ? 'manual' : null;
  if (!trigger) return null;

  const cmdOf = (sk) => (skillHome === undefined ? findCommand(sk, root, mainRoot, PLUGIN) : findCommand(sk, root, mainRoot, PLUGIN, skillHome));
  const pending = pendingRequirements({
    requires: tier.final?.requires ?? [],
    stages: got.stages,
    view: mineNow.view.stages,
    health: mineNow.health,
    tier,
    commandFor: cmdOf,
    ago,
  });
  if (!pending.length) return null;

  // 去重錨點（預審 #2/#3/#4）：對話級 mineNow.view?.origin?.at + 同 cwd 最後一次 tier_retracted，全數以 Date.parse 毫秒比較
  const originAt = mineNow.view?.origin?.at ?? null;
  const originFrom = mineNow.view?.origin?.from ?? null;
  const originMs = originAt ? Date.parse(originAt) : NaN;
  const cpAt = got.card?.checkpointRelation?.state === 'ok' ? (got.card.checkpoint?.at ?? null) : null;
  const lastRetractMs = got.events
    .filter((e) => e.event === 'tier_retracted' && e.cwd === root)
    .map((e) => Date.parse(e.ts))
    .filter(Number.isFinite)
    .reduce((m, t) => Math.max(m, t), -Infinity);
  const myNotifies = got.events
    .filter((e) => e.event === 'tier_notified' && e.session === sid && e.cwd === root && e.level === tier.final.id && Number.isFinite(Date.parse(e.ts)))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const lastNotify = myNotifies.at(-1) ?? null;
  const lastNotifyMs = lastNotify ? Date.parse(lastNotify.ts) : NaN;

  if (lastNotify && !(Number.isFinite(lastRetractMs) && lastNotifyMs <= lastRetractMs)) {
    if (!Number.isFinite(originMs)) return null;
    if (lastNotifyMs >= originMs) return null;
    if (originFrom !== 'A' && originFrom !== 'checkpoint'
        && lastNotify.originFrom !== 'A' && lastNotify.originFrom !== 'checkpoint'
        && (lastNotify.cpAt ?? null) === cpAt) {
      return null;
    }
    if (originFrom === 'A' && lastNotify.hadSpec === false && (lastNotify.cpAt ?? null) === cpAt) {
      const specStage = got.stages.find((s) => s.skill) ?? null;
      const aRuns = specStage ? (runsPerStage(got.events, [specStage], (e) => !e._subagent && e.session === sid).get(specStage.id) ?? []) : [];
      const hadEarlierABetween = aRuns.some((r) => {
        const t = Date.parse(r.ts);
        return Number.isFinite(t) && t > lastNotifyMs && t < originMs;
      });
      if (!hadEarlierABetween) return null;
    }
  }

  const whyText = trigger === 'danger'
    ? zhEn(`碰到危險清單：${fewFiles(dangerHits)}`, `touched the danger list: ${fewFiles(dangerHits)}`)
    : zhEn(`使用者手動調高（理由：${manualTop.why || '未填'}）`, `manually raised by the user (reason: ${manualTop.why || 'none given'})`);

  const missingSpec = pending.find((p) => p.isSpec && p.status === 'missing') ?? null;
  const closing = missingSpec
    ? zhEn(`因為這一輪還沒有規格或 --spec 連結，請先停下來告訴使用者這一輪已經升到 ${tier.final.id}，向使用者確認是要先補寫規格（${missingSpec.cmd}）還是連結既有規格（agy-pipeline --spec <規格檔>），再繼續改程式；不要等收工才補。`,
      `Because this round doesn't have a spec or --spec link yet, stop first, tell the user this round escalated to ${tier.final.id}, and ask whether to write a spec (${missingSpec.cmd}) or link an existing one (agy-pipeline --spec <spec file>) before continuing code edits; don't wait until wrapping up.`)
    : zhEn('請把以上剩餘項目一併納入這一輪的計畫處理（需先問人的項目勿擅自重跑），不必等收工被門禁攔下才補。',
      'Include the remaining items above in this round\'s plan (for items requiring user input, stop and ask first instead of running again on your own), rather than waiting for the closing hook to block you.');

  const message = [
    zhEn(`[產線監視器] 這一輪的分級已經升到 ${tier.final.id}（${whyText}）。這一級還缺／需確認的項目：`,
      `[Pipeline Monitor] This round's tier has escalated to ${tier.final.id} (${whyText}). Still missing or needs checking for this tier:`),
    ...pending.map(pendingLine),
    closing,
  ].join('\n');

  return {
    message,
    level: tier.final.id,
    trigger,
    files: dangerHits,
    hadSpec: !missingSpec,
    cpAt,
    originFrom,
    project: got.project,
    root,
    callerCwd,
    session: sid,
    logDir: got.logDir,
  };
}

function main() {
  const allow = () => { process.stdout.write('{}\n'); return 0; };
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    noteBroken('輸入不是合法 JSON');
    return allow();
  }
  const cwd = (typeof payload?.cwd === 'string' && payload.cwd) ? payload.cwd
    : (typeof payload?.workspacePaths?.[0] === 'string' && payload.workspacePaths[0]) ? payload.workspacePaths[0] : null;
  try {
    recordHeartbeat(logDir(), ESCALATE_FILE, cwd, { retainDays: RETAIN_DAYS });
  } catch { /* 心跳寫不了不影響正常對話 */ }

  let res = null;
  try {
    res = withLang(readLang().lang, () => evaluate({ payload }));
  } catch (e) {
    noteBroken(e?.message ?? e, undefined, cwd);
    return allow();
  }
  if (!res) return allow();

  // 先寫入 tier_notified 成功才輸出 injectSteps，寫入失敗則略過本次注入以防每步洗版（AC-2）
  try {
    const entry = {
      ts: new Date().toISOString(),
      event: 'tier_notified',
      session: cutBytes(res.session, 150),
      cwd: cutBytes(res.root, 300),
      ...(res.callerCwd && res.callerCwd !== res.root ? { caller_cwd: cutBytes(res.callerCwd, 300) } : {}),
      level: res.level,
      trigger: res.trigger,
      files: res.files.slice(0, 12).map((f) => cutBytes(f, 180)).filter(Boolean),
      hadSpec: res.hadSpec,
      ...(res.cpAt ? { cpAt: res.cpAt } : {}),
      ...(res.originFrom ? { originFrom: res.originFrom } : {}),
      source: 'escalate',
    };
    const dir = res.logDir ?? logDir();
    makeDataDir(dir);
    appendFileSync(logFileOf(dir, res.project), JSON.stringify(entry) + '\n');
  } catch (e) {
    noteBroken(`記不了 tier_notified：${e?.message ?? e}`, res.logDir ?? logDir(), cwd);
    return allow();
  }

  process.stdout.write(JSON.stringify({
    injectSteps: [{ systemMessage: { systemMessage: res.message } }],
  }) + '\n');
  return 0;
}

function isMain() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? ''); } catch { return false; }
}
if (isMain()) process.exit(main());
