// WhatsApp module selftest — validates the manifest and the entry contract
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
assert(manifest.id === "whatsapp", "manifest.id is whatsapp");
assert(manifest.name === "WhatsApp", "manifest.name present");
assert(manifest.version === "1.0.0", "manifest.version is 1.0.0");
assert(manifest.side === "main", 'manifest.side is "main" (entry required)');
assert(manifest.entry === "index.cjs", "manifest.entry points to index.cjs");
assert(manifest.auth?.type === "qr", 'auth.type is "qr"');

const FIELD_TYPES = new Set(["string", "secret", "number", "boolean", "select"]);
const fields = manifest.profileFields ?? [];
for (const f of fields) {
  assert(
    typeof f.key === "string" && typeof f.label === "string" && FIELD_TYPES.has(f.type),
    `profileField "${f.key}" has valid key/label/type (${f.type})`
  );
}
assert(fields.some((f) => f.key === "name"), 'profileFields contains optional "name"');

// ---- entry contract (baileys/qrcode must NOT be loaded or connected here)
const entry = require(path.join(here, manifest.entry));
assert(typeof entry.createClient === "function", "entry exports createClient");

const events = [];
const client = entry.createClient({
  profileId: "selftest",
  config: { name: "selftest" },
  dataDir: path.join(here, ".selftest-data"),
  emit: (event, payload) => events.push({ event, payload }),
  log: () => {},
});
assert(client && typeof client === "object", "createClient returns an object");
for (const m of ["connect", "disconnect", "send", "markRead", "setTyping"]) {
  assert(typeof client[m] === "function", `client.${m}() is a function`);
}

// createClient must not connect or emit anything
assert(events.length === 0, "createClient emits nothing (no implicit connect)");

// offline calls must reject cleanly (not crash) without connecting
let rejected = false;
try {
  await client.send("123@c.us", "test");
} catch {
  rejected = true;
}
assert(rejected, "send() rejects with a clear error while offline");

console.log(failed === 0 ? "whatsapp selftest: PASS" : `whatsapp selftest: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
