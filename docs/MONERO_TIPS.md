# Monero tips in Glowstr (0.3.20)

None of this is a merged NIP. It is what Glowstr does today, written down so it can be reviewed, changed, or proposed as a draft.

## Default: a tip leaves no trace on Nostr

Tipping publishes nothing. The client builds a `monero:` URI and shows the payment sheet (QR, copy, open wallet) — the same sheet used for relay plans and names. Glowstr cannot see whether the payment was made.

If the sender writes a note, it is sent as a NIP-17 gift-wrapped DM, which hides sender and recipient from relays. The older kind-4 DM is no longer used for tips, because its tags show both parties publicly. If the recipient has no NIP-17 inbox relays, the note is not sent and the sender is told; the tip can still be paid.

## One-time addresses: `xmr_tip`

A static address in a profile links every tip the recipient ever receives. To avoid publishing one, a profile (kind 0) may carry:

```json
{ "xmr_tip": "https://example.org/xmr-commerce/v1/tip-address" }
```

When the sender continues to payment, the client requests:

```
GET <xmr_tip>?p=<recipient pubkey, 64 hex>
Accept: application/json
```

and expects `{"address":"8…"}`. Rules the client enforces:

- `https` only; no username, password or fragment in the URL; no redirects followed.
- No cookies, no referrer, nothing that identifies the sender.
- The reply must be a 95-character mainnet **subaddress** (starts with `8`). Anything else is ignored.
- 6 second timeout. On any failure the client falls back to the `xmr` / `monero` address in the profile, if there is one.

The endpoint learns the tipper's IP address. That is the trade against a permanently public address, and the request is only made after the sender chooses to tip.

**Server side.** `monero-commerce/server.py` implements the endpoint for the operator's own wallet:

```sh
export GLOWSTR_TIP_ADDRESS_ENABLED=1          # off by default
export GLOWSTR_TIP_ADDRESSES_PER_MINUTE=30    # global cap
```

`GET /v1/tip-address` then returns a new subaddress from the wallet-RPC account on each call. It ignores `p`: every address belongs to the one wallet the server watches, so it suits one person or one project, not a multi-user service. It is the only route that answers any origin (`Access-Control-Allow-Origin: *`); invoice and admin routes keep their origin allowlist. Each call creates a wallet subaddress, so keep the per-minute cap and rate-limit at the reverse proxy too. The live relay runs the server from `feature/xmr-relay-annual-v1`, which does not have this route yet.

**Profile editor.** The XMR field now asks for a subaddress and warns when a primary (`4…`) address is saved without a tip endpoint.

## Optional: publish a payment proof

A sender who wants public credit can open *Publish a payment proof* on the tip sheet and paste the transaction id and the wallet's OutProof. The proof message must be the sender's own Nostr public key (hex), which stops someone else re-posting the proof as theirs. The client then signs and broadcasts:

```json
{
  "kind": 1814,
  "content": "",
  "tags": [
    ["p", "<recipient pubkey>"],
    ["txid", "<64 hex>"],
    ["proof", "OutProofV2…"],
    ["address", "<address that was paid>"],
    ["message", "<sender pubkey — the proof message>"],
    ["amount", "<piconero, only if the sender fixed an amount>"]
  ]
}
```

Anyone with a Monero node can check it with `check_tx_proof(txid, address, message, signature)`.

Limits to know about:

- **The kind number is provisional.** 1814 was chosen from memory of other Monero tipping work and has not been checked against the NIPs kind table or another client's schema. Settle it before asking anyone else to read these events.
- **Glowstr does not yet display or verify receipts.** Verification needs a node; the place to do it is the commerce server, which already talks to wallet-RPC.
- Publishing a proof is permanent and reveals the amount and the address paid.

## Relay price in NIP-11

`xmr-relay/nip11.example.json` advertises `limitation.payment_required`, `payments_url` and `fees`. strfry cannot add those fields itself, so `xmr-relay/Caddyfile.example` answers `Accept: application/nostr+json` requests from that file. The prices in the example ($10 a year, $40 lifetime, paid in XMR) mirror what the client shows; the server remains the source of truth, so change both together. The Caddy rule has not been run against a live relay.
