import type {
  ClientMessage,
  FlagServerMessage,
  FlagSnapshot,
  WorldServerMessage
} from "@ash-atlas/shared";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { WorldGameplayClient } from "../src/client/domains/worldGameplayClient.js";
import {
  isFlagServerMessage,
  useFlagFrameHandler
} from "../src/features/flags/useFlagFrameHandler.js";
import {
  isWorldServerMessage,
  useWorldFrameHandler
} from "../src/features/world/useWorldFrameHandler.js";
import {
  type FlagBuildCountdown,
  flagBuildRemainingTimeLabel
} from "../src/flags/flagBuildCountdown.js";
import { PopulationPreparationNotice } from "../src/population/PopulationPreparationNotice.js";
import {
  emptyPopulationZoneProjection,
  idlePopulationPreparationProgress,
  populationPreparationCheckpointKey,
  populationPreparationOperationKey,
  type PopulationPreparationProgress
} from "../src/population/populationZoneProjection.js";

type StoryFrame = FlagServerMessage | WorldServerMessage;
type StoryFlagBuild = Readonly<{
  buildId: string;
  requestId: string;
  countdown: FlagBuildCountdown;
  position: { lat: number; lon: number };
  flagName?: string;
}>;

declare global {
  interface Window {
    populationStoryClientFrames: ClientMessage[];
    receivePopulationStoryFrame(message: StoryFrame): void;
  }
}

export function PopulationPreparationStory(): React.JSX.Element {
  const [flags, setFlags] = useState<FlagSnapshot[]>([]);
  const [flagBuild, setFlagBuild] = useState<StoryFlagBuild | null>(null);
  const [flagBuildClock, setFlagBuildClock] = useState(performance.now());
  const [warning, setWarning] = useState<string | null>(null);
  const [collectibles, setCollectibles] = useState([]);
  const [progress, setProgress] = useState<PopulationPreparationProgress>(
    idlePopulationPreparationProgress
  );
  const [recovery, setRecovery] = useState<{
    requestId: string;
    operationKey: string;
    checkpointKey: string;
  } | null>(null);
  const [activityRevision, setActivityRevision] = useState(0);
  const projectionRef = useRef(emptyPopulationZoneProjection());
  const renderStateRef = useRef({ collectibles: [] });
  const relocationRevisionRef = useRef(7);
  const resourceVisionRevisionRef = useRef(9);
  const lastRecoveryCheckpointRef = useRef<string | null>(null);
  window.populationStoryClientFrames ??= [];

  const worldClient = useMemo(() => new WorldGameplayClient({
    send: (message) => {
      window.populationStoryClientFrames.push(message);
      return {
        status: "sent" as const,
        readiness: "ready" as const,
        connectionGeneration: 3
      };
    }
  }), []);

  const handleFlagFrame = useFlagFrameHandler({
    firstFlagsSnapshotRef: { current: true },
    flagPlacementValidationGateRef: { current: null },
    flagBuildIntentRef: { current: null },
    setFlags,
    setCollectibles,
    setFlagBuildQueued: () => undefined,
    setFlagPlacementPreviewActive: () => undefined,
    setFlagBuild,
    setFlagBuildClock,
    setSelectedFlagId: () => undefined,
    setResourceVision: () => undefined,
    setResourceVisionStatus: () => undefined,
    setWaterHighlights: () => undefined,
    setFlagAccessRevision: () => undefined,
    setWarning,
    cancelActiveHarvest: () => undefined,
    receiveInventorySnapshot: () => undefined
  } as never);

  const handleWorldFrame = useWorldFrameHandler({
    ownPlayerId: "player-1",
    relocationRevisionRef,
    resourceVisionRevisionRef,
    populationZoneProjectionRef: projectionRef,
    setPopulationPreparationProgress: setProgress,
    renderStateRef,
    overlayRef: { current: null },
    setCollectibles,
    harvestTaskRef: { current: null },
    selectedCollectibleIdRef: { current: null },
    cancelActiveHarvest: () => undefined,
    clearOptimisticResinPresentation: () => undefined,
    setSelectedCollectibleId: () => undefined,
    setWarning,
    onPopulationResyncResult: (
      message: Extract<WorldServerMessage, { type: "POPULATION_RESYNC_RESULT" }>
    ) => {
      if (!recovery || message.requestId !== recovery.requestId) return;
      setRecovery(null);
      lastRecoveryCheckpointRef.current = null;
      if (message.preparationResult === "pending") {
        setActivityRevision((revision) => revision + 1);
      }
    }
  } as never);

  useEffect(() => {
    window.receivePopulationStoryFrame = (message) => {
      if (isFlagServerMessage(message)) {
        handleFlagFrame(message);
      } else if (isWorldServerMessage(message)) {
        handleWorldFrame(message);
      }
    };
  }, [handleFlagFrame, handleWorldFrame]);

  useEffect(() => {
    if (!flagBuild) return;
    const interval = window.setInterval(
      () => setFlagBuildClock(performance.now()),
      50
    );
    return () => window.clearInterval(interval);
  }, [flagBuild]);

  const requestRecovery = useCallback((
    current: PopulationPreparationProgress
  ): void => {
    const operation = current.operation;
    const operationKey = populationPreparationOperationKey(operation);
    const checkpointKey = populationPreparationCheckpointKey(current);
    if (
      !operation ||
      !operationKey ||
      !checkpointKey ||
      !operation.requiredForGameplay ||
      operation.scope !== "required-visible" ||
      lastRecoveryCheckpointRef.current === checkpointKey
    ) return;
    const requestId = worldClient.requestPopulationResync({
      connectionId: operation.connectionId,
      connectionGeneration: operation.connectionGeneration,
      preparationGeneration: operation.preparationGeneration,
      relocationRevision: operation.relocationRevision,
      resourceVisionRevision: operation.resourceVisionRevision,
      preparationTrigger: operation.trigger,
      preparationScope: operation.scope
    });
    if (!requestId) return;
    lastRecoveryCheckpointRef.current = checkpointKey;
    setRecovery({ requestId, operationKey, checkpointKey });
  }, [worldClient]);

  useEffect(() => {
    if (progress.status === "failed") requestRecovery(progress);
  }, [progress, requestRecovery]);

  useEffect(() => {
    if (!recovery) return;
    const operationKey = populationPreparationOperationKey(progress.operation);
    const checkpointKey = populationPreparationCheckpointKey(progress);
    if (
      progress.status === "idle" ||
      progress.status === "ready" ||
      operationKey !== recovery.operationKey ||
      checkpointKey !== recovery.checkpointKey
    ) {
      setRecovery(null);
    }
  }, [progress, recovery]);
  useEffect(() => {
    if (!recovery) return;
    const timer = window.setTimeout(() => {
      lastRecoveryCheckpointRef.current = null;
      setRecovery(null);
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [recovery]);

  const remainingTimeLabel = flagBuild
    ? flagBuildRemainingTimeLabel(flagBuild.countdown, flagBuildClock)
    : null;

  return (
    <main>
      {flagBuild ? (
        <output data-testid="flag-countdown">
          {remainingTimeLabel}
        </output>
      ) : null}
      {flags.map((flag) => (
        <strong data-testid="flag-receipt" key={flag.id}>
          Flag created: {flag.name}
        </strong>
      ))}
      <output data-testid="preparation-state">{progress.status}</output>
      <output data-testid="preparation-percent">
        {Math.round(progress.completed / Math.max(1, progress.total) * 100)}
      </output>
      {warning ? <div role="alert">{warning}</div> : null}
      <PopulationPreparationNotice
        progress={progress}
        onStale={requestRecovery}
        recovering={recovery !== null}
        activityRevision={activityRevision}
      />
      <output data-testid="collectible-count">{collectibles.length}</output>
      <button type="button">Move</button>
      <button type="button">Harvest</button>
      <button type="button">Combat</button>
    </main>
  );
}
