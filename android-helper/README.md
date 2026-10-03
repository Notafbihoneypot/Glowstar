# Glowstr Bluetooth Bridge — Android helper

Small native Android companion for Glowstr Bluetooth Direct. It bundles the FOSS ZXing QR scanner and does not use Google Play Services.

Open this directory in Android Studio and build `app`.

See the top-level `GLOWSTR_V5_3_BLUETOOTH_DIRECT_README.md` in the complete bundle for pairing, security model, and testing details.

## Security and production builds

Release builds are explicitly non-debuggable. The workflow builds and checks an
unsigned release APK for pull requests; it no longer publishes debug APKs to
GitHub Releases. An unsigned APK is a review artifact and cannot be installed.

For a signed build, configure the `android-release` GitHub environment with a
protected-branch deployment policy and these secrets:

- `GLOWSTR_RELEASE_KEYSTORE_BASE64`: your stable production keystore, base64 encoded
- `GLOWSTR_RELEASE_STORE_PASSWORD`
- `GLOWSTR_RELEASE_KEY_ALIAS`
- `GLOWSTR_RELEASE_KEY_PASSWORD`

Run **Build Android APK** from the protected release branch with `signed` enabled.
The signed APK is uploaded as an Actions artifact. Publication is a separate
maintainer action. Missing signing configuration fails the signed build; the
workflow never substitutes the Android debug key.

For local signing, set `GLOWSTR_RELEASE_STORE_FILE` to the keystore path and the
three password/alias variables above. Set `GLOWSTR_REQUIRE_RELEASE_SIGNING=true`
and run `gradle :app:assembleRelease`. Keep the signing key backed up privately;
updates must use the same package and signing certificate.

The previous distributed app used `org.glowstr.meshbridge.debug`; production uses
`org.glowstr.meshbridge`. They install side by side and cannot share app-private
storage or Keystore records. Before removing the old app, preserve your local-key
backup or signer access, then reconnect the same identity in the production app.
Do not uninstall the only remaining copy of a local key.

The WebView only loads the bundled document. Every native method requires a fresh
256-bit capability available to its main script; remote frames are blocked and
external links open outside the WebView. Local nsec login still intentionally puts
the key in the trusted main script's memory. Use an external signer, including
[FROSTR](../docs/FROSTR.md), to keep the account key outside the renderer.

Android backups and device transfers exclude app data. Secure local signer
persistence is retained; a switch to an external signer removes stale local-key
records. FROSTR client transport sessions use authenticated Keystore encryption.

Run `python3 tests/run_tests.py`, `node tests/security-regression.cjs`, and
`python3 tests/test_commerce.py` from the repository root. The workflow also runs
Java crypto/bridge self-tests, `assembleRelease`, `lintRelease`, and a compiled
manifest check.
