# MSHH Module API (canonical contract)

Any developer can add protocol support by dropping a folder into
`mshh_modules/`. This document is the contract for both module authors and
the app. If code disagrees with this document, this document wins.

## Module folder layout

```
mshh_modules/<module-id>/
  module.json          # manifest (required)
  index.cjs | index.mjs | index.js   # entry (required for side:"main")
  package.json         # optional; deps for main-side modules
  node_modules/        # optional; if absent, host runs npm install --omit=dev
```

## module.json

```jsonc
{
  "id": "telegram",              // required, [a-z0-9_-]+, unique
  "name": "Telegram",            // required, display name
  "version": "1.0.0",            // required
  "side": "main",                // required: "main" (hosted in electron main) | "renderer"
  "description": "optional",
  "icon": "optional url or data-uri",
  "entry": "index.cjs",          // optional, default index.(cjs|mjs|js)
  "auth": {                      // optional; interactive login flow AFTER config form
    "type": "qr"                 // "none" (default) | "qr" | "code" | "builtin-login"
  },
  "profileFields": [             // config form schema, shown in add/edit profile UI
    { "key": "apiId", "label": "API ID", "type": "number", "required": true },
    { "key": "apiHash", "label": "API Hash", "type": "secret", "required": true },
    { "key": "phone", "label": "Phone", "type": "string", "required": true,
      "placeholder": "+7…", "hint": "international format" },
    { "key": "server", "label": "Server", "type": "select",
      "options": [{ "value": "prod", "label": "Production" }], "default": "prod" },
    { "key": "beta", "label": "Beta features", "type": "boolean", "default": false }
  ]
}
```

Field types: `string | secret | number | boolean | select`.
`secret` values are stored main-side and never returned to the renderer.

## side:"main" entry contract

Entry exports one factory. ESM or CJS both fine.

```js
module.exports = { createClient };

// ctx: {
//   profileId: string,
//   config: object,        // resolved from profileFields (values from profile store)
//   dataDir: string,       // per-profile persistent dir; module stores creds here
//   emit: (event, payload) => void,   // push events to app
//   log:  (level, msg) => void,       // "info"|"warn"|"error"
// }
// returns client object; host calls connect() after createClient.
function createClient(ctx) {
  return {
    connect: async () => {},             // start; may throw, host reports error event
    disconnect: async () => {},          // graceful stop
    send: async (chatId, text) => {},    // returns message id string
    markRead: async (chatId, messageId) => {},
    setTyping: async (chatId, on) => {},
  };
}
```

### Events (via ctx.emit)

| event          | payload                                                                 |
|----------------|-------------------------------------------------------------------------|
| `status`       | `"connecting" \| "online" \| "offline" \| "auth-pending"`               |
| `auth`         | `{ type: "qr", dataUrl }` — QR to render                                |
|                | `{ type: "code", hint }` — asks user for code, then `submitAuth`        |
|                | `{ type: "done" }` — auth finished (host persists nothing; module does) |
|                | `{ type: "error", message }`                                            |
| `chats`        | full snapshot: `[{ chatId, name, avatar?, unread?, pinned?, muted?, lastMessage?: { id, text, ts, out, senderName? } }]` |
| `message`      | `{ chatId, id, text, ts, out, senderName?, mediaUrl? }` (new/update)    |
| `chat-update`  | `{ chatId, ...patch }` (name, unread, pinned, …)                        |
| `typing`       | `{ chatId, who, on }`                                                   |
| `receipt`      | `{ chatId, lastReadId }`                                                |
| `error`        | `{ message }`                                                           |

`ts` — milliseconds epoch. `out` — true if message is from the account itself.
Modules SHOULD emit `chats` after connect and on any list change; `message` for
live updates (host stores last 200 messages per chat in memory).

## Auth flow (host-driven)

1. User fills `profileFields` form → host saves profile, calls `connect()`.
2. Module needing login emits `auth` events. For `code` type the renderer shows
   an input; user input reaches the module via `submitAuth(profileId, value)`
   — modules implement it as an extra client method `submitAuth(value)`.
   For `qr` the renderer shows the QR image; no input needed.
3. Modules persist session/creds in `ctx.dataDir` themselves; on next connect
   they should go online without auth events.

## Renderer-side modules (`side: "renderer"`)

Only `matrix` exists (built-in). Its manifest declares `auth.type:
"builtin-login"` and `profileFields` for display; its profiles are derived
from Cinny sessions by the renderer and cannot be edited beyond Cinny's own
session management. Renderer-side modules do NOT have entry scripts.

## IPC surface (preload `window.mshh`)

```ts
listModules(): Promise<ModuleInfo[]>            // manifests, secrets stripped
listProfiles(): Promise<ProfileMeta[]>          // { id, moduleId, name, enabled, config } no secrets
saveProfile(p: { id?, moduleId, name, config }): Promise<{ id }>
setProfileSecret(id, key, value): Promise<void>
deleteProfile(id): Promise<void>
setEnabled(id, enabled): Promise<void>
connectProfile(id): Promise<void>
disconnectProfile(id): Promise<void>
submitAuth(id, value): Promise<void>
send(id, chatId, text): Promise<string>         // message id
markRead(id, chatId, messageId?): Promise<void>
setTyping(id, chatId, on): Promise<void>
getChats(id): Promise<Chat[]>                   // snapshot
getMessages(id, chatId): Promise<Msg[]>         // in-memory history
onEvent(cb): () => void                         // { profileId, event, payload }
```

Errors surface as rejected promises; renderer maps them to UI toasts.
