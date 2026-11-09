#!/usr/bin/env bash
# Сборка и установка модулей MSHH в каталог данных ядра.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build -p mshh -p mshh-module-echo

dest="${MSHH_MODULES_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mshh/modules}"
mkdir -p "$dest"
cp -f target/debug/lib*.so "$dest/"

echo "Установлено в $dest:"
ls -1 "$dest"
echo
echo "Запуск: ./target/debug/mshh"
