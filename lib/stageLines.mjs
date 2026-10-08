/**
 * stageLines.mjs —— 五關那一段的句子,只寫這一份:終端機(lib/cliStages.mjs)印、伺服器(lib/collect.mjs)算好放進每一格、網頁(ui/app.js)照印。
 * 規格:終端機與網頁說同一句(路徑看 CLAUDE.md 的表)
 *
 * 以前終端機一份、網頁一份(每一格那一句、清單進度、對完那一句、為什麼還不算寫完、旁白):字一樣,改一邊就要記得改另一邊——
 * 測試一句一句追著兩邊對字,漏追的那一句就安靜過期(老毛病 P2)。
 * ⚠️ 網頁不 import 這支:常駐服務只送白名單裡的檔,多一個新檔,更新後還沒重啟的那段時間整個畫面會載不進來——伺服器算好帶過去。
 * 「幾分鐘前」由呼叫端給(終端機、伺服器都給 lib/git.mjs 那一個)。兩邊刻意不一樣的只有「怎麼做」那半句與版面寬度,由呼叫端給(AC-4):
 *   seePages(去哪看各對話)、clearHint(開過瀏覽器之後怎麼說驗收過了)、headLen(讀不懂的規格附開頭幾個字)。
 * E 驗收那一格走過、開過瀏覽器的三句不在這裡(lib/verify.mjs)。
 */
import { ago as agoNow } from './git.mjs';
import { rerunLine, tookLine } from './rounds.mjs';

/**
 * B 的清單進度一句話:「清單 3/5 對過,1 條待討論,1 條還沒對」。沒有清單是 null。分批做的規格只數這一批(施工對話認規格 AC-8)。
 * 好幾份規格:講幾份、共幾條,讀不到的另外講(規格:多份規格與新資料夾的起點 AC-2、AC-5)
 */
export function clProg(cl) {
  if (!cl?.parsed) return null;
  const tail = `${cl.pending ? `,${cl.pending} 條待討論` : ''}${cl.unmarked ? `,${cl.unmarked} 條還沒對` : ''}`;
  if (cl.multi) return `${cl.specs} 份規格共 ${cl.total} 條：${cl.checked} 條對過${tail}${cl.unreadable?.length ? `（另有 ${cl.unreadable.length} 份讀不到，條數不在裡面）` : ''}`;
  return `清單${cl.batch ? '這一批' : ''} ${cl.checked}/${cl.total} 對過${tail}`;
}

/** Claude 對完清單之後那一句的括號:好幾份規格才有——對完的是幾份、共幾條,讀不到的那份不算進「對完」(R2) */
export function clDoneNote(cl) {
  return cl?.multi ? `（${cl.specs} 份規格共 ${cl.total} 條${cl.unreadable?.length ? `；另有 ${cl.unreadable.length} 份讀不到，條數不在裡面` : ''}）` : '';
}

/** 「照別的對話寫的規格 X（Claude 說的）」(施工對話認規格 AC-1) */
export function linkLine(link) {
  const how = link.how === 'only' ? '；沒記到對話代號，這個工作區只有這個對話' : '';
  return `照別的對話寫的規格 ${link.name}（Claude 說的${how}）`;
}

/** B 為什麼還不算寫完:清單還有沒對的、這一批記的代號對不上檔案、或勾都是連上之前就打好的(施工對話認規格) */
export function checklistWhy(cl) {
  if (cl?.batchMissing?.length) return `這一批記的 ${cl.batchMissing.join('、')} 在規格裡找不到了（可能改過號），要重記 --spec`;
  // 連上之前就有的勾,分不出是誰打的:施工的對話常常先對清單、收工時才記 --spec(魔鬼教官第二輪 2026-09-22,R1)——不准斷言「這個對話沒對過」
  if (cl?.preMarked) return '清單的勾在連上這份之前就打好了，分不出是不是這個對話打的';
  return '清單沒對完';
}

/**
 * 寫規格那一關的旁白:規格在哪、另寫了一份、第一句話的提示、分不出是誰記的。都只是講,不算 A、不擋人(施工對話認規格)。
 * @param seePages 好幾個對話共用資料夾時叫你去哪看:終端機指去儀表板,網頁本身就是儀表板(AC-4)
 */
export function specNotes(st, { ago = agoNow, seePages = '看儀表板各對話的頁面' } = {}) {
  const L = [];
  const lk = st.link;
  // 規格在哪(規格搬家 AC-3、AC-4):別的對話寫的連結、這個對話 A 寫的,兩條路都讀 specPlace 這一份——同一個地方判斷、同一句話
  const where = (at) => {
    // 資料夾不在了(worktree 清掉了):工作區裡沒辦法找,不准講成「都沒有同名的」(R1,魔鬼教官 2026-09-22)
    if (at?.gone) return at.found === 'main' ? `這個對話的資料夾已經不在了；規格在主資料夾：${at.rel ?? `${at.name}.md`}` : `這個對話的資料夾已經不在了，找不到記的規格檔（${at.given ?? `${at.name}.md`}）`;
    // 記在主資料夾的(worktree 的對話把規格寫進了主資料夾):講寫在那裡,不講「可能還沒併進來」
    if (at?.found === 'main') return at.recordedIn === 'main' ? `規格寫在主資料夾（${at.rel ?? `${at.name}.md`}），不在這個工作區——不會叫 Claude 去那裡打勾` : '規格在主資料夾，不在這個工作區（可能還沒併進來）——不會叫 Claude 去那裡打勾';
    if (at?.found === 'missing') return `找不到規格檔 ${at.name}.md${!at.given ? '' : at.recordedIn === 'main' ? `（記的是主資料夾的 ${at.given}；主資料夾的規劃中／進行中／升級摘要都沒有同名的）` : `（記的是 ${at.given}；規劃中／進行中／升級摘要都沒有同名的）`}`;
    // 同名的那一份比記的那份還舊:分不出是不是同一份,不拿它的勾(R2,魔鬼教官 2026-09-22);證據只到「比較舊」,不講「是別份」(第二輪)
    if (at?.found === 'older') return `記的規格檔 ${at.name}.md 不在記的位置（${at.given}）；工作區裡同名的 ${at.rel} 比記的那份還舊，分不出是不是同一份——不畫它的清單`;
    // 記的位置不在這個工作區、也不在主資料夾:不拿工作區裡同名的另一份頂替(P6,魔鬼教官 2026-09-22)
    if (at?.found === 'outside') return `記的規格檔 ${at.name}.md 不在這個工作區，也不在主資料夾——不會叫 Claude 去那裡打勾`;
    if (at?.found === 'ambiguous') return `工作區裡叫 ${at.name}.md 的規格不只一份（${(at.where ?? []).join('、')}），分不出是哪一份`;
    if (at?.moved) return `規格搬到了 ${at.rel}（記的是 ${at.given}）`;
    return null;
  };
  // 一次 A 寫了好幾份(規格:多份規格與新資料夾的起點 AC-5):一份一句,前面標是哪一份——讀不到的那份不准安靜消失
  const many = Array.isArray(st.specPlaces) && st.specPlaces.length > 1;
  for (const at of many ? st.specPlaces : [st.specPlace]) {
    const line = where(at);
    if (line) L.push(many ? `${at.name}：${line}` : line);
  }
  if (st.side) L.push(!st.side.name ? `${ago(st.side.ts)}又叫了寫規格那一關（寫了哪份看不到）；施工清單還是 ${lk?.name ?? '原本那份'}`
    : st.side.count > 1 ? `另寫了 ${st.side.count} 份規格 ${st.side.name}（等你點頭）` : `另寫了一份規格 ${st.side.name}（等你點頭）`);
  // 連著一份規格又記了另一份(AC-7):換掉可以,安靜換掉不行。這一輪自己叫 A 寫的被 --spec 換掉也一樣
  if (st.replaced) L.push(st.replaced.own ? `原本照 ${(st.replaced.fromNames ?? [st.replaced.from]).map((n) => `${n}.md`).join('、')}（這個對話叫 A 寫的），後來換成 ${st.replaced.to}.md`
    : `原本照 ${st.replaced.from}.md，後來換成 ${st.replaced.to}.md`);
  // 這一輪之前叫 A 寫的、還有沒對完的(同一個對話叫第二次 A,一輪從後來那次算):收工 hook 不會再要它的清單,講出來
  for (const e of st.earlierSpecs ?? []) L.push(`${e.name}.md 是這一輪之前叫 A 寫的，還有 ${e.unmarked} 條沒對——這一輪從後來那次 A 算起，收工 hook 不會要它的清單`);
  // 記過、現在哪裡都找不到的(改名、刪了):不算進這一輪的規格,講一句
  if (st.ghostSpecs?.length) L.push(`記過 ${st.ghostSpecs.map((n) => `${n}.md`).join('、')}，現在找不到（可能改名或刪了）——不算進這一輪的規格`);
  if (st.hint) L.push(`從你第一句話看，可能是照 ${st.hint.name} 施工（Claude 還沒確認${st.hint.cut ? '；感測器只記第一句話的開頭，後面有沒有提到別份看不到' : ''}）`);
  if (st.unsure) L.push(`有一筆規格連結（${st.unsure.name}）分不出是哪個對話記的——不算數`);
  if (st.shared) L.push(`這個工作區這一輪有好幾個對話；規格連結只算記它的那個對話，${seePages}`);
  // 這一輪還動了別的規格檔、沒記到它是不是這一輪的(AC-6):講一句,不擋收工(Oscar 2026-10-05:會多講話,可以)
  if (st.extraSpecs?.length) L.push(`這一輪還動了 ${st.extraSpecs.map((n) => `${n}.md`).join('、')}，沒記到${st.extraSpecs.length > 1 ? '它們' : '它'}是不是這一輪的規格`);
  return L;
}

/**
 * 「叫了」不等於「通過」(R2):感測器只看得到指令被叫,看不到結果。五關那一段講這一句——終端機在最後、網頁在上面,所以不講「上面寫的」。
 * 「叫了」是 2026-09-15 起的說法(L19):以前網頁寫「跑過」
 */
export const CALLED_IS_NOT_PASSED = '⚠️ 五關寫的是「叫了」,不是「通過」——感測器只看得到指令被叫,看不到結果。驗屋師傅來過,不等於房子修好了。';

/** 「被叫」的證據有兩種:你自己打的斜線指令(不經過 Skill 工具,L19)、或 Claude 自己去叫。字要跟證據一樣大:叫了,不是跑完了 */
function verbOf(st) {
  return st.type === 'browser' ? `開瀏覽器跑過一輪${st.count ? `（${st.count} 個動作）` : ''}`
    : st.via === 'typed' ? `你叫了 /${st.calledAs ?? ''}` : `Claude 叫了 /${st.calledAs ?? st.skill ?? ''}`;
}

/**
 * 五關一格的那一句(不含前面的關名與燈號):終端機印在「D 魔鬼教官　⏸ 」後面,網頁印在那一格的狀態列。
 * ⚠️ 沒有「通過」這種狀態(R2):跑過的用「叫了」,結案要說得出是誰說的(Claude 說／你說)。
 * @param first      這一格是不是第一個有指令的關(寫規格那一關):它在等的是你點頭開工,不是結論
 * @param available  false = 這個專案找不到這一關的指令(lib/skills.mjs)——「沒有紀錄」跟「這裡根本沒有這個指令」是兩件事
 * @param noRecord   沒有紀錄、紀錄檔又讀不到東西時改講的那一句(感測器那一行的 noneLine;規格:90天清空之後的說法 AC-3);平常是 null
 * @param clearHint  開過瀏覽器那一句後面接什麼:終端機給指令,網頁那一格就有按鈕(AC-4)
 */
export function stageLine(st, { ago = agoNow, first = false, available = null, noRecord = null, clearHint = '' } = {}) {
  const head = String(st.report?.note ?? '').split('\n')[0].trim();
  // B(對話本身):改到程式檔就算在動,印最後一次改檔的時間;不數檔案——數量在改動那一段(git)
  if (st.type === 'main-conversation' && st.state !== 'main') {
    const cl = st.checklist;
    const prog = clProg(cl);
    const viaNote = st.via === 'git' ? '（感測器沒看到改檔,是 git 說的——可能是用 Bash 寫的）' : '';
    const extra = cl?.batchMissing?.length || cl?.preMarked ? `；${checklistWhy(cl)}` : '';
    return st.state === 'current' ? `最後一次改程式檔 ${ago(st.ranAt)}${viaNote}——現在在這一關${prog ? `（${prog}${extra}）` : ''}`
      // 清單沒對完:不劃掉,用「要處理」的樣子(五關自動結案 AC-6)
      : st.state === 'stale' ? `改過程式檔（最後一次 ${ago(st.ranAt)}）,${prog}——${checklistWhy(cl)},不算寫完`
      : st.state === 'done' ? `改過程式檔（最後一次 ${ago(st.ranAt)}）,${ago(st.doneAt)}Claude 對完清單${clDoneNote(cl)}`
      : `改過程式檔（最後一次 ${ago(st.ranAt)}）${st.closedBy === 'checklist' ? `,Claude 對完清單${clDoneNote(cl)}` : ''}——已走過`;
  }
  const verb = verbOf(st);
  // 結論會過期的關(D):「要不要再跑」那一句與「上一輪從叫到記結論幾分鐘」(D 多輪先問人 AC-9、AC-13)。花了多久只在最後一次跑完時講
  const rerun = st.rerun ? rerunLine(st.rerun, { ago }) : null;
  const took = st.rerun?.took?.latest ? `（${tookLine(st.rerun.took, { unit: st.type === 'browser' ? '趟' : '輪' })}）` : '';
  // 上一次 Claude 說了什麼:只在「要不要再跑」與「你說不用再跑」時補——找到問題那一句本身就帶著結論
  const prev = (st.rerun?.state === 'ask' || st.rerun?.state === 'skipped') && head ? ` · 上一次 Claude 說：${head}` : '';
  const said = st.type === 'browser' ? '驗收過了' : '處理完了';
  switch (st.state) {
    case 'main': return '就是你在講話的那個對話（這一輪還沒改到程式檔）';
    // 未建的關照實說(CLAUDE.md 刻意的決定)
    case 'notbuilt': return '這一關還沒建';
    case 'none':
      if (available === false) return `找不到 /${st.skill ?? ''} 這個指令（這個專案的 .claude/ 和 ~/.claude 都沒有）`;
      // 上一輪的只講一句,不畫線——線多了會干擾判斷(Oscar 2026-09-15)
      if (st.prevRanAt) return `這一輪還沒跑（上一輪 ${ago(st.prevRanAt)}跑過）`;
      return noRecord ?? '這一輪還沒跑';
    case 'passed':
      // 照別的對話寫的規格施工(施工對話認規格 AC-1):連結不是 A 的一次呼叫,沒有「叫了」的時間可講,講照哪份、誰說的
      if (st.closedBy === 'link' && st.link) return `已走過：${linkLine(st.link)}`;
      // A 的結案是你點頭開工(之後第一次改到程式檔):講出來,不然像是憑空劃掉的
      return `${ago(st.ranAt)}${verb}${st.closedBy === 'nod' ? `,${ago(st.nodAt)}開始改程式檔,算你點頭開工了` : st.closedBy === 'claude' && head ? `,Claude 說：${head}` : st.closedBy === 'human' ? `,你說${said}` : ''}——已走過${took}`;
    // D 之後又改了程式檔——要不要再跑由你決定(D 多輪先問人 AC-2),不是「要再跑」;叫了沒記結論也是這個樣子。不劃掉、不打勾
    case 'stale': return `${ago(st.ranAt)}${verb},${rerun ?? '之後又改了程式檔——要再跑一次'}${prev}${took}`;
    // 你說不用再跑(AC-4):附你在 D 之後說的最後一句(感測器記的)與時間。擱著——是你的決定,不是驗過了
    case 'held': return `${ago(st.ranAt)}${verb},${rerun ?? '你說不用再跑'}${prev}${took}`;
    // 開過瀏覽器 ≠ 驗收過(Oscar 2026-09-15:截圖儀表板也會讓 E 亮)。講去了哪,算不算由人說
    case 'seen': return `${ago(st.ranAt)}開過瀏覽器（${st.count} 個動作${st.hosts?.length ? `,去了 ${st.hosts.slice(0, 3).join('、')}` : ''}）——算不算驗收你說了算${clearHint}`;
    // 沒有結案的,時間越久要越顯眼——所以天數一定印出來。結案要說得出是誰說的(五關自動結案 AC-11)。等結論的關講清楚在等誰
    case 'current':
    case 'done': {
      let tail;
      if (st.state === 'done') tail = `,${ago(st.doneAt ?? st.clearedAt)}${st.closedBy === 'claude' ? `Claude 說${head ? `：${head}` : '沒問題'}` : `你說${said}`}${took}`;
      else if (st.report?.verdict === 'found') tail = `,Claude 說找到問題${head ? `：${head}` : ''}——還沒處理完${took}`;
      else if (st.type === 'browser') tail = `,還沒有人說${said}`;
      else if (first) tail = ',等你點頭開工';
      else tail = `,${rerun ?? 'Claude 還沒記結論'}`;
      return `${ago(st.ranAt)}${verb}${tail}`;
    }
    // 判斷算出這裡沒見過的狀態:照實講,不印空白、不印程式的值(規格:終端機與網頁說同一句 混沌推導)
    default: return '這一格的狀態讀不懂';
  }
}

/* ────────────── A 那格的清單(五關自動結案 AC-5):終端機一行一行印、網頁畫成可以收合的清單,字是這一份 ────────────── */

/** 規格檔的位置只給最後三段(docs/進行中/x.md);沒有位置就不加括號 */
const fileTag = (f) => (typeof f === 'string' && f ? `（${f.split('/').slice(-3).join('/')}）` : '');

/**
 * 清單上面那一句:好幾份規格的總數、找不到、讀不懂。讀得懂的一份回 null(清單本身就是答案)。
 * 一輪寫了好幾份:總數只加讀得到的,讀不到的講出來;「全部 N 條」只在一份的時候出現——只算一份卻長得像全部,
 * 就是 2026-10-02 那個「全部 5 條其實 15 條」(規格:多份規格與新資料夾的起點 AC-1、AC-2、AC-5)
 * @param headLen 讀不懂時附開頭幾個字:版面寬度不同(終端機 60、網頁 80)
 */
export function checklistHead(cl, { headLen = 60 } = {}) {
  if (cl?.multi) return `這一輪寫了 ${cl.parts.length} 份規格，共 ${cl.total} 條${cl.unreadable?.length ? `（另有 ${cl.unreadable.length} 份讀不到，條數不在裡面）` : ''}`;
  if (cl?.missing) return `清單：找不到這一輪的規格檔${fileTag(cl.file)}`;
  // 解析不了就照原文給開頭,不假裝解析成功(R1)
  if (!cl?.parsed) return `清單：規格檔裡沒有照格式寫的 AC${fileTag(cl?.file)}${cl?.head ? `，開頭是：${cl.head.slice(0, headLen)}` : ''}`;
  return null;
}

/** 好幾份規格裡的一份:讀得懂的講進度與這份幾條;讀不到的講找不到／讀不懂,帶檔名。不在這個工作區的那一份回 null(在哪、為什麼,旁白講了) */
export function checklistPartLine(p) {
  const c = p?.checklist;
  if (!c) return null;
  if (!c.parsed) return `${p.name}：${c.missing ? '找不到規格檔' : '規格檔裡沒有照格式寫的 AC'}${fileTag(c.file)}`;
  return `${p.name}：${clProg(c).replace(/^清單 /, '')}（這份 ${c.total} 條）`;
}

/** 網頁那格清單收合時的標題(一份、讀得懂才有)。分批做的規格整份照畫,標題講這一批只對哪幾條(施工對話認規格 AC-8)。終端機沒有這一行:進度印在 B 那一行 */
export function checklistTitle(cl) {
  if (!cl?.parsed || cl.multi) return null;
  return `驗收清單：${clProg(cl).replace(/^清單(這一批)? /, cl.batch ? '這一批 ' : '')}（全部 ${cl.allTotal ?? cl.total} 條${cl.batch ? `，這一批只對 ${cl.batch.join('、')}` : ''}）`;
}

/** 伺服器帶給網頁的那幾句(一格清單一包):上面那一句、收合的標題、為什麼還不算寫完、好幾份時每一份那一句(跟 cl.parts 同順序) */
export function checklistLines(cl) {
  return {
    head: checklistHead(cl, { headLen: 80 }),
    title: checklistTitle(cl),
    why: cl?.batchMissing?.length || cl?.preMarked ? checklistWhy(cl) : null,
    parts: cl?.multi ? cl.parts.map((p) => checklistPartLine(p)) : [],
  };
}
