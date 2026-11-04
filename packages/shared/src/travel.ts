import { z } from "zod";

export const TRAVEL_INVITE_TTL_MS = 10 * 60_000;
export const TRAVEL_INVITE_PAIR_COOLDOWN_MS = 30_000;
// Home lock between GPS relocations (owner rule O4). The SQL guard in
// apps/server/src/game/players.ts derives its interval from this constant.
export const GPS_RELOCATION_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
export const TRAVEL_INVITE_AFTER_RELOCATION_COOLDOWN_MS = 60 * 60_000;

export const TRAVEL_INVITE_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "expired",
  "invalidated"
] as const;

export type TravelInviteStatus = (typeof TRAVEL_INVITE_STATUSES)[number];
export type TravelInboxPerspective = "sender" | "recipient";

export type TravelInboxEntry = Readonly<{
  entryId: string;
  inviteId: string;
  perspective: TravelInboxPerspective;
  counterpartPlayerId: string;
  counterpartName: string;
  message: string;
  status: TravelInviteStatus;
  invalidationReason: string | null;
  sourceType: string;
  sourceId: string | null;
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
  updatedAt?: string | undefined;
}>;

export const travelInboxEntrySchema: z.ZodType<TravelInboxEntry> = z.object({
  entryId: z.string().uuid(),
  inviteId: z.string().uuid(),
  perspective: z.enum(["sender", "recipient"]),
  counterpartPlayerId: z.string().min(1).max(160),
  counterpartName: z.string().min(1).max(64),
  message: z.string().min(1).max(240),
  status: z.enum(TRAVEL_INVITE_STATUSES),
  invalidationReason: z.string().min(1).max(240).nullable(),
  sourceType: z.string().min(1).max(32),
  sourceId: z.string().min(1).max(160).nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  respondedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().optional()
}).strict();

export const travelInboxSnapshotSchema = z.object({
  type: z.literal("TRAVEL_INBOX_SNAPSHOT"),
  entries: z.array(travelInboxEntrySchema),
  serverTime: z.number().finite()
}).strict();
