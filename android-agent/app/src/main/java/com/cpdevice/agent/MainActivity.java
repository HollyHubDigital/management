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
        title.setText("CP DEVICE Agent Enrollment");
        title.setTextSize(22);
        layout.addView(title);
        status = new TextView(this);
        status.setText("Install, enroll, then approve Device Admin, Accessibility, Camera, and Screen Capture.");
        layout.addView(status);
        serverUrl = input("Control Server URL", "https://admin-device-management.vercel.app");
        deviceId = input("Device ID", "");
        deviceToken = input("Device Token", "");
        layout.addView(serverUrl); layout.addView(deviceId); layout.addView(deviceToken);
        Button admin = button("Enable Device Admin", view -> requestDeviceAdmin());
        Button accessibility = button("Enable Accessibility Control", view -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        Button camera = button("Allow Camera", view -> { if (Build.VERSION.SDK_INT >= 23) requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.POST_NOTIFICATIONS}, 41); });
        Button files = button("Allow File Access", view -> startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)));
        Button screen = button("Start Live Screen", view -> requestScreenCapture());
        Button start = button("Start Agent", view -> startAgent());
        layout.addView(admin); layout.addView(accessibility); layout.addView(camera); layout.addView(files); layout.addView(screen); layout.addView(start);
        setContentView(layout);
        applyEnrollmentIntent(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); applyEnrollmentIntent(intent); }

    private Button button(String text, android.view.View.OnClickListener listener) { Button b = new Button(this); b.setText(text); b.setOnClickListener(listener); return b; }
    private EditText input(String hint, String value) { EditText e = new EditText(this); e.setHint(hint); e.setText(value); e.setSingleLine(true); return e; }

    private void applyEnrollmentIntent(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"cpdevice".equals(data.getScheme()) || !"enroll".equals(data.getHost())) return;
        serverUrl.setText(value(data, "serverUrl", serverUrl.getText().toString()));
        deviceId.setText(value(data, "deviceId", ""));
        deviceToken.setText(value(data, "token", ""));
        status.setText("Enrollment received. Approve Device Admin, then enable Accessibility and Start Live Screen.");
        startAgent();
        requestDeviceAdmin();
    }

    private String value(Uri uri, String key, String fallback) { String v = uri.getQueryParameter(key); return v == null ? fallback : v; }

    private void requestDeviceAdmin() {
        ComponentName receiver = new ComponentName(this, CpDeviceAdminReceiver.class);
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm != null && dpm.isAdminActive(receiver)) { status.setText("Device Admin is active."); return; }
        Intent intent = new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
        intent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, receiver);
        intent.putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Enable CP DEVICE management for this authorized device.");
        startActivity(intent);
    }

    private void requestScreenCapture() {
        startAgent();
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

    private void startAgent() {
        getSharedPreferences("cp-device", Context.MODE_PRIVATE).edit()
                .putString("serverUrl", serverUrl.getText().toString().trim())
                .putString("deviceId", deviceId.getText().toString().trim())
                .putString("deviceToken", deviceToken.getText().toString().trim())
                .putString("androidId", Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID))
                .apply();
        startForegroundService(new Intent(this, AgentService.class));
        status.setText("Agent started.");
    }
}

