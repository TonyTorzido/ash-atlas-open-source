import type {
  WorldViewAuthority,
  WorldViewEpoch
} from "@ash-atlas/shared";

type Checkpoints = {
  populationReady: boolean;
  combatSnapshotGeneration: number | null;
  publishedPresentationReady: boolean;
  repeatableSnapshotReceived: boolean;
  resourceSnapshotGeneration: number | null;
  resourceReadyOrNotRequired: boolean;
  publishedReady: boolean;
};

export type WorldViewCheckpoint = "population" | "combat" | "resources";

const DEFAULT_DIAGNOSTIC_THRESHOLD_MS = 5_000;
const DEFAULT_MAX_RECOVERY_REQUESTS = 2;

export class WorldViewConvergenceBarrier {
  private authority: WorldViewAuthority | null = null;
  private checkpoints: Checkpoints = emptyCheckpoints();
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryAttempts = 0;
  private terminalPopulationRecoveryIssued = false;

  constructor(private readonly callbacks: Readonly<{
    preparing(authority: WorldViewAuthority): void;
    presentationDataReady?(authority: WorldViewAuthority): void;
    ready(epoch: WorldViewEpoch): void;
    recover?(
      authority: WorldViewAuthority,
      missing: readonly WorldViewCheckpoint[],
      attempt: number
    ): void;
    diagnosticThresholdMs?: number;
    maxRecoveryRequests?: number;
  }>) {}

  reset(): void {
    this.clearRecoveryTimer();
    this.authority = null;
    this.checkpoints = emptyCheckpoints();
    this.recoveryAttempts = 0;
    this.terminalPopulationRecoveryIssued = false;
  }

  begin(authority: WorldViewAuthority): boolean {
    return this.accept(authority);
  }

  observePopulation(
    authority: WorldViewAuthority,
    terminalReady: boolean
  ): void {
    if (!this.accept(authority)) return;
    const wasPopulationReady = this.checkpoints.populationReady;
    if (terminalReady) {
      this.checkpoints.populationReady = true;
      if (
        !wasPopulationReady &&
        !this.checkpoints.publishedPresentationReady &&
        !this.terminalPopulationRecoveryIssued &&
        this.recoveryAttempts >=
          (this.callbacks.maxRecoveryRequests ?? DEFAULT_MAX_RECOVERY_REQUESTS) &&
        missingCheckpoints(this.checkpoints).length > 0
      ) {
        // A terminal degraded population result is a useful checkpoint, not
        // proof that the earlier watchdog attempts were still actionable. The
        // next recovery cycle must be allowed to request the exact authority's
        // remaining snapshot (typically combat) immediately.
        this.terminalPopulationRecoveryIssued = true;
        this.recoveryAttempts = 0;
        this.clearRecoveryTimer();
        this.requestRecovery();
      }
    }
    this.publishIfReady();
  }

  observeCombat(
    authority: WorldViewAuthority,
    combatSnapshotGeneration: number
  ): void {
    if (!this.accept(authority)) return;
    this.checkpoints.combatSnapshotGeneration = Math.max(
      this.checkpoints.combatSnapshotGeneration ?? 0,
      combatSnapshotGeneration
    );
    this.publishIfReady();
  }

  observeResources(
    authority: WorldViewAuthority,
    resourceSnapshotGeneration: number,
    resourceReadyOrNotRequired: boolean
  ): void {
    if (!this.accept(authority)) return;
    this.checkpoints.repeatableSnapshotReceived = true;
    this.checkpoints.resourceSnapshotGeneration = Math.max(
      this.checkpoints.resourceSnapshotGeneration ?? 0,
      resourceSnapshotGeneration
    );
    if (resourceReadyOrNotRequired) {
      this.checkpoints.resourceReadyOrNotRequired = true;
    }
    this.publishIfReady();
  }

  currentAuthority(): WorldViewAuthority | null {
    return this.authority;
  }

  missingCheckpoints(): readonly WorldViewCheckpoint[] {
    return this.authority ? missingCheckpoints(this.checkpoints) : [];
  }

  diagnostics(): Readonly<{
    authority: WorldViewAuthority | null;
    missing: readonly WorldViewCheckpoint[];
    recoveryAttempts: number;
  }> {
    return {
      authority: this.authority,
      missing: this.missingCheckpoints(),
      recoveryAttempts: this.recoveryAttempts
    };
  }

  private accept(incoming: WorldViewAuthority): boolean {
    if (this.authority && sameAuthority(this.authority, incoming)) return true;
    if (
      this.authority &&
      compareAuthority(incoming, this.authority) < 0
    ) return false;
    this.authority = incoming;
    this.checkpoints = emptyCheckpoints();
    this.recoveryAttempts = 0;
    this.terminalPopulationRecoveryIssued = false;
    this.clearRecoveryTimer();
    this.callbacks.preparing(incoming);
    this.scheduleRecovery();
    return true;
  }

  private publishIfReady(): void {
    if (
      this.authority &&
      !this.checkpoints.publishedPresentationReady &&
      this.checkpoints.populationReady &&
      this.checkpoints.combatSnapshotGeneration !== null
    ) {
      this.checkpoints.publishedPresentationReady = true;
      this.callbacks.presentationDataReady?.(this.authority);
    }
    if (
      !this.authority ||
      this.checkpoints.publishedReady ||
      !this.checkpoints.populationReady ||
      this.checkpoints.combatSnapshotGeneration === null ||
      !this.checkpoints.repeatableSnapshotReceived ||
      this.checkpoints.resourceSnapshotGeneration === null ||
      !this.checkpoints.resourceReadyOrNotRequired
    ) return;
    this.checkpoints.publishedReady = true;
    this.clearRecoveryTimer();
    this.callbacks.ready({
      ...this.authority,
      combatSnapshotGeneration:
        this.checkpoints.combatSnapshotGeneration,
      resourceSnapshotGeneration:
        this.checkpoints.resourceSnapshotGeneration
    });
  }

  private scheduleRecovery(): void {
    if (
      !this.callbacks.recover ||
      this.recoveryAttempts >=
        (this.callbacks.maxRecoveryRequests ?? DEFAULT_MAX_RECOVERY_REQUESTS)
    ) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (!this.authority || this.checkpoints.publishedReady) return;
      this.requestRecovery();
    }, Math.max(
      0,
      this.callbacks.diagnosticThresholdMs ??
        DEFAULT_DIAGNOSTIC_THRESHOLD_MS
    ));
  }

  private requestRecovery(): void {
    if (
      !this.authority ||
      this.checkpoints.publishedReady ||
      !this.callbacks.recover ||
      this.recoveryAttempts >=
        (this.callbacks.maxRecoveryRequests ?? DEFAULT_MAX_RECOVERY_REQUESTS)
    ) return;
    const authority = this.authority;
    const missing = missingCheckpoints(this.checkpoints);
    if (missing.length === 0) return;
    this.recoveryAttempts += 1;
    this.callbacks.recover(authority, missing, this.recoveryAttempts);
    if (
      this.authority &&
      sameAuthority(this.authority, authority) &&
      !this.checkpoints.publishedReady
    ) {
      this.scheduleRecovery();
    }
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer === null) return;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }
}

function emptyCheckpoints(): Checkpoints {
  return {
    populationReady: false,
    combatSnapshotGeneration: null,
    publishedPresentationReady: false,
    repeatableSnapshotReceived: false,
    resourceSnapshotGeneration: null,
    resourceReadyOrNotRequired: false,
    publishedReady: false
  };
}

function missingCheckpoints(
  checkpoints: Checkpoints
): WorldViewCheckpoint[] {
  const missing: WorldViewCheckpoint[] = [];
  if (!checkpoints.populationReady) missing.push("population");
  if (checkpoints.combatSnapshotGeneration === null) missing.push("combat");
  if (
    !checkpoints.repeatableSnapshotReceived ||
    checkpoints.resourceSnapshotGeneration === null ||
    !checkpoints.resourceReadyOrNotRequired
  ) {
    missing.push("resources");
  }
  return missing;
}

function sameAuthority(
  left: WorldViewAuthority,
  right: WorldViewAuthority
): boolean {
  return left.playerId === right.playerId &&
    left.connectionId === right.connectionId &&
    left.connectionGeneration === right.connectionGeneration &&
    left.relocationRevision === right.relocationRevision &&
    left.resourceVisionRevision === right.resourceVisionRevision &&
    left.gameplayViewGeneration === right.gameplayViewGeneration &&
    left.populationPreparationGeneration ===
      right.populationPreparationGeneration;
}

function compareAuthority(
  left: WorldViewAuthority,
  right: WorldViewAuthority
): number {
  return left.connectionGeneration - right.connectionGeneration ||
    left.relocationRevision - right.relocationRevision ||
    left.resourceVisionRevision - right.resourceVisionRevision ||
    left.gameplayViewGeneration - right.gameplayViewGeneration ||
    left.populationPreparationGeneration -
      right.populationPreparationGeneration ||
    (left.connectionId === right.connectionId ? 0 : -1);
}
