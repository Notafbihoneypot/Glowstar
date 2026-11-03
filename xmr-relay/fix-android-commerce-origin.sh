#!/usr/bin/env bash
# Add the isolated Glowstr Android WebView origin to the existing Commerce
# allowlist without changing wallet files, secrets, or any paid memberships.
set -Eeuo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
ENV_FILE="$HERE/.env"
[[ -s "$ENV_FILE" ]] || { echo "Missing xmr-relay/.env. Run this on the existing paid-relay VPS." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v podman >/dev/null || { echo "Podman is required" >&2; exit 1; }

# Save a private, byte-for-byte rollback copy. It contains credentials.
umask 077
BACKUP="$HERE/.env.android-invoice-backup.$(date +%Y%m%dT%H%M%S).$$"
cp -p -- "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP"

python3 - "$ENV_FILE" <<'PY'
import os
import pathlib
import sys
import tempfile
from urllib.parse import urlsplit

path = pathlib.Path(sys.argv[1])
raw = path.read_text(encoding="utf-8")
lines = raw.splitlines(keepends=True)
key = "GLOWSTR_ALLOWED_ORIGIN"
indexes = [i for i, line in enumerate(lines) if line.startswith(key + "=")]
if len(indexes) > 1:
    raise SystemExit("Multiple GLOWSTR_ALLOWED_ORIGIN entries; refusing to guess")
if indexes:
    val = lines[indexes[0]].split("=", 1)[1].strip().strip('"').strip("'")
else:
    val = "https://glowstr.com"
origins = [x.strip() for x in val.split(",") if x.strip()]
for origin in origins:
    u = urlsplit(origin)
    if not u.scheme == "https" or not u.netloc or u.path or u.query or u.fragment or u.username or u.password:
        raise SystemExit("Existing origin is not a simple HTTPS origin; edit .env manually")
if "https://app.glowstr.local" not in origins:
    origins.append("https://app.glowstr.local")
new_line = key + "=" + ",".join(origins) + "\n"
if indexes:
    lines[indexes[0]] = new_line
else:
    lines.append(new_line)
fd, temp = tempfile.mkstemp(prefix=".env.android-origin.", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        out.writelines(lines)
        out.flush()
        os.fsync(out.fileno())
    os.chmod(temp, 0o600)
    os.replace(temp, path)
finally:
    if os.path.exists(temp):
        os.unlink(temp)
print("Added/verified Glowstr Android HTTPS origin; no wallet settings changed.")
PY

# Host shell variables take precedence over .env in most Compose providers.
# Export the value we just wrote, not a possibly stale inherited environment.
GLOWSTR_ALLOWED_ORIGIN="$(sed -n 's/^GLOWSTR_ALLOWED_ORIGIN=//p' "$ENV_FILE" | tail -n1)"
[[ ",$GLOWSTR_ALLOWED_ORIGIN," == *",https://app.glowstr.local,"* ]] ||
  { echo "Android origin absent from updated .env; refusing to restart Commerce." >&2; exit 1; }
export GLOWSTR_ALLOWED_ORIGIN
# The backend gives this optional plural variable precedence over the singular.
# Compose supplies only the singular; avoid a stale host override.
unset GLOWSTR_ALLOWED_ORIGINS || true

# Previous deployments used podman-compose versions that could not replace
# Commerce while Caddy/relay-gate still had Podman --requires references to it.
# Force-recreate could report success but leave the OLD Commerce environment.
# Replacing only the affected container objects in dependent order fixes this.
# We NEVER touch the Monero wallet, strfry relay storage, or named data volumes.

if command -v podman-compose >/dev/null 2>&1; then
  COMPOSE=(podman-compose)
elif podman compose version >/dev/null 2>&1; then
  COMPOSE=(podman compose)
else
  echo "No Podman Compose provider found." >&2
  exit 1
fi

android_origin_active() {
  podman exec xmr-relay_commerce_1 python3 -c '
import os, sys
raw = os.getenv("GLOWSTR_ALLOWED_ORIGINS", os.getenv("GLOWSTR_ALLOWED_ORIGIN", ""))
sys.exit(0 if "https://app.glowstr.local" in
         [x.strip() for x in raw.split(",")] else 1)
' >/dev/null 2>&1
}

if android_origin_active; then
  echo "Commerce already allows Glowstr Android; no service restart needed."
else
  # Caddy requires relay-gate and Commerce; the gate requires Commerce.
  # Check ownership BEFORE removing anything and reject unexpected containers.
  managed=(xmr-relay_caddy_1 xmr-relay_relay-gate_1 xmr-relay_commerce_1)
  for name in "${managed[@]}"; do
    podman container exists "$name" ||
      { echo "Expected $name missing; refusing partial recreation" >&2; exit 1; }
    owner="$(podman inspect --type container --format \
      '{{ index .Config.Labels "io.podman.compose.project" }}' "$name")" ||
      { echo "Cannot inspect $name; refusing recreation" >&2; exit 1; }
    [[ "$owner" == "xmr-relay" ]] ||
      { echo "Unexpected owner for $name; refusing recreation" >&2; exit 1; }
  done
  if podman container exists xmr-relay_notifier_1; then
    echo "Optional notifier container exists; refusing an automatic replacement that might disrupt its dependencies." >&2
    exit 1
  fi

  # Avoid exposing wallet-RPC and Commerce admin secrets from podman-compose
  # command output: it may print all its -e KEY=VALUE arguments.
  echo "Replacing stale Caddy, relay-gate and Commerce containers (brief connection interruption)."
  for name in "${managed[@]}"; do
    podman rm -f "$name" >/dev/null ||
      { echo "Could not remove $name; named volumes are untouched" >&2; exit 1; }
  done
  compose_log="$(mktemp "$HERE/.cors-compose.XXXXXXXX.log")"
  chmod 600 "$compose_log"
  if ! "${COMPOSE[@]}" -f compose.yaml -f compose.paid-relay.yaml \
      up -d --no-deps commerce relay-gate caddy >"$compose_log" 2>&1; then
    echo "Could not restart Commerce/gate/Caddy. Private provider log: $compose_log" >&2
    echo "Do not paste that log: it can contain wallet-RPC or admin secrets." >&2
    exit 1
  fi
  rm -f "$compose_log"
  for name in xmr-relay_commerce_1 xmr-relay_relay-gate_1 xmr-relay_caddy_1; do
    podman container exists "$name" ||
      { echo "Expected new $name missing after Compose" >&2; exit 1; }
    [[ "$(podman inspect --type container --format '{{.State.Running}}' "$name")" == "true" ]] ||
      { echo "New $name is not running; inspect its logs (redact secrets)" >&2; exit 1; }
  done
  if ! android_origin_active; then
    echo "Commerce still has the wrong CORS origins; check Compose config (do not share secrets)." >&2
    exit 2
  fi
  echo "Commerce recreated with the Android origin; named volumes preserved."
fi

echo "Private .env backup: $BACKUP"
echo "Do not share .env or the backup; they contain wallet RPC credentials."

# Confirm effective container configuration before testing public HTTPS.
# This prints ONLY public CORS origins, never env secrets or RPC credentials.
echo "Commerce active origin settings:"
podman exec xmr-relay_commerce_1 python3 -c '
import os
single = os.getenv("GLOWSTR_ALLOWED_ORIGIN", "")
plural = os.getenv("GLOWSTR_ALLOWED_ORIGINS")
effective = plural if plural is not None else single
print("  active origins:", effective)
print("  Android origin allowed:", "https://app.glowstr.local" in
      [x.strip() for x in effective.split(",")])
' || { echo "Cannot inspect Commerce CORS settings" >&2; exit 2; }

# Check loopback before public HTTPS: different results identify Caddy issues.
# OPTIONS requests never create an invoice or interact with your Monero wallet.
check_preflight() {
  local url="$1" headers
  headers="$(curl --silent --show-error --max-time 12 --dump-header - --output /dev/null \
    -X OPTIONS -H 'Origin: https://app.glowstr.local' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' \
    "$url")" || return 1
  if printf '%s\n' "$headers" | tr -d '\r' |
      grep -Fqi 'Access-Control-Allow-Origin: https://app.glowstr.local'; then
    return 0
  fi
  printf '%s\n' "$headers" | grep -iE '^(HTTP/|Access-Control-|Location:)' >&2 || true
  return 1
}

if check_preflight 'http://127.0.0.1:8787/v1/invoices'; then
  echo "PASS: Local Commerce API allows Glowstr Android origin."
else
  echo "FAIL: Local Commerce did not allow the Android origin; check effective container settings above." >&2
  exit 2
fi

relay_domain="$(sed -n 's/^GLOWSTR_RELAY_TARGET=//p' "$ENV_FILE" | tail -n1)"
if [[ "$relay_domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
  if check_preflight "https://$relay_domain/xmr-commerce/v1/invoices"; then
    echo "PASS: Public Commerce API permits the Glowstr Android origin."
  else
    echo "FAIL: Local CORS passed but public HTTPS failed; inspect Caddy headers/routing." >&2
    exit 2
  fi
else
  echo "NOTE: Invalid/missing relay target; skipping public HTTPS check." >&2
fi
