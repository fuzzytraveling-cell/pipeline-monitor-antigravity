/**
 * events.mjs —— 感測器的紀錄:檔名、讀進來、90 天清理。規格:pipeline-sensor、90天清理不丟紀錄(路徑看 CLAUDE.md 的表)
 *
 * ⚠️ 這支在危險清單上:這裡寫錯,你的紀錄會安靜地不見(讀不到、清掉不該清的)。所以只放「紀錄怎麼存、怎麼讀、怎麼清」——
 *    讀出來之後的判斷(誰說的話、每一關跑過沒、D 要不要再跑、這一輪從哪開始)住在 lib/rounds.mjs,改判斷不用碰這裡。
 *    以前兩樣放在同一支,1501 行裡只有約 235 行會弄丟紀錄,改一句判斷也被算成最高那一級(規格:紀錄與判斷分家,2026-10-06)。
 *    這裡不准拿 lib/rounds.mjs 的任何東西——危險的那段不依賴判斷。
 *
 * ⚠️ 讀紀錄要**分清楚三件長得一樣的事**(AC-1 / AC-7):
 *     ① 紀錄檔不存在        → 感測器還沒裝,或這個專案還沒用過 → 「還不知道」
 *     ② 紀錄檔存在但沒有事件 → 感測器裝了但沒收到東西       → 「感測器可能沒在運作」
 *     ③ 有事件,但沒有這一關   → 這一關**真的**沒跑過          → 「沒跑過」
 *   把①②講成③就是謊話,而且會害人重跑已經跑過的檢查,或以為驗過了其實沒有。
 */
import {
  readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync, fstatSync, statSync, fsyncSync,
  renameSync, unlinkSync, readdirSync, appendFileSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFaults } from './faults.mjs';

const RETAIN_DAYS = 90;   // AC-5:保留三個月(2026-09-09 Oscar 決定)
const DAY_MS = 86400_000;
/** 過期的累積滿幾天才真的清一次檔(規格:90 天清理不丟紀錄 AC-2,2026-09-24 Oscar 決定七天)。
 *  清得越少,撞上別人正在寫的機會越少;多留在檔案裡的那幾天,畫面照樣看不到。 */
const SWEEP_EVERY_DAYS = 7;
/** 清理的暫存檔超過這麼久還在,就是清到一半被砍留下的殘檔(同一份規格 AC-3)。清一次只要幾毫秒。 */
const STALE_TEMP_MS = 3600_000;
/** 換上去之後隔這麼久,再把寫進舊的那一份的行補一次(同一份規格 AC-1)。hook.sh 從打開檔案到寫進去,
 *  這台量到最慢 30 毫秒(2026-09-24,60 次);比這更慢才寫進舊檔的還是會丟——剩下的洞。 */
const SWEEP_DRAIN_MS = 50;
/** 同步地停一下:讀紀錄的人都是同步呼叫 readEvents 的。清檔通常一週一次,一次停這麼一下。 */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/**
 * 感測器記使用者一句話的上限(字數)。⚠️ 這個數字住兩個地方:這裡、hook.sh 的 `.[0:200]`(jq 照字數截,剝掉 system-reminder 之後)。
 * 讀取端要知道它,才分得出「這句話就這麼長」跟「後面被截掉了」(第一句話的規格提示,施工對話認規格 AC-3)。
 * scripts/specLink.test.mjs 真的跑 hook.sh 對這個數字(老毛病 P2)。
 */
export const PROMPT_CAP = 200;

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
 * @param opts.wait 清檔時「換上去之後停一下」的那一下(見 sweepFile);只有測試會換掉它
 * @returns {{state:'no-file'|'no-events'|'ok', events:Array, broken:Array}}
 *   state 刻意分三種,呼叫端不准折成布林。
 */
export function readEvents(logDir, project, { wait } = {}) {
  const file = logFileOf(logDir, project);
  // 感測器自己回報的故障(例如 jq 不在)。這是 AC-1 的第二個來源。
  // ⚠️ 它是全機一份、不分專案——所以只能當「那幾次可能漏記」的警告,
  //    不能拿來蓋掉整區紀錄(誠實修補 D2:以前一有故障,幾千筆紀錄都被講成「裡面沒有東西」)。
  // ⚠️ 專案還沒有紀錄檔也要讀:jq 不在的新專案一筆紀錄都不會有,以前這裡不讀,畫面叫你開新的對話,照做永遠等不到
  //    (規格:agent回報與故障記號 AC-3;老毛病 P3)。讀法只有一份(lib/faults.mjs)
  const broken = readFaults(logDir);
  if (!existsSync(file)) return { state: 'no-file', events: [], broken };

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
  if (!events.length) return { state: 'no-events', events: [], broken };
  // AC-5:超過保留期限的丟掉。⚠️ 丟掉的是真的沒了——呼叫端問到更早的期間要回答「超過保留期限」,不是「沒跑過」。
  // 畫面一律只看 90 天內的;檔案要等過期的累積滿一週才真的清(規格:90 天清理不丟紀錄 AC-2)。「現在」只取一次(L18)。
  // 例外:一筆都不剩了就不等——留著不清,讀出來是「有紀錄、但一筆都沒有」,畫面會連著幾天說「這一輪還沒跑」;
  // 以前只有清的那一次會這樣,清完就照「紀錄檔裡沒有東西」講(魔鬼教官第一輪抓到)
  const now = Date.now();
  const cutoff = now - RETAIN_DAYS * DAY_MS;
  const kept = events.filter((e) => inRetention(e, cutoff));
  let oldest = Infinity;
  for (const e of events) { const t = tsOf(e); if (t < oldest) oldest = t; }
  if (!kept.length || oldest < now - (RETAIN_DAYS + SWEEP_EVERY_DAYS) * DAY_MS) sweepFile(file, now, { wait });
  return { state: 'ok', events: kept, broken };
}

/**
 * 讀的人要清檔時走這一條:讀＋算 → 換 → 停一下(讓換檔之前就打開了舊檔的人寫完)→ 再補一次、放掉舊的那一份。
 * wait 可以換掉:測試拿它在「停一下」的那一刻寫一行進舊的那一份,不用賭時間。回 true = 換了。
 */
function sweepFile(file, now, { wait = pause } = {}) {
  const p = prepareSweep(file, now);
  if (!finishSweep(p)) return false;
  wait(SWEEP_DRAIN_MS);
  drainSweep(p, { last: true });
  return true;
}

/** 紀錄的時間。寫紀錄的每一處寫的都是 ISO 字串;不是字串、讀不出來的回 NaN(= 時間看不懂)。 */
const tsOf = (e) => (typeof e?.ts === 'string' ? Date.parse(e.ts) : NaN);
/** 還在保留期限內嗎。時間看不懂的**算在內**——不要因為看不懂就刪人家的資料。畫面濾的、清檔丟的都走這一個(老毛病 P2)。 */
const inRetention = (e, cutoff) => { const t = tsOf(e); return !Number.isFinite(t) || t >= cutoff; };
/** 這一行是不是「看得懂時間、而且過期」。整行讀不懂的(兩個對話同時寫、交錯壞掉的那種)不算,留著。 */
function expired(line, cutoff) {
  let e;
  try { e = JSON.parse(line.toString('utf8')); } catch { return false; }
  return !inRetention(e, cutoff);
}
const NEWLINE = Buffer.from('\n');

/**
 * 清檔(規格:90 天清理不丟紀錄)。分三步,讀的人(readEvents)一次做完;拆開是為了讓測試插得進「中間有人寫了一行」:
 *   prepareSweep:照這一刻的檔案,把留下來的行寫到同一個資料夾的暫存檔,原檔不動
 *   finishSweep: 換上去之前再看一眼原檔——長度、身分、修改時間有一樣變了,就是有人寫進來、或別人先換過了 → 這次不清;
 *                沒變就換上去,馬上把寫進舊的那一份的行補過來
 *   drainSweep:  隔一下再補一次,然後放掉舊的那一份
 * ⚠️ 以前是「整份讀出來、拿掉舊的、整份寫回去」:讀完到寫回之間別人 append 的那一行被蓋掉(包括你按的「驗收過了」),
 *    寫到一半被砍檔案只剩一半,兩個讀的人同時清還會互相蓋掉。紀錄的寫入者很多(hook.sh、status.mjs、server.mjs、gate.mjs),
 *    全都只 append、不等人,也不該讓它們等(hook.sh 是熱路徑,不准加鎖)。
 * ⚠️ 「換之前看一眼」擋不住的有兩種,都是先打開了舊檔、看完那一眼才寫進去的:
 *    ① hook.sh 是 shell 先打開檔案、jq 算完才寫(幾毫秒);
 *    ② 暫存檔 fsync 那幾毫秒,別的程式的 append 被磁碟擋著,放行時已經過了那一眼——按鈕、--report 這種一口氣寫完的也會中
 *       (魔鬼教官第一輪抓到、重現過;規格原本寫「你蓋的章不會丟」是錯的)。
 *    兩種都寫進了舊的那一份,所以換上去之後舊的那一份先不放,補兩次。
 * ⚠️ 還剩一個洞,不是零:最後一次補完之後才寫進舊的那一份的還是會丟(寫的人卡了 SWEEP_DRAIN_MS 以上:電腦很忙、剛好睡著)。
 *    所以才一週清一次(Oscar 2026-09-24 知情選的「甲」):撞上的機會跟清的次數成正比。要零得改存放方式(分冊,規格裡的「乙」)。
 * 任何錯誤都吞掉、當成這次不清:清理不急,跳過永遠安全;讀的人不准因為清不了而壞掉(收工 hook 的契約:錯誤一律放行)。
 * @returns 交給 finishSweep 的東西(帶著舊的那一份,要交給 finishSweep 放掉);null = 這次不清(沒有過期的、讀不到、暫存檔寫不進去)
 */
export function prepareSweep(file, now = Date.now()) {
  let fd = null, tmp = null;
  try {
    fd = openSync(file, 'r');
    const st = fstatSync(fd, { bigint: true });
    // 只讀 fstat 那一刻的長度:之後才寫進來的不在這一份裡,finishSweep 會看到檔案變長而放棄
    const raw = Buffer.alloc(Number(st.size));
    for (let got = 0, n; got < raw.length; got += n) {
      n = readSync(fd, raw, got, raw.length - got, got);
      if (!n) return null;   // 比 fstat 說的短:有人截過這個檔,不碰
    }
    const cutoff = now - RETAIN_DAYS * DAY_MS;
    const out = [];
    let dropped = 0;
    // 一行一行搬原本的位元組,不 parse 再 stringify、順序不變(結案、取消結案照檔案裡的先後算);只丟「看得懂時間、而且過期」的
    for (let start = 0; start < raw.length;) {
      let end = raw.indexOf(0x0a, start);
      if (end === -1) end = raw.length;
      const line = raw.subarray(start, end);
      start = end + 1;
      if (expired(line, cutoff)) { dropped++; continue; }
      out.push(line, NEWLINE);   // 最後一行沒換行也補一個——不然下一筆會黏上去,兩筆都壞
    }
    if (!dropped) return null;
    removeStaleTemps(file, now);
    // `.` 開頭、不以 .jsonl 結尾:儀表板數專案只認 .jsonl 結尾、跳過 `.` 開頭——半成品不會變成一個怪名字的專案
    const path = join(dirname(file), `.${basename(file)}.sweep-${process.pid}-${randomBytes(4).toString('hex')}`);
    const w = openSync(path, 'wx', Number(st.mode & 0o777n));
    tmp = path;   // 真的建起來了才記:建不起來(同名已經有了)的時候,不准把別人的檔當成自己的刪掉
    try {
      writeFileSync(w, Buffer.concat(out));
      fsyncSync(w);   // 先落到磁碟再換:電腦當掉時不會換上一個空檔
    } finally { closeSync(w); }
    const pending = { file, tmp, fd, size: st.size, ino: st.ino, mtimeNs: st.mtimeNs, drained: st.size };
    tmp = null; fd = null;   // 交給 finishSweep／drainSweep
    return pending;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* 關不了不影響 */ }
    if (tmp) try { unlinkSync(tmp); } catch { /* 殘檔下次清理收掉 */ }
  }
}

/** 換上去——前提是原檔從 prepareSweep 讀的那一刻起沒被動過。回 true = 換了(舊的那一份還開著,等 drainSweep 放掉);
 *  false = 這次不清(暫存檔收掉、舊的那一份放掉)。 */
export function finishSweep(p) {
  if (!p) return false;
  let swapped = false;
  try {
    const st = statSync(p.file, { bigint: true });
    // 變長了 = 有人 append;身分變了 = 別人先換過了(長度剛好一樣也認得出來);修改時間也比,多一道
    if (st.size !== p.size || st.ino !== p.ino || st.mtimeNs !== p.mtimeNs) return false;
    renameSync(p.tmp, p.file);   // 一次到位:換之前是舊的一整份,換之後是新的一整份,沒有半份的時候
    swapped = true;
    drainSweep(p);
    return true;
  } catch {
    return swapped;
  } finally {
    if (!swapped) { try { unlinkSync(p.tmp); } catch { /* 殘檔下次清理收掉 */ } releaseOld(p); }
  }
}

/**
 * 換上去之後,舊的那一份還是可能被寫進來(prepareSweep 上面寫的 ① ②)。它還開著:把讀的那一刻之後多出來的**整行**補到新檔。
 * 寫到一半的留給下一次;補過的記在 p.drained,不會補兩次。補的行排在換檔之後別人寫的後面——差幾十毫秒以內,跟兩個對話同時寫一樣。
 * last:補完就放掉舊的那一份;之後才寫進去的就真的沒了(剩下的洞)。
 */
export function drainSweep(p, { last = false } = {}) {
  if (!p || p.fd === null) return;
  try {
    const size = fstatSync(p.fd, { bigint: true }).size;
    if (size > p.drained) {
      const buf = Buffer.alloc(Number(size - p.drained));
      let got = 0;
      for (let n; got < buf.length; got += n) {
        n = readSync(p.fd, buf, got, buf.length - got, Number(p.drained) + got);
        if (!n) break;
      }
      const whole = buf.subarray(0, got).lastIndexOf(0x0a) + 1;
      if (whole > 0) {
        appendFileSync(p.file, buf.subarray(0, whole));
        p.drained += BigInt(whole);
      }
    }
  } catch { /* 補不了就跟沒補一樣:那幾行是剩下的洞 */ }
  finally { if (last) releaseOld(p); }
}

function releaseOld(p) {
  if (p.fd === null) return;
  try { closeSync(p.fd); } catch { /* 關不了不影響 */ }
  p.fd = null;
}

/** 清到一半被砍留下的暫存檔。只收這個檔自己的、超過一小時的——別人正在清的暫存檔只存在幾毫秒。 */
function removeStaleTemps(file, now) {
  const dir = dirname(file);
  const re = new RegExp(`^\\.${basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.sweep-\\d+-[0-9a-f]+$`);
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const f of names) {
    if (!re.test(f)) continue;
    try { if (statSync(join(dir, f)).mtimeMs < now - STALE_TEMP_MS) unlinkSync(join(dir, f)); } catch { /* 下次再說 */ }
  }
}

export { RETAIN_DAYS };
