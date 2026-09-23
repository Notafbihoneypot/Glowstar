const $=id=>document.getElementById(id);
const names={bluesky:'Bluesky',mastodon:'Mastodon',x:'X',activitypub:'ActivityPub',nostr:'Nostr'};
const marks={bluesky:'B',mastodon:'m',x:'𝕏',activitypub:'AP',nostr:'N'};
const protocols={bluesky:'AT PROTOCOL',mastodon:'ACTIVITYPUB',x:'X API',activitypub:'MASTODON API',nostr:'NOSTR'};
const specs={
  bluesky:{info:'Create an app password in Bluesky settings. It is exchanged for a refreshable session and is not stored. Your DID identifies the linked account even if its handle changes.',docs:'https://docs.bsky.app/docs/advanced-guides/api-directory',fields:[['server','Login server','url','https://bsky.social'],['identifier','Handle or DID','text'],['appPassword','App password','password']]},
  mastodon:{info:'Create an application in your server’s Development settings. Its user token needs read:accounts, write:statuses, and write:media. Your existing account federates through ActivityPub.',docs:'https://docs.joinmastodon.org/client/token/',fields:[['server','Server URL','url','https://mastodon.social'],['accessToken','User access token','password']]},
  x:{info:'Use an OAuth 2 user token with users.read, tweet.read, tweet.write, and media.write for images. Your developer app needs publishing access and API credits. Replace expired tokens here.',docs:'https://docs.x.com/x-api/getting-started/getting-access',fields:[['accessToken','User access token','password']]},
  activitypub:{info:'Link another ActivityPub account on a service that supports the Mastodon account, status, and media APIs. Use a user token with read:accounts, write:statuses, and write:media. This is not a universal ActivityPub login or a new federated actor. Compatibility must be checked for your server.',docs:'https://docs.akkoma.dev/stable/development/API/differences_in_mastoapi_responses/',fields:[['server','Compatible server URL','url'],['accessToken','User access token','password']]},
};
let me=null,uploaded=null,reviewed=null,pending=null,busy=false,currentPlatform,poll;
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function notice(message){$('notice').textContent=message;$('notice').hidden=!message;}
function profileLink(url,label){try{const parsed=new URL(url);if(parsed.protocol!=='https:')return null;const a=el('a',label);a.href=parsed.href;a.target='_blank';a.rel='noopener noreferrer';return a;}catch{return null;}}
async function api(path,{method='GET',body,headers={}}={}){
  const response=await fetch('./api/'+path,{method,credentials:'same-origin',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(me?{'X-CSRF-Token':me.csrf}:{}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok){const error=new Error(value.error||'Request failed');error.status=response.status;throw error;}return value;
}
async function sign(template){
  try{if(window.opener&&window.opener.location.origin===location.origin&&typeof window.opener.signEventUniversal==='function'&&window.opener.canSignInline()){const event=await window.opener.signEventUniversal(template);if(event)return event;}}catch(error){if(error.name!=='SecurityError')throw error;}
  if(window.nostr?.signEvent)return window.nostr.signEvent(template);
  throw new Error('Use a NIP-07 extension, or open from Glowstr with an inline NIP-46, NIP-07, or local signer. Amber redirect signing is not supported here yet.');
}
async function loadMe(){me=await api('me');render();}
async function login(){
  $('login').disabled=true;notice('');
  try{const challenge=await api('challenge'),body=JSON.stringify({challenge:challenge.challenge}),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const event=await sign({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',challenge.loginURL],['method','POST'],['payload',digest]]});
    await api('login',{method:'POST',body,headers:{Authorization:'Nostr '+btoa(JSON.stringify(event))}});await loadMe();notice('Signed in. Link your identities, then choose where to publish.');
  }catch(error){notice(error.message);}finally{$('login').disabled=false;}
}
function render(){
  $('login').hidden=!!me;$('logout').hidden=!me;$('clear-uploads').disabled=!me;$('signer-hint').hidden=!!me;
  $('identity').textContent=me?'IDENTITY HUB · '+me.pubkey.slice(0,10)+'…'+me.pubkey.slice(-6):'Your Nostr key connects your identities.';
  $('mode').textContent=me?me.previewOnly?'PREVIEW ONLY':'LIVE PUBLISHING':'SELF-HOSTED';
  const selected=new Set([...document.querySelectorAll('[data-destination]:checked')].map(n=>n.value));
  const versions=Object.fromEntries([...document.querySelectorAll('[data-override]')].map(n=>[n.dataset.override,{value:n.value,open:n.parentElement.open}]));
  $('destinations').replaceChildren();$('account-list').replaceChildren();
  for(const [platform,name]of Object.entries(names)){
    const connection=me?.connections.find(c=>c.platform===platform),connected=!!me&&(platform==='nostr'||!!connection),account=platform==='nostr'?'Your client signer':connection?.label||'Link an identity';
    const row=el('div',undefined,'destination'),label=el('label'),check=el('input');check.type='checkbox';check.value=platform;check.dataset.destination=platform;check.disabled=!connected;check.checked=connected&&selected.has(platform);
    const identity=el('span');identity.append(el('span',name),el('span',account,'account-label'));label.append(check,el('span',marks[platform],'network-icon'),identity);row.append(label);
    const custom=el('details'),textarea=el('textarea');custom.hidden=!check.checked;custom.open=versions[platform]?.open||false;textarea.dataset.override=platform;textarea.maxLength=65000;textarea.setAttribute('aria-label',name+' version');textarea.placeholder='Use the main text, or write a version here';textarea.value=versions[platform]?.value||'';
    custom.append(el('summary','Customize this version'),textarea);row.append(custom);check.addEventListener('change',()=>{custom.hidden=!check.checked;updateCount();});$('destinations').append(row);
    const card=el('div',undefined,'card account-card'),heading=el('div',undefined,'section-heading');heading.append(el('h3',name),el('span',connected?'LINKED':protocols[platform],'badge'+(connected?' success':'')));card.append(heading,el('p',account,'account-label small'));
    if(platform==='nostr')card.append(el('p','Signed in your client. Optional public notes are sent to the configured relays.','small muted'));
    else{
      if(connection){card.append(el('code',connection.identity));const link=profileLink(connection.profileURL,'View verified profile ↗');if(link)card.append(link);}
      else card.append(el('p',platform==='activitypub'?'Another account on a Mastodon-compatible federated service.':platform==='mastodon'?'Your existing Mastodon identity, with ActivityPub federation.':platform==='bluesky'?'Linked by your stable Bluesky DID.':'Linked by your verified X user ID.','small muted'));
      const actions=el('div',undefined,'actions'),button=el('button',connection?'Replace credentials':'Link identity');button.disabled=!me;button.addEventListener('click',()=>connectDialog(platform));actions.append(button);
      if(connection){const disconnect=el('button','Unlink');disconnect.addEventListener('click',async()=>{if(!confirm('Unlink '+name+'? Waiting deliveries will be cancelled. A request already in progress may complete.'))return;try{await api('connections/'+platform,{method:'DELETE'});await loadMe();}catch(error){notice(error.message);}});actions.append(disconnect);}card.append(actions);
    }
    $('account-list').append(card);
  }
  updateCount();
}
function updateCount(){const n=document.querySelectorAll('[data-destination]:checked').length;$('selected-count').textContent=n+' selected';$('review').disabled=!me||!n||busy;}
function composePost(){const destinations=[...document.querySelectorAll('[data-destination]:checked')].map(n=>n.value),overrides={};for(const node of document.querySelectorAll('[data-override]'))if(node.value.trim()&&destinations.includes(node.dataset.override))overrides[node.dataset.override]=node.value.trim();return{text:$('post-text').value.trim(),destinations,overrides,mediaId:uploaded?.id||null,expectedIdentities:Object.fromEntries(me.connections.filter(c=>destinations.includes(c.platform)).map(c=>[c.platform,c.identity]))};}
function switchTab(tab){for(const name of ['compose','accounts','history'])$(name).hidden=name!==tab;for(const b of document.querySelectorAll('[data-tab]')){b.classList.toggle('active',b.dataset.tab===tab);b.setAttribute('aria-selected',String(b.dataset.tab===tab));}clearInterval(poll);if(tab==='history'&&me){history();poll=setInterval(()=>{if(!document.hidden)history(true);},5000);}}
function connectDialog(platform){
  currentPlatform=platform;const spec=specs[platform];$('account-title').textContent='Link '+names[platform];
  const hosts=platform==='mastodon'?me.mastodonHosts:platform==='activitypub'?me.activitypubHosts:null;
  $('account-instructions').textContent=spec.info+(hosts?' Operator-approved servers: '+(hosts.join(', ')||'none yet; ask your operator to add your server.'):'');$('account-docs').href=spec.docs;$('account-fields').replaceChildren();
  for(const [name,text,type,value]of spec.fields){const label=el('label',text),input=el('input');input.name=name;input.id='field-'+name;input.type=type;input.required=true;input.maxLength=8192;input.autocomplete='off';input.spellcheck=false;input.value=value||'';label.htmlFor=input.id;$('account-fields').append(label,input);}$('account-dialog').showModal();
}
$('account-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{await api('connections/'+currentPlatform,{method:'POST',body:Object.fromEntries(new FormData(event.target))});$('account-dialog').close();await loadMe();notice(names[currentPlatform]+' identity verified and linked. Publishing also needs the correct provider permissions.');}catch(error){alert(error.message);}finally{button.disabled=false;}});
$('account-dialog').addEventListener('close',()=>$('account-form').reset());
async function prepareImage(){
  if(!me)return notice('Sign in before uploading.');const file=$('image-file').files[0],alt=$('image-alt').value.trim();if(!file||file.size>8*1024*1024||!alt)return notice('Choose an image under 8 MB and add its description.');$('prepare-image').disabled=true;notice('');
  try{const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});uploaded=await api('media',{method:'POST',body:{data,alt}});$('image-preview').src='./api/media/'+uploaded.id;$('image-preview').hidden=false;$('remove-image').hidden=false;$('image-file').disabled=true;$('image-alt').disabled=true;$('image-status').textContent='Prepared · 1080 × 1080';}catch(error){notice(error.message);}finally{$('prepare-image').disabled=!!uploaded;}
}
function resetImage(){uploaded=null;$('image-file').value='';$('image-alt').value='';$('image-file').disabled=false;$('image-alt').disabled=false;$('image-preview').hidden=true;$('image-preview').removeAttribute('src');$('remove-image').hidden=true;$('image-status').textContent='';$('prepare-image').disabled=false;}
async function review(){
  notice('');$('review').disabled=true;
  try{if($('image-file').files.length&&!uploaded)throw new Error('Prepare the selected image first.');reviewed=composePost();pending=null;const preview=await api('preview',{method:'POST',body:reviewed});$('versions').replaceChildren();let invalid=false;
    for(const version of preview.versions){const card=el('div',undefined,'version'),heading=el('div',undefined,'section-heading'),connection=me.connections.find(c=>c.platform===version.platform);heading.append(el('h3',names[version.platform]),el('span',version.count+' / '+version.limit,'small muted'));card.append(heading,el('p',version.platform==='nostr'?me.pubkey:connection?.label||'Not linked','small muted'),el('pre',version.text||'(Image only)'));if(uploaded){const img=el('img');img.src='./api/media/'+uploaded.id;img.alt=uploaded.alt;card.append(img);}for(const error of version.errors){invalid=true;card.append(el('p',error,'error'));}$('versions').append(card);}
    $('public-consent').checked=false;$('publish').dataset.invalid=String(invalid);$('publish').disabled=true;$('publish').textContent='Publish to '+reviewed.destinations.length+' identities';$('publish-note').textContent=me.previewOnly?'Preview-only mode is on. The operator must enable publishing before posts can be sent.':'Posting starts here and is immediate. Image descriptions are sent to Bluesky, Mastodon, and compatible ActivityPub accounts.';$('review-dialog').showModal();
  }catch(error){notice(error.message);}finally{updateCount();}
}
async function publishPost(){
  if(!reviewed||busy)return;busy=true;$('publish').disabled=true;
  try{if(!pending){const body={...reviewed,confirmPublic:true};if(body.destinations.includes('nostr'))body.event=await sign({kind:1,created_at:Math.floor(Date.now()/1000),tags:[['client','Glowstr Crosspost']],content:(body.overrides.nostr??body.text)+(uploaded?'\n\n'+uploaded.url:'')});pending={key:crypto.randomUUID(),body};}
    const result=await api('posts',{method:'POST',body:pending.body,headers:{'Idempotency-Key':pending.key}});pending=null;reviewed=null;$('review-dialog').close();$('post-text').value='';$('post-text').dispatchEvent(new Event('input'));for(const n of document.querySelectorAll('[data-override]'))n.value='';resetImage();switchTab('history');notice('Queued '+result.deliveries.length+' identities. Track each delivery here.');
  }catch(error){if([400,401,402,403,409,413,429].includes(error.status))pending=null;$('publish-note').textContent=error.message+' Keep this review open to retry the same request safely.';}finally{busy=false;$('publish').disabled=!reviewed||!$('public-consent').checked;}
}
async function history(quiet=false){if(!me)return;try{const result=await api('posts');$('history-list').replaceChildren();if(!result.posts.length)$('history-list').append(el('p','No deliveries yet. Compose your first public post.','empty'));
  for(const post of result.posts){const card=el('article',undefined,'card history-card');card.append(el('p',new Date(post.created).toLocaleString(),'small muted'),el('p',post.text||'(Image post)','post-summary'));
    for(const delivery of post.deliveries){const row=el('div',undefined,'delivery-row');row.append(el('strong',names[delivery.platform]),el('span',delivery.status,'status '+(delivery.status==='posted'?'success':delivery.status==='uncertain'?'warning':delivery.status==='failed'?'error':'muted')));const detail=el('p',delivery.error||(delivery.status==='posted'?'Accepted by destination':'Waiting for delivery'),'muted');const link=profileLink(delivery.result?.url,'View post ↗');if(link)detail.replaceChildren(link);row.append(detail);
      if(['failed','uncertain'].includes(delivery.status)&&!me.previewOnly){const button=el('button','Retry');button.addEventListener('click',async()=>{const uncertain=delivery.status==='uncertain';if(uncertain&&!confirm('Check this destination first: the post may already exist. Retry only if you accept the risk of a duplicate. Continue?'))return;button.disabled=true;try{await api('deliveries/'+delivery.id+'/retry',{method:'POST',body:{acceptDuplicateRisk:uncertain}});await history();}catch(error){notice(error.message);button.disabled=false;}});row.append(button);}card.append(row);
    }$('history-list').append(card);
  }
}catch(error){if(!quiet)notice(error.message);}}
$('login').addEventListener('click',login);
$('logout').addEventListener('click',async()=>{try{await api('logout',{method:'POST',body:{}});me=null;pending=null;reviewed=null;resetImage();clearInterval(poll);$('history-list').replaceChildren(el('p','Sign in to view your deliveries.','empty'));render();}catch(error){notice(error.message);}});
$('post-text').addEventListener('input',()=>{$('length').textContent=[...new Intl.Segmenter().segment($('post-text').value)].length+' characters';});
$('prepare-image').addEventListener('click',prepareImage);
$('remove-image').addEventListener('click',async()=>{try{if(uploaded)await api('media/'+uploaded.id,{method:'DELETE'});resetImage();}catch(error){notice(error.message);}});
$('clear-uploads').addEventListener('click',async()=>{if(!confirm('Remove all unpublished uploads? Open drafts will need their images uploaded again.'))return;try{const result=await api('media',{method:'DELETE'});resetImage();notice('Removed '+result.removed+' unused uploads.');}catch(error){notice(error.message);}});
$('review').addEventListener('click',review);$('publish').addEventListener('click',publishPost);$('refresh').addEventListener('click',()=>history());
$('public-consent').addEventListener('change',()=>{$('publish').disabled=!$('public-consent').checked||$('publish').dataset.invalid==='true'||me.previewOnly||busy;});
function canCloseReview(){return !busy&&(!pending||confirm('This request may already be queued. Check Deliveries before starting another post. Close this review?'));}
$('review-dialog').addEventListener('cancel',event=>{if(!canCloseReview())event.preventDefault();});
for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>{if(b.dataset.close==='review-dialog'?!canCloseReview():busy)return;$(b.dataset.close).close();});
for(const b of document.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>switchTab(b.dataset.tab));
window.addEventListener('beforeunload',event=>{if(pending){event.preventDefault();event.returnValue='';}});
render();loadMe().catch(()=>{});
try{if(window.opener?.location.origin===location.origin&&typeof window.opener.glowstrGetCrosspostDraft==='function'){$('post-text').value=window.opener.glowstrGetCrosspostDraft();$('post-text').dispatchEvent(new Event('input'));}}catch{}
