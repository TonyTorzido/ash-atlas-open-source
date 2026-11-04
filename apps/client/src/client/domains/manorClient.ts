import {
  portalIds,
  type FurnaceRecipeId,
  type KitchenRecipeId,
  type ClientMessage,
  type EnchantmentStoneVariant,
  type EquipmentMetal
} from "@ash-atlas/shared";
import { requestIdCrypto as crypto } from "../../requestId.js";
import { selectedRuntimePngContentPack } from "../../map/runtimePngAssetUrl.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import type { PortalCommandPort } from "../portalCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

/** Category picks the player saw (R6/R7) and the high-grade confirmation (R5). */
export type StationStartOptions = Readonly<{
  categoryPicks?: { itemId: string; quantity: number }[][];
  confirmHighGrade?: boolean;
}>;

export class ManorClient {
  private activeManorId: string | null = null;
  private activeGreenhouseId: string | null = null;
  constructor(
    private readonly port: ClientCommandPort,
    private readonly portals?: PortalCommandPort
  ) {}

  jumpToManor(
      manorId: string,
      requestId = crypto.randomUUID()
    ): string | null {
      return this.send({ type: "JUMP_TO_MANOR", requestId, manorId }) ? requestId : null;
    }

  enterManor(manorId: string): string | null {
      this.activeManorId = manorId;
      return this.portals?.use(portalIds.manorWorldToMain(manorId)) ?? null;
    }

  cancelManorEntry(): boolean {
      return this.portals?.cancel() ?? false;
    }

  requestManorGuests(manorId: string): boolean {
      return this.send({ type: "REQUEST_MANOR_GUESTS", requestId: crypto.randomUUID(), manorId });
    }

  kickManorGuest(manorId: string, targetPlayerId: string): boolean {
      return this.send({ type: "KICK_MANOR_GUEST", requestId: crypto.randomUUID(), manorId, targetPlayerId });
    }

  banManorGuest(manorId: string, targetPlayerId: string): boolean {
      return this.send({ type: "BAN_MANOR_GUEST", requestId: crypto.randomUUID(), manorId, targetPlayerId });
    }

  unbanManorGuest(manorId: string, targetPlayerId: string): boolean {
      return this.send({ type: "UNBAN_MANOR_GUEST", requestId: crypto.randomUUID(), manorId, targetPlayerId });
    }

  buildManor(): string | null {
      const requestId = crypto.randomUUID();
      return this.send({ type: "BUILD_MANOR", requestId }) ? requestId : null;
    }

  destroyManor(): string | null {
      const requestId = crypto.randomUUID();
      return this.send({ type: "DESTROY_MANOR", requestId }) ? requestId : null;
    }

  attackManor(manorId: string): string | null {
      const requestId = crypto.randomUUID();
      return this.send({ type: "ATTACK_MANOR", requestId, manorId }) ? requestId : null;
    }

  startManorRepair(manorId: string): string | null {
      const requestId = crypto.randomUUID();
      return this.send({ type: "START_MANOR_REPAIR", requestId, manorId }) ? requestId : null;
    }

  stopManorRepair(): string | null {
      const requestId = crypto.randomUUID();
      return this.send({ type: "STOP_MANOR_REPAIR", requestId }) ? requestId : null;
    }

  installManorSkin(manorTypeId: string, copyId?: string): string | null {
      const requestId = crypto.randomUUID();
      return this.send({ type: "INSTALL_MANOR_SKIN", requestId, manorTypeId, ...(copyId ? { copyId } : {}) }) ? requestId : null;
    }

  exitManor(manorSessionId: string): string | null {
      void manorSessionId;
      return this.activeManorId
        ? this.portals?.use(
          portalIds.manorMainToWorld(this.activeManorId)
        ) ?? null
        : null;
    }

  manorMoveTo(manorSessionId: string, x: number, y: number): string | null {
      const requestId = crypto.randomUUID();
      return this.send({ type: "MANOR_MOVE_TO", requestId, manorSessionId, x, y }) ? requestId : null;
    }

  requestManorDecorations(manorSessionId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "REQUEST_MANOR_DECORATIONS", requestId, manorSessionId }) ? requestId : null;
  }

  placeManorDecoration(
    manorSessionId: string,
    definitionId: string,
    x?: number,
    y?: number
  ): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "PLACE_MANOR_DECORATION",
      requestId,
      manorSessionId,
      definitionId,
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y })
    }) ? requestId : null;
  }

  moveManorDecoration(manorSessionId: string, placementId: string, x: number, y: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "MOVE_MANOR_DECORATION", requestId, manorSessionId, placementId, x, y }) ? requestId : null;
  }

  removeManorDecoration(manorSessionId: string, placementId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "REMOVE_MANOR_DECORATION", requestId, manorSessionId, placementId }) ? requestId : null;
  }

  buildFurnace(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "BUILD_FURNACE", requestId }) ? requestId : null;
  }

  openFurnace(furnaceId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "OPEN_FURNACE", requestId, furnaceId }) ? requestId : null;
  }

  startFurnaceSmelt(
    furnaceId: string,
    recipeId: FurnaceRecipeId | string,
    quantity: number,
    options: StationStartOptions = {}
  ): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "START_FURNACE_SMELT",
      requestId,
      furnaceId,
      recipeId,
      quantity,
      ...options
    }) ? requestId : null;
  }

  collectFurnaceOutput(furnaceId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "COLLECT_FURNACE_OUTPUT", requestId, furnaceId })
      ? requestId
      : null;
  }

  refineFurnaceGlimmerOil(furnaceId: string, quantity: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "REFINE_FURNACE_GLIMMER_OIL", requestId, furnaceId, quantity })
      ? requestId
      : null;
  }

  buildTannery(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "BUILD_TANNERY", requestId }) ? requestId : null;
  }

  openTannery(tanneryId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "OPEN_TANNERY", requestId, tanneryId }) ? requestId : null;
  }

  startTanneryBatch(
    tanneryId: string,
    recipeId: string,
    quantity: number,
    options: StationStartOptions = {}
  ): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "START_TANNERY_BATCH", requestId, tanneryId, recipeId, quantity, ...options
    }) ? requestId : null;
  }

  collectTanneryOutput(tanneryId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "COLLECT_TANNERY_OUTPUT", requestId, tanneryId })
      ? requestId
      : null;
  }

  buildLoom(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "BUILD_LOOM", requestId }) ? requestId : null;
  }

  openLoom(loomId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "OPEN_LOOM", requestId, loomId }) ? requestId : null;
  }

  startLoomBatch(loomId: string, quantity: number, recipeId = "flax_fiber", options: StationStartOptions = {}): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "START_LOOM_BATCH", requestId, loomId, recipeId, quantity, ...options
    }) ? requestId : null;
  }

  collectLoomOutput(loomId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "COLLECT_LOOM_OUTPUT", requestId, loomId })
      ? requestId
      : null;
  }

  buildKitchen(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "BUILD_KITCHEN", requestId }) ? requestId : null;
  }

  openKitchen(kitchenId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "OPEN_KITCHEN", requestId, kitchenId }) ? requestId : null;
  }

  startKitchenBatch(kitchenId: string, recipeId: KitchenRecipeId | "cook_any", quantity: number, options: StationStartOptions = {}): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "START_KITCHEN_BATCH", requestId, kitchenId, recipeId, quantity, ...options }) ? requestId : null;
  }

  collectKitchenOutput(kitchenId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "COLLECT_KITCHEN_OUTPUT", requestId, kitchenId }) ? requestId : null;
  }

  buildGreenhouse(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "BUILD_GREENHOUSE", requestId }) ? requestId : null;
  }

  previewGreenhouseBuild(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "PREVIEW_GREENHOUSE_BUILD", requestId }) ? requestId : null;
  }

  cancelGreenhouseBuild(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "CANCEL_GREENHOUSE_BUILD", requestId }) ? requestId : null;
  }

  destroyGreenhouse(greenhouseId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DESTROY_GREENHOUSE", requestId, greenhouseId }) ? requestId : null;
  }

  enterGreenhouse(greenhouseId: string): string | null {
    this.activeGreenhouseId = greenhouseId;
    return this.portals?.use(portalIds.greenhouseWorldToMain(greenhouseId)) ?? null;
  }

  exitGreenhouse(greenhouseSessionId: string): string | null {
    void greenhouseSessionId;
    return this.activeGreenhouseId
      ? this.portals?.use(
          portalIds.greenhouseMainToWorld(this.activeGreenhouseId),
          undefined,
          { approach: "immediate" }
        ) ?? null
      : null;
  }

  openGreenhouse(greenhouseId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "OPEN_GREENHOUSE", requestId, greenhouseId }) ? requestId : null;
  }

  rememberGreenhouse(greenhouseId: string): void {
    this.activeGreenhouseId = greenhouseId;
  }

  greenhouseMoveTo(greenhouseSessionId: string, x: number, y: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "GREENHOUSE_MOVE_TO", requestId, greenhouseSessionId, x, y }) ? requestId : null;
  }

  placeGreenhouse(
    greenhouseSessionId: string,
    placementKind: "pot" | "water_tank",
    x: number,
    y: number,
    anchorId?: string
  ): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "PLACE_GREENHOUSE", requestId, greenhouseSessionId, placementKind, x, y, ...(anchorId ? { anchorId } : {}) }) ? requestId : null;
  }

  plantGreenhouse(greenhouseSessionId: string, anchorId: string, cropId = "wheat"): string | null {
    const packId = selectedRuntimePngContentPack().packId;
    if (!packId && cropId !== "giving_berry_tree") return null;
    const requestId = crypto.randomUUID();
    return this.send({ type: "PLANT_GREENHOUSE", requestId, greenhouseSessionId, anchorId, cropId, packId: packId ?? "0".repeat(64) }) ? requestId : null;
  }

  waterGreenhouse(greenhouseSessionId: string, anchorId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "WATER_GREENHOUSE", requestId, greenhouseSessionId, anchorId }) ? requestId : null;
  }

  clipGreenhouse(greenhouseSessionId: string, anchorId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "CLIP_GREENHOUSE", requestId, greenhouseSessionId, anchorId }) ? requestId : null;
  }

  harvestGreenhouse(greenhouseSessionId: string, anchorId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "HARVEST_GREENHOUSE", requestId, greenhouseSessionId, anchorId }) ? requestId : null;
  }

  tapGreenhouseTree(greenhouseSessionId: string, anchorId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "TAP_GREENHOUSE_TREE", requestId, greenhouseSessionId, anchorId }) ? requestId : null;
  }

  craftWaterBucket(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "CRAFT_WATER_BUCKET", requestId }) ? requestId : null;
  }

  craftFertilizer(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "CRAFT_FERTILIZER", requestId }) ? requestId : null;
  }

  fillWaterBucket(lat: number, lon: number, gallons: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "FILL_WATER_BUCKET", requestId, lat, lon, gallons }) ? requestId : null;
  }

  cancelWaterBucketFill(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "CANCEL_WATER_BUCKET_FILL", requestId }) ? requestId : null;
  }

  depositGreenhouseWater(greenhouseSessionId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "DEPOSIT_GREENHOUSE_WATER", requestId, greenhouseSessionId }) ? requestId : null;
  }

  refillGardeningBucket(greenhouseSessionId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "REFILL_GARDENING_BUCKET", requestId, greenhouseSessionId }) ? requestId : null;
  }

  buildFishingHut(): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "BUILD_FISHING_HUT", requestId }) ? requestId : null;
  }

  openFishingHut(fishingHutId?: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "OPEN_FISHING_HUT", requestId, ...(fishingHutId ? { fishingHutId } : {}) }) ? requestId : null;
  }

  collectFishingHut(fishingHutId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "COLLECT_FISHING_HUT", requestId, fishingHutId }) ? requestId : null;
  }

  requestFishingRecords(fishingHutId?: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "REQUEST_FISHING_RECORDS", requestId, ...(fishingHutId ? { fishingHutId } : {}) }) ? requestId : null;
  }

  startFishing(fishingHutId: string): string | null {
    return this.startFishingWithRod(fishingHutId);
  }

  startFishingWithRod(fishingRodId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "START_FISHING", requestId, fishingRodId }) ? requestId : null;
  }

  craftFishingRod(fishingHutId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "CRAFT_FISHING_ROD", requestId, fishingHutId }) ? requestId : null;
  }

  upgradeFishingTraining(fishingHutId: string, track: "cast_range" | "reel_power" | "line_control"): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "UPGRADE_FISHING_TRAINING", requestId, fishingHutId, track }) ? requestId : null;
  }

  selectFishingSpecialization(fishingHutId: string, specializationType: "river" | "lake" | "ocean"): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "SELECT_FISHING_SPECIALIZATION", requestId, fishingHutId, specializationType }) ? requestId : null;
  }

  fishingCast(encounterId: string, timing: number, castPoint: { lat: number; lon: number }, waterbody?: { kind: "river" | "lake" | "ocean"; sourceId: string | null }): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "FISHING_CAST", requestId, encounterId, timing, castPoint, ...(waterbody ? { waterbody } : {}) }) ? requestId : null;
  }

  fishingHook(encounterId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "FISHING_HOOK", requestId, encounterId }) ? requestId : null;
  }

  fishingControl(encounterId: string, direction: "left" | "right" | "neutral", reeling: boolean): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "FISHING_CONTROL", requestId, encounterId, direction, reeling }) ? requestId : null;
  }

  fishingLand(encounterId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "FISHING_LAND", requestId, encounterId }) ? requestId : null;
  }

  fishingCancel(encounterId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "FISHING_CANCEL", requestId, encounterId }) ? requestId : null;
  }

  openJewelStation(manorSessionId: string, movementSequence: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "OPEN_JEWEL_STATION",
      requestId,
      manorSessionId,
      movementSequence
    }) ? requestId : null;
  }

  prepareJewelEquipment(
    manorSessionId: string,
    movementSequence: number,
    instanceId: string,
    gemstone: EnchantmentStoneVariant
  ): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "PREPARE_JEWEL_EQUIPMENT",
      requestId,
      manorSessionId,
      movementSequence,
      instanceId,
      gemstone
    }) ? requestId : null;
  }

  imbueJewelEquipment(
    manorSessionId: string,
    movementSequence: number,
    instanceId: string,
    metal: EquipmentMetal
  ): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "IMBUE_JEWEL_EQUIPMENT",
      requestId,
      manorSessionId,
      movementSequence,
      instanceId,
      metal
    }) ? requestId : null;
  }

  reforgeJewelEquipment(
    manorSessionId: string,
    movementSequence: number,
    instanceId: string,
    options: { gemstone?: EnchantmentStoneVariant; changeMetal?: boolean } = {}
  ): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "REFORGE_JEWEL_EQUIPMENT",
      requestId,
      manorSessionId,
      movementSequence,
      instanceId,
      ...(options.gemstone ? { gemstone: options.gemstone } : {}),
      ...(options.changeMetal !== undefined ? { changeMetal: options.changeMetal } : {})
    }) ? requestId : null;
  }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}
