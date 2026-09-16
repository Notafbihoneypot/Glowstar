from pathlib import Path
import hashlib, base64, re
src=Path('/mnt/data/glowstr-v5.2-mesh.html')
out=Path('/mnt/data/glowstr-v5.3-bluetooth-direct.html')
s=src.read_text()
s=s.replace('<title>GLOWSTR // v5.1 Offline + Feeds + Blossom</title>','<title>GLOWSTR // v5.3 Bluetooth Direct</title>',1)
s=s.replace('<meta name="glowstr-build" content="v5-secure-overhaul">','<meta name="glowstr-build" content="v5.3-bluetooth-direct">',1)

css='''\n/* GLOWSTR_V5_3_BLUETOOTH_DIRECT_START */\n.mesh-grid{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}\n.mesh-peer-list{font-family:var(--font-retro);font-size:.8rem;color:var(--xmr-text-dim);line-height:1.45;margin-top:8px;min-height:1.3em;word-break:break-word}\n.mesh-peer-chip{display:inline-block;border:1px solid var(--xmr-gray-light);padding:2px 5px;margin:2px 4px 2px 0;color:var(--xmr-cyan);background:rgba(0,216,255,.025)}\n#mesh-bluetooth-card .mesh-field[type=password]{min-width:180px}\n@media(max-width:760px){#mesh-bluetooth-card .mesh-row{align-items:stretch}#mesh-bluetooth-card .mesh-row .mesh-field{width:100%;max-width:none;flex-basis:100%}}\n/* GLOWSTR_V5_3_BLUETOOTH_DIRECT_END */\n'''
s=s.replace('/* GLOWSTR_V5_2_MESH_END */\n\n</style>', css+'/* GLOWSTR_V5_2_MESH_END */\n\n</style>',1)

needle='''            <div class="mesh-help">The token is session-only. The bridge binds to loopback by default and never receives your Nostr private key.</div>\n          </div>\n        </div>\n        <div class="mesh-collapse-options">'''
card='''            <div class="mesh-help">The token is session-only. The bridge binds to loopback by default and never receives your Nostr private key.</div>\n          </div>\n          <!-- GLOWSTR_V5_3_BLUETOOTH_DIRECT_START -->\n          <div class="mesh-card" id="mesh-bluetooth-card">\n            <div class="mesh-card-title">🔵 BLUETOOTH DIRECT // PHONE ↔ PHONE</div>\n            <div class="mesh-card-desc">Use the FOSS Glowstr Android helper for direct phone-to-phone BLE. The helper advertises and scans nearby Glowstr phones, uses secure LE L2CAP streams, and stores public signed notes while the PWA is closed.</div>\n            <div class="mesh-status" id="mesh-bluetooth-status">HELPER DISCONNECTED</div>\n            <div class="mesh-row">\n              <input class="mesh-field" id="mesh-bluetooth-token" type="password" placeholder="Android helper pairing token" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Bluetooth Direct helper pairing token" />\n              <label class="mesh-help" for="mesh-bluetooth-hops">HOPS</label>\n              <input class="mesh-field small" id="mesh-bluetooth-hops" type="number" min="1" max="5" step="1" value="5" inputmode="numeric" />\n            </div>\n            <div class="mesh-row">\n              <button class="btn btn-small" id="mesh-bluetooth-connect" type="button">CONNECT HELPER</button>\n              <button class="btn btn-small" id="mesh-bluetooth-rescan" type="button">RESCAN</button>\n              <button class="btn btn-small" id="mesh-bluetooth-disconnect" type="button">DISCONNECT</button>\n            </div>\n            <div class="mesh-peer-list" id="mesh-bluetooth-peers">NO PEERS</div>\n            <div class="mesh-help">Android helper endpoint: <strong>127.0.0.1:8788</strong>. The token stays in session storage only. Chrome/Vanadium may ask for Local Network Access to reach the loopback helper.</div>\n          </div>\n          <!-- GLOWSTR_V5_3_BLUETOOTH_DIRECT_END -->\n        </div>\n        <div class="mesh-collapse-options">'''
if needle not in s: raise SystemExit('UI needle missing')
s=s.replace(needle,card,1)

old='''const glowstrMesh = {\n  meshtastic:{device:null,server:null,to:null,from:null,wake:null,ready:false,stage:'idle',draining:false,waiter:null},\n  reticulum:{ws:null,ready:false,pending:new Map()}, reassembly:new Map(), seen:new Map(), init:false\n};'''
new='''const glowstrMesh = {\n  meshtastic:{device:null,server:null,to:null,from:null,wake:null,ready:false,stage:'idle',draining:false,waiter:null},\n  reticulum:{ws:null,ready:false,pending:new Map()},\n  bluetooth:{ready:false,token:'',cursor:0,pollGeneration:0,statusTimer:null,failures:0,lastStatus:null,controllers:new Set()},\n  reassembly:new Map(), seen:new Map(), init:false\n};'''
if old not in s: raise SystemExit('state needle missing')
s=s.replace(old,new,1)

start=s.index('function glowstrMeshSetStatus(which,text,kind=\'\'){')
end=s.index('function glowstrMeshPrefs()', start)
s=s[:start]+'''function glowstrMeshSetStatus(which,text,kind=''){\n  const ids={meshtastic:'mesh-meshtastic',reticulum:'mesh-reticulum',bluetooth:'mesh-bluetooth'},base=ids[which];if(!base)return;\n  const el=document.getElementById(base+'-status');if(el){el.textContent=text;el.className='mesh-status'+(kind?' '+kind:'');}\n  const card=document.getElementById(base+'-card');if(card)card.classList.toggle('mesh-ready',kind==='good');\n}\n'''+s[end:]

old="function glowstrMeshPrefs(){let x={channel:0,pace:1200,url:'ws://127.0.0.1:8787',queueInternet:true};try{Object.assign(x,JSON.parse(localStorage.getItem(GLOWSTR_MESH_PREFS_KEY)||'{}'));}catch(e){}x.channel=Math.max(0,Math.min(7,Number(x.channel)||0));x.pace=Math.max(800,Math.min(5000,Number(x.pace)||1200));return x;}"
new="function glowstrMeshPrefs(){let x={channel:0,pace:1200,url:'ws://127.0.0.1:8787',queueInternet:true,btHops:5};try{Object.assign(x,JSON.parse(localStorage.getItem(GLOWSTR_MESH_PREFS_KEY)||'{}'));}catch(e){}x.channel=Math.max(0,Math.min(7,Number(x.channel)||0));x.pace=Math.max(800,Math.min(5000,Number(x.pace)||1200));x.btHops=Math.max(1,Math.min(5,Number(x.btHops)||5));return x;}"
if old not in s: raise SystemExit('prefs missing')
s=s.replace(old,new,1)
old="function glowstrMeshSavePrefs(){const channel=Math.max(0,Math.min(7,Number(document.getElementById('mesh-meshtastic-channel')?.value)||0)),pace=Math.max(800,Math.min(5000,Number(document.getElementById('mesh-meshtastic-pace')?.value)||1200)),url=String(document.getElementById('mesh-reticulum-url')?.value||'').trim(),queueInternet=!!document.getElementById('mesh-queue-internet')?.checked;try{localStorage.setItem(GLOWSTR_MESH_PREFS_KEY,JSON.stringify({channel,pace,url,queueInternet}));}catch(e){}return {channel,pace,url,queueInternet};}"
new="function glowstrMeshSavePrefs(){const channel=Math.max(0,Math.min(7,Number(document.getElementById('mesh-meshtastic-channel')?.value)||0)),pace=Math.max(800,Math.min(5000,Number(document.getElementById('mesh-meshtastic-pace')?.value)||1200)),url=String(document.getElementById('mesh-reticulum-url')?.value||'').trim(),queueInternet=!!document.getElementById('mesh-queue-internet')?.checked,btHops=Math.max(1,Math.min(5,Number(document.getElementById('mesh-bluetooth-hops')?.value)||5));try{localStorage.setItem(GLOWSTR_MESH_PREFS_KEY,JSON.stringify({channel,pace,url,queueInternet,btHops}));}catch(e){}return {channel,pace,url,queueInternet,btHops};}"
if old not in s: raise SystemExit('save prefs missing')
s=s.replace(old,new,1)
s=s.replace("function glowstrMeshConnected(){return !!(glowstrMesh.meshtastic.ready||glowstrMesh.reticulum.ready);}","function glowstrMeshConnected(){return !!(glowstrMesh.meshtastic.ready||glowstrMesh.reticulum.ready||glowstrMesh.bluetooth.ready);}",1)

insert_before='async function glowstrMeshSendComposer()'
pos=s.index(insert_before)
btjs=r'''// GLOWSTR_V5_3_BLUETOOTH_DIRECT_START
const GLOWSTR_BT_HELPER='http://127.0.0.1:8788';
const GLOWSTR_BT_CURSOR_KEY='glowstr_bt_cursor_v1';
function glowstrBtSanitizeSource(x){return String(x||'peer').replace(/[^a-zA-Z0-9._:-]/g,'').slice(0,64)||'peer';}
function glowstrBtRenderPeers(status){
  const el=document.getElementById('mesh-bluetooth-peers');if(!el)return;
  const peers=Array.isArray(status?.peers)?status.peers:[];
  if(!peers.length){el.textContent='NO PEERS · STORE-AND-FORWARD READY';return;}
  el.textContent='';for(const p of peers){const chip=document.createElement('span');chip.className='mesh-peer-chip';chip.textContent=String(p.node||'peer').slice(0,16)+' · '+String(p.direction||'');el.appendChild(chip);}
}
function glowstrBtAbortRequests(){for(const c of glowstrMesh.bluetooth.controllers){try{c.abort();}catch(e){}}glowstrMesh.bluetooth.controllers.clear();}
async function glowstrBtFetch(path,{method='GET',body=null,timeout=8000}={}){
  const bt=glowstrMesh.bluetooth,token=String(bt.token||sessionStorage.getItem('glowstr_bluetooth_token')||'').trim();if(!token)throw new Error('Bluetooth helper pairing token missing');
  const controller=new AbortController();bt.controllers.add(controller);const timer=setTimeout(()=>controller.abort(),timeout);
  const headers={'X-Glowstr-Token':token,'Accept':'application/json'};let payload;
  if(body!==null){payload=JSON.stringify(body);headers['Content-Type']='application/json';}
  try{
    const options={method,headers,body:payload,mode:'cors',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal,targetAddressSpace:'loopback'};
    const res=await fetch(GLOWSTR_BT_HELPER+path,options);const text=await res.text();if(text.length>1024*1024)throw new Error('Bluetooth helper response too large');let data={};try{data=text?JSON.parse(text):{};}catch(e){throw new Error('Bluetooth helper returned invalid JSON');}if(!res.ok||data.ok===false)throw new Error(data.error||('Bluetooth helper HTTP '+res.status));return data;
  }catch(e){if(e?.name==='AbortError')throw new Error('Bluetooth helper timed out');throw e;}finally{clearTimeout(timer);bt.controllers.delete(controller);}
}
function glowstrBtApplyStatus(st){
  const bt=glowstrMesh.bluetooth;bt.lastStatus=st;bt.ready=!!st?.running;
  if(bt.ready){const n=Math.max(0,Number(st.peer_count)||0);glowstrMeshSetStatus('bluetooth','READY · '+n+' PEER'+(n===1?'':'S')+' · NODE '+String(st.node_id||'').slice(0,8),'good');}
  else glowstrMeshSetStatus('bluetooth','HELPER RUNNING · BLUETOOTH STOPPED','bad');
  glowstrBtRenderPeers(st);
}
async function glowstrBtRefreshStatus(){if(!glowstrMesh.bluetooth.ready)return;try{glowstrBtApplyStatus(await glowstrBtFetch('/v1/status'));glowstrMesh.bluetooth.failures=0;}catch(e){if(++glowstrMesh.bluetooth.failures>=3){glowstrDisconnectBluetoothDirect(false);glowstrMeshSetStatus('bluetooth','HELPER UNREACHABLE','bad');}}}
async function glowstrBtPollEvents(gen){
  const bt=glowstrMesh.bluetooth;
  while(bt.ready&&bt.pollGeneration===gen){
    try{
      const data=await glowstrBtFetch('/v1/events?after='+encodeURIComponent(bt.cursor)+'&limit=50&wait=20000',{timeout:26000});bt.failures=0;
      const rows=Array.isArray(data.events)?data.events:[];
      for(const row of rows){const seq=Math.max(0,Number(row?.seq)||0);try{if(row?.event)await acceptVerifiedRelayEvent(row.event,'mesh://bluetooth/'+glowstrBtSanitizeSource(row.source));}catch(e){console.warn('Dropped Bluetooth Direct event',e);}bt.cursor=Math.max(bt.cursor,seq);}
      bt.cursor=Math.max(bt.cursor,Number(data.cursor)||0);try{localStorage.setItem(GLOWSTR_BT_CURSOR_KEY,String(bt.cursor));}catch(e){}if(rows.length&&state.feedMode==='mesh')rerenderFeed();
    }catch(e){if(!bt.ready||bt.pollGeneration!==gen)break;if(++bt.failures>=3){glowstrDisconnectBluetoothDirect(false);glowstrMeshSetStatus('bluetooth','HELPER POLL LOST','bad');break;}await sleep(1000*bt.failures);}
  }
}
async function glowstrConnectBluetoothDirect(){
  glowstrDisconnectBluetoothDirect(false);const input=document.getElementById('mesh-bluetooth-token'),token=String(input?.value||sessionStorage.getItem('glowstr_bluetooth_token')||'').trim();if(token.length<20){showToast('Paste the pairing token from the Glowstr Bluetooth Bridge app');return false;}
  const bt=glowstrMesh.bluetooth;bt.token=token;try{sessionStorage.setItem('glowstr_bluetooth_token',token);}catch(e){}glowstrMeshSetStatus('bluetooth','CONNECTING TO 127.0.0.1…');
  try{
    const st=await glowstrBtFetch('/v1/status',{timeout:10000});glowstrBtApplyStatus(st);if(!bt.ready){showToast('Start Bluetooth Direct in the Android helper first');return false;}
    let saved=0;try{saved=Math.max(0,Number(localStorage.getItem(GLOWSTR_BT_CURSOR_KEY))||0);}catch(e){}const latest=Math.max(0,Number(st.latest_cursor)||0),oldest=Math.max(0,Number(st.oldest_cursor)||0);bt.cursor=saved>0?saved:Math.max(Math.max(0,oldest-1),latest-100);bt.failures=0;const gen=++bt.pollGeneration;glowstrBtPollEvents(gen);if(bt.statusTimer)clearInterval(bt.statusTimer);bt.statusTimer=setInterval(glowstrBtRefreshStatus,5000);return true;
  }catch(e){bt.ready=false;const msg=String(e.message||e);glowstrMeshSetStatus('bluetooth','CONNECT FAILED · '+msg.slice(0,80),'bad');showToast('Bluetooth helper: '+msg+(msg.includes('Failed to fetch')?' · allow Local Network Access if prompted':''));return false;}
}
function glowstrDisconnectBluetoothDirect(clearToken=false){const bt=glowstrMesh.bluetooth;bt.ready=false;bt.pollGeneration++;glowstrBtAbortRequests();if(bt.statusTimer){clearInterval(bt.statusTimer);bt.statusTimer=null;}bt.lastStatus=null;bt.failures=0;glowstrMeshSetStatus('bluetooth','HELPER DISCONNECTED','bad');glowstrBtRenderPeers(null);if(clearToken){bt.token='';try{sessionStorage.removeItem('glowstr_bluetooth_token');}catch(e){}}}
async function glowstrBluetoothRescan(){if(!glowstrMesh.bluetooth.ready){showToast('Connect the Bluetooth helper first');return;}try{await glowstrBtFetch('/v1/rescan',{method:'POST',body:{}});showToast('Bluetooth peer scan restarted');}catch(e){showToast('Bluetooth helper: '+e.message);}}
async function glowstrBluetoothSendEvent(event){if(!glowstrMesh.bluetooth.ready)throw new Error('Bluetooth Direct helper is not connected');const hops=glowstrMeshSavePrefs().btHops||5;const x=await glowstrBtFetch('/v1/send',{method:'POST',body:{event,hops},timeout:10000});const n=Math.max(0,Number(x.peers_sent)||0);glowstrMeshSetStatus('bluetooth',n?('READY · SENT TO '+n+' PEER'+(n===1?'':'S')):'READY · STORED · WAITING FOR PEER','good');return x;}
// GLOWSTR_V5_3_BLUETOOTH_DIRECT_END
'''
s=s[:pos]+btjs+s[pos:]

# Replace send composer as a compact known function by locating next function
start=s.index('async function glowstrMeshSendComposer()')
end=s.index('function glowstrMeshInit()',start)
sendfunc="""async function glowstrMeshSendComposer(){if(!glowstrMeshConnected()){showToast('Connect Meshtastic, Reticulum, or Bluetooth Direct in RELAYS → LOCAL MESH first');switchView('relays');return;}if(!state.publicKey){showToast('Choose a signer first');switchView('keys');return;}if(state.signerMethod==='amber-nip55'){showToast('Direct mesh send needs an inline signer. Use Amber NIP-46, NIP-07, or a local key.');return;}const input=document.getElementById('compose-input'),content=input?.value?.trim()||'';if(!content){showToast('Write a note first');return;}const reply=glowstrCloneReplyContext(state.replyTo),tpl=glowstrBuildQueuedTemplate({content,replyTo:reply});let signed;try{signed=await signEventUniversal(tpl);if(!signed)throw new Error('Signer did not return an event');}catch(e){showToast('Mesh signing failed: '+(e.message||e));return;}const jobs=[];if(glowstrMesh.meshtastic.ready)jobs.push(['Meshtastic',glowstrMeshtasticSendEvent(signed)]);if(glowstrMesh.reticulum.ready)jobs.push(['Reticulum',glowstrReticulumSendEvent(signed)]);if(glowstrMesh.bluetooth.ready)jobs.push(['Bluetooth Direct',glowstrBluetoothSendEvent(signed)]);const res=await Promise.allSettled(jobs.map(x=>x[1]));const ok=res.filter(x=>x.status==='fulfilled').length;if(!ok){showToast('Mesh send failed: '+res.map(x=>x.reason?.message||'error').join(' · '));return;}await acceptVerifiedRelayEvent(signed,'mesh://local');const prefs=glowstrMeshSavePrefs();if(prefs.queueInternet){try{await glowstrQueueDraftRecord({content,replyTo:reply,status:'queued'});}catch(e){console.warn('Could not queue mesh note for later relay publish',e);}}glowstrClearComposerAfterLocalSave();showToast('📡 Handed to '+ok+' mesh transport'+(ok===1?'':'s')+(prefs.queueInternet?' · queued for Internet later':''));}\n"""
s=s[:start]+sendfunc+s[end:]

start=s.index('function glowstrMeshInit()')
end=s.index("if(document.readyState==='loading')",start)
init="""function glowstrMeshInit(){if(glowstrMesh.init)return;glowstrMesh.init=true;const p=glowstrMeshPrefs();const ch=document.getElementById('mesh-meshtastic-channel'),pace=document.getElementById('mesh-meshtastic-pace'),url=document.getElementById('mesh-reticulum-url'),q=document.getElementById('mesh-queue-internet'),tok=document.getElementById('mesh-reticulum-token'),btTok=document.getElementById('mesh-bluetooth-token'),btHops=document.getElementById('mesh-bluetooth-hops');if(ch)ch.value=String(p.channel);if(pace)pace.value=String(p.pace);if(url)url.value=p.url||'ws://127.0.0.1:8787';if(q)q.checked=p.queueInternet!==false;if(btHops)btHops.value=String(p.btHops||5);if(tok){try{tok.value=sessionStorage.getItem('glowstr_reticulum_token')||'';}catch(e){}}if(btTok){try{btTok.value=sessionStorage.getItem('glowstr_bluetooth_token')||'';}catch(e){}}document.getElementById('mesh-meshtastic-connect')?.addEventListener('click',glowstrConnectMeshtastic);document.getElementById('mesh-meshtastic-disconnect')?.addEventListener('click',glowstrDisconnectMeshtastic);document.getElementById('mesh-reticulum-connect')?.addEventListener('click',glowstrConnectReticulum);document.getElementById('mesh-reticulum-disconnect')?.addEventListener('click',glowstrDisconnectReticulum);document.getElementById('mesh-bluetooth-connect')?.addEventListener('click',glowstrConnectBluetoothDirect);document.getElementById('mesh-bluetooth-rescan')?.addEventListener('click',glowstrBluetoothRescan);document.getElementById('mesh-bluetooth-disconnect')?.addEventListener('click',()=>glowstrDisconnectBluetoothDirect(false));document.getElementById('mesh-disconnect-all')?.addEventListener('click',()=>{glowstrDisconnectMeshtastic();glowstrDisconnectReticulum();glowstrDisconnectBluetoothDirect(false);});document.getElementById('compose-mesh-btn')?.addEventListener('click',glowstrMeshSendComposer);for(const id of ['mesh-meshtastic-channel','mesh-meshtastic-pace','mesh-reticulum-url','mesh-bluetooth-hops','mesh-queue-internet'])document.getElementById(id)?.addEventListener('change',glowstrMeshSavePrefs);window.addEventListener('beforeunload',()=>{try{glowstrMesh.reticulum.ws?.close();}catch(e){}glowstrBtAbortRequests();});glowstrMeshSetStatus('meshtastic',navigator.bluetooth?'DISCONNECTED':'WEB BLUETOOTH UNAVAILABLE');glowstrMeshSetStatus('reticulum','DISCONNECTED');glowstrMeshSetStatus('bluetooth','HELPER DISCONNECTED');}\n"""
s=s[:start]+init+s[end:]

# Restrict CSP loopback HTTP explicitly while preserving normal ws/wss/https
csp_old="connect-src 'self' https: wss: ws:;"
csp_new="connect-src 'self' https: wss: ws: http://127.0.0.1:8788 http://localhost:8788;"
if csp_old not in s: raise SystemExit('CSP connect-src missing')
s=s.replace(csp_old,csp_new,1)

# Recalculate hash for the single main inline script
m=re.search(r'<script>([\s\S]*?)</script>\s*</body>',s)
if not m: raise SystemExit('main script not found')
script=m.group(1).encode()
h=base64.b64encode(hashlib.sha256(script).digest()).decode()
s=re.sub(r"script-src 'self' 'sha256-[A-Za-z0-9+/=]+';",f"script-src 'self' 'sha256-{h}';",s,count=1)
out.write_text(s)
print(out)
print('script hash',h)
