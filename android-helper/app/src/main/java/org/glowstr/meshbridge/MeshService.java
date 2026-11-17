package org.glowstr.meshbridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Binder;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.List;
import java.util.Locale;

public final class MeshService extends Service implements BluetoothMeshManager.Listener {
    static final String ACTION_START = "org.glowstr.meshbridge.START";
    static final String ACTION_STOP = "org.glowstr.meshbridge.STOP";
    private static final String CHANNEL = "glowstr_mesh";
    private static final int NOTIFICATION_ID = 42051;

    private static volatile MeshService instance;
    private final IBinder binder = new LocalBinder();
    private EventStore store;
    private BluetoothMeshManager mesh;
    private volatile String lastError = "";

    public final class LocalBinder extends Binder { MeshService getService() { return MeshService.this; } }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        store = new EventStore(this);
        mesh = new BluetoothMeshManager(this, store, this);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        try {
            Notification notification = buildNotification();
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);

            if (mesh == null) throw new IllegalStateException("Bluetooth engine is unavailable");
            if (!mesh.isRunning()) mesh.start();
            lastError = "";
            updateNotification();
            return START_NOT_STICKY;
        } catch (RuntimeException | IOException e) {
            lastError = safeMessage(e);
            cleanupRuntime();
            stopForeground(true);
            stopSelf(startId);
            return START_NOT_STICKY;
        }
    }

    @Override public void onDestroy() {
        cleanupRuntime();
        if (mesh != null) mesh.destroy();
        mesh = null;
        if (store != null) {
            try { store.close(); } catch (RuntimeException ignored) {}
        }
        store = null;
        instance = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return binder; }

    @Override public void onStateChanged() { updateNotification(); }

    String lastError() { return lastError; }
    BluetoothMeshManager mesh() { return mesh; }


    JSONObject nativeRequest(String method, String target, String bodyText) {
        try {
            String m = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
            Uri uri = Uri.parse("https://app.glowstr.local" + (target == null ? "/" : target));
            String path = uri.getPath();
            if (path == null) path = "/";

            if ("GET".equals(m) && "/v1/status".equals(path)) {
                return envelope(200, snapshot());
            }
            if ("GET".equals(m) && "/v1/peers".equals(path)) {
                JSONArray peers = new JSONArray();
                if (mesh != null) for (JSONObject p : mesh.peerSnapshot()) peers.put(p);
                return envelope(200, new JSONObject().put("ok", true).put("peers", peers));
            }
            if ("POST".equals(m) && "/v1/send".equals(path)) {
                if (mesh == null || store == null || !mesh.isRunning()) {
                    return envelope(503, jsonError("Bluetooth mesh is not running"));
                }
                JSONObject body = new JSONObject(bodyText == null || bodyText.isEmpty() ? "{}" : bodyText);
                JSONObject event = body.optJSONObject("event");
                // v0.3.1 is deliberately direct-only. h=1 allows sender-side store-and-forward
                // when the paired peer reconnects, while the receiver stores h=0 and never relays it onward.
                int hops = 1;
                Protocol.validatePublicEvent(event);
                int peers = mesh.sendLocal(event, hops);
                return envelope(200, new JSONObject()
                        .put("ok", true)
                        .put("event_id", event.getString("id"))
                        .put("peers_sent", peers)
                        .put("stored", true)
                        .put("direct_only", true)
                        .put("hops", hops)
                        .put("delivery", mesh.deliverySnapshot(event.getString("id"))));
            }
            if ("GET".equals(m) && "/v1/delivery".equals(path)) {
                if (mesh == null) return envelope(503, jsonError("Bluetooth mesh is not running"));
                String eventId = uri.getQueryParameter("id");
                return envelope(200, mesh.deliverySnapshot(eventId == null ? "" : eventId));
            }
            if ("POST".equals(m) && "/v1/rescan".equals(path)) {
                if (mesh == null) return envelope(503, jsonError("Bluetooth mesh is not running"));
                mesh.restartScan();
                return envelope(200, new JSONObject().put("ok", true));
            }
            if ("GET".equals(m) && "/v1/events".equals(path)) {
                if (store == null) return envelope(503, jsonError("Event store is unavailable"));
                long after = parseLong(uri.getQueryParameter("after"), 0);
                int limit = (int)Math.max(1, Math.min(100, parseLong(uri.getQueryParameter("limit"), 50)));
                List<EventStore.Row> rows = store.after(after, limit);
                JSONArray events = new JSONArray();
                long cursor = after;
                for (EventStore.Row row : rows) {
                    events.put(row.toJson());
                    cursor = Math.max(cursor, row.seq);
                }
                return envelope(200, new JSONObject().put("ok", true).put("cursor", cursor).put("events", events));
            }
            return envelope(404, jsonError("not found"));
        } catch (Exception e) {
            return envelope(400, jsonError(safeMessage(e)));
        }
    }

    JSONObject snapshot() {
        try {
            JSONObject j = new JSONObject()
                    .put("ok", true).put("running", mesh != null && mesh.isRunning())
                    .put("peer_count", mesh == null ? 0 : mesh.peerCount())
                    .put("node_id", mesh == null ? "" : mesh.getNodeId());
            j.put("error", lastError);
            return j;
        } catch (Exception e) {
            JSONObject j = jsonError(safeMessage(e));
            try { j.put("running", false); } catch (Exception ignored) {}
            return j;
        }
    }

    static MeshService current() { return instance; }

    private static JSONObject envelope(int status, JSONObject body) {
        try { return new JSONObject().put("status", status).put("body", body); }
        catch (Exception e) { return new JSONObject(); }
    }

    private static JSONObject jsonError(String message) {
        JSONObject j = new JSONObject();
        try {
            j.put("ok", false);
            j.put("error", message == null || message.trim().isEmpty() ? "request failed" : message);
        } catch (Exception ignored) {}
        return j;
    }

    private static long parseLong(String v, long fallback) {
        try { return Long.parseLong(v); }
        catch (Exception e) { return fallback; }
    }

    private void cleanupRuntime() {
        if (mesh != null) {
            try { mesh.stop(); } catch (RuntimeException ignored) {}
        }
    }

    private static String safeMessage(Throwable t) {
        String m = t == null ? null : t.getMessage();
        return (m == null || m.trim().isEmpty()) ? "Could not start Bluetooth Direct" : m;
    }

    private Notification buildNotification() {
        int peers = mesh == null ? 0 : mesh.peerCount();
        String text = lastError.isEmpty() ? ("Bluetooth Direct · " + peers + " peer" + (peers==1?"":"s")) : lastError;
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop = new Intent(this, MeshService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 2, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = new Notification.Builder(this, CHANNEL);
        return b.setContentTitle("Glowstr")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_mesh)
                .setContentIntent(pi)
                .setOngoing(true)
                .addAction(R.drawable.ic_mesh, "Stop mesh", stopPi)
                .build();
    }

    private void updateNotification() {
        try { ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID, buildNotification()); }
        catch (Exception ignored) {}
    }

    private void createChannel() {
        NotificationChannel c = new NotificationChannel(CHANNEL, "Glowstr mesh", NotificationManager.IMPORTANCE_LOW);
        c.setDescription("Keeps Bluetooth Direct discovery and store-and-forward active");
        ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(c);
    }
}
