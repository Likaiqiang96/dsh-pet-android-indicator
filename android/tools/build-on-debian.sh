#!/usr/bin/env bash
# 在 Debian 高性能机上编译 APK，NUC 只负责 rsync + adb 安装。
set -euo pipefail
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEBIAN_HOST:-debian}"
REMOTE="${DEBIAN_BUILD_DIR:-/tmp/dsh-pet-build/android}"
TOOLCHAIN="${DEBIAN_TOOLCHAIN:-/home/kaiqiang/.cache/dsh-apk}"
URL="${DSH_DEFAULT_URL:-$(cat "$PROJECT/../url.txt" 2>/dev/null || true)}"
[ -n "$URL" ] || { echo "missing DSH_DEFAULT_URL / ../url.txt" >&2; exit 1; }

ssh "$HOST" "test -x $TOOLCHAIN/jdk/bin/javac && test -x $TOOLCHAIN/sdk/build-tools/34.0.0/aapt2" \
  || { echo "Debian toolchain missing at $TOOLCHAIN" >&2; exit 1; }

echo "== rsync to $HOST:$REMOTE"
ssh "$HOST" "mkdir -p $REMOTE"
rsync -a --delete --exclude build --exclude dist "$PROJECT/" "$HOST:$REMOTE/"

echo "== build on $HOST"
ssh "$HOST" "cd $REMOTE && DSH_APK_TOOLCHAIN='$TOOLCHAIN' DSH_DEFAULT_URL='$URL' ./tools/build.sh"

mkdir -p "$PROJECT/dist"
scp -q "$HOST:$REMOTE/dist/WhaleScreen-1.0.apk" "$PROJECT/dist/WhaleScreen-1.0.apk"
ls -lh "$PROJECT/dist/WhaleScreen-1.0.apk"
