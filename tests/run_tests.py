#!/usr/bin/env python3
import base64, hashlib, html.parser, json, re, subprocess, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SITE=ROOT/'glowstr-v5.3-bluetooth-direct.html'
JAVA=ROOT/'android-helper/app/src/main/java/org/glowstr/meshbridge'
MANIFEST=ROOT/'android-helper/app/src/main/AndroidManifest.xml'

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
ok('CSP loopback HTTP only', 'http://127.0.0.1:8788' in p.csp and not re.search(r'connect-src[^;]*(?:^|\s)http:(?:\s|;)',p.csp))
ok('Bluetooth helper UI present', 'BLUETOOTH DIRECT // PHONE ↔ PHONE' in text)
ok('Loopback address-space hint', "targetAddressSpace:'loopback'" in text)
ok('Token session-only', "sessionStorage.setItem('glowstr_bluetooth_token'" in text and "localStorage.setItem('glowstr_bluetooth_token'" not in text)
ok('Mesh imports verified events', "acceptVerifiedRelayEvent(row.event,'mesh://bluetooth/" in text)
ok('No automatic Bluetooth helper connect', not re.search(r'(?:DOMContentLoaded|glowstrMeshInit)[\s\S]{0,500}glowstrConnectBluetoothDirect\(\)', text))

# JS parse
js=ROOT/'tests/main-v53.js'; js.write_text(p.scripts[0])
r=subprocess.run(['node','--check',str(js)],capture_output=True,text=True)
ok('Client JavaScript syntax', r.returncode==0, r.stderr[:200])

manifest=MANIFEST.read_text()
alljava='\n'.join(x.read_text() for x in JAVA.glob('*.java'))
btm=(JAVA/'BluetoothMeshManager.java').read_text(); http=(JAVA/'LocalHttpServer.java').read_text(); proto=(JAVA/'Protocol.java').read_text(); svc=(JAVA/'MeshService.java').read_text(); gradle=(ROOT/'android-helper/app/build.gradle').read_text(); bridge=(JAVA/'AndroidBridge.java').read_text(); qrscan=(JAVA/'QrScanActivity.java').read_text(); mainactivity=(JAVA/'MainActivity.java').read_text()
ok('Android neverForLocation', 'android:usesPermissionFlags="neverForLocation"' in manifest)
ok('Android modern Bluetooth permissions', all(x in manifest for x in ['BLUETOOTH_SCAN','BLUETOOTH_ADVERTISE','BLUETOOTH_CONNECT']))
ok('No app-wide cleartext opt-in', 'usesCleartextTraffic="true"' not in manifest)
ok('Connected-device FGS manifest', 'FOREGROUND_SERVICE_CONNECTED_DEVICE' in manifest and 'foregroundServiceType="connectedDevice"' in manifest)
ok('Connected-device FGS runtime type', 'FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE' in svc)
ok('Secure L2CAP server', 'listenUsingL2capChannel()' in btm and 'listenUsingInsecureL2capChannel' not in btm)
ok('Secure L2CAP client', 'createL2capChannel(remotePsm)' in btm and 'createInsecureL2capChannel' not in btm)
ok('Loopback-only HTTP bind', 'InetAddress.getByName("127.0.0.1")' in http)
ok('Pairing token required', 'pairing token required' in http and 'MessageDigest.isEqual' in http)
ok('Public kind-1 only helper', 'optInt("kind", -1) != 1' in proto)
ok('Helper NIP-01 ID validation', 'NostrCrypto.eventId' in proto and 'event id does not match NIP-01 serialization' in proto)
ok('Helper BIP-340 validation', 'NostrCrypto.verifySchnorr' in proto and 'event Schnorr signature invalid' in proto)
ok('Bluetooth event ACK protocol', 'static JSONObject ack(String eventId)' in proto and '"ack".equals(type)' in btm and 'recordAck(eventId, remoteNode)' in btm)
ok('Bluetooth delivery status endpoint', '/v1/delivery' in svc and '/v1/delivery' in http and 'deliverySnapshot' in btm)
ok('Android Bluetooth API direct-only', 'int hops = 1;' in svc and 'int hops = 1;' in http and '.put("direct_only", true)' in svc)
ok('Native Amber offline mesh signing', 'glowstrAmberSignForMesh' in gradle and "__glowstrStartAmberPoll('mesh')" in gradle and "hops:1" in gradle)
ok('Android QR camera permission', 'android.permission.CAMERA' in manifest and '.QrScanActivity' in manifest)
ok('FOSS ZXing QR core dependency', "com.google.zxing:core:3.5.3" in gradle)
ok('JourneyApps embedded scanner dependency', "com.journeyapps:zxing-android-embedded:4.3.0" in gradle)
ok('Native QR bridge methods', all(x in bridge for x in ['startNostrQrScanner','pollNostrQrResult','makeNostrQrDataUrl']))
ok('JourneyApps QR scanner proxy', all(x in qrscan for x in ['IntentIntegrator', 'IntentResult', 'setDesiredBarcodeFormats', 'setBeepEnabled(false)', 'parseActivityResult']))
ok('Custom Camera2 QR pipeline removed', all(x not in qrscan for x in ['CameraManager','ImageReader','PlanarYUVLuminanceSource','DirectByteBuffer','decodeExecutor']))
ok('Crisp vector QR rendering', all(x in bridge for x in ['image/svg+xml;base64', 'shape-rendering=\\\"crispEdges\\\"', 'EncodeHintType.MARGIN, 4', 'moduleScale = 8']))
ok('Low-density uppercase QR payload', "('NOSTR:' + npub).toUpperCase()" in gradle and "width:auto;max-width:90vw" in gradle)
ok('QR UI and npub validation injected', all(x in gradle for x in ['nostr-show-my-qr-btn','nostr-qr-scan-btn','glowstrHexPubkeyToNpub','glowstrParsePubkeyQr','FOLLOW SCANNED PUBKEY']))
ok('Feed noise filter controls', all(x in text for x in ['feed-filter-bar','data-feed-noise="quiet"','data-feed-noise="balanced"','data-feed-noise="all"','feed-muted-clear']))
ok('Following uses author-scoped relay filters', all(x in text for x in ['function glowstrBuildCoreFilters()', 'authors:chunk', "state.feedMode === 'following'", 'glowstrRefreshCoreSubscriptions']))
ok('Feed relay routing matches selected mode', all(x in text for x in ['function glowstrFeedRelayTargets()', "state.feedMode === 'tor'", "state.feedMode === 'relay'", "state.feedMode === 'mesh'", 'targets.has(url)']))
ok('Global feed is explicit opt-in', "Auto-switch to global if following feed is still empty" not in text and "setFeedMode('global');\n    }\n  }, 3000);" not in text)
ok('Persistent login checks local storage on restart', 'function glowstrGetSavedPublicStateRaw()' in text and 'localStorage.getItem(GLOWSTR_PUBLIC_STATE_KEY)' in text and 'const stored = glowstrGetSavedPublicStateRaw();' in text)
ok('Persistent login fast-path accepts local state', 'localStorage survives an Android/WebView process restart' in text and 'saved?.publicKey' in text)
ok('Stay-logged-in controls stay synchronized', 'function glowstrSyncPersistUi()' in text and all(x in text for x in ["login-persist-checkbox","loggedin-persist-checkbox","glowstrSyncPersistUi();"]))
ok('Android native remembered-session bridge', all(x in bridge for x in ['saveRememberedPublicState','loadRememberedPublicState','clearRememberedPublicState','IDENTITY_PREFS','KEY_PUBLIC_STATE']))
ok('Native remembered state is secret-free allowlisted', all(x in bridge for x in ['out.put("publicKey"', 'out.put("persist", true)', 'out.put("relays"', 'out.put("following"']) and all(x not in bridge for x in ['out.put("privateKey"', 'out.put("bunkerUrl"', 'out.put("nip46"']))
ok('Native remembered state uses synchronous commit', '.putString(KEY_PUBLIC_STATE, out.toString()).commit()' in bridge and '.remove(KEY_PUBLIC_STATE).commit()' in bridge)
ok('APK prefers native remembered state', 'loadRememberedPublicState' in text and 'fromNative: true' in text and 'Native Android storage is authoritative' in text)
ok('APK saves and clears native remembered state', 'saveRememberedPublicState(payload)' in text and 'clearRememberedPublicState()' in text)
ok('Lifecycle flushes persistent public session', "document.addEventListener('visibilitychange'" in text and "window.addEventListener('pagehide'" in text)
ok('WebView detaches before destroy', 'ViewParent parent = webView.getParent();' in mainactivity and '((ViewGroup) parent).removeView(webView);' in mainactivity)
ok('Android Keystore local signer vault', all(x in bridge for x in ['AndroidKeyStore','KeyGenParameterSpec','AES/GCM/NoPadding','KEY_LOCAL_SIGNER','saveRememberedLocalSigner','loadRememberedLocalSigner','clearRememberedLocalSigner']))
ok('Local signer vault uses authenticated encryption', 'cipher.updateAAD(SIGNER_AAD)' in bridge and 'new GCMParameterSpec(128, iv)' in bridge and '.setRandomizedEncryptionRequired(true)' in bridge)
ok('Local signer vault writes only sealed ciphertext', '.putString(KEY_LOCAL_SIGNER, sealed.toString()).commit()' in bridge and '.putString(KEY_LOCAL_SIGNER, clear.toString())' not in bridge)
ok('Local signer restore is pubkey-bound', 'if (!expected.equals(pub)) return "";' in bridge and 'if (!secret.matches("[0-9a-f]{64}")) return "";' in bridge)
ok('Local signer restore wired into saved session', 'glowstrRestoreNativeLocalSigner(saved.signerMethod)' in text and 'loadRememberedLocalSigner(state.publicKey)' in text)
ok('Local signer persistence follows Stay logged in', 'glowstrSaveNativeLocalSigner();' in text and 'glowstrClearNativeLocalSigner();' in text and 'protected by Android Keystore' in text)
ok('Public WebView state still excludes raw signer key', 'privateKey: state.privateKey' not in text[text.index('function saveState()'):text.index('// Persist the already-secret-free public session')])
ok('Read-only restored identity is not shown as healthy signer', "SIGNER REQUIRED" in text and "RECONNECT" in text and 'function glowstrSignerReady()' in text)
ok('NIP-51 public mute list handling', "event.kind === 10000" in text and all(x in text for x in ["type === 'p'", "type === 'word'", "type === 't'", "type === 'e'"]))
ok('Per-note local mute action', 'data-glow-action="mute-author"' in text and "case 'mute-author'" in text and 'glowstrMuteAuthor' in text)
ok('Hidden feed events skip profile fetch', 'if (visibleInFeed && !state.profiles[event.pubkey]) requestProfile(event.pubkey);' in text)
ok('Feed count is coalesced', '_glowstrFeedCountTimer' in text and '}, 180);' in text)
ok('Sidebar updates are coalesced', 'glowstrScheduleSidebars' in text and '_glowstrSidebarTimer' in text)
ok('Mobile feed GPU cleanup', 'body::before, body::after { display:none !important; }' in text and 'backdrop-filter:none !important' in text)
ok('Mobile feed DOM cap', 'glowstrUsesMobileShell() ? 60 : 110' in text)
ok('Duplicate note pubkey attribute fixed', not re.search(r'data-pubkey=["\'][^>]{0,160}data-pubkey=', text))
ok('Bounded helper cache', 'MAX_ROWS = 5000' in (JAVA/'EventStore.java').read_text())
ok('Bounded peer sessions', 'MAX_LIVE_SESSIONS = 12' in btm and 'newFixedThreadPool(12)' in btm)
ok('Bounded pending GATT', 'MAX_PENDING_GATT = 8' in btm)
ok('Peer rate limits', 'rateCount > 60' in btm and 'frameCount > 120' in btm)
ok('Fast scan falls back to balanced', 'SCAN_MODE_LOW_LATENCY' in btm and 'SCAN_MODE_BALANCED' in btm and '20, TimeUnit.SECONDS' in btm)
ok('No native Nostr event signing implementation in helper', not re.search(r'(?i)signNostrEvent|generatePrivateKey|schnorr\s*sign|secp256k1\s*sign', alljava))

# Store-and-forward protocol simulation. Models id+sig dedup and higher-TTL refresh.
class Node:
    def __init__(self,name): self.name=name; self.store={}; self.out=[]
    def recv(self,key,h,src=None):
        next_h=max(0,min(5,h)-1)
        old=self.store.get(key,-1)
        if old>=next_h: return False
        self.store[key]=next_h
        if next_h>0: self.out.append((key,next_h,src))
        return True
    def local(self,key,h=5): self.store[key]=max(self.store.get(key,-1),h); self.out.append((key,h,None))

def flood(nodes, links, origin, key, hops):
    q=[(origin,None,key,hops)]
    delivered=0
    seen_steps=0
    while q:
        sender,previous,k,h=q.pop(0); seen_steps+=1
        if seen_steps>100: raise AssertionError('loop detected')
        for peer in links[sender]:
            if peer==previous: continue
            delivered+=1
            if nodes[peer].recv(k,h,sender):
                nh=nodes[peer].store[k]
                if nh>0: q.append((peer,sender,k,nh))
    return delivered
nodes={n:Node(n) for n in 'ABCD'}
links={'A':['B'],'B':['A','C'],'C':['B','D'],'D':['C']}
nodes['A'].local('id:sig',3)
flood(nodes,links,'A','id:sig',3)
ok('Store-forward reaches 3-link chain', all('id:sig' in nodes[n].store for n in 'ABCD'))
# replay should not create loops
before={n:dict(x.store) for n,x in nodes.items()}; flood(nodes,links,'A','id:sig',3)
ok('Store-forward replay deduplicates', all(nodes[n].store==before[n] for n in nodes))
# Higher TTL later should refresh forwarding capability
x=Node('X'); ok1=x.recv('e',1); low=x.store['e']; ok2=x.recv('e',5); high=x.store['e']
ok('Higher-TTL duplicate refreshes forwarding', ok1 and ok2 and low==0 and high==4)

print('ALL STATIC / PROTOCOL TESTS PASSED')
