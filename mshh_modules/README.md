# mshh_modules

Базовые модули протоколов MSHH. Контракт модулей описан в
[`docs/mshh/MODULE_API.md`](../docs/mshh/MODULE_API.md) — этот документ
канонический и главнее любого кода.

## Папка модуля

```
mshh_modules/<module-id>/
  module.json     # манифест (обязателен)
  index.cjs|.mjs  # точка входа (обязательна для side:"main")
  package.json    # зависимости main-модулей (опционально)
  selftest.mjs    # проверка манифеста и контракта без сети (рекомендуется)
```

Если `node_modules` отсутствует, приложение выполняет `npm install --omit=dev`
при первой активации профиля. Поэтому импортируйте тяжёлые зависимости внутри
`connect()`/`createClient`, а не на верхнем уровне файла.

## Существующие модули

| Модуль   | side     | auth          | Тест                  |
|----------|----------|---------------|-----------------------|
| `matrix`   | renderer | builtin-login | `node matrix/selftest.mjs`   |
| `telegram` | main     | code (2FA поддерживается) | `node telegram/selftest.mjs` |
| `whatsapp` | main     | qr            | `node whatsapp/selftest.mjs` |

## Как добавить свой модуль

1. Создайте папку с `module.json` (схема — в MODULE_API.md).
2. Для `side:"main"` экспортируйте фабрику `createClient(ctx)` с методами
   `connect / disconnect / send / markRead / setTyping` (и `submitAuth`
   для `auth.type:"code"`), события — через `ctx.emit`.
3. Сессии и креды храните в `ctx.dataDir`.
4. Проверьте папку локальным selftest-скриптом.
