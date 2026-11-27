#!/usr/bin/env node
/**
 * todo.test.mjs —— 「還差什麼」總表(規格:還差什麼總表)。
 * 只釘會安靜說謊的地方:問不到講成沒事(P5)、「沒有還差的事」畫得像通過(P10)、同一件事講兩次或漏講、網頁跟終端機講的不一樣(P2)、
 * 該重啟的沒講(P3)、你說了開工還講等你點頭(P7)。長相不釘。
 */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, copyFileSync, utimesSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { todoBoard, boardText, cardsText, programChanges, restartLine, serveDownLine, serveSlowLine, serveOldLine } from '../lib/todo.mjs';
import { askServe } from '../lib/cliTodo.mjs';
import { sessionsOf } from '../lib/rounds.mjs';
import { collectAll } from '../lib/collect.mjs';
import { clProg } from '../lib/stageLines.mjs';
import { withLang } from '../lib/lang.mjs';
import { createApp } from '../server.mjs';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGO = () => '3 分鐘前';

/* ── 假資料:長得跟 collectAll 給的一樣(真的跑一次在 AC-1 那一段) ── */
const step = (id, state, text) => ({ id, state, text });
const ladder = ({ commit = ['done', '都存好了'], merge = ['done', '併進 main 了（快轉,main 之後還沒動）'], push = ['done', 'GitHub 上的跟 main 一樣'] } = {}) =>
  ({ steps: [step('commit', ...commit), step('merge', ...merge), step('push', ...push)] });
const card = (o = {}) => ({ path: '/w/a', gone: false, notGit: false, ladder: ladder(), checkpoint: { commit: 'abc' }, checkpointRelation: { state: 'ok', commitsAfter: 0 }, ...o });
const stagesOf = (o = {}) => [
  { id: 'A', name: '寫規格', skill: 'spec', state: 'passed', doneBy: 'claude', doneAt: '2026-11-01T01:00:00.000Z',
    checklist: { parsed: true, total: 3, checked: 3, unmarked: 0, pending: 0 }, ...(o.A ?? {}) },
  { id: 'B', name: '寫程式', type: 'main-conversation', state: 'main', closedBy: 'checklist', nodAt: '2026-11-01T02:00:00Z', ...(o.B ?? {}) },
  { id: 'C', name: '打掃', skill: 'cleanup', state: 'none', rerun: null, ...(o.C ?? {}) },
  { id: 'D', name: '魔鬼教官', skill: 'chaos-check', state: 'done', doneBy: 'claude', ranAt: '2026-11-01T02:30:00Z',
    rerun: { state: 'ok', line: 'Claude 說：沒對到已知死法' }, ...(o.D ?? {}) },
  { id: 'E', name: '驗收', type: 'browser', state: 'none', rerun: { state: 'none', estate: 'none', line: '這一輪還沒走' }, ewhere: null, ...(o.E ?? {}) },
];
const MARK = { ok: '✅', ran: '⏸', missing: '⚠️', linked: '🔗' };
const req = (key, label, state, text) => ({ key, label, state, mark: MARK[state] ?? '❔', text });
const tierOk = (reqs = [], o = {}) => ({ state: 'ok', lines: { reqs, main: null, setupHint: '在這個專案的對話裡說「幫我設定分級」' }, staleNotes: [], ...o });
const D_OK = req('D', 'D 魔鬼教官', 'ok', '5 分鐘前跑過,Claude 說：沒對到已知死法');
const sess = (o = {}) => ({ id: 's1', title: '做某件事', cwd: '/w/a', lastTs: '2026-11-01T03:00:00Z', lastSaidAt: '2026-11-01T01:30:00Z',
  closedAt: null, deletedAt: null, movedOn: null, stages: stagesOf(), tier: tierOk([D_OK]), card: card(), ...o });
const proj = (sessions, o = {}) => ({ name: 'p', displayName: 'P 專案', mainRoot: '/w/main', cards: [card({ path: '/w/main' })], sessions, ...o });
const board = (projects, opt = {}) => todoBoard({ projects }, { ago: AGO, ...opt });
const rowsOf = (b) => b.projects.flatMap((p) => p.rows);
const oneRow = (s, o = {}) => rowsOf(board([proj([s], o)]))[0] ?? null;
const texts = (r) => (r?.items ?? []).map((i) => i.text);
const has = (r, part) => texts(r).some((t) => t.includes(part));
const escH = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** 真的跑整支 ui/app.js(L20:畫面的程式沒真的跑過就等於沒測):只拿掉最上面的 import 與最下面的輪詢,DOM、計時器、網路換成假的;latest 換成給的資料 */
function uiOf(latest, lang = 'zh', theme = 'night') {
  const src = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
  const body = src.replace(/^import .*$/m, '').replace(/^pollLoop\(\);$/m, '').replace(/^setInterval\(paintFreshness, 1000\);$/m, '');
  const noop = () => {};
  const el = () => ({ dataset: {}, classList: { toggle: noop }, innerHTML: '', textContent: '', setAttribute: noop });
  const document = { documentElement: { dataset: { lang, theme } }, getElementById: el, addEventListener: noop, body: el(), activeElement: null };
  const ls = { getItem: (k) => (k === 'pm-theme-mode' || k === 'pm-theme-resolved' ? theme : null), setItem: noop };
  const make = new Function('describeFreshness', 'STALE_AFTER_SECONDS', 'document', 'window', 'localStorage', 'location', 'setTimeout', 'setInterval', 'fetch', '__LATEST',
    `${body}\nlatest = __LATEST;\nreturn { whiteboard, workflow, directorOf, restartBanner, projectPage };`);
  return make(() => ({ label: '', state: 'fresh', dim: false }), 60, document, { addEventListener: noop }, ls,
    { hash: '' }, noop, noop, () => Promise.reject(new Error('測試不連網路')), latest);
}

section('AC-3:問不到的講問不到——資料夾不在、三階梯問不到、分級讀不懂或沒設定、章問不到,那一行都不准變成「沒有還差的事」', 'P5');
{
  const ok = oneRow(sess());
  check('必放:每一項都問得到、而且都不用做 → 寫「可以按結案」', /可以按結案/.test(ok?.clear ?? ''), JSON.stringify(ok));
  const gone = oneRow(sess({ card: card({ gone: true }) }));
  check('必抓:資料夾不在了 → 講看不到它還差什麼', has(gone, '資料夾不在了，看不到它還差什麼'), JSON.stringify(gone));
  eq('……而且不是「沒有還差的事」', gone?.clear, null);
  const noCard = oneRow(sess({ card: null }));
  check('找不到資料夾 → 講看不到,不是沒事', has(noCard, '看不到它還差什麼') && noCard.clear === null, JSON.stringify(noCard));
  const unk = oneRow(sess({ card: card({ ladder: ladder({ commit: ['unknown', '問不到有沒有沒存的檔案'] }) }) }));
  check('必抓:三階梯問不到 → 照那一格的句子講', has(unk, '問不到有沒有沒存的檔案') && unk.clear === null, JSON.stringify(unk));
  const broken = oneRow(sess({ tier: { state: 'broken', lines: { main: '分級設定讀不懂（.claude/pipeline-stages.json）：第 3 行' } } }));
  check('必抓:分級讀不懂 → 不知道該跑哪幾關＋分級卡那一句', has(broken, '不知道該跑哪幾關：分級設定讀不懂') && broken.clear === null, JSON.stringify(broken));
  const unset = oneRow(sess({ tier: { state: 'unset', lines: { setupHint: '在這個專案的對話裡說「幫我設定分級」' } } }));
  check('沒設定分級 → 不知道該跑哪幾關＋怎麼設定(沒設定 ≠ 不用跑,R1)', has(unset, '不知道該跑哪幾關：在這個專案的對話裡說「幫我設定分級」') && unset.clear === null, JSON.stringify(unset));
  const noTier = oneRow(sess({ tier: null }));
  check('分級整個問不到 → 講問不到', has(noTier, '問不到分級') && noTier.clear === null, JSON.stringify(noTier));
  const cpUnk = oneRow(sess({ card: card({ checkpointRelation: { state: 'unknown' } }) }));
  check('章跟現在差多少問不到 → 講問不到', has(cpUnk, '問不到章跟現在差幾次存檔') && cpUnk.clear === null, JSON.stringify(cpUnk));
  for (const state of ['off', 'no-change']) {
    const r = oneRow(sess({ tier: { state, lines: { main: 'x' } } }));
    check(`必放:分級是 ${state}(本來就沒有要跑的關)→ 不講不知道`, !has(r, '不知道該跑哪幾關') && /可以按結案/.test(r?.clear ?? ''), JSON.stringify(r));
  }
  const pushUnk = board([proj([sess()], { cards: [] })]).projects[0];
  check('有對話要列、卻一張還在的卡都沒有 → 推了沒講問不到', /問不到 main 推了沒/.test(pushUnk?.push ?? ''), JSON.stringify(pushUnk));
  const none = board([]);
  check('一個案件都看不到 → 講看不到,不留一張空表', /還看不到任何案件/.test(none.empty ?? '') && none.quiet === null, JSON.stringify(none));
  const quiet = board([proj([sess({ closedAt: '2026-11-01T04:00:00Z', card: card({ gone: true }) })])]);
  check('安靜的專案有已結案、資料夾不在的對話 → 那一句講它們看不到,不講成都沒事', /資料夾已經不在的看不到/.test(quiet.quiet ?? ''), quiet.quiet);
  const quiet2 = board([proj([sess({ closedAt: '2026-11-01T04:00:00Z' })])]);
  check('……都還在就不加那半句(不多話)', !!quiet2.quiet && !/看不到/.test(quiet2.quiet), quiet2.quiet);
}

section('魔鬼教官第一輪:沒有對話要列的專案,感測器掛壞了、退出記錄就照樣自己一段講出來——不收進「沒有進行中的對話」(證據在手上、那一句沒用它)', 'P3');
{
  // 魔鬼教官第一輪:沒有對話要列的專案,如果感測器掛壞了、或退出記錄,它新的對話根本沒被記——不准收進「沒有進行中的對話」那一句(R1、P3)
  const mountBroken = board([proj([], { cards: [card({ path: '/w/main', sensor: { mount: { state: 'broken' } } })] })]);
  check('必抓:感測器掛壞了、沒有對話要列 → 照樣自己一段、講掛壞了,不收進安靜的那一句', mountBroken.projects.length === 1 && /感測器掛壞了/.test(mountBroken.projects[0].note ?? '') && mountBroken.quiet === null, JSON.stringify(mountBroken));
  const optedOut = board([proj([], { optedOut: { at: '2026-11-01T00:00:00Z' }, optedOutLine: '這個專案已經退出記錄（1 天前）' })]);
  check('必抓:退出記錄的專案 → 照樣自己一段、講退出記錄了', optedOut.projects.length === 1 && /退出記錄/.test(optedOut.projects[0].note ?? '') && optedOut.quiet === null, JSON.stringify(optedOut));
}

section('AC-4:沒有還差的事的那一行——寫「可以按結案」,不打勾、不變綠;Claude 說的照寫是 Claude 說的', 'P10');
{
  const plain = oneRow(sess({ tier: tierOk([]) }));
  check('不打勾、不講通過', !/✅|✓|通過|passed/i.test(plain?.clear ?? '✅'), plain?.clear);
  const byClaude = oneRow(sess());
  check('必抓:分級要的 D 是 AI 記「沒對到已知死法」→ 照寫是 AI 說的', /D 的結論是 AI 說的/.test(byClaude?.clear ?? ''), byClaude?.clear);
  const byYou = oneRow(sess({ stages: stagesOf({ D: { doneBy: 'human' } }) }));
  check('你說處理完的 → 不寫成 AI 說的', !/AI/.test(byYou?.clear ?? 'AI'), byYou?.clear);
  const css = readFileSync(join(ROOT, 'ui', 'ui.css'), 'utf8');
  check('網頁那一行跟其他行同一個樣子:ui.css 不另外替「沒有還差的事」上顏色', !/data-k="clear"/.test(css));
}

section('AC-2:每一行照收尾的順序——等你決定的在前、還差的關、存檔與併、章;句子是現成的那幾句', 'P2');
{
  const s = sess({
    stages: stagesOf({ D: { state: 'stale', rerun: { state: 'ask', line: '之後又改了程式檔，還沒再跑——要不要再跑由你決定' } } }),
    tier: tierOk([req('C', 'C 打掃', 'missing', '沒有紀錄'), req('D', 'D 魔鬼教官', 'ran', '跑過,之後又改了程式檔，還沒再跑——要不要再跑由你決定')]),
    card: card({ ladder: ladder({ commit: ['pending', '還有 2 個檔案沒存'], merge: ['pending', '這條分支還多 4 個存檔沒併'] }), checkpointRelation: { state: 'ok', commitsAfter: 3 } }),
  });
  const r = oneRow(s);
  const at = (part) => texts(r).findIndex((t) => t.includes(part));
  const order = [at('等你決定（D 魔鬼教官）：之後又改了程式檔'), at('⚠️ C 打掃：沒有紀錄'), at('還有 2 個檔案沒存'), at('這條分支還多 4 個存檔沒併'), at('蓋章之後又存了 3 次')];
  check('五件都在,而且照順序:等你決定 → 還差的關 → 存檔 → 併 → 章', order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]), JSON.stringify(texts(r)));
  check('D 那一件只講一次(要不要再跑),分級卡那一行不再重複一次', texts(r).filter((t) => t.includes('D 魔鬼教官')).length === 1, JSON.stringify(texts(r)));
  check('三階梯那兩句原封不動', texts(r).includes('還有 2 個檔案沒存') && texts(r).includes('這條分支還多 4 個存檔沒併'));
  check('推了沒不在這一行(那是專案的事,AC-5)', !has(r, 'GitHub'));

  const found = oneRow(sess({ stages: stagesOf({ D: { state: 'current', rerun: { state: 'found', line: 'Claude 說找到問題：找到 1 條——還沒處理完' } } }) }));
  check('D 找到問題還沒處理完 → 還差,而且帶過了多久(⏸ 一定印時間)', has(found, 'D 魔鬼教官：3 分鐘前Claude 說找到問題') && found.clear === null, JSON.stringify(texts(found)));
  const held = oneRow(sess({ stages: stagesOf({ D: { state: 'held', rerun: { state: 'skipped', line: 'Claude 記下：你說不用再跑' } } }),
    tier: tierOk([req('D', 'D 魔鬼教官', 'ran', '跑過,Claude 記下：你說不用再跑')]) }));
  check('你說不用再跑 → 你決定了,不列(也不寫成通過)', !has(held, 'D 魔鬼教官') && !/通過/.test(held?.clear ?? ''), JSON.stringify(held));
  const missingD = oneRow(sess({ stages: stagesOf({ D: { state: 'none', doneBy: null, rerun: { state: 'none', line: '沒有紀錄' } } }),
    tier: tierOk([req('D', 'D 魔鬼教官', 'missing', '沒有紀錄')]) }));
  check('分級要 D、沒有紀錄 → 分級卡那一行', has(missingD, '⚠️ D 魔鬼教官：沒有紀錄'), JSON.stringify(texts(missingD)));
  const notNeeded = oneRow(sess({ stages: stagesOf({ D: { state: 'none', doneBy: null, rerun: { state: 'none', line: '沒有紀錄' } } }), tier: tierOk([]) }));
  check('分級不要 D、也沒跑 → 不列', !has(notNeeded, 'D 魔鬼教官'), JSON.stringify(texts(notNeeded)));

  const eStale = oneRow(sess({ stages: stagesOf({ E: { state: 'stale', ewhere: '你說驗收過了之後又改了程式，要不要再走由你決定', rerun: { state: 'ask', estate: 'accepted-stale', line: 'x' } } }) }));
  check('E 你驗收之後又改了程式 → 等你決定,用 E 那一格的句子', has(eStale, '等你決定（E 驗收）：你說驗收過了之後又改了程式'), JSON.stringify(texts(eStale)));
  const eWalked = oneRow(sess({ stages: stagesOf({ E: { state: 'current', ewhere: 'Claude 走過一遍：4 條看到了，等你查核', rerun: { state: 'ok', estate: 'ok', line: 'x' } } }) }));
  check('E Claude 走過一遍、等你查核 → 等你決定', has(eWalked, '等你決定（E 驗收）：Claude 走過一遍'), JSON.stringify(texts(eWalked)));
  const eDone = oneRow(sess({ stages: stagesOf({ E: { state: 'passed', ewhere: 'Claude 代記：你說驗收過了', rerun: { state: 'ask', estate: 'accepted', line: 'x' } } }) }));
  check('E 你說驗收過了 → 不列(就算 rerun 那一欄寫 ask,看的是 E 自己的狀態)', !has(eDone, 'E 驗收'), JSON.stringify(texts(eDone)));
  const eSeen = oneRow(sess({ stages: stagesOf({ E: { state: 'seen', rerun: { state: 'none', estate: 'none', line: '這一輪還沒走' } } }) }));
  check('E 只開過瀏覽器 → 不算走過,不列', !has(eSeen, 'E 驗收'), JSON.stringify(texts(eSeen)));

  const cl = { parsed: true, total: 3, checked: 1, unmarked: 2, pending: 0 };
  const unmarked = oneRow(sess({ stages: stagesOf({ A: { checklist: cl } }) }));
  check('清單還有沒對的 → B 那一行的句子(clProg)', texts(unmarked).includes(`B 寫程式：${clProg(cl)}`), JSON.stringify(texts(unmarked)));
  const cl2 = { parsed: true, total: 3, checked: 2, unmarked: 0, pending: 1 };
  const pending = oneRow(sess({ stages: stagesOf({ A: { checklist: cl2 } }) }));
  check('清單有待討論的 → 等你決定', texts(pending).includes(`等你決定（B 寫程式）：${clProg(cl2)}`), JSON.stringify(texts(pending)));
  const danger = oneRow(sess({ tier: tierOk([D_OK], { staleNotes: ['⚠️ 這一輪碰到 1 個危險清單定好之後才新加的程式檔：lib/x.mjs——危不危險還沒有人判斷。'] }) }));
  check('危險清單沒人判斷的新檔 → 等你決定,拿掉開頭的 ⚠️、字不改', texts(danger).includes('等你決定：這一輪碰到 1 個危險清單定好之後才新加的程式檔：lib/x.mjs——危不危險還沒有人判斷。'), JSON.stringify(texts(danger)));
  const tests = oneRow(sess({ tier: tierOk([D_OK, req('tests', '補測試', 'missing', '這次沒有新增或修改任何測試檔')]) }));
  check('分級要補測試、這次沒有 → 列', has(tests, '⚠️ 補測試：這次沒有新增或修改任何測試檔'), JSON.stringify(texts(tests)));
  const noStamp = oneRow(sess({ card: card({ checkpoint: null, checkpointRelation: null }) }));
  check('還沒蓋過章 → 列', has(noStamp, '還沒蓋過章'), JSON.stringify(texts(noStamp)));
  const off = oneRow(sess({ card: card({ checkpointRelation: { state: 'off-branch' } }) }));
  check('章不在這條分支上 → 講回不去(四種狀態不折成兩種)', has(off, '回不去'), JSON.stringify(texts(off)));
}

section('AC-2:規格等你點頭——只在規格記好之後你還沒說過話的時候講;你說了開工、Claude 還沒動手,不准還講等你', 'P7');
{
  const waiting = { A: { doneBy: 'claude', doneAt: '2026-11-01T01:00:00.000Z', checklist: { parsed: true, total: 3, checked: 0, unmarked: 3, pending: 0, file: '/w/a/docs/規劃中/某件事.md' } },
                    B: { closedBy: null, nodAt: null } };
  const nod = oneRow(sess({ stages: stagesOf(waiting), lastSaidAt: '2026-11-01T00:50:00Z' }));
  check('記好之後你還沒說話 → 等你點頭(帶規格名字)', texts(nod).includes('等你決定（A 寫規格）：規格寫好了，等你點頭開工（某件事）'), JSON.stringify(texts(nod)));
  check('……等你點頭的時候不另外講清單沒對(那是點頭之後的事)', !has(nod, '清單'), JSON.stringify(texts(nod)));
  // 同一秒裡記好、你接著說話:毫秒有、沒有的兩種時間格式要用時間比,不能用字串比
  const said = oneRow(sess({ stages: stagesOf(waiting), lastSaidAt: '2026-11-01T01:00:01Z' }));
  check('必抓:記好之後你說過話(照這樣開工)→ 不准還講等你點頭', !has(said, '等你點頭'), JSON.stringify(texts(said)));
  check('……球在 Claude 那邊:清單還沒對照講', has(said, '清單 0/3 對過'), JSON.stringify(texts(said)));
  const neverSaid = oneRow(sess({ stages: stagesOf(waiting), lastSaidAt: null }));
  check('這個對話你一句話都還沒說 → 等你點頭', has(neverSaid, '等你點頭'), JSON.stringify(texts(neverSaid)));
  const started = oneRow(sess({ stages: stagesOf({ ...waiting, B: { closedBy: 'nod', nodAt: '2026-11-01T01:10:00Z' } }), lastSaidAt: null }));
  check('已經開始改程式檔了 → 不講等你點頭', !has(started, '等你點頭'), JSON.stringify(texts(started)));

  const T = (m) => `2026-11-01T01:${String(m).padStart(2, '0')}:00Z`;
  const list = sessionsOf([
    { ts: T(1), hook: 'UserPromptSubmit', session: 'x', cwd: '/w', prompt: '幫我做這件事' },
    { ts: T(2), hook: 'UserPromptSubmit', session: 'x', cwd: '/w', prompt: '<task-notification>背景工作做完了</task-notification>' },
    { ts: T(3), hook: 'PostToolUse', tool: 'Edit', session: 'x', cwd: '/w', file: '/w/a.js' },
  ]);
  eq('sessionsOf 記你最後一次說話的時間(背景工作的通知不算)', list[0]?.lastSaidAt, T(1));
  eq('……訊息數照舊只數你說的', list[0]?.prompts, 1);
}

section('AC-6:結案的對話平常不在;資料夾還有沒存、沒併的照樣出現,只講檔案的事;同一個資料夾的事只講一次', 'P2');
{
  const dirty = card({ ladder: ladder({ commit: ['pending', '還有 1 個檔案沒存'] }), checkpoint: null, checkpointRelation: null });
  const closed = oneRow(sess({ closedAt: '2026-11-01T04:00:00Z', card: dirty,
    stages: stagesOf({ D: { state: 'current', rerun: { state: 'found', line: 'Claude 說找到問題' } } }) }));
  check('已結案、還有 1 個檔沒存 → 照樣出現,標已結案', closed?.closed === true && closed.closedNote === '已結案' && texts(closed).includes('還有 1 個檔案沒存'), JSON.stringify(closed));
  check('……只講檔案的事:關卡、章都不寫(結案算你決定了)', texts(closed).length === 1, JSON.stringify(texts(closed)));
  eq('……而且沒有結案鈕要給(它已經結案了):clear 是 null', closed?.clear, null);
  eq('已結案、檔案都存好併好 → 不列', oneRow(sess({ closedAt: '2026-11-01T04:00:00Z' })), null);
  eq('已結案、資料夾不在了 → 不列', oneRow(sess({ closedAt: '2026-11-01T04:00:00Z', card: card({ gone: true }) })), null);
  const del = oneRow(sess({ closedAt: '2026-11-01T04:00:00Z', deletedAt: '2026-11-01T04:00:00Z', card: dirty }));
  eq('在 app 裡刪掉的 → 標「已在 app 裡刪除」,不是你按的結案', del?.closedNote, '已在 app 裡刪除');

  // 同一個資料夾兩個進行中的對話:資料夾的事只掛在最近動過的那一個
  const newer = sess({ id: 'n', title: '新的', lastTs: '2026-11-01T05:00:00Z', card: dirty });
  const older = sess({ id: 'o', title: '舊的', lastTs: '2026-11-01T03:00:00Z', card: dirty });
  const rows = rowsOf(board([proj([newer, older])]));
  const rn = rows.find((r) => r.id === 'n'), ro = rows.find((r) => r.id === 'o');
  check('最近動過的那一個講資料夾的事', has(rn, '還有 1 個檔案沒存'), JSON.stringify(texts(rn)));
  check('另一個不再講一次,寫見哪一個', !has(ro, '還有 1 個檔案沒存') && has(ro, '資料夾的事見「新的」'), JSON.stringify(texts(ro)));
  check('……那一句只是說明,不擋它自己「沒有還差的事」', /可以按結案/.test(ro?.clear ?? ''), JSON.stringify(ro));
  // 最近動過的那一個已經結案:資料夾的事掛在還沒結案的那一個,不准兩邊都不講
  const closedNewer = sess({ id: 'n', title: '新的', lastTs: '2026-11-01T05:00:00Z', closedAt: '2026-11-01T05:30:00Z', card: dirty });
  const rows2 = rowsOf(board([proj([closedNewer, older])]));
  check('最近的已結案、舊的還在進行 → 舊的那一個講資料夾的事,已結案的不再列', rows2.length === 1 && rows2[0].id === 'o' && has(rows2[0], '還有 1 個檔案沒存'), JSON.stringify(rows2));
  const moved = oneRow(sess({ movedOn: { at: '2026-11-01T04:00:00Z' }, card: dirty }));
  check('資料夾已換給別的對話(上一手)→ 講換人了,不講資料夾現在的事', has(moved, '資料夾已換給別的對話') && !has(moved, '還有 1 個檔案沒存'), JSON.stringify(texts(moved)));
  const mixed = rowsOf(board([proj([sess({ id: 'c', closedAt: '2026-11-01T06:00:00Z', lastTs: '2026-11-01T06:00:00Z', cwd: '/w/c', card: card({ path: '/w/c', ladder: ladder({ commit: ['pending', '還有 1 個檔案沒存'] }) }) }), sess()])]));
  eq('已結案的排在進行中的後面', mixed.map((r) => r.id).join(','), 's1,c');
}

section('AC-5:推了沒一個專案講一次,不在每一行重複', 'P2');
{
  const pending = board([proj([sess()], { cards: [card({ path: '/w/main', ladder: ladder({ push: ['pending', 'main 有 5 個新存檔可以 push'] }) })] })]).projects[0];
  eq('main 有沒推的 → 專案那一段一行,三階梯那一句', pending?.push, 'main 有 5 個新存檔可以 push');
  check('……每一行都不再講', !rowsOf({ projects: [pending] }).some((r) => has(r, 'push')));
  const noGithub = board([proj([sess()], { cards: [card({ path: '/w/main', ladder: ladder({ push: ['none', 'main 沒有連到 GitHub,沒有地方可以 push'] }) })] })]).projects[0];
  eq('main 沒連到 GitHub → 不講(沒有東西可做)', noGithub?.push, null);
  const unk = board([proj([sess()], { cards: [card({ path: '/w/main', ladder: ladder({ push: ['unknown', '問不到 main 跟 GitHub 差幾個存檔'] }) })] })]).projects[0];
  eq('問不到 → 照講問不到', unk?.push, '問不到 main 跟 GitHub 差幾個存檔');
  const onlyPush = board([proj([], { cards: [card({ path: '/w/main', ladder: ladder({ push: ['pending', 'main 有 1 個新存檔可以 push'] }) })] })]);
  check('沒有對話要列、但 main 有沒推的 → 專案照樣出現(不是安靜的那一群)', onlyPush.projects.length === 1 && onlyPush.quiet === null, JSON.stringify(onlyPush));
}

section('AC-7:服務用到的程式在它啟動之後改過 → 講要重啟;只改畫面、文件不講;問不到不准當成不用重啟', 'P3');
{
  const prog = mkdtempSync(join(tmpdir(), 'pm-prog-'));
  mkdirSync(join(prog, 'lib')); mkdirSync(join(prog, 'ui')); mkdirSync(join(prog, 'docs'));
  const files = ['server.mjs', 'lib/a.mjs', 'lib/b.mjs', 'ui/app.js', 'ui/ui.css', 'docs/x.md'];
  const past = new Date(Date.now() - 3600_000);
  for (const f of files) { writeFileSync(join(prog, f), '// x\n'); utimesSync(join(prog, f), past, past); }
  const boot = Date.now() - 60_000;
  eq('啟動之後什麼都沒改 → 沒有', programChanges(prog, boot)?.join(','), '');
  const now = new Date();
  for (const f of ['ui/app.js', 'ui/ui.css', 'docs/x.md']) utimesSync(join(prog, f), now, now);
  eq('必放:只改了畫面那兩個檔、文件 → 不算(畫面自己會重新載入)', programChanges(prog, boot)?.join(','), '');
  utimesSync(join(prog, 'lib/a.mjs'), now, now);
  eq('必抓:改了 lib/ 的一支 → 列出來', programChanges(prog, boot)?.join(','), 'lib/a.mjs');
  writeFileSync(join(prog, 'lib/c.mjs'), '// 新的\n');
  check('必抓:新加一支 lib/ 的檔 → 也算', programChanges(prog, boot)?.includes('lib/c.mjs'), JSON.stringify(programChanges(prog, boot)));
  eq('讀不到 → null(不是「沒改過」)', programChanges(join(prog, '不存在'), boot), null);
  eq('沒改過 → 不講', restartLine({ bootAt: new Date(boot).toISOString(), changed: [] }, { ago: AGO }), null);
  check('問不到 → 照講問不到,不是不講', /問不到/.test(restartLine({ changed: null }, { ago: AGO }) ?? ''));
  const line = restartLine({ bootAt: new Date(boot).toISOString(), changed: ['lib/collect.mjs'] }, { ago: AGO });
  check('改過 → 講是哪一支、怎麼重啟', /lib\/collect\.mjs/.test(line ?? '') && /--serve-restart/.test(line ?? ''), line);

  // 真的服務:/api/serve-state 給終端機問;/api/status 的總表最上面那一句是它自己講的
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'logs'));
  for (const f of files) utimesSync(join(prog, f), past, past);
  utimesSync(join(prog, 'lib/c.mjs'), past, past);
  const server = createApp({ monitorDir, programDir: prog, statusShareMs: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const get = (path) => new Promise((resolve, reject) => {
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    rq.on('error', reject); rq.end();
  });
  const s0 = JSON.parse((await get('/api/serve-state')).body);
  check('/api/serve-state:啟動時間＋改過哪幾支(剛啟動:沒有)', typeof s0.bootAt === 'string' && Array.isArray(s0.changed) && s0.changed.length === 0, JSON.stringify(s0));
  const st0 = JSON.parse((await get('/api/status')).body);
  check('/api/status 帶總表(todo 這一欄一定在),沒改過就沒有重啟那一句', 'todo' in st0 && st0.todo.restart === null, JSON.stringify(st0.todo));
  utimesSync(join(prog, 'lib/b.mjs'), new Date(), new Date());
  const s1 = JSON.parse((await get('/api/serve-state')).body);
  eq('服務跑著的時候改了 lib/b.mjs → 問得出來', s1.changed?.join(','), 'lib/b.mjs');
  const st1 = JSON.parse((await get('/api/status')).body);
  check('……首頁總表最上面講要重啟', /lib\/b\.mjs/.test(st1.todo?.restart ?? '') && /--serve-restart/.test(st1.todo?.restart ?? ''), st1.todo?.restart);
  await new Promise((r) => server.close(r));

  rmSync(prog, { recursive: true, force: true }); rmSync(monitorDir, { recursive: true, force: true });
}

section('AC-7＋魔鬼教官第一輪:終端機問服務要不要重啟——連不上、等不到、舊的服務各講各的;服務在忙不准講成沒在跑,也都不准講成不用重啟', 'P5');
{
  // 終端機問服務:沒在跑 → 問不到;舊的服務(沒有這個網址)→ 它是舊的;有改 → 要重啟。都不准講成「不用重啟」
  check('服務沒在跑(連不上)→ 講連不上', (await askServe({ url: 'http://127.0.0.1:1/', ms: 1500 })) === serveDownLine());
  // 魔鬼教官第一輪:服務正在替開著的分頁算整頁,這一題排在後面——等不到要講「沒回答」,不准講成沒在跑(R1)
  const busy = await new Promise((r) => { const sv = createServer((req, res) => setTimeout(() => { res.writeHead(200); res.end('{}'); }, 2500)); sv.listen(0, '127.0.0.1', () => r(sv)); });
  eq('必抓:連得上、等不到 → 講幾秒內沒回答(可能在忙),不講沒在跑', await askServe({ url: `http://127.0.0.1:${busy.address().port}/`, ms: 1000 }), serveSlowLine(1));
  busy.closeAllConnections?.(); busy.close();
  const defaultWait = /ms = 10_000/.test(readFileSync(join(ROOT, 'lib', 'cliTodo.mjs'), 'utf8'));
  check('預設等 10 秒(整頁算一次要 3～5 秒,等 3 秒實測 10 次有 2 次等不到)', defaultWait);
  const fake = (handler) => new Promise((r) => { const sv = createServer(handler); sv.listen(0, '127.0.0.1', () => r(sv)); });
  const old = await fake((req, res) => { res.writeHead(404); res.end('找不到'); });
  check('舊的服務(沒有 /api/serve-state)→ 講它還在跑舊的程式', (await askServe({ url: `http://127.0.0.1:${old.address().port}/` })) === serveOldLine());
  old.close();
  const fresh = await fake((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ bootAt: new Date().toISOString(), changed: [] })); });
  eq('新的服務、沒改過 → 不講', await askServe({ url: `http://127.0.0.1:${fresh.address().port}/` }), null);
  fresh.close();
}

section('AC-8:終端機那一張跟網頁同一份——同一個函式出的字,網頁照畫、終端機照印;舊的服務不准畫成空表', 'P2');
{
  const b = board([proj([
    sess({ stages: stagesOf({ D: { state: 'stale', rerun: { state: 'ask', line: '要不要再跑由你決定' } } }), card: card({ ladder: ladder({ commit: ['pending', '還有 2 個檔案沒存'] }) }) }),
    sess({ id: 's2', title: '做完的那件', cwd: '/w/b', card: card({ path: '/w/b' }) }),
  ], { cards: [card({ path: '/w/main', ladder: ladder({ push: ['pending', 'main 有 5 個新存檔可以 push'] }) })] })],
  { restart: '⚠️ 儀表板的服務還在跑 3 分鐘前啟動時的程式，之後 lib/a.mjs 改過——跑 pipeline-status --serve-restart' });
  const said = [b.restart, ...b.projects.flatMap((p) => [p.push, ...p.rows.flatMap((r) => [...texts(r), r.clear])])].filter(Boolean);
  const lines = boardText(b, { faults: [{ tone: 'red', text: '🔴 感測器壞了' }] }).join('\n');
  const missT = said.filter((t) => !lines.includes(t));
  check('終端機印出總表的每一句(重啟、推了沒、每一件、可以按結案)', !missT.length, JSON.stringify(missT));
  check('終端機最上面也講故障(網頁每一頁上方那一條)', lines.includes('🔴 感測器壞了'));

  const p0 = b.projects[0];
  const html = uiOf({ projects: [{ name: 'p', suggestions: [] }], todo: b }).whiteboard({ name: 'p' });
  const saidHere = [p0.push, ...p0.rows.flatMap((r) => [...texts(r), r.clear])].filter(Boolean);
  const missW = saidHere.filter((t) => !html.includes(escH(t)));
  check('案件頁的白板畫出那個案件的每一句(跟終端機同一份)', !missW.length, JSON.stringify(missW));
  check('白板上每個進行中的對話一顆結案鈕(跟對話列同一個 data-close)', (html.match(/data-close="/g) ?? []).length === 2, html.slice(0, 200));
  const restart = uiOf({ projects: [], todo: b }).restartBanner();
  check('要重啟那一句放在每一頁最上面那幾條(講的是整個儀表板,不跟著白板搬)', restart.includes(escH(b.restart)), restart);
  const oldHtml = uiOf({ projects: [{ name: 'p' }] }).whiteboard({ name: 'p' });
  check('必抓:舊的服務沒有 todo 這一欄 → 講服務還在跑舊的程式,不畫一塊空白板', /--serve-restart/.test(oldHtml) && !/wb-task/.test(oldHtml), oldHtml);
  const lost = uiOf({ projects: [{ name: 'q' }], todo: b }).whiteboard({ name: 'q' });
  check('總表裡找不到這個案件 → 講對不上,不畫成沒事', /找不到這個案件/.test(lost) && !/wb-task/.test(lost), lost);

  // 真的跑一次 agy-pipeline --todo:不需要站在 git 專案裡;資料是空的、服務問不到 → 兩件都照講,不是一片空白
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  const env = { ...process.env, HOME: home, AGY_PIPELINE_HOME: join(home, 'data'), AGY_PIPELINE_PORT: '1' };
  delete env.AGY_PIPELINE_LOG_DIR;
  const out = spawnSync(process.execPath, [join(ROOT, 'status.mjs'), '--todo'], { cwd: home, env, encoding: 'utf8' });
  eq('agy-pipeline --todo 在不是 git 專案的地方也跑得完', out.status, 0);
  check('……講看不到任何案件', /還看不到任何案件/.test(out.stdout), out.stdout + out.stderr);
  check('……服務問不到就講問不到,不講不用重啟', out.stdout.includes(serveDownLine()), out.stdout);
  rmSync(home, { recursive: true, force: true });
}

section('AC-10、AC-11:案件頁的白板——每個對話一個彩色筆圈、預設收起;筆的顏色照最急的那一件,沒有還差的事不准是綠色;主任的表情照那幾件', 'P10');
{
  const askRow = sess({ id: 'r1', title: '要你決定的', stages: stagesOf({ D: { state: 'stale', rerun: { state: 'ask', line: '要不要再跑由你決定' } } }) });
  const todoRow = sess({ id: 'r2', title: '還差的', cwd: '/w/b', card: card({ path: '/w/b', ladder: ladder({ commit: ['pending', '還有 2 個檔案沒存'] }) }) });
  const unkRow = sess({ id: 'r3', title: '看不到的', cwd: '/w/c', card: card({ path: '/w/c', gone: true }) });
  const okRow = sess({ id: 'r4', title: '沒事的', cwd: '/w/d', card: card({ path: '/w/d' }), tier: tierOk([]) });
  const b = board([proj([askRow, todoRow, unkRow, okRow])]);
  const html = uiOf({ projects: [{ name: 'p', suggestions: [] }], todo: b }).whiteboard({ name: 'p' });
  const inkOfTask = (title) => html.match(new RegExp(`data-ink="([a-z]+)"[^>]*>\\s*<summary><span class="wb-ring">${title}`))?.[1] ?? null;
  eq('有事等你決定 → 紅筆', inkOfTask('要你決定的'), 'red');
  eq('還差 → 藍筆', inkOfTask('還差的'), 'blue');
  eq('必抓:看不到 → 灰筆(不准跟沒事同色,P5)', inkOfTask('看不到的'), 'gray');
  eq('沒有還差的事 → 黃筆(工地主任的黃)', inkOfTask('沒事的'), 'yellow');
  check('必抓:整塊白板沒有一處是綠色', !/green|mint|agent-c/i.test(html));
  check('預設收起:沒有一個圈是打開的', (html.match(/class="wb-task"/g) ?? []).length === 4 && !/class="wb-task"[^>]* open/.test(html), html.slice(0, 300));
  check('圈旁一定有字:等你決定幾件、還差幾件、看不到幾件、沒有還差的事', ['等你決定 1 件', '還差 1 件', '看不到 1 件', '沒有還差的事了'].every((t) => html.includes(t)), html);
  check('下方燈號每一盞旁寫那一色的意思(不只靠顏色)', ['紅燈＝等你決定', '藍燈＝還差什麼', '灰（不亮燈）＝看不到', '黃燈＝只差按結案'].every((t) => html.includes(t)), html.slice(-900));
  const dayHtml = uiOf({ projects: [{ name: 'p', suggestions: [] }], todo: b }, 'zh', 'day').whiteboard({ name: 'p' });
  check('白天工班:看板下緣切回「紅筆／藍筆／灰筆／黃筆」與筆頭提示',
    ['紅筆＝等你決定', '藍筆＝還差什麼', '灰筆＝看不到', '黃筆＝只差按結案'].every((t) => dayHtml.includes(t))
    && dayHtml.includes('筆頭亮著：白板上有這一色'), dayHtml.slice(-900));
  check('白板上有工地主任:有事等你決定 → 擔心的眼睛(不笑)', /class="agent" data-id="director" data-face="worry"/.test(html), html.match(/data-id="director"[^>]*/)?.[0]);
  const calm = uiOf({ projects: [{ name: 'p', suggestions: [] }], todo: board([proj([okRow])]) }).whiteboard({ name: 'p' });
  check('沒有還差的事 → 主任睜著眼,不笑(沒有人驗過,P10)', /data-id="director" data-face="open"/.test(calm), calm.match(/data-id="director"[^>]*/)?.[0]);
  const quietB = board([proj([sess({ closedAt: '2026-11-01T04:00:00Z' })])]);
  const quietHtml = uiOf({ projects: [{ name: 'p', suggestions: [] }], todo: quietB }).whiteboard({ name: 'p' });
  check('這個案件沒有要列的 → 白板照寫一句為什麼,不准空著(AC-1)', quietHtml.includes('沒有進行中的對話') && !/wb-task/.test(quietHtml), quietHtml);
  const page = uiOf({ projects: [{ name: 'p', displayName: 'P', cards: [], sessions: [], suggestions: [] }], todo: b }).projectPage('p');
  check('案件頁:白板在 Overview 下面、建議卡那一區上面', page.indexOf('Overview') < page.indexOf('class="wb"') && page.indexOf('class="wb"') < page.indexOf('建議新增的對話'), page.slice(0, 120));
}

section('筆槽(Oscar 2026-11-02):白板上畫到哪一色,那一支的筆頭就亮——紅圈裡的還差、推了沒那一行都算;白板畫不出來就不畫筆槽', 'P5');
{
  const litOf = (html) => Object.fromEntries([...html.matchAll(/class="wb-pen" data-ink="([a-z]+)" data-lit="([01])"/g)].map((m) => [m[1], m[2] === '1']));
  const wb = (b, name = 'p') => uiOf({ projects: [{ name: 'p', suggestions: [] }], todo: b }).whiteboard({ name });
  const askD = stagesOf({ D: { state: 'stale', rerun: { state: 'ask', line: '要不要再跑由你決定' } } });
  const four = litOf(wb(board([proj([
    sess({ id: 'r1', title: '要你決定的', stages: askD }),
    sess({ id: 'r2', title: '還差的', cwd: '/w/b', card: card({ path: '/w/b', ladder: ladder({ commit: ['pending', '還有 2 個檔案沒存'] }) }) }),
    sess({ id: 'r3', title: '看不到的', cwd: '/w/c', card: card({ path: '/w/c', gone: true }) }),
    sess({ id: 'r4', title: '沒事的', cwd: '/w/d', card: card({ path: '/w/d' }), tier: tierOk([]) }),
  ])])));
  eq('四支筆都在、照紅藍灰黃排', Object.keys(four).join(','), 'red,blue,gray,yellow');
  check('四色的圈都有 → 四支都亮', Object.values(four).every(Boolean), JSON.stringify(four));

  // 紅圈裡另有一件還差:圈是紅的,藍筆也要亮;收起來的時候圈旁那一件就是藍的
  const mixed = sess({ id: 'm1', title: '又要決定又還差', stages: askD, card: card({ ladder: ladder({ commit: ['pending', '還有 2 個檔案沒存'] }) }) });
  const html = wb(board([proj([mixed])]));
  const lit = litOf(html);
  check('紅圈 → 紅筆亮', lit.red === true, JSON.stringify(lit));
  check('必抓:紅圈裡還有還差的事 → 藍筆也亮(只看圈的顏色,藍筆不亮就是把「有」講成「沒有」)', lit.blue === true, JSON.stringify(lit));
  check('……收起來就看得到那一色:圈旁的「還差 1 件」標成還差那一色', html.includes('<span data-k="todo">還差 1 件</span>'), html.match(/class="wb-count">.*/)?.[0]);
  check('白板上沒畫到的顏色不亮(灰、黃)', lit.gray === false && lit.yellow === false, JSON.stringify(lit));

  // main 推了沒那一行也算:還沒推是還差(藍)、問不到是看不到(灰)
  const clean = sess({ id: 'c1', title: '沒事的', tier: tierOk([]) });
  const withPush = (state, text) => board([proj([clean], { cards: [card({ path: '/w/main', ladder: ladder({ push: [state, text] }) })] })]);
  const pending = litOf(wb(withPush('pending', 'main 有 5 個新存檔可以 push')));
  check('main 還沒推 → 藍筆亮(圈之外那一行也算)', pending.blue === true && pending.yellow === true && pending.red === false, JSON.stringify(pending));
  const unk = litOf(wb(withPush('unknown', '問不到 GitHub 上的 main')));
  check('問不到推了沒 → 灰筆亮,藍筆不亮', unk.gray === true && unk.blue === false, JSON.stringify(unk));
  const oldB = withPush('pending', 'main 有 5 個新存檔可以 push');
  for (const p of oldB.projects) delete p.pushKind;
  const old = litOf(wb(oldB));
  check('舊的服務沒給推了沒是哪一種 → 灰筆亮(分不出來就是看不到,不准不算)', old.gray === true, JSON.stringify(old));

  // 白板畫不出來 → 不畫筆槽:四支都不亮看起來就是「都沒事」
  const noTodo = uiOf({ projects: [{ name: 'p' }] }).whiteboard({ name: 'p' });
  const lost = wb(board([proj([mixed])]), 'q');
  check('必抓:舊的服務沒有總表、總表裡找不到這個案件 → 都不畫筆槽', !/wb-pen/.test(noTodo) && !/wb-pen/.test(lost), noTodo + lost);
}

section('筆槽:白板最上面講紀錄可能不全(感測器掛壞了、退出記錄)→ 灰筆亮——字說看不全,燈不准說沒有看不到的(魔鬼教官第 3 輪)', 'P10');
{
  const litOf = (html) => Object.fromEntries([...html.matchAll(/class="wb-pen" data-ink="([a-z]+)" data-lit="([01])"/g)].map((m) => [m[1], m[2] === '1']));
  const wb = (b) => uiOf({ projects: [{ name: 'p', suggestions: [] }], todo: b }).whiteboard({ name: 'p' });
  const clean = sess({ id: 'c1', title: '沒事的', tier: tierOk([]) });
  const brokenHtml = wb(board([proj([clean], { cards: [card({ path: '/w/main', sensor: { mount: { state: 'broken' } } })] })]));
  const broken = litOf(brokenHtml);
  check('必抓:感測器掛壞了 → 灰筆亮(新的對話記不到,不准講成沒有看不到的)', broken.gray === true, JSON.stringify(broken));
  check('……那一行前面是灰點(看不到那一色),筆亮的那一色白板上找得到', /<p class="wb-line" data-k="unknown">⚠️ 這個專案的感測器掛壞了/.test(brokenHtml), brokenHtml.match(/<p class="wb-line"[^>]*>[^<]*/)?.[0]);
  const off = litOf(wb(board([proj([clean], { optedOut: { at: '2026-11-01T00:00:00Z' }, optedOutLine: '這個專案已退出記錄（3 分鐘前），之前記的照樣留到滿 90 天。' })])));
  check('退出記錄的專案 → 灰筆亮(之後的對話不會被記)', off.gray === true, JSON.stringify(off));
  const fine = litOf(wb(board([proj([clean])])));
  check('感測器好好的、沒退出 → 灰筆不亮(不是一律亮著)', fine.gray === false, JSON.stringify(fine));
}

section('AC-12:對話頁多一關 F 工地主任——收尾了沒、這個對話提的建議卡;沒記到不准講成沒有', 'P5');
{
  const wfStages = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, name: id, line: '這一輪還沒跑', state: 'none', ...(id === 'B' ? { type: 'main-conversation', state: 'main' } : id === 'E' ? { type: 'browser' } : { skill: id.toLowerCase() }) }));
  const s1 = sess({ stages: stagesOf({ D: { state: 'stale', rerun: { state: 'ask', line: '要不要再跑由你決定' } } }) });
  const clean = sess({ id: 'c1', title: '收好的', cwd: '/w/c', closedAt: '2026-11-01T05:00:00Z', card: card({ path: '/w/c' }) });
  const b = board([proj([s1, clean])]);
  // oldServer:舊的服務根本沒有 todo 這一欄(JSON 裡沒有這個鍵),不是有鍵、值是空的
  const run = (sid, cards = [], { oldServer = false } = {}) => {
    const latest = { projects: [{ name: 'p', suggestions: cards }], ...(oldServer ? {} : { todo: b }) };
    const ui = uiOf(latest);
    return ui.workflow({ path: '/w/a', sensor: { state: 'ok' }, stages: wfStages, director: ui.directorOf(latest.projects[0], { id: sid }) });
  };
  const html = run('s1');
  check('五關下面多一列,字母接在最後一關後面(F)、叫工地主任', /<span class="rlab">F<\/span>/.test(html) && html.includes('F 工地主任'), html.slice(-600));
  check('狀態那一行講幾件(跟白板同一個算法)', html.includes('等你決定 1 件'), html.slice(-600));
  check('下面列每一件,句子跟白板同一句', html.includes(escH('等你決定（D 魔鬼教官）：要不要再跑由你決定')));
  check('主任擔心的眼睛(有事等你決定)', /data-id="director" data-face="worry"/.test(html));
  const closedHtml = run('c1');
  check('已結案、資料夾沒事 → 講已結案、資料夾裡沒有沒存沒併的,主任休息', closedHtml.includes('已結案') && closedHtml.includes('資料夾裡沒有沒存、沒併的東西') && /data-id="director" data-face="rest"/.test(closedHtml), closedHtml.slice(-500));
  const card1 = (o) => ({ id: 'k', title: 't', session: 's1', ...o });
  // F 那一格改成條列(規格:主任條列與工地帽 AC-1):外面講幾張、在案件頁,哪一區收在「細節」
  const two = run('s1', [card1({}), card1({ id: 'k2' })]);
  check('這個對話提的卡還沒開始 → 講幾張、在哪一區看', two.includes('建議卡：還沒開始 2 張（在案件頁）') && two.includes('「建議新增的對話」那一區'), two.slice(-900));
  check('都開始了、不做了、被取代了 → 照講(跟建議卡那一區同一個判斷)', run('s1', [card1({ startedBy: 'x' }), card1({ id: 'k2', dismissedAt: '2026-11-01T00:00:00Z' })]).includes('都開始了'));
  check('必抓:一張都沒記到 → 講只看得到用 --suggest 放的,不只講沒有(P5)', run('s1').includes('只看得到用 --suggest 放的'));
  check('必抓:分不出是哪個對話放的卡 → 另外講案件頁還有幾張,不算到這個對話頭上、也不因此講沒有(P7)', run('s1', [card1({ session: null }), card1({ id: 'k3', session: null })]).includes('另有 2 張建議卡分不出是哪個對話放的（在案件頁）'));
  const old = run('s1', [], { oldServer: true });
  check('舊的服務沒有 todo → F 那一行講服務還在跑舊的程式,不畫成沒事', old.includes('服務還在跑舊的程式') && /data-id="director" data-face="ask"/.test(old), old.slice(-500));
  check('沒給主任資料的工作流照舊只畫五關(測試、舊的呼叫法不會壞)', !uiOf({ projects: [] }).workflow({ path: '/w', sensor: { state: 'ok' }, stages: wfStages }).includes('工地主任'));
}

section('AC-12:已結案、白板上不列的對話,F 那一關照樣講為什麼不列(不列不等於沒事)', 'P5');
{
  const open = sess({ id: 'o', title: '還在做的', lastTs: '2026-11-01T06:00:00Z' });
  const closedHere = sess({ id: 'x', title: '同資料夾已結案', closedAt: '2026-11-01T05:00:00Z' });
  const closedGone = sess({ id: 'g', title: '資料夾不在', cwd: '/w/g', closedAt: '2026-11-01T05:00:00Z', card: card({ path: '/w/g', gone: true }) });
  const closedClean = sess({ id: 'k', title: '收好的', cwd: '/w/k', closedAt: '2026-11-01T05:00:00Z', card: card({ path: '/w/k' }) });
  const b = board([proj([open, closedHere, closedGone, closedClean])]);
  eq('進行中的那一個:F 用的就是白板那一行(同一份)', b.desk.o, b.projects[0].rows.find((r) => r.id === 'o'));
  check('同資料夾、已結案 → 資料夾的事見還在做的那一個', b.desk.x?.closed === true && b.desk.x.items.some((i) => i.kind === 'note' && i.text.includes('資料夾的事見「還在做的」')), JSON.stringify(b.desk.x));
  check('必抓:已結案、資料夾不在 → 看不到(不是沒事)', b.desk.g?.items.some((i) => i.kind === 'unknown' && i.text.includes('資料夾不在了')), JSON.stringify(b.desk.g));
  check('已結案、資料夾都在、沒東西 → 資料夾裡沒有沒存、沒併的東西', b.desk.k?.items.some((i) => i.text === '資料夾裡沒有沒存、沒併的東西'), JSON.stringify(b.desk.k));
  const q = board([proj([closedGone, closedClean])]).projects[0];
  check('那個案件只剩已結案的 → 白板那一句,資料夾不在的照講看不到', q.quiet?.includes('沒有進行中的對話') && q.quiet.includes('資料夾已經不在的看不到'), q.quiet);
}

section('AC-1:真的資料夾、真的紀錄跑一次 collectAll——總表用的欄位名字對得上真的資料(不只對假資料)', 'P5');
{
  const repo = makeRepo({ files: { 'a.txt': 'x\n' } });
  writeFileSync(join(repo.dir, 'new.txt'), 'y\n');            // 一個還沒存的新檔:git diff 看不到它(L2),三階梯看得到
  const monitorDir = mkdtempSync(join(tmpdir(), 'pm-monitor-'));
  mkdirSync(join(monitorDir, 'logs')); mkdirSync(join(monitorDir, 'checkpoints'));
  copyFileSync(join(ROOT, 'stages.json'), join(monitorDir, 'stages.json'));
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  const base = Date.now();
  const T = (m) => new Date(base - m * 60_000).toISOString();   // 同一個「現在」:寫紀錄跟對答案用的是同一個時間
  const log = join(monitorDir, 'logs', `${basename(repo.dir)}.jsonl`);
  writeFileSync(log, [
    JSON.stringify({ ts: T(10), hook: 'UserPromptSubmit', session: 's1', cwd: repo.dir, prompt: '幫我加一個檔' }),
    JSON.stringify({ ts: T(9), hook: 'PostToolUse', tool: 'Write', session: 's1', cwd: repo.dir, file: join(repo.dir, 'new.txt') }),
  ].join('\n') + '\n');
  const all = collectAll({ monitorDir, skillHome: home, home });
  const s1 = all.projects[0]?.sessions?.find((s) => s.id === 's1');
  eq('真的資料的對話帶著你最後一次說話的時間', s1?.lastSaidAt, T(10));
  const row = rowsOf(todoBoard(all, { ago: AGO }))[0];
  check('真的資料:還沒存的新檔照三階梯那一句列出來', has(row, '還有 1 個檔案沒存'), JSON.stringify(texts(row)));
  check('真的資料:沒蓋過章 → 列', has(row, '還沒蓋過章'), JSON.stringify(texts(row)));
  check('真的資料:這個專案沒設定分級 → 不知道該跑哪幾關,不是沒事', has(row, '不知道該跑哪幾關') && row.clear === null, JSON.stringify(row));
  appendFileSync(log, JSON.stringify({ ts: T(1), event: 'session_closed', session: 's1', cwd: repo.dir, source: 'human' }) + '\n');
  const after = rowsOf(todoBoard(collectAll({ monitorDir, skillHome: home, home }), { ago: AGO }))[0];
  check('真的資料:按了結案、檔案還沒存 → 照樣出現,只講檔案的事', after?.closed === true && texts(after).join('|') === '還有 1 個檔案沒存', JSON.stringify(after));
  repo.cleanup(); rmSync(monitorDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
}

section('AC-9:切成英文——總表的每一句都是英文,「沒有還差的事」不講成 passed、done', 'P2');
{
  const en = withLang('en', () => {
    const s = sess({ title: 'Do a thing', stages: stagesOf({ D: { state: 'stale', name: 'Chaos check', rerun: { state: 'ask', line: 'whether to run it again is your call' } } }),
      tier: tierOk([req('C', 'C Cleanup', 'missing', 'no record')]), card: card({ ladder: ladder({ commit: ['pending', '2 files not committed yet'] }), checkpoint: null }) });
    const done = sess({ id: 's2', title: 'Finished one', cwd: '/w/b', card: card({ path: '/w/b' }), tier: tierOk([]) });
    const gone = sess({ id: 's3', title: 'Gone one', cwd: '/w/c', card: card({ path: '/w/c', gone: true }) });
    const b = board([proj([s, done, gone], { displayName: 'P', cards: [card({ path: '/w/main', ladder: ladder({ push: ['pending', 'main has 5 new commits to push'] }) })] }), proj([], { name: 'q', displayName: 'Q', cards: [] })],
      { ago: () => '3 minutes ago' });   // 「幾分鐘前」的英文是 lib/git.mjs 的 ago 給的,這裡換成英文的假的
    return { b, lines: boardText(b), restart: restartLine({ bootAt: new Date().toISOString(), changed: ['lib/a.mjs'] }), down: serveDownLine(), old: serveOldLine() };
  });
  const all = [...en.lines, en.restart, en.down, en.old].join('\n');
  check('英文:總表自己出的字沒有中文', !/[一-鿿]/.test(all), all.match(/.*[一-鿿].*/)?.[0]);
  const clear = rowsOf(en.b).find((r) => r.id === 's2')?.clear ?? '';
  check('英文:沒有還差的事 → 不講 passed、done、✓', !!clear && !/\bpassed\b|\bdone\b|✓|✅/i.test(clear), clear);
  const wbEn = uiOf({ projects: [{ name: 'p', suggestions: [] }], todo: en.b }, 'en').whiteboard({ name: 'p' });
  const grayTitle = wbEn.match(/class="wb-pen" data-ink="gray" data-lit="1" title="([^"]+)"/)?.[1] ?? '';
  check('英文:看板下方四盞燈號文案完整且灰燈提示不因雙引號被截斷',
    ['Red light = your call', 'Blue light = what\'s still to do', 'Gray (unlit) = can\'t see', 'Yellow light = only closing left'].every((t) => wbEn.includes(t))
    && grayTitle.includes('&quot;can\'t see&quot;') && grayTitle.includes('(gray stays unlit)'),
    wbEn.slice(-600));
  const wbEnDay = uiOf({ projects: [{ name: 'p', suggestions: [] }], todo: en.b }, 'en', 'day').whiteboard({ name: 'p' });
  check('英文白天工班:看板下緣四支筆文案為 Red / Blue / Gray / Yellow 且沒有中文',
    ['Red = your call', 'Blue = what\'s still to do', 'Gray = can\'t see', 'Yellow = only closing left'].every((t) => wbEnDay.includes(t))
    && !/[一-鿿]/.test(wbEnDay), wbEnDay.slice(-600));
}

section('軟整併 AC-4/AC-2：--todo 任務板摘要與異常不入 quiet、--cards 尾行提示、task-board 下 directorRow 誠實對齊', 'P5');
{
  const pReady = proj([], {
    name: 'tb-ready',
    displayName: 'TB Ready',
    taskBoard: { state: 'ok', entryMode: 'task-board', relPath: '.agents/pipeline-tasks.json', total: 3, counts: { ready: 2, unknown: 0 } },
    suggestions: [{ id: 's-open', title: '舊卡', ts: '2026-11-01T00:00:00Z', prompt: 'x' }],
  });
  const pBroken = proj([], {
    name: 'tb-broken',
    displayName: 'TB Broken',
    taskBoard: { state: 'broken', entryMode: 'unknown', note: '任務清單設定有誤' },
  });
  const pNoMain = proj([], {
    name: 'tb-nomain',
    displayName: 'TB NoMain',
    taskBoard: { state: 'no-main', entryMode: 'unknown', note: '找不到主資料夾，問不到任務清單。' },
  });
  const pUnkTask = proj([], {
    name: 'tb-unk',
    displayName: 'TB Unknown',
    taskBoard: { state: 'ok', entryMode: 'task-board', total: 1, counts: { ready: 0, unknown: 1 } },
  });
  const pIdle = proj([], {
    name: 'tb-idle',
    displayName: 'TB Idle',
    taskBoard: { state: 'ok', entryMode: 'task-board', total: 1, counts: { ready: 0, unknown: 0 } },
  });

  const b = board([pReady, pBroken, pNoMain, pUnkTask, pIdle]);
  const lines = boardText(b);
  const joined = lines.join('\n');
  check('有可開工任務的專案出現在 --todo 專案段且不進 quiet',
    joined.includes('誠實任務板：可開工 2 項（共 3 項；跑 agy-pipeline --tasks 查看）') && !(b.quiet ?? '').includes('TB Ready'), joined);
  check('task-board 下有未開始建議卡時，cardsLine 指向誠實任務板底部「待清理建議卡（--suggest）」',
    joined.includes('案件頁誠實任務板底部的「待清理建議卡（--suggest）」'), joined);
  check('broken / no-main / counts.unknown > 0 皆在 --todo 列出且不進 quiet（預審 #3）',
    joined.includes('TB Broken') && joined.includes('TB NoMain') && joined.includes('TB Unknown')
    && !(b.quiet ?? '').includes('TB Broken') && !(b.quiet ?? '').includes('TB NoMain') && !(b.quiet ?? '').includes('TB Unknown'), joined);
  check('無可開工、無 unknown 且無未開始卡的任務板專案正常收進 quiet', (b.quiet ?? '').includes('TB Idle'), b.quiet);

  // --cards 在 task-board 模式保留完整歷史並加註 --tasks 提示
  const cardsOut = cardsText({ projects: [pReady] }, 'tb-ready', { ago: AGO }).join('\n');
  check('--cards 保留舊建議卡並附已建立誠實任務板尾行提醒',
    cardsOut.includes('舊卡') && cardsOut.includes('這個專案已建立誠實任務板（.agents/pipeline-tasks.json）'), cardsOut);

  // directorRow 在 task-board 模式下同步改用任務板文案與新位置引導
  const wfStages = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, name: id, line: '這一輪還沒跑', state: 'none', ...(id === 'B' ? { type: 'main-conversation', state: 'main' } : id === 'E' ? { type: 'browser' } : { skill: id.toLowerCase() }) }));
  const s1 = sess({ id: 'l' });
  const tbProject = { name: 'p', suggestions: [], taskBoard: { state: 'ok', entryMode: 'task-board', total: 1, counts: { ready: 1, unknown: 0 } } };
  const latestMerge = { projects: [tbProject], taskEntryMergeSupport: true, todo: board([proj([s1])]) };
  const dirHtml = uiOf(latestMerge).workflow({ path: '/w/a', sensor: { state: 'ok' }, stages: wfStages, director: uiOf(latestMerge).directorOf(tbProject, { id: 'l' }) });
  check('directorRow 在 task-board 模式且無本對話建議卡時改用任務板文案並保留只看得到 --suggest 但書',
    dirHtml.includes('任務入口：已改用誠實任務板；本對話無 --suggest 建議卡（只看得到用 --suggest 放的）')
    && dirHtml.includes('誠實任務板底部的「待清理建議卡（--suggest）」或歷史折疊列'), dirHtml);
}

section('D1 回歸（P8）：真實 collectAll() 下 --todo 對已結案刪檔與 90 天清空空檔不誤報為任務板異常', 'P8');
{
  const monDir = mkdtempSync(join(tmpdir(), 'pm-todo-nomain-'));
  try {
    mkdirSync(join(monDir, 'logs'), { recursive: true });
    mkdirSync(join(monDir, 'checkpoints'), { recursive: true });
    const t = new Date(Date.now() - 60_000).toISOString();

    const goneClosedDir = join(monDir, 'gone-closed-repo');
    writeFileSync(join(monDir, 'logs', 'old-closed.jsonl'), [
      JSON.stringify({ ts: t, hook: 'UserPromptSubmit', session: 's-gc', cwd: goneClosedDir, prompt: '舊專案工作' }),
      JSON.stringify({ ts: t, event: 'session_closed', session: 's-gc', cwd: goneClosedDir, source: 'human' }),
    ].join('\n') + '\n');
    writeFileSync(join(monDir, 'logs', 'expired-empty.jsonl'), '');
    const activeGoneDir = join(monDir, 'active-gone-repo');
    writeFileSync(join(monDir, 'logs', 'active-gone.jsonl'),
      JSON.stringify({ ts: t, hook: 'UserPromptSubmit', session: 's-ag', cwd: activeGoneDir, prompt: '進行中工作' }) + '\n');

    const all = collectAll({ monitorDir: monDir, home: monDir, skillHome: monDir });
    const b = todoBoard(all, { ago: AGO });
    const gcProj = b.projects.find((x) => x.name === 'old-closed');
    const expProj = b.projects.find((x) => x.name === 'expired-empty');
    const agProj = b.projects.find((x) => x.name === 'active-gone');
    check('old-closed（已結案且資料夾已刪）→ tasks === null 且進入 quiet 含「資料夾已經不在的看不到」',
      gcProj?.tasks === null && Boolean(gcProj?.quiet) && (b.quiet ?? '').includes('old-closed') && (b.quiet ?? '').includes('資料夾已經不在的看不到'),
      JSON.stringify({ gcProj, quiet: b.quiet }));
    check('expired-empty（90 天清空空檔）→ tasks === null（不誤報成誠實任務板問不到或設定有誤）',
      expProj?.tasks === null, JSON.stringify(expProj));
    check('active-gone（有未結案對話且資料夾已刪）→ 照樣在 tasks 提醒誠實任務板問不到',
      Boolean(agProj?.tasks && agProj.tasks.includes('誠實任務板問不到或設定有誤')), JSON.stringify(agProj));
  } finally {
    rmSync(monDir, { recursive: true, force: true });
  }
}

process.exit(summary());
