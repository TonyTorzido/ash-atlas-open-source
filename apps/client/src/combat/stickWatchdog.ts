/**
 * Pure rules for noticing a floating stick whose finger is gone without the page being told (iOS drops touches for system
 * gestures, banners and backgrounding, and does not always send pointerup or pointercancel). JoystickMovement feeds these.
 */

/** The stick's own touch is no longer among the touches a touch event lists as active. */
export function stickTouchGone(activeTouches: ArrayLike<Readonly<{ identifier: number }>>, stickTouchId: number | null): boolean {
  if (stickTouchId === null) return false;
  for (let i = 0; i < activeTouches.length; i++) if (activeTouches[i]!.identifier === stickTouchId) return false;
  return true;
}

/** The viewport turned between portrait and landscape (a held stick must not survive that). */
export function orientationFlipped(before: Readonly<{ width: number; height: number }>, after: Readonly<{ width: number; height: number }>): boolean {
  return before.width > before.height !== after.width > after.height;
}

/** A pointer-captured stick whose capture is gone (the browser took the finger back) is no longer held. */
export function captureLost(pointerId: number | null, hasCapture: (id: number) => boolean): boolean {
  return pointerId !== null && !hasCapture(pointerId);
}
