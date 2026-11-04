import type {
  GreenhouseBuildPreview,
  GreenhouseSnapshot,
  GreenhouseBuildSnapshot,
  GreenhouseStateSnapshot,
  ManorServerMessage,
  PlayerInventorySnapshot,
  ServerMessage
} from "@ash-atlas/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import type { GameClient } from "../../gameClient.js";
import { GreenhouseMovementTimeline } from "../../movement/greenhouseMovementTimeline.js";

export type GreenhouseServerMessage = Extract<ManorServerMessage, { type: `GREENHOUSE${string}` }>;
export type GreenhousePosition = Extract<GreenhouseServerMessage, { type: "GREENHOUSE_POSITION" }>['position'];
export type GreenhousePositionSnapshot = Readonly<{
  position: GreenhousePosition;
  movementSequence: number;
  serverTime: number;
}>;

export type GreenhouseFeatureCallbacks = Readonly<{
  onFertilizerCrafted?: (requestId: string) => void;
  onFertilizerCraftingError?: (requestId: string, message: string) => void;
}>;

const GREENHOUSE_PREVIEW_TIMEOUT_MS = 8_000;

export function isGreenhouseServerMessage(message: ServerMessage): message is GreenhouseServerMessage {
  return message.type.startsWith("GREENHOUSE");
}

export function useGreenhouseFeature(
  client: React.RefObject<GameClient | null>,
  onError: (message: string) => void,
  onInventorySnapshot?: (snapshot: PlayerInventorySnapshot) => void,
  playerId?: string | null,
  callbacks: GreenhouseFeatureCallbacks = {}
) {
  const [greenhouses, setGreenhouses] = useState<GreenhouseSnapshot[]>([]);
  const [buildPreview, setBuildPreview] = useState<GreenhouseBuildPreview | null>(null);
  const [buildPreviewRequestId, setBuildPreviewRequestId] = useState<string | null>(null);
  const [buildPreviewError, setBuildPreviewError] = useState<string | null>(null);
  const [build, setBuild] = useState<GreenhouseBuildSnapshot | null>(null);
  const [state, setState] = useState<GreenhouseStateSnapshot | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [position, setPosition] = useState<GreenhousePositionSnapshot | null>(null);
  const [fill, setFill] = useState<{ gallons: number; completesAt: number; rangeM: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buildRequestId, setBuildRequestId] = useState<string | null>(null);
  const [buildCancelRequestId, setBuildCancelRequestId] = useState<string | null>(null);
  const [buildCancellationId, setBuildCancellationId] = useState<string | null>(null);
  const [destroyRequestId, setDestroyRequestId] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const fertilizerRequestIdRef = useRef<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const buildPreviewRequestIdRef = useRef<string | null>(null);
  const buildPreviewTimeoutRef = useRef<number | null>(null);
  const buildRequestIdRef = useRef<string | null>(null);
  const activeBuildIdRef = useRef<string | null>(null);
  const buildCancelRequestIdRef = useRef<string | null>(null);
  const destroyRequestIdRef = useRef<string | null>(null);
  const ignoredBuildRequestIdsRef = useRef(new Set<string>());
  const retiredSessionIdsRef = useRef(new Set<string>());
  const movementTimelineRef = useRef(new GreenhouseMovementTimeline());
  const pendingPlantAndWaterRef = useRef<{ sessionId: string; anchorId: string; cropId: string } | null>(null);
  sessionRef.current = sessionId;
  buildRequestIdRef.current = buildRequestId;
  buildCancelRequestIdRef.current = buildCancelRequestId;
  destroyRequestIdRef.current = destroyRequestId;

  const updateBuildRequestId = useCallback((requestId: string | null): void => {
    buildRequestIdRef.current = requestId;
    setBuildRequestId(requestId);
  }, []);

  const resetSession = useCallback((): void => {
    const activeSessionId = sessionRef.current;
    if (activeSessionId) {
      retiredSessionIdsRef.current.add(activeSessionId);
    }
    sessionRef.current = null;
    movementTimelineRef.current.clear();
    setSessionId(null);
    setState(null);
    setPosition(null);
    setFill(null);
    pendingPlantAndWaterRef.current = null;
  }, []);

  const clearBuildPreviewTimeout = useCallback((): void => {
    if (buildPreviewTimeoutRef.current === null) return;
    window.clearTimeout(buildPreviewTimeoutRef.current);
    buildPreviewTimeoutRef.current = null;
  }, []);

  const previewBuild = useCallback((): string | null => {
    clearBuildPreviewTimeout();
    const requestId = client.current?.previewGreenhouseBuild() ?? null;
    if (!requestId) {
      buildPreviewRequestIdRef.current = null;
      setBuildPreviewRequestId(null);
      setBuildPreviewError("Cannot check Greenhouse placement while disconnected.");
      return null;
    }
    buildPreviewRequestIdRef.current = requestId;
    setBuildPreviewRequestId(requestId);
    setBuildPreview(null);
    setBuildPreviewError(null);
    setBuildError(null);
    setBuildCancellationId(null);
    buildPreviewTimeoutRef.current = window.setTimeout(() => {
      if (buildPreviewRequestIdRef.current !== requestId) return;
      buildPreviewRequestIdRef.current = null;
      buildPreviewTimeoutRef.current = null;
      setBuildPreviewRequestId(null);
      setBuildPreviewError("Placement check timed out. Check again before building.");
    }, GREENHOUSE_PREVIEW_TIMEOUT_MS);
    return requestId;
  }, [clearBuildPreviewTimeout, client]);

  useEffect(() => clearBuildPreviewTimeout, [clearBuildPreviewTimeout]);
  useEffect(() => () => movementTimelineRef.current.clear(), []);

  const isCurrentBuildRequest = useCallback((requestId: string): boolean => {
    if (ignoredBuildRequestIdsRef.current.has(requestId)) return false;
    const current = buildRequestIdRef.current;
    return current === null || current === requestId;
  }, []);

  const handleServerMessage = useCallback((message: GreenhouseServerMessage): void => {
    switch (message.type) {
      case "GREENHOUSES_SNAPSHOT":
        setGreenhouses(message.greenhouses);
        if (buildRequestIdRef.current && playerId && message.greenhouses.some((greenhouse) => greenhouse.ownerPlayerId === playerId)) {
          ignoredBuildRequestIdsRef.current.add(buildRequestIdRef.current);
          updateBuildRequestId(null);
          activeBuildIdRef.current = null;
          setBuild(null);
        }
        return;
      case "GREENHOUSE_BUILD_PREVIEW":
        if (buildPreviewRequestIdRef.current !== message.requestId) return;
        clearBuildPreviewTimeout();
        buildPreviewRequestIdRef.current = null;
        setBuildPreviewRequestId(null);
        setBuildPreview(message.preview);
        setBuildPreviewError(null);
        return;
      case "GREENHOUSE_BUILD_STARTED":
        if (!isCurrentBuildRequest(message.requestId)) return;
        clearBuildPreviewTimeout();
        updateBuildRequestId(message.requestId);
        activeBuildIdRef.current = message.build.buildId;
        buildPreviewRequestIdRef.current = null;
        setBuildPreviewRequestId(null);
        setBuildPreview(null);
        setBuildPreviewError(null);
        setBuildCancellationId(null);
        setBuild(message.build);
        setBuildError(null);
        onInventorySnapshot?.(message.inventory);
        return;
      case "GREENHOUSE_BUILD_RESULT":
        if (!isCurrentBuildRequest(message.requestId)) return;
        ignoredBuildRequestIdsRef.current.add(message.requestId);
        updateBuildRequestId(null);
        activeBuildIdRef.current = null;
        setBuild(null);
        setBuildError(null);
        onInventorySnapshot?.(message.inventory);
        setGreenhouses((current) => [
          ...current.filter((greenhouse) => greenhouse.greenhouseId !== message.greenhouse.greenhouseId),
          message.greenhouse
        ]);
        return;
      case "GREENHOUSE_BUILD_CANCELLED":
        if (activeBuildIdRef.current !== null && activeBuildIdRef.current !== message.buildId) return;
        if (activeBuildIdRef.current === null && buildRequestIdRef.current !== null && buildRequestIdRef.current !== message.requestId) return;
        ignoredBuildRequestIdsRef.current.add(message.requestId);
        updateBuildRequestId(null);
        activeBuildIdRef.current = null;
        buildCancelRequestIdRef.current = null;
        setBuildCancelRequestId(null);
        setBuild(null);
        setBuildError(null);
        setBuildCancellationId(message.buildId);
        setError(null);
        onInventorySnapshot?.(message.inventory);
        return;
      case "GREENHOUSE_DESTROY_RESULT":
        if (destroyRequestIdRef.current === message.requestId) {
          destroyRequestIdRef.current = null;
          setDestroyRequestId(null);
        }
        setGreenhouses((current) => current.filter((greenhouse) => greenhouse.greenhouseId !== message.greenhouseId));
        return;
      case "GREENHOUSE_STATE":
        client.current?.rememberGreenhouse(message.state.greenhouse.greenhouseId);
        setState(message.state);
        onInventorySnapshot?.(message.state.inventory);
        return;
      case "GREENHOUSE_POSITION":
        if (retiredSessionIdsRef.current.has(message.greenhouseSessionId)) return;
        if (sessionRef.current && message.greenhouseSessionId !== sessionRef.current) return;
        if (movementTimelineRef.current.currentSessionId() !== message.greenhouseSessionId) {
          movementTimelineRef.current.start(
            message.greenhouseSessionId,
            message.position,
            message.movementSequence,
            message.serverTime,
            performance.now()
          );
        } else if (movementTimelineRef.current.applySnapshot(
          message.greenhouseSessionId,
          message.position,
          message.movementSequence,
          message.serverTime,
          performance.now()
        ) === "ignored") return;
        sessionRef.current = message.greenhouseSessionId;
        setSessionId(message.greenhouseSessionId);
        setPosition({
          position: message.position,
          movementSequence: message.movementSequence,
          serverTime: message.serverTime
        });
        return;
      case "GREENHOUSE_MUTATION_RESULT":
        setState(message.state);
        onInventorySnapshot?.(message.inventory);
        if (message.action === "plant") {
          const pending = pendingPlantAndWaterRef.current;
          if (pending && pending.sessionId === sessionRef.current) {
            pendingPlantAndWaterRef.current = null;
            const waterRequestId = client.current?.waterGreenhouse(pending.sessionId, pending.anchorId) ?? null;
            if (!waterRequestId) {
              setError("Cannot water while disconnected.");
              onError("Cannot water while disconnected.");
            }
          }
        }
        return;
      case "GREENHOUSE_BUCKET_RESULT":
        onInventorySnapshot?.(message.inventory);
        setState((current) => current ? {
          ...current,
          waterBucketGallons: message.waterBucketGallons,
          gardeningBucketGallons: message.gardeningBucketGallons,
          inventory: message.inventory
        } : current);
        return;
      case "GREENHOUSE_FERTILIZER_RESULT":
        onInventorySnapshot?.(message.inventory);
        if (fertilizerRequestIdRef.current === message.requestId) {
          fertilizerRequestIdRef.current = null;
          callbacks.onFertilizerCrafted?.(message.requestId);
        }
        return;
      case "GREENHOUSE_WATER_FILL_STARTED":
        setFill({ gallons: message.gallons, completesAt: message.completesAt, rangeM: message.rangeM });
        return;
      case "GREENHOUSE_WATER_FILL_RESULT":
        setFill(null);
        onInventorySnapshot?.(message.inventory);
        setState((current) => current ? { ...current, waterBucketGallons: message.waterBucketGallons, inventory: message.inventory } : current);
        return;
      case "GREENHOUSE_ERROR":
        if (message.requestId && fertilizerRequestIdRef.current === message.requestId) {
          fertilizerRequestIdRef.current = null;
          callbacks.onFertilizerCraftingError?.(message.requestId, message.message);
        }
        if (message.requestId && buildPreviewRequestIdRef.current === message.requestId) {
          clearBuildPreviewTimeout();
          buildPreviewRequestIdRef.current = null;
          setBuildPreviewRequestId(null);
          setBuildPreviewError(message.message);
        }
        if (message.requestId && buildCancelRequestIdRef.current === message.requestId) {
          buildCancelRequestIdRef.current = null;
          setBuildCancelRequestId(null);
        }
        if (message.requestId && destroyRequestIdRef.current === message.requestId) {
          destroyRequestIdRef.current = null;
          setDestroyRequestId(null);
        }
        if (message.requestId && buildRequestIdRef.current === message.requestId) {
          ignoredBuildRequestIdsRef.current.add(message.requestId);
          updateBuildRequestId(null);
          activeBuildIdRef.current = null;
          setBuild(null);
          setBuildError(message.message);
        }
        setError(message.message);
        onError(message.message);
        return;
    }
  }, [callbacks, clearBuildPreviewTimeout, isCurrentBuildRequest, onError, onInventorySnapshot, playerId, updateBuildRequestId]);

  const request = useCallback((action: () => string | null, failure: string): string | null => {
    const requestId = action();
    if (!requestId) {
      setError(failure);
      onError(failure);
    } else {
      setError(null);
    }
    return requestId;
  }, [onError]);

  return {
    greenhouses,
    buildPreview,
    buildPreviewRequestId,
    buildPreviewError,
    build,
    state,
    sessionId,
    position,
    fill,
    error,
    buildRequestId,
    buildCancelRequestId,
    buildCancellationId,
    destroyRequestId,
    buildError,
    movementTimeline: movementTimelineRef.current,
    resetSession,
    handleServerMessage,
    previewBuild,
    buildGreenhouse: () => {
      const requestId = client.current?.buildGreenhouse() ?? null;
      if (!requestId) {
        clearBuildPreviewTimeout();
        setBuildError("Cannot build while disconnected.");
        setError("Cannot build while disconnected.");
        onError("Cannot build while disconnected.");
      } else {
        clearBuildPreviewTimeout();
        updateBuildRequestId(requestId);
        buildPreviewRequestIdRef.current = null;
        setBuildPreviewRequestId(null);
        setBuildPreview(null);
        setBuildPreviewError(null);
        setBuildCancellationId(null);
        setBuildError(null);
        setError(null);
      }
      return requestId;
    },
    cancelBuild: () => {
      const requestId = client.current?.cancelGreenhouseBuild() ?? null;
      if (!requestId) {
        setBuildError("Cannot cancel while disconnected.");
        setError("Cannot cancel while disconnected.");
        onError("Cannot cancel while disconnected.");
      } else {
        buildCancelRequestIdRef.current = requestId;
        setBuildCancelRequestId(requestId);
        setError(null);
      }
      return requestId;
    },
    destroy: (greenhouseId: string) => {
      const requestId = client.current?.destroyGreenhouse(greenhouseId) ?? null;
      if (!requestId) {
        setError("Cannot destroy while disconnected.");
        onError("Cannot destroy while disconnected.");
      } else {
        destroyRequestIdRef.current = requestId;
        setDestroyRequestId(requestId);
        setError(null);
      }
      return requestId;
    },
    enter: (greenhouseId: string) => request(() => client.current?.enterGreenhouse(greenhouseId) ?? null, "Cannot enter while disconnected."),
    exit: () => request(() => client.current?.exitGreenhouse(sessionRef.current ?? "") ?? null, "Cannot exit while disconnected."),
    move: (x: number, y: number) => request(() => sessionRef.current ? client.current?.greenhouseMoveTo(sessionRef.current, x, y) ?? null : null, "Cannot move while disconnected."),
    plant: (anchorId: string, cropId: string) => request(() => sessionRef.current ? client.current?.plantGreenhouse(sessionRef.current, anchorId, cropId) ?? null : null, "Cannot plant while disconnected."),
    plantAndWater: (anchorId: string, cropId: string) => {
      const session = sessionRef.current;
      if (!session || !client.current) {
        setError("Cannot plant while disconnected.");
        onError("Cannot plant while disconnected.");
        return null;
      }
      pendingPlantAndWaterRef.current = { sessionId: session, anchorId, cropId };
      const plantRequestId = client.current.plantGreenhouse(session, anchorId, cropId);
      if (!plantRequestId) {
        pendingPlantAndWaterRef.current = null;
        setError("Cannot plant and water while disconnected.");
        onError("Cannot plant and water while disconnected.");
        return null;
      }
      setError(null);
      return plantRequestId;
    },
    water: (anchorId: string) => request(() => sessionRef.current ? client.current?.waterGreenhouse(sessionRef.current, anchorId) ?? null : null, "Cannot water while disconnected."),
    clip: (anchorId: string) => request(() => sessionRef.current ? client.current?.clipGreenhouse(sessionRef.current, anchorId) ?? null : null, "Cannot take a clipping while disconnected."),
    harvest: (anchorId: string) => request(() => sessionRef.current ? client.current?.harvestGreenhouse(sessionRef.current, anchorId) ?? null : null, "Cannot harvest while disconnected."),
    tapTree: (anchorId: string) => request(() => sessionRef.current ? client.current?.tapGreenhouseTree(sessionRef.current, anchorId) ?? null : null, "Cannot tap resin while disconnected."),
    place: (placementKind: "pot" | "water_tank", x: number, y: number, anchorId?: string) => request(
      () => sessionRef.current ? client.current?.greenhouse.placeGreenhouse(sessionRef.current, placementKind, x, y, anchorId) ?? null : null,
      "Cannot place greenhouse objects while disconnected."
    ),
    depositWater: () => request(() => sessionRef.current ? client.current?.depositGreenhouseWater(sessionRef.current) ?? null : null, "Cannot deposit water while disconnected."),
    refillGardeningBucket: () => request(() => sessionRef.current ? client.current?.refillGardeningBucket(sessionRef.current) ?? null : null, "Cannot refill while disconnected."),
    craftWaterBucket: () => request(() => client.current?.craftWaterBucket() ?? null, "Cannot craft while disconnected."),
    craftFertilizer: () => {
      const requestId = client.current?.craftFertilizer() ?? null;
      if (!requestId) {
        setError("Cannot craft Fertilizer while disconnected.");
        onError("Cannot craft Fertilizer while disconnected.");
      } else {
        fertilizerRequestIdRef.current = requestId;
        setError(null);
      }
      return requestId;
    },
    fillWaterBucket: (lat: number, lon: number, gallons: number) => request(() => client.current?.fillWaterBucket(lat, lon, gallons) ?? null, "Cannot fill while disconnected."),
    cancelWaterBucketFill: () => request(() => client.current?.cancelWaterBucketFill() ?? null, "Cannot cancel while disconnected.")
  };
}
