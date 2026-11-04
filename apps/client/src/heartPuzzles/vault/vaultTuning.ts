import type { MarbleKind } from "./vaultTypes.js";

/** Every feel knob for the Tilted Vault. Units: cells (1 cell = 1.0) and seconds. */
export const VAULT_TUNING = {
  /** Acceleration at full tilt, cells/s^2. */
  gravity: 15,
  maxSpeed: 8,
  /** Constant rolling resistance, cells/s^2 (stops a marble slowly on level ground). */
  rollingResistance: 0.55,
  substepSeconds: 0.008,
  /** Hole capture radius; fast marbles skip over the rim a little. */
  holeRadius: 0.36,
  holeFastSpeed: 6,
  holeFallSeconds: 0.45,
  holeRespawnPauseSeconds: 0.25,
  /** Cracked tile breaks once the marble centre is this far from the tile centre. */
  crackBreakDistance: 0.72,
  /** Plates. */
  plateRadius: 0.3,
  plateMaxSpeed: 1.6,
  plateAttractRadius: 0.55,
  plateAttractStrength: 9,
  plateHoldSeconds: 0.7,
  goalRadius: 0.32,
  goalMaxSpeed: 3.5,
  /** Slit passages are narrower than a heavy marble but wider than a light one. */
  slitWall: 0.15,
  /** Impacts weaker than this do nothing to erodible walls. */
  erodeMinImpact: 1.4,
  erodeWallHp: 3,
  /** Hp lost per cell/s of impact above the minimum, scaled by marble erode factor. */
  erodeRate: 0.55,
  /** Marble-marble bounce. */
  marbleRestitution: 0.3
} as const;

export const MARBLE_SPECS: Readonly<Record<MarbleKind, Readonly<{
  radius: number;
  mass: number;
  /** Multiplies tilt acceleration (heavy responds slower). */
  accelScale: number;
  /** Exponential speed damping per second (heavy keeps momentum). */
  damping: number;
  restitution: number;
  /** Tilt below this does not move the marble at all (heavy needs a real lean). */
  stiction: number;
  erode: number;
}>>> = {
  light: { radius: 0.3, mass: 1, accelScale: 1, damping: 1.1, restitution: 0.38, stiction: 0.03, erode: 0 },
  heavy: { radius: 0.42, mass: 3, accelScale: 0.62, damping: 0.5, restitution: 0.14, stiction: 0.1, erode: 0.25 },
  big: { radius: 0.44, mass: 5, accelScale: 0.52, damping: 0.38, restitution: 0.06, stiction: 0.12, erode: 1 }
};
