import { DEFAULT_BOSS_APPEARANCE_CATALOG } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  bossStudioIsDirty,
  bossStudioReducer,
  createBossStudioHistory
} from "./bossStudioState.js";

describe("boss studio history", () => {
  it("restores a boss-only recovery draft as unsaved", () => {
    const saved = structuredClone(DEFAULT_BOSS_APPEARANCE_CATALOG);
    const draft = structuredClone(saved);
    draft.bosses[0]!.weapon.placements.idle = { offsetX: 12 };
    const restored = bossStudioReducer(createBossStudioHistory(saved), {
      type: "restoreDraft",
      catalog: draft,
      saved
    });

    expect(bossStudioIsDirty(restored)).toBe(true);
    expect(restored.present.bosses[0]?.weapon.placements.idle?.offsetX).toBe(12);
  });

  it("keeps newer edits while adopting the catalog revision returned by a save", () => {
    const initial = createBossStudioHistory(DEFAULT_BOSS_APPEARANCE_CATALOG);
    const submittedCatalog = structuredClone(initial.present);
    submittedCatalog.bosses[0]!.weapon.placements.idle = { offsetX: 4 };
    const submitted = bossStudioReducer(initial, {
      type: "edit",
      catalog: submittedCatalog
    });
    const newerCatalog = structuredClone(submitted.present);
    newerCatalog.bosses[0]!.weapon.placements.attack_action = { rotationDegrees: 80 };
    const newer = bossStudioReducer(submitted, { type: "edit", catalog: newerCatalog });
    const savedCatalog = structuredClone(submitted.present);
    savedCatalog.catalogRevision += 1;
    const afterSave = bossStudioReducer(newer, {
      type: "markSaved",
      catalog: savedCatalog,
      submittedRevision: submitted.revision
    });

    expect(afterSave.present.catalogRevision).toBe(savedCatalog.catalogRevision);
    expect(afterSave.present.bosses[0]?.weapon.placements.attack_action?.rotationDegrees)
      .toBe(80);
    expect(bossStudioIsDirty(afterSave)).toBe(true);
  });
});
