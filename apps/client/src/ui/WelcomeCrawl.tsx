import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useMenuTheme } from "./menuTheme.js";

import "./WelcomeCrawl.css";

type CrawlLine = { text: string; tone?: "strong" | "quiet" | "close" } | { break: true };

// Shown once, right after a new player is created.
const WELCOME_LINES: CrawlLine[] = [
  { text: "Long before our time, the rulers of the old world gathered to make peace." },
  { text: "They spoke of unity. They promised prosperity. But when the time came to set aside their differences, pride prevailed." },
  { text: "Our fathers went to negotiate peace." },
  { text: "They returned with war.", tone: "strong" },
  { break: true },
  { text: "The Ashen Wars consumed the world. Great civilizations crumbled, villages burned, and kingdoms that had stood for centuries vanished into history." },
  { text: "And when the fires finally faded, the world was no longer the same." },
  { text: "Magic seeped into the earth, spreading through forests, rivers, and mountains. Strange creatures emerged. Some magnificent. Others terrifying." },
  { text: "Those who survived fled." },
  { text: "They abandoned their homes, their kingdoms, and everything they had ever known. Deep into the wilderness they went, far from the ruins of civilization." },
  { text: "There, hidden from the world, they began again." },
  { break: true },
  { text: "We were raised in secrecy, taught to stay quiet, to keep our settlements hidden, and never to venture too far." },
  { text: "Do not follow the old roads. Do not seek the forgotten cities. Never wander into the Ashen Lands.", tone: "quiet" },
  { text: "But these warnings came from the very generation that had brought the world to ruin." },
  { text: "They taught us to fear what lay beyond the trees." },
  { text: "But we have spent our entire lives wondering.", tone: "strong" },
  { text: "What became of the great kingdoms? What creatures now roam the forgotten lands? What wonders have emerged from the ashes?" },
  { break: true },
  { text: "We did not start their wars. We do not have to inherit their fears." },
  { text: "They spent their lives dividing the world." },
  { text: "We will spend ours discovering it.", tone: "strong" },
  { text: "It is our time to explore. To uncover what was lost. To chart the lands that history has forgotten." },
  { text: "The old world ended in ashes.", tone: "strong" },
  { text: "Ours begins with an Atlas.", tone: "strong" },
  { text: "Welcome to Ash Atlas.", tone: "close" }
];

const BASE_SPEED_PX_PER_SECOND = 34;
const FAST_MULTIPLIER = 5;
const KEY_SCROLL_PX = 80;
const TAP_SLOP_PX = 6;
const ASH_FLECKS = 14;

export function WelcomeCrawl({ playerId, onDone }: { playerId: string; onDone(): void }): React.JSX.Element {
  // The game applies the theme only once the world is ready; the crawl plays before that.
  useMenuTheme(playerId);
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLElement>(null);
  const offsetRef = useRef<number | null>(null);
  const endRef = useRef(1);
  const pausedRef = useRef(false);
  const fastRef = useRef(false);
  const dragRef = useRef<{ id: number; y: number; moved: number } | null>(null);
  const [paused, setPaused] = useState(false);
  const [fast, setFast] = useState(false);
  const [finished, setFinished] = useState(false);

  const togglePaused = (): void => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  };
  const toggleFast = (): void => {
    fastRef.current = !fastRef.current;
    setFast(fastRef.current);
  };
  const scrollBy = (delta: number): void => {
    if (offsetRef.current === null) return;
    offsetRef.current = Math.max(0, Math.min(offsetRef.current + delta, endRef.current));
  };

  useEffect(() => {
    let last = performance.now();
    let frame = 0;
    const step = (now: number): void => {
      const viewport = viewportRef.current;
      const track = trackRef.current;
      if (viewport && track) {
        // Generous cap so world loading behind the crawl does not stall it.
        const elapsed = Math.min(now - last, 1000) / 1000;
        // Rest with the closing line and logo above the controls.
        const end = track.offsetHeight + Math.max(viewport.clientHeight * 0.34, 200);
        endRef.current = end;
        // Open with the title already rising into view.
        let offset = offsetRef.current ?? viewport.clientHeight * 0.45;
        if (!pausedRef.current && !dragRef.current) {
          offset += BASE_SPEED_PX_PER_SECOND * (fastRef.current ? FAST_MULTIPLIER : 1) * elapsed;
        }
        offset = Math.max(0, Math.min(offset, end));
        offsetRef.current = offset;
        track.style.transform = `translate3d(0, ${-offset}px, 0)`;
        if (progressRef.current) progressRef.current.style.transform = `scaleX(${offset / end})`;
        if (offset >= end) setFinished(true);
      }
      last = now;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        togglePaused();
      } else if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        scrollBy(event.key === "PageDown" ? KEY_SCROLL_PX * 4 : KEY_SCROLL_PX);
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        scrollBy(event.key === "PageUp" ? -KEY_SCROLL_PX * 4 : -KEY_SCROLL_PX);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return createPortal(
    // Portal to body: the game shell is transformed, which would trap a fixed overlay inside it.
    <div className="welcome-crawl" role="dialog" aria-modal="true" aria-label="Welcome to Ash Atlas">
      <div className="welcome-crawl__ash" aria-hidden="true">
        {Array.from({ length: ASH_FLECKS }, (_, index) => <i key={index} />)}
      </div>
      <div
        className="welcome-crawl__viewport"
        ref={viewportRef}
        onWheel={(event) => scrollBy(event.deltaY)}
        onPointerDown={(event) => {
          dragRef.current = { id: event.pointerId, y: event.clientY, moved: 0 };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.id !== event.pointerId) return;
          const delta = drag.y - event.clientY;
          drag.y = event.clientY;
          drag.moved += Math.abs(delta);
          scrollBy(delta);
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          dragRef.current = null;
          // A tap (not a drag) on the text pauses or resumes.
          if (drag && drag.id === event.pointerId && drag.moved < TAP_SLOP_PX && !finished) togglePaused();
        }}
        onPointerCancel={() => { dragRef.current = null; }}
      >
        <div className="welcome-crawl__track" ref={trackRef}>
          <h1 className="welcome-crawl__title">Welcome to Ash Atlas!</h1>
          <span className="welcome-crawl__rule" aria-hidden="true" />
          {WELCOME_LINES.map((line, index) =>
            "break" in line ? (
              <span key={index} className="welcome-crawl__rule welcome-crawl__rule--break" aria-hidden="true" />
            ) : (
              <p key={index} className={line.tone ? `welcome-crawl__line welcome-crawl__line--${line.tone}` : "welcome-crawl__line"}>
                {line.text}
              </p>
            )
          )}
          <img
            className="welcome-crawl__logo"
            src={`${import.meta.env.BASE_URL}icon-512x512.png`}
            alt="Ash Atlas"
            draggable={false}
          />
        </div>
      </div>
      <div className="welcome-crawl__dock">
        {finished ? (
          <button type="button" className="welcome-crawl__begin" autoFocus onClick={onDone}>
            Begin
          </button>
        ) : null}
        <div className="welcome-crawl__controls">
          <button
            type="button"
            className="welcome-crawl__control"
            aria-label={paused ? "Resume" : "Pause"}
            disabled={finished}
            onClick={togglePaused}
          >
            {paused || finished ? (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path className="welcome-crawl__icon-fill" d="M8 5.5v13l10.5-6.5z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12" /></svg>
            )}
          </button>
          <span className="welcome-crawl__progress" aria-hidden="true"><i ref={progressRef} /></span>
          <button
            type="button"
            className={fast ? "welcome-crawl__control welcome-crawl__control--on" : "welcome-crawl__control"}
            aria-label={fast ? "Normal speed" : "Speed up"}
            aria-pressed={fast}
            disabled={finished}
            onClick={toggleFast}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 5.5l6 6.5-6 6.5" />
              <path d="M13 5.5l6 6.5-6 6.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
