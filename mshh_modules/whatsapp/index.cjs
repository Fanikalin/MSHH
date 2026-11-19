// MSHH WhatsApp module — Baileys ("baileys" npm package).
// Baileys is ESM-only; it is imported dynamically inside connect() so that
// manifest scanning and createClient never fail before `npm install` runs.

const fs = require("fs");
const path = require("path");

const HISTORY_WAIT_MS = 4000;
const RECONNECT_DELAY_MS = 3000;
const BROADCAST_JIDS = new Set(["status@broadcast", "status@jed"]);

function createClient(ctx) {
  const { dataDir, emit, log } = ctx;

  let sock = null;
  let stopping = false;
  let reconnecting = false;

  // jid -> chat record; filled from history sync and live events
  const chats = new Map();
  // jid -> last message record (for chat snapshots)
  const lastMessages = new Map();

  function status(s) {
    emit("status", s);
  }

  function toMs(ts) {
    const n = typeof ts === "number" ? ts : Number(ts?.toNumber?.() ?? 0);
    return n * 1000;
  }

  function nameFallback(jid) {
    const [user, kind] = String(jid).split("@");
    if (kind === "g.us") return `Группа ${user}`;
    if (kind === "newsletter") return `Канал ${user}`;
    return user || String(jid);
  }

  function extractText(m) {
    const c = m.message;
    if (!c) return "";
    const inner = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c;
    return (
      inner.conversation ??
      inner.extendedTextMessage?.text ??
      inner.imageMessage?.caption ??
      inner.videoMessage?.caption ??
      inner.documentMessage?.caption ??
      inner.contactsArrayMessage?.title ??
      ""
    );
  }

  function recordMessage(chatId, msg, { unread } = {}) {
    lastMessages.set(chatId, msg);
    const chat = chats.get(chatId);
    if (chat) {
      chat.lastMessage = msg;
      if (unread) chat.unread = (chat.unread || 0) + 1;
    }
  }

  function upsertChat(chatId, patch) {
    const existing = chats.get(chatId);
    const chat = {
      chatId,
      name: patch.name ?? existing?.name ?? nameFallback(chatId),
      avatar: null,
      unread: patch.unread ?? existing?.unread ?? 0,
      pinned: patch.pinned ?? existing?.pinned ?? false,
      muted: patch.muted ?? existing?.muted ?? false,
      lastMessage: patch.lastMessage ?? existing?.lastMessage,
    };
    chats.set(chatId, chat);
    return chat;
  }

  let chatsTimer = null;
  function scheduleChats(delay = 300) {
    clearTimeout(chatsTimer);
    chatsTimer = setTimeout(() => {
      chatsTimer = null;
      emitChats();
    }, delay);
  }

  function emitChats() {
    const list = Array.from(chats.values()).sort(
      (a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0)
    );
    emit("chats", list);
  }

  function isVisibleJid(jid) {
    return !!jid && !BROADCAST_JIDS.has(jid) && !String(jid).endsWith("@broadcast");
  }

  function requireSock(what) {
    if (!sock) throw new Error(`WhatsApp: нет подключения (${what})`);
    return sock;
  }

  // ---- baileys event wiring

  function attachEvents(s, saveCreds, DisconnectReason) {
    s.ev.on("creds.update", async (creds) => {
      try {
        if (creds.qr) {
          // `qrcode` is a small CJS dep; lazy require keeps scanning safe.
          const qrcode = require("qrcode");
          const dataUrl = await qrcode.toDataURL(creds.qr);
          emit("auth", { type: "qr", dataUrl });
        }
      } catch (e) {
        emit("auth", { type: "error", message: "Не удалось сгенерировать QR-код: " + e.message });
      }
    });
    s.ev.on("creds.update", saveCreds);

    s.ev.on("connection.update", (u) => {
      if (u.connection === "connecting") {
        status("connecting");
        return;
      }
      if (u.connection === "open") {
        status("online");
        emit("auth", { type: "done" });
        scheduleChats(HISTORY_WAIT_MS);
        return;
      }
      if (u.connection === "close") {
        const err = u.lastDisconnect?.error;
        const code = err?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          // Session is dead on the server side; wipe creds and go offline.
          try {
            fs.rmSync(dataDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
          sock = null;
          status("offline");
          return;
        }
        if (stopping) {
          status("offline");
          return;
        }
        reconnect();
      }
    });

    s.ev.on("messaging-history.set", ({ chats: historyChats, messages }) => {
      for (const m of messages ?? []) {
        if (!m.key?.id || !isVisibleJid(m.key.remoteJid)) continue;
        recordMessage(m.key.remoteJid, {
          id: String(m.key.id),
          text: extractText(m),
          ts: toMs(m.messageTimestamp),
          out: !!m.key.fromMe,
          ...(m.key.fromMe ? {} : { senderName: m.pushName || undefined }),
        });
      }
      for (const c of historyChats ?? []) {
        if (!isVisibleJid(c.id)) continue;
        upsertChat(c.id, {
          name: c.name ?? c.subject,
          unread: c.unreadCount ?? 0,
          pinned: !!c.pinned,
          lastMessage: lastMessages.get(c.id),
        });
      }
      scheduleChats();
    });

    s.ev.on("chats.upsert", (upserts) => {
      for (const c of upserts ?? []) {
        if (!isVisibleJid(c.id)) continue;
        upsertChat(c.id, {
          name: c.name ?? c.subject,
          unread: c.unreadCount,
          pinned: c.pinned != null ? !!c.pinned : undefined,
        });
      }
      scheduleChats();
    });

    s.ev.on("chats.update", (updates) => {
      for (const c of updates ?? []) {
        if (!isVisibleJid(c.id) || !chats.has(c.id)) continue;
        const patch = {};
        if (c.name != null) patch.name = c.name;
        if (c.subject != null) patch.name = c.subject;
        if (c.unreadCount != null) patch.unread = c.unreadCount;
        if (c.pinned != null) patch.pinned = !!c.pinned;
        upsertChat(c.id, patch);
        emit("chat-update", { chatId: c.id, ...patch });
      }
      scheduleChats();
    });

    s.ev.on("messages.upsert", ({ messages, type }) => {
      for (const m of messages ?? []) {
        if (!m.key?.id || !isVisibleJid(m.key.remoteJid)) continue;
        const chatId = m.key.remoteJid;
        const out = !!m.key.fromMe;
        const msg = {
          id: String(m.key.id),
          text: extractText(m),
          ts: toMs(m.messageTimestamp),
          out,
          ...(out ? {} : { senderName: m.pushName || undefined }),
        };
        if (!chats.has(chatId)) upsertChat(chatId, {});
        recordMessage(chatId, msg, {
          unread: type === "notify" && !out ? true : false,
        });
        emit("message", { chatId, ...msg });
      }
      scheduleChats();
    });

    s.ev.on("presence.update", ({ id, presences }) => {
      if (!id) return;
      for (const [jid, p] of Object.entries(presences ?? {})) {
        emit("typing", {
          chatId: id,
          who: chats.get(id)?.name ?? nameFallback(jid),
          on: p?.lastKnownPresence === "composing",
        });
      }
    });
  }

  function reconnect() {
    if (reconnecting || stopping) return;
    reconnecting = true;
    status("connecting");
    setTimeout(() => {
      reconnecting = false;
      connect().catch((e) => {
        log("error", "Не удалось переподключиться: " + e.message);
        reconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  // ---- contract methods

  async function connect() {
    stopping = false;
    status("connecting");

    // Baileys is ESM-only; dynamic import keeps this file CJS.
    const baileys = await import("baileys");
    const { default: makeWASocket, useMultiFileAuthState } = baileys;

    let version;
    try {
      ({ version } = await baileys.fetchLatestBaileysVersion());
    } catch {
      version = undefined; // baileys falls back to its bundled version
    }

    const { state, saveCreds } = await useMultiFileAuthState(dataDir);

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    attachEvents(sock, saveCreds, baileys.DisconnectReason);
  }

  async function disconnect() {
    stopping = true;
    const s = sock;
    sock = null;
    if (s) {
      try {
        s.ev.removeAllListeners();
        s.end(new Error("disconnect"));
      } catch {
        // ignore
      }
    }
    status("offline");
  }

  async function send(chatId, text) {
    const s = requireSock("отправка");
    const res = await s.sendMessage(chatId, { text: String(text) });
    const id = res?.key?.id;
    if (!id) throw new Error("WhatsApp: отправка не подтверждена сервером");
    return String(id);
  }

  async function markRead(chatId, messageId) {
    if (messageId == null) return;
    const s = requireSock("отметка прочтения");
    await s.readMessages([
      { remoteJid: chatId, id: String(messageId), fromMe: false },
    ]);
  }

  async function setTyping(chatId, on) {
    const s = requireSock("индикатор набора");
    await s.sendPresenceUpdate(on ? "typing" : "paused", chatId);
  }

  return {
    connect,
    disconnect,
    send,
    markRead,
    setTyping,
  };
}

module.exports = { createClient };
