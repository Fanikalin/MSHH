#!/usr/bin/env sh
# Установка MSHH одной командой (Linux; Arch — в приоритете):
#
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/Fanikalin/MSHH/main/install.sh)"
#
# (голый `curl ... | sh` тоже работает — скрипт пересоздаёт себя во temp-файл)
#
# Скрипт: ставит тулчейн (Arch — нативный `rust` из pacman, Bazzite и другие
# атомарные Fedora — сборка в контейнере distrobox, остальные — rustup),
# клонирует репозиторий, собирает release, кладёт бинарник в ~/.local/bin/mshh
# и модули в ~/.local/share/mshh/modules. Повторный запуск = обновление.
#
# Переопределение путей: MSHH_INSTALL_DIR, MSHH_BIN_DIR, MSHH_MODULES_DIR.
set -eu

RAW_URL="https://raw.githubusercontent.com/Fanikalin/MSHH/main/install.sh"

# Защита от `curl URL | sh`: шелл читает скрипт из пайпа лениво, а порождённые
# процессы (brew, git, rustup) наследуют тот же stdin и воруют непрочитанный
# остаток скрипта. Если stdin — пайп, перекачиваем скрипт в файл и исполняем его.
if [ -p /proc/$$/fd/0 ] 2>/dev/null && command -v curl >/dev/null 2>&1; then
  tmp="$(mktemp "${TMPDIR:-/tmp}/mshh-install.XXXXXX")"
  curl -fsSL "$RAW_URL" -o "$tmp"
  exec sh "$tmp" </dev/null
fi

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

# Bazzite и другие атомарные Fedora (Silverblue, Bluefin): хост immutable,
# без gcc и crt1.o — тулчейн на хост не ставим. Сборка идёт в контейнере
# distrobox (на Bazzite предустановлен): $HOME общий, glibc бокса не выше
# хостовой, поэтому бинарник запускается на хосте. Без rpm-ostree и перезагрузки.
is_bazzite() {
  grep -qi '^ID=bazzite' /etc/os-release 2>/dev/null && return 0
  [ -e /run/ostree-booted ] && grep -qi '^ID_LIKE=.*fedora' /etc/os-release 2>/dev/null
}

BOX_NAME="${MSHH_BOX:-mshh-build}"
BOX_IMAGE="${MSHH_BOX_IMAGE:-ubuntu:24.04}"

prepare_build_box() {
  command -v distrobox >/dev/null 2>&1 || {
    say "!! distrobox не найден. На Bazzite он предустановлен;"
    say "   на других атомарных Fedora: flatpak install --system com.github.89luca89.distrobox"
    exit 1
  }
  if ! distrobox list --no-color 2>/dev/null | grep -qw "$BOX_NAME"; then
    say "==> Создаём сборочный контейнер distrobox: $BOX_NAME ($BOX_IMAGE)"
    distrobox create --name "$BOX_NAME" --image "$BOX_IMAGE" --yes
  fi
  say "==> Тулчейн внутри $BOX_NAME"
  # cargo может прийти из общего $HOME (rustup хоста) — он работает в боксе;
  # но cc/линкер нужны именно контейнерные, хостовый /usr/bin внутри не виден.
  distrobox enter --name "$BOX_NAME" -- bash -euc '
    if ! command -v cc >/dev/null 2>&1; then
      if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        sudo apt-get update -y
        sudo apt-get install -y build-essential curl git ca-certificates
      elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y gcc gcc-c++ make curl git
      elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --needed --noconfirm base-devel curl git
      else
        echo "!! В контейнере нет известного пакетного менеджера" >&2
        exit 1
      fi
    fi
    command -v cargo >/dev/null 2>&1 || {
      curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
    }
    command -v cc >/dev/null 2>&1 || { echo "!! В контейнере нет cc" >&2; exit 1; }
  '
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

if is_bazzite; then
  prepare_build_box
else
  if ! command -v cargo >/dev/null 2>&1; then
    install_toolchain
  fi
  command -v git >/dev/null 2>&1 || need_pkgs git
fi

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
if is_bazzite; then
  MSHH_SRC_DIR="$SRC_DIR" distrobox enter --name "$BOX_NAME" -- bash -euc '
    export PATH="$HOME/.cargo/bin:$PATH"
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    command -v cargo >/dev/null 2>&1 || { echo "!! cargo недоступен внутри контейнера" >&2; exit 1; }
    cd "$MSHH_SRC_DIR"
    cargo build --release -p mshh-core -p mshh-module-echo
  '
else
  ( cd "$SRC_DIR" && cargo build --release -p mshh-core -p mshh-module-echo )
fi

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
