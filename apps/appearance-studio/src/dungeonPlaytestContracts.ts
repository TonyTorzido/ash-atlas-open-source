import {
  dungeonCatalogValidationIssues,
  parseDungeonCatalog,
  type ClassId,
  type CombatEntitySnapshot,
  type CombatEvent,
  type DungeonCatalog,
  type DungeonSnapshot,
  type DroppedItemSnapshot,
  type PlayerAppearanceSnapshot,
  type PortalServerMessage
} from "@ash-atlas/shared";
import { z } from "zod";

/** Browser-safe messages for the disposable production-runtime host. */
export type CreatePlaytestInput = {
  catalog: DungeonCatalog;
  dungeonId: string;
  mode: "full" | "room";
  roomId?: string;
  seed: string;
};

export type PlaytestDebug = {
  invulnerable: boolean;
  aiEnabled: boolean;
  aggroEnabled: boolean;
  speed: number;
};

const debugCommandSchema = z.object({
  type: z.literal("debug"),
  paused: z.boolean().optional(),
  invulnerable: z.boolean().optional(),
  aiEnabled: z.boolean().optional(),
  aggroEnabled: z.boolean().optional(),
  speed: z.number().finite().min(0.25).max(4).optional()
}).strict();

export const playtestCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), x: z.number().finite(), y: z.number().finite() }).strict(),
  z.object({ type: z.literal("attack"), targetEntityId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("cancel_combat") }).strict(),
  z.object({ type: z.literal("interact"), objectId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("portal"), portalId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("harvest"), resourceId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("pickup"), dropId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("heal") }).strict(),
  z.object({ type: z.literal("kill_room") }).strict(),
  z.object({ type: z.literal("restart_room") }).strict(),
  z.object({ type: z.literal("damage"), targetEntityId: z.string().min(1), amount: z.literal(1000) }).strict(),
  z.object({ type: z.literal("teleport"), roomId: z.string().min(1) }).strict(),
  debugCommandSchema
]);

export type PlaytestCommand = z.infer<typeof playtestCommandSchema>;

export type DungeonPlaytestFrame = {
  runId: string;
  seed: string;
  mode: "full" | "room";
  lifecycle: "PLAYING" | "PLAYER_DEAD" | "DUNGEON_COMPLETED" | "DEBUG_PAUSED" | "RUN_EXITED";
  snapshot: DungeonSnapshot;
  combatEntities: CombatEntitySnapshot[];
  events: CombatEvent[];
  portalMessages: PortalServerMessage[];
  drops: DroppedItemSnapshot[];
  classId: ClassId;
  weaponName: string;
  armorName: string;
  appearance: PlayerAppearanceSnapshot;
  debug: PlaytestDebug;
  log: string[];
  geometry: {
    playerCollisionRadius: number;
    playerAttackRange: number;
    mobs: Array<{ entityId: string; attackRange: number; aggroRange: number }>;
    spawns: Array<{ id: string; kind: "mob" | "resource" | "player"; x: number; y: number }>;
  };
  sandbox: { storageAttempts: number; inventory: Record<string, number>; gold: number; cityCoins: number; exited: boolean };
};

export type PlaytestValidationIssue = Readonly<{ path: string; message: string }>;

export type PlaytestValidationResult<T> = Readonly<{
  value: T | null;
  issues: readonly PlaytestValidationIssue[];
}>;

export function validateCreatePlaytestInput(value: unknown): PlaytestValidationResult<CreatePlaytestInput> {
  const parsed = z.object({
    catalog: z.unknown(),
    dungeonId: z.string().min(1),
    mode: z.enum(["full", "room"]),
    roomId: z.string().min(1).optional(),
    seed: z.string().trim().min(1).max(160)
  }).strict().safeParse(value);
  if (!parsed.success) return { value: null, issues: zodIssues(parsed.error) };
  const catalogIssues = dungeonCatalogValidationIssues(parsed.data.catalog);
  if (catalogIssues.length > 0) {
    return { value: null, issues: catalogIssues.map((issue) => ({
      path: issue.path === "$" ? "catalog" : `catalog.${issue.path}`,
      message: issue.message
    })) };
  }
  const catalog: DungeonCatalog = parseDungeonCatalog(parsed.data.catalog);
  const issues: PlaytestValidationIssue[] = [];
  const dungeon = catalog.dungeons.find((candidate) => candidate.id === parsed.data.dungeonId && !candidate.retired);
  if (!dungeon) issues.push({ path: "dungeonId", message: "must reference an active dungeon in catalog" });
  if (parsed.data.mode === "room" && (!parsed.data.roomId || !dungeon?.rooms.some((room) =>
    room.id === parsed.data.roomId && room.active && !room.retired
  ))) {
    issues.push({ path: "roomId", message: "must reference an active room in the selected dungeon" });
  }
  if (issues.length > 0) return { value: null, issues };
  return {
    value: {
      catalog,
      dungeonId: parsed.data.dungeonId,
      mode: parsed.data.mode,
      seed: parsed.data.seed,
      ...(parsed.data.roomId ? { roomId: parsed.data.roomId } : {})
    },
    issues: []
  };
}

export function validatePlaytestCommand(value: unknown): PlaytestValidationResult<PlaytestCommand> {
  const parsed = playtestCommandSchema.safeParse(value);
  return parsed.success
    ? { value: parsed.data, issues: [] }
    : { value: null, issues: zodIssues(parsed.error) };
}

function zodIssues(error: z.ZodError): PlaytestValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "$",
    message: issue.code === "invalid_literal" ? `must be exactly ${String(issue.expected)}` : issue.message
  }));
}
