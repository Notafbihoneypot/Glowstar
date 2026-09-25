# Glowstr Monero Commerce

This is the first backend for Glowstr's XMR-only paid Nostr features. It creates a **fresh Monero subaddress per invoice**, watches that exact subaddress, tracks mempool/confirmations, and grants a time-limited entitlement to the buyer's Nostr pubkey.

## Included features

- `relay_30d`
- `room_30d`
- `storage_10gb_30d`
- `creator_30d`
- `crosspost_30d` — 30-day Crosspost publishing pass (starter default: 0.02 XMR, configurable with `GLOWSTR_XMR_CROSSPOST_30D_ATOMIC`)

Prices in `server.py` are starter values and should be changed before production.

## Security model

The Android/PWA client never receives wallet RPC credentials, wallet files, view keys, spend keys, or transaction history. `monero-wallet-rpc` stays on loopback. The commerce API gets only the minimum RPC access it needs. Use `--rpc-login` and put the commerce API behind HTTPS/reverse-proxy authentication/rate limiting.

For production, use a dedicated receiving wallet and strongly consider a view-only design for internet-facing payment detection. Spending belongs in a separate wallet/security boundary.

Invoice status uses a random bearer capability. The public Nostr network does **not** receive invoice subaddresses, transaction IDs, or the invoice-to-pubkey association.

## Run

```sh
export MONERO_WALLET_RPC=http://127.0.0.1:18083/json_rpc
export MONERO_RPC_USER=glowstr
export MONERO_RPC_PASS='change-me'
export GLOWSTR_COMMERCE_ADMIN_TOKEN='long-random-secret'
export GLOWSTR_ALLOWED_ORIGIN=https://glowstr.com
export GLOWSTR_COMMERCE_DB=/var/lib/glowstr-commerce/commerce.sqlite3
python3 server.py
```

Default API bind is `127.0.0.1:8787`. Put a TLS reverse proxy in front of it rather than binding it directly to the public Internet.

## API

`POST /v1/invoices`

```json
{"pubkey":"<64 hex chars>","feature":"relay_30d","target":""}
```

Returns the unique subaddress, Monero URI, invoice capability token and expiry.

`GET /v1/invoices/<id>` with `Authorization: Bearer <invoice token>` returns `WAITING`, `MEMPOOL`, `CONFIRMING`, `PAID`, or `EXPIRED`.

`GET /v1/admin/entitlements/<pubkey>` with the admin bearer token is intended for the paid relay/room/storage service to check access. Do not expose the admin token to Glowstr clients.

## Next integration

The existing Glowstr client already has XMR profile/post tip buttons and Monero URI/deeplink support. The next UI patch should call this service for paid relay/room/storage purchases and store only the invoice id/token locally until payment completes.
