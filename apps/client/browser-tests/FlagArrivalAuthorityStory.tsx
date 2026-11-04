import type {
  CollectibleNode,
  FlagSnapshot,
  PlayerSnapshot
} from "@ash-atlas/shared";
import { useRef, useState } from "react";

import { CombatStore } from "../src/combat/combatStore.js";
import { WorldResourcePresentationStore } from "../src/collectibles/worldResourcePresentationStore.js";
import { useFlagFrameHandler } from "../src/features/flags/useFlagFrameHandler.js";
import { useHarvestingFrameHandler } from "../src/features/harvesting/useHarvestingFrameHandler.js";
import { useTravelFrameHandler } from "../src/features/travel/useTravelFrameHandler.js";
import { emptyPopulationZoneProjection } from "../src/population/populationZoneProjection.js";

const PLAYER_ID = "player-1";
const FLAG_A = flag("flag-a", "Flag A", 35, -106);
const FLAG_B = flag("flag-b", "Flag B", 36, -105);
const NEW_FLAG = flag("flag-new", "New Flag", 36.001, -104.999);

export function FlagArrivalAuthorityStory(): React.JSX.Element {
  const [flags, setFlags] = useState<FlagSnapshot[]>([FLAG_A, FLAG_B]);
  const [player, setPlayer] = useState(() => playerAt(FLAG_A, 0));
  const [collectibles, setCollectibles] = useState<CollectibleNode[]>([]);
  const [mobCount, setMobCount] = useState(0);
  const [cameraCenters, setCameraCenters] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);
  const localPlayerRef = useRef<PlayerSnapshot | null>(player);
  const relocationRevisionRef = useRef(0);
  const resourceVisionRevisionRef = useRef(0);
  const gameplayViewGenerationRef = useRef(0);
  const renderStateRef = useRef({
    collectibles: [] as CollectibleNode[],
    selectedCollectibleId: null
  });
  const presentationStoreRef = useRef(new WorldResourcePresentationStore());
  const combatStoreRef = useRef(new CombatStore());
  const completedTravelArrivalRequestIdsRef = useRef(new Set<string>());
  const pendingTravelRequestIdRef = useRef<string | null>(null);
  const postArrivalTravelRequestIdRef = useRef<string | null>(null);
  const postArrivalTravelRequestExpiresAtRef = useRef(0);

  const handleFlagFrame = useFlagFrameHandler({
    firstFlagsSnapshotRef: { current: true },
    flagPlacementValidationGateRef: { current: null },
    flagBuildIntentRef: { current: null },
    setFlags,
    setFlagBuild: () => undefined,
    setWarning,
    setResourceVision: () => undefined,
    setResourceVisionStatus: () => undefined
  } as never);

  const handleTravelFrame = useTravelFrameHandler({
    observeManorTravelResult: () => undefined,
    completedTravelArrivalRequestIdsRef,
    pendingTravelRequestIdRef,
    postArrivalTravelRequestIdRef,
    postArrivalTravelRequestExpiresAtRef,
    localPlayerRef,
    localMovementRequests: {
      discardBoundTo: () => undefined
    },
    playerRenderTimeline: {
      snapPlayer: () => false
    },
    installCommittedWorldViewEpoch: (
      nextPlayer: PlayerSnapshot,
      resourceVisionRevision = 0
    ) => {
      if (
        (nextPlayer.relocationRevision ?? 0)
        <= relocationRevisionRef.current
      ) {
        return "same-epoch-already-installed";
      }
      relocationRevisionRef.current =
        nextPlayer.relocationRevision ?? 0;
      resourceVisionRevisionRef.current = resourceVisionRevision;
      gameplayViewGenerationRef.current += 1;
      presentationStoreRef.current = new WorldResourcePresentationStore();
      renderStateRef.current.collectibles = [];
      setCollectibles([]);
      return "new-epoch-installed";
    },
    setPlayers: (update: (
      current: PlayerSnapshot[]
    ) => PlayerSnapshot[]) => {
      const next = update([localPlayerRef.current ?? player]);
      const ownPlayer = next.find((candidate) =>
        candidate.playerId === PLAYER_ID
      );
      if (ownPlayer) setPlayer(ownPlayer);
    },
    setDevWalletGold: () => undefined,
    setSelectedCityId: () => undefined,
    setSelectedFlagId: () => undefined,
    setFlagListOpen: () => undefined,
    setWarning,
    centerCamera: () => setCameraCenters((current) => current + 1),
    showActionError: setWarning
  } as never);

  const handleHarvestingFrame = useHarvestingFrameHandler({
    ownPlayerId: PLAYER_ID,
    localPlayerRef,
    relocationRevisionRef,
    resourceVisionRevisionRef,
    gameplayViewGenerationRef,
    renderStateRef,
    presentationStoreRef,
    populationZoneProjectionRef: {
      current: emptyPopulationZoneProjection()
    },
    harvestTaskRef: { current: null },
    selectedCollectibleIdRef: { current: null },
    surveyStartedAtRef: { current: null },
    overlayRef: { current: null },
    setCollectibles,
    setSelectedCollectibleId: () => undefined,
    setResourceVision: () => undefined,
    setResourceVisionStatus: () => undefined,
    setWaterHighlights: () => undefined,
    cancelActiveHarvest: () => undefined,
    clearOptimisticResinPresentation: () => undefined
  } as never);

  const jump = (destination: FlagSnapshot, revision: number): void => {
    const requestId = `visit-${destination.id}`;
    const nextPlayer = playerAt(destination, revision);
    const resourceVisionRevision = revision + 10;
    handleTravelFrame({
      type: "FLAG_VISITED",
      requestId,
      flagId: destination.id,
      player: nextPlayer,
      resourceVisionRevision
    } as never);
    handleHarvestingFrame({
      type: "COLLECTIBLES_SNAPSHOT",
      playerId: PLAYER_ID,
      relocationRevision: revision,
      resourceVisionRevision,
      authority: {
        snapshotId: `snapshot-${destination.id}`,
        snapshotGeneration: revision,
        gameplayViewGeneration: gameplayViewGenerationRef.current,
        scope: { kind: "flag", id: destination.id },
        includedDomains: ["population", "repeatable-resource"],
        completeness: "complete",
        ordinaryNodesTruncated: false,
        returnedCount: 2,
        authoritativeTotalCount: 2
      },
      serverTime: revision,
      visibleRadiusM: 650,
      activationRadiusM: 650,
      resourceVision: resourceVision(destination),
      resourceVisionStatus: null,
      waterHighlights: [],
      nodes: [
        tree(`${destination.id}-tree-1`, destination),
        tree(`${destination.id}-tree-2`, destination)
      ],
      repeatableNodes: []
    });
    combatStoreRef.current.applySnapshot({
      serverTick: revision,
      serverTime: revision,
      sequence: revision,
      upserts: ["wolf-1", "wolf-2"].map((entityId) => ({
        entityId,
        kind: "mob",
        archetypeKey: "wolf",
        name: entityId,
        level: 1,
        regionCode: "test",
        zoneId: destination.id,
        lat: destination.lat,
        lon: destination.lon,
        maxHealth: 100,
        currentHealth: 100,
        lifeState: "alive",
        activityState: "idle",
        targetEntityId: null,
        revision
      })),
      removedEntityIds: [],
      events: []
    });
    setMobCount(combatStoreRef.current.entities().length);
  };

  const buildFlag = (): void => {
    handleFlagFrame({
      type: "FLAG_CREATED",
      requestId: "build-new-flag",
      buildId: "build-1",
      flag: NEW_FLAG,
      flagSetRevision: 2
    } as never);
  };

  return <main>
    <button onClick={() => jump(FLAG_B, 1)}>Jump to Flag B</button>
    <button onClick={buildFlag}>Build New Flag</button>
    <button onClick={() => jump(NEW_FLAG, 2)}>Jump to New Flag</button>
    <output aria-label="current flag">{player.currentFlagId ?? "none"}</output>
    <output aria-label="anchor">
      {player.anchorLat},{player.anchorLon}
    </output>
    <output aria-label="trees">{collectibles.length}</output>
    <output aria-label="mobs">{mobCount}</output>
    <output aria-label="camera centers">{cameraCenters}</output>
    <output aria-label="catalogue">
      {flags.map((candidate) => candidate.id).sort().join(",")}
    </output>
    <output aria-label="warning">{warning ?? "none"}</output>
  </main>;
}

function flag(
  id: string,
  name: string,
  lat: number,
  lon: number
): FlagSnapshot {
  return {
    id,
    controlType: "personal",
    ownerId: PLAYER_ID,
    ownerUsername: "Player",
    ownerColor: "#38bdf8",
    name,
    lat,
    lon,
    packageId: "test",
    elevationM: 0,
    terrainClass: "flat",
    biome: "forest",
    ecoregion: "forest",
    claimRadiusM: 1_000,
    cityId: null,
    createdAt: "2026-07-26T00:00:00.000Z"
  };
}

function playerAt(
  destination: FlagSnapshot,
  relocationRevision: number
): PlayerSnapshot {
  return {
    playerId: PLAYER_ID,
    username: "Player",
    displayColor: "#38bdf8",
    regionCode: "test",
    zoneId: "world",
    lat: destination.lat,
    lon: destination.lon,
    anchorLat: destination.lat,
    anchorLon: destination.lon,
    moveLeashRadiusM: 600,
    movementRevision: relocationRevision,
    relocationRevision,
    currentFlagId: destination.id,
    currentKingdomSeatId: null,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: "2026-07-26T00:00:00.000Z"
  };
}

function resourceVision(destination: FlagSnapshot) {
  return {
    flagId: destination.id,
    flagName: destination.name,
    center: { lat: destination.lat, lon: destination.lon },
    movementLeashRadiusM: 600,
    paddingM: 50,
    radiusM: 650
  };
}

function tree(id: string, destination: FlagSnapshot): CollectibleNode {
  return {
    id,
    type: "wood",
    lat: destination.lat,
    lon: destination.lon,
    quantity: 4,
    state: "available",
    createdAt: "2026-07-26T00:00:00.000Z",
    harvestedAt: null,
    sourceCellId: `population:${destination.id}`,
    waterKind: null,
    presentationOwner: "population",
    treeLifeRevision: 1
  };
}
