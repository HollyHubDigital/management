package com.cpdevice.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        SharedPreferences prefs = context.getSharedPreferences("cp-device", Context.MODE_PRIVATE);
        String deviceId = prefs.getString("deviceId", "");
        String deviceToken = prefs.getString("deviceToken", "");
        if (deviceId.isEmpty() || deviceToken.isEmpty()) return;
        Intent service = new Intent(context, AgentService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service);
        else context.startService(service);
    }
}