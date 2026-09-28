# Hermes: Glowstr Paid Relay + NIP-17 Staging Deployment

This document is the handoff for deploying the **staging/test** Glowstr annual XMR relay and NIP-17 renewal system on a dedicated Proxmox VM.

## Goal

Bring up one isolated staging stack containing:

- Caddy HTTPS / WSS edge
- Glowstr staging web client
- strfry paid-write Nostr relay
- Glowstr Monero Commerce
- staging-only fake `monero-wallet-rpc`
- NIP-17 renewal notifier
- Glowstr multi-AUTH/XMR relay gate for Armada Concord
- Armada CORD-07 blind voice broker
- LiveKit WebRTC SFU
- persistent Podman volumes

**No real Monero wallet is used in this mode. Do not send XMR to the fake addresses shown by staging.**

## Recommended VM

Use a dedicated Debian 12 / Ubuntu 24.04 VM rather than the production relay host.

Suggested starting resources:

- 4 vCPU
- 8 GB RAM
- 20 GB disk
- static LAN IP
- outbound Internet access

The VM must receive TCP **80/443** for Caddy, TCP **7881** for LiveKit ICE/TCP, and UDP **7882** for LiveKit ICE/UDP. Do not publicly expose the loopback service ports 7777, 7778, 7880, 8086, 8787, or 18084.

## DNS required before running

Create two DNS records pointing at the staging VM's public IP:

- `staging.glowstr.com`
- `relay-staging.glowstr.com`
- `voice-staging.glowstr.com`

If the VM is behind NAT, forward TCP 80 and 443 to the staging VM.

Do not expose ports 7777, 8787, or 18084 publicly. Caddy should be the public edge.

## Deploy

Run as root in the dedicated staging VM:

```sh
git clone https://github.com/Notafbihoneypot/Glowstar.git
cd Glowstar
git checkout feature/xmr-relay-annual-v1
cd xmr-relay

GLOWSTR_STAGING_SITE_DOMAIN=staging.glowstr.com \
GLOWSTR_STAGING_RELAY_DOMAIN=relay-staging.glowstr.com \
GLOWSTR_STAGING_VOICE_DOMAIN=voice-staging.glowstr.com \
bash setup-staging.sh
```

The script installs missing Podman dependencies on Debian/Ubuntu, creates staging secrets, derives the notifier public key, generates the staging client/Caddy/strfry configs, builds all containers, starts the stack, and performs health checks.

The script is designed to be rerun. It reuses the existing Commerce admin token and NIP-17 notifier secret instead of silently rotating them.

## What the fake wallet does

The staging wallet never talks to Monero.

After a Glowstr invoice is created it simulates:

- 0–8 seconds: mempool
- 8–18 seconds: 1 confirmation
- about 18 seconds: 2 confirmations

At 2 confirmations the relay entitlement activates automatically.

The staging membership lasts **10 minutes**. When **5 minutes remain**, Commerce queues the renewal reminder. The notifier polls every 10 seconds, so the NIP-17 DM should arrive shortly after the five-minute point.

Production remains 365 days / 30-day reminder. The short timing comes only from the staging overlay.

## End-to-end test

Use a throwaway/test Nostr identity.

1. Open `https://staging.glowstr.com/`.
2. Sign in with the test Nostr identity.
3. Open **RELAYS**.
4. Find **NIP-17 PRIVATE INBOX**.
5. Publish the suggested inbox list:
   - `wss://nos.lol`
   - `wss://relay.nostr.band`
6. Open **XMR**.
7. Choose **BUY / RENEW RELAY**.
8. **Do not pay the displayed Monero address or QR.** It is deliberately fake.
9. Watch the invoice progress to 2 confirmations automatically.
10. Confirm relay write access becomes active.
11. Around five minutes later, verify:
    - the encrypted NIP-17 DM arrives,
    - the verified Glowstr renewal notification appears,
    - tapping the notification opens the XMR renewal area.

The notification should only receive the special verified Glowstr treatment when its decrypted sender matches the notifier public key exposed by the staging Commerce HTTPS endpoint.

## Armada Concord voice test

The staging relay now places `relay-gate` in front of strfry for WebSocket traffic. This is required because Armada may authenticate both the real user and derived Concord stream keys on one socket. The gate accepts multiple valid NIP-42 AUTH identities, checks the XMR entitlement against the authenticated set, keeps normal event author matching, and grants the author-mismatch exception only to encrypted wrapper kinds 1059 and 21059.

After the test identity has an active staging entitlement:

1. Install/open current Armada on two test devices or browser profiles.
2. In Armada relay settings, add `wss://relay-staging.glowstr.com/`.
3. In Armada **Settings → Voice**, add `https://voice-staging.glowstr.com`.
4. Create or join a Concord community using the staging relay.
5. Start a voice call.
6. Join from the second test device/account.
7. Verify:
   - two-way audio,
   - mute/unmute,
   - leave/rejoin,
   - reconnect after briefly changing network,
   - call presence/raise-hand/reactions if exposed by the current Armada build.
8. Watch the relay-gate logs and confirm encrypted Concord `kind:21059` wrappers are accepted only while a paid NIP-42 identity is present on that connection.

The voice broker is blind: Armada proves possession of the derived voice-room key using a self-signed kind-27235 grant. The broker returns a short-lived LiveKit token with a random participant identity; it does not learn the real Nostr user identity.

### Voice network paths

```text
Armada
  |
  +-- wss://relay-staging.glowstr.com
  |       -> Caddy
  |       -> relay-gate :7778
  |       -> strfry :7777
  |
  +-- https://voice-staging.glowstr.com/.well-known/concord/av/*
  |       -> Caddy
  |       -> Armada CORD-07 broker :8086
  |
  +-- wss://voice-staging.glowstr.com
          -> Caddy
          -> LiveKit signaling :7880

WebRTC media:
  TCP 7881 directly to LiveKit
  UDP 7882 directly to LiveKit
```


## Verify services

From `Glowstar/xmr-relay`:

```sh
podman compose \
  -f compose.yaml \
  -f compose.staging.yaml \
  --profile notifications \
  ps
```

Local health:

```sh
curl -fsS http://127.0.0.1:18084/health
curl -fsS http://127.0.0.1:8787/ready
curl -fsS http://127.0.0.1:7778/health
curl -i http://127.0.0.1:8086/.well-known/concord/av
```

Public trust endpoint:

```sh
curl -fsS https://staging.glowstr.com/xmr-commerce/v1/notifier
curl -i https://voice-staging.glowstr.com/.well-known/concord/av
```

Expected form:

```json
{"configured":true,"pubkey":"<64-hex-pubkey>"}
```

Tail the full stack:

```sh
podman compose \
  -f compose.yaml \
  -f compose.staging.yaml \
  --profile notifications \
  logs -f
```

Useful individual logs:

```sh
podman ps --format '{{.Names}}'

# Then:
podman logs -f <commerce-container>
podman logs -f <relay-container>
podman logs -f <notifier-container>
podman logs -f <caddy-container>
podman logs -f <mock-wallet-container>
podman logs -f <relay-gate-container>
podman logs -f <armada-voice-container>
podman logs -f <livekit-container>
```

## Stop staging

```sh
podman compose \
  -f compose.yaml \
  -f compose.staging.yaml \
  --profile notifications \
  down
```

## Completely reset staging data

Only do this on the dedicated staging VM:

```sh
podman compose \
  -f compose.yaml \
  -f compose.staging.yaml \
  --profile notifications \
  down -v

rm -rf staging
rm -f .env
rm -rf secrets
```

Then rerun `bash setup-staging.sh`.

## Files that must remain private

Do not copy these into Git, chat messages, issue comments, or public logs:

- `xmr-relay/.env`
- `xmr-relay/secrets/notifier.key`

The notifier **public** key is safe to expose.

## Troubleshooting

### Caddy cannot obtain a certificate

Check:

```sh
getent hosts staging.glowstr.com
getent hosts relay-staging.glowstr.com
ss -ltnp | grep -E ':(80|443) '
```

Confirm TCP 80 and 443 reach the VM from the Internet.

### Commerce readiness fails

Check the mock wallet first:

```sh
curl -v http://127.0.0.1:18084/health
```

Then inspect Commerce logs.

### Payment does not progress

The staging Commerce service must point to:

```text
http://127.0.0.1:18084/json_rpc
```

The mock-wallet container should report that it advances to 1 confirmation after 8 seconds and 2 confirmations after 18 seconds.

### Renewal DM does not arrive

Verify the test account actually published a `kind:10050` event and that its inbox hosts are allowed by:

```text
GLOWSTR_NIP17_ALLOWED_RELAY_HOSTS
```

The default staging allowlist is:

```text
nos.lol,relay.nostr.band
```

Inspect notifier logs for:

- missing kind 10050
- relay host not operator-approved
- NIP-42 authentication failure
- relay publish rejection

## Production warning

Do **not** use `compose.staging.yaml` for production.

Production should use:

- real `monero-wallet-rpc`
- dedicated receiving wallet
- 365-day entitlement
- 30-day renewal reminder
- production DNS
- production firewall / egress policy
- backed-up Commerce and relay data
- no mock-wallet service

Only move to production after the complete staging lifecycle succeeds.


## Armada voice troubleshooting

### Armada says no compatible voice server

Verify the capability probe returns HTTP 204:

```sh
curl -i https://voice-staging.glowstr.com/.well-known/concord/av
```

Then confirm Armada's Voice setting contains exactly:

```text
https://voice-staging.glowstr.com
```

### Voice token works but audio does not

Check public reachability of **TCP 7881** and **UDP 7882**. LiveKit signaling may work perfectly through HTTPS while WebRTC media fails if these direct media ports are blocked.

Do not forward TCP 7880 publicly; Caddy proxies the signaling endpoint.

### Armada cannot publish encrypted community traffic

Inspect relay-gate logs first. The connection must have at least one authenticated Nostr pubkey with a valid staging `relay_365d` entitlement. Armada may additionally authenticate derived Concord stream keys. Encrypted outer wrapper kinds 1059/21059 may use those privacy keys, while ordinary events still require the event author itself to have authenticated on the socket.
