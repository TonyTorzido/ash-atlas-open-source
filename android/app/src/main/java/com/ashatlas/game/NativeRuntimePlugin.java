package com.ashatlas.game;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.UUID;

@CapacitorPlugin(name = "NativeRuntime")
public final class NativeRuntimePlugin extends Plugin {
    // A bridge/Activity recreation must not look like a new native process.
    private static final String PROCESS_ID = UUID.randomUUID().toString();
    private static final String RECOVERY_PREFERENCES = "ash-atlas-auth-recovery";
    private static final String LOGOUT_PENDING_KEY = "logout-pending";

    @PluginMethod
    public void getProcessIdentity(PluginCall call) {
        JSObject result = new JSObject();
        result.put("id", PROCESS_ID);
        call.resolve(result);
    }

    @PluginMethod
    public void getShellCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        // Firebase initializes only when the build bundled google-services.json.
        // Crashlytics calls are meaningful only then.
        result.put("firebaseConfigured", !FirebaseApp.getApps(getContext()).isEmpty());
        call.resolve(result);
    }

    @PluginMethod
    public void getLogoutPending(PluginCall call) {
        try {
            boolean pending = getContext().getSharedPreferences(RECOVERY_PREFERENCES, Context.MODE_PRIVATE)
                .getBoolean(LOGOUT_PENDING_KEY, false);
            JSObject result = new JSObject();
            result.put("pending", pending);
            call.resolve(result);
        } catch (RuntimeException unavailable) {
            call.reject("Sign-out recovery could not be read");
        }
    }

    @PluginMethod
    public void setLogoutPending(PluginCall call) {
        Boolean pending = call.getBoolean("pending");
        if (pending == null) {
            call.reject("A pending sign-out flag is required");
            return;
        }
        try {
            boolean saved = getContext().getSharedPreferences(RECOVERY_PREFERENCES, Context.MODE_PRIVATE)
                .edit().putBoolean(LOGOUT_PENDING_KEY, pending).commit();
            if (saved) call.resolve();
            else call.reject("Sign-out recovery could not be saved");
        } catch (RuntimeException unavailable) {
            call.reject("Sign-out recovery could not be saved");
        }
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        if (getActivity() == null) {
            call.reject("App settings could not be opened");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                Intent settings = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                settings.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
                getActivity().startActivity(settings);
                call.resolve();
            } catch (ActivityNotFoundException unavailable) {
                try {
                    Intent details = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    details.setData(Uri.fromParts("package", getContext().getPackageName(), null));
                    getActivity().startActivity(details);
                    call.resolve();
                } catch (RuntimeException failure) {
                    call.reject("App settings could not be opened");
                }
            } catch (RuntimeException failure) {
                call.reject("App settings could not be opened");
            }
        });
    }

    @PluginMethod
    public void pausePushAutoInit(PluginCall call) {
        try {
            FirebaseMessaging.getInstance().setAutoInitEnabled(false);
            call.resolve();
        } catch (IllegalStateException unavailable) {
            // A default-off artifact may intentionally have no public Firebase config.
            // There is no Firebase instance whose automatic initialization can run.
            call.resolve();
        }
    }
}
