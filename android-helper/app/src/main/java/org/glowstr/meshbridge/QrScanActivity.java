package org.glowstr.meshbridge;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import org.json.JSONObject;

import java.util.Collections;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Thin proxy around JourneyApps ZXing Android Embedded.
 *
 * Camera lifecycle, preview scaling, autofocus, permissions, orientation and
 * continuous frame decoding are delegated to the mature scanner library.
 * Glowstr only receives the decoded QR text and stores it for the WebView bridge.
 */
public final class QrScanActivity extends Activity {
    static final String PREFS = "nostr_qr";
    static final String KEY_RESULT = "scan_result";

    private final AtomicBoolean finished = new AtomicBoolean(false);
    private boolean launched = false;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_RESULT).apply();

        if (state != null) launched = state.getBoolean("launched", false);
        if (!launched) launchScanner();
    }

    @Override protected void onSaveInstanceState(Bundle outState) {
        outState.putBoolean("launched", launched);
        super.onSaveInstanceState(outState);
    }

    private void launchScanner() {
        if (launched || finished.get()) return;
        launched = true;

        try {
            IntentIntegrator integrator = new IntentIntegrator(this);
            integrator.setDesiredBarcodeFormats(
                    Collections.singletonList(IntentIntegrator.QR_CODE));
            integrator.setPrompt("Center the Nostr QR inside the frame");
            integrator.setBeepEnabled(false);
            integrator.setBarcodeImageEnabled(false);
            integrator.setOrientationLocked(true);
            integrator.setCameraId(0);
            integrator.initiateScan();
        } catch (RuntimeException e) {
            finishError("Could not open QR scanner");
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        IntentResult result = IntentIntegrator.parseActivityResult(
                requestCode, resultCode, data);

        if (result == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }

        String contents = result.getContents();
        if (contents == null) {
            finishCancelled();
            return;
        }

        String text = contents.trim();
        if (text.isEmpty()) {
            finishError("QR code was empty");
            return;
        }
        if (text.length() > 2048) {
            finishError("QR code is too large");
            return;
        }

        finishSuccess(text);
    }

    @Override public void onBackPressed() {
        finishCancelled();
    }

    private void finishSuccess(String text) {
        if (!finished.compareAndSet(false, true)) return;
        writeResultString("{\"ok\":true,\"text\":" + JSONObject.quote(text) + "}");
        finish();
    }

    private void finishError(String message) {
        if (!finished.compareAndSet(false, true)) return;
        writeResultString("{\"ok\":false,\"error\":" + JSONObject.quote(message) + "}");
        finish();
    }

    private void finishCancelled() {
        if (!finished.compareAndSet(false, true)) return;
        writeResultString("{\"ok\":false,\"cancelled\":true}");
        finish();
    }

    private void writeResultString(String json) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_RESULT, json).apply();
    }
}
