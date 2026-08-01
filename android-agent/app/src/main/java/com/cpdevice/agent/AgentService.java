package com.cpdevice.agent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.net.Uri;
import android.os.Environment;
import android.os.IBinder;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class AgentService extends Service {
    private volatile boolean running;
    private SharedPreferences prefs;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("cp-device", Context.MODE_PRIVATE);
        createChannel();
        startForeground(10, notification());
        running = true;
        new Thread(this::loop).start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    private void loop() {
        while (running) {
            try {
                heartbeat();
                String commandsJson = request("GET", "/api/device/" + deviceId() + "/commands", null);
                processCommands(commandsJson);
                Thread.sleep(2000);
            } catch (Exception error) {
                try { Thread.sleep(5000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            }
        }
    }

    private void heartbeat() throws Exception {
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName receiver = new ComponentName(this, CpDeviceAdminReceiver.class);
        boolean admin = dpm != null && dpm.isAdminActive(receiver);
        boolean owner = dpm != null && dpm.isDeviceOwnerApp(getPackageName());
        boolean accessibility = CpAccessibilityService.isReady();
        String body = "{\"info\":{\"manufacturer\":\"" + safe(Build.MANUFACTURER) + "\",\"model\":\"" + safe(Build.MODEL) + "\",\"androidVersion\":\"" + safe(Build.VERSION.RELEASE) + "\",\"androidId\":\"" + safe(prefs.getString("androidId", "")) + "\"},\"capabilities\":{\"nativeAgent\":true,\"deviceAdmin\":" + admin + ",\"deviceOwner\":" + owner + ",\"accessibility\":" + accessibility + ",\"camera\":true,\"files\":true,\"location\":true,\"oemPrivileged\":false},\"operation\":{\"agent\":\"running\",\"deviceAdmin\":" + admin + ",\"deviceOwner\":" + owner + ",\"accessibility\":" + accessibility + "},\"alerts\":[]}";
        request("POST", "/api/device/" + deviceId() + "/heartbeat", body);
    }

    private void processCommands(String commandsJson) throws Exception {
        int index = 0;
        while ((index = commandsJson.indexOf("\"id\":\"", index)) >= 0) {
            int start = index + 6;
            int end = commandsJson.indexOf("\"", start);
            String commandId = commandsJson.substring(start, end);
            int typeStart = commandsJson.indexOf("\"type\":\"", end) + 8;
            int typeEnd = commandsJson.indexOf("\"", typeStart);
            String type = commandsJson.substring(typeStart, typeEnd);
            String output = execute(type, commandsJson, index);
            String result = "{\"commandId\":\"" + safe(commandId) + "\",\"result\":{\"ok\":true,\"output\":\"" + safe(output) + "\"}}";
            request("POST", "/api/device/" + deviceId() + "/commands", result);
            index = typeEnd;
        }
    }

    private String execute(String type, String commandJson, int commandStart) {
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName receiver = new ComponentName(this, CpDeviceAdminReceiver.class);
        boolean admin = dpm != null && dpm.isAdminActive(receiver);
        boolean owner = dpm != null && dpm.isDeviceOwnerApp(getPackageName());
        if ("shell".equals(type)) return owner ? "Device Owner active. Root shell still requires OEM/system/root integration." : (admin ? "Device Admin active. Android does not expose arbitrary root shell to normal APKs." : "Device Admin is not active.");
        if ("app.install".equals(type)) return installApk(textValue(commandJson, "apkUrl", commandStart, ""));
        if ("file.list".equals(type)) return listFiles(textValue(commandJson, "path", commandStart, "/sdcard"));
        if ("file.pull".equals(type)) return exportFile(textValue(commandJson, "path", commandStart, ""), textValue(commandJson, "id", commandStart, "manual"));
        if ("locate.device".equals(type)) return locateDevice();
        if ("lock.device".equals(type)) { if (admin) { dpm.lockNow(); return "Device locked."; } return "Device Admin is required to lock device."; }
        if ("mobile.data.on".equals(type)) return owner ? "Device Owner active, but Android public APIs still do not expose mobile data toggle. Requires OEM/system API." : "Android does not allow normal or Device Admin apps to toggle mobile data. Requires OEM/system privileges.";
        if ("firmware.update".equals(type)) return "Firmware update queued URL received. Android firmware flashing requires Device Owner system update policy, OEM/system privileges, or vendor updater integration.";
        if ("screen.control.request".equals(type)) return CpAccessibilityService.isReady() ? "Accessibility control is active. Live screen must be started from the device permission screen." : "Enable CP DEVICE Accessibility service on the device first.";
        if ("screen.tap".equals(type)) {
            int x = numberAfter(commandJson, "\\\"x\\\":", commandStart, 360);
            int y = numberAfter(commandJson, "\\\"y\\\":", commandStart, 640);
            return CpAccessibilityService.tap(x, y) ? "Tap dispatched at " + x + "," + y : "Accessibility service is not enabled.";
        }
        if ("camera.stream.request".equals(type)) { startForegroundService(new Intent(this, CameraStreamService.class)); return "Camera stream requested. Android camera permission must be approved on the device."; }
        return "Command received: " + type;
    }

    private String locateDevice() {
        try {
            LocationManager manager = (LocationManager) getSystemService(LOCATION_SERVICE);
            Location location = manager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (location == null) location = manager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            if (location == null) return "Location unavailable. Approve location permission and enable location services.";
            return "{\\\"lat\\\":" + location.getLatitude() + ",\\\"lng\\\":" + location.getLongitude() + ",\\\"accuracy\\\":" + location.getAccuracy() + "}";
        } catch (SecurityException error) { return "Location permission is required."; } catch (Exception error) { return "Locate failed: " + safe(error.getMessage()); }
    }

    private String installApk(String apkUrl) {
        try {
            if (apkUrl.length() == 0) return "Missing apkUrl";
            File apk = new File(getCacheDir(), "cp-install.apk");
            downloadToFile(apkUrl, apk);
            Uri uri = FileProvider.getUriForFile(this, "com.cpdevice.agent.fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(intent);
            return "APK downloaded. Android Package Installer opened for user approval.";
        } catch (Exception error) { return "Install failed: " + safe(error.getMessage()); }
    }

    private String listFiles(String requestedPath) {
        try {
            File dir = resolveFile(requestedPath);
            if (!dir.exists() || !dir.isDirectory()) return "{\\\"files\\\":[]}";
            File[] files = dir.listFiles();
            StringBuilder json = new StringBuilder("{\\\"files\\\":[");
            if (files != null) {
                int count = 0;
                for (File file : files) {
                    if (count++ > 0) json.append(",");
                    json.append("{\\\"name\\\":\\\"").append(safe(file.getName())).append("\\\",\\\"path\\\":\\\"").append(safe(file.getAbsolutePath())).append("\\\",\\\"directory\\\":").append(file.isDirectory()).append(",\\\"size\\\":").append(file.isDirectory() ? 0 : file.length()).append("}");
                    if (count >= 200) break;
                }
            }
            json.append("]}");
            return json.toString();
        } catch (Exception error) { return "File list failed: " + safe(error.getMessage()); }
    }

    private String exportFile(String requestedPath, String commandId) {
        try {
            File file = resolveFile(requestedPath);
            if (!file.exists() || !file.isFile()) return "File not found or not readable";
            uploadFile(file, commandId);
            return "Exported " + file.getName() + " (" + file.length() + " bytes)";
        } catch (Exception error) { return "Export failed: " + safe(error.getMessage()); }
    }

    private File resolveFile(String requestedPath) {
        if (requestedPath == null || requestedPath.length() == 0 || "/sdcard".equals(requestedPath)) return Environment.getExternalStorageDirectory();
        return new File(requestedPath);
    }

    private void downloadToFile(String fileUrl, File destination) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(fileUrl).openConnection();
        conn.setRequestProperty("Authorization", "Bearer " + token());
        try (FileOutputStream out = new FileOutputStream(destination); java.io.InputStream in = conn.getInputStream()) {
            byte[] buffer = new byte[8192]; int read; while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        }
    }

    private void uploadFile(File file, String commandId) throws Exception {
        URL url = new URL(serverUrl() + "/api/device/" + deviceId() + "/files");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Authorization", "Bearer " + token());
        conn.setRequestProperty("Content-Type", "application/octet-stream");
        conn.setRequestProperty("X-File-Name", file.getName());
        conn.setRequestProperty("X-Command-Id", commandId);
        conn.setDoOutput(true);
        try (OutputStream out = conn.getOutputStream(); FileInputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[8192]; int read; while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        }
        conn.getResponseCode();
    }

    private String textValue(String text, String key, int from, String fallback) {
        String marker = "\\\"" + key + "\\\":\\\"";
        int index = text.indexOf(marker, from);
        if (index < 0) return fallback;
        int start = index + marker.length();
        int end = text.indexOf("\\\"", start);
        if (end < 0) return fallback;
        return text.substring(start, end).replace("\\\\/", "/").replace("\\\\\"", "\"");
    }

    private int numberAfter(String text, String marker, int from, int fallback) {
        int index = text.indexOf(marker, from);
        if (index < 0) return fallback;
        int start = index + marker.length();
        int end = start;
        while (end < text.length() && Character.isDigit(text.charAt(end))) end++;
        try { return Integer.parseInt(text.substring(start, end)); } catch (Exception ignored) { return fallback; }
    }

    private String request(String method, String path, String body) throws Exception {
        URL url = new URL(serverUrl() + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(method);
        conn.setRequestProperty("Authorization", "Bearer " + token());
        conn.setRequestProperty("Content-Type", "application/json");
        if (body != null) {
            conn.setDoOutput(true);
            try (OutputStream os = conn.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }
        }
        BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getResponseCode() >= 400 ? conn.getErrorStream() : conn.getInputStream()));
        StringBuilder out = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) out.append(line);
        return out.toString();
    }

    private String serverUrl() { return prefs.getString("serverUrl", "https://admin-device-management.vercel.app").replaceAll("/$", ""); }
    private String deviceId() { return prefs.getString("deviceId", ""); }
    private String token() { return prefs.getString("deviceToken", ""); }
    private String safe(String value) { return value == null ? "" : value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " "); }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel("cp-device", "CP DEVICE Agent", NotificationManager.IMPORTANCE_LOW);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    private Notification notification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, "cp-device") : new Notification.Builder(this);
        return builder.setContentTitle("CP DEVICE Agent").setContentText("Connected to control server").setSmallIcon(android.R.drawable.stat_sys_upload_done).build();
    }
}






