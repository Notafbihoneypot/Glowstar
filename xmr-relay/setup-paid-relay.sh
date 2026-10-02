#!/usr/bin/env bash
set -Eeuo pipefail

# Glowstr interactive lightweight paid XMR Nostr relay.
#
# Intended for a small Debian/Ubuntu VPS (512 MB / 1 vCPU is supported for
# low traffic with swap). No monerod is installed.
#
# Default wallet mode:
#   local view-only monero-wallet-rpc -> remote Monero daemon
#
# The VPS never needs the wallet seed or private spend key.

RELAY_DOMAIN="${GLOWSTR_RELAY_DOMAIN:-}"
ALLOWED_ORIGIN="${GLOWSTR_ALLOWED_ORIGIN:-}"
WALLET_MODE="${GLOWSTR_WALLET_MODE:-}"
REMOTE_DAEMON="${MONERO_DAEMON_ADDRESS:-}"
VIEW_ADDRESS="${MONERO_VIEW_ADDRESS:-}"
VIEW_KEY="${MONERO_PRIVATE_VIEW_KEY:-}"
RESTORE_HEIGHT="${MONERO_RESTORE_HEIGHT:-}"
RPC_URL="${MONERO_WALLET_RPC:-}"
RPC_USER="${MONERO_RPC_USER:-}"
RPC_PASS="${MONERO_RPC_PASS:-}"

AUTO_INSTALL="${AUTO_INSTALL:-1}"
AUTO_SWAP="${AUTO_SWAP:-1}"
SKIP_DNS_CHECK="${SKIP_DNS_CHECK:-0}"
ALLOW_PROXMOX_HOST="${ALLOW_PROXMOX_HOST:-0}"
ALLOW_UNAUTHENTICATED_WALLET_RPC="${ALLOW_UNAUTHENTICATED_WALLET_RPC:-0}"
ALLOW_PLAINTEXT_WALLET_RPC="${ALLOW_PLAINTEXT_WALLET_RPC:-0}"
NONINTERACTIVE="${NONINTERACTIVE:-0}"

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PAID_DIR="$HERE/paid-relay"
ENV_FILE="$HERE/.env"
COMPOSE=()

MONERO_RPC_BIN="${MONERO_WALLET_RPC_BIN:-}"
MONERO_CLI_VERSION="0.18.5.1"
MONERO_WALLET_USER="glowstrmonero"
MONERO_WALLET_DIR="/var/lib/glowstr-monero-wallet"
MONERO_WALLET_FILE="$MONERO_WALLET_DIR/relay-view"
MONERO_CONFIG_DIR="/etc/glowstr"
MONERO_CONFIG="$MONERO_CONFIG_DIR/monero-wallet-rpc.conf"
MONERO_PASSWORD_FILE="$MONERO_CONFIG_DIR/monero-wallet.password"
MONERO_SERVICE="glowstr-monero-wallet-rpc.service"

say(){ printf '\n==> %s\n' "$*"; }
warn(){ printf '\nWARNING: %s\n' "$*" >&2; }
die(){ printf '\nERROR: %s\n' "$*" >&2; exit 1; }

bool_enabled() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

interactive() {
  [[ -t 0 && ! "$NONINTERACTIVE" =~ ^(1|true|yes|on)$ ]]
}

ask_default() {
  local __var="$1" prompt="$2" default="$3" value=""
  if interactive; then
    read -r -p "$prompt [$default]: " value
    value="${value:-$default}"
  else
    value="$default"
  fi
  printf -v "$__var" '%s' "$value"
}

ask_required() {
  local __var="$1" prompt="$2" value="${!1:-}"
  if [[ -z "$value" ]] && interactive; then
    while [[ -z "$value" ]]; do
      read -r -p "$prompt: " value
    done
  fi
  [[ -n "$value" ]] || die "Missing required value: $prompt"
  printf -v "$__var" '%s' "$value"
}

ask_secret() {
  local __var="$1" prompt="$2" value="${!1:-}"
  if [[ -z "$value" ]] && interactive; then
    while [[ -z "$value" ]]; do
      read -r -s -p "$prompt: " value
      printf '\n'
    done
  fi
  [[ -n "$value" ]] || die "Missing required secret: $prompt"
  printf -v "$__var" '%s' "$value"
}

ask_yes_no() {
  local prompt="$1" default="$2" answer=""
  if ! interactive; then
    [[ "$default" == "Y" ]]
    return
  fi
  if [[ "$default" == "Y" ]]; then
    read -r -p "$prompt [Y/n]: " answer
    answer="${answer:-Y}"
  else
    read -r -p "$prompt [y/N]: " answer
    answer="${answer:-N}"
  fi
  [[ "$answer" =~ ^[Yy]$ ]]
}

env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n1
}

collect_inputs() {
  if [[ -z "$RELAY_DOMAIN" ]]; then
    ask_default RELAY_DOMAIN "Glowstr paid relay domain" "relay.glowstr.com"
  fi
  if [[ -z "$ALLOWED_ORIGIN" ]]; then
    ask_default ALLOWED_ORIGIN "Glowstr web/app origin allowed to use the payment API" "https://glowstr.com"
  fi

  if [[ -z "$WALLET_MODE" ]]; then
    if interactive; then
      printf '\nWallet setup:\n'
      printf '  1) View-only wallet on this VPS + remote Monero daemon (recommended)\n'
      printf '  2) Existing monero-wallet-rpc somewhere else\n'
      local choice=""
      read -r -p "Choose [1]: " choice
      choice="${choice:-1}"
      [[ "$choice" == "2" ]] && WALLET_MODE="external-rpc" || WALLET_MODE="local-view"
    else
      WALLET_MODE="local-view"
    fi
  fi

  case "$WALLET_MODE" in
    local-view)
      if [[ -z "$REMOTE_DAEMON" ]]; then
        ask_required REMOTE_DAEMON "Remote Monero daemon URL (example: https://your-node.example:18089)"
      fi
      ask_required VIEW_ADDRESS "Monero wallet PRIMARY public address (starts with 4)"
      ask_secret VIEW_KEY "Monero PRIVATE VIEW KEY (hidden; never stored in .env)"
      if [[ -z "$RESTORE_HEIGHT" ]]; then
        ask_default RESTORE_HEIGHT "Wallet restore height (0 works but scans from genesis)" "0"
      fi
      ;;
    external-rpc)
      ask_required RPC_URL "Existing monero-wallet-rpc JSON-RPC URL"
      ask_required RPC_USER "Wallet RPC username"
      ask_secret RPC_PASS "Wallet RPC password"
      ;;
    *)
      die "GLOWSTR_WALLET_MODE must be local-view or external-rpc"
      ;;
  esac
}

validate_inputs() {
  [[ "$RELAY_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "Invalid relay domain"
  [[ "$ALLOWED_ORIGIN" =~ ^https:// ]] || die "Glowstr origin must start with https://"

  if [[ -d /etc/pve ]] && ! bool_enabled "$ALLOW_PROXMOX_HOST"; then
    die "This looks like a Proxmox VE host. Run this inside the VPS/VM/LXC, not directly on PVE."
  fi

  if [[ "$WALLET_MODE" == "local-view" ]]; then
    [[ "$VIEW_ADDRESS" =~ ^4[1-9A-HJ-NP-Za-km-z]{94}$ ]] ||
      die "Primary Monero address should be a 95-character standard address beginning with 4"
    [[ "$VIEW_KEY" =~ ^[0-9a-fA-F]{64}$ ]] ||
      die "Private view key must be 64 hexadecimal characters"
    [[ "$RESTORE_HEIGHT" =~ ^[0-9]+$ ]] || die "Restore height must be an integer"
    [[ "$REMOTE_DAEMON" =~ ^https?:// ]] || die "Remote daemon must begin with http:// or https://"
  fi
}

install_deps() {
  local missing=()
  for c in podman curl openssl getent tar sha256sum; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  [[ "$WALLET_MODE" != "local-view" ]] || command -v systemctl >/dev/null 2>&1 || missing+=("systemd")

  if (("${#missing[@]}" == 0)); then return; fi
  bool_enabled "$AUTO_INSTALL" || die "Missing dependencies: ${missing[*]}"
  [[ $EUID -eq 0 ]] || die "Run as root to auto-install dependencies"

  if command -v apt-get >/dev/null 2>&1; then
    say "Installing relay dependencies"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y podman podman-compose curl openssl libc-bin util-linux bzip2 ca-certificates
  else
    die "Automatic dependency installation currently supports Debian/Ubuntu"
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

  if (( mem_kb >= 900000 || swap_kb >= 524288 )); then return; fi
  bool_enabled "$AUTO_SWAP" || { warn "Low RAM and no useful swap detected."; return; }
  [[ $EUID -eq 0 ]] || { warn "Root is required to create swap."; return; }

  say "512 MB-class VPS detected; adding 1 GB swap"
  if [[ ! -f "$swapfile" ]]; then
    if command -v fallocate >/dev/null 2>&1; then
      fallocate -l 1G "$swapfile" || dd if=/dev/zero of="$swapfile" bs=1M count=1024 status=none
    else
      dd if=/dev/zero of="$swapfile" bs=1M count=1024 status=none
    fi
    chmod 600 "$swapfile"
    mkswap "$swapfile" >/dev/null
  fi
  if swapon "$swapfile" 2>/dev/null; then
    grep -qF "$swapfile none swap sw 0 0" /etc/fstab 2>/dev/null ||
      printf '%s\n' "$swapfile none swap sw 0 0" >> /etc/fstab
  else
    warn "Could not enable swap (some VPS/LXC providers disable swapon)."
  fi
}

check_dns() {
  bool_enabled "$SKIP_DNS_CHECK" && { say "Skipping DNS check"; return; }
  say "Checking DNS for $RELAY_DOMAIN"
  getent ahosts "$RELAY_DOMAIN" >/dev/null 2>&1 ||
    die "$RELAY_DOMAIN does not resolve. Point its A/AAAA record at this VPS first."
}

install_monero_wallet_rpc() {
  [[ "$WALLET_MODE" == "local-view" ]] || return

  if [[ -n "$MONERO_RPC_BIN" && -x "$MONERO_RPC_BIN" ]]; then return; fi
  if command -v monero-wallet-rpc >/dev/null 2>&1; then
    MONERO_RPC_BIN="$(command -v monero-wallet-rpc)"
    return
  fi

  [[ $EUID -eq 0 ]] || die "Root is required to install monero-wallet-rpc"

  local arch url expected tmp found
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)
      url="https://downloads.getmonero.org/cli/linux64"
      expected="22a7dda7b0cb699fdd6b7674c3b4a4465b337cc98a54983523b759e1e7cc9958"
      ;;
    aarch64|arm64)
      url="https://downloads.getmonero.org/cli/linuxarm8"
      expected="c0caf042cb7c7b760f5ad6be188084b59352440b32990a78b8051497b9398dbc"
      ;;
    *)
      die "Automatic Monero CLI install supports x86_64 and arm64. Install monero-wallet-rpc manually and set MONERO_WALLET_RPC_BIN."
      ;;
  esac

  say "Downloading official Monero CLI $MONERO_CLI_VERSION (wallet-rpc only)"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -fL --retry 3 --connect-timeout 15 -o "$tmp/monero.tar.bz2" "$url"
  printf '%s  %s\n' "$expected" "$tmp/monero.tar.bz2" | sha256sum -c - >/dev/null ||
    die "Monero download hash mismatch. The official release may have changed; do not bypass this check."

  tar -xjf "$tmp/monero.tar.bz2" -C "$tmp"
  found="$(find "$tmp" -type f -name monero-wallet-rpc -perm -u+x | head -n1)"
  [[ -n "$found" ]] || die "monero-wallet-rpc was not found in the verified archive"
  install -m 0755 "$found" /usr/local/bin/monero-wallet-rpc
  MONERO_RPC_BIN="/usr/local/bin/monero-wallet-rpc"
  rm -rf "$tmp"
  trap - RETURN
}

validate_remote_daemon_transport() {
  [[ "$WALLET_MODE" == "local-view" ]] || return
  if [[ "$REMOTE_DAEMON" =~ ^http:// ]]; then
    warn "The remote Monero daemon URL uses plaintext HTTP."
    warn "The daemon does NOT receive your private view key, but HTTPS/Tor/private networking is preferable."
    if interactive && ! ask_yes_no "Continue with this HTTP remote daemon?" "N"; then
      die "Choose an HTTPS/private remote daemon and rerun."
    fi
  fi
}

ensure_wallet_user() {
  [[ "$WALLET_MODE" == "local-view" ]] || return
  [[ $EUID -eq 0 ]] || die "Root is required to create the view-wallet service"

  if ! id "$MONERO_WALLET_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$MONERO_WALLET_DIR" --shell /usr/sbin/nologin "$MONERO_WALLET_USER"
  fi
  install -d -m 0700 -o "$MONERO_WALLET_USER" -g "$MONERO_WALLET_USER" "$MONERO_WALLET_DIR"
  install -d -m 0750 -o root -g "$MONERO_WALLET_USER" "$MONERO_CONFIG_DIR"
}

generate_wallet_credentials() {
  [[ "$WALLET_MODE" == "local-view" ]] || return
  RPC_USER="${RPC_USER:-glowstr}"
  [[ -n "$RPC_PASS" ]] || RPC_PASS="$(openssl rand -hex 24)"

  local wallet_password
  if [[ -s "$MONERO_PASSWORD_FILE" ]]; then
    wallet_password="$(cat "$MONERO_PASSWORD_FILE")"
  else
    wallet_password="$(openssl rand -hex 32)"
    printf '%s\n' "$wallet_password" > "$MONERO_PASSWORD_FILE"
    chown root:"$MONERO_WALLET_USER" "$MONERO_PASSWORD_FILE"
    chmod 0640 "$MONERO_PASSWORD_FILE"
  fi
  WALLET_PASSWORD="$wallet_password"
}

write_wallet_config() {
  local mode="$1"
  cat > "$MONERO_CONFIG" <<EOF
rpc-bind-ip=127.0.0.1
rpc-bind-port=18083
rpc-login=$RPC_USER:$RPC_PASS
daemon-address=$REMOTE_DAEMON
untrusted-daemon=1
max-concurrency=1
log-level=0
log-file=$MONERO_WALLET_DIR/wallet-rpc.log
max-log-files=2
EOF
  if [[ "$mode" == "bootstrap" ]]; then
    printf '%s\n' "wallet-dir=$MONERO_WALLET_DIR" >> "$MONERO_CONFIG"
  else
    printf '%s\n' "wallet-file=$MONERO_WALLET_FILE" >> "$MONERO_CONFIG"
    printf '%s\n' "password-file=$MONERO_PASSWORD_FILE" >> "$MONERO_CONFIG"
  fi
  chown root:"$MONERO_WALLET_USER" "$MONERO_CONFIG"
  chmod 0640 "$MONERO_CONFIG"
}

write_wallet_service() {
  [[ "$WALLET_MODE" == "local-view" ]] || return
  cat > "/etc/systemd/system/$MONERO_SERVICE" <<EOF
[Unit]
Description=Glowstr view-only Monero wallet RPC
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$MONERO_WALLET_USER
Group=$MONERO_WALLET_USER
ExecStart=$MONERO_RPC_BIN --config-file=$MONERO_CONFIG
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$MONERO_WALLET_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "/etc/systemd/system/$MONERO_SERVICE"
  systemctl daemon-reload
}

wallet_rpc_call() {
  local method="$1" params="$2"
  printf '{"jsonrpc":"2.0","id":"glowstr","method":"%s","params":%s}' "$method" "$params" |
    curl -fsS --digest -u "$RPC_USER:$RPC_PASS"       -H 'Content-Type: application/json'       --data-binary @-       http://127.0.0.1:18083/json_rpc
}

wait_wallet_rpc() {
  local ok=0
  for _ in $(seq 1 45); do
    if wallet_rpc_call get_version '{}' >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  (( ok == 1 )) || {
    journalctl -u "$MONERO_SERVICE" --no-pager -n 50 || true
    die "monero-wallet-rpc did not become ready"
  }
}

create_or_reuse_view_wallet() {
  [[ "$WALLET_MODE" == "local-view" ]] || return

  ensure_wallet_user
  generate_wallet_credentials
  write_wallet_service

  if [[ -f "$MONERO_WALLET_FILE.keys" ]]; then
    say "Existing view-only wallet found; reusing $MONERO_WALLET_FILE"
  else
    say "Creating encrypted view-only wallet from address + private view key"
    write_wallet_config bootstrap
    systemctl restart "$MONERO_SERVICE"
    wait_wallet_rpc

    local params response escaped_pw
    escaped_pw="$(printf '%s' "$WALLET_PASSWORD" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    params="$(printf '{"restore_height":%s,"filename":"relay-view","address":"%s","viewkey":"%s","password":"%s","autosave_current":true}'       "$RESTORE_HEIGHT" "$VIEW_ADDRESS" "$VIEW_KEY" "$escaped_pw")"

    response="$(wallet_rpc_call generate_from_keys "$params")" ||
      die "generate_from_keys failed"
    [[ "$response" == *'"result"'* ]] || die "View-wallet creation failed: $response"

    systemctl stop "$MONERO_SERVICE"
  fi

  # Forget the raw private view key as soon as the encrypted wallet exists.
  VIEW_KEY=""
  unset MONERO_PRIVATE_VIEW_KEY || true

  write_wallet_config production
  systemctl enable --now "$MONERO_SERVICE"
  wait_wallet_rpc

  RPC_URL="http://127.0.0.1:18083/json_rpc"
  say "View-only wallet RPC is live on 127.0.0.1:18083"
}

check_external_wallet_security() {
  [[ "$WALLET_MODE" == "external-rpc" ]] || return

  if [[ ! "$RPC_URL" =~ ^https:// &&
        ! "$RPC_URL" =~ ^http://127\.0\.0\.1: &&
        ! "$RPC_URL" =~ ^http://localhost: &&
        ! "$RPC_URL" =~ ^http://10\. &&
        ! "$RPC_URL" =~ ^http://192\.168\. &&
        ! "$RPC_URL" =~ ^http://172\.(1[6-9]|2[0-9]|3[01])\. &&
        ! "$RPC_URL" =~ ^http://100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]]; then
    bool_enabled "$ALLOW_PLAINTEXT_WALLET_RPC" ||
      die "Refusing plaintext wallet RPC outside loopback/private/Tailscale ranges"
  fi
}

check_wallet_rpc() {
  local auth=()
  [[ -z "$RPC_USER" ]] || auth=(--digest -u "$RPC_USER:$RPC_PASS")

  say "Testing wallet RPC"
  local response
  response="$(curl -fsS --max-time 12 "${auth[@]}"     -H 'Content-Type: application/json'     --data '{"jsonrpc":"2.0","id":"glowstr","method":"get_version","params":{}}'     "$RPC_URL")" || die "Cannot reach/authenticate to monero-wallet-rpc"

  [[ "$response" == *'"result"'* ]] || die "Wallet RPC returned an invalid response"
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
GLOWSTR_REMINDER_SECONDS=2592000
GLOWSTR_INVOICE_SECONDS=1800
GLOWSTR_LATE_PAYMENT_GRACE_SECONDS=300
GLOWSTR_RECONCILE_SECONDS=20

GLOWSTR_ENTITLEMENT_CACHE_SECONDS=15
GLOWSTR_GATE_MAX_AUTH_KEYS=64
GLOWSTR_GATE_PRIVACY_AUTH_GRACE_MS=15000
GLOWSTR_GATE_MAX_GRACE_WRITES=8
GLOWSTR_ALLOW_PRIVACY_WRAPPERS=true

# NIP-17 notifier intentionally disabled in the 512 MB relay profile.
GLOWSTR_NIP17_PUBLIC_KEY=
EOF
  chmod 0600 "$ENV_FILE"
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

    # Glowstr payment API. handle_path strips /xmr-commerce before forwarding.
    handle_path /xmr-commerce/* {
        reverse_proxy 127.0.0.1:8787
    }

    # Paid Nostr publishing.
    @nostr_ws {
        header Connection *Upgrade*
        header Upgrade websocket
    }

    handle @nostr_ws {
        reverse_proxy 127.0.0.1:7778
    }

    # NIP-11 / ordinary HTTP.
    handle {
        reverse_proxy 127.0.0.1:7777
    }
}
EOF
}

start_stack() {
  say "Building and starting Glowstr paid relay"
  cd "$HERE"
  "${COMPOSE[@]}" -f compose.yaml -f compose.paid-relay.yaml up -d --build
}

healthcheck() {
  say "Checking Glowstr relay + payment service"
  local ok=0
  for _ in $(seq 1 45); do
    if curl -fsS http://127.0.0.1:8787/ready >/dev/null 2>&1 &&
       curl -fsS http://127.0.0.1:7778/health >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 2
  done
  (( ok == 1 )) || die "Local relay/payment services did not become healthy"

  curl -fsS --retry 12 --retry-delay 3     "https://$RELAY_DOMAIN/xmr-commerce/v1/features" >/tmp/glowstr-features.json ||
    die "Public payment API is not reachable through Caddy/TLS"
}

print_finish() {
  cat <<EOF

============================================================
 GLOWSTR PAID XMR RELAY READY
============================================================

Nostr relay:
  wss://$RELAY_DOMAIN/

Glowstr payment API:
  https://$RELAY_DOMAIN/xmr-commerce/v1

Wallet mode:
  $WALLET_MODE

Plan:
  $10 USD equivalent in XMR
  365 days of write access
  2 confirmations required
  reading remains public/free

HOW GLOWSTR LEARNS THE USER PAID

1. Glowstr POSTs an invoice request with the logged-in Nostr pubkey.
2. Commerce asks the view-only wallet for a NEW subaddress.
3. Glowstr receives the unique address + XMR amount + private invoice token.
4. Glowstr polls:
     /xmr-commerce/v1/invoices/<invoice-id>
   using that invoice token.
5. Commerce independently watches monero-wallet-rpc, even if Glowstr closes.
6. At 2 confirmations Commerce stores a relay_365d entitlement for that pubkey.
7. The invoice endpoint changes to:
     status = PAID
     access_valid_until = <unix time>
8. Glowstr shows "2 confirmations — relay access activated".
9. On every relay write, relay-gate verifies NIP-42 and checks the entitlement
   server-side. A fake client-side "paid" screen cannot bypass the gate.

Glowstr must use:
  apiBase = https://$RELAY_DOMAIN/xmr-commerce/v1

Health/status:
  https://$RELAY_DOMAIN/xmr-commerce/v1/features
  https://$RELAY_DOMAIN/xmr-commerce/ready

Public ports:
  TCP 80, 443

Private/local:
  7777 strfry
  7778 paid relay gate
  8787 Commerce
  18083 view-only monero-wallet-rpc

No monerod is installed on this VPS.

Logs:
  cd $HERE
  ${COMPOSE[*]} -f compose.yaml -f compose.paid-relay.yaml logs -f
EOF

  if [[ "$WALLET_MODE" == "local-view" ]]; then
    cat <<EOF

View-wallet logs:
  journalctl -u $MONERO_SERVICE -f

The VPS has the PRIVATE VIEW KEY capability through the encrypted view-wallet
file, but it does NOT have the seed or private spend key and cannot spend XMR.
EOF
  fi

  cat <<EOF

Back up:
  - glowstr-commerce Podman volume
  - glowstr-relay Podman volume
  - $ENV_FILE
EOF

  if [[ "$WALLET_MODE" == "local-view" ]]; then
    cat <<EOF
  - $MONERO_WALLET_DIR/
  - $MONERO_CONFIG_DIR/
EOF
  fi

  printf '%s\n' "============================================================"
}

main() {
  collect_inputs
  validate_inputs
  install_deps
  detect_compose
  ensure_swap
  check_dns

  if [[ "$WALLET_MODE" == "local-view" ]]; then
    validate_remote_daemon_transport
    install_monero_wallet_rpc
    create_or_reuse_view_wallet
  else
    check_external_wallet_security
  fi

  check_wallet_rpc
  write_env
  write_caddy
  start_stack
  healthcheck
  print_finish
}

main "$@"
