# Glowstr Armada Voice Broker

A small CORD-07-compatible blind token broker for Armada Concord voice.

The Nostr relay carries encrypted Concord presence/control traffic. LiveKit carries WebRTC media. This broker only verifies proof of the derived voice-room key and returns a short-lived LiveKit token.

## CORD-07 endpoint

- `GET /.well-known/concord/av` → HTTP 204 capability probe.
- `GET /.well-known/concord/av/<64-hex-room>` → LiveKit token.

Armada sends:

```text
Authorization: Concord <base64(JSON(kind-27235-event))>
```

The broker requires:

- valid Schnorr event signature,
- event pubkey exactly equals the voice-room hex key,
- exact `u` tag for the requested token URL,
- exactly `["method","GET"]`,
- exactly one 32-byte hex `nonce`,
- a recent timestamp,
- event id not previously consumed.

The response is:

```json
{"token":"<jwt>","url":"wss://voice.example","identity":"<random>"}
```

The random identity deliberately avoids exposing the Channel or user Nostr identity to LiveKit.

## Required environment

- `ARMADA_VOICE_PUBLIC_ORIGIN=https://voice.example`
- `LIVEKIT_PUBLIC_URL=wss://voice.example`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

Optional rate/TTL controls are documented in `server.mjs`.

This broker is intentionally blind: possession of the Concord-derived voice room key authorizes a token. Membership policy and media encryption remain in Concord/Armada.
