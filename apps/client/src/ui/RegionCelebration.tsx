import { useCallback, useEffect, useReducer } from "react";

import {
  INITIAL_CELEBRATION_QUEUE,
  celebrationAnnouncement,
  enqueueCelebrations,
  finishCelebration,
  interruptCelebration,
  startNextCelebration,
  type CelebrationCard,
  type CelebrationQueueState
} from "./celebrationQueue.js";

/** 0.35 s scale-in, 6 s hold, 2 s fade; matches `region-celebration-reveal` in styles.css. */
export const REGION_CELEBRATION_VISIBLE_MS = 8_350;
/** The card enters this long after it is ready, so it follows the zone banner rather than landing with it. */
export const REGION_CELEBRATION_STAGGER_MS = 400;

type Action =
  | { type: "enqueue"; cards: readonly CelebrationCard[] }
  | { type: "start" }
  | { type: "finish" }
  | { type: "interrupt" };

function reduce(state: CelebrationQueueState, action: Action): CelebrationQueueState {
  switch (action.type) {
    case "enqueue": return enqueueCelebrations(state, action.cards);
    case "start": return startNextCelebration(state);
    case "finish": return finishCelebration(state);
    case "interrupt": return interruptCelebration(state);
  }
}

/**
 * Queues achievement cards and plays them one at a time. While `suppressed` (combat, hurt,
 * travel, World Map, death) the queue holds; a card on screen when that starts returns to the
 * front of the queue and replays in full after things settle.
 */
export function useCelebrationQueue(suppressed: boolean): {
  card: CelebrationCard | null;
  enqueue(cards: readonly CelebrationCard[]): void;
} {
  const [state, dispatch] = useReducer(reduce, INITIAL_CELEBRATION_QUEUE);
  const enqueue = useCallback((cards: readonly CelebrationCard[]) => dispatch({ type: "enqueue", cards }), []);
  const waiting = state.current === null && state.queue.length > 0;
  useEffect(() => {
    if (suppressed) {
      dispatch({ type: "interrupt" });
      return;
    }
    if (!waiting) return;
    const timer = window.setTimeout(() => dispatch({ type: "start" }), REGION_CELEBRATION_STAGGER_MS);
    return () => window.clearTimeout(timer);
  }, [suppressed, waiting]);
  const current = state.current;
  useEffect(() => {
    if (!current || suppressed) return;
    const timer = window.setTimeout(() => dispatch({ type: "finish" }), REGION_CELEBRATION_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [current, suppressed]);
  return { card: suppressed ? null : current, enqueue };
}

/**
 * Passive parchment card for a new region's achievement or any other unlock, shown directly
 * below the zone banner. The card is hidden from assistive tech; one polite live region
 * announces each card once.
 */
export function RegionCelebration({
  card,
  preview = false
}: {
  card: CelebrationCard | null;
  /** UI Standards gallery: hold the card still instead of playing the reveal. */
  preview?: boolean;
}) {
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {card ? celebrationAnnouncement(card) : ""}
      </div>
      {card ? (
        <div
          key={card.key}
          className={preview ? "region-celebration region-celebration--preview" : "region-celebration"}
          data-celebration={card.key}
          aria-hidden="true"
        >
          <span className="region-celebration__eyebrow">{card.eyebrow}</span>
          <span className="region-celebration__title">{card.title}</span>
          <span className="region-celebration__rule" />
          {card.points !== null ? <span className="region-celebration__points">+{card.points} points</span> : null}
          {card.honor ? <span className="region-celebration__honor">Honor: {card.honor}</span> : null}
        </div>
      ) : null}
    </>
  );
}
