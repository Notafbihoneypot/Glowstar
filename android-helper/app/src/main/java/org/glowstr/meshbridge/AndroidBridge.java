package org.glowstr.meshbridge;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

public final class AndroidBridge {
    private static final int REQ_NOTIFICATIONS = 423;

    private final Context context;
    private final Activity activity;

    AndroidBridge(Context context) {
        this.context = context.getApplicationContext();
        this.activity = context instanceof Activity ? (Activity) context : null;
        NativeNotifier.ensureChannel(this.context);
        requestNotificationPermissionIfNeeded();
    }

    private void requestNotificationPermissionIfNeeded() {
        if (activity == null || Build.VERSION.SDK_INT < 33) return;
        if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        activity.getWindow().getDecorView().post(() -> {
            try {
                if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
                }
            } catch (RuntimeException ignored) {}
        });
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
