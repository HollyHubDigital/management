package com.cpdevice.agent;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.content.Intent;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.util.Collections;

public class CameraStreamService extends Service {
    private HandlerThread thread;
    private Handler handler;
    private ImageReader reader;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private SimpleWebSocketClient ws;
    private long lastFrameAt;

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(30, notification());
        thread = new HandlerThread("cp-camera");
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) { startCamera(); return START_STICKY; }
    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        try { if (session != null) session.close(); } catch (Exception ignored) { }
        try { if (camera != null) camera.close(); } catch (Exception ignored) { }
        try { if (reader != null) reader.close(); } catch (Exception ignored) { }
        if (ws != null) ws.close();
        if (thread != null) thread.quitSafely();
        super.onDestroy();
    }

    private void startCamera() {
        try {
            if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) { stopSelf(); return; }
            SharedPreferences prefs = getSharedPreferences("cp-device", MODE_PRIVATE);
            String serverUrl = prefs.getString("serverUrl", "https://admin-device-management.vercel.app");
            String wsUrl = serverUrl.replace("http://", "ws://").replace("https://", "wss://") + "/ws/device/" + prefs.getString("deviceId", "") + "?token=" + prefs.getString("deviceToken", "");
            ws = new SimpleWebSocketClient();
            try { ws.connect(wsUrl); } catch (Exception ignored) { ws = null; }
            reader = ImageReader.newInstance(640, 480, ImageFormat.JPEG, 2);
            reader.setOnImageAvailableListener(this::onImage, handler);
            CameraManager manager = (CameraManager) getSystemService(CAMERA_SERVICE);
            String cameraId = manager.getCameraIdList()[0];
            manager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice device) { camera = device; createSession(); }
                @Override public void onDisconnected(CameraDevice device) { device.close(); }
                @Override public void onError(CameraDevice device, int error) { device.close(); stopSelf(); }
            }, handler);
        } catch (Exception ignored) { stopSelf(); }
    }

    private void createSession() {
        try {
            camera.createCaptureSession(Collections.singletonList(reader.getSurface()), new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession captureSession) {
                    try {
                        session = captureSession;
                        CaptureRequest.Builder builder = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                        builder.addTarget(reader.getSurface());
                        session.setRepeatingRequest(builder.build(), null, handler);
                    } catch (Exception ignored) { stopSelf(); }
                }
                @Override public void onConfigureFailed(CameraCaptureSession captureSession) { stopSelf(); }
            }, handler);
        } catch (Exception ignored) { stopSelf(); }
    }

    private void onImage(ImageReader imageReader) {
        Image image = null;
        try {
            long now = System.currentTimeMillis();
            image = imageReader.acquireLatestImage();
            if (image == null || now - lastFrameAt < 350) return;
            lastFrameAt = now;
            ByteBuffer buffer = image.getPlanes()[0].getBuffer();
            byte[] jpeg = new byte[buffer.remaining()];
            buffer.get(jpeg);
            try { if (ws != null) ws.sendBinary(jpeg); } catch (Exception ignored) { }
            postFrame(jpeg);
        } catch (Exception ignored) {
        } finally { if (image != null) image.close(); }
    }

    private void postFrame(byte[] frame) {
        HttpURLConnection conn = null;
        try {
            SharedPreferences prefs = getSharedPreferences("cp-device", MODE_PRIVATE);
            String serverUrl = prefs.getString("serverUrl", "https://admin-device-management.vercel.app");
            String deviceId = prefs.getString("deviceId", "");
            String token = prefs.getString("deviceToken", "");
            if (deviceId.length() == 0 || token.length() == 0) return;
            URL url = new URL(serverUrl + "/api/device/" + deviceId + "/live-frame");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "image/jpeg");
            conn.setFixedLengthStreamingMode(frame.length);
            OutputStream output = conn.getOutputStream();
            output.write(frame);
            output.close();
            conn.getResponseCode();
        } catch (Exception ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void createChannel() { if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("cp-camera", "CP DEVICE Camera", NotificationManager.IMPORTANCE_LOW)); }
    private Notification notification() { Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, "cp-camera") : new Notification.Builder(this); return b.setContentTitle("CP DEVICE Camera").setContentText("Camera streaming is active").setSmallIcon(android.R.drawable.presence_video_online).build(); }
}
