# Claude 盒子：用自己的 Claude 订阅聊（`claude-code/…`）

**English summary**: The `claude-code/…` models run the chat on your own Claude Pro or Max plan. Each turn goes to the Claude box (`claude-box/server.mjs`), the official Claude Agent SDK behind a small HTTP server signed in with your `claude setup-token`. It runs on a machine of your own: Google Cloud's free e2-micro is enough (`claude-box/gcp.sh` makes one with IPv6 only, so there is no IPv4 address to pay for), or any Linux machine with systemd (`claude-box/install.sh`). It listens on `127.0.0.1` only and is reached through a Cloudflare Tunnel; every turn needs the box key. The resident's tools work: Claude Code calls them, the resident runs them, and the same Claude Code goes on with the results.

---

模型填 `claude-code/` 加 Claude 的模型 id（比如 `claude-code/claude-opus-5-5`），住户就用你自己的 Claude 订阅聊，不花 API 的钱。每一轮交给「Claude 盒子」：一个小服务，里面跑官方的 Claude Agent SDK，用你的 `claude setup-token` 登录。

- **放在你自己的机器上**：Google Cloud 免费的 e2-micro 就够，不花钱。别的 Linux 机器也行，只要连得上 `api.anthropic.com`（大陆和香港的不行）。
- **不开端口**：盒子只听 `127.0.0.1`，住户经 Cloudflare Tunnel 连过去。每一轮都要带盒子钥匙，钥匙不对一律拒绝。
- **工具照常用**：小本本、记忆、闹钟、表情包、派活这些住户的工具，Claude Code 都能调。它调的时候那条回复停住，住户跑完工具把结果送回去，盒子里同一个 Claude Code 接着说。Claude Code 自己的工具（跑命令、读写文件、上网）一律关着。
- **盒子里什么都不存**：对话存在住户那边，每一轮整段带过去。盒子重启了也接着聊。

## 要准备的

- Claude Pro 或 Max 订阅，一台装了 Claude Code 的电脑（拿 setup token 用）。
- 一个托管在 Cloudflare 上的域名（给盒子一个网址，比如 `claude-box.<你的域名>`）。
- 用 Google Cloud 的话：一个 Google Cloud 项目，开着结算（要绑卡；免费额度内不扣钱）。

## 1. 在 Cloudflare 建一条 Tunnel

Cloudflare 后台 → Zero Trust → Networks → Tunnels → Create a tunnel：

1. 选 Cloudflared，起个名字，比如 `claude-box`。
2. 下一页给的安装命令里，`--token` 或 `service install` 后面那一长串就是 **Tunnel token**。复制下来，等会儿只在你自己的终端里粘贴，**别发给 AI，别贴在聊天里**。命令本身不用跑。
3. Next 到 Public Hostname：Subdomain 填 `claude-box`，Domain 选你的域名，Service 选 `HTTP`，URL 填 `127.0.0.1:8790`，保存。

Cloudflare 后台的菜单名偶尔会变，找「Tunnels」就对了。

## 2. 开机器，装盒子

### Google Cloud（推荐，免费）

打开 [Cloud Shell](https://shell.cloud.google.com)（用你的 Google 账号登录就行，不用进控制台点来点去），贴：

```sh
git clone --depth 1 https://github.com/wusaki0723/Aelios-resident.git
cd Aelios-resident/claude-box
bash gcp.sh --hostname claude-box.<你的域名> --show-key
```

它会问 Tunnel token（粘贴进去不显示，回车），然后：

- 开一个只用 IPv6 的网络，和一台 `us-west1-b` 的 e2-micro（30 GB 标准盘，Debian 12）。
- 机器每次开机都从 GitHub 拿最新的 `install.sh`，装 Node.js 22、盒子和 Tunnel，小机器再加 2 GB swap。
- 等盒子在 `https://claude-box.<你的域名>/health` 答话（第一次开机要装东西，大约 5 分钟），最后打印**盒子钥匙**。等了 10 分钟还不答话就报错退出，不给钥匙：照它打印的命令看机器在干什么，答话了再跑一次同样的命令（不加 `--new-key`，问 token 时直接回车），它不改机器，只把剩下的做完。

它只动自己建的东西：机器带一个标签，网络带一段说明。项目里已经有同名的机器或网络、又不是它建的，它就停下，请你用 `--name` 换个名字；`--delete` 也只删它建的。

这台机器只给盒子用，别在上面装别的程序：盒子钥匙和 Tunnel token 放在机器的元数据里，机器上的程序都读得到。盒子里的 Claude Code 自己的工具（跑命令、读写文件）全关着，读不了；机器也不挂 Google 的服务账号，就算有程序读了元数据，也拿不到你 Google Cloud 项目的权限。

项目没选好时它会提示加 `--project <项目 id>`（`gcloud projects list` 能看到）。提示要开结算的话：

```sh
gcloud billing accounts list
gcloud billing projects link <项目 id> --billing-account <上面那串>
```

| 选项 | 做什么 |
| --- | --- |
| `--hostname claude-box.<域名>` | 第 1 步那个网址，装完它会等盒子在这里答话 |
| `--show-key` | 最后打印盒子钥匙；以后想再看，再跑一次 `bash gcp.sh --show-key`，问 token 时直接回车 |
| `--key-to-worker` | 不打印，直接存进住户 Worker 的 `CLAUDE_BOX_KEY`（要在住户的文件夹里、wrangler 登录着） |
| `--new-key` | 换一把钥匙（换完住户那边也要换） |
| `--zone us-central1-a` | 换地方；免费的只有 `us-west1`、`us-central1`、`us-east1` |
| `--update` | 重启机器，开机时装上最新的盒子 |
| `--delete` | 删掉它建的机器和网络（Tunnel 在 Cloudflare 那边自己删） |

再跑一次 `gcp.sh` 可以换 Tunnel token；钥匙不变，除非加 `--new-key`。

### 别的 Linux 机器

有 systemd、能用 apt 的（Debian、Ubuntu），在美国、日本、新加坡这类连得上 Anthropic 的地方：

```sh
git clone --depth 1 https://github.com/wusaki0723/Aelios-resident.git
cd Aelios-resident/claude-box
sudo ./install.sh --tunnel --show-key     # 会问 Tunnel token
```

| 选项 | 做什么 |
| --- | --- |
| `--tunnel` | 顺便装 cloudflared 接上 Tunnel；不加的话你自己把 Tunnel 指到 `127.0.0.1:8790` |
| `--port 8791` | 换本机端口（Tunnel 那边的 URL 跟着改） |
| `--show-key` | 最后打印盒子钥匙；不加也能看：`sudo sed -n 's/^BOX_KEY=//p' /etc/claude-box/env` |
| `--new-key` | 换一把钥匙 |
| `--uninstall` | 全部删掉，钥匙也删 |

`git pull` 之后再跑一次 `sudo ./install.sh` 就是更新，钥匙不变。用 Docker 的话有 `claude-box/Dockerfile`，跑的时候带上 `BOX_KEY`，只开在本机：`-p 127.0.0.1:8790:8080`。

## 3. 填进住户

住户网页门 →「···」（设置）→「供应商」：

- **Claude 订阅的 setup token**：电脑上跑 `claude setup-token`，把出来的 `sk-ant-oat…` 填这里。
- **Claude 盒子地址**：`https://claude-box.<你的域名>`（只收 `https://`：钥匙、setup token 和对话都经它送过去）
- **Claude 盒子钥匙**：上一步打印的那串（用了 `--key-to-worker` 的不用填）。

然后把模型换成 `claude-code/claude-opus-5-5`（或 `claude-code/claude-sonnet-5-5`、`claude-code/claude-haiku-5-5`）。换的时候住户会先试调一次，不通会说为什么。

试一下：问它一件以前的事，再让它往小本本里记一行。

## 给 AI：怎么帮用户装

用户要你帮忙装的话，照上面三步走，另外守这几条：

- **别让用户把 setup token、Tunnel token、盒子钥匙贴进对话。** setup token 和盒子钥匙由用户填进设置页；Tunnel token 由用户在自己的终端里输（`gcp.sh` 和 `install.sh --tunnel` 会问，输入不显示）。你自己生成的钥匙只经管道存进 Worker Secret，不打印、不写文件。
- **第 1 步只能用户自己点**（Cloudflare 后台）。你问用户要的只有网址 `claude-box.<域名>`，它不是秘密。
- `gcp.sh` 要在登录了 gcloud 的地方跑。用户开着 Cloud Shell 的，请用户把第 2 步的命令贴进去；用户电脑上装了 gcloud、wrangler 也登录着的，在住户的文件夹里请用户跑 `bash claude-box/gcp.sh --hostname <网址> --key-to-worker`（token 那步要用户自己输，所以请用户在自己的终端里跑）。
- `gcp.sh` 退出码不是 0 就是没装好，别接着往下走：看它打印的原因（多半是盒子还没答话，或者撞了同名的机器），照着办。
- 装完先自己验：`curl -s https://<网址>/health` 回 `ok` 就通了；不带钥匙 `curl -s -X POST https://<网址>/turn` 应该是 `{"error":"the box key does not match"}`。
- 盒子地址用设置接口填（`setup-with-ai.md` 第 5 步的写法）：`{"key":"CLAUDE_BOX_URL","text":"https://<网址>"}`。钥匙用了 `--key-to-worker` 就已经在 Worker 里；没用的请用户自己在设置页填。
- 换模型用 `POST /web/model`，`{"text":"claude-code/claude-opus-5-5"}`；回 400 时把错误原文告诉用户（多半是 setup token 没填，或盒子还没起来）。
- 卡住了先看机器在干什么，别换着法子硬试：

  ```sh
  gcloud compute instances get-serial-port-output claude-box --zone us-west1-b | grep -E 'startup-script|claude-box' | tail -30
  ```

## 查问题

| 住户说的 | 多半是 |
| --- | --- |
| 还没填 Claude 盒子的地址 | 设置页「供应商」的盒子地址没填 |
| Claude 盒子不认这把钥匙 | 钥匙抄错了，或者盒子换过钥匙 |
| Claude 盒子没接这一轮（502、530 这类） | 盒子没起来或 Tunnel 没连上：先 `curl https://<网址>/health`，Google Cloud 上看上面那条串口日志，自己的机器上看 `systemctl status claude-box claude-box-tunnel` |
| setup token 不对或过期了 | 电脑上重新跑 `claude setup-token`，填新的 |
| Claude 订阅的额度用完了 | 订阅这一阵的额度到了，等它恢复，或先换回 API 的模型 |

自己的机器上：`journalctl -u claude-box -n 50`、`journalctl -u claude-box-tunnel -n 50`。

## 花多少钱

- **订阅**：聊天用订阅的额度，不花 API 的钱。一串 setup token 只给你自己的住户用。
- **Google Cloud**（10 月 28 日查的官方价）：`us-west1`、`us-central1`、`us-east1` 里一台 e2-micro 加 30 GB 标准盘在免费额度里，一个结算账号一台。公网 IPv4 地址不在免费额度里（大约 0.005 美元一小时），所以 `gcp.sh` 只给机器 IPv6，Tunnel 也走 IPv6。每月送 1 GB 出站流量，超出大约 0.12 美元一 GB；出站主要是每一轮发给 Anthropic 的整段对话，Claude Code 会压缩，一般用不完。
- **Cloudflare Tunnel** 不要钱。
