import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  DEFAULT_PLAYER_FACE_APPEARANCE_ID,
  faceFeatureArea,
  SALON_CHAIR,
  SALON_CHAIR_APPROACH,
  SALON_CHAIR_INTERACTION_RADIUS,
  SALON_DOOR,
  SALON_INTERACTION_APPROACH_INSET,
  SALON_MAIN_ROOM,
  SALON_SPAWN,
  indoorInteractionApproachPoint,
  SALON_INTERIOR_ROOM,
  findIndoorNavigationRoute,
  interiorNavigation,
  isIndoorNavigationPointWalkable,
  type PlayerSalonStyles
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { SalonError, SalonRuntime, SalonService, type SalonPresence } from "./salon.js";

const presence: SalonPresence = {
  playerId: "player-1",
  structureId: "salon-1",
  sessionId: "00000000-0000-4000-8000-000000000001",
  localX: SALON_SPAWN.x,
  localY: SALON_SPAWN.y,
  returnRegionCode: "region-1",
  returnLat: 40,
  returnLon: -105
};

describe("Salon room navigation from the interior space", () => {
  it("blocks and routes exactly like the legacy room-bounds navigation", () => {
    const navigation = interiorNavigation(SALON_INTERIOR_ROOM);
    const points: { x: number; y: number }[] = [
      { x: 24, y: 24 }, { x: 976, y: 976 }, { x: 23.9, y: 500 }, { x: 976.1, y: 500 }, SALON_SPAWN, SALON_CHAIR_APPROACH
    ];
    for (let x = 0; x <= 1000; x += 41) for (let y = 0; y <= 1000; y += 43) points.push({ x, y });
    for (const point of points) {
      expect(isIndoorNavigationPointWalkable(navigation, point)).toBe(isIndoorNavigationPointWalkable(SALON_MAIN_ROOM, point));
    }
    const walkable = points.filter((point) => isIndoorNavigationPointWalkable(SALON_MAIN_ROOM, point));
    for (let from = 0; from < walkable.length; from += 11) for (let to = 1; to < walkable.length; to += 13) {
      expect(findIndoorNavigationRoute(navigation, walkable[from]!, walkable[to]!))
        .toEqual(findIndoorNavigationRoute(SALON_MAIN_ROOM, walkable[from]!, walkable[to]!));
    }
  });
});

describe("SalonRuntime", () => {
  it("keeps movement server-authoritative and chair interaction sequence-bound", () => {
    const runtime = new SalonRuntime();
    runtime.enter(presence);
    const approach = indoorInteractionApproachPoint(
      SALON_SPAWN,
      SALON_CHAIR,
      SALON_CHAIR_INTERACTION_RADIUS,
      SALON_INTERACTION_APPROACH_INSET
    );
    const walking = runtime.moveTo(
      presence.playerId,
      presence.sessionId,
      approach.x,
      approach.y
    );
    expect(walking.position.moving).toBe(true);
    expect(() => runtime.authorizeChair(
      presence.playerId,
      presence.sessionId,
      walking.movementSequence
    )).toThrowError(SalonError);

    let arrived = walking;
    for (let index = 0; index < 20 && arrived.position.moving; index += 1) {
      arrived = runtime.tick(0.25)[0]!;
    }
    expect(arrived.position.moving).toBe(false);
    expect(runtime.authorizeChair(
      presence.playerId,
      presence.sessionId,
      arrived.movementSequence
    ).sessionId).toBe(presence.sessionId);
  });

  it("requires the durable session and a nearby door for exit", () => {
    const runtime = new SalonRuntime();
    runtime.enter({ ...presence, localX: SALON_DOOR.x, localY: SALON_DOOR.y });
    expect(runtime.isNearDoor(presence.playerId, presence.sessionId)).toBe(true);
    expect(() => runtime.exit(presence.playerId, "00000000-0000-4000-8000-000000000002"))
      .toThrowError(SalonError);
    runtime.exit(presence.playerId, presence.sessionId);
    expect(runtime.get(presence.playerId)).toBeNull();
  });

  it("rejects out-of-bounds and oversized targets", () => {
    const runtime = new SalonRuntime();
    runtime.enter(presence);
    expect(() => runtime.moveTo(presence.playerId, presence.sessionId, -1, 20))
      .toThrowError(SalonError);
    expect(() => runtime.moveTo(presence.playerId, presence.sessionId, 999, 999))
      .toThrowError(SalonError);
  });

  it("rejects the chair center and routes around its inflated collider", () => {
    const runtime = new SalonRuntime();
    runtime.enter(presence);
    expect(() => runtime.moveTo(
      presence.playerId,
      presence.sessionId,
      SALON_CHAIR.x,
      SALON_CHAIR.y
    )).toThrowError(SalonError);

    let current = runtime.moveTo(presence.playerId, presence.sessionId, 500, 50);
    expect(current.position).toMatchObject({ targetX: 411, targetY: 239 });
    for (let index = 0; index < 30 && current.position.moving; index += 1) {
      const changed = runtime.tick(0.25);
      expect(changed).toHaveLength(1);
      current = changed[0]!;
      expect(isIndoorNavigationPointWalkable(SALON_MAIN_ROOM, current.position)).toBe(true);
    }
    expect(current.position).toMatchObject({
      x: 500,
      y: 50,
      targetX: null,
      targetY: null,
      moving: false
    });

    const lateralRuntime = new SalonRuntime();
    lateralRuntime.enter({ ...presence, localX: 100, localY: SALON_CHAIR.y });
    let approaching = lateralRuntime.moveTo(
      presence.playerId,
      presence.sessionId,
      SALON_CHAIR_APPROACH.x,
      SALON_CHAIR_APPROACH.y
    );
    expect(approaching.position).toMatchObject({ targetX: 411, targetY: 239 });
    for (let index = 0; index < 20 && approaching.position.moving; index += 1) {
      approaching = lateralRuntime.tick(0.25)[0]!;
      expect(isIndoorNavigationPointWalkable(SALON_MAIN_ROOM, approaching.position)).toBe(true);
    }
    expect(approaching.position).toMatchObject({
      x: SALON_CHAIR_APPROACH.x,
      y: SALON_CHAIR_APPROACH.y,
      targetX: null,
      targetY: null,
      moving: false
    });

    const crossingRuntime = new SalonRuntime();
    crossingRuntime.enter(presence);
    crossingRuntime.place(presence.playerId, presence.sessionId, { x: 450, y: 240 });
    crossingRuntime.moveTo(presence.playerId, presence.sessionId, 500, 50);
    const afterCorner = crossingRuntime.tick(0.25)[0]!;
    expect(afterCorner.position.x).toBeCloseTo(411);
    expect(afterCorner.position.y).toBeLessThan(239);
    expect(afterCorner.position.moving).toBe(true);
  });

  it("clears stale route waypoints when movement is stopped or replaced", () => {
    const runtime = new SalonRuntime();
    runtime.enter(presence);
    runtime.moveTo(presence.playerId, presence.sessionId, 500, 50);
    runtime.tick(0.25);
    runtime.stop(presence.playerId);
    const stopped = runtime.get(presence.playerId)!;
    expect(stopped.position.moving).toBe(false);
    expect(runtime.tick(0.25)).toEqual([]);

    runtime.moveTo(presence.playerId, presence.sessionId, 500, 50);
    runtime.tick(0.25);
    let current = runtime.moveTo(presence.playerId, presence.sessionId, 800, 790);
    for (let index = 0; index < 30 && current.position.moving; index += 1) {
      current = runtime.tick(0.25)[0]!;
    }
    expect(current.position).toMatchObject({
      x: 800,
      y: 790,
      targetX: null,
      targetY: null,
      moving: false
    });
  });

  it("recovers blocked legacy positions while preserving valid saved positions", () => {
    const recoveredPersistence = vi.fn(async () => undefined);
    const recoveredRuntime = new SalonRuntime(recoveredPersistence);
    const recovered = recoveredRuntime.enter({ ...presence, localX: 500, localY: 225 });
    expect(recovered.position).toMatchObject({ x: SALON_SPAWN.x, y: SALON_SPAWN.y });
    expect(recoveredPersistence).toHaveBeenCalledOnce();
    expect(recoveredPersistence).toHaveBeenCalledWith(
      presence.playerId,
      presence.structureId,
      SALON_SPAWN.x,
      SALON_SPAWN.y
    );
    expect(recoveredRuntime.moveTo(
      presence.playerId,
      presence.sessionId,
      800,
      790
    ).position.moving).toBe(true);

    const validPersistence = vi.fn(async () => undefined);
    const validRuntime = new SalonRuntime(validPersistence);
    const valid = validRuntime.enter({ ...presence, localX: 700, localY: 700 });
    expect(valid.position).toMatchObject({ x: 700, y: 700 });
    expect(validPersistence).not.toHaveBeenCalled();
  });
});

describe("SalonService appearance writes", () => {
  it("emits and saves only the canonical face while rejecting legacy nose/mouth", async () => {
    const database = new FakeSalonDatabase();
    const service = new SalonService(database as never, "a".repeat(40));
    const runtime = new SalonRuntime().enter(presence);
    const editor = await service.beginCustomize(presence.playerId, runtime);

    expect(editor.styles).toMatchObject({
      eyes: DEFAULT_PLAYER_FACE_APPEARANCE_ID,
      hair: "spikey-hair",
      legs: "black-pants",
      beard: null,
      skinToneId: "light"
    });
    expect(editor.styles).not.toHaveProperty("nose_mouth");
    const saved = await service.save({
      playerId: presence.playerId,
      requestId: "face-1",
      editorSessionId: editor.editorSessionId,
      expectedAppearanceRevision: 0,
      catalogRevision: editor.catalogRevision,
      changes: { eyes: DEFAULT_PLAYER_FACE_APPEARANCE_ID }
    });
    expect(saved.styles).toMatchObject({ eyes: DEFAULT_PLAYER_FACE_APPEARANCE_ID });
    expect(saved.styles).not.toHaveProperty("nose_mouth");

    await expect(service.save({
      playerId: presence.playerId,
      requestId: "face-legacy",
      editorSessionId: editor.editorSessionId,
      expectedAppearanceRevision: 1,
      catalogRevision: editor.catalogRevision,
      changes: { nose_mouth: "mouth-1" }
    })).rejects.toMatchObject({ code: "SALON_CATEGORY_INVALID" });

    await expect(service.save({
      playerId: presence.playerId,
      requestId: "face-null",
      editorSessionId: editor.editorSessionId,
      expectedAppearanceRevision: 1,
      catalogRevision: editor.catalogRevision,
      changes: { eyes: null }
    })).resolves.toMatchObject({
      revision: 2,
      styles: { eyes: DEFAULT_PLAYER_FACE_APPEARANCE_ID }
    });

    const styled = await service.save({
      playerId: presence.playerId,
      requestId: "beard-and-skin",
      editorSessionId: editor.editorSessionId,
      expectedAppearanceRevision: 2,
      catalogRevision: editor.catalogRevision,
      changes: { beard: "black-beard", skinToneId: "dark" }
    });
    expect(styled).toMatchObject({
      revision: 3,
      styles: { beard: "black-beard", skinToneId: "dark" }
    });
  });

  it("saves face feature points inside their area, rejects outside points, and replays", async () => {
    const database = new FakeSalonDatabase();
    const service = new SalonService(database as never, "a".repeat(40));
    const runtime = new SalonRuntime().enter(presence);
    const editor = await service.beginCustomize(presence.playerId, runtime);
    expect(editor.styles).not.toHaveProperty("nose");
    expect(editor.styles).not.toHaveProperty("featurePoints");
    const eyesArea = faceFeatureArea(DEFAULT_PLAYER_APPEARANCE_CATALOG, "eyes")!;
    const inside = { x: eyesArea.defaultPoint.x + 0.5, y: eyesArea.defaultPoint.y };
    const input = {
      playerId: presence.playerId,
      requestId: "feature-1",
      editorSessionId: editor.editorSessionId,
      expectedAppearanceRevision: 0,
      catalogRevision: editor.catalogRevision,
      changes: { nose: null, mouth: null, featurePoints: { eyes: inside } }
    };
    const saved = await service.save(input);
    expect(saved).toMatchObject({ revision: 1, replayed: false, styles: { featurePoints: { eyes: inside } } });
    expect(saved.styles).not.toHaveProperty("nose");
    expect(saved.styles).not.toHaveProperty("mouth");
    expect(database.points.slice(0, 2)).toEqual([inside.x, inside.y]);
    await expect(service.save(input)).resolves.toMatchObject({ revision: 1, replayed: true });
    await expect(service.save({ ...input, changes: { featurePoints: {} } }))
      .rejects.toMatchObject({ code: "SALON_IDEMPOTENCY_CONFLICT" });

    await expect(service.save({
      ...input,
      requestId: "feature-outside",
      expectedAppearanceRevision: 1,
      changes: { featurePoints: { eyes: { x: 400, y: 400 } } }
    })).rejects.toMatchObject({ code: "SALON_FEATURE_POINT_INVALID" });
    await expect(service.save({
      ...input,
      requestId: "feature-nan",
      expectedAppearanceRevision: 1,
      changes: { featurePoints: { nose: { x: Number.NaN, y: 0 } } }
    })).rejects.toMatchObject({ code: "SALON_FEATURE_POINT_INVALID" });
    expect(database.points.slice(0, 2)).toEqual([inside.x, inside.y]);

    // A stored point left outside a redrawn area falls back to the default on load.
    database.points = [400, 400, null, null, null, null];
    const reopened = await service.beginCustomize(presence.playerId, runtime);
    expect(reopened.styles).not.toHaveProperty("featurePoints");
  });

  it("never changes a worn mask: mask changes in a Salon save are ignored", async () => {
    const database = new FakeSalonDatabase();
    (database as unknown as { mask: string | null }).mask = "hockey-mask";
    const service = new SalonService(database as never, "a".repeat(40));
    const runtime = new SalonRuntime().enter(presence);
    const editor = await service.beginCustomize(presence.playerId, runtime);
    const saved = await service.save({
      playerId: presence.playerId,
      requestId: "mask-ignored",
      editorSessionId: editor.editorSessionId,
      expectedAppearanceRevision: 0,
      catalogRevision: editor.catalogRevision,
      changes: { beard: "black-beard", mask: null }
    });
    expect(saved.styles).toMatchObject({ beard: "black-beard", mask: "hockey-mask" });
    expect((database as unknown as { mask: string | null }).mask).toBe("hockey-mask");
  });

  it("accepts Legs, replays it after retirement, and rejects Chest", async () => {
    const legsAppearance = DEFAULT_PLAYER_APPEARANCE_CATALOG.appearances.find(
      ({ appearanceId }) => appearanceId === "black-pants"
    )!;
    const database = new FakeSalonDatabase();
    const service = new SalonService(database as never, "a".repeat(40));
    const runtime = new SalonRuntime().enter(presence);
    const priorRetired = legsAppearance.retired;
    try {
      const editor = await service.beginCustomize(presence.playerId, runtime);
      const input = {
        playerId: presence.playerId,
        requestId: "save-1",
        editorSessionId: editor.editorSessionId,
        expectedAppearanceRevision: 0,
        catalogRevision: editor.catalogRevision,
        changes: { legs: "black-pants" }
      };

      const saved = await service.save(input);
      expect(saved).toMatchObject({
        revision: 1,
        replayed: false,
        styles: { legs: "black-pants" }
      });
      legsAppearance.retired = true;
      expect(await service.save(input)).toMatchObject({ revision: 1, replayed: true });
      await expect(service.save({
        ...input,
        requestId: "save-2",
        expectedAppearanceRevision: 1,
        changes: { chest: "legacy_chest" }
      })).rejects.toMatchObject({ code: "SALON_CATEGORY_INVALID" });
      await expect(service.save({
        ...input,
        requestId: "save-3",
        expectedAppearanceRevision: 1,
        changes: { eyes: "not-deployed" }
      })).rejects.toMatchObject({ code: "SALON_APPEARANCE_UNAVAILABLE" });
    } finally {
      if (priorRetired === undefined) delete legsAppearance.retired;
      else legsAppearance.retired = priorRetired;
    }
  });
});

class FakeSalonDatabase {
  private readonly operations = new Map<string, {
    requestHash: string;
    result: { styles: PlayerSalonStyles; revision: number } | null;
  }>();
  private revision = 0;
  private hair: string | null = "spikey-hair";
  private eyes: string | null = "brown-eyes";
  private beard: string | null = null;
  private mask: string | null = null;
  private legs: string | null = "black-pants";
  private skinToneId: string | null = "light";
  private nose: string | null = null;
  private mouth: string | null = null;
  points: Array<number | null> = [null, null, null, null, null, null];

  query = async (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (text.includes("FROM players WHERE id=$1") && !text.includes("FOR UPDATE")) {
      return { rows: [this.playerRow()], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  connect = async () => ({
    query: async (text: string, values: unknown[] = []) => {
      if (text.includes("FROM salon_appearance_operations")) {
        const operation = this.operations.get(String(values[0]));
        return operation
          ? { rows: [{ request_hash: operation.requestHash, result: operation.result }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM players WHERE id=$1 FOR UPDATE")) {
        return { rows: [this.playerRow()], rowCount: 1 };
      }
      if (text.includes("INSERT INTO salon_appearance_operations")) {
        this.operations.set(String(values[0]), {
          requestHash: String(values[4]),
          result: null
        });
      }
      if (text.includes("UPDATE players SET")) {
        this.hair = values[1] as string | null;
        this.eyes = values[2] as string | null;
        this.beard = values[4] as string | null;
        this.mask = values[5] as string | null;
        this.legs = values[6] as string | null;
        this.skinToneId = values[7] as string | null;
        this.revision = Number(values[8]);
        this.nose = values[9] as string | null;
        this.mouth = values[10] as string | null;
        this.points = values.slice(11, 17) as Array<number | null>;
      }
      if (text.includes("UPDATE salon_appearance_operations SET")) {
        const operation = this.operations.get(String(values[0]));
        if (operation) {
          operation.result = JSON.parse(String(values[2])) as {
            styles: PlayerSalonStyles;
            revision: number;
          };
        }
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined
  });

  private playerRow() {
    return {
      hair_appearance_id: this.hair,
      eyes_appearance_id: this.eyes,
      nose_mouth_appearance_id: null,
      nose_appearance_id: this.nose,
      mouth_appearance_id: this.mouth,
      eyes_feature_x: this.points[0] ?? null,
      eyes_feature_y: this.points[1] ?? null,
      nose_feature_x: this.points[2] ?? null,
      nose_feature_y: this.points[3] ?? null,
      mouth_feature_x: this.points[4] ?? null,
      mouth_feature_y: this.points[5] ?? null,
      beard_appearance_id: this.beard,
      mask_appearance_id: this.mask,
      legs_overlay_appearance_id: this.legs,
      skin_tone_id: this.skinToneId,
      base_appearance_revision: this.revision
    };
  }
}
