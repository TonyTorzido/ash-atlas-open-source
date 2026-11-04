export type FlagTravelPresentationEvent =
  | "flag-visited-received"
  | "origin-presentation-frozen"
  | "camera-motion-started"
  | "camera-moveend"
  | "destination-data-ready"
  | "destination-map-painted"
  | "destination-map-paint-fallback"
  | "presentation-deadline-released"
  | "presentation-authority-reset"
  | "destination-state-committed"
  | "first-destination-pixi-paint";

export type FlagTravelPresentationMetrics = Readonly<{
  blankOverlayFrameCount: number;
  flagsVisibleFrameCount: number;
  leashVisibleFrameCount: number;
  mobsWithoutStaticWorldFrameCount: number;
  retainedObjectCount: number;
  committedDestinationCount: number;
  originLocalPlayerPosition: Readonly<{ x: number; y: number }> | null;
  currentLocalPlayerPosition: Readonly<{ x: number; y: number }> | null;
  destinationLocalPlayerPosition: Readonly<{ x: number; y: number }> | null;
  maxLocalPlayerDriftPx: number;
  plannedLocalPlayerPosition: Readonly<{ x: number; y: number }> | null;
  actualLocalPlayerPosition: Readonly<{ x: number; y: number }> | null;
  maxLocalPlayerPathErrorPx: number;
  finalPreCommitPlayerPosition: Readonly<{ x: number; y: number }> | null;
  destinationCommittedPlayerPosition: Readonly<{ x: number; y: number }> | null;
  destinationCommitSnapDistancePx: number;
  maximumPerFramePlayerDisplacementPx: number;
  localPlayerParent: "localPlayerLayer" | "worldDynamicEntityLayer" | "other" | null;
  localPlayerRetainedCount: number;
  localPlayerOutsideViewportFrameCount: number;
  cameraGeneration: number | null;
  cameraPlan: "atomic" | "continuous" | "correction" | "reduced-motion" | null;
  cameraDurationMs: number | null;
  projectedDistancePx: number | null;
  viewportDistance: number | null;
}>;

type FrameObservation = Readonly<{
  flagsVisible: boolean;
  leashVisible: boolean;
  mobsVisible: boolean;
  retainedObjectCount: number;
  plannedLocalPlayerPosition: Readonly<{ x: number; y: number }> | null;
  localPlayerPosition: Readonly<{ x: number; y: number }> | null;
  localPlayerParent: "localPlayerLayer" | "worldDynamicEntityLayer" | "other" | null;
  localPlayerRetainedCount: number;
  localPlayerInsideViewport: boolean;
  destination?: boolean;
  finalPreCommit?: boolean;
}>;

declare global {
  interface Window {
    __ASH_ATLAS_FLAG_TRAVEL_PRESENTATION_OBSERVER__?: (
      event: FlagTravelPresentationEvent,
      metrics: FlagTravelPresentationMetrics
    ) => void;
    __ASH_ATLAS_FLAG_TRAVEL_PRESENTATION_METRICS__?: FlagTravelPresentationMetrics;
  }
}

export class FlagTravelPresentationInstrumentation {
  private activeTrace: Readonly<{
    traceId: string;
    relocationRevision: number;
  }> | null = null;
  private blankOverlayFrameCount = 0;
  private flagsVisibleFrameCount = 0;
  private leashVisibleFrameCount = 0;
  private mobsWithoutStaticWorldFrameCount = 0;
  private retainedObjectCount = 0;
  private committedDestinationCount = 0;
  private originLocalPlayerPosition: Readonly<{ x: number; y: number }> | null = null;
  private currentLocalPlayerPosition: Readonly<{ x: number; y: number }> | null = null;
  private destinationLocalPlayerPosition: Readonly<{ x: number; y: number }> | null = null;
  private maxLocalPlayerDriftPx = 0;
  private plannedLocalPlayerPosition: Readonly<{ x: number; y: number }> | null = null;
  private actualLocalPlayerPosition: Readonly<{ x: number; y: number }> | null = null;
  private maxLocalPlayerPathErrorPx = 0;
  private finalPreCommitPlayerPosition: Readonly<{ x: number; y: number }> | null = null;
  private destinationCommittedPlayerPosition: Readonly<{ x: number; y: number }> | null = null;
  private destinationCommitSnapDistancePx = 0;
  private maximumPerFramePlayerDisplacementPx = 0;
  private previousLocalPlayerPosition: Readonly<{ x: number; y: number }> | null = null;
  private localPlayerParent: "localPlayerLayer" | "worldDynamicEntityLayer" | "other" | null = null;
  private localPlayerRetainedCount = 0;
  private localPlayerOutsideViewportFrameCount = 0;
  private cameraGeneration: number | null = null;
  private cameraPlan: FlagTravelPresentationMetrics["cameraPlan"] = null;
  private cameraDurationMs: number | null = null;
  private projectedDistancePx: number | null = null;
  private viewportDistance: number | null = null;

  reset(): void {
    this.blankOverlayFrameCount = 0;
    this.flagsVisibleFrameCount = 0;
    this.leashVisibleFrameCount = 0;
    this.mobsWithoutStaticWorldFrameCount = 0;
    this.retainedObjectCount = 0;
    this.committedDestinationCount = 0;
    this.originLocalPlayerPosition = null;
    this.currentLocalPlayerPosition = null;
    this.destinationLocalPlayerPosition = null;
    this.maxLocalPlayerDriftPx = 0;
    this.plannedLocalPlayerPosition = null;
    this.actualLocalPlayerPosition = null;
    this.maxLocalPlayerPathErrorPx = 0;
    this.finalPreCommitPlayerPosition = null;
    this.destinationCommittedPlayerPosition = null;
    this.destinationCommitSnapDistancePx = 0;
    this.maximumPerFramePlayerDisplacementPx = 0;
    this.previousLocalPlayerPosition = null;
    this.localPlayerParent = null;
    this.localPlayerRetainedCount = 0;
    this.localPlayerOutsideViewportFrameCount = 0;
    this.cameraGeneration = null;
    this.cameraPlan = null;
    this.cameraDurationMs = null;
    this.projectedDistancePx = null;
    this.viewportDistance = null;
    this.publish();
  }

  beginTrace(traceId: string, relocationRevision: number): void {
    this.activeTrace = { traceId, relocationRevision };
  }

  cancelTrace(): void {
    this.activeTrace = null;
  }

  setCameraGeneration(generation: number): void {
    this.cameraGeneration = generation;
    this.publish();
  }

  setCameraPlan(input: Readonly<{
    plan: NonNullable<FlagTravelPresentationMetrics["cameraPlan"]>;
    durationMs: number | null;
    projectedDistancePx: number;
    viewportDistance: number;
  }>): void {
    this.cameraPlan = input.plan;
    this.cameraDurationMs = input.durationMs;
    this.projectedDistancePx = input.projectedDistancePx;
    this.viewportDistance = input.viewportDistance;
    this.publish();
  }

  event(event: FlagTravelPresentationEvent): void {
    if (event === "destination-state-committed") {
      this.committedDestinationCount += 1;
    }
    const metrics = this.publish();
    const traceName = PRESENTATION_TRACE_EVENT_NAMES[event];
    if (this.activeTrace && traceName) {
      gameplayLatencyTrace.record("ui", traceName, {
        relocationRevision: this.activeTrace.relocationRevision,
        cameraGeneration: metrics.cameraGeneration,
        retainedObjectCount: metrics.retainedObjectCount,
        committedDestinationCount: metrics.committedDestinationCount
      }, { traceId: this.activeTrace.traceId });
      if (event === "first-destination-pixi-paint") {
        this.activeTrace = null;
      }
    }
    if (typeof window !== "undefined") {
      window.__ASH_ATLAS_FLAG_TRAVEL_PRESENTATION_OBSERVER__?.(event, metrics);
    }
  }

  frame(observation: FrameObservation): void {
    if (observation.flagsVisible) this.flagsVisibleFrameCount += 1;
    if (observation.leashVisible) this.leashVisibleFrameCount += 1;
    if (
      observation.mobsVisible &&
      (!observation.flagsVisible || !observation.leashVisible)
    ) {
      this.mobsWithoutStaticWorldFrameCount += 1;
    }
    this.retainedObjectCount = observation.retainedObjectCount;
    this.plannedLocalPlayerPosition = observation.plannedLocalPlayerPosition;
    this.currentLocalPlayerPosition = observation.localPlayerPosition;
    this.actualLocalPlayerPosition = observation.localPlayerPosition;
    this.localPlayerParent = observation.localPlayerParent;
    this.localPlayerRetainedCount = observation.localPlayerRetainedCount;
    if (
      observation.localPlayerPosition &&
      this.originLocalPlayerPosition === null
    ) {
      this.originLocalPlayerPosition = observation.localPlayerPosition;
    }
    if (observation.localPlayerPosition && this.originLocalPlayerPosition) {
      this.maxLocalPlayerDriftPx = Math.max(
        this.maxLocalPlayerDriftPx,
        Math.hypot(
          observation.localPlayerPosition.x - this.originLocalPlayerPosition.x,
          observation.localPlayerPosition.y - this.originLocalPlayerPosition.y
        )
      );
    }
    if (
      observation.localPlayerPosition &&
      observation.plannedLocalPlayerPosition
    ) {
      this.maxLocalPlayerPathErrorPx = Math.max(
        this.maxLocalPlayerPathErrorPx,
        Math.hypot(
          observation.localPlayerPosition.x -
            observation.plannedLocalPlayerPosition.x,
          observation.localPlayerPosition.y -
            observation.plannedLocalPlayerPosition.y
        )
      );
    }
    if (observation.localPlayerPosition && this.previousLocalPlayerPosition) {
      this.maximumPerFramePlayerDisplacementPx = Math.max(
        this.maximumPerFramePlayerDisplacementPx,
        Math.hypot(
          observation.localPlayerPosition.x -
            this.previousLocalPlayerPosition.x,
          observation.localPlayerPosition.y -
            this.previousLocalPlayerPosition.y
        )
      );
    }
    this.previousLocalPlayerPosition = observation.localPlayerPosition;
    if (
      observation.localPlayerPosition &&
      !observation.localPlayerInsideViewport
    ) {
      this.localPlayerOutsideViewportFrameCount += 1;
    }
    if (observation.destination) {
      this.destinationLocalPlayerPosition = observation.localPlayerPosition;
      this.destinationCommittedPlayerPosition =
        observation.localPlayerPosition;
      if (
        observation.localPlayerPosition &&
        this.finalPreCommitPlayerPosition
      ) {
        this.destinationCommitSnapDistancePx = Math.hypot(
          observation.localPlayerPosition.x -
            this.finalPreCommitPlayerPosition.x,
          observation.localPlayerPosition.y -
            this.finalPreCommitPlayerPosition.y
        );
      }
    }
    if (observation.finalPreCommit) {
      this.finalPreCommitPlayerPosition = observation.localPlayerPosition;
    }
    this.publish();
  }

  snapshot(): FlagTravelPresentationMetrics {
    return {
      blankOverlayFrameCount: this.blankOverlayFrameCount,
      flagsVisibleFrameCount: this.flagsVisibleFrameCount,
      leashVisibleFrameCount: this.leashVisibleFrameCount,
      mobsWithoutStaticWorldFrameCount: this.mobsWithoutStaticWorldFrameCount,
      retainedObjectCount: this.retainedObjectCount,
      committedDestinationCount: this.committedDestinationCount,
      originLocalPlayerPosition: this.originLocalPlayerPosition,
      currentLocalPlayerPosition: this.currentLocalPlayerPosition,
      destinationLocalPlayerPosition: this.destinationLocalPlayerPosition,
      maxLocalPlayerDriftPx: this.maxLocalPlayerDriftPx,
      plannedLocalPlayerPosition: this.plannedLocalPlayerPosition,
      actualLocalPlayerPosition: this.actualLocalPlayerPosition,
      maxLocalPlayerPathErrorPx: this.maxLocalPlayerPathErrorPx,
      finalPreCommitPlayerPosition: this.finalPreCommitPlayerPosition,
      destinationCommittedPlayerPosition:
        this.destinationCommittedPlayerPosition,
      destinationCommitSnapDistancePx:
        this.destinationCommitSnapDistancePx,
      maximumPerFramePlayerDisplacementPx:
        this.maximumPerFramePlayerDisplacementPx,
      localPlayerParent: this.localPlayerParent,
      localPlayerRetainedCount: this.localPlayerRetainedCount,
      localPlayerOutsideViewportFrameCount:
        this.localPlayerOutsideViewportFrameCount,
      cameraGeneration: this.cameraGeneration,
      cameraPlan: this.cameraPlan,
      cameraDurationMs: this.cameraDurationMs,
      projectedDistancePx: this.projectedDistancePx,
      viewportDistance: this.viewportDistance
    };
  }

  private publish(): FlagTravelPresentationMetrics {
    const metrics = this.snapshot();
    if (typeof window !== "undefined") {
      window.__ASH_ATLAS_FLAG_TRAVEL_PRESENTATION_METRICS__ = metrics;
    }
    return metrics;
  }
}

const PRESENTATION_TRACE_EVENT_NAMES: Partial<
  Record<FlagTravelPresentationEvent, string>
> = {
  "origin-presentation-frozen": "origin_presentation_frozen",
  "camera-motion-started": "camera_motion_started",
  "camera-moveend": "camera_moveend",
  "destination-data-ready": "destination_data_ready",
  "destination-map-painted": "destination_map_painted",
  "destination-map-paint-fallback": "destination_map_paint_fallback",
  "presentation-deadline-released": "presentation_deadline_released",
  "presentation-authority-reset": "presentation_authority_reset",
  "destination-state-committed": "destination_state_committed",
  "first-destination-pixi-paint": "first_destination_pixi_paint"
};

export const flagTravelPresentationInstrumentation =
  new FlagTravelPresentationInstrumentation();
import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
