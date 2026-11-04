import {
  ASH_ATLAS_PROTOCOL_QUERY_KEYS,
  DEFAULT_FLAG_CLAIM_RADIUS_M,
  DEFAULT_FLAG_PREPARE_RADIUS_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  distanceMeters,
  emptyEquipmentSlots,
  resolveEquipmentCombatStats,
  type ClientMessage,
  type CollectibleNode,
  type EquipmentChallengeProfile,
  type FlagSnapshot,
  type PlayerInventorySnapshot,
  type PlayerSnapshot,
  type RepeatableResourceNode,
  type ResourceVision,
  type ResourceVisionStatus,
  type ServerMessage
} from "@ash-atlas/shared";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthService } from "../auth/authService.js";
import { loadConfig } from "../config.js";
import type { CityService } from "../game/cities.js";
import type { CollectibleService } from "../game/collectibles.js";
import { CombatEngine } from "../game/combat/combatEngine.js";
import type { CombatProfileService } from "../game/combat/combatProfiles.js";
import type { EquipmentService } from "../game/equipment.js";
import type { FlagAccessService } from "../game/flagAccess.js";
import type { FlagService } from "../game/flags.js";
import type { KingdomService } from "../game/kingdoms.js";
import type { LegendaryBirdEventService } from "../game/legendaryBirdEvents.js";
import type { PlayerLocationService } from "../game/locations/playerLocationService.js";
import { PortalRegistry } from "../game/locations/portalRegistry.js";
import type { ManorPresenceService } from "../game/manor.js";
import { InMemoryPartyAuthority, type PartySnapshot } from "../game/party/PartyAuthority.js";
import type { PlayerService } from "../game/players.js";
import type { RepeatableResourceService } from "../game/repeatableResources.js";
import {
  packageIdForPosition,
  zoneIdForPosition
} from "../game/spatialZones.js";
import { GameState, type PlayerRecord } from "../game/state.js";
import type { TravelInviteService } from "../game/travelInvites.js";
import type { WorldMapService } from "../game/worldMap.js";
import { WorldRuntime } from "../game/worldRuntime.js";
import { createLogger } from "../logger.js";
import { ConnectionRegistry } from "./connectionRegistry.js";
import {
  registerRealtime,
  type PopulationV2RealtimeHooks
} from "./websocket.js";

const FLAG = {
  id: "11111111-1111-4111-8111-111111111111",
  controlType: "personal",
  ownerId: "leader",
  ownerUsername: "Leader",
  ownerColor: "#38bdf8",
  name: "Shared Camp",
  lat: 35.0875,
  lon: -106.6545,
  packageId: null,
  elevationM: null,
  terrainClass: null,
  biome: null,
  ecoregion: null,
  cityId: null,
  claimRadiusM: DEFAULT_FLAG_CLAIM_RADIUS_M,
  accessMode: "public",
  jumpTollGold: "6",
  createdAt: "2026-07-13T00:00:00.000Z"
} satisfies FlagSnapshot;

const KINGDOM_SEAT = {
  id: "33333333-3333-4333-8333-333333333333",
  kingdomId: "44444444-4444-4444-8444-444444444444",
  name: "Ember Crown Castle",
  lat: 35.087,
  lon: -106.655,
  claimRadiusM: 200
};

describe("distributed flag travel integration", () => {
  it("passes long-distance flag travel through durable military leave-behind reconciliation", async () => {
    const preserveMilitaryOnTravel = vi.fn(async () => ({
      accompaniedGroups: 0,
      leftBehindGroups: 1,
      warning: "Your troops will remain behind."
    }));
    const militaryIndustry = {
      preserveMilitaryOnTravel,
      reconcileDueTrainingJobs: vi.fn(async () => 0),
      reconcileDueRecovery: vi.fn(async () => 0),
      reconcileDueRallies: vi.fn(async () => 0),
      reconcileDueBomberDemolitions: vi.fn(async () => 0),
      reconcileDueBallistaVolleys: vi.fn(async () => 0)
    };
    const harness = await createHarness(["traveler"], null, undefined, undefined, {
      cities: {
        listCitiesNear: vi.fn(async () => []),
        getMembership: vi.fn(async () => null),
        militaryIndustry
      } as unknown as CityService
    });
    try {
      harness.clients.get("traveler")!.socket.send(
        visitFlag("military-long-distance")
      );
      await vi.waitFor(() => expect(
        harness.clients.get("traveler")!.messages
      ).toContainEqual(expect.objectContaining({
        type: "FLAG_VISITED",
        requestId: "military-long-distance",
        warning: "Your troops will remain behind."
      })));
      expect(preserveMilitaryOnTravel).toHaveBeenCalledWith(
        expect.objectContaining({
          playerId: "traveler",
          operationKind: "flag",
          destinationKind: "flag",
          lastKnownPosition: expect.any(Object)
        }),
        undefined
      );
    } finally {
      await harness.close();
    }
  });

  it("keeps committed flag travel successful when legendary activation publication fails", async () => {
    const activateForCommittedArrival = vi.fn(async () => "legendary-event-1");
    const publishActivation = vi.fn(async () => {
      throw new Error("legendary publication unavailable");
    });
    const legendaryBirdEvents = {
      activateForCommittedArrival,
      publishActivation,
      sendCurrentAlerts: vi.fn(async () => undefined)
    } as unknown as LegendaryBirdEventService;
    const harness = await createHarness(["leader"], null, undefined, undefined, {
      flagAccess: permissiveFlagAccess(true),
      legendaryBirdEvents
    });
    try {
      harness.clients.get("leader")!.socket.send(visitFlag("legendary-publish-failure"));

      await vi.waitFor(() => expect(
        harness.clients.get("leader")!.messages
      ).toContainEqual(expect.objectContaining({
        type: "FLAG_VISITED",
        requestId: "legendary-publish-failure",
        flagId: FLAG.id
      })));
      expect(harness.clients.get("leader")!.messages).not.toContainEqual(
        expect.objectContaining({ type: "ERROR", requestId: "legendary-publish-failure" })
      );
      expect(activateForCommittedArrival).toHaveBeenCalledTimes(1);
      expect(publishActivation).toHaveBeenCalledWith("legendary-event-1");
    } finally {
      await harness.close();
    }
  });

  it("keeps the owner alert, flag state, and flag-origin bird aligned through arrival", async () => {
    const eventId = "legendary-event-arrival";
    const visibleActivation = createDeferred<{
      status: "ready";
      pendingVisibleZoneCount: 0;
    }>();
    const birdEntityId = `legendary-bird:${eventId}`;
    const publishedFlag: FlagSnapshot = { ...FLAG };
    const alert = {
      type: "LEGENDARY_EVENT_ALERT" as const,
      eventId,
      birdSpecies: "fire" as const,
      flagId: FLAG.id,
      message: "A Phoenix is attacking your flag!",
      selectedAt: "2026-07-13T23:00:00.000Z",
      expiresAt: "2026-07-14T00:00:00.000Z"
    };
    const activateForCommittedArrival = vi.fn(async () => {
      harness.registry.send("leader", alert);
      return eventId;
    });
    const spawnActivation = vi.fn(async () => {
      harness.combat.spawnMob({
        entityId: birdEntityId,
        archetype: "fire_bird",
        position: { lat: FLAG.lat, lon: FLAG.lon },
        homePosition: { lat: FLAG.lat, lon: FLAG.lon },
        regionCode: packageIdForPosition(FLAG),
        zoneId: zoneIdForPosition(FLAG),
        originFlagId: FLAG.id
      });
    });
    const publishActivation = vi.fn(async () => {
      Object.assign(publishedFlag, {
        health: 100,
        maximumHealth: 200,
        burning: true,
        burningStartedAt: "2026-07-13T00:00:00.000Z",
        burningUntil: "2026-07-14T00:00:00.000Z",
        legendaryBirdSpecies: "fire"
      });
      harness.registry.broadcast({
        type: "FLAG_UPSERTED",
        flag: publishedFlag,
        serverTime: Date.now(),
        flagSetRevision: 1
      });
    });
    const legendaryBirdEvents = {
      activateForCommittedArrival,
      spawnActivation,
      publishActivation,
      sendCurrentAlerts: vi.fn(async () => undefined)
    } as unknown as LegendaryBirdEventService;
    const populationV2 = {
      ...readyPopulationHooks(),
      relocate: vi.fn<PopulationV2RealtimeHooks["relocate"]>(
        (input) => input.trigger === "flag-travel"
          ? {
              visibleReady: visibleActivation.promise,
              presentationReady: visibleActivation.promise,
              completion: visibleActivation.promise.then(() => undefined),
              preparationGeneration: 42,
              pendingVisibleZoneCount: () => 1
            }
          : readyPopulationRelocation()
      )
    } satisfies PopulationV2RealtimeHooks;
    const harness = await createHarness(
      ["leader"],
      null,
      undefined,
      undefined,
      {
        flagAccess: permissiveFlagAccess(true),
        legendaryBirdEvents,
        populationV2,
        flags: [publishedFlag],
        scopedFlagSnapshots: true
      }
    );
    const sendSpy = vi.spyOn(harness.registry, "send");
    try {
      harness.clients.get("leader")!.socket.send(visitFlag("legendary-arrival"));

      await vi.waitFor(() => expect(spawnActivation).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(
        harness.clients.get("leader")!.messages
      ).toContainEqual(expect.objectContaining({
        type: "FLAG_VISITED",
        requestId: "legendary-arrival",
        flagId: FLAG.id
      })));
      await vi.waitFor(() => expect(publishActivation).toHaveBeenCalledOnce());

      const visitedSendIndex = sendSpy.mock.calls.findIndex(([, message]) =>
        message.type === "FLAG_VISITED" &&
        message.requestId === "legendary-arrival"
      );
      expect(visitedSendIndex).toBeGreaterThanOrEqual(0);
      expect(publishActivation.mock.invocationCallOrder[0]!).toBeGreaterThan(
        sendSpy.mock.invocationCallOrder[visitedSendIndex]!
      );
      expect(harness.clients.get("leader")!.messages).toContainEqual(alert);
      expect(harness.clients.get("leader")!.messages).toContainEqual(
        expect.objectContaining({
          type: "FLAG_UPSERTED",
          flag: expect.objectContaining({
            id: FLAG.id,
            legendaryBirdSpecies: "fire",
            burning: true,
            health: 100
          })
        })
      );

      visibleActivation.resolve({ status: "ready", pendingVisibleZoneCount: 0 });
      await vi.waitFor(() => {
        const snapshot = harness.clients.get("leader")!.messages.find(
          (message) => message.type === "COMBAT_SNAPSHOT" &&
            message.worldViewAuthority?.relocationRevision === 1
        );
        expect(snapshot?.type === "COMBAT_SNAPSHOT"
          ? snapshot.state.upserts
          : []).toContainEqual(expect.objectContaining({
            entityId: birdEntityId,
            archetypeKey: "fire_bird",
            lifeState: "alive"
          }));
      });
      await vi.waitFor(() => expect(
        harness.clients.get("leader")!.messages
      ).toContainEqual(expect.objectContaining({
        type: "FLAGS_SNAPSHOT",
        flags: expect.arrayContaining([
          expect.objectContaining({
            id: FLAG.id,
            legendaryBirdSpecies: "fire",
            burning: true,
            health: 100
          })
        ])
      })));
    } finally {
      visibleActivation.resolve({ status: "ready", pendingVisibleZoneCount: 0 });
      await harness.close();
    }
  });

  it("allows a direct compatibility jump to a very distant map flag without intermediate flags", async () => {
    const distantFlag = {
      ...FLAG,
      id: "99999999-9999-4999-8999-999999999999",
      lat: 47.6062,
      lon: -122.3321
    } satisfies FlagSnapshot;
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      () => readyPopulationRelocation()
    );
    const populationV2 = readyPopulationHooks();
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        flag: distantFlag,
        populationV2: {
          ...populationV2,
          relocate,
        }
      }
    );
    try {
      const before = harness.gameState.getGameplayViewCircle("traveler");
      expect(before).not.toBeNull();
      expect(distanceMeters(before!.center, distantFlag))
        .toBeGreaterThan(before!.radiusM * 1_000);

      harness.clients.get("traveler")!.socket.send(
        visitDestination("very-distant-direct-flag", distantFlag.id)
      );

      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "very-distant-direct-flag",
            flagId: distantFlag.id
          })
        );
      });
      expect(relocate).toHaveBeenCalledWith(expect.objectContaining({
        area: expect.objectContaining({
          center: { lat: distantFlag.lat, lon: distantFlag.lon }
        })
      }));
      expect(harness.gameState.getPlayer("traveler")?.anchor).toEqual({
        lat: distantFlag.lat,
        lon: distantFlag.lon
      });
    } finally {
      await harness.close();
    }
  });

  it("releases a committed flag jump when optional population hooks are incomplete", async () => {
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      () => readyPopulationRelocation()
    );
    const flagAccess = permissiveFlagAccess();
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        flagAccess,
        populationV2: {
          relocate,
          releaseConnection: async () => undefined,
          prepareArea: vi.fn(async (input) => ({
            sourceId: input.source.sourceId,
            zoneIds: [],
            outcomes: []
          }))
        }
      }
    );
    const before = harness.gameState.capturePlayerViewTransition("traveler");
    try {
      harness.clients.get("traveler")!.socket.send(
        visitFlag("incomplete-population-hooks")
      );

      await vi.waitFor(() => expect(
        harness.clients.get("traveler")!.messages
      ).toContainEqual(expect.objectContaining({
        type: "FLAG_VISITED",
        requestId: "incomplete-population-hooks"
      })));
      expect(harness.gameState.capturePlayerViewTransition("traveler"))
        .not.toEqual(before);
      expect(flagAccess.executeTravel).toHaveBeenCalledOnce();
      expect(relocate.mock.calls.filter(
        ([input]) => input.trigger === "flag-travel"
      )).toHaveLength(1);
      expect(harness.runtime.hasPlayerWorldTransition("traveler")).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("keeps adjacent flag preparation and commit working", async () => {
    const adjacentFlag = {
      ...FLAG,
      lat: 35.085,
      lon: -106.651
    } satisfies FlagSnapshot;
    const prepareArea = vi.fn(async (
      input: Parameters<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >[0]
    ) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const harness = await createHarness(["traveler"], null, undefined, undefined, {
      flag: adjacentFlag,
      populationV2: {
        relocate: () => readyPopulationRelocation(),
        releaseConnection: async () => undefined,
        prepareArea,
        adoptSource: vi.fn(() => "adopted" as const),
        releaseSource: vi.fn(() => true)
      }
    });
    try {
      const authority = visibleFlagAuthority(harness.gameState, "traveler");
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "PREPARE_VISIBLE_FLAG_VISIT",
        requestId: "prepare-adjacent-flag",
        flagId: adjacentFlag.id,
        ...authority
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(prepareArea).toHaveBeenCalledWith(expect.objectContaining({
          area: expect.objectContaining({
            center: { lat: adjacentFlag.lat, lon: adjacentFlag.lon }
          })
        }));
      });

      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "COMMIT_VISIBLE_FLAG_VISIT",
        requestId: "commit-adjacent-flag",
        preparationId: "prepare-adjacent-flag",
        flagId: adjacentFlag.id,
        ...authority
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "commit-adjacent-flag",
            flagId: adjacentFlag.id
          })
        );
      });
    } finally {
      await harness.close();
    }
  });

  it("warms profiled simulation during prepare and reuses it on commit", async () => {
    const remoteFlag = {
      ...FLAG,
      lat: 36.1699,
      lon: -115.1398
    } satisfies FlagSnapshot;
    const prepareArea = vi.fn(async (
      input: Parameters<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >[0]
    ) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const adoptSource = vi.fn(() => "adopted" as const);
    const equipment = readyEquipmentService();
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        populationV2: {
          relocate: () => readyPopulationRelocation(),
          releaseConnection: async () => undefined,
          prepareArea,
          adoptSource,
          releaseSource: vi.fn(() => true)
        },
        equipment,
        flag: remoteFlag
      }
    );
    try {
      const view = harness.gameState.getGameplayViewCircle("traveler")!;
      const authority = {
        expectedConnectionGeneration: 1,
        expectedGameplayViewGeneration: view.generation,
        expectedResourceVisionRevision:
          harness.gameState.getResourceVisionRevision("traveler"),
        expectedFlagSetRevision: 1
      };
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "PREPARE_VISIBLE_FLAG_VISIT",
        requestId: "prepare-visible-flag",
        flagId: FLAG.id,
        ...authority
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(prepareArea).toHaveBeenCalledWith(expect.objectContaining({
          area: expect.objectContaining({
            center: { lat: remoteFlag.lat, lon: remoteFlag.lon }
          }),
          source: expect.objectContaining({
            sourceId: "travel:traveler:1:prepare-visible-flag",
            targetStage: "DURABLE_READY"
          })
        }));
        expect(prepareArea).toHaveBeenCalledWith(expect.objectContaining({
          source: expect.objectContaining({
            sourceId: "travel:traveler:1:prepare-visible-flag",
            targetStage: "SIMULATION_READY",
            priority: 0,
            challengeProfile: expect.objectContaining({
              currentGearLevel: 0,
              unlockedGearLevel: 0,
              balanceVersion: 2
            })
          })
        }));
      });
      expect(prepareArea).toHaveBeenCalledTimes(2);
      const preparedEquipment = equipment.runtimeSnapshot("traveler");
      if (!preparedEquipment) throw new Error("expected prepared equipment");
      vi.mocked(equipment.runtimeSnapshot).mockReturnValue({
        ...preparedEquipment,
        derivedStats: {
          ...preparedEquipment.derivedStats,
          challengeProfile: testChallengeProfile(10)
        }
      });

      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "COMMIT_VISIBLE_FLAG_VISIT",
        requestId: "commit-visible-flag",
        preparationId: "prepare-visible-flag",
        flagId: FLAG.id,
        ...authority
      } satisfies ClientMessage));

      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "commit-visible-flag",
            flagId: FLAG.id
          })
        );
      });
      expect(prepareArea).toHaveBeenCalledTimes(2);
      expect(adoptSource).toHaveBeenCalledOnce();
      expect(harness.clients.get("traveler")!.messages).not.toContainEqual(
        expect.objectContaining({
          type: "ERROR",
          requestId: "commit-visible-flag",
          code: "TRAVEL_POPULATION_PREPARING"
        })
      );
      expect(harness.gameState.getPlayer("traveler")?.anchor).toEqual({
        lat: remoteFlag.lat,
        lon: remoteFlag.lon
      });
    } finally {
      await harness.close();
    }
  });

  it("releases a committed flag Jump when the equipment profile is unavailable", async () => {
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        equipment: null,
        populationV2: {
          ...readyPopulationHooks(),
          prepareArea: vi.fn(async (input) => ({
            sourceId: input.source.sourceId,
            zoneIds: [],
            outcomes: []
          })),
          releaseSource: vi.fn(() => true),
          adoptSource: vi.fn(() => "adopted" as const)
        },
        configEnv: { POPULATION_TRAVEL_PREFLIGHT_TIMEOUT_MS: "250" }
      }
    );
    try {
      const authority = visibleFlagAuthority(harness.gameState, "traveler");
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "PREPARE_VISIBLE_FLAG_VISIT",
        requestId: "profile-unavailable-prepare",
        flagId: FLAG.id,
        ...authority
      } satisfies ClientMessage));
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "COMMIT_VISIBLE_FLAG_VISIT",
        requestId: "profile-unavailable",
        preparationId: "profile-unavailable-prepare",
        flagId: FLAG.id,
        ...authority
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(
        harness.clients.get("traveler")!.messages
      ).toContainEqual(expect.objectContaining({
        type: "FLAG_VISITED",
        requestId: "profile-unavailable"
      })));
      expect(harness.runtime.hasPlayerWorldTransition("traveler")).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("completes a Jump without polling for a temporarily unavailable profile", async () => {
    const equipment = readyEquipmentService();
    const prepareArea = vi.fn(async (
      input: Parameters<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >[0]
    ) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        equipment,
        populationV2: {
          ...readyPopulationHooks(),
          prepareArea,
          releaseSource: vi.fn(() => true),
          adoptSource: vi.fn(() => "adopted" as const)
        }
      }
    );
    try {
      const ready = equipment.runtimeSnapshot("traveler");
      if (!ready) throw new Error("expected connected equipment snapshot");
      let reads = 0;
      vi.mocked(equipment.runtimeSnapshot).mockImplementation(() => {
        reads += 1;
        return reads < 3 ? null : ready;
      });
      harness.clients.get("traveler")!.socket.send(
        visitFlag("profile-becomes-ready")
      );
      await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(1));
      expect(harness.runtime.hasPlayerWorldTransition("traveler")).toBe(false);
      await vi.waitFor(() => expect(
        harness.clients.get("traveler")!.messages
      ).toContainEqual(expect.objectContaining({
        type: "FLAG_VISITED",
        requestId: "profile-becomes-ready"
      })));
      expect(reads).toBe(1);
      expect(prepareArea.mock.calls.filter(
        ([request]) =>
          request.source.targetStage === "SIMULATION_READY"
      )).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("does not turn local gameplay or Resource Vision revisions into an adjacency rule", async () => {
    const remoteFlag = {
      ...FLAG,
      lat: 40.7128,
      lon: -74.006
    } satisfies FlagSnapshot;
    const prepareArea = vi.fn(async (
      input: Parameters<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >[0]
    ) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const adoptSource = vi.fn(() => "adopted" as const);
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        populationV2: {
          relocate: () => readyPopulationRelocation(),
          releaseConnection: async () => undefined,
          prepareArea,
          adoptSource,
          releaseSource: vi.fn(() => true)
        },
        flag: remoteFlag
      }
    );
    try {
      const view = harness.gameState.getGameplayViewCircle("traveler")!;
      const authority = {
        expectedConnectionGeneration: 1,
        expectedGameplayViewGeneration: view.generation,
        expectedResourceVisionRevision:
          harness.gameState.getResourceVisionRevision("traveler"),
        expectedFlagSetRevision: 1
      };
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "PREPARE_VISIBLE_FLAG_VISIT",
        requestId: "prepare-stale-visible-flag",
        flagId: FLAG.id,
        ...authority
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(prepareArea).toHaveBeenCalledTimes(2));

      const preparedResourceVisionRevision =
        harness.gameState.getResourceVisionRevision("traveler");
      harness.gameState.teleportPlayer("traveler", {
        lat: view.center.lat + 0.0001,
        lon: view.center.lon
      });
      expect(harness.gameState.getGameplayViewCircle("traveler")?.generation)
        .not.toBe(authority.expectedGameplayViewGeneration);
      expect(harness.gameState.getResourceVisionRevision("traveler"))
        .not.toBe(preparedResourceVisionRevision);
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "COMMIT_VISIBLE_FLAG_VISIT",
        requestId: "commit-stale-visible-flag",
        preparationId: "prepare-stale-visible-flag",
        flagId: FLAG.id,
        ...authority
      } satisfies ClientMessage));

      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "ERROR",
            requestId: "commit-stale-visible-flag",
            code: "VISIBLE_FLAG_RESOURCE_VISION_STALE"
          })
        );
      });
      expect(adoptSource).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("rejects a deleted prepared destination before relocation", async () => {
    const remoteFlag = {
      ...FLAG,
      lat: 51.5074,
      lon: -0.1278
    } satisfies FlagSnapshot;
    const prepareArea = vi.fn(async (
      input: Parameters<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >[0]
    ) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const harness = await createHarness(["traveler"], null, undefined, undefined, {
      flag: remoteFlag,
      populationV2: {
        relocate: () => readyPopulationRelocation(),
        releaseConnection: async () => undefined,
        prepareArea,
        adoptSource: vi.fn(() => "adopted" as const),
        releaseSource: vi.fn(() => true)
      }
    });
    try {
      const authority = visibleFlagAuthority(harness.gameState, "traveler");
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "PREPARE_VISIBLE_FLAG_VISIT",
        requestId: "prepare-then-delete",
        flagId: remoteFlag.id,
        ...authority
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(prepareArea).toHaveBeenCalledTimes(2));

      vi.mocked(harness.flags.getFlag).mockResolvedValue(null);
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "COMMIT_VISIBLE_FLAG_VISIT",
        requestId: "commit-deleted-flag",
        preparationId: "prepare-then-delete",
        flagId: remoteFlag.id,
        ...authority
      } satisfies ClientMessage));

      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "ERROR",
            requestId: "commit-deleted-flag",
            code: "FLAG_NOT_FOUND"
          })
        );
      });
      expect(harness.gameState.getPlayer("traveler")?.anchor).toEqual(
        playerRecord("traveler").anchor
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects a stale global flag-set revision for a distant destination", async () => {
    const remoteFlag = {
      ...FLAG,
      lat: -33.8688,
      lon: 151.2093
    } satisfies FlagSnapshot;
    const harness = await createHarness(["traveler"], null, undefined, undefined, {
      flag: remoteFlag,
      flagSetRevision: 2
    });
    try {
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "PREPARE_VISIBLE_FLAG_VISIT",
        requestId: "stale-global-flag-set",
        flagId: remoteFlag.id,
        ...visibleFlagAuthority(harness.gameState, "traveler", 1)
      } satisfies ClientMessage));

      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "ERROR",
            requestId: "stale-global-flag-set",
            code: "VISIBLE_FLAG_SET_STALE"
          })
        );
      });
    } finally {
      await harness.close();
    }
  });

  it("reports a changed toll for an otherwise accessible distant flag", async () => {
    const remoteFlag = {
      ...FLAG,
      lat: 25.7617,
      lon: -80.1918
    } satisfies FlagSnapshot;
    const flagAccess = {
      authorize: vi.fn(async () => ({
        flagId: remoteFlag.id,
        controlType: "personal",
        ownerPlayerId: remoteFlag.ownerId,
        mode: "public",
        jumpTollGold: 9n,
        accessRevision: 2n,
        travelerAccountId: "account-traveler",
        ownerAccountId: `account-${remoteFlag.ownerId}`,
        decision: {
          allowed: true,
          requestable: false,
          reasonCode: "ALLOWED_PUBLIC",
          tollGold: "9"
        }
      }))
    } as unknown as FlagAccessService;
    const harness = await createHarness(["traveler"], null, undefined, undefined, {
      flag: remoteFlag,
      flagAccess
    });
    try {
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "PREPARE_VISIBLE_FLAG_VISIT",
        requestId: "distant-toll-changed",
        flagId: remoteFlag.id,
        expectedTollGold: "6",
        ...visibleFlagAuthority(harness.gameState, "traveler")
      } satisfies ClientMessage));

      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "ERROR",
            requestId: "distant-toll-changed",
            code: "FLAG_TOLL_CHANGED",
            details: expect.objectContaining({
              currentTollGold: "9",
              requiredGold: "9"
            })
          })
        );
      });
    } finally {
      await harness.close();
    }
  });

  it("keeps inaccessible distant personal flags behind FlagAccessService", async () => {
    const remoteFlag = {
      ...FLAG,
      accessMode: "private",
      lat: 48.8566,
      lon: 2.3522
    } satisfies FlagSnapshot;
    const flagAccess = {
      authorize: vi.fn(async () => ({
        flagId: remoteFlag.id,
        controlType: "personal",
        ownerPlayerId: remoteFlag.ownerId,
        mode: "private",
        jumpTollGold: 0n,
        accessRevision: 1n,
        travelerAccountId: "account-traveler",
        ownerAccountId: `account-${remoteFlag.ownerId}`,
        decision: {
          allowed: false,
          requestable: false,
          reasonCode: "PRIVATE_OWNER_ONLY",
          tollGold: "0"
        }
      }))
    } as unknown as FlagAccessService;
    const harness = await createHarness(["traveler"], null, undefined, undefined, {
      flag: remoteFlag,
      flagAccess
    });
    try {
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "PREPARE_VISIBLE_FLAG_VISIT",
        requestId: "private-distant-flag",
        flagId: remoteFlag.id,
        ...visibleFlagAuthority(harness.gameState, "traveler")
      } satisfies ClientMessage));

      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "ERROR",
            requestId: "private-distant-flag",
            code: "PRIVATE_OWNER_ONLY"
          })
        );
      });
      expect(flagAccess.authorize).toHaveBeenCalledWith(
        remoteFlag.id,
        "traveler"
      );
    } finally {
      await harness.close();
    }
  });

  it("supports rapid distant A to B to A jumps without duplicate reservations", async () => {
    const flagA = {
      ...FLAG,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      lat: 47.6062,
      lon: -122.3321
    } satisfies FlagSnapshot;
    const flagB = {
      ...FLAG,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      lat: 51.5074,
      lon: -0.1278
    } satisfies FlagSnapshot;
    const prepareArea = vi.fn(async (
      input: Parameters<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >[0]
    ) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const adoptSource = vi.fn<
      NonNullable<PopulationV2RealtimeHooks["adoptSource"]>
    >(() => "adopted" as const);
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      () => readyPopulationRelocation()
    );
    const harness = await createHarness(["traveler"], null, undefined, undefined, {
      flags: [flagA, flagB],
      populationV2: {
        relocate,
        releaseConnection: async () => undefined,
        prepareArea,
        adoptSource,
        releaseSource: vi.fn(() => true)
      }
    });
    try {
      for (const [index, flag] of [flagA, flagB, flagA].entries()) {
        const preparationId = `rapid-distant-prepare-${index}`;
        const requestId = `rapid-distant-commit-${index}`;
        const authority = visibleFlagAuthority(harness.gameState, "traveler");
        harness.clients.get("traveler")!.socket.send(JSON.stringify({
          type: "PREPARE_VISIBLE_FLAG_VISIT",
          requestId: preparationId,
          flagId: flag.id,
          ...authority
        } satisfies ClientMessage));
        await vi.waitFor(() => {
          expect(prepareArea).toHaveBeenCalledWith(expect.objectContaining({
            source: expect.objectContaining({
              sourceId: `travel:traveler:1:${preparationId}`,
              targetStage: "DURABLE_READY"
            })
          }));
        });

        harness.clients.get("traveler")!.socket.send(JSON.stringify({
          type: "COMMIT_VISIBLE_FLAG_VISIT",
          requestId,
          preparationId,
          flagId: flag.id,
          ...authority
        } satisfies ClientMessage));
        await vi.waitFor(() => {
          expect(harness.clients.get("traveler")!.messages).toContainEqual(
            expect.objectContaining({
              type: "FLAG_VISITED",
              requestId,
              flagId: flag.id
            })
          );
        });
      }

      expect(adoptSource).toHaveBeenCalledTimes(3);
      expect(new Set(adoptSource.mock.calls.map((call) => call[0].sourceId)).size)
        .toBe(3);
      expect(relocate.mock.calls.filter(
        ([input]) => input.trigger === "flag-travel"
      )).toHaveLength(3);
      expect(harness.gameState.getPlayer("traveler")?.anchor).toEqual({
        lat: flagA.lat,
        lon: flagA.lon
      });
    } finally {
      await harness.close();
    }
  });

  it("lets B release A's optional preparation after A has already committed", async () => {
    const preparationA = createDeferred<{
      sourceId: string;
      zoneIds: [];
      outcomes: [];
    }>();
    const prepareArea = vi.fn((
      input: Parameters<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >[0]
    ) => input.source.travelId === "preparing-a"
      ? preparationA.promise
      : Promise.resolve({
          sourceId: input.source.sourceId,
          zoneIds: [] as [],
          outcomes: [] as []
        }));
    const releaseSource = vi.fn(() => true);
    const adoptSource = vi.fn(() => "adopted" as const);
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        populationV2: {
          relocate: () => readyPopulationRelocation(),
          releaseConnection: async () => undefined,
          prepareArea,
          adoptSource,
          releaseSource
        },
        equipment: readyEquipmentService(),
        configEnv: { POPULATION_TRAVEL_PREFLIGHT_ENABLED: "true" }
      }
    );
    try {
      harness.clients.get("traveler")!.socket.send(
        visitDestination("preparing-a", FLAG.id)
      );
      await vi.waitFor(() => {
        expect(prepareArea).toHaveBeenCalledWith(expect.objectContaining({
          source: expect.objectContaining({
            sourceId: "travel:traveler:1:preparing-a"
          })
        }));
      });

      harness.clients.get("traveler")!.socket.send(
        visitDestination("superseding-b", FLAG.id)
      );
      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "superseding-b"
          })
        );
      });

      expect(releaseSource).toHaveBeenCalledWith(
        "travel:traveler:1:preparing-a"
      );
      expect(adoptSource).toHaveBeenCalledWith(expect.objectContaining({
        sourceId: "travel:traveler:1:superseding-b",
        expectedTravelId: "superseding-b"
      }));
      preparationA.resolve({
        sourceId: "travel:traveler:1:preparing-a",
        zoneIds: [],
        outcomes: []
      });
      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "preparing-a"
          })
        );
      });
    } finally {
      preparationA.resolve({
        sourceId: "travel:traveler:1:preparing-a",
        zoneIds: [],
        outcomes: []
      });
      await harness.close();
    }
  });

  it("cancels optional flag preparation exactly once on disconnect during a durable retry", async () => {
      const durableRetryGate = createDeferred<void>();
      const prepareArea = vi.fn<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >(async (input) => {
        if (input.source.targetStage === "DURABLE_READY") {
          await durableRetryGate.promise;
        }
        const retry = input.source.targetStage === "DURABLE_READY";
        return retry
          ? {
              sourceId: input.source.sourceId,
              zoneIds: ["ppz2-eag1/0/0"] as const,
              outcomes: [{
                zoneId: "ppz2-eag1/0/0",
                requestedStage: input.source.targetStage,
                completedStage: input.source.targetStage === "DURABLE_READY"
                  ? "PLAN_READY" as const
                  : "DURABLE_READY" as const,
                status: "deferred" as const,
                reason: input.source.targetStage === "DURABLE_READY"
                  ? "backpressure-retry" as const
                  : "simulation-activation" as const,
                authority: null,
                durationMs: 1
              }]
            }
          : {
              sourceId: input.source.sourceId,
              zoneIds: [] as [],
              outcomes: [] as []
            };
      });
      const releaseSource = vi.fn<
        NonNullable<PopulationV2RealtimeHooks["releaseSource"]>
      >(() => true);
      const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
        () => readyPopulationRelocation()
      );
      const requestId = "disconnect-durable-retry";
      const sourceId = `travel:traveler:1:${requestId}`;
      const harness = await createHarness(
        ["traveler"],
        null,
        undefined,
        undefined,
        {
          equipment: readyEquipmentService(),
          populationV2: {
            relocate,
            releaseConnection: vi.fn(async () => undefined),
            prepareArea,
            releaseSource,
            adoptSource: vi.fn(() => "adopted" as const)
          }
        }
      );
      const before = harness.gameState.capturePlayerViewTransition("traveler");
      try {
        harness.clients.get("traveler")!.socket.send(
          visitFlag(requestId)
        );
        await vi.waitFor(() => {
          const stages = prepareArea.mock.calls.map(
            ([input]) => input.source.targetStage
          );
          expect(stages).toContain("DURABLE_READY");
        });

        harness.clients.get("traveler")!.socket.terminate();
        await vi.waitFor(() => expect(
          releaseSource.mock.calls.filter(([released]) => released === sourceId)
        ).toHaveLength(1));
        await vi.waitFor(() => expect(
          harness.runtime.hasPlayerWorldTransition("traveler")
        ).toBe(false));

        expect(releaseSource.mock.calls.filter(
          ([released]) => released === sourceId
        )).toHaveLength(1);
        expect(relocate.mock.calls.filter(
          ([input]) => input.trigger === "flag-travel"
        )).toHaveLength(1);
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({ type: "FLAG_VISITED", requestId })
        );
        const after =
          harness.gameState.capturePlayerViewTransition("traveler");
        expect(after.position).not.toEqual(before.position);
        expect(after.anchor).not.toEqual(before.anchor);
        expect(after.relocationRevision).toBe(before.relocationRevision + 1);
      } finally {
        durableRetryGate.resolve();
        await harness.close();
      }
  });

  it("does not let an old connection close cancel a newer preparation", async () => {
    const prepareArea = vi.fn<
      NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
    >(async (input) => input.source.connectionGeneration === 1
      ? {
          sourceId: input.source.sourceId,
          zoneIds: ["ppz2-eag1/0/0"] as const,
          outcomes: [{
            zoneId: "ppz2-eag1/0/0",
            requestedStage: input.source.targetStage,
            completedStage: "PLAN_READY" as const,
            status: "deferred" as const,
            reason: "backpressure-retry" as const,
            authority: null,
            durationMs: 1
          }]
        }
      : {
          sourceId: input.source.sourceId,
          zoneIds: [] as [],
          outcomes: [] as []
        });
    const releaseSource = vi.fn<
      NonNullable<PopulationV2RealtimeHooks["releaseSource"]>
    >(() => true);
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        populationV2: {
          ...readyPopulationHooks(),
          prepareArea,
          releaseSource,
          adoptSource: vi.fn(() => "adopted" as const)
        }
      }
    );
    try {
      const oldClient = harness.clients.get("traveler")!;
      oldClient.socket.send(visitFlag("old-connection-preparation"));
      await vi.waitFor(() => expect(prepareArea).toHaveBeenCalledWith(
        expect.objectContaining({
          source: expect.objectContaining({
            connectionGeneration: 1,
            travelId: "old-connection-preparation"
          })
        })
      ));

      const replacement = await harness.connectClient("traveler");
      await vi.waitFor(() => expect(releaseSource.mock.calls.filter(
        ([sourceId]) =>
          sourceId === "travel:traveler:1:old-connection-preparation"
      )).toHaveLength(1));
      harness.runtime.tick(0);
      replacement.socket.send(visitFlag("new-connection-preparation"));

      await vi.waitFor(() => expect(replacement.messages).toContainEqual(
        expect.objectContaining({
          type: "FLAG_VISITED",
          requestId: "new-connection-preparation"
        })
      ));
      expect(releaseSource.mock.calls.filter(
        ([sourceId]) =>
          sourceId === "travel:traveler:1:old-connection-preparation"
      )).toHaveLength(1);
      expect(harness.gameState.getPlayer("traveler")?.relocationRevision).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("does not let B release A after A acquires the transition", async () => {
    const persistedA = createDeferred<undefined>();
    const prepareArea = vi.fn(async (
      input: Parameters<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >[0]
    ) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const releaseSource = vi.fn(() => true);
    const adoptSource = vi.fn(() => "adopted" as const);
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        populationV2: {
          relocate: () => readyPopulationRelocation(),
          releaseConnection: async () => undefined,
          prepareArea,
          adoptSource,
          releaseSource
        },
        equipment: readyEquipmentService(),
        configEnv: { POPULATION_TRAVEL_PREFLIGHT_ENABLED: "true" }
      }
    );
    try {
      harness.persistPlayerSnapshot.mockImplementationOnce(
        () => persistedA.promise
      );
      harness.clients.get("traveler")!.socket.send(
        visitDestination("transition-owner-a", FLAG.id)
      );
      await vi.waitFor(() => {
        expect(harness.persistPlayerSnapshot).toHaveBeenCalledOnce();
      });

      harness.clients.get("traveler")!.socket.send(
        visitDestination("blocked-b", FLAG.id)
      );
      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "ERROR",
            requestId: "blocked-b",
            code: "PLAYER_WORLD_TRANSITION_PENDING"
          })
        );
      });
      expect(releaseSource).not.toHaveBeenCalledWith(
        "travel:traveler:1:transition-owner-a"
      );

      persistedA.resolve(undefined);
      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "transition-owner-a"
          })
        );
      });
      expect(adoptSource).toHaveBeenCalledWith(expect.objectContaining({
        sourceId: "travel:traveler:1:transition-owner-a",
        expectedTravelId: "transition-owner-a"
      }));
      expect(prepareArea.mock.calls.every(
        ([input]) => input.source.travelId === "transition-owner-a"
      )).toBe(true);
    } finally {
      persistedA.resolve(undefined);
      await harness.close();
    }
  });

  it("does not wait on population profiles after equipment changes", async () => {
    const firstDurable = createDeferred<{
      sourceId: string;
      zoneIds: [];
      outcomes: [];
    }>();
    let firstRequest = true;
    const prepareArea = vi.fn(async (
      input: Parameters<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >[0]
    ) => {
      if (
        firstRequest
        && input.source.targetStage === "DURABLE_READY"
      ) return firstDurable.promise;
      return {
        sourceId: input.source.sourceId,
        zoneIds: [] as [],
        outcomes: [] as []
      };
    });
    const equipment = readyEquipmentService();
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        equipment,
        populationV2: {
          ...readyPopulationHooks(),
          prepareArea,
          releaseSource: vi.fn(() => true),
          adoptSource: vi.fn(() => "adopted" as const)
        }
      }
    );
    try {
      const original = equipment.runtimeSnapshot("traveler");
      if (!original) throw new Error("expected connected equipment snapshot");
      vi.mocked(equipment.runtimeSnapshot).mockClear();
      harness.clients.get("traveler")!.socket.send(
        visitFlag("captured-profile-first")
      );
      await vi.waitFor(() => expect(
        vi.mocked(equipment.runtimeSnapshot)
      ).toHaveBeenCalled());
      const changed = {
        ...original,
        derivedStats: {
          ...original.derivedStats,
          challengeProfile: testChallengeProfile(10)
        }
      };
      vi.mocked(equipment.runtimeSnapshot).mockReturnValue(changed);
      firstDurable.resolve({
        sourceId: "travel:traveler:1:captured-profile-first",
        zoneIds: [],
        outcomes: []
      });
      await vi.waitFor(() => expect(
        harness.clients.get("traveler")!.messages
      ).toContainEqual(expect.objectContaining({
        type: "FLAG_VISITED",
        requestId: "captured-profile-first"
      })));
      const firstSimulation = prepareArea.mock.calls.find(
        ([request]) =>
          request.source.travelId === "captured-profile-first"
          && request.source.targetStage === "SIMULATION_READY"
      )?.[0];
      expect(firstSimulation).toBeUndefined();

      firstRequest = false;
      harness.clients.get("traveler")!.socket.send(
        visitFlag("captured-profile-second")
      );
      await vi.waitFor(() => expect(
        harness.clients.get("traveler")!.messages
      ).toContainEqual(expect.objectContaining({
        type: "FLAG_VISITED",
        requestId: "captured-profile-second"
      })));
      const secondSimulation = prepareArea.mock.calls.find(
        ([request]) =>
          request.source.travelId === "captured-profile-second"
          && request.source.targetStage === "SIMULATION_READY"
      )?.[0];
      expect(secondSimulation).toBeUndefined();
    } finally {
      firstDurable.resolve({
        sourceId: "travel:traveler:1:captured-profile-first",
        zoneIds: [],
        outcomes: []
      });
      await harness.close();
    }
  });

  it("reserves the exact accepted destination and adopts it at relocation", async () => {
    const prepareArea = vi.fn(async (
      input: Parameters<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >[0]
    ) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const adoptionState: {
      harness: Awaited<ReturnType<typeof createHarness>> | null;
    } = { harness: null };
    const adoptSource = vi.fn(() => {
      const harness = adoptionState.harness;
      if (!harness) throw new Error("expected initialized travel harness");
      expect(harness.gameState.currentFlagId("traveler")).toBe(FLAG.id);
      expect(harness.gameState.getPlayer("traveler")?.relocationRevision).toBe(1);
      return "adopted" as const;
    });
    const releaseSource = vi.fn(() => true);
    const populationV2: PopulationV2RealtimeHooks = {
      relocate: () => readyPopulationRelocation(),
      releaseConnection: async () => undefined,
      prepareArea,
      adoptSource,
      releaseSource
    };
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        populationV2,
        configEnv: { POPULATION_TRAVEL_PREFLIGHT_ENABLED: "true" }
      }
    );
    adoptionState.harness = harness;
    try {
      harness.clients.get("traveler")!.socket.send(
        visitDestination("exact-travel-reservation", FLAG.id)
      );
      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "exact-travel-reservation"
          })
        );
      });

      expect(prepareArea).toHaveBeenCalledTimes(1);
      expect(prepareArea).toHaveBeenCalledWith(expect.objectContaining({
        area: expect.objectContaining({
          center: { lat: FLAG.lat, lon: FLAG.lon },
          sourceType: "flag",
          sourceId: FLAG.id
        }),
        source: expect.objectContaining({
          sourceId: "travel:traveler:1:exact-travel-reservation",
          kind: "flag-travel",
          targetStage: "DURABLE_READY",
          priority: 1,
          playerId: "traveler",
          connectionGeneration: 1,
          travelId: "exact-travel-reservation"
        })
      }));
      expect(adoptSource).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  it("keeps committed authority and toll changes when optional population preparation is terminal", async () => {
    const flagAccess = permissiveFlagAccess();
    const releaseSource = vi.fn(() => true);
    const populationV2: PopulationV2RealtimeHooks = {
      relocate: () => readyPopulationRelocation(),
      releaseConnection: async () => undefined,
      prepareArea: vi.fn<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >(async (input) => ({
        sourceId: input.source.sourceId,
        zoneIds: ["ppz2-eag1/0/0"] as const,
        outcomes: [{
          zoneId: "ppz2-eag1/0/0",
          requestedStage: "DURABLE_READY" as const,
          completedStage: "PLAN_READY" as const,
          status: "stale" as const,
          reason: "stale-authority" as const,
          authority: null,
          durationMs: 3
        }]
      })),
      adoptSource: vi.fn(() => "adopted" as const),
      releaseSource
    };
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        flagAccess,
        populationV2,
        configEnv: { POPULATION_TRAVEL_PREFLIGHT_ENABLED: "true" }
      }
    );
    try {
      harness.clients.get("traveler")!.socket.send(
        visitDestination("population-not-ready", FLAG.id)
      );
      await vi.waitFor(() => expect(
        harness.clients.get("traveler")!.messages
      ).toContainEqual(expect.objectContaining({
        type: "FLAG_VISITED",
        requestId: "population-not-ready"
      })));

      expect(flagAccess.executeTravel).toHaveBeenCalledOnce();
      expect(releaseSource).toHaveBeenCalledOnce();
      expect(harness.runtime.hasPlayerWorldTransition("traveler")).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("does not start detached warming for a World Map preview", async () => {
    const destination = {
      kind: "city" as const,
      id: "22222222-2222-4222-8222-222222222222",
      name: "Water City",
      lat: 0,
      lon: -140
    };
    const worldMap = {
      snapshot: vi.fn(async () => ({
        destinations: [destination],
        serverTime: Date.now()
      }))
    } as unknown as WorldMapService;
    const prepareArea = vi.fn();
    const populationV2 = {
      relocate: vi.fn(() => readyPopulationRelocation()),
      releaseConnection: vi.fn(async () => undefined),
      prepareArea
    } satisfies PopulationV2RealtimeHooks;
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      { populationV2, worldMap }
    );
    try {
      const before = harness.gameState.capturePlayerViewTransition("traveler");
      harness.persistPlayerSnapshot.mockClear();
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "PREPARE_WORLD_MAP_TRAVEL",
        requestId: "prepare-water-city",
        destinationKind: destination.kind,
        destinationId: destination.id
      } satisfies ClientMessage));

      await vi.waitFor(() => expect(worldMap.snapshot).toHaveBeenCalled());
      expect(prepareArea).not.toHaveBeenCalled();
      expect(harness.gameState.capturePlayerViewTransition("traveler"))
        .toEqual(before);
      expect(harness.persistPlayerSnapshot).not.toHaveBeenCalled();
      expect(harness.clients.get("traveler")!.messages.some(
        (message) => message.type === "CITY_VISITED"
      )).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("allows a remote public city flag without personal access or adjacency checks", async () => {
    const cityFlag = {
      ...FLAG,
      controlType: "city" as const,
      cityId: "22222222-2222-4222-8222-222222222222",
      lat: 0,
      lon: -140,
      terrainClass: "open-water",
      biome: "open-water",
      accessMode: "public" as const,
      jumpTollGold: "0"
    };
    const city = {
      id: cityFlag.cityId,
      worldId: "main",
      worldSettlementId: "water-city",
      worldSettlementSource: "test",
      worldSourceSettlementId: "water-city",
      settlementClass: "city",
      settlementReleaseId: null,
      settlementReleaseFingerprint: null,
      name: "Water City",
      countryCode: "US",
      regionCode: null,
      founderPlayerId: "someone-else",
      mayorPlayerId: null,
      seatFlagId: "22222222-2222-4222-8222-222222222223",
      lat: 0,
      lon: -140.01,
      active: true,
      jumpable: true,
      spatialRevision: "1",
      foundingAnnexRadiusM: 350,
      createdAt: "2026-07-13T00:00:00.000Z"
    };
    const flagAccess = {
      authorize: vi.fn(async () => {
        throw new Error("city travel must not use personal access authorization");
      }),
      executeTravel: vi.fn(async () => {
        throw new Error("city travel must not execute a personal access command");
      })
    } as unknown as FlagAccessService;
    const cities = {
      listCitiesNear: vi.fn(async () => [city]),
      getMembership: vi.fn(async () => null),
      getCity: vi.fn(async (cityId: string) => cityId === city.id ? city : null)
    } as unknown as CityService;
    const prepareArea = vi.fn(async (
      input: Parameters<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >[0]
    ) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const harness = await createHarness(["outsider"], null, undefined, undefined, {
      cities,
      flagAccess,
      flag: cityFlag,
      populationV2: {
        ...readyPopulationHooks(),
        prepareArea,
        releaseSource: vi.fn(() => true),
        adoptSource: vi.fn(() => "adopted" as const)
      }
    });
    try {
      harness.clients.get("outsider")!.socket.send(
        visitDestination("visit-water-city-flag", cityFlag.id)
      );
      await vi.waitFor(() => {
        expect(harness.clients.get("outsider")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "visit-water-city-flag",
            flagId: cityFlag.id
          })
        );
      });
      expect(flagAccess.authorize).not.toHaveBeenCalled();
      expect(flagAccess.executeTravel).not.toHaveBeenCalled();
      expect(harness.gameState.getPlayer("outsider")?.anchor).toEqual({
        lat: cityFlag.lat,
        lon: cityFlag.lon
      });
      harness.clients.get("outsider")!.socket.send(JSON.stringify({
        type: "VISIT_CITY",
        requestId: "visit-water-city-center",
        cityId: city.id
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(harness.clients.get("outsider")!.messages).toContainEqual(
          expect.objectContaining({
            type: "CITY_VISITED",
            requestId: "visit-water-city-center",
            arrivalPresentation: "jump"
          })
        );
      });
      expect(harness.combat.flagArrivalProtectionUntil("outsider"))
        .toBeGreaterThan(Date.now());
      expect(harness.gameState.getPlayer("outsider")?.anchor).toEqual({
        lat: city.lat,
        lon: city.lon
      });
      expect(harness.gameState.getResourceVision("outsider")).toMatchObject({
        destinationKind: "area",
        center: { lat: city.lat, lon: city.lon },
        movementLeashRadiusM: 900,
        radiusM: 950
      });
      expect(harness.gameState.getResourceVision("outsider")?.center)
        .not.toEqual({ lat: cityFlag.lat, lon: cityFlag.lon });
      expect(cities.getMembership).toHaveBeenCalledWith("outsider");
      expect(flagAccess.authorize).not.toHaveBeenCalled();
      expect(flagAccess.executeTravel).not.toHaveBeenCalled();
      expect(prepareArea).toHaveBeenCalledWith(expect.objectContaining({
        area: expect.objectContaining({
          center: { lat: city.lat, lon: city.lon },
          sourceType: "area"
        }),
        source: expect.objectContaining({
          kind: "city-travel",
          targetStage: "DURABLE_READY"
        })
      }));
    } finally {
      await harness.close();
    }
  });

  it("keeps non-flag Auto-Follow gated on destination readiness", async () => {
    const party = partySnapshot(["leader", "follower"], ["follower"]);
    const city = {
      id: "22222222-2222-4222-8222-222222222222",
      worldId: "main",
      worldSettlementId: "party-city",
      worldSettlementSource: "test",
      worldSourceSettlementId: "party-city",
      settlementClass: "city",
      settlementReleaseId: null,
      settlementReleaseFingerprint: null,
      name: "Party City",
      countryCode: "US",
      regionCode: null,
      founderPlayerId: "someone-else",
      mayorPlayerId: null,
      seatFlagId: "22222222-2222-4222-8222-222222222223",
      lat: 35.5,
      lon: -106.5,
      active: true,
      jumpable: true,
      spatialRevision: "1",
      foundingAnnexRadiusM: 350,
      createdAt: "2026-07-13T00:00:00.000Z"
    };
    const cities = {
      listCitiesNear: vi.fn(async () => [city]),
      getMembership: vi.fn(async () => null),
      getCity: vi.fn(async (cityId: string) => cityId === city.id ? city : null)
    } as unknown as CityService;
    const followerSimulationReady = createDeferred<void>();
    const prepareArea = vi.fn<
      NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
    >(async (input) => {
      if (
        input.source.playerId === "follower"
        && input.source.targetStage === "SIMULATION_READY"
      ) {
        await followerSimulationReady.promise;
      }
      return {
        sourceId: input.source.sourceId,
        zoneIds: [],
        outcomes: []
      };
    });
    const harness = await createHarness(
      party.memberPlayerIds,
      party,
      undefined,
      undefined,
      {
        cities,
        populationV2: {
          ...readyPopulationHooks(),
          prepareArea
        },
        configEnv: { POPULATION_TRAVEL_PREFLIGHT_ENABLED: "true" }
      }
    );
    try {
      harness.clients.get("leader")!.socket.send(JSON.stringify({
        type: "VISIT_CITY",
        requestId: "party-city-readiness",
        cityId: city.id
      } satisfies ClientMessage));

      await vi.waitFor(() => {
        expect(harness.gameState.getPlayer("leader")?.anchor).toEqual({
          lat: city.lat,
          lon: city.lon
        });
        expect(prepareArea).toHaveBeenCalledWith(expect.objectContaining({
          source: expect.objectContaining({
            playerId: "follower",
            targetStage: "SIMULATION_READY"
          })
        }));
      });
      expect(harness.gameState.getPlayer("follower")?.anchor).toEqual({
        lat: 35.0844,
        lon: -106.6504
      });
      expect(harness.gameState.getPlayer("follower")?.relocationRevision).toBe(0);

      followerSimulationReady.resolve();
      await vi.waitFor(() => {
        expect(harness.gameState.getPlayer("follower")?.anchor).toEqual({
          lat: city.lat,
          lon: city.lon
        });
        expect(harness.clients.get("follower")!.messages).toContainEqual(
          expect.objectContaining({
            type: "CITY_VISITED",
            requestId: "party-follow:party-city-readiness:follower"
          })
        );
      });
    } finally {
      followerSimulationReady.resolve();
      await harness.close();
    }
  });

  it("places a three-player automatic party arrival as one shared triangle", async () => {
    const party = partySnapshot(["leader", "follower-a", "follower-b"], ["follower-a", "follower-b"]);
    const harness = await createHarness([...party.memberPlayerIds, "observer"], party);
    try {
      harness.clients.get("observer")!.socket.send(visitFlag("observer-arrives"));
      await vi.waitFor(() => expect(harness.gameState.currentFlagId("observer")).toBe(FLAG.id));
      harness.clients.get("leader")!.socket.send(visitFlag("party-triangle"));
      await vi.waitFor(() => {
        for (const playerId of party.memberPlayerIds) {
          expect(harness.gameState.currentFlagId(playerId)).toBe(FLAG.id);
          expect(harness.gameState.getPlayer(playerId)?.relocationRevision).toBe(1);
          expect(harness.clients.get(playerId)!.messages.some((message) =>
            message.type === "FLAG_VISITED"
          )).toBe(true);
        }
      });

      const positions = party.memberPlayerIds.map((playerId) => harness.gameState.getPlayer(playerId)!.position);
      for (const position of positions) {
        expect(distanceMeters(position, { lat: FLAG.lat, lon: FLAG.lon })).toBeCloseTo(75, 1);
      }
      for (let index = 0; index < positions.length; index += 1) {
        expect(distanceMeters(positions[index]!, positions[(index + 1) % positions.length]!))
          .toBeCloseTo(129.90, 1);
      }
      const initiallyBroadcastPositions = party.memberPlayerIds.map((playerId) => {
        const message = harness.clients.get(playerId)!.messages.find((candidate) =>
          candidate.type === "FLAG_VISITED"
        );
        if (message?.type !== "FLAG_VISITED") throw new Error("expected initial flag state");
        expect(message.player.relocationRevision).toBe(1);
        expect(distanceMeters(message.player, { lat: FLAG.lat, lon: FLAG.lon })).toBeCloseTo(75, 1);
        return `${message.player.lat},${message.player.lon}`;
      });
      expect(new Set(initiallyBroadcastPositions).size).toBe(3);
      expect(harness.runtime.interestFrameFor(party.memberPlayerIds).nearbyIdsByPlayer.get("leader"))
        .toEqual(new Set([...party.memberPlayerIds, "observer"]));

      for (const playerId of [...party.memberPlayerIds, "observer"]) {
        harness.runtime.replication.resetPlayer(playerId);
      }
      harness.runtime.tick(0);
      for (const viewerId of [...party.memberPlayerIds, "observer"]) {
        await vi.waitFor(() => {
          const snapshot = harness.clients.get(viewerId)!.messages.filter((message) =>
            message.type === "PLAYER_SNAPSHOT"
          ).at(-1);
          if (snapshot?.type !== "PLAYER_SNAPSHOT") throw new Error("expected replicated party state");
          for (const memberId of party.memberPlayerIds) {
            const replicated = snapshot.players.find((player) => player.playerId === memberId);
            expect(replicated).toMatchObject({
              relocationRevision: 1,
              lat: harness.gameState.getPlayer(memberId)!.position.lat,
              lon: harness.gameState.getPlayer(memberId)!.position.lon
            });
          }
        });
      }
    } finally {
      await harness.close();
    }
  });

  it("publishes leader then Auto-Follow while both population relocations remain pending", async () => {
    const party = partySnapshot(["leader", "follower"], ["follower"]);
    const leaderVisible = createDeferred<{
      status: "ready";
      pendingVisibleZoneCount: 0;
    }>();
    const followerVisible = createDeferred<{
      status: "ready";
      pendingVisibleZoneCount: 0;
    }>();
    const prepareArea = vi.fn<
      NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
    >(async (input) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      (input) => input.playerId === "leader" && input.trigger === "flag-travel"
        ? {
            visibleReady: leaderVisible.promise,
            presentationReady: leaderVisible.promise,
            completion: leaderVisible.promise.then(() => undefined),
            pendingVisibleZoneCount: () => 1
          }
        : input.playerId === "follower" && input.trigger === "party-travel"
          ? {
              visibleReady: followerVisible.promise,
              presentationReady: followerVisible.promise,
              completion: followerVisible.promise.then(() => undefined),
              pendingVisibleZoneCount: () => 1
            }
        : readyPopulationRelocation()
    );
    const harness = await createHarness(
      party.memberPlayerIds,
      party,
      undefined,
      undefined,
      {
        populationV2: {
          ...readyPopulationHooks(),
          prepareArea,
          relocate
        },
        scopedFlagSnapshots: true,
        configEnv: {
          POPULATION_TRAVEL_PREFLIGHT_ENABLED: "true",
          POPULATION_TRAVEL_OPTIONAL_ARRIVAL_SEQUENCING_ENABLED: "true"
        }
      }
    );
    try {
      for (const playerId of party.memberPlayerIds) {
        await vi.waitFor(() => expect(harness.clients.get(playerId)!.messages)
          .toContainEqual(expect.objectContaining({ type: "FLAGS_SNAPSHOT" })));
        harness.clients.get(playerId)!.messages.length = 0;
      }

      harness.clients.get("leader")!.socket.send(
        visitDestination("immediate-party-follow", FLAG.id)
      );
      await vi.waitFor(() => {
        expect(harness.gameState.currentFlagId("leader")).toBe(FLAG.id);
        expect(harness.gameState.currentFlagId("follower")).toBe(FLAG.id);
        expect(harness.runtime.hasPlayerWorldTransition("leader")).toBe(false);
        expect(harness.runtime.hasPlayerWorldTransition("follower")).toBe(false);
        expect(harness.clients.get("leader")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "immediate-party-follow"
          })
        );
        expect(harness.clients.get("follower")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "party-follow:immediate-party-follow:follower"
          })
        );
      });
      const leaderRelocationIndex = relocate.mock.calls.findIndex(
        ([input]) => input.playerId === "leader" && input.trigger === "flag-travel"
      );
      const followerRelocationIndex = relocate.mock.calls.findIndex(
        ([input]) => input.playerId === "follower" && input.trigger === "party-travel"
      );
      expect(leaderRelocationIndex).toBeGreaterThanOrEqual(0);
      expect(followerRelocationIndex).toBeGreaterThan(leaderRelocationIndex);
      expect(prepareArea.mock.calls.filter(
        ([input]) =>
          input.source.playerId === "follower"
          && input.source.targetStage === "SIMULATION_READY"
      )).toHaveLength(0);

      await vi.waitFor(() => expect(harness.clients.get("leader")!.messages)
        .toContainEqual(expect.objectContaining({
          type: "FLAGS_SNAPSHOT",
          authority: expect.objectContaining({
            relocationRevision: 1,
            finalChunk: true
          })
        })));
      await vi.waitFor(() => expect(harness.clients.get("follower")!.messages)
        .toContainEqual(expect.objectContaining({
          type: "FLAGS_SNAPSHOT",
          authority: expect.objectContaining({
            relocationRevision: 1,
            finalChunk: true
          })
        })));
      const leaderSnapshot = harness.clients.get("leader")!.messages.find(
        (message) => message.type === "FLAGS_SNAPSHOT"
          && message.authority?.scopeKind === "gameplay-circle-flags"
          && message.authority.relocationRevision === 1
      );
      const followerSnapshot = harness.clients.get("follower")!.messages.find(
        (message) => message.type === "FLAGS_SNAPSHOT"
          && message.authority?.scopeKind === "gameplay-circle-flags"
          && message.authority.relocationRevision === 1
      );
      if (
        leaderSnapshot?.type !== "FLAGS_SNAPSHOT"
        || followerSnapshot?.type !== "FLAGS_SNAPSHOT"
        || leaderSnapshot.authority?.scopeKind !== "gameplay-circle-flags"
        || followerSnapshot.authority?.scopeKind !== "gameplay-circle-flags"
      ) throw new Error("expected party flag snapshots");
      expect(leaderSnapshot.authority).toMatchObject({
        scopeKind: "gameplay-circle-flags",
        chunkIndex: 0,
        chunkCount: 1,
        finalChunk: true
      });
      expect(followerSnapshot.authority).toMatchObject({
        scopeKind: "gameplay-circle-flags",
        chunkIndex: 0,
        chunkCount: 1,
        finalChunk: true
      });
      expect(followerSnapshot.authority.connectionId)
        .not.toBe(leaderSnapshot.authority.connectionId);
      expect(followerSnapshot.authority.snapshotId)
        .not.toBe(leaderSnapshot.authority.snapshotId);
    } finally {
      leaderVisible.resolve({ status: "ready", pendingVisibleZoneCount: 0 });
      followerVisible.resolve({ status: "ready", pendingVisibleZoneCount: 0 });
      await harness.close();
    }
  });

  it("revalidates Auto-Follow authority immediately before follower commit", async () => {
    const party = partySnapshot(["leader", "follower"], ["follower"]);
    const releaseFollowerCommit = createDeferred<void>();
    let followerCommitBlocked = false;
    const flagAccess = permissiveFlagAccess();
    const executeTravel = vi.mocked(flagAccess.executeTravel);
    const executeTravelImmediately = executeTravel.getMockImplementation();
    if (!executeTravelImmediately) throw new Error("expected flag travel implementation");
    executeTravel.mockImplementation(async (input) => {
      if (input.travelerPlayerId === "follower") {
        followerCommitBlocked = true;
        await releaseFollowerCommit.promise;
      }
      return executeTravelImmediately(input);
    });
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      () => readyPopulationRelocation()
    );
    const harness = await createHarness(
      party.memberPlayerIds,
      party,
      undefined,
      undefined,
      {
        flagAccess,
        populationV2: {
          ...readyPopulationHooks(),
          relocate
        }
      }
    );
    try {
      harness.clients.get("leader")!.socket.send(
        visitDestination("authority-revalidation", FLAG.id)
      );

      await vi.waitFor(() => expect(followerCommitBlocked).toBe(true));
      expect(harness.gameState.currentFlagId("leader")).toBe(FLAG.id);
      expect(harness.gameState.currentFlagId("follower")).toBeNull();

      await harness.authority.leaveParty(
        "follower",
        "leave-during-follower-commit"
      );
      releaseFollowerCommit.resolve();
      await vi.waitFor(() =>
        expect(harness.runtime.hasPlayerWorldTransition("follower")).toBe(false)
      );

      expect(harness.gameState.currentFlagId("follower")).toBeNull();
      expect(harness.gameState.getPlayer("follower")?.relocationRevision).toBe(0);
      expect(relocate.mock.calls.filter(
        ([input]) =>
          input.playerId === "follower" && input.trigger === "party-travel"
      )).toHaveLength(0);
      expect(harness.clients.get("follower")!.messages).not.toContainEqual(
        expect.objectContaining({
          type: "FLAG_VISITED",
          requestId: "party-follow:authority-revalidation:follower"
        })
      );
    } finally {
      releaseFollowerCommit.resolve();
      await harness.close();
    }
  });

  it("lets a newer manual jump supersede a completed Auto-Follow arrival", async () => {
    const flagB = {
      ...FLAG,
      id: "55555555-5555-4555-8555-555555555555",
      name: "Follower Camp B",
      lat: FLAG.lat + 0.01,
      lon: FLAG.lon + 0.01
    } satisfies FlagSnapshot;
    const party = partySnapshot(["leader", "follower"], ["follower"]);
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      () => readyPopulationRelocation()
    );
    const harness = await createHarness(
      party.memberPlayerIds,
      party,
      undefined,
      undefined,
      {
        flags: [FLAG, flagB],
        populationV2: {
          ...readyPopulationHooks(),
          relocate
        }
      }
    );
    try {
      harness.clients.get("leader")!.socket.send(
        visitDestination("leader-follow-manual-override", FLAG.id)
      );
      await vi.waitFor(() => {
        expect(harness.gameState.currentFlagId("follower")).toBe(FLAG.id);
        expect(harness.clients.get("follower")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "party-follow:leader-follow-manual-override:follower",
            flagId: FLAG.id
          })
        );
      });

      harness.clients.get("follower")!.socket.send(
        visitDestination("follower-newer-manual-jump", flagB.id)
      );
      await vi.waitFor(() => {
        expect(harness.gameState.currentFlagId("follower")).toBe(flagB.id);
        expect(harness.gameState.getPlayer("follower")?.relocationRevision).toBe(2);
        expect(harness.clients.get("follower")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "follower-newer-manual-jump",
            flagId: flagB.id
          })
        );
      });

      await vi.waitFor(() => {
        expect(harness.runtime.hasPlayerWorldTransition("leader")).toBe(false);
        expect(harness.clients.get("leader")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "leader-follow-manual-override",
            flagId: FLAG.id
          })
        );
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(harness.gameState.currentFlagId("follower")).toBe(flagB.id);
      expect(harness.gameState.getPlayer("follower")?.relocationRevision).toBe(2);
      expect(relocate.mock.calls.filter(
        ([input]) =>
          input.playerId === "follower" && input.trigger === "party-travel"
      )).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("does not Auto-Follow a member after they leave the party", async () => {
    const flagB = {
      ...FLAG,
      id: "55555555-5555-4555-8555-555555555555",
      name: "Follower Camp B",
      lat: FLAG.lat + 0.01,
      lon: FLAG.lon + 0.01
    } satisfies FlagSnapshot;
    const party = partySnapshot(["leader", "follower"], ["follower"]);
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      () => readyPopulationRelocation()
    );
    const harness = await createHarness(
      party.memberPlayerIds,
      party,
      undefined,
      undefined,
      {
        flags: [FLAG, flagB],
        populationV2: {
          ...readyPopulationHooks(),
          relocate
        }
      }
    );
    try {
      harness.clients.get("leader")!.socket.send(
        visitDestination("leader-follow-before-party-leave", FLAG.id)
      );
      await vi.waitFor(() =>
        expect(harness.gameState.currentFlagId("follower")).toBe(FLAG.id)
      );

      harness.authority.leaveParty("follower", "leave-before-next-follow");
      expect(harness.authority.partyForPlayer("follower")).toBeNull();
      harness.clients.get("leader")!.socket.send(
        visitDestination("leader-after-party-leave", flagB.id)
      );

      await vi.waitFor(() => {
        expect(harness.gameState.currentFlagId("leader")).toBe(flagB.id);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(harness.gameState.currentFlagId("follower")).toBe(FLAG.id);
      expect(harness.gameState.getPlayer("follower")?.relocationRevision).toBe(1);
      expect(relocate.mock.calls.filter(
        ([input]) =>
          input.playerId === "follower" && input.trigger === "party-travel"
      )).toHaveLength(1);
      expect(harness.clients.get("follower")!.messages).not.toContainEqual(
        expect.objectContaining({
          type: "FLAG_VISITED",
          requestId: "party-follow:leader-after-party-leave:follower"
        })
      );
    } finally {
      await harness.close();
    }
  });

  it("does not make automatic followers wait on the leader's population profile", async () => {
    const party = partySnapshot(
      ["leader", "follower-a", "follower-b"],
      ["follower-a", "follower-b"]
    );
    const equipment = readyEquipmentService();
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      () => readyPopulationRelocation()
    );
    const harness = await createHarness(
      party.memberPlayerIds,
      party,
      undefined,
      undefined,
      {
        equipment,
        populationV2: {
          ...readyPopulationHooks(),
          relocate,
          releaseSource: vi.fn(() => true),
          adoptSource: vi.fn(() => "adopted" as const)
        }
      }
    );
    try {
      const snapshots = new Map(party.memberPlayerIds.map((playerId) => [
        playerId,
        equipment.runtimeSnapshot(playerId)
      ]));
      vi.mocked(equipment.runtimeSnapshot).mockImplementation((playerId) => {
        const snapshot = snapshots.get(playerId);
        if (!snapshot) return null;
        return {
          ...snapshot,
          derivedStats: {
            ...snapshot.derivedStats,
            challengeProfile: testChallengeProfile(
              playerId === "leader" ? 25 : 0
            )
          }
        };
      });
      relocate.mockClear();
      harness.clients.get("leader")!.socket.send(
        visitFlag("leader-profile-party")
      );
      await vi.waitFor(() => expect(
        relocate.mock.calls.filter(
          ([request]) => request.trigger === "flag-travel"
            || request.trigger === "party-travel"
        )
      ).toHaveLength(3));
      const relocations = relocate.mock.calls
        .map(([request]) => request)
        .filter((request) => request.trigger === "flag-travel"
          || request.trigger === "party-travel");
      expect(relocations.map(
        (request) => request.challengeProfile?.currentGearLevel
      )).toEqual([25, 0, 0]);
    } finally {
      await harness.close();
    }
  });

  it("does not Auto-Follow a member who disconnected before the leader commits", async () => {
    const party = partySnapshot(["leader", "follower"], ["follower"]);
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      () => readyPopulationRelocation()
    );
    const harness = await createHarness(
      party.memberPlayerIds,
      party,
      undefined,
      undefined,
      {
        populationV2: {
          ...readyPopulationHooks(),
          relocate
        }
      }
    );
    try {
      harness.clients.get("follower")!.socket.terminate();
      await vi.waitFor(() =>
        expect(harness.registry.activeConnectionIdForPlayer("follower"))
          .toBeNull()
      );

      harness.clients.get("leader")!.socket.send(
        visitFlag("leader-follower-disconnect")
      );
      await vi.waitFor(() => expect(
        harness.gameState.currentFlagId("leader")
      ).toBe(FLAG.id));

      expect(relocate.mock.calls.filter(
        ([input]) =>
          input.playerId === "follower"
          && input.trigger === "party-travel"
      )).toHaveLength(0);
      expect(harness.gameState.currentFlagId("follower")).toBeNull();
      expect(harness.gameState.getPlayer("follower")?.relocationRevision).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("uses the leader as a fee-free companion host for Auto-Follow", async () => {
    const party = partySnapshot(["leader", "follower"], ["follower"]);
    const flagAccess = permissiveFlagAccess();
    const harness = await createHarness(party.memberPlayerIds, party, undefined, undefined, { flagAccess });
    try {
      harness.clients.get("leader")!.socket.send(visitFlag("owner-free-followers-free"));
      await vi.waitFor(() => expect(harness.gameState.currentFlagId("follower")).toBe(FLAG.id));
      const calls = vi.mocked(flagAccess.executeTravel).mock.calls.map(([input]) => input);
      expect(calls.filter((input) => input.travelerPlayerId === "leader")
        .map((input) => input.companionHostPlayerId)).toEqual([undefined]);
      expect(calls.filter((input) => input.travelerPlayerId === "follower")
        .map((input) => input.companionHostPlayerId)).toContain("leader");
      const follower = harness.gameState.getPlayer("follower")!;
      expect(distanceMeters(follower.position, { lat: FLAG.lat, lon: FLAG.lon })).toBeCloseTo(75, 1);
    } finally {
      await harness.close();
    }
  });

  it("leaves a blocked follower behind while eligible arrivals remain separated", async () => {
    const party = partySnapshot(["leader", "eligible", "blocked"], ["eligible", "blocked"]);
    const harness = await createHarness(party.memberPlayerIds, party);
    try {
      const internal = harness.combat as unknown as {
        entities: Map<string, { aggressiveUntilMs: number; targetEntityId: string | null }>;
      };
      const blocked = internal.entities.get("blocked")!;
      blocked.aggressiveUntilMs = Date.now() + 60_000;
      blocked.targetEntityId = "mob:still-aggressive";

      harness.clients.get("leader")!.socket.send(visitFlag("party-partial"));
      await vi.waitFor(() => {
        expect(harness.gameState.currentFlagId("leader")).toBe(FLAG.id);
        expect(harness.gameState.currentFlagId("eligible")).toBe(FLAG.id);
        expect(harness.clients.get("blocked")!.messages.some((message) =>
          message.type === "TRAVEL_RESULT" && !message.success
        )).toBe(true);
      });

      expect(harness.gameState.currentFlagId("blocked")).toBeNull();
      expect(harness.gameState.getPlayer("blocked")?.relocationRevision).toBe(0);
      expect(distanceMeters(
        harness.gameState.getPlayer("leader")!.position,
        harness.gameState.getPlayer("eligible")!.position
      )).toBeCloseTo(150, 1);
    } finally {
      await harness.close();
    }
  });

  it("separates manual Party Travel from the leader on the same flag", async () => {
    const party = partySnapshot(["leader", "member"], []);
    const flagAccess = permissiveFlagAccess();
    const harness = await createHarness(
      party.memberPlayerIds,
      party,
      undefined,
      undefined,
      { flagAccess }
    );
    try {
      harness.clients.get("leader")!.socket.send(visitFlag("leader-arrives"));
      await vi.waitFor(() => expect(harness.gameState.currentFlagId("leader")).toBe(FLAG.id));

      harness.clients.get("member")!.socket.send(JSON.stringify({
        type: "TRAVEL_TO_PARTY_LEADER",
        requestId: "manual-member"
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.gameState.currentFlagId("member")).toBe(FLAG.id));

      expect(vi.mocked(flagAccess.executeTravel).mock.calls
        .map(([input]) => input)
        .find((input) => input.travelerPlayerId === "member"))
        .toEqual(expect.objectContaining({ companionHostPlayerId: "leader" }));

      expect(distanceMeters(
        harness.gameState.getPlayer("leader")!.position,
        harness.gameState.getPlayer("member")!.position
      )).toBeGreaterThan(149.5);
      expect(harness.authority.partyForPlayer("member")?.leaderPlayerId).toBe("leader");
    } finally {
      await harness.close();
    }
  });

  it("places a one-time invitee in a free same-flag slot without creating a party", async () => {
    const inviteService = travelInviteStub();
    const flagAccess = permissiveFlagAccess();
    const harness = await createHarness(
      ["inviter", "invitee"],
      null,
      inviteService,
      undefined,
      { flagAccess }
    );
    try {
      harness.clients.get("inviter")!.socket.send(visitFlag("inviter-arrives"));
      await vi.waitFor(() => expect(harness.gameState.currentFlagId("inviter")).toBe(FLAG.id));
      const anchor = harness.gameState.getAuthoritativeTravelAnchor("inviter")!;
      vi.mocked(inviteService.reserveAcceptance).mockResolvedValueOnce(inviteDestination(anchor));

      harness.clients.get("inviter")!.socket.send(JSON.stringify({
        type: "SEND_TRAVEL_INVITE",
        requestId: "send-once",
        targetPlayerId: "invitee"
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(inviteService.send).toHaveBeenCalledWith(expect.objectContaining({
        inviterPlayerId: "inviter",
        inviteePlayerId: "invitee",
        anchor
      })));
      expect(harness.clients.get("inviter")!.messages).toContainEqual(
        expect.objectContaining({
          type: "TRAVEL_RESULT",
          requestId: "send-once",
          kind: "invite_sent",
          success: true,
          message: "Travel Invite sent."
        })
      );

      harness.clients.get("invitee")!.socket.send(JSON.stringify({
        type: "RESPOND_TRAVEL_INVITE",
        requestId: "accept-once",
        inviteId: "22222222-2222-4222-8222-222222222222",
        response: "accept"
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.gameState.currentFlagId("invitee")).toBe(FLAG.id));

      expect(vi.mocked(flagAccess.executeTravel).mock.calls
        .map(([input]) => input)
        .find((input) => input.travelerPlayerId === "invitee"))
        .toEqual(expect.objectContaining({ companionHostPlayerId: "inviter" }));
      expect(distanceMeters(
        harness.gameState.getPlayer("inviter")!.position,
        harness.gameState.getPlayer("invitee")!.position
      )).toBeGreaterThan(149.5);
      expect(harness.authority.partyForPlayer("inviter")).toBeNull();
      expect(harness.authority.partyForPlayer("invitee")).toBeNull();
      expect(harness.gameState.sharesCompatibleFlagPresence("inviter", "invitee")).toBe(true);
      expect(harness.clients.get("invitee")!.messages).toContainEqual(expect.objectContaining({
        type: "TRAVEL_RESULT",
        requestId: "accept-once",
        kind: "invite",
        success: true
      }));
    } finally {
      await harness.close();
    }
  });

  it("publishes one committed invite result without waiting for population readiness", async () => {
    const inviteService = travelInviteStub();
    const invitePresentation = createDeferred<{
      status: "ready";
      pendingVisibleZoneCount: 0;
    }>();
    const populationV2 = {
      ...readyPopulationHooks(),
      relocate: vi.fn<PopulationV2RealtimeHooks["relocate"]>(
        (input) => input.trigger === "party-travel"
          ? {
              visibleReady: invitePresentation.promise,
              presentationReady: invitePresentation.promise,
              completion: invitePresentation.promise.then(() => undefined),
              pendingVisibleZoneCount: () => 1
            }
          : readyPopulationRelocation()
      )
    } satisfies PopulationV2RealtimeHooks;
    const harness = await createHarness(
      ["inviter", "invitee"],
      null,
      inviteService,
      undefined,
      { populationV2 }
    );
    try {
      harness.clients.get("inviter")!.socket.send(visitFlag("inviter-ready"));
      await vi.waitFor(() => expect(
        harness.gameState.currentFlagId("inviter")
      ).toBe(FLAG.id));
      const anchor = harness.gameState.getAuthoritativeTravelAnchor("inviter")!;
      vi.mocked(inviteService.reserveAcceptance).mockResolvedValueOnce(
        inviteDestination(anchor)
      );

      harness.clients.get("invitee")!.socket.send(JSON.stringify({
        type: "RESPOND_TRAVEL_INVITE",
        requestId: "accept-before-population",
        inviteId: "22222222-2222-4222-8222-222222222222",
        response: "accept"
      } satisfies ClientMessage));

      await vi.waitFor(() => expect(
        inviteService.completeAcceptance
      ).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(
        harness.clients.get("invitee")!.messages.filter(
          (message) =>
            message.type === "TRAVEL_RESULT" &&
            message.requestId === "accept-before-population" &&
            message.kind === "invite" &&
            message.success
        )
      ).toHaveLength(1));
      expect(harness.runtime.hasPlayerWorldTransition("invitee")).toBe(false);
      expect(harness.clients.get("invitee")!.messages.some(
        (message) =>
          message.type === "ERROR" &&
          message.requestId === "accept-before-population"
      )).toBe(false);
    } finally {
      invitePresentation.resolve({
        status: "ready",
        pendingVisibleZoneCount: 0
      });
      await harness.close();
    }
  });

  it("accepts a city-centered area invite without any real flag and sends the full scope", async () => {
    const inviteService = travelInviteStub();
    const harness = await createHarness(["inviter", "invitee"], null, inviteService);
    try {
      const vision = areaVision("city:ember");
      harness.gameState.applyValidatedFlagVisit("inviter", vision);
      expect(harness.gameState.currentFlagId("inviter")).toBeNull();
      const anchor = harness.gameState.getAuthoritativeTravelAnchor("inviter")!;
      vi.mocked(inviteService.reserveAcceptance).mockResolvedValueOnce(inviteDestination(anchor));

      harness.clients.get("invitee")!.socket.send(JSON.stringify({
        type: "RESPOND_TRAVEL_INVITE",
        requestId: "accept-city-area",
        inviteId: "22222222-2222-4222-8222-222222222222",
        response: "accept"
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(harness.gameState.getResourceVision("invitee")).toEqual(vision);
        expect(inviteService.completeAcceptance).toHaveBeenCalledOnce();
      });

      expect(harness.gameState.currentFlagId("invitee")).toBeNull();
      expect(distanceMeters(vision.center, harness.gameState.getPlayer("invitee")!.position))
        .toBeCloseTo(75, 1);
      expect(distanceMeters(
        harness.gameState.getPlayer("inviter")!.position,
        harness.gameState.getPlayer("invitee")!.position
      )).toBeGreaterThan(74);
      expect(harness.clients.get("invitee")!.messages.some((message) =>
        message.type === "COMBAT_SNAPSHOT"
      )).toBe(true);

      harness.runtime.tick(0);
      await vi.waitFor(() => expect(harness.clients.get("invitee")!.messages.some((message) =>
        message.type === "PLAYER_SNAPSHOT"
      )).toBe(true));
    } finally {
      await harness.close();
    }
  });

  it("sends from a developer-relocated area with currentFlagId null", async () => {
    const inviteService = travelInviteStub();
    const harness = await createHarness(["inviter", "invitee"], null, inviteService);
    try {
      harness.gameState.applyValidatedFlagVisit("inviter", areaVision("dev-teleport:cell"));
      expect(harness.gameState.currentFlagId("inviter")).toBeNull();

      harness.clients.get("inviter")!.socket.send(JSON.stringify({
        type: "SEND_TRAVEL_INVITE",
        requestId: "send-dev-area",
        targetPlayerId: "invitee"
      } satisfies ClientMessage));

      await vi.waitFor(() => expect(inviteService.send).toHaveBeenCalledWith(expect.objectContaining({
        inviterPlayerId: "inviter",
        inviteePlayerId: "invitee",
        anchor: expect.objectContaining({
          sourceType: "area",
          sourceId: "dev-teleport:cell",
          center: areaVision("dev-teleport:cell").center
        })
      })));
    } finally {
      await harness.close();
    }
  });

  it("keeps an invite valid across ordinary inviter movement", async () => {
    const inviteService = travelInviteStub();
    const harness = await createHarness(["inviter", "invitee"], null, inviteService);
    try {
      const vision = areaVision("area:movement");
      harness.gameState.applyValidatedFlagVisit("inviter", vision);
      const anchor = harness.gameState.getAuthoritativeTravelAnchor("inviter")!;
      harness.gameState.setTarget("inviter", { lat: vision.center.lat + 0.0001, lon: vision.center.lon });
      harness.gameState.tick(1);
      expect(harness.gameState.getAuthoritativeTravelAnchor("inviter")).toEqual(anchor);
      vi.mocked(inviteService.reserveAcceptance).mockResolvedValueOnce(inviteDestination(anchor));

      harness.clients.get("invitee")!.socket.send(JSON.stringify({
        type: "RESPOND_TRAVEL_INVITE",
        requestId: "accept-after-movement",
        inviteId: "22222222-2222-4222-8222-222222222222",
        response: "accept"
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(inviteService.completeAcceptance).toHaveBeenCalledOnce());
      expect(inviteService.invalidateForInviter).not.toHaveBeenCalledWith(
        "inviter",
        "The inviter is no longer in the original gameplay layer."
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects a stale invite after the inviter layer center is replaced", async () => {
    const inviteService = travelInviteStub();
    const harness = await createHarness(["inviter", "invitee"], null, inviteService);
    try {
      harness.gameState.applyValidatedFlagVisit("inviter", areaVision("area:old"));
      const staleAnchor = harness.gameState.getAuthoritativeTravelAnchor("inviter")!;
      vi.mocked(inviteService.reserveAcceptance).mockResolvedValueOnce(inviteDestination(staleAnchor));
      harness.gameState.applyValidatedFlagVisit("inviter", areaVision("area:new", {
        lat: 36.1,
        lon: -105.2
      }));

      harness.clients.get("invitee")!.socket.send(JSON.stringify({
        type: "RESPOND_TRAVEL_INVITE",
        requestId: "accept-stale",
        inviteId: "22222222-2222-4222-8222-222222222222",
        response: "accept"
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(inviteService.invalidateForInviter).toHaveBeenCalledWith(
        "inviter",
        "The inviter is no longer in the original gameplay layer."
      ));

      expect(inviteService.completeAcceptance).not.toHaveBeenCalled();
      expect(harness.gameState.getPlayer("invitee")?.relocationRevision).toBe(0);
      expect(harness.gameState.getPlayer("invitee")?.position).toEqual({
        lat: 35.0844,
        lon: -106.6504
      });
    } finally {
      await harness.close();
    }
  });

  it("safely rejects a completed Castle that the flag revalidation adapter cannot resolve", async () => {
    const kingdoms = {
      getSeatTravelDestination: vi.fn(async (seatId: string) =>
        seatId === KINGDOM_SEAT.id ? KINGDOM_SEAT : null)
    } as unknown as KingdomService;
    const harness = await createHarness(["traveler"], null, undefined, kingdoms);
    try {
      harness.clients.get("traveler")!.socket.send(visitDestination("seat-arrival", KINGDOM_SEAT.id));
      await vi.waitFor(() => expect(harness.clients.get("traveler")!.messages).toContainEqual(
        expect.objectContaining({
          type: "ERROR",
          requestId: "seat-arrival",
          code: "VISIBLE_FLAG_DESTINATION_STALE"
        })
      ));

      expect(harness.gameState.currentFlagId("traveler")).toBeNull();
      expect(harness.persistPlayerSnapshot).not.toHaveBeenCalled();
      expect(kingdoms.getSeatTravelDestination).toHaveBeenCalledWith(KINGDOM_SEAT.id);
    } finally {
      await harness.close();
    }
  });

  it("rejects pending, dissolved, or otherwise unavailable Castle destinations", async () => {
    const kingdoms = {
      getSeatTravelDestination: vi.fn(async () => null)
    } as unknown as KingdomService;
    const harness = await createHarness(["traveler"], null, undefined, kingdoms);
    try {
      harness.clients.get("traveler")!.socket.send(visitDestination("seat-unavailable", KINGDOM_SEAT.id));
      await vi.waitFor(() => expect(harness.clients.get("traveler")!.messages.some((message) =>
        message.type === "ERROR" &&
        message.requestId === "seat-unavailable" &&
        message.code === "KINGDOM_DESTINATION_UNAVAILABLE"
      )).toBe(true));

      expect(harness.gameState.currentFlagId("traveler")).toBeNull();
      expect(harness.persistPlayerSnapshot).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("rejects a forged World Map trip to another Kingdom's seat", async () => {
    const kingdoms = {
      getSeatTravelDestination: vi.fn(async (seatId: string) =>
        seatId === KINGDOM_SEAT.id ? KINGDOM_SEAT : null),
      getState: vi.fn(async () => ({ kingdom: null }))
    } as unknown as KingdomService;
    const harness = await createHarness(["traveler"], null, undefined, kingdoms);
    try {
      harness.clients.get("traveler")!.socket.send(worldMapKingdomDestination(
        "foreign-seat",
        KINGDOM_SEAT.id
      ));
      await vi.waitFor(() => expect(harness.clients.get("traveler")!.messages.some((message) =>
        message.type === "ERROR" &&
        message.requestId === "foreign-seat" &&
        message.code === "KINGDOM_DESTINATION_FORBIDDEN"
      )).toBe(true));

      expect(harness.gameState.currentFlagId("traveler")).toBeNull();
      expect(harness.persistPlayerSnapshot).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("allows World Map travel to the player's current Castle", async () => {
    const kingdoms = {
      getSeatTravelDestination: vi.fn(async (seatId: string) =>
        seatId === KINGDOM_SEAT.id ? KINGDOM_SEAT : null),
      getState: vi.fn(async () => ({
        kingdom: { id: KINGDOM_SEAT.kingdomId }
      }))
    } as unknown as KingdomService;
    const harness = await createHarness(["traveler"], null, undefined, kingdoms);
    try {
      harness.clients.get("traveler")!.socket.send(worldMapKingdomDestination(
        "own-seat",
        KINGDOM_SEAT.id
      ));
      await vi.waitFor(() => expect(harness.clients.get("traveler")!.messages.some((message) =>
        message.type === "FLAG_VISITED" &&
        message.requestId === "own-seat" &&
        message.flagId === KINGDOM_SEAT.id
      )).toBe(true));

      expect(harness.gameState.currentFlagId("traveler")).toBe(KINGDOM_SEAT.id);
      expect(harness.persistPlayerSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  it("allows only the owner to use an Atlas Shrine World Map destination", async () => {
    const shrine = {
      id: FLAG.id,
      name: "North Shrine",
      lat: FLAG.lat,
      lon: FLAG.lon,
      claim_radius_m: FLAG.claimRadiusM
    };
    const getOwnedAtlasShrine = vi.fn(async (playerId: string, flagId: string) =>
      playerId === "owner" && flagId === shrine.id ? shrine : null);
    const worldMap = { getOwnedAtlasShrine } as unknown as WorldMapService;
    const harness = await createHarness(["owner", "intruder"], null, undefined, undefined, {
      worldMap
    });
    try {
      harness.clients.get("intruder")!.socket.send(worldMapAtlasShrine(
        "forged-shrine",
        shrine.id
      ));
      await vi.waitFor(() => expect(harness.clients.get("intruder")!.messages.some(
        (message) =>
          message.type === "ERROR" &&
          message.requestId === "forged-shrine" &&
          message.code === "ATLAS_SHRINE_DESTINATION_UNAVAILABLE"
      )).toBe(true));
      expect(harness.gameState.currentFlagId("intruder")).toBeNull();

      harness.clients.get("owner")!.socket.send(worldMapAtlasShrine(
        "owned-shrine",
        shrine.id
      ));
      await vi.waitFor(() => expect(harness.clients.get("owner")!.messages.some(
        (message) =>
          message.type === "FLAG_VISITED" &&
          message.requestId === "owned-shrine" &&
          message.flagId === shrine.id
      )).toBe(true));
      expect(harness.gameState.currentFlagId("owner")).toBe(shrine.id);
      expect(getOwnedAtlasShrine).toHaveBeenCalledWith("owner", shrine.id);
      expect(getOwnedAtlasShrine.mock.calls.filter(([playerId]) => playerId === "owner"))
        .toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("rejects Atlas Shrine travel when the destination disappears before publication", async () => {
    const shrine = {
      id: FLAG.id,
      name: "North Shrine",
      lat: FLAG.lat,
      lon: FLAG.lon,
      claim_radius_m: FLAG.claimRadiusM
    };
    const getOwnedAtlasShrine = vi.fn()
      .mockResolvedValueOnce(shrine)
      .mockResolvedValueOnce(null);
    const harness = await createHarness(["owner"], null, undefined, undefined, {
      worldMap: { getOwnedAtlasShrine } as unknown as WorldMapService
    });
    try {
      harness.clients.get("owner")!.socket.send(worldMapAtlasShrine(
        "destroyed-during-travel",
        shrine.id
      ));
      await vi.waitFor(() => expect(harness.clients.get("owner")!.messages.some(
        (message) =>
          message.type === "ERROR" &&
          message.requestId === "destroyed-during-travel"
      )).toBe(true));
      expect(harness.gameState.currentFlagId("owner")).toBeNull();
      expect(harness.clients.get("owner")!.messages.some(
        (message) =>
          message.type === "FLAG_VISITED" &&
          message.requestId === "destroyed-during-travel"
      )).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("rejects pre-commit invite movement and accepts the first post-arrival move", async () => {
    const inviteService = travelInviteStub();
    const acceptanceDeferred = {
      resolve: null as ((playerIds: string[]) => void) | null
    };
    vi.mocked(inviteService.completeAcceptance).mockImplementationOnce(
      () => new Promise<string[]>((resolve) => {
        acceptanceDeferred.resolve = resolve;
      })
    );
    const harness = await createHarness(["inviter", "invitee"], null, inviteService);
    try {
      harness.clients.get("inviter")!.socket.send(visitFlag("inviter-before-buffer"));
      await vi.waitFor(() => expect(harness.gameState.currentFlagId("inviter")).toBe(FLAG.id));
      const anchor = harness.gameState.getAuthoritativeTravelAnchor("inviter")!;
      vi.mocked(inviteService.reserveAcceptance).mockResolvedValueOnce(
        inviteDestination(anchor)
      );

      harness.clients.get("invitee")!.socket.send(JSON.stringify({
        type: "RESPOND_TRAVEL_INVITE",
        requestId: "invite-buffered-arrival",
        inviteId: "22222222-2222-4222-8222-222222222222",
        response: "accept"
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(inviteService.completeAcceptance).toHaveBeenCalledOnce());
      expect(harness.runtime.hasPlayerWorldTransition("invitee")).toBe(true);
      expect(harness.clients.get("invitee")!.messages.some(
        (message) =>
          message.type === "FLAG_VISITED" &&
          message.requestId === "invite-buffered-arrival"
      )).toBe(false);

      for (const [requestId, lat] of [
        ["invite-move-old", FLAG.lat + 0.0001],
        ["invite-move-latest", FLAG.lat + 0.0002]
      ] as const) {
        harness.clients.get("invitee")!.socket.send(JSON.stringify({
          type: "MOVE_TO",
          requestId,
          boundTravelRequestId: "invite-buffered-arrival",
          lat,
          lon: FLAG.lon
        } satisfies ClientMessage));
      }
      await vi.waitFor(() => expect(
        harness.clients.get("invitee")!.messages.filter((message) =>
          message.type === "ERROR"
          && message.code === "WORLD_AUTHORITY_PREPARING"
        )
      ).toHaveLength(2));
      acceptanceDeferred.resolve?.(["inviter", "invitee"]);
      await vi.waitFor(() => expect(
        harness.runtime.hasPlayerWorldTransition("invitee")
      ).toBe(false));
      const protectionUntil = harness.combat.flagArrivalProtectionUntil("invitee");
      expect(protectionUntil).toBeGreaterThan(Date.now());
      expect(protectionUntil).toBeLessThanOrEqual(Date.now() + 10_000);
      harness.clients.get("invitee")!.socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "invite-move-after",
        lat: FLAG.lat + 0.0002,
        lon: FLAG.lon
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.runtime.commands.depth).toBe(1));
      harness.runtime.tick(0);
      expect(harness.combat.flagArrivalProtectionUntil("invitee")).toBe(protectionUntil);
      harness.runtime.tick(0.05);
      expect(harness.combat.flagArrivalProtectionUntil("invitee")).toBeNull();

      await vi.waitFor(() => expect(
        harness.clients.get("invitee")!.messages.some(
          (message) =>
            message.type === "MOVE_ACCEPTED" &&
            message.requestId === "invite-move-after"
        )
      ).toBe(true));
      const accepted = harness.clients.get("invitee")!.messages.filter(
        (message) => message.type === "MOVE_ACCEPTED"
      );
      expect(accepted).toEqual([
        expect.objectContaining({
          type: "MOVE_ACCEPTED",
          requestId: "invite-move-after"
        })
      ]);
    } finally {
      acceptanceDeferred.resolve?.(["inviter", "invitee"]);
      await harness.close();
    }
  });

  it("publishes committed arrival before exact resident combat and collectible baselines", async () => {
    const visibleActivation = createDeferred<{
      status: "ready";
      pendingVisibleZoneCount: 0;
    }>();
    const destinationTree = {
      id: "tree:travel-baseline",
      type: "wood",
      lat: FLAG.lat,
      lon: FLAG.lon,
      quantity: 4,
      state: "available",
      createdAt: "2026-07-29T18:00:00.000Z",
      harvestedAt: null,
      sourceCellId: "population-v2:travel-zone",
      waterKind: null
    } satisfies CollectibleNode;
    const collectibles = {
      resourceVisionStatus: vi.fn(async () => ({
        flagId: FLAG.id,
        layoutVersion: "test",
        status: "ready",
        radiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
        nodeCount: 1,
        waterHighlightCount: 0,
        requestedAt: "2026-07-29T18:00:00.000Z",
        generatedAt: "2026-07-29T18:00:01.000Z",
        lastError: null,
        updatedAt: "2026-07-29T18:00:01.000Z"
      } satisfies ResourceVisionStatus)),
      waterHighlightsForVision: vi.fn(async () => []),
      listAvailableInVision: vi.fn(async () => [destinationTree]),
      inventoryForPlayer: vi.fn(async () => emptyInventory("traveler"))
    } as unknown as CollectibleService;
    const populationV2 = {
      ...readyPopulationHooks(),
      relocate: vi.fn<PopulationV2RealtimeHooks["relocate"]>(
        (input) => input.trigger === "flag-travel"
          ? {
              visibleReady: visibleActivation.promise,
              presentationReady: visibleActivation.promise,
              completion: visibleActivation.promise.then(() => undefined),
              preparationGeneration: 41,
              pendingVisibleZoneCount: () => 1
            }
          : readyPopulationRelocation()
      )
    } satisfies PopulationV2RealtimeHooks;
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      { collectibles, populationV2 }
    );
    try {
      const mob = harness.combat.spawnMob({
        entityId: "wolf:resident-travel-baseline",
        archetype: "wolf",
        position: { lat: FLAG.lat, lon: FLAG.lon },
        regionCode: packageIdForPosition(FLAG),
        zoneId: zoneIdForPosition(FLAG),
        originFlagId: FLAG.id
      });
      harness.clients.get("traveler")!.socket.send(
        visitFlag("resident-baseline")
      );
      await vi.waitFor(() => expect(populationV2.relocate).toHaveBeenCalledWith(
        expect.objectContaining({
          playerId: "traveler",
          trigger: "flag-travel"
        })
      ));
      expect(harness.clients.get("traveler")!.messages).not.toContainEqual(
        expect.objectContaining({
          type: "COMBAT_SNAPSHOT",
          worldViewAuthority: expect.objectContaining({
            relocationRevision: 1
          })
        })
      );
      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "resident-baseline"
          })
        );
        expect(harness.runtime.hasPlayerWorldTransition("traveler")).toBe(false);
      });
      visibleActivation.resolve({
        status: "ready",
        pendingVisibleZoneCount: 0
      });
      await vi.waitFor(() => {
        const messages = harness.clients.get("traveler")!.messages;
        expect(messages).toContainEqual(expect.objectContaining({
          type: "COMBAT_SNAPSHOT",
          worldViewAuthority: expect.objectContaining({
            relocationRevision: 1
          })
        }));
        expect(messages).toContainEqual(expect.objectContaining({
          type: "COLLECTIBLES_SNAPSHOT",
          worldViewAuthority: expect.objectContaining({
            relocationRevision: 1
          })
        }));
      });

      const messages = harness.clients.get("traveler")!.messages;
      const combatIndex = messages.findIndex((message) =>
        message.type === "COMBAT_SNAPSHOT" &&
        message.worldViewAuthority?.relocationRevision === 1
      );
      const collectibleIndex = messages.findIndex((message, index) =>
        index > combatIndex &&
        message.type === "COLLECTIBLES_SNAPSHOT" &&
        message.worldViewAuthority?.relocationRevision === 1
      );
      const flagIndex = messages.findIndex((message) =>
        message.type === "FLAG_VISITED" &&
        message.requestId === "resident-baseline"
      );
      expect(flagIndex).toBeGreaterThanOrEqual(0);
      expect(combatIndex).toBeGreaterThan(flagIndex);
      expect(collectibleIndex).toBeGreaterThan(combatIndex);
      const combatSnapshot = messages[combatIndex];
      const collectibleSnapshot = messages[collectibleIndex];
      expect(combatSnapshot?.type === "COMBAT_SNAPSHOT"
        ? combatSnapshot.state.upserts
        : []).toContainEqual(expect.objectContaining({
          entityId: mob.entityId,
          lifeState: "alive",
          activityState: "idle"
        }));
      expect(combatSnapshot?.type === "COMBAT_SNAPSHOT"
        ? combatSnapshot.worldViewAuthority
        : null).toEqual(
          collectibleSnapshot?.type === "COLLECTIBLES_SNAPSHOT"
            ? collectibleSnapshot.worldViewAuthority
            : null
        );
      expect(combatSnapshot?.type === "COMBAT_SNAPSHOT"
        ? combatSnapshot.worldViewAuthority
        : null).toEqual(expect.objectContaining({
          playerId: "traveler",
          connectionGeneration: 1,
          relocationRevision: 1,
          resourceVisionRevision: 1,
          populationPreparationGeneration: 41
        }));
      expect(harness.combat.entity(mob.entityId)).toMatchObject({
        lifeState: "alive",
        activityState: "idle"
      });
    } finally {
      visibleActivation.resolve({
        status: "ready",
        pendingVisibleZoneCount: 0
      });
      await harness.close();
    }
  });

  it("gives two travelers scoped baselines for one shared resident actor set", async () => {
    const harness = await createHarness(["traveler", "companion"], null);
    try {
      const mob = harness.combat.spawnMob({
        entityId: "wolf:shared-resident",
        archetype: "wolf",
        position: { lat: FLAG.lat, lon: FLAG.lon },
        regionCode: packageIdForPosition(FLAG),
        zoneId: zoneIdForPosition(FLAG),
        originFlagId: FLAG.id
      });
      for (const playerId of ["traveler", "companion"]) {
        harness.clients.get(playerId)!.socket.send(
          visitFlag(`shared-baseline-${playerId}`)
        );
      }
      await vi.waitFor(() => {
        for (const playerId of ["traveler", "companion"]) {
          expect(harness.clients.get(playerId)!.messages).toContainEqual(
            expect.objectContaining({
              type: "FLAG_VISITED",
              requestId: `shared-baseline-${playerId}`
            })
          );
        }
      });
      for (const playerId of ["traveler", "companion"]) {
        const snapshot = harness.clients.get(playerId)!.messages.find(
          (message) =>
            message.type === "COMBAT_SNAPSHOT" &&
            message.worldViewAuthority?.relocationRevision === 1
        );
        expect(snapshot?.type === "COMBAT_SNAPSHOT"
          ? snapshot.worldViewAuthority?.playerId
          : null).toBe(playerId);
        expect(snapshot?.type === "COMBAT_SNAPSHOT"
          ? snapshot.state.upserts
          : []).toContainEqual(expect.objectContaining({
            entityId: mob.entityId
          }));
      }
      expect(harness.combat.entity(mob.entityId)).not.toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("publishes one newest-authority combat baseline across 100 hot A-B hops", async () => {
    const flagB = {
      ...FLAG,
      id: "55555555-5555-4555-8555-555555555555",
      name: "Nearby Camp B",
      lat: FLAG.lat + 0.003,
      lon: FLAG.lon + 0.003
    } satisfies FlagSnapshot;
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      () => readyPopulationRelocation()
    );
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        flags: [FLAG, flagB],
        populationV2: {
          ...readyPopulationHooks(),
          relocate,
        }
      }
    );
    try {
      const actors = [FLAG, flagB].map((flag, index) =>
        harness.combat.spawnMob({
          entityId: `wolf:hot-hop-${index}`,
          archetype: "wolf",
          position: { lat: flag.lat, lon: flag.lon },
          regionCode: packageIdForPosition(flag),
          zoneId: zoneIdForPosition(flag),
          originFlagId: flag.id
        })
      );
      const activeCombatantsBefore =
        harness.combat.metricsSnapshot().activeCombatants;
      for (let hop = 0; hop < 100; hop += 1) {
        const destination = hop % 2 === 0 ? FLAG : flagB;
        const requestId = `hot-hop-${hop}`;
        harness.clients.get("traveler")!.socket.send(
          visitDestination(requestId, destination.id)
        );
        await vi.waitFor(() => expect(
          harness.clients.get("traveler")!.messages
        ).toContainEqual(expect.objectContaining({
          type: "FLAG_VISITED",
          requestId
        })));
      }

      const travelSnapshots = harness.clients.get("traveler")!.messages.filter(
        (message) =>
          message.type === "COMBAT_SNAPSHOT" &&
          (message.worldViewAuthority?.relocationRevision ?? 0) > 0
      );
      expect(travelSnapshots).toHaveLength(100);
      expect(travelSnapshots.map((message) =>
        message.type === "COMBAT_SNAPSHOT"
          ? message.worldViewAuthority?.relocationRevision
          : null
      )).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
      for (let hop = 0; hop < travelSnapshots.length; hop += 1) {
        const snapshot = travelSnapshots[hop];
        expect(snapshot?.type === "COMBAT_SNAPSHOT"
          ? snapshot.state.upserts
          : []).toContainEqual(expect.objectContaining({
            entityId: actors[hop % 2]!.entityId
          }));
      }
      expect(relocate.mock.calls.filter(
        ([input]) => input.trigger === "flag-travel"
      )).toHaveLength(100);
      expect(harness.runtime.hasPlayerWorldTransition("traveler")).toBe(false);
      expect(harness.combat.metricsSnapshot().activeCombatants)
        .toBe(activeCombatantsBefore);
      expect(actors.map((actor) => harness.combat.entity(actor.entityId)?.entityId))
        .toEqual(actors.map((actor) => actor.entityId));
    } finally {
      await harness.close();
    }
  }, 15_000);

  it("does not publish a stale combat baseline when readiness authority changes after arrival", async () => {
    const visibleActivation = createDeferred<{
      status: "ready";
      pendingVisibleZoneCount: 0;
    }>();
    const populationV2 = {
      ...readyPopulationHooks(),
      relocate: vi.fn<PopulationV2RealtimeHooks["relocate"]>(
        (input) => input.trigger === "flag-travel"
          ? {
              visibleReady: visibleActivation.promise,
              presentationReady: visibleActivation.promise,
              completion: visibleActivation.promise.then(() => undefined),
              preparationGeneration: 31,
              pendingVisibleZoneCount: () => 1
            }
          : readyPopulationRelocation()
      )
    } satisfies PopulationV2RealtimeHooks;
    const kingdoms = {
      getSeatTravelDestination: vi.fn(async (seatId: string) =>
        seatId === KINGDOM_SEAT.id ? KINGDOM_SEAT : null),
      getState: vi.fn(async () => ({
        kingdom: { id: KINGDOM_SEAT.kingdomId }
      }))
    } as unknown as KingdomService;
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      kingdoms,
      { populationV2 }
    );
    try {
      harness.clients.get("traveler")!.socket.send(
        worldMapKingdomDestination(
          "stale-world-map-arrival",
          KINGDOM_SEAT.id
        )
      );
      await vi.waitFor(() => expect(populationV2.relocate).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "flag-travel" })
      ));
      await vi.waitFor(() => expect(
        harness.runtime.hasPlayerWorldTransition("traveler")
      ).toBe(false));
      const arrival = harness.clients.get("traveler")!.messages.find(
        (message) =>
          message.type === "FLAG_VISITED" &&
          message.requestId === "stale-world-map-arrival"
      );
      if (arrival?.type !== "FLAG_VISITED") {
        throw new Error("expected committed flag arrival");
      }
      const currentVision = harness.gameState.getResourceVision("traveler");
      if (!currentVision) throw new Error("expected committed resource vision");
      harness.gameState.setResourceVision("traveler", currentVision);
      const currentResourceVisionRevision =
        harness.gameState.getResourceVisionRevision("traveler");
      expect(currentResourceVisionRevision).toBeGreaterThan(
        arrival.resourceVisionRevision
      );
      visibleActivation.resolve({
        status: "ready",
        pendingVisibleZoneCount: 0
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(harness.clients.get("traveler")!.messages).toContainEqual(
        expect.objectContaining({
          type: "FLAG_VISITED",
          requestId: "stale-world-map-arrival",
          flagId: KINGDOM_SEAT.id,
          resourceVisionRevision: arrival.resourceVisionRevision
        })
      );
      expect(harness.clients.get("traveler")!.messages).not.toContainEqual(
        expect.objectContaining({
          type: "COMBAT_SNAPSHOT",
          worldViewAuthority: expect.objectContaining({
            relocationRevision: 1,
            populationPreparationGeneration: 31
          })
        })
      );
    } finally {
      visibleActivation.resolve({
        status: "ready",
        pendingVisibleZoneCount: 0
      });
      await harness.close();
    }
  });

  it("releases committed flag travel before visible readiness without waiting for prepared-only work", async () => {
    const listCitiesNear = vi.fn(async () => []);
    const getCityMembership = vi.fn(async () => null);
    const cities = {
      listCitiesNear,
      getMembership: getCityMembership
    } as unknown as CityService;
    const listBuiltNear = vi.fn(async () => []);
    const manorPresence = {
      load: vi.fn(async () => null),
      status: vi.fn(async () => null),
      listBuiltNear
    } as unknown as ManorPresenceService;
    const visibleActivation = createDeferred<{
      status: "ready";
      pendingVisibleZoneCount: 0;
    }>();
    const preparedOnlyCompletion = createDeferred<void>();
    let preparedOnlySettled = false;
    void preparedOnlyCompletion.promise.then(() => {
      preparedOnlySettled = true;
    });
    const destinationPreparation = createDeferred<{
      sourceId: string;
      zoneIds: [];
      outcomes: [];
    }>();
    let destinationPreparationSettled = false;
    void destinationPreparation.promise.then(() => {
      destinationPreparationSettled = true;
    });
    const populationV2 = {
      relocate: vi.fn<PopulationV2RealtimeHooks["relocate"]>(
        (input) => input.trigger === "flag-travel"
          ? {
              visibleReady: visibleActivation.promise,
              presentationReady: visibleActivation.promise,
              completion: preparedOnlyCompletion.promise,
              pendingVisibleZoneCount: () => 1
            }
          : readyPopulationRelocation()
      ),
      releaseConnection: vi.fn(async () => undefined),
      prepareArea: vi.fn(() => destinationPreparation.promise),
      adoptSource: vi.fn(() => "adopted" as const),
      releaseSource: vi.fn(() => true)
    } satisfies PopulationV2RealtimeHooks;
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        cities,
        manorPresence,
        populationV2,
        configEnv: { POPULATION_TRAVEL_PREFLIGHT_ENABLED: "true" }
      }
    );
    try {
      await vi.waitFor(() => expect(populationV2.relocate).toHaveBeenCalledWith(
        expect.objectContaining({
          playerId: "traveler",
          relocationRevision: 0,
          trigger: "world-entry"
        })
      ));
      const worldEntryRelocation = populationV2.relocate.mock.calls.find(
        ([input]) => input.trigger === "world-entry"
      )?.[0];
      expect(worldEntryRelocation?.resourceVisionRevision).toBe(
        harness.gameState.getResourceVisionRevision("traveler")
      );
      await vi.waitFor(() => expect(getCityMembership).toHaveBeenCalledOnce());
      listCitiesNear.mockClear();
      const bootstrapCitySnapshots = harness.clients.get("traveler")!.messages
        .filter((message) => message.type === "CITIES_SNAPSHOT").length;
      const bootstrapManorSnapshots = harness.clients.get("traveler")!.messages
        .filter((message) => message.type === "MANORS_SNAPSHOT").length;
      const startedAt = performance.now();
      harness.clients.get("traveler")!.socket.send(visitFlag("cold-arrival"));
      await vi.waitFor(() => expect(populationV2.prepareArea).toHaveBeenCalledWith(
        expect.objectContaining({
          source: expect.objectContaining({
            sourceId: "travel:traveler:1:cold-arrival",
            targetStage: "DURABLE_READY"
          })
        })
      ));
      await vi.waitFor(() => expect(populationV2.relocate.mock.calls.filter(
        ([input]) => input.trigger === "flag-travel"
      )).toHaveLength(1));
      await vi.waitFor(() => {
        expect(harness.runtime.hasPlayerWorldTransition("traveler")).toBe(false);
        expect(harness.clients.get("traveler")!.messages.some(
          (message) =>
            message.type === "FLAG_VISITED" &&
            message.requestId === "cold-arrival"
        )).toBe(true);
      });
      const arrival = harness.clients.get("traveler")!.messages.find(
        (message) =>
          message.type === "FLAG_VISITED" &&
          message.requestId === "cold-arrival"
      );
      if (arrival?.type !== "FLAG_VISITED") {
        throw new Error("expected committed flag arrival");
      }
      expect(arrival.resourceVisionRevision).toBeGreaterThan(0);
      const releaseElapsedMs = performance.now() - startedAt;
      expect(releaseElapsedMs).toBeLessThan(1_000);
      expect(destinationPreparationSettled).toBe(false);
      expect(preparedOnlySettled).toBe(false);
      visibleActivation.resolve({
        status: "ready",
        pendingVisibleZoneCount: 0
      });
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "first-cold-move",
        boundTravelRequestId: "cold-arrival",
        lat: FLAG.lat + 0.0001,
        lon: FLAG.lon
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.runtime.commands.depth).toBe(1));
      expect(harness.runtime.bufferedTransitionMoveRequestId("traveler")).toBeNull();
      await vi.waitFor(() => {
        expect(listCitiesNear).toHaveBeenCalledOnce();
        expect(listBuiltNear).toHaveBeenCalled();
        expect(harness.clients.get("traveler")!.messages
          .filter((message) => message.type === "CITIES_SNAPSHOT").length)
          .toBeGreaterThan(bootstrapCitySnapshots);
        expect(harness.clients.get("traveler")!.messages
          .filter((message) => message.type === "MANORS_SNAPSHOT").length)
          .toBeGreaterThan(bootstrapManorSnapshots);
      });
      harness.runtime.tick(0);
      await vi.waitFor(() => expect(harness.clients.get("traveler")!.messages.some(
        (message) =>
          message.type === "MOVE_ACCEPTED" &&
          message.requestId === "first-cold-move"
      )).toBe(true));
      expect(populationV2.relocate).toHaveBeenCalledWith(expect.objectContaining({
        playerId: "traveler",
        connectionId: expect.any(String),
        relocationRevision: 1,
        resourceVisionRevision: arrival.resourceVisionRevision,
        trigger: "flag-travel"
      }));
      expect(harness.clients.get("traveler")!.messages).not.toContainEqual(
        expect.objectContaining({
          type: "ERROR",
          code: "WORLD_AUTHORITY_PREPARING"
        })
      );
    } finally {
      visibleActivation.resolve({ status: "ready", pendingVisibleZoneCount: 0 });
      destinationPreparation.resolve({
        sourceId: "travel:traveler:1:cold-arrival",
        zoneIds: [],
        outcomes: []
      });
      preparedOnlyCompletion.resolve();
      await harness.close();
      await vi.waitFor(() => expect(populationV2.releaseConnection).toHaveBeenCalled());
    }
  });

  it("publishes arrival immediately while keeping optional cold work behind visible population", async () => {
    const listCitiesNear = vi.fn(async () => []);
    const listBuiltNear = vi.fn(async () => []);
    const visibleActivation = createDeferred<{
      status: "ready";
      pendingVisibleZoneCount: 0;
    }>();
    const populationV2 = {
      ...readyPopulationHooks(),
      relocate: vi.fn<PopulationV2RealtimeHooks["relocate"]>(
        (input) => input.trigger === "flag-travel"
          ? {
              visibleReady: visibleActivation.promise,
              presentationReady: visibleActivation.promise,
              completion: visibleActivation.promise.then(() => undefined),
              pendingVisibleZoneCount: () => 1
            }
          : readyPopulationRelocation()
      )
    } satisfies PopulationV2RealtimeHooks;
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        cities: {
          listCitiesNear,
          getMembership: vi.fn(async () => null)
        } as unknown as CityService,
        manorPresence: {
          load: vi.fn(async () => null),
          status: vi.fn(async () => null),
          listBuiltNear
        } as unknown as ManorPresenceService,
        populationV2,
        configEnv: {
          POPULATION_TRAVEL_PREFLIGHT_ENABLED: "false",
          POPULATION_TRAVEL_OPTIONAL_ARRIVAL_SEQUENCING_ENABLED: "true"
        }
      }
    );
    try {
      await vi.waitFor(() => expect(populationV2.relocate).toHaveBeenCalled());
      listCitiesNear.mockClear();
      listBuiltNear.mockClear();
      harness.clients.get("traveler")!.socket.send(
        visitFlag("sequenced-arrival")
      );
      await vi.waitFor(() => expect(populationV2.relocate).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "flag-travel" })
      ));
      await vi.waitFor(() => {
        expect(harness.runtime.hasPlayerWorldTransition("traveler")).toBe(false);
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "sequenced-arrival"
          })
        );
      });
      expect(listCitiesNear).not.toHaveBeenCalled();
      expect(listBuiltNear).not.toHaveBeenCalled();

      visibleActivation.resolve({
        status: "ready",
        pendingVisibleZoneCount: 0
      });
      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "sequenced-arrival"
          })
        );
        expect(listCitiesNear).toHaveBeenCalledOnce();
        expect(listBuiltNear).toHaveBeenCalledOnce();
      });
    } finally {
      visibleActivation.resolve({
        status: "ready",
        pendingVisibleZoneCount: 0
      });
      await harness.close();
    }
  });

  it("releases committed travel and flags while visible population remains pending", async () => {
    const remoteFlag = {
      ...FLAG,
      lat: 64.1466,
      lon: -21.9426
    } satisfies FlagSnapshot;
    const visibleActivation = createDeferred<{
      status: "ready";
      pendingVisibleZoneCount: 0;
    }>();
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      (input) => input.trigger === "flag-travel"
        ? {
            visibleReady: visibleActivation.promise,
            presentationReady: visibleActivation.promise,
            completion: Promise.resolve(),
            pendingVisibleZoneCount: () => 2
          }
        : readyPopulationRelocation()
    );
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        populationV2: {
          ...readyPopulationHooks(),
          relocate,
        },
        flag: remoteFlag,
        configEnv: { RESOURCE_ENVIRONMENT_BATCH_TIMEOUT_MS: "500" }
      }
    );
    try {
      harness.clients.get("traveler")!.socket.send(
        visitDestination("timeout-arrival", remoteFlag.id)
      );
      await vi.waitFor(() => expect(relocate.mock.calls.filter(
        ([input]) => input.trigger === "flag-travel"
      )).toHaveLength(1));
      await vi.waitFor(() => {
        expect(harness.runtime.hasPlayerWorldTransition("traveler")).toBe(false);
        expect(harness.clients.get("traveler")!.messages.some(
          (message) =>
            message.type === "FLAG_VISITED" &&
            message.requestId === "timeout-arrival"
        )).toBe(true);
      });
      await new Promise((resolve) => setTimeout(resolve, 550));
      expect(harness.runtime.hasPlayerWorldTransition("traveler")).toBe(false);
      expect(harness.clients.get("traveler")!.messages.some(
        (message) =>
          message.type === "FLAG_VISITED" &&
          message.requestId === "timeout-arrival"
      )).toBe(true);

      visibleActivation.resolve({
        status: "ready",
        pendingVisibleZoneCount: 0
      });
      await vi.waitFor(() => {
        expect(harness.runtime.hasPlayerWorldTransition("traveler")).toBe(false);
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "timeout-arrival"
          })
        );
      });
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "move-after-visible-timeout",
        boundTravelRequestId: "timeout-arrival",
        lat: remoteFlag.lat + 0.0001,
        lon: remoteFlag.lon
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.runtime.commands.depth).toBe(1));
      harness.runtime.tick(0);
      await vi.waitFor(() => expect(harness.clients.get("traveler")!.messages.some(
        (message) =>
          message.type === "MOVE_ACCEPTED" &&
          message.requestId === "move-after-visible-timeout"
      )).toBe(true));
      expect(relocate.mock.calls.filter(
        ([input]) => input.trigger === "flag-travel"
      )).toHaveLength(1);
    } finally {
      visibleActivation.resolve({ status: "ready", pendingVisibleZoneCount: 0 });
      await harness.close();
    }
  });

  it("publishes arrival before exact distant resources and preserves harvested and depleted state", async () => {
    const remoteFlag = {
      ...FLAG,
      lat: 35.6762,
      lon: 139.6503
    } satisfies FlagSnapshot;
    const resourceReady = createDeferred<ResourceVisionStatus | null>();
    const readyAt = "2026-07-29T20:00:00.000Z";
    const availableTree = {
      id: "tree-available",
      type: "wood",
      lat: remoteFlag.lat,
      lon: remoteFlag.lon,
      quantity: 1,
      state: "available",
      createdAt: "2026-07-29T18:00:00.000Z",
      harvestedAt: null,
      sourceCellId: "population-v2:remote-zone",
      waterKind: null
    } satisfies CollectibleNode;
    const depletedMine = {
      id: "mine-depleted",
      nodeType: "stone_mine",
      lat: remoteFlag.lat,
      lon: remoteFlag.lon,
      yieldItemId: "stone",
      yieldQuantity: 1,
      state: "depleted",
      authorityRevision: 12,
      readyAt,
      timerVisibility: "visible"
    } satisfies RepeatableResourceNode;
    const prepareResourceVision = vi.fn(async () => null);
    const collectibles = {
      prepareResourceVision,
      resourceVisionStatus: vi.fn(async () => resourceReady.promise),
      waterHighlightsForVision: vi.fn(async () => []),
      listAvailableInVision: vi.fn(async () => [availableTree]),
      inventoryForPlayer: vi.fn(async () => emptyInventory("traveler"))
    } as unknown as CollectibleService;
    const repeatableResources = {
      activeSessionForPlayer: vi.fn(async () => null),
      listInVision: vi.fn(async () => [depletedMine])
    } as unknown as RepeatableResourceService;
    const prepareArea = vi.fn(async (
      input: Parameters<
        NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
      >[0]
    ) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const harness = await createHarness(["traveler"], null, undefined, undefined, {
      flag: remoteFlag,
      collectibles,
      repeatableResources,
      populationV2: {
        relocate: () => readyPopulationRelocation(),
        releaseConnection: async () => undefined,
        prepareArea,
        adoptSource: vi.fn(() => "adopted" as const),
        releaseSource: vi.fn(() => true)
      }
    });
    try {
      const authority = visibleFlagAuthority(harness.gameState, "traveler");
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "PREPARE_VISIBLE_FLAG_VISIT",
        requestId: "prepare-distant-resources",
        flagId: remoteFlag.id,
        ...authority
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(prepareResourceVision).toHaveBeenCalledWith(
          expect.objectContaining({
            resourceVision: expect.objectContaining({
              flagId: remoteFlag.id,
              center: { lat: remoteFlag.lat, lon: remoteFlag.lon }
            })
          })
        );
      });

      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "COMMIT_VISIBLE_FLAG_VISIT",
        requestId: "commit-distant-resources",
        preparationId: "prepare-distant-resources",
        flagId: remoteFlag.id,
        ...authority
      } satisfies ClientMessage));
      await vi.waitFor(() =>
        expect(vi.mocked(collectibles.resourceVisionStatus)).toHaveBeenCalled());
      expect(harness.clients.get("traveler")!.messages).toContainEqual(
        expect.objectContaining({
          type: "FLAG_VISITED",
          requestId: "commit-distant-resources"
        })
      );
      expect(harness.clients.get("traveler")!.messages).not.toContainEqual(
        expect.objectContaining({
          type: "COLLECTIBLES_SNAPSHOT",
          worldViewAuthority: expect.objectContaining({
            relocationRevision: 1
          })
        })
      );

      resourceReady.resolve({
        flagId: remoteFlag.id,
        layoutVersion: "test",
        status: "ready",
        radiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
        nodeCount: 2,
        waterHighlightCount: 0,
        requestedAt: "2026-07-29T18:00:00.000Z",
        generatedAt: "2026-07-29T18:00:01.000Z",
        lastError: null,
        updatedAt: "2026-07-29T18:00:01.000Z"
      });
      await vi.waitFor(() => {
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "COLLECTIBLES_SNAPSHOT",
            nodes: [availableTree],
            repeatableNodes: [depletedMine],
            worldViewAuthority: expect.objectContaining({
              relocationRevision: 1
            })
          })
        );
        expect(harness.clients.get("traveler")!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: "commit-distant-resources",
            flagId: remoteFlag.id
          })
        );
      });
      const snapshot = harness.clients.get("traveler")!.messages.find(
        (message) =>
          message.type === "COLLECTIBLES_SNAPSHOT"
          && message.worldViewAuthority?.relocationRevision === 1
      );
      expect(snapshot?.type === "COLLECTIBLES_SNAPSHOT"
        ? snapshot.nodes.map((node) => node.id)
        : []).not.toContain("tree-harvested");
      expect(snapshot?.type === "COLLECTIBLES_SNAPSHOT"
        ? snapshot.repeatableNodes[0]?.readyAt
        : null).toBe(readyAt);
      expect(repeatableResources.listInVision).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ flagId: remoteFlag.id }),
        "traveler"
      );
    } finally {
      resourceReady.resolve(null);
      await harness.close();
    }
  });

  it("releases a Jump after one optional retryable destination result", async () => {
    let durableAttempts = 0;
    let simulationAttempts = 0;
    const prepareArea = vi.fn<
      NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
    >(async (input) => {
      if (input.source.targetStage === "DURABLE_READY") {
        durableAttempts += 1;
      } else {
        simulationAttempts += 1;
      }
      return input.source.targetStage === "DURABLE_READY"
        && durableAttempts === 1
      ? {
          sourceId: input.source.sourceId,
          zoneIds: ["ppz2-eag1/0/0"] as const,
          outcomes: [{
            zoneId: "ppz2-eag1/0/0",
            requestedStage: "DURABLE_READY" as const,
            completedStage: "PLAN_READY" as const,
            status: "deferred" as const,
            reason: "backpressure-retry" as const,
            authority: null,
            durationMs: 3
          }]
        }
      : {
          sourceId: input.source.sourceId,
          zoneIds: [],
          outcomes: []
        };
    });
    const releaseSource = vi.fn(() => true);
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      () => readyPopulationRelocation()
    );
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      {
        populationV2: {
          relocate,
          releaseConnection: vi.fn(async () => undefined),
          prepareArea,
          releaseSource,
          adoptSource: vi.fn(() => "adopted" as const)
        }
      }
    );
    try {
      harness.clients.get("traveler")!.socket.send(
        visitFlag("retryable-preparation")
      );
      await vi.waitFor(() => expect(harness.clients.get("traveler")!.messages.some(
        (message) =>
          message.type === "FLAG_VISITED" &&
          message.requestId === "retryable-preparation"
      )).toBe(true));
      await vi.waitFor(() => expect(
        harness.runtime.hasPlayerWorldTransition("traveler")
      ).toBe(false));
      expect(relocate.mock.calls.filter(
        ([input]) => input.trigger === "flag-travel"
      )).toHaveLength(1);
      expect(releaseSource).toHaveBeenCalledWith(
        "travel:traveler:1:retryable-preparation"
      );
      expect(new Set(prepareArea.mock.calls.map(
        ([input]) => input.source.sourceId
      ))).toEqual(new Set([
        "travel:traveler:1:retryable-preparation"
      ]));
      expect(durableAttempts).toBe(1);
      expect(simulationAttempts).toBe(0);
      expect(harness.gameState.getPlayer("traveler")?.relocationRevision).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("does not retry ten optional persistent preparations before releasing arrival", async () => {
    const playerIds = Array.from(
      { length: 10 },
      (_, index) => `pressure-${index}`
    );
    const attemptsBySource = new Map<string, number>();
    const activeSources = new Set<string>();
    let backendCalls = 0;
    let maxQueueDepth = 0;
    const prepareArea = vi.fn<
      NonNullable<PopulationV2RealtimeHooks["prepareArea"]>
    >(async (input) => {
      backendCalls += 1;
      const sourceId = input.source.sourceId;
      activeSources.add(sourceId);
      maxQueueDepth = Math.max(maxQueueDepth, activeSources.size);
      attemptsBySource.set(sourceId, (attemptsBySource.get(sourceId) ?? 0) + 1);
      return {
        sourceId,
        zoneIds: ["ppz2-eag1/0/0"] as const,
        outcomes: [{
          zoneId: "ppz2-eag1/0/0",
          requestedStage: "DURABLE_READY" as const,
          completedStage: "PLAN_READY" as const,
          status: "deferred" as const,
          reason: "backpressure-retry" as const,
          authority: null,
          durationMs: 1
        }]
      };
    });
    const releasedSources: string[] = [];
    const releaseSource = vi.fn<
      NonNullable<PopulationV2RealtimeHooks["releaseSource"]>
    >((sourceId) => {
      releasedSources.push(sourceId);
      return activeSources.delete(sourceId);
    });
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      () => readyPopulationRelocation()
    );
    const harness = await createHarness(
      playerIds,
      null,
      undefined,
      undefined,
      {
        populationV2: {
          relocate,
          releaseConnection: vi.fn(async () => undefined),
          prepareArea,
          releaseSource,
          adoptSource: vi.fn(() => "adopted" as const)
        },
        configEnv: {
          POPULATION_TRAVEL_PREFLIGHT_TIMEOUT_MS: "3250"
        }
      }
    );
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout"]
    });
    try {
      for (const playerId of playerIds) {
        harness.clients.get(playerId)!.socket.send(
          visitFlag(`pressure-${playerId}`)
        );
      }
      await vi.advanceTimersByTimeAsync(3_300);
      await Promise.resolve();

      expect([...attemptsBySource.values()]).toHaveLength(10);
      expect([...attemptsBySource.values()].every(
        (attempts) => attempts === 1
      )).toBe(true);
      expect(backendCalls).toBe(
        [...attemptsBySource.values()].reduce(
          (total, attempts) => total + attempts,
          0
        )
      );
      expect(maxQueueDepth).toBe(10);
      expect(new Set(releasedSources)).toEqual(
        new Set(attemptsBySource.keys())
      );
      expect(releasedSources).toHaveLength(10);
      expect(activeSources.size).toBe(0);
      expect(relocate.mock.calls.filter(
        ([input]) => input.trigger === "flag-travel"
      )).toHaveLength(10);
      for (const playerId of playerIds) {
        expect(harness.clients.get(playerId)!.messages).toContainEqual(
          expect.objectContaining({
            type: "FLAG_VISITED",
            requestId: `pressure-${playerId}`
          })
        );
      }
      console.info("population retry pressure", {
        attempts: Object.fromEntries(attemptsBySource),
        backendCalls,
        maxQueueDepth,
        releases: releasedSources.length,
        finalSourceCount: activeSources.size
      });
    } finally {
      vi.useRealTimers();
      await harness.close();
    }
  }, 15_000);

  it("schedules administrative population relocation with the active websocket identity", async () => {
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>((input) => {
      void input;
      return readyPopulationRelocation();
    });
    const populationV2 = {
      relocate,
      releaseConnection: vi.fn(async () => undefined)
    } satisfies PopulationV2RealtimeHooks;
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      { populationV2 }
    );

    try {
      await vi.waitFor(() => expect(relocate).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "world-entry" })
      ));
      const worldEntry = relocate.mock.calls.find(
        ([input]) => input.trigger === "world-entry"
      )?.[0];
      if (!worldEntry) throw new Error("expected world-entry relocation");
      relocate.mockClear();

      const destination = { lat: 35.081, lon: -106.621 };
      harness.gameState.teleportPlayer("traveler", destination);
      const teleportVisionRevision =
        harness.gameState.getResourceVisionRevision("traveler");
      expect(harness.realtime.schedulePopulationRelocation("traveler")).toBe(true);
      await vi.waitFor(() => expect(relocate).toHaveBeenCalledOnce());

      const scheduled = relocate.mock.calls[0]?.[0];
      if (!scheduled) throw new Error("expected administrative relocation");
      expect(scheduled).toMatchObject({
        playerId: "traveler",
        connectionId: worldEntry.connectionId,
        connectionGeneration: worldEntry.connectionGeneration,
        area: expect.objectContaining({
          center: destination,
          certifiedVisibleRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
          preparedRadiusM: DEFAULT_FLAG_PREPARE_RADIUS_M,
          sourceType: "player_anchor"
        }),
        relocationRevision: 1,
        resourceVisionRevision: teleportVisionRevision,
        trigger: "administrative-relocation"
      });
      expect(scheduled.isCurrent()).toBe(true);

      harness.gameState.teleportPlayer("traveler", {
        lat: destination.lat + 0.001,
        lon: destination.lon
      });
      expect(scheduled.isCurrent()).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("never relocates Population V2 or gameplay vision after a 450m-plus walk", async () => {
    const relocate = vi.fn<PopulationV2RealtimeHooks["relocate"]>(
      () => readyPopulationRelocation()
    );
    const populationV2 = {
      relocate,
      releaseConnection: vi.fn(async () => undefined)
    } satisfies PopulationV2RealtimeHooks;
    const harness = await createHarness(
      ["traveler"],
      null,
      undefined,
      undefined,
      { populationV2 }
    );

    try {
      await vi.waitFor(() => expect(relocate).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "world-entry" })
      ));
      relocate.mockClear();
      const start = harness.gameState.getPlayer("traveler")!.position;
      const before = harness.gameState.capturePlayerViewTransition("traveler");
      harness.clients.get("traveler")!.socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "population-anchor-fixed",
        lat: start.lat + 0.005,
        lon: start.lon
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.runtime.commands.depth).toBe(1));
      harness.runtime.tick(1_000);
      await vi.waitFor(() =>
        expect(harness.gameState.getPlayer("traveler")?.target).toBeNull()
      );
      await Promise.resolve();
      expect(relocate).not.toHaveBeenCalled();
      const after = harness.gameState.capturePlayerViewTransition("traveler");
      expect(distanceMeters(before.position, after.position)).toBeGreaterThan(450);
      expect(after.anchor).toEqual(before.anchor);
      expect(after.resourceVision?.center).toEqual(before.resourceVision?.center);
      expect(after.relocationRevision).toBe(before.relocationRevision);
      expect(after.viewGeneration).toBe(before.viewGeneration);
      expect(after.resourceVisionRevision).toBe(before.resourceVisionRevision);
    } finally {
      await harness.close();
    }
  });
});

function partySnapshot(memberPlayerIds: string[], autoFollowPlayerIds: string[]): PartySnapshot {
  return {
    partyId: "party-1",
    leaderPlayerId: "leader",
    memberPlayerIds,
    allowTravel: true,
    autoFollowPlayerIds,
    revision: 1
  };
}

async function createHarness(
  playerIds: readonly string[],
  party: PartySnapshot | null,
  travelInvites?: TravelInviteService,
  kingdoms?: KingdomService,
  options: {
    cities?: CityService;
    manorPresence?: ManorPresenceService;
    populationV2?: PopulationV2RealtimeHooks;
    worldMap?: WorldMapService;
    flagAccess?: FlagAccessService;
    legendaryBirdEvents?: LegendaryBirdEventService;
    equipment?: EquipmentService | null;
    collectibles?: CollectibleService;
    repeatableResources?: RepeatableResourceService;
    flag?: FlagSnapshot;
    flags?: readonly FlagSnapshot[];
    flagSetRevision?: number | (() => number);
    scopedFlagSnapshots?: boolean;
    configEnv?: Record<string, string>;
  } = {}
) {
  const app = Fastify();
  const config = loadConfig({ NODE_ENV: "test", ...options.configEnv });
  const logger = createLogger("test");
  const registry = new ConnectionRegistry();
  const gameState = new GameState(config, logger);
  const authority = new InMemoryPartyAuthority();
  if (party) authority.loadSnapshots([party]);
  const auth = {
    sessionCookieName: "aa_session_dev",
    assertOrigin: vi.fn(),
    authenticateSession: vi.fn(async (token: string | null) => {
      const playerId = token?.replace(/^token-/, "");
      if (!playerId) return null;
      return {
        sessionId: `session-${playerId}`,
        account: {
          id: `account-${playerId}`,
          status: "active",
          trustTier: "new",
          riskScore: 0,
          createdAt: new Date(),
          lastLoginAt: null
        },
        player: { id: playerId, accountId: `account-${playerId}`, displayName: playerId },
        deviceInstallationId: `device-${playerId}`,
        csrfToken: "csrf"
      };
    }),
    developerCapabilities: vi.fn(() => []),
    recordConnectionEvent: vi.fn(async () => undefined),
    requireGameplayReady: vi.fn()
  } as unknown as AuthService;
  const persistPlayerSnapshot = vi.fn(async (snapshot: PlayerSnapshot) => {
    void snapshot;
  });
  const persistPlayerSnapshotInTransaction = vi.fn(async (
    client: unknown,
    snapshot: PlayerSnapshot
  ) => {
    void client;
    void snapshot;
  });
  const fakeTravelHungerResult = {
    replayed: false,
    cost: 1,
    hungerBefore: 2_000,
    hungerAfter: 1_999,
    baseCapacity: 2_000
  } as const;
  const playerService = {
    loadPlayer: vi.fn(async (playerId: string) => playerRecord(playerId)),
    markOnline: vi.fn(async () => undefined),
    persistPlayerSnapshot,
    persistPlayerSnapshotInTransaction,
    persistTravelSnapshot: vi.fn(async (snapshot: PlayerSnapshot) => {
      await persistPlayerSnapshot(snapshot);
      return fakeTravelHungerResult;
    }),
    persistTravelSnapshotInTransaction: vi.fn(async (
      _client: unknown,
      snapshot: PlayerSnapshot
    ) => {
      await persistPlayerSnapshotInTransaction(_client, snapshot);
      return fakeTravelHungerResult;
    }),
    markOffline: vi.fn(async () => undefined)
  } as unknown as PlayerService;
  const playerLocations = {
    load: vi.fn(async () => null),
    commitPortalTransition: vi.fn()
  } as unknown as PlayerLocationService;
  const travelFlags = options.flags ?? [options.flag ?? FLAG];
  const currentFlagSetRevision = () =>
    typeof options.flagSetRevision === "function"
      ? options.flagSetRevision()
      : options.flagSetRevision ?? 1;
  const flags = {
    listFlags: vi.fn(async () => [...travelFlags]),
    getFlag: vi.fn(async (flagId: string) =>
      travelFlags.find((flag) => flag.id === flagId) ?? null),
    currentFlagSetRevision: vi.fn(async () => currentFlagSetRevision()),
    streamFlagSnapshot: vi.fn(async (
      onChunk: Parameters<FlagService["streamFlagSnapshot"]>[0]
    ) => {
      const flagSetRevision = currentFlagSetRevision();
      const completed = await onChunk({
        flags: [...travelFlags],
        flagSetRevision,
        chunkIndex: 0,
        finalChunk: true
      });
      return {
        flagSetRevision,
        chunksPublished: completed ? 1 : 0,
        flagsPublished: completed ? travelFlags.length : 0,
        completed
      };
    })
  } as unknown as FlagService;
  const combat = new CombatEngine({
    tickRateHz: config.SERVER_TICK_HZ,
    interestRadiusM: config.COMBAT_INTEREST_RADIUS_M,
    playerMovementSpeedMps: config.PLAYER_SPEED_MPS,
    getAuthoritativeViewCircle: (playerId) => gameState.getGameplayViewCircle(playerId),
    isPlayerAuthorityActive: (playerId, accountId, connectionId) =>
      registry.isActiveConnection(accountId, connectionId) &&
      registry.isActivePlayerConnection(playerId, connectionId),
    movePlayerToward: (playerId, target) => gameState.setCombatTarget(playerId, target),
    stopPlayer: (playerId) => gameState.stopPlayer(playerId)
  });
  const profiles = {
    getOrCreate: vi.fn(async (playerId: string) => ({
      playerId,
      maxHealth: 100,
      currentHealth: 100,
      baseAttackDamage: 10
    })),
    persistProfiles: vi.fn(async () => undefined)
  } as unknown as CombatProfileService;
  const runtime = new WorldRuntime(config, registry, gameState, combat, logger);
  const cities = options.cities
    ? {
        ...options.cities,
        districtBenefits: options.cities.districtBenefits ?? {
          refreshRuntime: vi.fn(async () => null),
          releaseRuntime: vi.fn()
        }
      } as CityService
    : undefined;

  await app.register(cookie);
  installAuthGuard(app, config, auth);
  const realtime = await registerRealtime({
      infrastructure: {
          app: app,
          registry: registry,
          logger: logger,
          config: config,
      },
      authority: {
          gameState: gameState,
          flagService: flags,
          playerService: playerService,
          auth: auth,
          worldRuntime: runtime,
          flagAccess: options.flagAccess ?? permissiveFlagAccess()
      },
      capabilities: {
          combat: combat,
          combatProfiles: profiles,
          equipment:
            options.equipment === null
              ? undefined
              : options.equipment ?? readyEquipmentService(),
          cities,
          collectibles: options.collectibles,
          kingdoms: kingdoms,
          partyAuthority: authority,
          manorPresence: options.manorPresence,
          repeatableResources: options.repeatableResources,
          worldMap: options.worldMap,
          travelInvites: travelInvites,
          legendaryBirdEvents: options.legendaryBirdEvents,
          playerLocations,
          portals: new PortalRegistry()
      },
      operations: {
          populationV2: options.populationV2 ?? readyPopulationHooks()
      }
  });
  await app.ready();

  const clients = new Map<string, {
    socket: Awaited<ReturnType<typeof app.injectWS>>;
    messages: ServerMessage[];
  }>();
  const connectClient = async (playerId: string) => {
    const protocolQuery = new URLSearchParams({
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.id]: "ash-atlas",
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.minimum]: "3",
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.maximum]: "3",
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.capabilities]: [
        "scoped-flag-snapshots",
        "viewport-flag-loading-v1"
      ].join(",")
    });
    const websocketPath = options.scopedFlagSnapshots
      ? `/ws?${protocolQuery.toString()}`
      : "/ws";
    const socket = await app.injectWS(websocketPath, {
      headers: { origin: config.CLIENT_ORIGIN, cookie: `aa_session_dev=token-${playerId}` }
    });
    const messages: ServerMessage[] = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      messages.push(message);
    });
    socket.send(JSON.stringify({ type: "HELLO" } satisfies ClientMessage));
    await vi.waitFor(() => expect(messages).toContainEqual(
      expect.objectContaining({ type: "WELCOME" })
    ));
    const client = { socket, messages };
    clients.set(playerId, client);
    return client;
  };
  for (const playerId of playerIds) {
    await connectClient(playerId);
  }

  return {
    gameState,
    combat,
    runtime,
    realtime,
    registry,
    authority,
    flags,
    persistPlayerSnapshot,
    clients,
    connectClient,
    async close() {
      for (const client of clients.values()) client.socket.terminate();
      await app.close();
    }
  };
}

function readyEquipmentService(): EquipmentService {
  type RuntimeSnapshot = NonNullable<
    ReturnType<EquipmentService["runtimeSnapshot"]>
  >;
  const runtimeSnapshots = new Map<string, RuntimeSnapshot>();
  const snapshotFor = (playerId: string) => {
    const active = emptyEquipmentSlots(null);
    return {
      snapshotVersion: 2,
      balanceVersion: 2,
      playerId,
      characterLevel: 0,
      repairMessage: null,
      instances: [],
      active,
      readiedWeaponSlot: "melee",
      activeKitIndex: null,
      kits: [],
      inventoryRevision: 0,
      activeRevision: 0,
      checkpointRevision: 0,
      derivedStats: resolveEquipmentCombatStats({
        context: "pve",
        characterLevel: 0,
        classId: "warrior",
        classRank: 0,
        loadout: {
          active,
          readiedWeaponSlot: "melee"
        }
      }),
      weapon: null,
      chest: null,
      totalAttackPowerBonus: 0,
      totalDefenseBonus: 0
    } as RuntimeSnapshot;
  };
  return {
    ensureStarterLoadout: vi.fn(async () => undefined),
    runtimeSnapshot: vi.fn((playerId: string) =>
      runtimeSnapshots.get(playerId) ?? null),
    connectRuntime: vi.fn(async (playerId: string) => {
      const snapshot = snapshotFor(playerId);
      runtimeSnapshots.set(playerId, snapshot);
      return snapshot;
    }),
    flushAndRelease: vi.fn(async (playerId: string) => {
      runtimeSnapshots.delete(playerId);
    })
  } as unknown as EquipmentService;
}

function permissiveFlagAccess(withTransactionClient = false): FlagAccessService {
  const authorizationFor = (travelerPlayerId: string) => ({
    flagId: FLAG.id,
    controlType: "personal",
    ownerPlayerId: FLAG.ownerId,
    mode: "public" as const,
    publicTollGold: 0n,
    travelerAccountId: `account-${travelerPlayerId}`,
    ownerAccountId: `account-${FLAG.ownerId}`,
    decision: {
      allowed: true,
      requestable: false,
      reasonCode: travelerPlayerId === FLAG.ownerId ? "ALLOWED_OWNER" as const : "ALLOWED_PUBLIC" as const,
      tollGold: "0"
    }
  });

  return {
    authorize: vi.fn(async (_flagId: string, travelerPlayerId: string) =>
      authorizationFor(travelerPlayerId)),
    executeTravel: vi.fn(async (input) => {
      const authorization = authorizationFor(input.travelerPlayerId);
      return {
        authorization,
        value: await input.commit(withTransactionClient ? {} as never : undefined as never, authorization),
        replayed: false,
        travelerGoldBalance: null,
        ownerGoldBalance: null
      };
    })
  } as unknown as FlagAccessService;
}

function visitFlag(requestId: string): string {
  return visitDestination(requestId, FLAG.id);
}

function visitDestination(requestId: string, flagId: string): string {
  return JSON.stringify({
    type: "VISIT_FLAG",
    requestId,
    flagId,
    source: "visible_map"
  } satisfies ClientMessage);
}

function visibleFlagAuthority(
  gameState: GameState,
  playerId: string,
  expectedFlagSetRevision = 1
) {
  return {
    expectedConnectionGeneration: 1,
    expectedGameplayViewGeneration:
      gameState.getGameplayViewCircle(playerId)!.generation,
    expectedResourceVisionRevision:
      gameState.getResourceVisionRevision(playerId),
    expectedFlagSetRevision
  };
}

function worldMapKingdomDestination(requestId: string, seatId: string): string {
  return JSON.stringify({
    type: "VISIT_WORLD_MAP_KINGDOM",
    requestId,
    seatId
  } satisfies ClientMessage);
}

function worldMapAtlasShrine(requestId: string, flagId: string): string {
  return JSON.stringify({
    type: "VISIT_WORLD_MAP_ATLAS_SHRINE",
    requestId,
    flagId
  } satisfies ClientMessage);
}

function playerRecord(playerId: string): PlayerRecord {
  return {
    playerId,
    username: playerId,
    displayColor: "#38bdf8",
    regionCode: "NM",
    position: { lat: 35.0844, lon: -106.6504 },
    anchor: { lat: 35.0844, lon: -106.6504 },
    moveLeashRadiusM: 900,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date("2026-07-13T00:00:00.000Z")
  };
}

function travelInviteStub(): TravelInviteService {
  return {
    inboxForPlayer: vi.fn(async () => []),
    send: vi.fn(async () => ({
      inviteId: "22222222-2222-4222-8222-222222222222",
      playerIds: ["invitee", "inviter"],
      replayed: false
    })),
    reserveAcceptance: vi.fn(async () => {
      throw new Error("Travel Invite destination was not configured");
    }),
    releaseAcceptance: vi.fn(async () => undefined),
    completeAcceptance: vi.fn(async () => ["inviter", "invitee"]),
    invalidateForInviter: vi.fn(async () => []),
    decline: vi.fn(async () => ["inviter", "invitee"]),
    cancel: vi.fn(async () => ["inviter", "invitee"])
  } as unknown as TravelInviteService;
}

function inviteDestination(anchor: NonNullable<ReturnType<GameState["getAuthoritativeTravelAnchor"]>>) {
  return {
    inviteId: "22222222-2222-4222-8222-222222222222",
    inviterPlayerId: "inviter",
    inviteePlayerId: "invitee",
    inviterSessionId: "session-inviter",
    anchor,
    expiresAt: "2099-01-01T00:10:00.000Z"
  };
}

function areaVision(flagId: string, center = { lat: 35.09, lon: -106.66 }): ResourceVision {
  return {
    flagId,
    flagName: "Authoritative area",
    destinationKind: "area",
    center,
    movementLeashRadiusM: 900,
    paddingM: 250,
    radiusM: 1_150
  };
}

function emptyInventory(playerId: string): PlayerInventorySnapshot {
  return {
    playerId,
    revision: 0,
    items: [],
    totals: {
      wood: 0,
      stone: 0,
      coal: 0,
      iron: 0,
      sulfur: 0,
      iron_bar: 0,
      venomsteel_bar: 0,
      venomsteel_core: 0,
      fire_feather: 0, tempest_quill: 0, ice_feather: 0,
      fire_bar: 0, fire_core: 0, lightning_bar: 0, lightning_core: 0, ice_bar: 0, ice_core: 0,
      food: 0,
      ore: 0,
      water: 0,
      leather: 0,
      deer_hide: 0,
      hog_hide: 0,
      wolf_pelt: 0,
      bear_hide: 0,
    alligator_hide: 0,
    squid_flesh: 0,
    crab_carapace: 0,
    raw_meat: 0,
    shell: 0,
      giving_berry: 0,
      balsam_resin: 0,
      crude_oil: 0,
      jellyfish_venom: 0, brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0,
      crystal: 0, pearl: 0, atlas_shrine_shard: 0,
      enchantment_stone: 0
    }
  };
}

function readyPopulationRelocation() {
  return {
    visibleReady: Promise.resolve({
      status: "ready" as const,
      pendingVisibleZoneCount: 0
    }),
    presentationReady: Promise.resolve({
      status: "ready" as const,
      pendingVisibleZoneCount: 0
    }),
    completion: Promise.resolve(),
    pendingVisibleZoneCount: () => 0
  };
}

function readyPopulationHooks(): PopulationV2RealtimeHooks {
  return {
    relocate: () => readyPopulationRelocation(),
    releaseConnection: async () => undefined,
    prepareArea: async (input) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }),
    adoptSource: () => "adopted",
    releaseSource: () => true
  };
}

function testChallengeProfile(level: number): EquipmentChallengeProfile {
  return {
    balanceVersion: 2,
    currentGearLevel: level,
    unlockedGearLevel: level,
    tier: level >= 25 ? "legendary" : level >= 10 ? "rare" : "common",
    contributors: {
      melee: level,
      chest: level,
      secondary: level
    }
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
