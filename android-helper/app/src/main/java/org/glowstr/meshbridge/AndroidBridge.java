package org.glowstr.meshbridge;

import android.content.Context;
import android.content.Intent;
import android.util.Base64;
import android.net.Uri;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;

import java.util.EnumMap;
import java.util.Map;

public final class AndroidBridge {
    private static final String IDENTITY_PREFS = "glowstr_identity";
    private static final String KEY_PUBLIC_STATE = "remembered_public_state";
    private final Context context;

    AndroidBridge(Context context) {
        this.context = context.getApplicationContext();
        NativeNotifier.ensureChannel(this.context);
        MeshDiagnostics.start(this.context);
    }

    @JavascriptInterface
    public boolean notificationsEnabled() {
        return NativeNotifier.canPost(context);
    }

    @JavascriptInterface
    public boolean notifyNostr(String type, String key) {
        return NativeNotifier.postActivity(context, type == null ? "activity" : type, key);
    }

    @JavascriptInterface
    public boolean amberSignerAvailable() {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:"));
            return !context.getPackageManager().queryIntentActivities(i, 0).isEmpty();
        } catch (RuntimeException e) {
            return false;
        }
    }

    @JavascriptInterface
    public boolean amberGetPublicKey() {
        if (!amberSignerAvailable()) return false;
        try {
            context.startActivity(new Intent(context, AmberProxyActivity.class)
                    .putExtra("request_type", AmberProxyActivity.ACTION_PUBLIC_KEY)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    @JavascriptInterface
    public boolean amberApproveEvent(String eventJson) {
        if (!amberSignerAvailable() || eventJson == null || eventJson.trim().isEmpty()) return false;
        try {
            String currentUser = "";
            try { currentUser = new JSONObject(eventJson).optString("pubkey", ""); } catch (Exception ignored) {}
            context.startActivity(new Intent(context, AmberProxyActivity.class)
                    .putExtra("request_type", AmberProxyActivity.ACTION_SIGN_EVENT)
                    .putExtra("event_json", eventJson)
                    .putExtra("current_user", currentUser)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    @JavascriptInterface
    public String pollAmberResult() {
        try {
            android.content.SharedPreferences p = context.getSharedPreferences(AmberProxyActivity.PREFS, Context.MODE_PRIVATE);
            String result = p.getString(AmberProxyActivity.KEY_RESULT, "");
            if (result == null || result.isEmpty()) return "";
            p.edit().remove(AmberProxyActivity.KEY_RESULT).apply();
            return result;
        } catch (RuntimeException e) {
            return "";
        }
    }

    /**
     * Persist only the secret-free public session subset in native Android storage.
     * This intentionally excludes nsec/private keys, bunker URLs, NIP-46 client keys,
     * tokens, encrypted secrets, and arbitrary caller-controlled fields.
     */
    @JavascriptInterface
    public boolean saveRememberedPublicState(String rawJson) {
        if (rawJson == null || rawJson.length() > 512 * 1024) return false;
        try {
            JSONObject in = new JSONObject(rawJson);
            if (!in.optBoolean("persist", false)) {
                return clearRememberedPublicState();
            }

            String publicKey = in.optString("publicKey", "").trim().toLowerCase(java.util.Locale.ROOT);
            if (!publicKey.matches("[0-9a-f]{64}")) return false;

            JSONObject out = new JSONObject();
            out.put("publicKey", publicKey);
            out.put("persist", true);

            String signerMethod = in.optString("signerMethod", "").trim();
            if (signerMethod.length() <= 64 &&
                    ("amber-nip55".equals(signerMethod) ||
                     "nip07".equals(signerMethod) ||
                     "readonly".equals(signerMethod) ||
                     "watch".equals(signerMethod))) {
                out.put("signerMethod", signerMethod);
            }

            org.json.JSONArray relaysIn = in.optJSONArray("relays");
            org.json.JSONArray relaysOut = new org.json.JSONArray();
            if (relaysIn != null) {
                int count = Math.min(relaysIn.length(), 64);
                for (int i = 0; i < count; i++) {
                    String relay = relaysIn.optString(i, "").trim();
                    if (relay.length() <= 512 &&
                            (relay.startsWith("wss://") || relay.startsWith("ws://"))) {
                        relaysOut.put(relay);
                    }
                }
            }
            out.put("relays", relaysOut);

            org.json.JSONArray followingIn = in.optJSONArray("following");
            org.json.JSONArray followingOut = new org.json.JSONArray();
            if (followingIn != null) {
                int count = Math.min(followingIn.length(), 5000);
                for (int i = 0; i < count; i++) {
                    String pk = followingIn.optString(i, "").trim().toLowerCase(java.util.Locale.ROOT);
                    if (pk.matches("[0-9a-f]{64}")) followingOut.put(pk);
                }
            }
            out.put("following", followingOut);

            // commit() is intentionally synchronous so a user/profile switch cannot
            // kill the WebView before Android has durably written the remembered state.
            return context.getSharedPreferences(IDENTITY_PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_PUBLIC_STATE, out.toString()).commit();
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public String loadRememberedPublicState() {
        try {
            String value = context.getSharedPreferences(IDENTITY_PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_PUBLIC_STATE, "");
            return value == null ? "" : value;
        } catch (RuntimeException e) {
            return "";
        }
    }

    @JavascriptInterface
    public boolean clearRememberedPublicState() {
        try {
            return context.getSharedPreferences(IDENTITY_PREFS, Context.MODE_PRIVATE)
                    .edit().remove(KEY_PUBLIC_STATE).commit();
        } catch (RuntimeException e) {
            return false;
        }
    }

    @JavascriptInterface
    public boolean startNostrQrScanner() {
        try {
            context.getSharedPreferences(QrScanActivity.PREFS, Context.MODE_PRIVATE)
                    .edit().remove(QrScanActivity.KEY_RESULT).apply();
            context.startActivity(new Intent(context, QrScanActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    @JavascriptInterface
    public String pollNostrQrResult() {
        try {
            android.content.SharedPreferences p =
                    context.getSharedPreferences(QrScanActivity.PREFS, Context.MODE_PRIVATE);
            String result = p.getString(QrScanActivity.KEY_RESULT, "");
            if (result == null || result.isEmpty()) return "";
            p.edit().remove(QrScanActivity.KEY_RESULT).apply();
            return result;
        } catch (RuntimeException e) {
            return "";
        }
    }

    @JavascriptInterface
    public String makeNostrQrDataUrl(String payload) {
        if (payload == null) return "";
        String value = payload.trim();
        if (value.length() < 8 || value.length() > 1024) return "";
        try {
            Map<EncodeHintType,Object> hints = new EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.MARGIN, 4);
            hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M);

            // Ask ZXing for the module grid at its natural size. Rendering that
            // grid as SVG avoids fractional bitmap scaling that made the first
            // QR look uneven on high-DPI phones.
            BitMatrix matrix = new QRCodeWriter().encode(
                    value, BarcodeFormat.QR_CODE, 0, 0, hints);
            int width = matrix.getWidth();
            int height = matrix.getHeight();

            StringBuilder path = new StringBuilder(width * height / 2);
            for (int y = 0; y < height; y++) {
                int x = 0;
                while (x < width) {
                    while (x < width && !matrix.get(x, y)) x++;
                    if (x >= width) break;
                    int start = x;
                    while (x < width && matrix.get(x, y)) x++;
                    int run = x - start;
                    path.append('M').append(start).append(' ').append(y)
                            .append('h').append(run)
                            .append("v1h-").append(run).append('z');
                }
            }

            // Keep each QR module an exact integer number of CSS pixels.
            // This avoids screen/camera moire caused by fractional resampling.
            int moduleScale = 8;
            int pixelWidth = width * moduleScale;
            int pixelHeight = height * moduleScale;
            String svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 "
                    + width + " " + height
                    + "\" width=\"" + pixelWidth + "\" height=\"" + pixelHeight
                    + "\" shape-rendering=\"crispEdges\">"
                    + "<rect width=\"100%\" height=\"100%\" fill=\"white\"/>"
                    + "<path d=\"" + path + "\" fill=\"black\"/>"
                    + "</svg>";
            String encoded = Base64.encodeToString(
                    svg.getBytes(java.nio.charset.StandardCharsets.UTF_8), Base64.NO_WRAP);
            return "data:image/svg+xml;base64," + encoded;
        } catch (WriterException | RuntimeException e) {
            return "";
        }
    }

    @JavascriptInterface
    public String pairingToken() {
        MeshService s = MeshService.current();
        if (s != null) return s.pairingToken();
        android.content.SharedPreferences p = context.getSharedPreferences("mesh", Context.MODE_PRIVATE);
        String token = p.getString("pairing_token", null);
        if (token == null || token.length() < 32) {
            token = Protocol.randomToken();
            p.edit().putString("pairing_token", token).apply();
        }
        return token;
    }

    @JavascriptInterface
    public boolean openExternal(String rawUrl) {
        try {
            Uri uri = Uri.parse(rawUrl == null ? "" : rawUrl.trim());
            String scheme = uri.getScheme();
            if (!("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme))) return false;
            Intent i = new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(i);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    @JavascriptInterface
    public String request(String method, String target, String body) {
        try {
            MeshService s = MeshService.current();
            if (s == null) {
                return new JSONObject()
                        .put("status", 503)
                        .put("body", new JSONObject().put("ok", false).put("error", "Bluetooth mesh is starting"))
                        .toString();
            }
            return s.nativeRequest(method, target, body == null ? "" : body).toString();
        } catch (Exception e) {
            String message = e.getMessage();
            if (message == null || message.trim().isEmpty()) message = "Android bridge request failed";
            try {
                return new JSONObject()
                        .put("status", 500)
                        .put("body", new JSONObject().put("ok", false).put("error", message))
                        .toString();
            } catch (Exception ignored) {
                return "{\"status\":500,\"body\":{\"ok\":false,\"error\":\"Android bridge request failed\"}}";
            }
        }
    }
}
