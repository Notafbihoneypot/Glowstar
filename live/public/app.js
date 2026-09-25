let me=null,currentStream=null,chatTimer=null,streamTimer=null,tipTimer=null,lastObs=new Map();

const $=id=>document.getElementById(id);
const toast=message=>{const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),2800);};
const short=value=>value?value.slice(0,8)+'…'+value.slice(-5):'';
const xmr=atomic=>{try{const n=BigInt(atomic||0),w=n/1000000000000n,f=(n%1000000000000n).toString().padStart(12,'0').replace(/0+$/,'');return w+(f?'.'+f:'');}catch{return '0';}};
function parseXmr(value){const m=String(value).trim().match(/^(\d+)(?:\.(\d{0,12}))?$/);if(!m)throw new Error('Enter a valid XMR amount');return BigInt(m[1])*1000000000000n+BigInt((m[2]||'').padEnd(12,'0')||0);}

async function signerPubkey(){
  try{if(window.opener&&window.opener!==window&&window.opener.state?.publicKey)return window.opener.state.publicKey;}catch{}
  if(window.nostr?.getPublicKey)return await window.nostr.getPublicKey();
  throw new Error('Connect a NIP-07 signer or open Glowstr Live from a signed-in Glowstr window');
}
async function signEvent(template){
  try{
    if(window.opener&&window.opener!==window&&typeof window.opener.signEventUniversal==='function'){
      const signed=await window.opener.signEventUniversal(template);if(signed)return signed;
    }
  }catch{}
  if(window.nostr?.signEvent){template.pubkey=template.pubkey||await signerPubkey();return await window.nostr.signEvent(template);}
  throw new Error('No compatible Nostr signer is available');
}
async function sha256hex(text){const bytes=new TextEncoder().encode(text),out=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));return [...out].map(x=>x.toString(16).padStart(2,'0')).join('');}

async function raw(path,{method='GET',body,headers={}}={}){
  const response=await fetch('./'+path.replace(/^\.\//,''),{method,credentials:'same-origin',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  const value=await response.json().catch(()=>({}));if(!response.ok)throw new Error(value.error||'Request failed');return value;
}
async function api(path,{method='GET',body,headers={}}={}){
  return raw('api/'+path,{method,body,headers:{...(me?{'X-CSRF-Token':me.csrf}:{}),...headers}});
}
async function login(){
  try{
    const pubkey=await signerPubkey(),challenge=await raw('api/challenge'),body=JSON.stringify({challenge:challenge.challenge});
    const event=await signEvent({kind:27235,pubkey,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',challenge.loginURL],['method','POST'],['payload',await sha256hex(body)]]});
    const authorization='Nostr '+btoa(JSON.stringify(event));
    await raw('api/login',{method:'POST',body,headers:{Authorization:authorization}});
    me=await api('me');renderSession();showDashboard();toast('Creator signed in');await loadDashboard();
  }catch(error){toast(error.message);}
}
async function restoreSession(){try{me=await api('me');renderSession();}catch{me=null;renderSession();}}
function renderSession(){
  $('identity').textContent=me?short(me.pubkey):'viewer';$('login').hidden=!!me;$('logout').hidden=!me;
}
async function logout(){try{await api('logout',{method:'POST',body:{}});}catch{}me=null;renderSession();showHome();}

function showHome(){$('home-view').hidden=false;$('dashboard-view').hidden=true;$('watch-view').hidden=true;clearInterval(chatTimer);clearInterval(streamTimer);loadLive();}
function showDashboard(){if(!me){login();return;}$('home-view').hidden=true;$('dashboard-view').hidden=false;$('watch-view').hidden=true;clearInterval(chatTimer);clearInterval(streamTimer);}
async function loadLive(){
  try{
    const {streams}=await raw('api/live'),grid=$('live-grid');grid.replaceChildren();
    if(!streams.length){grid.innerHTML='<p class="muted">No live or planned streams yet.</p>';return;}
    for(const stream of streams){
      const card=document.createElement('article');card.className='stream-card';card.innerHTML=`<div class="thumb">📡</div><div class="card-body"><span class="status ${stream.status==='live'?'live':''}">${stream.status.toUpperCase()}</span><h3></h3><p class="muted"></p><small>${xmr(stream.totalAtomic)} XMR tipped</small></div>`;card.querySelector('h3').textContent=stream.title;card.querySelector('p').textContent=stream.summary||short(stream.owner);card.onclick=()=>watch(stream.id);grid.append(card);
    }
  }catch(error){toast(error.message);}
}

async function createStream(){
  if(!me)return login();
  try{
    const title=$('new-title').value.trim(),summary=$('new-summary').value.trim(),goalAtomic=parseXmr($('new-goal').value.trim()||'0').toString();
    const stream=await api('dashboard/streams',{method:'POST',body:{title,summary,goalAtomic}});lastObs.set(stream.id,stream.obs);$('new-title').value='';$('new-summary').value='';$('new-goal').value='';toast('Stream created — copy the OBS key now');await loadDashboard();
  }catch(error){toast(error.message);}
}
async function loadDashboard(){
  if(!me)return;
  try{
    const {streams}=await api('dashboard/streams'),list=$('creator-streams');list.replaceChildren();
    if(!streams.length){list.innerHTML='<p class="muted">Create your first stream.</p>';return;}
    for(const stream of streams)list.append(renderCreator(stream));
  }catch(error){toast(error.message);}
}
function renderCreator(stream){
  const card=document.createElement('article');card.className='creator-card';
  const obs=lastObs.get(stream.id);
  card.innerHTML=`<div class="row"><span class="status ${stream.status==='live'?'live':''}">${stream.status.toUpperCase()}</span><h3></h3></div><p class="muted"></p>
    <div class="obs-box"><b>OBS Server</b><code class="server"></code><b>Stream Key</b><code class="key"></code></div>
    <div class="row"><button data-action="copy">Copy OBS settings</button><button data-action="rotate">Rotate key</button><button data-action="planned">Publish planned</button><button data-action="live" class="primary">Go Nostr live</button><button data-action="ended">End</button><button data-action="watch">Open stream</button></div>
    <p class="small muted totals"></p>`;
  card.querySelector('h3').textContent=stream.title;card.querySelector('p').textContent=stream.summary||'No description';
  card.querySelector('.server').textContent=obs?.server||stream.obs.server;card.querySelector('.key').textContent=obs?.streamKey||'Hidden — rotate to get a new key';
  card.querySelector('.totals').textContent=xmr(stream.totalAtomic)+' XMR tipped'+(stream.goalAtomic?' · goal '+xmr(stream.goalAtomic)+' XMR':'');
  card.querySelector('[data-action=copy]').onclick=()=>{if(!obs)return toast('Rotate the key to reveal a new OBS key');navigator.clipboard?.writeText('Server: '+obs.server+'\nStream Key: '+obs.streamKey);toast('OBS settings copied');};
  card.querySelector('[data-action=rotate]').onclick=async()=>{try{const next=await api('dashboard/streams/'+stream.id+'/rotate-key',{method:'POST',body:{}});lastObs.set(stream.id,next);toast('New stream key created');await loadDashboard();}catch(e){toast(e.message);}};
  for(const status of ['planned','live','ended'])card.querySelector('[data-action='+status+']').onclick=()=>publishLiveEvent(stream,status);
  card.querySelector('[data-action=watch]').onclick=()=>watch(stream.id);
  return card;
}
async function publishLiveEvent(stream,status){
  try{
    const now=Math.floor(Date.now()/1000),starts=status==='live'?(stream.starts||now):(stream.starts||now),ends=status==='ended'?now:null;
    const tags=[['d',stream.id],['title',stream.title],['summary',stream.summary||''],['streaming',stream.hls],['starts',String(starts)],['status',status],['p',me.pubkey,'','Host'],['relays',...me.relays]];
    if(ends)tags.push(['ends',String(ends)]);
    const event=await signEvent({kind:30311,created_at:now,content:'',tags});
    await api('dashboard/streams/'+stream.id+'/event',{method:'POST',body:{event}});
    toast(status==='live'?'NIP-53 stream is live':'NIP-53 status updated');await loadDashboard();await loadLive();
  }catch(error){toast(error.message);}
}

async function watch(id){
  try{
    currentStream=await raw('api/streams/'+id);$('home-view').hidden=true;$('dashboard-view').hidden=true;$('watch-view').hidden=false;renderWatch();
    await loadChat();chatTimer=setInterval(loadChat,3000);streamTimer=setInterval(refreshWatch,5000);
  }catch(error){toast(error.message);}
}
function renderWatch(){
  const s=currentStream;if(!s)return;$('watch-title').textContent=s.title;$('watch-summary').textContent=s.summary||'';$('watch-status').textContent=s.status.toUpperCase();$('watch-status').classList.toggle('live',s.status==='live');
  const embed=s.hls.replace(/\/index\.m3u8$/,'')+'?autoplay=true&muted=false&playsInline=true';if($('player').src!==embed)$('player').src=embed;
  $('tip-total').textContent=xmr(s.totalAtomic)+' XMR tipped';$('goal-label').textContent=s.goalAtomic?'Goal '+xmr(s.goalAtomic)+' XMR':'';
  const pct=s.goalAtomic?Math.min(100,Number(BigInt(s.totalAtomic||0)*10000n/BigInt(s.goalAtomic))/100):0;$('goal-progress').style.width=pct+'%';
}
async function refreshWatch(){if(!currentStream)return;try{currentStream=await raw('api/streams/'+currentStream.id);renderWatch();}catch{}}
async function loadChat(){
  if(!currentStream)return;
  try{
    const {events}=await raw('api/streams/'+currentStream.id+'/chat'),list=$('chat-list');list.replaceChildren();
    for(const e of events){const item=document.createElement('div');item.className='chat-item';const b=document.createElement('b');b.textContent=short(e.pubkey);const p=document.createElement('p');p.textContent=e.content;item.append(b,p);list.append(item);}list.scrollTop=list.scrollHeight;
  }catch{}
}
async function sendChat(){
  const content=$('chat-input').value.trim();if(!content||!currentStream)return;
  try{
    const event=await signEvent({kind:1311,created_at:Math.floor(Date.now()/1000),content,tags:[['a','30311:'+currentStream.owner+':'+currentStream.id,'','root']]});
    await raw('api/streams/'+currentStream.id+'/chat',{method:'POST',body:{event}});$('chat-input').value='';await loadChat();
  }catch(error){toast(error.message);}
}

async function createTip(amountAtomic){
  if(!currentStream)return;
  try{
    const message=$('tip-message').value.trim(),value=await raw('api/streams/'+currentStream.id+'/tips',{method:'POST',body:{amountAtomic:String(amountAtomic),message,tipper:me?.pubkey||''}});
    $('invoice').hidden=false;$('invoice-amount').textContent=xmr(value.amountAtomic)+' XMR';$('invoice-address').textContent=value.address;$('invoice-wallet').href=value.uri;$('invoice-state').textContent='WAITING — 0 / '+value.confirmationsRequired+' confirmations';
    clearInterval(tipTimer);const poll=async()=>{try{const status=await raw('api/tips/'+value.id,{headers:{Authorization:'Bearer '+value.token}});$('invoice-state').textContent=status.status+' — '+status.confirmations+' / '+status.confirmationsRequired+' confirmations';if(status.status==='PAID'){clearInterval(tipTimer);toast('XMR tip confirmed');await refreshWatch();}}catch{}};tipTimer=setInterval(poll,5000);poll();
  }catch(error){toast(error.message);}
}

$('login').onclick=login;$('logout').onclick=logout;$('open-dashboard').onclick=showDashboard;$('back-home').onclick=showHome;$('watch-back').onclick=showHome;$('refresh-live').onclick=loadLive;$('create-stream').onclick=createStream;$('send-chat').onclick=sendChat;
document.querySelectorAll('[data-tip]').forEach(b=>b.onclick=()=>createTip(BigInt(b.dataset.tip)));$('custom-tip').onclick=()=>{const value=prompt('XMR amount');if(value)try{createTip(parseXmr(value));}catch(e){toast(e.message);}};
$('chat-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();}});
(async()=>{await restoreSession();const id=new URLSearchParams(location.search).get('stream');if(id)watch(id);else loadLive();})();
