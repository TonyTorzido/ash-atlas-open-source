package com.ashatlas.game;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.Nullable;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.play.core.appupdate.AppUpdateInfo;
import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.appupdate.AppUpdateOptions;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.UpdateAvailability;

/**
 * Store-update gate. JS decides when an update is required (server-driven
 * minimum store build); this plugin only reports what Play knows and runs the
 * Play In-App Updates immediate flow or opens the store listing.
 */
@CapacitorPlugin(name = "StoreUpdate")
public final class StoreUpdatePlugin extends Plugin {
    private AppUpdateManager appUpdateManager;
    private ActivityResultLauncher<IntentSenderRequest> updateLauncher;
    @Nullable private PluginCall updateCall;

    @Override
    public void load() {
        appUpdateManager = AppUpdateManagerFactory.create(getContext());
        // Registered while the Activity is being created, as the Activity Result API requires.
        updateLauncher = getBridge().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            this::onUpdateResult
        );
    }

    @PluginMethod
    public void getUpdateInfo(PluginCall call) {
        appUpdateManager.getAppUpdateInfo()
            .addOnSuccessListener(info -> call.resolve(infoJson(info)))
            .addOnFailureListener(error -> {
                // Sideloaded/dev installs and devices without Play report an error here.
                JSObject result = baseInfo();
                result.put("updateAvailability", "unknown");
                result.put("error", error.getMessage());
                call.resolve(result);
            });
    }

    @PluginMethod
    public void performImmediateUpdate(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("The update screen could not be opened", "UNAVAILABLE");
            return;
        }
        appUpdateManager.getAppUpdateInfo()
            .addOnSuccessListener(info -> {
                int availability = info.updateAvailability();
                boolean resumable = availability == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS;
                if (!resumable && (availability != UpdateAvailability.UPDATE_AVAILABLE ||
                    !info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE))) {
                    JSObject result = new JSObject();
                    result.put("result", "notAvailable");
                    call.resolve(result);
                    return;
                }
                synchronized (this) {
                    if (updateCall != null) {
                        call.reject("An update is already in progress", "UPDATE_IN_PROGRESS");
                        return;
                    }
                    updateCall = call;
                }
                boolean started;
                try {
                    started = appUpdateManager.startUpdateFlowForResult(
                        info, updateLauncher, AppUpdateOptions.newBuilder(AppUpdateType.IMMEDIATE).build());
                } catch (RuntimeException failure) {
                    started = false;
                }
                if (!started) {
                    PluginCall pending = takeUpdateCall();
                    if (pending != null) pending.reject("The update could not be started", "UPDATE_FAILED");
                }
            })
            .addOnFailureListener(error -> call.reject("Google Play updates are unavailable", "UNAVAILABLE"));
    }

    @PluginMethod
    public void openStoreListing(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("The store could not be opened", "UNAVAILABLE");
            return;
        }
        String packageName = getContext().getPackageName();
        activity.runOnUiThread(() -> {
            try {
                Intent market = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + packageName));
                market.setPackage("com.android.vending");
                activity.startActivity(market);
                call.resolve();
            } catch (ActivityNotFoundException noPlayStore) {
                try {
                    activity.startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://play.google.com/store/apps/details?id=" + packageName)));
                    call.resolve();
                } catch (ActivityNotFoundException unavailable) {
                    call.reject("The store could not be opened", "UNAVAILABLE");
                }
            }
        });
    }

    private void onUpdateResult(ActivityResult activityResult) {
        PluginCall call = takeUpdateCall();
        if (call == null) return;
        JSObject result = new JSObject();
        int code = activityResult.getResultCode();
        if (code == Activity.RESULT_OK) result.put("result", "updated");
        else if (code == Activity.RESULT_CANCELED) result.put("result", "cancelled");
        else result.put("result", "failed");
        call.resolve(result);
    }

    @Nullable
    private synchronized PluginCall takeUpdateCall() {
        PluginCall call = updateCall;
        updateCall = null;
        return call;
    }

    private JSObject baseInfo() {
        JSObject result = new JSObject();
        result.put("platform", "android");
        try {
            result.put("currentVersionCode", PackageInfoCompat.getLongVersionCode(getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0)));
        } catch (Exception unavailable) {
            // Version code is informative only.
        }
        return result;
    }

    private JSObject infoJson(AppUpdateInfo info) {
        JSObject result = baseInfo();
        String availability;
        switch (info.updateAvailability()) {
            case UpdateAvailability.UPDATE_AVAILABLE: availability = "available"; break;
            case UpdateAvailability.UPDATE_NOT_AVAILABLE: availability = "notAvailable"; break;
            case UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS: availability = "inProgress"; break;
            default: availability = "unknown";
        }
        result.put("updateAvailability", availability);
        result.put("availableVersionCode", info.availableVersionCode());
        result.put("immediateAllowed", info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE));
        result.put("flexibleAllowed", info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE));
        result.put("installStatus", info.installStatus());
        result.put("updatePriority", info.updatePriority());
        Integer staleness = info.clientVersionStalenessDays();
        if (staleness != null) result.put("clientVersionStalenessDays", staleness.intValue());
        return result;
    }
}
