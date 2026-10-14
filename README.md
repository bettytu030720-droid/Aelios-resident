# Aelios-resident：住在 Cloudflare 里的伴侣，Telegram 和网页两扇门

一个住在 Durable Object 里的聊天 agent（基于 Cloudflare 的 [Think](https://developers.cloudflare.com/agents/)），[Aelios](https://github.com/wusaki0723/Aelios) 当长期记忆。Telegram 和网页是同一段对话的两扇门；你停下来一阵（默认 55 分钟），它趁对话还在缓存里给之后的自己写一封交接信，把旧聊天收起来。

```
Telegram ──▶ Worker（验 secret、白名单、斜杠命令）──┐
网页门（public/，WEB_KEY）────────────▶ Worker /web/* ──┤
                                                     ▼
                         Resident（一个 Durable Object，一段对话）
            模型（网页上选）← 人设（网页上填）+ 聊天规矩 + Aelios 开机包；工具：Aelios 记忆 6 个、web_search、web_fetch
            每轮记进 Aelios；没动静 55 分钟写交接信；到点可以主动找你
```

## 能做什么

- **Telegram**：私聊才回，不在 `TG_ALLOWED` 里的人一个字都不回。连发几条会等 `DEBOUNCE_SECONDS` 秒并成一轮。回复按空行拆成几条消息，写完一段发一段，中间显示「正在输入」。你每条消息前面带上当地时间（`TIME_ZONE`），模型知道现在几点。Telegram 重发同一条消息不会回两次。
- **网页门**：打开 Worker 的网址，填 `WEB_KEY` 进门。聊天界面用的是现成的 [deep-chat](https://github.com/OvidijusParsiunas/deep-chat)（MIT），星空配色，夜间/白天可切，手机上也好按。跟 Telegram 是同一段对话：两边说的话两边都看得到（网页每 5 秒刷新一次）；在网页上说的话只在网页上回。每条下面有时间、从哪边来的、心形按钮（存进 Aelios 的「珍贵」）。交接信折叠显示在它收起的位置。
- **模型**：点网页门左上角的模型名换。弹出来的是一个搜索框，不是几千项的下拉菜单：上面是正在用的、最近用过的、常用的（Claude 几个和默认的 GLM），往下是 Cloudflare 模型目录里全部文字模型（110 个，按厂商分组），输入 `opus`、`kimi`、`qwen` 就筛出来；目录里没有的，直接填完整 id 也能用。紫点是 Cloudflare 自己跑的（Workers AI），橙点走 AI Gateway 的额度。换之前先让它带着一句人设和缓存标记说一个字试试，调不通（写错、档位不含、没额度）就不换，当场告诉你原因。没选时用免费档能用的 `@cf/zai-org/glm-4.7-flash`。Claude 填 `anthropic/claude-opus-5.5` 这种（Cloudflare 的写法用点号），走 Anthropic 的 Messages 接口，每轮都带缓存标记，人设、规矩、开机包和之前的聊天下一轮从缓存读，缓存默认留 1 小时（`CACHE_TTL`）；`/status` 和人设页会显示上一次调用的缓存读了多少。以前填在 `MODEL` 变量里的模型，第一次用时自动搬过来，之后改 `MODEL` 不再起作用。
- **人设**：点右上角的铅笔填，保存后下一句就按新的说。存在 Durable Object 里，不在代码和 Secret 里，所以公开仓库也不会带出去。最近 10 版都留着，可以一键放回去；没填时用一句默认的，网页门顶上会提醒你去填。
- **Aelios 长期记忆**：你每发一条，回之前先拿这句去 Aelios 搜一下，最近没想起过的几条贴在这句后面给模型看，标成 `<recalled>`（自动浮现）；贴上的跟着那条留在记录里、以后不再改，所以缓存照样命中，网页、Telegram 和存回 Aelios 的都看不到它。另外给模型 6 个记忆工具：`memory_recall` 查、`memory_remember` 记一句（能改旧的）、`memory_keep_moment` 存珍贵瞬间、`memory_forget` 归档（Aelios 里能找回）、`memory_learn_word` 记黑话、`memory_read_diary` 翻日记；除了查，都走 Aelios 自己的 MCP，但描述是住户这边写的短句，7 个工具（含 `web_fetch`）的说明加起来约 2500 字符，每轮少占 token；每一轮都记进 Aelios（夜里 Dream 照常整理）；Aelios 的开机包（昨天的日记、珍贵原话、黑话表）放进系统提示，最多 6 小时取一次。
- **交接信**：没有长度上限。你 `LETTER_IDLE_MINUTES`（默认 55）分钟没动静，住户就给之后的自己写一封信，较早的聊天收进信里，最近 `KEEP_RECENT_TOKENS` 原样留着；写完就不动了，等你下次发消息。55 分钟是为了赶在 1 小时缓存过期前：写信那一轮就接在原对话后面问（系统提示、工具、之前每条消息都和上一轮一字不差），所以整段对话从缓存读，便宜；写完把这一问一答撤掉。信照七段写（对方怎么样、我们之间发生了什么、做了什么事、现在的温度、想做的事、喜欢的事、未完成的事），上一封里还没了结的要接着往下传，有时效的写死日期。信存在 Durable Object 里，也记进 Aelios，不发 Telegram 打扰你；`/letter` 看，`/handoff` 随时手动写。
- **提示词**：住户自带的聊天规矩、交接信和定时提示都是英文写的，不预设对方是谁、什么性别，称呼用人设和聊天里的；人设用什么语言，它就用什么语言聊。
- **主动找你**：`CHECKIN_SCHEDULE` 填了（比如 `every day at 09:00`），到点住户自己想想要不要找你；不合适打扰就不发。
- **查网页**（默认开）：`web_search` 搜网。填了自己的搜索 key（Secret `TAVILY_API_KEY`、`BRAVE_API_KEY`、`PERPLEXITY_API_KEY`，有几个填几个）就按 Tavily → Brave → Perplexity 的顺序用，前一家报错或免费额度用完就换下一家，不花 Gateway 的钱；一个都没填时用 Cloudflare 的 Web Search（按次收一点 AI Gateway 额度，见下）。`web_fetch` 把一个网页读成 Markdown，搜到的结果、你发的链接都能打开，照 [web-fetch](https://github.com/sakisakisa-design/web-fetch) 的做法长在住户里，不用另外部署：先普通地抓，每一次跳转都先查目的地再跟过去，本机和内网地址一律不读；抓回来几乎是空的（靠 JavaScript 才显示的页面）就交给 Cloudflare 的浏览器（`BROWSER` 绑定，不加载图片字体；浏览器跑在 Cloudflare 的机器上，网址里写明的本机和内网 IP 在浏览器里也拦掉，最后落到哪儿再查一遍，但解析到内网的域名只在最后这一查里拦得住）；读过的页面在住户自己的存储里留 1 小时，再问同一页不用重抓；长页面先用一个便宜的模型压一遍（`WEB_FETCH_MODEL`，默认 Workers AI 的 Qwen3 30B；填法和网页上换主模型一样，`anthropic/claude-haiku-5.5` 这种走 AI Gateway 的收费模型也行），带了问题就只摘跟问题有关的段落，这样一页新闻不会占掉一大截聊天记录。GBK 之类的老编码也认。
- **命令**：`/status` 看模型、人设、对话长度、交接信封数、上一次调用的缓存命中；`/letter` 看最近一封信；`/handoff` 马上写信。

## 测过什么

本地用假 Telegram、假 Aelios、脚本模型跑 `test/run.mjs`：

- 主流程 25 项全过：错 secret 拒绝；陌生人和群聊不回；两个气泡和时间戳；正在输入；重发去重；开机包进系统提示；`memory_recall` 打到 Aelios；`memory_remember` 走 Aelios 的 MCP；`web_fetch` 本机地址拒读；自动浮现（同一条记忆不重复浮现，之前浮现的原样留在那条后面，不存回 Aelios、网页上看不到）；每轮记进 Aelios；连发三条并成一轮；`/status`、`/letter`、`/handoff`（写信后对话里带着信；写信那一轮发给模型的前文和上一轮一字不差，所以吃得到缓存）；网页门没钥匙进不去；网页看得到 Telegram 的对话和交接信；网页上说的话在网页回、不发到 Telegram；心形按钮存进珍贵；没填人设时用默认那句；网页上存了人设，下一条 Telegram 消息就按新人设回；人设超过 3 万字拒收；旧版本留着，存空的回到默认；每轮都带 Anthropic 缓存标记（1 小时）；模型在网页上换，写错或调不通的不换，换成功的记进「最近用过」。另外单独测了旧的 `MODEL` 变量会搬到网页设置里。
- 定时：每分钟一次的定时，第一次主动发了两个气泡并记进 Aelios，第二次模型回 SKIP，什么都没发。
- 空闲交接信：把空闲时间调成 3 秒，聊 3 轮后自己写了信：没发 Telegram、记进 Aelios、网页上看得到信、写信的那一问一答撤掉了、前文和上一轮一字不差；之后再说一句会再写一封，不说话就不再写。
- 发给 Claude 前的整理（`node test/claude-run.mjs`）4 项：system 合成一段；之前几轮的思考块拿掉、回复和工具调用留着、这一轮工具之间的思考留着、只有思考的那条整条去掉；第一轮和没思考块的原样发；别家模型不动。另外用真的 AI SDK 和 Cloudflare provider 核过：不整理时历史里的思考块会带着签名发出去，整理后没有。
- 读网页（`node test/web.mjs`，不用起 Worker，网络全是假的）17 项：跳转先查再跟；跳到本机或内网（包括域名解析到内网）不跟；无限跳转会停；本机地址直接拒；JavaScript 空壳交给浏览器且不加载图片、浏览器里也拦内网 IP；没有浏览器时原样返回；404 和图片不送浏览器；读过的页面再问不重抓、同一页同一个问题连压缩结果也不重算；模型回 NOTHING_RELEVANT 的段落丢掉、只是提到这个词的留着；带问题的长页只留摘出来的部分（Qwen3 带 `/no_think`）；换成 Claude 之类的别家模型也能压、不带 `/no_think`；短页不送模型；回答里的 think 块去掉；模型挂了原样返回；工具超时会把模型调用一起取消；GBK 页面（GBK 在本地 workerd 里也核过能解）。
- 回复写到一半把进程杀掉：重启后住户自己醒过来，发一句「刚才回到一半断了，再发一次好吗？」，不会把半截重发一遍。
- 网页门在 Chromium 里点过（手机宽度夜间、电脑宽度白天）：错钥匙提示、手机宽度没有横向滚动、发消息收到回复（自己那条也带上时间和心形）、心形按钮、Telegram 那边发的消息 5 秒内自己出现且不重复、交接信折叠；换模型：搜 `opus` 只出 opus、调不通的不换并显示原因、目录里没有的 id 可以直接试、方向键和回车能选、Esc 关掉；人设：没填时的提醒、写了「Claude Code」会提示、保存后提醒消失。

没测过：真的模型、部署到线上（免费档的 CPU 和启动时间只在线上能验）；Cloudflare 浏览器和长页压缩（Qwen 或别的模型）只用假的测过；Claude 走 Cloudflare 这条路时 1 小时缓存有没有生效，要上线后看 `/status` 的缓存读写。

## 上线

1. **建 bot**：Telegram 里找 @BotFather，`/newbot`，起名字，记下 token 和 bot 的用户名。
2. **部署**：Cloudflare 后台 → Workers & Pages → Create → Import a repository，选这个仓库。项目名填 `aelios-resident`（要跟 `wrangler.jsonc` 里的 `name` 一样），其余用默认（部署命令 `npx wrangler deploy`）。以后推到 main 就自动更新。不用建 D1、KV 或别的库：聊天记录、交接信、人设存在 Durable Object 自带的 SQLite 里，部署时自动建好；长期记忆走你现有的 Aelios。
3. **填密钥和设置**（Worker → Settings → Variables and Secrets）。`wrangler.jsonc` 里故意一个变量都不写，所以这里填的东西以后推代码不会被冲掉：
   - Secret `TG_BOT_TOKEN`：第 1 步的 token
   - Secret `TG_WEBHOOK_SECRET`：自己编一串长的（字母、数字、`_`、`-`）
   - Secret `WEB_KEY`：网页门的钥匙，自己编一串长的；不填网页门就一直关着。拿到它就能看全部对话、改模型和人设，别截图别外发；怀疑漏了就在 Cloudflare 里换一个，网页门重新填一次
   - Secret `AELIOS_API_KEY`：跟你 Aelios 那边 `CHATBOX_API_KEY`、`IM_API_KEY`、`MEMORY_MCP_API_KEY` 任意一把同一个值。三把都读写 `default` 空间；想用别的空间（`AELIOS_NAMESPACE`）只能用 `CHATBOX_API_KEY`
   - 变量 `TG_BOT_USERNAME`：bot 的用户名（不带 @）
   - 变量 `TG_ALLOWED`：你的 Telegram 用户名，比如 `@your_name`（也可以填 chat id，逗号隔开）
   - 变量 `AELIOS_URL`：Aelios 的地址，比如 `https://companion-memory-proxy.xxx.workers.dev`
   - 可选 Secret `TAVILY_API_KEY`、`BRAVE_API_KEY`、`PERPLEXITY_API_KEY`：你自己的搜索 key，有几个填几个
4. **接上 Telegram**：浏览器打开一次 `https://aelios-resident.<你的子域>.workers.dev/tg/setup?secret=<TG_WEBHOOK_SECRET>`，两个 `"ok":true` 就接好了（顺便把三个命令登记到 bot 的菜单里）。
5. 打开 `https://aelios-resident.<你的子域>.workers.dev/`，填 `WEB_KEY` 进网页门，点左上角的模型名选模型，点右上角的铅笔把人设贴进去、保存。
6. 给 bot 发条消息。

## 设置

下面这些都在 Worker 的 Variables and Secrets 里按 Text 类型填，不填就用默认。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_GATEWAY_ID` | 空（用账户的 `default`） | Claude 这类厂商模型和搜索走哪个 AI Gateway |
| `TG_BOT_USERNAME` | 空 | bot 的用户名 |
| `TG_ALLOWED` | 空（谁都不回） | 允许的 chat id 和 @用户名 |
| `TIME_ZONE` | `Asia/Shanghai` | 消息前的时间、定时用哪个时区 |
| `DEBOUNCE_SECONDS` | `3` | 连发几条在这个秒数内算一轮 |
| `LETTER_IDLE_MINUTES` | `55`（`CACHE_TTL=5m` 时 `4`） | 你没动静多少分钟写交接信（定时找你那几轮不算，不往后推）；最多比缓存时长少 1 分钟，填多了也按这个算；`off` 只靠 `/handoff` |
| `KEEP_RECENT_TOKENS` | `6000` | 写信后最近多少 token 原样留着 |
| `CACHE_TTL` | `1h` | Claude 的缓存留多久，`1h` 或 `5m` |
| `AELIOS_URL` / `AELIOS_NAMESPACE` | 空 / `default` | 长期记忆；不填就不接 |
| `WEB_SEARCH` | `on` | `off` 关掉搜网；填 `ceramic`、`exa` 或 `linkup` 时，自己的 key 都失败后再用 Cloudflare 的 Web Search 这一家（没填自己的 key 时默认就是 `ceramic`）。Exa、Linkup、Ceramic 的 key 可以存在 AI Gateway → Provider Keys，别名 `default`，就不扣额度 |
| `WEB_FETCH` | `on` | `off` 关掉读网页 |
| `WEB_FETCH_MODEL` | `@cf/qwen/qwen3-30b-a3b-fp8` | 压长网页用的模型，主模型能填的 id 这里都能填（Workers AI 的 `@cf/…`，或 `anthropic/claude-haiku-5.5`、`openai/…` 这种走 AI Gateway 的）；`off` 不压，只截断 |
| `CHECKIN_SCHEDULE` | 空（不主动找） | `every day at 09:00`、`every weekday at 21:30`、`every 3 hours` 这类写法 |

## 花钱吗

- **Workers 免费档**：超出免费额度是报错，不扣钱。Durable Object 每天 10 万次请求，Workers AI 每天 1 万 neurons，UTC 0 点重置。闲着能休眠的 Durable Object 不算时长费。网页门开着时每 5 秒刷新一次，一小时大约 720 次请求，关掉页面或切到后台就停。
- **默认模型** `glm-4.7-flash`：免费档能用（DeepSeek v4、Kimi、GLM 5.3 这些在 Workers AI 上要付费账户）。按官方价目，每百万输入 token 5500 neurons、输出 36400 neurons，一万 neurons 大约够每天 80 到 200 轮，看对话多长（估算）。定时找你每次也算一轮。
- **搜网**：用你自己的 Tavily、Brave、Perplexity key 时按那几家自己的免费额度和价格算。没填自己的 key 时走 AI Gateway 的 Web Search，用 Gateway 额度按次付费，默认的 Ceramic.ai 是每 1000 次 0.25 美元（10-14 查的官方价），没有额度就报错。读网页：普通抓不收钱；靠浏览器的页面用 Cloudflare 浏览器渲染，Workers Paid 每月含 10 小时，超出每小时 0.09 美元（免费档每天 10 分钟），一页几秒；长页压缩默认走 Workers AI 的 Qwen3 30B，每百万 token 输入 0.051、输出 0.335 美元（10-14 查的官方价），一页大约千分之一美元；`WEB_FETCH_MODEL` 换成 Claude 之类的收费模型时，按那家的价格从 AI Gateway 额度里扣，一页最多 6 段、每段约 6000 token 进、1500 token 出。
- **Workers Paid（5 美元/月）**：超出包含额度才按量收，这个量级基本碰不到。
- **换 Claude**：走 AI Gateway，花的是 Gateway 的预付额度；Gateway 里存了你自己的 Anthropic key 时用那把。每轮带缓存标记，命中的部分按缓存价算（读是输入价的 1/10）；1 小时缓存写入是输入价的 2 倍（5 分钟的是 1.25 倍），换来的是停一会儿再聊、写交接信都还能读缓存。Cloudflare 这条路只收一整段文字的 system，AI SDK 发的是一组文字块，所以住户在发出去前把它们合成一段（`src/claude-run.ts`），缓存标记照带。Claude 的思考块签名绑着写下它时的系统提示、工具和前面每条消息，而住户会改这些（网页上换人设、开机包几小时刷新一次、交接信收掉旧聊天、部署了新规矩或新工具），旧思考块原样发回去就会报「bound to a different conversation」、之后每轮都失败；所以同一个文件里也把之前几轮的思考块拿掉，只回传这一轮工具调用之间的思考，回复本身都留着。用 Max 附带的 API key 时，人设里别出现「Claude Code」这几个字。

## 还没做

- 看图、听语音。
- 网页门逐字显示（现在是写完一整条再出现）。

## 网页用到的现成东西

都放在 `public/vendor/`，网页不用连外面的 CDN：

- [deep-chat](https://github.com/OvidijusParsiunas/deep-chat) 2.5.1，聊天界面，MIT（`deep-chat-LICENSE.txt`）
- [Alpine.js](https://github.com/alpinejs/alpine) 3.14.9，换模型和人设页，MIT（`alpine-LICENSE.txt`）

读网页的 HTML 转 Markdown 和网址检查是 [web-fetch](https://github.com/sakisakisa-design/web-fetch) 的原文件，长页压缩（`src/web/compress.ts`）照它的改，都是 MIT，在 `src/web/`（`web-fetch-LICENSE.txt`）。

换模型用的目录在 `public/models.json`，从 [Cloudflare 模型目录](https://developers.cloudflare.com/ai/models/)里挑的文字模型。Cloudflare 上了新模型想让它出现在列表里，跑一次 `node scripts/update-models.mjs` 再推上来；不跑也行，搜索框里直接填完整 id 照样能换。

## 本地测试

```sh
npm install
node test/mock-server.mjs &                                    # 假 Telegram 和假 Aelios，端口 9999
NO_PROXY=127.0.0.1 npx wrangler dev --config wrangler.test.jsonc --port 8787 &
NO_PROXY=127.0.0.1 node test/run.mjs main
```

`wrangler.test.jsonc` 用脚本模型（`FAKE_MODEL=true`），不需要登录 Cloudflare，也不花钱。定时和空闲交接信要另外起一次，见 `test/run.mjs` 开头的说明。读网页的测试 `node test/web.mjs` 和 `node test/claude-run.mjs` 不用起 Worker。

## 许可证

AGPL-3.0，和 [Aelios](https://github.com/wusaki0723/Aelios) 一样（`LICENSE`）：随便用、随便改；改过的版本拿去当网络服务给别人用，改动也要用同样的许可证公开。「网页用到的现成东西」那节列的文件各自保留 MIT 许可。
