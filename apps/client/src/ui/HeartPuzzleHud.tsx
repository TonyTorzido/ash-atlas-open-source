import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import {
  heartPuzzleHub, heartPuzzleRuntime, hidePellBubble, onHeartPuzzleTalk, onVaultEvent, requestHeartPuzzleActive
} from "../heartPuzzles/heartPuzzleSession.js";
import type { HeartPuzzleStatus } from "../heartPuzzles/heartPuzzleRuntime.js";
import { secondsToNextHint } from "../heartPuzzles/puzzleHints.js";
import { OLD_PELL, TILTED_VAULT_ROOMS } from "../heartPuzzles/vault/vaultRooms.js";
import { GameActionPrompt, type GamePromptAction } from "./GameActionPrompt.js";
import "./HeartPuzzleHud.css";

const ROMAN = ["I", "II", "III", "IV", "V", "VI"] as const;
const roomNumeral = (roomId: string): string => ROMAN[Math.max(0, TILTED_VAULT_ROOMS.findIndex((room) => room.id === roomId))] ?? "I";
const FINAL_ROOM_ID = TILTED_VAULT_ROOMS[TILTED_VAULT_ROOMS.length - 1]!.id;

/** Phones and tablets tilt with the gyroscope only; the drag pad and keys are for PC. */
export const isTouchPuzzleDevice = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(pointer: fine)").matches;

/** Gyro state on touch devices: asked on Start (iOS needs the tap), live once orientation events arrive. */
type GyroState = "idle" | "asking" | "live" | "unavailable";

/**
 * Controls for an Ash Heart puzzle room. The flow runs through Old Pell: walk to him and talk (tap him), read his
 * popup, Start. The player is then locked beside him (server-authoritative) until the seal opens or they give up
 * (talk to him again, or Quit on the chip). Phones tilt with the gyroscope; PC drags the pad or uses the keys.
 * The puzzle itself is drawn on the room floor by the map renderer.
 */
export function HeartPuzzleHud({ onRetrySolve }: Readonly<{ onRetrySolve: () => void }>) {
  const [status, setStatus] = useState<HeartPuzzleStatus | null>(heartPuzzleRuntime.status());
  const [pellOpen, setPellOpen] = useState(false);
  const [gyro, setGyro] = useState<GyroState>("idle");
  /** Touch fallback for phones without a gyro (or with motion access denied), revealed only from the notice. */
  const [touchPad, setTouchPad] = useState(false);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const padRef = useRef<HTMLDivElement | null>(null);
  const [titleCard, setTitleCard] = useState<string | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  /** The Heart room was just solved: open Pell's farewell once the celebration ends and the server confirms the seal. */
  const [farewellDue, setFarewellDue] = useState(false);
  const shownRoom = useRef("");
  const touch = isTouchPuzzleDevice();

  useEffect(() => {
    const poll = window.setInterval(() => setStatus(heartPuzzleRuntime.status()), 250);
    // Talking to Old Pell (tap beside him) opens his popup: his words, this room's instructions, Start or Give up.
    const offTalk = onHeartPuzzleTalk(() => {
      hidePellBubble();
      setStatus(heartPuzzleRuntime.status());
      setPellOpen(true);
    });
    const offEvent = onVaultEvent((event) => {
      if (event.type === "won" && heartPuzzleRuntime.status()?.roomId === FINAL_ROOM_ID) {
        window.setTimeout(() => setCelebrating(true), 1900);
        window.setTimeout(() => setCelebrating(false), 6200);
        window.setTimeout(() => setFarewellDue(true), 6400);
      }
    });
    return () => {
      window.clearInterval(poll);
      offTalk();
      offEvent();
      hidePellBubble();
      heartPuzzleHub().setDragOffset(null);
    };
  }, []);

  // A short title card on entering each puzzle room.
  useEffect(() => {
    if (!status || shownRoom.current === status.roomId) return;
    shownRoom.current = status.roomId;
    setPellOpen(false);
    setTouchPad(false);
    setTitleCard(`${roomNumeral(status.roomId)} · ${status.title}`);
    const timer = window.setTimeout(() => setTitleCard(null), 3000);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (!farewellDue || !status) return;
    if (status.roomId !== FINAL_ROOM_ID) { setFarewellDue(false); return; }
    if (!status.solved) return;
    setFarewellDue(false);
    hidePellBubble();
    setPellOpen(true);
  }, [farewellDue, status]);

  // The drag offset must not outlive a run.
  const active = status?.active === true;
  useEffect(() => {
    if (!active) { heartPuzzleHub().setDragOffset(null); setKnob({ x: 0, y: 0 }); }
  }, [active]);

  if (!status) return null;
  const hints = heartPuzzleRuntime.unlockedHints();
  const nextIn = secondsToNextHint(status.elapsedSeconds, status.hintTier);
  const retry = status.reported && !status.solved;

  /** Must run inside the Start tap: iOS only shows the motion prompt from a user gesture. */
  const startSensors = (): void => {
    if (!touch) { void heartPuzzleHub().start([]); return; }
    if (gyro === "live") { heartPuzzleHub().recalibrate(); return; }
    setGyro("asking");
    void heartPuzzleHub().start(["tilt", "motion"]).then(() => {
      window.setTimeout(() => {
        const live = heartPuzzleHub().read().sensorsLive.tilt;
        setGyro(live ? "live" : "unavailable");
        if (live) heartPuzzleHub().recalibrate();
      }, 900);
    });
  };
  const start = (): void => {
    startSensors();
    requestHeartPuzzleActive(true);
    setPellOpen(false);
  };
  const giveUp = (): void => {
    requestHeartPuzzleActive(false);
    heartPuzzleHub().setDragOffset(null);
    setPellOpen(false);
  };

  const dragTo = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    heartPuzzleHub().setDragOffset({ x: dx, y: dy });
    const max = rect.width / 2 - 14;
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, max / len);
    setKnob({ x: dx * k, y: dy * k });
  };
  const releasePad = (): void => {
    heartPuzzleHub().setDragOffset(null);
    setKnob({ x: 0, y: 0 });
  };

  const controls = touch
    ? "Tilt your phone to lean the floor. Hold it the way you like when you press Start: that angle counts as level."
    : "Drag the round pad, or hold the arrow keys or WASD, to lean the floor.";
  const pellActions: GamePromptAction[] = status.solved
    ? [{ key: "pell-leave", label: "Leave", tone: "secondary", onSelect: () => setPellOpen(false) }]
    : active
      ? [
        { key: "pell-keep-trying", label: "Keep trying", tone: "primary", onSelect: () => setPellOpen(false) },
        { key: "pell-give-up", label: "Give up", tone: "danger", onSelect: giveUp }
      ]
      : [
        { key: "pell-start", label: "Start", tone: "primary", onSelect: start },
        { key: "pell-leave", label: "Leave", tone: "secondary", onSelect: () => setPellOpen(false) }
      ];
  const showPad = active && !status.solved && (!touch || touchPad);
  const gyroProblem = touch && active && gyro === "unavailable" && !touchPad && !pellOpen;

  return (<>
    <div className="heart-puzzle-hud" data-testid="heart-puzzle-hud" data-puzzle-active={active ? "true" : "false"}>
      <div className="heart-puzzle-hud__card" data-testid="heart-puzzle-card">
        <div className="heart-puzzle-hud__chip">
          <strong className="heart-puzzle-hud__title">{status.title}</strong>
          {active && !status.solved ? (
            <button type="button" className="heart-puzzle-hud__quit" data-testid="heart-puzzle-quit" onClick={() => setPellOpen(true)}>Quit</button>
          ) : null}
        </div>
        <span className="heart-puzzle-hud__line">
          {status.solved
            ? "The seal is broken. Follow the glowing door."
            : retry ? "Waiting for the seal..."
              : active ? (touch && gyro === "asking" ? "Waking the tilt sensor..." : "Lean the floor.")
                : `Talk to ${OLD_PELL.name} to begin.`}
        </span>
        {active && !status.solved ? (
          <div className="heart-puzzle-hud__row">
            {touch && gyro === "live" ? <button type="button" onClick={() => heartPuzzleHub().recalibrate()}>Level here</button> : null}
            <button type="button" onClick={() => heartPuzzleRuntime.reset()}>Restart stones</button>
            {retry ? <button type="button" onClick={onRetrySolve}>Try the seal again</button> : null}
          </div>
        ) : null}
      </div>
      {gyroProblem ? (
        <div className="heart-puzzle-hud__notice" role="alert" data-testid="heart-puzzle-gyro-notice">
          <strong>Tilt needs your phone's motion sensor</strong>
          <span>This phone did not share its tilt. Allow motion access for this site in your browser settings, then talk to {OLD_PELL.name} and start again.</span>
          <button type="button" className="heart-puzzle-hud__fallback" onClick={() => setTouchPad(true)}>Use touch controls instead</button>
        </div>
      ) : null}
      {showPad ? (
        <div
          ref={padRef}
          className="heart-puzzle-hud__pad"
          aria-label="Tilt pad: drag to lean the floor"
          onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); dragTo(event); }}
          onPointerMove={(event) => { if (event.buttons) dragTo(event); }}
          onPointerUp={releasePad}
          onPointerCancel={releasePad}
        >
          <span className="heart-puzzle-hud__padBase" aria-hidden="true">
            <span className="heart-puzzle-hud__padRing" />
            <span className="heart-puzzle-hud__knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
          </span>
          <span className="heart-puzzle-hud__padNote">Drag to tilt</span>
        </div>
      ) : null}
      {titleCard ? <div className="heart-puzzle-hud__title-card" key={titleCard} data-testid="heart-puzzle-title-card"><span>{titleCard}</span></div> : null}
      {celebrating ? <div className="heart-puzzle-hud__celebrate" data-testid="heart-puzzle-celebrate"><span>The Heart stirs</span></div> : null}
    </div>
    {/* Outside the HUD layer so the prompt keeps the standard popup look (full-width split action bar). */}
    {pellOpen ? (
        <GameActionPrompt
          title={OLD_PELL.name}
          category={OLD_PELL.title}
          className="heart-puzzle-pell"
          ariaLabel={`${OLD_PELL.name} talk`}
          content={(
            <div className="heart-puzzle-pell__text" data-testid="pell-text" tabIndex={0}>
              {status.lore.length > 0 ? (
                <div className="heart-puzzle-pell__lore" data-testid="pell-lore">
                  {status.lore.map((line, index) => <p key={index}>{line}</p>)}
                </div>
              ) : <p>{OLD_PELL.greeting}</p>}
              {status.solved ? (status.roomId === FINAL_ROOM_ID ? null : <p>The seal is open. The door ahead is lit for you, friend. Off you go.</p>) : (
                <>
                  <p className="heart-puzzle-pell__label">{`${roomNumeral(status.roomId)} · ${status.title}`}</p>
                  <p>{status.intro}</p>
                  <p>{controls}</p>
                  <p>{active
                    ? "You stay here beside me while the stones roll. Give up and the board starts over."
                    : "Once you start, you stay here beside me until the seal opens or you give up."}</p>
                  {hints.length === 0
                    ? <p className="heart-puzzle-hud__muted">Give it a try first. I will have something to say if you struggle.</p>
                    : hints.map((hint, index) => <p key={index} className="heart-puzzle-pell__hint">{hint}</p>)}
                  {nextIn !== null && hints.length > 0 ? <p className="heart-puzzle-hud__muted">{`More advice in about ${Math.ceil(nextIn)}s, or after a few more falls.`}</p> : null}
                </>
              )}
            </div>
          )}
          actions={pellActions}
          onCancel={() => setPellOpen(false)}
        />
    ) : null}
  </>);
}
