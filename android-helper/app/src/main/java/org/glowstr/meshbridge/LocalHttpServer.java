package org.glowstr.meshbridge;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

final class LocalHttpServer {
    static final int PORT = 8788;
    private static final int MAX_HEADERS = 16 * 1024;
    private static final int MAX_BODY = 256 * 1024;

    private final String token;
    private final EventStore store;
    private final BluetoothMeshManager mesh;
    private final ExecutorService pool = Executors.newFixedThreadPool(6);
    private final AtomicBoolean running = new AtomicBoolean(false);
    private ServerSocket server;
    private Thread acceptThread;

    LocalHttpServer(String token, EventStore store, BluetoothMeshManager mesh) {
        this.token = token;
        this.store = store;
        this.mesh = mesh;
    }

    void start() throws IOException {
        if (!running.compareAndSet(false, true)) return;
        server = new ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"));
        acceptThread = new Thread(this::acceptLoop, "glowstr-http-accept");
        acceptThread.start();
    }

    void stop() {
        running.set(false);
        try { if (server != null) server.close(); } catch (Exception ignored) {}
        pool.shutdownNow();
    }

    private void acceptLoop() {
        while (running.get()) {
            try {
                Socket s = server.accept();
                s.setSoTimeout(30_000);
                pool.execute(() -> handle(s));
            } catch (IOException e) {
                if (running.get()) sleep(100);
            }
        }
    }

    private void handle(Socket socket) {
        try (Socket s = socket;
             BufferedInputStream in = new BufferedInputStream(s.getInputStream());
             BufferedOutputStream out = new BufferedOutputStream(s.getOutputStream())) {
            Request r = readRequest(in);
            if (r == null) return;
            if ("OPTIONS".equals(r.method)) {
                write(out, 204, "", "text/plain");
                return;
            }
            if (!tokenMatches(r.headers.get("x-glowstr-token"))) {
                writeJson(out, 401, new JSONObject().put("ok", false).put("error", "pairing token required"));
                return;
            }
            route(r, out);
        } catch (Exception ignored) {}
    }

    private void route(Request r, BufferedOutputStream out) throws Exception {
        if ("GET".equals(r.method) && "/v1/status".equals(r.path)) {
            writeJson(out, 200, status());
            return;
        }
        if ("GET".equals(r.method) && "/v1/peers".equals(r.path)) {
            JSONArray a = new JSONArray();
            for (JSONObject p : mesh.peerSnapshot()) a.put(p);
            writeJson(out, 200, new JSONObject().put("ok", true).put("peers", a));
            return;
        }
        if ("POST".equals(r.method) && "/v1/send".equals(r.path)) {
            JSONObject body = new JSONObject(new String(r.body, StandardCharsets.UTF_8));
            JSONObject event = body.optJSONObject("event");
            int hops = Protocol.boundedHops(body.optInt("hops", Protocol.DEFAULT_HOPS));
            Protocol.validatePublicEvent(event);
            int peers = mesh.sendLocal(event, hops);
            writeJson(out, 200, new JSONObject()
                    .put("ok", true)
                    .put("event_id", event.getString("id"))
                    .put("peers_sent", peers)
                    .put("stored", true)
                    .put("hops", hops));
            return;
        }
        if ("POST".equals(r.method) && "/v1/rescan".equals(r.path)) {
            mesh.restartScan();
            writeJson(out, 200, new JSONObject().put("ok", true));
            return;
        }
        if ("GET".equals(r.method) && "/v1/events".equals(r.path)) {
            long after = parseLong(r.query.get("after"), 0);
            int limit = (int)Math.max(1, Math.min(100, parseLong(r.query.get("limit"), 50)));
            long wait = Math.max(0, Math.min(25_000, parseLong(r.query.get("wait"), 0)));
            if (wait > 0) store.waitForAfter(after, wait);
            List<EventStore.Row> rows = store.after(after, limit);
            JSONArray a = new JSONArray();
            long cursor = after;
            for (EventStore.Row row : rows) {
                a.put(row.toJson());
                cursor = Math.max(cursor, row.seq);
            }
            writeJson(out, 200, new JSONObject().put("ok", true).put("cursor", cursor).put("events", a));
            return;
        }
        writeJson(out, 404, new JSONObject().put("ok", false).put("error", "not found"));
    }

    JSONObject status() throws Exception {
        JSONArray peers = new JSONArray();
        for (JSONObject p : mesh.peerSnapshot()) peers.put(p);
        return new JSONObject()
                .put("ok", true)
                .put("version", 1)
                .put("transport", "bluetooth-direct")
                .put("node_id", mesh.getNodeId())
                .put("running", mesh.isRunning())
                .put("scanning", mesh.isScanning())
                .put("advertising", mesh.isAdvertising())
                .put("psm", mesh.getPsm())
                .put("peer_count", mesh.peerCount())
                .put("peers", peers)
                .put("oldest_cursor", store.oldestSeq())
                .put("latest_cursor", store.latestSeq());
    }

    private Request readRequest(BufferedInputStream in) throws IOException {
        byte[] headerBytes = readUntilHeaders(in);
        if (headerBytes == null) return null;
        String head = new String(headerBytes, StandardCharsets.ISO_8859_1);
        String[] lines = head.split("\\r\\n");
        if (lines.length == 0) return null;
        String[] start = lines[0].split(" ");
        if (start.length < 2) return null;
        String method = start[0].toUpperCase(Locale.ROOT);
        if (!("GET".equals(method) || "POST".equals(method) || "OPTIONS".equals(method))) return null;
        String target = start[1];
        Map<String,String> headers = new HashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c <= 0) continue;
            headers.put(lines[i].substring(0,c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c+1).trim());
        }
        int contentLength = 0;
        try { contentLength = Integer.parseInt(headers.getOrDefault("content-length", "0")); } catch (Exception ignored) {}
        if (contentLength < 0 || contentLength > MAX_BODY) throw new IOException("body too large");
        if ("chunked".equalsIgnoreCase(headers.get("transfer-encoding"))) throw new IOException("chunked unsupported");
        byte[] body = new byte[contentLength];
        int off = 0;
        while (off < body.length) {
            int n = in.read(body, off, body.length - off);
            if (n < 0) throw new EOFException();
            off += n;
        }
        String path = target;
        Map<String,String> query = new HashMap<>();
        int q = target.indexOf('?');
        if (q >= 0) {
            path = target.substring(0,q);
            String qs = target.substring(q+1);
            for (String pair : qs.split("&")) {
                if (pair.isEmpty()) continue;
                int eq = pair.indexOf('=');
                String k = eq < 0 ? pair : pair.substring(0,eq);
                String v = eq < 0 ? "" : pair.substring(eq+1);
                query.put(URLDecoder.decode(k, StandardCharsets.UTF_8.name()), URLDecoder.decode(v, StandardCharsets.UTF_8.name()));
            }
        }
        return new Request(method, path, query, headers, body);
    }

    private byte[] readUntilHeaders(BufferedInputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int a=-1,c=-1,d=-1,x;
        while ((x=in.read()) != -1) {
            b.write(x);
            if (b.size() > MAX_HEADERS) throw new IOException("headers too large");
            if (a=='\r' && c=='\n' && d=='\r' && x=='\n') {
                byte[] all = b.toByteArray();
                byte[] head = new byte[all.length-4];
                System.arraycopy(all,0,head,0,head.length);
                return head;
            }
            a=c; c=d; d=x;
        }
        return null;
    }

    private boolean tokenMatches(String supplied) {
        if (supplied == null) return false;
        return MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), supplied.getBytes(StandardCharsets.UTF_8));
    }

    private void writeJson(BufferedOutputStream out, int code, JSONObject json) throws IOException {
        write(out, code, json.toString(), "application/json; charset=utf-8");
    }

    private void write(BufferedOutputStream out, int code, String body, String type) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String reason = code==200?"OK":code==204?"No Content":code==401?"Unauthorized":code==404?"Not Found":"Error";
        String h = "HTTP/1.1 "+code+" "+reason+"\r\n"+
                "Content-Type: "+type+"\r\n"+
                "Content-Length: "+bytes.length+"\r\n"+
                "Access-Control-Allow-Origin: *\r\n"+
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"+
                "Access-Control-Allow-Headers: Content-Type, X-Glowstr-Token\r\n"+
                "Access-Control-Allow-Private-Network: true\r\n"+
                "Vary: Origin, Access-Control-Request-Private-Network\r\n"+
                "Access-Control-Max-Age: 600\r\n"+
                "Cache-Control: no-store\r\n"+
                "X-Content-Type-Options: nosniff\r\n"+
                "Connection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.ISO_8859_1));
        out.write(bytes);
        out.flush();
    }

    private static long parseLong(String v, long fallback) { try { return Long.parseLong(v); } catch (Exception e) { return fallback; } }
    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }

    private static final class Request {
        final String method, path;
        final Map<String,String> query, headers;
        final byte[] body;
        Request(String method, String path, Map<String,String> query, Map<String,String> headers, byte[] body) {
            this.method=method; this.path=path; this.query=query; this.headers=headers; this.body=body;
        }
    }
}
