import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent } from 'nostr-tools/pure';
import { fixture,response } from './helpers.mjs';

test('creator login, stream creation and MediaMTX publish key are owner-scoped',async t=>{
  const f=await fixture(t),session=await f.login();assert.equal(session.status,200);
  const created=await f.request('/api/dashboard/streams',{method:'POST',session,body:{title:'Test live',summary:'Hello',goalAtomic:'1000000000000'}});
  assert.equal(created.status,201);assert.match(created.value.id,/^[a-f0-9]{24}$/);assert.match(created.value.obs.streamKey,/token=[a-f0-9]{64}$/);
  const secret=created.value.obs.streamKey.split('token=')[1],path='live/'+created.value.id;
  assert.equal((await f.request('/mediamtx/auth',{method:'POST',body:{action:'publish',path,token:secret}})).status,204);
  assert.equal((await f.request('/mediamtx/auth',{method:'POST',body:{action:'publish',path,token:'bad'}})).status,401);
  assert.equal((await f.request('/mediamtx/auth',{method:'POST',body:{action:'read',path}})).status,204);
  const dashboard=await f.request('/api/dashboard/streams',{session});assert.equal(dashboard.value.streams[0].obs.streamKey,'<hidden>');
  assert.equal((await f.login(f.otherKey)).status,401);
});

test('only the creator can publish an exact signed NIP-53 stream event',async t=>{
  const f=await fixture(t),session=await f.login();
  const created=(await f.request('/api/dashboard/streams',{method:'POST',session,body:{title:'NIP53',summary:'stream'}})).value;
  const make=(key,streaming=created.hls,status='live')=>finalizeEvent({kind:30311,created_at:Math.floor(Date.now()/1000),content:'',tags:[
    ['d',created.id],['title','NIP53'],['summary','stream'],['streaming',streaming],['starts',String(Math.floor(Date.now()/1000))],['status',status],['p',f.owner,'','Host']
  ]},key);
  const ok=await f.request('/api/dashboard/streams/'+created.id+'/event',{method:'POST',session,body:{event:make(f.key)}});assert.equal(ok.status,202);assert.equal(ok.value.stream.status,'live');assert.equal(f.published.at(-1).kind,30311);
  assert.equal((await f.request('/api/dashboard/streams/'+created.id+'/event',{method:'POST',session,body:{event:make(f.otherKey)}})).status,400);
  assert.equal((await f.request('/api/dashboard/streams/'+created.id+'/event',{method:'POST',session,body:{event:make(f.key,'https://evil.example/live.m3u8')}})).status,400);
});

test('NIP-53 chat requires a valid signed kind 1311 bound to the stream address',async t=>{
  const f=await fixture(t),session=await f.login(),stream=(await f.request('/api/dashboard/streams',{method:'POST',session,body:{title:'Chat'}})).value;
  const good=finalizeEvent({kind:1311,created_at:Math.floor(Date.now()/1000),content:'hello live',tags:[['a','30311:'+f.owner+':'+stream.id,'','root']]},f.otherKey);
  assert.equal((await f.request('/api/streams/'+stream.id+'/chat',{method:'POST',body:{event:good}})).status,202);
  const chat=await f.request('/api/streams/'+stream.id+'/chat');assert.equal(chat.value.events[0].content,'hello live');
  const bad=finalizeEvent({kind:1311,created_at:Math.floor(Date.now()/1000),content:'wrong',tags:[['a','30311:'+f.owner+':other','','root']]},f.otherKey);
  assert.equal((await f.request('/api/streams/'+stream.id+'/chat',{method:'POST',body:{event:bad}})).status,400);
});

test('XMR live tips create dynamic Commerce invoices and become visible only after payment',async t=>{
  let invoiceState='WAITING',streamId;
  const f=await fixture(t,{LIVE_COMMERCE_URL:'https://commerce.example',GLOWSTR_COMMERCE_ADMIN_TOKEN:'admin'},{fetcher:async(url,options={})=>{
    if(url.endsWith('/v1/invoices')&&options.method==='POST'){
      assert.equal(options.headers.Authorization,'Bearer admin');const body=JSON.parse(options.body);assert.equal(body.feature,'live_tip');assert.equal(body.target,streamId);assert.equal(body.amount_atomic,'5000000000');assert.equal(body.pubkey,f.owner);
      return response({id:'tip-invoice',token:'z'.repeat(40),status:'WAITING',address:'44tip',amount_atomic:5000000000,uri:'monero:44tip?tx_amount=0.005',expires_at:Math.floor(Date.now()/1000)+1800,confirmations_required:2},201);
    }
    if(url.endsWith('/v1/invoices/tip-invoice'))return response({id:'tip-invoice',status:invoiceState,confirmations:invoiceState==='PAID'?2:0,confirmations_required:2,expires_at:Math.floor(Date.now()/1000)+1200});
    throw new Error('Unexpected '+url);
  }});
  const session=await f.login(),stream=(await f.request('/api/dashboard/streams',{method:'POST',session,body:{title:'Tips'}})).value;streamId=stream.id;
  const tip=await f.request('/api/streams/'+stream.id+'/tips',{method:'POST',body:{amountAtomic:'5000000000',message:'based'}});assert.equal(tip.status,201);
  assert.equal((await f.request('/api/streams/'+stream.id+'/tips')).value.tips.length,0);
  let status=await f.request('/api/tips/'+tip.value.id,{headers:{Authorization:'Bearer '+tip.value.token}});assert.equal(status.value.status,'WAITING');
  invoiceState='PAID';status=await f.request('/api/tips/'+tip.value.id,{headers:{Authorization:'Bearer '+tip.value.token}});assert.equal(status.value.status,'PAID');
  const paid=await f.request('/api/streams/'+stream.id+'/tips');assert.equal(paid.value.tips[0].amount,5000000000);assert.equal(paid.value.tips[0].message,'based');
  const publicStream=await f.request('/api/streams/'+stream.id);assert.equal(publicStream.value.totalAtomic,5000000000);
});
