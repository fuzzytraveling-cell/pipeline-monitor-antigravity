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
LOG_DIR="$MONITOR_DIR/logs"
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
PROJECT=$(printf '%s' "$PROJECT" | tr -c 'A-Za-z0-9._-' '_')
HEAD=$(git -C "$CWD" rev-parse --short HEAD 2>/dev/null)

# ⚠️ AC-4:單行必須 < 4096 bytes,超過 O_APPEND 就不再保證原子性,
#    兩個 worktree 同時寫會交錯,兩筆都毀掉。所以每個字串欄位都截斷。
# ⚠️ AC-10:只記檔案路徑,不記內容(CCAM 就是這樣把資料庫養到 2GB 的)。
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
  prompt:     ((.prompt // null)        | if type=="string" then .[0:200] else . end),
  title:      .session_title
} | with_entries(select(.value != null))' >> "$LOG_DIR/$PROJECT.jsonl" 2>/dev/null

exit 0
