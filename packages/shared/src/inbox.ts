import { z } from "zod";

export const INBOX_READ_BATCH_MAX = 200;
export const LEGENDARY_BIRD_INBOX_EVENT_KIND = "legendary_bird_event";

export function gameInboxEntryKey(eventKind: string, eventId: string): string {
  return `game:${eventKind}:${eventId}`;
}

export type InboxReadTarget = Readonly<{
  entryKey: string;
  revision: string;
}>;

export type InboxReadReceipt = InboxReadTarget & Readonly<{
  readAt: string;
}>;

export type GameInboxNotice = Readonly<{
  eventKind: string;
  eventId: string;
  message: string;
  createdAt: string;
}>;

const inboxReadTargetObjectSchema = z.object({
  entryKey: z.string().min(1).max(240),
  revision: z.string().min(1).max(80)
}).strict();
export const inboxReadTargetSchema: z.ZodType<InboxReadTarget> = inboxReadTargetObjectSchema;

export const inboxReadBatchSchema = z.object({
  entries: z.array(inboxReadTargetSchema).max(INBOX_READ_BATCH_MAX)
}).strict();

export const inboxReadReceiptSchema: z.ZodType<InboxReadReceipt> = inboxReadTargetObjectSchema.extend({
  readAt: z.string().datetime()
}).strict();

export const inboxReadStateSchema = z.object({
  receipts: z.array(inboxReadReceiptSchema)
}).strict();

export const gameInboxNoticeSchema: z.ZodType<GameInboxNotice> = z.object({
  eventKind: z.string().min(1).max(80),
  eventId: z.string().uuid(),
  message: z.string().min(1).max(240),
  createdAt: z.string().datetime()
}).strict();

export const gameInboxNoticesResponseSchema = z.object({
  notices: z.array(gameInboxNoticeSchema).max(INBOX_READ_BATCH_MAX)
}).strict();
