# Repair Glowstr Android XMR relay invoice requests

Glowstr Android 0.3.15 uses a bundled WebView with an **HTTPS origin**
`https://app.glowstr.local`. The Monero Commerce server strictly checks
the request Origin; the original VPS installer usually allowed only the web
origin (`https://glowstr.com` or another configured site). In that case the
Android browser blocks `GET /xmr-commerce/v1/features` and the preflight for
`POST /xmr-commerce/v1/invoices` even though the backend and wallet are healthy.

## Existing VPS: one command

**On the VPS hosting the paid relay**, from the cloned checkout of the
`feature/xmr-relay-annual-v1` branch (after pulling the fix):

```bash
cd /root/Glowstar
git switch feature/xmr-relay-annual-v1
git pull --ff-only
bash xmr-relay/fix-android-commerce-origin.sh
```

The repair preserves the existing entries in `xmr-relay/.env`, adds only
`https://app.glowstr.local` to `GLOWSTR_ALLOWED_ORIGIN`, makes a **private
backup** of the full .env file, and recreates **only** the `commerce`
container using the existing Podman Compose files. Wallet RPC, wallet files,
relay-gate, strfry and payment database are not removed or replaced. The
script then verifies the public CORS preflight (this test generates no invoice
or payment). **Never share .env or its backup**; both contain credentials.

For a new install, `setup-paid-relay.sh` now proposes the Android origin
along with the web origin. Existing installations **must** run the repair or
edit their own allowlist; changing the GitHub code does not change a running
VPS's .env configuration.

## Manual verification (no payment)

```bash
curl -i -X OPTIONS \
  -H 'Origin: https://app.glowstr.local' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' \
  https://notafbihoneypotrelay.com/xmr-commerce/v1/invoices

curl -i -H 'Origin: https://app.glowstr.local' \
  https://notafbihoneypotrelay.com/xmr-commerce/v1/features

curl -i https://notafbihoneypotrelay.com/xmr-commerce/ready
```

Expected OPTIONS status **204** with
`Access-Control-Allow-Origin: https://app.glowstr.local`, and features
**200** with `relay_365d` and `relay_lifetime`. The readiness request
should return **200** if database and wallet RPC are reachable. CORS failure
is different from backend invoice-generation failure.

## If invoice creation still fails after preflight passes

The backend creates invoices by looking up the live XMR/USD quote on Kraken
and calling `monero-wallet-rpc create_address`. Either failure may return
`HTTP 500 server_error` or `503 wallet_rpc_unavailable`. The exact error
should be diagnosed from Commerce logs; **do not paste passwords, API tokens,
private view keys, invoice bearer tokens, or wallet files into chat**.

```bash
cd /root/Glowstar/xmr-relay
podman compose -f compose.yaml -f compose.paid-relay.yaml ps
podman compose -f compose.yaml -f compose.paid-relay.yaml logs --tail=80 commerce
curl -fsS --max-time 10 'https://api.kraken.com/0/public/Ticker?pair=XMRUSD' >/dev/null && echo 'Kraken HTTPS OK'
```

Potential failures:

- **Missing Access-Control-Allow-Origin:** fix the CORS allowlist as above.
- **Network error / failed to fetch:** DNS, TLS, CORS, or routing; inspect
  public preflight and HTTPS before touching wallet settings.
- **invalid_relay_target (400):** `GLOWSTR_RELAY_TARGET` on the VPS must be
  `notafbihoneypotrelay.com`, exactly the client target.
- **server_error (500):** check the safe log error type and Kraken price
  connectivity; keep payment creation fail-closed if the quote is unavailable.
- **wallet_rpc_unavailable (503):** check local wallet-RPC service, Digest
  authentication and wallet `create_address`, not only `get_height`.
- **rate_limited (429):** wait for the operator-configured limit; never
  bypass abuse controls.
- **unknown_feature (400):** the deployed Commerce image must support
  `relay_365d` and `relay_lifetime`, not the old 30-day prototype.

No invoices or Monero payments are created by the CORS repair script.
