import type {
  FlagAccessSnapshot,
  FlagSnapshot,
  PlayerSnapshot,
  WorldMapDestinationSnapshot
} from "@ash-atlas/shared";
import { expect, test } from "@playwright/experimental-ct-react";

import { WorldMapOverlay } from "../src/ui/WorldMapOverlay.js";
import { FlagFlowStory } from "./FlagFlowStory.js";

test("personal owners reach the two alternative access modes through More", async ({
  mount,
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("https://game.example/api/flags/**/access", async (route) => {
    const access = accessSnapshot();
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        mode: FlagAccessSnapshot["mode"];
        jumpTollGold: string;
      };
      await route.fulfill({
        json: {
          access: {
            ...access,
            mode: body.mode,
            jumpTollGold: body.jumpTollGold
          }
        }
      });
      return;
    }
    await route.fulfill({ json: { access } });
  });
  await page.route("https://game.example/api/flags/atlas-shrines/status", async (route) => {
    await route.fulfill({ json: { progression: {
      unlockedSlots: 4,
      builtShrines: 4,
      availableCapacity: 0,
      nextSlot: 5,
      requiredLevel: 5,
      playerLevel: 5,
      requiredShards: 5,
      currentShards: 28,
      levelRequirementMet: true,
      shardRequirementMet: true
    } } });
  });
  await mount(<FlagFlowStory flag={personalFlag()} player={player()} />);

  await page.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("button", { name: "Jump" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to Game Menu" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Return to Game" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(1);
  await expect(page.getByText("28/5 shards")).toBeVisible();
  await expect(page.locator(".phone-menu-layer")).toHaveCount(0);
  const prompt = page.locator(".mobile-world-action-sheet");
  await expect(prompt).toHaveCount(1);
  const promptBounds = await prompt.boundingBox();
  expect(promptBounds).not.toBeNull();
  expect(promptBounds!.width).toBeLessThan(390);
  expect(promptBounds!.height).toBeLessThan(500);
  const options = page.getByRole("group", { name: "Access" });
  await expect(options.getByRole("button")).toHaveText(["Public", "Private"]);
  const optionBounds = await options.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const bounds = button.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
  }));
  const accessBounds = await options.locator(".flag-more-access-options").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right };
  });
  expect(Math.abs(optionBounds[0]!.right - optionBounds[1]!.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(optionBounds[0]!.top - optionBounds[1]!.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(optionBounds[0]!.bottom - optionBounds[1]!.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(optionBounds[0]!.left - accessBounds.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(optionBounds[1]!.right - accessBounds.right)).toBeLessThanOrEqual(1);
  await expect(page.getByText("Custom")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save Access" })).toHaveCount(0);
  await expect(page.getByLabel("Public toll")).toHaveCount(0);
  await expect(page.locator("select")).toHaveCount(0);
  const requestPromise = page.waitForRequest((request) =>
    request.method() === "PATCH" && request.url().endsWith(`/api/flags/${personalFlag().id}/access`)
  );
  await options.getByRole("button", { name: "Public" }).click();
  const request = await requestPromise;
  expect(request.postDataJSON()).toEqual({ mode: "public", jumpTollGold: "0" });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Jump" })).toHaveCount(0);
});

test("phone destination clusters use the canonical picker and compact prompt", async ({
  mount,
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.setAttribute("data-ui-profile", "phone"));
  await mount(<WorldMapOverlay
    open
    snapshot={destinations()}
    fallbackCenter={{ lat: 35, lon: -106 }}
    connectionStatus="online"
    travelDisabled={false}
    developerAccessEnabled={false}
    developerMenuOpen={false}
    teleportMode="idle"
    layout="phone"
    onClose={() => undefined}
    onTravel={() => null}
    onOpenDeveloperTools={() => undefined}
    onTeleportTarget={() => undefined}
    onCancelTeleport={() => undefined}
  />);

  await expect(page.locator(".world-map-destination-tray")).toHaveCount(0);
  await page.locator(".world-map-marker--group").click();
  const picker = page.getByRole("dialog", { name: /nearby destinations/ });
  await expect(picker.getByRole("button", { name: /Town 24/ })).toBeVisible();
  await picker.getByRole("button", { name: /Town 24/ }).click();
  const prompt = page.getByRole("complementary", { name: "Town 24 actions" });
  await expect(prompt.getByRole("button", { name: "Travel" })).toBeEnabled();
});

function accessSnapshot(): FlagAccessSnapshot {
  return {
    flagId: personalFlag().id,
    ownerPlayerId: "owner-1",
    mode: "normal",
    jumpTollGold: "0",
    accessRevision: "1",
    requestPending: false,
    decision: {
      allowed: true,
      requestable: false,
      reasonCode: "ALLOWED_OWNER",
      tollGold: "0"
    },
    management: { pendingRequests: [] }
  };
}

function personalFlag(): FlagSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    controlType: "personal",
    ownerId: "owner-1",
    ownerUsername: "Ash",
    ownerColor: "#38bdf8",
    name: "Flag 1",
    lat: 53.3498,
    lon: -6.2603,
    packageId: "world_v1_lat53_lon-7",
    elevationM: 0,
    terrainClass: "flat",
    biome: "Temperate Broadleaf & Mixed Forests",
    ecoregion: "Celtic broadleaf forests",
    claimRadiusM: 1000,
    cityId: null,
    createdAt: "2026-07-13T08:00:00.000Z"
  };
}

function player(): PlayerSnapshot {
  return {
    playerId: "owner-1",
    username: "Ash",
    displayColor: "#38bdf8",
    regionCode: "GLOBAL",
    zoneId: "world",
    lat: 53.3498,
    lon: -6.2603,
    anchorLat: 53.3498,
    anchorLon: -6.2603,
    moveLeashRadiusM: 1250,
    movementRevision: 0,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: "2026-07-13T08:00:00.000Z"
  };
}

function destinations(): WorldMapDestinationSnapshot {
  return {
    destinations: Array.from({ length: 24 }, (_, index) => ({
      kind: "city" as const,
      id: `city-${index + 1}`,
      name: `Town ${String(index + 1).padStart(2, "0")}`,
      lat: 35 + index / 100,
      lon: -106 + index / 100
    })),
    serverTime: 1
  };
}
