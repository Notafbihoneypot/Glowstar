package org.glowstr.meshbridge;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public final class MainActivity extends Activity {
    private static final int REQ_BT = 420;
    private static final int REQ_ENABLE = 421;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView status, tokenView, details;
    private Button startButton, stopButton;
    private boolean pendingStart = false;

    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            updateUi();
            handler.postDelayed(this, 1000);
        }
    };

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildUi());
    }

    @Override protected void onResume() {
        super.onResume();
        handler.removeCallbacks(refresh);
        handler.post(refresh);
    }

    @Override protected void onPause() {
        handler.removeCallbacks(refresh);
        super.onPause();
    }

    private View buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(6,6,15));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(24), dp(18), dp(24));
        scroll.addView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = text("GLOWSTR // BLUETOOTH DIRECT", 22, 0xffff6600);
        title.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(title);
        TextView sub = text("Phone ↔ phone offline Nostr transport", 14, 0xffb7adc9);
        sub.setGravity(Gravity.CENTER_HORIZONTAL);
        sub.setPadding(0, dp(6), 0, dp(20));
        root.addView(sub);

        status = text("STOPPED", 16, 0xffffb000);
        status.setPadding(dp(12), dp(12), dp(12), dp(12));
        status.setBackgroundColor(0xff121222);
        root.addView(status, match());

        startButton = button("START BLUETOOTH DIRECT");
        startButton.setOnClickListener(v -> beginStart());
        root.addView(startButton, matchTop(12));
        stopButton = button("STOP");
        stopButton.setOnClickListener(v -> stopBridge());
        root.addView(stopButton, matchTop(8));

        TextView pairTitle = text("PAIR GLOWSTR PWA", 15, 0xff00d8ff);
        pairTitle.setPadding(0, dp(24), 0, dp(8));
        root.addView(pairTitle);
        TextView explain = text("In Glowstr: RELAYS → LOCAL MESH → BLUETOOTH DIRECT. Paste this token. It stays on this phone and can be rotated at any time.", 13, 0xffb7adc9);
        root.addView(explain);

        tokenView = text(readToken(), 13, 0xff7dffb2);
        tokenView.setTextIsSelectable(true);
        tokenView.setPadding(dp(10), dp(12), dp(10), dp(12));
        tokenView.setBackgroundColor(0xff0d0d1a);
        root.addView(tokenView, matchTop(8));

        LinearLayout tokenButtons = new LinearLayout(this);
        tokenButtons.setOrientation(LinearLayout.HORIZONTAL);
        Button copy = button("COPY TOKEN");
        copy.setOnClickListener(v -> copyToken());
        Button rotate = button("ROTATE");
        rotate.setOnClickListener(v -> confirmRotate());
        tokenButtons.addView(copy, weight());
        tokenButtons.addView(rotate, weightLeft(8));
        root.addView(tokenButtons, matchTop(8));

        TextView endpoint = text("Local API: http://127.0.0.1:8788\nOnly loopback connections are accepted.", 12, 0xff8f86a3);
        endpoint.setPadding(0, dp(10), 0, 0);
        root.addView(endpoint);

        TextView secTitle = text("SECURITY MODEL", 15, 0xff00d8ff);
        secTitle.setPadding(0, dp(24), 0, dp(8));
        root.addView(secTitle);
        root.addView(text("• Public Nostr kind-1 notes only\n• No nsec or signer secret enters this app\n• Secure authenticated BLE L2CAP\n• Event-ID dedup + hop limit + peer rate limit\n• 7-day / 5,000-event bounded store\n• Helper verifies NIP-01 ID + BIP-340 before caching\n• Glowstr verifies the event again before display", 13, 0xffb7adc9));

        details = text("", 12, 0xff8f86a3);
        details.setPadding(0, dp(20), 0, 0);
        root.addView(details);

        Button settings = button("OPEN BLUETOOTH SETTINGS");
        settings.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)));
        root.addView(settings, matchTop(20));
        return scroll;
    }

    private void beginStart() {
        pendingStart = true;
        if (!hasPermissions()) {
            requestBluetoothPermissions();
            return;
        }
        BluetoothManager bm = (BluetoothManager)getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter a = bm == null ? null : bm.getAdapter();
        if (a == null) { toast("This phone does not support Bluetooth"); pendingStart=false; return; }
        if (!a.isEnabled()) {
            Intent i = new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE);
            startActivityForResult(i, REQ_ENABLE);
            return;
        }
        startBridge();
    }

    private void startBridge() {
        pendingStart = false;
        Intent i = new Intent(this, MeshService.class).setAction(MeshService.ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
            toast("Starting Bluetooth Direct…");
        } catch (RuntimeException e) {
            toast("Could not start Bluetooth Direct: " + safeMessage(e));
            updateUi();
        }
    }

    private void stopBridge() {
        try {
            stopService(new Intent(this, MeshService.class));
            toast("Bluetooth Direct stopped");
        } catch (RuntimeException e) {
            toast("Could not stop Bluetooth Direct: " + safeMessage(e));
        }
    }

    private boolean hasPermissions() {
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
        } else p.add(Manifest.permission.ACCESS_FINE_LOCATION);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            p.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        requestPermissions(p.toArray(new String[0]), REQ_BT);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_BT && pendingStart) {
            if (hasPermissions()) beginStart();
            else { pendingStart=false; toast("Nearby devices permission is required"); }
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_ENABLE && pendingStart) {
            if (resultCode == RESULT_OK) startBridge();
            else { pendingStart=false; toast("Bluetooth must be enabled"); }
        }
    }

    private void updateUi() {
        MeshService s = MeshService.current();
        JSONObject snap = s == null ? null : s.snapshot();
        boolean running = snap != null && snap.optBoolean("running", false);
        int peers = snap == null ? 0 : snap.optInt("peer_count", 0);
        String err = snap == null ? "" : snap.optString("error", "");
        if (!err.isEmpty()) {
            status.setText("ERROR · " + err);
            status.setTextColor(0xffff5577);
        } else if (running) {
            status.setText("RUNNING · " + peers + " PEER" + (peers==1?"":"S"));
            status.setTextColor(0xff7dffb2);
        } else {
            status.setText("STOPPED");
            status.setTextColor(0xffffb000);
        }
        startButton.setEnabled(!running);
        stopButton.setEnabled(running);
        tokenView.setText(s == null ? readToken() : s.pairingToken());
        if (snap != null) {
            details.setText("Node: " + snap.optString("node_id", "—") +
                    "\nAdvertising: " + snap.optBoolean("advertising", false) +
                    " · Scanning: " + snap.optBoolean("scanning", false) +
                    "\nL2CAP PSM: " + snap.optInt("psm", -1) +
                    "\nLocal API: " + (snap.optBoolean("http", false) ? "ready" : "stopped"));
        } else details.setText("Start the helper to advertise, scan and accept secure L2CAP peers.");
    }

    private String readToken() {
        android.content.SharedPreferences p = getSharedPreferences("mesh", Context.MODE_PRIVATE);
        String t = p.getString("pairing_token", null);
        if (t == null || t.length() < 32) {
            t = Protocol.randomToken();
            p.edit().putString("pairing_token", t).apply();
        }
        return t;
    }

    private void copyToken() {
        String t = MeshService.current() == null ? readToken() : MeshService.current().pairingToken();
        ((ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Glowstr pairing token", t));
        toast("Pairing token copied");
    }

    private void confirmRotate() {
        new AlertDialog.Builder(this)
                .setTitle("Rotate pairing token?")
                .setMessage("Glowstr will need the new token. Existing browser sessions will stop working.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Rotate", (d,w) -> {
                    MeshService s = MeshService.current();
                    String t;
                    if (s != null) t = s.rotateToken();
                    else {
                        t = Protocol.randomToken();
                        getSharedPreferences("mesh", Context.MODE_PRIVATE).edit().putString("pairing_token", t).apply();
                    }
                    tokenView.setText(t);
                    toast("Pairing token rotated");
                }).show();
    }

    private TextView text(String s, int sp, long color) {
        TextView t = new TextView(this); t.setText(s); t.setTextSize(sp); t.setTextColor((int)color); t.setLineSpacing(0,1.15f); return t;
    }
    private Button button(String s) { Button b=new Button(this); b.setText(s); b.setAllCaps(false); return b; }
    private LinearLayout.LayoutParams match() { return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT); }
    private LinearLayout.LayoutParams matchTop(int top) { LinearLayout.LayoutParams p=match(); p.topMargin=dp(top); return p; }
    private LinearLayout.LayoutParams weight() { return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT,1f); }
    private LinearLayout.LayoutParams weightLeft(int left) { LinearLayout.LayoutParams p=weight(); p.leftMargin=dp(left); return p; }
    private int dp(int x) { return Math.round(x * getResources().getDisplayMetrics().density); }
    private static String safeMessage(Throwable t) {
        String m = t == null ? null : t.getMessage();
        return (m == null || m.trim().isEmpty()) ? "Android rejected the request" : m;
    }
    private void toast(String s) { Toast.makeText(this,s,Toast.LENGTH_SHORT).show(); }
}
