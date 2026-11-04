import { describe, expect, it, vi } from "vitest";

import {
  FLAG_BURN_INTERACTION_RADIUS_M,
  FLAG_HARDENED_ATTACK_DAMAGE,
  type FlagSnapshot
} from "@ash-atlas/shared";

import { FlagService } from "./flags.js";

describe("FlagService.attackFlag", () => {
  it("applies one bounded hit, records the cooldown, and is request-idempotent", async () => {
    const first = attackClient({
      flag: bastionFlagRow(175),
      updatedHealth: 150
    });
    const service = testService(first.client);

    await expect(service.attackFlag(
      "attacker-1",
      "flag-1",
      "attack-1",
      { position: { lat: 35, lon: -106 }, target: null, online: true }
    )).resolves.toMatchObject({
      damage: FLAG_HARDENED_ATTACK_DAMAGE,
      replayed: false,
      flag: { id: "flag-1" }
    });
    expect(first.updatedHealth).toBe(150);
    expect(first.queries.some((query) => query.includes("flag_attack_cooldowns"))).toBe(true);
    expect(first.queries.some((query) => query.includes("player_enemy_marks"))).toBe(true);

    const replay = attackClient({
      flag: bastionFlagRow(150),
      existingOperation: { flag_id: "flag-1", damage: FLAG_HARDENED_ATTACK_DAMAGE }
    });
    const replayService = testService(replay.client);
    await expect(replayService.attackFlag(
      "attacker-1",
      "flag-1",
      "attack-1",
      { position: { lat: 35, lon: -106 }, target: null, online: true }
    )).resolves.toMatchObject({
      damage: FLAG_HARDENED_ATTACK_DAMAGE,
      replayed: true,
      flag: { id: "flag-1" }
    });
    expect(replay.queries.some((query) => query.includes("SET health"))).toBe(false);
  });

  it("uses database server time for the 24-hour player cooldown", async () => {
    const state = attackClient({
      flag: bastionFlagRow(175),
      remainingCooldownMs: 60 * 60 * 1_000
    });
    const service = testService(state.client);

    await expect(service.attackFlag(
      "attacker-1",
      "flag-1",
      "attack-2",
      { position: { lat: 35, lon: -106 }, target: null, online: true }
    )).rejects.toMatchObject({ code: "FLAG_ATTACK_COOLDOWN" });
    expect(state.updatedHealth).toBeNull();
    expect(state.cooldownParams?.[2]).toBeGreaterThan(86_000_000);
  });

  it("stops at 110 HP and gates attack at the burn threshold", async () => {
    const threshold = attackClient({ flag: bastionFlagRow(110) });
    const thresholdService = testService(threshold.client);
    await expect(thresholdService.attackFlag(
      "attacker-1",
      "flag-1",
      "attack-3",
      { position: { lat: 35, lon: -106 }, target: null, online: true }
    )).rejects.toMatchObject({ code: "FLAG_ATTACK_THRESHOLD_REACHED" });

    const finalHit = attackClient({
      flag: bastionFlagRow(135),
      updatedHealth: 110
    });
    const finalHitService = testService(finalHit.client);
    await expect(finalHitService.attackFlag(
      "attacker-2",
      "flag-1",
      "attack-4",
      { position: { lat: 35, lon: -106 }, target: null, online: true }
    )).resolves.toMatchObject({ flag: { id: "flag-1" }, replayed: false });
    expect(finalHit.updatedHealth).toBe(110);
    expect(finalHit.updateParams?.[1]).toBe(FLAG_HARDENED_ATTACK_DAMAGE);
  });

  it("allows the creating developer to attack a marked test Flag without mutating social hostility", async () => {
    const state = attackClient({
      flag: {
        ...bastionFlagRow(175),
        developer_test_target: true,
        developer_test_creator_id: "attacker-1"
      },
      updatedHealth: 150
    });
    const service = testService(state.client);

    await expect(service.attackFlag(
      "attacker-1",
      "flag-1",
      "developer-test-attack",
      { position: { lat: 35, lon: -106 }, target: null, online: true }
    )).resolves.toMatchObject({ damage: FLAG_HARDENED_ATTACK_DAMAGE, replayed: false });
    expect(state.queries.some((query) => query.includes("player_enemy_marks"))).toBe(false);
  });

  it("allows an ordinary player to attack a marked test Flag without social hostility", async () => {
    const state = attackClient({
      flag: {
        ...bastionFlagRow(175),
        developer_test_target: true,
        developer_test_creator_id: "attacker-1"
      },
      updatedHealth: 150
    });
    const service = testService(state.client);

    await expect(service.attackFlag(
      "attacker-2",
      "flag-1",
      "developer-test-denied",
      { position: { lat: 35, lon: -106 }, target: null, online: true }
    )).resolves.toMatchObject({ damage: FLAG_HARDENED_ATTACK_DAMAGE, replayed: false });
    expect(state.queries.some((query) => query.includes("player_enemy_marks"))).toBe(false);
  });

  it("enforces the shared 50m server boundary", async () => {
    const state = attackClient({ flag: bastionFlagRow(175) });
    const service = testService(state.client);
    await expect(service.attackFlag(
      "attacker-1",
      "flag-1",
      "attack-5",
      {
        position: {
          lat: 35 + (FLAG_BURN_INTERACTION_RADIUS_M + 1) / 111_195,
          lon: -106
        },
        target: null,
        online: true
      }
    )).rejects.toMatchObject({ code: "FLAG_ATTACK_OUT_OF_RANGE" });
  });
});

describe("FlagService.attackFlag with a pet strike (Tail Lash)", () => {
  const moving = { position: { lat: 36, lon: -107 }, target: { lat: 36.1, lon: -107 }, online: true } as const;
  const strike = { origin: { lat: 35 + 80 / 111_195, lon: -106 }, radiusM: 100 } as const;

  it("finishes a bastion flag's 90-point hit phase and records the 24 h hit ledger", async () => {
    const state = attackClient({ flag: bastionFlagRow(200), updatedHealth: 110 });
    const service = testService(state.client);
    await expect(service.attackFlag("attacker-1", "flag-1", "swing-1:flag-1", moving, strike))
      .resolves.toMatchObject({ replayed: false, flag: { id: "flag-1" } });
    // The owner may be moving and far away; reach is measured from the drake (80 m here).
    expect(state.updateParams?.[1]).toBe(90);
    expect(state.updateParams?.[2]).toBe(110);
    expect(state.queries.some((query) => query.includes("INSERT INTO flag_attack_cooldowns"))).toBe(true);
  });

  it("hits a guard tower for 90-112, not its whole hit phase", async () => {
    const tower = { ...bastionFlagRow(2_700), reinforcement_level: 3, maximum_health: 2_700 };
    const state = attackClient({ flag: tower, updatedHealth: 2_590 });
    await expect(testService(state.client).attackFlag("attacker-1", "flag-1", "swing-6:flag-1", moving, strike))
      .resolves.toMatchObject({ replayed: false });
    const damage = Number(state.updateParams?.[1]);
    expect(damage).toBeGreaterThanOrEqual(90);
    expect(damage).toBeLessThanOrEqual(112);
  });

  it("skips a structure the owner already hit in the last 24 h", async () => {
    const state = attackClient({ flag: bastionFlagRow(220), remainingCooldownMs: 60_000 });
    const service = testService(state.client);
    await expect(service.attackFlag("attacker-1", "flag-1", "swing-2:flag-1", moving, strike))
      .rejects.toMatchObject({ code: "FLAG_ATTACK_COOLDOWN" });
    expect(state.updatedHealth).toBeNull();
  });

  it("replays an activation without a second hit", async () => {
    const state = attackClient({ flag: bastionFlagRow(110), existingOperation: { flag_id: "flag-1", damage: 100 } });
    const service = testService(state.client);
    await expect(service.attackFlag("attacker-1", "flag-1", "swing-1:flag-1", moving, strike))
      .resolves.toMatchObject({ replayed: true, damage: 100 });
    expect(state.queries.some((query) => query.includes("SET health"))).toBe(false);
  });

  it("refuses the owner's own flag, a burning flag and anything beyond 100 m of the drake", async () => {
    const own = attackClient({ flag: { ...bastionFlagRow(220), owner_id: "attacker-1" } });
    await expect(testService(own.client).attackFlag("attacker-1", "flag-1", "swing-3:flag-1", moving, strike))
      .rejects.toMatchObject({ code: "FLAG_ATTACK_TARGET_INVALID" });
    const burning = attackClient({ flag: { ...bastionFlagRow(220), burning_reason: "attack" as unknown as null } });
    await expect(testService(burning.client).attackFlag("attacker-1", "flag-1", "swing-4:flag-1", moving, strike))
      .rejects.toMatchObject({ code: "FLAG_ATTACK_BURNING" });
    const far = attackClient({ flag: bastionFlagRow(220) });
    await expect(testService(far.client).attackFlag("attacker-1", "flag-1", "swing-5:flag-1", moving,
      { origin: { lat: 35 + 110 / 111_195, lon: -106 }, radiusM: 100 }))
      .rejects.toMatchObject({ code: "FLAG_ATTACK_OUT_OF_RANGE" });
    for (const state of [own, burning, far]) expect(state.updatedHealth).toBeNull();
  });

  it("still refuses a moving owner without a strike", async () => {
    const state = attackClient({ flag: bastionFlagRow(220) });
    await expect(testService(state.client).attackFlag("attacker-1", "flag-1", "hand-1", moving))
      .rejects.toMatchObject({ code: "FLAG_ATTACK_MOVING" });
  });
});

function testService(client: ReturnType<typeof attackClient>["client"]): FlagService {
  const service = Object.create(FlagService.prototype) as FlagService;
  Object.defineProperty(service, "pool", {
    value: { connect: vi.fn(async () => client) },
    configurable: true
  });
  vi.spyOn(service, "getMapFlag").mockResolvedValue({
    id: "flag-1",
    controlType: "personal",
    ownerId: "victim-1"
  } as FlagSnapshot);
  return service;
}

function bastionFlagRow(health: number): {
  owner_id: string;
  control_type: "personal";
  anchor_kind: "flag";
  system_controlled: boolean;
  city_id: null;
  kingdom_id: null;
  reinforcement_level: number;
  health: number;
  maximum_health: number;
  lat: number;
  lon: number;
  burning_reason: null;
  developer_test_target?: boolean;
  developer_test_creator_id?: string;
} {
  return {
    owner_id: "victim-1",
    control_type: "personal",
    anchor_kind: "flag",
    system_controlled: false,
    city_id: null,
    kingdom_id: null,
    reinforcement_level: 1,
    health,
    maximum_health: 220,
    lat: 35,
    lon: -106,
    burning_reason: null
  };
}

function attackClient(input: Readonly<{
  flag: ReturnType<typeof bastionFlagRow>;
  updatedHealth?: number;
  existingOperation?: { flag_id: string; damage: number };
  remainingCooldownMs?: number;
}>) {
  let updatedHealth: number | null = null;
  let updateParams: unknown[] | null = null;
  let cooldownParams: unknown[] | null = null;
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const query = sql.trim();
      queries.push(query);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (query.includes("flag_attack_operations") && query.startsWith("SELECT")) {
        return {
          rows: input.existingOperation ? [input.existingOperation] : [],
          rowCount: input.existingOperation ? 1 : 0
        };
      }
      if (
        query.includes("FROM flags WHERE id=$1 FOR UPDATE") ||
        query.includes("FROM flags\n         LEFT JOIN developer_spawned_test_flags")
      ) {
        return { rows: [input.flag], rowCount: 1 };
      }
      if (query.includes("FROM flag_attack_cooldowns")) {
        cooldownParams = params ?? null;
        return input.remainingCooldownMs === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ remaining_ms: input.remainingCooldownMs }], rowCount: 1 };
      }
      if (query.startsWith("UPDATE flags")) {
        updateParams = params ?? null;
        updatedHealth = input.updatedHealth ?? null;
        return input.updatedHealth === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ health: input.updatedHealth }], rowCount: 1 };
      }
      if (query.includes("INSERT INTO flag_attack_operations")) {
        return { rows: [{ flag_id: "flag-1", damage: FLAG_HARDENED_ATTACK_DAMAGE }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn()
  };
  return {
    client,
    queries,
    get updatedHealth() { return updatedHealth; },
    get updateParams() { return updateParams; },
    get cooldownParams() { return cooldownParams; }
  };
}
