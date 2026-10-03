#!/usr/bin/env python3
"""Concurrency, restart and rollback tests with a disposable DB/fake wallet RPC."""
import importlib.util
import sqlite3
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

spec = importlib.util.spec_from_file_location('commerce', Path(__file__).resolve().parents[1] / 'monero-commerce/server.py')
commerce = importlib.util.module_from_spec(spec)
spec.loader.exec_module(commerce)

class Credits(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='glowstr-credit-test-')
        commerce.DB = str(Path(self.temp.name) / 'invoices.db')
        self.now = int(time.time())
        self.amount = commerce.FEATURES['relay_30d']['amount']
        self.seconds = commerce.FEATURES['relay_30d']['seconds']
        self.pubkey = '3' * 64
        self.create_invoice('first', 1)
        commerce.rpc = self.rpc
    def tearDown(self):
        self.temp.cleanup()
    def create_invoice(self, ident, index):
        with commerce.db() as c:
            c.execute('INSERT INTO invoices(id,token_hash,pubkey,feature,target,amount,account_index,address_index,address,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                      (ident,'hash',self.pubkey,'relay_30d','',self.amount,0,index,'fake-address',self.now,self.now+1800))
    def rpc(self, method, params):
        self.assertEqual(method,'get_transfers')
        return {'in':[{'subaddr_index':{'major':0,'minor':params['subaddr_indices'][0]},'amount':self.amount,'confirmations':commerce.CONFIRMATIONS,'txid':'fake-transaction'}]}
    def poll(self, ident='first'):
        c = commerce.db()
        try:
            row = c.execute('SELECT * FROM invoices WHERE id=?',(ident,)).fetchone()
            return commerce.refresh_invoice(c,row)['status']
        finally:
            c.close()
    def expiry(self):
        with commerce.db() as c:
            return c.execute('SELECT valid_until FROM entitlements WHERE pubkey=?',(self.pubkey,)).fetchone()[0]
    def test_simultaneous_and_repeated_polls_credit_once(self):
        barrier = threading.Barrier(4)
        def concurrent_rpc(method, params):
            result = self.rpc(method,params)
            barrier.wait(timeout=10)
            return result
        commerce.rpc = concurrent_rpc
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(list(pool.map(lambda _:self.poll(),range(4))),['PAID']*4)
        expiry = self.expiry()
        self.assertGreaterEqual(expiry,self.now+self.seconds)
        self.assertLess(expiry,self.now+self.seconds+10)
        # A process restart/repeat returns PAID without querying the wallet again.
        commerce.rpc = lambda *_: (_ for _ in ()).throw(AssertionError('Repeated RPC'))
        self.assertEqual(self.poll(),'PAID')
        self.assertEqual(self.expiry(),expiry)
    def test_distinct_invoices_extend_instead_of_overwriting(self):
        self.create_invoice('second',2)
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(list(pool.map(self.poll,['first','second'])),['PAID']*2)
        self.assertGreaterEqual(self.expiry(),self.now+2*self.seconds)
        self.assertLess(self.expiry(),self.now+2*self.seconds+10)
    def test_entitlement_failure_rolls_back_paid_transition(self):
        with commerce.db() as c:
            c.execute("CREATE TRIGGER reject_credit BEFORE INSERT ON entitlements BEGIN SELECT RAISE(ABORT, 'test rollback'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.poll()
        with commerce.db() as c:
            self.assertEqual(c.execute('SELECT status FROM invoices').fetchone()[0],'WAITING')
            self.assertEqual(c.execute('SELECT COUNT(*) FROM entitlements').fetchone()[0],0)
            c.execute('DROP TRIGGER reject_credit')
        self.assertEqual(self.poll(),'PAID')
        self.assertLess(self.expiry(),self.now+self.seconds+10)
    def test_stale_unpaid_poll_cannot_downgrade_paid_invoice(self):
        with commerce.db() as c:
            stale = c.execute('SELECT * FROM invoices').fetchone()
        self.assertEqual(self.poll(),'PAID')
        expiry = self.expiry()
        commerce.rpc = lambda *_:{}
        with commerce.db() as c:
            self.assertEqual(commerce.refresh_invoice(c,stale)['status'],'PAID')
        self.assertEqual(self.expiry(),expiry)

if __name__ == '__main__':
    unittest.main()
