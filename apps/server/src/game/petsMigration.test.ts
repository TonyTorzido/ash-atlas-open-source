import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0648_resonance_chamber_echoes.sql", import.meta.url)),
  "utf8"
);

describe("Resonance Chamber durable migration", () => {
  it("keeps the original pet migration immutable and extends identity forward", () => {
    for (const field of [
      "generator_version",
      "seed_fingerprint",
      "echo_signature",
      "appearance_fingerprint",
      "collision_nonce",
      "character_name_seed_snapshot",
      "adopted_at_mountain_local",
      "generated_blueprint_json",
      "innate_disposition",
      "quirk_key",
      "secondary_personality_trait",
      "personality_tie_order",
      "chamber_affinity"
    ]) {
      expect(sql).toContain(field);
    }
    expect(sql).toContain("player_pets_appearance_fingerprint_unique");
    expect(sql).toContain("player_pets_echo_signature_unique");
  });

  it("enforces exact-once memories, private offsets, operations, and append-only reset audit", () => {
    expect(sql).toContain("UNIQUE (pet_id, source_key)");
    expect(sql).toContain("CREATE TABLE pet_debug_offsets");
    expect(sql).toContain("PRIMARY KEY (player_id, operation_id)");
    expect(sql).toContain("CREATE TABLE pet_owner_audit_events");
    expect(sql).toContain("pet_owner_audit_events_append_only");
    expect(sql).toContain("RAISE EXCEPTION 'pet owner audit events are append-only'");
  });
});
