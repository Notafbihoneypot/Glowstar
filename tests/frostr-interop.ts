// Optional interoperability test. Run with a Bifrost checkout's tsx loader
// and test/tsconfig.json; see docs/FROSTR.md. Only disposable shares are created.
import { generate_dealer_package } from '@/lib/index.js'
import { create_network_fixture } from '@/test/lib/fixtures.js'
import { createTestContext } from '@/test/lib/test-context.js'
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import path from 'node:path'

async function main() {
  const pkg=generate_dealer_package(2,3)
  const ctx=createTestContext()
  const fixture=await create_network_fixture(ctx,{group:pkg.group,shares:pkg.shares.slice(0,2),seeds:[]},{nonceCount:20,nodeConfig:{request_timeout:1500}})
  try {
    const source=fs.readFileSync(process.argv[2] || path.resolve('glowstr-v5.3-bluetooth-direct.html'),'utf8')
    const start=source.indexOf('function hexToBytes('),end=source.indexOf('// Bech32 decoder',start)
    const c=vm.createContext({crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,console,setTimeout,clearTimeout,URL,window:{}})
    vm.runInContext(source.slice(start,end),c)
    const pubkey=fixture.group.group_pk.slice(-64)
    c.pubkey=pubkey
    c.tpl={pubkey,kind:1,created_at:1700000000,tags:[],content:'FROSTR 2-of-3 interoperability test'}
    const hash=await vm.runInContext(`sha256(JSON.stringify([0,tpl.pubkey,tpl.created_at,tpl.kind,tpl.tags,tpl.content])).then(bytesToHex)`,c)
    const alice=fixture.nodes.get('alice')!, bob=fixture.nodes.get('bob')!
    // An offline backup share leaves exactly the required two participants.
    // Only Alice and Bob were started. The third share stays offline.
    const result=await alice.req.sign(hash)
    assert.equal(result.ok,true,JSON.stringify(result))
    const data=Array.isArray(result.data[0])?result.data[0]:result.data
    assert.equal(data[0],hash)
    assert.equal(data[1].slice(-64),pubkey)
    c.event={...c.tpl,id:hash,sig:data[2]}
    assert.equal(await vm.runInContext('verifyEvent(event)',c),true)
    console.log('PASS Glowstr accepts a real FROSTR Bifrost 2-of-3 signature with the backup node offline')
    await bob.client.close()
    const newHash=await vm.runInContext(`sha256('Fresh message after quorum loss').then(bytesToHex)`,c)
    const noQuorum=await alice.req.sign(newHash)
    assert.equal(noQuorum.ok,false)
    console.log('PASS below-threshold FROSTR request refuses to sign')
  } finally {
    // Bifrost 2.0.2's close() calls a missing SDK clear() method. Shut down the
    // underlying transports explicitly so this interoperability test can exit.
    for (const node of fixture.nodes.values()) {
      try { await node.close() } catch(e) { await node.client.close() }
    }
    try { await fixture.cleanup() } catch(e) { /* transports already closed */ }
  }
}
main().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})
