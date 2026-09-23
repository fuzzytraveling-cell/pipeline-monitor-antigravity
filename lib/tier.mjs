/**
 * tier.mjs —— 分級:「這一次改動要多小心」。規格:分級(路徑看 CLAUDE.md 的表)
 *
 * 分級不是專案的屬性,是**這一次改動**的屬性:每次看儀表板都重新算。
 * 依據只有一個問題——這次改的檔案落在哪裡——對兩張**人寫的**清單查表:
 *   程式區(code)  :程式住的資料夾。碰到 → 第二級
 *   危險清單(danger):改錯了不會馬上看見、幾天後才發現使用者的東西壞了的檔案。碰到 → 第三級
 * 三級的名字與「必須有紀錄的關」住在設定檔;預設值在 stages.json 的 tierLevels——
 * 程式碼裡**不准**出現 T0／T1／T2 這種字串(CLAUDE.md:專案專屬的字串只准在設定檔)。
 *
 * ⚠️ 三條不准:
 *   1. 沒有清單就不分級。工具不猜危險清單——「改錯了會不會靜默丟資料」只有人判斷得了(R1／R3)。
 *   2. 給的是**下限**:檔名看不出改了一個字還是重寫整個檔。只准往上調;往下調要改設定檔,不方便是故意的。
 *   3. 危險清單空的 → 明講「永遠不會出現第三級」,不讓「空的」看起來像「都安全」。
 *
 * 終端機(status.mjs)與網頁(collect.mjs)都只呼叫這裡的 buildTier(),一份實作(老毛病 P2)。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, relative, isAbsolute, dirname } from 'node:path';
import { readProjectConfig, rerunLine } from './events.mjs';
import { eLines } from './verify.mjs';

/** 三級的內部名字,由低到高。id(T0…)與 requires 都從設定檔來,這裡只有順序。 */
export const RANKS = ['none', 'code', 'danger'];

const normDir = (p) => `${String(p).replace(/^\.\//, '').replace(/\/+$/, '')}/`;
const normEntry = (p) => String(p).replace(/^\.\//, '');

/**
 * 讀分級設定。五種狀態刻意分開,呼叫端不准折成「有／沒有」:
 *   unset  :設定檔裡沒有 tiers → 還沒設定(會提醒)
 *   off    :tiers.off === true → 人明講不分級(不提醒)
 *   broken :檔案讀不懂、或 tiers 形狀不對 → 為了不亂分,不分級,但要講(R1:不是「沒設定」)
 *   ok     :有程式區(非空陣列)、有危險清單(陣列,可以空)、三級定義齊全
 */
export function readTierConfig(root, mainRoot, monitorDir) {
  const { data, from, broken } = readProjectConfig(root, mainRoot);
  if (broken) return { state: 'broken', from, why: '設定檔讀不懂' };
  const t = data?.tiers;
  if (t === undefined) return { state: 'unset', from };
  if (t && typeof t === 'object' && t.off === true) return { state: 'off', from, off: { at: t.at ?? null, why: t.why ?? null } };
  if (!t || typeof t !== 'object' || !Array.isArray(t.code) || !t.code.length
      || (t.danger !== undefined && !Array.isArray(t.danger))) {
    return { state: 'broken', from, why: 'tiers.code 要是一個非空的陣列(程式區),tiers.danger 要是陣列(危險清單)' };
  }
  let levels = t.levels ?? null;
  if (!levels) {
    try { levels = JSON.parse(readFileSync(join(monitorDir, 'stages.json'), 'utf8')).tierLevels ?? null; } catch { levels = null; }
  }
  if (!levels || !RANKS.every((r) => typeof levels[r]?.id === 'string')) {
    return { state: 'broken', from, why: '找不到三級的定義(levels 要有 none／code／danger 三個,各有 id)' };
  }
  return {
    state: 'ok', from,
    config: { code: t.code.map(normDir), danger: (t.danger ?? []).map(normEntry), levels },
  };
}

/** 把 tiers 寫進(或蓋掉)專案的 .claude/pipeline-stages.json。其他鍵(stages 覆寫)原封不動。讀不懂就停手。 */
export function writeTierConfig(root, tiers) {
  const p = join(root, '.claude', 'pipeline-stages.json');
  let data = {};
  if (existsSync(p)) {
    try { data = JSON.parse(readFileSync(p, 'utf8')); }
    catch { return { ok: false, path: p, why: '設定檔讀不懂,為了不蓋掉你原本的內容,這次不動它' }; }
  }
  data.tiers = tiers;
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  return { ok: true, path: p };
}

export function rankOf(id, levels) {
  return RANKS.findIndex((r) => levels[r]?.id === id);
}

/** 機器算的那一級:只看檔案落在哪裡。 */
export function computeTier(files, { code, danger, levels }) {
  const inCode = (f) => code.some((p) => f === p.slice(0, -1) || f.startsWith(p));
  const inDanger = (f) => danger.some((d) => (d.endsWith('/') ? f.startsWith(d) : f === d));
  const hits = { danger: files.filter(inDanger), code: files.filter((f) => inCode(f) && !inDanger(f)) };
  const rank = hits.danger.length ? 2 : hits.code.length ? 1 : 0;
  return { rank, id: levels[RANKS[rank]].id, hits };
}

/**
 * 人調高的那一級(事件 tier_set／tier_retracted,source:'human')。
 * ⚠️ 跟著**這次改動**走,換了一輪就歸零:有章時蓋章之後;沒章時這一輪開始之前說的(規格:這一輪的起點 AC-1)。
 *    否則上星期說的「這次算第三級」會一直掛著,而它講的早就不是這次了。
 * ⚠️ 以前沒章時是「存檔(commit)之後就歸零」——存檔的是 Claude,收工前一存,你說的 T2 就不見了(2026-09-22 實測)。
 *    起點問不到(沒有這一輪的紀錄)才退回舊規則:畫面那時也只看還沒存檔的,兩邊是同一個基準。
 */
export function manualTier(events, cwd, { cpUsable, cpAt, head, originAt = null }) {
  let cur = null;
  for (const e of events) {
    if (e.cwd !== cwd) continue;
    if (e.event === 'tier_set') cur = e;
    else if (e.event === 'tier_retracted') cur = null;
  }
  if (!cur) return null;
  const originMs = originAt ? Date.parse(originAt) : NaN;
  const expired = cpUsable
    ? (cpAt && new Date(cur.ts) <= new Date(cpAt))
    : Number.isFinite(originMs) ? Date.parse(cur.ts) < originMs : (head && cur.head !== head);
  if (expired) return null;
  return { id: cur.level, why: cur.why ?? '', ts: cur.ts };
}

/**
 * 這一級「需要」的每一項現在的狀態。五種,呼叫端不准折成打勾:
 *   ok(有紀錄而且你說處理完了／這次有測試檔)、ran(有紀錄,還沒人說處理完)、missing(沒有紀錄)、unknown(問不到／這一關不適用)、
 *   linked(寫規格那一關:規格是別的對話寫的,Claude 用 --spec 記了照哪份施工——施工對話認規格 AC-7)
 * ⚠️ 「沒有紀錄」不等於「沒跑過」(L3),文案沿用五關那一區的說法。
 * spec 是 roundView 算的規格線索(這個對話的連結／分不出是誰記的那筆)。**另開一個欄位,不借 A 的呼叫時間**:
 *   連結不是 A 的一次呼叫,混進 perStage 的話,「A 跑過」跟「照別人寫的圖施工」在畫面上會長得一樣。
 * rerun 是 roundView 算好的「要不要再跑」(lib/events.mjs 的 rerunOf,關卡代號 → 判斷)。結論會過期的關(D)只讀它,
 *   這裡不另外比時間(D 多輪先問人 AC-9:以前這裡比結論時間、收工 hook 比被叫的時間,同一件事兩種答案)。沒給 → 「問不到」,不猜。
 */
export function requirementStatus(requires, { stages, perStage, cleared, health, reports = new Map(), spec = null, rerun = new Map(), ago = null }) {
  const specStage = stages.find((s) => s.skill);   // 寫規格的那一關 = 第一個指令關(跟一輪的分界同一個認法)
  return requires.map((r) => {
    if (r === 'tests') {
      const n = health?.touchedTests ?? null;
      return { key: 'tests', label: '補測試', state: n === null ? 'unknown' : n > 0 ? 'ok' : 'missing',
               detail: n === null ? '問不到' : n > 0 ? `這次有 ${n} 個測試檔被新增或修改` : '這次沒有新增或修改任何測試檔' };
    }
    const st = stages.find((s) => s.id === r);
    if (!st) return { key: r, label: r, state: 'unknown', detail: '關卡清單裡沒有這一關' };
    const label = `${st.id} ${st.name}`;
    if (st.type === 'not-built') return { key: r, label, state: 'unknown', detail: '這一關未建' };
    if (st.type === 'main-conversation') return { key: r, label, state: 'unknown', detail: '就是你在講話的那個對話' };
    if (st.id === specStage?.id && spec?.link) {
      return { key: r, label, state: 'linked', ts: null, detail: `規格是別的對話寫的：${spec.link.name}（Claude 說的）` };
    }
    // E 驗收(瀏覽器那一關,E 自動驗收 AC-8):這一級要的是「Claude 照規格走過一遍」;只有你說驗收過了才打勾——Claude 走完是「跑過」,不是 ok(R2)。
    // 講的話跟 E 那一格同一句(lib/verify.mjs 的 eLines,AC-7):以前這裡自己再寫一份,Claude 代記被講成「你說」、漏報的條目不見、時間用叫 verify 的那一刻
    // (魔鬼教官第一輪,老毛病 P2)
    if (st.rerunAfterChange && st.type === 'browser') {
      const rr = rerun.get(st.id) ?? null;
      const el = rr?.view ? eLines(rr.view, { ago: ago ?? ((t) => String(t ?? '')) }) : null;
      if (!rr || !el) return { key: r, label, state: 'unknown', ts: null, detail: '問不到走過沒' };
      const es = rr.estate ?? rr.state;
      const ts = rr.last?.call?.ts ?? null;
      if (es === 'accepted') return { key: r, label, state: 'ok', ts: rr.accept?.coverTs ?? ts, clearedAt: rr.accept?.coverTs ?? null, detail: el.human };
      if (es === 'none') return { key: r, label, state: 'missing', detail: el.walk, ts: null };
      // 你的驗收之後又改了程式／你說不用再走(錨在你的驗收):講的是你那一句;其他:講 Claude 走一趟那一句,還沒驗收的再補「還沒有人說驗收過了」
      if (es === 'accepted-stale' || (es === 'skipped' && rr.acceptDecision?.covered)) return { key: r, label, state: 'ran', ts, detail: el.human };
      return { key: r, label, state: 'ran', ts, detail: es === 'ok' || es === 'found' ? `${el.walk}——${el.human}` : el.walk };
    }
    // 結論會過期的關(D):「要不要再跑」讀同一份判斷,說同一句話(rerunLine)。你說不用再跑也不算 ok——那是你的決定,不是驗過了(R2)
    if (st.rerunAfterChange) {
      const rr = rerun.get(st.id) ?? null;
      if (!rr) return { key: r, label, state: 'unknown', ts: null, detail: '問不到要不要再跑' };
      if (rr.state === 'none') return { key: r, label, state: 'missing', detail: '沒有紀錄', ts: null };
      const ts = rr.last.call.ts;
      const c = rr.concluded;
      const head = String(c?.note ?? '').split('\n')[0].trim();
      if (rr.state === 'ok') return { key: r, label, state: 'ok', ts, clearedAt: c.ts, detail: c.human ? '跑過,你說處理完了' : `跑過,Claude 說${head ? `：${head}` : '沒問題'}` };
      return { key: r, label, state: 'ran', ts, detail: `跑過,${rerunLine(rr, { ago })}` };   // 找到問題／叫了沒記結論／要不要再跑／你說不用再跑
    }
    const run = perStage.get(st.id) ?? null;
    if (!run && st.id === specStage?.id && spec?.unsure) {
      return { key: r, label, state: 'unknown', ts: null, detail: `有一筆規格連結（${spec.unsure.name}）分不出是哪個對話記的，不算數也不擋` };
    }
    // 工作區層級、這個工作區這一輪有好幾個對話、有人記了連結:不是「沒有紀錄」,是這一層分不出來(R1,魔鬼教官 2026-09-21)
    if (!run && st.id === specStage?.id && spec?.shared) {
      return { key: r, label, state: 'unknown', ts: null, detail: '這個工作區有好幾個對話，有對話記了規格連結，這裡分不出是不是這一個（看各對話的頁面）' };
    }
    if (!run) return { key: r, label, state: 'missing', detail: '沒有紀錄', ts: null };
    // 結案的證據:Claude 記的結論(ok)或人說處理完了——都只認這一次跑之後的那筆,而且要說得出是誰說的(五關自動結案 AC-11)
    const rep = reports.get(st.id) ?? null;
    const repAfter = rep && new Date(rep.ts) >= new Date(run.ts) ? rep : null;
    const clr = cleared.get(st.id);
    const done = !!clr && new Date(clr.ts) >= new Date(run.ts);
    const head = String(repAfter?.note ?? '').split('\n')[0].trim();   // 清單住在五關那一區,這裡只講結論那一行
    if (repAfter?.verdict === 'ok') return { key: r, label, state: 'ok', ts: run.ts, clearedAt: repAfter.ts, detail: `跑過,Claude 說${head ? `：${head}` : '沒問題'}` };
    if (done) return { key: r, label, state: 'ok', ts: run.ts, clearedAt: clr.ts, detail: '跑過,你說處理完了' };
    if (repAfter) return { key: r, label, state: 'ran', ts: run.ts, detail: `跑過,Claude 說找到問題${head ? `：${head}` : ''},還沒處理完` };
    return { key: r, label, state: 'ran', ts: run.ts, detail: '跑過,Claude 還沒記結論' };
  });
}

/**
 * 「這個檔算不算改到程式」——給五關用(五關自動結案 AC-3、AC-4):B 有沒有在動、A 是不是開工了,還有收工 hook 判「這一回合改了沒」。
 * 有分級設定就查程式區＋危險清單(跟分級同一份判斷,老毛病 P2);沒有就退回「不在 docs/、不是 .md」——
 * 至少 A 自己寫的規格檔不會被算成開工。三處共用這一個,不准各寫各的。
 */
export function codeFileFn(root, cfg = null) {
  return (file) => {
    if (typeof file !== 'string' || !file) return false;
    const rel = isAbsolute(file) ? relative(root, file) : file.replace(/^\.\//, '');
    if (!rel || rel.startsWith('..')) return false;
    if (cfg) return computeTier([rel], cfg).rank > 0;
    return !/^docs\//.test(rel) && !/\.md$/i.test(rel);
  };
}

/**
 * git 說這次改了的程式檔,配上檔案的修改時間——B 在動的第二種證據(魔鬼教官 2026-09-16 抓到:用 Bash 寫檔感測器看不到,L8,
 * 這個對話改了 30 個檔,B 還寫「這一輪還沒改到程式檔」)。只給時間,不給內容;list 是 changeHealth 算的那份(含新檔案)。
 * ⚠️ 存檔過的也在 list 裡:沒章時 list 是從這一輪的起點算的(lib/origin.mjs),不是從上一次存檔(Oscar 2026-09-16:「一 commit,B 的證據就不見了」)。
 * ⚠️ 時間一律看檔案本身,**不拿存檔(commit)的時間頂**——存檔不是改檔。以前拿存檔時間當改檔時間,D 說沒問題之後
 *    只要一存檔,D 就變成「之後又改了程式檔,要再跑一次」(2026-09-22 實測;D 多輪先問人 AC-9 定的「存檔不算動工」)。
 *    刪掉的檔看它所在資料夾的時間(changeTimeOf)。
 */
export function gitCodeChanges(root, list, isCode) {
  const out = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (!isCode(f)) continue;
    const t = changeTimeOf(root, f);
    if (t !== null) out.push({ file: f, mtime: new Date(t).toISOString() });
  }
  return out.sort((a, b) => a.mtime.localeCompare(b.mtime));
}

/**
 * 一個檔「最後一次變動」的時間(毫秒)。五關的 B、D 過期、收工 hook 的「這一回合改了沒」都用這一個(老毛病 P2)。
 * 檔案在:它的修改時間。被刪了:它所在資料夾的修改時間(資料夾也不在就往上找)——資料夾裡有檔案被刪(或新增、改名)時會更新,
 *   所以它是刪除時間的**上限**:只會說得比實際晚(D 多要一次),不會比實際早。
 * ⚠️ 以前刪掉的檔就沒有時間:D 說沒問題之後只刪檔,收工 hook 安靜放行、D 照樣結案——「沒有時間」被讀成「之後沒改過」(魔鬼教官 2026-09-22,R1)。
 * 連工作區本身都問不到才回 null。
 */
export function changeTimeOf(root, file) {
  try { return statSync(join(root, file)).mtimeMs; } catch { /* 刪掉了:看它所在的資料夾 */ }
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const top = dir === '.' || dir === '/' || dir === '';
    try { return statSync(top ? root : join(root, dir)).mtimeMs; } catch { /* 資料夾也被刪了,往上找 */ }
    if (top) return null;
  }
}

/**
 * 給 roundView 的「這個檔現在的修改時間」(感測器記的是絕對路徑):不在這個資料夾裡的回 null。跟 changeTimeOf 同一套(刪掉的看資料夾)。
 * 感測器記過的程式檔用 Bash 還原、git 就說沒差,只有它看得到(E 自動驗收,魔鬼教官第一輪,老毛病 P1)。
 */
export function fileTimeOf(root) {
  return (f) => {
    const rel = isAbsolute(String(f)) ? relative(root, String(f)) : String(f);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? changeTimeOf(root, rel) : null;
  };
}

/** 名字像會存東西的檔案。**只是提醒**——出現在「這次動到、在程式區、不在危險清單」的檔案上,不決定任何事。 */
const LOOKS_LIKE_STORAGE = /(stor|save|persist|database|\bdb\b|backup|sync|export|upload|ledger|model|cloud)/i;
export function candidateFiles(files, { code, danger }) {
  const inCode = (f) => code.some((p) => f.startsWith(p));
  const inDanger = (f) => danger.some((d) => (d.endsWith('/') ? f.startsWith(d) : f === d));
  return files.filter((f) => inCode(f) && !inDanger(f) && LOOKS_LIKE_STORAGE.test(basename(f)));
}

/**
 * 整段分級的事實,一次算好。終端機與網頁都吃這個物件,各自只負責畫。
 * state:unset／off／broken／no-base(還沒有 commit)／unknown(問不到改動)／no-change／unseen／ok
 *   ⚠️ no-change 與 unseen 是同一個 0 的兩種意思(老毛病 P5),不准畫成同一張臉:
 *      no-change = 從這一輪的起點(或章)算,真的沒有改動;
 *      unseen    = 起點問不到、只看得到還沒存檔的,而還沒存檔的沒有——存檔過的看不到,分不了級(規格:這一輪的起點 AC-4);
 *                  或這一輪中間 HEAD 動過(存到別的分支又切回來),現在跟起點一樣——不在這條線上的存檔看不到(魔鬼教官 2026-09-22)
 * basis 是 lib/origin.mjs 的 changeBase() 算的基準(health 就是照它算的),原樣帶給畫面講「從哪裡算起」;沒給的話照舊當成有基準。
 */
export function buildTier({ root, mainRoot, monitorDir, health, stages, perStage, cleared, events, cwd, cpUsable, cpAt, head, hasCommits = true,
                            reports = new Map(), spec = null, basis = null, rerun = new Map(), ago = null }) {
  const cfg = readTierConfig(root, mainRoot, monitorDir);
  const base = { state: cfg.state, from: cfg.from ?? null, off: cfg.off ?? null, why: cfg.why ?? null };
  if (cfg.state !== 'ok') return base;
  const c = cfg.config;
  const dangerEmpty = c.danger.length === 0;
  const common = { ...base, dangerEmpty, levels: c.levels, code: c.code, dangerCount: c.danger.length, basis };
  // 一個 commit 都沒有 → 沒有基準,「這次改動」不成立。這不是「問不到」,要分開講
  if (!hasCommits) return { ...common, state: 'no-base' };
  if (!health || health.files === null || !Array.isArray(health.list)) return { ...common, state: 'unknown' };
  if (!health.list.length) return { ...common, state: basis?.kind === 'head' || basis?.moved ? 'unseen' : 'no-change' };

  const machine = computeTier(health.list, c);
  // 章不能用的話,「這一輪」從起點算——跟 health 同一個起點
  const m = manualTier(events, cwd, { cpUsable, cpAt, head, originAt: basis && basis.kind !== 'checkpoint' ? basis.origin?.at ?? null : null });
  const mRank = m ? rankOf(m.id, c.levels) : -1;
  const manual = m && mRank > machine.rank ? { ...m, rank: mRank } : null;
  const finalRank = manual ? mRank : machine.rank;
  const level = c.levels[RANKS[finalRank]];
  return {
    ...common,
    machine, manual,
    // 你說的沒有比機器算的高 → 不採用,但要講(不然人會以為自己調高了)
    manualIgnored: m && !manual ? m : null,
    // agents:這一級的 D 第一輪可不可以派獨立 agent(stages.json 的 tierLevels.agentsOnFirstRound;D 多輪先問人 AC-11)。沒寫就是不可以——最省
    final: { rank: finalRank, id: level.id, requires: level.requires ?? [], agents: level.agentsOnFirstRound === true },
    requirements: requirementStatus(level.requires ?? [], { stages, perStage, cleared, health, reports, spec, rerun, ago }),
    candidates: candidateFiles(health.list, c),
    upgradable: RANKS.slice(machine.rank + 1).map((r) => c.levels[r].id),
  };
}

/* ────────────── --tier-init:提議程式區 ────────────── */

const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|vue|svelte)$/;
const NOT_CODE = new Set(['node_modules', 'dist', 'build', 'out', 'docs', 'doc', 'test', 'tests', '__tests__',
                          'scripts', 'public', 'static', 'coverage', '_archive', '.claude', '.github', '.git']);

/**
 * 提議「程式區」。三個線索,由強到弱:package.json 指向哪、git 追蹤的程式檔最多在哪、硬碟上的程式檔最多在哪。
 * ⚠️ 只是提議,寫進設定檔之前要給人看。認不出就回 null——不要硬湊一個。
 */
export function proposeCodeArea(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const k of ['source', 'module', 'main']) {
      const v = typeof pkg[k] === 'string' ? pkg[k].replace(/^\.\//, '') : null;
      const top = v && v.includes('/') ? v.split('/')[0] : null;
      if (top && !NOT_CODE.has(top)) return { dirs: [`${top}/`], why: `package.json 的 ${k} 指向 ${v}` };
    }
  } catch { /* 沒有 package.json 或讀不懂,往下找 */ }

  const count = new Map();
  const bump = (f) => {
    if (!CODE_EXT.test(f) || !f.includes('/')) return;
    const top = f.split('/')[0];
    if (NOT_CODE.has(top) || top.startsWith('.')) return;
    count.set(top, (count.get(top) ?? 0) + 1);
  };
  let tracked = '';
  try { tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { tracked = ''; }
  for (const f of tracked.split('\n')) bump(f);
  let source = 'git 追蹤的程式檔';
  if (!count.size) {
    // 一個 commit 都沒有的專案 git 什麼都不知道,退而看硬碟(最多往下四層)
    source = '資料夾裡的程式檔';
    const walk = (dir, rel, depth) => {
      if (depth > 4) return;
      let ents = [];
      try { ents = readdirSync(dir); } catch { return; }
      for (const e of ents) {
        if (e.startsWith('.') || NOT_CODE.has(e)) continue;
        const full = join(dir, e), r = rel ? `${rel}/${e}` : e;
        let st; try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full, r, depth + 1); else bump(r);
      }
    };
    walk(root, '', 0);
  }
  const best = [...count].sort((a, b) => b[1] - a[1])[0];
  return best ? { dirs: [`${best[0]}/`], why: `${source}最多的資料夾（${best[1]} 個）` } : null;
}
