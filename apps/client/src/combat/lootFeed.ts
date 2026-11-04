import { floatingFeedbackFamily, floatingFeedbackLabel, type DamageFloater } from "./damageFloaters.js";

/** A second identical reward inside this window counts up the existing row instead of adding one. */
export const LOOT_FEED_MERGE_WINDOW_MS = 2_000;
export const LOOT_FEED_MAX_ROWS = 5;
const LOOT_FEED_ENTER_MS = 180;
const LOOT_FEED_FADE_MS = 450;

export type LootFeedRowKind = "item" | "gold" | "xp" | "notice";

export type LootFeedRow = Readonly<{
  /** Stable for the life of the row so merged counts do not remount it. */
  key: string;
  kind: LootFeedRowKind;
  text: string;
  /** Item art id; absent for gold, XP and notices. */
  icon: string | null;
  amount: number;
  createdAtMs: number;
  lastAtMs: number;
  expiresAtMs: number;
}>;

type Draft = {
  key: string; group: string; kind: LootFeedRowKind; subject: string | null; label: string;
  floaterKind: DamageFloater["kind"]; icon: string | null; amount: number;
  createdAtMs: number; lastAtMs: number; expiresAtMs: number;
};

function rowKind(floater: DamageFloater): LootFeedRowKind {
  if (floater.kind === "gold") return "gold";
  if (floater.kind === "character_xp" || floater.kind === "class_xp" || floater.kind === "profession_xp") return "xp";
  if (floater.kind === "resource") return "item";
  return "notice";
}

function rowText(draft: Pick<Draft, "kind" | "floaterKind" | "subject" | "label" | "amount">): string {
  const amount = draft.amount.toLocaleString();
  if (draft.kind === "gold") return `+${amount} Gold`;
  if (draft.floaterKind === "character_xp") return `+${amount} XP`;
  if (draft.kind === "xp") return draft.subject ? `+${amount} ${draft.subject} XP` : draft.label;
  if (draft.kind === "item" && draft.subject) return `${draft.subject} ×${amount}`;
  return draft.label;
}

/**
 * Turns reward floaters into feed rows, oldest first. Identical rewards inside the merge window
 * become one row whose amount counts up; only the newest rows stay.
 */
export function buildLootFeedRows(
  floaters: readonly DamageFloater[],
  nowMs: number,
  itemName: (itemId: string) => string | null,
  max = LOOT_FEED_MAX_ROWS
): LootFeedRow[] {
  const drafts: Draft[] = [];
  const ordered = floaters
    .filter((floater) => floatingFeedbackFamily(floater.kind) === "reward" && floater.createdAtMs <= nowMs)
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
  for (const floater of ordered) {
    const kind = rowKind(floater);
    const icon = floater.icon && floater.icon !== "enchantment_stone" ? floater.icon : null;
    const subject = floater.subject ?? (kind === "item" && icon ? itemName(icon) : null);
    const label = floatingFeedbackLabel(floater);
    // Structured rows merge by what they are; free-text notices only merge when the text is identical.
    const structured = kind === "gold" || floater.kind === "character_xp" || (kind !== "notice" && subject !== null);
    const group = structured ? `${floater.kind}:${subject ?? ""}` : `${floater.kind}:${label}`;
    const existing = [...drafts].reverse().find((draft) =>
      draft.group === group && floater.createdAtMs - draft.lastAtMs <= LOOT_FEED_MERGE_WINDOW_MS);
    if (existing) {
      existing.amount = structured ? existing.amount + floater.amount : existing.amount + 1;
      existing.lastAtMs = floater.createdAtMs;
      existing.expiresAtMs = Math.max(existing.expiresAtMs, floater.expiresAtMs);
      continue;
    }
    drafts.push({
      key: floater.eventId, group, kind, subject, label, floaterKind: floater.kind, icon,
      amount: structured ? floater.amount : 1,
      createdAtMs: floater.createdAtMs, lastAtMs: floater.createdAtMs, expiresAtMs: floater.expiresAtMs
    });
  }
  return drafts
    .filter((draft) => draft.expiresAtMs > nowMs)
    .slice(-max)
    .map((draft): LootFeedRow => {
      const structured = draft.kind === "gold" || draft.floaterKind === "character_xp" ||
        (draft.kind !== "notice" && draft.subject !== null);
      // Unstructured repeats read "Label ×N"; structured rows fold the count into the amount.
      const text = structured ? rowText(draft) : draft.amount > 1 ? `${draft.label} ×${draft.amount}` : draft.label;
      return {
        key: draft.key, kind: draft.kind, text, icon: draft.kind === "item" ? draft.icon : null,
        amount: draft.amount, createdAtMs: draft.createdAtMs, lastAtMs: draft.lastAtMs, expiresAtMs: draft.expiresAtMs
      };
    });
}

/** Opacity and slide for one row; new rows slide in, expiring rows fade, reduced motion only fades. */
export function lootFeedRowPresentation(
  row: Pick<LootFeedRow, "createdAtMs" | "expiresAtMs">,
  nowMs: number,
  reducedMotion: boolean
): { alpha: number; slidePx: number } {
  const fade = Math.min(1, Math.max(0, (row.expiresAtMs - nowMs) / LOOT_FEED_FADE_MS));
  const enter = Math.min(1, Math.max(0, (nowMs - row.createdAtMs) / LOOT_FEED_ENTER_MS));
  const ease = enter * enter * (3 - 2 * enter);
  return {
    alpha: fade * (reducedMotion ? 1 : 0.35 + 0.65 * ease),
    slidePx: reducedMotion ? 0 : 10 * (1 - ease) + 6 * (1 - fade)
  };
}
