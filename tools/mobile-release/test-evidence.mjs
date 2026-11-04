export function smokeEvidence(release, pushMode = "disabled") {
  return { schemaVersion: 1, checklistVersion: 1, platform: release.platform, sourceSha: release.sourceSha,
    artifactSha256: release.artifactSha256, storeBuildId: release.storeBuildId, marketingVersion: release.marketingVersion,
    build: release.build, pushMode, result: "passed", testedAt: "2026-09-19T00:00:00Z", tester: "Test fixture",
    device: "Physical test device", osVersion: "Test OS", evidenceUrl: "https://example.test/internal-smoke",
    checks: Object.fromEntries(["store-install-update", "cold-start", "sign-in", "world-load", "movement-inventory",
      "background-resume", "network-reconnect", ...(pushMode === "enabled" ? ["notification-permission", "notification-receive-background", "notification-tap"] : ["notification-disabled"])]
      .map((key) => [key, "passed"])) };
}
export function promotionEvidence(release) {
  const receipt = { schemaVersion: 1, toolSha: "d".repeat(40), actor: "test-operator", receiptUrl: "https://github.com/test/repo/actions/runs/123" };
  return { artifactValidation: artifactEvidence(release), internalSmokeEvidence: smokeEvidence(release),
    promotionApproval: { ...receipt, intent: "promote-existing", approvedAt: "2026-09-19T00:00:00Z" },
    promotionExecutions: [{ ...receipt, startedAt: "2026-09-19T00:00:00Z" }] };
}
export function artifactEvidence(release, pushMode = "disabled") {
  return { schemaVersion: 1, validated: true, platform: release.platform, sourceSha: release.sourceSha,
    artifactSha256: release.artifactSha256, marketingVersion: release.marketingVersion, build: release.build, pushMode };
}
