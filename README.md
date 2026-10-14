# Aelios-resident：住在 Cloudflare 里的伴侣，Telegram 和网页两扇门

一个住在 Durable Object 里的聊天 agent（基于 Cloudflare 的 [Think](https://developers.cloudflare.com/agents/)），[Aelios](https://github.com/wusaki0723/Aelios) 当长期记忆。Telegram 和网页是同一段对话的两扇门；聊得太长时，它自己给之后的自己写一封交接信，把旧聊天收起来。

```
Telegram ──▶ Worker（验 secret、白名单、斜杠命令）──┐
网页门（public/，WEB_KEY）────────────▶ Worker /web/* ──┤
                                                     ▼
                         Resident（一个 Durable Object，一段对话）
            模型（网页上选）← 人设（网页上填）+ 聊天规矩 + Aelios 开机包；工具：memory_recall、web_search、web_fetch
            每轮记进 Aelios；超过 LETTER_AFTER_TOKENS 写交接信；到点可以主动找你
```

## 能做什么

- **Telegram**：私聊才回，不在 `TG_ALLOWED` 里的人一个字都不回。连发几条会等 `DEBOUNCE_SECONDS` 秒并成一轮。回复按空行拆成几条消息，写完一段发一段，中间显示「正在输入」。她每条消息前面带上当地时间（`TIME_ZONE`），模型知道现在几点。Telegram 重发同一条消息不会回两次。
- **网页门**：打开 Worker 的网址，填 `WEB_KEY` 进门。聊天界面用的是现成的 [deep-chat](https://github.com/OvidijusParsiunas/deep-chat)（MIT），星空配色，夜间/白天可切，手机上也好按。跟 Telegram 是同一段对话：两边说的话两边都看得到（网页每 5 秒刷新一次）；在网页上说的话只在网页上回。每条下面有时间、从哪边来的、心形按钮（存进 Aelios 的「珍贵」）。交接信折叠显示在它收起的位置。
- **模型**：点网页门左上角的模型名换。弹出来的是一个搜索框，不是几千项的下拉菜单：上面是正在用的、最近用过的、常用的（Claude 几个和默认的 GLM），往下是 Cloudflare 模型目录里全部文字模型（110 个，按厂商分组），输入 `opus`、`kimi`、`qwen` 就筛出来；目录里没有的，直接填完整 id 也能用。紫点是 Cloudflare 自己跑的（Workers AI），橙点走 AI Gateway 的额度。换之前先让它带着一句人设和缓存标记说一个字试试，调不通（写错、档位不含、没额度）就不换，当场告诉你原因。没选时用免费档能用的 `@cf/zai-org/glm-4.7-flash`。Claude 填 `anthropic/claude-opus-5.5` 这种（Cloudflare 的写法用点号），走 Anthropic 的 Messages 接口，每轮都带缓存标记，人设、规矩、开机包和之前的聊天下一轮从缓存读；`/status` 和人设页会显示上一次调用的缓存读了多少。以前填在 `MODEL` 变量里的模型，第一次用时自动搬过来，之后改 `MODEL` 不再起作用。
- **人设**：点右上角的铅笔填，保存后下一句就按新的说。存在 Durable Object 里，不在代码和 Secret 里，所以公开仓库也不会带出去。最近 10 版都留着，可以一键放回去；没填时用一句默认的，网页门顶上会提醒你去填。
- **Aelios 长期记忆**：她每发一条，回之前先拿这句去 Aelios 搜一下，最近没想起过的几条贴在这句后面给模型看，标成「想起的旧事」（自动浮现）；贴上的跟着那条留在记录里、以后不再改，所以缓存照样命中，网页、Telegram 和存回 Aelios 的都看不到它。另外有 `memory_recall` 工具，想不起来时自己查；每一轮都记进 Aelios（夜里 Dream 照常整理）；Aelios 的开机包（昨天的日记、珍贵原话、黑话表）放进系统提示，最多 6 小时取一次。
- **交接信**：对话超过 `LETTER_AFTER_TOKENS`，较早的部分由住户自己写成一封信（第一人称，写给之后的自己），最近 `KEEP_RECENT_TOKENS` 原样留着。信存在 Durable Object 里，也记进 Aelios；`SHOW_LETTER=true` 时会发到 Telegram 给你看。
- **主动找你**：`CHECKIN_SCHEDULE` 填了（比如 `every day at 09:00`），到点住户自己想想要不要找你；不合适打扰就不发。
- **查网页**（默认开）：`web_search` 搜网（Cloudflare 的 Web Search，按次收一点 AI Gateway 额度，见下）；`web_fetch` 把一个网页读成 Markdown，搜到的结果、你发的链接都能打开，本机和内网地址一律不读。读网页默认是住户自己读，HTML 用 [web-fetch](https://github.com/sakisakisa-design/web-fetch) 的转换器转；你部署了 web-fetch 的话，填 `WEB_FETCH_URL` 和 `WEB_FETCH_KEY` 就改走它，要靠浏览器才显示得出来的页面也能读，长页面只取跟问题有关的部分。
- **命令**：`/status` 看模型、人设、对话长度、交接信封数、上一次调用的缓存命中；`/letter` 看最近一封信；`/handoff` 马上写信。

## 测过什么

本地用假 Telegram、假 Aelios、脚本模型跑 `test/run.mjs`：

- 主流程 24 项全过：错 secret 拒绝；陌生人和群聊不回；两个气泡和时间戳；正在输入；重发去重；开机包进系统提示；`memory_recall` 打到 Aelios；`web_fetch` 走 web-fetch Worker、本机地址拒读；自动浮现（同一条记忆不重复浮现，之前浮现的原样留在那条后面，不存回 Aelios、网页上看不到）；每轮记进 Aelios；连发三条并成一轮；`/status`、`/letter`、`/handoff`（写信后对话里带着信）；网页门没钥匙进不去；网页看得到 Telegram 的对话和交接信；网页上说的话在网页回、不发到 Telegram；心形按钮存进珍贵；没填人设时用默认那句；网页上存了人设，下一条 Telegram 消息就按新人设回；人设超过 3 万字拒收；旧版本留着，存空的回到默认；每轮都带 Anthropic 缓存标记；模型在网页上换，写错或调不通的不换，换成功的记进「最近用过」。另外单独测了旧的 `MODEL` 变量会搬到网页设置里。
- 定时：每分钟一次的定时，第一次主动发了两个气泡并记进 Aelios，第二次模型回 SKIP，什么都没发。
- 自动交接信：把门槛调低连聊 8 轮，自己写了信、发到 Telegram、记进 Aelios。
- 回复写到一半把进程杀掉：重启后住户自己醒过来，发一句「刚才回到一半断了，再发一次好吗？」，不会把半截重发一遍。
- 网页门在 Chromium 里点过（手机宽度夜间、电脑宽度白天）：错钥匙提示、手机宽度没有横向滚动、发消息收到回复（自己那条也带上时间和心形）、心形按钮、Telegram 那边发的消息 5 秒内自己出现且不重复、交接信折叠；换模型：搜 `opus` 只出 opus、调不通的不换并显示原因、目录里没有的 id 可以直接试、方向键和回车能选、Esc 关掉；人设：没填时的提醒、写了「Claude Code」会提示、保存后提醒消失。

没测过：真的模型、真的 Telegram、部署到线上（免费档的 CPU 和启动时间只在线上能验）。

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
| `LETTER_AFTER_TOKENS` | `24000` | 对话超过多少 token 写交接信 |
| `KEEP_RECENT_TOKENS` | `6000` | 写信后最近多少 token 原样留着 |
| `SHOW_LETTER` | `true` | 写了信发到 Telegram 给你看 |
| `AELIOS_URL` / `AELIOS_NAMESPACE` | 空 / `default` | 长期记忆；不填就不接 |
| `WEB_SEARCH` | `on` | `off` 关掉搜网 |
| `WEB_FETCH` | `on` | `off` 关掉读网页 |
| `WEB_FETCH_URL` | 空（住户自己读） | 你的 web-fetch Worker 地址，如 `https://web-fetch.<你的子域>.workers.dev`；还要配 Secret `WEB_FETCH_KEY`（它的 `API_KEYS` 里的一把） |
| `CHECKIN_SCHEDULE` | 空（不主动找） | `every day at 09:00`、`every weekday at 21:30`、`every 3 hours` 这类写法 |

## 花钱吗

- **Workers 免费档**：超出免费额度是报错，不扣钱。Durable Object 每天 10 万次请求，Workers AI 每天 1 万 neurons，UTC 0 点重置。闲着能休眠的 Durable Object 不算时长费。网页门开着时每 5 秒刷新一次，一小时大约 720 次请求，关掉页面或切到后台就停。
- **默认模型** `glm-4.7-flash`：免费档能用（DeepSeek v4、Kimi、GLM 5.3 这些在 Workers AI 上要付费账户）。按官方价目，每百万输入 token 5500 neurons、输出 36400 neurons，一万 neurons 大约够每天 80 到 200 轮，看对话多长（估算）。定时找你每次也算一轮。
- **搜网**：走 AI Gateway 的 Web Search，用 Gateway 额度按次付费，默认的 Ceramic.ai 是每 1000 次 0.25 美元（10-14 查的官方价），没有额度就报错。读网页住户自己读不收钱；走 web-fetch 的话按那边的配置算（它压缩长页面会调模型）。
- **Workers Paid（5 美元/月）**：超出包含额度才按量收，这个量级基本碰不到。
- **换 Claude**：走 AI Gateway，花的是 Gateway 的预付额度；Gateway 里存了你自己的 Anthropic key 时用那把。每轮带缓存标记，命中的部分按缓存价算。Cloudflare 这条路只收一整段文字的 system，AI SDK 发的是一组文字块，所以住户在发出去前把它们合成一段（`src/claude-run.ts`），缓存标记照带。用 Max 附带的 API key 时，人设里别出现「Claude Code」这几个字。

## 还没做

- 看图、听语音。
- 网页门逐字显示（现在是写完一整条再出现）。

## 网页用到的现成东西

都放在 `public/vendor/`，网页不用连外面的 CDN：

- [deep-chat](https://github.com/OvidijusParsiunas/deep-chat) 2.5.1，聊天界面，MIT（`deep-chat-LICENSE.txt`）
- [Alpine.js](https://github.com/alpinejs/alpine) 3.14.9，换模型和人设页，MIT（`alpine-LICENSE.txt`）

读网页的 HTML 转 Markdown 和网址检查是 [web-fetch](https://github.com/sakisakisa-design/web-fetch) 的原文件，MIT，在 `src/web/`。

换模型用的目录在 `public/models.json`，从 [Cloudflare 模型目录](https://developers.cloudflare.com/ai/models/)里挑的文字模型。Cloudflare 上了新模型想让它出现在列表里，跑一次 `node scripts/update-models.mjs` 再推上来；不跑也行，搜索框里直接填完整 id 照样能换。

## 本地测试

```sh
npm install
node test/mock-server.mjs &                                    # 假 Telegram 和假 Aelios，端口 9999
NO_PROXY=127.0.0.1 npx wrangler dev --config wrangler.test.jsonc --port 8787 &
NO_PROXY=127.0.0.1 node test/run.mjs main
```

`wrangler.test.jsonc` 用脚本模型（`FAKE_MODEL=true`），不需要登录 Cloudflare，也不花钱。定时和自动交接信要另外起一次，见 `test/run.mjs` 开头的说明。
