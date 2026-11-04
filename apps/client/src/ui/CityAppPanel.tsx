import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";

import {
  formatWeightKg,
  CITY_DISTRICT_TYPES,
  CITY_MARKET_MAX_LEVEL,
  cityMarketUpgradeCost,
  CITY_STRUCTURE_INTERACTION_RADIUS_M,
  OIL_WELL_CAPACITY,
  OIL_WELL_COST,
  OIL_WELL_INTERACTION_RADIUS_M,
  OIL_WELL_PRODUCTION_PER_HOUR,
  QUARTZ_HUT_CAPACITY,
  QUARTZ_HUT_COST,
  QUARTZ_HUT_PRODUCTION_PER_HOUR,
  distanceMeters,
  type CityMaterialCost,
  type CityAppSnapshot,
  type LatLon,
  type CityStructureSnapshot
} from "@ash-atlas/shared";

import { DestinationShell } from "./DestinationShell.js";
import { OrganizationWarsSection } from "./OrganizationWarsSection.js";
import { MaterialChips } from "./MaterialRequirements.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";
import { RealmAppTabs, type RealmAppSection } from "./RealmAppTabs.js";
import { bugReportDiagnostics } from "../diagnostics/bugReportDiagnostics.js";

type Props = {
  open: boolean;
  snapshot: CityAppSnapshot | null;
  playerPosition: LatLon | null;
  busy: boolean;
  layout: "desktop" | "phone";
  synchronizedNow?: () => number;
  onRefresh(): void;
  onDestroyHouse(structure: CityStructureSnapshot): void;
  onClaimMayor(cityId: string): void;
  onRelinquishMayor(cityId: string): void;
  onDestroyFacility(structure: CityStructureSnapshot): void;
  oilWellBuildDisabledReason?: string | null;
  onBuildOilWell?(): void;
  onOpenConstruction?(): void;
  onDestroyOilWell?(structure: CityStructureSnapshot): void;
  quartzHutBuildDisabledReason?: string | null;
  onBuildQuartzHut?(): void;
  onDestroyQuartzHut?(structure: CityStructureSnapshot): void;
  /** Glimmer balance (decimal string) for the City Market daily package; null while unknown. */
  glimmerBalance?: string | null;
  onBuyMarketDaily?(cityId: string): void;
  onOpenWarehouse(structure: CityStructureSnapshot): void;
  onOpenMarket(structure: CityStructureSnapshot): void;
  onJumpMarket?(structure: CityStructureSnapshot): void;
  /** Mayor: raise the City Market one level (one more City Tower slot). */
  onUpgradeMarket?(structure: CityStructureSnapshot): void;
  onDestroyMonument?(structure: CityStructureSnapshot): void;
  onOpenRealmSection?(section: RealmAppSection): void;
  /** Personal inventory totals, used to show which build materials are missing. */
  materialCounts?: Readonly<Record<string, number>> | undefined;
  /** Enables the city Wars section (active wars, Mayor declaration). */
  serverHttpBase?: string;
  csrfToken?: string;
  onClose(): void;
};

type CityManagementConfirmation =
  | Readonly<{ kind: "relinquish-mayor"; cityId: string }>
  | Readonly<{ kind: "destroy-monument"; structure: CityStructureSnapshot }>;

export function CityAppPanel({
  open,
  snapshot,
  playerPosition,
  busy,
  layout,
  synchronizedNow,
  onRefresh,
  onDestroyHouse,
  onClaimMayor,
  onRelinquishMayor,
  onDestroyFacility,
  oilWellBuildDisabledReason = null,
  onBuildOilWell,
  onOpenConstruction,
  onDestroyOilWell,
  quartzHutBuildDisabledReason = null,
  onBuildQuartzHut,
  onDestroyQuartzHut,
  glimmerBalance = null,
  onBuyMarketDaily,
  onOpenWarehouse,
  onOpenMarket,
  onJumpMarket,
  onUpgradeMarket,
  onDestroyMonument,
  onOpenRealmSection,
  materialCounts,
  serverHttpBase,
  csrfToken,
  onClose
}: Props): React.JSX.Element | null {
  const structures = Array.isArray(snapshot?.structures) ? snapshot.structures : [];
  const leaderboard = Array.isArray(snapshot?.leaderboard) ? snapshot.leaderboard : [];
  const warehouseCosts = snapshot?.facilityCosts?.warehouse ?? null;
  const salonCosts = snapshot?.facilityCosts?.salon ?? null;
  const kennelCosts = snapshot?.facilityCosts?.city_kennel ?? null;
  const [now, setNow] = useState(() => synchronizedNow?.() ?? Date.now());
  const [confirmation, setConfirmation] = useState<CityManagementConfirmation | null>(null);
  const refreshedDeadline = useRef<string | null>(null);
  const constructing = Boolean(snapshot?.activeConstruction) || [
    snapshot?.house,
    snapshot?.oilWell,
    snapshot?.quartzHut,
    ...structures
  ].some((structure) => structure?.state === "constructing");
  useEffect(() => {
    if (!open || (!snapshot?.founderClaimDeadline && !constructing)) return;
    const timer = window.setInterval(() => setNow(synchronizedNow?.() ?? Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [constructing, open, snapshot?.founderClaimDeadline, synchronizedNow]);
  useEffect(() => {
    if (!open) setConfirmation(null);
  }, [open]);
  const founderClaimRemaining = useMemo(() => {
    if (!snapshot?.founderClaimDeadline) return null;
    return formatClaimRemaining(new Date(snapshot.founderClaimDeadline).getTime() - now);
  }, [now, snapshot?.founderClaimDeadline]);
  useEffect(() => {
    const deadline = snapshot?.founderClaimDeadline ?? null;
    if (!open || !deadline) {
      refreshedDeadline.current = null;
      return;
    }
    if (Date.parse(deadline) <= now && refreshedDeadline.current !== deadline) {
      refreshedDeadline.current = deadline;
      onRefresh();
    }
  }, [now, onRefresh, open, snapshot?.founderClaimDeadline]);

  const city = snapshot?.city ?? null;
  const membership = snapshot?.membership ?? null;
  const confirmedMayor = Boolean(
    city?.mayorConfirmed && membership?.role === "mayor"
  );
  const facilities = structures.filter((entry) =>
    entry.type === "warehouse" || entry.type === "salon" || entry.type === "city_kennel"
  ) ?? [];
  const market = structures.find((entry) => entry.type === "market") ?? null;
  const marketUpgradeCost = market ? cityMarketUpgradeCost(market.tier + 1) : null;
  const oilWell = snapshot?.oilWell ?? null;
  const personalProducers = [
    {
      key: "oil-well",
      name: "Oil Well",
      resource: "Crude Oil",
      productionPerHour: OIL_WELL_PRODUCTION_PER_HOUR,
      capacity: OIL_WELL_CAPACITY,
      cost: OIL_WELL_COST,
      structure: oilWell,
      buildDisabledReason: oilWellBuildDisabledReason,
      onBuild: onBuildOilWell,
      onDestroy: onDestroyOilWell
    },
    {
      key: "quartz-hut",
      name: "Quartz Hut",
      resource: "Crystal",
      productionPerHour: QUARTZ_HUT_PRODUCTION_PER_HOUR,
      capacity: QUARTZ_HUT_CAPACITY,
      cost: QUARTZ_HUT_COST,
      structure: snapshot?.quartzHut ?? null,
      buildDisabledReason: quartzHutBuildDisabledReason,
      onBuild: onBuildQuartzHut,
      onDestroy: onDestroyQuartzHut
    }
  ];
  const monuments = CITY_DISTRICT_TYPES.map((districtType) => ({
    districtType,
    record: snapshot?.district.monuments[districtType] ?? null,
    structure: structures.find((entry) =>
      entry.type === "monument" && entry.districtType === districtType
    ) ?? null
  }));
  const activeMonumentCount = monuments.filter(
    ({ record }) => record?.status === "active"
  ).length;
  const location = city
    ? [snapshot?.municipality, snapshot?.region, snapshot?.country].filter(Boolean).join(", ")
    : "";
  const ownLeaderboardId = snapshot?.ownLeaderboardEntry?.playerId ?? null;
  const ownEntryIsListed = Boolean(
    ownLeaderboardId
    && leaderboard.some((entry) => entry.playerId === ownLeaderboardId)
  );
  const showManagement = Boolean(
    snapshot?.house
    || (snapshot?.mayorVacant && membership?.role !== "mayor")
    || confirmedMayor
  );

  return <>
    <DestinationShell
      open={open}
      title={city?.name ?? "City"}
      subtitle={city
        ? location
        : "Membership is anchored to a City House"}
      closeLabel="Close City App"
      className="city-app-panel"
      layout={layout}
      phoneBackLabel="Back to Game Menu"
      initialFocus="container"
      onClose={onClose}
    >
      {onOpenRealmSection ? <RealmAppTabs activeSection="city" onChange={onOpenRealmSection} /> : null}
      {!snapshot ? (
        <div className="city-app-loading" role="status" aria-live="polite">
          <strong>Consulting the city ledger</strong>
          <span>Loading city records…</span>
        </div>
      ) : city && snapshot.house?.state === "constructing" && !membership ? (
        <section className="destination-empty-state">
          <h3>{city.name}</h3>
          <p>Founder: {city.founderUsername ?? "Unknown founder"} · Mayor: {city.mayorUsername ?? "Vacant"}</p>
          <p><strong>City House constructing</strong> · {structureStatus(snapshot.house, now)}</p>
          <p>City membership begins when this City House finishes construction.</p>
          <p>Construction lives in Build &gt; City &gt; City House.</p>
          {founderClaimRemaining ? (
            <p>{snapshot.playerIsFounder
              ? `You founded this city. Claim Mayor after your City House becomes active within ${founderClaimRemaining}.`
              : `The founder has ${founderClaimRemaining} to claim Mayor.`}</p>
          ) : null}
          <button type="button" onClick={onRefresh}>Refresh</button>
        </section>
      ) : city && !membership ? (
        <section className="destination-empty-state">
          <h3>{city.name}</h3>
          <p>Founder: {city.founderUsername ?? "Unknown founder"} · Mayor: {city.mayorUsername ?? "Vacant"}</p>
          {snapshot.playerIsFounder && founderClaimRemaining ? (
            <p>You founded this city. Use Build &gt; City &gt; City House, then claim Mayor within {founderClaimRemaining}.</p>
          ) : founderClaimRemaining ? (
            <p>The founder has {founderClaimRemaining} to claim Mayor.</p>
          ) : (
            <p>Build a City House on this city’s land to become a member.</p>
          )}
          <button type="button" onClick={onRefresh}>Refresh</button>
        </section>
      ) : !city || !membership ? (
        <section className="destination-empty-state">
          <h3>No active city membership</h3>
          <p>City membership begins when a City House finishes construction.</p>
          <p>Go to Build &gt; City &gt; City House.</p>
          <p>Build a City House on a city’s land to become a member.</p>
          <button type="button" onClick={onRefresh}>Refresh</button>
        </section>
      ) : (
        <div className="city-app-content" aria-busy={busy}>
          <div className="city-app-top-grid">
            <section className="city-app-section city-app-overview" aria-labelledby="city-overview-title">
              <SectionHeading
                id="city-overview-title"
                title="Overview"
                status={membership.role === "mayor" ? "Mayor" : "Member"}
              />
              <dl className="city-app-overview-grid">
                <LabeledValue label="City" value={city.name} />
                <LabeledValue label="Location" value={location || city.name} />
                <LabeledValue
                  label="Mayor"
                  value={city.mayorUsername ?? "Vacant"}
                  {...(snapshot.mayorVacant ? { status: "warning" as const } : {})}
                />
                <LabeledValue label="Members" value={safeCount(snapshot.memberCount)} />
                <LabeledValue label="Your role" value={formatLabel(membership.role)} />
                <LabeledValue label="City House" value={snapshot.house ? structureLabel(snapshot.house) : "Missing"} status={snapshot.house ? "active" : "warning"} />
                <LabeledValue label="Member since" value={safeDate(membership.joinedAt)} />
                <LabeledValue label="Founder" value={city.founderUsername ?? "Unknown founder"} />
                {founderClaimRemaining ? (
                  <LabeledValue
                    label="Founder Mayor claim"
                    value={founderClaimRemaining}
                    status="warning"
                    wide
                  />
                ) : null}
              </dl>
              <p className="city-app-coordinates">
                Map coordinates {safeCoordinate(city.lat)}, {safeCoordinate(city.lon)}
              </p>
            </section>

            <section className="city-app-section city-app-treasury" aria-labelledby="city-treasury-title">
              <SectionHeading
                id="city-treasury-title"
                title="City Coins"
              />
              <div className="city-app-balance">
                <span>Spendable balance</span>
                <strong>{formatCoin(snapshot.treasuryBalance)}</strong>
                <small>City Coins available</small>
              </div>
              <dl className="city-app-stat-grid">
                <LabeledValue label="Lifetime earned" value={formatCoin(snapshot.lifetimeCoinsEarned)} />
                <LabeledValue label="Lifetime spent" value={formatCoin(snapshot.lifetimeCoinsSpent)} />
                <LabeledValue label="Your contribution" value={formatCoin(snapshot.playerContribution)} />
                <LabeledValue label="Your rank" value={snapshot.playerContributionRank ? `#${snapshot.playerContributionRank}` : "Unranked"} />
              </dl>
              {snapshot.marketDaily ? (() => {
                const daily = snapshot.marketDaily;
                const poor = glimmerBalance !== null && BigInt(glimmerBalance) < BigInt(daily.glimmer);
                return (
                  <div className="city-app-balance city-app-daily" aria-label="City Market daily offer">
                    <span>Daily offer</span>
                    <strong>{formatCoin(String(daily.cityCoins))} City Coins</strong>
                    <small>
                      {daily.purchasedToday
                        ? "Bought today. Resets at 00:00 UTC."
                        : `City Market level ${daily.marketLevel}: ${daily.glimmer} Glimmer, once per day, paid into the city treasury.`}
                    </small>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || daily.purchasedToday || poor || !onBuyMarketDaily}
                      title={poor ? `You need ${daily.glimmer} Glimmer.` : undefined}
                      onClick={() => onBuyMarketDaily?.(membership.cityId)}
                    >
                      {daily.purchasedToday ? "Bought today" : `Buy for ${daily.glimmer} Glimmer`}
                    </button>
                  </div>
                );
              })() : null}
            </section>
          </div>

          <div className="city-app-top-grid">
            <section className="city-app-section" aria-labelledby="city-district-title">
              <SectionHeading
                id="city-district-title"
                title="Monuments"
                status={`${activeMonumentCount} of ${CITY_DISTRICT_TYPES.length} active`}
              />
              <dl className="city-app-stat-grid">
                {monuments.map(({ districtType, record, structure }) => (
                  <LabeledValue
                    key={districtType}
                    label={`${formatLabel(districtType)} Monument`}
                    value={record?.status === "active"
                      ? `Active · Tier ${record.tier}`
                      : record?.status === "constructing" && structure
                        ? structureStatus(structure, now)
                        : "Inactive"}
                    status={record?.status === "active" ? "active" : "warning"}
                  />
                ))}
                <LabeledValue
                  label="Combined member benefits"
                  value={formatDistrictBenefits(snapshot)}
                  wide
                />
                <LabeledValue
                  label="Active market specialties"
                  value={formatSpecialtyDescriptions(snapshot)}
                  wide
                />
              </dl>
              {confirmedMayor && monuments.some(({ structure }) => structure?.state === "active") ? (
                <div className="city-app-management-actions">
                  {monuments.map(({ districtType, structure }) => structure?.state === "active" ? (
                    <div key={districtType}>
                      <span>
                        <strong>{formatLabel(districtType)} Monument</strong>
                        <small>Construction and upgrades are managed in Build &gt; City.</small>
                      </span>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy || !canManageMonument(structure, playerPosition)}
                        title={canManageMonument(structure, playerPosition)
                          ? undefined
                          : `Move within ${CITY_STRUCTURE_INTERACTION_RADIUS_M} meters to destroy the ${formatLabel(districtType)} Monument.`}
                        onClick={() => setConfirmation({ kind: "destroy-monument", structure })}
                      >
                        Destroy {formatLabel(districtType)} Monument
                      </button>
                    </div>
                  ) : null)}
                </div>
              ) : null}
            </section>

            <section className="city-app-section" aria-labelledby="city-gold-title">
              <SectionHeading
                id="city-gold-title"
                title="City Gold Reserve"
                status={`${formatCoin(snapshot.gold.balance)} / ${formatCoin(snapshot.gold.capacity)}`}
              />
              <dl className="city-app-stat-grid">
                <LabeledValue label="Current Gold" value={formatCoin(snapshot.gold.balance)} />
                <LabeledValue label="Capacity" value={formatCoin(snapshot.gold.capacity)} />
                <LabeledValue label="Remaining capacity" value={formatCoin(snapshot.gold.remainingCapacity)} />
                <LabeledValue label="Lifetime donated" value={formatCoin(snapshot.gold.lifetimeDonated)} />
                <LabeledValue label="Lifetime spent" value={formatCoin(snapshot.gold.lifetimeSpent)} />
              </dl>
              <p className="city-app-coordinates">
                Reserve Gold cannot be withdrawn or transferred. Market taxes are burned and never enter this balance.
              </p>
              <p className="city-app-empty">
                City Gold is read-only here. Donate Gold inside the active City Warehouse.
              </p>
              {snapshot.gold.recentDonations.length ? (
                <ol className="city-app-leaderboard">
                  {snapshot.gold.recentDonations.map((entry, index) => (
                    <li key={`${entry.playerId}:${entry.donatedAt}:${index}`}>
                      <span><strong>{entry.username}</strong><small>{safeDateTime(entry.donatedAt)}</small></span>
                      <b>{formatCoin(entry.amount)} <small>Gold</small></b>
                    </li>
                  ))}
                </ol>
              ) : null}
            </section>
          </div>

          {personalProducers.map((producer) => (
            <section
              key={producer.key}
              className="city-app-section"
              aria-labelledby={`city-${producer.key}-title`}
            >
              <SectionHeading
                id={`city-${producer.key}-title`}
                title={`Personal ${producer.name}`}
                status={producer.structure ? structureStatus(producer.structure, now) : "Unbuilt"}
              />
              <dl className="city-app-stat-grid">
                <LabeledValue label="Production" value={`${producer.productionPerHour} ${producer.resource} per hour`} />
                <LabeledValue label="Storage" value={`${producer.capacity} ${producer.resource}`} />
                <LabeledValue label="Build time" value="30 seconds · moving away cancels" />
                <LabeledValue label="Limit" value="One globally per player" />
              </dl>
              <div className="city-app-next-cost">
                <span>Personal materials</span>
                <CityCostChips label={`${producer.name} cost`} cost={producer.cost} materialCounts={materialCounts} />
              </div>
              <div className="city-app-controls">
                {producer.structure?.state === "active" ? (
                  <button
                    type="button"
                    className="danger"
                    disabled={busy || !playerPosition ||
                      distanceMeters(playerPosition, producer.structure) > OIL_WELL_INTERACTION_RADIUS_M}
                    title={!playerPosition || distanceMeters(playerPosition, producer.structure) > OIL_WELL_INTERACTION_RADIUS_M
                      ? `Move within ${OIL_WELL_INTERACTION_RADIUS_M} meters to delete the ${producer.name}.`
                      : undefined}
                    onClick={() => producer.structure && producer.onDestroy?.(producer.structure)}
                  >
                    {`Delete ${producer.name}`}
                  </button>
                ) : !producer.structure ? (
                  <button
                    type="button"
                    className="primary"
                    disabled={layout === "phone"
                      ? !onOpenConstruction
                      : busy || producer.buildDisabledReason !== null}
                    title={layout === "phone"
                      ? `Open Construction to build the ${producer.name}.`
                      : producer.buildDisabledReason ?? undefined}
                    onClick={() => layout === "phone"
                      ? onOpenConstruction?.()
                      : producer.onBuild?.()}
                  >
                    {layout === "phone" ? "Open Construction" : `Build ${producer.name}`}
                  </button>
                ) : null}
              </div>
              {producer.buildDisabledReason && !producer.structure ? (
                <p className="city-app-empty">{producer.buildDisabledReason}</p>
              ) : null}
            </section>
          ))}

          <section className="city-app-section" aria-labelledby="city-market-title">
            <SectionHeading
              id="city-market-title"
              title="City Market"
              status={market ? structureStatus(market, now) : "Unbuilt"}
            />
            <dl className="city-app-stat-grid">
              <LabeledValue label="Building" value={market ? structureLabel(market) : "Not built"} />
              <LabeledValue
                label="Local tax"
                value={activeMonumentCount > 0
                  ? `${snapshot.district.specialtyBuyerTaxBps / 100}% specialty · ${snapshot.district.standardBuyerTaxBps / 100}% other goods`
                  : `${snapshot.district.standardBuyerTaxBps / 100}% on all goods`}
              />
              <LabeledValue
                label="Access"
                value="Public while physically near the Market"
                wide
              />
              <LabeledValue
                label="Locality"
                value="Orders, listings, and collections exist only in this City Market"
                wide
              />
            </dl>
            <dl className="city-app-stat-grid">
              <LabeledValue
                label="Market level"
                value={market ? `Level ${market.tier} of ${CITY_MARKET_MAX_LEVEL}` : "Not built"}
              />
              <LabeledValue
                label="City Tower slots"
                value={snapshot.cityTowerSlots
                  ? `${snapshot.cityTowerSlots.used} of ${snapshot.cityTowerSlots.capacity} used`
                  : "Unavailable"}
              />
            </dl>
            {market ? (
              marketUpgradeCost ? (
                <div className="city-app-next-cost">
                  <span>Level {market.tier + 1} cost</span>
                  <CityCostChips label="City Market upgrade cost" cost={marketUpgradeCost} materialCounts={materialCounts} />
                </div>
              ) : <p className="city-app-empty">The City Market is at its highest level.</p>
            ) : (
              <div className="city-app-next-cost">
                <span>Build cost</span>
                <CityCostChips label="City Market cost" cost={snapshot.civicCosts.market} materialCounts={materialCounts} />
              </div>
            )}
            {snapshot.cityTowerSlots && snapshot.cityTowerSlots.used > snapshot.cityTowerSlots.capacity ? (
              <p className="city-app-empty">Towers over the slot count stay standing; new City Towers wait for a free slot.</p>
            ) : null}
            {market?.state === "active" ? (
              <div className="city-app-controls">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => onOpenMarket(market)}
                >
                  Open City Market
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onJumpMarket?.(market)}
                >
                  Travel
                </button>
                {confirmedMayor && marketUpgradeCost && onUpgradeMarket ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onUpgradeMarket(market)}
                  >
                    Upgrade Market
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="city-app-section city-app-facilities" aria-labelledby="city-facilities-title">
            <SectionHeading
              id="city-facilities-title"
              title="Structures"
              status={`${facilities.filter((entry) => entry.state === "active").length}/3 active`}
            />
            <div className="city-app-facility-list">
              {(["warehouse"] as const).map((type) => {
                const structure = facilities.find((entry) => entry.type === type);
                const activeStructure = structure?.state === "active"
                  ? structure
                  : null;
                const facilityDistanceM = structure && playerPosition
                  ? distanceMeters(playerPosition, structure)
                  : null;
                const canDestroyFacility = facilityDistanceM !== null
                  && facilityDistanceM <= CITY_STRUCTURE_INTERACTION_RADIUS_M;
                const nextTier = activeStructure
                  ? activeStructure.tier < 3 ? (activeStructure.tier + 1) as 2 | 3 : null
                  : structure ? null : 1;
                return (
                  <article key={type} className={`city-app-facility${structure ? " built" : ""}`}>
                    <header>
                      <div>
                        <span>{structure
                          ? structure.state === "constructing" ? "Constructing" : "Built"
                          : "Not built"}</span>
                        <h4>{facilityLabel()}</h4>
                      </div>
                      <strong>{structure ? `Tier ${structure.tier}` : "Unbuilt"}</strong>
                    </header>
                    <dl className="city-app-facility-facts">
                      <LabeledValue
                        label="Status"
                        value={structure
                          ? structureStatus(structure, now)
                          : "Available to build"}
                        {...(structure?.state === "active"
                          ? { status: "active" as const }
                          : {})}
                      />
                      <LabeledValue label="Current tier" value={structure ? `${structure.tier} of 3` : "—"} />
                      {type === "warehouse" ? (
                        <LabeledValue
                          label="Capacity"
                          value={structure?.state === "active"
                            ? formatWarehouseWeight(snapshot.warehouseCurrentWeightGrams, snapshot.warehouseMaximumWeightGrams)
                            : "Available after construction"}
                          wide
                        />
                      ) : null}
                    </dl>
                    {structure ? (
                      <p className="city-app-coordinates">
                        Location {safeCoordinate(structure.lat)}, {safeCoordinate(structure.lon)}
                      </p>
                    ) : null}
                    <div className="city-app-next-cost">
                      <span>{nextTier ? `${structure ? "Upgrade" : "Build"} cost · Tier ${nextTier}` : "Maximum tier reached"}</span>
                      {nextTier ? (warehouseCosts?.[nextTier]
                        ? <CityCostChips label="Warehouse cost" cost={warehouseCosts[nextTier]} materialCounts={materialCounts} />
                        : <strong>Warehouse costs are temporarily unavailable. Refresh City data.</strong>) : null}
                    </div>
                    {type === "warehouse" && structure?.state === "active" ? (
                      <div className="city-app-controls">
                        <button
                          type="button"
                          className="primary"
                          disabled={busy}
                          onClick={() => onOpenWarehouse(structure)}
                        >
                          Open Warehouse
                        </button>
                      </div>
                    ) : null}
                    {confirmedMayor && structure?.state !== "constructing" ? (
                      <div className="city-app-controls">
                        {structure ? (
                            <button
                              type="button"
                              className="danger"
                              disabled={busy || !canDestroyFacility}
                              title={canDestroyFacility
                                ? undefined
                                : `Move within ${CITY_STRUCTURE_INTERACTION_RADIUS_M} meters to destroy this facility.`}
                              onClick={() => onDestroyFacility(structure)}
                            >
                              Destroy
                            </button>
                        ) : null}
                      </div>
                    ) : null}
                    <FacilityCosts
                      costs={warehouseCosts}
                      currentTier={(structure?.tier ?? null) as 1 | 2 | 3 | null}
                      materialCounts={materialCounts}
                      onRefresh={onRefresh}
                    />
                  </article>
                );
              })}
              {(() => {
                const structure = facilities.find((entry) => entry.type === "salon");
                const distanceM = structure && playerPosition
                  ? distanceMeters(playerPosition, structure)
                  : null;
                const canDestroy = distanceM !== null &&
                  distanceM <= CITY_STRUCTURE_INTERACTION_RADIUS_M;
                return <article className={`city-app-facility${structure ? " built" : ""}`}>
                  <header><div><span>{structure
                    ? structure.state === "constructing" ? "Constructing" : "Built"
                    : "Not built"}</span><h4>City Salon</h4></div><strong>Tier 1</strong></header>
                  <dl className="city-app-facility-facts">
                    <LabeledValue label="Status" value={structure
                      ? structureStatus(structure, now)
                      : "Available to build"} />
                    <LabeledValue label="Service" value="Free hair, eyes, and facial styling" wide />
                  </dl>
                  <div className="city-app-next-cost"><span>Build cost · Tier 1</span>
                    {salonCosts?.[1]
                      ? <CityCostChips label="City Salon cost" cost={salonCosts[1]} materialCounts={materialCounts} />
                      : <strong>Salon costs are temporarily unavailable. Refresh City data.</strong>}
                  </div>
                  {confirmedMayor && structure?.state !== "constructing" && structure ? (
                    <div className="city-app-controls"><button type="button" className="danger"
                      disabled={busy || !canDestroy}
                      title={canDestroy ? undefined : `Move within ${CITY_STRUCTURE_INTERACTION_RADIUS_M} meters to destroy this facility.`}
                      onClick={() => onDestroyFacility(structure)}>Destroy</button></div>
                  ) : null}
                </article>;
              })()}
              {(() => {
                const structure = facilities.find((entry) => entry.type === "city_kennel");
                const distanceM = structure && playerPosition
                  ? distanceMeters(playerPosition, structure)
                  : null;
                const canDestroy = distanceM !== null &&
                  distanceM <= CITY_STRUCTURE_INTERACTION_RADIUS_M;
                return <article className={`city-app-facility${structure ? " built" : ""}`}>
                  <header><div><span>{structure
                    ? structure.state === "constructing" ? "Constructing" : "Built"
                    : "Not built"}</span><h4>City Kennel</h4></div><strong>Tier 1</strong></header>
                  <dl className="city-app-facility-facts">
                    <LabeledValue label="Status" value={structure
                      ? structureStatus(structure, now)
                      : "Available to build"} />
                    <LabeledValue label="Service" value="Foundation puppy purchase" wide />
                  </dl>
                  <div className="city-app-next-cost"><span>Build cost · Tier 1</span>
                    {kennelCosts?.[1]
                      ? <CityCostChips label="City Kennel cost" cost={kennelCosts[1]} materialCounts={materialCounts} />
                      : <strong>Kennel costs are temporarily unavailable. Refresh City data.</strong>}
                  </div>
                  {confirmedMayor && structure?.state !== "constructing" && structure ? (
                    <div className="city-app-controls"><button type="button" className="danger"
                      disabled={busy || !canDestroy}
                      title={canDestroy ? undefined : `Move within ${CITY_STRUCTURE_INTERACTION_RADIUS_M} meters to destroy this facility.`}
                      onClick={() => onDestroyFacility(structure)}>Destroy</button></div>
                  ) : null}
                </article>;
              })()}
            </div>
          </section>

          <div className={`city-app-bottom-grid${showManagement ? "" : " single"}`}>
            <section className="city-app-section city-app-contributors" aria-labelledby="city-contributors-title">
              <SectionHeading
                id="city-contributors-title"
                title="Members"
                subtitle={`${safeCount(snapshot.memberCount)} current · all-time City Coin contributors`}
                status={leaderboard.length ? `${leaderboard.length} ranked` : "No entries"}
              />
              {leaderboard.length ? (
                <ol className="city-app-leaderboard">
                  {leaderboard.map((entry) => {
                    const own = entry.playerId === ownLeaderboardId;
                    return (
                      <li key={entry.playerId} className={own ? "is-local-player" : undefined}>
                        <strong className="city-app-rank">#{entry.rank}</strong>
                        <span>
                          <strong>{entry.username}</strong>
                          <small>{entry.currentMember ? "Current member" : "Former member"}</small>
                        </span>
                        <b>{formatCoin(entry.contributed)} <small>City Coins</small></b>
                        {own ? <em>You</em> : null}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="city-app-empty">No City Coin contributions have been recorded yet.</p>
              )}
              {snapshot.ownLeaderboardEntry && !ownEntryIsListed ? (
                <div className="city-app-personal-rank">
                  <span>Your standing</span>
                  <strong>#{snapshot.ownLeaderboardEntry.rank}</strong>
                  <small>{formatCoin(snapshot.ownLeaderboardEntry.contributed)} City Coins contributed</small>
                </div>
              ) : null}
            </section>

            {showManagement ? <section className="city-app-section city-app-management" aria-labelledby="city-management-title">
              <SectionHeading
                id="city-management-title"
                title="City Management"
              />
              <div className="city-app-management-actions">
                {snapshot.mayorVacant && membership.role !== "mayor" ? (
                  <div>
                    <span>
                      <strong>Become Mayor</strong>
                      <small>{snapshot.mayorClaimAllowed
                        ? "Claim the vacant office for this city."
                        : founderClaimRemaining && !snapshot.playerIsFounder
                          ? `The founder has ${founderClaimRemaining} to claim Mayor.`
                          : snapshot.mayorClaimReason ?? "Mayor claim is not currently available."}</small>
                    </span>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || !snapshot.mayorClaimAllowed}
                      title={snapshot.mayorClaimAllowed
                        ? undefined
                        : snapshot.mayorClaimReason ?? undefined}
                      onClick={() => onClaimMayor(city.id)}
                    >
                      Become Mayor
                    </button>
                  </div>
                ) : null}
                {confirmedMayor ? (
                  <div>
                    <span><strong>Relinquish Mayor</strong><small>Leave the office vacant for another member.</small></span>
                    <button type="button" className="danger" disabled={busy} onClick={() => setConfirmation({ kind: "relinquish-mayor", cityId: city.id })}>
                      Relinquish Mayor
                    </button>
                  </div>
                ) : null}
                {snapshot.house ? (
                  <div className="destructive">
                    <span><strong>Destroy City House</strong><small>This removes your active city membership anchor.</small></span>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => onDestroyHouse(snapshot.house!)}
                    >
                      Destroy City House
                    </button>
                  </div>
                ) : null}
              </div>
            </section> : null}
          </div>
          {serverHttpBase && csrfToken ? (
            <OrganizationWarsSection
              side="city"
              serverHttpBase={serverHttpBase}
              csrfToken={csrfToken}
              className="city-app-section"
            />
          ) : null}
        </div>
      )}
    </DestinationShell>
    {confirmation?.kind === "relinquish-mayor" ? <GameConfirmationPrompt
      title="Relinquish Mayor?"
      detail="Your Mayor House will become a normal City House and no city resources will be returned."
      confirmLabel="Relinquish Mayor"
      destructive
      onCancel={() => setConfirmation(null)}
      onConfirm={() => {
        const { cityId } = confirmation;
        setConfirmation(null);
        onRelinquishMayor(cityId);
      }}
    /> : null}
    {confirmation?.kind === "destroy-monument" ? <GameConfirmationPrompt
      title={`Destroy the ${formatLabel(confirmation.structure.districtType ?? "City")} Monument?`}
      detail={"No materials, City Coins, or Gold will be refunded. " +
        `The ${formatLabel(confirmation.structure.districtType ?? "City")} benefit and specialty tax stop immediately.`}
      confirmLabel={`Destroy ${formatLabel(confirmation.structure.districtType ?? "City")} Monument`}
      destructive
      onCancel={() => setConfirmation(null)}
      onConfirm={() => {
        const { structure } = confirmation;
        setConfirmation(null);
        onDestroyMonument?.(structure);
      }}
    /> : null}
  </>;
}

function SectionHeading({
  id,
  title,
  subtitle,
  status
}: {
  id: string;
  title: string;
  subtitle?: string;
  status?: string;
}): React.JSX.Element {
  return (
    <header className="destination-section-heading">
      <div><h3 id={id}>{title}</h3>{subtitle ? <small>{subtitle}</small> : null}</div>
      {status ? <span>{status}</span> : null}
    </header>
  );
}

function LabeledValue({
  label,
  value,
  status,
  wide = false
}: {
  label: string;
  value: string;
  status?: "active" | "warning";
  wide?: boolean;
}): React.JSX.Element {
  return (
    <div className={`${wide ? "wide " : ""}${status ? `status-${status}` : ""}`.trim()}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function FacilityCosts({
  costs,
  currentTier,
  materialCounts,
  onRefresh
}: {
  materialCounts?: Readonly<Record<string, number>> | undefined;
  costs: Readonly<Record<1 | 2 | 3, CityMaterialCost>> | null;
  currentTier: 1 | 2 | 3 | null;
  onRefresh(): void;
}): React.JSX.Element {
  if (!costs || !costs[1] || !costs[2] || !costs[3]) {
    return (
      <div className="city-app-empty" role="status">
        <p>Warehouse costs are temporarily unavailable. Refresh City data.</p>
        <button type="button" onClick={onRefresh}>Refresh</button>
      </div>
    );
  }
  return (
    <details className="city-app-cost-details">
      <summary>View full tier cost schedule</summary>
      <ul>
        {([1, 2, 3] as const).map((tier) => {
          const cost = costs[tier];
          return (
            <li key={tier} className={tier === currentTier ? "current" : undefined}>
              <strong>Tier {tier}</strong>
              <CityCostChips label={`Tier ${tier} cost`} cost={cost} materialCounts={materialCounts} />
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export class CityAppErrorBoundary extends Component<{
  children: ReactNode;
  resetKey: string;
  onRefresh(): void;
  onClose(): void;
  membershipExists: boolean;
  warehouseExists: boolean;
  facilityCostsPresent: boolean;
}, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    bugReportDiagnostics.recordError({
      category: "react_error_boundary",
      name: error.name,
      message: `${error.message} [release=${import.meta.env.VITE_RELEASE_SHA ?? "unknown"} membership=${this.props.membershipExists} warehouse=${this.props.warehouseExists} facilityCosts=${this.props.facilityCostsPresent}]`,
      stack: error.stack ?? info.componentStack ?? null,
      component: "city-app-panel"
    });
    console.error("City App render failure", error, info.componentStack);
  }

  override componentDidUpdate(previous: Readonly<{ resetKey: string }>): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="destination-empty-state" role="alert">
        <h3>City App unavailable</h3>
        <p>City data could not be displayed. Gameplay remains available.</p>
        <button type="button" onClick={() => {
          this.setState({ failed: false });
          this.props.onRefresh();
        }}>Refresh City Data</button>
        <button type="button" onClick={this.props.onClose}>Return to Game</button>
      </section>
    );
  }
}

function facilityLabel(): string {
  return "Warehouse";
}

function structureLabel(structure: CityStructureSnapshot): string {
  const name = structure.type === "mayor_house"
    ? "Mayor House"
    : structure.type === "city_house"
      ? "City House"
      : structure.type === "warehouse"
        ? "Warehouse"
        : structure.type === "market"
          ? "City Market"
          : structure.type === "monument"
            ? `${formatLabel(structure.districtType ?? "city")} Monument`
            : "Retired City Structure";
  return `${name} · ${
    structure.state === "constructing" ? "Constructing" : "Active"
  }`;
}

function structureStatus(structure: CityStructureSnapshot, now: number): string {
  if (structure.state !== "constructing") return "Active";
  const completesAt = structure.constructionCompletesAt
    ? Date.parse(structure.constructionCompletesAt)
    : now;
  return `Constructing · ${formatCountdown(Math.max(0, completesAt - now))}`;
}

/** Material chips for a city cost; City Coins and City Gold show their need only (balances live in the treasury). */
function CityCostChips({ label, cost, materialCounts }: {
  label: string;
  cost: CityMaterialCost;
  materialCounts?: Readonly<Record<string, number>> | undefined;
}): React.JSX.Element {
  return <MaterialChips label={label} materials={[
    ...cost.materials.map((item) => ({
      itemId: item.itemId,
      quantity: item.quantity,
      name: formatLabel(item.itemId),
      have: materialCounts ? materialCounts[item.itemId] ?? 0 : undefined
    })),
    ...(cost.cityCoins > 0 ? [{ itemId: "gold", quantity: cost.cityCoins, name: "City Coins", have: null }] : []),
    ...(cost.cityGold ? [{ itemId: "gold", quantity: cost.cityGold, name: "City Gold", have: null }] : [])
  ]} />;
}

function formatDistrictBenefits(snapshot: CityAppSnapshot): string {
  const benefit = snapshot.district.memberBenefit;
  const descriptions: string[] = [];
  if (benefit.miningExtraYieldChance > 0) {
    descriptions.push(`${Math.round(benefit.miningExtraYieldChance * 100)}% chance for +1 Stone or Ore`);
  }
  if (benefit.forestryExtraYieldChance > 0) {
    descriptions.push(`${Math.round(benefit.forestryExtraYieldChance * 100)}% chance for +1 Wood`);
  }
  if (benefit.directMobDamageBonus > 0) {
    descriptions.push(`+${benefit.directMobDamageBonus} direct mob damage`);
  }
  if (benefit.mobDefenseBonus > 0) {
    descriptions.push(`+${benefit.mobDefenseBonus} defense against mobs`);
  }
  if (benefit.resinPreservationChance > 0) {
    descriptions.push(`${Math.round(benefit.resinPreservationChance * 100)}% Giving Berry preservation chance`);
  }
  return descriptions.length > 0 ? descriptions.join(" · ") : "No active Monument benefits";
}

function formatSpecialtyDescriptions(snapshot: CityAppSnapshot): string {
  const descriptions = CITY_DISTRICT_TYPES.flatMap((districtType) => {
    if (snapshot.district.monuments[districtType].status !== "active") return [];
    return [snapshot.district.specialtyDescriptions[districtType] ?? `${formatLabel(districtType)} goods`];
  });
  return descriptions.length > 0 ? descriptions.join(" · ") : "No active specialty tax";
}

function canManageMonument(
  structure: CityStructureSnapshot,
  playerPosition: LatLon | null
): boolean {
  return playerPosition !== null &&
    distanceMeters(playerPosition, structure) <= CITY_STRUCTURE_INTERACTION_RADIUS_M;
}

function formatCoin(value: string): string {
  try {
    return BigInt(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatLabel(value: string): string {
  return value
    .split("_")
    .map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function safeCount(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value)).toLocaleString()
    : "Unavailable";
}

function formatWarehouseWeight(current: string | undefined, maximum: string | undefined): string {
  if (current === undefined || maximum === undefined) return "Loading…";
  try {
    return `${formatWeightKg(current)} / ${formatWeightKg(maximum)} kg`;
  } catch {
    return "Unavailable";
  }
}

function safeCoordinate(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(5) : "Unavailable";
}

function safeDate(value: unknown): string {
  if (typeof value !== "string") return "Unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unavailable" : parsed.toLocaleDateString();
}

function safeDateTime(value: unknown): string {
  if (typeof value !== "string") return "Unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unavailable" : parsed.toLocaleString();
}

function formatClaimRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatCountdown(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
