import {
  EQUIPMENT_DEFINITIONS,
  PET_GLIMMER_COSTS,
  PET_HEAL_ITEM_ID,
  PET_MAX_LEVEL,
  PET_SPECIES_DEFINITIONS,
  PET_SPECIES_IDS,
  PET_TRAVEL_SHAVE_MS,
  isPetSpeciesId,
  petActiveDurationMs,
  petCombatStats,
  petEffectiveLevel,
  petGearCapLevel,
  petRestDurationMs,
  petSpeciesForItem,
  type PetAbilityId,
  type PetEggHolding,
  type PetGlimmerCostKey,
  type PetSnapshot,
  type PetSpeciesId,
  type InventoryItemType,
  type PetStateSnapshot,
  type PlayerInventorySnapshot,
  type PremiumWalletSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { InventoryService } from "./inventory.js";
import { PremiumWalletOperationError, type PremiumWalletService } from "./premiumWallet.js";

export class PetError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "PetError";
  }
}

type PetRow = {
  id: string;
  account_id: string;
  species: string;
  name: string;
  level: number;
  unlocked_abilities: string[];
  current_hp: number | null;
  last_fed_at: Date;
  rest_until: Date | null;
  active_until: Date | null;
  paused_remaining_ms: number | null;
  source: string;
};

/** Everything a pet runtime needs to put the pet in the world. */
export type ActivePet = Readonly<{
  id: string;
  species: PetSpeciesId;
  name: string;
  effectiveLevel: number;
  unlockedAbilities: PetAbilityId[];
  baseMaxHealth: number;
  health: number;
  damage: number;
  defense: number;
  activeUntilMs: number;
}>;

export type PetMutationResult = Readonly<{
  state: PetStateSnapshot;
  notice?: string;
  inventory?: PlayerInventorySnapshot;
  premiumWallet?: PremiumWalletSnapshot;
  /** The pet now out in the world, if any (for the companion runtime). */
  active: ActivePet | null;
}>;

export type PetOwnerContext = Readonly<{ accountId: string; playerId: string }>;

type PaidAction = "feed" | "heal" | "train" | "unlock" | "hatch" | "hermit";

const PET_COLUMNS = `id, account_id, species, name, level, unlocked_abilities, current_hp,
  last_fed_at, rest_until, active_until, paused_remaining_ms, source`;
const WEAPON_CATEGORIES = new Set(["melee_weapon", "ranged_weapon"]);
const ARMOR_CATEGORIES = new Set(["head_armor", "chest_armor", "gloves", "boots", "shield"]);
const EGG_ITEM_IDS = PET_SPECIES_IDS
  .map((id) => PET_SPECIES_DEFINITIONS[id].source.itemId)
  .filter((itemId): itemId is string => typeof itemId === "string");

/**
 * Server authority for pet whistles: call, dismiss, rest, feed, heal, train and ability unlocks.
 * Every Glimmer spend and item use is guarded by `account_pet_operations` and shares its operation
 * key with the wallet/inventory debit inside one transaction, so a replayed request never charges
 * twice.
 */
export class PetService {
  private readonly now: () => Date;

  constructor(
    private readonly pool: pg.Pool,
    private readonly premium: Pick<PremiumWalletService, "debitForOperationInTransaction" | "snapshotInTransaction">,
    private readonly inventory: Pick<InventoryService, "debitItemsForOperationInTransaction" | "snapshotInTransaction"> | null,
    options: { now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Onboarding seam: every account owns the free Trail Hound whistle. */
  async ensureStarterPetInTransaction(client: pg.PoolClient, accountId: string): Promise<void> {
    await client.query(
      `INSERT INTO account_pet_whistles (account_id, species, name, source)
       VALUES ($1, 'trail_hound', 'Trail Hound', 'starter')
       ON CONFLICT (account_id, species) DO NOTHING`,
      [accountId]
    );
  }

  /** Read-only: no starter insert, no row locks; lapsed timers are reconciled in memory only. */
  async state(owner: PetOwnerContext): Promise<PetMutationResult> {
    return this.mutate(owner, async (client, rows, now) => ({ rows, now, client }), () => false, true);
  }

  /** Brings a pet out on a fresh timer. Any other pet out goes home to rest. */
  async call(owner: PetOwnerContext, petId: string): Promise<PetMutationResult> {
    return this.mutate(owner, async (client, rows, now) => {
      const pet = requirePet(rows, petId);
      if (pet.active_until) return { rows, now, client, notice: `${pet.name} is already out.` };
      if (pet.rest_until) throw new PetError("PET_RESTING", `${pet.name} is resting until ${pet.rest_until.toISOString()}.`);
      if (pet.source !== "developer") await this.assertSpeciesPermission(client, owner.playerId, pet.species as PetSpeciesId);
      await this.restOthers(client, owner, rows, pet.id, now);
      const durationMs = petActiveDurationMs(pet.species as PetSpeciesId, await this.skillRank(client, owner.playerId, "rare_beast_mastery"));
      await client.query(
        `UPDATE account_pet_whistles
         SET active_until = $2, paused_remaining_ms = NULL
         WHERE id = $1`,
        [pet.id, new Date(now.getTime() + durationMs)]
      );
      return { rows: await this.loadRows(client, owner.accountId), now, client, notice: `${pet.name} is out.` };
    });
  }

  /** Dismiss (or the owner entered a dungeon): the pet goes home to rest. */
  async sendHome(owner: PetOwnerContext, petId: string | null): Promise<PetMutationResult> {
    return this.mutate(owner, async (client, rows, now) => {
      const pet = petId ? requirePet(rows, petId) : rows.find((row) => row.active_until) ?? null;
      if (!pet?.active_until) return { rows, now, client };
      await this.restOthers(client, owner, rows, null, now);
      return { rows: await this.loadRows(client, owner.accountId), now, client, notice: `${pet.name} went home to rest.` };
    });
  }

  /** Timer ran out or the pet fell to 0 HP: it goes home to rest. */
  async beginRest(owner: PetOwnerContext, petId: string, reason: "expired" | "defeated"): Promise<PetMutationResult> {
    return this.mutate(owner, async (client, rows, now) => {
      const pet = rows.find((row) => row.id === petId);
      if (!pet?.active_until) return { rows, now, client };
      const restMs = petRestDurationMs(pet.level, await this.druidRank(client, owner.playerId));
      await client.query(
        `UPDATE account_pet_whistles
         SET active_until = NULL, paused_remaining_ms = NULL, rest_until = $2,
             current_hp = CASE WHEN $3 THEN 0 ELSE current_hp END
         WHERE id = $1`,
        [pet.id, new Date(now.getTime() + restMs), reason === "defeated"]
      );
      return {
        rows: await this.loadRows(client, owner.accountId), now, client,
        notice: reason === "defeated" ? `${pet.name} was hurt and went home to rest.` : `${pet.name} went home to rest.`
      };
    });
  }

  /** Relocation or teleport while a pet is out shaves a minute off its timer. */
  async shaveForTravel(owner: PetOwnerContext): Promise<PetMutationResult | null> {
    const out = await this.pool.query(
      "SELECT 1 FROM account_pet_whistles WHERE account_id = $1 AND active_until > now()",
      [owner.accountId]
    );
    if (!out.rowCount) return null;
    const result = await this.mutate(owner, async (client, rows, now) => {
      const pet = rows.find((row) => row.active_until);
      if (!pet) return { rows, now, client };
      await client.query(
        "UPDATE account_pet_whistles SET active_until = active_until - ($2::integer * interval '1 millisecond') WHERE id = $1",
        [pet.id, PET_TRAVEL_SHAVE_MS]
      );
      return { rows: await this.loadRows(client, owner.accountId), now, client };
    });
    return result.active ? result : null;
  }

  /** Persists base health reported by the combat runtime (no reconciliation, no locking beyond the row). */
  async updateHealthForOwner(ownerPlayerId: string, petId: string, baseHealth: number): Promise<void> {
    await this.pool.query(
      `UPDATE account_pet_whistles SET current_hp = $3
       WHERE id = $1 AND active_until IS NOT NULL
         AND account_id = (SELECT account_id FROM players WHERE id = $2)`,
      [petId, ownerPlayerId, Math.max(0, Math.round(baseHealth))]
    );
  }

  async ownerForPlayer(playerId: string): Promise<PetOwnerContext | null> {
    const result = await this.pool.query<{ account_id: string }>("SELECT account_id FROM players WHERE id = $1", [playerId]);
    const accountId = result.rows[0]?.account_id;
    return accountId ? { accountId, playerId } : null;
  }

  /** Feed: skip rest, reset aging, and bring the pet out on a fresh timer. */
  async feed(owner: PetOwnerContext, petId: string, requestId: string): Promise<PetMutationResult> {
    return this.paid(owner, "feed", requestId, petId, "feed", async (client, pet, now) => {
      if (pet.source !== "developer") await this.assertSpeciesPermission(client, owner.playerId, pet.species as PetSpeciesId);
      await this.restOthers(client, owner, await this.loadRows(client, owner.accountId), pet.id, now);
      const durationMs = petActiveDurationMs(pet.species as PetSpeciesId, await this.skillRank(client, owner.playerId, "rare_beast_mastery"));
      await client.query(
        `UPDATE account_pet_whistles
         SET last_fed_at = $2, rest_until = NULL, paused_remaining_ms = NULL, current_hp = NULL,
             active_until = $3
         WHERE id = $1`,
        [pet.id, now, new Date(now.getTime() + durationMs)]
      );
      return `${pet.name} ate and is ready to go.`;
    });
  }

  /** Heal: one Giving Berry restores the pet to full health. */
  async heal(owner: PetOwnerContext, petId: string, requestId: string): Promise<PetMutationResult> {
    return this.paid(owner, "heal", requestId, petId, null, async (client, pet, _now, operationKey) => {
      if (!this.inventory) throw new PetError("PET_UNAVAILABLE", "Healing is temporarily unavailable.", true);
      const maxHp = petCombatStats(pet.species as PetSpeciesId, 0).maxHp;
      if (pet.current_hp === null || pet.current_hp >= maxHp) {
        throw new PetError("PET_FULL_HEALTH", `${pet.name} is already at full health.`);
      }
      try {
        await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey,
          playerId: owner.playerId,
          source: "pet_heal",
          sourceEntityType: "pet",
          sourceEntityId: pet.id,
          debits: [{ itemId: PET_HEAL_ITEM_ID, variant: "default", quantity: 1n }]
        });
      } catch (error) {
        if (error instanceof Error && /not contain enough/u.test(error.message)) {
          throw new PetError("PET_NO_BERRY", "You need a Giving Berry to heal your pet.");
        }
        throw error;
      }
      await client.query("UPDATE account_pet_whistles SET current_hp = NULL WHERE id = $1", [pet.id]);
      return `${pet.name} is fully healed.`;
    });
  }

  async train(owner: PetOwnerContext, petId: string, requestId: string): Promise<PetMutationResult> {
    return this.paid(owner, "train", requestId, petId, "train", async (client, pet) => {
      if (pet.level >= PET_MAX_LEVEL) throw new PetError("PET_MAX_LEVEL", `${pet.name} is fully trained.`);
      await client.query("UPDATE account_pet_whistles SET level = level + 1 WHERE id = $1", [pet.id]);
      return `${pet.name} trained to level ${pet.level + 1}.`;
    });
  }

  async unlockAbility(owner: PetOwnerContext, petId: string, abilityId: PetAbilityId, requestId: string): Promise<PetMutationResult> {
    return this.paid(owner, "unlock", requestId, petId, "unlockAbility", async (client, pet) => {
      const species = PET_SPECIES_DEFINITIONS[pet.species as PetSpeciesId];
      if (!species.abilities.includes(abilityId)) throw new PetError("PET_ABILITY_INVALID", "That ability does not belong to this pet.");
      if (pet.unlocked_abilities.includes(abilityId)) throw new PetError("PET_ABILITY_OWNED", "That ability is already unlocked.");
      await client.query(
        "UPDATE account_pet_whistles SET unlocked_abilities = array_append(unlocked_abilities, $2) WHERE id = $1",
        [pet.id, abilityId]
      );
      return "Ability unlocked.";
    });
  }

  /** Hatch an egg (or repair a broken whistle) into a new whistle: consumes the item and Glimmer. */
  async hatch(owner: PetOwnerContext, itemId: string, requestId: string): Promise<PetMutationResult> {
    const speciesId = petSpeciesForItem(itemId);
    if (!speciesId || !PET_SPECIES_DEFINITIONS[speciesId].source.available) {
      throw new PetError("PET_EGG_INVALID", "That item cannot be hatched yet.");
    }
    return this.paid(owner, "hatch", requestId, null, "hatch", async (client, _pet, _now, operationKey) => {
      if (!this.inventory) throw new PetError("PET_UNAVAILABLE", "Hatching is temporarily unavailable.", true);
      await this.assertSpeciesPermission(client, owner.playerId, speciesId);
      const created = await this.createWhistle(client, owner.accountId, speciesId, "hatch");
      try {
        await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey,
          playerId: owner.playerId,
          source: "pet_hatch",
          sourceEntityType: "pet",
          sourceEntityId: created,
          debits: [{ itemId: itemId as InventoryItemType, variant: "default", quantity: 1n }]
        });
      } catch (error) {
        if (error instanceof Error && /not contain enough/u.test(error.message)) {
          throw new PetError("PET_EGG_MISSING", "You no longer have that egg.");
        }
        throw error;
      }
      return { notice: `${PET_SPECIES_DEFINITIONS[speciesId].displayName} hatched!`, petId: created };
    });
  }

  /** Grove Hermit beast sale (the caller checks the owner stands at the Hermit). */
  async buyFromHermit(owner: PetOwnerContext, speciesId: PetSpeciesId, requestId: string): Promise<PetMutationResult> {
    if (PET_SPECIES_DEFINITIONS[speciesId].source.kind !== "hermit") {
      throw new PetError("PET_NOT_SOLD", "The Grove Hermit does not sell that beast.");
    }
    return this.paid(owner, "hermit", requestId, null, "hermit", async (client) => {
      const created = await this.createWhistle(client, owner.accountId, speciesId, "hermit");
      return { notice: `The Grove Hermit hands you a ${PET_SPECIES_DEFINITIONS[speciesId].displayName} whistle.`, petId: created };
    });
  }

  /**
   * Developer grant: every species (including ones without a live source), both abilities unlocked,
   * ready now. No Glimmer, no skill gate. Idempotent: repeating it only re-readies the whistles.
   */
  async grantAllForDeveloper(owner: PetOwnerContext): Promise<PetMutationResult> {
    return this.mutate(owner, async (client, _rows, now) => {
      for (const speciesId of PET_SPECIES_IDS) {
        const species = PET_SPECIES_DEFINITIONS[speciesId];
        await client.query(
          `INSERT INTO account_pet_whistles (account_id, species, name, source, unlocked_abilities)
           VALUES ($1, $2, $3, 'developer', $4::text[])
           ON CONFLICT (account_id, species) DO UPDATE
           SET unlocked_abilities = EXCLUDED.unlocked_abilities,
               rest_until = NULL,
               current_hp = CASE WHEN account_pet_whistles.active_until IS NULL THEN NULL ELSE account_pet_whistles.current_hp END`,
          [owner.accountId, speciesId, species.displayName, [...species.abilities]]
        );
      }
      return { rows: await this.loadRows(client, owner.accountId), now, client, notice: "All pets granted and ready." };
    });
  }

  private async createWhistle(client: pg.PoolClient, accountId: string, speciesId: PetSpeciesId, source: "hatch" | "hermit"): Promise<string> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO account_pet_whistles (account_id, species, name, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, species) DO NOTHING
       RETURNING id`,
      [accountId, speciesId, PET_SPECIES_DEFINITIONS[speciesId].displayName, source]
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new PetError("PET_ALREADY_OWNED", `You already have a ${PET_SPECIES_DEFINITIONS[speciesId].displayName} whistle.`);
    return id;
  }

  private async paid(
    owner: PetOwnerContext,
    action: PaidAction,
    requestId: string,
    petId: string | null,
    cost: PetGlimmerCostKey | null,
    apply: (client: pg.PoolClient, pet: PetRow, now: Date, operationKey: string) =>
      Promise<string | { notice: string; petId: string }>
  ): Promise<PetMutationResult> {
    const operationKey = `pet:${owner.accountId}:${action}:${requestId}`;
    let touchedInventory = false;
    const result = await this.mutate(owner, async (client, rows, now) => {
      const pet = petId ? requirePet(rows, petId) : null;
      const glimmer = cost ? PET_GLIMMER_COSTS[cost] : 0;
      const reserved = await client.query(
        `INSERT INTO account_pet_operations (account_id, operation_key, action, pet_id, glimmer_cost)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [owner.accountId, operationKey, action, pet?.id ?? null, glimmer]
      );
      if (reserved.rowCount !== 1) return { rows, now, client, notice: "Already done." };
      const outcome = await apply(client, pet ?? (undefined as unknown as PetRow), now, operationKey);
      touchedInventory = action === "heal" || action === "hatch";
      if (glimmer > 0) {
        try {
          await this.premium.debitForOperationInTransaction(client, {
            accountId: owner.accountId,
            currency: "glimmer",
            amount: BigInt(glimmer),
            operationKey,
            reason: "spend",
            actorPlayerId: owner.playerId,
            refType: `pet_${action}`,
            refId: typeof outcome === "string" ? pet!.id : outcome.petId,
            metadata: { action, species: pet?.species ?? null }
          });
        } catch (error) {
          if (error instanceof PremiumWalletOperationError && error.code === "PREMIUM_WALLET_INSUFFICIENT_FUNDS") {
            throw new PetError("PET_INSUFFICIENT_GLIMMER", `You need ${glimmer} Glimmer.`);
          }
          throw error;
        }
      }
      return {
        rows: await this.loadRows(client, owner.accountId), now, client,
        notice: typeof outcome === "string" ? outcome : outcome.notice,
        premiumWallet: glimmer > 0 ? await this.premium.snapshotInTransaction(client, owner.accountId) : undefined
      };
    }, () => touchedInventory);
    return result;
  }

  private async mutate(
    owner: PetOwnerContext,
    work: (client: pg.PoolClient, rows: PetRow[], now: Date) => Promise<{
      rows: PetRow[]; now: Date; client: pg.PoolClient; notice?: string; premiumWallet?: PremiumWalletSnapshot | undefined;
    }>,
    includeInventory: () => boolean = () => false,
    readOnly = false
  ): Promise<PetMutationResult> {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
      if (!readOnly) await this.ensureStarterPetInTransaction(client, owner.accountId);
      const now = this.now();
      const rows = await this.reconcile(client, owner, await this.loadRows(client, owner.accountId, !readOnly), now, readOnly);
      const outcome = await work(client, rows, now);
      const snapshot = await this.snapshot(client, owner, outcome.rows, now);
      const inventory = includeInventory() && this.inventory
        ? await this.inventory.snapshotInTransaction(client, owner.playerId)
        : undefined;
      await client.query("COMMIT");
      return {
        state: snapshot.state,
        active: snapshot.active,
        ...(outcome.notice ? { notice: outcome.notice } : {}),
        ...(outcome.premiumWallet ? { premiumWallet: outcome.premiumWallet } : {}),
        ...(inventory ? { inventory } : {})
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isUniqueViolation(error)) throw new PetError("PET_BUSY", "Your pets are busy. Try again.", true);
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadRows(client: pg.PoolClient, accountId: string, lock = false): Promise<PetRow[]> {
    const result = await client.query<PetRow>(
      `SELECT ${PET_COLUMNS} FROM account_pet_whistles
       WHERE account_id = $1 ORDER BY created_at, id ${lock ? "FOR UPDATE" : ""}`,
      [accountId]
    );
    return result.rows.filter((row) => isPetSpeciesId(row.species));
  }

  /** Timers that ran out while nobody was looking: out → resting, resting → ready (healed). */
  private async reconcile(client: pg.PoolClient, owner: PetOwnerContext, rows: PetRow[], now: Date, inMemoryOnly = false): Promise<PetRow[]> {
    let changed = false;
    for (const row of rows) {
      if (row.active_until && row.active_until.getTime() <= now.getTime()) {
        const restMs = petRestDurationMs(row.level, await this.druidRank(client, owner.playerId));
        const restUntil = new Date(row.active_until.getTime() + restMs);
        if (!inMemoryOnly) {
          await client.query(
            "UPDATE account_pet_whistles SET active_until = NULL, rest_until = $2 WHERE id = $1",
            [row.id, restUntil]
          );
        }
        row.active_until = null;
        row.rest_until = restUntil;
        changed = true;
      }
      if (row.rest_until && row.rest_until.getTime() <= now.getTime()) {
        if (!inMemoryOnly) {
          await client.query("UPDATE account_pet_whistles SET rest_until = NULL, current_hp = NULL WHERE id = $1", [row.id]);
        }
        row.rest_until = null;
        row.current_hp = null;
        changed = true;
      }
    }
    return changed && !inMemoryOnly ? this.loadRows(client, owner.accountId) : rows;
  }

  /** Every other pet that is out goes home to rest (one pet out at a time). */
  private async restOthers(client: pg.PoolClient, owner: PetOwnerContext, rows: PetRow[], keepId: string | null, now: Date): Promise<void> {
    const druidRank = await this.druidRank(client, owner.playerId);
    for (const row of rows) {
      if (row.id === keepId || !row.active_until) continue;
      await client.query(
        "UPDATE account_pet_whistles SET active_until = NULL, paused_remaining_ms = NULL, rest_until = $2 WHERE id = $1",
        [row.id, new Date(now.getTime() + petRestDurationMs(row.level, druidRank))]
      );
    }
  }

  private async snapshot(
    client: pg.PoolClient,
    owner: PetOwnerContext,
    rows: PetRow[],
    now: Date
  ): Promise<{ state: PetStateSnapshot; active: ActivePet | null }> {
    const gearCapLevel = await this.gearCapLevel(client, owner.playerId);
    const druidRank = await this.druidRank(client, owner.playerId);
    const holdings = await client.query<{ resource_type: string; quantity: string }>(
      `SELECT resource_type, sum(quantity)::text AS quantity FROM player_inventory
       WHERE player_id = $1 AND resource_type = ANY($2::text[]) AND quantity > 0
       GROUP BY resource_type`,
      [owner.playerId, [...EGG_ITEM_IDS, PET_HEAL_ITEM_ID]]
    );
    const quantities = new Map(holdings.rows.map((row) => [row.resource_type, Number(row.quantity)]));
    const eggs: PetEggHolding[] = EGG_ITEM_IDS.flatMap((itemId) => {
      const quantity = quantities.get(itemId) ?? 0;
      const speciesId = petSpeciesForItem(itemId);
      return quantity > 0 && speciesId ? [{ itemId, species: speciesId, quantity }] : [];
    });
    let active: ActivePet | null = null;
    const pets: PetSnapshot[] = rows.map((row) => {
      const speciesId = row.species as PetSpeciesId;
      const effectiveLevel = petEffectiveLevel(row.level, gearCapLevel);
      const stats = petCombatStats(speciesId, effectiveLevel);
      const health = row.current_hp === null ? stats.maxHp : Math.min(stats.maxHp, row.current_hp);
      const unlockedAbilities = row.unlocked_abilities.filter((id): id is PetAbilityId =>
        (PET_SPECIES_DEFINITIONS[speciesId].abilities as readonly string[]).includes(id));
      if (row.active_until) {
        active = {
          id: row.id, species: speciesId, name: row.name, effectiveLevel, unlockedAbilities,
          baseMaxHealth: stats.maxHp, health, damage: stats.damage, defense: stats.defense,
          activeUntilMs: row.active_until.getTime()
        };
      }
      return {
        id: row.id,
        species: speciesId,
        name: row.name,
        level: row.level,
        effectiveLevel,
        unlockedAbilities,
        status: row.active_until ? "active" : row.rest_until ? "resting" : "ready",
        activeUntil: row.active_until?.toISOString() ?? null,
        restUntil: row.rest_until?.toISOString() ?? null,
        restDurationMs: petRestDurationMs(row.level, druidRank),
        lastFedAt: row.last_fed_at.toISOString(),
        health,
        maxHealth: stats.maxHp,
        damage: stats.damage,
        defense: stats.defense,
        abilityReadyAt: {}
      };
    });
    const activePet = active as ActivePet | null;
    return {
      active: activePet,
      state: {
        pets,
        activePetId: activePet?.id ?? null,
        gearCapLevel,
        eggs,
        healItemQuantity: quantities.get(PET_HEAL_ITEM_ID) ?? 0,
        hermitOffers: [],
        serverTime: now.toISOString()
      }
    };
  }

  /** Average of the best weapon and best armour level the owner carries or wears. */
  private async gearCapLevel(client: pg.PoolClient, playerId: string): Promise<number> {
    const result = await client.query<{ definition_id: string; item_level: number }>(
      `SELECT definition_id, max(item_level)::integer AS item_level FROM equipment_instances
       WHERE owner_player_id = $1 AND location IN ('inventory', 'equipped')
       GROUP BY definition_id`,
      [playerId]
    );
    let weapon = 0;
    let armor = 0;
    for (const row of result.rows) {
      const category = (EQUIPMENT_DEFINITIONS as Readonly<Record<string, { category: string } | undefined>>)[row.definition_id]?.category;
      if (!category) continue;
      if (WEAPON_CATEGORIES.has(category)) weapon = Math.max(weapon, row.item_level);
      if (ARMOR_CATEGORIES.has(category)) armor = Math.max(armor, row.item_level);
    }
    return petGearCapLevel(weapon, armor);
  }

  private async skillRank(client: pg.PoolClient, playerId: string, skillId: string): Promise<number> {
    const result = await client.query<{ rank: number }>(
      "SELECT rank FROM player_skill_ranks WHERE player_id = $1 AND skill_id = $2",
      [playerId, skillId]
    );
    return result.rows[0]?.rank ?? 0;
  }

  private async druidRank(client: pg.PoolClient, playerId: string): Promise<number> {
    const result = await client.query<{ rank: number }>(
      "SELECT rank FROM player_specialization_ranks WHERE player_id = $1 AND specialization_id = 'druid'",
      [playerId]
    );
    return result.rows[0]?.rank ?? 0;
  }

  private async assertSpeciesPermission(client: pg.PoolClient, playerId: string, speciesId: PetSpeciesId): Promise<void> {
    const required = PET_SPECIES_DEFINITIONS[speciesId].requiresSkill;
    if (!required) return;
    if (await this.skillRank(client, playerId, required.skillId) < required.rank) {
      throw new PetError("PET_SKILL_REQUIRED", `${PET_SPECIES_DEFINITIONS[speciesId].displayName} needs Rare Beast Mastery rank ${required.rank}.`);
    }
  }
}

function requirePet(rows: readonly PetRow[], petId: string): PetRow {
  const pet = rows.find((row) => row.id === petId);
  if (!pet) throw new PetError("PET_NOT_FOUND", "That pet is not yours.");
  return pet;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}
