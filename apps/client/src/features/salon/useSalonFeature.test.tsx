// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import {
  SALON_CHAIR,
  SALON_CHAIR_APPROACH
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import type { GameClient } from "../../gameClient.js";
import { useSalonFeature } from "./useSalonFeature.js";

function setup() {
  const commands = {
    enterSalon: vi.fn(() => "enter"),
    salonMoveTo: vi.fn(() => "move"),
    beginSalonCustomize: vi.fn(() => "customize"),
    saveSalonAppearance: vi.fn(() => "save"),
    cancelSalonCustomize: vi.fn(() => "cancel"),
    exitSalon: vi.fn(() => "exit")
  };
  const client = { current: commands as unknown as GameClient };
  const result = renderHook(() => useSalonFeature(client, vi.fn())).result;
  act(() => result.current.handleServerMessage({
    type: "SALON_ENTERED",
    structureId: "salon-1",
    salonSessionId: "session-1",
    displayColor: null,
    position: {
      x: 500, y: 790, targetX: null, targetY: null, moving: false, revision: 0
    },
    movementSequence: 0,
    serverTime: 1_000
  }));
  return { commands, result };
}

describe("useSalonFeature chair intent", () => {
  it("approaches and opens the editor once after authoritative arrival", () => {
    const { commands, result } = setup();
    act(() => result.current.handleServerMessage({
      type: "SALON_POSITION",
      salonSessionId: "session-1",
      position: {
        x: 100, y: SALON_CHAIR.y, targetX: null, targetY: null, moving: false, revision: 1
      },
      movementSequence: 1,
      serverTime: 1_050
    }));
    act(() => { void result.current.customize(); });
    expect(commands.salonMoveTo).toHaveBeenCalledWith(
      "session-1",
      SALON_CHAIR_APPROACH.x,
      SALON_CHAIR_APPROACH.y
    );
    expect(commands.beginSalonCustomize).not.toHaveBeenCalled();
    expect(result.current.customizing).toBe(true);

    act(() => result.current.handleServerMessage({
      type: "SALON_POSITION",
      salonSessionId: "session-1",
      position: {
        x: 300, y: 220,
        targetX: SALON_CHAIR_APPROACH.x, targetY: SALON_CHAIR_APPROACH.y,
        moving: true, revision: 2
      },
      movementSequence: 2,
      serverTime: 1_100
    }));
    expect(commands.beginSalonCustomize).not.toHaveBeenCalled();

    act(() => result.current.handleServerMessage({
      type: "SALON_POSITION",
      salonSessionId: "session-1",
      position: {
        x: SALON_CHAIR_APPROACH.x, y: SALON_CHAIR_APPROACH.y,
        targetX: null, targetY: null, moving: false, revision: 3
      },
      movementSequence: 3,
      serverTime: 1_200
    }));
    expect(commands.beginSalonCustomize).toHaveBeenCalledOnce();
    expect(commands.beginSalonCustomize).toHaveBeenCalledWith("session-1", 3);
  });

  it("cancels a pending chair action when the player chooses manual movement", () => {
    const { commands, result } = setup();
    act(() => { void result.current.customize(); });
    act(() => { void result.current.move(700, 700); });
    act(() => result.current.handleServerMessage({
      type: "SALON_POSITION",
      salonSessionId: "session-1",
      position: {
        x: 500, y: 255, targetX: null, targetY: null, moving: false, revision: 2
      },
      movementSequence: 2,
      serverTime: 1_200
    }));
    expect(commands.salonMoveTo).toHaveBeenCalledTimes(2);
    expect(commands.beginSalonCustomize).not.toHaveBeenCalled();
    expect(result.current.customizing).toBe(false);
  });
});
