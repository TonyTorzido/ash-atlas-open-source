import { z } from "zod";

import { DUNGEON_TORCH_MEMBER_MIN, DUNGEON_TORCH_TOTAL_MAX } from "../dungeonCatalog.js";

const requestId = z.string().min(1).max(128);
const id = z.string().min(1).max(128);

export const requestDungeonEntrancesMessageSchema = z.object({
  type: z.literal("REQUEST_DUNGEON_ENTRANCES"),
  requestId
}).strict();
export const enterCisternWarrensMessageSchema = z.object({
  type: z.literal("ENTER_CISTERN_WARRENS"),
  requestId,
  sewerId: id
}).strict();
export const exitCisternWarrensMessageSchema = z.object({
  type: z.literal("EXIT_CISTERN_WARRENS"),
  requestId,
  sessionId: id
}).strict();
export const dungeonMoveToMessageSchema = z.object({
  type: z.literal("DUNGEON_MOVE_TO"),
  requestId,
  sessionId: id,
  x: z.number().finite(),
  y: z.number().finite()
}).strict();
export const dungeonInteractMessageSchema = z.object({
  type: z.literal("DUNGEON_INTERACT"),
  requestId,
  sessionId: id,
  objectId: id
}).strict();
export const dungeonPuzzleSolveMessageSchema = z.object({
  type: z.literal("DUNGEON_PUZZLE_SOLVE"),
  requestId,
  sessionId: id,
  roomId: id,
  /** Client-measured solve time, for diagnostics only; the server uses its own clock. */
  clientSolveMs: z.number().finite().nonnegative().max(86_400_000)
}).strict();
/** Start (talked to the room's NPC, standing next to him) or quit an Ash Heart puzzle. The player is locked while active. */
export const dungeonPuzzleActiveMessageSchema = z.object({
  type: z.literal("DUNGEON_PUZZLE_ACTIVE"),
  requestId,
  sessionId: id,
  roomId: id,
  active: z.boolean()
}).strict();
export const dungeonHarvestResourceMessageSchema = z.object({
  type: z.literal("DUNGEON_HARVEST_RESOURCE"),
  requestId,
  sessionId: id,
  resourceId: id
}).strict();
// Torch lobby (WP16): join at an entrance, pick torches, ready check, leader starts.
const torches = z.number().int().min(DUNGEON_TORCH_MEMBER_MIN).max(DUNGEON_TORCH_TOTAL_MAX);
export const dungeonTorchLobbyJoinMessageSchema = z.object({
  type: z.literal("DUNGEON_TORCH_LOBBY_JOIN"),
  requestId,
  entranceId: id
}).strict();
export const dungeonTorchLobbySetTorchesMessageSchema = z.object({
  type: z.literal("DUNGEON_TORCH_LOBBY_SET_TORCHES"),
  requestId,
  lobbyId: id,
  torches
}).strict();
/** ready: true readies, false unreadies. */
export const dungeonTorchLobbyReadyMessageSchema = z.object({
  type: z.literal("DUNGEON_TORCH_LOBBY_READY"),
  requestId,
  lobbyId: id,
  ready: z.boolean()
}).strict();
export const dungeonTorchLobbyStartMessageSchema = z.object({
  type: z.literal("DUNGEON_TORCH_LOBBY_START"),
  requestId,
  lobbyId: id
}).strict();
export const dungeonTorchLobbyLeaveMessageSchema = z.object({
  type: z.literal("DUNGEON_TORCH_LOBBY_LEAVE"),
  requestId,
  lobbyId: id
}).strict();
export const dungeonClientMessageSchemas = [
  requestDungeonEntrancesMessageSchema,
  enterCisternWarrensMessageSchema,
  exitCisternWarrensMessageSchema,
  dungeonMoveToMessageSchema,
  dungeonInteractMessageSchema,
  dungeonPuzzleSolveMessageSchema,
  dungeonPuzzleActiveMessageSchema,
  dungeonHarvestResourceMessageSchema,
  dungeonTorchLobbyJoinMessageSchema,
  dungeonTorchLobbySetTorchesMessageSchema,
  dungeonTorchLobbyReadyMessageSchema,
  dungeonTorchLobbyStartMessageSchema,
  dungeonTorchLobbyLeaveMessageSchema
] as const;

export type DungeonClientMessage = z.infer<(typeof dungeonClientMessageSchemas)[number]>;
