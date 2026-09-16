# Glowstr v5.2 — Local Mesh / Collapse Mode

This release adds **public offline Nostr note transport** without changing Glowstr's Nostr signing or verification rules.

## What it supports

### Meshtastic over Bluetooth

Glowstr can connect directly to a nearby Meshtastic radio from browsers that support Web Bluetooth.

1. Open **RELAYS → LOCAL MESH / COLLAPSE MODE**.
2. Choose the Meshtastic channel slot used by your mesh (`0` is the primary channel on most setups).
3. Press **CONNECT BLUETOOTH** and select the Meshtastic device.
4. Wait for `READY · BLUETOOTH / LoRa`.
5. Write a public note and press **📡 MESH SEND**.
6. Use the **MESH** feed to see notes received through offline transports.

Glowstr uses Meshtastic `PRIVATE_APP` port **256**. It does **not** use port 76, which Meshtastic reserves for Reticulum tunnel traffic.

Because Meshtastic's application payload is tiny, Glowstr optionally gzip-compresses a signed Nostr event and fragments it. The radio pacing control defaults to 1200 ms between fragments. Keep collapse-mode notes short for better airtime and reliability.

Web Bluetooth generally requires a secure browser context and is not supported by every browser. If Bluetooth is unavailable, use the Reticulum bridge.

## Reticulum bridge

The browser does not run the Reticulum stack directly. `glowstr-mesh-bridge.py` connects Glowstr to the Reticulum instance on the local machine.

Install dependencies:

```bash
python -m pip install rns websockets
```

Start the bridge:

```bash
python glowstr-mesh-bridge.py
```

It prints a pairing token, for example:

```text
WebSocket: ws://127.0.0.1:8787
Pairing token: <random token>
```

Enter that URL and token under **RELAYS → LOCAL MESH / COLLAPSE MODE → RETICULUM** and press **CONNECT BRIDGE**.

The token is persisted by the bridge in `~/.glowstr/mesh-token` with owner-only permissions. Glowstr stores the token only in `sessionStorage`.

The bridge binds to loopback by default. If you deliberately bind it to a LAN address with `--allow-lan`, protect it with a TLS/WSS reverse proxy before relying on it across an untrusted LAN. A Glowstr page loaded over HTTPS may also block an insecure `ws://` connection; in that case use WSS.

Reticulum uses whatever interfaces you configured in `~/.reticulum/config`: AutoInterface on local Wi‑Fi/Ethernet, RNode/LoRa, packet radio, TCP, etc.

The v5.2 bridge uses a shared **public PLAIN Reticulum destination** named `glowstr.mesh.public`. This is intentional because these are public Nostr kind-1 notes. The Nostr event signature provides end-to-end authorship/integrity. Do **not** use this mode for private messages.

Test bridge framing without Reticulum hardware:

```bash
python glowstr-mesh-bridge.py --self-test
```

## Security model

Mesh mode sends only:

- Signed Nostr `kind:1` public notes.
- No nsec/private key.
- No NIP-17 DMs.
- No wallet information.
- No Monero payment information.

Every received event still goes through Glowstr's normal event checks:

1. structure/size limits
2. NIP-01 event ID recomputation
3. BIP-340 Schnorr signature verification
4. normal event handling only after verification

Meshtastic and Reticulum are treated as **untrusted transports**.

## Internet-later queue

`Keep mesh-sent notes in the unsigned queue` is enabled by default. After a successful mesh send, Glowstr stores the note text/reply context in its existing unsigned offline queue. When Internet relays return, you can review/sign/publish it normally.

This means the later Internet event will be newly signed and may have a different event ID/timestamp from the mesh event.

## Important limitations

- Public notes only in v5.2.
- Real Meshtastic BLE hardware was not available in the build environment, so the protobuf, fragmentation and handshake code is unit-tested but not radio-hardware-tested here.
- The Reticulum Python package/hardware network was not available for a live RNS test. The bridge framing/self-test and Python syntax passed.
- Meshtastic channel security/PSK is controlled by your radio configuration, not Glowstr.
- Reticulum PLAIN destination traffic is not confidential. It carries public Nostr notes only.
