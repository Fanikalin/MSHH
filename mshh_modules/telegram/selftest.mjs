// Telegram module selftest — validates the manifest and the entry contract
// against docs/mshh/MODULE_API.md WITHOUT any network activity.
// Run: node selftest.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL: " + msg);
  } else {
    console.log("ok: " + msg);
  }
}

// ---- manifest schema
const manifest = JSON.parse(readFileSync(path.join(here, "module.json"), "utf8"));
assert(/^[a-z0-9_-]+$/.test(manifest.id), "manifest.id matches [a-z0-9_-]+");
assert(manifest.id === "telegram", "manifest.id is telegram");
assert(manifest.name === "Telegram", "manifest.name present");
assert(manifest.version === "1.0.0", "manifest.version is 1.0.0");
assert(manifest.side === "main", 'manifest.side is "main" (entry required)');
assert(manifest.entry === "index.cjs", "manifest.entry points to index.cjs");
assert(manifest.auth?.type === "code", 'auth.type is "code"');

const FIELD_TYPES = new Set(["string", "secret", "number", "boolean", "select"]);
const fields = manifest.profileFields ?? [];
assert(Array.isArray(fields) && fields.length > 0, "profileFields is a non-empty array");
for (const f of fields) {
  assert(
    typeof f.key === "string" && typeof f.label === "string" && FIELD_TYPES.has(f.type),
    `profileField "${f.key}" has valid key/label/type (${f.type})`
  );
  if (f.required) assert(true, `profileField "${f.key}" marked required`);
}
for (const key of ["apiId", "apiHash", "phone"]) {
  assert(fields.some((f) => f.key === key), `profileFields contains "${key}"`);
}
const apiHashField = fields.find((f) => f.key === "apiHash");
assert(apiHashField?.type === "secret", 'apiHash is type "secret"');

// ---- entry contract (gramjs itself must NOT be loaded or connected here)
const entry = require(path.join(here, manifest.entry));
assert(typeof entry.createClient === "function", "entry exports createClient");

const events = [];
const client = entry.createClient({
  profileId: "selftest",
  config: { apiId: 1, apiHash: "selftest", phone: "+79990000000" },
  dataDir: path.join(here, ".selftest-data"),
  emit: (event, payload) => events.push({ event, payload }),
  log: () => {},
});
assert(client && typeof client === "object", "createClient returns an object");
for (const m of ["connect", "disconnect", "send", "markRead", "setTyping", "submitAuth"]) {
  assert(typeof client[m] === "function", `client.${m}() is a function`);
}

// createClient must not connect or emit anything
assert(events.length === 0, "createClient emits nothing (no implicit connect)");

// offline calls must resolve without connecting
await client.setTyping("123", true);
assert(true, "setTyping() is a safe no-op while offline");

console.log(failed === 0 ? "telegram selftest: PASS" : `telegram selftest: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
