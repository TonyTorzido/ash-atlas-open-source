import type { Vec2 } from "../sensorMath.js";

export type MarbleKind = "light" | "heavy" | "big";

/**
 * Room layout characters (one per cell, rows top to bottom):
 *  #  wall            .  floor            o  hole (marble drops, respawns)
 *  c  cracked tile (breaks into a hole once a marble has crossed it)
 *  w  erodible wall (a fast big marble wears it away)
 *  v  vertical slit, h horizontal slit (only the light marble fits through)
 *  S  light marble start   T  heavy marble start   B  big marble start
 *  a  plate for the light marble   b  plate for the heavy marble
 *  g  goal (a marble resting on it clears the room)
 */
export type VaultRoomDef = Readonly<{
  id: string;
  title: string;
  /** What the player is told on entering. Kept short. */
  intro: string;
  rows: readonly string[];
  /** Radians per second the whole floor turns; room gravity follows. */
  rotationSpeed?: number;
  /** "plates": every plate held at once. "reach": a marble reaches the goal. */
  win: "plates" | "reach";
  /** Three tiers, vaguest first. */
  hints: readonly [string, string, string];
  /** Old Pell's story for this room: short lines shown at the top of his popup, before the instructions. */
  lore: readonly string[];
  /** What Pell says instead once this room's seal is open (the Heart room's farewell); else `lore` again. */
  solvedLore?: readonly string[];
}>;

export type VaultCell = "#" | "." | "o" | "c" | "w" | "v" | "h";

export type MarbleState = {
  id: string;
  kind: MarbleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  startX: number;
  startY: number;
  /** Cell index of the cracked tile this marble is standing on. */
  onCrack: number | null;
  /** Falling into a hole: progress 0..1 and the hole centre. */
  falling: { t: number; hx: number; hy: number } | null;
};

export type VaultEvent =
  | { type: "bump"; strength: number; x: number; y: number; nx: number; ny: number; marble: string | null }
  | { type: "fell"; marble: string; x: number; y: number; hx: number; hy: number }
  | { type: "respawned"; marble: string; x: number; y: number }
  | { type: "crack-broke"; cell: number }
  | { type: "wall-chip"; cell: number; hpLeft: number; x: number; y: number }
  | { type: "wall-broke"; cell: number; x: number; y: number }
  | { type: "plate"; pressed: boolean }
  | { type: "won" };

export type PlateState = Readonly<{ cell: number; x: number; y: number; kind: MarbleKind }>;

export type VaultState = {
  def: VaultRoomDef;
  cols: number;
  rows: number;
  cells: VaultCell[];
  wallHp: Map<number, number>;
  marbles: MarbleState[];
  plates: PlateState[];
  goal: Vec2 | null;
  /** Seconds all plates have been held together. */
  plateHold: number;
  angle: number;
  time: number;
  falls: number;
  status: "playing" | "won";
  events: VaultEvent[];
};
