import { describe, expect, it } from "vitest";

import { loadConfig } from "../../../config.js";
import { AttestationService } from "./attestationService.js";
import type { AttestationStore } from "./attestationStore.js";

const store = {} as AttestationStore;
const service = (env: Record<string, string>, providers = true) => new AttestationService(
  store,
  loadConfig({ NODE_ENV: "test", ...env }),
  providers
    ? { playIntegrity: async () => ({ status: "unavailable", code: "x" }), deviceCheck: async () => "unavailable" }
    : {}
);

describe("AttestationService.sessionConfig", () => {
  it("is absent when off or nothing is enabled", () => {
    expect(service({}).sessionConfig()).toBeUndefined();
    expect(service({ TRUST_ATTESTATION_MODE: "off", TRUST_APP_ATTEST_ENABLED: "true" }).sessionConfig()).toBeUndefined();
    // Enabled without a provider client is not offered.
    expect(service({ TRUST_PLAY_INTEGRITY_ENABLED: "true", TRUST_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER: "42" }, false).sessionConfig())
      .toBeUndefined();
  });

  it("describes the enabled providers without secrets", () => {
    expect(service({
      TRUST_PLAY_INTEGRITY_ENABLED: "true",
      TRUST_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER: "42",
      TRUST_APP_ATTEST_ENABLED: "true",
      TRUST_DEVICECHECK_ENABLED: "true"
    }).sessionConfig()).toEqual({
      mode: "shadow",
      android: { cloudProjectNumber: "42" },
      ios: { appAttest: true, deviceCheck: true },
      refreshSeconds: 1500
    });
  });
});
