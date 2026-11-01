#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-39100}"
if [ -f .pid ] && kill -0 "$(cat .pid)" 2>/dev/null; then
  echo "已在运行: $(cat url.txt 2>/dev/null || echo "http://127.0.0.1:$PORT/")"
  exit 0
fi
nohup env PORT="$PORT" node server.mjs > run.log 2>&1 &
echo $! > .pid
sleep 1
cat run.log
