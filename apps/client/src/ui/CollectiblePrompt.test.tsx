import type { CollectibleNode } from "@ash-atlas/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CollectiblePrompt } from "./CollectiblePrompt.js";
import { formatRemainingDuration } from "./CollectiblePrompt.js";

describe("CollectiblePrompt gathering language", () => {
  it("retains detailed desktop information and offers CHOP for a tree", () => {
    const html = renderPrompt(node({ type: "wood", quantity: 4 }));
    expect(html).toContain("Giving Tree");
    expect(html).toContain(">CHOP</button>");
    expect(html).toContain("Type: wood");
    expect(html).toContain("Available: 4");
    expect(html).toContain("Distance: 10.0 m");
    expect(html).toContain("Interaction");
    expect(html).toContain("range: 50 m");
    expect(html).not.toMatch(/harvest tree/i);
  });

  it("offers Gather Berries and a fruiting name only while berries are available", () => {
    expect(renderPrompt(node({ berryAvailable: true, resinAvailable: false }))).toContain("Giving Tree (Fruiting)");
    expect(renderPrompt(node({ berryAvailable: false, resinAvailable: false }))).not.toContain("Giving Tree (Fruiting)");
    expect(renderPrompt(node({ berryAvailable: true, resinAvailable: false })))
      .toContain(">Gather Berries</button>");
    expect(renderPrompt(node({ berryAvailable: false, resinAvailable: false })))
      .not.toContain("Gather Berries");
  });

  it("offers Harvest Frond Sap beside Chop only while a Elder Fern has sap", () => {
    // "node-wood" is a Elder Fern.
    const now = Date.parse("2026-10-07T00:00:00.000Z");
    const withSap = renderPrompt(node({ id: "node-wood", sapReadyAt: null }), now);
    expect(withSap).toContain("Elder Fern (Sap)");
    expect(withSap).toContain(">Harvest Frond Sap</button>");
    expect(withSap).toContain(">CHOP</button>");
    const tapped = renderPrompt(node({ id: "node-wood", sapReadyAt: "2026-10-07T05:47:15.212Z" }), now);
    expect(tapped).toContain("Elder Fern (Tapped)");
    expect(tapped).not.toContain("Harvest Frond Sap");
    expect(tapped).toContain(">CHOP</button>");
    expect(renderPrompt(node({ id: "node-wood", sapReadyAt: "2026-10-06T23:59:59.000Z" }), now))
      .toContain(">Harvest Frond Sap</button>");
  });

  it("offers GATHER for a ready permanent mine", () => {
    const html = renderPrompt(node({
      type: "stone",
      quantity: 1,
      repeatableNodeType: "stone_mine",
      repeatableState: "ready",
      repeatableReadyAt: null
    }));
    expect(html).toContain(">GATHER</button>");
  });

  it("offers owner access management only in mine range", () => {
    const mine = node({
      type: "stone",
      quantity: 1,
      repeatableNodeType: "stone_mine",
      repeatableState: "ready",
      repeatableOwnerPlayerId: "owner",
      repeatableOwnerUsername: "Owner",
      repeatableAccessMode: "private",
      repeatableCanManage: true
    });
    const onManageAccess = vi.fn();
    expect(renderPrompt(mine, Date.now(), 10, onManageAccess)).toContain(">Make Public</button>");
    const outOfRange = renderPrompt(mine, Date.now(), 51, onManageAccess);
    expect(outOfRange).not.toContain("Make Public");
    expect(outOfRange).not.toContain("Move within 50 meters of this mine to change access.");
    expect(onManageAccess).not.toHaveBeenCalled();
  });

  it("keeps a depleted mine selected with a readable countdown and no gather action", () => {
    const html = renderPrompt(node({
      type: "stone",
      quantity: 1,
      repeatableNodeType: "stone_mine",
      repeatableState: "depleted",
      repeatableTimerVisibility: "visible",
      repeatableReadyAt: "2026-07-15T05:12:00.000Z"
    }), Date.parse("2026-07-15T00:00:00.000Z"));
    expect(html).toContain("Depleted — Ready in 5h 12m");
    expect(html).not.toContain("data-action-key=\"harvest\"");
  });

  it("uses a neutral depleted state for hidden, malformed, or elapsed timers", () => {
    for (const readyAt of [
      null,
      "not-a-timestamp",
      "2026-07-14T23:59:59.000Z"
    ]) {
      const html = renderPrompt(node({
        type: "stone",
        quantity: 1,
        repeatableNodeType: "stone_mine",
        repeatableState: "depleted",
        repeatableTimerVisibility: "visible",
        repeatableReadyAt: readyAt
      }), Date.parse("2026-07-15T00:00:00.000Z"));
      expect(html).toContain(">Depleted</p>");
      expect(html).not.toContain("server refresh");
      expect(html).not.toContain("Ready in");
    }
    expect(formatRemainingDuration(null, Date.now())).toBeNull();
  });

  it("keeps an intentionally redacted timer neutral", () => {
    const html = renderPrompt(node({
      type: "stone",
      quantity: 1,
      state: "harvested",
      repeatableNodeType: "stone_mine",
      repeatableState: "depleted",
      repeatableTimerVisibility: "redacted",
      repeatableReadyAt: null
    }));
    expect(html).toContain(">Depleted</p>");
    expect(html).not.toContain("Ready in");
    expect(html).not.toContain("server refresh");
  });

  it("keeps another resource actionable while mine claim remains busy", () => {
    const treeHtml = renderToStaticMarkup(<CollectiblePrompt
      collectible={node({ type: "wood" })}
      distanceM={10}
      task={null}
      nowMs={Date.now()}
      disabled={false}
      otherHarvestBusy
      onHarvest={vi.fn()}
      onCancel={vi.fn()}
    />);
    const mineHtml = renderToStaticMarkup(<CollectiblePrompt
      collectible={node({
        type: "stone",
        repeatableNodeType: "stone_mine",
        repeatableOwnerPlayerId: null
      })}
      distanceM={10}
      task={null}
      nowMs={Date.now()}
      disabled={false}
      otherHarvestBusy
      onHarvest={vi.fn()}
      onClaim={vi.fn()}
      onCancel={vi.fn()}
    />);

    expect(treeHtml).toContain(">CHOP</button>");
    expect(treeHtml).not.toMatch(/disabled=""[^>]*>CHOP/);
    expect(mineHtml).not.toContain("Claim Mine");
  });

  it("keeps the active mine gather button actionable when its prompt is retapped", () => {
    const html = renderToStaticMarkup(<CollectiblePrompt
      collectible={node({
        type: "stone",
        repeatableNodeType: "stone_mine",
        repeatableState: "ready"
      })}
      distanceM={10}
      task={{
        nodeId: "node",
        action: "primary",
        phase: "harvesting",
        sessionId: "session",
        completesAtMs: Date.now() + 5_000,
        startedAtMs: Date.now(),
        startRequestedAtMs: Date.now()
      }}
      nowMs={Date.now()}
      disabled={false}
      onHarvest={vi.fn()}
      onCancel={vi.fn()}
    />);

    expect(html).not.toMatch(/disabled=""[^>]*>HARVESTING/);
  });
});

function renderPrompt(
  collectible: CollectibleNode,
  nowMs = Date.now(),
  distanceM = 10,
  onManageAccess?: () => void
): string {
  return renderToStaticMarkup(<CollectiblePrompt
    collectible={collectible}
    distanceM={distanceM}
    task={null}
    nowMs={nowMs}
    disabled={false}
    onHarvest={vi.fn()}
    {...(onManageAccess ? { onManageAccess } : {})}
    onCancel={vi.fn()}
  />);
}

function node(overrides: Partial<CollectibleNode>): CollectibleNode {
  return {
    id: "node",
    type: "wood",
    lat: 35,
    lon: -106,
    quantity: 4,
    state: "available",
    createdAt: "2026-07-15T00:00:00.000Z",
    harvestedAt: null,
    sourceCellId: "cell",
    waterKind: null,
    ...overrides
  };
}
