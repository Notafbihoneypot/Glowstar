# Glowstr APK signing — owner-held offline Qubes key

Production Android package: org.glowstr.meshbridge
Display name: Glowstr
Target release: versionCode 30, versionName 0.3.18.

This procedure never transfers a private signing key, keystore or keystore password to GitHub, CI, the VPS, or another online device.

## Update compatibility FIRST

A valid Android update needs the same application ID, a higher versionCode, and a certificate accepted by Android (same signer or verified supported signing lineage).

Earlier Glowstr integrated previews use org.glowstr.meshbridge.integrated, while Glowstr debug previews use org.glowstr.meshbridge.debug. These are separate from the production app org.glowstr.meshbridge. Their data is not automatically transferred.

A new private key cannot update an existing APK signed with an unrelated CI/debug key unless an authorized old-to-new signing lineage is created using the **old private key** and the device supports that rotation. The old key may not be recoverable from ephemeral CI runners. If the package IDs differ, signing lineage does not change that: install as a separate application. Back up Nostr seed/private key, settings, and verify your signer/bunker recovery method before uninstalling ANY older app. Android Keystore-encrypted secrets may become unrecoverable after uninstall.

## 1. Build unsigned

On the repository's main branch, run GitHub Actions -> Build Android APK. Download the artifact named Glowstr-Android-Unsigned-Review. It contains:
- app-release-unsigned.apk
- app-release-unsigned.apk.sha256

Verify on the online build machine:

~~~sh
sha256sum -c app-release-unsigned.apk.sha256
~~~

Transfer only the unsigned APK and checksum to a network-disabled Qubes signing qube. Verify SHA-256 again inside the signing qube. A checksum in the same CI artifact authenticates transfer integrity only, not the build's origin.

## 2. Prepare the offline signing qube

Use trusted Android SDK Build Tools (apksigner, zipalign, aapt) and a JDK already installed or transferred and verified from a trusted source. Do not connect the offline key-storage qube to the network. Your pre-existing signer key should be a Java keystore (JKS or PKCS12) holding a private key and public certificate. If you instead created a PKCS#8 private-key and PEM certificate pair, use the apksigner --key/--cert options.

Inspect public signing certificate fingerprint (the keystore password is prompted):

~~~sh
keytool -list -v -keystore /offline/keys/glowstr-release.jks
~~~

## 3. Sign and verify IN OFFLINE QUBES

Edit filenames, keystore path and alias to match what you already created. Do not enter passwords as command-line arguments or paste them into logs.

~~~sh
umask 077
cd /path/to/unsigned-apk
sha256sum -c app-release-unsigned.apk.sha256

zipalign -P 16 -f -v 4 app-release-unsigned.apk Glowstr-0.3.18-aligned.apk

apksigner sign \
  --ks /offline/keys/glowstr-release.jks \
  --ks-key-alias MY_GLOWSTR_ALIAS \
  --out Glowstr-0.3.18.apk \
  Glowstr-0.3.18-aligned.apk

apksigner verify --verbose --print-certs Glowstr-0.3.18.apk
zipalign -c -P 16 -v 4 Glowstr-0.3.18.apk
aapt dump badging Glowstr-0.3.18.apk | head -5
sha256sum Glowstr-0.3.18.apk > Glowstr-0.3.18.apk.sha256
~~~

Check the package is org.glowstr.meshbridge, versionCode at least 30, app label Glowstr, and signer SHA-256 certificate fingerprint exactly matches the keystore's certificate fingerprint.

## 4. Release and update

Transfer ONLY signed APK and checksum back to the online distribution qube. Publish those files in GitHub Releases/decentralized app stores with exact source commit, versionCode, build tool versions and public certificate fingerprint.

Test with adb install -r Glowstr-0.3.18.apk on a noncritical Android device. If INSTALL_FAILED_UPDATE_INCOMPATIBLE occurs, do not force installation. Verify recovery material before uninstalling the old app.

For each following release, increment versionCode (30, 31, ...), keep org.glowstr.meshbridge, and sign with the SAME Qubes private key. Back up your private key encrypted/offline in two separate physical locations and test restoration in an isolated qube. Do not upload keystores or passwords to GitHub Actions.

## 5. Rotation versus migration

True Android APK signing-key rotation needs the old private signing key to generate a proof-of-rotation lineage. Merely renaming the app, using a different keystore, or changing Gradle signingConfigs does not rotate an installed Android app. On Android 13+ APK signature v3.1 supports key rotation; older devices have additional compatibility limitations.

Official guidance:
https://developer.android.com/tools/apksigner
https://source.android.com/docs/security/features/apksigning/v3-1
