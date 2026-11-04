/**
 * The local player's held movement input (joystick, keys or gamepad), screen space, x right / y down, unit length.
 * Render only: the Jacket B player turns on the frame the horizontal sign changes, before the position catches up.
 * Written by JoystickMovement each frame while a move is held; inactive otherwise.
 */
export const localMoveInput = { active: false, dx: 0, dy: 0 };

/**
 * The local player's held attack input (touch attack stick, right mouse button, gamepad aim stick), render only.
 * While any is held the Jacket B sword keeps facing the attack (owner 2026-10-20); `dx` is the held aim's screen x
 * (unit vector), or null while held without a direction (a still tap-and-hold auto-aims).
 */
export const localAttackInput = { touch: false, mouse: false, pad: false, dx: null as number | null };

/** Any attack input held by the local player. */
export function localAttackHeld(): boolean {
  return localAttackInput.touch || localAttackInput.mouse || localAttackInput.pad;
}
