#!/usr/bin/env node
'use strict';
// Module smoke test: validates manifest + loads factory + runs a connect
// attempt with fake credentials (must fail cleanly, not hang or crash).
// Usage: node scripts/module-smoke.js mshh_modules/<id>

const fs = require('node:fs');
const path = require('node:path');
const { validateManifest } = require('../electron/core/contract.cjs');

const dir = path.resolve(process.argv[2] || '');
if (!fs.existsSync(dir)) {
  console.error(`FAIL: папка не найдена: ${dir}`);
  process.exit(1);
}
const dirName = path.basename(dir);
let failures = 0;
const fail = (m) => { failures++; console.error(`FAIL: ${m}`); };

// 1. manifest
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
} catch (e) {
  fail(`manifest.json: ${e.message}`);
  process.exit(1);
}
const problems = validateManifest(manifest, dirName);
problems.forEach(fail);

// 2. factory loads
let mod;
try {
  mod = require(path.join(dir, 'index.js'));
} catch (e) {
  fail(`index.js не загружается: ${e.message}`);
  process.exit(1);
}
const create = mod?.create ?? mod?.default?.create;
if (typeof create !== 'function') fail('index.js не экспортирует create()');

// 3. fake ctx + connect must terminate (usually with an auth error)
const dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), `mshh-smoke-${dirName}-`));
const events = [];
const ctx = {
  profileId: 'smoke',
  name: dirName,
  config: fakeConfig(manifest),
  dataDir,
  log: (level, msg) => console.log(`  [${level}] ${msg}`),
  emit: (type, payload) => events.push({ type, payload }),
  prompt: () => Promise.resolve({}),
};
const timeout = setTimeout(() => {
  fail('connect() не завершился за 30с (завис?)');
  process.exit(1);
}, 30000);

(async () => {
  let api;
  try {
    api = create(ctx);
    for (const m of ['connect', 'disconnect', 'loadHistory', 'sendMessage']) {
      if (typeof api?.[m] !== 'function') fail(`нет метода ${m}()`);
    }
    if (failures) process.exit(1);
    await Promise.race([
      api.connect().then(
        () => console.log('  connect() прошёл (сиречь модуль вошёл без настроек — допустимо, если протокол это позволяет)'),
        (e) => console.log(`  connect() отклонился, как ожидалось: ${e.message}`),
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('connect() timeout 20s')), 20000)),
    ]);
  } catch (e) {
    fail(`create/connect бросил синхронно: ${e.message}`);
  }
  try {
    await Promise.race([
      api.disconnect().then(() => console.log('  disconnect() ok')),
      new Promise((_, rej) => setTimeout(() => rej(new Error('disconnect() timeout 5s')), 5000)),
    ]);
  } catch (e) {
    fail(`disconnect(): ${e.message}`);
  }
  clearTimeout(timeout);
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (failures) {
    console.error(`\nFAIL (${failures})`);
    process.exit(1);
  }
  console.log(`\nPASS: ${dirName}`);
})();

function fakeConfig(manifest) {
  const cfg = {};
  (manifest.fields || []).forEach((f) => {
    if (f.type === 'boolean') cfg[f.name] = false;
    else if (f.type === 'number') cfg[f.name] = Number(f.placeholder) || 1;
    else if (f.type === 'select') cfg[f.name] = f.options?.[0];
    else cfg[f.name] = f.placeholder || 'smoke-test-fake-value';
  });
  return cfg;
}
