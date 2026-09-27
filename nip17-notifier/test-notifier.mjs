import test from 'node:test'
import assert from 'node:assert/strict'

import * as nip59 from 'nostr-tools/nip59'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

import {
  buildNotificationWraps,
  isBlockedAddress,
  parseSecretKey,
  relayTagsFromEvent,
  renewalMessage,
  shouldRetry,
  validateRecipientRelay,
} from './notifier.mjs'

test('parses 64 hex service key', () => {
  const key = generateSecretKey()
  const hex = Buffer.from(key).toString('hex')
  assert.deepEqual(parseSecretKey(hex), key)
})

test('blocks local and private addresses', () => {
  assert.equal(isBlockedAddress('127.0.0.1'), true)
  assert.equal(isBlockedAddress('10.1.2.3'), true)
  assert.equal(isBlockedAddress('192.168.50.1'), true)
  assert.equal(isBlockedAddress('::1'), true)
  assert.equal(isBlockedAddress('8.8.8.8'), false)
})

test('rejects recipient inbox hosts outside the operator allowlist', async () => {
  await assert.rejects(
    validateRecipientRelay('wss://attacker.example/', ['nos.lol', 'relay.nostr.band']),
    /operator-approved/,
  )
})

test('deduplicates kind 10050 relay tags', () => {
  const event = { tags: [
    ['relay', 'wss://one.example'],
    ['x', 'ignore'],
    ['relay', 'wss://one.example'],
    ['relay', 'wss://two.example'],
  ] }
  assert.deepEqual(relayTagsFromEvent(event), ['wss://one.example', 'wss://two.example'])
})

test('retry delay prevents notification hammering', () => {
  assert.equal(shouldRetry({ sent_at: 1 }), false)
  assert.equal(shouldRetry({ sent_at: null, last_attempt_at: 900 }, 1000, 200), false)
  assert.equal(shouldRetry({ sent_at: null, last_attempt_at: 700 }, 1000, 200), true)
})

test('builds decryptable NIP-17 gift wraps for recipient and sender', () => {
  const sender = generateSecretKey()
  const recipient = generateSecretKey()
  const recipientPubkey = getPublicKey(recipient)
  const reminder = {
    id: 7,
    pubkey: recipientPubkey,
    valid_until: 1790524800,
  }

  const wraps = buildNotificationWraps(sender, reminder, 'wss://inbox.example')
  assert.equal(wraps.recipient.kind, 1059)
  assert.equal(wraps.sender.kind, 1059)
  assert.deepEqual(wraps.recipient.tags[0].slice(0, 2), ['p', recipientPubkey])
  assert.deepEqual(wraps.sender.tags[0].slice(0, 2), ['p', getPublicKey(sender)])

  const received = nip59.unwrapEvent(wraps.recipient, recipient)
  const archived = nip59.unwrapEvent(wraps.sender, sender)
  assert.equal(received.kind, 14)
  assert.equal(received.id, archived.id)
  assert.equal(received.pubkey, getPublicKey(sender))
  assert.deepEqual(received.tags[0], ['p', recipientPubkey, 'wss://inbox.example'])
  assert.ok(received.tags.some(t => t[0] === 'subject' && t[1] === 'Glowstr relay renewal'))
  assert.match(received.content, /2 confirmations/)
})

test('renewal message includes expiry and annual XMR terms', () => {
  const msg = renewalMessage({ valid_until: 1790524800 })
  assert.match(msg, /Glowstr relay renewal reminder/)
  assert.match(msg, /\$10 USD equivalent in Monero/)
  assert.match(msg, /Public relay reading remains free/)
})
