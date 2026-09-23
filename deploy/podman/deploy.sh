#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/../.." && pwd)"
cd "$HERE"

die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }
say(){ printf '\n==> %s\n' "$*"; }

command -v podman >/dev/null || die "Podman is required."
podman compose version >/dev/null 2>&1 || die "A Podman Compose provider is required (podman compose)."
command -v python3 >/dev/null || die "python3 is required."
command -v openssl >/dev/null || die "openssl is required."
command -v curl >/dev/null || die "curl is required."

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  LOW_PORT="$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)"
  if [[ "$LOW_PORT" -gt 80 ]]; then
    cat >&2 <<'EOF'
Rootless Podman is supported and preferred, but this host does not currently
allow an unprivileged process to bind ports 80/443.

Run this one-time host setting, then rerun deploy.sh as your normal user:

  echo 'net.ipv4.ip_unprivileged_port_start=80' | doas tee /etc/sysctl.d/90-rootless-web.conf
  doas sysctl --system
EOF
    exit 2
  fi
fi

MODE="mainnet"
case "${1:-}" in
  --stagenet) MODE="stagenet" ;;
  --mainnet|"") MODE="mainnet" ;;
  *) die "usage: $0 [--stagenet|--mainnet]" ;;
esac

if [[ ! -f .env ]]; then
  cp .env.example .env
  say "Created deploy/podman/.env with Glowstr defaults. Edit APP_DOMAIN/RELAY_DOMAIN if you use different DNS names."
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

[[ -n "${APP_DOMAIN:-}" ]] || die "APP_DOMAIN is empty in .env"
[[ -n "${RELAY_DOMAIN:-}" ]] || die "RELAY_DOMAIN is empty in .env"
[[ -n "${CROSSPOST_ALLOWED_PUBKEYS:-}" ]] || die "Set CROSSPOST_ALLOWED_PUBKEYS in .env to your 64-character hex Nostr public key."
python3 - "$CROSSPOST_ALLOWED_PUBKEYS" <<'PY'
import re,sys
keys=[x.strip() for x in sys.argv[1].split(",") if x.strip()]
if not keys or any(not re.fullmatch(r"[0-9a-fA-F]{64}",x) for x in keys):
    raise SystemExit("CROSSPOST_ALLOWED_PUBKEYS must contain only comma-separated 64-character hex public keys")
PY
[[ "$APP_DOMAIN" != "example.com" ]] || die "Set a real APP_DOMAIN."
[[ "$RELAY_DOMAIN" != "relay.example.com" ]] || die "Set a real RELAY_DOMAIN."

case "$(uname -m)" in
  x86_64|amd64)
    MONERO_ARCH=x64
    MONERO_ARCHIVE=monero-linux-x64-v0.18.5.1.tar.bz2
    MONERO_SHA256=22a7dda7b0cb699fdd6b7674c3b4a4465b337cc98a54983523b759e1e7cc9958
    ;;
  aarch64|arm64)
    MONERO_ARCH=armv8
    MONERO_ARCHIVE=monero-linux-armv8-v0.18.5.1.tar.bz2
    MONERO_SHA256=c0caf042cb7c7b760f5ad6be188084b59352440b32990a78b8051497b9398dbc
    ;;
  *) die "Unsupported CPU architecture: $(uname -m)" ;;
esac

if [[ "$MODE" == "stagenet" ]]; then
  MONERO_NETWORK=stagenet
  MONERO_NETWORK_FLAG=--stagenet
  MONERO_WALLET_NAME=glowstr-stagenet
else
  MONERO_NETWORK=mainnet
  MONERO_NETWORK_FLAG=
  MONERO_WALLET_NAME=glowstr-mainnet
fi
export MONERO_ARCH MONERO_ARCHIVE MONERO_SHA256 MONERO_NETWORK MONERO_NETWORK_FLAG MONERO_WALLET_NAME

# Persist detected architecture/network without storing secrets.
python3 - "$MODE" <<'PY'
from pathlib import Path
import os, sys
p=Path(".env")
lines=p.read_text().splitlines()
vals={
 "MONERO_NETWORK": os.environ["MONERO_NETWORK"],
 "MONERO_NETWORK_FLAG": os.environ.get("MONERO_NETWORK_FLAG",""),
 "MONERO_WALLET_NAME": os.environ["MONERO_WALLET_NAME"],
 "MONERO_ARCH": os.environ["MONERO_ARCH"],
 "MONERO_ARCHIVE": os.environ["MONERO_ARCHIVE"],
 "MONERO_SHA256": os.environ["MONERO_SHA256"],
}
seen=set(); out=[]
for line in lines:
    k=line.split("=",1)[0] if "=" in line and not line.lstrip().startswith("#") else None
    if k in vals:
        out.append(f"{k}={vals[k]}"); seen.add(k)
    else:
        out.append(line)
for k,v in vals.items():
    if k not in seen: out.append(f"{k}={v}")
p.write_text("\n".join(out)+"\n")
PY

mkdir -p secrets generated
chmod 700 secrets generated
[[ -s secrets/admin_token ]] || openssl rand -hex 32 > secrets/admin_token
[[ -s secrets/rpc_password ]] || openssl rand -base64 36 | tr -d '\n' > secrets/rpc_password
[[ -s secrets/wallet_password ]] || openssl rand -base64 48 | tr -d '\n' > secrets/wallet_password
[[ -s secrets/crosspost_encryption_key ]] || openssl rand -hex 32 > secrets/crosspost_encryption_key
chmod 600 secrets/*

say "Generating deployment-specific Glowstr and strfry configuration"
python3 - "$ROOT" "$APP_DOMAIN" "$RELAY_DOMAIN" <<'PY'
from pathlib import Path
import sys, re, hashlib, base64
root=Path(sys.argv[1]); app=sys.argv[2]; relay=sys.argv[3]
src=(root/"glowstr-v5.3-bluetooth-direct.html").read_text()
src=src.replace("wss://relay.glowstr.com/", f"wss://{relay}/")
src=src.replace("https://relay.glowstr.com", f"https://{relay}")
# Use the current Commerce API for the hosted app instead of the retired v4 /api/xmr routes.
src=src.replace("apiBase: '/xmr-commerce/v1'", f"apiBase: 'https://{relay}/xmr-commerce/v1'")
src=src.replace("NIP-42 AUTHENTICATED", "NIP-42 AUTHENTICATED · XMR CHECK ON WRITE")
src=re.sub(
    r"async function glowstrCheckMembershipV42\(\)\{[\s\S]*?\n\}\nfunction glowstrPayOpenV42",
    "async function glowstrCheckMembershipV42(){\\n  const entry=glowstrFirstPartyEntryV42(); const ws=entry?.[1]?.ws;\\n  if(!ws || ws.readyState!==WebSocket.OPEN){glowstrSetMembershipV42('DISCONNECTED');showToast('Connect to the Glowstr relay first');return false;}\\n  if(ws._glowstrAuthedV42){glowstrSetMembershipV42('NIP-42 AUTHENTICATED · XMR CHECK ON WRITE');showToast('XMR membership is enforced privately when you publish');return true;}\\n  glowstrSetMembershipV42('WAITING FOR NIP-42 AUTH');return false;\\n}\\nfunction glowstrPayOpenV42",
    src, count=1)
src=re.sub(
    r"async function glowstrPayRelayV42\(\)\{[\s\S]*?\n\}\nfunction initGlowstrV42",
    "async function glowstrPayRelayV42(){\\n  return buyXmrFeature('relay_30d', GLOWSTR_RELAY_V42.relay);\\n}\\nfunction initGlowstrV42",
    src, count=1)
scripts=re.findall(r"<script>([\s\S]*?)</script>", src, flags=re.I)
if len(scripts)!=1:
    raise SystemExit(f"expected one inline executable script, found {len(scripts)}")
digest=base64.b64encode(hashlib.sha256(scripts[0].encode()).digest()).decode()
src=re.sub(r"'sha256-[^']+'", f"'sha256-{digest}'", src, count=1)
Path("generated/index.html").write_text(src)

conf=(root/"xmr-relay/strfry.conf").read_text()
conf=conf.replace("wss://relay.glowstr.com/", f"wss://{relay}/")
conf=re.sub(r'bind\s*=\s*"[^"]+"', 'bind = "127.0.0.1"', conf, count=1)
Path("generated/strfry.conf").write_text(conf)
PY

say "Building the verified Monero image plus Glowstr services"
podman compose build monerod commerce crosspost relay

say "Starting local Monero node ($MODE)"
podman compose up -d monerod

say "Waiting for monerod RPC"
for _ in $(seq 1 120); do
  if curl -fsS -m 2 -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":"0","method":"get_info"}' \
    http://127.0.0.1:18081/json_rpc >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -fsS -m 3 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"0","method":"get_info"}' http://127.0.0.1:18081/json_rpc >/dev/null 2>&1 || die "monerod RPC did not become ready. Run: podman compose logs monerod"

MONERO_IMAGE="localhost/glowstr-monero:${MONERO_VERSION}-${MONERO_ARCH}"
podman volume inspect glowstr-xmr-wallet >/dev/null 2>&1 || podman volume create glowstr-xmr-wallet >/dev/null

if ! podman run --rm -v glowstr-xmr-wallet:/wallet "$MONERO_IMAGE" test -f "/wallet/${MONERO_WALLET_NAME}.keys"; then
  cat <<EOF

A dedicated $MODE receiving wallet must be created once.
The next command is interactive and will display the wallet's recovery seed.

*** WRITE THE SEED DOWN OFFLINE. DO NOT PASTE IT INTO CHAT, .env, GITHUB, OR LOGS. ***
When wallet creation finishes, type: exit

EOF
  read -r -p "Press Enter to create the wallet, or Ctrl-C to stop. "
  podman run --rm -it --network host     -v glowstr-xmr-wallet:/wallet     -v "$HERE/secrets:/run/secrets:ro,Z"     "$MONERO_IMAGE" /bin/sh -ec     'exec monero-wallet-cli '"${MONERO_NETWORK_FLAG:-}"' --generate-new-wallet "/wallet/'"${MONERO_WALLET_NAME}"'" --password-file /run/secrets/wallet_password --daemon-address 127.0.0.1:18081'
fi

say "Starting wallet RPC, Commerce, Crosspost, XMR-gated Nostr relay and Caddy"
podman compose up -d wallet-rpc commerce crosspost relay caddy

say "Waiting for Commerce health endpoint"
for _ in $(seq 1 60); do
  if curl -fsS -m 2 http://127.0.0.1:8787/health >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS -m 3 http://127.0.0.1:8787/health || {
  echo
  podman compose logs --tail=100 wallet-rpc commerce
  die "Commerce did not become healthy."
}

say "Waiting for Crosspost health endpoint"
for _ in $(seq 1 60); do
  if curl -fsS -m 2 http://127.0.0.1:8790/health >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS -m 3 http://127.0.0.1:8790/health || {
  echo
  podman compose logs --tail=100 crosspost
  die "Crosspost did not become healthy."
}

cat <<EOF

Glowstr XMR stack is running.

Web app:       https://$APP_DOMAIN/
Nostr relay:   wss://$RELAY_DOMAIN/
Commerce:      https://$APP_DOMAIN/xmr-commerce/v1/
Crosspost:     https://$APP_DOMAIN/crosspost/
Local monerod: http://127.0.0.1:18081
Local wallet:  http://127.0.0.1:18083

Useful commands:
  cd $HERE
  podman compose ps
  podman compose logs -f --tail=100
  podman compose restart
  podman compose down

IMPORTANT:
  - DNS for $APP_DOMAIN and $RELAY_DOMAIN must point to this server.
  - Allow inbound TCP 80/443. Monero P2P/RPC and internal Glowstr ports stay on loopback.
  - The node can take a long time to sync. Payment detection is reliable only after the wallet/node is synchronized.
  - Back up the wallet seed you recorded, Crosspost encryption key, and Commerce/Crosspost/relay data volumes.
EOF
