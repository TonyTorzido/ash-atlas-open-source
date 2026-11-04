import { createContext, useContext } from "react";

/** Optional host clock; the live game keeps its existing performance clock. */
export const IndoorPresentationClock = createContext<(() => number) | null>(null);
export function useIndoorPresentationClock(): () => number {
  return useContext(IndoorPresentationClock) ?? performanceClock;
}
const performanceClock = (): number => performance.now();
