import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, connect, postBody, note, response } from './helpers.mjs';
import { createPublisher, makeAPI, verifyConnection, publishNostr } from '../adapters.mjs';
import { openStore } from '../store.mjs';
test('ambiguous publishing is quarantined and retry needs owner consent',async t=>{
  let calls=0;const f=await fixture(t,{}, {publish:async(_p,_post,_c,_m,ctx)=>{calls++;ctx.markPublishing();throw new Error('Interrupted');}});connect(f);const session=await f.login(),other=await f.login(f.otherKey);
  const queued=await f.request('/api/posts',{method:'POST',session,body:postBody(),headers:{'Idempotency-Key':randomUUID()}}),id=queued.value.deliveries[0].id;
  await f.worker.tick();await f.worker.tick();assert.equal(calls,1);assert.equal(f.store.db.prepare('SELECT status FROM deliveries').get().status,'uncertain');
  assert.equal((await f.request('/api/deliveries/'+id+'/retry',{method:'POST',session:other,body:{acceptDuplicateRisk:true}})).status,404);
  assert.equal((await f.request('/api/deliveries/'+id+'/retry',{method:'POST',session,body:{}})).status,409);
  assert.equal((await f.request('/api/deliveries/'+id+'/retry',{method:'POST',session,body:{acceptDuplicateRisk:true}})).status,200);await f.worker.tick();assert.equal(calls,2);
});
test('changing a linked account never redirects an existing queued post',async t=>{
  let calls=0;const f=await fixture(t,{}, {publish:async()=>{calls++;return{id:'result'};}});connect(f);const session=await f.login();await f.request('/api/posts',{method:'POST',session,body:postBody(),headers:{'Idempotency-Key':randomUUID()}});connect(f,'x','other');await f.worker.tick();assert.equal(calls,0);assert.equal(f.store.db.prepare('SELECT status FROM deliveries').get().status,'failed');
});
test('restart resumes preparation but does not repeat in-flight publication',async t=>{
  const f=await fixture(t),session=await f.login();connect(f);for(let i=0;i<2;i++)await f.request('/api/posts',{method:'POST',session,body:postBody(),headers:{'Idempotency-Key':randomUUID()}});
  const rows=f.store.db.prepare('SELECT id FROM deliveries ORDER BY id').all();f.store.db.prepare("UPDATE deliveries SET status='publishing' WHERE id=?").run(rows[0].id);f.store.db.prepare("UPDATE deliveries SET status='working' WHERE id=?").run(rows[1].id);
  const reopened=openStore(f.config);assert.deepEqual(reopened.db.prepare('SELECT status FROM deliveries ORDER BY id').all().map(r=>r.status),['uncertain','queued']);reopened.close();
});
test('HTTP rate limits and media processing retry safely while publishing outages remain uncertain',async()=>{
  const ctx={markPublishing(){}};
  await assert.rejects(makeAPI(async()=>response({},429,{'retry-after':'120'}))('https://api.example',{},ctx,true),e=>e.state==='retrying'&&e.delay===120000);
  await assert.rejects(makeAPI(async()=>response({},503))('https://api.example',{},ctx,true),e=>e.state==='uncertain');
  await assert.rejects(makeAPI(async()=>{throw new Error();})('https://api.example',{},ctx,true),e=>e.state==='uncertain');
  await assert.rejects(makeAPI(async()=>new Response(null,{status:206}))('https://api.example'),e=>e.state==='retrying');
});
test('all HTTP adapters preserve identities and content, and use compatible publication APIs',async t=>{
  const f=await fixture(t),calls=[],media={id:'c'.repeat(64),alt:'Sample image',width:1080,height:1080};await writeFile(join(f.data,'media',media.id+'.jpg'),Buffer.from('fake-jpeg'));
  const fetcher=async(url,options)=>{calls.push({url,options,json:typeof options.body==='string'?JSON.parse(options.body):null});
    if(url.endsWith('/2/media/upload'))return response({data:{id:'x-media'}});if(url.endsWith('/2/tweets'))return response({data:{id:'x-post'}});
    if(url.endsWith('/api/v2/media')||url.endsWith('/api/v1/media'))return response({id:'media',url:'https://fedi.example/image.jpg'});if(url.endsWith('/api/v1/statuses'))return response({id:'status',url:'https://fedi.example/status'});
    if(url.endsWith('refreshSession'))return response({did:'did:plc:test',accessJwt:'new-access',refreshJwt:'new-refresh'});if(url.endsWith('uploadBlob'))return response({blob:{$type:'blob',ref:{$link:'cid'},mimeType:'image/jpeg',size:9}});if(url.endsWith('putRecord'))return response({uri:'at://did:plc:test/app.bsky.feed.post/3mabc23456789'});throw new Error('Unexpected endpoint');};
  const publisher=createPublisher(f.config,f.store,{fetcher}),post={id:'stable-job',owner:f.owner,created:Date.now(),text:'Hi 🌍 https://example.org',overrides:{x:'X version'},rkey:'3mabc23456789'};
  const accounts={x:{identity:'123',secret:{accessToken:'x-token'}},mastodon:{identity:'masto:1',secret:{server:'https://mastodon.social',accessToken:'m-token'}},activitypub:{identity:'fedi:2',secret:{server:'https://fedi.example',accessToken:'ap-token'}},bluesky:{identity:'did:plc:test',secret:{pds:'https://bsky.social',accessToken:'old',refreshToken:'refresh'}}};
  for(const [platform,account]of Object.entries(accounts)){f.store.saveConnection(f.owner,platform,{...account,label:'Test'});const ctx={checkpoint:{},save(v){Object.assign(this.checkpoint,v);},markPublishing(){}};assert.ok((await publisher(platform,post,f.store.connection(f.owner,platform),media,ctx)).id);}
  const get=suffix=>calls.find(c=>c.url.endsWith(suffix));assert.deepEqual(get('/2/tweets').json,{text:'X version',media:{media_ids:['x-media']}});assert.equal(get('/api/v1/statuses').json.visibility,'public');assert.equal(get('/api/v1/statuses').options.headers['Idempotency-Key'],post.id);
  assert.ok(calls.some(c=>c.url==='https://fedi.example/api/v1/media'));assert.equal(get('/api/v1/media').options.body.get('description'),media.alt);
  const record=get('putRecord').json;assert.equal(record.repo,'did:plc:test');assert.equal(record.rkey,post.rkey);assert.equal(record.record.embed.images[0].alt,media.alt);const facet=record.record.facets[0];assert.equal(Buffer.from(post.text).subarray(facet.index.byteStart,facet.index.byteEnd).toString(),'https://example.org');assert.equal(f.store.connection(f.owner,'bluesky').secret.refreshToken,'new-refresh');assert.ok(calls.every(c=>c.options.redirect==='error'));
});
test('Nostr sends an unchanged signed event and requires acknowledgement',async()=>{
  const event=note(new Uint8Array(32).fill(1),'Public'),sent=[];class Socket extends EventTarget{constructor(url){super();this.url=url;queueMicrotask(()=>this.dispatchEvent(new Event('open')));}send(raw){sent.push(JSON.parse(raw));queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(['OK',event.id,this.url.endsWith('good')])})));}close(){this.dispatchEvent(new Event('close'));}}
  const result=await publishNostr(event,['wss://relay/good','wss://relay/bad'],Socket);assert.equal(result.id,event.id);assert.deepEqual(sent[0],JSON.parse(JSON.stringify(['EVENT',event])));await assert.rejects(publishNostr(event,['wss://relay/bad'],Socket),e=>e.state==='retrying');
});
test('identity verification restricts token destinations and records stable identities and profile links',async t=>{
  const f=await fixture(t);let calls=0;await assert.rejects(verifyConnection('activitypub',{server:'https://127.0.0.1',accessToken:'secret'},f.config,async()=>{calls++;}));assert.equal(calls,0);
  const bsky=await verifyConnection('bluesky',{identifier:'me.bsky.social',appPassword:'app-password'},f.config,async()=>({did:'did:plc:test',handle:'me.bsky.social',accessJwt:'access',refreshJwt:'refresh',didDoc:{service:[{id:'#atproto_pds',serviceEndpoint:'https://example.host.bsky.network'}]}}));assert.equal(bsky.identity,'did:plc:test');assert.equal(JSON.stringify(bsky).includes('app-password'),false);assert.match(bsky.profileURL,/bsky.app/);
  const ap=await verifyConnection('activitypub',{server:'https://fedi.example',accessToken:'token'},f.config,async url=>url.includes('verify_credentials')?{id:'17',acct:'alice',url:'https://fedi.example/users/alice'}:{configuration:{statuses:{max_characters:5000}}});assert.equal(ap.identity,'https://fedi.example:17');assert.equal(ap.label,'@alice@fedi.example');assert.equal(ap.secret.limit,5000);
  await assert.rejects(verifyConnection('bluesky',{identifier:'me',appPassword:'pw'},f.config,async()=>({did:'did:plc:test',accessJwt:'a',refreshJwt:'r',didDoc:{service:[{id:'#atproto_pds',serviceEndpoint:'https://evil.example'}]}})));
});
