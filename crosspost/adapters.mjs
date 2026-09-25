import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { allowedServer, Problem, textFor } from './validation.mjs';
import { blueskyAgent, xAccessToken } from './oauth.mjs';
export class DeliveryError extends Error { constructor(message,state='failed',delay=0){super(message);this.state=state;this.delay=delay;} }
export function makeAPI(fetcher=fetch) {
  return async function api(url,{method='GET',bearer,json,form,bytes,headers={}}={},context=null,final=false) {
    headers={...headers}; if(bearer)headers.Authorization='Bearer '+bearer;
    let body=bytes || form;
    if(json!==undefined){body=JSON.stringify(json);headers['Content-Type']='application/json';}
    if(final)context?.markPublishing();
    let response;
    try{response=await fetcher(url,{method,headers,body,redirect:'error',signal:AbortSignal.timeout(20000)});}
    catch{throw new DeliveryError(final?'Connection interrupted while publishing. Check the destination before retrying.':'Provider could not be reached.',final?'uncertain':'retrying',30000);}
    if(!response.ok){
      if(response.status===429){const raw=response.headers.get('retry-after'),n=Number(raw),ms=raw&&Number.isFinite(n)?n*1000:Date.parse(raw)-Date.now();throw new DeliveryError('Provider rate limit; waiting to retry.','retrying',Math.min(86400000,Math.max(30000,Number.isFinite(ms)?ms:60000)));}
      if(response.status>=500)throw new DeliveryError('Provider returned HTTP '+response.status+'. '+(final?'Check the destination before retrying.':'Delivery will retry.'),final?'uncertain':'retrying',30000);
      throw new DeliveryError('Provider rejected the request (HTTP '+response.status+'). Check credentials, permissions, and limits.');
    }
    if(method==='GET' && response.status===206)throw new DeliveryError('Provider is processing the image.','retrying',5000);
    try{return await response.json();}catch{throw new DeliveryError('Provider returned an unreadable response. Inspect the destination.',final?'uncertain':'failed');}
  };
}
function nonempty(value,name,max=8192){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Problem('Enter '+name);return value.trim();}
function safeProfile(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}}
export async function verifyConnection(platform,input,config,api) {
  if(platform==='bluesky'){
    const server=allowedServer(input.server||'https://bsky.social',config.pdsHosts);
    const session=await api(server+'/xrpc/com.atproto.server.createSession',{method:'POST',json:{identifier:nonempty(input.identifier,'a Bluesky handle',254),password:nonempty(input.appPassword,'an app password',256)}});
    if(!session.did||!session.accessJwt||!session.refreshJwt)throw new Problem('Bluesky did not return a session');
    const endpoint=session.didDoc?.service?.find(s=>typeof s.id==='string'&&s.id.endsWith('#atproto_pds'))?.serviceEndpoint;
    let pds=server;
    if(endpoint){let parsed;try{parsed=new URL(endpoint);}catch{throw new Problem('Invalid Bluesky PDS');}const hosts=new Set(config.pdsHosts);if(parsed.hostname.endsWith('.bsky.network'))hosts.add(parsed.hostname);pds=allowedServer(endpoint,hosts);}
    return {identity:session.did,label:session.handle||session.did,profileURL:'https://bsky.app/profile/'+encodeURIComponent(session.did),secret:{pds,accessToken:session.accessJwt,refreshToken:session.refreshJwt}};
  }
  const accessToken=nonempty(input.accessToken,'an authorized user access token');
  if(platform==='x'){
    const account=(await api('https://api.x.com/2/users/me',{bearer:accessToken})).data;
    if(!account?.id||!account.username)throw new Problem('Use an X OAuth user token, not an app-only token');
    return {identity:account.id,label:'@'+account.username,profileURL:'https://x.com/'+encodeURIComponent(account.username),secret:{accessToken}};
  }
  if(['mastodon','activitypub'].includes(platform)){
    const server=allowedServer(input.server||'',platform==='mastodon'?config.mastodonHosts:config.activitypubHosts);
    const account=await api(server+'/api/v1/accounts/verify_credentials',{bearer:accessToken});
    if(!account.id||!account.acct)throw new Problem('Server did not identify this account through the Mastodon-compatible API');
    let limit=500;
    try{limit=(await api(server+'/api/v2/instance')).configuration?.statuses?.max_characters||500;}catch{try{const instance=await api(server+'/api/v1/instance');limit=instance.configuration?.statuses?.max_characters||instance.max_toot_chars||500;}catch{}}
    if(!Number.isInteger(limit)||limit<1||limit>65000)limit=500;
    return {identity:server+':'+account.id,label:'@'+(account.acct.includes('@')?account.acct:account.acct+'@'+new URL(server).hostname),profileURL:safeProfile(account.url),secret:{server,accessToken,limit}};
  }
  throw new Problem('Unknown platform');
}
const result = (id,url='') => {if(typeof id!=='string'||!id)throw new DeliveryError('Provider accepted the request without a post ID. Inspect the destination.','uncertain');return {id,url:safeProfile(url)};};
export function publishNostr(event,urls,WebSocketImpl=WebSocket){
  return Promise.all(urls.map(url=>new Promise(resolve=>{
    let socket,finished=false;
    const finish=ok=>{if(finished)return;finished=true;clearTimeout(timer);try{socket?.close();}catch{}resolve({relay:url,ok});};
    const timer=setTimeout(()=>finish(false),12000);
    try{socket=new WebSocketImpl(url);socket.addEventListener('open',()=>socket.send(JSON.stringify(['EVENT',event])));socket.addEventListener('message',message=>{try{const data=JSON.parse(String(message.data));if(data[0]==='OK'&&data[1]===event.id)finish(data[2]===true);}catch{}});socket.addEventListener('error',()=>finish(false));socket.addEventListener('close',()=>finish(false));}catch{finish(false);}
  }))).then(relays=>{if(!relays.some(r=>r.ok))throw new DeliveryError('No relay acknowledged the note. Authenticated relays require a live signer.','retrying',30000);return {id:event.id,url:'',relays};});
}
export function createPublisher(config,store,{fetcher=fetch,WebSocketImpl=WebSocket}={}){
  const api=makeAPI(fetcher);
  return async function publish(platform,post,connection,media,context){
    if(platform==='nostr')return publishNostr(post.event,config.relays,WebSocketImpl);
    const text=textFor(post,platform),auth=connection.secret,image=media?await readFile(join(config.data,'media',media.id+'.jpg')):null;
    if(platform==='x'){
      let accessToken=auth.accessToken;
      if(auth.auth==='oauth2'){try{accessToken=await xAccessToken(config,store,post.owner,connection,fetcher);}catch(error){throw new DeliveryError(error.message,error.status===502?'retrying':'failed',30000);}}
      const payload={text};
      if(image){const upload=await api('https://api.x.com/2/media/upload',{method:'POST',bearer:accessToken,json:{media:image.toString('base64'),media_category:'tweet_image'}});if(!upload.data?.id)throw new DeliveryError('X did not return a media ID');payload.media={media_ids:[upload.data.id]};}
      const data=(await api('https://api.x.com/2/tweets',{method:'POST',bearer:accessToken,json:payload},context,true)).data;
      return result(data?.id,'https://x.com/i/status/'+data?.id);
    }
    if(['mastodon','activitypub'].includes(platform)){
      const payload={status:text,visibility:'public'};
      if(image){
        let id=context.checkpoint.mediaId;
        if(!id){const form=new FormData();form.set('file',new Blob([image],{type:'image/jpeg'}),'image.jpg');form.set('description',media.alt);
          const uploaded=await api(auth.server+(platform==='activitypub'?'/api/v1/media':'/api/v2/media'),{method:'POST',bearer:auth.accessToken,form});
          if(!uploaded.id)throw new DeliveryError('Server did not return a media ID');id=uploaded.id;context.save({mediaId:id,mediaReady:!!uploaded.url});}
        if(!context.checkpoint.mediaReady){const attachment=await api(auth.server+'/api/v1/media/'+id,{bearer:auth.accessToken});if(!attachment.url)throw new DeliveryError('Server is processing the image.','retrying',5000);context.save({mediaReady:true});}
        payload.media_ids=[id];
      }
      const published=await api(auth.server+'/api/v1/statuses',{method:'POST',bearer:auth.accessToken,json:payload,headers:{'Idempotency-Key':post.id}},context,true);
      return result(published.id,published.url);
    }
    if(platform==='bluesky'){
      const record={$type:'app.bsky.feed.post',text,createdAt:new Date(post.created).toISOString()},facets=[];
      for(const match of text.matchAll(/https?:\/\/[^\s<>]+/gu)){const uri=match[0].replace(/[.,!?;:)]+$/,'');try{new URL(uri);}catch{continue;}facets.push({index:{byteStart:Buffer.byteLength(text.slice(0,match.index)),byteEnd:Buffer.byteLength(text.slice(0,match.index)+uri)},features:[{$type:'app.bsky.richtext.facet#link',uri}]});}
      if(facets.length)record.facets=facets;
      if(auth.auth==='oauth'){
        let agent;try{agent=await blueskyAgent(config,store,post.owner,connection.identity);}catch{throw new DeliveryError('Bluesky authorization expired or was revoked. Reconnect this identity.');}
        if(image){let uploaded;try{uploaded=await agent.uploadBlob(image,{encoding:'image/jpeg'});}catch{throw new DeliveryError('Bluesky image upload failed; delivery will retry.','retrying',30000);}const blob=uploaded.data?.blob||uploaded.blob;if(!blob)throw new DeliveryError('Bluesky did not return an image blob');record.embed={$type:'app.bsky.embed.images',images:[{alt:media.alt,image:blob,aspectRatio:{width:media.width,height:media.height}}]};}
        context.markPublishing();
        try{const published=await agent.com.atproto.repo.putRecord({repo:connection.identity,collection:'app.bsky.feed.post',rkey:post.rkey,record,validate:true}),data=published.data||published;return result(data.uri,'https://bsky.app/profile/'+encodeURIComponent(connection.identity)+'/post/'+post.rkey);}
        catch(error){const status=Number(error.status||error.statusCode||error.response?.status);if(status===429)throw new DeliveryError('Bluesky rate limit; waiting to retry.','retrying',60000);if(status>=400&&status<500)throw new DeliveryError('Bluesky rejected the post. Check authorization and content limits.');throw new DeliveryError('Bluesky publication may have completed. Check the destination before retrying.','uncertain');}
      }
      const refreshed=await api(auth.pds+'/xrpc/com.atproto.server.refreshSession',{method:'POST',bearer:auth.refreshToken});
      if(refreshed.did!==connection.identity||!refreshed.accessJwt||!refreshed.refreshJwt)throw new DeliveryError('Bluesky session changed identity; reconnect');
      auth.accessToken=refreshed.accessJwt;auth.refreshToken=refreshed.refreshJwt;
      if(!store.replaceConnectionSecret(post.owner,platform,connection.identity,connection.sealed,auth))throw new DeliveryError('Bluesky identity changed while refreshing; create a new post after reviewing the account');
      if(image){const uploaded=await api(auth.pds+'/xrpc/com.atproto.repo.uploadBlob',{method:'POST',bearer:auth.accessToken,bytes:image,headers:{'Content-Type':'image/jpeg'}});if(!uploaded.blob)throw new DeliveryError('Bluesky did not return an image blob');record.embed={$type:'app.bsky.embed.images',images:[{alt:media.alt,image:uploaded.blob,aspectRatio:{width:media.width,height:media.height}}]};}
      const published=await api(auth.pds+'/xrpc/com.atproto.repo.putRecord',{method:'POST',bearer:auth.accessToken,json:{repo:connection.identity,collection:'app.bsky.feed.post',rkey:post.rkey,record,validate:true}},context,true);
      return result(published.uri,'https://bsky.app/profile/'+encodeURIComponent(connection.identity)+'/post/'+post.rkey);
    }
    throw new DeliveryError('Unsupported platform');
  };
}
