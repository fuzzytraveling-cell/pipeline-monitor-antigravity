/**
 * events.mjs —— 讀感測器寫下的事件。規格:pipeline-sensor(路徑看 CLAUDE.md 的表)
 *
 * ⚠️ 這支檔案存在的唯一理由,是**分清楚三件長得一樣的事**(AC-1 / AC-7):
 *     ① 紀錄檔不存在        → 感測器還沒裝,或這個專案還沒用過 → 「還不知道」
 *     ② 紀錄檔存在但沒有事件 → 感測器裝了但沒收到東西       → 「感測器可能沒在運作」
 *     ③ 有事件,但沒有這一關   → 這一關**真的**沒跑過          → 「沒跑過」
 *   把①②講成③就是謊話,而且會害人重跑已經跑過的檢查,或以為驗過了其實沒有。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, isAbsolute, basename } from 'node:path';
import { readChecklist as readChecklistFile, batchOf, locateSpec, specHint } from './checklist.mjs';

const RETAIN_DAYS = 90;   // AC-5:保留三個月(2026-09-09 Oscar 決定)
/**
 * 感測器記使用者一句話的上限(字數)。⚠️ 這個數字住兩個地方:這裡、hook.sh 的 `.[0:200]`(jq 照字數截,剝掉 system-reminder 之後)。
 * 讀取端要知道它,才分得出「這句話就這麼長」跟「後面被截掉了」(第一句話的規格提示,施工對話認規格 AC-3)。
 * scripts/specLink.test.mjs 真的跑 hook.sh 對這個數字(老毛病 P2)。
 */
export const PROMPT_CAP = 200;
/** 感測器自己回報故障的檔案(hook.sh 也寫死這個名字)。它不是專案,讀專案清單時要跳過它——只跳它。 */
export const SENSOR_FILE = '_sensor.jsonl';

/**
 * 專案名 → 檔名。⚠️ 這是 hook.sh 那條 `LC_ALL=C tr -c 'A-Za-z0-9._-' '_'` 的 JS 翻譯,
 * 兩邊必須**逐位元組**一樣:hook 寫的是 `TutorPod_AI_v4.jsonl`,讀取端拿 `TutorPod AI v4` 去找
 * 就永遠「還沒有紀錄」(誠實修補 C1,2026-09-11)。
 * 逐位元組不是逐字元:中文一個字 3 bytes → 3 個底線,跟 tr 一樣。
 * 兩份實作的唯一共識來源是 scripts/sensor.test.mjs——它真的跑 hook.sh,對兩邊的答案。改任何一邊它會紅。
 */
export function safeName(name) {
  return Array.from(Buffer.from(String(name), 'utf8'), (b) => {
    const ch = String.fromCharCode(b);
    return /[A-Za-z0-9._-]/.test(ch) ? ch : '_';
  }).join('');
}

/** 某個專案的紀錄檔在哪。讀(readEvents)跟寫(--clear)都從這裡拿,不准各自拼字串(老毛病 P2)。 */
export function logFileOf(logDir, project) {
  return join(logDir, `${safeName(project)}.jsonl`);
}

/**
 * @returns {{state:'no-file'|'no-events'|'ok', events:Array, broken:Array}}
 *   state 刻意分三種,呼叫端不准折成布林。
 */
export function readEvents(logDir, project) {
  const file = logFileOf(logDir, project);
  if (!existsSync(file)) return { state: 'no-file', events: [], broken: [] };

  const events = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // ⚠️ AC-4:兩個 worktree 同時寫,萬一還是交錯了,壞行**跳過就好**,
      // 不得讓整份紀錄變成不可讀——一筆壞掉不該害死其他幾千筆。
    }
  }
  // 感測器自己回報的故障(例如 jq 不在)。這是 AC-1 的第二個來源。
  // ⚠️ 它是全機一份、不分專案——所以只能當「那幾次可能漏記」的警告,
  //    不能拿來蓋掉整區紀錄(誠實修補 D2:以前一有故障,幾千筆紀錄都被講成「裡面沒有東西」)。
  const brokenFile = join(logDir, SENSOR_FILE);
  const broken = existsSync(brokenFile)
    ? readFileSync(brokenFile, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return { ts: null, why: '看不懂的一行' }; }
      })
    : [];

  if (!events.length) return { state: 'no-events', events: [], broken };
  return { state: 'ok', events: rotate(file, events), broken };
}

/** AC-5:超過保留期限的丟掉。⚠️ 丟掉的是真的沒了——呼叫端問到更早的期間
 *  要回答「超過保留期限」,不是「沒跑過」。 */
function rotate(file, events) {
  const cutoff = Date.now() - RETAIN_DAYS * 86400_000;
  const kept = events.filter((e) => {
    const t = new Date(e.ts).getTime();
    return !Number.isFinite(t) || t >= cutoff;   // 時間讀不出來的**留著**,不要因為看不懂就刪
  });
  if (kept.length !== events.length) {
    try {
      writeFileSync(file, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } catch { /* 寫不回去不影響這次顯示,下次再試 */ }
  }
  return kept;
}

/**
 * 專案自己的設定檔 .claude/pipeline-stages.json(關卡覆寫與分級都住這一份)。
 * root 沒有就找主資料夾——worktree 常常沒有自己的一份(`.claude/*` 多半被 gitignore,不會跟著 checkout)。
 * 讀不懂要回 broken,呼叫端不准當成「沒有」(R1)。
 */
export function readProjectConfig(root, mainRoot = null) {
  for (const d of [...new Set([root, mainRoot].filter(Boolean))]) {
    const p = join(d, '.claude', 'pipeline-stages.json');
    if (!existsSync(p)) continue;
    try { return { data: JSON.parse(readFileSync(p, 'utf8')), from: p, broken: null }; }
    catch (e) { return { data: null, from: p, broken: String(e.message) }; }
  }
  return { data: null, from: null, broken: null };
}

/** 專案的關卡定義。專案自己的覆寫優先(AC-6:清單只有一份,但可以換一份)。
 *  ⚠️ 專案的檔案可能只有 tiers 沒有 stages——那時關卡要退回內建的,不能變成零關。 */
export function loadStages(monitorDir, projectRoot, mainRoot = null) {
  let builtin = [];
  try { builtin = JSON.parse(readFileSync(join(monitorDir, 'stages.json'), 'utf8')).stages ?? []; } catch { builtin = []; }
  const { data, from, broken } = readProjectConfig(projectRoot, mainRoot);
  if (broken || !Array.isArray(data?.stages)) return { stages: builtin, from: join(monitorDir, 'stages.json') };
  return { stages: data.stages, from };
}

/**
 * 每一關**最後一次**被呼叫是什麼時候。
 * ⚠️ AC-3:這裡算的是「跑過」。**沒有任何欄位代表「通過」**,因為感測器沒記,
 *    也不該記——它無從得知。
 */
/** 這一關的事件怎麼認:有 skill 就比 skill;有 tools(正則)就比工具名——E 驗收就是用它認瀏覽器工具。
 *  ⚠️ 認到的永遠只是「被呼叫」。瀏覽器開了 12 個動作不等於驗收通過(R2),畫面要照這樣講。 */
function matcherOf(s) {
  // plugin 帶的 skill 叫「pipeline-monitor:spec」,專案自己的叫「spec」——同一關,兩種名字都認
  if (s.skill) return (e) => e.skill === s.skill || String(e.skill ?? '').endsWith(`:${s.skill}`);
  if (s.tools) { const re = new RegExp(s.tools); return (e) => re.test(String(e.tool ?? '')); }
  return null;
}

/**
 * 你自己打的斜線指令**不經過 Skill 工具**(L19,2026-09-15 Forma Pro 實測):Claude Code 把 SKILL.md 展開成訊息,
 * 感測器只看到 UserPromptSubmit 的 prompt 開頭是「/pipeline-monitor:spec …」;Claude 自己去叫的才會走 Skill 工具。
 * 所以一關「被叫」有兩種證據:Skill 事件(via:'skill'),或訊息開頭就是這個指令(via:'typed')。
 * ⚠️ 打了不等於跑起來——指令不存在時 Claude Code 回「Unknown command」,感測器看不到那句。
 *    所以文案講「你叫了」,不講「跑過」;證據能證明的就只有這麼多(R2)。
 * 只認**開頭**:「你跑過 /spec 了嗎」是提到,不算;「/specs」名字沒整個對上,也不算。
 */
function typedRun(e, s) {
  if (!s.skill || e.hook !== 'UserPromptSubmit' || typeof e.prompt !== 'string') return null;
  const name = s.skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = e.prompt.match(new RegExp(`^\\s*/((?:[A-Za-z0-9_.-]+:)?${name})(?=\\s|$)`));
  if (!m) return null;
  const args = e.prompt.slice(m[0].length).trim();
  return { ...e, skill: m[1], args: args || null, via: 'typed' };
}

/** 一個事件算不算這一關的一次「被叫」:算就回標準化過的事件(帶 via),不算回 null。
 *  lastRunPerStage 跟 runsPerStage 都走這裡,不准各認各的(老毛病 P2)。 */
function runOf(e, s, match) {
  if (e.hook === 'PreToolUse' && match(e)) return { ...e, via: s.skill ? 'skill' : 'tool' };
  return typedRun(e, s);
}

export function lastRunPerStage(events, stages, cwd) {
  const mine = events.filter((e) => e.cwd === cwd);
  const out = new Map();
  for (const s of stages) {
    const match = matcherOf(s);
    if (!match) continue;
    const runs = mine.map((e) => runOf(e, s, match)).filter(Boolean);
    const last = runs.length ? runs[runs.length - 1] : null;
    // 瀏覽器那種一關會有很多筆(每個動作一筆):附上「最後那一輪(同一個對話)有幾個動作」,
    // 畫面才講得出「開瀏覽器跑過一輪(12 個動作)」而不是只有時間
    out.set(s.id, last ? { ...last, count: runs.filter((e) => e.session === last.session).length } : null);
  }
  return { perStage: out, sawAnyEventHere: mine.length > 0 };
}

/**
 * 「這一輪」——My Agent work flow 存在的目的是提醒**現在這件事**走到哪,不是歷史(Oscar 2026-09-15)。
 * 一輪從哪裡開始:最近一次「第一關」(通常是 A 寫規格)被叫,或最近一次蓋章——取較晚的那個。
 *   ⚠️ 用 commit 當分界是錯的:D 魔鬼教官通常在 commit **之前**跑,會把這次的 D 算成上一輪。
 * 一輪裡面:最後被叫的那一關是「現在這一關」(亮);比它早被叫的關是「已走過」(劃掉);還沒被叫的是空的。
 * 上一輪的紀錄不畫成線,只在空的關寫一句「上一輪 N 前跑過」——線多了會干擾判斷。
 *
 * ⚠️ 瀏覽器那一關(E 驗收)不一樣:叫 /chaos-check 就是在做 D,但開瀏覽器**不一定**是在做 E——
 *    Oscar 2026-09-15 抓到:Claude 開瀏覽器截圖儀表板,E 就亮了,讀起來像驗收做過了。
 *    所以瀏覽器動作只算「看過」(seen):畫面講「開過瀏覽器,去了哪」,**不亮、不算走到**;
 *    只有人說「驗收過了」(stage_cleared)才算走到、才劃掉前面的。算不算驗收,人說了算。
 *
 * @param runs   Map<關卡 id, 事件[]>(時間順序),用 runsPerStage() 算
 * @returns {{stages: Array, roundStart: string|null, current: object|null}}
 *   每關的 state:main／notbuilt／none／passed／current／done(現在這一關而且你說處理完了)
 */
/** B 的活動:感測器記到的改檔事件(Edit／Write／NotebookEdit 的 PostToolUse)。pick 決定範圍(工作區或對話)。
 *  ⚠️ 只拿來看「什麼時候」,不拿來數檔案——Bash 寫檔看不到(L8),數量歸 git。 */
export function editsOf(events, pick) {
  return events.filter((e) => pick(e) && e.hook === 'PostToolUse' && typeof e.file === 'string')
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

/** 結論的完整說明:太長的清單另存在檔案裡(noteFile),讀得到就整份給;讀不到要說「完整清單找不到」,不當成只有那一行(R1)。 */
export function reportText(rep) {
  const head = typeof rep?.note === 'string' ? rep.note : '';
  if (!rep?.noteFile) return head;
  try { return readFileSync(rep.noteFile, 'utf8').trim(); }
  catch { return `${head}\n（完整清單找不到：${String(rep.noteFile).split('/').slice(-1)[0]} 不見了）`; }
}

/** Claude 記的結論(事件 stage_report,source:claude):每一關最後一筆。pick 決定範圍(跟 cleared 同一種取法)。 */
export function reportsIn(events, pick) {
  const out = new Map();
  for (const e of events) if (e.event === 'stage_report' && e.stage && pick(e)) out.set(e.stage, e);
  return out;
}

/**
 * 一輪從哪裡開始,與這一輪照哪份規格施工。
 * 分界:最近一次「第一關」(A 那種一次呼叫一筆的 skill 關)被叫,或最近一次蓋章,取較晚的。
 *   瀏覽器那種一關一堆事件,拿它最後一筆當分界會把同一輪切碎(測試抓到的:E 的 3 個動作只剩 1 個)。
 * 規格連結(spec_link,Claude 用 pipeline-status --spec 記的)改了兩件事(施工對話認規格 AC-1、AC-5):
 *   ① 連結**不是** A 的一次呼叫——不移動分界、不參加「現在這一關」的排序、不算「你點頭開工」
 *   ② 已經連上一份規格,又叫 A 寫了**別份**(或寫了哪份看不到)→ 那次 A 是「另寫了一份」:不移動分界、不換掉施工清單。
 *      只有 A 寫的就是連著的那份時,才照舊算新的一輪(那份變成這個對話自己寫的,連結跟著失效)。
 *   蓋章之前的連結都過期了(AC-2:下一次 A 或蓋章之後失效);`--spec 無` 把連結清掉,並記得「Claude 說沒有」。
 * links 由呼叫端挑好範圍(這個對話的;或整個工作區只有一個對話時,那個對話的),specOfRun(A 的一次呼叫) 回它寫的規格檔(連不到回 null)。
 * ⚠️ 時間一律換成同一個鐘再比:感測器的時間只到秒(…:37Z),CLI 記到毫秒(…:37.433Z),字串比大小同一秒內會顛倒。
 */
export function roundOf(runs, stages, cpAt = null, { links = [], specOfRun = () => null } = {}) {
  const first = stages.find((s) => s.skill);
  const aRuns = first ? (runs.get(first.id) ?? []) : [];
  const cpMs = cpAt ? Date.parse(cpAt) : NaN;
  const afterCp = (ts) => !Number.isFinite(cpMs) || Date.parse(ts) >= cpMs;
  // 同一秒的 A 排在連結前面:A 的時間只到秒,真的先後一定是 A 先(同一秒內 Claude 不會先記連結再叫 A)
  const items = [
    ...aRuns.filter((r) => afterCp(r.ts)).map((r) => ({ at: Date.parse(r.ts), k: 0, a: r })),
    ...links.filter((l) => afterCp(l.ts)).map((l) => ({ at: Date.parse(l.ts), k: 1, l })),
  ].filter((x) => Number.isFinite(x.at)).sort((x, y) => x.at - y.at || x.k - y.k);
  let start = null, link = null, none = null;
  let side = [];
  let sideNow = [];   // 這一段連著的期間另寫的(換成另一份連結也算同一段;記了「無」或算新的一輪才清掉)
  for (const x of items) {
    if (x.l) {
      if (x.l.none) {
        // Claude 說不照那份了(--spec 無):連著期間另寫的那幾次 A 回到一般的 A——最後一次就是這一輪的開始,它寫的那份就是這一輪的規格。
        // 不還原的話,A 明明跑過卻畫成「這一輪還沒跑」,而那份又是這個對話自己寫的、--spec 收不下,卡住出不去(魔鬼教官 2026-09-21)
        if (link && sideNow.length) { start = sideNow.at(-1).run.ts; side = side.filter((y) => !sideNow.includes(y)); }
        link = null; none = x.l; sideNow = [];
      } else { link = x.l; none = null; }
      continue;
    }
    if (link) {
      const f = specOfRun(x.a);
      if (!f || basename(f) !== basename(String(link.spec ?? ''))) { const it = { run: x.a, file: f }; side.push(it); sideNow.push(it); continue; }
    }
    start = x.a.ts; link = null; none = null; sideNow = [];
  }
  const at = [start, cpAt].filter(Boolean).sort((p, q) => Date.parse(p) - Date.parse(q)).at(-1) ?? null;
  return { start: at, link, none, side };
}

/** 只要分界的呼叫端用這個。⚠️ 要跟 roundView 同一個分界,就要給同一份 links／specOfRun——所以 git 的證據改成交給 roundView 自己算(gitChanges 可以是函式)。 */
export function roundStartOf(runs, stages, cpAt = null, opts = {}) {
  return roundOf(runs, stages, cpAt, opts).start;
}

/* ────────────── 規格連結(施工對話認規格) ────────────── */

/** 某個工作區的規格連結,時間順序。 */
export function specLinksIn(events, cwd) {
  return events.filter((e) => e.event === 'spec_link' && e.cwd === cwd && Number.isFinite(Date.parse(e.ts)))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** 感測器的時間只到秒,CLI 記到毫秒:「記的那一刻之前」要留一秒的餘裕。 */
const LINK_SKEW_MS = 1000;

/**
 * 一筆規格連結是哪個對話記的(施工對話認規格 AC-2)。
 *   ① 紀錄裡有對話代號(by_session:Claude Code 給指令的環境變數 CLAUDE_CODE_SESSION_ID,2026-09-21 實測有給)→ 就是它
 *   ② 沒有(舊版、或人自己在終端機跑)→ 只有「記的那一刻之前,這個工作區只有一個對話」才歸給它(how:'only');
 *      有別的對話來過就不歸給任何人,畫面寫「分不出是哪個對話記的」、不擋人。寧可不歸屬,也不把一個對話的清單套到別的對話上。
 *      ⚠️ 規格原本寫「歸給那一刻最近開口的對話」——但只用 Bash 在做事的對話感測器一筆都看不到(L8),
 *         會被當成沒在動,連結就算到另一個剛好開口的對話頭上(魔鬼教官 2026-09-21 實驗重現)。所以收緊成「只有一個對話」。
 *      candidates:分不出來時可能是誰——那一刻最近開口的對話,加上它開口之後也在動的(只有這幾個的頁面會講「分不出」)。
 * 只看記的那一刻之前的紀錄:之後發生的事不改變「那一刻是誰記的」。
 * @returns {{session:string|null, how:'id'|'only'|null, candidates:string[]}}
 */
export function linkOwner(link, events) {
  const id = typeof link?.by_session === 'string' ? link.by_session.trim() : '';
  if (id) return { session: id, how: 'id', candidates: [id] };
  const t = Date.parse(link?.ts);
  if (!Number.isFinite(t)) return { session: null, how: null, candidates: [] };
  const before = events.filter((e) => e.cwd === link.cwd && e.hook && e.session && Date.parse(e.ts) <= t + LINK_SKEW_MS);
  const turn = new Map();   // 每個對話最近一次開口
  for (const e of before) {
    if (e.hook !== 'UserPromptSubmit') continue;
    const x = Date.parse(e.ts);
    if (Number.isFinite(x) && x > (turn.get(e.session) ?? -Infinity)) turn.set(e.session, x);
  }
  const everyone = new Set(before.map((e) => e.session));
  if (everyone.size === 1) { const only = [...everyone][0]; return { session: only, how: 'only', candidates: [only] }; }
  if (!turn.size) return { session: null, how: null, candidates: [] };
  const [latest, from] = [...turn].sort((p, q) => q[1] - p[1])[0];
  const others = [...new Set(before.filter((e) => e.session !== latest && Date.parse(e.ts) >= from - LINK_SKEW_MS).map((e) => e.session))];
  return { session: null, how: null, candidates: [latest, ...others] };
}

/**
 * 給 roundView 的規格線索,按「這個對話」或「整個工作區」挑(施工對話認規格 AC-2、AC-3)。
 * 分級卡、五關、收工 hook 都從這裡拿,不各算一份(老毛病 P2)。
 *   session 有給 → 只認這個對話記的連結;分不出是誰記的、而它是可能的那幾個之一 → unsure(不算數、不擋)
 *   session 沒給(工作區層級:終端機、工作區的卡)→ 蓋章之後這個工作區只有一個對話在動,就等於那個對話;
 *     不只一個 → 不套任何連結(scope 'shared'),連結只算記它的那個對話,各對話的頁面各自畫
 * firstPrompt 是這個對話的第一句話(感測器記的前 200 字),AC-3 的提示從它來。
 */
export function specContext(events, { cwd, session = null, cpAt = null }) {
  const cpMs = cpAt ? Date.parse(cpAt) : NaN;
  const afterCp = (ts) => !Number.isFinite(cpMs) || Date.parse(ts) >= cpMs;
  const links = specLinksIn(events, cwd).filter((l) => afterCp(l.ts)).map((l) => ({ ...l, owner: linkOwner(l, events) }));
  let sid = session;
  if (!sid) {
    const active = new Set(events.filter((e) => e.cwd === cwd && e.hook && e.session && afterCp(e.ts)).map((e) => e.session));
    const who = active.size ? active : new Set(links.map((l) => l.owner.session).filter(Boolean));
    if (!who.size) return { scope: 'workspace', session: null, links: [], unsure: [], others: [], firstPrompt: null };
    if (who.size > 1) return { scope: 'shared', session: null, links: [], unsure: [], others: links, firstPrompt: null };
    sid = [...who][0];
  }
  const fp = events.find((e) => e.hook === 'UserPromptSubmit' && e.session === sid && e.cwd === cwd && typeof e.prompt === 'string') ?? null;
  return {
    scope: session ? 'session' : 'workspace', session: sid,
    links: links.filter((l) => l.owner.session === sid),
    unsure: links.filter((l) => !l.owner.session && l.owner.candidates.includes(sid) && !l.none),
    others: [],
    firstPrompt: fp ? { prompt: fp.prompt, ts: fp.ts } : null,
  };
}

export function roundView({ runs, stages, cleared, cpAt = null, edits = [], isCode = null, reports = new Map(), readChecklist = readChecklistFile, gitChanges = [],
                            spec = null, root = null, mainRoot = null, locate = locateSpec }) {
  const first = stages.find((s) => s.skill);
  const aAll = first ? (runs.get(first.id) ?? []) : [];
  // 一次 A 寫了哪份規格(AC-5):那次呼叫同一個 prompt_id 之後第一個寫到 docs/ 的 .md(感測器兩邊都記 prompt_id,實測對得上)。
  // ⚠️ 不退路成「A 之後第一個 docs/ 的 .md」——工作區層級的卡兩個對話共用時會抓到別人寫的文件(魔鬼教官 2026-09-16)。
  //    對不到就是找不到,不猜(R1)。
  const isSpec = (e) => /\.md$/i.test(String(e.file)) && /(^|\/)docs\//.test(String(e.file));
  // 用 Bash 寫檔感測器看不到那次寫檔(L8):A 收尾用 --report A ok "<路徑>" 指路,那筆紀錄就是第二條線索(Claude 說的)。
  // 那筆結論只屬於它之前最後一次 A——不然兩次 A 共用一筆結論,「另寫了哪份」會認錯
  const aRep = first ? reports.get(first.id) ?? null : null;
  const repFileOf = (run) => {
    if (!run || !aRep || typeof aRep.note !== 'string' || !/\.md$/i.test(aRep.note.trim())) return null;
    const at = Date.parse(aRep.ts), from = Date.parse(run.ts);
    const next = aAll.find((r) => Date.parse(r.ts) > from);
    if (!(at >= from) || (next && at >= Date.parse(next.ts))) return null;
    const note = aRep.note.trim();
    return isAbsolute(note) ? note : join(aRep.cwd ?? '', note);
  };
  const specOfRun = (run) => (run?.prompt_id
    ? edits.find((e) => e.prompt_id === run.prompt_id && e.ts >= run.ts && isSpec(e))?.file ?? null : null) ?? repFileOf(run);
  const sc = spec ?? {};
  const round = roundOf(runs, stages, cpAt, { links: sc.links ?? [], specOfRun });
  const roundStart = round.start;
  const startMs = roundStart ? Date.parse(roundStart) : NaN;
  const sinceStart = (ts) => !Number.isFinite(startMs) || Date.parse(ts) >= startMs;
  const sideRuns = new Set(round.side.map((x) => x.run));
  const inRound = (e) => !roundStart || e.ts >= roundStart;
  // B 在動的證據:這一輪改到**程式檔**的事件(五關自動結案 AC-3)。A 自己寫的規格檔(docs/)不算——
  // 不然 A 一寫完檔 B 就亮、A 就被劃掉。沒有分級設定時「程式檔」退回「不在 docs/、不是 .md」(lib/tier.mjs 的 codeFileFn)。
  const codeEdits = edits.filter(inRound).filter((e) => (isCode ? isCode(e.file) : !/(^|\/)docs\/|\.md$/i.test(String(e.file))));
  // 第二種證據:git 說改了的程式檔的修改時間——用 Bash 寫檔感測器看不到(L8),只靠感測器 B 會說「沒改到程式檔」而 git 明明有改動。
  // 可以給函式:用這裡算出來的分界去問 git(存檔之後的 commit 也算),分界只算一次——在外面另算一次,兩邊遲早對不上(老毛病 P2)
  const gc = typeof gitChanges === 'function' ? gitChanges(roundStart) : gitChanges;
  const mtimes = (Array.isArray(gc) ? gc : []).map((g) => g.mtime).filter((t) => t && (!roundStart || t >= roundStart)).sort();
  const lastEdit = [codeEdits.at(-1)?.ts, mtimes.at(-1)].filter(Boolean).sort().at(-1) ?? null;
  const editVia = codeEdits.length ? 'hook' : mtimes.length ? 'git' : null;
  // 這一輪的 A:另寫一份規格的那幾次不算(AC-5 ②:它們不重算這一輪、不換掉施工清單)
  const aRun = aAll.filter(inRound).filter((r) => !sideRuns.has(r)).at(-1) ?? null;
  const roundEdits = edits.filter(inRound);
  // 這一輪的清單從哪來:有連結就是連著的那份(施工對話認規格 AC-1);沒有就是這一輪 A 寫的那份(五關 AC-5,照舊)
  let specFile = null, checklist = null, link = null;
  if (round.link) {
    const loc = locate(round.link.spec, { root: root ?? round.link.cwd ?? null, mainRoot: mainRoot ?? round.link.main ?? null });
    link = {
      name: String(loc.name || basename(String(round.link.spec ?? ''))).replace(/\.md$/i, ''),
      rel: loc.rel ?? round.link.spec ?? null, found: loc.found, where: loc.where ?? null,
      acs: Array.isArray(round.link.acs) && round.link.acs.length ? round.link.acs : null,
      ts: round.link.ts, how: round.link.owner?.how ?? null,
    };
    // 只有工作區裡找得到才畫清單、才要 Claude 打勾(AC-6):只在主資料夾的只說在哪,不叫 Claude 去那裡改
    if (loc.found === 'here') { specFile = loc.file; checklist = batchOf(readChecklist(loc.file), link.acs); }
  } else if (aRun) {
    specFile = specOfRun(aRun);
    // 這一輪跑過 A、連不到它寫的檔 → 說找不到(AC-5 ①),不退到第一句話去猜
    checklist = specFile ? readChecklist(specFile) : { file: null, missing: true, parsed: false, items: [], checked: 0, pending: 0, unmarked: 0, total: 0, head: null };
  }
  // 「對完清單」的時間:那份規格檔最後一次被改的時間(打勾就是改檔案)
  const specLastEdit = specFile ? roundEdits.filter((e) => e.file === specFile).map((e) => e.ts).sort().at(-1) ?? null : null;
  const view = stages.map((s) => {
    const base = { id: s.id, name: s.name, type: s.type ?? null, skill: s.skill ?? null,
                   ranAt: null, args: null, count: 0, prevRanAt: null, clearedAt: null, via: null, calledAs: null,
                   closedBy: null, nodAt: null, report: null, doneAt: null, stale: false, rerunAfterChange: s.rerunAfterChange === true,
                   checklist: null };
    // B:ranAt 是最後一次改程式檔的時間(感測器或 git 說的,via 說是哪個)。不數檔案(那要看 git)
    if (s.type === 'main-conversation') return { ...base, state: 'main', ranAt: lastEdit, via: editVia };
    if (s.type === 'not-built') return { ...base, state: 'notbuilt' };
    const all = runs.get(s.id) ?? [];
    const mine = all.filter(inRound).filter((e) => !sideRuns.has(e));
    const run = mine.at(-1) ?? null;
    const prev = all.filter((e) => !inRound(e)).at(-1) ?? null;
    const clr = cleared.get(s.id) ?? null;
    const burst = run ? mine.filter((e) => e.session === run.session) : [];
    // Claude 記的結論,只認這一次跑之後的那筆(五關自動結案 AC-7、AC-8):ok=沒問題／列好了,found=找到問題
    const rep = reports.get(s.id) ?? null;
    const report = rep && run && new Date(rep.ts) >= new Date(run.ts)
      ? { verdict: rep.verdict === 'found' ? 'found' : 'ok', note: reportText(rep) || null, ts: rep.ts } : null;
    return {
      ...base,
      ranAt: run?.ts ?? null, args: run?.args ?? null,
      // 怎麼被叫的(typed=你自己打的斜線指令、skill=Claude 去叫)與打的那個名字——文案要跟證據一樣大
      via: run?.via ?? null, calledAs: run?.skill ?? null,
      // 瀏覽器那種一關會有很多筆(每個動作一筆):附上同一個對話裡有幾個動作,畫面才講得出「跑過一輪(12 個動作)」
      count: burst.length,
      // 去了哪(主機名):是在測專案還是在看儀表板,人一眼分得出來
      hosts: [...new Set(burst.map((e) => e.url_host).filter(Boolean))],
      prevRanAt: prev?.ts ?? null,
      clearedAt: clr && run && new Date(clr.ts) >= new Date(run.ts) ? clr.ts : null,
      report,
      state: 'none',
    };
  });
  // 結案的證據有兩種,都要說得出是誰說的(AC-11):Claude 說沒問題(report ok)、或人說處理完了(舊紀錄的 A–D、現在的 E)
  for (const v of view) {
    if (v.type === 'main-conversation' || v.type === 'not-built') continue;
    if (v.report?.verdict === 'ok') { v.doneAt = v.report.ts; v.closedBy = 'claude'; }
    else if (v.clearedAt) { v.doneAt = v.clearedAt; v.closedBy = 'human'; }
  }
  // 連著的規格,勾都是連上之前就打好的(別的對話對過那一版):不算這個對話對完(R2——勾只證明「有人在某個時候對過某一版」)。
  // 檔案在連上之後被改過(打勾、重標日期,用 Bash 改的也看得到)才算這個對話回頭對過(魔鬼教官 2026-09-21)
  if (link && checklist?.parsed) {
    const touched = Number.isFinite(Date.parse(checklist.mtime)) && Date.parse(checklist.mtime) > Date.parse(link.ts);
    checklist.preMarked = !touched && checklist.total > 0 && checklist.unmarked === 0 && checklist.pending === 0;
  }
  // B 的結案(AC-6):有清單就看清單——這一批全部 ✅ 才算 Claude 對完了;有 ⏳ 或沒標的,B 不劃掉。沒有清單的輪次:後面的關開始就算。
  // 這一批記的代號對不上檔案、或勾是連上之前打的 → 不算對完
  const b = view.find((v) => v.type === 'main-conversation');
  if (b) {
    const summary = checklist ? { file: checklist.file, missing: checklist.missing, parsed: checklist.parsed, checked: checklist.checked, pending: checklist.pending, unmarked: checklist.unmarked, total: checklist.total,
                                  allTotal: checklist.allTotal ?? checklist.total, batch: checklist.batch ?? null,
                                  batchMissing: checklist.batchMissing ?? [], preMarked: checklist.preMarked === true } : null;
    b.checklist = summary;
    if (b.ranAt && summary?.parsed && summary.total > 0 && summary.unmarked === 0 && summary.pending === 0 && !summary.batchMissing.length && !summary.preMarked) {
      b.doneAt = specLastEdit && specLastEdit > b.ranAt ? specLastEdit : b.ranAt;
      b.closedBy = 'checklist';
    }
  }
  const a = first ? view.find((v) => v.id === first.id) : null;
  if (a) a.checklist = checklist;
  // 「走到哪」看三種證據:skill 關被叫(或 Claude 記了結論)、B 改到程式檔(或對完清單)、瀏覽器關被人說驗收過。單純開過瀏覽器不算走到
  const stepTs = (v) => (v.type === 'browser' ? v.clearedAt : [v.doneAt, v.ranAt].filter(Boolean).sort().at(-1)) ?? null;
  const latest = view.map(stepTs).filter(Boolean).sort().at(-1) ?? null;
  for (const v of view) {
    if (v.type === 'main-conversation') {
      if (!v.ranAt) continue;                                  // 這一輪沒改過程式檔:還是「就是你在講話的那個對話」
      const open = v.checklist?.parsed && (v.checklist.total > 0 || v.checklist.batchMissing?.length) && v.closedBy !== 'checklist';   // 清單還沒對完
      if (v.closedBy === 'checklist') v.state = stepTs(v) === latest ? 'done' : 'passed';
      else if (open) v.state = v.ranAt === latest ? 'current' : 'stale';   // 不劃掉:清單還有沒對的(AC-6),用「要處理」的樣子
      else { v.state = v.ranAt === latest ? 'current' : 'passed'; if (v.state === 'passed') v.closedBy = 'next'; }   // 沒有清單:後面的關開始了就算
      continue;
    }
    if (v.state !== 'none' || !v.ranAt) continue;
    if (v.type === 'browser') v.state = v.clearedAt ? (stepTs(v) === latest ? 'done' : 'passed') : 'seen';
    else v.state = stepTs(v) === latest ? (v.doneAt ? 'done' : 'current') : 'passed';
    // 結論會過期的關(D):結論之後又改了程式檔 → 退回「要再跑一次」,不管它排在哪(AC-9)
    if (v.rerunAfterChange && lastEdit && lastEdit > (v.doneAt ?? v.ranAt)) { v.state = 'stale'; v.stale = true; }
  }
  if (a) {
    a.link = link;
    // 另寫了一份規格(AC-5 ②):連著施工清單的時候又叫了 A。講它寫了哪份;看不到就只講叫過
    const lastSide = round.link ? round.side.at(-1) ?? null : null;
    a.side = lastSide ? { name: lastSide.file ? basename(lastSide.file).replace(/\.md$/i, '') : null, ts: lastSide.run.ts, via: lastSide.run.via ?? null } : null;
    // 有連結:A 固定畫成「已走過」,誰說的是 Claude(它記了照哪份施工)。連結不參加「現在這一關」的排序,所以不會變成現在這一關
    if (link) { a.state = 'passed'; a.closedBy = 'link'; }
    // A 的結案是你點頭開工:A 之後第一次改到程式檔(AC-4)。那次改檔一定比 A 晚,上面已經把 A 劃掉了,這裡只補「誰說的」。
    // 有連結的輪次不算點頭(連結不是 A 的一次呼叫)
    else if (a.ranAt) {
      const nod = codeEdits.find((e) => e.ts > a.ranAt)?.ts ?? mtimes.find((t) => t > a.ranAt) ?? null;
      if (nod) { a.closedBy = 'nod'; a.nodAt = nod; }
    }
    // 分不出是哪個對話記的連結(AC-2):不算數、不擋,只講一句。這一輪自己跑過 A 或有連結的,不用講
    const unsure = !link && !aRun ? (sc.unsure ?? []).filter((l) => sinceStart(l.ts)).at(-1) ?? null : null;
    a.unsure = unsure ? { name: basename(String(unsure.spec ?? '')).replace(/\.md$/i, ''), ts: unsure.ts } : null;
    // 工作區層級、而這個工作區這一輪有好幾個對話:連結只算記它的那個對話,這裡不套(各對話的頁面各自畫)
    a.shared = !link && !aRun && sc.scope === 'shared' ? (sc.others ?? []).filter((l) => !l.none && sinceStart(l.ts)).length : 0;
    // 第一句話提到的規格(AC-3):只是提示。這一輪跑過 A(連不到檔也一樣,AC-5 ①)、有連結、Claude 說了「無」,都不提示;
    // 第一句話比這一輪早(蓋過章之後)也不提示——那句話講的是上一件事
    const fp = sc.firstPrompt ?? null;
    a.hint = !link && !round.none && !aRun && !a.unsure && fp && sinceStart(fp.ts) ? specHint(fp.prompt, { cap: PROMPT_CAP }) : null;
  }
  return { stages: view, roundStart, lastEdit, link, current: view.find((v) => v.state === 'current' || v.state === 'done') ?? null,
           spec: { link, unsure: a?.unsure ?? null, hint: a?.hint ?? null, shared: a?.shared ?? 0 } };
}

/** 分級的「需要那幾關」要看**這一輪**的紀錄,跟五關同一份(魔鬼教官 2026-09-16 抓到:以前看歷來最後一次,
 *  新一輪沒再跑 D 時分級卡寫 ✅、五關寫「這一輪還沒跑」——同一畫面兩句話,老毛病 P2)。 */
export function perStageOfRound(view) {
  const out = new Map();
  for (const v of view.stages) if (v.ranAt && v.type !== 'main-conversation' && v.type !== 'not-built') out.set(v.id, { ts: v.ranAt, skill: v.calledAs ?? v.skill ?? null, session: null });
  return out;
}

/** 收工 hook 的心跳:gate.mjs 每次跑都寫 logs/_gate.json。沒有這個檔 = 它從沒跑過——「掛著」不等於「活著」(L13)。 */
export const GATE_FILE = '_gate.json';
export function gateHeartbeat(logDir) {
  try { return JSON.parse(readFileSync(join(logDir, GATE_FILE), 'utf8')); } catch { return null; }
}

/**
 * app 的「建議新開對話」卡是哪個工具:Claude 在桌面 app 的對話裡叫它,對話裡就跳一張「Suggested task」。
 * ⚠️ 這個名字住兩個地方:這裡(讀取端認事件)、hooks/hooks.json 的 matcher(決定感測器會不會被叫);hook.sh 不認工具名。
 *    scripts/sensor.test.mjs 釘住兩邊對得上(老毛病 P2)。
 * ⚠️ app 哪天把工具改名,卡會安靜地不再進來,那條測試擋不到——所以畫面要一直講「app 的卡從什麼時候開始有紀錄」,
 *    一張卡都沒有的專案也要講(沒有卡跟沒在記長得一樣,老毛病 P5)。
 */
export const SUGGEST_TOOL = 'mcp__ccd_session__spawn_task';

/**
 * Claude **收回**建議卡的工具(做完了、前提變了、換一張新的)。卡的一生有兩條路,兩條都要接(老毛病 P6、L22)。
 *   實測(2026-09-17):8 張卡,Claude 叫了 5 次收回;其中 4 次 app 回「卡早就不在了」(之前被按掉、或被後來的新卡擠掉)——
 *   app 裡的卡消失得很快,儀表板留得住才有意義;也因此「叫了收回」不等於「是收回把卡拿掉的」。
 * ⚠️ 它帶的代號(task_…)只出現在提卡那一次的**回傳**裡,感測器刻意不讀回傳,所以對不回是哪一張——只講到「這個對話後來叫過收回」,
 *    不配對、不自動收(2026-09-17 Oscar 決定)。硬配的話收錯張,就是讓一張還要做的卡安靜消失。
 * ⚠️ 它**不是** app 的叉叉:叉叉是人按的,沒有任何工具呼叫,照舊看不到。
 * ⚠️ 記到的是 PreToolUse——「Claude 叫了收回」,不是「收回成功」(你已經開始做那張、或拒絕那次呼叫,紀錄照樣有,R2)。
 * 名字同樣住兩個地方(這裡、hooks/hooks.json 的 matcher),scripts/sensor.test.mjs 釘住兩邊。
 */
export const WITHDRAW_TOOL = 'mcp__ccd_session__dismiss_task';

/** 「已開始」至少要對得上幾個字(說明本身更短就整段)。 */
const START_MIN = 60;

/**
 * 這個對話的第一句話是不是照這段說明開的。回對得上幾個字,0 = 對不上。
 * 說明可以從第一句話的開頭開始,也可以從其中**某一行的開頭**開始——Oscar 習慣先打一行「這個對話命名為…」再貼說明,
 *   只認開頭的話,複製貼上這條路永遠認不出來(2026-09-17 實測:這個功能自己的那張卡就是這樣一直掛著)。
 * 對上之後,兩邊**都有的那一段要一字不差**(感測器只記第一句話的前 200 字,說明也可能被截過,所以比的是交疊的部分)。
 *   只比前 60 字的話,同一個對話提的兩張卡開頭一樣(同一段專案前言,實測已到 49 字)時,照其中一張開對話,兩張會一起被收掉。
 */
function startMatch(first, prompt) {
  const want = String(prompt).trim(), text = String(first).trim();
  if (!want) return 0;
  const head = want.slice(0, START_MIN);
  let at = -1;
  if (text.startsWith(head)) at = 0;
  else { const line = text.indexOf(`\n${head}`); if (line >= 0) at = line + 1; }
  if (at < 0) return 0;
  const rest = text.slice(at);
  return want.startsWith(rest) || rest.startsWith(want) ? Math.min(rest.length, want.length) : 0;
}

/** 每個對話的第一句話(感測器記的前 200 字)與時間。「已開始」的比對靠它。 */
export function firstPromptsOf(events) {
  const out = new Map();
  for (const e of events) {
    if (e.hook === 'UserPromptSubmit' && e.session && typeof e.prompt === 'string' && !out.has(e.session)) out.set(e.session, { prompt: e.prompt, ts: e.ts });
  }
  return out;
}

/**
 * 「另開一個對話做這件事」的建議卡。兩條路,同一種卡,source 說是哪條來的(app建議卡 AC-5):
 *   claude = Claude 用 pipeline-status --suggest 寫的(事件 suggestion)
 *   app    = Claude 在 app 的對話裡叫了建議卡(感測器記到的 PreToolUse,工具是 SUGGEST_TOOL;id 用 use_id)
 * ⚠️ app 那條記到的是「Claude 叫了這張卡」,不是「卡真的跳出來了」、更不是「你按了什麼」(R2):
 *    感測器看不到 app 的叉叉,所以在 app 按取消,這裡那張還在——只有儀表板的「不做了」(suggestion_dismissed)會收起來。
 *    Claude 自己叫了收回(WITHDRAW_TOOL):列在**那個對話、收回之前提的每一張** app 卡的 withdrawals 上,卡照樣掛著(對不回是哪一張)。
 *    收回之前的時間比卡早 → 收回的不可能是它,不列。同一個 task_id 記到兩次(plugin 跟舊接法同時掛著)算一次。
 * ⚠️ 儀表板開不了對話——它只能把說明放在那裡讓人複製,貼進新對話的第一句。
 *    「已開始」看的是事實:有沒有哪個對話的第一句話是照這段說明開的(startMatch),
 *    而且那個對話不比這張卡早——早就存在的對話不可能是照這張卡開的,認了的話卡一出生就被當成「已開始」收掉,等於弄丟。
 *    對不上就是「還沒開始」,不猜(R1)。一個對話同時對上好幾張卡:認對得上最多字的那張;一樣多的話,
 *    說明相同(同一件事放了兩次,例如 app 一張、--suggest 一張)就都算已開始,說明不同就是分不出來——都不收,
 *    寧可多掛一張,不准讓還沒開始的卡安靜消失。
 * @param firstPrompts 拿哪些對話來比。預設只有這份紀錄裡的;collect 會給所有專案的——app 的卡實測有一半是要開在別的專案,
 *                     只看自己這份就永遠對不到。值帶 project 的話,startedIn 會說那個對話在哪個專案。
 */
export function suggestionsOf(events, { firstPrompts = firstPromptsOf(events) } = {}) {
  const map = new Map();
  const noId = new Map();
  const withdrawn = new Map();   // session → Map<代號, {ts, reason, cut}>
  const card = (o) => ({ tldr: null, session: null, target: null, cut: [], withdrawals: [], ...o, dismissedAt: null, startedBy: null, startedIn: null });
  for (const e of events) {
    if (e.hook === 'PreToolUse' && e.tool === WITHDRAW_TOOL && e.session) {
      // 同一次收回的代號:task_id 最準(同一張記兩次算一次);沒有就用這次呼叫的 use_id;都沒有就是這一筆自己(寧可多算一次,不准把兩次併成一次)
      const byTask = withdrawn.get(e.session) ?? new Map();
      // 代號被截過就不拿來分:兩個開頭一樣的長代號截完會變成同一個,兩次收回會被算成一次
      const taskCut = Array.isArray(e.in_cut) && e.in_cut.includes('task');
      const key = typeof e.in_task === 'string' && !taskCut ? `task:${e.in_task}` : e.use_id ? `use:${e.use_id}` : `row:${byTask.size}:${e.ts}`;
      if (!byTask.has(key)) byTask.set(key, { ts: e.ts ?? null, reason: typeof e.in_reason === 'string' && e.in_reason.trim() ? e.in_reason.trim() : null, cut: Array.isArray(e.in_cut) && e.in_cut.includes('reason') });
      withdrawn.set(e.session, byTask);
    }
    if (e.event === 'suggestion' && e.id) {
      map.set(e.id, card({ id: e.id, ts: e.ts, source: 'claude', title: e.title ?? '（沒有標題）', prompt: e.prompt ?? '', cwd: e.cwd ?? null, cut: e.cut === true ? ['prompt'] : [] }));
    }
    if (e.hook === 'PreToolUse' && e.tool === SUGGEST_TOOL) {
      // 沒有 use_id 也要是一張卡(輸入畸形:不准因為少一個欄位就當成沒有這張卡,R1)。代號用「哪個對話、哪一秒、第幾張」湊,每次讀都一樣,「不做了」才指得回來
      const k = `${e.session ?? ''}@${e.ts}`;
      if (!e.use_id) noId.set(k, (noId.get(k) ?? 0) + 1);
      const id = e.use_id ?? `app-${k}-${noId.get(k)}`;
      // 同一個 use_id 出現兩次(plugin 跟舊接法同時掛著會記兩次)是同一張卡,不是兩張
      if (map.has(id)) continue;
      const str = (v) => (typeof v === 'string' ? v : '');
      map.set(id, card({ id, ts: e.ts, source: 'app', title: str(e.in_title).trim() || '（沒有標題）', tldr: str(e.in_tldr).trim() || null, prompt: str(e.in_prompt),
        cwd: e.cwd ?? null, session: e.session ?? null, target: str(e.in_cwd) || null, cut: Array.isArray(e.in_cut) ? e.in_cut.filter((x) => typeof x === 'string') : [] }));
    }
    if (e.event === 'suggestion_dismissed' && map.has(e.id)) map.get(e.id).dismissedAt = e.ts;
  }
  const cards = [...map.values()];
  for (const s of cards) {
    if (s.source !== 'app' || !s.session || !withdrawn.has(s.session)) continue;
    const born = Date.parse(s.ts);
    // 收回比卡早 → 收回的不可能是這張。時間讀不出來的**列著**:看不懂不等於比較早,多一行提醒不會讓卡消失
    s.withdrawals = [...withdrawn.get(s.session).values()]
      .filter((w) => !(Number.isFinite(born) && Number.isFinite(Date.parse(w.ts)) && Date.parse(w.ts) < born))
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }
  // 兩張卡是不是同一段說明:一字不差;或短的那張是**被截過**的、而且是長的那張的開頭(兩條路的截短上限不同)。
  // 沒被截過、只是剛好是另一張的開頭(第二版 = 第一版 + 補充)是兩段不同的說明,不算
  const samePrompt = (a, b) => {
    const x = a.prompt.trim(), y = b.prompt.trim();
    if (x === y) return true;
    const [short, long] = x.length <= y.length ? [a, b] : [b, a];
    return short.cut.includes('prompt') && long.prompt.trim().startsWith(short.prompt.trim());
  };
  for (const [session, fp] of firstPrompts) {
    const said = new Date(fp.ts).getTime();
    const hits = [];
    for (const s of cards) {
      // 感測器的時間只到秒:同一秒內的先後分不出來,留 1 秒的餘裕。時間讀不出來的不擋(看不懂不等於比較早)
      if (said + 1000 < new Date(s.ts).getTime()) continue;
      const n = startMatch(fp.prompt, s.prompt);
      if (n) hits.push({ s, n });
    }
    if (!hits.length) continue;
    const most = Math.max(...hits.map((h) => h.n));
    const top = hits.filter((h) => h.n === most).map((h) => h.s);
    if (!top.every((s) => samePrompt(s, top[0]))) continue;
    // 同一張卡被好幾個對話照著開:認先比到的那個(一份紀錄裡是時間順序;collect 給的那份,自己專案的排前面)
    for (const s of top) if (!s.startedBy) { s.startedBy = session; s.startedIn = fp.project ?? null; }
  }
  return cards.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

/** 每一關的所有呼叫(時間順序)。pick 決定看哪些事件:某個工作區的、或某個對話的。 */
export function runsPerStage(events, stages, pick) {
  const mine = events.filter(pick);
  const out = new Map();
  for (const s of stages) {
    const match = matcherOf(s);
    if (!match) continue;
    out.set(s.id, mine.map((e) => runOf(e, s, match)).filter(Boolean).sort((a, b) => String(a.ts).localeCompare(String(b.ts))));
  }
  return out;
}

/** AC-10:這一輪(prompt_id)動過哪些檔案。只有路徑,沒有內容。 */
export function filesByTurn(events, cwd) {
  const turns = new Map();
  for (const e of events) {
    if (e.cwd !== cwd || !e.file) continue;
    if (!turns.has(e.prompt_id)) turns.set(e.prompt_id, new Set());
    turns.get(e.prompt_id).add(e.file);
  }
  return turns;
}

export { RETAIN_DAYS };


/**
 * 把事件切成「一個對話一組」。
 *
 * ⚠️ Oscar 2026-09-10 指出:他習慣**一個功能開一個對話**,而每個對話跑在自己的
 *    worktree／分支上。所以「對話」才是他真正的工作單位,不是「專案」。
 *    我原本用專案當單位是錯的——那讓他七個對話擠成一張卡。
 *
 * ⚠️ 但要誠實:對話與工作區**通常**是一對一,不保證。
 *    同一個資料夾開兩個對話時,它們共用 git 狀態——那件事必須講出來,
 *    不然使用者會以為那是兩套獨立的東西。
 */
export function sessionsOf(events) {
  const map = new Map();
  for (const e of events) {
    if (!e.session) continue;
    let s = map.get(e.session);
    if (!s) {
      s = { id: e.session, title: null, cwd: e.cwd ?? null,
            firstTs: e.ts, lastTs: e.ts, prompts: 0, closedAt: null, reopenedByActivity: null };
      map.set(e.session, s);
    }
    if (e.title) s.title = e.title;           // session_title 會隨對話改名而更新,取最後一個
    if (e.cwd) s.cwd = e.cwd;
    if (e.hook === 'UserPromptSubmit') s.prompts++;
    // 結案／取消結案:兩種事件都是人蓋的,按檔案順序(時間順序)最後一筆說了算。
    // ⚠️ 伺服器一直都有寫 session_reopened,但這裡以前只認 session_closed——
    //    「取消結案」按了、紀錄也記了,畫面卻永遠劃掉(2026-09-11 Oscar 實測)。
    if (e.event === 'session_closed') { s.closedAt = e.ts; s.reopenedByActivity = null; }
    if (e.event === 'session_reopened') s.closedAt = null;
    // 結案之後對話又有動作(感測器記到的,不是按鈕)→ 它顯然還在工作,自動算回進行中,並標明是這樣來的
    if (e.hook && s.closedAt && e.ts > s.closedAt) { s.closedAt = null; s.reopenedByActivity = e.ts; }
    // ⚠️ 「最後動作」只算感測器記到的(對話裡真的發生的事)。按「結案」「取消結案」是你在儀表板上的動作,
    //    不是對話的動作——算進去會出現「最後動作 57 秒前」但對話根本沒開(2026-09-15 Oscar 實測)。
    if (e.ts < s.firstTs) s.firstTs = e.ts;
    if (e.hook && e.ts > s.lastTs) s.lastTs = e.ts;
  }
  const list = [...map.values()];
  // 同一個工作區有幾個對話——用來講「這兩個對話共用 git 狀態」
  const perCwd = new Map();
  for (const s of list) perCwd.set(s.cwd, (perCwd.get(s.cwd) ?? 0) + 1);
  for (const s of list) s.sharesCwd = (perCwd.get(s.cwd) ?? 1) > 1;
  return list.sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
}

/** 某一個對話這一輪跑到哪（只看這個對話自己的事件）。cpAt 是這個工作區的蓋章時間,有的話也是一輪的分界。
 *  ⚠️ 「你說處理完了」是按**工作區**記的(CLI 的 --clear 沒有對話代號),所以這個對話所在工作區的結案也要認——
 *     不然同一關在卡片上是「處理完了」、在對話頁卻是「現在這一關」(2026-09-15 實測)。
 *  規格連結只認**這個對話**記的(施工對話認規格 AC-2),從 specContext 拿——分級卡、五關、收工 hook 同一份。
 *  回整個 roundView 的結果(分級卡要它的 lastEdit 與規格線索),連同這裡挑的 cleared／reports。 */
export function sessionView(events, stages, sessionId, cpAt = null, cwd = null, { isCode = null, gitChanges = [], root = null, mainRoot = null } = {}) {
  const cleared = new Map();
  for (const e of events) {
    if (e.event === 'stage_cleared' && (e.session === sessionId || (cwd && e.cwd === cwd))) cleared.set(e.stage, e);
  }
  const mine = (e) => e.session === sessionId;
  // Claude 記的結論跟人的結案一樣是按工作區記的(CLI 沒有對話代號),所以這個對話所在工作區的也認
  const reports = reportsIn(events, (e) => e.session === sessionId || (cwd && e.cwd === cwd));
  const spec = cwd ? specContext(events, { cwd, session: sessionId, cpAt }) : null;
  const view = roundView({ runs: runsPerStage(events, stages, mine), stages, cleared, cpAt, edits: editsOf(events, mine), isCode, reports, gitChanges,
                           spec, root: root ?? cwd, mainRoot });
  return { view, cleared, reports };
}

export function stagesOfSession(events, stages, sessionId, cpAt = null, cwd = null, opts = {}) {
  return sessionView(events, stages, sessionId, cpAt, cwd, opts).view.stages;
}
