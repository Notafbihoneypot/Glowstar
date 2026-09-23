# Glowstr connected-identity crossposting

Link **Bluesky, Mastodon, X, and a Mastodon-compatible ActivityPub account** to one Glowstr identity. Compose a public post once, choose which linked accounts publish it, customize individual versions, review, and track every delivery separately. Nostr output is also available through your client signer.

This implementation has local API and browser tests with simulated destinations, plus live publishing adapters. Account linking now uses OAuth/authorization redirects for Bluesky, Mastodon, X, and the Mastodon-compatible ActivityPub slot. Live platform publishing and container deployment still require operator acceptance testing with accounts you control. Posting starts in the shared composer; it does not monitor existing social feeds.

## How identities are linked

Your allowlisted Nostr public key identifies your private bridge account. Connecting a platform verifies its identity using an authorized credential, then stores this mapping:

| Connection | Stable account binding | Publishing path |
| --- | --- | --- |
| Bluesky | DID | AT Protocol repository record |
| Mastodon | Server URL + account ID | Mastodon API; the account's server handles ActivityPub federation |
| X | X user ID | X API v2 |
| ActivityPub-compatible service | Server URL + account ID | Mastodon-compatible account, media, and status APIs |
| Nostr | Public key | Client-signed kind-1 event sent to configured relays |

The UI shows linked profiles and account IDs. A queued post remains bound to the reviewed account ID; replacing a connection with another account cannot redirect that post. Selecting the same federated account through both the Mastodon and ActivityPub slots is rejected. One account per connector is supported in this version. Labels and profile URLs reflect the last connection verification; reconnect to refresh a changed handle.

ActivityPub is a federation protocol, not a universal account-login or publishing API. This bridge publishes **as an existing account** through its service's supported client API. Mastodon already federates through ActivityPub. The extra ActivityPub connector is for another Mastodon-compatible service; it is not a standalone actor, inbox/outbox server, or universal adapter for every ActivityPub application. Compatibility must be tested on the selected service. It uses `/api/v1/accounts/verify_credentials`, `/api/v1/media`, and `/api/v1/statuses`.

These connections are private to your bridge account. They do not modify public bios, merge followers, migrate accounts, or issue public identity proofs. Cross-posting itself associates the chosen public identities.

## Included

- Mobile composer, connected-profile cards, per-platform versions and character checks, explicit public-post review, and delivery history.
- NIP-98 sign-in with an operator allowlist, one-use challenges, HttpOnly sessions, and CSRF/origin checks. Your Nostr private key stays in the client signer.
- Encrypted provider credentials, OAuth state, refresh credentials, and AT Protocol sessions (AES-256-GCM), plus a SQLite queue, bounded retries, and durable upload checkpoints.
- One image per post, normalized to a metadata-free 1080×1080 JPEG under 950 KB with padding. Descriptions go to Bluesky, Mastodon, and the compatible ActivityPub service.
- Request idempotency and stable Bluesky record keys. Ambiguous publication failures are marked `uncertain` and need an explicit destination check before manual retry.
- Optional existing Monero Commerce entitlement checks. Preview-only mode is on by default.

## Local setup

Requires Node.js 24. From this directory:

```sh
npm ci --ignore-scripts
cp .env.example .env
node setup.mjs
```

Edit `.env`: set `CROSSPOST_ALLOWED_PUBKEYS` to your hex **public** key, or a comma-separated list. Never put an `nsec` here. To connect X, also create an OAuth 2 application, set its callback URL to `CROSSPOST_PUBLIC_URL/oauth/x/callback`, and set `CROSSPOST_X_CLIENT_ID`. A confidential web app may provide `CROSSPOST_X_CLIENT_SECRET_FILE`; leave it unset for a public client. Then:

```sh
node --env-file=.env server.mjs
```

Open `http://localhost:8790/` with a NIP-07 extension. Connect accounts, select identities, and review previews. Set `CROSSPOST_PREVIEW_ONLY=false` only when ready to publish an explicit test post to accounts you control.

For Glowstr's hosted client, serve the bridge at the same trusted origin under `/crosspost/` and set `CROSSPOST_PUBLIC_URL=https://YOUR_APP_DOMAIN/crosspost`. The **CROSSPOST ↗** launcher opens a window that reuses Glowstr's NIP-07, NIP-46/Amber bunker, or local signer. It copies a top-level draft; replies are excluded. Standalone Amber NIP-55 redirect signing and the APK's local origin are not integrated yet.

HTTPS is required outside localhost. The configured public URL must match the proxy path exactly for signed login URLs, session cookies, and public media URLs.

## Credentials and server compatibility

| Platform | What to connect |
| --- | --- |
| Bluesky | Enter a handle or DID, then authorize Glowstr through AT Protocol OAuth. The bridge requests `atproto`, `repo:app.bsky.feed.post`, and `blob:image/jpeg`; the DID is the stable account binding. OAuth session refresh is handled by the AT Protocol OAuth client and stored encrypted. |
| Mastodon | Enter an operator-approved instance, then authorize there. Glowstr dynamically registers its OAuth client and requests `read:accounts`, `write:statuses`, and `write:media`. Add your instance to `CROSSPOST_MASTODON_HOSTS`. |
| X | Configure `CROSSPOST_X_CLIENT_ID`, then authorize with OAuth 2.0 + PKCE. The requested user scopes are `users.read`, `tweet.read`, `tweet.write`, `media.write`, and `offline.access`; refresh tokens are rotated and saved encrypted when X issues them. |
| ActivityPub-compatible service | Enter an operator-approved host in `CROSSPOST_ACTIVITYPUB_HOSTS`, then authorize through its Mastodon-compatible OAuth endpoints. The service must support the account, status, and media APIs used by this bridge. This remains a compatibility connector, not universal ActivityPub client-to-server support. |

The normal UI no longer asks users to paste social-account passwords or long-lived provider tokens. The legacy credential verification endpoint remains for local/operator migration and tests, but the supported interactive path is OAuth. Identity verification still does not guarantee a provider will accept every later write; provider permissions, limits, and account state can change. Keep OAuth application secrets out of chat, Git, and logs.

Nostr output requires writable WSS relays in `CROSSPOST_NOSTR_RELAYS`. Success means at least one relay acknowledged the event; the full result records every relay acknowledgement. Server-side NIP-42 challenge signing is not implemented, so the existing XMR-gated relay is a separate service and is not a supported authenticated output relay yet.

## Rootless Podman deployment

After editing `.env` and generating the encryption key:

```sh
podman compose up -d --build
podman compose logs --tail=50 crosspost
```

Run this recipe as your normal unprivileged host user. Container UID 0 maps to that user inside **rootless** Podman, allowing access to its mode-0600 encryption key. The service listens on **127.0.0.1:8790**, uses a read-only container filesystem, and stores data in `glowstr-crosspost-data`. Run one process per data volume.

The existing `deploy/podman/Caddyfile` includes the `/crosspost/` route. Start this Compose project alongside that stack and reload its Caddy configuration. Regenerate the hosted Glowstr client with the stack's normal deployment workflow to include the new launcher, or open `/crosspost/` directly with a NIP-07 extension.

For another Caddy installation, add these before the catch-all handler:

```caddyfile
handle /crosspost {
  redir /crosspost/ 308
}
handle_path /crosspost/* {
  reverse_proxy 127.0.0.1:8790
}
```

Set `CROSSPOST_PREVIEW_ONLY=false` and recreate the container after checking previews. `GET /health` provides a health check.

## Optional Monero subscriptions

To require an existing Commerce entitlement at enqueue time:

```dotenv
CROSSPOST_COMMERCE_URL=http://127.0.0.1:8787
CROSSPOST_ENTITLEMENT_FEATURE=relay_30d
CROSSPOST_ENTITLEMENT_TARGET=EXACT_EXISTING_ENTITLEMENT_TARGET
GLOWSTR_COMMERCE_ADMIN_TOKEN_FILE=/absolute/path/to/admin_token
```

Match the entitlement target exactly, including any scheme or trailing slash. For Podman, mount this token read-only using a private Compose override and configure its in-container path. No invoice prices or feature definitions are changed. Missing/expired membership rejects a new post; an unavailable Commerce service fails closed. Accepted jobs can finish or retry after membership expires.

A possible business model is managed hosting, setup, and support paid in Monero, with an agreed posting allowance. The default daily limit is 50 posts per identity hub. Community demand, pricing, and operating costs still need validation; X API costs remain an operating expense.

## Operations and limits

- The operator can read public post content and decrypt stored platform credentials. Encryption at rest does not hide them from the operator. APIs see the server's network address.
- Stop the service before backing up the entire data volume; back up the encryption key separately. Losing the key makes stored credentials unreadable. Key rotation/migration tooling is not included.
- Posted media and delivery history persist until removed by the operator. Unused image uploads can be cleared in the Identities tab; at most 20 unpublished images are allowed per account. Monitor disk use. There is no automatic retention policy.
- Uploaded images are private until a post is queued, then available at a high-entropy public URL. Removal cannot recall copies from other networks.
- Unlinking an identity cancels waiting jobs; a request already in progress can complete. Remote edits/deletes and replies are not synchronized.
- Automatic retries stop after eight attempts. An ambiguous publish is never blindly replayed. Manual retries of `uncertain` jobs may duplicate a remote post.
- Text and one image are supported. Video, carousels, scheduling, automatic source-feed mirroring, multi-account groups, and a native ActivityPub actor are outside this version.
- Existing platform IDs remain separate. This is a publishing bridge, not a cross-network account-migration or shared-follower system.

## Checks and primary references

```sh
npm test
npx playwright install chromium
npm run test:browser
```

Tests use temporary databases, local HTTP sessions, fake provider responses, and a test signer. They do not publish externally. OAuth unit tests cover PKCE, stable identity binding, one-use state, encrypted application credentials, and X refresh rotation. The browser flow uses four pre-linked test identities, reviews a post, and verifies four simulated deliveries and mobile layout without opening external consent pages.

- [Mastodon ActivityPub implementation](https://docs.joinmastodon.org/spec/activitypub/), [W3C ActivityPub](https://www.w3.org/TR/activitypub/), [Akkoma Mastodon API differences](https://docs.akkoma.dev/stable/development/API/differences_in_mastoapi_responses/)
- [Mastodon statuses](https://docs.joinmastodon.org/methods/statuses/) and [media](https://docs.joinmastodon.org/methods/media/)
- [Bluesky post lexicon](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json)
- [X post creation](https://docs.x.com/x-api/posts/create-post), [media upload](https://docs.x.com/x-api/media/upload-media), and [pricing](https://docs.x.com/x-api/getting-started/pricing)
- [NIP-98 authentication](https://github.com/nostr-protocol/nips/blob/master/98.md), [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md), [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md)
