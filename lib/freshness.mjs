/**
 * freshness.mjs —— 「這些資料是什麼時候的」的唯一出處
 *
 * ⚠️ 這支是 ③ 畫面最重要的一塊,理由寫在規格開頭:
 *
 *    `pipeline-status` 在終端機裡**天生誠實**——你打了指令,看到的就是那一刻。
 *    **網頁不是。** 一個開著三小時的分頁,每個字都是三小時前的,
 *    但它看起來跟剛開的一模一樣。
 *    **這是這個產品第一次有能力安靜地騙人。**
 *
 * 所以這段邏輯刻意抽成純函式:它不碰 DOM、不碰網路,可以直接被測試釘住。
 * 埋在畫面程式碼裡的話,它會是「壞了也沒人知道」的那一種。
 *
 * 中英兩種並排寫在這裡(規格:儀表板與終端機中英切換)。⚠️ 這支會直接送給瀏覽器,所以不 import lib 的任何一支——
 * 語言由呼叫端給(lang):畫面給它自己的那一種,lib/git.mjs 的 ago 給這一次輸出的那一種。
 */

/** 中文、英文並排(跟 lib/lang.mjs 的 zhEn 同一個寫法,只是語言自己帶:這支不能 import lib) */
const zhEn = (lang, zh, en) => (lang === 'en' ? en : zh);

/** 超過這個秒數沒拿到新資料,就不准再假裝資料是新的。 */
export const STALE_AFTER_SECONDS = 30;

/**
 * @param {object} o
 * @param {number} o.generatedAt  伺服器產生這份資料的時間(epoch ms)。⚠️ 伺服器給的,不是瀏覽器算的
 * @param {number} o.now          現在(epoch ms)
 * @param {boolean} o.connected   最近一次抓資料成功了嗎
 * @param {'zh'|'en'} [o.lang]  用哪一種講;沒給是中文
 * @returns {{state:'fresh'|'stale'|'disconnected'|'unknown', label:string, dim:boolean}}
 */
export function describeFreshness({ generatedAt, now, connected, lang = 'zh' }) {
  // 沒有時間戳 → 不知道。**不准當成新的**(R1:沒問到不是「沒問題」)
  if (!Number.isFinite(generatedAt) || !Number.isFinite(now)) {
    return { state: 'unknown', label: zhEn(lang, '不知道這些資料是什麼時候的', 'Can\'t tell when this data is from'), dim: true };
  }

  const ageMs = now - generatedAt;

  // ⚠️ 負數代表時鐘被調過、或筆電睡醒之後對不上。
  // 印一個負數的「-5 秒前」比什麼都不說更糟——它看起來像個正常的數字。
  if (ageMs < -2000) {
    return { state: 'unknown', label: zhEn(lang, '時間對不上（時鐘被調整過？）', 'The times don\'t line up (was the clock changed?)'), dim: true };
  }

  const age = Math.max(0, Math.round(ageMs / 1000));

  if (!connected) {
    // AC-2:斷線的時候**整頁都要說**,不准只是靜靜地停止更新。
    return {
      state: 'disconnected',
      label: zhEn(lang, `連不上了。以下是 ${formatClock(generatedAt)} 的資料（${humanAge(age, lang)}）`,
        `Disconnected. What you see is the data from ${formatClock(generatedAt)} (${humanAge(age, lang)})`),
      dim: true,
    };
  }
  if (age >= STALE_AFTER_SECONDS) {
    return {
      state: 'stale',
      label: zhEn(lang, `資料可能過期了：${formatClock(generatedAt)}（${humanAge(age, lang)}）`,
        `This data might be out of date: ${formatClock(generatedAt)} (${humanAge(age, lang)})`),
      dim: true,
    };
  }
  return {
    state: 'fresh',
    label: zhEn(lang, `資料產生於 ${formatClock(generatedAt)}（${humanAge(age, lang)}）`,
      `Data from ${formatClock(generatedAt)} (${humanAge(age, lang)})`),
    dim: false,
  };
}

/** 英文的單複數是句子的一部分(1 minute ago／2 minutes ago) */
export function humanAge(seconds, lang = 'zh') {
  const unit = (n, one) => `${n} ${one}${n === 1 ? '' : 's'} ago`;
  if (seconds < 1) return zhEn(lang, '剛剛', 'just now');
  if (seconds < 60) return zhEn(lang, `${seconds} 秒前`, unit(seconds, 'second'));
  const m = Math.round(seconds / 60);
  if (m < 60) return zhEn(lang, `${m} 分鐘前`, unit(m, 'minute'));
  const h = Math.round(m / 60);
  if (h < 48) return zhEn(lang, `${h} 小時前`, unit(h, 'hour'));
  return zhEn(lang, `${Math.round(h / 24)} 天前`, unit(Math.round(h / 24), 'day'));
}

function formatClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
