#!/bin/sh
# remind.sh —— Antigravity SessionStart 分級提醒 hook。規格:antigravity-v01-foundation（路徑看 AGENTS.md 的表）
#
# 對話開始（SessionStart）時看一眼：是 git 專案、有在記錄、不是 subagent、但還沒設定分級
# → 依 Antigravity SessionStart 契約回傳 {"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}。
# 其餘所有情況（含失敗、缺 jq）一律回傳 {} 並 exit 0：它是提醒，不是門。

done_ok() {
  printf '{}\n'
  exit 0
}

PAYLOAD=$(cat)
command -v jq >/dev/null 2>&1 || done_ok

# subagent（transcript step 0 為 SYSTEM_MESSAGE 含 sender=）不打擾
TP=$(printf '%s' "$PAYLOAD" | jq -r '.transcriptPath // empty' 2>/dev/null)
if [ -n "$TP" ] && [ -f "$TP" ]; then
  FIRST=$(head -n 1 "$TP" 2>/dev/null)
  case "$FIRST" in
    *'"SYSTEM_MESSAGE"'*'sender='*) done_ok ;;
  esac
fi

CWD=$(printf '%s' "$PAYLOAD" | jq -r 'if (.cwd | type)=="string" and .cwd != "" then .cwd elif (.workspacePaths[0] | type)=="string" and .workspacePaths[0] != "" then .workspacePaths[0] else empty end' 2>/dev/null)
[ -n "$CWD" ] || CWD=$(pwd)
TOP=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || done_ok
COMMON=$(git -C "$CWD" rev-parse --git-common-dir 2>/dev/null)
case "$COMMON" in /*) MAIN=$(dirname "$COMMON") ;; *) MAIN="$TOP" ;; esac

# 退出記錄的專案不提（優先 .agents/，相容 .claude/）
for d in "$CWD" "$TOP" "$MAIN"; do
  [ -n "$d" ] || continue
  [ -f "$d/.agents/pipeline-monitor.off" ] && done_ok
  [ -f "$d/.claude/pipeline-monitor.off" ] && done_ok
done

# 與 lib/rounds.mjs readProjectConfig 同一個停止規則（P2）：依序找到的第一份設定檔說了算；
# 有 tiers（設好了、或明講不分級）就不提；讀不懂也不提（交給看板與終端機講）
FOUND_CFG=""
for d in "$TOP" "$MAIN"; do
  [ -n "$d" ] || continue
  for rel in ".agents/pipeline-stages.json" ".claude/pipeline-stages.json"; do
    f="$d/$rel"
    if [ -f "$f" ]; then
      FOUND_CFG="$f"
      break 2
    fi
  done
done
if [ -n "$FOUND_CFG" ]; then
  HAS=$(jq -r 'has("tiers")' "$FOUND_CFG" 2>/dev/null) || done_ok
  [ "$HAS" = "true" ] && done_ok
fi

# 語言跟 lib/lang.mjs 讀同一個設定檔（資料的家底下的 lang.json），只認 "en"，其餘中文
DATA_HOME="${AGY_PIPELINE_HOME:-$HOME/.pipeline-monitor-agy}"
UI_LANG=$(jq -r '.lang // empty' "$DATA_HOME/lang.json" 2>/dev/null)
if [ "$UI_LANG" = "en" ]; then
  MSG='[Pipeline Monitor] This project hasn'\''t set up tiers yet (.agents/pipeline-stages.json has no tiers). When you reply to the user'\''s first message, just ask about it in one sentence, without interrupting their actual question, and only this once: if they want it, they say "set up tiers"; if they don'\''t need it, they say "this project doesn'\''t need tiers".'
else
  MSG='[產線監視器] 這個專案還沒設定分級（.agents/pipeline-stages.json 沒有 tiers）。回覆使用者的第一句話時，順帶問一句就好，不要打斷他原本的問題，而且只提這一次：要的話說「幫我設定分級」，不需要的話說「這個專案不用分級」。'
fi

jq -nc --arg m "$MSG" '{"injectSteps":[{"systemMessage":{"systemMessage":$m}}]}' 2>/dev/null || printf '{}\n'
exit 0
