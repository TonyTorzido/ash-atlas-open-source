/**
 * Ash Heart puzzle rooms. The client simulates a puzzle on the room floor and
 * reports a solve; the server checks it against this registry (right room, the
 * seal still closed, enough time spent in the room) and then fires the seal
 * object's normal `object_interact` trigger, which opens the next door.
 */
export type HeartPuzzleDefinition = Readonly<{
  dungeonId: string;
  roomId: string;
  /** Switch object whose triggers a verified solve fires. Players cannot interact with it directly. */
  sealObjectId: string;
  /** Hint NPC standing in the room. */
  npcObjectId: string;
  /** Server minimum: seconds in the room before a solve is believable. */
  minSolveMs: number;
  /** Top-left of the puzzle board in room units, where the room art leaves its floor slot. */
  boardOrigin: Readonly<{ x: number; y: number }>;
  /**
   * The board layout, one character per cell (see the client's vault types for the legend). The server reads
   * its size for player collision: until the seal opens, the whole board footprint blocks players.
   */
  rows: readonly string[];
  /** The board turns by itself (its walls move). */
  turning?: boolean;
}>;

/** Board cell size in room units. */
export const HEART_PUZZLE_CELL = 80;

/** Extra room units beyond Old Pell's interaction radius the server allows when a puzzle is started. */
export const HEART_PUZZLE_START_SLACK = 60;

export const HEART_PUZZLES: readonly HeartPuzzleDefinition[] = [
  { dungeonId: "tilted_vault", roomId: "vault_r1", sealObjectId: "vault_seal_1", npcObjectId: "vault_pell_1", minSolveMs: 7_000, boardOrigin: { x: 180, y: 310 },
    rows: [
    "#########",
    "#S..o...#",
    "#.#.o.#.#",
    "#.#...#.#",
    "#.####o.#",
    "#.o.....#",
    "#...###.#",
    "###.#...#",
    "#...#.###",
    "#.###.o.#",
    "#...o...#",
    "#.#.###.#",
    "#g..oo..#"
  ]
  },
  { dungeonId: "tilted_vault", roomId: "vault_r2", sealObjectId: "vault_seal_2", npcObjectId: "vault_pell_2", minSolveMs: 8_000, boardOrigin: { x: 180, y: 290 },
    rows: [
    "#########",
    "#S.....T#",
    "#.#####.#",
    "#.......#",
    "#.##v##.#",
    "#.#...#.#",
    "#.#.a.#.#",
    "#.#####.#",
    "#b......#",
    "#########"
  ]
  },
  { dungeonId: "tilted_vault", roomId: "vault_r3", sealObjectId: "vault_seal_3", npcObjectId: "vault_pell_3", minSolveMs: 8_000, boardOrigin: { x: 180, y: 270 },
    rows: [
    "#########",
    "#S.c.c..#",
    "#######.#",
    "#.c.c.c.#",
    "#.#######",
    "#...c..g#",
    "#########"
  ],
    turning: true
  },
  { dungeonId: "tilted_vault", roomId: "vault_r4", sealObjectId: "vault_seal_4", npcObjectId: "vault_pell_4", minSolveMs: 6_000, boardOrigin: { x: 180, y: 320 },
    rows: [
    "#########",
    "#B......#",
    "#.#####.#",
    "#.......#",
    "#.#####.#",
    "#.......#",
    "#.o...o.#",
    "#.......#",
    "####w####",
    "#.......#",
    "#...g...#",
    "#########"
  ]
  }
];

export const heartPuzzleForRoom = (dungeonId: string, roomId: string): HeartPuzzleDefinition | null =>
  HEART_PUZZLES.find((puzzle) => puzzle.dungeonId === dungeonId && puzzle.roomId === roomId) ?? null;

export const heartPuzzleForSeal = (roomId: string, objectId: string): HeartPuzzleDefinition | null =>
  HEART_PUZZLES.find((puzzle) => puzzle.roomId === roomId && puzzle.sealObjectId === objectId) ?? null;

export type HeartPuzzleVerdict = Readonly<{ ok: true } | { ok: false; reason: "unknown_room" | "too_fast" }>;

/** Pure server-side sanity check for a reported solve. `msInRoom` is measured by the server. */
export const verifyHeartPuzzleSolve = (
  dungeonId: string,
  roomId: string,
  msInRoom: number
): HeartPuzzleVerdict => {
  const puzzle = heartPuzzleForRoom(dungeonId, roomId);
  if (!puzzle) return { ok: false, reason: "unknown_room" };
  return msInRoom >= puzzle.minSolveMs ? { ok: true } : { ok: false, reason: "too_fast" };
};

export const heartPuzzleForNpc = (objectId: string): HeartPuzzleDefinition | null =>
  HEART_PUZZLES.find((puzzle) => puzzle.npcObjectId === objectId) ?? null;

export type HeartPuzzleBoardCollider = Readonly<{ id: string; minX: number; maxX: number; minY: number; maxY: number }>;

/**
 * Player colliders for an unsolved board, in room units: the whole board footprint (every row and column the
 * layout spans) is one solid rectangle until the seal opens, so no corridor, hole or open board edge can be
 * walked into. After the solve the board is plain floor.
 */
export const heartPuzzleBoardColliders = (puzzle: HeartPuzzleDefinition): readonly HeartPuzzleBoardCollider[] => {
  const { minX, maxX, minY, maxY } = heartPuzzleBoardFootprint(puzzle);
  const inset = HEART_PUZZLE_FOOTPRINT_INSET;
  return [{ id: `${puzzle.roomId}_board`, minX: minX + inset, maxX: maxX - inset, minY: minY + inset, maxY: maxY - inset }];
};

/**
 * Room units the solid footprint is pulled in from the board edge, so a player standing right against the board
 * (Maze 1's escape door sits one body width under its open bottom row) still fits. Far less than half a cell.
 */
export const HEART_PUZZLE_FOOTPRINT_INSET = 8;

/** The board's footprint in room units. */
export const heartPuzzleBoardFootprint = (
  puzzle: HeartPuzzleDefinition
): Readonly<{ minX: number; maxX: number; minY: number; maxY: number }> => {
  const cols = Math.max(0, ...puzzle.rows.map((row) => row.length));
  const { x, y } = puzzle.boardOrigin;
  return { minX: x, maxX: x + cols * HEART_PUZZLE_CELL, minY: y, maxY: y + puzzle.rows.length * HEART_PUZZLE_CELL };
};
