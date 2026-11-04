import { randomUUID } from "node:crypto";
import {
  advanceIndoorVector,
  GREENHOUSE_INTERIOR_ROOM,
  GREENHOUSE_MAIN_ROOM,
  GREENHOUSE_PLANTER_INTERACTION_RADIUS,
  GREENHOUSE_STUDIO_CATALOG,
  GREENHOUSE_TANK_INTERACTION_RADIUS,
  STANDARD_INDOOR_SPATIAL_PROFILE,
  findIndoorNavigationRoute,
  interiorNavigation,
  isIndoorNavigationPointWalkable,
  type IndoorPosition
} from "@ash-atlas/shared";

export type GreenhouseRuntimeSession = {
  playerId: string;
  greenhouseId: string;
  spaceId: typeof GREENHOUSE_MAIN_ROOM;
  sessionId: string;
  position: IndoorPosition;
  movementSequence: number;
};

export class GreenhouseRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GreenhouseRuntimeError";
  }
}

export class GreenhouseRuntime {
  private readonly sessions = new Map<string, GreenhouseRuntimeSession>();
  private readonly routes = new Map<string, Array<{ x: number; y: number }>>();
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly persistPosition?: (input: {
      playerId: string;
      instanceId: string;
      spaceId: string;
      x: number;
      y: number;
    }) => Promise<void>
  ) {}

  enter(playerId: string, greenhouseId: string, position?: { x: number; y: number }): GreenhouseRuntimeSession {
    const navigation = greenhouseNavigation();
    const requested = position ?? STANDARD_INDOOR_SPATIAL_PROFILE.spawn;
    const safePosition = isIndoorNavigationPointWalkable(navigation, requested) ? requested : greenhouseSafeSpawn(navigation);
    const session: GreenhouseRuntimeSession = {
      playerId,
      greenhouseId,
      spaceId: GREENHOUSE_MAIN_ROOM,
      sessionId: randomUUID(),
      position: {
        x: safePosition.x,
        y: safePosition.y,
        targetX: null,
        targetY: null,
        moving: false,
        revision: 0
      },
      movementSequence: 0
    };
    this.sessions.set(playerId, session);
    return cloneSession(session);
  }

  restore(playerId: string, greenhouseId: string, position?: { x: number; y: number }): GreenhouseRuntimeSession {
    return this.enter(playerId, greenhouseId, position);
  }

  get(playerId: string): GreenhouseRuntimeSession | null {
    const session = this.sessions.get(playerId);
    return session ? cloneSession(session) : null;
  }

  isInside(playerId: string): boolean {
    return this.sessions.has(playerId);
  }

  exit(playerId: string, sessionId: string): GreenhouseRuntimeSession {
    const session = this.requireSession(playerId, sessionId);
    this.sessions.delete(playerId);
    this.routes.delete(playerId);
    this.listeners.delete(playerId);
    return cloneSession(session);
  }

  async disconnect(playerId: string, sessionId: string): Promise<void> {
    if (!this.sessions.get(playerId) || this.sessions.get(playerId)?.sessionId !== sessionId) return;
    this.sessions.delete(playerId);
    this.routes.delete(playerId);
    this.listeners.delete(playerId);
  }

  requireSession(playerId: string, sessionId: string): GreenhouseRuntimeSession {
    const session = this.sessions.get(playerId);
    if (!session) throw new GreenhouseRuntimeError("NOT_INSIDE", "You are not inside a greenhouse.");
    if (session.sessionId !== sessionId) throw new GreenhouseRuntimeError("STALE_SESSION", "That greenhouse session is stale.");
    return session;
  }

  isNearWaterStorage(playerId: string, sessionId: string, target?: { roomId?: string; x: number; y: number }): boolean {
    const session = this.requireSession(playerId, sessionId);
    const anchor = target ?? GREENHOUSE_STUDIO_CATALOG.waterStorage;
    return session.spaceId === (anchor.roomId ?? GREENHOUSE_MAIN_ROOM) &&
      !session.position.moving &&
      Math.hypot(session.position.x - anchor.x, session.position.y - anchor.y) <= GREENHOUSE_TANK_INTERACTION_RADIUS;
  }

  isNearPlanter(playerId: string, sessionId: string, anchorId: string, target?: { roomId?: string; x: number; y: number }): boolean {
    const session = this.requireSession(playerId, sessionId);
    const authored = GREENHOUSE_STUDIO_CATALOG.anchors.find((candidate) => candidate.anchorId === anchorId);
    const anchor = target ?? authored;
    if (!anchor) throw new GreenhouseRuntimeError("ANCHOR_NOT_FOUND", "That Farm Plot is not available.");
    return session.spaceId === (anchor.roomId ?? GREENHOUSE_MAIN_ROOM) &&
      !session.position.moving &&
      Math.hypot(session.position.x - anchor.x, session.position.y - anchor.y) <= GREENHOUSE_PLANTER_INTERACTION_RADIUS;
  }

  moveTo(playerId: string, sessionId: string, x: number, y: number): GreenhouseRuntimeSession {
    const session = this.requireSession(playerId, sessionId);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new GreenhouseRuntimeError("INVALID_MOVE", "Greenhouse coordinates must be finite.");
    const navigation = greenhouseNavigation();
    if (!isIndoorNavigationPointWalkable(navigation, { x, y })) {
      throw new GreenhouseRuntimeError("OUT_OF_BOUNDS", "That target is outside the greenhouse floor.");
    }
    if (Math.hypot(x - session.position.x, y - session.position.y) > STANDARD_INDOOR_SPATIAL_PROFILE.maxTargetDistance) {
      throw new GreenhouseRuntimeError("INVALID_MOVE", "That target is too far away.");
    }
    const route = findIndoorNavigationRoute(navigation, session.position, { x, y });
    if (!route) throw new GreenhouseRuntimeError("INVALID_MOVE", "That path is blocked by a greenhouse wall.");
    this.routes.set(playerId, route);
    session.position.targetX = x;
    session.position.targetY = y;
    session.position.moving = true;
    session.position.revision += 1;
    session.movementSequence += 1;
    return cloneSession(session);
  }

  stop(playerId: string): void {
    const session = this.sessions.get(playerId);
    if (!session || !session.position.moving) return;
    session.position.targetX = null;
    session.position.targetY = null;
    session.position.moving = false;
    session.position.revision += 1;
    session.movementSequence += 1;
    this.routes.delete(playerId);
  }

  subscribeMovementSettled(playerId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(playerId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(playerId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(playerId);
    };
  }

  tick(deltaSeconds: number): GreenhouseRuntimeSession[] {
    const changed: GreenhouseRuntimeSession[] = [];
    const step = Math.max(0, Math.min(0.25, deltaSeconds)) * STANDARD_INDOOR_SPATIAL_PROFILE.movementUnitsPerSecond;
    for (const session of this.sessions.values()) {
      const { targetX, targetY } = session.position;
      if (targetX === null || targetY === null) continue;
      const route = this.routes.get(session.playerId) ?? [{ x: targetX, y: targetY }];
      const waypoint = route[0] ?? { x: targetX, y: targetY };
      const advanced = advanceIndoorVector(session.position, waypoint, step);
      session.position.x = advanced.x;
      session.position.y = advanced.y;
      if (advanced.arrived) {
        route.shift();
        if (route.length > 0) {
          session.position.revision += 1;
          session.movementSequence += 1;
          changed.push(cloneSession(session));
          continue;
        }
        this.routes.delete(session.playerId);
        session.position.targetX = null;
        session.position.targetY = null;
        session.position.moving = false;
        void this.persistPosition?.({ playerId: session.playerId, instanceId: `greenhouse:${session.greenhouseId}`, spaceId: session.spaceId, x: session.position.x, y: session.position.y });
        for (const listener of this.listeners.get(session.playerId) ?? []) queueMicrotask(listener);
      }
      session.position.revision += 1;
      session.movementSequence += 1;
      changed.push(cloneSession(session));
    }
    return changed;
  }
}

/**
 * Movement inputs for the Greenhouse room, straight from the authored interior
 * space. Placed pots are not movement colliders today (the server only checks
 * placement overlap), so no extra colliders are layered on; this is the U0
 * equivalence-tested navigation of the previous Manor-template construction.
 */
function greenhouseNavigation() {
  return interiorNavigation(GREENHOUSE_INTERIOR_ROOM);
}

function greenhouseSafeSpawn(navigation: ReturnType<typeof greenhouseNavigation>): { x: number; y: number } {
  const candidates = [
    { x: navigation.roomWidth / 2, y: navigation.roomHeight * 0.8 },
    { x: navigation.roomWidth / 2, y: navigation.roomHeight / 2 },
    ...(navigation.walkableSurfaces?.[0] ?? [])
  ];
  return candidates.find((candidate) => isIndoorNavigationPointWalkable(navigation, candidate)) ?? { x: navigation.roomWidth / 2, y: navigation.roomHeight / 2 };
}

function cloneSession(session: GreenhouseRuntimeSession): GreenhouseRuntimeSession {
  return {
    ...session,
    position: { ...session.position }
  };
}
