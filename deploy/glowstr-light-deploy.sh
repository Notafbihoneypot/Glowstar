#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Glowstr Crosspost + XMR lightweight one-file deployer
#
# Purpose:
#   - No local monerod / no local blockchain
#   - Dedicated VIEW-ONLY Monero wallet on this VM
#   - Remote Monero node for blockchain access
#   - No private spend key on this VM
#   - Unique subaddress per invoice
#   - XMR payment -> confirmations -> automatic 30-day Crosspost access
#
# Recommended target:
#   Dedicated Debian 12/13 VM on Proxmox VE.
#
# Usage:
#   chmod +x glowstr-light-deploy.sh
#   ./glowstr-light-deploy.sh
#
# Optional overrides:
#   GLOWSTR_NETWORK=mainnet
#   APP_DOMAIN=crosspost.example.com
#   CROSSPOST_ALLOWED_PUBKEYS=<64-char-hex-nostr-pubkey>
#   MONERO_REMOTE_NODE=https://your-trusted-node.example:18089
#
# By default this starts in:
#   - stagenet
#   - CROSSPOST_PREVIEW_ONLY=true

REPO_URL="${GLOWSTR_REPO_URL:-https://github.com/Notafbihoneypot/Glowstar.git}"
BRANCH="${GLOWSTR_BRANCH:-codex/crosspost-bridge}"
INSTALL_DIR="${GLOWSTR_INSTALL_DIR:-$HOME/glowstr-light}"
NETWORK="${GLOWSTR_NETWORK:-stagenet}"
ALLOW_PVE_HOST="${GLOWSTR_ALLOW_PVE_HOST:-0}"

say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn(){ printf '\n\033[1;33mWARNING: %s\033[0m\n' "$*" >&2; }
die(){ printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

if [[ -d /etc/pve && "$ALLOW_PVE_HOST" != "1" ]]; then
  cat >&2 <<'EOF'
This appears to be the Proxmox VE host.

Run this inside a dedicated Debian VM instead of directly on PVE.
That keeps wallet files, OAuth credentials, and container networking
isolated from the hypervisor.

Override only if you deliberately accept that risk:
  GLOWSTR_ALLOW_PVE_HOST=1 ./glowstr-light-deploy.sh
EOF
  exit 2
fi

case "$NETWORK" in
  stagenet|mainnet) ;;
  *) die "GLOWSTR_NETWORK must be stagenet or mainnet." ;;
esac

if [[ "$NETWORK" == "mainnet" ]]; then
  warn "MAINNET selected. Real XMR can be received."
  read -r -p "Type MAINNET to continue: " confirm
  [[ "$confirm" == "MAINNET" ]] || die "Mainnet deployment cancelled."
fi

PRIV=""
if command -v doas >/dev/null 2>&1; then
  PRIV="doas"
elif command -v sudo >/dev/null 2>&1; then
  PRIV="sudo"
elif [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  PRIV=""
else
  die "Need doas, sudo, or root access to install packages and adjust sysctl."
fi

need_packages=0
for cmd in git curl openssl python3 podman; do
  command -v "$cmd" >/dev/null 2>&1 || need_packages=1
done
podman compose version >/dev/null 2>&1 || need_packages=1

if [[ "$need_packages" -eq 1 ]]; then
  command -v apt-get >/dev/null 2>&1 || die "Install git curl openssl python3 podman podman-compose uidmap slirp4netns fuse-overlayfs, then rerun."
  say "Installing Podman and dependencies"
  $PRIV apt-get update
  $PRIV apt-get install -y \
    git curl openssl python3 podman podman-compose \
    uidmap slirp4netns fuse-overlayfs ca-certificates
fi

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  warn "Rootless Podman is preferred. Consider rerunning as a normal VM user."
fi

LOW_PORT="$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)"
if [[ "$LOW_PORT" -gt 80 ]]; then
  say "Allowing rootless Podman to bind HTTPS ports"
  printf '%s\n' 'net.ipv4.ip_unprivileged_port_start=80' \
    | $PRIV tee /etc/sysctl.d/90-glowstr-rootless-web.conf >/dev/null
  $PRIV sysctl --system >/dev/null
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  say "Updating Glowstr source"
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  say "Cloning Glowstr"
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
fi

ROOT="$INSTALL_DIR"
DEPLOY="$ROOT/deploy/light-xmr"
mkdir -p "$DEPLOY/secrets"
cd "$DEPLOY"
chmod 700 "$DEPLOY/secrets"

prompt_value() {
  local var="$1" prompt="$2" default="${3:-}"
  local current="${!var:-}"
  if [[ -n "$current" ]]; then
    printf -v "$var" '%s' "$current"
    return
  fi
  local value=""
  read -r -p "$prompt${default:+ [$default]}: " value
  value="${value:-$default}"
  printf -v "$var" '%s' "$value"
}

APP_DOMAIN="${APP_DOMAIN:-}"
CROSSPOST_ALLOWED_PUBKEYS="${CROSSPOST_ALLOWED_PUBKEYS:-}"
MONERO_REMOTE_NODE="${MONERO_REMOTE_NODE:-}"
MONERO_RESTORE_HEIGHT="${MONERO_RESTORE_HEIGHT:-0}"
CROSSPOST_X_CLIENT_ID="${CROSSPOST_X_CLIENT_ID:-}"
GLOWSTR_XMR_CROSSPOST_30D_ATOMIC="${GLOWSTR_XMR_CROSSPOST_30D_ATOMIC:-20000000000}"
GLOWSTR_XMR_CONFIRMATIONS="${GLOWSTR_XMR_CONFIRMATIONS:-2}"

prompt_value APP_DOMAIN "HTTPS domain for Crosspost (DNS must point to this VM)"
prompt_value CROSSPOST_ALLOWED_PUBKEYS "64-character HEX Nostr pubkey (NOT npub/nsec)"
prompt_value MONERO_REMOTE_NODE "Remote Monero node URL (must match $NETWORK)"
prompt_value MONERO_RESTORE_HEIGHT "Wallet restore height (0 if unsure)" "0"
prompt_value CROSSPOST_X_CLIENT_ID "X OAuth Client ID (optional)" ""

[[ -n "$APP_DOMAIN" ]] || die "APP_DOMAIN is required."
[[ -n "$MONERO_REMOTE_NODE" ]] || die "MONERO_REMOTE_NODE is required."
[[ "$MONERO_RESTORE_HEIGHT" =~ ^[0-9]+$ ]] || die "MONERO_RESTORE_HEIGHT must be an integer."

python3 - "$CROSSPOST_ALLOWED_PUBKEYS" "$MONERO_REMOTE_NODE" <<'PY'
import re, sys, urllib.parse
keys=[x.strip() for x in sys.argv[1].split(",") if x.strip()]
if not keys or any(not re.fullmatch(r"[0-9a-fA-F]{64}", x) for x in keys):
    raise SystemExit("CROSSPOST_ALLOWED_PUBKEYS must contain comma-separated 64-character HEX public keys.")
u=urllib.parse.urlparse(sys.argv[2])
if u.scheme not in ("http","https") or not u.hostname:
    raise SystemExit("MONERO_REMOTE_NODE must be an http:// or https:// URL.")
PY

[[ -s secrets/admin_token ]] || openssl rand -hex 32 > secrets/admin_token
[[ -s secrets/rpc_password ]] || openssl rand -base64 36 | tr -d '\n' > secrets/rpc_password
[[ -s secrets/wallet_password ]] || openssl rand -base64 48 | tr -d '\n' > secrets/wallet_password
[[ -s secrets/crosspost_encryption_key ]] || openssl rand -hex 32 > secrets/crosspost_encryption_key
chmod 600 secrets/*

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

MONERO_VERSION=0.18.5.1
MONERO_WALLET_NAME="glowstr-view-${NETWORK}"
MONERO_NETWORK_FLAG=""
[[ "$NETWORK" == "stagenet" ]] && MONERO_NETWORK_FLAG="--stagenet"

cat > .env <<EOF
APP_DOMAIN=$APP_DOMAIN
MONERO_NETWORK=$NETWORK
MONERO_NETWORK_FLAG=$MONERO_NETWORK_FLAG
MONERO_REMOTE_NODE=$MONERO_REMOTE_NODE
MONERO_RESTORE_HEIGHT=$MONERO_RESTORE_HEIGHT
MONERO_WALLET_NAME=$MONERO_WALLET_NAME
MONERO_VERSION=$MONERO_VERSION
MONERO_ARCH=$MONERO_ARCH
MONERO_ARCHIVE=$MONERO_ARCHIVE
MONERO_SHA256=$MONERO_SHA256

CROSSPOST_ALLOWED_PUBKEYS=$CROSSPOST_ALLOWED_PUBKEYS
CROSSPOST_PREVIEW_ONLY=true
CROSSPOST_X_CLIENT_ID=$CROSSPOST_X_CLIENT_ID
CROSSPOST_MASTODON_HOSTS=mastodon.social,fosstodon.org,hachyderm.io
CROSSPOST_ACTIVITYPUB_HOSTS=
CROSSPOST_BLUESKY_HOSTS=bsky.social
CROSSPOST_NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol
CROSSPOST_DAILY_LIMIT=25

GLOWSTR_XMR_CONFIRMATIONS=$GLOWSTR_XMR_CONFIRMATIONS
GLOWSTR_XMR_CROSSPOST_30D_ATOMIC=$GLOWSTR_XMR_CROSSPOST_30D_ATOMIC
GLOWSTR_XMR_MAX_PENDING_PER_PUBKEY=5
GLOWSTR_XMR_MAX_INVOICES_PER_HOUR=500
EOF
chmod 600 .env

cat > compose.yaml <<'EOF'
name: glowstr-light-xmr

services:
  wallet-rpc:
    build:
      context: ../podman/monero
      args:
        MONERO_VERSION: ${MONERO_VERSION}
        MONERO_ARCHIVE: ${MONERO_ARCHIVE}
        MONERO_SHA256: ${MONERO_SHA256}
    image: localhost/glowstr-monero:${MONERO_VERSION}-${MONERO_ARCH}
    restart: unless-stopped
    command:
      - /bin/sh
      - -ec
      - |
        test -f "/wallet/${MONERO_WALLET_NAME}.keys" || { echo "View-only wallet not initialized."; exit 1; }
        exec monero-wallet-rpc ${MONERO_NETWORK_FLAG:-} \
          --wallet-file "/wallet/${MONERO_WALLET_NAME}" \
          --password-file /run/secrets/wallet_password \
          --daemon-address "${MONERO_REMOTE_NODE}" \
          --untrusted-daemon \
          --rpc-bind-ip 0.0.0.0 \
          --rpc-bind-port 18083 \
          --rpc-login "glowstr:$$(cat /run/secrets/rpc_password)" \
          --non-interactive \
          --log-level=0
    volumes:
      - monero-wallet:/wallet
      - ./secrets:/run/secrets:ro,Z

  commerce:
    build: ../../monero-commerce
    restart: unless-stopped
    depends_on:
      - wallet-rpc
    environment:
      GLOWSTR_COMMERCE_HOST: 0.0.0.0
      GLOWSTR_COMMERCE_PORT: "8787"
      GLOWSTR_COMMERCE_DB: /data/commerce.sqlite3
      MONERO_WALLET_RPC: http://wallet-rpc:18083/json_rpc
      MONERO_RPC_USER: glowstr
      MONERO_RPC_PASS_FILE: /run/secrets/rpc_password
      GLOWSTR_COMMERCE_ADMIN_TOKEN_FILE: /run/secrets/admin_token
      GLOWSTR_XMR_CONFIRMATIONS: ${GLOWSTR_XMR_CONFIRMATIONS}
      GLOWSTR_XMR_CROSSPOST_30D_ATOMIC: ${GLOWSTR_XMR_CROSSPOST_30D_ATOMIC}
      GLOWSTR_XMR_MAX_PENDING_PER_PUBKEY: ${GLOWSTR_XMR_MAX_PENDING_PER_PUBKEY}
      GLOWSTR_XMR_MAX_INVOICES_PER_HOUR: ${GLOWSTR_XMR_MAX_INVOICES_PER_HOUR}
    volumes:
      - commerce-data:/data
      - ./secrets:/run/secrets:ro,Z

  crosspost:
    build: ../../crosspost
    restart: unless-stopped
    depends_on:
      - commerce
    environment:
      CROSSPOST_PUBLIC_URL: https://${APP_DOMAIN}/crosspost
      CROSSPOST_ALLOWED_PUBKEYS: ${CROSSPOST_ALLOWED_PUBKEYS}
      CROSSPOST_PREVIEW_ONLY: ${CROSSPOST_PREVIEW_ONLY}
      CROSSPOST_HOST: 0.0.0.0
      CROSSPOST_PORT: "8790"
      CROSSPOST_DATA: /data
      CROSSPOST_ENCRYPTION_KEY_FILE: /run/secrets/crosspost_encryption_key
      CROSSPOST_MASTODON_HOSTS: ${CROSSPOST_MASTODON_HOSTS}
      CROSSPOST_ACTIVITYPUB_HOSTS: ${CROSSPOST_ACTIVITYPUB_HOSTS}
      CROSSPOST_BLUESKY_HOSTS: ${CROSSPOST_BLUESKY_HOSTS}
      CROSSPOST_X_CLIENT_ID: ${CROSSPOST_X_CLIENT_ID}
      CROSSPOST_NOSTR_RELAYS: ${CROSSPOST_NOSTR_RELAYS}
      CROSSPOST_DAILY_LIMIT: ${CROSSPOST_DAILY_LIMIT}
      CROSSPOST_COMMERCE_URL: http://commerce:8787
      CROSSPOST_ENTITLEMENT_FEATURE: crosspost_30d
      CROSSPOST_ENTITLEMENT_TARGET: ""
      GLOWSTR_COMMERCE_ADMIN_TOKEN_FILE: /run/secrets/admin_token
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:size=64m,mode=1777
    volumes:
      - crosspost-data:/data
      - ./secrets:/run/secrets:ro,Z

  caddy:
    image: docker.io/library/caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - crosspost
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      APP_DOMAIN: ${APP_DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro,Z
      - caddy-data:/data
      - caddy-config:/config

volumes:
  monero-wallet:
    name: glowstr-light-wallet-${MONERO_NETWORK}
  commerce-data:
    name: glowstr-light-commerce-${MONERO_NETWORK}
  crosspost-data:
    name: glowstr-light-crosspost-${MONERO_NETWORK}
  caddy-data:
    name: glowstr-light-caddy
  caddy-config:
    name: glowstr-light-caddy-config
EOF

cat > Caddyfile <<'EOF'
{$APP_DOMAIN} {
    encode zstd gzip
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
    }
    handle / {
        redir /crosspost/ 302
    }
    handle /crosspost {
        redir /crosspost/ 308
    }
    handle_path /crosspost/* {
        reverse_proxy crosspost:8790
    }
    respond 404
}
EOF

say "Building verified Monero wallet image"
podman compose build wallet-rpc commerce crosspost

WALLET_VOLUME="glowstr-light-wallet-${NETWORK}"
podman volume inspect "$WALLET_VOLUME" >/dev/null 2>&1 || podman volume create "$WALLET_VOLUME" >/dev/null

if ! podman run --rm -v "$WALLET_VOLUME:/wallet" "localhost/glowstr-monero:${MONERO_VERSION}-${MONERO_ARCH}" test -f "/wallet/${MONERO_WALLET_NAME}.keys"; then
  cat <<EOF

Create the VIEW-ONLY receiving wallet.

You need:
  1. PRIMARY ADDRESS
  2. SECRET VIEW KEY

DO NOT enter:
  - mnemonic seed
  - private spend key

Restore height: $MONERO_RESTORE_HEIGHT
Remote node:   $MONERO_REMOTE_NODE

EOF
  read -r -p "Press Enter to create the view-only wallet, or Ctrl-C to stop. "
  podman run --rm -it \
    -v "$WALLET_VOLUME:/wallet" \
    -v "$DEPLOY/secrets:/run/secrets:ro,Z" \
    "localhost/glowstr-monero:${MONERO_VERSION}-${MONERO_ARCH}" \
    monero-wallet-cli ${MONERO_NETWORK_FLAG:-} \
      --generate-from-view-key "/wallet/${MONERO_WALLET_NAME}" \
      --password-file /run/secrets/wallet_password \
      --daemon-address "$MONERO_REMOTE_NODE" \
      --untrusted-daemon \
      --restore-height "$MONERO_RESTORE_HEIGHT"
fi

say "Starting lightweight stack"
podman compose up -d wallet-rpc commerce crosspost caddy

echo
podman compose ps
echo

cat <<EOF
Glowstr lightweight XMR Crosspost is starting.

Open:
  https://$APP_DOMAIN/crosspost/

There is NO local monerod and NO local blockchain.
The VM has only a view-only wallet: no spend key and no mnemonic seed.

Publishing remains CROSSPOST_PREVIEW_ONLY=true for testing.

Logs:
  cd "$DEPLOY"
  podman compose logs -f wallet-rpc
  podman compose logs -f commerce
  podman compose logs -f crosspost
EOF
