# One-machine Glowstr XMR deployment

This folder deploys the complete server side with Podman:

- a local **pruned Monero node**
- a dedicated **monero-wallet-rpc** receiving wallet
- Glowstr **Monero Commerce** invoice/subaddress service
- the **XMR-gated strfry Nostr relay**
- **Glowstr Crosspost** for Bluesky, Mastodon, X, ActivityPub-compatible, and Nostr publishing
- **Caddy** for HTTPS/WSS and the Glowstr web client
- persistent named volumes for chain, wallet, invoices, Crosspost OAuth state/data, relay database and TLS data

Only ports **80/443** need to be public. Monero RPC, wallet RPC, Commerce, and strfry bind to loopback.

[Crosspost](../../crosspost/README.md) is part of this same Compose project and binds only to loopback port 8790. Caddy routes `/crosspost/` to it. Publishing is protected by the `crosspost_30d` Monero entitlement: users can sign in, link identities, compose, and preview without a pass, but live publishing requires an active entitlement. Preview-only mode remains the deployment default.

## Recommended host

Use a dedicated Linux VM rather than installing this directly on a Proxmox VE host. Give the VM enough disk for a pruned Monero chain plus growth, and back up the wallet/Commerce databases separately.

## First deployment

```sh
git clone https://github.com/Notafbihoneypot/Glowstar.git
cd Glowstar/deploy/podman
cp .env.example .env
nano .env
```

Set:

- `APP_DOMAIN`
- `RELAY_DOMAIN`
- `CROSSPOST_ALLOWED_PUBKEYS` — your 64-character hex Nostr public key, or a comma-separated allowlist
- optionally `CROSSPOST_X_CLIENT_ID` if you want X account linking

Both DNS records must point to the server.

Rootless Podman is supported and preferred. If your host still reserves ports below 1024 for root, run this once:

```sh
echo 'net.ipv4.ip_unprivileged_port_start=80' | doas tee /etc/sysctl.d/90-rootless-web.conf
doas sysctl --system
```

Test without real XMR first:

```sh
./deploy.sh --stagenet
```

When satisfied, deploy a separate mainnet wallet:

```sh
./deploy.sh --mainnet
```

On first run the script opens `monero-wallet-cli` interactively. Record the recovery seed offline and type `exit`. The seed is never written into the repo or environment file.

## Monero binary verification

The image build downloads Monero CLI **v0.18.5.1** directly from `downloads.getmonero.org` and verifies the official SHA-256 before installing it.

Supported automatically:

- Linux x86-64: `22a7dda7b0cb699fdd6b7674c3b4a4465b337cc98a54983523b759e1e7cc9958`
- Linux ARMv8: `c0caf042cb7c7b760f5ad6be188084b59352440b32990a78b8051497b9398dbc`


## Crosspost XMR paywall

The default starter entitlement is:

- feature: `crosspost_30d`
- duration: 30 days
- starter price: **0.02 XMR**
- price setting: `GLOWSTR_XMR_CROSSPOST_30D_ATOMIC=20000000000`

The browser requests a fresh invoice from `/xmr-commerce/v1/invoices`. Commerce creates a fresh Monero subaddress and returns a capability token used only to poll that invoice. After the configured confirmation count, Commerce records the entitlement against the signed-in Nostr public key. Crosspost checks the entitlement server-to-server before accepting a live publish request.

The Commerce admin token, wallet RPC credentials, wallet files, and Crosspost encryption key never go to the browser.

For testing, use:

```sh
./deploy.sh --stagenet
```

Keep `CROSSPOST_PREVIEW_ONLY=true` while validating OAuth and invoice flow. When you are ready for an explicit live posting test, change it to `false` and recreate the Crosspost service:

```sh
podman compose up -d --force-recreate crosspost
```

## Operations

```sh
./status.sh
podman compose logs -f --tail=100
podman compose restart
podman compose down
```

Do not publish the `secrets/` directory. It contains the wallet file password, wallet-RPC password, and the internal Commerce/relay authorization token.
