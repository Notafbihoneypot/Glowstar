#!/usr/bin/env node
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { verifyEvent } from 'nostr-tools/pure'
import { WebSocket, WebSocketServer } from 'ws'

const MAX_FRAME_BYTES = 262144
const AUTH_MAX_SKEW_SECONDS = 600
const DEFAULT_CACHE_SECONDS = 15

function envInt(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

async function readSecret(envName, fileEnvName) {
  const path = String(process.env[fileEnvName] || '').trim()
  if (path) return (await readFile(path, 'utf8')).trim()
  return String(process.env[envName] || '').trim()
}

export function normalizeRelayUrl(raw) {
  const u = new URL(String(raw || '').trim())
  if (!['ws:', 'wss:'].includes(u.protocol)) throw new Error('relay URL must use ws/wss')
  u.username = ''
  u.password = ''
  u.hash = ''
  u.search = ''
  u.pathname = '/'
  return u.toString().replace(/\/$/, '')
}

export function isPrivacyWrapperKind(kind) {
  return kind === 1059 || kind === 21059
}

function tagValues(tags, name) {
  if (!Array.isArray(tags)) return []
  return tags
    .filter(t => Array.isArray(t) && t[0] === name && typeof t[1] === 'string')
    .map(t => t[1])
}

export function validateAuthEvent(event, challenge, relayUrl, now = Math.floor(Date.now() / 1000)) {
  if (!event || typeof event !== 'object') return { ok: false, error: 'invalid AUTH event' }
  if (event.kind !== 22242) return { ok: false, error: 'AUTH kind must be 22242' }
  if (!/^[0-9a-f]{64}$/.test(String(event.pubkey || ''))) return { ok: false, error: 'invalid AUTH pubkey' }
  if (!Number.isSafeInteger(event.created_at) || Math.abs(now - event.created_at) > AUTH_MAX_SKEW_SECONDS) {
    return { ok: false, error: 'stale AUTH event' }
  }
  const challenges = tagValues(event.tags, 'challenge')
  if (challenges.length !== 1 || challenges[0] !== challenge) {
    return { ok: false, error: 'AUTH challenge mismatch' }
  }
  const relays = tagValues(event.tags, 'relay')
  if (relays.length !== 1) return { ok: false, error: 'AUTH relay tag missing or ambiguous' }
  try {
    if (normalizeRelayUrl(relays[0]) !== normalizeRelayUrl(relayUrl)) {
      return { ok: false, error: 'AUTH relay mismatch' }
    }
  } catch {
    return { ok: false, error: 'invalid AUTH relay URL' }
  }
  if (!verifyEvent(event)) return { ok: false, error: 'invalid AUTH signature' }
  return { ok: true, pubkey: event.pubkey }
}

export function basicEventShape(event) {
  return !!(
    event &&
    typeof event === 'object' &&
    /^[0-9a-f]{64}$/.test(String(event.id || '')) &&
    /^[0-9a-f]{64}$/.test(String(event.pubkey || '')) &&
    Number.isSafeInteger(event.kind) &&
    Number.isSafeInteger(event.created_at) &&
    Array.isArray(event.tags) &&
    typeof event.content === 'string' &&
    /^[0-9a-f]{128}$/.test(String(event.sig || ''))
  )
}

export function decideWrite(event, authedPubkeys, paidPubkeys, allowPrivacyWrappers = true) {
  if (!basicEventShape(event)) {
    return { ok: false, reason: 'invalid: malformed event' }
  }
  if (!authedPubkeys || authedPubkeys.size === 0) {
    return { ok: false, reason: 'auth-required: authenticate before publishing' }
  }
  if (!paidPubkeys || paidPubkeys.size === 0) {
    return { ok: false, reason: 'restricted: Glowstr annual relay membership required' }
  }

  const privacy = allowPrivacyWrappers && isPrivacyWrapperKind(event.kind)
  if (!privacy && !authedPubkeys.has(event.pubkey)) {
    return { ok: false, reason: 'restricted: authenticated pubkey must match event author' }
  }

  return { ok: true }
}

class EntitlementCache {
  constructor({ adminUrl, adminToken, feature, target, ttlSeconds }) {
    this.adminUrl = adminUrl.replace(/\/$/, '')
    this.adminToken = adminToken
    this.feature = feature
    this.target = target
    this.ttlMs = ttlSeconds * 1000
    this.entries = new Map()
  }

  async active(pubkey) {
    const nowMs = Date.now()
    const hit = this.entries.get(pubkey)
    if (hit && hit.expiresAtMs > nowMs) return hit.allowed

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    try {
      const res = await fetch(this.adminUrl + '/entitlements/' + encodeURIComponent(pubkey), {
        headers: { Authorization: 'Bearer ' + this.adminToken, Accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('commerce entitlement HTTP ' + res.status)
      const data = await res.json()
      const now = Math.floor(Date.now() / 1000)
      let validUntil = 0
      for (const ent of Array.isArray(data.entitlements) ? data.entitlements : []) {
        if (ent.feature !== this.feature) continue
        if (this.target && ent.target && ent.target !== this.target) continue
        const until = Number(ent.valid_until || 0)
        if (until > now && until > validUntil) validUntil = until
      }
      const allowed = validUntil > now
      // Positive entries never outlive the entitlement itself.
      const entitlementMs = allowed ? Math.max(0, validUntil * 1000 - nowMs) : this.ttlMs
      const expiresAtMs = nowMs + Math.min(this.ttlMs, entitlementMs || this.ttlMs)
      this.entries.set(pubkey, { allowed, expiresAtMs })
      return allowed
    } finally {
      clearTimeout(timer)
    }
  }
}

function sendJson(ws, value) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value))
}

function closePair(client, upstream, code = 1000, reason = '') {
  try { if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason) } catch {}
  try { if (upstream?.readyState === WebSocket.OPEN || upstream?.readyState === WebSocket.CONNECTING) upstream.close(code, reason) } catch {}
}

async function main() {
  const host = process.env.GLOWSTR_GATE_HOST || '127.0.0.1'
  const port = envInt('GLOWSTR_GATE_PORT', 7778, 1, 65535)
  const relayUrl = normalizeRelayUrl(process.env.GLOWSTR_GATE_PUBLIC_RELAY || 'wss://relay.glowstr.com/')
  const upstreamUrl = process.env.GLOWSTR_GATE_UPSTREAM || 'ws://127.0.0.1:7777'
  const adminUrl = process.env.GLOWSTR_COMMERCE_ADMIN_URL || 'http://127.0.0.1:8787/v1/admin'
  const adminToken = await readSecret('GLOWSTR_COMMERCE_ADMIN_TOKEN', 'GLOWSTR_COMMERCE_ADMIN_TOKEN_FILE')
  const feature = process.env.GLOWSTR_RELAY_FEATURE || 'relay_365d'
  const target = process.env.GLOWSTR_RELAY_TARGET || 'relay.glowstr.com'
  const allowPrivacyWrappers = !['0', 'false', 'no', 'off'].includes(
    String(process.env.GLOWSTR_ALLOW_PRIVACY_WRAPPERS || 'true').toLowerCase(),
  )
  const maxAuthKeys = envInt('GLOWSTR_GATE_MAX_AUTH_KEYS', 64, 2, 256)
  if (!adminToken) throw new Error('GLOWSTR_COMMERCE_ADMIN_TOKEN[_FILE] is required')

  const entitlements = new EntitlementCache({
    adminUrl,
    adminToken,
    feature,
    target,
    ttlSeconds: envInt('GLOWSTR_ENTITLEMENT_CACHE_SECONDS', DEFAULT_CACHE_SECONDS, 1, 300),
  })

  const server = createServer((req, res) => {
    if (req.url === '/health') {
      const body = JSON.stringify({ ok: true, multi_auth: true, privacy_wrappers: allowPrivacyWrappers })
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      })
      return res.end(body)
    }
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end('not found')
  })

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  })

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req))
  })

  wss.on('connection', client => {
    const challenge = randomBytes(32).toString('base64url')
    const authed = new Set()
    const upstream = new WebSocket(upstreamUrl, {
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    })
    const pending = []

    // Challenge immediately. Armada can answer with both user and derived stream keys.
    sendJson(client, ['AUTH', challenge])

    upstream.on('open', () => {
      while (pending.length && upstream.readyState === WebSocket.OPEN) upstream.send(pending.shift())
    })

    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
    })
    upstream.on('close', () => closePair(client, upstream, 1011, 'upstream relay closed'))
    upstream.on('error', err => {
      console.warn('upstream relay error:', String(err?.message || err))
      closePair(client, upstream, 1011, 'upstream relay error')
    })

    client.on('message', async (data, isBinary) => {
      if (isBinary || data.length > MAX_FRAME_BYTES) {
        return closePair(client, upstream, 1009, 'text frame required')
      }
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return sendJson(client, ['NOTICE', 'invalid: malformed JSON'])
      }
      if (!Array.isArray(msg) || typeof msg[0] !== 'string') {
        return sendJson(client, ['NOTICE', 'invalid: malformed Nostr message'])
      }

      if (msg[0] === 'AUTH') {
        const event = msg[1]
        const result = validateAuthEvent(event, challenge, relayUrl)
        if (!result.ok) {
          if (event?.id && /^[0-9a-f]{64}$/.test(event.id)) sendJson(client, ['OK', event.id, false, 'restricted: ' + result.error])
          else sendJson(client, ['NOTICE', 'restricted: ' + result.error])
          return
        }
        if (!authed.has(result.pubkey) && authed.size >= maxAuthKeys) {
          sendJson(client, ['OK', event.id, false, 'rate-limited: too many authenticated identities'])
          return
        }
        authed.add(result.pubkey)
        sendJson(client, ['OK', event.id, true, 'authenticated'])
        return
      }

      if (msg[0] === 'EVENT') {
        const event = msg[1]
        if (!basicEventShape(event) || !verifyEvent(event)) {
          const id = basicEventShape(event) ? event.id : ''
          if (id) sendJson(client, ['OK', id, false, 'invalid: event signature or shape'])
          else sendJson(client, ['NOTICE', 'invalid: malformed event'])
          return
        }

        if (!authed.size) {
          sendJson(client, ['AUTH', challenge])
          sendJson(client, ['OK', event.id, false, 'auth-required: authenticate before publishing'])
          return
        }

        const paid = new Set()
        try {
          const checks = await Promise.all([...authed].map(async pk => [pk, await entitlements.active(pk)]))
          for (const [pk, active] of checks) if (active) paid.add(pk)
        } catch (err) {
          console.error('entitlement check failed:', String(err?.message || err))
          sendJson(client, ['OK', event.id, false, 'error: membership service unavailable'])
          return
        }

        const decision = decideWrite(event, authed, paid, allowPrivacyWrappers)
        if (!decision.ok) {
          sendJson(client, ['OK', event.id, false, decision.reason])
          return
        }
      }

      const raw = data.toString()
      if (upstream.readyState === WebSocket.OPEN) upstream.send(raw)
      else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 64) pending.push(raw)
      else closePair(client, upstream, 1011, 'upstream unavailable')
    })

    client.on('close', () => closePair(client, upstream))
    client.on('error', () => closePair(client, upstream, 1011, 'client error'))
  })

  server.listen(port, host, () => {
    console.log(`Glowstr relay gate listening on ${host}:${port}; relay=${relayUrl}; upstream=${upstreamUrl}`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('fatal relay gate error:', String(err?.message || err))
    process.exit(1)
  })
}
