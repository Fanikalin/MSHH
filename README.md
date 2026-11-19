# MSHH

Мультипротокольный мессенджер на базе [Cinny](https://github.com/cinnyapp/cinny)
(Electron-приложение). Matrix работает «из коробки», остальные протоколы
подключаются модулями.

## Возможности

- **Модули протоколов** — Telegram, WhatsApp и другие подключаются как модули;
  чаты всех протоколов собираются в единый список.
- **Профили** — несколько аккаунтов в одном окне: профиль — отдельный аккаунт
  любого протокола, настройки и секреты хранятся локально на устройстве.
- **Фильтры чатов** — быстрый отбор единого списка по профилю или по протоколу.

## Установка — Omarchy / Arch Linux

Одна команда:

```bash
curl -fsSL https://raw.githubusercontent.com/Fanikalin/MSHH/main/install.sh | bash
```

Приложение ставится в `/opt/mshh`, лаунчер — в `/usr/local/bin/mshh`.
Повторный запуск этой же команды обновляет MSHH до последней версии.

Запуск: команда `mshh` в терминале или пункт «Mshh» в меню приложений.

Другие режимы установщика:

- `./install.sh --from-source` — собрать из исходников и установить;
- `./install.sh --uninstall` — удалить (при запуске через `curl | bash` флаги
  передаются так: `curl -fsSL .../install.sh | bash -s -- --uninstall`);
- `MSHH_DIR=путь ./install.sh` — установить в свой каталог вместо `/opt/mshh`.

## Разработка

```bash
npm ci
npm run mshh
```

Подробнее об устройстве приложения —
[docs/mshh/ARCHITECTURE.md](docs/mshh/ARCHITECTURE.md).

## Модули протоколов

Гайд для авторов модулей:
[docs/mshh/MODULE_API.md](docs/mshh/MODULE_API.md).

## Лицензия

[AGPL-3.0-only](LICENSE). Основано на [Cinny](https://github.com/cinnyapp/cinny)
(© Ajay Bura). Историческая ветка с консольным клиентом на Rust —
[`legacy-rust-tui`](https://github.com/Fanikalin/MSHH/tree/legacy-rust-tui).
