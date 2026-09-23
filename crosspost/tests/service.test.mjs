import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateSecretKey } from 'nostr-tools/pure';
import sharp from 'sharp';
import { fixture, connect, postBody, note, response } from './helpers.mjs';
import { inspectPost, validateSignedNote } from '../validation.mjs';

test('NIP-98 authenticates only allowed keys and binds the URL, method, body, time, and one-use challenge',async t=>{
  const f=await fixture(t),signed=await f.login();assert.equal(signed.status,200);assert.match(signed.headers.get('set-cookie'),/HttpOnly/);assert.match(signed.headers.get('set-cookie'),/SameSite=Strict/);
  assert.equal((await f.request('/api/login',{method:'POST',body:signed.body,headers:{Authorization:signed.authorization}})).status,401);
  for(const mutate of [e=>({...e,created_at:e.created_at-120}),e=>({...e,tags:e.tags.map(t=>t[0]==='u'?['u','https://evil.example']:t)}),e=>({...e,tags:[...e.tags,['method','POST']]})])assert.equal((await f.login(f.key,mutate)).status,401);
  assert.equal((await f.login(generateSecretKey())).status,401);
  assert.equal((await f.request('/api/login',{method:'POST',body:{challenge:'a'.repeat(64)},headers:{Authorization:signed.authorization}})).status,401);
});
test('sessions enforce CSRF, origin, credential secrecy, and owner-specific encryption',async t=>{
  const f=await fixture(t),session=await f.login();connect(f);assert.equal((await f.request('/api/me')).status,401);
  const me=(await f.request('/api/me',{session})).value;assert.equal(me.connections[0].identity,'123');assert.equal(me.connections[0].profileURL,'https://example.com/profile');assert.equal(JSON.stringify(me).includes('test-token'),false);
  for(const headers of [{Origin:'https://evil.example'},{'X-CSRF-Token':'wrong'}])assert.equal((await f.request('/api/logout',{method:'POST',body:{},session,headers})).status,403);
  const encrypted=f.store.db.prepare('SELECT secret FROM connections').get().secret;assert.equal(encrypted.includes('test-token'),false);assert.throws(()=>f.store.unseal(f.other,'x',encrypted));
  await f.request('/api/logout',{method:'POST',body:{},session});assert.equal((await f.request('/api/me',{session})).status,401);
});
test('preview mode blocks publishing; requests are idempotent and bound to reviewed identities',async t=>{
  const f=await fixture(t,{CROSSPOST_PREVIEW_ONLY:'true'}),session=await f.login();connect(f);const options={method:'POST',session,body:postBody(),headers:{'Idempotency-Key':randomUUID()}};
  assert.equal((await f.request('/api/posts',options)).status,409);f.config.previewOnly=false;
  const first=await f.request('/api/posts',options);assert.equal(first.status,202);assert.equal((await f.request('/api/posts',options)).value.id,first.value.id);
  assert.equal((await f.request('/api/posts',{...options,body:{...postBody(),text:'Changed'}})).status,409);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,1);
  assert.match(JSON.parse(f.store.db.prepare('SELECT payload FROM posts').get().payload).rkey,/^[234567a-z]{13}$/);
  connect(f,'x','different');assert.equal((await f.request('/api/posts',{...options,headers:{'Idempotency-Key':randomUUID()}})).status,409);
  const other=await f.login(f.otherKey);assert.deepEqual((await f.request('/api/posts',{session:other})).value.posts,[]);
});
test('same federated identity cannot receive two copies through Mastodon and ActivityPub slots',async t=>{
  const f=await fixture(t),session=await f.login();for(const platform of ['mastodon','activitypub'])connect(f,platform,'https://fedi.example:1');
  const body={text:'One post',destinations:['mastodon','activitypub'],expectedIdentities:{mastodon:'https://fedi.example:1',activitypub:'https://fedi.example:1'},confirmPublic:true};
  assert.match((await f.request('/api/preview',{method:'POST',session,body})).value.versions[0].errors.join(),/same federated account/);
  assert.equal((await f.request('/api/posts',{method:'POST',session,body,headers:{'Idempotency-Key':randomUUID()}})).status,400);
});
test('Nostr output accepts only the exact signed public top-level note',async t=>{
  const f=await fixture(t),session=await f.login(),send=event=>f.request('/api/posts',{method:'POST',session,headers:{'Idempotency-Key':randomUUID()},body:{text:'Public',destinations:['nostr'],event,confirmPublic:true}});
  assert.equal((await send(note(f.key,'Public'))).status,202);assert.equal((await send(note(f.otherKey,'Public'))).status,400);assert.equal((await send(note(f.key,'Other'))).status,400);assert.equal((await send(note(f.key,'Public',[['-']]))).status,400);
  assert.throws(()=>validateSignedNote(note(f.key,'Public',[['e','a'.repeat(64)]]),f.owner,'Public'));
});
test('images are stripped and normalized, private until queued, owner-scoped, and protected from cleanup after posting',async t=>{
  const f=await fixture(t),session=await f.login(),other=await f.login(f.otherKey);connect(f);
  const bytes=await sharp({create:{width:100,height:50,channels:3,background:'red'}}).png().withMetadata().toBuffer(),body={data:bytes.toString('base64'),alt:'Red rectangle'};
  const upload=await f.request('/api/media',{method:'POST',session,body});assert.equal(upload.status,201);const id=upload.value.id;
  assert.equal((await f.request('/media/'+id+'.jpg')).status,404);assert.equal((await f.request('/api/media/'+id,{session:other})).status,404);
  const metadata=await sharp((await f.request('/api/media/'+id,{session})).value).metadata();assert.equal(metadata.width,1080);assert.equal(metadata.height,1080);assert.equal(metadata.exif,undefined);
  assert.equal((await f.request('/api/preview',{method:'POST',session:other,body:{text:'Other',destinations:['nostr'],mediaId:id}})).status,400);
  assert.equal((await f.request('/api/posts',{method:'POST',session,body:{...postBody(),mediaId:id},headers:{'Idempotency-Key':randomUUID()}})).status,202);
  assert.equal((await f.request('/media/'+id+'.jpg')).status,200);assert.equal((await f.request('/api/media/'+id,{method:'DELETE',session})).status,400);
  await f.request('/api/media',{method:'POST',session,body});const otherImage=await f.request('/api/media',{method:'POST',session:other,body});assert.equal((await f.request('/api/media',{method:'DELETE',session})).value.removed,1);assert.equal((await f.request('/api/media/'+otherImage.value.id,{session:other})).status,200);assert.equal((await f.request('/media/'+id+'.jpg')).status,200);
});
test('platform versions enforce weighted X and Bluesky byte limits without changing text',()=>{
  const text='a'.repeat(281),versions=inspectPost({text,destinations:['x','bluesky'],overrides:{bluesky:'👩🏽‍💻'.repeat(300)}},{x:{},bluesky:{}});
  assert.match(versions[0].errors.join(),/Shorten/);assert.equal(versions[0].text,text);assert.equal(versions[1].count,300);assert.match(versions[1].errors.join(),/UTF-8/);
  assert.equal(inspectPost({text:'Check https://example.org/'+'a'.repeat(300),destinations:['x']},{x:{}})[0].count,29);
});
test('optional Monero membership fails closed and concurrent accepted requests queue once',async t=>{
  let active=false,broken=false;const f=await fixture(t,{CROSSPOST_COMMERCE_URL:'https://commerce.example',GLOWSTR_COMMERCE_ADMIN_TOKEN:'test-admin'},{fetcher:async()=>{if(broken)throw new Error();await new Promise(resolve=>setTimeout(resolve,10));return response({entitlements:active?[{feature:'crosspost_30d',target:'',valid_until:Math.floor(Date.now()/1000)+3600}]:[]});}});
  const session=await f.login();connect(f);const options={method:'POST',session,body:postBody(),headers:{'Idempotency-Key':randomUUID()}};
  assert.equal((await f.request('/api/posts',options)).status,402);broken=true;assert.equal((await f.request('/api/posts',options)).status,503);broken=false;active=true;
  const results=await Promise.all([f.request('/api/posts',options),f.request('/api/posts',options)]);assert.equal(results[0].value.id,results[1].value.id);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,1);
});
