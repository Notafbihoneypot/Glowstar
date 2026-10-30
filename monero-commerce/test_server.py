import hashlib
import importlib.util
import os
import re
import tempfile
import threading
import time
import unittest
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("server.py")
spec = importlib.util.spec_from_file_location("glowstr_commerce", MODULE_PATH)
commerce = importlib.util.module_from_spec(spec)
spec.loader.exec_module(commerce)


class CommerceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        commerce.DB = os.path.join(self.tmp.name, "commerce.sqlite3")
        commerce.CONFIRMATIONS = 2
        commerce.LATE_GRACE_SECONDS = 300
        commerce.FEATURES = {
            "relay_365d": {
                "usd_cents": 1000,
                "seconds": 365 * 86400,
                "label": "Glowstr relay - 1 year",
                "lifetime": False,
            },
            "relay_lifetime": {
                "usd_cents": 4000,
                "seconds": None,
                "label": "Glowstr relay - lifetime of service",
                "lifetime": True,
            },
        }

    def tearDown(self):
        self.tmp.cleanup()

    def invoice_row(self, amount=1000, expires_delta=1800, feature="relay_365d"):
        now = int(time.time())
        c = commerce.db()
        c.execute(
            """INSERT INTO invoices(
               id,token_hash,pubkey,feature,target,amount,account_index,
               address_index,address,created_at,expires_at,usd_cents,xmr_usd_micros
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                "inv1",
                "hash",
                "a" * 64,
                feature,
                "relay.glowstr.com",
                amount,
                0,
                7,
                "subaddress",
                now,
                now + expires_delta,
                1000,
                100_000_000,
            ),
        )
        c.commit()
        return c, c.execute("SELECT * FROM invoices WHERE id='inv1'").fetchone()


    def test_wallet_rpc_code_zero_requires_a_valid_result(self):
        """An empty RPC 'error' can coexist with a valid result; fail closed otherwise."""
        from unittest.mock import patch

        class Response:
            def __init__(self, payload):
                self.payload = payload

            def raise_for_status(self):
                pass

            def json(self):
                return self.payload

        class Session:
            def __init__(self, payload):
                self.payload = payload
                self.trust_env = True

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def post(self, *args, **kwargs):
                self.test_args = (args, kwargs)
                return Response(self.payload)

        result = {"in": [], "pool": []}
        cases = [
            ({"result": result}, True),
            ({"error": {"code": 0, "message": ""}, "result": result}, True),
            ({"error": {"code": 0, "message": ""}}, False),
            ({"error": {"code": 0, "message": ""}, "result": None}, False),
            ({"error": {"code": 0, "message": ""}, "result": []}, False),
            ({"error": {"code": -1, "message": "error"}, "result": result}, False),
            ({"result": None}, False),
            ({"error": {"code": 0, "message": "something failed"}, "result": result}, False),
        ]
        for payload, success in cases:
            with self.subTest(payload=payload):
                with patch.object(commerce.requests, "Session", return_value=Session(payload)):
                    if success:
                        self.assertEqual(commerce.rpc("get_transfers"), result)
                    else:
                        with self.assertRaises(commerce.WalletRPCError):
                            commerce.rpc("get_transfers")

    def test_wallet_rpc_error_does_not_change_unpaid_invoice(self):
        from unittest.mock import patch

        conn, row = self.invoice_row()
        try:
            with patch.object(commerce, "rpc", side_effect=commerce.WalletRPCError(
                    "get_transfers", "ambiguous empty error without valid result", 0)):
                with self.assertRaises(commerce.WalletRPCError):
                    commerce.refresh_invoice(conn, row)
            unchanged = conn.execute("SELECT status FROM invoices WHERE id='inv1'").fetchone()
            self.assertEqual(unchanged["status"], "WAITING")
            self.assertIsNone(conn.execute("SELECT * FROM entitlements").fetchone())
        finally:
            conn.close()

    def test_digest_authenticated_wallet_rpc_handshake(self):
        """Mirror Monero wallet RPC's HTTP Digest challenge and POST response."""
        realm, nonce = "monero-wallet-rpc", "test-nonce"
        username, password = "glowstr", "unit-test-password"

        class WalletRPCHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                header = self.headers.get("Authorization", "")
                fields = {}
                for key, quoted, plain in re.findall(
                    r'(\w+)=(?:"([^"]*)"|([^,\s]+))', header
                ):
                    fields[key] = quoted or plain
                ha1 = hashlib.md5(
                    f"{username}:{realm}:{password}".encode()
                ).hexdigest()
                ha2 = hashlib.md5(
                    f"POST:{fields.get('uri', '')}".encode()
                ).hexdigest()
                expected = hashlib.md5(
                    (f"{ha1}:{nonce}:{fields.get('nc', '')}:"
                     f"{fields.get('cnonce', '')}:auth:{ha2}").encode()
                ).hexdigest()
                if fields.get("response") != expected:
                    self.send_response(401)
                    self.send_header(
                        "WWW-Authenticate",
                        f'Digest realm="{realm}", nonce="{nonce}", '
                        'qop="auth", algorithm=MD5',
                    )
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    b'{"jsonrpc":"2.0","result":{"version":12345}}'
                )

        server = HTTPServer(("127.0.0.1", 0), WalletRPCHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        old = (commerce.RPC, commerce.RPC_USER, commerce.RPC_PASS)
        try:
            commerce.RPC = f"http://127.0.0.1:{server.server_port}/json_rpc"
            commerce.RPC_USER, commerce.RPC_PASS = username, password
            self.assertEqual(commerce.rpc("get_version"), {"version": 12345})
        finally:
            commerce.RPC, commerce.RPC_USER, commerce.RPC_PASS = old
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_client_ip_uses_caddy_header_only_on_loopback(self):
        self.assertEqual(commerce.client_ip("127.0.0.1", "203.0.113.21"), "203.0.113.21")
        self.assertEqual(commerce.client_ip("::1", "203.0.113.23"), "203.0.113.23")
        self.assertEqual(commerce.client_ip("198.51.100.15", "203.0.113.21"), "198.51.100.15")
        self.assertEqual(commerce.client_ip("127.0.0.1", "not-an-ip"), "127.0.0.1")
        self.assertEqual(commerce.client_ip("127.0.0.1", "192.0.2.3, 203.0.113.22"), "203.0.113.22")

    def test_usd_conversion_rounds_up(self):
        self.assertEqual(
            commerce.usd_cents_to_atomic(1000, Decimal("100")),
            100_000_000_000,
        )

    def test_verification_status_needs_recent_successful_scan(self):
        c, row = self.invoice_row()
        try:
            now = int(time.time())
            self.assertFalse(commerce.verification_healthy(row, now))
            c.execute(
                "UPDATE invoices SET last_checked_at=? WHERE id='inv1'",
                (now,),
            )
            current = c.execute("SELECT * FROM invoices WHERE id='inv1'").fetchone()
            self.assertTrue(commerce.verification_healthy(current, now))
            self.assertFalse(commerce.verification_healthy(
                current, now + max(3 * commerce.RECONCILE_SECONDS, 90) + 1
            ))
            c.execute("UPDATE invoices SET status='PAID' WHERE id='inv1'")
            paid = c.execute("SELECT * FROM invoices WHERE id='inv1'").fetchone()
            self.assertTrue(commerce.verification_healthy(
                paid, now + 10_000
            ))
        finally:
            c.close()

    def test_stats_require_admin_and_return_only_aggregates(self):
        """Operator metrics must not expose wallet or Nostr identity fields."""
        import json
        from unittest.mock import patch
        from urllib.error import HTTPError
        from urllib.request import Request, urlopen

        c, row = self.invoice_row()
        now = int(time.time())
        c.execute(
            "UPDATE invoices SET status='PAID', usd_cents=1000 WHERE id='inv1'"
        )
        c.execute(
            """INSERT INTO entitlements(pubkey,feature,target,valid_until,invoice_id)
               VALUES(?,?,?,?,?)""",
            ("a" * 64, "relay_365d", commerce.RELAY_TARGET, now + 86400, "inv1"),
        )
        c.execute("UPDATE invoices SET target=? WHERE id='inv1'",
                  (commerce.RELAY_TARGET,))
        c.commit()
        c.close()

        server = HTTPServer(("127.0.0.1", 0), commerce.H)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}/v1/admin/stats"
        try:
            with patch.object(commerce, "ADMIN_TOKEN", "temporary-test-admin-token"):
                with self.assertRaises(HTTPError) as exc:
                    urlopen(url, timeout=5)
                self.assertEqual(exc.exception.code, 401)
                req = Request(url, headers={
                    "Authorization": "Bearer temporary-test-admin-token"
                })
                with urlopen(req, timeout=5) as response:
                    obj = json.load(response)
                self.assertEqual(obj["paid_invoices"], 1)
                self.assertEqual(obj["annual_payments"], 1)
                self.assertEqual(obj["active_paid_pubkeys"], 1)
                self.assertEqual(obj["gross_usd_cents_at_invoice"], 1000)
                for secret_key in ("pubkey", "address", "txid", "token", "invoice_id"):
                    self.assertNotIn(secret_key, str(obj))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_invoice_poll_does_not_call_wallet_rpc(self):
        """A known invoice bearer can only read cached status, not force RPC scans."""
        import json
        from unittest.mock import patch
        from urllib.request import Request, urlopen

        c, row = self.invoice_row()
        token = "unit-test-invoice-token"
        c.execute("UPDATE invoices SET token_hash=? WHERE id='inv1'",
                  (commerce.token_hash(token),))
        c.commit()
        c.close()

        server = HTTPServer(("127.0.0.1", 0), commerce.H)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(commerce, "rpc", side_effect=AssertionError("RPC not allowed")):
                request = Request(
                    f"http://127.0.0.1:{server.server_port}/v1/invoices/inv1",
                    headers={"Authorization": "Bearer " + token},
                )
                with urlopen(request, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    body = json.load(response)
            self.assertEqual(body["status"], "WAITING")
            self.assertIs(body["verification_healthy"], False)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_confirmed_only_transfer_lookup_avoids_pool_refresh(self):
        """Default payment monitoring must not invoke broken daemon mempool RPC."""
        from unittest.mock import patch

        c, row = self.invoice_row()
        called = []
        def fake_rpc(method, params=None):
            called.append((method, params))
            return {"in": [], "pool": []}

        try:
            with patch.object(commerce, "CHECK_MEMPOOL", False):
                with patch.object(commerce, "rpc", side_effect=fake_rpc):
                    latest = commerce.refresh_invoice(c, row)
            self.assertEqual(latest["status"], "WAITING")
            self.assertEqual(len(called), 1)
            self.assertEqual(called[0][0], "get_transfers")
            self.assertTrue(called[0][1]["in"])
            self.assertIs(called[0][1]["pool"], False)
        finally:
            c.close()

    def test_mempool_scan_is_explicit_opt_in(self):
        """Mempool access is optional and does not affect the confirmation rule."""
        from unittest.mock import patch

        c, row = self.invoice_row()
        called = []
        def fake_rpc(method, params=None):
            called.append(params)
            return {"in": [], "pool": []}

        try:
            with patch.object(commerce, "CHECK_MEMPOOL", True):
                with patch.object(commerce, "rpc", side_effect=fake_rpc):
                    latest = commerce.refresh_invoice(c, row)
            self.assertEqual(latest["status"], "WAITING")
            self.assertIs(called[0]["pool"], True)
        finally:
            c.close()

    def test_one_confirmation_does_not_grant_access(self):
        c, row = self.invoice_row()
        old_rpc = commerce.rpc
        commerce.rpc = lambda method, params=None: {
            "in": [{
                "subaddr_index": {"major": 0, "minor": 7},
                "amount": 1000,
                "confirmations": 1,
                "txid": "tx1",
                "timestamp": int(time.time()),
                "double_spend_seen": False,
            }],
            "pool": [],
        }
        try:
            row = commerce.refresh_invoice(c, row)
            self.assertEqual(row["status"], "CONFIRMING")
            ent = c.execute("SELECT * FROM entitlements").fetchone()
            self.assertIsNone(ent)
        finally:
            commerce.rpc = old_rpc
            c.close()

    def test_two_confirmations_grant_one_year(self):
        c, row = self.invoice_row()
        old_rpc = commerce.rpc
        commerce.rpc = lambda method, params=None: {
            "in": [{
                "subaddr_index": {"major": 0, "minor": 7},
                "amount": 1000,
                "confirmations": 2,
                "txid": "tx1",
                "timestamp": int(time.time()),
                "double_spend_seen": False,
            }],
            "pool": [],
        }
        before = int(time.time())
        try:
            row = commerce.refresh_invoice(c, row)
            self.assertEqual(row["status"], "PAID")
            ent = c.execute("SELECT * FROM entitlements").fetchone()
            self.assertIsNotNone(ent)
            self.assertGreaterEqual(ent["valid_until"], before + 365 * 86400)
        finally:
            commerce.rpc = old_rpc
            c.close()

    def test_renewal_stacks_from_existing_expiry(self):
        c, row = self.invoice_row()
        existing = int(time.time()) + 20 * 86400
        c.execute(
            """INSERT INTO entitlements(pubkey,feature,target,valid_until,invoice_id)
               VALUES(?,?,?,?,?)""",
            ("a" * 64, "relay_365d", "relay.glowstr.com", existing, "old"),
        )
        c.execute(
            """INSERT INTO reminders(pubkey,feature,target,valid_until,created_at)
               VALUES(?,?,?,?,?)""",
            ("a" * 64, "relay_365d", "relay.glowstr.com", existing, int(time.time())),
        )
        c.commit()
        old_rpc = commerce.rpc
        commerce.rpc = lambda method, params=None: {
            "in": [{
                "subaddr_index": {"major": 0, "minor": 7},
                "amount": 1000,
                "confirmations": 2,
                "txid": "tx2",
                "timestamp": int(time.time()),
                "double_spend_seen": False,
            }],
            "pool": [],
        }
        try:
            commerce.refresh_invoice(c, row)
            ent = c.execute("SELECT * FROM entitlements").fetchone()
            self.assertEqual(ent["valid_until"], existing + 365 * 86400)
            reminder = c.execute("SELECT * FROM reminders").fetchone()
            self.assertIsNotNone(reminder["cancelled_at"])
            self.assertIn("superseded", reminder["last_error"])
        finally:
            commerce.rpc = old_rpc
            c.close()

    def test_double_spend_is_not_counted(self):
        c, row = self.invoice_row()
        old_rpc = commerce.rpc
        commerce.rpc = lambda method, params=None: {
            "in": [{
                "subaddr_index": {"major": 0, "minor": 7},
                "amount": 1000,
                "confirmations": 10,
                "txid": "bad",
                "timestamp": int(time.time()),
                "double_spend_seen": True,
            }],
            "pool": [],
        }
        try:
            row = commerce.refresh_invoice(c, row)
            self.assertEqual(row["status"], "WAITING")
        finally:
            commerce.rpc = old_rpc
            c.close()

    def test_reminder_queued_within_30_days(self):
        c = commerce.db()
        expiry = int(time.time()) + 29 * 86400
        c.execute(
            """INSERT INTO entitlements(pubkey,feature,target,valid_until,invoice_id)
               VALUES(?,?,?,?,?)""",
            ("b" * 64, "relay_365d", "relay.glowstr.com", expiry, "paid"),
        )
        c.commit()
        c.close()

        old_rpc = commerce.rpc
        commerce.rpc = lambda method, params=None: {}
        try:
            commerce.reconcile_once()
            c = commerce.db()
            reminder = c.execute("SELECT * FROM reminders").fetchone()
            self.assertIsNotNone(reminder)
            self.assertEqual(reminder["valid_until"], expiry)
            c.close()
        finally:
            commerce.rpc = old_rpc


    def test_annual_expiry_and_lifetime_marker(self):
        now = 1_800_000_000
        annual = commerce.FEATURES["relay_365d"]
        lifetime = commerce.FEATURES["relay_lifetime"]
        self.assertEqual(commerce.entitlement_valid_until(now, 0, annual),
                         now + 365 * 86400)
        self.assertEqual(commerce.entitlement_valid_until(now, now + 500, annual),
                         now + 500 + 365 * 86400)
        self.assertEqual(commerce.entitlement_valid_until(now, 0, lifetime),
                         commerce.LIFETIME_UNTIL)

    def test_lifetime_payment_requires_two_confirms_and_preserves_annual(self):
        c, row = self.invoice_row(amount=4000, feature="relay_lifetime")
        existing = int(time.time()) + 50 * 86400
        c.execute(
            """INSERT INTO entitlements(pubkey,feature,target,valid_until,invoice_id)
               VALUES(?,?,?,?,?)""",
            ("a" * 64, "relay_365d", "relay.glowstr.com", existing, "annual"),
        )
        c.execute(
            """INSERT INTO reminders(pubkey,feature,target,valid_until,created_at)
               VALUES(?,?,?,?,?)""",
            ("a" * 64, "relay_365d", "relay.glowstr.com", existing, int(time.time())),
        )
        c.commit()
        conf = {"value": 1}
        old_rpc = commerce.rpc
        commerce.rpc = lambda method, params=None: {
            "in": [{
                "subaddr_index": {"major": 0, "minor": 7},
                "amount": 4000,
                "confirmations": conf["value"],
                "txid": "lifetime-tx",
                "timestamp": int(time.time()),
                "double_spend_seen": False,
            }],
            "pool": [],
        }
        try:
            first = commerce.refresh_invoice(c, row)
            self.assertEqual(first["status"], "CONFIRMING")
            self.assertIsNone(c.execute(
                "SELECT valid_until FROM entitlements WHERE feature='relay_lifetime'"
            ).fetchone())
            conf["value"] = 2
            paid = commerce.refresh_invoice(c, first)
            self.assertEqual(paid["status"], "PAID")
            self.assertEqual(c.execute(
                "SELECT valid_until FROM entitlements WHERE feature='relay_lifetime'"
            ).fetchone()["valid_until"], commerce.LIFETIME_UNTIL)
            self.assertEqual(c.execute(
                "SELECT valid_until FROM entitlements WHERE feature='relay_365d'"
            ).fetchone()["valid_until"], existing)
            reminder = c.execute("SELECT cancelled_at,last_error FROM reminders").fetchone()
            self.assertIsNotNone(reminder["cancelled_at"])
            self.assertIn("lifetime", reminder["last_error"])
        finally:
            commerce.rpc = old_rpc
            c.close()

    def test_lifetime_does_not_generate_expiry_reminder(self):
        c = commerce.db()
        c.execute(
            """INSERT INTO entitlements(pubkey,feature,target,valid_until,invoice_id)
               VALUES(?,?,?,?,?)""",
            ("b" * 64, "relay_lifetime", "relay.glowstr.com",
             commerce.LIFETIME_UNTIL, "lifetime"),
        )
        c.commit()
        c.close()
        old_rpc = commerce.rpc
        commerce.rpc = lambda method, params=None: {}
        try:
            commerce.reconcile_once()
            c = commerce.db()
            self.assertIsNone(c.execute("SELECT * FROM reminders").fetchone())
            c.close()
        finally:
            commerce.rpc = old_rpc



    def test_annual_reminder_suppressed_when_lifetime_exists(self):
        c = commerce.db()
        expiry = int(time.time()) + 10 * 86400
        for feature, until in [
            ("relay_365d", expiry), ("relay_lifetime", commerce.LIFETIME_UNTIL)
        ]:
            c.execute(
                """INSERT INTO entitlements(pubkey,feature,target,valid_until,invoice_id)
                   VALUES(?,?,?,?,?)""",
                ("c" * 64, feature, "relay.glowstr.com", until, feature),
            )
        c.commit()
        c.close()
        old_rpc = commerce.rpc
        commerce.rpc = lambda method, params=None: {}
        try:
            commerce.reconcile_once()
            c = commerce.db()
            self.assertIsNone(c.execute("SELECT * FROM reminders").fetchone())
            c.close()
        finally:
            commerce.rpc = old_rpc



if __name__ == "__main__":
    unittest.main()
