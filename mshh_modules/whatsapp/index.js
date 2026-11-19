'use strict';

/**
 * MSHH WhatsApp module — Baileys (WhatsApp Web multi-device) over WebSocket.
 *
 * History limitation: Baileys has no REST "load chat history" API. Full history
 * is only delivered once per linked session via the `messaging-history.set`
 * event. We cache those messages per chat in <dataDir>/history.json (capped at
 * ~200 per chat) and serve loadHistory() from that cache. Messages received
 * live are appended to the same cache. Older-than-cached history is therefore
 * not available until the session is re-linked.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const baileys = require('baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
} = baileys;

const HISTORY_FILE = 'history.json';
const HISTORY_CAP = 200; // messages kept per chat
const CONNECT_TIMEOUT_MS = 60_000;
const QR_TIMEOUT_MS = 180_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 120_000;

// Minimal extension → mime map (nothing exotic needed for sends)
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.txt': 'text/plain', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function mimeForFile(p) {
  const ext = path.extname(p).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function extractText(message) {
  if (!message) return undefined;
  if (typeof message.conversation === 'string' && message.conversation) return message.conversation;
  const ext = message.extendedTextMessage;
  if (ext && typeof ext.text === 'string' && ext.text) return ext.text;
  const cap = message.ephemeralMessage?.message;
  if (cap) return extractText(cap);
  const imgCap = message.imageMessage?.caption;
  if (imgCap) return String(imgCap);
  const vidCap = message.videoMessage?.caption;
  if (vidCap) return String(vidCap);
  const docCap = message.documentMessage?.caption;
  if (docCap) return String(docCap);
  return undefined;
}

function extractMediaKind(message) {
  if (!message) return undefined;
  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.audioMessage) return 'audio';
  const doc = message.documentMessage;
  if (doc) {
    const mime = String(doc.mimetype || '');
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'file';
  }
  return undefined;
}

function mediaMessageName(message) {
  const name = message?.documentMessage?.fileName
    || message?.imageMessage?.fileName
    || message?.videoMessage?.fileName
    || message?.audioMessage?.fileName;
  return name ? String(name) : undefined;
}

module.exports.create = function create(ctx) {
  const state = {
    sock: null,
    stopped: false,
    reconnectTimer: null,
    reconnectAttempts: 0,
    disconnecting: null, // in-flight disconnect promise
    contacts: new Map(), // jid -> { name, notify }
    history: new Map(), // chatId -> Message[] (newest last)
    lastKeys: new Map(), // chatId -> last incoming message key (for markRead)
    historyDirty: false,
    offline: false, // true after a drop until reconnect
  };

  const mediaDir = () => {
    const dir = path.join(ctx.dataDir, 'media');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  function log(level, msg, meta) {
    try { ctx.log(level, `[whatsapp] ${msg}`, meta); } catch { /* logger must never throw */ }
  }

  function emit(type, payload) {
    if (state.stopped) return;
    try { ctx.emit(type, payload); } catch (e) {
      log('warn', `emit ${type} failed: ${e.message}`);
    }
  }

  function status(stateName, error) {
    const payload = { state: stateName };
    if (error) payload.error = error;
    emit('status', payload);
  }

  // ---------------------------------------------------------------- history

  function historyPath() { return path.join(ctx.dataDir, HISTORY_FILE); }

  function loadHistoryCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [chatId, msgs] of Object.entries(raw)) {
          if (Array.isArray(msgs)) state.history.set(chatId, msgs);
        }
      }
    } catch { /* absent or corrupt cache — start empty */ }
  }

  function saveHistoryCache() {
    try {
      const obj = {};
      for (const [chatId, msgs] of state.history) obj[chatId] = msgs;
      fs.mkdirSync(ctx.dataDir, { recursive: true });
      fs.writeFileSync(historyPath(), JSON.stringify(obj), 'utf8');
      state.historyDirty = false;
    } catch (e) {
      log('warn', `history save failed: ${e.message}`);
    }
  }

  function cacheMessage(chatId, msg) {
    if (!chatId || !msg) return;
    let arr = state.history.get(chatId);
    if (!arr) { arr = []; state.history.set(chatId, arr); }
    if (arr.some((m) => m.id === msg.id && m.ts === msg.ts)) return;
    arr.push(msg);
    if (arr.length > HISTORY_CAP) arr.splice(0, arr.length - HISTORY_CAP);
    state.historyDirty = true;
  }

  function flushHistorySoon() {
    if (!state.historyDirty) return;
    setTimeout(() => { if (state.historyDirty) saveHistoryCache(); }, 3000).unref?.();
  }

  // ------------------------------------------------------------ contacts/UI

  function contactName(jid) {
    const norm = jidNormalizedUser(jid || '');
    const c = state.contacts.get(norm);
    return c?.notify || c?.name || (isGroupJid(jid) ? undefined : norm.split('@')[0]);
  }

  function chatPayload(chatId, extra) {
    const kind = isGroupJid(chatId) ? 'group' : 'dm';
    let title = undefined;
    if (isGroupJid(chatId)) {
      const meta = state.contacts.get(jidNormalizedUser(chatId));
      title = meta?.subject || extra?.title || chatId;
    } else {
      title = contactName(chatId) || extra?.title || chatId;
    }
    return {
      id: chatId,
      kind,
      title,
      ts: extra?.ts || Date.now(),
      unread: extra?.unread ?? 0,
      ...(extra?.muted !== undefined ? { muted: !!extra.muted } : {}),
    };
  }

  function chatIdFromMessage(msg) {
    const remote = msg?.key?.remoteJid;
    if (!remote) return undefined;
    // Status broadcast — still a "channel"-ish chat; map to dm, filter later if needed
    return remote;
  }

  function messageFromBaileys(msg, chatId) {
    const key = msg.key;
    if (!key) return undefined;
    const tsSec = typeof msg.messageTimestamp === 'number'
      ? msg.messageTimestamp
      : Number(msg.messageTimestamp?.toNumber?.() ?? Date.now() / 1000);
    const ts = tsSec > 0 ? tsSec * 1000 : Date.now();
    const out = !!key.fromMe;
    let senderId = out
      ? jidNormalizedUser(state.sock?.user?.id || '')
      : jidNormalizedUser(key.participant || chatId);
    if (!senderId) senderId = 'me';

    const mediaKind = extractMediaKind(msg.message);
    const base = {
      id: `${key.id}`,
      chatId,
      senderId,
      ts,
      out,
    };
    const senderName = out
      ? (state.sock?.user?.name || undefined)
      : contactName(senderId);
    if (senderName) base.senderName = senderName;

    if (mediaKind) {
      base.media = { kind: mediaKind };
      const name = mediaMessageName(msg.message);
      if (name) base.media.name = name;
      const mime = msg.message?.documentMessage?.mimetype
        || msg.message?.imageMessage?.mimetype
        || msg.message?.videoMessage?.mimetype
        || msg.message?.audioMessage?.mimetype;
      if (mime) base.media.mime = String(mime);
    } else {
      const text = extractText(msg.message);
      if (text) base.text = text;
    }
    const replyTo = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
    if (replyTo) base.replyTo = String(replyTo);
    return base;
  }

  async function downloadToMedia(msg, msgMeta) {
    try {
      const buf = await downloadMediaMessage(
        { message: msg.message, key: msg.key },
        'buffer',
        { reuploadRequest: state.sock?.updateMediaMessage.bind(state.sock) },
      );
      if (!buf || !buf.length) return undefined;
      const ext = mimeExt(msgMeta?.mime);
      const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      const filePath = path.join(mediaDir(), name);
      fs.writeFileSync(filePath, buf);
      return filePath;
    } catch (e) {
      log('warn', `media download failed: ${e.message}`);
      return undefined;
    }
  }

  function mimeExt(mime) {
    if (!mime) return '.bin';
    const found = Object.entries(MIME_BY_EXT).find(([, m]) => m === mime);
    return found ? found[0] : '.bin';
  }

  // ----------------------------------------------------------------- events

  function wireEvents() {
    const sock = state.sock;
    if (!sock) return;

    sock.ev.on('connection.update', onConnectionUpdate);
    sock.ev.on('creds.update', () => { /* persisted by useMultiFileAuthState */ });
    sock.ev.on('chats.upsert', (chats) => {
      try {
        for (const c of chats) {
          if (!c?.id) continue;
          const ts = lastActivityTs(c);
          emit('chat', chatPayload(c.id, { ts, unread: c.unreadCount ?? 0, muted: c.muted }));
        }
      } catch (e) { log('warn', `chats.upsert: ${e.message}`); }
    });
    sock.ev.on('chats.update', (chats) => {
      try {
        for (const c of chats) {
          if (!c?.id) continue;
          const ts = lastActivityTs(c);
          emit('chat', chatPayload(c.id, { ts, unread: c.unreadCount ?? 0, muted: c.muted }));
        }
      } catch (e) { log('warn', `chats.update: ${e.message}`); }
    });
    sock.ev.on('contacts.upsert', (contacts) => {
      try {
        for (const c of contacts) {
          if (!c?.id) continue;
          const norm = jidNormalizedUser(c.id);
          const prev = state.contacts.get(norm) || {};
          state.contacts.set(norm, {
            name: c.name ?? prev.name,
            notify: c.notify ?? prev.notify,
            subject: c.subject ?? prev.subject,
          });
        }
      } catch (e) { log('warn', `contacts.upsert: ${e.message}`); }
    });
    sock.ev.on('contacts.update', (contacts) => {
      try {
        for (const c of contacts) {
          if (!c?.id) continue;
          const norm = jidNormalizedUser(c.id);
          const prev = state.contacts.get(norm) || {};
          state.contacts.set(norm, { ...prev, ...pickDefined(c, ['name', 'notify', 'subject']) });
        }
      } catch (e) { log('warn', `contacts.update: ${e.message}`); }
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      void handleUpsert(messages, type).catch((e) => log('warn', `messages.upsert: ${e.message}`));
    });
    sock.ev.on('messages.update', (updates) => {
      try {
        for (const u of updates) {
          if (!u?.key) continue;
          const proto = u.message?.protocolMessage;
          if (proto?.type === 14 /* PROTOCOL_MESSAGE_TYPE.REVOKE */ || proto?.editedMessage) {
            const chatId = u.key.remoteJid;
            if (!chatId) continue;
            const edited = messageFromBaileys(
              { key: proto.key || u.key, message: proto.editedMessage?.message || proto.editedMessage, messageTimestamp: u.messageTimestamp },
              chatId,
            );
            if (edited) { edited.edited = true; emit('message-edit', edited); }
          }
          // Pure delivery/read-status updates carry no content — nothing to emit.
        }
      } catch (e) { log('warn', `messages.update: ${e.message}`); }
    });
    sock.ev.on('messaging-history.set', ({ messages }) => {
      try {
        for (const m of messages) {
          if (!m?.key?.remoteJid) continue;
          const chatId = m.key.remoteJid;
          const norm = messageFromBaileys(m, chatId);
          if (!norm || (!norm.text && !norm.media)) continue;
          if (norm.media && !norm.media.path) {
            // Historic media is often expired; keep metadata without a path.
          }
          cacheMessage(chatId, norm);
        }
        saveHistoryCache();
        log('debug', `history set: ${messages.length} messages cached`);
      } catch (e) { log('warn', `messaging-history.set: ${e.message}`); }
    });
    sock.ev.on('presence.update', ({ ids, presences }) => {
      try {
        for (const id of ids || []) {
          const p = presences?.[id];
          if (p?.lastKnownPresence === 'composing') emit('typing', { chatId: id, who: id });
        }
      } catch (e) { log('warn', `presence.update: ${e.message}`); }
    });
  }

  function pickDefined(obj, keys) {
    const out = {};
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
    return out;
  }

  function lastActivityTs(c) {
    const t = c.lastMessageTimestamp ?? c.t ?? c.conversationTimestamp;
    if (typeof t === 'number' && t > 0) return t < 1e12 ? t * 1000 : t;
    return Date.now();
  }

  async function handleUpsert(messages, type) {
    for (const m of messages || []) {
      if (!m?.key?.remoteJid) continue;
      const chatId = m.key.remoteJid;
      const norm = messageFromBaileys(m, chatId);
      if (!norm) continue;

      // protocolMessage edits arrive as upserts; revokes drop the message
      const proto = m.message?.protocolMessage;
      if (proto?.editedMessage) {
        const edited = messageFromBaileys(
          { key: proto.key || m.key, message: proto.editedMessage?.message || proto.editedMessage, messageTimestamp: m.messageTimestamp },
          chatId,
        );
        if (edited) { edited.edited = true; emit('message-edit', edited); }
        continue;
      }
      if (proto) continue; // other protocol frames (revoke, ephemeral timer…) are not messages

      if (!norm.text && !norm.media) continue;

      // "append" = our own sends echoed back; only notify-type are new incoming
      const isOutgoingEcho = type === 'append';

      if (norm.media && !isOutgoingEcho) {
        const p = await downloadToMedia(m, norm.media);
        if (p) norm.media.path = p;
      }

      emit('message', norm);
      cacheMessage(chatId, norm);
      if (!norm.out) {
        state.lastKeys.set(chatId, m.key);
      }
      emit('chat', chatPayload(chatId, { ts: norm.ts, unread: 0 }));
    }
    flushHistorySoon();
  }

  function onConnectionUpdate(update) {
    try {
      const { connection, lastDisconnect, qr } = update;
      if (qr && state.waitingForQr) {
        state.waitingForQr(qr);
        return;
      }
      if (connection === 'open') {
        if (state.onOpen) { const f = state.onOpen; state.onOpen = null; f(); }
        state.reconnectAttempts = 0;
        state.offline = false;
        status('online');
        return;
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
          ?? lastDisconnect?.error?.error?.output?.statusCode;
        handleConnectionClosed(code);
        return;
      }
      if (connection === 'connecting') status('connecting');
    } catch (e) {
      log('warn', `connection.update: ${e.message}`);
    }
  }

  function handleConnectionClosed(statusCode) {
    if (state.stopped) return;
    if (statusCode === DisconnectReason.loggedOut) {
      // session revoked on the phone — auth must be cleared, re-pair required
      try {
        fs.rmSync(path.join(ctx.dataDir, 'auth'), { recursive: true, force: true });
      } catch (e) { log('warn', `auth cleanup failed: ${e.message}`); }
      const err = 'WhatsApp-сессия отключена на телефоне — требуется повторное сопряжение (QR)';
      log('error', err);
      if (state.onOpen) { const f = state.onOpen; state.onOpen = null; f(new Error(err)); }
      if (state.qrWaiter) { const f = state.qrWaiter; state.qrWaiter = null; f(new Error(err)); }
      status('error', err);
      state.stopped = true; // no auto-reconnect after logout; user must re-pair
      void state.sock?.end?.(new Error(err));
      return;
    }
    // network drop / restartRequired / etc. — reconnect with backoff
    if (state.onOpen) {
      const f = state.onOpen; state.onOpen = null;
      f(new Error('connection closed during connect'));
      return;
    }
    state.offline = true;
    status('offline');
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (state.stopped || state.reconnectTimer) return;
    state.reconnectAttempts += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (state.reconnectAttempts - 1), RECONNECT_MAX_MS);
    log('info', `reconnecting in ${delay}ms (attempt ${state.reconnectAttempts})`);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      void startSocket().catch((e) => log('error', `reconnect failed: ${e.message}`));
    }, delay);
    if (state.reconnectTimer.unref) state.reconnectTimer.unref();
  }

  // ---------------------------------------------------------------- connect

  async function startSocket() {
    const authDir = path.join(ctx.dataDir, 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    const registered = !!(authState.creds && authState.creds.registered);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (e) {
      log('warn', `fetchLatestBaileysVersion failed (${e.message}); using default`);
    }
    state.sock = makeWASocket({
      version,
      auth: authState,
      browser: Browsers.macOS('MSHH'),
      markOnlineOnConnect: true,
      syncFullHistory: false,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
    });
    state.sock.ev.on('creds.update', saveCreds);
    wireEvents();
    return registered;
  }

  async function connect() {
    if (state.sock) return; // idempotent
    state.stopped = false;
    status('connecting');
    loadHistoryCache();

    const registered = await startSocket();

    try {
      if (registered) {
        // existing session: wait for open
        await waitConnected(CONNECT_TIMEOUT_MS);
      } else {
        // fresh profile: drive QR pairing through ctx.prompt
        await pairViaQr();
        await waitConnected(CONNECT_TIMEOUT_MS);
      }
    } catch (e) {
      await disconnect();
      throw e;
    }
    log('info', `online as ${state.sock?.user?.id || '?'}`);
  }

  function waitConnected(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.onOpen = null;
        reject(new Error('WhatsApp: не удалось подключиться (таймаут)'));
      }, timeoutMs);
      state.onOpen = (err) => {
        clearTimeout(timer);
        err ? reject(err) : resolve();
      };
    });
  }

  async function pairViaQr() {
    // wait for the first qr string from the server
    const qrStr = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.waitingForQr = null;
        reject(new Error('WhatsApp: сервер не прислал QR (таймаут)'));
      }, CONNECT_TIMEOUT_MS);
      state.waitingForQr = (qr) => {
        clearTimeout(timer);
        state.waitingForQr = null;
        resolve(qr);
      };
    });

    const png = await QRCode.toBuffer(qrStr, { type: 'png', margin: 1, width: 512 });

    const answer = await ctx.prompt({
      kind: 'qr',
      title: 'WhatsApp — привязка устройства',
      detail: 'Отсканируйте QR-код: WhatsApp на телефоне → Настройки → Связанные устройства → Привязать устройство',
      qr: png,
      timeoutMs: QR_TIMEOUT_MS,
    });
    if (!answer || !answer.value) {
      // baileys rotates qr on failure; if the user cancelled we stop cleanly
      throw new Error('Вход отменён — QR не был подтверждён');
    }
    // qr pairing: server confirms pairing via connection.update open; the
    // prompt answer only signals the user scanned it (answer.value is unused).
  }

  // ------------------------------------------------------- contract methods

  async function loadHistory(chatId, opts = {}) {
    const limit = opts.limit ?? 50;
    const before = opts.beforeTs;
    const arr = state.history.get(chatId) || [];
    let filtered = arr.filter((m) => (before == null || m.ts < before));
    filtered = filtered.slice(-limit); // newest last, but only `limit` of them
    return filtered.slice().reverse(); // contract: new messages first
  }

  async function sendMessage(chatId, draft = {}) {
    if (!state.sock || state.stopped) throw new Error('WhatsApp: не подключено');
    let jid = chatId;
    let content;
    let mediaMeta;

    if (Array.isArray(draft.files) && draft.files.length > 0) {
      const f = draft.files[0];
      if (!f?.path || !fs.existsSync(f.path)) throw new Error(`Файл не найден: ${f?.path}`);
      const mime = mimeForFile(f.path);
      const fileName = f.name || path.basename(f.path);
      if (mime.startsWith('image/')) content = { image: fs.readFileSync(f.path), mimetype: mime, fileName, caption: draft.text };
      else if (mime.startsWith('video/')) content = { video: fs.readFileSync(f.path), mimetype: mime, fileName, caption: draft.text };
      else if (mime.startsWith('audio/')) content = { audio: fs.readFileSync(f.path), mimetype: mime, fileName };
      else content = { document: fs.readFileSync(f.path), mimetype: mime, fileName, caption: draft.text };
      mediaMeta = { kind: mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file', name: fileName, mime };
    } else {
      content = { text: draft.text || '' };
    }

    const sent = await state.sock.sendMessage(jid, content);
    const norm = messageFromBaileys(sent, jid);
    if (!norm) {
      // baileys returned no full message; fabricate from draft
      norm = {
        id: Date.now().toString(),
        chatId: jid,
        senderId: state.sock.user?.id ? jidNormalizedUser(state.sock.user.id) : 'me',
        ts: Date.now(),
        out: true,
      };
    }
    if (draft.text && mediaMeta) norm.text = draft.text;
    else if (mediaMeta) norm.media = { ...mediaMeta };
    else if (!norm.text && draft.text) norm.text = draft.text;
    if (!norm.out) norm.out = true;
    if (norm.senderName) delete norm.senderName;

    cacheMessage(jid, norm);
    flushHistorySoon();
    emit('chat', chatPayload(jid, { ts: norm.ts, unread: 0 }));
    return norm;
  }

  async function markRead(chatId) {
    if (!state.sock || state.stopped) return;
    const key = state.lastKeys.get(chatId);
    if (!key) return;
    try {
      await state.sock.readMessages([key]);
      state.lastKeys.delete(chatId);
    } catch (e) { log('warn', `markRead: ${e.message}`); }
  }

  async function sendTyping(chatId) {
    if (!state.sock || state.stopped) return;
    try {
      await state.sock.sendPresenceUpdate('composing', chatId);
    } catch (e) { log('warn', `sendTyping: ${e.message}`); }
  }

  async function disconnect() {
    state.stopped = true;
    if (state.disconnecting) return state.disconnecting;
    state.disconnecting = (async () => {
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
      if (state.historyDirty) saveHistoryCache();
      const sock = state.sock;
      state.sock = null;
      state.onOpen = null;
      state.waitingForQr = null;
      if (sock) {
        try { sock.ev.removeAllListeners('connection.update'); } catch { /* already gone */ }
        try { sock.ev.removeAllListeners('messages.upsert'); } catch { /* already gone */ }
        try { sock.ev.removeAllListeners('messages.update'); } catch { /* already gone */ }
        try { await sock.end(new Error('disconnect')); } catch { /* socket already dead */ }
      }
    })();
    await state.disconnecting;
    state.disconnecting = null;
  }

  return { connect, disconnect, loadHistory, sendMessage, markRead, sendTyping };
};
