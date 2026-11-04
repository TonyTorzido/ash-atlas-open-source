import Foundation
import UIKit
import AuthenticationServices
import Capacitor

/// Native Sign in with Apple (ASAuthorizationAppleIDProvider). Returns Apple's
/// raw credential; the server verifies the identity token (audience = bundle id)
/// and decides everything. The server-side flag decides whether JS uses this.
@objc(AppleSignInPlugin)
public final class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCredentialState", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?
    private var activeController: ASAuthorizationController?

    @objc func authorize(_ call: CAPPluginCall) {
        let nonce = call.getString("nonce")
        let state = call.getString("state")
        let scopes = (call.getArray("scopes") ?? ["email", "fullName"]).compactMap { $0 as? String }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.pendingCall == nil else {
                call.reject("Sign in with Apple is already in progress", "IN_PROGRESS")
                return
            }
            let request = ASAuthorizationAppleIDProvider().createRequest()
            var requested: [ASAuthorization.Scope] = []
            if scopes.contains("email") { requested.append(.email) }
            if scopes.contains("fullName") { requested.append(.fullName) }
            request.requestedScopes = requested
            if let nonce = nonce { request.nonce = nonce }
            if let state = state { request.state = state }
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.pendingCall = call
            self.activeController = controller
            controller.performRequests()
        }
    }

    @objc func getCredentialState(_ call: CAPPluginCall) {
        guard let user = call.getString("user"), !user.isEmpty else {
            call.reject("An Apple user identifier is required", "INVALID_ARGUMENT")
            return
        }
        ASAuthorizationAppleIDProvider().getCredentialState(forUserID: user) { state, error in
            if let error = error {
                call.reject("The Apple credential state could not be read", "UNAVAILABLE", error)
                return
            }
            let name: String
            switch state {
            case .authorized: name = "authorized"
            case .revoked: name = "revoked"
            case .notFound: name = "notFound"
            case .transferred: name = "transferred"
            @unknown default: name = "unknown"
            }
            call.resolve(["state": name])
        }
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = takePendingCall() else { return }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
            call.reject("Apple returned an unexpected credential", "SIGN_IN_FAILED")
            return
        }
        var result: [String: Any] = [
            "user": credential.user,
            "realUserStatus": credential.realUserStatus.rawValue
        ]
        if let token = credential.identityToken {
            result["identityToken"] = String(data: token, encoding: .utf8)
        }
        if let code = credential.authorizationCode {
            result["authorizationCode"] = String(data: code, encoding: .utf8)
        }
        result["state"] = credential.state
        // Email and name are only present the first time a user authorizes this app.
        result["email"] = credential.email
        result["givenName"] = credential.fullName?.givenName
        result["familyName"] = credential.fullName?.familyName
        call.resolve(result)
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = takePendingCall() else { return }
        let nsError = error as NSError
        if nsError.domain == ASAuthorizationError.errorDomain && nsError.code == ASAuthorizationError.canceled.rawValue {
            call.reject("Sign in with Apple was cancelled", "USER_CANCELLED")
            return
        }
        call.reject("Sign in with Apple failed", "SIGN_IN_FAILED", error)
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? UIWindow()
    }

    private func takePendingCall() -> CAPPluginCall? {
        let call = pendingCall
        pendingCall = nil
        activeController = nil
        return call
    }
}
