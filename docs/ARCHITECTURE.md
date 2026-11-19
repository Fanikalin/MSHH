# MSHH — Architecture (internal)

MSHH = multi-protocol messenger client. Cinny is the UI foundation: its screens,
components and styles are reused as-is or composed; they are never rewritten.
All protocol work lives in modules. Matrix is one module among five, with no
privileges: the app runs fully without any Matrix profile.

## Process model (desktop, Electron)

```
┌────────────────────────── Electron main (Node) ──────────────────────────┐
│  MSHH core                                                               │
│   ├─ profile store   (userData/profiles.json, atomic writes)             │
│   ├─ module loader   (scan mshh_modules/*/ , manifest validation)        │
│   ├─ profile runners (one instance per enabled profile)                  │
│   ├─ IPC router      (invoke channels + event bus → renderer)            │
│   └─ static server   (serves vite dist on 127.0.0.1:<port>)              │
└──────────────┬───────────────────────────────────────────┬───────────────┘
               │ preload: contextBridge window.mshh        │
┌──────────────▼───────────────────────────────────────────▼───────────────┐
│  Renderer (Cinny build + src/mshh React layer)                           │
│   ├─ MSHH screens: welcome / profiles / unified chat list+filters        │
│   ├─ unified chat view (composed from Cinny components, Cinny style)     │
│   └─ Cinny app as shipped: native room view + its internals, used by     │
│      the Matrix module only, via its existing routes                     │
└──────────────────────────────────────────────────────────────────────────┘
```

Why Electron: Telegram (MTProto), WhatsApp (Baileys), VK longpoll need Node
sockets/crypto that browsers cannot do; main process hosts them natively.
Renderer stays a normal web page — the same UI stack is portable to other
Linux distros (Electron builds exist) and later Android (renderer reuse +
core-as-service). Main serves dist over http://127.0.0.1 — avoids `file://`
breakage in service-worker/fetch paths.

## Module contract

A module is a folder in `mshh_modules/`:

```
mshh_modules/<module-id>/
  manifest.json     # identity + settings schema + auth type  (required)
  index.js          # module implementation                   (required)
  package.json      # optional; deps auto-installed on first load
```

User-facing format doc: `docs/MODULES.md` (written for module authors).

`manifest.json`:

```jsonc
{
  "id": "telegram",            // [a-z0-9_-]+ , unique
  "name": "Telegram",
  "version": "1.0.0",
  "runtime": "main",           // "main" (Node) | "renderer" (browser; used by matrix)
  "auth": "custom",            // "password" | "token" | "qr" | "custom" — UI hint
  "fields": [                  // profile settings form schema
    { "name": "phone", "label": "Phone number", "type": "text",
      "required": true, "placeholder": "+79990001122", "help": "…" },
    { "name": "server", "type": "select", "options": ["a", "b"] },
    { "name": "tls", "type": "boolean" },
    { "name": "port", "type": "number" },
    { "name": "secret", "type": "password" }
  ],
  "capabilities": { "media": true, "history": true, "typing": true }
}
```

Field types: `text | password | number | boolean | select`. The profile form is
generated from `fields` — modules ship no UI code.

`index.js` (CommonJS, `runtime: "main"`):

```js
module.exports = { create };

// ctx: { profileId, name, config, dataDir, log(level,msg,meta?), emit(type,payload), http }
// emit types (main → renderer): see "Normalized events" below
module.exports.create = function create(ctx) {
  return {
    async connect() {},        // authorize + sync; may await ctx.prompt(...)
    async disconnect() {},     // close sockets, flush state
    async loadHistory(chatId, opts) {},   // opts: { beforeTs?, limit } → Message[]
    async sendMessage(chatId, draft) {},  // draft: { text?, files?: [{path, name?}] }
    async markRead(chatId) {},
    async sendTyping(chatId) {},          // optional
  };
};
```

Auth that needs data from the user mid-connect (Telegram login code, QR render)
is done through the prompt channel:

```js
const answer = await ctx.prompt({
  kind: "code",                 // "code" | "text" | "qr"
  title: "Login code",
  qr: pngBuffer,                // kind:"qr" — renderer shows the QR image
  timeoutMs: 120000,
});
// answer: { value: "12345" } for code/text; qr resolves when module says so
```

Renderer module (`runtime: "renderer"`, Matrix): the loader does not
instantiate it in main. `mshh_modules/matrix/index.js` exports
`{ manifestRuntimeAdapter: true }`; the renderer adapter in
`src/mshh/bridges/matrix` drives Cinny's existing Matrix stack (login screens,
sync, native room view) and produces the same normalized events as main-side
modules, so the rest of MSHH is module-agnostic.

### Normalized data

```ts
// Chat
{ id, profileId, kind: "dm"|"group"|"channel", title, subtitle?,
  ts,                       // last-activity epoch ms — drives list sort
  unread, muted?, avatarPath? }

// Message
{ id, chatId, profileId, senderId, senderName?, ts,
  out,                      // true = sent by the user
  text?,                    // plain text after module-side normalization
  media?: { kind: "image"|"file"|"audio"|"video", name?, mime?, size?,
            path? },        // path = file in profile dataDir, served via mshh-media://
  replyTo?, edited?, pending? }

// Events emitted by module runner
"chat"            Chat (upsert by (profileId, id))
"chat-remove"     { id }
"message"         Message
"message-edit"    Message
"typing"          { chatId, who }
"status"          { state: "connecting"|"online"|"offline"|"error", error? }
```

## Profiles

- `userData/profiles.json`: `{ profiles: [{ id, moduleId, name, enabled, config, meta }] }`.
- `id` = `p_<random>`; `config` = values for the module `fields` schema.
- Session/secrets live in `userData/sessions/<profileId>/` — module-owned, never
  synced into profiles.json.
- Lifecycle: create → (enabled) runner starts on launch / on edit; disable stops
  runner, keeps config; delete wipes profile + session dir.

## Chat surface (renderer)

- Sidebar section «Чаты» renders ALL chats of all enabled profiles, sorted by
  `ts`; filters: by profile, by module, text search. Section is ADDED beside
  Cinny's own room navigation — Cinny screens untouched.
- Opening a non-Matrix chat → unified chat view (Cinny-styled, composed from
  Cinny components). Opening a Matrix chat → Cinny's native room view (its
  existing route). Matrix chats also appear in the unified list.
- Zero enabled profiles → MSHH welcome screen («Добавить профиль» flow), never
  a Matrix login.

## Installation / packaging

- Repo ships `install.sh`: installs deps, builds renderer, writes `mshh`
  launcher (`~/.local/bin/mshh`) + `.desktop` entry; idempotent; distro-generic
  (Omarchy today, any Arch/other Linux with node+npm).
- `mshh` → launches Electron app (dev mode falls back to vite).
- Android: out of scope now; renderer/core split keeps it reachable.

## Layer map (where code lives)

```
electron/            main process (core, ipc, media protocol, static server)
mshh_modules/        modules: telegram, whatsapp, matrix, xmpp, vk (+ user-installed)
src/mshh/            renderer layer: state (jotai), screens, unified view, filters
src/                 Cinny as shipped — additions live in src/mshh, edits to
                     existing Cinny files are limited to wiring points listed
                     in docs/CINNY_WIRING.md (each documented + justified)
```
