import type {
  ManorGuestManagementSnapshot,
  ManorOccupantPresenceSnapshot,
  ManorOccupantAccessSource,
  ManorPosition,
  ManorStorageSnapshot,
  ManorStorageResult,
  ManorStorageUpgradeResult,
  ManorStorageUpgradeSnapshot,
  ManorWorldSnapshot,
  ManorDecorationMutationResult,
  ManorDecorationSnapshot
} from "../manor.js";
import type { JewelStationMutationResult, JewelStationState } from "../manor.js";
import type {
  FurnaceBuildSnapshot,
  FurnaceStateSnapshot,
  FurnaceWorldSnapshot
} from "../furnace.js";
import type { PremiumWalletSnapshot } from "../premiumCurrency.js";
import type {
  TanneryBuildSnapshot,
  TanneryStateSnapshot,
  TanneryWorldSnapshot
} from "../tannery.js";
import type {
  LoomBuildSnapshot,
  LoomStateSnapshot,
  LoomWorldSnapshot
} from "../loom.js";
import type {
  KitchenBuildSnapshot,
  KitchenStateSnapshot,
  KitchenWorldSnapshot
} from "../kitchen.js";
import type {
  FishingHutBuildSnapshot,
  FishingHutWorldSnapshot,
  FishingStateSnapshot,
  FishingCatchSnapshot,
  FishingRecordSnapshot,
  FishingUpgradeSnapshot,
  FishingSpecializationSnapshot
} from "../fishing.js";
import type { DroppedItemSnapshot } from "../droppedItems.js";
import type { PlayerInventorySnapshot } from "../collectibles.js";
import type { PlayerAppearanceSnapshot } from "../appearance.js";
import type { PlayerSnapshot } from "../playerSnapshotContracts.js";
import type {
  GreenhouseBuildPreview,
  GreenhouseBuildSnapshot,
  GreenhouseSnapshot,
  GreenhouseStateSnapshot,
  GreenhouseMutationResult
} from "../greenhouse.js";

export type ManorServerMessage =
  | { type: "MANOR_STATUS"; manor: ManorWorldSnapshot | null }
  | { type: "MANOR_BUILD_RESULT"; requestId: string; manor: ManorWorldSnapshot; inventory?: PlayerInventorySnapshot; replayed: boolean }
  | { type: "MANOR_UPGRADES_SNAPSHOT"; requestId: string; snapshot: ManorStorageUpgradeSnapshot }
  | ({ type: "MANOR_UPGRADE_RESULT" } & ManorStorageUpgradeResult)
  | {
      type: "MANOR_DESTROY_RESULT";
      requestId: string;
      manorId: string;
      placementRevision: number;
      replayed: boolean;
    }
  | { type: "MANORS_SNAPSHOT"; manors: ManorWorldSnapshot[] }
  /** Manor warfare: the acting player's result. */
  | {
      type: "MANOR_WARFARE_CHANGED";
      requestId: string;
      action: "attack" | "repair_started" | "repair_stopped";
      manorId: string;
      damage?: number;
      replayed: boolean;
    }
  /** Manor warfare: a built Manor's health changed (broadcast). */
  | { type: "MANOR_WORLD_UPDATED"; manor: ManorWorldSnapshot }
  | {
      type: "MANOR_SKIN_RESULT";
      requestId: string;
      action: "install" | "purchase";
      /** The owner's Manor after an install (null for purchases). */
      manor: ManorWorldSnapshot | null;
      inventory: PlayerInventorySnapshot;
      premiumWallet?: PremiumWalletSnapshot;
      replayed: boolean;
      message: string;
    }
  | { type: "FURNACES_SNAPSHOT"; furnaces: FurnaceWorldSnapshot[] }
  | {
      type: "FURNACE_BUILD_STARTED";
      requestId: string;
      build: FurnaceBuildSnapshot;
      inventory: PlayerInventorySnapshot;
      serverTime: number;
      replayed: boolean;
    }
  | {
      type: "FURNACE_BUILD_RESULT";
      requestId: string;
      furnace: FurnaceWorldSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
    }
  | {
      type: "FURNACE_BUILD_CANCELLED";
      requestId: string;
      buildId: string;
      inventory: PlayerInventorySnapshot;
      droppedItems: DroppedItemSnapshot[];
      message: string;
    }
  | { type: "FURNACE_STATE"; requestId?: string; state: FurnaceStateSnapshot }
  | {
      type: "FURNACE_SMELT_STARTED";
      requestId: string;
      state: FurnaceStateSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
    }
  | {
      type: "FURNACE_OUTPUT_COLLECTED";
      requestId: string;
      state: FurnaceStateSnapshot;
      inventory: PlayerInventorySnapshot;
      collectedQuantity: number;
      replayed: boolean;
    }
  | {
      type: "FURNACE_GLIMMER_OIL_REFINED";
      requestId: string;
      state: FurnaceStateSnapshot;
      inventory: PlayerInventorySnapshot;
      premiumWallet: PremiumWalletSnapshot;
      refinedQuantity: number;
      replayed: boolean;
    }
  | { type: "FURNACE_ERROR"; requestId?: string; code: string; message: string; suggestedPosition?: { lat: number; lon: number } }
  | { type: "TANNERIES_SNAPSHOT"; tanneries: TanneryWorldSnapshot[] }
  | { type: "TANNERY_BUILD_STARTED"; requestId: string; build: TanneryBuildSnapshot; inventory: PlayerInventorySnapshot; serverTime: number; replayed: boolean }
  | { type: "TANNERY_BUILD_RESULT"; requestId: string; tannery: TanneryWorldSnapshot; inventory: PlayerInventorySnapshot; replayed: boolean }
  | { type: "TANNERY_BUILD_CANCELLED"; requestId: string; buildId: string; inventory: PlayerInventorySnapshot; droppedItems: DroppedItemSnapshot[]; message: string }
  | { type: "TANNERY_STATE"; requestId?: string; state: TanneryStateSnapshot }
  | { type: "TANNERY_BATCH_STARTED"; requestId: string; state: TanneryStateSnapshot; inventory: PlayerInventorySnapshot; replayed: boolean }
  | { type: "TANNERY_OUTPUT_COLLECTED"; requestId: string; state: TanneryStateSnapshot; inventory: PlayerInventorySnapshot; collectedQuantity: number; replayed: boolean }
  | { type: "TANNERY_ERROR"; requestId?: string; code: string; message: string; suggestedPosition?: { lat: number; lon: number } }
  | { type: "LOOMS_SNAPSHOT"; looms: LoomWorldSnapshot[] }
  | { type: "LOOM_BUILD_STARTED"; requestId: string; build: LoomBuildSnapshot; inventory: PlayerInventorySnapshot; serverTime: number; replayed: boolean }
  | { type: "LOOM_BUILD_RESULT"; requestId: string; loom: LoomWorldSnapshot; inventory: PlayerInventorySnapshot; replayed: boolean }
  | { type: "LOOM_BUILD_CANCELLED"; requestId: string; buildId: string; inventory: PlayerInventorySnapshot; droppedItems: DroppedItemSnapshot[]; message: string }
  | { type: "LOOM_STATE"; requestId?: string; state: LoomStateSnapshot }
  | { type: "LOOM_BATCH_STARTED"; requestId: string; state: LoomStateSnapshot; inventory: PlayerInventorySnapshot; replayed: boolean }
  | { type: "LOOM_OUTPUT_COLLECTED"; requestId: string; state: LoomStateSnapshot; inventory: PlayerInventorySnapshot; collectedQuantity: number; replayed: boolean }
  | { type: "LOOM_ERROR"; requestId?: string; code: string; message: string; suggestedPosition?: { lat: number; lon: number } }
  | { type: "KITCHENS_SNAPSHOT"; kitchens: KitchenWorldSnapshot[] }
  | { type: "KITCHEN_BUILD_STARTED"; requestId: string; build: KitchenBuildSnapshot; inventory: PlayerInventorySnapshot; serverTime: number; replayed: boolean }
  | { type: "KITCHEN_BUILD_RESULT"; requestId: string; kitchen: KitchenWorldSnapshot; inventory: PlayerInventorySnapshot; replayed: boolean }
  | { type: "KITCHEN_BUILD_CANCELLED"; requestId: string; buildId: string; inventory: PlayerInventorySnapshot; droppedItems: DroppedItemSnapshot[]; message: string }
  | { type: "KITCHEN_STATE"; requestId?: string; state: KitchenStateSnapshot }
  | { type: "KITCHEN_BATCH_STARTED"; requestId: string; state: KitchenStateSnapshot; inventory: PlayerInventorySnapshot; replayed: boolean; /** Cook-any: items left uncooked because the queue filled. */ leftoverQuantity?: number }
  | { type: "KITCHEN_OUTPUT_COLLECTED"; requestId: string; state: KitchenStateSnapshot; inventory: PlayerInventorySnapshot; collectedQuantity: number; replayed: boolean }
  | { type: "KITCHEN_ERROR"; requestId?: string; code: string; message: string; suggestedPosition?: { lat: number; lon: number } }
  | { type: "GREENHOUSES_SNAPSHOT"; greenhouses: GreenhouseSnapshot[] }
  | { type: "GREENHOUSE_BUILD_PREVIEW"; requestId: string; preview: GreenhouseBuildPreview }
  | { type: "GREENHOUSE_BUILD_STARTED"; requestId: string; build: GreenhouseBuildSnapshot; inventory: PlayerInventorySnapshot; serverTime: number; replayed: boolean }
  | { type: "GREENHOUSE_BUILD_RESULT"; requestId: string; greenhouse: GreenhouseSnapshot; inventory: PlayerInventorySnapshot; replayed: boolean }
  | { type: "GREENHOUSE_BUILD_CANCELLED"; requestId: string; buildId: string; inventory: PlayerInventorySnapshot; droppedItems: DroppedItemSnapshot[]; message: string }
  | { type: "GREENHOUSE_DESTROY_RESULT"; requestId: string; greenhouseId: string; placementRevision: number; replayed: boolean }
  | { type: "GREENHOUSE_STATE"; requestId?: string; state: GreenhouseStateSnapshot }
  | { type: "GREENHOUSE_POSITION"; greenhouseSessionId: string; position: { x: number; y: number; targetX: number | null; targetY: number | null; moving: boolean; revision: number }; movementSequence: number; serverTime: number }
  | ({ type: "GREENHOUSE_MUTATION_RESULT" } & GreenhouseMutationResult & { requestId: string; action: "plant" | "water" | "clip" | "harvest" | "tap" | "deposit" | "refill" | "place"; yieldQuantity?: number })
  | { type: "GREENHOUSE_BUCKET_RESULT"; requestId: string; inventory: PlayerInventorySnapshot; waterBucketGallons: number; gardeningBucketGallons: number; replayed: boolean }
  | { type: "GREENHOUSE_FERTILIZER_RESULT"; requestId: string; inventory: PlayerInventorySnapshot; replayed: boolean }
  | { type: "GREENHOUSE_WATER_FILL_STARTED"; requestId: string; gallons: number; completesAt: number; rangeM: number; message: string }
  | { type: "GREENHOUSE_WATER_FILL_RESULT"; requestId: string; gallons: number; waterBucketGallons: number; inventory: PlayerInventorySnapshot; replayed: boolean }
  | { type: "GREENHOUSE_ERROR"; requestId?: string; code: string; message: string; suggestedPosition?: { lat: number; lon: number } }
  | { type: "FISHING_HUTS_SNAPSHOT"; fishingHuts: FishingHutWorldSnapshot[] }
  | { type: "FISHING_HUT_BUILD_STARTED"; requestId: string; build: FishingHutBuildSnapshot; inventory: PlayerInventorySnapshot; serverTime: number; replayed: boolean }
  | { type: "FISHING_HUT_BUILD_RESULT"; requestId: string; fishingHut: FishingHutWorldSnapshot; inventory: PlayerInventorySnapshot; replayed: boolean }
  | { type: "FISHING_HUT_BUILD_CANCELLED"; requestId: string; buildId: string; inventory: PlayerInventorySnapshot; droppedItems: DroppedItemSnapshot[]; message: string }
  | { type: "FISHING_STATE"; requestId?: string; state: FishingStateSnapshot }
  | { type: "FISHING_PROGRESS_RESULT"; requestId: string; state: FishingStateSnapshot; inventory: PlayerInventorySnapshot; upgrades: readonly FishingUpgradeSnapshot[]; specialization: FishingSpecializationSnapshot; replayed: boolean; rodId?: string; walletGold?: string; walletVersion?: string }
  | { type: "FISHING_PASSIVE_COLLECTED"; requestId: string; state: FishingStateSnapshot; inventory: PlayerInventorySnapshot; collectedQuantity: number; replayed: boolean }
  | { type: "FISHING_ENCOUNTER_STARTED"; requestId: string; state: FishingStateSnapshot; replayed: boolean }
  | { type: "FISHING_ENCOUNTER_STATE"; requestId?: string; state: FishingStateSnapshot }
  | { type: "FISHING_CAST_RESULT"; requestId: string; state: FishingStateSnapshot; replayed: boolean }
  | { type: "FISHING_HOOK_RESULT"; requestId: string; state: FishingStateSnapshot; replayed: boolean }
  | { type: "FISHING_CONTROL_RESULT"; requestId: string; state: FishingStateSnapshot; replayed: boolean }
  | { type: "FISHING_CATCH_LANDED"; requestId: string; state: FishingStateSnapshot; catch: FishingCatchSnapshot | null; inventory?: PlayerInventorySnapshot; collectedQuantity: number; replayed: boolean }
  | { type: "FISHING_RECORDS"; requestId: string; records: FishingRecordSnapshot }
  | { type: "FISHING_ERROR"; requestId?: string; code: string; message: string; suggestedPosition?: { lat: number; lon: number } }
  | { type: "JEWEL_STATION_STATE"; requestId: string; state: JewelStationState }
  | ({ type: "JEWEL_STATION_RESULT" } & JewelStationMutationResult)
  | { type: "JEWEL_STATION_ERROR"; requestId?: string; code: string; message: string }
  | {
      type: "MANOR_ENTERED";
      requestId?: string;
      manorId: string;
      manorSessionId: string;
      displayColor: string | null;
      appearance?: PlayerAppearanceSnapshot;
      position: ManorPosition;
      movementSequence: number;
      serverTime: number;
      spaceId?: string;
      /** Manor type (interior space id) of the entered Manor; absent means the default type. */
      manorTypeId?: string;
      accessSource: ManorOccupantAccessSource;
      storage: ManorStorageSnapshot | null;
      decorations?: ManorDecorationSnapshot;
      droppedItems?: DroppedItemSnapshot[];
    }
  | { type: "MANOR_ENTRY_PENDING"; requestId: string; manorId: string; message: string }
  | { type: "MANOR_GUESTS"; requestId?: string; snapshot: ManorGuestManagementSnapshot }
  | { type: "MANOR_OCCUPANTS"; manorId: string; occupants: ManorOccupantPresenceSnapshot[]; serverTime: number }
  | { type: "MANOR_EXITED"; requestId?: string; reason?: string; player: PlayerSnapshot; resourceVisionRevision?: number }
  | {
      type: "MANOR_POSITION";
      manorSessionId: string;
      position: ManorPosition;
      movementSequence: number;
      serverTime: number;
      spaceId?: string;
    }
  | { type: "MANOR_STORAGE_SNAPSHOT"; requestId: string; manorSessionId: string; storage: ManorStorageSnapshot }
  | { type: "MANOR_STORAGE_VIEW_SNAPSHOT"; requestId: string; storage: ManorStorageSnapshot }
  | ({ type: "MANOR_STORAGE_UPDATED" } & ManorStorageResult)
  | { type: "MANOR_DECORATIONS_SNAPSHOT"; requestId: string; snapshot: ManorDecorationSnapshot }
  | ({ type: "MANOR_DECORATION_UPDATED" } & ManorDecorationMutationResult)
  | {
      type: "MANOR_EQUIPMENT_DROPS_UPDATED";
      manorId: string;
      drops: DroppedItemSnapshot[];
      serverTime: number;
    }
  | { type: "MANOR_ERROR"; requestId?: string; code: string; message: string };
