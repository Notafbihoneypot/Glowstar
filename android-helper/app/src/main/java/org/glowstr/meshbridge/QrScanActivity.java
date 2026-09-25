package org.glowstr.meshbridge;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.SurfaceTexture;
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
import java.util.concurrent.atomic.AtomicBoolean;

public final class QrScanActivity extends Activity {
    static final String PREFS = "nostr_qr";
    static final String KEY_RESULT = "scan_result";
    private static final int REQ_CAMERA = 912;

    private final AtomicBoolean finished = new AtomicBoolean(false);
    private final MultiFormatReader reader = new MultiFormatReader();
    private TextureView preview;
    private HandlerThread cameraThread;
    private Handler cameraHandler;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader imageReader;
    private long lastDecodeAt = 0L;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_RESULT).apply();

        Map<DecodeHintType,Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        reader.setHints(hints);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        preview = new TextureView(this);
        root.addView(preview, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView title = new TextView(this);
        title.setText("SCAN NOSTR PUBKEY QR");
        title.setTextColor(Color.WHITE);
        title.setBackgroundColor(0xAA000000);
        title.setTextSize(18f);
        title.setGravity(Gravity.CENTER);
        title.setPadding(16, 28, 16, 20);
        FrameLayout.LayoutParams titleLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
        root.addView(title, titleLp);

        TextView hint = new TextView(this);
        hint.setText("Point the camera at a Glowstr / Nostr npub QR code");
        hint.setTextColor(0xFFE0E0E0);
        hint.setBackgroundColor(0xAA000000);
        hint.setTextSize(14f);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(16, 16, 16, 16);
        FrameLayout.LayoutParams hintLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        hintLp.bottomMargin = 84;
        root.addView(hint, hintLp);

        Button cancel = new Button(this);
        cancel.setText("CANCEL");
        cancel.setOnClickListener(v -> finishCancelled());
        FrameLayout.LayoutParams cancelLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        cancelLp.bottomMargin = 20;
        root.addView(cancel, cancelLp);

        setContentView(root);
        preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) { ensureCamera(); }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture surface, int width, int height) {}
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture surface) { return true; }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture surface) {}
        });

        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        } else if (preview.isAvailable()) {
            ensureCamera();
        }
    }

    @Override protected void onResume() {
        super.onResume();
        startCameraThread();
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED && preview != null && preview.isAvailable()) {
            ensureCamera();
        }
    }

    @Override protected void onPause() {
        closeCamera();
        stopCameraThread();
        super.onPause();
    }

    @Override public void onBackPressed() {
        finishCancelled();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_CAMERA) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) ensureCamera();
        else finishError("Camera permission is required to scan QR codes");
    }

    private synchronized void startCameraThread() {
        if (cameraThread != null) return;
        cameraThread = new HandlerThread("glowstr-qr-camera");
        cameraThread.start();
        cameraHandler = new Handler(cameraThread.getLooper());
    }

    private synchronized void stopCameraThread() {
        HandlerThread t = cameraThread;
        cameraThread = null;
        cameraHandler = null;
        if (t != null) {
            t.quitSafely();
            try { t.join(800); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
    }

    private void ensureCamera() {
        if (finished.get() || camera != null || preview == null || !preview.isAvailable()) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        startCameraThread();
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
                Size s1 = chooseSize(map.getOutputSizes(android.graphics.ImageFormat.YUV_420_888), 960, 720);
                Size s2 = chooseSize(map.getOutputSizes(SurfaceTexture.class), 1280, 960);
                if (s1 != null && s2 != null) {
                    selected = id;
                    scanSize = s1;
                    previewSize = s2;
                    break;
                }
            }
            if (selected == null || scanSize == null || previewSize == null) {
                finishError("No compatible camera was found");
                return;
            }

            SurfaceTexture texture = preview.getSurfaceTexture();
            if (texture == null) {
                finishError("Camera preview is unavailable");
                return;
            }
            texture.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
            final Surface previewSurface = new Surface(texture);
            imageReader = ImageReader.newInstance(scanSize.getWidth(), scanSize.getHeight(),
                    android.graphics.ImageFormat.YUV_420_888, 2);
            imageReader.setOnImageAvailableListener(this::onImage, cameraHandler);
            final Surface scanSurface = imageReader.getSurface();

            manager.openCamera(selected, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice device) {
                    camera = device;
                    try {
                        device.createCaptureSession(java.util.Arrays.asList(previewSurface, scanSurface),
                                new CameraCaptureSession.StateCallback() {
                                    @Override public void onConfigured(CameraCaptureSession captureSession) {
                                        if (finished.get()) { captureSession.close(); return; }
                                        session = captureSession;
                                        try {
                                            CaptureRequest.Builder b = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                                            b.addTarget(previewSurface);
                                            b.addTarget(scanSurface);
                                            b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                                            captureSession.setRepeatingRequest(b.build(), null, cameraHandler);
                                        } catch (Exception e) {
                                            finishError("Could not start camera preview");
                                        }
                                    }
                                    @Override public void onConfigureFailed(CameraCaptureSession captureSession) {
                                        finishError("Could not configure camera");
                                    }
                                }, cameraHandler);
                    } catch (Exception e) {
                        finishError("Could not create camera session");
                    }
                }
                @Override public void onDisconnected(CameraDevice device) {
                    device.close();
                    if (camera == device) camera = null;
                    if (!finished.get()) finishError("Camera disconnected");
                }
                @Override public void onError(CameraDevice device, int error) {
                    device.close();
                    if (camera == device) camera = null;
                    if (!finished.get()) finishError("Camera error");
                }
            }, cameraHandler);
        } catch (SecurityException e) {
            finishError("Camera permission is required");
        } catch (Exception e) {
            finishError("Could not open camera");
        }
    }

    private void onImage(ImageReader source) {
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null || finished.get()) return;
            long now = android.os.SystemClock.elapsedRealtime();
            if (now - lastDecodeAt < 220) return;
            lastDecodeAt = now;

            Image.Plane yPlane = image.getPlanes()[0];
            int width = image.getWidth(), height = image.getHeight();
            byte[] y = copyYPlane(yPlane, width, height);
            Result result = decodeRotations(y, width, height);
            if (result != null) {
                String text = result.getText();
                if (text != null && !text.trim().isEmpty() && text.length() <= 2048) finishSuccess(text.trim());
            }
        } catch (Exception ignored) {
        } finally {
            if (image != null) image.close();
        }
    }

    private Result decodeRotations(byte[] data, int width, int height) {
        byte[] current = data;
        int w = width, h = height;
        for (int i = 0; i < 4; i++) {
            try {
                PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(current, w, h, 0, 0, w, h, false);
                BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(src));
                Result result = reader.decodeWithState(bitmap);
                reader.reset();
                return result;
            } catch (NotFoundException e) {
                reader.reset();
            }
            byte[] rotated = rotate90(current, w, h);
            current = rotated;
            int tmp = w; w = h; h = tmp;
        }
        return null;
    }

    private static byte[] copyYPlane(Image.Plane plane, int width, int height) {
        ByteBuffer buffer = plane.getBuffer();
        int rowStride = plane.getRowStride();
        int pixelStride = plane.getPixelStride();
        byte[] out = new byte[width * height];
        if (pixelStride == 1 && rowStride == width) {
            int oldPos = buffer.position();
            buffer.get(out, 0, Math.min(out.length, buffer.remaining()));
            buffer.position(oldPos);
            return out;
        }
        for (int y = 0; y < height; y++) {
            int rowStart = y * rowStride;
            for (int x = 0; x < width; x++) {
                int index = rowStart + x * pixelStride;
                if (index < buffer.limit()) out[y * width + x] = buffer.get(index);
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
        long bestArea = -1;
        for (Size s : sizes) {
            if (s.getWidth() > maxW || s.getHeight() > maxH) continue;
            long area = (long)s.getWidth() * s.getHeight();
            if (area > bestArea) { best = s; bestArea = area; }
        }
        return best != null ? best : sizes[0];
    }

    private void finishSuccess(String text) {
        if (!finished.compareAndSet(false, true)) return;
        try {
            String json = new JSONObject().put("ok", true).put("text", text).toString();
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_RESULT, json).apply();
        } catch (Exception ignored) {}
        runOnUiThread(this::finish);
    }

    private void finishError(String message) {
        if (!finished.compareAndSet(false, true)) return;
        try {
            String json = new JSONObject().put("ok", false).put("error", message).toString();
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_RESULT, json).apply();
        } catch (Exception ignored) {}
        runOnUiThread(this::finish);
    }

    private void finishCancelled() {
        if (!finished.compareAndSet(false, true)) return;
        try {
            String json = new JSONObject().put("ok", false).put("cancelled", true).toString();
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_RESULT, json).apply();
        } catch (Exception ignored) {}
        finish();
    }

    private void closeCamera() {
        try { if (session != null) session.close(); } catch (Exception ignored) {}
        session = null;
        try { if (camera != null) camera.close(); } catch (Exception ignored) {}
        camera = null;
        try { if (imageReader != null) imageReader.close(); } catch (Exception ignored) {}
        imageReader = null;
    }
}
