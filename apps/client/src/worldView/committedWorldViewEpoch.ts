import type { WorldViewAuthority } from "@ash-atlas/shared";

export type CommittedWorldViewAuthority = Readonly<{
  playerId: string;
  connectionId?: string;
  connectionGeneration?: number;
  relocationRevision: number;
  resourceVisionRevision?: number;
  gameplayViewGeneration?: number;
  populationPreparationGeneration?: number;
}>;

export type WorldViewEpochInstallationResult =
  | "new-epoch-installed"
  | "in-place-authority-advanced"
  | "same-epoch-already-installed"
  | "stale-epoch-ignored";

export class CommittedWorldViewEpochInstaller {
  private installed: CommittedWorldViewAuthority | null = null;

  reset(): void {
    this.installed = null;
  }

  current(): CommittedWorldViewAuthority | null {
    return this.installed;
  }

  wouldIgnoreCommittedWorldViewEpoch(
    incoming: CommittedWorldViewAuthority
  ): boolean {
    return this.installed !== null &&
      compareCommittedWorldViewAuthority(incoming, this.installed) < 0;
  }

  installCommittedWorldViewEpoch(
    incoming: CommittedWorldViewAuthority
  ): WorldViewEpochInstallationResult {
    const current = this.installed;
    if (!current) {
      this.installed = incoming;
      return "new-epoch-installed";
    }
    const comparison = compareCommittedWorldViewAuthority(incoming, current);
    if (comparison < 0) return "stale-epoch-ignored";
    if (comparison > 0) {
      this.installed = incoming;
      if (
        incoming.relocationRevision === current.relocationRevision &&
        sameConnectionAuthority(incoming, current)
      ) {
        return "in-place-authority-advanced";
      }
      return "new-epoch-installed";
    }
    const merged = mergeSameEpochAuthority(current, incoming);
    this.installed = merged;
    return sameCommittedWorldViewAuthority(current, merged)
      ? "same-epoch-already-installed"
      : "in-place-authority-advanced";
  }
}

function sameConnectionAuthority(
  incoming: CommittedWorldViewAuthority,
  current: CommittedWorldViewAuthority
): boolean {
  if (
    incoming.connectionGeneration !== undefined &&
    current.connectionGeneration !== undefined &&
    incoming.connectionGeneration !== current.connectionGeneration
  ) return false;
  if (
    incoming.connectionId !== undefined &&
    current.connectionId !== undefined &&
    incoming.connectionId !== current.connectionId
  ) return false;
  return true;
}

export function isExactWorldViewAuthority(
  authority: CommittedWorldViewAuthority
): authority is WorldViewAuthority {
  return authority.connectionId !== undefined &&
    authority.connectionGeneration !== undefined &&
    authority.resourceVisionRevision !== undefined &&
    authority.gameplayViewGeneration !== undefined &&
    authority.populationPreparationGeneration !== undefined;
}

function compareCommittedWorldViewAuthority(
  incoming: CommittedWorldViewAuthority,
  current: CommittedWorldViewAuthority
): number {
  if (incoming.playerId !== current.playerId) return -1;

  if (
    isExactWorldViewAuthority(incoming) &&
    isExactWorldViewAuthority(current)
  ) {
    const connectionComparison =
      incoming.connectionGeneration - current.connectionGeneration;
    if (connectionComparison !== 0) return connectionComparison;
    if (incoming.connectionId !== current.connectionId) return -1;
  }

  const relocationComparison =
    incoming.relocationRevision - current.relocationRevision;
  if (relocationComparison !== 0) return relocationComparison;

  if (
    incoming.resourceVisionRevision !== undefined &&
    current.resourceVisionRevision !== undefined
  ) {
    const resourceComparison =
      incoming.resourceVisionRevision - current.resourceVisionRevision;
    if (resourceComparison !== 0) return resourceComparison;
  }

  if (
    isExactWorldViewAuthority(incoming) &&
    isExactWorldViewAuthority(current)
  ) {
    return incoming.gameplayViewGeneration -
      current.gameplayViewGeneration ||
      incoming.populationPreparationGeneration -
        current.populationPreparationGeneration;
  }

  return 0;
}

function mergeSameEpochAuthority(
  current: CommittedWorldViewAuthority,
  incoming: CommittedWorldViewAuthority
): CommittedWorldViewAuthority {
  if (isExactWorldViewAuthority(current)) return current;
  return { ...current, ...incoming };
}

function sameCommittedWorldViewAuthority(
  left: CommittedWorldViewAuthority,
  right: CommittedWorldViewAuthority
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
