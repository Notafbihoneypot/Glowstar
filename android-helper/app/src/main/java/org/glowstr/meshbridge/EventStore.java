package org.glowstr.meshbridge;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class EventStore extends SQLiteOpenHelper {
    private static final String DB_NAME = "bluetooth_mesh.db";
    private static final int DB_VERSION = 2;
    private static final int MAX_ROWS = 5000;
    private static final long MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000;
    private final Object waitLock = new Object();

    static final class Row {
        final long seq;
        final String eventId;
        final JSONObject event;
        final String source;
        final int hops;
        final long receivedAt;

        Row(long seq, String eventId, JSONObject event, String source, int hops, long receivedAt) {
            this.seq = seq;
            this.eventId = eventId;
            this.event = event;
            this.source = source;
            this.hops = hops;
            this.receivedAt = receivedAt;
        }

        JSONObject toJson() throws JSONException {
            return new JSONObject()
                    .put("seq", seq)
                    .put("event_id", eventId)
                    .put("event", event)
                    .put("source", source)
                    .put("hops", hops)
                    .put("received_at", receivedAt);
        }
    }

    EventStore(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE events (" +
                "seq INTEGER PRIMARY KEY AUTOINCREMENT," +
                "event_key TEXT NOT NULL UNIQUE," +
                "event_id TEXT NOT NULL," +
                "json TEXT NOT NULL," +
                "source TEXT NOT NULL," +
                "hops INTEGER NOT NULL," +
                "received_at INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX events_received_idx ON events(received_at)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        db.execSQL("DROP TABLE IF EXISTS events");
        onCreate(db);
    }

    // 0 = already known with same-or-better TTL, 1 = newly inserted, 2 = known event with a higher remaining TTL.
    int upsert(JSONObject event, String source, int hops) {
        String id = event.optString("id", "");
        String sig = event.optString("sig", "");
        if (!Protocol.isHex(id, 64) || !Protocol.isHex(sig, 128)) return 0;
        String eventKey = id + ":" + sig;
        int bounded = Protocol.boundedHops(hops);
        SQLiteDatabase db = getWritableDatabase();
        ContentValues v = new ContentValues();
        v.put("event_key", eventKey);
        v.put("event_id", id);
        v.put("json", event.toString());
        v.put("source", sanitizeSource(source));
        v.put("hops", bounded);
        v.put("received_at", System.currentTimeMillis());
        long row = db.insertWithOnConflict("events", null, v, SQLiteDatabase.CONFLICT_IGNORE);
        if (row != -1) {
            prune();
            synchronized (waitLock) { waitLock.notifyAll(); }
            return 1;
        }
        ContentValues higher = new ContentValues();
        higher.put("hops", bounded);
        int changed = db.update("events", higher, "event_key=? AND hops<?",
                new String[]{eventKey, String.valueOf(bounded)});
        return changed > 0 ? 2 : 0;
    }

    long latestSeq() {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COALESCE(MAX(seq),0) FROM events", null)) {
            return c.moveToFirst() ? c.getLong(0) : 0;
        }
    }

    long oldestSeq() {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COALESCE(MIN(seq),0) FROM events", null)) {
            return c.moveToFirst() ? c.getLong(0) : 0;
        }
    }

    List<Row> after(long after, int limit) {
        int n = Math.max(1, Math.min(100, limit));
        List<Row> out = new ArrayList<>();
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT seq,event_id,json,source,hops,received_at FROM events WHERE seq>? ORDER BY seq ASC LIMIT " + n,
                new String[]{String.valueOf(Math.max(0, after))})) {
            while (c.moveToNext()) {
                try {
                    out.add(new Row(c.getLong(0), c.getString(1), new JSONObject(c.getString(2)),
                            c.getString(3), c.getInt(4), c.getLong(5)));
                } catch (JSONException ignored) {}
            }
        }
        return out;
    }

    List<Row> recentForwardable(int limit) {
        int n = Math.max(1, Math.min(200, limit));
        long cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
        List<Row> out = new ArrayList<>();
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT seq,event_id,json,source,hops,received_at FROM events WHERE hops>0 AND received_at>? ORDER BY seq DESC LIMIT " + n,
                new String[]{String.valueOf(cutoff)})) {
            while (c.moveToNext()) {
                try {
                    out.add(new Row(c.getLong(0), c.getString(1), new JSONObject(c.getString(2)),
                            c.getString(3), c.getInt(4), c.getLong(5)));
                } catch (JSONException ignored) {}
            }
        }
        return out;
    }

    void waitForAfter(long after, long waitMs) {
        if (latestSeq() > after) return;
        synchronized (waitLock) {
            if (latestSeq() > after) return;
            try { waitLock.wait(Math.max(0, Math.min(25_000, waitMs))); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
    }

    private void prune() {
        SQLiteDatabase db = getWritableDatabase();
        long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
        db.delete("events", "received_at<?", new String[]{String.valueOf(cutoff)});
        db.execSQL("DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT " + MAX_ROWS + ")");
    }

    private static String sanitizeSource(String s) {
        if (s == null) return "unknown";
        s = s.replaceAll("[^a-zA-Z0-9._:-]", "");
        return s.substring(0, Math.min(64, s.length()));
    }
}
