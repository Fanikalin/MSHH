#!/usr/bin/env bash
# MSHH — установка одной командой (Omarchy / Arch / любой Linux с node+npm).
# Идемпотентна: можно перезапускать для обновления установленной версии.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

bold "==> MSHH: установка"

# --- зависимости окружения ---
command -v node >/dev/null || fail "не найден node. Установите: sudo pacman -S nodejs npm"
command -v npm >/dev/null || fail "не найден npm."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "нужен node >= 20, сейчас $(node -v)"

# --- сборка ---
cd "$REPO_DIR"
bold "==> npm install (может занять несколько минут)"
if [ -f package-lock.json ]; then
  npm ci --include=dev --no-audit --no-fund || npm install --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

bold "==> сборка интерфейса (vite build)"
npm run build

# --- лаунчер mshh ---
mkdir -p "$BIN_DIR"
ELECTRON_BIN="$REPO_DIR/node_modules/.bin/electron"
[ -x "$ELECTRON_BIN" ] || fail "бинарь electron не найден после npm install"
cat > "$BIN_DIR/mshh" << EOF
#!/bin/sh
# MSHH launcher (сгенерирован install.sh из $REPO_DIR)
exec "$ELECTRON_BIN" "$REPO_DIR" "\$@"
EOF
chmod +x "$BIN_DIR/mshh"

# --- иконка и .desktop ---
mkdir -p "$ICON_DIR" "$APPS_DIR"
if [ -f "$REPO_DIR/assets/mshh-icon.png" ]; then
  cp -f "$REPO_DIR/assets/mshh-icon.png" "$ICON_DIR/mshh.png"
fi
cat > "$APPS_DIR/mshh.desktop" << EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=MSHH
GenericName=Мессенджер
Comment=Мультипротокольный клиент: Telegram, WhatsApp, Matrix, XMPP, VK
Exec=$BIN_DIR/mshh
TryExec=$BIN_DIR/mshh
Icon=mshh
Terminal=false
Categories=Network;InstantMessaging;
StartupWMClass=MSHH
EOF

command -v update-desktop-database >/dev/null && update-desktop-database "$APPS_DIR" || true

bold "==> готово."
echo "  Запуск:        mshh   (или из меню приложений — MSHH)"
echo "  Обновление:    git -C $REPO_DIR pull && $REPO_DIR/install.sh"
echo "  Данные:        ~/.config/MSHH (профили и сессии)"
