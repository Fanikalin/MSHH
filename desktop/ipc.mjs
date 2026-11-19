/**
 * ipcMain wiring for the MODULE_API.md contract.
 * Kept separate from main.mjs; electron is only imported here and in main/preload.
 */
import { splitSecretConfig, validateProfileConfig } from './moduleHost.mjs';

function asString(v, name) {
  if (typeof v !== 'string' || !v) throw new Error(`${name} must be a non-empty string`);
  return v;
}

function asObject(v, name) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${name} must be an object`);
  return v;
}

function handler(fn) {
  return async (event, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      // Errors surface as rejected promises in the renderer.
      throw err instanceof Error ? err : new Error(String(err));
    }
  };
}

/**
 * @param {object} opts
 * @param {Electron.IpcMain} opts.ipcMain
 * @param {import('./moduleHost.mjs').ModuleHost} opts.host
 * @param {import('./profilesStore.mjs').ProfilesStore} opts.store
 * @param {(payload: any) => void} opts.pushEvent deliver { profileId, event, payload } to renderer(s)
 */
export function registerIpc({ ipcMain, host, store, pushEvent }) {
  const off = host.onEvent((e) => {
    try {
      pushEvent(e);
    } catch {
      // window closing — ignore
    }
  });

  const on = (channel, fn) => ipcMain.handle(channel, handler(fn));

  on('mshh:listModules', async () => host.listModules());

  on('mshh:listProfiles', async () => store.listPublic());

  on('mshh:saveProfile', async (p) => {
    const input = asObject(p, 'profile');
    const moduleId = asString(input.moduleId, 'moduleId');
    const name = asString(input.name, 'name');
    const config = asObject(input.config, 'config');
    const module = await host.getModule(moduleId);
    if (!module) throw new Error(`unknown module "${moduleId}"`);

    const split = splitSecretConfig(module, config);
    validateProfileConfig(module, split.config, split.secrets);

    let profile;
    if (input.id !== undefined && input.id !== null) {
      const id = asString(input.id, 'id');
      const existing = await store.get(id);
      if (!existing) throw new Error(`unknown profile ${id}`);
      profile = await store.update(id, { name, config: split.config, secrets: split.secrets });
    } else {
      profile = await store.create({ moduleId, name, config: split.config, secrets: split.secrets });
    }

    // Auto-connect when enabled (edits reconnect with the new config).
    if (profile.enabled) {
      host.connectProfile(profile.id).catch((err) => {
        host.log('warn', `auto-connect(${profile.id}) failed: ${err.message}`);
        host._onModuleEvent(profile.id, 'error', { message: err.message });
      });
    }
    return { id: profile.id };
  });

  on('mshh:setProfileSecret', async (id, key, value) => {
    const profileId = asString(id, 'id');
    const secretKey = asString(key, 'key');
    if (value === null || value === undefined || typeof value !== 'string') {
      throw new Error('secret value must be a string');
    }
    await store.setSecret(profileId, secretKey, value);
    const profile = await store.get(profileId);
    if (profile?.enabled && host.isConnected(profileId)) {
      // module needs the new secret — restart with fresh config
      host.connectProfile(profileId).catch((err) => {
        host.log('warn', `reconnect(${profileId}) after secret change failed: ${err.message}`);
        host._onModuleEvent(profileId, 'error', { message: err.message });
      });
    }
  });

  on('mshh:deleteProfile', async (id) => {
    const profileId = asString(id, 'id');
    await host.disconnectProfile(profileId);
    await store.remove(profileId);
  });

  on('mshh:setEnabled', async (id, enabled) => {
    const profileId = asString(id, 'id');
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
    await store.setEnabled(profileId, enabled);
    if (enabled) {
      host.connectProfile(profileId).catch((err) => {
        host.log('warn', `enable-connect(${profileId}) failed: ${err.message}`);
        host._onModuleEvent(profileId, 'error', { message: err.message });
      });
    } else {
      await host.disconnectProfile(profileId);
    }
  });

  on('mshh:connect', async (id) => {
    await host.connectProfile(asString(id, 'id'));
  });

  on('mshh:disconnect', async (id) => {
    await host.disconnectProfile(asString(id, 'id'));
  });

  on('mshh:submitAuth', async (id, value) => {
    await host.submitAuth(asString(id, 'id'), value);
  });

  on('mshh:send', async (id, chatId, text) => {
    return host.send(asString(id, 'id'), asString(chatId, 'chatId'), asString(text, 'text'));
  });

  on('mshh:markRead', async (id, chatId, messageId) => {
    if (messageId !== undefined && messageId !== null && typeof messageId !== 'string') {
      throw new Error('messageId must be a string');
    }
    await host.markRead(asString(id, 'id'), asString(chatId, 'chatId'), messageId ?? undefined);
  });

  on('mshh:setTyping', async (id, chatId, onTyping) => {
    if (typeof onTyping !== 'boolean') throw new Error('on must be a boolean');
    await host.setTyping(asString(id, 'id'), asString(chatId, 'chatId'), onTyping);
  });

  on('mshh:getChats', async (id) => host.getChats(asString(id, 'id')));

  on('mshh:getMessages', async (id, chatId) => {
    return host.getMessages(asString(id, 'id'), asString(chatId, 'chatId'));
  });

  return () => {
    off();
    for (const ch of [
      'mshh:listModules',
      'mshh:listProfiles',
      'mshh:saveProfile',
      'mshh:setProfileSecret',
      'mshh:deleteProfile',
      'mshh:setEnabled',
      'mshh:connect',
      'mshh:disconnect',
      'mshh:submitAuth',
      'mshh:send',
      'mshh:markRead',
      'mshh:setTyping',
      'mshh:getChats',
      'mshh:getMessages',
    ]) {
      ipcMain.removeHandler(ch);
    }
  };
}
