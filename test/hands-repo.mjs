// Unit tests for the hands on GitHub Actions: setting up the private repository (src/hands-repo.ts) against a
// fake GitHub, starting a run, and the OpenAI-format model calls through the resident (src/openai-chat.ts).
// Usage: node test/hands-repo.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-hands-repo-"));
await build({ entryPoints: ["src/hands-repo.ts", "src/openai-chat.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, logLevel: "error" });
const h = await import(pathToFileURL(join(process.cwd(), dir, "hands-repo.js")).href);
const o = await import(pathToFileURL(join(process.cwd(), dir, "openai-chat.js")).href);
rmSync(dir, { recursive: true, force: true });

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error.stack}`);
    process.exitCode = 1;
  }
}

const realFetch = globalThis.fetch;
const decode = (value) => Buffer.from(value, "base64").toString("utf8");

/** A small GitHub: one user, their repositories and files. `scopes` decides what the token may do. */
function fakeGitHub({ login = "octo", repos = {}, scopes = ["repo", "workflow"], token = "ghp_good" } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(String(url));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: pathname + search, body, headers: init.headers });
    if (init.headers?.authorization !== `Bearer ${token}`) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (method === "GET" && pathname === "/user") return Response.json({ login });
    const repo = pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (method === "GET" && repo) {
      const found = repos[`${repo[1]}/${repo[2]}`];
      return found ? Response.json({ private: found.private, default_branch: found.branch ?? "main", html_url: `https://github.com/${repo[1]}/${repo[2]}` }) : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (method === "POST" && pathname === "/user/repos") {
      if (!scopes.includes("repo")) return Response.json({ message: "Resource not accessible" }, { status: 403 });
      repos[`${login}/${body.name}`] = { private: body.private, files: {} };
      return Response.json({ private: body.private, default_branch: "main", html_url: `https://github.com/${login}/${body.name}` }, { status: 201 });
    }
    const file = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (file) {
      const found = repos[`${file[1]}/${file[2]}`];
      if (!found) return Response.json({ message: "Not Found" }, { status: 404 });
      found.files ??= {};
      const kept = found.files[file[3]];
      if (method === "GET") return kept ? Response.json({ sha: kept.sha, content: Buffer.from(kept.text).toString("base64").replace(/(.{60})/g, "$1\n") }) : Response.json({ message: "Not Found" }, { status: 404 });
      if (!scopes.includes("workflow")) return Response.json({ message: "refusing to allow a Personal Access Token to create or update workflow without `workflow` scope" }, { status: 404 });
      if (kept && body.sha !== kept.sha) return Response.json({ message: "sha mismatch" }, { status: 409 });
      found.files[file[3]] = { text: decode(body.content), sha: `sha${calls.length}` };
      return Response.json({}, { status: kept ? 200 : 201 });
    }
    const dispatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/);
    if (method === "POST" && dispatch) {
      const found = repos[`${dispatch[1]}/${dispatch[2]}`];
      if (!found?.files?.[`.github/workflows/${dispatch[3]}`]) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({ workflow_run_id: 9, html_url: `https://github.com/${dispatch[1]}/${dispatch[2]}/actions/runs/9` });
    }
    return Response.json({ message: `unexpected ${method} ${pathname}` }, { status: 500 });
  };
  return { calls, repos };
}

try {
  await test("a new token: the private repository is made with the workflow in it, and a second setup writes nothing", async () => {
    const github = fakeGitHub();
    const repo = await h.setUpHands("ghp_good");
    assert.deepEqual(repo, { owner: "octo", repo: "resident-hands", branch: "main", url: "https://github.com/octo/resident-hands" });
    const made = github.calls.find((call) => call.method === "POST" && call.path === "/user/repos");
    assert.equal(made.body.private, true, "the repository is private");
    assert.equal(made.body.auto_init, true, "it starts with a commit, so the workflow can go on a branch");
    assert.equal(github.repos["octo/resident-hands"].files[".github/workflows/resident-hands.yml"].text, h.WORKFLOW);
    assert.equal(github.calls[0].headers["user-agent"], "aelios-resident");
    const before = github.calls.length;
    assert.deepEqual(await h.setUpHands("ghp_good"), repo);
    assert.equal(github.calls.slice(before).filter((call) => call.method !== "GET").length, 0, "the same workflow is not written again");
  });

  await test("an old workflow is replaced in place, on the repository's own branch", async () => {
    const github = fakeGitHub({ repos: { "octo/resident-hands": { private: true, branch: "trunk", files: { ".github/workflows/resident-hands.yml": { text: "old", sha: "s1" } } } } });
    const repo = await h.setUpHands("ghp_good");
    assert.equal(repo.branch, "trunk");
    const put = github.calls.find((call) => call.method === "PUT");
    assert.equal(put.body.sha, "s1");
    assert.equal(put.body.branch, "trunk");
    assert.equal(github.repos["octo/resident-hands"].files[".github/workflows/resident-hands.yml"].text, h.WORKFLOW);
  });

  await test("what can go wrong is said plainly: a bad token, a public repository, missing scopes, no connection", async () => {
    fakeGitHub();
    assert.match((await h.setUpHands("ghp_bad")).error, /不认这个 token/);
    fakeGitHub({ repos: { "octo/resident-hands": { private: false } } });
    assert.match((await h.setUpHands("ghp_good")).error, /是公开的/);
    fakeGitHub({ scopes: ["workflow"] });
    assert.match((await h.setUpHands("ghp_good")).error, /建不了仓库.*repo 和 workflow/);
    fakeGitHub({ scopes: ["repo"] });
    assert.match((await h.setUpHands("ghp_good")).error, /写不了工作流文件.*workflow/);
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    assert.match((await h.setUpHands("ghp_good")).error, /连不上 GitHub/);
  });

  await test("a run starts on the repository's branch with the job and the resident's address, and links to that run", async () => {
    const github = fakeGitHub();
    const repo = await h.setUpHands("ghp_good");
    const fired = await h.dispatchHands(repo, "ghp_good", "task: t_1\ncode: c\ntitle: x\n\njob", "https://resident.example");
    assert.deepEqual(fired, { sessionId: "9", sessionUrl: "https://github.com/octo/resident-hands/actions/runs/9" });
    const sent = github.calls.at(-1);
    assert.equal(sent.path, "/repos/octo/resident-hands/actions/workflows/resident-hands.yml/dispatches");
    assert.deepEqual(sent.body, { ref: "main", inputs: { job: "task: t_1\ncode: c\ntitle: x\n\njob", resident: "https://resident.example" }, return_run_details: true });
    // A repository GitHub does not know (deleted since): worth setting up again.
    delete github.repos["octo/resident-hands"];
    const missing = await h.dispatchHands(repo, "ghp_good", "x", "https://resident.example");
    assert.equal(missing.missing, true);
    // An older GitHub that answers 204 without the run: the card links to the workflow's runs.
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal((await h.dispatchHands(repo, "ghp_good", "x", "https://r.example")).sessionUrl, "https://github.com/octo/resident-hands/actions/workflows/resident-hands.yml");
    globalThis.fetch = async () => Response.json({ workflow_run_id: 3, html_url: "https://evil.example/run" });
    assert.equal((await h.dispatchHands(repo, "ghp_good", "x", "https://r.example")).sessionUrl, "https://github.com/octo/resident-hands/actions/workflows/resident-hands.yml", "a run link that is not GitHub's is not shown");
    // The local tests point it elsewhere; only the origin changes.
    const local = fakeGitHub();
    await h.setUpHands("ghp_good", "http://127.0.0.1:9999/");
    assert.ok(local.calls.length > 0);
  });

  await test("the workflow takes its inputs through env, fetches the hands from the resident, and keeps no key", () => {
    const workflow = h.WORKFLOW;
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /RESIDENT_URL: \$\{\{ inputs\.resident \}\}/);
    assert.match(workflow, /curl -fsSL --retry 3 "\$RESIDENT_URL\/hands\.mjs"/);
    assert.ok(!/run:.*\$\{\{/.test(workflow), "no expression is pasted into a script");
    assert.ok(!/secrets\./.test(workflow), "nothing has to be stored in the repository");
    assert.ok(!/inputs\.job/.test(workflow), "the job is read from the event file, never printed through env");
    assert.match(workflow, /if: failure\(\) \|\| cancelled\(\)/);
    // runner.temp is not available in a job's env, only in a step's.
    const jobEnv = workflow.split("steps:")[0];
    assert.ok(!jobEnv.includes("runner."), "the job's env uses only contexts it may");
    assert.match(h.TOKEN_PAGE, /^https:\/\/github\.com\/settings\/tokens\/new\?scopes=repo,workflow/);
  });
} finally {
  globalThis.fetch = realFetch;
}

await test("an OpenAI request becomes AI SDK messages: tool calls carry their names into the results", () => {
  const request = o.fromOpenAI({
    model: "resident",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "fix it" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }, { id: "c2", type: "function", function: { name: "read_file", arguments: "not json" } }] },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
      { role: "tool", tool_call_id: "c2", content: [{ type: "text", text: "1: hi" }] },
      { role: "assistant", content: "done" }
    ],
    tools: [{ type: "function", function: { name: "bash", description: "Run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }]
  });
  assert.equal(request.instructions, "be brief", "system messages become the instructions");
  assert.equal(request.messages.length, 4, "both results go in one tool message");
  assert.deepEqual(request.messages[0], { role: "user", content: "fix it" });
  assert.deepEqual(request.messages[1].content[0], { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } });
  assert.deepEqual(request.messages[1].content[1].input, {}, "arguments that are not JSON become no input");
  assert.equal(request.messages[2].role, "tool");
  assert.deepEqual(request.messages[2].content.map((part) => [part.toolName, part.output.value]), [["bash", "a.txt"], ["read_file", "1: hi"]]);
  assert.deepEqual(Object.keys(request.tools), ["bash"]);
  assert.equal(request.tools.bash.execute, undefined, "a call goes back to the hands, not run here");
  for (const bad of [{}, { messages: [] }, { messages: [{ role: "system", content: "only this" }] }, { messages: [{ role: "tool", tool_call_id: "x", content: "?" }] }, { messages: [{ role: "robot", content: "?" }] }, { messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "bad name" } }] }]) {
    assert.ok("error" in o.fromOpenAI(bad), JSON.stringify(bad));
  }
});

await test("an answer goes back as a chat completion: text, or tool calls with JSON arguments", () => {
  const text = o.toOpenAI({ text: "好了", toolCalls: [], finishReason: "stop", usage: { inputTokens: 10, outputTokens: 2 } }, "@cf/zai-org/glm-4.7-flash");
  assert.equal(text.object, "chat.completion");
  assert.equal(text.model, "@cf/zai-org/glm-4.7-flash");
  assert.deepEqual(text.choices[0].message, { role: "assistant", content: "好了" });
  assert.equal(text.choices[0].finish_reason, "stop");
  assert.deepEqual(text.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  const calls = o.toOpenAI({ text: "", toolCalls: [{ toolCallId: "c9", toolName: "bash", input: { command: "ls" } }], finishReason: "tool-calls" }, "m");
  assert.equal(calls.choices[0].message.content, null);
  assert.deepEqual(calls.choices[0].message.tool_calls, [{ id: "c9", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }]);
  assert.equal(calls.choices[0].finish_reason, "tool_calls");
});
