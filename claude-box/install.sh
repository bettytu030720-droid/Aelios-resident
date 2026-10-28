#!/usr/bin/env bash
# Installs the Claude box for Aelios-resident on this machine (Linux with systemd; apt for what it adds): Node.js 22,
# the box (server.mjs) as a service on 127.0.0.1, and if asked the Cloudflare Tunnel that brings the resident to it.
#
#   sudo ./install.sh                  the box alone (you connect a tunnel to 127.0.0.1:8790 yourself)
#   sudo ./install.sh --tunnel         also cloudflared, with the tunnel's token from stdin (or $TUNNEL_TOKEN)
#   sudo ./install.sh --gcp            on the Google Cloud machine gcp.sh makes: key and token from its metadata
#   sudo ./install.sh --port 8791      another local port (default 8790)
#   sudo ./install.sh --show-key       print the box key at the end (it is in /etc/claude-box/env either way)
#   sudo ./install.sh --new-key        a new key (then put it on the resident's settings page again)
#   sudo ./install.sh --uninstall      remove it all, key included
#
# Run it again any time: it brings the box up to date (from this folder, or from GitHub when there is no clone) and
# keeps the key. It opens no port to the outside: the box listens on 127.0.0.1 only, and the tunnel goes out.
# The machine has to reach api.anthropic.com: not in mainland China or Hong Kong. See docs/claude-box.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
port=""
tunnel=0
gcp=0
show_key=0
new_key=0
uninstall=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tunnel) tunnel=1 ;;
    --gcp) gcp=1 ;;
    --port) port="${2:-}"; shift ;;
    --show-key) show_key=1 ;;
    --new-key) new_key=1 ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done

if [ "$(id -u)" != 0 ]; then
  echo "run it with sudo" >&2
  exit 1
fi

say() { echo "claude-box: $*"; }
box_unit=/etc/systemd/system/claude-box.service
tunnel_unit=/etc/systemd/system/claude-box-tunnel.service
conf=/etc/claude-box

if [ "$uninstall" = 1 ]; then
  systemctl disable --now claude-box claude-box-tunnel 2>/dev/null || true
  rm -f "$box_unit" "$tunnel_unit"
  rm -rf /opt/claude-box /opt/claude-box-node /var/lib/claude-box "$conf"
  userdel claude-box 2>/dev/null || true
  systemctl daemon-reload
  say "removed (cloudflared and the swap file, if they were added, are left in place)"
  exit 0
fi

# Google Cloud's metadata server; an IPv6-only machine reaches it at its IPv6 address.
metadata() {
  local base
  for base in http://metadata.google.internal "http://[fd20:ce::254]" http://169.254.169.254; do
    if curl -fsS -m 3 -H "Metadata-Flavor: Google" "$base/computeMetadata/v1/instance/attributes/$1" 2>/dev/null; then return 0; fi
  done
  return 1
}

apt_install() {
  if ! command -v apt-get >/dev/null; then
    echo "$* is needed: install it, then run this again" >&2
    exit 1
  fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@"; }
}

command -v curl >/dev/null || apt_install curl ca-certificates

repo="${BOX_REPO:-wusaki0723/Aelios-resident}"
ref="${BOX_REF:-main}"
token="${TUNNEL_TOKEN:-}"
given_key=""
if [ "$gcp" = 1 ]; then
  # The key and the token gcp.sh gave. The metadata server can be slow right after boot; without them nothing is made
  # up, since a key of the box's own would not be the one gcp.sh hands out.
  for _ in $(seq 1 20); do
    given_key="$(metadata box-key || true)"
    token="$(metadata tunnel-token || true)"
    [ -n "$given_key" ] && [ -n "$token" ] && break
    sleep 3
  done
  if [ -z "$given_key" ] || [ -z "$token" ]; then
    echo "claude-box: no box-key or tunnel-token in this machine's metadata: run gcp.sh again" >&2
    exit 1
  fi
  repo="$(metadata box-repo || echo "$repo")"
  ref="$(metadata box-ref || echo "$ref")"
  tunnel=1
elif [ "$tunnel" = 1 ] && [ -z "$token" ]; then
  if [ -t 0 ]; then
    read -rsp "tunnel token (it does not show): " token
    echo
  else
    read -r token || true
  fi
  [ -n "$token" ] || { echo "--tunnel needs the tunnel's token on stdin or in TUNNEL_TOKEN" >&2; exit 1; }
fi

# A small machine (Google's e2-micro has 1 GB) gets swap, so a turn and an update never run out of memory.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 1600000 ] && [ "$(awk 'NR > 1' /proc/swaps | wc -l)" = 0 ]; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile 2>/dev/null || true
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  say "added 2 GB of swap"
fi

# Node.js 22 or newer: the one on the machine, or the newest 22 from nodejs.org in a folder of the box's own.
node_ok() { "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; }
node="$(command -v node || true)"
if [ -z "$node" ] || ! node_ok "$node"; then
  if [ -x /opt/claude-box-node/bin/node ] && node_ok /opt/claude-box-node/bin/node; then
    node=/opt/claude-box-node/bin/node
  else
    case "$(uname -m)" in
      x86_64) arch=x64 ;;
      aarch64) arch=arm64 ;;
      *) echo "no Node.js 22 for $(uname -m) here: install Node.js 22, then run this again" >&2; exit 1 ;;
    esac
    command -v xz >/dev/null || apt_install xz-utils
    dist=https://nodejs.org/dist/latest-v22.x
    sums="$(curl -fsSL "$dist/SHASUMS256.txt")"
    file="$(printf '%s\n' "$sums" | awk -v want="linux-$arch.tar.xz" '$2 ~ ("^node-v22[.0-9]*-" want "$") {print $2; exit}')"
    [ -n "$file" ] || { echo "could not find Node.js 22 for linux-$arch on nodejs.org" >&2; exit 1; }
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/$file" "$dist/$file"
    (cd "$tmp" && printf '%s\n' "$sums" | grep "  $file\$" | sha256sum -c --quiet -)
    rm -rf /opt/claude-box-node && mkdir -p /opt/claude-box-node
    tar -xJf "$tmp/$file" -C /opt/claude-box-node --strip-components=1
    rm -rf "$tmp"
    node=/opt/claude-box-node/bin/node
    say "installed Node.js $("$node" -v)"
  fi
fi
npm="$(dirname "$node")/npm"
[ -x "$npm" ] || npm="$(command -v npm)"

# The box's files: from this folder when it is a clone, otherwise from GitHub.
files="package.json package-lock.json server.mjs transcript.mjs"
new="$(mktemp -d)"
if [ -f "$here/server.mjs" ] && [ -f "$here/transcript.mjs" ]; then
  for f in $files; do cp "$here/$f" "$new/$f"; done
else
  for f in $files; do curl -fsSL -o "$new/$f" "https://raw.githubusercontent.com/$repo/$ref/claude-box/$f"; done
fi
install -d -m 755 /opt/claude-box
if ! cmp -s "$new/package-lock.json" /opt/claude-box/package-lock.json || [ ! -d /opt/claude-box/node_modules ]; then
  cp "$new/package.json" "$new/package-lock.json" /opt/claude-box/
  (cd /opt/claude-box && PATH="$(dirname "$node"):$PATH" "$npm" ci --omit=dev --no-audit --no-fund --loglevel=error)
  # The SDK brings Claude Code for glibc and musl alike; this machine needs one.
  musl=0
  ldd --version 2>&1 | grep -qi musl && musl=1
  for d in /opt/claude-box/node_modules/@anthropic-ai/claude-agent-sdk-linux-*; do
    case "$d" in
      *-musl) [ "$musl" = 1 ] || rm -rf "$d" ;;
      *) [ "$musl" = 0 ] || rm -rf "$d" ;;
    esac
  done
fi
for f in $files; do install -m 644 "$new/$f" "/opt/claude-box/$f"; done
rm -rf "$new"

id claude-box >/dev/null 2>&1 || useradd --system --home-dir /var/lib/claude-box --shell /usr/sbin/nologin claude-box
install -d -m 700 -o claude-box -g claude-box /var/lib/claude-box

# The key and the port, kept where only root reads them.
env_file="$conf/env"
old() { [ -f "$env_file" ] && sed -n "s/^$1=//p" "$env_file" | head -n 1 || true; }
key="$given_key"
[ -n "$key" ] || [ "$new_key" = 1 ] || key="$(old BOX_KEY)"
[ -n "$key" ] || key="$("$node" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
[ -n "$port" ] || port="$(old PORT)"
[ -n "$port" ] || port=8790
case "$port" in ''|*[!0-9]*) echo "--port needs a number" >&2; exit 1 ;; esac
install -d -m 700 "$conf"
(
  umask 077
  printf 'BOX_KEY=%s\nPORT=%s\nBOX_HOST=127.0.0.1\n' "$key" "$port" > "$env_file"
)

cat > "$box_unit" <<EOF
[Unit]
Description=Claude box for Aelios-resident (127.0.0.1 only)
After=network-online.target
Wants=network-online.target

[Service]
User=claude-box
Group=claude-box
EnvironmentFile=$env_file
Environment=HOME=/var/lib/claude-box NODE_ENV=production
WorkingDirectory=/opt/claude-box
ExecStart=$node server.mjs
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/claude-box
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
LockPersonality=yes
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

if [ "$tunnel" = 1 ]; then
  if ! command -v cloudflared >/dev/null; then
    if command -v apt-get >/dev/null; then
      . /etc/os-release
      install -d -m 755 /usr/share/keyrings
      curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
      echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared ${VERSION_CODENAME:-bookworm} main" > /etc/apt/sources.list.d/cloudflared.list
      apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q cloudflared
    else
      echo "--tunnel needs cloudflared: install it, then run this again" >&2
      exit 1
    fi
  fi
  # A machine without IPv4 (the free Google Cloud one) reaches Cloudflare over IPv6.
  edge=auto
  [ -n "$(ip -4 route show default 2>/dev/null)" ] || edge=6
  (
    umask 077
    printf 'TUNNEL_TOKEN=%s\nTUNNEL_EDGE_IP_VERSION=%s\n' "$token" "$edge" > "$conf/tunnel"
  )
  cat > "$tunnel_unit" <<EOF
[Unit]
Description=Cloudflare Tunnel to the Claude box
After=network-online.target claude-box.service
Wants=network-online.target

[Service]
EnvironmentFile=$conf/tunnel
ExecStart=$(command -v cloudflared) --no-autoupdate tunnel run
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable claude-box >/dev/null 2>&1
systemctl restart claude-box
if [ "$tunnel" = 1 ]; then
  systemctl enable claude-box-tunnel >/dev/null 2>&1
  systemctl restart claude-box-tunnel
fi

up=""
for _ in $(seq 1 30); do
  up="$(curl -fsS -m 2 "http://127.0.0.1:$port/health" 2>/dev/null || true)"
  [ "$up" = ok ] && break
  sleep 1
done
if [ "$up" != ok ]; then
  echo "the box did not start; see: journalctl -u claude-box -n 50" >&2
  exit 1
fi

echo
say "running on 127.0.0.1:$port (nothing listens outside this machine)"
if [ "$tunnel" = 1 ]; then
  say "tunnel started; see: systemctl status claude-box-tunnel"
else
  echo "next: a Cloudflare Tunnel public hostname (e.g. claude-box.<your domain>) -> http://127.0.0.1:$port"
fi
echo "then on the resident's settings page (供应商): the box address https://<that hostname>, and the box key from:"
echo "  sudo sed -n 's/^BOX_KEY=//p' $env_file"
if [ "$show_key" = 1 ]; then
  echo
  echo "box key: $key"
fi
