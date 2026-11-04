import {
  PLAYER_APPEARANCE_CATEGORY_IDS,
  parseBossAppearanceCatalog,
  parseItemVariantCatalog,
  parsePlayerAppearanceCatalog,
  type AppearanceDefinitionId,
  type BossAppearanceCatalog,
  type BossAppearanceId,
  type ItemVariantCatalog,
  type PlayerAppearanceCatalog,
  type PlayerAppearanceCategoryId
} from "@ash-atlas/shared";
import type { StudioSession } from "./bridgeTypes.js";

export type StudioDomain = "player" | "boss" | "hues";

export type RecoveryDraft = {
  baseCatalogRevision: number;
  baseBossCatalogRevision?: number;
  catalog: PlayerAppearanceCatalog;
  itemVariants: ItemVariantCatalog;
  bossCatalog?: BossAppearanceCatalog;
  studioDomain?: StudioDomain;
  selectedBossId?: BossAppearanceId;
  selectedId: AppearanceDefinitionId | null;
  selectedCategoryId: PlayerAppearanceCategoryId;
  selectedFamilyId: string;
  savedAt: string;
};

const RECOVERY_DRAFT_PREFIX = "ash-atlas-appearance-studio-draft:";

function recoveryDraftKey(session: StudioSession): string {
  return RECOVERY_DRAFT_PREFIX + encodeURIComponent(
    `${session.workspace.worktreePath}|${session.workspace.branch ?? "detached"}`
  );
}

export function readRecoveryDraft(session: StudioSession): RecoveryDraft | null {
  const key = recoveryDraftKey(session);
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RecoveryDraft>;
    const catalog = parsePlayerAppearanceCatalog(value.catalog);
    const itemVariants = parseItemVariantCatalog(value.itemVariants);
    const bossCatalog = value.bossCatalog === undefined
      ? undefined
      : parseBossAppearanceCatalog(value.bossCatalog);
    if (
      !Number.isInteger(value.baseCatalogRevision) ||
      !(
        value.baseBossCatalogRevision === undefined ||
        Number.isInteger(value.baseBossCatalogRevision)
      ) ||
      typeof value.savedAt !== "string" ||
      !PLAYER_APPEARANCE_CATEGORY_IDS.includes(
        value.selectedCategoryId as PlayerAppearanceCategoryId
      ) ||
      typeof value.selectedFamilyId !== "string" ||
      !(
        value.studioDomain === undefined ||
        value.studioDomain === "player" ||
        value.studioDomain === "boss" ||
        value.studioDomain === "hues"
      ) ||
      !(
        value.selectedBossId === undefined ||
        (
          bossCatalog !== undefined &&
          bossCatalog.bosses.some((boss) => boss.bossId === value.selectedBossId)
        )
      ) ||
      !(
        value.selectedId === null ||
        (
          typeof value.selectedId === "string" &&
          catalog.appearances.some((appearance) =>
            appearance.appearanceId === value.selectedId
          )
        )
      )
    ) {
      throw new Error("Invalid recovery draft");
    }
    return {
      baseCatalogRevision: value.baseCatalogRevision!,
      ...(value.baseBossCatalogRevision === undefined
        ? {}
        : { baseBossCatalogRevision: value.baseBossCatalogRevision }),
      catalog,
      itemVariants,
      ...(bossCatalog === undefined ? {} : { bossCatalog }),
      ...(value.studioDomain === undefined ? {} : { studioDomain: value.studioDomain }),
      ...(value.selectedBossId === undefined ? {} : { selectedBossId: value.selectedBossId }),
      selectedId: value.selectedId as AppearanceDefinitionId | null,
      selectedCategoryId: value.selectedCategoryId as PlayerAppearanceCategoryId,
      selectedFamilyId: value.selectedFamilyId,
      savedAt: value.savedAt
    };
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
}

export function writeRecoveryDraft(session: StudioSession, draft: RecoveryDraft): void {
  try {
    window.localStorage.setItem(recoveryDraftKey(session), JSON.stringify(draft));
  } catch {
    // Saving to the verified worktree remains available if browser draft storage is unavailable.
  }
}

export function removeRecoveryDraft(session: StudioSession): void {
  try {
    window.localStorage.removeItem(recoveryDraftKey(session));
  } catch {
    // Storage cleanup is best-effort and never changes worktree persistence.
  }
}
