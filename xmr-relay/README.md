# Glowstr XMR Relay

A public-read, Monero-paid-write Nostr relay for Glowstr.

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
   |
   v
monero-wallet-rpc :18083
```

Reads are public. A network write is accepted only when all of these are true:

1. The connection completed NIP-42 authentication.
2. By default, the authenticated pubkey matches the event author.
3. That pubkey has an unexpired `relay_30d` entitlement from the Monero Commerce service.

The write policy fails closed if the commerce service is unavailable. `Import` and `Stored` sources can be allowed for operator maintenance; network `IP4`, `IP6`, `Stream`, and `Sync` writes stay gated.

## Why this design

strfry already verifies normal Nostr events and exposes the NIP-42 authenticated pubkey to write-policy plugins. The plugin therefore does not handle Nostr secret keys or duplicate signature verification. The Monero wallet RPC stays outside the relay container.

## Deploy with Podman

Copy `.env.example` to `.env` and set a strong random admin token plus your `monero-wallet-rpc` credentials.

```sh
podman compose up -d --build
```

The compose file binds the relay to `127.0.0.1:7777` and Commerce to `127.0.0.1:8787`. Put TLS in front of both. `Caddyfile.example` shows the intended routing.

`strfry.conf` is configured for `wss://relay.glowstr.com/`. If the public relay hostname changes, update `relay.auth.serviceUrl` before building. NIP-42 authentication requires that URL to match the public relay URL.

## Payment flow

Glowstr creates `relay_30d` invoices through `/xmr-commerce/v1/invoices`. The Commerce service creates a fresh Monero subaddress, tracks payment/confirmations, then stores the entitlement against the buyer's Nostr pubkey. The relay policy checks only the internal entitlement API; wallet RPC credentials and invoice transaction data never go to strfry or the client.

## Policy environment

- `GLOWSTR_COMMERCE_ADMIN_URL` — internal admin API base; default `http://commerce:8787/v1/admin`.
- `GLOWSTR_COMMERCE_ADMIN_TOKEN` — required shared secret; never expose to clients.
- `GLOWSTR_RELAY_FEATURE` — entitlement name; default `relay_30d`.
- `GLOWSTR_RELAY_TARGET` — optional relay target, default `relay.glowstr.com`.
- `GLOWSTR_ENTITLEMENT_CACHE_SECONDS` — positive/negative authorization cache; default 20 seconds.
- `GLOWSTR_REQUIRE_AUTHOR_MATCH` — default `true`; prevents one paid authenticated key from publishing events authored by unrelated pubkeys.
- `GLOWSTR_ALLOW_LOCAL_IMPORTS` — default `true`; allows operator `Import`/`Stored` maintenance paths.

## Security notes

- Keep `monero-wallet-rpc` on loopback/private networking and enable RPC authentication.
- Keep the Commerce admin endpoint private; only the write-policy plugin should have its bearer token.
- Keep `GLOWSTR_REQUIRE_AUTHOR_MATCH=true` unless you deliberately need delegated/bot publishing.
- Rate-limit the public TLS endpoint at the reverse proxy as well as using strfry's request/event limits.
- Back up the strfry LMDB and Commerce SQLite database separately; neither backup needs the Monero spend key.
