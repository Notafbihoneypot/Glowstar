import test from 'node:test'
import assert from 'node:assert/strict'

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

import {
  decideWrite,
  isPrivacyWrapperKind,
  normalizeRelayUrl,
  validateAuthEvent,
} from './gate.mjs'

function authEvent(sk, challenge, relay, createdAt = Math.floor(Date.now() / 1000)) {
  return finalizeEvent({
    kind: 22242,
    content: '',
    created_at: createdAt,
    tags: [['relay', relay], ['challenge', challenge]],
  }, sk)
}

function event(sk, kind = 1) {
  return finalizeEvent({
    kind,
    content: 'hello',
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
  }, sk)
}

test('normalizes relay URL for NIP-42 matching', () => {
  assert.equal(normalizeRelayUrl('wss://Relay.Example/abc?x=1#z'), 'wss://relay.example')
})

test('accepts multiple independently signed AUTH events for one challenge', () => {
  const challenge = 'abc'
  const relay = 'wss://relay.example/'
  const a = authEvent(generateSecretKey(), challenge, relay)
  const b = authEvent(generateSecretKey(), challenge, relay)
  assert.equal(validateAuthEvent(a, challenge, relay).ok, true)
  assert.equal(validateAuthEvent(b, challenge, relay).ok, true)
})

test('rejects stale and wrong-relay AUTH', () => {
  const sk = generateSecretKey()
  const now = Math.floor(Date.now() / 1000)
  assert.equal(validateAuthEvent(authEvent(sk, 'x', 'wss://one.example', now - 601), 'x', 'wss://one.example', now).ok, false)
  assert.equal(validateAuthEvent(authEvent(sk, 'x', 'wss://one.example', now), 'x', 'wss://two.example', now).ok, false)
})

test('ordinary event requires the event author to be authenticated and paid session to exist', () => {
  const user = generateSecretKey()
  const other = generateSecretKey()
  const userPk = getPublicKey(user)
  const ev = event(other, 1)
  assert.equal(decideWrite(ev, new Set([userPk]), new Set([userPk])).ok, false)
  assert.equal(decideWrite(event(user, 1), new Set([userPk]), new Set([userPk])).ok, true)
})

test('paid authenticated user may publish NIP-59 and Concord privacy wrappers', () => {
  const payer = generateSecretKey()
  const stream = generateSecretKey()
  const payerPk = getPublicKey(payer)
  for (const kind of [1059, 21059]) {
    const ev = event(stream, kind)
    assert.equal(isPrivacyWrapperKind(kind), true)
    assert.equal(decideWrite(ev, new Set([payerPk]), new Set([payerPk]), true).ok, true)
  }
})

test('privacy wrapper still requires at least one paid authenticated identity', () => {
  const authed = generateSecretKey()
  const stream = generateSecretKey()
  const ev = event(stream, 21059)
  assert.equal(decideWrite(ev, new Set([getPublicKey(authed)]), new Set(), true).ok, false)
})

test('privacy wrapper exception can be disabled', () => {
  const payer = generateSecretKey()
  const stream = generateSecretKey()
  const payerPk = getPublicKey(payer)
  assert.equal(decideWrite(event(stream, 1059), new Set([payerPk]), new Set([payerPk]), false).ok, false)
})
