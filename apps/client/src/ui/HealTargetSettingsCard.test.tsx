// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_HEAL_TARGET_SETTINGS, type HealTargetSettings } from "@ash-atlas/shared";

import { HealTargetSettingsCard } from "./HealTargetSettingsCard.js";

afterEach(cleanup);

const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

it("shows the five groups from the server and saves one change at a time", async () => {
  const updateHealTargets = vi.fn(async (update: Partial<HealTargetSettings>) => ({ ...DEFAULT_HEAL_TARGET_SETTINGS, ...update }));
  render(<HealTargetSettingsCard api={{ getHealTargets: async () => DEFAULT_HEAL_TARGET_SETTINGS, updateHealTargets }} />);
  await waitFor(() => expect(box("Heal party").disabled).toBe(false));
  expect([box("Heal party"), box("Heal friends"), box("Heal kingdom"), box("Heal city"), box("Heal everyone else")]
    .map((input) => input.checked)).toEqual([true, true, true, true, false]);
  fireEvent.click(box("Heal everyone else"));
  expect(updateHealTargets).toHaveBeenCalledWith({ neutral: true });
  await waitFor(() => expect(box("Heal everyone else").checked).toBe(true));
});

it("puts a box back and says so when the save fails", async () => {
  render(<HealTargetSettingsCard api={{
    getHealTargets: async () => DEFAULT_HEAL_TARGET_SETTINGS,
    updateHealTargets: async () => { throw new Error("offline"); }
  }} />);
  await waitFor(() => expect(box("Heal city").disabled).toBe(false));
  fireEvent.click(box("Heal city"));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("not saved"));
  expect(box("Heal city").checked).toBe(true);
});
