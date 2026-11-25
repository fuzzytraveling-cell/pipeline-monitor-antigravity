/**
 * brief.mjs —— 定時工地巡檢晨報（--brief / --brief --quiet-if-clear）與首頁晨報卡的單一真相來源。
 * 規格：brief-patrol-command、dashboard-brief-card（路徑看 AGENTS.md 的表）
 *
 * ⚠️ 零額外 git 查詢：只消費 collectAll 與 todoBoard 已經算好的事實（P2）。
 * ⚠️ 三條紅線：
 *   R1 任何「問不到／看不到」（含 0 專案、儀表板連不上／忙碌／舊版、分級未設／讀不懂、感測器掛壞、
 *      故障檔讀不懂、衝突檢查不全、規格失蹤或讀不出 AC、emptyLine）一律納入提醒且不進入安靜模式。
 *   R2 清零時不宣稱「通過／安全／all clear」（P10），僅誠實說明已檢查幾個專案、紀錄裡看得到的項目都沒列。
 *   R3 不自編「太久沒動」天數門檻或緊急分數，只印既有的最後動作時間與事實。
 */
import { zhEn, plural, langBrokenLine, langUnreadableLine } from './lang.mjs';
import { ago as agoNow } from './git.mjs';
import { cardState } from './rounds.mjs';
import { checklistHead, specNotes } from './stageLines.mjs';

export const BRIEF_CARD_CAP = 5;

const ALLOWED_BRIEF_FLAGS = new Set(['--brief', '--quiet-if-clear']);
const BAD_SPEC_PLACES = new Set(['missing', 'older', 'outside', 'ambiguous']);

/**
 * 嚴格檢查 --brief 參數：只允許 --brief 與 --quiet-if-clear，拒絕其他一切旗標與位置引數（P4）。
 */
export function parseBriefArgs(argv = []) {
  const bad = argv.filter((a) => !ALLOWED_BRIEF_FLAGS.has(a));
  if (bad.length) {
    return {
      ok: false,
      quietIfClear: false,
      bad,
      errorLine: zhEn(
        `不認得搭配 --brief 使用的參數：${bad.join(' ')}。可用法：agy-pipeline --brief [--quiet-if-clear]`,
        `Unrecognized argument(s) with --brief: ${bad.join(' ')}. Usage: agy-pipeline --brief [--quiet-if-clear]`,
      ),
    };
  }
  return { ok: true, quietIfClear: argv.includes('--quiet-if-clear'), bad: [], errorLine: null };
}

const isBadPlace = (at) => !!at && (at.gone || BAD_SPEC_PLACES.has(at.found));

/**
 * 檢查進行中對話的 A 關卡規格失蹤、同名歧義、來源不明或讀不出 AC 格式（預審 #5，P5/R1）。
 * 正在寫規格初態（spec.state === 'current' && !spec.doneAt && !spec.link）不算異常。
 */
function specUnknownItems(rawS, { ago }) {
  if (!rawS || rawS.card?.gone || rawS.card?.notGit) return [];
  const spec = (rawS.stages ?? []).find((x) => x.skill) ?? null;
  if (!spec) return [];
  const out = [];
  const many = Array.isArray(spec.specPlaces) && spec.specPlaces.length > 1;
  const badPlaces = many ? spec.specPlaces.filter(isBadPlace) : [];
  const badPlace = !many && isBadPlace(spec.specPlace) ? spec.specPlace : null;
  const badInput = {
    ...(badPlace ? { specPlace: badPlace } : {}),
    ...(badPlaces.length ? { specPlaces: badPlaces } : {}),
    ...(spec.unsure ? { unsure: spec.unsure } : {}),
    ...(spec.ghostSpecs?.length ? { ghostSpecs: spec.ghostSpecs } : {}),
  };
  if (Object.keys(badInput).length) out.push(...specNotes(badInput, { ago }));

  const writingSpec = spec.state === 'current' && !spec.doneAt && !spec.link;
  const hasMissingNote = badPlace?.found === 'missing' || badPlaces.some((at) => at.found === 'missing');
  if (spec.checklist && spec.checklist.parsed === false && !writingSpec && !(spec.checklist.missing && hasMissingNote)) {
    const head = checklistHead(spec.checklist);
    if (head) out.push(head);
  }
  return out;
}

/**
 * 從 collectAll 與 todoBoard 濃縮晨報結構與輸出行（終端機與儀表板共用同一份，P2）。
 * clear 僅在 system / loss / ask / unknown / todo 五區皆空時為 true；未開始建議卡與 goneHidden 不單獨打破靜音。
 */
export function briefReport(all, board, { langState = 'ok', ago = agoNow, cardCap = BRIEF_CARD_CAP } = {}) {
  const rawByName = new Map((all?.projects ?? []).map((p) => [p.name, p]));
  const systemItems = [];
  const lossItems = [];
  const askItems = [];
  const unknownItems = [];
  const todoItems = [];
  const cardItems = [];

  // 1. 系統與服務提醒（onTopBanner: 已畫在儀表板頁頂橫條者，網頁卡省略不重複，但 copyText 與終端機照列）
  if (langState === 'broken') systemItems.push({ text: langBrokenLine(), onTopBanner: true });
  else if (langState === 'unreadable') systemItems.push({ text: langUnreadableLine(), onTopBanner: true });
  for (const f of all?.faults?.banner ?? []) if (f?.text) systemItems.push({ text: f.text, onTopBanner: true });
  if (all?.faults?.unreadableLine) systemItems.push({ text: all.faults.unreadableLine });
  if (board?.restart) systemItems.push({ text: board.restart, onTopBanner: true });

  const boardProjects = board?.projects ?? [];
  const projectCount = (all?.projects ?? []).length;

  // 4（全機層）. 看不到任何專案
  if (board?.empty) unknownItems.push({ text: board.empty });
  else if (!projectCount) {
    unknownItems.push({
      text: zhEn(
        '這裡還看不到任何案件（只列有紀錄或有還原點的專案）。',
        'No projects can be seen here yet (only projects with records or a restore point are listed).',
      ),
    });
  }

  for (const p of boardProjects) {
    const rawP = rawByName.get(p.name) ?? null;
    const projTag = (text) => zhEn(`【${p.displayName}】${text}`, `[${p.displayName}] ${text}`);

    if (p.note) systemItems.push({ text: projTag(p.note), project: p.name });
    const seenStagesNotes = new Set();
    for (const c of rawP?.cards ?? []) {
      if (c?.stagesNote && !seenStagesNotes.has(c.stagesNote)) {
        seenStagesNotes.add(c.stagesNote);
        systemItems.push({ text: projTag(c.stagesNote), project: p.name });
      }
    }

    // 專案層盲區（預審 #2）
    if (!rawP?.optedOut && rawP?.emptyLine) unknownItems.push({ text: projTag(rawP.emptyLine), project: p.name });
    else if (
      rawP && Array.isArray(rawP.cards) && rawP.cards.length > 0
      && !rawP.cards.some((c) => c && !c.gone && !c.notGit)
      && !(p.rows ?? []).length && !p.push && !p.note
      && !(rawP.sessions ?? []).some((s) => s.closedAt)
    ) {
      unknownItems.push({
        text: projTag(zhEn(
          '找不到還在的資料夾，看不到這個專案的現況',
          'Can\'t find a folder that\'s still there, so can\'t see this project\'s current status',
        )),
        project: p.name,
      });
    }

    // 2. 防丟與衝突警示（已結案未存未併、跨 worktree 衝突／檢查不全、main 未推／問不到）
    for (const r of p.rows ?? []) {
      if (!r.closed) continue;
      const itemText = (r.items ?? []).map((i) => i.text).filter(Boolean).join(zhEn('；', '; '));
      lossItems.push({
        text: zhEn(
          `【${p.displayName}】「${r.title}」（${r.closedNote ? `${r.closedNote} · ` : ''}${r.last}）：${itemText}`,
          `[${p.displayName}] "${r.title}" (${r.closedNote ? `${r.closedNote} · ` : ''}${r.last}): ${itemText}`,
        ),
        project: p.name,
        sessionId: r.id,
      });
    }
    for (const c of p.conflicts ?? []) if (c?.text) lossItems.push({ text: projTag(c.text), project: p.name });
    if (p.push) lossItems.push({ text: projTag(p.push), project: p.name });

    // 3 / 4 / 5. 進行中對話：等你拍板、問不到與看不全、其餘待辦與可結案
    for (const r of p.rows ?? []) {
      if (r.closed) continue;
      const rowPrefix = zhEn(`【${p.displayName}】「${r.title}」`, `[${p.displayName}] "${r.title}"`);
      for (const i of r.items ?? []) {
        if (i.kind === 'ask') askItems.push({ text: zhEn(`${rowPrefix}：${i.text}`, `${rowPrefix}: ${i.text}`), project: p.name, sessionId: r.id });
        else if (i.kind === 'unknown') unknownItems.push({ text: zhEn(`${rowPrefix}：${i.text}`, `${rowPrefix}: ${i.text}`), project: p.name, sessionId: r.id });
      }

      const rawS = rawP?.sessions?.find((s) => s.id === r.id) ?? null;
      let extraUnknown = false;
      if (rawS?.unknownNote) {
        unknownItems.push({ text: zhEn(`${rowPrefix}：${rawS.unknownNote}`, `${rowPrefix}: ${rawS.unknownNote}`), project: p.name, sessionId: r.id });
        extraUnknown = true;
      }
      for (const note of specUnknownItems(rawS, { ago })) {
        unknownItems.push({ text: zhEn(`${rowPrefix}：${note}`, `${rowPrefix}: ${note}`), project: p.name, sessionId: r.id });
        extraUnknown = true;
      }

      const openTodo = (r.items ?? []).filter((i) => i.kind === 'todo').map((i) => i.text).filter(Boolean);
      if (openTodo.length) {
        todoItems.push({
          text: zhEn(
            `${rowPrefix}（${r.last}）：${openTodo.join('；')}`,
            `${rowPrefix} (${r.last}): ${openTodo.join('; ')}`,
          ),
          project: p.name,
          sessionId: r.id,
        });
      } else if (r.clear && !extraUnknown) {
        todoItems.push({
          text: zhEn(
            `${rowPrefix}（${r.last}）：${r.clear}`,
            `${rowPrefix} (${r.last}): ${r.clear}`,
          ),
          project: p.name,
          sessionId: r.id,
        });
      }
    }
  }

  // 6. 可開工的待辦項目（直接掃各專案 p.suggestions 中還沒開始的卡；卡片本體住在來源專案 p.name）
  const openCards = [];
  for (const p of all?.projects ?? []) {
    const projName = p.displayName ?? p.name;
    for (const sg of p.suggestions ?? []) {
      if (cardState(sg) !== 'open') continue;
      const titleText = `${sg.title ?? zhEn('（沒有標題）', '(no title)')}${(sg.cut ?? []).includes('title') ? '…' : ''}`;
      const target = sg.openIn
        ? (sg.openIn.name
          ? zhEn(` → 要開在「${sg.openIn.name}」`, ` -> to open in "${sg.openIn.name}"`)
          : zhEn(' → 要開在別的資料夾（路徑沒記完整）', ' -> to open in another folder (path wasn\'t recorded in full)'))
        : '';
      const when = sg.ts ? ago(sg.ts) : null;
      openCards.push({
        text: zhEn(
          `【${projName}】「${titleText}」${target}${when ? ` · ${when}` : ''}`,
          `[${projName}] "${titleText}"${target}${when ? ` · ${when}` : ''}`,
        ),
        project: p.name,
      });
    }
  }
  if (openCards.length) {
    cardItems.push(...openCards.slice(0, cardCap));
    if (openCards.length > cardCap) {
      cardItems.push({
        text: zhEn(
          `……等共 ${openCards.length} 張（在對應專案資料夾執行 agy-pipeline --cards 查看完整內容）`,
          `...and more (${plural(openCards.length, 'card')} total; run agy-pipeline --cards in the corresponding project folder to see all of them)`,
        ),
        summary: true,
      });
    } else {
      cardItems.push({
        text: zhEn(
          `共 ${openCards.length} 張（在對應專案資料夾執行 agy-pipeline --cards 查看詳情）`,
          `${plural(openCards.length, 'card')} total (run agy-pipeline --cards in the corresponding project folder for details)`,
        ),
        summary: true,
      });
    }
  }

  const groupDefs = [
    { id: 'system', title: zhEn('系統與服務提醒', 'System & service alerts'), cliTitle: zhEn('【系統與服務提醒】', '[System & service alerts]'), kind: 'unknown', items: systemItems },
    { id: 'loss', title: zhEn('防丟與衝突警示', 'Data-loss & conflict alerts'), cliTitle: zhEn('【防丟與衝突警示】', '[Data-loss & conflict alerts]'), kind: 'ask', items: lossItems },
    { id: 'ask', title: zhEn('等你拍板', 'Needs your decision'), cliTitle: zhEn('【等你拍板】', '[Needs your decision]'), kind: 'ask', items: askItems },
    { id: 'unknown', title: zhEn('問不到與看不全', 'Couldn\'t check or incomplete'), cliTitle: zhEn('【問不到與看不全】', '[Couldn\'t check or incomplete]'), kind: 'unknown', items: unknownItems },
    { id: 'todo', title: zhEn('其餘進行中待辦與可結案', 'Other open work & ready to close'), cliTitle: zhEn('【其餘進行中待辦與可結案】', '[Other open work & ready to close]'), kind: 'todo', items: todoItems },
    { id: 'cards', title: zhEn('可開工的待辦項目（還沒開始的建議卡）', 'Ready to start (unstarted suggestion cards)'), cliTitle: zhEn('【可開工的待辦項目（還沒開始的建議卡）】', '[Ready to start (unstarted suggestion cards)]'), kind: 'cards', items: cardItems },
  ];

  const sections = Object.fromEntries(groupDefs.map((g) => [g.id, g.items.map((it) => it.text)]));
  const groups = groupDefs.filter((g) => g.items.length > 0).map(({ id, title: gTitle, kind, items }) => ({ id, title: gTitle, kind, items }));

  const clear = !(systemItems.length || lossItems.length || askItems.length || unknownItems.length || todoItems.length);
  const goneHidden = boardProjects.some((p) => p.goneHidden);
  const title = zhEn('工地晨報（所有專案）', 'Site brief (all projects)');
  const clearLine = clear
    ? zhEn(
      `目前沒有列出故障、待拍板、未存未併或進行中待辦（已檢查 ${projectCount} 個專案；這只代表紀錄裡看得到的項目都沒列）${goneHidden ? '（已結案且資料夾已經不在的看不到）' : ''}。`,
      `No faults, pending decisions, uncommitted/unmerged work, or open tasks are listed right now (checked ${plural(projectCount, 'project')}; this only reflects what can be seen in the records)${goneHidden ? ' (closed conversations whose folders are gone can\'t be seen)' : ''}.`,
    )
    : null;
  const topOnlyLine = zhEn(
    '上方全機提醒之外，目前沒有列出其他待拍板、未存未併或進行中待辦。',
    'Aside from the alerts at the top, no other pending decisions, uncommitted/unmerged work, or open tasks are listed right now.',
  );
  const goneNote = !clear && goneHidden
    ? zhEn('註：已結案且資料夾已經不在的對話看不到。', 'Note: closed conversations whose folders are gone can\'t be seen.')
    : null;

  const lines = [title];
  const bullet = (t) => zhEn(`  ・${t}`, `  - ${t}`);
  if (clear) {
    lines.push(clearLine);
    const cardsDef = groupDefs.find((g) => g.id === 'cards');
    if (cardsDef?.items.length) lines.push('', cardsDef.cliTitle, ...cardsDef.items.map((it) => bullet(it.text)));
  } else {
    for (const g of groupDefs) {
      if (!g.items.length) continue;
      lines.push('', g.cliTitle, ...g.items.map((it) => bullet(it.text)));
    }
    if (goneNote) lines.push('', goneNote);
  }

  return {
    title,
    clear,
    clearLine,
    topOnlyLine,
    goneHidden,
    goneNote,
    projectCount,
    sections,
    groups,
    lines,
    copyText: lines.join('\n'),
  };
}
