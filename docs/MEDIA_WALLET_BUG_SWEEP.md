# Android media and wallet bug sweep — 0.3.14

Inspected main commit `7370e7d145d8e657e0bf76e5cab87186ad363523`, stable APK release 0.3.11, and the current 0.3.13 FROSTR test build configuration.

## Confirmed fixes

- The Android WebView used a default `WebChromeClient`, so HTML file inputs never opened a picker. The bundled document now opens Android's read-only `ACTION_OPEN_DOCUMENT` picker, filters MIME types, and receives its selected content URIs. Full storage permissions are unnecessary. Cancelling, a missing picker, duplicate requests, and activity destruction complete callbacks without leaving the button stuck. Only readable, granted content URIs are accepted; private file paths and the app's own providers are refused.
- The WebView disabled content-URI access, preventing selected documents from being read. It now permits content access while file-URL access, external document navigation, and bridge capability isolation remain enforced.
- Android navigation refused `monero:` wallet links. A capability-gated native wallet handoff now accepts format-checked mainnet payment URIs, including after asynchronous signer approval. Arbitrary Android intent URLs remain blocked.
- A zero amount plus a description produced `&tx_description` without a preceding query delimiter. Payment URI creation now shares one builder and preserves amounts to 12 decimal places. Negative, non-finite, scientific-notation, or over-precision input is refused.
- Address-format checks previously accepted any length from 95 through 106 characters. They now accept the exact primary/subaddress and integrated address lengths. This is format validation, not a cryptographic checksum or wallet-ownership check.
- Failed legacy uploads could return `null`, which the composer inserted into the draft. Empty, relative, or unsafe returned URLs are rejected, the draft remains intact, and the button/file input are reset. An upload finishing after an account change cannot insert into the new account's draft.
- A tip DM claimed payment had already been sent before the wallet opened. It now describes preparation and explicitly says payment is not yet confirmed.

## Monostr watcher report — not reproduced

Glowstr currently advertises direct tipping addresses in kind-0 metadata. It does not call Monostr's watcher registration API, and this update does not add that integration or register any wallet.

Monostr's current watcher validates `POST /v1/accounts` by requiring:

1. A standard primary address, not a subaddress or integrated address.
2. The address network to match the watcher's configured network.
3. A canonical private view key whose public key matches that address.

It distinguishes those validation failures from an unavailable scanner backend. A primary mainnet address starts with `4`; an ordinary mainnet subaddress starts with `8`. A direct-tip subaddress that works in Glowstr can therefore be rejected by Monostr registration by design. The exact rejection message is needed to identify the reported case; a valid matching wallet can also fail for service/authentication reasons.

References: [Monostr protocol](https://github.com/schmidt1024/monostr/blob/main/docs/protocol/monostr-tips.md), [watcher registration validation](https://github.com/schmidt1024/monostr/blob/main/watcher/internal/watcher/service.go), and [Android Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files).

## Build and testing

Run `node tests/media-wallet-regression.cjs` for payment URI, native handoff, failed-upload, and account-switch scenarios. `:app:testMediafixUnitTest` runs Android picker behavior tests under Robolectric. Existing client, signer, commerce, cryptography, bridge-isolation, and release-manifest gates remain in the build workflow.

The test APK is `org.glowstr.meshbridge.mediafix` and installs beside existing Glowstr builds. CI currently creates temporary debug certificates; using a separate application ID avoids requiring an uninstall that could remove accounts or local data. The production signing configuration is unchanged. Physical Pixel/GrapheneOS picker and wallet-app behavior still need device confirmation; unit/build checks cannot establish physical-device success.
