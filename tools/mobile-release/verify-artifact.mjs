import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGE, requireState } from "./store-api.mjs";

export const BUNDLETOOL_SHA256 = "a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29";
const run = (command, args, input) => execFileSync(command, args, { encoding: "utf8", input, env: { ...process.env, LC_ALL: "C" }, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
const plist = (input) => JSON.parse(run("plutil", ["-convert", "json", "-o", "-", "--", "-"], input));
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function expectedUploadCertificateSha256(env) {
  const value = String(env.ASH_ATLAS_PLAY_UPLOAD_CERT_SHA256 ?? "").trim().toUpperCase();
  requireState(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(value), "ASH_ATLAS_PLAY_UPLOAD_CERT_SHA256 must be the upload certificate SHA-256 fingerprint");
  return value;
}

export function validateCapacitor(config) {
  requireState(config.appId === PACKAGE && !config.server?.url && config.server?.cleartext !== true &&
    config.server?.iosScheme === "capacitor" && config.server?.androidScheme === "https",
  "Final artifact has an unexpected app/server configuration");
}

export function validateBundledBuild(marker, platform, env) {
  requireState(marker.schemaVersion === 1 && marker.platform === platform && marker.version === env.VITE_NATIVE_APP_VERSION &&
    marker.build === Number(env.VITE_NATIVE_APP_BUILD) && marker.pushMode === (env.VITE_NATIVE_PUSH_ENABLED === "true" ? "enabled" : "disabled"),
  "Bundled native build marker does not match the validated artifact identity/push mode");
}

export function validateFirebaseResource(dump, name, expected) {
  const lines = dump.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  requireState(lines.length === 3 && lines[0] === `Package '${PACKAGE}':` &&
    /^0x[0-9a-f]+ - string\/[A-Za-z_]+$/u.test(lines[1]) && lines[1].endsWith(` - string/${name}`) &&
    lines[2] === `(default) - [STR] ${JSON.stringify(String(expected))}`, "Final AAB Firebase resource differs from public app configuration");
}

// Every permission the final AAB may request. Location (game) and INTERNET are
// ours; the rest are merged from libraries: VIBRATE (haptics), BILLING (Play
// Billing), the Firebase Messaging set (push), and androidx.core's
// app-private receiver permission. Anything else fails the artifact.
export const ANDROID_ALLOWED_PERMISSIONS = Object.freeze([
  "android.permission.INTERNET",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.VIBRATE",
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.WAKE_LOCK",
  "com.google.android.c2dm.permission.RECEIVE",
  "com.android.vending.BILLING",
  `${PACKAGE}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`
]);

export function validateAndroidPermissions(permissions) {
  const unexpected = permissions.filter((name) => !ANDROID_ALLOWED_PERMISSIONS.includes(name));
  requireState(unexpected.length === 0, `Final AAB requests unexpected permissions: ${unexpected.join(", ")}`);
  for (const required of ["android.permission.INTERNET", "android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION"]) {
    requireState(permissions.includes(required), `Final AAB is missing ${required}`);
  }
}

// The store build's capabilities must survive the unsigned archive + export re-sign.
export function validateIosCapabilities(entitlements) {
  requireState(entitlements["aps-environment"] === "production" &&
    entitlements["com.apple.developer.devicecheck.appattest-environment"] === "production" &&
    entitlements["com.apple.developer.associated-domains"]?.includes("applinks:playashatlas.com") &&
    entitlements["com.apple.developer.applesignin"]?.includes("Default"),
  "Exported IPA is missing APNs (production), App Attest (production), associated domains or Sign in with Apple entitlements");
}

export function validateIos(info, entitlements, profile, env) {
  requireState(info.CFBundleIdentifier === PACKAGE && info.CFBundleShortVersionString === env.VITE_NATIVE_APP_VERSION &&
    String(info.CFBundleVersion) === env.VITE_NATIVE_APP_BUILD, "Exported IPA identity mismatch");
  requireState(info.CFBundleURLTypes?.some((entry) => entry.CFBundleURLSchemes?.includes(PACKAGE)), "IPA auth callback scheme missing");
  requireState(entitlements["application-identifier"] === `${env.APPLE_TEAM_ID}.${PACKAGE}` &&
    entitlements["com.apple.developer.team-identifier"] === env.APPLE_TEAM_ID && entitlements["get-task-allow"] !== true,
  "Exported IPA signing entitlements mismatch");
  requireState(profile.TeamIdentifier?.includes(env.APPLE_TEAM_ID) &&
    profile.Entitlements?.["application-identifier"] === `${env.APPLE_TEAM_ID}.${PACKAGE}` &&
    profile.Entitlements?.["get-task-allow"] === false && !profile.ProvisionedDevices && !profile.ProvisionsAllDevices &&
    Date.parse(profile.ExpirationDate) > Date.now(), "IPA profile is not valid App Store distribution");
  validateIosCapabilities(entitlements);
  if (env.VITE_NATIVE_PUSH_ENABLED === "true") requireState(entitlements["aps-environment"] === "production" &&
    profile.Entitlements["aps-environment"] === "production", "Push-enabled IPA requires production APNs entitlement and profile");
}

function verifyIos(artifact, env) {
  const directory = mkdtempSync(join(env.ASH_ATLAS_JOB_TEMP, "ipa-verify-"));
  try {
    run("unzip", ["-q", artifact, "-d", directory]);
    const apps = readdirSync(join(directory, "Payload")).filter((name) => name.endsWith(".app"));
    requireState(apps.length === 1, "Expected exactly one exported IPA app");
    const app = join(directory, "Payload", apps[0]);
    requireState(/^[A-Z0-9]+$/u.test(env.APPLE_TEAM_ID), "Invalid signing team");
    run("codesign", ["--verify", "--deep", "--strict", "-R", `=anchor apple generic and certificate leaf[subject.OU] = "${env.APPLE_TEAM_ID}"`, app]);
    const info = plist(readFileSync(join(app, "Info.plist")));
    const entitlements = plist(run("codesign", ["-d", "--entitlements", ":-", app]));
    const profileXml = run("security", ["cms", "-D", "-i", join(app, "embedded.mobileprovision")]);
    const extract = (key, format = "json") => run("plutil", ["-extract", key, format, "-o", "-", "--", "-"], profileXml).trim();
    // Profiles contain NSData and NSDate, which cannot be converted wholesale to JSON.
    const profile = { TeamIdentifier: JSON.parse(extract("TeamIdentifier")), Entitlements: JSON.parse(extract("Entitlements")),
      ExpirationDate: extract("ExpirationDate", "raw"),
      ProvisionedDevices: run("xmllint", ["--xpath", "boolean(/plist/dict/key[.='ProvisionedDevices'])", "-"], profileXml).trim() === "true",
      ProvisionsAllDevices: run("xmllint", ["--xpath", "boolean(/plist/dict/key[.='ProvisionsAllDevices']/following-sibling::*[1][self::true])", "-"], profileXml).trim() === "true" };
    run("codesign", ["-d", `--extract-certificates=${join(directory, "signer-")}`, app]);
    const signer = readFileSync(join(directory, "signer-0"));
    const certificateCount = Number(extract("DeveloperCertificates", "raw"));
    requireState(Number.isSafeInteger(certificateCount) && certificateCount > 0 && certificateCount < 100, "Invalid profile certificates");
    requireState(Array.from({ length: certificateCount }, (_, index) =>
      Buffer.from(extract(`DeveloperCertificates.${index}`, "raw"), "base64")).some((certificate) => certificate.equals(signer)),
    "Exported IPA signer is not authorized by the embedded profile");
    validateIos(info, entitlements, profile, env);
    validateCapacitor(JSON.parse(readFileSync(join(app, "capacitor.config.json"), "utf8")));
    validateBundledBuild(JSON.parse(readFileSync(join(app, "public", "native-build.json"), "utf8")), "ios", env);
    requireState(existsSync(join(app, "public", "index.html")), "IPA bundled web assets missing");
  } finally { rmSync(directory, { recursive: true }); }
}

function verifyAndroid(artifact, env) {
  const jar = env.ASH_ATLAS_BUNDLETOOL_JAR;
  requireState(jar && sha(jar) === BUNDLETOOL_SHA256, "Verified bundletool 1.18.3 is required");
  run("java", ["-jar", jar, "validate", `--bundle=${artifact}`]);
  const manifest = run("java", ["-jar", jar, "dump", "manifest", `--bundle=${artifact}`, "--module=base"]);
  const attr = (xpath) => run("xmllint", ["--xpath", `string(${xpath})`, "-"], manifest).trim();
  requireState(attr("/manifest/@package") === PACKAGE &&
    attr("/manifest/@*[local-name()='versionName']") === env.VITE_NATIVE_APP_VERSION &&
    attr("/manifest/@*[local-name()='versionCode']") === env.VITE_NATIVE_APP_BUILD &&
    attr("/manifest/application/@*[local-name()='debuggable']") !== "true", "Final AAB identity/debug configuration mismatch");
  const permissionNames = run("xmllint", ["--xpath",
    "//*[local-name()='uses-permission' or local-name()='uses-permission-sdk-23']/@*[local-name()='name']", "-"], manifest);
  validateAndroidPermissions([...permissionNames.matchAll(/name="([^"]+)"/gu)].map((match) => match[1]));
  validateCapacitor(JSON.parse(run("unzip", ["-p", artifact, "base/assets/capacitor.config.json"])));
  validateBundledBuild(JSON.parse(run("unzip", ["-p", artifact, "base/assets/public/native-build.json"])), "android", env);
  requireState(run("unzip", ["-p", artifact, "base/assets/public/index.html"]).includes("<html"), "AAB bundled web assets missing");
  if (env.VITE_NATIVE_PUSH_ENABLED === "true") {
    const config = JSON.parse(readFileSync("android/app/google-services.json", "utf8"));
    const clients = config.client?.filter((c) => c.client_info?.android_client_info?.package_name === PACKAGE);
    requireState(clients?.length === 1 && clients[0].client_info.mobilesdk_app_id && config.project_info?.project_number,
      "Push-enabled Android app requires exact Firebase public app configuration");
    for (const [name, expected] of [["google_app_id", clients[0].client_info.mobilesdk_app_id], ["gcm_defaultSenderId", config.project_info.project_number]]) {
      const resource = run("java", ["-jar", jar, "dump", "resources", `--bundle=${artifact}`, `--resource=string/${name}`, "--values"]);
      validateFirebaseResource(resource, name, expected);
    }
  }
  if (env.DRY_RUN !== "true" || env.SIGNING_VALIDATION === "true") {
    const verification = run("jarsigner", ["-verify", "-verbose", artifact]);
    requireState(verification.includes("jar verified.") && !/unsigned entries|jar is unsigned/iu.test(verification), "AAB signature or entry coverage failed");
    const certificate = run("keytool", ["-printcert", "-jarfile", artifact]);
    requireState(certificate.includes(expectedUploadCertificateSha256(env)), "AAB upload signing certificate mismatch");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [platform, path] = process.argv.slice(2);
    requireState(["ios", "android"].includes(platform) && path, "usage: verify-artifact.mjs ios|android PATH");
    requireState([undefined, "true", "false"].includes(process.env.VITE_NATIVE_PUSH_ENABLED), "Push build flag must be true or false");
    const artifact = resolve(path);
    if (platform === "ios") verifyIos(artifact, process.env); else verifyAndroid(artifact, process.env);
    requireState(/^[0-9a-f]{40}$/u.test(process.env.SOURCE_SHA), "Exact artifact source SHA is required");
    console.log(JSON.stringify({ schemaVersion: 1, platform, sourceSha: process.env.SOURCE_SHA,
      artifactSha256: sha(artifact), marketingVersion: process.env.VITE_NATIVE_APP_VERSION,
      build: Number(process.env.VITE_NATIVE_APP_BUILD), pushMode: process.env.VITE_NATIVE_PUSH_ENABLED === "true" ? "enabled" : "disabled", validated: true }));
  } catch (error) { console.error(error.stderr ? "Final artifact inspection failed; no upload is allowed" : error.message); process.exitCode = 1; }
}
