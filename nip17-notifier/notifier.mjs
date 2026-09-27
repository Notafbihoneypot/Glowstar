#!/usr/bin/env node
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

import { SimplePool } from 'nostr-tools/pool'
import * as nip19 from 'nostr-tools/nip19'
import * as nip59 from 'nostr-tools/nip59'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const DEFAULT_POLL_SECONDS = 300
const DEFAULT_RETRY_SECONDS = 21600
const DEFAULT_LOOKUP_WAIT_MS = 5000
const DEFAULT_PUBLISH_WAIT_MS = 8000

const blocked = new BlockList()
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4')
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(addr, prefix, 'ipv6')

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envBool(name, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase()
  if (!raw) return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw)
}

function listEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
}

export async function readSecret(envName, fileEnvName) {
  const file = String(process.env[fileEnvName] || '').trim()
  if (file) return (await readFile(file, 'utf8')).trim()
  return String(process.env[envName] || '').trim()
}

export function parseSecretKey(raw) {
  const value = String(raw || '').trim()
  if (/^[0-9a-fA-F]{64}$/.test(value)) return new Uint8Array(Buffer.from(value, 'hex'))
  if (value.startsWith('nsec1')) {
    const decoded = nip19.decode(value)
    if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
      throw new Error('NIP-17 secret is not a valid nsec')
    }
    return decoded.data
  }
  throw new Error('NIP-17 secret must be a 64-character hex key or nsec')
}

export function isBlockedAddress(address) {
  let value = String(address || '').trim().toLowerCase()
  if (value.startsWith('::ffff:')) value = value.slice(7)
  const family = isIP(value)
  if (family === 4) return blocked.check(value, 'ipv4')
  if (family === 6) return blocked.check(value, 'ipv6')
  return true
}

export async function validateRecipientRelay(raw) {
  const u = new URL(String(raw || '').trim())
  if (u.protocol !== 'wss:') throw new Error('recipient relay must use wss://')
  if (u.username || u.password) throw new Error('relay credentials in URL are not allowed')
  const host = u.hostname.toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('local relay host is not allowed')
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('private/reserved relay address is not allowed')
  } else {
    const answers = await lookup(host, { all: true, verbatim: true })
    if (!answers.length) throw new Error('relay hostname did not resolve')
    if (answers.some(x => isBlockedAddress(x.address))) {
      throw new Error('relay hostname resolves to a private/reserved address')
    }
  }
  u.hash = ''
  return u.toString()
}

export function relayTagsFromEvent(event) {
  const out = []
  for (const tag of event?.tags || []) {
    if (tag?.[0] !== 'relay' || typeof tag?.[1] !== 'string') continue
    if (!out.includes(tag[1])) out.push(tag[1])
  }
  return out
}

export function renewalMessage(reminder) {
  const expiry = new Date(Number(reminder.valid_until) * 1000)
  const when = Number.isFinite(expiry.getTime())
    ? expiry.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    : 'your current expiry time'
  return [
    'Glowstr relay renewal reminder',
    '',
    `Your paid relay write access expires at ${when}.`,
    'Renew inside Glowstr for another year: $10 USD equivalent in Monero.',
    'Access activates or renews after 2 confirmations. Public relay reading remains free.',
  ].join('\n')
}

export function buildNotificationWraps(secretKey, reminder, relayHint) {
  const senderPubkey = getPublicKey(secretKey)
  const rumor = {
    created_at: Math.floor(Date.now() / 1000),
    kind: 14,
    tags: [
      relayHint ? ['p', reminder.pubkey, relayHint] : ['p', reminder.pubkey],
      ['subject', 'Glowstr relay renewal'],
    ],
    content: renewalMessage(reminder),
  }
  return {
    senderPubkey,
    recipient: nip59.wrapEvent(rumor, secretKey, reminder.pubkey),
    sender: nip59.wrapEvent(rumor, secretKey, senderPubkey),
  }
}

export function shouldRetry(reminder, now = Math.floor(Date.now() / 1000), retrySeconds = DEFAULT_RETRY_SECONDS) {
  if (reminder.sent_at) return false
  const last = Number(reminder.last_attempt_at || 0)
  return !last || now - last >= retrySeconds
}

async function appendSenderArchive(path, reminderId, wrap) {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify({ reminder_id: reminderId, wrap }) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmod(path, 0o600).catch(() => {})
}

function commerceHeaders(token, json = false) {
  return {
    Accept: 'application/json',
    Authorization: 'Bearer ' + token,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

async function commerceJson(url, token, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(url, {
      ...options,
      headers: { ...commerceHeaders(token, options.body != null), ...(options.headers || {}) },
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`commerce HTTP ${res.status}: ${body.error || 'request failed'}`)
    return body
  } finally {
    clearTimeout(timer)
  }
}

export async function discoverInboxRelays(pool, pubkey, lookupRelays, maxWait = DEFAULT_LOOKUP_WAIT_MS) {
  const event = await pool.get(
    lookupRelays,
    { kinds: [10050], authors: [pubkey], limit: 1 },
    { maxWait },
  )
  if (!event) return []

  const relays = []
  for (const raw of relayTagsFromEvent(event).slice(0, 8)) {
    try {
      const safe = await validateRecipientRelay(raw)
      if (!relays.includes(safe)) relays.push(safe)
    } catch (err) {
      console.warn('Ignoring unsafe NIP-17 inbox relay:', String(err?.message || err))
    }
  }
  return relays.slice(0, 3)
}

async function publishAtLeastOne(pool, relays, event, authSigner, maxWait) {
  const settled = await Promise.allSettled(
    pool.publish(relays, event, { onauth: authSigner, maxWait }),
  )
  const success = settled.filter(x => x.status === 'fulfilled').length
  if (!success) {
    const errors = settled
      .map(x => x.status === 'rejected' ? String(x.reason?.message || x.reason) : '')
      .filter(Boolean)
      .slice(0, 3)
      .join('; ')
    throw new Error('NIP-17 publish failed' + (errors ? ': ' + errors : ''))
  }
  return success
}

export async function deliverReminder(ctx, reminder) {
  const relays = await discoverInboxRelays(
    ctx.pool,
    reminder.pubkey,
    ctx.lookupRelays,
    ctx.lookupWaitMs,
  )
  if (!relays.length) throw new Error('no NIP-17 kind:10050 inbox relay list found')

  const wraps = buildNotificationWraps(ctx.secretKey, reminder, relays[0])
  const authSigner = async template => finalizeEvent(template, ctx.secretKey)
  const delivered = await publishAtLeastOne(
    ctx.pool,
    relays,
    wraps.recipient,
    authSigner,
    ctx.publishWaitMs,
  )

  // NIP-17 requires a sender-addressed gift wrap too. Keep a private local copy,
  // and optionally publish it to operator-configured sender inbox relays.
  await appendSenderArchive(ctx.archivePath, reminder.id, wraps.sender)
  if (ctx.senderRelays.length) {
    await Promise.allSettled(
      ctx.pool.publish(ctx.senderRelays, wraps.sender, {
        onauth: authSigner,
        maxWait: ctx.publishWaitMs,
      }),
    )
  }
  return { delivered, relays }
}

async function markReminder(adminUrl, token, reminderId, action, error = '') {
  const url = `${adminUrl}/reminders/${encodeURIComponent(reminderId)}/${action}`
  return commerceJson(url, token, {
    method: 'POST',
    body: JSON.stringify(error ? { error } : {}),
  })
}

export async function processOnce(ctx) {
  const body = await commerceJson(
    ctx.adminUrl + '/reminders?status=pending',
    ctx.adminToken,
  )
  const reminders = Array.isArray(body.reminders) ? body.reminders : []
  let sent = 0
  let failed = 0

  for (const reminder of reminders.slice(0, ctx.batchSize)) {
    if (!shouldRetry(reminder, Math.floor(Date.now() / 1000), ctx.retrySeconds)) continue
    try {
      const result = await deliverReminder(ctx, reminder)
      await markReminder(ctx.adminUrl, ctx.adminToken, reminder.id, 'sent')
      console.log(
        `NIP-17 renewal reminder ${reminder.id} delivered to ${result.delivered}/${result.relays.length} inbox relays`,
      )
      sent++
    } catch (err) {
      const message = String(err?.message || err).slice(0, 220)
      console.warn(`NIP-17 reminder ${reminder.id} deferred: ${message}`)
      await markReminder(ctx.adminUrl, ctx.adminToken, reminder.id, 'failed', message).catch(() => {})
      failed++
    }
  }
  return { pending: reminders.length, sent, failed }
}

async function main() {
  const secretRaw = await readSecret('GLOWSTR_NIP17_SECRET', 'GLOWSTR_NIP17_SECRET_FILE')
  const adminToken = await readSecret(
    'GLOWSTR_COMMERCE_ADMIN_TOKEN',
    'GLOWSTR_COMMERCE_ADMIN_TOKEN_FILE',
  )
  if (!secretRaw) throw new Error('GLOWSTR_NIP17_SECRET[_FILE] is required')
  if (!adminToken) throw new Error('GLOWSTR_COMMERCE_ADMIN_TOKEN[_FILE] is required')

  const secretKey = parseSecretKey(secretRaw)
  const lookupRelays = listEnv('GLOWSTR_NIP17_LOOKUP_RELAYS')
  if (!lookupRelays.length) throw new Error('GLOWSTR_NIP17_LOOKUP_RELAYS is required')

  const ctx = {
    secretKey,
    adminToken,
    adminUrl: String(
      process.env.GLOWSTR_COMMERCE_ADMIN_URL || 'http://127.0.0.1:8787/v1/admin',
    ).replace(/\/$/, ''),
    lookupRelays,
    senderRelays: listEnv('GLOWSTR_NIP17_SENDER_RELAYS'),
    archivePath: String(process.env.GLOWSTR_NIP17_ARCHIVE || '/data/sender-wraps.jsonl'),
    pollSeconds: envInt('GLOWSTR_NIP17_POLL_SECONDS', DEFAULT_POLL_SECONDS),
    retrySeconds: envInt('GLOWSTR_NIP17_RETRY_SECONDS', DEFAULT_RETRY_SECONDS),
    lookupWaitMs: envInt('GLOWSTR_NIP17_LOOKUP_WAIT_MS', DEFAULT_LOOKUP_WAIT_MS),
    publishWaitMs: envInt('GLOWSTR_NIP17_PUBLISH_WAIT_MS', DEFAULT_PUBLISH_WAIT_MS),
    batchSize: Math.min(100, envInt('GLOWSTR_NIP17_BATCH_SIZE', 25)),
    pool: new SimplePool({ enablePing: true, enableReconnect: false }),
  }

  const pubkey = getPublicKey(secretKey)
  const npub = nip19.npubEncode(pubkey)
  console.log(`Glowstr NIP-17 notifier started as ${npub}; lookup relays=${lookupRelays.length}`)

  const stop = () => {
    ctx.pool.destroy()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  do {
    try {
      await processOnce(ctx)
    } catch (err) {
      console.error('notifier cycle failed:', String(err?.message || err))
    }
    if (envBool('GLOWSTR_NIP17_ONCE')) break
    await new Promise(resolve => setTimeout(resolve, ctx.pollSeconds * 1000))
  } while (true)

  ctx.pool.destroy()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('fatal notifier error:', String(err?.message || err))
    process.exit(1)
  })
}
