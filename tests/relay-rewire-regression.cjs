'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'glowstr-v5.4-relay-domain-secure.html'), 'utf8');
const gradle = fs.readFileSync(path.join(root, 'android-helper/app/build.gradle'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/android-apk.yml'), 'utf8');

function includes(needle, label) { assert.ok(client.includes(needle), label + ' not found in v5.4'); }

includes("relay:'wss://notafbihoneypotrelay.com/'", 'real relay URL');
includes("api:'https://notafbihoneypotrelay.com/xmr-commerce/v1'", 'real commerce API');
includes("target:'notafbihoneypotrelay.com'", 'server-bound target');
includes("glowstrCommerceFetchV54('/features')", 'service feature discovery');
includes("glowstrCommerceFetchV54('/invoices'", 'server-side invoice creation');
includes("headers.Authorization='Bearer '+bearer", 'private invoice status token');
includes("feature: 'nip05_lifetime'", 'NIP-05 product');
includes("USERNAME_REGISTRY.enabled = false", 'NIP-05 disabled on failure');
includes("if (check) check.disabled = true", 'NIP-05 purchase fail-closed');
includes("kind:22242", 'NIP-42 authentication');
assert.ok(!client.includes('relay.glowstr.com'), 'Old relay hostname still present');
assert.ok(!client.includes('/api/xmr/'), 'Obsolete Commerce prototype endpoint still present');

const scripts = [...client.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1, 'Expected exactly one protected inline script');
new vm.Script(scripts[0][1], {filename:'glowstr-v5.4-inline.js'});
const hash = crypto.createHash('sha256').update(scripts[0][1]).digest('base64');
assert.ok(client.includes("'sha256-" + hash + "'"), 'Inline script CSP hash is stale');

assert.ok(gradle.includes("from('../../glowstr-v5.4-relay-domain-secure.html')"), 'Android packaging still reads old source');
assert.ok(gradle.includes("applicationIdSuffix '.relayrewire'"), 'Isolated APK package missing');
assert.ok(gradle.includes("versionName '0.3.15'"), 'Android version not updated');
assert.ok(workflow.includes(':app:assembleRelayrewire'), 'Relay-rewire build task not in CI');
assert.ok(workflow.includes('Glowstr-Android-0.3.15-relayrewire.apk'), 'APK artifact not in CI');
console.log('Glowstr v5.4 relay, checkout, NIP-05 gating, CSP and APK build wiring OK');
