// Unit tests for roles (src/task-roles.ts): the three that come with it, saving, removing, and what a role's job
// and a wrong role say. node:sqlite stands in for the agent's. Usage: node test/task-roles.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-roles-"));
const out = join(dir, "task-roles.mjs");
await build({ entryPoints: ["src/task-roles.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const r = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

function sqlOn(db) {
  return (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    return /^\s*SELECT/i.test(strings[0]) ? statement.all(...values) : (statement.run(...values), []);
  };
}

await test("three roles come with it, put in once: removed ones do not come back", () => {
  const db = new DatabaseSync(":memory:");
  const roles = new r.RoleStore(sqlOn(db));
  assert.deepEqual(roles.list().map((role) => [role.name, role.model]), [["coder", ""], ["reviewer", ""], ["researcher", ""]]);
  assert.match(roles.get("coder").template, /绝不合并、不推默认分支、不部署/);
  assert.match(roles.get("reviewer").template, /必须改 \/ 建议改 \/ 小毛病/);
  assert.match(roles.get("researcher").template, /不确定/);
  roles.remove("researcher");
  assert.deepEqual(new r.RoleStore(sqlOn(db)).list().map((role) => role.name), ["coder", "reviewer"], "a restart leaves the list as they left it");
});

await test("saving: a new one goes last, a changed one keeps its place; names, templates and models are checked", () => {
  const roles = new r.RoleStore(sqlOn(new DatabaseSync(":memory:")));
  assert.deepEqual(roles.save({ name: " Tester ", template: " 只跑测试，写出哪些没过。 ", model: "anthropic/claude-haiku-5.5" }), { name: "tester", template: "只跑测试，写出哪些没过。", model: "anthropic/claude-haiku-5.5" });
  roles.save({ name: "coder", template: "改代码，开 PR。", model: "@cf/zai-org/glm-4.7-flash" });
  assert.deepEqual(roles.list().map((role) => [role.name, role.model]), [["coder", "@cf/zai-org/glm-4.7-flash"], ["reviewer", ""], ["researcher", ""], ["tester", "anthropic/claude-haiku-5.5"]]);
  assert.match(roles.save({ name: "代码", template: "x" }).error, /小写英文字母开头/);
  assert.match(roles.save({ name: "1st", template: "x" }).error, /小写英文字母开头/);
  assert.match(roles.save({ name: "ok", template: "  " }).error, /怎么干活/);
  assert.match(roles.save({ name: "ok", template: "长".repeat(1501) }).error, /最多 1500/);
  assert.match(roles.save({ name: "ok", template: "x", model: "two words" }).error, /一个 id/);
  for (let i = 0; i < 8; i += 1) assert.ok(!("error" in roles.save({ name: `r${i}`, template: "x" })));
  assert.match(roles.save({ name: "one-more", template: "x" }).error, /最多 12 个/);
  assert.ok(!("error" in roles.save({ name: "r0", template: "changed" })), "changing one is fine when full");
});

await test("a role's job is its template, then the resident's words; a wrong role names the ones there are", () => {
  assert.equal(r.withRole({ name: "reviewer", template: "只读审查。", model: "" }, "审 #41"), "只读审查。\n\n审 #41");
  const roles = [{ name: "coder" }, { name: "reviewer" }];
  assert.equal(r.unknownRole("tester", roles), "Not sent: there is no role tester. Their roles: coder, reviewer. Leave role out to write the whole job yourself.");
  assert.match(r.unknownRole("tester", []), /They have no roles\./);
});
