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
Nostr client / Armada
   |  WebSocket / NIP-42 AUTH
   v
Glowstr relay-gate :7778
   |  multi-AUTH + XMR entitlement check
   |  accepted Nostr frames
   v
strfry :7777
   |  private storage/query engine
   |
   +------------------------+
                            |
                    Monero Commerce :8787
                       |          |
                       |          +--> renewal queue --> NIP-17 notifier
                       v
                monero-wallet-rpc :18083

Armada voice:
Armada -> CORD-07 broker :8086 -> LiveKit :7880
                                  | TCP 7881 / UDP 7882
                                  v
                              WebRTC media
```

The public reverse proxy sends relay **WebSocket** traffic through `relay-gate`, while HTTP/NIP-11 can go directly to loopback-only strfry.

A network write is accepted only when all of these are true:

1. At least one valid NIP-42 identity has authenticated on the socket.
2. At least one authenticated identity has an unexpired `relay_365d` entitlement.
3. For ordinary events, `event.pubkey` is one of the authenticated identities.
4. Only privacy-wrapper kinds **1059** and **21059** may use an outer author that is not one of the authenticated identities.

The narrow wrapper exception is required for NIP-59 and Armada Concord privacy envelopes; it does not disable author matching for ordinary notes. The gate verifies event signatures and fails closed if Commerce is unavailable.

This gate also solves Armada's multi-AUTH behavior: Armada may authenticate a derived Concord stream key immediately and the real user key later on the same socket. Upstream strfry currently keeps only one NIP-42 identity per connection, so it remains private behind the gate rather than being the public authorization layer.

## Payment flow

1. Glowstr requests a `relay_365d` invoice.
2. Commerce fetches XMR/USD, converts $10 to atomic XMR, and stores that locked amount.
3. Commerce creates a fresh wallet subaddress.
4. A background reconciler monitors unpaid invoices even when the client closes.
5. At 0 confirmations the invoice is `MEMPOOL`; below the threshold it is `CONFIRMING`.
6. At 2 confirmations, Commerce grants or extends the entitlement by 365 days.
7. The relay gate sees the active entitlement and accepts authenticated writes.

Invoice polling is still supported for UI status, but it is no longer required for payment recognition.

## Renewal reminders

When an annual entitlement enters its final 30 days, Commerce creates one pending reminder row keyed to that exact expiry. The separate `nip17-notifier` service consumes the queue, discovers the member's NIP-17 `kind:10050` inbox relays, creates NIP-44/NIP-59 gift wraps, and marks the reminder delivered only after at least one recipient inbox relay accepts it.

Glowstr can publish the member's `kind:10050` list from **Relays → NIP-17 Private Inbox**. If a member has not published an inbox list, the notifier leaves the reminder pending and retries later instead of leaking the message to arbitrary fallback relays.

- `GET /v1/admin/reminders?status=pending`
- `POST /v1/admin/reminders/<id>/sent`
- `POST /v1/admin/reminders/<id>/failed`

The Nostr notification key is deliberately isolated from Monero Commerce.

For the current production deployment, wallet sync gate, unpaid-write smoke test,
real-XMR acceptance test, and backup checklist, follow **[LAUNCH.md](LAUNCH.md)**.

## Lightweight 512 MB paid-relay deployment

Run the interactive installer:

```sh
cd xmr-relay
bash setup-paid-relay.sh
```

It asks for:

- paid relay domain (default `relay.glowstr.com`)
- Glowstr web/app origin (default `https://glowstr.com`)
- wallet mode
- remote Monero daemon URL
- primary Monero address
- private view key (hidden input)
- wallet restore height

The recommended/default wallet mode runs a **view-only** `monero-wallet-rpc` on the VPS and points it at a remote Monero daemon. The script never asks for the seed or private spend key. It uses the private view key only during view-wallet creation; the raw view key is not written to Glowstr's `.env`.

For x86_64/arm64 Debian/Ubuntu systems, if `monero-wallet-rpc` is missing the script can install the current pinned official Monero CLI wallet RPC binary and verifies its SHA-256 before installing. On low-memory hosts it also attempts to create 1 GB of swap.

The tiny profile runs only:

- Caddy
- `relay-gate`
- strfry
- Monero Commerce
- local view-only `monero-wallet-rpc` (when the recommended mode is chosen)

It does **not** run `monerod`, NIP-17 notifier, Armada, or LiveKit.

### How Glowstr learns that payment succeeded

Glowstr creates an invoice tied to the logged-in Nostr pubkey. Commerce creates a fresh subaddress, returns an invoice id/token, and keeps reconciling the wallet even if the app closes. Glowstr polls its private invoice URL. Once the wallet sees enough confirmed XMR, Commerce writes the `relay_365d` entitlement and returns `status: PAID` plus `access_valid_until`.

The relay gate independently enforces that entitlement after NIP-42 authentication, so client-side UI state cannot grant access by itself.

Public API:

```text
https://relay.glowstr.com/xmr-commerce/v1
```

Public ports: TCP 80/443 only. Keep 7777, 7778, 8787, and 18083 private.

## Deploy with Podman

Copy `.env.example` to `.env`, set a strong admin token and wallet RPC credentials, then:

```sh
podman compose up -d --build
```

Commerce, relay-gate, and strfry bind to host loopback; Caddy is the only intended public HTTP/WebSocket listener. Keep `monero-wallet-rpc` on loopback and use RPC authentication.

To enable encrypted renewal notifications, create a dedicated notifier key file, configure the `GLOWSTR_NIP17_*` values in `.env`, then start the notification profile:

```sh
mkdir -p secrets
chmod 700 secrets
# Write a dedicated 64-hex Nostr service secret to secrets/notifier.key.
chmod 600 secrets/notifier.key

podman compose --profile notifications up -d --build
```

Do not use a personal Nostr key for the notifier and never commit `secrets/notifier.key`. The notifier container only receives this dedicated Nostr key, the Commerce admin capability, and outbound network access; it does not receive Monero wallet RPC credentials.

## Important environment

- `GLOWSTR_RELAY_FEATURE=relay_365d`
- `GLOWSTR_RELAY_USD_CENTS=1000`
- `GLOWSTR_XMR_CONFIRMATIONS=2`
- `GLOWSTR_XMR_USD_URL` — default Kraken public XMR/USD ticker
- `GLOWSTR_XMR_USD_OVERRIDE` — staging/test fixed price only
- `GLOWSTR_RECONCILE_SECONDS=20`
- `GLOWSTR_INVOICE_SECONDS=1800`
- `GLOWSTR_LATE_PAYMENT_GRACE_SECONDS=300`
- `GLOWSTR_ENTITLEMENT_CACHE_SECONDS=15`
- `GLOWSTR_GATE_MAX_AUTH_KEYS=64`
- `GLOWSTR_ALLOW_PRIVACY_WRAPPERS=true` — author-mismatch exception only for kinds 1059/21059
- `GLOWSTR_NIP17_SECRET_PATH` — local path to the dedicated notifier key file
- `GLOWSTR_NIP17_LOOKUP_RELAYS` — public discovery relays used to find members' `kind:10050` events
- `GLOWSTR_NIP17_POLL_SECONDS=300`
- `GLOWSTR_NIP17_RETRY_SECONDS=21600`

## Security notes

- Keep wallet RPC and Commerce admin APIs private.
- Keep the relay gate's ordinary author matching enabled; do not broaden the 1059/21059 privacy-wrapper exception to normal event kinds.
- Invoice creation has application-level IP/pubkey throttling; also rate-limit at Caddy/firewall level.
- Commerce uses SQLite WAL and a busy timeout for concurrent reconciliation/API access.
- Public 500 responses do not expose wallet-RPC exception details.
- Back up the relay LMDB and Commerce SQLite database separately.


## Armada voice staging

The all-in-one staging installer also deploys a CORD-07-compatible blind voice broker plus LiveKit. It uses:

- `voice-staging.glowstr.com` for HTTPS broker requests and WSS LiveKit signaling,
- TCP 7881 for ICE/TCP,
- UDP 7882 for ICE/UDP.

The Nostr relay does **not** carry raw audio. Armada publishes encrypted Concord call presence/control data through Nostr; LiveKit carries the WebRTC media.

See `HERMES-STAGING.md` for the end-to-end two-device test.
