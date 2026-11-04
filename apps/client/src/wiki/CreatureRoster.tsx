import {
  MAX_EQUIPMENT_LEVEL,
  equalLevelSwordSwings,
  mobChallengeTier,
  resolveMatchupDamage,
  type WikiRosterCreature
} from "@ash-atlas/shared";
import { useState, type ReactNode } from "react";

import { WikiArt } from "./wikiArt.js";

type Creature = WikiRosterCreature;
const DEFAULT_LEVEL = 10;
const TIER_LABELS = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary" } as const;
const BOOK_ORDER: Readonly<Record<string, number>> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

/** The level a creature fights at: its own fixed level for bosses, otherwise the chosen level. */
function creatureLevel(creature: Creature, level: number): number {
  return creature.fixedLevel ?? level;
}

/** One hit on an unarmored player (bare skin defends at level 1), through the shared table. */
function hitOnBareSkin(creature: Creature, level: number): number {
  return resolveMatchupDamage({
    weaponType: creature.weaponTypeId,
    armorType: "unarmored",
    attackerLevel: creatureLevel(creature, level),
    defenderLevel: 1,
    multiplier: creature.damageMultiplier
  }).finalDamage;
}

function multiplierNote(multiplier: number): string | null {
  if (multiplier === 1) return null;
  if (multiplier === 0) return "Venom does the damage";
  return `Hits ×${multiplier}`;
}

export function CreatureRoster({ creatures }: { creatures: readonly WikiRosterCreature[] }): ReactNode {
  const [level, setLevel] = useState(DEFAULT_LEVEL);
  const roster = [...creatures].sort((left, right) =>
    (BOOK_ORDER[left.bookRarity] ?? 0) - (BOOK_ORDER[right.bookRarity] ?? 0) || left.name.localeCompare(right.name));
  return <div className="wiki-roster">
    <div className="wiki-roster-controls">
      <div className="wiki-mx-stepper" role="group" aria-label="Creature level">
        <span>Level</span>
        <button type="button" aria-label="Lower creature level" disabled={level <= 0} onClick={() => setLevel(level - 1)}>−</button>
        <output aria-live="polite" aria-label="Creature level">{level}</output>
        <button type="button" aria-label="Raise creature level" disabled={level >= MAX_EQUIPMENT_LEVEL} onClick={() => setLevel(level + 1)}>+</button>
      </div>
      <p>Most creatures match the level of the adventurers nearby. Bosses always fight at their own level.</p>
    </div>
    <div className="wiki-table-wrap"><table className="wiki-table wiki-roster-table">
      <caption className="wiki-visually-hidden">Creatures at level {level}</caption>
      <thead><tr>
        <th>Creature</th><th>Weapon · Armor</th><th>Tier</th><th className="wiki-num">Level</th>
        <th className="wiki-num">Health</th><th className="wiki-num">Sword hits</th><th className="wiki-num">Hits bare skin</th>
      </tr></thead>
      <tbody>{roster.map((creature) => {
        const fightLevel = creatureLevel(creature, level);
        const tier = mobChallengeTier(fightLevel);
        const note = multiplierNote(creature.damageMultiplier);
        return <tr key={creature.key} data-accent={tier} data-testid={`creature-${creature.key}`}>
          <td><a className="wiki-entity" href={`/wiki/character/matchups#monster=${creature.key}`}>
            <WikiArt kind="monster" id={creature.key} name={creature.name} />
            <span>{creature.name}{note ? <small className="wiki-roster-note">{note}</small> : null}</span>
          </a></td>
          <td className="wiki-roster-gear">{creature.weaponName} ({creature.weaponType}) · {creature.armorName} ({creature.armorType})</td>
          <td><span className={`wiki-rarity wiki-rarity-${tier}`}>{TIER_LABELS[tier]}</span></td>
          <td className="wiki-num">{fightLevel}{creature.fixedLevel !== null ? <small className="wiki-roster-fixed"> fixed</small> : null}</td>
          <td className="wiki-num">{creature.maxHealth.toLocaleString()}</td>
          <td className="wiki-num">{equalLevelSwordSwings(creature.maxHealth, creature.armorTypeId)}</td>
          <td className="wiki-num" data-testid={`creature-${creature.key}-hit`}>{hitOnBareSkin(creature, level)}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </div>;
}
