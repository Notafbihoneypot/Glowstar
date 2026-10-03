// Exercises the shipped client functions with real Schnorr/NIP-44 crypto and a
// local in-memory NIP-46 relay. Never contacts a relay or uses an account key.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const path = require('node:path');
const source = fs.readFileSync(process.argv[2] || path.join(__dirname,'../glowstr-v5.3-bluetooth-direct.html'),'utf8');
function section(from,to) {
  const start=source.indexOf(from), end=source.indexOf(to,start+from.length);
  assert(start>=0 && end>=0, `Missing source section: ${from}`);
  return source.slice(start,end);
}
function storage() {
  const map=new Map();
  return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),clear:()=>map.clear(),map};
}
const elements=new Map();
const element=id=>{
  if(!elements.has(id)) elements.set(id,{value:'',checked:true,style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},remove(){},textContent:''});
  return elements.get(id);
};
const localStorage=storage(), sessionStorage=storage();
const nativeRecords=new Map();
const native={
  loadRememberedPublicState:()=>nativeRecords.get('public')||'',
  saveRememberedPublicState:raw=>{nativeRecords.set('public',raw);return true;},
  clearRememberedPublicState:()=>nativeRecords.delete('public'),
  loadRememberedRemoteSigner:pub=>{const raw=nativeRecords.get('remote');return raw&&JSON.parse(raw).publicKey===pub?raw:'';},
  saveRememberedRemoteSigner:raw=>{nativeRecords.set('remote',raw);return true;},
  clearRememberedRemoteSigner:()=>nativeRecords.delete('remote'),
  clearRememberedLocalSigner:()=>nativeRecords.delete('local'),
};
const c=vm.createContext({crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,console,setTimeout,clearTimeout,URL,URLSearchParams,btoa,atob,
  localStorage,sessionStorage, window:{GlowstrAndroid:native,addEventListener(){}}, document:{getElementById:element,addEventListener(){},visibilityState:'visible'},
  location:{protocol:'https:',origin:'https://test.invalid',pathname:'/'},
  showToast:()=>{},showLoggedIn:()=>{},stopQrLogin:()=>{},glowstrMaskPrivateKeyDisplay:()=>{},glowstrSyncPersistUi:()=>{},
  updateProfilesInFeed:()=>{},glowstrTrackEventRelay:()=>{},detectGlowstrClientContext:()=>({deviceClass:'desktop'})
});
vm.runInContext(`let state={profiles:{},publicKey:null,privateKey:null,signerMethod:null,nip46:null,persistKey:true,following:new Set(),relays:{}};`,c);
vm.runInContext(section('function hexToBytes(', '// Bech32 decoder'),c);
vm.runInContext(section('function generatePrivateKey(', '// BOOT'),c);
vm.runInContext(section('async function computeSharedSecret(', '// DM UI'),c);
vm.runInContext(section('function safeMeta(', 'function linkifyContent('),c);
vm.runInContext(section('function handleEvent(', 'function updateFollowingCount('),c);
vm.runInContext(section('const GLOWSTR_PUBLIC_STATE_KEY', 'function glowstrSyncPersistUi('),c);
vm.runInContext(section('function glowstrIsLocalSignerMethod(', 'function glowstrNativeSignerVaultAvailable('),c);
vm.runInContext(section('function glowstrClearNativeLocalSigner(', 'function glowstrReconnectSigner('),c);
vm.runInContext(section('function loadSavedState(', '// Persist the already-secret-free public session'),c);
vm.runInContext(section('const NIP46_REQUESTED_PERMS', '// === CLIENT CONTEXT'),c);
vm.runInContext(section('async function connectBunker(', '// Manual paste fallback:'),c);
vm.runInContext(section('async function nip44EncryptUniversal(', 'function randomPastTimestamp('),c);
vm.runInContext(section('async function nip46Sign(', '// SW:'),c);
vm.runInContext(section('function logout()', 'function glowstrMaskPrivateKeyDisplay('),c);
c._walletCapabilityState=null;
const run=code=>vm.runInContext(code.includes('await ') ? '(async()=>{return '+code+';})()' : code,c);
let passed=0;
function pass(name) {++passed;console.log(`PASS ${name}`);}

// Server implements NIP-46 using an independent transport key, as Igloo does.
vm.runInContext(`const testAccountSecret='0'.repeat(63)+'3', testSignerSecret='0'.repeat(63)+'4', testRecipientSecret='0'.repeat(63)+'5';
let testMode='normal'; const testRequests=[];
async function testRespond(ws, request) {
  if (!(await verifyEvent(request))) throw new Error('Client request signature invalid');
  const payload=JSON.parse(await nip44Decrypt(request.content,testSignerSecret,request.pubkey));
  testRequests.push(payload);
  if(testMode==='timeout' || testMode==='pending') return;
  if(testMode==='disconnect') {ws.close();return;}
  let result, error;
  if(testMode==='deny' && payload.method==='sign_event') error='User denied request';
  else if(payload.method==='connect') result='ack';
  else if(payload.method==='get_public_key') result=await derivePublicKey(testAccountSecret);
  else if(payload.method==='switch_relays') result=[];
  else if(payload.method==='logout') result='ack';
  else if(payload.method==='ping') result='pong';
  else if(payload.method==='sign_event') {
    const tpl=JSON.parse(payload.params[0]);
    if(testMode==='changed-template') tpl.content='Unexpected signer content';
    result=JSON.stringify(await signNostrEvent(tpl,testAccountSecret));
  } else if(payload.method==='nip44_encrypt') result=await nip44Encrypt(payload.params[1],testAccountSecret,payload.params[0]);
  else if(payload.method==='nip44_decrypt') result=await nip44Decrypt(payload.params[1],testAccountSecret,payload.params[0]);
  else error='Unsupported method';
  const reply=async (id,secret=testSignerSecret,sid=ws.sid,tamper=false) => {
    const content=await nip44Encrypt(JSON.stringify({id,result,error}),secret,request.pubkey);
    const event=await signNostrEvent({kind:24133,created_at:Math.floor(Date.now()/1000),tags:[['p',request.pubkey]],content},secret);
    if(tamper) event.content+='x';
    if(ws.readyState===WebSocket.OPEN) await ws.onmessage?.({data:JSON.stringify(['EVENT',sid,event])});
  };
  if(testMode==='noise') {
    await reply('wrong-request-id');
    await reply(payload.id,testAccountSecret);
    await reply(payload.id,testSignerSecret,'wrong-subscription');
    await reply(payload.id,testSignerSecret,ws.sid,true);
  }
  await reply(payload.id);
}`,c);
class FakeSocket {
  static OPEN=1;
  constructor(url) {this.url=url;this.readyState=0;setTimeout(()=>{if(this.readyState!==3){this.readyState=1;this.onopen?.();}},0);}
  send(data) {
    const parsed=JSON.parse(data);
    if(parsed[0]==='REQ') this.sid=parsed[1];
    if(parsed[0]==='EVENT') {c.testSocket=this;c.testRequest=parsed[1];run('testRespond(testSocket,testRequest)').catch(e=>{console.error(e);this.onerror?.();});}
  }
  close() {if(this.readyState===3)return;this.readyState=3;this.onclose?.();}
}
c.WebSocket=FakeSocket;
(async()=>{
  await run(`(async()=>{
    const original=await signNostrEvent({kind:0,created_at:1700000000,tags:[],content:JSON.stringify({name:'Honest',xmr:'honest-test-address'})},testAccountSecret);
    await acceptVerifiedRelayEvent(original,'local-original');
    for(const changed of [{content:'Forged'},{created_at:original.created_at+1},{kind:1},{tags:[['p','a'.repeat(64)]]},{pubkey:await derivePublicKey(testSignerSecret)},{sig:'0'.repeat(128)}]) {
      if(await glowstrVerifyAndCache({...original,...changed})) throw new Error('Forged cached event accepted');
    }
    const forged={...original,content:JSON.stringify({name:'Forged',xmr:'attacker-test-address'})};
    if(await acceptVerifiedRelayEvent(forged,'local-forged')) throw new Error('Profile forgery accepted');
    if(state.profiles[original.pubkey].xmr!=='honest-test-address') throw new Error('Tip address overwritten');
    const genuine=await signNostrEvent({kind:1,created_at:1700000001,tags:[],content:'Genuine'},testAccountSecret);
    if(await glowstrVerifyAndCache({...genuine,content:'Poison'})) throw new Error('Poison accepted');
    if(!(await glowstrVerifyAndCache(genuine))) throw new Error('Valid event poisoned');
  })()`);
  pass('all event bodies and signatures verified; rejected IDs cannot poison valid events');
  await run(`(async()=>{
    state.privateKey=testAccountSecret;state.publicKey=await derivePublicKey(testAccountSecret);state.signerMethod='frostr';state.nip46=null;
    if(canSignInline()) throw new Error('FROSTR silently enables local signing');
  })()`);
  await assert.rejects(run(`signEventUniversal({kind:1,created_at:1700000002,tags:[],content:'No quorum'})`),/unavailable/);
  await assert.rejects(run(`nip44EncryptUniversal('No fallback', 'a'.repeat(64))`),/does not provide/);
  pass('no local-key fallback for remote signing or encryption');
  const account=await run('derivePublicKey(testAccountSecret)'),signer=await run('derivePublicKey(testSignerSecret)');
  c.url=`bunker://${signer}?relay=wss%3A%2F%2Frelay.test.invalid&secret=one-time-test`;
  c.account=account;
  assert.equal(await run(`connectBunker(url,{method:'frostr',expectedPublicKey:account})`),true);
  assert.equal(run('state.privateKey'),null);
  assert.equal(run('state.signerMethod'),'frostr');
  assert(!localStorage.getItem('glowstr_state').includes('clientPrivKey'));
  const record=JSON.parse(nativeRecords.get('remote'));
  assert.equal(record.publicKey,account);assert.equal(record.nip46.secret,undefined);
  assert(!JSON.stringify(record).includes('one-time-test'));
  assert(!run('NIP46_REQUESTED_PERMS').split(',').includes('sign_event'));
  pass('FROSTR handshake, separate transport/account keys, scoped permissions, one-time secret disposal');
  const signed=await run(`signEventUniversal({kind:1,created_at:1700000003,tags:[],content:'Threshold-backed note'})`);
  assert.equal(signed.pubkey,account);c.signed=signed;assert(await run('verifyEvent(signed)'));
  const encrypted=await run(`nip44EncryptUniversal('Private message', await derivePublicKey(testRecipientSecret))`);c.encrypted=encrypted;
  assert.equal(await run(`nip44DecryptUniversal(encrypted,await derivePublicKey(testRecipientSecret))`),'Private message');
  await assert.rejects(run(`encryptDmUniversal('Legacy',await derivePublicKey(testRecipientSecret))`),/NIP-17/);
  pass('remote event signing and NIP-44 messaging; FROSTR legacy NIP-04 disabled');
  run(`testMode='noise'`);assert.equal(await run(`nip46Request('ping',[],5000)`),'pong');
  pass('forged body, wrong author, request ID and subscription responses ignored');
  run(`testMode='changed-template'`);
  await assert.rejects(run(`signEventUniversal({kind:1,created_at:1700000004,tags:[],content:'Expected content'})`),/mismatch|changed|requested/i);
  run(`testMode='deny'`);
  await assert.rejects(run(`signEventUniversal({kind:1,created_at:1700000004,tags:[],content:'Denied'})`),/denied/);
  run(`testMode='disconnect'`);await assert.rejects(run(`nip46Request('ping',[],1000)`),/disconnected/);
  run(`testMode='timeout'`);await assert.rejects(run(`nip46Request('ping',[],40)`),/timeout/);
  assert.equal(run('_glowstrNip46Pending.size'),0);
  pass('signer changes, denial, disconnect and timeout fail closed and clean up');
  // Native process restart: tab storage disappears; restore only the matching account.
  run(`testMode='normal';state.privateKey=null;state.publicKey=null;state.nip46=null;state.signerMethod=null;`);
  sessionStorage.clear();run('loadSavedState()');assert.equal(run('state.signerMethod'),'frostr');assert.equal(run('state.privateKey'),null);
  assert.equal(await run(`nip46Request('ping',[],1000)`),'pong');
  const publicRecord=JSON.parse(nativeRecords.get('public')); publicRecord.publicKey=signer;
  nativeRecords.set('public',JSON.stringify(publicRecord));
  run(`state.publicKey=null;state.nip46=null;state.signerMethod=null;`);sessionStorage.clear();run('loadSavedState()');
  assert.equal(run('state.nip46'),null);
  pass('Android restart retains remote session; mismatched account cannot restore it');
  assert.equal(await run(`connectBunker(url,{method:'frostr',expectedPublicKey:'a'.repeat(64)})`),false);
  assert.equal(run('state.nip46'),null);assert.equal(run('state.privateKey'),null);assert.equal(nativeRecords.has('remote'),false);
  pass('wrong FROSTR npub rejects connection and erases failed session');
  assert.equal(await run(`connectBunker(url,{method:'frostr',expectedPublicKey:account})`),true);
  run(`testMode='pending'`);
  const pending=run(`nip46Request('ping',[],1000)`);const rejected=assert.rejects(pending,/session changed/);
  for(let i=0;i<100 && !run('_glowstrNip46Pending.size');i++) await new Promise(r=>setTimeout(r,2));
  run('glowstrResetSigner()');await rejected;
  assert.equal(run('_glowstrNip46Pending.size'),0);assert.equal(nativeRecords.has('remote'),false);assert.equal(sessionStorage.getItem('glowstr_session_secrets_v2'),null);
  pass('account change cancels in-flight requests and deletes native and tab sessions');

  // Account-scoped data must not leak when selecting a different FROSTR identity.
  run(`(()=>{
    const dmId='d'.repeat(64);
    state.following=new Set(['1'.repeat(64)]);
    state.followEvent={id:'old-follow'};
    state.followSets={old:{id:'old',members:new Set(['2'.repeat(64)])}};
    state.selectedFollowSet='old';
    state.networkMutedPubkeys=new Set(['3'.repeat(64)]);
    state.networkMutedWords=new Set(['spam']);
    state.networkMutedTags=new Set(['old-account']);
    state.networkMutedEvents=new Set(['4'.repeat(64)]);
    state.muteEvent={id:'old-mute'};
    state.dms=[{id:dmId,pubkey:'5'.repeat(64),content:'old account dm'}];
    state.eventIds.add(dmId);
    state.activeDmPubkey='5'.repeat(64);
    state._dmEventIds=new Set([dmId]);
    state.notifications=[{dupeKey:'old-account-notification',created_at:1700000000}];
    state.notifReadTs=1700000000;
    state.reactedIds=new Set(['6'.repeat(64)]);
    state.replyTo={id:'old-reply'};
    state.activeTip={pubkey:'7'.repeat(64)};
    state.pendingUsername={name:'old-account'};
    state.activeXmrInvoice={id:'old-invoice'};
    state.feedBuffer=[{id:'old-feed'}];
    state._feedSelectionCache={old:true};
    state._cachedAuthors=['8'.repeat(64)];
    state._cachedAuthorsAt=Date.now();
  })()`);
  run('glowstrResetSigner()');
  assert.equal(run('state.following.size'),0);
  assert.equal(run('state.followEvent'),null);
  assert.equal(run('Object.keys(state.followSets).length'),0);
  assert.equal(run('state.selectedFollowSet'),null);
  assert.equal(run('state.networkMutedPubkeys.size+state.networkMutedWords.size+state.networkMutedTags.size+state.networkMutedEvents.size'),0);
  assert.equal(run('state.muteEvent'),null);
  assert.equal(run('state.dms.length'),0);
  assert.equal(run('state.activeDmPubkey'),null);
  assert.equal(run('state._dmEventIds.size'),0);
  assert.equal(run("state.eventIds.has('d'.repeat(64))"),false);
  assert.equal(run('state.notifications.length'),0);
  assert.equal(run('state.notifReadTs'),0);
  assert.equal(run('state.reactedIds.size'),0);
  assert.equal(run('state.replyTo'),null);
  assert.equal(run('state.activeTip'),null);
  assert.equal(run('state.pendingUsername'),null);
  assert.equal(run('state.activeXmrInvoice'),null);
  assert.equal(run('state.feedBuffer.length'),0);
  assert.equal(run('state._feedSelectionCache'),null);
  assert.equal(run('state._cachedAuthors'),null);
  pass('account switch clears follows, DMs, mutes, notifications, reactions, invoice UI, and feed selection');

  assert.equal(await run(`connectBunker('bunker://'+await derivePublicKey(testSignerSecret)+'?relay=ws://unsafe.invalid',{method:'frostr',expectedPublicKey:account})`),false);
  pass('insecure signer relay URLs rejected');
  run(`testMode='normal'`);
  assert.equal(await run(`connectBunker(url,{method:'frostr',expectedPublicKey:account})`),true);
  run('logout()');
  assert.equal(run('state.privateKey'),null);assert.equal(run('state.publicKey'),null);assert.equal(run('state.nip46'),null);
  assert.equal(nativeRecords.has('remote'),false);assert.equal(nativeRecords.has('public'),false);
  assert.equal(sessionStorage.getItem('glowstr_session_secrets_v2'),null);
  for(let i=0;i<200 && !run("testRequests.some(r=>r.method==='logout')");i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(run("testRequests.some(r=>r.method==='logout')"),true);
  pass('logout erases local identity and sends authenticated signer revocation');
  console.log(`${passed} security regression groups passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
