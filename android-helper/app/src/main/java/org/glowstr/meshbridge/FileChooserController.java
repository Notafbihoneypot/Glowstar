package org.glowstr.meshbridge;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.net.Uri;
import android.os.Process;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient.FileChooserParams;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Locale;

/** Single outstanding, read-only document selection for the bundled WebView. */
final class FileChooserController {
    static final int REQUEST_CODE = 422;
    private final Activity activity;
    private ValueCallback<Uri[]> pending;
    private boolean multiple;
    private boolean closed;

    FileChooserController(Activity activity) { this.activity = activity; }

    boolean open(ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (closed || pending != null || params == null ||
                (params.getMode() != FileChooserParams.MODE_OPEN &&
                 params.getMode() != FileChooserParams.MODE_OPEN_MULTIPLE)) {
            callback.onReceiveValue(null);
            return true;
        }
        pending = callback;
        multiple = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        String[] types = acceptTypes(params.getAcceptTypes());
        intent.setType(types.length == 1 ? types[0] : "*/*");
        if (types.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
        try {
            activity.startActivityForResult(intent, REQUEST_CODE);
        } catch (RuntimeException e) {
            finish(null);
            Toast.makeText(activity, "Android could not open a file picker", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_CODE) return false;
        if (pending == null) return true;
        if (resultCode != Activity.RESULT_OK || data == null) {
            finish(null);
            return true;
        }
        // Ignore any Intent supplied by a picker. Only use selected, granted URIs.
        LinkedHashSet<Uri> selected = new LinkedHashSet<>();
        ClipData clips = data.getClipData();
        if (clips != null) {
            int limit = Math.min(clips.getItemCount(), multiple ? 16 : 1);
            for (int i = 0; i < limit; i++) selected.add(clips.getItemAt(i).getUri());
        } else if (data.getData() != null) selected.add(data.getData());
        ArrayList<Uri> readable = new ArrayList<>();
        for (Uri uri : selected) if (isGrantedDocument(uri)) readable.add(uri);
        finish(readable.isEmpty() ? null : readable.toArray(new Uri[0]));
        return true;
    }

    private boolean isGrantedDocument(Uri uri) {
        if (uri == null || !"content".equals(uri.getScheme()) ||
                uri.getAuthority() == null || uri.getAuthority().isEmpty()) return false;
        ProviderInfo provider = activity.getPackageManager().resolveContentProvider(uri.getAuthority(), 0);
        if (provider != null && provider.applicationInfo != null &&
                provider.applicationInfo.uid == activity.getApplicationInfo().uid) return false;
        return activity.checkUriPermission(uri, Process.myPid(), Process.myUid(),
                Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    void close() { closed = true; finish(null); }

    private void finish(Uri[] result) {
        ValueCallback<Uri[]> callback = pending;
        pending = null;
        if (callback != null) callback.onReceiveValue(result);
    }

    private static String[] acceptTypes(String[] raw) {
        LinkedHashSet<String> types = new LinkedHashSet<>();
        if (raw != null) for (String group : raw) {
            if (group == null) continue;
            for (String value : group.split(",")) {
                String type = value.trim().toLowerCase(Locale.ROOT);
                if (type.startsWith(".")) {
                    type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(type.substring(1));
                }
                if (type != null && type.matches("[a-z0-9!#$&^_.+-]+/(?:[a-z0-9!#$&^_.+-]+|\\*)")) types.add(type);
                if (types.size() >= 16) return types.toArray(new String[0]);
            }
        }
        return types.toArray(new String[0]);
    }
}
