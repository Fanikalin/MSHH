'use strict';

// Telegram module for MSHH — MTProto via GramJS (`telegram`, already installed
// at the repo root). Auth: phone + login code (+ optional 2FA cloud password),
// session persisted as a GramJS StringSession in ctx.dataDir/session.string.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const bigInt = require('big-integer');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Raw } = require('telegram/events');
const { UpdateConnectionState } = require('telegram/network');
const { computeCheck } = require('telegram/Password');
const QRCode = require('qrcode');

// Public Telegram-desktop api credentials — fallback when the profile leaves
// apiId/apiHash empty (matches the help text in manifest.json).
const DEFAULT_API_ID = 6;
const DEFAULT_API_HASH = 'eb06d4abfb49dc3eeb1aeb98ae0f581e';

// Персональная сборка (scripts/build-share.cjs): ключи, вшитые в
// mshh_modules/telegram/app-defaults.json (в git не попадает). Файл
// необязателен: без него работают публичные DEFAULT_*.
let BUNDLED_DEFAULTS = null;
try {
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, 'app-defaults.json'), 'utf8'));
  const bundledId = Number(bundled?.apiId);
  if (Number.isFinite(bundledId) && bundledId > 0 && /^[0-9a-f]{32}$/i.test(String(bundled?.apiHash || ''))) {
    BUNDLED_DEFAULTS = { apiId: bundledId, apiHash: String(bundled.apiHash) };
  }
} catch {
  BUNDLED_DEFAULTS = null; // файла нет — обычный режим репозитория
}

const SYNC_DIALOGS_LIMIT = 200;
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;
const CONNECT_DEADLINE_MS = 15000;
const SENDCODE_DEADLINE_MS = 10000;
const SEND_DEDUPE_MS = 15000;
const WATCHDOG_INTERVAL_MS = 15000;
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 300000;
const PROMPT_TIMEOUT_MS = 300000;
const QR_PROMPT_MS = 30000; // совпадает с QR_CODE_TIMEOUT GramJS — обновление QR каждые 30с

/** Пользователь отказался от QR-входа («Отмена» / пустой ввод) → вход по коду. */
class QrCancelled extends Error {}

function tgQrUrl(token) {
  return `tg://login?token=${Buffer.from(token).toString('base64url')}`;
}

// ---------- small helpers ----------

/** Race a promise against a deadline; the loser is not left unhandled. */
function withDeadline(promise, ms, message) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // If the deadline wins, make sure the losing promise never becomes an
  // unhandled rejection.
  promise.catch(() => {});
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

function sanitizeName(name, fallback) {
  const s = String(name || '').replace(/[^A-Za-z0-9._-]+/g, '_');
  return s || fallback;
}

function entityName(entity) {
  if (!entity) return undefined;
  if (entity.title) return entity.title;
  const n = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
  if (n) return n;
  if (entity.username) return `@${entity.username}`;
  return undefined;
}

function mediaKind(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function mimeExt(mime) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/mp4': '.m4a',
    'application/pdf': '.pdf', 'text/plain': '.txt', 'application/zip': '.zip',
  };
  return map[mime] || '.bin';
}

function bigToNumber(v) {
  if (v == null) return undefined;
  const n = Number(typeof v === 'object' && v.toString ? v.toString() : v);
  return Number.isFinite(n) ? n : undefined;
}

/** Wrap a GramJS RPC error into readable text. */
function friendlyError(e, fallback) {
  const code = String(e?.errorMessage || '');
  if (code === 'SESSION_PASSWORD_NEEDED') return new Error('Telegram: для этого аккаунта нужен облачный пароль (2FA)');
  if (code === 'PHONE_CODE_INVALID') return new Error('Telegram: неверный код подтверждения');
  if (code === 'PHONE_CODE_EXPIRED') return new Error('Telegram: код истёк — попробуйте войти заново');
  if (code === 'PHONE_NUMBER_INVALID') return new Error('Telegram: неверный номер телефона');
  if (code === 'PHONE_NUMBER_BANNED') return new Error('Telegram: номер заблокирован');
  if (code === 'PASSWORD_HASH_INVALID') return new Error('Telegram: неверный облачный пароль');
  if (code === 'API_ID_INVALID' || code === 'API_ID_PUBLISHED_FLOOD') {
    return new Error('Telegram: неверные api_id/api_hash — укажите свои с my.telegram.org');
  }
  if (code.startsWith('FLOOD_WAIT_') || e?.className === 'FloodWaitError') {
    const sec = Number(e?.seconds) || Number(String(code).split('_').pop()) || 0;
    const wait = sec >= 3600 ? `${Math.ceil(sec / 3600)} ч` : sec >= 60 ? `${Math.ceil(sec / 60)} мин` : `${sec} с`;
    return new Error(`Telegram: слишком много попыток — подождите ${wait}`);
  }
  if (code === 'AUTH_KEY_UNREGISTERED' || code === 'AUTH_KEY_INVALID' || code === 'SESSION_REVOKED') {
    return new Error('Telegram: сессия отозвана — выполните вход заново');
  }
  if (code === 'PEER_ID_INVALID') return new Error('Telegram: чат недоступен для этого аккаунта');
  if (code) return new Error(`Telegram: ${code}`);
  return e instanceof Error ? e : new Error(fallback || String(e));
}

/**
 * chatId encoding (stable across restarts, carries MTProto access hashes):
 *   dm               → "u_<userId>_<accessHash>"
 *   small group chat → "g_<chatId>"
 *   megagroup        → "g_<channelId>_<accessHash>"
 *   broadcast channel→ "c_<channelId>_<accessHash>"
 */
function parseChatId(chatId) {
  const parts = String(chatId || '').split('_');
  const prefix = parts[0];
  const id = parts[1];
  const hash = parts[2];
  if (!/^\d+$/.test(id || '')) return null;
  if (prefix === 'u' || prefix === 'c') {
    if (!/^\d+$/.test(hash || '')) return null;
    return { prefix, id, hash };
  }
  if (prefix === 'g') {
    if (parts.length === 2) return { prefix, id, hash: undefined };
    if (/^\d+$/.test(hash || '')) return { prefix, id, hash };
  }
  return null;
}

/** Build an MTProto input peer from a parsed chatId (uses the entity cache when the hash is unknown). */
async function buildInputPeer(client, parsed) {
  if (parsed.prefix === 'g' && parsed.hash === undefined) {
    return new Api.InputPeerChat({ chatId: Number(parsed.id) });
  }
  if (parsed.hash && parsed.hash !== '0') {
    const hash = bigInt(parsed.hash);
    if (parsed.prefix === 'u') {
      return new Api.InputPeerUser({ userId: bigInt(parsed.id), accessHash: hash });
    }
    return new Api.InputPeerChannel({ channelId: bigInt(parsed.id), accessHash: hash });
  }
  // no stored hash — resolve through the session entity cache
  return await client.getInputEntity(bigInt(parsed.id));
}

// Media types we do not download (no file payload behind them).
const SKIP_MEDIA = new Set([
  'MessageMediaWebPage', 'MessageMediaGeo', 'MessageMediaGeoLive', 'MessageMediaContact',
  'MessageMediaDice', 'MessageMediaGame', 'MessageMediaPoll', 'MessageMediaInvoice',
]);

function create(ctx) {
  const ctxLog = (level, msg, meta) => {
    try { ctx.log(level, `[telegram] ${msg}`, meta); } catch { /* logging must never throw */ }
  };
  const safe = (fn, fallback) => {
    try { return fn(); } catch { return fallback; }
  };

  const mod = {
    _client: undefined,
    _rawEvent: undefined,
    _stopped: true,
    _authed: false,          // true only after a passing getMe()
    _connecting: undefined,
    _state: 'offline',
    _wdTimer: undefined,
    _reconnectTimer: undefined,
    _reconnecting: false,
    _reconnectAttempts: 0,
    _meId: undefined,
    _meHash: undefined,
    _meName: undefined,
    _chatCache: new Map(),   // chatId -> Chat
    _peerIndex: new Map(),   // 'u:<id>' | 'chat:<id>' | 'ch:<cid>' -> chatId
    _recentSent: new Map(),  // msgId -> ts (dedupe our own send updates)
    _mediaDir: path.join(ctx.dataDir, 'media'),
    _sessionPath: path.join(ctx.dataDir, 'session.string'),
  };

  function emitStatus(state, error) {
    if (mod._stopped) return;
    mod._state = state;
    try { ctx.emit('status', error ? { state, error } : { state }); } catch { /* ignore */ }
  }

  function emitEvent(type, payload) {
    if (mod._stopped) return;
    try { ctx.emit(type, payload); } catch { /* ignore */ }
  }

  function requireClient() {
    if (!mod._client) throw new Error('Telegram: не подключено (профиль выключен или вход не выполнен)');
    return mod._client;
  }

  // 401-class errors: the auth key is no longer valid for this account.
  const AUTH_ERROR_CODES = new Set([
    'AUTH_KEY_UNREGISTERED', 'AUTH_KEY_INVALID', 'AUTH_KEY_DUPLICATED',
    'SESSION_REVOKED', 'SESSION_EXPIRED',
  ]);

  function isAuthError(e) {
    return AUTH_ERROR_CODES.has(String(e?.errorMessage || ''));
  }

  /**
   * The session died in the background (revoked/expired): wipe it, stop the
   * machinery and flip the profile to "error" — never keep running as if
   * nothing happened.
   */
  function handleAuthRevoked() {
    if (mod._stopped || !mod._authed) return;
    mod._authed = false;
    try { fs.rmSync(mod._sessionPath, { force: true }); } catch { /* ignore */ }
    if (mod._wdTimer) { clearInterval(mod._wdTimer); mod._wdTimer = undefined; }
    if (mod._reconnectTimer) { clearTimeout(mod._reconnectTimer); mod._reconnectTimer = undefined; }
    mod._reconnecting = false;
    mod._chatCache.clear();
    mod._peerIndex.clear();
    mod._recentSent.clear();
    const client = mod._client;
    mod._client = undefined;
    emitStatus('error', 'Telegram: сессия отозвана — выполните вход заново');
    if (client) {
      withDeadline(client.destroy(), 5000, 'disconnect timeout').catch(() => {});
    }
  }

  /** Shared tail for update handlers: revoke on 401, log anything else. */
  function swallowUpdateError(e, what) {
    if (isAuthError(e)) {
      handleAuthRevoked();
      return;
    }
    ctxLog('debug', `${what}: ${e.message}`);
  }

  function indexChat(chat, keys) {
    mod._chatCache.set(chat.id, chat);
    for (const k of keys) mod._peerIndex.set(k, chat.id);
  }

  function chatTitle(chatId) {
    return mod._chatCache.get(chatId)?.title;
  }

  // ---------- chat/message normalization ----------

  function chatFromDialog(dialog) {
    const entity = dialog.entity;
    if (!entity) return null;

    let kind;
    let chatId;
    let keys;

    if (dialog.isUser || entity.className === 'User' || entity.className === 'UserEmpty') {
      kind = 'dm';
      const uid = String(entity.id);
      const hash = entity.accessHash ? String(entity.accessHash) : '0';
      chatId = `u_${uid}_${hash}`;
      keys = [`u:${uid}`];
    } else if (entity.className === 'Channel' || entity.className === 'ChannelForbidden') {
      const cid = String(entity.id);
      const hash = entity.accessHash ? String(entity.accessHash) : '0';
      const broadcast = entity.broadcast === true && entity.megagroup !== true;
      kind = broadcast ? 'channel' : 'group';
      chatId = `${broadcast ? 'c' : 'g'}_${cid}_${hash}`;
      keys = [`ch:${cid}`];
    } else {
      kind = 'group';
      chatId = `g_${String(entity.id)}`;
      keys = [`chat:${String(entity.id)}`];
    }

    const ts = Number(dialog.date || (dialog.message && dialog.message.date) || 0) * 1000 || Date.now();
    const chat = {
      id: chatId,
      kind,
      title: dialog.title || dialog.name || entityName(entity) || chatId,
      ts,
      unread: Number(dialog.unreadCount || 0),
    };
    if (entity.username) chat.subtitle = `@${entity.username}`;
    if (dialog.dialog && dialog.dialog.muted) chat.muted = true;
    return { chat, keys };
  }

  async function syncChats(limit = SYNC_DIALOGS_LIMIT) {
    const client = requireClient();
    const dialogs = await client.getDialogs({ limit });
    let emitted = 0;
    for (const dialog of dialogs) {
      try {
        const entry = chatFromDialog(dialog);
        if (!entry) continue;
        indexChat(entry.chat, entry.keys);
        emitEvent('chat', entry.chat);
        emitted++;
      } catch (e) {
        ctxLog('warn', `диалог пропущен: ${e.message}`);
      }
    }
    ctxLog('info', `синхронизировано чатов: ${emitted}`);
    return emitted;
  }

  async function tryAccessHash(idStr) {
    const client = requireClient();
    try {
      const peer = await client.getInputEntity(bigInt(idStr));
      if (peer && peer.accessHash) return String(peer.accessHash);
    } catch { /* cache miss */ }
    return '0';
  }

  function safeSender(msg) { return safe(() => msg.sender, null); }
  function safeChat(msg) { return safe(() => msg.chat, null); }

  /**
   * Resolve (and register) the chat for an incoming message. Emits a chat
   * upsert when the chat is new (e.g. a first DM from an unknown user).
   */
  async function resolveChatFromMessage(msg) {
    const peerId = msg.peerId;
    if (!peerId) return null;

    if (peerId instanceof Api.PeerUser) {
      const uid = String(peerId.userId);
      const cachedId = mod._peerIndex.get(`u:${uid}`);
      if (cachedId) return { chatId: cachedId, kind: 'dm' };
      const entity = safeSender(msg) || safeChat(msg);
      let hash = '0';
      if (entity && entity.className === 'User' && entity.accessHash) hash = String(entity.accessHash);
      else if (uid === mod._meId && mod._meHash) hash = mod._meHash;
      else hash = await tryAccessHash(uid);
      const chatId = `u_${uid}_${hash}`;
      const chat = {
        id: chatId,
        kind: 'dm',
        title: entityName(entity) || chatId,
        ts: Number(msg.date || 0) * 1000 || Date.now(),
        unread: msg.out ? 0 : 1,
      };
      if (entity && entity.username) chat.subtitle = `@${entity.username}`;
      indexChat(chat, [`u:${uid}`]);
      emitEvent('chat', chat);
      return { chatId, kind: 'dm' };
    }

    if (peerId instanceof Api.PeerChat) {
      const gid = String(peerId.chatId);
      const cachedId = mod._peerIndex.get(`chat:${gid}`);
      if (cachedId) return { chatId: cachedId, kind: 'group' };
      const entity = safeChat(msg);
      const chatId = `g_${gid}`;
      const chat = {
        id: chatId,
        kind: 'group',
        title: entityName(entity) || chatId,
        ts: Number(msg.date || 0) * 1000 || Date.now(),
        unread: msg.out ? 0 : 1,
      };
      indexChat(chat, [`chat:${gid}`]);
      emitEvent('chat', chat);
      return { chatId, kind: 'group' };
    }

    if (peerId instanceof Api.PeerChannel) {
      const cid = String(peerId.channelId);
      const cachedId = mod._peerIndex.get(`ch:${cid}`);
      if (cachedId) {
        return { chatId: cachedId, kind: cachedId.startsWith('c_') ? 'channel' : 'group' };
      }
      const entity = safeChat(msg);
      const broadcast = entity && entity.className === 'Channel'
        ? (entity.broadcast === true && entity.megagroup !== true)
        : false;
      const hash = entity && entity.accessHash ? String(entity.accessHash) : await tryAccessHash(cid);
      const chatId = `${broadcast ? 'c' : 'g'}_${cid}_${hash}`;
      const chat = {
        id: chatId,
        kind: broadcast ? 'channel' : 'group',
        title: entityName(entity) || chatId,
        ts: Number(msg.date || 0) * 1000 || Date.now(),
        unread: msg.out ? 0 : 1,
      };
      indexChat(chat, [`ch:${cid}`]);
      emitEvent('chat', chat);
      return { chatId, kind: broadcast ? 'channel' : 'group' };
    }

    return null;
  }

  async function downloadMedia(msg, chatId) {
    const m = msg.media;
    if (!m || SKIP_MEDIA.has(m.className)) return undefined;
    if (m.className === 'MessageMediaDocument' && !m.document) return undefined;

    const file = safe(() => msg.file, null);
    const mime = (file && file.mimeType) || (m.className === 'MessageMediaPhoto' ? 'image/jpeg' : undefined);
    const kind = mediaKind(mime);
    const origName = (file && file.name)
      || (m.className === 'MessageMediaPhoto' ? `photo_${msg.id}.jpg` : `file_${msg.id}`);
    const name = sanitizeName(origName, `file_${msg.id}`);
    const size = bigToNumber(file && file.size);

    const dir = path.join(mod._mediaDir, sanitizeName(chatId, 'chat'));
    fs.mkdirSync(dir, { recursive: true });
    let fname = `${msg.id}_${name}`;
    if (!path.extname(fname)) fname += mimeExt(mime);
    const filePath = path.join(dir, fname);

    await msg.downloadMedia({ outputFile: filePath });
    if (!fs.existsSync(filePath)) return undefined;

    const media = { kind, name, ...(mime ? { mime } : {}) };
    if (size != null) media.size = size;
    media.path = filePath;
    return media;
  }

  async function normalizeMessage(msg, chatId, { download = true } = {}) {
    const out = msg.out === true;
    const senderId = msg.senderId ? `u_${String(msg.senderId)}` : chatId;
    let senderName = entityName(safeSender(msg)) || entityName(safeChat(msg));
    if (!senderName && out && mod._meName) senderName = mod._meName;
    if (!senderName) senderName = chatTitle(chatId);

    let media;
    if (download && msg.media) {
      try {
        media = await downloadMedia(msg, chatId);
      } catch (e) {
        if (isAuthError(e)) {
          handleAuthRevoked();
          throw e;
        }
        ctxLog('warn', `медиа не скачано (${chatId}/${msg.id}): ${e.message}`);
      }
    }

    const message = {
      id: String(msg.id),
      chatId,
      senderId,
      ts: Number(msg.date || 0) * 1000,
      out,
    };
    if (senderName) message.senderName = senderName;
    const text = safe(() => msg.rawText, '') || '';
    if (text.trim()) message.text = text;
    if (media) message.media = media;
    if (msg.replyToMsgId) message.replyTo = String(msg.replyToMsgId);
    if (msg.editDate) message.edited = true;
    return message;
  }

  function touchChat(chatId, ts, incoming) {
    const chat = mod._chatCache.get(chatId);
    if (!chat) return;
    chat.ts = Math.max(chat.ts || 0, ts || Date.now());
    if (incoming && mod._state === 'online') chat.unread = (chat.unread || 0) + 1;
    emitEvent('chat', { ...chat });
  }

  // ---------- live updates ----------

  function onNewMessage(msg) {
    if (msg.out && msg.id != null) {
      const sentAt = mod._recentSent.get(String(msg.id));
      if (sentAt && Date.now() - sentAt < SEND_DEDUPE_MS) return; // our own send — already returned by sendMessage()
    }
    return (async () => {
      const info = await resolveChatFromMessage(msg);
      if (!info) return;
      const message = await normalizeMessage(msg, info.chatId, { download: true });
      touchChat(info.chatId, message.ts, !message.out);
      emitEvent('message', message);
    })();
  }

  function onEditMessage(msg) {
    return (async () => {
      const info = await resolveChatFromMessage(msg);
      if (!info) return;
      const message = await normalizeMessage(msg, info.chatId, { download: false });
      message.edited = true;
      touchChat(info.chatId, message.ts, false);
      emitEvent('message-edit', message);
    })();
  }

  function emitTyping(chatId, fromPeer) {
    if (!chatId) return;
    const who = chatTitle(chatId)
      || (fromPeer && fromPeer instanceof Api.PeerUser ? `u_${String(fromPeer.userId)}` : undefined)
      || chatId;
    emitEvent('typing', { chatId, who });
  }

  function onUpdate(upd) {
    if (mod._stopped) return;
    try {
      if (upd instanceof UpdateConnectionState) {
        // Transport state alone is NOT profile status: before authorization
        // the client is "connected" to a DC yet has no valid session, so
        // anything status-like here must wait for a passing getMe().
        if (!mod._authed) return;
        if (upd.state === UpdateConnectionState.connected) {
          // GramJS announces the sender is up again; only meaningful when we
          // are recovering from a drop. True revocation is caught by the next
          // authorized RPC (401 → handleAuthRevoked).
          if (mod._state === 'offline') {
            mod._reconnectAttempts = 0;
            emitStatus('online');
          }
        } else if (upd.state === UpdateConnectionState.disconnected
          || upd.state === UpdateConnectionState.broken) {
          emitStatus('offline');
          scheduleReconnect();
        }
        return;
      }
      if (upd instanceof Api.UpdateNewMessage || upd instanceof Api.UpdateNewChannelMessage) {
        const msg = upd.message;
        if (!msg || msg.className !== 'Message') return; // skip service messages
        onNewMessage(msg).catch((e) => swallowUpdateError(e, 'update пропущен'));
        return;
      }
      if (upd instanceof Api.UpdateEditMessage || upd instanceof Api.UpdateEditChannelMessage) {
        const msg = upd.message;
        if (!msg || msg.className !== 'Message') return;
        onEditMessage(msg).catch((e) => swallowUpdateError(e, 'edit пропущен'));
        return;
      }
      if (upd instanceof Api.UpdateUserTyping) {
        const chatId = mod._peerIndex.get(`u:${String(upd.userId)}`);
        emitTyping(chatId, upd.userId ? new Api.PeerUser({ userId: upd.userId }) : null);
        return;
      }
      if (upd instanceof Api.UpdateChatUserTyping) {
        emitTyping(mod._peerIndex.get(`chat:${String(upd.chatId)}`), upd.fromId);
        return;
      }
      if (upd instanceof Api.UpdateChannelUserTyping) {
        emitTyping(mod._peerIndex.get(`ch:${String(upd.channelId)}`), upd.fromId);
      }
    } catch (e) {
      ctxLog('debug', `обработка update: ${e.message}`);
    }
  }

  // ---------- reconnect watchdog ----------

  function isUp() {
    try {
      return Boolean(mod._client && mod._client._sender && mod._client._sender.isConnected());
    } catch {
      return false;
    }
  }

  function scheduleReconnect() {
    if (mod._stopped || !mod._authed || mod._reconnecting || mod._reconnectTimer || !mod._client) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** mod._reconnectAttempts, RECONNECT_MAX_MS);
    mod._reconnectAttempts++;
    const timer = setTimeout(() => {
      mod._reconnectTimer = undefined;
      attemptReconnect();
    }, delay);
    if (timer.unref) timer.unref();
    mod._reconnectTimer = timer;
  }

  function attemptReconnect() {
    if (mod._stopped || !mod._authed || !mod._client) return;
    mod._reconnecting = true;
    mod._client.connect()
      .then(async () => {
        mod._reconnecting = false;
        const client = mod._client;
        if (!client || mod._stopped) return;
        // Never report "online" without a passing authorized RPC — the session
        // may have been revoked while we were offline.
        try {
          await client.getMe();
        } catch (e) {
          if (isAuthError(e)) {
            handleAuthRevoked();
            return;
          }
          mod._reconnectAttempts = 0;
          emitStatus('offline');
          scheduleReconnect();
          return;
        }
        mod._reconnectAttempts = 0;
        emitStatus('online');
        try {
          await syncChats(100);
        } catch (e) {
          if (isAuthError(e)) return handleAuthRevoked();
          ctxLog('debug', `ресинхронизация чатов: ${e.message}`);
        }
      })
      .catch((e) => {
        mod._reconnecting = false;
        ctxLog('warn', `переподключение не удалось: ${friendlyError(e, 'нет соединения').message}`);
        scheduleReconnect();
      });
  }

  function startWatchdog() {
    if (mod._wdTimer) return;
    const timer = setInterval(() => {
      if (mod._stopped || !mod._authed || !mod._client) return;
      if (mod._reconnecting || mod._reconnectTimer) return;
      if (isUp()) {
        mod._reconnectAttempts = 0;
        if (mod._state !== 'online') emitStatus('online');
        return;
      }
      if (mod._state !== 'offline') emitStatus('offline');
      scheduleReconnect();
    }, WATCHDOG_INTERVAL_MS);
    if (timer.unref) timer.unref();
    mod._wdTimer = timer;
  }

  // ---------- auth ----------

  function setMe(me) {
    mod._meId = String(me.id);
    mod._meHash = me.accessHash ? String(me.accessHash) : '0';
    mod._meName = entityName(me) || mod._meId;
  }

  function saveSession(client) {
    try {
      const tmp = `${mod._sessionPath}.tmp`;
      fs.writeFileSync(tmp, client.session.save(), 'utf8');
      fs.renameSync(tmp, mod._sessionPath);
    } catch (e) {
      ctxLog('warn', `сессия не сохранена: ${e.message}`);
    }
  }

  /** QR-вход через встроенный helper GramJS: телефон не нужен.
   *  Отказ пользователя → QrCancelled (authFlow переключится на код). */
  async function qrLogin(client, creds) {
    try {
      await client.signInUserWithQrCode(creds, {
        qrCode: async ({ token }) => {
          const png = await QRCode.toBuffer(tgQrUrl(token), { type: 'png', margin: 1, width: 512 });
          // Таймаут промпта длиннее внутреннего цикла GramJS (30с): цикл всегда
          // «выигрывает гонку» и сам перезапрашивает QR с новым токеном —
          // иначе промпт-таймаут роняет весь вход.
          const promptPromise = ctx.prompt({
            kind: 'qr',
            qr: png,
            title: 'Вход по QR',
            detail: 'Отсканируйте в Telegram: Настройки → Устройства → Связать устройство',
            timeoutMs: QR_PROMPT_MS + 5000,
          });
          promptPromise.catch(() => {}); // поздний таймаут не должен стать unhandled
          const answer = await Promise.race([
            promptPromise,
            new Promise((resolve) => setTimeout(() => resolve({ refreshed: true }), QR_PROMPT_MS)),
          ]);
          if (answer?.refreshed) return; // GramJS перезапустит цикл с новым токеном
          if (!answer || answer.value === undefined) throw new QrCancelled();
          // иное разрешение (таймаут формы) — просто ждём следующий QR-токен
        },
        password: async (hint) => {
          const pwdAnswer = await ctx.prompt({
            kind: 'text',
            title: 'Облачный пароль',
            detail: `На аккаунте включена двухфакторная аутентификация${hint ? ` (подсказка: ${hint})` : ''}`,
            timeoutMs: PROMPT_TIMEOUT_MS,
          });
          const password = String(pwdAnswer?.value ?? '');
          if (!password) throw new QrCancelled();
          return password;
        },
        onError: async (err) => {
          if (err instanceof QrCancelled) return true;
          ctxLog('warn', `qr-вход: ${err?.errorMessage || err?.message}`);
          return false;
        },
      });
    } catch (e) {
      if (e instanceof QrCancelled) throw e;
      if (String(e?.message) === 'AUTH_USER_CANCEL') throw new QrCancelled();
      throw friendlyError(e, 'Telegram: вход по QR не выполнен');
    }
  }

  async function authFlow(client, creds, phone) {
    // Сначала QR — телефон не нужен. «Отмена» → вход по коду.
    try {
      await qrLogin(client, creds);
      return;
    } catch (e) {
      if (!(e instanceof QrCancelled)) throw e;
      ctxLog('info', 'QR-вход отменён — переключаюсь на вход по коду');
    }
    if (!phone) throw new Error('Не указан номер телефона — для входа по коду заполните поле «Телефон» и повторите подключение');

    const { phoneCodeHash } = await withDeadline(
      client.sendCode(creds, phone),
      SENDCODE_DEADLINE_MS,
      'Telegram: не удалось отправить код подтверждения (таймаут)',
    ).catch((e) => { throw friendlyError(e, 'Telegram: не удалось отправить код'); });

    const codeAnswer = await ctx.prompt({
      kind: 'code',
      title: 'Код входа Telegram',
      detail: `Мы отправили код в Telegram на номер ${phone}`,
      timeoutMs: PROMPT_TIMEOUT_MS,
    });
    const code = String(codeAnswer?.value ?? '').trim();
    if (!code) throw new Error('Вход отменён: код не введён');

    try {
      await client.invoke(new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code,
      }));
    } catch (e) {
      if (String(e?.errorMessage) !== 'SESSION_PASSWORD_NEEDED') throw friendlyError(e, 'Telegram: вход не выполнен');
      // 2FA — ask for the cloud password
      const pwdAnswer = await ctx.prompt({
        kind: 'text',
        title: 'Облачный пароль',
        detail: 'На аккаунте включена двухфакторная аутентификация — введите облачный пароль',
        timeoutMs: PROMPT_TIMEOUT_MS,
      });
      const password = String(pwdAnswer?.value ?? '');
      if (!password) throw new Error('Вход отменён: пароль не введён');
      try {
        const pwdInfo = await client.invoke(new Api.account.GetPassword());
        const check = await computeCheck(pwdInfo, password);
        await client.invoke(new Api.auth.CheckPassword({ password: check }));
      } catch (e2) {
        throw friendlyError(e2, 'Telegram: вход по паролю не выполнен');
      }
    }
  }

  // ---------- lifecycle ----------

  async function doConnect() {
    fs.mkdirSync(mod._mediaDir, { recursive: true });
    emitStatus('connecting');

    const apiId = Number(ctx.config.apiId);
    const creds = {
      apiId:
        Number.isFinite(apiId) && apiId > 0 ? apiId : (BUNDLED_DEFAULTS?.apiId ?? DEFAULT_API_ID),
      apiHash:
        String(ctx.config.apiHash || '').trim() || BUNDLED_DEFAULTS?.apiHash || DEFAULT_API_HASH,
    };
    const phone = String(ctx.config.phone || '').trim(); // нужен только для входа по коду

    const saved = safe(() => fs.readFileSync(mod._sessionPath, 'utf8').trim(), '') || '';

    const client = new TelegramClient(new StringSession(saved), creds.apiId, creds.apiHash, {
      connectionRetries: 3,
      retryDelay: 1000,
      requestRetries: 2,
      autoReconnect: true,
      useWSS: false,
      deviceModel: 'MSHH Desktop',
      systemVersion: `${os.platform()} ${os.release()}`,
      appVersion: '1.0.0',
      floodSleepThreshold: 60,
    });
    mod._client = client;
    try { client.setLogLevel('none'); } catch { /* optional */ }
    mod._rawEvent = new Raw({});
    client.addEventHandler(onUpdate, mod._rawEvent);

    try {
      // 1. transport: reach a Telegram DC
      await withDeadline(client.connect(), CONNECT_DEADLINE_MS, 'Не удалось подключиться к Telegram (таймаут)');

      // 2. ALWAYS verify authorization before any "online" transition.
      // getMe() is an authorized-only RPC: on a bare connection (fresh or
      // stale session) it answers 401 AUTH_KEY_UNREGISTERED, which routes us
      // into the login flow instead of marking the profile online.
      let me = null;
      try {
        me = await client.getMe();
      } catch (e) {
        if (!isAuthError(e)) throw friendlyError(e, 'Telegram: проверка сессии не выполнена');
        if (saved) {
          // stale/revoked session — drop it and re-auth
          try { fs.rmSync(mod._sessionPath, { force: true }); } catch { /* ignore */ }
          ctxLog('info', 'сохранённая сессия недействительна — повторный вход');
        }
      }

      if (me) {
        setMe(me);
        mod._authed = true;
      } else {
        // 3. interactive auth: phone → code (+ 2FA password), then re-verify.
        await authFlow(client, creds, phone);
        me = await client.getMe(); // if this 401s, the login did not stick → error, never "online"
        if (!me) throw new Error('Telegram: вход не выполнен');
        setMe(me);
        mod._authed = true;
        saveSession(client);
      }

      // 4. initial sync + live loop
      await syncChats();
      startWatchdog();
      emitStatus('online');
    } catch (e) {
      if (isAuthError(e)) handleAuthRevoked(); // e.g. revoked between getMe and sync
      const err = friendlyError(e, 'Telegram: подключение не выполнено');
      emitStatus('error', err.message);
      // a failed connect() must leave nothing running (sockets, update loop)
      try { await withDeadline(client.destroy(), 5000, 'disconnect timeout'); } catch { /* best effort */ }
      if (mod._client === client) mod._client = undefined;
      throw err;
    }
  }

  return {
    async connect() {
      if (mod._stopped) mod._stopped = false;
      if (mod._connecting) return mod._connecting;
      if (mod._client) return; // already connected/connecting (idempotent)
      mod._authed = false; // a fresh connect() must re-verify authorization
      mod._connecting = doConnect().finally(() => { mod._connecting = undefined; });
      return mod._connecting;
    },

    async disconnect() {
      mod._stopped = true;
      if (mod._wdTimer) { clearInterval(mod._wdTimer); mod._wdTimer = undefined; }
      if (mod._reconnectTimer) { clearTimeout(mod._reconnectTimer); mod._reconnectTimer = undefined; }
      mod._reconnecting = false;
      mod._chatCache.clear();
      mod._peerIndex.clear();
      mod._recentSent.clear();
      const client = mod._client;
      mod._client = undefined;
      if (!client) return;
      if (mod._rawEvent) {
        try { client.removeEventHandler(onUpdate, mod._rawEvent); } catch { /* ignore */ }
        mod._rawEvent = undefined;
      }
      try {
        await withDeadline(client.destroy(), 5000, 'disconnect timeout');
      } catch { /* best effort */ }
    },

    async loadHistory(chatId, opts = {}) {
      const client = requireClient();
      const parsed = parseChatId(chatId);
      if (!parsed) throw new Error(`Telegram: неизвестный chatId: ${chatId}`);
      try {
        const peer = await buildInputPeer(client, parsed);
        const limit = Math.max(1, Math.min(Number(opts.limit) || HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT));
        const params = { limit, offsetId: 0 };
        if (opts.beforeTs) params.offsetDate = Math.floor(Number(opts.beforeTs) / 1000);
        const list = await client.getMessages(peer, params);
        const result = [];
        for (const msg of list) {
          if (!msg || msg.className !== 'Message') continue;
          try {
            result.push(await normalizeMessage(msg, chatId, { download: true }));
          } catch (e) {
            ctxLog('warn', `сообщение истории пропущено: ${e.message}`);
          }
        }
        return result; // newest first, per contract
      } catch (e) {
        if (isAuthError(e)) handleAuthRevoked();
        throw friendlyError(e, 'Telegram: загрузка истории не удалась');
      }
    },

    async sendMessage(chatId, draft = {}) {
      const client = requireClient();
      const parsed = parseChatId(chatId);
      if (!parsed) throw new Error(`Telegram: неизвестный chatId: ${chatId}`);
      try {
        const peer = await buildInputPeer(client, parsed);
        const text = String(draft.text ?? '');
        const files = Array.isArray(draft.files) ? draft.files.filter(Boolean) : [];

        let sent;
        if (files.length > 0) {
          const paths = files.map((f) => String(f.path || '')).filter(Boolean);
          if (paths.length === 0) throw new Error('Telegram: в черновике нет файлов с путём');
          for (const p of paths) {
            if (!fs.existsSync(p)) throw new Error(`Telegram: файл не найден: ${p}`);
          }
          sent = await client.sendFile(peer, {
            file: paths.length > 1 ? paths : paths[0],
            caption: text || undefined,
            parseMode: false,
          });
        } else {
          sent = await client.sendMessage(peer, { message: text, parseMode: false });
        }

        const msg = Array.isArray(sent) ? sent[sent.length - 1] : sent;
        if (!msg) throw new Error('Telegram: сервер не вернул отправленное сообщение');
        if (msg.id != null) {
          mod._recentSent.set(String(msg.id), Date.now());
          if (mod._recentSent.size > 500) {
            const oldest = mod._recentSent.keys().next().value;
            mod._recentSent.delete(oldest);
          }
        }
        touchChat(chatId, Date.now(), false);
        return await normalizeMessage(msg, chatId, { download: false });
      } catch (e) {
        if (isAuthError(e)) handleAuthRevoked();
        throw friendlyError(e, 'Telegram: отправка не удалась');
      }
    },

    async markRead(chatId) {
      const client = requireClient();
      const parsed = parseChatId(chatId);
      if (!parsed) throw new Error(`Telegram: неизвестный chatId: ${chatId}`);
      try {
        const peer = await buildInputPeer(client, parsed);
        if (parsed.prefix === 'c' || (parsed.prefix === 'g' && parsed.hash)) {
          await client.invoke(new Api.channels.ReadHistory({ channel: peer, maxId: 0 }));
        } else {
          await client.invoke(new Api.messages.ReadHistory({ peer, maxId: 0 }));
        }
        const chat = mod._chatCache.get(chatId);
        if (chat) {
          chat.unread = 0;
          emitEvent('chat', { ...chat });
        }
      } catch (e) {
        if (isAuthError(e)) handleAuthRevoked();
        throw friendlyError(e, 'Telegram: не удалось отметить чат прочитанным');
      }
    },

    async sendTyping(chatId) {
      const client = requireClient();
      const parsed = parseChatId(chatId);
      if (!parsed) throw new Error(`Telegram: неизвестный chatId: ${chatId}`);
      try {
        const peer = await buildInputPeer(client, parsed);
        await client.invoke(new Api.SetTyping({ peer, action: new Api.SendMessageTypingAction() }));
      } catch (e) {
        if (isAuthError(e)) handleAuthRevoked();
        throw friendlyError(e, 'Telegram: не удалось отправить статус печати');
      }
    },
  };
}

module.exports = { create };
