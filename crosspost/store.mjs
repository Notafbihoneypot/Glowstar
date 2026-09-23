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
    CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,owner TEXT NOT NULL,alt TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,public INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_key TEXT NOT NULL,digest TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(owner,request_key));
    CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY,post_id TEXT NOT NULL REFERENCES posts(id),platform TEXT NOT NULL,identity TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,due INTEGER NOT NULL,checkpoint TEXT NOT NULL DEFAULT '{}',result TEXT,error TEXT,UNIQUE(post_id,platform));
    CREATE INDEX IF NOT EXISTS queue ON deliveries(status,due);
    CREATE TABLE IF NOT EXISTS clock(id INTEGER PRIMARY KEY CHECK(id=1),micros INTEGER NOT NULL); INSERT OR IGNORE INTO clock VALUES(1,0);`);
  db.exec("UPDATE deliveries SET status=CASE WHEN status='publishing' THEN 'uncertain' ELSE 'queued' END,error='Interrupted delivery; inspect destination before retrying' WHERE status IN ('working','publishing')");
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
  function nextRecordKey() {
    const micros=Math.max(Date.now()*1000,db.prepare('SELECT micros FROM clock WHERE id=1').get().micros+1); db.prepare('UPDATE clock SET micros=? WHERE id=1').run(micros);
    let n=BigInt(micros)<<10n,s=''; for(let i=0;i<13;i++){s='234567abcdefghijklmnopqrstuvwxyz'[Number(n&31n)]+s;n>>=5n;} return s;
  }
  return {db,seal,unseal,connection,saveConnection,nextRecordKey,close:()=>db.close()};
}
