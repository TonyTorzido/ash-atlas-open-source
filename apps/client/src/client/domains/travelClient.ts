import type {
  LocationFixReason,
  NativeLocationSignals,
  ClientMessage,
  FlagSnapshot,
  VisibleFlagDestinationAuthority,
  WorldMapDestination
} from "@ash-atlas/shared";
import { requestIdCrypto as crypto } from "../../requestId.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

/**
 * Optional device trust fields on location messages. Callers pass them only
 * when the session advertises `trustNativeSignalsAccepted`.
 */
export type LocationTrustFields = Readonly<{
  native?: NativeLocationSignals | undefined;
  attestationRef?: string | undefined;
}>;

function trustFields(trust: LocationTrustFields | undefined): LocationTrustFields {
  if (!trust) return {};
  return {
    ...(trust.native === undefined ? {} : { native: trust.native }),
    ...(trust.attestationRef === undefined ? {} : { attestationRef: trust.attestationRef })
  };
}

export type VisibleFlagVisitAuthority = Readonly<{
  expectedConnectionGeneration: number;
  expectedGameplayViewGeneration: number;
  expectedResourceVisionRevision: number;
  expectedFlagSetRevision: number;
  expectedDestination: VisibleFlagDestinationAuthority;
}>;

export function destinationAuthorityForVisibleFlag(
  flag: FlagSnapshot
): VisibleFlagDestinationAuthority {
  return {
    lat: flag.lat,
    lon: flag.lon,
    claimRadiusM: flag.claimRadiusM,
    ...(flag.resourceVisionRadiusM === undefined
      ? {}
      : { resourceVisionRadiusM: flag.resourceVisionRadiusM }),
    ...(flag.controlType === "personal"
      ? { personalFlagId: flag.id }
      : {})
  };
}

export class TravelClient {
  constructor(private readonly port: ClientCommandPort) {}

  visitFlag(
      flagId: string,
      requestId = crypto.randomUUID(),
      expectedTollGold?: string
    ): string | null {
      const sent = this.send({
        type: "VISIT_FLAG",
        requestId,
        flagId,
        source: "visible_map",
        ...(expectedTollGold === undefined ? {} : { expectedTollGold })
      });
      if (!sent) return null;
      return requestId;
    }

  visitWorldMapKingdom(
      seatId: string,
      requestId = crypto.randomUUID()
    ): string | null {
      const sent = this.send({
        type: "VISIT_WORLD_MAP_KINGDOM",
        requestId,
        seatId
      });
      if (!sent) return null;
      return requestId;
    }

  visitWorldMapAtlasShrine(
      flagId: string,
      requestId = crypto.randomUUID()
    ): string | null {
      const sent = this.send({
        type: "VISIT_WORLD_MAP_ATLAS_SHRINE",
        requestId,
        flagId
      });
      if (!sent) return null;
      return requestId;
    }

  visitWorldMapHollinHut(
      hutId: string,
      requestId = crypto.randomUUID()
    ): string | null {
      const sent = this.send({ type: "VISIT_WORLD_MAP_HOLLIN_HUT", requestId, hutId });
      return sent ? requestId : null;
    }

  /** Find Open Land: travel to the spot the Trail Hound found (held by the server). */
  visitOpenLand(requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "VISIT_OPEN_LAND", requestId }) ? requestId : null;
  }

  /** Voyager: travel to one of the player's recorded locations. */
  visitRecordedLocation(locationId: string, requestId = crypto.randomUUID()): string | null {
    return this.send({ type: "VISIT_RECORDED_LOCATION", requestId, locationId }) ? requestId : null;
  }

  prepareWorldMapTravel(
      destination: WorldMapDestination,
      requestId = crypto.randomUUID()
    ): string | null {
      const sent = this.send({
        type: "PREPARE_WORLD_MAP_TRAVEL",
        requestId,
        destinationKind: destination.kind,
        destinationId: destination.id
      });
      if (!sent) return null;
      return requestId;
    }

  cancelWorldMapTravel(requestId: string): boolean {
      return this.send({
        type: "CANCEL_WORLD_MAP_TRAVEL",
        requestId
      });
    }

  visitCity(cityId: string): string | null {
      const requestId = crypto.randomUUID();
      return this.send({ type: "VISIT_CITY", requestId, cityId })
        ? requestId
        : null;
    }

  visitCityHouse(structureId: string): string | null {
      const requestId = crypto.randomUUID();
      return this.send({ type: "VISIT_CITY_HOUSE", requestId, structureId })
        ? requestId
        : null;
    }

  visitCityMarket(
      structureId: string,
      expectedPlacementRevision: string,
      requestId = crypto.randomUUID()
    ): string | null {
      const sent = this.send({
        type: "VISIT_CITY_MARKET",
        requestId,
        structureId,
        expectedPlacementRevision
      });
      return sent ? requestId : null;
    }

  visitCityWarehouse(
      structureId: string,
      expectedPlacementRevision: string,
      requestId = crypto.randomUUID()
    ): string | null {
      const sent = this.send({
        type: "VISIT_CITY_WAREHOUSE",
        requestId,
        structureId,
        expectedPlacementRevision
      });
      return sent ? requestId : null;
    }

  visitWorldMapCity(
      cityId: string,
      requestId = crypto.randomUUID()
    ): string | null {
      const sent = this.send({ type: "VISIT_WORLD_MAP_CITY", requestId, cityId });
      if (!sent) return null;
      return requestId;
    }

  sendTravelInvite(
      targetPlayerId: string,
      requestId = crypto.randomUUID()
    ): string | null {
      return this.send({ type: "SEND_TRAVEL_INVITE", requestId, targetPlayerId })
        ? requestId
        : null;
    }

  respondTravelInvite(
      inviteId: string,
      response: "accept" | "decline",
      requestId = crypto.randomUUID()
    ): string | null {
      const sent = this.send({
        type: "RESPOND_TRAVEL_INVITE",
        requestId,
        inviteId,
        response
      });
      if (!sent) return null;
      return requestId;
    }

  cancelTravelInvite(inviteId: string): boolean {
      return this.cancelTravelInviteRequest(inviteId) !== null;
    }

  cancelTravelInviteRequest(inviteId: string, requestId = crypto.randomUUID()): string | null {
      return this.send({ type: "CANCEL_TRAVEL_INVITE", requestId, inviteId }) ? requestId : null;
    }

  requestTravelInbox(): boolean {
      return this.send({ type: "REQUEST_TRAVEL_INBOX", requestId: crypto.randomUUID() });
    }

  travelToPartyLeader(
      requestId = crypto.randomUUID()
    ): string | null {
      if (!this.send({
        type: "TRAVEL_TO_PARTY_LEADER",
        requestId
      })) return null;
      return requestId;
    }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }

  relocateToCurrentLocation(
    lat: number,
    lon: number,
    accuracy?: number,
    requestId = crypto.randomUUID(),
    deviceTimeZone?: string,
    trust?: LocationTrustFields
  ): string | null {
    const sent = this.send({
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId,
      lat,
      lon,
      ...(accuracy === undefined ? {} : { accuracy }),
      ...(deviceTimeZone === undefined ? {} : { deviceTimeZone }),
      ...trustFields(trust)
    });
    return sent ? requestId : null;
  }

  /** Fire-and-forget passive fix for the location trust ledger; the server never replies. */
  sendLocationFix(
    lat: number,
    lon: number,
    accuracy?: number,
    deviceTimeZone?: string,
    reason?: LocationFixReason,
    trust?: LocationTrustFields
  ): boolean {
    return this.send({
      type: "LOCATION_FIX",
      lat,
      lon,
      ...(accuracy === undefined ? {} : { accuracy }),
      ...(deviceTimeZone === undefined ? {} : { deviceTimeZone }),
      ...(reason === undefined ? {} : { reason }),
      ...trustFields(trust)
    });
  }

  prepareVisibleFlagVisit(
    flagId: string,
    authority: VisibleFlagVisitAuthority,
    requestId = crypto.randomUUID(),
    expectedTollGold?: string
  ): string | null {
    const sent = this.send({
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId,
      flagId,
      ...authority,
      ...(expectedTollGold === undefined ? {} : { expectedTollGold })
    });
    return sent ? requestId : null;
  }

  commitVisibleFlagVisit(
    flagId: string,
    authority: VisibleFlagVisitAuthority,
    requestId = crypto.randomUUID(),
    preparationId?: string,
    expectedTollGold?: string
  ): string | null {
    const sent = this.send({
      type: "COMMIT_VISIBLE_FLAG_VISIT",
      requestId,
      flagId,
      ...authority,
      ...(preparationId === undefined ? {} : { preparationId }),
      ...(expectedTollGold === undefined ? {} : { expectedTollGold })
    });
    return sent ? requestId : null;
  }

  cancelVisibleFlagVisit(requestId: string): boolean {
    return this.send({
      type: "CANCEL_VISIBLE_FLAG_VISIT",
      requestId
    });
  }
}
