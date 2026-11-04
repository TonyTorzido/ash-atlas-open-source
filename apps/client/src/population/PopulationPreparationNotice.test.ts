import { describe, expect, it } from "vitest";

import {
  populationPreparationCopy
} from "./PopulationPreparationNotice.js";

describe("PopulationPreparationNotice copy", () => {
  it("does not describe valid-area rehydration as generating wilds", () => {
    expect(populationPreparationCopy("durable-rehydration")).toEqual({
      label: "Restoring nearby wildlife…",
      ariaLabel: "Restoring nearby wildlife"
    });
  });

  it("distinguishes activation, regeneration, compatibility, and pressure", () => {
    expect(populationPreparationCopy("simulation-activation").label)
      .toMatch(/Waking/u);
    expect(populationPreparationCopy("replacement-required").label)
      .toMatch(/Refreshing/u);
    expect(populationPreparationCopy("guarded-materialization").label)
      .toMatch(/compatibility/u);
    expect(populationPreparationCopy("backpressure-retry").label)
      .toMatch(/busy; retrying/u);
  });
});
