#!/usr/bin/env bash
set -Eeuo pipefail

# Glowstr all-in-one staging deploy.
# STAGING ONLY: uses a fake Monero wallet RPC and short entitlement timing.

SITE_DOMAIN="${GLOWSTR_STAGING_SITE_DOMAIN:-staging.glowstr.com}"
RELAY_DOMAIN="${GLOWSTR_STAGING_RELAY_DOMAIN:-relay-staging.glowstr.com}"
VOICE_DOMAIN="${GLOWSTR_STAGING_VOICE_DOMAIN:-voice-staging.glowstr.com}"
SKIP_DNS_CHECK="${SKIP_DNS_CHECK:-0}"

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/.." && pwd)"
STAGING_DIR="$HERE/staging"
SITE_DIR="$STAGING_DIR/site"
SECRETS_DIR="$HERE/secrets"
ENV_FILE="$HERE/.env"
NOTIFIER_IMAGE="localhost/glowstr-nip17-notifier-keygen:staging"

say(){ printf '\n==> %s\n' "$*"; }
die(){ printf '\nERROR: %s\n' "$*" >&2; exit 1; }

install_deps_if_needed() {
  local missing=()
  for c in podman curl openssl python3 git getent; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if ((${#missing[@]})); then
    [[ $EUID -eq 0 ]] || die "Missing: ${missing[*]}. Re-run as root in the staging VM."
    if command -v apt-get >/dev/null 2>&1; then
      say "Installing Podman staging dependencies"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y podman podman-compose curl openssl python3 git libc-bin
    else
      die "Automatic dependency install supports Debian/Ubuntu. Install: ${missing[*]}"
    fi
  fi
}

detect_compose() {
  if podman compose version >/dev/null 2>&1; then
    COMPOSE=(podman compose)
  elif command -v podman-compose >/dev/null 2>&1; then
    COMPOSE=(podman-compose)
  else
    die "No Podman Compose provider found. Install podman-compose."
  fi
}

check_dns() {
  [[ "$SKIP_DNS_CHECK" == "1" ]] && { say "Skipping DNS preflight"; return; }
  say "Checking staging DNS"
  getent ahosts "$SITE_DOMAIN" >/dev/null 2>&1 ||
    die "$SITE_DOMAIN does not resolve. Create its DNS A/AAAA record, then rerun."
  getent ahosts "$RELAY_DOMAIN" >/dev/null 2>&1 ||
    die "$RELAY_DOMAIN does not resolve. Create its DNS A/AAAA record, then rerun."
  getent ahosts "$VOICE_DOMAIN" >/dev/null 2>&1 ||
    die "$VOICE_DOMAIN does not resolve. Create its DNS A/AAAA record, then rerun."
}

env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n1
}

generate_notifier_identity() {
  say "Building notifier image for key generation"
  podman build -q -t "$NOTIFIER_IMAGE" "$ROOT/nip17-notifier" >/dev/null

  mkdir -p "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR"

  if [[ ! -s "$SECRETS_DIR/notifier.key" ]]; then
    say "Generating dedicated NIP-17 notifier key"
    podman run --rm --user 0:0       -v "$SECRETS_DIR:/out"       --entrypoint node       "$NOTIFIER_IMAGE"       /app/keygen.mjs /out/notifier.key
    chmod 600 "$SECRETS_DIR/notifier.key"
  else
    say "Reusing existing notifier key"
  fi

  local secret
  secret="$(tr -d '\r\n' < "$SECRETS_DIR/notifier.key")"
  [[ "$secret" =~ ^[0-9a-fA-F]{64}$ ]] || die "notifier.key is not a 32-byte hex Nostr secret"

  NOTIFIER_PUBKEY="$(
    podman run --rm       -e "GLOWSTR_KEY_HEX=$secret"       --entrypoint node       "$NOTIFIER_IMAGE"       --input-type=module       -e "import {getPublicKey} from 'nostr-tools/pure'; console.log(getPublicKey(new Uint8Array(Buffer.from(process.env.GLOWSTR_KEY_HEX,'hex'))))"
  )"
  [[ "$NOTIFIER_PUBKEY" =~ ^[0-9a-f]{64}$ ]] || die "Could not derive notifier public key"
}

write_env() {
  local token livekit_key livekit_secret
  token="$(env_value GLOWSTR_COMMERCE_ADMIN_TOKEN)"
  if [[ ! "$token" =~ ^[A-Za-z0-9_-]{32,}$ && ! "$token" =~ ^[0-9a-fA-F]{64,}$ ]]; then
    token="$(openssl rand -hex 32)"
  fi
  livekit_key="$(env_value LIVEKIT_API_KEY)"
  if [[ ! "$livekit_key" =~ ^[A-Za-z0-9_-]{8,64}$ ]]; then
    livekit_key="LK$(openssl rand -hex 10)"
  fi
  livekit_secret="$(env_value LIVEKIT_API_SECRET)"
  if [[ ! "$livekit_secret" =~ ^[A-Za-z0-9_-]{24,128}$ && ! "$livekit_secret" =~ ^[0-9a-fA-F]{32,128}$ ]]; then
    livekit_secret="$(openssl rand -hex 32)"
  fi

  LIVEKIT_KEY="$livekit_key"
  LIVEKIT_SECRET="$livekit_secret"

  umask 077
  cat > "$ENV_FILE" <<EOF
GLOWSTR_COMMERCE_ADMIN_TOKEN=$token
GLOWSTR_STAGING_SITE_DOMAIN=$SITE_DOMAIN
GLOWSTR_STAGING_RELAY_DOMAIN=$RELAY_DOMAIN
GLOWSTR_STAGING_VOICE_DOMAIN=$VOICE_DOMAIN
GLOWSTR_ALLOWED_ORIGIN=https://$SITE_DOMAIN
GLOWSTR_RELAY_TARGET=$RELAY_DOMAIN

# Mock-wallet staging values. No real Monero wallet is used.
MONERO_WALLET_RPC=http://127.0.0.1:18084/json_rpc
MONERO_RPC_USER=
MONERO_RPC_PASS=
GLOWSTR_XMR_CONFIRMATIONS=2
GLOWSTR_RELAY_USD_CENTS=1000
GLOWSTR_XMR_USD_OVERRIDE=100

# Short test lifecycle: 10-minute membership, reminder at 5 minutes remaining.
GLOWSTR_RELAY_SECONDS=600
GLOWSTR_REMINDER_SECONDS=300
GLOWSTR_INVOICE_SECONDS=300
GLOWSTR_RECONCILE_SECONDS=5

GLOWSTR_NIP17_SECRET_PATH=./secrets/notifier.key
GLOWSTR_NIP17_PUBLIC_KEY=$NOTIFIER_PUBKEY
GLOWSTR_NIP17_LOOKUP_RELAYS=wss://nos.lol,wss://relay.nostr.band
GLOWSTR_NIP17_ALLOWED_RELAY_HOSTS=nos.lol,relay.nostr.band
GLOWSTR_NIP17_SENDER_RELAYS=
GLOWSTR_NIP17_POLL_SECONDS=10
GLOWSTR_NIP17_RETRY_SECONDS=30
GLOWSTR_NIP17_BATCH_SIZE=25

# Armada Concord voice / LiveKit staging.
LIVEKIT_API_KEY=$LIVEKIT_KEY
LIVEKIT_API_SECRET=$LIVEKIT_SECRET
EOF
  chmod 600 "$ENV_FILE"
}

write_staging_files() {
  say "Generating HTTPS staging client and relay config"
  rm -rf "$STAGING_DIR"
  mkdir -p "$SITE_DIR"

  cat > "$STAGING_DIR/Caddyfile" <<EOF
$SITE_DOMAIN {
    encode zstd gzip
    handle_path /xmr-commerce/* {
        reverse_proxy 127.0.0.1:8787
    }
    handle {
        root * /srv
        try_files {path} /index.html
        file_server
    }
}

$RELAY_DOMAIN {
    @nostr_ws {
        header Connection *Upgrade*
        header Upgrade websocket
    }
    handle @nostr_ws {
        reverse_proxy 127.0.0.1:7778
    }
    handle {
        reverse_proxy 127.0.0.1:7777
    }
}

$VOICE_DOMAIN {
    handle /.well-known/concord/av* {
        reverse_proxy 127.0.0.1:8086
    }
    handle {
        reverse_proxy 127.0.0.1:7880
    }
}
EOF

  cat > "$STAGING_DIR/livekit.yaml" <<EOF
port: 7880
log_level: info
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: true
keys:
  $LIVEKIT_KEY: "$LIVEKIT_SECRET"
EOF

  python3 - "$HERE/strfry.conf" "$STAGING_DIR/strfry.conf" "$RELAY_DOMAIN" <<'PY'
from pathlib import Path
import sys
src, dst, relay = sys.argv[1:]
text = Path(src).read_text(encoding="utf-8")
old = 'serviceUrl = "wss://relay.glowstr.com/"'
if old not in text:
    raise SystemExit("strfry staging replacement anchor not found")
text = text.replace(old, f'serviceUrl = "wss://{relay}/"')
text = text.replace('name = "Glowstr XMR Relay"', 'name = "Glowstr XMR Relay STAGING"')
Path(dst).write_text(text, encoding="utf-8")
PY

  python3 - "$ROOT/glowstr-v5.3-bluetooth-direct.html" "$SITE_DIR/index.html" "$SITE_DOMAIN" "$RELAY_DOMAIN" <<'PY'
from pathlib import Path
import sys
src, dst, site, relay = sys.argv[1:]
text = Path(src).read_text(encoding="utf-8")
for needle in ("https://relay.glowstr.com/xmr-commerce/v1", "wss://relay.glowstr.com/", "relay.glowstr.com"):
    if needle not in text:
        raise SystemExit(f"staging client replacement anchor missing: {needle}")
text = text.replace("https://relay.glowstr.com/xmr-commerce/v1", f"https://{site}/xmr-commerce/v1")
text = text.replace("https://relay.glowstr.com", f"https://{relay}")
text = text.replace("wss://relay.glowstr.com/", f"wss://{relay}/")
text = text.replace("relay.glowstr.com", relay)
banner = '<div style="position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#8a2be2;color:white;padding:5px;text-align:center;font:12px monospace;">GLOWSTR STAGING — MOCK MONERO — DO NOT SEND REAL XMR</div>'
text = text.replace("</body>", banner + "\n</body>")
Path(dst).write_text(text, encoding="utf-8")
PY
}

preflight_ports() {
  if [[ $EUID -ne 0 ]]; then
    local low
    low="$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)"
    (( low <= 80 )) || die "Caddy needs TCP 80/443. Run as root in the dedicated staging VM."
  fi
}

start_stack() {
  say "Starting Caddy + mock wallet + Commerce + relay gate + NIP-17 notifier + Armada voice + LiveKit"
  cd "$HERE"
  "${COMPOSE[@]}"     -f compose.yaml     -f compose.staging.yaml     --profile notifications     up -d --build
}

healthcheck() {
  say "Checking local services"
  local ok=0
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:18084/health >/dev/null 2>&1 &&
       curl -fsS http://127.0.0.1:8787/ready >/dev/null 2>&1 &&
       curl -fsS http://127.0.0.1:7778/health >/dev/null 2>&1 &&
       curl -fsS -o /dev/null http://127.0.0.1:8086/.well-known/concord/av; then
      ok=1
      break
    fi
    sleep 2
  done
  (( ok == 1 )) || die "Local health checks failed. Run the compose logs command printed below."

  say "Checking public HTTPS"
  if curl -fsS --retry 12 --retry-delay 3 "https://$SITE_DOMAIN/xmr-commerce/v1/notifier" >/tmp/glowstr-notifier.json 2>/dev/null; then
    printf 'Notifier trust endpoint: '
    cat /tmp/glowstr-notifier.json
    printf '\n'
  else
    printf '\nWARNING: backend is healthy, but public HTTPS is not reachable yet.\n'
    printf 'Check DNS, TCP 80/443 NAT/firewall rules, and Caddy logs.\n'
  fi

  if curl -fsS -o /dev/null --retry 12 --retry-delay 3 "https://$VOICE_DOMAIN/.well-known/concord/av" 2>/dev/null; then
    printf 'Armada voice capability: OK (%s)\n' "$VOICE_DOMAIN"
  else
    printf 'WARNING: Armada voice HTTPS capability is not reachable yet.\n'
  fi
}

print_finish() {
  cat <<EOF

============================================================
 GLOWSTR STAGING DEPLOYED
============================================================
Client:       https://$SITE_DOMAIN/
Nostr relay: wss://$RELAY_DOMAIN/
Armada voice: https://$VOICE_DOMAIN/
Commerce:    https://$SITE_DOMAIN/xmr-commerce/v1/
Notifier PK: $NOTIFIER_PUBKEY

STAGING USES A MOCK MONERO WALLET. DO NOT SEND REAL XMR.

Expected timing after BUY / RENEW:
  0-8 sec     mempool
  8-18 sec    1 confirmation
  ~18 sec     2 confirmations -> relay write access
  ~5 min      renewal reminder becomes eligible
  <=10 sec    notifier sends encrypted NIP-17 DM
  ~10 min     staging membership expires if not renewed

Test:
  1. Open https://$SITE_DOMAIN/
  2. Log in with a TEST Nostr identity.
  3. RELAYS -> NIP-17 PRIVATE INBOX -> publish the suggested inbox list.
  4. XMR -> BUY / RENEW RELAY.
  5. DO NOT pay the fake QR/address.
  6. Confirm the mock reaches 2 confirmations.
  7. Around 5 minutes later, verify the encrypted renewal DM and notification.

Armada voice test:
  1. Make sure the TEST Nostr identity has the active staging relay entitlement above.
  2. In Armada, add relay: wss://$RELAY_DOMAIN/
  3. In Armada Settings -> Voice, add: https://$VOICE_DOMAIN
  4. Create/join a Concord community that uses the staging relay.
  5. Start a voice call from two test devices/accounts.
  6. Verify audio in both directions, mute/unmute, leave/rejoin, and reconnect.
  7. Verify the relay gate logs accept encrypted kind 21059 traffic.

Required inbound ports on the staging VM/router:
  TCP 80, 443, 7881
  UDP 7882
Do NOT expose TCP 7777, 7778, 7880, 8086, 8787, or 18084.

Logs:
  cd $HERE
  ${COMPOSE[*]} -f compose.yaml -f compose.staging.yaml --profile notifications logs -f

Stop:
  ${COMPOSE[*]} -f compose.yaml -f compose.staging.yaml --profile notifications down

Secrets stay in: $SECRETS_DIR/
============================================================
EOF
}

main() {
  install_deps_if_needed
  detect_compose
  preflight_ports
  check_dns
  generate_notifier_identity
  write_env
  write_staging_files
  start_stack
  healthcheck
  print_finish
}

main "$@"
