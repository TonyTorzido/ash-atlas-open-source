import { useState } from "react";
import { DUNGEON_CHEST_RARITIES, DUNGEON_MESSAGE_MAX_LENGTH, MOB_ARCHETYPE_KEYS, INVENTORY_CATALOG, type DungeonCatalog, type DungeonDefinition,
  type DungeonRoomDefinition, type DungeonRewardTableDefinition, type MobArchetypeKey } from "@ash-atlas/shared";
import { createMobPlacement, dungeonAssetId, runtimeDungeonAssetUrl } from "./dungeonStudioV2.js";
import type { DungeonAssetImportOptions } from "./bridgeTypes.js";

type Props = { catalog: DungeonCatalog; dungeon: DungeonDefinition; room: DungeonRoomDefinition;
  disabled: boolean; onUpdate(edit: (catalog: DungeonCatalog) => void): void };
const RARITIES = DUNGEON_CHEST_RARITIES;

export function addRandomMobGroup(dungeon: DungeonDefinition, room: DungeonRoomDefinition,
  archetype: MobArchetypeKey, count: number, zoneId: string, encounterId: string, waveIndex: number): void {
  const encounter = dungeon.encounters.find((candidate) => candidate.id === encounterId && candidate.roomId === room.id);
  const wave = encounter?.waves[waveIndex];
  const zone = room.zones.find((candidate) => candidate.id === zoneId && !candidate.retired);
  if (!encounter || !wave || !zone || !Number.isInteger(count) || count < 1 || count > 100) return;
  const spawn = room.anchors.find((anchor) => anchor.id === room.spawnAnchorId)!;
  const group = uniqueId(`${encounter.id}_group`, room.mobs.map((mob) => mob.spawnGroupId));
  for (let index = 0; index < count; index += 1) {
    const id = uniqueId(`${archetype}_spawn`, dungeon.rooms.flatMap((candidate) => candidate.mobs.map((mob) => mob.id)));
    const anchorId = uniqueId(`${id}_anchor`, room.anchors.map((anchor) => anchor.id));
    room.anchors.push({ ...spawn, id: anchorId });
    room.mobs.push({ ...createMobPlacement(archetype, id, anchorId, encounter.id, encounter.leashZoneId),
      waveIndex: waveIndex + 1, spawnGroupId: group, randomSpawnZoneId: zoneId });
    wave.mobSpawnIds.push(id);
  }
}

export function configureChestReward(catalog: DungeonCatalog, dungeon: DungeonDefinition,
  room: DungeonRoomDefinition, chestId: string): void {
  const chest = room.objects.find((object) => object.id === chestId && object.type === "chest")!;
  const id = uniqueId(`${dungeon.id}_${chest.id}_loot`, catalog.rewardTableIds);
  const table: DungeonRewardTableDefinition = { id, revision: `${id}-v1`, retired: false, items: [],
    chestLoot: { rarities: RARITIES.map((rarity, index) => ({ rarity, chance: [60, 25, 10, 4, 1][index]!,
      slots: index + 1, loot: [{ itemId: "coal", weight: 1, minQuantity: 1, maxQuantity: 3 }] })) } };
  catalog.rewardTables.push(table); catalog.rewardTableIds.push(id);
  dungeon.rewardTableIds.push(id); chest.rewardTableId = id; chest.spawnChance ??= 100;
  const rewards = dungeon.triggers.filter((trigger) => !trigger.retired && trigger.event.type === "object_interact" &&
    trigger.event.roomId === room.id && trigger.event.objectId === chest.id && trigger.actions.some((action) => action.type === "grant_reward"));
  if (rewards.length) {
    // Replace the first existing payout only. Never duplicate one chest's roll
    // across separate reward sources or rewrite unrelated bonus rewards.
    const trigger = rewards[0]!;
    const action = trigger.actions.find((action) => action.type === "grant_reward")!;
    if (action.type === "grant_reward") action.rewardTableId = id;
  } else dungeon.triggers.push({ id: uniqueId(`${room.id}_${chest.id}_reward`, dungeon.triggers.map((trigger) => trigger.id)),
    retired: false, enabled: true, scope: "player", repetition: "once", cooldownMs: 0,
    event: { type: "object_interact", roomId: room.id, objectId: chest.id }, conditions: { mode: "all", items: [] },
    actions: [{ type: "grant_reward", rewardTableId: id }] });
}

export function DungeonMobBatchTools(props: Props) {
  const [archetype, setArchetype] = useState<MobArchetypeKey>(MOB_ARCHETYPE_KEYS[0]);
  const [count, setCount] = useState(3);
  const encounters = props.dungeon.encounters.filter((encounter) => !encounter.retired && encounter.roomId === props.room.id);
  const [encounterChoice, setEncounterChoice] = useState("");
  const encounter = encounters.find((value) => value.id === encounterChoice) ?? encounters[0];
  const [zoneChoice, setZoneChoice] = useState("");
  const zones = props.room.zones.filter((zone) => !zone.retired);
  const zoneId = zones.find((zone) => zone.id === zoneChoice)?.id ?? zones[0]?.id ?? "";
  const [waveIndex, setWaveIndex] = useState(0);
  const [summonerId, setSummonerId] = useState("");
  const [healthPercent, setHealthPercent] = useState(50);
  const effectiveWave = Math.min(waveIndex, (encounter?.waves.length ?? 1) - 1);
  const mutate = (edit: (dungeon: DungeonDefinition, room: DungeonRoomDefinition) => void) => props.onUpdate((catalog) => {
    const dungeon = catalog.dungeons.find((value) => value.id === props.dungeon.id)!;
    edit(dungeon, dungeon.rooms.find((room) => room.id === props.room.id)!);
  });
  return <details className="dungeon-recipe-card" open><summary>Random enemy group</summary>
    <p>Choose N enemies and a spawnable zone. Positions reroll once per run; retries in that run keep the same positions. Use the canvas for fixed placements.</p>
    <label className="field compact"><span>Enemy</span><select value={archetype} onChange={(event) => setArchetype(event.target.value as MobArchetypeKey)}>{MOB_ARCHETYPE_KEYS.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}</option>)}</select></label>
    <NumberInput label="Enemy count" value={count} min={1} max={100} onChange={setCount} />
    <label className="field compact"><span>Encounter</span><select value={encounter?.id ?? ""} onChange={(event) => { setEncounterChoice(event.target.value); setWaveIndex(0); }}><option value="">Choose encounter</option>{encounters.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
    <label className="field compact"><span>Wave</span><select value={effectiveWave} onChange={(event) => setWaveIndex(Number(event.target.value))}>{encounter?.waves.map((wave, index) => <option key={wave.id} value={index}>Wave {index + 1}</option>)}</select></label>
    <label className="field compact"><span>Spawnable zone</span><select value={zoneId} onChange={(event) => setZoneChoice(event.target.value)}><option value="">Draw a zone first</option>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.id} · {zone.kind}</option>)}</select></label>
    <label className="field compact"><span>Spawn timing</span><select value={summonerId} onChange={(event) => setSummonerId(event.target.value)}><option value="">When this wave starts</option>{props.room.mobs.filter((mob) => !mob.retired && !mob.summonedByMobSpawnId && mob.encounterId === encounter?.id && mob.waveIndex === effectiveWave + 1).map((mob) => <option key={mob.id} value={mob.id}>Summoned by {mob.archetype.replaceAll("_", " ")} · {props.room.mobs.indexOf(mob) + 1}</option>)}</select></label>
    {summonerId ? <NumberInput label="Leader health at or below %" value={healthPercent} min={1} max={100} onChange={setHealthPercent} /> : null}
    <button type="button" disabled={props.disabled || !encounter || !zoneId} onClick={() => mutate((dungeon, room) => {
      const before = new Set(room.mobs.map((mob) => mob.id));
      addRandomMobGroup(dungeon, room, archetype, count, zoneId, encounter!.id, effectiveWave);
      const leader = room.mobs.find((mob) => mob.id === summonerId && mob.encounterId === encounter!.id && mob.waveIndex === effectiveWave + 1 && !mob.summonedByMobSpawnId);
      if (leader) for (const mob of room.mobs.filter((mob) => !before.has(mob.id))) { mob.summonedByMobSpawnId = leader.id; mob.summonAtHealthPercent = healthPercent; }
    })}>Add {count} random enemies</button>
    <small>For miniboss adds, place the leader first, then choose it under Spawn timing. Adds appear once per attempt and must be defeated before the wave clears. Change an add's placement below to Fixed to position it manually.</small>
    {!encounter ? <small>Add an encounter below, or place the first enemy on the canvas.</small> : null}
    {props.room.mobs.filter((mob) => !mob.retired).map((mob) => <label className="field compact" key={mob.id}><span>{mob.archetype.replaceAll("_", " ")} · {props.room.mobs.indexOf(mob) + 1} placement</span><select value={mob.randomSpawnZoneId ?? ""} onChange={(event) => mutate((_dungeon, room) => {
      const target = room.mobs.find((value) => value.id === mob.id)!;
      if (event.target.value) target.randomSpawnZoneId = event.target.value; else delete target.randomSpawnZoneId;
    })}><option value="">Fixed canvas position</option>{zones.map((zone) => <option key={zone.id} value={zone.id}>Random in {zone.id}</option>)}</select></label>)}
  </details>;
}

export function DungeonChestTools(props: Props & { onImport(file: File, options: DungeonAssetImportOptions, onImported?: (assetKey: string) => void): Promise<boolean> }) {
  const chests = props.room.objects.filter((object) => !object.retired && object.type === "chest");
  const items = Object.values(INVENTORY_CATALOG).filter((item) => item.packageGrantable);
  const objectPrefabs = props.catalog.prefabs.filter((prefab) => !prefab.retired && prefab.type === "object");
  return <section aria-label="Chest setup"><h3>Chests in this room</h3><p>Chest spawn roll → rarity roll → weighted loot picks. Each rarity has its own slots and pool; duplicate picks stack. Rewards are claimed once per player per run.</p>
    {!chests.length ? <p>Place a Treasure Chest from Objects first.</p> : null}
    {chests.map((chest) => {
      const table = props.catalog.rewardTables.find((value) => value.id === chest.rewardTableId);
      const fallbackPrefab = objectPrefabs.find((prefab) => prefab.id === chest.prefabId);
      const edit = (callback: (draft: DungeonRewardTableDefinition) => void) => props.onUpdate((catalog) => {
        const draft = catalog.rewardTables.find((value) => value.id === chest.rewardTableId)!;
        callback(draft); draft.revision = `${draft.id}-v${Number(/-v(\d+)$/.exec(draft.revision)?.[1] ?? 0) + 1}`;
      });
      const importChestArt = (file: File, rarity?: (typeof RARITIES)[number]): void => {
        const suffix = rarity ? `_${rarity}` : "";
        const prefabId = dungeonAssetId(`chest${suffix}_${props.dungeon.id}_${chest.id}`, props.catalog.prefabs.map((prefab) => prefab.id));
        void props.onImport(file, {
          prefabId,
          displayName: (rarity ? `${rarity} chest · ${chest.name}` : chest.name).slice(0, 80),
          kind: "object",
          layer: "actors",
          renderMode: "sprite",
          defaultWidth: 80,
          defaultHeight: 80
        }, (assetKey) => props.onUpdate((catalog) => {
          if (!rarity) {
            const object = catalog.dungeons.find((dungeon) => dungeon.id === props.dungeon.id)!.rooms
              .find((room) => room.id === props.room.id)!.objects.find((object) => object.id === chest.id)!;
            object.prefabId = prefabId;
            object.prefabRevision = `${prefabId}-v1`;
            return;
          }
          const draft = catalog.rewardTables.find((value) => value.id === chest.rewardTableId);
          const row = draft?.chestLoot?.rarities.find((candidate) => candidate.rarity === rarity);
          if (row) row.assetKey = assetKey;
        }));
      };
      return <details className="dungeon-recipe-card" open key={chest.id}><summary>{chest.name}</summary>
        <section className="dungeon-chest-default-art" aria-label={`${chest.name} default artwork`}>
          <h4>Default chest picture</h4>
          <p>Older dungeons and any rarity without its own PNG use this picture.</p>
          {fallbackPrefab ? <img className="dungeon-prefab-thumbnail" src={runtimeDungeonAssetUrl(fallbackPrefab.assetKey)} alt={`${chest.name} default preview`} /> : null}
          <label className="field compact"><span>Chest picture</span><select value={chest.prefabId} disabled={props.disabled} onChange={(event) => props.onUpdate((catalog) => {
            const object = catalog.dungeons.find((dungeon) => dungeon.id === props.dungeon.id)!.rooms.find((room) => room.id === props.room.id)!.objects.find((object) => object.id === chest.id)!;
            const prefab = catalog.prefabs.find((value) => value.id === event.target.value)!; object.prefabId = prefab.id; object.prefabRevision = prefab.revision;
          })}>{objectPrefabs.map((prefab) => <option key={prefab.id} value={prefab.id}>{prefab.name}</option>)}</select></label>
          <label className="field compact"><span>Upload default chest PNG</span><input aria-label="Upload default chest PNG" type="file" accept="image/png" disabled={props.disabled} onChange={(event) => {
            const file = event.target.files?.[0]; if (file) importChestArt(file);
          }} /></label>
        </section>
        <NumberInput label={`${chest.name} spawn chance %`} value={chest.spawnChance ?? 100} min={0} max={100} onChange={(value) => props.onUpdate((catalog) => { catalog.dungeons.find((dungeon) => dungeon.id === props.dungeon.id)!.rooms.find((room) => room.id === props.room.id)!.objects.find((object) => object.id === chest.id)!.spawnChance = value; })} />
        {!table?.chestLoot ? <button type="button" disabled={props.disabled} onClick={() => props.onUpdate((catalog) => { const dungeon = catalog.dungeons.find((value) => value.id === props.dungeon.id)!; configureChestReward(catalog, dungeon, dungeon.rooms.find((room) => room.id === props.room.id)!, chest.id); })}>Configure rarity loot for this chest</button> : <>
          <p role={table.chestLoot.rarities.reduce((sum, row) => sum + row.chance, 0) === 100 ? "status" : "alert"}>Rarity total: {table.chestLoot.rarities.reduce((sum, row) => sum + row.chance, 0)}% · must equal 100%</p>
          <section className="dungeon-chest-rarity-art" aria-label={`${chest.name} artwork by rarity`}>
            <h4>Chest artwork by rolled rarity</h4>
            <p>Each rarity accepts PNG files up to 4 MB, 4096 pixels per side and 16 million pixels total. Internal names are generated automatically. The server rolls spawn chance first, then rarity once per run.</p>
            <div className="dungeon-chest-rarity-grid">
              {RARITIES.map((rarityName) => {
                const rarityIndex = table.chestLoot!.rarities.findIndex((candidate) => candidate.rarity === rarityName);
                const rarity = rarityIndex >= 0 ? table.chestLoot!.rarities[rarityIndex] : undefined;
                const selectedPrefab = rarity?.assetKey ? objectPrefabs.find((prefab) => prefab.assetKey === rarity.assetKey) : undefined;
                const previewAssetKey = rarity?.assetKey ?? fallbackPrefab?.assetKey;
                return <article className="dungeon-chest-rarity-slot" key={rarityName} aria-label={`${rarityName} chest artwork`}>
                  <h5>{rarityName[0]!.toUpperCase() + rarityName.slice(1)} chest</h5>
                  {previewAssetKey ? <img className="dungeon-prefab-thumbnail" src={runtimeDungeonAssetUrl(previewAssetKey)} alt={`${rarityName} chest preview`} /> : <div className="dungeon-prefab-thumbnail" aria-label={`${rarityName} chest preview unavailable`}>No preview</div>}
                  {!rarity ? <p role="alert">Add exactly one {rarityName} rarity row.</p> : <>
                    <small>{rarity.assetKey ? (selectedPrefab ? "Assigned PNG" : "Assigned PNG is not in the prefab catalog") : "Using default chest picture"}</small>
                    <label className="field compact"><span>Use existing PNG</span><select aria-label={`${rarityName} existing PNG`} value={selectedPrefab?.id ?? ""} disabled={props.disabled} onChange={(event) => edit((draft) => {
                      const row = draft.chestLoot!.rarities[rarityIndex]!;
                      const prefab = objectPrefabs.find((candidate) => candidate.id === event.target.value);
                      if (prefab) row.assetKey = prefab.assetKey; else delete row.assetKey;
                    })}><option value="">Default chest picture</option>{objectPrefabs.map((prefab) => <option key={prefab.id} value={prefab.id}>{prefab.name}</option>)}</select></label>
                    <label className="field compact"><span>Upload {rarityName} chest PNG</span><input aria-label={`Upload ${rarityName} chest PNG`} type="file" accept="image/png" disabled={props.disabled} onChange={(event) => {
                      const file = event.target.files?.[0]; if (file) importChestArt(file, rarityName);
                    }} /></label>
                  </>}
                </article>;
              })}
            </div>
          </section>
          {table.chestLoot.rarities.map((rarity, rarityIndex) => <details key={rarity.rarity}><summary>{rarity.rarity} · {rarity.chance}% · {rarity.slots} slots</summary>
            <NumberInput label={`${rarity.rarity} chance %`} value={rarity.chance} min={0} max={100} onChange={(value) => edit((draft) => { draft.chestLoot!.rarities[rarityIndex]!.chance = value; })} />
            <NumberInput label={`${rarity.rarity} slots`} value={rarity.slots} min={1} max={32} onChange={(value) => edit((draft) => { draft.chestLoot!.rarities[rarityIndex]!.slots = value; })} />
            {rarity.loot.map((loot, index) => <fieldset key={index}><legend>Loot pick {index + 1}</legend><label className="field compact"><span>Item</span><select value={loot.itemId} onChange={(event) => edit((draft) => { draft.chestLoot!.rarities[rarityIndex]!.loot[index]!.itemId = event.target.value; })}>{items.map((item) => <option key={item.itemId} value={item.itemId}>{item.displayName}</option>)}</select></label>
              <NumberInput label="Weight" value={loot.weight} min={1} onChange={(value) => edit((draft) => { draft.chestLoot!.rarities[rarityIndex]!.loot[index]!.weight = value; })} />
              <p>{(loot.weight / rarity.loot.reduce((sum, pick) => sum + pick.weight, 0) * 100).toFixed(1)}% per pick in this rarity. Each slot rolls independently.</p>
              <NumberInput label="Minimum quantity" value={loot.minQuantity} min={1} onChange={(value) => edit((draft) => { draft.chestLoot!.rarities[rarityIndex]!.loot[index]!.minQuantity = value; })} />
              <NumberInput label="Maximum quantity" value={loot.maxQuantity} min={1} onChange={(value) => edit((draft) => { draft.chestLoot!.rarities[rarityIndex]!.loot[index]!.maxQuantity = value; })} />
              <button type="button" disabled={rarity.loot.length <= 1} onClick={() => edit((draft) => { draft.chestLoot!.rarities[rarityIndex]!.loot.splice(index, 1); })}>Remove loot pick</button>
            </fieldset>)}
            <button type="button" onClick={() => edit((draft) => { draft.chestLoot!.rarities[rarityIndex]!.loot.push({ itemId: "coal", weight: 1, minQuantity: 1, maxQuantity: 1 }); })}>Add loot pick</button>
          </details>)}
        </>}
      </details>;
    })}
  </section>;
}

export function DungeonCompletionTools(props: Props) {
  const [encounterId, setEncounterId] = useState("");
  const [chestId, setChestId] = useState("");
  const [complete, setComplete] = useState(true);
  const [message, setMessage] = useState("");
  const encounters = props.dungeon.encounters.filter((encounter) => !encounter.retired);
  const chests = props.room.objects.filter((object) => !object.retired && object.type === "chest");
  const chosenEncounter = encounters.find((value) => value.id === encounterId) ?? encounters.find((value) => value.roomId === props.room.id) ?? encounters[0];
  const chosenChest = chests.find((value) => value.id === chestId) ?? chests[0];
  return <details className="dungeon-recipe-card" open><summary>Fight cleared → chest appears</summary>
    <label className="field compact"><span>Final encounter or miniboss</span><select value={chosenEncounter?.id ?? ""} onChange={(event) => setEncounterId(event.target.value)}>{encounters.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
    <label className="field compact"><span>Chest to reveal</span><select value={chosenChest?.id ?? ""} onChange={(event) => setChestId(event.target.value)}>{chests.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
    <label className="field compact"><span>Message when cleared (optional)</span><input value={message} maxLength={DUNGEON_MESSAGE_MAX_LENGTH} placeholder="The Ossuary door grinds open." onChange={(event) => setMessage(event.target.value.slice(0, DUNGEON_MESSAGE_MAX_LENGTH))} /></label>
    <label className="toggle"><input type="checkbox" checked={complete} onChange={(event) => setComplete(event.target.checked)} /><span>Also complete the dungeon</span></label>
    <button type="button" disabled={props.disabled || !chosenEncounter || !chosenChest} onClick={() => props.onUpdate((catalog) => {
      const dungeon = catalog.dungeons.find((value) => value.id === props.dungeon.id)!;
      const room = dungeon.rooms.find((value) => value.id === props.room.id)!;
      room.objects.find((value) => value.id === chosenChest!.id)!.available = false;
      const id = `clear_${chosenEncounter!.id}_${chosenChest!.id}`;
      // A replacement recipe must not leave an earlier event revealing this chest.
      // Retire empty old triggers to preserve published stable IDs.
      for (const trigger of dungeon.triggers.filter((value) => !value.retired && value.id !== id)) {
        const remaining = trigger.actions.filter((action) => !(action.type === "set_object_available" && action.roomId === room.id && action.objectId === chosenChest!.id && action.available));
        if (remaining.length === trigger.actions.length) continue;
        if (remaining.length === 0) trigger.retired = true;
        else trigger.actions = remaining;
      }
      dungeon.triggers = dungeon.triggers.filter((trigger) => trigger.id !== id);
      dungeon.triggers.push({ id, retired: false, enabled: true, scope: "instance", repetition: "once", cooldownMs: 0,
        event: { type: "encounter_state", encounterId: chosenEncounter!.id, state: "completed" }, conditions: { mode: "all", items: [] },
        actions: [{ type: "set_object_available", roomId: room.id, objectId: chosenChest!.id, available: true }, ...(complete ? [{ type: "complete_dungeon" as const }] : []),
          ...(message.trim() ? [{ type: "show_message" as const, text: message.trim(), tone: "success" as const }] : [])] });
    })}>Set completion event</button>
  </details>;
}

function NumberInput(props: { label: string; value: number; min: number; max?: number; onChange(value: number): void }) {
  return <label className="field compact"><span>{props.label}</span><input type="number" value={props.value} min={props.min} max={props.max} onChange={(event) => {
    const value = event.target.valueAsNumber; if (Number.isFinite(value)) props.onChange(value);
  }} /></label>;
}
function uniqueId(stem: string, ids: readonly string[]): string {
  let value = stem; let index = 2; while (ids.includes(value)) value = `${stem}_${index++}`; return value;
}
