#!/bin/sh
# guard.sh —— Antigravity 改檔前把關（PreToolUse）的殼。規格:danger-guard-force-ask（路徑看 AGENTS.md 的表）
#
# 判斷住在 guard.mjs（node）：這支只找 node 並把 stdin 原封不動交給 guard.mjs；
# 找不到 node 就留一筆 guard_broken 記號，什麼都不印（0 bytes stdout）並安靜放行（exit 0）。
# ⚠️ PreToolUse 契約（階段 0 實測確認）：不可印出 {} 或其他非決定 JSON——空輸出＋exit 0 才交回 Antigravity 預設權限。

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE=$(command -v node 2>/dev/null)
if [ -z "$NODE" ]; then
  # hook 跑的 shell 不一定載了 nvm：常見位置找一輪
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  if [ -n "$AGY_PIPELINE_LOG_DIR" ]; then
    LOGS="$AGY_PIPELINE_LOG_DIR"
  else
    LOGS="${AGY_PIPELINE_HOME:-$HOME/.pipeline-monitor-agy}/logs"
  fi
  [ -d "$LOGS" ] || (umask 077 && mkdir -p "$LOGS") 2>/dev/null
  [ -d "$LOGS" ] && printf '{"ts":"%s","event":"guard_broken","why":"找不到 node"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOGS/_sensor.jsonl" 2>/dev/null
  exit 0
fi
exec "$NODE" "$DIR/guard.mjs"
