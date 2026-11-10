'use strict';
// Guards the bundled secp256k1 / BIP-340 code: official vectors, sign/verify
// round trips, tamper rejection, and curve edge cases.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '../glowstr-v5.5-relay-frostr-media.html'), 'utf8');
function section(a, b) { const i = html.indexOf(a), j = html.indexOf(b, i); assert.ok(i >= 0 && j > i, 'missing ' + a); return html.slice(i, j); }
const src = section('function hexToBytes(hex)', 'function preloadCrypto()') +
  section('// BIP-340 Schnorr verify', '// Defensive relay event validation.') +
  ';globalThis.api={verifyEvent,verifySchnorrSig,signNostrEvent,derivePublicKey,_pointMul,_pointAdd,_modInv,_G,_N,_P};';
const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, console });
vm.runInContext(src, ctx);
const c = ctx.api;
const M = '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89';
const PK = 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659';
const vectors = [
  ['f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9', '0'.repeat(64), 'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0', true],
  [PK, M, '6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de33418906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a', true],
  ['dd308afec5777e13121fa72b9cc1b7cc0139715309b086c960e18fd969774eb8', '7e2d58d8b3bcdf1abadec7829054f90dda9805aab56c77333024b9d0a508b75c', '5831aaeed7b44bb74e5eab94ba9d4294c49bcf2a60728d8b4c200f50dd313c1bab745879a5ad954a72c45a91c3a51d3c7adea98d82f8481e0e1e03674a6f3fb7', true],
  ['d69c3509bb99e412e68b0fe8544e72837dfa30746d8be2aa65975f29d22dc7b9', '4df3c3f68fcc83b27e9d42c90431a72499f17875c81a599b566c9889b9696703', '00000000000000000000003b78ce563f89a0ed9414f5aa28ad0d96d6795f9c6376afb1548af603b3eb45c9f8207dee1060cb71c04e80f593060b07d28308d7f4', true],
  ['eefdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34', M, '6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e17776969e89b4c5564d00349106b8497785dd7d1d713a8ae82b32fa79d5f7fc407d39b', false], // key not on curve
  [PK, M, 'fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a14602975563cc27944640ac607cd107ae10923d9ef7a73c643e166be5ebeafa34b1ac553e2', false], // odd R.y
  [PK, M, '1fa62e331edbc21c394792d2ab1100a7b432b013df3f6ff4f99fcb33e0e1515f28890b3edb6e7189b630448b515ce4f8622a954cfe545735aaea5134fccdb2bd', false], // negated message
  [PK, M, '6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e177769961764b3aa9b2ffcb6ef947b6887a226e8d7c93e00c5ed0c1834ff0d0c2e6da6', false], // negated s
  [PK, M, '6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e177769fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', false], // s == n
  ['fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc30', M, '6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e17776969e89b4c5564d00349106b8497785dd7d1d713a8ae82b32fa79d5f7fc407d39b', false], // x >= p
];
(async () => {
  for (const [pk, m, sig, want] of vectors) assert.strictEqual(await c.verifySchnorrSig(sig, m, pk), want, 'BIP-340 vector ' + pk.slice(0, 8));
  assert.strictEqual(await c.derivePublicKey('0'.repeat(63) + '3'), vectors[0][0], 'pubkey derivation');
  for (let i = 0; i < 12; i++) {
    const sk = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('hex');
    const ev = await c.signNostrEvent({ kind: 1, created_at: 1700000000 + i, tags: [['t', 'glowstr']], content: 'note ' + i }, sk);
    assert.ok(await c.verifyEvent(ev), 'round trip');
    assert.ok(await c.verifyEvent(ev), 'cached repeat');
    const flip = ev.sig.slice(0, 127) + (ev.sig[127] === '0' ? '1' : '0');
    assert.ok(!(await c.verifyEvent({ ...ev, sig: flip })), 'tampered signature must fail even after a cached success');
    assert.ok(!(await c.verifyEvent({ ...ev, content: 'forged' })), 'tampered body must fail');
    const other = await c.signNostrEvent({ kind: 1, created_at: 5, tags: [], content: 'other' }, sk);
    assert.ok(!(await c.verifyEvent({ ...other, sig: ev.sig })), 'signature from another event must fail');
  }
  const G = c._G, negG = [G[0], c._P - G[1]];
  assert.strictEqual(c._pointAdd(G, negG), null, 'P + (-P) is infinity');
  assert.strictEqual(c._pointMul(c._N, G), null, 'n*G is infinity');
  const last = c._pointMul(c._N - 1n, G);
  assert.ok(last[0] === G[0] && last[1] === negG[1], '(n-1)*G == -G');
  assert.strictEqual((c._modInv(7n) * 7n) % c._P, 1n, 'modular inverse');
  const t0 = performance.now();
  const sk = '1'.repeat(64), evs = [];
  for (let i = 0; i < 20; i++) evs.push(await c.signNostrEvent({ kind: 1, created_at: i, tags: [], content: 'b' + i }, sk));
  const t1 = performance.now();
  // Fresh ids each time, so this measures uncached verification.
  for (const e of evs) await c.verifySchnorrSig(e.sig, e.id, e.pubkey);
  const perVerify = (performance.now() - t1) / evs.length;
  assert.ok(perVerify < 40, 'signature verification regressed to ' + perVerify.toFixed(1) + ' ms');
  console.log('PASS secp256k1/BIP-340: ' + vectors.length + ' vectors, round trips, tamper checks; verify ' + perVerify.toFixed(2) + ' ms, sign ' + ((t1 - t0) / evs.length).toFixed(2) + ' ms');
})().catch(e => { console.error(e); process.exit(1); });
