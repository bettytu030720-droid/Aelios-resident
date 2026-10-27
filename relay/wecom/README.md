# 企业微信转发机（relay/wecom）

**English summary**: WeCom only accepts API calls from an app's trusted IPs, and a Cloudflare Worker has no fixed address. This small relay runs on a Linux machine that has one and passes the resident's calls on to `qyapi.weixin.qq.com`. It listens on `127.0.0.1` only and is reached through a Cloudflare Tunnel, so no port is opened. Every request needs the relay key. Install with `sudo ./install.sh` (add `--media` for voice messages and Telegram's WebM/WebP stickers, which installs ffmpeg). Only needed if you use the resident's WeCom door; the web door and Telegram do not need it.

---

只有接企业微信才要它；只用网页门、Telegram 的不用装。

企业微信只接受应用「企业可信 IP」发来的接口调用，而 Cloudflare Worker 没有固定 IP。所以住户回你的消息、发图、发语音，都先发到这台有固定 IP 的机器，再由它转给 `qyapi.weixin.qq.com`。企业微信推给住户的消息不经过这里，直接到住户。

- **不开端口**：只听 `127.0.0.1`，外面经 Cloudflare Tunnel 进来。
- **要钥匙**：每个请求都要带转发钥匙，没带或不对一律 403。
- **只转企业微信**：只转 `/cgi-bin/…` 到 `qyapi.weixin.qq.com`，别的地址一律 404，不能拿来当通用代理。
- **不存企业微信的 key**：Secret、Token、EncodingAESKey 都在住户那边，这里只经手一次性的 access_token，日志里也不记。
- **转码选装**：语音条和 Telegram 包里的 WebM、WebP 贴纸要 ffmpeg，装的时候加 `--media` 才有；不装也能聊文字、发图片。
- 只用 Python 3.8+ 自带的库，一个文件，一个 systemd 服务。

## 装

在那台机器上（Debian、Ubuntu 这类用 apt 的，要有 systemd）：

```sh
git clone https://github.com/wusaki0723/Aelios-resident.git
cd Aelios-resident/relay/wecom
sudo ./install.sh            # 文字和图片
sudo ./install.sh --media    # 再加语音条和贴纸转码（会装 ffmpeg 和 libavcodec-extra）
```

装完它会自己试一次，打印「what it can do」和接下来三步。之后随时可以再跑一次改选项，钥匙不变；想换钥匙加 `--new-key`（换完要去住户设置页填新的）。

| 选项 | 做什么 |
| --- | --- |
| `--media` / `--no-media` | 开 / 关转码 |
| `--port 8790` | 换本机端口，默认 `8787` |
| `--show-key` | 最后把钥匙打印出来（不加也能用下面的命令看） |
| `--new-key` | 换一把新钥匙 |
| `--uninstall` | 全部删掉，钥匙也删；ffmpeg 留着 |

`--media` 开了以后能做的：

| 转成 | 用在哪 |
| --- | --- |
| `amr` | 住户回你的语音条（企业微信只收 AMR，最长 60 秒） |
| `mp3` | 你发的语音条，转好再给住户听 |
| `png` | Telegram 包里的贴纸：静态的（WebP），和视频贴纸（WebM）的第一帧 |
| `gif` | 旧版住户把视频贴纸转成动图用的，现在的住户不用了 |

没开的话：住户该回语音时改回文字；你发的语音条它可能听不了；WebM、WebP 贴纸不发，GIF、PNG、JPG 的和它自己画的照发（GIF 由住户自己转成静图，不经过这里）。

表情包在企业微信上默认不发，想发的话在住户设置页「聊天渠道」的企业微信卡上打开「在企业微信上发表情包」。企业微信不放动图，还会把透明底变黑，所以发出去是垫了底色的静图（底色也在那里改）。

语音条要 ffmpeg 里有 `libopencore_amrnb`。Debian、Ubuntu 上 `libavcodec-extra` 带着它，装的脚本会一起装；没有的话会提醒你，这时语音回复改成文字。

## 接 Cloudflare Tunnel

给转发机一个外面能到的网址，转到本机的 `127.0.0.1:8787`。

- **这台机器已经有 Tunnel**：Cloudflare 后台 → Zero Trust → Networks → Tunnels，点开那条 → Public Hostname → Add，子域名比如 `wecom-relay`，选你的域名，Service 选 `HTTP`，URL 填 `127.0.0.1:8787`，保存。
- **还没有**：同一处 Create a tunnel → Cloudflared，起个名字，照页面给的命令在这台机器上装 cloudflared（命令里那串 token 只在你自己的终端里粘贴，别发给 AI），再照上一条加 Public Hostname。

Cloudflare 后台的菜单名偶尔会变，找「Tunnels」就对了。

试一下（在任何地方都行，钥匙换成你的）：

```sh
curl -s https://wecom-relay.<你的域名>/ping -H "x-relay-key: <转发钥匙>"
```

返回 `{"ok": true, "media": {...}}` 就通了。不带钥匙应该是 `{"error": "forbidden"}`。

## 填进住户

住户网页门 →「···」（设置）→「聊天渠道」→「接企业微信」，按步骤填：

- **转发地址**：`https://wecom-relay.<你的域名>`
- **转发钥匙**：在转发机上看，复制过去，别发在聊天里：

  ```sh
  sudo sed -n 's/^WECOM_RELAY_KEY=//p' /etc/wecom-relay/env
  ```

整套顺序（建应用、Token、可信 IP、微信插件）见住户 README 的「企业微信」一节。

## 企业可信 IP

企业微信后台 → 应用管理 → 这个自建应用 → 企业可信 IP，填转发机出去时的 IP：

```sh
curl -s https://ifconfig.me
```

企业微信要先在同一个应用里设好「接收消息」的 URL，才让填可信 IP。没填或填错时，住户那边会报 60020，设置页「聊天渠道」里的企业微信卡会写出来。

## 查问题

```sh
systemctl status wecom-relay
journalctl -u wecom-relay -n 50
```

- 日志每个请求一行，只有方法和路径，不带参数。
- `/ping` 返回的 `media` 全是 `false`：没加 `--media`，或者 ffmpeg 没装上。
- 住户设置页说「转发机不认这把钥匙」：钥匙抄错了，或者转发机换过钥匙。
- 住户设置页说「转发机连不上」：先在别处 `curl …/ping` 看 Tunnel 通不通，再看 `systemctl status wecom-relay`。

## 没有 apt 或 systemd 的机器

自己装好 Python 3.8+（要语音条再装带 `libopencore_amrnb` 的 ffmpeg），然后用你自己的方式常驻运行：

```sh
WECOM_RELAY_KEY=<至少 32 位的随机串> WECOM_RELAY_MEDIA=1 python3 wecom-relay.py
```

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WECOM_RELAY_KEY` | 无，必填 | 至少 32 位；可以用 `python3 -c 'import secrets; print(secrets.token_hex(32))'` 生成 |
| `WECOM_RELAY_PORT` | `8787` | 本机端口，只听 `127.0.0.1` |
| `WECOM_RELAY_MEDIA` | `0` | `1` 开转码 |
| `WECOM_RELAY_FFMPEG` | `ffmpeg` | ffmpeg 的路径 |

## 卸载

```sh
sudo ./install.sh --uninstall
```

再去 Cloudflare 后台删掉那条 Public Hostname，住户设置页清空「转发地址」和「转发钥匙」。
