package org.glowstr.meshbridge;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

final class MeshDiagnostics {
    private static final String TAG = "GlowstrMeshDiag";
    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static boolean started;

    static synchronized void start(Context context) {
        if (started) return;
        started = true;
        Context app = context.getApplicationContext();
        final int[] count = {0};
        Runnable r = new Runnable() {
            @Override public void run() {
                try { Log.i(TAG, snapshot(app).toString()); }
                catch (Exception e) { Log.w(TAG, "diagnostic snapshot failed: " + safe(e)); }
                count[0]++;
                if (count[0] < 20) handler.postDelayed(this, 2000);
            }
        };
        handler.post(r);
    }

    static JSONObject snapshot(Context context) {
        JSONObject j = new JSONObject();
        try {
            boolean scan = Build.VERSION.SDK_INT < 31 || context.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
            boolean advertise = Build.VERSION.SDK_INT < 31 || context.checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED;
            boolean connect = Build.VERSION.SDK_INT < 31 || context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
            j.put("perm_scan", scan).put("perm_advertise", advertise).put("perm_connect", connect);

            BluetoothManager bm = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = bm == null ? null : bm.getAdapter();
            boolean enabled = false;
            try { enabled = adapter != null && adapter.isEnabled(); } catch (SecurityException ignored) {}
            j.put("bluetooth_enabled", enabled);

            MeshService service = MeshService.current();
            j.put("service_alive", service != null);
            if (service != null) {
                BluetoothMeshManager mesh = service.mesh();
                j.put("service_error", service.lastError());
                j.put("mesh_present", mesh != null);
                if (mesh != null) {
                    j.put("running", mesh.isRunning());
                    j.put("scanning", mesh.isScanning());
                    j.put("advertising", mesh.isAdvertising());
                    j.put("psm", mesh.getPsm());
                    j.put("peers", mesh.peerCount());
                }
            }
        } catch (Exception e) {
            try { j.put("diag_error", safe(e)); } catch (Exception ignored) {}
        }
        return j;
    }

    private static String safe(Throwable t) {
        String m = t == null ? null : t.getMessage();
        return m == null || m.trim().isEmpty() ? t.getClass().getSimpleName() : m;
    }
}
