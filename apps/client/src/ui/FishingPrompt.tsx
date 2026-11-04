import {
  FISHING_BASE_CAST_RANGE_M,
  FISHING_CONTROL_UPDATE_INTERVAL_MS,
  FISHING_ROD_RECIPE_COST,
  FISHING_STAMINA_LANDING_THRESHOLD,
  fishingStaminaPercent,
  fishingFightCanLand,
  type FishingControlDirection,
  type FishingEncounterSnapshot,
  type FishingHutWorldSnapshot,
  type FishingRecordSnapshot,
  type FishingStateSnapshot,
  type MarketInteger
} from "@ash-atlas/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  FISHING_ENCOUNTER_ARTWORK,
  fishingEncounterBackgroundUrl,
  fishingWaterbodyLabel
} from "../map/fishingArtwork.js";
import { GameActionPrompt, GamePromptButton } from "./GameActionPrompt.js";
import { GameAppCard } from "./GameAppShell.js";
import { GameTargetPicker } from "./GameTargetPicker.js";
import { MaterialChips, type MaterialNeed } from "./MaterialRequirements.js";

export function fishingPercentileLabel(percentile: number | null | undefined): string {
  const value = Number(percentile);
  const percentage = Math.round((Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0) * 100);
  const remainder100 = percentage % 100;
  const suffix = remainder100 >= 11 && remainder100 <= 13
    ? "th"
    : percentage % 10 === 1
      ? "st"
      : percentage % 10 === 2
        ? "nd"
        : percentage % 10 === 3
          ? "rd"
          : "th";
  return `${percentage}${suffix} percentile`;
}

export function FishingActionPrompt(props: Readonly<{
  hut: FishingHutWorldSnapshot;
  state: FishingStateSnapshot | null;
  connected: boolean;
  feedback: string | null;
  busy: boolean;
  /** Deprecated V1 callbacks retained only for old isolated callers/tests. */
  onFish?(): void;
  onStart?(): void;
  onCollect(): void;
  onCraft?(): void;
  onUpgrade?(track: "cast_range" | "reel_power" | "line_control"): void;
  onSpecialize?(type: "river" | "lake" | "ocean"): void;
  onClose(): void;
  /** Inventory totals and Gold so craft and training costs can show what is missing. */
  materialCounts?: Readonly<Record<string, number>> | undefined;
  goldBalance?: MarketInteger | null | undefined;
}>): React.JSX.Element {
  const ready = props.state?.hut?.fishingHutId === props.hut.fishingHutId
    ? props.state.hut.passiveReadyQuantity + props.state.hut.passiveStoredQuantity
    : props.hut.passiveReadyQuantity + props.hut.passiveStoredQuantity;
  const disabledReason = props.connected ? null : "Cannot use a Fishing Hut while disconnected.";
  const upgrades = props.state?.upgrades ?? props.hut.upgrades ?? [];
  const specialization = props.state?.specialization;
  const specializationDetail = specialization
    ? specialization.selectedType
      ? `Specialization: ${specialization.selectedType} · ${specialization.canChange ? "available now" : `locked until ${specialization.unlocksAt ? new Date(specialization.unlocksAt).toISOString() : "expiry"}`}`
      : "Specialization: none selected"
    : null;
  const have = (itemId: string): number | undefined => props.materialCounts ? props.materialCounts[itemId] ?? 0 : undefined;
  const gold = props.goldBalance === null || props.goldBalance === undefined ? undefined : BigInt(props.goldBalance);
  const costs: { key: string; label: string; materials: MaterialNeed[] }[] = [
    ...(props.onCraft ? [{
      key: "rod",
      label: "Fishing Rod",
      materials: [
        { itemId: "wood", name: "Wood", quantity: FISHING_ROD_RECIPE_COST.wood, have: have("wood") },
        { itemId: "flax_fiber", name: "Flax Fiber", quantity: FISHING_ROD_RECIPE_COST.flaxFiber, have: have("flax_fiber") }
      ]
    }] : []),
    ...(props.onUpgrade ? upgrades.filter((upgrade) => upgrade.nextRank !== null && upgrade.nextCostGold !== null).map((upgrade) => ({
      key: `upgrade-${upgrade.track}`,
      label: `${fishingUpgradeTrackLabel(upgrade.track)} rank ${upgrade.nextRank}`,
      materials: [{ itemId: "gold", name: "Gold", quantity: upgrade.nextCostGold!, have: gold }]
    })) : [])
  ];
  const legacyStart = props.onStart ?? props.onFish ?? (() => undefined);
  const actions = [
    ...(ready > 0 ? [{ key: "collect", label: `Collect ${ready} Freshwater Fish`, enabled: disabledReason === null, busy: props.busy, disabledReason, onSelect: props.onCollect }] : []),
    ...(props.onCraft ? [{ key: "craft-rod", label: "Craft Fishing Rod", enabled: disabledReason === null && !props.busy, disabledReason, onSelect: props.onCraft }] : []),
    ...(props.onUpgrade ? upgrades.map((upgrade) => ({
      key: `upgrade-${upgrade.track}`,
      label: `${fishingUpgradeTrackLabel(upgrade.track)} · ${upgrade.nextRank === null ? `Max rank · ${fishingUpgradeEffectLabel(upgrade.track, upgrade.effect)}` : `Rank ${upgrade.nextRank} · ${fishingUpgradeEffectLabel(upgrade.track, upgrade.nextEffect ?? 0)}`}`,
      enabled: disabledReason === null && !props.busy && upgrade.nextRank !== null,
      busy: props.busy,
      disabledReason: upgrade.nextRank === null ? "This training track is maxed." : disabledReason,
      onSelect: () => props.onUpgrade!(upgrade.track)
    })) : []),
    ...(props.onSpecialize && specialization ? (specialization.canChange
      ? (["river", "lake", "ocean"] as const).map((type) => ({
          key: `specialize-${type}`,
          label: `Specialize: ${type[0]!.toUpperCase()}${type.slice(1)}`,
          enabled: disabledReason === null && !props.busy,
          busy: props.busy,
          disabledReason,
          onSelect: () => props.onSpecialize!(type)
        }))
      : [{ key: "specialization-locked", label: `Specialization locked until ${specialization.unlocksAt ? new Date(specialization.unlocksAt).toISOString() : "expiry"}`, enabled: false, disabledReason: "You may choose again after the seven-day lock expires.", onSelect: () => undefined }]) : []),
    ...(props.onCraft ? [] : [{ key: "fish", label: "Fish", enabled: disabledReason === null && !props.busy, tone: ready > 0 ? "secondary" as const : "primary" as const, disabledReason, onSelect: legacyStart }])
  ];
  return <GameActionPrompt
    title="Fishing Hut"
    category={props.hut.waterbody.kind === "lake" ? "Freshwater lake" : props.hut.waterbody.kind === "river" ? "Freshwater river" : "Ocean shore"}
    detail={[`${fishingWaterbodyLabel(props.hut.waterbody.kind)}: ${props.hut.waterbody.displayName} · ${Math.round(props.hut.waterbody.distanceM)}m away`, specializationDetail].filter(Boolean).join(" · ")}
    message={props.feedback ? { text: props.feedback } : null}
    content={costs.length > 0 ? <div className="fishing-cost-list">{costs.map((cost) => <div key={cost.key}>
      <small>{cost.label}</small>
      <MaterialChips label={`${cost.label} cost`} materials={cost.materials} />
    </div>)}</div> : null}
    actions={actions}
    onCancel={props.onClose}
  />;
}

function fishingUpgradeTrackLabel(track: "cast_range" | "reel_power" | "line_control"): string {
  return track === "cast_range" ? "Cast Range" : track === "reel_power" ? "Reel Power" : "Line Control";
}

function fishingUpgradeEffectLabel(track: "cast_range" | "reel_power" | "line_control", effect: number): string {
  if (track === "cast_range") return `+${Math.round(effect)}m (${Math.round(FISHING_BASE_CAST_RANGE_M + effect)}m total)`;
  return `+${Math.round(effect * 100)}% handling`;
}

export function FishingTargetingPrompt(props: Readonly<{
  state: FishingStateSnapshot;
  feedback: string | null;
  busy: boolean;
  invalid: boolean;
  selectedWaterbody?: { kind: "river" | "lake" | "ocean"; sourceId: string | null } | null;
  onSelectWaterbody?(waterbody: { kind: "river" | "lake" | "ocean"; sourceId: string | null }): void;
  onCancel(): void;
}>): React.JSX.Element {
  const encounter = props.state.encounter;
  const candidates = encounter?.waterbodyCandidates ?? [];
  if (encounter && candidates.length > 1 && !props.selectedWaterbody && props.onSelectWaterbody) {
    return <GameTargetPicker
      title="Choose a waterbody"
      ariaLabel="Choose a waterbody for fishing"
      choices={candidates.map((candidate) => ({
        key: `${candidate.kind}:${candidate.sourceId}`,
        name: candidate.displayName,
        category: fishingWaterbodyLabel(candidate.kind),
        meta: `${Math.round(candidate.distanceM)}m away`,
        detail: "Select this waterbody, then choose a cast square."
      }))}
      onSelect={(key) => {
        const candidate = candidates.find((entry) => `${entry.kind}:${entry.sourceId}` === key);
        if (candidate) props.onSelectWaterbody?.({ kind: candidate.kind, sourceId: candidate.sourceId });
      }}
      onQuickAction={(key) => {
        const candidate = candidates.find((entry) => `${entry.kind}:${entry.sourceId}` === key);
        if (candidate) props.onSelectWaterbody?.({ kind: candidate.kind, sourceId: candidate.sourceId });
      }}
      onCancel={props.onCancel}
    />;
  }
  const selectedCandidate = props.selectedWaterbody
    ? candidates.find((candidate) => candidate.kind === props.selectedWaterbody?.kind && candidate.sourceId === props.selectedWaterbody?.sourceId)
    : null;
  const waterbody = encounter?.waterbody ?? selectedCandidate;
  return <div className="fishing-targeting-placement">
    <GameActionPrompt
      title="Choose a cast spot"
      category="Fishing"
      detail={waterbody ? `${fishingWaterbodyLabel(waterbody.kind)}: ${waterbody.displayName} · within ${Math.round(encounter?.castRangeM ?? FISHING_BASE_CAST_RANGE_M)}m` : `Within ${Math.round(encounter?.castRangeM ?? FISHING_BASE_CAST_RANGE_M)}m of your standing position`}
      message={{ text: props.feedback ?? "Choose a square of authoritative water on the map.", tone: props.invalid ? "error" : "muted" }}
      content={<p className="game-compact-message fishing-targeting-help">Tap or click the water where the float should land. Press Escape or Cancel to step away.</p>}
      actions={[]}
      cancelLabel={props.busy ? "Checking…" : "Cancel"}
      onCancel={props.onCancel}
    />
  </div>;
}

function encounterPhaseLabel(encounter: FishingEncounterSnapshot): string {
  const kind = encounter.biteEvent?.kind;
  if (encounter.phase === "cast") return encounter.castPoint ? "Float set" : "Choose cast spot";
  if (encounter.phase === "bite") return kind === "true_strike" ? "True strike" : kind ? "Float movement" : "Strike passed";
  if (encounter.phase === "hooked" || encounter.phase === "fighting") return "";
  return encounter.phase;
}

function encounterHint(encounter: FishingEncounterSnapshot): string {
  const kind = encounter.biteEvent?.kind;
  if (encounter.phase === "bite" && (kind === "fake_nibble" || kind === "nibble")) return "The float is moving. Set the hook if you want to test the bite.";
  if (encounter.phase === "bite" && kind === "true_strike") return "Set the hook now.";
  if (encounter.phase === "cast") return encounter.castPoint ? "The float is on the water. Watch for the strike." : "Choose a square of authoritative water on the map.";
  return "The encounter has ended.";
}

function oppositeDirection(direction: FishingControlDirection): FishingControlDirection {
  return direction === "left" ? "right" : direction === "right" ? "left" : "neutral";
}

function waterbodyContext(encounter: FishingEncounterSnapshot): string {
  return encounter.waterbody
    ? `${fishingWaterbodyLabel(encounter.waterbody.kind)}: ${encounter.waterbody.displayName}`
    : "Waterbody selection pending";
}

function accessibleFightGuidance(
  encounter: FishingEncounterSnapshot,
  canLand: boolean
): string {
  if (canLand) return "The fish is ready to land. Choose Land fish.";
  if (encounter.fishDirection === "neutral") return "The fish is steady. Use REEL.";
  return `The fish is pulling ${encounter.fishDirection}. Counter with ${oppositeDirection(encounter.fishDirection)}.`;
}

function FishingEncounterScene(props: Readonly<{
  encounter: FishingEncounterSnapshot;
  canLand: boolean;
}>): React.JSX.Element {
  const { encounter } = props;
  const backgroundUrl = encounter.waterbody ? fishingEncounterBackgroundUrl(encounter.waterbody.kind) : null;
  const direction = encounter.fishDirection;
  const guidance = accessibleFightGuidance(encounter, props.canLand);
  return <div
    className={`fishing-encounter-scene fishing-encounter-scene-${direction}`}
    data-pull-direction={direction}
    role="img"
    aria-label={guidance}
  >
    {backgroundUrl ? <img className="fishing-encounter-scene-background" src={backgroundUrl} alt="" /> : <div className="fishing-encounter-scene-fallback" aria-hidden="true" />}
    <span className="fishing-encounter-scene-waterline" aria-hidden="true" />
    <img className="fishing-encounter-scene-fish" src={FISHING_ENCOUNTER_ARTWORK.fish} alt="" />
    <span className="sr-only">{guidance}</span>
  </div>;
}

function FishingMeter(props: Readonly<{
  label: string;
  value: number;
  description: string;
  markers: React.ReactNode;
}>): React.JSX.Element {
  return <div>
    <dt>{props.label}</dt>
    <dd>
      <div className="fishing-meter-track">
        <meter aria-label={props.label} aria-describedby={`${props.label.toLowerCase().replaceAll(" ", "-")}-threshold`} min={0} max={100} value={props.value}>{Math.round(props.value)}%</meter>
        {props.markers}
      </div>
      <span id={`${props.label.toLowerCase().replaceAll(" ", "-")}-threshold`} className="sr-only">{props.description}</span>
    </dd>
  </div>;
}

function PointerButton(props: Readonly<{
  label: string;
  disabled: boolean;
  recommended?: boolean;
  onPress(): void;
  onRelease(): void;
}>): React.JSX.Element {
  const pressedRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const onReleaseRef = useRef(props.onRelease);
  const [pressed, setPressed] = useState(false);
  onReleaseRef.current = props.onRelease;
  const finishPress = useCallback((pointerId?: number): void => {
    if (!pressedRef.current) return;
    if (pointerId !== undefined && pointerIdRef.current !== pointerId) return;
    pressedRef.current = false;
    pointerIdRef.current = null;
    setPressed(false);
    onReleaseRef.current();
  }, []);
  useEffect(() => {
    // Pointer capture normally routes these events back to the button. Keep a
    // window fallback as well so a browser losing capture cannot leave the
    // server-side intent latched forever.
    const releasePointer = (event: PointerEvent): void => {
      if (Number.isFinite(event.pointerId) && pointerIdRef.current === event.pointerId) finishPress(event.pointerId);
    };
    const releaseAll = (): void => finishPress();
    window.addEventListener("pointerup", releasePointer);
    window.addEventListener("pointercancel", releasePointer);
    window.addEventListener("blur", releaseAll);
    return () => {
      window.removeEventListener("pointerup", releasePointer);
      window.removeEventListener("pointercancel", releasePointer);
      window.removeEventListener("blur", releaseAll);
      // A terminal server snapshot can remove this button while its pointer
      // is still down. Clear local state without sending a late release to an
      // encounter that is no longer fighting; the server already reset its
      // durable intent as part of the terminal transition.
      if (pressedRef.current) {
        pressedRef.current = false;
        pointerIdRef.current = null;
      }
    };
  }, [finishPress]);
  return <GamePromptButton
    className={`fishing-overworld-control${props.recommended ? " fishing-overworld-control-recommended" : ""}${pressed ? " fishing-overworld-control-pressed" : ""}`}
    disabled={props.disabled}
    aria-label={props.label}
    aria-pressed={pressed}
    onPointerDown={(event) => {
      event.preventDefault();
      if (pressedRef.current) return;
      pressedRef.current = true;
      pointerIdRef.current = event.pointerId;
      setPressed(true);
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // Some embedded browsers reject capture for synthetic/non-primary
        // pointers; the window release fallback still keeps the intent safe.
      }
      props.onPress();
    }}
    onPointerUp={(event) => {
      event.preventDefault();
      if (pointerIdRef.current !== event.pointerId) return;
      finishPress();
      try {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      } catch {
        // Capture may already have been released by the browser.
      }
    }}
    onPointerCancel={() => finishPress()}
    onLostPointerCapture={(event) => {
      // Browsers include the captured pointer id here. Ignore malformed
      // events without an id so a sibling control cannot release this one.
      if (Number.isFinite(event.pointerId)) finishPress(event.pointerId);
    }}
    onContextMenu={(event) => event.preventDefault()}
  >{props.label}</GamePromptButton>;
}

/** Compact in-world encounter controls; the map remains visible behind this prompt. */
export function FishingPrompt(props: Readonly<{
  state: FishingStateSnapshot;
  feedback: string | null;
  outcome?: "missed" | "expired" | null;
  busy: boolean;
  onHook(): void;
  onControl(direction: "left" | "right" | "neutral", reeling: boolean): void;
  onLand(): void;
  onClose(): void;
}>): React.JSX.Element | null {
  const encounter = props.state.encounter;
  const directionRef = useRef<"left" | "right" | "neutral">("neutral");
  const reelingRef = useRef(false);
  const controlTimerRef = useRef<number | null>(null);
  const onControlRef = useRef(props.onControl);
  const busyRef = useRef(props.busy);
  onControlRef.current = props.onControl;
  busyRef.current = props.busy;
  const stopControlCadence = (): void => {
    if (controlTimerRef.current === null) return;
    window.clearInterval(controlTimerRef.current);
    controlTimerRef.current = null;
  };
  const sendCurrentControl = (): void => {
    if (!busyRef.current) onControlRef.current(directionRef.current, reelingRef.current);
  };
  const startControlCadence = (): void => {
    if (controlTimerRef.current !== null) return;
    controlTimerRef.current = window.setInterval(() => {
      if (directionRef.current === "neutral" && !reelingRef.current) {
        stopControlCadence();
        return;
      }
      sendCurrentControl();
    }, FISHING_CONTROL_UPDATE_INTERVAL_MS);
  };
  const updateControlIntent = (next: Readonly<{ direction?: FishingControlDirection; reeling?: boolean }>): void => {
    if (next.direction !== undefined) directionRef.current = next.direction;
    if (next.reeling !== undefined) reelingRef.current = next.reeling;
    sendCurrentControl();
    if (directionRef.current !== "neutral" || reelingRef.current) startControlCadence();
    else stopControlCadence();
  };
  useEffect(() => {
    if (!encounter || (encounter.phase !== "fighting" && encounter.phase !== "hooked")) {
      stopControlCadence();
      directionRef.current = "neutral";
      reelingRef.current = false;
      return;
    }
    const releaseControls = (): void => {
      const wasActive = directionRef.current !== "neutral" || reelingRef.current;
      directionRef.current = "neutral";
      reelingRef.current = false;
      stopControlCadence();
      if (wasActive && !busyRef.current) onControlRef.current("neutral", false);
    };
    const onWindowBlur = (): void => releaseControls();
    const onVisibilityChange = (): void => {
      if (document.hidden) releaseControls();
    };
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopControlCadence();
      directionRef.current = "neutral";
      reelingRef.current = false;
    };
  }, [encounter?.phase]);
  useEffect(() => {
    if (!encounter || (encounter.phase !== "fighting" && encounter.phase !== "hooked")) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "a" || event.key === "ArrowLeft") {
        event.preventDefault(); updateControlIntent({ direction: "left" });
      } else if (event.key === "d" || event.key === "ArrowRight") {
        event.preventDefault(); updateControlIntent({ direction: "right" });
      } else if (event.code === "Space") {
        event.preventDefault(); updateControlIntent({ reeling: true });
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if ((event.key === "a" || event.key === "ArrowLeft") && directionRef.current === "left") {
        event.preventDefault(); updateControlIntent({ direction: "neutral" });
      } else if ((event.key === "d" || event.key === "ArrowRight") && directionRef.current === "right") {
        event.preventDefault(); updateControlIntent({ direction: "neutral" });
      } else if (event.code === "Space") {
        event.preventDefault(); updateControlIntent({ reeling: false });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      directionRef.current = "neutral";
      reelingRef.current = false;
      stopControlCadence();
    };
  }, [encounter?.phase]);
  if (!encounter) return null;
  const biteCue = encounter.phase === "bite" && encounter.biteEvent !== null;
  const activeFight = encounter.phase === "fighting" || encounter.phase === "hooked";
  // A late hook is recovered by the server as the next Float Set cycle. Keep
  // the legacy outcome prop non-terminal so stale clients never strand a
  // player behind a dismiss-only result.
  const terminal = props.outcome === "expired"
    || encounter.phase === "landed" || encounter.phase === "escaped" || encounter.phase === "expired" || encounter.phase === "cancelled";
  const phaseLabel = props.outcome === "expired" ? "Encounter expired" : encounter.phase === "escaped" ? "Fish escaped" : encounterPhaseLabel(encounter);
  const canLand = activeFight && fishingFightCanLand({
    distance: encounter.distance,
    stamina: encounter.stamina,
    tension: encounter.tension,
    slackMs: encounter.slackMs,
    criticalMs: encounter.criticalMs,
    fishDirection: encounter.fishDirection,
    fishPull: encounter.fishPull
  });
  const fightGuidance = activeFight ? accessibleFightGuidance(encounter, canLand) : null;
  const status = props.feedback ?? (props.outcome === "missed"
    ? "The strike passed. The float is set again; watch for another bite."
    : props.outcome === "expired"
      ? "The fishing encounter expired."
      : encounterHint(encounter));
  const content = <>
    {activeFight ? <FishingEncounterScene encounter={encounter} canLand={canLand} /> : null}
    {activeFight ? <span className="sr-only" role="status">{fightGuidance}</span> : null}
    {activeFight ? <dl className="fishing-overworld-meters" aria-label="Fishing fight meters">
      <FishingMeter
        label="Line tension"
        value={encounter.tension}
        description="Landable when line tension is between 25% and 91%."
        markers={<span className="fishing-meter-landing-band" aria-hidden="true" title="Landable tension range" />}
      />
      <FishingMeter
        label="Fish distance"
        value={encounter.distance}
        description="Landable when fish distance is 12% or lower."
        markers={<span className="fishing-meter-threshold fishing-meter-threshold-distance" aria-hidden="true" title="Landable distance threshold" />}
      />
      <FishingMeter
        label="Fish stamina"
        value={fishingStaminaPercent(encounter.stamina)}
        description={`Landable when fish stamina is ${Math.round(fishingStaminaPercent(FISHING_STAMINA_LANDING_THRESHOLD))}% or lower.`}
        markers={<span className="fishing-meter-threshold fishing-meter-threshold-stamina" aria-hidden="true" title="Landable stamina threshold" />}
      />
    </dl> : null}
    {biteCue ? <GamePromptButton className="fishing-overworld-hook" disabled={props.busy} onClick={props.onHook}>Set hook</GamePromptButton> : null}
    {activeFight ? <div className="fishing-overworld-controls" aria-label="Fishing controls">
      <PointerButton label="LEFT" recommended={encounter.fishDirection === "right"} disabled={props.busy} onPress={() => updateControlIntent({ direction: "left" })} onRelease={() => { if (directionRef.current === "left") updateControlIntent({ direction: "neutral" }); }} />
      <PointerButton label="REEL" disabled={props.busy} onPress={() => updateControlIntent({ reeling: true })} onRelease={() => updateControlIntent({ reeling: false })} />
      <PointerButton label="RIGHT" recommended={encounter.fishDirection === "left"} disabled={props.busy} onPress={() => updateControlIntent({ direction: "right" })} onRelease={() => { if (directionRef.current === "right") updateControlIntent({ direction: "neutral" }); }} />
    </div> : null}
    {encounter.catch ? <p className="game-compact-message fishing-overworld-catch" role="status">{encounter.catch.fishSpecies ?? (encounter.catch.waterbody.kind === "ocean" ? "Ocean Fish" : "Freshwater Fish")} · {encounter.catch.lengthIn.toFixed(1)} in · {encounter.catch.weightLb.toFixed(2)} lb · {encounter.catch.score} score{encounter.catch.perfect ? " · Perfect" : ""}</p> : null}
  </>;
  return <div className="fishing-overworld-prompt" data-fishing-phase={encounter.phase} data-fishing-outcome={props.outcome ?? undefined}>
    <GameActionPrompt
      title="Fishing"
      category={phaseLabel}
      detail={waterbodyContext(encounter)}
      message={activeFight
        ? (canLand ? { text: "Ready to land", tone: "muted" as const } : null)
        : { text: status, tone: props.outcome === "expired" || encounter.phase === "escaped" ? "error" : "muted" }}
      content={content}
      actions={[
        ...(activeFight ? [{
          key: "land",
          label: "Land fish",
          tone: "primary" as const,
          enabled: !props.busy && canLand,
          busy: props.busy,
          disabledReason: canLand ? null : props.busy ? "Waiting for the fight update." : null,
          onSelect: props.onLand
        }] : [])
      ]}
      cancelLabel={terminal ? "Back to world" : "Cancel"}
      ariaLabel="Fishing encounter actions"
      onCancel={props.onClose}
    />
  </div>;
}

/** Fishing records content housed by the canonical Rankings destination. */
export function FishingRecordsCards(props: Readonly<{
  state?: FishingStateSnapshot | null;
  records: FishingRecordSnapshot | null;
  busy: boolean;
  onRecords(): void;
}>): React.JSX.Element {
  const records = props.records;
  const personalBestWeight = props.state?.personalBestWeightLb ?? records?.personalBestWeight?.weightLb ?? null;
  return <div className="weekly-fishing-records-grid">
      <GameAppCard title="Personal records" badge="Best 5 weekly">
        <p>Heaviest: {personalBestWeight === null ? "—" : `${personalBestWeight.toFixed(2)} lb`}</p>
        <p>Highest score: {props.state?.personalBestScore ?? records?.personalBestScore?.score ?? "—"}</p>
        <p>Weekly best five total: {props.state?.weeklyBestFiveScore ?? records?.weeklyBestFiveScore ?? 0}</p>
        <p>Best Perfect Catch: {records?.personalBestPerfect ? `${records.personalBestPerfect.score} score` : "—"}</p>
      </GameAppCard>
      <GameAppCard title="Universal records" badge="All active waterbodies">
        <p>Heaviest: {records?.heaviest ? `${records.heaviest.weightLb.toFixed(2)} lb` : "—"}</p>
        <p>Highest score: {records?.highestScore?.score ?? "—"}</p>
        <p>Personal best across all waters: {records?.personalBestWeight ? `${records.personalBestWeight.weightLb.toFixed(2)} lb` : "—"}</p>
        <p>Personal best score across all waters: {records?.personalBestScore?.score ?? "—"}</p>
        <p>Weekly Top Anglers</p>
        {records?.weeklyTopAnglers.length ? <ol aria-label="Weekly Top Anglers">{records.weeklyTopAnglers.map((angler) => <li key={angler.playerId}>{angler.username} · {angler.score} ({angler.catchCount} catches)</li>)}</ol> : <p>No ranked catches yet.</p>}
        <p>Recent notable catches</p>
        {records?.recentCatches.length ? <ul aria-label="Recent notable catches">{records.recentCatches.map((caught) => {
          const fish = caught.fishSpecies ?? (caught.waterbody.kind === "ocean" ? "ocean_fish" : caught.fishItemId);
          const player = caught.player?.username ?? caught.player?.playerId ?? "Unknown angler";
          const location = caught.geography ? `${caught.geography.region}, ${caught.geography.country}` : "Unknown area";
          return <li key={caught.catchId}>{player} · {fish} · {caught.weightLb.toFixed(2)} lb · {caught.lengthIn.toFixed(1)} in · {fishingPercentileLabel(caught.percentile)} · {caught.waterbody.displayName} ({fishingWaterbodyLabel(caught.waterbody.kind)}) · {location}</li>;
        })}</ul> : <p>No catches yet.</p>}
        <button type="button" disabled={props.busy} onClick={props.onRecords}>{records ? "Refresh records" : "View records"}</button>
      </GameAppCard>
    </div>;
}
