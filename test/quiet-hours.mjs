// Unit tests for the quiet hours, when the heartbeat does not ask (src/quiet-hours.ts), and the setting's check.
// Usage: node test/quiet-hours.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-quiet-"));
const out = join(dir, "quiet.mjs");
await build({
  stdin: { contents: 'export * from "./src/quiet-hours.ts"; export { cleaned, fieldOf } from "./src/config.ts";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  logLevel: "error"
});
const { DEFAULT_QUIET_HOURS, parseQuietHours, quietHoursProblem, quietHoursOf, inQuietHours, quietHoursInWords, cleaned, fieldOf } = await import(
  pathToFileURL(join(process.cwd(), out)).href
);
rmSync(dir, { recursive: true, force: true });

const SH = "Asia/Shanghai";
const NY = "America/New_York";
// Shanghai has no daylight saving: UTC+8 all year.
const sh = (clock) => Date.parse(`2026-10-26T${clock}:00+08:00`);

let failed = 0;
function step(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

step("the setting is read as a range of minutes, off is none, other text is refused", () => {
  assert.equal(DEFAULT_QUIET_HOURS, "00:00-08:00");
  assert.deepEqual(parseQuietHours("00:00-08:00"), { start: 0, end: 480 });
  assert.deepEqual(parseQuietHours("23:30-7:00"), { start: 1410, end: 420 });
  assert.deepEqual(parseQuietHours("1-9"), { start: 60, end: 540 });
  assert.deepEqual(parseQuietHours("22:00 到 24:00"), { start: 1320, end: 1440 });
  assert.deepEqual(parseQuietHours("23:00–07:00"), { start: 1380, end: 420 });
  assert.equal(parseQuietHours("off"), null);
  assert.equal(parseQuietHours(" OFF "), null);
  for (const bad of ["", "8", "nightly", "24:00-08:00", "07:60-08:00", "08:00-08:00", "00:00-24:00", "25-3"]) {
    assert.ok("error" in (parseQuietHours(bad) ?? {}), bad);
  }
});

step("the settings page refuses what it cannot read and keeps what it can", () => {
  const field = fieldOf("QUIET_HOURS");
  assert.ok(field, "QUIET_HOURS is a setting");
  assert.deepEqual(cleaned(field, " 23:00-07:00 "), { value: "23:00-07:00" });
  assert.deepEqual(cleaned(field, "off"), { value: "off" });
  assert.deepEqual(cleaned(field, ""), { value: "" });
  assert.match(cleaned(field, "晚上").error, /00:00-08:00/);
  assert.match(cleaned(field, "08:00-08:00").error, /同一个时间/);
  assert.equal(quietHoursProblem("00:00-08:00"), null);
});

step("in effect: the default when empty or unreadable, none when off", () => {
  assert.deepEqual(quietHoursOf(undefined), { start: 0, end: 480 });
  assert.deepEqual(quietHoursOf("  "), { start: 0, end: 480 });
  assert.deepEqual(quietHoursOf("not a time"), { start: 0, end: 480 });
  assert.deepEqual(quietHoursOf("23:00-07:00"), { start: 1380, end: 420 });
  assert.equal(quietHoursOf("off"), null);
});

step("inside the hours on the time zone's clock; the start counts, the end does not", () => {
  const night = quietHoursOf("00:00-08:00");
  assert.equal(inQuietHours(night, sh("00:00"), SH), true);
  assert.equal(inQuietHours(night, sh("03:17"), SH), true);
  assert.equal(inQuietHours(night, sh("07:59"), SH), true);
  assert.equal(inQuietHours(night, sh("08:00"), SH), false);
  assert.equal(inQuietHours(night, sh("23:59"), SH), false);
  assert.equal(inQuietHours(night, sh("12:00"), SH), false);
  assert.equal(inQuietHours(null, sh("03:00"), SH), false, "off: never quiet");
});

step("hours that run past midnight", () => {
  const late = quietHoursOf("23:00-07:00");
  assert.equal(inQuietHours(late, sh("22:59"), SH), false);
  assert.equal(inQuietHours(late, sh("23:00"), SH), true);
  assert.equal(inQuietHours(late, sh("02:00"), SH), true);
  assert.equal(inQuietHours(late, sh("06:59"), SH), true);
  assert.equal(inQuietHours(late, sh("07:00"), SH), false);
  const toMidnight = quietHoursOf("22:00-24:00");
  assert.equal(inQuietHours(toMidnight, sh("23:59"), SH), true);
  assert.equal(inQuietHours(toMidnight, sh("00:00"), SH), false);
});

step("another time zone reads its own clock, through daylight saving", () => {
  const night = quietHoursOf("00:00-08:00");
  // 03:00 in Shanghai is 15:00 the day before in New York (EDT, UTC-4): quiet in one, not the other.
  assert.equal(inQuietHours(night, sh("03:00"), SH), true);
  assert.equal(inQuietHours(night, sh("03:00"), NY), false);
  // 2026-11-01 01:30 in New York happens twice (EDT, then EST); both are quiet.
  assert.equal(inQuietHours(night, Date.parse("2026-11-01T05:30:00Z"), NY), true);
  assert.equal(inQuietHours(night, Date.parse("2026-11-01T06:30:00Z"), NY), true);
  // 08:30 EST is 13:30 UTC after the change.
  assert.equal(inQuietHours(night, Date.parse("2026-11-01T13:30:00Z"), NY), false);
});

step("/status words", () => {
  assert.equal(quietHoursInWords(quietHoursOf("00:00-08:00")), "0:00 到 8:00");
  assert.equal(quietHoursInWords(quietHoursOf("23:30-07:00")), "23:30 到 7:00");
});

if (failed) process.exitCode = 1;
