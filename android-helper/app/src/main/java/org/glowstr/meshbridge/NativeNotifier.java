package org.glowstr.meshbridge;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

final class NativeNotifier {
    static final String CHANNEL_ACTIVITY = "glowstr_nostr_activity_v1";
    private static final String GROUP_ACTIVITY = "glowstr_nostr_activity";

    private NativeNotifier() {}

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ACTIVITY,
                "Nostr activity",
                NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Private on-device alerts for replies, mentions, likes, reposts and zaps. No cloud push service is used.");
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
    }

    static boolean canPost(Context context) {
        if (Build.VERSION.SDK_INT >= 33 &&
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        return manager != null && manager.areNotificationsEnabled();
    }

    static boolean postActivity(Context context, String type, String key) {
        ensureChannel(context);
        if (!canPost(context)) return false;

        String title;
        if ("reply".equals(type)) title = "Glowstr · New reply";
        else if ("mention".equals(type)) title = "Glowstr · New mention";
        else if ("like".equals(type)) title = "Glowstr · New reaction";
        else if ("repost".equals(type)) title = "Glowstr · New repost";
        else if ("zap".equals(type)) title = "Glowstr · New zap";
        else title = "Glowstr · New activity";

        // Intentionally generic: do not copy note text, pubkeys, DM content, relay URLs,
        // or other Nostr metadata into the Android notification surface.
        String body = "New Nostr activity is waiting in Glowstr.";

        Intent open = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int requestCode = stableId("open:" + (key == null ? type : key));
        PendingIntent pending = PendingIntent.getActivity(
                context,
                requestCode,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification publicVersion = new Notification.Builder(context, CHANNEL_ACTIVITY)
                .setSmallIcon(R.drawable.ic_mesh)
                .setContentTitle("Glowstr")
                .setContentText("New activity")
                .setLocalOnly(true)
                .setVisibility(Notification.VISIBILITY_SECRET)
                .build();

        Notification notification = new Notification.Builder(context, CHANNEL_ACTIVITY)
                .setSmallIcon(R.drawable.ic_mesh)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SOCIAL)
                .setGroup(GROUP_ACTIVITY)
                .setLocalOnly(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .build();

        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return false;
        manager.notify(stableId(key == null ? type : key), notification);
        return true;
    }

    private static int stableId(String value) {
        int hash = value == null ? 1 : value.hashCode();
        if (hash == Integer.MIN_VALUE) hash = 1;
        hash = Math.abs(hash);
        return hash == 0 ? 1 : hash;
    }
}
