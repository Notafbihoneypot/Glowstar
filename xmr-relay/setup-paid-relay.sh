#!/usr/bin/env bash
set -Eeuo pipefail

# Glowstr lightweight paid XMR Nostr relay.
#
# Runs on this VPS:
#   - Caddy
#   - relay-gate (NIP-42 + paid entitlement)
#   - strfry
#   - Glowstr Commerce
#
# Does NOT run:
#   - monerod
#   - monero-wallet-rpc
#   - NIP-17 notifier
#   - Armada / LiveKit
#
# You must provide a monero-wallet-rpc endpoint. Best practice is to run that
# wallet RPC on another trusted machine and reach it over WireGuard/Tailscale
# or HTTPS with RPC authentication.
#
# Example:
#   GLOWSTR_RELAY_DOMAIN=relay.glowstr.com \
#   GLOWSTR_ALLOWED_ORIGIN=https://glowstr.com \
#   MONERO_WALLET_RPC=http://100.64.0.10:18083/json_rpc \
#   MONERO_RPC_USER=glowstr \
#   MONERO_RPC_PASS='strong-password' \
#   bash setup-paid-relay.sh

RELAY_DOMAIN="${GLOWSTR_RELAY_DOMAIN:-relay.glowstr.com}"
ALLOWED_ORIGIN="${GLOWSTR_ALLOWED_ORIGIN:-https://glowstr.com}"
RPC_URL="${MONERO_WALLET_RPC:-}"
RPC_USER="${MONERO_RPC_USER:-}"
RPC_PASS="${MONERO_RPC_PASS:-}"
AUTO_INSTALL="${AUTO_INSTALL:-1}"
AUTO_SWAP="${AUTO_SWAP:-1}"
SKIP_DNS_CHECK="${SKIP_DNS_CHECK:-0}"
ALLOW_PROXMOX_HOST="${ALLOW_PROXMOX_HOST:-0}"
ALLOW_UNAUTHENTICATED_WALLET_RPC="${ALLOW_UNAUTHENTICATED_WALLET_RPC:-0}"
ALLOW_PLAINTEXT_WALLET_RPC="${ALLOW_PLAINTEXT_WALLET_RPC:-0}"

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PAID_DIR="$HERE/paid-relay"
ENV_FILE="$HERE/.env"
COMPOSE=()

say(){ printf '\n==> %s\n' "$*"; }
warn(){ printf '\nWARNING: %s\n' "$*" >&2; }
die(){ printf '\nERROR: %s\n' "$*" >&2; exit 1; }

bool_enabled() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n1
}

validate_host() {
  [[ "$RELAY_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "Invalid GLOWSTR_RELAY_DOMAIN"
  [[ "$ALLOWED_ORIGIN" =~ ^https:// ]] || die "GLOWSTR_ALLOWED_ORIGIN must start with https://"

  if [[ -d /etc/pve ]] && ! bool_enabled "$ALLOW_PROXMOX_HOST"; then
    die "This looks like a Proxmox VE host. Run the relay inside a VPS/VM/LXC instead. Set ALLOW_PROXMOX_HOST=1 only if intentional."
  fi
}

install_deps() {
  local missing=()
  for c in podman curl openssl getent; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if (("${#missing[@]}" == 0)); then return; fi

  bool_enabled "$AUTO_INSTALL" || die "Missing dependencies: ${missing[*]}"
  [[ $EUID -eq 0 ]] || die "Run as root to auto-install: ${missing[*]}"

  if command -v apt-get >/dev/null 2>&1; then
    say "Installing Podman dependencies"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y podman podman-compose curl openssl libc-bin util-linux
  else
    die "Auto-install supports Debian/Ubuntu. Install manually: ${missing[*]}"
  fi
}

detect_compose() {
  if podman compose version >/dev/null 2>&1; then
    COMPOSE=(podman compose)
  elif command -v podman-compose >/dev/null 2>&1; then
    COMPOSE=(podman-compose)
  else
    die "No Podman Compose provider found"
  fi
}

ensure_swap() {
  local mem_kb swap_kb swapfile="/swapfile-glowstr"
  mem_kb="$(awk '/MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  swap_kb="$(awk '/SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"

  if (( mem_kb >= 900000 || swap_kb >= 524288 )); then
    return
  fi

  bool_enabled "$AUTO_SWAP" || {
    warn "Less than 1 GB RAM and no useful swap detected. Image builds may OOM."
    return
  }

  [[ $EUID -eq 0 ]] || {
    warn "Low RAM detected, but root is required to create swap. Add about 1 GB swap before building."
    return
  }

  say "Low-memory VPS detected; creating 1 GB swap"
  if [[ ! -f "$swapfile" ]]; then
    if command -v fallocate >/dev/null 2>&1; then
      fallocate -l 1G "$swapfile" || dd if=/dev/zero of="$swapfile" bs=1M count=1024 status=progress
    else
      dd if=/dev/zero of="$swapfile" bs=1M count=1024 status=progress
    fi
    chmod 600 "$swapfile"
    mkswap "$swapfile" >/dev/null
  fi

  if swapon "$swapfile" 2>/dev/null; then
    grep -qF "$swapfile none swap sw 0 0" /etc/fstab 2>/dev/null ||
      printf '%s\n' "$swapfile none swap sw 0 0" >> /etc/fstab
  else
    warn "Could not enable swap inside this VPS/container. Ask the VPS provider to add swap if builds run out of memory."
  fi
}

check_dns() {
  bool_enabled "$SKIP_DNS_CHECK" && { say "Skipping DNS check"; return; }
  say "Checking DNS for $RELAY_DOMAIN"
  getent ahosts "$RELAY_DOMAIN" >/dev/null 2>&1 ||
    die "$RELAY_DOMAIN does not resolve yet. Point its A/AAAA record at this VPS first."
}

resolve_wallet_settings() {
  [[ -n "$RPC_URL" ]] || RPC_URL="$(env_value MONERO_WALLET_RPC)"
  [[ -n "$RPC_USER" ]] || RPC_USER="$(env_value MONERO_RPC_USER)"
  [[ -n "$RPC_PASS" ]] || RPC_PASS="$(env_value MONERO_RPC_PASS)"

  [[ -n "$RPC_URL" ]] || die "Set MONERO_WALLET_RPC to your external monero-wallet-rpc endpoint"

  if [[ ! "$RPC_URL" =~ ^https:// &&
        ! "$RPC_URL" =~ ^http://127\.0\.0\.1: &&
        ! "$RPC_URL" =~ ^http://localhost: &&
        ! "$RPC_URL" =~ ^http://10\. &&
        ! "$RPC_URL" =~ ^http://192\.168\. &&
        ! "$RPC_URL" =~ ^http://172\.(1[6-9]|2[0-9]|3[01])\. &&
        ! "$RPC_URL" =~ ^http://100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]]; then
    bool_enabled "$ALLOW_PLAINTEXT_WALLET_RPC" ||
      die "Refusing plaintext wallet RPC outside loopback/private/Tailscale ranges: $RPC_URL"
  fi

  if [[ -z "$RPC_USER" || -z "$RPC_PASS" ]]; then
    bool_enabled "$ALLOW_UNAUTHENTICATED_WALLET_RPC" ||
      die "Set MONERO_RPC_USER and MONERO_RPC_PASS for wallet RPC authentication"
  fi
}

check_wallet_rpc() {
  local auth=()
  [[ -z "$RPC_USER" ]] || auth=(--digest -u "$RPC_USER:$RPC_PASS")

  say "Testing monero-wallet-rpc connection"
  local response
  response="$(curl -fsS --max-time 12 "${auth[@]}" \
    -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","id":"glowstr","method":"get_version","params":{}}' \
    "$RPC_URL")" || die "Cannot reach/authenticate to monero-wallet-rpc at $RPC_URL"

  [[ "$response" == *'"result"'* ]] ||
    die "monero-wallet-rpc did not return a valid get_version result"
}

write_env() {
  local admin
  admin="$(env_value GLOWSTR_COMMERCE_ADMIN_TOKEN)"
  if [[ ! "$admin" =~ ^[A-Za-z0-9_-]{32,}$ && ! "$admin" =~ ^[0-9a-fA-F]{64,}$ ]]; then
    admin="$(openssl rand -hex 32)"
  fi

  umask 077
  cat > "$ENV_FILE" <<EOF
# Glowstr paid relay — generated by setup-paid-relay.sh
GLOWSTR_COMMERCE_ADMIN_TOKEN=$admin

GLOWSTR_ALLOWED_ORIGIN=$ALLOWED_ORIGIN
GLOWSTR_RELAY_TARGET=$RELAY_DOMAIN

MONERO_WALLET_RPC=$RPC_URL
MONERO_RPC_USER=$RPC_USER
MONERO_RPC_PASS=$RPC_PASS

# $10 USD equivalent in XMR for 365 days.
GLOWSTR_XMR_CONFIRMATIONS=2
GLOWSTR_RELAY_USD_CENTS=1000
GLOWSTR_XMR_USD_URL=https://api.kraken.com/0/public/Ticker?pair=XMRUSD
GLOWSTR_XMR_USD_OVERRIDE=
GLOWSTR_RELAY_SECONDS=31536000
GLOWSTR_INVOICE_SECONDS=1800
GLOWSTR_LATE_PAYMENT_GRACE_SECONDS=300
GLOWSTR_RECONCILE_SECONDS=20

# Paid-write gate.
GLOWSTR_ENTITLEMENT_CACHE_SECONDS=15
GLOWSTR_GATE_MAX_AUTH_KEYS=64
GLOWSTR_GATE_PRIVACY_AUTH_GRACE_MS=15000
GLOWSTR_GATE_MAX_GRACE_WRITES=8
GLOWSTR_ALLOW_PRIVACY_WRAPPERS=true

# Renewal notifier is intentionally disabled on this tiny relay VPS.
GLOWSTR_NIP17_PUBLIC_KEY=
EOF
  chmod 600 "$ENV_FILE"
}

write_caddy() {
  mkdir -p "$PAID_DIR"
  cat > "$PAID_DIR/Caddyfile" <<EOF
$RELAY_DOMAIN {
    encode zstd gzip

    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
    }

    # Public payment API used by Glowstr.
    handle_path /xmr-commerce/* {
        reverse_proxy 127.0.0.1:8787
    }

    # Nostr WebSockets must pass through the paid/NIP-42 gate.
    @nostr_ws {
        header Connection *Upgrade*
        header Upgrade websocket
    }

    handle @nostr_ws {
        reverse_proxy 127.0.0.1:7778
    }

    # NIP-11 and ordinary HTTP go directly to loopback-only strfry.
    handle {
        reverse_proxy 127.0.0.1:7777
    }
}
EOF
}

start_stack() {
  say "Building and starting the lightweight paid relay"
  cd "$HERE"
  "${COMPOSE[@]}" -f compose.yaml -f compose.paid-relay.yaml up -d --build
}

healthcheck() {
  say "Checking local services"
  local ok=0
  for _ in $(seq 1 45); do
    if curl -fsS http://127.0.0.1:8787/ready >/dev/null 2>&1 &&
       curl -fsS http://127.0.0.1:7778/health >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 2
  done
  (( ok == 1 )) || die "Local relay services did not become healthy"

  say "Checking public HTTPS/API"
  curl -fsS --retry 12 --retry-delay 3     "https://$RELAY_DOMAIN/xmr-commerce/v1/features" >/tmp/glowstr-features.json ||
    die "Caddy/TLS/payment API is not reachable publicly"
}

print_finish() {
  cat <<EOF

============================================================
 GLOWSTR PAID XMR RELAY IS UP
============================================================
Nostr relay:
  wss://$RELAY_DOMAIN/

Payment API:
  https://$RELAY_DOMAIN/xmr-commerce/v1

Plan:
  $10 USD equivalent in XMR
  365 days
  2 confirmations
  public reads free
  paid authenticated writes

This VPS is NOT running:
  monerod
  monero-wallet-rpc
  LiveKit / Armada voice
  NIP-17 notifier

Wallet backend:
  $RPC_URL

PUBLIC PORTS:
  TCP 80
  TCP 443

KEEP PRIVATE:
  TCP 7777  strfry
  TCP 7778  paid relay gate
  TCP 8787  Commerce

Glowstr frontend should use:
  apiBase: 'https://$RELAY_DOMAIN/xmr-commerce/v1'

Logs:
  cd $HERE
  ${COMPOSE[*]} -f compose.yaml -f compose.paid-relay.yaml logs -f

Stop:
  ${COMPOSE[*]} -f compose.yaml -f compose.paid-relay.yaml down

Important:
  Back up the glowstr-commerce and glowstr-relay Podman volumes.
  Keep $ENV_FILE private; it contains the Commerce token and wallet-RPC password.
============================================================
EOF
}

main() {
  validate_host
  install_deps
  detect_compose
  ensure_swap
  check_dns
  resolve_wallet_settings
  check_wallet_rpc
  write_env
  write_caddy
  start_stack
  healthcheck
  print_finish
}

main "$@"
