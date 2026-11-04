import { LAUNCH_ACTIVE_ABILITY_IDS } from "@ash-atlas/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClassAbilityIcon, CLASS_ABILITY_ICON_IDS, hasClassAbilityIcon } from "./ClassAbilityIcon.js";

describe("class ability icon catalog", () => {
  it("keeps one outline icon for each of the 15 catalogued class active skills and covers every launch active", () => {
    // The roster launches without hotbar actives; the catalogued icons stay for the retained class skills.
    const launchAbilityIds = Object.values(LAUNCH_ACTIVE_ABILITY_IDS).flat();
    expect(launchAbilityIds.every(hasClassAbilityIcon)).toBe(true);
    expect(CLASS_ABILITY_ICON_IDS).toHaveLength(15);
    for (const abilityId of CLASS_ABILITY_ICON_IDS) {
      expect(hasClassAbilityIcon(abilityId)).toBe(true);
      expect(renderToStaticMarkup(<ClassAbilityIcon abilityId={abilityId} />))
        .toContain(`data-class-ability-icon="${abilityId}"`);
    }
  });
});
