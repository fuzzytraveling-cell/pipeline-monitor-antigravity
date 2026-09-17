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
import { join, isAbsolute } from 'node:path';
import { readChecklist as readChecklistFile } from './checklist.mjs';

const RETAIN_DAYS = 90;   // AC-5:保留三個月(2026-09-09 Oscar 決定)
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

/** 一輪從哪裡開始:最近一次「第一關」(A 那種一次呼叫一筆的 skill 關)被叫,或最近一次蓋章,取較晚的。
 *  瀏覽器那種一關一堆事件,拿它最後一筆當分界會把同一輪切碎(測試抓到的:E 的 3 個動作只剩 1 個)。
 *  抽出來是因為 git 的證據要從這個時間點往後找(commit 之後 git diff 就看不到這一輪的改動了)。 */
export function roundStartOf(runs, stages, cpAt = null) {
  const first = stages.find((s) => s.skill);
  const lastFirst = first ? (runs.get(first.id) ?? []).at(-1)?.ts ?? null : null;
  return [lastFirst, cpAt].filter(Boolean).sort().at(-1) ?? null;
}

export function roundView({ runs, stages, cleared, cpAt = null, edits = [], isCode = null, reports = new Map(), readChecklist = readChecklistFile, gitChanges = [] }) {
  const first = stages.find((s) => s.skill);
  const roundStart = roundStartOf(runs, stages, cpAt);
  const inRound = (e) => !roundStart || e.ts >= roundStart;
  // B 在動的證據:這一輪改到**程式檔**的事件(五關自動結案 AC-3)。A 自己寫的規格檔(docs/)不算——
  // 不然 A 一寫完檔 B 就亮、A 就被劃掉。沒有分級設定時「程式檔」退回「不在 docs/、不是 .md」(lib/tier.mjs 的 codeFileFn)。
  const codeEdits = edits.filter(inRound).filter((e) => (isCode ? isCode(e.file) : !/(^|\/)docs\/|\.md$/i.test(String(e.file))));
  // 第二種證據:git 說改了的程式檔的修改時間——用 Bash 寫檔感測器看不到(L8),只靠感測器 B 會說「沒改到程式檔」而 git 明明有改動
  const mtimes = gitChanges.map((g) => g.mtime).filter((t) => t && (!roundStart || t >= roundStart)).sort();
  const lastEdit = [codeEdits.at(-1)?.ts, mtimes.at(-1)].filter(Boolean).sort().at(-1) ?? null;
  const editVia = codeEdits.length ? 'hook' : mtimes.length ? 'git' : null;
  // 這一輪的規格檔(AC-5):A 那一次呼叫同一個 prompt_id 之後第一個寫到 docs/ 的 .md(感測器兩邊都記 prompt_id,實測對得上)。
  // ⚠️ 不退路成「A 之後第一個 docs/ 的 .md」——工作區層級的卡兩個對話共用時會抓到別人寫的文件(魔鬼教官 2026-09-16)。
  //    對不到就是找不到,不猜(R1)。清單直接讀那份檔案(lib/checklist.mjs)
  const aRun = first ? (runs.get(first.id) ?? []).filter(inRound).at(-1) ?? null : null;
  const isSpec = (e) => /\.md$/i.test(String(e.file)) && /(^|\/)docs\//.test(String(e.file));
  const roundEdits = edits.filter(inRound);
  const specEdit = aRun?.prompt_id
    ? roundEdits.find((e) => e.prompt_id === aRun.prompt_id && e.ts >= aRun.ts && isSpec(e)) ?? null
    : null;
  // 用 Bash 寫檔感測器看不到那次寫檔(L8):A 收尾用 --report A ok "<路徑>" 指路,那筆紀錄就是第二條線索(Claude 說的)
  const aRep = first ? reports.get(first.id) ?? null : null;
  const aRepFile = aRun && aRep && new Date(aRep.ts) >= new Date(aRun.ts) && typeof aRep.note === 'string' && /\.md$/i.test(aRep.note.trim())
    ? (isAbsolute(aRep.note.trim()) ? aRep.note.trim() : join(aRep.cwd ?? '', aRep.note.trim())) : null;
  const specFile = specEdit?.file ?? aRepFile ?? null;
  const checklist = specFile ? readChecklist(specFile) : null;
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
    const mine = all.filter(inRound);
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
  // B 的結案(AC-6):有清單就看清單——全部 ✅ 才算 Claude 對完了;有 ⏳ 或沒標的,B 不劃掉。沒有清單的輪次:後面的關開始就算
  const b = view.find((v) => v.type === 'main-conversation');
  if (b) {
    const summary = checklist ? { file: checklist.file, missing: checklist.missing, parsed: checklist.parsed, checked: checklist.checked, pending: checklist.pending, unmarked: checklist.unmarked, total: checklist.total } : null;
    b.checklist = summary;
    if (b.ranAt && summary?.parsed && summary.total > 0 && summary.unmarked === 0 && summary.pending === 0) {
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
      const open = v.checklist?.parsed && v.checklist.total > 0 && v.closedBy !== 'checklist';   // 清單還沒對完
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
  // A 的結案是你點頭開工:A 之後第一次改到程式檔(AC-4)。那次改檔一定比 A 晚,上面已經把 A 劃掉了,這裡只補「誰說的」
  if (a?.ranAt) {
    const nod = codeEdits.find((e) => e.ts > a.ranAt)?.ts ?? mtimes.find((t) => t > a.ranAt) ?? null;
    if (nod) { a.closedBy = 'nod'; a.nodAt = nod; }
  }
  return { stages: view, roundStart, lastEdit, current: view.find((v) => v.state === 'current' || v.state === 'done') ?? null };
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
 * Claude 建議「另開一個對話做這件事」的卡(事件 suggestion,source:claude)。
 * ⚠️ 儀表板開不了對話——它只能把說明放在那裡讓人複製,貼進新對話的第一句。
 *    「已開始」看的是事實:有沒有哪個對話的第一句話跟這段說明開頭一樣(感測器只記前 200 字,比前 60 字)。
 */
export function suggestionsOf(events) {
  const map = new Map();
  for (const e of events) {
    if (e.event === 'suggestion' && e.id) map.set(e.id, { id: e.id, ts: e.ts, title: e.title ?? '（沒有標題）', prompt: e.prompt ?? '', cwd: e.cwd ?? null, dismissedAt: null, startedBy: null });
    if (e.event === 'suggestion_dismissed' && map.has(e.id)) map.get(e.id).dismissedAt = e.ts;
  }
  const firstPrompt = new Map();   // session → 第一句
  for (const e of events) {
    if (e.hook === 'UserPromptSubmit' && e.session && typeof e.prompt === 'string' && !firstPrompt.has(e.session)) firstPrompt.set(e.session, e.prompt);
  }
  for (const s of map.values()) {
    const head = s.prompt.trim().slice(0, 60);
    if (!head) continue;
    for (const [session, prompt] of firstPrompt) {
      if (prompt.trim().startsWith(head)) { s.startedBy = session; break; }
    }
  }
  return [...map.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
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
 *     不然同一關在卡片上是「處理完了」、在對話頁卻是「現在這一關」(2026-09-15 實測)。 */
export function stagesOfSession(events, stages, sessionId, cpAt = null, cwd = null, { isCode = null, gitChanges = [] } = {}) {
  const cleared = new Map();
  for (const e of events) {
    if (e.event === 'stage_cleared' && (e.session === sessionId || (cwd && e.cwd === cwd))) cleared.set(e.stage, e);
  }
  const mine = (e) => e.session === sessionId;
  // Claude 記的結論跟人的結案一樣是按工作區記的(CLI 沒有對話代號),所以這個對話所在工作區的也認
  const reports = reportsIn(events, (e) => e.session === sessionId || (cwd && e.cwd === cwd));
  return roundView({ runs: runsPerStage(events, stages, mine), stages, cleared, cpAt, edits: editsOf(events, mine), isCode, reports, gitChanges }).stages;
}
