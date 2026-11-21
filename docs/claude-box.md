# 盒子：在自己的机器上用 Claude 订阅和 Kiro 额度（`claude-code/…`、`kiro/…`）

**English summary**: A box is a small program (`acp-box/`) you run on a machine of your own. It dials out to the resident over one WebSocket (no tunnel, no box address, no domain, no open port) and serves two plugs: `claude` (the official Claude Agent SDK on your own Claude Pro or Max plan, for `claude-code/…` models) and `kiro` (`kiro-cli acp` on your own Kiro credits, for `kiro/…` models). You pair it once with a one-time code from the settings page. The helpers' keys (`CLAUDE_CODE_OAUTH_TOKEN`, `KIRO_API_KEY`) live only on the box machine. The resident connection works over IPv6 only, and so does the Claude plug; the Kiro plug needs IPv4 egress, because Kiro's endpoints have no IPv6 address.

---

模型填 `claude-code/` 加 Claude 的模型 id（比如 `claude-code/claude-opus-5-5`），或者 `kiro/auto`，住户就用你自己的 Claude 订阅或 Kiro 额度聊，不花 API 的钱。这两种的每一轮都交给「盒子」：你在自己机器上跑的一个小程序。

- **盒子主动连出去**：它向住户开一条 WebSocket 一直连着，断了自己重连。不用 Tunnel，不用域名，不用盒子的网址，机器也不用开任何端口。
- **钥匙只在盒子那台机器上**：Claude 的 setup token 和 Kiro 的 API key 不经过住户，也不存在 Cloudflare 上。盒子从自己的环境变量读，或者读配置文件夹里权限 0600 的文件，不写日志。
- **一台盒子多个插头**：连上时盒子报它现在能做的插头（`claude`、`kiro`），住户按模型名的前缀送：`claude-code/…` 到 `claude`，`kiro/…` 到 `kiro`。
- **工具照常用**：小本本、记忆、闹钟、表情包、派活这些住户的工具，帮手都能调。它调的时候那条回复停住，住户跑完工具把结果送回去，同一个帮手接着说。Claude Code 自己的工具（跑命令、读写文件、上网）一律关着。
- **盒子里不存对话**：对话存在住户那边，每一轮整段带过去。盒子重启了也接着聊。

## 帮手能不能连上它的服务商

住户到盒子这一段只要 IPv6 就行。但帮手自己要连它的服务商：

| 插头 | 要什么 |
| --- | --- |
| `claude` | 连得上 `api.anthropic.com`（大陆和香港的机器不行）。**只有 IPv6 的机器也能用。** |
| `kiro` | 连得上 Kiro 的服务。**Kiro 的服务地址没有 IPv6，机器要能出 IPv4**：家里的电脑，或者只有 IPv6 的云主机加 Cloudflare WARP（或别的 IPv4 出口）。 |

带 kiro 插头的盒子启动时（之后每隔几分钟）会试连 Kiro 的地址。连不上，它就把这个插头报成「用不了」，附一句原因；设置页上看得到，不会每一轮都失败。机器后来能出 IPv4 了，几分钟内盒子自己重连，插头就变回可用。

## 要准备的

- 一台有 Node.js 22 以上的机器：家里的电脑，或者一台云主机。Google Cloud 的免费 e2-micro 够用（us-west1、us-central1、us-east1 里一台加 30 GB 标准盘；只用 IPv6 就没有 IPv4 地址的钱，这对 `claude` 够，`kiro` 不够）。
- 要 `claude`：Claude Pro 或 Max 订阅，和一台装了 Claude Code 的电脑，跑 `claude setup-token` 拿 setup token（`sk-ant-oat…`）。
- 要 `kiro`：机器上装好 [Kiro CLI](https://kiro.dev/docs/cli/)，在 Kiro 后台生成一个无头模式的 API key（`ksk_` 开头，见 [Kiro headless mode](https://kiro.dev/docs/cli/headless/)）。

## 1. 在设置页拿配对码

设置页 →「供应商」→「盒子」那行右边的链接按钮。它给一个一次性的配对码（10 分钟，用一次作废）和要在盒子上运行的命令。

## 2. 装盒子，配对

### 在自己的电脑或任何机器上直接跑

```sh
git clone --depth 1 https://github.com/wusaki0723/Aelios-resident.git
cd Aelios-resident/acp-box
npm ci                         # 只用 kiro 的话 npm ci --omit=optional，不下载 Claude 的 SDK
node main.mjs --resident https://<你的 Worker 地址> --code ABCD-EFGH
```

第一次起，盒子用配对码换到自己的 token，存在 `~/.config/aelios-box/box.json`（权限 0600，只在这台机器上）。接着它会问你要不要填 Kiro 的 API key 和 Claude 的 setup token（输入不显示，直接回车就是跳过），填的存在同一个文件夹的 `creds.json`（权限 0600）。也可以不填，改用环境变量：

```sh
KIRO_API_KEY=ksk_… CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat… node main.mjs
```

以后直接 `node main.mjs` 就行。不是第一个住户的话，地址写成 `https://<Worker 地址>/r/<住户代号>`。

### Linux 加 systemd，装成服务

```sh
cd Aelios-resident/acp-box
KIRO_API_KEY=ksk_… CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat… sudo -E ./install.sh --resident https://<你的 Worker 地址> --code ABCD-EFGH
```

它建一个 `aelios-box` 用户，把盒子放进 `/opt/aelios-box`，钥匙写进 `/etc/aelios-box/env`（权限 0600），配对一次，再起服务 `aelios-box`。想改钥匙就编辑那个文件，然后 `sudo systemctl restart aelios-box`。再跑一次 `install.sh` 就是更新，配对和钥匙都留着。看日志：`journalctl -u aelios-box -f`。卸载：`sudo ./install.sh --uninstall`（再去设置页撤销这台盒子）。

### 只有 IPv6 的云主机

连住户没问题，`claude` 插头直接能用。要用 `kiro` 的话，先让机器能出 IPv4（比如装 Cloudflare WARP），否则盒子会把 `kiro` 报成「用不了」。

## 3. 在设置页看

配好后几秒内，设置页「盒子」那行下面出现这台盒子：名字（机器的名字）、它有的插头、在不在线、上次见到的时间。做不了的插头会写原因。可以配好几台；两台有同一个插头时，设置页让你选哪台来管，不选就是最近连上的那台。「撤销」会让这台马上断开，它的 token 作废。

模型填 `claude-code/claude-opus-5-5` 或 `kiro/auto`。选的模型没有盒子连着时，这一轮用默认模型回，聊天里留一行说盒子不在线。

## 从旧的 Tunnel 盒子搬过来

旧版的盒子是住户经 Cloudflare Tunnel 去连的 HTTP 服务，钥匙填在设置页。新版反过来：

1. 住户启动时会把旧的设置（`CLAUDE_CODE_OAUTH_TOKEN`、`CLAUDE_BOX_URL`、`CLAUDE_BOX_KEY`、`KIRO_API_KEY`、`KIRO_BOX_URL`、`KIRO_BOX_KEY`）删掉，不再读。设置页会提示一次。
2. 在原来的机器上（Google Cloud 那台、这台 Mac）：停掉旧服务（用旧版代码里的 `sudo claude-box/install.sh --uninstall` 卸；Mac 上停掉 `node server.mjs`），按上面装新盒子并配对，把 setup token 和 API key 放到这台机器上。
3. Tunnel 不用了，可以在 Cloudflare 后台删。`claude-box/` 文件夹和 `gcp.sh` 不在了；要新开一台云主机就用云平台自己的控制台。

## 常见问题

- **配对码不对或过期了**：在设置页重新拿一个。试错太多次（10 分钟内 10 次）会被拦一阵。
- **盒子显示不在线**：看盒子的输出或日志；机器断网、盒子没起、或者被撤销了都会这样。被撤销的盒子会打印出来并停下，重新拿配对码配一次。
- **盒子反复重连**。在盒子上运行 `journalctl -u aelios-box -f` 即可观察空闲连接。每条 `disconnected` 记录含关闭码、原因及当时进行中的回合数。`localClose` 是盒子主动请求关闭的理由，`lastPingAgoMs` 和 `lastPongAgoMs` 是距最近一次发送心跳、收到心跳回复的毫秒数，尚无记录时为 `null`。关闭码 1006 表示未收到关闭帧。排查原因时，一起看同一时刻的 `WebSocket error` 和进程级 `WebSocket transport error`。
- **插头写着「用不了」**：照写的原因处理（没放钥匙、没装 `kiro-cli`、连不上 Kiro 要 IPv4、没装 Claude 的 SDK 要在 `acp-box` 里 `npm ci`）。
- **Claude 订阅没登录上**：setup token 不对或过期了，重新 `claude setup-token`，放到盒子那台机器上，重启盒子。
