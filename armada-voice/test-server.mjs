import test from 'node:test'
import assert from 'node:assert/strict'

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { TokenVerifier } from 'livekit-server-sdk'

import {
  FixedWindowLimiter,
  ReplaySet,
  expectedTokenUrl,
  mintToken,
  parseConcordAuthorization,
  validateGrant,
} from './server.mjs'

function grant(sk, url, createdAt = Math.floor(Date.now() / 1000), nonce = 'ab'.repeat(32)) {
  return finalizeEvent({
    kind: 27235,
    content: '',
    created_at: createdAt,
    tags: [['u', url], ['method', 'GET'], ['nonce', nonce]],
  }, sk)
}

test('accepts Armada CORD-07 grant with room-key pubkey', () => {
  const sk = generateSecretKey()
  const room = getPublicKey(sk)
  const url = expectedTokenUrl('https://voice.example', room)
  assert.deepEqual(validateGrant(grant(sk, url), room, url), { ok: true })
})

test('rejects wrong room, URL, method, nonce, and stale grants', () => {
  const sk = generateSecretKey()
  const room = getPublicKey(sk)
  const url = expectedTokenUrl('https://voice.example', room)
  const now = Math.floor(Date.now() / 1000)

  assert.equal(validateGrant(grant(sk, url), '11'.repeat(32), url, now).ok, false)
  assert.equal(validateGrant(grant(sk, url), room, url + 'x', now).ok, false)

  const badMethod = finalizeEvent({
    kind: 27235, content: '', created_at: now,
    tags: [['u', url], ['method', 'POST'], ['nonce', 'ab'.repeat(32)]],
  }, sk)
  assert.equal(validateGrant(badMethod, room, url, now).ok, false)

  assert.equal(validateGrant(grant(sk, url, now, 'bad'), room, url, now).ok, false)
  assert.equal(validateGrant(grant(sk, url, now - 121), room, url, now).ok, false)
})

test('parses Armada Concord base64 authorization', () => {
  const sk = generateSecretKey()
  const room = getPublicKey(sk)
  const url = expectedTokenUrl('https://voice.example', room)
  const ev = grant(sk, url)
  const header = 'Concord ' + Buffer.from(JSON.stringify(ev)).toString('base64')
  assert.equal(parseConcordAuthorization(header).id, ev.id)
})

test('replay set accepts a grant once', () => {
  const r = new ReplaySet(180)
  const id = 'aa'.repeat(32)
  assert.equal(r.consume(id, 1000), true)
  assert.equal(r.consume(id, 1001), false)
  r.prune(181002)
  assert.equal(r.consume(id, 181003), true)
})

test('fixed window limiter bounds repeated token attempts', () => {
  const l = new FixedWindowLimiter(2, 60)
  assert.equal(l.allow('ip', 1000), true)
  assert.equal(l.allow('ip', 1001), true)
  assert.equal(l.allow('ip', 1002), false)
  assert.equal(l.allow('ip', 61000), true)
})

test('mints a LiveKit token bound to room and random identity', async () => {
  const apiKey = 'test-api-key'
  const apiSecret = 'test-api-secret-that-is-long-enough'
  const room = 'ab'.repeat(32)
  const identity = 'cd'.repeat(24)
  const jwt = await mintToken({ apiKey, apiSecret, room, identity, ttlSeconds: 600 })
  const claims = await new TokenVerifier(apiKey, apiSecret).verify(jwt)
  assert.equal(claims.sub, identity)
  assert.equal(claims.video?.roomJoin, true)
  assert.equal(claims.video?.room, room)
  assert.equal(claims.video?.canPublish, true)
  assert.equal(claims.video?.canSubscribe, true)
})
