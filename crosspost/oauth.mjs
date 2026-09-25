import { randomBytes, createHash } from 'node:crypto';
import { Agent } from '@atproto/api';
import { NodeOAuthClient, buildAtprotoLoopbackClientMetadata } from '@atproto/oauth-client-node';
import { allowedServer, Problem } from './validation.mjs';

const BSKY_SCOPE='atproto repo:app.bsky.feed.post blob:image/jpeg';
const MASTODON_SCOPE='read:accounts write:statuses write:media';
const X_SCOPE='tweet.read tweet.write users.read media.write offline.access';
const verifier=()=>randomBytes(48).toString('base64url');
const challenge=value=>createHash('sha256').update(value).digest('base64url');
const callback=(config,platform)=>config.base+'/oauth/'+platform+'/callback';

async function jsonFetch(fetcher,url,{method='GET',headers={},form,json}={}){
  const init={method,headers:{...headers},redirect:'error',signal:AbortSignal.timeout(20000)};
  if(form){init.body=new URLSearchParams(form);init.headers['Content-Type']='application/x-www-form-urlencoded';}
  if(json!==undefined){init.body=JSON.stringify(json);init.headers['Content-Type']='application/json';}
  let response;
  try{response=await fetcher(url,init);}catch{throw new Problem('Authorization provider could not be reached',502);}
  let body={};try{body=await response.json();}catch{}
  if(!response.ok)throw new Problem(body.error_description||body.error||body.message||('Authorization provider returned HTTP '+response.status),response.status>=500?502:400);
  return body;
}
function safeProfile(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}}

export function blueskyClientMetadata(config){
  const redirectURI=callback(config,'bluesky');
  if(!config.secure){
    const port=new URL(config.base).port||'80';
    return buildAtprotoLoopbackClientMetadata({scope:BSKY_SCOPE,redirect_uris:['http://127.0.0.1:'+port+'/oauth/bluesky/callback']});
  }
  return {
    client_id:config.base+'/oauth/bluesky/client-metadata.json',
    client_name:'Glowstr Crosspost',
    client_uri:config.base+'/',
    redirect_uris:[redirectURI],
    grant_types:['authorization_code','refresh_token'],
    response_types:['code'],
    scope:BSKY_SCOPE,
    application_type:'web',
    token_endpoint_auth_method:'none',
    dpop_bound_access_tokens:true,
  };
}
function blueskyClient(config,store,owner){
  return new NodeOAuthClient({
    clientMetadata:blueskyClientMetadata(config),
    stateStore:{
      async get(key){return store.oauthState(owner,key);},
      async set(key,value){store.saveOAuthState(owner,key,value);},
      async del(key){store.deleteOAuthState(owner,key);},
    },
    sessionStore:{
      async get(sub){return store.oauthSession(owner,sub);},
      async set(sub,value){store.saveOAuthSession(owner,sub,value);},
      async del(sub){store.deleteOAuthSession(owner,sub);},
    },
  });
}
export async function startBlueskyOAuth(config,store,owner,handle){
  if(typeof handle!=='string'||!handle.trim()||handle.length>254)throw new Problem('Enter a Bluesky handle or DID');
  const clean=handle.trim();
  const client=blueskyClient(config,store,owner);
  const url=await client.authorize(clean,{state:JSON.stringify({handle:clean})});
  return String(url);
}
export async function finishBlueskyOAuth(config,store,params){
  const key=params.get('state');if(!key)throw new Problem('Missing Bluesky OAuth state');
  const owner=store.oauthStateOwner(key);if(!owner)throw new Problem('Bluesky authorization expired; start again');
  const client=blueskyClient(config,store,owner);
  let result;try{result=await client.callback(params);}catch{throw new Problem('Bluesky authorization failed; start again');}
  let handle=result.session.did;try{const parsed=JSON.parse(result.state||'{}');if(typeof parsed.handle==='string'&&parsed.handle)handle=parsed.handle;}catch{}
  return {owner,platform:'bluesky',account:{identity:result.session.did,label:handle.startsWith('did:')?handle:'@'+handle.replace(/^@/,''),profileURL:'https://bsky.app/profile/'+encodeURIComponent(result.session.did),secret:{auth:'oauth',subject:result.session.did}}};
}
export async function blueskyAgent(config,store,owner,did){
  const client=blueskyClient(config,store,owner);
  const session=await client.restore(did);
  return new Agent(session);
}
export async function revokeBluesky(config,store,owner,did){
  try{await blueskyClient(config,store,owner).revoke(did);}catch{store.deleteOAuthSession(owner,did);}
}

async function mastodonApp(config,store,platform,server,fetcher){
  let app=store.oauthApp(platform,server);if(app)return app;
  app=await jsonFetch(fetcher,server+'/api/v1/apps',{method:'POST',json:{client_name:'Glowstr Crosspost',redirect_uris:callback(config,platform),scopes:MASTODON_SCOPE,website:config.base+'/'}});
  if(!app.client_id||!app.client_secret)throw new Problem('Server did not return OAuth application credentials');
  const saved={clientId:app.client_id,clientSecret:app.client_secret};store.saveOAuthApp(platform,server,saved);return saved;
}
export async function startStandardOAuth(config,store,owner,platform,input={},fetcher=fetch){
  const state=randomBytes(32).toString('hex'),codeVerifier=verifier(),codeChallenge=challenge(codeVerifier);
  if(platform==='x'){
    if(!config.xClientId)throw new Problem('X OAuth is not configured on this server',409);
    store.saveOAuthFlow(state,owner,platform,{codeVerifier});
    const url=new URL('https://x.com/i/oauth2/authorize');url.search=new URLSearchParams({response_type:'code',client_id:config.xClientId,redirect_uri:callback(config,'x'),scope:X_SCOPE,state,code_challenge:codeChallenge,code_challenge_method:'S256'});return url.href;
  }
  if(!['mastodon','activitypub'].includes(platform))throw new Problem('Unsupported OAuth provider');
  const hosts=platform==='mastodon'?config.mastodonHosts:config.activitypubHosts,server=allowedServer(input.server||'',hosts),app=await mastodonApp(config,store,platform,server,fetcher);
  store.saveOAuthFlow(state,owner,platform,{server,codeVerifier,clientId:app.clientId,clientSecret:app.clientSecret});
  const url=new URL(server+'/oauth/authorize');url.search=new URLSearchParams({response_type:'code',client_id:app.clientId,redirect_uri:callback(config,platform),scope:MASTODON_SCOPE,state,code_challenge:codeChallenge,code_challenge_method:'S256'});return url.href;
}
export async function finishStandardOAuth(config,store,platform,params,fetcher=fetch){
  const state=params.get('state'),code=params.get('code');if(!state||!code)throw new Problem('Authorization was not completed');
  const flow=store.takeOAuthFlow(state,platform);if(!flow)throw new Problem('Authorization expired; start again');
  if(platform==='x'){
    const form={grant_type:'authorization_code',code,redirect_uri:callback(config,'x'),code_verifier:flow.codeVerifier};
    const headers={};if(config.xClientSecret)headers.Authorization='Basic '+Buffer.from(config.xClientId+':'+config.xClientSecret).toString('base64');else form.client_id=config.xClientId;
    const token=await jsonFetch(fetcher,'https://api.x.com/2/oauth2/token',{method:'POST',headers,form});
    if(!token.access_token)throw new Problem('X did not return an access token');
    const me=await jsonFetch(fetcher,'https://api.x.com/2/users/me',{headers:{Authorization:'Bearer '+token.access_token}});
    if(!me.data?.id||!me.data?.username)throw new Problem('X did not identify the authorized account');
    return {owner:flow.owner,platform,account:{identity:me.data.id,label:'@'+me.data.username,profileURL:'https://x.com/'+encodeURIComponent(me.data.username),secret:{auth:'oauth2',accessToken:token.access_token,refreshToken:token.refresh_token||'',expiresAt:Date.now()+Number(token.expires_in||7200)*1000}}};
  }
  const token=await jsonFetch(fetcher,flow.server+'/oauth/token',{method:'POST',form:{grant_type:'authorization_code',client_id:flow.clientId,client_secret:flow.clientSecret,redirect_uri:callback(config,platform),code,code_verifier:flow.codeVerifier}});
  if(!token.access_token)throw new Problem('Server did not return an access token');
  const account=await jsonFetch(fetcher,flow.server+'/api/v1/accounts/verify_credentials',{headers:{Authorization:'Bearer '+token.access_token}});
  if(!account.id||!account.acct)throw new Problem('Server did not identify the authorized account');
  let limit=500;try{const instance=await jsonFetch(fetcher,flow.server+'/api/v2/instance');limit=instance.configuration?.statuses?.max_characters||500;}catch{}
  if(!Number.isInteger(limit)||limit<1||limit>65000)limit=500;
  return {owner:flow.owner,platform,account:{identity:flow.server+':'+account.id,label:'@'+(account.acct.includes('@')?account.acct:account.acct+'@'+new URL(flow.server).hostname),profileURL:safeProfile(account.url),secret:{auth:'oauth2',server:flow.server,accessToken:token.access_token,limit}}};
}
export async function xAccessToken(config,store,owner,connection,fetcher=fetch){
  const secret=connection.secret;if(secret.auth!=='oauth2'||!secret.refreshToken||!secret.expiresAt||secret.expiresAt>Date.now()+60000)return secret.accessToken;
  if(!config.xClientId)throw new Error('X OAuth configuration is missing; reconnect this identity');
  const form={grant_type:'refresh_token',refresh_token:secret.refreshToken};const headers={};if(config.xClientSecret)headers.Authorization='Basic '+Buffer.from(config.xClientId+':'+config.xClientSecret).toString('base64');else form.client_id=config.xClientId;
  const token=await jsonFetch(fetcher,'https://api.x.com/2/oauth2/token',{method:'POST',headers,form});
  if(!token.access_token)throw new Error('X token refresh failed; reconnect this identity');
  const next={...secret,accessToken:token.access_token,refreshToken:token.refresh_token||secret.refreshToken,expiresAt:Date.now()+Number(token.expires_in||7200)*1000};
  if(!store.replaceConnectionSecret(owner,'x',connection.identity,connection.sealed,next))throw new Error('X identity changed while refreshing; create a new post after reviewing the account');connection.secret=next;connection.sealed=store.connection(owner,'x')?.sealed||connection.sealed;return next.accessToken;
}
