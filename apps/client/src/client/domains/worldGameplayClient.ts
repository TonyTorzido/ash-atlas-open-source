import type {
  ClientMessage,
  MapMarkerCommand,
  PopulationPreparationScope,
  PopulationPreparationTrigger,
  WorldMapDestination,
  WorldMapSocialAudience,
  WorldViewAuthority
} from "@ash-atlas/shared";
import { perfRecorder } from "../../perf/perfRecorder.js";
import { requestIdCrypto as crypto } from "../../requestId.js";
import { gameplayLatencyTrace } from "../../diagnostics/gameplayLatencyTrace.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export type PopulationResyncOperation = Readonly<{
  connectionId: string;
  connectionGeneration: number;
  preparationGeneration: number;
  relocationRevision: number;
  resourceVisionRevision: number;
  preparationTrigger: PopulationPreparationTrigger;
  preparationScope: PopulationPreparationScope;
}>;

export class WorldGameplayClient {
  constructor(private readonly port: ClientCommandPort) {}

  /** DASH: world-space unit vector (dirX east, dirY north); `lastDash` reports the previous dash's measurement. */
  dash(
    dirX: number,
    dirY: number,
    lastDash?: { requestId: string; pressToAcceptMs: number; correctionM: number; startOffsetM?: number } | null
  ): string | null {
    const message = {
      type: "DASH",
      requestId: crypto.randomUUID(),
      dirX,
      dirY,
      ...(lastDash ? { lastDash } : {})
    } as const;
    if (!this.send(message)) return null;
    gameplayLatencyTrace.record("movement", "dash_request_transmitted", {
      requestId: message.requestId,
      dirX,
      dirY
    }, { traceId: message.requestId });
    return message.requestId;
  }

  /**
   * SWING (action combat): world-space unit vector (dirX east, dirY north), per-connection
   * monotonic `seq`, and a lag hint in ms (rtt/2 + mob render delay; schema max 1000).
   * Returns the request id, or null when it could not be sent.
   */
  swing(seq: number, dirX: number, dirY: number, lagMs: number): string | null {
    const message = {
      type: "SWING",
      requestId: crypto.randomUUID(),
      seq,
      dirX,
      dirY,
      lagMs: Math.min(1_000, Math.max(0, Math.round(lagMs)))
    } as const;
    return this.send(message) ? message.requestId : null;
  }

  moveTo(lat: number, lon: number, boundTravelRequestId?: string, launchRaft = false, walk = false): string | null {
      const message = {
        type: "MOVE_TO",
        requestId: crypto.randomUUID(),
        ...(boundTravelRequestId ? { boundTravelRequestId } : {}),
        ...(launchRaft ? { launchRaft: true } : {}),
        ...(walk ? { walk: true } : {}),
        lat,
        lon
      } as const;
      if (this.send(message)) {
        perfRecorder.recordEvent("move_command_sent", {
          requestId: message.requestId,
          lat,
          lon
        });
        gameplayLatencyTrace.record("movement", "movement_request_transmitted", {
          requestId: message.requestId,
          boundTravelRequestId: boundTravelRequestId ?? null,
          requestedLat: lat,
          requestedLon: lon
        }, { traceId: message.requestId });
        return message.requestId;
      }
      return null;
    }

  /** The server resolves the biome from its own authoritative position. */
  requestBiomeDiscovery(): boolean {
    return this.send({ type: "REQUEST_BIOME_DISCOVERY" });
  }

  /** Survey Stake Kit / Compass command; resolves to the request id used to correlate the reply. */
  mapMarkerCommand(command: MapMarkerCommand): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type: "MAP_MARKER_COMMAND", requestId, command }) ? requestId : null;
  }

  requestWorldMapDestinations(): boolean {
      return this.send({
        type: "REQUEST_WORLD_MAP_DESTINATIONS",
        requestId: crypto.randomUUID()
      });
    }

  setWorldMapDestinationVisibility(
    destination: Pick<WorldMapDestination, "kind" | "id">,
    visible: boolean
  ): boolean {
    // A mark expires by itself; it has no visibility preference.
    if (destination.kind === "pathfinder_mark") return false;
    return this.send({
      type: "SET_WORLD_MAP_DESTINATION_VISIBILITY",
      requestId: crypto.randomUUID(),
      destinationKind: destination.kind,
      destinationId: destination.id,
      visible
    });
  }

  setWorldMapSocialVisibility(
    audience: WorldMapSocialAudience,
    visible: boolean
  ): boolean {
    return this.send({
      type: "SET_WORLD_MAP_SOCIAL_VISIBILITY",
      requestId: crypto.randomUUID(),
      audience,
      visible
    });
  }

  requestWorldResync(
    combatSequence: number,
    playerSequence: number,
    expectedWorldViewAuthority?: WorldViewAuthority
  ): boolean {
      return this.send({
        type: "REQUEST_WORLD_RESYNC",
        requestId: crypto.randomUUID(),
        combatSequence,
        playerSequence,
        ...(expectedWorldViewAuthority ? { expectedWorldViewAuthority } : {})
      });
    }

  requestPopulationResync(operation: PopulationResyncOperation): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "REQUEST_POPULATION_RESYNC",
      requestId,
      ...operation
    }) ? requestId : null;
  }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}
