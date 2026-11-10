# Glowstr Android — security, speed and UX review (2026-11-10)

**What was reviewed:** the source that the APK is built from — `android-helper/` (WebView shell, native bridge, key vault, Bluetooth service), `glowstr-v5.5-relay-frostr-media.html` (the bundled client), the JavaScript that `app/build.gradle` injects at build time, and the CI workflow.

**What this is not:** a test of a signed APK on a device, a dependency audit, fuzzing, or a penetration test. No APK was built for this review — the Android SDK is not reachable from the review environment — so the Gradle and manifest edits below are verified only by reading them and by the non-Android test suites. Run the `Build Android APK` workflow before trusting them.

## 1. Changed in this pass

| Area | Change |
|---|---|
| Speed | Signature maths rewritten (Jacobian coordinates, precomputed base-point table, Euclidean inverse). Measured in Node on the review machine: verify **88.7 ms → 1.5 ms** per event, sign **129 ms → 3.1 ms**. Phones will be slower in absolute terms; the ratio should hold. |
| Speed | An event already verified this session is not re-verified when a second relay delivers the same `(id, sig)`. The id is still re-hashed from the full body every time, so a forged body cannot ride on a cached id. |
| Speed | Off-screen notes skip layout and paint (`content-visibility: auto`). |
| Correctness | BIP-340 public keys with `x >= p` are now rejected, as the spec requires. |
| Bug | Links in notes had `&` escaped twice, so any URL with a query string (`?a=1&b=2`) opened the wrong address. |
| NIP-05 | The name storefront is pinned to `glowstr.net`. A commerce server that advertises any other domain leaves checkout disabled. See `GLOWSTR_NET_NIP05.md`. |
| Android | Bluetooth LE is no longer a hard install requirement (`required="false"`). |
| Bloat | Removed the unused v5.4 client copy (778 KB), the one-off `patch_glowstr_v5_3.py`, two duplicate build types (`mediafix`, `relayrewire` — all three built the same app), their CI steps, and a disabled release step. |
| Tests | Every suite now defaults to the client that actually ships (v5.5) instead of v5.3. New `tests/crypto-regression.cjs` runs BIP-340 vectors, tamper checks and a speed floor. |
| Version | `0.3.19` / `versionCode 31`. |

## 2. Security findings

Severity reflects impact on a user's Nostr key or funds.

### High

**H1 — The raw nsec lives in the WebView.** `loadRememberedLocalSigner` hands the decrypted private key back to JavaScript, where it stays in `state.privateKey`. The Keystore wrapping protects the key at rest only. Anything that gets script running in the page — a WebView engine bug, a future sanitiser regression — can read the key or simply ask the bridge for it. `tests/run_tests.py` currently *asserts* that the native side never signs.
*Fix:* sign natively. Add `signEvent(templateJson)` and the NIP-44/NIP-04 operations to the bridge, keep the key in Java, and never return it. `NostrCrypto.java` already has the curve code for verification. Until then, steer users to Amber or the FROST bunker, which already keep the key out of the page.

**H2 — The vault key needs no user presence.** The AES key is created without `setUserAuthenticationRequired`, so any code running as the app can decrypt at any time, including while the phone is locked after first unlock.
*Fix:* require biometric/credential auth with a short validity window, request StrongBox where available, and `setUnlockedDeviceRequired(true)`.

**H3 — What CI tests is not what ships.** `app/build.gradle` rewrites the client at build time: about 600 lines of JavaScript (QR, Amber queueing, mesh) are spliced in by string replacement and the CSP hash is recomputed. The regression suites run against the un-patched file, so the injected code has no test coverage and no stable hash to review.
*Fix:* move the Android-only code into the client behind `if (window.GlowstrAndroid)`, delete the Gradle splicing, and let the build fail if the asset's hash differs from a committed value.

### Medium

**M1 — Signing code is not constant-time.** BigInt arithmetic leaks timing. This pass makes the sequence of group operations uniform for secret scalars, which narrows the leak but does not remove it. Native signing (H1) closes it.

**M2 — NIP-05 names are shown without verification.** A profile's `nip05` string is displayed as claimed. Once `@glowstr.net` names are for sale, anyone can type `support@glowstr.net` into their profile.
*Fix:* verify on profile open (one fetch to `/.well-known/nostr.json`, cached), show a clear verified / unverified state, and never show the bare string in feeds unless verified.

**M3 — Loopback HTTP server is redundant inside the app.** `LocalHttpServer` listens on `127.0.0.1:8788` with `Access-Control-Allow-Origin: *`. The WebView already reaches the mesh through the native bridge, so the listener only adds surface: any app on the phone can connect, and six slow connections exhaust its thread pool. The 256-bit token does protect the data.
*Fix:* do not start the listener in the APK; drop `http://127.0.0.1:8788` from the CSP.

**M4 — Amber handshake trusts a self-reported package.** `get_public_key` is sent as an implicit `nostrsigner:` intent, and the `package` extra in the reply is stored and trusted afterwards. A hostile app that registers the scheme can become "the signer". It cannot forge signatures (every result is verified), but it can make the user log in as the wrong identity and can deny service.
*Fix:* show the resolved package and its signing certificate on first use, and pin both.

**M5 — Remote media loads automatically.** Avatars, note images and custom emoji are fetched from whatever host the event names, which gives every such host the user's IP address and a read receipt. For a client whose pitch is privacy this is the largest everyday leak.
*Fix:* a "load media" setting with three states (always / followed accounts only / tap to load), defaulting to followed-only; optionally an image proxy on glowstr.net.

**M6 — Gradle dependencies are not pinned by hash.** There is no wrapper and no `verification-metadata.xml`, so a compromised mirror or plugin release changes the APK silently.
*Fix:* `gradle --write-verification-metadata sha256`, commit the result, commit the wrapper with its checksum.

### Low

- **L1** `ws:` is still allowed by the CSP and the relay-list validator. Android blocks cleartext for this target SDK, so it fails rather than leaks, but the allowance should go.
- **L2** No `FLAG_SECURE` on the key screens: the nsec and QR appear in screenshots and the recents thumbnail.
- **L3** Subscription ids use `Math.random()`. Not a secret, but `crypto.getRandomValues` is free.
- **L4** `openExternal` and link navigation still accept `http:`.
- **L5** Bluetooth permission is requested 300 ms after first launch, before the user has seen the app (see UX).
- **L6** `glowstr-v5.3-bluetooth-direct.html` is still what `deploy/podman/deploy.sh` publishes. It has none of the v5.4/v5.5 fixes. Either retire that script or port it.

### Already in good shape

Strict script CSP (single hashed inline script, `script-src-attr 'none'`, no `eval`), `frame-src 'none'` in the app, WebView file access off, mixed content blocked, backups disabled, bridge methods gated on a per-launch capability, every relay event shape-checked and signature-verified before use, signer results checked against the request, no secrets in `localStorage`, unsigned release builds with offline signing, GitHub Actions pinned by commit.

## 3. Speed — what is left

1. **Verify off the main thread.** Even at ~1.5 ms, a burst of a few hundred events blocks scrolling. A Web Worker (CSP already allows `worker-src blob:`) or a native `verifyBatch` removes that.
2. **Stop rebuilding the feed.** `rerenderFeed()` clears and re-creates up to 60–110 notes from 16 call sites. Keep a keyed list and insert/remove single nodes.
3. **Cache events on disk.** Store the last few hundred verified events in IndexedDB and paint them before any relay connects. This is the difference between a blank screen and an instant feed.
4. **Ask relays for less.** Use `since` from the newest cached event, NIP-45 `COUNT` for reaction totals where supported, and NIP-77 negentropy against the Glowstr relay (strfry supports it) to sync only what is missing.
5. **Lazy images.** Add `loading="lazy" decoding="async"` and explicit dimensions to every generated `<img>`.
6. **Ship less CSS and markup.** ~120 KB of CSS and ~240 KB of markup are parsed before the script starts. Dropping features (section 4) shrinks both.
7. **Start the Bluetooth service on demand**, not in `onResume`.

## 4. Bloat — candidates that need your decision

Removing these would cut code and attack surface, but each is a visible feature, so nothing here was removed without asking.

| Candidate | Why it is a candidate |
|---|---|
| Profile music player, YouTube IFrame API, SoundCloud/Spotify/Wavlake embeds | Third-party frames and trackers; already blocked inside the APK by `frame-src 'none'`, so much of this is dead code on Android. |
| Custom profile cursors | No effect on a touch screen. |
| Presence dot and "visitor counter" | Local-only decoration; listens to every scroll and touch. |
| Twitter import | Depends on third-party lookups. |
| Direct `monero-wallet-rpc` panel | Already disabled; stubs and hidden markup remain. |
| Legacy `XMR_COMMERCE` (`relay_30d`, `room_30d`, …) | Superseded by the v4.2/v5.4 checkout; two payment code paths is one too many. |
| NIP-47 Nostr Wallet Connect | Lightning-only, in a Monero-first client. |
| CoinGecko price panel | Third-party request; off by default already. |
| void.cat and catbox upload fallbacks | Unauthenticated third-party uploads; prefer Blossom/NIP-96 only. |
| Meshtastic and Reticulum bridges inside the APK | Need a desktop bridge; the phone build could ship Bluetooth Direct only. |
| `monero-commerce/`, `xmr-relay/`, `deploy/` on `main` | The live versions are on `feature/xmr-relay-annual-v1`; the copies here are older and invite deploying the wrong one. |
| `glowstr-v5.3-bluetooth-direct.html` | See L6. |

## 5. UX suggestions

**First run**
- Do not ask for Bluetooth on launch. Ask when the user opens *Local mesh*, with one sentence on why.
- Replace the boot animation and manifesto with a three-choice screen: *Create account*, *I have a signer (Amber / FROST bunker)*, *Paste a key*. Put the signer options first; pasting an nsec is the least safe path and should say so.
- After account creation, force a backup step (show nsec once, confirm, offer Keystore-only storage) before the feed.

**Navigation**
- A bottom bar with five destinations — Home, Search, Post, Messages, Me — instead of a horizontally scrolling tab strip. Everything else (relays, mesh, market, rooms, wallet) goes under Me or a single "More".
- One compose button, always in the same place.

**Feed**
- Skeleton rows while loading rather than a spinner.
- "N new notes" pill instead of content jumping; pull to refresh.
- Minimum 44 px touch targets on reply/boost/like/tip; the current action row is tight on small phones.

**Identity and names**
- Offer `name@glowstr.net` at the moment it is useful: on the profile editor's NIP-05 field ("Get a glowstr.net name — $4 once, paid in XMR") and once after onboarding. Today it sits inside the wallet view.
- Show the name live as the user types (`alice@glowstr.net`), with availability checked on pause rather than on a button.
- A verified mark next to names only when verification has actually passed (M2).

**Payments**
- One payment sheet for everything (tip, relay plan, name): amount in XMR and USD, QR, *Open wallet*, *Copy address*, a confirmation counter (0/2 → 2/2) and a plain "Do not pay twice" line.
- Persist pending invoices and show them on the Me screen so a user who closed the app can find them again.
- Say what happens next after payment ("Your name activates after 2 confirmations, about 4 minutes").

**Look and feel**
- Keep the retro identity, but add a "Calm" theme: no scanlines, no glow, system font for body text. Pixel fonts at small sizes are hard to read and the fixed scanline overlay costs GPU time on every frame.
- Respect the system font size (the WebView currently forces `textZoom 100`).
- Error messages should say what to do: "Relay refused the note — your plan expired. Renew" rather than the relay's raw string.

**Safety cues**
- Show which signer is active at all times (Local key / Amber / FROST 2-of-3).
- A screenshot guard on key screens, and auto-clear of the clipboard 60 s after copying an nsec.

## 6. Monero on Nostr — what to build on

There is no merged Monero NIP. Zaps (NIP-57), NWC (NIP-47) and nutzaps (NIP-61) are Lightning or Cashu only. What exists for Monero is convention, so the useful move is to pick conventions other clients can read and publish them as a draft.

**Use what is already standard**

| NIP | Use in Glowstr |
|---|---|
| NIP-05 | `name@glowstr.net`, sold for XMR. Done; add verification of other users' names. |
| NIP-11 | Advertise relay price and `payments_url` in the relay information document so other clients can show "paid relay, pay in XMR here". |
| NIP-42 / NIP-98 | Already used for relay auth and for proving key ownership at checkout. Keep both; they are why no account system is needed. |
| NIP-17 / NIP-44 | Send Monero payment proofs and invoice details as gift-wrapped DMs. A tip stays private between two people unless the sender chooses to publish it. |
| NIP-40 | Put an `expiration` tag on anything that carries an invoice so stale payment requests disappear. |
| NIP-99 (kind 30402) | Already used for the market. Standardise on `["price", "<amount>", "XMR"]` and stop inventing a separate `xmr_address` tag where a payment-target event will do. |
| NIP-58 badges | Award a "glowstr.net member" or "supporter" badge on confirmed payment — visible in any badge-aware client, reveals nothing about the transaction. |
| NIP-75 goals | Fundraising goals denominated in XMR, with progress reported by the recipient's view-only watcher. |
| NIP-78 | Per-user app settings (default wallet, tip presets, media policy), encrypted to self with NIP-44. |
| NIP-89 | Publish a handler so `monero:` tip events open in Glowstr. |
| NIP-65 / NIP-77 / NIP-45 | Not Monero, but the three that most affect speed: outbox reads, set reconciliation, counts. |
| NIP-B7 / NIP-96 | Paid media storage (`storage_10gb_30d` already exists as a product) sold through the same XMR checkout. |
| NIP-69 (kind 38383) | Peer-to-peer order events. Worth evaluating for XMR↔fiat offers if the market grows; check that it still fits before building. |

**Conventions to adopt for tipping**

1. **Where the address lives.** Keep reading the `monero` / `xmr` fields in kind 0 that Glowstr and Garnet-style clients already use, but prefer a dedicated replaceable "payment targets" event carrying a `monero:` URI. A kind-10133 payment-targets list has been discussed in the NIPs repo; confirm its current state before committing to the kind number.
2. **Never publish a primary address.** Publish a subaddress per profile, and rotate it. Better: the profile advertises a tip endpoint (the commerce server) that returns a fresh subaddress per tip, exactly as checkout does today. Then no address is ever public.
3. **Private by default, provable by choice.** A tip is invisible on Nostr. If the sender wants credit, the wallet produces an OutProof (`get_tx_proof`) and the client publishes a small receipt event with `e`/`p` tags, the txid, the proof and the amount. Any client can check the proof against a node; the address is not revealed beyond what the proof needs. This is the Monero equivalent of a zap receipt and is the piece most worth writing up as a draft NIP.
4. **Watch with a view key, never a spend key.** The receiving side confirms tips with a view-only wallet (the pattern Monostr's watcher and this repo's commerce server already follow). Do not derive Monero keys from the Nostr key: one leak then loses both.
5. **Paid-write relays.** The NIP-42 + XMR entitlement design here matches Nerostr's model. Publishing the entitlement check as a small spec would let other clients buy access to the Glowstr relay.

**Wallet side**
- Hand off with `monero:` URIs only (already done). Add an *animated QR / UR* option so air-gapped wallets work.
- Fetch the XMR/USD rate from the commerce server, not from CoinGecko, so the app makes no third-party calls.
- Offer Tor for the commerce and name endpoints (an `.onion` mirror of the glowstr.net API).

Sources consulted for the Monero section: [NIPs repository](https://github.com/nostr-protocol/nips), [Nerostr](https://github.com/pluja/nerostr), [Garnet discussion](https://nostr.at/nevent1qqsp2m5wvr7nxsu8chm7v2ljvu5nzsea80svgvqfqnjjqnxacf8pm3gpz3mhxue69uhhyetvv9ujumn0wd68ytnzvu8t20eq), [payment-targets discussion](https://nostr.ae/r/relay.jmoose.rocks/intent:relay.jmoose.rocks/raven-titan?lang=en). Monostr is cited from this repo's own `MEDIA_WALLET_BUG_SWEEP.md`; it was not re-checked.

## 7. Suggested order of work

1. Native signing + authenticated Keystore key (H1, H2, M1).
2. Fold the Gradle-injected JavaScript into the client and test what ships (H3).
3. NIP-05 verification and media-loading policy (M2, M5).
4. Drop the loopback server and `ws:` (M3, L1); pin Gradle dependencies (M6).
5. Event cache + incremental feed + worker verification (speed 1–3).
6. Decide the bloat list (section 4), then the navigation rework.
