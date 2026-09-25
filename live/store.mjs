import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes,createHash,createCipheriv,createDecipheriv } from 'node:crypto';

export const hash=value=>createHash('sha256').update(String(value)).digest('hex');
export const token=(bytes=32)=>randomBytes(bytes).toString('hex');

export function openStore(config){
  mkdirSync(config.data,{recursive:true,mode:0o700});
  const db=new DatabaseSync(join(config.data,'live.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS streams(
      id TEXT PRIMARY KEY,owner TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'planned',
      goal_atomic INTEGER NOT NULL DEFAULT 0,stream_key_hash TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,
      starts INTEGER,ends INTEGER,latest_event TEXT);
    CREATE INDEX IF NOT EXISTS stream_owner ON streams(owner,updated DESC);
    CREATE INDEX IF NOT EXISTS stream_status ON streams(status,updated DESC);
    CREATE TABLE IF NOT EXISTS chat(
      id TEXT PRIMARY KEY,stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL,content TEXT NOT NULL,event TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS chat_stream ON chat(stream_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS tips(
      id TEXT PRIMARY KEY,stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,cap_hash TEXT NOT NULL,
      invoice_id TEXT NOT NULL,invoice_secret TEXT NOT NULL,amount INTEGER NOT NULL,message TEXT NOT NULL,tipper TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'WAITING',confirmations INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,paid_at INTEGER);
    CREATE INDEX IF NOT EXISTS tips_pending ON tips(status,created);
    CREATE INDEX IF NOT EXISTS tips_stream ON tips(stream_id,paid_at DESC);`);
  const key=Buffer.from(config.key,'hex');
  function seal(scope,value){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(scope));
    const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');
  }
  function unseal(scope,value){
    const raw=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));
    decipher.setAAD(Buffer.from(scope));decipher.setAuthTag(raw.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString());
  }
  return {db,seal,unseal,close:()=>db.close()};
}
