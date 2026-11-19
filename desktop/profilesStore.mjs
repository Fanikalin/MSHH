import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Persistence for main-side profiles: <userData>/profiles.json
 * Shape: { profiles: [{ id, moduleId, name, config, secrets, enabled }] }
 * `secrets` never leaves this process (listPublic strips them).
 */
export class ProfilesStore {
  /** @param {object} opts @param {string} opts.file absolute path to profiles.json */
  constructor({ file }) {
    this.file = file;
    /** @type {{ profiles: any[] } | null} */
    this.data = null;
    /** serialized mutation queue -> atomic, no concurrent writes */
    this._queue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const profiles = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
      this.data = { profiles: profiles.filter((p) => p && typeof p.id === 'string') };
    } catch {
      this.data = { profiles: [] };
    }
    return this;
  }

  async _persistLocked() {
    const dir = path.dirname(this.file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.profiles-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    const body = JSON.stringify(this.data, null, 2);
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(body, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, this.file); // atomic on POSIX
  }

  /** Serialize mutations so concurrent IPC calls can't interleave writes. */
  _mutate(fn) {
    const run = this._queue.then(fn);
    this._queue = run.catch(() => {});
    return run;
  }

  _findLocked(id) {
    return this.data.profiles.find((p) => p.id === id);
  }

  /** All profiles including secrets — main process internal use only. */
  async list() {
    if (!this.data) await this.load();
    return this.data.profiles.map((p) => ({ ...p, config: { ...p.config }, secrets: { ...p.secrets } }));
  }

  /** Renderer-safe profile metadata (no secrets). */
  async listPublic() {
    const all = await this.list();
    return all.map(({ secrets, ...p }) => p);
  }

  async get(id) {
    if (!this.data) await this.load();
    const p = this._findLocked(id);
    return p ? { ...p, config: { ...p.config }, secrets: { ...p.secrets } } : undefined;
  }

  async create({ moduleId, name, config = {}, secrets = {}, enabled = true }) {
    if (typeof moduleId !== 'string' || !moduleId) throw new Error('moduleId is required');
    if (typeof name !== 'string' || !name.trim()) throw new Error('name is required');
    if (!config || typeof config !== 'object') throw new Error('config must be an object');
    if (!secrets || typeof secrets !== 'object') throw new Error('secrets must be an object');
    return this._mutate(() => {
      const profile = {
        id: crypto.randomUUID(),
        moduleId,
        name,
        config: { ...config },
        secrets: { ...secrets },
        enabled: Boolean(enabled),
      };
      this.data.profiles.push(profile);
      return this._persistLocked().then(() => ({ ...profile, config: { ...profile.config }, secrets: { ...profile.secrets } }));
    });
  }

  /** Merge-patch a profile; config replaces, secrets merge. Returns updated copy or undefined. */
  async update(id, patch = {}) {
    return this._mutate(() => {
      const p = this._findLocked(id);
      if (!p) return undefined;
      if (patch.name !== undefined) {
        if (typeof patch.name !== 'string' || !patch.name.trim()) throw new Error('name is required');
        p.name = patch.name;
      }
      if (patch.config !== undefined) {
        if (!patch.config || typeof patch.config !== 'object') throw new Error('config must be an object');
        p.config = { ...patch.config };
      }
      if (patch.secrets !== undefined) {
        if (!patch.secrets || typeof patch.secrets !== 'object') throw new Error('secrets must be an object');
        p.secrets = { ...p.secrets, ...patch.secrets };
      }
      if (patch.enabled !== undefined) p.enabled = Boolean(patch.enabled);
      return this._persistLocked().then(() => ({ ...p, config: { ...p.config }, secrets: { ...p.secrets } }));
    });
  }

  /** Set or remove (value === null) a single secret. */
  async setSecret(id, key, value) {
    if (typeof key !== 'string' || !key) throw new Error('secret key is required');
    return this._mutate(() => {
      const p = this._findLocked(id);
      if (!p) throw new Error(`unknown profile ${id}`);
      if (value === null) delete p.secrets[key];
      else p.secrets[key] = value;
      return this._persistLocked();
    });
  }

  async setEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
    return this._mutate(() => {
      const p = this._findLocked(id);
      if (!p) throw new Error(`unknown profile ${id}`);
      p.enabled = enabled;
      return this._persistLocked();
    });
  }

  async remove(id) {
    return this._mutate(() => {
      const before = this.data.profiles.length;
      this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
      const removed = this.data.profiles.length < before;
      return removed ? this._persistLocked().then(() => true) : false;
    });
  }
}

export function profilesFileFor(userDataDir) {
  return path.join(userDataDir, 'profiles.json');
}

/** Check file parses + shape is valid (used by selftest / diagnostics). */
export function readProfilesFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
