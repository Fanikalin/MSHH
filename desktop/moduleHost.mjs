import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_MESSAGES_PER_CHAT = 200;
const NPM_INSTALL_TIMEOUT_MS = 120_000;

const FIELD_TYPES = ['string', 'secret', 'number', 'boolean', 'select'];
const AUTH_TYPES = ['none', 'qr', 'code', 'builtin-login'];
const ENTRY_CANDIDATES = ['index.cjs', 'index.mjs', 'index.js'];
const MODULE_ID_RE = /^[a-z0-9_-]+$/;

/**
 * Validate a module manifest against docs/mshh/MODULE_API.md.
 * Returns { module, error }. On error, `module` is undefined.
 */
export function validateModule(manifest, moduleDir) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { error: 'module.json is not an object' };
  }
  const { id, name, version, side } = manifest;
  if (typeof id !== 'string' || !MODULE_ID_RE.test(id)) {
    return { error: `bad id ${JSON.stringify(id)} (must match [a-z0-9_-]+)` };
  }
  if (typeof name !== 'string' || !name.trim()) return { error: 'missing "name"' };
  if (typeof version !== 'string' || !version.trim()) return { error: 'missing "version"' };
  if (side !== 'main' && side !== 'renderer') {
    return { error: `bad side ${JSON.stringify(side)} (must be "main" or "renderer")` };
  }

  const mod = {
    id,
    name,
    version,
    side,
    dir: moduleDir,
  };
  if (manifest.description !== undefined) mod.description = String(manifest.description);
  if (manifest.icon !== undefined) mod.icon = String(manifest.icon);

  if (manifest.auth !== undefined) {
    const auth = manifest.auth;
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
      return { error: '"auth" must be an object' };
    }
    const type = auth.type === undefined ? 'none' : auth.type;
    if (!AUTH_TYPES.includes(type)) {
      return { error: `bad auth.type ${JSON.stringify(type)} (one of ${AUTH_TYPES.join('|')})` };
    }
    mod.auth = { ...auth, type };
  } else {
    mod.auth = { type: 'none' };
  }

  if (manifest.profileFields !== undefined) {
    const fields = manifest.profileFields;
    if (!Array.isArray(fields)) return { error: '"profileFields" must be an array' };
    for (let i = 0; i < fields.length; i++) {
      const err = validateProfileField(fields[i], i);
      if (err) return { error: err };
    }
    mod.profileFields = fields;
  }

  if (side === 'main') {
    const entry = resolveEntry(manifest, moduleDir);
    if (!entry) {
      return { error: `entry script not found (entry: ${JSON.stringify(manifest.entry)}; tried ${ENTRY_CANDIDATES.join(', ')})` };
    }
    mod.entry = entry;
  } else if (manifest.entry !== undefined) {
    return { error: 'renderer-side modules must not declare an entry script' };
  }

  return { module: mod };
}

function validateProfileField(f, i) {
  const label = `profileFields[${i}]`;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'must be an object';
  if (typeof f.key !== 'string' || !f.key) return `${label}.key must be a non-empty string`;
  if (typeof f.label !== 'string' || !f.label) return `${label}.label must be a non-empty string`;
  if (!FIELD_TYPES.includes(f.type)) return `${label}.type must be one of ${FIELD_TYPES.join('|')}`;
  if (f.type === 'select') {
    if (!Array.isArray(f.options) || f.options.length === 0) {
      return `${label}.options must be a non-empty array for select fields`;
    }
    for (const o of f.options) {
      if (!o || typeof o !== 'object' || !('value' in o) || typeof o.label !== 'string') {
        return `${label}.options items must be { value, label }`;
      }
    }
  }
  if (f.required !== undefined && typeof f.required !== 'boolean') return `${label}.required must be boolean`;
  if (f.placeholder !== undefined && typeof f.placeholder !== 'string') return `${label}.placeholder must be string`;
  if (f.hint !== undefined && typeof f.hint !== 'string') return `${label}.hint must be string`;
  if (f.default !== undefined && f.default === null) return `${label}.default must not be null`;
  return undefined;
}

function resolveEntry(manifest, moduleDir) {
  const candidates = manifest.entry ? [manifest.entry] : ENTRY_CANDIDATES;
  for (const c of candidates) {
    const p = path.join(moduleDir, c);
    try {
      if (fs.statSync(p).isFile()) return c;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Split a renderer-submitted config into { config, secrets } per the
 * module manifest ("secret" fields are stored main-side only).
 */
export function splitSecretConfig(module, config) {
  const secretKeys = new Set((module.profileFields ?? []).filter((f) => f.type === 'secret').map((f) => f.key));
  const out = { config: {}, secrets: {} };
  for (const [k, v] of Object.entries(config ?? {})) {
    if (secretKeys.has(k)) out.secrets[k] = v;
    else out.config[k] = v;
  }
  return out;
}

/**
 * Validate config values against profileFields (required fields present).
 * Throws Error with a user-facing message.
 */
export function validateProfileConfig(module, config, secrets) {
  const merged = { ...config, ...secrets };
  const missing = [];
  for (const f of module.profileFields ?? []) {
    if (!f.required) continue;
    const v = merged[f.key];
    if (v === undefined || v === null || v === '') missing.push(f.label);
  }
  if (missing.length) throw new Error(`missing required field(s): ${missing.join(', ')}`);
}

async function runNpmInstall(moduleDir, log) {
  log('info', `running "npm install --omit=dev" in ${moduleDir}`);
  const args = ['install', '--omit=dev', '--no-audit', '--no-fund'];
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd: moduleDir, shell: false, env: process.env });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      output += '\n[host] npm install timed out';
    }, NPM_INSTALL_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      output += d;
    });
    child.stderr.on('data', (d) => {
      output += d;
    });
    // Stream npm output into the host log line by line.
    let carry = '';
    const pump = (chunk) => {
      carry += chunk;
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (t) log('info', `npm: ${t}`);
      }
    };
    child.stdout.on('data', (d) => pump(d.toString()));
    child.stderr.on('data', (d) => pump(d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`npm not available to install module deps: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (carry.trim()) log('info', `npm: ${carry.trim()}`);
      if (code === 0) {
        resolve();
      } else {
        const tail = output.trim().split('\n').slice(-10).join('\n');
        reject(new Error(`npm install exited with code ${code}\n${tail}`));
      }
    });
  });
}

export class ModuleHost {
  /**
   * @param {object} opts
   * @param {string} opts.appDir app root (contains bundled mshh_modules/)
   * @param {string} opts.userDataDir electron userData dir (user mshh_modules/ + per-profile data)
   * @param {object} [opts.store] ProfilesStore, used to resolve connectProfile(id)
   * @param {(level: string, msg: string) => void} [opts.log]
   */
  constructor({ appDir, userDataDir, store, log = () => {} }) {
    this.baseModulesDir = path.join(appDir, 'mshh_modules');
    this.userModulesDir = path.join(userDataDir, 'mshh_modules');
    this.profileDataRoot = path.join(userDataDir, 'profile-data');
    this.store = store;
    this.log = log;
    /** @type {Map<string, { client: any, moduleId: string }>} profileId -> client */
    this.clients = new Map();
    /** profileId -> Map(chatId -> { chatId, name, avatar?, unread?, pinned?, muted?, lastMessage?, messages: [] }) */
    this.chatState = new Map();
    /** profileId -> last status string */
    this.status = new Map();
    /** @type {Set<(e: {profileId: string, event: string, payload: any}) => void>} */
    this.listeners = new Set();
    /** moduleDir -> in-flight/finished npm install promise */
    this.installs = new Map();
  }

  onEvent(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  _emit(profileId, event, payload) {
    const e = { profileId, event, payload };
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        this.log('error', `event listener failed: ${err?.message ?? err}`);
      }
    }
  }

  _setStatus(profileId, status) {
    this.status.set(profileId, status);
    this._emit(profileId, 'status', status);
  }

  getStatus(profileId) {
    return this.status.get(profileId);
  }

  isConnected(profileId) {
    return this.clients.has(profileId);
  }

  listConnected() {
    return [...this.clients.keys()];
  }

  /** Scan base + user module dirs; user wins on id collision. */
  async listModules() {
    const byId = new Map();
    for (const dir of [this.baseModulesDir, this.userModulesDir]) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // dir missing or unreadable — not fatal
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const moduleDir = path.join(dir, ent.name);
        const manifestPath = path.join(moduleDir, 'module.json');
        let manifest;
        try {
          manifest = readJson(manifestPath);
        } catch {
          this.log('warn', `skipping ${moduleDir}: no readable module.json`);
          continue;
        }
        try {
          const { module, error } = validateModule(manifest, moduleDir);
          if (error) {
            this.log('warn', `skipping module in ${moduleDir}: ${error}`);
            continue;
          }
          if (byId.has(module.id)) {
            this.log('warn', `module id "${module.id}" from ${moduleDir} overrides ${byId.get(module.id).dir}`);
          }
          byId.set(module.id, module);
        } catch (err) {
          this.log('warn', `skipping module in ${moduleDir}: ${err.message}`);
        }
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getModule(moduleId) {
    const modules = await this.listModules();
    return modules.find((m) => m.id === moduleId);
  }

  async _ensureDeps(moduleDir) {
    const pkgPath = path.join(moduleDir, 'package.json');
    const nmPath = path.join(moduleDir, 'node_modules');
    let hasPkg = false;
    try {
      hasPkg = fs.statSync(pkgPath).isFile();
    } catch {
      hasPkg = false;
    }
    if (!hasPkg) return;
    let hasNm = false;
    try {
      hasNm = fs.statSync(nmPath).isDirectory();
    } catch {
      hasNm = false;
    }
    if (hasNm) return;
    let p = this.installs.get(moduleDir);
    if (!p) {
      p = runNpmInstall(moduleDir, this.log).finally(() => this.installs.delete(moduleDir));
      this.installs.set(moduleDir, p);
    }
    await p;
    // npm with zero deps may not create the dir; mark the install as done
    // so we don't re-run it on every connect.
    try {
      await fsp.mkdir(nmPath, { recursive: true });
    } catch {
      // best-effort marker
    }
    return p;
  }

  async _importEntry(entryPath) {
    const url = pathToFileURL(entryPath).href;
    const mod = await import(url);
    const factory = mod?.createClient ?? mod?.default?.createClient;
    if (typeof factory !== 'function') {
      throw new Error(`entry ${entryPath} does not export createClient`);
    }
    return factory;
  }

  /**
   * Connect a profile. Accepts the profile object or its id (requires store).
   */
  async connectProfile(profileOrId) {
    let profile = profileOrId;
    if (typeof profileOrId === 'string') {
      if (!this.store) throw new Error('connectProfile(id) requires a profiles store');
      profile = await this.store.get(profileOrId);
      if (!profile) throw new Error(`unknown profile ${profileOrId}`);
    }
    const { id: profileId, moduleId } = profile;
    if (typeof profileId !== 'string' || !profileId) throw new Error('profile has no id');
    if (typeof moduleId !== 'string' || !moduleId) throw new Error('profile has no moduleId');

    const module = await this.getModule(moduleId);
    if (!module) throw new Error(`unknown module "${moduleId}"`);
    if (module.side === 'renderer') {
      throw new Error(`module "${moduleId}" is renderer-side; its profiles are managed by the renderer`);
    }

    // Replace any existing client for this profile.
    if (this.clients.has(profileId)) {
      await this.disconnectProfile(profileId);
    }

    await this._ensureDeps(module.dir);
    const factory = await this._importEntry(path.join(module.dir, module.entry));

    const dataDir = path.join(this.profileDataRoot, profileId);
    await fsp.mkdir(dataDir, { recursive: true });

    const config = { ...profile.config, ...profile.secrets };
    const host = this;
    const ctx = {
      profileId,
      config,
      dataDir,
      emit: (event, payload) => host._onModuleEvent(profileId, event, payload),
      log: (level, msg) => host.log(level, `[${moduleId}/${profileId}] ${msg}`),
    };

    const client = await factory(ctx);
    if (!client || typeof client.connect !== 'function' || typeof client.disconnect !== 'function') {
      throw new Error(`module "${moduleId}" createClient must return { connect, disconnect, ... }`);
    }
    this.clients.set(profileId, { client, moduleId });
    this._setStatus(profileId, 'connecting');
    try {
      await client.connect();
    } catch (err) {
      this.clients.delete(profileId);
      const msg = err?.message ?? String(err);
      this._onModuleEvent(profileId, 'error', { message: msg });
      this._setStatus(profileId, 'offline');
      throw new Error(`module "${moduleId}" failed to connect: ${msg}`);
    }
    return client;
  }

  _onModuleEvent(profileId, event, payload) {
    switch (event) {
      case 'status': {
        this.status.set(profileId, payload);
        break;
      }
      case 'chats': {
        this._applyChatSnapshot(profileId, payload);
        break;
      }
      case 'chat-update': {
        this._applyChatUpdate(profileId, payload);
        break;
      }
      case 'message': {
        this._applyMessage(profileId, payload);
        break;
      }
      case 'receipt': {
        this._applyReceipt(profileId, payload);
        break;
      }
      case 'auth':
      case 'typing':
      case 'error':
      default:
        break; // forwarded as-is
    }
    this._emit(profileId, event, payload);
  }

  _chatsOf(profileId) {
    let m = this.chatState.get(profileId);
    if (!m) {
      m = new Map();
      this.chatState.set(profileId, m);
    }
    return m;
  }

  _applyChatSnapshot(profileId, snapshot) {
    if (!Array.isArray(snapshot)) return;
    const chats = this._chatsOf(profileId);
    const seen = new Set();
    for (const raw of snapshot) {
      if (!raw || typeof raw.chatId !== 'string') continue;
      seen.add(raw.chatId);
      const prev = chats.get(raw.chatId);
      chats.set(raw.chatId, {
        ...prev?.meta,
        ...raw,
        messages: prev?.messages ?? [],
      });
    }
    // drop chats no longer in the snapshot
    for (const chatId of [...chats.keys()]) {
      if (!seen.has(chatId)) chats.delete(chatId);
    }
  }

  _applyChatUpdate(profileId, patch) {
    if (!patch || typeof patch.chatId !== 'string') return;
    const chats = this._chatsOf(profileId);
    const prev = chats.get(patch.chatId) ?? { chatId: patch.chatId, messages: [] };
    const { chatId, ...rest } = patch;
    chats.set(chatId, { ...prev, ...rest });
  }

  _applyMessage(profileId, msg) {
    if (!msg || typeof msg.chatId !== 'string' || msg.id === undefined) return;
    const chats = this._chatsOf(profileId);
    const chat = chats.get(msg.chatId) ?? { chatId: msg.chatId, messages: [] };
    chats.set(msg.chatId, chat);
    const list = chat.messages;
    const idx = list.findIndex((m) => m.id === msg.id);
    const normalized = {
      chatId: msg.chatId,
      id: msg.id,
      text: msg.text,
      ts: typeof msg.ts === 'number' ? msg.ts : Date.now(),
      out: Boolean(msg.out),
    };
    if (msg.senderName !== undefined) normalized.senderName = msg.senderName;
    if (msg.mediaUrl !== undefined) normalized.mediaUrl = msg.mediaUrl;
    if (idx >= 0) list[idx] = normalized;
    else list.push(normalized);
    list.sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
    if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
    // keep chat meta in sync
    const last = list[list.length - 1];
    if (!chat.lastMessage || last.ts >= (chat.lastMessage.ts ?? 0)) {
      chat.lastMessage = {
        id: last.id,
        text: last.text,
        ts: last.ts,
        out: last.out,
        ...(last.senderName !== undefined ? { senderName: last.senderName } : {}),
      };
    }
  }

  _applyReceipt(profileId, payload) {
    if (!payload || typeof payload.chatId !== 'string') return;
    const chat = this._chatsOf(profileId).get(payload.chatId);
    if (chat) chat.lastReadId = payload.lastReadId;
  }

  _client(profileId, method) {
    const entry = this.clients.get(profileId);
    if (!entry) throw new Error(`profile ${profileId} is not connected`);
    const { client } = entry;
    if (method && typeof client[method] !== 'function') {
      throw new Error(`module client does not implement ${method}()`);
    }
    return client;
  }

  /** Snapshot of chats kept in memory from module `chats` events. */
  async getChats(profileId) {
    const chats = this.chatState.get(profileId);
    if (!chats) return [];
    return [...chats.values()].map(({ messages, ...meta }) => {
      const c = { chatId: meta.chatId, name: meta.name ?? meta.chatId };
      for (const k of ['avatar', 'unread', 'pinned', 'muted']) {
        if (meta[k] !== undefined) c[k] = meta[k];
      }
      if (meta.lastMessage) c.lastMessage = meta.lastMessage;
      return c;
    });
  }

  /** In-memory message history (last 200 per chat). */
  async getMessages(profileId, chatId) {
    const chat = this.chatState.get(profileId)?.get(chatId);
    return chat ? chat.messages.map((m) => ({ ...m })) : [];
  }

  async disconnectProfile(profileId) {
    const entry = this.clients.get(profileId);
    if (!entry) return;
    this.clients.delete(profileId);
    try {
      await entry.client.disconnect();
    } catch (err) {
      this.log('warn', `disconnect(${profileId}) failed: ${err?.message ?? err}`);
    }
    this._setStatus(profileId, 'offline');
  }

  async submitAuth(profileId, value) {
    const client = this._client(profileId, 'submitAuth');
    return client.submitAuth(value);
  }

  async send(profileId, chatId, text) {
    const client = this._client(profileId, 'send');
    const id = await client.send(chatId, text);
    return id === undefined || id === null ? undefined : String(id);
  }

  async markRead(profileId, chatId, messageId) {
    const client = this._client(profileId, 'markRead');
    return client.markRead(chatId, messageId);
  }

  async setTyping(profileId, chatId, on) {
    const client = this._client(profileId, 'setTyping');
    return client.setTyping(chatId, on);
  }

  /** Graceful disconnect of everything (app quit). */
  async disconnectAll() {
    const ids = this.listConnected();
    await Promise.allSettled(ids.map((id) => this.disconnectProfile(id)));
  }
}

export { MAX_MESSAGES_PER_CHAT };
