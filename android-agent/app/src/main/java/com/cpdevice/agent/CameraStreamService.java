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
import android.hardware.camera2.CameraCharacteristics;
import android.media.Image;
import android.media.ImageReader;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.content.Intent;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.nio.ByteBuffer;
import java.util.Collections;

public class CameraStreamService extends Service {
    private HandlerThread thread;
    private Handler handler;
    private ImageReader reader;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private SimpleWebSocketClient ws;
    private SimpleWebSocketClient audioWs;
    private WebRtcLiveSender webRtcSender;
    private Thread audioThread;
    private volatile boolean audioRunning;
    private final ExecutorService uploadExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService audioUploadExecutor = Executors.newSingleThreadExecutor();
    private volatile boolean uploadBusy;
    private volatile boolean audioUploadBusy;
    private long lastFrameAt;
    private long lastHttpFrameAt;
    private long lastHttpAudioAt;
    private String requestedFacing = "back";

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(30, notification());
        thread = new HandlerThread("cp-camera");
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        requestedFacing = intent != null ? intent.getStringExtra("facing") : requestedFacing;
        if (requestedFacing == null || requestedFacing.length() == 0) requestedFacing = "back";
        restartCamera();
        return START_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        try { if (session != null) session.close(); } catch (Exception ignored) { }
        try { if (camera != null) camera.close(); } catch (Exception ignored) { }
        try { if (reader != null) reader.close(); } catch (Exception ignored) { }
        stopAudio();
        if (ws != null) ws.close();
        if (webRtcSender != null) webRtcSender.stop();
        webRtcSender = null;
        uploadExecutor.shutdownNow();
        audioUploadExecutor.shutdownNow();
        if (thread != null) thread.quitSafely();
        super.onDestroy();
    }

    private void restartCamera() {
        try { if (session != null) session.close(); } catch (Exception ignored) { }
        try { if (camera != null) camera.close(); } catch (Exception ignored) { }
        try { if (reader != null) reader.close(); } catch (Exception ignored) { }
        stopAudio();
        if (ws != null) ws.close();
        if (webRtcSender != null) webRtcSender.stop();
        webRtcSender = null;
        session = null; camera = null; reader = null; ws = null; lastFrameAt = 0; lastHttpFrameAt = 0; lastHttpAudioAt = 0;
        startCamera();
    }

    private void startCamera() {
        try {
            if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) { stopSelf(); return; }
            SharedPreferences prefs = getSharedPreferences("cp-device", MODE_PRIVATE);
            String serverUrl = liveServerUrl(prefs);
            String wsUrl = serverUrl.replace("http://", "ws://").replace("https://", "wss://") + "/ws/device/" + prefs.getString("deviceId", "") + "?token=" + prefs.getString("deviceToken", "");
            ws = new SimpleWebSocketClient();
            try { ws.connect(wsUrl); } catch (Exception ignored) { ws = null; }
            startAudio(prefs);
            webRtcSender = WebRtcLiveSender.start(this, prefs, true);
            reader = ImageReader.newInstance(480, 360, ImageFormat.JPEG, 2);
            reader.setOnImageAvailableListener(this::onImage, handler);
            CameraManager manager = (CameraManager) getSystemService(CAMERA_SERVICE);
            String cameraId = chooseCameraId(manager, requestedFacing);
            manager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice device) { camera = device; createSession(); }
                @Override public void onDisconnected(CameraDevice device) { device.close(); }
                @Override public void onError(CameraDevice device, int error) { device.close(); stopSelf(); }
            }, handler);
        } catch (Exception ignored) { stopSelf(); }
    }

    private String chooseCameraId(CameraManager manager, String facing) throws Exception {
        int desired = "front".equalsIgnoreCase(facing) ? CameraCharacteristics.LENS_FACING_FRONT : CameraCharacteristics.LENS_FACING_BACK;
        String fallback = manager.getCameraIdList().length > 0 ? manager.getCameraIdList()[0] : "0";
        for (String id : manager.getCameraIdList()) {
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(id);
            Integer lens = characteristics.get(CameraCharacteristics.LENS_FACING);
            if (lens != null && lens == desired) return id;
        }
        return fallback;
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
            if (image == null || now - lastFrameAt < 90) return;
            lastFrameAt = now;
            ByteBuffer buffer = image.getPlanes()[0].getBuffer();
            byte[] jpeg = new byte[buffer.remaining()];
            buffer.get(jpeg);
            if (webRtcSender != null) webRtcSender.pushJpegFrame(jpeg);
            boolean sent = false;
            try {
                if (ws != null) {
                    ws.sendBinary(jpeg);
                    sent = true;
                }
            } catch (Exception ignored) {
                ws = null;
            }
            if (!sent || now - lastHttpFrameAt > 1000) {
                lastHttpFrameAt = now;
                postFrameAsync(jpeg);
            }
        } catch (Exception ignored) {
        } finally { if (image != null) image.close(); }
    }


    private void startAudio(SharedPreferences prefs) {
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return;
        stopAudio();
        audioRunning = true;
        String serverUrl = liveServerUrl(prefs);
        String deviceId = prefs.getString("deviceId", "");
        String token = prefs.getString("deviceToken", "");
        String audioWsUrl = serverUrl.replace("http://", "ws://").replace("https://", "wss://") + "/ws/device-audio/" + deviceId + "?token=" + token;
        audioWs = new SimpleWebSocketClient();
        try { audioWs.connect(audioWsUrl); } catch (Exception ignored) { audioWs = null; }
        audioThread = new Thread(() -> recordAudio(serverUrl, deviceId, token), "cp-camera-audio");
        audioThread.start();
    }

    private void stopAudio() {
        audioRunning = false;
        try { if (audioWs != null) audioWs.close(); } catch (Exception ignored) { }
        audioWs = null;
        if (audioThread != null) {
            try { audioThread.interrupt(); } catch (Exception ignored) { }
            audioThread = null;
        }
    }

    private void recordAudio(String serverUrl, String deviceId, String token) {
        AudioRecord recorder = null;
        try {
            int sampleRate = 16000;
            int minBuffer = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int bufferSize = Math.max(minBuffer, 1600);
            recorder = new AudioRecord(MediaRecorder.AudioSource.MIC, sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize * 2);
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) return;
            AudioManager audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
            if (audioManager != null) audioManager.setMicrophoneMute(false);
            byte[] buffer = new byte[bufferSize];
            recorder.startRecording();
            if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) return;
            while (audioRunning && !Thread.currentThread().isInterrupted()) {
                int read = recorder.read(buffer, 0, buffer.length);
                if (read <= 0) continue;
                byte[] chunk = new byte[read];
                System.arraycopy(buffer, 0, chunk, 0, read);
                boolean sent = false;
                try {
                    if (audioWs != null) {
                        audioWs.sendBinary(chunk);
                        sent = true;
                    }
                } catch (Exception ignored) {
                    audioWs = null;
                }
                long now = System.currentTimeMillis();
                if (!sent || now - lastHttpAudioAt > 1000) {
                    lastHttpAudioAt = now;
                    postAudioAsync(serverUrl, deviceId, token, chunk, sampleRate);
                }
            }
        } catch (Exception ignored) {
        } finally {
            try { if (recorder != null) recorder.stop(); } catch (Exception ignored) { }
            try { if (recorder != null) recorder.release(); } catch (Exception ignored) { }
        }
    }

    private void postAudioAsync(String serverUrl, String deviceId, String token, byte[] chunk, int sampleRate) {
        if (audioUploadBusy) return;
        audioUploadBusy = true;
        audioUploadExecutor.execute(() -> {
            try {
                postAudio(serverUrl, deviceId, token, chunk, sampleRate);
            } finally {
                audioUploadBusy = false;
            }
        });
    }

    private void postAudio(String serverUrl, String deviceId, String token, byte[] chunk, int sampleRate) {
        HttpURLConnection conn = null;
        try {
            if (deviceId.length() == 0 || token.length() == 0) return;
            URL url = new URL(serverUrl + "/api/device/" + deviceId + "/live-audio");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(2000);
            conn.setReadTimeout(2000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "audio/pcm; rate=" + sampleRate);
            conn.setRequestProperty("X-Audio-Sample-Rate", String.valueOf(sampleRate));
            conn.setFixedLengthStreamingMode(chunk.length);
            OutputStream output = conn.getOutputStream();
            output.write(chunk);
            output.close();
            conn.getResponseCode();
        } catch (Exception ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void postFrameAsync(byte[] frame) {
        if (uploadBusy) return;
        uploadBusy = true;
        uploadExecutor.execute(() -> {
            try {
                postFrame(frame);
            } finally {
                uploadBusy = false;
            }
        });
    }

    private void postFrame(byte[] frame) {
        HttpURLConnection conn = null;
        try {
            SharedPreferences prefs = getSharedPreferences("cp-device", MODE_PRIVATE);
            String serverUrl = liveServerUrl(prefs);
            String deviceId = prefs.getString("deviceId", "");
            String token = prefs.getString("deviceToken", "");
            if (deviceId.length() == 0 || token.length() == 0) return;
            URL url = new URL(serverUrl + "/api/device/" + deviceId + "/live-frame");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(2500);
            conn.setReadTimeout(2500);
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

    private String liveServerUrl(SharedPreferences prefs) {
        String fallback = prefs.getString("serverUrl", "https://shied.onrender.com");
        String live = prefs.getString("liveServerUrl", fallback);
        return (live == null || live.length() == 0 ? fallback : live).replaceAll("/$", "");
    }
    private void createChannel() { if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("cp-camera", "Shield Device Camera", NotificationManager.IMPORTANCE_DEFAULT)); }
    private Notification notification() { Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, "cp-camera") : new Notification.Builder(this); return b.setContentTitle("Shield Device Camera").setContentText("Camera and microphone streaming are active and visible").setSmallIcon(android.R.drawable.presence_video_online).setOngoing(true).build(); }
}
