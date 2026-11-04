package com.ashatlas.game;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.ConsumeParams;
import com.android.billingclient.api.GetBillingConfigParams;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.json.JSONException;

/**
 * Google Play Billing bridge. Mirrors the store's own objects; the server is the
 * only authority that grants anything. Purchases are acknowledged or consumed
 * only when JS calls in after the server confirmed the grant.
 * The billing connection is opened lazily, so a shell whose JS never touches
 * purchases never talks to Play Billing.
 */
@CapacitorPlugin(name = "Purchases")
public final class PurchasesPlugin extends Plugin implements PurchasesUpdatedListener {
    static final String EVENT_TRANSACTION_UPDATED = "transactionUpdated";

    private final Object lock = new Object();
    private BillingClient billingClient;
    private final List<Runnable> waitingForConnection = new ArrayList<>();
    private final List<PluginCall> waitingCalls = new ArrayList<>();
    private boolean connecting = false;
    @Nullable private PluginCall purchaseCall;
    @Nullable private String purchaseProductId;

    @Override
    public void load() {
        billingClient = BillingClient.newBuilder(getContext())
            .setListener(this)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().enablePrepaidPlans().build())
            .enableAutoServiceReconnection()
            .build();
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (lock) {
            if (purchaseCall != null) {
                purchaseCall.reject("The purchase screen closed with the app", "PURCHASE_INTERRUPTED");
                purchaseCall = null;
                purchaseProductId = null;
            }
        }
        if (billingClient != null) billingClient.endConnection();
    }

    // ---- Connection --------------------------------------------------------------------------

    private void withBilling(PluginCall call, Runnable action) {
        if (billingClient.isReady()) {
            action.run();
            return;
        }
        boolean start;
        synchronized (lock) {
            waitingForConnection.add(action);
            waitingCalls.add(call);
            start = !connecting;
            connecting = true;
        }
        if (!start) return;
        billingClient.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult result) {
                List<Runnable> actions;
                List<PluginCall> calls;
                synchronized (lock) {
                    actions = new ArrayList<>(waitingForConnection);
                    calls = new ArrayList<>(waitingCalls);
                    waitingForConnection.clear();
                    waitingCalls.clear();
                    connecting = false;
                }
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    for (Runnable waiting : actions) waiting.run();
                } else {
                    for (PluginCall waiting : calls) rejectBilling(waiting, result, "Google Play Billing is unavailable");
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                // enableAutoServiceReconnection() re-establishes the connection on the next call.
            }
        });
    }

    // ---- Methods -----------------------------------------------------------------------------

    @PluginMethod
    public void isAvailable(PluginCall call) {
        withBilling(call, () -> {
            BillingResult subscriptions = billingClient.isFeatureSupported(BillingClient.FeatureType.SUBSCRIPTIONS);
            JSObject result = new JSObject();
            result.put("available", true);
            result.put("subscriptions", subscriptions.getResponseCode() == BillingClient.BillingResponseCode.OK);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void getProducts(PluginCall call) {
        List<String> ids = stringList(call.getArray("productIds"));
        if (ids == null || ids.isEmpty()) {
            call.reject("At least one product id is required", "INVALID_ARGUMENT");
            return;
        }
        withBilling(call, () -> queryProducts(ids, BillingClient.ProductType.INAPP, (inappResult, inapp) -> {
            if (inappResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                rejectBilling(call, inappResult, "Products could not be loaded");
                return;
            }
            queryProducts(ids, BillingClient.ProductType.SUBS, (subsResult, subs) -> {
                boolean subsUnsupported = subsResult.getResponseCode() == BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED;
                if (subsResult.getResponseCode() != BillingClient.BillingResponseCode.OK && !subsUnsupported) {
                    rejectBilling(call, subsResult, "Products could not be loaded");
                    return;
                }
                JSArray products = new JSArray();
                List<String> found = new ArrayList<>();
                for (ProductDetails details : inapp) {
                    products.put(productJson(details));
                    found.add(details.getProductId());
                }
                for (ProductDetails details : subs) {
                    products.put(productJson(details));
                    found.add(details.getProductId());
                }
                JSArray invalid = new JSArray();
                for (String id : ids) if (!found.contains(id)) invalid.put(id);
                JSObject result = new JSObject();
                result.put("products", products);
                result.put("invalidProductIds", invalid);
                call.resolve(result);
            });
        }));
    }

    @PluginMethod
    public void purchase(PluginCall call) {
        String productId = call.getString("productId");
        String appAccountToken = call.getString("appAccountToken");
        String offerToken = call.getString("offerToken");
        if (productId == null || productId.isEmpty()) {
            call.reject("A product id is required", "INVALID_ARGUMENT");
            return;
        }
        if (!isUuid(appAccountToken)) {
            call.reject("appAccountToken must be a UUID", "INVALID_ARGUMENT");
            return;
        }
        withBilling(call, () -> findProduct(productId, (result, details) -> {
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                rejectBilling(call, result, "The product could not be loaded");
                return;
            }
            if (details == null) {
                call.reject("The product is not available in this store", "PRODUCT_NOT_FOUND");
                return;
            }
            BillingFlowParams.ProductDetailsParams.Builder productParams = BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(details);
            if (BillingClient.ProductType.SUBS.equals(details.getProductType())) {
                String token = offerToken != null ? offerToken : basePlanOfferToken(details);
                if (token == null) {
                    call.reject("No subscription offer is available", "PRODUCT_NOT_FOUND");
                    return;
                }
                productParams.setOfferToken(token);
            } else if (offerToken != null) {
                productParams.setOfferToken(offerToken);
            }
            BillingFlowParams params = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(List.of(productParams.build()))
                .setObfuscatedAccountId(appAccountToken.toLowerCase())
                .build();
            Activity activity = getActivity();
            if (activity == null) {
                call.reject("The purchase screen could not be opened", "PURCHASE_UNAVAILABLE");
                return;
            }
            synchronized (lock) {
                if (purchaseCall != null) {
                    call.reject("Another purchase is already in progress", "PURCHASE_IN_PROGRESS");
                    return;
                }
                purchaseCall = call;
                purchaseProductId = productId;
            }
            activity.runOnUiThread(() -> {
                BillingResult launch = billingClient.launchBillingFlow(activity, params);
                if (launch.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    PluginCall pending = takePurchaseCall();
                    if (pending != null) settleFailedPurchase(pending, launch);
                }
            });
        }));
    }

    @Override
    public void onPurchasesUpdated(@NonNull BillingResult result, @Nullable List<Purchase> purchases) {
        String productId;
        synchronized (lock) {
            productId = purchaseProductId;
        }
        PluginCall pending = null;
        Purchase matched = null;
        if (result.getResponseCode() == BillingClient.BillingResponseCode.OK && purchases != null) {
            for (Purchase purchase : purchases) {
                if (matched == null && productId != null && purchase.getProducts().contains(productId)) matched = purchase;
            }
            if (matched != null) pending = takePurchaseCall();
            for (Purchase purchase : purchases) {
                if (purchase == matched && pending != null) continue;
                JSObject event = new JSObject();
                event.put("platform", "android");
                event.put("purchase", purchaseJson(purchase));
                notifyListeners(EVENT_TRANSACTION_UPDATED, event, true);
            }
            if (matched != null && pending != null) {
                JSObject resolved = new JSObject();
                resolved.put("platform", "android");
                resolved.put("status", matched.getPurchaseState() == Purchase.PurchaseState.PURCHASED ? "purchased" : "pending");
                resolved.put("purchase", purchaseJson(matched));
                pending.resolve(resolved);
            }
            return;
        }
        pending = takePurchaseCall();
        if (pending != null) settleFailedPurchase(pending, result);
    }

    @PluginMethod
    public void acknowledgePurchase(PluginCall call) {
        String token = call.getString("purchaseToken");
        if (token == null || token.isEmpty()) {
            call.reject("A purchase token is required", "INVALID_ARGUMENT");
            return;
        }
        withBilling(call, () -> billingClient.acknowledgePurchase(
            AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build(),
            result -> {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) call.resolve();
                else rejectBilling(call, result, "The purchase could not be acknowledged");
            }
        ));
    }

    @PluginMethod
    public void consumePurchase(PluginCall call) {
        String token = call.getString("purchaseToken");
        if (token == null || token.isEmpty()) {
            call.reject("A purchase token is required", "INVALID_ARGUMENT");
            return;
        }
        withBilling(call, () -> billingClient.consumeAsync(
            ConsumeParams.newBuilder().setPurchaseToken(token).build(),
            (result, consumedToken) -> {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) call.resolve();
                else rejectBilling(call, result, "The purchase could not be consumed");
            }
        ));
    }

    @PluginMethod
    public void finishTransaction(PluginCall call) {
        call.unimplemented("Android uses acknowledgePurchase or consumePurchase");
    }

    @PluginMethod
    public void restorePurchases(PluginCall call) {
        // Play has no restore flow: owned purchases are always returned by queryPurchasesAsync.
        ownedPurchases(call, false);
    }

    @PluginMethod
    public void currentEntitlements(PluginCall call) {
        ownedPurchases(call, false);
    }

    @PluginMethod
    public void unfinishedTransactions(PluginCall call) {
        ownedPurchases(call, true);
    }

    @PluginMethod
    public void getStorefront(PluginCall call) {
        withBilling(call, () -> billingClient.getBillingConfigAsync(
            GetBillingConfigParams.newBuilder().build(),
            (result, config) -> {
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK || config == null) {
                    rejectBilling(call, result, "The store country could not be read");
                    return;
                }
                JSObject storefront = new JSObject();
                storefront.put("platform", "android");
                storefront.put("countryCode", config.getCountryCode());
                call.resolve(storefront);
            }
        ));
    }

    @PluginMethod
    public void manageSubscriptions(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Subscriptions could not be opened", "UNAVAILABLE");
            return;
        }
        String productId = call.getString("productId");
        String url = "https://play.google.com/store/account/subscriptions?package=" + Uri.encode(getContext().getPackageName());
        if (productId != null && !productId.isEmpty()) url += "&sku=" + Uri.encode(productId);
        String target = url;
        activity.runOnUiThread(() -> {
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(target)));
                call.resolve();
            } catch (ActivityNotFoundException unavailable) {
                call.reject("Subscriptions could not be opened", "UNAVAILABLE");
            }
        });
    }

    // ---- Helpers -----------------------------------------------------------------------------

    private interface ProductsCallback {
        void done(BillingResult result, List<ProductDetails> details);
    }

    private interface ProductCallback {
        void done(BillingResult result, @Nullable ProductDetails details);
    }

    private void queryProducts(List<String> ids, String type, ProductsCallback callback) {
        List<QueryProductDetailsParams.Product> products = new ArrayList<>();
        for (String id : ids) {
            products.add(QueryProductDetailsParams.Product.newBuilder().setProductId(id).setProductType(type).build());
        }
        billingClient.queryProductDetailsAsync(
            QueryProductDetailsParams.newBuilder().setProductList(products).build(),
            (result, queryResult) -> callback.done(result, queryResult.getProductDetailsList())
        );
    }

    private void findProduct(String productId, ProductCallback callback) {
        List<String> ids = List.of(productId);
        queryProducts(ids, BillingClient.ProductType.SUBS, (subsResult, subs) -> {
            if (subsResult.getResponseCode() == BillingClient.BillingResponseCode.OK && !subs.isEmpty()) {
                callback.done(subsResult, subs.get(0));
                return;
            }
            queryProducts(ids, BillingClient.ProductType.INAPP, (inappResult, inapp) ->
                callback.done(inappResult, inapp.isEmpty() ? null : inapp.get(0)));
        });
    }

    private void ownedPurchases(PluginCall call, boolean unfinishedOnly) {
        withBilling(call, () -> queryOwned(BillingClient.ProductType.INAPP, (inappResult, inapp) -> {
            if (inappResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                rejectBilling(call, inappResult, "Purchases could not be loaded");
                return;
            }
            queryOwned(BillingClient.ProductType.SUBS, (subsResult, subs) -> {
                boolean subsUnsupported = subsResult.getResponseCode() == BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED;
                if (subsResult.getResponseCode() != BillingClient.BillingResponseCode.OK && !subsUnsupported) {
                    rejectBilling(call, subsResult, "Purchases could not be loaded");
                    return;
                }
                JSArray list = new JSArray();
                for (Purchase purchase : inapp) if (!unfinishedOnly || !purchase.isAcknowledged()) list.put(purchaseJson(purchase));
                for (Purchase purchase : subs) if (!unfinishedOnly || !purchase.isAcknowledged()) list.put(purchaseJson(purchase));
                JSObject result = new JSObject();
                result.put("platform", "android");
                result.put("purchases", list);
                call.resolve(result);
            });
        }));
    }

    private interface PurchasesCallback {
        void done(BillingResult result, List<Purchase> purchases);
    }

    private void queryOwned(String type, PurchasesCallback callback) {
        billingClient.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder().setProductType(type).build(),
            callback::done
        );
    }

    @Nullable
    private PluginCall takePurchaseCall() {
        synchronized (lock) {
            PluginCall call = purchaseCall;
            purchaseCall = null;
            purchaseProductId = null;
            return call;
        }
    }

    private void settleFailedPurchase(PluginCall call, BillingResult result) {
        if (result.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            JSObject cancelled = new JSObject();
            cancelled.put("platform", "android");
            cancelled.put("status", "cancelled");
            call.resolve(cancelled);
            return;
        }
        rejectBilling(call, result, "The purchase did not complete");
    }

    private static void rejectBilling(PluginCall call, BillingResult result, String message) {
        JSObject data = new JSObject();
        data.put("responseCode", result.getResponseCode());
        data.put("debugMessage", result.getDebugMessage());
        call.reject(message, billingCode(result.getResponseCode()), data);
    }

    private static String billingCode(int code) {
        switch (code) {
            case BillingClient.BillingResponseCode.USER_CANCELED: return "USER_CANCELLED";
            case BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED: return "ITEM_ALREADY_OWNED";
            case BillingClient.BillingResponseCode.ITEM_NOT_OWNED: return "ITEM_NOT_OWNED";
            case BillingClient.BillingResponseCode.ITEM_UNAVAILABLE: return "PRODUCT_NOT_FOUND";
            case BillingClient.BillingResponseCode.BILLING_UNAVAILABLE: return "BILLING_UNAVAILABLE";
            case BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED: return "FEATURE_NOT_SUPPORTED";
            case BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE:
            case BillingClient.BillingResponseCode.SERVICE_DISCONNECTED:
            case BillingClient.BillingResponseCode.NETWORK_ERROR: return "STORE_UNAVAILABLE";
            case BillingClient.BillingResponseCode.DEVELOPER_ERROR: return "DEVELOPER_ERROR";
            default: return "BILLING_ERROR";
        }
    }

    @Nullable
    private static String basePlanOfferToken(ProductDetails details) {
        List<ProductDetails.SubscriptionOfferDetails> offers = details.getSubscriptionOfferDetails();
        if (offers == null || offers.isEmpty()) return null;
        for (ProductDetails.SubscriptionOfferDetails offer : offers) {
            if (offer.getOfferId() == null) return offer.getOfferToken();
        }
        return offers.get(0).getOfferToken();
    }

    private static JSObject productJson(ProductDetails details) {
        JSObject product = new JSObject();
        product.put("platform", "android");
        product.put("id", details.getProductId());
        product.put("type", details.getProductType());
        product.put("name", details.getName());
        product.put("title", details.getTitle());
        product.put("description", details.getDescription());
        ProductDetails.OneTimePurchaseOfferDetails oneTime = details.getOneTimePurchaseOfferDetails();
        if (oneTime != null) {
            JSObject offer = new JSObject();
            offer.put("formattedPrice", oneTime.getFormattedPrice());
            offer.put("priceAmountMicros", String.valueOf(oneTime.getPriceAmountMicros()));
            offer.put("priceCurrencyCode", oneTime.getPriceCurrencyCode());
            product.put("oneTimePurchaseOffer", offer);
        }
        List<ProductDetails.SubscriptionOfferDetails> subscriptionOffers = details.getSubscriptionOfferDetails();
        if (subscriptionOffers != null) {
            JSArray offers = new JSArray();
            for (ProductDetails.SubscriptionOfferDetails offerDetails : subscriptionOffers) {
                JSObject offer = new JSObject();
                offer.put("basePlanId", offerDetails.getBasePlanId());
                offer.put("offerId", offerDetails.getOfferId());
                offer.put("offerToken", offerDetails.getOfferToken());
                offer.put("offerTags", new JSArray(offerDetails.getOfferTags()));
                JSArray phases = new JSArray();
                for (ProductDetails.PricingPhase phase : offerDetails.getPricingPhases().getPricingPhaseList()) {
                    JSObject pricing = new JSObject();
                    pricing.put("formattedPrice", phase.getFormattedPrice());
                    pricing.put("priceAmountMicros", String.valueOf(phase.getPriceAmountMicros()));
                    pricing.put("priceCurrencyCode", phase.getPriceCurrencyCode());
                    pricing.put("billingPeriod", phase.getBillingPeriod());
                    pricing.put("billingCycleCount", phase.getBillingCycleCount());
                    pricing.put("recurrenceMode", phase.getRecurrenceMode());
                    phases.put(pricing);
                }
                offer.put("pricingPhases", phases);
                offers.put(offer);
            }
            product.put("subscriptionOffers", offers);
        }
        return product;
    }

    static JSObject purchaseJson(Purchase purchase) {
        JSObject json = new JSObject();
        json.put("purchaseToken", purchase.getPurchaseToken());
        json.put("orderId", purchase.getOrderId());
        json.put("productIds", new JSArray(purchase.getProducts()));
        json.put("purchaseState", purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED
            ? "purchased"
            : purchase.getPurchaseState() == Purchase.PurchaseState.PENDING ? "pending" : "unspecified");
        json.put("purchaseTime", purchase.getPurchaseTime());
        json.put("quantity", purchase.getQuantity());
        json.put("isAcknowledged", purchase.isAcknowledged());
        json.put("isAutoRenewing", purchase.isAutoRenewing());
        json.put("packageName", purchase.getPackageName());
        if (purchase.getAccountIdentifiers() != null) {
            json.put("obfuscatedAccountId", purchase.getAccountIdentifiers().getObfuscatedAccountId());
        }
        json.put("originalJson", purchase.getOriginalJson());
        json.put("signature", purchase.getSignature());
        return json;
    }

    @Nullable
    private static List<String> stringList(@Nullable JSArray array) {
        if (array == null) return null;
        try {
            List<String> values = new ArrayList<>();
            for (Object value : array.toList()) {
                if (!(value instanceof String) || ((String) value).isEmpty()) return null;
                if (!values.contains(value)) values.add((String) value);
            }
            return values;
        } catch (JSONException invalid) {
            return null;
        }
    }

    private static boolean isUuid(@Nullable String value) {
        if (value == null || value.length() != 36) return false;
        try {
            UUID.fromString(value);
            return true;
        } catch (IllegalArgumentException invalid) {
            return false;
        }
    }
}
