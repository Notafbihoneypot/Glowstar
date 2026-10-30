# Glowstr Relay — source review, checkout QR and operator stats (2026-10-30)

Scope: branch `feature/xmr-relay-annual-v1`: Caddy, offline payment page,
Commerce, NIP-42 paid relay gate and Podman deployment. This is a focused
static source review and regression-test update, **not** a penetration test,
live Monero payment validation or comprehensive dependency audit.

## Delivered on this branch

- Checkout QR is generated **in the browser** from the exact `monero:` payment
  URI returned with each invoice. This includes the unique Monero subaddress
  and exact XMR amount, and does not call a remote QR service.
- The vendor library `qrcode.min.js` is the MIT-licensed qrcodejs project
  (2012, davidshimjs); license notice retained in `qrcode-LICENSE.txt`.
- Browser checkout verifies the QR's Monero URI address and amount match the
  invoice, offers copy-address and copy-payment-link controls.
- Checkout scripts are locally hosted, with Caddy CSP that blocks third-party
  scripts, framing and unnecessary permissions.
- Public invoice polling is **read-only**; the Commerce reconciliation worker
  alone queries wallet RPC. A recent successful scan is required before the
  browser declares payment verification healthy. Payment activation remains
  server-side and requires 2 confirmations.
- Operator-only `GET /v1/admin/stats` returns aggregated paid invoice counts,
  annual and lifetime payments, active paying public-key count, pending invoice
  count and gross USD invoice value. Requires the existing Commerce admin
  bearer token; never returns identities, payment addresses or transaction IDs.
- Nostr gate rejects malformed event-signature checks safely. Connections now
  have a 240-message/minute and 50-message/5-second budget to limit anonymous
  REQ and similar traffic; paid-write per-pubkey limits still apply.
- `GLOWSTR_STACK_UPDATE_ONLY=1` updates existing Podman services without
  changing the encrypted view-only wallet, remote daemon, its systemd service
  or the existing `.env` settings.

## Deploy safely (on the existing VPS)

**First** take a snapshot and make secure copies of the Commerce and strfry
named volumes, the encrypted wallet files in
`/var/lib/glowstr-monero-wallet/`, the wallet-RPC configuration under
`/etc/glowstr/` and `xmr-relay/.env`. Never commit secrets to GitHub.

```sh
cd /root/Glowstar
git checkout feature/xmr-relay-annual-v1
git pull --ff-only origin feature/xmr-relay-annual-v1
cd xmr-relay
GLOWSTR_STACK_UPDATE_ONLY=1 bash setup-paid-relay.sh
```

This is a **brief disruptive** update that recreates Caddy, Commerce,
relay-gate and strfry containers but preserves their named data volumes. It
will not recreate the wallet or reset the Monero node. Avoid
`ROTATE_SECRETS=1` unless intentionally rotating exposed credentials.

Once updated, test:

```sh
curl -fsS http://127.0.0.1:8787/ready
curl -fsS http://127.0.0.1:7778/health
curl -fSI https://notafbihoneypotrelay.com/app.js
curl -fSI https://notafbihoneypotrelay.com/qrcode.min.js
curl -fsS https://notafbihoneypotrelay.com/xmr-commerce/v1/features
```

An unpaid fresh invoice should eventually show `WAITING — 0/2` with
healthy monitoring; QR should scan to the same address and amount shown in
the checkout. Do not send Monero if monitoring is stale. Test real payments
and paid publishing separately.

For stats from the VPS, avoid printing the admin token or putting it in
shell history. Read it from the local protected `.env` file and pass it
privately to the local `/v1/admin/stats` endpoint.

## Remaining issues / recommended next phase

1. **Rate limiting beyond one socket (high availability risk).** Per-socket
   limits do not protect against many source IPs, HTTP connection floods or
   upstream distributed attacks. Add provider-side network limits plus
   no-Cloudflare, self-hosted connection-rate limits and structured alerts.
2. **Abuse/moderation (medium).** Paid membership does not make an event
   trustworthy. Add opt-in local denylist for exact public keys and event
   kinds, quarantines, adjustable rule reasons, review/expiry, and optional
   operator-maintained URL/domain filters. Do not automatically trust or
   import unaudited third-party blocklists. Encrypted privacy wrappers cannot
   be safely classified by plaintext keyword filters.
3. **Remote-node trust and synchronized wallets (high payment reliability).**
   Commerce cannot verify payments if the selected daemon disappears or the
   view-only wallet lags. Monitor wallet height vs daemon height, RPC
   availability, errors and backup integrity; use a controlled fallback
   daemon, not one chosen silently by a third party.
4. **Invoice recovery (medium usability).** The bearer token for a status
   lookup exists only in the current checkout page's JS state. Refreshing
   the page loses the status link even though the server keeps the invoice.
   Add a user-initiated encrypted/exportable recovery slip or fragment-only
   recovery link with clear token-sharing warning.
5. **Durable quotas (medium).** Per-paid-key byte and count budgets are
   in-memory and reset on gate restarts. Persist a compact usage ledger if
   abuse becomes material, and clean up old entries.
6. **CI and dependency scanning (medium).** The existing GitHub Actions
   Commerce step does not explicitly install Python `requests`; it should
   do so in an isolated test virtualenv. Add SBOM, dependency scanning,
   frozen dependencies and a scheduled release review.
7. **Encrypted backups and restore drills (high operations).** Regularly
   back up the Commerce SQLite DB (using SQLite backup APIs or stopping
   Commerce), strfry data, view-only wallet files and settings. A backup
   must be restorable without reconstructing paid entitlements by guessing.
   Keep spend keys/seeds strictly offline.

## Privacy-minded statistics roadmap

The operator JSON endpoint is a start. Later add per-hour aggregates for
active connections, accepted/rejected events, quotas, relay LMDB disk use,
backlog/latency and wallet synchronization; do **not** retain reader IPs,
Nostr reading histories or public per-user financial charts.
