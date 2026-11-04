import { DEFAULT_PLAYER_APPEARANCE_CATALOG } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  createStudioHistory,
  duplicateAppearance,
  resetAppearancePose,
  withImportedPlayerSkinToneAsset,
  studioIsDirty,
  studioReducer
} from "./studioState.js";

describe("Appearance Studio history", () => {
  it("supports bounded edit, undo, redo, save, and revert semantics", () => {
    const original = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const edited = structuredClone(original);
    edited.families[0]!.displayName = "Edited";
    let state = createStudioHistory(original);
    state = studioReducer(state, { type: "edit", catalog: edited });
    expect(studioIsDirty(state)).toBe(true);
    state = studioReducer(state, { type: "undo" });
    expect(state.present.families[0]!.displayName).not.toBe("Edited");
    state = studioReducer(state, { type: "redo" });
    expect(state.present.families[0]!.displayName).toBe("Edited");
    const submittedRevision = state.revision;
    state = studioReducer(state, {
      type: "markSaved",
      catalog: edited,
      submittedRevision
    });
    expect(studioIsDirty(state)).toBe(false);

    const second = structuredClone(edited);
    second.families[0]!.displayName = "Second";
    state = studioReducer(state, { type: "edit", catalog: second });
    state = studioReducer(state, { type: "revert" });
    expect(state.present.families[0]!.displayName).toBe("Edited");
  });

  it("keeps newer edits dirty when an older save response arrives", () => {
    const original = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    let state = createStudioHistory(original);
    const submitted = structuredClone(original);
    submitted.families[0]!.displayName = "Submitted";
    state = studioReducer(state, { type: "edit", catalog: submitted });
    const submittedRevision = state.revision;
    const newer = structuredClone(submitted);
    newer.families[0]!.displayName = "Newer";
    state = studioReducer(state, { type: "edit", catalog: newer });
    const persisted = structuredClone(submitted);
    persisted.catalogRevision += 1;
    state = studioReducer(state, {
      type: "markSaved",
      catalog: persisted,
      submittedRevision
    });
    expect(state.present.families[0]!.displayName).toBe("Newer");
    expect(state.present.catalogRevision).toBe(persisted.catalogRevision);
    expect(studioIsDirty(state)).toBe(true);
  });

  it("duplicates appearance identity safely through inheritance", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    catalog.appearances = [{
      appearanceId: "starter_sword",
      displayName: "Starter Sword",
      familyId: "one_handed_sword",
      assetKey: "weapons/starter-sword.png",
      cosmetic: false,
      equipmentDefinitionId: "starter_sword",
      placements: { idle: { offsetX: 2 } }
    }];
    const duplicate = duplicateAppearance(catalog, "starter_sword");
    expect(duplicate.appearance).toMatchObject({
      appearanceId: "starter_sword_copy",
      inheritAppearanceId: "starter_sword",
      placements: {}
    });
    expect(catalog.appearances).toHaveLength(1);
    expect(duplicate.catalog.appearances).toHaveLength(2);
  });

  it("resets only the requested combat pose override", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    catalog.appearances = [{
      appearanceId: "starter_sword",
      displayName: "Starter Sword",
      familyId: "one_handed_sword",
      assetKey: "weapons/starter-sword.png",
      cosmetic: false,
      equipmentDefinitionId: "starter_sword",
      placements: { idle: { offsetX: 17 }, combat_ready: { offsetX: 8 } }
    }];
    const reset = resetAppearancePose(
      catalog,
      "starter_sword",
      "combat_ready"
    );
    expect(reset.appearances[0]!.placements?.combat_ready).toBeUndefined();
    expect(reset.appearances[0]!.placements?.idle?.offsetX).toBe(17);
  });

  it("updates one tone link without changing the shared base transform or poses", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const before = structuredClone(catalog.bodyVariants[0]!);
    const updated = withImportedPlayerSkinToneAsset(
      catalog,
      "medium",
      "bodies/player-medium.png"
    );
    const body = updated.bodyVariants[0]!;
    expect(body.skinToneAssetKeys?.medium).toBe("bodies/player-medium.png");
    expect(body.skinToneAssetKeys?.light).toBe(before.skinToneAssetKeys?.light);
    expect(body.bodyAssetKeys).toEqual(before.bodyAssetKeys);
    expect(body.bodyTransforms).toEqual(before.bodyTransforms);
    expect(body.poses).toEqual(before.poses);
  });
});
