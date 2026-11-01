#!/usr/bin/env bash
# 全屏鲸鱼娘 APK：aapt2 + javac + d8 + zipalign + apksigner，无 Gradle。
set -euo pipefail
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${DSH_APK_TOOLCHAIN:-$HOME/.cache/dsh-apk}"
JAVA_HOME="$ROOT/jdk"
SDK="$ROOT/sdk"
BT_VERSION="${BT_VERSION:-34.0.0}"
BT="$SDK/build-tools/$BT_VERSION"
PLATFORM="$SDK/platforms/android-34/android.jar"
DEFAULT_URL="${DSH_DEFAULT_URL:-http://192.168.1.212:39100/}"
KS_PASS="${DSH_KS_PASS:-dshviewer}"
KS_ALIAS="${DSH_KS_ALIAS:-dsh}"
KS_FILE="$PROJECT/keystore/dsh.keystore"
APP_VERSION="1.0"
BUILD="$PROJECT/build"
DIST="$PROJECT/dist"

for tool in "$JAVA_HOME/bin/javac" "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$BT/aapt2"; do
  [ -x "$tool" ] || { echo "missing tool: $tool (run ../dsh-android-apk/tools/setup-toolchain.sh)" >&2; exit 1; }
done
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

rm -rf "$BUILD"; mkdir -p "$BUILD/classes" "$BUILD/dex" "$BUILD/src" "$DIST"

echo "== default url: $DEFAULT_URL"
sed "s|__DEFAULT_URL__|$DEFAULT_URL|" \
  "$PROJECT/app/src/com/dsh/petscreen/MainActivity.java" > "$BUILD/src/MainActivity.java"
grep -q '__DEFAULT_URL__' "$BUILD/src/MainActivity.java" && { echo "placeholder not substituted" >&2; exit 1; }

echo "== resources"
"$BT/aapt2" compile --dir "$PROJECT/app/res" -o "$BUILD/res.zip"
"$BT/aapt2" link -o "$BUILD/app-unsigned.apk" -I "$PLATFORM" \
  --manifest "$PROJECT/app/AndroidManifest.xml" -R "$BUILD/res.zip" \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code 1 --version-name "$APP_VERSION" --auto-add-overlay

echo "== javac"
javac -encoding UTF-8 -source 8 -target 8 -nowarn -classpath "$PLATFORM" \
  -d "$BUILD/classes" "$BUILD/src/MainActivity.java"

echo "== d8"
"$BT/d8" --lib "$PLATFORM" --min-api 24 --output "$BUILD/dex" \
  $(find "$BUILD/classes" -name '*.class')
(cd "$BUILD/dex" && zip -q -X "$BUILD/app-unsigned.apk" classes.dex)

echo "== zipalign"
"$BT/zipalign" -f -p 4 "$BUILD/app-unsigned.apk" "$BUILD/app-aligned.apk"

if [ ! -f "$KS_FILE" ]; then
  echo "== generate local keystore: $KS_FILE"
  mkdir -p "$(dirname "$KS_FILE")"
  "$JAVA_HOME/bin/keytool" -genkeypair -noprompt \
    -keystore "$KS_FILE" -alias "$KS_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=DSH Viewer, OU=Local, O=DSH, L=Local, ST=Local, C=CN" >/dev/null
fi
OUT="$DIST/WhaleScreen-$APP_VERSION.apk"
echo "== sign"
rm -f "$OUT" "$OUT.idsig"
"$BT/apksigner" sign --ks "$KS_FILE" --ks-key-alias "$KS_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true --v4-signing-enabled false \
  --out "$OUT" "$BUILD/app-aligned.apk"

echo "== verify"
"$BT/apksigner" verify --print-certs "$OUT" | head -2
"$BT/aapt2" dump badging "$OUT" | grep -E "^(package|launchable-activity|application-label|sdkVersion|targetSdkVersion)" || true
ls -lh "$OUT"
