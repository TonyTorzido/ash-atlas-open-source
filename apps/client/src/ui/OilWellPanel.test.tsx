// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OilWellPanel,
  oilWellProductionPresentation
} from "./OilWellPanel.js";

afterEach(cleanup);

describe("OilWellPanel", () => {
  it("shows private production and owner controls on desktop and phone", () => {
    const onHarvest = vi.fn();
    const onDestroy = vi.fn();
    const well = {
      structureId: "00000000-0000-4000-8000-000000000001",
      ownerPlayerId: "owner",
      ownerUsername: "Actual Owner",
      storedCrudeOil: 17,
      capacity: 120,
      productionPerHour: 10,
      serverTime: Date.now(),
      nextUnitAt: new Date(Date.now() + 360_000).toISOString(),
      canHarvest: true,
      canDestroy: true
    } as const;

    const { rerender } = render(
      <OilWellPanel
        open
        well={well}
        feedback="Harvest ready"
        busy={false}
        online
        layout="desktop"
        onHarvest={onHarvest}
        onDestroy={onDestroy}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole("dialog", { name: "Actual Owner's Oil Well" })).toBeTruthy();
    expect(screen.getByText("17 / 120")).toBeTruthy();
    expect(screen.getByText(/^Next unit in 6:0[01]$/)).toBeTruthy();
    expect(screen.getByText(/Change access in person at the Oil Well/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Harvest 17 Crude Oil" }));
    expect(screen.queryByRole("button", { name: "Destroy Oil Well" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Well options" }));
    fireEvent.click(screen.getByRole("button", { name: "Destroy Oil Well" }));
    expect(onHarvest).toHaveBeenCalledOnce();
    expect(onDestroy).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Destroy Oil Well" })).toBeNull();

    rerender(
      <OilWellPanel
        open
        well={{ ...well, storedCrudeOil: 0, canHarvest: false }}
        feedback={null}
        busy={false}
        online
        layout="phone"
        onHarvest={onHarvest}
        onDestroy={onDestroy}
        onClose={vi.fn()}
      />
    );
    expect((screen.getByRole("button", {
      name: "No Crude Oil Available"
    }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);

    rerender(
      <OilWellPanel
        open
        well={{ ...well, storedCrudeOil: 1, canHarvest: true }}
        feedback={null}
        busy={false}
        online
        layout="phone"
        onHarvest={onHarvest}
        onDestroy={onDestroy}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Harvest 1 Crude Oil" })).toBeTruthy();
  });

  it("shows full storage without a running countdown", () => {
    const now = Date.parse("2026-07-31T00:00:00.000Z");
    expect(oilWellProductionPresentation({
      structureId: "well",
      ownerPlayerId: "owner",
      ownerUsername: "Owner",
      storedCrudeOil: 120,
      capacity: 120,
      productionPerHour: 10,
      serverTime: now,
      nextUnitAt: null,
      canHarvest: true,
      canDestroy: true
    }, now)).toEqual({
      full: true,
      progress: 1,
      timerLabel: "Storage Full"
    });

    expect(oilWellProductionPresentation({
      structureId: "well",
      ownerPlayerId: "owner",
      ownerUsername: "Owner",
      storedCrudeOil: 2,
      capacity: 120,
      productionPerHour: 10,
      serverTime: now,
      nextUnitAt: new Date(now + 3 * 60_000).toISOString(),
      canHarvest: true,
      canDestroy: true
    }, now)).toMatchObject({
      full: false,
      progress: 0.5,
      timerLabel: "Next unit in 3:00"
    });
  });
});
