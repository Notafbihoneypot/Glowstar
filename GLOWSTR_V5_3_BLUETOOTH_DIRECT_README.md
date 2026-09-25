# Glowstr v5.3 — Bluetooth Direct

Glowstr v5.3 adds an Android-to-Android Bluetooth transport to the existing Meshtastic and Reticulum collapse-network modes.

## Architecture

```text
Glowstr PWA (signing + final verification)
       |
       | HTTP to 127.0.0.1:8788
       | X-Glowstr-Token
       v
Glowstr Bluetooth Bridge (Android)
       |
       | BLE service discovery + GATT PSM lookup
       | secure BLE L2CAP CoC
       v
Nearby Glowstr Bluetooth Bridge
       |
       +-- bounded signed-event store
       +-- hop-limited store-and-forward
```

The helper does **not** hold an nsec or sign Nostr events. It only accepts public kind-1 events that already have a valid NIP-01 ID and BIP-340 signature. Glowstr verifies them again before showing them.

## Current safety limits

- Public Nostr `kind:1` only.
- Maximum hop count: 5.
- Maximum live Bluetooth sessions: 12; maximum registered peers: 8.
- Maximum event content: 16 KiB.
- Maximum encoded event JSON: 48 KiB.
- Maximum peer event rate: 60/minute; total frame rate: 120/minute.
- Local store: 5,000 events / 7 days.
- Newly connected peers receive at most 50 recent forwardable events in the initial backlog.
- Invalid event IDs or Schnorr signatures are rejected before caching.
- Event deduplication uses `event-id + signature`; a later copy with a larger remaining hop budget can refresh forwarding without allowing a fake signature to poison a real event ID.
- The browser bridge binds **only** to `127.0.0.1:8788` and requires a random 256-bit pairing token.

## Build the Android helper

The project is in `android-helper/`.

Requirements:

- Android Studio / Android SDK 36
- Android Gradle Plugin 8.13.2 (declared by the project)
- JDK 17+
- Android 10 / API 29 or newer device

Open `android-helper/` as an Android Studio project, let Gradle sync, then choose:

`Build → Build APK(s)`

The debug APK should be produced at:

```text
android-helper/app/build/outputs/apk/debug/app-debug.apk
```

Or, with a compatible system Gradle already installed:

```bash
gradle :app:assembleDebug
```

There is intentionally no checked-in Gradle wrapper JAR in this generated project.

## Install and start

1. Install the helper APK on each Android phone.
2. Open **Glowstr Bluetooth Bridge**.
3. Grant **Nearby devices** when Android asks.
   - On Android 12+ the app requests Bluetooth Scan / Advertise / Connect and declares `neverForLocation`.
   - Android 10–11 require location permission for BLE scanning because of the older Android permission model.
4. Press **START BLUETOOTH DIRECT**.
5. Keep the foreground-service notification active while you want store-and-forward running.
6. Copy the pairing token shown by the helper.

The first secure L2CAP connection between two phones may produce an Android Bluetooth pairing/authentication prompt.

## Connect Glowstr

For reliable browser-to-helper access, serve/install Glowstr from HTTPS as a PWA.

1. Open `glowstr-v5.3-bluetooth-direct.html` from your Glowstr HTTPS deployment.
2. Go to **RELAYS → LOCAL MESH / COLLAPSE MODE**.
3. Find **BLUETOOTH DIRECT // PHONE ↔ PHONE**.
4. Paste the token from the Android helper.
5. Choose a hop limit (1–5; default 5).
6. Press **CONNECT HELPER**.
7. If Chromium/Vanadium asks for **Local Network Access**, allow it for your Glowstr origin. Glowstr only requests `127.0.0.1:8788` for this helper.

The pairing token is kept in browser `sessionStorage`, not persistent `localStorage`.

## Send a note

Write a normal public note and press:

`📡 MESH SEND`

Glowstr signs the Nostr event itself and hands the already-signed public event to any connected mesh transports:

- Bluetooth Direct
- Meshtastic
- Reticulum

If Bluetooth has no peer in range, the helper still stores the valid signed event. When a compatible peer later connects, recent forwardable events are gossiped automatically.

If **queue for Internet later** is enabled, Glowstr also keeps an unsigned copy in its existing offline publish queue. When the Internet returns, you can explicitly publish it to normal Nostr relays with your signer.

## What the helper API exposes

Loopback only: `http://127.0.0.1:8788`

All endpoints except CORS preflight require `X-Glowstr-Token`.

```text
GET  /v1/status
GET  /v1/peers
GET  /v1/events?after=<cursor>&limit=50&wait=20000
GET  /v1/delivery?id=<nostr-event-id>
POST /v1/send
POST /v1/rescan
```

`/v1/events` supports long polling so the PWA does not spin aggressively in the background.

### v0.3.1 direct-note delivery

The Android APK can sign public kind-1 notes with native Amber/NIP-55 while offline and send the signed event over the existing secure L2CAP link. The receiver verifies the NIP-01 event ID and BIP-340 signature, stores the event, exposes it to the local feed, and returns an event-ID ACK.

For this stabilization build, Android Bluetooth sends are intentionally **one hop**. A locally-created note is retained with one remaining hop so it can be delivered when the paired peer reconnects; the receiving phone stores it with zero remaining hops and does not forward it to a third phone.

## Privacy notes

Bluetooth Direct is not anonymity. Nearby radios can observe that a Bluetooth device is advertising and communicating. The random Glowstr node ID is transport metadata, not a Nostr identity, and is stored only in the helper's app-private storage.

The Bluetooth helper never receives the Nostr private key. Bluetooth link authentication and a Nostr signature solve different problems: Android's secure L2CAP protects the local radio link, while the Nostr signature establishes authorship of the note.

Do not use this first Bluetooth version for DMs, private lists, Monero wallet data, or payment secrets. Those event types are rejected.

## Browser Local Network Access

Modern Chromium gates requests from a public HTTPS origin to loopback/local addresses behind a Local Network Access permission. The v5.3 client uses a Fetch address-space hint for the loopback helper and does not auto-connect at startup, so the permission request happens only after you press **CONNECT HELPER**.

## Testing performed here

Passed:

- v5.3 JavaScript syntax.
- strict CSP script hash.
- zero inline executable HTML handlers.
- zero external script tags.
- no duplicate HTML IDs.
- loopback-only helper CSP allowance.
- random-token localhost authorization source audit.
- secure L2CAP server/client API source audit.
- bounded sessions, GATT discovery, caches, hop count and rate limits.
- official BIP-340 verification vectors in the helper's pure-Java verifier.
- NIP-01 event serialization compared against JavaScript, including Unicode and lone-surrogate cases.
- A→B→C→D multi-hop simulation.
- replay/loop suppression.
- larger-hop-budget refresh behavior.
- Java parser-level source check.

Not performed in this environment:

- A complete Android Gradle build/APK, because the Android SDK is not installed here and the SDK download endpoint is unavailable from the build container.
- Physical phone-to-phone BLE/L2CAP testing.

Those are the two next tests to perform before calling Bluetooth Direct production-ready.
