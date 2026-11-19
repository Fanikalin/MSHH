# MSHH Architecture

MSHH — multi-protocol messenger client built on Cinny (Matrix renderer) with a
module system for other protocols (Telegram, WhatsApp, …) and multiple profiles.

```
┌────────────────────────── Electron ──────────────────────────┐
│ main process (desktop/)                                      │
│  moduleHost — loads modules from mshh_modules dirs           │
│  profilesStore — userData/profiles.json (config + secrets)   │
│  IPC (ipcMain) ⇄ preload (window.mshh) ⇄ renderer            │
│                              │                               │
│ renderer (Cinny build, src/) │                               │
│  src/mshh/ — store, atoms, UI glue                           │
│  Matrix profiles = built-in Cinny sessions (unchanged code)  │
│  Non-matrix chats = unified list + MshhChatView via IPC      │
└──────────────────────────────────────────────────────────────┘
```

## Profiles

- Stored in `userData/profiles.json`: `{ profiles: [{ id, moduleId, name, config, secrets, enabled }] }`.
- `id` — uuid (main-generated). `secrets` never sent to renderer.
- Matrix profiles are NOT stored in profiles.json: they are derived by the
  renderer from existing Cinny sessions (one profile per session, named by userId).
  They appear in the unified list with `moduleId: "matrix"`.
- Main-side profiles (`telegram`, `whatsapp`, …) live in profiles.json and are
  hosted by moduleHost: one client instance per enabled profile.

## Module lookup

1. `<appDir>/mshh_modules/` — base modules shipped with the app.
2. `userData/mshh_modules/` — user-installed modules (drop a folder there).
   On id collision user module wins.

A module folder contains `module.json` + entry script + optional `package.json`
(main-side modules run `npm install --omit=dev` on first activation if
node_modules is missing; bundled base modules ship with node_modules).

## Chat aggregation (renderer)

Unified chat list = matrix rooms (existing Cinny room-list factory) + all
module chats (from moduleHost events, kept in jotai atoms). Default view shows
everything; filter chips by profile and by module narrow it. Matrix rooms open
via existing navigation; module chats open `MshhChatView`.

## IPC contract

See MODULE_API.md — renderer talks only through `window.mshh` (preload).
When `window.mshh` is absent (plain web build) the renderer uses a no-op stub:
modules list = matrix only, no extra chats. All UI must degrade gracefully.

## Packaging (Omarchy)

- `npm run build` → `dist/` (renderer).
- `desktop/` is plain ESM JS, not bundled; electron runs it directly.
- Release: electron-packager → tarball with bundled `mshh_modules/` +
  `desktop/`; `install.sh` downloads tarball, installs to `/opt/mshh`,
  symlinks `/usr/local/bin/mshh`, writes `.desktop` entry.
- Dev run: `npm run mshh` (electron desktop/main.mjs, loads vite dev server or dist).
