#!/usr/bin/env python3
"""Apply the minimal Igloo Mobile overlay to a pinned Keep Android checkout."""

from __future__ import annotations

import pathlib
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: apply-overlay.py /path/to/keep-android")

root = pathlib.Path(sys.argv[1]).resolve()
if not (root / "app" / "build.gradle.kts").is_file():
    raise SystemExit(f"not a Keep Android checkout: {root}")

EXPECTED_KEEP = "d9192f5801949700dbefff2c9634b0fe904edf9e"
actual_keep = (root / "keep.version").read_text(encoding="utf-8").strip()
if actual_keep != EXPECTED_KEEP:
    raise SystemExit(f"unexpected keep.version: {actual_keep}; expected {EXPECTED_KEEP}")


def replace_once(path: pathlib.Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match for {old!r}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


gradle = root / "app" / "build.gradle.kts"
replace_once(gradle, 'applicationId = "io.privkey.keep"', 'applicationId = "org.glowstr.igloomobile"')
replace_once(gradle, 'versionCode = 28', 'versionCode = 1')
replace_once(gradle, 'versionName = "1.2.0"', 'versionName = "0.1.0-test"')
replace_once(
    gradle,
    'include("arm64-v8a", "x86_64")',
    'include("arm64-v8a")',
)

strings = root / "app" / "src" / "main" / "res" / "values" / "strings.xml"
replace_once(
    strings,
    '<string name="app_name" translatable="false">Keep</string>',
    '<string name="app_name" translatable="false">Igloo Mobile</string>',
)
replace_once(
    strings,
    '<string name="foreground_service_title" translatable="false">Keep</string>',
    '<string name="foreground_service_title" translatable="false">Igloo Mobile</string>',
)
replace_once(
    strings,
    '<string name="bunker_service_title" translatable="false">Keep Bunker</string>',
    '<string name="bunker_service_title" translatable="false">Igloo Mobile Bunker</string>',
)
replace_once(
    strings,
    '<string name="biometric_unlock_title" translatable="false">Keep</string>',
    '<string name="biometric_unlock_title" translatable="false">Igloo Mobile</string>',
)

main_strings = root / "app" / "src" / "main" / "res" / "values" / "strings_main.xml"
replace_once(
    main_strings,
    '<string name="main_unlock_title">Unlock Keep</string>',
    '<string name="main_unlock_title">Unlock Igloo Mobile</string>',
)
replace_once(
    main_strings,
    '<string name="main_home_title">Keep</string>',
    '<string name="main_home_title">Igloo Mobile</string>',
)
replace_once(
    main_strings,
    '<string name="main_create_group_title">Create Signing Group</string>',
    '<string name="main_create_group_title">Create FROST Identity</string>',
)
replace_once(
    main_strings,
    '<string name="main_create_group_subtitle">Authenticate to store share securely</string>',
    '<string name="main_create_group_subtitle">Create a threshold identity and store this device\'s share securely</string>',
)
replace_once(
    main_strings,
    '<string name="main_create_account_button">Create Account</string>',
    '<string name="main_create_account_button">Create single-key account (advanced)</string>',
)

manifest = root / "app" / "src" / "main" / "AndroidManifest.xml"
text = manifest.read_text(encoding="utf-8")
old = 'android:authorities="io.privkey.keep.GET_PUBLIC_KEY;io.privkey.keep.SIGN_EVENT;io.privkey.keep.NIP04_ENCRYPT;io.privkey.keep.NIP04_DECRYPT;io.privkey.keep.NIP44_ENCRYPT;io.privkey.keep.NIP44_DECRYPT;io.privkey.keep.DECRYPT_ZAP_EVENT;io.privkey.keep.NIP44_V3_ENCRYPT;io.privkey.keep.NIP44_V3_DECRYPT"'
new = 'android:authorities="${applicationId}.GET_PUBLIC_KEY;${applicationId}.SIGN_EVENT;${applicationId}.NIP04_ENCRYPT;${applicationId}.NIP04_DECRYPT;${applicationId}.NIP44_ENCRYPT;${applicationId}.NIP44_DECRYPT;${applicationId}.DECRYPT_ZAP_EVENT;${applicationId}.NIP44_V3_ENCRYPT;${applicationId}.NIP44_V3_DECRYPT"'
if text.count(old) != 1:
    raise SystemExit("AndroidManifest.xml: unexpected NIP-55 provider authorities")
manifest.write_text(text.replace(old, new, 1), encoding="utf-8")

print("Igloo Mobile overlay applied successfully")
