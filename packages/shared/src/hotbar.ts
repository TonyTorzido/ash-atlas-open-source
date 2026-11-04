import { z } from "zod";

/**
 * The ten player-owned utility slots: five rows on each side. The bottom/core
 * slot is deliberately absent from this list: it is reserved for game-owned
 * actions and can never be persisted as a player binding.
 */
export const HOTBAR_PLAYER_SLOT_IDS = [
  "left-1",
  "left-2",
  "left-3",
  "left-4",
  "left-5",
  "right-1",
  "right-2",
  "right-3",
  "right-4",
  "right-5"
] as const;
export type HotbarPlayerSlotId = (typeof HOTBAR_PLAYER_SLOT_IDS)[number];

/** The legacy shapes written by migrations 0848 and the first eight-slot UI. */
export const HOTBAR_LEGACY_PLAYER_SLOT_IDS = [
  "left-1",
  "left-2",
  "left-3",
  "right-1",
  "right-2",
  "right-3"
] as const;
export const HOTBAR_LEGACY_EIGHT_SLOT_IDS = [
  "left-1",
  "left-2",
  "left-3",
  "left-4",
  "right-1",
  "right-2",
  "right-3",
  "right-4"
] as const;

export const HOTBAR_MAX_VISIBLE_ROWS = 5 as const;
export const HOTBAR_DEFAULT_VISIBLE_ROWS = 4 as const;
/** Positions are percentages within the gameplay space, top to bottom. */
export const HOTBAR_DEFAULT_ROW_POSITIONS = [44, 58, 72, 86, 100] as const;
export const HOTBAR_ROW_POSITION_MIN = 0 as const;
export const HOTBAR_ROW_POSITION_MAX = 100 as const;
/** @deprecated Use hotbarRowAnchorConstraints for rendered separation. */
export const HOTBAR_ROW_POSITION_GAP = 12 as const;
/** The intentional visual separation between adjacent rendered row tiles. */
export const HOTBAR_ROW_VISUAL_GAP_PX = 8 as const;
/** Smallest preserved touch-sized row footprint when a mobile track is short. */
export const HOTBAR_MIN_ROW_HEIGHT_PX = 44 as const;
/** Short-track fallback gap; it remains visible when the full 8px gap cannot fit. */
export const HOTBAR_MIN_ROW_GAP_PX = 4 as const;
/** Fallback geometry used before a browser has reported the live track size. */
export const HOTBAR_DEFAULT_TRACK_HEIGHT_PX = 320 as const;
export const HOTBAR_DEFAULT_ROW_HEIGHT_PX = 48 as const;
/** Rendered paired-row height used by the tablet/desktop hotbar treatment. */
export const HOTBAR_DESKTOP_ROW_HEIGHT_PX = 64 as const;
/**
 * Explicit compact anchor-domain height for callers that intentionally opt into
 * a compact layout. The live gameplay hotbar leaves this option unset so its
 * anchors use the full measured track.
 */
export const HOTBAR_DESKTOP_COMPACT_TRACK_HEIGHT_PX = 384 as const;

export type HotbarLayoutGeometry = Readonly<{
  /** Height of the usable hotbar track, excluding the bottom controls. */
  trackHeight: number;
  /** Rendered height of one paired-row tile in that track. */
  rowHeight: number;
  /** Clear space between adjacent rendered row tiles. */
  rowGap?: number;
  /**
   * Optional compact height, in the same pixels as trackHeight, used as an
   * explicit compact anchor domain. The live hotbar leaves this unset so its
   * full measured track and persisted percentage model remain unchanged.
   */
  compactTrackHeight?: number;
}>;

export const HOTBAR_DEFAULT_LAYOUT_GEOMETRY: HotbarLayoutGeometry = {
  trackHeight: HOTBAR_DEFAULT_TRACK_HEIGHT_PX,
  rowHeight: HOTBAR_DEFAULT_ROW_HEIGHT_PX,
  rowGap: HOTBAR_ROW_VISUAL_GAP_PX
};

/**
 * Fit a measured row footprint into the actual usable track. Normal phones
 * retain their measured 48px rows and 8px gap; short orientations first
 * reduce the row height, then the gap, so the visible rows never overlap or
 * spill into the HUD boundaries. An explicit compact anchor domain remains
 * available to callers that provide compactTrackHeight.
 */
export function fitHotbarLayoutGeometry(
  geometry: HotbarLayoutGeometry,
  rowCount: number
): HotbarLayoutGeometry {
  const trackHeight = finitePositive(geometry.trackHeight, HOTBAR_DEFAULT_TRACK_HEIGHT_PX);
  const measuredRowHeight = Math.min(
    trackHeight,
    finitePositive(geometry.rowHeight, HOTBAR_DEFAULT_ROW_HEIGHT_PX)
  );
  const desiredGap = Math.min(
    HOTBAR_ROW_VISUAL_GAP_PX,
    finiteNonNegative(geometry.rowGap ?? HOTBAR_ROW_VISUAL_GAP_PX, HOTBAR_ROW_VISUAL_GAP_PX)
  );
  const count = Math.min(HOTBAR_MAX_VISIBLE_ROWS, Math.max(0, Math.trunc(rowCount)));
  if (count <= 1 || measuredRowHeight * count + desiredGap * Math.max(0, count - 1) <= trackHeight) {
    return {
      ...geometry,
      trackHeight,
      rowHeight: measuredRowHeight,
      rowGap: desiredGap
    };
  }

  const preferredGap = Math.min(desiredGap, HOTBAR_MIN_ROW_GAP_PX);
  const rowHeightAtPreferredGap = (trackHeight - preferredGap * (count - 1)) / count;
  const rowHeightAtDesiredGap = (trackHeight - desiredGap * (count - 1)) / count;
  const rowHeight = rowHeightAtDesiredGap >= HOTBAR_MIN_ROW_HEIGHT_PX
    ? rowHeightAtDesiredGap
    : rowHeightAtPreferredGap > 0
      ? rowHeightAtPreferredGap
      : Math.max(1, trackHeight / count);
  const rowGap = rowHeightAtDesiredGap >= HOTBAR_MIN_ROW_HEIGHT_PX
    ? desiredGap
    : rowHeightAtPreferredGap > 0
      ? preferredGap
      : 0;
  return {
    ...geometry,
    trackHeight,
    rowHeight: Math.min(measuredRowHeight, rowHeight),
    rowGap
  };
}

export const HOTBAR_RESERVED_SLOT_ID = "core" as const;
export const HOTBAR_SLOT_IDS = [
  ...HOTBAR_PLAYER_SLOT_IDS,
  HOTBAR_RESERVED_SLOT_ID
] as const;
export type HotbarSlotId = (typeof HOTBAR_SLOT_IDS)[number];

/** Game actions that can sit in a quick slot alongside items. */
export const HOTBAR_ACTION_IDS = ["anchor_build", "plant_sapling", "dig_treasure"] as const;
export type HotbarActionId = (typeof HOTBAR_ACTION_IDS)[number];

/**
 * Clients that understand action bindings add this query to hotbar requests.
 * Older clients never receive action bindings (see stripHotbarActionBindings)
 * and cannot erase them when they save (see preserveHotbarActionBindings).
 */
export const HOTBAR_ACTION_BINDINGS_QUERY = "bindings=actions";

/** Stable references are item identities, never stack quantities or indexes. */
export const hotbarBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("consumable"),
    itemId: z.string().trim().min(1).max(96),
    variant: z.string().trim().min(1).max(96).nullable()
  }).strict(),
  z.object({
    kind: z.literal("fishing_rod"),
    rodId: z.string().trim().min(1).max(128)
  }).strict(),
  // This binding is intentionally data-only until a canonical gear-scroll
  // action exists. It lets the persistence contract evolve without inventing
  // client mechanics or pretending that a scroll is executable today.
  z.object({
    kind: z.literal("gear_scroll"),
    scrollId: z.string().trim().min(1).max(128)
  }).strict(),
  z.object({
    kind: z.literal("action"),
    actionId: z.enum(HOTBAR_ACTION_IDS)
  }).strict()
]);
export type HotbarBinding = z.infer<typeof hotbarBindingSchema>;

export const hotbarPlayerSlotSchema = z.object({
  slotId: z.enum(HOTBAR_PLAYER_SLOT_IDS),
  binding: hotbarBindingSchema.nullable()
}).strict();
export type HotbarPlayerSlot = z.infer<typeof hotbarPlayerSlotSchema>;

const uniquePlayerSlots = (
  slots: readonly HotbarPlayerSlot[],
  context: z.RefinementCtx
): void => {
  const seen = new Set<string>();
  for (const slot of slots) {
    if (seen.has(slot.slotId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate hotbar slot: ${slot.slotId}`
      });
    }
    seen.add(slot.slotId);
  }
  if (seen.size !== HOTBAR_PLAYER_SLOT_IDS.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "All ten player hotbar slots are required"
    });
  }
};

const hotbarRowPositionsSchema = z.array(
  z.number().finite().min(HOTBAR_ROW_POSITION_MIN).max(HOTBAR_ROW_POSITION_MAX)
).length(HOTBAR_MAX_VISIBLE_ROWS);

export const hotbarSettingsSchema = z.object({
  revision: z.number().int().nonnegative().safe(),
  slots: z.array(hotbarPlayerSlotSchema).length(HOTBAR_PLAYER_SLOT_IDS.length),
  /** 0 hides the hotbar; 1–5 reveal that many persisted rows. */
  rowCount: z.number().int().min(0).max(HOTBAR_MAX_VISIBLE_ROWS).default(HOTBAR_DEFAULT_VISIBLE_ROWS),
  /** One independent vertical anchor per possible row. */
  rowPositions: hotbarRowPositionsSchema.default([...HOTBAR_DEFAULT_ROW_POSITIONS])
}).strict().superRefine((value, context) => uniquePlayerSlots(value.slots, context));
export type HotbarSettings = z.infer<typeof hotbarSettingsSchema>;

export const hotbarUpdateSchema = z.object({
  revision: z.number().int().nonnegative().safe(),
  slots: z.array(hotbarPlayerSlotSchema).length(HOTBAR_PLAYER_SLOT_IDS.length),
  rowCount: z.number().int().min(0).max(HOTBAR_MAX_VISIBLE_ROWS).optional(),
  rowPositions: hotbarRowPositionsSchema.optional()
}).strict().superRefine((value, context) => uniquePlayerSlots(value.slots, context));
export type HotbarUpdate = z.infer<typeof hotbarUpdateSchema>;

export const hotbarSettingsResponseSchema = z.object({
  hotbar: hotbarSettingsSchema
}).strict();

/** The view of saved settings sent to clients that predate action bindings. */
export function stripHotbarActionBindings(settings: HotbarSettings): HotbarSettings {
  return {
    ...settings,
    slots: settings.slots.map((slot) => slot.binding?.kind === "action" ? { ...slot, binding: null } : slot)
  };
}

/**
 * An older client saves every slot it can see, so a slot holding an action it
 * could not see arrives as empty; keep the saved action instead of clearing it.
 */
export function preserveHotbarActionBindings(update: HotbarUpdate, current: HotbarSettings): HotbarUpdate {
  const currentById = new Map(current.slots.map((slot) => [slot.slotId, slot.binding]));
  return {
    ...update,
    slots: update.slots.map((slot) => {
      const saved = currentById.get(slot.slotId);
      return slot.binding === null && saved?.kind === "action" ? { ...slot, binding: saved } : slot;
    })
  };
}

export function defaultHotbarSettings(): HotbarSettings {
  return {
    revision: 0,
    // The bottom row starts with the flag/buoy builder (left) and Giving Berry heal (right).
    slots: HOTBAR_PLAYER_SLOT_IDS.map((slotId) => ({
      slotId,
      binding: slotId === `left-${HOTBAR_DEFAULT_VISIBLE_ROWS}`
        ? { kind: "action", actionId: "anchor_build" }
        : slotId === `right-${HOTBAR_DEFAULT_VISIBLE_ROWS}`
          ? { kind: "consumable", itemId: "giving_berry", variant: null }
          : null
    })),
    rowCount: HOTBAR_DEFAULT_VISIBLE_ROWS,
    rowPositions: [...HOTBAR_DEFAULT_ROW_POSITIONS]
  };
}

/** Clamp settings received from older rows or untrusted clients to one safe layout. */
export function normalizeHotbarLayout(
  rowCount: unknown,
  rowPositions: unknown,
  geometry: HotbarLayoutGeometry = HOTBAR_DEFAULT_LAYOUT_GEOMETRY
): Pick<HotbarSettings, "rowCount" | "rowPositions"> {
  const safeCount = typeof rowCount === "number" && Number.isInteger(rowCount)
    ? Math.min(HOTBAR_MAX_VISIBLE_ROWS, Math.max(0, rowCount))
    : HOTBAR_DEFAULT_VISIBLE_ROWS;
  const raw = Array.isArray(rowPositions)
    ? rowPositions.map((value) => typeof value === "number" && Number.isFinite(value) ? value : Number.NaN)
    : [];
  const positions = HOTBAR_DEFAULT_ROW_POSITIONS.map((fallback, index) => {
    const value = raw[index] ?? Number.NaN;
    return Number.isFinite(value)
      ? Math.min(HOTBAR_ROW_POSITION_MAX, Math.max(HOTBAR_ROW_POSITION_MIN, value))
      : fallback;
  });
  return {
    rowCount: safeCount,
    rowPositions: normalizeHotbarRowPositions(safeCount, positions, geometry)
  };
}

/**
 * Sanitize the durable layout without applying a rendered footprint. The
 * client owns non-overlap normalization because only it can measure the
 * current safe-area-aware track; applying the desktop fallback here would
 * rewrite a valid tall-phone layout during save or reconnect.
 */
export function normalizeHotbarLayoutForPersistence(
  rowCount: unknown,
  rowPositions: unknown
): Pick<HotbarSettings, "rowCount" | "rowPositions"> {
  const safeCount = typeof rowCount === "number" && Number.isInteger(rowCount)
    ? Math.min(HOTBAR_MAX_VISIBLE_ROWS, Math.max(0, rowCount))
    : HOTBAR_DEFAULT_VISIBLE_ROWS;
  const raw = Array.isArray(rowPositions)
    ? rowPositions.map((value) => typeof value === "number" && Number.isFinite(value) ? value : Number.NaN)
    : [];
  return {
    rowCount: safeCount,
    rowPositions: HOTBAR_DEFAULT_ROW_POSITIONS.map((fallback, index) => {
      const value = raw[index] ?? Number.NaN;
      const position = Number.isFinite(value) ? value : fallback;
      return Math.round(Math.min(HOTBAR_ROW_POSITION_MAX, Math.max(HOTBAR_ROW_POSITION_MIN, position)) * 100) / 100;
    })
  };
}

/**
 * Keep visible rows separated even when a saved layout was edited by an older
 * client or contains anchors that are too close together. Row identity is
 * preserved, while each anchor is clamped into the available range. When a
 * compact track is supplied, persisted anchors are first mapped into that
 * shorter rendered domain; hidden-row anchors remain untouched for persistence.
 */
export function normalizeHotbarRowPositions(
  rowCount: number,
  rowPositions: readonly number[],
  geometry: HotbarLayoutGeometry = HOTBAR_DEFAULT_LAYOUT_GEOMETRY
): number[] {
  const count = Math.min(HOTBAR_MAX_VISIBLE_ROWS, Math.max(0, Math.trunc(rowCount)));
  const constraints = hotbarRowAnchorConstraints(geometry, count);
  const anchorMaximum = count === 0 ? HOTBAR_ROW_POSITION_MAX : constraints.maxAnchor;
  const compactAnchorScale = geometry.compactTrackHeight === undefined
    ? 1
    : constraints.maxAnchor / HOTBAR_ROW_POSITION_MAX;
  const normalized = HOTBAR_DEFAULT_ROW_POSITIONS.map((fallback, index) => {
    const value = rowPositions[index] ?? Number.NaN;
    const source = Number.isFinite(value) ? value : fallback;
    const responsiveSource = index < count ? source * compactAnchorScale : source;
    return Math.min(HOTBAR_ROW_POSITION_MAX, Math.max(HOTBAR_ROW_POSITION_MIN, responsiveSource));
  });
  if (count <= 1) return normalized.map((value, index) => Math.round(Math.min(
    index < count ? anchorMaximum : HOTBAR_ROW_POSITION_MAX,
    Math.max(HOTBAR_ROW_POSITION_MIN, value)
  ) * 100) / 100);
  const gap = constraints.minAnchorGap;
  for (let index = 1; index < count; index += 1) {
    normalized[index] = Math.min(
      constraints.maxAnchor,
      Math.max(normalized[index]!, normalized[index - 1]! + gap)
    );
  }
  for (let index = count - 2; index >= 0; index -= 1) {
    const maximum = constraints.maxAnchor - gap * (count - 1 - index);
    normalized[index] = Math.min(normalized[index]!, maximum, normalized[index + 1]! - gap);
  }
  return normalized.map((value, index) => Math.round(Math.min(
    index < count ? anchorMaximum : HOTBAR_ROW_POSITION_MAX,
    Math.max(HOTBAR_ROW_POSITION_MIN, value)
  ) * 100) / 100);
}

/**
 * Apply one player-controlled row anchor and immediately return the safe
 * layout. Keeping this update beside the normalizer means range input, touch
 * dragging, and keyboard changes all use the same non-overlap rules.
 */
export function normalizeHotbarRowPositionUpdate(
  rowCount: number,
  rowPositions: readonly number[],
  rowIndex: number,
  value: number,
  geometry: HotbarLayoutGeometry = HOTBAR_DEFAULT_LAYOUT_GEOMETRY
): number[] {
  const next = HOTBAR_DEFAULT_ROW_POSITIONS.map((fallback, index) => {
    const current = rowPositions[index];
    return typeof current === "number" && Number.isFinite(current) ? current : fallback;
  });
  const count = Math.min(HOTBAR_MAX_VISIBLE_ROWS, Math.max(0, Math.trunc(rowCount)));
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= HOTBAR_MAX_VISIBLE_ROWS) {
    return normalizeHotbarRowPositions(rowCount, next, geometry);
  }
  next[rowIndex] = value;
  if (rowIndex >= count) return normalizeHotbarRowPositions(rowCount, next, geometry);
  const baseline = normalizeHotbarRowPositions(rowCount, next, geometry);
  const constraints = hotbarRowAnchorConstraints(geometry, count);
  const gap = constraints.minAnchorGap;
  const minimum = rowIndex * gap;
  const maximum = constraints.maxAnchor - gap * (count - 1 - rowIndex);
  const anchor = Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : baseline[rowIndex]!));
  baseline[rowIndex] = anchor;
  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    baseline[index] = Math.min(baseline[index]!, baseline[index + 1]! - gap);
  }
  for (let index = rowIndex + 1; index < count; index += 1) {
    baseline[index] = Math.min(
      constraints.maxAnchor,
      Math.max(baseline[index]!, baseline[index - 1]! + gap)
    );
  }
  return baseline.map((position, index) => Math.round(Math.min(
    index < count ? constraints.maxAnchor : HOTBAR_ROW_POSITION_MAX,
    Math.max(HOTBAR_ROW_POSITION_MIN, position)
  ) * 100) / 100);
}

/**
 * Return the normalized constraints for row anchors in a rendered track.
 * Anchors are percentages of the full track, while the final row may start
 * only as low as the track minus its rendered tile height. The minimum anchor
 * separation therefore comes from the actual tile footprint plus the desired
 * visual gap, rather than from a fixed percentage that changes meaning at
 * every viewport size.
 */
export function hotbarRowAnchorConstraints(
  geometry: HotbarLayoutGeometry,
  rowCount: number = HOTBAR_MAX_VISIBLE_ROWS
): Readonly<{ maxAnchor: number; minAnchorGap: number }> {
  const trackHeight = finitePositive(geometry.trackHeight, HOTBAR_DEFAULT_TRACK_HEIGHT_PX);
  const rowHeight = Math.min(
    trackHeight,
    finiteNonNegative(geometry.rowHeight, HOTBAR_DEFAULT_ROW_HEIGHT_PX)
  );
  const rowGap = finiteNonNegative(geometry.rowGap ?? HOTBAR_ROW_VISUAL_GAP_PX, HOTBAR_ROW_VISUAL_GAP_PX);
  const measuredMaximum = Math.min(
    HOTBAR_ROW_POSITION_MAX,
    Math.max(HOTBAR_ROW_POSITION_MIN, ((trackHeight - rowHeight) / trackHeight) * 100)
  );
  const compactTrackHeight = geometry.compactTrackHeight === undefined
    ? trackHeight
    : Math.min(
      trackHeight,
      Math.max(rowHeight, finitePositive(geometry.compactTrackHeight, trackHeight))
    );
  const maxAnchor = Math.min(
    measuredMaximum,
    Math.max(HOTBAR_ROW_POSITION_MIN, ((compactTrackHeight - rowHeight) / trackHeight) * 100)
  );
  const count = Math.min(HOTBAR_MAX_VISIBLE_ROWS, Math.max(0, Math.trunc(rowCount)));
  if (count <= 1) return { maxAnchor, minAnchorGap: 0 };
  const desiredAnchorGap = ((rowHeight + rowGap) / trackHeight) * 100;
  const maximumFittingGap = maxAnchor / (count - 1);
  return {
    maxAnchor,
    minAnchorGap: Math.min(desiredAnchorGap, maximumFittingGap)
  };
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Decode the persisted slot array while accepting the six/eight-slot migration
 * shapes. Writes continue to use the ten-slot canonical contract. A null
 * result means the row is malformed.
 */
export function decodePersistedHotbarSlots(value: unknown): HotbarPlayerSlot[] | null {
  if (!Array.isArray(value)) return null;
  const expectedIds = value.length === HOTBAR_LEGACY_PLAYER_SLOT_IDS.length
    ? HOTBAR_LEGACY_PLAYER_SLOT_IDS
    : value.length === HOTBAR_LEGACY_EIGHT_SLOT_IDS.length
      ? HOTBAR_LEGACY_EIGHT_SLOT_IDS
      : value.length === HOTBAR_PLAYER_SLOT_IDS.length
        ? HOTBAR_PLAYER_SLOT_IDS
        : null;
  if (!expectedIds) return null;

  const parsed = value
    .map((slot) => hotbarPlayerSlotSchema.safeParse(slot))
    .filter((result): result is { success: true; data: HotbarPlayerSlot } => result.success);
  if (parsed.length !== value.length) return null;
  const slots = parsed.map((result) => result.data);
  const byId = new Map(slots.map((slot) => [slot.slotId, slot]));
  if (
    byId.size !== expectedIds.length
    || expectedIds.some((slotId) => !byId.has(slotId))
  ) return null;

  return HOTBAR_PLAYER_SLOT_IDS.map((slotId) => byId.get(slotId) ?? ({ slotId, binding: null }));
}
