/**
 * The touch attack button shows only where swings do something: the overworld and
 * dungeon rooms (Cistern Warrens included). Manor, salon and greenhouse have no combat,
 * so the button is hidden there; the stick stays.
 */
export function attackButtonAllowedIn(locationMode: string): boolean {
  return locationMode !== "manor" && locationMode !== "salon" && locationMode !== "greenhouse";
}
