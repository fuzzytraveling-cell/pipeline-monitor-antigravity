#!/bin/sh
# gate.sh —— Antigravity 收工 hook（Stop）的殼。規格:antigravity-v01-foundation（路徑看 AGENTS.md 的表）
#
# 判斷住在 gate.mjs（node）：這支只找 node 並把 stdin 原封不動交給 gate.mjs；
# 找不到 node 就留一筆 gate_broken 記號，輸出 {} 並安靜放行（exit 0）。

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
  [ -d "$LOGS" ] && printf '{"ts":"%s","event":"gate_broken","why":"找不到 node"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOGS/_sensor.jsonl" 2>/dev/null
  printf '{}\n'
  exit 0
fi
exec "$NODE" "$DIR/gate.mjs"
