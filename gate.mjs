#!/usr/bin/env node
/**
 * gate.mjs —— 收工 hook(Stop)。規格:docs/進行中/五關自動結案.md AC-1
 *
 * Claude 準備收工時看一眼:這一回合有改到程式區的檔案、而這次改動的分級要求的關還沒在最後一次改檔之後跑過
 * → 擋一次,用白話告訴它還缺哪幾關、該叫哪個指令。其他情況一律安靜放行。
 *
 * ⚠️ 三條契約:
 *   1. 任何錯誤一律放行(exit 0、不輸出),壞掉的事實記進 logs/_sensor.jsonl(gate_broken)。hook 壞了不准讓人下不了班。
 *   2. stop_hook_active 為 true 就放行——那是 Claude Code 說「上一次已經擋過,這是繼續之後的收工」,再擋就是迴圈。
 *      所以同一個 prompt 最多擋一次;Claude 不聽就讓它走,儀表板會標紅。
 *   3. 只在**這一回合**有改到程式區的檔案時才擋,回答問題的回合安靜。
 *      「這一回合」= 這個對話最後一句話之後;「改了沒」看兩種證據,取較新者:感測器的改檔事件,
 *      與 git 說有改動的檔案的修改時間(用 Bash 寫檔會繞過感測器,L8)。
 *      感測器沒記到這個對話的任何一句話 → 不知道回合從哪開始 → 放行(R1:沒問到不當沒有)。
 *
 * 擋不擋、缺什麼,都從儀表板同一份事實算(lib/collect.mjs 的 cardFor → buildTier／roundView),不另外算一份(老毛病 P2)。
 */
import { readFileSync, appendFileSync, existsSync, statSync, mkdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { cardFor } from './lib/collect.mjs';
import { stagesOfSession, logFileOf } from './lib/events.mjs';
import { readTierConfig, codeFileFn } from './lib/tier.mjs';
import { skillAvailable } from './lib/skills.mjs';
import { optOutState } from './lib/mount.mjs';
import { monitorHome } from './lib/paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 資料住在主資料夾(lib/paths.mjs,PIPELINE_MONITOR_HOME 可以換掉);紀錄位置跟 hook.sh 看同一個變數
const MONITOR_DIR = monitorHome(HERE);
const LOG_DIR = process.env.PIPELINE_MONITOR_LOG_DIR ?? join(MONITOR_DIR, 'logs');
const PLUGIN = (() => {
  try { return JSON.parse(readFileSync(join(HERE, '.claude-plugin', 'plugin.json'), 'utf8')).name; } catch { return 'pipeline-monitor'; }
})();
// 時間戳來自兩台鐘(感測器寫的 ISO 時間、檔案系統的 mtime),留兩秒的誤差
const SKEW_MS = 2000;

function noteBroken(why, logDir = LOG_DIR) {
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, '_sensor.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'gate_broken', why: String(why).slice(0, 200) }) + '\n');
  } catch { /* 連記都記不了,就真的算了 */ }
}

/** 這一關要叫哪個指令:專案自己有同名指令就叫它的,沒有才叫 plugin 的;兩邊都沒有回 null(要求不了)。 */
function commandFor(skill, root, mainRoot, home) {
  for (const d of new Set([root, mainRoot].filter(Boolean))) {
    if (existsSync(join(d, '.claude', 'commands', `${skill}.md`)) || existsSync(join(d, '.claude', 'skills', skill, 'SKILL.md'))) return `/${skill}`;
  }
  const av = home === undefined ? skillAvailable(skill, root, mainRoot) : skillAvailable(skill, root, mainRoot, home);
  return av.found ? `/${PLUGIN}:${skill}` : null;
}

/**
 * 決定擋不擋。回 null = 放行;否則回 { reason, missing, level, project, cwd, session }。
 * 除了讀檔與問 git,沒有副作用——記紀錄是 main() 的事,測試才能直接呼叫。
 */
export function decide({ payload, monitorDir = MONITOR_DIR, skillHome = undefined }) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.stop_hook_active === true) return null;
  const path = typeof payload.cwd === 'string' ? payload.cwd : null;
  if (!path || !existsSync(path)) return null;
  const sid = typeof payload.session_id === 'string' ? payload.session_id : null;
  if (!sid) return null;

  const got = cardFor({ monitorDir, path, skillHome });
  if (!got) return null;
  const { card, events, stages, ctx } = got;
  if (card.gone || card.notGit) return null;
  if (optOutState(ctx.root, ctx.mainRoot)) return null;          // 退出記錄的專案,連感測器都不記,也不擋
  const tier = card.tier;
  if (!tier || tier.state !== 'ok') return null;                  // 沒設定分級就沒有「該跑的關」
  const requires = tier.final?.requires ?? [];
  if (!requires.length) return null;
  const cfg = readTierConfig(ctx.root, ctx.mainRoot, monitorDir);
  if (cfg.state !== 'ok') return null;

  // 這一回合從哪開始:這個對話最後一句話。沒記到 → 放行(契約 3)
  const mine = events.filter((e) => e.session === sid);
  const turnStart = mine.filter((e) => e.hook === 'UserPromptSubmit').map((e) => Date.parse(e.ts))
    .filter(Number.isFinite).sort((a, b) => a - b).at(-1) ?? null;
  if (turnStart === null) return null;

  // 這一輪改到程式區／危險清單的檔案(git 說的,跟儀表板同一份),與它們的修改時間
  const hits = [...(tier.machine?.hits?.danger ?? []), ...(tier.machine?.hits?.code ?? [])];
  const mtimes = hits.map((f) => { try { return statSync(join(ctx.root, f)).mtimeMs; } catch { return null; } }).filter((t) => t !== null);
  // 感測器記到的、落在程式區的改檔事件(這個對話)——「算不算程式檔」跟五關、分級用同一個判斷(lib/tier.mjs)
  const inArea = codeFileFn(ctx.root, cfg.config);
  const editTs = mine.filter((e) => e.hook === 'PostToolUse' && inArea(e.file)).map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  const changedThisTurn = [...mtimes, ...editTs].some((t) => t >= turnStart - SKEW_MS);
  if (!changedThisTurn) return null;
  const lastChange = Math.max(...mtimes, ...editTs);

  const cpAt = card.checkpointRelation?.state === 'ok' ? card.checkpoint?.at ?? null : null;
  const view = stagesOfSession(events, stages, sid, cpAt, path);
  const missing = [];
  // 有規格的輪次:改了程式就要回頭對清單(AC-6)。沒標的 AC 列出來;⏳ 待討論的不算沒標——那是要跟人談,不是要 Claude 補
  const a = view.find((v) => v.checklist?.parsed);
  if (a && a.checklist.unmarked > 0) {
    const ids = a.checklist.items.filter((x) => x.state === 'none').map((x) => x.id);
    const file = String(a.checklist.file ?? '').startsWith(ctx.root) ? String(a.checklist.file).slice(ctx.root.length + 1) : a.checklist.file;
    missing.push({ key: 'checklist', line: `- 對規格的清單：${ids.slice(0, 6).join('、')}${ids.length > 6 ? ` 等 ${ids.length} 條` : ''} 還沒標——在 ${file} 每條 AC 的標題行末尾加「✅ 對過 日期」或「⏳ 待討論：原因」` });
  }
  for (const key of requires) {
    if (key === 'tests') {
      const n = card.health?.touchedTests ?? null;
      if (n === null || n > 0) continue;                           // 問不到就不要求(R1)
      missing.push({ key, line: '- 補測試：這一輪還沒新增或修改任何測試檔' });
      continue;
    }
    const st = view.find((s) => s.id === key);
    if (!st || !st.skill) continue;                                // B、E、未建的關:不是 hook 能要求的
    const ran = st.ranAt ? Date.parse(st.ranAt) : null;
    // 這一輪跑過就算(A、C);結論會過期的關(stages.json 標 rerunAfterChange,例如 D)要在最後一次改檔**之後**跑過才算(AC-9)
    const ok = ran !== null && (!st.rerunAfterChange || ran >= lastChange - SKEW_MS);
    if (ok) continue;
    const cmd = commandFor(st.skill, ctx.root, ctx.mainRoot, skillHome);
    if (!cmd) continue;                                            // 指令不存在,要求了也做不到
    const why = ran === null ? '這一輪還沒跑' : '最後一次改檔之後還沒再跑一次';
    missing.push({ key, line: `- ${st.id} ${st.name}：${why} → 跑 ${cmd}` });
  }
  if (!missing.length) return null;

  const level = tier.final.id;
  const area = tier.machine?.hits?.danger?.length ? '危險清單' : '程式區';
  const files = hits.slice(0, 3).join('、') + (hits.length > 3 ? ` 等 ${hits.length} 個檔` : '');
  const reason = [
    `[產線監視器] 這次改動至少 ${level}（碰到${area}：${files}）。收工前還缺：`,
    ...missing.map((m) => m.line),
    '先把缺的跑完再收工；跑完照那支指令的收尾把結果記給儀表板。這是分級的要求，不是建議。',
  ].join('\n');
  return { reason, missing: missing.map((m) => m.key), level, project: got.project, cwd: path, session: sid, logDir: got.logDir };
}

function main() {
  let payload = null;
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return 0; }
  let d = null;
  try { d = decide({ payload }); } catch (e) { noteBroken(e?.message ?? e); return 0; }
  if (!d) return 0;
  // 擋了就留一筆:儀表板才講得出「工頭擋過一次,缺 C、D」,驗證也靠這筆(source:gate,不是人也不是感測器)
  try {
    appendFileSync(logFileOf(d.logDir, d.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'gate_blocked', session: d.session, cwd: d.cwd, level: d.level, missing: d.missing, source: 'gate',
    }) + '\n');
  } catch (e) { noteBroken(`記不了 gate_blocked：${e?.message ?? e}`, d.logDir); }
  process.stdout.write(JSON.stringify({ decision: 'block', reason: d.reason }) + '\n');
  return 0;
}

// 跟 status.mjs 同一個判斷:兩邊都解析成真實路徑再比(L1、誠實修補 E1——透過捷徑跑時 argv[1] 是捷徑)
function isMain() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? ''); } catch { return false; }
}
if (isMain()) process.exit(main());
