package org.glowstr.meshbridge;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.SurfaceTexture;
import android.graphics.drawable.GradientDrawable;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.Image;
import android.media.ImageReader;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class QrScanActivity extends Activity {
    static final String PREFS = "nostr_qr";
    static final String KEY_RESULT = "scan_result";
    private static final int REQ_CAMERA = 912;
    private static final long DECODE_INTERVAL_MS = 160L;

    private final AtomicBoolean finished = new AtomicBoolean(false);
    private final AtomicBoolean decodeBusy = new AtomicBoolean(false);
    private final MultiFormatReader reader = new MultiFormatReader();
    private final ExecutorService decodeExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "glowstr-qr-decode");
        t.setDaemon(true);
        return t;
    });

    private TextureView preview;
    private HandlerThread cameraThread;
    private Handler cameraHandler;

    // Camera objects below are owned by cameraHandler. Do not close them from
    // the UI thread: Image.Plane buffers are direct native buffers and can be
    // invalidated if ImageReader is closed while a frame callback is reading.
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader imageReader;
    private Surface previewSurface;
    private boolean cameraOpening = false;
    private int cameraGeneration = 0;

    private volatile boolean resumed = false;
    private long lastDecodeAt = 0L;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_RESULT).apply();

        Map<DecodeHintType,Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.ALSO_INVERTED, Boolean.TRUE);
        reader.setHints(hints);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        preview = new TextureView(this);
        root.addView(preview, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        View finder = new View(this);
        GradientDrawable finderBorder = new GradientDrawable();
        finderBorder.setColor(Color.TRANSPARENT);
        finderBorder.setStroke(dp(3), 0xFFFF6600);
        finderBorder.setCornerRadius(dp(12));
        finder.setBackground(finderBorder);
        FrameLayout.LayoutParams finderLp = new FrameLayout.LayoutParams(
                dp(286), dp(286), Gravity.CENTER);
        root.addView(finder, finderLp);

        TextView title = new TextView(this);
        title.setText("SCAN NOSTR PUBKEY");
        title.setTextColor(Color.WHITE);
        title.setBackgroundColor(0xCC000000);
        title.setTextSize(18f);
        title.setGravity(Gravity.CENTER);
        title.setPadding(dp(16), dp(28), dp(16), dp(18));
        FrameLayout.LayoutParams titleLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
        root.addView(title, titleLp);

        TextView hint = new TextView(this);
        hint.setText("Center a Nostr npub QR inside the orange square");
        hint.setTextColor(0xFFEAEAEA);
        hint.setBackgroundColor(0xCC000000);
        hint.setTextSize(14f);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(dp(16), dp(14), dp(16), dp(14));
        FrameLayout.LayoutParams hintLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        hintLp.bottomMargin = dp(82);
        root.addView(hint, hintLp);

        Button cancel = new Button(this);
        cancel.setText("CANCEL");
        cancel.setOnClickListener(v -> finishCancelled());
        FrameLayout.LayoutParams cancelLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        cancelLp.bottomMargin = dp(18);
        root.addView(cancel, cancelLp);

        setContentView(root);

        preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) {
                ensureCamera();
            }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture surface, int width, int height) {}
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture surface) {
                requestCameraClose();
                return true;
            }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture surface) {}
        });

        startCameraThread();
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        startCameraThread();
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                && preview != null && preview.isAvailable()) {
            ensureCamera();
        }
    }

    @Override protected void onPause() {
        resumed = false;
        requestCameraClose();
        super.onPause();
    }

    @Override protected void onDestroy() {
        resumed = false;
        requestCameraClose();
        decodeExecutor.shutdownNow();
        stopCameraThreadDeferred();
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        finishCancelled();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_CAMERA) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            if (resumed) ensureCamera();
        } else {
            finishError("Camera permission is required to scan QR codes");
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private synchronized void startCameraThread() {
        if (cameraThread != null && cameraThread.isAlive() && cameraHandler != null) return;
        cameraThread = new HandlerThread("glowstr-qr-camera");
        cameraThread.start();
        cameraHandler = new Handler(cameraThread.getLooper());
    }

    private void stopCameraThreadDeferred() {
        final Handler h;
        final HandlerThread t;
        synchronized (this) {
            h = cameraHandler;
            t = cameraThread;
        }
        if (h == null || t == null) return;

        // Keep the looper alive briefly after CameraDevice.close() so Android can
        // deliver its asynchronous onClosed callbacks to a live Handler.
        h.postDelayed(() -> {
            synchronized (QrScanActivity.this) {
                if (cameraThread == t) {
                    cameraHandler = null;
                    cameraThread = null;
                }
            }
            t.quitSafely();
        }, 750L);
    }

    private void ensureCamera() {
        if (finished.get() || !resumed || preview == null || !preview.isAvailable()) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;

        final SurfaceTexture texture = preview.getSurfaceTexture();
        if (texture == null) return;

        startCameraThread();
        final Handler h;
        synchronized (this) { h = cameraHandler; }
        if (h != null) h.post(() -> openCameraOnThread(texture));
    }

    private void openCameraOnThread(SurfaceTexture texture) {
        if (finished.get() || !resumed || camera != null || cameraOpening) return;
        cameraOpening = true;
        final int generation = ++cameraGeneration;

        try {
            CameraManager manager = (CameraManager)getSystemService(Context.CAMERA_SERVICE);
            String selected = null;
            Size scanSize = null;
            Size previewSize = null;

            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics chars = manager.getCameraCharacteristics(id);
                Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT) continue;

                android.hardware.camera2.params.StreamConfigurationMap map =
                        chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                if (map == null) continue;

                Size s1 = chooseSize(
                        map.getOutputSizes(android.graphics.ImageFormat.YUV_420_888), 1280, 960);
                Size s2 = chooseSize(map.getOutputSizes(SurfaceTexture.class), 1920, 1080);
                if (s1 != null && s2 != null) {
                    selected = id;
                    scanSize = s1;
                    previewSize = s2;
                    break;
                }
            }

            if (selected == null || scanSize == null || previewSize == null) {
                cameraOpening = false;
                finishError("No compatible camera was found");
                return;
            }

            texture.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
            previewSurface = new Surface(texture);

            imageReader = ImageReader.newInstance(
                    scanSize.getWidth(), scanSize.getHeight(),
                    android.graphics.ImageFormat.YUV_420_888, 3);
            imageReader.setOnImageAvailableListener(this::onImage, cameraHandler);
            final Surface scanSurface = imageReader.getSurface();

            manager.openCamera(selected, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice device) {
                    cameraOpening = false;
                    if (generation != cameraGeneration || finished.get() || !resumed) {
                        device.close();
                        return;
                    }
                    camera = device;
                    createSessionOnThread(device, scanSurface, generation);
                }

                @Override public void onDisconnected(CameraDevice device) {
                    cameraOpening = false;
                    device.close();
                    if (camera == device) camera = null;
                    if (generation == cameraGeneration && resumed && !finished.get()) {
                        finishError("Camera disconnected");
                    }
                }

                @Override public void onError(CameraDevice device, int error) {
                    cameraOpening = false;
                    device.close();
                    if (camera == device) camera = null;
                    if (generation == cameraGeneration && resumed && !finished.get()) {
                        finishError("Camera error");
                    }
                }

                @Override public void onClosed(CameraDevice device) {
                    if (camera == device) camera = null;
                }
            }, cameraHandler);
        } catch (SecurityException e) {
            cameraOpening = false;
            finishError("Camera permission is required");
        } catch (Exception e) {
            cameraOpening = false;
            closeCameraOnThread();
            finishError("Could not open camera");
        }
    }

    private void createSessionOnThread(CameraDevice device, Surface scanSurface, int generation) {
        if (previewSurface == null) {
            finishError("Camera preview is unavailable");
            return;
        }
        try {
            device.createCaptureSession(java.util.Arrays.asList(previewSurface, scanSurface),
                    new CameraCaptureSession.StateCallback() {
                        @Override public void onConfigured(CameraCaptureSession captureSession) {
                            if (generation != cameraGeneration || finished.get() || !resumed || camera != device) {
                                captureSession.close();
                                return;
                            }
                            session = captureSession;
                            try {
                                CaptureRequest.Builder b =
                                        device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                                b.addTarget(previewSurface);
                                b.addTarget(scanSurface);
                                b.set(CaptureRequest.CONTROL_AF_MODE,
                                        CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                                b.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
                                captureSession.setRepeatingRequest(b.build(), null, cameraHandler);
                            } catch (Exception e) {
                                finishError("Could not start camera preview");
                            }
                        }

                        @Override public void onConfigureFailed(CameraCaptureSession captureSession) {
                            captureSession.close();
                            if (generation == cameraGeneration && resumed && !finished.get()) {
                                finishError("Could not configure camera");
                            }
                        }

                        @Override public void onClosed(CameraCaptureSession captureSession) {
                            if (session == captureSession) session = null;
                        }
                    }, cameraHandler);
        } catch (Exception e) {
            finishError("Could not create camera session");
        }
    }

    private void onImage(ImageReader source) {
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null) return;
            if (finished.get() || !resumed || decodeBusy.get()) return;

            long now = android.os.SystemClock.elapsedRealtime();
            if (now - lastDecodeAt < DECODE_INTERVAL_MS) return;
            lastDecodeAt = now;

            // IMPORTANT: copy the native-backed Y plane to a Java byte[] before
            // leaving the camera callback. The decoder never touches ImageReader
            // or DirectByteBuffer memory.
            Image.Plane yPlane = image.getPlanes()[0];
            int width = image.getWidth();
            int height = image.getHeight();
            byte[] y = copyYPlane(yPlane, width, height);

            if (!decodeBusy.compareAndSet(false, true)) return;
            decodeExecutor.execute(() -> {
                try {
                    Result result = decodeRotations(y, width, height);
                    if (result == null || finished.get() || !resumed) return;
                    String text = result.getText();
                    if (text != null && !text.trim().isEmpty() && text.length() <= 2048) {
                        finishSuccess(text.trim());
                    }
                } catch (Exception ignored) {
                } finally {
                    decodeBusy.set(false);
                }
            });
        } catch (IllegalStateException ignored) {
            // ImageReader may already be stopping; no crash or user-visible error.
        } catch (Exception ignored) {
        } finally {
            if (image != null) {
                try { image.close(); } catch (Exception ignored) {}
            }
        }
    }

    private Result decodeRotations(byte[] data, int width, int height) {
        byte[] current = data;
        int w = width;
        int h = height;

        for (int i = 0; i < 4; i++) {
            try {
                PlanarYUVLuminanceSource src =
                        new PlanarYUVLuminanceSource(current, w, h, 0, 0, w, h, false);
                BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(src));
                Result result = reader.decodeWithState(bitmap);
                reader.reset();
                return result;
            } catch (NotFoundException e) {
                reader.reset();
            }

            if (i < 3) {
                byte[] rotated = rotate90(current, w, h);
                current = rotated;
                int tmp = w;
                w = h;
                h = tmp;
            }
        }
        return null;
    }

    private static byte[] copyYPlane(Image.Plane plane, int width, int height) {
        ByteBuffer buffer = plane.getBuffer().duplicate();
        int rowStride = plane.getRowStride();
        int pixelStride = plane.getPixelStride();
        int base = buffer.position();
        int limit = buffer.limit();
        byte[] out = new byte[width * height];

        if (pixelStride == 1 && rowStride == width && limit - base >= out.length) {
            buffer.get(out, 0, out.length);
            return out;
        }

        for (int y = 0; y < height; y++) {
            int rowStart = base + y * rowStride;
            for (int x = 0; x < width; x++) {
                int index = rowStart + x * pixelStride;
                if (index >= base && index < limit) {
                    out[y * width + x] = buffer.get(index);
                }
            }
        }
        return out;
    }

    private static byte[] rotate90(byte[] src, int width, int height) {
        byte[] out = new byte[src.length];
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                out[x * height + (height - y - 1)] = src[y * width + x];
            }
        }
        return out;
    }

    private static Size chooseSize(Size[] sizes, int maxW, int maxH) {
        if (sizes == null || sizes.length == 0) return null;
        Size best = null;
        long bestArea = -1L;

        for (Size s : sizes) {
            int w = s.getWidth();
            int h = s.getHeight();
            int longEdge = Math.max(w, h);
            int shortEdge = Math.min(w, h);
            if (longEdge > Math.max(maxW, maxH) || shortEdge > Math.min(maxW, maxH)) continue;
            long area = (long)w * h;
            if (area > bestArea) {
                best = s;
                bestArea = area;
            }
        }
        return best != null ? best : sizes[0];
    }

    private void requestCameraClose() {
        final Handler h;
        synchronized (this) { h = cameraHandler; }
        if (h != null) h.post(this::closeCameraOnThread);
    }

    private void closeCameraOnThread() {
        // Invalidate callbacks from any in-flight open/session before releasing.
        cameraGeneration++;
        cameraOpening = false;

        ImageReader readerToClose = imageReader;
        imageReader = null;
        if (readerToClose != null) {
            try { readerToClose.setOnImageAvailableListener(null, null); } catch (Exception ignored) {}
        }

        CameraCaptureSession sessionToClose = session;
        session = null;
        if (sessionToClose != null) {
            try { sessionToClose.stopRepeating(); } catch (Exception ignored) {}
            try { sessionToClose.abortCaptures(); } catch (Exception ignored) {}
            try { sessionToClose.close(); } catch (Exception ignored) {}
        }

        CameraDevice cameraToClose = camera;
        camera = null;
        if (cameraToClose != null) {
            try { cameraToClose.close(); } catch (Exception ignored) {}
        }

        if (readerToClose != null) {
            try { readerToClose.close(); } catch (Exception ignored) {}
        }

        Surface surfaceToRelease = previewSurface;
        previewSurface = null;
        if (surfaceToRelease != null) {
            try { surfaceToRelease.release(); } catch (Exception ignored) {}
        }
    }

    private void finishSuccess(String text) {
        if (!finished.compareAndSet(false, true)) return;
        try {
            String json = new JSONObject().put("ok", true).put("text", text).toString();
            getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_RESULT, json).apply();
        } catch (Exception ignored) {}
        runOnUiThread(this::finish);
    }

    private void finishError(String message) {
        if (!finished.compareAndSet(false, true)) return;
        try {
            String json = new JSONObject().put("ok", false).put("error", message).toString();
            getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_RESULT, json).apply();
        } catch (Exception ignored) {}
        runOnUiThread(this::finish);
    }

    private void finishCancelled() {
        if (!finished.compareAndSet(false, true)) return;
        try {
            String json = new JSONObject().put("ok", false).put("cancelled", true).toString();
            getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_RESULT, json).apply();
        } catch (Exception ignored) {}
        runOnUiThread(this::finish);
    }
}
