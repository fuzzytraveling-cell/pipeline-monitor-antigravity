#!/bin/sh
# hook.sh —— 感測器的熱路徑。規格:pipeline-sensor(路徑看 CLAUDE.md 的表)
#
# ⚠️ 這支的第一守則是 **AC-2:絕不影響 Claude**。
#    所以它:不驗證、不重試、不輸出、不回傳非零。最後一行永遠是 exit 0。
#    用 /bin/sh + jq 而不是 node,是因為「最不能壞的那一段,
#    就該是沒有東西可以壞的那一段」——node 啟動要 ~40ms,這裡只要 ~10ms。
#
# ⚠️ AC-3:只記「跑過」。tool_response.success 與 duration_ms **刻意不取**——
#    前者只代表指令檔讀進來了,後者只是載入時間。寫進去遲早會被畫成綠勾。
#
# ⚠️ AC-6:這裡**不過濾哪些 skill 算關卡**,全部照記。
#    關卡清單只住在 stages.json 一個地方,由讀取端判斷。

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 紀錄住在固定的家 ~/.pipeline-monitor,跟這支程式住哪無關(規格:紀錄搬到固定的家;lib/paths.mjs 有同一條規則)。
# 別人從 marketplace 裝的時候,程式是一個版本一個資料夾、更新後舊的會被清掉——紀錄跟著程式住,就會跟著消失。
# 「家」跟紀錄位置都可以用環境變數換掉。這是**設定**不是測試專用後門——
# 測試要能在自己的暫存資料夾裡跑,而且真的有人會想把紀錄放別的地方。lib/paths.mjs 看同一個 PIPELINE_MONITOR_HOME。
DATA_HOME="${PIPELINE_MONITOR_HOME:-$HOME/.pipeline-monitor}"

# 這一筆寫去哪(lib/paths.mjs 的 pickDir 同一條規則,測試對兩邊的答案):
#   新家有就用新家。新家還沒有、舊的地方(這支程式所屬 repo 主資料夾的 logs/)是真的資料夾 → 還沒搬家,照舊寫舊的,
#   等 node 那一端整個搬過去——這裡先寫新家的話,就是兩邊各一半。都沒有 → 建新家(只給自己讀寫:紀錄裡有使用者打的字)。
#   ⚠️ 只有預設的家才看舊的地方:指定了家或紀錄位置(測試一律會)→ 舊的地方一律不碰——在 worktree 裡跑測試時,那裡是這台電腦真的紀錄。
#      家目錄被換掉了也不碰(real_home):新家落在暫存資料夾裡,這時候寫舊的、等著被搬,就是把真的紀錄往用完就丟的地方送。
#   舊的位置搬過之後是一個指向新家的捷徑(-L),不算舊家。主資料夾那條路不問 git;從 worktree 被呼叫、而且新家還沒有的時候才問。
#   這幾個判斷都只在新家還沒有的時候跑——搬過家之後,每次只多一個 [ -d ]。
# 家目錄是不是帳號真正的那一個(lib/paths.mjs 的 accountHome 同一條;比的是實體路徑)。
# PIPELINE_MONITOR_TEST_REAL_HOME 只給測試:假裝假的家目錄就是真的——只准配假的程式資料夾。
real_home() {
  _A=$PIPELINE_MONITOR_TEST_REAL_HOME
  if [ -z "$_A" ]; then
    _U=$(id -un 2>/dev/null)
    case "$_U" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
    eval "_A=~$_U"
  fi
  _H=$(cd "$HOME" 2>/dev/null && pwd -P) || return 1
  _R=$(cd "$_A" 2>/dev/null && pwd -P) || return 1
  [ -n "$_H" ] && [ "$_H" = "$_R" ]
}
pick_log_dir() {
  if [ -n "$PIPELINE_MONITOR_LOG_DIR" ]; then
    LOG_DIR=$PIPELINE_MONITOR_LOG_DIR
    [ -d "$LOG_DIR" ] || mkdir -p "$LOG_DIR" 2>/dev/null
    return 0
  fi
  LOG_DIR="$DATA_HOME/logs"
  [ -d "$LOG_DIR" ] && return 0
  if [ -z "$PIPELINE_MONITOR_HOME" ] && real_home; then
    _OLD=$SELF_DIR
    if [ -f "$_OLD/.git" ]; then
      _C=$(git -C "$_OLD" rev-parse --git-common-dir 2>/dev/null)
      case "$_C" in /*) _OLD=$(dirname "$_C") ;; ?*) _OLD=$(dirname "$_OLD/$_C") ;; esac
    fi
    if [ -d "$_OLD/logs" ] && [ ! -L "$_OLD/logs" ]; then LOG_DIR="$_OLD/logs"; return 0; fi
  fi
  (umask 077 && mkdir -p "$LOG_DIR") 2>/dev/null
  return 0
}
pick_log_dir

PAYLOAD=$(cat)

# jq 不在就留一筆記號再走。
# ⚠️ AC-1:什麼都不留的話,讀取端會把「感測器壞了」看成「什麼都沒跑」——那是謊話。
# 寫不進去(搬家那一刻)就重新看一次該寫哪裡、再寫一次,跟最下面那一筆同一個作法。
if ! command -v jq >/dev/null 2>&1; then
  BROKEN=$(printf '{"ts":"%s","event":"sensor_broken","why":"jq 不存在"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
  { printf '%s\n' "$BROKEN" >> "$LOG_DIR/_sensor.jsonl"; } 2>/dev/null || {
    pick_log_dir
    { printf '%s\n' "$BROKEN" >> "$LOG_DIR/_sensor.jsonl"; } 2>/dev/null
  }
  exit 0
fi

CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] || CWD=$(pwd)

# 專案身分:worktree 會解析到主 repo 的 .git,所以三個 worktree 算同一個專案(AC-4)。
COMMON=$(git -C "$CWD" rev-parse --git-common-dir 2>/dev/null)
case "$COMMON" in
  "")   PROJECT="_不是git專案" ;;
  /*)   PROJECT=$(basename "$(dirname "$COMMON")") ;;
  *)    PROJECT=$(basename "$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)") ;;
esac
# ⚠️ LC_ALL=C:讓 tr 逐**位元組**換,不受 hook 跑在哪種 locale 影響(UTF-8 下 BSD tr 會把中文當一個字)。
#    這條規則在 lib/events.mjs 的 safeName() 有一份逐位元組的 JS 翻譯——讀取端靠它找到這個檔案。
#    改這裡要一起改那邊;scripts/sensor.test.mjs 會真的跑這支,對兩邊的答案(誠實修補 C1)。
PROJECT=$(printf '%s' "$PROJECT" | LC_ALL=C tr -c 'A-Za-z0-9._-' '_')
HEAD=$(git -C "$CWD" rev-parse --short HEAD 2>/dev/null)

# 退出記號:專案根目錄(worktree 的話是主資料夾)底下有 .claude/pipeline-monitor.off 就不記。
# plugin 裝在使用者層級、每個專案都會跑,「不要記這個專案」只能靠這個檔案表達——
# 儀表板的「退出記錄」按鈕放的就是它。每次呼叫都看,所以按下去馬上生效,不用開新對話。
TOP=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)
case "$COMMON" in /*) MAIN=$(dirname "$COMMON") ;; *) MAIN="$TOP" ;; esac
for d in "$CWD" "$TOP" "$MAIN"; do
  [ -n "$d" ] && [ -f "$d/.claude/pipeline-monitor.off" ] && exit 0
done

# ⚠️ AC-4:單行必須 < 4096 bytes,超過 O_APPEND 就不再保證原子性,
#    兩個 worktree 同時寫會交錯,兩筆都毀掉。所以每個字串欄位都截斷。
# ⚠️ AC-10:只記檔案路徑,不記內容(CCAM 就是這樣把資料庫養到 2GB 的)。
# ⚠️ 瀏覽器工具只記**主機名**(url_host),不記整個網址:E 驗收要講得出「去了哪」,才分得出是在測專案還是在看儀表板。
# ⚠️ E3(2026-09-11):worktree 對話的第一則訊息前面會被系統附加一段 <system-reminder>…</system-reminder>,
#    截 200 字之後使用者打的字整個不見。先剝掉那段再截——記的是「使用者說了什麼」,不是系統塞了什麼。
# ⚠️ 同一個形狀第二次(2026-10-25,規格:建議卡開的對話認得出已開始):在 app 按建議卡開出來的對話,第一句話被 app 包一層
#    「Background (from the session that started this one):」＋背景說明＋「\n\nTask:\n」＋要貼的話。背景吃掉前 200 字,
#    要貼的話剩不到 60 字,儀表板就認不出這個對話是照卡開的。所以剝完系統提醒之後,再剝掉**開頭**那一層才截。
#    只認整段開頭(\A,不用 ^:有的 jq 版本 ^ 也認每一行的開頭)那一整句標頭;找不到「\n\nTask:\n」(格式變了)就整段照記,不剝、不猜。
#    有剝的那一筆記 prompt_wrap:"task"——那一句其實是別的對話寫的(老毛病 P7),讀取端之後要分辨才有證據;這裡照舊不判斷誰說的。
# ⚠️ app 建議卡(2026-09-17):Claude 在 app 裡叫「建議新開對話」的卡時,工具參數的 title／tldr／prompt／cwd 都記——
#    在 app 按叉叉那張卡就永久消失,儀表板要留得住。欄位叫 in_*(tool_input 的):title、prompt、cwd 這三個名字
#    已經是「對話標題」「使用者說的話」「對話在哪個資料夾」,混用的話讀取端會把對話改名成卡的標題。
#    cwd 是「這張卡要開在哪」——實測有一半的卡是開在別的專案,不記的話「已開始」永遠對不到。
#    這裡照舊**不認工具名**(AC-6):哪個工具算建議卡,讀取端說了算(lib/rounds.mjs 的 SUGGEST_TOOLS)。
#    cut 照 **bytes** 截、不照字數:算的是寫進這一行之後佔幾個 bytes(中文 3、emoji 4、換行與引號 2、控制字元 6),
#    照字數截保證不了 AC-4。不是字串、或是空的 → null(不猜)。有被截的欄位記在 in_cut,畫面才標得出「已截短」。
#    二分法的圈數寫死(12 圈,2^12 比任何一個上限都大)、沒有「跑到條件成立為止」的迴圈——熱路徑不准有機會卡住(AC-2)。
#    上限是看過真的卡才訂的(2026-09-17):title、tldr、cwd 都留得全;prompt 常常比整行的上限還長,留不全是 AC-4 的代價。
#    四段同時截滿也要離 4096 有一段距離——這一行還有沒截的舊欄位(cwd、對話與工具的代號),它們吃的是同一個空間。
# ⚠️ Claude 收回建議卡時(2026-09-17 接),參數裡的 task_id 與 reason 也記(in_task／in_reason),同一個 cut、同一個 in_cut。
#    上限一樣看過真的才訂:task_id 是 13 個字、理由最長 235 bytes。六段全部截滿也要放得進一行(測試真的跑一次量)。
# ⚠️ app 換了做卡的工具(2026-10-25,規格:app建議卡換工具):新工具多帶 initiation(哪一種叫法)與 proposal_id(照哪一張開的),
#    記成 in_init／in_proposal,同一個 cut、同一個 in_cut。新工具的「背景說明」(background)放進 tldr 那一格——
#    兩個工具不會同時帶,所以最胖的一行不變胖;tldr 有的話照舊取 tldr。這裡照舊不認工具名。
FILTER='
def cut($max):
  if type != "string" or . == "" then null else
    .[0:$max] as $s
    | if ($s | tojson | utf8bytelength) <= $max then $s else
        reduce range(0; 12) as $_ ({lo: 0, hi: ($s | length)};
          if .lo >= .hi then . else
            ((.lo + .hi + 1) / 2 | floor) as $m
            | if ($s[0:$m] | tojson | utf8bytelength) <= $max then .lo = $m else .hi = $m - 1 end
          end)
        | $s[0:.lo]
      end
  end;
(.tool_input.title  | cut(200))  as $t |
(.tool_input.tldr // .tool_input.background | cut(500)) as $l |
(.tool_input.prompt | cut(2000)) as $p |
(.tool_input.cwd    | cut(300))  as $w |
(.tool_input.task_id | cut(60))  as $k |
(.tool_input.reason | cut(300))  as $r |
(.tool_input.initiation  | cut(40)) as $i |
(.tool_input.proposal_id | cut(80)) as $o |
((.prompt // null) | if type=="string"
   then gsub("<system-reminder>[\\s\\S]*?</system-reminder>\\s*"; "") else . end) as $said |
($said | if type=="string"
   then sub("\\ABackground \\(from the session that started this one\\):\\n[\\s\\S]*?\\n\\nTask:\\n"; "") else . end) as $task |
{
  ts:        (now | todateiso8601),
  hook:       .hook_event_name,
  session:    .session_id,
  prompt_id:  .prompt_id,
  cwd:        .cwd,
  head:       $head,
  tool:       .tool_name,
  skill:      (.tool_input.skill // null),
  use_id:     .tool_use_id,
  args:       ((.tool_input.args // null) | if type=="string" then .[0:200] else . end),
  file:       (.tool_input.file_path // .tool_input.notebook_path // null),
  url_host:   ([(.tool_input.url // "") | if type=="string" then . else "" end
                 | capture("^[a-zA-Z]+://(?<h>[^/?#]+)")] | .[0].h // null),
  prompt:     ($task | if type=="string" then .[0:200] else . end),
  prompt_wrap: (if $task != $said then "task" else null end),
  title:      .session_title,
  in_title:   $t,
  in_tldr:    $l,
  in_prompt:  $p,
  in_cwd:     $w,
  in_task:    $k,
  in_reason:  $r,
  in_init:    $i,
  in_proposal: $o,
  in_cut:     ([["title", $t, .tool_input.title], ["tldr", $l, (.tool_input.tldr // .tool_input.background)],
                ["prompt", $p, .tool_input.prompt], ["cwd", $w, .tool_input.cwd],
                ["task", $k, .tool_input.task_id], ["reason", $r, .tool_input.reason],
                ["init", $i, .tool_input.initiation], ["proposal", $o, .tool_input.proposal_id]]
                 | map(select(.[1] != null and .[1] != .[2]) | .[0]) | if length > 0 then . else null end)
} | with_entries(select(.value != null))'

# 寫進去。打不開(搬家那一刻:舊的資料夾剛被改名、指向新家的捷徑還沒放好)就重新看一次該寫哪裡、再寫一次——
# 一筆都不准掉(規格:紀錄搬到固定的家 AC-4)。錯誤訊息整組丟掉:打不開檔案時 shell 會自己印一行,而這支永遠不准出聲。
{ printf '%s' "$PAYLOAD" | jq -c --arg head "${HEAD:-}" "$FILTER" >> "$LOG_DIR/$PROJECT.jsonl"; } 2>/dev/null || {
  pick_log_dir
  { printf '%s' "$PAYLOAD" | jq -c --arg head "${HEAD:-}" "$FILTER" >> "$LOG_DIR/$PROJECT.jsonl"; } 2>/dev/null
}

exit 0
