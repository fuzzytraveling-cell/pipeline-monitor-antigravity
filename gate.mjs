#!/usr/bin/env node
/**
 * gate.mjs —— 收工 hook(Stop)。規格:五關自動結案 AC-1(路徑看 CLAUDE.md 的表)
 *
 * Claude 準備收工時看一眼:這一回合有改到程式區的檔案、而這次改動的分級要求的關這一輪還沒跑
 * → 擋一次,用白話告訴它還缺哪幾關、該叫哪個指令。結論會過期的關(D)跑過之後又改了程式,**不叫它再跑**,
 * 叫它先停下來問人(D 多輪先問人 AC-1)。這一輪碰到危險清單定好之後才新加、沒人判斷過的程式檔,
 * 也叫它先停下來問人,不准自己決定(收工hook問危險清單 AC-1)。其他情況一律安靜放行。
 *
 * ⚠️ 三條契約:
 *   1. 任何錯誤一律放行(exit 0、不輸出),壞掉的事實記進 logs/_sensor.jsonl(gate_broken)。hook 壞了不准讓人下不了班。
 *   2. 同一個回合,同一件事只擋一次(D 多輪先問人 AC-7):擋的時候把「種類」記進 gate_blocked,這一回合擋過的種類不再擋,
 *      新的種類照擋(擋「D 還沒跑」→ 跑了 → 再擋「還沒記結論」→ 記了、修了 → 再擋「要不要再跑先問人」→ 問了就放行)。
 *      種類是有限的幾種,不會迴圈。stop_hook_active(擋過之後的收工)而這一回合找不到擋過的紀錄 → 放行;記不了紀錄就不擋——防迴圈的底線。
 *      (以前是 stop_hook_active 就放行、同一句話最多擋一次:擋完「D 還沒跑」,D 跑了沒記結論也管不到。)
 *   3. 只在**這一回合**有改到程式區的檔案時才擋,回答問題的回合安靜——例外只有「叫了 D 還沒記結論」(AC-6)。
 *      「這一回合」= 這個對話你說的最後一句話之後(背景工作的通知、子 agent 的回報不算;沒見過的格式取會擋的那邊——見 decide 裡);「改了沒」看三種證據,取較新者:感測器的改檔事件、
 *      git 說有改動的檔案的修改時間(用 Bash 寫檔會繞過感測器,L8)、五關算的最後一次改檔(感測器記過的檔現在的修改時間:用 Bash 還原也看得到)。
 *      感測器沒記到這個對話的任何一句話 → 不知道回合從哪開始 → 放行(R1:沒問到不當沒有)。
 *
 * 擋不擋、缺什麼,都從儀表板同一份事實算(lib/collect.mjs 的 cardFor → sessionTier,跟對話頁同一個函式),不另外算一份(老毛病 P2)。
 * 擋下來的那段話照語言設定(規格:技能與寫給AI的話中英切換 AC-5):main 讀一次,整段用同一種(lib/lang.mjs 的 withLang);
 *   decide 自己不讀——測試直接叫它,沒包就是中文,跟改之前一字不差。借來的句子(rerunLine、changeScope、ago)跟著同一種。
 * 「這次改了什麼」從這一輪的起點算(規格:這一輪的起點):Claude 收工前先存檔,該擋的照樣擋——以前沒章時比的是上一次存檔,一存就全部放行。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { cardFor, sessionTier } from './lib/collect.mjs';
import { logFileOf } from './lib/events.mjs';
import { sessionsOf, saidByHuman, promptKind, rerunLine, runMode, SKEW_MS, isEditEvent } from './lib/rounds.mjs';
import { isSubagentPayload } from './lib/transcript.mjs';
import { GATE_FILE, SENSOR_FILE } from './lib/faults.mjs';
import { ago } from './lib/git.mjs';
import { readTierConfig, codeFileFn, changeTimeOf, RANKS, DANGER_ASK, dangerAskLine, laterOf } from './lib/tier.mjs';
import { predictsDanger, isOpenSpec } from './lib/checklist.mjs';
import { changeScope } from './lib/scope.mjs';
import { commandFor as findCommand, pluginName } from './lib/skills.mjs';
import { optOutState } from './lib/mount.mjs';
import { codeHome, dataDir, makeDataDir } from './lib/paths.mjs';
import { zhEn, plural, readLang, withLang } from './lib/lang.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 程式的主資料夾:decide 預設從那裡讀關卡清單(stages.json)。資料不住那裡了(規格:紀錄搬到固定的家)
const MONITOR_DIR = codeHome(HERE);
// 紀錄住哪:lib/paths.mjs 的 dataDir(跟 hook.sh 同一條規則)。用到才問、不在載入時算——好幾支測試在同一個程式裡載入這支,
// 那一刻還沒換上假的家;而且第一次問的時候會順便搬家,搬家要在收工 hook 真的跑的時候才做。
const logDir = () => dataDir('logs', HERE);
const PLUGIN = pluginName(HERE);

/**
 * 記一筆「收工 hook 自己壞了」。帶那次的資料夾:心跳只留最後一次、全機一份,沒有資料夾就分不出
 * 「出錯的那個資料夾之後又跑過了」還是「只是別的資料夾跑過」(規格:agent回報與故障記號 AC-5)。
 * why 是程式的錯誤原文——只給 Claude 查,畫面不印(lib/faults.mjs)。
 */
function noteBroken(why, dir = logDir(), cwd = null) {
  try {
    makeDataDir(dir);
    appendFileSync(join(dir, SENSOR_FILE), JSON.stringify({ ts: new Date().toISOString(), event: 'gate_broken', why: String(why).slice(0, 200),
      ...(typeof cwd === 'string' ? { cwd } : {}) }) + '\n');
  } catch { /* 連記都記不了,就真的算了 */ }
}

/** 這一關要叫哪個指令:專案自己有同名指令就叫它的,沒有才叫 plugin 的;兩邊都沒有回 null(要求不了)。住在 lib/skills.mjs,--spec 也用。 */
function commandFor(skill, root, mainRoot, home) {
  return home === undefined ? findCommand(skill, root, mainRoot, PLUGIN) : findCommand(skill, root, mainRoot, PLUGIN, home);
}

/**
 * 決定擋不擋。回 null = 放行;否則回 { reason, missing, level, project, cwd, session, again }。
 * 除了讀檔與問 git,沒有副作用——記紀錄是 main() 的事,測試才能直接呼叫。
 * missing 是這一次擋的「種類」:關卡代號(A、C、D、E)、tests、checklist,結論會過期的關(D、E)另有兩種——
 *   <關>:report(叫了還沒記結論,AC-6)、<關>:ask(之後又改了程式,要不要再跑／再走先問人,AC-1)。記進 gate_blocked,這一回合同一種不再擋(AC-7)。
 *   danger:ask(lib/tier.mjs 的 DANGER_ASK):沒人判斷過的新檔,先問人(收工hook問危險清單 AC-1)——「這次先不看」算不算數也找這一種。
 *   E 只有在專案自己的分級把它放進清單時才會出現(E 自動驗收 AC-8,預設三級都不放)。
 */
export function decide({ payload, monitorDir = MONITOR_DIR, skillHome = undefined }) {
  if (!payload || typeof payload !== 'object') return null;
  // Antigravity Stop 契約（階段 0 實測事實 #6、AC-6）：
  // 使用者按取消、系統出錯、背景任務未結束（fullyIdle:false）、或 subagent 結束，一律立刻放行。
  if (typeof payload.terminationReason === 'string' && payload.terminationReason && payload.terminationReason !== 'NO_TOOL_CALL') return null;
  if (payload.error) return null;
  if (payload.fullyIdle === false) return null;
  if (isSubagentPayload(payload)) return null;
  // 防迴圈：階段 0 實測確認第二次執行時 continuationActive 仍為 false，必須認 executionNum > 0。
  const again = Number(payload.executionNum) > 0 || payload.continuationActive === true || payload.stop_hook_active === true;
  const path = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd
    : (Array.isArray(payload.workspacePaths) && typeof payload.workspacePaths[0] === 'string' && payload.workspacePaths[0] ? payload.workspacePaths[0] : null);
  if (!path || !existsSync(path)) return null;
  const sid = typeof payload.conversationId === 'string' && payload.conversationId ? payload.conversationId
    : (typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null);
  if (!sid) return null;
  const tp = typeof payload.transcriptPath === 'string' && payload.transcriptPath ? payload.transcriptPath : null;
  const extraTranscripts = tp ? new Map([[sid, tp]]) : null;

  const got = cardFor({ monitorDir, path, skillHome, extraTranscripts, sessionId: sid });
  if (!got) return null;
  const { card, events, stages, ctx } = got;
  if (card.gone || card.notGit) return null;
  if (optOutState(ctx.root, ctx.mainRoot)) return null;          // 退出記錄的專案,連感測器都不記,也不擋
  const cfg = readTierConfig(ctx.root, ctx.mainRoot, monitorDir);
  if (cfg.state !== 'ok') return null;                          // 沒設定分級／讀不懂／不分級：不擋（含規格預審，Oscar 2026-11-23 拍板）
  // 這個對話的分級:跟對話頁同一個函式。共用工作區時從這個對話自己的起點算,別的對話更早存的檔不算到它頭上
  const shared = sessionsOf(events).find((s) => s.id === sid)?.sharesCwd === true;
  const mineNow = sessionTier({ card, events, stages, session: sid, cwd: path, shared, monitorDir });

  const mine = events.filter((e) => !e._subagent && e.session === sid);
  const timesOf = (pick) => mine.filter(pick).map((e) => Date.parse(e.ts)).filter(Number.isFinite).sort((a, b) => a - b);
  const said = timesOf(saidByHuman), odd = timesOf((e) => promptKind(e) === 'unknown');
  const turnStart = said.at(-1) ?? odd[0] ?? null;
  if (turnStart === null) return null;
  const oddStart = Math.max(turnStart, odd.at(-1) ?? -Infinity);
  const blockedFrom = (from) => new Set(mine.filter((e) => e.event === 'gate_blocked' && Date.parse(e.ts) >= from)
    .flatMap((e) => (Array.isArray(e.missing) ? e.missing : [])));
  const blocked = blockedFrom(turnStart), blockedOdd = blockedFrom(oddStart);
  if (again && !blockedOdd.size) return null;

  const tier = mineNow.tier;
  const hits = tier?.state === 'ok' ? [...(tier.machine?.hits?.danger ?? []), ...(tier.machine?.hits?.code ?? [])] : [];
  const mtimes = hits.map((f) => changeTimeOf(ctx.root, f)).filter((t) => t !== null);
  const inArea = codeFileFn(ctx.root, cfg.config);
  // 用單一真相來源 isEditEvent（AC-4）：read_file / view_file 絕不當成改過程式檔
  const editTs = mine.filter((e) => isEditEvent(e) && inArea(e.file)).map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  // 第三種證據:roundView 算的「最後一次改檔」——感測器記過的程式檔現在的修改時間也在裡面,用 Bash 還原(git 說跟起點沒差)看得到。
  // 不吃它的話,儀表板說 D、E「要不要再跑／再走由你決定」,這裡卻當成這一回合沒改程式、不叫 Claude 先問(魔鬼教官第二輪,老毛病 P2)
  const viewEdit = Date.parse(mineNow.view?.lastEdit);
  const changeTimes = [...mtimes, ...editTs, ...(Number.isFinite(viewEdit) ? [viewEdit] : [])];
  const changedSince = (from) => changeTimes.some((t) => t >= from - SKEW_MS);
  const changedThisTurn = changedSince(turnStart), changedOdd = changedSince(oddStart);

  // 規格連結只認這個對話記的(施工對話認規格 AC-2):五關、分級卡、這裡都從同一份 specContext 算(sessionTier 裡的 sessionView)
  const view = mineNow.view.stages;
  const specStage = stages.find((s) => s.skill);   // 寫規格的那一關 = 第一個指令關(跟一輪的分界同一個認法,不寫死代號)
  const bStage = view.find((v) => v.type === 'main-conversation') ?? null;
  const aStage = specStage ? view.find((v) => v.id === specStage.id) ?? null : null;

  // A → D 規格預審(寫規格後、動手前):純寫規格回合機器分級只到 T0(requires 為空),所以檢查擺在 tier.requires 之前。
  // 只在尚未開工(!bStage?.ranAt && !changedThisTurn && !changedOdd)且非 --spec 連結(!aStage?.link)時檢查：
  //   1. 叫了 spec-precheck 卻還沒記結論(no-report) → 擋一次 A:precheck:report
  //   2. 本回合寫完預測達最高級的規格(state==='none') → 擋一次 A:precheck；之後再改規格不重擋(AC-4)
  if (!bStage?.ranAt && !changedThisTurn && !changedOdd && !aStage?.link && aStage?.precheck) {
    const blockedAlready = (key) => blocked.has(key) && blockedOdd.has(key);
    if (aStage.precheck.state === 'no-report' && !blockedAlready('A:precheck:report')) {
      const reason = [
        zhEn('[產線監視器] 這一輪叫了規格預審，還沒記結論：', '[Pipeline Monitor] This round called spec precheck, and no conclusion has been recorded yet:'),
        zhEn(
          '- 規格預審：叫了，還沒記結論。還在背景跑就照實說還在跑，不准先記 ok 交差；跑完照這支技能收尾記：agy-pipeline --precheck ok|found "…"。沒跑完（中斷了）就再叫一次',
          '- Spec precheck: called, no conclusion recorded yet. If it is still running in the background, say truthfully that it is still running; never record ok early just to finish. When it is done, record it with: agy-pipeline --precheck ok|found "…". If it did not finish (it was interrupted), call it again',
        ),
        zhEn('先把這一步補完（或還在跑就照實告訴使用者）再收工。', 'Finish this step (or tell the user truthfully if it is still running) before wrapping up.'),
      ].join('\n');
      return { reason, missing: ['A:precheck:report'], level: cfg.config.levels.none.id, project: got.project, cwd: path, session: sid, logDir: got.logDir, again };
    }
    const dangerId = cfg.config.levels.danger.id;
    const precheckCmd = commandFor('spec-precheck', ctx.root, ctx.mainRoot, skillHome);
    const aInTurn = [aStage.ranAt, aStage.doneAt, ...mine.filter((e) => isEditEvent(e) && isOpenSpec(e.file)).map((e) => e.ts)]
      .map((t) => Date.parse(t)).some((ms) => Number.isFinite(ms) && ms >= turnStart - SKEW_MS);
    if (aStage.precheck.state === 'none' && aStage.checklist?.parsed === true && aInTurn
        && predictsDanger(aStage.checklist, dangerId) === true && precheckCmd && !blockedAlready('A:precheck')) {
      const reason = [
        zhEn(
          `[產線監視器] 這一輪寫了預測至少 ${dangerId} 的規格，還沒開始寫程式，收工前還缺：`,
          `[Pipeline Monitor] This round wrote a spec predicting at least ${dangerId}, and coding has not started yet. Still missing before wrapping up:`,
        ),
        zhEn(
          `- 規格預審：這一輪還沒跑 → 跑 ${precheckCmd}（派 1 個獨立唯讀子 agent 對照已知死法與通用三條紅線 R1–R3；不改任何檔；收尾記 agy-pipeline --precheck ok|found "…"）。記完就停，不要自己重跑`,
          `- Spec precheck: not run yet this round → run ${precheckCmd} (send 1 independent read-only subagent against known failure patterns and R1-R3; change no files; record with agy-pipeline --precheck ok|found "…"). Stop once recorded and never run again on your own`,
        ),
        zhEn('先補完再收工；記完就停，不要自己再重跑。', 'Finish this before wrapping up; once recorded, stop and don\'t run it again on your own.'),
      ].join('\n');
      return { reason, missing: ['A:precheck'], level: dangerId, project: got.project, cwd: path, session: sid, logDir: got.logDir, again };
    }
  }

  if (!tier || tier.state !== 'ok') return null;                  // 沒設定分級就沒有「該跑的關」;只看得到還沒存檔的而且沒有(unseen)也要不了
  const requires = tier.final?.requires ?? [];
  // 危險清單定好之後才新加、沒人判斷過的程式檔(規格:收工hook問危險清單 AC-1、AC-4):分級卡算好的那一份(buildTier 的 stale),不另算。
  const top = (tier.final?.rank ?? RANKS.length - 1) >= RANKS.length - 1;
  const fresh = !top && tier.stale?.since && Array.isArray(tier.stale.fresh) ? tier.stale.fresh : [];
  if (!requires.length && !fresh.length) return null;
  const missing = [];
  // 危險清單(規格:收工hook問危險清單 AC-1)排第一:他的答案會改這一輪的等級,其他缺的關跟著變。
  // 這個對話說過「這次先不看」、而且算數的那幾個檔不再問(AC-3;--tier-later 記的,用 by_session 記,所以給整份紀錄、不給 mine)
  if (fresh.length) {
    const later = laterOf(events, { session: sid, since: mineNow.view?.origin?.at ?? null });
    const ask = fresh.filter((f) => !later.covered.has(f));
    if (ask.length) {
      missing.push({ key: DANGER_ASK, ask: true,
        line: dangerAskLine({ since: tier.stale.since, fresh: ask }, { dangerId: tier.levels.danger.id, deferred: fresh.length - ask.length, ago }) });
    }
  }
  // 有規格的輪次:改了程式就要回頭對清單(AC-6)。沒標的 AC 列出來;⏳ 待討論的不算沒標——那是要跟人談,不是要 Claude 補。
  // 規格分批做的話(--spec 帶了 AC 代號),只要求這一批(施工對話認規格 AC-8);不在這一批的沒標不算
  const a = view.find((v) => v.checklist?.parsed);
  if (a) {
    const cl = a.checklist;
    const relOf = (f) => (String(f ?? '').startsWith(ctx.root) ? String(f).slice(ctx.root.length + 1) : f);
    const file = relOf(cl.file);
    const ids = (c) => c.items.filter((x) => x.state === 'none' && x.inBatch !== false).map((x) => x.id);
    const few = (list) => zhEn(`${list.slice(0, 6).join('、')}${list.length > 6 ? ` 等 ${list.length} 條` : ''}`, `${list.slice(0, 6).join(', ')}${list.length > 6 ? ` and others (${list.length} in all)` : ''}`);
    // 勾的寫法:規格是哪一種語言寫的都認(lib/checklist.mjs),英文那一句教英文的寫法
    const marks = () => zhEn('「✅ 對過 日期」或「⏳ 待討論：原因」', '"✅ ticked <date>" or "⏳ to discuss: <reason>"');
    if (cl.multi) {
      // 一輪寫了好幾份(規格:多份規格與新資料夾的起點 AC-3):每一份的清單都要對,分份列。以前只拿第一份讀得出的清單——
      // 對完報告時間那 5 條就放行,語音斷線那 10 條沒對完也不攔(2026-10-02 實測)。讀不到的那份要不了(檔案不在,打不了勾),A 那格會講
      const per = cl.parts.filter((p) => p.checklist?.parsed && p.checklist.unmarked > 0).map((p) => zhEn(`${relOf(p.checklist.file)} 的 ${few(ids(p.checklist))}`, `${few(ids(p.checklist))} in ${relOf(p.checklist.file)}`));
      if (per.length) {
        missing.push({ key: 'checklist', line: zhEn(`- 對規格的清單（這一輪 ${cl.parts.length} 份規格）：${per.join('；')} 還沒標——在每份規格每條 AC 的標題行末尾加${marks()}`,
          `- Check the specs' checklists (${cl.parts.length} specs this round): ${per.join('; ')} not marked yet. At the end of every AC heading line in each spec, add ${marks()}`) });
      }
    } else if (cl.batchMissing?.length) {
      missing.push({ key: 'checklist', line: zhEn(`- 對規格的清單：這一批記的 ${cl.batchMissing.join('、')} 在 ${file} 裡找不到了（可能改過號）——重記一次 agy-pipeline --spec ${file} <這一批的 AC 代號>`,
        `- Check the spec's checklist: ${cl.batchMissing.join(', ')}, recorded for this batch, can't be found in ${file} any more (maybe renumbered). Record it again: agy-pipeline --spec ${file} <this batch's AC IDs>`) });
    } else if (cl.unmarked > 0) {
      missing.push({ key: 'checklist', line: zhEn(`- 對規格的清單：${few(ids(cl))} 還沒標——在 ${file} 每條 AC 的標題行末尾加${marks()}`,
        `- Check the spec's checklist: ${few(ids(cl))} not marked yet. At the end of every AC heading line in ${file}, add ${marks()}`) });
    } else if (cl.preMarked) {
      // 連上的規格勾都是連上之前打的:可能是別的對話對過那一版(R2,魔鬼教官 2026-09-21),也可能是這個對話先對了清單才記 --spec——
      // 分不出來,所以只講分不出來(R1,第二輪 2026-09-22);改了程式就回頭對一次,重標日期就算數
      missing.push({ key: 'checklist', line: zhEn(`- 對規格的清單：${file} 的勾在連上之前就打好了，分不出是不是這個對話打的——改了程式就回頭對一次（對過的條目把日期改成今天，要討論的標「⏳ 待討論：原因」）`,
        `- Check the spec's checklist: the marks in ${file} were made before it was linked, so it can't tell whether this conversation made them. After changing code, check it again (change the date on items you've gone over to today; mark ones to discuss "⏳ to discuss: <reason>")`) });
    }
  }
  for (const key of requires) {
    if (key === 'tests') {
      const n = mineNow.health?.touchedTests ?? null;
      if (n === null || n > 0) continue;                           // 問不到就不要求(R1)
      missing.push({ key, line: zhEn('- 補測試：這一輪還沒新增或修改任何測試檔', '- Add tests: this round hasn\'t added or changed any test file yet') });
      continue;
    }
    const st = view.find((s) => s.id === key);
    if (!st || !st.skill) continue;                                // B、未建的關、沒有指令的瀏覽器關:不是 hook 能要求的
    // 規格是別的對話寫的、Claude 記了照哪份施工 → 不叫重跑 A(AC-7);連結分不出是哪個對話記的、而這個對話可能就是 → 不擋(AC-2)
    if (st.id === specStage?.id && (st.link || st.unsure)) continue;
    const cmd = commandFor(st.skill, ctx.root, ctx.mainRoot, skillHome);
    const name = `${st.id} ${st.name}`;
    // E 驗收(瀏覽器那一關,E 自動驗收 AC-8):分級把 E 放進清單時,要的是「Claude 照規格走過一遍」,不是要使用者按——
    // 讀 roundView 算好的 E 這一輪在哪(acceptStateOf),跟五關那一格、分級卡同一份。使用者說驗收過了(之後沒再改程式)就不要求
    if (st.rerunAfterChange && st.rerun && st.type === 'browser') {
      const es = st.estate ?? st.rerun.estate ?? st.rerun.state;
      if (es === 'none') {
        if (!cmd) continue;                                        // 指令不存在,要求了也做不到
        missing.push({ key, line: zhEn(`- ${name}：這一輪還沒走 → 跑 ${cmd}（照這一輪的規格逐條在畫面上看，每條記看到了（附畫面上的原文）／沒看到／驗不了；`
          + '「驗收過了」只有使用者能說）。走完不要自己再走，要再走先問使用者',
          `- ${name}: not walked through yet this round → run ${cmd} (look at this round's spec item by item on the screen, recording each as seen (with the original text from the screen) / not seen / can't verify; `
          + 'only the user can say "accepted"). After walking through it, don\'t walk through it again on your own; to walk through it again, ask the user first') });
      } else if (es === 'no-report') {
        missing.push({ key: `${key}:report`, anyTurn: true,
          line: zhEn(`- ${name}：叫了，還沒記結論。還在走就照實說還在走，不准先記結論交差；走完照那支指令的收尾記：agy-pipeline --report ${st.id} ok|found "…"。`
            + `沒走完（中斷了）就再叫一次，那還算第一趟；使用者說不用走了就 agy-pipeline --decide ${st.id} skip "使用者的原話"`,
          `- ${name}: called, no conclusion recorded yet. If it's still walking through, say truthfully that it's still walking through; never record a conclusion early just to finish. When it's done, record it the way that command's ending says: agy-pipeline --report ${st.id} ok|found "…". `
            + `If it didn't finish (it was interrupted), call it again; that still counts as the first walk-through. If the user says there's no need to walk through it: agy-pipeline --decide ${st.id} skip "the user's own words"`) });
      } else if (es === 'ask' || es === 'accepted-stale') {
        const why = es === 'accepted-stale' ? zhEn('使用者說驗收過了之後，又改了程式檔', 'code files changed after the user said it\'s accepted') : rerunLine(st.rerun, { ago });
        missing.push({ key: `${key}:ask`, ask: true,
          line: zhEn(`- ${name}：${why}。不要自己再走——先停下來問使用者（白話＋舉例）：之後改了什麼、可能影響哪幾條、上一趟從叫到記結論花了多久`
            + `（跑 agy-pipeline --round ${st.id} 拿）、不再走的風險，最後一行給建議。使用者說走才走；說不用就 agy-pipeline --decide ${st.id} skip "使用者的原話"；`
            + `說看過了、可以（驗收現在這一版），才照他的原話 agy-pipeline --clear ${st.id} "使用者的原話"——「不用再走」不是「驗收過了」，不准記成 --clear`,
          `- ${name}: ${why}. Don't walk through it again on your own; stop and ask the user first (plain words plus examples): what changed since, which items it might affect, how long the last walk-through took from the call to the recorded conclusion `
            + `(run agy-pipeline --round ${st.id} to get it), and the risk of not walking through again; the last line gives a recommendation. Walk through it only if the user says so. If they say no need: agy-pipeline --decide ${st.id} skip "the user's own words". `
            + `Only if they say they've looked and it's fine (accepting this version): agy-pipeline --clear ${st.id} "the user's own words". "No need to walk through again" isn't "accepted": never record it as --clear`) });
      }
      continue;
    }
    if (st.rerunAfterChange && st.rerun) {
      const r = st.rerun;
      if (r.state === 'none') {
        if (!cmd) continue;
        const how = runMode({ nth: 1, tierState: 'ok', levelId: tier.final.id, agents: tier.final.agents === true }).line;
        missing.push({ key, line: zhEn(`- ${name}：${rerunLine(r)} → 跑 ${cmd}（${how}）。修完不要自己再跑這一關，要再跑先問使用者`,
          `- ${name}: ${rerunLine(r)} → run ${cmd} (${how}). After fixing, don't run this stage again on your own; to run it again, ask the user first`) });
      } else if (r.state === 'no-report') {
        missing.push({ key: `${key}:report`, anyTurn: true,
          line: zhEn(`- ${name}：叫了，還沒記結論。還在背景跑就照實說還在跑，不准先記 ok 交差；跑完照那支指令的收尾記：agy-pipeline --report ${st.id} ok|found "…"。`
            + `沒跑完（中斷了）就再叫一次，那還算第一輪；使用者說不用跑了就 agy-pipeline --decide ${st.id} skip "使用者的原話"`,
          `- ${name}: called, no conclusion recorded yet. If it's still running in the background, say truthfully that it's still running; never record ok early just to finish. When it's done, record it the way that command's ending says: agy-pipeline --report ${st.id} ok|found "…". `
            + `If it didn't finish (it was interrupted), call it again; that still counts as the first round. If the user says there's no need to run it: agy-pipeline --decide ${st.id} skip "the user's own words"`) });
      } else if (r.state === 'ask') {
        missing.push({ key: `${key}:ask`, ask: true,
          line: zhEn(`- ${name}：${rerunLine(r, { ago })}。不要自己再跑——先停下來問使用者（白話＋舉例）：第一輪之後改了什麼、每條修法標「小修」或「建議再看」、`
            + `上一輪從叫到記結論花了多久、不跑的風險（前三件跑 agy-pipeline --round ${st.id} 拿），最後一行給建議。使用者說跑才跑；說不用就 agy-pipeline --decide ${st.id} skip "使用者的原話"`,
          `- ${name}: ${rerunLine(r, { ago })}. Don't run it again on your own; stop and ask the user first (plain words plus examples): what changed after the first round, each fix marked "small fix" or "worth another look", `
            + `how long the last round took from the call to the recorded conclusion, and the risk of not running it (run agy-pipeline --round ${st.id} to get the first three); the last line gives a recommendation. Run it only if the user says so. If they say no need: agy-pipeline --decide ${st.id} skip "the user's own words"`) });
      }
      continue;
    }
    if (st.ranAt) continue;
    if (!cmd) continue;
    const why = zhEn('這一輪還沒跑', 'not run yet this round');
    if (st.id === specStage?.id) {
      const hint = st.hint && !st.hint.cut ? zhEn(`（從第一句話看，可能是 ${st.hint.path}）`, ` (from the first message, it might be ${st.hint.path})`) : '';
      missing.push({ key, line: zhEn(`- ${name}：${why}。照別的對話寫好的規格施工的話跑 agy-pipeline --spec <規格檔>${hint}；還沒有規格才跑 ${cmd}`,
        `- ${name}: ${why}. If you're building from a spec another conversation wrote, run agy-pipeline --spec <spec file>${hint}; run ${cmd} only if there's no spec yet`) });
      continue;
    }
    missing.push({ key, line: zhEn(`- ${name}：${why} → 跑 ${cmd}`, `- ${name}: ${why} → run ${cmd}`) });
  }
  // 只在這一回合改到程式時才擋(契約 3);例外只有「叫了還沒記結論」(AC-6)。這一回合擋過的種類不再擋(AC-7)。
  // 兩種讀法(上面)任何一種要擋就擋;沒有沒見過的訊息時兩種一樣
  const dueBy = (seen, changed) => (m) => !seen.has(m.key) && (changed || m.anyTurn);
  const due = missing.filter((m) => dueBy(blocked, changedThisTurn)(m) || dueBy(blockedOdd, changedOdd)(m));
  if (!due.length) return null;

  const level = tier.final.id;
  // 危險清單的檔跟程式區的檔分開列:以前全部掛在「碰到危險清單：」底下,只在程式區的檔也被講成危險(2026-09-22 收工 hook 自己印出來的)
  const list = (xs) => zhEn(xs.slice(0, 3).join('、') + (xs.length > 3 ? ` 等 ${xs.length} 個檔` : ''), xs.slice(0, 3).join(', ') + (xs.length > 3 ? ` and others (${plural(xs.length, 'file')} in all)` : ''));
  const dangerHits = tier.machine?.hits?.danger ?? [], codeHits = tier.machine?.hits?.code ?? [];
  const touched = dangerHits.length
    ? zhEn(`碰到危險清單：${list(dangerHits)}${codeHits.length ? `；另外碰到程式區 ${codeHits.length} 個檔` : ''}`,
      `touched the danger list: ${list(dangerHits)}${codeHits.length ? `; also touched ${plural(codeHits.length, 'file')} in the code area` : ''}`)
    : zhEn(`碰到程式區：${list(codeHits)}`, `touched the code area: ${list(codeHits)}`);
  // 從哪裡算起跟儀表板同一句話(lib/scope.mjs):「這一輪，含已存檔的」——Claude 才不會以為存了檔就不算
  const scope = changeScope(mineNow.base, () => '').short;
  // 有「先問人」那一行時,最後那句不准叫它「先把缺的跑完」——那會跟「不要自己再跑」打架(AC-7);危險清單那一行也是先問人(收工hook問危險清單 AC-1)
  const closing = due.some((m) => m.ask)
    ? zhEn('標「不要自己再跑」「不要自己再走」「不要自己決定」的那一項是要你先停下來問使用者、等使用者決定，不是叫你自己動手；其他缺的先補完再收工。這是分級的要求，不是建議。',
      'The items that say "don\'t run it again on your own", "don\'t walk through it again on your own" or "don\'t decide yourself" mean stop and ask the user first and wait for their decision, not do it yourself; finish the other missing items before wrapping up. This is what the tier requires, not a suggestion.')
    : zhEn('先把缺的跑完再收工；跑完照那支指令的收尾把結果記給儀表板。這是分級的要求，不是建議。',
      'Run what\'s missing before wrapping up; when done, record the result for the dashboard the way that command\'s ending says. This is what the tier requires, not a suggestion.');
  const reason = [
    zhEn(`[產線監視器] 這次改動至少 ${level}（${touched}；${scope}）。收工前還缺：`, `[Pipeline Monitor] This change is at least ${level} (${touched}; ${scope}). Still missing before wrapping up:`),
    ...due.map((m) => m.line),
    closing,
  ].join('\n');
  return { reason, missing: due.map((m) => m.key), level, project: got.project, cwd: path, session: sid, logDir: got.logDir, again };
}

function main() {
  const allow = () => { process.stdout.write('{}\n'); return 0; };
  let payload = null;
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return allow(); }
  const cwd = (typeof payload?.cwd === 'string' && payload.cwd) ? payload.cwd
    : (typeof payload?.workspacePaths?.[0] === 'string' && payload.workspacePaths[0]) ? payload.workspacePaths[0] : null;
  // 心跳:每次跑都留時間(不是紀錄,是一個會被蓋掉的小檔)。沒有它,「hook 掛著但從沒被觸發」跟「一切正常」長得一模一樣(L13、老毛病 P3)
  try { const dir = logDir(); makeDataDir(dir); writeFileSync(join(dir, GATE_FILE), JSON.stringify({ ts: new Date().toISOString(), cwd }) + '\n'); } catch { /* 留不了就算了,不影響判斷 */ }
  let d = null;
  try { d = withLang(readLang().lang, () => decide({ payload })); } catch (e) { noteBroken(e?.message ?? e, undefined, cwd); return allow(); }
  if (!d) return allow();
  try {
    appendFileSync(logFileOf(d.logDir, d.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'gate_blocked', session: d.session, cwd: d.cwd, level: d.level, missing: d.missing, source: 'gate',
    }) + '\n');
  } catch (e) {
    noteBroken(`記不了 gate_blocked：${e?.message ?? e}`, d.logDir, d.cwd);
    if (d.again) return allow();
  }
  // Antigravity Stop 契約（階段 0 實測事實 #6）：擋收工回傳 {"decision":"continue","reason":"..."}
  process.stdout.write(JSON.stringify({ decision: 'continue', reason: d.reason }) + '\n');
  return 0;
}

// 跟 status.mjs 同一個判斷:兩邊都解析成真實路徑再比(L1、誠實修補 E1——透過捷徑跑時 argv[1] 是捷徑)
function isMain() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? ''); } catch { return false; }
}
if (isMain()) process.exit(main());
