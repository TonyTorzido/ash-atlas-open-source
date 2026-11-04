import { STANDARD_INDOOR_SPATIAL_PROFILE, type IndoorPosition } from "@ash-atlas/shared";

import {
  IndoorMovementTimeline,
  type IndoorMovementApplyResult,
  type IndoorRenderedPosition
} from "./indoorMovementTimeline.js";

export type GreenhouseRenderedPosition = IndoorRenderedPosition;
export type GreenhouseMovementApplyResult = IndoorMovementApplyResult;

/** Greenhouse movement uses the same authoritative indoor reconciliation as Manor and Salon. */
export class GreenhouseMovementTimeline extends IndoorMovementTimeline<IndoorPosition> {
  constructor() {
    super(STANDARD_INDOOR_SPATIAL_PROFILE.movementUnitsPerSecond);
  }
}
