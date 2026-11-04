// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GREENHOUSE_ROOM_HEIGHT, GREENHOUSE_ROOM_WIDTH, GREENHOUSE_STUDIO_CATALOG, greenhousePlantStageArtFrame, greenhouseTemplateFootprint, greenhouseTemplateImageFrame } from "@ash-atlas/shared";
import { GreenhouseMovementTimeline } from "../movement/greenhouseMovementTimeline.js";
vi.mock("./GreenhousePlayerLayer.js", () => ({ GreenhousePlayerLayer: () => null }));
const cropPackFixture = vi.hoisted(() => ({ packId: "a".repeat(64) }));
vi.mock("../map/runtimePngAssetUrl.js", () => ({
  runtimePngAssetUrl: (path: string) => `/runtime/${path}`,
  selectedRuntimePngContentPack: () => ({
    packId: cropPackFixture.packId,
    greenhouseCropPresentations: [{
      cropId: "wheat",
      displayName: "Wheat",
      seedDisplayName: "Wheat Seed",
      seedItemId: "wheat_seed",
      seedVariant: null,
      stages: [1, 2, 3, 4].map((stage) => ({
        stage,
        artId: ["wheat_seedling", "wheat_middle_2", "wheat_middle_3", "wheat_full"][stage - 1],
        assetId: `wheat-stage-${stage}`,
        pivotX: 0.5,
        pivotY: 0.5,
        offsetX: 0,
        offsetY: 0,
        scale: 0.68
      }))
    }]
  }),
  greenhouseCropStageAssetUrl: (cropId: string, stage: number) => cropId === "wheat" ? `/crop-art/${cropId}/${stage}.png` : null
}));
import { GreenhouseScene } from "./GreenhouseScene.js";

const anchor = GREENHOUSE_STUDIO_CATALOG.anchors[0]!;

function state(gardeningBucketGallons = 0, tankWaterTenths = 0) {
  return {
    greenhouse: {
      greenhouseId: "greenhouse-1",
      ownerPlayerId: "player-1",
      regionCode: "world-test",
      lat: 35,
      lon: -106,
      builtAt: new Date(0).toISOString(),
      placementRevision: 1,
      roomCount: 1,
      planterCapacity: 15,
      tankWaterTenths,
      tankCapacityTenths: 200,
      eligibility: { isRiverbank: false, policyId: "test", policyDistanceM: 500, checkedAt: new Date(0).toISOString() },
      anchors: [{ ...anchor, active: true, plant: null }]
    },
    serverTime: Date.now(),
    waterBucketGallons: 0,
    gardeningBucketGallons,
    inventory: { totals: { wheat_seed: 1 }, items: [] },
    cropCatalog: {
      packId: cropPackFixture.packId,
      crops: [{
        cropId: "wheat",
        displayName: "Wheat",
        seedDisplayName: "Wheat Seed",
        seed: { itemId: "wheat_seed", variant: null },
        maxStage: 4,
        harvestQuantity: 5,
        clippingStages: [3],
        plantingAvailable: true,
        stageArtIds: ["wheat_seedling", "wheat_middle_2", "wheat_middle_3", "wheat_full"]
      }]
    }
  } as never;
}

function position(x: number, y: number, moving = false) {
  return {
    position: { x, y, targetX: moving ? anchor.x : null, targetY: moving ? anchor.y : null, moving, revision: 1 },
    movementSequence: 1,
    serverTime: Date.now()
  } as never;
}

describe("GreenhouseScene planter interactions", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("approaches a planter before planting and waits the half-second action time", () => {
    vi.useFakeTimers();
    const onMove = vi.fn();
    const onPlant = vi.fn();
    const onPlanterActionChange = vi.fn();
    const view = render(<GreenhouseScene
      state={state()}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(500, 700)}
      disabled={false}
      movementDisabled={false}
      onMove={onMove}
      onPlant={onPlant}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={onPlanterActionChange}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);

    fireEvent.click(view.getByRole("button", { name: /Farm Plot \d+/ }));
    fireEvent.click(view.getByRole("button", { name: "Plant" }));
    expect(onMove).toHaveBeenCalledOnce();
    expect(onPlant).not.toHaveBeenCalled();
    expect(screen.queryByText("Walking to the planter…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Plant" })).toBeNull();

    view.rerender(<GreenhouseScene
      state={state()}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(anchor.x, anchor.y)}
      disabled={false}
      movementDisabled={false}
      onMove={onMove}
      onPlant={onPlant}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={onPlanterActionChange}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);
    expect(onPlant).not.toHaveBeenCalled();
    expect(screen.queryByText(/Planting/u)).toBeNull();
    expect(onPlanterActionChange).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Planting", durationMs: 2_000 }));
    act(() => { vi.advanceTimersByTime(1_999); });
    expect(onPlant).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onPlant).toHaveBeenCalledWith(anchor.anchorId, "wheat");
  });

  it("recognizes a carried Giving Berry with the canonical default inventory variant", () => {
    const givingState = state(1) as any;
    givingState.inventory.items = [{ entryId: "berry-1", resourceType: "giving_berry", variant: "default", quantity: 1 }];
    givingState.inventory.totals.giving_berry = 1;
    givingState.cropCatalog.crops.push({
      cropId: "giving_berry_tree",
      displayName: "Giving Berry Tree",
      seedDisplayName: "Giving Berry",
      seed: { itemId: "giving_berry", variant: null },
      maxStage: 4,
      harvestQuantity: 4,
      clippingStages: [3],
      plantingAvailable: true,
      stageArtIds: ["giving_berry_tree_seedling", "giving_berry_tree_middle_2", "giving_berry_tree_fruiting", "giving_berry_tree_mature"]
    });
    const view = render(<GreenhouseScene
      state={givingState}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(anchor.x, anchor.y)}
      disabled={false}
      movementDisabled={false}
      onMove={vi.fn()}
      onPlant={vi.fn()}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={vi.fn()}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);
    fireEvent.click(view.getByRole("button", { name: /Farm Plot \d+/ }));
    expect(view.getByRole("button", { name: "Plant and Water Giving Berry Tree" })).not.toHaveProperty("disabled", true);
  });

  it("clears the mature tree and chop action after tapping resin", () => {
    vi.useFakeTimers();
    const onTapTree = vi.fn();
    const onHarvest = vi.fn();
    const legacyState = state() as any;
    legacyState.inventory.items = [];
    legacyState.inventory.totals = {};
    legacyState.cropCatalog.crops.push({
      cropId: "giving_berry_tree",
      displayName: "Giving Berry Tree",
      seedDisplayName: "Giving Berry",
      seed: { itemId: "giving_berry", variant: null },
      maxStage: 4,
      harvestQuantity: 4,
      clippingStages: [3],
      plantingAvailable: true,
      stageArtIds: ["giving_berry_tree_seedling", "giving_berry_tree_middle_2", "giving_berry_tree_fruiting", "giving_berry_tree_mature"]
    });
    legacyState.greenhouse.anchors[0].plant = {
      anchorId: anchor.anchorId,
      cropId: "giving_berry_tree",
      stage: 4,
      artId: "giving_berry_tree_mature",
      plantedAt: new Date(0).toISOString(),
      wateredAt: null,
      nextStageAt: null,
      dry: true,
      berriesRemaining: 3,
      resinHarvested: false
    };
    const scene = () => <GreenhouseScene
      state={legacyState}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(anchor.x, anchor.y)}
      disabled={false}
      movementDisabled={false}
      onMove={vi.fn()}
      onPlant={vi.fn()}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={onHarvest}
      onTapTree={onTapTree}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={vi.fn()}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />;
    const view = render(scene());
    fireEvent.click(screen.getByRole("button", { name: /Farm Plot \d+/ }));
    expect(screen.queryByRole("button", { name: "Gather 3 Giving Berries" })).toBeNull();
    expect(screen.getByRole("button", { name: "Tap Resin" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chop Tree · 4 Wood" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tap Resin" }));
    act(() => { vi.runAllTimers(); });
    expect(onTapTree).toHaveBeenCalledExactlyOnceWith(anchor.anchorId);
    expect(onHarvest).not.toHaveBeenCalled();
    legacyState.greenhouse.anchors[0].plant = null;
    view.rerender(scene());
    expect(view.container.querySelector(".greenhouse-crop-art")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Farm Plot \d+/ }));
    expect(screen.queryByRole("button", { name: "Tap Resin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Chop Tree · 4 Wood" })).toBeNull();
    expect(onHarvest).not.toHaveBeenCalled();
  });

  it("closes the Plant and Water prompt while the character approaches", () => {
    const onMove = vi.fn();
    const onPlantAndWater = vi.fn();
    const view = render(<GreenhouseScene
      state={state(1)}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(500, 700)}
      disabled={false}
      movementDisabled={false}
      onMove={onMove}
      onPlant={vi.fn()}
      onPlantAndWater={onPlantAndWater}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={vi.fn()}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);

    fireEvent.click(view.getByRole("button", { name: /Farm Plot \d+/ }));
    fireEvent.click(view.getByRole("button", { name: "Plant and Water" }));

    expect(onMove).toHaveBeenCalledOnce();
    expect(onPlantAndWater).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Plant and Water" })).toBeNull();
    expect(screen.queryByText("Walking to the planter…")).toBeNull();
  });

  it("cancels a timed planter action when authoritative movement begins", () => {
    vi.useFakeTimers();
    const onPlant = vi.fn();
    const onPlanterActionChange = vi.fn();
    const view = render(<GreenhouseScene
      state={state()}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(anchor.x, anchor.y)}
      disabled={false}
      movementDisabled={false}
      onMove={vi.fn()}
      onPlant={onPlant}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={onPlanterActionChange}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);

    fireEvent.click(view.getByRole("button", { name: /Farm Plot \d+/ }));
    fireEvent.click(view.getByRole("button", { name: "Plant" }));
    view.rerender(<GreenhouseScene
      state={state()}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(anchor.x, anchor.y, true)}
      disabled={false}
      movementDisabled={false}
      onMove={vi.fn()}
      onPlant={onPlant}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={onPlanterActionChange}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(onPlant).not.toHaveBeenCalled();
  });

  it("keeps the tank prompt focused on its amount and available actions", () => {
    const view = render(<GreenhouseScene
      state={state(0, 40)}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(500, 700)}
      disabled={false}
      movementDisabled={false}
      onMove={vi.fn()}
      onPlant={vi.fn()}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={vi.fn()}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);

    fireEvent.click(view.getByRole("button", { name: "Water storage tank" }));

    expect(screen.getByRole("heading", { name: "Water Storage Tank · 4/20 gal" })).toBeTruthy();
    expect(screen.getByText("Move closer to use.")).toBeTruthy();
    expect(screen.queryByText(/Water storage art and interaction hotspot/)).toBeNull();
  });

  it("renders an authored stage frame separately from the Farm Plot touch button", () => {
    const snapshot = state() as { greenhouse: { anchors: Array<{ plant: unknown }> } };
    snapshot.greenhouse.anchors[0]!.plant = {
      anchorId: anchor.anchorId,
      cropId: "wheat",
      stage: 2,
      artId: "wheat_middle_2",
      plantedAt: new Date(0).toISOString(),
      wateredAt: new Date(0).toISOString(),
      nextStageAt: new Date(Date.now() + 10_000).toISOString(),
      dry: false
    };
    const view = render(<GreenhouseScene
      state={snapshot as never}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(anchor.x, anchor.y)}
      disabled={false}
      movementDisabled={false}
      onMove={vi.fn()}
      onPlant={vi.fn()}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={vi.fn()}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);
    const cropArt = view.container.querySelector<HTMLImageElement>(".greenhouse-crop-art")!;
    const stageArt = { pivotX: 0.5, pivotY: 0.5, offsetX: 0, offsetY: 0, scale: 0.68 };
    const frame = greenhousePlantStageArtFrame(GREENHOUSE_STUDIO_CATALOG, stageArt, anchor.x, anchor.y);
    expect(cropArt.closest("button")).toBeNull();
    expect(cropArt.getAttribute("src")).toBe("/crop-art/wheat/2.png");
    expect(cropArt.style.width).toBe(`${frame.width / GREENHOUSE_ROOM_WIDTH * 100}%`);
    expect(cropArt.style.height).toBe(`${frame.height / GREENHOUSE_ROOM_HEIGHT * 100}%`);
  });

  it("renders planted Giving Berry art from its authored tree slot", () => {
    const snapshot = state() as { greenhouse: { anchors: Array<{ plant: unknown }> } };
    snapshot.greenhouse.anchors[0]!.plant = {
      anchorId: anchor.anchorId,
      cropId: "giving_berry_tree",
      stage: 1,
      artId: "giving_berry_tree_seedling",
      plantedAt: new Date(0).toISOString(),
      wateredAt: null,
      nextStageAt: null,
      dry: true
    };
    const view = render(<GreenhouseScene
      state={snapshot as never}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(anchor.x, anchor.y)}
      disabled={false}
      movementDisabled={false}
      onMove={vi.fn()}
      onPlant={vi.fn()}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={vi.fn()}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);

    expect(view.container.querySelector<HTMLImageElement>(".greenhouse-crop-art")?.getAttribute("src"))
      .toBe("/runtime/apps/client/src/assets/plants/giving-berry-tree-seedling.png");
  });

  it("keeps an unknown crop unavailable instead of drawing wheat art", () => {
    const snapshot = state() as {
      greenhouse: { anchors: Array<{ plant: unknown }> };
      cropCatalog: { crops: Array<unknown> };
    };
    snapshot.cropCatalog.crops.push({
      cropId: "moonbean",
      displayName: "Moonbean",
      seedDisplayName: "Moonbean Seed",
      seed: { itemId: "seed", variant: "moonbean" },
      maxStage: 4,
      harvestQuantity: 3,
      clippingStages: [2],
      plantingAvailable: true,
      stageArtIds: ["moonbean_seedling", "moonbean_middle_2", "moonbean_middle_3", "moonbean_full"]
    });
    snapshot.greenhouse.anchors[0]!.plant = {
      anchorId: anchor.anchorId,
      cropId: "moonbean",
      stage: 1,
      artId: "moonbean_seedling",
      plantedAt: new Date(0).toISOString(),
      wateredAt: null,
      nextStageAt: null,
      dry: true
    };
    const view = render(<GreenhouseScene
      state={snapshot as never}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(anchor.x, anchor.y)}
      disabled={false}
      movementDisabled={false}
      onMove={vi.fn()}
      onPlant={vi.fn()}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={vi.fn()}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);

    expect(view.container.querySelector(".greenhouse-crop-art")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: /Moonbean stage 1/ }));
    expect(screen.getByText(/Crop artwork unavailable/u)).toBeTruthy();
  });

  it("renders stage-level authored art without live footprint debug guides", () => {
    const snapshot = state();
    const view = render(<GreenhouseScene
      state={snapshot}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(anchor.x, anchor.y)}
      disabled={false}
      movementDisabled={false}
      onMove={vi.fn()}
      onPlant={vi.fn()}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={vi.fn()}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);
    const footprintSvg = screen.getByTestId("greenhouse-physical-footprints");
    expect(footprintSvg.querySelector(".greenhouse-placement-footprint")).toBeNull();
    expect(footprintSvg.querySelector(".greenhouse-physical-footprint")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Farm Plot \d+/ }));
    expect(view.container.querySelector(".greenhouse-anchor.selected")).toBeNull();

    const potArt = view.container.querySelector<HTMLImageElement>(".greenhouse-pot-art")!;
    const potImage = greenhouseTemplateImageFrame(GREENHOUSE_STUDIO_CATALOG, "pot", anchor.x, anchor.y);
    expect(potArt.closest("button")).toBeNull();
    expect(potArt.style.objectFit).toBe("fill");
    expect(potArt.style.width).toBe(`${potImage.width / GREENHOUSE_ROOM_WIDTH * 100}%`);
    expect(potArt.style.height).toBe(`${potImage.height / GREENHOUSE_ROOM_HEIGHT * 100}%`);
    const tankArt = view.container.querySelector<HTMLImageElement>(".greenhouse-tank-art")!;
    expect(tankArt.closest("button")).toBeNull();
    expect(tankArt.style.objectFit).toBe("fill");

    const stage = view.container.querySelector<HTMLDivElement>(".greenhouse-room")!;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0,
      toJSON: () => ({})
    } as DOMRect);
    fireEvent.click(screen.getByRole("button", { name: /Place Farm Plot/ }), { bubbles: true });
    fireEvent.click(stage, { clientX: 500, clientY: 500, bubbles: true });
    expect(screen.getByRole("group", { name: "Farm Plot materials" })).toBeTruthy();
    expect(screen.getByLabelText(/^Wood 100/u)).toBeTruthy();
    expect(screen.getByLabelText(/^Fertilizer 50/u)).toBeTruthy();
    const preview = screen.getByTestId("greenhouse-physical-footprints").querySelector<SVGPolygonElement>(".greenhouse-placement-footprint")!;
    expect(preview.getAttribute("points")).toBe(greenhouseTemplateFootprint(GREENHOUSE_STUDIO_CATALOG, "pot", GREENHOUSE_ROOM_WIDTH * 0.5, GREENHOUSE_ROOM_HEIGHT * 0.5).map((point) => `${point.x},${point.y}`).join(" "));
    expect(view.container.querySelector<HTMLImageElement>(".greenhouse-placement-preview-art")?.style.objectFit).toBe("fill");
  });

  it("zooms the shared indoor stage through wheel and mobile controls", () => {
    const view = render(<GreenhouseScene
      state={state()}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(anchor.x, anchor.y)}
      disabled={false}
      movementDisabled={false}
      onMove={vi.fn()}
      onPlant={vi.fn()}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={vi.fn()}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);
    const stage = view.container.querySelector<HTMLElement>(".indoor-scene-stage")!;
    expect(stage.dataset.indoorScale).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in greenhouse" }));
    expect(stage.dataset.indoorScale).toBe("1.1");
    const shell = view.container.querySelector<HTMLElement>(".greenhouse-stage-shell")!;
    fireEvent.wheel(shell, { deltaY: -100 });
    expect(Number(stage.dataset.indoorScale)).toBeGreaterThan(1.1);
    fireEvent.click(screen.getByRole("button", { name: "Reset greenhouse view" }));
    expect(stage.dataset.indoorScale).toBe("1");
  });

  it("keeps canonical double-click movement available after camera gesture wiring", () => {
    const onMove = vi.fn();
    const view = render(<GreenhouseScene
      state={state()}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(anchor.x, anchor.y)}
      disabled={false}
      movementDisabled={false}
      onMove={onMove}
      onPlant={vi.fn()}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={vi.fn()}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
    />);
    const stage = view.container.querySelector<HTMLElement>(".indoor-scene-stage")!;
    Object.defineProperty(stage, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 1_000, height: 1_000, right: 1_000, bottom: 1_000, x: 0, y: 0, toJSON: () => ({}) })
    });
    fireEvent.doubleClick(view.container.querySelector<HTMLElement>(".greenhouse-stage-shell")!, {
      clientX: 420,
      clientY: 360,
      button: 0
    });
    expect(onMove).toHaveBeenCalledOnce();
  });
});

describe("GreenhouseScene on the map renderer", () => {
  afterEach(() => { cleanup(); });

  it("opens the Farm Plot prompt from a map tap on a placed plot and keeps only the HUD in the DOM", () => {
    const mapPickRef: { current: ((local: { x: number; y: number }) => boolean) | null } = { current: null };
    const view = render(<GreenhouseScene
      state={state()}
      timeline={new GreenhouseMovementTimeline()}
      displayColor="#fff"
      position={position(200, 1100)}
      disabled={false}
      movementDisabled={false}
      onMove={vi.fn()}
      onPlant={vi.fn()}
      onPlantAndWater={vi.fn()}
      onWater={vi.fn()}
      onClip={vi.fn()}
      onHarvest={vi.fn()}
      onDepositWater={vi.fn()}
      onRefillGardeningBucket={vi.fn()}
      onPlanterActionChange={vi.fn()}
      synchronizedNow={() => Date.now()}
      onExit={vi.fn()}
      mapRendered
      mapPickRef={mapPickRef as never}
    />);
    expect(view.container.querySelector(".greenhouse-map-hud")).not.toBeNull();
    expect(view.container.querySelector(".greenhouse-stage-shell")).toBeNull();
    expect(screen.getByRole("toolbar", { name: "Greenhouse placement tools" })).toBeTruthy();
    expect(mapPickRef.current).toBeTypeOf("function");
    let handled = false;
    act(() => { handled = mapPickRef.current!({ x: anchor.x, y: anchor.y }); });
    expect(handled).toBe(true);
    expect(screen.getAllByText(/Farm Plot \d+/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Plant" })).toBeTruthy();
  });
});
