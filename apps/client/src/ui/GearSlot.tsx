import { Capacitor } from "@capacitor/core";
import { Haptics } from "@capacitor/haptics";
import { useEffect, useRef, useState } from "react";

export type GearSlotSet = Readonly<{ name: string; color: string }>;

/** Movement (px) that turns a press into a slide gesture instead of a tap. */
const SLIDE_THRESHOLD_PX = 8;
/** Vertical distance from the fan row beyond which a release cancels. */
const ROW_TOLERANCE_PX = 72;

/**
 * Quick slot that swaps whole gear sets. Touch-down opens a sideways fan
 * instantly; slide and release on a set to equip it. Sets keep fixed positions
 * and are picked by horizontal distance band, so fast imprecise flicks land
 * predictably. A press without sliding leaves the fan open for tapping.
 */
export function GearSlot({
  side,
  sets,
  currentIndex,
  disabled,
  onEquip
}: Readonly<{
  side: "left" | "right";
  sets: readonly GearSlotSet[];
  currentIndex: number;
  disabled: boolean;
  onEquip(index: number): void;
}>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const fanRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<{ pointerId: number; startX: number; startY: number; sliding: boolean } | null>(null);
  const hoveredRef = useRef<number | null>(null);
  const current = sets[currentIndex] ?? sets[0];

  const setHover = (index: number | null): void => {
    if (hoveredRef.current === index) return;
    hoveredRef.current = index;
    setHovered(index);
    if (index !== null) tick();
  };
  const close = (): void => {
    gestureRef.current = null;
    hoveredRef.current = null;
    setHovered(null);
    setOpen(false);
  };
  const equip = (index: number): void => {
    close();
    if (index === currentIndex) return;
    onEquip(index);
    setFlash(true);
  };

  useEffect(() => {
    if (!flash) return undefined;
    const timer = window.setTimeout(() => setFlash(false), 320);
    return () => window.clearTimeout(timer);
  }, [flash]);

  // Tap mode: an outside press or Escape closes the fan.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (gestureRef.current) return;
      if (!wrapperRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /** Fixed-position bands: distance past the slot edge picks the set. */
  const indexAt = (clientX: number, clientY: number): number | null => {
    const button = buttonRef.current?.getBoundingClientRect();
    const entries = fanRef.current ? Array.from(fanRef.current.children, (child) => child.getBoundingClientRect()) : [];
    if (!button || entries.length === 0) return null;
    const rowCenter = button.top + button.height / 2;
    if (Math.abs(clientY - rowCenter) > ROW_TOLERANCE_PX) return null;
    const distance = side === "left" ? clientX - button.right : button.left - clientX;
    if (distance < 0) return null;
    const first = entries[0]!;
    const second = entries[1];
    const step = second ? Math.abs((second.left + second.width / 2) - (first.left + first.width / 2)) : first.width;
    return Math.min(entries.length - 1, Math.floor(distance / step));
  };

  return <div ref={wrapperRef} className={`ash-gear-slot ash-gear-slot-${side}${open ? " is-open" : ""}`}>
    <button
      ref={buttonRef}
      type="button"
      className={`ash-hotbar-slot has-binding unlocked ready ash-gear-slot-button${flash ? " is-flashing" : ""}`}
      aria-label={`Gear set: ${current?.name ?? "none"}. Press and slide to a set to equip it`}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onPointerDown={(event) => {
        if (disabled || event.button > 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        gestureRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, sliding: false };
        hoveredRef.current = null;
        setHovered(null);
        setOpen(true);
      }}
      onPointerMove={(event) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        if (!gesture.sliding && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >= SLIDE_THRESHOLD_PX) {
          gesture.sliding = true;
        }
        if (gesture.sliding) setHover(indexAt(event.clientX, event.clientY));
      }}
      onPointerUp={(event) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        gestureRef.current = null;
        if (!gesture.sliding) return; // Tap: leave the fan open for tapping a set.
        // The release point decides, so a flick faster than a frame still counts.
        const index = indexAt(event.clientX, event.clientY);
        if (index === null) close();
        else equip(index);
      }}
      onPointerCancel={close}
      onClick={(event) => {
        // Keyboard activation (no pointer) toggles the fan for tap selection.
        if (event.detail === 0) setOpen((value) => !value);
      }}
    >
      <GearSetGlyph color={current?.color ?? "currentColor"} number={currentIndex + 1} />
    </button>
    {open ? <div ref={fanRef} className="ash-gear-fan" role="menu" aria-label="Gear sets">
      {sets.map((set, index) => <button
        key={set.name}
        type="button"
        role="menuitemradio"
        aria-checked={index === currentIndex}
        aria-label={`Equip ${set.name}`}
        className={`ash-gear-fan-entry${index === hovered ? " is-hovered" : ""}${index === currentIndex ? " is-current" : ""}`}
        onClick={() => equip(index)}
      >
        <GearSetGlyph color={set.color} number={index + 1} />
        {index === hovered ? <span className="ash-gear-fan-label" aria-hidden="true">{set.name}</span> : null}
      </button>)}
    </div> : null}
  </div>;
}

function tick(): void {
  try {
    if (Capacitor.isNativePlatform()) void Haptics.selectionChanged().catch(() => undefined);
    else navigator.vibrate?.(6);
  } catch {
    // Haptics are a nicety; never let them break the gesture.
  }
}

/** A chestplate in the set's color with its fixed position number. */
function GearSetGlyph({ color, number }: Readonly<{ color: string; number: number }>): React.JSX.Element {
  return <span className="ash-gear-glyph" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M8 3 5 5 3 9l3 2v9h12v-9l3-2-2-4-3-2c-.6 1.6-2.2 2.5-4 2.5S8.6 4.6 8 3z" fill={color} />
    </svg>
    <b>{number}</b>
  </span>;
}
