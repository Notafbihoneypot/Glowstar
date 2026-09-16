package org.glowstr.meshbridge;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public final class MainActivity extends Activity {
    private static final int REQ_BT = 420;
    private static final int REQ_ENABLE = 421;
    private static final String APP_ORIGIN = "https://app.glowstr.local/";
    private static final String APP_HOST = "app.glowstr.local";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private boolean pendingStart;

    private static final String NATIVE_BOOTSTRAP = """
            <script>
            (() => {
              const helper = 'http://127.0.0.1:8788';
              const originalFetch = window.fetch.bind(window);
              window.__GLOWSTR_ANDROID_NATIVE__ = true;
              window.__glowstrOriginalFetch = originalFetch;
              window.fetch = function(input, init = {}) {
                const url = typeof input === 'string' ? input : String(input?.url || '');
                if (!url.startsWith(helper)) return originalFetch(input, init);
                const method = String(init.method || input?.method || 'GET').toUpperCase();
                const path = url.slice(helper.length) || '/';
                const body = typeof init.body === 'string' ? init.body : '';
                try {
                  const raw = window.GlowstrAndroid.request(method, path, body);
                  const envelope = JSON.parse(raw || '{}');
                  const status = Number(envelope.status) || 500;
                  const responseBody = envelope.body || {ok:false,error:'empty Android bridge response'};
                  const buildResponse = () => new Response(JSON.stringify(responseBody), {
                    status,
                    headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}
                  });
                  if (path.startsWith('/v1/events') && Array.isArray(responseBody.events) && responseBody.events.length === 0) {
                    return new Promise(resolve => setTimeout(() => resolve(buildResponse()), 750));
                  }
                  return Promise.resolve(buildResponse());
                } catch (error) {
                  return Promise.reject(new TypeError('Glowstr Android bridge: ' + String(error?.message || error)));
                }
              };
            })();
            </script>
            """;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);
        configureWebView();
        loadBundledGlowstr();
        handler.postDelayed(() -> ensureBluetooth(true), 300);
    }

    @Override protected void onResume() {
        super.onResume();
        if (hasBluetoothPermissions() && isBluetoothEnabled()) startBridge();
    }

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (webView != null) {
            webView.removeJavascriptInterface("GlowstrAndroid");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(true);

        webView.addJavascriptInterface(new AndroidBridge(this), "GlowstrAndroid");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request.getUrl());
            }

            @Override @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(Uri.parse(url));
            }

            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectNativeUiState();
                autoConnectNative();
            }
        });
    }

    private boolean handleNavigation(Uri uri) {
        if (uri == null) return true;
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if ("https".equalsIgnoreCase(scheme) && APP_HOST.equalsIgnoreCase(host)) return false;
        if ("about".equalsIgnoreCase(scheme) || "data".equalsIgnoreCase(scheme) || "blob".equalsIgnoreCase(scheme)) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (RuntimeException e) {
            toast("No app can open this link");
        }
        return true;
    }

    private void loadBundledGlowstr() {
        try (InputStream in = getAssets().open("glowstr.html")) {
            String html = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            int head = html.toLowerCase().indexOf("<head>");
            if (head >= 0) html = html.substring(0, head + 6) + NATIVE_BOOTSTRAP + html.substring(head + 6);
            else html = NATIVE_BOOTSTRAP + html;
            webView.loadDataWithBaseURL(APP_ORIGIN, html, "text/html", "UTF-8", APP_ORIGIN);
        } catch (Exception e) {
            String message = safeMessage(e).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
            webView.loadDataWithBaseURL(APP_ORIGIN,
                    "<html><body style='background:#06060f;color:#fff;font-family:monospace;padding:24px'><h2>Glowstr failed to load</h2><p>" + message + "</p></body></html>",
                    "text/html", "UTF-8", APP_ORIGIN);
        }
    }

    private void injectNativeUiState() {
        if (webView == null) return;
        webView.evaluateJavascript("""
                (() => {
                  try {
                    const token = GlowstrAndroid.pairingToken();
                    sessionStorage.setItem('glowstr_bluetooth_token', token);
                    const input = document.getElementById('mesh-bluetooth-token');
                    if (input) { input.value = token; input.style.display = 'none'; }
                    const connect = document.getElementById('mesh-bluetooth-connect');
                    if (connect) connect.style.display = 'none';
                    const disconnect = document.getElementById('mesh-bluetooth-disconnect');
                    if (disconnect) disconnect.style.display = 'none';
                    const card = document.getElementById('mesh-bluetooth-card');
                    if (card) {
                      const title = card.querySelector('.mesh-card-title');
                      if (title) title.textContent = '📱 ANDROID BLUETOOTH MESH // PHONE ↔ PHONE';
                      const desc = card.querySelector('.mesh-card-desc');
                      if (desc) desc.textContent = 'Native Android Bluetooth mesh. No browser, localhost permission, or pairing-token copy/paste is required.';
                      const helps = card.querySelectorAll('.mesh-help');
                      if (helps.length) helps[helps.length - 1].textContent = 'Integrated Android transport · direct BLE/L2CAP · store-and-forward stays on this phone.';
                    }
                  } catch (e) { console.warn('Glowstr native UI setup failed', e); }
                })();
                """, null);
    }

    private void autoConnectNative() {
        if (webView == null) return;
        webView.evaluateJavascript("""
                (() => {
                  if (!window.__GLOWSTR_ANDROID_NATIVE__) return;
                  let tries = 0;
                  const attempt = async () => {
                    tries++;
                    try {
                      const env = JSON.parse(GlowstrAndroid.request('GET','/v1/status',''));
                      if (env.status === 200 && env.body && env.body.running && typeof glowstrConnectBluetoothDirect === 'function') {
                        const ok = await glowstrConnectBluetoothDirect();
                        if (ok) return;
                      }
                    } catch (e) {}
                    if (tries < 30) setTimeout(attempt, 1000);
                  };
                  attempt();
                })();
                """, null);
    }

    private void ensureBluetooth(boolean requestIfMissing) {
        pendingStart = true;
        if (!hasBluetoothPermissions()) {
            if (requestIfMissing) requestBluetoothPermissions();
            return;
        }
        BluetoothAdapter adapter = bluetoothAdapter();
        if (adapter == null) {
            pendingStart = false;
            toast("This phone does not support Bluetooth");
            return;
        }
        if (!adapter.isEnabled()) {
            try { startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQ_ENABLE); }
            catch (RuntimeException e) { toast("Enable Bluetooth in Android settings"); }
            return;
        }
        startBridge();
    }

    private void startBridge() {
        pendingStart = false;
        Intent i = new Intent(this, MeshService.class).setAction(MeshService.ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
            handler.postDelayed(this::autoConnectNative, 800);
        } catch (RuntimeException e) {
            toast("Bluetooth mesh could not start: " + safeMessage(e));
        }
    }

    private BluetoothAdapter bluetoothAdapter() {
        BluetoothManager bm = (BluetoothManager)getSystemService(Context.BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }

    private boolean isBluetoothEnabled() {
        try {
            BluetoothAdapter a = bluetoothAdapter();
            return a != null && a.isEnabled();
        } catch (SecurityException e) {
            return false;
        }
    }

    private boolean hasBluetoothPermissions() {
        if (Build.VERSION.SDK_INT >= 31) {
            return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
                    checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED &&
                    checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestBluetoothPermissions() {
        List<String> p = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            p.add(Manifest.permission.BLUETOOTH_SCAN);
            p.add(Manifest.permission.BLUETOOTH_ADVERTISE);
            p.add(Manifest.permission.BLUETOOTH_CONNECT);
        } else {
            p.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            p.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        requestPermissions(p.toArray(new String[0]), REQ_BT);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_BT && pendingStart) {
            if (hasBluetoothPermissions()) ensureBluetooth(false);
            else {
                pendingStart = false;
                toast("Nearby devices permission is required for Bluetooth mesh");
            }
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_ENABLE && pendingStart) {
            if (resultCode == RESULT_OK) startBridge();
            else {
                pendingStart = false;
                toast("Bluetooth must be enabled for offline mesh");
            }
        }
    }

    private static String safeMessage(Throwable t) {
        String m = t == null ? null : t.getMessage();
        return (m == null || m.trim().isEmpty()) ? "Android rejected the request" : m;
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }
}
