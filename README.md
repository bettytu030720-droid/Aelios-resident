# Aelios-resident：住在 Cloudflare 里的伴侣，Telegram 和网页两扇门

一个住在 Durable Object 里的聊天 agent（基于 Cloudflare 的 [Think](https://developers.cloudflare.com/agents/)），[Aelios](https://github.com/wusaki0723/Aelios) 当长期记忆。Telegram 和网页是同一段对话的两扇门；聊得太长时，它自己给之后的自己写一封交接信，把旧聊天收起来。

```
Telegram ──▶ Worker（验 secret、白名单、斜杠命令）──┐
网页门（public/index.html，WEB_KEY）──▶ Worker /web/* ──┤
                                                     ▼
                         Resident（一个 Durable Object，一段对话）
            模型 ← 人设（网页门里填）+ 聊天规矩 + Aelios 开机包；工具：memory_recall、可选查网页
            每轮记进 Aelios；超过 LETTER_AFTER_TOKENS 写交接信；到点可以主动找你
```

## 能做什么

- **Telegram**：私聊才回，不在 `TG_ALLOWED` 里的人一个字都不回。连发几条会等 `DEBOUNCE_SECONDS` 秒并成一轮。回复按空行拆成几条消息，写完一段发一段，中间显示「正在输入」。她每条消息前面带上当地时间（`TIME_ZONE`），模型知道现在几点。Telegram 重发同一条消息不会回两次。
- **网页门**：打开 Worker 的网址，填 `WEB_KEY` 进门。样子照 Aelios admin 的星空配色，左右气泡，夜间/白天可切。跟 Telegram 是同一段对话：两边说的话两边都看得到（网页每 5 秒刷新一次）；在网页上说的话只在网页上回。每条旁边的心形按钮把这句存进 Aelios 的「珍贵」。交接信折叠显示在它收起的位置。
- **人设**：在网页门右上角的人形按钮里填，保存后下一句就按新的说。存在 Durable Object 里，不在代码和 Secret 里，所以公开仓库也不会带出去。最近 10 版都留着，可以一键放回去；没填时用一句默认的，网页门顶上会提醒你去填。
- **Aelios 长期记忆**：`memory_recall` 工具查记忆；每一轮都记进 Aelios（夜里 Dream 照常整理）；Aelios 的开机包（昨天的日记、珍贵原话、黑话表）放进系统提示，最多 6 小时取一次。
- **交接信**：对话超过 `LETTER_AFTER_TOKENS`，较早的部分由住户自己写成一封信（第一人称，写给之后的自己），最近 `KEEP_RECENT_TOKENS` 原样留着。信存在 Durable Object 里，也记进 Aelios；`SHOW_LETTER=true` 时会发到 Telegram 给你看。
- **主动找你**：`CHECKIN_SCHEDULE` 填了（比如 `every day at 09:00`），到点住户自己想想要不要找你；不合适打扰就不发。
- **查网页**（默认关）：`WEB_SEARCH=on` 给模型一个搜索工具（按次收 AI Gateway 额度，见下）；`FETCH_ALLOWLIST` 填几个网站，模型可以免费读这些网站的页面。
- **命令**：`/status` 看模型、人设、对话长度、交接信封数；`/letter` 看最近一封信；`/handoff` 马上写信。

## 测过什么

本地用假 Telegram、假 Aelios、脚本模型跑 `test/run.mjs`：

- 主流程 20 项全过：错 secret 拒绝；陌生人和群聊不回；两个气泡和时间戳；正在输入；重发去重；开机包进系统提示；`memory_recall` 打到 Aelios；每轮记进 Aelios；连发三条并成一轮；`/status`、`/letter`、`/handoff`（写信后对话里带着信）；网页门没钥匙进不去；网页看得到 Telegram 的对话和交接信；网页上说的话在网页回、不发到 Telegram；心形按钮存进珍贵；没填人设时用默认那句；网页上存了人设，下一条 Telegram 消息就按新人设回；人设超过 3 万字拒收；旧版本留着，存空的回到默认。
- 定时：每分钟一次的定时，第一次主动发了两个气泡并记进 Aelios，第二次模型回 SKIP，什么都没发。
- 自动交接信：把门槛调低连聊 8 轮，自己写了信、发到 Telegram、记进 Aelios。
- 回复写到一半把进程杀掉：重启后住户自己醒过来，发一句「刚才回到一半断了，再发一次好吗？」，不会把半截重发一遍。
- 网页门在 Chromium 里点过：错钥匙提示、手机宽度没有横向滚动、发消息收到回复、心形按钮；人设面板：没填时的提醒、写了「Claude Code」会提示、保存后网页上问「你是谁」按新人设回、旧版本放回去、没保存就返回会问一句。

没测过：真的模型、真的 Telegram、部署到线上（免费档的 CPU 和启动时间只在线上能验）。

## 上线

1. **建 bot**：Telegram 里找 @BotFather，`/newbot`，起名字，记下 token 和 bot 的用户名。
2. **部署**：Cloudflare 后台 → Workers & Pages → Create → Import a repository，选这个仓库。项目名填 `aelios-resident`（要跟 `wrangler.jsonc` 里的 `name` 一样），其余用默认（部署命令 `npx wrangler deploy`）。以后推到 main 就自动更新。不用建 D1、KV 或别的库：聊天记录、交接信、人设存在 Durable Object 自带的 SQLite 里，部署时自动建好；长期记忆走你现有的 Aelios。
3. **填密钥和设置**（Worker → Settings → Variables and Secrets）。`wrangler.jsonc` 里故意一个变量都不写，所以这里填的东西以后推代码不会被冲掉：
   - Secret `TG_BOT_TOKEN`：第 1 步的 token
   - Secret `TG_WEBHOOK_SECRET`：自己编一串长的（字母、数字、`_`、`-`）
   - Secret `WEB_KEY`：网页门的钥匙，自己编；不填网页门就一直关着
   - Secret `AELIOS_API_KEY`：跟你 Aelios 那边 `CHATBOX_API_KEY`、`IM_API_KEY`、`MEMORY_MCP_API_KEY` 任意一把同一个值。三把都读写 `default` 空间；想用别的空间（`AELIOS_NAMESPACE`）只能用 `CHATBOX_API_KEY`
   - 变量 `TG_BOT_USERNAME`：bot 的用户名（不带 @）
   - 变量 `TG_ALLOWED`：你的 Telegram 用户名，比如 `@your_name`（也可以填 chat id，逗号隔开）
   - 变量 `AELIOS_URL`：Aelios 的地址，比如 `https://companion-memory-proxy.xxx.workers.dev`
4. **接上 Telegram**：浏览器打开一次 `https://aelios-resident.<你的子域>.workers.dev/tg/setup?secret=<TG_WEBHOOK_SECRET>`，两个 `"ok":true` 就接好了（顺便把三个命令登记到 bot 的菜单里）。
5. 打开 `https://aelios-resident.<你的子域>.workers.dev/`，填 `WEB_KEY` 进网页门，点右上角的人形按钮把人设贴进去、保存。
6. 给 bot 发条消息。

## 设置

下面这些都在 Worker 的 Variables and Secrets 里按 Text 类型填，不填就用默认。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MODEL` | `@cf/zai-org/glm-4.7-flash` | Workers AI 的 id，或 AI Gateway 上的厂商模型（如 `anthropic/claude-sonnet-5-5`）。改了以后现有对话也跟着换 |
| `AI_GATEWAY_ID` | 空（用账户的 `default`） | 厂商模型和搜索走哪个 AI Gateway |
| `TG_BOT_USERNAME` | 空 | bot 的用户名 |
| `TG_ALLOWED` | 空（谁都不回） | 允许的 chat id 和 @用户名 |
| `TIME_ZONE` | `Asia/Shanghai` | 消息前的时间、定时用哪个时区 |
| `DEBOUNCE_SECONDS` | `3` | 连发几条在这个秒数内算一轮 |
| `LETTER_AFTER_TOKENS` | `24000` | 对话超过多少 token 写交接信 |
| `KEEP_RECENT_TOKENS` | `6000` | 写信后最近多少 token 原样留着 |
| `SHOW_LETTER` | `true` | 写了信发到 Telegram 给你看 |
| `AELIOS_URL` / `AELIOS_NAMESPACE` | 空 / `default` | 长期记忆；不填就不接 |
| `WEB_SEARCH` | `off` | `on` 打开搜索工具 |
| `FETCH_ALLOWLIST` | 空 | 模型可以读的网站，逗号隔开，如 `https://www.bbc.com/zhongwen/**` |
| `CHECKIN_SCHEDULE` | 空（不主动找） | `every day at 09:00`、`every weekday at 21:30`、`every 3 hours` 这类写法 |

## 花钱吗

- **Workers 免费档**：超出免费额度是报错，不扣钱。Durable Object 每天 10 万次请求，Workers AI 每天 1 万 neurons，UTC 0 点重置。闲着能休眠的 Durable Object 不算时长费。网页门开着时每 5 秒刷新一次，一小时大约 720 次请求，关掉页面或切到后台就停。
- **默认模型** `glm-4.7-flash`：免费档能用（DeepSeek v4、Kimi、GLM 5.3 这些在 Workers AI 上要付费账户）。按官方价目，每百万输入 token 5500 neurons、输出 36400 neurons，一万 neurons 大约够每天 80 到 200 轮，看对话多长（估算）。定时找你每次也算一轮。
- **搜索**（`WEB_SEARCH=on`）：走 AI Gateway 的 Web Search，默认用 Gateway 额度按次付费，没有额度就报错。`FETCH_ALLOWLIST` 读指定网站不收钱。
- **Workers Paid（5 美元/月）**：超出包含额度才按量收，这个量级基本碰不到。
- **换 Claude**：走 AI Gateway，花的是你在 Gateway 里配的 Anthropic key 或 Gateway 预付额度。用 Max 附带的 API key 时，人设里别出现「Claude Code」这几个字。

## 还没做

- 看图、听语音。
- 网页门逐字显示（现在是写完一整条再出现）。

## 本地测试

```sh
npm install
node test/mock-server.mjs &                                    # 假 Telegram 和假 Aelios，端口 9999
NO_PROXY=127.0.0.1 npx wrangler dev --config wrangler.test.jsonc --port 8787 &
NO_PROXY=127.0.0.1 node test/run.mjs main
```

`wrangler.test.jsonc` 用脚本模型（`MODEL=fake`），不需要登录 Cloudflare，也不花钱。定时和自动交接信要另外起一次，见 `test/run.mjs` 开头的说明。
