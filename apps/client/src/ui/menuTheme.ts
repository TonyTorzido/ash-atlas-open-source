import { useCallback, useLayoutEffect, useState } from "react";

export type MenuTheme = "light" | "dark";
export const DEFAULT_MENU_THEME: MenuTheme = "light";
const preferenceKey = (playerId: string): string => `ashAtlas.player.${playerId}.menuTheme.v1`;

export function readMenuTheme(playerId: string): MenuTheme {
  try {
    return window.localStorage.getItem(preferenceKey(playerId)) === "dark" ? "dark" : DEFAULT_MENU_THEME;
  } catch { return DEFAULT_MENU_THEME; }
}

export function persistMenuTheme(playerId: string, theme: MenuTheme): void {
  try { window.localStorage.setItem(preferenceKey(playerId), theme); } catch { /* Appearance still works for this session. */ }
}

export function useMenuTheme(playerId: string): readonly [MenuTheme, (theme: MenuTheme) => void] {
  const [theme, setTheme] = useState<MenuTheme>(() => readMenuTheme(playerId));
  useLayoutEffect(() => { setTheme(readMenuTheme(playerId)); }, [playerId]);
  useLayoutEffect(() => { document.documentElement.dataset.menuTheme = theme; }, [theme]);
  const changeTheme = useCallback((next: MenuTheme): void => {
    persistMenuTheme(playerId, next);
    setTheme(next);
  }, [playerId]);
  return [theme, changeTheme] as const;
}
