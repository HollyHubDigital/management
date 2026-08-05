package com.cpdevice.agent;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

public class CpDeviceAdminReceiver extends DeviceAdminReceiver {
    @Override
    public CharSequence onDisableRequested(Context context, Intent intent) {
        return "Removing CP DEVICE Admin disables dashboard-managed protection. For theft-resistant enrollment, provision CP DEVICE as Android Device Owner; only dashboard Delete/Unenroll should release management.";
    }

    @Override
    public void onDisabled(Context context, Intent intent) {
        Toast.makeText(context, "CP DEVICE Admin was disabled. Dashboard protection is reduced until Device Owner/Admin is restored.", Toast.LENGTH_LONG).show();
    }
}
