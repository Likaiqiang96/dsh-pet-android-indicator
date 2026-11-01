#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .pid ]; then
  pid="$(cat .pid)"
  kill "$pid" 2>/dev/null || true
  rm -f .pid
  echo "已停止 (pid $pid)"
else
  pkill -f "dsh-pet-screen/server.mjs" 2>/dev/null || true
  echo "已尝试停止"
fi
