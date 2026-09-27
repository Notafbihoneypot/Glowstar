# Glowstr NIP-17 Renewal Notifier

This service consumes the private renewal-reminder queue from Glowstr Monero Commerce and delivers encrypted NIP-17 direct messages.

## Privacy / protocol behavior

- The service key is separate from Monero Commerce.
- Messages are NIP-17 kind 14 rumors, encrypted with NIP-44 and wrapped with NIP-59 kind 1059 gift wraps.
- The outer gift wrap uses a fresh random key and randomized timestamp.
- The notifier discovers the recipient's **kind 10050** DM inbox relay list.
- It does **not** fall back to arbitrary relays when no kind 10050 event is found.
- Recipient-supplied relay URLs are treated as untrusted: only public `wss://` destinations are accepted, and private/reserved DNS/IP targets are rejected.
- A sender-addressed gift wrap is kept in a private local archive; it can also be published to operator-configured sender inbox relays.

## Configuration

Required:

- `GLOWSTR_NIP17_SECRET_FILE` — file containing a dedicated 64-hex Nostr secret or nsec.
- `GLOWSTR_COMMERCE_ADMIN_TOKEN` or `GLOWSTR_COMMERCE_ADMIN_TOKEN_FILE`.
- `GLOWSTR_NIP17_LOOKUP_RELAYS` — comma-separated public relays used only to discover kind 10050 events.

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

Use a dedicated service key, not a personal Nostr key.

After installing the notifier dependencies:

```sh
node -e "import('nostr-tools/pure').then(({generateSecretKey})=>console.log(Buffer.from(generateSecretKey()).toString('hex')))"
```

Write the output to a root-readable secret file and mount it read-only into the notifier container. Never commit it to Git.

The notifier logs its **npub** at startup so the operator can publish profile metadata/NIP-05 for an identifiable Glowstr service account if desired.
