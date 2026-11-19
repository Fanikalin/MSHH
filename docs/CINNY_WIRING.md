# Правки в кодовой базе Cinny (wiring points)

Инвариант ТЗ: существующие экраны Cinny не переписываются. Всё MSHH-специфичное
живёт в `src/mshh/`, `electron/`, `mshh_modules/`. Ниже — ПОЛНЫЙ список точек,
где мы касаемся файлов Cinny. Каждая правка аддитивна, кроме одной (п. 2),
необходимой по требованию ТЗ («точка входа — сценарий профили и чаты, не логин
матрикса»).

## 1. `src/app/pages/paths.ts` — добавлены константы маршрутов
`MSHH_PATH`, `_MSHH_PROFILES_PATH`, `_MSHH_PROFILE_NEW_PATH`,
`_MSHH_PROFILE_EDIT_PATH`, `_MSHH_CHAT_PATH` (в конце файла, ничего не меняя).

## 2. `src/app/pages/Router.tsx`
- Импорты MSHH-констант и экранов (аддитивно).
- **Единственная семантическая правка**: loader корневого маршрута `/` теперь
  всегда редиректит на `/mshh` (сценарий «профили и чаты»). Раньше он вёл на
  список матрикс-комнат при сессии или на матрикс-логин без неё. Логин матрикса
  остался доступен на `/login` (его использует модуль matrix).
- Добавлено поддерево `<Route path="/mshh" element={<MshhIndex/>}>` с
  вложенными маршрутами: чаты, профили, форма профиля, чат.

## 3. `src/app/pages/pathUtils.ts`
Добавлены `getMshhPath`, `getMshhProfilesPath`, `getMshhProfileNewPath`,
`getMshhProfileEditPath`, `getMshhChatPath` + одно имя в импорте.

## 4. `src/app/pages/client/SidebarNav.tsx`
В первый `SidebarStack` добавлен `<MshhTab />` (перед HomeTab) — новая вкладка
рядом с существующими, существующие не тронуты.

## 5. `src/app/pages/client/sidebar/MshhTab.tsx` — новый файл
Вкладка сайдбара, ведёт на `/mshh`. Образец — соседние `HomeTab`/`DirectTab`.

## 6. `src/index.tsx`
Регистрация service worker обёрнута условием `!window.mshh?.desktop`: в
Electron-приложении SW не нужен (локальный сервер, обновление = перезапуск
`mshh`), а устаревший SW мог бы отдавать старую сборку. Вне Electron поведение
Cinny не меняется.

## 7. `package.json`
- `"main": "electron/main.cjs"` — точка входа Electron.
- Скрипты `app` / `app:dev` — запуск оболочки (дев-режим поверх vite).

Больше ни один файл Cinny не изменён. Проверка: `git diff --stat` после
мерджа MSHH — затронутые Cinny-файлы совпадают со списком выше.
