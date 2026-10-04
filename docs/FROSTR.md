# FROSTR in Glowstr

Glowstr connects to an external FROSTR / Igloo NIP-46 signer. The signer performs
threshold signing; Glowstr does not split or reconstruct your account key and
never imports a FROSTR share or group package. This is a remote signer integration,
not an in-app Shamir backup generator.

## Set up and connect

1. Set up a FROSTR group outside Glowstr, for example 2 of 3. Keep shares on
   separate signer devices, with an offline backup and a copy of the group package.
   Do not put enough shares to meet the threshold on the client device.
2. Set up [Igloo Server](https://github.com/FROSTR-ORG/igloo-server) with one share,
   enable its NIP-46 service, and bring another group signer online. Use an Igloo
   release with NIP-46 `connect`, `get_public_key`, `sign_event`, and NIP-44 support.
3. In Glowstr's Identity Vault, open **FROSTR THRESHOLD SIGNER**, enter the group's
   account npub and Igloo's `bunker://` URL, and press **CONNECT FROSTR**. The bunker
   public key is the transport identity and can differ from the account npub.
4. Approve Glowstr in Igloo. Glowstr checks the returned account against your npub.
   Approve individual requests or narrowly scoped permissions in your signers.
5. Use gift-wrapped NIP-17 messages. The FROSTR mode does not use legacy NIP-04.

The initial permissions cover profile updates, notes, contacts, deletion, reposts,
reactions, NIP-17 seals, mute/relay/inbox lists, and relay authentication. Additional
features may require a separate signer approval. No wildcard `sign_event`
permission is requested.

## Sessions and logout

Signing and encryption follow the selected signer. If FROSTR loses its connection
or quorum, requests fail; they never use a previously imported nsec. Returned events
must match the requested body and account and pass NIP-01/BIP-340 verification.

Android's **Stay logged in** option encrypts only the disposable NIP-46 client key
and connection metadata with an Android Keystore key. The record is bound to the
account and signer method. Browser clients keep transport material in session
storage and reconnect after their browser session ends. Connection secrets are
removed after the handshake; account keys and shares are never stored by this mode.

Logout immediately deletes local session records, cancels pending operations, and
attempts NIP-46 `logout`. If the signer is offline or does not support revocation,
Glowstr reports that you should revoke its connection in Igloo. Deleting the local
client key cannot guarantee deletion of a copy stolen before logout.

## Custody and testing limits

Threshold custody does not make a compromised client trustworthy. An automatically
approving quorum can still authorize a malicious request. Review requests on the
signers and keep devices and shares independent. An old full nsec continues to
control the same identity; splitting that key does not revoke old copies.

The automated client tests use disposable keys and an in-memory NIP-46 signer with
real Schnorr signatures and NIP-44 messages. They cover forged responses, request
binding, denied operations, disconnects, timeouts, account changes, logout, native
session restoration, and account mismatches. Before a production release, also
exercise the complete Igloo/Glowstr flow on separate devices: posting, relay auth,
NIP-17 send/receive, quorum loss, restart, and signer-side revocation. These tests
are not a third-party cryptographic audit of FROSTR or Glowstr.


## Optional Bifrost interoperability check

`tests/frostr-interop.ts` verifies that Glowstr accepts a real Bifrost 2-of-3
signature with only two nodes online and that one remaining node cannot sign.
It uses a disposable group and a loopback relay. This check passed against Bifrost
commit `5c8348e5d597df459ce0b6960293289a2aabdc60` (package version 2.0.2).
It also closes the underlying transports explicitly to work around that checkout's
SDK cleanup API mismatch; it does not change threshold signing code.

Clone that Bifrost revision into a separate directory and run `npm ci --ignore-scripts`.
From that checkout, run the following with absolute paths to Glowstr:

```sh
TSX_TSCONFIG_PATH=test/tsconfig.json node --import tsx \
  /path/to/Glowstar/tests/frostr-interop.ts \
  /path/to/Glowstar/glowstr-v5.3-bluetooth-direct.html
```

This checks BIP-340 signature interoperability; it does not replace the separate
Igloo NIP-46 and Android device acceptance checks above. Igloo Server currently
pins the Bifrost 1.x API family; do not substitute Bifrost 2.x into its deployment
without following upstream compatibility guidance.
