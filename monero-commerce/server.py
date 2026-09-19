#!/usr/bin/env python3
"""Glowstr Monero Commerce service.

Small dependency-free service for XMR invoices and Nostr-pubkey entitlements.
Keep monero-wallet-rpc on loopback. Never expose wallet RPC to the browser.
"""
from __future__ import annotations
import base64, hashlib, json, os, secrets, sqlite3, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import build_opener, HTTPDigestAuthHandler, HTTPPasswordMgrWithDefaultRealm, Request

DB=os.getenv("GLOWSTR_COMMERCE_DB","/data/commerce.sqlite3")
HOST=os.getenv("GLOWSTR_COMMERCE_HOST","127.0.0.1")
PORT=int(os.getenv("GLOWSTR_COMMERCE_PORT","8787"))
RPC=os.getenv("MONERO_WALLET_RPC","http://127.0.0.1:18083/json_rpc")
RPC_USER=os.getenv("MONERO_RPC_USER","")
RPC_PASS=os.getenv("MONERO_RPC_PASS","")
ACCOUNT=int(os.getenv("MONERO_ACCOUNT_INDEX","0"))
CONFIRMATIONS=max(1,int(os.getenv("GLOWSTR_XMR_CONFIRMATIONS","2")))
ORIGIN=os.getenv("GLOWSTR_ALLOWED_ORIGIN","https://glowstr.com")
ADMIN_TOKEN=os.getenv("GLOWSTR_COMMERCE_ADMIN_TOKEN","")
ATOMIC=10**12
FEATURES={
 "relay_30d": {"amount": 20000000000, "seconds": 30*86400, "label":"30 day paid relay"},
 "room_30d": {"amount": 10000000000, "seconds": 30*86400, "label":"30 day paid room"},
 "storage_10gb_30d": {"amount": 30000000000, "seconds":30*86400, "label":"10 GB storage / 30 days"},
 "creator_30d": {"amount": 10000000000, "seconds":30*86400, "label":"creator support / 30 days"},
}

def db():
 os.makedirs(os.path.dirname(DB) or ".",exist_ok=True)
 c=sqlite3.connect(DB); c.row_factory=sqlite3.Row
 c.execute("""CREATE TABLE IF NOT EXISTS invoices(
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, pubkey TEXT NOT NULL, feature TEXT NOT NULL,
 target TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL, account_index INTEGER NOT NULL,
 address_index INTEGER NOT NULL, address TEXT NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, paid_at INTEGER, txid TEXT, confirmations INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'WAITING')""")
 c.execute("""CREATE TABLE IF NOT EXISTS entitlements(
 pubkey TEXT NOT NULL, feature TEXT NOT NULL, target TEXT NOT NULL DEFAULT '',
 valid_until INTEGER NOT NULL, invoice_id TEXT NOT NULL, PRIMARY KEY(pubkey,feature,target))""")
 c.commit(); return c

def rpc(method,params=None):
 payload=json.dumps({"jsonrpc":"2.0","id":"glowstr","method":method,"params":params or {}}).encode()
 req=Request(RPC,data=payload,headers={"Content-Type":"application/json"})
 if RPC_USER:
  mgr=HTTPPasswordMgrWithDefaultRealm(); mgr.add_password(None,RPC,RPC_USER,RPC_PASS)
  opener=build_opener(HTTPDigestAuthHandler(mgr))
 else: opener=build_opener()
 with opener.open(req,timeout=12) as r: out=json.load(r)
 if out.get("error"): raise RuntimeError(str(out["error"]))
 return out["result"]

def token_hash(token): return hashlib.sha256(token.encode()).hexdigest()
def valid_pubkey(s): return isinstance(s,str) and len(s)==64 and all(c in "0123456789abcdefABCDEF" for c in s)
def invoice_uri(address,amount,label):
 # Standard Monero URI. Amount is rendered from atomic units without float math.
 whole,frac=divmod(amount,ATOMIC)
 amount_s=str(whole)+(("."+f"{frac:012d}".rstrip("0")) if frac else "")
 from urllib.parse import urlencode
 return "monero:"+address+"?"+urlencode({"tx_amount":amount_s,"tx_description":label})

def refresh_invoice(c,row):
 if row["status"]=="PAID": return row
 now=int(time.time())
 result=rpc("get_transfers",{"in":True,"pool":True,"account_index":row["account_index"],"subaddr_indices":[row["address_index"]]})
 candidates=(result.get("pool") or [])+(result.get("in") or [])
 best=None
 for tx in candidates:
  idx=tx.get("subaddr_index") or {}
  if idx.get("major")!=row["account_index"] or idx.get("minor")!=row["address_index"]: continue
  if int(tx.get("amount",0)) < row["amount"] or tx.get("double_spend_seen"): continue
  if best is None or int(tx.get("confirmations",0))>int(best.get("confirmations",0)): best=tx
 status="EXPIRED" if now>row["expires_at"] else "WAITING"; conf=0; txid=None; paid_at=None
 if best:
  conf=int(best.get("confirmations",0)); txid=best.get("txid")
  status="PAID" if conf>=CONFIRMATIONS else ("CONFIRMING" if conf else "MEMPOOL")
  if status=="PAID": paid_at=now
 c.execute("UPDATE invoices SET status=?,confirmations=?,txid=?,paid_at=COALESCE(paid_at,?) WHERE id=?",(status,conf,txid,paid_at,row["id"]))
 if status=="PAID":
  spec=FEATURES[row["feature"]]; current=c.execute("SELECT valid_until FROM entitlements WHERE pubkey=? AND feature=? AND target=?",(row["pubkey"],row["feature"],row["target"])).fetchone()
  base=max(now,int(current["valid_until"]) if current else now); until=base+spec["seconds"]
  c.execute("""INSERT INTO entitlements(pubkey,feature,target,valid_until,invoice_id) VALUES(?,?,?,?,?)
   ON CONFLICT(pubkey,feature,target) DO UPDATE SET valid_until=excluded.valid_until,invoice_id=excluded.invoice_id""",(row["pubkey"],row["feature"],row["target"],until,row["id"]))
 c.commit(); return c.execute("SELECT * FROM invoices WHERE id=?",(row["id"],)).fetchone()

class H(BaseHTTPRequestHandler):
 server_version="GlowstrCommerce/0.1"
 def log_message(self,fmt,*args): print("%s - %s"%(self.address_string(),fmt%args))
 def _headers(self,code=200):
  self.send_response(code); self.send_header("Content-Type","application/json"); self.send_header("Cache-Control","no-store")
  if ORIGIN: self.send_header("Access-Control-Allow-Origin",ORIGIN); self.send_header("Vary","Origin")
  self.send_header("Access-Control-Allow-Headers","Content-Type, Authorization"); self.send_header("Access-Control-Allow-Methods","GET,POST,OPTIONS"); self.end_headers()
 def out(self,obj,code=200): self._headers(code); self.wfile.write(json.dumps(obj,separators=(",",":")).encode())
 def body(self):
  n=min(int(self.headers.get("Content-Length","0")),8192); return json.loads(self.rfile.read(n) or b"{}")
 def do_OPTIONS(self): self._headers(204)
 def do_POST(self):
  try:
   if self.path!="/v1/invoices": return self.out({"error":"not_found"},404)
   p=self.body(); pubkey=str(p.get("pubkey","")).lower(); feature=str(p.get("feature","")); target=str(p.get("target",""))[:160]
   if not valid_pubkey(pubkey): return self.out({"error":"invalid_pubkey"},400)
   if feature not in FEATURES: return self.out({"error":"unknown_feature","features":FEATURES},400)
   inv=secrets.token_urlsafe(18); token=secrets.token_urlsafe(32); now=int(time.time()); spec=FEATURES[feature]
   a=rpc("create_address",{"account_index":ACCOUNT,"label":"glowstr:"+inv,"count":1})
   address=a.get("address") or (a.get("addresses") or [None])[0]; idx=a.get("address_index")
   if idx is None: idx=(a.get("address_indices") or [None])[0]
   if not address or idx is None: raise RuntimeError("wallet RPC did not return subaddress")
   c=db(); c.execute("INSERT INTO invoices(id,token_hash,pubkey,feature,target,amount,account_index,address_index,address,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(inv,token_hash(token),pubkey,feature,target,spec["amount"],ACCOUNT,int(idx),address,now,now+1800)); c.commit()
   return self.out({"id":inv,"token":token,"status":"WAITING","address":address,"amount_atomic":spec["amount"],"uri":invoice_uri(address,spec["amount"],spec["label"]),"expires_at":now+1800,"confirmations_required":CONFIRMATIONS})
  except Exception as e: return self.out({"error":"server_error","detail":str(e)[:180]},500)
 def do_GET(self):
  try:
   if self.path=="/health": return self.out({"ok":True})
   if self.path=="/v1/features": return self.out({"features":FEATURES,"confirmations_required":CONFIRMATIONS})
   if self.path.startswith("/v1/invoices/"):
    iid=self.path.split("/")[-1]; auth=self.headers.get("Authorization","")
    if not auth.startswith("Bearer "): return self.out({"error":"unauthorized"},401)
    c=db(); row=c.execute("SELECT * FROM invoices WHERE id=?",(iid,)).fetchone()
    if not row or not secrets.compare_digest(row["token_hash"],token_hash(auth[7:])): return self.out({"error":"unauthorized"},401)
    row=refresh_invoice(c,row)
    return self.out({"id":row["id"],"status":row["status"],"amount_atomic":row["amount"],"address":row["address"],"confirmations":row["confirmations"],"confirmations_required":CONFIRMATIONS,"expires_at":row["expires_at"]})
   if self.path.startswith("/v1/admin/entitlements/"):
    if not ADMIN_TOKEN or not secrets.compare_digest(self.headers.get("Authorization",""),"Bearer "+ADMIN_TOKEN): return self.out({"error":"unauthorized"},401)
    pubkey=self.path.split("/")[-1].lower()
    if not valid_pubkey(pubkey): return self.out({"error":"invalid_pubkey"},400)
    now=int(time.time()); rows=db().execute("SELECT feature,target,valid_until,invoice_id FROM entitlements WHERE pubkey=? AND valid_until>?",(pubkey,now)).fetchall()
    return self.out({"pubkey":pubkey,"entitlements":[dict(x) for x in rows]})
   return self.out({"error":"not_found"},404)
  except Exception as e: return self.out({"error":"server_error","detail":str(e)[:180]},500)

if __name__=="__main__":
 print(f"Glowstr Commerce listening on {HOST}:{PORT}; wallet RPC={RPC}")
 ThreadingHTTPServer((HOST,PORT),H).serve_forever()
