const PLATFORMS = new Set(["ios", "android"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const TESTFLIGHT_GROUP_ID = /^[A-Za-z0-9-]+$/u;
const TESTFLIGHT_LINK = /^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/u;

export const DAILY_TESTER_MODE = "daily-testers";
export const GOOGLE_INTERNAL_TEST_TRACK = "internal";

export function readTesterDeliveryMode(value, keys = ["delivery_mode", "deliveryMode"]) {
  requireState(value && typeof value === "object" && !Array.isArray(value),
    "delivery mode container is invalid");
  const supplied = keys.map((key) => value[key]).filter((entry) => entry !== undefined && entry !== null);
  if (supplied.length === 0) return null;
  const normalized = supplied.map((entry) => String(entry));
  requireState(normalized.every((entry) => entry === normalized[0]), "delivery mode aliases disagree");
  return normalized[0];
}

/**
 * Normalize the tester destination that is part of the immutable candidate
 * packet.  A TestFlight group is deliberately explicit: App Store Connect
 * internal users and an external public-link group have different review and
 * availability semantics, so an omitted or ambiguous type cannot authorize
 * a store write.
 */
export function normalizeTesterDestination(platform, value) {
  requireState(PLATFORMS.has(platform), "tester destination platform is invalid");
  requireState(value && typeof value === "object" && !Array.isArray(value),
    `${platform} tester destination is required`);
  if (platform === "android") {
    const kind = consistentAlias(value, ["kind", "destination"], "Android tester destination kind");
    const track = consistentAlias(value, ["track", "google_track"], "Android tester destination track");
    requireState(["google-play-internal", "google-play"].includes(kind),
      "Android tester destination must be Google Play internal testing");
    requireState(track === GOOGLE_INTERNAL_TEST_TRACK,
      `Android tester destination must use Google Play ${GOOGLE_INTERNAL_TEST_TRACK}`);
    return { kind: "google-play-internal", track: GOOGLE_INTERNAL_TEST_TRACK };
  }
  const kind = consistentAlias(value, ["kind", "destination"], "iOS tester destination kind");
  const groupType = consistentAlias(value, ["group_type", "groupType"], "iOS TestFlight group type").toLowerCase();
  const groupId = consistentAlias(value, ["group_id", "groupId"], "iOS TestFlight group ID");
  requireState(kind === "testflight", "iOS tester destination must be TestFlight");
  requireState(["internal", "external"].includes(groupType),
    "iOS TestFlight group type must be explicitly internal or external");
  requireState(TESTFLIGHT_GROUP_ID.test(groupId),
    "iOS TestFlight group ID is required and invalid");
  const publicLink = consistentAlias(value, ["public_link", "publicLink"], "TestFlight public link", { optional: true });
  if (groupType === "external") {
    requireState(TESTFLIGHT_LINK.test(String(publicLink ?? "")),
      "external TestFlight destination requires the existing public link");
  } else if (publicLink !== undefined && publicLink !== null && publicLink !== "") {
    requireState(TESTFLIGHT_LINK.test(String(publicLink)),
      "internal TestFlight destination has an invalid public link");
    requireState(false, "internal TestFlight destination must not include a public link");
  }
  return { kind: "testflight", group_type: groupType, group_id: groupId,
    ...(groupType === "external" ? { public_link: String(publicLink) } : {}) };
}

export function readTesterDestination(platform, value, keys = ["tester_destination", "testerDestination", "testing"]) {
  requireState(value && typeof value === "object" && !Array.isArray(value),
    `${platform} tester destination container is invalid`);
  const supplied = keys.map((key) => value[key]).filter((entry) => entry !== undefined && entry !== null);
  if (supplied.length === 0) return null;
  const normalized = supplied.map((entry) => normalizeTesterDestination(platform, entry));
  requireState(normalized.every((entry) => JSON.stringify(entry) === JSON.stringify(normalized[0])),
    `${platform} tester destination aliases disagree`);
  return normalized[0];
}

export function assertTesterDestinationBinding(candidate, expected) {
  const actual = candidate?.tester_destination ?? candidate?.testerDestination;
  const normalized = normalizeTesterDestination(candidate?.platform, actual);
  const target = normalizeTesterDestination(candidate.platform, expected);
  requireState(JSON.stringify(normalized) === JSON.stringify(target),
    "tester destination changed for the coordinated candidate");
  return normalized;
}

/**
 * Validate a store observation already shaped by a trusted adapter.  This
 * keeps the coordinator independent from App Store Connect and Play wire
 * formats while requiring exact candidate identity and destination evidence.
 */
export function validateTesterObservation({ platform, candidate, destination, observation }) {
  const target = normalizeTesterDestination(platform, destination);
  const marketingVersion = candidate.marketing_version ?? candidate.marketingVersion;
  const build = candidate.build;
  const storeBuildId = candidate.store_build_id ?? candidate.storeBuildId;
  const artifactSha256 = candidate.artifact_sha256 ?? candidate.artifactSha256;
  requireState(observation && typeof observation === "object" && !Array.isArray(observation),
    `${platform} tester observation is missing`);
  requireState(observation.platform === platform && observation.available === true,
    `${platform} tester candidate is not store-observed as available`);
  requireState(observation.marketing_version === marketingVersion ||
    observation.marketingVersion === marketingVersion,
  `${platform} tester observation marketing version changed`);
  requireState(Number(observation.build) === Number(build),
    `${platform} tester observation build changed`);
  requireState(String(observation.store_build_id ?? observation.storeBuildId) ===
    String(storeBuildId),
  `${platform} tester observation store identity changed`);
  requireState(String(observation.artifact_sha256 ?? observation.artifactSha256).toLowerCase() ===
    String(artifactSha256).toLowerCase() && SHA256.test(String(artifactSha256)),
  `${platform} tester observation artifact fingerprint changed`);
  if (platform === "android") {
    requireState(observation.track === target.track && observation.status === "completed",
      "Google tester observation is not an exact completed internal assignment");
    if (observation.available === true) {
      requireState(observation.lifecycle_status === "RELEASE_LIFECYCLE_STATE_PUBLISHED",
        "Google tester observation is not published on the internal track");
      requireState(Number(observation.active_artifact_version_code) === Number(build),
        "Google tester observation active artifact changed");
    }
  } else {
    requireState(observation.group_type === target.group_type && observation.group_id === target.group_id,
      "TestFlight tester observation group changed");
    if (target.group_type === "external") requireState(observation.public_link === target.public_link,
      "TestFlight public link changed during tester verification");
  }
  return { ...observation, destination: target };
}

export function testerAvailableFromSnapshot(snapshot, candidate, destination) {
  const observation = snapshot?.tester ?? snapshot?.tester_observation;
  if (!observation) return false;
  try {
    validateTesterObservation({ platform: candidate.platform, candidate, destination, observation });
    return true;
  } catch {
    return false;
  }
}

export function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

function consistentAlias(value, keys, label, { optional = false } = {}) {
  const supplied = keys.map((key) => value[key]).filter((entry) => entry !== undefined && entry !== null);
  if (supplied.length === 0) {
    requireState(optional, `${label} is required`);
    return undefined;
  }
  const normalized = supplied.map((entry) => String(entry));
  requireState(normalized.every((entry) => entry === normalized[0]), `${label} aliases disagree`);
  return normalized[0];
}
