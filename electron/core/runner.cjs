'use strict';
// ProfileRunner: hosts one module instance for one profile; caches chats and
// recent messages for the renderer; owns the auth-prompt lifecycle.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { importModuleFactory } = require('./store.cjs');

const RECENT_CAP = 80;

class ProfileRunner {
  constructor({ profile, module_, dataDir, bus, log }) {
    this.profile = profile;
    this.module_ = module_;
    this.manifest = module_.manifest;
    this.dataDir = dataDir;
    this.bus = bus;
    this.log = log;
    this.status = 'offline'; // offline|connecting|online|error|renderer
    this.lastError = null;
    this.chats = new Map(); // chatId -> Chat
    this.recent = new Map(); // chatId -> Message[]
    this.prompts = new Map(); // promptId -> { resolve, reject, timer }
    this.earlyResponses = new Map(); // ответ интерфейса, пришедший до появления промпта
    this.openChatId = null; // chat currently open in UI → no unread bump
    this.api = null;
    this.stopped = false;
    this.rendererDriven = module_.manifest.runtime === 'renderer';
  }

  ctx() {
    return {
      profileId: this.profile.id,
      name: this.profile.name,
      config: this.profile.config,
      dataDir: this.dataDir,
      log: (level, msg, meta) => this.log(level, `[${this.profile.name}] ${msg}`, meta),
      emit: (type, payload) => this.onModuleEvent(type, payload),
      prompt: (req) => this.prompt(req),
    };
  }

  async start() {
    if (this.rendererDriven) {
      this.status = 'renderer';
      this.bus.emitModuleEvent(this.profile.id, 'status', {
        state: 'renderer',
        note: 'управляется интерфейсом',
      });
      return;
    }
    if (this.api) return;
    this.stopped = false;
    this.setStatus('connecting');
    const create = await importModuleFactory(this.module_.entry).catch((e) => {
      throw new Error(`модуль не загружается: ${e.message}`);
    });
    if (typeof create !== 'function') throw new Error('модуль не экспортирует create()');
    this.api = create(this.ctx());
    try {
      await this.api.connect();
    } catch (e) {
      const msg = e?.message || String(e);
      this.lastError = msg;
      this.log('error', `connect failed: ${msg}\n${e?.stack || ''}`);
      this.setStatus('error');
      await this.stop({ silent: true });
      throw new Error(msg);
    }
  }

  async stop({ silent = false } = {}) {
    const api = this.api;
    this.stopped = true;
    this.api = null;
    this.cancelPrompts('профиль останавливается');
    if (api?.disconnect) {
      try {
        await api.disconnect();
      } catch (e) {
        this.log('warn', `disconnect error: ${e?.message}`);
      }
    }
    if (!silent) this.setStatus('offline');
  }

  async restart() {
    await this.stop({ silent: true });
    this.chats.clear();
    this.recent.clear();
    await this.start();
  }

  setStatus(state, extra = {}) {
    this.status = state;
    if (state === 'online') this.lastError = null;
    this.log('info', `статус: ${state}${this.lastError ? ` (${this.lastError})` : ''}`);
    this.bus.emitModuleEvent(this.profile.id, 'status', { state, error: this.lastError, ...extra });
  }

  onModuleEvent(type, payload) {
    if (this.stopped) return;
    try {
      switch (type) {
        case 'chat': {
          const prev = this.chats.get(payload.id);
          const chat = { ...prev, ...payload, profileId: this.profile.id };
          this.chats.set(chat.id, chat);
          this.bus.emitModuleEvent(this.profile.id, 'chat', chat);
          break;
        }
        case 'chat-remove': {
          this.chats.delete(payload.id);
          this.recent.delete(payload.id);
          this.bus.emitModuleEvent(this.profile.id, 'chat-remove', payload);
          break;
        }
        case 'message': {
          const msg = { ...payload, profileId: this.profile.id };
          this.pushRecent(msg);
          const chat = this.chats.get(msg.chatId);
          if (chat) {
            if (msg.ts > (chat.ts || 0)) {
              chat.ts = msg.ts;
              this.bus.emitModuleEvent(this.profile.id, 'chat', { ...chat });
            }
            if (!msg.out && msg.chatId !== this.openChatId && !chat.muted) {
              chat.unread = (chat.unread || 0) + 1;
              this.bus.emitModuleEvent(this.profile.id, 'chat', { ...chat });
            }
          }
          this.bus.emitModuleEvent(this.profile.id, 'message', msg);
          break;
        }
        case 'message-edit': {
          const msg = { ...payload, profileId: this.profile.id };
          this.replaceRecent(msg);
          this.bus.emitModuleEvent(this.profile.id, 'message-edit', msg);
          break;
        }
        case 'typing': {
          this.bus.emitModuleEvent(this.profile.id, 'typing', payload);
          break;
        }
        case 'status': {
          if (payload?.state) {
            if (payload.state === 'error') this.lastError = payload.error || 'Ошибка соединения';
            this.status = payload.state;
            if (payload.state === 'online') this.lastError = null;
            this.bus.emitModuleEvent(this.profile.id, 'status', {
              state: payload.state,
              error: this.lastError,
            });
          }
          break;
        }
        default:
          this.log('warn', `unknown event type: ${type}`);
      }
    } catch (e) {
      this.log('error', `event handling failed (${type}): ${e?.message}`);
    }
  }

  pushRecent(msg) {
    let list = this.recent.get(msg.chatId);
    if (!list) {
      list = [];
      this.recent.set(msg.chatId, list);
    }
    // drop local pending copy replaced by the server-confirmed message
    const pendingIdx = msg.pending
      ? -1
      : list.findIndex((m) => m.pending && m.ts >= msg.ts - 15000 && m.ts <= msg.ts + 15000 && m.text && m.text === msg.text);
    if (pendingIdx >= 0) list.splice(pendingIdx, 1);
    const idx = list.findIndex((m) => m.id === msg.id);
    if (idx >= 0) list[idx] = msg;
    else {
      list.push(msg);
      list.sort((a, b) => a.ts - b.ts);
    }
    if (list.length > RECENT_CAP) list.splice(0, list.length - RECENT_CAP);
  }

  replaceRecent(msg) {
    const list = this.recent.get(msg.chatId);
    if (!list) return;
    const idx = list.findIndex((m) => m.id === msg.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...msg };
  }

  // ---- prompts ----
  prompt(req) {
    return new Promise((resolve, reject) => {
      // интерфейс мог отправить ответ до того, как модуль спросил промпт
      const early = this.earlyResponses.get('value');
      if (early !== undefined) {
        this.earlyResponses.delete('value');
        resolve({ value: early });
        return;
      }
      const promptId = crypto.randomUUID();
      const timeoutMs = req?.timeoutMs || 180000;
      const timer = setTimeout(() => {
        this.prompts.delete(promptId);
        this.bus.clearLastPrompt(this.profile.id, promptId);
        reject(new Error('время ожидания ввода истекло'));
      }, timeoutMs);
      this.prompts.set(promptId, { resolve, reject, timer });
      this.log('info', `промпт: ${req?.kind || 'text'} — ждём ввод пользователя`);
      this.bus.emitModuleEvent(this.profile.id, 'prompt', {
        promptId,
        kind: req?.kind || 'text',
        title: req?.title,
        detail: req?.detail,
        qrBase64: req?.qr ? Buffer.from(req.qr).toString('base64') : undefined,
      });
    });
  }

  respond(promptId, value) {
    const val = String(value ?? '');
    const p = this.prompts.get(promptId);
    if (p) {
      this.prompts.delete(promptId);
      clearTimeout(p.timer);
      this.bus.clearLastPrompt(this.profile.id, promptId);
      p.resolve({ value: val });
      return true;
    }
    // промпта ещё нет — сохраним ответ, prompt() заберёт его при появлении
    this.earlyResponses.set('value', val);
    return true;
  }

  cancelPrompts(reason) {
    for (const [id, p] of this.prompts) {
      clearTimeout(p.timer);
      this.bus.clearLastPrompt(this.profile.id, id);
      p.reject(new Error(reason));
      this.prompts.delete(id);
    }
  }

  // ---- renderer-facing ----
  chatsList() {
    return [...this.chats.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  recentMessages(chatId) {
    return [...(this.recent.get(chatId) || [])];
  }

  markOpened(chatId) {
    const prev = this.openChatId;
    this.openChatId = chatId;
    if (prev && prev !== chatId) {
      const chat = this.chats.get(prev);
      if (chat?.unread) {
        chat.unread = 0;
        this.bus.emitModuleEvent(this.profile.id, 'chat', { ...chat });
      }
    }
    return prev;
  }
}

class RunnerManager {
  constructor({ store, userDataDir, repoRoot, bus, log }) {
    this.store = store;
    this.userDataDir = userDataDir;
    this.repoRoot = repoRoot;
    this.bus = bus;
    this.log = log;
    this.runners = new Map(); // profileId -> ProfileRunner
    this.modules = [];
  }

  setModules(modules) {
    this.modules = modules;
  }

  moduleById(id) {
    return this.modules.find((m) => m.manifest.id === id);
  }

  dataDirFor(profileId) {
    const { profileDataDir } = require('./store.cjs');
    return profileDataDir(this.userDataDir, profileId);
  }

  /** Start runners for every enabled non-renderer profile (staggered). */
  async startAll() {
    const enabled = this.store.list().filter((p) => p.enabled);
    for (const profile of enabled) {
      await this.ensureRunner(profile).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async ensureRunner(profile) {
    let runner = this.runners.get(profile.id);
    if (!runner) {
      const module_ = this.moduleById(profile.moduleId);
      if (!module_) throw new Error(`модуль "${profile.moduleId}" не установлен`);
      runner = new ProfileRunner({
        profile,
        module_,
        dataDir: this.dataDirFor(profile.id),
        bus: this.bus,
        log: this.log,
      });
      this.runners.set(profile.id, runner);
    }
    if (runner.status === 'online' || runner.rendererDriven) return runner;
    try {
      await runner.start();
    } catch (e) {
      this.log('error', `профиль ${profile.name}: ${e?.message}`);
    }
    return runner;
  }

  async stopRunner(profileId, { silent = false } = {}) {
    const runner = this.runners.get(profileId);
    if (!runner) return;
    await runner.stop({ silent });
  }

  async removeRunner(profileId) {
    const runner = this.runners.get(profileId);
    if (runner) {
      await runner.stop({ silent: true });
      this.runners.delete(profileId);
    }
    fs.rmSync(this.dataDirFor(profileId), { recursive: true, force: true });
  }

  async stopAll() {
    for (const runner of this.runners.values()) {
      await runner.stop({ silent: true }).catch(() => {});
    }
  }

  allChats() {
    const out = [];
    for (const runner of this.runners.values()) {
      if (!runner.rendererDriven) out.push(...runner.chatsList());
    }
    return out;
  }

  runnerFor(profileId) {
    return this.runners.get(profileId);
  }
}

module.exports = { ProfileRunner, RunnerManager };
