#!/usr/bin/env node
// Smoke check for the LIVE relay, with no Monero transfer and no private keys.
// Usage: node smoke.mjs wss://relay.example/
import { WebSocket } from 'ws'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'

const relay = process.argv[2]
if (!relay || !/^wss:\/\//i.test(relay)) {
  console.error('Usage: node smoke.mjs wss://your-relay.example/')
  process.exit(2)
}

const secret = generateSecretKey()
const note = finalizeEvent({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['t', 'glowstr-launch-smoke-test']],
  content: 'Glowstr unpaid-write test - relay MUST reject this event',
}, secret)

let readOk = false
let unauthRejected = false
let authOk = false
let unpaidRejected = false
let sentAuth = false
let challenge = ''
const sid = 'glowstr-launch-probe'
const ws = new WebSocket(relay, {
  handshakeTimeout: 8000,
  perMessageDeflate: false,
  maxPayload: 262144,
})
const timer = setTimeout(() => {
  console.error('TIMEOUT: missing read/auth/write response')
  ws.terminate()
  process.exitCode = 1
}, 16000)

function send(v) { ws.send(JSON.stringify(v)) }
function finish() {
  if (!(readOk && unauthRejected && authOk && unpaidRejected)) return
  clearTimeout(timer)
  console.log('PASS: public Nostr reads are available')
  console.log('PASS: unauthenticated notes are rejected')
  console.log('PASS: fresh NIP-42 authentication succeeds')
  console.log('PASS: authenticated but unpaid notes are rejected')
  ws.close()
}

ws.on('open', () => {
  send(['REQ', sid, { kinds: [1], limit: 1 }])
  send(['EVENT', note])
})
ws.on('message', raw => {
  let msg
  try { msg = JSON.parse(raw.toString()) } catch { return }
  if (!Array.isArray(msg)) return

  if (msg[0] === 'EOSE' && msg[1] === sid) readOk = true
  if (msg[0] === 'AUTH' && typeof msg[1] === 'string') {
    challenge = msg[1]
  }
  if (msg[0] === 'OK' && msg[1] === note.id && msg[2] === false) {
    if (!sentAuth) unauthRejected = true
    else if (authOk) unpaidRejected = true
  }
  if (unauthRejected && challenge && !sentAuth) {
    sentAuth = true
    const auth = finalizeEvent({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['relay', relay], ['challenge', challenge]],
      content: '',
    }, secret)
    globalThis._authId = auth.id
    send(['AUTH', auth])
  }
  if (msg[0] === 'OK' && msg[1] === globalThis._authId) {
    if (msg[2] !== true) {
      console.error('FAIL: NIP-42 AUTH rejected:', msg[3])
      ws.close()
      process.exitCode = 1
      return
    }
    authOk = true
    send(['EVENT', note])
  }
  finish()
})
ws.on('error', err => {
  clearTimeout(timer)
  console.error('FAIL: WebSocket connection:', err.message)
  process.exitCode = 1
})
ws.on('close', () => {
  clearTimeout(timer)
  if (!(readOk && unauthRejected && authOk && unpaidRejected)) {
    console.error('FAIL: incomplete relay checks', { readOk, unauthRejected, authOk, unpaidRejected })
    process.exitCode = 1
  }
})
