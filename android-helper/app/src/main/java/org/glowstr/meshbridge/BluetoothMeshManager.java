package org.glowstr.meshbridge;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.ParcelUuid;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

final class BluetoothMeshManager {
    interface Listener { void onStateChanged(); }

    static final UUID SERVICE_UUID = UUID.fromString("4d6f9b20-8a7e-4e19-9b6f-2b1b7e82a501");
    static final UUID INFO_UUID = UUID.fromString("4d6f9b21-8a7e-4e19-9b6f-2b1b7e82a501");

    private final Context context;
    private final EventStore store;
    private final Listener listener;
    private final BluetoothManager bluetoothManager;
    private final BluetoothAdapter adapter;
    private final ExecutorService io = Executors.newFixedThreadPool(12);
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);
    private final Map<String, PeerConnection> peers = new ConcurrentHashMap<>();
    private final Map<String, Long> connectCooldown = new ConcurrentHashMap<>();
    private final Map<String, BluetoothGatt> pendingGatt = new ConcurrentHashMap<>();
    private final Map<String, DeliveryState> deliveries = new ConcurrentHashMap<>();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicInteger liveSessions = new AtomicInteger(0);
    private final AtomicInteger scanEpoch = new AtomicInteger(0);
    private static final int MAX_LIVE_SESSIONS = 12;
    private static final int MAX_PENDING_GATT = 8;
    private static final int MAX_DELIVERY_STATES = 256;
    private static final long DELIVERY_STATE_TTL_MS = 10L * 60 * 1000;

    private final String nodeId;
    private BluetoothServerSocket l2capServer;
    private BluetoothGattServer gattServer;
    private BluetoothLeScanner scanner;
    private BluetoothLeAdvertiser advertiser;
    private volatile int psm = -1;
    private volatile boolean scanning = false;
    private volatile boolean advertising = false;

    BluetoothMeshManager(Context context, EventStore store, Listener listener) {
        this.context = context.getApplicationContext();
        this.store = store;
        this.listener = listener;
        this.bluetoothManager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        this.adapter = bluetoothManager == null ? null : bluetoothManager.getAdapter();
        android.content.SharedPreferences p = context.getSharedPreferences("mesh", Context.MODE_PRIVATE);
        String id = p.getString("node_id", null);
        if (!Protocol.isHex(id, 16)) {
            id = Protocol.randomNodeId();
            p.edit().putString("node_id", id).apply();
        }
        this.nodeId = id;
    }

    String getNodeId() { return nodeId; }
    int getPsm() { return psm; }
    boolean isRunning() { return running.get(); }
    boolean isScanning() { return scanning; }
    boolean isAdvertising() { return advertising; }
    int peerCount() { return peers.size(); }

    List<JSONObject> peerSnapshot() {
        List<JSONObject> out = new ArrayList<>();
        for (PeerConnection p : peers.values()) {
            try {
                out.add(new JSONObject()
                        .put("node", p.remoteNode == null ? "unknown" : p.remoteNode)
                        .put("direction", p.outgoing ? "outgoing" : "incoming")
                        .put("connected_at", p.connectedAt));
            } catch (Exception ignored) {}
        }
        return out;
    }

    synchronized void start() throws IOException {
        if (running.get()) return;
        if (adapter == null || !adapter.isEnabled()) throw new IOException("Bluetooth is unavailable or disabled");
        requirePermissions();
        running.set(true);
        try {
            startL2capServer();
            startGattServer();
            startScanning(true);
            changed();
        } catch (Exception e) {
            stop();
            if (e instanceof IOException) throw (IOException)e;
            throw new IOException(e.getMessage(), e);
        }
    }

    synchronized void stop() {
        running.set(false);
        scanEpoch.incrementAndGet();
        try { if (scanner != null && scanning && hasScanPermission()) scanner.stopScan(scanCallback); } catch (Exception ignored) {}
        scanning = false;
        try { if (advertiser != null && hasAdvertisePermission()) advertiser.stopAdvertising(advertiseCallback); } catch (Exception ignored) {}
        advertising = false;
        for (BluetoothGatt g : pendingGatt.values()) try { g.close(); } catch (Exception ignored) {}
        pendingGatt.clear();
        for (PeerConnection p : new ArrayList<>(peers.values())) p.close();
        peers.clear();
        try { if (gattServer != null) gattServer.close(); } catch (Exception ignored) {}
        gattServer = null;
        try { if (l2capServer != null) l2capServer.close(); } catch (Exception ignored) {}
        l2capServer = null;
        psm = -1;
        changed();
    }

    void destroy() {
        stop();
        io.shutdownNow();
        scheduler.shutdownNow();
    }

    int sendLocal(JSONObject event, int hops) throws Exception {
        Protocol.validatePublicEvent(event);
        int bounded = Protocol.boundedHops(hops <= 0 ? Protocol.DEFAULT_HOPS : hops);
        String eventId = event.getString("id");
        store.upsert(event, "bluetooth-local", bounded);
        ensureDeliveryState(eventId);
        int sent = 0;
        JSONObject envelope = Protocol.envelope(event, bounded);
        for (PeerConnection p : peers.values()) {
            noteAttempt(eventId, p.remoteNode);
            if (p.send(envelope)) sent++;
        }
        return sent;
    }

    JSONObject deliverySnapshot(String eventId) throws Exception {
        if (!Protocol.isHex(eventId, 64)) throw new IOException("invalid event id");
        pruneDeliveries();
        DeliveryState state = deliveries.get(eventId);
        JSONArray ackedBy = new JSONArray();
        JSONArray targeted = new JSONArray();
        if (state != null) {
            for (String node : state.acked) ackedBy.put(node);
            for (String node : state.targets) targeted.put(node);
        }
        int targetCount = state == null ? 0 : state.targets.size();
        int ackCount = state == null ? 0 : state.acked.size();
        return new JSONObject()
                .put("ok", true)
                .put("event_id", eventId)
                .put("known", state != null)
                .put("delivered", ackCount > 0)
                .put("peers_targeted", targetCount)
                .put("acks", ackCount)
                .put("pending", Math.max(0, targetCount - ackCount))
                .put("targeted_peers", targeted)
                .put("acked_by", ackedBy)
                .put("updated_at", state == null ? 0 : state.updatedAt);
    }

    private DeliveryState ensureDeliveryState(String eventId) {
        pruneDeliveries();
        DeliveryState existing = deliveries.get(eventId);
        if (existing != null) return existing;
        if (deliveries.size() >= MAX_DELIVERY_STATES) {
            String oldestKey = null;
            long oldest = Long.MAX_VALUE;
            for (Map.Entry<String, DeliveryState> e : deliveries.entrySet()) {
                if (e.getValue().updatedAt < oldest) {
                    oldest = e.getValue().updatedAt;
                    oldestKey = e.getKey();
                }
            }
            if (oldestKey != null) deliveries.remove(oldestKey);
        }
        DeliveryState created = new DeliveryState();
        DeliveryState raced = deliveries.putIfAbsent(eventId, created);
        return raced == null ? created : raced;
    }

    private void noteAttempt(String eventId, String peerNode) {
        if (!Protocol.isHex(eventId, 64) || !Protocol.isHex(peerNode, 16)) return;
        DeliveryState state = ensureDeliveryState(eventId);
        state.targets.add(peerNode);
        state.updatedAt = System.currentTimeMillis();
    }

    private void recordAck(String eventId, String peerNode) {
        if (!Protocol.isHex(eventId, 64) || !Protocol.isHex(peerNode, 16)) return;
        DeliveryState state = ensureDeliveryState(eventId);
        state.targets.add(peerNode);
        state.acked.add(peerNode);
        state.updatedAt = System.currentTimeMillis();
        changed();
    }

    private void pruneDeliveries() {
        long cutoff = System.currentTimeMillis() - DELIVERY_STATE_TTL_MS;
        for (Map.Entry<String, DeliveryState> e : new ArrayList<>(deliveries.entrySet())) {
            if (e.getValue().updatedAt < cutoff) deliveries.remove(e.getKey(), e.getValue());
        }
    }

    void restartScan() {
        if (!running.get()) return;
        try {
            if (scanner != null && scanning && hasScanPermission()) scanner.stopScan(scanCallback);
        } catch (Exception ignored) {}
        scanning = false;
        try { startScanning(true); } catch (Exception ignored) {}
        changed();
    }

    private void startL2capServer() throws IOException {
        l2capServer = adapter.listenUsingL2capChannel();
        psm = l2capServer.getPsm();
        io.execute(() -> {
            while (running.get()) {
                try {
                    BluetoothSocket socket = l2capServer.accept();
                    if (socket != null) {
                        if (liveSessions.get() >= MAX_LIVE_SESSIONS) {
                            try { socket.close(); } catch (Exception ignored) {}
                        } else {
                            new PeerConnection(socket, false).start();
                        }
                    }
                } catch (IOException e) {
                    if (running.get()) sleep(300);
                }
            }
        });
    }

    private void startGattServer() throws IOException {
        gattServer = bluetoothManager.openGattServer(context, gattServerCallback);
        if (gattServer == null) throw new IOException("Could not open BLE GATT server");
        BluetoothGattService service = new BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        BluetoothGattCharacteristic info = new BluetoothGattCharacteristic(INFO_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ,
                BluetoothGattCharacteristic.PERMISSION_READ);
        service.addCharacteristic(info);
        if (!gattServer.addService(service)) throw new IOException("Could not publish Glowstr BLE service");
    }

    private void startAdvertising() throws IOException {
        if (!running.get()) return;
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) throw new IOException("BLE advertising is not supported by this phone");
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setConnectable(true)
                .setTimeout(0)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .build();
        AdvertiseData data = new AdvertiseData.Builder()
                .addServiceUuid(new ParcelUuid(SERVICE_UUID))
                .setIncludeDeviceName(false)
                .setIncludeTxPowerLevel(false)
                .build();
        advertiser.startAdvertising(settings, data, advertiseCallback);
    }

    private void startScanning(boolean fast) {
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) return;
        final int epoch = scanEpoch.incrementAndGet();
        List<ScanFilter> filters = Collections.singletonList(new ScanFilter.Builder()
                .setServiceUuid(new ParcelUuid(SERVICE_UUID)).build());
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(fast ? ScanSettings.SCAN_MODE_LOW_LATENCY : ScanSettings.SCAN_MODE_BALANCED)
                .build();
        scanner.startScan(filters, settings, scanCallback);
        scanning = true;
        if (fast) {
            scheduler.schedule(() -> {
                if (!running.get() || scanEpoch.get() != epoch) return;
                try { if (scanner != null && scanning && hasScanPermission()) scanner.stopScan(scanCallback); } catch (Exception ignored) {}
                scanning = false;
                try { startScanning(false); } catch (Exception ignored) {}
                changed();
            }, 20, TimeUnit.SECONDS);
        }
    }

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            if (!running.get()) {
                try { if (advertiser != null && hasAdvertisePermission()) advertiser.stopAdvertising(this); } catch (Exception ignored) {}
                advertising = false;
            } else advertising = true;
            changed();
        }
        @Override public void onStartFailure(int errorCode) {
            advertising = false; changed();
        }
    };

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override public void onScanResult(int callbackType, ScanResult result) {
            if (!running.get() || result == null || result.getDevice() == null) return;
            BluetoothDevice d = result.getDevice();
            String addr;
            try { addr = d.getAddress(); } catch (SecurityException e) { return; }
            if (addr == null) return;
            long now = System.currentTimeMillis();
            long last = connectCooldown.getOrDefault(addr, 0L);
            if (now - last < 30_000 || pendingGatt.containsKey(addr) || pendingGatt.size() >= MAX_PENDING_GATT) return;
            connectCooldown.put(addr, now);
            if (connectCooldown.size() > 256) {
                long cutoff = now - 5 * 60_000L;
                for (Map.Entry<String, Long> e : new ArrayList<>(connectCooldown.entrySet())) {
                    if (e.getValue() < cutoff) connectCooldown.remove(e.getKey(), e.getValue());
                }
                if (connectCooldown.size() > 256) connectCooldown.clear();
            }
            discoverInfo(d, addr);
        }
    };

    private void discoverInfo(BluetoothDevice device, String addr) {
        try {
            final AtomicBoolean infoHandled = new AtomicBoolean(false);
            BluetoothGatt gatt = device.connectGatt(context, false, new BluetoothGattCallback() {
                @Override public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        try { g.discoverServices(); } catch (SecurityException e) { closeGatt(addr, g); }
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) closeGatt(addr, g);
                }

                @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
                    if (status != BluetoothGatt.GATT_SUCCESS) { closeGatt(addr, g); return; }
                    BluetoothGattService s = g.getService(SERVICE_UUID);
                    BluetoothGattCharacteristic c = s == null ? null : s.getCharacteristic(INFO_UUID);
                    if (c == null) { closeGatt(addr, g); return; }
                    try { if (!g.readCharacteristic(c)) closeGatt(addr, g); }
                    catch (SecurityException e) { closeGatt(addr, g); }
                }

                @SuppressWarnings("deprecation")
                @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
                    byte[] value = c == null ? null : c.getValue();
                    if (status == BluetoothGatt.GATT_SUCCESS && c != null && INFO_UUID.equals(c.getUuid()) && infoHandled.compareAndSet(false, true)) handleInfo(device, addr, value);
                    closeGatt(addr, g);
                }

                @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value, int status) {
                    if (status == BluetoothGatt.GATT_SUCCESS && c != null && INFO_UUID.equals(c.getUuid()) && infoHandled.compareAndSet(false, true)) handleInfo(device, addr, value);
                    closeGatt(addr, g);
                }
            }, BluetoothDevice.TRANSPORT_LE);
            if (gatt != null) {
                pendingGatt.put(addr, gatt);
                scheduler.schedule(() -> {
                    if (pendingGatt.get(addr) == gatt) closeGatt(addr, gatt);
                }, 12, TimeUnit.SECONDS);
            }
        } catch (SecurityException ignored) {}
    }

    private void handleInfo(BluetoothDevice device, String addr, byte[] info) {
        int remotePsm = Protocol.infoPsm(info);
        String remoteNode = Protocol.infoNodeId(info);
        if (remotePsm <= 0 || !Protocol.isHex(remoteNode, 16) || remoteNode.equals(nodeId)) return;
        if (nodeId.compareTo(remoteNode) >= 0) return; // smaller node ID owns the outgoing direction
        if (peers.containsKey(remoteNode)) return;
        io.execute(() -> {
            try {
                if (liveSessions.get() >= MAX_LIVE_SESSIONS) return;
                BluetoothSocket socket = device.createL2capChannel(remotePsm);
                socket.connect();
                new PeerConnection(socket, true).start();
            } catch (Exception ignored) {}
        });
    }

    private void closeGatt(String addr, BluetoothGatt g) {
        pendingGatt.remove(addr, g);
        try { g.disconnect(); } catch (Exception ignored) {}
        try { g.close(); } catch (Exception ignored) {}
    }

    private final BluetoothGattServerCallback gattServerCallback = new BluetoothGattServerCallback() {
        @Override public void onServiceAdded(int status, BluetoothGattService service) {
            if (!running.get() || service == null || !SERVICE_UUID.equals(service.getUuid())) return;
            if (status == BluetoothGatt.GATT_SUCCESS) {
                try { startAdvertising(); } catch (Exception ignored) { advertising = false; changed(); }
            } else {
                advertising = false;
                changed();
            }
        }

        @Override public void onCharacteristicReadRequest(BluetoothDevice device, int requestId, int offset, BluetoothGattCharacteristic characteristic) {
            if (gattServer == null) return;
            if (!INFO_UUID.equals(characteristic.getUuid())) {
                gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null);
                return;
            }
            byte[] all = Protocol.infoBytes(psm, nodeId);
            if (offset < 0 || offset > all.length) {
                gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null);
                return;
            }
            byte[] part = new byte[all.length - offset];
            System.arraycopy(all, offset, part, 0, part.length);
            try { gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, part); }
            catch (SecurityException ignored) {}
        }
    };

    private void register(PeerConnection peer) {
        if (!Protocol.isHex(peer.remoteNode, 16)) { peer.close(); return; }
        boolean preferredOutgoing = nodeId.compareTo(peer.remoteNode) < 0;
        if (peer.outgoing != preferredOutgoing) { peer.close(); return; }
        if (peers.size() >= 8 && !peers.containsKey(peer.remoteNode)) { peer.close(); return; }
        PeerConnection old = peers.put(peer.remoteNode, peer);
        if (old != null && old != peer) old.close();
        changed();
        io.execute(() -> {
            for (EventStore.Row row : store.recentForwardable(50)) {
                if (!peer.alive.get()) break;
                try {
                    if (row.hops > 0) {
                        noteAttempt(row.eventId, peer.remoteNode);
                        peer.send(Protocol.envelope(row.event, row.hops));
                    }
                    sleep(35);
                } catch (Exception ignored) {}
            }
        });
    }

    private void unregister(PeerConnection peer) {
        if (peer.remoteNode != null) peers.remove(peer.remoteNode, peer);
        changed();
    }

    private void onPeerEvent(PeerConnection from, JSONObject event, int inboundHops) throws Exception {
        Protocol.validatePublicEvent(event);
        String eventId = event.getString("id");
        int nextHops = Math.max(0, Protocol.boundedHops(inboundHops) - 1);
        int storeResult = store.upsert(event, "bluetooth-" + from.remoteNode, nextHops);

        // ACK only after the event is cryptographically valid and is either persisted
        // or already present locally. This lets the sender distinguish "written to the
        // socket" from "accepted by the other Glowstr client".
        from.send(Protocol.ack(eventId));

        if (storeResult == 0) return;
        if (nextHops > 0) {
            JSONObject env = Protocol.envelope(event, nextHops);
            for (PeerConnection p : peers.values()) if (p != from) p.send(env);
        }
        changed();
    }

    private final class PeerConnection {
        final BluetoothSocket socket;
        final boolean outgoing;
        final long connectedAt = System.currentTimeMillis();
        final AtomicBoolean alive = new AtomicBoolean(true);
        final AtomicBoolean counted = new AtomicBoolean(false);
        final Object writeLock = new Object();
        volatile String remoteNode;
        volatile BufferedOutputStream output;
        long rateWindowStart = System.currentTimeMillis();
        int rateCount = 0;
        long frameWindowStart = System.currentTimeMillis();
        int frameCount = 0;

        PeerConnection(BluetoothSocket socket, boolean outgoing) {
            this.socket = socket;
            this.outgoing = outgoing;
        }

        void start() {
            if (liveSessions.incrementAndGet() > MAX_LIVE_SESSIONS) {
                liveSessions.decrementAndGet();
                try { socket.close(); } catch (Exception ignored) {}
                return;
            }
            counted.set(true);
            io.execute(() -> {
                try {
                    output = new BufferedOutputStream(socket.getOutputStream());
                    send(Protocol.hello(nodeId));
                    scheduler.schedule(() -> { if (remoteNode == null) close(); }, 10, TimeUnit.SECONDS);
                    readLoop();
                } catch (Exception e) { close(); }
            });
        }

        boolean send(JSONObject msg) {
            if (!alive.get() || output == null) return false;
            try {
                byte[] frame = Protocol.frame(msg);
                synchronized (writeLock) {
                    output.write(frame);
                    output.flush();
                }
                return true;
            } catch (Exception e) {
                close();
                return false;
            }
        }

        void readLoop() throws Exception {
            DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream()));
            while (alive.get() && running.get()) {
                int len;
                try { len = in.readInt(); } catch (IOException e) { break; }
                if (len <= 0 || len > Protocol.MAX_FRAME_BYTES) throw new IOException("bad frame length");
                byte[] body = new byte[len];
                in.readFully(body);
                long frameNow = System.currentTimeMillis();
                if (frameNow - frameWindowStart >= 60_000) { frameWindowStart = frameNow; frameCount = 0; }
                if (++frameCount > 120) throw new IOException("peer frame rate exceeded");
                JSONObject msg = new JSONObject(new String(body, StandardCharsets.UTF_8));
                if (msg.optInt("v", -1) != Protocol.VERSION) continue;
                String type = msg.optString("t", "");
                if (remoteNode == null) {
                    if (!"hello".equals(type)) throw new IOException("hello required");
                    String remote = msg.optString("node", "");
                    if (!Protocol.isHex(remote, 16) || remote.equals(nodeId)) throw new IOException("bad peer node id");
                    remoteNode = remote;
                    register(this);
                    continue;
                }
                if ("event".equals(type)) {
                    long now = System.currentTimeMillis();
                    if (now - rateWindowStart >= 60_000) { rateWindowStart = now; rateCount = 0; }
                    if (++rateCount > 60) continue;
                    JSONObject ev = msg.optJSONObject("event");
                    int hops = msg.optInt("h", 0);
                    if (ev != null) onPeerEvent(this, ev, hops);
                } else if ("ack".equals(type)) {
                    String eventId = msg.optString("id", "");
                    if (Protocol.isHex(eventId, 64)) recordAck(eventId, remoteNode);
                }
            }
            close();
        }

        void close() {
            if (!alive.compareAndSet(true, false)) return;
            try { socket.close(); } catch (Exception ignored) {}
            if (counted.compareAndSet(true, false)) liveSessions.decrementAndGet();
            unregister(this);
        }
    }

    private static final class DeliveryState {
        final Set<String> targets = ConcurrentHashMap.newKeySet();
        final Set<String> acked = ConcurrentHashMap.newKeySet();
        volatile long updatedAt = System.currentTimeMillis();
    }

    private void requirePermissions() throws IOException {
        if (Build.VERSION.SDK_INT >= 31) {
            if (context.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED ||
                    context.checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) != PackageManager.PERMISSION_GRANTED ||
                    context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                throw new IOException("Nearby devices permission is required");
            }
        } else if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            throw new IOException("Location permission is required for Bluetooth scanning on this Android version");
        }
    }

    private boolean hasScanPermission() {
        return Build.VERSION.SDK_INT < 31 || context.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
    }
    private boolean hasAdvertisePermission() {
        return Build.VERSION.SDK_INT < 31 || context.checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED;
    }

    private void changed() { if (listener != null) listener.onStateChanged(); }
    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }
}
