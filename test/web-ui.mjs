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
assert.deepEqual(Array.from(page.CONFIG_MENU, (item) => item.id), ['aelios', 'chat', 'wecom', 'voice', 'stickers', 'web', 'mcp', 'tasks', 'thinking', 'custom']);
// WeCom: off while empty; what is missing; who is let in and whether voice goes out; someone shut out.
page.config.wecom = { gap: 'off', allowed: [], relay: null, error: null, refused: null };
assert.equal(page.sectionSummary('wecom'), '没接');
assert.ok(!page.sectionNeeds('wecom'));
page.config.wecom = { gap: 'WECOM_AGENT_ID', allowed: [], relay: null, error: null, refused: null };
assert.equal(page.sectionSummary('wecom'), '还差AGENT_ID');
assert.match(page.wecomStatus(), /还差AgentId/);
page.config.wecom = { gap: null, allowed: ['heruser'], relay: { amr: true, mp3: true, gif: true, png: true }, error: null, refused: null };
assert.equal(page.sectionSummary('wecom'), 'heruser · 能发语音');
assert.ok(!page.sectionNeeds('wecom'));
page.config.wecom = { gap: null, allowed: [], relay: { amr: false }, error: null, refused: { at: Date.now(), user: 'HerUser' } };
assert.ok(page.sectionNeeds('wecom'));
assert.match(page.wecomStatus(), /没装转码/);
assert.match(page.wecomStatus(), /挡下了账号 HerUser/);
assert.equal(page.viaLabel('wecom'), '企业微信');
console.log('PASS the WeCom section: off while empty, what is missing, the relay, someone shut out');
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
assert.ok(html.includes('x-if="group.id === \'web\'"') && html.includes('sitePreset(\'access\')'));
console.log('PASS keys for sites: counted in the 搜网和读网页 row while reading pages is on');
// The key is typed as name : value rows; the page joins them into the lines the resident reads.
page.siteDraft = { site: 'gated.example', lines: [{ name: '', value: '' }] };
assert.equal(page.siteKeyText(), '', 'nothing typed yet');
page.sitePreset('access');
assert.deepEqual(Array.from(page.siteDraft.lines, (line) => line.name), ['CF-Access-Client-Id', 'CF-Access-Client-Secret']);
page.siteDraft.lines[0].value = ' id.access ';
assert.equal(page.siteKeyText(), '', 'a row with no value is not a key yet');
page.siteDraft.lines[1].value = 'CF-Access-Client-Secret: s3cret';
assert.equal(page.siteKeyText(), 'CF-Access-Client-Id: id.access\nCF-Access-Client-Secret: s3cret', 'a value pasted with its name in front');
page.siteDraft.lines.push({ name: 'X-Extra：', value: '1' });
assert.equal(page.siteKeyText().split('\n')[2], 'X-Extra: 1', 'a colon typed after the name');
page.siteDraft = { site: 'raw.githubusercontent.com', lines: [{ name: '', value: 'github_pat_1' }] };
page.sitePreset('token');
assert.deepEqual(JSON.parse(JSON.stringify(page.siteDraft.lines)), [{ name: 'Authorization', value: 'github_pat_1' }], 'a value already typed stays');
assert.equal(page.siteKeyText(), 'Authorization: Bearer github_pat_1');
page.siteDraft.lines[0].value = 'token abc';
assert.equal(page.siteKeyText(), 'Authorization: token abc', 'a value with its own scheme is left alone');
console.log('PASS keys for sites: name : value rows become the key, presets fill the names, pasted names are dropped');
// The heartbeat is on unless turned off, alarms off unless turned on; the 聊天 row counts the alarms while they are on.
const chatGroup = page.CONFIG_GROUPS.find((group) => group.id === 'chat');
const chatMeta = (key) => chatGroup.fields.find((meta) => meta.key === key);
page.config = { fields: [
  { key: 'TG_ALLOWED', kind: 'text', value: '@her', fromWorker: '' },
  { key: 'CHECKIN_SCHEDULE', kind: 'text', value: '', fromWorker: '' },
  { key: 'HEARTBEAT', kind: 'text', value: '', fromWorker: '' },
  { key: 'ALARMS', kind: 'choice', value: '', fromWorker: '', choices: ['on', 'off'] }
] };
assert.equal(page.textInEffect(chatMeta('HEARTBEAT')), '3', 'three times unless set');
assert.deepEqual(Array.from(page.picksFor(chatMeta('HEARTBEAT'))), ['0', '1', '3', '5', '10']);
assert.equal(page.inEffect(chatMeta('ALARMS')), 'off');
page.alarms = { on: false, limit: 10, alarms: [{ id: 'a_1', note: '叫她起床', next: '10-25 周日 09:00', when: '每天 09:00' }] };
assert.equal(page.sectionSummary('chat'), '@her · 不主动找');
page.config.fields[3].value = 'on';
assert.equal(page.sectionSummary('chat'), '@her · 不主动找 · 闹钟 1 个');
const calls = [];
page.api = async (path, options) => { calls.push([path, options && options.body]); return { on: true, limit: 10, alarms: [] }; };
page.notify = () => {};
await page.removeAlarm(page.alarms.alarms[0]);
assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['/web/alarms/remove', { id: 'a_1' }]]);
assert.equal(page.alarms.alarms.length, 0);
assert.ok(html.includes('x-if="group.id === \'chat\'"') && html.includes('removeAlarm(alarm)'));
console.log('PASS heartbeat three times and alarms off by default; alarms counted in the 聊天 row and deleted from the settings page');
// Letter settings: one visible threshold, two conditions, and a fixed recent-chat budget instead of a second knob.
const letterPage = vm.runInContext('resident()', context);
const thinkingGroup = letterPage.CONFIG_GROUPS.find((group) => group.id === 'thinking');
const threshold = thinkingGroup.fields.find((meta) => meta.key === 'LETTER_TOKEN_THRESHOLD');
const idle = thinkingGroup.fields.find((meta) => meta.key === 'LETTER_IDLE_MINUTES');
assert.ok(threshold, 'the token threshold has its own setting');
assert.equal(letterPage.CONFIG_GROUPS.flatMap((group) => group.fields).filter((meta) => meta.key === threshold.key).length, 1);
assert.equal(Boolean(threshold.more), false, 'the threshold is visible without opening 更多设置');
assert.equal(letterPage.shown(threshold), true);
assert.ok(!html.includes('KEEP_RECENT_TOKENS'), 'the retired recent-token setting is absent from the page');
letterPage.config = { fields: [
  { key: threshold.key, kind: 'text', value: '', fromWorker: '' },
  { key: idle.key, kind: 'text', value: '', fromWorker: '' }
] };
assert.equal(letterPage.field(threshold.key).kind, 'text', 'use the ordinary settings input');
assert.equal(letterPage.placeholderFor(threshold), '30000');
assert.equal(letterPage.textInEffect(threshold), '30000');
assert.match(letterPage.helpFor(threshold), /只接受大于 8000 的整数/);
assert.match(letterPage.helpFor(threshold), /50000/);
assert.match(letterPage.helpFor(threshold), /当前携带的聊天估算，含旧交接信、工具调用和结果、图片/);
assert.match(letterPage.helpFor(threshold), /不含人设、工具定义和历史思考/);
assert.match(letterPage.helpFor(threshold), /不按累计聊天总量算/);
assert.match(letterPage.groupHint(thinkingGroup), /同时满足聊天达到 token 门槛、没人说话达到闲置时间（默认 55 分钟）/);
assert.match(letterPage.groupHint(thinkingGroup), /连续聊天即使超过门槛也不会立即写/);
assert.match(letterPage.groupHint(thinkingGroup), /固定保留最近约 8000 token 原始聊天，整轮问答不拆开；最近一轮本身超过 8000 时整轮保留/);
assert.match(letterPage.groupHint(thinkingGroup), /交接信、人设、工具定义另算/);
assert.match(letterPage.groupHint(thinkingGroup), /手动 \/handoff 不受门槛限制，但也要有旧内容可收/);
assert.match(letterPage.helpFor(idle), /达到门槛后，也要等这么久没人说话/);
assert.match(letterPage.helpFor(idle), /off 只靠手动 \/handoff/);
assert.match(letterPage.helpFor(letterPage.metaOf('HEARTBEAT')), /还没达到写信门槛，或没有旧内容可收/);
console.log('PASS letter settings expose the threshold, remove the old knob, and explain both conditions and fixed recent chat');
// Exercise the real save/clear flow rather than the stub used by the earlier picker tests.
const letterCalls = [];
letterPage.notify = () => {};
letterPage.api = async (path, options) => {
  letterCalls.push([path, options && options.body]);
  if (path === '/web/letter') return {};
  return { fields: letterPage.config.fields.map((field) => field.key === options.body.key ? { ...field, value: options.body.text } : field) };
};
letterPage.fillDrafts();
letterPage.configDraft[idle.key] = '40';
letterPage.configDraft[threshold.key] = '50000';
assert.equal(letterPage.configDirty(threshold.key), true);
await letterPage.saveConfig(threshold.key, letterPage.configDraft[threshold.key]);
assert.equal(letterPage.textInEffect(threshold), '50000');
assert.equal(letterPage.savedHere(threshold.key), true);
assert.equal(letterPage.configDirty(threshold.key), false);
assert.equal(letterPage.configDraft[idle.key], '40', 'saving the threshold leaves other drafts intact');
await letterPage.saveConfig(threshold.key, '');
assert.equal(letterPage.textInEffect(threshold), '30000');
assert.equal(letterPage.savedHere(threshold.key), false);
assert.equal(letterPage.configDraft[threshold.key], '');
assert.deepEqual(JSON.parse(JSON.stringify(letterCalls)), [
  ['/web/config', { key: 'LETTER_TOKEN_THRESHOLD', text: '50000' }],
  ['/web/letter', null],
  ['/web/config', { key: 'LETTER_TOKEN_THRESHOLD', text: '' }],
  ['/web/letter', null]
]);
letterPage.field(threshold.key).fromWorker = '50000';
assert.equal(letterPage.textInEffect(threshold), '50000');
assert.equal(letterPage.placeholderFor(threshold), '50000');
assert.equal(letterPage.tagText(threshold), 'Cloudflare：LETTER_TOKEN_THRESHOLD');
console.log('PASS the letter threshold uses the normal save/clear API, refreshes letter state, and inherits Cloudflare or the default');
// Writing and delivery have independent outcomes. Missing fields never imply an empty successful handoff.
const statePage = vm.runInContext('resident()', context);
statePage.notify = () => {};
for (const response of [null, {}, { write: null }, { delivery: {} }, { write: {}, delivery: { latest: {} } }]) {
  statePage.setLetter(response);
  assert.equal(statePage.letterCanRetry(), false);
  assert.equal(statePage.letterDeliveryCounts(), '待发送 0 · 待重试 0 · 已暂停 0');
  assert.doesNotMatch(statePage.letterWriteStatus(), /没有旧内容可收|信已写好/);
  assert.doesNotThrow(() => statePage.letterDeliveryDetail());
}
const at = Date.UTC(2026, 9, 25, 12);
for (const [state, label] of [
  ['writing', '正在写信'], ['recovering', '已有恢复任务，正在恢复写信'], ['written', '信已写好'],
  ['empty', '没有旧内容可收，本次未写信'], ['failed', '写信失败，旧聊天仍保留'], ['future', '写信状态未知']
]) {
  statePage.setLetter({ write: { state, at } });
  assert.equal(statePage.letterWriteStatus(), label);
  assert.equal(statePage.letterTime(statePage.letter.write.at), statePage.fmt(at));
  assert.equal(statePage.sectionNeeds('thinking'), state === 'failed');
}
assert.equal(statePage.letterTime(null), '暂无记录');
statePage.setLetter({ write: { state: 'written', at: NaN }, delivery: { pending: -1, failed: '1', blocked: Infinity, latest: { at: 1e100 } } });
assert.equal(statePage.letterTime(statePage.letter.write.at), '暂无记录');
assert.equal(statePage.letter.delivery.latest.at, null);
assert.equal(statePage.letterCanRetry(), false);
console.log('PASS letter write states distinguish failure, no content, and recovery; missing or invalid fields are safe');
const unsafeError = '发送失败：<img src=x onerror=unsafe()> & "请重试"';
const snapshot = (status, failed = 0, blocked = 0, canRetry = failed > 0 || blocked > 0) => ({
  canRetry,
  write: { state: 'written', at, error: unsafeError },
  delivery: { pending: 2, failed, blocked, latest: { id: 'letter_1', at, status, attempts: 6, lastError: unsafeError, sentAt: status === 'sent' ? at + 1000 : null } }
});
for (const [status, label] of [['pending', /待发送/], ['sent', /已确认送达/], ['failed', /发送失败/], ['blocked', /已暂停/]]) {
  statePage.setLetter(snapshot(status, status === 'failed' ? 1 : 0, status === 'blocked' ? 1 : 0));
  assert.match(statePage.letterDeliveryStatus(), label);
  assert.match(statePage.letterDeliveryDetail(), /已尝试 6 次/);
  assert.equal(statePage.letterCanRetry(), status === 'failed' || status === 'blocked');
  assert.equal(statePage.sectionNeeds('thinking'), statePage.letterCanRetry());
  assert.equal(statePage.letterDeliveryDetail().includes('确认送达：'), status === 'sent');
}
// Older failures must remain retryable even when the latest letter was sent successfully.
statePage.config = { fields: [{ key: 'THINKING_EFFORT', kind: 'choice', value: '', fromWorker: '' }] };
statePage.setLetter(snapshot('sent', 3, 4));
assert.equal(statePage.letterCanRetry(), true);
assert.equal(statePage.letterDeliveryCounts(), '待发送 2 · 待重试 3 · 已暂停 4');
assert.match(statePage.sectionSummary('thinking'), /信已写好.*待重试 3.*已暂停 4/);
// Failures left only for an earlier Aelios address or namespace: retrying cannot resend them, so no button.
statePage.setLetter(snapshot('failed', 2, 1, false));
assert.equal(statePage.letterCanRetry(), false);
assert.equal(statePage.letterDeliveryCounts(), '待发送 2 · 待重试 2 · 已暂停 1');
statePage.setLetter(snapshot('sent', 3, 4));
const letterPanel = html.slice(html.indexOf('<template x-if="group.id === \'thinking\'">'), html.indexOf('<template x-for="meta in group.fields"'));
assert.ok(letterPanel.length > 0 && !letterPanel.includes('x-html'));
for (const binding of ['letterWriteStatus()', "'最近写信时间：' + letterTime(letter.write && letter.write.at)", 'letter.write && letter.write.error', 'letterDeliveryStatus()', 'letterDeliveryCounts()', 'letterDeliveryDetail()', 'letter.delivery.latest && letter.delivery.latest.lastError', 'letterError']) {
  assert.ok(letterPanel.includes('x-text="' + binding + '"'), binding + ' uses text-only binding');
}
assert.equal(statePage.letter.write.error, unsafeError, 'raw error is kept as text, not interpolated into HTML');
assert.equal(statePage.letter.delivery.latest.lastError, unsafeError);
assert.ok(letterPanel.includes('x-show="letterCanRetry()"'));
assert.match(letterPanel, /只重发已写好的信，不调用模型、不重写信/);
assert.match(letterPanel, /最多自动尝试 6 次/);
assert.match(letterPanel, /确认送达不等同于 Aelios 后台记忆处理已完成/);
console.log('PASS delivery states and queue counts stay separate; retry visibility follows what retry can resend, including older failures; error bindings use x-text, never x-html');
const retryCalls = [];
statePage.api = async (path, options) => {
  retryCalls.push([path, options]);
  assert.equal(statePage.letterBusy, 'retry');
  await statePage.retryLetter(); // A second click while in flight sends nothing.
  return snapshot('blocked', 0, 4); // Still paused after the retry, not reported as delivered.
};
await statePage.retryLetter();
assert.deepEqual(JSON.parse(JSON.stringify(retryCalls)), [['/web/letter/retry', { method: 'POST' }]]);
assert.equal(statePage.letterCanRetry(), true);
assert.match(statePage.letterDeliveryStatus(), /已暂停/);
assert.equal(statePage.letterBusy, '');
statePage.api = async (path, options) => { retryCalls.push([path, options]); return snapshot('sent'); };
await statePage.retryLetter();
assert.equal(statePage.letterCanRetry(), false);
await statePage.retryLetter();
assert.equal(retryCalls.length, 2, 'pending-only or sent states cannot trigger a retry');
statePage.setLetter(snapshot('failed', 1));
statePage.configBusy = 'AELIOS_URL';
await statePage.retryLetter();
assert.equal(retryCalls.length, 2, 'do not retry while saving a target change');
statePage.configBusy = '';
statePage.api = async () => { throw new Error(unsafeError); };
await statePage.retryLetter();
assert.equal(statePage.letterBusy, '');
assert.equal(statePage.letterCanRetry(), true, 'request failure preserves retryable deliveries');
assert.match(statePage.letterError, /^重试同步失败：/);
await statePage.loadLetter();
assert.equal(statePage.letterBusy, '');
assert.match(statePage.letterError, /^读取交接信状态失败/);
assert.match(statePage.letterWriteStatus(), /信已写好/, 'a read failure does not invent an empty or failed write');
assert.equal(statePage.sectionNeeds('thinking'), true);
statePage.api = async () => ({});
await statePage.loadLetter();
assert.equal(statePage.letterError, '');
assert.equal(statePage.letter.write, null);
console.log('PASS retry sends only POST /web/letter/retry, handles paused targets and duplicate clicks, and preserves state on network errors');
// Open/save must read the status endpoint. A status read failure must not turn a successful config save into a failure.
const configPage = vm.runInContext('resident()', context);
const configCalls = [];
configPage.notify = () => {};
for (const name of ['loadMcp', 'loadSites', 'loadStickers', 'loadTasks', 'loadAlarms']) configPage[name] = async () => {};
let failRead = false;
configPage.api = async (path, options) => {
  configCalls.push(path);
  if (path === '/web/letter') {
    if (failRead) throw new Error('暂时无法读取');
    return snapshot('sent');
  }
  assert.equal(path, '/web/config');
  return { fields: [{ key: 'LETTER_TOKEN_THRESHOLD', kind: 'text', value: options ? options.body.text : '', fromWorker: '' }] };
};
await configPage.openConfig();
assert.deepEqual(configCalls, ['/web/config', '/web/letter']);
assert.equal(configPage.view, 'config');
assert.equal(configPage.letter.write.state, 'written');
failRead = true;
await configPage.saveConfig('LETTER_TOKEN_THRESHOLD', '50000');
assert.deepEqual(configCalls.slice(2), ['/web/config', '/web/letter']);
assert.equal(configPage.field('LETTER_TOKEN_THRESHOLD').value, '50000');
assert.equal(configPage.configError.LETTER_TOKEN_THRESHOLD, '');
assert.match(configPage.letterError, /读取交接信状态失败/);
assert.equal(configPage.configBusy, '');
console.log('PASS opening and saving config read /web/letter; a failed status read does not misreport a successful settings save');

// The model picker. Without Aelios it browses the catalog the page ships with; with Aelios connected it browses
// Aelios' own model list (what can actually be picked there), falling back to the catalog when that cannot be had.
const pickerPage = (patch = {}) => {
  const picker = vm.runInContext('resident()', context);
  picker.catalog = [
    { id: 'anthropic/claude-opus-5.5', name: 'claude-opus-5.5', provider: 'Anthropic', hosted: false, desc: 'Opus.' },
    { id: 'openai/gpt-5', name: 'gpt-5', provider: 'OpenAI', hosted: false, desc: 'GPT.' },
    { id: '@cf/zai-org/glm-4.7-flash', name: 'glm-4.7-flash', provider: 'Zhipu AI', hosted: true, desc: 'GLM.' },
    { id: 'anthropic/claude-sonnet-4.5', name: 'claude-sonnet-4.5', provider: 'Anthropic', hosted: false, desc: 'Sonnet.' },
    { id: 'openai/gpt-4o', name: 'gpt-4o', provider: 'OpenAI', hosted: false, desc: '4o.' },
    { id: '@cf/meta/llama-3.3', name: 'llama-3.3', provider: 'Meta', hosted: true, desc: 'Llama.' }
  ];
  picker.model = { model: 'openai/gpt-5', at: null, fallback: '@cf/zai-org/glm-4.7-flash', recent: [], lastUsage: null, memoryOff: false };
  return Object.assign(picker, patch);
};
// Arrays made inside the page's context have another Array; copy them out so deepEqual compares like with like.
const titles = (picker) => Array.from(picker.pickerGroups().map((group) => group.title));
const ids = (picker, title) => Array.from(picker.pickerGroups().find((group) => group.title === title)?.items.map((item) => item.id) ?? []);
const aeliosList = (items, curated = true, error = '') => ({ loaded: true, items, curated, error });
const listed = [
  { id: 'chatgpt/gpt-5', owner: 'chatgpt', main: true },
  { id: 'openrouter/openai/gpt-6.1-sol:floor', owner: 'openrouter', main: false },
  { id: 'anthropic/claude-opus-5-5', owner: 'anthropic', main: true }
];

const plain = pickerPage();
assert.equal(plain.canon('anthropic/claude-opus-5.5'), 'anthropic/claude-opus-5-5');
assert.equal(plain.canon('Anthropic/claude-opus-5.5'), 'anthropic/claude-opus-5-5');
assert.equal(plain.canon('@cf/zai-org/glm-4.7-flash'), 'workers-ai/@cf/zai-org/glm-4.7-flash');
assert.equal(plain.canon('custom-relay/anthropic/claude-sonnet-4.5'), 'custom-relay/anthropic/claude-sonnet-4.5');
assert.equal(plain.same('anthropic/claude-opus-5.5', 'anthropic/claude-opus-5-5'), true);
assert.equal(plain.same('openai/gpt-5', 'openai/gpt-4'), false);
assert.equal(plain.same('', ''), false);
console.log('PASS one model spelled with dots or dashes counts as one, the way Aelios names it');

assert.equal(plain.pickerMode(), 'catalog');
assert.equal(plain.pickerNote(), '');
assert.deepEqual(titles(plain), ['正在用', '常用', 'Anthropic', 'OpenAI', 'Workers AI · Meta']);
assert.equal(plain.entry('anthropic/claude-opus-5-5').desc, 'Opus.', 'the catalog still describes a model spelled the other way');
assert.equal(plain.entry('anthropic/claude-opus-5-5').id, 'anthropic/claude-opus-5-5', 'and the spelling it was given is kept');
console.log('PASS without Aelios the picker browses the shipped catalog as before');

const waiting = pickerPage({ aelios: true });
assert.equal(waiting.pickerMode(), 'loading');
assert.match(waiting.pickerNote(), /正在取 Aelios/);
assert.deepEqual(titles(waiting), ['正在用'], 'no catalog flashes up while Aelios is being asked');
console.log('PASS while Aelios is being asked the picker shows what is in use, not the catalog');

const curated = pickerPage({ aelios: true, aeliosModels: aeliosList(listed), model: { ...plain.model, model: 'chatgpt/gpt-5', recent: ['openai/gpt-5'] } });
assert.equal(curated.pickerMode(), 'aelios');
assert.deepEqual(titles(curated), ['正在用', '最近用过', '常用', 'openrouter'], 'the model in use and the favourite are not listed a second time under their own provider');
assert.deepEqual(ids(curated, '常用'), ['anthropic/claude-opus-5.5'], 'a favourite is shown when Aelios lists it, whichever way it is spelled');
assert.equal(curated.pickerGroups().find((group) => group.title === '常用').items[0].main, true);
assert.deepEqual(ids(curated, 'openrouter'), ['openrouter/openai/gpt-6.1-sol:floor']);
assert.equal(curated.pickerGroups().find((group) => group.title === 'openrouter').items[0].main, false, 'a model that would not remember is marked');
assert.ok(!titles(curated).some((title) => /^(Anthropic|OpenAI|Workers AI)/.test(title)), 'the shipped catalog is not browsed');
assert.match(curated.pickerNote(), /你在 Aelios 里存的模型清单/);
assert.equal(curated.entry('anthropic/claude-opus-5-5').desc, 'Opus.', 'the catalog still describes a listed model');
assert.equal(curated.entry('anthropic/claude-opus-5-5').main, true);
console.log('PASS with Aelios connected the picker browses its model list, once per model, marks the ones that would not remember');

const searching = pickerPage({ aelios: true, aeliosModels: aeliosList(listed) });
searching.picker.q = '5.5';
assert.deepEqual(ids(searching, '搜到的'), ['anthropic/claude-opus-5-5'], 'a search with dots finds a dashed version');
searching.picker.q = 'sol:floor';
assert.deepEqual(ids(searching, '搜到的'), ['openrouter/openai/gpt-6.1-sol:floor']);
searching.picker.q = 'custom-mine/tiny';
assert.deepEqual(titles(searching), ['目录里没有'], 'an id nobody lists can still be typed in');
assert.deepEqual(ids(searching, '目录里没有'), ['custom-mine/tiny']);
searching.picker.q = 'anthropic/claude-opus-5.5';
assert.ok(!titles(searching).includes('目录里没有'), 'the same model spelled another way is not "not listed"');
console.log('PASS search runs over Aelios\' list (dots or dashes), and a typed id it does not list is still offered');

const everything = Array.from({ length: 200 }, (_, i) => ({ id: `openrouter/vendor/model-${i}`, owner: 'openrouter' }));
const huge = pickerPage({ aelios: true, aeliosModels: aeliosList(everything, false) });
assert.deepEqual(titles(huge), ['正在用'], 'an uncurated catalog is searched, not browsed');
assert.match(huge.pickerNote(), /一共 200 个模型/);
huge.picker.q = 'model-1';
assert.equal(ids(huge, '搜到的').length, 60, 'and search shows at most 60');
const small = pickerPage({ aelios: true, aeliosModels: aeliosList(everything.slice(0, 40), false) });
assert.ok(titles(small).includes('openrouter'), 'a short list is browsed even when nobody curated it');
assert.equal(small.pickerNote(), '');
console.log('PASS an uncurated catalog of hundreds is searched rather than drawn in full');

const down = pickerPage({ aelios: true, aeliosModels: aeliosList([], false, 'Aelios answered 401') });
assert.equal(down.pickerMode(), 'catalog');
assert.match(down.pickerNote(), /没取到（Aelios answered 401）.*自带的目录/);
assert.ok(titles(down).includes('Anthropic'));
const empty = pickerPage({ aelios: true, aeliosModels: aeliosList([], false) });
assert.equal(empty.pickerMode(), 'catalog');
assert.equal(empty.pickerNote(), '');
console.log('PASS when Aelios cannot give a list the picker falls back to the shipped catalog and says why');

const loader = pickerPage({ aelios: true });
const asked = [];
loader.api = async (path) => { asked.push(path); return { aelios: true, models: listed, curated: true }; };
await loader.loadAeliosModels();
assert.deepEqual(asked, ['/web/models']);
assert.deepEqual([loader.aeliosModels.loaded, loader.aeliosModels.items.length, loader.aeliosModels.curated, loader.aeliosModels.error], [true, 3, true, '']);
loader.api = async () => { throw new Error('网页门断了'); };
await loader.loadAeliosModels();
assert.deepEqual([loader.aeliosModels.loaded, loader.aeliosModels.items.length, loader.aeliosModels.error], [true, 0, '网页门断了']);
loader.api = async (path) => ({ aelios: true, models: [], curated: false, error: 'Aelios answered 401' });
await loader.loadAeliosModels();
assert.equal(loader.aeliosModels.error, 'Aelios answered 401');
const offline = pickerPage({ aelios: false });
offline.api = async () => { throw new Error('should not be asked'); };
await offline.loadAeliosModels();
assert.equal(offline.aeliosModels.loaded, false);
console.log('PASS the list is fetched from /web/models only when Aelios is connected, and a failure is kept as a reason');

const same = pickerPage({ model: { ...plain.model, model: 'anthropic/claude-opus-5.5' } });
same.api = async () => { throw new Error('picking the model already in use must not try it again'); };
same.picker.open = true;
await same.chooseModel('anthropic/claude-opus-5-5');
assert.equal(same.picker.open, false);
console.log('PASS choosing the model already in use, spelled the other way, just closes the picker');

