import type {
  ClientMessage,
  DeveloperTestFlagKind,
  EquipmentMetal,
  DeveloperTestUnitType,
  MobAppearanceVariant,
  MobArchetypeKey,
  PlantBookKey,
  InventoryItemType
} from "@ash-atlas/shared";
import { requestIdCrypto as crypto } from "../../requestId.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export class DeveloperClient {
  constructor(private readonly port: ClientCommandPort) {}

  devTeleport(lat: number, lon: number): string | null {
      const requestId = crypto.randomUUID();
      return this.send({ type: "DEV_TELEPORT", requestId, lat, lon }) ? requestId : null;
    }

  devVisitMine(mineId: string): string | null {
      const requestId = crypto.randomUUID();
      return this.send({ type: "DEV_VISIT_MINE", requestId, mineId }) ? requestId : null;
    }

  spawnMob(archetype: MobArchetypeKey, lat: number, lon: number, appearanceVariant?: MobAppearanceVariant): boolean {
      return this.send({
        type: "DEV_SPAWN_MOB",
        requestId: crypto.randomUUID(),
        archetype,
        ...(appearanceVariant ? { appearanceVariant } : {}),
        lat,
        lon
      });
    }

  spawnPlant(plantKey: PlantBookKey, lat: number, lon: number): boolean {
    return this.send({
      type: "DEV_SPAWN_PLANT",
      requestId: crypto.randomUUID(),
      plantKey,
      lat,
      lon
    });
  }

  spawnTestFlag(targetKind: DeveloperTestFlagKind, lat: number, lon: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "DEV_SPAWN_TEST_FLAG",
      requestId,
      targetKind,
      lat,
      lon
    }) ? requestId : null;
  }

  spawnTestUnit(unitType: DeveloperTestUnitType, lat: number, lon: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "DEV_SPAWN_TEST_UNIT",
      requestId,
      unitType,
      lat,
      lon
    }) ? requestId : null;
  }

  spawnGoblinVillage(lat: number, lon: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "DEV_SPAWN_GOBLIN_VILLAGE",
      requestId,
      lat,
      lon
    }) ? requestId : null;
  }

  spawnDungeonEntrance(templateId: string, lat: number, lon: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "DEV_SPAWN_DUNGEON_ENTRANCE",
      requestId,
      templateId,
      lat,
      lon
    }) ? requestId : null;
  }

  foundCapital(input: { requestId: string; dryRun: boolean; leaveCurrentCity: boolean }): boolean {
    return this.send({ type: "DEV_FOUND_CAPITAL", ...input });
  }

  collapseTerritory(input: { requestId: string; kind: "city" | "kingdom"; targetId?: string }): boolean {
    return this.send({ type: "DEV_COLLAPSE_TERRITORY", ...input });
  }

  listDungeonEntrances(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DEV_LIST_DUNGEON_ENTRANCES", requestId }) ? requestId : null;
  }

  deleteDungeonEntrance(entranceId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DEV_DELETE_DUNGEON_ENTRANCE", requestId, entranceId })
      ? requestId
      : null;
  }

  listGoblinVillages(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DEV_LIST_GOBLIN_VILLAGES", requestId }) ? requestId : null;
  }

  deleteGoblinVillage(cityId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DEV_DELETE_GOBLIN_VILLAGE", requestId, cityId })
      ? requestId
      : null;
  }

  clearMobs(): boolean {
      return this.send({
        type: "DEV_CLEAR_MOBS",
        requestId: crypto.randomUUID()
      });
    }

  /** Reset the dev-entrance dungeon run this player is in (replay the Tilted Vault from scratch). */
  resetDungeonRun(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DEV_RESET_DUNGEON_RUN", requestId }) ? requestId : null;
  }

  clearPlants(): boolean {
    return this.send({
      type: "DEV_CLEAR_PLANTS",
      requestId: crypto.randomUUID()
    });
  }

  advanceAllGreenhouseCrops(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DEV_ADVANCE_ALL_GREENHOUSE_CROPS", requestId }) ? requestId : null;
  }

  /** Developer App: builds the caller's manor where they stand (no territory or wood). */
  buildDevManor(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DEV_BUILD_MANOR", requestId }) ? requestId : null;
  }

  /** Developer App: an active Salon in the city the caller stands in (or that city's existing Salon). */
  buildDevSalon(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DEV_BUILD_SALON", requestId }) ? requestId : null;
  }

  grantMetalEquipment(kind: "sword" | "chest", metal: EquipmentMetal): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DEV_GRANT_METAL_EQUIPMENT", requestId, kind, metal }) ? requestId : null;
  }

  waterAllGreenhouseCrops(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DEV_WATER_ALL_GREENHOUSE_CROPS", requestId }) ? requestId : null;
  }

  resetOwnDevClassCooldowns(): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "RESET_OWN_DEV_CLASS_COOLDOWNS",
        requestId
      }) ? requestId : null;
    }

  grantOwnDevelopmentAssets(
      grant: {
        gold?: number;
        cityCoins?: number;
        glimmer?: number;
        lumen?: number;
        materials?: readonly { itemId: InventoryItemType; quantity: number }[];
      },
      requestId = crypto.randomUUID()
    ): string | null {
      const sent = this.send({
        type: "GRANT_OWN_DEV_ASSETS",
        requestId,
        gold: grant.gold === undefined ? undefined : String(grant.gold),
        cityCoins: grant.cityCoins === undefined
          ? undefined
          : String(grant.cityCoins),
        glimmer: grant.glimmer === undefined ? undefined : String(grant.glimmer),
        lumen: grant.lumen === undefined ? undefined : String(grant.lumen),
        materials: grant.materials?.map((material) => ({ itemId: material.itemId, quantity: String(material.quantity) }))
      });
      return sent ? requestId : null;
    }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}
