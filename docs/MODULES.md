# MSHH modules — формат модуля

Модуль = папка внутри `mshh_modules/`. Установка нового протокола = положить
папку и перезапустить `mshh`. Модуль не содержит UI: форму настройки профиля
приложение генерирует по схеме из манифеста.

## Структура папки

```
mshh_modules/<module-id>/
  manifest.json   # обязательно — имя, схема полей, тип авторизации
  index.js        # обязательно — реализация протокола
  package.json    # опционально; { "type": "commonjs" } и зависимости модуля
```

`module-id` — латиница, цифры, `-`, `_`. Совпадает с `"id"` в манифесте.

## manifest.json

```jsonc
{
  "id": "example",
  "name": "Example",              // человекочитаемое имя
  "version": "1.0.0",
  "runtime": "main",              // "main" — Node (обычный модуль),
                                  // "renderer" — особый случай (встроенный matrix)
  "auth": "password",             // подсказка UI: "password" | "token" | "qr" | "custom"
  "fields": [                     // схема формы настройки профиля
    { "name": "login",   "label": "Логин",  "type": "text",     "required": true },
    { "name": "secret",  "label": "Пароль", "type": "password", "required": true },
    { "name": "port",    "label": "Порт",   "type": "number",   "placeholder": "5222" },
    { "name": "starttls","label": "TLS",    "type": "boolean" },
    { "name": "resource","label": "Ресурс", "type": "select",   "options": ["pc","phone"] }
  ],
  "capabilities": { "media": true, "history": true, "typing": true }
}
```

Типы полей: `text | password | number | boolean | select`.
Допустимые ключи поля: `name`, `label`, `type`, `required?`, `placeholder?`,
`help?`, `options?` (для `select`). Значения полей хранятся в профиле
(`config`); пароли — вместе с ним в `profiles.json`.

## index.js

Модуль экспортирует фабрику `create`. Работает и CommonJS
(`module.exports = { create }`), и ESM (`export default { create }`) — лоадер
использует динамический `import()`.

```js
module.exports = { create };

// ctx выдаётся приложением на каждый запуск профиля:
// ctx = {
//   profileId, name,        // профиль
//   config,                 // значения полей из manifest.fields
//   dataDir,                // папка профиля на диске (сессии, медиа, кэш)
//   log(level, msg, meta?), // level: "debug"|"info"|"warn"|"error"
//   emit(type, payload),    // события наружу, см. ниже
//   prompt(req),            // запрос данных у пользователя в ходе connect()
// }
module.exports.create = function create(ctx) {
  return {
    // Подключение/авторизация. Вызывается при старте включённого профиля.
    // Должна восстановить сессию из ctx.dataDir, если она сохранена.
    // Бросает Error с понятным сообщением при неудаче.
    async connect() {},

    // Отключение: закрыть сокеты, сбросить таймеры. Обязательна к идемпотентности.
    async disconnect() {},

    // История чата. opts: { beforeTs?: number, limit?: number } → Message[]
    // (сообщения старше beforeTs, новые первые).
    async loadHistory(chatId, opts) {},

    // Отправка. draft: { text?: string, files?: [{ path, name? }] }
    // Возвращает отправленное Message (pending: false).
    async sendMessage(chatId, draft) {},

    // Отметить чат прочитанным (опционально).
    async markRead(chatId) {},

    // Показать «печатает» (опционально).
    async sendTyping(chatId) {},
  };
};
```

### ctx.prompt — запрос данных при входе

Если для входа нужен ввод пользователя (код из SMS, скан QR):

```js
const answer = await ctx.prompt({
  kind: "code",            // "code" | "text" | "qr"
  title: "Код входа",
  detail: "Мы отправили код в Telegram",
  qr: pngBuffer,           // только для kind:"qr" — PNG-буфер с картинкой
  timeoutMs: 120000,
});
// answer.value — строка, введённая пользователем (для code/text).
```

Модуль должен корректно пережить отказ пользователя (отмена → очистить
состояние входа, connect() бросает Error «вход отменён»).

## Нормализованные данные

**emit(type, payload)** — типы событий:

| type            | payload                  | когда                                   |
|-----------------|--------------------------|-----------------------------------------|
| `chat`          | `Chat`                   | новый чат или обновление (upsert)       |
| `chat-remove`   | `{ id }`                 | чат исчез                               |
| `message`       | `Message`                | новое сообщение (входящее и исходящее)  |
| `message-edit`  | `Message`                | правка сообщения                        |
| `typing`        | `{ chatId, who }`        | собеседник печатает                     |
| `status`        | `{ state, error? }`      | `connecting \| online \| offline \| error` |

```ts
type Chat = {
  id: string;            // идентификатор в рамках профиля
  kind: "dm" | "group" | "channel";
  title: string;
  subtitle?: string;     // например, статус/присутствие
  ts: number;            // epoch ms последней активности — сортировка списка
  unread: number;
  muted?: boolean;
  avatarPath?: string;   // файл внутри dataDir; отдаётся как mshh-media://
};

type Message = {
  id: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  ts: number;            // epoch ms
  out: boolean;          // true — отправлено этим профилем
  text?: string;
  media?: {              // путь — файл внутри dataDir (mshh-media:// в UI)
    kind: "image" | "file" | "audio" | "video";
    name?: string; mime?: string; size?: number; path?: string;
  };
  replyTo?: string;      // id сообщения
  edited?: boolean;
  pending?: boolean;     // только для локального черновика до подтверждения
};
```

Текст — простой текст (не HTML): модуль сам сводит разметку протокола к тексту.

## Правила жизни модуля

- Сессии/токены храните в `ctx.dataDir` (не в `config`).
- `connect()` при старте: сначала попытка восстановить сессию, и только если
  её нет/она протухла — авторизация (в т.ч. через `ctx.prompt`).
- Медиа входящих сохраняйте в `ctx.dataDir/media/` и указывайте `path`.
- Все ошибки авторизации — понятным русским/английским текстом через
  `Error(...)`: их увидит пользователь в карточке профиля.
- После `disconnect()` модуль не должен emit-ить события.

## app-defaults.json (персональная сборка)

Модуль может поддержать необязательный файл `app-defaults.json` рядом с
`index.js`: пары «имя поля из manifest.fields → значение». Лоадер читает его
и отдаёт интерфейсу для предзаполнения формы профиля; модуль может использовать
значения как фолбэк (пример — telegram). Файл добавлен в `.gitignore`
(`mshh_modules/*/app-defaults.json`) и предназначен для персональных сборок
(`npm run build:share`), а не для репозитория.


## Проверка модуля

```
node scripts/module-smoke.cjs mshh_modules/<module-id>
```

Проверяет манифест, загрузку фабрики, корректный отказ при фейковых данных.
