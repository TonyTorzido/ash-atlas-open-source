import type { FlagServerMessage, WorldServerMessage } from "@ash-atlas/shared";
import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";

import { PopulationPreparationStory } from "./PopulationPreparationStory.js";

test.beforeEach(async ({ page, mount }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    window.populationStoryClientFrames = [];
  });
  await mount(<PopulationPreparationStory />);
});

test("commits the real flag frame while required population remains pending", async ({
  page
}) => {
  await sendFrame(page, flagBuildStarted());
  await sendFrame(page, populationFrame({
    preparationGeneration: 5,
    readyVisibleZoneCount: 1
  }));

  await page.clock.fastForward(9_999);
  await expect(page.getByTestId("flag-receipt")).toHaveCount(0);
  await page.clock.fastForward(1);
  await expect(page.getByTestId("flag-countdown"))
    .toHaveText("Finalizing\u2026");

  const created = flagCreated();
  await sendFrame(page, created);
  await sendFrame(page, {
    type: "FLAG_UPSERTED",
    flag: created.flag,
    serverTime: 10_000
  });
  await page.clock.fastForward(30_000);

  await expect(page.getByTestId("flag-receipt"))
    .toHaveText("Flag created: Southwatch");
  await expect(page.getByTestId("flag-receipt")).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Harvest" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Combat" })).toBeEnabled();
});

test("clears a typed recovery on its correlated result and accepts the replacement", async ({
  page
}) => {
  await sendFrame(page, populationFrame({
    preparationGeneration: 5,
    readyVisibleZoneCount: 1
  }));
  await page.clock.fastForward(200);
  await expect(page.getByRole("progressbar")).toBeVisible();

  await page.clock.fastForward(15_000);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByText("Refreshing the nearby world\u2026"))
    .toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const recoveryFrames = await populationResyncFrames(page);
  expect(recoveryFrames).toEqual([
    expect.objectContaining({
      type: "REQUEST_POPULATION_RESYNC",
      connectionId: "connection-1",
      connectionGeneration: 3,
      preparationGeneration: 5,
      relocationRevision: 7,
      resourceVisionRevision: 9,
      preparationTrigger: "flag-travel",
      preparationScope: "required-visible"
    })
  ]);

  const requestId = recoveryFrames[0]?.requestId;
  expect(requestId).toEqual(expect.any(String));
  await sendFrame(page, populationResyncResult({
    requestId: "unrelated-request",
    currentPreparationGeneration: 5
  }));
  await expect(page.getByText("Refreshing the nearby world\u2026"))
    .toBeVisible();
  await sendFrame(page, populationResyncResult({
    requestId: requestId!,
    outcome: "republished",
    currentPreparationGeneration: 5,
    preparationResult: "pending",
    visibleZoneCount: 5,
    readyVisibleZoneCount: 1,
    terminal: false
  }));
  await expect(page.getByText("Refreshing the nearby world\u2026"))
    .toHaveCount(0);
  await page.clock.fastForward(200);
  await expect(page.getByRole("progressbar")).toBeVisible();

  await sendFrame(page, populationFrame({
    preparationGeneration: 6,
    readyVisibleZoneCount: 2
  }));
  await sendFrame(page, populationFrame({
    preparationGeneration: 6,
    readyVisibleZoneCount: 5,
    preparationResult: "ready",
    partial: false,
    terminal: true
  }));
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByText("Refreshing the nearby world\u2026"))
    .toHaveCount(0);
  await expect(page.getByTestId("preparation-state")).toHaveText("ready");
});

test("reaches 25 to 75 to 100 percent after permanent-stone plan adoption", async ({
  page
}) => {
  await sendFrame(page, populationFrame({
    visibleZoneCount: 4,
    readyVisibleZoneCount: 1
  }));
  await page.clock.fastForward(200);
  await expect(page.getByTestId("preparation-percent")).toHaveText("25");
  await expect(page.getByRole("progressbar"))
    .toHaveAttribute("aria-valuenow", "25");

  await sendFrame(page, populationFrame({
    visibleZoneCount: 4,
    readyVisibleZoneCount: 3
  }));
  await expect(page.getByTestId("preparation-percent")).toHaveText("75");
  await expect(page.getByRole("progressbar"))
    .toHaveAttribute("aria-valuenow", "75");

  await sendFrame(page, populationFrame({
    visibleZoneCount: 4,
    readyVisibleZoneCount: 4,
    preparationResult: "ready",
    partial: false,
    terminal: true
  }));
  await expect(page.getByTestId("preparation-percent")).toHaveText("100");
  await expect(page.getByTestId("preparation-state")).toHaveText("ready");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByText("Refreshing the nearby world\u2026"))
    .toHaveCount(0);
});

test("abandons an unanswered recovery notice within three seconds", async ({
  page
}) => {
  await sendFrame(page, populationFrame());
  await page.clock.fastForward(15_000);
  await expect(page.getByText("Refreshing the nearby world\u2026"))
    .toBeVisible();
  await page.clock.fastForward(3_000);
  await expect(page.getByText("Refreshing the nearby world\u2026"))
    .toHaveCount(0);
});

test("keeps a committed flag and stays silent for late optional failure", async ({
  page
}) => {
  await sendFrame(page, flagCreated());
  await sendFrame(page, populationFrame({
    preparationGeneration: 7,
    preparationTrigger: "flag-construction",
    preparationScope: "neighbor-preload",
    requiredForGameplay: false,
    readyVisibleZoneCount: 0,
    visibleZoneCount: 0,
    backgroundZoneCount: 3,
    readyBackgroundZoneCount: 1,
    preparationResult: "retryable-failure",
    partial: false,
    terminal: true
  }));

  await expect(page.getByTestId("flag-receipt"))
    .toHaveText("Flag created: Southwatch");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Refreshing the nearby world\u2026"))
    .toHaveCount(0);
  expect(await populationResyncFrames(page)).toHaveLength(0);
});

async function sendFrame(
  page: Parameters<typeof populationResyncFrames>[0],
  frame: FlagServerMessage | WorldServerMessage
): Promise<void> {
  await page.evaluate((message) => {
    window.receivePopulationStoryFrame(message);
  }, frame);
}

async function populationResyncFrames(
  page: Page
) {
  return page.evaluate(() => window.populationStoryClientFrames.filter(
    (message) => message.type === "REQUEST_POPULATION_RESYNC"
  ));
}

function flagBuildStarted(): FlagServerMessage {
  return {
    type: "FLAG_BUILD_STARTED",
    buildId: "build-1",
    requestId: "request-1",
    startedAt: 0,
    completesAt: 10_000,
    durationMs: 10_000,
    serverTime: 0,
    position: { lat: 35, lon: -106 },
    flagName: "Southwatch"
  };
}

function flagCreated(): Extract<FlagServerMessage, { type: "FLAG_CREATED" }> {
  return {
    type: "FLAG_CREATED",
    requestId: "request-1",
    buildId: "build-1",
    serverTime: 10_000,
    flag: {
      id: "flag-1",
      controlType: "personal",
      ownerId: "player-1",
      name: "Southwatch",
      lat: 35,
      lon: -106,
      packageId: "world_v1_lat35_lon-106",
      elevationM: 1_600,
      terrainClass: "forest",
      biome: "temperate",
      ecoregion: "mountains",
      claimRadiusM: 200,
      cityId: null,
      createdAt: "2026-07-24T00:00:00.000Z"
    }
  };
}

function populationFrame(
  overrides: Partial<Extract<
    WorldServerMessage,
    { type: "POPULATION_ZONE_DELTA" }
  >> = {}
): Extract<WorldServerMessage, { type: "POPULATION_ZONE_DELTA" }> {
  return {
    type: "POPULATION_ZONE_DELTA",
    playerId: "player-1",
    connectionId: "connection-1",
    connectionGeneration: 3,
    preparationGeneration: 5,
    preparationTrigger: "flag-travel",
    preparationScope: "required-visible",
    requiredForGameplay: true,
    relocationRevision: 7,
    resourceVisionRevision: 9,
    gameplayViewGeneration: 11,
    retainedZoneIds: [],
    activatedZoneIds: [],
    releasedZoneIds: [],
    withheldZoneIds: [],
    upserts: [],
    removedEntityIds: [],
    visibleZoneCount: 5,
    readyVisibleZoneCount: 1,
    backgroundZoneCount: 2,
    readyBackgroundZoneCount: 0,
    zoneSnapshots: [],
    preparationReason: "durable-rehydration",
    preparationResult: "pending",
    partial: true,
    terminal: false,
    ...overrides
  };
}

function populationResyncResult(
  overrides: Partial<Extract<
    WorldServerMessage,
    { type: "POPULATION_RESYNC_RESULT" }
  >> = {}
): Extract<WorldServerMessage, { type: "POPULATION_RESYNC_RESULT" }> {
  return {
    type: "POPULATION_RESYNC_RESULT",
    requestId: "population-request-1",
    outcome: "republished",
    playerId: "player-1",
    connectionId: "connection-1",
    connectionGeneration: 3,
    requestedPreparationGeneration: 5,
    currentPreparationGeneration: 5,
    requestedRelocationRevision: 7,
    currentRelocationRevision: 7,
    requestedResourceVisionRevision: 9,
    currentResourceVisionRevision: 9,
    preparationReason: "durable-rehydration",
    preparationResult: "pending",
    visibleZoneCount: 5,
    readyVisibleZoneCount: 1,
    terminal: false,
    ...overrides
  };
}
