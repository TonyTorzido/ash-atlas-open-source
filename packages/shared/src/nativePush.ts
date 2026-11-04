import { z } from "zod";

export const nativePushPreferencesSchema = z.object({
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  directMessages: z.boolean(),
  invitations: z.boolean(),
  packages: z.boolean(),
  quietStart: z.number().int().min(0).max(1439).nullable(),
  quietEnd: z.number().int().min(0).max(1439).nullable(),
  timeZone: z.string().min(1).max(100)
}).strict().refine((value) => (value.quietStart === null) === (value.quietEnd === null), "Both quiet-hour boundaries are required");
export type NativePushPreferences = z.infer<typeof nativePushPreferencesSchema>;
export const DEFAULT_NATIVE_PUSH_PREFERENCES: NativePushPreferences = Object.freeze({
  revision: 0,
  enabled: false, directMessages: true, invitations: true, packages: true,
  quietStart: null, quietEnd: null, timeZone: "UTC"
});
export const nativePushRegistrationSchema = z.object({
  token: z.string().min(16).max(4096).regex(/^[A-Za-z0-9_:.-]+$/),
  platform: z.enum(["ios", "android"]),
  expectedEpoch: z.number().int().nonnegative(),
  expectedTokenVersion: z.number().int().nonnegative()
}).strict();
export const nativePushResetSchema = z.object({ expectedEpoch: z.number().int().positive() }).strict();
export const nativePushDestinationSchema = z.object({ deliveryId: z.string().uuid() }).strict();
export type NativePushStatus = Readonly<{
  available: boolean;
  binding: { epoch: number; tokenVersion: number; enabled: boolean } | null;
  preferences: NativePushPreferences;
}>;
export type NativePushDestination = Readonly<{ tab: "direct" | "requests" | "game"; conversationId?: string }>;
