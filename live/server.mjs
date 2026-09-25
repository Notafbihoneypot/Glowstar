import express from 'express';
import { randomUUID } from 'node:crypto';
import { resolve,dirname,join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { verifyEvent } from 'nostr-tools/pure';
import { loadConfig } from './config.mjs';
import { openStore,hash,token } from './store.mjs';
import { publishToRelays } from './relay.mjs';

const here=dirname(fileURLToPath(import.meta.url)),cookieName='glowstr_live';
class Problem extends Error{constructor(message,status=400){super(message);this.status=status;}}
const cookieValue=req=>(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
const tag=(event,name)=>event.tags.find(t=>t[0]===name)?.[1]||'';
const tags=(event,name)=>event.tags.filter(t=>t[0]===name);
const validHex=value=>/^[0-9a-f]{64}$/.test(value||'');

export function createService(config,dependencies={}){
  const store=dependencies.store||openStore(config),{db}=store,fetcher=dependencies.fetcher||fetch,publisher=dependencies.publisher||((event)=>publishToRelays(config.relays,event));
  const app=express(),attempts=new Map();let tipTimer=null,tipBusy=false;app.disable('x-powered-by');
  app.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: https:; frame-src 'self' https:; connect-src 'self' https: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"});next();});
  app.use(express.json({limit:'256kb',verify(req,_res,bytes){req.rawBody=bytes;}}));

  const sameOrigin=(req,_res,next)=>req.headers.origin===config.origin?next():next(new Problem('Request origin does not match this service',403));
  const auth=(req,_res,next)=>{const session=db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(cookieValue(req)),Date.now());if(!session||!config.allowed.has(session.owner))return next(new Problem('Sign in with an allowed Nostr key',401));req.session=session;next();};
  const csrf=(req,res,next)=>sameOrigin(req,res,error=>{if(error)return next(error);if(req.headers['x-csrf-token']!==req.session.csrf)return next(new Problem('Session check failed; sign in again',403));next();});
  const setCookie=(res,value,expires)=>res.cookie(cookieName,value,{httpOnly:true,secure:config.secure,sameSite:'strict',path:config.cookiePath,expires});
  const loginLimit=(req,_res,next)=>{const now=Date.now();for(const [ip,item]of attempts)if(item.until<now)attempts.delete(ip);const ip=req.socket.remoteAddress,item=attempts.get(ip)||{count:0,until:now+300000};if(++item.count>100||attempts.size>10000)return next(new Problem('Too many sign-in attempts; wait five minutes',429));attempts.set(ip,item);next();};
  const streamURLs=id=>({hls:config.hlsBase+'/'+id+'/index.m3u8',player:config.base+'/?stream='+encodeURIComponent(id),rtmpServer:config.rtmpBase});
  const publicStream=row=>{
    const total=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM tips WHERE stream_id=? AND status='PAID'").get(row.id).n;
    return {id:row.id,owner:row.owner,title:row.title,summary:row.summary,status:row.status,goalAtomic:row.goal_atomic,totalAtomic:total,
      created:row.created,updated:row.updated,starts:row.starts,ends:row.ends,...streamURLs(row.id),event:row.latest_event?JSON.parse(row.latest_event):null};
  };
  const ownerStream=row=>({...publicStream(row),obs:{server:config.rtmpBase,streamKey:'<hidden>',path:'live/'+row.id}});
  const streamFor=(id)=>db.prepare('SELECT * FROM streams WHERE id=?').get(id);
  const ownedStream=(id,owner)=>{const row=db.prepare('SELECT * FROM streams WHERE id=? AND owner=?').get(id,owner);if(!row)throw new Problem('Stream not found',404);return row;};

  app.get('/health',(_req,res)=>res.json({ok:true,service:'glowstr-live',tips:!!config.commerceURL}));
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
      const one=name=>{const matches=event.tags.filter(t=>t[0]===name);return matches.length===1&&matches[0].length===2?matches[0][1]:null;};
      if(one('u')!==config.base+'/api/login'||one('method')!=='POST'||one('payload')!==hash(req.rawBody))throw new Error();
    }catch{throw new Problem('Invalid, expired, or unauthorized Nostr sign-in',401);}
    const challenge=req.body?.challenge;if(typeof challenge!=='string'||!/^[a-f0-9]{64}$/.test(challenge))throw new Problem('Invalid challenge',401);
    if(!db.prepare('DELETE FROM challenges WHERE id=? AND expires>?').run(hash(challenge),Date.now()).changes)throw new Problem('Challenge expired or already used',401);
    const session=token(),csrfToken=token(),expires=Date.now()+86400000;db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(session),event.pubkey,csrfToken,expires);
    setCookie(res,session,new Date(expires));res.json({pubkey:event.pubkey,csrf:csrfToken});
  });

  // MediaMTX external HTTP authentication. Only publishing requires a stream key.
  app.post('/mediamtx/auth',(req,res)=>{
    const action=String(req.body?.action||''),path=String(req.body?.path||'').replace(/^\/+|\/+$/g,'');
    if(action!=='publish')return res.status(204).end();
    const match=/^live\/([a-f0-9]{24})$/.exec(path);if(!match)return res.status(401).end();
    const row=streamFor(match[1]),provided=String(req.body?.token||req.body?.password||'');
    if(!row||!provided||hash(provided)!==row.stream_key_hash)return res.status(401).end();
    res.status(204).end();
  });

  // Public discovery / playback metadata.
  app.get('/api/live',(_req,res)=>res.json({streams:db.prepare("SELECT * FROM streams WHERE status IN ('live','planned') ORDER BY CASE status WHEN 'live' THEN 0 ELSE 1 END,updated DESC LIMIT 100").all().map(publicStream)}));
  app.get('/api/streams/:id',(req,res)=>{const row=streamFor(req.params.id);if(!row)throw new Problem('Stream not found',404);res.json(publicStream(row));});
  app.get('/api/streams/:id/chat',(req,res)=>{
    if(!streamFor(req.params.id))throw new Problem('Stream not found',404);
    const rows=db.prepare('SELECT event FROM chat WHERE stream_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.id).reverse();
    res.json({events:rows.map(r=>JSON.parse(r.event))});
  });
  app.get('/api/streams/:id/tips',(req,res)=>{
    if(!streamFor(req.params.id))throw new Problem('Stream not found',404);
    const rows=db.prepare("SELECT amount,message,tipper,paid_at FROM tips WHERE stream_id=? AND status='PAID' ORDER BY paid_at DESC LIMIT 50").all(req.params.id);
    res.json({tips:rows});
  });

  app.post('/api/streams/:id/chat',async(req,res)=>{
    const stream=streamFor(req.params.id),event=req.body?.event;if(!stream)throw new Problem('Stream not found',404);
    if(!event||event.kind!==1311||!verifyEvent(event)||typeof event.content!=='string'||!event.content.trim()||event.content.length>500)throw new Problem('Invalid live chat event');
    const address='30311:'+stream.owner+':'+stream.id;
    if(!tags(event,'a').some(t=>t[1]===address))throw new Problem('Chat event does not reference this live stream');
    const relay=await publisher(event);if(!relay||relay.accepted<1)throw new Problem('No configured Nostr relay accepted the chat event',502);
    db.prepare('INSERT OR IGNORE INTO chat VALUES(?,?,?,?,?,?)').run(event.id,stream.id,event.pubkey,event.created_at,event.content,JSON.stringify(event));
    res.status(202).json({ok:true,relays:relay.accepted});
  });

  app.post('/api/streams/:id/tips',async(req,res)=>{
    const stream=streamFor(req.params.id);if(!stream)throw new Problem('Stream not found',404);if(!config.commerceURL)throw new Problem('XMR tips are not enabled',409);
    let amount;try{amount=BigInt(req.body?.amountAtomic);}catch{throw new Problem('Invalid XMR tip amount');}
    if(amount<config.tipMin||amount>config.tipMax)throw new Problem('Tip amount is outside the allowed range');
    const message=String(req.body?.message||'').trim();if(message.length>180)throw new Problem('Tip message is too long');
    const tipper=String(req.body?.tipper||'').toLowerCase();if(tipper&&!validHex(tipper))throw new Problem('Invalid tipper pubkey');
    let response,value;
    try{
      response=await fetcher(config.commerceURL+'/v1/invoices',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.commerceToken},
        body:JSON.stringify({pubkey:stream.owner,feature:'live_tip',target:stream.id,amount_atomic:amount.toString()}),redirect:'error',signal:AbortSignal.timeout(10000)});
      value=await response.json();
    }catch{throw new Problem('XMR payment service unavailable',503);}
    if(!response.ok)throw new Problem('XMR payment service could not create the tip invoice',response.status===429?429:502);
    const id=randomUUID(),cap=token(),now=Date.now(),sealed=store.seal('tip:'+id,{token:value.token});
    db.prepare('INSERT INTO tips(id,stream_id,cap_hash,invoice_id,invoice_secret,amount,message,tipper,created) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,stream.id,hash(cap),value.id,sealed,Number(amount),message,tipper,now);
    res.status(201).json({id,token:cap,status:'WAITING',amountAtomic:Number(amount),address:value.address,uri:value.uri,expiresAt:value.expires_at,confirmationsRequired:value.confirmations_required});
  });

  async function refreshTip(row){
    if(row.status==='PAID'||!config.commerceURL)return row;
    let response,value;
    try{
      const secret=store.unseal('tip:'+row.id,row.invoice_secret);
      response=await fetcher(config.commerceURL+'/v1/invoices/'+encodeURIComponent(row.invoice_id),{headers:{Authorization:'Bearer '+secret.token},redirect:'error',signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw new Error();value=await response.json();
    }catch{return row;}
    const next=String(value.status||row.status).toUpperCase(),paidAt=next==='PAID'?(row.paid_at||Date.now()):row.paid_at;
    db.prepare('UPDATE tips SET status=?,confirmations=?,paid_at=? WHERE id=?').run(next,Number(value.confirmations||0),paidAt,row.id);
    return {...db.prepare('SELECT * FROM tips WHERE id=?').get(row.id),confirmationsRequired:Number(value.confirmations_required||2)};
  }
  app.get('/api/tips/:id',async(req,res)=>{
    const row=db.prepare('SELECT * FROM tips WHERE id=?').get(req.params.id),authHeader=req.headers.authorization||'';
    if(!row||!authHeader.startsWith('Bearer ')||hash(authHeader.slice(7))!==row.cap_hash)throw new Problem('Tip invoice not found',404);
    const current=await refreshTip(row);
    res.json({id:current.id,status:current.status,amountAtomic:current.amount,confirmations:current.confirmations,confirmationsRequired:current.confirmationsRequired||2,paidAt:current.paid_at});
  });
  async function watchTips(){
    if(tipBusy)return;tipBusy=true;
    try{
      const rows=db.prepare("SELECT * FROM tips WHERE status NOT IN ('PAID','EXPIRED') AND created>? ORDER BY created LIMIT 200").all(Date.now()-7*86400000);
      for(const row of rows)await refreshTip(row);
    }finally{tipBusy=false;}
  }
  const tipWatcher={start(){if(tipTimer)return;watchTips();tipTimer=setInterval(watchTips,config.pollMs);tipTimer.unref?.();},stop(){if(tipTimer){clearInterval(tipTimer);tipTimer=null;}}};

  app.use('/api',auth);
  app.get('/api/me',(req,res)=>res.json({pubkey:req.session.owner,csrf:req.session.csrf,relays:config.relays,rtmpServer:config.rtmpBase,hlsBase:config.hlsBase,tips:!!config.commerceURL}));
  app.post('/api/logout',csrf,(req,res)=>{db.prepare('DELETE FROM sessions WHERE id=?').run(req.session.id);setCookie(res,'',new Date(0));res.json({ok:true});});
  app.get('/api/dashboard/streams',(req,res)=>res.json({streams:db.prepare('SELECT * FROM streams WHERE owner=? ORDER BY updated DESC LIMIT 100').all(req.session.owner).map(ownerStream)}));
  app.post('/api/dashboard/streams',csrf,(req,res)=>{
    const title=String(req.body?.title||'').trim(),summary=String(req.body?.summary||'').trim();if(!title||title.length>120)throw new Problem('Title must be 1–120 characters');if(summary.length>500)throw new Problem('Summary is too long');
    let goal;try{goal=BigInt(req.body?.goalAtomic||0);}catch{throw new Problem('Invalid XMR goal');}if(goal<0n||goal>1000000000000000n)throw new Problem('Invalid XMR goal');
    const id=token(12),streamKey=token(),now=Date.now();db.prepare('INSERT INTO streams(id,owner,title,summary,goal_atomic,stream_key_hash,created,updated) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,req.session.owner,title,summary,Number(goal),hash(streamKey),now,now);
    res.status(201).json({...ownerStream(streamFor(id)),obs:{server:config.rtmpBase,streamKey:id+'?token='+streamKey,path:'live/'+id}});
  });
  app.post('/api/dashboard/streams/:id/rotate-key',csrf,(req,res)=>{
    ownedStream(req.params.id,req.session.owner);const streamKey=token();db.prepare('UPDATE streams SET stream_key_hash=?,updated=? WHERE id=?').run(hash(streamKey),Date.now(),req.params.id);
    res.json({server:config.rtmpBase,streamKey:req.params.id+'?token='+streamKey,path:'live/'+req.params.id});
  });
  app.post('/api/dashboard/streams/:id/event',csrf,async(req,res)=>{
    const stream=ownedStream(req.params.id,req.session.owner),event=req.body?.event;if(!event||event.kind!==30311||event.pubkey!==req.session.owner||!verifyEvent(event))throw new Problem('Invalid NIP-53 live event');
    if(tag(event,'d')!==stream.id)throw new Problem('Live event d tag does not match the stream');
    if(tag(event,'streaming')!==streamURLs(stream.id).hls)throw new Problem('Live event streaming URL does not match this stream');
    const status=tag(event,'status');if(!['planned','live','ended'].includes(status))throw new Problem('Live event status must be planned, live, or ended');
    if(!tags(event,'p').some(t=>t[1]===stream.owner&&String(t[3]||'').toLowerCase()==='host'))throw new Problem('Live event must include the owner as Host');
    const title=tag(event,'title')||stream.title,summary=tag(event,'summary')||stream.summary,starts=Number(tag(event,'starts')||0)||null,ends=Number(tag(event,'ends')||0)||null;
    if(title.length>120||summary.length>500)throw new Problem('Live event metadata is too long');
    const relay=await publisher(event);if(!relay||relay.accepted<1)throw new Problem('No configured Nostr relay accepted the live event',502);
    db.prepare('UPDATE streams SET title=?,summary=?,status=?,starts=?,ends=?,latest_event=?,updated=? WHERE id=?')
      .run(title,summary,status,starts,ends,JSON.stringify(event),Date.now(),stream.id);
    res.status(202).json({stream:publicStream(streamFor(stream.id)),relays:relay.accepted});
  });

  app.use(express.static(join(here,'public'),{dotfiles:'deny'}));
  app.use((_req,_res,next)=>next(new Problem('Not found',404)));
  app.use((error,_req,res,_next)=>res.status(error instanceof Problem?error.status:500).json({error:error instanceof Problem?error.message:'Server could not complete this request'}));
  return {app,store,tipWatcher};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  process.umask(0o077);const config=loadConfig(),service=createService(config);const server=service.app.listen(config.port,config.host,()=>console.log(`Glowstr Live listening on ${config.host}:${config.port}; tips=${!!config.commerceURL}`));service.tipWatcher.start();
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{service.tipWatcher.stop();server.close(()=>process.exit(0));});
}
