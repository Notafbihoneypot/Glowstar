import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { createService } from '../server.mjs';
import { loadConfig } from '../config.mjs';
import { hash } from '../store.mjs';
export async function fixture(t,env={},dependencies={}){
  const key=generateSecretKey(),otherKey=generateSecretKey(),owner=getPublicKey(key),other=getPublicKey(otherKey),data=await mkdtemp(join(tmpdir(),'crosspost-test-'));
  const config=loadConfig({CROSSPOST_ALLOWED_PUBKEYS:owner+','+other,CROSSPOST_ENCRYPTION_KEY:'ab'.repeat(32),CROSSPOST_DATA:data,CROSSPOST_PREVIEW_ONLY:'false',CROSSPOST_ACTIVITYPUB_HOSTS:'fedi.example',...env});
  const service=createService(config,{fetcher:async()=>{throw new Error('Unexpected external request');},...dependencies});
  const server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));config.base=config.origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{service.worker.stop();service.nameWorker.stop();await new Promise(resolve=>server.close(resolve));service.store.close();await rm(data,{recursive:true,force:true});});
  async function request(path,{method='GET',body,session,headers={}}={}){
    const response=await fetch(config.base+path,{method,headers:{Origin:config.origin,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
    return {status:response.status,headers:response.headers,value:response.headers.get('content-type')?.includes('json')?await response.json():Buffer.from(await response.arrayBuffer())};
  }
  async function login(privateKey=key,mutate=e=>e){const challenge=await request('/api/challenge'),body=JSON.stringify({challenge:challenge.value.challenge}),event=finalizeEvent(mutate({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',config.base+'/api/login'],['method','POST'],['payload',hash(body)]]}),privateKey),authorization='Nostr '+Buffer.from(JSON.stringify(event)).toString('base64');const result=await request('/api/login',{method:'POST',body,headers:{Authorization:authorization}});return {...result,cookie:result.headers.get('set-cookie')?.split(';')[0],csrf:result.value.csrf,body,authorization};}
  return {...service,config,data,key,otherKey,owner,other,request,login};
}
export const response=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...headers}});
export const note=(key,content,tags=[])=>finalizeEvent({kind:1,created_at:Math.floor(Date.now()/1000),content,tags},key);
export function connect(f,platform='x',identity='123',secret={accessToken:'test-token'}){f.store.saveConnection(f.owner,platform,{identity,label:'@example',profileURL:'https://example.com/profile',secret});}
export const postBody=()=>({text:'A public update',destinations:['x'],expectedIdentities:{x:'123'},confirmPublic:true});
