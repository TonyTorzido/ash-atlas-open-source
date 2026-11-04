import type {
  ManorOccupantAccessSource,
  ManorServerMessage,
  PlayerAppearanceSnapshot,
  ServerMessage
} from "@ash-atlas/shared";

export type LocationMode = "world" | "manor" | "transitioning";

export type ManorClientSession = {
  manorId: string;
  spaceId?: string;
  /** Manor type (interior space id) of the entered Manor; absent means the default type. */
  manorTypeId?: string;
  sessionId: string;
  accessSource: ManorOccupantAccessSource;
  appearance?: PlayerAppearanceSnapshot;
};

export type ManorPendingRequests = {
  move: string | null;
  build: string | null;
  destroy: string | null;
  jump: string | null;
  entry: string | null;
  exit: string | null;
  decorations: string | null;
  /** Skin install or Glimmer purchase in flight. */
  skin: string | null;
};

export const emptyPendingRequests = (): ManorPendingRequests => ({
  move: null,
  build: null,
  destroy: null,
  jump: null,
  entry: null,
  exit: null,
  decorations: null,
  skin: null
});

const MANOR_FRAME_TYPES = new Set<ServerMessage["type"]>([
  "MANOR_STATUS",
  "MANOR_BUILD_RESULT",
  "MANOR_UPGRADES_SNAPSHOT",
  "MANOR_UPGRADE_RESULT",
  "MANOR_DESTROY_RESULT",
  "MANOR_SKIN_RESULT",
  "MANORS_SNAPSHOT",
  "MANOR_WARFARE_CHANGED",
  "MANOR_WORLD_UPDATED",
  "MANOR_ENTERED",
  "MANOR_ENTRY_PENDING",
  "MANOR_GUESTS",
  "MANOR_OCCUPANTS",
  "MANOR_EXITED",
  "MANOR_POSITION",
  "MANOR_STORAGE_SNAPSHOT",
  "MANOR_STORAGE_VIEW_SNAPSHOT",
  "MANOR_STORAGE_UPDATED",
  "MANOR_DECORATIONS_SNAPSHOT",
  "MANOR_DECORATION_UPDATED",
  "MANOR_EQUIPMENT_DROPS_UPDATED",
  "MANOR_ERROR",
  "FURNACES_SNAPSHOT",
  "FURNACE_BUILD_STARTED",
  "FURNACE_BUILD_RESULT",
  "FURNACE_BUILD_CANCELLED",
  "FURNACE_STATE",
  "FURNACE_SMELT_STARTED",
  "FURNACE_OUTPUT_COLLECTED",
  "FURNACE_GLIMMER_OIL_REFINED",
  "FURNACE_ERROR",
  "TANNERIES_SNAPSHOT",
  "TANNERY_BUILD_STARTED",
  "TANNERY_BUILD_RESULT",
  "TANNERY_BUILD_CANCELLED",
  "TANNERY_STATE",
  "TANNERY_BATCH_STARTED",
  "TANNERY_OUTPUT_COLLECTED",
  "TANNERY_ERROR",
  "LOOMS_SNAPSHOT",
  "LOOM_BUILD_STARTED",
  "LOOM_BUILD_RESULT",
  "LOOM_BUILD_CANCELLED",
  "LOOM_STATE",
  "LOOM_BATCH_STARTED",
  "LOOM_OUTPUT_COLLECTED",
  "LOOM_ERROR",
  "KITCHENS_SNAPSHOT",
  "KITCHEN_BUILD_STARTED",
  "KITCHEN_BUILD_RESULT",
  "KITCHEN_BUILD_CANCELLED",
  "KITCHEN_STATE",
  "KITCHEN_BATCH_STARTED",
  "KITCHEN_OUTPUT_COLLECTED",
  "KITCHEN_ERROR",
  "GREENHOUSES_SNAPSHOT",
  "GREENHOUSE_BUILD_PREVIEW",
  "GREENHOUSE_BUILD_STARTED",
  "GREENHOUSE_BUILD_RESULT",
  "GREENHOUSE_BUILD_CANCELLED",
  "GREENHOUSE_DESTROY_RESULT",
  "GREENHOUSE_STATE",
  "GREENHOUSE_POSITION",
  "GREENHOUSE_MUTATION_RESULT",
  "GREENHOUSE_BUCKET_RESULT",
  "GREENHOUSE_FERTILIZER_RESULT",
  "GREENHOUSE_WATER_FILL_STARTED",
  "GREENHOUSE_WATER_FILL_RESULT",
  "GREENHOUSE_ERROR",
  "FISHING_HUTS_SNAPSHOT",
  "FISHING_HUT_BUILD_STARTED",
  "FISHING_HUT_BUILD_RESULT",
  "FISHING_HUT_BUILD_CANCELLED",
  "FISHING_STATE",
  "FISHING_PASSIVE_COLLECTED",
  "FISHING_ENCOUNTER_STARTED",
  "FISHING_ENCOUNTER_STATE",
  "FISHING_PROGRESS_RESULT",
  "FISHING_CAST_RESULT",
  "FISHING_HOOK_RESULT",
  "FISHING_CONTROL_RESULT",
  "FISHING_CATCH_LANDED",
  "FISHING_RECORDS",
  "FISHING_ERROR",
  "JEWEL_STATION_STATE",
  "JEWEL_STATION_RESULT",
  "JEWEL_STATION_ERROR"
]);

export function isManorServerMessage(message: ServerMessage): message is ManorServerMessage {
  return MANOR_FRAME_TYPES.has(message.type);
}
