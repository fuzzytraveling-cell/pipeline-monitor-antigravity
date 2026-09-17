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
  # 找不到 node 是 L13 那種安靜失效:能留記號就留(主資料夾才有 logs/;worktree 沒有就算了)
  [ -d "$DIR/logs" ] && printf '{"ts":"%s","event":"gate_broken","why":"找不到 node"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$DIR/logs/_sensor.jsonl" 2>/dev/null
  exit 0
fi
exec "$NODE" "$DIR/gate.mjs"
