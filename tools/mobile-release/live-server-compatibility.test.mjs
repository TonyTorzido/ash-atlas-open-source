import assert from "node:assert/strict";
import test from "node:test";

import { verifyLiveServerCompatibility } from "./live-server-compatibility.mjs";

const candidate = {
  serverUrl: "https://playashatlas.com",
  platform: "ios",
  version: "1.2.0",
  build: 42,
  sourceSha: "a".repeat(40),
  protocolMin: 3,
  protocolMax: 4
};

function response(overrides = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      contractVersion: 1,
      platform: "ios",
      version: "1.2.0",
      build: "42",
      hardMinimum: { version: "1.0.0", build: 2 },
      wsMin: 3,
      wsMax: 3,
      serverSha: "b".repeat(40),
      status: "supported",
      ...overrides
    })
  };
}

test("binds the live response to the immutable candidate identity and returns proof", async () => {
  let requested;
  const proof = await verifyLiveServerCompatibility({ ...candidate, fetcher: async (url, options) => {
    requested = { url: String(url), options };
    return response();
  } });
  assert.match(requested.url, /\/api\/auth\/native\/compatibility\?/u);
  assert.match(requested.url, /platform=ios/u);
  assert.equal(requested.options.redirect, "error");
  assert.deepEqual(proof, {
    schemaVersion: 1,
    platform: "ios",
    sourceSha: "a".repeat(40),
    marketingVersion: "1.2.0",
    build: 42,
    protocol: { min: 3, max: 4 },
    serverUrl: "https://playashatlas.com",
    serverSha: "b".repeat(40),
    serverProtocol: { min: 3, max: 3 },
    hardMinimum: { version: "1.0.0", build: 2 },
    status: "supported",
    observedAt: proof.observedAt
  });
});

test("stops before availability when live protocol or hard minimum rejects the candidate", async () => {
  await assert.rejects(verifyLiveServerCompatibility({ ...candidate,
    fetcher: async () => response({ wsMin: 5, wsMax: 5 })
  }), /protocol/u);
  await assert.rejects(verifyLiveServerCompatibility({ ...candidate,
    fetcher: async () => response({ hardMinimum: { version: "2.0.0", build: 1 }, status: "required" })
  }), /hard minimum|requires/u);
});

test("fails closed on an unavailable or unverifiable live server identity", async () => {
  await assert.rejects(verifyLiveServerCompatibility({ ...candidate,
    fetcher: async () => ({ ok: false, status: 503 })
  }), /HTTP 503/u);
  await assert.rejects(verifyLiveServerCompatibility({ ...candidate,
    fetcher: async () => response({ serverSha: null })
  }), /immutable server SHA/u);
});

test("binds an unchanged server component to the exact client-only release", async () => {
  const proof = await verifyLiveServerCompatibility({ ...candidate, expectedReleaseSha: candidate.sourceSha,
    fetcher: async (url) => String(url).endsWith("/play/release.json")
      ? { ok: true, json: async () => ({ game_sha: candidate.sourceSha, release_class: "client_only",
        server_component_sha: "b".repeat(40) }) } : response() });
  assert.equal(proof.serverSha, "b".repeat(40));
  assert.equal(proof.serverReleaseSha, candidate.sourceSha);
});

test("rejects a different release or component in client-only compatibility proof", async () => {
  for (const changed of [{ game_sha: "c".repeat(40) }, { server_component_sha: "c".repeat(40) },
    { release_class: "server" }]) {
    await assert.rejects(verifyLiveServerCompatibility({ ...candidate, expectedReleaseSha: candidate.sourceSha,
      fetcher: async (url) => String(url).endsWith("/play/release.json")
        ? { ok: true, json: async () => ({ game_sha: candidate.sourceSha, release_class: "client_only",
          server_component_sha: "b".repeat(40), ...changed }) } : response() }), /does not bind/u);
  }
});
