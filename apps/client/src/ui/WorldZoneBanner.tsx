import {
  distanceMeters,
  isWorldZoneDiscoverableBiome,
  WORLD_ZONE_DISCOVERABLE_BIOMES,
  WORLD_ZONE_TAG_NAMES,
  worldSeasonAt,
  worldZoneBannerContent,
  worldZoneFromCode,
  worldZoneFromParts,
  type WorldZoneBannerContent,
  type WorldZoneDiscoverableBiome,
  type WorldZoneResolution,
  type WorldZoneTag
} from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import { loadWorldZoneLookup, type WorldZoneLookup } from "../map/worldZoneLookup.js";
import {
  INITIAL_WORLD_ZONE_BANNER_STATE,
  markWorldZoneArrival,
  observeWorldZone
} from "./worldZoneBannerScheduler.js";

/** Matches the `world-zone-banner-reveal` animation in styles.css. */
export const WORLD_ZONE_BANNER_VISIBLE_MS = 7_600;
/** Taking damage counts as combat for this long, even when the player has not fought back. */
const WORLD_ZONE_BANNER_HURT_MS = 6_000;

/** The server's zone answer is used only while the player is this close to where it was asked. */
const WORLD_ZONE_SERVER_MATCH_M = 150;

/** The server's latest `BIOME_DISCOVERY_SNAPSHOT`; persistence is server-side only. */
export type WorldZoneDiscovery = Readonly<{
  biomes: readonly WorldZoneDiscoverableBiome[];
  newlyDiscovered: WorldZoneDiscoverableBiome | null;
  /** World-authoritative zone (water and shore tags) at the server's player position. */
  current: WorldZoneResolution | null;
  /** Local player position when the answered request was sent. */
  requestedAt: Readonly<{ lat: number; lon: number }> | null;
}>;

export type WorldZoneView = Readonly<{
  content: WorldZoneBannerContent;
  tags: readonly WorldZoneTag[];
}>;

export type WorldZoneBannerView = Readonly<{
  sequence: number;
  content: WorldZoneBannerContent;
}>;

export type WorldZoneReadoutView = Readonly<{
  title: string;
  detail: string;
  /** Null until the server has sent the player's discoveries. */
  discovered: number | null;
}>;

export function WorldZoneBanner({
  banner,
  preview = false
}: {
  banner: WorldZoneBannerView | null;
  /** UI Standards gallery: hold the banner still instead of playing the reveal. */
  preview?: boolean;
}) {
  if (!banner) return null;
  return (
    <div
      key={banner.sequence}
      className={preview ? "world-zone-banner world-zone-banner--preview" : "world-zone-banner"}
      role="status"
      aria-live="polite"
      data-world-zone={banner.content.key}
    >
      <span className="world-zone-banner__title">{banner.content.title}</span>
      <span className="world-zone-banner__rule" aria-hidden="true" />
      <span className="world-zone-banner__detail">{banner.content.detail}</span>
    </div>
  );
}

/** Passive World Map plate: the zone under the player and their discovery count. */
export function WorldZoneReadout({ readout }: { readout: WorldZoneReadoutView | null }) {
  if (!readout) return null;
  return (
    <div className="world-zone-readout" role="group" aria-label="Current region">
      <span className="world-zone-readout__title">{readout.title}</span>
      <span className="world-zone-readout__detail">{readout.detail}</span>
      {readout.discovered !== null ? (
        <span className="world-zone-readout__count">
          Regions discovered {readout.discovered} / {WORLD_ZONE_DISCOVERABLE_BIOMES.length}
        </span>
      ) : null}
    </div>
  );
}

/** Starts loading the bundled zone lookup on mount; null until it is ready or if it fails. */
export function useWorldZoneLookup(): WorldZoneLookup | null {
  const [lookup, setLookup] = useState<WorldZoneLookup | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadWorldZoneLookup().then((loaded) => {
      if (!cancelled) setLookup(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return lookup;
}

/**
 * Biome, season, height or depth, and shore tags at a point. Uses the server's World-authoritative
 * answer while the player is still where it was asked, otherwise the cooked lookup (no tags).
 * Null without a lookup or position.
 */
export function worldZoneViewAt(
  lookup: WorldZoneLookup | null,
  position: Readonly<{ lat: number; lon: number }> | null,
  discovery: WorldZoneDiscovery | null = null
): WorldZoneView | null {
  if (!lookup || !position) return null;
  const server = discovery?.current && discovery.requestedAt
    && distanceMeters(discovery.requestedAt, position) <= WORLD_ZONE_SERVER_MATCH_M
    ? discovery.current
    : null;
  const zone = server
    ? worldZoneFromParts(server.biome, server.heightWord)
    : worldZoneFromCode(lookup.codeAt(position.lat, position.lon), position.lat);
  const season = worldSeasonAt({
    latitude: position.lat,
    date: new Date(),
    elevationBand: zone.elevationBand,
    biome: zone.biome
  });
  return { content: worldZoneBannerContent(zone, season), tags: server?.tags ?? [] };
}

/** World Map readout lines, for example "Plains · Riverside" over "Early Autumn · Lowland". */
export function worldZoneReadoutFor(
  view: WorldZoneView,
  discovered: number | null
): WorldZoneReadoutView {
  return {
    title: [view.content.title, ...view.tags.map((tag) => WORLD_ZONE_TAG_NAMES[tag])].join(" · "),
    detail: view.content.detail,
    discovered
  };
}

/** True for a few seconds after the local player's health drops; damage counts as combat. */
export function useRecentlyHurt(health: number | null): boolean {
  const [hurt, setHurt] = useState(false);
  const lastHealthRef = useRef<number | null>(null);
  const hurtTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const previous = lastHealthRef.current;
    lastHealthRef.current = health;
    if (health === null || previous === null || health >= previous) return;
    setHurt(true);
    if (hurtTimerRef.current !== null) window.clearTimeout(hurtTimerRef.current);
    hurtTimerRef.current = window.setTimeout(() => {
      hurtTimerRef.current = null;
      setHurt(false);
    }, WORLD_ZONE_BANNER_HURT_MS);
  }, [health]);
  useEffect(() => () => {
    if (hurtTimerRef.current !== null) window.clearTimeout(hurtTimerRef.current);
  }, []);
  return hurt;
}

/**
 * Announces the zone under the local player from the bundled lookup. A zone shows after a short
 * dwell, never twice in a row, and waits while `suppressed` (combat, travel, World Map) is true.
 * Each newly settled zone calls `onZoneSettled` so the server can record a discovery from its
 * own position. A first discovery is celebrated separately by RegionCelebration.
 */
export function useWorldZoneBanner(input: {
  lookup: WorldZoneLookup | null;
  discovery: WorldZoneDiscovery | null;
  onZoneSettled(): void;
  position: Readonly<{ lat: number; lon: number }> | null;
  inWorld: boolean;
  traveling: boolean;
  suppressed: boolean;
  /** Local player health; any drop suppresses the banner for a few seconds. */
  health: number | null;
}): WorldZoneBannerView | null {
  const { lookup, discovery, position, inWorld, traveling, health } = input;
  const onZoneSettledRef = useRef(input.onZoneSettled);
  onZoneSettledRef.current = input.onZoneSettled;
  const hurt = useRecentlyHurt(health);
  const suppressed = input.suppressed || hurt || traveling || !inWorld;
  const [banner, setBanner] = useState<WorldZoneBannerView | null>(null);
  const [recheck, setRecheck] = useState(0);
  const schedulerRef = useRef(INITIAL_WORLD_ZONE_BANNER_STATE);
  const sequenceRef = useRef(0);
  const previousRef = useRef({ inWorld, traveling });

  const content = useMemo(
    () => worldZoneViewAt(lookup, position, discovery)?.content ?? null,
    [lookup, position?.lat, position?.lon, discovery]
  );
  const contentKey = content ? `${content.key}|${content.detail}` : null;

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { inWorld, traveling };
    if ((inWorld && !previous.inWorld) || (!traveling && previous.traveling)) {
      schedulerRef.current = markWorldZoneArrival(schedulerRef.current);
    }
    const previousPresentedKey = schedulerRef.current.presentedKey;
    const decision = observeWorldZone(schedulerRef.current, {
      now: Date.now(),
      content,
      suppressed
    });
    schedulerRef.current = decision.state;
    if (decision.show) {
      const shown = decision.show;
      sequenceRef.current += 1;
      setBanner({ sequence: sequenceRef.current, content: shown });
    }
    if (
      decision.state.presentedKey !== null
      && decision.state.presentedKey !== previousPresentedKey
      && isWorldZoneDiscoverableBiome(decision.state.presentedKey)
    ) {
      onZoneSettledRef.current();
    }
    if (decision.recheckAt === null) return;
    const timer = window.setTimeout(
      () => setRecheck((value) => value + 1),
      Math.max(0, decision.recheckAt - Date.now())
    );
    return () => window.clearTimeout(timer);
    // `content` is represented by contentKey so movement inside one zone does not re-run this.
  }, [contentKey, suppressed, inWorld, traveling, recheck]);

  useEffect(() => {
    if (!banner) return;
    // A fight or a trip starting dismisses the banner instead of pausing it.
    if (suppressed) {
      setBanner(null);
      return;
    }
    const timer = window.setTimeout(() => setBanner(null), WORLD_ZONE_BANNER_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [banner, suppressed]);

  return suppressed ? null : banner;
}
