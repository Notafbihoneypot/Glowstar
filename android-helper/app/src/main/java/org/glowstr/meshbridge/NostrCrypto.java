package org.glowstr.meshbridge;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;

/** Pure-Java NIP-01 event-id serialization and BIP-340 verification. No signing. */
final class NostrCrypto {
    private static final BigInteger P = new BigInteger("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F", 16);
    private static final BigInteger N = new BigInteger("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", 16);
    private static final Point G = new Point(
            new BigInteger("79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798", 16),
            new BigInteger("483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8", 16));
    private static final String CHALLENGE_TAG = "BIP0340/challenge";

    private NostrCrypto() {}

    static String eventId(String pubkey, long createdAt, int kind, List<List<String>> tags, String content) {
        String canonical = eventSerialization(pubkey, createdAt, kind, tags, content);
        return hex(sha256(canonical.getBytes(StandardCharsets.UTF_8)));
    }

    static String eventSerialization(String pubkey, long createdAt, int kind, List<List<String>> tags, String content) {
        StringBuilder b = new StringBuilder(256 + (content == null ? 0 : content.length()));
        b.append("[0,").append(quote(pubkey)).append(',').append(createdAt).append(',').append(kind).append(",[");
        for (int i = 0; i < tags.size(); i++) {
            if (i > 0) b.append(',');
            List<String> tag = tags.get(i);
            b.append('[');
            for (int j = 0; j < tag.size(); j++) {
                if (j > 0) b.append(',');
                b.append(quote(tag.get(j)));
            }
            b.append(']');
        }
        b.append("],").append(quote(content)).append(']');
        return b.toString();
    }

    static boolean verifySchnorr(String pubkeyHex, String msgHex, String sigHex) {
        try {
            byte[] pub = fromHex(pubkeyHex, 32);
            byte[] msg = fromHex(msgHex, 32);
            byte[] sig = fromHex(sigHex, 64);
            if (pub == null || msg == null || sig == null) return false;

            BigInteger px = new BigInteger(1, pub);
            if (px.compareTo(P) >= 0) return false;
            Point point = liftX(px);
            if (point == null) return false;

            byte[] rBytes = new byte[32];
            byte[] sBytes = new byte[32];
            System.arraycopy(sig, 0, rBytes, 0, 32);
            System.arraycopy(sig, 32, sBytes, 0, 32);
            BigInteger r = new BigInteger(1, rBytes);
            BigInteger s = new BigInteger(1, sBytes);
            if (r.compareTo(P) >= 0 || s.compareTo(N) >= 0) return false;

            byte[] challengeInput = new byte[96];
            System.arraycopy(rBytes, 0, challengeInput, 0, 32);
            System.arraycopy(pub, 0, challengeInput, 32, 32);
            System.arraycopy(msg, 0, challengeInput, 64, 32);
            BigInteger e = new BigInteger(1, taggedHash(CHALLENGE_TAG, challengeInput)).mod(N);

            Point R = add(mul(G, s), mul(point, N.subtract(e).mod(N)));
            return R != null && !R.infinity && !R.y.testBit(0) && R.x.equals(r);
        } catch (Exception e) {
            return false;
        }
    }

    private static Point liftX(BigInteger x) {
        if (x.signum() < 0 || x.compareTo(P) >= 0) return null;
        BigInteger c = x.modPow(BigInteger.valueOf(3), P).add(BigInteger.valueOf(7)).mod(P);
        BigInteger y = c.modPow(P.add(BigInteger.ONE).shiftRight(2), P);
        if (!y.multiply(y).mod(P).equals(c)) return null;
        if (y.testBit(0)) y = P.subtract(y);
        return new Point(x, y);
    }

    private static Point mul(Point a, BigInteger k) {
        if (a == null || a.infinity || k.signum() == 0) return Point.INFINITY;
        BigInteger n = k.mod(N);
        Point out = Point.INFINITY;
        Point cur = a;
        while (n.signum() > 0) {
            if (n.testBit(0)) out = add(out, cur);
            cur = add(cur, cur);
            n = n.shiftRight(1);
        }
        return out;
    }

    private static Point add(Point a, Point b) {
        if (a == null || a.infinity) return b;
        if (b == null || b.infinity) return a;
        if (a.x.equals(b.x)) {
            if (!a.y.equals(b.y) || a.y.signum() == 0) return Point.INFINITY;
            BigInteger numerator = a.x.multiply(a.x).multiply(BigInteger.valueOf(3)).mod(P);
            BigInteger denominator = a.y.shiftLeft(1).mod(P).modInverse(P);
            BigInteger lambda = numerator.multiply(denominator).mod(P);
            BigInteger x3 = lambda.multiply(lambda).subtract(a.x.shiftLeft(1)).mod(P);
            BigInteger y3 = lambda.multiply(a.x.subtract(x3)).subtract(a.y).mod(P);
            return new Point(x3, y3);
        }
        BigInteger numerator = b.y.subtract(a.y).mod(P);
        BigInteger denominator = b.x.subtract(a.x).mod(P).modInverse(P);
        BigInteger lambda = numerator.multiply(denominator).mod(P);
        BigInteger x3 = lambda.multiply(lambda).subtract(a.x).subtract(b.x).mod(P);
        BigInteger y3 = lambda.multiply(a.x.subtract(x3)).subtract(a.y).mod(P);
        return new Point(x3, y3);
    }

    private static byte[] taggedHash(String tag, byte[] payload) {
        byte[] tagHash = sha256(tag.getBytes(StandardCharsets.UTF_8));
        byte[] input = new byte[tagHash.length * 2 + payload.length];
        System.arraycopy(tagHash, 0, input, 0, tagHash.length);
        System.arraycopy(tagHash, 0, input, tagHash.length, tagHash.length);
        System.arraycopy(payload, 0, input, tagHash.length * 2, payload.length);
        return sha256(input);
    }

    private static byte[] sha256(byte[] input) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(input);
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static String quote(String value) {
        if (value == null) return "null";
        StringBuilder b = new StringBuilder(value.length() + 16);
        b.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\b': b.append("\\b"); break;
                case '\f': b.append("\\f"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20 || (Character.isSurrogate(c) &&
                            !((Character.isHighSurrogate(c) && i + 1 < value.length() && Character.isLowSurrogate(value.charAt(i + 1))) ||
                              (Character.isLowSurrogate(c) && i > 0 && Character.isHighSurrogate(value.charAt(i - 1)))))) {
                        appendUnicodeEscape(b, c);
                    } else {
                        b.append(c);
                    }
            }
        }
        b.append('"');
        return b.toString();
    }

    private static void appendUnicodeEscape(StringBuilder b, char c) {
        final char[] h = "0123456789abcdef".toCharArray();
        b.append("\\u");
        b.append(h[(c >>> 12) & 0xf]);
        b.append(h[(c >>> 8) & 0xf]);
        b.append(h[(c >>> 4) & 0xf]);
        b.append(h[c & 0xf]);
    }

    private static byte[] fromHex(String s, int expectedBytes) {
        if (s == null || s.length() != expectedBytes * 2) return null;
        byte[] out = new byte[expectedBytes];
        for (int i = 0; i < expectedBytes; i++) {
            int hi = Character.digit(s.charAt(i * 2), 16);
            int lo = Character.digit(s.charAt(i * 2 + 1), 16);
            if (hi < 0 || lo < 0) return null;
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    private static String hex(byte[] b) {
        final char[] h = "0123456789abcdef".toCharArray();
        char[] out = new char[b.length * 2];
        for (int i = 0; i < b.length; i++) {
            out[i * 2] = h[(b[i] >>> 4) & 0xf];
            out[i * 2 + 1] = h[b[i] & 0xf];
        }
        return new String(out);
    }

    private static final class Point {
        static final Point INFINITY = new Point();
        final BigInteger x;
        final BigInteger y;
        final boolean infinity;
        private Point() { this.x = BigInteger.ZERO; this.y = BigInteger.ZERO; this.infinity = true; }
        Point(BigInteger x, BigInteger y) { this.x = x; this.y = y; this.infinity = false; }
    }
}
