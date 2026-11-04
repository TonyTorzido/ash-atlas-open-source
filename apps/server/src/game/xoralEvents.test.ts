import { afterEach, describe, expect, it, vi } from "vitest";

import {
  XORAL_CLASS_XP_REWARD,
  XORAL_GOLD_REWARD,
  XORAL_PLAYER_XP_REWARD,
  XORAL_ROOT_DURATION_MS,
  XORAL_ROOT_INTERVAL_MS,
  XoralEventService
} from "./xoralEvents.js";
import { OverworldBossParticipantLeaseCoordinator } from "./overworldBossParticipantLeases.js";

const anchor = { lat: 35.0844, lon: -106.6504 };

describe("XoralEventService V3 reward policy", () => {
  it("retains player XP and Gold while class XP remains historical and does not advance", () => {
    expect(XORAL_PLAYER_XP_REWARD).toBeGreaterThan(0);
    expect(XORAL_GOLD_REWARD).toBe(10_000);
    expect(XORAL_CLASS_XP_REWARD).toBe(0);
  });
});

describe("XoralEventService active mechanics", () => {
  afterEach(() => vi.useRealTimers());

  it("targets immediately and roots the locked participant every interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    const directMobTarget = vi.fn(() => true);
    const applyScriptedRoot = vi.fn(() => true);
    const setMovementBlocked = vi.fn();
    const service = new XoralEventService(
      { query: vi.fn() } as never,
      {
        isPlayerAlive: () => true,
        directMobTarget,
        applyScriptedRoot
      } as never,
      {} as never,
      {
        getPlayer: () => ({}),
        isWorldPresent: () => true,
        getAuthoritativeTravelAnchor: () => ({ center: anchor }),
        setMovementBlocked
      } as never,
      {} as never,
      {} as never,
      {} as never,
      { warn: vi.fn() } as never,
      () => 0
    );
    const internal = service as unknown as {
      installActiveRuntime(row: Record<string, unknown>): void;
      tick(): void;
      nextDormantCleanupAt: number;
    };
    internal.nextDormantCleanupAt = Number.MAX_SAFE_INTEGER;
    internal.installActiveRuntime({
      event_id: "event-1",
      combat_entity_id: "xoral:event-1",
      owner_player_id: "p1",
      locked_participant_ids: ["p1"],
      excluded_participant_ids: [],
      lat: anchor.lat,
      lon: anchor.lon
    });

    internal.tick();
    expect(directMobTarget).toHaveBeenLastCalledWith("xoral:event-1", "p1");

    vi.advanceTimersByTime(XORAL_ROOT_INTERVAL_MS);
    internal.tick();
    expect(applyScriptedRoot).toHaveBeenCalledWith(
      "xoral:event-1",
      "p1",
      XORAL_ROOT_DURATION_MS
    );
    expect(setMovementBlocked).toHaveBeenCalledWith("p1", true, "xoral-root:event-1");
    expect(directMobTarget).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(XORAL_ROOT_DURATION_MS);
    expect(setMovementBlocked).toHaveBeenLastCalledWith("p1", false, "xoral-root:event-1");
  });

  it("does not freeze or force-focus a participant when the scripted root is rejected", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    const directMobTarget = vi.fn(() => true);
    const setMovementBlocked = vi.fn();
    const service = new XoralEventService(
      { query: vi.fn() } as never,
      {
        isPlayerAlive: () => true,
        directMobTarget,
        applyScriptedRoot: vi.fn(() => false)
      } as never,
      {} as never,
      {
        getPlayer: () => ({}),
        isWorldPresent: () => true,
        getAuthoritativeTravelAnchor: () => ({ center: anchor }),
        setMovementBlocked
      } as never,
      {} as never,
      {} as never,
      {} as never,
      { warn: vi.fn() } as never,
      () => 0
    );
    const internal = service as unknown as {
      installActiveRuntime(row: Record<string, unknown>): void;
      tick(): void;
      nextDormantCleanupAt: number;
      activeByEntityId: Map<string, { forcedFocusPlayerId: string | null }>;
    };
    internal.nextDormantCleanupAt = Number.MAX_SAFE_INTEGER;
    internal.installActiveRuntime({
      event_id: "event-1",
      combat_entity_id: "xoral:event-1",
      owner_player_id: "p1",
      locked_participant_ids: ["p1"],
      excluded_participant_ids: [],
      lat: anchor.lat,
      lon: anchor.lon
    });

    vi.advanceTimersByTime(XORAL_ROOT_INTERVAL_MS);
    internal.tick();

    expect(setMovementBlocked).not.toHaveBeenCalled();
    expect(internal.activeByEntityId.get("xoral:event-1")?.forcedFocusPlayerId).toBeNull();
    expect(directMobTarget).toHaveBeenCalledWith("xoral:event-1", "p1");
  });

  it("allows combat only for locked, non-excluded participants", () => {
    const service = new XoralEventService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const internal = service as unknown as {
      installActiveRuntime(row: Record<string, unknown>): void;
    };
    internal.installActiveRuntime({
      event_id: "event-1",
      combat_entity_id: "xoral:event-1",
      owner_player_id: "p1",
      locked_participant_ids: ["p1", "p2"],
      excluded_participant_ids: ["p2"],
      lat: anchor.lat,
      lon: anchor.lon
    });

    expect(service.canPlayerAttack("p1", "xoral:event-1")).toBe(true);
    expect(service.canPlayerAttack("p2", "xoral:event-1")).toBe(false);
    expect(service.canPlayerAttack("outsider", "xoral:event-1")).toBe(false);
    expect(service.canPlayerAttack("p1", "xoral:dormant")).toBe(false);
  });

  it("fails closed for an archetype-only defeat candidate", () => {
    const service = new XoralEventService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    expect(service.ownsDefeatCandidate({
      settlementKey: "xoral-unowned",
      defeatedEntityId: "xoral:event-unowned",
      defeatGeneration: 1,
      eligibleParticipantIds: [],
      contributions: [],
      serverTick: 1,
      mobArchetype: "xoral"
    })).toBe(false);
  });
});

describe("XoralEventService start authority", () => {
  it.each([
    {
      role: "solo player",
      playerId: "solo",
      ownerPlayerId: "tree-chopper",
      party: null,
      participantIds: ["solo"],
      allowed: true
    },
    {
      role: "party leader",
      playerId: "leader",
      ownerPlayerId: "tree-chopper",
      party: {
        partyId: "party-1",
        leaderPlayerId: "leader",
        memberPlayerIds: ["leader", "tree-chopper"],
        revision: 4
      },
      participantIds: ["leader", "tree-chopper"],
      allowed: true
    },
    {
      role: "party follower",
      playerId: "tree-chopper",
      ownerPlayerId: "tree-chopper",
      party: {
        partyId: "party-1",
        leaderPlayerId: "leader",
        memberPlayerIds: ["leader", "tree-chopper"],
        revision: 4
      },
      participantIds: [],
      allowed: false
    }
  ])("enforces leader-or-solo authority for a $role", async ({
    playerId,
    ownerPlayerId,
    party,
    participantIds,
    allowed
  }) => {
    const dormant = {
      event_id: "event-1",
      source_tree_entity_id: "tree-1",
      population_zone_id: "population-zone-1",
      population_generation_id: "generation-1",
      owner_player_id: ownerPlayerId,
      combat_entity_id: "xoral:event-1",
      region_code: "US-NM",
      zone_id: "combat-zone-1",
      lat: anchor.lat,
      lon: anchor.lon,
      status: "dormant",
      locked_party_id: null,
      locked_participant_ids: [],
      excluded_participant_ids: [],
      defeat_candidate: null
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM xoral_events WHERE combat_entity_id")) return { rows: [dormant] };
      if (sql.includes("SET status='starting'")) {
        return { rows: [{ ...dormant, status: "starting", owner_player_id: params?.[3] }] };
      }
      return { rows: [] };
    });
    const service = new XoralEventService(
      { connect: async () => ({ query, release: vi.fn() }) } as never,
      {} as never,
      { partyForPlayer: () => party } as never,
      {
        getPlayer: () => ({ regionCode: dormant.region_code, position: anchor }),
        isWorldPresent: () => true
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    if (allowed) {
      await expect(service.start(playerId, dormant.combat_entity_id)).resolves.toMatchObject({
        eventId: dormant.event_id,
        participantIds
      });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("owner_player_id=$4"),
        [dormant.event_id, party?.partyId ?? null, JSON.stringify(participantIds), playerId]
      );
    } else {
      await expect(service.start(playerId, dormant.combat_entity_id)).rejects.toMatchObject({
        code: "XORAL_PARTY_LEADER_REQUIRED",
        message: "Only the party leader may start The Xoral"
      });
      expect(query).not.toHaveBeenCalledWith(
        expect.stringContaining("SET status='starting'"),
        expect.anything()
      );
    }
  });

  it("restores a starting event when the captured party changes before the lock is installed", async () => {
    const dormant = eventRow();
    let partyRevision = 4;
    const transactionQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM xoral_events WHERE combat_entity_id")) return { rows: [dormant] };
      if (sql.includes("SET status='starting'")) {
        partyRevision = 5;
        return { rows: [{ ...dormant, status: "starting", owner_player_id: "leader" }] };
      }
      return { rows: [] };
    });
    const resetQuery = vi.fn(async () => ({
      rowCount: 1,
      rows: [{ combat_entity_id: dormant.combat_entity_id }]
    }));
    const setBossEventState = vi.fn();
    const service = new XoralEventService(
      {
        connect: async () => ({ query: transactionQuery, release: vi.fn() }),
        query: resetQuery
      } as never,
      { setBossEventState } as never,
      {
        partyForPlayer: () => ({
          partyId: "party-1",
          leaderPlayerId: "leader",
          memberPlayerIds: ["leader", "member"],
          allowTravel: true,
          autoFollowPlayerIds: [],
          revision: partyRevision
        })
      } as never,
      {
        getPlayer: () => ({ regionCode: dormant.region_code, position: anchor }),
        isWorldPresent: () => true
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(service.start("leader", dormant.combat_entity_id)).rejects.toMatchObject({
      code: "XORAL_PARTY_CHANGED"
    });
    expect(resetQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status='dormant'"),
      [dormant.event_id]
    );
    expect(setBossEventState).toHaveBeenCalledWith(dormant.combat_entity_id, "dormant");
  });

  it.each([
    {
      description: "not world-present",
      player: { regionCode: "US-NM", position: anchor },
      worldPresent: false
    },
    {
      description: "in another region",
      player: { regionCode: "US-CO", position: anchor },
      worldPresent: true
    },
    {
      description: "outside the arena",
      player: { regionCode: "US-NM", position: { lat: anchor.lat + 0.02, lon: anchor.lon } },
      worldPresent: true
    }
  ])("rejects a start when the initiator is $description", async ({ player, worldPresent }) => {
    const dormant = eventRow();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM xoral_events WHERE combat_entity_id")) return { rows: [dormant] };
      return { rows: [] };
    });
    const service = new XoralEventService(
      { connect: async () => ({ query, release: vi.fn() }) } as never,
      {} as never,
      { partyForPlayer: () => null } as never,
      { getPlayer: () => player, isWorldPresent: () => worldPresent } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(service.start("solo", dormant.combat_entity_id)).rejects.toMatchObject({
      code: "XORAL_START_LOCATION_INVALID"
    });
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status='starting'"),
      expect.anything()
    );
    expect(service.blocksPartyGrowth("solo")).toBe(false);
  });

  it("reserves captured participants before the first await", async () => {
    const dormant = eventRow();
    let releaseConnect!: (client: unknown) => void;
    const waitingConnect = new Promise((resolve) => { releaseConnect = resolve; });
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM xoral_events WHERE combat_entity_id")) return { rows: [dormant] };
      if (sql.includes("SET status='starting'")) {
        return { rows: [{ ...dormant, status: "starting", owner_player_id: params?.[3] }] };
      }
      return { rows: [] };
    });
    const connect = vi.fn(() => waitingConnect);
    const service = new XoralEventService(
      { connect } as never,
      {} as never,
      { partyForPlayer: () => null } as never,
      {
        getPlayer: () => ({ regionCode: dormant.region_code, position: anchor }),
        isWorldPresent: () => true
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    const firstStart = service.start("solo", dormant.combat_entity_id);
    await expect(service.start("solo", "xoral:event-2")).rejects.toMatchObject({
      code: "XORAL_PARTICIPANT_BUSY"
    });
    expect(connect).toHaveBeenCalledTimes(1);

    releaseConnect({ query, release: vi.fn() });
    await expect(firstStart).resolves.toMatchObject({ participantIds: ["solo"] });
  });

  it("rejects before connecting while a party roster mutation is in progress", async () => {
    const leases = new OverworldBossParticipantLeaseCoordinator();
    let finishMutation!: () => void;
    const mutation = leases.runRosterMutation(() => new Promise<void>((resolve) => {
      finishMutation = resolve;
    }));
    const connect = vi.fn();
    const service = new XoralEventService(
      { connect } as never,
      {} as never,
      { partyForPlayer: () => null } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      Math.random,
      leases
    );

    await expect(service.start("solo", "xoral:event-1")).rejects.toMatchObject({
      code: "XORAL_PARTICIPANT_BUSY"
    });
    expect(connect).not.toHaveBeenCalled();

    finishMutation();
    await mutation;
  });

  it("retains the participant reservation when the commit outcome is indeterminate", async () => {
    const dormant = eventRow();
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM xoral_events WHERE combat_entity_id")) return { rows: [dormant] };
      if (sql.includes("SET status='starting'")) {
        return { rows: [{ ...dormant, status: "starting", owner_player_id: params?.[3] }] };
      }
      if (sql === "COMMIT") throw new Error("connection lost during commit");
      return { rows: [] };
    });
    const connect = vi.fn(async () => ({ query, release: vi.fn() }));
    const service = new XoralEventService(
      { connect } as never,
      {} as never,
      { partyForPlayer: () => null } as never,
      {
        getPlayer: () => ({ regionCode: dormant.region_code, position: anchor }),
        isWorldPresent: () => true
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(service.start("solo", dormant.combat_entity_id)).rejects.toThrow(
      "connection lost during commit"
    );
    expect(service.blocksPartyGrowth("solo")).toBe(true);
    await expect(service.start("solo", "xoral:event-2")).rejects.toMatchObject({
      code: "XORAL_PARTICIPANT_BUSY"
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("resets a retryable start without despawning the Xoral", async () => {
    const dormant = eventRow();
    const query = vi.fn(async () => ({
      rowCount: 1,
      rows: [{ combat_entity_id: dormant.combat_entity_id }]
    }));
    const setBossEventState = vi.fn();
    const despawnMob = vi.fn();
    const service = new XoralEventService(
      { query } as never,
      { setBossEventState, despawnMob } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(service.resetStartingEvent(dormant.event_id, ["leader", "member"]))
      .resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status='dormant'"),
      [dormant.event_id]
    );
    expect(setBossEventState).toHaveBeenCalledWith(dormant.combat_entity_id, "dormant");
    expect(despawnMob).not.toHaveBeenCalled();
  });

  it("recovers an interrupted start as a visible dormant Xoral", async () => {
    const starting = { ...eventRow(), status: "starting" };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [starting] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const spawnMob = vi.fn();
    const setBossEventState = vi.fn();
    const service = new XoralEventService(
      { query } as never,
      {
        entity: vi.fn(() => null),
        spawnMob,
        setBossEventState
      } as never,
      {} as never,
      { setMovementBlocked: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      { warn: vi.fn() } as never
    );

    await service.recover();
    service.stop();

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET status='dormant'"),
      [starting.event_id]
    );
    expect(spawnMob).toHaveBeenCalledWith(expect.objectContaining({
      entityId: starting.combat_entity_id,
      bossEventState: "dormant"
    }));
    expect(setBossEventState).not.toHaveBeenCalled();
  });

  it("restores dormant state on an existing Xoral projection during recovery", async () => {
    const starting = { ...eventRow(), status: "starting" };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [starting] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const spawnMob = vi.fn();
    const setBossEventState = vi.fn();
    const service = new XoralEventService(
      { query } as never,
      {
        entity: vi.fn(() => ({ entityId: starting.combat_entity_id })),
        spawnMob,
        setBossEventState
      } as never,
      {} as never,
      { setMovementBlocked: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      { warn: vi.fn() } as never
    );

    await service.recover();
    service.stop();

    expect(setBossEventState).toHaveBeenCalledWith(starting.combat_entity_id, "dormant");
    expect(spawnMob).not.toHaveBeenCalled();
  });
});

describe("XoralEventService race recovery", () => {
  it("cancels and despawns an active life on restart instead of rebuilding full health", async () => {
    const active = { ...eventRow(), status: "active", locked_participant_ids: ["leader"] };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [active] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const despawnMob = vi.fn();
    const service = new XoralEventService(
      { query } as never,
      { despawnMob } as never,
      {} as never,
      { setMovementBlocked: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await service.recover();
    service.stop();

    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("SET status='cancelled'"), [active.event_id]);
    expect(despawnMob).toHaveBeenCalledWith(active.combat_entity_id);
    expect(service.hasActiveEvent("leader")).toBe(false);
  });

  it("releases the shared participant lease after successful cancellation", async () => {
    const leases = new OverworldBossParticipantLeaseCoordinator();
    const service = new XoralEventService(
      { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) } as never,
      { despawnMob: vi.fn() } as never,
      {} as never,
      { setMovementBlocked: vi.fn() } as never,
      { send: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      Math.random,
      leases
    );
    const internal = service as unknown as {
      installActiveRuntime(row: Record<string, unknown>): void;
    };
    internal.installActiveRuntime({
      ...eventRow(),
      status: "active",
      owner_player_id: "leader",
      locked_participant_ids: ["leader", "member"]
    });
    expect(leases.isReserved("leader")).toBe(true);
    expect(leases.isReserved("member")).toBe(true);

    await expect(service.cancelForLeader("leader", "cancelled")).resolves.toBe(true);

    expect(leases.isReserved("leader")).toBe(false);
    expect(leases.isReserved("member")).toBe(false);
  });

  it("fails closed when active recovery conflicts with another boss lease", async () => {
    const leases = new OverworldBossParticipantLeaseCoordinator();
    expect(leases.acquire("future-boss:1", ["leader"])).toBe(true);
    const active = {
      ...eventRow(),
      status: "active",
      owner_player_id: "leader",
      locked_participant_ids: ["leader"]
    };
    const spawnMob = vi.fn();
    const service = new XoralEventService(
      { query: vi.fn(async () => ({ rows: [active] })) } as never,
      { spawnMob } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      Math.random,
      leases
    );

    await expect(service.recover()).rejects.toMatchObject({
      code: "XORAL_PARTICIPANT_BUSY"
    });
    expect(spawnMob).not.toHaveBeenCalled();
    expect(leases.isReserved("leader")).toBe(true);
  });

  it("has no cancellation side effects and reports no leader success when the active update loses", async () => {
    const despawnMob = vi.fn();
    const send = vi.fn();
    const setMovementBlocked = vi.fn();
    const service = new XoralEventService(
      { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) } as never,
      { despawnMob } as never,
      {} as never,
      { setMovementBlocked } as never,
      { send } as never,
      {} as never,
      {} as never,
      {} as never
    );
    const internal = service as unknown as {
      installActiveRuntime(row: Record<string, unknown>): void;
    };
    internal.installActiveRuntime({
      event_id: "event-1",
      combat_entity_id: "xoral:event-1",
      owner_player_id: "leader",
      locked_participant_ids: ["leader", "member"],
      excluded_participant_ids: [],
      lat: anchor.lat,
      lon: anchor.lon
    });

    await expect(service.confirmExit("leader")).rejects.toMatchObject({
      code: "XORAL_EVENT_NOT_ACTIVE"
    });
    expect(despawnMob).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(setMovementBlocked).not.toHaveBeenCalled();
    expect(service.hasActiveEvent("leader")).toBe(true);
  });

  it("resumes the stored settling candidate instead of replacing it", async () => {
    const callbackCandidate = defeatCandidate("later-callback", 2);
    const storedCandidate = defeatCandidate("stored-candidate", 1);
    const settling = {
      ...eventRow(),
      status: "settling",
      defeat_candidate: storedCandidate
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [settling] });
    const service = new XoralEventService(
      { query } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const finishSettlement = vi.fn(async () => undefined);
    (service as unknown as { finishSettlement: typeof finishSettlement }).finishSettlement =
      finishSettlement;

    await expect(service.acceptDefeat(callbackCandidate)).resolves.toBe(true);

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("status='active'"),
      [callbackCandidate.defeatedEntityId, JSON.stringify(callbackCandidate)]
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("status IN ('settling','defeated')"),
      [callbackCandidate.defeatedEntityId]
    );
    expect(finishSettlement).toHaveBeenCalledWith(settling);
  });

  it("serializes concurrent settlement and later defeated replay to one reward pass", async () => {
    const storedCandidate = defeatCandidate("stored-candidate", 1);
    let status: "settling" | "defeated" = "settling";
    let lockTail = Promise.resolve();
    const connect = vi.fn(async () => {
      let releaseLock: (() => void) | null = null;
      return {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("pg_advisory_xact_lock")) {
            const previous = lockTail;
            lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
            await previous;
            return { rows: [] };
          }
          if (
            sql.includes("FROM xoral_events WHERE event_id") &&
            sql.includes("FOR NO KEY UPDATE")
          ) {
            return {
              rows: [{
                ...eventRow(),
                status,
                owner_player_id: "leader",
                locked_participant_ids: ["leader"],
                defeat_candidate: storedCandidate
              }]
            };
          }
          if (sql.includes("SET status='defeated'")) {
            if (status !== "settling") return { rowCount: 0, rows: [] };
            status = "defeated";
            return { rowCount: 1, rows: [] };
          }
          if (sql === "COMMIT" || sql === "ROLLBACK") {
            releaseLock?.();
            releaseLock = null;
          }
          return { rows: [] };
        }),
        release: vi.fn()
      };
    });
    const service = new XoralEventService(
      { connect } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const grantReward = vi.fn(async () => undefined);
    const internal = service as unknown as {
      finishSettlement(row: Record<string, unknown>): Promise<void>;
      grantReward: typeof grantReward;
    };
    internal.grantReward = grantReward;
    const settling = {
      ...eventRow(),
      status: "settling",
      locked_participant_ids: ["leader"],
      defeat_candidate: storedCandidate
    };

    await Promise.all([
      internal.finishSettlement(settling),
      internal.finishSettlement(settling)
    ]);
    await internal.finishSettlement(settling);

    expect(grantReward).toHaveBeenCalledOnce();
    expect(grantReward).toHaveBeenCalledWith(
      expect.objectContaining({ status: "settling", defeat_candidate: storedCandidate }),
      "leader",
      100
    );
    expect(status).toBe("defeated");
  });
});

function eventRow() {
  return {
    event_id: "event-1",
    source_tree_entity_id: "tree-1",
    population_zone_id: "population-zone-1",
    population_generation_id: "generation-1",
    owner_player_id: "tree-chopper",
    combat_entity_id: "xoral:event-1",
    region_code: "US-NM",
    zone_id: "combat-zone-1",
    lat: anchor.lat,
    lon: anchor.lon,
    status: "dormant",
    locked_party_id: null,
    locked_participant_ids: [],
    excluded_participant_ids: [],
    defeat_candidate: null
  };
}

function defeatCandidate(settlementKey: string, defeatGeneration: number) {
  return {
    settlementKey,
    defeatedEntityId: "xoral:event-1",
    defeatGeneration,
    eligibleParticipantIds: ["leader"],
    contributions: [{ entityId: "leader", damage: 100 }],
    serverTick: 100 + defeatGeneration,
    mobArchetype: "xoral" as const,
    bossOwnership: {
      bossId: "xoral",
      bossRevision: 1,
      encounterHandlerId: "xoral",
      hostKind: "overworld" as const,
      hostInstanceId: "event-1",
      encounterInstanceId: "event-1",
      lifeGeneration: defeatGeneration
    }
  };
}
