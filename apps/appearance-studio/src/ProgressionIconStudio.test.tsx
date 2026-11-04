// @vitest-environment jsdom

import { PROGRESSION_ICON_PRESENTATION_CATALOG, type ProgressionIconPresentationCatalog } from "@ash-atlas/shared";
import { act, createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProgressionIconStudio, type ProgressionIconStudioHandle } from "./ProgressionIconStudio.js";
import type { ProgressionIconInventory } from "./bridgeTypes.js";
import type { StudioApi } from "./studioApi.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProgressionIconStudio", () => {
  it("edits scale and position, saves, then reverts later edits", async () => {
    const base: ProgressionIconPresentationCatalog = {
      ...structuredClone(PROGRESSION_ICON_PRESENTATION_CATALOG),
      transforms: { ...PROGRESSION_ICON_PRESENTATION_CATALOG.transforms, "general:cleave": { offsetX: 0, offsetY: 0, scale: 1 } }
    };
    const icon = {
      key: "general:cleave" as const, id: "cleave" as const, label: "Cleave", group: "general" as const,
      atlasPath: "apps/client/public/assets/skills/general-skills-v3.png", imageUrl: "/runtime-assets/skills.png",
      columns: 5, index: 0, cellSize: 256 as const
    };
    const inventory: ProgressionIconInventory = { catalog: base, icons: [icon] };
    const publishProgressionIcons = vi.fn(async (catalog: ProgressionIconPresentationCatalog) => {
      const saved = { ...catalog, revision: catalog.revision + 1 };
      return { catalog: saved, inventory: { catalog: saved, icons: [icon] }, modifiedFiles: ["catalog.json"] };
    });
    const api = {
      loadProgressionIcons: vi.fn(async () => inventory),
      publishProgressionIcons
    } as unknown as StudioApi;
    const ref = createRef<ProgressionIconStudioHandle>();
    render(<ProgressionIconStudio ref={ref} api={api} visible writesAllowed
      onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "Cleave" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Nudge →" }));
    fireEvent.change(screen.getByLabelText("Scale slider"), { target: { value: "1.4" } });
    await act(async () => ref.current?.save());
    expect(publishProgressionIcons).toHaveBeenCalledWith(expect.objectContaining({
      transforms: expect.objectContaining({ "general:cleave": { offsetX: 0.01, offsetY: 0, scale: 1.4 } })
    }));

    fireEvent.change(screen.getByLabelText("X offset"), { target: { value: "50" } });
    expect((screen.getByLabelText("X offset") as HTMLInputElement).value).toBe("50");
    await act(async () => ref.current?.revert());
    expect((screen.getByLabelText("X offset") as HTMLInputElement).value).toBe("1");
  });
});
