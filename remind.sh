#!/bin/sh
# remind.sh —— 唯一會出聲的 hook。規格:docs/進行中/分級.md
#
# 對話開始(SessionStart)時看一眼:是 git 專案、有在記錄、但**還沒設定分級** → 給 Claude 一行提示,
# 讓它回第一句話時順帶問「要不要設定分級」。就這樣,沒有第二件事。
#
# ⚠️ 它跟 hook.sh 的契約**相反**:hook.sh 永遠不出聲(AC-2),這支的全部意義就是出聲一次。
#    所以刻意分成兩支檔案——放在一起,遲早有人把「不出聲」改掉。
# ⚠️ 只在 startup／clear 出聲。resume／compact 不算新對話,再提就是狼來了。
# ⚠️ 最多一行、永遠 exit 0、任何失敗都安靜:它是提醒,不是門。

PAYLOAD=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
SRC=$(printf '%s' "$PAYLOAD" | jq -r '.source // "startup"' 2>/dev/null)
case "$SRC" in startup|clear) ;; *) exit 0 ;; esac

CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] || CWD=$(pwd)
TOP=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || exit 0
COMMON=$(git -C "$CWD" rev-parse --git-common-dir 2>/dev/null)
case "$COMMON" in /*) MAIN=$(dirname "$COMMON") ;; *) MAIN="$TOP" ;; esac

# 退出記錄的專案不提(它連記都不記了)
for d in "$CWD" "$TOP" "$MAIN"; do
  [ -f "$d/.claude/pipeline-monitor.off" ] && exit 0
done

# 設定檔裡有 tiers(設好了、或明講不分級)就不提;讀不懂的檔案也不提——那是儀表板的事,不該用提醒去碰
for d in "$TOP" "$MAIN"; do
  f="$d/.claude/pipeline-stages.json"
  [ -f "$f" ] || continue
  HAS=$(jq -r 'has("tiers")' "$f" 2>/dev/null) || exit 0
  [ "$HAS" = "true" ] && exit 0
done

printf '%s\n' "[產線監視器] 這個專案還沒設定分級（.claude/pipeline-stages.json 沒有 tiers）。回覆使用者的第一句話時,順帶問一句就好,不要打斷他原本的問題,而且只提這一次:要的話說「幫我設定分級」,不需要的話說「這個專案不用分級」。"
exit 0
