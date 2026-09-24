import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('hex');
export function openStore(config) {
  mkdirSync(config.data,{recursive:true,mode:0o700}); mkdirSync(join(config.data,'media'),{recursive:true,mode:0o700});
  const db = new DatabaseSync(join(config.data,'crosspost.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS connections(owner TEXT NOT NULL,platform TEXT NOT NULL,identity TEXT NOT NULL,label TEXT NOT NULL,profile_url TEXT NOT NULL,secret TEXT NOT NULL,PRIMARY KEY(owner,platform));
    CREATE TABLE IF NOT EXISTS oauth_flows(id TEXT PRIMARY KEY,owner TEXT NOT NULL,platform TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_states(id TEXT PRIMARY KEY,owner TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_sessions(owner TEXT NOT NULL,subject TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,subject));
    CREATE TABLE IF NOT EXISTS oauth_apps(platform TEXT NOT NULL,server TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(platform,server));
    CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,owner TEXT NOT NULL,alt TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,public INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_key TEXT NOT NULL,digest TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(owner,request_key));
    CREATE TABLE IF NOT EXISTS name_challenges(id TEXT PRIMARY KEY,name TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS name_claims(
      name TEXT PRIMARY KEY COLLATE NOCASE,pubkey TEXT NOT NULL,state TEXT NOT NULL,invoice_id TEXT,invoice_secret TEXT,claim_token_hash TEXT NOT NULL,
      amount INTEGER,quote_usd_cents INTEGER,quote_xmr_usd TEXT,address TEXT,uri TEXT,confirmations_required INTEGER,reserved_at INTEGER NOT NULL,
      expires_at INTEGER,activated_at INTEGER,updated INTEGER NOT NULL,event_id TEXT NOT NULL UNIQUE);
    CREATE INDEX IF NOT EXISTS name_claim_state ON name_claims(state,updated);
    CREATE INDEX IF NOT EXISTS name_claim_pubkey ON name_claims(pubkey,state);
    CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY,post_id TEXT NOT NULL REFERENCES posts(id),platform TEXT NOT NULL,identity TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,due INTEGER NOT NULL,checkpoint TEXT NOT NULL DEFAULT '{}',result TEXT,error TEXT,UNIQUE(post_id,platform));
    CREATE INDEX IF NOT EXISTS queue ON deliveries(status,due);
    CREATE INDEX IF NOT EXISTS oauth_flow_expiry ON oauth_flows(expires);
    CREATE INDEX IF NOT EXISTS oauth_state_expiry ON oauth_states(expires);
    CREATE TABLE IF NOT EXISTS clock(id INTEGER PRIMARY KEY CHECK(id=1),micros INTEGER NOT NULL); INSERT OR IGNORE INTO clock VALUES(1,0);`);
  db.exec("UPDATE deliveries SET status=CASE WHEN status='publishing' THEN 'uncertain' ELSE 'queued' END,error='Interrupted delivery; inspect destination before retrying' WHERE status IN ('working','publishing')");
  db.prepare('DELETE FROM oauth_flows WHERE expires<?').run(Date.now());db.prepare('DELETE FROM oauth_states WHERE expires<?').run(Date.now());
  const key = Buffer.from(config.key,'hex');
  function seal(owner,platform,value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,iv); cipher.setAAD(Buffer.from(owner+':'+platform));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]); return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');
  }
  function unseal(owner,platform,value) {
    const raw=Buffer.from(value,'base64'), decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));
    decipher.setAAD(Buffer.from(owner+':'+platform)); decipher.setAuthTag(raw.subarray(12,28)); return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString());
  }
  function connection(owner,platform) {
    const row=db.prepare('SELECT * FROM connections WHERE owner=? AND platform=?').get(owner,platform);
    return row ? {...row,sealed:row.secret,secret:unseal(owner,platform,row.secret)} : null;
  }
  function saveConnection(owner,platform,account) {
    db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?) ON CONFLICT(owner,platform) DO UPDATE SET identity=excluded.identity,label=excluded.label,profile_url=excluded.profile_url,secret=excluded.secret')
      .run(owner,platform,account.identity,account.label,account.profileURL || '',seal(owner,platform,account.secret));
  }
  function replaceConnectionSecret(owner,platform,identity,expectedSealed,next) {
    return db.prepare('UPDATE connections SET secret=? WHERE owner=? AND platform=? AND identity=? AND secret=?')
      .run(seal(owner,platform,next),owner,platform,identity,expectedSealed).changes===1;
  }
  function saveOAuthFlow(id,owner,platform,value,ttl=10*60*1000) {
    db.prepare('INSERT OR REPLACE INTO oauth_flows VALUES(?,?,?,?,?)').run(id,owner,platform,seal(owner,'oauth-flow:'+platform,value),Date.now()+ttl);
  }
  function takeOAuthFlow(id,platform) {
    const row=db.prepare('SELECT * FROM oauth_flows WHERE id=? AND platform=? AND expires>?').get(id,platform,Date.now());
    db.prepare('DELETE FROM oauth_flows WHERE id=?').run(id);
    return row?{owner:row.owner,...unseal(row.owner,'oauth-flow:'+platform,row.payload)}:null;
  }
  function saveOAuthState(owner,id,value,ttl=15*60*1000) {
    db.prepare('INSERT OR REPLACE INTO oauth_states VALUES(?,?,?,?)').run(id,owner,seal(owner,'oauth-state',value),Date.now()+ttl);
  }
  function oauthState(owner,id) {
    const row=db.prepare('SELECT payload FROM oauth_states WHERE id=? AND owner=? AND expires>?').get(id,owner,Date.now());return row?unseal(owner,'oauth-state',row.payload):undefined;
  }
  function oauthStateOwner(id) { return db.prepare('SELECT owner FROM oauth_states WHERE id=? AND expires>?').get(id,Date.now())?.owner || null; }
  function deleteOAuthState(owner,id) { db.prepare('DELETE FROM oauth_states WHERE id=? AND owner=?').run(id,owner); }
  function saveOAuthSession(owner,subject,value) {
    db.prepare('INSERT INTO oauth_sessions VALUES(?,?,?) ON CONFLICT(owner,subject) DO UPDATE SET payload=excluded.payload').run(owner,subject,seal(owner,'oauth-session:'+subject,value));
  }
  function oauthSession(owner,subject) {
    const row=db.prepare('SELECT payload FROM oauth_sessions WHERE owner=? AND subject=?').get(owner,subject);return row?unseal(owner,'oauth-session:'+subject,row.payload):undefined;
  }
  function deleteOAuthSession(owner,subject) { db.prepare('DELETE FROM oauth_sessions WHERE owner=? AND subject=?').run(owner,subject); }
  function saveOAuthApp(platform,server,value) {
    db.prepare('INSERT INTO oauth_apps VALUES(?,?,?) ON CONFLICT(platform,server) DO UPDATE SET payload=excluded.payload').run(platform,server,seal('operator','oauth-app:'+platform+':'+server,value));
  }
  function oauthApp(platform,server) {
    const row=db.prepare('SELECT payload FROM oauth_apps WHERE platform=? AND server=?').get(platform,server);return row?unseal('operator','oauth-app:'+platform+':'+server,row.payload):null;
  }
  function nextRecordKey() {
    const micros=Math.max(Date.now()*1000,db.prepare('SELECT micros FROM clock WHERE id=1').get().micros+1); db.prepare('UPDATE clock SET micros=? WHERE id=1').run(micros);
    let n=BigInt(micros)<<10n,s=''; for(let i=0;i<13;i++){s='234567abcdefghijklmnopqrstuvwxyz'[Number(n&31n)]+s;n>>=5n;} return s;
  }
  return {db,seal,unseal,connection,saveConnection,replaceConnectionSecret,saveOAuthFlow,takeOAuthFlow,saveOAuthState,oauthState,oauthStateOwner,deleteOAuthState,saveOAuthSession,oauthSession,deleteOAuthSession,saveOAuthApp,oauthApp,nextRecordKey,close:()=>db.close()};
}
