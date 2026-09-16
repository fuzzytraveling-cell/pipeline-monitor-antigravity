#!/bin/sh
# hook.sh —— 感測器的熱路徑。規格:<專案>/docs/進行中/pipeline-sensor.md
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
printf '%s' "$PAYLOAD" | jq -c --arg head "${HEAD:-}" '{
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
  title:      .session_title
} | with_entries(select(.value != null))' >> "$LOG_DIR/$PROJECT.jsonl" 2>/dev/null

exit 0
