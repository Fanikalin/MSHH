'use strict';

// VK module — plain HTTPS API (global fetch) + messages longpoll. No SDK, no deps.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API_BASE = 'https://api.vk.com/method';
const DEFAULT_API_VERSION = '5.199';
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

class VkApiError extends Error {
  constructor(method, code, message) {
    super(`VK API ${method}: [${code}] ${message}`);
    this.name = 'VkApiError';
    this.code = code;
    this.method = method;
  }
}

function chatIdForPeer(peerId) {
  return String(peerId);
}

// peer_id: 2000000xxx = group chat (multi-user conversation), positive = user dm,
// negative (non-2000000 prefix) = community/group.
function peerKind(peerId) {
  const id = Number(peerId);
  if (id > 2000000000) return 'group';
  if (id < 0) return 'group';
  return 'dm';
}

function peerIdForChatId(chatId) {
  return Number(chatId);
}

module.exports.create = function create(ctx) {
  const token = String(ctx.config?.token || '').trim();
  const apiVersion = String(ctx.config?.apiVersion || DEFAULT_API_VERSION).trim() || DEFAULT_API_VERSION;

  let stopped = true;
  let reconnectTimer = null;
  let abort = null;
  let longpollTs = null;
  let backoffMs = RECONNECT_BASE_MS;
  let afterOnline = false; // emit "offline" vs "error" on drops

  // ---------- API ----------

  async function api(method, params = {}) {
    const body = new URLSearchParams({ access_token: token, v: apiVersion });
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      body.set(k, String(v));
    }
    let res;
    try {
      res = await fetch(`${API_BASE}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (e) {
      throw new Error(`VK API ${method}: сетевая ошибка: ${e.message}`);
    }
    if (!res.ok) {
      throw new Error(`VK API ${method}: HTTP ${res.status}`);
    }
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error(`VK API ${method}: некорректный ответ сервера`);
    }
    if (data.error) {
      throw new VkApiError(method, data.error.error_code, data.error.error_msg);
    }
    return data.response;
  }

  // ---------- Users / chats ----------

  const userNameCache = new Map();

  async function fetchUserNames(userIds) {
    const missing = [...new Set(userIds.map(String))].filter((id) => !userNameCache.has(id));
    if (missing.length) {
      try {
        const users = await api('users.get', { user_ids: missing.join(','), fields: 'photo_200' });
        for (const u of users || []) {
          userNameCache.set(String(u.id), `${u.first_name || ''} ${u.last_name || ''}`.trim() || `id${u.id}`);
        }
      } catch (e) {
        ctx.log('warn', 'users.get failed', { error: e.message });
      }
    }
    return (id) => userNameCache.get(String(id));
  }

  async function buildChat(conversation, names) {
    const peer = conversation.peer || {};
    const peerId = peer.id;
    const cid = chatIdForPeer(peerId);
    const kind = peerKind(peerId);
    let title = '';
    let avatarUrl = null;

    if (kind === 'group' && peerId > 2000000000) {
      try {
        const chat = await api('messages.getChat', { chat_id: peerId - 2000000000 });
        const c = Array.isArray(chat) ? chat[0] : chat;
        title = c?.title || `Чат ${cid}`;
        avatarUrl = c?.photo_200 || null;
      } catch (e) {
        title = `Чат ${cid}`;
      }
    } else if (kind === 'group') {
      // community conversation
      try {
        const groups = await api('groups.getById', { group_id: String(-peerId), fields: 'photo_200' });
        const g = groups?.groups?.[0] || groups?.[0];
        title = g?.name || `Сообщество ${cid}`;
        avatarUrl = g?.photo_200 || null;
      } catch {
        title = `Сообщество ${cid}`;
      }
    } else {
      title = names(String(peerId)) || `id${peerId}`;
    }

    const chat = {
      id: cid,
      kind,
      title,
      ts: (conversation.last_message?.date || 0) * 1000,
      unread: conversation.unread_count || 0,
    };
    const { avatarPath } = avatarUrl ? await downloadMedia(avatarUrl, `avatar-${cid}.jpg`) : {};
    if (avatarPath) chat.avatarPath = avatarPath;
    return chat;
  }

  async function loadConversations() {
    const names = await fetchUserNames([]);
    let loaded = 0;
    for (let offset = 0; ; offset += 200) {
      const resp = await api('messages.getConversations', {
        offset,
        count: 200,
        filter: 'all',
        extended: 0,
      });
      const items = resp?.items || [];
      for (const item of items) {
        try {
          ctx.emit('chat', await buildChat(item.conversation, names));
        } catch (e) {
          ctx.log('warn', 'chat build failed', { error: e.message });
        }
      }
      loaded += items.length;
      const total = resp?.count || 0;
      if (items.length === 0 || loaded >= total) break;
    }
    ctx.log('info', `loaded ${loaded} conversations`);
  }

  // ---------- Media ----------

  function safeName(name) {
    return String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(-120) || 'file';
  }

  async function downloadMedia(url, fallbackName) {
    const dir = path.join(ctx.dataDir, 'media');
    await fs.promises.mkdir(dir, { recursive: true });
    let name = safeName(new URL(url).pathname.split('/').pop() || fallbackName);
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) name = safeName(fallbackName);
    const dest = path.join(dir, `${Date.now()}-${crypto.randomInt(1e6)}-${name}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`media download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(dest, buf);
    // path relative to dataDir (contract: file inside dataDir)
    return { path: path.relative(ctx.dataDir, dest), size: buf.length };
  }

  // photo attachment: pick the largest size with width <= 1600 (else the smallest available)
  function pickPhotoUrl(photo) {
    const sizes = (photo?.sizes || []).filter((s) => s && s.url);
    if (!sizes.length) return null;
    const sorted = [...sizes].sort((a, b) => (a.width || 0) - (b.width || 0));
    const fit = sorted.filter((s) => (s.width || 0) <= 1600);
    const best = fit.length ? fit[fit.length - 1] : sorted[0];
    return best.url;
  }

  async function attachmentToMedia(att) {
    if (!att || typeof att !== 'object') return null;
    if (att.photo) {
      const url = pickPhotoUrl(att.photo);
      if (!url) return null;
      const { path: p, size } = await downloadMedia(url, `photo${att.photo.owner_id}_${att.photo.id}.jpg`);
      return { kind: 'image', name: `photo${att.photo.owner_id}_${att.photo.id}.jpg`, size, path: p };
    }
    if (att.doc && att.doc.url) {
      const { path: p, size } = await downloadMedia(att.doc.url, att.doc.title || 'doc');
      const ext = (att.doc.ext || '').toLowerCase();
      const kind = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
        ? 'image'
        : ['mp3', 'ogg', 'wav'].includes(ext)
          ? 'audio'
          : ['mp4', 'mkv', 'webm', 'avi', 'mov'].includes(ext)
            ? 'video'
            : 'file';
      return { kind, name: att.doc.title, mime: att.doc.mime_type, size: size ?? att.doc.size, path: p };
    }
    if (att.audio && att.audio.url) {
      const { path: p, size } = await downloadMedia(att.audio.url, `${att.audio.artist || ''} - ${att.audio.title || 'audio'}.mp3`);
      return { kind: 'audio', name: `${att.audio.artist || ''} - ${att.audio.title || ''}`.trim(), path: p };
    }
    if (att.video) {
      // video files need a separate resolution API call; surface as file without path
      return { kind: 'video', name: att.video.title || 'video' };
    }
    return null;
  }

  // ---------- Normalization ----------

  async function normalizeMessage(msg, { edited = false } = {}) {
    const peerId = msg.peer_id;
    const cid = chatIdForPeer(peerId);
    const out = Boolean(msg.out || (Number(msg.flags) & 2));
    const senderId = String(msg.from_id ?? peerId);
    const text = typeof msg.text === 'string' ? msg.text : undefined;
    let media = null;
    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    if (atts.length) {
      try {
        media = await attachmentToMedia(atts[0]);
      } catch (e) {
        ctx.log('warn', 'attachment download failed', { error: e.message });
      }
    }
    const m = {
      id: String(msg.id),
      chatId: cid,
      senderId,
      ts: (msg.date || 0) * 1000,
      out,
      edited: edited || undefined,
    };
    if (text) m.text = text;
    if (media) m.media = media;
    if (msg.reply_message?.id) m.replyTo = String(msg.reply_message.id);
    const names = await fetchUserNames([senderId]);
    if (!out && names(senderId)) m.senderName = names(senderId);
    return m;
  }

  // ---------- Longpoll ----------

  async function fetchLongpollUpdate() {
    if (!abort) abort = new AbortController();
    const signal = abort.signal;
    if (longpollTs === null) {
      const server = await api('messages.getLongPollServer', {
        lp_version: 3,
        need_pts: 0,
      });
      longpollTs = server.ts;
      var { key, server: srv } = server;
    } else {
      var { key, server: srv } = await api('messages.getLongPollServer', { lp_version: 3, need_pts: 0 });
    }
    const url = `https://${srv}?act=a_check&key=${encodeURIComponent(key)}&ts=${longpollTs}` +
      `&wait=25&mode=234&version=3`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`longpoll HTTP ${res.status}`);
    const data = await res.json();
    if (data.failed) {
      if (data.failed === 1 && data.ts) {
        longpollTs = data.ts; // lost events, continue from new ts
        return;
      }
      longpollTs = null; // 2/3/4: re-init server
      if (data.failed >= 3) throw new Error('longpoll: сессия истекла, переподключение');
      return;
    }
    longpollTs = data.ts;
    for (const upd of data.updates || []) {
      await handleLongpollEvent(upd).catch((e) =>
        ctx.log('warn', 'longpoll event failed', { error: e.message }));
    }
  }

  async function handleLongpollEvent(upd) {
    const code = upd[0];
    if (code === 4 || code === 5) {
      const flags = upd[2];
      const msg = upd[code === 4 ? 5 : 5]; // both: [.., .., .., .., .., message]
      const edited = code === 5;
      // skip service / hidden messages
      if (Number(flags) & (16 | 128)) return;
      const m = await normalizeMessage(msg, { edited });
      ctx.emit(edited ? 'message-edit' : 'message', m);
    } else if (code === 61 || code === 62) {
      const peerId = code === 61 ? upd[1] : upd[1] + 2000000000;
      const userId = upd[2];
      const names = await fetchUserNames([userId]);
      ctx.emit('typing', { chatId: chatIdForPeer(peerId), who: names(String(userId)) || `id${userId}` });
    }
  }

  async function longpollLoop() {
    while (!stopped) {
      try {
        await fetchLongpollUpdate();
        if (stopped) return;
        if (backoffMs !== RECONNECT_BASE_MS) {
          backoffMs = RECONNECT_BASE_MS;
          afterOnline = false;
          ctx.emit('status', { state: 'online' });
        }
      } catch (e) {
        if (stopped || e.name === 'AbortError') return;
        ctx.log('warn', 'longpoll error', { error: e.message });
        longpollTs = null;
        const state = afterOnline ? 'offline' : 'error';
        afterOnline = false;
        ctx.emit('status', { state, error: e.message });
        await new Promise((resolve) => {
          reconnectTimer = setTimeout(resolve, backoffMs);
        });
        backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
        if (stopped) return;
        ctx.emit('status', { state: 'connecting' });
      }
    }
  }

  // ---------- File upload for sendMessage ----------

  async function uploadAttachments(chatId, files) {
    const peerId = peerIdForChatId(chatId);
    const parts = [];
    for (const f of files) {
      const buf = await fs.promises.readFile(f.path);
      const name = f.name || path.basename(f.path);
      const isImage = /\.(jpe?g|png|gif|webp)$/i.test(name);
      try {
        if (isImage) {
          const up = await api('photos.getMessagesUploadServer', { peer_id: peerId });
          const fd = new FormData();
          fd.append('photo', new Blob([buf]), name);
          const res = await fetch(up.upload_url, { method: 'POST', body: fd });
          const saved = await res.json();
          const savedResp = await api('photos.saveMessagesPhoto', {
            photo: saved.photo,
            server: saved.server,
            hash: saved.hash,
          });
          const p = Array.isArray(savedResp) ? savedResp[0] : savedResp;
          parts.push(`photo${p.owner_id}_${p.id}`);
        } else {
          const up = await api('docs.getMessagesUploadServer', { peer_id: peerId, type: 'doc' });
          const fd = new FormData();
          fd.append('file', new Blob([buf]), name);
          const res = await fetch(up.upload_url, { method: 'POST', body: fd });
          const saved = await res.json();
          parts.push(`doc${saved.file.owner_id}_${saved.file.doc_id}`.replace(/^doc/, 'doc'));
          // upload response: { file: "..." } for docs
          parts[parts.length - 1] = saved.file;
        }
      } catch (e) {
        ctx.log('warn', `upload failed for ${name}`, { error: e.message });
        throw new Error(`Не удалось загрузить файл «${name}»: ${e.message}`);
      }
    }
    return parts.join(',');
  }

  // ---------- Public API ----------

  return {
    async connect() {
      if (!token) throw new Error('Не задан токен VK — укажите его в настройках профиля');

      stopped = false;
      afterOnline = false;
      ctx.emit('status', { state: 'connecting' });

      // 1. Validate token
      try {
        const users = await api('users.get');
        if (!Array.isArray(users) || users.length === 0) {
          throw new Error('Неверный токен VK');
        }
        ctx.log('info', `authorized as ${users[0].first_name} ${users[0].last_name}`);
      } catch (e) {
        stopped = true;
        ctx.emit('status', { state: 'error', error: e.message });
        if (e instanceof VkApiError && (e.code === 5 || e.code === 28)) {
          throw new Error('Неверный токен VK');
        }
        throw new Error(`VK: ${e.message}`);
      }

      // 2. Initial sync
      await loadConversations();

      ctx.emit('status', { state: 'online' });
      afterOnline = true;

      // 3. Longpoll loop (background, supervised reconnection)
      longpollLoop().catch((e) => {
        if (!stopped) {
          ctx.log('error', 'longpoll loop crashed', { error: e.message });
          ctx.emit('status', { state: 'error', error: e.message });
        }
      });
    },

    async disconnect() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (abort) { try { abort.abort(); } catch {} abort = null; }
      longpollTs = null;
      ctx.emit('status', { state: 'offline' });
    },

    async loadHistory(chatId, opts = {}) {
      const peerId = peerIdForChatId(chatId);
      const limit = Math.min(opts.limit || 50, 200);
      const resp = await api('messages.getHistory', {
        peer_id: peerId,
        count: limit,
        rev: 0, // newest first
      });
      const items = resp?.items || [];
      const names = await fetchUserNames(items.map((m) => m.from_id).filter(Boolean));
      const out = [];
      for (const m of items) {
        const ts = (m.date || 0) * 1000;
        if (opts.beforeTs && ts >= opts.beforeTs) continue;
        const msg = {
          id: String(m.id),
          chatId,
          senderId: String(m.from_id ?? peerId),
          ts,
          out: m.from_id === (await myId()),
        };
        if (m.text) msg.text = m.text;
        const atts = Array.isArray(m.attachments) ? m.attachments : [];
        if (atts.length) {
          try {
            const media = await attachmentToMedia(atts[0]);
            if (media) msg.media = media;
          } catch (e) {
            ctx.log('warn', 'history attachment failed', { error: e.message });
          }
        }
        if (m.reply_message?.id) msg.replyTo = String(m.reply_message.id);
        if (!msg.out && names(String(msg.senderId))) msg.senderName = names(String(msg.senderId));
        out.push(msg);
      }
      return out;
    },

    async sendMessage(chatId, draft = {}) {
      const peerId = peerIdForChatId(chatId);
      const params = {
        peer_id: peerId,
        random_id: crypto.randomInt(0, 2 ** 31),
        message: draft.text || '',
      };
      if (Array.isArray(draft.files) && draft.files.length) {
        params.attachment = await uploadAttachments(chatId, draft.files);
      }
      const resp = await api('messages.send', params);
      const sentId = Array.isArray(resp) ? resp[0]?.message_id ?? resp[0] : resp;
      const names = await fetchUserNames([]);
      const msg = {
        id: String(sentId ?? `tmp-${params.random_id}`),
        chatId,
        senderId: String(await myId()),
        ts: Date.now(),
        out: true,
        pending: false,
      };
      if (draft.text) msg.text = draft.text;
      if (draft.files?.length) msg.media = { kind: 'file', name: draft.files[0].name };
      return msg;
    },

    async markRead(chatId) {
      await api('messages.markAsRead', { peer_id: peerIdForChatId(chatId) }).catch((e) =>
        ctx.log('warn', 'markAsRead failed', { error: e.message }));
    },

    async sendTyping(chatId) {
      await api('messages.setActivity', {
        peer_id: peerIdForChatId(chatId),
        type: 'typing',
      }).catch((e) => ctx.log('warn', 'setActivity failed', { error: e.message }));
    },
  };

  // lazily cached own id
  let ownId = null;
  async function myId() {
    if (ownId === null) {
      try {
        const users = await api('users.get');
        ownId = users?.[0]?.id ?? 0;
      } catch {
        ownId = 0;
      }
    }
    return ownId;
  }
};
