#!/bin/sh
# Install the t3code Chinese UI patch (WSL side) and keep it applied across updates.
#   ./install.sh            install / reinstall
#   ./install.sh --remove   uninstall and restore T3's original files
set -eu
ROOT=$(cd "$(dirname "$0")" && pwd)
UNIT_DIR="$HOME/.config/systemd/user"

if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now t3zh-patch.path 2>/dev/null || true
  rm -f "$UNIT_DIR/t3zh-patch.path" "$UNIT_DIR/t3zh-patch.service"
  systemctl --user daemon-reload
  "$ROOT/scripts/patch-runtime.sh" --remove
  echo "已卸载。重新加载 T3 窗口（Ctrl+R）即恢复英文。"
  exit 0
fi

node "$ROOT/tools/build-dict.mjs"
mkdir -p "$UNIT_DIR"
cp "$ROOT/systemd/t3zh-patch.path" "$UNIT_DIR/"
sed "s#@ROOT@#$ROOT#g" "$ROOT/systemd/t3zh-patch.service.in" >"$UNIT_DIR/t3zh-patch.service"
systemctl --user daemon-reload
systemctl --user enable --now t3zh-patch.path
"$ROOT/scripts/patch-runtime.sh"
echo "已安装。在 T3 窗口按 Ctrl+R 重新加载即可看到中文；Ctrl+Alt+L 切换中/英。"
