#!/usr/bin/env bash
# MSHH — установщик для Omarchy (Arch Linux, Wayland).
#
# Режимы:
#   (по умолчанию)      установить/обновить последний релиз с GitHub Releases
#   --from-source       собрать из исходников (текущего клона или GitHub) и установить
#   --uninstall         удалить MSHH
#
# Переменные окружения:
#   MSHH_DIR       каталог установки (по умолчанию /opt/mshh)
#   MSHH_VERSION   конкретный релиз для установки, например v1.2.3
set -euo pipefail

REPO="Fanikalin/MSHH"
TARBALL="mshh-linux-x64.tar.gz"
APP_SUBDIR="mshh-linux-x64"

MSHH_DIR="${MSHH_DIR:-/opt/mshh}"
MSHH_VERSION="${MSHH_VERSION:-}"
BIN_DIR="${MSHH_BIN_DIR:-/usr/local/bin}"
DESKTOP_DIR="${MSHH_DESKTOP_DIR:-/usr/share/applications}"
ICON_DIR="${MSHH_ICON_DIR:-/usr/share/icons/hicolor/scalable/apps}"

APP_DIR="$MSHH_DIR/$APP_SUBDIR"
LAUNCHER="$BIN_DIR/mshh"
DESKTOP_FILE="$DESKTOP_DIR/mshh.desktop"
ICON_FILE="$ICON_DIR/mshh.svg"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || SCRIPT_DIR="$PWD"
TEMPLATE_REF="" # ref репозитория для загрузки шаблонов packaging/ (режим релиза)
SRC_DIR=""      # каталог исходников в режиме --from-source
TMP=""

info() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m==> ОШИБКА:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<EOF
MSHH — установщик (Omarchy / Arch Linux)

Использование:
  install.sh                установить или обновить последний релиз с GitHub
  install.sh --from-source  собрать из исходников и установить
  install.sh --uninstall    удалить MSHH
  install.sh --help         эта справка

Переменные окружения:
  MSHH_DIR      каталог установки (по умолчанию /opt/mshh)
  MSHH_VERSION  установить конкретный релиз, например v1.2.3
EOF
}

need() { command -v "$1" >/dev/null 2>&1 || die "Не найдена утилита «$1». Установите её и повторите."; }

can_write_in() { # can_write_in <dir> — true, если dir (или ближайший существующий предок) доступен на запись
	local d="$1"
	while [ ! -d "$d" ]; do
		d="$(dirname "$d")"
		[ "$d" = "/" ] && break
	done
	[ -w "$d" ]
}

as_root() { # as_root <целевой каталог> <команда...> — sudo только если цель недоступна без прав root
	local target="$1"
	shift
	if [ "$(id -u)" -eq 0 ] || can_write_in "$target"; then "$@"; else sudo "$@"; fi
}

fetch() { # fetch <url> <файл назначения>
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$1" -o "$2"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$2" "$1"
	else
		die "Нужен curl или wget для загрузки файлов."
	fi
}

latest_tag() { # тег последнего релиза с GitHub API (без jq)
	local tag
	tag="$(
		curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
			awk -F'"' '/"tag_name"/ {print $4; exit}'
	)" || return 1
	[ -n "$tag" ] || return 1
	printf '%s' "$tag"
}

template() { # template <имя файла> -> путь к шаблону packaging/
	local name="$1" dir out
	for dir in "$SCRIPT_DIR" "$SRC_DIR"; do
		if [ -n "$dir" ] && [ -f "$dir/packaging/$name" ]; then
			printf '%s' "$dir/packaging/$name"
			return 0
		fi
	done
	if [ -n "$TEMPLATE_REF" ]; then
		out="$TMP/$name"
		fetch "https://raw.githubusercontent.com/$REPO/$TEMPLATE_REF/packaging/$name" "$out"
		printf '%s' "$out"
		return 0
	fi
	die "Не найден шаблон packaging/$name: запустите установщик из клона репозитория или укажите релиз."
}

install_app() { # install_app <каталог со собранным приложением>
	local src="$1"
	need install

	info "Установка приложения в $APP_DIR..."
	as_root "$MSHH_DIR" mkdir -p "$MSHH_DIR"
	as_root "$MSHH_DIR" rm -rf "$APP_DIR"
	as_root "$MSHH_DIR" cp -r "$src" "$APP_DIR"

	info "Установка лаунчера $LAUNCHER..."
	as_root "$BIN_DIR" mkdir -p "$BIN_DIR"
	sed "s|@INSTALL_DIR@|$MSHH_DIR|g" "$(template mshh-launcher)" >"$TMP/mshh-launcher.installed"
	as_root "$BIN_DIR" install -m 755 "$TMP/mshh-launcher.installed" "$LAUNCHER"

	info "Установка ярлыка и иконки..."
	as_root "$DESKTOP_DIR" mkdir -p "$DESKTOP_DIR" "$ICON_DIR"
	as_root "$DESKTOP_DIR" install -m 644 "$(template mshh.desktop)" "$DESKTOP_FILE"
	as_root "$ICON_DIR" install -m 644 "$(template mshh.svg)" "$ICON_FILE"

	if command -v update-desktop-database >/dev/null 2>&1; then
		as_root "$DESKTOP_DIR" update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
	fi

	info "Готово. Запускайте командой «mshh» или через меню приложений («Mshh»)."
}

install_release() {
	need tar
	local tag="$MSHH_VERSION"
	if [ -z "$tag" ]; then
		info "Определяю последнюю версию..."
		tag="$(latest_tag)" ||
			die "Не удалось получить последний релиз с GitHub.
Укажите версию вручную: MSHH_VERSION=vX.Y.Z $0
или соберите из исходников: $0 --from-source"
	fi
	info "Загрузка MSHH $tag..."
	fetch "https://github.com/$REPO/releases/download/$tag/$TARBALL" "$TMP/$TARBALL"
	tar -xzf "$TMP/$TARBALL" -C "$TMP"
	[ -x "$TMP/$APP_SUBDIR/mshh" ] || die "В архиве нет исполняемого файла $APP_SUBDIR/mshh."

	TEMPLATE_REF="$tag"
	install_app "$TMP/$APP_SUBDIR"
}

install_from_source() {
	need git
	need npm
	need node

	local src="$SCRIPT_DIR"
	if [ ! -f "$src/package.json" ]; then
		info "Клон репозитория не найден рядом с install.sh — клонирую $REPO..."
		src="$TMP/src"
		git clone --depth 1 "https://github.com/$REPO.git" "$src"
	fi

	local node_major
	node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
	case "$node_major" in
	'' | *[!0-9]*) node_major=0 ;;
	esac
	[ "$node_major" -ge 20 ] ||
		die "Требуется Node.js >= 20 (обнаружено: $(node -v 2>/dev/null || echo 'не найден'))."

	info "Сборка из исходников: $src"
	(
		cd "$src"
		npm ci
		npm run build
		npm run dist
	)
	[ -d "$src/out/$APP_SUBDIR" ] ||
		die "Сборка не создала out/$APP_SUBDIR. Проверьте скрипты build/dist в package.json."
	info "Сборка готова."

	SRC_DIR="$src"
	install_app "$src/out/$APP_SUBDIR"
}

uninstall() {
	info "Удаляю MSHH..."
	as_root "$MSHH_DIR" rm -rf "$APP_DIR"
	as_root "$BIN_DIR" rm -f "$LAUNCHER"
	as_root "$DESKTOP_DIR" rm -f "$DESKTOP_FILE" "$ICON_FILE"
	as_root "$MSHH_DIR" rmdir --ignore-fail-on-non-empty "$MSHH_DIR" 2>/dev/null || true
	info "MSHH удалена."

	local d
	for d in "$HOME/.config/mshh" "$HOME/.config/MSHH" "$HOME/.config/Electron"; do
		if [ -d "$d" ]; then
			warn "Данные профилей сохранены: $d — удалите вручную, если они не нужны."
		fi
	done
}

main() {
	local mode="release"
	while [ $# -gt 0 ]; do
		case "$1" in
		--from-source) mode="source" ;;
		--uninstall) mode="uninstall" ;;
		-h | --help)
			usage
			return 0
			;;
		*)
			die "Неизвестный аргумент: $1 (см. $0 --help)"
			;;
		esac
		shift
	done

	if [ "$mode" = "uninstall" ]; then
		uninstall
		return 0
	fi

	need tar
	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT

	if [ "$mode" = "source" ]; then
		install_from_source
	else
		install_release
	fi
}

main "$@"
