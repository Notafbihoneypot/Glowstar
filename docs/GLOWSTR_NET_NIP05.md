# `name@glowstr.net` — NIP-05 names sold for Monero

From 0.3.19 on, the Android client sells names on **glowstr.net only**. The domain is a constant in the client (`GLOWSTR_NIP05_DOMAIN`); the commerce server has to advertise the same domain or checkout stays off.

Nothing in this document has been deployed or payment-tested. glowstr.net could not be reached from the environment where this was written, so DNS, TLS and the server side are unverified.

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
GLOWSTR_NIP05_ENABLED=0     # switch to 1 only after the checks below pass
```

Keep `https://app.glowstr.local` in `GLOWSTR_ALLOWED_ORIGIN` — that is the origin the Android WebView sends.

**DNS.** Point the apex `glowstr.net` A (and AAAA, only if the VPS answers IPv6) at the relay VPS. NIP-05 for `alice@glowstr.net` is fetched from the apex, so the apex itself must serve the well-known route; a redirect to `www` breaks it.

**Check before enabling sales:**

```sh
curl -sS -D- -o /tmp/n.json 'https://glowstr.net/.well-known/nostr.json?name=__glowstr_probe'
# expect: HTTP 200, Access-Control-Allow-Origin: *, no Location header, body {"names":{}}

curl -sS 'https://notafbihoneypotrelay.com/xmr-commerce/v1/features'
# expect: features.nip05_lifetime = {"domain":"glowstr.net","usd_cents":400,...}
```

Then buy one throwaway name end to end with a test identity before announcing it.

## Things to decide

- **Reserved names.** Block `_`, `admin`, `support`, `help`, `security`, `abuse`, `postmaster`, `root`, `glowstr`, `relay`, `nostr`, `monero`, `xmr` and close look-alikes on the server before opening sales. `_@glowstr.net` should map to the project's own key.
- **Where the API lives.** Checkout still talks to `notafbihoneypotrelay.com`. Moving it to `api.glowstr.net` and the relay to `relay.glowstr.net` would put everything under one name, but NIP-42 binds auth to the relay URL, so existing members would need to re-authenticate and the client constant `GLOWSTR_RELAY_V42` would change. Do it as its own release.
- **Web app.** If the client is ever served from `https://glowstr.net`, add that origin to `GLOWSTR_ALLOWED_ORIGIN` and send `Content-Security-Policy` as a response header with `frame-ancestors 'none'`.
- **Privacy of the registry.** `nostr.json?name=` answers one name at a time. Do not serve the full list without a `name` parameter, or the customer list becomes public in one request.
- **Operator duty.** A one-time fee does not end the renewal, hosting and backup costs. If the domain lapses, every sold name stops verifying.
