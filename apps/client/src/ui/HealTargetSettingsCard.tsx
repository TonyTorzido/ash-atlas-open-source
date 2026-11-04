import { DEFAULT_HEAL_TARGET_SETTINGS, type HealTargetGroup, type HealTargetSettings } from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { GameAppCard } from "./GameAppShell.js";

/** Loads and saves the player's holy arc heal-target settings (server-side, GET/PATCH /api/profile/me/heal-targets). */
export type HealTargetApi = Readonly<{
  getHealTargets(): Promise<HealTargetSettings>;
  updateHealTargets(update: Partial<HealTargetSettings>): Promise<HealTargetSettings>;
}>;

const GROUPS: ReadonlyArray<readonly [HealTargetGroup, string, string]> = [
  ["party", "Party", "Players in your party."],
  ["friends", "Friends", "Players on your friends list."],
  ["kingdom", "Kingdom", "Members of your kingdom."],
  ["city", "City", "Members of your city."],
  ["neutral", "Everyone else", "Players in none of the groups above. Enemies are never healed."]
];

/**
 * Settings > Gameplay: who a Cleric's holy arc heals. One checkbox per group; an ally in any ticked group is healed.
 * Each change saves at once; a failed save puts the box back and says so.
 */
export function HealTargetSettingsCard({ api }: { api: HealTargetApi }): React.JSX.Element {
  const [settings, setSettings] = useState<HealTargetSettings>(DEFAULT_HEAL_TARGET_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getHealTargets().then((next) => {
      if (cancelled) return;
      setSettings(next);
      setLoaded(true);
    }).catch(() => {
      if (!cancelled) setError("Heal targets could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [api]);

  const change = (group: HealTargetGroup, value: boolean): void => {
    const previous = settings;
    setSettings({ ...settings, [group]: value });
    setError(null);
    api.updateHealTargets({ [group]: value }).then(setSettings).catch(() => {
      setSettings(previous);
      setError("That change was not saved. Try again.");
    });
  };

  return (
    <GameAppCard
      title="Holy arc heals"
      className="phone-map-settings"
      description="Who your scepter's holy arc heals as it passes through them."
    >
      {GROUPS.map(([group, label, detail]) => (
        <label className="developer-tool-toggle" key={group}>
          <span>
            <strong>{label}</strong>
            <small>{detail}</small>
          </span>
          <input
            type="checkbox"
            aria-label={`Heal ${label.toLowerCase()}`}
            checked={settings[group]}
            disabled={!loaded}
            onChange={(event) => change(group, event.currentTarget.checked)}
          />
        </label>
      ))}
      {error ? <small role="status">{error}</small> : null}
    </GameAppCard>
  );
}
