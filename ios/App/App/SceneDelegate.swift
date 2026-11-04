import UIKit
import Capacitor

private final class AshAtlasBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeRuntimePlugin())
        bridge?.registerPluginInstance(PurchasesPlugin())
        bridge?.registerPluginInstance(StoreUpdatePlugin())
        bridge?.registerPluginInstance(AppleSignInPlugin())
        bridge?.registerPluginInstance(DeviceTrustPlugin())
    }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge {
        .bottom
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        configureFullBleedWebView()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        configureFullBleedWebView()
    }

    private func configureFullBleedWebView() {
        edgesForExtendedLayout = [.top, .bottom, .left, .right]
        extendedLayoutIncludesOpaqueBars = true
        view.insetsLayoutMarginsFromSafeArea = false
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
    }
}

@objc(NativeRuntimePlugin)
public final class NativeRuntimePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeRuntimePlugin"
    public let jsName = "NativeRuntime"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProcessIdentity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLogoutPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLogoutPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openNotificationSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pausePushAutoInit", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getShellCapabilities", returnType: CAPPluginReturnPromise)
    ]
    // Static for the native process, not the bridge/WebView lifetime. Capacitor
    // can reload its WebView while an old native HTTP request still sets cookies.
    private static let processIdentity = UUID().uuidString
    private static let logoutPendingKey = "ash-atlas-native-logout-pending-v1"

    @objc func getProcessIdentity(_ call: CAPPluginCall) {
        call.resolve(["id": Self.processIdentity])
    }

    @objc func getShellCapabilities(_ call: CAPPluginCall) {
        // The Firebase config is bundled only when the build input provided it.
        // Crashlytics must not be called without it (the SDK asserts on use).
        let firebaseConfigured = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil
        call.resolve(["firebaseConfigured": firebaseConfigured])
    }

    @objc func getLogoutPending(_ call: CAPPluginCall) {
        guard let stored = CFPreferencesCopyAppValue(Self.logoutPendingKey as CFString, kCFPreferencesCurrentApplication) else {
            call.resolve(["pending": false])
            return
        }
        guard let pending = stored as? Bool else {
            call.reject("Sign-out recovery could not be read")
            return
        }
        call.resolve(["pending": pending])
    }

    @objc func setLogoutPending(_ call: CAPPluginCall) {
        guard let pending = call.getBool("pending") else {
            call.reject("A pending sign-out flag is required")
            return
        }
        CFPreferencesSetAppValue(Self.logoutPendingKey as CFString,
                                 pending ? kCFBooleanTrue : kCFBooleanFalse,
                                 kCFPreferencesCurrentApplication)
        // Unlike ordinary preferences, this security recovery flag needs an
        // explicit checked persistent-write boundary before acknowledging intent.
        guard CFPreferencesAppSynchronize(kCFPreferencesCurrentApplication) else {
            call.reject("Sign-out recovery could not be saved")
            return
        }
        call.resolve()
    }

    @objc func openNotificationSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("App settings are unavailable")
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() }
                else { call.reject("App settings could not be opened") }
            }
        }
    }

    @objc func pausePushAutoInit(_ call: CAPPluginCall) {
        // iOS uses APNs, not Firebase's persisted automatic-registration setting.
        call.resolve()
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = AshAtlasBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
