import type {
  PlayerAppearanceSnapshot,
  PlayerSalonStyles
} from "./appearance.js";
import { INTERIOR_DATA } from "./data/interiors/index.js";
import {
  STANDARD_INDOOR_SPATIAL_PROFILE,
  type IndoorPosition
} from "./indoor.js";
import type { InteriorCatalog, InteriorRoom, InteriorSpace } from "./interior/interiorCatalog.js";
import { worldExitOf } from "./interior/interiorRoomRuntime.js";
import {
  SALON_CHAIR_OBJECT_ID,
  salonMainRoomFromInterior,
  salonRoomOf,
  salonSpaceOf
} from "./interior/salonView.js";

/** The unified interior space the Salon is authored in (packages/shared/src/data/interiors/salon.json). */
export const SALON_INTERIOR_SPACE: InteriorSpace = salonSpaceOf(INTERIOR_DATA as unknown as InteriorCatalog);
export const SALON_INTERIOR_ROOM: InteriorRoom = salonRoomOf(SALON_INTERIOR_SPACE);
/** Read-only view over {@link SALON_INTERIOR_SPACE} in the legacy room shape. */
export const SALON_MAIN_ROOM = salonMainRoomFromInterior(SALON_INTERIOR_SPACE);
/** The Salon chair object the server's interaction check uses. */
export const SALON_CHAIR_OBJECT = SALON_INTERIOR_ROOM.objects.find((object) => object.id === SALON_CHAIR_OBJECT_ID)!;

export const SALON_FLOOR_SIZE = SALON_MAIN_ROOM.roomWidth;
export const SALON_PLAYER_VISUAL_HEIGHT_UNITS =
  STANDARD_INDOOR_SPATIAL_PROFILE.playerVisualHeightUnits;
export const SALON_PLAYER_RADIUS = SALON_MAIN_ROOM.playerRadius;
export const SALON_MOVE_SPEED = STANDARD_INDOOR_SPATIAL_PROFILE.movementUnitsPerSecond;
export const SALON_MAX_TARGET_DISTANCE = STANDARD_INDOOR_SPATIAL_PROFILE.maxTargetDistance;
export const SALON_SPAWN = SALON_MAIN_ROOM.spawn;
export const SALON_CHAIR = SALON_MAIN_ROOM.fixtures.chair.position;
export const SALON_CHAIR_INTERACTION_RADIUS = SALON_CHAIR_OBJECT.interactionRadius;
export const SALON_DOOR = worldExitOf(SALON_INTERIOR_SPACE)!.position;
export const SALON_DOOR_INTERACTION_RADIUS = STANDARD_INDOOR_SPATIAL_PROFILE.doorInteractionRadius;
export const SALON_INTERACTION_APPROACH_INSET = 25;
export const SALON_CHAIR_APPROACH = SALON_MAIN_ROOM.fixtures.chair.approachPosition;

export type SalonPosition = IndoorPosition;

export type SalonSessionSnapshot = {
  structureId: string;
  sessionId: string;
  position: SalonPosition;
  movementSequence: number;
  displayColor: string | null;
  appearance?: PlayerAppearanceSnapshot;
};

export type SalonEditorSnapshot = {
  editorSessionId: string;
  releaseSha: string | null;
  catalogRevision: number;
  schemaVersion: number;
  appearanceRevision: number;
  styles: PlayerSalonStyles;
};

export type SalonSaveResult = {
  requestId: string;
  appearanceRevision: number;
  styles: PlayerSalonStyles;
  appearance: PlayerAppearanceSnapshot;
  replayed: boolean;
  price: 0;
};
