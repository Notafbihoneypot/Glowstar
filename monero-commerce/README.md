# Glowstr Monero Commerce

Glowstr Commerce powers the annual XMR-paid Nostr relay membership.

## Annual relay product

`relay_365d` costs **$10 USD equivalent in XMR** for 365 days of relay write access.

At invoice creation Commerce:

1. obtains the current XMR/USD price,
2. calculates the atomic XMR amount without float arithmetic,
3. locks that amount to the invoice,
4. creates a fresh Monero subaddress,
5. returns a Monero URI and random invoice capability token.

By default, two confirmations are required.

## Server-side reconciliation

Payment recognition does not depend on the phone or PWA remaining open. A background worker checks outstanding invoice subaddresses with `monero-wallet-rpc` and moves invoices through:

`WAITING -> MEMPOOL -> CONFIRMING -> PAID`

Only non-double-spent incoming value with the required confirmations counts toward access. Multiple payments to the invoice subaddress may satisfy the total. Once paid, the entitlement is granted automatically.

Renewals stack from the current `valid_until` when access is still active, so renewing early never loses remaining days.

## Expiry

When `valid_until` passes, the relay policy stops accepting network writes for that Nostr pubkey. Public reads remain unaffected. Once a renewal reaches the confirmation threshold, access becomes active again.

## Renewal reminders

Within the final 30 days of an annual entitlement, Commerce inserts one reminder into a private admin queue. A separate NIP-17 notifier should consume that queue and mark each reminder sent.

This split is deliberate: the Monero service does not need to hold a Nostr service private key.

## API

### Create invoice

`POST /v1/invoices`

```json
{"pubkey":"<64 hex chars>","feature":"relay_365d","target":"relay.glowstr.com"}
```

The response contains the locked XMR amount, price used, fresh subaddress, Monero URI, invoice token, expiry, and confirmation requirement.

### Invoice status

`GET /v1/invoices/<id>`

Use `Authorization: Bearer <invoice token>`.

The response includes `WAITING`, `MEMPOOL`, `CONFIRMING`, `PAID`, or `EXPIRED`, plus `access_valid_until` once the membership exists.

### Entitlements

`GET /v1/admin/entitlements/<pubkey>`

Requires the Commerce admin bearer token.

### Reminder queue

`GET /v1/admin/reminders?status=pending`

`POST /v1/admin/reminders/<id>/sent`

Both require the admin bearer token.

## Security model

- Keep `monero-wallet-rpc` on loopback/private networking with RPC authentication.
- Prefer a dedicated receiving wallet and separate spending boundary.
- The browser/APK never receives wallet credentials, wallet files, view/spend keys, transaction history, or the Commerce admin token.
- Invoice capability tokens are stored hashed.
- Public server errors are generic.
- Add reverse-proxy rate limiting in addition to the service's basic invoice throttles.
