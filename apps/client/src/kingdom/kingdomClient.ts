import type {
  KingdomConstructionQuote,
  KingdomDecorationTypeId,
  KingdomEnvironmentSnapshot,
  KingdomFoundingSourceFlag,
  KingdomFoundingQuoteResult as SharedKingdomFoundingQuoteResult,
  KingdomFlagEligibility,
  KingdomFlagRemovalPreview,
  KingdomDowngradeStructure,
  KingdomPublicSnapshot,
  KingdomStateSnapshot,
  ResourceType
} from "@ash-atlas/shared";

import { requestIdCrypto as crypto } from "../requestId.js";

export type FoundKingdomRequest = {
  requestId?: string;
  sourceFlagId?: string;
  displayName: string;
  description?: string | null;
  emblemKey?: string | null;
  displayColor?: string;
};

export type KingdomInvitationResponseRequest = {
  requestId?: string;
  invitationId: string;
  response: "accept" | "decline";
};

export type KingdomMemberAction =
  | "remove"
  | "ban"
  | "unban"
  | "promote"
  | "demote"
  | "transfer_leadership";

export type KingdomDecorationActionRequest = {
  requestId?: string;
  decorationId: string;
  action: "move" | "remove";
  rotation?: number;
};

export type KingdomCotActionRequest = {
  requestId?: string;
  cotId: string;
  action: "move" | "pack";
  rotation?: number;
};

export type KingdomMutationResult = {
  state: KingdomStateSnapshot | null;
  stateRefreshRequired: boolean;
  quote: KingdomConstructionQuote | null;
  replayed: boolean;
  message: string | null;
};

export type KingdomFoundingQuoteResult = SharedKingdomFoundingQuoteResult;

export class KingdomApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: unknown = null
  ) {
    super(message);
    this.name = "KingdomApiError";
  }
}

/**
 * Authenticated HTTP access to durable Kingdom mutations and private state.
 * Live chat and push updates remain on the gameplay WebSocket.
 */
export class KingdomApiClient {
  constructor(
    private readonly serverHttpBase: string,
    private readonly csrfToken: string
  ) {}

  async getState(): Promise<KingdomStateSnapshot> {
    const payload = await this.request<unknown>("/api/kingdom/state", { method: "GET" });
    return stateFromPayload(payload);
  }

  async getPublicKingdom(kingdomId: string): Promise<KingdomPublicSnapshot> {
    const payload = await this.request<unknown>(
      `/api/kingdom/${encodeURIComponent(kingdomId)}`,
      { method: "GET" }
    );
    const record = objectRecord(payload);
    const kingdom = objectRecord(record?.kingdom) ?? record;
    if (
      !kingdom ||
      typeof kingdom.id !== "string" ||
      kingdom.id !== kingdomId ||
      typeof kingdom.displayName !== "string" ||
      typeof kingdom.level !== "number" ||
      typeof kingdom.memberCount !== "number"
    ) {
      throw new KingdomApiError(
        "INVALID_KINGDOM_RESPONSE",
        "Invalid public Kingdom response",
        500
      );
    }
    return kingdom as KingdomPublicSnapshot;
  }

  async getFoundingQuote(input: FoundKingdomRequest): Promise<KingdomFoundingQuoteResult> {
    const payload = await this.request<unknown>("/api/kingdom/founding-quote", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": this.csrfToken
      },
      body: JSON.stringify({
        requestId: requestId(input.requestId),
        ...(input.sourceFlagId !== undefined ? { sourceFlagId: input.sourceFlagId } : {}),
        displayName: input.displayName,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.emblemKey !== undefined ? { emblemKey: input.emblemKey } : {}),
        ...(input.displayColor !== undefined ? { displayColor: input.displayColor } : {})
      })
    });
    return foundingQuoteFromPayload(payload);
  }

  async getFlagEligibility(flagId: string): Promise<KingdomFlagEligibility> {
    const payload = await this.request<unknown>(
      `/api/kingdom/flags/${encodeURIComponent(flagId)}/eligibility`,
      { method: "GET" }
    );
    const record = objectRecord(payload);
    const eligibility = objectRecord(record?.eligibility);
    if (!eligibility || eligibility.flagId !== flagId || typeof eligibility.eligible !== "boolean") {
      throw new KingdomApiError("INVALID_KINGDOM_FLAG_RESPONSE", "Invalid Kingdom Flag eligibility response", 500);
    }
    return eligibility as KingdomFlagEligibility;
  }

  async getFlagRemovalPreview(flagId: string): Promise<KingdomFlagRemovalPreview> {
    const payload = await this.request<unknown>(
      `/api/kingdom/flags/${encodeURIComponent(flagId)}/removal-preview`,
      { method: "GET" }
    );
    const record = objectRecord(payload);
    const preview = objectRecord(record?.preview);
    if (!preview || preview.flagId !== flagId || typeof preview.allowed !== "boolean" ||
        typeof preview.downstreamCount !== "number") {
      throw new KingdomApiError("INVALID_KINGDOM_FLAG_RESPONSE", "Invalid Kingdom Flag removal preview", 500);
    }
    return preview as KingdomFlagRemovalPreview;
  }

  async convertFlag(flagId: string, providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/flags/convert", {
      requestId: requestId(providedRequestId),
      flagId
    });
  }

  async removeFlag(
    flagId: string,
    expectedNetworkRevision: string,
    providedRequestId?: string
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/flags/remove", {
      requestId: requestId(providedRequestId),
      flagId,
      expectedNetworkRevision
    });
  }

  async found(input: FoundKingdomRequest): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/found", {
      requestId: requestId(input.requestId),
      ...(input.sourceFlagId !== undefined ? { sourceFlagId: input.sourceFlagId } : {}),
      displayName: input.displayName,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.emblemKey !== undefined ? { emblemKey: input.emblemKey } : {}),
      ...(input.displayColor !== undefined ? { displayColor: input.displayColor } : {})
    });
  }

  async invite(targetPlayerId: string, providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/invite", {
      requestId: requestId(providedRequestId),
      targetPlayerId
    });
  }

  async respondToInvitation(
    input: KingdomInvitationResponseRequest
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/invitation/respond", {
      requestId: requestId(input.requestId),
      invitationId: input.invitationId,
      response: input.response
    });
  }

  async cancelInvitation(
    invitationId: string,
    providedRequestId?: string
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/invitation/cancel", {
      requestId: requestId(providedRequestId),
      invitationId
    });
  }

  async memberAction(
    targetPlayerId: string,
    action: KingdomMemberAction,
    providedRequestId?: string
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/member/action", {
      requestId: requestId(providedRequestId),
      targetPlayerId,
      action
    });
  }

  async leave(providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/leave", {
      requestId: requestId(providedRequestId)
    });
  }

  async updateIdentity(
    input: {
      requestId?: string;
      description?: string | null;
      emblemKey?: string | null;
      displayColor?: string;
    }
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/identity", {
      requestId: requestId(input.requestId),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.emblemKey !== undefined ? { emblemKey: input.emblemKey } : {}),
      ...(input.displayColor !== undefined ? { displayColor: input.displayColor } : {})
    });
  }

  async muteMember(
    targetPlayerId: string,
    action: "mute" | "unmute",
    mutedUntil?: string | null,
    providedRequestId?: string
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/mute", {
      requestId: requestId(providedRequestId),
      targetPlayerId,
      action,
      ...(action === "mute" ? { mutedUntil: mutedUntil ?? null } : {})
    });
  }

  async donate(
    input: {
      requestId?: string;
      resourceType: ResourceType;
      variant?: string | null;
      quantity: number;
    }
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/donate", {
      requestId: requestId(input.requestId),
      resourceType: input.resourceType,
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
      quantity: input.quantity
    });
  }

  async depositBricks(quantity: number, providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/bricks/deposit", { requestId: requestId(providedRequestId), quantity });
  }

  async startRevolt(providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/revolt/start", { requestId: requestId(providedRequestId) });
  }

  async voteRevolt(revoltId: string, support: boolean, providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/revolt/vote", { requestId: requestId(providedRequestId), revoltId, support });
  }

  async upgradeBrickFurnace(targetLevel: number, providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/furnace/upgrade", { requestId: requestId(providedRequestId), targetLevel });
  }

  async upgradeCommandBoard(targetLevel: number, providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/command-board/upgrade", { requestId: requestId(providedRequestId), targetLevel });
  }

  /** Takes a Kingdom Tower, Obelisk, Brick Furnace or Command Board down one level (45% refund to the treasury). */
  async downgradeStructure(
    input: Readonly<{ structure: KingdomDowngradeStructure; fromLevel: number; flagId?: string }>,
    providedRequestId?: string
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/structure/downgrade", { requestId: requestId(providedRequestId), ...input });
  }

  /** Raises a War Tower or War Outpost at the player's live position. */
  async placeWarStructure(kind: "war_tower" | "war_outpost", providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/war-structure/place", { requestId: requestId(providedRequestId), kind });
  }

  async buyBrickFurnacePackage(furnaceLevel: number, providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/furnace/package", { requestId: requestId(providedRequestId), furnaceLevel });
  }

  async chooseKingdomPerk(
    perkId: string,
    expectedCurrentPerkId: string | null,
    providedRequestId?: string
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/perks/choose", {
      requestId: requestId(providedRequestId),
      perkId,
      expectedCurrentPerkId
    });
  }

  async activateKingdomPerk(perkId: string, providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/perks/activate", { requestId: requestId(providedRequestId), perkId });
  }

  async startAdvancementProject(
    targetLevel: number,
    providedRequestId?: string
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/project/start", {
      requestId: requestId(providedRequestId),
      targetLevel
    });
  }

  async cancelAdvancementProject(
    projectId: string,
    providedRequestId?: string
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/project/cancel", {
      requestId: requestId(providedRequestId),
      projectId
    });
  }

  async placeCot(rotation = 0, providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/cot", {
      requestId: requestId(providedRequestId),
      rotation
    });
  }

  async cotAction(input: KingdomCotActionRequest): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/cot/action", {
      requestId: requestId(input.requestId),
      cotId: input.cotId,
      action: input.action,
      ...(input.rotation !== undefined ? { rotation: input.rotation } : {})
    });
  }

  async placeDecoration(
    input: {
      requestId?: string;
      typeId: KingdomDecorationTypeId;
      kingdomOwned: boolean;
      rotation?: number;
    }
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/decoration", {
      requestId: requestId(input.requestId),
      typeId: input.typeId,
      kingdomOwned: input.kingdomOwned,
      rotation: input.rotation ?? 0
    });
  }

  async decorationAction(
    input: KingdomDecorationActionRequest
  ): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/decoration/action", {
      requestId: requestId(input.requestId),
      decorationId: input.decorationId,
      action: input.action,
      ...(input.rotation !== undefined ? { rotation: input.rotation } : {})
    });
  }

  /** The leader rebuilds a Castle lying in rubble for the founding cost. */
  async rebuildCastle(providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/castle/rebuild", { requestId: requestId(providedRequestId) });
  }

  async dissolve(providedRequestId?: string): Promise<KingdomMutationResult> {
    return this.mutate("/api/kingdom/dissolve", {
      requestId: requestId(providedRequestId)
    });
  }

  private async mutate(path: string, body: unknown): Promise<KingdomMutationResult> {
    const payload = await this.request<unknown>(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": this.csrfToken
      },
      body: JSON.stringify(body)
    });
    return mutationResultFromPayload(payload);
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.serverHttpBase), {
        ...init,
        credentials: "include"
      });
    } catch {
      // The serialized body already contains the durable request id. A single
      // ambiguous transport retry must reuse it rather than minting a new id.
      if (init.method !== "POST") {
        throw new KingdomApiError("SERVER_UNAVAILABLE", "Kingdom service unavailable", 0);
      }
      try {
        response = await fetch(new URL(path, this.serverHttpBase), {
          ...init,
          credentials: "include"
        });
      } catch {
        throw new KingdomApiError("SERVER_UNAVAILABLE", "Kingdom service unavailable", 0);
      }
    }

    const payload = await readJson(response);
    if (!response.ok) {
      const error = errorFromPayload(payload);
      throw new KingdomApiError(
        error?.code ?? "KINGDOM_REQUEST_FAILED",
        error?.message ?? "Kingdom request failed",
        response.status,
        error?.details ?? null
      );
    }
    return payload as T;
  }
}

function requestId(provided: string | undefined): string {
  return provided ?? crypto.randomUUID();
}

function mutationResultFromPayload(payload: unknown): KingdomMutationResult {
  const record = objectRecord(payload);
  return {
    state: record?.state === null ? null : stateFromPayload(payload),
    stateRefreshRequired: record?.stateRefreshRequired === true,
    quote: isConstructionQuote(record?.quote) ? record.quote : null,
    replayed: typeof record?.replayed === "boolean" ? record.replayed : false,
    message: typeof record?.message === "string" ? record.message : null
  };
}

function foundingQuoteFromPayload(payload: unknown): KingdomFoundingQuoteResult {
  const record = objectRecord(payload);
  const quoteRecord = objectRecord(record?.foundingQuote) ?? record;
  const position = objectRecord(quoteRecord?.seatPosition) ??
    objectRecord(quoteRecord?.position) ??
    objectRecord(quoteRecord?.authoritativePosition);
  const environment = objectRecord(quoteRecord?.environment);
  const sourceFlag = objectRecord(quoteRecord?.sourceFlag);
  const constructionQuote = isConstructionQuote(quoteRecord?.quote) ? quoteRecord.quote : null;
  const affordability = Array.isArray(quoteRecord?.affordability)
    ? quoteRecord.affordability.flatMap((value) => {
        const line = objectRecord(value);
        return line && typeof line.resourceType === "string" &&
          typeof line.requiredQuantity === "number" &&
          typeof line.availableQuantity === "number" &&
          typeof line.missingQuantity === "number"
          ? [line as KingdomFoundingQuoteResult["affordability"][number]]
          : [];
      })
    : [];
  if (
    !quoteRecord ||
    !position ||
    typeof position.lat !== "number" ||
    typeof position.lon !== "number" ||
    typeof quoteRecord.eligible !== "boolean" ||
    (quoteRecord.eligible && (
      typeof quoteRecord.territoryRadiusM !== "number" ||
      !environment ||
      !sourceFlag ||
      !constructionQuote
    )) ||
    (sourceFlag !== undefined && sourceFlag !== null && (
      typeof sourceFlag.id !== "string" ||
      typeof sourceFlag.name !== "string" ||
      typeof sourceFlag.ownerColor !== "string" ||
      typeof sourceFlag.lat !== "number" ||
      typeof sourceFlag.lon !== "number" ||
      typeof sourceFlag.claimRadiusM !== "number"
    ))
  ) {
    throw new KingdomApiError(
      "INVALID_KINGDOM_QUOTE_RESPONSE",
      "Invalid Kingdom founding quote response",
      500
    );
  }
  return {
    requestId: typeof quoteRecord.requestId === "string" ? quoteRecord.requestId : null,
    position: { lat: position.lat, lon: position.lon },
    seatPosition: { lat: position.lat, lon: position.lon },
    territoryRadiusM: typeof quoteRecord.territoryRadiusM === "number"
      ? quoteRecord.territoryRadiusM
      : null,
    sourceFlag: sourceFlag ? sourceFlag as KingdomFoundingSourceFlag : null,
    absorbedFlagCount: typeof quoteRecord.absorbedFlagCount === "number"
      ? quoteRecord.absorbedFlagCount
      : 0,
    eligible: quoteRecord.eligible === true,
    affordable: typeof quoteRecord.affordable === "boolean" ? quoteRecord.affordable : null,
    disabledReason: typeof quoteRecord.disabledReason === "string" ? quoteRecord.disabledReason : null,
    blockerCode: typeof quoteRecord.blockerCode === "string" ? quoteRecord.blockerCode : null,
    guidance: typeof quoteRecord.guidance === "string" ? quoteRecord.guidance : null,
    environment: environment ? environment as KingdomEnvironmentSnapshot : null,
    quote: constructionQuote,
    affordability,
    informational: quoteRecord.informational === true,
    reservationNotice: typeof quoteRecord.reservationNotice === "string"
      ? quoteRecord.reservationNotice
      : "This quote is informational and reserves nothing; confirmation revalidates all rules."
  };
}

function stateFromPayload(payload: unknown): KingdomStateSnapshot {
  const record = objectRecord(payload);
  const state = objectRecord(record?.state) ?? objectRecord(record?.snapshot) ?? record;
  if (
    !state ||
    !("membership" in state) ||
    !Array.isArray(state.permissions) ||
    !Array.isArray(state.roster) ||
    !Array.isArray(state.invitations) ||
    !Array.isArray(state.chatHistory) ||
    !Array.isArray(state.treasury) ||
    !(state.treasuryExpenditureHistory === null || Array.isArray(state.treasuryExpenditureHistory)) ||
    !Array.isArray(state.activityHistory) ||
    !Array.isArray(state.cots) ||
    !Array.isArray(state.decorations) ||
    !Array.isArray(state.decorationCatalog) ||
    !Array.isArray(state.nearbyKingdoms)
  ) {
    throw new KingdomApiError(
      "INVALID_KINGDOM_RESPONSE",
      "Invalid Kingdom service response",
      500
    );
  }
  return state as KingdomStateSnapshot;
}

function isConstructionQuote(value: unknown): value is KingdomConstructionQuote {
  const record = objectRecord(value);
  return Boolean(
    record &&
      (record.action === "found" || record.action === "cot" || record.action === "decoration") &&
      typeof record.freeConstruction === "boolean" &&
      Array.isArray(record.intendedCost) &&
      typeof record.intendedConstructionSeconds === "number" &&
      Array.isArray(record.adjustedCost) &&
      typeof record.adjustedConstructionSeconds === "number" &&
      Array.isArray(record.modifiers)
  );
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorFromPayload(
  payload: unknown
): { code?: string; message?: string; details?: unknown } | null {
  const payloadRecord = objectRecord(payload);
  const error = objectRecord(payloadRecord?.error) ?? payloadRecord;
  if (!error) return null;
  return {
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.message === "string" ? { message: error.message } : {}),
    ...("details" in error ? { details: error.details } : {})
  };
}
