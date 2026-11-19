'use strict';
// Profile store: userData/profiles.json, atomic writes.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateManifest } = require('./contract.cjs');

class ProfileStore {
  constructor(userDataDir, modules /* [{manifest,dir}] */) {
    this.file = path.join(userDataDir, 'profiles.json');
    this.modulesById = new Map(modules.map((m) => [m.manifest.id, m]));
    this.data = this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && Array.isArray(raw.profiles)) return raw;
    } catch {
      /* first run or corrupted → recreate */
    }
    return { version: 1, profiles: [] };
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.data.profiles;
  }

  get(id) {
    return this.data.profiles.find((p) => p.id === id);
  }

  /** Validate config against module field schema. Returns { errors: string[] }. */
  validateConfig(moduleId, config) {
    const errors = [];
    const module_ = this.modulesById.get(moduleId);
    if (!module_) return [`Неизвестный модуль "${moduleId}"`];
    const cfg = config && typeof config === 'object' ? config : {};
    for (const f of module_.manifest.fields || []) {
      const v = cfg[f.name];
      const empty = v === undefined || v === null || v === '';
      if (f.required && empty) {
        errors.push(`«${f.label || f.name}»: обязательное поле`);
        continue;
      }
      if (empty) continue;
      if (f.type === 'number' && (typeof v !== 'number' || Number.isNaN(v))) {
        errors.push(`«${f.label || f.name}»: должно быть числом`);
      }
      if (f.type === 'boolean' && typeof v !== 'boolean') {
        errors.push(`«${f.label || f.name}»: должно быть true/false`);
      }
      if (f.type === 'select' && !f.options.includes(v)) {
        errors.push(`«${f.label || f.name}»: недопустимое значение`);
      }
      if ((f.type === 'text' || f.type === 'password') && typeof v !== 'string') {
        errors.push(`«${f.label || f.name}»: должна быть строкой`);
      }
    }
    return errors;
  }

  create({ moduleId, name, config, enabled = true }) {
    const errors = this.validateConfig(moduleId, config);
    if (errors.length) throw new MshhUserError(errors.join('; '));
    const profile = {
      id: `p_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
      moduleId,
      name: (name || '').trim() || this.modulesById.get(moduleId)?.manifest.name || moduleId,
      enabled: !!enabled,
      config,
      createdAt: Date.now(),
    };
    this.data.profiles.push(profile);
    this.save();
    return profile;
  }

  /** Apply patch { name?, enabled?, config? }. Full config replace (form-driven). */
  update(id, patch) {
    const profile = this.get(id);
    if (!profile) throw new MshhUserError('Профиль не найден');
    if (patch.config !== undefined) {
      const errors = this.validateConfig(profile.moduleId, patch.config);
      if (errors.length) throw new MshhUserError(errors.join('; '));
      profile.config = patch.config;
    }
    if (typeof patch.name === 'string' && patch.name.trim()) profile.name = patch.name.trim();
    if (typeof patch.enabled === 'boolean') profile.enabled = patch.enabled;
    this.save();
    return profile;
  }

  delete(id) {
    const before = this.data.profiles.length;
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    if (this.data.profiles.length === before) throw new MshhUserError('Профиль не найден');
    this.save();
  }
}

class MshhUserError extends Error {}

/** Sessions root: per-profile module data dirs live here. */
function sessionsRoot(userDataDir) {
  return path.join(userDataDir, 'sessions');
}

function profileDataDir(userDataDir, profileId) {
  const dir = path.join(sessionsRoot(userDataDir), profileId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Scan mshh_modules/ for module folders. Returns [{manifest, dir, entry}]. */
async function loadModules(repoRoot, log) {
  const modulesDir = path.join(repoRoot, 'mshh_modules');
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(modulesDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    log('warn', `нет папки модулей: ${modulesDir}`);
    return found;
  }
  for (const entry of entries) {
    const dir = path.join(modulesDir, entry.name);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      log('warn', `пропущен ${entry.name}: нет manifest.json`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      log('error', `пропущен ${entry.name}: manifest.json битый — ${e.message}`);
      continue;
    }
    const problems = validateManifest(manifest, entry.name);
    if (problems.length) {
      log('error', `пропущен ${entry.name}: ${problems.join('; ')}`);
      continue;
    }
    const entryFile = path.join(dir, 'index.js');
    if (!fs.existsSync(entryFile)) {
      log('error', `пропущен ${entry.name}: нет index.js`);
      continue;
    }
    found.push({ manifest, dir, entry: entryFile });
  }
  // dependency auto-install for third-party modules with their own package.json
  for (const m of found) {
    await ensureDeps(m, log);
  }
  return found;
}

async function ensureDeps(module_, log) {
  const pkgPath = path.join(module_.dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return;
  }
  const deps = pkg.dependencies || {};
  const missing = Object.keys(deps).filter(
    (d) => !fs.existsSync(path.join(module_.dir, 'node_modules', d, 'package.json'))
  );
  if (!missing.length) return;
  log('info', `модуль ${module_.manifest.id}: установка зависимостей (${missing.join(', ')})`);
  const { execFile } = require('node:child_process');
  await new Promise((resolve) => {
    execFile('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: module_.dir }, (err, stdout, stderr) => {
      if (err) log('error', `модуль ${module_.manifest.id}: npm install failed — ${stderr || err.message}`);
      resolve();
    });
  });
}

/** Dynamic-import a module factory (works for CJS and ESM). */
async function importModuleFactory(entryFile) {
  const mod = await import(`file://${entryFile.replace(/\\/g, '/')}`);
  return mod.create ?? mod.default?.create;
}

module.exports = { ProfileStore, MshhUserError, sessionsRoot, profileDataDir, loadModules, importModuleFactory };
