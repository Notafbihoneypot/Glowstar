#!/usr/bin/env python3
"""Glowstr Monero Commerce service.

Annual XMR-paid relay access with server-side payment reconciliation.
Keep monero-wallet-rpc on loopback. Never expose wallet RPC to the browser.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
from decimal import Decimal, ROUND_UP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlparse, parse_qs
from urllib.request import (
    build_opener,
    HTTPDigestAuthHandler,
    HTTPPasswordMgrWithDefaultRealm,
    Request,
    urlopen,
)

ATOMIC = 10**12
YEAR_SECONDS = 365 * 86400
REMINDER_SECONDS = 30 * 86400


def read_secret(env_name, file_env_name):
    path = os.getenv(file_env_name, "").strip()
    if path:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    return os.getenv(env_name, "").strip()


DB = os.getenv("GLOWSTR_COMMERCE_DB", "/data/commerce.sqlite3")
HOST = os.getenv("GLOWSTR_COMMERCE_HOST", "127.0.0.1")
PORT = int(os.getenv("GLOWSTR_COMMERCE_PORT", "8787"))
RPC = os.getenv("MONERO_WALLET_RPC", "http://127.0.0.1:18083/json_rpc")
RPC_USER = os.getenv("MONERO_RPC_USER", "")
RPC_PASS = read_secret("MONERO_RPC_PASS", "MONERO_RPC_PASS_FILE")
ACCOUNT = int(os.getenv("MONERO_ACCOUNT_INDEX", "0"))
CONFIRMATIONS = max(1, int(os.getenv("GLOWSTR_XMR_CONFIRMATIONS", "2")))
INVOICE_SECONDS = max(300, int(os.getenv("GLOWSTR_INVOICE_SECONDS", "1800")))
LATE_GRACE_SECONDS = max(0, int(os.getenv("GLOWSTR_LATE_PAYMENT_GRACE_SECONDS", "300")))
RECONCILE_SECONDS = max(5, int(os.getenv("GLOWSTR_RECONCILE_SECONDS", "20")))
PRICE_URL = os.getenv(
    "GLOWSTR_XMR_USD_URL",
    "https://api.kraken.com/0/public/Ticker?pair=XMRUSD",
).strip()
PRICE_OVERRIDE = os.getenv("GLOWSTR_XMR_USD_OVERRIDE", "").strip()
RELAY_USD_CENTS = max(1, int(os.getenv("GLOWSTR_RELAY_USD_CENTS", "1000")))
ORIGINS = {
    x.strip()
    for x in os.getenv(
        "GLOWSTR_ALLOWED_ORIGINS",
        os.getenv("GLOWSTR_ALLOWED_ORIGIN", "https://glowstr.com"),
    ).split(",")
    if x.strip()
}
ADMIN_TOKEN = read_secret(
    "GLOWSTR_COMMERCE_ADMIN_TOKEN", "GLOWSTR_COMMERCE_ADMIN_TOKEN_FILE"
)

FEATURES = {
    "relay_365d": {
        "usd_cents": RELAY_USD_CENTS,
        "seconds": YEAR_SECONDS,
        "label": "Glowstr relay - 1 year",
    }
}

_rate_lock = threading.Lock()
_rate_buckets = {}


def rate_limit(key, limit, window_seconds):
    now = int(time.time())
    bucket = now // window_seconds
    with _rate_lock:
        old_bucket, count = _rate_buckets.get(key, (bucket, 0))
        if old_bucket != bucket:
            old_bucket, count = bucket, 0
        count += 1
        _rate_buckets[key] = (old_bucket, count)
        return count <= limit


def db():
    os.makedirs(os.path.dirname(DB) or ".", exist_ok=True)
    c = sqlite3.connect(DB, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=10000")
    c.execute(
        """CREATE TABLE IF NOT EXISTS invoices(
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, pubkey TEXT NOT NULL,
        feature TEXT NOT NULL, target TEXT NOT NULL DEFAULT '',
        amount INTEGER NOT NULL, account_index INTEGER NOT NULL,
        address_index INTEGER NOT NULL, address TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        paid_at INTEGER, txid TEXT, confirmations INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'WAITING',
        usd_cents INTEGER NOT NULL DEFAULT 0,
        xmr_usd_micros INTEGER NOT NULL DEFAULT 0
        )"""
    )
    columns = {r["name"] for r in c.execute("PRAGMA table_info(invoices)")}
    if "usd_cents" not in columns:
        c.execute("ALTER TABLE invoices ADD COLUMN usd_cents INTEGER NOT NULL DEFAULT 0")
    if "xmr_usd_micros" not in columns:
        c.execute("ALTER TABLE invoices ADD COLUMN xmr_usd_micros INTEGER NOT NULL DEFAULT 0")

    c.execute(
        """CREATE TABLE IF NOT EXISTS entitlements(
        pubkey TEXT NOT NULL, feature TEXT NOT NULL, target TEXT NOT NULL DEFAULT '',
        valid_until INTEGER NOT NULL, invoice_id TEXT NOT NULL,
        PRIMARY KEY(pubkey,feature,target)
        )"""
    )
    c.execute(
        """CREATE TABLE IF NOT EXISTS reminders(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pubkey TEXT NOT NULL, feature TEXT NOT NULL, target TEXT NOT NULL DEFAULT '',
        valid_until INTEGER NOT NULL, created_at INTEGER NOT NULL,
        sent_at INTEGER, last_attempt_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        UNIQUE(pubkey,feature,target,valid_until)
        )"""
    )
    reminder_columns = {r["name"] for r in c.execute("PRAGMA table_info(reminders)")}
    if "last_attempt_at" not in reminder_columns:
        c.execute("ALTER TABLE reminders ADD COLUMN last_attempt_at INTEGER")
    if "attempts" not in reminder_columns:
        c.execute("ALTER TABLE reminders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
    if "last_error" not in reminder_columns:
        c.execute("ALTER TABLE reminders ADD COLUMN last_error TEXT NOT NULL DEFAULT ''")
    c.commit()
    return c


def rpc(method, params=None):
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": "glowstr", "method": method, "params": params or {}}
    ).encode()
    req = Request(RPC, data=payload, headers={"Content-Type": "application/json"})
    if RPC_USER:
        mgr = HTTPPasswordMgrWithDefaultRealm()
        mgr.add_password(None, RPC, RPC_USER, RPC_PASS)
        opener = build_opener(HTTPDigestAuthHandler(mgr))
    else:
        opener = build_opener()
    with opener.open(req, timeout=12) as r:
        out = json.load(r)
    if out.get("error"):
        raise RuntimeError(str(out["error"]))
    return out["result"]


def xmr_usd_price():
    if PRICE_OVERRIDE:
        price = Decimal(PRICE_OVERRIDE)
    else:
        req = Request(PRICE_URL, headers={"User-Agent": "GlowstrCommerce/0.2"})
        with urlopen(req, timeout=8) as r:
            payload = json.load(r)
        if payload.get("error"):
            raise RuntimeError("price oracle returned an error")
        result = payload.get("result") or {}
        if not result:
            raise RuntimeError("price oracle returned no market data")
        first = next(iter(result.values()))
        price = Decimal(str(first["c"][0]))
    if price <= 0:
        raise RuntimeError("invalid XMR/USD price")
    return price


def usd_cents_to_atomic(usd_cents, xmr_usd):
    usd = Decimal(usd_cents) / Decimal(100)
    atomic = (usd / xmr_usd * Decimal(ATOMIC)).to_integral_value(rounding=ROUND_UP)
    return max(1, int(atomic))


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def valid_pubkey(s):
    return (
        isinstance(s, str)
        and len(s) == 64
        and all(c in "0123456789abcdefABCDEF" for c in s)
    )


def invoice_uri(address, amount, label):
    whole, frac = divmod(amount, ATOMIC)
    amount_s = str(whole) + (("." + f"{frac:012d}".rstrip("0")) if frac else "")
    return "monero:" + address + "?" + urlencode(
        {"tx_amount": amount_s, "tx_description": label}
    )


def transfer_matches_invoice(tx, row):
    idx = tx.get("subaddr_index") or {}
    if idx.get("major") != row["account_index"] or idx.get("minor") != row["address_index"]:
        return False
    if tx.get("double_spend_seen"):
        return False
    ts = int(tx.get("timestamp") or 0)
    if ts and ts > row["expires_at"] + LATE_GRACE_SECONDS:
        return False
    return True


def refresh_invoice(c, row):
    if row["status"] == "PAID":
        return row
    if row["feature"] not in FEATURES:
        c.execute("UPDATE invoices SET status='EXPIRED' WHERE id=?", (row["id"],))
        c.commit()
        return c.execute("SELECT * FROM invoices WHERE id=?", (row["id"],)).fetchone()

    now = int(time.time())
    result = rpc(
        "get_transfers",
        {
            "in": True,
            "pool": True,
            "account_index": row["account_index"],
            "subaddr_indices": [row["address_index"]],
        },
    )
    candidates = (result.get("pool") or []) + (result.get("in") or [])
    candidates = [tx for tx in candidates if transfer_matches_invoice(tx, row)]

    seen = {}
    for tx in candidates:
        txid = str(tx.get("txid") or "")
        if not txid:
            continue
        prev = seen.get(txid)
        if prev is None or int(tx.get("confirmations", 0)) > int(prev.get("confirmations", 0)):
            seen[txid] = tx

    total_seen = sum(max(0, int(tx.get("amount", 0))) for tx in seen.values())
    confirmed = sum(
        max(0, int(tx.get("amount", 0)))
        for tx in seen.values()
        if int(tx.get("confirmations", 0)) >= CONFIRMATIONS
    )
    best_conf = max((int(tx.get("confirmations", 0)) for tx in seen.values()), default=0)
    txids = ",".join(list(seen.keys())[:8]) or None

    if confirmed >= row["amount"]:
        status = "PAID"
    elif total_seen >= row["amount"]:
        status = "CONFIRMING" if best_conf else "MEMPOOL"
    elif now > row["expires_at"] + LATE_GRACE_SECONDS:
        status = "EXPIRED"
    else:
        status = "WAITING"

    paid_at = now if status == "PAID" else None
    c.execute(
        """UPDATE invoices SET status=?,confirmations=?,txid=?,paid_at=COALESCE(paid_at,?)
           WHERE id=?""",
        (status, best_conf, txids, paid_at, row["id"]),
    )

    if status == "PAID":
        spec = FEATURES[row["feature"]]
        current = c.execute(
            """SELECT valid_until FROM entitlements
               WHERE pubkey=? AND feature=? AND target=?""",
            (row["pubkey"], row["feature"], row["target"]),
        ).fetchone()
        base = max(now, int(current["valid_until"]) if current else now)
        until = base + spec["seconds"]
        c.execute(
            """INSERT INTO entitlements(pubkey,feature,target,valid_until,invoice_id)
               VALUES(?,?,?,?,?)
               ON CONFLICT(pubkey,feature,target)
               DO UPDATE SET valid_until=excluded.valid_until,invoice_id=excluded.invoice_id""",
            (row["pubkey"], row["feature"], row["target"], until, row["id"]),
        )
    c.commit()
    return c.execute("SELECT * FROM invoices WHERE id=?", (row["id"],)).fetchone()


def reconcile_once():
    c = db()
    now = int(time.time())
    rows = c.execute(
        """SELECT * FROM invoices
           WHERE status IN ('WAITING','MEMPOOL','CONFIRMING')
              OR (status='EXPIRED' AND expires_at + ? > ?)""",
        (LATE_GRACE_SECONDS, now),
    ).fetchall()
    for row in rows:
        try:
            refresh_invoice(c, row)
        except Exception as exc:
            print(f"reconcile invoice {row['id']} failed: {exc}")

    window_end = now + REMINDER_SECONDS
    expiring = c.execute(
        """SELECT pubkey,feature,target,valid_until FROM entitlements
           WHERE feature='relay_365d' AND valid_until>? AND valid_until<=?""",
        (now, window_end),
    ).fetchall()
    for ent in expiring:
        c.execute(
            """INSERT OR IGNORE INTO reminders(pubkey,feature,target,valid_until,created_at)
               VALUES(?,?,?,?,?)""",
            (
                ent["pubkey"],
                ent["feature"],
                ent["target"],
                ent["valid_until"],
                now,
            ),
        )
    c.commit()
    c.close()


def reconciler():
    while True:
        try:
            reconcile_once()
        except Exception as exc:
            print(f"reconciler failed: {exc}")
        time.sleep(RECONCILE_SECONDS)


class H(BaseHTTPRequestHandler):
    server_version = "GlowstrCommerce/0.2"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def _headers(self, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "").strip()
        if origin and origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def out(self, obj, code=200):
        self._headers(code)
        self.wfile.write(json.dumps(obj, separators=(",", ":")).encode())

    def body(self):
        raw_len = int(self.headers.get("Content-Length", "0"))
        if raw_len < 0 or raw_len > 8192:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(raw_len) or b"{}")

    def admin(self):
        return bool(
            ADMIN_TOKEN
            and secrets.compare_digest(
                self.headers.get("Authorization", ""), "Bearer " + ADMIN_TOKEN
            )
        )

    def do_OPTIONS(self):
        self._headers(204)

    def do_POST(self):
        try:
            if self.path == "/v1/invoices":
                if not rate_limit("ip:" + self.client_address[0], 20, 3600):
                    return self.out({"error": "rate_limited"}, 429)
                p = self.body()
                pubkey = str(p.get("pubkey", "")).lower()
                feature = str(p.get("feature", ""))
                target = str(p.get("target", ""))[:160]
                if not valid_pubkey(pubkey):
                    return self.out({"error": "invalid_pubkey"}, 400)
                if not rate_limit("pub:" + pubkey, 8, 3600):
                    return self.out({"error": "rate_limited"}, 429)
                if feature not in FEATURES:
                    return self.out({"error": "unknown_feature", "features": FEATURES}, 400)

                spec = FEATURES[feature]
                price = xmr_usd_price()
                amount = usd_cents_to_atomic(spec["usd_cents"], price)
                inv = secrets.token_urlsafe(18)
                token = secrets.token_urlsafe(32)
                now = int(time.time())

                a = rpc(
                    "create_address",
                    {"account_index": ACCOUNT, "label": "glowstr:" + inv, "count": 1},
                )
                address = a.get("address") or (a.get("addresses") or [None])[0]
                idx = a.get("address_index")
                if idx is None:
                    idx = (a.get("address_indices") or [None])[0]
                if not address or idx is None:
                    raise RuntimeError("wallet RPC did not return subaddress")

                c = db()
                c.execute(
                    """INSERT INTO invoices(
                       id,token_hash,pubkey,feature,target,amount,account_index,
                       address_index,address,created_at,expires_at,usd_cents,xmr_usd_micros
                       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        inv,
                        token_hash(token),
                        pubkey,
                        feature,
                        target,
                        amount,
                        ACCOUNT,
                        int(idx),
                        address,
                        now,
                        now + INVOICE_SECONDS,
                        spec["usd_cents"],
                        int(price * Decimal(1_000_000)),
                    ),
                )
                c.commit()
                c.close()
                return self.out(
                    {
                        "id": inv,
                        "token": token,
                        "status": "WAITING",
                        "address": address,
                        "amount_atomic": amount,
                        "usd_cents": spec["usd_cents"],
                        "xmr_usd": str(price),
                        "uri": invoice_uri(address, amount, spec["label"]),
                        "expires_at": now + INVOICE_SECONDS,
                        "confirmations_required": CONFIRMATIONS,
                    }
                )

            if self.path.startswith("/v1/admin/reminders/") and self.path.endswith("/sent"):
                if not self.admin():
                    return self.out({"error": "unauthorized"}, 401)
                rid = self.path.split("/")[-2]
                now = int(time.time())
                c = db()
                cur = c.execute(
                    """UPDATE reminders
                       SET sent_at=?, last_attempt_at=?, attempts=attempts+1, last_error=''
                       WHERE id=? AND sent_at IS NULL""",
                    (now, now, rid),
                )
                c.commit()
                c.close()
                return self.out({"ok": cur.rowcount == 1})

            if self.path.startswith("/v1/admin/reminders/") and self.path.endswith("/failed"):
                if not self.admin():
                    return self.out({"error": "unauthorized"}, 401)
                rid = self.path.split("/")[-2]
                payload = self.body()
                err = str(payload.get("error", "delivery failed")).strip()[:240]
                now = int(time.time())
                c = db()
                cur = c.execute(
                    """UPDATE reminders
                       SET last_attempt_at=?, attempts=attempts+1, last_error=?
                       WHERE id=? AND sent_at IS NULL""",
                    (now, err, rid),
                )
                c.commit()
                c.close()
                return self.out({"ok": cur.rowcount == 1})

            return self.out({"error": "not_found"}, 404)
        except ValueError as exc:
            return self.out({"error": "bad_request", "detail": str(exc)}, 400)
        except Exception as exc:
            print("request failed:", exc)
            return self.out({"error": "server_error"}, 500)

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/health":
                return self.out({"ok": True})
            if path == "/ready":
                c = db()
                c.execute("SELECT 1").fetchone()
                c.close()
                rpc("get_version")
                return self.out({"ok": True})
            if path == "/v1/features":
                public = {
                    k: {
                        "usd_cents": v["usd_cents"],
                        "seconds": v["seconds"],
                        "label": v["label"],
                    }
                    for k, v in FEATURES.items()
                }
                return self.out(
                    {"features": public, "confirmations_required": CONFIRMATIONS}
                )
            if path.startswith("/v1/invoices/"):
                iid = path.split("/")[-1]
                auth = self.headers.get("Authorization", "")
                if not auth.startswith("Bearer "):
                    return self.out({"error": "unauthorized"}, 401)
                c = db()
                row = c.execute("SELECT * FROM invoices WHERE id=?", (iid,)).fetchone()
                if not row or not secrets.compare_digest(
                    row["token_hash"], token_hash(auth[7:])
                ):
                    c.close()
                    return self.out({"error": "unauthorized"}, 401)
                row = refresh_invoice(c, row)
                ent = c.execute(
                    """SELECT valid_until FROM entitlements
                       WHERE pubkey=? AND feature=? AND target=?""",
                    (row["pubkey"], row["feature"], row["target"]),
                ).fetchone()
                c.close()
                return self.out(
                    {
                        "id": row["id"],
                        "status": row["status"],
                        "amount_atomic": row["amount"],
                        "usd_cents": row["usd_cents"],
                        "address": row["address"],
                        "confirmations": row["confirmations"],
                        "confirmations_required": CONFIRMATIONS,
                        "expires_at": row["expires_at"],
                        "access_valid_until": int(ent["valid_until"]) if ent else None,
                    }
                )
            if path.startswith("/v1/admin/entitlements/"):
                if not self.admin():
                    return self.out({"error": "unauthorized"}, 401)
                pubkey = path.split("/")[-1].lower()
                if not valid_pubkey(pubkey):
                    return self.out({"error": "invalid_pubkey"}, 400)
                now = int(time.time())
                c = db()
                rows = c.execute(
                    """SELECT feature,target,valid_until,invoice_id
                       FROM entitlements WHERE pubkey=? AND valid_until>?""",
                    (pubkey, now),
                ).fetchall()
                c.close()
                return self.out(
                    {"pubkey": pubkey, "entitlements": [dict(x) for x in rows]}
                )
            if path == "/v1/admin/reminders":
                if not self.admin():
                    return self.out({"error": "unauthorized"}, 401)
                query = parse_qs(parsed.query)
                pending = query.get("status", ["pending"])[0] == "pending"
                c = db()
                sql = """SELECT id,pubkey,feature,target,valid_until,created_at,sent_at,
                                last_attempt_at,attempts,last_error
                         FROM reminders"""
                if pending:
                    sql += " WHERE sent_at IS NULL"
                sql += " ORDER BY created_at ASC LIMIT 500"
                rows = c.execute(sql).fetchall()
                c.close()
                return self.out({"reminders": [dict(x) for x in rows]})
            return self.out({"error": "not_found"}, 404)
        except Exception as exc:
            print("request failed:", exc)
            return self.out({"error": "server_error"}, 500)


if __name__ == "__main__":
    db().close()
    threading.Thread(target=reconciler, name="payment-reconciler", daemon=True).start()
    print(
        f"Glowstr Commerce listening on {HOST}:{PORT}; "
        f"wallet RPC={RPC}; confirmations={CONFIRMATIONS}"
    )
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
