# Glowstr paid relay — annual + lifetime membership

This is the existing `xmr-relay` Podman/Caddy/strfry/relay-gate/Monero-Commerce stack.

## Plans

| Feature ID | XMR invoice price | Authorized publishing |
| --- | --- | --- |
| `relay_365d` | USD $10 equivalent | 365 days after confirmation, prepaid renewal stacks onto current annual expiry |
| `relay_lifetime` | USD $40 equivalent | One time, for the **operating lifetime of this relay** |

Both require 2 on-chain Monero confirmations by default. **The default VPS profile checks confirmed transfers only:** the invoice may remain `WAITING` until the first block confirmation and then become `CONFIRMING`; it becomes `PAID` only after at least two confirmations. This avoids a Monero 0.18.x wallet-RPC failure during daemon mempool-refresh calls. `GLOWSTR_XMR_CHECK_MEMPOOL=1` is an optional opt-in for operators who have verified that `get_transfers` with `pool: true` works reliably on their daemon. No automatic recurring payment. Users own their Nostr keys, not accounts or email addresses. Public reading stays free; both products authorize NIP-42 publishing by the paid pubkey. Both may be used by any compatible Nostr client.

*Lifetime* means while the operator continues this relay service; it is **not** a guarantee of permanent hosting, permanent storage, or a 9999-year business promise. Internally the database stores a far-future `valid_until=253402300799` as the nonexpiring entitlement marker. Do not surface that value as a literal service expiry date. If an annual member upgrades to lifetime, the original annual row remains intact, but no longer needs renewing. Pending annual renewal reminders are canceled or suppressed.

## Fair-use and anti-abuse policy (both plans)

- Maximum **60 relay-gate-accepted EVENT requests per minute** and **5,000 per day**, per paid pubkey, across current connections. This is a *best-effort, in-memory* throttle, not a durable usage ledger; counters reset on process restart.
- Up to **2 MiB of uploaded event data per day** per paid pubkey. This is tracked in memory and can reset after a process restart; it is not a durable disk quota.
- Events may not exceed **64 KiB** as enforced by strfry; limits on tags, subscriptions, query filters, concurrent sockets, and message buffers still apply.
- No event floods, harassment via automated spam, bulk mirror traffic that overwhelms the VPS, or access resale. Limitations apply equally to annual and lifetime subscriptions.
- A privacy wrapper (NIP-59/Concord) may be published under a derived author key when an authenticated paid member is on the same connection; its traffic counts against that paid member.
- Storage/retention and service uptime are best effort. Users should replicate important events elsewhere. **No byte quota or suspension dashboard is implemented**; operator moderation requires separate tooling.

This policy is visible on the public static homepage. The gate enforces publish-attempt rates, and strfry continues to reject malformed and oversized requests. These protections are a starting point for a small 512 MB VPS, not unlimited bot hosting or comprehensive DDoS mitigation.

## Upgrade an existing installation

Back up the commerce and relay volumes, your encrypted view-only wallet files, and the private `.env` before applying a major service upgrade. Never publish your private view key or RPC password.

```sh
cd /root/Glowstar
git checkout feature/xmr-relay-annual-v1
git pull --ff-only origin feature/xmr-relay-annual-v1
cd xmr-relay
bash setup-paid-relay.sh
```

The installer reuses an existing `relay-view` wallet and existing Commerce admin token. New `.env` settings are:

```text
GLOWSTR_RELAY_USD_CENTS=1000
GLOWSTR_RELAY_LIFETIME_USD_CENTS=4000
GLOWSTR_GATE_MAX_WRITES_PER_MINUTE=60
GLOWSTR_GATE_MAX_WRITES_PER_DAY=5000
GLOWSTR_GATE_MAX_BYTES_PER_DAY=2097152
```

Compose passes `GLOWSTR_RELAY_FEATURES=relay_365d,relay_lifetime` to the gate.

### Verify without paying

```sh
curl -fsS https://YOUR_RELAY_DOMAIN/xmr-commerce/v1/features
curl -I https://YOUR_RELAY_DOMAIN/
podman ps
```

The features response should include **both** `relay_365d` and `relay_lifetime` before accepting real customer payments.

### Checkout

The one-file homepage uses `POST /xmr-commerce/v1/invoices` with the user's Nostr hex pubkey and `feature: "relay_365d"` or `feature: "relay_lifetime"`. Each invoice has a unique XMR subaddress and a bearer token used to check status. Tokens should not be disclosed. Wallet RPC stays bound to `127.0.0.1`. Users never provide a spend key or wallet seed.

If lifetime is active for a relay/pubkey combination, requests for another annual or lifetime invoice return `409 already_lifetime_member`.

## Regression tests (for a development environment)

```sh
python3 ../monero-commerce/test_server.py
cd ../relay-gate && npm ci && npm test
```

These tests simulate payment states and exercise fair-use logic. They do **not** verify live RPC wallet connectivity, successful Monero confirmations, or external HTTPS deployment. Do an end-to-end staging checkout before announcing paid access.
