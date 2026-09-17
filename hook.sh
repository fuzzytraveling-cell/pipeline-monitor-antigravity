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

MONITOR_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 紀錄住在這個 repo 的主資料夾,不管這支是從哪個 worktree 被呼叫的(lib/paths.mjs 有同一條規則)。
# worktree 的 .git 是一個檔案;是檔案才問 git,主資料夾那條路一毛都不花。
if [ -f "$MONITOR_DIR/.git" ]; then
  _C=$(git -C "$MONITOR_DIR" rev-parse --git-common-dir 2>/dev/null)
  case "$_C" in /*) MONITOR_DIR=$(dirname "$_C") ;; ?*) MONITOR_DIR=$(dirname "$MONITOR_DIR/$_C") ;; esac
fi
# 「家」跟紀錄位置都可以用環境變數換掉。這是**設定**不是測試專用後門——
# 測試要能在自己的暫存資料夾裡跑,而且真的有人會想把紀錄放別的地方。lib/paths.mjs 看同一個 PIPELINE_MONITOR_HOME。
MONITOR_DIR="${PIPELINE_MONITOR_HOME:-$MONITOR_DIR}"
LOG_DIR="${PIPELINE_MONITOR_LOG_DIR:-$MONITOR_DIR/logs}"
mkdir -p "$LOG_DIR" 2>/dev/null

PAYLOAD=$(cat)

# jq 不在就留一筆記號再走。
# ⚠️ AC-1:什麼都不留的話,讀取端會把「感測器壞了」看成「什麼都沒跑」——那是謊話。
if ! command -v jq >/dev/null 2>&1; then
  printf '{"ts":"%s","event":"sensor_broken","why":"jq 不存在"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG_DIR/_sensor.jsonl" 2>/dev/null
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
# ⚠️ app 建議卡(2026-09-17):Claude 在 app 裡叫「建議新開對話」的卡時,工具參數的 title／tldr／prompt／cwd 都記——
#    在 app 按叉叉那張卡就永久消失,儀表板要留得住。欄位叫 in_*(tool_input 的):title、prompt、cwd 這三個名字
#    已經是「對話標題」「使用者說的話」「對話在哪個資料夾」,混用的話讀取端會把對話改名成卡的標題。
#    cwd 是「這張卡要開在哪」——實測有一半的卡是開在別的專案,不記的話「已開始」永遠對不到。
#    這裡照舊**不認工具名**(AC-6):哪個工具算建議卡,讀取端說了算(lib/events.mjs 的 SUGGEST_TOOL)。
#    cut 照 **bytes** 截、不照字數:算的是寫進這一行之後佔幾個 bytes(中文 3、emoji 4、換行與引號 2、控制字元 6),
#    照字數截保證不了 AC-4。不是字串、或是空的 → null(不猜)。有被截的欄位記在 in_cut,畫面才標得出「已截短」。
#    二分法的圈數寫死(12 圈,2^12 比任何一個上限都大)、沒有「跑到條件成立為止」的迴圈——熱路徑不准有機會卡住(AC-2)。
#    上限是看過真的卡才訂的(2026-09-17):title、tldr、cwd 都留得全;prompt 常常比整行的上限還長,留不全是 AC-4 的代價。
#    四段同時截滿也要離 4096 有一段距離——這一行還有沒截的舊欄位(cwd、對話與工具的代號),它們吃的是同一個空間。
# ⚠️ Claude 收回建議卡時(2026-09-17 接),參數裡的 task_id 與 reason 也記(in_task／in_reason),同一個 cut、同一個 in_cut。
#    上限一樣看過真的才訂:task_id 是 13 個字、理由最長 235 bytes。六段全部截滿也要放得進一行(測試真的跑一次量)。
printf '%s' "$PAYLOAD" | jq -c --arg head "${HEAD:-}" '
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
(.tool_input.tldr   | cut(500))  as $l |
(.tool_input.prompt | cut(2000)) as $p |
(.tool_input.cwd    | cut(300))  as $w |
(.tool_input.task_id | cut(60))  as $k |
(.tool_input.reason | cut(300))  as $r |
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
  prompt:     ((.prompt // null)        | if type=="string"
                 then (gsub("<system-reminder>[\\s\\S]*?</system-reminder>\\s*"; "") | .[0:200]) else . end),
  title:      .session_title,
  in_title:   $t,
  in_tldr:    $l,
  in_prompt:  $p,
  in_cwd:     $w,
  in_task:    $k,
  in_reason:  $r,
  in_cut:     ([["title", $t, .tool_input.title], ["tldr", $l, .tool_input.tldr],
                ["prompt", $p, .tool_input.prompt], ["cwd", $w, .tool_input.cwd],
                ["task", $k, .tool_input.task_id], ["reason", $r, .tool_input.reason]]
                 | map(select(.[1] != null and .[1] != .[2]) | .[0]) | if length > 0 then . else null end)
} | with_entries(select(.value != null))' >> "$LOG_DIR/$PROJECT.jsonl" 2>/dev/null

exit 0
