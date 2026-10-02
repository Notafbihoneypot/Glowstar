# Glowstr Relay Gate

A loopback-only WebSocket gate in front of strfry for Glowstr's paid-write relay.

Why it exists:

- Glowstr memberships are attached to a real Nostr pubkey.
- Armada Concord can authenticate both the user key and derived stream keys on one connection.
- strfry currently keeps one NIP-42 identity per connection.
- Concord/NIP-59 outer wrappers (kinds 1059 and 21059) intentionally do not use the real user's pubkey as the outer author.

The gate therefore owns network-write authorization while strfry remains the storage/query engine.

Rules:

- reads are forwarded without payment;
- writes require at least one valid NIP-42 AUTH;
- at least one authenticated pubkey must have an active `relay_365d` entitlement;
- ordinary events still require `event.pubkey` to be one of the authenticated keys;
- only kinds **1059** and **21059** get the privacy-wrapper author mismatch exception;
- the event signature is verified before forwarding;
- Commerce failure fails closed.

The public relay should proxy WebSocket upgrades to this gate. strfry must remain loopback-only and should not independently expose a public write path.
