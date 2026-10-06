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
import { readProjectConfig, rerunLine, saidByHuman } from './events.mjs';
import { eLines } from './verify.mjs';
import { ago as agoNow } from './git.mjs';

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
  // 人記的「危險清單判斷過」(--tier-checked;規格:危險清單會過期 AC-3)。時間讀不懂 → 當成沒記過,不准當成剛判斷過
  // by:誰記的——在對話裡跑的(Claude 代記)、還是你自己在終端機跑的。附的話是記的人打的字,Claude 代記的不准講成「你說」(老毛病 P7)
  // snap:判斷那一刻的快照——那時的版本(HEAD)與那時還沒存檔的程式檔(規格:收工hook問危險清單 AC-2)。
  //   兩樣都讀得懂才算;版本寫壞、清單不是字串陣列 → 當成沒有快照,退回用時間算(多問,不少問)
  const ck0 = t.checked && typeof t.checked === 'object' && Number.isFinite(Date.parse(t.checked.at)) ? t.checked : null;
  const snapOk = ck0 && typeof ck0.commit === 'string' && /^[0-9a-f]{7,64}$/i.test(ck0.commit)
    && Array.isArray(ck0.files) && ck0.files.every((f) => typeof f === 'string');
  const ck = ck0
    ? { at: ck0.at, said: typeof ck0.said === 'string' ? ck0.said : null, by: ck0.by === 'human' ? 'human' : 'claude',
        snap: snapOk ? { commit: ck0.commit, files: ck0.files.map(normEntry) } : null } : null;
  return {
    state: 'ok', from,
    config: { code: t.code.map(normDir), danger: (t.danger ?? []).map(normEntry), levels, checked: ck },
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
    // 一次 A 寫了好幾份:講寫了哪幾份——跟 A 那格同一件事(roundView 算的 spec.wrote)。只取最後一筆結論的第一行,
    // 就只講最後交的那份,同一頁兩句話(魔鬼教官第一輪,老毛病 P2、L32)
    const wrote = st.id === specStage?.id && spec?.wrote?.length > 1 ? spec.wrote : null;
    if (repAfter?.verdict === 'ok') return { key: r, label, state: 'ok', ts: run.ts, clearedAt: repAfter.ts,
      detail: wrote ? `跑過,Claude 說寫了 ${wrote.length} 份規格：${wrote.join('、')}` : `跑過,Claude 說${head ? `：${head}` : '沒問題'}` };
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

/* ────────────── 危險清單會過期(規格:危險清單會過期,路徑看 CLAUDE.md 的表) ──────────────
 * 危險清單是某一天拍的照片:之後才新加的程式檔、改了名的危險檔,分級永遠不會算成最高那一級,畫面卻不講(R1)。
 * 這裡只**講出來**,不升級、不把檔加進清單——工具不猜危險清單(CLAUDE.md 刻意的決定)。
 * ⚠️ 2026-10-05 實測:pipeline-monitor 的設定檔 9/23 存過一次,但改的是三級定義,危險清單 9/16 之後沒變——
 *    拿「設定檔最後一次存檔」當清單定好的時間,9/16～9/23 新加的 5 個檔就被當成考慮過了。所以只看危險清單那一段。 */

/**
 * 一個 git 指令;問不到回 null,不丟例外。
 * ⚠️ core.quotepath=false:不關的話,中文檔名會變成 "src/\345\240\261..." 這種轉義,跟改動清單(lib/git.mjs 的 git() 關了)對不上——
 *    清單定好之後新加的中文檔名程式檔永遠不會被講出來,--tier-review 還說「之後沒有新加」(魔鬼教官第一輪,老毛病 P1、R1)。
 */
function gitOut(cwd, args) {
  try { return execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
// 「現在這份清單從哪一次存檔起」要把設定檔的每一版拿出來比:常駐的儀表板每幾秒算一次,同一份歷史只算一次
const sinceCache = new Map();

/**
 * 危險清單什麼時候定的(AC-1、AC-4)。兩個來源取較晚的:
 *   人記的判斷時間(tiers.checked,--tier-checked 寫的);
 *   git 說「現在這份危險清單」從哪一次存檔起就是這樣——設定檔別的地方變(三級定義、關卡)不算。
 *   工作區裡的清單跟最後一次存檔的不一樣(改了還沒存)、設定檔沒進版控、git 問不到 → git 這條沒有。
 * @param from 設定檔的路徑(readTierConfig 的 from)
 * @returns {{ at:string, how:'checked'|'git', commit:string|null, said:string|null, by?:'claude'|'human' } | null}  都沒有 → null(分不出,R1)
 */
export function dangerSince(from, config) {
  let viaGit = null;
  if (from) {
    const dir = dirname(dirname(from));            // .claude 所在的那一層
    const rel = '.claude/pipeline-stages.json';
    const log = gitOut(dir, ['log', '--format=%H %cI', '--', rel]);
    const commits = (log ?? '').split('\n').filter(Boolean).map((l) => { const [sha, at] = l.split(' '); return { sha, at }; });
    const key = `${dir}\n${commits[0]?.sha ?? ''}\n${JSON.stringify(config.danger)}`;
    if (sinceCache.has(key)) viaGit = sinceCache.get(key);
    else {
      let found = null;
      for (const c of commits) {                    // 新的往舊的走:跟現在這份一樣就往前,不一樣就停
        let d = null;
        try {
          const t = JSON.parse(gitOut(dir, ['show', `${c.sha}:${rel}`]) ?? '').tiers;
          if (t && typeof t === 'object' && !t.off && Array.isArray(t.code)) d = Array.isArray(t.danger) ? t.danger.map(normEntry) : [];
        } catch { d = null; }
        if (d === null || !sameSet(d, config.danger)) break;
        found = c;
      }
      viaGit = found ? { at: found.at, how: 'git', commit: found.sha, said: null } : null;
      if (log !== null) sinceCache.set(key, viaGit);
    }
  }
  const ck = config.checked
    ? { at: config.checked.at, how: 'checked', commit: null, snap: config.checked.snap ?? null, said: config.checked.said, by: config.checked.by } : null;
  if (viaGit && ck) return Date.parse(ck.at) > Date.parse(viaGit.at) ? ck : viaGit;
  return ck ?? viaGit;
}

// 一個版本裡有哪些檔(git ls-tree)。版本號指的內容永遠不變,算一次就留著——常駐的儀表板每幾秒算一次
const treeCache = new Map();
function treeOf(root, sha) {
  const key = `${root}\n${sha}`;
  if (treeCache.has(key)) return treeCache.get(key);
  const out = gitOut(root, ['ls-tree', '-r', '--full-tree', '--name-only', sha]);
  const set = out === null ? null : new Set(out.split('\n').filter(Boolean));
  if (set) treeCache.set(key, set);
  return set;
}
/** 這個工作區現在的檔:追蹤的＋還沒追蹤的(不含 gitignore 的)。問不到 → null。 */
function workingFiles(root) {
  const tracked = gitOut(root, ['ls-files']);
  const untracked = gitOut(root, ['ls-files', '--others', '--exclude-standard']);
  return tracked === null || untracked === null ? null : [...new Set([...tracked.split('\n'), ...untracked.split('\n')])].filter(Boolean);
}

/**
 * 「那一刻」的快照:那時候已經在、清單(或判斷)可能考慮過的檔(規格:收工hook問危險清單 AC-2)。不在快照裡的,才是之後才新加的。
 *   git 說的那一次:那個版本裡的檔。人記的判斷:判斷那一刻的版本裡的檔＋那一刻還沒存檔的程式檔(--tier-checked 記的)。
 * ⚠️ 以前拿時間猜(那之後的存檔新增的、修改時間比較晚的):判斷時還沒存檔的新檔,一存檔就變成「判斷之後才新加的」——
 *    判斷過的檔又被講成「危不危險還沒有人判斷」,收工 hook 每存一次檔就再擋一次(2026-10-06 寫下一份規格時重現;
 *    老毛病 P9:存檔的時間不是事情發生的時間)。
 * 沒有快照(舊的判斷紀錄沒記版本)、版本問不到 → null,呼叫端退回用時間算(多問,不少問)。
 */
function snapshotOf(root, since) {
  if (since.how === 'git' && since.commit) return treeOf(root, since.commit);
  if (since.how === 'checked' && since.snap) {
    const t = treeOf(root, since.snap.commit);
    return t ? new Set([...t, ...since.snap.files]) : null;
  }
  return null;
}

/**
 * --tier-checked 那一刻的快照(AC-2):現在的版本(HEAD),與現在還沒存檔、在程式區的檔。判斷過的就是這些——
 * 之後存檔、再改,都還是判斷過的那一個檔。問不到(一次存檔都沒有、git 問不到)→ null:只記時間,之後退回用時間算。
 */
export function checkSnapshot(root, config) {
  const head = (gitOut(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']) ?? '').trim();
  if (!/^[0-9a-f]{7,64}$/i.test(head)) return null;
  const t = treeOf(root, head);
  const files = workingFiles(root);
  if (!t || !files) return null;
  return { commit: head, files: files.filter((f) => !t.has(f) && computeTier([f], config).rank > 0 && existsSync(join(root, f))).sort() };
}

/**
 * 那之後才新加的檔(AC-1):不在「那一刻」快照裡的、這個工作區現在的檔(追蹤的＋還沒追蹤的)。問不到 → null(R1)。
 * 改名算新加——改了名的危險檔,新名字要有人看過(舊名字由 missingDanger 講)。
 * 沒有快照時(舊的判斷紀錄)才照以前用時間算:那之後存檔新增的＋修改時間比那一刻晚的還沒存檔的新檔。
 */
export function addedSince(root, since) {
  const snap = snapshotOf(root, since);
  if (snap) {
    const files = workingFiles(root);
    return files === null ? null : new Set(files.filter((f) => !snap.has(f)));
  }
  // ── 以下是沒有快照時的舊算法(時間) ──
  // 還沒追蹤的新檔沒有存檔時間:修改時間比那一刻早的,那一刻一定已經在了(建立 ≤ 修改)→ 不算新的;
  //   比那一刻晚的可能是新建、也可能是舊檔之後又改過——都算(多問一次,不會少問)
  const range = since.how === 'git' && since.commit ? [`${since.commit}..HEAD`] : [`--since=${since.at}`];
  const log = gitOut(root, ['log', ...range, '--diff-filter=A', '--no-renames', '--name-only', '--format=']);
  const untracked = gitOut(root, ['ls-files', '--others', '--exclude-standard']);
  // add 過、還沒存檔的新檔(git mv 改名之後的新名字就是這種):既不是還沒追蹤的,也還沒有存檔紀錄——不問它就漏掉(老毛病 P1)
  const staged = gitOut(root, ['diff', '--cached', '--diff-filter=A', '--no-renames', '--name-only']);
  if (log === null || untracked === null || staged === null) return null;
  const sinceMs = Date.parse(since.at);
  const mt = (p) => { try { return statSync(join(root, p)).mtimeMs; } catch { return Infinity; } };   // 問不到 → 當成之後(多問,不少問)
  const after = (f) => !(mt(f) < sinceMs);
  // add 過的新檔多半是 git mv 改名來的:搬家不改檔案的修改時間(老毛病 P1,roundFiles 那段說過),再看它所在資料夾的時間——搬進來會更新它。
  // 只對這一種看資料夾:還沒追蹤的也看的話,同一個資料夾之後新建任何檔,判斷過的那幾個就全部又被問一次
  const afterMoved = (f) => after(f) || !(mt(dirname(f)) < sinceMs);
  const unsaved = [...untracked.split('\n').filter(Boolean).filter(after), ...staged.split('\n').filter(Boolean).filter(afterMoved)];
  return new Set([...log.split('\n').filter(Boolean), ...unsaved]);
}

/** 危險清單裡已經不在這個工作區的那幾條(AC-2):檔、或 / 結尾的資料夾。 */
export function missingDanger(root, danger) {
  return danger.filter((d) => !existsSync(join(root, d.endsWith('/') ? d.slice(0, -1) : d)));
}

/**
 * 這一輪的「清單可能過期了」:碰到的新檔、清單裡不在的、分不出來的原因。
 * touched:這一輪碰到、在程式區、不在危險清單的檔(computeTier 的 hits.code)。沒碰到就不去問 git——平常不多花任何時間。
 */
export function staleOf(root, from, config, touched) {
  const missing = missingDanger(root, config.danger);
  if (!touched.length) return { since: null, fresh: [], missing, unknown: null };
  const since = dangerSince(from, config);
  if (!since) return { since: null, fresh: [], missing, unknown: 'no-time' };
  const added = addedSince(root, since);
  if (!added) return { since, fresh: [], missing, unknown: 'no-git' };
  return { since, fresh: touched.filter((f) => added.has(f) && existsSync(join(root, f))), missing, unknown: null };
}

/** 檔案列法:前三個,多的講「等 N 個」。分級卡與收工 hook 那一句用同一個(老毛病 P2)。 */
const fewFiles = (xs) => xs.slice(0, 3).join('、') + (xs.length > 3 ? ` 等 ${xs.length} 個` : '');
/** 清單「定好（X 前，git 說的）」或「判斷過（X 前）」:分級卡與收工 hook 同一個講法。 */
const whenOf = (since, ago) => (since.how === 'checked' ? `判斷過（${ago(since.at)}）` : `定好（${ago(since.at)}，git 說的）`);

/**
 * 那幾句話,只寫這一份(終端機印、伺服器帶著分級卡過去、網頁照印——老毛病 P2)。
 * dangerId:最高那一級的名字(從設定讀,程式碼不寫 T0／T1／T2);already:這次已經是那一級了,就不講「其實是」。
 */
export function staleLines(s, { dangerId, already = false, ago = agoNow }) {
  const out = [];
  const list = fewFiles;
  const ask = '跟 Claude 說「幫我看危險清單」';
  if (s.fresh.length) {
    const when = whenOf(s.since, ago);
    out.push(`⚠️ 這一輪碰到 ${s.fresh.length} 個危險清單${when}之後才新加的程式檔：${list(s.fresh)}——清單不可能考慮過，危不危險還沒有人判斷`
      + `${already ? '' : `；如果是危險的，這次其實是 ${dangerId}`}。要判斷就${ask}。`);
  } else if (s.unknown === 'no-time') {
    out.push(`⚠️ 危險清單沒記下是什麼時候定的，這一輪碰到的程式檔裡哪些是之後才新加的，這裡分不出來——判斷一次（${ask}）就分得出來。`);
  } else if (s.unknown === 'no-git') {
    out.push('⚠️ 問不到 git，這一輪碰到的程式檔裡哪些是危險清單定好之後才新加的，這裡分不出來。');
  }
  if (s.missing.length) {
    out.push(`⚠️ 危險清單裡有 ${s.missing.length} 個已經不在了：${list(s.missing)}——改了名或搬了家的話，新的名字不在清單上，碰到它也不會是 ${dangerId}。要修就${ask}。`);
  }
  return out;
}

/* ────────────── 收工 hook 問危險清單(規格:收工hook問危險清單,路徑看 CLAUDE.md 的表) ──────────────
 * 分級卡講了「這個新檔沒人判斷過」,沒人看卡就沒人問。收工 hook 擋一次,叫 Claude 先停下來問使用者——不准自己決定。 */

/** 收工 hook 擋這件事時記進 gate_blocked 的種類。「這次先不看」算不算數要找它,兩邊用同一個字串。 */
export const DANGER_ASK = 'danger:ask';

/**
 * 收工 hook 那一行(AC-1)。檔案列法、時間講法跟分級卡同一份(老毛病 P2)。
 * s:{ since, fresh }——fresh 是還要問的那幾個(使用者說過這次先不看的已經拿掉,deferred 是拿掉幾個);dangerId:最高那一級的名字。
 */
export function dangerAskLine(s, { dangerId, deferred = 0, ago = agoNow }) {
  return `- 危險清單：這一輪碰到 ${s.fresh.length} 個危險清單${whenOf(s.since, ago)}之後才新加、還沒人判斷過的程式檔：${fewFiles(s.fresh)}`
    + `${deferred ? `（另有 ${deferred} 個使用者說這次先不看）` : ''}——如果是危險的，這次其實是 ${dangerId}。`
    + '不要自己決定，先停下來問使用者（白話＋舉例）：每個檔用三個問題（會不會讀寫使用者做出來的東西；會不會碰儲存、雲端、資料庫、別人的原始檔；'
    + '改錯了是當場在畫面上看到，還是幾天後才發現）各附一句為什麼；'
    + `講清楚加進清單的話這一輪就變 ${dangerId}、收工前要補 ${dangerId} 要的關；最後一行給建議。他的答案會改這一輪的等級——先問完，再跑其他缺的關。`
    // --tier-checked 記的是「整份清單判斷過了」:只問這一輪碰到的就記,別的、沒給他看過的新檔也一起被當成判斷過(魔鬼教官第一輪,R1)
    + '問之前先跑 pipeline-status --tier-review，它列的每一個都要問（不只這一輪碰到的——--tier-checked 記的是整份清單判斷過了）。'
    + '每一個都判斷了：說加才加進 tiers.danger，再照他的原話 pipeline-status --tier-checked "使用者的原話"；'
    // 清單一改、一存檔,git 就說「清單從這次存檔起就是這樣」,那時在的檔全算考慮過——只改一部分,沒判斷的就被吃掉(魔鬼教官第二輪,R1)。
    // 這件事不替他決定:講清楚,讓他選
    + '只判斷了一部分：先跟他講清楚「清單一改、一存檔，沒判斷的那幾個就算清單考慮過了，之後不會再問」，讓他選一起判斷完、或清單這次先不動。'
    + '他說這次先不看：清單不動、不跑 --tier-checked，照他的原話 pipeline-status --tier-later "使用者的原話"';
}

/**
 * 上一次存檔(HEAD)那一版的危險清單。清單剛改過、還沒存檔時,「改之前定好的時間」照它算——--tier-review 在改之前列的就是那一份。
 * 問不到(設定檔沒進版控、讀不懂)→ null。
 */
export function committedDanger(from) {
  if (!from) return null;
  try {
    const t = JSON.parse(gitOut(dirname(dirname(from)), ['show', 'HEAD:.claude/pipeline-stages.json']) ?? '').tiers;
    return t && typeof t === 'object' && !t.off && Array.isArray(t.code) ? (Array.isArray(t.danger) ? t.danger.map(normEntry) : []) : null;
  } catch { return null; }
}

/**
 * 「這次先不看」(--tier-later,AC-3):這個對話記過、算數的那幾筆,蓋到哪些檔。收工 hook 與 --tier-later 都叫這一個。
 * 算數 = 這個對話記的(by_session 對得上;拿不到對話代號的不算),而且收工 hook 為這件事最後一次擋了之後、這筆之前,
 * 有使用者說的話——還沒擋過就看 since(這一輪開始)之後。跟 --decide 同一條規矩:不是人打的不算你說的(老毛病 P7)。
 * said:那一段裡感測器記的、使用者說的最後一句——「有說話」不等於「說了先不看」,給人對照(跟 --decide 附的那一句同一套;魔鬼教官第一輪)。
 * @returns {{ covered:Set<string>, recs:Array<{ ts:string, files:string[], quote:string|null, counted:boolean, said:string|null }> }}
 */
export function laterOf(events, { session, since = null }) {
  const covered = new Set(), recs = [];
  if (!session) return { covered, recs };
  const ms = (e) => Date.parse(e.ts);
  const blocks = events.filter((e) => e.event === 'gate_blocked' && e.session === session && Array.isArray(e.missing) && e.missing.includes(DANGER_ASK))
    .map(ms).filter(Number.isFinite);
  const words = events.filter((e) => e.session === session && saidByHuman(e) && Number.isFinite(ms(e)));
  const start = Date.parse(since);
  for (const e of events) {
    if (e.event !== 'tier_later' || e.by_session !== session || !Array.isArray(e.files)) continue;
    const at = ms(e);
    if (!Number.isFinite(at)) continue;
    const prior = blocks.filter((b) => b <= at);
    const from = prior.length ? Math.max(...prior) : Number.isFinite(start) ? start : -Infinity;
    const between = words.filter((w) => ms(w) > from && ms(w) <= at);
    const counted = between.length > 0;
    const files = e.files.filter((f) => typeof f === 'string');
    const last = between.reduce((p, w) => (!p || ms(w) >= ms(p) ? w : p), null);
    recs.push({ ts: e.ts, files, quote: typeof e.quote === 'string' ? e.quote : null, counted, said: typeof last?.prompt === 'string' ? last.prompt : null });
    if (counted) for (const f of files) covered.add(f);
  }
  return { covered, recs };
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
  const stale = staleOf(root, cfg.from, c, machine.hits.code);
  return {
    ...common,
    machine, manual,
    // 你說的沒有比機器算的高 → 不採用,但要講(不然人會以為自己調高了)
    manualIgnored: m && !manual ? m : null,
    // agents:這一級的 D 第一輪可不可以派獨立 agent(stages.json 的 tierLevels.agentsOnFirstRound;D 多輪先問人 AC-11)。沒寫就是不可以——最省
    final: { rank: finalRank, id: level.id, requires: level.requires ?? [], agents: level.agentsOnFirstRound === true },
    requirements: requirementStatus(level.requires ?? [], { stages, perStage, cleared, health, reports, spec, rerun, ago }),
    candidates: candidateFiles(health.list, c),
    // 危險清單可能過期了(規格:危險清單會過期):這一輪碰到的新檔、清單裡已經不在的。只講,不升級;句子在這裡算好,兩邊照印
    staleNotes: staleLines(stale, { dangerId: c.levels.danger.id, already: finalRank === 2, ago: ago ?? agoNow }),
    // 同一份事實給收工 hook(規格:收工hook問危險清單 AC-1):它不另算一份新檔清單(老毛病 P2)。只帶它要的,不帶判斷的原話
    stale: { fresh: stale.fresh, since: stale.since ? { at: stale.since.at, how: stale.since.how } : null, unknown: stale.unknown },
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
