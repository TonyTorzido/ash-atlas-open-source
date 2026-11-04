import { describe, expect, it } from "vitest";
import { joystickMovementEffective } from "./joystickMovementPreference.js";

describe("joystickMovementEffective", () => {
  it("uses a stored 1 even on desktop without action combat", () => {
    expect(joystickMovementEffective(true, false, false)).toBe(true);
  });
  it("uses a stored 0 even on touch with action combat", () => {
    expect(joystickMovementEffective(false, true, true)).toBe(false);
  });
  it("defaults on for touch-primary devices when action combat is effective", () => {
    expect(joystickMovementEffective(null, true, true)).toBe(true);
  });
  it("stays off on touch when action combat is off", () => {
    expect(joystickMovementEffective(null, true, false)).toBe(false);
  });
  it("stays off on desktop even with action combat on", () => {
    expect(joystickMovementEffective(null, false, true)).toBe(false);
  });
});
