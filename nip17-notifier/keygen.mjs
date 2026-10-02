#!/usr/bin/env node
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'

import * as nip19 from 'nostr-tools/nip19'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const target = resolve(process.argv[2] || '../xmr-relay/secrets/notifier.key')

try {
  await access(target, constants.F_OK)
  console.error('Refusing to overwrite existing notifier key:', target)
  process.exit(2)
} catch {}

await mkdir(dirname(target), { recursive: true, mode: 0o700 })
const secret = generateSecretKey()
const secretHex = Buffer.from(secret).toString('hex')
const pubkey = getPublicKey(secret)

await writeFile(target, secretHex + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
await chmod(target, 0o600)

console.log('Created dedicated Glowstr NIP-17 notifier key:', target)
console.log('Public hex key:', pubkey)
console.log('Public npub:', nip19.npubEncode(pubkey))
console.log('')
console.log('Set this in xmr-relay/.env:')
console.log('GLOWSTR_NIP17_PUBLIC_KEY=' + pubkey)
console.log('')
console.log('The secret key was written only to the file above. Do not commit or paste it into Glowstr.')
