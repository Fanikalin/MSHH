// Matrix module selftest — manifest-only validation against
// docs/mshh/MODULE_API.md (renderer-side modules have NO entry script).
// Run: node selftest.mjs
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL: " + msg);
  } else {
    console.log("ok: " + msg);
  }
}

const manifest = JSON.parse(readFileSync(path.join(here, "module.json"), "utf8"));

assert(/^[a-z0-9_-]+$/.test(manifest.id), "manifest.id matches [a-z0-9_-]+");
assert(manifest.id === "matrix", "manifest.id is matrix");
assert(manifest.name === "Matrix", "manifest.name present");
assert(manifest.version === "1.0.0", "manifest.version is 1.0.0");
assert(manifest.side === "renderer", 'manifest.side is "renderer"');
assert(manifest.auth?.type === "builtin-login", 'auth.type is "builtin-login"');
assert(manifest.entry === undefined, "renderer module has no entry script");

const FIELD_TYPES = new Set(["string", "secret", "number", "boolean", "select"]);
const fields = manifest.profileFields ?? [];
assert(Array.isArray(fields) && fields.length > 0, "profileFields is a non-empty array");
for (const f of fields) {
  assert(
    typeof f.key === "string" && typeof f.label === "string" && FIELD_TYPES.has(f.type),
    `profileField "${f.key}" has valid key/label/type (${f.type})`
  );
}
const keys = fields.map((f) => f.key);
assert(keys.includes("homeserver"), "profileFields contains homeserver (display)");
assert(keys.includes("userId"), "profileFields contains userId (display)");
assert(!fields.some((f) => f.required), "no profileField is required (derived from Cinny sessions)");

// no entry script in the folder
const files = readdirSync(here);
assert(
  !["index.cjs", "index.mjs", "index.js"].some((f) => existsSync(path.join(here, f))),
  "folder contains no entry script (as expected for side:renderer)"
);

console.log(failed === 0 ? "matrix selftest: PASS" : `matrix selftest: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
