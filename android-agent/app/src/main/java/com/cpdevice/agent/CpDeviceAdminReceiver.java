package com.cpdevice.agent;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.widget.Toast;

public class CpDeviceAdminReceiver extends DeviceAdminReceiver {

    @Override
    public CharSequence onDisableRequested(Context context, Intent intent) {
        return "WARNING: Removing Aegis Eye Device Admin disables dashboard theft-protection. " +
               "This device enrolled record still exists on the dashboard. " +
               "Only dashboard Delete/Unenroll should release management. " +
               "If you are the device owner, disable from the dashboard first.";
    }

    @Override
    public void onDisabled(Context context, Intent intent) {
        Toast.makeText(context,
            "Aegis Eye Admin disabled. Theft protection reduced. Agent will restart on next boot.",
            Toast.LENGTH_LONG).show();
        restartAgentIfEnrolled(context);
    }

    @Override
    public void onEnabled(Context context, Intent intent) {
        restartAgentIfEnrolled(context);
    }

    private void restartAgentIfEnrolled(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences("cp-device", Context.MODE_PRIVATE);
            if (!prefs.getString("deviceId", "").isEmpty() && !prefs.getString("deviceToken", "").isEmpty()) {
                Intent service = new Intent(context, AgentService.class);
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service);
                else context.startService(service);
            }
        } catch (Exception ignored) { }
    }
}