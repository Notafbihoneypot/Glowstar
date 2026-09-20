# One-machine Glowstr XMR deployment

This folder deploys the complete server side with Podman:

- a local **pruned Monero node**
- a dedicated **monero-wallet-rpc** receiving wallet
- Glowstr **Monero Commerce** invoice/subaddress service
- the **XMR-gated strfry Nostr relay**
- **Caddy** for HTTPS/WSS and the Glowstr web client
- persistent named volumes for chain, wallet, invoices, relay database and TLS data

Only ports **80/443** need to be public. Monero RPC, wallet RPC, Commerce, and strfry bind to loopback.

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
- `ACME_EMAIL`

Both DNS records must point to the server.

Test without real XMR first:

```sh
doas ./deploy.sh --stagenet
```

When satisfied, deploy a separate mainnet wallet:

```sh
doas ./deploy.sh --mainnet
```

On first run the script opens `monero-wallet-cli` interactively. Record the recovery seed offline and type `exit`. The seed is never written into the repo or environment file.

## Monero binary verification

The image build downloads Monero CLI **v0.18.5.1** directly from `downloads.getmonero.org` and verifies the official SHA-256 before installing it.

Supported automatically:

- Linux x86-64: `22a7dda7b0cb699fdd6b7674c3b4a4465b337cc98a54983523b759e1e7cc9958`
- Linux ARMv8: `c0caf042cb7c7b760f5ad6be188084b59352440b32990a78b8051497b9398dbc`

## Operations

```sh
doas ./status.sh
doas podman compose logs -f --tail=100
doas podman compose restart
doas podman compose down
```

Do not publish the `secrets/` directory. It contains the wallet file password, wallet-RPC password, and the internal Commerce/relay authorization token.
