#!/usr/bin/env bash
# Installs the WeCom relay for Aelios-resident on this machine (systemd; apt for the optional ffmpeg).
#
#   sudo ./install.sh              the relay alone: text and pictures
#   sudo ./install.sh --media      also voice messages and video stickers (installs ffmpeg)
#   sudo ./install.sh --port 8790  another local port (default 8787)
#   sudo ./install.sh --show-key   print the relay key at the end (it is in /etc/wecom-relay/env either way)
#   sudo ./install.sh --uninstall  remove it all, key included
#
# Run it again any time to change these: the key stays the same unless you add --new-key.
# It opens no port to the outside: the relay listens on 127.0.0.1 only. See README.md for the Cloudflare Tunnel.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
media=""
port=""
show_key=0
new_key=0
uninstall=0

while [ $# -gt 0 ]; do
  case "$1" in
    --media) media=1 ;;
    --no-media) media=0 ;;
    --port) port="${2:-}"; shift ;;
    --show-key) show_key=1 ;;
    --new-key) new_key=1 ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done

if [ "$(id -u)" != 0 ]; then
  echo "run it with sudo" >&2
  exit 1
fi

unit=/etc/systemd/system/wecom-relay.service
if [ "$uninstall" = 1 ]; then
  systemctl disable --now wecom-relay 2>/dev/null || true
  rm -f "$unit"
  rm -rf /opt/wecom-relay /etc/wecom-relay
  systemctl daemon-reload
  echo "wecom-relay removed (ffmpeg, if it was installed, is left in place)"
  exit 0
fi

python="$(command -v python3 || true)"
if [ -z "$python" ]; then
  if command -v apt-get >/dev/null; then
    apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3
    python="$(command -v python3)"
  else
    echo "python3 is needed: install it, then run this again" >&2
    exit 1
  fi
fi

env_file=/etc/wecom-relay/env
old() { [ -f "$env_file" ] && sed -n "s/^$1=//p" "$env_file" | head -n 1 || true; }
key="$(old WECOM_RELAY_KEY)"
[ -n "$port" ] || port="$(old WECOM_RELAY_PORT)"
[ -n "$port" ] || port=8787
[ -n "$media" ] || media="$(old WECOM_RELAY_MEDIA)"
[ -n "$media" ] || media=0
case "$port" in ''|*[!0-9]*) echo "--port needs a number" >&2; exit 1 ;; esac

if [ "$media" = 1 ]; then
  if command -v apt-get >/dev/null; then
    # libavcodec-extra has the AMR encoder WeCom voice messages need; plain ffmpeg on Debian and Ubuntu does not.
    apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q ffmpeg libavcodec-extra
  elif ! command -v ffmpeg >/dev/null; then
    echo "--media needs ffmpeg (with the libopencore_amrnb encoder): install it, then run this again" >&2
    exit 1
  fi
  encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
  case "$encoders" in
    *libopencore_amrnb*) ;;
    *) echo "note: this ffmpeg has no libopencore_amrnb encoder, so voice messages will go out as text" >&2 ;;
  esac
fi

if [ -z "$key" ] || [ "$new_key" = 1 ]; then
  key="$("$python" -c 'import secrets; print(secrets.token_hex(32))')"
fi

install -d -m 755 /opt/wecom-relay
install -m 644 "$here/wecom-relay.py" /opt/wecom-relay/wecom-relay.py
install -d -m 700 /etc/wecom-relay
(
  umask 077
  cat > "$env_file" <<EOF
WECOM_RELAY_KEY=$key
WECOM_RELAY_PORT=$port
WECOM_RELAY_MEDIA=$media
EOF
)
chmod 600 "$env_file"

cat > "$unit" <<EOF
[Unit]
Description=WeCom relay for Aelios-resident (127.0.0.1 only)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$env_file
ExecStart=$python /opt/wecom-relay/wecom-relay.py
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=yes
MemoryMax=512M
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable wecom-relay >/dev/null 2>&1
systemctl restart wecom-relay

ping=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  ping="$(RELAY_KEY="$key" "$python" -c 'import os, sys, urllib.request as u
r = u.Request(sys.argv[1], headers={"X-Relay-Key": os.environ["RELAY_KEY"]})
print(u.urlopen(r, timeout=3).read().decode())' "http://127.0.0.1:$port/ping" 2>/dev/null || true)"
  [ -n "$ping" ] && break
  sleep 1
done
if [ -z "$ping" ]; then
  echo "wecom-relay did not start; see: journalctl -u wecom-relay -n 50" >&2
  exit 1
fi

echo
echo "wecom-relay is running on 127.0.0.1:$port (nothing listens outside this machine)"
echo "what it can do: $ping"
echo
echo "next:"
echo "  1. Cloudflare Tunnel: add a public hostname (e.g. wecom-relay.<your domain>) -> http://127.0.0.1:$port"
echo "  2. the resident's settings page: relay address https://wecom-relay.<your domain>, relay key from:"
echo "       sudo sed -n 's/^WECOM_RELAY_KEY=//p' $env_file"
echo "  3. WeCom's trusted IP for the app: this machine's address on the way out:"
echo "       curl -s https://ifconfig.me   (WeCom takes it only after the app's message URL is set)"
if [ "$show_key" = 1 ]; then
  echo
  echo "relay key: $key"
fi
