package org.glowstr.meshbridge;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import org.json.JSONArray;
import org.json.JSONObject;

public final class AmberProxyActivity extends Activity {
    static final String ACTION_PUBLIC_KEY = "amber_get_public_key";
    static final String ACTION_SIGN_EVENT = "amber_sign_event";
    static final String PREFS = "amber_native";
    static final String KEY_RESULT = "pending_result";
    static final String KEY_PACKAGE = "signer_package";
    private static final int REQ_SIGNER = 5501;

    private String requestType;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (state != null) {
            requestType = state.getString("request_type", "");
            return;
        }
        requestType = getIntent().getStringExtra("request_type");
        launchSigner();
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putString("request_type", requestType == null ? "" : requestType);
    }

    private void launchSigner() {
        try {
            final boolean getKey = ACTION_PUBLIC_KEY.equals(requestType);
            final String payload = getKey ? "" : getIntent().getStringExtra("event_json");
            Uri uri = Uri.parse("nostrsigner:" + (payload == null ? "" : payload));
            Intent signer = new Intent(Intent.ACTION_VIEW, uri);
            signer.putExtra("type", getKey ? "get_public_key" : "sign_event");
            if (getKey) {
                JSONArray perms = new JSONArray();
                perms.put(new JSONObject().put("type", "sign_event"));
                perms.put(new JSONObject().put("type", "nip44_encrypt"));
                perms.put(new JSONObject().put("type", "nip44_decrypt"));
                signer.putExtra("permissions", perms.toString());
            } else {
                String currentUser = getIntent().getStringExtra("current_user");
                if (currentUser != null && !currentUser.isEmpty()) signer.putExtra("current_user", currentUser);
                String signerPackage = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_PACKAGE, null);
                if (signerPackage != null && !signerPackage.isEmpty()) signer.setPackage(signerPackage);
                try {
                    JSONObject event = new JSONObject(payload == null ? "{}" : payload);
                    String id = event.optString("id", "");
                    if (!id.isEmpty()) signer.putExtra("id", id);
                } catch (Exception ignored) {}
            }
            startActivityForResult(signer, REQ_SIGNER);
        } catch (Exception e) {
            storeError("Could not open Android NIP-55 signer: " + safe(e));
            finish();
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_SIGNER) return;
        try {
            JSONObject out = new JSONObject();
            out.put("type", requestType == null ? "" : requestType);
            out.put("ok", resultCode == RESULT_OK);
            if (resultCode != RESULT_OK) {
                out.put("error", "Signer activity failed or was cancelled");
            } else if (data != null) {
                boolean rejected = data.getBooleanExtra("rejected", false);
                out.put("rejected", rejected);
                String result = data.getStringExtra("result");
                String event = data.getStringExtra("event");
                String pkg = data.getStringExtra("package");
                String id = data.getStringExtra("id");
                if (result != null) out.put("result", result);
                if (event != null) out.put("event", event);
                if (id != null) out.put("id", id);
                if (ACTION_PUBLIC_KEY.equals(requestType) && pkg != null && !pkg.isEmpty()) {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_PACKAGE, pkg).apply();
                    out.put("package", pkg);
                }
            }
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_RESULT, out.toString()).apply();
        } catch (Exception e) {
            storeError(safe(e));
        }
        finish();
    }

    private void storeError(String message) {
        try {
            JSONObject out = new JSONObject().put("type", requestType == null ? "" : requestType)
                    .put("ok", false).put("error", message);
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_RESULT, out.toString()).apply();
        } catch (Exception ignored) {}
    }

    private static String safe(Throwable t) {
        String m = t == null ? null : t.getMessage();
        return m == null || m.trim().isEmpty() ? "unknown signer error" : m;
    }
}
