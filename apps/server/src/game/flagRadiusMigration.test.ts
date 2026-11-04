import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const expansionMigration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0602_expand_flag_claim_and_movement_radii.sql", import.meta.url)
  ),
  "utf8"
);
const ordinaryContractMigration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0657_ordinary_flag_radius_contract.sql", import.meta.url)
  ),
  "utf8"
);
const anchorAuthoritativeContractMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../db/migrations/0661_anchor_authoritative_radius_contract.sql",
      import.meta.url
    )
  ),
  "utf8"
);

describe("0602 flag radius expansion migration", () => {
  it("updates only the persisted authoritative radii and stale vision state", () => {
    expect(expansionMigration).toMatch(/UPDATE flags[\s\S]*claim_radius_m = 1000/i);
    expect(expansionMigration).toMatch(/UPDATE players[\s\S]*move_leash_radius_m = 1250/i);
    expect(expansionMigration).toMatch(/UPDATE flag_resource_visions[\s\S]*radius_m = 1500/i);
    expect(expansionMigration).toMatch(/status = 'pending'/i);
    expect(expansionMigration).not.toMatch(/DELETE|DROP|TRUNCATE/i);
    expect(expansionMigration).not.toMatch(/\b(?:lat|lon|owner_id|name|city_id)\s*=/i);
  });
});

describe("0657 ordinary flag radius contract migration", () => {
  it("changes future row defaults without rewriting retained gameplay rows", () => {
    expect(ordinaryContractMigration).toMatch(/flags[\s\S]*claim_radius_m SET DEFAULT 500/i);
    expect(ordinaryContractMigration).toMatch(/flags[\s\S]*resource_vision_radius_m SET DEFAULT 750/i);
    expect(ordinaryContractMigration).toMatch(/players[\s\S]*move_leash_radius_m SET DEFAULT 650/i);
    expect(ordinaryContractMigration).not.toMatch(/UPDATE|DELETE|DROP|TRUNCATE/i);
  });
});

describe("0661 anchor-authoritative radius contract migration", () => {
  it("normalizes only recognized superseded defaults and fences actionable old-radius jobs", () => {
    expect(anchorAuthoritativeContractMigration).toMatch(
      /flags[\s\S]*claim_radius_m SET DEFAULT 500/i
    );
    expect(anchorAuthoritativeContractMigration).toMatch(
      /flags[\s\S]*resource_vision_radius_m SET DEFAULT 650/i
    );
    expect(anchorAuthoritativeContractMigration).toMatch(
      /players[\s\S]*move_leash_radius_m SET DEFAULT 600/i
    );
    expect(anchorAuthoritativeContractMigration).toMatch(
      /ADD COLUMN IF NOT EXISTS resource_vision_center_lat[\s\S]*resource_vision_center_lon/i
    );
    expect(anchorAuthoritativeContractMigration).toMatch(
      /UPDATE players[\s\S]*resource_vision_center_lat = COALESCE[\s\S]*flags[\s\S]*kingdom_seats[\s\S]*anchor_lat[\s\S]*resource_vision_center_lon = COALESCE/i
    );
    expect(anchorAuthoritativeContractMigration).toMatch(
      /environmental_population_areas[\s\S]*radius_m SET DEFAULT 750/i
    );
    expect(anchorAuthoritativeContractMigration).toMatch(
      /UPDATE flags[\s\S]*claim_radius_m = 500[\s\S]*claim_radius_m = 1000/i
    );
    expect(anchorAuthoritativeContractMigration).toMatch(
      /UPDATE players[\s\S]*move_leash_radius_m = 600[\s\S]*IN \(650, 1250\)/i
    );
    expect(anchorAuthoritativeContractMigration).toMatch(
      /UPDATE flag_resource_visions[\s\S]*radius_m = 650[\s\S]*IN \(750, 1500\)/i
    );
    expect(anchorAuthoritativeContractMigration).toMatch(
      /UPDATE resource_vision_jobs[\s\S]*status = 'completed'[\s\S]*completed_at = now\(\)[\s\S]*radius_m IN \(750, 1500\)/i
    );
    expect(anchorAuthoritativeContractMigration).toMatch(
      /WHEN 'flag-visit' THEN 0[\s\S]*WHEN 'flag-build' THEN 1[\s\S]*WHEN 'dev-prewarm' THEN 2/i
    );
    expect(anchorAuthoritativeContractMigration).not.toMatch(/DELETE|DROP|TRUNCATE/i);
  });
});
