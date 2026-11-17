#!/usr/bin/env python3
import base64, hashlib, html.parser, re, subprocess, sys, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SITE=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'glowstr-v5.5-relay-frostr-media.html'

class AuditParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.ids=[]; self.inline=[]; self.external=[]; self.scripts=[]; self._script=False; self._buf=[]; self.csp=''
    def handle_starttag(self, tag, attrs):
        d=dict(attrs)
        if 'id' in d: self.ids.append(d['id'])
        for k,v in attrs:
            if k.lower().startswith('on'): self.inline.append((tag,k,v))
        if tag=='script':
            if d.get('src'): self.external.append(d['src'])
            else: self._script=True; self._buf=[]
        if tag=='meta' and d.get('http-equiv','').lower()=='content-security-policy': self.csp=d.get('content','')
    def handle_endtag(self, tag):
        if tag=='script' and self._script:
            self.scripts.append(''.join(self._buf)); self._script=False; self._buf=[]
    def handle_data(self, data):
        if self._script: self._buf.append(data)


def ok(name, cond, detail=''):
    if not cond: raise AssertionError(f'{name}: FAIL {detail}')
    print(f'{name}: PASS'+(f' ({detail})' if detail else ''))

text=SITE.read_text()
p=AuditParser(); p.feed(text)

dup=sorted({x for x in p.ids if p.ids.count(x)>1})
ok('HTML duplicate IDs', not dup, repr(dup))
ok('Inline executable handlers', not p.inline, str(len(p.inline)))
ok('External script tags', not p.external, repr(p.external))
ok('Inline main script count', len(p.scripts)==1, str(len(p.scripts)))
hash_b64=base64.b64encode(hashlib.sha256(p.scripts[0].encode()).digest()).decode()
ok('CSP main-script SHA-256', f"'sha256-{hash_b64}'" in p.csp, hash_b64)
ok('CSP script-src-attr none', "script-src-attr 'none'" in p.csp)
ok('CSP unsafe-eval absent', 'unsafe-eval' not in p.csp)
connect_src=re.search(r'connect-src ([^;]+)',p.csp)
media_src=re.search(r'media-src ([^;]+)',p.csp)
local_ws={'ws://127.0.0.1:8787','ws://localhost:8787'}
ok('CSP cleartext limited to local Reticulum', bool(connect_src and media_src) and
   'http:' not in connect_src.group(1) and 'http:' not in media_src.group(1) and
   all(not token.startswith('ws:') or token in local_ws for token in connect_src.group(1).split()))
ok('Bluetooth helper UI present', 'BLUETOOTH DIRECT // PHONE ↔ PHONE' in text)
ok('Bluetooth native bridge only', 'glowstr-native://mesh' in text and '127.0.0.1:8788' not in text)

# JS parse
with tempfile.NamedTemporaryFile(mode='w',suffix='.js') as js:
    js.write(p.scripts[0]); js.flush()
    r=subprocess.run(['node','--check',js.name],capture_output=True,text=True)
ok('Client JavaScript syntax', r.returncode==0, r.stderr[:200])

print('ALL CLIENT ARTIFACT CHECKS PASSED')
