import type {
  PlayerLocationSnapshot,
  PortalDefinition,
  PortalServerMessage
} from "@ash-atlas/shared";
import { createHash, randomUUID } from "node:crypto";

import type { PlayerLocationService } from "./playerLocationService.js";
import { PlayerLocationError } from "./playerLocationService.js";
import type { PortalRegistry } from "./portalRegistry.js";

export interface PortalMovementAdapter {
  approach(input: Readonly<{
    playerId: string;
    transitionId: string;
    portal: PortalDefinition;
    onThreshold(): void;
    onFailure(error: unknown): void;
  }>): void | Promise<void>;
  stop(playerId: string, transitionId: string): void;
}

export interface PortalDestinationAdapter {
  authorize(input: Readonly<{
    playerId: string;
    portal: PortalDefinition;
    source: PlayerLocationSnapshot;
  }>): void | Promise<void>;
  prepare?(input: Readonly<{
    playerId: string;
    transitionId: string;
    portal: PortalDefinition;
  }>): void | Promise<void>;
  commit(input: Readonly<{
    playerId: string;
    requestId: string;
    transitionId: string;
    portal: PortalDefinition;
    source: PlayerLocationSnapshot;
    destination: PlayerLocationSnapshot;
  }>): void | Promise<void>;
  rollback?(input: Readonly<{
    playerId: string;
    transitionId: string;
    portal: PortalDefinition;
    reason: unknown;
  }>): void | Promise<void>;
}

export type PortalTransitionEffectsInput = Readonly<{
  playerId: string;
  requestId: string;
  transitionId: string;
  portal: PortalDefinition;
  source: PlayerLocationSnapshot;
  isSuperseded?: () => boolean;
}>;

export interface PortalTransitionEffects {
  prepare(input: PortalTransitionEffectsInput): void | Promise<void>;
  apply(input: PortalTransitionEffectsInput & Readonly<{
    destination: PlayerLocationSnapshot;
  }>): void | Promise<void>;
  complete?(input: PortalTransitionEffectsInput & Readonly<{
    destination: PlayerLocationSnapshot;
  }>): void | Promise<void>;
  release(input: PortalTransitionEffectsInput & Readonly<{
    committed: boolean;
    reason?: unknown;
  }>): void | Promise<void>;
}

export type PortalTransitionCoordinatorDependencies = Readonly<{
  locations: Pick<PlayerLocationService, "load" | "replayPortalTransition" | "commitPortalTransition">;
  portals: PortalRegistry;
  movementFor(location: PlayerLocationSnapshot): PortalMovementAdapter;
  destinationFor(portal: PortalDefinition): PortalDestinationAdapter;
  effects: PortalTransitionEffects;
  send(playerId: string, message: PortalServerMessage): void;
  runWithPlayerAuthority?<T>(playerId: string, operation: () => Promise<T>): Promise<T>;
  readinessFallbackMs?: number;
}>;

type ActiveTransition = {
  playerId: string;
  requestId: string;
  requestHash: string;
  transitionId: string;
  portal: PortalDefinition;
  source: PlayerLocationSnapshot;
  movement: PortalMovementAdapter;
  adapter: PortalDestinationAdapter;
  thresholdReached: boolean;
  destinationReady: boolean;
  committing: boolean;
  failing: boolean;
  superseded: boolean;
  readinessTimer: ReturnType<typeof setTimeout> | null;
  authoritativeCompletion: Promise<void>;
  resolveAuthoritativeCompletion: () => void;
  finalization: Promise<void>;
  resolveFinalization: () => void;
  supersededCompletion: Promise<void>;
  resolveSupersededCompletion: () => void;
};

type RecoveryRecord = Readonly<{
  requestHash: string;
  source?: PlayerLocationSnapshot;
  portal?: PortalDefinition;
  location?: PlayerLocationSnapshot;
}>;

export class PortalTransitionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PortalTransitionError";
  }
}

/**
 * The sole transition state machine. Feature adapters authorize and project
 * domain state; they never decide canonical location or transfer ordering.
 */
export class PortalTransitionCoordinator {
  private readonly activeByPlayer = new Map<string, ActiveTransition>();
  private readonly completedByRequest = new Map<string, { hash: string; location: PlayerLocationSnapshot }>();
  private readonly recoveryByRequest = new Map<string, RecoveryRecord>();
  private readonly recoveryInFlightByRequest = new Map<string, Promise<PlayerLocationSnapshot>>();

  constructor(private readonly dependencies: PortalTransitionCoordinatorDependencies) {}

  async recoverToWorldAnchor(input: Readonly<{
    playerId: string;
    requestId: string;
    regionCode: string;
    anchor: Readonly<{ lat: number; lon: number }>;
  }>): Promise<PlayerLocationSnapshot> {
    const destination = {
      kind: "world" as const,
      regionCode: input.regionCode,
      position: { ...input.anchor }
    };
    const requestHash = createHash("sha256").update(JSON.stringify({
      kind: "death-recovery", destination
    })).digest("hex");
    const requestKey = `${input.playerId}:${input.requestId}`;
    const retained = this.recoveryByRequest.get(requestKey);
    if (retained && retained.requestHash !== requestHash) {
      throw new PortalTransitionError("REQUEST_ID_REUSED", "That recovery request ID was already used.");
    }
    const inFlight = this.recoveryInFlightByRequest.get(requestKey);
    if (inFlight) return inFlight;
    if (retained?.location) return retained.location;
    if (!retained) this.recoveryByRequest.set(requestKey, { requestHash });

    const recovery = this.runRecovery({
      ...input,
      destination,
      requestHash,
      requestKey
    });
    this.recoveryInFlightByRequest.set(requestKey, recovery);
    try {
      return await recovery;
    } finally {
      if (this.recoveryInFlightByRequest.get(requestKey) === recovery) {
        this.recoveryInFlightByRequest.delete(requestKey);
      }
    }
  }

  private async runRecovery(input: Readonly<{
    playerId: string;
    requestId: string;
    destination: Extract<PortalDefinition["destination"], { kind: "world" }>;
    requestHash: string;
    requestKey: string;
  }>): Promise<PlayerLocationSnapshot> {
    const active = this.activeByPlayer.get(input.playerId);
    if (active) {
      if (active.committing) {
        this.supersede(active);
        await active.authoritativeCompletion;
        await active.finalization;
      } else {
        await this.fail(
          active,
          new PortalTransitionError("FORCED_RECOVERY", "Death recovery replaced the active portal transition."),
          false
        );
        await active.finalization;
      }
    }
    return this.withPlayerAuthority(input.playerId, () => this.commitRecovery(input));
  }

  private async commitRecovery(input: Readonly<{
    playerId: string;
    requestId: string;
    destination: Extract<PortalDefinition["destination"], { kind: "world" }>;
    requestHash: string;
    requestKey: string;
  }>): Promise<PlayerLocationSnapshot> {
    const retained = this.recoveryByRequest.get(input.requestKey);
    const source = retained?.source ?? await this.dependencies.locations.load(input.playerId);
    const portal: PortalDefinition = retained?.portal ?? {
      portalId: "recovery:death-anchor",
      source: endpointFromLocation(source),
      destination: input.destination,
      sourceApproach: source.position,
      sourceThreshold: source.position,
      destinationArrival: input.destination.position,
      interactionLabel: "Recovering",
      transitionPresentation: "door",
      enabled: true,
      revision: "death-recovery-v1"
    };
    const transitionId = randomUUID();
    const effectsInput: PortalTransitionEffectsInput = {
      playerId: input.playerId,
      requestId: input.requestId,
      transitionId,
      portal,
      source,
      isSuperseded: () => false
    };
    const adapter = this.dependencies.destinationFor(portal);
    let commitOutcome: "not-attempted" | "unknown" | "not-committed" | "committed" = "not-attempted";
    try {
      await adapter.authorize({ playerId: input.playerId, portal, source });
      await this.dependencies.effects.prepare(effectsInput);
      await adapter.prepare?.({ playerId: input.playerId, transitionId, portal });
      commitOutcome = "unknown";
      let result: { location: PlayerLocationSnapshot; replayed: boolean };
      try {
        result = await this.dependencies.locations.commitPortalTransition({
          playerId: input.playerId,
          requestId: input.requestId,
          portalId: portal.portalId,
          expectedRevision: source.revision,
          requestHash: input.requestHash,
          destination: input.destination
        });
      } catch (error) {
        this.recoveryByRequest.set(input.requestKey, {
          requestHash: input.requestHash,
          source,
          portal
        });
        const replayed = await this.dependencies.locations.replayPortalTransition(
          input.playerId,
          input.requestId,
          input.requestHash
        );
        if (!replayed) {
          commitOutcome = "not-committed";
          throw error;
        }
        result = { location: replayed, replayed: true };
      }
      commitOutcome = "committed";
      this.recoveryByRequest.set(input.requestKey, {
        requestHash: input.requestHash,
        source,
        portal
      });
      await this.dependencies.effects.apply({ ...effectsInput, destination: result.location });
      await adapter.commit({
        playerId: input.playerId,
        requestId: input.requestId,
        transitionId,
        portal,
        source,
        destination: result.location
      });
      this.recoveryByRequest.set(input.requestKey, {
        requestHash: input.requestHash,
        location: result.location
      });
      try {
        this.dependencies.send(input.playerId, {
          type: "PLAYER_LOCATION_SNAPSHOT",
          location: result.location
        });
      } catch {
        // Canonical recovery and destination projection are already complete.
      }
      void this.finishCommittedRecovery(effectsInput, result.location);
      return result.location;
    } catch (error) {
      await Promise.resolve(this.dependencies.effects.release({
        ...effectsInput,
        committed: commitOutcome === "committed",
        reason: error
      })).catch(() => undefined);
      if (commitOutcome !== "committed") {
        if (commitOutcome !== "unknown") {
          this.recoveryByRequest.set(input.requestKey, { requestHash: input.requestHash });
        }
        await Promise.resolve(adapter.rollback?.({
          playerId: input.playerId,
          transitionId,
          portal,
          reason: error
        })).catch(() => undefined);
      }
      throw error;
    }
  }

  private async finishCommittedRecovery(
    input: PortalTransitionEffectsInput,
    destination: PlayerLocationSnapshot
  ): Promise<void> {
    await Promise.resolve(this.dependencies.effects.complete?.({
      ...input,
      destination
    })).catch(() => undefined);
    await Promise.resolve(this.dependencies.effects.release({
      ...input,
      committed: true
    })).catch(() => undefined);
  }

  async usePortal(input: Readonly<{
    playerId: string; requestId: string; portalId: string;
    expectedPortalRevision?: string; expectedLocationRevision: number;
    approach?: "normal" | "immediate";
  }>): Promise<void> {
    const requestHash = hashRequest(input);
    const requestKey = `${input.playerId}:${input.requestId}`;
    const completed = this.completedByRequest.get(requestKey);
    if (completed) {
      if (completed.hash !== requestHash) throw new PortalTransitionError("REQUEST_ID_REUSED", "That request ID was already used.");
      this.dependencies.send(input.playerId, { type: "PLAYER_LOCATION_SNAPSHOT", location: completed.location });
      return;
    }
    const durableReplay = await this.dependencies.locations.replayPortalTransition(
      input.playerId,
      input.requestId,
      requestHash
    );
    if (durableReplay) {
      this.completedByRequest.set(requestKey, { hash: requestHash, location: durableReplay });
      this.dependencies.send(input.playerId, {
        type: "PLAYER_LOCATION_SNAPSHOT",
        location: durableReplay
      });
      return;
    }
    const active = this.activeByPlayer.get(input.playerId);
    if (active) {
      if (active.requestId === input.requestId && active.requestHash === requestHash) {
        this.sendPlan(active);
        return;
      }
      throw new PortalTransitionError("TRANSITION_ACTIVE", "Finish or cancel the current portal transition first.");
    }

    const source = await this.dependencies.locations.load(input.playerId);
    if (source.revision !== input.expectedLocationRevision) {
      throw new PortalTransitionError("STALE_LOCATION", "Your location changed before the portal could be used.");
    }
    const portal = await this.dependencies.portals.resolve(input.portalId, source, {
      playerId: input.playerId
    });
    if (!portal.enabled) throw new PortalTransitionError("PORTAL_DISABLED", "That portal is currently unavailable.");
    if (input.expectedPortalRevision !== undefined && portal.revision !== input.expectedPortalRevision) {
      throw new PortalTransitionError("STALE_PORTAL", "That portal changed before it could be used.");
    }
    const immediate = input.approach === "immediate";
    if (immediate && portal.approachPolicy !== "immediate") {
      throw new PortalTransitionError(
        "PORTAL_IMMEDIATE_UNAVAILABLE",
        "That portal requires an approach before it can be used."
      );
    }
    const adapter = this.dependencies.destinationFor(portal);
    await adapter.authorize({ playerId: input.playerId, portal, source });
    const movement = this.dependencies.movementFor(source);
    const authoritative = deferred();
    const finalization = deferred();
    const superseded = deferred();
    const transition: ActiveTransition = {
      playerId: input.playerId, requestId: input.requestId, requestHash,
      transitionId: randomUUID(), portal, source, movement, adapter,
      thresholdReached: immediate, destinationReady: false, committing: false,
      failing: false, superseded: false, readinessTimer: null,
      authoritativeCompletion: authoritative.promise,
      resolveAuthoritativeCompletion: authoritative.resolve,
      finalization: finalization.promise,
      resolveFinalization: finalization.resolve,
      supersededCompletion: superseded.promise,
      resolveSupersededCompletion: superseded.resolve
    };
    this.activeByPlayer.set(input.playerId, transition);
    try {
      if (immediate) movement.stop(input.playerId, transition.transitionId);
      await this.dependencies.effects.prepare(this.effectsInput(transition));
      if (this.activeByPlayer.get(input.playerId) !== transition || transition.failing) return;
      await adapter.prepare?.({ playerId: input.playerId, transitionId: transition.transitionId, portal });
      if (this.activeByPlayer.get(input.playerId) !== transition || transition.failing) return;
      this.sendPlan(transition);
      this.dependencies.send(input.playerId, {
        type: "PORTAL_TRANSITION_PHASE", transitionId: transition.transitionId,
        phase: immediate ? "threshold_reached" : "approaching"
      });
      transition.readinessTimer = setTimeout(() => {
        const current = this.activeByPlayer.get(input.playerId);
        if (current !== transition || current.committing || current.failing) return;
        current.destinationReady = true;
        void this.tryCommit(current);
      }, this.dependencies.readinessFallbackMs ?? 5_000);
      if (immediate) {
        void this.tryCommit(transition);
        return;
      }
      await movement.approach({
        playerId: input.playerId, transitionId: transition.transitionId, portal,
        onThreshold: () => {
          const current = this.activeByPlayer.get(input.playerId);
          if (current !== transition || current.committing || current.failing) return;
          current.thresholdReached = true;
          this.dependencies.send(input.playerId, {
            type: "PORTAL_TRANSITION_PHASE", transitionId: transition.transitionId,
            phase: current.destinationReady ? "covered" : "waiting_for_destination"
          });
          void this.tryCommit(current);
        },
        onFailure: (error) => void this.fail(transition, error)
      });
    } catch (error) {
      await this.fail(transition, error);
      throw error;
    }
  }

  destinationReady(playerId: string, transitionId: string, sceneKey: string): void {
    const transition = this.activeByPlayer.get(playerId);
    if (!transition || transition.transitionId !== transitionId) {
      throw new PortalTransitionError("STALE_TRANSITION", "That portal transition is no longer active.");
    }
    if (transition.committing || transition.failing) return;
    const expected = transition.portal.preloadSceneKey ?? sceneKey;
    if (sceneKey !== expected) throw new PortalTransitionError("SCENE_MISMATCH", "The prepared scene does not match the destination.");
    transition.destinationReady = true;
    if (transition.readinessTimer) clearTimeout(transition.readinessTimer);
    transition.readinessTimer = null;
    void this.tryCommit(transition);
  }

  async cancel(playerId: string, transitionId: string): Promise<void> {
    const transition = this.activeByPlayer.get(playerId);
    if (!transition || transition.transitionId !== transitionId) return;
    if (transition.committing) throw new PortalTransitionError("ALREADY_COMMITTING", "That transition is already committing.");
    await this.fail(transition, new PortalTransitionError("CANCELLED", "Portal transition cancelled."));
  }

  async disconnect(playerId: string): Promise<void> {
    const transition = this.activeByPlayer.get(playerId);
    if (!transition || transition.committing) return;
    await this.fail(transition, new PortalTransitionError("DISCONNECTED", "Portal transition cancelled on disconnect."), false);
  }

  private async tryCommit(transition: ActiveTransition): Promise<void> {
    if (!transition.thresholdReached || !transition.destinationReady || transition.committing || transition.failing) return;
    if (this.activeByPlayer.get(transition.playerId) !== transition) return;
    transition.committing = true;
    await this.withPlayerAuthority(transition.playerId, () => this.commitTransition(transition));
  }

  private async commitTransition(transition: ActiveTransition): Promise<void> {
    this.dependencies.send(transition.playerId, {
      type: "PORTAL_TRANSITION_PHASE", transitionId: transition.transitionId, phase: "committing"
    });
    let committedLocation: PlayerLocationSnapshot | null = null;
    try {
      const result = await this.dependencies.locations.commitPortalTransition({
        playerId: transition.playerId, requestId: transition.requestId,
        portalId: transition.portal.portalId, expectedRevision: transition.source.revision,
        requestHash: transition.requestHash,
        destination: { ...transition.portal.destination, position: transition.portal.destinationArrival } as PortalDefinition["destination"]
      });
      committedLocation = result.location;
      await this.dependencies.effects.apply({
        ...this.effectsInput(transition), destination: result.location
      });
      await transition.adapter.commit({
        playerId: transition.playerId, requestId: transition.requestId,
        transitionId: transition.transitionId,
        portal: transition.portal, source: transition.source, destination: result.location
      });
      transition.resolveAuthoritativeCompletion();
      this.completedByRequest.set(`${transition.playerId}:${transition.requestId}`, {
        hash: transition.requestHash, location: result.location
      });
      try {
        this.dependencies.send(transition.playerId, {
          type: "PLAYER_LOCATION_SNAPSHOT", location: result.location,
          transitionId: transition.transitionId
        });
      } catch {
        // Canonical commit and the destination projection are already complete.
      }
      void this.finishCommittedTransition(transition, result.location);
    } catch (error) {
      // Canonical commit is final. A failed projection is repaired by reconnect/resync.
      if (!committedLocation) {
        transition.committing = false;
        await this.fail(transition, error);
        return;
      }
      this.completedByRequest.set(`${transition.playerId}:${transition.requestId}`, {
        hash: transition.requestHash, location: committedLocation
      });
      try {
        this.dependencies.send(transition.playerId, {
          type: "PLAYER_LOCATION_SNAPSHOT",
          location: committedLocation,
          transitionId: transition.transitionId
        });
      } catch {
        // Canonical commit remains durable even if the socket is gone.
      }
      transition.resolveAuthoritativeCompletion();
      void this.finishCommittedTransition(
        transition,
        committedLocation,
        error,
        false
      );
    }
  }

  private withPlayerAuthority<T>(playerId: string, operation: () => Promise<T>): Promise<T> {
    return this.dependencies.runWithPlayerAuthority?.(playerId, operation) ?? operation();
  }

  private async finishCommittedTransition(
    transition: ActiveTransition,
    destination: PlayerLocationSnapshot,
    reason?: unknown,
    runComplete = true
  ): Promise<void> {
    try {
      if (runComplete && !transition.superseded) {
        const complete = Promise.resolve(this.dependencies.effects.complete?.({
          ...this.effectsInput(transition), destination
        })).catch(() => undefined);
        await Promise.race([complete, transition.supersededCompletion]);
      }
      await Promise.resolve(this.dependencies.effects.release({
        ...this.effectsInput(transition), committed: true,
        ...(reason === undefined ? {} : { reason })
      })).catch(() => undefined);
      this.clear(transition);
    } finally {
      transition.resolveFinalization();
    }
  }

  private async fail(transition: ActiveTransition, reason: unknown, notify = true): Promise<void> {
    if (this.activeByPlayer.get(transition.playerId) !== transition || transition.failing || transition.committing) return;
    transition.failing = true;
    transition.movement.stop(transition.playerId, transition.transitionId);
    await Promise.resolve(this.dependencies.effects.release({
      ...this.effectsInput(transition), committed: false, reason
    })).catch(() => undefined);
    await Promise.resolve(transition.adapter.rollback?.({
      playerId: transition.playerId, transitionId: transition.transitionId,
      portal: transition.portal, reason
    })).catch(() => undefined);
    this.clear(transition);
    transition.resolveAuthoritativeCompletion();
    transition.resolveFinalization();
    if (!notify) return;
    const location = await this.dependencies.locations.load(transition.playerId);
    const code = reason instanceof PortalTransitionError || reason instanceof PlayerLocationError
      ? reason.code : "PORTAL_TRANSITION_FAILED";
    this.dependencies.send(transition.playerId, {
      type: "PORTAL_TRANSITION_FAILED", requestId: transition.requestId,
      transitionId: transition.transitionId, code,
      message: reason instanceof Error ? reason.message : "Portal transition failed.",
      location
    });
  }

  private clear(transition: ActiveTransition): void {
    if (transition.readinessTimer) clearTimeout(transition.readinessTimer);
    transition.readinessTimer = null;
    if (this.activeByPlayer.get(transition.playerId) === transition) {
      this.activeByPlayer.delete(transition.playerId);
    }
  }

  private effectsInput(transition: ActiveTransition): PortalTransitionEffectsInput {
    return {
      playerId: transition.playerId,
      requestId: transition.requestId,
      transitionId: transition.transitionId,
      portal: transition.portal,
      source: transition.source,
      isSuperseded: () => transition.superseded
    };
  }

  private supersede(transition: ActiveTransition): void {
    if (transition.superseded) return;
    transition.superseded = true;
    transition.resolveSupersededCompletion();
  }

  private sendPlan(transition: ActiveTransition): void {
    this.dependencies.send(transition.playerId, {
      type: "PORTAL_TRANSITION_PLANNED", requestId: transition.requestId,
      transitionId: transition.transitionId, portalId: transition.portal.portalId,
      portalRevision: transition.portal.revision, source: transition.portal.source,
      destination: transition.portal.destination,
      sourceApproach: transition.portal.sourceApproach,
      sourceThreshold: transition.portal.sourceThreshold,
      preloadSceneKey: transition.portal.preloadSceneKey ?? sceneKey(transition.portal.destination),
      presentation: transition.portal.transitionPresentation,
      status: transition.portal.interactionLabel
    });
  }
}

function endpointFromLocation(location: PlayerLocationSnapshot): PortalDefinition["source"] {
  return location.kind === "world"
    ? { kind: "world", regionCode: location.regionCode, position: location.position }
    : {
        kind: "interior",
        locationType: location.locationType,
        locationId: location.locationId,
        instanceId: location.instanceId,
        spaceId: location.spaceId,
        position: location.position,
        ...(location.facing === undefined ? {} : { facing: location.facing })
      };
}

function sceneKey(endpoint: PortalDefinition["destination"]): string {
  return endpoint.kind === "world" ? "world" : `${endpoint.locationType}/${endpoint.spaceId}`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function hashRequest(input: Readonly<{
  portalId: string; expectedPortalRevision?: string; expectedLocationRevision: number;
  approach?: "normal" | "immediate";
}>): string {
  const body: {
    portalId: string;
    expectedPortalRevision: string | null;
    expectedLocationRevision: number;
    approach?: "normal" | "immediate";
  } = {
    portalId: input.portalId, expectedPortalRevision: input.expectedPortalRevision ?? null,
    expectedLocationRevision: input.expectedLocationRevision
  };
  // Keep the legacy hash for normal requests so an in-flight/retried request
  // created before the optional immediate-exit field remains idempotent.
  if (input.approach !== undefined) body.approach = input.approach;
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
