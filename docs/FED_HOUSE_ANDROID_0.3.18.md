# Glowstr 0.3.18 — fed.house NIP-05 names

Android app: `Glowstr`, package `org.glowstr.meshbridge`, `versionCode=30`, `versionName=0.3.18`.

## Customer feature

- One-time **$4 USD-equivalent in XMR** for a name like `alice@fed.house`.
- No customer renewal fee; it works only while the operator continues to host `fed.house` and the registry.
- Log in to Glowstr with a Nostr signer (local, Amber or FROSTR/NIP-46).
- Open the **NIP-05 NAME — ONE-TIME XMR PURCHASE** panel.
- The browser asks the configured Commerce service which domain and price are active and checks that `https://fed.house/.well-known/nostr.json?name=__glowstr_probe` returns valid, CORS-readable JSON before enabling checkout. Until then, purchases are **disabled**.
- Enter a lowercase 1–30 character name, check availability, and approve the signed Nostr kind-27235 ownership claim with the logged-in signer. A typed pubkey alone does not authorize registration.
- The server allocates a unique Monero invoice subaddress, checks payment with view-only wallet-RPC, and assigns the name only after **two confirmations**.
- Verify that `https://fed.house/.well-known/nostr.json?name=<name>` maps to your own Nostr hex public key and then press **VERIFY & ADD NIP-05 TO PROFILE** to publish kind-0 metadata.
- Failed, conflicting or late credits require operator review. **Never pay the same invoice twice.**

## Deployment separation

The Android client and its signing/CI files are on **main**. The actual payment settlement, Schnorr ownership proof verifier, name registry, and optional fed.house Caddy site are on `feature/xmr-relay-annual-v1` because that branch runs the working production paid relay. Do not replace the live VPS with the older main-branch Commerce server.

The backend is deliberately disabled until the operator has control of fed.house, matching DNS and HTTPS, working backups and successful NIP-05 tests. See the live-relay branch document:

https://github.com/Notafbihoneypot/Glowstar/blob/feature/xmr-relay-annual-v1/xmr-relay/FED_HOUSE_NIP05_DEPLOY.md

## APK build/signing

**Do not use the prior 0.3.17 unsigned APK ZIP for this release.** The new NIP-05 code is in the 0.3.18 source. Run the `Build Android APK` workflow on main, download the `Glowstr-Android-Unsigned-Review` artifact, check its hash, and sign it with the existing **offline Qubes** keystore using the repository's `docs/OFFLINE-APK-SIGNING.md`.

Never put the APK signing keystore/alias password, Nostr private key, FROST share or wallet RPC secret in GitHub Actions, a VPS or a support log. Unrelated debug certificates cannot update an owner-signed app; retain package ID and signing certificate for all later updates.

## Release readiness gates

- Complete both GitHub CI suites (Android main and paid relay feature).
- Validate built Android release is non-debuggable, unsigned, versionCode 30 and label Glowstr.
- Verify NIP-05 ownership signature (including signer mismatch, stale claims and tampering rejection).
- Verify name reservation collision handling and two-confirmation settlement.
- Verify strict `*.well-known/nostr.json` GET without redirects and with CORS `*`.
- Run a test name/payment end to end, including wallet-RPC and kind-0 profile update, before accepting customers.
- Test offline signing and an Android install on a noncritical device/profile first.
