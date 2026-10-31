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
includes("if (check) check.disabled = true", 'NIP-05 purchase fail-closed');
includes("kind:22242", 'NIP-42 authentication');
includes('frostr-connect-btn', 'FROSTR panel');
includes('function glowstrIsRemoteSignerMethod(', 'FROSTR transport routing');
includes('function glowstrUploadComposeMedia(', 'Media upload draft protection');
includes('id="compose-media-file"', 'Media picker');
includes("name='glowstr-relay-plan'", 'Relay checkout plans');
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
assert.ok(gradle.includes("versionName '0.3.16'"), 'Android version not updated');
assert.ok(workflow.includes(':app:assembleIntegrated'), 'Relay-rewire build task not in CI');
assert.ok(workflow.includes('Glowstr-Android-0.3.16-integrated.apk'), 'APK artifact not in CI');
console.log('Glowstr v5.5 relay, checkout, NIP-05, FROSTR, media, CSP and APK build wiring OK');
