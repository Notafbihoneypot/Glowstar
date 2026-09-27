# Glowstr XMR Relay

A public-read, Monero-paid-write Nostr relay for Glowstr.

## Membership

- Reads are public.
- Writes require NIP-42 authentication.
- Annual write access costs **$10 USD equivalent in XMR**.
- Each invoice gets a fresh Monero subaddress and locks the XMR amount at invoice creation.
- Access activates only after **2 confirmations** by default.
- An active renewal adds 365 days to the existing expiry instead of discarding remaining time.
- If access expires before a renewal reaches the confirmation threshold, writes are denied until payment is confirmed.
- Thirty days before expiry, Commerce queues a renewal reminder for a dedicated NIP-17 notification worker.

## Architecture

```text
Nostr client
   |  WebSocket / NIP-42 AUTH
   v
strfry :7777
   |  writePolicy JSONL
   v
Glowstr XMR policy
   |  private admin HTTP
   v
Monero Commerce :8787
   |        |
   |        +--> renewal reminder queue --> NIP-17 notifier
   v
monero-wallet-rpc :18083
```

A network write is accepted only when all of these are true:

1. The connection completed NIP-42 authentication.
2. By default, the authenticated pubkey matches the event author.
3. That pubkey has an unexpired `relay_365d` entitlement.

The policy fails closed if Commerce is unavailable. Local `Import` and `Stored` sources can remain allowed for operator maintenance.

## Payment flow

1. Glowstr requests a `relay_365d` invoice.
2. Commerce fetches XMR/USD, converts $10 to atomic XMR, and stores that locked amount.
3. Commerce creates a fresh wallet subaddress.
4. A background reconciler monitors unpaid invoices even when the client closes.
5. At 0 confirmations the invoice is `MEMPOOL`; below the threshold it is `CONFIRMING`.
6. At 2 confirmations, Commerce grants or extends the entitlement by 365 days.
7. The relay write-policy sees the active entitlement and accepts authenticated writes.

Invoice polling is still supported for UI status, but it is no longer required for payment recognition.

## Renewal reminders

When an annual entitlement enters its final 30 days, Commerce creates one pending reminder row keyed to that exact expiry. The admin reminder API is intentionally separate from Monero payment handling so a dedicated notifier can sign/encrypt a NIP-17 DM without placing a Nostr service private key in Commerce.

- `GET /v1/admin/reminders?status=pending`
- `POST /v1/admin/reminders/<id>/sent`

## Deploy with Podman

Copy `.env.example` to `.env`, set a strong admin token and wallet RPC credentials, then:

```sh
podman compose up -d --build
```

Commerce and strfry bind to host loopback; Caddy is the only intended public listener. Keep `monero-wallet-rpc` on loopback and use RPC authentication.

## Important environment

- `GLOWSTR_RELAY_FEATURE=relay_365d`
- `GLOWSTR_RELAY_USD_CENTS=1000`
- `GLOWSTR_XMR_CONFIRMATIONS=2`
- `GLOWSTR_XMR_USD_URL` — default Kraken public XMR/USD ticker
- `GLOWSTR_XMR_USD_OVERRIDE` — staging/test fixed price only
- `GLOWSTR_RECONCILE_SECONDS=20`
- `GLOWSTR_INVOICE_SECONDS=1800`
- `GLOWSTR_LATE_PAYMENT_GRACE_SECONDS=300`

## Security notes

- Keep wallet RPC and Commerce admin APIs private.
- Keep `GLOWSTR_REQUIRE_AUTHOR_MATCH=true` unless delegated publishing is explicitly required.
- Invoice creation has application-level IP/pubkey throttling; also rate-limit at Caddy/firewall level.
- Commerce uses SQLite WAL and a busy timeout for concurrent reconciliation/API access.
- Public 500 responses do not expose wallet-RPC exception details.
- Back up the relay LMDB and Commerce SQLite database separately.
