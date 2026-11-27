/**
 * history.mjs —— 舊規格與已知死法即時反查（零快取純字面掃描）。
 * 規格：legacy-spec-lookup（路徑看 AGENTS.md 的表）
 *
 * 絕不另存第二份索引檔或快取（防 P2），每次查詢現場讀取：
 *   1. 已完成規格資料夾（lib/lang.mjs 的 specDirNames(['done'])：docs/升級摘要/*.md 與 docs/done/*.md）
 *   2. 已知死法清單（docs/FAILURE-PATTERNS.md）
 * 排序依內文最新合法 YYYY-MM-DD 日期由新到舊、同日依相對路徑字碼順序，絕不依賴檔案 mtime（P8／P9）。
 * 找不到、空目錄、讀檔失敗或抽不到目標檔名時各自明講，絕不折成「沒有歷史決定」（R1／P5）。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import process from 'node:process';
import { TIER_LINE, TECH_LINE, NOT_DOING_HEAD, specDirNames, zhEn, plural } from './lang.mjs';
import { isSpecPath, realOf } from './checklist.mjs';
import { readTierConfig, computeTier } from './tier.mjs';

export const DEFAULT_ROUND_SPEC_LIMIT = 3;
export const DEFAULT_CONTEXT_SPEC_LIMIT = 5;
export const DEFAULT_FP_LIMIT = 5;
export const DEFAULT_ROUND_FILE_LIMIT = 8;
export const MAX_BRACE_ITEMS = 50;

/** 跳過 markdown code fence 裡的範例內容，避免假標題、假日期或範例路徑干擾（P4）。 */
export function stripCodeFences(text) {
  const out = [];
  let inFence = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}

/**
 * 展開單層大括號縮寫（如 lib/{rounds,cliRerun}.mjs → ['lib/rounds.mjs', 'lib/cliRerun.mjs']）。
 * 巢狀、未閉合、含空項或超過 MAX_BRACE_ITEMS 一律原樣回傳，防止畸形輸入炸開。
 */
export function expandBraces(token) {
  const s = String(token ?? '');
  const m = s.match(/^([^{}]*)\{([^{}]+)\}([^{}]*)$/);
  if (!m) return [s];
  const [, pre, inner, post] = m;
  const parts = inner.split(',').map((x) => x.trim());
  if (!parts.length || parts.length > MAX_BRACE_ITEMS || parts.some((x) => !x || /\s/.test(x))) return [s];
  return parts.map((x) => `${pre}${x}${post}`);
}

/** 把內文裡的單層路徑大括號展開為空白分隔路徑，讓純字面比對也認得縮寫列檔。 */
export function expandBraceText(text) {
  return String(text ?? '').replace(
    /([A-Za-z0-9_./-]*)\{([A-Za-z0-9_, .-]+)\}([A-Za-z0-9_./-]*)/g,
    (full) => {
      const expanded = expandBraces(full);
      return expanded.length === 1 && expanded[0] === full ? full : expanded.join(' ');
    },
  );
}

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normRelPath = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * 目標路徑字面比對正則：守住左右非路徑字元邊界（允許 ./、../ 前綴），
 * 避免 status.mjs 誤中 lib/status.mjs、my-status.mjs 或 status.mjs.bak（P4）。
 */
export function pathRegexFor(target) {
  const norm = normRelPath(target);
  if (!norm) return /(?!)/;
  return new RegExp(`(?:^|(?<![A-Za-z0-9_./-])(?:\\.\\.?\\/)*)${escRe(norm)}(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9_-])`);
}

/** 從跳過 code fence 的內文找出最新合法 YYYY-MM-DD 日曆日期，找不到回 null（絕不看檔案 mtime，P8／P9）。 */
export function latestDateIn(text) {
  const body = stripCodeFences(text);
  let best = null;
  for (const m of body.matchAll(/\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g)) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) continue;
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    if (!best || iso > best) best = iso;
  }
  return best;
}

/** 解析 docs/FAILURE-PATTERNS.md 的 ## 分段（跳過 code fence），相容中英文標題。 */
export function parseFailurePatterns(text) {
  const body = stripCodeFences(text);
  const sections = [];
  let cur = null;
  for (const line of body.split('\n')) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      if (cur) sections.push({ id: cur.id, title: cur.title, text: expandBraceText(cur.lines.join('\n')) });
      const rawHead = m[1].trim();
      const hm = rawHead.match(/^([A-Za-z][A-Za-z0-9_-]{0,31})(?:[:\uFF1A\s\u3000]+(.+))?$/);
      cur = {
        id: hm ? hm[1] : null,
        title: hm ? ((hm[2] ?? '').trim() || rawHead) : rawHead,
        lines: [line],
      };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) sections.push({ id: cur.id, title: cur.title, text: expandBraceText(cur.lines.join('\n')) });
  return sections;
}

/**
 * 將使用者輸入路徑正規化為相對於 ctx.root 的工作區路徑。
 * 沿用 checklist.mjs realOf() 上溯最近存在父目錄解析符號連結（相容 macOS /tmp 與尚未建立的新檔，P8／P13），
 * 並明確排除工作區外、根目錄「.」與實存目錄（P4／R1）。
 */
export function normalizeTargetPath(raw, { root, cwd = root } = {}) {
  const cleaned = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!cleaned) return { ok: false, raw: String(raw ?? ''), reason: 'empty' };
  if (!root) return { ok: false, raw: String(raw ?? ''), reason: 'outside' };
  let abs;
  if (isAbsolute(cleaned)) {
    abs = cleaned;
  } else if (cwd && cwd !== root) {
    const fromCwd = resolve(cwd, cleaned);
    const fromRoot = resolve(root, cleaned);
    if (existsSync(fromCwd)) abs = fromCwd;
    else if (!cleaned.startsWith('..') && existsSync(fromRoot)) abs = fromRoot;
    else abs = fromCwd;
  } else {
    abs = resolve(root, cleaned);
  }
  const realRoot = realOf(root);
  const realTarget = realOf(abs);
  const rel = relative(realRoot, realTarget).split(sep).join('/');
  if (rel === '' || rel === '.') return { ok: false, raw: String(raw ?? ''), reason: 'root' };
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return { ok: false, raw: String(raw ?? ''), reason: 'outside' };
  let isDir = cleaned.endsWith('/');
  if (!isDir) {
    try { isDir = statSync(realTarget).isDirectory(); } catch { isDir = false; }
  }
  if (isDir) return { ok: false, raw: String(raw ?? ''), reason: 'dir', rel: rel.replace(/\/+$/, '') };
  return { ok: true, raw: String(raw ?? ''), rel };
}

/**
 * 從規格檔同時抽取「分級／Tier」與「**技術**：／**Technical**:」行裡預計觸及的檔案路徑並合併去重。
 * 跳過 code fence 與「明確不做／Not doing」段落；與 lookupHistory 共用 expandBraces（P2）；
 * 無斜線的詞（如 status.mjs vs tiers.code）須實存於 root 才納入（P4）。
 */
export function extractSpecTargetPaths(text, { root = null, excludePaths = [] } = {}) {
  const exclude = new Set((Array.isArray(excludePaths) ? excludePaths : []).map(normRelPath).filter(Boolean));
  const lines = String(text ?? '').split('\n');
  const targetLines = [];
  let inFence = false;
  let inNotDoing = 0;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const hm = line.match(/^\s*(#{1,6})\s+/);
    if (NOT_DOING_HEAD.test(line)) { inNotDoing = hm ? hm[1].length : 2; continue; }
    if (inNotDoing && hm && hm[1].length <= inNotDoing) inNotDoing = 0;
    if (inNotDoing) continue;
    if (TIER_LINE.test(line) || TECH_LINE.test(line)) targetLines.push(line);
  }
  const out = [];
  const seen = new Set();
  const tokenRe = /(?:(?:\.\.?\/)+)?(?:\.?[A-Za-z0-9_-]+(?:\/(?:[A-Za-z0-9_.-]+|\{[^{}\s\n]+\}))*\.[A-Za-z0-9]{1,8}|(?:\.?[A-Za-z0-9_-]+\/)+\{[^{}\s\n]+\}[A-Za-z0-9_./-]*)/g;
  for (const line of targetLines) {
    const cleanLine = line.replace(/https?:\/\/[^\s`'"<>()]+/g, ' ');
    for (const m of cleanLine.matchAll(tokenRe)) {
      for (const rawTok of expandBraces(m[0])) {
        const p = rawTok.replace(/\\/g, '/').replace(/^(?:\.\.?\/)+/, '').replace(/[.,;:!?]+$/, '');
        if (!p || exclude.has(p) || isSpecPath(p)) continue;
        if (p.includes('/')) {
          if (!/\.[A-Za-z0-9]{1,8}$/.test(p)) continue;
          if (root) {
            try { if (statSync(join(root, p)).isDirectory()) continue; } catch { /* 尚未建立的新檔仍納入 */ }
          }
        } else {
          if (!root) continue;
          try { if (!statSync(join(root, p)).isFile()) continue; } catch { continue; }
        }
        if (!seen.has(p)) { seen.add(p); out.push(p); }
      }
    }
  }
  return out;
}

/** 若設定檔有效，將命中危險清單的檔案排在前面、其餘依檔名穩定排序（P2／R3）。 */
export function prioritizeFiles(files, { root, mainRoot = null, monitorDir = null } = {}) {
  const uniq = [...new Set((Array.isArray(files) ? files : []).map(normRelPath).filter(Boolean))];
  const cfg = root && monitorDir ? readTierConfig(root, mainRoot, monitorDir) : null;
  const inDanger = cfg?.state === 'ok'
    ? (f) => computeTier([f], cfg.config).rank === 2
    : () => false;
  return uniq
    .map((file) => ({ file, danger: inDanger(file) }))
    .sort((a, b) => (a.danger === b.danger ? (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) : a.danger ? -1 : 1));
}

function readDoneSpecs(root) {
  if (!root || !existsSync(root)) return { state: 'no-dir', docs: [], unreadableDirs: [], unreadableFiles: [] };
  const byRel = new Map();
  const unreadableDirs = [];
  const unreadableFiles = [];
  let dirCount = 0;
  for (const folder of specDirNames(['done'])) {
    const dirRel = `docs/${folder}`;
    const dirAbs = join(root, 'docs', folder);
    if (!existsSync(dirAbs)) continue;
    let entries;
    try { entries = readdirSync(dirAbs); }
    catch (e) { unreadableDirs.push({ dir: dirRel, code: e?.code ?? null }); continue; }
    dirCount++;
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const fileAbs = join(dirAbs, name);
      const fileRel = `${dirRel}/${name}`;
      let st;
      try { st = statSync(fileAbs); }
      catch { unreadableFiles.push(fileRel); continue; }
      if (!st.isFile()) continue;
      let content;
      try { content = readFileSync(fileAbs, 'utf8'); }
      catch { unreadableFiles.push(fileRel); continue; }
      const title = (content.match(/^#\s+(.+)$/m)?.[1] ?? '').trim() || name.replace(/\.md$/i, '');
      const date = latestDateIn(content);
      byRel.set(fileRel, {
        rel: fileRel,
        name: name.replace(/\.md$/i, ''),
        title,
        date,
        searchText: expandBraceText(content),
      });
    }
  }
  let state;
  if (dirCount === 0 && unreadableDirs.length === 0) state = 'no-dir';
  else if (dirCount === 0 && unreadableDirs.length > 0) state = 'unreadable';
  else if (byRel.size === 0 && unreadableFiles.length === 0) state = 'empty';
  else if (byRel.size === 0 && unreadableFiles.length > 0) state = 'unreadable';
  else state = 'ok';
  const docs = [...byRel.values()].sort((a, b) => (
    (b.date || '') < (a.date || '') ? -1
      : (b.date || '') > (a.date || '') ? 1
      : a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
  ));
  return { state, docs, unreadableDirs, unreadableFiles };
}

function readFailurePatternsSource(root) {
  if (!root || !existsSync(root)) return { state: 'missing', sections: [] };
  const fpPath = join(root, 'docs', 'FAILURE-PATTERNS.md');
  if (!existsSync(fpPath)) return { state: 'missing', sections: [] };
  let raw;
  try { raw = readFileSync(fpPath, 'utf8'); }
  catch { return { state: 'unreadable', sections: [] }; }
  const sections = parseFailurePatterns(raw);
  if (!sections.length) return { state: 'no-sections', sections: [] };
  return { state: 'ok', sections };
}

/** 即時反查每個目標檔案的已完成規格與已知死法出處，絕不建立快取或索引。 */
export function lookupHistory({
  root,
  targets = [],
  specLimit = DEFAULT_CONTEXT_SPEC_LIMIT,
  fpLimit = DEFAULT_FP_LIMIT,
  all = false,
} = {}) {
  const specsSrc = readDoneSpecs(root);
  const fpSrc = readFailurePatternsSource(root);
  const items = (Array.isArray(targets) ? targets : []).map((t) => {
    const file = normRelPath(typeof t === 'string' ? t : t?.file);
    const danger = typeof t === 'object' && t?.danger === true;
    const re = pathRegexFor(file);
    const matchedSpecs = specsSrc.docs.filter((d) => re.test(d.searchText));
    const matchedFp = fpSrc.sections.filter((s) => re.test(s.text));
    const sCap = all ? matchedSpecs.length : specLimit;
    const fCap = all ? matchedFp.length : fpLimit;
    return {
      file,
      danger,
      totalSpecs: matchedSpecs.length,
      specs: matchedSpecs.slice(0, sCap).map(({ rel, name, title, date }) => ({ rel, name, title, date })),
      totalFp: matchedFp.length,
      fps: matchedFp.slice(0, fCap).map(({ id, title }) => ({ id, title })),
    };
  });
  return {
    specs: {
      state: specsSrc.state,
      totalDocs: specsSrc.docs.length,
      unreadableDirs: specsSrc.unreadableDirs,
      unreadableFiles: specsSrc.unreadableFiles,
    },
    fp: {
      state: fpSrc.state,
      totalSections: fpSrc.sections.length,
    },
    items,
  };
}

/** 將 lookupHistory 的結果轉為終端機可讀的誠實文案（ZH／EN 同一份單一真相來源）。 */
export function formatHistoryLines(result, {
  indent = '   ',
  extraNotes = [],
  omittedFiles = 0,
  hintContext = false,
  all = false,
} = {}) {
  const lines = [];
  const p = indent;
  lines.push(zhEn(
    `${p}歷史反查（僅列字面上點名過該檔路徑的歷史紀錄，沒列到的不代表無關）：`,
    `${p}History lookup (only lists historical records that literally name that file path; what isn't listed isn't necessarily unrelated):`,
  ));
  const sp = result?.specs ?? { state: 'no-dir', unreadableDirs: [], unreadableFiles: [] };
  if (sp.state === 'no-dir') {
    lines.push(zhEn(
      `${p}   舊規格來源：找不到已完成規格資料夾（docs/升級摘要/ 或 docs/done/），沒辦法反查舊規格。`,
      `${p}   Past specs source: completed-specs folder (docs/done/ or the Chinese equivalent) does not exist, so past specs couldn't be checked.`,
    ));
  } else if (sp.state === 'empty') {
    lines.push(zhEn(
      `${p}   舊規格來源：已完成規格資料夾裡還沒有任何 .md 規格檔。`,
      `${p}   Past specs source: no .md spec files exist in the completed-specs folder yet.`,
    ));
  } else if (sp.state === 'unreadable') {
    lines.push(zhEn(
      `${p}   舊規格來源：讀不到已完成規格資料夾或裡面的檔案，沒辦法反查舊規格。`,
      `${p}   Past specs source: couldn't read the completed-specs folder or its files, so past specs couldn't be checked.`,
    ));
  }
  if (sp.unreadableDirs?.length) {
    const dirs = sp.unreadableDirs.map((d) => d.dir).join(zhEn('、', ', '));
    lines.push(zhEn(
      `${p}   ⚠️ 有 ${sp.unreadableDirs.length} 個規格資料夾沒有權限讀或讀不到：${dirs}`,
      `${p}   ⚠️ Couldn't read ${plural(sp.unreadableDirs.length, 'spec folder')}: ${dirs}`,
    ));
  }
  if (sp.unreadableFiles?.length) {
    const shown = sp.unreadableFiles.slice(0, 5).join(zhEn('、', ', '));
    const more = sp.unreadableFiles.length > 5 ? zhEn(` 等 ${sp.unreadableFiles.length} 份`, ` and others (${sp.unreadableFiles.length} in all)`) : '';
    lines.push(zhEn(
      `${p}   ⚠️ 有 ${sp.unreadableFiles.length} 份舊規格檔讀不到（已略過）：${shown}${more}`,
      `${p}   ⚠️ Couldn't read ${plural(sp.unreadableFiles.length, 'past spec file')} (skipped): ${shown}${more}`,
    ));
  }
  const fp = result?.fp ?? { state: 'missing' };
  if (fp.state === 'missing') {
    lines.push(zhEn(
      `${p}   已知死法來源：找不到 docs/FAILURE-PATTERNS.md，沒辦法反查已知死法。`,
      `${p}   Failure patterns source: docs/FAILURE-PATTERNS.md was not found, so known failure patterns couldn't be checked.`,
    ));
  } else if (fp.state === 'unreadable') {
    lines.push(zhEn(
      `${p}   已知死法來源：讀不到 docs/FAILURE-PATTERNS.md（可能沒有權限），沒辦法反查已知死法。`,
      `${p}   Failure patterns source: couldn't read docs/FAILURE-PATTERNS.md (possibly no permission), so known failure patterns couldn't be checked.`,
    ));
  } else if (fp.state === 'no-sections') {
    lines.push(zhEn(
      `${p}   已知死法來源：docs/FAILURE-PATTERNS.md 裡找不到任何 ## 分段標題，沒辦法反查已知死法。`,
      `${p}   Failure patterns source: no ## section headings were found in docs/FAILURE-PATTERNS.md, so known failure patterns couldn't be checked.`,
    ));
  }

  for (const note of extraNotes) if (note) lines.push(`${p}   ${note}`);

  const specsReadable = sp.state === 'ok' || sp.state === 'empty';
  const fpReadable = fp.state === 'ok';
  for (const it of result?.items ?? []) {
    const tag = it.danger ? zhEn('（危險清單）', ' (danger list)') : '';
    lines.push(`${p}   ▸ ${it.file}${tag}`);
    if (specsReadable) {
      if (it.totalSpecs === 0) {
        lines.push(zhEn(`${p}      舊規格：未見字面點名`, `${p}      Past specs: no literal mention found`));
      } else {
        const list = it.specs.map((s) => `${s.rel}${s.date ? ` (${s.date})` : ''}`).join(zhEn('、', ', '));
        const suffix = it.specs.length < it.totalSpecs
          ? zhEn(`（共 ${it.totalSpecs} 份，列最近 ${it.specs.length} 份${all ? '' : '；要看全部用 agy-pipeline --context ' + it.file + ' --all'}）`,
            ` (${it.totalSpecs} in all, showing latest ${it.specs.length}${all ? '' : `; run agy-pipeline --context ${it.file} --all for all`})`)
          : zhEn(`（共 ${it.totalSpecs} 份）`, ` (${it.totalSpecs} in all)`);
        lines.push(zhEn(`${p}      舊規格：${list}${suffix}`, `${p}      Past specs: ${list}${suffix}`));
      }
    }
    if (fpReadable) {
      if (it.totalFp === 0) {
        lines.push(zhEn(`${p}      已知死法：未見字面點名`, `${p}      Known pitfalls: no literal mention found`));
      } else {
        const list = it.fps.map((x) => (x.id ? `${x.id} ${x.title}` : x.title)).join(zhEn('；', '; '));
        const suffix = it.fps.length < it.totalFp
          ? zhEn(`（共 ${it.totalFp} 條，列前 ${it.fps.length} 條）`, ` (${it.totalFp} in all, showing first ${it.fps.length})`)
          : zhEn(`（共 ${it.totalFp} 條）`, ` (${it.totalFp} in all)`);
        lines.push(zhEn(`${p}      已知死法：${list}${suffix}`, `${p}      Known pitfalls: ${list}${suffix}`));
      }
    }
  }

  if (omittedFiles > 0) {
    lines.push(zhEn(
      `${p}   （另有 ${omittedFiles} 個檔未展開反查${hintContext ? '；需要時可跑 agy-pipeline --context <檔...>' : ''}）`,
      `${p}   (${plural(omittedFiles, 'other file')} not expanded${hintContext ? '; run agy-pipeline --context <file...> if needed' : ''})`,
    ));
  } else if (hintContext && (result?.items?.length ?? 0) > 0) {
    lines.push(zhEn(
      `${p}   需要展開全部或查指定檔案：agy-pipeline --context <檔...> [--all]`,
      `${p}   To see all entries or check specific files: agy-pipeline --context <file...> [--all]`,
    ));
  }
  return lines;
}

/** 終端機唯讀指令：agy-pipeline --context <檔...> [--all] */
export function doContext(ctx, argv = []) {
  const idx = argv.indexOf('--context');
  const rawArgs = idx === -1 ? [] : argv.slice(idx + 1);
  let all = false;
  const targetsRaw = [];
  const unknownFlags = [];
  for (const a of rawArgs) {
    if (a === '--all') { all = true; continue; }
    if (a.startsWith('--')) { unknownFlags.push(a); continue; }
    targetsRaw.push(a);
  }
  if (unknownFlags.length) {
    console.log(zhEn(
      `不認得參數：${unknownFlags.join('、')}。用法：agy-pipeline --context <檔...> [--all]`,
      `Unknown flag: ${unknownFlags.join(', ')}. Usage: agy-pipeline --context <file...> [--all]`,
    ));
    return 1;
  }
  if (!targetsRaw.length) {
    console.log(zhEn(
      '請提供要反查的檔案路徑。例：agy-pipeline --context status.mjs lib/cliRerun.mjs [--all]',
      'Provide one or more file paths to look up. Example: agy-pipeline --context status.mjs lib/cliRerun.mjs [--all]',
    ));
    return 1;
  }

  const cwd = process.cwd();
  const valid = [];
  const seen = new Set();
  const badNotes = [];
  for (const raw of targetsRaw) {
    const n = normalizeTargetPath(raw, { root: ctx.root, cwd });
    if (!n.ok) {
      if (n.reason === 'root') {
        badNotes.push(zhEn(
          `⚠️ 跳過「${raw}」：這是工作區根目錄本身，請指定具體檔案路徑。`,
          `⚠️ Skipped "${raw}": this is the workspace root itself; specify a file path instead.`,
        ));
      } else if (n.reason === 'dir') {
        badNotes.push(zhEn(
          `⚠️ 跳過「${raw}」：這是資料夾，請指定具體檔案路徑。`,
          `⚠️ Skipped "${raw}": this is a directory; specify a file path instead.`,
        ));
      } else if (n.reason === 'outside') {
        badNotes.push(zhEn(
          `⚠️ 跳過「${raw}」：不在這個專案工作區內，沒有反查。`,
          `⚠️ Skipped "${raw}": outside this project workspace, so it wasn't looked up.`,
        ));
      } else {
        badNotes.push(zhEn(
          `⚠️ 跳過空白路徑參數。`,
          `⚠️ Skipped an empty path argument.`,
        ));
      }
      continue;
    }
    if (!seen.has(n.rel)) { seen.add(n.rel); valid.push(n.rel); }
  }

  for (const line of badNotes) console.log(line);
  if (!valid.length) {
    console.log(zhEn(
      '沒有可反查的專案檔案路徑。用法：agy-pipeline --context <檔...> [--all]',
      'No valid project file paths to look up. Usage: agy-pipeline --context <file...> [--all]',
    ));
    return 1;
  }

  const res = lookupHistory({
    root: ctx.root,
    targets: valid,
    specLimit: DEFAULT_CONTEXT_SPEC_LIMIT,
    fpLimit: DEFAULT_FP_LIMIT,
    all,
  });
  for (const line of formatHistoryLines(res, { indent: '', all })) console.log(line);
  return 0;
}
