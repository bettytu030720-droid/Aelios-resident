// Host-only tests: no model credits, git pushes or network services.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspace, validateFiles, publishFiles, saveArtifacts, runTool, runHands, jobFromEvent, reportStopped } from '../public/hands.mjs';
const root = mkdtempSync(join(tmpdir(), 'resident-hands-test-'));
const workdir = join(root, 'work');
mkdirSync(workdir);
mkdirSync(join(workdir, 'out'));
writeFileSync(join(workdir, 'out/index.html'), '<h1>Hello</h1>');
writeFileSync(join(workdir, '.env'), 'secret');
writeFileSync(join(workdir, 'out/design-tokens.css'), ':root { --a: 1px; }');
symlinkSync(join(workdir, 'out/index.html'), join(workdir, 'alias.html'));
for (const files of [['../escape'], ['.env'], ['alias.html'], ['out'], ['/etc/passwd'], ['out/../out/index.html'], ['private/a']]) assert.throws(() => validateFiles(workdir, files));
assert.equal(validateFiles(workdir, ['out/index.html'])[0].relative, 'out/index.html');
assert.equal(validateFiles(workdir, ['out/design-tokens.css'])[0].relative, 'out/design-tokens.css');
console.log('PASS explicit file validation rejects traversal, dot files, directories and symlinks, and takes ordinary names like design-tokens.css');
const calls = [];
const exec = async (bin, args, options) => { calls.push({ bin, args, options }); return { stdout: '', stderr: '' }; };
await assert.rejects(prepareWorkspace({ repository: '--evil/repo', task: 't_one', workdir, exec }));
const cloned = await prepareWorkspace({ repository: 'owner/other', currentRepository: 'owner/current', task: 't_one', workdir, tempRoot: root, exec });
assert.ok(cloned.endsWith('/repo'));
assert.ok(calls.some((c) => c.bin === 'gh' && c.args[0] === 'repo' && c.args[2] === 'owner/other'));
assert.ok(calls.some((c) => c.args.join(' ') === 'switch -c resident/t_one'));
assert.ok(calls.some((c) => c.args.join(' ') === 'config user.name resident-hands'));
console.log('PASS workspace setup validates target, clones different repo and prepares identity/branch');
let rg;
assert.equal(await runTool('search_files', { filenames: true, pattern: 'index', path: '.' }, { workdir, exec: async (bin, args) => { rg = { bin, args }; return { stdout: 'a.txt\nout/index.html\n' }; } }), 'out/index.html');
assert.equal(rg.bin, 'rg');
assert.equal(rg.args[0], '--files');
await runTool('search_files', { pattern: '$(bad)' }, { workdir, exec: async (bin, args) => { assert.ok(args.includes('$(bad)')); return { stdout: 'one' }; } });
console.log('PASS search uses rg argument arrays and filters filename mode');
{
  // A machine without ripgrep (GitHub's runners): grep and find, leaving out .git and node_modules.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const tried = [];
  const noRg = async (bin, args, options) => {
    tried.push(bin);
    if (bin === 'rg') throw Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' });
    return run(bin, args, { encoding: 'utf8', ...options });
  };
  const where = join(root, 'search');
  for (const dir of ['src', 'node_modules/x', '.git']) mkdirSync(join(where, dir), { recursive: true });
  writeFileSync(join(where, 'src/a.ts'), 'const one = 1;\nwebThreads(one);\n' + 'x'.repeat(900) + ' webThreads(two)\n');
  writeFileSync(join(where, 'node_modules/x/b.ts'), 'webThreads(lib);\n');
  writeFileSync(join(where, '.git/c'), 'webThreads(git);\n');
  const hits = await runTool('search_files', { pattern: 'webThreads\\(' }, { workdir: where, exec: noRg });
  assert.deepEqual(tried, ['rg', 'grep']);
  const lines = hits.split('\n');
  assert.equal(lines.length, 2, hits);
  assert.match(lines[0], /src\/a\.ts:2:webThreads\(one\);$/);
  assert.ok(lines[1].endsWith(' […]') && lines[1].length < 600, 'a long line is cut');
  assert.equal(await runTool('search_files', { pattern: 'nowhere' }, { workdir: where, exec: noRg }), 'No matches');
  assert.deepEqual((await runTool('search_files', { filenames: true, pattern: '.ts' }, { workdir: where, exec: noRg })).split('\n').map((line) => line.slice(where.length)), ['/src/a.ts']);
  // A pattern the search cannot read: what it said comes back to the model instead of a bare failure.
  assert.match(await runTool('search_files', { pattern: 'webThreads(' }, { workdir: where, exec: noRg }), /^Search failed: .*(parenth|\(|unmatched|Unmatched)/i);
}
console.log('PASS without ripgrep, search falls back to grep and find; a bad pattern says why');
const runUrl = 'https://github.com/owner/repo/actions/runs/123';
const artifacts = saveArtifacts({ files: ['out/index.html'], workdir, task: 't_artifact', outputDir: join(root, 'artifacts'), runUrl, retentionDays: 30 });
assert.equal(readFileSync(join(root, 'artifacts/t_artifact/out/index.html'), 'utf8'), '<h1>Hello</h1>');
assert.deepEqual(artifacts.links, [runUrl]);
assert.match(artifacts.note, /30 天/);
assert.throws(() => saveArtifacts({ files: ['out/index.html'], workdir, task: 't_bad', outputDir: join(workdir, 'artifacts') }));
console.log('PASS private artifact copy preserves paths outside workspace and includes retention/access note');
const pagesCalls = [];
const pagesExec = async (bin, args, options) => {
  pagesCalls.push({ bin, args, options });
  if (args[0] === 'api' && args[1].endsWith('/pages')) return { stdout: JSON.stringify({ build_type: 'legacy', source: { branch: 'gh-pages', path: '/' }, html_url: 'https://owner.github.io/works/' }) };
  if (args[0] === 'api') return { stdout: '[[]]' };
  return { stdout: '' };
};
await assert.rejects(publishFiles({ files: ['out/index.html'], workdir, task: 't_page', exec: pagesExec }), /disabled/);
await assert.rejects(publishFiles({ files: ['out/index.html'], workdir, task: 't_page', publishRepo: 'owner/works', exec: pagesExec }), /PAT/);
const published = await publishFiles({ files: ['out/index.html'], workdir, task: 't_page', publishRepo: 'owner/works', publishToken: 'test-pat', tempRoot: root, exec: pagesExec });
assert.equal(published.status, 'submitted');
assert.match(published.note, /pending/);
assert.deepEqual(published.links, ['https://owner.github.io/works/tasks/t_page/out/index.html']);
assert.ok(pagesCalls.some((c) => c.args.join(' ') === 'push origin HEAD:refs/heads/gh-pages'));
assert.ok(!pagesCalls.some((c) => c.args.includes('--force')));
await assert.rejects(publishFiles({ files: ['out/index.html'], workdir, task: 't_race', publishRepo: 'owner/works', publishToken: 'test-pat', tempRoot: root, exec: async (bin, args, opts) => { if (args[0] === 'push') throw new Error('non-fast-forward'); return pagesExec(bin, args, opts); } }), /non-fast-forward/);
await assert.rejects(publishFiles({ files: ['out/index.html'], workdir, task: 't_wrong', publishRepo: 'owner/works', publishToken: 'test-pat', tempRoot: root, exec: async () => ({ stdout: JSON.stringify({ build_type: 'workflow', source: { branch: 'gh-pages', path: '/' } }) }) }), /legacy/);
console.log('PASS Pages is opt-in, validates legacy source, uses actual html_url and fails concurrent pushes');
const realFetch = globalThis.fetch;
const jobText = 'task: t_demo\ncode: sensitive-code\ntitle: Make a page\nmodel: selected/model\n\nCreate a page';
let reports = [];
try {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('/tasks/')) { reports.push(body); return new Response('{}'); }
    assert.equal(body.model, 'selected/model');
    assert.ok(!JSON.stringify(body).includes('sensitive-code'));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Ready' } }] }));
  };
  const base = { residentUrl: 'https://resident.example', modelBaseUrl: 'https://model.example/v1', modelApiKey: 'test-key', model: 'fallback/model', jobText, workdir, modelRetryMs: 1 };
  assert.equal((await runHands(base)).status, 'done');
  const missing = await runHands({ ...base, model: '', jobText: jobText.replace('model: selected/model\n', '') });
  assert.equal(missing.status, 'failed');
  assert.match(missing.summary, /MODEL_NAME 要一起给/);
  let modelCalls = 0;
  globalThis.fetch = async (url, init) => { if (String(url).includes('/tasks/')) { reports.push(JSON.parse(init.body)); return new Response('{}'); } modelCalls++; throw new Error('do not leak test-key'); };
  const offline = await runHands(base);
  assert.deepEqual([offline.status, offline.summary, modelCalls], ['failed', '模型连接失败或超时（重试过一次）', 2], 'a call that cannot connect is tried once more');
  assert.ok(!JSON.stringify(reports).includes('test-key'));
  modelCalls = 0;
  globalThis.fetch = async (url) => String(url).includes('/tasks/') ? new Response('{}') : (modelCalls++, new Response('raw secret test-key', { status: 401 }));
  assert.equal((await runHands(base)).summary, '模型调用失败（HTTP 401）');
  assert.equal(modelCalls, 1, 'a refusal (4xx) is not tried again');
  // A server error (a 502 from a model call that timed out) is tried once more, and the second answer counts.
  modelCalls = 0;
  globalThis.fetch = async (url) => String(url).includes('/tasks/') ? new Response('{}')
    : ++modelCalls === 1 ? Response.json({ error: { message: 'the model call failed: timeout' } }, { status: 502 })
    : new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Ready' } }] }));
  const retried = [];
  assert.equal((await runHands({ ...base, log: (line) => retried.push(line) })).status, 'done');
  assert.equal(modelCalls, 2);
  assert.ok(retried.includes('模型调用失败（HTTP 502），过一会儿再试一次'), JSON.stringify(retried));
  // A step the model took too long over, twice: the resident's words reach the result.
  modelCalls = 0;
  globalThis.fetch = async (url) => String(url).includes('/tasks/') ? new Response('{}') : (modelCalls++, Response.json({ error: { message: 'the model did not answer within 5 minutes' } }, { status: 504 }));
  assert.equal((await runHands(base)).summary, '模型调用失败（HTTP 504，重试过一次）：the model did not answer within 5 minutes');
  assert.equal(modelCalls, 2);
  globalThis.fetch = async (url) => String(url).includes('/tasks/') ? new Response('{}', { status: 403 }) : new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Ready' } }] }));
  await assert.rejects(runHands(base), /report could not be delivered/);
  globalThis.fetch = async (url) => { assert.ok(String(url).includes('/tasks/')); return new Response('{}'); };
  assert.equal((await runHands({ residentUrl: base.residentUrl, jobText: 'task: t_test\ncode: test-code\ntitle: 接通测试\n\nThis is a test from the resident\'s settings page' })).status, 'done');
  console.log('PASS selected model wins, no implicit model, network/HTTP failures are safe and a timeout or 5xx is tried once more, rejected reports fail and connectivity test needs no model');

  // With no model endpoint of its own, the model is called through the resident with the task's code, and on
  // Actions the GitHub token comes from the resident too: it goes to gh and git, and never into a report.
  const seen = [];
  const savedGh = process.env.GH_TOKEN;
  const savedGithub = process.env.GITHUB_TOKEN;
  globalThis.fetch = async (url, init) => {
    const where = String(url);
    seen.push({ where, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (where.endsWith('/tasks/t_demo/hands')) return Response.json({ github_token: 'ghp_from_resident' });
    if (where.endsWith('/tasks/t_demo/model/chat/completions')) return Response.json({ choices: [{ message: { role: 'assistant', content: 'Ready, used ghp_from_resident' } }] });
    if (where.includes('/tasks/')) return new Response('{}');
    throw new Error(`unexpected ${where}`);
  };
  try {
    const through = await runHands({ residentUrl: 'https://resident.example/', jobText: jobText.replace('model: selected/model\n', ''), workdir, askToken: true });
    assert.equal(through.status, 'done');
    const model = seen.find((call) => call.where.endsWith('/chat/completions'));
    assert.equal(model.where, 'https://resident.example/tasks/t_demo/model/chat/completions');
    assert.equal(model.headers.authorization, 'Bearer sensitive-code');
    assert.equal(model.body.model, 'resident', 'the resident picks the model');
    assert.ok(!model.body.tools.some((item) => item.function.name === 'publish_files'), 'no public pages without a repository for them');
    assert.ok(!model.body.messages[0].content.includes('publish_files'));
    assert.equal(seen[0].where, 'https://resident.example/tasks/t_demo/hands');
    assert.equal(seen[0].headers['x-task-code'], 'sensitive-code');
    assert.equal(process.env.GH_TOKEN, 'ghp_from_resident');
    assert.equal(process.env.GITHUB_TOKEN, 'ghp_from_resident');
    const result = seen.find((call) => call.where.endsWith('/result'));
    assert.ok(!JSON.stringify(result.body).includes('ghp_from_resident'), 'the token is redacted from the report');
    // A resident that gives no token: the run fails with that said, and reports it.
    globalThis.fetch = async (url) => String(url).endsWith('/hands') ? Response.json({ error: 'no GitHub token is set' }, { status: 409 }) : (seen.push({ where: String(url) }), new Response('{}'));
    const refused = await runHands({ residentUrl: 'https://resident.example', jobText, workdir, askToken: true });
    assert.equal(refused.status, 'failed');
    assert.match(refused.summary, /住户没给 GitHub token（HTTP 409）：no GitHub token is set/);
    // GitHub's "Re-run" of a task that has its result: said in the log, nothing reported, no "stopped" report after.
    const rerun = [];
    const said = [];
    const rerunMark = join(root, 'rerun-reported');
    globalThis.fetch = async (url) => String(url).endsWith('/hands') ? Response.json({ error: 'this task is finished', finished: true }, { status: 409 }) : (rerun.push(String(url)), new Response('{}'));
    const again = await runHands({ residentUrl: 'https://resident.example', jobText, workdir, askToken: true, reportedFile: rerunMark, log: (line) => said.push(line) });
    assert.deepEqual([again.status, again.finished], ['failed', true]);
    assert.match(again.summary, /已经有结果了.*「重新运行」跑的还是这一单.*让它新派一单/);
    assert.equal(said.at(-1), again.summary);
    assert.deepEqual(rerun, [], 'the card keeps its result');
    assert.ok(existsSync(rerunMark), 'and the last step does not report it stopped');

    // A failure says why, on the card and in the run log: the resident's own error for the model, and the command
    // that failed with what it printed, secrets taken out.
    const lines = [];
    globalThis.fetch = async (url) => {
      const where = String(url);
      if (where.endsWith('/hands')) return Response.json({ github_token: 'ghp_from_resident' });
      if (where.endsWith('/chat/completions')) return Response.json({ error: { message: 'the model call failed: 5007 no such model' } }, { status: 502 });
      return new Response('{}');
    };
    const modelDown = await runHands({ residentUrl: 'https://resident.example', jobText: jobText.replace('model: selected/model\n', ''), workdir, askToken: true, log: (line) => lines.push(line), modelRetryMs: 1 });
    assert.equal(modelDown.summary, '模型调用失败（HTTP 502，重试过一次）：the model call failed: 5007 no such model');
    assert.ok(lines.includes('向住户借 GitHub token'), JSON.stringify(lines));
    assert.ok(lines.at(-1).startsWith('没做完：模型调用失败'), JSON.stringify(lines));
    const cloneFails = async (bin, args) => {
      if (args[1] === 'clone') throw new Error('Command failed: gh repo clone owner/secret-repo\nGraphQL: Could not resolve to a Repository with the name \'owner/secret-repo\'. (repository)\ntoken ghp_from_resident\n');
      return { stdout: '' };
    };
    const noClone = await runHands({ residentUrl: 'https://resident.example', jobText: jobText.replace('title: Make a page', 'title: Make a page\nrepository: owner/secret-repo'), workdir, askToken: true, prepare: true, exec: cloneFails, log: (line) => lines.push(line) });
    assert.equal(noClone.status, 'failed');
    assert.match(noClone.summary, /^后台执行失败：Command failed: gh repo clone owner\/secret-repo\nGraphQL: Could not resolve/);
    assert.ok(!noClone.summary.includes('ghp_from_resident') && noClone.summary.includes('[redacted]'));
    assert.ok(lines.includes('准备工作区：owner/secret-repo'));
  } finally {
    if (savedGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedGh;
    if (savedGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = savedGithub;
  }
  console.log('PASS through the resident: the model with the task code, the GitHub token for gh and git, redacted from reports');

  // On Actions the job comes from the event file; a run that reported leaves a mark, and only one that did not is
  // reported as stopped by the workflow's last step.
  const event = join(root, 'event.json');
  writeFileSync(event, JSON.stringify({ inputs: { job: jobText } }));
  assert.equal(jobFromEvent(event), jobText);
  assert.equal(jobFromEvent(join(root, 'missing.json')), '');
  const marker = join(root, 'reported');
  globalThis.fetch = async (url, init) => String(url).includes('/tasks/') ? (reports.push({ url: String(url), body: JSON.parse(init.body) }), new Response('{}')) : new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Ready' } }] }));
  await runHands({ ...base, reportedFile: marker });
  assert.ok(existsSync(marker));
  reports = [];
  assert.equal(await reportStopped({ residentUrl: base.residentUrl, jobText, reportedFile: marker }), false);
  assert.equal(reports.length, 0);
  assert.equal(await reportStopped({ residentUrl: base.residentUrl, jobText, reportedFile: join(root, 'not-reported'), runUrl }), true);
  assert.equal(reports.length, 1);
  assert.match(reports[0].url, /\/tasks\/t_demo\/result$/);
  assert.equal(reports[0].body.status, 'failed');
  assert.deepEqual(reports[0].body.links, [runUrl]);
  console.log('PASS the job comes from the event file, and a stopped run is reported once, only when it had not reported');
} finally { globalThis.fetch = realFetch; }
// Temp test evidence is intentionally retained for inspection; no filesystem deletion is needed.
