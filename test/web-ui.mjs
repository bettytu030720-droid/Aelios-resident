// The page's renderer is plain JS: exercise its real functions without a live account.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync('public/index.html', 'utf8');
const code = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('function resident()'));
const context = vm.createContext({ document: { documentElement: { dataset: { theme: 'dark' } } }, localStorage: { getItem() { return ''; } }, setTimeout, clearTimeout, console, Date, URL, window: {} });
vm.runInContext(code, context);
const page = vm.runInContext('resident()', context);
const line = { id: 'quoted"<>', role: 'assistant', text: '答复<script>unsafe</script>', kind: 'chat', via: 'web', at: null, activity: [
  { type: 'reasoning', text: '<img src=x onerror=unsafe()>' },
  { type: 'tool', id: 'one', name: 'web_fetch', input: '{"url":"https://example.com"}', output: '</pre><script>unsafe()</script>', state: 'output-available' },
  { type: 'tool', id: 'two', name: 'memory_recall', input: '猫', output: '小橘', state: 'output-available' }
] };
const rendered = page.toMessages(line)[0].html;
assert.ok(rendered.includes('想了一下'));
assert.ok(rendered.includes('忙活了 2 回'));
assert.equal((rendered.match(/<details/g) || []).length, 2);
assert.ok(!rendered.includes(' open'));
assert.ok(!rendered.includes('<script>') && !rendered.includes('<img '));
assert.ok(rendered.includes('&lt;script&gt;'));
assert.ok(rendered.includes('quoted&quot;&lt;&gt;'));
console.log('PASS thoughts and tools are collapsed, counted per call, and HTML-escaped');
assert.equal(page.activityHtml({ activity: [] }), '');
assert.ok(page.activityHtml({ ...line, pending: true }).includes('正在想…'));
assert.ok(page.activityHtml({ ...line, pending: true }).includes('还在继续'));
assert.equal(page.toMessages({ ...line, text: '', activity: [line.activity[1]] }).length, 1);
console.log('PASS empty reasoning is not fabricated; running activity and tool-only replies render');
page.miniApp = true;
page.authed = true;
page.miniSession = async () => { throw new Error('请关闭小窗后重新打开'); };
await assert.rejects(page.api('/web/messages'), /重新打开/);
assert.equal(page.authed, false);
assert.match(page.loginError, /重新打开/);
console.log('PASS a failed Mini App renewal visibly returns to the reconnect screen');
assert.ok(!html.includes('<script src="https://telegram.org/'));
assert.ok(html.includes("script.src = 'https://telegram.org/js/telegram-web-app.js'"));
console.log('PASS ordinary WEB_KEY pages do not load Telegram third-party JS');
const withSticker = page.toMessages({ ...line, activity: [], text: '好呀', stickers: [{ url: '/stickers/0123456789abcdef01234567', video: false }, { url: 'https://evil.example/x.gif', video: false }] });
assert.equal(withSticker.length, 2);
assert.ok(withSticker[1].html.includes('class="sticker-row"') && withSticker[1].html.includes('<img src="/stickers/0123456789abcdef01234567"'));
assert.ok(!withSticker.some((message) => message.html.includes('evil.example')));
const onlySticker = page.toMessages({ ...line, activity: [], text: '', stickers: [{ url: '/stickers/0123456789abcdef01234567', video: true }] });
assert.equal(onlySticker.length, 1);
assert.ok(onlySticker[0].html.includes('<video src="/stickers/0123456789abcdef01234567" autoplay loop muted playsinline>'));
console.log('PASS stickers show after the words, only from the resident itself, and a sticker-only reply is just the sticker');
const voiceFields = (provider, model = '') => [
  { key: 'VOICE_PROVIDER', kind: 'choice', value: provider, fromWorker: '', choices: ['off', 'elevenlabs', 'cartesia', 'openrouter'] },
  { key: 'VOICE_MODEL', kind: 'text', value: model, fromWorker: '' },
  { key: 'VOICE_ID', kind: 'text', value: '', fromWorker: '' },
  { key: 'VOICE_REPLY', kind: 'choice', value: '', fromWorker: '', choices: ['mirror', 'always', 'tool'] },
  { key: 'VOICE_BASE_URL', kind: 'text', value: '', fromWorker: '' },
  { key: 'AI_GATEWAY_ID', kind: 'text', value: '', fromWorker: '' }
];
const voiceGroup = page.CONFIG_GROUPS.find((group) => group.id === 'voice');
const metaOf = (key) => voiceGroup.fields.find((meta) => meta.key === key);
page.config = { fields: voiceFields('') };
assert.equal(page.shown(metaOf('VOICE_PROVIDER')), true);
assert.equal(page.shown(metaOf('VOICE_MODEL')), false);
page.config = { fields: voiceFields('elevenlabs') };
assert.equal(page.shown(metaOf('VOICE_MODEL')), true);
assert.ok(page.picksFor(metaOf('VOICE_MODEL')).includes('eleven_v3'));
assert.equal(page.textInEffect(metaOf('VOICE_MODEL')), 'eleven_v4');
assert.equal(page.tagText(metaOf('VOICE_ID')), '要填');
const saved = [];
page.saveConfig = (key, text) => saved.push([key, text]);
page.pickText(metaOf('VOICE_MODEL'), 'eleven_v4');
page.pickText(metaOf('VOICE_MODEL'), 'eleven_v3');
assert.deepEqual(saved, [['VOICE_MODEL', 'eleven_v3']]);
page.config = { fields: voiceFields('openrouter') };
assert.ok(page.picksFor(metaOf('VOICE_MODEL')).includes('minimax/speech-2.8-hd'));
assert.equal(page.tagText(metaOf('VOICE_MODEL')), '要填');
assert.equal(page.tagText(metaOf('VOICE_ID')), '');
assert.equal(page.placeholderFor(metaOf('VOICE_ID')), '模型自己的');
console.log('PASS voice settings show once a provider is picked, with that provider\'s models to pick from');
page.config = { fields: [...voiceFields('elevenlabs'), { key: 'STICKERS', kind: 'choice', value: '', fromWorker: '', choices: ['on', 'off'] }, { key: 'TG_ALLOWED', kind: 'text', value: '', fromWorker: '@her' }], voice: { hears: 'whisper', gap: 'VOICE_ID' } };
page.stickers = { on: true, packs: [{ id: 'a' }, { id: 'b' }], left: 0 };
assert.deepEqual(Array.from(page.CONFIG_MENU, (item) => item.id), ['aelios', 'chat', 'voice', 'stickers', 'web', 'mcp', 'tasks', 'thinking', 'custom']);
assert.equal(page.sectionSummary('voice'), '还差声音');
assert.ok(page.sectionNeeds('voice'));
assert.equal(page.tagText(metaOf('VOICE_ID')), '要填');
assert.equal(page.sectionSummary('stickers'), '开 · 2 个包');
assert.equal(page.sectionSummary('chat'), '@her · 不主动找');
assert.equal(page.tagText(page.metaOf('TG_ALLOWED')), 'Cloudflare：TG_ALLOWED');
page.config.voice = { hears: 'whisper', gap: null };
assert.equal(page.sectionSummary('voice'), 'ElevenLabs · 你发语音才回语音');
assert.match(page.voiceStatus(), /用 ElevenLabs 说话，你发语音才回语音/);
assert.equal(page.helpFor(metaOf('VOICE_ID')), '从 ElevenLabs 的声音库复制 voice id，自己克隆的也行。');
assert.doesNotMatch(page.voiceStatus(), /Gateway/);
page.config.voice = { hears: 'whisper', gap: null, keyFrom: 'aelios' };
assert.match(page.voiceStatus(), /key 用 AI Gateway「aelios」里存的/);
assert.match(page.helpFor(metaOf('VOICE_API_KEY')), /^空着就用 AI Gateway「aelios」的 Provider Keys/);
assert.match(page.helpFor(metaOf('VOICE_API_KEY')), /到「供应商」里改「AI Gateway 的名字」/);
// The gateway's name has one place: first in 供应商, not behind 更多设置, empty with a grey default.
const providers = page.CONFIG_GROUPS.find((group) => group.id === 'custom');
assert.equal(providers.title, '供应商');
assert.equal(providers.fields[0].key, 'AI_GATEWAY_ID');
assert.ok(!providers.fields[0].more);
assert.equal(page.CONFIG_GROUPS.filter((group) => group.fields.some((meta) => meta.key === 'AI_GATEWAY_ID')).length, 1);
assert.equal(page.placeholderFor(providers.fields[0]), 'default');
assert.equal(page.sectionSummary('custom'), 'Gateway default');
page.view = 'config';
page.openSection('voice');
assert.equal(page.sectionTitle(), '语音');
assert.equal(page.hasMore(voiceGroup), true);
page.configBack();
assert.equal(page.configSection, '');
assert.equal(page.sectionTitle(), '设置');
page.fillDrafts();
page.configBack();
assert.equal(page.view, 'chat');
console.log('PASS the settings page opens on a list with a line of state per section; back goes one step at a time');
// Cloud tasks: a card under the reply that sent it, escaped, with https links only; the settings shown once it is on.
const task = { id: 't_0123456789', title: '<b>修</b>错字', status: 'done', sessionUrl: 'https://claude.ai/code/session_1', progress: '', summary: '好了"<img src=x onerror=unsafe()>',
  links: ['https://github.com/o/r/pull/7', 'javascript:unsafe()', 'http://example.com/a'], test: false };
const withTask = page.toMessages({ ...line, activity: [], text: '派出去了', tasks: [task] });
assert.equal(withTask.length, 2);
const card = withTask[1].html;
assert.ok(card.startsWith('<div class="task-card"') && card.includes('data-task="t_0123456789"'));
assert.ok(card.includes('&lt;b&gt;修&lt;/b&gt;错字') && !card.includes('<b>') && !card.includes('<img'));
assert.ok(card.includes('class="task-status s-done">做完了<'));
assert.ok(card.includes('<a href="https://claude.ai/code/session_1" target="_blank" rel="noopener noreferrer">打开会话</a>'));
assert.ok(card.includes('>r #7</a>') && !card.includes('javascript') && !card.includes('http://example.com'));
assert.ok(!page.toMessages({ ...line, role: 'user', activity: [], text: 'x', tasks: [task] }).some((m) => m.html && m.html.includes('task-card')), 'only under the resident\'s own lines');
assert.ok(page.toMessages({ ...line, activity: [], text: 'x', tasks: [{ ...task, status: 'working', progress: '改到一半', summary: '' }] })[1].html.includes('<div class="task-note">改到一半</div>'));
const taskGroup = page.CONFIG_GROUPS.find((group) => group.id === 'tasks');
const taskFields = (on) => [
  { key: 'CLOUD_TASKS', kind: 'choice', value: on, fromWorker: '', choices: ['on', 'off'] },
  { key: 'CLOUD_TASK_URL', kind: 'text', value: '', fromWorker: '' },
  { key: 'CLOUD_TASK_TOKEN', kind: 'secret', value: '', fromWorker: '', saved: false, workerHas: true }
];
page.config = { fields: taskFields('') };
page.cloud = { on: false, configured: false, origin: 'https://r.example', prompt: 'p', today: 0, limit: 10, tasks: [] };
assert.equal(page.inEffect(taskGroup.fields[0]), 'off', 'off unless turned on');
assert.equal(page.shown(taskGroup.fields[1]), false);
assert.equal(page.sectionSummary('tasks'), '关');
assert.ok(!page.sectionNeeds('tasks'));
page.config = { fields: taskFields('on') };
assert.equal(page.shown(taskGroup.fields[1]), true);
assert.equal(page.sectionSummary('tasks'), '开了，还没接好');
assert.ok(page.sectionNeeds('tasks'));
assert.equal(page.tagText(taskGroup.fields[2]), 'Cloudflare：CLOUD_TASK_TOKEN', 'a token kept as a Cloudflare secret is shown as such');
assert.equal(page.cloudHost(), 'r.example');
page.cloud = { ...page.cloud, on: true, configured: true, today: 3 };
assert.equal(page.sectionSummary('tasks'), '接好了 · 24 小时内派了 3 单');
assert.equal(page.linkText('https://github.com/o/r/pull/7'), 'r #7');
console.log('PASS cloud tasks: a card under the reply, escaped and https only; the settings appear once it is turned on');
// Keys for sites web_fetch reads: counted in the 搜网和读网页 row, only while reading pages is on.
page.config = { fields: [
  { key: 'WEB_SEARCH', kind: 'choice', value: '', fromWorker: '', choices: ['on', 'off'] },
  { key: 'WEB_FETCH', kind: 'choice', value: '', fromWorker: '', choices: ['on', 'off'] }
] };
page.sites = [];
assert.equal(page.sectionSummary('web'), '搜网开 · 读网页开');
page.sites = [{ host: 'gated.example', names: ['CF-Access-Client-Id', 'CF-Access-Client-Secret'] }];
assert.equal(page.sectionSummary('web'), '搜网开 · 读网页开 · 1 个网站带钥匙');
page.config.fields[1].value = 'off';
assert.equal(page.sectionSummary('web'), '搜网开 · 读网页关');
assert.ok(html.includes('x-if="group.id === \'web\'"') && html.includes('placeholder="网站，比如 example.com"'));
console.log('PASS keys for sites: counted in the 搜网和读网页 row while reading pages is on');
