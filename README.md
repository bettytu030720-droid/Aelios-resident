# Aelios-resident：住在 Cloudflare 里的伴侣，Telegram 和网页两扇门

一个住在 Durable Object 里的聊天 agent（基于 Cloudflare 的 [Think](https://developers.cloudflare.com/agents/)），[Aelios](https://github.com/wusaki0723/Aelios) 当长期记忆。Telegram 和网页是同一段对话的两扇门；你停下来一阵（默认 55 分钟），它趁对话还在缓存里给之后的自己写一封交接信，把旧聊天收起来。

```
Telegram ──▶ Worker（验 secret、白名单、斜杠命令）──┐
网页门（public/，WEB_KEY）────────────▶ Worker /web/* ──┤
                                                     ▼
                         Resident（一个 Durable Object，一段对话）
            模型（网页上选）← 人设（网页上填）+ 聊天规矩 + Aelios 开机包；工具：Aelios 记忆 6 个、web_search、web_fetch、发表情和画表情、接上的别的 MCP
            接了 Aelios 时聊天从 Aelios 过（它想起旧事、它记）；没动静 55 分钟写交接信；到点可以主动找你
```

## 能做什么

- **Telegram**：私聊才回，不在 `TG_ALLOWED` 里的人一个字都不回。连发几条会等 `DEBOUNCE_SECONDS` 秒并成一轮。回复按空行拆成几条消息，写完一段发一段，中间显示「正在输入」。你每条消息前面带上当地时间（`TIME_ZONE`），模型知道现在几点。Telegram 重发同一条消息不会回两次。发图片（照片，或者当文件发的图）模型看得到：Think 本来只把附件写成一行文字，住户收到后从 Telegram 下载下来放进你那条消息（`src/pictures.ts`），配的文字照常；超过 5 MB 或下载失败的还是一行文字。超过 32 KB 的图按 Think 默认的做法，过几轮会从对话里拿掉、留一行标记，免得每轮都重读；网页上显示成「[图片]」。网页门暂时不能发图。
- **网页门**：打开 Worker 的网址，填 `WEB_KEY` 进门。聊天界面用的是现成的 [deep-chat](https://github.com/OvidijusParsiunas/deep-chat)（MIT），星空配色，夜间/白天可切，手机上也好按。跟 Telegram 是同一段对话：两边说的话两边都看得到（网页每 5 秒刷新一次）；在网页上说的话只在网页上回。每条下面有时间、从哪边来的、心形按钮（存进 Aelios 的「珍贵」）。交接信折叠显示在它收起的位置。模型返回的思考默认收在「想了一下」里，工具调用默认收在「忙活了 X 回」里，点开看工具名、参数和结果；X 按工具调用次数计，同一个调用的返回不重复计数。模型未返回思考时不凭空生成。网页发消息等待回复时约每 0.9 秒同步一次进行中的思考、工具和回复文字；Telegram 那边的进度随网页原有的 5 秒刷新同步。
- **模型**：点网页门左上角的模型名换。弹出来的是一个搜索框，不是几千项的下拉菜单：上面是正在用的、最近用过的、常用的（Claude 几个和默认的 GLM），往下是 Cloudflare 模型目录里全部文字模型（110 个，按厂商分组），输入 `opus`、`kimi`、`qwen` 就筛出来；目录里没有的，直接填完整 id 也能用。紫点是 Cloudflare 自己跑的（Workers AI），橙点走 AI Gateway 的额度。换之前先让它带着一句人设和缓存标记说一个字试试，调不通（写错、档位不含、没额度）就不换，当场告诉你原因。没选时用免费档能用的 `@cf/zai-org/glm-4.7-flash`。接了 Aelios 时，选的模型都从 Aelios 过（见下面「Aelios 长期记忆」），用 Aelios 那边配好的供应商和 key，选单上标「从 Aelios 过」；Aelios 说这个模型不在住户那个身份的主模型里（从它那儿过也不记）时，也不换。Claude 填 `anthropic/claude-opus-5.5` 这种（Cloudflare 的写法用点号），走 Anthropic 的 Messages 接口，每轮都带缓存标记，人设、规矩、开机包和之前的聊天下一轮从缓存读，缓存默认留 1 小时（`CACHE_TTL`）；Opus、Sonnet、Haiku 5 以后的 Claude 每轮都会想，但默认把想的内容藏起来，住户请它返回一份摘要（`display: summarized`，不多花钱），网页上收在「想了一下」里；想多久在设置页的「思考」里调（`THINKING_EFFORT`）；`/status` 和人设页会显示上一次调用的缓存读了多少。以前填在 `MODEL` 变量里的模型，第一次用时自动搬过来，之后改 `MODEL` 不再起作用。
- **自己的 key、自己的供应商**：接了 Aelios 就在 Aelios 后台配，住户这边不用管。下面说的是没接 Aelios 的时候。Claude（`anthropic/…`）默认花 Cloudflare 的统一计费额度。想用自己的 Anthropic key，不用改任何东西：在住户用的那个 AI Gateway（`AI_GATEWAY_ID`，没填就是 `default`）→ Provider Keys 里存一把 Anthropic 的 key，别名留 `default`，之后 `anthropic/…` 就用这把，不再走统一计费（Cloudflare 的规矩：请求里没带厂商 key 时先用 Gateway 里别名 `default` 的那把，没有才走统一计费）。要接中转、OpenRouter、Nous 这类别家，在设置页填那家的地址（`CUSTOM_BASE_URL`，写到 `/v1` 为止）和 key（`CUSTOM_API_KEY`），模型填 `custom/` 加那家自己的模型名，比如 `custom/anthropic/claude-sonnet-5.5`。默认按 OpenAI 的 chat completions 格式调；那家说的是 Anthropic 的 Messages 格式（Anthropic 自己 `https://api.anthropic.com/v1`，或者支持 Messages 的中转）就把格式（`CUSTOM_FORMAT`）选 `anthropic`，这样缓存标记照带、之前几轮的思考块照样拿掉（`src/custom.ts`）。这条路从 Worker 直接打过去，不经过 AI Gateway，所以 Gateway 的日志里看不到。AI Gateway 后台建的「自定义供应商」（`custom-xxx/…`）Cloudflare 的模型目录不认，住户用不了，直接填那家的地址就行。网页选单里这种模型的圆点是空心的。
- **设置页**：点右上角的齿轮。Aelios 的地址和 key、谁能在 Telegram 上跟它说话、时区、主动找你的时间、交接信和缓存、自己的供应商、搜网和读网页，都在这里改，下一句就生效，不用再去 Cloudflare 后台填变量。这里存的优先；空着的用 Cloudflare 里同名的变量（以前填的照样有效），那边也没有就用默认。key 只能填、不能看，页面上只显示「已填」。主动找你的时间和时区存的时候当场排一次，排不上就不存。只有 `TG_BOT_TOKEN`、`TG_WEBHOOK_SECRET`、`WEB_KEY` 还得在 Cloudflare 里填：没有它们 Telegram 接不上、网页门进不去。锁上网页门的按钮在这页最下面。
- **人设**：点右上角的铅笔填，保存后下一句就按新的说。存在 Durable Object 里，不在代码和 Secret 里，所以公开仓库也不会带出去。最近 10 版都留着，可以一键放回去；没填时用一句默认的，网页门顶上会提醒你去填。
- **Aelios 长期记忆**：聊天从 Aelios 自己的模型接口过（`https://<Aelios>/<身份>/v1`，跟别的聊天软件接 Aelios 一样，`src/via-aelios.ts`）：Aelios 拿你这句想起相关的旧事、贴在这句后面给模型看，再把这一轮记下来（夜里 Dream 照常整理），住户自己不再搜、不再记。`anthropic/…` 和名字里带 claude 的都走 Messages 接口（`anthropic/claude-opus-5.5` 这种 Cloudflare 的点号写法，发给 Anthropic 本家时自动换成 `claude-opus-5-5`；别家中转的名字原样发），Aelios 把缓存标记放在你那句上、想起的旧事贴在标记后面，所以之前的聊天照样从缓存读；想起的旧事只在那一轮看得见，下一轮不再带着。要在 Aelios 后台给住户建一个身份，把要用的模型放进它的主模型，再在设置页填上这个身份名（不填用这把 key 的第一个身份）。用的模型不在主模型里时 Aelios 只转发、不想也不记，网页门顶上和 `/status` 会提醒。交接信、定时找你、换模型时的试调这些不是你说的话，带上 `x-aelios-purpose: auxiliary`，Aelios 不替它们想、也不当成你说的记下来；交接信和定时找你发出的话由住户自己记进 Aelios。另外给模型 6 个记忆工具：`memory_recall` 查、`memory_remember` 记一句（能改旧的）、`memory_keep_moment` 存珍贵瞬间、`memory_forget` 归档（Aelios 里能找回）、`memory_learn_word` 记黑话、`memory_read_diary` 翻日记；除了查，都走 Aelios 自己的 MCP，但描述是住户这边写的短句，7 个工具（含 `web_fetch`）的说明加起来约 2500 字符，每轮少占 token；Aelios 的开机包（昨天的日记、珍贵原话、黑话表）放进系统提示，最多 6 小时取一次。搜过网的那一轮回完以后，住户用压缩网页的模型（`WEB_FETCH_MODEL`）把你的问题、搜到的和回答过一遍，挑出最多 3 条过几个月还对的知识（是什么、怎么做、在哪，不要天气、新闻、价格这类会变的，也不要你们俩的事），每条一句话、带日期和来源，用 Aelios 的 remember 存成世界知识，键是 `world:…`，再搜同一件事就新版本顶掉旧的（`src/web/learn.ts`）；下次聊到时它跟别的记忆一起被想起来，不用再搜。`WEB_LEARN=off` 关掉。
- **交接信**：没有长度上限。你 `LETTER_IDLE_MINUTES`（默认 55）分钟没动静，住户就给之后的自己写一封信，较早的聊天收进信里，最近 `KEEP_RECENT_TOKENS` 原样留着（中文一个字算约 1 token）；聊得还不多、全在这段里时没有旧的可收，就不写，也不调模型，`/status` 的「对话」一行能看到现在带着多少。写完就不动了，等你下次发消息。这 55 分钟是 Durable Object 的定时（alarm），部署、Worker 睡着都不丢，不用另外接 Queue。55 分钟是为了赶在 1 小时缓存过期前：写信那一轮就接在原对话后面问（系统提示、工具、之前每条消息都和上一轮一字不差），所以整段对话从缓存读，便宜；写完把这一问一答撤掉。信照七段写（对方怎么样、我们之间发生了什么、做了什么事、现在的温度、想做的事、喜欢的事、未完成的事），上一封里还没了结的要接着往下传，有时效的写死日期。信存在 Durable Object 里，也记进 Aelios，不发 Telegram 打扰你；`/letter` 看，`/handoff` 随时手动写。
- **提示词**：住户自带的聊天规矩、交接信和定时提示都是英文写的，不预设对方是谁、什么性别，称呼用人设和聊天里的；人设用什么语言，它就用什么语言聊。
- **主动找你**：设置页里「主动找你」填了（`CHECKIN_SCHEDULE`，比如 `every day at 09:00`），到点住户自己想想要不要找你；不合适打扰就不发。
- **查网页**（默认开）：`web_search` 搜网。在设置页填了自己的搜索 key（Tavily、Brave、Perplexity，有几个填几个）就按 Tavily → Brave → Perplexity 的顺序用，前一家报错或免费额度用完就换下一家，不花 Gateway 的钱；一个都没填时用 Cloudflare 的 Web Search（按次收一点 AI Gateway 额度，见下）。`web_fetch` 把一个网页读成 Markdown，搜到的结果、你发的链接都能打开，照 [web-fetch](https://github.com/sakisakisa-design/web-fetch) 的做法长在住户里，不用另外部署：先普通地抓，每一次跳转都先查目的地再跟过去，本机和内网地址一律不读；抓回来几乎是空的（靠 JavaScript 才显示的页面）就交给 Cloudflare 的浏览器（`BROWSER` 绑定，不加载图片字体；浏览器跑在 Cloudflare 的机器上，网址里写明的本机和内网 IP 在浏览器里也拦掉，最后落到哪儿再查一遍，但解析到内网的域名只在最后这一查里拦得住）；读过的页面在住户自己的存储里留 1 小时，再问同一页不用重抓；长页面先用一个便宜的模型压一遍（`WEB_FETCH_MODEL`，默认 Workers AI 的 Qwen3 30B；填法和网页上换主模型一样，`@cf/` 开头的在 Cloudflare 上跑，别的接了 Aelios 就从 Aelios 过、标成不是你说的话，没接就走 AI Gateway），带了问题就只摘跟问题有关的段落，这样一页新闻不会占掉一大截聊天记录。GBK 之类的老编码也认。
- **接别的 MCP**：设置页「别的 MCP」填服务地址（https），它的工具从下一句起加进每一轮，名字是 `mcp_<服务>_<工具>`。要登录的（OAuth）点「去授权」，授权完回到住户的 `/mcp/callback`；要 key 的把 key 填在那里，只能填不能看，默认当 `Authorization: Bearer` 发，写成 `x-api-key: 你的key` 这种就放进那个头。也可以在聊天里跟它说「接上 https://…」「断开 …」，它用 `connect_mcp_server` / `disconnect_mcp_server` 自己接，要登录的会把授权链接发给你；key 和地址里带 key 的（比如 `?api_key=…`）不要在聊天里发（聊天会记进 Aelios），这种只在设置页接；报错里的地址只留到域名，免得把地址里的 key 带进聊天。已经接过的再说一次「接上」或在设置页点「重连」，是原地再连一次，key 和登录都留着。只认你自己开口的那一轮：这一轮里读过网页、搜过网或者调过别的 MCP 工具，它就不接，免得网页上一句「接上 …」替你做主。每个工具的说明每轮都要带上，所以说明只留第一段、最多 300 字，参数说明 120 字，结果最长 6000 字；最多接 8 个、一轮最多带 40 个工具。连接用的是 Think 自带的 MCP 客户端（agents SDK），存在 Durable Object 里，休眠、重启后自己接回来。代码在 `src/mcp-servers.ts`。
- **表情包**：设置页「表情包」里导入，它聊天时偶尔发一张（`send_sticker`）：一次回复最多一张，你难过或说正事时不发，可以跟在话后面，也可以只发一张当整个回复。导入两种：Telegram 的贴纸包贴链接（`t.me/addstickers/…`），或者传一个 zip、贴 zip 的 https 网址（格式见下面「表情包格式」；网址跟 `web_fetch` 一样，本机和内网地址不读，每次跳转都先查）。它也能自己画（`make_sticker`）：像素画，最多 8 帧的小动画，自动描白边，存进自己的包「mine」，以后还能再发；同一个名字再画一次就是重画。Telegram 上：zip 里带了 Telegram 贴纸文件（WebM、WebP、TGS）的当真贴纸发，透明底；没带的 GIF 当动图发、静态图当照片发，Telegram 会把 GIF 转成视频，透明底变成浅灰底，它自己画的也是这样。同一张第一次上传，之后用 Telegram 给的 file_id 发，不再传。网页上表情显示在那条回复下面，透明底；网页上说的话不往 Telegram 发表情。设置页能开关整个功能（`STICKERS`，关了不发也不画）、单独开关每个包、删包、删单张、改每张的「什么时候用」。开着的包里每张的名字、emoji 和「什么时候用」每轮都带给模型（每个包旁边写着约多少 token），所以最多带 200 张，最多 20 个包。代码在 `src/stickers.ts`、`src/sticker-store.ts`、`src/gif.ts`。
- **命令**：`/status` 看模型、人设、对话长度、交接信封数、上一次调用的缓存命中、表情包开没开和有几张；`/letter` 看最近一封信；`/handoff` 马上写信。

## 测过什么

本地用假 Telegram、假 Aelios、脚本模型跑 `test/run.mjs`：

- 主流程 30 项全过：错 secret 拒绝；陌生人和群聊不回；两个气泡和时间戳；正在输入；重发去重；开机包进系统提示；`memory_recall` 打到 Aelios；`memory_remember` 走 Aelios 的 MCP；`web_fetch` 本机地址拒读；连发三条并成一轮；发的照片模型收到的是图（下载不了的还是一行附件说明），网页上显示「[图片]」；`/status`、`/letter`、`/handoff`（写信后对话里带着信；写信那一轮发给模型的前文和上一轮一字不差，所以吃得到缓存）；网页门没钥匙进不去；网页看得到 Telegram 的对话和交接信；网页上说的话在网页回、不发到 Telegram；心形按钮存进珍贵；没填人设时用默认那句；网页上存了人设，下一条 Telegram 消息就按新人设回；人设超过 3 万字拒收；旧版本留着，存空的回到默认；每轮都带 Anthropic 缓存标记（1 小时）；模型在网页上换，写错或调不通的不换，换成功的记进「最近用过」；接了 Aelios 时聊天从 Aelios 过（`anthropic/…` 走 Messages、带 Aelios 的 key 和缓存标记，之前几轮的思考块不发回去，住户自己不搜也不记），试调和交接信那一轮标成不是她说的，Aelios 说不是主模型的不换，换上之后才被拿出主模型的，网页和 `/status` 会说「没记下来」，`@cf/…` 换成 `workers-ai/@cf/…` 走 chat completions；设置页：key 不出现在页面上，时区、数字、选项、网址、排不上的定时都不收，填了身份下一句就以这个身份过，`TG_ALLOWED` 改成别人后她的消息不回、清掉又回，页面上存的 Aelios key 优先于 Worker 里的。另外单独测了旧的 `MODEL` 变量会搬到网页设置里。
- 定时：每分钟一次的定时，第一次主动发了两个气泡并记进 Aelios，第二次模型回 SKIP，什么都没发。
- 空闲交接信：把空闲时间调成 3 秒，聊 3 轮后自己写了信：没发 Telegram、记进 Aelios、网页上看得到信、写信的那一问一答撤掉了、前文和上一轮一字不差；之后再说一句会再写一封，不说话就不再写。
- 没接 Aelios 时自己的供应商（`--var AELIOS_URL:`，`node test/run.mjs custom`）：OpenAI 格式先试调再换上，带着 key 回话；在设置页把格式改成 `anthropic`，下一句就走 Messages：带着 key、每轮有缓存标记，第二轮发回去的第一轮回复留着字、没有思考块。
- 从 Aelios 过的那几条规矩（`node test/via-aelios.mjs`）5 项：模型名怎么改写、哪个走 Messages；身份怎么放进地址；她说的话是她的，定时和交接信那一轮（包括里面调了工具之后的请求）标成不是她说的，旧的中文提示也认。
- 发给 Claude 前的整理（`node test/claude-run.mjs`）4 项：system 合成一段；之前几轮的思考块拿掉、回复和工具调用留着、这一轮工具之间的思考留着、只有思考的那条整条去掉；第一轮和没思考块的原样发；别家模型不动。另外用真的 AI SDK 和 Cloudflare provider 核过：不整理时历史里的思考块会带着签名发出去，整理后没有。
- 交接信收哪些聊天（`node test/fold.mjs`）9 项：中文一个字算 1 token、全角标点也算，思考不算，图片和工具调用、结果算；留最近 6000 token，从她的那条开始留，她连发的几条和回复不拆开；聊得少时不写信、不调模型；更早的信不再收一遍；写出来是空的就不收。
- 读网页（`node test/web.mjs`，不用起 Worker，网络全是假的）17 项：跳转先查再跟；跳到本机或内网（包括域名解析到内网）不跟；无限跳转会停；本机地址直接拒；JavaScript 空壳交给浏览器且不加载图片、浏览器里也拦内网 IP；没有浏览器时原样返回；404 和图片不送浏览器；读过的页面再问不重抓、同一页同一个问题连压缩结果也不重算；模型回 NOTHING_RELEVANT 的段落丢掉、只是提到这个词的留着；带问题的长页只留摘出来的部分（Qwen3 带 `/no_think`）；换成 Claude 之类的别家模型也能压、不带 `/no_think`；短页不送模型；回答里的 think 块去掉；模型挂了原样返回；工具超时会把模型调用一起取消；GBK 页面（GBK 在本地 workerd 里也核过能解）。
- 别的 MCP（`node test/run.mjs mcp`，再 `mcp-2`）10 项 + 重启 1 项：设置页接一个不用 key 的，数出 2 个工具；模型拿到的说明截短了、叫 `title` 的参数还在；调一次读到结果；要 key 的不填接不上、也不留着，填了能用，key 不往回发；接不上的报错不留；要登录的给出授权链接，假的授权服务跳回 `/mcp/callback`，页面写「接好了」、换到 token、之后的请求带着它；聊天里说「接上」接上了；先读了网页再接的被拒；`/status` 列出来；聊天里断开、设置页断开；重启后不用重连就在，登录过的那个带着存下的 token 调得通。`node test/mcp-servers.mjs` 12 项测地址检查、名字、key 放哪个头、截短、工具名不撞、结果转文字、顺序固定、授权页转义。
- 表情包（`node test/run.mjs stickers`）11 项：设置页传 zip 导入（没钥匙不收，不是 zip 的报错）；表情图只凭长长的随机 key 就能取，乱填的 404；贴 Telegram 贴纸包链接导入，图第一次从 Telegram 取、之后不再取，找不到的包、表情符号包、乱填的链接、本机地址的 zip 都报错；Telegram 上表情跟在话后面，第一次上传、之后用 file_id 发；只发一张表情时不再补「没说出话来」；一次回复第二张被拒；自己画一张，存进「mine」并在 Telegram 上当动图发；网页上那条回复下面显示表情，网页上说的话不往 Telegram 发；模型看得到开着的包里的每一张，关掉一个包或整个功能就看不到；设置页改「什么时候用」、删单张、删包；`/status` 那一行。`node test/stickers.mjs` 10 项测 zip 读法（中文文件名、GBK 文件名、`__MACOSX`、加密的拒收、解开后太大的停下）、pack.json 和没有 pack.json 时的读法、名字不撞、Telegram 链接、画出来的 GIF 用解码器读回来每个像素都对、透明色和描边。
- 回复写到一半把进程杀掉：重启后住户自己醒过来，发一句「刚才回到一半断了，再发一次好吗？」，不会把半截重发一遍。
- 网页门在 Chromium 里点过（手机宽度夜间、电脑宽度白天）：错钥匙提示、手机宽度没有横向滚动、发消息收到回复（自己那条也带上时间和心形）、心形按钮、Telegram 那边发的消息 5 秒内自己出现且不重复、交接信折叠；换模型：搜 `opus` 只出 opus、调不通的不换并显示原因、目录里没有的 id 可以直接试、方向键和回车能选、Esc 关掉；人设：没填时的提醒、写了「Claude Code」会提示、保存后提醒消失。

没测过：真的模型、部署到线上（免费档的 CPU 和启动时间只在线上能验）；Cloudflare 浏览器和长页压缩（Qwen 或别的模型）只用假的测过；Claude 走 Cloudflare 这条路时 1 小时缓存有没有生效，要上线后看 `/status` 的缓存读写。

## 上线

1. **建 bot**：Telegram 里找 @BotFather，`/newbot`，起名字，记下 token 和 bot 的用户名。
2. **部署**：Cloudflare 后台 → Workers & Pages → Create → Import a repository，选这个仓库。项目名填 `aelios-resident`（要跟 `wrangler.jsonc` 里的 `name` 一样），其余用默认（部署命令 `npx wrangler deploy`）。以后推到 main 就自动更新。不用建 D1、KV 或别的库：聊天记录、交接信、人设存在 Durable Object 自带的 SQLite 里，部署时自动建好；长期记忆走你现有的 Aelios。
3. **填三个 Secret**（Worker → Settings → Variables and Secrets）。别的都在网页门的设置页里填，不用来这儿：
   - `TG_BOT_TOKEN`：第 1 步的 token
   - `TG_WEBHOOK_SECRET`：自己编一串长的（字母、数字、`_`、`-`）
   - `WEB_KEY`：普通浏览器的网页门钥匙，自己编一串长的；不填时普通网页登录关闭，Telegram Mini App 仍可凭签名身份和白名单进入。拿到它就能看全部对话、改模型、人设和设置，别截图别外发；怀疑漏了就在 Cloudflare 里换一个，网页门重新填一次
4. **接上 Telegram**：浏览器打开一次 `https://aelios-resident.<你的子域>.workers.dev/tg/setup?secret=<TG_WEBHOOK_SECRET>`，`setWebhook`、`setMyCommands` 和 `setChatMenuButton` 都返回 `"ok":true` 就接好了（顺便把三个命令登记到 bot 的菜单里，并把 bot 左下角的菜单按钮设成「打开网页」，在 Telegram 里点开就是网页门，见下面「Telegram Mini App」）。
5. 打开 `https://aelios-resident.<你的子域>.workers.dev/`，填 `WEB_KEY` 进网页门。点右上角的齿轮进设置页，填：
   - 谁能跟它说话：你的 Telegram 用户名，比如 `@your_name`（也可以填 chat id，逗号隔开）
   - Aelios 的地址（比如 `https://companion-memory-proxy.xxx.workers.dev`）和 key：跟你 Aelios 那边 `CHATBOX_API_KEY`、`IM_API_KEY`、`MEMORY_MCP_API_KEY` 任意一把同一个值。三把都读写 `default` 空间；想用别的空间只能用 `CHATBOX_API_KEY`
   - 身份：在 Aelios 后台给住户建一个身份，把要用的模型放进它的主模型，这里填身份名

   再点左上角的模型名选模型，点铅笔把人设贴进去、保存。
6. 给 bot 发条消息。

## Telegram Mini App

部署这个版本后，从正式 https 域名重新打开一次 `/tg/setup?secret=<TG_WEBHOOK_SECRET>`，即可更新 bot 左下角的「打开网页」按钮。也可以在 BotFather 的 Menu Button 设置里填同一个 https 根网址。此操作不需要新建 bot。

在 Telegram 里点 bot 的菜单按钮，网页门直接在 Telegram 里打开，不用填 `WEB_KEY`；Mini App 里也拿不到 `WEB_KEY`。它凭 Telegram 用 bot token 签过名的 `initData` 进门（`src/mini-app.ts`）：Worker 按[官方做法](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)验 HMAC 签名，`auth_date` 超过 24 小时的不认，用户只从签过名的字符串里读，不信 `initDataUnsafe`。验过以后换一个短期会话（12 小时，页面开着时自己续，从打开那一刻起最多续 7 天，之后要重新打开 Mini App），所以开着很久也不会掉线。

- 每次请求都按当时生效的 `TG_ALLOWED` 再查一遍（用户 id 或 @用户名）：把人从名单里拿掉，正开着的 Mini App 下一次请求就进不来。
- 会话用从 bot token 派生的密钥签名，换掉 `TG_BOT_TOKEN` 所有会话立刻作废，不存任何状态。
- 名单里的人在 Mini App 里能做的和网页门一样（聊天、换模型、人设、设置）。
- `/tg/setup` 只有用 https 网址打开时才设菜单按钮（Telegram 只开 https 的 Mini App），打开的就是那个网址的根路径；换了自定义域名就从新域名再打开一次 `/tg/setup`。本地 http 测试时跳过这一步。

## 表情包格式

一个 zip，最大 16 MB，解开后最多 40 MB。最简单的：把图打进去，文件名就是什么时候用，比如 `开心.gif`、`想你了.png`；图可以是 GIF、PNG、WebP、JPEG，一张最大 1 MB，旁边有同名的 `.webm`（Telegram 视频贴纸）就在 Telegram 上发它。要写得细一点，放一个 `pack.json`：

```json
{
  "format": "resident-stickers/1",
  "id": "clawd",
  "name": "Clawd",
  "description": "一句话说这是什么包",
  "author": "谁画的",
  "license": "能怎么用",
  "homepage": "https://…",
  "stickers": [
    { "id": "love", "file": "love.gif", "telegram": "love.webm", "emoji": "❤️", "when": "A rush of love: they said something sweet." }
  ]
}
```

- `file`：网页上显示的图，路径相对 `pack.json` 所在的文件夹。
- `telegram`（可选）：在 Telegram 上当真贴纸发的文件，WebM（VP9，512 像素，3 秒以内，最大 256 KB）、WebP（最大 512 KB）或 TGS（最大 64 KB），按 Telegram 自己的贴纸规矩做，透明底才留得住。不带就按上面说的当动图或照片发。
- `id`：模型叫它 `<包 id>/<id>`，不填用文件名；`emoji` 一个，Telegram 上传贴纸时要；`when`：什么时候用，最多 160 字，模型看这个挑，写英文还是中文都行。
- `homepage` 只认 https，设置页上是「出处」按钮。
- 同一个 `id` 的包再导一次就替换旧的，开关状态留着；一个包最多 120 张，多的不导，导不进的每张都会在设置页上说为什么。

Telegram 贴纸包导进来时每张只有 Telegram 给的 emoji，名字是 1、2、3……，在设置页给常用的几张填上「什么时候用」，它才知道什么时候发。表情符号包（`t.me/addemoji/…`）机器人发不了，不收。

## 设置

下面这些都在网页门的设置页里改（齿轮），下一句就生效。设置页里没存的，用 Worker 的 Variables and Secrets 里同名的变量（以前填的照样有效），那边也没有就用默认。`TG_BOT_USERNAME` 和 `DEBOUNCE_SECONDS` 不在设置页，要改还是在 Cloudflare 里填。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_GATEWAY_ID` | 空（用账户的 `default`） | Claude 这类厂商模型和搜索走哪个 AI Gateway |
| `TG_BOT_USERNAME` | 空 | bot 的用户名 |
| `TG_ALLOWED` | 空（谁都不回） | 允许的 chat id 和 @用户名 |
| `TIME_ZONE` | `Asia/Singapore` | 消息前的时间、定时用哪个时区 |
| `DEBOUNCE_SECONDS` | `3` | 连发几条在这个秒数内算一轮 |
| `LETTER_IDLE_MINUTES` | `55`（`CACHE_TTL=5m` 时 `4`） | 你没动静多少分钟写交接信（定时找你那几轮不算，不往后推）；最多比缓存时长少 1 分钟，填多了也按这个算；`off` 只靠 `/handoff` |
| `KEEP_RECENT_TOKENS` | `6000` | 写信后最近多少 token 原样留着（中文一字约 1 token）；比这更早的聊天才收进信里，想聊得少也写信就调小 |
| `CACHE_TTL` | `1h` | Claude 的缓存留多久，`1h` 或 `5m` |
| `THINKING_EFFORT` | `auto` | Claude 想多久：`low`、`medium`、`high`、`xhigh`、`max`，`auto` 用模型自己的默认（Opus 5.5 是 `medium`，Sonnet 5.5 是 `high`）。只在从 Aelios 过或自己 Anthropic 格式的供应商时生效，不收这个参数的老模型不带；换档后第一句要重写一次缓存（`src/thinking.ts`） |
| `AELIOS_URL` / `AELIOS_API_KEY` | 空 | 长期记忆；不填就不接，聊天也不从 Aelios 过 |
| `AELIOS_NAMESPACE` | `default` | 记忆工具、开机包、交接信用的空间；聊天记进哪个空间看身份在 Aelios 里的设置，两边对上 |
| `AELIOS_IDENTITY` | 空（这把 key 的第一个身份） | 聊天以 Aelios 里哪个身份过；用的模型要在它的主模型里 |
| `WEB_SEARCH` | `on` | `off` 关掉搜网；填 `ceramic`、`exa` 或 `linkup` 时，自己的 key 都失败后再用 Cloudflare 的 Web Search 这一家（没填自己的 key 时默认就是 `ceramic`）。Exa、Linkup、Ceramic 的 key 可以存在 AI Gateway → Provider Keys，别名 `default`，就不扣额度 |
| `WEB_LEARN` | `on` | 搜到的长期知识存进 Aelios 的世界知识，`off` 关掉；要接着 Aelios |
| `WEB_FETCH` | `on` | `off` 关掉读网页 |
| `WEB_FETCH_MODEL` | `@cf/qwen/qwen3-30b-a3b-fp8` | 压长网页用的模型，主模型能填的 id 这里都能填（Workers AI 的 `@cf/…`，或 `anthropic/claude-haiku-5.5`、`openai/…` 这种走 AI Gateway 的）；`off` 不压，只截断 |
| `CUSTOM_BASE_URL` / `CUSTOM_API_KEY` | 空 | 没接 Aelios 时自己的供应商的地址（写到 `/v1` 为止）和 key；模型填 `custom/…` 时用 |
| `CUSTOM_FORMAT` | `openai` | 自己的供应商说哪种格式：`openai`（chat completions）或 `anthropic`（Messages，带缓存） |
| `CHECKIN_SCHEDULE` | 空（不主动找） | `every day at 09:00`、`every weekday at 21:30`、`every 3 hours` 这类写法 |
| `STICKERS` | `on` | `off` 不发表情也不画；包还留着，开回来照用 |

## 花钱吗

- **Workers 免费档**：超出免费额度是报错，不扣钱。Durable Object 每天 10 万次请求，Workers AI 每天 1 万 neurons，UTC 0 点重置。闲着能休眠的 Durable Object 不算时长费。网页门开着时每 5 秒刷新一次，一小时大约 720 次请求，关掉页面或切到后台就停。
- **默认模型** `glm-4.7-flash`：免费档能用（DeepSeek v4、Kimi、GLM 5.3 这些在 Workers AI 上要付费账户）。按官方价目，每百万输入 token 5500 neurons、输出 36400 neurons，一万 neurons 大约够每天 80 到 200 轮，看对话多长（估算）。定时找你每次也算一轮。
- **搜网**：用你自己的 Tavily、Brave、Perplexity key 时按那几家自己的免费额度和价格算。没填自己的 key 时走 AI Gateway 的 Web Search，用 Gateway 额度按次付费，默认的 Ceramic.ai 是每 1000 次 0.25 美元（10-14 查的官方价），没有额度就报错。读网页：普通抓不收钱；靠浏览器的页面用 Cloudflare 浏览器渲染，Workers Paid 每月含 10 小时，超出每小时 0.09 美元（免费档每天 10 分钟），一页几秒；长页压缩默认走 Workers AI 的 Qwen3 30B，每百万 token 输入 0.051、输出 0.335 美元（10-14 查的官方价），一页大约千分之一美元；`WEB_FETCH_MODEL` 换成 Claude 之类的收费模型时，按那家的价格从 AI Gateway 额度里扣，一页最多 6 段、每段约 6000 token 进、1500 token 出。搜过网的那一轮，挑知识再多调一次这个模型，约 1 万字进、几百字出。
- **别的 MCP**：每调一次它的工具就是一次对外请求，跟搜网、读网页一样算在免费档每次请求 50 个子请求里；工具说明每轮都带，设置页上每个服务旁边有「每轮约多少 token」。服务本身收不收钱看那一家。
- **表情包**：开着的包里每张一行（名字、emoji、什么时候用）每轮都带给模型，一行十几到几十 token，设置页每个包旁边写着约多少；17 张的包大约 400 token，从缓存读时按缓存价算。发表情不调模型；自己画一张就是一次工具调用。图存在 Durable Object 自带的 SQLite 里，Telegram 包的图第一次在网页上看时才从 Telegram 取。
- **Workers Paid（5 美元/月）**：超出包含额度才按量收，这个量级基本碰不到。
- **换 Claude**：接了 Aelios 时从 Aelios 过，花的是 Aelios 那边配的供应商和 key。没接时走 AI Gateway，花的是 Gateway 的预付额度；Gateway 里存了你自己的 Anthropic key 时用那把。每轮带缓存标记，命中的部分按缓存价算（读是输入价的 1/10）；1 小时缓存写入是输入价的 2 倍（5 分钟的是 1.25 倍），换来的是停一会儿再聊、写交接信都还能读缓存。Cloudflare 这条路只收一整段文字的 system，AI SDK 发的是一组文字块，所以住户在发出去前把它们合成一段（`src/claude-run.ts`），缓存标记照带。Claude 的思考块签名绑着写下它时的系统提示、工具和前面每条消息，而住户会改这些（网页上换人设、开机包几小时刷新一次、交接信收掉旧聊天、部署了新规矩或新工具），旧思考块原样发回去就会报「bound to a different conversation」、之后每轮都失败；所以同一个文件里也把之前几轮的思考块拿掉，只回传这一轮工具调用之间的思考，回复本身都留着。用 Max 附带的 API key 时，人设里别出现「Claude Code」这几个字。

## 还没做

- 听语音、网页门发图。
- 真正逐 token 推送（现在等待回复时短轮询同步文字和思考、工具进度）。

## 网页用到的现成东西

聊天组件都放在 `public/vendor/`，普通网页登录不用连外面的 CDN。仅从 Telegram Mini App 打开时加载官方 `https://telegram.org/js/telegram-web-app.js`，用来取得签名身份、适配窗口高度、安全区、返回按钮和主题：

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

`wrangler.test.jsonc` 用脚本模型（`FAKE_MODEL=true`），不需要登录 Cloudflare，也不花钱。定时、空闲交接信、没接 Aelios 时自己的供应商要另外起一次，见 `test/run.mjs` 开头的说明。读网页的测试 `node test/web.mjs`、`node test/claude-run.mjs`、Mini App 进门的 `node test/history.mjs` 测思考、工具投影与计数，`node test/history-worker.mjs` 在本地 Worker 上测实时思考与工具记录；`node test/mini-app.mjs`（加 `worker` 再连本地 Worker 测一遍）、交接信收哪些聊天的 `node test/fold.mjs` 、从 Aelios 过的 `node test/via-aelios.mjs` 、搜网后存知识的 `node test/learn.mjs` 、接别的 MCP 的 `node test/mcp-servers.mjs` 和表情包的 `node test/stickers.mjs` 不用起 Worker。

## 许可证

AGPL-3.0，和 [Aelios](https://github.com/wusaki0723/Aelios) 一样（`LICENSE`）：随便用、随便改；改过的版本拿去当网络服务给别人用，改动也要用同样的许可证公开。「网页用到的现成东西」那节列的文件各自保留 MIT 许可。
