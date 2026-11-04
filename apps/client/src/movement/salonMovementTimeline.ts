import { SALON_MOVE_SPEED, type SalonPosition } from "@ash-atlas/shared";

import {
  IndoorMovementTimeline,
  type IndoorMovementApplyResult,
  type IndoorRenderedPosition
} from "./indoorMovementTimeline.js";

export type SalonRenderedPosition = IndoorRenderedPosition;
export type SalonMovementApplyResult = IndoorMovementApplyResult;

export class SalonMovementTimeline extends IndoorMovementTimeline<SalonPosition> {
  constructor() {
    super(SALON_MOVE_SPEED);
  }
}
