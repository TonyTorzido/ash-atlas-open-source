import type {
  FlagAccessSnapshot,
  FlagReinforcementTarget,
  FlagSnapshot,
  KingdomStateSnapshot
} from "@ash-atlas/shared";
import {
  CITY_TOWER_UPGRADE_COST,
  KINGDOM_OBELISK_MAX_LEVEL,
  KINGDOM_TOWER_MAX_LEVEL,
  kingdomStructureBuildCost,
  type KingdomStructureKind,
  PERSONAL_GUARD_TOWER_MAX_LEVEL,
  personalGuardTowerUpgradeCost,
  structureWarfareHealthForReinforcementLevel,
  structureWarfareDisplayKind,
  structureWarfareProfileForFlag,
  type StructureWarfareProfile
} from "@ash-atlas/shared";

import { ownerColorForClaim } from "../territory/territoryGeometry.js";

function reinforcementLevelForPresentation(
  flag: Pick<FlagSnapshot, "reinforcementLevel" | "upgradeTier">
): number {
  if (typeof flag.reinforcementLevel === "number") return flag.reinforcementLevel;
  if (flag.upgradeTier === "tower") return 3;
  if (flag.upgradeTier === "stone") return 1;
  if (flag.upgradeTier === "atlas_shrine") return 2;
  // Older snapshots omitted upgradeTier; their personal land anchor is the
  // ordinary soft/base tier unless an explicit higher tier is present.
  return 0;
}

export function flagRenderColor(
  flag: Pick<FlagSnapshot, "cityId" | "controlType" | "ownerColor" | "kingdomColor">
): string {
  if (flag.controlType === "kingdom" || flag.controlType === "kingdom_seat") {
    return /^#[0-9a-fA-F]{6}$/.test(flag.kingdomColor ?? "")
      ? flag.kingdomColor!.toLowerCase()
      : "#7c3aed";
  }
  return ownerColorForClaim(flag);
}

export function hasPersonalAccessPresentation(
  flag: Pick<FlagSnapshot, "cityId" | "controlType">
): boolean {
  return flag.controlType === "personal" && !flag.cityId;
}

export type FlagPresentationAllies = Readonly<{
  cityId?: string | null;
  kingdomId?: string | null;
}>;

type WarfarePresentationFlag = Pick<
  FlagSnapshot,
  | "towerLevel"
  | "obeliskLevel"
  | "warStructureKind"
  | "anchorKind"
  | "burning"
  | "cityId"
  | "controlType"
  | "developerTestTarget"
  | "health"
  | "kingdomId"
  | "maximumHealth"
  | "ownerId"
  | "systemControlled"
  | "reinforcementLevel"
  | "upgradeTier"
>;

function warfarePresentationProfile(flag: WarfarePresentationFlag) {
  return structureWarfareProfileForFlag({
    controlType: flag.controlType,
    anchorKind: flag.anchorKind ?? "flag",
    systemControlled: flag.systemControlled === true,
    cityId: flag.cityId ?? null,
    kingdomId: flag.kingdomId ?? null,
    reinforcementLevel: reinforcementLevelForPresentation(flag),
    towerLevel: flag.towerLevel ?? null,
    obeliskLevel: flag.obeliskLevel ?? null,
    warStructureKind: flag.warStructureKind ?? null
  });
}

/**
 * Hostility for presentation: another player's personal flag (or a
 * developer fixture), or a city / kingdom structure that does not belong to
 * the viewer's own city or kingdom. The server enforces the same rule.
 */
function isHostileWarfareTarget(
  flag: WarfarePresentationFlag,
  playerId: string | null | undefined,
  allies: FlagPresentationAllies | undefined,
  profile: StructureWarfareProfile
): boolean {
  if (!playerId) return false;
  if (profile.organization) {
    return !(
      (flag.cityId && flag.cityId === allies?.cityId) ||
      (flag.kingdomId && flag.kingdomId === allies?.kingdomId)
    );
  }
  return flag.ownerId !== playerId || flag.developerTestTarget === true;
}

/**
 * Burning is a separate interaction from passage access. Keep this
 * presentation predicate independent from the async access snapshot so a
 * valid enemy Flag can still expose its burn action while access is loading.
 */
export function isFlagBurnablePresentationTarget(
  flag: WarfarePresentationFlag,
  playerId: string | null | undefined,
  allies?: FlagPresentationAllies
): boolean {
  const profile = warfarePresentationProfile(flag);
  return Boolean(
    profile &&
    isHostileWarfareTarget(flag, playerId, allies, profile) &&
    !flag.burning &&
    flag.maximumHealth === profile.maximumHealth &&
    flag.health !== undefined && flag.health !== null &&
    flag.health > 0 && flag.health <= profile.burnThreshold
  );
}

export function isFlagAttackablePresentationTarget(
  flag: WarfarePresentationFlag,
  playerId: string | null | undefined,
  allies?: FlagPresentationAllies
): boolean {
  const profile = warfarePresentationProfile(flag);
  return Boolean(
    profile &&
    isHostileWarfareTarget(flag, playerId, allies, profile) &&
    !flag.burning &&
    flag.maximumHealth === profile.maximumHealth &&
    flag.health !== undefined && flag.health !== null &&
    flag.health > profile.burnThreshold
  );
}

/**
 * Bomber demolition is a one-charge damage action. Any positive-health,
 * non-burning hostile structure is a valid target, and so is one being
 * repaired (its burn is paused). The server owns the terminal transition: an
 * unattended city or kingdom structure stops at its burn threshold and
 * ignites, while a repairing one takes double damage and can be destroyed.
 */
export function isFlagDemolishablePresentationTarget(
  flag: WarfarePresentationFlag,
  playerId: string | null | undefined,
  allies?: FlagPresentationAllies,
  repairing = false
): boolean {
  const profile = warfarePresentationProfile(flag);
  return Boolean(
    profile &&
    isHostileWarfareTarget(flag, playerId, allies, profile) &&
    (!flag.burning || repairing) &&
    flag.maximumHealth === profile.maximumHealth &&
    flag.health !== undefined && flag.health !== null &&
    flag.health > 0
  );
}

/**
 * A hostile city or kingdom structure a Siege can fire at (single target,
 * from at least the fusion level's minimum placement distance).
 */
export function isFlagOrganizationSiegeTargetPresentationTarget(
  flag: WarfarePresentationFlag,
  playerId: string | null | undefined,
  allies?: FlagPresentationAllies
): boolean {
  const profile = warfarePresentationProfile(flag);
  return Boolean(
    profile?.organization &&
    isHostileWarfareTarget(flag, playerId, allies, profile) &&
    flag.maximumHealth === profile.maximumHealth &&
    flag.health !== undefined && flag.health !== null &&
    flag.health > 0
  );
}

/** Siege preview and live reticles only include Tower Flags. */
export function isFlagSiegeTargetPresentationTarget(
  flag: Pick<
    FlagSnapshot,
    | "anchorKind"
    | "burning"
    | "cityId"
    | "controlType"
    | "developerTestTarget"
    | "health"
    | "kingdomId"
    | "maximumHealth"
    | "ownerId"
    | "systemControlled"
    | "reinforcementLevel"
    | "upgradeTier"
    | "towerLevel"
  >,
  playerId: string | null | undefined
): boolean {
  const reinforcementLevel = reinforcementLevelForPresentation(flag);
  const expectedHealth = structureWarfareHealthForReinforcementLevel(reinforcementLevel, flag.towerLevel);
  return Boolean(
    playerId &&
    flag.controlType === "personal" &&
    (flag.ownerId !== playerId || flag.developerTestTarget === true) &&
    (flag.anchorKind ?? "flag") === "flag" &&
    flag.systemControlled !== true &&
    (flag.cityId ?? null) === null &&
    (flag.kingdomId ?? null) === null &&
    reinforcementLevel === 3 &&
    expectedHealth !== null &&
    flag.maximumHealth === expectedHealth &&
    flag.health !== undefined && flag.health !== null &&
    flag.health > 0
  );
}

export function flagAccessRenderColor(
  flag: Pick<
    FlagSnapshot,
    | "accessMode"
    | "cityId"
    | "controlType"
    | "kingdomColor"
    | "ownerColor"
    | "upgradeTier"
  >
): string {
  const baseColor = flagRenderColor(flag);
  if (!hasPersonalAccessPresentation(flag) || flag.accessMode === "normal") return baseColor;
  return mixHexColor(baseColor, flag.accessMode === "public" ? 255 : 0, 0.52);
}

export function flagSpriteKind(
  flag: Pick<FlagSnapshot, "anchorKind" | "controlType">
): "personal_flag" | "personal_buoy" | "kingdom_banner" | "kingdom_seat" {
  if (flag.controlType === "kingdom_seat") return "kingdom_seat";
  if (flag.anchorKind === "buoy") return "personal_buoy";
  return flag.controlType === "kingdom" ? "kingdom_banner" : "personal_flag";
}

export function flagTerritoryControllerKey(
  flag: Pick<FlagSnapshot, "id" | "cityId" | "controlType" | "ownerId" | "kingdomId">
): string {
  if ((flag.controlType === "kingdom" || flag.controlType === "kingdom_seat") && flag.kingdomId) {
    return `kingdom:${flag.kingdomId}`;
  }
  if (flag.controlType === "kingdom_seat") return `kingdom-seat:${flag.id}`;
  if (flag.cityId) return `city:${flag.cityId}`;
  return `player:${flag.ownerId}`;
}

export function flagTerritoryPresentationKey(
  flag: Pick<
    FlagSnapshot,
    "accessMode" | "cityId" | "controlType" | "id" | "kingdomId" | "ownerId"
  >
): string {
  const controllerKey = flagTerritoryControllerKey(flag);
  return hasPersonalAccessPresentation(flag)
    ? `${controllerKey}:access:${flag.accessMode ?? "private"}`
    : controllerKey;
}

export function flagOwnerIndicatorColor(
  flag: Pick<FlagSnapshot, "ownerColor">
): string {
  return ownerColorForClaim(flag);
}

export function flagInteractionDisplayName(
  flag: {
    anchorKind?: FlagSnapshot["anchorKind"];
    cityId?: string | null;
    developerTestTarget?: boolean;
    name?: string;
    ownerUsername?: string | null;
    upgradeTier?: FlagSnapshot["upgradeTier"];
  }
): string {
  if (flag.name && (flag.cityId || flag.developerTestTarget)) return flag.name;
  const structure = flag.anchorKind === "buoy"
    ? "Buoy"
    : flag.upgradeTier === "atlas_shrine"
      ? "Shrine"
      : flag.upgradeTier === "tower" ? "Tower" : "Flag";
  return `${flag.ownerUsername ?? "Unknown Player"}'s ${structure}`;
}

export function flagInteractionDetail(
  flag: Pick<FlagSnapshot, "accessMode" | "cityId" | "controlType" | "jumpTollGold">
): string | null {
  if (!hasPersonalAccessPresentation(flag) || !flag.accessMode) return null;
  const mode = flag.accessMode[0]!.toUpperCase() + flag.accessMode.slice(1);
  if (flag.accessMode === "private") return mode;
  const price = BigInt(flag.jumpTollGold ?? "0") > 0n
    ? `${flag.jumpTollGold} Gold`
    : "Free";
  return `${mode} · ${price}`;
}

export function flagInteractionHeading(
  flag: {
    anchorKind?: FlagSnapshot["anchorKind"];
    cityId: string | null;
    controlType: FlagSnapshot["controlType"];
    developerTestTarget?: boolean;
    name?: string;
    ownerUsername?: string | null;
    upgradeTier?: FlagSnapshot["upgradeTier"];
  },
  access: Pick<FlagAccessSnapshot, "jumpTollGold" | "mode"> | null | undefined
): string {
  const displayName = flagInteractionDisplayName(flag);
  if (flag.developerTestTarget) return displayName;
  if (!hasPersonalAccessPresentation(flag) || !access) return displayName;
  const mode = access.mode[0]!.toUpperCase() + access.mode.slice(1);
  if (access.mode === "private") return `${displayName} (${mode})`;
  const price = BigInt(access.jumpTollGold) > 0n
    ? `${access.jumpTollGold} Gold`
    : "Free";
  return `${displayName} (${mode}) · ${price}`;
}

export function updateFlagAccessPresentation(
  flags: FlagSnapshot[],
  access: Pick<FlagAccessSnapshot, "accessRevision" | "flagId" | "jumpTollGold" | "mode">
): FlagSnapshot[] {
  let changed = false;
  const next = flags.map((flag) => {
    if (flag.id !== access.flagId || (
      flag.accessMode === access.mode &&
      flag.jumpTollGold === access.jumpTollGold &&
      flag.accessRevision === access.accessRevision
    )) return flag;
    changed = true;
    return {
      ...flag,
      accessMode: access.mode,
      jumpTollGold: access.jumpTollGold,
      accessRevision: access.accessRevision
    };
  });
  return changed ? next : flags;
}

export function upsertFlagSnapshot(
  flags: FlagSnapshot[],
  next: FlagSnapshot
): FlagSnapshot[] {
  if (!flags.some((flag) => flag.id === next.id)) return [next, ...flags];
  return flags.map((flag) => (flag.id === next.id ? next : flag));
}

export function ordinaryFlagListEntries(flags: FlagSnapshot[]): FlagSnapshot[] {
  return flags;
}

export type MapFlagSelection =
  | { kind: "flag"; flagId: string }
  | { kind: "kingdom_seat"; sourceFlagId: string; kingdomId: string };

export function mapFlagSelection(flag: FlagSnapshot): MapFlagSelection {
  if (flag.controlType === "kingdom_seat" && flag.kingdomId) {
    return { kind: "kingdom_seat", sourceFlagId: flag.id, kingdomId: flag.kingdomId };
  }
  return { kind: "flag", flagId: flag.id };
}

export function synchronizeKingdomSeatPresentation(
  flags: FlagSnapshot[],
  state: KingdomStateSnapshot | null
): FlagSnapshot[] {
  if (!state) return flags;
  const kingdoms = new Map(
    [state.kingdom, ...state.nearbyKingdoms]
      .filter((kingdom) => kingdom?.seat?.sourceFlagId)
      .map((kingdom) => [kingdom!.seat!.sourceFlagId!, kingdom!] as const)
  );
  let changed = false;
  const synchronized = flags.map((flag) => {
    if (flag.controlType !== "kingdom_seat") return flag;
    const kingdom = kingdoms.get(flag.id);
    const seat = kingdom?.seat;
    if (!kingdom || !seat) return flag;
    if (
      flag.kingdomId === kingdom.id &&
      flag.kingdomName === kingdom.displayName &&
      flag.kingdomEmblemKey === kingdom.emblemKey &&
      flag.kingdomColor === kingdom.displayColor &&
      flag.kingdomSeatId === seat.id &&
      flag.kingdomSeatConstructionState === seat.constructionState &&
      flag.kingdomSeatLat === seat.lat &&
      flag.kingdomSeatLon === seat.lon &&
      flag.claimRadiusM === seat.territoryRadiusM
    ) {
      return flag;
    }
    changed = true;
    return {
      ...flag,
      kingdomId: kingdom.id,
      kingdomName: kingdom.displayName,
      kingdomEmblemKey: kingdom.emblemKey,
      kingdomColor: kingdom.displayColor,
      kingdomSeatId: seat.id,
      kingdomSeatConstructionState: seat.constructionState,
      kingdomSeatLat: seat.lat,
      kingdomSeatLon: seat.lon,
      claimRadiusM: seat.territoryRadiusM
    };
  });
  return changed ? synchronized : flags;
}

function mixHexColor(color: string, target: 0 | 255, amount: number): string {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  return `#${channels.map((channel) => Math.max(0, Math.min(255,
    Math.round(channel * (1 - amount) + target * amount)
  )).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Player-facing structure noun for warfare actions: "City Flag", "City
 * Center", "Kingdom Flag", "Castle" for organization structures, otherwise
 * "Flag". A kingdom seat is always the Castle.
 */
export function structureWarfareStructureLabel(flag: WarfarePresentationFlag): string {
  const profile = warfarePresentationProfile(flag);
  return profile?.organization ? structureWarfareDisplayKind(profile.kind) : "Flag";
}

/**
 * Tower level and health for the flag panel and mobile sheet, for example
 * "Guard Tower Level 3 · 2,800 / 3,200 HP". Null when the flag is not a tower.
 */
export function towerStatusLabel(flag: WarfarePresentationFlag): string | null {
  const profile = warfarePresentationProfile(flag);
  if (!profile) return null;
  const obeliskLevel = profile.obeliskLevel ?? null;
  if (profile.towerLevel === null && obeliskLevel === null && profile.kind !== "war_outpost") return null;
  const name = obeliskLevel !== null
    ? `Obelisk Level ${obeliskLevel}`
    : profile.kind === "tower"
    ? `Guard Tower Level ${profile.towerLevel}`
    : profile.kind === "kingdom_tower"
      ? `Kingdom Tower Level ${profile.towerLevel}`
      : structureWarfareDisplayKind(profile.kind);
  const maximum = flag.maximumHealth ?? profile.maximumHealth;
  const current = flag.health ?? maximum;
  return `${name} · ${Math.max(0, Math.round(current)).toLocaleString("en-US")} / ` +
    `${Math.round(maximum).toLocaleString("en-US")} HP`;
}

export type TowerUpgradeOffer = Readonly<{
  targetTier: Exclude<FlagReinforcementTarget, "stone">;
  targetTowerLevel?: number;
  label: string;
}>;

/**
 * The next tower upgrade the viewer may start: the owner's next Guard Tower
 * level, or the Mayor's City Tower. The server re-checks every rule.
 */
export function towerUpgradeOffer(
  flag: WarfarePresentationFlag,
  viewer: Readonly<{ playerId: string | null | undefined; mayorOfCityId?: string | null }>
): TowerUpgradeOffer | null {
  if (flag.developerTestTarget === true || (flag.anchorKind ?? "flag") !== "flag") return null;
  if (
    flag.controlType === "personal" && flag.ownerId === viewer.playerId &&
    reinforcementLevelForPresentation(flag) === 1
  ) {
    return { targetTier: "tower", label: "Upgrade to Tower · 25 Stone" };
  }
  if (
    flag.controlType === "personal" && flag.ownerId === viewer.playerId &&
    reinforcementLevelForPresentation(flag) === 3
  ) {
    const level = flag.towerLevel ?? 1;
    if (level >= PERSONAL_GUARD_TOWER_MAX_LEVEL) return null;
    const cost = personalGuardTowerUpgradeCost(level + 1);
    if (!cost) return null;
    return {
      targetTier: "tower_level",
      targetTowerLevel: cost.targetLevel,
      label: `Build Level ${cost.targetLevel} · ${cost.iron} Iron Ore · ${cost.stone} Stone`
    };
  }
  if (
    flag.controlType === "city" && (flag.towerLevel ?? null) === null &&
    flag.cityId !== null && flag.cityId !== undefined && flag.cityId === viewer.mayorOfCityId
  ) {
    return {
      targetTier: "city_tower",
      label: `Upgrade to City Tower · ${CITY_TOWER_UPGRADE_COST.cityCoins.toLocaleString("en-US")} City Coins · ` +
        `${CITY_TOWER_UPGRADE_COST.stone} Stone`
    };
  }
  return null;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Obelisk / Kingdom Tower builds a kingdom builder (the leader) may start on
 * one of the kingdom's flags: both structures on a plain Kingdom Flag, or
 * the next level of the one already built. The server re-checks every rule.
 */
export function kingdomStructureOffers(
  flag: WarfarePresentationFlag,
  viewer: Readonly<{ buildKingdomId: string | null | undefined }>
): TowerUpgradeOffer[] {
  if (
    flag.developerTestTarget === true || (flag.anchorKind ?? "flag") !== "flag" ||
    flag.controlType !== "kingdom" || !flag.kingdomId || flag.kingdomId !== viewer.buildKingdomId ||
    (flag.warStructureKind ?? null) !== null
  ) {
    return [];
  }
  const offer = (kind: KingdomStructureKind, targetLevel: number): TowerUpgradeOffer | null => {
    const cost = kingdomStructureBuildCost(kind, targetLevel);
    if (!cost) return null;
    const name = kind === "obelisk" ? "Obelisk" : "Kingdom Tower";
    const material = cost.materialItemId === "crude_oil" ? "Crude Oil" : "Crystal";
    return {
      targetTier: kind,
      targetTowerLevel: targetLevel,
      label: `${targetLevel === 1 ? `Build ${name}` : `${name} Level ${targetLevel}`} · ` +
        `${formatCount(cost.bricks)} Bricks · ${formatCount(cost.materialQuantity)} ${material}`
    };
  };
  const obeliskLevel = flag.obeliskLevel ?? null;
  const towerLevel = flag.towerLevel ?? null;
  if (obeliskLevel !== null) {
    const next = obeliskLevel < KINGDOM_OBELISK_MAX_LEVEL ? offer("obelisk", obeliskLevel + 1) : null;
    return next ? [next] : [];
  }
  if (towerLevel !== null) {
    const next = towerLevel < KINGDOM_TOWER_MAX_LEVEL ? offer("kingdom_tower", towerLevel + 1) : null;
    return next ? [next] : [];
  }
  return [offer("obelisk", 1), offer("kingdom_tower", 1)].filter((entry): entry is TowerUpgradeOffer => entry !== null);
}

/** The kingdom whose structures the viewer may build (build permission), if any. */
export function kingdomStructureBuildKingdomId(state: KingdomStateSnapshot | null | undefined): string | null {
  return state?.membership && state.kingdom?.status === "active" &&
    state.permissions.includes("build_kingdom_structures")
    ? state.kingdom.id
    : null;
}
