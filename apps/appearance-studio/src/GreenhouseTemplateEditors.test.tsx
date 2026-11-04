// @vitest-environment jsdom

import { interiorCatalogFromLegacy } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GreenhousePlantersPanel,
  greenhouseAlphaWeightedPivot,
  greenhouseTemplatePreviewImageFrame,
  templateBounds,
  templateFromPrefab
} from "./GreenhouseTemplateEditors.js";
import type { RuntimeAsset } from "./bridgeTypes.js";
import type { PlanterStageArt } from "./interiorModules.js";
import type { ViewPrefab } from "./interiorStudioModel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const interior = interiorCatalogFromLegacy();
const greenhouse = interior.spaces.find((space) => space.kind === "greenhouse")!;
const potPrefab = interior.library.prefabs.find((prefab) => prefab.id === greenhouse.modules!.planters!.potPrefabId)! as ViewPrefab;
const tankPrefab = interior.library.prefabs.find((prefab) => prefab.id === "greenhouse_water_tank")! as ViewPrefab;

/** The panel over a small stateful stand-in for the Studio's draft (prefabs and stage art). */
function Harness(props: { assets: RuntimeAsset[]; centerPivot?: boolean; onReplace?(assetKey: string, file: File): Promise<boolean>; onState?(state: { pot: ViewPrefab; art: PlanterStageArt[] }): void }) {
  const [prefabs, setPrefabs] = useState<ViewPrefab[]>([{ ...structuredClone(potPrefab), ...(props.centerPivot ? { pivotX: 0.5, pivotY: 0.5 } : {}) }, { ...structuredClone(tankPrefab), ...(props.centerPivot ? { pivotX: 0.5, pivotY: 0.5 } : {}) }]);
  const [art, setArt] = useState<PlanterStageArt[]>(structuredClone(greenhouse.modules!.planters!.stageArt));
  props.onState?.({ pot: prefabs[0]!, art });
  return <GreenhousePlantersPanel
    pot={prefabs[0]!}
    tank={prefabs[1]!}
    stageArt={art}
    capacity={greenhouse.modules!.planters!.capacity}
    assets={props.assets}
    disabled={false}
    onEditPrefab={(prefabId, edit) => setPrefabs((current) => current.map((prefab) => { if (prefab.id !== prefabId) return prefab; const next = structuredClone(prefab); edit(next); return next; }))}
    onEditStageArt={(edit) => setArt((current) => { const next = structuredClone(current); edit(next); return next; })}
    onReplacePng={props.onReplace ?? (async () => true)}
  />;
}

function runtimeAsset(id: string, overrides: Partial<RuntimeAsset> = {}): RuntimeAsset {
  return {
    id,
    label: id,
    category: "greenhouse",
    relativeFile: id,
    imageUrl: "",
    width: 0,
    height: 0,
    bytes: 0,
    contentHash: "",
    usages: [],
    staged: false,
    missing: false,
    ...overrides
  };
}

const anchorX = (): HTMLInputElement => screen.getAllByLabelText("Anchor X")[0] as HTMLInputElement;
const anchorY = (): HTMLInputElement => screen.getAllByLabelText("Anchor Y")[0] as HTMLInputElement;

describe("Greenhouse template editors", () => {
  it("edits the Farm Plot and Water tank templates of the unified library prefabs", () => {
    render(<Harness assets={[]} />);
    expect(screen.getByRole("group", { name: "Farm Plot template" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Water tank template" })).toBeTruthy();
    expect(screen.getByText(`Farm Plot capacity: ${greenhouse.modules!.planters!.capacity} plots`)).toBeTruthy();
    const template = templateFromPrefab(potPrefab);
    expect((screen.getAllByLabelText("Render W")[0] as HTMLInputElement).value).toBe(String(Math.round(template.renderWidth)));
    expect((screen.getAllByLabelText("Footprint W")[0] as HTMLInputElement).value).toBe(String(Math.round(templateBounds(template.physicalFootprint).width)));
  });

  it("refreshes the Farm Plot card after a replacement PNG is staged", () => {
    const { rerender } = render(<Harness assets={[runtimeAsset(potPrefab.assetKey, { missing: true })]} />);
    expect(screen.getByText("Fallback square active")).toBeTruthy();
    rerender(<Harness assets={[runtimeAsset(potPrefab.assetKey, { imageUrl: "/runtime-assets/pot.png", width: 64, height: 48, bytes: 24, contentHash: "new-pot", staged: true })]} />);
    expect(screen.getByAltText("Farm Plot PNG preview").getAttribute("src")).toContain("new-pot");
  });

  it("auto-centers a replaced template PNG on visible alpha unless the pivot was set by hand", async () => {
    const rgba = new Uint8ClampedArray(4 * 2 * 4);
    for (let y = 0; y < 2; y += 1) for (let x = 2; x < 4; x += 1) rgba[(y * 4 + x) * 4 + 3] = 255;
    const bitmap = { width: 4, height: 2, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const context = { drawImage: vi.fn(), getImageData: vi.fn().mockReturnValue({ data: rgba }) } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext);
    const replace = vi.fn().mockResolvedValue(true);
    const file = new File(["pot"], "pot.png", { type: "image/png" });
    // A centered pivot has not been set by hand yet.
    render(<Harness assets={[]} centerPivot onReplace={replace} />);
    fireEvent.change(document.querySelector<HTMLInputElement>("#greenhouse-asset-greenhouse-pot")!, { target: { files: [file] } });
    await waitFor(() => expect(replace).toHaveBeenCalledWith(potPrefab.assetKey, file));
    await waitFor(() => expect(anchorX().value).toBe("0.75"));
    expect(anchorY().value).toBe("0.5");
    expect(bitmap.close).toHaveBeenCalledOnce();

    // A pivot moved by hand keeps its value when the art is replaced again.
    fireEvent.change(anchorX(), { target: { value: "0.2" } });
    fireEvent.change(document.querySelector<HTMLInputElement>("#greenhouse-asset-greenhouse-pot")!, { target: { files: [file] } });
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(anchorX().value).toBe("0.2"));
  });

  it("does not move the pivot when the replacement could not be staged", async () => {
    const replace = vi.fn().mockResolvedValue(false);
    render(<Harness assets={[]} onReplace={replace} />);
    const before = anchorX().value;
    fireEvent.change(document.querySelector<HTMLInputElement>("#greenhouse-asset-greenhouse-pot")!, { target: { files: [new File(["pot"], "pot.png", { type: "image/png" })] } });
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(anchorX().value).toBe(before);
  });

  it("drags the template anchor handle in normalized PNG coordinates", () => {
    render(<Harness assets={[runtimeAsset(potPrefab.assetKey, { missing: true })]} />);
    const editor = screen.getByLabelText("Farm Plot image anchor editor");
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    fireEvent.click(screen.getByRole("button", { name: "Farm Plot image anchor" }), { clientX: 50, clientY: 75 });
    expect(anchorX().value).toBe("0.25");
    expect(anchorY().value).toBe("0.75");
  });

  it("fits arbitrary PNG aspect ratios and keeps pivot mapping through wheel zoom", () => {
    render(<Harness assets={[runtimeAsset(potPrefab.assetKey, { imageUrl: "/runtime-assets/pot.png", width: 400, height: 100, contentHash: "wide-pot" })]} />);
    const editor = screen.getByLabelText("Farm Plot image anchor editor");
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    expect(screen.getByAltText("Farm Plot anchor preview").getAttribute("style")).toContain("height: 25%");
    expect(screen.getAllByRole("button", { name: "Auto-center anchor" })).toHaveLength(2);
    fireEvent.wheel(editor, { deltaY: -250, clientX: 40, clientY: 50 });
    expect(Number(editor.getAttribute("data-zoom"))).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "Farm Plot image anchor" }), { clientX: 40, clientY: 50 });
    expect(anchorX().value).toBe("0.2");
    expect(anchorY().value).toBe("0.5");
    for (let index = 0; index < 10; index += 1) fireEvent.wheel(editor, { deltaY: 10_000, clientX: 100, clientY: 50 });
    expect(Number(editor.getAttribute("data-zoom"))).toBe(0.5);
    for (let index = 0; index < 10; index += 1) fireEvent.wheel(editor, { deltaY: -10_000, clientX: 100, clientY: 50 });
    expect(Number(editor.getAttribute("data-zoom"))).toBe(4);
  });

  it("uses alpha-weighted visible art for auto-center and falls back for opaque PNGs", () => {
    const rgba = new Uint8ClampedArray(4 * 2 * 4);
    for (let y = 0; y < 2; y += 1) for (let x = 2; x < 4; x += 1) rgba[(y * 4 + x) * 4 + 3] = 255;
    expect(greenhouseAlphaWeightedPivot(rgba, 4, 2)).toEqual({ x: 0.75, y: 0.5 });
    const opaque = new Uint8ClampedArray(2 * 2 * 4);
    for (let index = 3; index < opaque.length; index += 4) opaque[index] = 255;
    expect(greenhouseAlphaWeightedPivot(opaque, 2, 2)).toEqual({ x: 0.5, y: 0.5 });
    expect(greenhouseTemplatePreviewImageFrame(400, 100)).toEqual({ left: 0, top: 0.375, width: 1, height: 0.25 });
  });

  it("keeps the physical footprint centered on the anchor while footprint and touch controls change", () => {
    render(<Harness assets={[]} />);
    const preview = (): SVGSVGElement => screen.getAllByRole("img", { name: "Farm Plot frame, footprint and touch area" })[0] as unknown as SVGSVGElement;
    const footprint = (): number[][] => preview().querySelector(".greenhouse-template-footprint")!.getAttribute("points")!.split(" ").map((point) => point.split(",").map(Number));
    fireEvent.change(screen.getAllByLabelText("Footprint W")[0]!, { target: { value: "80" } });
    fireEvent.change(screen.getAllByLabelText("Footprint H")[0]!, { target: { value: "60" } });
    fireEvent.change(anchorX(), { target: { value: "0.2" } });
    fireEvent.change(anchorY(), { target: { value: "0.8" } });
    const xs = footprint().map((point) => point[0]!);
    const ys = footprint().map((point) => point[1]!);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([-40, 40, -30, 30]);
    // The touch area follows the same anchor and switches between circle and rectangle.
    expect(preview().querySelector("circle.greenhouse-template-touch") || preview().querySelector("polygon.greenhouse-template-touch")).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText("Touch shape")[0]!, { target: { value: "rectangle" } });
    fireEvent.change(screen.getAllByLabelText("Touch W")[0]!, { target: { value: "150" } });
    fireEvent.change(screen.getAllByLabelText("Touch H")[0]!, { target: { value: "90" } });
    const touch = preview().querySelector("polygon.greenhouse-template-touch")!.getAttribute("points")!.split(" ").map((point) => point.split(",").map(Number));
    expect([Math.max(...touch.map((point) => point[0]!)), Math.max(...touch.map((point) => point[1]!))]).toEqual([75, 45]);
    fireEvent.change(screen.getAllByLabelText("Touch shape")[0]!, { target: { value: "circle" } });
    expect(Number(preview().querySelector("circle.greenhouse-template-touch")!.getAttribute("r"))).toBe(75);
  });

  it("selects a plant then one stage and edits its art on the authored Farm Plot composite", () => {
    const assets = [
      runtimeAsset(potPrefab.assetKey, { imageUrl: "/runtime-assets/plot.png", width: 200, height: 160, contentHash: "plot" }),
      runtimeAsset("apps/client/src/assets/plants/wheat-seedling.png", { imageUrl: "/runtime-assets/seedling.png", width: 64, height: 64, contentHash: "seedling" }),
      runtimeAsset("apps/client/src/assets/plants/wheat-middle-2.png", { imageUrl: "/runtime-assets/middle-2.png", width: 64, height: 64, contentHash: "middle-2" })
    ];
    render(<Harness assets={assets} />);
    expect((screen.getByLabelText("Plant to author") as HTMLSelectElement).value).toBe("wheat");
    expect(screen.getByRole("group", { name: "Wheat stages" })).toBeTruthy();
    const stagePreview = screen.getByTestId("greenhouse-stage-preview-1");
    expect(stagePreview.querySelector(".greenhouse-plant-stage-plot")?.getAttribute("src")).toContain("plot");
    expect(stagePreview.querySelector(".greenhouse-plant-stage-art")?.getAttribute("src")).toContain("seedling");
    const offset = screen.getByLabelText("Offset X") as HTMLInputElement;
    fireEvent.change(offset, { target: { value: "12" } });
    expect(offset.value).toBe("12");
    fireEvent.click(screen.getByRole("button", { name: "Middle 2" }));
    expect(screen.queryByTestId("greenhouse-stage-preview-1")).toBeNull();
    expect(screen.getByTestId("greenhouse-stage-preview-2").querySelector(".greenhouse-plant-stage-art")?.getAttribute("src")).toContain("middle-2");
    // Edits stick to the stage they were made on.
    fireEvent.click(screen.getByRole("button", { name: "Seedling" }));
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe("12");
    fireEvent.change(screen.getByLabelText("Plant to author"), { target: { value: "giving_berry_tree" } });
    expect(screen.getByRole("group", { name: "Giving Berry Tree stages" })).toBeTruthy();
  });
});
