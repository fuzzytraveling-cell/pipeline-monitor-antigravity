#!/bin/sh
# remind.sh —— 唯一會出聲的 hook。規格:分級(路徑看 CLAUDE.md 的表)
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

# 語言(規格:技能與寫給AI的話中英切換 AC-5):跟 lib/lang.mjs 讀同一個設定檔(資料的家底下的 lang.json,家怎麼找跟 hook.sh 同一條)。
# 只認 "en";沒有這個檔、讀不懂、寫了別的字,一律中文——跟 lib/lang.mjs「從來沒選過＝中文、讀不懂先用中文」同一條規則。
# 讀不懂不另外講:提醒只准一行(讀不懂那一句是儀表板與終端機的事)
UI_LANG=$(jq -r '.lang // empty' "${PIPELINE_MONITOR_HOME:-$HOME/.pipeline-monitor}/lang.json" 2>/dev/null)
if [ "$UI_LANG" = "en" ]; then
  printf '%s\n' "[Pipeline Monitor] This project hasn't set up tiers yet (.claude/pipeline-stages.json has no tiers). When you reply to the user's first message, just ask about it in one sentence, without interrupting their actual question, and only this once: if they want it, they say \"set up tiers\"; if they don't need it, they say \"this project doesn't need tiers\"."
else
  printf '%s\n' "[產線監視器] 這個專案還沒設定分級（.claude/pipeline-stages.json 沒有 tiers）。回覆使用者的第一句話時,順帶問一句就好,不要打斷他原本的問題,而且只提這一次:要的話說「幫我設定分級」,不需要的話說「這個專案不用分級」。"
fi
exit 0
