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
- persistent Podman volumes

**No real Monero wallet is used in this mode. Do not send XMR to the fake addresses shown by staging.**

## Recommended VM

Use a dedicated Debian 12 / Ubuntu 24.04 VM rather than the production relay host.

Suggested starting resources:

- 2 vCPU
- 4 GB RAM
- 20 GB disk
- static LAN IP
- outbound Internet access

The VM must be able to receive public TCP **80 and 443** for Caddy certificates and HTTPS/WSS testing.

## DNS required before running

Create two DNS records pointing at the staging VM's public IP:

- `staging.glowstr.com`
- `relay-staging.glowstr.com`

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
```

Public trust endpoint:

```sh
curl -fsS https://staging.glowstr.com/xmr-commerce/v1/notifier
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
