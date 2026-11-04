import type {
  CityDistrictType,
  CityConstructionAction,
  CityFacilityType,
  MilitaryFacilityType,
  ClientMessage
} from "@ash-atlas/shared";
import type { GoblinMarketBuyLine, GoblinMarketLine } from "@ash-atlas/shared";
import { requestIdCrypto as crypto } from "../../requestId.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";
import { requestActionFix } from "../../location/actionFixHook.js";

export class SettlementClient {
  constructor(private readonly port: ClientCommandPort) {}

  sendKingdomChat(content: string, requestId: string = crypto.randomUUID()): boolean {
    return this.send({
      type: "KINGDOM_CHAT_SEND",
      requestId,
      content
    });
  }

  previewCityFounding(flagId: string): void {
      this.send({ type: "PREVIEW_CITY_FOUNDING", requestId: crypto.randomUUID(), flagId });
    }

  foundCity(flagId: string): void {
      if (this.send({ type: "FOUND_CITY", requestId: crypto.randomUUID(), flagId })) requestActionFix("action_city_found");
    }

  advanceCityConstruction(
    cityId: string,
    action: CityConstructionAction,
    requestId = crypto.randomUUID()
  ): string | null {
    return this.send({
      type: "ADVANCE_CITY_CONSTRUCTION",
      requestId,
      cityId,
      action
    }) ? requestId : null;
  }

  requestCityInfo(cityId: string): void {
      this.send({ type: "REQUEST_CITY_INFO", requestId: crypto.randomUUID(), cityId });
    }

  requestCityApp(): void {
      this.send({ type: "REQUEST_CITY_APP", requestId: crypto.randomUUID() });
    }

  requestMilitaryIndustry(requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "REQUEST_MILITARY_INDUSTRY", requestId }) ? requestId : null;
  }

  openGoblinMarket(marketStructureId: string): boolean {
    return this.send({
      type: "OPEN_GOBLIN_MARKET",
      requestId: crypto.randomUUID(),
      marketStructureId
    });
  }

  sellToGoblinMarket(marketStructureId: string, line: GoblinMarketLine): boolean {
    return this.send({
      type: "SELL_TO_GOBLIN_MARKET",
      requestId: crypto.randomUUID(),
      marketStructureId,
      itemKind: line.kind,
      itemIdentity: line.identity,
      quantity: line.quantity,
      expectedOfferGold: line.offerGold
    });
  }

  buyFromGoblinMarket(
    marketStructureId: string,
    line: GoblinMarketBuyLine,
    quantity = 1
  ): boolean {
    return this.send({
      type: "BUY_FROM_GOBLIN_MARKET",
      requestId: crypto.randomUUID(),
      marketStructureId,
      itemId: line.itemId,
      quantity,
      expectedUnitPriceGold: line.unitPriceGold
    });
  }

  openHollinHut(hutId: string): boolean {
    return this.send({ type: "OPEN_HOLLIN_HUT", requestId: crypto.randomUUID(), hutId });
  }

  buyFromHollinHut(hutId: string, itemId: string, quantity: number, expectedUnitPriceGold: string): boolean {
    return this.send({
      type: "BUY_FROM_HOLLIN_HUT", requestId: crypto.randomUUID(), hutId, itemId, quantity, expectedUnitPriceGold
    });
  }

  listWanderingMerchants(): boolean {
    return this.send({ type: "LIST_WANDERING_MERCHANTS", requestId: crypto.randomUUID() });
  }

  openWanderingMerchant(merchantId: string): boolean {
    return this.send({ type: "OPEN_WANDERING_MERCHANT", requestId: crypto.randomUUID(), merchantId });
  }

  buyFromWanderingMerchant(merchantId: string, itemId: string, quantity: number, expectedUnitPriceGold: string): boolean {
    return this.send({
      type: "BUY_FROM_WANDERING_MERCHANT", requestId: crypto.randomUUID(), merchantId, itemId, quantity, expectedUnitPriceGold
    });
  }

  craftCinderLantern(lantern: "cinder" | "challenger" = "cinder"): boolean {
    return this.send({
      type: "CRAFT_CINDER_LANTERN",
      requestId: crypto.randomUUID(),
      ...(lantern === "challenger" ? { lantern } : {})
    });
  }

  offerBerryToHollins(hutId: string): boolean {
    return this.send({ type: "OFFER_BERRY_TO_HOLLINS", requestId: crypto.randomUUID(), hutId });
  }

  useHollinHutService(hutId: string, service: "heal" | "turn_in_eggs"): boolean {
    return this.send({ type: "USE_HOLLIN_HUT_SERVICE", requestId: crypto.randomUUID(), hutId, service });
  }

  buildCityHouse(requestId = crypto.randomUUID()): string | null {
      return this.send({ type: "BUILD_CITY_HOUSE", requestId }) ? requestId : null;
    }

  destroyCityHouse(structureId: string, expectedPlacementRevision: string): boolean {
      return this.send({
        type: "DESTROY_CITY_HOUSE",
        requestId: crypto.randomUUID(),
        structureId,
        expectedPlacementRevision
      });
    }

  buildCityFacility(
    cityId: string,
    facilityType: CityFacilityType
  ): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "BUILD_CITY_FACILITY",
        requestId,
        cityId,
        facilityType
      }) ? requestId : null;
    }

  buildMilitaryFacility(cityId: string, facilityType: MilitaryFacilityType): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "BUILD_MILITARY_FACILITY",
      requestId,
      cityId,
      facilityType
    }) ? requestId : null;
  }

  buildLodge(requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "BUILD_LODGE", requestId }) ? requestId : null;
  }

  upgradeLodge(expectedLevel: number, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "UPGRADE_LODGE", requestId, expectedLevel }) ? requestId : null;
  }

  destroyLodge(requestId = crypto.randomUUID()): boolean {
    return this.send({ type: "DESTROY_LODGE", requestId });
  }

  trainSiegeCrew(facilityStructureId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "TRAIN_SIEGE_CREW", requestId, facilityStructureId }) ? requestId : null;
  }

  trainMilitaryUnit(
    facilityStructureId: string,
    unitType: "infantry" | "archer" | "bomber",
    requestId = crypto.randomUUID()
  ): string | null {
    return this.send({ type: "TRAIN_MILITARY_UNIT", requestId, facilityStructureId, unitType }) ? requestId : null;
  }

  manufactureFieldBallista(facilityStructureId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "MANUFACTURE_FIELD_BALLISTA", requestId, facilityStructureId }) ? requestId : null;
  }

  startMilitaryProduction(
    facilityStructureId: string,
    production: "repair_kit_batch" | "torch_batch",
    quantity: number,
    requestId = crypto.randomUUID()
  ): string | null {
    return this.send({ type: "START_MILITARY_PRODUCTION", requestId, facilityStructureId, production, quantity }) ? requestId : null;
  }

  combineMilitaryGroups(groupIds: string[], requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "COMBINE_MILITARY_GROUPS", requestId, groupIds }) ? requestId : null;
  }

  splitMilitaryGroup(groupId: string, splitSizes: number[], requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "SPLIT_MILITARY_GROUP", requestId, groupId, splitSizes }) ? requestId : null;
  }

  buildWarCamp(requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "BUILD_WAR_CAMP", requestId }) ? requestId : null;
  }

  relocateWarCamp(requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "RELOCATE_WAR_CAMP", requestId }) ? requestId : null;
  }

  removeWarCamp(requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "REMOVE_WAR_CAMP", requestId }) ? requestId : null;
  }

  callTroops(requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "CALL_TROOPS", requestId }) ? requestId : null;
  }

  followMilitaryGroup(groupId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "FOLLOW_MILITARY_GROUP", requestId, groupId }) ? requestId : null;
  }

  stayMilitaryGroup(groupId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "STAY_MILITARY_GROUP", requestId, groupId }) ? requestId : null;
  }

  packUpMilitaryGroup(groupId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "PACK_UP_MILITARY_GROUP", requestId, groupId }) ? requestId : null;
  }

  deployMilitaryGroup(
    groupId: string,
    position?: { lat: number; lon: number },
    requestId = crypto.randomUUID()
  ): string | null {
    return this.send({
      type: "DEPLOY_MILITARY_GROUP",
      requestId,
      groupId,
      ...(position ? { position } : {})
    }) ? requestId : null;
  }

  defendMilitaryGroup(groupId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "DEFEND_MILITARY_GROUP", requestId, groupId }) ? requestId : null;
  }

  returnMilitaryGroup(groupId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "RETURN_MILITARY_GROUP", requestId, groupId }) ? requestId : null;
  }

  stopMilitaryGroup(groupId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "STOP_MILITARY_GROUP", requestId, groupId }) ? requestId : null;
  }

  moveMilitaryGroup(
    groupId: string,
    position: { lat: number; lon: number },
    requestId = crypto.randomUUID()
  ): string | null {
    return this.send({ type: "MOVE_MILITARY_GROUP", requestId, groupId, position }) ? requestId : null;
  }

  attackMilitaryGroup(groupId: string, targetEntityId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "ATTACK_MILITARY_GROUP", requestId, groupId, targetEntityId }) ? requestId : null;
  }

  attackMilitarySiege(groupId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "ATTACK_MILITARY_SIEGE", requestId, groupId }) ? requestId : null;
  }

  demolishFlag(
    groupId: string,
    targetFlagId: string,
    requestId = crypto.randomUUID(),
    targetKind: "flag" | "city_structure" = "flag"
  ): string | null {
    return this.send({
      type: "DEMOLISH_FLAG", requestId, groupId, targetFlagId,
      ...(targetKind === "city_structure" ? { targetKind } : {})
    }) ? requestId : null;
  }

  attackWarCamp(
    campId: string,
    mode: "hand" | "bomber" | "siege",
    groupId?: string,
    requestId = crypto.randomUUID()
  ): string | null {
    return this.send({ type: "ATTACK_WAR_CAMP", requestId, campId, mode, ...(groupId ? { groupId } : {}) })
      ? requestId
      : null;
  }

  fireBallistaVolley(
    groupId: string,
    targetFlagId: string,
    requestId = crypto.randomUUID(),
    targetKind: "flag" | "city_structure" = "flag"
  ): string | null {
    return this.send({
      type: "FIRE_BALLISTA_VOLLEY", requestId, groupId, targetFlagId,
      ...(targetKind === "city_structure" ? { targetKind } : {})
    }) ? requestId : null;
  }

  attackCityStructure(structureId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "ATTACK_CITY_STRUCTURE", requestId, structureId }) ? requestId : null;
  }

  startCityStructureRepair(structureId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "START_CITY_STRUCTURE_REPAIR", requestId, structureId }) ? requestId : null;
  }

  stopCityStructureRepair(requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "STOP_CITY_STRUCTURE_REPAIR", requestId }) ? requestId : null;
  }

  repairBallista(unitId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "REPAIR_BALLISTA", requestId, unitId }) ? requestId : null;
  }

  collectMilitaryJob(jobId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "COLLECT_MILITARY_JOB", requestId, jobId }) ? requestId : null;
  }

  upgradeCityFacility(structureId: string, expectedTier: number): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "UPGRADE_CITY_FACILITY",
        requestId,
        structureId,
        expectedTier
      }) ? requestId : null;
    }

  destroyCityFacility(
    structureId: string,
    expectedPlacementRevision: string
  ): boolean {
      return this.send({
        type: "DESTROY_CITY_FACILITY",
        requestId: crypto.randomUUID(),
        structureId,
        expectedPlacementRevision
      });
    }

  buyCityMarketDaily(cityId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "BUY_CITY_MARKET_DAILY", requestId, cityId }) ? requestId : null;
  }

  buildCityMarket(cityId: string, expectedCityRevision: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "BUILD_CITY_MARKET",
      requestId,
      cityId,
      expectedCityRevision
    }) ? requestId : null;
  }

  buildOilWell(
    cityId: string,
    requestId = crypto.randomUUID(),
    structureType: "oil_well" | "quartz_hut" | "library" = "oil_well"
  ): string | null {
    return this.send({
      type: "BUILD_OIL_WELL",
      requestId,
      cityId,
      ...(structureType !== "oil_well" ? { structureType } : {})
    })
      ? requestId
      : null;
  }

  openOilWell(structureId: string, requestId = crypto.randomUUID(), remote = false): string | null {
    return this.send({ type: "OPEN_OIL_WELL", requestId, structureId, ...(remote ? { remote: true } : {}) })
      ? requestId
      : null;
  }

  openLibrary(structureId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "OPEN_LIBRARY", requestId, structureId }) ? requestId : null;
  }

  studyLibrary(structureId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "STUDY_LIBRARY", requestId, structureId }) ? requestId : null;
  }

  harvestOilWell(structureId: string, requestId = crypto.randomUUID(), remote = false): string | null {
    return this.send({ type: "HARVEST_OIL_WELL", requestId, structureId, ...(remote ? { remote: true } : {}) })
      ? requestId
      : null;
  }

  destroyOilWell(
    structureId: string,
    expectedPlacementRevision: string
  ): boolean {
    return this.send({
      type: "DESTROY_OIL_WELL",
      requestId: crypto.randomUUID(),
      structureId,
      expectedPlacementRevision
    });
  }

  buildCityMonument(
    cityId: string,
    districtType: CityDistrictType,
    expectedCityRevision: string,
    expectedDistrictRevision: string
  ): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "BUILD_CITY_MONUMENT",
      requestId,
      cityId,
      districtType,
      expectedCityRevision,
      expectedDistrictRevision
    }) ? requestId : null;
  }

  upgradeCityMonument(
    structureId: string,
    expectedTier: 1 | 2,
    expectedPlacementRevision: string,
    expectedDistrictRevision: string
  ): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "UPGRADE_CITY_MONUMENT",
      requestId,
      structureId,
      expectedTier,
      expectedPlacementRevision,
      expectedDistrictRevision
    }) ? requestId : null;
  }

  destroyCityMonument(
    structureId: string,
    expectedPlacementRevision: string,
    expectedDistrictRevision: string
  ): boolean {
    return this.send({
      type: "DESTROY_CITY_MONUMENT",
      requestId: crypto.randomUUID(),
      structureId,
      expectedPlacementRevision,
      expectedDistrictRevision
    });
  }

  openCityWarehouse(structureId: string, requestId = crypto.randomUUID()): string | null {
      return this.send({ type: "OPEN_CITY_WAREHOUSE", requestId, structureId })
        ? requestId
        : null;
    }

  donateCityWarehouse(
    structureId: string,
    stackId: string,
    quantity: number,
    requestId = crypto.randomUUID()
  ): string | null {
      return this.send({
        type: "DONATE_CITY_WAREHOUSE",
        requestId,
        structureId,
        stackId,
        quantity
      }) ? requestId : null;
    }

  donateAllCityWarehouse(
    structureId: string,
    requestId = crypto.randomUUID()
  ): string | null {
      return this.send({
        type: "DONATE_ALL_CITY_WAREHOUSE",
        requestId,
        structureId
      }) ? requestId : null;
    }

  moveCityWarehouseStack(
    structureId: string,
    stackId: string,
    targetSlot: number,
    requestId = crypto.randomUUID()
  ): string | null {
      return this.send({
        type: "MOVE_CITY_WAREHOUSE_STACK",
        requestId,
        structureId,
        stackId,
        targetSlot
      }) ? requestId : null;
    }

  reorganizeCityWarehouse(
    structureId: string,
    requestId = crypto.randomUUID()
  ): string | null {
      return this.send({
        type: "REORGANIZE_CITY_WAREHOUSE",
        requestId,
        structureId
      }) ? requestId : null;
    }

  joinCity(cityId: string): void {
      this.send({ type: "JOIN_CITY", requestId: crypto.randomUUID(), cityId });
    }

  leaveCity(cityId: string): void {
      this.send({ type: "LEAVE_CITY", requestId: crypto.randomUUID(), cityId });
    }

  claimCityMayor(cityId: string): void {
      this.send({ type: "CLAIM_CITY_MAYOR", requestId: crypto.randomUUID(), cityId });
    }

  relinquishCityMayor(cityId: string): void {
      this.send({ type: "RELINQUISH_CITY_MAYOR", requestId: crypto.randomUUID(), cityId });
    }

  convertCityFlag(
    flagId: string,
    requestId = crypto.randomUUID()
  ): string | null {
      return this.send({ type: "CONVERT_CITY_FLAG", requestId, flagId })
        ? requestId
        : null;
    }

  requestKingdomState(): boolean {
      return this.send({
        type: "REQUEST_KINGDOM_STATE",
        requestId: crypto.randomUUID()
      });
    }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }

  donateCityGold(
    structureId: string,
    amount: string,
    requestId = crypto.randomUUID()
  ): string | null {
    return this.send({
      type: "DONATE_CITY_GOLD",
      requestId,
      structureId,
      amount
    }) ? requestId : null;
  }
}
