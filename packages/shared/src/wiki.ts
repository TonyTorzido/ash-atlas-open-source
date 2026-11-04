import { z } from "zod";

import type { MatchupArmorType, MatchupWeaponType } from "./mobMatchups.js";

export const WIKI_PAGE_LIST_LIMIT = 100;
export const WIKI_TITLE_MAX_LENGTH = 120;
export const WIKI_SUMMARY_MAX_LENGTH = 500;
export const WIKI_BODY_MAX_LENGTH = 50_000;

export const wikiSlugSchema = z.string().trim().min(1).max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const wikiPageContentSchema = z.object({
  slug: wikiSlugSchema,
  title: z.string().trim().min(1).max(WIKI_TITLE_MAX_LENGTH),
  summary: z.string().trim().min(1).max(WIKI_SUMMARY_MAX_LENGTH),
  body: z.string().trim().min(1).max(WIKI_BODY_MAX_LENGTH)
});
export const createWikiPageRequestSchema = wikiPageContentSchema.extend({
  operationKey: z.string().uuid()
});
export const updateWikiPageRequestSchema = wikiPageContentSchema.omit({ slug: true }).extend({
  expectedRevision: z.number().int().positive(),
  operationKey: z.string().uuid()
});
export const wikiCollaboratorRoleSchema = z.enum(["owner", "editor"]);
export const setWikiCollaboratorRequestSchema = z.object({
  accountId: z.string().uuid(),
  role: wikiCollaboratorRoleSchema
});

export type WikiCollaboratorRole = z.infer<typeof wikiCollaboratorRoleSchema>;
export type WikiAccess = "none" | WikiCollaboratorRole;
export type WikiPageSummary = {
  slug: string; title: string; summary: string; currentRevision: number; updatedAt: string;
};
export type WikiPage = WikiPageSummary & { body: string; createdAt: string };
/** Serializable article body: text, or an element (`t` is an HTML tag, "" for a fragment, or a client wiki component). */
export type WikiContentNode = string | number | { t: string; p?: Record<string, unknown>; c?: WikiContentNode[] };
export type WikiBuiltInCategoryId = "getting-started" | "character" | "world" | "activities" | "kingdoms" | "items";
export type WikiBuiltInCategory = { id: WikiBuiltInCategoryId; label: string; description: string };
export type WikiBuiltInArticle = {
  slug: string; title: string; summary: string; category: WikiBuiltInCategoryId; tags: string[]; content: WikiContentNode;
};
export type WikiBuiltInContent = { categories: WikiBuiltInCategory[]; articles: WikiBuiltInArticle[] };
/** Props of the interactive creature roster and matchup explorer embedded in built-in articles. */
export type WikiRosterCreature = {
  key: string; name: string; bookRarity: string; fixedLevel: number | null; maxHealth: number;
  weaponName: string; weaponType: string; armorName: string; armorType: string;
  weaponTypeId: MatchupWeaponType; armorTypeId: MatchupArmorType; damageMultiplier: number;
};
export type WikiMatchupData = {
  armors: readonly { id: MatchupArmorType; name: string; shield: boolean; artItemId: string | null }[];
  weapons: readonly { id: MatchupWeaponType; name: string; inGame: boolean; artItemId: string | null; values: readonly number[] }[];
  monsters: readonly {
    key: string; name: string; boss: boolean; weaponName: string; weaponTypeId: MatchupWeaponType; weaponType: string;
    armorName: string; armorTypeId: MatchupArmorType; armorType: string; damageMultiplier: number;
  }[];
};
export type WikiPageListResponse = { pages: WikiPageSummary[]; builtIn?: WikiBuiltInContent };
export type WikiAccessResponse = { access: WikiAccess; implicitDeveloperOwner: boolean };
export type CreateWikiPageRequest = z.infer<typeof createWikiPageRequestSchema>;
export type UpdateWikiPageRequest = z.infer<typeof updateWikiPageRequestSchema>;
export type WikiMutationResponse = { page: WikiPage; replayed: boolean };
export type WikiCollaborator = { accountId: string; playerName: string; role: WikiCollaboratorRole; grantedAt: string };
export type WikiPlayerSearchResult = { accountId: string; playerName: string };
