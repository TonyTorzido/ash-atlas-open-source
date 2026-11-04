import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPublicReleaseMetadata,
  nextPublicVersion,
  patchNotes,
  validateReleaseClassification
} from "./public-release-metadata.mjs";

test("public version starts at 0.1.0, increments once, and resets only for a higher series", () => {
  assert.equal(nextPublicVersion({ major: 0, minor: 1 }, undefined), "0.1.0");
  assert.equal(nextPublicVersion({ major: 0, minor: 1 }, "0.1.7"), "0.1.8");
  assert.equal(nextPublicVersion({ major: 0, minor: 2 }, "0.1.7"), "0.2.0");
  assert.throws(() => nextPublicVersion({ major: 0, minor: 1 }, "0.2.0"), /regress/);
  assert.throws(() => nextPublicVersion({ major: 0, minor: 1 }, "version-one"), /malformed/);
});

test("release metadata accepts only canonical generations and release classes", () => {
  assert.doesNotThrow(() => validateReleaseClassification("test/t909", "client_only"));
  assert.throws(() => validateReleaseClassification("t909", "client_only"), /generation/);
  assert.throws(() => validateReleaseClassification("test/t909", "unknown"), /class/);
});

test("supplied prior metadata must be readable and advances 0.1.0 to 0.1.1", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ash-atlas-prior-release-"));
  try {
    git(root, ["init", "-b", "integration/test"]);
    git(root, ["config", "user.email", "release-test@example.invalid"]);
    git(root, ["config", "user.name", "Release Test"]);
    fs.writeFileSync(path.join(root, "fixture.txt"), "previous\n");
    git(root, ["add", "fixture.txt"]);
    git(root, ["commit", "-m", "chore(release): previous"]);
    const previousSha = git(root, ["rev-parse", "HEAD"]);
    fs.appendFileSync(path.join(root, "fixture.txt"), "candidate\n");
    git(root, ["commit", "-am", "fix(release): Advance public version"]);
    const gameSha = git(root, ["rev-parse", "HEAD"]);
    const currentCreatedAt = commitCreatedAt(root, gameSha);
    const previousCreatedAt = commitCreatedAt(root, previousSha);
    const policyPath = path.join(root, "policy.json");
    const previousReleasePath = path.join(root, "previous-release.json");
    fs.writeFileSync(policyPath, JSON.stringify({ major: 0, minor: 1 }));
    fs.writeFileSync(previousReleasePath, JSON.stringify({ public_version: "0.1.0" }));
    const input = {
      repository: root,
      policyPath,
      previousReleasePath,
      previousSha,
      gameSha,
      gameGeneration: "test/t912",
      clientSha: "c".repeat(64),
      releaseClass: "release_tooling",
      serverComponentSha: gameSha,
      serverArtifactSha256: "d".repeat(64),
      clientComponentSha: gameSha
    };
    const silent = buildPublicReleaseMetadata(input);
    assert.deepEqual(silent.patch_notes, []);
    assert.deepEqual(silent.patch_note_releases, []);
    assert.equal(silent.publish_patch_notes, false);
    assert.throws(() => buildPublicReleaseMetadata({ ...input, publishPatchNotes: true }), /supplied wording/);
    assert.throws(() => buildPublicReleaseMetadata({ ...input, releasePatchNotes: ["Explicit player wording."] }), /explicit publication/);
    input.publishPatchNotes = true;
    input.releasePatchNotes = ["Explicit player wording."];
    const metadata = buildPublicReleaseMetadata(input);
    assert.equal(metadata.public_version, "0.1.1");
    assert.deepEqual(metadata.clients, {
      web: { client_sha: input.clientSha, min_protocol: 3 },
      ios: null,
      android: null
    });
    assert.equal(metadata.server_version, input.serverComponentSha);
    assert.equal(metadata.protocol_min, 3);
    assert.equal(metadata.protocol_max, 3);
    assert.equal(metadata.generation, input.gameGeneration);
    assert.equal(metadata.client_sha, input.clientSha);
    const nativeSha = "a".repeat(64);
    const withNativeClients = buildPublicReleaseMetadata({
      ...input,
      iosClientSha: nativeSha,
      androidClientSha: nativeSha
    });
    assert.deepEqual(withNativeClients.clients.ios, { client_sha: nativeSha, min_protocol: 3 });
    assert.deepEqual(withNativeClients.clients.android, { client_sha: nativeSha, min_protocol: 3 });
    assert.throws(() => buildPublicReleaseMetadata({ ...input, iosClientSha: "bad" }),
      /ios client SHA is malformed/);
    fs.writeFileSync(previousReleasePath, JSON.stringify({
      public_version: "0.1.0",
      clients: { ios: { client_sha: nativeSha, min_protocol: 3 }, android: null }
    }));
    const preservedNativeClient = buildPublicReleaseMetadata(input);
    assert.deepEqual(preservedNativeClient.clients.ios, { client_sha: nativeSha, min_protocol: 3 });
    assert.equal(preservedNativeClient.clients.android, null);
    assert.equal(metadata.server_component_sha, input.serverComponentSha);
    assert.equal(metadata.game_generation, input.gameGeneration);
    assert.throws(() => buildPublicReleaseMetadata({
      ...input,
      previousReleasePath: path.join(root, "missing.json")
    }), /previous public release is malformed/);
    assert.throws(() => buildPublicReleaseMetadata({
      ...input,
      previousReleasePath: root
    }), /previous public release is malformed/);
    const { previousReleasePath: omitted, ...firstReleaseInput } = input;
    void omitted;
    assert.equal(buildPublicReleaseMetadata(firstReleaseInput).public_version, "0.1.0");

    fs.writeFileSync(previousReleasePath, JSON.stringify({
      game_sha: previousSha,
      game_generation: "test/t911",
      public_version: "0.1.0",
      patch_notes: ["Previous release note."]
    }));
    const silentWithHistory = buildPublicReleaseMetadata({ ...input, publishPatchNotes: false, releasePatchNotes: [] });
    assert.deepEqual(silentWithHistory.patch_notes, []);
    assert.equal(silentWithHistory.patch_note_releases.length, 1);
    assert.equal(silentWithHistory.patch_note_releases[0].game_sha, previousSha);
    fs.writeFileSync(previousReleasePath, JSON.stringify(silentWithHistory));
    const laterSilent = buildPublicReleaseMetadata({ ...input, previousSha: gameSha,
      gameGeneration: "test/t913", publishPatchNotes: false, releasePatchNotes: [] });
    assert.deepEqual(laterSilent.patch_note_releases, silentWithHistory.patch_note_releases);
    fs.writeFileSync(previousReleasePath, JSON.stringify({
      game_sha: previousSha, game_generation: "test/t911", public_version: "0.1.0",
      patch_notes: ["Previous release note."]
    }));
    const lifted = buildPublicReleaseMetadata(input);
    assert.deepEqual(lifted.patch_note_releases, [
      {
        game_sha: gameSha,
        game_generation: "test/t912",
        public_version: "0.1.1",
        created_at_utc: currentCreatedAt,
        patch_notes: lifted.patch_notes
      },
      {
        game_sha: previousSha,
        game_generation: "test/t911",
        public_version: "0.1.0",
        created_at_utc: previousCreatedAt,
        patch_notes: ["Previous release note."]
      }
    ]);
    fs.writeFileSync(previousReleasePath, JSON.stringify({
      game_sha: "f".repeat(40),
      game_generation: "test/t911",
      public_version: "0.1.0",
      patch_notes: ["Previous release note."]
    }));
    assert.throws(() => buildPublicReleaseMetadata(input), /conflicts with previous SHA/);

    const priorHistory = Array.from({ length: 10 }, (_, index) => ({
      game_sha: index === 0 ? previousSha : `${(index + 1).toString(16)}`.repeat(40),
      game_generation: `test/t${911 - index}`,
      public_version: `0.1.${10 - index}`,
      created_at_utc: previousCreatedAt,
      patch_notes: Array.from({ length: 5 }, (__, noteIndex) => `Release ${index} note ${noteIndex}.`)
    }));
    fs.writeFileSync(previousReleasePath, JSON.stringify({
      ...priorHistory[0],
      patch_note_releases: priorHistory
    }));
    const bounded = buildPublicReleaseMetadata(input);
    assert.equal(bounded.patch_note_releases.length, 10);
    assert.equal(bounded.patch_note_releases.reduce((count, release) => count + release.patch_notes.length, 0), 46);
    assert.deepEqual(bounded.patch_note_releases[0].patch_notes, bounded.patch_notes);
    assert.equal(bounded.patch_note_releases.at(-1).game_generation, "test/t903");

    const twentyPriorReleases = Array.from({ length: 20 }, (_, index) => ({
      game_sha: index === 0
        ? previousSha
        : `${((index + 1) % 16).toString(16)}${Math.floor(index / 16).toString(16)}`.repeat(20),
      game_generation: `test/t${911 - index}`,
      public_version: `0.1.${20 - index}`,
      created_at_utc: previousCreatedAt,
      patch_notes: [`Release ${index} note.`]
    }));
    fs.writeFileSync(previousReleasePath, JSON.stringify({
      ...twentyPriorReleases[0],
      patch_note_releases: twentyPriorReleases
    }));
    const releaseBounded = buildPublicReleaseMetadata(input);
    assert.equal(releaseBounded.patch_note_releases.length, 20);
    assert.equal(releaseBounded.patch_note_releases.at(-1).game_generation, "test/t893");

    fs.writeFileSync(previousReleasePath, JSON.stringify({
      ...priorHistory[0],
      patch_notes: ["Conflicting outer note."],
      patch_note_releases: priorHistory
    }));
    assert.throws(() => buildPublicReleaseMetadata(input), /conflicts with current release identity/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("patch notes use only supplied wording and preserve it exactly", () => {
  assert.deepEqual(patchNotes(), []);
  assert.deepEqual(patchNotes(["Exact supplied wording!"]), ["Exact supplied wording!"]);
  for (const notes of [["Short"], ["Unsafe @everyone note."], ["Unsafe\nmultiline note."], ["x".repeat(161)]]) {
    assert.throws(() => patchNotes(notes), /malformed/);
  }
});

test("a history reset clears old and current notes once, and later releases start a fresh history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ash-atlas-note-reset-"));
  try {
    git(root, ["init", "-b", "integration/test"]);
    git(root, ["config", "user.email", "release-test@example.invalid"]);
    git(root, ["config", "user.name", "Release Test"]);
    fs.writeFileSync(path.join(root, "fixture.txt"), "previous\n");
    git(root, ["add", "fixture.txt"]);
    git(root, ["commit", "-m", "chore(release): previous"]);
    const previousSha = git(root, ["rev-parse", "HEAD"]);
    fs.appendFileSync(path.join(root, "fixture.txt"), "reset\n");
    git(root, ["commit", "-am", "fix(release): clear notes"]);
    const gameSha = git(root, ["rev-parse", "HEAD"]);
    const policyPath = path.join(root, "policy.json");
    const previousReleasePath = path.join(root, "previous.json");
    fs.writeFileSync(policyPath, JSON.stringify({ major: 0, minor: 1, patch_notes_reset_id: "clear-history" }));
    const prior = {
      game_sha: previousSha, game_generation: "test/t910", public_version: "0.1.0",
      created_at_utc: commitCreatedAt(root, previousSha), patch_notes: ["Old note to delete."]
    };
    fs.writeFileSync(previousReleasePath, JSON.stringify({ ...prior, patch_note_releases: [prior] }));
    const input = {
      repository: root, policyPath, previousReleasePath, previousSha, gameSha,
      gameGeneration: "test/t911", clientSha: "c".repeat(64), releaseClass: "release_tooling",
      serverComponentSha: gameSha, serverArtifactSha256: "d".repeat(64), clientComponentSha: gameSha
    };
    const reset = buildPublicReleaseMetadata(input);
    assert.deepEqual(reset.patch_notes, []);
    assert.deepEqual(reset.patch_note_releases, []);
    assert.equal(reset.patch_notes_reset_id, "clear-history");
    assert.equal(reset.public_version, "0.1.1");
    assert.equal(reset.game_sha, gameSha);
    assert.deepEqual(buildPublicReleaseMetadata(input), reset);
    fs.writeFileSync(previousReleasePath, JSON.stringify(reset));
    fs.appendFileSync(path.join(root, "fixture.txt"), "next\n");
    git(root, ["commit", "-am", "feat(game): A new update"]);
    const nextSha = git(root, ["rev-parse", "HEAD"]);
    const nextInput = { ...input, previousSha: gameSha, gameSha: nextSha, gameGeneration: "test/t912" };
    const quiet = buildPublicReleaseMetadata(nextInput);
    assert.deepEqual(quiet.patch_notes, []);
    assert.deepEqual(quiet.patch_note_releases, []);
    const next = buildPublicReleaseMetadata({ ...nextInput, publishPatchNotes: true, releasePatchNotes: ["A new update."] });
    assert.deepEqual(next.patch_notes, ["A new update."]);
    assert.equal(next.patch_note_releases.length, 1);
    assert.equal(next.patch_note_releases[0].game_sha, nextSha);
    assert.equal(next.patch_notes_reset_id, "clear-history");
    assert.equal(next.public_version, "0.1.2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function commitCreatedAt(repository, commit) {
  return new Date(git(repository, ["show", "-s", "--format=%cI", `${commit}^{commit}`])).toISOString();
}
