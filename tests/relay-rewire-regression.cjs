'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'glowstr-v5.5-relay-frostr-media.html'), 'utf8');
const gradle = fs.readFileSync(path.join(root, 'android-helper/app/build.gradle'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/android-apk.yml'), 'utf8');

function includes(needle, label) { assert.ok(client.includes(needle), label + ' not found in unified v5.5'); }

includes("relay:'wss://notafbihoneypotrelay.com/'", 'real relay URL');
includes("api:'https://notafbihoneypotrelay.com/xmr-commerce/v1'", 'real commerce API');
includes("target:'notafbihoneypotrelay.com'", 'server-bound target');
includes("glowstrCommerceFetchV54('/features')", 'service feature discovery');
includes("glowstrCommerceFetchV54('/invoices'", 'server-side invoice creation');
includes("headers.Authorization='Bearer '+bearer", 'private invoice status token');
includes("feature: 'nip05_lifetime'", 'NIP-05 product');
includes("USERNAME_REGISTRY.enabled = false", 'NIP-05 disabled on failure');
includes("const GLOWSTR_NIP05_DOMAIN = 'glowstr.net'", 'NIP-05 domain pinned to glowstr.net');
includes("domain !== GLOWSTR_NIP05_DOMAIN", 'commerce server cannot substitute another NIP-05 domain');
includes("['nip05',target]", 'time-limited signed Nostr NIP-05 ownership proof');
includes("proof.pubkey!==state.publicKey", 'proof signer must equal logged-in Nostr account');
includes("body:{pubkey:state.publicKey.toLowerCase(),feature,target,...(proof?{proof}:{})}", 'proof included in server invoice request');
includes("NIP-05 endpoint unavailable", 'NIP-05 verification must work before payment is enabled');
includes("data.nip05!==target", 'invoice target must match requested name');
includes("if (check) check.disabled = true", 'NIP-05 purchase fail-closed');
includes("kind:22242", 'NIP-42 authentication');
includes('frostr-connect-btn', 'FROSTR panel');
includes('function glowstrIsRemoteSignerMethod(', 'FROSTR transport routing');
includes('function glowstrUploadComposeMedia(', 'Media upload draft protection');
includes('id="compose-media-file"', 'Media picker');
includes('name="glowstr-relay-plan"', 'Relay checkout plans');
assert.ok(!client.includes('relay.glowstr.com'), 'Old relay hostname still present');
assert.ok(!client.includes('/api/xmr/'), 'Obsolete Commerce prototype endpoint still present');

const scripts = [...client.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1, 'Expected exactly one protected inline script');
new vm.Script(scripts[0][1], {filename:'glowstr-v5.5-inline.js'});
const hash = crypto.createHash('sha256').update(scripts[0][1]).digest('base64');
assert.ok(client.includes("'sha256-" + hash + "'"), 'Inline script CSP hash is stale');

assert.ok(gradle.includes("from('../../glowstr-v5.5-relay-frostr-media.html')"), 'Android packaging still reads old source');
assert.ok(gradle.includes("applicationIdSuffix '.integrated'"), 'Isolated integrated APK package missing');
assert.ok(gradle.includes('window.glowstrAmberSignForMesh(tpl)'), 'Native Amber NIP-55 relay AUTH path missing');
// Derive the APK version from Gradle, rather than freezing the test at an
// older release number every time the owner-signed production app is updated.
const version = gradle.match(/^\s*versionName\s+'(\d+\.\d+\.\d+)'/m)?.[1];
const code = Number(gradle.match(/^\s*versionCode\s+(\d+)/m)?.[1]);
assert.ok(version && /^\d+\.\d+\.\d+$/.test(version) && code >= 29,
  'Android versionCode/versionName missing or lower than owner-signing baseline');
assert.ok(workflow.includes(':app:assembleIntegrated'), 'Relay-rewire build task not in CI');
assert.ok(workflow.includes(`Glowstr-Android-${version}-integrated.apk`),
  'Integrated preview artifact version does not match Gradle');
assert.ok(workflow.includes('app-release-unsigned.apk'),
  'Owner-signed production workflow must emit an unsigned release');
assert.ok(/signingConfig\s*=\s*null/.test(gradle),
  'Production APK must remain unsigned for offline Qubes signing');
// Tips: private by default, shared payment sheet, one-time addresses.
const tipFn = client.slice(client.indexOf('async function executeXmrTip()'), client.indexOf('function glowstrPaySheetMode('));
assert.ok(tipFn.includes('sendNip17Dm(') && !tipFn.includes('kind: 4') && !tipFn.includes('nip04'), 'Tip notes must be gift-wrapped, never kind-4');
assert.ok(tipFn.includes('glowstrOpenTipSheet(') && !tipFn.includes('glowstrOpenWalletUri('), 'Tips must go through the shared payment sheet');
assert.ok(tipFn.includes('glowstrFetchTipAddress('), 'Tips must try the one-time address endpoint');
includes("redirect:'error', referrerPolicy:'no-referrer', signal:c.signal});\n    if (!r.ok) return '';", 'tip endpoint fetch hardening');
includes("return glowstrIsMoneroSubaddress(address) ? address : '';", 'tip endpoint may only return a subaddress');
includes("html.theme-calm body::before { display: none; }", 'calm theme');
includes('id="appearance-calm-toggle"', 'calm theme switch');
const mainActivity = fs.readFileSync(path.join(root, 'android-helper/app/src/main/java/org/glowstr/meshbridge/MainActivity.java'), 'utf8');
const onCreate = mainActivity.slice(mainActivity.indexOf('protected void onCreate('), mainActivity.indexOf('protected void onResume('));
assert.ok(!/ensureBluetooth|requestPermissions/.test(onCreate), 'No permission prompt at launch');
assert.ok(mainActivity.includes("/v1/mesh/enable") && mainActivity.includes("/v1/notifications/enable"), 'Permissions are requested on demand');
const nip11 = JSON.parse(fs.readFileSync(path.join(root, 'xmr-relay/nip11.example.json'), 'utf8'));
assert.ok(nip11.limitation.payment_required === true && nip11.payments_url && nip11.fees.subscription.length, 'NIP-11 must advertise price and payment URL');
console.log('Glowstr v5.5 relay, checkout, NIP-05, FROSTR, media, CSP and APK build wiring OK');
