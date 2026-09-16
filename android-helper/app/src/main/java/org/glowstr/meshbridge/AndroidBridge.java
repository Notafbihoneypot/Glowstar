package org.glowstr.meshbridge;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

public final class AndroidBridge {
    private final Context context;

    AndroidBridge(Context context) {
        this.context = context.getApplicationContext();
        NativeNotifier.ensureChannel(this.context);
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
    public boolean amberSignEvent(String eventJson) {
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
