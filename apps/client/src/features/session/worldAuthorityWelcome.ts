import type { SessionServerMessage } from "@ash-atlas/shared";

type WelcomeMessage = Extract<SessionServerMessage, { type: "WELCOME" }>;

export type WorldAuthorityWelcomeMarker = Readonly<{
  playerId: string;
  epoch: string | null;
  relocationRevision: number;
  resourceVisionRevision: number;
  gameplayViewGeneration: number;
}>;

export type WorldAuthorityWelcomeClassification =
  | "initial"
  | "same-authority"
  | "player-changed"
  | "epoch-established"
  | "epoch-changed"
  | "revision-regressed";

export function markerForWorldAuthorityWelcome(
  message: WelcomeMessage
): WorldAuthorityWelcomeMarker {
  return {
    playerId: message.playerId,
    epoch: message.worldAuthorityEpoch ?? null,
    relocationRevision: message.relocationRevision ?? 0,
    resourceVisionRevision: message.resourceVisionRevision ?? 0,
    gameplayViewGeneration: message.gameplayViewGeneration ?? 0
  };
}

export function classifyWorldAuthorityWelcome(
  previous: WorldAuthorityWelcomeMarker | null,
  current: WorldAuthorityWelcomeMarker
): WorldAuthorityWelcomeClassification {
  if (!previous) return "initial";
  if (previous.playerId !== current.playerId) return "player-changed";
  if (previous.epoch === null && current.epoch !== null) {
    return "epoch-established";
  }
  if (
    previous.epoch !== null &&
    current.epoch !== null &&
    previous.epoch !== current.epoch
  ) {
    return "epoch-changed";
  }
  if (
    current.relocationRevision < previous.relocationRevision ||
    current.resourceVisionRevision < previous.resourceVisionRevision ||
    current.gameplayViewGeneration < previous.gameplayViewGeneration
  ) {
    return "revision-regressed";
  }
  return "same-authority";
}

export function welcomeRequiresWorldAuthorityReset(
  classification: WorldAuthorityWelcomeClassification
): boolean {
  return classification !== "initial" && classification !== "same-authority";
}
