import Foundation
import UIKit
import Capacitor

/// Store-update gate. JS decides when an update is required (server-driven
/// minimum store build). iOS has no in-app update API, so "update" means
/// opening this app's App Store page; the numeric App Store id comes from JS.
@objc(StoreUpdatePlugin)
public final class StoreUpdatePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StoreUpdatePlugin"
    public let jsName = "StoreUpdate"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getUpdateInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "performImmediateUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openStoreListing", returnType: CAPPluginReturnPromise)
    ]

    @objc func getUpdateInfo(_ call: CAPPluginCall) {
        var result: [String: Any] = ["platform": "ios", "updateAvailability": "unknown"]
        result["currentVersion"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        result["currentBuild"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        call.resolve(result)
    }

    @objc func performImmediateUpdate(_ call: CAPPluginCall) {
        openAppStore(call, resolved: ["result": "openedStore"])
    }

    @objc func openStoreListing(_ call: CAPPluginCall) {
        openAppStore(call, resolved: [:])
    }

    private func openAppStore(_ call: CAPPluginCall, resolved: [String: Any]) {
        guard let appStoreId = call.getString("appStoreId"),
              !appStoreId.isEmpty,
              appStoreId.allSatisfy({ $0.isASCII && $0.isNumber }),
              let url = URL(string: "itms-apps://apps.apple.com/app/id\(appStoreId)") else {
            call.reject("A numeric App Store id is required", "INVALID_ARGUMENT")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened {
                    call.resolve(resolved)
                } else {
                    call.reject("The App Store could not be opened", "UNAVAILABLE")
                }
            }
        }
    }
}
