package com.ashatlas.game;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.InstallSourceInfo;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorManager;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Debug;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.telephony.CellIdentityGsm;
import android.telephony.CellIdentityLte;
import android.telephony.CellIdentityWcdma;
import android.telephony.CellInfo;
import android.telephony.CellInfoGsm;
import android.telephony.CellInfoLte;
import android.telephony.CellInfoWcdma;
import android.telephony.TelephonyManager;
import android.util.Base64;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.location.CurrentLocationRequest;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.CancellationTokenSource;
import com.google.android.play.core.integrity.IntegrityManagerFactory;
import com.google.android.play.core.integrity.StandardIntegrityException;
import com.google.android.play.core.integrity.StandardIntegrityManager;
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider;
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import org.json.JSONArray;

/**
 * DeviceTrust (NATIVE_ANTISPOOF_BUILD_PLAN.md §8; JS contract at the top of
 * apps/client/src/native/nativeDeviceTrust.ts). Never requests permissions and
 * never prompts. Rejections use the contract's string codes. JS never hashes:
 * the Play Integrity requestHash is computed here from clientData.
 */
@CapacitorPlugin(name = "DeviceTrust")
public final class DeviceTrustPlugin extends Plugin {
    private static final int MAX_CLIENT_DATA = 4096;

    private FusedLocationProviderClient locationClient;
    private StandardIntegrityManager integrityManager;
    @Nullable private volatile StandardIntegrityTokenProvider integrityProvider;
    /** Static environment parts, computed once per process. */
    @Nullable private volatile JSObject staticEnvironment;

    @Override
    public void load() {
        locationClient = LocationServices.getFusedLocationProviderClient(getContext());
        integrityManager = IntegrityManagerFactory.createStandard(getContext());
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        boolean playServices = GoogleApiAvailability.getInstance()
            .isGooglePlayServicesAvailable(getContext()) == ConnectionResult.SUCCESS;
        JSObject result = new JSObject();
        result.put("v", 1);
        result.put("platform", "android");
        result.put("location", playServices && hasLocationPermission());
        result.put("playIntegrity", playServices);
        result.put("appAttest", false);
        result.put("deviceCheck", false);
        result.put("environment", true);
        if (isProbablyEmulator()) result.put("simulator", true);
        call.resolve(result);
    }

    @PluginMethod
    public void getCurrentFix(PluginCall call) {
        if (!hasLocationPermission()) {
            call.reject("Location permission is not granted", "PERMISSION_DENIED");
            return;
        }
        boolean highAccuracy = Boolean.TRUE.equals(call.getBoolean("enableHighAccuracy", false));
        long maximumAgeMs = Math.max(0, longOption(call, "maximumAgeMs", 0L));
        long timeoutMs = Math.max(1000, Math.min(60_000, longOption(call, "timeoutMs", 10_000L)));
        CurrentLocationRequest request = new CurrentLocationRequest.Builder()
            .setPriority(highAccuracy ? Priority.PRIORITY_HIGH_ACCURACY : Priority.PRIORITY_BALANCED_POWER_ACCURACY)
            .setMaxUpdateAgeMillis(maximumAgeMs)
            .setDurationMillis(timeoutMs)
            .build();
        long started = SystemClock.elapsedRealtime();
        CancellationTokenSource cancellation = new CancellationTokenSource();
        GnssSampler gnss = new GnssSampler();
        gnss.start();
        try {
            locationClient.getCurrentLocation(request, cancellation.getToken())
                .addOnSuccessListener(location -> {
                    JSObject gnssFields = gnss.stop();
                    if (location == null) {
                        boolean timedOut = SystemClock.elapsedRealtime() - started >= timeoutMs;
                        call.reject("No location fix", timedOut ? "TIMEOUT" : "LOCATION_UNAVAILABLE");
                        return;
                    }
                    JSObject fix = fixJson(location);
                    mergeInto(fix, gnssFields);
                    call.resolve(fix);
                })
                .addOnFailureListener(error -> {
                    gnss.stop();
                    if (error instanceof SecurityException) call.reject("Location permission is not granted", "PERMISSION_DENIED");
                    else call.reject("No location fix", "LOCATION_UNAVAILABLE");
                });
        } catch (SecurityException denied) {
            gnss.stop();
            call.reject("Location permission is not granted", "PERMISSION_DENIED");
        }
    }

    @PluginMethod
    public void getEnvironment(PluginCall call) {
        try {
            JSObject result = new JSObject();
            mergeInto(result, staticEnvironment());
            Context context = getContext();
            result.put("debuggerAttached", Debug.isDebuggerConnected());
            putSetting(result, "devOptions", Settings.Global.DEVELOPMENT_SETTINGS_ENABLED);
            putSetting(result, "adbEnabled", Settings.Global.ADB_ENABLED);
            putSetting(result, "autoTimeEnabled", Settings.Global.AUTO_TIME);
            Boolean vpn = vpnActive();
            if (vpn != null) result.put("vpnActive", vpn);
            try {
                TelephonyManager telephony = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
                if (telephony != null) {
                    result.put("simCountryIso", isoOrNull(telephony.getSimCountryIso()));
                    result.put("networkCountryIso", isoOrNull(telephony.getNetworkCountryIso()));
                }
            } catch (RuntimeException unavailable) {
                // omit
            }
            result.put("cellMccs", cellMccs());
            result.put("timeZone", TimeZone.getDefault().getID());
            result.put("locale", Locale.getDefault().toLanguageTag());
            call.resolve(result);
        } catch (RuntimeException failure) {
            call.reject("Environment is unavailable", "UNSUPPORTED");
        }
    }

    @PluginMethod
    public void prepareIntegrity(PluginCall call) {
        long projectNumber;
        try {
            projectNumber = Long.parseLong(call.getString("cloudProjectNumber", ""));
        } catch (NumberFormatException invalid) {
            call.reject("A numeric cloud project number is required", "INVALID_ARGUMENT");
            return;
        }
        integrityManager.prepareIntegrityToken(
                StandardIntegrityManager.PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(projectNumber).build())
            .addOnSuccessListener(provider -> {
                integrityProvider = provider;
                call.resolve();
            })
            .addOnFailureListener(error -> rejectIntegrity(call, error));
    }

    @PluginMethod
    public void requestIntegrityToken(PluginCall call) {
        String clientData = call.getString("clientData");
        if (clientData == null || clientData.isEmpty() || clientData.length() > MAX_CLIENT_DATA) {
            call.reject("clientData is required", "INVALID_ARGUMENT");
            return;
        }
        StandardIntegrityTokenProvider provider = integrityProvider;
        if (provider == null) {
            call.reject("Play Integrity is not prepared", "NOT_PREPARED");
            return;
        }
        String requestHash;
        try {
            requestHash = Base64.encodeToString(sha256(clientData),
                Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        } catch (NoSuchAlgorithmException unavailable) {
            call.reject("SHA-256 is unavailable", "UNSUPPORTED");
            return;
        }
        provider.request(StandardIntegrityManager.StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build())
            .addOnSuccessListener(token -> {
                JSObject result = new JSObject();
                result.put("token", token.token());
                call.resolve(result);
            })
            .addOnFailureListener(error -> {
                if (error instanceof StandardIntegrityException &&
                    ((StandardIntegrityException) error).getErrorCode() == StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID) {
                    // The warmed-up provider expired: JS prepares again.
                    integrityProvider = null;
                    call.reject("Play Integrity must be prepared again", "NOT_PREPARED");
                    return;
                }
                rejectIntegrity(call, error);
            });
    }

    @PluginMethod
    public void generateKey(PluginCall call) {
        call.reject("App Attest is iOS only", "UNSUPPORTED");
    }

    @PluginMethod
    public void attestKey(PluginCall call) {
        call.reject("App Attest is iOS only", "UNSUPPORTED");
    }

    @PluginMethod
    public void generateAssertion(PluginCall call) {
        call.reject("App Attest is iOS only", "UNSUPPORTED");
    }

    @PluginMethod
    public void deviceCheckToken(PluginCall call) {
        call.reject("DeviceCheck is iOS only", "UNSUPPORTED");
    }

    // ---- Helpers -----------------------------------------------------------------------------

    // org.json yields Integer or Double for JS numbers; PluginCall.getLong only accepts Long.
    private static long longOption(PluginCall call, String name, long fallback) {
        Object value = call.getData().opt(name);
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (!Double.isNaN(number) && !Double.isInfinite(number)) return (long) number;
        }
        return fallback;
    }

    private boolean hasLocationPermission() {
        return granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    @SuppressWarnings("deprecation")
    private JSObject fixJson(Location location) {
        JSObject fix = new JSObject();
        fix.put("lat", location.getLatitude());
        fix.put("lon", location.getLongitude());
        if (location.hasAccuracy()) fix.put("accuracy", (double) location.getAccuracy());
        fix.put("timestampMs", location.getTime());
        if (location.getProvider() != null) fix.put("provider", location.getProvider());
        fix.put("mock", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? location.isMock() : location.isFromMockProvider());
        fix.put("devOptions", developerOptionsEnabled());
        fix.put("reducedAccuracy", !granted(Manifest.permission.ACCESS_FINE_LOCATION));
        fix.put("networkCountryIso", networkCountryIso());
        return fix;
    }

    private boolean developerOptionsEnabled() {
        try {
            return Settings.Global.getInt(getContext().getContentResolver(), Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1;
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    private String networkCountryIso() {
        try {
            TelephonyManager telephony = (TelephonyManager) getContext().getSystemService(Context.TELEPHONY_SERVICE);
            String iso = telephony == null ? null : telephony.getNetworkCountryIso();
            return iso == null ? "" : iso.toLowerCase(java.util.Locale.ROOT);
        } catch (RuntimeException unavailable) {
            return "";
        }
    }

    private static boolean isProbablyEmulator() {
        String fingerprint = Build.FINGERPRINT == null ? "" : Build.FINGERPRINT;
        String hardware = Build.HARDWARE == null ? "" : Build.HARDWARE;
        return fingerprint.startsWith("generic") || fingerprint.contains("emulator") ||
            hardware.equals("goldfish") || hardware.equals("ranchu");
    }

    // ---- Environment ---------------------------------------------------------------------------

    private JSObject staticEnvironment() {
        JSObject cached = staticEnvironment;
        if (cached != null) return cached;
        JSObject env = new JSObject();
        env.put("v", 1);
        env.put("installId", installId());
        env.put("installIdPersistent", false);
        env.put("installSource", installSource());
        List<String> emulator = emulatorHints();
        if (!emulator.isEmpty()) env.put("emulatorHints", new JSONArray(emulator));
        List<String> root = rootHints();
        if (!root.isEmpty()) env.put("rootHints", new JSONArray(root));
        staticEnvironment = env;
        return env;
    }

    private static void mergeInto(JSObject target, @Nullable JSObject source) {
        if (source == null) return;
        java.util.Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            try {
                target.put(key, source.get(key));
            } catch (org.json.JSONException skip) {
                // omit
            }
        }
    }

    /** Random UUID in app-private storage (removed on uninstall). */
    private String installId() {
        try {
            File file = new File(getContext().getFilesDir(), "device_trust_install_id");
            if (file.isFile()) {
                try (FileInputStream in = new FileInputStream(file)) {
                    byte[] buffer = new byte[64];
                    int length = Math.max(0, in.read(buffer));
                    String stored = new String(buffer, 0, length, StandardCharsets.UTF_8).trim();
                    UUID.fromString(stored);
                    return stored;
                } catch (RuntimeException | java.io.IOException invalid) {
                    // regenerate below
                }
            }
            String created = UUID.randomUUID().toString();
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(created.getBytes(StandardCharsets.UTF_8));
            }
            return created;
        } catch (Exception failure) {
            return UUID.randomUUID().toString();
        }
    }

    @SuppressWarnings("deprecation")
    private String installSource() {
        try {
            Context context = getContext();
            PackageManager pm = context.getPackageManager();
            String installer;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                InstallSourceInfo info = pm.getInstallSourceInfo(context.getPackageName());
                installer = info.getInstallingPackageName();
            } else {
                installer = pm.getInstallerPackageName(context.getPackageName());
            }
            if (installer == null || installer.isEmpty()) return "sideload";
            return "com.android.vending".equals(installer) ? "store" : "unknown";
        } catch (Exception unavailable) {
            return "unknown";
        }
    }

    private List<String> emulatorHints() {
        List<String> hints = new ArrayList<>();
        try {
            String fingerprint = lower(Build.FINGERPRINT);
            String hardware = lower(Build.HARDWARE);
            String model = lower(Build.MODEL);
            String product = lower(Build.PRODUCT);
            if (fingerprint.startsWith("generic") || fingerprint.contains("emulator")) hints.add("generic_fingerprint");
            if (hardware.contains("goldfish")) hints.add("goldfish");
            if (hardware.contains("ranchu")) hints.add("ranchu");
            if (hardware.contains("vbox86")) hints.add("vbox86");
            if (model.contains("sdk") || model.contains("emulator")) hints.add("model");
            if (product.contains("sdk") || product.contains("emulator")) hints.add("product");
            SensorManager sensors = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
            if (sensors != null && sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) == null) hints.add("no_accelerometer");
        } catch (RuntimeException unavailable) {
            // keep what was gathered
        }
        return hints;
    }

    private static List<String> rootHints() {
        List<String> hints = new ArrayList<>();
        try {
            if (Build.TAGS != null && Build.TAGS.contains("test-keys")) hints.add("test_keys");
            String[] paths = {"/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/su",
                "/system/sd/xbin/su", "/vendor/bin/su", "/su/bin/su", "/data/local/xbin/su", "/data/local/bin/su"};
            for (String path : paths) {
                if (new File(path).exists()) {
                    hints.add("su_binary");
                    break;
                }
            }
        } catch (RuntimeException unavailable) {
            // keep what was gathered
        }
        return hints;
    }

    private static String lower(@Nullable String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT);
    }

    private void putSetting(JSObject target, String key, String setting) {
        try {
            int value = Settings.Global.getInt(getContext().getContentResolver(), setting, -1);
            if (value >= 0) target.put(key, value == 1);
        } catch (RuntimeException unavailable) {
            // omit
        }
    }

    @Nullable
    private static String isoOrNull(@Nullable String iso) {
        return iso == null || iso.isEmpty() ? null : iso.toLowerCase(Locale.ROOT);
    }

    /** ConnectivityManager when ACCESS_NETWORK_STATE is already held, else tunnel interface names. */
    @Nullable
    private Boolean vpnActive() {
        try {
            if (granted(Manifest.permission.ACCESS_NETWORK_STATE)) {
                ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm == null) return null;
                Network network = cm.getActiveNetwork();
                if (network == null) return false;
                NetworkCapabilities caps = cm.getNetworkCapabilities(network);
                return caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
            }
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                String name = nif.getName();
                if (nif.isUp() && (name.startsWith("tun") || name.startsWith("ppp") || name.startsWith("tap") ||
                    name.startsWith("ipsec") || name.startsWith("wg"))) return true;
            }
            return false;
        } catch (Exception unavailable) {
            return null;
        }
    }

    private JSONArray cellMccs() {
        Set<String> mccs = new LinkedHashSet<>();
        try {
            if (granted(Manifest.permission.ACCESS_FINE_LOCATION) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                TelephonyManager telephony = (TelephonyManager) getContext().getSystemService(Context.TELEPHONY_SERVICE);
                @SuppressLint("MissingPermission")
                List<CellInfo> cells = telephony == null ? null : telephony.getAllCellInfo();
                if (cells != null) {
                    for (CellInfo cell : cells) {
                        String mcc = null;
                        if (cell instanceof CellInfoLte) {
                            CellIdentityLte id = ((CellInfoLte) cell).getCellIdentity();
                            mcc = id.getMccString();
                        } else if (cell instanceof CellInfoGsm) {
                            CellIdentityGsm id = ((CellInfoGsm) cell).getCellIdentity();
                            mcc = id.getMccString();
                        } else if (cell instanceof CellInfoWcdma) {
                            CellIdentityWcdma id = ((CellInfoWcdma) cell).getCellIdentity();
                            mcc = id.getMccString();
                        }
                        if (mcc != null && !mcc.isEmpty()) mccs.add(mcc);
                    }
                }
            }
        } catch (RuntimeException unavailable) {
            // report what was gathered
        }
        return new JSONArray(mccs);
    }

    /** Samples GNSS status over the fix window; one instance per getCurrentFix call. */
    private final class GnssSampler {
        @Nullable private LocationManager manager;
        @Nullable private GnssStatus.Callback callback;
        private volatile int used = -1;
        private volatile int visible = -1;
        private volatile double avgCn0 = -1;

        @SuppressLint("MissingPermission")
        void start() {
            try {
                if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) return;
                manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
                if (manager == null) return;
                callback = new GnssStatus.Callback() {
                    @Override
                    public void onSatelliteStatusChanged(GnssStatus status) {
                        int count = status.getSatelliteCount();
                        int usedCount = 0;
                        double sum = 0;
                        for (int i = 0; i < count; i++) {
                            if (status.usedInFix(i)) {
                                usedCount++;
                                sum += status.getCn0DbHz(i);
                            }
                        }
                        visible = count;
                        used = usedCount;
                        avgCn0 = usedCount > 0 ? sum / usedCount : -1;
                    }
                };
                manager.registerGnssStatusCallback(callback, new Handler(Looper.getMainLooper()));
            } catch (RuntimeException unavailable) {
                callback = null;
            }
        }

        /** Unregisters (idempotent) and returns the sampled fields; empty when nothing was seen. */
        JSObject stop() {
            JSObject fields = new JSObject();
            try {
                if (manager != null && callback != null) manager.unregisterGnssStatusCallback(callback);
            } catch (RuntimeException unavailable) {
                // already gone
            }
            callback = null;
            if (visible >= 0) {
                fields.put("gnssSatellitesUsed", used);
                fields.put("gnssSatellitesVisible", visible);
                if (avgCn0 >= 0) fields.put("gnssAvgCn0", avgCn0);
            }
            return fields;
        }
    }

    private static byte[] sha256(String value) throws NoSuchAlgorithmException {
        return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
    }

    private static void rejectIntegrity(PluginCall call, Exception error) {
        if (error instanceof StandardIntegrityException) {
            int code = ((StandardIntegrityException) error).getErrorCode();
            call.reject("Play Integrity failed", "INTEGRITY_" + code);
            return;
        }
        call.reject("Play Integrity is unavailable", "SERVER_UNAVAILABLE");
    }
}
