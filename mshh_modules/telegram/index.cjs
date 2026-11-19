// MSHH Telegram module — gramjs ("telegram" npm package).
// All heavy imports are lazy (inside connect), so manifest scanning and
// createClient never fail before `npm install` runs in this folder.

const fs = require("fs");
const path = require("path");

const SESSION_FILE = "session";
const DIALOG_LIMIT = 200;

function createClient(ctx) {
  const { config, dataDir, emit, log } = ctx;

  // Lazily loaded gramjs handles.
  let Api = null;
  let TelegramClient = null;
  let NewMessage = null;
  let Raw = null;
  let StringSession = null;
  let utils = null;

  let client = null;
  let authorized = false;
  let eventsAttached = false;
  let pendingAuth = null; // { resolve, stage: "code" | "password" }

  // marked peer id -> display name, filled from dialogs
  const nameCache = new Map();

  const sessionPath = () => path.join(dataDir, SESSION_FILE);

  function loadSession() {
    try {
      return fs.readFileSync(sessionPath(), "utf8").trim();
    } catch {
      return "";
    }
  }

  function saveSession(str) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(sessionPath(), str, "utf8");
    } catch (e) {
      log("error", "Не удалось сохранить сессию: " + e.message);
    }
  }

  function status(s) {
    emit("status", s);
  }

  function ensureClient() {
    if (client) return client;
    const telegram = require("telegram");
    Api = telegram.Api;
    TelegramClient = telegram.TelegramClient;
    utils = telegram.utils;
    ({ StringSession } = require("telegram/sessions"));
    ({ NewMessage, Raw } = require("telegram/events"));

    client = new TelegramClient(
      new StringSession(loadSession()),
      Number(config.apiId),
      String(config.apiHash),
      { connectionRetries: 3 }
    );
    return client;
  }

  const peerIdOf = (peer) => (peer ? String(utils.getPeerId(peer)) : null);

  function senderNameOf(chatId, msg) {
    if (msg.out) return undefined;
    const sid = msg.fromId ? peerIdOf(msg.fromId) : chatId;
    return (sid && nameCache.get(sid)) || undefined;
  }

  function toMsg(chatId, m) {
    return {
      id: String(m.id),
      text: m.message || "",
      ts: (m.date || 0) * 1000,
      out: !!m.out,
      ...(m.out ? {} : { senderName: senderNameOf(chatId, m) }),
    };
  }

  // ---- auth flow (host-driven): phone is in config, code/password via submitAuth

  function askAuth(stage, hint) {
    return new Promise((resolve) => {
      pendingAuth = { resolve, stage };
      emit("auth", { type: "code", hint });
    });
  }

  function submitAuth(value) {
    const pending = pendingAuth;
    pendingAuth = null;
    if (!pending) {
      emit("auth", { type: "error", message: "Нет активного запроса авторизации" });
      return;
    }
    pending.resolve(String(value ?? ""));
  }

  async function doLogin() {
    try {
      // gramjs handles SESSION_PASSWORD_NEEDED internally by calling the
      // `password` callback, which emits another code-type auth prompt.
      await client.signInUser(
        { apiId: Number(config.apiId), apiHash: String(config.apiHash) },
        {
          phoneNumber: String(config.phone),
          phoneCode: async () => {
            status("auth-pending");
            return askAuth("code", "Введите код, отправленный в Telegram");
          },
          password: async (hint) => {
            return askAuth("password", hint || "пароль 2FA");
          },
          onError: async (err) => {
            emit("auth", { type: "error", message: err.message });
            return false; // false = gramjs retries and asks for the code again
          },
        }
      );
      authorized = true;
      saveSession(client.session.save());
      emit("auth", { type: "done" });
      await afterLogin();
    } catch (e) {
      emit("auth", { type: "error", message: e.message || String(e) });
      status("offline");
    }
  }

  // ---- data flow

  async function pushChats() {
    const dialogs = Array.from(await client.getDialogs({ limit: DIALOG_LIMIT }));
    const chats = dialogs.map((d) => {
      const chatId = d.id ? d.id.toString() : null;
      const name = d.name || d.title || "Без названия";
      if (chatId) nameCache.set(chatId, name);
      return {
        chatId,
        name,
        avatar: null,
        unread: d.unreadCount || 0,
        pinned: !!d.pinned,
        ...(d.message ? { lastMessage: toMsg(chatId, d.message) } : {}),
      };
    });
    emit("chats", chats.filter((c) => c.chatId));
  }

  function attachEvents() {
    if (eventsAttached || !client) return;
    eventsAttached = true;

    client.addEventHandler((event) => {
      const m = event.message;
      if (!m) return;
      const chatId = m.peerId ? peerIdOf(m.peerId) : null;
      if (!chatId) return;
      emit("message", {
        chatId,
        id: String(m.id),
        text: m.message || "",
        ts: (m.date || Math.floor(Date.now() / 1000)) * 1000,
        out: !!m.out,
        ...(m.out ? {} : { senderName: senderNameOf(chatId, m) }),
      });
    }, new NewMessage({}));

    client.addEventHandler((update) => {
      try {
        if (
          update instanceof Api.UpdateUserTyping ||
          update instanceof Api.UpdateChannelUserTyping
        ) {
          const peer =
            update instanceof Api.UpdateUserTyping
              ? new Api.PeerUser({ userId: update.userId })
              : new Api.PeerChannel({ channelId: update.channelId });
          const chatId = peerIdOf(peer);
          if (!chatId) return;
          const on = update.action instanceof Api.SendMessageTypingAction;
          emit("typing", {
            chatId,
            who: nameCache.get(chatId) || chatId,
            on,
          });
        } else if (
          update instanceof Api.UpdateReadHistoryInbox ||
          update instanceof Api.UpdateReadHistoryOutbox
        ) {
          const chatId = peerIdOf(update.peer);
          if (!chatId || update.maxId == null) return;
          emit("receipt", { chatId, lastReadId: String(update.maxId) });
        }
      } catch (e) {
        log("warn", "Не удалось обработать обновление: " + e.message);
      }
    }, new Raw({}));
  }

  async function afterLogin() {
    attachEvents();
    status("online");
    try {
      await pushChats();
    } catch (e) {
      log("error", "Не удалось загрузить список чатов: " + e.message);
    }
  }

  function requireOnline(what) {
    if (!client || !authorized) {
      throw new Error(`Telegram: нет подключения (${what})`);
    }
  }

  // ---- contract methods

  async function connect() {
    if (!config?.apiId || !config?.apiHash || !config?.phone) {
      throw new Error("Telegram: не заданы apiId, apiHash или телефон");
    }
    status("connecting");
    const c = ensureClient();
    await c.connect();
    authorized = await c.checkAuthorization();
    if (!authorized) {
      status("auth-pending");
      // Not awaited: stays pending while the user enters the code/password.
      doLogin();
      return;
    }
    saveSession(c.session.save());
    emit("auth", { type: "done" });
    await afterLogin();
  }

  async function disconnect() {
    try {
      if (client) {
        saveSession(client.session.save());
        await client.disconnect();
      }
    } catch {
      // ignore disconnect errors
    }
    client = null;
    authorized = false;
    eventsAttached = false;
    status("offline");
  }

  async function send(chatId, text) {
    requireOnline("отправка");
    const msg = await client.sendMessage(chatId, { message: String(text) });
    return String(msg.id);
  }

  async function markRead(chatId, messageId) {
    requireOnline("отметка прочтения");
    await client.markAsRead(
      chatId,
      messageId != null ? Number(messageId) : undefined
    );
  }

  async function setTyping(chatId, on) {
    // gramjs has no setTyping helper; messages.SetTyping is the MTProto call.
    if (!client || !authorized) return;
    const action = on
      ? new Api.SendMessageTypingAction()
      : new Api.SendMessageCancelAction();
    await client.invoke(new Api.messages.SetTyping({ peer: chatId, action }));
  }

  return {
    connect,
    disconnect,
    send,
    markRead,
    setTyping,
    submitAuth,
  };
}

module.exports = { createClient };
