# Focused Android security / release engineering review — 2026-11-03

**Scope reviewed:** Glowstr Android Gradle configuration, CI release workflow, manifest, MainActivity WebView, TrustedWebContent, AndroidBridge sensitive local-signer storage, Android security regression tests; Frost bunker overlay, pinned upstream Keep Android Gradle/manifest and NIP-55 exported content provider, and Android CI.

This is a focused **static** code review, NOT a complete security audit, end-to-end signed APK test, dependency/cryptographic audit, fuzzing, or penetration test. None of the new CI builds or offline signed APKs were executed as part of this review. Production release readiness remains conditional on green CI and real test-device validation.

## Findings and changes

1. **High — private signing key on CI was an available option (Glowstr): mitigated.** The Android GitHub workflow could accept a base64 keystore in GitHub Secrets and produce a signed release. Removed that job and release signing environment plumbing. Gradle release now requires an unsigned artifact, signed later by the owner's network-disabled Qubes key.
2. **High — Frost release fell back to DEBUG signing: mitigated in overlay.** Pinned Keep Android app Gradle chose the debug signing config if no release config was present. The overlay now explicitly sets release signingConfig to null and fails if the upstream anchor changes. CI verifies the resulting release artifact is unsigned and no longer publishes a debug-signed APK as a GitHub prerelease.
3. **High — signing identity continuity and upgrade break: NOT solvable in build code alone.** Existing debug-signed app cannot generally be updated by an unrelated owner signing key. Glowstr integrated preview uses a distinct package suffix. Preserve user credentials, Nostr identity, and FROST share backups; migrate only with verified restore and test-device checks. See per-repo offline signing guides.
4. **Positive — Glowstr WebView scope and backup policy.** WebView debugging disabled, file:// access disabled, mixed content blocked. Native JavaScript bridge methods require a secret capability and trusted bundled document source. App backups disabled. Remaining concern: any exploitable untrusted-event HTML/XSS in the bundled 800+ KB client can potentially exercise native exposed API in that WebView. Audit all rendering/sanitization, inputs, URLs, third-party JS, and internal-bridge origin controls as a separate security task.
5. **Positive — Frost upstream core guardrails.** Pinned Keep Android manifest disables backups, approval UI is not exported, and exported NIP-55 signing provider verifies calling UID/package/signature through CallerVerificationStore; it checks kill switch and rate limiter before processing. Revalidate all provider call and approval policy flows after the overlay.
6. **Medium — signing in hardware-token vs keystore format.** A raw OpenSSH/FIDO2 credential cannot be used directly by apksigner. The owner must have a supported JKS/PKCS12 signer or compatible PKCS#8 key + certificate; hardware-backed signing may require a PKCS#11-supported integration. Do not downgrade to an online/exported secret.
7. **Medium — CI artifact provenance.** A SHA-256 generated beside an unsigned artifact protects against accidental transfer corruption, not a compromised CI runner/source/dependency. Pin and independently review build dependencies, use a trusted signing qube, and independently verify release fingerprints; reproducible builds/build attestations are a future step.
8. **Medium — test-only applications and versioning.** Debug preview variants have separate app IDs and different signing keys; users should not confuse those QA APKs with owner-signed production updates. Build workflows still produce QA artifacts, but automatic publication as signed production releases has been disabled.

## Required verification before production distribution

- Both modified GitHub Actions workflows finish green and release APKs are positively verified **unsigned**.
- Confirm manifest app IDs, visible labels and version codes on the produced binaries. Glowstr production: org.glowstr.meshbridge, versionCode 30. Frost bunker: org.glowstr.igloomobile, base versionCode 2 with ARM64 split-specific derived versionCode.
- Test signing verification and zip alignment entirely inside network-disabled Qubes; public certificate SHA-256 fingerprints match offline keystore and published signed APKs.
- Test Frost group restore and recovery with a throwaway identity; verify share export/import and NIP-46/55 approval, rejection, crash/back, biometric lockout and notification behavior on actual GrapheneOS.
- Test Glowstr NIP-42 public and paid relay auth, CORS invoice flow, signer persistence, media picker, Bluetooth/mesh, and no cleartext secret persistence.
- Verify update compatibility (same app ID, owner certificate, and higher versionCode) on a sacrificial test device before distribution.
- No signing secrets or private FROST share material in Git commits, Actions secrets, release assets, log output, chat or support tickets.

See Android signing docs: https://developer.android.com/tools/apksigner
