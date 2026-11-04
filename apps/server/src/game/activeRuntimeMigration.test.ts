import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("durable player flag view migration", () => {
  it("persists a constrained flag reference without cascading player deletion", () => {
    const migration = readFileSync(
      new URL("../../../../db/migrations/0615_durable_player_flag_view.sql", import.meta.url),
      "utf8"
    );

    expect(migration).toContain("ADD COLUMN IF NOT EXISTS current_flag_id uuid");
    expect(migration).toContain("FOREIGN KEY (current_flag_id)");
    expect(migration).toContain("REFERENCES flags(id)");
    expect(migration).toContain("ON DELETE SET NULL");
    expect(migration).not.toContain("ON DELETE CASCADE");
  });
});
