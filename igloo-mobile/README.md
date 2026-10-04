# Igloo Mobile (Rust/Android prototype)

This directory builds an Android threshold signer for Glowstr by applying a small, auditable overlay to the upstream Keep Android signer and its pinned Rust core.

## Why this base

Upstream Keep Android already provides the security-sensitive pieces needed for the first Igloo Mobile milestone:

- FROST distributed key generation (DKG) on Android
- 2-of-3, 3-of-5 and custom threshold groups
- Rust signing core via UniFFI/JNI
- Android Keystore + biometric-protected share storage
- FROST share QR import/export
- NIP-46 bunker remote signing
- NIP-55 Android signer support
- NIP-44 encryption/decryption
- signing permissions, audit history and kill switch

The overlay deliberately does **not** reimplement FROST cryptography.

## Pinned upstream revisions

- Keep Android: `f0db28aa218f18b71be60e3b1cf39eb51705e791`
- Keep Rust core: `d9192f5801949700dbefff2c9634b0fe904edf9e`

The Android repository itself pins the same Rust core in `keep.version`. CI verifies the pin before building.

## Milestone 1

1. Install Igloo Mobile beside Glowstr.
2. Configure at least one secure `wss://` FROST relay.
3. Choose **Create FROST Identity**.
4. Start a 2-of-3 ceremony.
5. Each signer device generates its own DKG subkey locally.
6. Exchange setup/subkey/roster QR codes between the devices.
7. Run the DKG. Each Android device stores only its resulting share.
8. Enable **NIP-46 Bunker** in Igloo Mobile.
9. Show/copy the `bunker://` URL.
10. In Glowstr, open **FROSTR THRESHOLD SIGNER**, enter the resulting account npub and the bunker URL, then connect.

## Security model

The recommended setup is distributed DKG: each signer generates its contribution on the device that will hold that share. No phone should generate all threshold shares in the normal flow.

Glowstr receives a NIP-46 signer session, not the FROST share. Losing the NIP-46 session does not reveal the threshold share.

This prototype keeps the upstream cryptographic implementation pinned and only changes branding/package identity and a few user-facing labels. A later milestone can add a Glowstr-specific guided setup flow without moving cryptography into the client.

## Compatibility note

Keep's share export format is `kshare1...`. We have **not** established byte-for-byte compatibility with Bifrost/Igloo `bfshare1...` or `bfgroup1...` encodings. For the first milestone, interoperability with Glowstr is through NIP-46, which avoids depending on share-file format compatibility.

## Build

The GitHub workflow `.github/workflows/igloo-mobile-android.yml` clones the pinned upstream sources, applies `apply-overlay.py`, builds the Rust core for ARM64 Android, builds the APK, verifies its signature, and publishes a prerelease APK.

The upstream projects are MIT licensed. See `THIRD_PARTY_NOTICES.md`.
