#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const WEBHOOK_PATTERN = /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/;
const MAX_NOTES = 50;
const MAX_NOTE_LENGTH = 160;
const EMBED_DESCRIPTION_LIMIT = 4096;

export async function sendDiscordPatchNotes(options) {
  const release = readRelease(options.releasePath);
  if (release.publish_patch_notes !== true || release.patch_notes.length === 0) return "disabled";
  fs.mkdirSync(options.outboxDir, { recursive: true, mode: 0o750 });
  enqueue(options.outboxDir, release, options.now?.() ?? new Date());
  const webhookUrl = options.webhookUrl;
  if (!WEBHOOK_PATTERN.test(webhookUrl)) throw new Error("Discord webhook configuration is invalid");

  let sentCurrent = false;
  const pending = readItems(options.outboxDir).filter((item) => item.status === "pending" && item.game_sha === release.game_sha &&
      item.public_version === release.public_version &&
      JSON.stringify(item.patch_notes) === JSON.stringify(release.patch_notes))
    .sort((left, right) => left.queued_at.localeCompare(right.queued_at) ||
      left.game_sha.localeCompare(right.game_sha));
  for (const item of pending) {
    const response = await postWithRetries(webhookUrl, payloadFor(item), options);
    const body = await response.json().catch(() => null);
    if (!body || typeof body.id !== "string" || !/^\d+$/.test(body.id)) {
      throw new Error("Discord returned an invalid success response");
    }
    writeItem(options.outboxDir, {
      ...item,
      status: "sent",
      message_id: body.id,
      sent_at: (options.now?.() ?? new Date()).toISOString()
    });
    if (item.game_sha === release.game_sha) sentCurrent = true;
  }
  return sentCurrent ? "sent" : "already-sent";
}

export function payloadFor(item) {
  const lines = [];
  for (let index = 0; index < item.patch_notes.length; index++) {
    const line = `• ${item.patch_notes[index]}`;
    const remaining = item.patch_notes.length - index - 1;
    const remainder = remaining > 0 ? `\n…plus ${remaining} more update${remaining === 1 ? "" : "s"}.` : "";
    if ([...lines, line].join("\n").length + remainder.length > EMBED_DESCRIPTION_LIMIT) break;
    lines.push(line);
  }
  let omitted = item.patch_notes.length - lines.length;
  while (omitted > 0) {
    const remainder = `…plus ${omitted} more update${omitted === 1 ? "" : "s"}.`;
    if ([...lines, remainder].join("\n").length <= EMBED_DESCRIPTION_LIMIT) {
      lines.push(remainder);
      break;
    }
    lines.pop();
    omitted += 1;
  }
  return {
    username: "Ash Atlas Patch Notes",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Ash Atlas ${item.public_version} is live`,
      color: 0xD4AF37,
      description: lines.join("\n")
    }]
  };
}

function readRelease(releasePath) {
  let release;
  try { release = JSON.parse(fs.readFileSync(releasePath, "utf8")); }
  catch { throw new Error("release metadata is unreadable"); }
  if (!SHA_PATTERN.test(release?.game_sha) || !VERSION_PATTERN.test(release?.public_version) ||
      !Array.isArray(release?.patch_notes) ||
      release.patch_notes.length > MAX_NOTES ||
      !release.patch_notes.every((note) => typeof note === "string" && note.length > 0 &&
        note.length <= MAX_NOTE_LENGTH)) {
    throw new Error("release metadata is invalid");
  }
  return release;
}

function enqueue(outboxDir, release, now) {
  const target = itemPath(outboxDir, release.game_sha);
  if (fs.existsSync(target)) {
    const existing = JSON.parse(fs.readFileSync(target, "utf8"));
    if (existing.game_sha !== release.game_sha || existing.public_version !== release.public_version ||
        JSON.stringify(existing.patch_notes) !== JSON.stringify(release.patch_notes)) {
      throw new Error("current release conflicts with its immutable Discord outbox item");
    }
    return;
  }
  const item = {
    schema_version: 1,
    game_sha: release.game_sha,
    public_version: release.public_version,
    patch_notes: release.patch_notes,
    queued_at: now.toISOString(),
    status: "pending"
  };
  const temporary = path.join(outboxDir, `.${release.game_sha}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(item, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  try { fs.linkSync(temporary, target); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  finally { fs.rmSync(temporary, { force: true }); }
}

function readItems(outboxDir) {
  return fs.readdirSync(outboxDir).filter((name) => /^[a-f0-9]{40}\.json$/.test(name)).map((name) => {
    const item = JSON.parse(fs.readFileSync(path.join(outboxDir, name), "utf8"));
    if (item?.schema_version !== 1 || !SHA_PATTERN.test(item.game_sha) ||
        !VERSION_PATTERN.test(item.public_version) || !Array.isArray(item.patch_notes) ||
        item.patch_notes.length < 1 || item.patch_notes.length > MAX_NOTES ||
        !item.patch_notes.every((note) => typeof note === "string" && note.length > 0 &&
          note.length <= MAX_NOTE_LENGTH) ||
        !["pending", "sent"].includes(item.status) || typeof item.queued_at !== "string") {
      throw new Error("Discord outbox contains an invalid item");
    }
    return item;
  });
}

function writeItem(outboxDir, item) {
  const target = itemPath(outboxDir, item.game_sha);
  const temporary = path.join(outboxDir, `.${item.game_sha}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(item, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  fs.renameSync(temporary, target);
}

async function postWithRetries(webhookUrl, payload, options) {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = options.maxAttempts ?? 3;
  let lastStatus = "network error";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
    try {
      const url = new URL(webhookUrl);
      url.searchParams.set("wait", "true");
      const response = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (response.ok) return response;
      lastStatus = `HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 429) break;
    } catch { lastStatus = "network error"; }
    finally { clearTimeout(timer); }
    if (attempt < attempts) await sleep(250 * attempt);
  }
  throw new Error(`Discord delivery failed (${lastStatus})`);
}

function itemPath(outboxDir, gameSha) { return path.join(outboxDir, `${gameSha}.json`); }

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index]?.startsWith("--") || values[index + 1] === undefined) {
      throw new Error("sender arguments are incomplete");
    }
    result[values[index].slice(2)] = values[index + 1];
  }
  return result;
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const result = await sendDiscordPatchNotes({
      releasePath: args.release,
      outboxDir: args.outbox,
      webhookUrl: process.env.ASH_ATLAS_DISCORD_PATCH_NOTES_WEBHOOK_URL ?? ""
    });
    process.stdout.write(`${result}\n`);
  } catch (error) {
    console.error(`Discord patch notes queued: ${error instanceof Error ? error.message : "delivery failed"}`);
    process.exitCode = 1;
  }
}
