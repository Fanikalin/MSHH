#!/usr/bin/env sh
# Установка MSHH одной командой (Linux; Arch — в приоритете):
#
#   curl -fsSL https://raw.githubusercontent.com/Fanikalin/MSHH/main/install.sh | sh
#
# Скрипт: ставит тулчейн (Arch — нативный `rust` из pacman, остальные — rustup),
# клонирует репозиторий, собирает release, кладёт бинарник в ~/.local/bin/mshh
# и модули в ~/.local/share/mshh/modules. Повторный запуск = обновление.
#
# Переопределение путей: MSHH_INSTALL_DIR, MSHH_BIN_DIR, MSHH_MODULES_DIR.
set -eu

REPO="https://github.com/Fanikalin/MSHH.git"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
SRC_DIR="${MSHH_INSTALL_DIR:-$DATA/mshh/src}"
BIN_DIR="${MSHH_BIN_DIR:-$HOME/.local/bin}"
MODULES_DIR="${MSHH_MODULES_DIR:-$DATA/mshh/modules}"

say() { printf '%s\n' "$*"; }

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

need_pkgs() {
  if command -v pacman >/dev/null 2>&1; then
    $SUDO pacman -S --needed --noconfirm -- "$@"
  elif command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y && $SUDO apt-get install -y -- "$@"
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y -- "$@"
  elif command -v zypper >/dev/null 2>&1; then
    $SUDO zypper --non-interactive install -- "$@"
  elif command -v apk >/dev/null 2>&1; then
    $SUDO apk add -- "$@"
  else
    say "!! Не найден известный пакетный менеджер. Установите вручную: $*"
    exit 1
  fi
}

install_toolchain() {
  if command -v pacman >/dev/null 2>&1; then
    say "==> Arch: нативный rust из репозитория"
    need_pkgs rust git
  else
    say "==> Системные зависимости сборки"
    if command -v apt-get >/dev/null 2>&1; then
      need_pkgs build-essential curl git ca-certificates
    elif command -v dnf >/dev/null 2>&1; then
      need_pkgs gcc gcc-c++ make curl git
    elif command -v zypper >/dev/null 2>&1; then
      need_pkgs gcc gcc-c++ make curl git
    elif command -v apk >/dev/null 2>&1; then
      need_pkgs build-base curl git
    fi
    say "==> rustup (минимальный профиль, stable)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi
}

if ! command -v cargo >/dev/null 2>&1; then
  install_toolchain
fi
command -v git >/dev/null 2>&1 || need_pkgs git

say "==> Исходники: $SRC_DIR"
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" pull --ff-only
elif [ -e "$SRC_DIR" ]; then
  say "!! $SRC_DIR существует, но это не клон MSHH."
  say "   Удалите его или задайте MSHH_INSTALL_DIR."
  exit 1
else
  git clone --depth 1 "$REPO" "$SRC_DIR"
fi

say "==> Сборка (release)"
( cd "$SRC_DIR" && cargo build --release -p mshh-core -p mshh-module-echo )

mkdir -p "$BIN_DIR" "$MODULES_DIR"
cp -f "$SRC_DIR/target/release/mshh" "$BIN_DIR/mshh"
chmod 755 "$BIN_DIR/mshh"
for so in "$SRC_DIR"/target/release/lib*.so; do
  [ -f "$so" ] && cp -f "$so" "$MODULES_DIR/"
done

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say "!! $BIN_DIR не в PATH. Добавьте в ~/.bashrc или ~/.zshrc:"
    say "   export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

say
say "Готово:"
say "  бинарник: $BIN_DIR/mshh"
say "  модули:   $MODULES_DIR"
say "Запуск: mshh  (--list — найденные модули, --headless — без TUI)"
