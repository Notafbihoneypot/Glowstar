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
    '<string name="main_create_group_subtitle">Create a threshold identity and store this device\\\'s share securely</string>',
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


# Add the advanced offline trusted-dealer setup to the FROST identity screen.
create_group = root / "app" / "src" / "main" / "kotlin" / "io" / "privkey" / "keep" / "CreateGroupScreen.kt"
cg = create_group.read_text(encoding="utf-8")

cg = cg.replace(
    "import androidx.compose.ui.text.font.FontFamily\n",
    "import androidx.compose.ui.text.font.FontFamily\n"
    "import androidx.compose.ui.text.input.PasswordVisualTransformation\n"
    "import androidx.compose.foundation.text.KeyboardOptions\n"
    "import androidx.compose.ui.text.input.KeyboardType\n"
    "import io.privkey.keep.uniffi.FrostGenerationResult\n"
    "import io.privkey.keep.uniffi.KeepMobile\n"
    "import io.privkey.keep.uniffi.hexToNpub\n"
    "import kotlinx.coroutines.Dispatchers\n"
    "import kotlinx.coroutines.launch\n"
    "import kotlinx.coroutines.withContext\n"
    "import java.util.Arrays\n",
    1,
)

old_sig = """fun CreateGroupScreen(
    relays: List<String>,
"""
new_sig = """fun CreateGroupScreen(
    keepMobile: KeepMobile,
    relays: List<String>,
"""
if old_sig not in cg:
    raise SystemExit("CreateGroupScreen signature not found")
cg = cg.replace(old_sig, new_sig, 1)

old_mode = """    var isJoinMode by remember { mutableStateOf(false) }
"""
new_mode = """    var setupMode by remember { mutableStateOf(GroupSetupMode.DISTRIBUTED) }
"""
if old_mode not in cg:
    raise SystemExit("CreateGroupScreen mode state not found")
cg = cg.replace(old_mode, new_mode, 1)

old_tabs = """        SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
            SegmentedButton(
                selected = !isJoinMode,
                onClick = { isJoinMode = false },
                shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2)
            ) {
                Text(stringResource(R.string.create_group_mode_start))
            }
            SegmentedButton(
                selected = isJoinMode,
                onClick = { isJoinMode = true },
                shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2)
            ) {
                Text(stringResource(R.string.create_group_mode_join))
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        if (isJoinMode) {
            JoinGroupMode(onDkgBegin = onDkgBegin, runDkg = runDkg)
        } else {
            StartGroupMode(relays = relays, onDkgBegin = onDkgBegin, runDkg = runDkg)
        }
"""
new_tabs = """        SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
            SegmentedButton(
                selected = setupMode == GroupSetupMode.DISTRIBUTED,
                onClick = { setupMode = GroupSetupMode.DISTRIBUTED },
                shape = SegmentedButtonDefaults.itemShape(index = 0, count = 3)
            ) {
                Text(stringResource(R.string.create_group_mode_start))
            }
            SegmentedButton(
                selected = setupMode == GroupSetupMode.JOIN,
                onClick = { setupMode = GroupSetupMode.JOIN },
                shape = SegmentedButtonDefaults.itemShape(index = 1, count = 3)
            ) {
                Text(stringResource(R.string.create_group_mode_join))
            }
            SegmentedButton(
                selected = setupMode == GroupSetupMode.OFFLINE,
                onClick = { setupMode = GroupSetupMode.OFFLINE },
                shape = SegmentedButtonDefaults.itemShape(index = 2, count = 3)
            ) {
                Text(stringResource(R.string.igloo_offline_tab))
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        when (setupMode) {
            GroupSetupMode.DISTRIBUTED ->
                StartGroupMode(relays = relays, onDkgBegin = onDkgBegin, runDkg = runDkg)
            GroupSetupMode.JOIN ->
                JoinGroupMode(onDkgBegin = onDkgBegin, runDkg = runDkg)
            GroupSetupMode.OFFLINE ->
                OfflineGroupMode(keepMobile = keepMobile)
        }
"""
if old_tabs not in cg:
    raise SystemExit("CreateGroupScreen tabs block not found")
cg = cg.replace(old_tabs, new_tabs, 1)

offline_code = r'''
private enum class GroupSetupMode { DISTRIBUTED, JOIN, OFFLINE }

@Composable
private fun OfflineGroupMode(keepMobile: KeepMobile) {
    val scope = rememberCoroutineScope()
    val passphrase = remember { SecurePassphrase() }
    val confirmPassphrase = remember { SecurePassphrase() }
    var passphraseDisplay by remember { mutableStateOf("") }
    var confirmPassphraseDisplay by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("Offline FROST") }
    var threshold by remember { mutableIntStateOf(2) }
    var participants by remember { mutableIntStateOf(3) }
    var acknowledged by remember { mutableStateOf(false) }
    var generating by remember { mutableStateOf(false) }
    var generationResult by remember { mutableStateOf<FrostGenerationResult?>(null) }
    var selectedShare by remember { mutableIntStateOf(0) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            passphrase.clear()
            confirmPassphrase.clear()
            passphraseDisplay = ""
            confirmPassphraseDisplay = ""
            generationResult = null
        }
    }

    val generated = generationResult
    if (generated != null) {
        val share = generated.shares[selectedShare]
        val frames by produceState<List<String>?>(initialValue = null, key1 = share.exportData) {
            value = withContext(Dispatchers.Default) {
                runCatching {
                    io.privkey.keep.uniffi.generateAnimatedFrames(share.exportData, 600u)
                }.getOrElse { listOf(share.exportData) }
            }
        }

        StatusCard(
            text = stringResource(R.string.igloo_offline_generated_warning),
            containerColor = MaterialTheme.colorScheme.tertiaryContainer,
            contentColor = MaterialTheme.colorScheme.onTertiaryContainer
        )
        Spacer(modifier = Modifier.height(16.dp))

        val npub = remember(generated.groupPubkey) {
            hexToNpub(generated.groupPubkey) ?: generated.groupPubkey
        }
        NpubDisplay(npub)

        Spacer(modifier = Modifier.height(16.dp))
        Text(
            stringResource(
                R.string.igloo_offline_share_position,
                selectedShare + 1,
                generated.shares.size,
                share.shareIndex.toInt()
            ),
            style = MaterialTheme.typography.titleMedium
        )
        Spacer(modifier = Modifier.height(12.dp))

        val readyFrames = frames
        if (readyFrames == null) {
            CircularProgressIndicator()
        } else if (readyFrames.size > 1) {
            AnimatedQrCodeDisplay(
                frames = readyFrames,
                label = stringResource(R.string.igloo_offline_share_qr, share.shareIndex.toInt()),
                fullData = share.exportData
            )
        } else {
            QrCodeDisplay(
                data = share.exportData,
                label = stringResource(R.string.igloo_offline_share_qr, share.shareIndex.toInt())
            )
        }

        Spacer(modifier = Modifier.height(16.dp))
        Text(
            stringResource(R.string.igloo_offline_transfer_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.height(16.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            OutlinedButton(
                onClick = { if (selectedShare > 0) selectedShare-- },
                enabled = selectedShare > 0,
                modifier = Modifier.weight(1f)
            ) {
                Text(stringResource(R.string.igloo_offline_previous))
            }
            Button(
                onClick = {
                    if (selectedShare < generated.shares.lastIndex) selectedShare++
                },
                enabled = selectedShare < generated.shares.lastIndex,
                modifier = Modifier.weight(1f)
            ) {
                Text(stringResource(R.string.igloo_offline_next))
            }
        }

        Spacer(modifier = Modifier.height(8.dp))
        OutlinedButton(
            onClick = {
                generationResult = null
                selectedShare = 0
                acknowledged = false
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(stringResource(R.string.igloo_offline_finish))
        }
        return
    }

    StatusCard(
        text = stringResource(R.string.igloo_offline_warning),
        containerColor = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer
    )
    Spacer(modifier = Modifier.height(16.dp))

    OutlinedTextField(
        value = name,
        onValueChange = { if (it.length <= MAX_ACCOUNT_NAME_LENGTH) name = it },
        label = { Text(stringResource(R.string.create_group_name_label)) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true
    )

    Spacer(modifier = Modifier.height(16.dp))

    Stepper(
        label = stringResource(R.string.create_group_threshold_label, threshold),
        decrementDescription = stringResource(R.string.create_group_threshold_decrement),
        incrementDescription = stringResource(R.string.create_group_threshold_increment),
        onDecrement = { if (threshold > 2) threshold-- },
        onIncrement = { if (threshold < participants) threshold++ },
        canDecrement = threshold > 2,
        canIncrement = threshold < participants
    )

    Spacer(modifier = Modifier.height(8.dp))

    Stepper(
        label = stringResource(R.string.create_group_participants_label, participants),
        decrementDescription = stringResource(R.string.create_group_participants_decrement),
        incrementDescription = stringResource(R.string.create_group_participants_increment),
        onDecrement = {
            if (participants > 2) {
                participants--
                if (threshold > participants) threshold = participants
            }
        },
        onIncrement = { if (participants < 8) participants++ },
        canDecrement = participants > 2,
        canIncrement = participants < 8
    )

    Spacer(modifier = Modifier.height(16.dp))

    OutlinedTextField(
        value = passphraseDisplay,
        onValueChange = {
            passphrase.update(it)
            passphraseDisplay = it
            errorMessage = null
        },
        label = { Text(stringResource(R.string.igloo_offline_passphrase)) },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        singleLine = true,
        modifier = Modifier.fillMaxWidth()
    )

    Spacer(modifier = Modifier.height(12.dp))

    OutlinedTextField(
        value = confirmPassphraseDisplay,
        onValueChange = {
            confirmPassphrase.update(it)
            confirmPassphraseDisplay = it
            errorMessage = null
        },
        label = { Text(stringResource(R.string.igloo_offline_confirm_passphrase)) },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
        isError = confirmPassphrase.length > 0 && !passphrase.contentEquals(confirmPassphrase)
    )

    Spacer(modifier = Modifier.height(12.dp))

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth()
    ) {
        Checkbox(
            checked = acknowledged,
            onCheckedChange = { acknowledged = it }
        )
        Text(
            stringResource(R.string.igloo_offline_acknowledge),
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f)
        )
    }

    if (errorMessage != null) {
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            errorMessage!!,
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall
        )
    }

    Spacer(modifier = Modifier.height(16.dp))

    Button(
        onClick = {
            when {
                name.isBlank() -> errorMessage = "Name is required"
                passphrase.length < 15 -> errorMessage = "Use a passphrase of at least 15 characters"
                !passphrase.contentEquals(confirmPassphrase) -> errorMessage = "Passphrases do not match"
                !acknowledged -> errorMessage = "Confirm the offline-generation warning first"
                else -> {
                    val passphraseChars = passphrase.toCharArray()
                    generating = true
                    errorMessage = null
                    scope.launch {
                        try {
                            val result = withContext(Dispatchers.Default) {
                                keepMobile.frostGenerate(
                                    threshold.toUShort(),
                                    participants.toUShort(),
                                    name.trim(),
                                    String(passphraseChars)
                                )
                            }
                            generationResult = result
                            selectedShare = 0
                            passphrase.clear()
                            confirmPassphrase.clear()
                            passphraseDisplay = ""
                            confirmPassphraseDisplay = ""
                        } catch (e: Exception) {
                            if (BuildConfig.DEBUG) {
                                Log.e("OfflineFrost", "Trusted-dealer generation failed: \${e::class.simpleName}")
                            }
                            errorMessage = "Offline share generation failed"
                        } finally {
                            Arrays.fill(passphraseChars, '\u0000')
                            generating = false
                        }
                    }
                }
            }
        },
        enabled = !generating,
        modifier = Modifier.fillMaxWidth()
    ) {
        if (generating) {
            CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                strokeWidth = 2.dp
            )
            Spacer(modifier = Modifier.width(8.dp))
        }
        Text(stringResource(R.string.igloo_offline_generate))
    }

    Spacer(modifier = Modifier.height(8.dp))
    Text(
        stringResource(R.string.igloo_offline_recommendation),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}

'''
marker = "private enum class CoordPhase { Form, Collect, Ready }\n"
if marker not in cg:
    raise SystemExit("CoordPhase marker not found")
cg = cg.replace(marker, offline_code + marker, 1)
create_group.write_text(cg, encoding="utf-8")

main_activity = root / "app" / "src" / "main" / "kotlin" / "io" / "privkey" / "keep" / "MainActivity.kt"
ma = main_activity.read_text(encoding="utf-8")
old_call = """        CreateGroupScreen(
            relays = groupRelays,
"""
new_call = """        CreateGroupScreen(
            keepMobile = keepMobile,
            relays = groupRelays,
"""
if old_call not in ma:
    raise SystemExit("MainActivity CreateGroupScreen call not found")
main_activity.write_text(ma.replace(old_call, new_call, 1), encoding="utf-8")

share_strings = root / "app" / "src" / "main" / "res" / "values" / "strings_share.xml"
ss = share_strings.read_text(encoding="utf-8")
offline_strings = """
    <!-- Igloo Mobile advanced offline trusted-dealer setup -->
    <string name="igloo_offline_tab">Offline</string>
    <string name="igloo_offline_warning">Advanced setup: this phone temporarily generates the complete threshold key material and every share. Use an offline, trusted device. Distributed setup is safer because no single device ever holds the whole key.</string>
    <string name="igloo_offline_passphrase">Share export passphrase</string>
    <string name="igloo_offline_confirm_passphrase">Confirm passphrase</string>
    <string name="igloo_offline_acknowledge">I understand this device temporarily creates all shares and must be trusted during generation.</string>
    <string name="igloo_offline_generate">Generate encrypted shares offline</string>
    <string name="igloo_offline_recommendation">Recommended: keep this phone offline during generation, transfer each encrypted share to a different signer, verify the backups, then remove any exported share copies left on the generating device.</string>
    <string name="igloo_offline_generated_warning">Generation complete. Save every required share before leaving this screen. The same passphrase protects each exported share.</string>
    <string name="igloo_offline_share_position">Share %1$d of %2$d · FROST index %3$d</string>
    <string name="igloo_offline_share_qr">Encrypted FROST share %1$d</string>
    <string name="igloo_offline_transfer_hint">Scan this QR on the signer that should hold this share. Animated QR frames cycle automatically when the encrypted export is too large for one QR.</string>
    <string name="igloo_offline_previous">Previous share</string>
    <string name="igloo_offline_next">Next share</string>
    <string name="igloo_offline_finish">Clear generated shares from this screen</string>
"""
if "</resources>" not in ss:
    raise SystemExit("strings_share.xml missing resources terminator")
share_strings.write_text(ss.replace("</resources>", offline_strings + "</resources>", 1), encoding="utf-8")

print("Igloo Mobile overlay applied successfully")
