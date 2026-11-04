/** @jsx h */
/** @jsxFrag Fragment */
import { DUNGEON_SKILL_TURN_INS, EQUIPMENT_CRAFT_RECIPES, EQUIPMENT_SWAG_CRAFT_RECIPES, GENERAL_SKILL_DEFINITIONS, GENERAL_SKILL_IDS, LAUNCH_SPECIALIZATION_IDS, isGeneralSkillAvailable, WORLD_KNOWLEDGE_OVERWORLD_PARTS, WORLD_KNOWLEDGE_SKILL_DEFINITIONS, offeringSummary, type UnlockOfferingPart, SPECIALIZATION_DEFINITIONS, formatWeightKg, getItemWeightGrams, type WikiBuiltInCategory, type WikiBuiltInCategoryId, type WikiContentNode } from "@ash-atlas/shared";

import { GENERATED_WIKI_DATA as data } from "./generatedWikiData.js";
// The JSX pragmas above reference these; eslint cannot see pragma usage.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Fragment, h, type Child } from "./jsx.js";

export type WikiCategoryId = WikiBuiltInCategoryId;
/** Provenance stays in code and tests; it is never sent to players. */
export type WikiSourceType = "curated" | "generated" | "hybrid";
export type WikiArticle = {
  slug: string;
  title: string;
  summary: string;
  category: WikiCategoryId;
  sourceType: WikiSourceType;
  sourcePath: string;
  tags: readonly string[];
  content: () => WikiContentNode;
};

export const WIKI_CATEGORIES: readonly WikiBuiltInCategory[] = [
  { id: "getting-started", label: "Getting started", description: "Controls, menus, and your first steps." },
  { id: "character", label: "Character", description: "Combat, matchups, levels, gear, and your pack." },
  { id: "world", label: "World", description: "Travel, time, creatures, and gathering." },
  { id: "activities", label: "Activities", description: "Smelting, trading, and delving into dungeons." },
  { id: "kingdoms", label: "Kingdoms", description: "Roles, growth, and shared territory." },
  { id: "items", label: "Items", description: "Every item, its rarity, weight, and tradability." }
];

// Interactive pieces stay named client components; the client supplies their behavior and art.
const WikiLink = "WikiLink";
const WikiArt = "WikiArt";
const CreatureRoster = "CreatureRoster";
const MatchupExplorer = "MatchupExplorer";

function Note({ title, children, tone = "tip" }: { title: string; children: Child; tone?: "tip" | "warning" }): WikiContentNode {
  return <aside className={`wiki-callout wiki-callout-${tone}`}><strong>{title}</strong><div>{children}</div></aside>;
}

type Cell = Child;
function Table({ headers, rows, accents, numeric = [] }: {
  headers: readonly string[];
  rows: readonly (readonly Cell[])[];
  /** Rarity or category per row, drawn as an edge stripe. */
  accents?: readonly (string | null)[];
  /** Column indexes that hold numbers (right-aligned, tabular). */
  numeric?: readonly number[];
}): WikiContentNode {
  return <div className="wiki-table-wrap"><table className="wiki-table">
    <thead><tr>{headers.map((header, index) => <th className={numeric.includes(index) ? "wiki-num" : undefined}>{header}</th>)}</tr></thead>
    <tbody>{rows.map((row, rowIndex) => <tr data-accent={accents?.[rowIndex] ?? undefined}>
      {row.map((cell, cellIndex) => <td className={numeric.includes(cellIndex) ? "wiki-num" : undefined}>{cell}</td>)}
    </tr>)}</tbody>
  </table></div>;
}

function Rarity({ value }: { value: string }): WikiContentNode {
  return <span className={`wiki-rarity wiki-rarity-${value}`}>{value}</span>;
}

function Bullets({ children }: { children: Child }): WikiContentNode { return <ul className="wiki-checklist">{children}</ul>; }

const controls: WikiArticle = {
  slug: "getting-started/controls",
  title: "Controls & How to Play",
  summary: "Moving, targeting, menus, combat, and touch controls in one quick reference.",
  category: "getting-started",
  sourceType: "hybrid",
  sourcePath: "apps/client/src/map + apps/client/src/ui + apps/client/src/App.tsx",
  tags: ["controls", "mouse", "touch", "map", "targeting", "menu", "inventory", "hud"],
  content: () => <>
    <p>Keep this page open while you play. Mouse, touch, and pen all move and select the same way; the main difference is how you confirm a target.</p>
    <Note title="Start here"><WikiLink slug="getting-started/first-steps">First steps in the world</WikiLink> walks through the core loop: move, select something, read the action prompt, then confirm.</Note>
    <h2>Move and read the map</h2>
    <Table headers={["Input", "What it does"]} rows={[
      ["Double-click the map", "Walk to that spot. A single click waits a moment to see whether a second click follows."],
      ["Press and hold the map", "Precision movement: keep holding and drag to aim, then release to go. The map stops panning and zooming while you hold."],
      ["Drag the map", "Pan the view."],
      ["Mouse wheel or pinch", "Zoom in and out. The map never rotates."],
      ["Phone: two-finger hold", "Hold two fingers still for about 600 ms to use a Giving Berry when one is available. The hold never counts as a map tap."],
      ["Phone: two-finger double-tap", "Snap back to your saved phone zoom."],
    ]} />
    <Note title="Moving is not acting" tone="warning">Tapping the map only chooses where to walk. Tapping a creature, player, resource, station, building, or entrance selects it first; its action prompt is where you act.</Note>
    <h2>Select and target</h2>
    <p>Tap or click anything in the world to select it. When several things overlap, <strong>Choose Target</strong> opens so you can pick the right one. Choosing a target never starts an action by itself.</p>
    <Bullets>
      <li>Tap or click a row to choose it. The focused row is highlighted.</li>
      <li>If your finger slides past a small distance, or you release over a different row, nothing is chosen and the picker stays open.</li>
      <li>A cancelled touch does nothing. Releasing outside the picker closes it without touching the world beneath.</li>
      <li>Choose <strong>Cancel</strong> or press <strong>Escape</strong> to close the picker.</li>
    </Bullets>
    <p>On phones, Tap assistance widens how close a tap must land. Pick Precise (6 px), Standard (12 px, the default), or Large (20 px); larger settings make <strong>Choose Target</strong> appear more often in busy scenes.</p>
    <h2>HUD and menus</h2>
    <p>On phones the HUD keeps your status and the two places you visit most within thumb reach: the center button opens the Game Menu and the right-hand coin button opens Inventory. The left side shows your health, your class resource when you have one, and your experience.</p>
    <Table headers={["Where", "What you'll find"]} rows={[
      ["Phone Game Menu", "Adventurer (Profile, Character, Pets); Inventory; Progression (Skills & Professions, Achievements); Encyclopedia (Beasts & Plants); Social (Messages, Party); Realm (World Map, City, Kingdom); Holdings (Build, Flags, Tolls); Rankings; Notice Board (Announcements, Patch Notes, Report a Bug, Support & Credits)."],
      ["Desktop Actions drawer", "World/Recenter, Character/Profile/Character/Inventory, Skills & Professions, Pets, Leaderboards, Realm Flags/Kingdom, Economy Market/Tolls."],
      ["Desktop account menu", "Profile, Travel Inbox, Messages, Pet, World Map, Party, Test Access, flag color, and Sign out."],
    ]} />
    <h2>Keyboard shortcuts</h2>
    <Table headers={["Key", "Action"]} rows={[
      ["I", "Open or close Inventory when it's available."],
      ["M", "Open or close the Market when it's available."],
      ["F", "Start placing a flag when you're allowed to build one."],
      ["Escape", "Close the market or an open panel, or back out of the current selection or targeting."],
      ["Q / W / E", "Use the matching combat skill when your class shows those slots. Each skill still needs the right target and weapon."],
    ]} />
    <Note title="No secret keys">If a control isn't listed here, follow the label or prompt on screen rather than hunting for a hidden shortcut.</Note>
  </>
};

const firstSteps: WikiArticle = {
  slug: "getting-started/first-steps",
  title: "First Steps in the World",
  summary: "A simple loop for learning any new area without guesswork.",
  category: "getting-started",
  sourceType: "curated",
  sourcePath: "apps/client/src/App.tsx; apps/client/src/ui/GameActionPrompt.tsx",
  tags: ["new player", "movement", "actions", "hud"],
  content: () => <>
    <ol className="wiki-steps">
      <li><strong>Find your bearings.</strong> Spot yourself on the map, then move with a double-click or a precision hold. <WikiLink slug="world/world-map">World Map</WikiLink> covers long journeys.</li>
      <li><strong>Select something.</strong> Tap or click a creature, resource, station, building, or entrance. In a crowd, pick the right row.</li>
      <li><strong>Read before you confirm.</strong> The action prompt names what you selected and what you're about to do. Confirm when the range, target, and cost look right.</li>
      <li><strong>Check your gear.</strong> Inventory shows your resources and equipment; Character shows your equipment slots and combat stats.</li>
      <li><strong>Get back up.</strong> If you fall, follow the respawn prompt. <WikiLink slug="character/death-and-respawning">Death and respawning</WikiLink> explains what you'll see.</li>
    </ol>
    <Note title="One useful habit">When an action is greyed out, read the reason it gives instead of trying again. World actions, travel, crafting, and entrances all use the same prompt.</Note>
  </>
};

const hud: WikiArticle = {
  slug: "getting-started/hud-and-menus",
  title: "HUD, Menus, and Panels",
  summary: "Where your everyday tools live on phone and desktop.",
  category: "getting-started",
  sourceType: "curated",
  sourcePath: "apps/client/src/ui/PhoneHud.tsx; apps/client/src/ui/BottomActionBar.tsx; apps/client/src/ui/TopBar.tsx",
  tags: ["hud", "inventory", "menu", "desktop", "phone"],
  content: () => <>
    <p>Phone and desktop lay things out differently, but everything is in both. On phones the Game Menu groups places by what you want to do; on desktop the Actions drawer and account menu hold the same screens with roomier labels.</p>
    <h2>Phone categories</h2>
    <Table headers={["Category", "Destinations"]} rows={[
      ["Adventurer", "Profile, Character, Pets"], ["Progression", "Skills & Professions, Achievements"], ["Social", "Messages, Party"],
      ["Realm", "World Map, City, Kingdom"], ["Holdings", "Build, Flags, Tolls"], ["Notice Board", "Announcements, Patch Notes, Report a Bug, Support & Credits"],
      ["Main menu", "Inventory, Encyclopedia, Rankings, plus the categories above"]
    ]} />
    <h2>Panels change what your next tap does</h2>
    <p>An open panel takes over from the map. Inventory and Character are for checking and acting on your gear; World Map is for choosing a destination; the target picker and action prompt are where you confirm. Close them with their close or back button, or Escape where it works, to return to the map.</p>
  </>
};

const characterOverview: WikiArticle = {
  slug: "character/levels-and-experience",
  title: "Levels, Experience, and Health",
  summary: "How your character levels up, and how that differs from class mastery.",
  category: "character",
  sourceType: "generated",
  sourcePath: "packages/shared/src/progression.ts",
  tags: ["level", "experience", "xp", "health", "progression"],
  content: () => <>
    <p>Your character climbs from level 0 to level <strong>{data.progress.levelCap}</strong>, and each level asks for a little more experience than the last.</p>
    <Table numeric={[1]} headers={["Milestone", "Value"]} rows={[
      ["Base maximum health", `${data.progress.baseMaxHealth} before class or other bonuses`],
      ["Level cap", String(data.progress.levelCap)],
      ["Level 1 total XP", `${data.progress.xpByLevel["1"]?.toLocaleString("en-US")} XP`],
      ["Level 10 total XP", `${data.progress.xpByLevel["10"]?.toLocaleString("en-US")} XP`],
      [`Level ${data.progress.levelCap} total XP`, `${data.progress.xpByLevel[String(data.progress.levelCap) as keyof typeof data.progress.xpByLevel]?.toLocaleString("en-US")} XP`],
    ]} />
    <p>Character XP and class or profession progress are separate tracks. Levels make you stronger in a fight, but not every level raises your ordinary maximum health. See <WikiLink slug="character/classes">Classes and skills</WikiLink> for the class side.</p>
  </>
};

/** Creatures whose drop tables list the item (from the generated Creature Book data). */
function droppedBy(itemId: string): string {
  const names = [...new Set(data.creatures
    .filter((creature) => creature.rewards.some((reward) => reward.startsWith(`${itemId} \u00d7`)))
    .map((creature) => creature.name))];
  if (names.length === 0) return "Elite and world bosses";
  return names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ");
}

function partSources(parts: readonly UnlockOfferingPart[]): string {
  return parts.map((part) => part.kind === "distinct_items"
    ? `${part.count} ${part.label} (${part.itemIds.map((itemId) => `${data.items.find((item) => item.id === itemId)?.name ?? itemId}: ${droppedBy(itemId)}`).join("; ")})`
    : part.kind === "item" ? `${part.quantity} ${data.items.find((item) => item.id === part.itemId)?.name ?? part.itemId}: ${droppedBy(part.itemId)}` : `${part.quantity} ${part.label}: elite and world bosses`).join("; ");
}

const classes: WikiArticle = {
  slug: "character/classes",
  title: "Classes and Skills",
  summary: "The classes you can play today and how their skills unlock.",
  category: "character",
  sourceType: "generated",
  sourcePath: "packages/shared/src/classes.ts; packages/shared/src/skillSystemV3.ts",
  tags: ["class", "skills", "combat"],
  content: () => <>
    <p>These are the classes you can choose today. Open the Class tab and tap one to equip it, or No class to unequip. Switching is free and instant, with no level, skill or writ requirement. The classes have no perks yet.</p>
    <Table headers={["Class"]} rows={LAUNCH_SPECIALIZATION_IDS.map((id) => [SPECIALIZATION_DEFINITIONS[id].displayName])} />
    <h2>Skills</h2>
    <p>New combat skills are coming soon. The old combat skills are retired, and any Skill Points you spent on them are back to spend. The five Trades stay open to everyone at 1 Skill Point per rank:</p>
    <Table headers={["Trade", "What it does"]} rows={GENERAL_SKILL_IDS.filter((id) => isGeneralSkillAvailable(id)).map((id) => [GENERAL_SKILL_DEFINITIONS[id].displayName, GENERAL_SKILL_DEFINITIONS[id].description])} />
    <h2>World Knowledge discovery</h2>
    <p>Each field of World Knowledge takes its dungeon token plus a set of overworld drops, given together in one turn-in.</p>
    <Table headers={["Knowledge", "Turn-in", "Where the overworld items drop"]} rows={Object.entries(WORLD_KNOWLEDGE_OVERWORLD_PARTS).map(([id, offering]) => {
      const turnIn = (DUNGEON_SKILL_TURN_INS as Readonly<Record<string, { tokenItemId: string; tokenCost: number }>>)[id];
      const token = turnIn ? `${turnIn.tokenCost} ${data.items.find((item) => item.id === turnIn.tokenItemId)?.name ?? turnIn.tokenItemId}, ` : "100 Crystal, ";
      return [WORLD_KNOWLEDGE_SKILL_DEFINITIONS[id as keyof typeof WORLD_KNOWLEDGE_SKILL_DEFINITIONS].displayName, token + offeringSummary(offering!.parts), partSources(offering!.parts)];
    })} />
    <p>Field Engineering is the exception: it takes only 175 Forge Sparks, turned in at the Spark Forge in the Golem Forge hub (a level 37 raid).</p>
    <h2>Skill progression</h2>
    <Bullets><li>Every character level grants skill points.</li><li>Ronin and Warrior are free to pick, switch or drop at any time.</li></Bullets>
  </>
};

const equipment: WikiArticle = {
  slug: "character/equipment",
  title: "Equipment and Character",
  summary: "Your seven equipment slots and how to ready a weapon for battle.",
  category: "character",
  sourceType: "hybrid",
  sourcePath: "apps/client/src/ui/CharacterPanel.tsx; packages/shared/src/equipment.ts",
  tags: ["equipment", "character", "weapon", "armor"],
  content: () => <>
    <p>Open Character from the Actions drawer or Game Menu to see your equipment slots and combat stats. Pick a slot to see the gear you own that fits it; your readied weapon decides what your attacks use.</p>
    <p>There are {data.items.filter((item) => item.kind === "equipment").length} pieces of equipment in the game. Each one you own is its own item in Inventory, so you can carry several of the same piece.</p>
    <Note title="Equip from Inventory or Character">If an item can't be equipped, the panel tells you why, whether that's the wrong slot or a level requirement.</Note>
    <p>Curious which weapon to bring? The <WikiLink slug="character/matchups">Weapon &amp; Armor Matchups</WikiLink> explorer shows every weapon against every armor.</p>
  </>
};

const inventory: WikiArticle = {
  slug: "character/inventory",
  title: "Inventory and Item Actions",
  summary: "Carry weight, item categories, and moving exact quantities.",
  category: "character",
  sourceType: "hybrid",
  sourcePath: "apps/client/src/ui/InventoryPanel.tsx; packages/shared/src/inventoryCatalog.ts",
  tags: ["inventory", "items", "resources", "equipment", "stack"],
  content: () => <>
    <p>Inventory shows one row for each material you hold and keeps every piece of equipment separate. Switch between All, Equipment, Resources, Consumables, and any Backpacks you own. Your carry weight and capacity stay visible above the list.</p>
    <Table headers={["Item kind", "What you can check"]} rows={[
      ["Resources", "Name, quantity, weight in kg, rarity, and whether it can be sold on the market or stored at a manor."],
      ["Equipment", "What it is, which slot it fits, the copy you own, and what you can do with it."],
      ["Consumables", "The same details, plus whether you can use it right now."],
    ]} />
    <p>Identical materials stack without limit. Dropping, trading, and storing let you move an exact amount. Your capacity counts everything you carry, equipped gear included, plus the bonus from every Backpack +N you own that hasn't been destroyed, whether equipped or stored at your manor. A new Backpack +0 costs 80 Leather and 2,000 Gold to craft; each enhancement adds a guaranteed 5 kg, up to +55 kg at +10, and the backpack itself weighs nothing. Picking up more than you can carry simply fails; you never slow down.</p>
    <p>For every item's name and trade status, see the <WikiLink slug="items/catalog">Item catalog</WikiLink>.</p>
  </>
};

const combat: WikiArticle = {
  slug: "character/combat",
  title: "Combat Basics",
  summary: "Pick a target, attack, and read the numbers before you commit.",
  category: "character",
  sourceType: "curated",
  sourcePath: "apps/client/src/ui/PhoneCombatControls.tsx; apps/client/src/ui/SkillSystemV3CombatControls.tsx; apps/client/src/ui/WarriorQuickSlots.tsx",
  tags: ["combat", "attack", "skills", "target"],
  content: () => <>
    <p>Every fight starts with a target. Before an attack or ability goes off, the game checks your range, weapon, target, cooldown, and resource.</p>
    <Bullets><li>Tap or click a target, then use the basic attack or a skill.</li><li>Some abilities charge your next attack; others show a preview on the map. Drag abilities aim where you drag when the skill card says so.</li><li>On phones, a 500 ms long-press on a support ability casts it on yourself; a normal tap aims it as usual.</li><li>Q, W, and E trigger class slots on phone and desktop where your controls show them. Trust the cooldown and the reason shown on the button over muscle memory.</li></Bullets>
    <Note title="Crowded fights">When creatures bunch up, use Choose Target and check each row. A tap picks a target; it never hits a different creature by accident.</Note>
    <p>Wondering what hits hardest? The <WikiLink slug="character/matchups">Weapon &amp; Armor Matchups</WikiLink> explorer has every answer.</p>
  </>
};

const matchups: WikiArticle = {
  slug: "character/matchups",
  title: "Weapon & Armor Matchups",
  summary: "Pick a monster, weapon, or armor to see what to bring, what to wear, and every matchup at your level.",
  category: "character",
  sourceType: "generated",
  sourcePath: "packages/shared/src/damageMatrixV3.ts; packages/shared/src/mobMatchups.ts",
  tags: ["matchups", "damage", "weapon", "armor", "pvp", "pve", "monsters", "combat"],
  content: () => <>
    <p>Every hit in Ash Atlas, against players and monsters alike, comes down to one thing: the attacker's weapon against the defender's armor. Monsters carry a weapon and wear armor too.</p>
    <MatchupExplorer matchups={data.matchups} />
  </>
};

const targeting: WikiArticle = {
  slug: "character/targeting",
  title: "Target Picker and Action Prompts",
  summary: "Choosing exactly the thing you meant when targets overlap.",
  category: "character",
  sourceType: "curated",
  sourcePath: "apps/client/src/ui/GameTargetPicker.tsx; apps/client/src/ui/GameActionPrompt.tsx",
  tags: ["target", "picker", "prompt", "touch"],
  content: () => <>
    <p>The target picker appears whenever a tap could mean more than one thing, for world objects and destinations alike. Choosing is always separate from acting, so a stray tap never starts something by surprise.</p>
    <h2>Picker gestures</h2>
    <Table headers={["Gesture", "Result"]} rows={[
      ["Tap or click a row", "Highlights and chooses that row."], ["Slide off or release over another row", "Nothing is chosen; the picker stays open."], ["Cancelled touch", "Nothing happens; the picker stays open."], ["Cancel, Escape, or release outside", "Closes the picker without choosing."],
    ]} />
    <p>Once you've chosen, read the action prompt. Travel, enter, gather, attack, build, and every other action is confirmed there, along with whether it's in range and available.</p>
  </>
};

const death: WikiArticle = {
  slug: "character/death-and-respawning",
  title: "Death and Respawning",
  summary: "What happens when you fall, and how to get back up.",
  category: "character",
  sourceType: "curated",
  sourcePath: "apps/client/src/ui/DeathScreen.tsx",
  tags: ["death", "respawn", "experience", "reconnect"],
  content: () => <>
    <p>When you die, the <strong>YOU FELL</strong> prompt appears. Dying costs 3% of your current level's XP requirement, but never more than your progress within that level, so you never lose a level. You can respawn when the countdown ends.</p>
    <p>Dying in the open world also drops your lowest backpack (+0 before +1, and so on) on the ground where you fell, along with anything you can no longer carry without it. Anyone can pick it up, and it disappears after 1 hour. Players at level 3 or below drop nothing, and deaths inside a dungeon drop nothing.</p>
    <Bullets><li>Check the loss line; sometimes it tells you no EXP was lost.</li><li>Wait for the respawn button to light up, then press it.</li><li>If you've disconnected, reconnect first; your fallen state is kept safe until you return.</li></Bullets>
  </>
};

const worldMap: WikiArticle = {
  slug: "world/world-map",
  title: "World Map and Travel",
  summary: "Open the map, search destinations, switch layers, and travel.",
  category: "world",
  sourceType: "curated",
  sourcePath: "apps/client/src/ui/WorldMapOverlay.tsx; packages/shared/src/worldMap.ts",
  tags: ["world map", "travel", "destinations", "layers"],
  content: () => <>
    <p>Open the World Map from the phone Game Menu, the desktop account menu, or by holding the locate button on your phone HUD. It's for picking far-off destinations; everyday walking still happens on the main map.</p>
    <Table headers={["Map tool", "Use"]} rows={[
      ["Search destinations", "Search the Cities, Personal, and Kingdom tabs, then choose a destination."], ["Layers", "Toggle map overlays: Biomes (the 13 land biomes), Elevation (Low to Summit), Terrain, Ocean Depth, and Water."], ["You / current focus", "Jump the view back to yourself or what you were looking at."], ["Choose Destination", "Pick where to go before the Travel prompt."], ["Escape / Close / Back", "Step back out of search, layers, or a destination, then close the World Map."],
    ]} />
    <p>You unlock destinations through cities, a manor you've built, or your Kingdom. Every journey starts with a confirmation, and you can cancel while you're on the way.</p>
    <Note title="Phone locate button">Tap to recenter the map on yourself. Hold for about 500 ms to open the World Map; letting go after the hold won't also recenter.</Note>
  </>
};

const dayNight: WikiArticle = {
  slug: "world/day-and-night",
  title: "World Time and Day/Night",
  summary: "The world clock, its four phases, and which count as day or night.",
  category: "world",
  sourceType: "generated",
  sourcePath: "packages/shared/src/worldTime.ts",
  tags: ["time", "day", "night", "dawn", "dusk"],
  content: () => <>
    <p>A full game day passes every {data.sourceRevision.worldTimeCycleMs / 3_600_000} real hours. The clock runs on UTC, so it doesn't shift with your time zone or daylight saving.</p>
    <Table headers={["Phase", "Game time", "Counts as"]} rows={data.dayNight.map((phase) => [phase.phase, `${phase.start} – ${phase.end}`, phase.mechanical])} />
    <p>Day and dusk both count as <strong>DAY</strong>; night and dawn both count as <strong>NIGHT</strong>. If a creature or habitat cares about the time, check the in-game clock.</p>
  </>
};

const creatures: WikiArticle = {
  slug: "world/creatures",
  title: "Creatures and the Encyclopedia",
  summary: "Every beast in the Encyclopedia: what it fights with, what it wears, and how tough it is.",
  category: "world",
  sourceType: "generated",
  sourcePath: "packages/shared/src/creatureBook.ts; packages/shared/src/mobMatchups.ts; apps/server/src/game/combat/mobDefinitions.ts",
  tags: ["creatures", "plants", "mobs", "combat", "habitat", "encyclopedia"],
  content: () => <>
    <p>The Encyclopedia holds {data.creatures.length} beasts and Wild Flax. Most entries fill in as you explore their habitat; legendary entries have no habitat goal.</p>
    <p>Every creature fights with a weapon and wears armor, just like you. Health is the same at any level and is counted in plain sword hits; their armor decides how many swings it really takes. What changes with level is how hard they hit and how they rank. Tap a creature to see what to bring against it.</p>
    <CreatureRoster creatures={data.creatures.map(rosterCreature)} />
    <p>Sword hits counts swings from a sword of the creature's own level. Hits bare skin is one blow on an adventurer wearing no armor. Your in-game Encyclopedia tracks what you've actually seen, harvested, and discovered.</p>
  </>
};

const gathering: WikiArticle = {
  slug: "world/resources-and-gathering",
  title: "Resources and Gathering",
  summary: "How to spot something you can gather and where your haul goes.",
  category: "world",
  sourceType: "hybrid",
  sourcePath: "apps/client/src/collectibles.ts; apps/client/src/harvestAccess.ts; apps/client/src/App.tsx",
  tags: ["resources", "gathering", "harvest", "collectibles"],
  content: () => <>
    <p>Resource nodes and collectibles work like anything else in the world: tap or click one, pick the right row if it's crowded, and confirm the gather action in the prompt.</p>
    <Bullets><li>Whatever you gather goes straight to Inventory.</li><li>Some resources need the right access, terrain, habitat, or distance. When you can't gather, the prompt tells you why.</li><li>Check your stacks in <WikiLink slug="character/inventory">Inventory</WikiLink> and turn materials into bars and cores at the <WikiLink slug="activities/furnace">Furnace</WikiLink>.</li></Bullets>
    <Note title="Where to look">Nodes appear and refresh across the living world, so this guide doesn't pin them to fixed spots. Explore, and keep an eye on habitats.</Note>
  </>
};

const furnace: WikiArticle = {
  slug: "activities/furnace",
  title: "Furnace and Smelting",
  summary: "Furnace range, queue size, batches, and every recipe.",
  category: "activities",
  sourceType: "generated",
  sourcePath: "packages/shared/src/furnace.ts",
  tags: ["furnace", "crafting", "smelting", "bars", "cores"],
  content: () => <>
    <p>The furnace belongs to your manor. Use it from within {data.furnace.interactionRadiusM} m, and it must stand within {data.furnace.maxManorDistanceM} m of the manor. It queues up to {data.furnace.queueCapacity} jobs, and recipes that batch take {data.furnace.batch.min} to {data.furnace.batch.max} at a time.</p>
    <Table numeric={[2]} headers={["Recipe", "Output", "Time", "Inputs"]} rows={data.furnace.recipes.map((recipe) => [recipe.name, recipe.output, `${recipe.durationMinutes} min`, recipe.inputs.map((input) => `${input.name} × ${input.quantity}`).join(", ")])} />
    <p>Every iron bar is smelted on its own roll. Metallurgy starts at a 75% success chance, rising to 80% at Rank 2, 90% at Rank 5, and 100% at Rank 8; a failed attempt always leaves Slag. Your very first iron smelt always succeeds. A success earns 1,500 Metallurgy XP and a failure 1,000.</p>
    <p>At Metallurgy Rank 2 you can recover Slag without Wood and without earning Metallurgy XP: 5 Slag become one Iron Bar, then 4 Slag at Rank 5 and 3 Slag at Rank 8.</p>
    <p>The furnace panel shows your queue, what you have on hand, and when each job finishes.</p>
  </>
};

const market: WikiArticle = {
  slug: "activities/market",
  title: "Market Basics",
  summary: "Buying and selling, and what each order status means.",
  category: "activities",
  sourceType: "curated",
  sourcePath: "apps/client/src/ui/MarketOverlay.tsx; packages/shared/src/market.ts",
  tags: ["market", "buy", "sell", "orders", "economy"],
  content: () => <>
    <p>Open the Market from the Actions drawer, or press <strong>M</strong> when it's available. You trade by placing buy and sell orders at the venues the market offers.</p>
    <Table headers={["Order state", "Meaning"]} rows={[["Open", "Waiting for a match."], ["Partially filled", "Some of it has traded; the rest is still waiting."], ["Filled", "All of it has traded."], ["Cancelled", "No longer on the market."]]}/>
    <p>Venues, fees, taxes, held funds, and collections can change, so read the quote and confirmation before you place or cancel an order rather than relying on a remembered fee.</p>
  </>
};

const dungeons: WikiArticle = {
  slug: "activities/dungeons",
  title: "Dungeons and Interior Locations",
  summary: "Stepping inside buildings, caves, and dungeons, and finding your way back out.",
  category: "activities",
  sourceType: "curated",
  sourcePath: "packages/shared/src/locations.ts; apps/client/src/ui/DungeonZoneLayer.tsx; apps/client/src/App.tsx",
  tags: ["dungeon", "interior", "portal", "location"],
  content: () => <>
    <p>Buildings, rooms, floors, caves, and dungeons all work the same way: select an entrance, read the action prompt, and confirm Enter. You leave the same way you came in.</p>
    <p>Inside, the map and target picker work as usual: move, inspect what's around you, and fight what you find. Some world-map, combat, or travel options change while you're inside; the controls on screen always show what's available.</p>
    <Note title="No shortcuts">The only way in or out is through an entrance and its prompt.</Note>
  </>
};

const kingdoms: WikiArticle = {
  slug: "kingdoms/overview",
  title: "Kingdoms",
  summary: "Kingdom roles, levels, flags, and the spaces you share.",
  category: "kingdoms",
  sourceType: "generated",
  sourcePath: "packages/shared/src/kingdoms.ts; apps/client/src/ui/KingdomPanel.tsx",
  tags: ["kingdom", "roles", "flags", "territory", "progression"],
  content: () => <>
    <p>A Kingdom brings players together under one banner, with shared flags, decorations, cots, chat, a treasury, projects, and perks. Here's what each role can do:</p>
    <Table headers={["Role", "Permissions"]} rows={data.kingdom.roles.map((role) => [role.role, role.permissions.map((permission) => permission.replaceAll("_", " ")).join(", ")])} />
    <h2>Kingdom levels</h2>
    <Table numeric={[0, 1, 2, 3, 4]} headers={["Level", "Lifetime XP", "Members", "Cots", "Decorations"]} rows={data.kingdom.levels.map((level) => [level.level, level.requiredXp.toLocaleString("en-US"), level.members, level.cots, level.decorations])} />
    <p>Leaders and officers have different powers, and the Kingdom panel shows exactly what your role allows. Flags and decorations stay in the world, so check the confirmation and cost the panel shows before you commit.</p>
  </>
};

const itemCatalog: WikiArticle = {
  slug: "items/catalog",
  title: "Item Catalog",
  summary: "Every item's name, kind, rarity, weight, and whether you can trade it.",
  category: "items",
  sourceType: "generated",
  sourcePath: "packages/shared/src/inventoryCatalog.ts; packages/shared/src/equipment.ts",
  tags: ["items", "resources", "equipment", "catalog", "rarity"],
  content: () => <>
    <p>Every item in Ash Atlas at a glance. How many you own, and whether one is around right now, is up to your adventures.</p>
    <Table numeric={[3]} accents={data.items.map((item) => item.rarity)} headers={["Item", "Kind", "Rarity", "Weight", "Market"]}
      rows={data.items.map((item) => [item.name, item.kind, <Rarity value={item.rarity} />, `${formatWeightKg(getItemWeightGrams(item.id))} kg`, item.marketTradable ? "Tradable" : "Not tradable"])} />
    <p>Use Inventory to equip, use, drop, or move exact amounts. Being listed here doesn't give you an item, set its price, or mean it's available everywhere.</p>
  </>
};

function itemName(itemId: string): string {
  return data.items.find((item) => item.id === itemId)?.name ?? itemId;
}

const swagWeapons: WikiArticle = {
  slug: "items/swag-weapons",
  title: "Swag Weapons",
  summary: "Cosmetic weapons with base-weapon stats, crafted from regional monster drops.",
  category: "items",
  sourceType: "generated",
  sourcePath: "packages/shared/src/equipment.ts; packages/shared/src/data/item-variant-catalog.json",
  tags: ["swag", "weapons", "cosmetic", "crafting", "smithing", "drops"],
  content: () => <>
    <p>Swag weapons are new looks for the weapons you already use. Each one has exactly the same stats as its base weapon, so pick the one you like the look of.</p>
    <Bullets>
      <li>Craft them at your Manor's <strong>Smithing Station</strong>, on the Craft tab. They start at +0.</li>
      <li>The recipe is the base weapon's normal recipe plus a few monster drops from the region that inspired it.</li>
      <li>Upgrade and infuse them like any other weapon. They can be traded on the market.</li>
    </Bullets>
    <Note title="Plan before you hunt">The Crafting app shows every swag recipe and how many of each material you already have, wherever you are.</Note>
    {EQUIPMENT_CRAFT_RECIPES.flatMap((base) => {
      const recipes = EQUIPMENT_SWAG_CRAFT_RECIPES.filter((recipe) => recipe.familyId === base.familyId);
      if (recipes.length === 0) return [];
      return [
        <h2>{base.displayName}</h2>,
        <p>Base recipe: {base.materials.map(({ itemId, quantity }) => `${quantity} ${itemName(itemId)}`).join(", ")}.</p>,
        <Table headers={["", "Swag weapon", "Full recipe", "Where the extra drops come from"]} rows={recipes.map((recipe) => {
          const extras = recipe.materials.slice(base.materials.length);
          return [
            <WikiArt kind="item" id={recipe.definitionId} name={recipe.displayName} />,
            recipe.displayName,
            recipe.materials.map(({ itemId, quantity }) => `${quantity} ${itemName(itemId)}`).join(", "),
            extras.map(({ itemId }) => `${itemName(itemId)}: ${droppedBy(itemId)}`).join("; ")
          ];
        })} />
      ];
    })}
  </>
};

export const WIKI_ARTICLES: readonly WikiArticle[] = [
  controls, firstSteps, hud, characterOverview, classes, equipment, inventory, combat, matchups, targeting, death,
  worldMap, dayNight, creatures, gathering, furnace, market, dungeons, kingdoms, itemCatalog, swagWeapons
];

export const WIKI_ARTICLES_BY_SLUG = new Map(WIKI_ARTICLES.map((article) => [article.slug, article]));

/** Only the fields the roster draws; the rest of the generated creature data stays on the server. */
function rosterCreature(creature: (typeof data.creatures)[number]) {
  const { key, name, bookRarity, fixedLevel, maxHealth, weaponName, weaponType, armorName, armorType, weaponTypeId, armorTypeId, damageMultiplier } = creature;
  return { key, name, bookRarity, fixedLevel, maxHealth, weaponName, weaponType, armorName, armorType, weaponTypeId, armorTypeId, damageMultiplier };
}
