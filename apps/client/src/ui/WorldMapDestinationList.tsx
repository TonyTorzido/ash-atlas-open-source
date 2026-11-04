import {
  distanceMeters,
  travelHungerCost,
  type LatLon,
  type WorldMapCityDestination,
  type WorldMapDestination
} from "@ash-atlas/shared";
import { useMemo, useState } from "react";

import { compareWorldMapDestinations } from "./worldMapDestinationPresentation.js";

export type WorldMapView = "list" | "globe";

/** Hub glyph (ring with four spokes) shared by list rows and globe markers. */
export const HUB_GLYPH_PATH = "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM12 2v6.5M12 15.5V22M2 12h6.5M15.5 12H22";

const VIEW_STORAGE_KEY = "ash-atlas.world-map.view";

/** List is the first-run default; the last chosen view is remembered per device. */
export function readStoredWorldMapView(): WorldMapView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "globe" ? "globe" : "list";
  } catch {
    return "list";
  }
}

export function storeWorldMapView(view: WorldMapView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Storage can be unavailable (private windows, blocked site data).
  }
}

type Section = Readonly<{
  id: string;
  title: string;
  destinations: readonly WorldMapDestination[];
}>;

export function WorldMapDestinationList({
  destinations,
  origin,
  travelDisabled,
  travelDisabledReason,
  travelBusy,
  failureMessage,
  notice,
  onTravel
}: Readonly<{
  destinations: readonly WorldMapDestination[];
  origin: LatLon;
  travelDisabled: boolean;
  travelDisabledReason: string | null;
  travelBusy: boolean;
  failureMessage: string | null;
  notice: React.ReactNode;
  onTravel(destination: WorldMapDestination): void;
}>): React.JSX.Element {
  const [query, setQuery] = useState("");
  const sections = useMemo(
    () => buildSections(destinations, query),
    [destinations, query]
  );
  return <section className="world-map-destination-list" aria-label="Travel destinations">
    <label className="world-map-destination-list-search">
      <span className="sr-only">Search travel destinations</span>
      <input
        type="search"
        value={query}
        placeholder="Search destinations"
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
    </label>
    {failureMessage ? <p className="world-map-destination-list-error" role="alert">{failureMessage}</p> : null}
    <div className="world-map-destination-list-scroll">
      {notice}
      {sections.map((section) => <section
        key={section.id}
        className={`world-map-destination-list-section world-map-destination-list-section--${section.id}`}
        aria-label={section.title}
      >
        <h3>{section.title}</h3>
        {section.destinations.map((destination) => {
          const meters = distanceMeters(origin, { lat: destination.lat, lon: destination.lon });
          const meta = [
            formatMapDistance(meters),
            destination.kind === "manor" ? null : `${travelHungerCost(meters)} Hunger`
          ].filter(Boolean).join(" · ");
          return <div
            key={`${destination.kind}:${destination.id}`}
            className="world-map-destination-list-row"
          >
            {destination.kind === "city" && destination.featured ? <svg className="world-map-destination-list-hub" viewBox="0 0 24 24" role="img" aria-label="Major hub">
              <path d={HUB_GLYPH_PATH} />
            </svg> : null}
            <span className="world-map-destination-list-name">
              <strong>{destination.name}</strong>
              <small>{meta}</small>
            </span>
            <button
              type="button"
              className="world-map-destination-list-travel"
              aria-label={`Travel to ${destination.name}`}
              disabled={travelDisabled || travelBusy}
              title={travelDisabledReason ?? undefined}
              onClick={() => onTravel(destination)}
            >{travelBusy ? "Travelling…" : "Travel"}</button>
          </div>;
        })}
      </section>)}
      {sections.length === 0 && !notice ? <p className="world-map-destination-list-empty">No matching destinations.</p> : null}
    </div>
  </section>;
}

function buildSections(
  destinations: readonly WorldMapDestination[],
  query: string
): Section[] {
  const needle = normalize(query);
  const matching = destinations.filter((destination) =>
    normalize(destination.name).includes(needle)
  );
  const city = (destination: WorldMapDestination): WorldMapCityDestination | null =>
    destination.kind === "city" ? destination : null;
  const major = matching
    .filter((destination) => city(destination)?.featured)
    .sort((left, right) =>
      Number(city(right)?.featured === "capital") - Number(city(left)?.featured === "capital") ||
      (city(right)?.memberCount ?? 0) - (city(left)?.memberCount ?? 0) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  const own = (destination: WorldMapDestination): number =>
    destination.kind === "city" ? (destination.member ? 0 : 4)
      : destination.kind === "manor" ? 1
        : destination.kind === "kingdom" ? 2 : 3;
  const yours = matching
    .filter((destination) => !city(destination)?.featured)
    .filter((destination) => {
      const item = city(destination);
      return !item || item.member || item.discovered !== false;
    })
    .sort((left, right) => own(left) - own(right) || compareWorldMapDestinations(left, right));
  return ([
    { id: "major", title: "Major destinations", destinations: major },
    { id: "yours", title: "Your destinations", destinations: yours }
  ] satisfies Section[]).filter((section) => section.destinations.length > 0);
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase()
    .trim();
}

function formatMapDistance(meters: number): string {
  if (meters < 1_000) return `${Math.round(meters)} m`;
  const miles = meters / 1_609.344;
  return miles < 100
    ? `${miles.toFixed(1)} mi`
    : `${Math.round(miles).toLocaleString()} mi`;
}
