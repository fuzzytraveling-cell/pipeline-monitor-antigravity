/**
 * retrospect.mjs —— 工地復盤官的純事實盤點（零自然語言猜測、零快取、純唯讀）。
 * 規格：retrospect-skill（路徑看 AGENTS.md 的表）
 *
 * 一次攤開兩塊事實供 AI（skills/retrospect/SKILL.md）與人類檢視：
 *   1. 專案文件與分級現況（已完成規格依內文 YYYY-MM-DD 穩定排序、FAILURE-PATTERNS.md、LESSONS.md、分級四態與消失路徑；獨立 worktree 同步對照 mainRoot 差異）
 *   2. 本專案近 90 天紀錄檔純統計與近期明細（相容無感測器 hook 但有 Node 結構化事件並存、揭露壞行／已恢復故障／無心跳、動態讀取關卡不寫死 D、共用 reportText 展開 noteFile）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { gitContext, real, ago } from './git.mjs';
import { RETAIN_DAYS } from './events.mjs';
import { loadEvents } from './transcript.mjs';
import {
  faultsNow, faultBanner, faultNotes, unreadableLine, sensorNow, sensorOffLine,
  gateHeartbeat, guardHeartbeat, gateLine, guardLine, sensorParts,
} from './faults.mjs';
import { optOutState, mountState, mountFix } from './mount.mjs';
import { moveState } from './paths.mjs';
import { loadStages, stagesBrokenLine, noRecordsWithin, isSensorBacked, reportText } from './rounds.mjs';
import { readTierConfig, dangerRuleFor, missingDanger } from './tier.mjs';
import { readDoneSpecs, readFailurePatternsSource, stripCodeFences } from './history.mjs';
import { HERE, LOG_DIR } from './cliFacts.mjs';
import { zhEn, plural, langBrokenLine, langUnreadableLine } from './lang.mjs';

export const DEFAULT_RETROSPECT_SPEC_LIMIT = 10;
export const DEFAULT_RETROSPECT_FOUND_LIMIT = 10;
export const DEFAULT_RETROSPECT_GUARD_LIMIT = 10;
const NOTE_PREVIEW_LINES = 3;
const NOTE_PREVIEW_CHARS = 220;

/**
 * 嚴格檢查整包 argv：只接受 --retrospect 與選填 --all，
 * 前後出現任何其他旗標或位置參數一律回 ok:false，防止誤混寫檔旗標（預審 #2，P2／P4）。
 */
export function parseRetrospectArgs(argv = []) {
  let seenMain = false;
  let all = false;
  const extra = [];
  for (const raw of Array.isArray(argv) ? argv : []) {
    const a = String(raw ?? '');
    if (a === '--retrospect') { seenMain = true; continue; }
    if (a === '--all') { all = true; continue; }
    extra.push(a);
  }
  if (!seenMain || extra.length > 0) {
    return { ok: false, all: false, extra };
  }
  return { ok: true, all, extra: [] };
}

/** 讀取專案教訓檔（優先 docs/LESSONS.md，相容 docs/references/LESSONS.md，對齊 skills/spec）。 */
export function readLessonsSource(root) {
  if (!root || !existsSync(root)) return { state: 'missing', rel: null, count: 0 };
  const candidates = ['docs/LESSONS.md', 'docs/references/LESSONS.md'];
  const hit = candidates.find((rel) => existsSync(join(root, rel)));
  if (!hit) return { state: 'missing', rel: null, count: 0 };
  let raw;
  try { raw = readFileSync(join(root, hit), 'utf8'); }
  catch { return { state: 'unreadable', rel: hit, count: 0 }; }
  const body = stripCodeFences(raw);
  const headings = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) headings.push(m[1].trim());
  }
  return { state: 'ok', rel: hit, count: headings.length, headings };
}

function summarizeTierSource(root, mainRoot, monitorDir) {
  const cfg = readTierConfig(root, mainRoot, monitorDir);
  if (cfg.state === 'ok') {
    const missing = missingDanger(root, cfg.config.danger);
    return {
      state: 'ok',
      from: cfg.from ?? null,
      code: cfg.config.code,
      danger: cfg.config.danger,
      levels: cfg.config.levels,
      checked: cfg.config.checked ?? null,
      missing,
    };
  }
  if (cfg.state === 'off') {
    return { state: 'off', from: cfg.from ?? null, off: cfg.off ?? null };
  }
  if (cfg.state === 'broken') {
    return { state: 'broken', from: cfg.from ?? null, why: cfg.why ?? null };
  }
  return { state: 'unset', from: cfg.from ?? null };
}

function canReadFile(p) {
  try { readFileSync(p, 'utf8'); return true; }
  catch { return false; }
}

function summarizeReportNote(rep, { all = false } = {}) {
  const full = String(reportText(rep) ?? '').trim();
  if (!full) return { lines: [], truncatedLines: 0, truncatedChars: false };
  const rawLines = full.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  if (all) return { lines: rawLines, truncatedLines: 0, truncatedChars: false };

  // 若 noteFile 遺失，reportText 最後一行會帶遺失警告，預覽時必須保留該警告行不截掉（R1）
  const hasMissingTail = Boolean(rep?.noteFile) && rawLines.length > 1 && !canReadFile(rep.noteFile);
  const bodyLines = hasMissingTail ? rawLines.slice(0, -1) : rawLines;
  const kept = bodyLines.slice(0, NOTE_PREVIEW_LINES);
  let truncatedChars = false;
  const trimmedKept = kept.map((line) => {
    const chars = [...line];
    if (chars.length <= NOTE_PREVIEW_CHARS) return line;
    truncatedChars = true;
    return `${chars.slice(0, NOTE_PREVIEW_CHARS).join('')}…`;
  });
  if (hasMissingTail) trimmedKept.push(rawLines.at(-1));
  return {
    lines: trimmedKept,
    truncatedLines: Math.max(0, bodyLines.length - kept.length),
    truncatedChars,
  };
}

function isoDatePrefix(ts) {
  const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 收集純唯讀復盤事實（不修改任何檔案、不跑額外 git log），方便測試直接檢查結構與格式化。
 */
export function collectRetrospectFacts(ctx, {
  monitorDir = HERE,
  logDir = LOG_DIR,
  home = undefined,
  all = false,
  specLimit = DEFAULT_RETROSPECT_SPEC_LIMIT,
  foundLimit = DEFAULT_RETROSPECT_FOUND_LIMIT,
  guardLimit = DEFAULT_RETROSPECT_GUARD_LIMIT,
  now = Date.now(),
} = {}) {
  const realRoot = real(ctx.root);
  const realMain = ctx.mainRoot ? real(ctx.mainRoot) : realRoot;
  const inWorktree = Boolean(ctx.mainRoot && realMain && realRoot && realMain !== realRoot && existsSync(ctx.mainRoot));

  const specs = readDoneSpecs(ctx.root);
  const fp = readFailurePatternsSource(ctx.root);
  const lessons = readLessonsSource(ctx.root);
  const tier = summarizeTierSource(ctx.root, ctx.mainRoot, monitorDir);

  let mainDiff = null;
  if (inWorktree) {
    const mainSpecs = readDoneSpecs(ctx.mainRoot);
    const specsPartialUnreadable = Boolean(
      specs.unreadableDirs.length || specs.unreadableFiles.length
      || mainSpecs.unreadableDirs.length || mainSpecs.unreadableFiles.length,
    );
    let specsDiffState = 'same';
    let extraMainSpecs = [];
    if (specs.state === 'unreadable' || mainSpecs.state === 'unreadable') {
      specsDiffState = 'unreadable';
    } else {
      const hereSpecNames = new Set(specs.docs.map((d) => d.name));
      const hereUnreadableSpecNames = new Set(
        specs.unreadableFiles.map((f) => f.split('/').pop().replace(/\.md$/i, '')),
      );
      extraMainSpecs = mainSpecs.docs.filter((d) => !hereSpecNames.has(d.name) && !hereUnreadableSpecNames.has(d.name));
      specsDiffState = extraMainSpecs.length ? 'extra' : 'same';
    }

    const mainFp = readFailurePatternsSource(ctx.mainRoot);
    let fpDiffState = 'same';
    let extraMainFp = [];
    if (fp.state === 'unreadable' || mainFp.state === 'unreadable') {
      fpDiffState = 'unreadable';
    } else {
      const hereFpKeys = new Set(fp.sections.map((s) => s.id || s.title));
      extraMainFp = mainFp.sections.filter((s) => !hereFpKeys.has(s.id || s.title));
      fpDiffState = extraMainFp.length ? 'extra' : 'same';
    }

    const mainLessons = readLessonsSource(ctx.mainRoot);
    let lessonsDiffState = 'same';
    let extraMainLessons = [];
    if (lessons.state === 'unreadable' || mainLessons.state === 'unreadable') {
      lessonsDiffState = 'unreadable';
    } else if (lessons.state === 'missing' && mainLessons.state === 'ok') {
      lessonsDiffState = 'main-only';
      extraMainLessons = mainLessons.headings ?? [];
    } else if (lessons.state === 'ok' && mainLessons.state === 'ok') {
      const hereLessonSet = new Set(lessons.headings ?? []);
      extraMainLessons = (mainLessons.headings ?? []).filter((h) => !hereLessonSet.has(h));
      lessonsDiffState = extraMainLessons.length ? 'extra' : 'same';
    }

    const mainTier = summarizeTierSource(ctx.mainRoot, ctx.mainRoot, monitorDir);
    const extraMainDanger = tier.state === 'ok' && mainTier.state === 'ok'
      ? mainTier.danger.filter((d) => !new Set(tier.danger).has(d))
      : [];

    mainDiff = {
      mainRoot: ctx.mainRoot,
      specsDiffState,
      specsPartialUnreadable,
      extraSpecsCount: extraMainSpecs.length,
      extraSpecs: extraMainSpecs.slice(0, all ? extraMainSpecs.length : specLimit).map(({ rel, name, date }) => ({ rel, name, date })),
      fpDiffState,
      extraFpCount: extraMainFp.length,
      extraFp: extraMainFp.map(({ id, title }) => ({ id, title })),
      mainLessonsState: mainLessons.state,
      lessonsDiffState,
      extraLessonsCount: extraMainLessons.length,
      extraLessons: extraMainLessons,
      mainTierState: mainTier.state,
      mainDanger: mainTier.state === 'ok' ? mainTier.danger : [],
      extraMainDanger,
    };
  }

  const { stages, broken: stagesBroken = null, brokenFrom: stagesBrokenFrom = null } = loadStages(monitorDir, ctx.root, ctx.mainRoot);
  const optedOut = Boolean(optOutState(ctx.root, ctx.mainRoot));
  // ⚠️ 第三參數是使用者家目錄（home），絕不能傳入程式資料夾 monitorDir，否則會把已裝好的 plugin 誤判為未掛上或漏偵測斷鏈（P11/P3/R1）
  const mount = home === undefined ? mountState(ctx.root, ctx.mainRoot) : mountState(ctx.root, ctx.mainRoot, home);
  const ev = loadEvents(logDir, ctx.project, home === undefined ? {} : { home });
  const faults = faultsNow(logDir, { retainDays: RETAIN_DAYS, now, move: moveState() });
  const gateHb = gateHeartbeat(logDir);
  const guardHb = guardHeartbeat(logDir);

  const events = Array.isArray(ev.events) ? ev.events : [];
  const rawEvents = events.filter((e) => e && !e._fromTranscript && !e._fromFallback && !e._fromSubagent);
  // 與 noRecordsWithin(ev) 共用同一個 isSensorBacked 口徑（排除 _subagent／轉錄檔補入，P2）
  const sensorEvents = events.filter(isSensorBacked);
  const noSensorWithin = noRecordsWithin(ev);

  let earliestTs = null;
  let latestTs = null;
  let earliestMs = Infinity;
  let latestMs = -Infinity;
  let lastHereSensorTs = null;
  let lastHereSensorMs = -Infinity;
  const projectCwds = new Set([ctx.root, ...(inWorktree && ctx.mainRoot ? [ctx.mainRoot] : [])]);
  const underBase = (cwd, base) => Boolean(base) && (cwd === base || cwd.startsWith(`${base}/`));
  const inProjectCwd = (cwd) => {
    const rCwd = real(cwd);
    return underBase(cwd, ctx.root) || underBase(cwd, realRoot)
      || (rCwd && (underBase(rCwd, realRoot) || (inWorktree && underBase(rCwd, realMain))))
      || (inWorktree && (underBase(cwd, ctx.mainRoot) || underBase(cwd, realMain)));
  };
  for (const e of rawEvents) {
    if (typeof e?.cwd === 'string' && e.cwd) projectCwds.add(e.cwd);
    const t = typeof e?.ts === 'string' ? Date.parse(e.ts) : NaN;
    if (!Number.isFinite(t)) continue;
    if (t < earliestMs) { earliestMs = t; earliestTs = e.ts; }
    if (t > latestMs) { latestMs = t; latestTs = e.ts; }
    if (isSensorBacked(e) && typeof e.cwd === 'string' && inProjectCwd(e.cwd)) {
      if (t > lastHereSensorMs) { lastHereSensorMs = t; lastHereSensorTs = e.ts; }
    }
  }

  // 1) spec_precheck
  const precheckAll = events.filter((e) => e?.event === 'spec_precheck');
  let precheckFoundCount = 0;
  let precheckOkCount = 0;
  let precheckOtherCount = 0;
  const precheckFoundList = [];
  for (const e of precheckAll) {
    if (e.verdict === 'found') { precheckFoundCount++; precheckFoundList.push(e); }
    else if (e.verdict === 'ok') precheckOkCount++;
    else precheckOtherCount++;
  }
  precheckFoundList.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
  const pCap = all ? precheckFoundList.length : foundLimit;
  const precheckFoundShown = precheckFoundList.slice(0, pCap).map((e) => ({
    ts: e.ts ?? null,
    date: isoDatePrefix(e.ts),
    specs: Array.isArray(e.specs) && e.specs.length ? e.specs.filter((s) => typeof s === 'string' && s.trim()) : null,
    summary: summarizeReportNote(e, { all }),
  }));

  // 2) stage_report（動態依關卡分組，並保留不在目前 stages.json 的歷史舊關卡代號，預審 #3）
  const stageReportAll = events.filter((e) => e?.event === 'stage_report');
  const byStageMap = new Map();
  const stageOrder = new Map(stages.map((s, idx) => [s.id, { idx, name: s.name, current: true }]));
  const stageReportFoundList = [];
  for (const e of stageReportAll) {
    const id = typeof e.stage === 'string' && e.stage.trim() ? e.stage.trim() : '?';
    if (!byStageMap.has(id)) {
      const meta = stageOrder.get(id) ?? null;
      byStageMap.set(id, {
        id,
        name: meta ? meta.name : null,
        current: Boolean(meta),
        order: meta ? meta.idx : Number.MAX_SAFE_INTEGER,
        found: 0,
        ok: 0,
        other: 0,
      });
    }
    const bucket = byStageMap.get(id);
    if (e.verdict === 'found') { bucket.found++; stageReportFoundList.push({ ...e, _stageId: id, _stageName: bucket.name }); }
    else if (e.verdict === 'ok') bucket.ok++;
    else bucket.other++;
  }
  const stageBuckets = [...byStageMap.values()].sort((a, b) => (
    a.order !== b.order ? a.order - b.order : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  ));
  stageReportFoundList.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
  const rCap = all ? stageReportFoundList.length : foundLimit;
  const stageFoundShown = stageReportFoundList.slice(0, rCap).map((e) => ({
    ts: e.ts ?? null,
    date: isoDatePrefix(e.ts),
    stageId: e._stageId,
    stageName: e._stageName,
    currentStage: stageOrder.has(e._stageId),
    summary: summarizeReportNote(e, { all }),
  }));

  // 3) gate_blocked
  const gateBlockedAll = events.filter((e) => e?.event === 'gate_blocked');
  const missingCounts = new Map();
  let gateUnlabeled = 0;
  for (const e of gateBlockedAll) {
    const arr = Array.isArray(e.missing) ? e.missing.filter((x) => typeof x === 'string' && x.trim()) : [];
    if (!arr.length) { gateUnlabeled++; continue; }
    for (const k of arr) missingCounts.set(k, (missingCounts.get(k) ?? 0) + 1);
  }
  const gateMissing = [...missingCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // 4) guard_asked（以 dangerRuleFor 支援資料夾規則，並區分分級非 ok 狀態，預審 #4）
  const guardAskedAll = events.filter((e) => e?.event === 'guard_asked');
  let guardConfigBroken = 0;
  let guardDangerTotal = 0;
  let guardOtherKind = 0;
  const guardByFile = new Map();
  for (const e of guardAskedAll) {
    if (e.kind === 'config_broken') { guardConfigBroken++; continue; }
    if (e.kind === 'danger') {
      guardDangerTotal++;
      const f = typeof e.file === 'string' && e.file.trim() ? e.file.trim() : '';
      guardByFile.set(f, (guardByFile.get(f) ?? 0) + 1);
      continue;
    }
    guardOtherKind++;
  }
  const guardFilesAll = [...guardByFile.entries()]
    .map(([file, count]) => {
      let status = 'unknown-tier';
      let rule = null;
      let onMainDanger = false;
      if (!file) {
        status = 'no-file-field';
      } else if (tier.state === 'ok') {
        rule = dangerRuleFor(file, tier.danger);
        status = rule ? 'in-danger' : 'not-in-danger';
      } else {
        status = tier.state; // 'unset' | 'off' | 'broken'
      }
      if (file && mainDiff?.mainTierState === 'ok') {
        onMainDanger = dangerRuleFor(file, mainDiff.mainDanger) !== null;
      }
      return { file, count, status, rule, onMainDanger };
    })
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const gCap = all ? guardFilesAll.length : guardLimit;
  const guardFilesShown = guardFilesAll.slice(0, gCap);

  const structuredTotal = precheckAll.length + stageReportAll.length + gateBlockedAll.length + guardAskedAll.length;
  const specsCap = all ? specs.docs.length : specLimit;

  return {
    project: ctx.project,
    root: ctx.root,
    mainRoot: ctx.mainRoot ?? null,
    inWorktree,
    all,
    docs: {
      specs: {
        state: specs.state,
        totalDocs: specs.docs.length,
        shownDocs: specs.docs.slice(0, specsCap).map(({ rel, name, title, date }) => ({ rel, name, title, date })),
        unreadableDirs: specs.unreadableDirs,
        unreadableFiles: specs.unreadableFiles,
      },
      fp: {
        state: fp.state,
        totalSections: fp.sections.length,
        sections: fp.sections.map(({ id, title }) => ({ id, title })),
      },
      lessons,
      tier,
      mainDiff,
    },
    records: {
      retainDays: RETAIN_DAYS,
      evState: ev.state,
      totalEvents: rawEvents.length,
      sensorCount: sensorEvents.length,
      noSensorWithin,
      structuredTotal,
      earliestTs,
      latestTs,
      lastHereSensorTs,
      projectCwds: [...projectCwds],
      optedOut,
      mount,
      faults,
      gateHb,
      guardHb,
      stagesBroken,
      stagesBrokenFrom,
      precheck: {
        total: precheckAll.length,
        found: precheckFoundCount,
        ok: precheckOkCount,
        other: precheckOtherCount,
        shownFound: precheckFoundShown,
      },
      stageReports: {
        total: stageReportAll.length,
        totalFound: stageReportFoundList.length,
        buckets: stageBuckets,
        shownFound: stageFoundShown,
      },
      gateBlocked: {
        total: gateBlockedAll.length,
        unlabeled: gateUnlabeled,
        missing: gateMissing,
      },
      guardAsked: {
        total: guardAskedAll.length,
        configBroken: guardConfigBroken,
        dangerTotal: guardDangerTotal,
        otherKind: guardOtherKind,
        totalFiles: guardFilesAll.length,
        shownFiles: guardFilesShown,
      },
    },
  };
}

function formatDocSection(facts) {
  const L = [];
  const { docs, inWorktree, root, all } = facts;
  L.push(zhEn('━━ 1. 專案文件與分級現況 ━━', '━━ 1. Project docs & tier setup ━━'));
  if (inWorktree && docs.mainDiff) {
    L.push(zhEn(
      `   📍 目前位於獨立 worktree（${root}）；主資料夾為 ${docs.mainDiff.mainRoot}。`,
      `   📍 Running inside an independent worktree (${root}); main folder is ${docs.mainDiff.mainRoot}.`,
    ));
  }

  // 已完成規格
  const sp = docs.specs;
  if (sp.state === 'no-dir') {
    L.push(zhEn(
      '   ▸ 已完成規格：找不到已完成規格資料夾（docs/升級摘要/ 或 docs/done/）。',
      '   ▸ Completed specs: completed-specs folder (docs/done/ or the Chinese equivalent) was not found.',
    ));
  } else if (sp.state === 'empty') {
    L.push(zhEn(
      '   ▸ 已完成規格：資料夾存在，但裡面還沒有任何 .md 規格檔。',
      '   ▸ Completed specs: folder exists, but no .md spec files are inside yet.',
    ));
  } else if (sp.state === 'unreadable') {
    L.push(zhEn(
      '   ▸ 已完成規格：讀不到已完成規格資料夾或裡面的檔案。',
      '   ▸ Completed specs: couldn\'t read the completed-specs folder or its files.',
    ));
  } else {
    const more = sp.shownDocs.length < sp.totalDocs
      ? zhEn(`（共 ${sp.totalDocs} 份，列最近 ${sp.shownDocs.length} 份${all ? '' : '；加 --all 列全部'}）`,
        ` (${sp.totalDocs} in all, showing latest ${sp.shownDocs.length}${all ? '' : '; add --all for all'})`)
      : zhEn(`（共 ${sp.totalDocs} 份）`, ` (${sp.totalDocs} in all)`);
    L.push(zhEn(`   ▸ 已完成規格${more}：`, `   ▸ Completed specs${more}:`));
    for (const d of sp.shownDocs) {
      L.push(`      - ${d.rel}${d.date ? ` (${d.date})` : zhEn('（內文無日期）', ' (no date in body)')}`);
    }
  }
  if (sp.unreadableDirs?.length) {
    const dirs = sp.unreadableDirs.map((x) => x.dir).join(zhEn('、', ', '));
    L.push(zhEn(
      `      ⚠️ 有 ${sp.unreadableDirs.length} 個規格資料夾讀不到：${dirs}`,
      `      ⚠️ Couldn't read ${plural(sp.unreadableDirs.length, 'spec folder')}: ${dirs}`,
    ));
  }
  if (sp.unreadableFiles?.length) {
    const shown = sp.unreadableFiles.slice(0, 5).join(zhEn('、', ', '));
    const tail = sp.unreadableFiles.length > 5 ? zhEn(` 等 ${sp.unreadableFiles.length} 份`, ` and others (${sp.unreadableFiles.length} in all)`) : '';
    L.push(zhEn(
      `      ⚠️ 有 ${sp.unreadableFiles.length} 份規格檔讀不到（未列入）：${shown}${tail}`,
      `      ⚠️ Couldn't read ${plural(sp.unreadableFiles.length, 'spec file')} (omitted): ${shown}${tail}`,
    ));
  }
  if (docs.mainDiff?.specsDiffState === 'unreadable') {
    L.push(zhEn(
      '      ⚠️ 主資料夾或此 worktree 的已完成規格資料夾無法讀取，無法比對兩邊規格差異。',
      '      ⚠️ Couldn\'t read the completed-specs folder in the main folder or this worktree, so their specs couldn\'t be compared.',
    ));
  } else {
    if (docs.mainDiff?.extraSpecsCount > 0) {
      const names = docs.mainDiff.extraSpecs.map((s) => `${s.name}${s.date ? ` (${s.date})` : ''}`).join(zhEn('、', ', '));
      const more = docs.mainDiff.extraSpecs.length < docs.mainDiff.extraSpecsCount
        ? zhEn(` 等共 ${docs.mainDiff.extraSpecsCount} 份`, ` and others (${docs.mainDiff.extraSpecsCount} in all)`)
        : '';
      L.push(zhEn(
        `      ⚠️ 主資料夾另有 ${docs.mainDiff.extraSpecsCount} 份已完成規格尚未同步到此 worktree：${names}${more}`,
        `      ⚠️ Main folder has ${plural(docs.mainDiff.extraSpecsCount, 'additional completed spec')} not yet in this worktree: ${names}${more}`,
      ));
    }
    if (docs.mainDiff?.specsPartialUnreadable) {
      L.push(zhEn(
        '      ⚠️ 主資料夾或此 worktree 有部分規格檔／資料夾讀不到，兩邊差異比對可能不完整。',
        '      ⚠️ Some spec files or folders in the main folder or this worktree couldn\'t be read, so the diff between them might be incomplete.',
      ));
    }
  }

  // FAILURE-PATTERNS.md
  const fp = docs.fp;
  if (fp.state === 'missing') {
    L.push(zhEn(
      '   ▸ 已知死法清單（docs/FAILURE-PATTERNS.md）：找不到（復盤對照退回三條通用判準 R1–R3，亦可提議新建）。',
      '   ▸ Known failure patterns (docs/FAILURE-PATTERNS.md): not found (fall back to the three general rules R1-R3; creating one may be proposed).',
    ));
  } else if (fp.state === 'unreadable') {
    L.push(zhEn(
      '   ▸ 已知死法清單（docs/FAILURE-PATTERNS.md）：讀不到（可能沒有權限）。',
      '   ▸ Known failure patterns (docs/FAILURE-PATTERNS.md): couldn\'t read (possibly no permission).',
    ));
  } else if (fp.state === 'no-sections') {
    L.push(zhEn(
      '   ▸ 已知死法清單（docs/FAILURE-PATTERNS.md）：檔案存在，但找不到任何 ## 分段標題。',
      '   ▸ Known failure patterns (docs/FAILURE-PATTERNS.md): file exists, but no ## section headings were found.',
    ));
  } else {
    const ids = fp.sections.map((s) => (s.id ? s.id : s.title)).join(zhEn('、', ', '));
    L.push(zhEn(
      `   ▸ 已知死法清單（docs/FAILURE-PATTERNS.md）：共 ${fp.totalSections} 條（${ids}）`,
      `   ▸ Known failure patterns (docs/FAILURE-PATTERNS.md): ${plural(fp.totalSections, 'section')} (${ids})`,
    ));
  }
  if (docs.mainDiff?.fpDiffState === 'unreadable') {
    L.push(zhEn(
      '      ⚠️ 主資料夾或此 worktree 的 FAILURE-PATTERNS.md 無法讀取，無法比對兩邊條目差異。',
      '      ⚠️ Couldn\'t read FAILURE-PATTERNS.md in the main folder or this worktree, so their sections couldn\'t be compared.',
    ));
  } else if (docs.mainDiff?.extraFpCount > 0) {
    const extra = docs.mainDiff.extraFp.map((s) => (s.id ? `${s.id} ${s.title}` : s.title)).join(zhEn('；', '; '));
    L.push(zhEn(
      `      ⚠️ 主資料夾的 FAILURE-PATTERNS.md 另有 ${docs.mainDiff.extraFpCount} 條尚未同步到此 worktree：${extra}`,
      `      ⚠️ Main folder's FAILURE-PATTERNS.md has ${plural(docs.mainDiff.extraFpCount, 'additional section')} not yet in this worktree: ${extra}`,
    ));
  }

  // LESSONS.md
  const ls = docs.lessons;
  if (ls.state === 'missing') {
    L.push(zhEn(
      '   ▸ 教訓紀錄（docs/LESSONS.md）：找不到。',
      '   ▸ Lessons log (docs/LESSONS.md): not found.',
    ));
  } else if (ls.state === 'unreadable') {
    L.push(zhEn(
      `   ▸ 教訓紀錄（${ls.rel}）：讀不到（可能沒有權限）。`,
      `   ▸ Lessons log (${ls.rel}): couldn't read (possibly no permission).`,
    ));
  } else {
    L.push(zhEn(
      `   ▸ 教訓紀錄（${ls.rel}）：可讀（共 ${ls.count} 個 ## 段落）`,
      `   ▸ Lessons log (${ls.rel}): readable (${plural(ls.count, '## section')})`,
    ));
  }
  if (docs.mainDiff?.lessonsDiffState === 'unreadable') {
    L.push(zhEn(
      '      ⚠️ 主資料夾或此 worktree 的教訓紀錄無法讀取，無法比對兩邊段落差異。',
      '      ⚠️ Couldn\'t read the lessons log in the main folder or this worktree, so their sections couldn\'t be compared.',
    ));
  } else if (docs.mainDiff?.lessonsDiffState === 'main-only') {
    L.push(zhEn(
      `      ⚠️ 主資料夾有可讀的教訓紀錄檔（共 ${docs.mainDiff.extraLessonsCount} 個段落），此 worktree 尚未同步。`,
      `      ⚠️ Main folder has a readable lessons log (${plural(docs.mainDiff.extraLessonsCount, 'section')}) not yet synced to this worktree.`,
    ));
  } else if (docs.mainDiff?.lessonsDiffState === 'extra' && docs.mainDiff.extraLessonsCount > 0) {
    L.push(zhEn(
      `      ⚠️ 主資料夾的教訓紀錄另有 ${docs.mainDiff.extraLessonsCount} 個段落尚未同步到此 worktree。`,
      `      ⚠️ Main folder's lessons log has ${plural(docs.mainDiff.extraLessonsCount, 'additional section')} not yet in this worktree.`,
    ));
  }

  // 分級現況
  const tr = docs.tier;
  if (tr.state === 'unset') {
    L.push(zhEn(
      '   ▸ 分級設定：這個專案還沒設定分級。',
      '   ▸ Tier setup: this project hasn\'t set up tiers.',
    ));
  } else if (tr.state === 'off') {
    const why = tr.off?.why ? zhEn(`（理由：${tr.off.why}）`, ` (reason: ${tr.off.why})`) : '';
    L.push(zhEn(
      `   ▸ 分級設定：這個專案設定成不分級${why}。`,
      `   ▸ Tier setup: this project is set to not use tiers${why}.`,
    ));
  } else if (tr.state === 'broken') {
    L.push(zhEn(
      `   ▸ 分級設定：⚠️ 設定檔讀不懂（${tr.why ?? ''}）。`,
      `   ▸ Tier setup: ⚠️ settings file can't be read (${tr.why ?? ''}).`,
    ));
  } else {
    const codeText = tr.code.join(zhEn('、', ', '));
    const dangerText = tr.danger.length
      ? zhEn(`共 ${tr.danger.length} 條（${tr.danger.join('、')}）`, `${plural(tr.danger.length, 'entry', 'entries')} (${tr.danger.join(', ')})`)
      : zhEn('空的（永遠不會出現第三級）', 'empty (the third level will never come up)');
    L.push(zhEn(
      `   ▸ 分級設定：程式區 [${codeText}] · 危險清單 ${dangerText}`,
      `   ▸ Tier setup: code area [${codeText}] · danger list ${dangerText}`,
    ));
    if (tr.checked?.at) {
      const who = tr.checked.by === 'human'
        ? zhEn('使用者親記', 'recorded by user')
        : zhEn('AI 代記', 'AI recorded it for them');
      const said = tr.checked.said ? zhEn(`：「${tr.checked.said}」`, `: "${tr.checked.said}"`) : '';
      L.push(zhEn(
        `      上次危險清單確認：${isoDatePrefix(tr.checked.at) ?? tr.checked.at}（${ago(tr.checked.at)}，${who}${said}）`,
        `      Last danger-list check: ${isoDatePrefix(tr.checked.at) ?? tr.checked.at} (${ago(tr.checked.at)}, ${who}${said})`,
      ));
    }
    if (tr.missing?.length) {
      L.push(zhEn(
        `      ⚠️ 危險清單裡有 ${tr.missing.length} 個路徑在此工作區已經不存在：${tr.missing.join('、')}`,
        `      ⚠️ ${plural(tr.missing.length, 'entry', 'entries')} on the danger list no longer ${tr.missing.length === 1 ? 'exists' : 'exist'} in this workspace: ${tr.missing.join(', ')}`,
      ));
    }
  }
  if (docs.mainDiff) {
    if (tr.state === 'ok' && docs.mainDiff.mainTierState === 'ok' && docs.mainDiff.extraMainDanger?.length) {
      L.push(zhEn(
        `      ⚠️ 主資料夾的危險清單另有 ${docs.mainDiff.extraMainDanger.length} 條尚未同步到此 worktree：${docs.mainDiff.extraMainDanger.join('、')}`,
        `      ⚠️ Main folder's danger list has ${plural(docs.mainDiff.extraMainDanger.length, 'additional entry', 'additional entries')} not yet in this worktree: ${docs.mainDiff.extraMainDanger.join(', ')}`,
      ));
    } else if (tr.state !== docs.mainDiff.mainTierState) {
      const mainLabel = docs.mainDiff.mainTierState === 'ok'
        ? zhEn(`已設定有效分級（危險清單 ${docs.mainDiff.mainDanger.length} 條）`, `active tier settings (${plural(docs.mainDiff.mainDanger.length, 'danger entry', 'danger entries')})`)
        : docs.mainDiff.mainTierState === 'off'
          ? zhEn('設定為不分級', 'set to not use tiers')
          : docs.mainDiff.mainTierState === 'broken'
            ? zhEn('分級設定讀不懂', 'unreadable tier settings')
            : zhEn('尚未設定分級', 'tiers not set up');
      L.push(zhEn(
        `      ⚠️ 主資料夾目前為「${mainLabel}」，與此 worktree 目前的分級狀態不同。`,
        `      ⚠️ Main folder currently has "${mainLabel}", which differs from this worktree's current tier state.`,
      ));
    }
  }

  return L;
}

function truncationNotice(summary) {
  if (summary.truncatedLines > 0) {
    return zhEn(
      `        （…尚有 ${summary.truncatedLines} 行未列；加 --all 展開全文）`,
      `        (... ${plural(summary.truncatedLines, 'more line')} omitted; add --all for full text)`,
    );
  }
  if (summary.truncatedChars) {
    return zhEn(
      '        （…單行過長已截短；加 --all 展開全文）',
      '        (... long line shortened; add --all for full text)',
    );
  }
  return null;
}

function formatRecordsSection(facts) {
  const L = [];
  const r = facts.records;
  const all = facts.all;
  L.push('');
  L.push(zhEn(
    `━━ 2. 本專案近 ${r.retainDays} 天紀錄純統計（跨 worktree 共用同一份專案紀錄檔）━━`,
    `━━ 2. Last ${r.retainDays} days of project records (shared across worktrees of this project) ━━`,
  ));

  // 故障橫條、壞行、90 天內已恢復故障、掛載／退出記錄與門禁／把關心跳（預審 #1）
  for (const b of faultBanner(r.faults)) L.push(`   ${b.text}`);
  const unread = unreadableLine(r.faults);
  if (unread) L.push(`   ⚠️ ${unread}`);

  const seenRec = new Set();
  const cwdsToCheck = Array.isArray(r.projectCwds) && r.projectCwds.length ? r.projectCwds : [facts.root];
  for (const checkCwd of cwdsToCheck) {
    for (const note of faultNotes(r.faults, { since: null, startKnown: true, until: null, cwd: checkCwd })) {
      if (seenRec.has(note)) continue;
      seenRec.add(note);
      L.push(`   ${note}`);
    }
  }

  const sp = sensorParts({ mount: r.mount, lastSeen: r.lastHereSensorTs, gate: r.gateHb, guard: r.guardHb, ago });
  const sNow = sensorNow(r.faults);
  if (r.optedOut) {
    L.push(zhEn(
      '   ⚠️ 這個專案目前已設定退出記錄（.agents/pipeline-monitor.off），退出期間的新對話不會留下紀錄。',
      '   ⚠️ This project currently opted out of recording (.agents/pipeline-monitor.off); new conversations while opted out leave no records.',
    ));
  } else if (r.mount.state === 'broken') {
    L.push(`   ${sp.broken}`);
    const fix = mountFix(r.mount);
    if (fix) L.push(`   ${fix}`);
  } else if (r.mount.state === 'off') {
    const offLine = sensorOffLine({ mount: r.mount, lastSeen: r.lastHereSensorTs, now: sNow, here: zhEn('上面那一行', 'the line above'), ago, days: r.retainDays });
    if (offLine) L.push(`   ⚠️ ${offLine}`);
    else L.push(`   ⚠️ ${sp.notMounted}`);
  }
  L.push(`   ${gateLine(r.gateHb, { ago })}`);
  L.push(`   ${guardLine(r.guardHb, { ago })}`);
  if (r.stagesBroken) {
    L.push(`   ${stagesBrokenLine(r.stagesBroken, r.stagesBrokenFrom)}`);
  }

  // 紀錄檔狀態與感測器／結構化事件並存處理（預審 #1，P3／P5／R1）
  if (r.evState === 'no-file') {
    L.push(zhEn(
      '   ▸ 紀錄狀態：這個專案還沒有紀錄檔（沒有紀錄不等於零失誤，無法統計四類卡關事件）。',
      '   ▸ Record status: no record file exists for this project yet (no record does not mean zero issues; the four friction event types couldn\'t be counted).',
    ));
    return L;
  }
  if (r.evState === 'no-events' || r.totalEvents === 0) {
    L.push(zhEn(
      `   ▸ 紀錄狀態：這個專案近 ${r.retainDays} 天內沒有任何事件紀錄（可能超過保留期限已清掉，或感測器從未寫入；不印四類 0 次以免誤導）。`,
      `   ▸ Record status: no event records in the last ${r.retainDays} days for this project (either older records expired or nothing was ever written; 0-counts are omitted so no record isn't mistaken for zero friction).`,
    ));
    return L;
  }

  const spanStr = r.earliestTs && r.latestTs
    ? zhEn(
        `最早 ${isoDatePrefix(r.earliestTs) ?? r.earliestTs}（${ago(r.earliestTs)}）· 最新 ${isoDatePrefix(r.latestTs) ?? r.latestTs}（${ago(r.latestTs)}）`,
        `earliest ${isoDatePrefix(r.earliestTs) ?? r.earliestTs} (${ago(r.earliestTs)}) · latest ${isoDatePrefix(r.latestTs) ?? r.latestTs} (${ago(r.latestTs)})`,
      )
    : '';
  L.push(zhEn(
    `   ▸ 紀錄範圍：共 ${r.totalEvents} 筆事件（其中感測器 hook 事件 ${r.sensorCount} 筆）${spanStr ? ` · ${spanStr}` : ''}`,
    `   ▸ Record span: ${plural(r.totalEvents, 'event')} in window (${plural(r.sensorCount, 'sensor hook event')})${spanStr ? ` · ${spanStr}` : ''}`,
  ));
  if (r.noSensorWithin) {
    L.push(zhEn(
      `   ⚠️ 近 ${r.retainDays} 天內沒有任何感測器（hook）事件，底下僅為終端機指令或把關寫入的結構化紀錄，各關實際呼叫與改檔可能漏記。`,
      `   ⚠️ No sensor (hook) events in the last ${r.retainDays} days; only CLI or hook-guard structured records exist below, so stage calls and file edits may not have been recorded.`,
    ));
  }
  if (r.structuredTotal === 0) {
    L.push(zhEn(
      `   ▸ 四類結構化紀錄：在目前這 ${r.totalEvents} 筆紀錄裡，沒有看到 spec_precheck、stage_report、gate_blocked 或 guard_asked 事件（僅代表紀錄裡未出現，不代表沒有問題）。`,
      `   ▸ Four structured record types: among these ${plural(r.totalEvents, 'event')}, no spec_precheck, stage_report, gate_blocked, or guard_asked records appeared (only reflects what's in the records).`,
    ));
    return L;
  }

  // ① spec_precheck
  const pc = r.precheck;
  const pcOther = pc.other > 0 ? zhEn(`、其他標記 ${pc.other} 筆`, `, ${pc.other} other`) : '';
  L.push(zhEn(
    `   ▸ 規格預審（spec_precheck）：共 ${pc.total} 筆（找到問題 found ${pc.found} 筆、沒對到已知死法 ok ${pc.ok} 筆${pcOther}）`,
    `   ▸ Spec precheck (spec_precheck): ${plural(pc.total, 'record')} (found ${pc.found}, didn't match any known failure pattern ok ${pc.ok}${pcOther})`,
  ));
  if (pc.shownFound.length > 0) {
    if (pc.shownFound.length < pc.found) {
      L.push(zhEn(
        `      （共 ${pc.found} 筆 found，列最近 ${pc.shownFound.length} 筆${all ? '' : '；加 --all 列全部'}）`,
        `      (${pc.found} found in all, showing latest ${pc.shownFound.length}${all ? '' : '; add --all for all'})`,
      ));
    }
    for (const item of pc.shownFound) {
      const specText = item.specs ? item.specs.join(zhEn('、', ', ')) : zhEn('未記規格路徑', 'spec path not recorded');
      const headLine = item.summary.lines[0] ?? zhEn('（無文字說明）', '(no note text)');
      L.push(zhEn(`      - [${item.date ?? '?'}] ${specText}：${headLine}`, `      - [${item.date ?? '?'}] ${specText}: ${headLine}`));
      for (const extraLine of item.summary.lines.slice(1)) {
        L.push(`        ${extraLine}`);
      }
      const noteMore = truncationNotice(item.summary);
      if (noteMore) L.push(noteMore);
    }
  }

  // ② stage_report
  const sr = r.stageReports;
  if (sr.total === 0) {
    L.push(zhEn(
      '   ▸ 關卡回報（stage_report）：沒有紀錄',
      '   ▸ Stage reports (stage_report): no record',
    ));
  } else {
    const parts = sr.buckets.map((b) => {
      const label = b.name
        ? `${b.id} ${b.name}`
        : zhEn(`${b.id}（已不在目前關卡清單）`, `${b.id} (no longer in current stage list)`);
      const oth = b.other > 0 ? zhEn(`／其他 ${b.other}`, `/${b.other} other`) : '';
      return zhEn(`${label}：found ${b.found}／ok ${b.ok}${oth}`, `${label}: found ${b.found} / ok ${b.ok}${oth}`);
    }).join(zhEn('；', '; '));
    L.push(zhEn(
      `   ▸ 關卡回報（stage_report）：共 ${sr.total} 筆（${parts}）`,
      `   ▸ Stage reports (stage_report): ${plural(sr.total, 'record')} (${parts})`,
    ));
    if (sr.shownFound.length > 0) {
      if (sr.shownFound.length < sr.totalFound) {
        L.push(zhEn(
          `      （各關共 ${sr.totalFound} 筆 found，列最近 ${sr.shownFound.length} 筆${all ? '' : '；加 --all 列全部'}）`,
          `      (${sr.totalFound} found across stages, showing latest ${sr.shownFound.length}${all ? '' : '; add --all for all'})`,
        ));
      }
      for (const item of sr.shownFound) {
        const stLabel = item.stageName
          ? `${item.stageId} ${item.stageName}`
          : zhEn(`${item.stageId}（歷史關卡）`, `${item.stageId} (historical stage)`);
        const headLine = item.summary.lines[0] ?? zhEn('（無文字說明）', '(no note text)');
        L.push(zhEn(`      - [${item.date ?? '?'}] ${stLabel}：${headLine}`, `      - [${item.date ?? '?'}] ${stLabel}: ${headLine}`));
        for (const extraLine of item.summary.lines.slice(1)) {
          L.push(`        ${extraLine}`);
        }
        const noteMore = truncationNotice(item.summary);
        if (noteMore) L.push(noteMore);
      }
    }
  }

  // ③ gate_blocked
  const gb = r.gateBlocked;
  if (gb.total === 0) {
    L.push(zhEn(
      '   ▸ 收工門禁擋下（gate_blocked）：沒有紀錄',
      '   ▸ Closing-hook blocks (gate_blocked): no record',
    ));
  } else {
    const missText = gb.missing.map((m) => `${m.key} × ${m.count}`).join(zhEn('、', ', '));
    const unl = gb.unlabeled > 0
      ? zhEn(`（另有 ${gb.unlabeled} 次未標缺項種類）`, ` (${plural(gb.unlabeled, 'block')} without missing-key labels)`)
      : '';
    L.push(zhEn(
      `   ▸ 收工門禁擋下（gate_blocked）：共擋 ${gb.total} 次${missText ? `（各缺項累計出現次數：${missText}）` : ''}${unl}`,
      `   ▸ Closing-hook blocks (gate_blocked): ${plural(gb.total, 'block')} in all${missText ? ` (occurrences per missing item: ${missText})` : ''}${unl}`,
    ));
  }

  // ④ guard_asked
  const ga = r.guardAsked;
  if (ga.total === 0) {
    L.push(zhEn(
      '   ▸ 改檔把關詢問（guard_asked，命中既有危險清單或設定讀不懂時觸發）：沒有紀錄',
      '   ▸ Edit-guard prompts (guard_asked, triggered on danger-list hits or unreadable tier settings): no record',
    ));
  } else {
    const otherTxt = ga.otherKind > 0 ? zhEn(`、其他種類 ${ga.otherKind} 次`, `, ${ga.otherKind} other`) : '';
    L.push(zhEn(
      `   ▸ 改檔把關詢問（guard_asked，命中既有危險清單或設定讀不懂時觸發）：共 ${ga.total} 次（命中危險清單 ${ga.dangerTotal} 次、設定讀不懂 ${ga.configBroken} 次${otherTxt}）`,
      `   ▸ Edit-guard prompts (guard_asked, triggered on danger-list hits or unreadable tier settings): ${plural(ga.total, 'prompt')} (danger-list hits ${ga.dangerTotal}, unreadable settings ${ga.configBroken}${otherTxt})`,
    ));
    if (ga.shownFiles.length > 0) {
      if (ga.shownFiles.length < ga.totalFiles) {
        L.push(zhEn(
          `      （共涉及 ${ga.totalFiles} 個檔案，列前 ${ga.shownFiles.length} 個${all ? '' : '；加 --all 列全部'}）`,
          `      (${plural(ga.totalFiles, 'file')} involved, showing top ${ga.shownFiles.length}${all ? '' : '; add --all for all'})`,
        ));
      }
      for (const f of ga.shownFiles) {
        const fileName = f.file || zhEn('（未記錄檔名）', '(file path not recorded)');
        const mainNote = f.status !== 'in-danger' && f.onMainDanger
          ? zhEn('；主資料夾已在危險清單', '; already on main folder\'s danger list')
          : '';
        const statusTxt = f.status === 'in-danger'
          ? zhEn(`仍在危險清單，規則：${f.rule}`, `still on danger list, rule: ${f.rule}`)
          : f.status === 'not-in-danger'
            ? zhEn(`目前已不在危險清單${mainNote}`, `no longer on danger list${mainNote}`)
            : f.status === 'broken'
              ? zhEn(`分級設定讀不懂，無法確認目前清單${mainNote}`, `tier settings unreadable; couldn't check current list${mainNote}`)
              : f.status === 'unset'
                ? zhEn(`目前未設定分級${mainNote}`, `tiers not set up currently${mainNote}`)
                : f.status === 'off'
                  ? zhEn(`目前設為不分級${mainNote}`, `tiers currently turned off${mainNote}`)
                  : zhEn('無法確認清單狀態', 'couldn\'t check list status');
        L.push(zhEn(`      - ${fileName} × ${f.count}（${statusTxt}）`, `      - ${fileName} × ${f.count} (${statusTxt})`));
      }
    }
  }

  return L;
}

/** 將 collectRetrospectFacts 產出的純事實格式化為終端機雙語輸出（單一真相來源）。 */
export function formatRetrospectLines(facts) {
  const head = zhEn(
    `━━ 工地復盤純事實盤點 · ${facts.project} ━━`,
    `━━ Site retrospect fact sheet · ${facts.project} ━━`,
  );
  const boundary = zhEn(
    '（以下僅為結構化檔案與近 90 天事件的純事實計數，零語意猜測；沒紀錄不等於沒發生過，亦不代表通過。）',
    '(Pure factual counts of project files and last-90-day structured events with zero semantic guessing; no record does not mean nothing happened and is not an endorsement.)',
  );
  return [
    head,
    boundary,
    '',
    ...formatDocSection(facts),
    ...formatRecordsSection(facts),
  ];
}

/** 終端機唯讀指令：agy-pipeline --retrospect [--all] */
export function doRetrospect(argv = [], { langState = 'ok', cwd = process.cwd(), monitorDir = HERE, logDir = LOG_DIR, home = undefined } = {}) {
  if (langState === 'broken') console.log(langBrokenLine());
  else if (langState === 'unreadable') console.log(langUnreadableLine());

  const parsed = parseRetrospectArgs(argv);
  if (!parsed.ok) {
    console.log(zhEn(
      `不認得參數：${parsed.extra.join('、')}。用法：agy-pipeline --retrospect [--all]`,
      `Unexpected argument(s): ${parsed.extra.join(', ')}. Usage: agy-pipeline --retrospect [--all]`,
    ));
    return 1;
  }

  const ctx = gitContext(cwd);
  if (!ctx.isGit) {
    console.log(zhEn(
      '這裡看起來不是一個 git 專案，沒辦法執行專案復盤盤點。',
      'This doesn\'t look like a git project, so project retrospect facts can\'t be gathered here.',
    ));
    console.log(zhEn(`（目前位置：${cwd}）`, `(current location: ${cwd})`));
    return 1;
  }

  const facts = collectRetrospectFacts(ctx, { monitorDir, logDir, home, all: parsed.all });
  for (const line of formatRetrospectLines(facts)) console.log(line);
  return 0;
}
