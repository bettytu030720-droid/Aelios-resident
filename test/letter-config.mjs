// Settings validation for the independent letter trigger. Usage: node test/letter-config.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-letter-config-"));
const out = join(dir, "config.mjs");
await build({ entryPoints: ["src/config.ts"], bundle: true, platform: "node", format: "esm", outfile: out, external: ["ai", "zod"], logLevel: "error" });
const { fieldOf, cleaned, describe, withSaved } = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

const field = fieldOf("LETTER_TOKEN_THRESHOLD");
assert.ok(field);
for (const raw of ["abc", "Infinity", "1e309", "0", "-1", "8000", "7999", "9000.5", "9007199254740992"]) {
  assert.match(cleaned(field, raw).error, /大于 8000 的整数/, raw);
}
for (const raw of ["30000", "50000", "8001"]) assert.deepEqual(cleaned(field, ` ${raw} `), { value: raw });
assert.deepEqual(cleaned(field, ""), { value: "" }, "clear returns to the Worker value or default");
assert.equal(fieldOf("KEEP_RECENT_TOKENS"), undefined);
const env = { KEEP_RECENT_TOKENS: "10", LETTER_TOKEN_THRESHOLD: "50000" };
const saved = { KEEP_RECENT_TOKENS: "100000", LETTER_TOKEN_THRESHOLD: "30000" };
const fields = describe(env, saved);
assert.ok(!fields.some((item) => item.key === "KEEP_RECENT_TOKENS"));
assert.equal(fields.find((item) => item.key === "LETTER_TOKEN_THRESHOLD").value, "30000");
assert.equal(fields.find((item) => item.key === "LETTER_TOKEN_THRESHOLD").fromWorker, "50000");
assert.equal(withSaved(env, saved).LETTER_TOKEN_THRESHOLD, "30000");
console.log("PASS letter thresholds: validated, saved over Worker values, and no editable retention field");
