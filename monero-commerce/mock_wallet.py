#!/usr/bin/env python3
"""Staging-only mock for monero-wallet-rpc.

It creates fake subaddresses and automatically advances incoming payments:
MEMPOOL -> 1 confirmation -> 2 confirmations.
Never use this service in production.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.getenv("MOCK_WALLET_HOST", "127.0.0.1")
PORT = int(os.getenv("MOCK_WALLET_PORT", "18083"))
DB = os.getenv("MOCK_WALLET_DB", "/data/mock-wallet.sqlite3")
CONF1_SECONDS = max(1, int(os.getenv("MOCK_WALLET_CONF1_SECONDS", "8")))
CONF2_SECONDS = max(CONF1_SECONDS + 1, int(os.getenv("MOCK_WALLET_CONF2_SECONDS", "18")))
AMOUNT = max(1, int(os.getenv("MOCK_WALLET_AMOUNT_ATOMIC", str(10 * 10**12))))


def db():
    os.makedirs(os.path.dirname(DB) or ".", exist_ok=True)
    c = sqlite3.connect(DB, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute(
        """CREATE TABLE IF NOT EXISTS addresses(
        idx INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
        )"""
    )
    c.commit()
    return c


def fake_address(idx: int) -> str:
    # Looks address-like but is deliberately not a valid Monero address.
    digest = hashlib.sha256(f"glowstr-staging-{idx}".encode()).hexdigest()
    body = (digest * 3)[:94]
    return "8" + body


def tx_for(row):
    age = max(0, int(time.time()) - int(row["created_at"]))
    txid = hashlib.sha256(("tx:" + row["address"]).encode()).hexdigest()
    common = {
        "txid": txid,
        "amount": AMOUNT,
        "timestamp": int(row["created_at"]),
        "double_spend_seen": False,
        "subaddr_index": {"major": 0, "minor": int(row["idx"])},
    }
    if age < CONF1_SECONDS:
        return "pool", {**common, "confirmations": 0}
    if age < CONF2_SECONDS:
        return "in", {**common, "confirmations": 1}
    return "in", {**common, "confirmations": 2}


class H(BaseHTTPRequestHandler):
    server_version = "GlowstrMockWallet/0.1"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def out(self, obj, code=200):
        raw = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            return self.out({"ok": True, "staging_only": True})
        return self.out({"error": "not_found"}, 404)

    def do_POST(self):
        if self.path != "/json_rpc":
            return self.out({"error": "not_found"}, 404)
        try:
            length = min(65536, int(self.headers.get("Content-Length", "0")))
            req = json.loads(self.rfile.read(length) or b"{}")
            method = str(req.get("method", ""))
            params = req.get("params") or {}
            rid = req.get("id", "glowstr")

            if method == "get_version":
                result = {"version": 999999, "release": False, "staging_mock": True}
            elif method == "create_address":
                c = db()
                now = int(time.time())
                cur = c.execute("INSERT INTO addresses(address,created_at) VALUES('',?)", (now,))
                idx = int(cur.lastrowid)
                address = fake_address(idx)
                c.execute("UPDATE addresses SET address=? WHERE idx=?", (address, idx))
                c.commit()
                c.close()
                result = {"address": address, "address_index": idx}
            elif method == "get_transfers":
                wanted = params.get("subaddr_indices") or []
                c = db()
                if wanted:
                    marks = ",".join("?" for _ in wanted)
                    rows = c.execute(f"SELECT * FROM addresses WHERE idx IN ({marks})", [int(x) for x in wanted]).fetchall()
                else:
                    rows = c.execute("SELECT * FROM addresses").fetchall()
                c.close()
                result = {"pool": [], "in": []}
                for row in rows:
                    bucket, tx = tx_for(row)
                    result[bucket].append(tx)
            else:
                return self.out({
                    "jsonrpc": "2.0",
                    "id": rid,
                    "error": {"code": -32601, "message": "method not found in staging mock"},
                })

            return self.out({"jsonrpc": "2.0", "id": rid, "result": result})
        except Exception as exc:
            print("mock wallet request failed:", exc)
            return self.out({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32603, "message": "mock wallet internal error"},
            }, 500)


if __name__ == "__main__":
    db().close()
    print(
        f"Glowstr staging mock wallet on {HOST}:{PORT}; "
        f"1 conf after {CONF1_SECONDS}s; 2 conf after {CONF2_SECONDS}s"
    )
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
