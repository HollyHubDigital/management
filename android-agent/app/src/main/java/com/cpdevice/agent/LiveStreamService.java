package com.cpdevice.agent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;

public class LiveStreamService extends Service {
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread thread;
    private SimpleWebSocketClient ws;
    private long lastFrameAt;

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(20, notification());
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        int resultCode = intent.getIntExtra("resultCode", 0);
        Intent data = intent.getParcelableExtra("data");
        if (data == null) return START_NOT_STICKY;
        startProjection(resultCode, data);
        return START_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        if (display != null) display.release();
        if (reader != null) reader.close();
        if (projection != null) projection.stop();
        if (ws != null) ws.close();
        if (thread != null) thread.quitSafely();
        super.onDestroy();
    }

    private void startProjection(int resultCode, Intent data) {
        try {
            SharedPreferences prefs = getSharedPreferences("cp-device", MODE_PRIVATE);
            String serverUrl = prefs.getString("serverUrl", "https://admin-device-management.vercel.app");
            String wsUrl = serverUrl.replace("http://", "ws://").replace("https://", "wss://") + "/ws/device/" + prefs.getString("deviceId", "") + "?token=" + prefs.getString("deviceToken", "");
            ws = new SimpleWebSocketClient();
            try { ws.connect(wsUrl); } catch (Exception ignored) { ws = null; }

            WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
            DisplayMetrics metrics = new DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(metrics);
            int width = Math.min(metrics.widthPixels, 720);
            int height = Math.max(1, (int) (metrics.heightPixels * (width / (float) metrics.widthPixels)));
            int density = metrics.densityDpi;
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
            thread = new HandlerThread("cp-live");
            thread.start();
            reader.setOnImageAvailableListener(this::onImage, new Handler(thread.getLooper()));
            MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            projection = manager.getMediaProjection(resultCode, data);
            display = projection.createVirtualDisplay("CP DEVICE Live", width, height, density, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, null);
        } catch (Exception ignored) { stopSelf(); }
    }

    private void onImage(ImageReader imageReader) {
        Image image = null;
        try {
            long now = System.currentTimeMillis();
            image = imageReader.acquireLatestImage();
            if (image == null || now - lastFrameAt < 350) return;
            lastFrameAt = now;
            Image.Plane plane = image.getPlanes()[0];
            ByteBuffer buffer = plane.getBuffer();
            int pixelStride = plane.getPixelStride();
            int rowStride = plane.getRowStride();
            int rowPadding = rowStride - pixelStride * image.getWidth();
            Bitmap bitmap = Bitmap.createBitmap(image.getWidth() + rowPadding / pixelStride, image.getHeight(), Bitmap.Config.ARGB_8888);
            bitmap.copyPixelsFromBuffer(buffer);
            Bitmap cropped = Bitmap.createBitmap(bitmap, 0, 0, image.getWidth(), image.getHeight());
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            cropped.compress(Bitmap.CompressFormat.JPEG, 55, out);
            byte[] frame = out.toByteArray();
            try { if (ws != null) ws.sendBinary(frame); } catch (Exception ignored) { }
            postFrame(frame);
            bitmap.recycle();
            cropped.recycle();
        } catch (Exception ignored) {
        } finally {
            if (image != null) image.close();
        }
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

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("cp-live", "CP DEVICE Live", NotificationManager.IMPORTANCE_LOW));
    }

    private Notification notification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, "cp-live") : new Notification.Builder(this);
        return builder.setContentTitle("CP DEVICE Live Control").setContentText("Screen streaming is active").setSmallIcon(android.R.drawable.presence_video_online).build();
    }
}
