import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent } from 'nostr-tools/pure';
import { fixture, response } from './helpers.mjs';
import { hash } from '../store.mjs';

function authorization(key,url,body){
  const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',url],['method','POST'],['payload',hash(body)]]},key);
  return 'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64');
}
async function challenge(f,name){
  return (await f.request('/fed-house/api/challenge?name='+encodeURIComponent(name))).value;
}
async function signedPost(f,path,name,key){
  const c=await challenge(f,name),body=JSON.stringify({challenge:c.challenge,name});
  return f.request(path,{method:'POST',body,headers:{Authorization:authorization(key,f.config.fedHouse.base+path.replace('/fed-house',''),body)}});
}
function setupFed(f){
  f.config.fedHouse.base=f.config.base+'/fed-house';
  f.config.fedHouse.origin=f.config.origin;
  f.config.fedHouse.allowedOrigins=new Set([f.config.origin]);
}

test('signed fed.house checkout reserves one permanent name and blocks competing claims',async t=>{
  const states=new Map(),seen=[];
  const f=await fixture(t,{CROSSPOST_COMMERCE_URL:'https://commerce.example',GLOWSTR_COMMERCE_ADMIN_TOKEN:'admin',FED_HOUSE_DOMAIN:'fed.house',FED_HOUSE_PUBLIC_URL:'http://localhost:8790/fed-house'},{fetcher:async(url,options={})=>{
    seen.push({url,options});
    if(url.endsWith('/v1/invoices')&&options.method==='POST'){
      assert.equal(options.headers.Authorization,'Bearer admin');
      const body=JSON.parse(options.body);assert.equal(body.feature,'fed_house_name');assert.equal(body.target,'alice');
      states.set('inv-alice','WAITING');
      return response({id:'inv-alice',token:'z'.repeat(40),status:'WAITING',address:'44alice',amount_atomic:7287300000,quote_usd_cents:400,xmr_usd:'548.90',uri:'monero:44alice?tx_amount=0.0072873',expires_at:Math.floor(Date.now()/1000)+1800,confirmations_required:2},201);
    }
    if(url.endsWith('/v1/invoices/inv-alice'))return response({id:'inv-alice',status:states.get('inv-alice'),confirmations:states.get('inv-alice')==='PAID'?2:0,confirmations_required:2,expires_at:Math.floor(Date.now()/1000)+1200});
    throw new Error('Unexpected '+url);
  }});
  setupFed(f);
  const available=await f.request('/fed-house/api/names/alice');assert.equal(available.value.available,true);
  const first=await signedPost(f,'/fed-house/api/claim','alice',f.key);assert.equal(first.status,201);assert.equal(first.value.identifier,'alice@fed.house');assert.equal(first.value.quoteUsdCents,400);assert.equal(first.value.permanent,false);assert.ok(first.value.claimToken);
  const replayBody=seen.find(x=>x.url.endsWith('/v1/invoices')).options.body;assert.ok(replayBody);
  const other=await signedPost(f,'/fed-house/api/claim','alice',f.otherKey);assert.equal(other.status,409);
  const row=f.store.db.prepare('SELECT * FROM name_claims WHERE name=?').get('alice');assert.equal(row.pubkey,f.owner);assert.equal(row.state,'WAITING');assert.equal(row.quote_usd_cents,400);
});

test('fed.house claim challenge is one-use and payment confirmation creates a permanent NIP-05 mapping',async t=>{
  let state='CONFIRMING';
  const f=await fixture(t,{CROSSPOST_COMMERCE_URL:'https://commerce.example',GLOWSTR_COMMERCE_ADMIN_TOKEN:'admin',FED_HOUSE_DOMAIN:'fed.house',FED_HOUSE_PUBLIC_URL:'http://localhost:8790/fed-house'},{fetcher:async(url,options={})=>{
    if(url.endsWith('/v1/invoices')&&options.method==='POST')return response({id:'inv-zoe',token:'q'.repeat(40),status:'WAITING',address:'44zoe',amount_atomic:7000000000,quote_usd_cents:400,xmr_usd:'571.42',uri:'monero:44zoe?tx_amount=0.007',expires_at:Math.floor(Date.now()/1000)+1800,confirmations_required:2},201);
    if(url.endsWith('/v1/invoices/inv-zoe'))return response({id:'inv-zoe',status:state,confirmations:state==='PAID'?2:1,confirmations_required:2,expires_at:Math.floor(Date.now()/1000)+1200});
    throw new Error('Unexpected '+url);
  }});
  setupFed(f);
  const c=await challenge(f,'zoe'),body=JSON.stringify({challenge:c.challenge,name:'zoe'}),auth=authorization(f.key,f.config.fedHouse.base+'/api/claim',body);
  const claim=await f.request('/fed-house/api/claim',{method:'POST',body,headers:{Authorization:auth}});assert.equal(claim.status,201);
  assert.equal((await f.request('/fed-house/api/claim',{method:'POST',body,headers:{Authorization:auth}})).status,401);
  let status=await f.request('/fed-house/api/claim/zoe',{headers:{Authorization:'Bearer '+claim.value.claimToken}});assert.equal(status.value.state,'CONFIRMING');assert.equal(status.value.confirmations,1);
  state='PAID';
  status=await f.request('/fed-house/api/claim/zoe',{headers:{Authorization:'Bearer '+claim.value.claimToken}});assert.equal(status.value.state,'ACTIVE');assert.equal(status.value.permanent,true);
  const nip05=await f.request('/.well-known/nostr.json?name=zoe');assert.equal(nip05.value.names.zoe,f.owner);assert.equal(nip05.headers.get('access-control-allow-origin'),'*');
  state='EXPIRED';
  status=await f.request('/fed-house/api/claim/zoe',{headers:{Authorization:'Bearer '+claim.value.claimToken}});assert.equal(status.value.state,'ACTIVE');
  assert.ok(f.store.db.prepare('SELECT activated_at FROM name_claims WHERE name=?').get('zoe').activated_at);
});

test('fed.house owner can recover an invoice on another device and expired unpaid reservations release',async t=>{
  const states={mia:'WAITING',old:'EXPIRED'};
  const f=await fixture(t,{CROSSPOST_COMMERCE_URL:'https://commerce.example',GLOWSTR_COMMERCE_ADMIN_TOKEN:'admin',FED_HOUSE_DOMAIN:'fed.house',FED_HOUSE_PUBLIC_URL:'http://localhost:8790/fed-house'},{fetcher:async(url,options={})=>{
    if(url.endsWith('/v1/invoices')&&options.method==='POST'){
      const body=JSON.parse(options.body),name=body.target;return response({id:'inv-'+name,token:(name==='mia'?'m':'o').repeat(40),status:'WAITING',address:'44'+name,amount_atomic:8000000000,quote_usd_cents:400,xmr_usd:'500',uri:'monero:44'+name+'?tx_amount=0.008',expires_at:Math.floor(Date.now()/1000)+1800,confirmations_required:2},201);
    }
    const name=url.endsWith('inv-mia')?'mia':url.endsWith('inv-old')?'old':null;
    if(name)return response({id:'inv-'+name,status:states[name],confirmations:0,confirmations_required:2,expires_at:Math.floor(Date.now()/1000)+(name==='old'?-1:1200)});
    throw new Error('Unexpected '+url);
  }});
  setupFed(f);
  const mia=await signedPost(f,'/fed-house/api/claim','mia',f.key);assert.equal(mia.status,201);
  const recovered=await signedPost(f,'/fed-house/api/recover','mia',f.key);assert.equal(recovered.status,200);assert.ok(recovered.value.claimToken);assert.notEqual(recovered.value.claimToken,mia.value.claimToken);
  assert.equal((await f.request('/fed-house/api/claim/mia',{headers:{Authorization:'Bearer '+mia.value.claimToken}})).status,401);
  assert.equal((await signedPost(f,'/fed-house/api/recover','mia',f.otherKey)).status,404);

  const old=await signedPost(f,'/fed-house/api/claim','old',f.key);assert.equal(old.status,201);
  const oldStatus=await f.request('/fed-house/api/claim/old',{headers:{Authorization:'Bearer '+old.value.claimToken}});assert.equal(oldStatus.value.state,'EXPIRED');
  assert.equal((await f.request('/fed-house/api/names/old')).value.available,true);
  states.old='WAITING';
  const replacement=await signedPost(f,'/fed-house/api/claim','old',f.otherKey);assert.equal(replacement.status,201);
  assert.equal(f.store.db.prepare('SELECT pubkey FROM name_claims WHERE name=?').get('old').pubkey,f.other);
});
