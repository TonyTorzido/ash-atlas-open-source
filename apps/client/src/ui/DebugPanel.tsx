import type {
  CombatEntitySnapshot,
  PlayerSnapshot,
  ResourceVision,
  ResourceVisionStatus
} from "@ash-atlas/shared";
import { distanceMeters } from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";
import type { BuildableStatus } from "../flags/buildStatus.js";
import { useMapZoom } from "./useMapZoom.js";

type DebugPanelProps = {
  combatEnabled: boolean;
  movementEnabled: boolean;
  geographyEnabled: boolean;
  player: PlayerSnapshot | null;
  zoom?: number;
  /** When given, the panel follows this map's zoom itself instead of re-rendering its parent. */
  map?: maplibregl.Map | null;
  visibleFlagCount: number;
  visibleCollectibleCount: number;
  resourceVision: ResourceVision | null;
  resourceVisionStatus: ResourceVisionStatus | null;
  waterHighlightCount: number;
  rttMs: number | null;
  lastSnapshotAgeMs: number | null;
  buildableStatus: BuildableStatus;
  players: PlayerSnapshot[];
  warning: string | null;
  combatPlayer: CombatEntitySnapshot | null;
  combatEntityCount: number;
  retainedDisplayObjectCount: number;
  worldProfile: WorldDebugProfile | null;
  worldProfileStatus: "loading" | "ready" | "unavailable";
};

export type WorldDebugProfile = {
  packageId: string;
  releaseId: string;
  administrative: string;
  environment: string;
  water: string;
  tags: string;
};

export function DebugPanel({
  combatEnabled,
  movementEnabled,
  geographyEnabled,
  player,
  zoom: zoomProp,
  map,
  visibleFlagCount,
  visibleCollectibleCount,
  resourceVision,
  resourceVisionStatus,
  waterHighlightCount,
  rttMs,
  lastSnapshotAgeMs,
  buildableStatus,
  players,
  warning,
  combatPlayer,
  combatEntityCount,
  retainedDisplayObjectCount,
  worldProfile,
  worldProfileStatus
}: DebugPanelProps): React.JSX.Element {
  const zoom = useMapZoom(map, zoomProp ?? 14);
  const onlinePlayers = players.filter((onlinePlayer) => onlinePlayer.online !== false);
  const otherPlayers = onlinePlayers.filter(
    (onlinePlayer) => onlinePlayer.playerId !== player?.playerId
  );
  return (
    <aside className="debug-panel">
      <div className="panel-title">Developer Diagnostics</div>
      {movementEnabled ? <>
      <div>Lat: {player ? player.lat.toFixed(6) : "unknown"}</div>
      <div>Lon: {player ? player.lon.toFixed(6) : "unknown"}</div>
      <div>
        Anchor:{" "}
        {player
          ? `${player.anchorLat.toFixed(6)}, ${player.anchorLon.toFixed(6)}`
          : "unknown"}
      </div>
      <div>Leash: {player ? formatLeash(player.moveLeashRadiusM) : "unknown"}</div>
      <div>
        Target:{" "}
        {player?.targetLat === null || player?.targetLat === undefined
          ? "none"
          : `${player.targetLat.toFixed(6)}, ${player.targetLon?.toFixed(6)}`}
      </div>
      <div>Zoom: {zoom.toFixed(2)}</div>
      <div>Online: {onlinePlayers.length}</div>
      {otherPlayers.length > 0 ? (
        <div className="online-player-list">
          {otherPlayers.slice(0, 4).map((onlinePlayer) => (
            <div key={onlinePlayer.playerId}>
              {onlinePlayer.username}
              {player
                ? ` (${formatDistance(
                    distanceMeters(
                      { lat: player.lat, lon: player.lon },
                      { lat: onlinePlayer.lat, lon: onlinePlayer.lon }
                    )
                  )})`
                : ""}
            </div>
          ))}
        </div>
      ) : null}
      <div>RTT: {rttMs === null ? "unknown" : `${rttMs.toFixed(0)} ms`}</div>
      <div>
        Snapshot:{" "}
        {lastSnapshotAgeMs === null ? "unknown" : `${lastSnapshotAgeMs.toFixed(0)} ms ago`}
      </div>
      </> : null}
      {geographyEnabled ? <>
      <div>
        World: {worldProfileStatus === "ready" ? worldProfile?.releaseId : worldProfileStatus}
      </div>
      {worldProfile ? (
        <>
          <div>Package: {worldProfile.packageId}</div>
          <div>Admin: {worldProfile.administrative}</div>
          <div>Environment: {worldProfile.environment}</div>
          <div>Water: {worldProfile.water}</div>
          <div>World tags: {worldProfile.tags}</div>
        </>
      ) : null}
      <div>Flags: {visibleFlagCount}</div>
      <div>Collectibles: {visibleCollectibleCount}</div>
      <div>
        Resource Vision:{" "}
        {resourceVision
          ? `${resourceVision.flagName} (${resourceVision.radiusM.toFixed(0)}m)`
          : "travel to a flag"}
      </div>
      <div>Vision status: {resourceVisionStatus?.status ?? (resourceVision ? "surveying" : "none")}</div>
      <div>Water highlights: {waterHighlightCount}</div>
      <div>Territory here: {buildableStatus.territoryLabel}</div>
      <div>{buildableStatus.label}</div>
      {warning ? <div className="warning">{warning}</div> : null}
      </> : null}
      {combatEnabled ? <>
      <div>
        Health: {combatPlayer ? `${combatPlayer.currentHealth} / ${combatPlayer.maxHealth}` : "unknown"}
      </div>
      <div>Combat entities: {combatEntityCount}</div>
      <div>Retained dynamic objects: {retainedDisplayObjectCount}</div>
      </> : null}
    </aside>
  );
}

function formatLeash(radiusMeters: number): string {
  const diameterMiles = (radiusMeters * 2) / 1609.344;
  return `${radiusMeters.toFixed(0)} m radius (${diameterMiles.toFixed(1)} mi across)`;
}

function formatDistance(distanceM: number): string {
  return distanceM < 1_000
    ? `${Math.round(distanceM)} m`
    : `${(distanceM / 1609.344).toFixed(2)} mi`;
}
