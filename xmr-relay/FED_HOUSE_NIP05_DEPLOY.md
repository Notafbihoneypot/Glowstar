# fed.house: final Glowstr NIP-05 launch checklist

**Not yet deployed or payment-tested.** These changes are on the **existing live paid relay branch** `feature/xmr-relay-annual-v1`, not the older Commerce backend on main. The Glowstr Android client changes are on main (0.3.18, unsigned for owner-held Qubes signing).

## Contract

- NIP-05 names: `alice@fed.house`; lowercase names with 1–30 characters (`a-z0-9._-`), except reserved operator identifiers.
- One payment: **$4 USD equivalent in XMR**, 2 confirmations, one unique wallet subaddress per invoice.
- Name remains mapped to the **signing purchaser's Nostr pubkey** with no customer renewal fee, for as long as the operator maintains the registry and domain.
- Name ownership is permanent/immutable in the registry. Purchaser signs a short-lived Nostr kind 27235 claim for the exact name; Commerce checks its Schnorr signature by calling the existing localhost relay-gate.
- Never credit a name from unverified, zero-confirmation, double-spend, mismatched, late or conflicting payments; unresolved credits become operator review.
- Back end uses existing view-only monero-wallet-rpc; no spend key and no local full node required.

## 1. Prepare DNS and back up

You must own/control `fed.house`. Create its A/AAAA records pointing to the existing relay VPS (remove stale AAAA records if the VPS cannot answer IPv6). Caddy must be able to obtain HTTPS for the host via ports 80/443. No DNS proxy is required. Confirm the hostname has not been delegated elsewhere.

Before touching the VPS, take a snapshot and back up Commerce SQLite **using the SQLite backup API or with Commerce stopped**, strfry data, current `.env`, Caddy config and view-only wallet files. Maintain an offline encrypted copy. Never post the wallet RPC credentials, private keys or an `.env` backup.

## 2. Stage DNS/TLS first, with checkout OFF

On the existing VPS checkout only:
```sh
cd /root/Glowstar
git switch feature/xmr-relay-annual-v1
git pull --ff-only origin feature/xmr-relay-annual-v1
cd xmr-relay
chmod 600 .env
```

Edit the existing `xmr-relay/.env` (do **not** run the original installer, which rewrites config). Set **exactly one** of each line:

```dotenv
GLOWSTR_NIP05_DOMAIN=fed.house
GLOWSTR_NIP05_USD_CENTS=400
GLOWSTR_NIP05_ENABLED=0
```

**Preserve your existing `GLOWSTR_ALLOWED_ORIGIN` value including `https://app.glowstr.local`, your Monero remote daemon, admin token, and relay entitlements.** Stage the updated services:

```sh
GLOWSTR_STACK_UPDATE_ONLY=1 bash setup-paid-relay.sh
```

This briefly interrupts Caddy/relay-gate and Commerce, but preserves the named volumes, view-only Monero wallet and daemon configuration. New sales remain disabled. The server will nevertheless serve the public `/.well-known/nostr.json` route so you can verify DNS and TLS.

Check public NIP-05 (GET, not HEAD; no redirects allowed):
```sh
curl -sS --max-time 12 -D /tmp/fed-house-headers.txt -o /tmp/fed-house-body.json \
  'https://fed.house/.well-known/nostr.json?name=glowstr-test'
grep -iE '^(HTTP/|Access-Control-Allow-Origin:|Content-Type:|Location:)' /tmp/fed-house-headers.txt
python3 -m json.tool /tmp/fed-house-body.json
```
Expect HTTP **200**, `Access-Control-Allow-Origin: *`, no Location header/redirect, and `{"names":{}}` for a nonexistent name.

Check that the live relay and Commerce health still work:

```sh
curl -fsS http://127.0.0.1:8787/ready
curl -fsS http://127.0.0.1:7778/health
```

## 3. Enable $4 sales only after full staged tests

When domain, HTTPS, well-known JSON, RPC readiness, signature verifier and database backups have passed, change **only**:

```dotenv
GLOWSTR_NIP05_ENABLED=1
```

Repeat the safe stack update:

```sh
GLOWSTR_STACK_UPDATE_ONLY=1 bash setup-paid-relay.sh
```

Check the public features endpoint: it must advertise `nip05_lifetime` with `usd_cents=400` and `domain=fed.house`. Use a test Nostr identity and a unique inexpensive test name, e.g. `trialuser@fed.house`, then create an invoice in Glowstr 0.3.18. The Nostr signer must approve the ownership claim before a Monero address is allocated.

Pay the precise USD-$4 XMR invoice **once**. Wait for two confirmed blocks; verify the mapping at

`https://fed.house/.well-known/nostr.json?name=trialuser`

and confirm the JSON `names.trialuser` equals the signed test account hex pubkey. Then use Glowstr's **Verify & Add NIP-05 to Profile** button to publish its kind-0 metadata. Verify another Nostr client resolves it.

If the payment stalls, enters REVIEW, or mapping does not appear, **do not send another payment**. Retain the invoice ID and inspect Commerce and wallet-RPC logs without revealing secrets. View-only wallet cannot initiate refunds; operator review/recovery must be handled separately.

## 4. Publish the Android APK (offline owner signing)

The NIP-05 storefront source is on the **main** branch. Build the updated **Glowstr 0.3.18 / versionCode 30** unsigned APK through `.github/workflows/android-apk.yml`. Do NOT sign the old 0.3.17 artifact (it lacks the final name implementation). Transfer unsigned artifact + SHA-256 to your offline Qubes signing qube, verify, zipalign, sign with your owner-held production key, verify signature/certificate/package ID, and then publish only signed APK + checksums. See `docs/OFFLINE-APK-SIGNING.md` on main.

## 5. Operational cautions

- New checkout is controlled by `GLOWSTR_NIP05_ENABLED`; turning sales off does **not** delete existing purchased names, provided you keep `GLOWSTR_NIP05_DOMAIN=fed.house` and the registry database.
- A domain identifier is an alias for a Nostr pubkey, **not** control of the Nostr secret key or proof of personhood. Never sell/transmit private keys.
- One-time customer fees do not remove the operator's recurring domain registration, server hosting, TLS and backup obligations.
- The public NIP-05 JSON needs wildcard CORS; **the Commerce invoice API must not** use wildcard CORS.
- Public requests must never be able to reach private `/v1/admin/*` routes from `fed.house`.
- The working relay currently has active members. Test in a staging environment before deploying a fresh checkout path to mainnet.
