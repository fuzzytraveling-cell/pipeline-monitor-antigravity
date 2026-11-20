#!/bin/sh
# hook.sh —— Antigravity 感測器的熱路徑（PostToolUse）。規格:antigravity-v01-foundation（路徑看 AGENTS.md 的表）
#
# ⚠️ 第一守則是絕不干擾 Antigravity：
#    永遠輸出 {} 並 exit 0——不驗證、不重試、不印錯誤訊息、不回傳非零。
#    用 /bin/sh + jq 而不是 node，保持熱路徑精簡快速。
#
# ⚠️ 只記「呼叫過」，不記 error / success / duration_ms（R2：代理指標寫進去遲早被畫成綠勾）。
# ⚠️ 不過濾哪些 skill 算關卡，所有已安裝路徑下的 SKILL.md 全部照記（AC-6）；關卡清單只住 stages.json。
# ⚠️ 讀檔（read_file / view_file）只記技能檔，一般源碼與本 repo 開發中的 skills/*/SKILL.md 直接快速放行。

done_ok() {
  printf '{}\n'
  exit 0
}

DATA_HOME="${AGY_PIPELINE_HOME:-$HOME/.pipeline-monitor-agy}"
if [ -n "$AGY_PIPELINE_LOG_DIR" ]; then
  LOG_DIR="$AGY_PIPELINE_LOG_DIR"
else
  LOG_DIR="$DATA_HOME/logs"
fi
[ -d "$LOG_DIR" ] || (umask 077 && mkdir -p "$LOG_DIR") 2>/dev/null

PAYLOAD=$(cat)

# jq 不在就留一筆故障記號再走（AC-1：避免把感測器壞掉講成沒跑過）
if ! command -v jq >/dev/null 2>&1; then
  BROKEN=$(printf '{"ts":"%s","event":"sensor_broken","why":"jq 不存在"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
  { printf '%s\n' "$BROKEN" >> "$LOG_DIR/_sensor.jsonl"; } 2>/dev/null
  done_ok
fi

TOOL=$(printf '%s' "$PAYLOAD" | jq -r '.toolCall.name // empty' 2>/dev/null) || done_ok
[ -n "$TOOL" ] || done_ok

# 讀檔熱路徑快速過濾：只記已安裝位置或專案 .agents/.agent/.claude 底下的技能／指令檔，
# 避免一般源碼閱讀灌爆紀錄，也不會把開發本 repo 自己的 skills/*/SKILL.md 誤判成呼叫關卡。
case "$TOOL" in
  read_file|view_file)
    FILE=$(printf '%s' "$PAYLOAD" | jq -r '.toolCall.args.Path // .toolCall.args.TargetFile // .toolCall.args.AbsolutePath // empty' 2>/dev/null)
    case "$FILE" in
      */plugins/*/skills/*/SKILL.md|plugins/*/skills/*/SKILL.md|*/.gemini/config/skills/*/SKILL.md|.gemini/config/skills/*/SKILL.md|*/.agents/skills/*/SKILL.md|.agents/skills/*/SKILL.md|*/.agent/skills/*/SKILL.md|.agent/skills/*/SKILL.md|*/.claude/skills/*/SKILL.md|.claude/skills/*/SKILL.md|*/.claude/commands/*.md|.claude/commands/*.md) ;;
      *) done_ok ;;
    esac
    ;;
esac

CWD=$(printf '%s' "$PAYLOAD" | jq -r 'if (.cwd | type)=="string" and .cwd != "" then .cwd elif (.workspacePaths[0] | type)=="string" and .workspacePaths[0] != "" then .workspacePaths[0] else empty end' 2>/dev/null)
[ -n "$CWD" ] || CWD=$(pwd)

# 專案身分：worktree 會解析到主 repo 的 .git，所以同一個專案的 worktree 共用同一個紀錄檔。
COMMON=$(git -C "$CWD" rev-parse --git-common-dir 2>/dev/null)
TOP=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)
case "$COMMON" in
  "")   PROJECT="_不是git專案"; MAIN="$TOP" ;;
  /*)   MAIN=$(dirname "$COMMON"); PROJECT=$(basename "$MAIN") ;;
  *)    MAIN="$TOP"; PROJECT=$(basename "$TOP") ;;
esac

# 退出記號：優先認 .agents/pipeline-monitor.off，相容 .claude/pipeline-monitor.off。每次呼叫都看，馬上生效。
for d in "$CWD" "$TOP" "$MAIN"; do
  [ -n "$d" ] || continue
  [ -f "$d/.agents/pipeline-monitor.off" ] && done_ok
  [ -f "$d/.claude/pipeline-monitor.off" ] && done_ok
done

# ⚠️ LC_ALL=C：逐位元組替換，與 lib/events.mjs 的 safeName() 逐位元組一致（P2）。
PROJECT=$(printf '%s' "$PROJECT" | LC_ALL=C tr -c 'A-Za-z0-9._-' '_')
HEAD=$(git -C "$CWD" rev-parse --short HEAD 2>/dev/null)

# ⚠️ 單行必須 < 4096 bytes 保障 O_APPEND 原子性；只記路徑不記檔案內容；不記 error / success。
#    cut 照 UTF-8 bytes 截短，固定 12 圈二分法，絕不卡住熱路徑。
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
def skill_of($t; $f):
  if ($t == "read_file" or $t == "view_file") and ($f | type) == "string" then
    ([$f | capture("(?:^|/)plugins/(?<p>[^/]+)/skills/(?<s>[^/]+)/SKILL\\.md$")] | .[0] | if . then "\(.p):\(.s)" else null end)
    // ([$f | capture("(?:^|/)\\.(?:gemini/config|agents|agent|claude)/skills/(?<s>[^/]+)/SKILL\\.md$")] | .[0].s // null)
    // ([$f | capture("(?:^|/)\\.claude/commands/(?<s>[^/]+)\\.md$")] | .[0].s // null)
  else null end;
(.toolCall.name // null) as $tool |
(.toolCall.args // {}) as $args |
($args.Path // $args.TargetFile // $args.AbsolutePath // null) as $raw_file |
($raw_file | cut(500)) as $file |
(skill_of($tool; $raw_file) | cut(120)) as $skill |
(if $tool == "run_command" then (($args.CommandLine // null) | if type=="string" then
  gsub("//[^/@\\s]+@"; "//")
  | gsub("(?i)(?<p>(?:Bearer|Basic)[ \\t]+)[^ \\t\\n\"&]+"; "\(.p)[REDACTED]")
  | gsub("(?i)(?<k>[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|AUTH)[ \\t]*[=:][ \\t]*)[^ \\t\\n\"&]+"; "\(.k)[REDACTED]")
else . end | cut(200)) else null end) as $cmd |
(if $tool == "invoke_subagent" then ($args.TypeName // null | cut(80)) else null end) as $sub |
((.lastUserInput // null) | if type=="string" and . != "" then .[0:200] else null end) as $prompt |
{
  ts:            (now | todateiso8601),
  hook:          (.hookEventName // "PostToolUse"),
  session:       (.conversationId // null),
  cwd:           ((if (.cwd | type)=="string" and .cwd != "" then .cwd elif (.workspacePaths[0] | type)=="string" and .workspacePaths[0] != "" then .workspacePaths[0] else $cwd end) | cut(300)),
  head:          (if $head != "" then $head else null end),
  tool:          $tool,
  use_id:        (.toolCall.id // null),
  step:          (.stepIdx | if type=="number" then . else null end),
  file:          $file,
  skill:         $skill,
  subagent_type: $sub,
  cmd:           $cmd,
  url_host:      (([($args.Url // $args.url // $args.URL // "") | if type=="string" then . else "" end
                    | capture("^[a-zA-Z]+://(?<h>[^/?#]+)")] | .[0].h)
                    // (if $tool == "webview_browser" then
                          ([($args.script // $args.intention // "") | if type=="string" then . else "" end
                            | capture("https?://(?<h>[^/?#\"\u0027\\s\\\\]+)")] | .[0].h)
                        else null end)
                    | if type=="string" then sub("^[^@]+@"; "") else null end),
  prompt:        $prompt,
  transcript:    (.transcriptPath // null | cut(500))
} | with_entries(select(.value != null))'

{ printf '%s' "$PAYLOAD" | jq -c --arg head "${HEAD:-}" --arg cwd "$CWD" "$FILTER" >> "$LOG_DIR/$PROJECT.jsonl"; } 2>/dev/null

done_ok
