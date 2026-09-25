package org.glowstr.meshbridge;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
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

import java.io.ByteArrayOutputStream;
import java.util.EnumMap;
import java.util.Map;

public final class AndroidBridge {
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
            hints.put(EncodeHintType.MARGIN, 2);
            hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M);
            BitMatrix matrix = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 512, 512, hints);
            int width = matrix.getWidth(), height = matrix.getHeight();
            int[] pixels = new int[width * height];
            for (int y = 0; y < height; y++) {
                int row = y * width;
                for (int x = 0; x < width; x++) pixels[row + x] = matrix.get(x, y) ? 0xFF000000 : 0xFFFFFFFF;
            }
            Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            bitmap.setPixels(pixels, 0, width, 0, 0, width, height);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) return "";
            bitmap.recycle();
            return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
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
