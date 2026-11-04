import { randomUUID } from 'node:crypto';
import { seedTradeSkillRank } from './skills/tradeSkillTestSeed.js';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { InventoryCapacityError, InventoryService, lockInventoryCapacity } from './inventory.js';
import { validateItemDefinitionCatalog } from './items.js';
import { BackpackService } from './backpacks.js';
import { WalletService } from './wallet.js';
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migration = '0829_inventory_carry_kg.sql';
describeDatabase('quantity inventory carry migration and transactional capacity', () => {
  const databaseName = 'ash_atlas_stability_carry_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const repositoryMigrations = fileURLToPath(new URL('../../../../db/migrations/', import.meta.url));
  const equipmentIds = [randomUUID(), randomUUID()];
  const collectionEquipmentId = randomUUID();
  const collectionListingId = randomUUID();
  const collectionId = randomUUID();
  const backpackIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  let pool: pg.Pool;
  let inventory: InventoryService;
  let precedingMigrations = '';
  let databaseUrl = '';
  let applied: string[] = [];
  let originalBalances: unknown[] = [];
  let originalEquipment: unknown[] = [];
  let originalEvents = '';
  let retainedAccountId = '';
  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.pathname.slice(1).startsWith('ash_atlas_stability')) {
      throw new Error('Carry tests require a local disposable ash_atlas_stability database');
    }
    parsed.pathname = '/' + databaseName;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), 'ash-atlas-carry-migrations-'));
    for (const name of (await readdir(repositoryMigrations)).filter(name => name.endsWith('.sql') && name < migration)) {
      await copyFile(path.join(repositoryMigrations, name), path.join(precedingMigrations, name));
    }
    await admin.query('CREATE DATABASE "' + databaseName + '"');
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    retainedAccountId = await seedPlayer('carry-retained', 72);
    await seedPlayer('carry-overweight', 40);
    await seedPlayer('carry-boundary', 40);
    await seedPlayer('carry-concurrent', 40);
    await seedPlayer('carry-multi', 40);
    await seedBalance('carry-retained', 'wood', 'default', 437);
    await seedBalance('carry-retained', 'wood', 'retained:quality-A', 7);
    await seedBalance('carry-retained', 'stone', 'default', 82);
    await seedBalance('carry-retained', 'enchantment_stone', 'retained:fire', 7);
    await seedBalance('carry-overweight', 'wood', 'default', 15000);
    await seedInstances();
    await seedMarketCollection();
    originalBalances = (await pool.query('SELECT player_id,resource_type,variant,quantity::text,version::text FROM player_inventory ORDER BY player_id,resource_type,variant')).rows;
    originalEquipment = (await pool.query('SELECT instance_id,definition_id,owner_player_id,location,item_level,condition,enchantment_identity,metadata,market_listing_id,market_collection_id FROM equipment_instances ORDER BY instance_id')).rows;
    originalEvents = (await pool.query<{
      count: string;
    }>('SELECT count(*)::text FROM inventory_events')).rows[0]!.count;
    applied = await runMigrations(databaseUrl);
    // The carry regression cases use compact test capacities; 0830 correctly
    // promotes production baselines to 1,000 kg before this fixture narrows
    // them again. The overweight fixture intentionally retains its carried
    // 1,500 kg against the promoted 1,000 kg baseline.
    await pool.query(
      `UPDATE player_inventory_capacities
       SET base_capacity_grams = CASE player_id
         WHEN 'carry-retained' THEN 25000
         WHEN 'carry-boundary' THEN 100000
         WHEN 'carry-concurrent' THEN 100000
         WHEN 'carry-multi' THEN 100000
         ELSE base_capacity_grams
       END
       WHERE player_id IN ('carry-retained','carry-boundary','carry-concurrent','carry-multi')`
    );
    inventory = new InventoryService(pool);
    await validateItemDefinitionCatalog(pool);
  }, 180000);
  afterAll(async () => {
    await pool?.end();
    await admin.query('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
    await admin.end();
    if (precedingMigrations)
      await rm(precedingMigrations, { recursive: true, force: true });
  });
  it('preserves exact balances, variants, instance state and backpack ownership while retiring grid writes', async () => {
    expect(applied).toContain(migration);
    expect((await pool.query('SELECT player_id,resource_type,variant,quantity::text,version::text FROM player_inventory ORDER BY player_id,resource_type,variant')).rows).toEqual(originalBalances);
    expect((await pool.query('SELECT instance_id,definition_id,owner_player_id,location,item_level,condition,enchantment_identity,metadata,market_listing_id,market_collection_id FROM equipment_instances ORDER BY instance_id')).rows).toEqual(originalEquipment);
    expect((await pool.query<{
      count: string;
    }>('SELECT count(*)::text FROM inventory_events')).rows[0]!.count).toBe(originalEvents);
    const snapshot = await inventory.getInventorySnapshot('carry-retained');
    expect(snapshot.items).toHaveLength(4);
    expect(snapshot.items.find(item => item.resourceType === 'wood' && item.variant === null)?.quantity).toBe(437);
    expect(snapshot.items.find(item => item.variant === 'retained:quality-A')?.quantity).toBe(7);
    expect(snapshot.items.every(item => item.entryId === item.stackId && item.entryId && item.slotIndex === undefined && item.maxStack === undefined)).toBe(true);
    expect(snapshot.maximumWeightGrams).toBe('245000');
    expect(snapshot.unlockedSlots).toBeUndefined();
    // 0849 is the authorized forward gift: every pre-existing backpack is now +10.
    expect((await pool.query('SELECT instance_id,upgrade_level FROM player_backpack_instances ORDER BY equipped_slot')).rows).toEqual(backpackIds.map((instance_id) => ({ instance_id, upgrade_level: 10 })));
    expect((await pool.query('SELECT inventory_slot_index FROM equipment_instances')).rows.every(row => row.inventory_slot_index === null)).toBe(true);
    await expect(pool.query('UPDATE legacy_player_inventory_slots SET quantity=quantity WHERE player_id=$1', ['carry-retained'])).rejects.toThrow('archival');
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  });
  it('preserves both market collection custody references and can return the retained instance', async () => {
    const retained = await pool.query(
      `SELECT instance_id,location,market_listing_id,market_collection_id,condition
       FROM equipment_instances WHERE instance_id = $1`,
      [collectionEquipmentId]
    );
    expect(retained.rows).toEqual([{
      instance_id: collectionEquipmentId,
      location: 'market_collection',
      market_listing_id: collectionListingId,
      market_collection_id: collectionId,
      condition: 61
    }]);
    const before = await inventory.getInventorySnapshot('carry-retained');
    await pool.query(
      `UPDATE equipment_instances
       SET location = 'inventory', market_listing_id = NULL, market_collection_id = NULL
       WHERE instance_id = $1`,
      [collectionEquipmentId]
    );
    const after = await inventory.getInventorySnapshot('carry-retained');
    expect(BigInt(after.currentWeightGrams!) - BigInt(before.currentWeightGrams!)).toBe(1500n);
    expect((await pool.query(
      'SELECT listing_id,equipment_instance_id FROM market_equipment_collections WHERE collection_id = $1',
      [collectionId]
    )).rows).toEqual([{listing_id: collectionListingId,equipment_instance_id: collectionEquipmentId}]);
  });
  it('accepts exact gram capacity, rejects excess atomically and replays without duplicating quantity', async () => {
    const input = grant('carry-boundary', 'boundary', 1000);
    const first = await inventory.grantItemsForOperation(input);
    expect(first.inventory.currentWeightGrams).toBe('100000');
    expect(first.inventory.items).toHaveLength(1);
    await expect(inventory.grantItemsForOperation(grant('carry-boundary', 'overflow', 1))).rejects.toBeInstanceOf(InventoryCapacityError);
    const replay = await inventory.grantItemsForOperation(input);
    expect(replay.applied).toBe(false);
    expect(replay.inventory.totals.wood).toBe(1000);
    expect((await pool.query('SELECT operation_key FROM inventory_operations WHERE operation_key=$1', ['overflow'])).rows).toEqual([]);
    await expect(inventory.grantItemsForOperation(grant('carry-boundary', 'boundary', 999))).rejects.toThrow('different');
  });
  it('serializes two concurrent additions and never commits more than available capacity', async () => {
    await inventory.grantItemsForOperation(grant('carry-concurrent', 'concurrent-seed', 999));
    const results = await Promise.allSettled([
      inventory.grantItemsForOperation(grant('carry-concurrent', 'concurrent-a', 1)),
      inventory.grantItemsForOperation(grant('carry-concurrent', 'concurrent-b', 1))
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await inventory.getInventorySnapshot('carry-concurrent')).currentWeightGrams).toBe('100000');
  });
  it('preserves overweight legacy inventory and permits only net reductions until within its limit', async () => {
    expect((await inventory.getInventorySnapshot('carry-overweight')).currentWeightGrams).toBe('1500000');
    await expect(inventory.grantItemsForOperation(grant('carry-overweight', 'overweight-add', 1))).rejects.toBeInstanceOf(InventoryCapacityError);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await inventory.debitItemsForOperationInTransaction(client, {
        operationKey: 'overweight-craft-input', playerId: 'carry-overweight', source: 'carry_test',
        debits: [{ itemId: 'wood', variant: null, quantity: 10 }]
      });
      await inventory.grantItemsForOperationInTransaction(client, {
        operationKey: 'overweight-craft-output', playerId: 'carry-overweight', source: 'carry_test',
        grants: [{ itemId: 'stone', variant: null, quantity: 1 }]
      });
      await client.query('COMMIT');
    }
    catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    finally {
      client.release();
    }
    expect((await inventory.getInventorySnapshot('carry-overweight')).currentWeightGrams).toBe('1499250');
    await expect(pool.query('UPDATE player_inventory_capacities SET base_capacity_grams=99000 WHERE player_id=$1', ['carry-overweight'])).rejects.toThrow('carrying capacity');
  });
  it('rolls back multi-resource operations and preserves explicit partial pickup remainder accounting', async () => {
    await expect(inventory.grantItemsForOperation({
      operationKey: 'multi-overflow', playerId: 'carry-multi', source: 'carry_test',
      grants: [{ itemId: 'wood', variant: null, quantity: 900 }, { itemId: 'stone', variant: null, quantity: 100 }]
    })).rejects.toBeInstanceOf(InventoryCapacityError);
    expect((await inventory.getInventorySnapshot('carry-multi')).items).toHaveLength(0);
    const partial = await inventory.grantItemsForOperation({ ...grant('carry-multi', 'partial-pickup', 1200), allowPartial: true });
    expect(partial.grants[0]).toMatchObject({ requestedQuantity: 1200, grantedQuantity: 1000, remainderQuantity: 200 });
    expect((await inventory.grantItemsForOperation({ ...grant('carry-multi', 'partial-pickup', 1200), allowPartial: true })).grants).toEqual(partial.grants);
  });
  it('counts equipped instances, blocks bypass writes at commit, and upgrades stored levels through +10', async () => {
    const before = await inventory.getInventorySnapshot('carry-retained');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockInventoryCapacity(client, 'carry-boundary');
      await client.query('INSERT INTO equipment_operations(operation_key,player_id,action,completed_at) VALUES($1,$2,$3,now())', ['bypass-equipment', 'carry-boundary', 'starter_loadout']);
      await client.query(`INSERT INTO equipment_instances(instance_id,definition_id,owner_player_id,location,created_by_operation_key)
    VALUES($1,'starter_bow','carry-boundary','inventory','bypass-equipment')`, [randomUUID()]);
      await expect(client.query('COMMIT')).rejects.toThrow('carrying capacity');
      await client.query('ROLLBACK');
    }
    finally {
      client.release();
    }
    expect((await inventory.getInventorySnapshot('carry-boundary')).currentWeightGrams).toBe('100000');
    const backpacks = new BackpackService(pool);
    const initial = await backpacks.getSnapshot('carry-retained');
    expect(initial.instances.map(item => item.upgradeLevel).sort()).toEqual([10, 10, 10, 10]);
    expect(initial.instances.every(item => item.displayName === 'Backpack +' + item.upgradeLevel)).toBe(true);
    await pool.query('UPDATE player_backpack_instances SET location=$2,equipped_slot=NULL WHERE instance_id=$1', [backpackIds[0], 'inventory']);
    expect((await inventory.getInventorySnapshot('carry-retained')).currentWeightGrams).toBe(before.currentWeightGrams);
    // Exercise the actual level advancement service with funded, authoritative balances.
    await pool.query('UPDATE player_inventory_capacities SET base_capacity_grams=10000000 WHERE player_id=$1', ['carry-retained']);
    await inventory.grantItemsForOperation({ operationKey: 'upgrade-leather', playerId: 'carry-retained', source: 'carry_test', grants: [{ itemId: 'leather', variant: null, quantity: 20000 }] });
    const funding = await pool.connect();
    try {
      await funding.query('BEGIN');
      await new WalletService().creditForOperationInTransaction(funding, {
        playerId: 'carry-retained', accountId: retainedAccountId, amount: 1000000n,
        operationKey: 'carry-upgrade-wallet', reason: 'carry_test'
      });
      await funding.query('COMMIT');
    }
    catch (error) {
      await funding.query('ROLLBACK');
      throw error;
    }
    finally {
      funding.release();
    }
    const crafted = await backpacks.craft({ playerId: 'carry-retained', accountId: retainedAccountId }, 'carry-upgrade-craft');
    const craftedInstanceId = (await pool.query<{ instance_id: string }>(
      'SELECT instance_id::text FROM player_backpack_instances WHERE created_by_operation_key=$1',
      ['backpack:carry-retained:carry-upgrade-craft']
    )).rows[0]!.instance_id;
    expect(crafted.backpacks.instances.find(item => item.instanceId === craftedInstanceId)?.upgradeLevel).toBe(0);
    for (let level = 1; level <= 10; level++) {
      const result = await backpacks.upgrade({ playerId: 'carry-retained', accountId: retainedAccountId }, 'upgrade-' + level, craftedInstanceId);
      expect(result.backpacks.instances.find(item => item.instanceId === craftedInstanceId)?.upgradeLevel).toBe(level);
    }
    const replay = await backpacks.upgrade({ playerId: 'carry-retained', accountId: retainedAccountId }, 'upgrade-10', craftedInstanceId);
    expect(replay.replayed).toBe(true);
    await expect(backpacks.upgrade({ playerId: 'carry-retained', accountId: retainedAccountId }, 'upgrade-11', craftedInstanceId)).rejects.toThrow('maximum upgrade +10');
  });
  it('checks a direct multirow instance statement against the original transaction baseline', async () => {
    await seedPlayer('carry-direct-multirow', 40);
    await pool.query('UPDATE player_inventory_capacities SET base_capacity_grams=2999 WHERE player_id=$1', ['carry-direct-multirow']);
    for (const fits of [false, true]) {
      if (fits)
        await pool.query('UPDATE player_inventory_capacities SET base_capacity_grams=3000 WHERE player_id=$1', ['carry-direct-multirow']);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("INSERT INTO equipment_operations(operation_key,player_id,action,completed_at) VALUES('multirow-equipment','carry-direct-multirow','starter_loadout',now())");
        await client.query(`INSERT INTO equipment_instances(instance_id,definition_id,owner_player_id,location,created_by_operation_key)
     VALUES($1,'starter_bow','carry-direct-multirow','inventory','multirow-equipment'),
        ($2,'starter_bow','carry-direct-multirow','inventory','multirow-equipment')`, [randomUUID(), randomUUID()]);
        if (fits)
          await client.query('COMMIT');
        else
          await expect(client.query('COMMIT')).rejects.toThrow('carrying capacity');
      }
      finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect((await inventory.getInventorySnapshot('carry-direct-multirow')).currentWeightGrams).toBe(fits ? '3000' : '0');
    }
  });
  function grant(playerId: string, operationKey: string, quantity: number) {
    return { playerId, operationKey, source: 'carry_test', grants: [{ itemId: 'wood' as const, variant: null, quantity }] };
  }
  async function seedPlayer(playerId: string, baseSlots: number): Promise<string> {
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts(id,status,trust_tier) VALUES($1,'active','standard')", [accountId]);
    await pool.query(`INSERT INTO players(id,account_id,username,username_normalized,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
   VALUES($1,$2,$1,$1,'GLOBAL',0,0,0,0,1250,false,ST_SetSRID(ST_MakePoint(0,0),4326))`, [playerId, accountId]);
    await pool.query('INSERT INTO player_inventory_capacities(player_id,base_slots,unlocked_slots) VALUES($1,$2,$2)', [playerId, baseSlots]);
    await seedTradeSkillRank(pool, playerId, 'leatherworking', 1);
    return accountId;
  }
  async function seedBalance(playerId: string, itemId: string, variant: string, quantity: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const key = randomUUID();
      await client.query("INSERT INTO inventory_operations(operation_key,player_id,source) VALUES($1,$2,'carry_seed')", [key, playerId]);
      await client.query('INSERT INTO player_inventory(player_id,resource_type,variant,quantity,version) VALUES($1,$2,$3,$4,1)', [playerId, itemId, variant, quantity]);
      await client.query("INSERT INTO inventory_events(operation_key,player_id,item_id,variant,delta_quantity,quantity_after,version_after,source) VALUES($1,$2,$3,$4,$5,$5,1,'carry_seed')", [key, playerId, itemId, variant, quantity]);
      await client.query('COMMIT');
    }
    catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    finally {
      client.release();
    }
  }
  async function seedMarketCollection(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const venue = await client.query<{venue_id: string}>(
        'SELECT venue_id FROM market_venues ORDER BY venue_id LIMIT 1'
      );
      const venueId = venue.rows[0]?.venue_id;
      if (!venueId) throw new Error('Expected migrated market venue for retained custody fixture');
      await client.query(
        `INSERT INTO equipment_operations(operation_key,player_id,action,completed_at)
         VALUES('carry-collection-equipment','carry-retained','starter_loadout',now())`
      );
      await client.query(
        `INSERT INTO equipment_instances(
           instance_id,definition_id,owner_player_id,location,created_by_operation_key,
           market_listing_id,market_collection_id,condition
         ) VALUES($1,'starter_bow','carry-retained','market_collection',
                  'carry-collection-equipment',$2,$3,61)`,
        [collectionEquipmentId,collectionListingId,collectionId]
      );
      await client.query(
        `INSERT INTO market_equipment_listings(
           listing_id,venue_id,equipment_instance_id,seller_player_id,
           asking_price,status,presentation_snapshot
         ) VALUES($1,$2,$3,'carry-retained',100,'cancelled','{}'::jsonb)`,
        [collectionListingId,venueId,collectionEquipmentId]
      );
      await client.query(
        `INSERT INTO market_equipment_collections(
           collection_id,venue_id,listing_id,equipment_instance_id,player_id,reason
         ) VALUES($1,$2,$3,$4,'carry-retained','cancel_return')`,
        [collectionId,venueId,collectionListingId,collectionEquipmentId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function seedInstances(): Promise<void> {
    for (let index = 0; index < equipmentIds.length; index++) {
      const operation = 'carry-equipment-' + index;
      await pool.query("INSERT INTO equipment_operations(operation_key,player_id,action,completed_at) VALUES($1,'carry-retained','starter_loadout',now())", [operation]);
      await pool.query(`INSERT INTO equipment_instances(instance_id,definition_id,owner_player_id,location,inventory_slot_index,created_by_operation_key,item_level,condition,metadata)
    VALUES($1,'starter_bow','carry-retained','inventory',$2,$3,$4,$5,$6)`, [equipmentIds[index], 30 + index, operation, index, index === 0 ? 83 : 41, JSON.stringify({ retainedIdentity: index })]);
    }
    const definitions = ['starter_backpack', 'traveler_backpack', 'explorer_backpack', 'trailblazer_backpack'];
    for (let index = 0; index < 4; index++) {
      const operation = 'carry-backpack-' + index;
      await pool.query(`WITH operation AS (
    INSERT INTO backpack_operations(operation_key,player_id,account_id,request_id,action,request_hash)
    VALUES($1,'carry-retained',$2,$1,'create',$3) RETURNING operation_key
   ) INSERT INTO player_backpack_instances(instance_id,owner_player_id,definition_id,location,equipped_slot,created_by_operation_key)
    SELECT $4,'carry-retained',$5,'equipped',$6,operation_key FROM operation`, [operation, retainedAccountId, '0'.repeat(64), backpackIds[index], definitions[index], index]);
    }
  }
});
