import express from 'express';
import sharp from 'sharp';
import { verifyEvent } from 'nostr-tools/pure';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, PLATFORMS } from './config.mjs';
import { openStore, hash, token } from './store.mjs';
import { normalizePost, inspectPost, Problem, nostrContent, validateSignedNote } from './validation.mjs';
import { createPublisher, makeAPI, verifyConnection, DeliveryError } from './adapters.mjs';
import { createWorker } from './worker.mjs';
const here=dirname(fileURLToPath(import.meta.url)),cookieName='glowstr_crosspost';
const cookieValue=req=>(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';

export function createService(config,dependencies={}){
  const store=dependencies.store||openStore(config),{db}=store,fetcher=dependencies.fetcher||fetch;
  const worker=createWorker(config,store,dependencies.publish||createPublisher(config,store,{fetcher,WebSocketImpl:dependencies.WebSocketImpl}));
  const app=express(),attempts=new Map();app.disable('x-powered-by');
  app.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"});next();});
  app.use(express.json({limit:'12mb',verify(req,_res,bytes){req.rawBody=bytes;}}));
  const sameOrigin=(req,_res,next)=>req.headers.origin===config.origin?next():next(new Problem('Request origin does not match this service',403));
  const auth=(req,_res,next)=>{const session=db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(cookieValue(req)),Date.now());if(!session||!config.allowed.has(session.owner))return next(new Problem('Sign in with an allowed Nostr key',401));req.session=session;next();};
  const csrf=(req,res,next)=>sameOrigin(req,res,error=>{if(error)return next(error);if(req.headers['x-csrf-token']!==req.session.csrf)return next(new Problem('Session check failed; sign in again',403));next();});
  const loginLimit=(req,_res,next)=>{const now=Date.now();for(const [ip,item]of attempts)if(item.until<now)attempts.delete(ip);const ip=req.socket.remoteAddress,item=attempts.get(ip)||{count:0,until:now+300000};if(++item.count>100||attempts.size>10000)return next(new Problem('Too many sign-in attempts; wait five minutes',429));attempts.set(ip,item);next();};
  const setCookie=(res,value,expires)=>res.cookie(cookieName,value,{httpOnly:true,secure:config.secure,sameSite:'strict',path:config.cookiePath,expires});
  const connectionsFor=owner=>Object.fromEntries(PLATFORMS.filter(p=>p!=='nostr').map(p=>[p,store.connection(owner,p)]));
  const mediaFor=(post,owner)=>{const row=post.mediaId?db.prepare('SELECT * FROM media WHERE id=? AND owner=?').get(post.mediaId,owner):null;if(post.mediaId&&!row)throw new Problem('Image is missing or belongs to another account');return row;};
  const postResult=id=>{const post=db.prepare('SELECT id,created,payload FROM posts WHERE id=?').get(id);return {id:post.id,created:post.created,text:JSON.parse(post.payload).text,deliveries:db.prepare('SELECT id,platform,identity,status,attempts,result,error FROM deliveries WHERE post_id=? ORDER BY id').all(id).map(d=>({...d,result:d.result?JSON.parse(d.result):null}))};};

  app.get('/health',(_req,res)=>res.json({ok:true,service:'glowstr-crosspost',previewOnly:config.previewOnly}));
  app.get('/api/challenge',loginLimit,(_req,res)=>{
    db.prepare('DELETE FROM challenges WHERE expires<?').run(Date.now());db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    if(db.prepare('SELECT COUNT(*) AS n FROM challenges').get().n>1000)throw new Problem('Try signing in later',429);
    const challenge=token();db.prepare('INSERT INTO challenges VALUES(?,?)').run(hash(challenge),Date.now()+300000);res.json({challenge,loginURL:config.base+'/api/login'});
  });
  app.post('/api/login',sameOrigin,loginLimit,(req,res)=>{
    let event;
    try{
      const header=req.headers.authorization||'';if(!header.startsWith('Nostr ')||header.length>16000)throw new Error();event=JSON.parse(Buffer.from(header.slice(6),'base64').toString());
      if(event.kind!==27235||event.content!==''||!config.allowed.has(event.pubkey)||Math.abs(Date.now()/1000-event.created_at)>60||!verifyEvent(event))throw new Error();
      const tag=name=>{const matches=event.tags.filter(t=>t[0]===name);return matches.length===1&&matches[0].length===2?matches[0][1]:null;};
      if(tag('u')!==config.base+'/api/login'||tag('method')!=='POST'||tag('payload')!==hash(req.rawBody))throw new Error();
    }catch{throw new Problem('Invalid, expired, or unauthorized Nostr sign-in',401);}
    const challenge=req.body?.challenge;if(typeof challenge!=='string'||!/^[a-f0-9]{64}$/.test(challenge))throw new Problem('Invalid challenge',401);
    if(!db.prepare('DELETE FROM challenges WHERE id=? AND expires>?').run(hash(challenge),Date.now()).changes)throw new Problem('Challenge expired or already used',401);
    db.prepare('DELETE FROM sessions WHERE id=?').run(hash(cookieValue(req)));
    const session=token(),csrfToken=token(),expires=Date.now()+86400000;db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(session),event.pubkey,csrfToken,expires);
    setCookie(res,session,new Date(expires));res.json({pubkey:event.pubkey,csrf:csrfToken});
  });
  app.use('/api',auth);
  app.get('/api/me',(req,res)=>res.json({pubkey:req.session.owner,csrf:req.session.csrf,previewOnly:config.previewOnly,base:config.base,relays:config.relays,
    mastodonHosts:[...config.mastodonHosts],activitypubHosts:[...config.activitypubHosts],blueskyHosts:[...config.pdsHosts],
    connections:db.prepare('SELECT platform,identity,label,profile_url AS profileURL FROM connections WHERE owner=? ORDER BY platform').all(req.session.owner)}));
  app.post('/api/logout',csrf,(req,res)=>{db.prepare('DELETE FROM sessions WHERE id=?').run(req.session.id);setCookie(res,'',new Date(0));res.json({ok:true});});
  app.post('/api/connections/:platform',csrf,async(req,res)=>{
    const {platform}=req.params;if(!PLATFORMS.includes(platform)||platform==='nostr')throw new Problem('Unknown connection');
    const account=await verifyConnection(platform,req.body||{},config,makeAPI(fetcher));store.saveConnection(req.session.owner,platform,account);
    res.json({platform,identity:account.identity,label:account.label,profileURL:account.profileURL});
  });
  app.delete('/api/connections/:platform',csrf,(req,res)=>{
    db.prepare('DELETE FROM connections WHERE owner=? AND platform=?').run(req.session.owner,req.params.platform);
    db.prepare("UPDATE deliveries SET status='cancelled',error='Identity disconnected' WHERE platform=? AND status IN ('queued','retrying') AND post_id IN (SELECT id FROM posts WHERE owner=?)").run(req.params.platform,req.session.owner);res.json({ok:true});
  });
  app.post('/api/media',csrf,async(req,res)=>{
    const {data,alt}=req.body||{};if(typeof data!=='string'||data.length>11200000||!/^[A-Za-z0-9+/]+={0,2}$/.test(data)||typeof alt!=='string'||!alt.trim()||alt.length>1000)throw new Problem('Upload one image under 8 MB with a description (1–1000 characters)');
    if(db.prepare('SELECT COUNT(*) AS n FROM media WHERE owner=? AND public=0').get(req.session.owner).n>=20)throw new Problem('Clear unused uploads from the Identities tab first');
    let output;
    try{const bytes=Buffer.from(data,'base64');if(bytes.length>8*1024*1024)throw new Error();const source=sharp(bytes,{limitInputPixels:40000000,animated:false});if(!['jpeg','png','webp'].includes((await source.metadata()).format))throw new Error();const pipeline=source.rotate().resize(1080,1080,{fit:'contain',background:'#19201b'}).flatten({background:'#19201b'}).toColourspace('srgb');for(const quality of [85,70,50]){output=await pipeline.clone().jpeg({quality}).toBuffer();if(output.length<=950000)break;}if(output.length>950000)throw new Error();}catch{throw new Problem('Use a JPG, PNG, or WebP under 8 MB');}
    const id=token();await writeFile(join(config.data,'media',id+'.jpg'),output,{flag:'wx',mode:0o600});db.prepare('INSERT INTO media(id,owner,alt,width,height) VALUES(?,?,?,?,?)').run(id,req.session.owner,alt.trim(),1080,1080);
    res.status(201).json({id,width:1080,height:1080,alt:alt.trim(),url:config.base+'/media/'+id+'.jpg'});
  });
  app.get('/api/media/:id',(req,res)=>{const row=db.prepare('SELECT id FROM media WHERE id=? AND owner=?').get(req.params.id,req.session.owner);if(!row)throw new Problem('Image not found',404);res.sendFile(resolve(config.data,'media',row.id+'.jpg'));});
  app.delete('/api/media/:id',csrf,async(req,res)=>{
    const row=db.prepare('SELECT id FROM media WHERE id=? AND owner=?').get(req.params.id,req.session.owner);if(!row)throw new Problem('Image not found',404);
    if(!db.prepare("DELETE FROM media WHERE id=? AND owner=? AND NOT EXISTS(SELECT id FROM posts WHERE json_extract(payload,'$.mediaId')=?)").run(row.id,req.session.owner,row.id).changes)throw new Problem('This image belongs to a queued or published post');
    await unlink(join(config.data,'media',row.id+'.jpg'));res.json({ok:true});
  });
  app.delete('/api/media',csrf,async(req,res)=>{const rows=db.prepare('DELETE FROM media WHERE owner=? AND public=0 RETURNING id').all(req.session.owner);await Promise.all(rows.map(row=>unlink(join(config.data,'media',row.id+'.jpg')).catch(()=>{})));res.json({removed:rows.length});});
  app.post('/api/preview',csrf,(req,res)=>{const post=normalizePost(req.body),media=mediaFor(post,req.session.owner);res.json({versions:inspectPost(post,connectionsFor(req.session.owner),media)});});
  app.post('/api/posts',csrf,async(req,res)=>{
    const owner=req.session.owner,post=normalizePost(req.body),requestKey=req.headers['idempotency-key'];
    if(typeof requestKey!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey))throw new Problem('A valid idempotency key is required');
    const digest=hash(JSON.stringify(post)),existing=db.prepare('SELECT id,digest FROM posts WHERE owner=? AND request_key=?').get(owner,requestKey);
    if(existing){if(existing.digest!==digest)throw new Problem('Request key already used for a different post',409);return res.json(postResult(existing.id));}
    if(config.previewOnly)throw new Problem('Publishing is disabled in preview-only mode',409);
    if(req.body.confirmPublic!==true)throw new Problem('Confirm these are public posts');
    const media=mediaFor(post,owner),connections=connectionsFor(owner),errors=inspectPost(post,connections,media).flatMap(v=>v.errors.map(e=>v.platform+': '+e));
    if(errors.length)throw new Problem(errors.join('; '));
    for(const p of post.destinations.filter(p=>p!=='nostr'))if(post.expectedIdentities[p]!==connections[p].identity)throw new Problem('A linked identity changed or was not reviewed. Refresh the accounts and review again.',409);
    if(post.destinations.includes('nostr'))validateSignedNote(post.event,owner,nostrContent(post,media?config.base+'/media/'+media.id+'.jpg':null));else post.event=null;
    if(config.commerceURL){
      let entitlements;try{const response=await fetcher(config.commerceURL.replace(/\/$/,'')+'/v1/admin/entitlements/'+owner,{headers:{Authorization:'Bearer '+config.commerceToken},redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error();entitlements=(await response.json()).entitlements;if(!Array.isArray(entitlements))throw new Error();}catch{throw new Problem('Membership service unavailable; no post was queued',503);}
      if(!entitlements.some(e=>e.feature===config.entitlementFeature&&e.target===config.entitlementTarget&&Number(e.valid_until)>Date.now()/1000))throw new Problem('An active Monero membership is required',402);
    }
    // The entitlement request can yield; recheck bindings and idempotency atomically.
    db.exec('BEGIN IMMEDIATE');let id;
    try{const race=db.prepare('SELECT id,digest FROM posts WHERE owner=? AND request_key=?').get(owner,requestKey);
      if(race){if(race.digest!==digest)throw new Problem('Request key already used for a different post',409);id=race.id;}
      else{
        if(db.prepare('SELECT COUNT(*) AS n FROM posts WHERE owner=? AND created>?').get(owner,Date.now()-86400000).n>=config.dailyLimit)throw new Problem('Daily publishing limit reached',429);
        mediaFor(post,owner);for(const p of post.destinations.filter(p=>p!=='nostr'))if(store.connection(owner,p)?.identity!==connections[p].identity)throw new Problem('A linked identity changed; review again',409);
        id=randomUUID();post.rkey=store.nextRecordKey();const now=Date.now();db.prepare('INSERT INTO posts VALUES(?,?,?,?,?,?)').run(id,owner,requestKey,digest,now,JSON.stringify(post));
        for(const p of post.destinations)db.prepare('INSERT INTO deliveries(post_id,platform,identity,due) VALUES(?,?,?,?)').run(id,p,p==='nostr'?owner:connections[p].identity,now);
        if(media)db.prepare('UPDATE media SET public=1 WHERE id=?').run(media.id);
      }db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    res.status(202).json(postResult(id));
  });
  app.get('/api/posts',(req,res)=>res.json({posts:db.prepare('SELECT id FROM posts WHERE owner=? ORDER BY created DESC LIMIT 50').all(req.session.owner).map(p=>postResult(p.id))}));
  app.post('/api/deliveries/:id/retry',csrf,(req,res)=>{
    if(config.previewOnly)throw new Problem('Publishing is disabled in preview-only mode',409);
    const row=db.prepare('SELECT d.* FROM deliveries d JOIN posts p ON p.id=d.post_id WHERE d.id=? AND p.owner=?').get(req.params.id,req.session.owner);
    if(!row)throw new Problem('Delivery not found',404);if(!['failed','uncertain'].includes(row.status))throw new Problem('Only failed or uncertain deliveries can be retried',409);
    if(row.status==='uncertain'&&req.body?.acceptDuplicateRisk!==true)throw new Problem('Check the destination before accepting duplicate risk',409);
    db.prepare("UPDATE deliveries SET status='queued',due=?,error=NULL WHERE id=?").run(Date.now(),row.id);res.json({ok:true});
  });
  app.get('/media/:name',(req,res)=>{if(!/^[a-f0-9]{64}\.jpg$/.test(req.params.name))throw new Problem('Image not found',404);const row=db.prepare('SELECT id FROM media WHERE id=? AND public=1').get(req.params.name.slice(0,-4));if(!row)throw new Problem('Image not found',404);res.sendFile(resolve(config.data,'media',row.id+'.jpg'));});
  app.use(express.static(join(here,'public'),{dotfiles:'deny'}));app.use((_req,_res,next)=>next(new Problem('Not found',404)));
  app.use((error,_req,res,_next)=>{const status=error instanceof Problem?error.status:error instanceof DeliveryError?502:error.type==='entity.too.large'?413:error instanceof SyntaxError?400:500;res.status(status).json({error:error instanceof Problem||error instanceof DeliveryError?error.message:status===413?'Request too large':status===400?'Invalid JSON':'Server could not complete this request'});});
  return {app,store,worker};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  process.umask(0o077);const config=loadConfig(),service=createService(config);const server=service.app.listen(config.port,config.host,()=>console.log(`Crosspost listening on ${config.host}:${config.port}; preview-only=${config.previewOnly}`));service.worker.start();
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{service.worker.stop();server.close(()=>process.exit(0));});
}
