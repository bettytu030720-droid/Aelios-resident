// Real local Worker/Think facets, fake model only. Start mock-server and a fresh wrangler.test worker.
// Run `node test/native-tasks.mjs first`, restart the Worker with the same state, then run `... restart`.
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:8787';
const mock = 'http://127.0.0.1:9999';
const headers = { 'x-web-key': 'test-web-key', 'content-type': 'application/json' };
async function api(path, body) {
  const response = await fetch(base + path, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
async function set(values) { for (const [key, text] of Object.entries(values)) await api('/web/config', { key, text }); }
async function waitTask(id) {
  const until = Date.now() + 40000;
  while (Date.now() < until) {
    const task = (await api('/web/tasks')).tasks.find(t => t.id === id);
    if (task && ['done', 'failed', 'needs_you'].includes(task.status)) {
      assert.equal(task.status, 'done', JSON.stringify(task));
      return task;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Task ${id} did not finish`);
}
async function say(text) {
  const before = new Set((await api('/web/tasks')).tasks.map(t => t.id));
  await api('/web/say', { text });
  const task = (await api('/web/tasks')).tasks.find(t => !before.has(t.id));
  assert.ok(task, 'message created a task');
  return task;
}
const github = 'https://api.github.com/repos/example/executor/actions/workflows/resident-hands.yml/dispatches';
if (process.argv[2] !== 'restart') {
  await set({ CLOUD_TASKS: 'on', CLOUD_TASK_URL: github, CLOUD_TASK_TOKEN: 'good-token' });
  const state = await api('/web/tasks');
  assert.equal(state.mode, 'linux');
  const before = (await (await fetch(mock + '/__log')).json()).filter(e => e.kind === 'github.dispatch').length;
  const task = await say('后台写文件');
  await waitTask(task.id);
  const after = (await (await fetch(mock + '/__log')).json()).filter(e => e.kind === 'github.dispatch').length;
  assert.equal(after, before, 'local job stays local despite a configured Actions executor');
  const messages = (await api('/web/messages')).data;
  assert.ok(!JSON.stringify(messages).includes('native-workspace-persisted'), 'workspace tool content stays out of main chat');
  const thread = await api(`/web/thread?id=${task.id}`);
  assert.deepEqual(thread.files.map(f => f.path), ['/draft.txt']);
  const file = await fetch(`${base}/web/thread/file?id=${task.id}&path=${encodeURIComponent('/draft.txt')}`, { headers });
  assert.equal(await file.text(), 'native-workspace-persisted');
  console.log('PASS native child writes a workspace file without dispatching Actions or leaking tool history; the web page lists and serves it');
  const linux = await say('Linux派活');
  assert.ok(linux.sessionUrl.includes('github.com/example/executor/actions/'));
  const dispatched = (await (await fetch(mock + '/__log')).json()).filter(e => e.kind === 'github.dispatch');
  assert.equal(dispatched.length, before + 1);
  console.log('PASS explicit Linux work uses the fixed Actions executor');
} else {
  const tasks = (await api('/web/tasks')).tasks;
  const first = tasks.find(t => t.title === '工作区写入测试' && t.status === 'done');
  assert.ok(first, 'first-stage task persisted across Worker restart');
  const follow = await say(`后台接着读 ${first.id}`);
  const result = await waitTask(follow.id);
  assert.ok(result.summary.includes('native-workspace-persisted'), JSON.stringify(result));
  assert.equal(follow.thread, first.id, 'a follow-up belongs to the first task\'s thread');
  const thread = await api(`/web/thread?id=${first.id}`);
  assert.deepEqual(thread.lines.filter(l => l.role === 'user').map(l => l.task), [first.id, follow.id]);
  console.log('PASS local follow-up reads the same native workspace after Worker restart, in the same thread');
}
