import { describe, expect, it } from "vitest";

import { INTERIOR_DATA } from "./data/interiors/index.js";
import { cisternWarrensRoomNavigation } from "./dungeon.js";
import { DUNGEON_CATALOG } from "./dungeonCatalog.js";
import { findIndoorNavigationRoute, isIndoorNavigationPointWalkable } from "./indoor.js";
import {
  HEART_PUZZLE_CELL, HEART_PUZZLE_FOOTPRINT_INSET, HEART_PUZZLE_START_SLACK, HEART_PUZZLES, heartPuzzleBoardColliders, heartPuzzleBoardFootprint, heartPuzzleForRoom, heartPuzzleForSeal,
  verifyHeartPuzzleSolve
} from "./heartPuzzles.js";

type Room = { id: string; objects: Array<{ id: string }> };

describe("heart puzzle registry", () => {
  it("points at real rooms, seal switches and hint NPCs in the scaffolded dungeon", () => {
    for (const puzzle of HEART_PUZZLES) {
      const space = INTERIOR_DATA.spaces.find((candidate) => candidate.id === puzzle.dungeonId);
      expect(space, puzzle.dungeonId).toBeTruthy();
      const room = (space!.rooms as unknown as Room[]).find((candidate) => candidate.id === puzzle.roomId);
      expect(room, puzzle.roomId).toBeTruthy();
      const ids = room!.objects.map((object) => object.id);
      expect(ids).toContain(puzzle.sealObjectId);
      expect(ids).toContain(puzzle.npcObjectId);
    }
  });

  it("looks puzzles up by room and by seal", () => {
    expect(heartPuzzleForRoom("tilted_vault", "vault_r2")?.sealObjectId).toBe("vault_seal_2");
    expect(heartPuzzleForSeal("vault_r3", "vault_seal_3")?.roomId).toBe("vault_r3");
    expect(heartPuzzleForSeal("vault_r3", "vault_seal_1")).toBeNull();
  });

  it("rejects solves that are too fast or in a room without a puzzle", () => {
    expect(verifyHeartPuzzleSolve("tilted_vault", "vault_r1", 500)).toEqual({ ok: false, reason: "too_fast" });
    expect(verifyHeartPuzzleSolve("tilted_vault", "vault_r1", 60_000)).toEqual({ ok: true });
    expect(verifyHeartPuzzleSolve("tilted_vault", "nowhere", 60_000)).toEqual({ ok: false, reason: "unknown_room" });
  });

  it("walks on the painted floor only: anchors on the floor, the walls and the board slot edges respected", () => {
    for (const puzzle of HEART_PUZZLES) {
      const dungeon = DUNGEON_CATALOG.dungeons.find((candidate) => candidate.id === puzzle.dungeonId)!;
      const room = dungeon.rooms.find((candidate) => candidate.id === puzzle.roomId)!;
      const navigation = cisternWarrensRoomNavigation(room.id, dungeon);
      expect(navigation.walkableSurfaces?.[0]?.length, room.id).toBeGreaterThan(4);
      for (const anchor of room.anchors) {
        if (anchor.id.startsWith("vault_pell_")) continue;
        expect(isIndoorNavigationPointWalkable(navigation, anchor), `${room.id}.${anchor.id}`).toBe(true);
      }
      // The back facade, both side walls and the bottom cap are solid.
      for (const wall of [{ x: room.width / 2, y: 60 }, { x: 20, y: room.height / 2 }, { x: room.width - 20, y: room.height / 2 }, { x: room.width / 2, y: room.height - 20 }]) {
        expect(isIndoorNavigationPointWalkable(navigation, wall), `${room.id} wall ${wall.x},${wall.y}`).toBe(false);
      }
      expect(isIndoorNavigationPointWalkable(navigation, puzzle.boardOrigin), `${room.id} board origin`).toBe(true);
    }
  });

  it("unsolved boards block their whole footprint, and every room stays playable around them", () => {
    for (const puzzle of HEART_PUZZLES) {
      const dungeon = DUNGEON_CATALOG.dungeons.find((candidate) => candidate.id === puzzle.dungeonId)!;
      const room = dungeon.rooms.find((candidate) => candidate.id === puzzle.roomId)!;
      const base = cisternWarrensRoomNavigation(room.id, dungeon);
      const colliders = heartPuzzleBoardColliders(puzzle);
      const footprint = heartPuzzleBoardFootprint(puzzle);
      expect(colliders, room.id).toEqual([{
        id: `${room.id}_board`,
        minX: footprint.minX + HEART_PUZZLE_FOOTPRINT_INSET, maxX: footprint.maxX - HEART_PUZZLE_FOOTPRINT_INSET,
        minY: footprint.minY + HEART_PUZZLE_FOOTPRINT_INSET, maxY: footprint.maxY - HEART_PUZZLE_FOOTPRINT_INSET
      }]);
      const locked = { ...base, colliders: [...base.colliders, ...colliders] };
      const inFootprint = (point: { x: number; y: number }) =>
        point.x >= footprint.minX && point.x <= footprint.maxX && point.y >= footprint.minY && point.y <= footprint.maxY;
      // Every cell of the board, corridors and open edges included, is solid before the solve.
      puzzle.rows.forEach((row, r) => {
        for (let c = 0; c < row.length; c += 1) {
          const centre = { x: puzzle.boardOrigin.x + (c + 0.5) * HEART_PUZZLE_CELL, y: puzzle.boardOrigin.y + (r + 0.5) * HEART_PUZZLE_CELL };
          expect(isIndoorNavigationPointWalkable(locked, centre), `${room.id} cell ${c},${r}`).toBe(false);
        }
      });
      // Spawn, every door/seal anchor and the routes between them stay open (the board is walked around).
      for (const anchor of room.anchors) {
        if (anchor.id.startsWith("vault_pell_") || anchor.id === "death_recovery") continue;
        expect(inFootprint(anchor), `${room.id}.${anchor.id} outside the board`).toBe(false);
        expect(isIndoorNavigationPointWalkable(locked, anchor), `${room.id}.${anchor.id}`).toBe(true);
        expect(findIndoorNavigationRoute(locked, base.spawn, anchor), `${room.id} spawn to ${anchor.id}`).toBeTruthy();
      }
      // Old Pell can be talked to (and his puzzle started) from a reachable spot outside the board.
      const pell = room.anchors.find((anchor) => anchor.id === `${puzzle.npcObjectId}_anchor`)!;
      const npc = room.objects.find((object) => object.id === puzzle.npcObjectId)!;
      const talkSpots: Array<{ x: number; y: number }> = [];
      for (const reach of [0.35, 0.55, 0.8]) {
        for (let i = 0; i < 16; i += 1) {
          const angle = (i / 16) * Math.PI * 2;
          talkSpots.push({ x: pell.x + Math.cos(angle) * npc.interactionRadius * reach, y: pell.y + Math.sin(angle) * npc.interactionRadius * reach });
        }
      }
      const reachable = talkSpots.filter((spot) => !inFootprint(spot) && isIndoorNavigationPointWalkable(locked, spot) &&
        findIndoorNavigationRoute(locked, base.spawn, spot) !== null);
      expect(reachable.length, `${room.id} Pell talk spots`).toBeGreaterThan(0);
      for (const spot of reachable) {
        expect(Math.hypot(spot.x - pell.x, spot.y - pell.y), `${room.id} talk range`).toBeLessThanOrEqual(npc.interactionRadius + HEART_PUZZLE_START_SLACK);
      }
      // After the solve the board is plain floor again.
      const start = puzzle.rows.findIndex((row) => row.includes("S") || row.includes("B"));
      const startCol = puzzle.rows[start]!.search(/[SB]/);
      const startCell = { x: puzzle.boardOrigin.x + (startCol + 0.5) * HEART_PUZZLE_CELL, y: puzzle.boardOrigin.y + (start + 0.5) * HEART_PUZZLE_CELL };
      expect(isIndoorNavigationPointWalkable(base, startCell), `${room.id} board after solve`).toBe(true);
    }
  });

  it("maze 1 (no bottom wall row) is solid down to its last row until solved", () => {
    const puzzle = heartPuzzleForRoom("tilted_vault", "vault_r1")!;
    expect(puzzle.rows[puzzle.rows.length - 1]).not.toMatch(/^#+$/);
    const footprint = heartPuzzleBoardFootprint(puzzle);
    expect(footprint.maxY).toBe(puzzle.boardOrigin.y + puzzle.rows.length * HEART_PUZZLE_CELL);
  });
});
