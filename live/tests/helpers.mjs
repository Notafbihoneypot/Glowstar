import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey,getPublicKey,finalizeEvent } from 'nostr-tools/pure';
import { loadConfig } from '../config.mjs';
import { createService } from '../server.mjs';
import { hash } from '../store.mjs';

export async function fixture(t,env={},dependencies={}){
  const key=generateSecretKey(),otherKey=generateSecretKey(),owner=getPublicKey(key),other=getPublicKey(otherKey),data=await mkdtemp(join(tmpdir(),'glowstr-live-'));
  const config=loadConfig({LIVE_ALLOWED_PUBKEYS:owner,LIVE_ENCRYPTION_KEY:'ab'.repeat(32),LIVE_DATA:data,LIVE_HLS_PUBLIC_BASE:'https://live.example/hls/live',LIVE_RTMP_PUBLIC_BASE:'rtmp://live.example:1935/live',...env});
  const published=[];
  const service=createService(config,{publisher:async event=>{published.push(event);return {accepted:1,results:[]};},fetcher:async()=>{throw new Error('Unexpected external request');},...dependencies});
  const server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));config.base=config.origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{service.tipWatcher.stop();await new Promise(resolve=>server.close(resolve));service.store.close();await rm(data,{recursive:true,force:true});});
  async function request(path,{method='GET',body,session,headers={}}={}){
    const response=await fetch(config.base+path,{method,headers:{Origin:config.origin,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
    const value=response.headers.get('content-type')?.includes('json')?await response.json():Buffer.from(await response.arrayBuffer());
    return {status:response.status,headers:response.headers,value};
  }
  async function login(privateKey=key){
    const challenge=await request('/api/challenge'),body=JSON.stringify({challenge:challenge.value.challenge});
    const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',config.base+'/api/login'],['method','POST'],['payload',hash(body)]]},privateKey);
    const result=await request('/api/login',{method:'POST',body,headers:{Authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')}});
    return {...result,cookie:result.headers.get('set-cookie')?.split(';')[0],csrf:result.value.csrf};
  }
  return {...service,config,key,otherKey,owner,other,data,published,request,login};
}
export const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
