#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_PATCH_NOTES = 50;
export const MAX_PATCH_NOTE_LENGTH = 160;
export const MAX_PATCH_NOTE_RELEASES = 20;
export const MAX_PATCH_NOTE_HISTORY_NOTES = 50;

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const CLIENT_SHA_PATTERN = /^[a-f0-9]{64}$/;
const PUBLIC_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const GAME_GENERATION_PATTERN = /^test\/t[0-9]{3,}$/;
const RELEASE_CLASSES = new Set([
  "client_only",
  "server_no_migration",
  "database_migration",
  "release_tooling"
]);

export function nextPublicVersion(policy, previousVersion) {
  const major = validSeriesNumber(policy?.major, "major");
  const minor = validSeriesNumber(policy?.minor, "minor");
  if (previousVersion === undefined) return `${major}.${minor}.0`;
  if (typeof previousVersion !== "string") throw new Error("previous public_version is malformed");
  const match = PUBLIC_VERSION_PATTERN.exec(previousVersion);
  if (!match) throw new Error("previous public_version is malformed");
  const previous = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  if (major < previous.major || (major === previous.major && minor < previous.minor)) {
    throw new Error("public version series must not regress");
  }
  if (major > previous.major || minor > previous.minor) return `${major}.${minor}.0`;
  if (!Number.isSafeInteger(previous.patch + 1)) throw new Error("public version patch is exhausted");
  return `${major}.${minor}.${previous.patch + 1}`;
}

export function patchNotes(notes = []) {
  if (!Array.isArray(notes) || notes.length > MAX_PATCH_NOTES ||
      !notes.every((note) => typeof note === "string" && note.length >= 10 &&
        note.length <= MAX_PATCH_NOTE_LENGTH && !/[\r\n\p{Cc}\p{Cf}]/u.test(note) &&
        !/@(?:everyone|here)\b|<@(?:!|&)?\d+>/iu.test(note))) {
    throw new Error("supplied release patch notes are malformed");
  }
  return [...notes];
}

export function buildPublicReleaseMetadata(input) {
  const policy = readJson(input.policyPath, "public version policy");
  const protocolVersions = readJson(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../config/protocol-versions.json"),
    "protocol versions"
  );
  if (protocolVersions.protocol_id !== "ash-atlas" ||
      !Number.isSafeInteger(protocolVersions.min_protocol) || protocolVersions.min_protocol <= 0 ||
      !Number.isSafeInteger(protocolVersions.max_protocol) ||
      protocolVersions.max_protocol < protocolVersions.min_protocol) {
    throw new Error("protocol versions are malformed");
  }
  const previous = input.previousReleasePath === undefined
    ? {}
    : readJson(input.previousReleasePath, "previous public release");
  assertSha(input.gameSha, "game SHA");
  assertSha(input.previousSha, "previous SHA");
  if (!CLIENT_SHA_PATTERN.test(input.clientSha)) throw new Error("client SHA is malformed");
  for (const platform of ["ios", "android"]) {
    const sha = input[`${platform}ClientSha`];
    if (sha !== undefined && !CLIENT_SHA_PATTERN.test(sha)) {
      throw new Error(`${platform} client SHA is malformed`);
    }
  }
  assertSha(input.serverComponentSha, "server component SHA");
  assertSha(input.clientComponentSha, "client component SHA");
  validateReleaseClassification(input.gameGeneration, input.releaseClass);
  if (!CLIENT_SHA_PATTERN.test(input.serverArtifactSha256)) {
    throw new Error("server artifact SHA-256 is malformed");
  }
  if (input.publishPatchNotes === true && (!input.releasePatchNotes || input.releasePatchNotes.length === 0)) {
    throw new Error("patch-note publication requires supplied wording");
  }
  if (input.publishPatchNotes !== true && input.releasePatchNotes?.length > 0) {
    throw new Error("supplied patch notes require explicit publication");
  }
  const publicVersion = nextPublicVersion(policy, previous.public_version);
  const resetId = policy.patch_notes_reset_id;
  if (resetId !== undefined && (typeof resetId !== "string" || !/^[a-z0-9-]{1,80}$/.test(resetId))) {
    throw new Error("patch-note reset identity is malformed");
  }
  const resetPatchNotes = resetId !== undefined && previous.patch_notes_reset_id !== resetId;
  const currentPatchNotes = patchNotes(!resetPatchNotes && input.publishPatchNotes === true ? input.releasePatchNotes : []);
  const currentCreatedAtUtc = commitCreatedAtUtc(input.repository, input.gameSha);
  const currentPatchNoteRelease = {
    game_sha: input.gameSha,
    game_generation: input.gameGeneration,
    public_version: publicVersion,
    created_at_utc: currentCreatedAtUtc,
    patch_notes: currentPatchNotes
  };
  const priorPatchNoteReleases = resetPatchNotes ? [] : readPriorPatchNoteReleases(
    previous,
    input.repository,
    input.previousSha
  );
  const allPatchNoteReleases = [
    ...(currentPatchNotes.length > 0 ? [currentPatchNoteRelease] : []),
    ...priorPatchNoteReleases.filter((release) => release.game_sha !== input.gameSha)
  ];
  assertPatchNoteReleasesNewestFirst(allPatchNoteReleases);
  const patchNoteReleases = boundedPatchNoteReleases(allPatchNoteReleases);
  return {
    game_sha: input.gameSha,
    game_generation: input.gameGeneration,
    created_at_utc: currentCreatedAtUtc,
    client_sha: input.clientSha,
    clients: {
      web: { client_sha: input.clientSha, min_protocol: protocolVersions.min_protocol },
      ios: nativeClientIdentity("ios", input.iosClientSha, previous, protocolVersions.min_protocol),
      android: nativeClientIdentity("android", input.androidClientSha, previous, protocolVersions.min_protocol)
    },
    server_version: input.serverComponentSha,
    protocol_min: protocolVersions.min_protocol,
    protocol_max: protocolVersions.max_protocol,
    generation: input.gameGeneration,
    public_version: publicVersion,
    patch_notes: currentPatchNotes,
    publish_patch_notes: input.publishPatchNotes === true,
    patch_note_releases: patchNoteReleases,
    ...(resetId !== undefined ? { patch_notes_reset_id: resetId } : {}),
    release_class: input.releaseClass,
    server_component_sha: input.serverComponentSha,
    server_artifact_sha256: input.serverArtifactSha256,
    client_component_sha: input.clientComponentSha,
    base_path: "/play/",
    source_repository: "example-org/game"
  };
}

function nativeClientIdentity(platform, sha, previous, currentMinProtocol) {
  if (sha !== undefined) return { client_sha: sha, min_protocol: currentMinProtocol };
  const identity = previous.clients?.[platform] ?? null;
  if (identity === null) return null;
  if (typeof identity !== "object" || !CLIENT_SHA_PATTERN.test(identity.client_sha) ||
      !Number.isSafeInteger(identity.min_protocol) || identity.min_protocol <= 0) {
    throw new Error(`previous ${platform} client identity is malformed`);
  }
  return { client_sha: identity.client_sha, min_protocol: identity.min_protocol };
}

function readPriorPatchNoteReleases(previous, repository, expectedPreviousSha) {
  if (previous.patch_note_releases === undefined) {
    const legacy = validPatchNoteRelease(previous);
    if (legacy && legacy.game_sha !== expectedPreviousSha) {
      throw new Error("previous patch-note history conflicts with previous SHA");
    }
    return legacy ? [hydratePatchNoteRelease(repository, legacy)] : [];
  }
  if (!Array.isArray(previous.patch_note_releases) ||
      previous.patch_note_releases.length > MAX_PATCH_NOTE_RELEASES) {
    throw new Error("previous patch_note_releases is malformed");
  }
  const releases = previous.patch_note_releases.map((value) => {
    const release = validPatchNoteRelease(value);
    if (!release) throw new Error("previous patch_note_releases is malformed");
    return release;
  });
  if (new Set(releases.map(({ game_sha }) => game_sha)).size !== releases.length ||
      releases.reduce((count, release) => count + release.patch_notes.length, 0) > MAX_PATCH_NOTE_HISTORY_NOTES) {
    throw new Error("previous patch_note_releases is malformed");
  }
  if (previous.game_sha !== expectedPreviousSha) {
    throw new Error("previous patch-note history conflicts with previous SHA");
  }
  assertPatchNoteReleasesNewestFirst(releases, "previous patch_note_releases");
  const newest = releases[0];
  if (!Array.isArray(previous.patch_notes)) throw new Error("previous patch notes are malformed");
  if (previous.patch_notes.length > 0) {
    if (!newest || previous.game_sha !== newest.game_sha ||
        previous.game_generation !== newest.game_generation ||
        previous.public_version !== newest.public_version || !sameNotes(previous.patch_notes, newest.patch_notes)) {
      throw new Error("previous patch_note_releases conflicts with current release identity");
    }
  } else if (newest && (generationNumber(previous.game_generation) <= generationNumber(newest.game_generation) ||
      comparePublicVersions(previous.public_version, newest.public_version) <= 0)) {
    throw new Error("previous patch-note history conflicts with current release identity");
  }
  return releases.map((release) => hydratePatchNoteRelease(repository, release));
}

function assertPatchNoteReleasesNewestFirst(releases, label = "patch_note_releases") {
  for (let index = 1; index < releases.length; index += 1) {
    if (generationNumber(releases[index - 1].game_generation) <= generationNumber(releases[index].game_generation) ||
        comparePublicVersions(releases[index - 1].public_version, releases[index].public_version) <= 0) {
      throw new Error(`${label} is not newest-first`);
    }
  }
}

function validPatchNoteRelease(value) {
  const createdAtUtc = validCreatedAt(value?.created_at_utc);
  if (!value || typeof value !== "object" ||
      typeof value.game_sha !== "string" || !SHA_PATTERN.test(value.game_sha) ||
      typeof value.game_generation !== "string" || !GAME_GENERATION_PATTERN.test(value.game_generation) ||
      typeof value.public_version !== "string" || !PUBLIC_VERSION_PATTERN.test(value.public_version) ||
      createdAtUtc === undefined || !validPatchNoteList(value.patch_notes)) return null;
  return {
    game_sha: value.game_sha,
    game_generation: value.game_generation,
    public_version: value.public_version,
    created_at_utc: createdAtUtc,
    patch_notes: [...value.patch_notes]
  };
}

function hydratePatchNoteRelease(repository, release) {
  return release.created_at_utc === null
    ? { ...release, created_at_utc: commitCreatedAtUtc(repository, release.game_sha) }
    : release;
}

function validPatchNoteList(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_PATCH_NOTES &&
    value.every((note) => typeof note === "string" && note.length > 0 && note.length <= MAX_PATCH_NOTE_LENGTH);
}

function boundedPatchNoteReleases(releases) {
  const bounded = [];
  let noteCount = 0;
  for (const release of releases) {
    if (bounded.length >= MAX_PATCH_NOTE_RELEASES ||
        noteCount + release.patch_notes.length > MAX_PATCH_NOTE_HISTORY_NOTES) break;
    bounded.push(release);
    noteCount += release.patch_notes.length;
  }
  return bounded;
}

function generationNumber(value) {
  return Number(value.slice("test/t".length));
}

function comparePublicVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function sameNotes(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((note, index) => note === right[index]);
}

function validCreatedAt(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/(?:[zZ]|[+-][0-9]{2}:[0-9]{2})$/.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

export function validateReleaseClassification(gameGeneration, releaseClass) {
  if (typeof gameGeneration !== "string" || !GAME_GENERATION_PATTERN.test(gameGeneration)) {
    throw new Error("game generation is malformed");
  }
  if (typeof releaseClass !== "string" || !RELEASE_CLASSES.has(releaseClass)) {
    throw new Error("release class is malformed");
  }
}

function validSeriesNumber(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`public version ${label} is malformed`);
  return value;
}

function assertSha(value, label) {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label} is malformed`);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function commitCreatedAtUtc(repository, commit) {
  const value = git(repository, ["show", "-s", "--format=%cI", `${commit}^{commit}`]);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`commit ${commit} has a malformed committer timestamp`);
  return new Date(timestamp).toISOString();
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("release metadata arguments are incomplete");
    result[key.slice(2)] = value;
  }
  return result;
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const metadata = buildPublicReleaseMetadata({
      publishPatchNotes: args["publish-patch-notes"] === "true",
      releasePatchNotes: args["release-patch-notes-hex"] ? JSON.parse(Buffer.from(args["release-patch-notes-hex"], "hex").toString("utf8")) : [],
      repository: args.repository,
      policyPath: args.policy,
      previousReleasePath: args["previous-release"],
      previousSha: args["previous-sha"],
      gameSha: args["game-sha"],
      gameGeneration: args["game-generation"],
      clientSha: args["client-sha"],
      iosClientSha: args["ios-client-sha"],
      androidClientSha: args["android-client-sha"],
      releaseClass: args["release-class"],
      serverComponentSha: args["server-component-sha"],
      serverArtifactSha256: args["server-artifact-sha256"],
      clientComponentSha: args["client-component-sha"]
    });
    fs.writeFileSync(args.output, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  } catch (error) {
    console.error(`STOP: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
