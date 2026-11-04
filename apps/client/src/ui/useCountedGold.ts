import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

import { lootGoldHold } from "../combat/lootFly.js";

export const GOLD_COUNT_UP_MS = 450;

/** Wallet gold minus coins still in the air, never below zero. Null while the wallet is unknown. */
export function visibleGold(walletGold: string | null, held: number): bigint | null {
  if (walletGold === null) return null;
  const wallet = BigInt(walletGold);
  const hold = BigInt(Math.max(0, Math.floor(held)));
  return wallet > hold ? wallet - hold : 0n;
}

/** Eased value between two amounts at progress 0..1. */
export function interpolateGold(from: bigint, to: bigint, progress: number): bigint {
  const clamped = Math.min(1, Math.max(0, progress));
  const eased = 1 - (1 - clamped) * (1 - clamped);
  return from + ((to - from) * BigInt(Math.round(eased * 1_000))) / 1_000n;
}

/**
 * The gold the counter shows. Coins that have not landed yet are held back; when a coin lands (or
 * the hold lapses) the number counts up to its new value instead of jumping. Decreases and the
 * first value apply at once. Runs in its own small component so only the number re-renders.
 */
export function useCountedGold(walletGold: string | null): bigint | null {
  const revision = useSyncExternalStore(lootGoldHold.subscribe, lootGoldHold.getRevision);
  const [, forceExpiryCheck] = useReducer((count: number) => count + 1, 0);
  const target = visibleGold(walletGold, lootGoldHold.held(performance.now()));
  const [shown, setShown] = useState<bigint | null>(target);
  const shownRef = useRef<bigint | null>(target);

  useEffect(() => {
    const expiry = lootGoldHold.nextExpiryMs();
    if (expiry === null) return;
    const timer = setTimeout(forceExpiryCheck, Math.max(0, expiry - performance.now()) + 20);
    return () => clearTimeout(timer);
  }, [revision, walletGold]);

  useEffect(() => {
    const apply = (value: bigint | null): void => {
      shownRef.current = value;
      setShown(value);
    };
    const from = shownRef.current;
    if (target === null || from === null || target <= from || typeof requestAnimationFrame !== "function") {
      apply(target);
      return;
    }
    const startedAt = performance.now();
    let frameId = 0;
    const step = (now: number): void => {
      const progress = (now - startedAt) / GOLD_COUNT_UP_MS;
      apply(progress >= 1 ? target : interpolateGold(from, target, progress));
      if (progress < 1) frameId = requestAnimationFrame(step);
    };
    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [target]);

  return shown;
}
