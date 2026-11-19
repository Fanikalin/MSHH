'use strict';

// MSHH XMPP module — @xmpp/client v0.14.x (reconnect is built into client()).
// Media is not supported (manifest capabilities.media = false).
// History: XMPP servers may expose MAM (XEP-0313), which is server-dependent
// and NOT implemented here. loadHistory therefore returns only messages
// cached from the current session (persisted in dataDir/history.json,
// capped at 200 per chat). No server-side history without MAM.

const fs = require('node:fs');
const path = require('node:path');
const { client, xml, jid } = require('@xmpp/client');
const { dns: resolveDns } = require('@xmpp/resolve/resolve.js');

const HISTORY_CAP = 200;

function bareOf(j) {
  try { return j.bare().toString(); } catch { return String(j).split('/')[0]; }
}
function resourceOf(j) {
  try { return j.getResource() || undefined; } catch { return undefined; }
}

module.exports.create = function create(ctx) {
  const historyPath = path.join(ctx.dataDir, 'history.json');
  const sessionPath = path.join(ctx.dataDir, 'session.json');

  let xmpp = null;
  let stopped = false;        // disconnect() called — suppress reconnect & events
  let online = false;
  let ownBare = null;
  // chatId -> { title, subtitle?, ts, messages: Message[] (oldest first) }
  const chats = new Map();
  // persist typing emit timeouts? none needed; chatState composable only.

  // ---------- history cache ----------
  function loadHistoryCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      for (const [id, c] of Object.entries(raw.chats || {})) {
        chats.set(id, { title: c.title || id, subtitle: c.subtitle, ts: c.ts || 0, messages: c.messages || [] });
      }
    } catch { /* no cache yet */ }
  }
  function saveHistoryCache() {
    try {
      fs.mkdirSync(ctx.dataDir, { recursive: true });
      const out = { chats: {} };
      for (const [id, c] of chats) {
        out.chats[id] = {
          title: c.title, subtitle: c.subtitle, ts: c.ts,
          messages: c.messages.slice(-HISTORY_CAP),
        };
      }
      fs.writeFileSync(historyPath, JSON.stringify(out));
    } catch (e) {
      ctx.log('warn', 'history cache write failed', { error: e.message });
    }
  }

  function getChat(chatId, title) {
    let c = chats.get(chatId);
    if (!c) {
      c = { title: title || chatId, subtitle: undefined, ts: 0, messages: [] };
      chats.set(chatId, c);
    }
    return c;
  }

  function emitChat(chatId) {
    const c = chats.get(chatId);
    if (!c || stopped) return;
    ctx.emit('chat', {
      id: chatId,
      kind: 'dm',
      title: c.title,
      subtitle: c.subtitle,
      ts: c.ts,
      unread: 0,
    });
  }

  // ---------- connect / lifecycle ----------
  // SRV pre-flight: on networks where SRV DNS fails (ESERVFAIL/ENOTFOUND/timeout),
  // @xmpp/client's built-in resolution would abort the whole connection. We probe
  // SRV ourselves first and fall back to direct TCP+STARTTLS on the domain host.
  async function pickService(domain) {
    const timeout = new Promise((_, rej) => {
      const t = setTimeout(() => rej(new Error('SRV resolution timeout')), 6000);
      if (t.unref) t.unref();
    });
    try {
      const records = await Promise.race([
        resolveDns.resolve(domain, {
          srv: [
            { service: 'xmpps-client', protocol: 'tcp' },
            { service: 'xmpp-client', protocol: 'tcp' },
          ],
        }),
        timeout,
      ]);
      if (!Array.isArray(records) || records.length === 0) throw new Error('нет SRV-записей');
      return domain; // SRV works — bare domain makes @xmpp/client resolve endpoints
    } catch (e) {
      const fallback = `xmpp://${domain}:5222`;
      ctx.log('info', `SRV-резолвинг не удался (${e.message}); подключаюсь напрямую к ${fallback}`);
      return fallback;
    }
  }

  async function buildOptions() {
    const cfg = ctx.config || {};
    const j = jid(String(cfg.jid || ''));
    const domain = j.getDomain();
    if (!domain) throw new Error('Некорректный JID — ожидается вида user@jabber.ru');
    const opts = {
      username: j.getLocal(),
      domain,
      password: String(cfg.password || ''),
    };
    const service = String(cfg.service || '').trim();
    if (service) {
      opts.service = service; // explicit user setting takes absolute precedence
    } else {
      opts.service = await pickService(domain);
    }
    return opts;
  }

  function cleanAuthError(e) {
    const condition = e && (e.condition || e.name || '');
    if (/auth|not-authorized|saslfailure|invalid-credentials|bad- credentials|credential/i.test(String(condition)) ||
        /auth/i.test(String(e && e.message))) {
      return new Error('Ошибка авторизации XMPP: сервер отклонил JID или пароль (' + (condition || 'auth failure') + ')');
    }
    return e instanceof Error ? e : new Error(String(e && e.message || e));
  }

  function attachHandlers() {
    xmpp.on('status', (s) => {
      if (stopped) return;
      if (s === 'connecting') ctx.emit('status', { state: 'connecting' });
      else if (s === 'connect') ctx.emit('status', { state: 'connecting' });
    });
    xmpp.on('error', (err) => {
      if (stopped) return;
      // Prevent unhandled 'error' event crashes; reconnect layer also logs it.
      ctx.log('warn', 'xmpp error', { error: err && (err.message || String(err)) });
      ctx.emit('status', { state: 'error', error: String(err && err.message || err) });
      if (err && typeof err === 'object') err.ignore = true; // hint to @xmpp not to rethrow via entity
    });
    xmpp.on('offline', () => {
      if (stopped) return;
      online = false;
      ctx.emit('status', { state: 'offline' });
    });
    // @xmpp/reconnect events (reconnect is embedded in client()).
    xmpp.reconnect.on('reconnecting', () => {
      if (!stopped) ctx.emit('status', { state: 'connecting' });
    });
    xmpp.reconnect.on('reconnected', () => {
      if (!stopped) ctx.emit('status', { state: 'online' });
    });
    xmpp.on('online', async (address) => {
      if (stopped) return;
      try {
        online = true;
        ownBare = bareOf(address);
        ctx.emit('status', { state: 'online' });
        persistSession();
        await xmpp.send(xml('presence'));
        await requestRoster();
      } catch (e) {
        ctx.log('warn', 'post-online setup failed', { error: e.message });
      }
    });
    xmpp.on('stanza', (st) => {
      try { onStanza(st); } catch (e) {
        ctx.log('warn', 'stanza handler error', { error: e.message });
      }
    });
  }

  function persistSession() {
    try {
      fs.mkdirSync(ctx.dataDir, { recursive: true });
      // XMPP has no reusable session token; remember a successful-login marker
      // so connect() can distinguish "session exists" from first-time setup.
      fs.writeFileSync(sessionPath, JSON.stringify({ jid: ctx.config.jid, at: Date.now() }));
    } catch { /* non-fatal */ }
  }

  async function requestRoster() {
    await xmpp.send(xml('iq', { type: 'get', id: 'mshh-roster-1' },
      xml('query', { xmlns: 'jabber:iq:roster' })));
  }

  // ---------- stanza handling ----------
  function onStanza(st) {
    if (st.is('iq') && st.attrs.type === 'result') {
      const q = st.getChild('query', 'jabber:iq:roster');
      if (q) return onRoster(q);
    }
    if (st.is('presence')) return onPresence(st);
    if (st.is('message')) return onMessage(st);
  }

  function onRoster(query) {
    for (const item of query.getChildren('item')) {
      const chatId = String(item.attrs.jid || '').split('/')[0];
      if (!chatId) continue;
      const title = item.attrs.name || chatId;
      const c = getChat(chatId, title);
      c.title = title;
      emitChat(chatId);
    }
  }

  function onPresence(st) {
    const from = st.attrs.from;
    if (!from) return;
    const chatId = bareOf(jid(from));
    const statusEl = st.getChildText('status');
    if (statusEl && chats.has(chatId)) {
      chats.get(chatId).subtitle = statusEl;
      emitChat(chatId);
    } else if (statusEl) {
      const c = getChat(chatId);
      c.subtitle = statusEl;
      emitChat(chatId);
    }
  }

  function onMessage(st) {
    const type = st.attrs.type;
    if (type !== 'chat' && type !== 'normal') return;
    const from = st.attrs.from;
    if (!from) return;
    const fromJ = jid(from);
    const fromBare = bareOf(fromJ);
    const out = fromBare === ownBare;
    const chatId = out ? bareOf(jid(st.attrs.to || '')) || fromBare : fromBare;
    const body = st.getChildText('body');
    const delay = st.getChild('delay'); // offline delivery timestamp
    // Chat state notifications carry no body — handle them separately.
    const composing = st.getChild('composing', 'http://jabber.org/protocol/chatstates');
    if (composing && !body && !out) {
      ctx.emit('typing', { chatId, who: resourceOf(fromJ) || fromBare });
    }
    if (!body) return;
    const ts = delay ? Date.parse(delay.attrs.stamp) || Date.now() : Date.now();
    const msg = {
      id: String(st.attrs.id || `xmpp-${ts}-${Math.random().toString(36).slice(2, 8)}`),
      chatId,
      senderId: fromBare,
      senderName: resourceOf(fromJ) || fromBare,
      ts,
      out,
      text: body,
    };
    const c = getChat(chatId);
    c.ts = Math.max(c.ts, ts);
    c.messages.push(msg);
    if (c.messages.length > HISTORY_CAP) c.messages.splice(0, c.messages.length - HISTORY_CAP);
    saveHistoryCache();
    if (!stopped) ctx.emit('message', msg);
    emitChat(chatId);
  }

  // ---------- API ----------
  return {
    async connect() {
      loadHistoryCache();
      stopped = false;
      const opts = await buildOptions();
      ctx.emit('status', { state: 'connecting' });
      xmpp = client(opts); // reconnect is enabled by default in @xmpp/client
      attachHandlers();
      try {
        await xmpp.start();
      } catch (e) {
        throw cleanAuthError(e);
      }
      if (!online) throw new Error('XMPP: не удалось установить сессию');
    },

    async disconnect() {
      stopped = true;
      saveHistoryCache();
      const x = xmpp;
      xmpp = null;
      online = false;
      if (!x) return;
      try {
        x.reconnect.stop();
        await x.stop();
      } catch { /* already closed */ }
    },

    // MAM (server-side archive) is intentionally not implemented: it is
    // optional on XMPP servers and detection adds fragility. We serve the
    // session cache only; older-than-session history is unavailable.
    async loadHistory(chatId, opts = {}) {
      const c = chats.get(chatId);
      if (!c) return [];
      let msgs = c.messages.slice();
      if (opts.beforeTs) msgs = msgs.filter((m) => m.ts < opts.beforeTs);
      msgs.sort((a, b) => b.ts - a.ts); // newest first
      return msgs.slice(0, opts.limit || 50);
    },

    async sendMessage(chatId, draft = {}) {
      if (!xmpp || !online) throw new Error('XMPP не подключён');
      if (Array.isArray(draft.files) && draft.files.length) {
        throw new Error('XMPP-модуль не поддерживает файлы');
      }
      const text = String(draft.text || '');
      if (!text) throw new Error('Пустое сообщение');
      const id = `mshh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const msg = xml('message', { type: 'chat', to: chatId, id },
        xml('body', {}, text),
        xml('active', { xmlns: 'http://jabber.org/protocol/chatstates' }));
      await xmpp.send(msg);
      const ts = Date.now();
      const out = {
        id,
        chatId,
        senderId: ownBare || chatId,
        senderName: undefined,
        ts,
        out: true,
        text,
        pending: false,
      };
      const c = getChat(chatId);
      c.ts = Math.max(c.ts, ts);
      c.messages.push(out);
      if (c.messages.length > HISTORY_CAP) c.messages.splice(0, c.messages.length - HISTORY_CAP);
      saveHistoryCache();
      if (!stopped) ctx.emit('message', out);
      emitChat(chatId);
      return out;
    },

    // XMPP core has no read receipts by default (XEP-0333 chat markers are
    // not widely supported) — marking read is a client-local no-op.
    async markRead() {},

    async sendTyping(chatId) {
      if (!xmpp || !online) return;
      await xmpp.send(xml('message', { type: 'chat', to: chatId },
        xml('composing', { xmlns: 'http://jabber.org/protocol/chatstates' })));
    },
  };
};
