import type {
  FlagSnapshot,
  PlayerSnapshot,
  ServerMessage
} from "@ash-atlas/shared";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import {
  GameApp,
  type GameRuntimeFactories
} from "../src/App.js";
import type { AuthenticatedClientSession } from "../src/auth/authState.js";
import type { GameClient, GameClientHandlers } from "../src/gameClient.js";
import type { GameMapRuntime, MapRuntimeHandlers } from "../src/map/mapRuntime.js";
import type { PixiGameOverlay } from "../src/map/pixiOverlay.js";
import { UiEnvironmentProvider } from "../src/uiEnvironment.js";

declare global {
  interface Window {
    gameAppFlagHarnessReady: boolean;
    selectGameAppFlag(flagId: string): void;
  }
}

const session: AuthenticatedClientSession = {
  authenticated: true,
  csrfToken: "csrf",
  developmentAuthEnabled: false,
  developerCapabilities: [],
  testAccessStatus: "approved",
  account: { id: "account-1", status: "active", trustTier: "standard" },
  player: {
    id: "player-1",
    displayName: "Scout",
    personalFlagColor: "blue"
  },
  onboardingRequired: false
};

export function GameAppFlagAccessStory(): React.JSX.Element {
  const harness = useMemo(() => createHarness(), []);
  const ready = useSyncExternalStore(
    harness.subscribe,
    harness.isReady,
    harness.isReady
  );

  useEffect(() => {
    window.gameAppFlagHarnessReady = ready;
    window.selectGameAppFlag = harness.selectFlag;
    return () => {
      window.gameAppFlagHarnessReady = false;
    };
  }, [harness, ready]);

  return (
    <UiEnvironmentProvider>
      <GameApp
        session={session}
        onLogout={async () => undefined}
        onSessionEnded={() => undefined}
        verifySession={async () => true}
        checkForRequiredUpdate={async () => false}
        onServerComponentRelease={() => undefined}
        runtimeFactories={harness.factories}
      />
    </UiEnvironmentProvider>
  );
}

function createHarness(): {
  factories: GameRuntimeFactories;
  isReady(): boolean;
  selectFlag(flagId: string): void;
  subscribe(listener: () => void): () => void;
} {
  const flags = [ownerFlag(), visitorFlag()];
  const listeners = new Set<() => void>();
  let mapHandlers: MapRuntimeHandlers | null = null;
  let overlayReady = false;
  let bootstrapReady = false;
  let selectedFlagId: string | null = null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const isReady = (): boolean =>
    mapHandlers !== null && overlayReady && bootstrapReady;

  const canvasContainer = document.createElement("div");
  const canvas = document.createElement("canvas");
  const noOp = (): null => null;
  const map = new Proxy({
    getCanvasContainer: () => canvasContainer,
    getCanvas: () => canvas,
    loaded: () => false,
    once: noOp,
    project: () => ({ x: 0, y: 0 }),
    unproject: () => ({ lat: 35, lng: -106 }),
    getCenter: () => ({ lat: 35, lng: -106 }),
    getZoom: () => 14,
    getBearing: () => 0,
    getPitch: () => 0,
    triggerRepaint: noOp
  }, {
    get(target, property) {
      if (property === "then") return undefined;
      if (property in target) return target[property as keyof typeof target];
      return noOp;
    }
  });
  const overlay = new Proxy({
    pickDroppedItemAt: () => null,
    pickCollectibleAt: () => null,
    pickPlayerAt: () => null,
    pickCombatEntityAt: () => null,
    pickManorAt: () => null,
    pickCityStructureAt: () => null,
    pickCityAt: () => null,
    pickFlagAt: () => flags.find((flag) => flag.id === selectedFlagId) ?? null,
    pickWorldObjectsAt: () => []
  }, {
    get(target, property) {
      if (property === "then") return undefined;
      if (property in target) return target[property as keyof typeof target];
      return noOp;
    }
  }) as unknown as PixiGameOverlay;
  const domain = new Proxy({}, { get: () => noOp });

  const factories: GameRuntimeFactories = {
    createMapRuntime: () => ({
      map,
      attach: (handlers: MapRuntimeHandlers) => {
        mapHandlers = handlers;
        notify();
      },
      cancelPendingInteraction: noOp,
      destroy: (beforeMapRemove?: () => void) => beforeMapRemove?.()
    } as unknown as GameMapRuntime),
    createOverlay: async () => {
      overlayReady = true;
      notify();
      return overlay;
    },
    createClient: (_wsBase: string, handlers: GameClientHandlers) => {
      const client = new Proxy({
        connect: () => {
          handlers.onOpen();
          window.setTimeout(() => {
            for (const message of bootstrapMessages(flags)) {
              handlers.onMessage(message);
            }
            bootstrapReady = true;
            notify();
          }, 0);
        },
        disconnect: noOp,
        combatEquipment: domain,
        developer: domain,
        flags: domain,
        harvesting: domain,
        manor: domain,
        market: domain,
        packages: domain,
        party: domain,
        pets: domain,
        settlements: domain,
        social: domain,
        travel: domain,
        world: domain
      }, {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return noOp;
        }
      });
      return client as unknown as GameClient;
    }
  };

  return {
    factories,
    isReady,
    selectFlag: (flagId) => {
      if (!isReady() || !mapHandlers) {
        throw new Error("The GameApp flag harness is not ready.");
      }
      selectedFlagId = flagId;
      mapHandlers.onClick({
        point: { x: 10, y: 10 },
        lngLat: { lat: 35, lng: -106 }
      } as never);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function bootstrapMessages(flags: FlagSnapshot[]): ServerMessage[] {
  return [
    {
      type: "WELCOME",
      playerId: session.player.id,
      username: session.player.displayName,
      spawn: { lat: 35, lon: -106 },
      anchor: { lat: 35, lon: -106 },
      moveLeashRadiusM: 1_250,
      flagClaimRadiusM: 1_000,
      playerSpeedMps: 5,
      serverTickHz: 20,
      regionCode: "GLOBAL",
      zoneId: "world",
      developerCapabilities: [],
      serverTime: 1
    },
    {
      type: "PLAYER_SNAPSHOT",
      serverTime: 1,
      sequence: 0,
      players: [player()]
    },
    {
      type: "PROGRESSION_SNAPSHOT",
      progression: {
        playerId: session.player.id,
        totalXp: 0,
        level: 0,
        curveVersion: 1,
        persistenceVersion: 1,
        xpIntoLevel: 0,
        xpForNextLevel: 800,
        nextLevelTotalXp: 800,
        atCap: false,
        pveStats: {
          maxHealth: 100,
          attackPower: 10,
          defense: 0,
          attackIntervalMs: 1_000,
          attackRangeM: 2
        }
      }
    },
    {
      type: "FLAGS_SNAPSHOT",
      flags,
      flagSetRevision: 1,
      complete: true
    }
  ];
}

function player(): PlayerSnapshot {
  return {
    playerId: session.player.id,
    username: session.player.displayName,
    displayColor: "#38bdf8",
    regionCode: "GLOBAL",
    zoneId: "world",
    lat: 35,
    lon: -106,
    anchorLat: 35,
    anchorLon: -106,
    moveLeashRadiusM: 1_250,
    movementRevision: 0,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: "2026-07-27T00:00:00.000Z"
  };
}

function ownerFlag(): FlagSnapshot {
  return flag("11111111-1111-4111-8111-111111111111", "Owner Flag", "player-1");
}

function visitorFlag(): FlagSnapshot {
  return flag("22222222-2222-4222-8222-222222222222", "Visitor Flag", "player-2");
}

function flag(id: string, name: string, ownerId: string): FlagSnapshot {
  return {
    id,
    controlType: "personal",
    ownerId,
    ownerUsername: ownerId === "player-1" ? "Scout" : "Ranger",
    ownerColor: "#38bdf8",
    name,
    lat: 35,
    lon: -106,
    packageId: "world_v1_lat35_lon-106",
    elevationM: 0,
    terrainClass: "flat",
    biome: "Temperate",
    ecoregion: "Test",
    claimRadiusM: 1_000,
    cityId: null,
    createdAt: "2026-07-27T00:00:00.000Z"
  };
}
