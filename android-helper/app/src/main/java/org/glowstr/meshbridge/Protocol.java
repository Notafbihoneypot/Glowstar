package org.glowstr.meshbridge;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

final class Protocol {
    static final int VERSION = 1;
    static final int DEFAULT_HOPS = 5;
    static final int MAX_HOPS = 5;
    static final int MAX_FRAME_BYTES = 64 * 1024;
    static final int MAX_EVENT_JSON_BYTES = 48 * 1024;
    static final int MAX_CONTENT_CHARS = 16 * 1024;
    static final long MAX_EVENT_AGE_SECONDS = 7L * 24 * 60 * 60;
    static final long MAX_FUTURE_SECONDS = 10 * 60;

    private static final SecureRandom RNG = new SecureRandom();

    private Protocol() {}

    static String randomNodeId() {
        byte[] b = new byte[8];
        RNG.nextBytes(b);
        return hex(b);
    }

    static String randomToken() {
        byte[] b = new byte[32];
        RNG.nextBytes(b);
        return android.util.Base64.encodeToString(b,
                android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
    }

    static boolean isHex(String s, int len) {
        if (s == null || s.length() != len) return false;
        for (int i = 0; i < len; i++) {
            char c = s.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        }
        return true;
    }

    static JSONObject validatePublicEvent(JSONObject event) throws JSONException {
        if (event == null) throw new JSONException("event missing");
        if (event.optInt("kind", -1) != 1) throw new JSONException("Bluetooth Direct supports public kind-1 notes only");
        String id = event.optString("id", "");
        String pubkey = event.optString("pubkey", "");
        String sig = event.optString("sig", "");
        if (!isHex(id, 64) || !isHex(pubkey, 64) || !isHex(sig, 128)) throw new JSONException("event id/pubkey/signature malformed");
        long created = event.optLong("created_at", -1);
        long now = System.currentTimeMillis() / 1000L;
        if (created < 0 || created < now - MAX_EVENT_AGE_SECONDS || created > now + MAX_FUTURE_SECONDS) {
            throw new JSONException("event timestamp outside Bluetooth Direct window");
        }
        String content = event.optString("content", null);
        if (content == null || content.length() > MAX_CONTENT_CHARS) throw new JSONException("event content too large");
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null || tags.length() > 256) throw new JSONException("event tags malformed");
        List<List<String>> canonicalTags = new ArrayList<>();
        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag == null || tag.length() > 16) throw new JSONException("event tag malformed");
            List<String> canonicalTag = new ArrayList<>();
            for (int j = 0; j < tag.length(); j++) {
                Object v = tag.opt(j);
                if (!(v instanceof String) || ((String) v).length() > 2048) throw new JSONException("event tag value malformed");
                canonicalTag.add((String) v);
            }
            canonicalTags.add(canonicalTag);
        }
        byte[] encoded = event.toString().getBytes(StandardCharsets.UTF_8);
        if (encoded.length > MAX_EVENT_JSON_BYTES) throw new JSONException("event JSON too large");
        String computedId = NostrCrypto.eventId(pubkey, created, 1, canonicalTags, content);
        if (!id.equals(computedId)) throw new JSONException("event id does not match NIP-01 serialization");
        if (!NostrCrypto.verifySchnorr(pubkey, id, sig)) throw new JSONException("event Schnorr signature invalid");
        return event;
    }

    static JSONObject hello(String nodeId) throws JSONException {
        return new JSONObject().put("v", VERSION).put("t", "hello").put("node", nodeId);
    }

    static JSONObject envelope(JSONObject event, int hops) throws JSONException {
        validatePublicEvent(event);
        return new JSONObject()
                .put("v", VERSION)
                .put("t", "event")
                .put("h", Math.max(0, Math.min(MAX_HOPS, hops)))
                .put("event", event);
    }

    static byte[] frame(JSONObject msg) throws JSONException {
        byte[] body = msg.toString().getBytes(StandardCharsets.UTF_8);
        if (body.length <= 0 || body.length > MAX_FRAME_BYTES) throw new JSONException("mesh frame too large");
        ByteBuffer bb = ByteBuffer.allocate(4 + body.length).order(ByteOrder.BIG_ENDIAN);
        bb.putInt(body.length).put(body);
        return bb.array();
    }

    static int boundedHops(int hops) {
        return Math.max(0, Math.min(MAX_HOPS, hops));
    }

    static byte[] infoBytes(int psm, String nodeId) {
        byte[] node = fromHex(nodeId);
        ByteBuffer b = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN);
        b.put((byte) VERSION);
        b.put((byte) 0); // flags reserved
        b.putShort((short) (psm & 0xffff));
        b.put(node, 0, Math.min(8, node.length));
        return b.array();
    }

    static int infoPsm(byte[] info) {
        if (info == null || info.length < 12 || (info[0] & 0xff) != VERSION) return -1;
        return ByteBuffer.wrap(info, 2, 2).order(ByteOrder.LITTLE_ENDIAN).getShort() & 0xffff;
    }

    static String infoNodeId(byte[] info) {
        if (info == null || info.length < 12 || (info[0] & 0xff) != VERSION) return null;
        byte[] b = new byte[8];
        System.arraycopy(info, 4, b, 0, 8);
        return hex(b);
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02x", x & 0xff));
        return sb.toString();
    }

    static byte[] fromHex(String s) {
        if (s == null || (s.length() & 1) != 0) return new byte[0];
        ByteArrayOutputStream out = new ByteArrayOutputStream(s.length() / 2);
        for (int i = 0; i < s.length(); i += 2) {
            int hi = Character.digit(s.charAt(i), 16);
            int lo = Character.digit(s.charAt(i + 1), 16);
            if (hi < 0 || lo < 0) return new byte[0];
            out.write((hi << 4) | lo);
        }
        return out.toByteArray();
    }
}
