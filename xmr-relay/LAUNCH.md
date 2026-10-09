# Launch the lightweight paid Glowstr Nostr relay

This is the **production paid-relay-only** profile, not the Armada/LiveKit or mock-wallet staging stack.

## Hardware and DNS

- Dedicated Debian 12 / Ubuntu 24.04 VPS, ideally >=1 GB RAM. On 512 MB RAM / 1 vCPU, use 1 GB swap, low traffic, and watch OOM; neither high throughput nor capacity is guaranteed.
- Public DNS A/AAAA: `relay.glowstr.com` -> VPS. Remove incorrect AAAA if IPv6 isn't configured.
- Inbound public TCP **80/443** only.
- Do **not** expose TCP 7777 (strfry), 7778 (relay-gate), 8787 (Commerce), or 18083 (wallet RPC).
- The wallet connects outward to a **remote Monero daemon**. No `monerod` or blockchain storage on this VPS.
- Use a **dedicated Monero wallet**. Keep its seed and private spend key offline. Only its primary public address and private **view** key are used to create the VPS view-only wallet.
- Choose a remote node with reliable availability. An untrusted remote node can impair invoice detection/availability and learn your wallet's network connection.

## Install

Use a dedicated VPS as root, not the Proxmox VE host:

```sh
apt-get update
apt-get install -y git ca-certificates
git clone https://github.com/Notafbihoneypot/Glowstar.git
cd Glowstar
git checkout feature/xmr-relay-annual-v1
cd xmr-relay
bash setup-paid-relay.sh
```

Answer the prompts for:

1. Relay domain, e.g. `relay.glowstr.com`
2. Glowstr web/app origin, e.g. `https://glowstr.com`. Commerce supports comma-separated allowlisted browser origins via `GLOWSTR_ALLOWED_ORIGIN` if the Android origin is different.
3. Wallet mode: **1** for local view-only `monero-wallet-rpc` using a remote daemon; **2** if you already have a private wallet-RPC elsewhere.
4. Remote daemon URL in `https://hostname:port` format. For `http://`, the script warns that this is unencrypted.
5. **Primary** Monero address, private view key (hidden prompt), and restore height (first run only). Use the height from your wallet's actual creation date; `0` may take a long time to scan.
6. The script verifies its pinned official Monero 0.18.5.1 CLI download against the published release SHA256 and installs **only** the `monero-wallet-rpc` binary. It runs the wallet RPC on 127.0.0.1 with a separate system user and generates passwords.

### Confirm wallet synchronization before accepting real payments

Check the wallet RPC and node synchronization using the chosen daemon and the view-wallet. A working `get_version` does **not** mean the wallet has scanned to the current block height. In the wallet-RPC API, `get_height` reports the wallet scan height. Compare it with your remote node's current height, and keep the relay payment UI unadvertised until the scan is sufficiently caught up.

For the wallet's current scan height:

```sh
# Run on the VPS; use your generated wallet RPC credentials from xmr-relay/.env.
# Avoid putting secrets directly into a shell's history or public logs.
curl --digest --user 'glowstr' --no-progress-meter \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"0","method":"get_height"}' \
  http://127.0.0.1:18083/json_rpc
```

`curl` may request the password interactively. Do not publish RPC credentials.

## Verify before real XMR is sent

```sh
curl -fsS https://relay.glowstr.com/xmr-commerce/v1/features
curl -fsS https://relay.glowstr.com/xmr-commerce/ready
```

No-spend Nostr check using the built relay-gate image:

```sh
cd ~/Glowstar/xmr-relay
podman compose -f compose.yaml -f compose.paid-relay.yaml \
  run --rm --no-deps --entrypoint node relay-gate \
  /app/smoke.mjs wss://relay.glowstr.com/
```

The smoke test creates a **temporary** Nostr key, subscribes for public reads and tries unauthorized publishing. Expected: public read + authentication succeed; **unauthenticated and authenticated-but-unpaid writes are denied**. It never makes an XMR payment.

If the Podman Compose provider does not accept these `run` options, run `npm install` and `node smoke.mjs` in `relay-gate/` on another Linux machine with Node.js 22+.

## First real paid-member test

1. Build/use Glowstr from the same feature branch (the client must point its `apiBase` at `https://relay.glowstr.com/xmr-commerce/v1`). An older APK/main build might still use another endpoint.
2. Log into a **test Nostr identity**, connect to `wss://relay.glowstr.com/`, and verify a note is rejected before payment.
3. Open Glowstr's XMR relay purchase UI. Confirm the invoice is exactly **$10 USD-equivalent in XMR**, the fresh subaddress belongs to your dedicated view wallet, and the target is `relay.glowstr.com`.
4. Send one real payment from an independent wallet. Confirm `WAITING -> MEMPOOL -> CONFIRMING -> PAID`.
5. Only after **2 confirmations**, verify the test identity's NIP-42-authenticated post is accepted.
6. Verify a different unpaid identity is still rejected. Check that access ends after its expiry and that an early renewal stacks another year.

Do not test with the staging/mock-wallet address. It is not a real Monero receiving address.

## Logs, restart, resources

```sh
cd ~/Glowstar/xmr-relay
podman compose -f compose.yaml -f compose.paid-relay.yaml ps
podman compose -f compose.yaml -f compose.paid-relay.yaml logs --tail=120
journalctl -u glowstr-monero-wallet-rpc.service -n 100 --no-pager
free -h
df -h
```

Keep an eye on memory pressure, swap use, relay DB growth, wallet synchronization, and payment reconciliation errors. For updates, back up first, then rebuild from reviewed commits.

## Backups and security

- Back up the persistent **Commerce SQLite** and **strfry LMDB** Podman volumes. Stop services or use an application-consistent snapshot; do not copy a live SQLite WAL database as if it were a single isolated file.
- Back up the encrypted view-wallet files under `/var/lib/glowstr-monero-wallet`, and the password/config directory `/etc/glowstr`.
- Back up `xmr-relay/.env` **encrypted and off-server**; it contains wallet RPC credentials and the Commerce admin token.
- Protect the wallet seed and private spend key separately, **never** on the VPS.
- Never expose the wallet RPC or Commerce admin API to the public network. Caddy is the public listener.
- Consider at least **1 GB RAM** if the 512 MB VPS starts swapping heavily under actual client traffic.
- Do not merge the PR or turn on public billing until the live paid-member test and wallet sync check pass.
