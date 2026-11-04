import {
  CREATURE_BOOK_ROSTER,
  PLANT_BOOK_ROSTER,
  WORLD_MAP_MIN_ZOOM,
  type CreatureBookHabitatRestriction,
  type CreatureBookSlotSnapshot,
  type CreatureBookSnapshot,
  type PlantBookSlotSnapshot,
  type WorldEnvironmentOverlayGroupId
} from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import type { WorldMapInstance } from "../map/worldMap.js";
import type { WorldEnvironmentOverlayPresenter } from "../map/worldEnvironmentOverlays.js";
import { mobArtworkSource } from "../map/mobArtwork.js";
import { GameAppCard, GameAppTabs } from "./GameAppShell.js";
import { ItemArtwork, itemArtworkSource, itemArtworkStyle } from "./ItemArtwork.js";
import { PhoneMenuDestinationShell } from "./PhoneMenuDestinationShell.js";

type UnlockedSlot = Extract<CreatureBookSlotSnapshot, { unlocked: true }>;
type UnlockedPlant = Extract<PlantBookSlotSnapshot, { unlocked: true }>;

const HABITAT_TABS = [
  { id: "environment", label: "BIO", ariaLabel: "Biomes" },
  { id: "elevation", label: "ELE", ariaLabel: "Elevation" },
  { id: "terrain", label: "TER", ariaLabel: "Terrain" },
  { id: "ocean_depth", label: "SEA", ariaLabel: "Sea" }
] as const;
const EMPTY_HABITAT_RESTRICTIONS: readonly CreatureBookHabitatRestriction[] = [];

export function CreatureBookPanel(props: Readonly<{
  snapshot: CreatureBookSnapshot | null;
  onBack(): void;
}>): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<"beasts" | "plants">("beasts");
  const [selectedOrder, setSelectedOrder] = useState<number | null>(null);
  const slots = props.snapshot?.slots ?? [];
  const plants = props.snapshot?.plants ?? [];
  const selected = useMemo(
    () => slots.find((slot): slot is UnlockedSlot =>
      activeSection === "beasts" && slot.bookOrder === selectedOrder && slot.unlocked) ?? null,
    [activeSection, selectedOrder, slots]
  );
  const selectedPlant = useMemo(
    () => plants.find((plant): plant is UnlockedPlant =>
      activeSection === "plants" && plant.bookOrder === selectedOrder && plant.unlocked) ?? null,
    [activeSection, plants, selectedOrder]
  );
  const discoveredCount = slots.filter((slot) => slot.unlocked).length
    + plants.filter((plant) => plant.unlocked).length;
  const entryCount = slots.length + plants.length;
  const selectedEntry = selected || selectedPlant;

  return <PhoneMenuDestinationShell
    menuId="creature-book"
    title="Encyclopedia"
    headerStatus={props.snapshot ? { value: `${discoveredCount} / ${entryCount}`, label: "Discovered" } : null}
    className="creature-book-app"
    bodyClassName="creature-book-body"
    backLabel={selectedEntry ? "Back" : "Back to Game Menu"}
    onBack={selectedEntry ? () => setSelectedOrder(null) : props.onBack}
  >
    {!props.snapshot ? <GameAppCard title="Loading Encyclopedia" badge="Waiting">
      <p className="creature-book-copy" role="status">Waiting for the authoritative Encyclopedia.</p>
    </GameAppCard> : <>
      <GameAppTabs
        tabs={[{ id: "beasts", label: "Beasts" }, { id: "plants", label: "Plants" }]}
        activeTab={activeSection}
        ariaLabel="Encyclopedia sections"
        variant="housed"
        onChange={(section) => {
          setActiveSection(section as "beasts" | "plants");
          setSelectedOrder(null);
        }}
      />
      {selected
        ? <CreatureDetail key={selected.bookOrder} slot={selected} />
        : selectedPlant
          ? <PlantDetail key={selectedPlant.bookOrder} slot={selectedPlant} />
          : activeSection === "beasts"
            ? <div className="creature-book-grid" aria-label="Beast index">
                {slots.map((slot) => {
                  const roster = slot.unlocked ? slot : null;
                  const hiddenArchetype = CREATURE_BOOK_ROSTER.find(
                    (entry) => entry.bookOrder === slot.bookOrder
                  )?.archetypeKey;
                  const artwork = roster
                    ? mobArtworkSource(roster.archetypeKey)
                    : hiddenArchetype
                      ? mobArtworkSource(hiddenArchetype)
                      : null;
                  return <button
                    key={slot.bookOrder}
                    type="button"
                    className={`creature-book-slot${slot.unlocked ? " discovered" : " unseen"}`}
                    disabled={!slot.unlocked}
                    aria-label={slot.unlocked ? `Open ${slot.name}` : `Unknown creature ${slot.bookOrder + 1}`}
                    onClick={() => setSelectedOrder(slot.bookOrder)}
                  >
                    <span className="creature-book-portrait">
                      {artwork ? <img className={slot.unlocked ? undefined : "creature-book-silhouette"} src={artwork} alt="" aria-hidden="true" /> : <span className="creature-book-silhouette" aria-hidden="true" />}
                    </span>
                    <strong>{slot.unlocked ? slot.name : "???"}</strong>
                    <small>{slot.unlocked ? titleCase(slot.rarity) : "Undiscovered"}</small>
                  </button>;
                })}
              </div>
            : <div className="creature-book-grid" aria-label="Plant index">
                {plants.map((plant) => {
                  const roster = PLANT_BOOK_ROSTER.find(
                    (entry) => entry.bookOrder === plant.bookOrder
                  );
                  const artwork = roster ? itemArtworkSource(roster.itemId) : null;
                  return <button
                    key={plant.bookOrder}
                    type="button"
                    className={`creature-book-slot${plant.unlocked ? " discovered" : " unseen"}`}
                    disabled={!plant.unlocked}
                    aria-label={plant.unlocked ? `Open ${plant.name}` : `Unknown plant ${plant.bookOrder + 1}`}
                    onClick={() => setSelectedOrder(plant.bookOrder)}
                  >
                    <span className="creature-book-portrait">
                      {artwork ? <img className={`item-artwork${plant.unlocked ? "" : " creature-book-silhouette"}`} style={roster ? itemArtworkStyle(roster.itemId) : undefined} src={artwork} alt="" aria-hidden="true" /> : <span className="creature-book-silhouette" aria-hidden="true" />}
                    </span>
                    <strong>{plant.unlocked ? plant.name : "???"}</strong>
                    <small>{plant.unlocked ? titleCase(plant.rarity) : "Undiscovered"}</small>
                  </button>;
                })}
              </div>}
    </>}
  </PhoneMenuDestinationShell>;
}

function CreatureDetail({ slot }: Readonly<{ slot: UnlockedSlot }>): React.JSX.Element {
  return <div className="creature-book-detail">
    <NormalCreatureDetail slot={slot} />
  </div>;
}

function NormalCreatureDetail({ slot }: Readonly<{ slot: UnlockedSlot }>): React.JSX.Element {
  const natural = slot.habitat.kind === "natural" ? slot.habitat : null;
  const restrictions = natural?.restrictions ?? EMPTY_HABITAT_RESTRICTIONS;
  const habitatUnlocked = natural ? natural.restrictions !== null : true;
  const [activeGroupId, setActiveGroupId] = useState<WorldEnvironmentOverlayGroupId | null>(
    restrictions[0]?.groupId ?? null
  );
  const selectedRestriction = restrictions.find(({ groupId }) => groupId === activeGroupId)
    ?? restrictions[0]
    ?? null;
  useEffect(() => {
    if (!restrictions.some(({ groupId }) => groupId === activeGroupId)) {
      setActiveGroupId(restrictions[0]?.groupId ?? null);
    }
  }, [activeGroupId, restrictions]);
  return <>
    <GameAppCard
      title={slot.name}
      badge={titleCase(slot.rarity)}
      leading={<img className="creature-book-detail-art" src={mobArtworkSource(slot.archetypeKey) ?? undefined} alt="" aria-hidden="true" />}
    >
      <dl className="creature-book-facts">
        <div><dt>Active</dt><dd>{activeLabel(slot.habitat.active)}</dd></div>
        <div><dt>Total Kills</dt><dd>{slot.killCount === null ? "N/A" : slot.killCount.toLocaleString()}</dd></div>
        <div className={selectedRestriction ? "creature-book-habitat-fact" : undefined}>
          <dt>Habitat</dt>
          <dd className={selectedRestriction ? "creature-book-habitat-tabs" : undefined}>
            {slot.habitat.kind === "legendary"
              ? "N/A"
              : selectedRestriction
                ? <GameAppTabs
                    tabs={HABITAT_TABS.map((tab) => ({
                      ...tab,
                      disabled: !restrictions.some(({ groupId }) => groupId === tab.id)
                    }))}
                    activeTab={selectedRestriction.groupId}
                    ariaLabel="Habitat groups"
                    variant="housed"
                    onChange={(groupId) => {
                      const restriction = restrictions.find((candidate) => candidate.groupId === groupId);
                      if (restriction) setActiveGroupId(restriction.groupId);
                    }}
                  />
                : `${Math.min(slot.habitat.progress, slot.habitat.threshold)} / ${slot.habitat.threshold} kills`}
          </dd>
        </div>
      </dl>
      {natural && habitatUnlocked && selectedRestriction
        ? <HabitatMap restriction={selectedRestriction} />
        : null}
    </GameAppCard>
    <GameAppCard title="Observed Drops" badge={`${slot.drops.filter((drop) => drop.observed).length}/${slot.drops.length}`}>
      <div className="creature-book-drops">
        {slot.drops.map((drop) => drop.observed ? <article key={drop.slotOrder} className="creature-book-drop observed">
          <ItemArtwork itemId={drop.itemId} label={drop.displayName} />
          <strong>{drop.displayName}</strong>
          <small>{drop.occurrenceCount.toLocaleString()} observed · Observed Drop Rate: {formatRate(drop.observedRate)}</small>
        </article> : <article key={drop.slotOrder} className="creature-book-drop unknown" aria-label="Unobserved drop">
          <span aria-hidden="true">?</span><strong>Unknown</strong><small>Not yet observed</small>
        </article>)}
      </div>
    </GameAppCard>
  </>;
}

function PlantDetail({ slot }: Readonly<{ slot: UnlockedPlant }>): React.JSX.Element {
  const roster = PLANT_BOOK_ROSTER.find((entry) => entry.bookOrder === slot.bookOrder);
  const natural = slot.habitat.kind === "natural" ? slot.habitat : null;
  const restrictions = natural?.restrictions ?? EMPTY_HABITAT_RESTRICTIONS;
  const habitatUnlocked = natural ? natural.restrictions !== null : true;
  const [activeGroupId, setActiveGroupId] = useState<WorldEnvironmentOverlayGroupId | null>(
    restrictions[0]?.groupId ?? null
  );
  const selectedRestriction = restrictions.find(({ groupId }) => groupId === activeGroupId)
    ?? restrictions[0]
    ?? null;
  useEffect(() => {
    if (!restrictions.some(({ groupId }) => groupId === activeGroupId)) {
      setActiveGroupId(restrictions[0]?.groupId ?? null);
    }
  }, [activeGroupId, restrictions]);
  return <GameAppCard
    title={slot.name}
    badge={titleCase(slot.rarity)}
    leading={<img className="creature-book-detail-art item-artwork" style={itemArtworkStyle(roster?.itemId ?? "flax_fiber")} src={itemArtworkSource(roster?.itemId ?? "flax_fiber")} alt="" aria-hidden="true" />}
  >
    <dl className="creature-book-facts">
      <div><dt>Active</dt><dd>{slot.active.toLocaleString()}</dd></div>
      <div><dt>Total Harvests</dt><dd>{slot.totalHarvests.toLocaleString()}</dd></div>
      <div className={selectedRestriction ? "creature-book-habitat-fact" : undefined}>
        <dt>Habitat</dt>
        <dd className={selectedRestriction ? "creature-book-habitat-tabs" : undefined}>
          {selectedRestriction
            ? <GameAppTabs
                tabs={HABITAT_TABS.map((tab) => ({
                  ...tab,
                  disabled: !restrictions.some(({ groupId }) => groupId === tab.id)
                }))}
                activeTab={selectedRestriction.groupId}
                ariaLabel="Habitat groups"
                variant="housed"
                onChange={(groupId) => {
                  const restriction = restrictions.find((candidate) => candidate.groupId === groupId);
                  if (restriction) setActiveGroupId(restriction.groupId);
                }}
              />
            : `${Math.min(slot.habitat.progress, slot.habitat.threshold)} / ${slot.habitat.threshold} harvests`}
        </dd>
      </div>
    </dl>
    {natural && habitatUnlocked && selectedRestriction
      ? <HabitatMap restriction={selectedRestriction} ariaLabel="Plant habitat map" />
      : null}
  </GameAppCard>;
}

function HabitatMap({ restriction, ariaLabel = "Creature habitat map" }: Readonly<{
  restriction: CreatureBookHabitatRestriction;
  ariaLabel?: string;
}>): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<WorldMapInstance | null>(null);
  const presenterRef = useRef<WorldEnvironmentOverlayPresenter | null>(null);
  const latestRestrictionRef = useRef(restriction);
  latestRestrictionRef.current = restriction;
  useEffect(() => {
    presenterRef.current?.sync(restriction.groupId, restriction.categoryIds);
  }, [restriction]);
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    let cancelled = false;
    let install: (() => void) | null = null;
    void Promise.all([
      import("../map/worldMap.js"),
      import("../map/worldEnvironmentOverlays.js")
    ]).then(([worldMapModule, overlayModule]) => {
      if (cancelled) return;
      const instance = worldMapModule.createWorldMap(container, { lat: 20, lon: 0 });
      instance.map.jumpTo({ zoom: WORLD_MAP_MIN_ZOOM });
      instanceRef.current = instance;
      install = (): void => {
        if (cancelled) return;
        const presenter = overlayModule.installWorldEnvironmentOverlays(instance.map, () => undefined);
        const latestRestriction = latestRestrictionRef.current;
        presenter.sync(latestRestriction.groupId, latestRestriction.categoryIds);
        presenterRef.current = presenter;
      };
      if (instance.map.loaded()) install();
      else void instance.map.once("load", install);
    });
    return () => {
      cancelled = true;
      const instance = instanceRef.current;
      if (instance && install) instance.map.off("load", install);
      presenterRef.current?.destroy();
      presenterRef.current = null;
      instance?.map.remove();
      instanceRef.current = null;
    };
  }, []);
  return <figure className="creature-book-habitat">
    <div ref={containerRef} className="creature-book-habitat-map" aria-label={ariaLabel} />
    <figcaption>{habitatGroupLabel(restriction.groupId)} · {restriction.label}</figcaption>
  </figure>;
}

function habitatGroupLabel(groupId: WorldEnvironmentOverlayGroupId): string {
  if (groupId === "ocean_depth") return "Sea";
  return titleCase(groupId);
}

function activeLabel(active: "any_time" | "day" | "night"): string {
  return active === "any_time" ? "Any Time" : titleCase(active);
}

function formatRate(rate: number): string {
  return `${Math.round(Math.max(0, Math.min(1, rate)) * 100)}%`;
}

function titleCase(value: string): string {
  return value.replace(/(^|_)([a-z])/g, (_match, prefix: string, letter: string) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
}
