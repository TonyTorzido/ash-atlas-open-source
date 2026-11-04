import Foundation
import CFNetwork
import Security
import CoreLocation
import CryptoKit
import DeviceCheck
import Capacitor

/// DeviceTrust (NATIVE_ANTISPOOF_BUILD_PLAN.md §8; JS contract at the top of
/// apps/client/src/native/nativeDeviceTrust.ts). Never requests permissions and
/// never prompts. Rejections use the contract's string codes. JS never hashes:
/// clientDataHash = SHA-256(UTF-8 clientData) is computed here.
@objc(DeviceTrustPlugin)
public final class DeviceTrustPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "DeviceTrustPlugin"
    public let jsName = "DeviceTrust"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentFix", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getEnvironment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareIntegrity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestIntegrityToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generateKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attestKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generateAssertion", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deviceCheckToken", returnType: CAPPluginReturnPromise)
    ]

    private static let maxClientDataLength = 4096

    /// Main-thread only.
    private var locationManager: CLLocationManager?
    private var pendingFixes: [(call: CAPPluginCall, timeout: DispatchWorkItem)] = []

    // MARK: - Capabilities

    @objc func getCapabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            var result: [String: Any] = [
                "v": 1,
                "platform": "ios",
                "location": self.isAuthorized(self.manager()),
                "playIntegrity": false,
                "appAttest": DCAppAttestService.shared.isSupported,
                "deviceCheck": DCDevice.current.isSupported,
                "environment": true
            ]
            #if targetEnvironment(simulator)
            result["simulator"] = true
            #endif
            call.resolve(result)
        }
    }

    // MARK: - Environment

    /// Static parts (install id, source, simulator/jailbreak hints) are computed once per process.
    private static let staticEnvironment: [String: Any] = {
        var env: [String: Any] = ["v": 1]
        let install = DeviceTrustPlugin.installId()
        env["installId"] = install.id
        env["installIdPersistent"] = install.persistent
        env["installSource"] = DeviceTrustPlugin.installSource()
        var emulator: [String] = []
        #if targetEnvironment(simulator)
        emulator.append("simulator")
        #endif
        if !emulator.isEmpty { env["emulatorHints"] = emulator }
        var root: [String] = []
        let paths = ["/var/jb", "/Applications/Cydia.app", "/Applications/Sileo.app", "/Library/MobileSubstrate/MobileSubstrate.dylib",
                     "/bin/bash", "/usr/sbin/sshd", "/etc/apt", "/private/var/lib/apt/"]
        if paths.contains(where: { FileManager.default.fileExists(atPath: $0) }) { root.append("jb_paths") }
        if !root.isEmpty { env["rootHints"] = root }
        return env
    }()

    @objc func getEnvironment(_ call: CAPPluginCall) {
        var result = DeviceTrustPlugin.staticEnvironment
        result["debuggerAttached"] = DeviceTrustPlugin.debuggerAttached()
        if let vpn = DeviceTrustPlugin.vpnActive() { result["vpnActive"] = vpn }
        result["simCountryIso"] = NSNull()
        result["networkCountryIso"] = NSNull()
        result["cellMccs"] = [String]()
        result["timeZone"] = TimeZone.current.identifier
        result["locale"] = Locale.current.identifier
        call.resolve(result)
    }

    /// Random UUID in the Keychain (survives reinstall); falls back to a per-process UUID if the Keychain fails.
    private static func installId() -> (id: String, persistent: Bool) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.ashatlas.game.devicetrust",
            kSecAttrAccount as String: "install-id"
        ]
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
           let data = item as? Data, let stored = String(data: data, encoding: .utf8), UUID(uuidString: stored) != nil {
            return (stored, true)
        }
        let created = UUID().uuidString
        var add = base
        add[kSecValueData as String] = Data(created.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        if SecItemAdd(add as CFDictionary, nil) == errSecSuccess { return (created, true) }
        return (created, false)
    }

    private static func installSource() -> String {
        #if targetEnvironment(simulator)
        return "unknown"
        #else
        if Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" { return "testflight" }
        return "store"
        #endif
    }

    /// sysctl P_TRACED on our own process.
    private static func debuggerAttached() -> Bool {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        let status = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        return status == 0 && (info.kp_proc.p_flag & P_TRACED) != 0
    }

    /// Tunnel interface in CFNetwork's scoped proxy settings; nil when unreadable.
    private static func vpnActive() -> Bool? {
        guard let settings = CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [String: Any],
              let scoped = settings["__SCOPED__"] as? [String: Any] else { return nil }
        let prefixes = ["utun", "ipsec", "ppp", "tap", "tun"]
        return scoped.keys.contains { key in prefixes.contains { key.hasPrefix($0) } }
    }

    // MARK: - Location

    @objc func getCurrentFix(_ call: CAPPluginCall) {
        let highAccuracy = call.getBool("enableHighAccuracy") ?? false
        let maximumAgeMs = max(0, call.getDouble("maximumAgeMs") ?? 0)
        let timeoutMs = min(60_000, max(1_000, call.getDouble("timeoutMs") ?? 10_000))
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let manager = self.manager()
            guard self.isAuthorized(manager) else {
                call.reject("Location permission is not granted", "PERMISSION_DENIED")
                return
            }
            if let cached = manager.location, -cached.timestamp.timeIntervalSinceNow * 1000 <= maximumAgeMs,
               !highAccuracy || cached.horizontalAccuracy <= kCLLocationAccuracyHundredMeters {
                call.resolve(self.fixPayload(cached, manager: manager))
                return
            }
            let timeout = DispatchWorkItem { [weak self] in
                self?.settleFix(call, code: "TIMEOUT")
            }
            self.pendingFixes.append((call: call, timeout: timeout))
            DispatchQueue.main.asyncAfter(deadline: .now() + timeoutMs / 1000, execute: timeout)
            manager.desiredAccuracy = highAccuracy ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters
            // One-shot request; never asks for authorization.
            manager.requestLocation()
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let payload = fixPayload(location, manager: manager)
        let waiting = pendingFixes
        pendingFixes.removeAll()
        for pending in waiting {
            pending.timeout.cancel()
            pending.call.resolve(payload)
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let code = (error as? CLError)?.code == .denied ? "PERMISSION_DENIED" : "LOCATION_UNAVAILABLE"
        let waiting = pendingFixes
        pendingFixes.removeAll()
        for pending in waiting {
            pending.timeout.cancel()
            pending.call.reject("No location fix", code)
        }
    }

    private func settleFix(_ call: CAPPluginCall, code: String) {
        guard let index = pendingFixes.firstIndex(where: { $0.call === call }) else { return }
        pendingFixes.remove(at: index)
        call.reject("No location fix", code)
    }

    private func manager() -> CLLocationManager {
        if let existing = locationManager { return existing }
        let created = CLLocationManager()
        created.delegate = self
        created.desiredAccuracy = kCLLocationAccuracyHundredMeters
        locationManager = created
        return created
    }

    private func isAuthorized(_ manager: CLLocationManager) -> Bool {
        let status = manager.authorizationStatus
        return status == .authorizedWhenInUse || status == .authorizedAlways
    }

    private func fixPayload(_ location: CLLocation, manager: CLLocationManager) -> [String: Any] {
        var fix: [String: Any] = [
            "lat": location.coordinate.latitude,
            "lon": location.coordinate.longitude,
            "timestampMs": (location.timestamp.timeIntervalSince1970 * 1000).rounded(),
            "provider": "core_location",
            "reducedAccuracy": manager.accuracyAuthorization == .reducedAccuracy
        ]
        if location.horizontalAccuracy >= 0 {
            fix["accuracy"] = location.horizontalAccuracy
        }
        if let source = location.sourceInformation {
            fix["simulated"] = source.isSimulatedBySoftware
            fix["accessory"] = source.isProducedByAccessory
        }
        return fix
    }

    // MARK: - Play Integrity (Android only)

    @objc func prepareIntegrity(_ call: CAPPluginCall) {
        call.reject("Play Integrity is Android only", "UNSUPPORTED")
    }

    @objc func requestIntegrityToken(_ call: CAPPluginCall) {
        call.reject("Play Integrity is Android only", "UNSUPPORTED")
    }

    // MARK: - App Attest / DeviceCheck

    @objc func generateKey(_ call: CAPPluginCall) {
        let service = DCAppAttestService.shared
        guard service.isSupported else {
            call.reject("App Attest is not supported on this device", "UNSUPPORTED")
            return
        }
        service.generateKey { keyId, error in
            if let error = error {
                call.reject("App Attest key generation failed", DeviceTrustPlugin.code(for: error))
                return
            }
            guard let keyId = keyId else {
                call.reject("App Attest key generation failed", "UNKNOWN_SYSTEM_FAILURE")
                return
            }
            // keyId is already standard base64.
            call.resolve(["keyId": keyId])
        }
    }

    @objc func attestKey(_ call: CAPPluginCall) {
        guard let input = keyAndHash(call) else { return }
        DCAppAttestService.shared.attestKey(input.keyId, clientDataHash: input.hash) { attestation, error in
            if let error = error {
                call.reject("App Attest attestation failed", DeviceTrustPlugin.code(for: error))
                return
            }
            guard let attestation = attestation else {
                call.reject("App Attest attestation failed", "UNKNOWN_SYSTEM_FAILURE")
                return
            }
            call.resolve(["attestationObject": attestation.base64EncodedString()])
        }
    }

    @objc func generateAssertion(_ call: CAPPluginCall) {
        guard let input = keyAndHash(call) else { return }
        DCAppAttestService.shared.generateAssertion(input.keyId, clientDataHash: input.hash) { assertion, error in
            if let error = error {
                call.reject("App Attest assertion failed", DeviceTrustPlugin.code(for: error))
                return
            }
            guard let assertion = assertion else {
                call.reject("App Attest assertion failed", "UNKNOWN_SYSTEM_FAILURE")
                return
            }
            call.resolve(["assertion": assertion.base64EncodedString()])
        }
    }

    @objc func deviceCheckToken(_ call: CAPPluginCall) {
        guard DCDevice.current.isSupported else {
            call.reject("DeviceCheck is not supported on this device", "UNSUPPORTED")
            return
        }
        DCDevice.current.generateToken { token, error in
            if let error = error {
                call.reject("DeviceCheck token failed", DeviceTrustPlugin.code(for: error))
                return
            }
            guard let token = token else {
                call.reject("DeviceCheck token failed", "UNKNOWN_SYSTEM_FAILURE")
                return
            }
            call.resolve(["token": token.base64EncodedString()])
        }
    }

    /// Validates keyId + clientData and returns SHA-256(UTF-8 clientData); rejects the call otherwise.
    private func keyAndHash(_ call: CAPPluginCall) -> (keyId: String, hash: Data)? {
        guard DCAppAttestService.shared.isSupported else {
            call.reject("App Attest is not supported on this device", "UNSUPPORTED")
            return nil
        }
        guard let keyId = call.getString("keyId"), !keyId.isEmpty else {
            call.reject("keyId is required", "INVALID_ARGUMENT")
            return nil
        }
        guard let clientData = call.getString("clientData"), !clientData.isEmpty,
              clientData.utf8.count <= DeviceTrustPlugin.maxClientDataLength else {
            call.reject("clientData is required", "INVALID_ARGUMENT")
            return nil
        }
        return (keyId: keyId, hash: Data(SHA256.hash(data: Data(clientData.utf8))))
    }

    private static func code(for error: Error) -> String {
        let nsError = error as NSError
        guard nsError.domain == DCError.errorDomain else { return "UNKNOWN_SYSTEM_FAILURE" }
        switch nsError.code {
        case DCError.Code.featureUnsupported.rawValue: return "UNSUPPORTED"
        case DCError.Code.invalidKey.rawValue: return "KEY_INVALID"
        case DCError.Code.serverUnavailable.rawValue: return "SERVER_UNAVAILABLE"
        case DCError.Code.invalidInput.rawValue: return "INVALID_INPUT"
        default: return "UNKNOWN_SYSTEM_FAILURE"
        }
    }
}
