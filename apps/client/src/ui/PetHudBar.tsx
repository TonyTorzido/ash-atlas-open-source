import {
  PET_ABILITY_DEFINITIONS,
  PET_SPECIES_DEFINITIONS,
  type PetAbilityId,
  type PetCompanionCommand,
  type PetSnapshot
} from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { PET_ABILITY_ICON_URLS, PET_CALL_ICON_URL, PET_STAY_ICON_URL } from "./petAbilityIcons.js";

/**
 * Pet controls in the activity-status slot while a pet is out: time left, Stay/Follow and the
 * learned abilities with their cooldowns. Abilities aimed at an enemy use your current target.
 */
export function PetHudBar(props: Readonly<{
  pet: PetSnapshot;
  staying: boolean;
  busy: boolean;
  /** The ability the server is still working on (Find Open Land searching). */
  pendingAbilityId?: PetAbilityId | null;
  onCommand(command: PetCompanionCommand): void;
  onAbility(abilityId: PetAbilityId): void;
  /** Press-and-hold Stay/Follow, drag onto the map, release: the pet walks there and stays. */
  onPlaceStay?(clientPoint: Readonly<{ x: number; y: number }>): void;
}>): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const placement = useStayPlacement(props.busy ? undefined : props.onPlaceStay);
  const species = PET_SPECIES_DEFINITIONS[props.pet.species];
  const minutesLeft = props.pet.activeUntil ? Math.max(0, Math.ceil((Date.parse(props.pet.activeUntil) - now) / 60_000)) : 0;
  return (
    <div className="pet-hud-bar" role="group" aria-label={`${props.pet.name} controls`}>
      <span className="pet-hud-bar-name">{props.pet.name}<small>{minutesLeft}m</small></span>
      <button
        type="button"
        className="pet-hud-bar-button"
        aria-label={props.staying ? "Follow" : "Stay"}
        title={props.staying ? "Follow" : "Stay"}
        disabled={props.busy}
        data-placing={placement.drag ? "true" : undefined}
        {...placement.handlers}
        onClick={() => {
          if (placement.consumeClick()) return;
          props.onCommand(props.staying ? "follow" : "stay");
        }}
      >
        <img src={props.staying ? PET_CALL_ICON_URL : PET_STAY_ICON_URL} alt="" draggable={false} />
      </button>
      {placement.drag ? createPortal(<StayPlacementArrow drag={placement.drag} />, document.body) : null}
      {species.abilities.filter((id) => props.pet.unlockedAbilities.includes(id)).map((abilityId) => {
        const readyAt = props.pet.abilityReadyAt[abilityId];
        const remaining = readyAt ? Math.ceil((Date.parse(readyAt) - now) / 1_000) : 0;
        const name = PET_ABILITY_DEFINITIONS[abilityId].name;
        return (
          <button
            key={abilityId}
            type="button"
            className="pet-hud-bar-button"
            aria-label={remaining > 0 ? `${name}, ready in ${remaining} seconds` : name}
            title={name}
            disabled={props.busy || remaining > 0}
            aria-busy={props.pendingAbilityId === abilityId}
            onClick={() => props.onAbility(abilityId)}
          >
            <img src={PET_ABILITY_ICON_URLS[abilityId]} alt="" />
            {remaining > 0 ? <span className="pet-hud-bar-cooldown">{remaining}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

const STAY_HOLD_MS = 350;

type StayDrag = Readonly<{ from: { x: number; y: number }; to: { x: number; y: number }; overButton: boolean }>;

/**
 * Hold on the Stay/Follow button to aim a placed Stay: an arrow follows the pointer (touch or
 * mouse) and releasing on the map places the pet there. Releasing back on the button cancels.
 */
function useStayPlacement(onPlaceStay: ((clientPoint: Readonly<{ x: number; y: number }>) => void) | undefined) {
  const [drag, setDrag] = useState<StayDrag | null>(null);
  const dragRef = useRef<StayDrag | null>(null);
  const holdTimer = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const pressRef = useRef<{ pointerId: number; button: HTMLButtonElement; point: { x: number; y: number } } | null>(null);
  const clearHold = (): void => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  const update = (next: StayDrag | null): void => {
    dragRef.current = next;
    setDrag(next);
  };
  useEffect(() => () => clearHold(), []);
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      pressRef.current = null;
      suppressClick.current = true;
      update(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragging]);
  const overButton = (button: HTMLButtonElement, x: number, y: number): boolean => {
    const rect = button.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };
  const handlers = onPlaceStay ? {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>): void => {
      if (event.button !== 0) return;
      const button = event.currentTarget;
      const rect = button.getBoundingClientRect();
      const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      pressRef.current = { pointerId: event.pointerId, button, point: { x: event.clientX, y: event.clientY } };
      try { button.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
      clearHold();
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        const press = pressRef.current;
        if (!press) return;
        update({ from, to: press.point, overButton: overButton(press.button, press.point.x, press.point.y) });
      }, STAY_HOLD_MS);
    },
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>): void => {
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      press.point = { x: event.clientX, y: event.clientY };
      const current = dragRef.current;
      if (current) update({ ...current, to: press.point, overButton: overButton(press.button, event.clientX, event.clientY) });
    },
    onPointerUp: (event: React.PointerEvent<HTMLButtonElement>): void => {
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      clearHold();
      pressRef.current = null;
      if (!dragRef.current) return;
      suppressClick.current = true;
      update(null);
      if (!overButton(press.button, event.clientX, event.clientY)) onPlaceStay({ x: event.clientX, y: event.clientY });
    },
    onPointerCancel: (): void => {
      clearHold();
      pressRef.current = null;
      if (dragRef.current) suppressClick.current = true;
      update(null);
    },
    onContextMenu: (event: React.MouseEvent): void => event.preventDefault(),
    // A native image/element drag would cancel the pointer gesture on desktop.
    onDragStart: (event: React.DragEvent): void => event.preventDefault()
  } : {};
  return {
    drag,
    handlers,
    /** True once for the click that ends a drag (so it is not also a Stay/Follow tap). */
    consumeClick: (): boolean => {
      const suppressed = suppressClick.current;
      suppressClick.current = false;
      return suppressed;
    }
  };
}

function StayPlacementArrow(props: Readonly<{ drag: StayDrag }>): React.JSX.Element {
  const { from, to, overButton } = props.drag;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  // Stop the shaft at the target circle so the arrowhead sits on its rim.
  const tipLength = Math.max(0, length - 18);
  const tip = { x: from.x + Math.cos(angle) * tipLength, y: from.y + Math.sin(angle) * tipLength };
  const head = (offset: number): { x: number; y: number } => ({
    x: tip.x - Math.cos(angle + offset) * 12,
    y: tip.y - Math.sin(angle + offset) * 12
  });
  const left = head(0.5);
  const right = head(-0.5);
  return (
    <svg className={`pet-stay-placement${overButton ? " cancelling" : ""}`} aria-hidden="true">
      {length > 24 ? (
        <>
          <line x1={from.x} y1={from.y} x2={tip.x} y2={tip.y} />
          <polyline points={`${left.x},${left.y} ${tip.x},${tip.y} ${right.x},${right.y}`} />
        </>
      ) : null}
      <circle cx={to.x} cy={to.y} r={16} />
    </svg>
  );
}
