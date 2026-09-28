#!/usr/bin/env node
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { AccessToken } from 'livekit-server-sdk'
import { verifyEvent } from 'nostr-tools/pure'

const KIND_HTTP_AUTH = 27235
const MAX_AUTH_AGE_SECONDS = 120
const MAX_HEADER_BYTES = 16384
const MAX_REPLAY_ENTRIES = 20000

function envInt(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

function tagValues(tags, name) {
  if (!Array.isArray(tags)) return []
  return tags
    .filter(t => Array.isArray(t) && t[0] === name && typeof t[1] === 'string')
    .map(t => t[1])
}

export function expectedTokenUrl(publicOrigin, room) {
  return publicOrigin.replace(/\/$/, '') + '/.well-known/concord/av/' + room
}

export function parseConcordAuthorization(header) {
  if (typeof header !== 'string' || header.length > MAX_HEADER_BYTES) throw new Error('invalid authorization header')
  const m = header.match(/^Concord ([A-Za-z0-9+/=]+)$/)
  if (!m) throw new Error('missing Concord authorization')
  const raw = Buffer.from(m[1], 'base64').toString('utf8')
  if (!raw || raw.length > 12000) throw new Error('invalid Concord authorization')
  return JSON.parse(raw)
}

export function validateGrant(event, room, url, now = Math.floor(Date.now() / 1000)) {
  if (!event || typeof event !== 'object') return { ok: false, error: 'invalid grant' }
  if (event.kind !== KIND_HTTP_AUTH) return { ok: false, error: 'wrong grant kind' }
  if (!/^[0-9a-f]{64}$/.test(String(room || ''))) return { ok: false, error: 'invalid room' }
  if (event.pubkey !== room) return { ok: false, error: 'grant pubkey must equal voice room' }
  if (!Number.isSafeInteger(event.created_at) || Math.abs(now - event.created_at) > MAX_AUTH_AGE_SECONDS) {
    return { ok: false, error: 'stale grant' }
  }
  const urls = tagValues(event.tags, 'u')
  const methods = tagValues(event.tags, 'method')
  const nonces = tagValues(event.tags, 'nonce')
  if (urls.length !== 1 || urls[0] !== url) return { ok: false, error: 'grant URL mismatch' }
  if (methods.length !== 1 || methods[0] !== 'GET') return { ok: false, error: 'grant method mismatch' }
  if (nonces.length !== 1 || !/^[0-9a-f]{64}$/.test(nonces[0])) return { ok: false, error: 'invalid grant nonce' }
  if (!verifyEvent(event)) return { ok: false, error: 'invalid grant signature' }
  return { ok: true }
}

export class ReplaySet {
  constructor(ttlSeconds = 180) {
    this.ttlMs = ttlSeconds * 1000
    this.ids = new Map()
  }

  consume(id, nowMs = Date.now()) {
    if (!/^[0-9a-f]{64}$/.test(String(id || ''))) return false
    this.prune(nowMs)
    if (this.ids.has(id)) return false
    this.ids.set(id, nowMs + this.ttlMs)
    if (this.ids.size > MAX_REPLAY_ENTRIES) {
      const excess = this.ids.size - MAX_REPLAY_ENTRIES
      for (const key of this.ids.keys()) {
        this.ids.delete(key)
        if (this.ids.size <= MAX_REPLAY_ENTRIES - Math.max(0, excess - 1)) break
      }
    }
    return true
  }

  prune(nowMs = Date.now()) {
    for (const [id, expires] of this.ids) {
      if (expires <= nowMs) this.ids.delete(id)
    }
  }
}

export class FixedWindowLimiter {
  constructor(limit, windowSeconds) {
    this.limit = limit
    this.windowMs = windowSeconds * 1000
    this.buckets = new Map()
  }

  allow(key, now = Date.now()) {
    const bucket = Math.floor(now / this.windowMs)
    const old = this.buckets.get(key)
    const count = old?.bucket === bucket ? old.count + 1 : 1
    this.buckets.set(key, { bucket, count })
    if (this.buckets.size > 10000) {
      for (const [k, v] of this.buckets) if (v.bucket < bucket) this.buckets.delete(k)
    }
    return count <= this.limit
  }
}

export async function mintToken({ apiKey, apiSecret, room, identity, ttlSeconds }) {
  const at = new AccessToken(apiKey, apiSecret, { identity, ttl: ttlSeconds })
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })
  return at.toJwt()
}

function clientIp(req) {
  const direct = String(req.socket?.remoteAddress || '')
  return direct.replace(/^::ffff:/, '') || 'unknown'
}

function corsHeaders(req, allowedOrigin) {
  const origin = String(req.headers.origin || '')
  if (!origin) return {}
  if (allowedOrigin === '*' || origin === allowedOrigin) {
    return {
      'Access-Control-Allow-Origin': allowedOrigin === '*' ? '*' : origin,
      'Vary': 'Origin',
    }
  }
  return {}
}

function sendJson(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  })
  res.end(body)
}

async function main() {
  const host = process.env.ARMADA_VOICE_HOST || '127.0.0.1'
  const port = envInt('ARMADA_VOICE_PORT', 8086, 1, 65535)
  const publicOrigin = String(process.env.ARMADA_VOICE_PUBLIC_ORIGIN || '').replace(/\/$/, '')
  const livekitUrl = String(process.env.LIVEKIT_PUBLIC_URL || '').replace(/\/$/, '')
  const apiKey = String(process.env.LIVEKIT_API_KEY || '')
  const apiSecret = String(process.env.LIVEKIT_API_SECRET || '')
  const allowedOrigin = String(process.env.ARMADA_VOICE_CORS_ORIGIN || '*')
  const tokenTtl = envInt('ARMADA_VOICE_TOKEN_TTL_SECONDS', 3600, 60, 21600)

  if (!/^https:\/\//.test(publicOrigin)) throw new Error('ARMADA_VOICE_PUBLIC_ORIGIN must use https://')
  if (!/^wss:\/\//.test(livekitUrl)) throw new Error('LIVEKIT_PUBLIC_URL must use wss://')
  if (apiKey.length < 8 || apiSecret.length < 16) throw new Error('LiveKit API credentials are required')

  const replay = new ReplaySet(180)
  const ipLimiter = new FixedWindowLimiter(envInt('ARMADA_VOICE_IP_LIMIT_PER_MINUTE', 60, 5, 1000), 60)
  const roomLimiter = new FixedWindowLimiter(envInt('ARMADA_VOICE_ROOM_LIMIT_PER_MINUTE', 120, 5, 2000), 60)

  const server = createServer(async (req, res) => {
    try {
      const cors = corsHeaders(req, allowedOrigin)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...cors,
          'Access-Control-Allow-Headers': 'Authorization',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Cache-Control': 'no-store',
        })
        return res.end()
      }

      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, { ok: true, protocol: 'CORD-07' }, cors)
      }

      if (req.method === 'GET' && req.url === '/.well-known/concord/av') {
        res.writeHead(204, { ...cors, 'Cache-Control': 'no-store' })
        return res.end()
      }

      const m = req.url?.match(/^\/\.well-known\/concord\/av\/([0-9a-f]{64})$/)
      if (req.method !== 'GET' || !m) return sendJson(res, 404, { error: 'not_found' }, cors)

      const room = m[1]
      const ip = clientIp(req)
      if (!ipLimiter.allow(ip) || !roomLimiter.allow(room)) {
        return sendJson(res, 429, { error: 'rate_limited' }, { ...cors, 'Retry-After': '60' })
      }

      const url = expectedTokenUrl(publicOrigin, room)
      let grant
      try {
        grant = parseConcordAuthorization(req.headers.authorization)
      } catch {
        return sendJson(res, 401, { error: 'invalid_authorization' }, cors)
      }

      const checked = validateGrant(grant, room, url)
      if (!checked.ok) return sendJson(res, 401, { error: checked.error }, cors)
      if (!replay.consume(grant.id)) return sendJson(res, 409, { error: 'replayed_grant' }, cors)

      // Random SFU identity: never expose the channel/user Nostr identity to LiveKit.
      const identity = randomBytes(24).toString('hex')
      const token = await mintToken({ apiKey, apiSecret, room, identity, ttlSeconds: tokenTtl })
      return sendJson(res, 200, { token, url: livekitUrl, identity }, cors)
    } catch (err) {
      console.error('voice broker request failed:', String(err?.message || err))
      return sendJson(res, 500, { error: 'server_error' })
    }
  })

  server.listen(port, host, () => {
    console.log(`Glowstr Armada CORD-07 voice broker listening on ${host}:${port}; SFU=${livekitUrl}`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('fatal Armada voice error:', String(err?.message || err))
    process.exit(1)
  })
}
