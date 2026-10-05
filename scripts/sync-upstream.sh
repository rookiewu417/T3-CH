#!/bin/sh
# After T3 updates: fetch the matching t3code source, re-extract UI strings and
# list what the dictionary is missing.
#   scripts/sync-upstream.sh            use the installed runtime's version
#   scripts/sync-upstream.sh v0.0.46    a specific tag
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="${T3ZH_SRC:-$HOME/.cache/t3zh/t3code-src}"
REPO="https://github.com/pingdotgg/t3code"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  # Newest installed runtime = the one T3 is using after an update.
  runtime=$(ls -td "$HOME"/.t3/wsl-runtime/sha256-* 2>/dev/null | head -1)
  [ -n "$runtime" ] || { echo "找不到 ~/.t3/wsl-runtime，请手动指定版本，如 v0.0.46" >&2; exit 1; }
  VERSION=$("$runtime/t3" --version 2>/dev/null | grep -o 'v[0-9][0-9A-Za-z.+-]*' | tail -1)
fi
echo "t3code 版本: $VERSION"

if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$(dirname "$SRC")"
  git clone --quiet --depth 1 --branch "$VERSION" "$REPO" "$SRC"
else
  git -C "$SRC" fetch --quiet --depth 1 origin tag "$VERSION"
  git -C "$SRC" checkout --quiet "$VERSION"
fi

mkdir -p "$ROOT/extracted"
node "$ROOT/tools/extract-strings.mjs" "$SRC" "$ROOT/extracted/$VERSION.json"
cp "$ROOT/extracted/$VERSION.json" "$ROOT/extracted/latest.json"
node "$ROOT/tools/check-dict.mjs" "$ROOT/extracted/$VERSION.json" --src "$SRC" --json "$ROOT/extracted/missing.json"
echo "缺失条目已写入 extracted/missing.json。翻译后放进 dict/zh-CN/*.json，"
echo "不需要翻译的（品牌名、命令、示例）加入 dict/keep-en.json，然后运行: node tools/build-dict.mjs"
