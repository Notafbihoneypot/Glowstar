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

# Only recreate Commerce. Do not recreate monero-wallet-rpc, relay, or relay gate.
if podman compose version >/dev/null 2>&1; then
  COMPOSE=(podman compose)
elif command -v podman-compose >/dev/null 2>&1; then
  COMPOSE=(podman-compose)
else
  echo "No Podman Compose provider; manually restart just the commerce service." >&2
  echo "Private backup: $BACKUP" >&2
  exit 1
fi

"${COMPOSE[@]}" -f compose.yaml -f compose.paid-relay.yaml up -d --no-deps --force-recreate commerce
echo "Commerce service recreated. Private backup: $BACKUP"
echo "Do not share .env or the backup; they contain wallet RPC credentials."

# Public unauthenticated CORS preflight; never creates an invoice or spends XMR.
relay_domain="$(sed -n 's/^GLOWSTR_RELAY_TARGET=//p' "$ENV_FILE" | tail -n1)"
if [[ "$relay_domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
  headers="$(curl --silent --show-error --max-time 12 --dump-header - --output /dev/null \
    -X OPTIONS -H 'Origin: https://app.glowstr.local' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' \
    "https://$relay_domain/xmr-commerce/v1/invoices")" || {
      echo "Public preflight unreachable. Check DNS/TLS/Caddy and try again." >&2
      exit 2
    }
  if printf '%s\n' "$headers" | tr -d '\r' | grep -Fqi 'Access-Control-Allow-Origin: https://app.glowstr.local'; then
    echo "PASS: Public Commerce API permits the Glowstr Android origin."
  else
    echo "FAIL: HTTPS endpoint did not return Android Access-Control-Allow-Origin." >&2
    echo "Check Caddy routing and Commerce logs. HTTP response headers:" >&2
    printf '%s\n' "$headers" | grep -iE '^(HTTP/|Access-Control-|Location:)' >&2 || true
    exit 2
  fi
fi
