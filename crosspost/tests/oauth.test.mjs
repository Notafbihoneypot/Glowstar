import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, response } from './helpers.mjs';
import { blueskyClientMetadata, startStandardOAuth, finishStandardOAuth, xAccessToken } from '../oauth.mjs';

test('X OAuth uses PKCE, stable user IDs, refresh tokens, and one-use state',async t=>{
  const f=await fixture(t,{CROSSPOST_X_CLIENT_ID:'x-client'});
  const authorize=new URL(await startStandardOAuth(f.config,f.store,f.owner,'x'));
  assert.equal(authorize.origin,'https://x.com');
  assert.equal(authorize.pathname,'/i/oauth2/authorize');
  assert.equal(authorize.searchParams.get('client_id'),'x-client');
  assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
  assert.match(authorize.searchParams.get('scope'),/tweet\.write/);
  assert.match(authorize.searchParams.get('scope'),/offline\.access/);
  const state=authorize.searchParams.get('state'),calls=[];
  const fetcher=async(url,options={})=>{calls.push({url,options});
    if(url==='https://api.x.com/2/oauth2/token')return response({access_token:'x-access',refresh_token:'x-refresh',expires_in:7200});
    if(url==='https://api.x.com/2/users/me')return response({data:{id:'42',username:'alice'}});
    throw new Error('Unexpected '+url);
  };
  const params=new URLSearchParams({state,code:'auth-code'});
  const linked=await finishStandardOAuth(f.config,f.store,'x',params,fetcher);
  assert.equal(linked.owner,f.owner);assert.equal(linked.account.identity,'42');assert.equal(linked.account.label,'@alice');
  assert.equal(linked.account.secret.refreshToken,'x-refresh');assert.equal(linked.account.secret.auth,'oauth2');
  assert.ok(String(calls[0].options.body).includes('code_verifier='));
  await assert.rejects(finishStandardOAuth(f.config,f.store,'x',params,fetcher),/expired/i);
});

test('Mastodon OAuth dynamically registers, uses PKCE, and binds server plus account ID',async t=>{
  const f=await fixture(t),calls=[];
  const fetcher=async(url,options={})=>{calls.push({url,options});
    if(url==='https://mastodon.social/api/v1/apps')return response({client_id:'m-client',client_secret:'m-secret'});
    if(url==='https://mastodon.social/oauth/token')return response({access_token:'m-access'});
    if(url==='https://mastodon.social/api/v1/accounts/verify_credentials')return response({id:'77',acct:'alice',url:'https://mastodon.social/@alice'});
    if(url==='https://mastodon.social/api/v2/instance')return response({configuration:{statuses:{max_characters:5000}}});
    throw new Error('Unexpected '+url);
  };
  const authorize=new URL(await startStandardOAuth(f.config,f.store,f.owner,'mastodon',{server:'https://mastodon.social'},fetcher));
  assert.equal(authorize.href.startsWith('https://mastodon.social/oauth/authorize?'),true);
  assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
  assert.match(authorize.searchParams.get('scope'),/write%3Astatuses|write:statuses/);
  const linked=await finishStandardOAuth(f.config,f.store,'mastodon',new URLSearchParams({state:authorize.searchParams.get('state'),code:'m-code'}),fetcher);
  assert.equal(linked.account.identity,'https://mastodon.social:77');assert.equal(linked.account.label,'@alice@mastodon.social');assert.equal(linked.account.secret.limit,5000);
  assert.equal(calls.filter(c=>c.url.endsWith('/api/v1/apps')).length,1);
  await startStandardOAuth(f.config,f.store,f.owner,'mastodon',{server:'https://mastodon.social'},fetcher);
  assert.equal(calls.filter(c=>c.url.endsWith('/api/v1/apps')).length,1);
  const raw=f.store.db.prepare('SELECT payload FROM oauth_apps').get().payload;assert.equal(raw.includes('m-secret'),false);
});

test('X access token refresh rotates credentials without changing the linked identity',async t=>{
  const f=await fixture(t,{CROSSPOST_X_CLIENT_ID:'x-client'}),account={identity:'42',label:'@alice',profileURL:'https://x.com/alice',secret:{auth:'oauth2',accessToken:'old',refreshToken:'refresh-1',expiresAt:Date.now()-1}};
  f.store.saveConnection(f.owner,'x',account);const connection=f.store.connection(f.owner,'x');
  const access=await xAccessToken(f.config,f.store,f.owner,connection,async(url,options)=>{
    assert.equal(url,'https://api.x.com/2/oauth2/token');assert.ok(String(options.body).includes('refresh_token=refresh-1'));
    return response({access_token:'new',refresh_token:'refresh-2',expires_in:7200});
  });
  assert.equal(access,'new');const saved=f.store.connection(f.owner,'x');assert.equal(saved.identity,'42');assert.equal(saved.secret.refreshToken,'refresh-2');assert.equal(saved.secret.accessToken,'new');
});

test('Bluesky publishes granular OAuth metadata without requesting account passwords',async t=>{
  const f=await fixture(t),metadata=blueskyClientMetadata(f.config);
  assert.match(metadata.scope,/repo:app\.bsky\.feed\.post/);assert.match(metadata.scope,/blob:image\/jpeg/);
  assert.equal(JSON.stringify(metadata).includes('password'),false);
  assert.ok(metadata.redirect_uris.some(uri=>uri.includes('/oauth/bluesky/callback')));
});
