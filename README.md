# Glowstr

A privacy-first Nostr client with Monero payments: the bundled client, the Android app that ships it, the Python mesh bridge, and the tests.

Start with [`docs/SECURITY-AUDIT-2026-11-10.md`](docs/SECURITY-AUDIT-2026-11-10.md) for the current security posture and roadmap, and [`docs/GLOWSTR_NET_NIP05.md`](docs/GLOWSTR_NET_NIP05.md) for the `name@glowstr.net` service.

## Android 0.3.22

- New posts appear in Following as soon as a relay accepts them, without waiting for a relay echo or the new-posts buffer. The composer shows when FROSTR is signing and preserves edits made during approval.
- Profile opens the signed-in account directly. Signer settings remain under Keys; profile editing opens on demand.
- Removed the promotional purchase cards from the XMR tab. Wallet tools and tips remain, and relay memberships still live under Relays.

## Project files

- [`glowstr-v5.5-relay-frostr-media.html`](glowstr-v5.5-relay-frostr-media.html): the canonical client; Android tests run against the exact generated shipping asset.
- [`glowstr-v5.3-bluetooth-direct.html`](glowstr-v5.3-bluetooth-direct.html): older client, still read by `deploy/podman/deploy.sh` only. It does not receive fixes.
- [`android-helper/`](android-helper/): native Android Bluetooth bridge source.
- [`glowstr-mesh-bridge.py`](glowstr-mesh-bridge.py): Meshtastic / Reticulum bridge.
- [`GLOWSTR_V5_3_BLUETOOTH_DIRECT_README.md`](GLOWSTR_V5_3_BLUETOOTH_DIRECT_README.md): Bluetooth setup, pairing, API, and limitations.
- [`GLOWSTR_V5_2_MESH_README.md`](GLOWSTR_V5_2_MESH_README.md): Meshtastic / Reticulum setup.

## Build the unsigned Android release

The project requires Android SDK 36, Android Gradle Plugin 8.13.2, Gradle 8.13+, and Java 17. There is no Gradle wrapper.

```sh
gradle -p android-helper :app:assembleRelease
```

The result is `android-helper/app/build/outputs/apk/release/app-release-unsigned.apk`. It is deliberately unsigned; follow [`docs/OFFLINE-APK-SIGNING.md`](docs/OFFLINE-APK-SIGNING.md). The app requires Android 10 or newer.

## Run the included checks

Generate the exact client that the APK embeds, then pass that file to the behavior checks:

```sh
gradle -p android-helper :app:syncGlowstrAsset
CLIENT=android-helper/app/build/generated/glowstrAssets/glowstr.html
python3 tests/run_tests.py "$CLIENT"
node tests/security-regression.cjs "$CLIENT"
node tests/media-wallet-regression.cjs "$CLIENT"
node tests/crypto-regression.cjs "$CLIENT"
python3 tests/test_commerce.py
gradle -p android-helper :app:testReleaseUnitTest :app:lintRelease
```

The workflow also compiles and runs the Java cryptography and native-bridge self-tests. These checks do not replace Bluetooth testing between physical phones.

## Import notes

Imported from the original Bluetooth Direct bundle. `SHA256SUMS` tracks the retained bridge source files; obsolete source is removed rather than preserved as a compatibility path.
