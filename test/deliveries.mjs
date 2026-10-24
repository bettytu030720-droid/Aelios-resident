import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-deliveries-"));
const out = join(dir, "deliveries.mjs");
await build({ entryPoints: ["src/deliveries.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { DeliveryStore } = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

const db = new DatabaseSync(":memory:");
const sql = (strings, ...values) => {
  const statement = db.prepare(strings.join("?"));
  return /^\s*SELECT/i.test(strings[0]) ? statement.all(...values) : (statement.run(...values), []);
};
const store = new DeliveryStore(sql);

store.add("checkin:one", "checkin", "hello", true, 1);
store.add("checkin:one", "checkin", "a replay must not replace the original", true, 2);
assert.deepEqual(store.get("checkin:one"), { key: "checkin:one", kind: "checkin", reply: "hello", telegramDone: false, memoryDone: false, progress: 0 });
store.progress("checkin:one", 1);
assert.equal(store.get("checkin:one").progress, 1);
store.telegramDone("checkin:one");
assert.equal(store.get("checkin:one").memoryDone, false);
assert.equal(store.pending().length, 1);
store.memoryDone("checkin:one");
assert.equal(store.get("checkin:one").telegramDone, true);
store.remove("checkin:one");
assert.equal(store.get("checkin:one"), null);

store.add("letter:one", "letter", "（交接信）letter", false, 3);
assert.deepEqual(store.pending(), [{ key: "letter:one", kind: "letter", reply: "（交接信）letter", telegramDone: true, memoryDone: true, progress: 0 }]);
store.remove("letter:one");
assert.equal(store.pending().length, 0);
console.log("PASS durable deliveries are idempotent and advance each destination independently");
