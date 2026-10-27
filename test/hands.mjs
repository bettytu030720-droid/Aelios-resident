// Host-only tests: no model credits, git pushes or network services.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspace, validateFiles, publishFiles, saveArtifacts, runTool, runHands, jobFromEvent, reportStopped } from '../scripts/hands.mjs';
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
  const base = { residentUrl: 'https://resident.example', modelBaseUrl: 'https://model.example/v1', modelApiKey: 'test-key', model: 'fallback/model', jobText, workdir };
  assert.equal((await runHands(base)).status, 'done');
  const missing = await runHands({ ...base, model: '', jobText: jobText.replace('model: selected/model\n', '') });
  assert.equal(missing.status, 'failed');
  assert.match(missing.summary, /没有默认模型/);
  globalThis.fetch = async (url, init) => { if (String(url).includes('/tasks/')) { reports.push(JSON.parse(init.body)); return new Response('{}'); } throw new Error('do not leak test-key'); };
  assert.equal((await runHands(base)).status, 'failed');
  assert.ok(!JSON.stringify(reports).includes('test-key'));
  globalThis.fetch = async (url) => String(url).includes('/tasks/') ? new Response('{}') : new Response('raw secret test-key', { status: 401 });
  assert.equal((await runHands(base)).summary, '模型调用失败（HTTP 401）');
  globalThis.fetch = async (url) => String(url).includes('/tasks/') ? new Response('{}', { status: 403 }) : new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Ready' } }] }));
  await assert.rejects(runHands(base), /report could not be delivered/);
  globalThis.fetch = async (url) => { assert.ok(String(url).includes('/tasks/')); return new Response('{}'); };
  assert.equal((await runHands({ residentUrl: base.residentUrl, jobText: 'task: t_test\ncode: test-code\ntitle: 接通测试\n\nThis is a test from the resident\'s settings page' })).status, 'done');
  console.log('PASS selected model wins, no implicit model, network/HTTP failures are safe, rejected reports fail and connectivity test needs no model');

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
