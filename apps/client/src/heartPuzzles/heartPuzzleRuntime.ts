/**
 * Client runtime for the puzzle on the current dungeon room's floor. The Pixi
 * overlay layer calls `step()` every frame and draws `state`; the HUD reads
 * `status()`. A solve is only reported to the server (the server decides).
 * Pure apart from the injected input source, so it is unit tested.
 */
import { heartPuzzleForRoom } from "@ash-atlas/shared";

import { unlockedHintTier, type HintTier } from "./puzzleHints.js";
import type { Vec2 } from "./sensorMath.js";
import { drainEvents, createVaultState, stepVault } from "./vault/vaultSim.js";
import { vaultRoomById } from "./vault/vaultRooms.js";
import type { VaultEvent, VaultRoomDef, VaultState } from "./vault/vaultTypes.js";

export type HeartPuzzleContext = Readonly<{
  dungeonId: string;
  roomId: string;
  sessionId: string;
  roomWidth: number;
  roomHeight: number;
  /** The server says the seal is already open. */
  solved: boolean;
  /** The server says this player started the puzzle at Old Pell (locked in place). The marbles only roll then. */
  active?: boolean;
}>;

export type HeartPuzzleStatus = Readonly<{
  roomId: string;
  title: string;
  intro: string;
  /** Old Pell's story lines for this room (his farewell once the room's seal is open, where he has one). */
  lore: readonly string[];
  elapsedSeconds: number;
  falls: number;
  hintTier: HintTier;
  solved: boolean;
  /** Solve reported, waiting for the server to open the seal. */
  reported: boolean;
  /** Started at Old Pell and running (the server holds the player in place). */
  active: boolean;
}>;

export type HeartPuzzleInput = Readonly<{ tilt: Vec2 }>;

export type HeartPuzzleHooks = Readonly<{
  readInput(): HeartPuzzleInput;
  onEvent?(event: VaultEvent): void;
  onSolved(report: Readonly<{ sessionId: string; roomId: string; solveMs: number }>): void;
}>;

export class HeartPuzzleRuntime {
  state: VaultState | null = null;
  context: HeartPuzzleContext | null = null;
  def: VaultRoomDef | null = null;
  private elapsed = 0;
  private reported = false;
  private serverSolved = false;
  private serverActive = false;
  /** Dev/e2e only: replay a room the server already opened (evidence captures). */
  devReplay = false;
  /** Roomed key so a snapshot refresh does not reset the sim. */
  private key = "";

  constructor(private readonly hooks: HeartPuzzleHooks) {}

  /** Call with the current room context each frame (or null outside puzzle rooms). */
  activate(context: HeartPuzzleContext | null): void {
    if (!context || !heartPuzzleForRoom(context.dungeonId, context.roomId)) {
      this.state = null; this.context = null; this.def = null; this.key = "";
      return;
    }
    const def = vaultRoomById(context.roomId);
    if (!def) { this.state = null; this.context = null; this.def = null; this.key = ""; return; }
    const key = `${context.sessionId}:${context.roomId}`;
    if (key !== this.key) {
      this.key = key;
      this.def = def;
      this.state = createVaultState(def);
      this.elapsed = 0;
      this.reported = false;
      this.serverSolved = false;
      this.serverActive = false;
    }
    this.context = context;
    this.serverSolved = context.solved && !this.devReplay;
    const active = (context.active === true || this.devReplay) && !this.serverSolved;
    // Every start and every quit begins from a fresh board (the hint clock keeps running across attempts).
    if (active !== this.serverActive && !(this.reported && !active)) this.reset();
    this.serverActive = active;
  }

  /** Restart the room's marbles (not the timer, not the hint progress). */
  reset(): void {
    if (this.def) this.state = createVaultState(this.def);
    this.reported = false;
  }

  step(dtSeconds: number): void {
    const state = this.state;
    const context = this.context;
    if (!state || !context || this.serverSolved || !this.serverActive) return;
    this.elapsed += dtSeconds;
    stepVault(state, this.hooks.readInput().tilt, dtSeconds);
    for (const event of drainEvents(state)) {
      this.hooks.onEvent?.(event);
      if (event.type === "won" && !this.reported) {
        this.reported = true;
        this.hooks.onSolved({ sessionId: context.sessionId, roomId: context.roomId, solveMs: Math.round(this.elapsed * 1000) });
      }
    }
  }

  /** A server snapshot arrived without the seal opening: allow another report. */
  retryReport(): void {
    if (this.state && this.state.status === "won" && this.context && !this.serverSolved && this.serverActive) {
      this.hooks.onSolved({ sessionId: this.context.sessionId, roomId: this.context.roomId, solveMs: Math.round(this.elapsed * 1000) });
    }
  }

  status(): HeartPuzzleStatus | null {
    if (!this.state || !this.def || !this.context) return null;
    return {
      roomId: this.context.roomId,
      title: this.def.title,
      intro: this.def.intro,
      lore: this.serverSolved ? this.def.solvedLore ?? this.def.lore : this.def.lore,
      elapsedSeconds: this.elapsed,
      falls: this.state.falls,
      hintTier: unlockedHintTier(this.elapsed, this.state.falls),
      solved: this.serverSolved,
      reported: this.reported,
      active: this.serverActive
    };
  }

  /** Hints unlocked so far for the current room (tier 1..n). */
  unlockedHints(): readonly string[] {
    const status = this.status();
    return status && this.def ? this.def.hints.slice(0, status.hintTier) : [];
  }
}
