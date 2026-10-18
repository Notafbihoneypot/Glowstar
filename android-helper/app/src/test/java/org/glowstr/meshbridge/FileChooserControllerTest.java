package org.glowstr.meshbridge;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.webkit.WebChromeClient.FileChooserParams;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class FileChooserControllerTest {
    public static class PickerActivity extends Activity {
        Intent launched;
        boolean fail;
        @Override public void startActivityForResult(Intent intent, int code) {
            if (fail) throw new android.content.ActivityNotFoundException();
            assertEquals(FileChooserController.REQUEST_CODE, code);
            launched = intent;
        }
        @Override public int checkUriPermission(Uri uri, int pid, int uid, int flags) {
            return "documents.test".equals(uri.getAuthority()) ?
                    PackageManager.PERMISSION_GRANTED : PackageManager.PERMISSION_DENIED;
        }
    }
    private PickerActivity activity;
    private FileChooserController chooser;
    private List<Uri[]> results;

    @Before public void setUp() {
        activity = Robolectric.buildActivity(PickerActivity.class).setup().get();
        chooser = new FileChooserController(activity);
        results = new ArrayList<>();
    }

    private FileChooserParams params(int mode, String... types) {
        return new FileChooserParams() {
            @Override public int getMode() { return mode; }
            @Override public String[] getAcceptTypes() { return types; }
            @Override public boolean isCaptureEnabled() { return false; }
            @Override public CharSequence getTitle() { return null; }
            @Override public String getFilenameHint() { return null; }
            @Override public Intent createIntent() { throw new AssertionError("Use read-only system picker"); }
        };
    }

    @Test public void imagePickerUsesScopedReadAccessAndAllowsRetryAfterCancel() {
        assertTrue(chooser.open(results::add, params(FileChooserParams.MODE_OPEN, "image/*")));
        Intent i = activity.launched;
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, i.getAction());
        assertTrue(i.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals("image/*", i.getType());
        assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, i.getFlags());
        assertFalse(i.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, true));
        chooser.onActivityResult(FileChooserController.REQUEST_CODE, Activity.RESULT_CANCELED, null);
        assertEquals(1, results.size());
        assertNull(results.get(0));
        chooser.open(results::add, params(FileChooserParams.MODE_OPEN, "image/*"));
        Uri selected = Uri.parse("content://documents.test/photo/1");
        chooser.onActivityResult(FileChooserController.REQUEST_CODE, Activity.RESULT_OK,
                new Intent().setData(selected));
        assertArrayEquals(new Uri[]{selected}, results.get(1));
    }

    @Test public void pendingRequestIsNotOverwrittenAndDestroyCompletesItOnce() {
        List<Uri[]> second = new ArrayList<>();
        chooser.open(results::add, params(FileChooserParams.MODE_OPEN));
        chooser.open(second::add, params(FileChooserParams.MODE_OPEN));
        assertEquals(1, second.size()); assertNull(second.get(0));
        assertTrue(results.isEmpty());
        chooser.close(); chooser.close();
        chooser.onActivityResult(FileChooserController.REQUEST_CODE, Activity.RESULT_OK, new Intent());
        assertEquals(1, results.size()); assertNull(results.get(0));
    }

    @Test public void missingPickerAndUnsupportedModesCompleteTheirCallbacks() {
        activity.fail = true;
        chooser.open(results::add, params(FileChooserParams.MODE_OPEN));
        assertEquals(1, results.size()); assertNull(results.get(0));
        activity.fail = false;
        chooser.open(results::add, params(FileChooserParams.MODE_SAVE));
        assertEquals(2, results.size()); assertNull(results.get(1));
    }

    @Test public void resultsRejectPrivateFilesAndUngrantedContent() {
        for (String value : new String[]{"file:///data/user/0/private", "https://evil.test/photo", "content://ungranted.test/photo"}) {
            chooser.open(results::add, params(FileChooserParams.MODE_OPEN));
            chooser.onActivityResult(FileChooserController.REQUEST_CODE, Activity.RESULT_OK,
                    new Intent().setData(Uri.parse(value)));
            assertNull(results.get(results.size() - 1));
        }
    }

    @Test public void multiSelectFiltersMimeTypesAndDeduplicatesGrantedDocuments() {
        chooser.open(results::add, params(FileChooserParams.MODE_OPEN_MULTIPLE, " image/jpeg,image/png "));
        assertEquals("*/*", activity.launched.getType());
        assertArrayEquals(new String[]{"image/jpeg", "image/png"}, activity.launched.getStringArrayExtra(Intent.EXTRA_MIME_TYPES));
        assertTrue(activity.launched.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
        Uri one = Uri.parse("content://documents.test/1"), two = Uri.parse("content://documents.test/2");
        ClipData clips = ClipData.newRawUri("images", one);
        clips.addItem(new ClipData.Item(one));
        clips.addItem(new ClipData.Item(Uri.parse("file:///private")));
        clips.addItem(new ClipData.Item(two));
        Intent result = new Intent();
        result.setClipData(clips);
        chooser.onActivityResult(FileChooserController.REQUEST_CODE, Activity.RESULT_OK, result);
        assertArrayEquals(new Uri[]{one, two}, results.get(0));
    }
}
