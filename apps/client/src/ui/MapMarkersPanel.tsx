import {
  INVENTORY_CATALOG,
  MAP_COMPASS_RECIPE,
  SURVEY_STAKE_KIT_RECIPE,
  MAP_MARKER_NAME_MAX_LENGTH,
  TRADE_SKILL_GATES,
  tradeSkillGateMessage,
  tradeSkillGateMet,
  type MapMarkersState,
  type WorldMapDestination
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import type { MapMarkersFeature, PendingMarkerSpot } from "../features/mapMarkers/useMapMarkers.js";
import { GameAppButton, GameAppCard, GameAppSectionHeader, GameAppShell, GameAppState } from "./GameAppShell.js";

export type WaypointEstate = Extract<WorldMapDestination, { kind: "city" | "manor" | "kingdom" | "atlas_shrine" }>;

function recipeText(recipe: Readonly<Record<string, number>>): string {
  return Object.entries(recipe)
    .map(([itemId, quantity]) => `${quantity} ${INVENTORY_CATALOG[itemId]?.displayName ?? itemId}`)
    .join(" + ");
}

export function MapMarkersPanel({
  feature,
  estates,
  onTravelToRecorded,
  layout,
  connected
}: Readonly<{
  feature: MapMarkersFeature;
  /** Voyager: travel to one of the recorded locations. */
  onTravelToRecorded(locationId: string): void;
  /** The player's own estates (manor, flags, city) that can be targeted by a waypoint. */
  estates: readonly WaypointEstate[];
  layout: "desktop" | "phone";
  connected: boolean;
}>): React.JSX.Element | null {
  const { open, state, busy, error, pendingSpot } = feature.view;
  if (!open) return null;
  return <GameAppShell
    open
    title="Map Markers"
    closeLabel="Close Map Markers"
    layout={layout}
    onClose={feature.actions.closePanel}
  >
    {error ? <GameAppState variant="error" title={error} /> : null}
    {state ? <MarkersBody
      state={state}
      estates={estates}
      pendingSpot={pendingSpot}
      busy={busy || !connected}
      feature={feature}
      onTravelToRecorded={onTravelToRecorded}
    /> : <p>Reading your map...</p>}
  </GameAppShell>;
}

function MarkersBody({
  state,
  estates,
  pendingSpot,
  busy,
  feature,
  onTravelToRecorded
}: Readonly<{
  state: MapMarkersState;
  estates: readonly WaypointEstate[];
  pendingSpot: PendingMarkerSpot | null;
  busy: boolean;
  feature: MapMarkersFeature;
  onTravelToRecorded(locationId: string): void;
}>): React.JSX.Element {
  const { actions } = feature;
  const compass = state.compass;
  const daysLeft = Math.max(0, compass.maxDays - compass.daysUsed);
  const full = state.markers.length >= state.markerCap;
  const compassGate = TRADE_SKILL_GATES.artisan_compass;
  const kitGate = TRADE_SKILL_GATES.craft_survey_stake_kit;
  const canArtisanCompass = tradeSkillGateMet(compassGate, state.cartographyRank);
  const canCraftKit = tradeSkillGateMet(kitGate, state.cartographyRank);
  return <>
    <GameAppSectionHeader title="Carried" />
    <GameAppCard
      title="Compass"
      badge={compass.held ? `${daysLeft} of ${compass.maxDays} days left` : "Not carried"}
      action={compass.held
        ? <GameAppButton disabled={busy} onClick={() => actions.openCompass()}>Use Compass</GameAppButton>
        : <GameAppButton variant="primary" disabled={busy || !canArtisanCompass} onClick={() => actions.craft("compass")}>Artisan Compass</GameAppButton>}
    >
      <span>{compass.held
        ? "Shows your markers on the World Map and one waypoint arrow on your circle. A day counts when you use it."
        : canArtisanCompass ? `Needs ${recipeText(MAP_COMPASS_RECIPE)}.` : tradeSkillGateMessage(compassGate)}</span>
    </GameAppCard>
    <GameAppCard
      title="Survey Stake Kits"
      badge={`${state.kitCount} carried`}
      action={<GameAppButton disabled={busy || !canCraftKit} onClick={() => actions.craft("survey_stake_kit")}>Craft kit</GameAppButton>}
    >
      <span>One kit names one spot. Needs {recipeText(SURVEY_STAKE_KIT_RECIPE)}.{canCraftKit ? "" : ` ${tradeSkillGateMessage(kitGate)}`}</span>
    </GameAppCard>

    {pendingSpot ? <MarkForm
      key={`${pendingSpot.kind}:${pendingSpot.defaultName}`}
      spot={pendingSpot}
      disabled={busy || state.kitCount < 1 || full}
      reason={full
        ? `You can keep ${state.markerCap} markers. Delete one first.`
        : state.kitCount < 1 ? "You need a Survey Stake Kit." : null}
      onConfirm={(name) => actions.create(name, pendingSpot)}
      onCancel={() => actions.startMarking(null)}
    /> : <GameAppCard
      title="Mark a spot"
      action={<GameAppButton
        variant="primary"
        disabled={busy}
        onClick={() => actions.startMarking({ kind: "here", defaultName: "My spot" })}
      >Mark my position</GameAppButton>}
    ><span>To mark a building, tap it and choose Mark Location.</span></GameAppCard>}

    {state.waypoint ? <GameAppCard
      title="Active waypoint"
      badge={state.waypoint.label}
      action={<GameAppButton disabled={busy} onClick={() => actions.clearWaypoint()}>Clear waypoint</GameAppButton>}
    ><span>An arrow on your circle points toward it.</span></GameAppCard> : null}

    <GameAppSectionHeader title={`Markers ${state.markers.length} / ${state.markerCap}`} />
    {state.markers.length === 0 ? <p>No markers yet.</p> : state.markers.map((marker) =>
      <MarkerCard
        key={marker.id}
        marker={marker}
        active={state.waypoint?.markerId === marker.id}
        busy={busy}
        compassHeld={compass.held}
        feature={feature}
      />)}

    {state.voyager ? <VoyagerSection
      voyager={state.voyager}
      compassHeld={compass.held}
      busy={busy}
      feature={feature}
      onTravel={onTravelToRecorded}
    /> : null}

    {estates.length > 0 ? <>
      <GameAppSectionHeader title="Your estates" />
      {estates.map((estate) => <GameAppCard
        key={`${estate.kind}:${estate.id}`}
        title={estate.name}
        action={<GameAppButton
          disabled={busy || !compass.held}
          title={compass.held ? undefined : "Needs a Compass"}
          onClick={() => actions.setWaypointToDestination(estate.kind, estate.id)}
        >Set waypoint</GameAppButton>}
      ><span>{compass.held ? "Point your arrow here." : "Needs a Compass."}</span></GameAppCard>)}
    </> : null}
  </>;
}

function VoyagerSection({
  voyager,
  compassHeld,
  busy,
  feature,
  onTravel
}: Readonly<{
  voyager: NonNullable<MapMarkersState["voyager"]>;
  compassHeld: boolean;
  busy: boolean;
  feature: MapMarkersFeature;
  onTravel(locationId: string): void;
}>): React.JSX.Element {
  const { actions } = feature;
  const [name, setName] = useState("My camp");
  const full = voyager.locations.length >= voyager.recordCap;
  return <>
    <GameAppSectionHeader title={`Recorded locations ${voyager.locations.length} / ${voyager.recordCap}`} />
    <GameAppCard
      title="Record this position"
      badge={`${voyager.recordCost} ${INVENTORY_CATALOG.refined_oil?.displayName ?? "Glimmer Oil"}`}
      action={<GameAppButton
        variant="primary"
        disabled={busy || full || name.trim().length === 0}
        onClick={() => actions.recordLocation(name)}
      >Record</GameAppButton>}
    >
      <label>
        <span className="sr-only">Recorded location name</span>
        <input
          value={name}
          maxLength={MAP_MARKER_NAME_MAX_LENGTH}
          autoComplete="off"
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {full ? <span>Forget a location first.</span> : null}
    </GameAppCard>
    {voyager.locations.map((location) => <GameAppCard
      key={location.id}
      title={location.name}
      action={<>
        <GameAppButton variant="primary" disabled={busy} onClick={() => onTravel(location.id)}>Travel</GameAppButton>
        <GameAppButton
          disabled={busy || !compassHeld}
          title={compassHeld ? undefined : "Needs a Compass"}
          onClick={() => actions.setWaypointToRecorded(location.id)}
        >Set waypoint</GameAppButton>
        <GameAppButton variant="destructive" disabled={busy} onClick={() => actions.deleteRecordedLocation(location.id)}>Forget</GameAppButton>
      </>}
    ><span>{`${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}`}</span></GameAppCard>)}
  </>;
}

function MarkForm({
  spot,
  disabled,
  reason,
  onConfirm,
  onCancel
}: Readonly<{
  spot: PendingMarkerSpot;
  disabled: boolean;
  reason: string | null;
  onConfirm(name: string): void;
  onCancel(): void;
}>): React.JSX.Element {
  const [name, setName] = useState(spot.defaultName.slice(0, MAP_MARKER_NAME_MAX_LENGTH));
  return <GameAppCard
    title={spot.kind === "here" ? "Name your position" : "Name this building"}
    badge="Uses 1 kit"
    action={<>
      <GameAppButton variant="primary" disabled={disabled || name.trim().length === 0} onClick={() => onConfirm(name)}>Mark Location</GameAppButton>
      <GameAppButton variant="quiet" onClick={onCancel}>Cancel</GameAppButton>
    </>}
  >
    <label>
      <span className="sr-only">Marker name</span>
      <input
        value={name}
        maxLength={MAP_MARKER_NAME_MAX_LENGTH}
        autoComplete="off"
        onChange={(event) => setName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !disabled && name.trim()) onConfirm(name);
        }}
      />
    </label>
    {reason ? <span>{reason}</span> : null}
  </GameAppCard>;
}

function MarkerCard({
  marker,
  active,
  busy,
  compassHeld,
  feature
}: Readonly<{
  marker: MapMarkersState["markers"][number];
  active: boolean;
  busy: boolean;
  compassHeld: boolean;
  feature: MapMarkersFeature;
}>): React.JSX.Element {
  const { actions } = feature;
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [name, setName] = useState(marker.name);
  useEffect(() => setName(marker.name), [marker.name]);
  return <GameAppCard
    title={marker.name}
    {...(active ? { badge: "Waypoint" } : {})}
    action={mode === "view" ? <>
      <GameAppButton
        disabled={busy || !compassHeld || active}
        title={compassHeld ? undefined : "Needs a Compass"}
        onClick={() => actions.setWaypointToMarker(marker.id)}
      >Set waypoint</GameAppButton>
      <GameAppButton variant="quiet" disabled={busy} onClick={() => setMode("rename")}>Rename</GameAppButton>
      <GameAppButton variant="destructive" disabled={busy} onClick={() => setMode("delete")}>Delete</GameAppButton>
    </> : mode === "rename" ? <>
      <GameAppButton
        variant="primary"
        disabled={busy || name.trim().length === 0}
        onClick={() => {
          if (actions.rename(marker.id, name)) setMode("view");
        }}
      >Save name</GameAppButton>
      <GameAppButton variant="quiet" onClick={() => setMode("view")}>Cancel</GameAppButton>
    </> : <>
      <GameAppButton variant="destructive" disabled={busy} onClick={() => actions.remove(marker.id)}>Delete marker</GameAppButton>
      <GameAppButton variant="quiet" onClick={() => setMode("view")}>Keep</GameAppButton>
    </>}
  >
    {mode === "rename"
      ? <label>
        <span className="sr-only">New marker name</span>
        <input
          value={name}
          maxLength={MAP_MARKER_NAME_MAX_LENGTH}
          autoComplete="off"
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      : <span>{mode === "delete"
        ? "Delete this marker for good? The kit is not refunded."
        : `${marker.lat.toFixed(4)}, ${marker.lon.toFixed(4)}`}</span>}
  </GameAppCard>;
}
