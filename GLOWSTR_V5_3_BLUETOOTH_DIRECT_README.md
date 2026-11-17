# Glowstr Android — Bluetooth Direct

Glowstr carries signed public Nostr notes directly between nearby Android phones over secure BLE L2CAP.

## Architecture

```text
Bundled Glowstr client
       |
       | capability-gated native calls (no network listener)
       v
Android Bluetooth service
       |
       | BLE discovery + secure L2CAP CoC
       v
Nearby Glowstr Android service
       |
       +-- bounded verified-event store
       +-- one-hop delivery + event-ID ACK
```

The service never receives an nsec and never signs on its own. It accepts public kind-1 events only after NIP-01 ID and BIP-340 signature verification. The receiving WebView verifies imported events again.

## Safety limits

- One-hop Android delivery; received events are not forwarded to a third phone.
- Maximum 12 live Bluetooth sessions and 8 registered peers.
- Event content up to 16 KiB; encoded event JSON up to 48 KiB.
- Per-peer limits: 60 events/minute and 120 frames/minute.
- Local store: 5,000 events or 7 days.
- At most 50 recent forwardable events in a new peer backlog.
- Invalid IDs/signatures are rejected before storage.
- Deduplication keys on event ID plus signature; a forged body cannot poison a valid event ID.

## Build

Requirements: Android SDK 36, Gradle 8.13+, Java 17, Android 10/API 29 or newer.

```sh
gradle -p android-helper :app:assembleRelease
```

This produces the deliberately unsigned `android-helper/app/build/outputs/apk/release/app-release-unsigned.apk`.

## Start and use

1. Open Glowstr.
2. Go to **RELAYS → LOCAL MESH / COLLAPSE MODE**.
3. Press **START BLUETOOTH**.
4. Grant Nearby Devices when Android asks. Android 10–11 also require location permission for BLE scanning.
5. Keep the foreground-service notification active while store-and-forward is wanted.

The first secure L2CAP connection may trigger Android's Bluetooth pairing prompt. **RESCAN** restarts discovery. A sent event waits for an event-ID ACK and reports delivery when the peer confirms it.

The internal native request surface is equivalent to:

```text
GET  /v1/status
GET  /v1/peers
GET  /v1/events?after=<cursor>&limit=50&wait=20000
GET  /v1/delivery?id=<nostr-event-id>
POST /v1/send
POST /v1/rescan
```

These are in-process bridge calls, not HTTP endpoints. No other app or browser can connect to them.

## Privacy

Bluetooth is not anonymity. Nearby radios can observe advertising and traffic. The random node ID is transport metadata stored in app-private storage, not a Nostr identity.

Do not use Bluetooth Direct for DMs, private lists, Monero wallet data, or payment secrets. Those event types are rejected.

## Verification boundary

Automated checks cover JavaScript parsing/CSP, NIP-01 and BIP-340 vectors, bridge capability isolation, bounded storage/rates, release compilation, lint, manifest policy, and unsigned output. Physical phone-to-phone BLE/L2CAP behavior still requires two-device testing.
