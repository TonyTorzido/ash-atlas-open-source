import { z } from "zod";

export const authSessionServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("SESSION_REPLACED"),
    message: z.string().min(1).max(240)
  }).strict(),
  z.object({
    type: z.literal("AUTH_SESSION_INVALID"),
    code: z.enum([
      "SESSION_EXPIRED",
      "ACCOUNT_SUSPENDED",
      "SESSION_REVOKED",
      "TEST_ACCESS_PENDING",
      "TEST_ACCESS_DENIED",
      "TEST_ACCESS_REVOKED"
    ]),
    message: z.string().min(1).max(240)
  }).strict()
]);

export const helloMessageSchema = z.object({
  type: z.literal("HELLO"),
  greenhouseCropCatalogVersion: z.literal(1).optional(),
  greenhouseCropPackId: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional()
}).strict();

export const appSuspendMessageSchema = z.object({
  type: z.literal("APP_SUSPEND")
}).strict();

export const pingMessageSchema = z.object({
  type: z.literal("PING"),
  clientTime: z.number().finite()
});

export const requestCreatureBookMessageSchema = z.object({
  type: z.literal("REQUEST_CREATURE_BOOK")
}).strict();

/** No position: the server resolves the biome from its own authoritative player position. */
export const requestBiomeDiscoveryMessageSchema = z.object({
  type: z.literal("REQUEST_BIOME_DISCOVERY")
}).strict();
