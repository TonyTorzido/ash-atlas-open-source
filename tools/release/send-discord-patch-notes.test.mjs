import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { payloadFor, sendDiscordPatchNotes } from "./send-discord-patch-notes.mjs";

const webhookUrl = "https://discord.com/api/webhooks/123456/token_value";

test("sender posts the safe compact payload once and records the Discord message", async () => {
  await withFixture(async ({ releasePath, outboxDir, gameSha }) => {
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url: String(url), init });
      return response(200, { id: "987654321" });
    };
    assert.equal(await sendDiscordPatchNotes({ releasePath, outboxDir, webhookUrl, fetcher }), "sent");
    assert.equal(await sendDiscordPatchNotes({ releasePath, outboxDir, webhookUrl, fetcher }), "already-sent");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\?wait=true$/);
    const payload = JSON.parse(calls[0].init.body);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.equal(payload.username, "Ash Atlas Patch Notes");
    assert.equal(payload.embeds[0].title, "Ash Atlas 0.1.9 is live");
    const item = JSON.parse(fs.readFileSync(path.join(outboxDir, `${gameSha}.json`), "utf8"));
    assert.equal(item.status, "sent");
    assert.equal(item.message_id, "987654321");
    assert.equal(JSON.stringify(item).includes("token_value"), false);
  });
});

test("failed delivery remains pending and a later invocation retries it", async () => {
  await withFixture(async ({ releasePath, outboxDir, gameSha }) => {
    await assert.rejects(sendDiscordPatchNotes({
      releasePath,
      outboxDir,
      webhookUrl,
      maxAttempts: 1,
      fetcher: async () => response(503, {})
    }), /delivery failed/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(outboxDir, `${gameSha}.json`), "utf8")).status, "pending");
    assert.equal(await sendDiscordPatchNotes({
      releasePath,
      outboxDir,
      webhookUrl,
      fetcher: async () => response(200, { id: "123" })
    }), "sent");
  });
});

test("default publication leaves pending items untouched and makes no requests", async () => {
  await withFixture(async ({ releasePath, outboxDir, gameSha }) => {
    await assert.rejects(sendDiscordPatchNotes({ releasePath, outboxDir, webhookUrl,
      maxAttempts: 1, fetcher: async () => response(503, {}) }), /delivery failed/);
    const itemPath = path.join(outboxDir, `${gameSha}.json`);
    const before = fs.readFileSync(itemPath, "utf8");
    const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
    fs.writeFileSync(releasePath, JSON.stringify({ ...release, publish_patch_notes: false, patch_notes: [] }));
    assert.equal(await sendDiscordPatchNotes({ releasePath, outboxDir,
      fetcher: async () => { throw new Error("must not send"); } }), "disabled");
    assert.equal(fs.readFileSync(itemPath, "utf8"), before);
    fs.writeFileSync(releasePath, JSON.stringify({ ...release, game_sha: "b".repeat(40) }));
    let calls = 0;
    assert.equal(await sendDiscordPatchNotes({ releasePath, outboxDir, webhookUrl,
      fetcher: async () => { calls++; return response(200, { id: "456" }); } }), "sent");
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(itemPath, "utf8"), before);
  });
});

test("a current outbox item with different wording is refused", async () => {
  await withFixture(async ({ releasePath, outboxDir }) => {
    await assert.rejects(sendDiscordPatchNotes({ releasePath, outboxDir, webhookUrl,
      maxAttempts: 1, fetcher: async () => response(503, {}) }), /delivery failed/);
    const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
    fs.writeFileSync(releasePath, JSON.stringify({ ...release, patch_notes: ["Different supplied wording."] }));
    await assert.rejects(sendDiscordPatchNotes({ releasePath, outboxDir, webhookUrl,
      fetcher: async () => { throw new Error("must not send"); } }), /conflicts/);
  });
});

test("embed truncation reports the number of omitted updates honestly", () => {
  const payload = payloadFor({
    public_version: "0.1.9",
    patch_notes: Array.from({ length: 50 }, (_, index) => `${index}: ${"x".repeat(150)}`)
  });
  assert.ok(payload.embeds[0].description.length <= 4096);
  assert.match(payload.embeds[0].description, /…plus \d+ more updates\.$/);
});

async function withFixture(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ash-atlas-discord-notes-"));
  const gameSha = "a".repeat(40);
  const releasePath = path.join(root, "release.json");
  const outboxDir = path.join(root, "outbox");
  fs.writeFileSync(releasePath, JSON.stringify({
    game_sha: gameSha,
    public_version: "0.1.9",
    publish_patch_notes: true,
    patch_notes: ["Players now receive clearer release updates."]
  }));
  try { await action({ releasePath, outboxDir, gameSha }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
