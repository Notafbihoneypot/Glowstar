# Glowstr v5.3 — Bluetooth Direct

This repository contains the complete Glowstr v5.3 source bundle: the Nostr web client, the Android Bluetooth companion, the Python mesh bridge, and the included tests.

## Project files

- [`glowstr-v5.3-bluetooth-direct.html`](glowstr-v5.3-bluetooth-direct.html): web client.
- [`crosspost/`](crosspost/): connected-identity publishing for Bluesky, Mastodon, X, and Mastodon-compatible ActivityPub accounts, with optional Nostr output and Monero membership checks.
- [`android-helper/`](android-helper/): native Android Bluetooth bridge source.
- [`glowstr-mesh-bridge.py`](glowstr-mesh-bridge.py): Meshtastic / Reticulum bridge.
- [`GLOWSTR_V5_3_BLUETOOTH_DIRECT_README.md`](GLOWSTR_V5_3_BLUETOOTH_DIRECT_README.md): Bluetooth setup, pairing, API, and limitations.
- [`GLOWSTR_V5_2_MESH_README.md`](GLOWSTR_V5_2_MESH_README.md): Meshtastic / Reticulum setup.

## Build the Android companion

Open `android-helper/` in Android Studio. The project declares Android SDK 36, Android Gradle Plugin 8.13.2, and Java 17. There is no Gradle wrapper included in this source bundle.

With the Android SDK and a compatible system Gradle installed:

```sh
cd android-helper
sh build-debug.sh
```

The debug APK is generated at `android-helper/app/build/outputs/apk/debug/app-debug.apk`, relative to the repository root. The companion requires Android 10 or newer.

## Run the included checks

The static checks and protocol simulation require Python 3 and Node.js:

```sh
python3 tests/run_tests.py
```

The Java cryptography self-test requires JDK 17 or newer:

```sh
mkdir -p android-helper/build/crypto-tests
javac -encoding UTF-8 -d android-helper/build/crypto-tests \
  android-helper/app/src/main/java/org/glowstr/meshbridge/NostrCrypto.java \
  tests/java/org/glowstr/meshbridge/NostrCryptoSelfTest.java
java -cp android-helper/build/crypto-tests org.glowstr.meshbridge.NostrCryptoSelfTest
```

`tests/final-results.txt` contains results supplied with the original bundle. Static checks and simulations do not replace a full Android build or testing Bluetooth between physical phones.

## Import notes

Imported from `glowstr-v5.3-bluetooth-direct-bundle.zip`. Its Android source matches `glowstr-bluetooth-direct-android-source.zip` byte for byte. The test runner paths have been made relative to this checkout; application source files remain as supplied. `SHA256SUMS` records the supplied checksums for the client and bridge sources.
