import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  selectPrimaryWorldActivityTimer,
  WorldActivityTimerPlate,
  worldActivityKindForGatheringLabel,
  type WorldActivityTimerCandidate,
  type WorldActivityTimerKind
} from "./WorldActivityTimerPlate.js";

const candidate = (kind: WorldActivityTimerKind, priority = 1): WorldActivityTimerCandidate => ({
  kind,
  ariaLabel: `${kind} activity`,
  remainingTimeLabel: "4.2s",
  progress: 0.42,
  priority
});

describe("WorldActivityTimerPlate", () => {
  it("maps each gathering label to an activity-specific glyph", () => {
    expect(worldActivityKindForGatheringLabel("Chopping")).toBe("gathering-chopping");
    expect(worldActivityKindForGatheringLabel("Mining")).toBe("gathering-mining");
    expect(worldActivityKindForGatheringLabel("Harvesting")).toBe("gathering-harvesting");

    for (const kind of [
      "flag",
      "gathering-chopping",
      "gathering-mining",
      "gathering-harvesting",
      "greenhouse-planting",
      "flag-hardening",
      "furnace",
      "tannery",
      "loom",
      "kitchen",
      "fishing-hut",
      "manor",
      "kingdom-seat",
      "city-construction",
      "city-flag-conversion"
    ] as const) {
      const html = renderToStaticMarkup(<WorldActivityTimerPlate {...candidate(kind)} />);
      expect(html).toContain(`data-world-activity="${kind}"`);
      expect(html).toContain(`data-world-activity-icon="${kind}"`);
      expect(html).toContain('viewBox="0 0 24 24"');
    }
  });

  it("renders one centered, accessible determinate plate", () => {
    const html = renderToStaticMarkup(
      <WorldActivityTimerPlate {...candidate("furnace")} />
    );
    expect(html).toContain('class="world-activity-timer-plate"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="furnace activity time remaining"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('style="width:42%"');
    expect(html).toContain('class="sr-only">furnace activity</span>');
  });

  it("selects a deterministic single primary activity without changing candidates", () => {
    const gathering = candidate("gathering-mining", 20);
    const construction = candidate("furnace", 40);
    const selected = selectPrimaryWorldActivityTimer([construction, gathering]);
    expect(selected).toEqual(gathering);
    expect(selectPrimaryWorldActivityTimer([null, null])).toBeNull();
    expect(construction.progress).toBe(0.42);
  });
});
