import importlib.util
import os
import tempfile
import time
import unittest
from decimal import Decimal
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
            }
        }

    def tearDown(self):
        self.tmp.cleanup()

    def invoice_row(self, amount=1000, expires_delta=1800):
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
                "relay_365d",
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

    def test_usd_conversion_rounds_up(self):
        self.assertEqual(
            commerce.usd_cents_to_atomic(1000, Decimal("100")),
            100_000_000_000,
        )

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


if __name__ == "__main__":
    unittest.main()
