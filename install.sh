#!/bin/sh
# Install the t3code Chinese UI patch (WSL side) and keep it applied across updates.
#   ./install.sh            install / reinstall
#   ./install.sh --remove   uninstall and restore T3's original files
set -eu
ROOT=$(cd "$(dirname "$0")" && pwd)
UNIT_DIR="$HOME/.config/systemd/user"

if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now t3zh-patch.path t3zh-patch.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/t3zh-patch.path" "$UNIT_DIR/t3zh-patch.timer" "$UNIT_DIR/t3zh-patch.service"
  systemctl --user daemon-reload
  "$ROOT/scripts/patch-runtime.sh" --remove
  echo "已卸载。重新打开 T3 Code 即恢复英文。"
  exit 0
fi

node "$ROOT/tools/build-dict.mjs"
mkdir -p "$UNIT_DIR"
cp "$ROOT/systemd/t3zh-patch.path" "$ROOT/systemd/t3zh-patch.timer" "$UNIT_DIR/"
sed -e "s#@ROOT@#$ROOT#g" -e "s#@NODE@#$(command -v node)#g" "$ROOT/systemd/t3zh-patch.service.in" >"$UNIT_DIR/t3zh-patch.service"
systemctl --user daemon-reload
systemctl --user enable --now t3zh-patch.path t3zh-patch.timer
"$ROOT/scripts/patch-runtime.sh"
echo "已安装。完全退出并重新打开 T3 Code 即可看到中文；Ctrl+Alt+L 切换中/英。"
