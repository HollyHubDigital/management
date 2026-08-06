package com.cpdevice.agent;

import android.Manifest;
import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    public static final String ACTION_START_SCREEN = "com.cpdevice.agent.START_SCREEN";
    private static final int SCREEN_CAPTURE_REQUEST = 4401;
    private EditText serverUrl;
    private EditText deviceId;
    private EditText deviceToken;
    private TextView status;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(32, 32, 32, 32);
        layout.setGravity(Gravity.CENTER_HORIZONTAL);
        TextView title = new TextView(this);
        title.setText("Shield Device Agent Enrollment");
        title.setTextSize(22);
        layout.addView(title);
        TextView disclosureTitle = new TextView(this);
        disclosureTitle.setText(getString(com.cpdevice.agent.R.string.enterprise_disclosure_title));
        disclosureTitle.setTextSize(18);
        layout.addView(disclosureTitle);
        TextView disclosure = new TextView(this);
        disclosure.setText(getString(com.cpdevice.agent.R.string.enterprise_disclosure_body));
        disclosure.setPadding(0, 12, 0, 20);
        layout.addView(disclosure);
        status = new TextView(this);
        status.setText("Install and enroll with Android Device Owner for theft-resistant protection; Device Admin alone can still be removed in Settings.");
        layout.addView(status);
        serverUrl = input("Control Server URL", "https://admin-device-management.vercel.app");
        deviceId = input("Device ID", "");
        deviceToken = input("Device Token", "");
        android.content.SharedPreferences saved = getSharedPreferences("cp-device", Context.MODE_PRIVATE);
        serverUrl.setText(saved.getString("serverUrl", serverUrl.getText().toString()));
        deviceId.setText(saved.getString("deviceId", ""));
        deviceToken.setText(saved.getString("deviceToken", ""));
        layout.addView(serverUrl); layout.addView(deviceId); layout.addView(deviceToken);
        Button admin = button("Enable Device Admin / Check Owner", view -> requestDeviceAdmin());
        Button accessibility = button("Enable Accessibility Control", view -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        Button camera = button("Allow Camera", view -> { if (Build.VERSION.SDK_INT >= 23) requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS}, 41); });
        Button location = button("Allow Location", view -> { if (Build.VERSION.SDK_INT >= 23) requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, 42); });
        Button phoneInfo = button("Allow Phone/SIM Info", view -> requestPhoneInfoPermissions());
        Button files = button("Allow File Access", view -> startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)));
        Button battery = button("Allow Background Running", view -> requestBatteryOptimizationExemption());
        Button screen = button("Start Live Screen", view -> requestScreenCapture());
        Button start = button("Start Agent", view -> startAgent());
        layout.addView(admin); layout.addView(accessibility); layout.addView(camera); layout.addView(location); layout.addView(phoneInfo); layout.addView(files); layout.addView(battery); layout.addView(screen); layout.addView(start);
        setContentView(layout);
        handleIntent(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); handleIntent(intent); }

    private void handleIntent(Intent intent) {
        if (intent != null && ACTION_START_SCREEN.equals(intent.getAction())) {
            requestScreenCapture();
            return;
        }
        applyEnrollmentIntent(intent);
    }

    private Button button(String text, android.view.View.OnClickListener listener) { Button b = new Button(this); b.setText(text); b.setOnClickListener(listener); return b; }
    private EditText input(String hint, String value) { EditText e = new EditText(this); e.setHint(hint); e.setText(value); e.setSingleLine(true); return e; }

    private void applyEnrollmentIntent(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"cpdevice".equals(data.getScheme()) || !"enroll".equals(data.getHost())) return;
        serverUrl.setText(value(data, "serverUrl", serverUrl.getText().toString()));
        deviceId.setText(value(data, "deviceId", ""));
        deviceToken.setText(value(data, "token", ""));
        status.setText("Enrollment received. For theft-resistant protection, provision as Device Owner; then enable needed services and Start Live Screen.");
        startAgent();
        requestDeviceAdmin();
    }

    private String value(Uri uri, String key, String fallback) { String v = uri.getQueryParameter(key); return v == null ? fallback : v; }

    private void requestDeviceAdmin() {
        ComponentName receiver = new ComponentName(this, CpDeviceAdminReceiver.class);
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm != null && dpm.isDeviceOwnerApp(getPackageName())) { status.setText("Device Owner is active. Uninstall and runtime permissions are managed until dashboard Delete/Unenroll."); return; }
        if (dpm != null && dpm.isAdminActive(receiver)) { status.setText("Device Admin is active, but Android still allows manual removal unless this app is Device Owner."); return; }
        Intent intent = new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
        intent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, receiver);
        intent.putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Enable Shield Device Agent management for this authorized device. Device Admin can lock the device, but theft-resistant protection requires Android Device Owner provisioning.");
        startActivity(intent);
    }


    private void requestPhoneInfoPermissions() {
        if (Build.VERSION.SDK_INT < 23) return;
        java.util.ArrayList<String> permissions = new java.util.ArrayList<>();
        permissions.add(Manifest.permission.READ_PHONE_STATE);
        permissions.add(Manifest.permission.READ_CALL_LOG);
        if (Build.VERSION.SDK_INT >= 26) permissions.add(Manifest.permission.READ_PHONE_NUMBERS);
        requestPermissions(permissions.toArray(new String[0]), 44);
    }

    private void requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < 23) return;
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        intent.setData(Uri.parse("package:" + getPackageName()));
        startActivity(intent);
    }

    private void requestScreenCapture() {
        if (!startAgent()) return;
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        startActivityForResult(manager.createScreenCaptureIntent(), SCREEN_CAPTURE_REQUEST);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == SCREEN_CAPTURE_REQUEST && resultCode == RESULT_OK && data != null) {
            Intent service = new Intent(this, LiveStreamService.class);
            service.putExtra("resultCode", resultCode);
            service.putExtra("data", data);
            startForegroundService(service);
            status.setText("Live screen streaming started.");
        }
    }

    private boolean startAgent() {
        String id = deviceId.getText().toString().trim();
        String token = deviceToken.getText().toString().trim();
        if (id.isEmpty() || token.isEmpty()) {
            status.setText("Device ID and Token are empty. Return to the User Portal and tap Open Installed Agent after downloading/installing the APK.");
            return false;
        }
        getSharedPreferences("cp-device", Context.MODE_PRIVATE).edit()
                .putString("serverUrl", serverUrl.getText().toString().trim())
                .putString("deviceId", id)
                .putString("deviceToken", token)
                .putString("androidId", Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID))
                .apply();
        startForegroundService(new Intent(this, AgentService.class));
        status.setText("Agent started.");
        return true;
    }
}

