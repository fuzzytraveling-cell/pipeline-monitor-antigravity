/**
 * scope.mjs —— 「這個數字從哪裡算起」的文案,只有這一份。規格:這一輪的起點 AC-5(路徑看 CLAUDE.md 的表)
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
 *   title:終端機那一段的標題;label:網頁「未檢查清單」的小標;note:括號裡那一句(可能是 null);
 *   empty:一個檔案都沒有時的那一句;short:收工 hook 理由裡的括號;
 *   blind:只看得到還沒存檔的(存檔過的看不到)——等級旁邊要講「實際可能更高」;
 *   emptyBlind:0 的時候不准畫「沒有改動」那張臉(看不到存檔過的,或這一輪中間 HEAD 動過);
 *   commitsNote:這一輪是好幾次存檔加起來的時候講一句,比例尺(一次存檔的)旁邊要用(L6)
 */
export function changeScope(base, ago) {
  const commitsNote = base?.commits > 1 ? `這裡是 ${base.commits} 次存檔加起來的` : null;
  if (!base || base.kind === 'checkpoint') {
    return { title: '蓋章之後的改動', label: '蓋章之後改過、還沒重新檢查的檔案', note: null,
             empty: '現在的檔案跟蓋章時一模一樣。', short: '蓋章之後', blind: false, emptyBlind: false, commitsNote };
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
    };
  }
  if (base.why === 'no-commits') {
    return { title: '還沒存檔的改動', label: '還沒存檔（commit）的改動', note: '這個專案還沒有任何存檔',
             empty: '還沒有任何改動。', short: '還沒有任何存檔', blind: false, emptyBlind: false, commitsNote: null };
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
  };
}
