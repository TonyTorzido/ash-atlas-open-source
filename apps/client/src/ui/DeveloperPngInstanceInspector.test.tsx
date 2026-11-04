// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { findDevPngAsset } from "../developer/devPngCatalog.js";
import { DevPngLabController } from "../developer/devPngLabController.js";
import { DeveloperPngInstanceInspector } from "./DeveloperPngInstanceInspector.js";

afterEach(cleanup);

describe("selected PNG instance inspector", () => {
  it("shows the failed source and keeps the placement deletable", () => {
    const controller = new DevPngLabController();
    const placement = controller.place(-106, 35)!;
    const asset = findDevPngAsset(placement.assetId)!;
    controller.reportImageFailure(placement.id, {
      url: asset.url,
      sourcePath: asset.sourcePath,
      message: "PNG failed to load."
    });
    const view = render(
      <DeveloperPngInstanceInspector
        controller={controller}
        mapZoom={14}
        onCenter={vi.fn()}
      />
    );

    expect(screen.getByText("⚠ Image unavailable")).toBeTruthy();
    expect(screen.getByText(
      "This PNG failed to load. The small map marker is diagnostic only and does not represent the asset’s real dimensions."
    )).toBeTruthy();
    expect(screen.getByText(asset.sourcePath)).toBeTruthy();
    expect(screen.getByText(asset.url)).toBeTruthy();
    expect(view.container.querySelector("header img")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByLabelText("Selected PNG instance")).toBeNull();
    expect(controller.getSnapshot().placements).toHaveLength(0);
    expect(controller.getSnapshot().imageFailures[placement.id]).toBeUndefined();
  });
});
