#!/usr/bin/env python3
"""Glowstr Reticulum mesh bridge.

Bridges a local Glowstr browser/PWA (WebSocket) to a public Reticulum
broadcast destination. Only public signed Nostr kind-1 events are accepted.
The browser remains responsible for full Schnorr signature verification.

Default WebSocket bind is loopback-only: ws://127.0.0.1:8787
"""
from __future__ import annotations
import argparse
import asyncio
import gzip
import hashlib
import hmac
import json
import os
import secrets
import stat
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

MAGIC = b"GMS1"
MAX_FRAGMENTS = 16
HEADER_LEN = 15
RNS_PLAIN_MDU = 464
FRAG_DATA = RNS_PLAIN_MDU - HEADER_LEN  # 449 bytes
MAX_EVENT_BYTES = FRAG_DATA * MAX_FRAGMENTS
MAX_WS_BYTES = 1024 * 1024
REASSEMBLY_TTL = 120.0


def canonical_event_id(event: dict) -> Optional[str]:
    try:
        if not isinstance(event, dict):
            return None
        pubkey = event.get("pubkey")
        created_at = event.get("created_at")
        kind = event.get("kind")
        tags = event.get("tags")
        content = event.get("content")
        if not isinstance(pubkey, str) or len(pubkey) != 64:
            return None
        if not isinstance(created_at, int) or not isinstance(kind, int):
            return None
        if not isinstance(tags, list) or not isinstance(content, str):
            return None
        raw = json.dumps([0, pubkey, created_at, kind, tags, content], separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()
    except Exception:
        return None


def basic_event_ok(event: dict) -> bool:
    if not isinstance(event, dict) or event.get("kind") != 1:
        return False
    if not isinstance(event.get("id"), str) or len(event["id"]) != 64:
        return False
    if not isinstance(event.get("sig"), str) or len(event["sig"]) != 128:
        return False
    if not isinstance(event.get("content"), str) or len(event["content"]) > 5000:
        return False
    if not isinstance(event.get("tags"), list) or len(event["tags"]) > 2000:
        return False
    try:
        int(event["id"], 16); int(event["sig"], 16); int(event.get("pubkey", ""), 16)
    except Exception:
        return False
    return hmac.compare_digest(canonical_event_id(event) or "", event["id"].lower())


def encode_event_frames(event: dict) -> List[bytes]:
    if not basic_event_ok(event):
        raise ValueError("Only structurally valid signed kind-1 events are accepted")
    raw = json.dumps(event, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=6, mtime=0)
    flags = 1 if len(compressed) + 8 < len(raw) else 0
    body = compressed if flags else raw
    count = (len(body) + FRAG_DATA - 1) // FRAG_DATA
    if count < 1 or count > MAX_FRAGMENTS:
        raise ValueError("Event is too large for bounded Reticulum mesh framing")
    msg_id = bytes.fromhex(event["id"][:16])
    out = []
    for idx in range(count):
        frag = body[idx * FRAG_DATA:(idx + 1) * FRAG_DATA]
        out.append(MAGIC + bytes([flags]) + msg_id + bytes([idx, count]) + frag)
    return out


def parse_frame(data: bytes):
    if not isinstance(data, (bytes, bytearray)) or len(data) < HEADER_LEN + 1 or len(data) > RNS_PLAIN_MDU:
        return None
    if data[:4] != MAGIC:
        return None
    flags = data[4]
    if flags & ~1:
        return None
    msg = data[5:13].hex()
    idx, count = data[13], data[14]
    if count < 1 or count > MAX_FRAGMENTS or idx >= count:
        return None
    return flags, msg, idx, count, bytes(data[15:])


class Reassembler:
    def __init__(self):
        self.pending: Dict[str, dict] = {}
        self.seen: Dict[str, float] = {}
        self.max_pending = 128
        self.max_seen = 1024

    def reap(self):
        now = time.monotonic()
        self.pending = {k: v for k, v in self.pending.items() if now - v["at"] <= REASSEMBLY_TTL}
        self.seen = {k: t for k, t in self.seen.items() if now - t <= 900.0}
        while len(self.pending) > self.max_pending:
            self.pending.pop(next(iter(self.pending)))
        while len(self.seen) > self.max_seen:
            self.seen.pop(next(iter(self.seen)))

    def feed(self, data: bytes) -> Optional[dict]:
        self.reap()
        p = parse_frame(data)
        if not p:
            return None
        flags, msg, idx, count, frag = p
        if msg in self.seen:
            return None
        item = self.pending.get(msg)
        if not item or item["flags"] != flags or item["count"] != count:
            item = {"flags": flags, "count": count, "parts": [None] * count, "at": time.monotonic()}
            self.pending[msg] = item
        item["at"] = time.monotonic()
        item["parts"][idx] = frag
        if any(x is None for x in item["parts"]):
            return None
        self.pending.pop(msg, None)
        body = b"".join(item["parts"])
        if flags & 1:
            body = gzip.decompress(body)
        if len(body) > MAX_WS_BYTES:
            return None
        try:
            event = json.loads(body.decode("utf-8"))
        except Exception:
            return None
        if not basic_event_ok(event) or not event["id"].startswith(msg):
            return None
        self.seen[msg] = time.monotonic()
        return event


def load_or_create_token(path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        token = path.read_text().strip()
        if len(token) >= 32:
            return token
    token = secrets.token_hex(32)
    path.write_text(token + "\n")
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    return token


class Bridge:
    def __init__(self, token: str, channel: str, rns_config: Optional[str]):
        self.token = token
        self.channel = channel
        self.rns_config = rns_config
        self.clients = set()
        self.authed = set()
        self.loop = None
        self.reassembler = Reassembler()
        self.RNS = None
        self.destination = None

    def init_rns(self):
        try:
            import RNS
        except ImportError as e:
            raise RuntimeError("Reticulum is not installed. Install it with: python -m pip install rns") from e
        self.RNS = RNS
        RNS.Reticulum(self.rns_config)
        self.destination = RNS.Destination(None, RNS.Destination.IN, RNS.Destination.PLAIN, "glowstr", "mesh", self.channel)
        self.destination.set_packet_callback(self.on_rns_packet)
        return self.destination.hash.hex() if isinstance(self.destination.hash, (bytes, bytearray)) else str(self.destination.hash)

    def on_rns_packet(self, data, packet):
        try:
            event = self.reassembler.feed(bytes(data))
            if not event or not self.loop:
                return
            ph = getattr(packet, "packet_hash", None)
            source = ph.hex()[:32] if isinstance(ph, (bytes, bytearray)) else "public"
            asyncio.run_coroutine_threadsafe(self.broadcast_event(event, source), self.loop)
        except Exception as e:
            print(f"[mesh] dropped RNS packet: {e}", file=sys.stderr)

    async def broadcast_event(self, event: dict, source: str):
        if not self.authed:
            return
        msg = json.dumps({"type": "event", "event": event, "source": source}, separators=(",", ":"), ensure_ascii=False)
        dead = []
        for ws in list(self.authed):
            try:
                await ws.send(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.authed.discard(ws); self.clients.discard(ws)

    async def publish(self, event: dict):
        frames = encode_event_frames(event)
        for frame in frames:
            pkt = self.RNS.Packet(self.destination, frame, create_receipt=False)
            sent = pkt.send()
            if sent is False:
                raise RuntimeError("Reticulum packet send failed")
            await asyncio.sleep(0.04)
        return len(frames)

    async def ws_handler(self, ws):
        self.clients.add(ws)
        try:
            async for raw in ws:
                if not isinstance(raw, str) or len(raw) > MAX_WS_BYTES:
                    await ws.close(code=1009, reason="message too large")
                    return
                try:
                    msg = json.loads(raw)
                except Exception:
                    await ws.send(json.dumps({"type":"error","message":"invalid JSON"}))
                    continue
                if ws not in self.authed:
                    supplied = str(msg.get("token", "")) if msg.get("type") == "hello" else ""
                    if not supplied or not hmac.compare_digest(supplied, self.token):
                        await ws.close(code=1008, reason="pairing token required")
                        return
                    self.authed.add(ws)
                    await ws.send(json.dumps({"type":"ready","channel":f"reticulum:{self.channel}","public_notes_only":True}))
                    continue
                if msg.get("type") == "publish":
                    event = msg.get("event")
                    try:
                        n = await self.publish(event)
                        await ws.send(json.dumps({"type":"published","id":event.get("id"),"fragments":n}))
                    except Exception as e:
                        await ws.send(json.dumps({"type":"error","message":str(e)[:200]}))
                elif msg.get("type") == "ping":
                    await ws.send(json.dumps({"type":"pong","time":int(time.time())}))
                else:
                    await ws.send(json.dumps({"type":"error","message":"unsupported message type"}))
        finally:
            self.authed.discard(ws); self.clients.discard(ws)


def self_test() -> int:
    # Deterministic structural test event. The signature is format-only; bridge intentionally
    # cannot Schnorr-verify it. Browser Glowstr performs full verification before display.
    event = {
        "id":"0"*64,"pubkey":"1"*64,"created_at":1700000000,"kind":1,
        "tags":[["t","mesh"]],"content":secrets.token_urlsafe(3000),"sig":"2"*128
    }
    event["id"] = canonical_event_id(event)
    frames = encode_event_frames(event)
    r = Reassembler(); got = None
    for f in reversed(frames):
        x = r.feed(f)
        if x is not None: got = x
    assert got and got["id"] == event["id"] and got["content"] == event["content"]
    assert parse_frame(b"BAD!" + b"x"*20) is None
    assert all(len(f) <= RNS_PLAIN_MDU for f in frames)
    print(f"SELF-TEST PASS ({len(frames)} fragment(s))")
    return 0


async def amain(args):
    try:
        from websockets.asyncio.server import serve
    except ImportError as e:
        raise RuntimeError("websockets is not installed. Install it with: python -m pip install websockets") from e
    if args.bind not in ("127.0.0.1", "::1", "localhost") and not args.allow_lan:
        raise RuntimeError("Refusing non-loopback bind without --allow-lan. Use TLS/reverse proxy if exposing the bridge on a LAN.")
    token = args.token or load_or_create_token(Path(args.token_file).expanduser())
    bridge = Bridge(token, args.channel, args.rns_config)
    dest_hash = bridge.init_rns()
    bridge.loop = asyncio.get_running_loop()
    print("Glowstr Reticulum bridge")
    print(f"  WebSocket: ws://{args.bind}:{args.port}")
    print(f"  RNS channel: glowstr.mesh.{args.channel}")
    print(f"  RNS destination: {dest_hash}")
    print(f"  Pairing token: {token}")
    print("  Public signed kind-1 notes only. Browser still performs full Nostr signature verification.")
    async with serve(bridge.ws_handler, args.bind, args.port, max_size=MAX_WS_BYTES, compression=None, ping_interval=30, ping_timeout=20):
        await asyncio.Future()


def main():
    p = argparse.ArgumentParser(description="Local Glowstr ↔ Reticulum bridge for public offline Nostr notes")
    p.add_argument("--bind", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--channel", default="public", help="Reticulum Glowstr public channel/aspect")
    p.add_argument("--rns-config", default=None, help="Alternative Reticulum config directory")
    p.add_argument("--token", default=None, help="Explicit WebSocket pairing token (otherwise persisted locally)")
    p.add_argument("--token-file", default="~/.glowstr/mesh-token")
    p.add_argument("--allow-lan", action="store_true", help="Allow binding beyond loopback (prefer WSS via reverse proxy)")
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args()
    if args.self_test:
        return self_test()
    try:
        asyncio.run(amain(args))
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
