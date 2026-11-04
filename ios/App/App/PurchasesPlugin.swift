import Foundation
import UIKit
import StoreKit
import Capacitor

/// StoreKit 2 bridge. Mirrors the store's own objects; the server is the only
/// authority that grants anything. Transactions are finished only when JS calls
/// `finishTransaction` after the server confirmed the grant.
@objc(PurchasesPlugin)
public final class PurchasesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PurchasesPlugin"
    public let jsName = "Purchases"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgePurchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumePurchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restorePurchases", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentEntitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unfinishedTransactions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStorefront", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manageSubscriptions", returnType: CAPPluginReturnPromise)
    ]

    private static let transactionUpdatedEvent = "transactionUpdated"
    private var updatesTask: Task<Void, Never>?

    override public func load() {
        // Apple requires listening from launch so Ask to Buy approvals, renewals,
        // refunds and purchases made outside the app are never missed. Events are
        // retained until JS registers a listener; nothing is finished here.
        updatesTask = Task.detached(priority: .background) { [weak self] in
            for await update in Transaction.updates {
                guard let plugin = self else { return }
                var event: [String: Any] = ["platform": "ios"]
                event["transaction"] = PurchasesPlugin.transactionPayload(update)
                plugin.notifyListeners(PurchasesPlugin.transactionUpdatedEvent, data: event, retainUntilConsumed: true)
            }
        }
    }

    deinit {
        updatesTask?.cancel()
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": AppStore.canMakePayments, "subscriptions": true])
    }

    @objc func getProducts(_ call: CAPPluginCall) {
        let ids = (call.getArray("productIds") ?? []).compactMap { $0 as? String }.filter { !$0.isEmpty }
        guard !ids.isEmpty else {
            call.reject("At least one product id is required", "INVALID_ARGUMENT")
            return
        }
        Task {
            do {
                let products = try await Product.products(for: ids)
                let found = Set(products.map { $0.id })
                let invalid = ids.filter { !found.contains($0) }
                call.resolve([
                    "products": products.map { PurchasesPlugin.productPayload($0) },
                    "invalidProductIds": invalid
                ])
            } catch {
                call.reject("Products could not be loaded", "STORE_UNAVAILABLE", error)
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"), !productId.isEmpty else {
            call.reject("A product id is required", "INVALID_ARGUMENT")
            return
        }
        guard let tokenString = call.getString("appAccountToken"), let token = UUID(uuidString: tokenString) else {
            call.reject("appAccountToken must be a UUID", "INVALID_ARGUMENT")
            return
        }
        Task {
            do {
                guard let product = try await Product.products(for: [productId]).first else {
                    call.reject("The product is not available in this store", "PRODUCT_NOT_FOUND")
                    return
                }
                let result = try await product.purchase(options: [.appAccountToken(token)])
                switch result {
                case .success(let verification):
                    call.resolve([
                        "platform": "ios",
                        "status": "purchased",
                        "transaction": PurchasesPlugin.transactionPayload(verification)
                    ])
                case .pending:
                    // Ask to Buy or Strong Customer Authentication. The outcome arrives later
                    // through the transactionUpdated event.
                    call.resolve(["platform": "ios", "status": "pending"])
                case .userCancelled:
                    call.resolve(["platform": "ios", "status": "cancelled"])
                @unknown default:
                    call.reject("The purchase did not complete", "BILLING_ERROR")
                }
            } catch {
                call.reject("The purchase did not complete", PurchasesPlugin.errorCode(error), error)
            }
        }
    }

    @objc func finishTransaction(_ call: CAPPluginCall) {
        guard let idString = call.getString("transactionId"), let transactionId = UInt64(idString) else {
            call.reject("A transaction id is required", "INVALID_ARGUMENT")
            return
        }
        Task {
            for await verification in Transaction.unfinished {
                let transaction = PurchasesPlugin.unsafeTransaction(verification)
                if transaction.id == transactionId {
                    await transaction.finish()
                    call.resolve(["finished": true])
                    return
                }
            }
            // Already finished (or never existed on this device): nothing left to do.
            call.resolve(["finished": false])
        }
    }

    @objc func acknowledgePurchase(_ call: CAPPluginCall) {
        call.unimplemented("iOS uses finishTransaction")
    }

    @objc func consumePurchase(_ call: CAPPluginCall) {
        call.unimplemented("iOS uses finishTransaction")
    }

    @objc func restorePurchases(_ call: CAPPluginCall) {
        Task {
            do {
                // Shows an App Store sign-in prompt when needed; call only from a user action.
                try await AppStore.sync()
            } catch {
                if PurchasesPlugin.isUserCancelled(error) {
                    call.resolve(["platform": "ios", "status": "cancelled", "transactions": [[String: Any]]()])
                    return
                }
                call.reject("Purchases could not be restored", PurchasesPlugin.errorCode(error), error)
                return
            }
            var transactions: [[String: Any]] = []
            for await verification in Transaction.currentEntitlements {
                transactions.append(PurchasesPlugin.transactionPayload(verification))
            }
            call.resolve(["platform": "ios", "status": "restored", "transactions": transactions])
        }
    }

    @objc func currentEntitlements(_ call: CAPPluginCall) {
        Task {
            var transactions: [[String: Any]] = []
            for await verification in Transaction.currentEntitlements {
                transactions.append(PurchasesPlugin.transactionPayload(verification))
            }
            call.resolve(["platform": "ios", "transactions": transactions])
        }
    }

    @objc func unfinishedTransactions(_ call: CAPPluginCall) {
        Task {
            var transactions: [[String: Any]] = []
            for await verification in Transaction.unfinished {
                transactions.append(PurchasesPlugin.transactionPayload(verification))
            }
            call.resolve(["platform": "ios", "transactions": transactions])
        }
    }

    @objc func getStorefront(_ call: CAPPluginCall) {
        Task {
            guard let storefront = await Storefront.current else {
                call.reject("The store country could not be read", "STORE_UNAVAILABLE")
                return
            }
            // App Store country codes are ISO 3166-1 alpha-3 (Play returns alpha-2).
            call.resolve(["platform": "ios", "countryCode": storefront.countryCode, "id": storefront.id])
        }
    }

    @objc func manageSubscriptions(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let scene = self?.bridge?.viewController?.view.window?.windowScene else {
                call.reject("Subscriptions could not be opened", "UNAVAILABLE")
                return
            }
            Task { @MainActor in
                do {
                    try await AppStore.showManageSubscriptions(in: scene)
                    call.resolve()
                } catch {
                    call.reject("Subscriptions could not be opened", "UNAVAILABLE", error)
                }
            }
        }
    }

    // MARK: - Payloads (JSON-safe: never store Optionals in the dictionaries)

    private static func milliseconds(_ date: Date) -> Double {
        return (date.timeIntervalSince1970 * 1000).rounded()
    }

    private static func unsafeTransaction(_ verification: VerificationResult<Transaction>) -> Transaction {
        switch verification {
        case .verified(let transaction):
            return transaction
        case .unverified(let transaction, _):
            return transaction
        }
    }

    private static func productTypeName(_ type: Product.ProductType) -> String {
        switch type {
        case .consumable: return "consumable"
        case .nonConsumable: return "nonConsumable"
        case .autoRenewable: return "autoRenewable"
        case .nonRenewable: return "nonRenewable"
        default: return "unknown"
        }
    }

    private static func periodPayload(_ period: Product.SubscriptionPeriod) -> [String: Any] {
        let unit: String
        switch period.unit {
        case .day: unit = "day"
        case .week: unit = "week"
        case .month: unit = "month"
        case .year: unit = "year"
        @unknown default: unit = "unknown"
        }
        return ["unit": unit, "value": period.value]
    }

    private static func offerPayload(_ offer: Product.SubscriptionOffer) -> [String: Any] {
        var payload: [String: Any] = [
            "displayPrice": offer.displayPrice,
            "price": NSDecimalNumber(decimal: offer.price).stringValue,
            "period": periodPayload(offer.period),
            "periodCount": offer.periodCount
        ]
        payload["id"] = offer.id
        switch offer.paymentMode {
        case .freeTrial: payload["paymentMode"] = "freeTrial"
        case .payAsYouGo: payload["paymentMode"] = "payAsYouGo"
        case .payUpFront: payload["paymentMode"] = "payUpFront"
        default: payload["paymentMode"] = "unknown"
        }
        return payload
    }

    private static func productPayload(_ product: Product) -> [String: Any] {
        var payload: [String: Any] = [
            "platform": "ios",
            "id": product.id,
            "type": productTypeName(product.type),
            "displayName": product.displayName,
            "description": product.description,
            "displayPrice": product.displayPrice,
            "price": NSDecimalNumber(decimal: product.price).stringValue,
            "currencyCode": product.priceFormatStyle.currencyCode,
            "isFamilyShareable": product.isFamilyShareable
        ]
        if let subscription = product.subscription {
            var info: [String: Any] = [
                "subscriptionGroupId": subscription.subscriptionGroupID,
                "subscriptionPeriod": periodPayload(subscription.subscriptionPeriod)
            ]
            if let intro = subscription.introductoryOffer {
                info["introductoryOffer"] = offerPayload(intro)
            }
            payload["subscription"] = info
        }
        return payload
    }

    private static func transactionPayload(_ verification: VerificationResult<Transaction>) -> [String: Any] {
        var verified = false
        var verificationError: String?
        let transaction: Transaction
        switch verification {
        case .verified(let value):
            transaction = value
            verified = true
        case .unverified(let value, let error):
            transaction = value
            verificationError = String(describing: error)
        }
        var payload: [String: Any] = [
            // The signed JWS is what the server verifies; `verified` is only the
            // device's local opinion and must never be trusted on its own.
            "jws": verification.jwsRepresentation,
            "verified": verified,
            "transactionId": String(transaction.id),
            "originalTransactionId": String(transaction.originalID),
            "productId": transaction.productID,
            "productType": productTypeName(transaction.productType),
            "purchaseDate": milliseconds(transaction.purchaseDate),
            "originalPurchaseDate": milliseconds(transaction.originalPurchaseDate),
            "purchasedQuantity": transaction.purchasedQuantity,
            "isUpgraded": transaction.isUpgraded,
            "ownershipType": transaction.ownershipType == .familyShared ? "familyShared" : "purchased"
        ]
        payload["verificationError"] = verificationError
        payload["appAccountToken"] = transaction.appAccountToken?.uuidString.lowercased()
        payload["subscriptionGroupId"] = transaction.subscriptionGroupID
        payload["webOrderLineItemId"] = transaction.webOrderLineItemID
        if let expiration = transaction.expirationDate {
            payload["expirationDate"] = milliseconds(expiration)
        }
        if let revocation = transaction.revocationDate {
            payload["revocationDate"] = milliseconds(revocation)
        }
        if let reason = transaction.revocationReason {
            payload["revocationReason"] = reason == .developerIssue ? "developerIssue" : "other"
        }
        if #available(iOS 16.0, *) {
            payload["environment"] = transaction.environment.rawValue
        }
        return payload
    }

    private static func isUserCancelled(_ error: Error) -> Bool {
        if let storeKitError = error as? StoreKitError, case .userCancelled = storeKitError {
            return true
        }
        return false
    }

    private static func errorCode(_ error: Error) -> String {
        if let storeKitError = error as? StoreKitError {
            switch storeKitError {
            case .userCancelled: return "USER_CANCELLED"
            case .networkError: return "STORE_UNAVAILABLE"
            case .notAvailableInStorefront: return "PRODUCT_NOT_FOUND"
            default: return "BILLING_ERROR"
            }
        }
        if let purchaseError = error as? Product.PurchaseError {
            switch purchaseError {
            case .productUnavailable: return "PRODUCT_NOT_FOUND"
            case .purchaseNotAllowed: return "BILLING_UNAVAILABLE"
            default: return "BILLING_ERROR"
            }
        }
        return "BILLING_ERROR"
    }
}
