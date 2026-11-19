/**
 * Electron-free smoke test for desktop/moduleHost.mjs + desktop/profilesStore.mjs.
 * Run: node desktop/selftest.mjs
 * Uses only tmp dirs; never touches real mshh_modules/ or userData.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleHost, validateModule, splitSecretConfig, validateProfileConfig } from './moduleHost.mjs';
import { ProfilesStore } from './profilesStore.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mshh-selftest-'));
const appDir = path.join(tmp, 'app');
const userData = path.join(tmp, 'user-data');
const baseModules = path.join(appDir, 'mshh_modules');
const userModules = path.join(userData, 'mshh_modules');
fs.mkdirSync(baseModules, { recursive: true });
fs.mkdirSync(userModules, { recursive: true });

const logs = [];
const log = (level, msg) => logs.push(`[${level}] ${msg}`);
const test = async (name, fn) => {
  await fn();
  console.log(`ok - ${name}`);
};

const ECHO_CJS = `module.exports.createClient = function createClient(ctx) {
  const calls = [];
  const client = {
    ctx,
    calls,
    async connect() {
      calls.push(['connect']);
      ctx.emit('status', 'online');
      ctx.emit('chats', [
        { chatId: 'c1', name: 'Chat One', unread: 2, pinned: true, lastMessage: { id: 'm0', text: 'hello', ts: 1000, out: false } },
        { chatId: 'c2', name: 'Chat Two' },
      ]);
      ctx.emit('message', { chatId: 'c1', id: 'm0', text: 'hello', ts: 1000, out: false, senderName: 'bob' });
      ctx.emit('message', { chatId: 'c1', id: 'm1', text: 'hi there', ts: 2000, out: true });
    },
    async disconnect() { calls.push(['disconnect']); ctx.emit('status', 'offline'); },
    async send(chatId, text) {
      calls.push(['send', chatId, text]);
      const id = 'sent-' + calls.length;
      ctx.emit('message', { chatId, id, text, ts: Date.now(), out: true });
      return id;
    },
    async markRead(chatId, messageId) { calls.push(['markRead', chatId, messageId]); ctx.emit('receipt', { chatId, lastReadId: messageId }); },
    async setTyping(chatId, on) { calls.push(['setTyping', chatId, on]); ctx.emit('typing', { chatId, who: 'me', on }); },
    async submitAuth(value) { calls.push(['submitAuth', value]); ctx.emit('auth', { type: 'done' }); },
  };
  return client;
};`;

const ECHO_USER_MJS = `export function createClient(ctx) {
  const calls = [];
  const client = {
    ctx,
    calls,
    async connect() {
      calls.push(['connect']);
      ctx.emit('status', 'online');
      ctx.emit('chats', [
        { chatId: 'c1', name: 'Chat One', unread: 2, pinned: true, lastMessage: { id: 'm0', text: 'hello', ts: 1000, out: false } },
        { chatId: 'c2', name: 'Chat Two' },
      ]);
      ctx.emit('message', { chatId: 'c1', id: 'm0', text: 'hello', ts: 1000, out: false, senderName: 'bob' });
      ctx.emit('message', { chatId: 'c1', id: 'm1', text: 'hi there', ts: 2000, out: true });
    },
    async disconnect() { calls.push(['disconnect']); ctx.emit('status', 'offline'); },
    async send(chatId, text) {
      calls.push(['send', chatId, text]);
      const id = 'sent-' + calls.length;
      ctx.emit('message', { chatId, id, text, ts: Date.now(), out: true });
      return id;
    },
    async markRead(chatId, messageId) { calls.push(['markRead', chatId, messageId]); ctx.emit('receipt', { chatId, lastReadId: messageId }); },
    async setTyping(chatId, on) { calls.push(['setTyping', chatId, on]); ctx.emit('typing', { chatId, who: 'me', on }); },
    async submitAuth(value) { calls.push(['submitAuth', value]); ctx.emit('auth', { type: 'done' }); },
  };
  return client;
}`;

const SPAM_CJS = `module.exports.createClient = function createClient(ctx) {
  return {
    async connect() {
      ctx.emit('status', 'online');
      ctx.emit('chats', [{ chatId: 's1', name: 'Spam' }]);
      for (let i = 0; i < 250; i++) {
        ctx.emit('message', { chatId: 's1', id: 'm' + i, text: 'msg ' + i, ts: i, out: false });
      }
    },
    async disconnect() {},
    async send() { return 'x'; },
    async markRead() {},
    async setTyping() {},
  };
};`;

const INSTALLER_CJS = `module.exports.createClient = function createClient(ctx) {
  return {
    async connect() { ctx.emit('status', 'online'); },
    async disconnect() {},
    async send() { return 'i1'; },
    async markRead() {},
    async setTyping() {},
  };
};`;

// --- fixtures on disk -----------------------------------------------------
const write = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

write(path.join(baseModules, 'echo', 'module.json'), JSON.stringify({
  id: 'echo', name: 'Echo', version: '1.0.0', side: 'main',
  description: 'test module',
  auth: { type: 'code' },
  profileFields: [
    { key: 'token', label: 'Token', type: 'secret', required: true },
    { key: 'region', label: 'Region', type: 'select', options: [{ value: 'eu', label: 'EU' }], default: 'eu' },
    { key: 'port', label: 'Port', type: 'number', required: true },
  ],
}));
write(path.join(baseModules, 'echo', 'index.cjs'), ECHO_CJS);

write(path.join(userModules, 'echo', 'module.json'), JSON.stringify({
  id: 'echo', name: 'Echo User', version: '9.9.9', side: 'main', entry: 'index.mjs',
}));
write(path.join(userModules, 'echo', 'index.mjs'), ECHO_USER_MJS);

write(path.join(baseModules, 'matrix', 'module.json'), JSON.stringify({
  id: 'matrix', name: 'Matrix', version: '1.0.0', side: 'renderer',
  auth: { type: 'builtin-login' },
  profileFields: [{ key: 'userId', label: 'User ID', type: 'string' }],
}));

write(path.join(baseModules, 'bad-id', 'module.json'), JSON.stringify({ id: 'Bad ID!', name: 'Bad', version: '1', side: 'main' }));
write(path.join(baseModules, 'no-entry', 'module.json'), JSON.stringify({ id: 'no-entry', name: 'No Entry', version: '1', side: 'main' }));
write(path.join(baseModules, 'bad-field', 'module.json'), JSON.stringify({
  id: 'bad-field', name: 'Bad Field', version: '1', side: 'main',
  profileFields: [{ key: 'x', label: 'X', type: 'color' }],
}));

write(path.join(baseModules, 'spam', 'module.json'), JSON.stringify({ id: 'spam', name: 'Spam', version: '1.0.0', side: 'main' }));
write(path.join(baseModules, 'spam', 'index.cjs'), SPAM_CJS);

write(path.join(baseModules, 'installer', 'module.json'), JSON.stringify({ id: 'installer', name: 'Installer', version: '1.0.0', side: 'main' }));
write(path.join(baseModules, 'installer', 'index.cjs'), INSTALLER_CJS);
write(path.join(baseModules, 'installer', 'package.json'), JSON.stringify({ name: 'installer-mod', version: '1.0.0', private: true }));
// no node_modules → host must run npm install

// --- validation unit tests ------------------------------------------------
await test('validateModule accepts the echo manifest', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(baseModules, 'echo', 'module.json'), 'utf8'));
  const { module, error } = validateModule(manifest, path.join(baseModules, 'echo'));
  assert.equal(error, undefined);
  assert.equal(module.id, 'echo');
  assert.equal(module.entry, 'index.cjs');
  assert.equal(module.auth.type, 'code');
});

await test('validateModule rejects bad id / bad field type', async () => {
  assert.ok(validateModule({ id: 'UPPER', name: 'x', version: '1', side: 'main' }, '.').error);
  assert.ok(validateModule({ id: 'ok', name: 'x', version: '1', side: 'sideways' }, '.').error);
  assert.ok(validateModule({ id: 'ok', name: 'x', version: '1', side: 'main', profileFields: [{ key: 'a', label: 'A', type: 'nope' }] }, '.').error);
  assert.ok(validateModule({ id: 'ok', name: 'x', version: '1', side: 'main', profileFields: [{ key: 'a', label: 'A', type: 'select' }] }, '.').error, 'select without options');
  assert.ok(validateModule({ id: 'ok', name: 'x', version: '1', side: 'renderer', entry: 'index.js' }, '.').error, 'renderer with entry');
});

await test('splitSecretConfig separates secret-typed fields', async () => {
  const mod = { profileFields: [{ key: 'token', type: 'secret' }, { key: 'host', type: 'string' }] };
  const { config, secrets } = splitSecretConfig(mod, { token: 's3cret', host: 'example.org', extra: 1 });
  assert.deepEqual(config, { host: 'example.org', extra: 1 });
  assert.deepEqual(secrets, { token: 's3cret' });
});

await test('validateProfileConfig reports missing required fields', () => {
  const mod = { profileFields: [
    { key: 'token', label: 'Token', type: 'secret', required: true },
    { key: 'n', label: 'Num', type: 'number', required: true },
    { key: 'opt', label: 'Opt', type: 'string' },
  ] };
  assert.throws(() => validateProfileConfig(mod, { token: 'x' }, {}), /Num/);
  assert.doesNotThrow(() => validateProfileConfig(mod, { n: 0 }, { token: 'x' }));
});

// --- profiles store -------------------------------------------------------
const store = new ProfilesStore({ file: path.join(userData, 'profiles.json') });
await store.load();

await test('store create + listPublic strips secrets', async () => {
  const p = await store.create({ moduleId: 'echo', name: 'Echo 1', config: { region: 'eu', port: 443 }, secrets: { token: 's3cret' } });
  assert.match(p.id, /^[0-9a-f-]{36}$/);
  const pub = await store.listPublic();
  assert.equal(pub.length, 1);
  assert.deepEqual(pub[0], { id: p.id, moduleId: 'echo', name: 'Echo 1', config: { region: 'eu', port: 443 }, enabled: true });
  const raw = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(raw.profiles[0].secrets.token, 's3cret');
});

await test('store update merges secrets, replaces config', async () => {
  const p = (await store.list())[0];
  await store.update(p.id, { name: 'Echo 1 renamed', config: { region: 'us' }, secrets: { token: 'new' } });
  const got = await store.get(p.id);
  assert.equal(got.name, 'Echo 1 renamed');
  assert.deepEqual(got.config, { region: 'us' });
  assert.deepEqual(got.secrets, { token: 'new' });
});

await test('store setSecret / setEnabled / remove', async () => {
  const p = (await store.list())[0];
  await store.setSecret(p.id, 'token', 'rotated');
  assert.equal((await store.get(p.id)).secrets.token, 'rotated');
  await store.setEnabled(p.id, false);
  assert.equal((await store.get(p.id)).enabled, false);
  await store.setEnabled(p.id, true);
  await store.setSecret(p.id, 'token', null);
  assert.equal('token' in (await store.get(p.id)).secrets, false);
  const p2 = await store.create({ moduleId: 'spam', name: 'Spam 1' });
  assert.equal(await store.remove(p2.id), true);
  assert.equal(await store.remove('nope'), false);
});

await test('store reloads persisted file', async () => {
  const again = new ProfilesStore({ file: store.file });
  await again.load();
  assert.equal((await again.listPublic())[0].name, 'Echo 1 renamed');
});

// --- module host ----------------------------------------------------------
const host = new ModuleHost({ appDir, userDataDir: userData, store, log });

await test('listModules: user dir wins id collision, invalid skipped, renderer listed', async () => {
  const mods = await host.listModules();
  const ids = mods.map((m) => m.id);
  assert.ok(ids.includes('echo'), 'echo present');
  assert.ok(ids.includes('matrix'), 'matrix present');
  assert.ok(!ids.includes('bad-id'), 'bad id skipped');
  assert.ok(!ids.includes('no-entry'), 'missing entry skipped');
  assert.ok(!ids.includes('bad-field'), 'bad field skipped');
  const echo = mods.find((m) => m.id === 'echo');
  assert.equal(echo.name, 'Echo User');
  assert.equal(echo.dir, path.join(userModules, 'echo'));
  const matrix = mods.find((m) => m.id === 'matrix');
  assert.equal(matrix.entry, undefined);
});

const events = [];
host.onEvent((e) => events.push(e));

await test('connectProfile(profile object): events, chats snapshot, message history', async () => {
  const profile = (await store.list())[0];
  await host.connectProfile(profile);
  const chats = await host.getChats(profile.id);
  assert.equal(chats.length, 2);
  const c1 = chats.find((c) => c.chatId === 'c1');
  assert.equal(c1.name, 'Chat One');
  assert.equal(c1.unread, 2);
  assert.equal(c1.pinned, true);
  assert.equal(c1.lastMessage.id, 'm1', 'lastMessage follows newest message');
  const msgs = await host.getMessages(profile.id, 'c1');
  assert.deepEqual(msgs.map((m) => m.id), ['m0', 'm1']);
  assert.equal(msgs[0].senderName, 'bob');
  assert.equal(host.getStatus(profile.id), 'online');
  const kinds = events.map((e) => `${e.profileId}:${e.event}`);
  assert.ok(kinds.includes(`${profile.id}:chats`));
  assert.ok(kinds.includes(`${profile.id}:message`));
  assert.ok(events.some((e) => e.event === 'status' && e.payload === 'connecting'));
  assert.ok(events.some((e) => e.event === 'status' && e.payload === 'online'));
});

await test('send/markRead/setTyping/submitAuth reach the client', async () => {
  const profile = (await store.list())[0];
  const client = host.clients.get(profile.id).client;
  const sentId = await host.send(profile.id, 'c1', 'outgoing');
  assert.equal(sentId, 'sent-2');
  await host.markRead(profile.id, 'c1', 'm1');
  await host.setTyping(profile.id, 'c1', true);
  await host.submitAuth(profile.id, '123456');
  assert.deepEqual(client.calls, [
    ['connect'],
    ['send', 'c1', 'outgoing'],
    ['markRead', 'c1', 'm1'],
    ['setTyping', 'c1', true],
    ['submitAuth', '123456'],
  ]);
  const msgs = await host.getMessages(profile.id, 'c1');
  assert.ok(msgs.some((m) => m.id === 'sent-2' && m.out === true), 'sent message stored');
  const c1 = (await host.getChats(profile.id)).find((c) => c.chatId === 'c1');
  assert.equal(c1.lastMessage.id, 'sent-2', 'lastMessage follows newest message');
});

await test('receipt and typing events forwarded', async () => {
  assert.ok(events.some((e) => e.event === 'receipt' && e.payload.lastReadId === 'm1'));
  assert.ok(events.some((e) => e.event === 'typing' && e.payload.on === true));
});

await test('chat-update merges into snapshot', async () => {
  const profile = (await store.list())[0];
  const client = host.clients.get(profile.id).client;
  client.ctx.emit('chat-update', { chatId: 'c2', name: 'Chat Two Renamed', unread: 5 });
  const c2 = (await host.getChats(profile.id)).find((c) => c.chatId === 'c2');
  assert.equal(c2.name, 'Chat Two Renamed');
  assert.equal(c2.unread, 5);
});

await test('disconnectProfile is graceful and idempotent; ops after fail', async () => {
  const profile = (await store.list())[0];
  const client = host.clients.get(profile.id).client;
  await host.disconnectProfile(profile.id);
  assert.ok(client.calls.some((c) => c[0] === 'disconnect'));
  assert.equal(host.isConnected(profile.id), false);
  await host.disconnectProfile(profile.id); // no-op
  assert.equal(host.getStatus(profile.id), 'offline');
  await assert.rejects(() => host.send(profile.id, 'c1', 'x'), /not connected/);
});

await test('connectProfile(id string) resolves via store; reconnect replaces client', async () => {
  const profile = (await store.list())[0];
  await host.connectProfile(profile.id);
  const first = host.clients.get(profile.id).client;
  await host.connectProfile(profile.id);
  const second = host.clients.get(profile.id).client;
  assert.notEqual(first, second);
  assert.ok(first.calls.some((c) => c[0] === 'disconnect'), 'old client disconnected');
  assert.equal(host.isConnected(profile.id), true);
});

await test('connect errors surface as error event + rejection', async () => {
  write(path.join(baseModules, 'failmod', 'module.json'), JSON.stringify({ id: 'failmod', name: 'Failmod', version: '1', side: 'main' }));
  write(path.join(baseModules, 'failmod', 'index.cjs'), `module.exports.createClient = () => ({
    async connect() { throw new Error('nope'); },
    async disconnect() {},
  });`);
  const errs = [];
  const off = host.onEvent((e) => { if (e.event === 'error') errs.push(e.payload.message); });
  const profile = await store.create({ moduleId: 'failmod', name: 'Failing' });
  await assert.rejects(() => host.connectProfile(profile.id), /failed to connect: nope/);
  assert.ok(errs.some((m) => m.includes('nope')));
  off();
  await store.remove(profile.id);
});

await test('connectProfile rejects for unknown profile/module and renderer modules', async () => {
  await assert.rejects(() => host.connectProfile('ghost-id'), /unknown profile/);
  await assert.rejects(() => host.connectProfile({ id: 'x', moduleId: 'ghost' }), /unknown module/);
  await assert.rejects(() => host.connectProfile({ id: 'x', moduleId: 'matrix' }), /renderer-side/);
  await store.create({ moduleId: 'ghost', name: 'Ghost' }); // create then expect unknown module on connect by id
  const ghost = (await store.list()).find((p) => p.moduleId === 'ghost');
  await assert.rejects(() => host.connectProfile(ghost.id), /unknown module "ghost"/);
  await store.remove(ghost.id);
});

await test('client without connect/disconnect is rejected', async () => {
  write(path.join(baseModules, 'lazy', 'module.json'), JSON.stringify({ id: 'lazy', name: 'Lazy', version: '1', side: 'main' }));
  write(path.join(baseModules, 'lazy', 'index.cjs'), 'module.exports.createClient = () => ({});');
  const profile = await store.create({ moduleId: 'lazy', name: 'Lazy 1' });
  await assert.rejects(() => host.connectProfile(profile.id), /connect/);
  await store.remove(profile.id);
});

await test('message history capped at 200, oldest dropped, sorted by ts', async () => {
  const profile = await store.create({ moduleId: 'spam', name: 'Spam 1' });
  await host.connectProfile(profile);
  const msgs = await host.getMessages(profile.id, 's1');
  assert.equal(msgs.length, 200);
  assert.equal(msgs[0].id, 'm50');
  assert.equal(msgs[199].id, 'm249');
  for (let i = 1; i < msgs.length; i++) assert.ok(msgs[i].ts >= msgs[i - 1].ts);
  await host.disconnectProfile(profile.id);
  await store.remove(profile.id);
});

await test('getMessages returns copies; unknown chat/profile yields empty', async () => {
  assert.deepEqual(await host.getMessages('ghost', 'c'), []);
  const profile = (await store.list())[0];
  await host.connectProfile(profile.id);
  const msgs = await host.getMessages(profile.id, 'c1');
  msgs.length = 0;
  assert.equal((await host.getMessages(profile.id, 'c1')).length > 0, true);
  assert.deepEqual(await host.getMessages(profile.id, 'unknown-chat'), []);
  await host.disconnectProfile(profile.id);
});

await test('npm install runs when package.json exists and node_modules missing', async () => {
  const profile = await store.create({ moduleId: 'installer', name: 'Inst 1' });
  await host.connectProfile(profile);
  assert.ok(fs.existsSync(path.join(baseModules, 'installer', 'node_modules')), 'node_modules created by npm install');
  assert.equal(host.getStatus(profile.id), 'online');
  await host.disconnectProfile(profile.id);
  await store.remove(profile.id);
});

await test('npm install not re-run when node_modules exists', async () => {
  const nm = path.join(baseModules, 'installer', 'node_modules');
  const before = fs.statSync(nm).mtimeMs;
  const profile = await store.create({ moduleId: 'installer', name: 'Inst 2' });
  await host.connectProfile(profile);
  assert.equal(fs.statSync(nm).mtimeMs, before, 'node_modules untouched');
  await host.disconnectProfile(profile.id);
  await store.remove(profile.id);
});

await test('disconnectAll disconnects every client', async () => {
  const p1 = await store.create({ moduleId: 'echo', name: 'A' });
  const p2 = await store.create({ moduleId: 'echo', name: 'B' });
  await host.connectProfile(p1);
  await host.connectProfile(p2);
  assert.equal(host.listConnected().length, 2);
  await host.disconnectAll();
  assert.equal(host.listConnected().length, 0);
});

console.log(`\nall selftests passed (tmp: ${tmp})`);
fs.rmSync(tmp, { recursive: true, force: true });
