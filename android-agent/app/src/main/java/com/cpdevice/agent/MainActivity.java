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
import android.os.UserManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public class MainActivity extends Activity {
    public static final String ACTION_START_SCREEN = "com.cpdevice.agent.START_SCREEN";
    private static final int SCREEN_CAPTURE_REQUEST = 4401;
    private static final int PROVISION_OWNER_REQUEST = 4402;
    private EditText serverUrl;
    private EditText liveServerUrl;
    private EditText deviceId;
    private EditText deviceToken;
    private TextView status;

    // Keep refs to tamper-risk buttons so onResume can refresh them
    private Button adminBtn;
    private Button accessibilityBtn;
    private Button cameraBtn;
    private Button locationBtn;
    private Button phoneInfoBtn;
    private Button filesBtn;
    private Button overlayBtn;
    private Button batteryBtn;
    private Button provisionOwnerBtn;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(false);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(32, 32, 32, 96);
        layout.setGravity(Gravity.CENTER_HORIZONTAL);
        TextView title = new TextView(this);
        title.setText(getString(com.cpdevice.agent.R.string.app_full_name));
        title.setTextSize(22);
        layout.addView(title);
        TextView tagline = new TextView(this);
        tagline.setText(getString(com.cpdevice.agent.R.string.app_tagline));
        tagline.setTextSize(16);
        tagline.setGravity(Gravity.CENTER_HORIZONTAL);
        tagline.setPadding(0, 4, 0, 24);
        layout.addView(tagline);
        TextView disclosureTitle = new TextView(this);
        disclosureTitle.setText(getString(com.cpdevice.agent.R.string.enterprise_disclosure_title));
        disclosureTitle.setTextSize(18);
        layout.addView(disclosureTitle);
        TextView disclosure = new TextView(this);
        disclosure.setText(getString(com.cpdevice.agent.R.string.enterprise_disclosure_body));
        disclosure.setPadding(0, 12, 0, 20);
        layout.addView(disclosure);
        status = new TextView(this);
        status.setPadding(0, 0, 0, 16);
        layout.addView(status);
        serverUrl = input("Control Server URL", "https://shied.onrender.com");
        liveServerUrl = input("Live WebSocket Server URL", "https://shied.onrender.com");
        deviceId = input("Device ID", "");
        deviceToken = input("Device Token", "");
        android.content.SharedPreferences saved = getSharedPreferences("cp-device", Context.MODE_PRIVATE);
        serverUrl.setText(saved.getString("serverUrl", serverUrl.getText().toString()));
        liveServerUrl.setText(saved.getString("liveServerUrl", saved.getString("serverUrl", liveServerUrl.getText().toString())));
        deviceId.setText(saved.getString("deviceId", ""));
        deviceToken.setText(saved.getString("deviceToken", ""));
        adminBtn        = button("Enable Device Admin / Check Owner", view -> requestDeviceAdmin());
        accessibilityBtn = button("Enable Accessibility Control", view -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        cameraBtn       = button("Allow Camera", view -> { if (Build.VERSION.SDK_INT >= 23) requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS}, 41); });
        locationBtn     = button("Allow Location", view -> { if (Build.VERSION.SDK_INT >= 23) requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, 42); });
        phoneInfoBtn    = button("Allow Phone/SIM Info", view -> requestPhoneInfoPermissions());
        filesBtn        = button("Allow File Access", view -> requestAllFilesAccess());
        overlayBtn      = button("Allow Owner Message Overlay", view -> requestOverlayPermission());
        batteryBtn      = button("Allow Background Running", view -> requestBatteryOptimizationExemption());
        provisionOwnerBtn = button("Provision as Device Owner (fresh device)", view -> attemptProvisionOwner());
        Button screen   = button("Start Live Screen", view -> requestScreenCapture());
        Button start    = button("Start Agent", view -> startAgent());
        layout.addView(adminBtn);
        layout.addView(accessibilityBtn);
        layout.addView(cameraBtn);
        layout.addView(locationBtn);
        layout.addView(phoneInfoBtn);
        layout.addView(filesBtn);
        layout.addView(overlayBtn);
        layout.addView(batteryBtn);
        layout.addView(provisionOwnerBtn);
        layout.addView(screen);
        layout.addView(start);
        Button site = button("Go to site", view -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://android-device-management.vercel.app"))));
        LinearLayout.LayoutParams siteParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        siteParams.setMargins(0, 24, 0, 72);
        layout.addView(site, siteParams);
        scrollView.addView(layout);
        setContentView(scrollView);
        handleIntent(getIntent());
        refreshProtectionStatus();
    }

    @Override protected void onResume() {
        super.onResume();
        // Re-check every time the user returns from Settings so the UI
        // reflects the current Device Owner / Admin state immediately.
        refreshProtectionStatus();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent != null && ACTION_START_SCREEN.equals(intent.getAction())) {
            requestScreenCapture();
            return;
        }
        applyEnrollmentIntent(intent);
    }

    /**
     * Called on onCreate and every onResume.
     * - If Device Owner + enrolled: lock tamper-risk buttons.
     * - If Device Admin only: show warning and leave buttons active so setup can continue.
     * - If neither: show setup prompt.
     */
    private void refreshProtectionStatus() {
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName receiver = new ComponentName(this, CpDeviceAdminReceiver.class);
        boolean isOwner  = dpm != null && dpm.isDeviceOwnerApp(getPackageName());
        boolean isAdmin  = dpm != null && dpm.isAdminActive(receiver);
        android.content.SharedPreferences prefs = getSharedPreferences("cp-device", Context.MODE_PRIVATE);
        boolean isEnrolled = !prefs.getString("deviceId", "").isEmpty()
                          && !prefs.getString("deviceToken", "").isEmpty();

        if (isOwner && isEnrolled) {
            // Full tamper-resistant protection active — lock all tamper-risk buttons.
            lockButtons(true);
            status.setText(
                "DEVICE OWNER ACTIVE — Full tamper protection enabled.\n\n" +
                "Blocked: Device Admin toggle | Permission revocation | " +
                "Clear Data | Force Stop | Settings factory reset | Recovery wipe (FRP).\n\n" +
                "NOTE: Android system design does not allow any app to block the " +
                "Accessibility toggle — the dashboard will alert if it is disabled.\n\n" +
                "All protections release ONLY when this device is deleted from the dashboard."
            );
            // Ensure enforceOwnerSecurity is re-applied immediately (also runs every heartbeat)
            enforceOwnerSecurity(dpm, receiver);
        } else if (isAdmin && isEnrolled) {
            // Device Admin only — reduced protection, buttons stay usable for setup
            lockButtons(false);
            status.setText(
                "DEVICE ADMIN active — Uninstall is blocked.\n\n" +
                "WARNING: Device Admin does NOT block the Device Admin toggle, " +
                "permission revocation, Clear Data, Force Stop, or factory reset.\n\n" +
                "To enable FULL tamper protection, this device must be provisioned " +
                "as DEVICE OWNER. Use the 'Provision as Device Owner' button (requires " +
                "no Google accounts on device), OR run via ADB:\n" +
                "  adb shell dpm set-device-owner \\\n" +
                "  com.cpdevice.agent/.CpDeviceAdminReceiver\n\n" +
                "Remove all Google accounts from this device first if ADB fails."
            );
        } else {
            lockButtons(false);
            status.setText("Install and enroll via the dashboard link, then provision as Device Owner for full theft-resistant protection.");
        }
    }

    /**
     * Lock or unlock tamper-risk buttons.
     * locked=true: buttons disabled + greyed out (Device Owner active).
     * locked=false: buttons restored to normal.
     */
    private void lockButtons(boolean locked) {
        Button[] protected_buttons = new Button[]{ adminBtn, accessibilityBtn, cameraBtn, locationBtn, phoneInfoBtn, filesBtn, overlayBtn, batteryBtn };
        for (Button b : protected_buttons) {
            if (b == null) continue;
            b.setEnabled(!locked);
            b.setAlpha(locked ? 0.3f : 1.0f);
        }
        // Provision button: only show when NOT yet Device Owner
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        boolean isOwner = dpm != null && dpm.isDeviceOwnerApp(getPackageName());
        if (provisionOwnerBtn != null) provisionOwnerBtn.setVisibility(isOwner ? View.GONE : View.VISIBLE);
    }

    private Button button(String text, android.view.View.OnClickListener listener) {
        Button b = new Button(this);
        b.setText(text);
        b.setOnClickListener(listener);
        return b;
    }

    private EditText input(String hint, String value) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setText(value);
        e.setSingleLine(true);
        return e;
    }

    private void applyEnrollmentIntent(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"cpdevice".equals(data.getScheme()) || !"enroll".equals(data.getHost())) return;
        serverUrl.setText(value(data, "serverUrl", serverUrl.getText().toString()));
        liveServerUrl.setText(value(data, "liveServerUrl", serverUrl.getText().toString()));
        deviceId.setText(value(data, "deviceId", ""));
        deviceToken.setText(value(data, "token", ""));
        startAgent();
        requestDeviceAdmin();
    }

    private String value(Uri uri, String key, String fallback) {
        String v = uri.getQueryParameter(key);
        return v == null ? fallback : v;
    }

    private void requestDeviceAdmin() {
        ComponentName receiver = new ComponentName(this, CpDeviceAdminReceiver.class);
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm != null && dpm.isDeviceOwnerApp(getPackageName())) {
            enforceOwnerSecurity(dpm, receiver);
            refreshProtectionStatus();
            return;
        }
        if (dpm != null && dpm.isAdminActive(receiver)) {
            refreshProtectionStatus();
            return;
        }
        Intent intent = new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
        intent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, receiver);
        intent.putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION,
            "Enable Aegis Eye Agent as Device Admin. For full theft-resistant protection " +
            "(blocking Device Admin toggle, permissions, Clear Data, Force Stop, and " +
            "factory reset), this app must be provisioned as Android Device Owner via ADB: " +
            "adb shell dpm set-device-owner com.cpdevice.agent/.CpDeviceAdminReceiver");
        startActivity(intent);
    }

    /**
     * Attempt managed provisioning to become Device Owner.
     * This only works on factory-fresh devices with no accounts,
     * or via NFC/QR during the device setup wizard.
     */
    private void attemptProvisionOwner() {
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm != null && dpm.isDeviceOwnerApp(getPackageName())) {
            status.setText("This device is already Device Owner. All tamper protections are active.");
            return;
        }
        try {
            ComponentName admin = new ComponentName(this, CpDeviceAdminReceiver.class);
            Intent provisionIntent = new Intent(DevicePolicyManager.ACTION_PROVISION_MANAGED_DEVICE);
            provisionIntent.putExtra(DevicePolicyManager.EXTRA_PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME, admin);
            provisionIntent.putExtra(DevicePolicyManager.EXTRA_PROVISIONING_SKIP_ENCRYPTION, true);
            if (provisionIntent.resolveActivity(getPackageManager()) != null) {
                startActivityForResult(provisionIntent, PROVISION_OWNER_REQUEST);
            } else {
                status.setText(
                    "Managed provisioning is not available on this device in its current state.\n\n" +
                    "To provision as Device Owner, use ADB:\n" +
                    "1. Enable Developer Options (tap Build Number 7 times)\n" +
                    "2. Enable USB Debugging\n" +
                    "3. Remove all Google accounts from Settings\n" +
                    "4. Run: adb shell dpm set-device-owner com.cpdevice.agent/.CpDeviceAdminReceiver\n" +
                    "5. Re-add your Google account after provisioning."
                );
            }
        } catch (Exception e) {
            status.setText(
                "Provisioning unavailable on this device.\n\n" +
                "Use ADB to set Device Owner:\n" +
                "adb shell dpm set-device-owner com.cpdevice.agent/.CpDeviceAdminReceiver\n\n" +
                "Remove all Google accounts first if this command fails."
            );
        }
    }

    private void requestOverlayPermission() {
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
            status.setText("Grant Overlay on apps so Lost Mode owner messages can appear over the current screen.");
            return;
        }
        status.setText("Overlay on apps is already allowed for Lost Mode owner messages.");
    }

    private void requestAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                intent.setData(Uri.parse("package:" + getPackageName()));
                startActivity(intent);
                status.setText("Grant All files access to browse folders and export real files from device storage.");
                return;
            } catch (Exception ignored) { }
        }
        startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
        status.setText("Grant file access to browse folders and export real files from device storage.");
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
        } else if (requestCode == PROVISION_OWNER_REQUEST) {
            if (resultCode == RESULT_OK) {
                // Provisioning succeeded — apply full owner security immediately
                DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
                ComponentName receiver = new ComponentName(this, CpDeviceAdminReceiver.class);
                if (dpm != null && dpm.isDeviceOwnerApp(getPackageName())) {
                    enforceOwnerSecurity(dpm, receiver);
                }
                refreshProtectionStatus();
            } else {
                status.setText(
                    "Device Owner provisioning was not completed.\n\n" +
                    "If this device already has Google accounts, use ADB instead:\n" +
                    "adb shell dpm set-device-owner com.cpdevice.agent/.CpDeviceAdminReceiver"
                );
            }
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
                .putString("liveServerUrl", liveServerUrl.getText().toString().trim().isEmpty() ? serverUrl.getText().toString().trim() : liveServerUrl.getText().toString().trim())
                .putString("deviceId", id)
                .putString("deviceToken", token)
                .putString("androidId", Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID))
                .apply();
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName receiver = new ComponentName(this, CpDeviceAdminReceiver.class);
        if (dpm != null && dpm.isDeviceOwnerApp(getPackageName())) enforceOwnerSecurity(dpm, receiver);
        startForegroundService(new Intent(this, AgentService.class));
        refreshProtectionStatus();
        return true;
    }

    private void enforceOwnerSecurity(DevicePolicyManager dpm, ComponentName receiver) {
        try { dpm.setUninstallBlocked(receiver, getPackageName(), true); } catch (Exception ignored) { }
        if (Build.VERSION.SDK_INT >= 23) {
            try { dpm.setPermissionPolicy(receiver, DevicePolicyManager.PERMISSION_POLICY_AUTO_GRANT); } catch (Exception ignored) { }
        }
        addRestriction(dpm, receiver, UserManager.DISALLOW_APPS_CONTROL);
        addRestriction(dpm, receiver, UserManager.DISALLOW_SAFE_BOOT);
        addRestriction(dpm, receiver, UserManager.DISALLOW_FACTORY_RESET);
        addRestriction(dpm, receiver, UserManager.DISALLOW_ADD_USER);
        addRestriction(dpm, receiver, UserManager.DISALLOW_REMOVE_USER);
        addRestriction(dpm, receiver, UserManager.DISALLOW_DEBUGGING_FEATURES);
        addRestriction(dpm, receiver, UserManager.DISALLOW_USB_FILE_TRANSFER);
        addRestriction(dpm, receiver, UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA);
        if (Build.VERSION.SDK_INT >= 28) {
            try { dpm.setLogoutEnabled(receiver, false); } catch (Exception ignored) { }
        }
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                android.app.admin.FactoryResetProtectionPolicy frpPolicy =
                    new android.app.admin.FactoryResetProtectionPolicy.Builder()
                        .setFactoryResetProtectionEnabled(true)
                        .build();
                dpm.setFactoryResetProtectionPolicy(receiver, frpPolicy);
            } catch (Exception ignored) { }
        }
    }

    private void addRestriction(DevicePolicyManager dpm, ComponentName receiver, String restriction) {
        try { dpm.addUserRestriction(receiver, restriction); } catch (Exception ignored) { }
    }
}
