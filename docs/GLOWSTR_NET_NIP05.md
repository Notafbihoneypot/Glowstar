# `name@glowstr.net` — NIP-05 names sold for Monero

From 0.3.20 the Android client sells names on **glowstr.net only**. The domain is a constant in the client (`GLOWSTR_NIP05_DOMAIN`); the commerce server has to advertise the same domain or checkout stays off.

**Customer promise:** Pay once in XMR. No renewal fees. Your Nostr name stays assigned for as long as Glowstr operates the `glowstr.net` registry. You are buying a NIP-05 alias, not a domain registration, email address, or ownership of a Nostr key.

**Staging status (2026-11-24):** `glowstr.net` has nameservers but no public A or AAAA record. Live commerce does not advertise `nip05_lifetime`. DNS/TLS, registry restore, and a real purchase remain launch gates.

## What the client does

1. Asks the commerce API (`/xmr-commerce/v1/features`) for the `nip05_lifetime` product.
2. Enables checkout only if **all** of these hold:
   - the product's `domain` is exactly `glowstr.net`;
   - `usd_cents` is `400`;
   - `GET https://glowstr.net/.well-known/nostr.json?name=__glowstr_probe` returns 200, without a redirect, readable cross-origin, with a JSON body containing a `names` object.
3. The buyer signs a kind-27235 claim for `name@glowstr.net` with their Nostr signer, receives a one-off Monero subaddress, and pays once.
4. After two confirmations the name maps to the buyer's pubkey. **Verify & add NIP-05 to profile** re-checks the mapping and publishes kind 0.

If any check fails the panel reads `OFFLINE` and no invoice can be created.

## What you need to do on the server

The registry, payment settlement and `/.well-known/nostr.json` route live on the `feature/xmr-relay-annual-v1` branch. Follow `xmr-relay/NIP05_DOMAIN_DEPLOY.md` there, with these values:

```dotenv
GLOWSTR_NIP05_DOMAIN=glowstr.net
GLOWSTR_NIP05_USD_CENTS=400
GLOWSTR_NIP05_ENABLED=0     # keep off while staging DNS/TLS and restoring a backup
```

Keep `https://app.glowstr.local` in `GLOWSTR_ALLOWED_ORIGIN` — that is the origin the Android WebView sends.

**DNS.** Point the apex `glowstr.net` A (and AAAA, only if the VPS answers IPv6) at the relay VPS. NIP-05 for `alice@glowstr.net` is fetched from the apex, so the apex itself must serve the well-known route; a redirect to `www` breaks it.

**Check before enabling sales:**

```sh
curl -sS -D- -o /tmp/n.json 'https://glowstr.net/.well-known/nostr.json?name=__glowstr_probe'
# expect: HTTP 200, Access-Control-Allow-Origin: *, no Location header, body {"names":{}}

curl -sS 'https://notafbihoneypotrelay.com/xmr-commerce/v1/features'
# with sales off: features.nip05_lifetime is absent
```

Before opening sales publicly, verify an off-host registry backup can be restored. In a controlled test, enable checkout, confirm `features.nip05_lifetime` advertises `glowstr.net` at `400` cents, and buy one throwaway name. Wait for two confirmations, then verify the name resolves to the test pubkey in another Nostr client. Turn sales back off if the purchase fails; do not pay the failed invoice again.

## Domain boundary

The public site and NIP-05 lookup use `glowstr.net`. The existing relay and checkout API remain on `notafbihoneypotrelay.com`. See [ADR 0001](adr/0001-keep-relay-host-separate.md).

## Things to decide

- **Reserved names.** Block `_`, `admin`, `support`, `help`, `security`, `abuse`, `postmaster`, `root`, `glowstr`, `relay`, `nostr`, `monero`, `xmr` and close look-alikes on the server before opening sales. `_@glowstr.net` should map to the project's own key.
- **Web app.** If the client is ever served from `https://glowstr.net`, add that origin to `GLOWSTR_ALLOWED_ORIGIN` and send `Content-Security-Policy` as a response header with `frame-ancestors 'none'`.
- **Privacy of the registry.** `nostr.json?name=` answers one name at a time. Do not serve the full list without a `name` parameter, or the customer list becomes public in one request.
- **Operator duty.** A one-time fee does not end the renewal, hosting and backup costs. If the domain lapses, every sold name stops verifying.
