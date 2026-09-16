package org.glowstr.meshbridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.IOException;

public final class MeshService extends Service implements BluetoothMeshManager.Listener {
    static final String ACTION_START = "org.glowstr.meshbridge.START";
    static final String ACTION_STOP = "org.glowstr.meshbridge.STOP";
    private static final String CHANNEL = "glowstr_mesh";
    private static final int NOTIFICATION_ID = 42051;

    private static volatile MeshService instance;
    private final IBinder binder = new LocalBinder();
    private EventStore store;
    private BluetoothMeshManager mesh;
    private LocalHttpServer http;
    private String token;
    private volatile String lastError = "";

    public final class LocalBinder extends Binder { MeshService getService() { return MeshService.this; } }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        store = new EventStore(this);
        android.content.SharedPreferences p = getSharedPreferences("mesh", Context.MODE_PRIVATE);
        token = p.getString("pairing_token", null);
        if (token == null || token.length() < 32) {
            token = Protocol.randomToken();
            p.edit().putString("pairing_token", token).apply();
        }
        mesh = new BluetoothMeshManager(this, store, this);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, buildNotification());
        }
        try {
            if (!mesh.isRunning()) mesh.start();
            if (http == null) {
                http = new LocalHttpServer(token, store, mesh);
                http.start();
            }
            lastError = "";
        } catch (Exception e) {
            lastError = e.getMessage() == null ? "Could not start Bluetooth Direct" : e.getMessage();
            updateNotification();
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        if (http != null) http.stop();
        http = null;
        if (mesh != null) mesh.destroy();
        if (store != null) store.close();
        instance = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return binder; }

    @Override public void onStateChanged() { updateNotification(); }

    String pairingToken() { return token; }
    String lastError() { return lastError; }
    BluetoothMeshManager mesh() { return mesh; }

    String rotateToken() {
        token = Protocol.randomToken();
        getSharedPreferences("mesh", Context.MODE_PRIVATE).edit().putString("pairing_token", token).apply();
        if (http != null) {
            http.stop();
            try {
                http = new LocalHttpServer(token, store, mesh);
                http.start();
                lastError = "";
            } catch (IOException e) { lastError = e.getMessage(); }
        }
        return token;
    }

    JSONObject snapshot() {
        try {
            JSONObject j = http != null ? http.status() : new JSONObject()
                    .put("ok", true).put("running", mesh != null && mesh.isRunning())
                    .put("peer_count", mesh == null ? 0 : mesh.peerCount())
                    .put("node_id", mesh == null ? "" : mesh.getNodeId());
            j.put("http", http != null).put("port", LocalHttpServer.PORT).put("error", lastError);
            return j;
        } catch (Exception e) { return new JSONObject(); }
    }

    static MeshService current() { return instance; }

    private Notification buildNotification() {
        int peers = mesh == null ? 0 : mesh.peerCount();
        String text = lastError.isEmpty() ? ("Bluetooth Direct · " + peers + " peer" + (peers==1?"":"s")) : lastError;
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop = new Intent(this, MeshService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 2, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return b.setContentTitle("Glowstr Bluetooth Direct")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_mesh)
                .setContentIntent(pi)
                .setOngoing(true)
                .addAction(R.drawable.ic_mesh, "Stop", stopPi)
                .build();
    }

    private void updateNotification() {
        try { ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID, buildNotification()); }
        catch (Exception ignored) {}
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel c = new NotificationChannel(CHANNEL, "Glowstr mesh", NotificationManager.IMPORTANCE_LOW);
            c.setDescription("Keeps Bluetooth Direct discovery and store-and-forward active");
            ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(c);
        }
    }
}
