import { z } from "zod";

/**
 * Who a Cleric's holy arc heals (docs/plans/class-roster-v2.md 5, heal-target settings). Per player, persisted on the
 * server (player_heal_target_settings). An ally is healed when they match ANY ticked group; "neutral" is a player in
 * none of the other groups. Enemies are never healed, whatever is ticked.
 */
export const HEAL_TARGET_GROUPS = ["party", "friends", "kingdom", "city", "neutral"] as const;
export type HealTargetGroup = (typeof HEAL_TARGET_GROUPS)[number];
export type HealTargetSettings = Readonly<Record<HealTargetGroup, boolean>>;

export const DEFAULT_HEAL_TARGET_SETTINGS: HealTargetSettings = Object.freeze({
  party: true,
  friends: true,
  kingdom: true,
  city: true,
  neutral: false
});

export const healTargetSettingsSchema = z.object({
  party: z.boolean(),
  friends: z.boolean(),
  kingdom: z.boolean(),
  city: z.boolean(),
  neutral: z.boolean()
}).strict();

/** GET/PATCH /api/profile/me/heal-targets response. */
export const healTargetSettingsResponseSchema = z.object({ healTargets: healTargetSettingsSchema });

/** A PATCH: any subset of the five groups, at least one. */
export const healTargetSettingsUpdateSchema = healTargetSettingsSchema.partial().strict()
  .refine((update) => Object.keys(update).length > 0, { message: "Change at least one heal-target group." });
export type HealTargetSettingsUpdate = z.infer<typeof healTargetSettingsUpdateSchema>;

/** How a target player relates to the caster, as the server resolved it. */
export type HolyArcAllyRelation = Readonly<{
  party: boolean;
  friend: boolean;
  kingdom: boolean;
  city: boolean;
  /** At war with the caster's kingdom or city, or fighting the caster or the caster's party. */
  enemy: boolean;
}>;

/** True when the caster's heal-target settings let the holy arc heal this player. */
export function holyArcHealsPlayer(relation: HolyArcAllyRelation, settings: HealTargetSettings): boolean {
  if (relation.enemy) return false;
  if (relation.party && settings.party) return true;
  if (relation.friend && settings.friends) return true;
  if (relation.kingdom && settings.kingdom) return true;
  if (relation.city && settings.city) return true;
  const neutral = !relation.party && !relation.friend && !relation.kingdom && !relation.city;
  return neutral && settings.neutral;
}
