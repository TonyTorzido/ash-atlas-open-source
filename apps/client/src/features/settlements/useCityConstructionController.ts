import type {
  CityAppSnapshot,
  CityDistrictType,
  CityPhysicalConstructionAction
} from "@ash-atlas/shared";
import { useCallback, useMemo, useState } from "react";

import {
  cityBuildActionTitle,
  cityBuildConfirmationMessage,
  cityDestructionConfirmationMessage,
  cityHouseMaterialRequirements,
  cityStructureDisplayName,
  type PendingCityBuildAction,
  type PendingCityDestruction
} from "./cityConstructionPresentation.js";

export interface CityConstructionCommands {
  buildCityHouse(): string | null;
  buildOilWell(cityId: string, structureType?: "oil_well" | "quartz_hut" | "library"): string | null;
  buildCityFacility(
    cityId: string,
    facilityType: "warehouse" | "cistern_warrens" | "salon" | "city_kennel"
  ): string | null;
  upgradeCityFacility(structureId: string, expectedTier: number): string | null;
  buildCityMarket(cityId: string, expectedCityRevision: string): string | null;
  buildCityMonument(
    cityId: string,
    districtType: CityDistrictType,
    expectedCityRevision: string,
    expectedDistrictRevision: string
  ): string | null;
  upgradeCityMonument(
    structureId: string,
    expectedTier: 1 | 2,
    expectedPlacementRevision: string,
    expectedDistrictRevision: string
  ): string | null;
  destroyCityHouse(structureId: string, expectedPlacementRevision: string): boolean;
  destroyOilWell(structureId: string, expectedPlacementRevision: string): boolean;
  destroyCityFacility(structureId: string, expectedPlacementRevision: string): boolean;
}

export interface CityConstructionControllerOptions {
  getCommands(): CityConstructionCommands | null;
  cityApp: CityAppSnapshot | null;
  busy: boolean;
  trackRequest(
    requestId: string | null,
    action: CityPhysicalConstructionAction
  ): boolean;
  setBusy(busy: boolean): void;
  clearWarning(): void;
  showActionError(message: string): void;
}

export function useCityConstructionController({
  getCommands,
  cityApp,
  busy,
  trackRequest,
  setBusy,
  clearWarning,
  showActionError
}: CityConstructionControllerOptions) {
  const [pendingBuild, setPendingBuild] = useState<PendingCityBuildAction | null>(null);
  const [houseConfirmationOpen, setHouseConfirmationOpen] = useState(false);
  const [pendingDestruction, setPendingDestruction] =
    useState<PendingCityDestruction | null>(null);

  const requestBuild = useCallback((action: PendingCityBuildAction): void => {
    setPendingBuild(action);
  }, []);

  const confirmBuild = useCallback((): void => {
    if (busy || !pendingBuild) return;
    const commands = getCommands();
    let requestId: string | null = null;
    let action: CityPhysicalConstructionAction;
    switch (pendingBuild.kind) {
      case "oil-well":
        action = "build_oil_well";
        requestId = commands?.buildOilWell(pendingBuild.cityId) ?? null;
        break;
      case "quartz-hut":
        action = "build_quartz_hut";
        requestId = commands?.buildOilWell(pendingBuild.cityId, "quartz_hut") ?? null;
        break;
      case "library":
        action = "build_library";
        requestId = commands?.buildOilWell(pendingBuild.cityId, "library") ?? null;
        break;
      case "warehouse":
        action = "build_facility";
        requestId = commands?.buildCityFacility(pendingBuild.cityId, "warehouse") ?? null;
        break;
      case "cistern-warrens":
        action = "build_facility";
        requestId = commands?.buildCityFacility(pendingBuild.cityId, "cistern_warrens") ?? null;
        break;
      case "salon":
        action = "build_facility";
        requestId = commands?.buildCityFacility(pendingBuild.cityId, "salon") ?? null;
        break;
      case "city-kennel":
        action = "build_facility";
        requestId = commands?.buildCityFacility(pendingBuild.cityId, "city_kennel") ?? null;
        break;
      case "warehouse-upgrade":
        action = "upgrade_facility";
        requestId = commands?.upgradeCityFacility(
          pendingBuild.structure.structureId,
          pendingBuild.structure.tier
        ) ?? null;
        break;
      case "market-upgrade":
        action = "upgrade_facility";
        requestId = commands?.upgradeCityFacility(
          pendingBuild.structure.structureId,
          pendingBuild.structure.tier
        ) ?? null;
        break;
      case "market":
        action = "build_market";
        requestId = cityApp?.city?.id === pendingBuild.cityId
          ? commands?.buildCityMarket(
              pendingBuild.cityId,
              cityApp.city.spatialRevision
            ) ?? null
          : null;
        break;
      case "monument":
        action = "build_monument";
        requestId = cityApp?.city?.id === pendingBuild.cityId
          ? commands?.buildCityMonument(
              pendingBuild.cityId,
              pendingBuild.districtType,
              cityApp.city.spatialRevision,
              cityApp.district.districtRevision
            ) ?? null
          : null;
        break;
      case "monument-upgrade":
        action = "upgrade_monument";
        requestId = cityApp?.city?.id === pendingBuild.structure.cityId &&
          pendingBuild.structure.tier < 3
          ? commands?.upgradeCityMonument(
              pendingBuild.structure.structureId,
              pendingBuild.structure.tier as 1 | 2,
              pendingBuild.structure.placementRevision,
              cityApp.district.districtRevision
            ) ?? null
          : null;
        break;
    }
    if (!trackRequest(requestId, action)) {
      showActionError(
        "Cannot begin city construction while disconnected or using stale City records."
      );
      return;
    }
    setPendingBuild(null);
  }, [busy, cityApp, getCommands, pendingBuild, showActionError, trackRequest]);

  const confirmHouseBuild = useCallback((): void => {
    if (busy) return;
    clearWarning();
    const requestId = getCommands()?.buildCityHouse() ?? null;
    if (!trackRequest(requestId, "build_house")) {
      setHouseConfirmationOpen(false);
      showActionError("Cannot build a City House while disconnected.");
      return;
    }
    setHouseConfirmationOpen(false);
  }, [busy, clearWarning, getCommands, showActionError, trackRequest]);

  const confirmDestruction = useCallback((): void => {
    if (busy || !pendingDestruction) return;
    const { kind, structure } = pendingDestruction;
    const commands = getCommands();
    const sent = kind === "house"
      ? commands?.destroyCityHouse(structure.structureId, structure.placementRevision)
      : kind === "oil-well"
        ? commands?.destroyOilWell(structure.structureId, structure.placementRevision)
        : commands?.destroyCityFacility(structure.structureId, structure.placementRevision);
    if (!sent) {
      showActionError("Cannot destroy a city building while disconnected.");
      return;
    }
    setBusy(true);
    setPendingDestruction(null);
  }, [busy, getCommands, pendingDestruction, setBusy, showActionError]);

  const buildPrompt = useMemo(() => pendingBuild ? {
    title: cityBuildActionTitle(pendingBuild),
    message: cityBuildConfirmationMessage(pendingBuild, cityApp)
  } : null, [cityApp, pendingBuild]);
  const destructionPrompt = useMemo(() => pendingDestruction ? {
    title: `Destroy ${cityStructureDisplayName(pendingDestruction.structure)}?`,
    message: cityDestructionConfirmationMessage(pendingDestruction.structure),
    confirmLabel: `Destroy ${cityStructureDisplayName(pendingDestruction.structure)}`
  } : null, [pendingDestruction]);

  return {
    view: {
      busy,
      buildPrompt,
      housePrompt: houseConfirmationOpen ? {
        title: "Build City House here?",
        message: `This will use ${cityHouseMaterialRequirements.join(" and ")}. The house will be placed at your current position and take 30 seconds to construct. You must remain stationary. City membership begins when authoritative construction completes.`
      } : null,
      destructionPrompt
    },
    actions: {
      requestBuild,
      requestHouseBuild: () => setHouseConfirmationOpen(true),
      requestDestruction: (destruction: PendingCityDestruction) =>
        setPendingDestruction(destruction),
      cancelBuild: () => setPendingBuild(null),
      cancelHouseBuild: () => setHouseConfirmationOpen(false),
      cancelDestruction: () => setPendingDestruction(null),
      confirmBuild,
      confirmHouseBuild,
      confirmDestruction
    }
  } as const;
}

export type CityConstructionController = ReturnType<typeof useCityConstructionController>;
