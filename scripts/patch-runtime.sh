#!/bin/sh
# Inject the Chinese translator into every installed t3code WSL runtime (web /
# in-app browser) and into the Windows desktop client's server.asar.
#
# Idempotent: safe to run any number of times. Runs from the systemd path unit
# whenever ~/.t3/wsl-runtime changes (i.e. after every T3 update).
#   patch-runtime.sh            patch all runtimes
#   patch-runtime.sh --remove   undo the patch everywhere
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)
RUNTIME_SRC="$HERE/runtime"
RUNTIME_PARENT="${T3ZH_RUNTIME_PARENT:-$HOME/.t3/wsl-runtime}"
MARK='data-t3zh-inject'
TAG='<script src="/t3zh/dict.js" data-t3zh-inject></script><script src="/t3zh/t3zh.js" data-t3zh-inject></script>'

NODE="${T3ZH_NODE:-$(command -v node || true)}"

# Windows desktop client: its window loads the UI from server.asar, not WSL.
if [ -n "$NODE" ]; then
  if [ "${1:-}" = "--remove" ]; then
    "$NODE" "$HERE/tools/patch-asar.mjs" --remove || true
  else
    "$NODE" "$HERE/tools/patch-asar.mjs" || true
  fi
else
  echo "node not found; skipped the Windows desktop client" >&2
fi

[ -d "$RUNTIME_PARENT" ] || exit 0

for runtime in "$RUNTIME_PARENT"/sha256-*; do
  # Only fully installed runtimes: T3 writes the ready marker last, so the
  # client files are complete. Skips half-extracted temp dirs.
  case "$(basename "$runtime")" in sha256-*[!0-9a-f]* | sha256-) continue ;; esac
  [ -f "$runtime/.t3code-wsl-runtime-ready" ] || continue
  client="$runtime/client"
  index="$client/index.html"
  [ -f "$index" ] || continue

  if [ "${1:-}" = "--remove" ]; then
    [ -L "$client/t3zh" ] && rm -f "$client/t3zh"
    if grep -q "$MARK" "$index"; then
      sed -i "/$MARK/d" "$index"
      echo "unpatched $runtime"
    fi
    continue
  fi

  # Symlink so dictionary edits go live on the next window reload.
  if [ ! -L "$client/t3zh" ] || [ "$(readlink "$client/t3zh")" != "$RUNTIME_SRC" ]; then
    rm -rf "$client/t3zh"
    ln -s "$RUNTIME_SRC" "$client/t3zh"
  fi

  if ! grep -q "$MARK" "$index"; then
    # Classic scripts at the top of <head> run before React's deferred module
    # script, so the observer is in place before the first render.
    tmp="$index.t3zh.$$"
    awk -v tag="    $TAG" '{ print } !done && /<meta charset/ { print tag; done = 1 }' "$index" >"$tmp"
    grep -q "$MARK" "$tmp" || awk -v tag="$TAG" '!done && /<\/head>/ { print tag; done = 1 } { print }' "$index" >"$tmp"
    cat "$tmp" >"$index" # keep inode/permissions
    rm -f "$tmp"
    echo "patched $runtime"
  fi
done
