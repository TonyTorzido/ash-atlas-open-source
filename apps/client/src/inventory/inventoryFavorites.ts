import { useEffect, useState } from "react";

/** Presentation preference, isolated by player and retained on this device. */
export function useInventoryFavorites(playerId: string) {
  const key = `ash-atlas:inventory-favorites:v1:${playerId}`;
  const read = (): string[] => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    } catch { return []; }
  };
  const [state, setState] = useState(() => ({ key, values: read() }));
  useEffect(() => { setState({ key, values: read() }); }, [key]);
  const favorites = new Set(state.key === key ? state.values : []);
  const toggleFavorite = (id: string): void => {
    const next = new Set(state.key === key ? state.values : read());
    if (next.has(id)) next.delete(id); else next.add(id);
    const values = [...next];
    try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* Session still works without storage. */ }
    setState({ key, values });
  };
  const toggleFavorites = (ids: readonly string[]): void => {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return;
    const next = new Set(state.key === key ? state.values : read());
    const shouldFavorite = uniqueIds.some((id) => !next.has(id));
    for (const id of uniqueIds) {
      if (shouldFavorite) next.add(id); else next.delete(id);
    }
    const values = [...next];
    try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* Session still works without storage. */ }
    setState({ key, values });
  };
  /** Adds and removes ids in one write (used for the client-local "pin:" flag next to favourites). */
  const updateFavorites = (add: readonly string[], remove: readonly string[]): void => {
    const next = new Set(state.key === key ? state.values : read());
    for (const id of remove) next.delete(id);
    for (const id of add) next.add(id);
    const values = [...next];
    try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* Session still works without storage. */ }
    setState({ key, values });
  };
  return { favorites, toggleFavorite, toggleFavorites, updateFavorites };
}
