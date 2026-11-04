/// <reference types="@capawesome/capacitor-live-update" />

import type { CapacitorConfig } from "@capacitor/cli";

const liveUpdatePublicKey = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8F4tyXVMHOvXleFyXYOK
PQJkHtKKOy8fvl280ZWejrbpNPjMYM7WQgMW+j0gtjm11PudxCBjUPd2WwN3KEQ0
/HMcVGYTYMP/r3iKqiztxkQ70OVBwB2w/tqRNNWWOqQw6J5wvv6JBd1eLdhak5uv
xB5vjywKYEQZobuNj4IZH7RTXEY1Am4ddmACIzkq0sw+D5Decl3F6RqoExujIOgd
F39RNgiIwWMeRE5rwprZpRyAdBKklmG6E5Nc/+GcE5NYI+2B8qmWNYLqXbeM3BNF
zbDxZNeKbNJby8+tCq0SZMznlYc1tmxwbtwzb6972bJcjoIutxNxxWzG256QXO0K
QwIDAQAB
-----END PUBLIC KEY-----`;

const config: CapacitorConfig = {
  appId: "com.ashatlas.game",
  appName: "Ash Atlas",
  webDir: "apps/client/dist",
  server: {
    iosScheme: "capacitor",
    androidScheme: "https"
  },
  plugins: {
    PushNotifications: { presentationOptions: [] },
    CapacitorCookies: {
      enabled: true
    },
    CapacitorHttp: {
      enabled: true
    },
    LiveUpdate: {
      // Self-hosted tester bundles are downloaded explicitly by the client.
      // The plugin still owns signature verification, rollback, and blocked IDs.
      autoBlockRolledBackBundles: true,
      autoDeleteBundles: true,
      autoUpdateStrategy: "none",
      readyTimeout: 10_000,
      ...(liveUpdatePublicKey ? { publicKey: liveUpdatePublicKey } : {})
    }
  }
};

export default config;
