/**
 * Pure marble physics for the Tilted Vault. No DOM, no timers: feed it a tilt
 * vector and a time step. The renderer and tests both drive this.
 */
import { clamp, type Vec2 } from "../sensorMath.js";
import { MARBLE_SPECS, VAULT_TUNING as T } from "./vaultTuning.js";
import type {
  MarbleKind,
  MarbleState,
  PlateState,
  VaultCell,
  VaultEvent,
  VaultRoomDef,
  VaultState
} from "./vaultTypes.js";

type Rect = Readonly<{ x0: number; y0: number; x1: number; y1: number }>;

const MARBLE_START_CHAR: Readonly<Record<string, MarbleKind>> = { S: "light", T: "heavy", B: "big" };
const PLATE_CHAR: Readonly<Record<string, MarbleKind>> = { a: "light", b: "heavy" };

export const createVaultState = (def: VaultRoomDef): VaultState => {
  const rows = def.rows.length;
  const cols = def.rows[0]?.length ?? 0;
  const cells: VaultCell[] = [];
  const marbles: MarbleState[] = [];
  const plates: PlateState[] = [];
  const wallHp = new Map<number, number>();
  let goal: Vec2 | null = null;
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const ch = def.rows[cy]![cx]!;
      const index = cy * cols + cx;
      const kind = MARBLE_START_CHAR[ch];
      const plateKind = PLATE_CHAR[ch];
      if (kind) {
        marbles.push({
          id: `${kind}-${marbles.length}`, kind, x: cx + 0.5, y: cy + 0.5, vx: 0, vy: 0,
          startX: cx + 0.5, startY: cy + 0.5, onCrack: null, falling: null
        });
      }
      if (plateKind) plates.push({ cell: index, x: cx + 0.5, y: cy + 0.5, kind: plateKind });
      if (ch === "g") goal = { x: cx + 0.5, y: cy + 0.5 };
      if ("#.ocwvh".includes(ch)) cells.push(ch as VaultCell);
      else cells.push(".");
      if (ch === "w") wallHp.set(index, T.erodeWallHp);
    }
  }
  return {
    def, cols, rows, cells, wallHp, marbles, plates, goal,
    plateHold: 0, angle: 0, time: 0, falls: 0, status: "playing", events: []
  };
};

/** Solid rectangles for a cell, in cell units. */
export const cellRects = (cell: VaultCell, cx: number, cy: number): readonly Rect[] => {
  const w = T.slitWall;
  switch (cell) {
    case "#":
    case "w":
      return [{ x0: cx, y0: cy, x1: cx + 1, y1: cy + 1 }];
    case "v":
      return [
        { x0: cx, y0: cy, x1: cx + w, y1: cy + 1 },
        { x0: cx + 1 - w, y0: cy, x1: cx + 1, y1: cy + 1 }
      ];
    case "h":
      return [
        { x0: cx, y0: cy, x1: cx + 1, y1: cy + w },
        { x0: cx, y0: cy + 1 - w, x1: cx + 1, y1: cy + 1 }
      ];
    default:
      return [];
  }
};

const cellAt = (s: VaultState, cx: number, cy: number): VaultCell =>
  cx < 0 || cy < 0 || cx >= s.cols || cy >= s.rows ? "#" : s.cells[cy * s.cols + cx]!;

const emit = (s: VaultState, e: VaultEvent): void => { s.events.push(e); };

/** Rotate a screen-space tilt into room space for a floor turned by `angle` radians. */
export const roomGravity = (tilt: Vec2, angle: number): Vec2 => {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  return { x: tilt.x * c + tilt.y * sn, y: -tilt.x * sn + tilt.y * c };
};

const collideWalls = (s: VaultState, m: MarbleState): void => {
  const spec = MARBLE_SPECS[m.kind];
  const r = spec.radius;
  const bx = Math.floor(m.x);
  const by = Math.floor(m.y);
  for (let cy = by - 1; cy <= by + 1; cy += 1) {
    for (let cx = bx - 1; cx <= bx + 1; cx += 1) {
      const cell = cellAt(s, cx, cy);
      const rects = cellRects(cell, cx, cy);
      for (const rect of rects) {
        const px = clamp(m.x, rect.x0, rect.x1);
        const py = clamp(m.y, rect.y0, rect.y1);
        let dx = m.x - px;
        let dy = m.y - py;
        let dist = Math.hypot(dx, dy);
        if (dist >= r) continue;
        if (dist < 1e-6) {
          // Centre inside the rect: push out along the shallowest axis.
          const left = m.x - rect.x0;
          const right = rect.x1 - m.x;
          const up = m.y - rect.y0;
          const down = rect.y1 - m.y;
          const least = Math.min(left, right, up, down);
          dx = least === left ? -1 : least === right ? 1 : 0;
          dy = least === up ? -1 : least === down ? 1 : 0;
          dist = 0;
          m.x += dx * (least + r);
          m.y += dy * (least + r);
        } else {
          const nx = dx / dist;
          const ny = dy / dist;
          m.x += nx * (r - dist);
          m.y += ny * (r - dist);
          dx = nx;
          dy = ny;
        }
        const vn = m.vx * dx + m.vy * dy;
        if (vn < 0) {
          const impact = -vn;
          m.vx -= (1 + spec.restitution) * vn * dx;
          m.vy -= (1 + spec.restitution) * vn * dy;
          if (impact > 1.2) {
            emit(s, { type: "bump", strength: clamp(impact / 6, 0, 1), x: px, y: py, nx: dx, ny: dy, marble: m.id });
          }
          if (cell === "w" && spec.erode > 0 && impact > T.erodeMinImpact) {
            const index = cy * s.cols + cx;
            const hp = (s.wallHp.get(index) ?? 0) - (impact - T.erodeMinImpact) * T.erodeRate * spec.erode;
            if (hp <= 0) {
              s.cells[index] = ".";
              s.wallHp.delete(index);
              emit(s, { type: "wall-broke", cell: index, x: px, y: py });
            } else {
              s.wallHp.set(index, hp);
              emit(s, { type: "wall-chip", cell: index, hpLeft: hp, x: px, y: py });
            }
          }
        }
      }
    }
  }
};

const respawn = (s: VaultState, m: MarbleState): void => {
  m.x = m.startX; m.y = m.startY; m.vx = 0; m.vy = 0; m.falling = null; m.onCrack = null;
  emit(s, { type: "respawned", marble: m.id, x: m.x, y: m.y });
};

const updateHolesAndCracks = (s: VaultState, m: MarbleState, h: number): void => {
  if (m.falling) {
    m.falling.t += h / T.holeFallSeconds;
    m.x += (m.falling.hx - m.x) * Math.min(1, h * 14);
    m.y += (m.falling.hy - m.y) * Math.min(1, h * 14);
    if (m.falling.t >= 1 + T.holeRespawnPauseSeconds / T.holeFallSeconds) respawn(s, m);
    return;
  }
  const cx = Math.floor(m.x);
  const cy = Math.floor(m.y);
  const speed = Math.hypot(m.vx, m.vy);
  const reach = T.holeRadius * (1 - clamp((speed - 3) / (T.holeFastSpeed * 1.5), 0, 0.55));
  for (let y = cy - 1; y <= cy + 1; y += 1) {
    for (let x = cx - 1; x <= cx + 1; x += 1) {
      if (cellAt(s, x, y) !== "o") continue;
      const hx = x + 0.5;
      const hy = y + 0.5;
      if (Math.hypot(m.x - hx, m.y - hy) < reach) {
        m.falling = { t: 0, hx, hy };
        s.falls += 1;
        emit(s, { type: "fell", marble: m.id, x: m.x, y: m.y, hx, hy });
        return;
      }
    }
  }
  // Cracked tiles: remember the tile underfoot; once the marble has left it, it collapses.
  const here = cy * s.cols + cx;
  if (cellAt(s, cx, cy) === "c" && m.onCrack === null) m.onCrack = here;
  if (m.onCrack !== null) {
    const ox = (m.onCrack % s.cols) + 0.5;
    const oy = Math.floor(m.onCrack / s.cols) + 0.5;
    if (Math.hypot(m.x - ox, m.y - oy) > T.crackBreakDistance) {
      s.cells[m.onCrack] = "o";
      emit(s, { type: "crack-broke", cell: m.onCrack });
      m.onCrack = null;
    }
  }
};

const collideMarbles = (s: VaultState): void => {
  const list = s.marbles.filter((m) => !m.falling);
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]!;
      const b = list[j]!;
      const ra = MARBLE_SPECS[a.kind];
      const rb = MARBLE_SPECS[b.kind];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const min = ra.radius + rb.radius;
      if (dist >= min || dist < 1e-6) continue;
      const nx = dx / dist;
      const ny = dy / dist;
      const total = ra.mass + rb.mass;
      const push = min - dist;
      a.x -= nx * push * (rb.mass / total); a.y -= ny * push * (rb.mass / total);
      b.x += nx * push * (ra.mass / total); b.y += ny * push * (ra.mass / total);
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel < 0) {
        const j2 = (-(1 + T.marbleRestitution) * rel) / (1 / ra.mass + 1 / rb.mass);
        a.vx -= (j2 / ra.mass) * nx; a.vy -= (j2 / ra.mass) * ny;
        b.vx += (j2 / rb.mass) * nx; b.vy += (j2 / rb.mass) * ny;
        if (-rel > 1.2) {
          emit(s, { type: "bump", strength: clamp(-rel / 6, 0, 1), x: a.x + nx * ra.radius, y: a.y + ny * ra.radius, nx: -nx, ny: -ny, marble: null });
        }
      }
    }
  }
};

const platePressed = (s: VaultState, plate: PlateState): boolean =>
  s.marbles.some((m) => m.kind === plate.kind && !m.falling
    && Math.hypot(m.x - plate.x, m.y - plate.y) < T.plateRadius
    && Math.hypot(m.vx, m.vy) < T.plateMaxSpeed);

const substep = (s: VaultState, g: Vec2, h: number): void => {
  const gMag = Math.hypot(g.x, g.y);
  for (const m of s.marbles) {
    if (m.falling) { updateHolesAndCracks(s, m, h); continue; }
    const spec = MARBLE_SPECS[m.kind];
    if (gMag > spec.stiction) {
      const eff = (gMag - spec.stiction * 0.5) / gMag;
      m.vx += g.x * eff * T.gravity * spec.accelScale * h;
      m.vy += g.y * eff * T.gravity * spec.accelScale * h;
    }
    // Plates gently pull a slow marble into the notch so it settles instead of skating over.
    for (const p of s.plates) {
      if (p.kind !== m.kind) continue;
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < T.plateAttractRadius && d > 1e-4 && Math.hypot(m.vx, m.vy) < T.plateMaxSpeed * 2) {
        const pull = T.plateAttractStrength * (1 - d / T.plateAttractRadius) * h;
        m.vx += ((p.x - m.x) / d) * pull; m.vy += ((p.y - m.y) / d) * pull;
      }
    }
    const damp = Math.exp(-spec.damping * h);
    m.vx *= damp; m.vy *= damp;
    let speed = Math.hypot(m.vx, m.vy);
    if (speed > 0) {
      const slowed = Math.max(0, speed - T.rollingResistance * h);
      // Rolling resistance only bites when the player is not pushing, so tilt always wins at low speed.
      const k = gMag > spec.stiction ? 1 : slowed / speed;
      m.vx *= k; m.vy *= k;
      speed = Math.hypot(m.vx, m.vy);
      if (speed > T.maxSpeed) { m.vx *= T.maxSpeed / speed; m.vy *= T.maxSpeed / speed; }
    }
    m.x += m.vx * h;
    m.y += m.vy * h;
    collideWalls(s, m);
    updateHolesAndCracks(s, m, h);
  }
  collideMarbles(s);
};

/** Advance the room. `tilt` is screen-space (-1..1 per axis); the turning floor is handled here. */
export const stepVault = (s: VaultState, tilt: Vec2, dtRaw: number): void => {
  if (s.status === "won") return;
  const dt = clamp(dtRaw, 0, 0.05);
  s.angle += (s.def.rotationSpeed ?? 0) * dt;
  const g = roomGravity(tilt, s.angle);
  const n = Math.max(1, Math.ceil(dt / T.substepSeconds));
  for (let i = 0; i < n; i += 1) substep(s, g, dt / n);
  s.time += dt;

  if (s.def.win === "plates" && s.plates.length > 0) {
    const all = s.plates.every((p) => platePressed(s, p));
    const was = s.plateHold > 0;
    s.plateHold = all ? s.plateHold + dt : 0;
    if (all !== was) emit(s, { type: "plate", pressed: all });
    if (s.plateHold >= T.plateHoldSeconds) { s.status = "won"; emit(s, { type: "won" }); }
  } else if (s.goal) {
    const goal = s.goal;
    if (s.marbles.some((m) => !m.falling && Math.hypot(m.x - goal.x, m.y - goal.y) < T.goalRadius
      && Math.hypot(m.vx, m.vy) < T.goalMaxSpeed)) {
      s.status = "won";
      emit(s, { type: "won" });
    }
  }
};

/** Drain queued events (renderer plays haptics/sound from these). */
export const drainEvents = (s: VaultState): VaultEvent[] => s.events.splice(0, s.events.length);

/**
 * Cell-graph solvability check used by tests: can each marble reach its target
 * (goal or plate) ignoring holes, with slits blocked for non-light marbles?
 * Cracked tiles are passable (the room data keeps them single-use on the route).
 */
export const roomIsReachable = (def: VaultRoomDef): boolean => {
  const s = createVaultState(def);
  const passable = (kind: MarbleKind, cx: number, cy: number): boolean => {
    const c = cellAt(s, cx, cy);
    if (c === "#" || c === "o") return false;
    if (c === "w") return kind === "big" || kind === "heavy";
    if ((c === "v" || c === "h") && kind !== "light") return false;
    return true;
  };
  for (const m of s.marbles) {
    const targets: Vec2[] = def.win === "plates"
      ? s.plates.filter((p) => p.kind === m.kind).map((p) => ({ x: p.x, y: p.y }))
      : s.goal ? [s.goal] : [];
    if (targets.length === 0) return false;
    const seen = new Set<number>();
    const queue: Array<[number, number]> = [[Math.floor(m.x), Math.floor(m.y)]];
    seen.add(queue[0]![1] * s.cols + queue[0]![0]);
    while (queue.length) {
      const [x, y] = queue.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        const key = ny * s.cols + nx;
        if (seen.has(key) || !passable(m.kind, nx, ny)) continue;
        seen.add(key);
        queue.push([nx, ny]);
      }
    }
    if (!targets.every((t) => seen.has(Math.floor(t.y) * s.cols + Math.floor(t.x)))) return false;
  }
  return s.marbles.length > 0;
};
