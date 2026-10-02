# Glowstr NIP-17 Renewal Notifier

This service consumes the private renewal-reminder queue from Glowstr Monero Commerce and delivers encrypted NIP-17 direct messages.

## Privacy / protocol behavior

- The service key is separate from Monero Commerce.
- Messages are NIP-17 kind 14 rumors, encrypted with NIP-44 and wrapped with NIP-59 kind 1059 gift wraps.
- The outer gift wrap uses a fresh random key and randomized timestamp.
- The notifier discovers the recipient's **kind 10050** DM inbox relay list.
- It does **not** fall back to arbitrary relays when no kind 10050 event is found.
- Recipient-supplied relay URLs are treated as untrusted: only public `wss://` destinations are accepted, private/reserved DNS/IP targets are rejected, and production can restrict destinations to an operator allowlist.
- A sender-addressed gift wrap is kept in a private local archive; it can also be published to operator-configured sender inbox relays.

## Configuration

Required:

- `GLOWSTR_NIP17_SECRET_FILE` — file containing a dedicated 64-hex Nostr secret or nsec.
- `GLOWSTR_COMMERCE_ADMIN_TOKEN` or `GLOWSTR_COMMERCE_ADMIN_TOKEN_FILE`.
- `GLOWSTR_NIP17_LOOKUP_RELAYS` — comma-separated public relays used only to discover kind 10050 events.
- `GLOWSTR_NIP17_ALLOWED_RELAY_HOSTS` — comma-separated host allowlist for recipient inbox destinations. If omitted, the notifier derives the allowlist from the lookup-relay hosts.

Optional:

- `GLOWSTR_COMMERCE_ADMIN_URL` — default `http://127.0.0.1:8787/v1/admin`.
- `GLOWSTR_NIP17_SENDER_RELAYS` — optional relays for the notifier's sender copy.
- `GLOWSTR_NIP17_ARCHIVE` — default `/data/sender-wraps.jsonl`.
- `GLOWSTR_NIP17_POLL_SECONDS` — default 300.
- `GLOWSTR_NIP17_RETRY_SECONDS` — default 21600 (6 hours after a failed attempt).
- `GLOWSTR_NIP17_BATCH_SIZE` — default 25.
- `GLOWSTR_NIP17_ONCE=1` — process one queue cycle and exit.

## Reminder text

The notification contains only the membership expiry time and renewal instructions. It does not contain an invoice address, transaction ID, payment history, or wallet information.

The user creates a fresh renewal invoice inside Glowstr after opening the notification.

## Key generation

Use a dedicated service key, not a personal Nostr key. The included helper creates the secret file with mode `0600` and prints only the public identity you need for deployment:

```sh
cd nip17-notifier
npm install --ignore-scripts --no-audit --no-fund
npm run keygen -- ../xmr-relay/secrets/notifier.key
```

Copy the printed **public hex key** into `GLOWSTR_NIP17_PUBLIC_KEY` in `xmr-relay/.env`. Commerce exposes only that public key over HTTPS, and the Glowstr client uses it to verify that a renewal-themed NIP-17 message really came from the configured notifier account.

Never commit `secrets/notifier.key`. The notifier also validates at startup that the configured public key matches the mounted secret, preventing an accidental trust-pin mismatch.

The notifier logs its **npub** and public hex key at startup so the operator can publish profile metadata/NIP-05 for an identifiable Glowstr service account if desired.


## Network boundary

A member controls the relay URLs published in their kind 10050 event, so those URLs must never be treated as trusted server configuration. The notifier validates DNS/IP destinations and enforces the operator-approved host list before opening a WebSocket.

For a production host, also enforce outbound firewall rules so the notifier container/process cannot reach RFC1918, link-local, loopback, cloud metadata, or other management networks even if application validation regresses.
