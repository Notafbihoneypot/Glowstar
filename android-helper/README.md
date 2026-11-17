# Glowstr Android

Native Android shell for the bundled Glowstr Nostr client. It provides capability-gated Keystore, QR, wallet handoff, and direct Bluetooth APIs without Google Play Services.

## Unsigned release

```sh
gradle -p android-helper :app:assembleRelease
```

The release is non-debuggable and intentionally unsigned at `app/build/outputs/apk/release/app-release-unsigned.apk`. Never upload an owner keystore or password to CI. Align, sign, and verify offline using [the signing guide](../docs/OFFLINE-APK-SIGNING.md).

Production uses `org.glowstr.meshbridge`. Historical debug/integrated previews used different package IDs and cannot share app-private storage or Keystore records. Preserve signer recovery before removing any installed preview.

## Security model

- The WebView loads only the bundled document. Every native method requires a fresh per-launch capability; remote frames are blocked.
- Bluetooth starts only after **RELAYS → LOCAL MESH → START BLUETOOTH**. The client talks directly to the native bridge; no localhost server or pairing token exists.
- Backups are disabled. Keystore ciphertext cannot be opened while the device is locked.
- A local nsec still enters the trusted renderer. Prefer Amber or FROSTR when the account key must remain outside WebView memory.

## Checks

CI generates `app/build/generated/glowstrAssets/glowstr.html`, runs client regressions against that exact file, runs Java and Android unit tests, builds/lints release, verifies the compiled manifest, and rejects a release APK that is already signed.

See [the current audit](../docs/SECURITY-AUDIT-2026-11-10.md) and [Bluetooth Direct details](../GLOWSTR_V5_3_BLUETOOTH_DIRECT_README.md).
