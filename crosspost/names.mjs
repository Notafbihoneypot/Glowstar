import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';
import { hash, token } from './store.mjs';
import { Problem } from './validation.mjs';

const pendingStates=new Set(['CREATING','WAITING','MEMPOOL','CONFIRMING']);
const normalizeName=value=>String(value||'').trim().toLowerCase();
const validName=(name,reserved)=>/^[a-z0-9._-]{1,30}$/.test(name)&&!reserved.has(name);
const safeEqual=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};

function authEvent(req,expectedURL,bodyHash){
  try{
    const header=req.headers.authorization||'';
    if(!header.startsWith('Nostr ')||header.length>16000)throw new Error();
    const event=JSON.parse(Buffer.from(header.slice(6),'base64').toString());
    if(event.kind!==27235||event.content!==''||Math.abs(Date.now()/1000-event.created_at)>60||!verifyEvent(event))throw new Error();
    const tag=name=>{const rows=event.tags.filter(t=>t[0]===name);return rows.length===1&&rows[0].length===2?rows[0][1]:null;};
    if(tag('u')!==expectedURL||tag('method')!=='POST'||tag('payload')!==bodyHash)throw new Error();
    return event;
  }catch{throw new Problem('Invalid or expired Nostr authorization',401);}
}

export function installNameRegistry(app,config,store,fetcher=fetch){
  const {db}=store,fed=config.fedHouse;
  if(!fed?.enabled)return {start(){},stop(){}};
  const router=express.Router(),attempts=new Map();let timer=null,running=false;

  const fail=(message,status=400)=>{throw new Problem(message,status);};
  const publicClaimURL=path=>fed.base+path;
  const allowedOrigin=req=>!req.headers.origin||fed.allowedOrigins.has(req.headers.origin);
  const cors=(req,res,next)=>{
    const origin=req.headers.origin;
    if(origin&&fed.allowedOrigins.has(origin)){res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');}
    res.set('Access-Control-Allow-Headers','Content-Type, Authorization');res.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');
    if(req.method==='OPTIONS')return res.status(204).end();
    next();
  };
  router.use(cors);
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});

  function cleanup(){
    const now=Date.now();
    db.prepare('DELETE FROM name_challenges WHERE expires<?').run(now);
    db.prepare("UPDATE name_claims SET state='EXPIRED',updated=? WHERE state='CREATING' AND reserved_at<?").run(now,now-10*60*1000);
  }
  function challengeLimit(req){
    const now=Date.now();for(const [ip,item]of attempts)if(item.until<now)attempts.delete(ip);
    const ip=req.socket.remoteAddress||'unknown',item=attempts.get(ip)||{count:0,until:now+300000};
    if(++item.count>120||attempts.size>10000)fail('Too many requests; wait five minutes',429);
    attempts.set(ip,item);
  }
  function view(row,extra={}){
    if(!row)return null;
    return {name:row.name,identifier:row.name+'@'+fed.domain,state:row.state,permanent:row.state==='ACTIVE',
      address:row.address||null,amountAtomic:row.amount||null,quoteUsdCents:row.quote_usd_cents||null,xmrUsd:row.quote_xmr_usd||null,
      uri:row.uri||null,expiresAt:row.expires_at?Math.floor(row.expires_at/1000):null,activatedAt:row.activated_at?Math.floor(row.activated_at/1000):null,...extra};
  }
  async function commerceStatus(row){
    if(!row.invoice_id||!row.invoice_secret)return null;
    const secret=store.unseal(row.pubkey,'fed-house:'+row.name,row.invoice_secret);
    const response=await fetcher(config.commerceURL.replace(/\/$/,'')+'/v1/invoices/'+encodeURIComponent(row.invoice_id),{
      headers:{Authorization:'Bearer '+secret.token},redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('commerce status '+response.status);
    return response.json();
  }
  async function reconcileName(name){
    let row=db.prepare('SELECT * FROM name_claims WHERE name=?').get(name);
    if(!row||row.state==='ACTIVE'||row.state==='EXPIRED')return row;
    if(row.state==='CREATING')return row;
    let status;
    try{status=await commerceStatus(row);}catch{return row;}
    const now=Date.now(),next=String(status.status||row.state).toUpperCase();
    if(next==='PAID'){
      db.prepare("UPDATE name_claims SET state='ACTIVE',activated_at=COALESCE(activated_at,?),updated=? WHERE name=? AND pubkey=? AND invoice_id=? AND state!='ACTIVE'")
        .run(now,now,row.name,row.pubkey,row.invoice_id);
    }else if(next==='EXPIRED'){
      db.prepare("UPDATE name_claims SET state='EXPIRED',updated=? WHERE name=? AND pubkey=? AND invoice_id=? AND state!='ACTIVE'")
        .run(now,row.name,row.pubkey,row.invoice_id);
    }else if(['WAITING','MEMPOOL','CONFIRMING'].includes(next)){
      db.prepare("UPDATE name_claims SET state=?,updated=? WHERE name=? AND pubkey=? AND invoice_id=? AND state!='ACTIVE'")
        .run(next,now,row.name,row.pubkey,row.invoice_id);
    }
    row=db.prepare('SELECT * FROM name_claims WHERE name=?').get(name);
    return {...row,_status:status};
  }
  async function reconcilePending(){
    if(running)return;running=true;
    try{
      cleanup();
      const rows=db.prepare("SELECT name FROM name_claims WHERE state IN ('WAITING','MEMPOOL','CONFIRMING') ORDER BY updated LIMIT 200").all();
      for(const row of rows)await reconcileName(row.name);
    }finally{running=false;}
  }
  function consumeChallenge(challenge,name){
    if(typeof challenge!=='string'||!/^[a-f0-9]{64}$/.test(challenge))fail('Invalid challenge',401);
    const row=db.prepare('SELECT name FROM name_challenges WHERE id=? AND expires>?').get(hash(challenge),Date.now());
    db.prepare('DELETE FROM name_challenges WHERE id=?').run(hash(challenge));
    if(!row||row.name!==name)fail('Challenge expired or already used',401);
  }
  function claimTokenOK(row,value){return typeof value==='string'&&value.length>=32&&value.length<=160&&safeEqual(row.claim_token_hash,hash(value));}

  app.get('/.well-known/nostr.json',async(req,res,next)=>{
    try{
      const name=normalizeName(req.query.name);
      res.set({'Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=60'});
      if(name){
        if(!/^[a-z0-9._-]{1,30}$/.test(name))return res.json({names:{}});
        const row=await reconcileName(name);
        return res.json({names:row?.state==='ACTIVE'?{[name]:row.pubkey}:{}});
      }
      const rows=db.prepare("SELECT name,pubkey FROM name_claims WHERE state='ACTIVE' ORDER BY name LIMIT 5000").all();
      res.json({names:Object.fromEntries(rows.map(r=>[r.name,r.pubkey]))});
    }catch(error){next(error);}
  });

  router.get('/api/names/:name',async(req,res,next)=>{
    try{
      cleanup();const name=normalizeName(req.params.name);
      if(!validName(name,fed.reservedNames))return res.json({name,available:false,state:'reserved-name'});
      const row=await reconcileName(name);
      const available=!row||row.state==='EXPIRED';
      res.json({name,identifier:name+'@'+fed.domain,available,state:row?.state||'AVAILABLE'});
    }catch(error){next(error);}
  });

  router.get('/api/challenge',(req,res,next)=>{
    try{
      if(!allowedOrigin(req))fail('Origin not allowed',403);challengeLimit(req);cleanup();
      const name=normalizeName(req.query.name);if(!validName(name,fed.reservedNames))fail('Invalid or reserved name');
      if(db.prepare('SELECT COUNT(*) AS n FROM name_challenges').get().n>2000)fail('Try again later',429);
      const challenge=token();db.prepare('INSERT INTO name_challenges VALUES(?,?,?)').run(hash(challenge),name,Date.now()+300000);
      res.json({challenge,name,claimURL:publicClaimURL('/api/claim'),recoverURL:publicClaimURL('/api/recover')});
    }catch(error){next(error);}
  });

  router.post('/api/claim',async(req,res,next)=>{
    let insertedEvent=null;
    try{
      if(!allowedOrigin(req))fail('Origin not allowed',403);
      const name=normalizeName(req.body?.name);if(!validName(name,fed.reservedNames))fail('Invalid or reserved name');
      const event=authEvent(req,publicClaimURL('/api/claim'),hash(req.rawBody));consumeChallenge(req.body?.challenge,name);
      const existing=await reconcileName(name);
      if(existing?.state==='ACTIVE'){
        if(existing.pubkey===event.pubkey)return res.json(view(existing));
        fail('That name is already permanently registered',409);
      }
      if(existing&&pendingStates.has(existing.state)){
        if(existing.pubkey!==event.pubkey)fail('That name is currently reserved by another buyer',409);
        const claimToken=token();db.prepare('UPDATE name_claims SET claim_token_hash=?,updated=? WHERE name=?').run(hash(claimToken),Date.now(),name);
        return res.json({...view(db.prepare('SELECT * FROM name_claims WHERE name=?').get(name)),claimToken});
      }
      if(db.prepare("SELECT COUNT(*) AS n FROM name_claims WHERE pubkey=? AND state IN ('CREATING','WAITING','MEMPOOL','CONFIRMING')").get(event.pubkey).n>=5)fail('Too many pending name purchases',429);
      const claimToken=token(),now=Date.now();
      db.exec('BEGIN IMMEDIATE');
      try{
        const race=db.prepare('SELECT * FROM name_claims WHERE name=?').get(name);
        if(race&&race.state!=='EXPIRED')fail('That name is not available',409);
        if(race)db.prepare('DELETE FROM name_claims WHERE name=?').run(name);
        db.prepare(`INSERT INTO name_claims(name,pubkey,state,claim_token_hash,reserved_at,updated,event_id) VALUES(?,?,?,?,?,?,?)`)
          .run(name,event.pubkey,'CREATING',hash(claimToken),now,now,event.id);
        db.exec('COMMIT');insertedEvent=event.id;
      }catch(error){db.exec('ROLLBACK');throw error;}
      let response,value;
      try{
        response=await fetcher(config.commerceURL.replace(/\/$/,'')+'/v1/invoices',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.commerceToken},
          body:JSON.stringify({pubkey:event.pubkey,feature:'fed_house_name',target:name}),redirect:'error',signal:AbortSignal.timeout(12000)});
        value=await response.json();
      }catch{fail('Payment service unavailable; the name reservation was released',503);}
      if(!response.ok)fail('Payment service could not create an invoice',response.status===429?429:502);
      const sealed=store.seal(event.pubkey,'fed-house:'+name,{token:value.token});
      db.prepare(`UPDATE name_claims SET state='WAITING',invoice_id=?,invoice_secret=?,amount=?,quote_usd_cents=?,quote_xmr_usd=?,address=?,uri=?,expires_at=?,confirmations_required=?,updated=? WHERE name=? AND pubkey=? AND event_id=?`)
        .run(value.id,sealed,Number(value.amount_atomic),Number(value.quote_usd_cents||400),String(value.xmr_usd||''),value.address,value.uri,Number(value.expires_at)*1000,Number(value.confirmations_required||2),Date.now(),name,event.pubkey,event.id);
      res.status(201).json({...view(db.prepare('SELECT * FROM name_claims WHERE name=?').get(name)),claimToken,confirmations:0});
    }catch(error){
      if(insertedEvent){
        const row=db.prepare("SELECT state,event_id FROM name_claims WHERE name=?").get(normalizeName(req.body?.name));
        if(row?.event_id===insertedEvent&&row.state==='CREATING')db.prepare('DELETE FROM name_claims WHERE name=?').run(normalizeName(req.body?.name));
      }
      next(error);
    }
  });

  router.get('/api/claim/:name',async(req,res,next)=>{
    try{
      const name=normalizeName(req.params.name),row=await reconcileName(name);
      if(!row)fail('Claim not found',404);
      const bearer=(req.headers.authorization||'').startsWith('Bearer ')?req.headers.authorization.slice(7):'';
      if(!claimTokenOK(row,bearer))fail('Invalid claim capability',401);
      const current=await reconcileName(name),status=current?._status||null;
      res.json(view(current,{confirmations:Number(status?.confirmations||0),confirmationsRequired:Number(status?.confirmations_required||current.confirmations_required||2)}));
    }catch(error){next(error);}
  });

  router.post('/api/recover',async(req,res,next)=>{
    try{
      if(!allowedOrigin(req))fail('Origin not allowed',403);
      const name=normalizeName(req.body?.name);if(!/^[a-z0-9._-]{1,30}$/.test(name))fail('Invalid name');
      const event=authEvent(req,publicClaimURL('/api/recover'),hash(req.rawBody));consumeChallenge(req.body?.challenge,name);
      const row=await reconcileName(name);if(!row||row.pubkey!==event.pubkey||row.state==='EXPIRED')fail('No recoverable purchase for this key',404);
      const claimToken=token();db.prepare('UPDATE name_claims SET claim_token_hash=?,updated=? WHERE name=? AND pubkey=?').run(hash(claimToken),Date.now(),name,event.pubkey);
      const current=await reconcileName(name),status=current?._status||null;
      res.json({...view(current,{confirmations:Number(status?.confirmations||0),confirmationsRequired:Number(status?.confirmations_required||current.confirmations_required||2)}),claimToken});
    }catch(error){next(error);}
  });

  app.use('/fed-house',router);
  const worker={
    start(){if(timer)return;reconcilePending();timer=setInterval(reconcilePending,fed.pollMs);timer.unref?.();},
    stop(){if(timer){clearInterval(timer);timer=null;}}
  };
  return worker;
}
