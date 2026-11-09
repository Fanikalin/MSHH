# Модуль MSHH: руководство

Модуль — это `cdylib`-библиотека на Rust (как мод к игре): реализует протокол,
хранение и правила отображения своего мессенджера. Ядро грузит `.so`, дергает
несколько экспортов и предоставляет host-сервисы.

Полный живой пример: [modules/echo](../modules/echo) — локальный чат с историей
в SQLite и эхо-ответами.

## Минимальный модуль

`Cargo.toml`:

```toml
[package]
name = "mshh-module-myproto"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
mshh-module-api = { path = "crates/mshh-module-api" }   # или git/версия из реестра
```

`src/lib.rs`:

```rust
use mshh_module_api::prelude::*;

#[derive(Default)]
struct MyProto;

impl Module for MyProto {
    fn run(&self, s: Session) {
        // 1. Регистрируем UI и схему БД.
        s.send_ui(&UiCmd::SetAccounts(vec![AccountView {
            id: "me".into(), name: "MyProto".into(), status: "онлайн".into(),
        }]));
        s.send_ui(&UiCmd::SetChats(vec![ChatView {
            id: "general".into(), title: "Общий чат".into(),
            subtitle: None, unread: 0,
        }]));

        // 2. Главный цикл: события ядра.
        loop {
            match s.recv() {
                Some(Ev::UiAction { action, chat_id, payload })
                    if action == actions::COMPOSER_SEND =>
                {
                    let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    // ... отправить в сеть, получить ответ ...
                    s.send_ui(&UiCmd::AddMessage(MessageView {
                        id: format!("{}-{}", s.now_ms(), text.len()),
                        chat_id: chat_id.unwrap_or_default(),
                        sender: "server".into(),
                        out: false,
                        ts_ms: s.now_ms(),
                        body: Body::Text(format!("ответ на «{text}»")),
                    }));
                }
                Some(Ev::Shutdown) | None => break,
                _ => {}
            }
        }
    }
}

register_module!(MyProto, id: "myproto", name: "MyProto", version: "0.1.0");
```

Сборка и установка:

```sh
cargo build -p mshh-module-myproto
cp target/debug/libmshh_module_myproto.so ~/.local/share/mshh/modules/
mshh --list && mshh
```

## Session — host-сервисы

| Метод | Назначение |
|---|---|
| `recv()` / `recv_timeout()` / `try_recv()` | события ядра (`Ev`) |
| `send_ui(&UiCmd)` | команда отображения (thread-safe, не блокирует) |
| `storage_exec(sql, &[SqlValue])` | SQL ядра, параметры `?N`, результат `Vec<Row>` |
| `kv_get` / `kv_set` | KV, изолированный по id модуля |
| `log/error/warn/info/debug(tag, msg)` | журнал: `~/.local/state/mshh/mshh.log` |
| `now_ms()` | время ядра |
| `sleep(d)` | сон потока модуля |

## События ядра (Ev)

| Событие | Когда |
|---|---|
| `Started` | после старта/переинициализации: поднять UI, историю |
| `UiAction { action, chat_id, payload }` | действие пользователя |
| `Shutdown` | ядро завершается: выйти из `run` |

Стандартные `action` (модуль `mshh-module-api::model::actions`):

| Имя | payload |
|---|---|
| `__chat.open` | `{"chat_id": "..."}` — чат открыт/выбран |
| `__composer.send` | `{"chat_id": "...", "text": "..."}` |
| `__login.submit` | `{"<field_id>": "value", ...}` |
| `__login.cancel` | `{}` |

## Команды отображения (UiCmd)

`SetAccounts`, `SetChats` (полная замена), `UpsertChat` (unread/заголовок),
`SetMessages` (история), `AddMessage` (дозапись), `SetPresence`,
`PromptLogin { title, fields, submit_action, cancel_action }` (форма входа —
поля определяете вы), `CloseLogin`, `Toast`.

Тела сообщений: `Body::Text | Image { alt } | File { name, size }` — TUI
показывает плейсхолдеры, будущий GUI-рендерер — реальные медиа.

## Хранилище

* Таблицы модуля: **обязательный префикс** `mod_<id>_`, например
  `mod_myproto_messages`. Модель доверия: модуль — нативный код, SQL выполняется
  как есть; префикс — соглашение, чтобы модули не топтали друг друга.
* `storage_exec` принимает любые SQL (SELECT/INSERT/DDL); параметры — `?N`.
* Мелкое состояние — `kv_*` (не нужно создавать таблицу).
* Схему создавайте в начале `run` (`CREATE TABLE IF NOT EXISTS …`).
* Файлы (сессии, ключи, state-store): `$HOME/.local/share/mshh/modules-data/<id>/`,
  создавайте каталог сами (`create_dir_all`). Права на файлы с секретами — 0600.

## Правила и ограничения

* **`Session` не `Send`**: host-вызовы — только из потока `run`. Свои потоки —
  можно, но общайтесь с `run` через свои каналы (`std::sync::mpsc`).
* После возврата из `run` (по `Shutdown`) host-вызовы запрещены — ядро
  уничтожает экземпляр.
* **Профили (ABI v2)**: ядро может запускать несколько экземпляров модуля
  одновременно — у каждого свой `s.profile()`. Изолируйте состояние:
  таблицы `mod_<id>_<profile>_...`, per-аккаунтные kv-ключи с префиксом
  профиля, файлы в подкаталоге `modules-data/<id>/<profile>/`.
* **Настройки профиля**: объявите схему `fn settings_schema(&self) -> Vec<FieldDef>`
  (метод трейта `Module`) — они появятся в «Настройки → профиль»; значения
  приходят событием `Ev::Settings { values }` после старта и при каждом
  сохранении, применяйте на лету. Тип значения — строка; числа парсьте сами.
* Паники в модуле перехватываются ядром (`catch_unwind`) — процесс не падает,
  но модуль в этом `run` мёртв: логируйте и завершайте поток.
* Сетевые пути, требующие живых учётных данных, помечайте
  `// LIVE-CREDENTIALS:` — так reviewers видят, что проверено только offline
  (загрузка, формы, обработка ошибок сети).
* Версия ABI проверяется при загрузке; несовместимые модули не грузятся.
* Сеть: тяньте любые крейты (tokio, rustls, reqwest…) — модуль изолирован от
  ядра только границей вызовов, runtime свой. Прямой `std::net::TcpStream`
  тоже работает.

## Отладка

```sh
tail -f ~/.local/state/mshh/mshh.log        # журнал ядра и модулей
mshh --verbose --headless                   # журнал в stderr + UiCmd-поток
mshh --modules-dir target/debug --list      # найти модуль из сборки
```

Ещё не поддерживается (дорожная карта): сетевые примитивы в ABI (v2),
мульти-экземпляры одной библиотеки, Windows/Android сборки.
