# Hermes Deployment Runbook
## Glowstr Crosspost + Monero Paywall — Lightweight Proxmox Deployment

Target branch: codex/crosspost-bridge

Repository: https://github.com/Notafbihoneypot/Glowstar

Primary installer: deploy/glowstr-light-deploy.sh

Recommended target: a dedicated Debian 12/13 VM on Proxmox VE.

Default first-run mode: Monero stagenet with CROSSPOST_PREVIEW_ONLY=true.

## Mission

Deploy the lightweight Glowstr Crosspost service with:

- Nostr NIP-98 sign-in restricted by CROSSPOST_ALLOWED_PUBKEYS.
- OAuth account linking for Bluesky, Mastodon, X, and Mastodon-compatible ActivityPub services.
- Nostr client-signed publishing.
- A responsive compose/review/delivery-history UI.
- A Monero payment gate for live publishing.
- One fresh Monero subaddress per invoice.
- Automatic confirmation tracking and a 30-day crosspost_30d entitlement.
- A view-only Monero wallet on the application VM.
- A remote Monero node rather than a local monerod/blockchain.
- No Monero mnemonic seed or private spend key on the application VM.

This build is currently a private/allowlisted identity hub. The XMR paywall does not replace the Nostr allowlist or provide open public self-registration.

## Architecture

~~~text
Internet
   |
TCP 80 / 443
   |
 Caddy
   |
 /crosspost/
   |
 Crosspost
   |
   +--------------------------+
   |                          |
provider OAuth/APIs       XMR Commerce
                              |
                       monero-wallet-rpc
                              |
                       remote Monero node
~~~

Only Caddy should publish host ports. wallet-rpc, Commerce, and Crosspost stay on the private Podman network.

The VM contains a view-only wallet. The authoritative spending wallet stays elsewhere.

## Required VM

Recommended starting point:

~~~text
2 vCPU
2 GB RAM
32 GB disk
Debian 12 or Debian 13
~~~

16 GB may work for a minimal setup, but 32 GB gives comfortable room for images, packages, logs, SQLite data, and wallet cache.

Do not deploy this stack directly onto the Proxmox VE host. Use a dedicated VM.

## Network and DNS

Allow inbound:

~~~text
TCP 80
TCP 443
UDP 443 optional for HTTP/3
~~~

Do not expose:

~~~text
8787   Commerce
8790   Crosspost
18083  monero-wallet-rpc
~~~

Create a DNS record such as:

~~~text
crosspost.example.com -> VM public IP
~~~

If the VM is behind NAT, forward 80 and 443 to it.

Caddy obtains HTTPS automatically when DNS and inbound connectivity are correct.

Production Crosspost public URL:

~~~text
https://APP_DOMAIN/crosspost
~~~

A real HTTPS hostname is recommended for OAuth. Do not build production OAuth around a raw private IP.

## Inputs Hermes may request

Hermes may request:

1. APP_DOMAIN.
2. The owner's 64-character hexadecimal Nostr public key.
3. A remote Monero node URL that matches the selected network.
4. A wallet restore height at or before wallet creation.
5. An X OAuth Client ID if X support is required.

During interactive view-only wallet creation, the owner enters directly into the terminal:

- Monero primary address.
- Monero secret view key.

Hermes must never ask the owner to send the secret view key in chat, GitHub, tickets, or logs.

Hermes must never request:

- Monero mnemonic seed.
- Monero private spend key.
- Hardware-wallet recovery seed.
- Nostr private key.

## Secret handling

Non-secret or public inputs:

~~~text
Nostr hex public key
Monero primary receiving address
X Client ID
APP_DOMAIN
~~~

Server secrets:

~~~text
deploy/light-xmr/secrets/admin_token
deploy/light-xmr/secrets/rpc_password
deploy/light-xmr/secrets/wallet_password
deploy/light-xmr/secrets/crosspost_encryption_key
view-only wallet file containing the private view capability
~~~

Never commit:

~~~text
.env
secrets/
wallet files
production SQLite databases
OAuth client secrets
secret view key exports
private spend keys
mnemonic seeds
~~~

Before any Git push:

~~~bash
git status
git diff --cached
~~~

Stop if any secret is staged.

## Separate Monero receiving wallet

Use a dedicated receiving wallet for Glowstr payments instead of the owner's everyday wallet.

On the trusted wallet device:

1. Create or select a dedicated wallet.
2. Store the mnemonic seed offline.
3. Keep the private spend key off the application VM.
4. Obtain the primary address and secret view key.

For monero-wallet-cli, the relevant commands are:

~~~text
address
viewkey
~~~

Do not copy the seed or private spend key to the VM.

For stagenet testing, use a stagenet wallet and stagenet remote node. Mainnet and stagenet wallet data must stay separate.

## Why a view-only wallet works

The paywall needs to:

- create a unique invoice address;
- tell invoices apart;
- detect incoming payment;
- count confirmations;
- grant access to the correct Nostr identity.

The primary address contains the public spend key. Combined with the private view key, a view-only wallet can monitor the wallet and its subaddresses.

Glowstr Commerce calls wallet RPC create_address for each invoice.

This allows the VM to monitor incoming payments without intentionally storing the private spend key.

A compromise of the VM can still reveal incoming-wallet metadata because the private view key is present. It should not, by design, provide the key needed to spend the XMR.

## Remote Monero node

The wallet uses a remote daemon via --daemon-address and runs it as an untrusted daemon.

Benefits:

- no local blockchain;
- much lower disk usage;
- simpler VM.

Tradeoffs:

- remote-node availability affects payment detection;
- the node operator can observe the VM's connection and timing metadata;
- a remote node is a privacy/reliability dependency.

Prefer a node the owner controls or trusts. HTTPS is preferred where supported.

The current installer assumes the remote daemon does not require username/password authentication.

## Deploy

Clone the feature branch:

~~~bash
git clone https://github.com/Notafbihoneypot/Glowstar.git
cd Glowstar
git checkout codex/crosspost-bridge
chmod +x deploy/glowstr-light-deploy.sh
~~~

First deployment must be stagenet:

~~~bash
./deploy/glowstr-light-deploy.sh
~~~

The installer prompts for:

~~~text
APP_DOMAIN
CROSSPOST_ALLOWED_PUBKEYS
MONERO_REMOTE_NODE
MONERO_RESTORE_HEIGHT
optional CROSSPOST_X_CLIENT_ID
~~~

The installer:

1. verifies it is not running directly on the PVE host unless explicitly overridden;
2. installs Podman/dependencies on Debian/Ubuntu if needed;
3. configures rootless low-port binding if required;
4. builds the verified Monero CLI image;
5. creates random internal secrets;
6. creates the lightweight Compose stack;
7. creates the view-only wallet interactively;
8. starts wallet-rpc, Commerce, Crosspost, and Caddy;
9. starts with CROSSPOST_PREVIEW_ONLY=true.

Generated deployment directory is normally:

~~~text
~/glowstr-light/deploy/light-xmr/
~~~

## View-only wallet creation

The first run invokes monero-wallet-cli with --generate-from-view-key.

The owner supplies only:

~~~text
PRIMARY ADDRESS
SECRET VIEW KEY
~~~

Do not supply:

~~~text
mnemonic seed
private spend key
~~~

Use a restore height at or before wallet creation. Zero works but is slower.

Named wallet volumes are separated by network, for example:

~~~text
glowstr-light-wallet-stagenet
glowstr-light-wallet-mainnet
~~~

## Default XMR paywall

Defaults:

~~~text
feature: crosspost_30d
duration: 30 days
price: 0.02 XMR
confirmations: 2
watch interval: 10 seconds
pending invoices per Nostr pubkey: 5
global invoice rate limit: 500/hour
invoice expiry: 30 minutes
~~~

Relevant environment settings:

~~~dotenv
CROSSPOST_PREVIEW_ONLY=true
GLOWSTR_XMR_CONFIRMATIONS=2
GLOWSTR_XMR_CROSSPOST_30D_ATOMIC=20000000000
GLOWSTR_XMR_MAX_PENDING_PER_PUBKEY=5
GLOWSTR_XMR_MAX_INVOICES_PER_HOUR=500
GLOWSTR_XMR_WATCH_SECONDS=10
~~~

## Payment lifecycle

~~~text
Nostr identity signs in
        |
Unlock with XMR
        |
authenticated invoice request
        |
wallet-rpc create_address
        |
fresh subaddress
        |
WAITING
        |
payment seen
        |
MEMPOOL
        |
mined
        |
CONFIRMING
        |
required confirmations reached
        |
PAID
        |
crosspost_30d entitlement
        |
publishing access until valid_until
~~~

Commerce now has a server-side invoice watcher. A payer does not need to keep the payment dialog open for confirmation to complete.

Renewals extend from the later of the current time or current entitlement expiry, so unused membership time is not discarded.

## Access enforcement

Live publishing is enforced by Crosspost on the server, not only by frontend UI.

Before accepting a live post, Crosspost checks the private Commerce entitlement endpoint using the internal admin token.

No valid entitlement:

~~~text
HTTP 402
An active Monero membership is required
~~~

Commerce unavailable:

~~~text
HTTP 503
Membership service unavailable; no post was queued
~~~

This is intentionally fail-closed.

## Preview-only safety mode

Keep this enabled during deployment testing:

~~~dotenv
CROSSPOST_PREVIEW_ONLY=true
~~~

In preview mode the owner can sign in, link identities, compose, upload an image, preview versions, and test the XMR membership workflow, but Crosspost will not enqueue live provider posts.

Only after explicit acceptance change to:

~~~dotenv
CROSSPOST_PREVIEW_ONLY=false
~~~

Then recreate Crosspost:

~~~bash
cd ~/glowstr-light/deploy/light-xmr
podman compose up -d --force-recreate crosspost
~~~

## OAuth callbacks

Bluesky:

~~~text
Client metadata:
https://APP_DOMAIN/crosspost/oauth/bluesky/client-metadata.json

Callback:
https://APP_DOMAIN/crosspost/oauth/bluesky/callback
~~~

Mastodon:

~~~text
https://APP_DOMAIN/crosspost/oauth/mastodon/callback
~~~

Allowed instances must be listed in CROSSPOST_MASTODON_HOSTS.

X:

~~~text
https://APP_DOMAIN/crosspost/oauth/x/callback
~~~

Set CROSSPOST_X_CLIENT_ID.

The implementation uses OAuth 2 Authorization Code + PKCE and binds the connection to the verified X user ID.

ActivityPub-compatible connector:

~~~text
https://APP_DOMAIN/crosspost/oauth/activitypub/callback
~~~

Hosts must be in CROSSPOST_ACTIVITYPUB_HOSTS and must expose the Mastodon-compatible API used by the bridge. This is not universal ActivityPub support.

Nostr:

- sign-in uses NIP-98;
- only allowed public keys may sign in;
- kind-1 output is client-signed;
- Crosspost does not store the user's Nostr private key.

## Health checks

After deployment:

~~~bash
cd ~/glowstr-light/deploy/light-xmr
podman compose ps
podman compose logs --tail=100
~~~

Expected services:

~~~text
wallet-rpc
commerce
crosspost
caddy
~~~

Per-service logs:

~~~bash
podman compose logs -f wallet-rpc
podman compose logs -f commerce
podman compose logs -f crosspost
podman compose logs -f caddy
~~~

External check:

~~~bash
curl -I https://APP_DOMAIN/crosspost/
~~~

## Stagenet acceptance test

Hermes must complete this before mainnet.

### Authentication

- Sign in using the allowlisted Nostr identity.
- Confirm the hub loads.
- Confirm an unapproved key is rejected.

### OAuth

Test one provider at a time:

~~~text
Bluesky
Mastodon
X if configured
ActivityPub-compatible account if configured
~~~

Verify the returned linked identity is the account that was authorized.

### Preview

Create a harmless test draft and verify:

- destination selection;
- character counts;
- per-platform override;
- review screen;
- preview-only mode blocks live publication.

### XMR invoice

Click Unlock with XMR and verify:

- authentication is required;
- amount is correct;
- a fresh subaddress is displayed;
- a Monero URI is available;
- state begins at WAITING.

Create another invoice and confirm it has a different subaddress.

### Payment

Pay using stagenet XMR.

Expected states:

~~~text
WAITING
MEMPOOL
CONFIRMING
PAID
~~~

After the configured confirmations:

- crosspost_30d exists;
- valid_until is in the future;
- UI shows an active pass.

### Browser-close test

1. create an invoice;
2. pay it;
3. close the browser before confirmation;
4. wait for required confirmations;
5. reopen and sign in.

The pass should become active because the Commerce watcher monitors pending invoices server-side.

### Identity isolation

Payment for Nostr pubkey A must not unlock pubkey B.

## Mainnet cutover

Only after stagenet succeeds:

~~~bash
GLOWSTR_NETWORK=mainnet ./deploy/glowstr-light-deploy.sh
~~~

The installer requires typing MAINNET.

Use a separate mainnet receiving wallet and a mainnet remote node.

Keep preview-only enabled through the first mainnet payment test.

Do not reuse stagenet wallet data or entitlements.

## Live publishing acceptance

After explicit approval, set preview-only false and test accounts controlled by the owner.

Test separately:

1. Bluesky only.
2. Mastodon only.
3. X only.
4. ActivityPub-compatible only.
5. Nostr only.
6. Multi-destination last.

Verify:

- the intended identity receives the post;
- reviewed text matches;
- image and alt text are correct;
- delivery result URL is correct where available;
- a failure on one destination does not mark another successful;
- ambiguous writes become uncertain rather than being blindly replayed.

## Security controls that must remain

Do not weaken without review:

~~~text
dedicated VM
rootless Podman
Caddy-only public ingress
private Podman network
Crosspost read-only root filesystem
cap_drop ALL
no-new-privileges
HttpOnly sessions
CSRF/origin checks
NIP-98 login
Nostr allowlist
AES-256-GCM credential storage
one-use challenges/OAuth state
stable provider identity binding
idempotent post enqueue
server-side XMR enforcement
fail-closed Commerce checks
remote node treated as untrusted
no Monero spend key on server
~~~

## Backup

Back up:

- secrets/crosspost_encryption_key;
- Crosspost data volume;
- Commerce data volume;
- optionally Caddy data/config;
- protected copy of the view-only wallet if desired.

The real spending wallet seed remains the authoritative recovery secret and must be kept separately/offline. It should not exist in this VM.

A Proxmox VM backup is useful but must not be the only backup of the Crosspost encryption key or business databases.

Never use this during normal maintenance:

~~~bash
podman compose down -v
~~~

The -v flag removes persistent volumes.

## Update

Before update, back up and check service health.

Then:

~~~bash
cd ~/glowstr-light
git fetch origin
git checkout codex/crosspost-bridge
git pull --ff-only origin codex/crosspost-bridge

cd deploy/light-xmr
podman compose build --pull
podman compose up -d
podman compose ps
podman compose logs --tail=100
~~~

Use a Proxmox snapshot or separate test VM for risky upgrades.

## Troubleshooting

Crosspost page unavailable:

~~~bash
podman compose ps
podman compose logs caddy
podman compose logs crosspost
~~~

Check DNS, firewall, NAT, and ports 80/443.

Wallet RPC restarting:

~~~bash
podman compose logs wallet-rpc
~~~

Likely causes:

- view-only wallet missing;
- wrong network;
- remote node unreachable;
- wrong wallet password;
- mainnet/stagenet mismatch.

Invoice creation fails:

~~~bash
podman compose logs commerce
podman compose logs wallet-rpc
~~~

Payment remains WAITING:

- verify displayed subaddress was used;
- verify correct network;
- verify remote node is current;
- verify wallet refresh has reached the transaction;
- verify amount is sufficient;
- inspect invoice watcher logs.

Payment remains CONFIRMING:

- check remote-node chain height;
- verify the transaction is receiving new confirmations.

Payment is PAID but UI appears locked:

- reload and sign in;
- inspect Crosspost and Commerce logs;
- verify entitlement values:

~~~text
pubkey = signed-in Nostr hex public key
feature = crosspost_30d
target = empty string
valid_until > current time
~~~

Wrong OAuth redirect:

~~~text
CROSSPOST_PUBLIC_URL must equal:
https://APP_DOMAIN/crosspost
~~~

X button disabled:

Set CROSSPOST_X_CLIENT_ID and recreate Crosspost.

Mastodon host rejected:

Add only the intended host to CROSSPOST_MASTODON_HOSTS. Do not allow arbitrary OAuth hosts without SSRF/security review.

## Payment incident procedure

If a customer says they paid but access was not granted:

1. Never request seed or spend key.
2. Obtain invoice ID if available.
3. Inspect Commerce logs.
4. Verify stored invoice address/amount/status.
5. Verify wallet RPC sees the transaction.
6. Verify confirmations.
7. Verify the entitlement row.
8. Verify the Nostr pubkey matches the signed-in identity.

Do not manually grant access from a screenshot alone.

## Privacy limitations

Crosspost is not zero-knowledge.

The operator/server may be able to access:

- public post drafts/content;
- provider credentials after server-side decryption;
- account mappings;
- delivery history;
- uploaded media;
- incoming Monero wallet metadata available to the view-only wallet.

The remote Monero node can observe network/timing metadata from the VM.

The server should not possess:

- Nostr private keys;
- Monero mnemonic seed;
- Monero private spend key.

## Current functional limits

Implemented:

- text;
- one image;
- alt text;
- Bluesky/Mastodon/X/Mastodon-compatible OAuth;
- Nostr client-signed output;
- per-platform overrides;
- retries;
- delivery history;
- XMR 30-day entitlement.

Not currently implemented:

- video;
- carousels;
- scheduling;
- cross-network delete/edit sync;
- reply synchronization;
- automatic source-feed mirroring;
- open public registration;
- universal ActivityPub actor/inbox/outbox;
- multi-account groups per provider.

## Production acceptance checklist

Hermes may report production-ready only after applicable checks pass:

- [ ] dedicated Debian VM, not PVE host
- [ ] rootless Podman
- [ ] DNS correct
- [ ] valid HTTPS
- [ ] only intended public ports exposed
- [ ] no local monerod
- [ ] remote node reachable
- [ ] view-only wallet created
- [ ] no spend key or seed on server
- [ ] wallet-rpc healthy
- [ ] Commerce healthy
- [ ] Crosspost healthy
- [ ] allowlisted Nostr login works
- [ ] unapproved Nostr login rejected
- [ ] OAuth tested
- [ ] preview-only mode verified
- [ ] unique subaddress per invoice verified
- [ ] stagenet payment detected
- [ ] server watcher grants access after browser closure
- [ ] entitlement isolated by Nostr pubkey
- [ ] mainnet and stagenet wallet/data separated
- [ ] mainnet payment tested
- [ ] live publishing enabled only after explicit acceptance
- [ ] providers tested separately
- [ ] backups verified
- [ ] Git contains no secrets

## Hermes operating rules

1. Deploy inside a dedicated Debian VM unless the owner explicitly overrides.
2. Never request or store the Monero mnemonic seed or private spend key.
3. Never put the secret view key into chat, Git, .env, command history, or logs.
4. Keep CROSSPOST_PREVIEW_ONLY=true until acceptance testing passes.
5. Test stagenet before mainnet.
6. Treat the remote Monero node as untrusted.
7. Do not expose wallet-rpc, Commerce, or Crosspost directly.
8. Expose only Caddy on 80/443.
9. Keep the Nostr allowlist for this private deployment.
10. Never run podman compose down -v during routine maintenance.
11. Inspect staged Git changes for secrets before every push.
12. If any acceptance test fails, stop at that stage and report the exact failing component and useful log excerpt instead of enabling production.

## Copy-paste task for Hermes

~~~text
Deploy Glowstr Crosspost lightweight XMR from:
https://github.com/Notafbihoneypot/Glowstar
branch: codex/crosspost-bridge

Read HERMES_DEPLOYMENT_RUNBOOK.md first and follow it.

Use deploy/glowstr-light-deploy.sh as the deployment entry point.

Deploy to a dedicated Debian VM on Proxmox, not the Proxmox VE host.

Start with Monero stagenet and CROSSPOST_PREVIEW_ONLY=true.

Use a view-only Monero wallet and a remote Monero node. Never request, import, or store the owner's mnemonic seed or private spend key.

Only Caddy should publish 80/443. Do not expose wallet-rpc, Commerce, or Crosspost directly.

During view-only wallet creation, have the owner enter the primary address and secret view key directly in the terminal. Do not ask them to send the secret view key in chat.

Complete the production acceptance checklist before switching to mainnet or enabling live publishing.
~~~

## Primary upstream Monero references

- https://docs.getmonero.org/interacting/monero-wallet-rpc-reference/
- https://docs.getmonero.org/rpc-library/wallet-rpc/
- https://docs.getmonero.org/interacting/monero-wallet-cli-reference/
- https://docs.getmonero.org/public-address/subaddress/
- https://docs.getmonero.org/cold-storage/offline-transaction-signing/

These references document remote-daemon wallet operation, view-only restoration, wallet RPC, and subaddress monitoring.

## Relevant repository components

~~~text
crosspost/
monero-commerce/
deploy/glowstr-light-deploy.sh
deploy/podman/monero/Containerfile
.github/workflows/crosspost.yml
~~~

The older deploy/podman full stack includes a local Monero node. For this use case, deploy/glowstr-light-deploy.sh is the preferred path.

## Final security boundary

~~~text
OWNER-CONTROLLED WALLET
  seed ..................... offline/trusted only
  private spend key ........ offline/trusted only
  primary address .......... may be copied to VM
  private view key ......... view-only VM wallet
              |
              v
PROXMOX DEBIAN VM
  view-only wallet
  monero-wallet-rpc
  XMR Commerce
  Crosspost
  Caddy
              |
              v
REMOTE MONERO NODE
  blockchain access
~~~

Preserve this boundary throughout deployment and maintenance.
