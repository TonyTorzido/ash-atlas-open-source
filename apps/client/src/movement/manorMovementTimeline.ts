import { MANOR_MOVE_SPEED, type ManorPosition } from "@ash-atlas/shared";

import {
  IndoorMovementTimeline,
  type IndoorMovementApplyResult,
  type IndoorRenderedPosition
} from "./indoorMovementTimeline.js";

export type ManorRenderedPosition = IndoorRenderedPosition;
export type ManorMovementApplyResult = IndoorMovementApplyResult;

export class ManorMovementTimeline extends IndoorMovementTimeline<ManorPosition> {
  constructor() {
    super(MANOR_MOVE_SPEED);
  }
}
