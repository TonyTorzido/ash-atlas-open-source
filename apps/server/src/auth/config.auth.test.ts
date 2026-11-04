import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";

describe("production authentication configuration", () => {
  it("accepts explicit Google auth, HTTPS origins, optional Gmail enforcement, and distinct keys", () => {
    expect(loadConfig(validProductionEnv())).toMatchObject({
      NODE_ENV: "production",
      AUTH_MODE: "google",
      AUTH_RUNTIME_MODE: "public",
      AUTH_REQUIRE_GMAIL: true,
      AUTH_REQUIRED: true,
      DEV_TOOLS_ENABLED: false,
      DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED: false,
      AUTH_TRUST_PROXY: ["127.0.0.1", "::1"]
    });
    expect(loadConfig(validProductionEnv()).APPLE_SIGN_IN_ENABLED).toBe(false);
  });

  it("accepts any verified Google account in production when Gmail enforcement is off", () => {
    expect(loadConfig({ ...validProductionEnv(), AUTH_REQUIRE_GMAIL: "false" }).AUTH_REQUIRE_GMAIL)
      .toBe(false);
    expect(loadConfig({ ...validProductionEnv(), AUTH_REQUIRE_GMAIL: undefined }).AUTH_REQUIRE_GMAIL)
      .toBe(false);
  });

  it("keeps email sign-in disabled by default with the log sender", () => {
    expect(loadConfig(validProductionEnv())).toMatchObject({
      AUTH_EMAIL_LOGIN_ENABLED: false,
      AUTH_EMAIL_SENDER: "log",
      AUTH_EMAIL_DEV_LOG_CODES: false
    });
  });

  it("accepts production email sign-in only with Resend, a real sender, and a unique code key", () => {
    expect(loadConfig({ ...validProductionEnv(), ...productionEmailEnv() }))
      .toMatchObject({ AUTH_EMAIL_LOGIN_ENABLED: true, AUTH_EMAIL_SENDER: "resend" });
    for (const override of [
      { AUTH_EMAIL_SENDER: "log" },
      { AUTH_EMAIL_RESEND_API_KEY: "" },
      { AUTH_EMAIL_FROM: undefined },
      { AUTH_EMAIL_CODE_HMAC_KEY: undefined },
      { AUTH_EMAIL_CODE_HMAC_KEY: "session-key-aaaaaaaaaaaaaaaaaaaaaaaa" }
    ]) {
      expect(() =>
        loadConfig({ ...validProductionEnv(), ...productionEmailEnv(), ...override })
      ).toThrow();
    }
  });

  it("ignores development code logging in production", () => {
    expect(loadConfig({
      ...validProductionEnv(),
      ...productionEmailEnv(),
      AUTH_EMAIL_DEV_LOG_CODES: "true"
    }).AUTH_EMAIL_DEV_LOG_CODES).toBe(false);
  });

  it("fails closed for partial Apple configuration and accepts the complete contract", () => {
    expect(() => loadConfig({
      ...validProductionEnv(),
      APPLE_SIGN_IN_ENABLED: "true",
      APPLE_SERVICES_ID: "com.ashatlas.web"
    })).toThrow();

    expect(loadConfig({
      ...validProductionEnv(),
      APPLE_SIGN_IN_ENABLED: "true",
      APPLE_TEAM_ID: "TEAMID1234",
      APPLE_SERVICES_ID: "com.ashatlas.web",
      APPLE_KEY_ID: "KEYID1234",
      APPLE_PRIVATE_KEY_P8_BASE64: Buffer.from("private-key-placeholder").toString("base64"),
      APPLE_REFRESH_TOKEN_KEY_ID: "v1",
      APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64: Buffer.from("a".repeat(32)).toString("base64")
    }).APPLE_SIGN_IN_ENABLED).toBe(true);
  });

  it.each([
    ["development auth", { AUTH_MODE: "dev" }],
    ["development login flag", { AUTH_DEV_LOGIN_ENABLED: "true" }],
    ["unresolved development flags", { ALLOW_UNRESOLVED_FLAGS_IN_DEV: "true" }],
    ["missing client id", { GOOGLE_CLIENT_ID: "" }],
    ["wildcard origin", { AUTH_ALLOWED_ORIGINS: "*" }],
    ["insecure public origin", { APP_PUBLIC_ORIGIN: "http://game.example", AUTH_ALLOWED_ORIGINS: "http://game.example" }],
    ["missing test-access administrator", { TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: "" }],
    ["reused HMAC keys", { AUTH_DEVICE_TOKEN_HMAC_KEY: "session-key-aaaaaaaaaaaaaaaaaaaaaaaa" }],
    ["reused Dog genetics HMAC key", { DOG_GENETICS_HMAC_KEY: "session-key-aaaaaaaaaaaaaaaaaaaaaaaa" }],
    ["missing proxy trust", { AUTH_TRUST_PROXY: "" }],
    ["trust-all IPv4 proxy", { AUTH_TRUST_PROXY: "0.0.0.0/0" }],
    ["invalid proxy", { AUTH_TRUST_PROXY: "proxy.example.com" }]
  ])("rejects %s", (_label, override) => {
    expect(() => loadConfig({ ...validProductionEnv(), ...override })).toThrow();
  });

  it("allows public owner tooling configuration without enabling fake login", () => {
    expect(loadConfig({
      ...validProductionEnv(),
      DEV_TOOLS_ENABLED: "true",
      DEV_ADMIN_TOOLS_ENABLED: "true",
      DEV_AUTHORIZED_GOOGLE_SUBJECTS: "owner-google-subject",
      RUNTIME_SHA: "f".repeat(40)
    })).toMatchObject({
      AUTH_RUNTIME_MODE: "public",
      AUTH_DEV_LOGIN_ENABLED: false,
      DEV_TOOLS_ENABLED: true,
      DEV_ADMIN_TOOLS_ENABLED: true,
      DEV_AUTHORIZED_GOOGLE_SUBJECTS: ["owner-google-subject"]
    });
  });

  it("accepts production economy mutation only with every explicit safe gate", () => {
    expect(loadConfig(validProductionEconomyEnv())).toMatchObject({
      NODE_ENV: "production",
      AUTH_RUNTIME_MODE: "public",
      AUTH_MODE: "google",
      AUTH_DEV_LOGIN_ENABLED: false,
      DEV_TOOLS_ENABLED: true,
      DEV_ADMIN_TOOLS_ENABLED: true,
      DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED: true,
      DEV_AUTHORIZED_GOOGLE_SUBJECTS: ["owner-google-subject"],
      RUNTIME_SHA: "f".repeat(40)
    });
  });

  it.each([
    ["non-production runtime", { NODE_ENV: "development" }],
    ["non-public auth runtime", { AUTH_RUNTIME_MODE: "private" }],
    ["non-Google auth", { AUTH_MODE: "dev" }],
    ["development login", { AUTH_DEV_LOGIN_ENABLED: "true" }],
    ["disabled developer tools", { DEV_TOOLS_ENABLED: "false" }],
    ["disabled admin tools", { DEV_ADMIN_TOOLS_ENABLED: "false" }],
    ["empty subject allowlist", { DEV_AUTHORIZED_GOOGLE_SUBJECTS: "" }],
    ["missing release SHA", { RUNTIME_SHA: undefined }]
  ])("rejects production economy mutation with %s", (_label, override) => {
    expect(() =>
      loadConfig({ ...validProductionEconomyEnv(), ...override })
    ).toThrow();
  });

  it("rejects invalid session lifetimes", () => {
    expect(() =>
      loadConfig({
        ...validProductionEnv(),
        AUTH_SESSION_ABSOLUTE_DAYS: "10",
        AUTH_SESSION_INACTIVITY_DAYS: "14"
      })
    ).toThrow();
  });

  it("enables development login only with an explicit local-development configuration", () => {
    expect(
      loadConfig({
        NODE_ENV: "development",
        AUTH_RUNTIME_MODE: "local",
        AUTH_MODE: "dev",
        AUTH_DEV_LOGIN_ENABLED: "true"
      }).AUTH_DEV_LOGIN_ENABLED
    ).toBe(true);

    for (const override of [
      { NODE_ENV: "test", AUTH_RUNTIME_MODE: "local", AUTH_MODE: "dev", AUTH_DEV_LOGIN_ENABLED: "true" },
      { NODE_ENV: "development", AUTH_RUNTIME_MODE: "local", AUTH_MODE: "google", AUTH_DEV_LOGIN_ENABLED: "true" },
      {
        NODE_ENV: "development",
        AUTH_RUNTIME_MODE: "local",
        AUTH_MODE: "dev",
        AUTH_DEV_LOGIN_ENABLED: "true",
        APP_PUBLIC_ORIGIN: "https://staging.example",
        AUTH_ALLOWED_ORIGINS: "https://staging.example"
      }
    ]) {
      expect(() => loadConfig(override)).toThrow();
    }
  });

  it("allows explicit private-LAN HTTP origins for development login", () => {
    expect(
      loadConfig({
        NODE_ENV: "development",
        AUTH_RUNTIME_MODE: "private",
        AUTH_MODE: "dev",
        AUTH_DEV_LOGIN_ENABLED: "true",
        APP_PUBLIC_ORIGIN: "http://127.0.0.1:5300",
        AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:5300,http://192.168.1.10:5300"
      }).AUTH_ALLOWED_ORIGINS
    ).toEqual(["http://127.0.0.1:5300", "http://192.168.1.10:5300"]);
  });

  it.each([
    "http://8.8.8.8:5300",
    "http://100.64.0.10:5300",
    "https://192.168.1.10:5300"
  ])("rejects non-private development origin %s", (origin) => {
    expect(() =>
      loadConfig({
        NODE_ENV: "development",
        AUTH_RUNTIME_MODE: "private",
        AUTH_MODE: "dev",
        AUTH_DEV_LOGIN_ENABLED: "true",
        APP_PUBLIC_ORIGIN: "http://127.0.0.1:5300",
        AUTH_ALLOWED_ORIGINS: `http://127.0.0.1:5300,${origin}`
      })
    ).toThrow();
  });
});

describe("AUTH_DEV_EXTRA_ORIGINS development opt-in", () => {
  const tailnet = "https://devbox.example-tailnet.ts.net:41297";
  const devLoginEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    NODE_ENV: "development",
    AUTH_RUNTIME_MODE: "local",
    AUTH_MODE: "dev",
    AUTH_DEV_LOGIN_ENABLED: "true",
    APP_PUBLIC_ORIGIN: "http://127.0.0.1:41297",
    AUTH_ALLOWED_ORIGINS: `http://127.0.0.1:41297,${tailnet}`,
    AUTH_DEV_EXTRA_ORIGINS: tailnet,
    ...overrides
  });

  it("lets an exact ts.net https origin sit beside development login", () => {
    expect(loadConfig(devLoginEnv())).toMatchObject({
      AUTH_ALLOWED_ORIGINS: ["http://127.0.0.1:41297", tailnet],
      AUTH_DEV_EXTRA_ORIGINS: [tailnet]
    });
    expect(
      loadConfig(devLoginEnv({
        AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:41297,https://phone.example-tailnet.ts.net",
        AUTH_DEV_EXTRA_ORIGINS: "https://phone.example-tailnet.ts.net"
      })).AUTH_DEV_EXTRA_ORIGINS
    ).toEqual(["https://phone.example-tailnet.ts.net"]);
  });

  it.each([
    ["http ts.net", "http://devbox.example-tailnet.ts.net:41297"],
    ["non-ts.net https host", "https://staging.example:41297"],
    ["ts.net suffix spoof", "https://devbox.ts.net.example:41297"],
    ["wildcard", "https://*.example-tailnet.ts.net:41297"],
    ["path", "https://devbox.example-tailnet.ts.net:41297/game"],
    ["trailing slash", "https://devbox.example-tailnet.ts.net:41297/"],
    ["credentials", "https://user@devbox.example-tailnet.ts.net:41297"]
  ])("rejects a %s entry", (_label, origin) => {
    expect(() =>
      loadConfig(devLoginEnv({
        AUTH_ALLOWED_ORIGINS: `http://127.0.0.1:41297,${origin}`,
        AUTH_DEV_EXTRA_ORIGINS: origin
      }))
    ).toThrow(/AUTH_DEV_EXTRA_ORIGINS|AUTH_ALLOWED_ORIGINS/u);
  });

  it("requires every entry to also be an allowed origin", () => {
    expect(() =>
      loadConfig(devLoginEnv({ AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:41297" }))
    ).toThrow(/must also be listed in AUTH_ALLOWED_ORIGINS/u);
  });

  it("does not exempt allowed https origins that are not listed", () => {
    expect(() =>
      loadConfig(devLoginEnv({
        AUTH_ALLOWED_ORIGINS: `http://127.0.0.1:41297,${tailnet},https://other.example-tailnet.ts.net`
      }))
    ).toThrow(/loopback or private-LAN HTTP origins/u);
  });

  it("never exempts APP_PUBLIC_ORIGIN", () => {
    expect(() => loadConfig(devLoginEnv({ APP_PUBLIC_ORIGIN: tailnet }))).toThrow(
      /loopback or private-LAN HTTP origins/u
    );
  });

  it.each([
    ["development login off", { AUTH_DEV_LOGIN_ENABLED: "false" }],
    ["test runtime", { NODE_ENV: "test" }],
    ["Google auth", { AUTH_MODE: "google" }],
    ["public auth runtime", { AUTH_RUNTIME_MODE: "public" }]
  ])("rejects the env with %s", (_label, override) => {
    expect(() => loadConfig(devLoginEnv(override))).toThrow(/AUTH_DEV_EXTRA_ORIGINS requires/u);
  });

  it("rejects the env in production even for an https ts.net allowed origin", () => {
    expect(() =>
      loadConfig({
        ...validProductionEnv(),
        AUTH_ALLOWED_ORIGINS: `https://game.example,${tailnet}`,
        AUTH_DEV_EXTRA_ORIGINS: tailnet
      })
    ).toThrow(/AUTH_DEV_EXTRA_ORIGINS requires/u);
  });

  it("leaves every existing rule unchanged when unset", () => {
    const unset = devLoginEnv({ AUTH_DEV_EXTRA_ORIGINS: undefined });
    expect(() => loadConfig(unset)).toThrow(/loopback or private-LAN HTTP origins/u);
    expect(
      loadConfig({ ...unset, AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:41297,http://192.168.1.5:41297" })
        .AUTH_DEV_EXTRA_ORIGINS
    ).toEqual([]);
    expect(loadConfig(validProductionEnv()).AUTH_DEV_EXTRA_ORIGINS).toEqual([]);
  });
});

function validProductionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    AUTH_RUNTIME_MODE: "public",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "google-client-id.apps.googleusercontent.com",
    APP_PUBLIC_ORIGIN: "https://game.example",
    AUTH_ALLOWED_ORIGINS: "https://game.example",
    AUTH_TRUST_PROXY: "127.0.0.1,::1",
    AUTH_SESSION_TOKEN_HMAC_KEY: "session-key-aaaaaaaaaaaaaaaaaaaaaaaa",
    AUTH_DEVICE_TOKEN_HMAC_KEY: "device-key-bbbbbbbbbbbbbbbbbbbbbbbbb",
    AUTH_NETWORK_HMAC_KEY: "network-key-ccccccccccccccccccccccccc",
    INITIAL_SPAWN_HMAC_KEY: "spawn-key-ddddddddddddddddddddddddddddd",
    DOG_GENETICS_HMAC_KEY: "dog-genetics-key-eeeeeeeeeeeeeeeeeeeeeeee",
    AUTH_REQUIRE_GMAIL: "true",
    TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: "test-access-admin-subject",
    ALLOW_UNRESOLVED_FLAGS_IN_DEV: "false",
    DEV_TOOLS_ENABLED: "false"
  };
}

function productionEmailEnv(): NodeJS.ProcessEnv {
  return {
    AUTH_EMAIL_LOGIN_ENABLED: "true",
    AUTH_EMAIL_SENDER: "resend",
    AUTH_EMAIL_RESEND_API_KEY: "re_test_key",
    AUTH_EMAIL_FROM: "Ash Atlas <login@game.example>",
    AUTH_EMAIL_CODE_HMAC_KEY: "email-code-key-ffffffffffffffffffffffffff"
  };
}

function validProductionEconomyEnv(): NodeJS.ProcessEnv {
  return {
    ...validProductionEnv(),
    DEV_TOOLS_ENABLED: "true",
    DEV_ADMIN_TOOLS_ENABLED: "true",
    DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED: "true",
    DEV_AUTHORIZED_GOOGLE_SUBJECTS: "owner-google-subject",
    RUNTIME_SHA: "f".repeat(40)
  };
}

describe("production trust ladder configuration", () => {
  it("defaults every trust mechanism to shadow and refuses enforce without the ladder ack", () => {
    expect(loadConfig(validProductionEnv())).toMatchObject({
      TRUST_LOCATION_REJECT_MODE: "shadow",
      TRUST_LAND_ACTION_MODE: "shadow",
      TRUST_QUARANTINE_MODE: "shadow",
      TRUST_LADDER_MAX_TIER: 2,
      TRUST_DECAY_TAU_DAYS: 7
    });
    expect(() => loadConfig({ ...validProductionEnv(), TRUST_QUARANTINE_MODE: "enforce" })).toThrow(/TRUST_LADDER_ACK/);
    expect(loadConfig({
      ...validProductionEnv(),
      TRUST_QUARANTINE_MODE: "enforce",
      TRUST_LADDER_ACK: "true"
    }).TRUST_QUARANTINE_MODE).toBe("enforce");
  });
});

describe("device attestation configuration", () => {
  it("defaults to shadow modes with every provider disabled", () => {
    expect(loadConfig(validProductionEnv())).toMatchObject({
      TRUST_ATTESTATION_MODE: "shadow",
      TRUST_MOCK_LOCATION_MODE: "shadow",
      TRUST_PLAY_INTEGRITY_ENABLED: false,
      TRUST_APP_ATTEST_ENABLED: false,
      TRUST_DEVICECHECK_ENABLED: false,
      TRUST_ATTEST_VERDICT_TTL_SECONDS: 1800,
      TRUST_ATTEST_CHALLENGE_TTL_SECONDS: 300,
      TRUST_ATTEST_VERIFY_TIMEOUT_MS: 4000,
      TRUST_ATTEST_RETENTION_DAYS: 90
    });
  });

  it("requires production Play Integrity, App Attest and DeviceCheck settings", () => {
    const digest = "AB:".repeat(31) + "AB";
    expect(() => loadConfig({ ...validProductionEnv(), TRUST_PLAY_INTEGRITY_ENABLED: "true", TRUST_PLAY_INTEGRITY_CERT_SHA256: digest }))
      .toThrow(/TRUST_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER/u);
    expect(() => loadConfig({ ...validProductionEnv(), TRUST_PLAY_INTEGRITY_ENABLED: "true", TRUST_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER: "123" }))
      .toThrow(/certificate digest/u);
    expect(loadConfig({
      ...validProductionEnv(),
      TRUST_PLAY_INTEGRITY_ENABLED: "true",
      TRUST_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER: "123",
      TRUST_PLAY_INTEGRITY_CERT_SHA256: digest
    }).TRUST_PLAY_INTEGRITY_ENABLED).toBe(true);
    expect(() => loadConfig({ ...validProductionEnv(), TRUST_PLAY_INTEGRITY_CERT_SHA256: "AB:CD" }))
      .toThrow(/TRUST_PLAY_INTEGRITY_CERT_SHA256/u);
    expect(() => loadConfig({ ...validProductionEnv(), TRUST_PLAY_INTEGRITY_CREDENTIALS_JSON_BASE64: "bm90IGpzb24=" }))
      .toThrow(/TRUST_PLAY_INTEGRITY_CREDENTIALS_JSON_BASE64/u);
    expect(() => loadConfig({ ...validProductionEnv(), TRUST_APP_ATTEST_ALLOW_DEVELOPMENT: "true" }))
      .toThrow(/development App Attest/u);
    expect(loadConfig({ NODE_ENV: "test", TRUST_APP_ATTEST_ALLOW_DEVELOPMENT: "true" }).TRUST_APP_ATTEST_ALLOW_DEVELOPMENT).toBe(true);
    expect(() => loadConfig({ ...validProductionEnv(), TRUST_DEVICECHECK_ENABLED: "true", TRUST_DEVICECHECK_KEY_ID: "KEY" }))
      .toThrow(/TRUST_DEVICECHECK/u);
  });
});
