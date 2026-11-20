'use strict';

// TestMock — офлайн-модуль для тестов MSHH. Без сети и сервера.
// Повторяет фишки Telegram-модуля: личные чаты/группы/каналы, архив,
// pinned, unread, упоминания @, папки (tgFolder), verified, черновики,
// сервисные сообщения, аватарки (цветные PNG), входящие по таймеру,
// эхо-отправка, медиа-сообщения, промпт кода, profile-name.

const fs = require('node:fs');
const path = require('node:path');

// мини PNG-энкодер: одноцветная картинка 96x96 (для аватарок/медиа)
function colorPng(rgb) {
  const { deflateSync } = require('node:zlib');
  const W = 96, H = 96;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      const px = row + 1 + x * 3;
      raw[px] = rgb[0]; raw[px + 1] = rgb[1]; raw[px + 2] = rgb[2];
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports.create = function create(ctx) {
  const dataDir = ctx.dataDir;
  const avatarDir = path.join(dataDir, 'avatars');
  const mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(avatarDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });

  let stopped = false;
  let chatSeq = [];
  const timers = [];

  const emit = (type, payload) => { if (!stopped) ctx.emit(type, payload); };
  const later = (fn, ms) => { const t = setTimeout(() => { if (!stopped) fn(); }, ms); timers.push(t); return t; };

  const SEED = [
    { id: 'dm_1', kind: 'dm', title: 'Анна Смирнова', ts: Date.now() - 60000, unread: 2, mentions: true, avatar: [235, 87, 87] },
    { id: 'dm_2', kind: 'dm', title: 'Борис Котов', ts: Date.now() - 3600000, unread: 0, draft: 'Проверка черновика', avatar: [255, 179, 71] },
    { id: 'dm_3', kind: 'dm', title: 'Виктор Пепел', ts: Date.now() - 7200000, unread: 1, avatar: [111, 207, 151] },
    { id: 'gr_1', kind: 'group', title: 'Супергруппа: Разработка MSHH', ts: Date.now() - 120000, unread: 15, tgFolder: 'Работа', avatar: [82, 139, 255] },
    { id: 'gr_2', kind: 'group', title: 'Супергруппа: Мемы', ts: Date.now() - 5400000, unread: 0, avatar: [186, 104, 200] },
    { id: 'ch_1', kind: 'channel', title: 'Канал: Новости MSHH', ts: Date.now() - 900000, unread: 0, verified: true, tgFolder: 'Новости', avatar: [88, 178, 178] },
    { id: 'dm_4', kind: 'dm', title: 'Архив: Старый друг', ts: Date.now() - 86400000 * 30, unread: 0, archived: true, avatar: [140, 140, 140] },
    { id: 'gr_3', kind: 'group', title: 'Архив: События 2024', ts: Date.now() - 86400000 * 60, unread: 3, archived: true, avatar: [96, 96, 96] },
    { id: 'dm_5', kind: 'dm', title: 'Закреплённый: Напоминания', ts: Date.now() - 300000, unread: 0, pinned: true, avatar: [255, 214, 90] },
  ];

  function seedChats() {
    chatSeq = [];
    for (const s of SEED) {
      const av = path.join(avatarDir, `${s.id}.png`);
      if (!fs.existsSync(av)) fs.writeFileSync(av, colorPng(s.avatar));
      const chat = {
        id: s.id, kind: s.kind, title: s.title, ts: s.ts,
        unread: s.unread, avatarPath: av,
        ...(s.archived ? { archived: true } : {}),
        ...(s.pinned ? { pinned: true } : {}),
        ...(s.mentions ? { mentions: true } : {}),
        ...(s.tgFolder ? { tgFolder: s.tgFolder } : {}),
        ...(s.verified ? { verified: true } : {}),
        ...(s.draft ? { draft: s.draft } : {}),
      };
      chatSeq.push(chat);
      emit('chat', chat);
    }
  }

  function fakeIncoming() {
    const chat = chatSeq[(Math.random() * chatSeq.length) | 0];
    if (!chat) return;
    const phrases = ['Привет!', 'Как дела?', 'Смотри что нашёл', 'Ок', 'Тест входящего', '🔔 напоминание'];
    const text = phrases[(Math.random() * phrases.length) | 0];
    chat.ts = Date.now();
    if (!chat.muted) chat.unread = (chat.unread || 0) + 1;
    emit('chat', { ...chat });
    emit('message', {
      id: `in_${Date.now()}`, chatId: chat.id, senderId: chat.id,
      senderName: chat.title, ts: Date.now(), out: false, text,
    });
  }

  function fakeMediaIncoming() {
    const chat = chatSeq[0];
    if (!chat) return;
    const file = path.join(mediaDir, `fake_${Date.now()}.png`);
    fs.writeFileSync(file, colorPng([40, 160, 220]));
    chat.ts = Date.now();
    emit('chat', { ...chat });
    emit('message', {
      id: `med_${Date.now()}`, chatId: chat.id, senderId: chat.id,
      senderName: chat.title, ts: Date.now(), out: false,
      text: '(картинка)', media: { kind: 'image', path: file, mime: 'image/png', name: 'fake.png' },
    });
  }

  return {
    async connect() {
      stopped = false;
      // генерируем аватарку самого аккаунта (для бейджа профиля)
      fs.writeFileSync(path.join(avatarDir, 'me.png'), colorPng([90, 200, 250]));
      seedChats();
      ctx.log('info', 'testmock: демо-данные готовы');
      emit('profile-name', { name: 'Тестовый Аккаунт' });

      // демо-промпт кода (тест модалки) — опционально
      if (ctx.config.demoCodePrompt === true) {
        later(async () => {
          try {
            const answer = await ctx.prompt({
              kind: 'code', title: 'Демо: код подтверждения',
              detail: 'Тест модального ввода кода (можно отменить крестиком)', timeoutMs: 60000,
            });
            const code = String(answer?.value ?? '').trim();
            if (code) emit('message', { id: `democode_${Date.now()}`, chatId: 'dm_1', senderId: 'system', senderName: 'TestMock', ts: Date.now(), out: false, text: `Код принят: ${code}` });
          } catch { /* отмена/таймаут — не страшно */ }
        }, 1500);
      }

      timers.push(setInterval(fakeIncoming, 12000));
      later(fakeMediaIncoming, 20000);
      later(fakeMediaIncoming, 45000);
      emit('status', { state: 'online' });
    },

    async disconnect() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
    },

    async loadHistory(chatId, { beforeTs, limit } = {}) {
      void beforeTs; void limit;
      const chat = chatSeq.find((c) => c.id === chatId);
      // в группах/каналах — сервисное событие как в Telegram (смена названия)
      if (!chat || chat.kind === 'dm') return [];
      return [{
        id: `svc_${chatId}`, chatId,
        senderId: chatId, senderName: chat.title,
        ts: Date.now() - 3600000, out: false, service: true,
        text: `сменил(а) название на «${chat.title}»`,
      }];
    },

    // эхо: отправка видна сразу и приходит входящим эхом (тест цикла отправки)
    async sendMessage(chatId, draft) {
      const chat = chatSeq.find((c) => c.id === chatId);
      const ts = Date.now();
      const outMsg = {
        id: `out_${ts}`, chatId, senderId: 'me', senderName: 'Я',
        ts, out: true, text: draft.text || '', pending: false,
      };
      if (draft.files && draft.files.length) {
        const f = draft.files[0];
        outMsg.media = { kind: 'file', path: f.path, name: f.name || path.basename(f.path), mime: 'application/octet-stream' };
        outMsg.text = `(файл: ${outMsg.media.name})`;
      }
      if (chat) { chat.ts = ts; emit('chat', { ...chat }); }
      emit('message', outMsg);
      later(() => {
        emit('message', {
          id: `echo_${ts}`, chatId, senderId: chatId, senderName: 'Эхо-бот',
          ts: Date.now(), out: false,
          text: draft.text ? `Эхо: ${draft.text}` : 'Эхо файла',
          ...(outMsg.media ? { media: outMsg.media } : {}),
        });
        if (chat) { chat.unread = (chat.unread || 0) + 1; emit('chat', { ...chat }); }
      }, 800);
      return outMsg;
    },

    async markRead(chatId) {
      const chat = chatSeq.find((c) => c.id === chatId);
      if (chat) { chat.unread = 0; emit('chat', { ...chat }); }
    },

    async sendTyping(chatId) {
      void chatId;
    },
  };
};
