/**
 * scope.mjs —— 「這個數字從哪裡算起」的文案,只有這一份。規格:這一輪的起點 AC-5(路徑看 CLAUDE.md 的表)
 * 檔尾另有還原點與改動那兩段終端機與儀表板都講的那幾句(規格:終端機與網頁說同一句)。
 *
 * 終端機(status.mjs)、收工 hook(gate.mjs)、伺服器(lib/collect.mjs 算好放進卡片的 scope,網頁照著畫)都呼叫這裡——
 * 三處各寫一份,遲早講三種話(老毛病 P2)。
 * ⚠️ 網頁不直接 import 這支:常駐的儀表板服務只送它啟動那一刻白名單裡的檔案,多一個新檔,
 *    更新後還沒重啟的那段時間整個畫面會載不進來(scripts/ui.test.mjs 的 suggestionsBlock 那段說過同一件事)。
 *
 * base 是 lib/origin.mjs 的 changeBase() 算的:{ kind: 'checkpoint'|'origin'|'head', why, moved, commits, origin: { at, from, sessions } }。
 * ⚠️ 三條紅線:
 *   R1 只看還沒存檔的時候,要講「存檔過的算不進來」——不准讓「沒有」看起來像這一輪真的沒動過(老毛病 P5);
 *      反過來,一次都沒存過檔,就不准說「存檔過的看不到」
 *   R3 時間只准從起點那筆紀錄來,不自己估;「幾分鐘前」怎麼寫由呼叫端給(ago)
 */

/** 起點是什麼(名詞,後面接「那一刻」)。蓋章不會出現在這裡:章能用的話 kind 是 checkpoint。 */
const FROM = {
  A: '叫 A 寫規格',
  prompt: '這個對話第一句話',
  // 這個對話在這裡的第一筆紀錄不是一句話:它是從別的資料夾換過來的(或這個資料夾是後來才變成 git 的)
  arrival: '這個對話在這裡的第一筆紀錄',
  // app 把這個資料夾換一條新分支給新對話,之後還沒有任何紀錄(規格:新對話接手舊資料夾)
  takeover: '這個資料夾換到這條分支',
};

/**
 * @returns {{ title, label, note, empty, short, blind, emptyBlind, commitsNote }}
 *   title:終端機那一段的標題;label:網頁改動卡以前的小標(存檔與蓋章卡不用了,還開著的舊畫面還在用,只加不拿);note:括號裡那一句(可能是 null);
 *   empty:一個檔案都沒有時的那一句;short:收工 hook 理由裡的括號;
 *   blind:只看得到還沒存檔的(存檔過的看不到)——等級旁邊要講「實際可能更高」;
 *   emptyBlind:0 的時候不准畫「沒有改動」那張臉(看不到存檔過的,或這一輪中間 HEAD 動過);
 *   commitsNote:這一輪是好幾次存檔加起來的時候講一句,比例尺(一次存檔的)旁邊要用(L6)
 *   網頁「存檔與蓋章」那張卡(規格:先講commit再講蓋章 AC-3、AC-4、AC-5)另外用三句,看得到哪裡就講到哪裡:
 *   savedTail:還有東西沒 commit 時,「另外 N 個」後面接的那半句;allSaved:都 commit 了,大字底下那一句;
 *   unseen:看不到 commit 過的是哪些(沒有這一輪的起點、或一個 commit 都沒有)時講的那一句——有它就沒有前兩句
 * ⚠️ 「還沒有能用的章」只在不是 checkpoint 時講:章能用,changeBase() 一定給 checkpoint(lib/origin.mjs)
 */
export function changeScope(base, ago) {
  const commitsNote = base?.commits > 1 ? `這裡是 ${base.commits} 次存檔加起來的` : null;
  if (!base || base.kind === 'checkpoint') {
    return { title: '蓋章之後的改動', label: '蓋章之後改過、還沒重新檢查的檔案', note: null,
             empty: '現在的檔案跟蓋章時一模一樣。', short: '蓋章之後', blind: false, emptyBlind: false, commitsNote,
             savedTail: '已經 commit、還沒蓋章', allSaved: '都 commit 了，這些是蓋章之後改的', unseen: null };
  }
  const o = base.origin ?? {};
  if (base.kind === 'origin') {
    const many = o.sessions > 1;
    const from = many ? '最早開口的那個對話' : FROM[o.from] ?? '這一輪開始';   // 「最早開口的那個」是 Oscar 2026-09-22 點頭的說法
    const when = o.at ? `（${ago(o.at)}）` : '';
    return {
      title: '這一輪的改動',
      label: '這一輪改過的檔案（含已存檔的）',
      note: `${many ? `含 ${o.sessions} 個對話的改動，` : ''}從${from}${when}那一刻的版本算起，含已存檔的`,
      // 0 的時候只講證明得出來的:「現在跟開始時一模一樣」。「沒有任何檔案被動過」證明不了——改了又改回去、git stash 都是 0
      //   (魔鬼教官 2026-09-22 第二輪)。中間 HEAD 動過(存到別的分支又切回來、存了又退回去)就再多講一句,而且換一張臉
      empty: base.moved
        ? '現在的檔案跟這一輪開始時一模一樣；但這一輪中間存過檔或切過分支——不在現在這條線上的存檔，這裡看不到。'
        : '現在的檔案跟這一輪開始時一模一樣。',
      short: many ? `這一輪，含已存檔的，含 ${o.sessions} 個對話的改動` : '這一輪，含已存檔的',
      blind: false,
      emptyBlind: !!base.moved,
      commitsNote,
      // 沒有能用的章:「還沒蓋章的」不只這一輪這些,更早改的也沒蓋過——講明只算這一輪(R1)
      savedTail: '已經 commit、還沒蓋章（只算這一輪改的）',
      allSaved: '都 commit 了，還沒有能用的章；這裡只算這一輪改的',
      unseen: null,
    };
  }
  if (base.why === 'no-commits') {
    return { title: '還沒存檔的改動', label: '還沒存檔（commit）的改動', note: '這個專案還沒有任何存檔',
             empty: '還沒有任何改動。', short: '還沒有任何存檔', blind: false, emptyBlind: false, commitsNote: null,
             savedTail: null, allSaved: null, unseen: '還沒有任何 commit，所以也還沒有東西可以蓋章' };
  }
  const why = base.why === 'no-origin' ? '沒有這一輪的紀錄' : '找不到這一輪開始時的版本';
  return {
    title: '還沒存檔的改動',
    label: '還沒存檔（commit）的改動',
    note: `${why}，存檔過的算不進來`,
    empty: `還沒存檔的：沒有。這一輪存檔過的看不到（${why}）。`,
    short: `只算還沒存檔的——${why}`,
    blind: true,
    emptyBlind: true,
    commitsNote: null,
    savedTail: null,
    allSaved: null,
    unseen: `commit 過、還沒蓋章的有哪些，這裡看不到（${why}）`,
  };
}

/* ────────────── 還原點與改動那兩段,終端機與儀表板都講的那幾句(規格:終端機與網頁說同一句,路徑看 CLAUDE.md 的表) ──────────────
 * 只寫這一份:終端機(lib/cliView.mjs)印,伺服器算好放進卡片帶給網頁(card.lines),網頁照印。
 * ⚠️ 「回去」的指令(git reset --hard、備份分支、stash)不在這裡:那是終端機與網頁各自的版面(網頁是一顆複製鈕、而且含 cd),
 *    章不能用時不給指令的那條規矩照舊由它們各自守(L14,scripts/status.test.mjs 釘著)。 */

/** 還沒有還原點:不說「你沒有能動的版本」,說「還不知道」(pipeline-status AC-4) */
export const NO_STAMP_YET = '這不代表你沒有好版本,只代表我沒問到。';

/** 章能用時永遠寫「檢查全綠」,永遠不寫「確定能動」(pipeline-status AC-5) */
export const GREEN_IS_NOT_CORRECT = '⚠️ 檢查全綠不等於功能正確——測試沒測到的地方它不知道。';

/** 章失效的原因(L14):它指的版本不在了、不在這條分支的歷史上、問不到關係。「所以不給回去的指令」那半句各自講 */
export function stampBrokenReason(rel) {
  return rel?.state === 'gone' ? '它指的版本已經不存在了。'
    : rel?.state === 'off-branch' ? '它指的版本不在目前這條分支的歷史上（歷史被改寫過，或分支換過）。'
    : '問不到它跟現在的版本是什麼關係。';
}

/**
 * 比例尺(pipeline-status AC-7):這個專案自己的歷史,一次存檔平常幾個檔案、最多到過幾個——沒有「太多」這種話。
 * 這裡是好幾次存檔加起來的時候要講,不然 22 個配「最多到過 20 個」讀起來像有史以來最大的一次(L6)。外面的括號、「參考:」是各自的版面
 */
export function scaleLine(scale, commitsNote = null) {
  return `這個專案一次存檔（commit）通常 ${scale.median} 個檔案,最多到過 ${scale.max} 個${commitsNote ? `；${commitsNote}` : ''}`;
}

/** 還沒存進保險箱(commit)的有幾個——「保險箱」只是 commit(Oscar 2026-09-10 讀成 push 過)。問不到 ≠ 沒有(R1) */
export const unsavedLine = (n) => `其中 ${n} 個還沒存進保險箱（commit）`;
export const UNSAVED_UNKNOWN = '問不到有幾個還沒存進保險箱（commit）。';

/* ── 回去會丟掉什麼:儀表板還原點那一行,跟終端機「怎麼回去」那一段講同一句(規格:先講commit再講蓋章 AC-9) ──
 * 以前網頁那一行永遠寫「回去會丟掉還沒存（commit）的東西」,都 commit 了也照樣掛著——讀起來就是「你現在有東西沒存」(2026-10-29)。
 * 整頁統一講「還沒 commit」(Oscar 2026-10-29)。外面的 ⚠️、「想留著先打」那半句是各自的版面 */
/** also:前面已經講過「會丟掉蓋章之後的 N 次存檔」(終端機才有那一句) */
export const loseUnsavedLine = (n, also = false) => `回去${also ? '也' : ''}會丟掉你還沒 commit 的 ${n} 個檔案`;
/** 問不到 ≠ 沒有(R1):不知道有沒有,就照「可能有」提醒 */
export const UNSAVED_WHETHER = '問不到你有沒有還沒 commit 的檔案';
/** 一個都沒有:只講現在。不講「回去不會丟東西」——複製指令之後才改的檔,貼上指令照樣會丟 */
export const NONE_UNSAVED_NOW = '現在沒有還沒 commit 的檔案';
/** 照還沒 commit 的個數挑一句(null／沒給 = 問不到) */
export const restoreUnsavedLine = (dirty) => (dirty == null ? UNSAVED_WHETHER : dirty > 0 ? loseUnsavedLine(dirty) : NONE_UNSAVED_NOW);

/** 網頁「存檔與蓋章」卡最下面收起來的那一段:commit 跟蓋章差在哪(規格:先講commit再講蓋章 AC-8)。每一頁都一樣,伺服器放在最上層帶過去。
 *  ⚠️ 「會直接被拒絕」照 lib/cliStamp.mjs 的 doCheckpoint 寫的(工作區有沒 commit 的檔就不蓋)——那邊的做法變了,這一句要跟著改 */
export const STAMP_HELP = {
  commit: 'commit（存檔）：把現在的檔案存一份，之後回得去這一份。只代表存了，不代表程式能動。',
  stamp: '蓋章（pipeline-status --checkpoint）：在已經 commit 的那一份上，跑這個專案的檢查（還原點卡上列的那幾項），全綠才蓋。還原點卡上的時間，就是最近一次蓋章。',
  order: '一定先 commit 再蓋章：還有沒 commit 的檔案，蓋章會直接被拒絕。',
};
