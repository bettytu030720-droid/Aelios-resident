#!/usr/bin/env bash
# Makes the Claude box's machine on Google Cloud's free tier, with gcloud (Cloud Shell has it signed in already):
# one e2-micro in a US region with IPv6 only (so no IPv4 address to pay for) and a 30 GB standard disk. On every boot
# it runs the newest install.sh from GitHub, which installs the box and its Cloudflare Tunnel. See docs/claude-box.md.
#
#   bash gcp.sh --hostname claude-box.example.com   asks for the tunnel token (it does not show), makes it all, and
#                                                   waits until the box answers at that hostname
#   bash gcp.sh ... --tunnel-token-stdin            the token from stdin instead of asking
#   bash gcp.sh ... --key-to-worker                 the box key straight into the resident Worker's CLAUDE_BOX_KEY
#                                                   secret (run it in the resident's folder, with wrangler logged in)
#   bash gcp.sh ... --show-key                      print the box key at the end
#   bash gcp.sh ... --new-key                       a new box key (then give the resident the new one)
#   bash gcp.sh --project ID --zone us-west1-b --name claude-box
#   bash gcp.sh --update                            restart the machine, which brings the box up to date
#   bash gcp.sh --delete                            delete the machine and its network
#
# Run it again to change the tunnel token; the key stays unless --new-key.
set -euo pipefail

project=""
zone="us-west1-b"
name="claude-box"
hostname=""
token_stdin=0
key_to_worker=0
show_key=0
new_key=0
update=0
delete=0
repo="${BOX_REPO:-wusaki0723/Aelios-resident}"
ref="${BOX_REF:-main}"

while [ $# -gt 0 ]; do
  case "$1" in
    --project) project="${2:-}"; shift ;;
    --zone) zone="${2:-}"; shift ;;
    --name) name="${2:-}"; shift ;;
    --hostname) hostname="${2:-}"; shift ;;
    --tunnel-token-stdin) token_stdin=1 ;;
    --key-to-worker) key_to_worker=1 ;;
    --show-key) show_key=1 ;;
    --new-key) new_key=1 ;;
    --update) update=1 ;;
    --delete) delete=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done

say() { echo "claude-box: $*"; }
command -v gcloud >/dev/null || { echo "gcloud is needed: use Cloud Shell (https://shell.cloud.google.com), or install the Google Cloud CLI" >&2; exit 1; }
[ -n "$project" ] || project="$(gcloud config get-value project 2>/dev/null || true)"
[ -n "$project" ] || { echo "no project: add --project <id> (gcloud projects list shows them)" >&2; exit 1; }
region="${zone%-*}"
case "$region" in
  us-west1|us-central1|us-east1) ;;
  *) say "note: the free e2-micro is only in us-west1, us-central1 and us-east1; one in $zone is billed" ;;
esac
hostname="${hostname#https://}"
hostname="${hostname%%/*}"
g() { gcloud --project "$project" --quiet "$@"; }
# exists <group> [flags]: whether $name is there, e.g. exists "networks subnets" --region us-west1
exists() {
  local group="$1"
  shift
  # shellcheck disable=SC2086
  g compute $group describe "$name" "$@" --format='value(name)' >/dev/null 2>&1
}
new_key() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
health() { [ -n "$hostname" ] && [ "$(curl -fsS -m 5 "https://$hostname/health" 2>/dev/null || true)" = ok ]; }

if [ "$delete" = 1 ]; then
  if exists instances --zone "$zone"; then g compute instances delete "$name" --zone "$zone"; fi
  if exists "networks subnets" --region "$region"; then g compute networks subnets delete "$name" --region "$region"; fi
  if exists networks; then g compute networks delete "$name"; fi
  say "deleted (the tunnel stays in Cloudflare: delete it there if you no longer need it)"
  exit 0
fi

if [ "$update" = 1 ]; then
  exists instances --zone "$zone" || { echo "no machine $name in $zone yet" >&2; exit 1; }
  g compute instances reset "$name" --zone "$zone"
  say "restarted: it installs the newest box as it boots, back in a few minutes"
  exit 0
fi

# What the machine runs on every boot: the newest install.sh, which takes the key and the token from the metadata.
startup="$(mktemp)"
trap 'rm -f "$startup"' EXIT
cat > "$startup" <<EOF
#!/bin/bash
# The Claude box (Aelios-resident claude-box/gcp.sh): bring it up to date and start it.
md() { for b in http://metadata.google.internal "http://[fd20:ce::254]" http://169.254.169.254; do curl -fsS -m 3 -H "Metadata-Flavor: Google" "\$b/computeMetadata/v1/instance/attributes/\$1" && return; done; }
repo="\$(md box-repo)"
ref="\$(md box-ref)"
curl -fsSL --retry 5 -o /run/claude-box-install.sh "https://raw.githubusercontent.com/\${repo:-$repo}/\${ref:-$ref}/claude-box/install.sh" && exec bash /run/claude-box-install.sh --gcp
EOF

token=""
if [ "$token_stdin" = 1 ]; then
  read -r token || true
elif [ -t 0 ]; then
  read -rsp "Cloudflare Tunnel token (it does not show; Enter keeps the one the machine has): " token
  echo
fi

say "project $project, zone $zone"
# Compute Engine needs billing on, free tier or not; turning it on takes a minute the first time.
g services enable compute.googleapis.com

exists networks || g compute networks create "$name" --subnet-mode=custom
exists "networks subnets" --region "$region" ||
  g compute networks subnets create "$name" --network "$name" --region "$region" --stack-type=IPV6_ONLY --ipv6-access-type=EXTERNAL

key=""
if ! exists instances --zone "$zone"; then
  [ -n "$token" ] || { echo "a new machine needs the tunnel token" >&2; exit 1; }
  key="$(new_key)"
  # The key and the token go straight into the machine's metadata (only this project sees it), never onto a disk here.
  g compute instances create "$name" --zone "$zone" \
    --machine-type=e2-micro \
    --network-interface="subnet=$name,stack-type=IPV6_ONLY,ipv6-network-tier=PREMIUM" \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=30GB --boot-disk-type=pd-standard \
    --metadata "box-repo=$repo,box-ref=$ref" \
    --metadata-from-file startup-script="$startup",box-key=<(printf %s "$key"),tunnel-token=<(printf %s "$token")
else
  [ "$new_key" = 1 ] && key="$(new_key)"
  if [ -n "$token" ] && [ -n "$key" ]; then
    g compute instances add-metadata "$name" --zone "$zone" --metadata "box-repo=$repo,box-ref=$ref" \
      --metadata-from-file startup-script="$startup",box-key=<(printf %s "$key"),tunnel-token=<(printf %s "$token")
  elif [ -n "$token" ]; then
    g compute instances add-metadata "$name" --zone "$zone" --metadata "box-repo=$repo,box-ref=$ref" \
      --metadata-from-file startup-script="$startup",tunnel-token=<(printf %s "$token")
  elif [ -n "$key" ]; then
    g compute instances add-metadata "$name" --zone "$zone" --metadata "box-repo=$repo,box-ref=$ref" \
      --metadata-from-file startup-script="$startup",box-key=<(printf %s "$key")
  fi
  if [ -n "$token" ] || [ -n "$key" ]; then g compute instances reset "$name" --zone "$zone"; fi
fi
if [ -z "$key" ]; then
  key="$(g compute instances describe "$name" --zone "$zone" --format=json | python3 -c 'import json, sys
items = json.load(sys.stdin).get("metadata", {}).get("items", [])
print(next((i["value"] for i in items if i["key"] == "box-key"), ""), end="")')"
fi

if [ -n "$hostname" ]; then
  say "waiting for https://$hostname/health (the first boot installs Node.js and Claude Code: about 5 minutes)"
  for _ in $(seq 1 60); do health && break; sleep 10; done
  if health; then
    say "the box answers at https://$hostname"
  else
    say "no answer yet. What the machine is doing:"
    echo "  gcloud compute instances get-serial-port-output $name --zone $zone --project $project | grep -E 'startup-script|claude-box' | tail -30"
  fi
fi

if [ "$key_to_worker" = 1 ]; then
  printf %s "$key" | npx wrangler secret put CLAUDE_BOX_KEY
  say "the box key is in the resident Worker's CLAUDE_BOX_KEY secret"
fi

echo
say "next, on the resident's settings page (供应商 → Claude 订阅): the box address https://${hostname:-<the tunnel hostname>}"
if [ "$show_key" = 1 ]; then
  echo "and the box key: $key"
elif [ "$key_to_worker" = 0 ]; then
  echo "and the box key, which this shows: bash gcp.sh --show-key (Enter at the token question keeps the token)"
fi
