import {
  MAX_EQUIPMENT_LEVEL,
  MATCHUP_STRONG_AT,
  MATCHUP_WEAK_AT,
  PVP_RAW_MATRIX_V3,
  matchupTone,
  resolveMatchupDamage,
  type MatchupArmorType,
  type MatchupTone,
  type MatchupWeaponType,
  type WikiMatchupData
} from "@ash-atlas/shared";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { WikiArt } from "./wikiArt.js";

type Mode = "monster" | "weapon" | "armor";
type Matchups = WikiMatchupData;
type Monster = Matchups["monsters"][number];
type Weapon = Matchups["weapons"][number];
type Armor = Matchups["armors"][number];
type Selection = Readonly<{ mode: Mode; id: string }>;
type MonsterFilter = "all" | "creatures" | "bosses";

const MODES: readonly { id: Mode; label: string; noun: string }[] = [
  { id: "monster", label: "I'm fighting", noun: "monster" },
  { id: "weapon", label: "I'm holding", noun: "weapon" },
  { id: "armor", label: "I'm wearing", noun: "armor" }
];
const DEFAULT_LEVEL = 10;
const DEFAULT_SELECTION: Selection = { mode: "monster", id: "wolf" };
const TONE_LABELS: Readonly<Record<MatchupTone, string>> = { strong: "Strong", standard: "Standard", weak: "Weak" };
const TONES: readonly MatchupTone[] = ["strong", "standard", "weak"];

/** The matchup tables arrive from the signed-in wiki API with the article, not from the bundle. */
type IndexedMatchups = Matchups & Readonly<{
  monstersByKey: ReadonlyMap<string, Monster>;
  weaponsById: ReadonlyMap<string, Weapon>;
  monsterWeaponTypes: readonly MatchupWeaponType[];
}>;
function indexMatchups(matchups: Matchups): IndexedMatchups {
  return {
    ...matchups,
    monstersByKey: new Map(matchups.monsters.map((monster) => [monster.key, monster])),
    weaponsById: new Map(matchups.weapons.map((weapon) => [weapon.id, weapon])),
    monsterWeaponTypes: [...new Set(matchups.monsters.map((monster) => monster.weaponTypeId))]
  };
}
const MatchupsContext = createContext<IndexedMatchups>(indexMatchups({ armors: [], weapons: [], monsters: [] }));
const useMatchups = (): IndexedMatchups => useContext(MatchupsContext);

function isKnown(matchups: Matchups, selection: Selection): boolean {
  if (selection.mode === "monster") return matchups.monsters.some((monster) => monster.key === selection.id);
  if (selection.mode === "weapon") return matchups.weapons.some((weapon) => weapon.id === selection.id);
  return matchups.armors.some((armor) => armor.id === selection.id);
}

/** Reads `#monster=wolf`, `#weapon=sword`, or `#armor=leather`. */
export function matchupSelectionFromHash(matchups: Matchups, hash: string): Selection | null {
  const match = /^#(monster|weapon|armor)=([a-z_]+)$/.exec(hash);
  if (!match) return null;
  const selection: Selection = { mode: match[1] as Mode, id: match[2]! };
  return isKnown(matchups, selection) ? selection : null;
}

/** Damage a player deals: weapon item level vs the target's armor level (bare hands are level 0). */
function damageDealt(weapon: MatchupWeaponType, armor: MatchupArmorType, yourLevel: number, theirLevel: number): number {
  return resolveMatchupDamage({
    weaponType: weapon,
    armorType: armor,
    attackerLevel: weapon === "unarmed" ? 0 : yourLevel,
    defenderLevel: theirLevel
  }).finalDamage;
}

/** Damage a player takes: monster level vs armor item level (bare skin defends at level 1). */
function damageTaken(weapon: MatchupWeaponType, armor: MatchupArmorType, theirLevel: number, yourLevel: number, multiplier = 1): number {
  return resolveMatchupDamage({
    weaponType: weapon,
    armorType: armor,
    attackerLevel: theirLevel,
    defenderLevel: armor === "unarmored" ? 1 : yourLevel,
    multiplier
  }).finalDamage;
}

/** Wearing tone: armor that takes little damage is the strong choice. */
function wearTone(rawValue: number): MatchupTone {
  const tone = matchupTone(rawValue);
  return tone === "strong" ? "weak" : tone === "weak" ? "strong" : "standard";
}

function Art({ kind, id, name, typeId }: { kind: "monster" | "item"; id: string | null; name: string; typeId?: string }): ReactNode {
  return <WikiArt kind={kind} id={id} name={name} className="wiki-mx-art" {...(typeId ? { typeId } : {})} />;
}

function multiplierNote(multiplier: number): string | null {
  if (multiplier === 1) return null;
  if (multiplier === 0) return "Token hit; its venom does the damage";
  return `Hits ×${multiplier}`;
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

type RankedEntry = Readonly<{ id: string; name: string; value: number; tone: MatchupTone; art: ReactNode; onSelect?: () => void }>;

function RankedGroups({ title, hint, entries, testId }: { title: string; hint: string; entries: readonly RankedEntry[]; testId: string }): ReactNode {
  return <section className="wiki-mx-ranking" data-testid={testId} aria-label={title}>
    <header><h3>{title}</h3><p>{hint}</p></header>
    <div className="wiki-mx-groups">{TONES.map((tone) => {
      const members = entries.filter((entry) => entry.tone === tone);
      return <div className={`wiki-mx-group wiki-mx-group-${tone}`} key={tone}>
        <h4>{TONE_LABELS[tone]}</h4>
        {members.length ? <ul>{members.map((entry) => <li key={entry.id}>
          {entry.onSelect
            ? <button type="button" className="wiki-mx-row" onClick={entry.onSelect}>{entry.art}<span>{entry.name}</span><strong>{entry.value}</strong></button>
            : <span className="wiki-mx-row">{entry.art}<span>{entry.name}</span><strong>{entry.value}</strong></span>}
        </li>)}</ul> : <p className="wiki-mx-empty">None</p>}
      </div>;
    })}</div>
  </section>;
}

function LevelStepper({ label, value, onChange }: { label: string; value: number; onChange(next: number): void }): ReactNode {
  return <div className="wiki-mx-stepper" role="group" aria-label={`${label} level`}>
    <span>{label}</span>
    <button type="button" aria-label={`Lower ${label.toLowerCase()} level`} disabled={value <= 0} onClick={() => onChange(value - 1)}>−</button>
    <output aria-live="polite" aria-label={`${label} level`}>{value}</output>
    <button type="button" aria-label={`Raise ${label.toLowerCase()} level`} disabled={value >= MAX_EQUIPMENT_LEVEL} onClick={() => onChange(value + 1)}>+</button>
  </div>;
}

export function MatchupGrid({ showUpcoming }: { showUpcoming: boolean }): ReactNode {
  const { armors, weapons } = useMatchups();
  return <div className="wiki-table-wrap wiki-matchup-wrap">
    <table className="wiki-table wiki-matchup-grid">
      <caption>Equal-level hit by weapon (rows) into armor (columns)</caption>
      <thead><tr><th scope="col">Weapon</th>{armors.map((armor) => <th scope="col" key={armor.id}>{armor.name}</th>)}</tr></thead>
      <tbody>{weapons.filter((weapon) => showUpcoming || weapon.inGame).map((weapon) => <tr key={weapon.id}>
        <th scope="row">{weapon.name}</th>
        {weapon.values.map((value, index) => {
          const tone = matchupTone(value);
          const toneLabel = tone === "standard" ? "" : `, ${tone}`;
          return <td key={armors[index]!.id} className={tone === "standard" ? undefined : `wiki-matchup-${tone}`}
            aria-label={`${weapon.name} into ${armors[index]!.name}: ${value}${toneLabel}`}>{value}</td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}

export function MatchupExplorer({ matchups }: { matchups: Matchups }): ReactNode {
  const indexed = useMemo(() => indexMatchups(matchups), [matchups]);
  return <MatchupsContext.Provider value={indexed}><MatchupExplorerBody /></MatchupsContext.Provider>;
}

function MatchupExplorerBody(): ReactNode {
  const matchups = useMatchups();
  const [selection, setSelection] = useState<Selection>(() =>
    (typeof window === "undefined" ? null : matchupSelectionFromHash(matchups, window.location.hash)) ?? DEFAULT_SELECTION);
  const [lastByMode, setLastByMode] = useState<Readonly<Record<Mode, string>>>({ monster: "wolf", weapon: "sword", armor: "leather" });
  const [yourLevel, setYourLevel] = useState(DEFAULT_LEVEL);
  const [theirLevel, setTheirLevel] = useState(DEFAULT_LEVEL);
  const [showUpcoming, setShowUpcoming] = useState(false);
  const [filter, setFilter] = useState<MonsterFilter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const sync = () => {
      const next = matchupSelectionFromHash(matchups, window.location.hash);
      if (next) setSelection(next);
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  useEffect(() => {
    setLastByMode((previous) => previous[selection.mode] === selection.id ? previous : { ...previous, [selection.mode]: selection.id });
  }, [selection]);

  const detailRef = useRef<HTMLDivElement>(null);
  function select(next: Selection, reveal = false): void {
    setSelection(next);
    // Picking a card below the detail brings the answer back into view.
    if (reveal) detailRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    const hash = `#${next.mode}=${next.id}`;
    if (window.location.hash !== hash) window.history.pushState(window.history.state, "", hash);
  }

  const visibleWeapons = matchups.weapons.filter((weapon) => showUpcoming || weapon.inGame);
  const needle = query.trim().toLocaleLowerCase();
  const pickerCards = (() => {
    if (selection.mode === "monster") {
      return matchups.monsters
        .filter((monster) => filter === "all" || (filter === "bosses") === monster.boss)
        .filter((monster) => !needle || `${monster.name} ${monster.weaponName} ${monster.armorName} ${monster.weaponType} ${monster.armorType}`.toLocaleLowerCase().includes(needle))
        .map((monster) => ({ id: monster.key, name: monster.name, art: <Art kind="monster" id={monster.key} name={monster.name} /> }));
    }
    const entries = selection.mode === "weapon" ? visibleWeapons : matchups.armors;
    return entries
      .filter((entry) => !needle || entry.name.toLocaleLowerCase().includes(needle))
      .map((entry) => ({ id: entry.id, name: entry.name, art: <Art kind="item" id={entry.artItemId} name={entry.name} typeId={entry.id} /> }));
  })();

  const noun = MODES.find((mode) => mode.id === selection.mode)!.noun;
  return <div className="wiki-mx">
    <div className="wiki-mx-modes" role="group" aria-label="Explore matchups by">
      {MODES.map((mode) => <button type="button" key={mode.id} aria-pressed={selection.mode === mode.id}
        onClick={() => select({ mode: mode.id, id: lastByMode[mode.id] })}>{mode.label}…</button>)}
    </div>

    <div className="wiki-mx-controls">
      <LevelStepper label="You" value={yourLevel} onChange={setYourLevel} />
      <LevelStepper label="Them" value={theirLevel} onChange={setTheirLevel} />
      <label className="wiki-mx-toggle"><input type="checkbox" checked={showUpcoming} onChange={(event) => setShowUpcoming(event.currentTarget.checked)} />Show upcoming weapons</label>
    </div>
    <p className="wiki-matchup-legend">+1 per level your weapon is above their armor, −1 below, minimum 1. Bare hands count as level 0 and bare skin as level 1. <span className="wiki-matchup-key wiki-matchup-strong">strong</span> ≥ {MATCHUP_STRONG_AT} · <span className="wiki-matchup-key wiki-matchup-weak">weak</span> ≤ {MATCHUP_WEAK_AT} at equal level.</p>

    <div className="wiki-mx-detail" aria-live="polite" ref={detailRef}>
      {selection.mode === "monster"
        ? <MonsterDetail monster={matchups.monstersByKey.get(selection.id)!} weapons={visibleWeapons} yourLevel={yourLevel} theirLevel={theirLevel} />
        : selection.mode === "weapon"
          ? <WeaponDetail weapon={matchups.weaponsById.get(selection.id)!} yourLevel={yourLevel} theirLevel={theirLevel} onMonster={(key) => select({ mode: "monster", id: key }, true)} />
          : <ArmorDetail armor={matchups.armors.find((armor) => armor.id === selection.id)!} yourLevel={yourLevel} theirLevel={theirLevel} onMonster={(key) => select({ mode: "monster", id: key }, true)} />}
    </div>

    <div className="wiki-mx-picker">
      <div className="wiki-mx-picker-bar">
        <label className="wiki-mx-search"><span>Choose another {noun}</span><input type="search" value={query} placeholder={`Search ${noun}s`} onChange={(event) => setQuery(event.currentTarget.value)} /></label>
        {selection.mode === "monster" ? <div className="wiki-mx-chips" role="group" aria-label="Filter monsters">
          {(["all", "creatures", "bosses"] as const).map((chip) => <button type="button" key={chip} aria-pressed={filter === chip} onClick={() => setFilter(chip)}>{chip === "all" ? "All" : chip === "creatures" ? "Creatures" : "Bosses"}</button>)}
        </div> : null}
      </div>
      {pickerCards.length
        ? <div className="wiki-mx-cards" role="group" aria-label={`Choose a ${noun}`}>{pickerCards.map((card) =>
          <button type="button" key={card.id} className="wiki-mx-card" aria-pressed={selection.id === card.id}
            onClick={() => select({ mode: selection.mode, id: card.id }, true)}>{card.art}<span>{card.name}</span></button>)}</div>
        : <p className="wiki-mx-empty">No {noun}s match that search.</p>}
    </div>

    <details className="wiki-mx-full">
      <summary>Full table</summary>
      <MatchupGrid showUpcoming={showUpcoming} />
      <p>A shield adds its own column: a shielded defender takes the lower of the armor and shield results.</p>
    </details>
  </div>;
}

function MonsterDetail({ monster, weapons, yourLevel, theirLevel }: { monster: Monster; weapons: readonly Weapon[]; yourLevel: number; theirLevel: number }): ReactNode {
  const matchups = useMatchups();
  const bring: RankedEntry[] = weapons
    .map((weapon) => ({
      id: weapon.id,
      name: weapon.name,
      value: damageDealt(weapon.id, monster.armorTypeId, yourLevel, theirLevel),
      tone: matchupTone(PVP_RAW_MATRIX_V3[weapon.id][monster.armorTypeId]),
      art: <Art kind="item" id={weapon.artItemId} name={weapon.name} typeId={weapon.id} />
    }))
    .sort((left, right) => right.value - left.value);
  const wear: RankedEntry[] = matchups.armors
    .map((armor) => ({
      id: armor.id,
      name: armor.name,
      value: damageTaken(monster.weaponTypeId, armor.id, theirLevel, yourLevel, monster.damageMultiplier),
      tone: wearTone(PVP_RAW_MATRIX_V3[monster.weaponTypeId][armor.id]),
      art: <Art kind="item" id={armor.artItemId} name={armor.name} typeId={armor.id} />
    }))
    .sort((left, right) => left.value - right.value);
  const strong = bring.filter((entry) => entry.tone === "strong").map((entry) => entry.name);
  const weak = bring.filter((entry) => entry.tone === "weak").map((entry) => entry.name);
  const armorLabel = `${monster.armorName} (${monster.armorType})`;
  const opening = strong.length
    ? `${armorLabel} gives way to ${list(strong)}`
    : `No weapon is strong into ${armorLabel}; ${bring[0]?.name ?? "nothing"} hits it hardest`;
  const reason = `${opening}${weak.length ? `, and it shrugs off ${list(weak)}.` : "."}`;
  const note = multiplierNote(monster.damageMultiplier);
  return <>
    <header className="wiki-mx-hero">
      <Art kind="monster" id={monster.key} name={monster.name} />
      <div>
        <h2>{monster.name}</h2>
        <p>{monster.weaponName} ({monster.weaponType}) · {monster.armorName} ({monster.armorType})</p>
        {note ? <span className="wiki-mx-badge">{note}</span> : null}
      </div>
    </header>
    <p className="wiki-mx-reason">{reason}</p>
    <div className="wiki-mx-split">
      <RankedGroups testId="matchup-bring" title="Bring" hint={`Your damage per hit into its ${monster.armorType}`} entries={bring} />
      <RankedGroups testId="matchup-wear" title="Wear" hint={`Damage you take from its ${monster.weaponType}; lower is better`} entries={wear} />
    </div>
  </>;
}

function MonsterCards({ title, monsters, value, onMonster }: { title: string; monsters: readonly Monster[]; value(monster: Monster): number; onMonster(key: string): void }): ReactNode {
  return <section className="wiki-mx-monsters" aria-label={title}>
    <h3>{title}</h3>
    {monsters.length
      ? <div className="wiki-mx-cards">{monsters.map((monster) => <button type="button" key={monster.key} className="wiki-mx-card" onClick={() => onMonster(monster.key)}>
        <Art kind="monster" id={monster.key} name={monster.name} /><span>{monster.name}</span><strong>{value(monster)}</strong>
      </button>)}</div>
      : <p className="wiki-mx-empty">None</p>}
  </section>;
}

function WeaponDetail({ weapon, yourLevel, theirLevel, onMonster }: { weapon: Weapon; yourLevel: number; theirLevel: number; onMonster(key: string): void }): ReactNode {
  const matchups = useMatchups();
  const armors: RankedEntry[] = matchups.armors
    .map((armor, index) => ({
      id: armor.id,
      name: armor.name,
      value: damageDealt(weapon.id, armor.id, yourLevel, theirLevel),
      tone: matchupTone(weapon.values[index]!),
      art: <Art kind="item" id={armor.artItemId} name={armor.name} typeId={armor.id} />
    }))
    .sort((left, right) => right.value - left.value);
  const toneInto = (monster: Monster) => matchupTone(PVP_RAW_MATRIX_V3[weapon.id][monster.armorTypeId]);
  const dealt = (monster: Monster) => damageDealt(weapon.id, monster.armorTypeId, yourLevel, theirLevel);
  return <>
    <header className="wiki-mx-hero">
      <Art kind="item" id={weapon.artItemId} name={weapon.name} typeId={weapon.id} />
      <div><h2>{weapon.name}</h2><p>{weapon.inGame ? "In game today" : "Upcoming weapon"}</p></div>
    </header>
    <RankedGroups testId="matchup-weapon-armor" title="Into armor" hint="Your damage per hit into each armor type" entries={armors} />
    <div className="wiki-mx-split">
      <MonsterCards title="Strong against" monsters={matchups.monsters.filter((monster) => toneInto(monster) === "strong")} value={dealt} onMonster={onMonster} />
      <MonsterCards title="Weak against" monsters={matchups.monsters.filter((monster) => toneInto(monster) === "weak")} value={dealt} onMonster={onMonster} />
    </div>
  </>;
}

function ArmorDetail({ armor, yourLevel, theirLevel, onMonster }: { armor: Armor; yourLevel: number; theirLevel: number; onMonster(key: string): void }): ReactNode {
  const matchups = useMatchups();
  const weapons: RankedEntry[] = matchups.monsterWeaponTypes
    .map((type) => {
      const weapon = matchups.weaponsById.get(type)!;
      return {
        id: type,
        name: weapon.name,
        value: damageTaken(type, armor.id, theirLevel, yourLevel),
        tone: wearTone(PVP_RAW_MATRIX_V3[type][armor.id]),
        art: <Art kind="item" id={weapon.artItemId} name={weapon.name} typeId={weapon.id} />
      };
    })
    .sort((left, right) => left.value - right.value);
  const rawFrom = (monster: Monster) => PVP_RAW_MATRIX_V3[monster.weaponTypeId][armor.id];
  const taken = (monster: Monster) => damageTaken(monster.weaponTypeId, armor.id, theirLevel, yourLevel, monster.damageMultiplier);
  return <>
    <header className="wiki-mx-hero">
      <Art kind="item" id={armor.artItemId} name={armor.name} typeId={armor.id} />
      <div><h2>{armor.name}</h2><p>{armor.shield ? "Shield: you take the lower of your armor and this column" : "Body armor"}</p></div>
    </header>
    <RankedGroups testId="matchup-armor-weapons" title="Against monster weapons" hint="Damage you take per hit; lower is better" entries={weapons} />
    <div className="wiki-mx-split">
      <MonsterCards title="Hit it hard" monsters={matchups.monsters.filter((monster) => matchupTone(rawFrom(monster)) === "strong")} value={taken} onMonster={onMonster} />
      <MonsterCards title="Barely scratch it" monsters={matchups.monsters.filter((monster) => matchupTone(rawFrom(monster)) === "weak")} value={taken} onMonster={onMonster} />
    </div>
  </>;
}
