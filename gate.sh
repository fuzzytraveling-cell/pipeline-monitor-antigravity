#!/bin/sh
# gate.sh —— 收工 hook(Stop)的殼。規格:五關自動結案(路徑看 CLAUDE.md 的表)
#
# 判斷住在 gate.mjs(node):它要讀分級、git、紀錄,用 sh 寫會變成第二份實作(老毛病 P2)。
# 這支只做一件事:找到 node 就把 stdin 原封不動交給 gate.mjs;找不到就**安靜放行**。
#
# ⚠️ 契約跟前兩支都不同:hook.sh 永遠不出聲、remind.sh 只在對話開始出一行、
#    這支只在「這次改動的分級要求的關還沒跑」時出聲一次。任何失敗一律放行(exit 0)——
#    hook 壞了不准讓人下不了班;壞掉的事實由 gate.mjs 記進 logs/_sensor.jsonl。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE=$(command -v node 2>/dev/null)
if [ -z "$NODE" ]; then
  # hook 跑的 shell 不一定載了 nvm:常見位置找一輪
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  # 找不到 node 是 L13 那種安靜失效:能留記號就留。留在哪跟 hook.sh 同一條規則(lib/paths.mjs 的 pickDir):
  # 新家有就新家;新家還沒有、還沒搬家 → 舊的地方。簡化兩處:這裡不建資料夾(建家是感測器的事),
  # 舊的地方只看這支自己的資料夾(主資料夾才有 logs/;從 worktree 被叫就算了,跟以前一樣)。
  if [ -n "$PIPELINE_MONITOR_LOG_DIR" ]; then
    LOGS=$PIPELINE_MONITOR_LOG_DIR
  else
    LOGS="${PIPELINE_MONITOR_HOME:-$HOME/.pipeline-monitor}/logs"
    # 家目錄被換掉了就不看舊的地方(hook.sh 的 real_home 同一條,這裡只比實體路徑、不另外處理測試用的變數以外的情況)
    _A=$PIPELINE_MONITOR_TEST_REAL_HOME
    if [ -z "$_A" ]; then _U=$(id -un 2>/dev/null); case "$_U" in ''|*[!A-Za-z0-9._-]*) _A= ;; *) eval "_A=~$_U" ;; esac; fi
    _H=$(cd "$HOME" 2>/dev/null && pwd -P); _R=$( [ -n "$_A" ] && cd "$_A" 2>/dev/null && pwd -P)
    if [ ! -d "$LOGS" ] && [ -z "$PIPELINE_MONITOR_HOME" ] && [ -n "$_H" ] && [ "$_H" = "$_R" ] && [ -d "$DIR/logs" ] && [ ! -L "$DIR/logs" ]; then LOGS="$DIR/logs"; fi
  fi
  [ -d "$LOGS" ] && printf '{"ts":"%s","event":"gate_broken","why":"找不到 node"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOGS/_sensor.jsonl" 2>/dev/null
  exit 0
fi
exec "$NODE" "$DIR/gate.mjs"
