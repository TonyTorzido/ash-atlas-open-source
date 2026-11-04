import { describe, expect, it } from "vitest";

import {
  buildEconomyReport,
  calculateDistributionFromBigints,
  createXlsxWorkbook,
  type EconomyAnalysisEvent,
  type EconomyHolding,
  type SnapshotRead,
  economyHealthLabel,
  isEconomyGameplayActivityMessage,
  transferConservation
} from "./economyObservatory.js";

describe("economy observatory definitions", () => {
  it("normalizes HHI by actual holder count and reports actual top counts", () => {
    const result = calculateDistributionFromBigints([100n, 25n, 5n]);

    expect(result.total).toBe("130");
    expect(result.holderCount).toBe(3);
    expect(result.normalizedHhi).toBeGreaterThan(0.4);
    expect(result.normalizedHhi).toBeLessThan(1);
    expect(result.topN.actualCount).toBe(3);
    expect(result.topPercent.actualCount).toBe(1);
    expect(result.topPlayers.map((entry) => entry.actualCount)).toEqual([1, 3, 3, 3]);
    expect(result.topPercents.map((entry) => entry.actualCount)).toEqual([1, 1, 1]);
  });

  it("keeps transfer legs globally conserved", () => {
    expect(transferConservation([
      { leg: "debit", quantity: 17n },
      { leg: "credit", quantity: 17n }
    ])).toBe(0n);
    expect(transferConservation([
      { leg: "debit", quantity: 17n },
      { leg: "credit", quantity: 16n }
    ])).toBe(-1n);
  });

  it("gates health on coverage, volume, reconciliation, and staleness", () => {
    expect(economyHealthLabel({
      coverage: 1,
      eventCount: 10,
      holderCount: 3,
      reconciliationOk: true,
      stale: false,
      normalizedHhi: 0.1
    })).toBe("healthy");
    expect(economyHealthLabel({
      coverage: 1,
      eventCount: 10,
      holderCount: 3,
      reconciliationOk: false,
      stale: false
    })).toBe("critical");
    expect(economyHealthLabel({
      coverage: 1,
      eventCount: 10,
      holderCount: 3,
      reconciliationOk: true,
      stale: true
    })).toBe("stale");
    expect(economyHealthLabel({
      coverage: 0.5,
      eventCount: 100,
      holderCount: 3,
      reconciliationOk: true,
      stale: false
    })).toBe("insufficient-data");
    expect(economyHealthLabel({
      coverage: 1,
      eventCount: 100,
      holderCount: 3,
      activePlayerCount: 3,
      historicalBaselineAvailable: false,
      observationWindowMs: 24 * 60 * 60 * 1000,
      reconciliationOk: true,
      stale: false
    })).toBe("insufficient-data");
  });

  it("does not count PING or telemetry as gameplay activity", () => {
    expect(isEconomyGameplayActivityMessage("PING")).toBe(false);
    expect(isEconomyGameplayActivityMessage("TELEMETRY_BATCH")).toBe(false);
    expect(isEconomyGameplayActivityMessage("MOVE")).toBe(true);
  });

  it("writes bounded formula-safe XLSX cells", () => {
    const workbook = createXlsxWorkbook([{
      name: "Export",
      rows: [["value"], ["=1+1"], ["@cmd"], ["safe"]]
    }]);
    const text = workbook.toString("utf8");
    expect(workbook.subarray(0, 2).toString("hex")).toBe("504b");
    expect(text).toContain("&apos;=1+1");
    expect(text).toContain("&apos;@cmd");
  });

  it("keeps ten balancing scenarios distinguishable in the 24h report", () => {
    const snapshot = syntheticSnapshot();
    const report = buildEconomyReport(snapshot, "24h");
    const byId = new Map(report.items.map((item) => [item.assetId, item]));

    expect(byId.get("common")?.acquisitionParticipationRate).toBe(1);
    expect(byId.get("rare")?.uniqueAcquiringPlayers).toBe(1);
    expect(byId.get("low_supply_high_acquisition")?.externalInflow).toBe("100");
    expect(byId.get("high_supply_no_acquisition")?.externalInflow).toBe("0");
    expect(byId.get("high_throughput")?.grossInflow).toBe("1000");
    expect(byId.get("high_throughput")?.grossOutflow).toBe("1000");
    expect(byId.get("common")?.top1Share).toBeCloseTo(0.1);
    expect(byId.get("common")?.top3Share).toBeCloseTo(0.3);
    expect(byId.get("common")?.top5Share).toBeCloseTo(0.5);
    expect(byId.get("accumulating")?.netChange).toBe("100");
    expect(byId.get("contracting")?.netChange).toBe("-100");
    expect(byId.get("concentrated")?.top1Share).toBeCloseTo(0.9);
    expect(byId.get("veteran_abundant_new_starved")?.zeroHolderRateAmongActivePlayers).toBeCloseTo(0.2);
    expect(byId.get("ordinary_zero_supply")?.endingExistingSupply).toBe("0");
    expect(byId.get("ordinary_zero_supply")?.holderCount).toBe(0);
    expect(byId.get("ordinary_zero_supply")?.attemptMetrics.supported).toBe(false);
    expect(report.playerItemRows.some((row) => row.itemId === "common" && row.playerId === "player-1")).toBe(true);
    expect(report.playerItemRows.some((row) => row.itemId === "ordinary_zero_supply" && row.playerId === "player-1" && row.endingQuantity === "0")).toBe(true);
    expect(report.playerItemRows.filter((row) => row.playerId === "player-1")).toHaveLength(10);
    expect(report.cohorts.some((row) => row.dimension === "level" && row.assetId === "veteran_abundant_new_starved")).toBe(true);
  });

  it("keeps custody transfers visible without treating them as acquisition or gross flow", () => {
    const base = syntheticSnapshot();
    const transferItem = { itemId: "transfer_only", displayName: "Transfer Only", category: "resource", assetKind: "fungible" as const };
    const transferHoldings: EconomyHolding[] = [
      {
        supplyScope: "player_controlled_existing_supply", existingSupply: true, assetKind: "fungible", assetId: "transfer_only", itemId: "transfer_only", variant: "default", uniqueAssetInstanceId: null,
        quantity: 80n, custodyType: "player_inventory", custodyId: "player-1", playerId: "player-1", organizationType: null, organizationId: null
      },
      {
        supplyScope: "existing_world_supply", existingSupply: true, assetKind: "fungible", assetId: "transfer_only", itemId: "transfer_only", variant: "default", uniqueAssetInstanceId: null,
        quantity: 80n, custodyType: "player_inventory", custodyId: "player-1", playerId: "player-1", organizationType: null, organizationId: null
      },
      {
        supplyScope: "player_controlled_existing_supply", existingSupply: true, assetKind: "fungible", assetId: "transfer_only", itemId: "transfer_only", variant: "default", uniqueAssetInstanceId: null,
        quantity: 20n, custodyType: "player_inventory", custodyId: "player-2", playerId: "player-2", organizationType: null, organizationId: null
      },
      {
        supplyScope: "existing_world_supply", existingSupply: true, assetKind: "fungible", assetId: "transfer_only", itemId: "transfer_only", variant: "default", uniqueAssetInstanceId: null,
        quantity: 20n, custodyType: "player_inventory", custodyId: "player-2", playerId: "player-2", organizationType: null, organizationId: null
      }
    ];
    const transferEvents: EconomyAnalysisEvent[] = [
      {
        eventId: "transfer-debit", eventKind: "TRANSFER", leg: "debit", assetKind: "fungible", assetId: "transfer_only", itemId: "transfer_only", variant: "default", uniqueAssetInstanceId: null,
        quantity: 20n, custodyType: "player_inventory", custodyId: "player-1", playerId: "player-1", organizationType: null, organizationId: null, sourceSystem: "synthetic", reason: "trade", occurredAt: "2026-09-11T11:00:00.000Z"
      },
      {
        eventId: "transfer-credit", eventKind: "TRANSFER", leg: "credit", assetKind: "fungible", assetId: "transfer_only", itemId: "transfer_only", variant: "default", uniqueAssetInstanceId: null,
        quantity: 20n, custodyType: "player_inventory", custodyId: "player-2", playerId: "player-2", organizationType: null, organizationId: null, sourceSystem: "synthetic", reason: "trade", occurredAt: "2026-09-11T11:00:00.000Z"
      }
    ];
    const report = buildEconomyReport({
      ...base,
      catalog: [...base.catalog, transferItem],
      holdings: [...base.holdings, ...transferHoldings],
      analysisEvents: [...base.analysisEvents, ...transferEvents]
    }, "24h");
    const item = report.items.find((entry) => entry.assetId === "transfer_only");
    expect(item).toMatchObject({ grossInflow: "0", grossOutflow: "0", transferInflow: "20", transferOutflow: "20", acquisitionEventCount: 0, outflowEventCount: 0, uniqueAcquiringPlayers: 0, uniqueSpendingPlayers: 0 });
    expect(report.sourceBreakdown.filter((entry) => entry.assetId === "transfer_only")).toHaveLength(0);
    expect(report.playerItemRows.find((row) => row.itemId === "transfer_only" && row.playerId === "player-1")).toMatchObject({ transferredOut: "20", grossAcquired: "0", grossOutflow: "0", startingQuantity: "100", endingQuantity: "80" });
    expect(report.playerItemRows.find((row) => row.itemId === "transfer_only" && row.playerId === "player-2")).toMatchObject({ transferredIn: "20", grossAcquired: "0", grossOutflow: "0", startingQuantity: "0", endingQuantity: "20" });
  });

  it("retains explicit workbook evidence sheets and stable raw headers", () => {
    const names = [
      "README", "24h Summary", "Item Statistics", "Acquisition Difficulty", "Source Sink Flow", "Source Breakdown",
      "Players", "Player Holdings Wide", "Player Holdings Long", "Player 24h Flow", "Item Holders", "Unique Assets",
      "Organization Holdings", "Cohort Statistics", "Concentration", "Coverage", "Data Quality"
    ];
    const workbook = createXlsxWorkbook(names.map((name) => ({ name, rows: [["asset_id", "ending_existing_supply"], ["ordinary_zero_supply", "0"]] })));
    const text = workbook.toString("utf8");
    expect(workbook.subarray(0, 2).toString("hex")).toBe("504b");
    for (const name of names) expect(text).toContain(name);
    expect(text).toContain("asset_id");
    expect(text).toContain("ending_existing_supply");
  });
});

function syntheticSnapshot(): SnapshotRead {
  const end = "2026-09-11T12:00:00.000Z";
  const start = "2026-09-10T12:00:00.000Z";
  const players = Array.from({ length: 10 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
    accountId: `account-${index + 1}`,
    accountCreatedAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: end,
    level: index < 2 ? 3 : 20,
    kingdomId: null,
    kingdomName: null,
    cityId: null,
    cityName: null,
    gold: 0n,
    connectedSeconds: 3600,
    activeSeconds: 3600,
    lastActiveAt: end
  }));
  const itemIds = [
    "common", "rare", "low_supply_high_acquisition", "high_supply_no_acquisition", "high_throughput",
    "accumulating", "contracting", "concentrated", "veteran_abundant_new_starved", "ordinary_zero_supply"
  ];
  const catalog = itemIds.map((itemId) => ({ itemId, displayName: itemId, category: "resource", assetKind: "fungible" as const }));
  const holdings: EconomyHolding[] = [];
  const events: EconomyAnalysisEvent[] = [];
  const addHolding = (itemId: string, playerId: string, quantity: bigint): void => {
    if (quantity <= 0n) return;
    holdings.push({ supplyScope: "player_controlled_existing_supply", existingSupply: true, assetKind: "fungible", assetId: itemId, itemId, variant: "default", uniqueAssetInstanceId: null, quantity, custodyType: "player_inventory", custodyId: playerId, playerId, organizationType: null, organizationId: null });
    holdings.push({ supplyScope: "existing_world_supply", existingSupply: true, assetKind: "fungible", assetId: itemId, itemId, variant: "default", uniqueAssetInstanceId: null, quantity, custodyType: "player_inventory", custodyId: playerId, playerId, organizationType: null, organizationId: null });
  };
  const addEvent = (eventId: string, itemId: string, playerId: string, eventKind: EconomyAnalysisEvent["eventKind"], leg: EconomyAnalysisEvent["leg"], quantity: bigint): void => {
    events.push({ eventId, eventKind, leg, assetKind: "fungible", assetId: itemId, itemId, variant: "default", uniqueAssetInstanceId: null, quantity, custodyType: "player_inventory", custodyId: playerId, playerId, organizationType: null, organizationId: null, sourceSystem: "synthetic", reason: eventKind.toLowerCase(), occurredAt: "2026-09-11T11:00:00.000Z" });
  };
  for (const player of players) {
    addHolding("common", player.playerId, 10n);
    addEvent(`common-${player.playerId}`, "common", player.playerId, "SOURCE", "credit", 10n);
  }
  addHolding("rare", "player-1", 5n);
  addEvent("rare-1", "rare", "player-1", "SOURCE", "credit", 5n);
  addHolding("low_supply_high_acquisition", "player-1", 10n);
  addEvent("low-in", "low_supply_high_acquisition", "player-1", "SOURCE", "credit", 100n);
  addEvent("low-out", "low_supply_high_acquisition", "player-1", "SINK", "debit", 90n);
  for (const player of players.slice(0, 5)) addHolding("high_supply_no_acquisition", player.playerId, 100n);
  for (const player of players) {
    addHolding("high_throughput", player.playerId, 50n);
    addEvent(`through-in-${player.playerId}`, "high_throughput", player.playerId, "SOURCE", "credit", 100n);
    addEvent(`through-out-${player.playerId}`, "high_throughput", player.playerId, "SINK", "debit", 100n);
  }
  addHolding("accumulating", "player-1", 100n);
  addEvent("accum-in", "accumulating", "player-1", "SOURCE", "credit", 100n);
  addHolding("contracting", "player-1", 20n);
  addEvent("contract-out", "contracting", "player-1", "SINK", "debit", 100n);
  addHolding("concentrated", "player-1", 900n);
  addHolding("concentrated", "player-2", 100n);
  for (const player of players.slice(2)) addHolding("veteran_abundant_new_starved", player.playerId, 100n);
  return {
    snapshotId: "snapshot",
    snapshotAsOf: end,
    snapshotStart: start,
    holdings,
    flows: [],
    analysisEvents: events,
    catalog,
    players,
    attempts: new Map(),
    analysisEventsTruncated: false,
    coverage: [{ domain: "inventory", status: "complete", reliableFrom: start, lastObservedAt: end, notes: "synthetic" }],
    sessions: [],
    metadata: {
      snapshotId: "snapshot",
      snapshotAsOf: end,
      isolationLevel: "REPEATABLE READ",
      historicalBaselineAvailable: true,
      sourceWatermarks: { inventory: null, wallet: null, economyLatestAt: end, inventoryLatestAt: end, walletLatestAt: null },
      reconciliation: { status: "ok", transferGroups: 0, imbalancedGroups: 0 },
      staleness: { isStale: false, staleSources: [], maxAgeSeconds: 0 }
    }
  };
}
