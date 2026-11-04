import type {
  ServerMessage,
  WorldViewAuthority
} from "@ash-atlas/shared";

import type {
  CommittedWorldViewAuthority
} from "./committedWorldViewEpoch.js";

export type InstalledRelocationAuthority = Readonly<{
  playerId: string;
  relocationRevision: number;
  resourceVisionRevision?: number;
}>;

type StagedFrame = Readonly<{
  sequence: number;
  message: ServerMessage;
  authority: CommittedWorldViewAuthority;
}>;

const MAX_STAGED_WORLD_VIEW_FRAMES = 64;

export class WorldViewFrameStager {
  private nextSequence = 0;
  private frames: StagedFrame[] = [];

  reset(): void {
    this.frames = [];
  }

  stageIfAhead(
    message: ServerMessage,
    installed: InstalledRelocationAuthority
  ): boolean {
    const authority = committedWorldViewAuthorityForFrame(message);
    if (
      !authority ||
      authority.playerId !== installed.playerId ||
      compareRelocationAuthority(authority, installed) <= 0
    ) {
      return false;
    }
    this.frames.push({
      sequence: this.nextSequence++,
      message,
      authority
    });
    if (this.frames.length > MAX_STAGED_WORLD_VIEW_FRAMES) {
      this.frames.splice(
        0,
        this.frames.length - MAX_STAGED_WORLD_VIEW_FRAMES
      );
    }
    return true;
  }

  takeMatching(
    installed: InstalledRelocationAuthority
  ): ServerMessage[] {
    const matching: StagedFrame[] = [];
    const pending: StagedFrame[] = [];
    for (const frame of this.frames) {
      if (frame.authority.playerId !== installed.playerId) continue;
      const comparison = compareRelocationAuthority(
        frame.authority,
        installed
      );
      if (comparison === 0) {
        matching.push(frame);
      } else if (comparison > 0) {
        pending.push(frame);
      }
    }
    this.frames = pending;
    return matching
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ message }) => message);
  }

  pendingCount(): number {
    return this.frames.length;
  }
}

export function worldViewAuthorityForFrame(
  message: ServerMessage
): WorldViewAuthority | null {
  switch (message.type) {
    case "POPULATION_ZONE_DELTA":
      return {
        playerId: message.playerId,
        connectionId: message.connectionId,
        connectionGeneration: message.connectionGeneration,
        relocationRevision: message.relocationRevision,
        resourceVisionRevision: message.resourceVisionRevision,
        gameplayViewGeneration: message.gameplayViewGeneration,
        populationPreparationGeneration: message.preparationGeneration
      };
    case "COMBAT_SNAPSHOT":
    case "COLLECTIBLES_SNAPSHOT":
      return message.worldViewAuthority ?? null;
    default:
      return null;
  }
}

export function committedWorldViewAuthorityForFrame(
  message: ServerMessage
): CommittedWorldViewAuthority | null {
  const exact = worldViewAuthorityForFrame(message);
  if (exact) return exact;
  if (message.type !== "COLLECTIBLES_SNAPSHOT") return null;
  return {
    playerId: message.playerId,
    relocationRevision: message.relocationRevision,
    resourceVisionRevision: message.resourceVisionRevision,
    gameplayViewGeneration:
      message.authority.gameplayViewGeneration
  };
}

function compareRelocationAuthority(
  left: Pick<
    CommittedWorldViewAuthority,
    "relocationRevision" | "resourceVisionRevision"
  >,
  right: Pick<
    InstalledRelocationAuthority,
    "relocationRevision" | "resourceVisionRevision"
  >
): number {
  const relocationComparison =
    left.relocationRevision - right.relocationRevision;
  if (relocationComparison !== 0) return relocationComparison;
  if (
    left.resourceVisionRevision === undefined ||
    right.resourceVisionRevision === undefined
  ) {
    return 0;
  }
  return left.resourceVisionRevision - right.resourceVisionRevision;
}
