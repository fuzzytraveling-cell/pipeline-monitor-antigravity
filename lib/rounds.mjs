/**
 * rounds.mjs —— 從感測器的紀錄讀出「這一輪」的事:誰說的話、每一關跑過沒、D 要不要再跑、E 驗收、這一輪從哪開始、
 * 規格連結、這一輪的畫面、建議卡、對話清單;還有關卡與分級的設定檔怎麼讀。規格:紀錄與判斷分家(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-06 從 lib/events.mjs 原封不動搬過來:那支在危險清單上,判斷跟紀錄放在一起時,改一句判斷也被算成最高那一級。
 * 這裡只讀、不寫、不清紀錄——寫錯會讓畫面說錯(一樣要擋:老毛病 P2、P7 的測試照舊釘著),但不會弄丟你的紀錄。
 * 紀錄的檔名、讀、清理在 lib/events.mjs;不准把它們搬過來,也不准讓 events.mjs 反過來拿這裡的東西。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute, basename } from 'node:path';
import { readChecklist as readChecklistFile, batchOf, locateSpec, specHint, combineChecklists, specPathsInNote, isOpenSpec } from './checklist.mjs';
import { PROMPT_CAP, RETAIN_DAYS } from './events.mjs';
import { zhEn, plural } from './lang.mjs';

/**
 * 感測器記的「一句話」(UserPromptSubmit)不一定是人說的(D 多輪先問人 AC-8,老毛病 P7):
 * 背景工作做完時,Claude Code 把一則 <task-notification>…</task-notification> 當成一句話送進對話——
 * 同一個 hook、同一個欄位,連 prompt_id 都常沿用前一句人話的(2026-09-22 實測 17 筆裡 8 筆),只能看開頭認。
 * ⚠️ 9/22 07:20 那一則讓收工 hook 把「這一回合」的開始當成通知,程式在那之前就改完了,被當成「這一回合沒改程式」放行(LESSONS L26)。
 * 讀取端只在這裡判斷:回合從哪開始(收工 hook)、對話有幾則訊息、第一句話、「D 之後你說的最後一句」,都走這一個。
 * 只認開頭:你貼一段通知進來問「這是什麼」,開頭是你打的字,照樣算你說的。
 * 感測器照舊全部照記(hook.sh 不過濾,刻意的決定)——分辨是讀的那一端的事。
 * 同一條路上還有一句:用量上限重置後,app 替你送進來的固定英文句(真實紀錄 9/17 07:41、9/21 05:51 各一筆,一字不差;魔鬼教官第一輪抓到)。
 *   它不是你說的,也不是新的交代——把回合的開始挪到它,之前改的程式就看不見了(跟 L26 同一種壞法)。
 *
 * 開頭是 <標籤 的分三種(規格:agent回報與故障記號 AC-1、AC-2):
 *   認得的系統訊息 → 不是你說的、不出聲:背景工作做完(task-notification)、子 agent 的回報(agent-message——
 *     2026-10-05 真的紀錄三筆,收工 hook 為同一件事重擋兩次;它也會被當成「D 之後你說不用再跑」的原話)
 *   認得的你的動作 → 算你開口:你貼的(pasted_content)、用 ! 跑的(bash-*)、9/11 以前系統在你的話前面加了一段的(system-reminder,E3 修好之前記的)
 *   沒見過的 → 不算你說的,而且要講出來(unknownPromptLine)。看到一種加一種會漏——agent-message 就是第四次——
 *     所以沒見過的不准預設成人話:猜錯的代價是 Claude 多問你一次、收工 hook 多擋一次,不是替你說了話。
 * ⚠️ 不是 < 開頭的系統字照舊算你說的(只認得用量上限那句英文):看到一種加一種。
 */
const SYSTEM_TEXT = [/^\s*I hit my usage limit while you were working, but it has reset now\./];
const SYSTEM_TAGS = new Set(['task-notification', 'agent-message']);
const HUMAN_TAGS = new Set(['pasted_content', 'bash-input', 'bash-stdout', 'bash-stderr', 'system-reminder']);
const LEADING_TAG = /^\s*<([A-Za-z][\w:-]*)/;

/** 這一筆是誰說的:'human'(你)、'system'(認得的系統訊息)、'unknown'(沒見過的格式)、null(不是一句話)。 */
export function promptKind(e) {
  if (e?.hook !== 'UserPromptSubmit') return null;
  const p = typeof e.prompt === 'string' ? e.prompt : '';
  if (SYSTEM_TEXT.some((re) => re.test(p))) return 'system';
  const tag = p.match(LEADING_TAG)?.[1];
  if (!tag) return 'human';
  if (SYSTEM_TAGS.has(tag)) return 'system';
  return HUMAN_TAGS.has(tag) ? 'human' : 'unknown';
}
export function saidByHuman(e) {
  return promptKind(e) === 'human';
}

/** 這個對話裡沒見過的格式:幾則、開頭是哪幾種(AC-2)。沒有回 null。 */
export function unknownPromptsOf(events, session) {
  const tags = new Set();
  let count = 0;
  for (const e of events) {
    if (e.session !== session || promptKind(e) !== 'unknown') continue;
    count++;
    tags.add(e.prompt.match(LEADING_TAG)[1]);
  }
  return count ? { count, tags: [...tags] } : null;
}

/**
 * 那一句(終端機與對話頁同一句;伺服器算好放進資料,畫面只畫——老毛病 P2)。先講白話、再附開頭、最後給動作。
 * ⚠️ 只講得出「認不出」,講不出「不是你」:你打的字剛好以 <英文字 開頭(貼一段 HTML)也會走到這裡(魔鬼教官第一輪,R1)。
 */
export function unknownPromptLine(u) {
  if (!u) return null;
  const tags = u.tags.slice(0, 3).map((t) => `<${t}>`);
  const more = u.tags.length > 3;
  return zhEn(`⚠️ 這個對話有 ${u.count} 則開頭是 ${tags.join('、')}${more ? ` 等 ${u.tags.length} 種` : ''} 的訊息，我認不出是誰送的（可能是系統，也可能是你打的字剛好這樣開頭），沒算成你說的話——把這句給 Claude 看，它會判斷該算誰的。`,
    `⚠️ This conversation has ${plural(u.count, 'message')} starting with ${tags.join(', ')}${more ? ` and others (${u.tags.length} kinds)` : ''} and I can't tell who sent them (maybe the system, maybe your own typing happened to start that way), so they aren't counted as things you said. Show this line to Claude and it will work out whose they are.`);
}

/** 這段時間裡有幾則認不出是誰送的(沒見過的格式)。代記不算數時要講「只有 N 則認不出的」,不准講成「沒有你說的話」(R1)。 */
function oddIn(list, pick) {
  return list.filter((e) => promptKind(e) === 'unknown' && pick(Date.parse(e.ts))).length;
}

/**
 * 「你說的話」要有字,才拿來當你說不用再跑的原話(D 多輪先問人 AC-4)。只貼圖(感測器記成空字串)、用 ! 跑一行指令(<bash-input>…<bash-stdout>…)
 * 是你的動作——回合與訊息數照樣算——但不是一句話;拿來當原話,畫面會寫「你說：「」」或把系統輸出標成你說的(魔鬼教官第一輪,R2)。
 * 9/11 以前前面被加了 <system-reminder> 的那幾筆也一樣:截到 200 字只剩系統的字,你打的字整個不在裡面(E3)。
 */
const NO_WORDS = /^\s*(<bash-(input|stdout|stderr)>|<system-reminder>|$)/;

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
 *  ⚠️ 專案的檔案可能只有 tiers 沒有 stages——那時關卡要退回內建的,不能變成零關。
 *  ⚠️ 寫了 stages 卻讀不懂(一關寫成 null、沒有代號、空的、不是清單):退回內建的,而且帶著 broken(一句白話)讓畫面講出來。
 *     以前不檢查:一關是 null,終端機印出程式的錯誤訊息,儀表板整頁算不出來——連別的專案一起不見;
 *     空的,五關那一段整個消失;不是清單,安安靜靜改用內建的(R1)。整份設定讀不懂(JSON 壞掉)由分級那一段講,這裡照舊退回。 */
export function loadStages(monitorDir, projectRoot, mainRoot = null) {
  let builtin = [];
  try { builtin = JSON.parse(readFileSync(join(monitorDir, 'stages.json'), 'utf8')).stages ?? []; } catch { builtin = []; }
  const { data, from, broken } = readProjectConfig(projectRoot, mainRoot);
  const fallback = { stages: named(builtin), from: join(monitorDir, 'stages.json') };
  if (broken || !data || !Object.prototype.hasOwnProperty.call(data, 'stages')) return fallback;
  const why = stagesProblem(data.stages);
  return why ? { ...fallback, broken: why } : { stages: named(data.stages), from };
}

/**
 * 關卡的名字照這一次輸出的語言給(規格:儀表板與終端機中英切換):英文寫在同一關的 nameEn。
 * 專案自己覆寫的關卡沒寫 nameEn,英文的時候照它寫的印——那是資料,不替它翻。名字只拿來給人看,沒有地方拿它來比對
 */
function named(list) {
  if (!Array.isArray(list)) return list;
  return list.map((s) => (s && typeof s === 'object' && typeof s.nameEn === 'string' && s.nameEn.trim() ? { ...s, name: zhEn(s.name, s.nameEn) } : s));
}

/** 專案自己寫的關卡哪裡讀不懂:回一句白話(第幾個、哪裡不對),讀得懂回 null。只檢查程式真的會用到、壞了會出錯或印出內部值的欄位。 */
function stagesProblem(list) {
  if (!Array.isArray(list)) return zhEn('「stages」不是一張清單', '"stages" is not a list');
  if (!list.length) return zhEn('「stages」是空的', '"stages" is empty');
  const ids = new Set();
  for (const [i, s] of list.entries()) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return zhEn(`第 ${i + 1} 個不是一關`, `Item ${i + 1} is not a stage`);
    if (typeof s.id !== 'string' || !s.id.trim()) return zhEn(`第 ${i + 1} 個沒有代號（id）`, `Item ${i + 1} has no ID (id)`);
    if (ids.has(s.id)) return zhEn(`代號 ${s.id} 出現兩次`, `ID ${s.id} appears twice`);
    ids.add(s.id);
    if (typeof s.name !== 'string' || !s.name.trim()) return zhEn(`${s.id} 沒有名字（name）`, `${s.id} has no name (name)`);
    // 選填的欄位寫成 null 就是「沒有」——舊程式照常跑,不准講成讀不懂(魔鬼教官第一輪:一份能用的設定被當成壞的,R1)
    if (s.skill != null && (typeof s.skill !== 'string' || !s.skill.trim())) return zhEn(`${s.id} 的指令名（skill）不是文字`, `${s.id}'s command name (skill) is not text`);
    if (s.tools != null) {
      if (typeof s.tools !== 'string') return zhEn(`${s.id} 的工具名規則（tools）不是文字`, `${s.id}'s tool-name rule (tools) is not text`);
      try { new RegExp(s.tools); } catch { return zhEn(`${s.id} 的工具名規則（tools）讀不懂`, `${s.id}'s tool-name rule (tools) can't be read`); }
    }
  }
  return null;
}

/** 關卡設定讀不懂時,終端機與儀表板講的同一句(老毛病 P2)。 */
export function stagesBrokenLine(why) {
  return zhEn(`⚠️ 專案設定檔（.claude/pipeline-stages.json）裡的關卡讀不懂：${why}——先照內建的五關算。改好那一段，就會照你寫的。`,
    `⚠️ Couldn't read the stages in the project settings file (.claude/pipeline-stages.json): ${why}. Using the built-in five stages for now; fix that part and it will follow what you wrote.`);
}

/**
 * 90 天內一筆紀錄都沒有(規格:90天清空之後的說法 AC-1):紀錄檔在,讀出來是空的——清完之後的空檔(no-events),
 * 或全部過期、還沒清／清不掉(ok 但 0 筆)。只看 readEvents 現在回的東西,lib/events.mjs 不用改。
 * ⚠️ 沒有紀錄檔(no-file)不算:那是從來沒記過,另外講。
 */
export function noRecordsWithin(ev) {
  return (ev?.state === 'no-events' || ev?.state === 'ok') && !ev.events?.length;
}

/**
 * 90 天內沒有任何對話紀錄時的那一句:終端機的五關、儀表板的對話那一區照印這一句(規格:90天清空之後的說法 AC-1;老毛病 P2)。
 * ⚠️ 空的紀錄檔看不出是過期清空的、還是從來沒寫進去(hook.sh 先開檔才寫,jq 出錯就留下空檔)——所以兩種都講,
 *    讓知道這 90 天有沒有用過這個專案的人自己對。不准講死「是過期清掉的,沒事」:那會把感測器壞了講成正常(P3),
 *    比以前那句「感測器可能沒在運作」還危險。
 * @param now       這台電腦的感測器現在怎樣(lib/faults.mjs 的 sensorNow):還在壞、時好時壞要照講
 * @param here      「見哪裡」:終端機是最上面那一行、網頁是最上面那一條
 * @param optedOut  你退出記錄的專案:之後的對話本來就不記,不叫你去問 Claude
 * @param mount     感測器掛得怎樣(lib/mount.mjs 的 mountState):'broken' 掛壞了(資料夾搬走、捷徑指空)、'off' 沒掛上(不是你退出的);其他給 null。
 *                  有這種證據就不講「沒開過對話就沒事」——壞了、拆了 90 天之後對話頁全清掉,儀表板上講感測器的那一行再也看不到,
 *                  只剩這一句,不能還講得像沒事(P3;魔鬼教官第一輪接了掛壞了、第二輪接了沒掛上——同一件事的兩條路,P6)
 * @param fix       掛壞了的修法(mountFix 那一句,跟感測器那一行同一句)
 */
export function noRecordLine({ now = null, here, optedOut = false, mount = null, fix = null } = {}) {
  const D = RETAIN_DAYS;
  const head = zhEn(`這個專案 ${D} 天內沒有任何對話紀錄（紀錄只留 ${D} 天，更早的會清掉）`,
    `This project has no conversation records from the last ${D} days (records are kept for ${D} days; older ones are cleared)`);
  if (optedOut) return zhEn(`${head}；你退出了記錄，之後的對話本來就不記。`, `${head}; you opted out of recording, so later conversations aren't recorded anyway.`);
  const tail = now === 'broken' ? zhEn(`這台電腦的感測器現在記不到東西（見${here}）。`, ` This computer's sensor can't record anything right now (see ${here}).`)
    : now === 'flaky' ? zhEn(`這台電腦的感測器時好時壞（見${here}），也可能是這個原因。`, ` This computer's sensor works on and off (see ${here}); that might be why too.`) : '';
  if (mount === 'broken') {
    return zhEn(`${head}。感測器掛著，但它指向的檔案不存在——紀錄已經停了，在這裡開的對話都記不到。${fix ?? '修法：把這句給 Claude 看'}。${tail}`,
      `${head}. The sensor is hooked up, but the file it points to doesn't exist: recording has stopped, and conversations opened here can't be recorded. ${fix ?? 'To fix it: show this line to Claude'}.${tail}`);
  }
  if (mount === 'off') {
    return zhEn(`${head}。感測器沒掛上，在這裡開的對話都記不到——在那個資料夾跑 pipeline-status --on 掛上。${tail}`,
      `${head}. The sensor isn't hooked up, so conversations opened here can't be recorded: run pipeline-status --on in that folder to hook it up.${tail}`);
  }
  return zhEn(`${head}。這 ${D} 天你沒在這裡開過對話的話，就是這個原因，沒事；有開過的話，是感測器沒記到——把這句給 Claude 看。${tail}`,
    `${head}. If you haven't opened a conversation here in these ${D} days, that's why, and it's fine; if you have, the sensor didn't record it: show this line to Claude.${tail}`);
}

/**
 * 每一關**最後一次**被呼叫是什麼時候。
 * ⚠️ AC-3:這裡算的是「跑過」。**沒有任何欄位代表「通過」**,因為感測器沒記,
 *    也不該記——它無從得知。
 */
/** 這一關的事件怎麼認:有 skill 就比 skill;有 tools(正則)就比工具名——E 驗收就是用它認瀏覽器工具。
 *  E 兩種都有(E 自動驗收 AC-7):verify 的呼叫是「走一趟」('skill'),瀏覽器工具只是「開過」('tool')——回的是哪一種,不是真假。
 *  ⚠️ 認到的永遠只是「被呼叫」。瀏覽器開了 12 個動作不等於驗收通過(R2),畫面要照這樣講。 */
function matcherOf(s) {
  // plugin 帶的 skill 叫「pipeline-monitor:spec」,專案自己的叫「spec」——同一關,兩種名字都認
  const bySkill = s.skill ? (e) => e.skill === s.skill || String(e.skill ?? '').endsWith(`:${s.skill}`) : null;
  const re = s.tools ? new RegExp(s.tools) : null;
  if (!bySkill && !re) return null;
  return (e) => (bySkill?.(e) ? 'skill' : re?.test(String(e.tool ?? '')) ? 'tool' : null);
}

/**
 * 你自己打的斜線指令**不經過 Skill 工具**(L19,2026-09-15 Forma Pro 實測):Claude Code 把 SKILL.md 展開成訊息,
 * 感測器只看到 UserPromptSubmit 的 prompt 開頭是「/pipeline-monitor:spec …」;Claude 自己去叫的才會走 Skill 工具。
 * 所以一關「被叫」有兩種證據:Skill 事件(via:'skill'),或訊息開頭就是這個指令(via:'typed')。
 * ⚠️ 打了不等於跑起來——指令不存在時 Claude Code 回「Unknown command」,感測器看不到那句。
 *    所以文案講「你叫了」,不講「跑過」;證據能證明的就只有這麼多(R2)。
 * 只認**開頭**:「你跑過 /spec 了嗎」是提到,不算;「/specs」名字沒整個對上,也不算。
 * ⚠️ 感測器剝掉 app 包的那一層(prompt_wrap,規格:建議卡開的對話認得出已開始)的那一句不算:它是別的對話交代的,
 *    送進來的時候開頭是「Background…」,Claude Code 沒有把它當指令執行——剝完剛好以「/指令」開頭,不代表有人叫了這一關(D 第一輪抓到,R2)。
 */
function typedRun(e, s) {
  if (!s.skill || e.hook !== 'UserPromptSubmit' || typeof e.prompt !== 'string' || e.prompt_wrap) return null;
  const name = s.skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = e.prompt.match(new RegExp(`^\\s*/((?:[A-Za-z0-9_.-]+:)?${name})(?=\\s|$)`));
  if (!m) return null;
  const args = e.prompt.slice(m[0].length).trim();
  return { ...e, skill: m[1], args: args || null, via: 'typed' };
}

/** 一個事件算不算這一關的一次「被叫」:算就回標準化過的事件(帶 via),不算回 null。
 *  lastRunPerStage 跟 runsPerStage 都走這裡,不准各認各的(老毛病 P2)。 */
function runOf(e, s, match) {
  const kind = e.hook === 'PreToolUse' ? match(e) : null;
  if (kind) return { ...e, via: kind };
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
    // 畫面才講得出「開瀏覽器跑過一輪(12 個動作)」而不是只有時間。E 的動作只數瀏覽器工具,verify 的呼叫不是一個「動作」
    out.set(s.id, last ? { ...last, count: runs.filter((e) => e.session === last.session && (!s.tools || e.via === 'tool')).length } : null);
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
 *    Claude 照規格走一趟(叫了 verify,E 自動驗收)才算走到——亮著等你查核,不劃掉;
 *    只有人說「驗收過了」(stage_cleared)才劃掉。算不算驗收,人說了算。
 *
 * @param runs   Map<關卡 id, 事件[]>(時間順序),用 runsPerStage() 算
 * @returns {{stages: Array, roundStart: string|null, current: object|null}}
 *   每關的 state:main／notbuilt／none／passed／current／done(現在這一關而且你說處理完了)／
 *   stale(要處理:D 之後又改了程式、要不要再跑你決定;B 清單沒對完)／held(你說不用再跑:擱著)／seen(開過瀏覽器)
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
  catch {
    const f = String(rep.noteFile).split('/').slice(-1)[0];
    return zhEn(`${head}\n（完整清單找不到：${f} 不見了）`, `${head}\n(The full list can't be found: ${f} is missing)`);
  }
}

/** Claude 記的結論(事件 stage_report,source:claude):每一關最後一筆。pick 決定範圍(跟 cleared 同一種取法)。 */
export function reportsIn(events, pick) {
  const out = new Map();
  for (const e of events) if (e.event === 'stage_report' && e.stage && pick(e)) out.set(e.stage, e);
  return out;
}

/** 每一筆結論(不只最後一筆),時間順序:「叫 → 結論」要一次一次配對(D 多輪先問人 AC-3、AC-13)。pick 同上。 */
export function reportLogIn(events, pick) {
  return events.filter((e) => e.event === 'stage_report' && e.stage && pick(e) && Number.isFinite(Date.parse(e.ts)))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** 「要不要再跑」的決定(事件 stage_decision:你說的,Claude 用 --decide 代記),時間順序。pick 同上(D 多輪先問人 AC-4)。 */
export function decisionsIn(events, pick) {
  return events.filter((e) => e.event === 'stage_decision' && e.stage && pick(e) && Number.isFinite(Date.parse(e.ts)))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/* ────────────── 結論會過期的關:要不要再跑(D 多輪先問人) ────────────── */

/**
 * 感測器的時間只到秒、檔案的修改時間與 CLI 到毫秒:「D 被叫之後又改了檔」留兩秒的誤差。
 * 收工 hook 以前自己留一份同樣的數;判斷合成一份之後(AC-9),數字與比法都只住這裡——--round 列「第一輪之後改的檔」也用它。
 */
export const SKEW_MS = 2000;
export function afterCall(ms, callTs) {
  const c = Date.parse(callTs);
  return Number.isFinite(ms) && Number.isFinite(c) && ms > c + SKEW_MS;
}

/**
 * 「叫 → 結論」配對(D 多輪先問人 AC-3、AC-13 的「從叫到記結論幾分鐘」都從這裡來)。
 *   每次叫,配它之後、下一次叫之前的結論;兩邊都知道是哪個對話的話要是同一個(共用工作區時不把別人的結論配給自己)。
 *   同一段裡記了好幾筆:內容看最後一筆(補記、更正),時間看第一筆(那一刻就是跑完了)。
 *   沒有結論的叫 = 還沒記結論。沒有叫的結論(沒叫 skill 的那一輪,9/17 下午第二輪就是)配不到任何一次叫——照實不知道,不回頭補、不猜。
 */
export function pairRuns(calls, reports) {
  const ms = (x) => Date.parse(x.ts);
  const used = new Set();
  return calls.map((call, i) => {
    const from = ms(call), to = i + 1 < calls.length ? ms(calls[i + 1]) : Infinity;
    const mine = reports.filter((r) => !used.has(r) && ms(r) >= from && ms(r) < to
      && (!r.by_session || !call.session || r.by_session === call.session));
    for (const r of mine) used.add(r);
    return { call, report: mine.at(-1) ?? null, minutes: mine.length ? Math.max(0, (ms(mine[0]) - from) / 60000) : null };
  });
}

/**
 * 結論會過期的關(stages.json 標 rerunAfterChange,例如 D)這一輪「要不要再跑」——**只在這裡算一次**(AC-9,老毛病 P2)。
 * 五關那一格、分級卡那一行、終端機、收工 hook 都讀這一份,各自只負責印(rerunLine)。
 * 比的是 **D 被叫的時間**,不是結論記下的時間:修完才記「沒問題」,也算結論之後改過。
 *   (以前三種比法:五關與分級卡比結論時間,收工 hook 比被叫的時間——同一件事,三處講兩種話。)
 * 「最後一次改檔」是 roundView 算的那一個(感測器的改檔＋檔案本身的修改時間),存檔(commit)不算改檔(這一輪的起點 AC-6)。
 * @param calls     這一輪這一關的每一次被叫(時間順序,呼叫端挑好範圍)
 * @param reports   這一關的每一筆結論;decisions 這一關的每一筆決定(時間順序,範圍同上)
 * @param cleared   舊紀錄裡人按的「處理完了」(現在只有 E 有按鈕,新的不會再有)
 * @param events    全部紀錄:決定要對回「記這一筆的那個對話、D 之後你說的最後一句話」
 * @returns state 六種,呼叫端不准折成「過了／沒過」:
 *   none      這一輪還沒跑
 *   no-report 叫了,還沒記結論(AC-6:可能還在跑,也可能收尾忘了記)
 *   ask       D 被叫之後又改了程式檔,還沒再跑——要不要再跑由你決定(AC-1、AC-2:不是「要再跑」)
 *   skipped   Claude 記下:你說不用再跑(AC-4)。只蓋到你那句話之前的改檔(AC-5)
 *   found     Claude 說找到問題,之後沒再改程式檔——還沒處理完
 *   ok        Claude 說沒問題(或舊紀錄裡你說處理完了),之後沒再改程式檔
 *   另外帶著:count(這一輪叫了幾次)、first／last(第一次與最後一次)、took(最近一次跑完從叫到記結論幾分鐘)、concluded、decision
 */
export function rerunOf({ calls = [], reports = [], decisions = [], lastEdit = null, cleared = null, events = [] }) {
  if (!calls.length) return { state: 'none', count: 0, rounds: 0, unfinished: 0, first: null, last: null, took: null, concluded: null, decision: null };
  const runs = pairRuns(calls, reports);
  const last = runs.at(-1);
  const doneRuns = runs.filter((r) => r.report);
  const done = doneRuns.at(-1) ?? null;
  const clr = cleared && Date.parse(cleared.ts) >= Date.parse(last.call.ts) ? cleared : null;
  const concluded = last.report ?? (clr ? { verdict: 'ok', ts: clr.ts, human: true } : null);
  const base = {
    // count:叫了幾次(含沒跑完的)。rounds:跑完(記了結論)幾次——「第幾輪」只算這個:叫了沒跑完(卡在用量上限、你按了中斷)不算一輪,
    //   不然下一次真的跑會被當成第二輪、只看第一次之後改的檔,整批從沒被看過就結案(魔鬼教官第一輪,R2)。
    // first:第一輪=第一次跑完的那一次,「第一輪之後改了哪些檔」從它算。unfinished:最後一次以外,叫了沒記結論的次數
    count: calls.length, rounds: doneRuns.length, unfinished: runs.filter((r) => !r.report && r !== last).length,
    first: doneRuns[0]?.call ?? null, last, concluded, decision: null,
    // 最近一次跑完的那一次,從叫到記結論花多久(AC-3、AC-13)。latest:就是最後一次(五關那一格只在這時候印;還在跑的那一次沒有時間)
    took: done ? { minutes: done.minutes, latest: done === last } : null,
  };
  const editMs = lastEdit ? Date.parse(lastEdit) : NaN;
  const decision = decisionOf(decisions, last.call, events);
  // 你那句話之前的改檔才算在決定裡(AC-5)——之後又改了,那次改動又是「要不要再跑,你決定」。感測器的時間只到秒,同一秒的改檔算之後(往要問的那邊倒)
  const covered = decision?.said && !(editMs >= Date.parse(decision.said.ts));
  if (!concluded) {
    // 叫了沒記結論(可能沒跑完)、而你說不用跑了:你的決定照樣算數——不然收工 hook 每一回合都叫它記結論,
    // 剩下的路只有違背你的決定再跑一次(魔鬼教官第一輪)。你那句話之後又改了 → 又是要不要再跑,你決定
    if (decision?.said) return { ...base, state: covered ? 'skipped' : 'ask', decision };
    return { ...base, state: 'no-report', decision };
  }
  if (afterCall(editMs, last.call.ts)) return { ...base, state: covered ? 'skipped' : 'ask', decision };
  return { ...base, state: concluded.verdict === 'found' ? 'found' : 'ok' };
}

/**
 * 最後一次叫之後記的「不用再跑」算不算數(AC-4):要對得回**記這一筆的那個對話**、D 被叫之後你說的最後一句話。
 *   畫面附的是感測器記的那句(前 200 字),不是 Claude 轉述的——轉述擋不住「你說跑、Claude 記成不用」,原話讓你自己對得出來(R2:證據只有這麼大)。
 *   叫 D 的那句斜線指令本身不算(那就是那一次叫);背景工作的通知不算(AC-8)。
 *   分不出是哪個對話記的(沒有代號、而工作區有別的對話)、或記的不是叫這一次 D 的那個對話 → 不算數(併發)。
 * @returns null(沒有決定)| { ts, quote, said:{ts,text,cut}|null, why:null|'owner'|'no-words' }
 */
function decisionOf(decisions, call, events) {
  const callMs = Date.parse(call.ts);
  const after = decisions.filter((x) => x.decision === 'skip' && Date.parse(x.ts) >= callMs).map((d) => ({ d, owner: linkOwner(d, events) }));
  // 認得出是別的對話記的 → 講的不是這一次 D,略過;不然同一個資料夾的另一個對話後來記一筆,就把你說過的蓋掉(魔鬼教官第一輪)。
  // 這個對話記的優先;都沒有才看分不出是誰記的那幾筆(講「分不出」,不算數)
  const own = after.filter((x) => x.owner.session && (!call.session || x.owner.session === call.session)).at(-1);
  const unknown = after.filter((x) => !x.owner.session).at(-1);
  const pick = own ?? unknown;
  if (!pick) return null;
  const base = { ts: pick.d.ts, quote: typeof pick.d.quote === 'string' ? pick.d.quote : null, said: null };
  if (!own) return { ...base, why: 'owner' };
  const dMs = Date.parse(pick.d.ts);
  const said = events.filter((e) => e.session === own.owner.session && saidByHuman(e) && typeof e.prompt === 'string' && !NO_WORDS.test(e.prompt)
      && Date.parse(e.ts) > callMs && Date.parse(e.ts) <= dMs)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).at(-1) ?? null;
  // odd:那段時間有幾則認不出是誰送的——畫面講「只有 N 則認不出的,沒當成你的原話」,不講「沒有你說的話」(魔鬼教官第一輪,R1)
  if (!said) return { ...base, why: 'no-words', odd: oddIn(events.filter((e) => e.session === own.owner.session), (t) => t > callMs && t <= dMs) };
  return { ...base, why: null, said: { ts: said.ts, text: said.prompt, cut: said.prompt.length >= PROMPT_CAP } };
}

/* ────────────── E 驗收:你說驗收過了(E 自動驗收) ────────────── */

/** 「你說處理完了／驗收過了」(stage_cleared)的每一筆,時間順序。pick 同上——E 要逐筆判斷哪一筆算數(AC-9),只給最後一筆的話,
 *  你按了按鈕之後 Claude 又記一筆不算數的,就把你的那一筆蓋掉了。 */
export function clearLogIn(events, pick) {
  return events.filter((e) => e.event === 'stage_cleared' && e.stage && pick(e) && Number.isFinite(Date.parse(e.ts)))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/**
 * 你說驗收過了,算不算數、蓋到哪一刻(E 自動驗收 AC-9、AC-6)。
 *   儀表板的按鈕、你自己在終端機跑的(指令的環境沒有對話代號)→ 你說的,蓋到那一刻。
 *   Claude 跑的(via:'claude',記了對話代號)→ Claude 代記:要對得回**那個對話**、E 這一趟之後你說的最後一句話(跟 --decide 同一套);
 *     對不上就不算數。蓋到你那句話那一刻,不是 Claude 記下的那一刻(D 多輪先問人 AC-5 同一條)。
 *     ⚠️ 以前 Claude 替你跑的 --clear E 跟你自己按的按鈕一模一樣(source:human)——9/16 那一筆就是(老毛病 P7 的鏡像:Claude 做的被當成你做的)。
 *     例外:你自己在對話框用 ! 跑的指令,環境一樣帶著對話代號(魔鬼教官第一輪,老毛病 P7 反方向)——感測器會在指令跑完之後、
 *     用同一個對話代號記下那一句 <bash-input>…--clear…;對得上就是你自己按的,不是 Claude 代記。Claude 的工具呼叫不會留下這種一句話。
 *   只認這一趟之後記的(since:最後一次「走一趟」,沒走過就是這一輪的起點)——走了新的一趟,之前的驗收講的是之前那一次。
 *     ⚠️ 開瀏覽器不算:以前連瀏覽器動作也算,你按了驗收之後 Claude 開儀表板看一眼,你的驗收就不見了(魔鬼教官第一輪,R1)。
 *        驗收講的是不是現在這一版,交給「之後又改了程式」(stale)判斷。
 *   session:這是哪個對話的那一格。Claude 代記只算記它的那個對話——同一個資料夾的另一個對話代記的,講的是那邊的事(跟 --decide 同一套);
 *     你按的按鈕、你自己跑的,照舊算整個資料夾。沒給(資料夾層級的卡)就都認。
 *   最後一筆算數的才是你的驗收;它之後又記了一筆不算數的,另外講(rejected),不蓋掉你的。
 *   蓋到的那一刻之後又改了程式檔 → stale:你的驗收講的是改之前的版本(AC-6:要不要再走由你決定)。同一秒算之後(往要問的那邊倒)。
 * @returns null(這一趟之後沒有任何一筆)| { valid, by:'human'|'claude', ts, coverTs, head, said, bang, stale, rejected:{ts, why}|null }
 */
export function acceptOf({ clears = [], since = null, events = [], lastEdit = null, session = null, sinceIsWalk = true }) {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) return null;   // 找不到這一輪從哪開始:分不出哪一筆是這一輪的,不拿舊的充數(R1)
  let accept = null, rejected = null;
  for (const c of clears) {
    if (!(Date.parse(c.ts) >= sinceMs)) continue;
    const j = judgeClear(c, sinceMs, events, sinceIsWalk);
    // 別的對話 Claude 代記的,講的是那邊的事——略過;你自己在那邊用 ! 跑的是你按的,跟按鈕一樣算整個資料夾(魔鬼教官第二輪)
    if (session && c.via === 'claude' && c.by_session && c.by_session !== session && !j.bang) continue;
    if (j.valid) { accept = j; rejected = null; } else rejected = j;
  }
  if (!accept && !rejected) return null;
  const editMs = Date.parse(lastEdit);
  const stale = !!accept && Number.isFinite(editMs) && editMs >= Date.parse(accept.coverTs);
  return accept ? { ...accept, stale, rejected: rejected ? { ts: rejected.ts, why: rejected.why, odd: rejected.odd ?? 0 } : null }
    : { valid: false, by: null, ts: null, coverTs: null, head: null, said: null, bang: false, stale: false, rejected: { ts: rejected.ts, why: rejected.why, odd: rejected.odd ?? 0 } };
}

/** 你在對話框用 ! 跑的那一句,感測器在指令跑完之後才記:比記下那一筆晚一點(留兩分鐘),也可能同一秒(感測器只到秒)。 */
const BANG_AFTER_MS = 120_000;
const BANG = /^\s*<bash-input>[^<]*(?:pipeline-status|status\.mjs)[^<]*\s--clear\b/;

/**
 * sinceIsWalk:起算點是一次「走一趟」(叫 verify 的那一刻——你打的斜線指令本身不是你說可以,不算)、
 * 還是這一輪的起點(那一刻你說的第一句話就在這一輪裡,要算;魔鬼教官第一輪的修法自己漏的,測試抓到)。
 */
function judgeClear(c, sinceMs, events, sinceIsWalk = true) {
  const head = typeof c.head === 'string' ? c.head : null;
  if (c.via !== 'claude') return { valid: true, by: 'human', ts: c.ts, coverTs: c.ts, head, said: null, bang: false };
  const owner = typeof c.by_session === 'string' && c.by_session.trim() ? c.by_session.trim() : null;
  if (!owner) return { valid: false, ts: c.ts, why: 'owner' };
  const at = Date.parse(c.ts);
  const mine = events.filter((e) => e.session === owner && e.hook === 'UserPromptSubmit' && typeof e.prompt === 'string' && Number.isFinite(Date.parse(e.ts)));
  // 你自己在對話框用 ! 跑的(魔鬼教官第一輪):不是 Claude 代記,是你按的
  if (mine.some((e) => BANG.test(e.prompt) && Date.parse(e.ts) >= at - SKEW_MS && Date.parse(e.ts) <= at + BANG_AFTER_MS)) {
    return { valid: true, by: 'human', ts: c.ts, coverTs: c.ts, head, said: null, bang: true };
  }
  // E 這一趟之後、記下之前,那個對話你說的最後一句(有字的;背景工作的通知、只貼圖、! 跑的指令都不算,AC-8 與魔鬼教官第一輪同一套)
  const after = (t) => (sinceIsWalk ? t > sinceMs : t >= sinceMs);
  const said = mine.filter((e) => saidByHuman(e) && !NO_WORDS.test(e.prompt) && after(Date.parse(e.ts)) && Date.parse(e.ts) <= at)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).at(-1) ?? null;
  if (!said) return { valid: false, ts: c.ts, why: 'no-words', odd: oddIn(mine, (t) => after(t) && t <= at) };
  return { valid: true, by: 'claude', ts: c.ts, coverTs: said.ts, head, said: { ts: said.ts, text: said.prompt, cut: said.prompt.length >= PROMPT_CAP }, bang: false };
}

/**
 * 你說驗收過了之後又改了程式,而你說不用再走(--decide E skip):錨在你的驗收,不是錨在走一趟——沒走過 verify、你自己驗的那條路,
 * 走一趟那邊什麼都沒有,以前 --decide 收不下來,剩下的路只有把「不用再走」記成「驗收過了」(魔鬼教官第一輪,P6、R2)。
 * 跟 D 的 decisionOf 同一套:記它的那個對話、你的驗收之後你說的最後一句;只蓋到你那句話之前的改檔。
 * @returns null | { ...decisionOf 的結果, covered }
 */
function acceptDecisionOf(decisions, accept, session, events, lastEdit) {
  if (!accept?.valid || !accept.stale) return null;
  const d = decisionOf(decisions, { ts: accept.coverTs, session }, events);
  if (!d) return null;
  const editMs = Date.parse(lastEdit);
  return { ...d, covered: !!d.said && !(editMs >= Date.parse(d.said.ts)) };
}

/**
 * E 這一輪整體在哪(一個地方算,五關那一格、分級卡、收工 hook、終端機都讀它;老毛病 P2):
 *   accepted        你說驗收過了,之後沒再改程式檔
 *   skipped         你說不用再走(--decide),蓋得到之後的改檔——錨在走一趟,或(沒走過的話)錨在你的驗收
 *   accepted-stale  你說驗收過了,之後又改了程式檔——要不要再走由你決定
 *   其他            Claude 走一趟的狀態(rerunOf):none／no-report／ask／ok／found
 */
export function acceptStateOf(walk, accept, acceptDecision = null) {
  if (accept?.valid && !accept.stale) return 'accepted';
  const w = walk?.state ?? 'none';
  if (w === 'skipped') return 'skipped';
  if (accept?.valid && accept.stale) return acceptDecision?.covered ? 'skipped' : 'accepted-stale';
  return w;
}

/**
 * 「要不要再跑」那一句——五關那一格、分級卡那一行、終端機、收工 hook 都印這一句(AC-9:只有這幾種說法,各處同一句)。
 * 網頁不 import 這支(常駐服務只送白名單裡的檔):伺服器照這裡算好放進資料。ok／found 沒有這一句(照舊講 Claude 的結論)。
 */
/** 「沒有你說的話」的兩種:真的一句都沒有、只有認不出是誰送的(那幾則可能就是你打的——講成「沒有」是 R1)。 */
export function noWords(odd) {
  return odd ? zhEn(`只有 ${odd} 則認不出是誰送的訊息，沒當成你的原話`, `there are only ${plural(odd, 'message')} I can't tell who sent, not taken as your own words`)
    : zhEn('紀錄裡沒有你說的話', 'there\'s nothing you said in the records');
}

export function rerunLine(r, { ago = null } = {}) {
  const when = (ts) => (ago && ts ? zhEn(`，${ago(ts)}`, `, ${ago(ts)}`) : '');
  // 哪一關、動詞是什麼:roundView 掛在 stage 上(D 是「跑」一輪 run,E 驗收是「走」一趟 walk);沒掛的(舊的呼叫端)當成 D。英文的動詞連時態一起寫
  const id = r?.stage?.id ?? 'D', walk = r?.stage?.verb === 'walk';
  const verb = walk ? zhEn('走', 'walk through it') : zhEn('跑', 'run it');
  const ing = walk ? 'walking through it' : 'running it', done = walk ? 'walked through' : 'run';
  // 引號裡的是「D 被叫之後、Claude 記下之前,你說的最後一句」——證據只有這麼大(R2),不講成「你說不用的那一句」(魔鬼教官第一輪)
  const words = (s) => {
    const t = `${String(s.text).replace(/\s+/g, ' ').trim()}${s.cut ? '…' : ''}`;
    return zhEn(`${id} 之後你說的最後一句：「${t}」${when(s.ts)}`, `the last thing you said after ${id}: “${t}”${when(s.ts)}`);
  };
  const d = r?.decision ?? null;
  const rejected = !d ? '' : d.why === 'no-words'
    ? zhEn(`（Claude 記了你說不用再${verb}，但 ${id} 之後${noWords(d.odd)}，分不出是不是你說的——不算數）`,
      ` (Claude recorded that you said no need to ${verb} again, but after ${id} ${noWords(d.odd)}, so it can't tell whether you said it: it doesn't count)`)
    : d.why === 'owner' ? zhEn(`（有一筆「不用再${verb}」分不出是哪個對話記的——不算數）`, ` (a "no need to ${verb} again" record can't be traced to a conversation: it doesn't count)`) : '';
  switch (r?.state) {
    case 'none': return zhEn(`這一輪還沒${verb}`, `not ${done} yet this round`);
    case 'no-report': return zhEn(`Claude 還沒記結論（可能還在${verb}，也可能收尾忘了記）${rejected}`,
      `Claude hasn't recorded a conclusion yet (it might still be ${ing}, or it might have forgotten to record one at the end)${rejected}`);
    case 'skipped': return zhEn(`Claude 記下：你說不用再${verb}（${words(d.said)}${r.concluded ? '' : '；那一次叫了沒記結論'}）`,
      `Claude recorded: you said no need to ${verb} again (${words(d.said)}${r.concluded ? '' : '; that call never recorded a conclusion'})`);
    case 'ask': {
      const why = !d ? '' : rejected || zhEn(`（Claude 記過你說不用再${verb}，那時 ${words(d.said)}；那之後又改了）`,
        ` (Claude once recorded that you said no need to ${verb} again; at that time, ${words(d.said)}; things changed after that)`);
      return zhEn(`之後又改了程式檔，還沒再${verb}——要不要再${verb}由你決定${why}`,
        `code files changed after that and it hasn't been ${done} again: whether to ${verb} again is your call${why}`);
    }
    case 'found': {
      const head = String(r.concluded?.note ?? '').split('\n')[0].trim();
      return zhEn(`Claude 說找到問題${head ? `：${head}` : ''}——還沒處理完`, `Claude says it found problems${head ? `: ${head}` : ''}, not handled yet`);
    }
    default: return null;
  }
}

/**
 * 「上一輪從叫到記結論 N 分鐘」(AC-13、AC-3)。算不出來就不講——不估(R3);用了多少 tokens 感測器看不到,一個字都不印。
 * 量的就是字面上那件事:叫了到記結論之間過了多久,中間卡在用量上限、等人回話都算在裡面(9/21 那一次就是 4 小時 46 分鐘)。
 */
export function tookLine(took, { unit = 'round' } = {}) {
  if (!took || !Number.isFinite(took.minutes)) return null;
  const m = Math.round(took.minutes), h = Math.floor(m / 60);
  const span = took.minutes < 1 ? zhEn('不到 1 分鐘', 'under 1 minute') : m < 60 ? zhEn(`${m} 分鐘`, plural(m, 'minute'))
    : zhEn(`${h} 小時${m % 60 ? ` ${m % 60} 分鐘` : ''}`, `${plural(h, 'hour')}${m % 60 ? ` ${plural(m % 60, 'minute')}` : ''}`);
  // unit:D 是「一輪」(round),E 驗收是走「一趟」(walk)
  return unit === 'walk' ? zhEn(`上一趟從叫到記結論 ${span}`, `last walk-through: ${span} from the call to the recorded conclusion`)
    : zhEn(`上一輪從叫到記結論 ${span}`, `last round: ${span} from the call to the recorded conclusion`);
}

/**
 * 這一次 D 怎麼跑(AC-11)。工具管得到的只有這句話;Claude 聽不聽要實測(L19)。
 *   第二次以上:不論分級都自己看,只看第一次之後改的檔,不派 agent。
 *   第一次:分級那一級設定了 agentsOnFirstRound(stages.json 的 tierLevels,預設只有碰到危險清單那一級)→ 可以派 agent;其他自己看。
 *   沒設定分級、或設定讀不懂 → 自己看,而且講明:不是當成最低那一級,是成本上取最省的那條(呼叫端給 noLevel,一句白話的原因)。
 */
export function runMode({ nth, levelId = null, agents = false, noLevel = null }) {
  // 寫給 Claude 的(收工 hook、--round 印的)。英文那一份是 Claude 用英文跟使用者講話時讀的:回報那幾句照英文寫(skill 照這幾句分路)
  if (nth >= 2) {
    return { self: true, line: zhEn(`第 ${nth} 次：不論分級都你自己看，只看第一次之後改的檔，不派 agent`,
      `time ${nth}: whatever the tier, look yourself, only at the files changed after the first time, and don't send agents`) };
  }
  // noLevel:分不了級的原因(沒設定、讀不懂、設定成不分級、這次分不了)。不是當成最低那一級,是成本上取最省的那條
  if (noLevel) {
    return { self: true, line: zhEn(`第一次、${noLevel}：照最省的方式跑——你自己看，不派 agent；回報明講「${noLevel}，我照最省的方式跑」`,
      `first time, ${noLevel}: run it the cheapest way: look yourself, don't send agents; say plainly in the report "${noLevel}, so I ran it the cheapest way"`) };
  }
  return agents
    ? { self: false, line: zhEn(`第一次、分級 ${levelId}：可以派獨立 agent 多角度看，派幾個你判斷；回報第一行寫「派了 N 個 agent」（沒派就寫「沒派 agent」）`,
      `first time, tier ${levelId}: you may send independent agents to look from several angles, as many as you judge; the first line of the report says "Sent N agents" (or "Sent no agents")`) }
    : { self: true, line: zhEn(`第一次、分級 ${levelId}：你自己看，不派 agent`, `first time, tier ${levelId}: look yourself, don't send agents`) };
}

/** 給分級卡與收工 hook:每一關(結論會過期的)要不要再跑的判斷,從 roundView 的結果拿。 */
export function rerunMapOf(view) {
  // E 驗收:分級卡那一行要講的跟 E 那一格同一句(三句話要整格的事實),所以連那一格一起給(E 自動驗收 AC-7)
  return new Map((view?.stages ?? []).filter((v) => v.rerun).map((v) => [v.id, v.type === 'browser' ? { ...v.rerun, view: v } : v.rerun]));
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
 * links 由呼叫端挑好範圍(這個對話的;或整個工作區只有一個對話時,那個對話的),specOfRun(A 的一次呼叫) 回它寫的規格檔
 *   (一份是字串、好幾份是陣列,連不到回 null 或空陣列——一次 A 寫了好幾份,規格:多份規格與新資料夾的起點 AC-1)。
 * startRun:這一輪從哪一次 A 開始(起點是蓋章、或沒有起點時是 null)——它記的版本號是起點的版本(同一份規格 AC-8)。
 * replaced:連著一份規格又記了另一份(AC-7):換掉可以,安靜換掉不行。只留最後一次換掉的;記了「無」或新的一輪就清掉。
 * ⚠️ 時間一律換成同一個鐘再比:感測器的時間只到秒(…:37Z),CLI 記到毫秒(…:37.433Z),字串比大小同一秒內會顛倒。
 */
export function roundOf(runs, stages, cpAt = null, { links = [], specOfRun = () => null } = {}) {
  const first = stages.find((s) => s.skill);
  const aRuns = first ? (runs.get(first.id) ?? []) : [];
  const cpMs = cpAt ? Date.parse(cpAt) : NaN;
  const afterCp = (ts) => !Number.isFinite(cpMs) || Date.parse(ts) >= cpMs;
  const filesOf = (run) => { const f = specOfRun(run); return (Array.isArray(f) ? f : [f]).filter((x) => typeof x === 'string' && x); };
  // 同一秒的 A 排在連結前面:A 的時間只到秒,真的先後一定是 A 先(同一秒內 Claude 不會先記連結再叫 A)
  const items = [
    ...aRuns.filter((r) => afterCp(r.ts)).map((r) => ({ at: Date.parse(r.ts), k: 0, a: r })),
    ...links.filter((l) => afterCp(l.ts)).map((l) => ({ at: Date.parse(l.ts), k: 1, l })),
  ].filter((x) => Number.isFinite(x.at)).sort((x, y) => x.at - y.at || x.k - y.k);
  let start = null, startRun = null, link = null, none = null, replaced = null;
  let side = [];
  let sideNow = [];   // 這一段連著的期間另寫的(換成另一份連結也算同一段;記了「無」或算新的一輪才清掉)
  for (const x of items) {
    if (x.l) {
      if (x.l.none) {
        // Claude 說不照那份了(--spec 無):連著期間另寫的那幾次 A 回到一般的 A——最後一次就是這一輪的開始,它寫的那份就是這一輪的規格。
        // 不還原的話,A 明明跑過卻畫成「這一輪還沒跑」,而那份又是這個對話自己寫的、--spec 收不下,卡住出不去(魔鬼教官 2026-09-21)
        if (link && sideNow.length) { start = sideNow.at(-1).run.ts; startRun = sideNow.at(-1).run; side = side.filter((y) => !sideNow.includes(y)); }
        link = null; none = x.l; sideNow = []; replaced = null;
      } else {
        if (link && basename(String(link.spec ?? '')) !== basename(String(x.l.spec ?? ''))) replaced = { from: link.spec, to: x.l.spec, ts: x.l.ts };
        link = x.l; none = null;
      }
      continue;
    }
    if (link) {
      const fs = filesOf(x.a);
      if (!fs.some((f) => basename(f) === basename(String(link.spec ?? '')))) { const it = { run: x.a, file: fs[0] ?? null, files: fs }; side.push(it); sideNow.push(it); continue; }
    }
    start = x.a.ts; startRun = x.a; link = null; none = null; sideNow = []; replaced = null;
  }
  const at = [start, cpAt].filter(Boolean).sort((p, q) => Date.parse(p) - Date.parse(q)).at(-1) ?? null;
  return { start: at, startRun: at && at === start && at !== cpAt ? startRun : null, link, none, side, replaced: link ? replaced : null };
}


/* ────────────── 規格連結(施工對話認規格) ────────────── */

/** 某個工作區的規格連結,時間順序。 */
function specLinksIn(events, cwd) {
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
    if (!saidByHuman(e)) continue;   // 背景工作的通知不是開口(AC-8)
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
 * startHere 是「沒有 A、章時,這一輪從哪一刻算起」(規格:這一輪的起點 AC-3):這個對話在這個資料夾的**第一筆紀錄**——
 *   通常就是第一句話(from:'prompt');對話中途換進這個資料夾、或這個資料夾是對話中途才 git init 的,第一筆會是改檔之類的動作
 *   (from:'arrival'),不是後來才講的那一句——只認第一句話的話,換過來之後、下一句話之前存的檔全落到起點前面(魔鬼教官 2026-09-22)。
 *   工作區只有一個對話時就是它的;好幾個對話共用時是**最早**的那一筆,sessions 記幾個對話(畫面要講「含 N 個對話」)。
 *   ⚠️ 只拿時間,不拿內容:共用時 firstPrompt 照舊是空的——別的對話的第一句話不准拿來當這裡的規格提示。
 */
export function specContext(events, { cwd, session = null, cpAt = null }) {
  const cpMs = cpAt ? Date.parse(cpAt) : NaN;
  const afterCp = (ts) => !Number.isFinite(cpMs) || Date.parse(ts) >= cpMs;
  const links = specLinksIn(events, cwd).filter((l) => afterCp(l.ts)).map((l) => ({ ...l, owner: linkOwner(l, events) }));
  let sid = session;
  if (!sid) {
    const active = new Set(events.filter((e) => e.cwd === cwd && e.hook && e.session && afterCp(e.ts)).map((e) => e.session));
    const who = active.size ? active : new Set(links.map((l) => l.owner.session).filter(Boolean));
    if (!who.size) return { scope: 'workspace', session: null, links: [], unsure: [], others: [], firstPrompt: null, startHere: null };
    if (who.size > 1) {
      return { scope: 'shared', session: null, links: [], unsure: [], others: links, firstPrompt: null,
               startHere: firstEventAt(events, cwd, (e) => who.has(e.session) && afterCp(e.ts), who.size) };
    }
    sid = [...who][0];
  }
  const fp = events.find((e) => saidByHuman(e) && e.session === sid && e.cwd === cwd && typeof e.prompt === 'string') ?? null;
  return {
    scope: session ? 'session' : 'workspace', session: sid,
    links: links.filter((l) => l.owner.session === sid),
    unsure: links.filter((l) => !l.owner.session && l.owner.candidates.includes(sid) && !l.none),
    others: [],
    firstPrompt: fp ? { prompt: fp.prompt, ts: fp.ts } : null,
    startHere: firstEventAt(events, cwd, (e) => e.session === sid, 1),
  };
}

/**
 * 這個工作區裡、pick 挑中的對話最早的一筆感測器紀錄(任何一種 hook,不只第一句話)。時間讀不懂的不算(看不懂不等於比較早)。
 * 同一秒的第一句話跟動作,算第一句話(感測器只到秒,那一秒裡先開口才會有動作)。
 */
function firstEventAt(events, cwd, pick, sessions) {
  let best = null;
  for (const e of events) {
    if (!e.hook || !e.session || e.cwd !== cwd || !pick(e)) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    const prompt = saidByHuman(e);
    if (best === null || t < best.t || (t === best.t && prompt && !best.prompt)) best = { t, ts: e.ts, prompt, head: e.head };
  }
  // head:感測器在那一筆記的版本號——app 新開的資料夾沒有 reflog 時,起點的版本靠它(規格:多份規格與新資料夾的起點 AC-8)
  return best ? { ts: best.ts, from: best.prompt ? 'prompt' : 'arrival', sessions, head: typeof best.head === 'string' ? best.head : null } : null;
}

export function roundView({ runs, stages, cleared, cpAt = null, edits = [], isCode = null, reports = new Map(), readChecklist = readChecklistFile, gitChanges = [],
                            spec = null, root = null, mainRoot = null, locate = locateSpec, reportLog = null, decisions = [], events = [], folderEdit = null,
                            clearLog = null, session = null, mtimeOf = null, specFiles = null }) {
  const first = stages.find((s) => s.skill);
  const aAll = first ? (runs.get(first.id) ?? []) : [];
  // 每一筆結論(不只最後一筆):結論會過期的關要一次一次配對「叫 → 結論」;A 寫了哪幾份也要每一筆都看。舊的呼叫端只給最後一筆,就只配得到那一筆
  const repLog = reportLog ?? [...reports.values()].sort((p, q) => Date.parse(p.ts) - Date.parse(q.ts));
  // 一次 A 寫了哪幾份規格(五關 AC-5;規格:多份規格與新資料夾的起點 AC-1)。兩條線索:
  //   ① 感測器:那次呼叫同一個 prompt_id 之後寫到 docs/規劃中、docs/進行中 的每一份 .md(感測器兩邊都記 prompt_id,實測對得上)
  //   ② Claude 收尾記的 --report A ok "<路徑>":用 Bash 寫檔感測器看不到那次寫檔(L8),這就是線索。寫了幾份就記幾次,一筆裡一行一個也認——
  //      以前每一關只看最後一筆結論,一次寫兩份只認得最後交的那份,畫面寫「全部 5 條」其實 15 條(2026-10-02 實測,R1)
  //   兩條都沒有,才照以前的規則:同一個 prompt 第一份寫到 docs/ 的 .md(規格不放在規劃中／進行中的專案)。
  // ⚠️ 不退路成「A 之後第一個 docs/ 的 .md」——工作區層級的卡兩個對話共用時會抓到別人寫的文件(魔鬼教官 2026-09-16)。
  //    對不到就是找不到,不猜(R1)。
  const isSpec = (e) => /\.md$/i.test(String(e.file)) && /(^|\/)docs\//.test(String(e.file));
  const inSpecDir = isOpenSpec;
  // 一筆結論只屬於它之前最後一次 A——不然兩次 A 共用結論,「另寫了哪份」會認錯。共用資料夾時只認同一個對話記的(沒有代號的舊紀錄照認)
  const reportsOfRun = (run) => {
    if (!run || !first) return [];
    const from = Date.parse(run.ts);
    const next = aAll.find((r) => Date.parse(r.ts) > from);
    return repLog.filter((rep) => {
      if (rep.stage !== first.id) return false;
      const at = Date.parse(rep.ts);
      if (!(at >= from) || (next && at >= Date.parse(next.ts))) return false;
      return !(rep.by_session && run.session && rep.by_session !== run.session);
    });
  };
  // 結論裡記的規格路徑:只認規劃中／進行中底下的 .md,一行寫好幾份也認(lib/checklist.mjs 的 specPathsInNote,lib/cliReport.mjs 認「自己寫的」用同一個)
  const reportedBy = (run) => reportsOfRun(run).flatMap((rep) => specPathsInNote(reportText(rep))
    .map((p) => ({ file: isAbsolute(p) ? p : join(rep.cwd ?? '', p), at: Date.parse(rep.ts), how: 'report' })));
  const specsOfRun = (run) => {
    const ed = run?.prompt_id ? edits.filter((e) => e.prompt_id === run.prompt_id && e.ts >= run.ts && isSpec(e)) : [];
    const found = [...ed.filter((e) => inSpecDir(e.file)).map((e) => ({ file: e.file, at: Date.parse(e.ts), how: 'edit' })), ...reportedBy(run)];
    if (!found.length) {
      // 兩條都沒有(規格不放在規劃中／進行中的專案):照以前的規則——同一個 prompt 第一份寫到 docs/ 的 .md,沒有才用最後一筆整份說明就是一個 .md 的結論
      const legacy = reportsOfRun(run).filter((rep) => typeof rep.note === 'string' && /\.md$/i.test(rep.note.trim())).at(-1) ?? null;
      if (ed.length) found.push({ file: ed[0].file, at: Date.parse(ed[0].ts), how: 'edit' });
      else if (legacy) { const n = legacy.note.trim(); found.push({ file: isAbsolute(n) ? n : join(legacy.cwd ?? '', n), at: Date.parse(legacy.ts), how: 'report' }); }
    }
    const t = (x) => (Number.isFinite(x.at) ? x.at : Infinity);
    return found.sort((p, q) => t(p) - t(q));
  };
  const specOfRun = (run) => specsOfRun(run).map((x) => x.file);
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
  // 這一輪的起點(規格:這一輪的起點 AC-3):「這次改動」從這一刻 HEAD 指的版本算起,存了幾次檔都一樣(lib/origin.mjs)。
  //   分界(A／蓋章)有就用分界;沒有就是這個對話在這個資料夾的第一筆紀錄(通常是第一句話;工作區共用時是最早的那一筆)。
  //   ⚠️ 不拿規格連結當起點:Claude 常在收工時才照收工 hook 的建議記 --spec(施工對話認規格的第二輪),連結比施工晚——
  //      拿它當起點,施工的存檔全落到起點前面,分級又變「沒有改動」。這裡一筆紀錄都沒有,就是沒有起點:照實講「看不全」。
  //      分界本身不動(連結不移動一輪的開始)。
  // 可以給函式:用這裡算出來的起點去問 git,起點只算一次——在外面另算一次,兩邊遲早對不上(老毛病 P2)
  const here = sc.startHere ?? null;
  const originAt = roundStart ?? here?.ts ?? null;
  const originFrom = roundStart ? (cpAt && roundStart === cpAt ? 'checkpoint' : 'A') : here?.ts ? here.from : null;
  // 感測器在起點那一筆記的版本號,與起點之後這個資料夾記到的版本號:app 新開的資料夾沒有 reflog 時,起點的版本、中間動過沒,靠它們
  // (規格:多份規格與新資料夾的起點 AC-8、AC-11)。蓋章的起點不用——章自己記了版本
  const headOf = (e) => (typeof e?.head === 'string' && e.head.trim() ? e.head.trim() : null);
  const originHead = originFrom === 'A' ? headOf(round.startRun) : originFrom === 'prompt' || originFrom === 'arrival' ? headOf(here) : null;
  const folder = root ?? round.startRun?.cwd ?? null;
  // 起點換成毫秒:感測器記的版本號、下面改檔的時間都跟它比(同一個鐘,字串比大小同一秒內會顛倒)
  const originMs = originAt ? Date.parse(originAt) : NaN;
  const originHeads = folder && Number.isFinite(originMs)
    ? [...new Set(events.filter((e) => e.hook && e.cwd === folder && Date.parse(e.ts) >= originMs).map(headOf).filter(Boolean))] : [];
  const origin = {
    at: originAt,
    from: originFrom,
    sessions: !roundStart && here?.ts ? here.sessions ?? 1 : null,
    head: originHead, heads: originHeads,
  };
  const gc = typeof gitChanges === 'function' ? gitChanges(origin) : gitChanges;
  // 這一輪動了的規格檔(git 說的,含新檔、不含刪掉的):A 認到的、連著的以外還有的,A 那格講一句(AC-6)。跟 gitChanges 同一個起點
  const sf = typeof specFiles === 'function' ? specFiles(origin) : specFiles;
  // 起點之前就改了的檔(上一件事留下、還沒存的)不是這一輪在動的證據(下面 mtimes 只留起點之後的)。
  // 感測器記過、落在程式區的檔,現在的修改時間也算(mtimeOf,呼叫端給;工作區共用時不給,跟 git 那一半同一條規則):
  //   之後用 Bash 把它還原(git checkout／restore／stash)、或用 Bash 又改了一次,git 說跟起點沒差、感測器也看不到——
  //   只看 git 的話,還原之後 E 照樣「你說驗收過了」、D 照樣「沒問題」,講的是已經不在的那一版(魔鬼教官第一輪,老毛病 P1、L8)
  const touched = typeof mtimeOf === 'function'
    ? [...new Set(codeEdits.map((e) => e.file))].map((f) => mtimeOf(f)).filter(Number.isFinite).map((t) => new Date(t).toISOString()) : [];
  const mtimes = [...(Array.isArray(gc) ? gc : []).map((g) => g.mtime), ...touched].filter((t) => t && (!Number.isFinite(originMs) || Date.parse(t) >= originMs)).sort();
  const lastEdit = [codeEdits.at(-1)?.ts, mtimes.at(-1)].filter(Boolean).sort().at(-1) ?? null;
  const editVia = codeEdits.length ? 'hook' : mtimes.length ? 'git' : null;
  // 這一輪的 A:另寫一份規格的那幾次不算(AC-5 ②:它們不重算這一輪、不換掉施工清單)
  const aRun = aAll.filter(inRound).filter((r) => !sideRuns.has(r)).at(-1) ?? null;
  // 這一輪的清單從哪來:有連結就是連著的那份(施工對話認規格 AC-1);沒有就是這一輪 A 寫的那份(五關 AC-5,照舊)。
  // 兩條路都用 locateSpec 找,都交出同一個形狀的「規格在哪」(place)給畫面:記的位置搬走了,就在規劃中／進行中／升級摘要找同名檔。
  // ⚠️ 以前只有連結那條會跟著搬家找:A 寫的規格開工照規矩搬到進行中,A 那格就說「找不到這一輪的規格檔」,
  //    收工 hook 安靜地不再要求對清單(規格搬家 AC-1,老毛病 P6)。
  // 只有工作區裡找得到才畫清單、才要 Claude 打勾(施工對話認規格 AC-6):只在主資料夾、同名不只一份、都找不到,都只講一句(畫面讀 place)
  let checklist = null, link = null, place = null;
  // 這一輪的規格檔:找到的那一份,加上記的位置(搬家之前打的勾記在舊路徑上)。「對完清單的時間」看感測器記到的、改這幾個路徑的最後一次
  let specPaths = [];
  // 一次 A 寫了好幾份(規格:多份規格與新資料夾的起點):每一份各自在哪、各自一張清單。只有一份的時候是空的,下面照舊用 place／checklist——
  // 只寫一份的對話,畫面一字不差(AC-1)
  let parts = [];
  // 記過、現在哪裡都找不到的那幾份(改名、刪了):不算進「N 份」,另外講一句(魔鬼教官第一輪:改名被算成兩份,R3)
  let ghostNames = [];
  const placeOf = (loc, recorded) => ({
    // mainFile:只在主資料夾的那一份(E 驗收照它讀要驗哪幾條,只讀;A 那格照舊不畫、不叫人去那裡打勾)
    mainFile: loc.found === 'main' ? loc.mainFile ?? null : null,
    name: String(loc.name || basename(String(recorded ?? ''))).replace(/\.md$/i, ''),
    rel: loc.rel ?? null, given: loc.given ?? null, found: loc.found, where: loc.where ?? null, moved: loc.moved === true, gone: loc.gone === true, recordedIn: loc.recordedIn ?? null,
  });
  // 一次 A 記的規格,一份一個:同一份記了不只一次(寫的時候在規劃中、搬到進行中之後又記一次;感測器記一次、--report 又記一次)算一份——
  // 同檔名就是同一份(規格的狀態就是路徑,搬家只換資料夾不換檔名;同名不只一份 locateSpec 會講「分不出」)。
  // 「記在哪」照以前的優先序:感測器記到的寫檔優先(第一次),沒有才用最後一筆結論——只寫一份的對話,旁白與清單跟以前一字不差。
  //   ⚠️ 不能照「找到的檔」併:一筆路徑寫法找得到、另一筆(對話開在子資料夾時 --report 的相對路徑)找不到,就被當成兩份(測試抓到)
  const partsOf = (wrote, run) => {
    const groups = new Map();
    for (const w of wrote) {
      const k = basename(w.file);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(w);
    }
    return [...groups.values()].map((ws) => {
      const w = ws.find((x) => x.how === 'edit') ?? ws.at(-1);
      // notBefore:記的那份最後一次被寫的時間——感測器記到的寫檔(任何一次,不只這一次 A);記不到(用 Bash 寫的)才用這一次 A 被叫的時間。
      // 比它還舊的同名檔分不出是不是同一份(見 locateSpec)。⚠️ 不能只用這一次 A 的時間:又叫了一次 A 但沒改規格檔,
      //   同一份規格一搬家就會被當成別份,清單又不見了(魔鬼教官第二輪 2026-09-22)
      const wroteAt = edits.filter((e) => e.file === w.file).map((e) => Date.parse(e.ts)).filter(Number.isFinite);
      const loc = locate(w.file, { root: root ?? run.cwd ?? null, mainRoot, notBefore: wroteAt.length ? Math.max(...wroteAt) : Date.parse(run.ts) });
      const pl = placeOf(loc, w.file);
      return { name: pl.name, place: pl, checklist: loc.found === 'here' ? readChecklist(loc.file) : null,
               paths: loc.found === 'here' ? [loc.file, ...ws.map((x) => x.file)] : [] };
    });
  };
  if (round.link) {
    const base = root ?? round.link.cwd ?? null;
    const loc = locate(round.link.spec, { root: base, mainRoot: mainRoot ?? round.link.main ?? null });
    place = placeOf(loc, round.link.spec);
    link = {
      name: place.name, rel: loc.rel ?? round.link.spec ?? null, found: loc.found, where: loc.where ?? null,
      acs: Array.isArray(round.link.acs) && round.link.acs.length ? round.link.acs : null,
      ts: round.link.ts, how: round.link.owner?.how ?? null,
    };
    if (loc.found === 'here') { checklist = batchOf(readChecklist(loc.file), link.acs); specPaths = [loc.file, base ? join(base, String(round.link.spec)) : null]; }
  } else if (aRun) {
    const wrote = specsOfRun(aRun);
    if (wrote.length) {
      const all = partsOf(wrote, aRun);
      // 記過、現在哪裡都找不到的(改名、刪了)不算進「N 份」——還有別份找得到的時候。只有它們的話照舊(單份時就是「找不到規格檔」);
      // 資料夾整個不在了不算這一種(那是沒辦法找,不是找不到)
      const ghost = (p) => p.place.found === 'missing' && !p.place.gone;
      const live = all.filter((p) => !ghost(p));
      ghostNames = live.length ? all.filter(ghost).map((p) => p.name) : [];
      parts = live.length ? live : all;
      if (parts.length === 1) { place = parts[0].place; checklist = parts[0].checklist; specPaths = parts[0].paths; parts = []; }
      else { checklist = combineChecklists(parts); specPaths = parts.flatMap((p) => p.paths); }
    } else {
      // 這一輪跑過 A、連不到它寫了哪份 → 說找不到(AC-5 ①),不退到第一句話去猜
      checklist = { file: null, missing: true, parsed: false, items: [], checked: 0, pending: 0, unmarked: 0, total: 0, head: null };
    }
  }
  // 「對完清單」的時間:這一輪感測器記到的、改那份規格檔的最後一次(打勾就是改檔案)。找到的那一份跟記的位置都認——搬家之前打的勾記在舊路徑上。
  // ⚠️ 不看檔案本身的修改時間(規格搬家 AC-1 原本寫的做法):照規矩追加施作紀錄、git 改寫檔案都會改到它,B 就變成這一輪的最後一步,
  //    D 的「找到問題」被畫成已走過(魔鬼教官 2026-09-22 抓到)。用 Bash 打的勾感測器看不到(L8),B 的結案時間就退回最後一次改程式的時間——寧可早,不可晚
  const roundEdits = edits.filter(inRound);
  const specLastEdit = specPaths.length ? roundEdits.filter((e) => specPaths.includes(e.file)).map((e) => e.ts).sort().at(-1) ?? null : null;
  // 結論會過期的關看的「最後一次改檔」是**這個資料夾**的:分級一個資料夾一份,D 看過的是這個資料夾的改動(這一輪的起點 AC-3)。
  // 對話頁共用資料夾時,B 只認這個對話自己的改檔(不把別人的算到它頭上),D 卻要看整個資料夾——別的對話在 D 之後改了,這裡也問(寧可多問)。
  // folderEdit 是呼叫端給的資料夾那一份(卡片算的);沒給就是這裡算的這一份
  const rerunEdit = [lastEdit, folderEdit].filter((t) => Number.isFinite(Date.parse(t))).sort((p, q) => Date.parse(p) - Date.parse(q)).at(-1) ?? null;
  // E 驗收要驗哪幾條(E 自動驗收 AC-4、AC-1):A 那格畫的那一份(分批做的只有這一批)。只在主資料夾的照主資料夾那份讀——只讀,
  // A 那格照舊不畫、不叫人去那裡打勾;不讀的話,Claude 漏報的條目會安靜消失,「N 條裡」的 N 變成它自己回報的條數(魔鬼教官第一輪,R1)。
  // 只在這裡算一次:五關那一格、分級卡、終端機、--round E 都拿它(老毛病 P2)
  let verifyList = null;
  if (parts.length) {
    // 好幾份規格(規格:多份規格與新資料夾的起點 AC-4):每一份都要驗。兩份都有「AC-1」,代號前面加規格名才分得開——
    // 回報也照這樣寫(lib/verify.mjs 認規格名);只寫「AC-1」的不猜是哪一份。只在主資料夾的那份照單份的規則只讀
    const vparts = parts.map((p) => {
      if (p.checklist?.parsed) return { name: p.name, where: 'here', file: p.checklist.file, cl: p.checklist };
      const m = p.place.found === 'main' && p.place.mainFile ? readChecklist(p.place.mainFile) : null;
      return m?.parsed ? { name: p.name, where: 'main', file: p.place.mainFile, cl: m } : { name: p.name, where: null, file: null, cl: null };
    });
    const items = vparts.flatMap((v) => (v.cl ? v.cl.items.map((it) => ({ id: `${v.name} ${it.id}`, spec: v.name, title: it.title, plain: it.plain ?? null })) : []));
    verifyList = items.length ? {
      multi: true, where: vparts.every((v) => v.where === 'here') ? 'here' : 'mixed', file: null, batch: null, items, expected: items.map((it) => it.id),
      specs: vparts.map((v) => ({ name: v.name, where: v.where, file: v.file, total: v.cl ? v.cl.items.length : null })),
    } : null;
  } else {
    let verifyCl = checklist?.parsed ? checklist : null;
    let verifyWhere = verifyCl ? 'here' : null;
    if (!verifyCl && place?.found === 'main' && place.mainFile) {
      const main = batchOf(readChecklist(place.mainFile), round.link?.acs ?? null);
      if (main?.parsed) { verifyCl = main; verifyWhere = 'main'; }
    }
    const verifyItems = verifyCl ? verifyCl.items.filter((it) => it.inBatch !== false).map((it) => ({ id: it.id, title: it.title, plain: it.plain ?? null })) : [];
    // name:這一份的名字——回報照著好幾份時的格式在代號前面加了它,也認得出是這一份(魔鬼教官第一輪:以前被講成「不在這一輪的規格裡」)
    verifyList = verifyItems.length
      ? { where: verifyWhere, file: verifyCl.file ?? null, batch: verifyCl.batch ?? null, items: verifyItems, expected: verifyItems.map((it) => it.id), name: place?.name ?? null } : null;
  }
  const view = stages.map((s) => {
    const base = { id: s.id, name: s.name, type: s.type ?? null, skill: s.skill ?? null,
                   ranAt: null, args: null, count: 0, prevRanAt: null, clearedAt: null, via: null, calledAs: null,
                   closedBy: null, doneBy: null, nodAt: null, report: null, doneAt: null, stale: false, rerunAfterChange: s.rerunAfterChange === true,
                   checklist: null };
    // B:ranAt 是最後一次改程式檔的時間(感測器或 git 說的,via 說是哪個)。不數檔案(那要看 git)
    if (s.type === 'main-conversation') return { ...base, state: 'main', ranAt: lastEdit, via: editVia };
    if (s.type === 'not-built') return { ...base, state: 'notbuilt' };
    const all = runs.get(s.id) ?? [];
    const mine = all.filter(inRound).filter((e) => !sideRuns.has(e));
    // 瀏覽器那一關(E)有兩種證據(E 自動驗收 AC-7):verify 的呼叫才是「走一趟」,瀏覽器動作只是「開過」。
    // 第幾趟、要不要再走、叫了沒記結論只看呼叫;「開過幾個動作」只數動作。別的關只有呼叫
    const browser = s.type === 'browser';
    const calls = browser ? mine.filter((e) => e.via !== 'tool') : mine;
    const acts = browser ? mine.filter((e) => e.via === 'tool') : [];
    const run = mine.at(-1) ?? null;                // 這一關最後一次動作(E:走一趟或開瀏覽器)
    const call = calls.at(-1) ?? null;
    const lastAct = acts.at(-1) ?? null;
    const prev = all.filter((e) => !inRound(e)).at(-1) ?? null;
    const clr = cleared.get(s.id) ?? null;
    const burst = browser ? (lastAct ? acts.filter((e) => e.session === lastAct.session) : []) : run ? mine.filter((e) => e.session === run.session) : [];
    // 結論會過期的關(D、E):這一輪「要不要再跑」只在 rerunOf 算一次(D 多輪先問人 AC-9);它的結論是配給最後一次叫的那一筆。
    // E 的「你說驗收過了」不當成 Claude 的結論——它另外一層判斷(acceptOf),蓋在走一趟的上面
    const rerun = s.rerunAfterChange && s.skill
      ? { ...rerunOf({ calls, reports: repLog.filter((x) => x.stage === s.id), decisions: decisions.filter((x) => x.stage === s.id),
                       lastEdit: rerunEdit, cleared: browser ? null : clr, events }),
          stage: { id: s.id, verb: browser ? 'walk' : 'run' } }
      : null;
    // Claude 記的結論,只認這一次跑之後的那筆(五關自動結案 AC-7、AC-8):ok=沒問題／列好了,found=找到問題。
    // E 比的是最後一次「走一趟」:走完之後又開瀏覽器給你看,結論不能因此不見
    const rep = rerun ? rerun.last?.report ?? null : reports.get(s.id) ?? null;
    const anchor = browser ? call : run;
    const report = rep && anchor && Date.parse(rep.ts) >= Date.parse(anchor.ts)
      ? { verdict: rep.verdict === 'found' ? 'found' : 'ok', note: reportText(rep) || null, ts: rep.ts } : null;
    // 你說驗收過了(E 自動驗收 AC-9、AC-6):哪一筆算數、蓋到哪一刻、之後又改了沒。沒有 skill 的舊關卡定義也照這一套判斷
    // 從哪一刻算起:最後一次走一趟,沒走過就是這一輪的起點。開瀏覽器不算(魔鬼教官第一輪:按了驗收之後開儀表板看一眼,驗收就不見了)
    const clears = (clearLog ?? (clr ? [clr] : [])).filter((c) => c.stage === s.id);
    const since = [call?.ts, originAt].filter((t) => Number.isFinite(Date.parse(t))).sort((p, q) => Date.parse(p) - Date.parse(q)).at(-1) ?? null;
    const accept = browser ? acceptOf({ clears, since, events, lastEdit: rerunEdit, session, sinceIsWalk: !!call && since === call.ts }) : null;
    // 你的驗收之後又改了程式、你說不用再走:沒走過一趟也收得下(錨在你的驗收)
    const acceptDecision = browser ? acceptDecisionOf(decisions.filter((x) => x.stage === s.id), accept, session, events, rerunEdit) : null;
    const estate = browser ? acceptStateOf(rerun, accept, acceptDecision) : null;
    // 分級卡、收工 hook 只拿得到 rerun 這一份:E 在哪、你的驗收都掛上去,不讓它們各自再猜一次(老毛病 P2)
    if (rerun && browser) { rerun.estate = estate; rerun.accept = accept; rerun.acceptDecision = acceptDecision; }
    const src = browser ? call : run;               // 怎麼被叫的、打的那個名字與後面的字:E 看最後一次走一趟
    return {
      ...base,
      ranAt: run?.ts ?? null, args: src?.args ?? null,
      // 怎麼被叫的(typed=你自己打的斜線指令、skill=Claude 去叫、tool=只有瀏覽器動作)與打的那個名字——文案要跟證據一樣大
      via: src?.via ?? (lastAct ? 'tool' : null), calledAs: src?.skill ?? null,
      // 瀏覽器那種一關會有很多筆(每個動作一筆):附上同一個對話裡有幾個動作,畫面才講得出「跑過一輪(12 個動作)」
      count: burst.length,
      // 去了哪(主機名):是在測專案還是在看儀表板,人一眼分得出來
      hosts: [...new Set(burst.map((e) => e.url_host).filter(Boolean))],
      prevRanAt: prev?.ts ?? null,
      clearedAt: browser ? (accept?.valid ? accept.ts : null) : clr && run && new Date(clr.ts) >= new Date(run.ts) ? clr.ts : null,
      report,
      rerun,
      // estate:E 這一輪整體在哪(acceptStateOf,一個地方算);沒有 verify 的舊關卡定義也有(只看你說的驗收)
      ...(browser ? { actAt: lastAct?.ts ?? null, callAt: call?.ts ?? null, accept, acceptDecision, estate, verify: verifyList } : {}),
      state: 'none',
    };
  });
  // 結案的證據有兩種,都要說得出是誰說的(AC-11):Claude 說沒問題(report ok)、或人說處理完了(舊紀錄的 A–D、現在的 E)。
  // doneBy:doneAt 那一刻是誰說處理完了,跟 doneAt 一起定、之後不換。那一格的字(lib/stageLines.mjs)與網頁工班的臉都只讀它——
  // closedBy 是「憑什麼劃掉」,下面還會換掉(A 的點頭開工、連結;B 的對完清單、後面的關開始了),拿它猜誰說的,字跟臉各猜一個(老毛病 P2,2026-10-27)
  for (const v of view) {
    if (v.type === 'main-conversation' || v.type === 'not-built') continue;
    // E 只有你說了才算過(E 自動驗收 AC-3):Claude 走一遍的結論不劃掉、不打勾;你的驗收之後又改了程式也不算數(AC-6)
    if (v.type === 'browser') {
      if (v.accept?.valid && !v.accept.stale) { v.doneAt = v.accept.ts; v.closedBy = v.doneBy = 'human'; }
      continue;
    }
    if (v.report?.verdict === 'ok') { v.doneAt = v.report.ts; v.closedBy = v.doneBy = 'claude'; }
    else if (v.clearedAt) { v.doneAt = v.clearedAt; v.closedBy = v.doneBy = 'human'; }
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
                                  batchMissing: checklist.batchMissing ?? [], preMarked: checklist.preMarked === true,
                                  // 好幾份規格:B 那一行講幾份、讀不到的幾份(條數只加讀得到的,AC-2、AC-5)
                                  ...(checklist.multi ? { multi: true, specs: checklist.parts.length, unreadable: checklist.unreadable } : {}) } : null;
    b.checklist = summary;
    if (b.ranAt && summary?.parsed && summary.total > 0 && summary.unmarked === 0 && summary.pending === 0 && !summary.batchMissing.length && !summary.preMarked) {
      b.doneAt = specLastEdit && Date.parse(specLastEdit) > Date.parse(b.ranAt) ? specLastEdit : b.ranAt;
      b.closedBy = 'checklist'; b.doneBy = 'claude';   // 那一格寫「Claude 對完清單」
    }
  }
  const a = first ? view.find((v) => v.id === first.id) : null;
  if (a) a.checklist = checklist;
  // 「走到哪」看三種證據:skill 關被叫(或 Claude 記了結論)、B 改到程式檔(或對完清單)、瀏覽器關被人說驗收過、或 Claude 照規格走了一趟。
  // 單純開過瀏覽器不算走到(Oscar 2026-09-15:截圖儀表板也會讓 E 亮)
  const latestOf = (ts) => ts.filter((t) => Number.isFinite(Date.parse(t))).sort((p, q) => Date.parse(p) - Date.parse(q)).at(-1) ?? null;
  const stepTs = (v) => (v.type === 'browser' ? latestOf([v.accept?.valid ? v.accept.ts : null, v.callAt, v.report?.ts])
    : [v.doneAt, v.ranAt].filter(Boolean).sort().at(-1)) ?? null;
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
    if (v.type === 'browser') {
      // 這一輪 Claude 一點動靜都沒有、而你自己驗過(你自己的瀏覽器、手機)按了驗收,也算數(魔鬼教官第一輪:以前一定要有動靜才認)
      if (v.state !== 'none' || (!v.ranAt && !v.accept?.valid)) continue;
      // E(E 自動驗收):你說驗收過了才劃掉;Claude 走一趟只讓它亮(等你查核),不劃掉、不打勾(AC-3)。
      //   你的驗收之後又改了程式、或走過之後又改了程式 → 要處理的樣子:要不要再走由你決定(AC-6);你說不用再走 → 擱著。
      //   只開過瀏覽器 → 看過(seen):不亮、不算走到
      const es = v.estate ?? 'none';
      if (es === 'accepted') v.state = stepTs(v) === latest ? 'done' : 'passed';
      else if (es === 'accepted-stale' || es === 'ask') { v.state = 'stale'; v.stale = true; }
      else if (es === 'skipped') v.state = 'held';
      else if (es === 'no-report' || es === 'ok' || es === 'found') {
        v.state = stepTs(v) === latest ? 'current' : 'stale';   // 後面的關又動了也不劃掉:還在等你查核(或 Claude 還沒記結論)
        v.stale = v.state === 'stale';
      } else v.state = 'seen';
      continue;
    }
    if (v.state !== 'none' || !v.ranAt) continue;
    v.state = stepTs(v) === latest ? (v.doneAt ? 'done' : 'current') : 'passed';
    // 結論會過期的關(D):照 rerunOf 的判斷,不管它排在哪(D 多輪先問人 AC-9)。
    //   ask(D 被叫之後又改了程式檔)→ 要處理的樣子——但不是「要再跑」,是「要不要再跑,你決定」(AC-1、AC-2);
    //   skipped(你說不用再跑)→ 擱著:不劃掉、不打勾(AC-4);叫了沒記結論、後面的關又動了 → 不准劃掉,劃掉就像跑完了(AC-6)
    //   找到問題、後面的關又動了(先跑 D 再跑 C、或你先去驗收)→ 也不准劃掉:分級卡那一行寫「還沒處理完」,這一格不能寫「已走過」(魔鬼教官第一輪)
    const r = v.rerun;
    if (r?.state === 'ask' || ((r?.state === 'no-report' || r?.state === 'found') && v.state === 'passed')) { v.state = 'stale'; v.stale = true; }
    else if (r?.state === 'skipped') v.state = 'held';
  }
  if (a) {
    a.link = link;
    // 這一輪的規格在哪(規格搬家 AC-3):兩條路同一份。畫面的旁白只讀它——搬到了、在主資料夾、同名不只一份、找不到
    a.specPlace = place;
    // 一次 A 寫了好幾份(規格:多份規格與新資料夾的起點 AC-1、AC-5):每一份在哪各一個,畫面的旁白一份一句。只有一份是空陣列,畫面照舊讀 specPlace
    a.specPlaces = parts.map((p) => p.place);
    // 另寫了一份規格(AC-5 ②):連著施工清單的時候又叫了 A。講它寫了哪份(寫了好幾份就都講);看不到就只講叫過
    const lastSide = round.link ? round.side.at(-1) ?? null : null;
    const sideNames = lastSide ? [...new Set((lastSide.files ?? [lastSide.file]).filter(Boolean).map((f) => basename(f).replace(/\.md$/i, '')))] : [];
    a.side = lastSide ? { name: sideNames.length ? sideNames.join(zhEn('、', ', ')) : null, count: sideNames.length, ts: lastSide.run.ts, via: lastSide.run.via ?? null } : null;
    // 連著一份規格又記了另一份(AC-7):換掉可以,安靜換掉不行——A 那格講原本照哪份、後來換成哪份。
    // 這一輪自己叫 A 寫了、之後又 --spec 別份,也是換掉(魔鬼教官第一輪:以前不講,A 那格還說自己寫的那份「沒記到」)
    const nameOf = (f) => basename(String(f ?? '')).replace(/\.md$/i, '');
    const ownNames = aRun ? [...new Set(specOfRun(aRun).map(nameOf))] : [];
    a.replaced = round.replaced ? { from: nameOf(round.replaced.from), to: nameOf(round.replaced.to), ts: round.replaced.ts }
      : link && ownNames.length && !ownNames.includes(link.name) ? { from: ownNames.join(zhEn('、', ', ')), fromNames: ownNames, to: link.name, own: true, ts: link.ts } : null;
    // 這一輪之前叫 A 寫的(同一個對話叫第二次 A,一輪從後來那次算——Oscar 2026-09-21 定的一輪不改):第一份掉出這一輪,收工 hook 不會再要它的清單。
    // 還有沒對完的條目就講出來,不准安靜消失(魔鬼教官第一輪,P6、L32);對完了就不講(不多話)。蓋章之前的不算(那是上一段的事)
    const cpMs = cpAt ? Date.parse(cpAt) : NaN;
    const earlierParts = aAll.filter((r) => !inRound(r) && (!Number.isFinite(cpMs) || Date.parse(r.ts) >= cpMs))
      .flatMap((r) => partsOf(specsOfRun(r), r));
    const sideAll = round.side.flatMap((x) => x.files ?? [x.file]).filter(Boolean).map(nameOf);
    const thisRound = new Set([place?.name, link?.name, ...parts.map((p) => p.name), ...ownNames, ...sideAll, ...ghostNames].filter(Boolean));
    const earlierOpen = new Map();
    for (const p of earlierParts) if (!thisRound.has(p.name) && p.checklist?.parsed && p.checklist.unmarked > 0) earlierOpen.set(p.name, p.checklist.unmarked);
    a.earlierSpecs = [...earlierOpen].map(([name, unmarked]) => ({ name, unmarked }));
    a.ghostSpecs = ghostNames;
    // 這一輪還動了別的規格檔、沒記到它是不是這一輪的(AC-6):git 說的(用 Bash 寫的也看得到),扣掉這個對話的 A 記過的(這一輪的、之前的)、
    // 連著的、另寫的——記過的不准說「沒記到」。只講一句、不擋收工——分不出是不是這一輪要做的(Oscar 2026-10-05:會多講話,可以)
    const known = new Set([...thisRound, ...earlierParts.map((p) => p.name)]);
    a.extraSpecs = [...new Set((Array.isArray(sf) ? sf : []).map(nameOf))].filter((n) => n && !known.has(n));
    // 有連結:A 固定畫成「已走過」,誰說的是 Claude(它記了照哪份施工)。連結不參加「現在這一關」的排序,所以不會變成現在這一關
    if (link) { a.state = 'passed'; a.closedBy = 'link'; }
    // A 的結案是你點頭開工:A 之後第一次改到程式檔(AC-4)。通常那次改檔比 A 晚,上面已經把 A 劃掉了,這裡只補「憑什麼劃掉」。
    // ⚠️ Claude 最後才記 A 的結論(規格搬到升級摘要之後再記一次),A 又是最新的那一步、還是 done——誰說處理完了看 doneBy,這裡不動它(2026-10-27)。
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
  // checklist:這一輪的規格清單(A 那格畫的那一份)。E 驗收要驗哪幾條也拿它(E 自動驗收 AC-4)——別處不再自己去 A 那格找(老毛病 P2)
  return { stages: view, roundStart, lastEdit, link, origin, current: view.find((v) => v.state === 'current' || v.state === 'done') ?? null,
           spec: { link, unsure: a?.unsure ?? null, hint: a?.hint ?? null, shared: a?.shared ?? 0,
                   // 這一輪 A 寫了哪幾份(好幾份才有):分級卡 A 那一行跟 A 那格講同一件事,不另外去取最後一筆結論(魔鬼教官第一輪,P2、L32)
                   wrote: parts.length ? parts.map((p) => p.name) : null }, checklist };
}

/** 分級的「需要那幾關」要看**這一輪**的紀錄,跟五關同一份(魔鬼教官 2026-09-16 抓到:以前看歷來最後一次,
 *  新一輪沒再跑 D 時分級卡寫 ✅、五關寫「這一輪還沒跑」——同一畫面兩句話,老毛病 P2)。 */
export function perStageOfRound(view) {
  const out = new Map();
  for (const v of view.stages) if (v.ranAt && v.type !== 'main-conversation' && v.type !== 'not-built') out.set(v.id, { ts: v.ranAt, skill: v.calledAs ?? v.skill ?? null, session: null });
  return out;
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
 * 2026-10-25 app 把做卡的工具換成這個(規格:app建議卡換工具)。舊的 SUGGEST_TOOL 照認:舊紀錄要讀得到。
 * 它多一個 initiation:own_initiative 是掛著等你按的卡(START_PENDING);offer 是當場問你(START_OFFER,2026-10-28 起也是卡,見下);
 * user_asked 是直接開了(START_DIRECT),不是待辦。
 * 只帶 proposal_id 的一次是「照你的話開了之前提的某一張」——代號只在提卡那次的回傳裡,對不回是哪一張,所以不是新卡、也不收卡。
 * 帶 proposal_id **又帶要貼的話**的那一次不一樣:是你按了 New session 之後,app 叫 Claude 補的說明(規格:當場問的卡也收進來 AC-3)。
 * 名字同樣住兩個地方(這裡、hooks/hooks.json 的 matcher),scripts/sensor.test.mjs 釘住兩邊。
 */
export const START_TOOL = 'mcp__ccd_session__start_session';
export const SUGGEST_TOOLS = [SUGGEST_TOOL, START_TOOL];
const START_PENDING = 'own_initiative';
/**
 * 當場問你要不要開的卡(規格:當場問的卡也收進來)。它在對話裡跳出 New session／Do it here 等你按;你沒按就傳了新訊息,卡就關了,
 * app 也不准 Claude 再問一次——想「下次再做」的事,關掉對話就再也找不到。所以它也是一張卡:看不到下文的掛著。
 * ⚠️ 只有 app 的回覆分得出「你選了在這裡做」跟「沒按就關」,感測器刻意不讀回覆(沒按就關那一次的回覆也不是一筆正常的工具結果),
 *    所以分不出的一律掛著,寧可多掛一張——選了在這裡做的,你自己按「不做了」(2026-10-28 Oscar 決定)。
 * 看得到的下文只有兩種:補說明(你按了 New session,app 叫 Claude 補的那一次)、同一個對話後來又叫了同名的卡。
 */
const START_OFFER = 'offer';
const START_DIRECT = 'user_asked';
/**
 * 照 New session 開的對話,第一句話開頭的那一行標頭(2026-10-28 看的紀錄;感測器拆不掉,見 suggestionsOf 的 brief)。
 * 那一句是另一個 Claude 寫的,照舊算進「你說的話」——第一句話的比對要靠它認「已開始」,要不要整個改,跟這件事一起另寫一份。
 * 這裡只拿來擋一件事:不准當成「你那時說」附在當場問的卡上、抄進湊的那段(D 第一輪,P7)。感測器剝過包裝的那種看 prompt_wrap。
 */
const NEW_SESSION_WRAP = /^Task \(from the session that started this one\):\n/;

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

/**
 * app 對話工具(mcp__ccd_session__ 開頭)裡**認得的**那幾個:有自己那一筆接點的(提卡、收回),跟卡無關的(換章節、交棒、讀小工具…)。
 * hooks/hooks.json 最後一筆接的是「這個開頭、但不在這份清單裡」的工具——app 下次再把做卡的工具改名,
 * 紀錄裡才會出現一個認不得的名字,畫面講得出來;不然卡又會安靜地一張都進不來(規格:app建議卡換工具 AC-8,老毛病 P6)。
 * ⚠️ 這份清單跟那一筆 matcher 的排除清單是同一份,scripts/sensor.test.mjs 釘住兩邊一字不差(P2)。
 */
export const KNOWN_SESSION_TOOLS = ['spawn_task', 'start_session', 'dismiss_task', 'hand_off_to_session', 'mark_chapter', 'read_widget_context', 'list_start_targets', 'move_to_cloud']
  .map((n) => `mcp__ccd_session__${n}`);
const SESSION_TOOL_PREFIX = 'mcp__ccd_session__';

/**
 * 這份紀錄裡,做卡的工具什麼時候換過、有沒有記到認不得的 app 對話工具(規格:app建議卡換工具 AC-5、AC-8)。
 * oldLast:最後一次記到舊工具;newFirst:第一次記到新工具;unknown:認不得的工具,每個一筆 {tool, first, count}。
 * 只用紀錄裡查得到的時間——「app 哪天換的」查不到,不編(R3)。好幾份紀錄的結果用 mergeCardTools 合起來(換工具是整個 app 的事)。
 */
export function cardToolsOf(events) {
  let oldLast = null, newFirst = null;
  const unknown = new Map();
  for (const e of events) {
    if (e.hook !== 'PreToolUse' || typeof e.tool !== 'string' || typeof e.ts !== 'string') continue;
    if (e.tool === SUGGEST_TOOL && (!oldLast || e.ts > oldLast)) oldLast = e.ts;
    if (e.tool === START_TOOL && (!newFirst || e.ts < newFirst)) newFirst = e.ts;
    if (e.tool.startsWith(SESSION_TOOL_PREFIX) && !KNOWN_SESSION_TOOLS.includes(e.tool)) {
      const u = unknown.get(e.tool) ?? { tool: e.tool, first: e.ts, count: 0 };
      if (e.ts < u.first) u.first = e.ts;
      u.count++;
      unknown.set(e.tool, u);
    }
  }
  return { oldLast, newFirst, unknown: [...unknown.values()] };
}

export function mergeCardTools(list) {
  const out = { oldLast: null, newFirst: null, unknown: [] };
  const unknown = new Map();
  for (const x of list) {
    if (x.oldLast && (!out.oldLast || x.oldLast > out.oldLast)) out.oldLast = x.oldLast;
    if (x.newFirst && (!out.newFirst || x.newFirst < out.newFirst)) out.newFirst = x.newFirst;
    for (const u of x.unknown) {
      const m = unknown.get(u.tool);
      unknown.set(u.tool, m ? { tool: u.tool, first: u.first < m.first ? u.first : m.first, count: m.count + u.count } : { ...u });
    }
  }
  out.unknown = [...unknown.values()].sort((a, b) => a.first.localeCompare(b.first));
  return out;
}

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
    if (saidByHuman(e) && e.session && typeof e.prompt === 'string' && !out.has(e.session)) out.set(e.session, { prompt: e.prompt, ts: e.ts });
  }
  return out;
}

/** 每個對話的標題(感測器記到的最後一個 session_title,跟 sessionsOf 同一個取法)。collect 會改給 app 側欄上那個字。 */
function titlesOf(events) {
  const out = new Map();
  for (const e of events) if (e.session && typeof e.title === 'string' && e.title) out.set(e.session, e.title);
  return out;
}

/**
 * 當場問的卡只帶標題,沒有說明:監視器替它湊一段能貼進新對話的話(規格:當場問的卡也收進來 AC-4)。
 * 只放查得到的三樣——標題、原本那個對話的名字、你在那之前說的最後一句——不替 Claude 補它沒寫的說明。
 * 伺服器算這一份:畫面照印、「已開始」也拿它比(照這段開了新對話,這張才認得出來)。
 * ⚠️ 不附「去讀原本那個對話的紀錄」:新對話會自己去翻,舊對話越長越貴(2026-10-28 Oscar 決定先不附)。
 */
function offerPrompt(title, fromTitle, said) {
  const lines = title ? [title, ''] : [];
  lines.push(fromTitle ? `這件事原本在「${fromTitle}」那個對話裡提過。` : '這件事原本在另一個對話裡提過。');
  if (said) lines.push(`你那時說：「${said.text.replace(/\s+/g, ' ').trim()}${said.cut ? '…' : ''}」`);
  return lines.join('\n');
}

/**
 * 「另開一個對話做這件事」的建議卡。兩條路,同一種卡,source 說是哪條來的(app建議卡 AC-5):
 *   claude = Claude 用 pipeline-status --suggest 寫的(事件 suggestion)
 *   app    = Claude 在 app 的對話裡叫了建議卡(感測器記到的 PreToolUse,工具是 SUGGEST_TOOLS 其中一個;id 用 use_id)
 *            新工具(START_TOOL)own_initiative、offer 算卡;initiation 沒有或看不懂 → 照卡算(寧可多掛一張,不准讓真的卡安靜消失,R1)。
 *            只帶 proposal_id 的那一次(照你的話開了之前提的某一張)列在**那個對話、它之前提的每一張**掛著的 app 卡的 opens 上,跟收回一樣不配對、不收卡。
 *            當場問的卡不列:它在 app 裡從來不是掛著等你按的那種,只帶代號的那一次指的不可能是它。
 *   當場問的卡(offer,ask 是 'offer';規格:當場問的卡也收進來):
 *     said         你在那之前說的最後一句(同一個對話、比提卡早;系統塞的字、照卡開的對話裡另一個 Claude 寫的說明都不算,P7)。感測器只記前面一段,記滿了標 cut
 *     brief        看得到的下文:補說明(帶代號又帶要貼的話,只配給這個對話最近那一張當場問的卡——還沒配到、提卡之後你還沒說過話)、
 *                  或同一個對話後來叫了同名、直接開的那一次。說明、背景說明、要開在哪都換成它的;「已開始」拿要貼的話**和背景說明**比——
 *                  照 New session 開的對話,第一句話的包裝感測器拆不掉,記到的前 200 字是標頭加背景說明,要貼的話一個字都沒有
 *                  沒有下文 → prompt 是監視器湊的那段(offerPrompt),一樣拿來比;湊的那段在這裡算一份,畫面照印
 *     supersededAt 同一個對話後來又叫了同名、會掛出來的卡:這張收起來、跟著後來那一張,不重複掛兩張
 *     workedAfter  提卡之後、你下一句話之前,Claude 接著叫了 skill 或改了檔案——只是提示(可能是你選了在這裡做),不收卡、不改狀態(L25)
 *   看不到下文的一律掛著:分不出「你選了在這裡做」跟「沒按就關」,寧可多掛一張(R1)。
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
 * @param titles       每個對話的標題(當場問的卡湊說明時要寫原本在哪個對話)。預設是感測器記到的;collect 會給 app 側欄上那個字。
 */
export function suggestionsOf(events, { firstPrompts = firstPromptsOf(events), titles = titlesOf(events) } = {}) {
  const map = new Map();
  const noId = new Map();
  const withdrawn = new Map();   // session → Map<代號, {ts, reason, cut}>
  const opened = new Map();      // session → Map<代號, {ts}>(只帶 proposal_id 的那幾次)
  const lastSaid = new Map();    // session → 你到目前為止說的最後一句 {ts, text, cut}
  const offers = new Map();      // session → [{ c: 當場問的卡, title: 去頭尾空白的標題 }](時間順序)
  const watching = new Map();    // session → Set<當場問的卡>:提卡之後、還沒等到你下一句話的
  const briefOf = new Map();     // 補說明的代號 → 配到的那張(同一次記兩次、或同一張補兩次,都落在同一張)
  const card = (o) => ({ tldr: null, session: null, target: null, cut: [], withdrawals: [], opens: [], ask: null, said: null, brief: null, workedAfter: null, supersededAt: null,
    ...o, dismissedAt: null, startedBy: null, startedIn: null });
  const str = (v) => (typeof v === 'string' ? v : '');
  // 下文的說明、背景說明、要開在哪換成那一次的;標題照提卡那一次(補說明不帶標題)。被截的欄位照那一次的標
  const giveBrief = (c, e, via) => {
    c.brief = { ts: e.ts ?? null, via };
    c.tldr = str(e.in_tldr).trim() || null;
    c.prompt = str(e.in_prompt);
    c.target = str(e.in_cwd) || null;
    const cut = Array.isArray(e.in_cut) ? e.in_cut.filter((x) => x === 'tldr' || x === 'prompt' || x === 'cwd') : [];
    c.cut = [...c.cut.filter((x) => x === 'title'), ...cut];
  };
  for (const e of events) {
    // 你說的話:關掉「提卡之後、你下一句話之前」那一段;有字的記下來,下一張當場問的卡要附(NO_WORDS:你跑的指令、只有系統提醒的不算一句話)。
    // 照卡開的對話的第一句話是另一個 Claude 寫的說明(prompt_wrap、或 New session 那一行標頭):不當成你那時說的(P7)
    if (e.session && saidByHuman(e)) {
      watching.delete(e.session);
      if (typeof e.prompt === 'string' && !NO_WORDS.test(e.prompt) && !e.prompt_wrap && !NEW_SESSION_WRAP.test(e.prompt)) {
        lastSaid.set(e.session, { ts: e.ts ?? null, text: e.prompt, cut: e.prompt.length >= PROMPT_CAP });
      }
    }
    // 那一段裡 Claude 接著叫了 skill 或改了檔案:卡要是還在等你按,Claude 動不了——只是提示,不收卡
    if (e.session && watching.has(e.session) && ((e.tool === 'Skill' && e.skill) || (typeof e.file === 'string' && e.file))) {
      for (const c of watching.get(e.session)) if (!c.workedAfter) c.workedAfter = e.ts ?? null;
    }
    if (e.hook === 'PreToolUse' && e.tool === START_TOOL) {
      const init = typeof e.in_init === 'string' ? e.in_init : null;
      if (init === START_DIRECT) {
        // 直接開了:不是卡。同一個對話前面有同名的當場問的卡 → 這一次就是那張的下文(跟著後來那一次)
        const title = str(e.in_title).trim();
        const o = title ? (offers.get(e.session) ?? []).findLast((x) => x.title === title) : null;
        if (o) giveBrief(o.c, e, 'same-title');
        continue;
      }
      if (typeof e.in_proposal === 'string' && init !== START_PENDING && str(e.in_prompt).trim()) {
        // 帶代號又帶要貼的話:你按了 New session 之後 app 叫 Claude 補的說明。app 叫它補的時候,那一則只准有這一次呼叫——
        // 所以只配給這個對話**最近的那一張**當場問的卡,而且它還沒配到、提卡之後你還沒說過話(D 第一輪:以前配給前面任何一張還沒配到的,
        // 你選了在這裡做的那張,會被後來不相干的一次呼叫換上別人的說明、甚至被收成已開始)。同一個代號第二次(記兩次、補兩次)落在同一張。
        // 配不到(換工具之前就開著的對話、紀錄過了保留期限、時序不對)就什麼都不是——不是卡,也不是「照你的話開卡」(AC-3:不准掛到別張卡上)
        const key = Array.isArray(e.in_cut) && e.in_cut.includes('proposal') ? (e.use_id ? `use:${e.use_id}` : null) : `${e.session}|${e.in_proposal}`;
        const last = (offers.get(e.session) ?? []).at(-1)?.c ?? null;
        const c = (key && briefOf.get(key)) || (last && !last.brief && watching.get(e.session)?.has(last) ? last : null);
        if (c) {
          giveBrief(c, e, 'followup');
          // 補說明證明你按的是 New session:在那之前記到的動工不是「可能是你選了在這裡做」
          c.workedAfter = null;
          if (key) briefOf.set(key, c);
          watching.get(e.session)?.delete(c);
        }
        continue;
      }
      if (typeof e.in_proposal === 'string' && init !== START_PENDING) {
        // 同一次記兩次(plugin 跟舊接法同時掛著)算一次:用這次呼叫的 use_id;沒有就是這一筆自己
        if (e.session) {
          const byUse = opened.get(e.session) ?? new Map();
          const key = e.use_id ? `use:${e.use_id}` : `row:${byUse.size}:${e.ts}`;
          if (!byUse.has(key)) byUse.set(key, { ts: e.ts ?? null });
          opened.set(e.session, byUse);
        }
        continue;
      }
    }
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
      map.set(e.id, card({ id: e.id, ts: e.ts, source: 'claude', title: e.title ?? zhEn('（沒有標題）', '(no title)'), prompt: e.prompt ?? '', cwd: e.cwd ?? null, cut: e.cut === true ? ['prompt'] : [] }));
    }
    if (e.hook === 'PreToolUse' && SUGGEST_TOOLS.includes(e.tool)) {
      // 沒有 use_id 也要是一張卡(輸入畸形:不准因為少一個欄位就當成沒有這張卡,R1)。代號用「哪個對話、哪一秒、第幾張」湊,每次讀都一樣,「不做了」才指得回來
      const k = `${e.session ?? ''}@${e.ts}`;
      if (!e.use_id) noId.set(k, (noId.get(k) ?? 0) + 1);
      const id = e.use_id ?? `app-${k}-${noId.get(k)}`;
      // 同一個 use_id 出現兩次(plugin 跟舊接法同時掛著會記兩次)是同一張卡,不是兩張
      if (map.has(id)) continue;
      const title = str(e.in_title).trim();
      const c = card({ id, ts: e.ts, source: 'app', title: title || zhEn('（沒有標題）', '(no title)'), tldr: str(e.in_tldr).trim() || null, prompt: str(e.in_prompt),
        cwd: e.cwd ?? null, session: e.session ?? null, target: str(e.in_cwd) || null, cut: Array.isArray(e.in_cut) ? e.in_cut.filter((x) => typeof x === 'string') : [] });
      map.set(id, c);
      if (e.session) {
        // 同一個對話後來又叫了同名、會掛出來的卡:前面那張當場問的卡收起來,跟著後來那一張(不重複掛兩張)。
        // 沒有標題的不算同名;收起來的那張照樣看得到——兩件不同的事剛好同名、認錯了,看得出來
        if (title && e.ts) for (const o of offers.get(e.session) ?? []) if (o.title === title && !o.c.supersededAt) o.c.supersededAt = e.ts;
        if (e.tool === START_TOOL && e.in_init === START_OFFER) {
          c.ask = 'offer';
          c.said = lastSaid.get(e.session) ?? null;
          offers.set(e.session, [...(offers.get(e.session) ?? []), { c, title }]);
          watching.set(e.session, new Set([...(watching.get(e.session) ?? []), c]));
        }
      }
    }
    if (e.event === 'suggestion_dismissed' && map.has(e.id)) map.get(e.id).dismissedAt = e.ts;
  }
  const cards = [...map.values()];
  for (const s of cards) {
    if (s.source !== 'app' || !s.session) continue;
    const born = Date.parse(s.ts);
    // 收回／開卡比卡早 → 指的不可能是這張。時間讀不出來的**列著**:看不懂不等於比較早,多一行提醒不會讓卡消失
    const after = (m) => [...(m.get(s.session)?.values() ?? [])]
      .filter((w) => !(Number.isFinite(born) && Number.isFinite(Date.parse(w.ts)) && Date.parse(w.ts) < born))
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    s.withdrawals = after(withdrawn);
    s.opens = s.ask === 'offer' ? [] : after(opened);
  }
  // 當場問的卡沒有下文:要貼的話是監視器湊的那段(標題、原本那個對話、你那時說的話)——畫面照印,下面也拿它比「已開始」
  for (const list of offers.values()) for (const { c, title } of list) if (!c.brief) c.prompt = offerPrompt(title, titles.get(c.session) ?? null, c.said);
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
      // 有下文的當場問的卡多比一次背景說明:照 New session 開的對話,感測器記到的是標頭加背景說明(見上面 brief)
      const n = Math.max(startMatch(fp.prompt, s.prompt), s.brief && s.tldr ? startMatch(fp.prompt, s.tldr) : 0);
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
            firstTs: e.ts, lastTs: e.ts, prompts: 0, lastSaidAt: null, closedAt: null, reopenedByActivity: null };
      map.set(e.session, s);
    }
    if (e.title) s.title = e.title;           // session_title 會隨對話改名而更新,取最後一個
    if (e.cwd) s.cwd = e.cwd;
    // 「N 則訊息」只數你說的——背景工作的通知不算(D 多輪先問人 AC-8)。
    // lastSaidAt:你最後一次說話的時間。總表的「等你點頭」要它:規格記好之後你說過話,球就在 Claude 那邊(規格:還差什麼總表 AC-2)
    if (saidByHuman(e)) {
      s.prompts++;
      if (!s.lastSaidAt || Date.parse(e.ts) > Date.parse(s.lastSaidAt)) s.lastSaidAt = e.ts;
    }
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
export function sessionView(events, stages, sessionId, cpAt = null, cwd = null, { isCode = null, gitChanges = [], specFiles = null, root = null, mainRoot = null, folderEdit = null, mtimeOf = null } = {}) {
  const cleared = new Map();
  for (const e of events) {
    if (e.event === 'stage_cleared' && (e.session === sessionId || (cwd && e.cwd === cwd))) cleared.set(e.stage, e);
  }
  const mine = (e) => e.session === sessionId;
  // Claude 記的結論跟人的結案一樣是按工作區記的(CLI 沒有對話代號),所以這個對話所在工作區的也認
  // 結論與決定:CLI 記的 cwd 是 git 的根,對話開在子資料夾時對不上——有對話代號(by_session)就認代號(魔鬼教官第一輪)
  const inScope = (e) => e.session === sessionId || e.by_session === sessionId || (cwd && e.cwd === cwd);
  const reports = reportsIn(events, inScope);
  const spec = cwd ? specContext(events, { cwd, session: sessionId, cpAt }) : null;
  const view = roundView({ runs: runsPerStage(events, stages, mine), stages, cleared, cpAt, edits: editsOf(events, mine), isCode, reports, gitChanges, specFiles,
                           spec, root: root ?? cwd, mainRoot, reportLog: reportLogIn(events, inScope), decisions: decisionsIn(events, inScope), events, folderEdit,
                           // E 的「你說驗收過了」要逐筆判斷(E 自動驗收 AC-9):Claude 代記的記了對話代號,也認代號;只算這個對話代記的
                           clearLog: clearLogIn(events, inScope), session: sessionId, mtimeOf });
  return { view, cleared, reports };
}
