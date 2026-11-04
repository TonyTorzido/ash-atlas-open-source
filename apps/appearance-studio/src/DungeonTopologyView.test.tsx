// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DUNGEON_CATALOG, type DungeonDefinition } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DungeonTopology, type DungeonTopologyProps } from "./DungeonTopologyView.js";

afterEach(() => { cleanup(); localStorage.clear(); });
const dungeon = (): DungeonDefinition => structuredClone(DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!);
function defaultProps(value = dungeon()): DungeonTopologyProps {
  return { dungeon: value, prefabs: DUNGEON_CATALOG.prefabs, selectedRoomId: value.entrance.roomId,
    onSelectRoom: vi.fn(), onSelectAnchor: vi.fn(), onChangeDungeon: vi.fn() };
}

describe("DungeonTopology editor interactions", () => {
  it("synchronizes graph selections in both directions without editing dungeon data", () => {
    const props = defaultProps(); const view = render(<DungeonTopology {...props} />);
    const initial = screen.getByRole("button", { name: "Select Hatch Landing" });
    expect(initial.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Select Overflow Channel" }));
    expect(props.onSelectRoom).toHaveBeenCalledWith("overflow_channel");
    view.rerender(<DungeonTopology {...props} selectedRoomId="overflow_channel" />);
    expect(screen.getByRole("button", { name: "Select Overflow Channel" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Select Hatch Landing" }).getAttribute("aria-pressed")).toBe("false");
    const node = screen.getByRole("article", { name: "Overflow Channel topology node" });
    fireEvent.click(within(node).getAllByRole("button").find((button) => button.classList.contains("dungeon-topology-port"))!);
    expect(props.onSelectAnchor).toHaveBeenCalledWith("overflow_channel", expect.any(String));
    expect(props.onChangeDungeon).not.toHaveBeenCalled();
  });

  it("inspects real source, threshold and arrival anchors from a selected edge", () => {
    const props = defaultProps(); render(<DungeonTopology {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Go East: Hatch Landing to Overflow Channel" }));
    const inspector = screen.getByRole("region", { name: "Selected connection" });
    expect(inspector.textContent).toContain("Approach"); expect(inspector.textContent).toContain("Threshold"); expect(inspector.textContent).toContain("Arrival");
    expect(inspector.textContent).toContain("Overflow Channel");
    expect(props.onSelectAnchor).toHaveBeenCalledWith("hatch_landing", "door_e");
    const arrival = props.dungeon.rooms.find((room) => room.id === "overflow_channel")!.anchors.find((anchor) => anchor.id === "arrive_w")!;
    const arrivalButton = within(inspector).getAllByRole("button").find((button) => button.textContent?.includes(`${Math.round(arrival.x)}, ${Math.round(arrival.y)}`));
    fireEvent.click(arrivalButton!);
    expect(props.onSelectAnchor).toHaveBeenCalledWith("overflow_channel", "arrive_w");
  });

  it("navigates validation errors to the affected authored anchor", () => {
    const value = dungeon(); value.rooms[0]!.anchors.push({ id: "outside", retired: false, x: -40, y: 30 });
    const props = defaultProps(value); render(<DungeonTopology {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /error An anchor in Hatch Landing is outside/u }));
    expect(props.onSelectRoom).toHaveBeenCalledWith("hatch_landing");
    expect(props.onSelectAnchor).toHaveBeenCalledWith("hatch_landing", "outside");
  });

  it("moves graph nodes and zooms independently of authored camera and coordinates", () => {
    const props = defaultProps(); render(<DungeonTopology {...props} />);
    const node = screen.getByRole("article", { name: "Hatch Landing topology node" });
    const before = Number.parseFloat(node.style.left);
    fireEvent.keyDown(screen.getByRole("button", { name: "Select Hatch Landing" }), { key: "ArrowRight" });
    expect(Number.parseFloat(node.style.left)).toBe(before + 20);
    const zoom = screen.getByLabelText("Topology zoom").textContent;
    fireEvent.click(screen.getByRole("button", { name: "Zoom in topology" }));
    expect(screen.getByLabelText("Topology zoom").textContent).not.toBe(zoom);
    fireEvent.click(screen.getByRole("button", { name: "Auto-layout" }));
    expect(Number.parseFloat(node.style.left)).toBe(before);
    expect(props.onChangeDungeon).not.toHaveBeenCalled();
  });

  it("renders directed edge endpoints using the same 44px geometry supplied to port CSS", () => {
    render(<DungeonTopology {...defaultProps()} />);
    const topology = screen.getByRole("region", { name: "Dungeon topology" });
    expect(topology.style.getPropertyValue("--topology-port-height")).toBe("44px");
    expect(topology.style.getPropertyValue("--topology-node-meta-height")).toBe("44px");
    expect(topology.style.getPropertyValue("--topology-more-height")).toBe("44px");
    const edge = screen.getByRole("button", { name: "Go East: Hatch Landing to Overflow Channel" });
    const path = edge.querySelector(".dungeon-topology-edge-line")!.getAttribute("d")!;
    expect(path.startsWith("M 440 400 ")).toBe(true);
    expect(path.endsWith("570 268")).toBe(true);
  });

  it("creates a usable room connection through named room and anchor choices", () => {
    let finalDungeon = dungeon(); const changed = vi.fn();
    const room = finalDungeon.rooms[0]!;
    function Harness() {
      const [value, setValue] = useState(finalDungeon); const [selected, setSelected] = useState({ roomId: room.id, anchorId: room.spawnAnchorId });
      return <DungeonTopology dungeon={value} prefabs={DUNGEON_CATALOG.prefabs} selectedRoomId={selected.roomId} selectedAnchorId={selected.anchorId}
        onSelectRoom={(roomId) => setSelected({ roomId, anchorId: "" })} onSelectAnchor={(roomId, anchorId) => setSelected({ roomId, anchorId })}
        onChangeDungeon={(edit) => { const next = structuredClone(value); edit(next); finalDungeon = next; changed(); setValue(next); }} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Connect from this anchor" }));
    fireEvent.change(screen.getByLabelText("To room"), { target: { value: "warden_junction" } });
    expect(screen.getByLabelText("To anchor").textContent).not.toContain("arrive_w");
    fireEvent.click(screen.getByRole("button", { name: "Create connection" }));
    expect(changed).toHaveBeenCalledTimes(1);
    const connection = finalDungeon.portals.find((portal) => portal.source.kind === "room" && portal.source.roomId === room.id && portal.source.anchorId === room.spawnAnchorId && portal.destination.kind === "room" && portal.destination.roomId === "warden_junction")!;
    expect(connection).toBeTruthy(); expect(connection.reciprocalPortalId).toBeTruthy();
    expect(finalDungeon.rooms[0]!.objects.some((object) => object.type === "portal" && object.portalId === connection.id)).toBe(true);
    expect(screen.getByRole("status", { name: "Topology action result" }).textContent).toContain("Connection created");
  });

  it("keeps link creation disabled when editor writes are unavailable", () => {
    const props = defaultProps(); render(<DungeonTopology {...props} disabled selectedAnchorId={props.dungeon.rooms[0]!.spawnAnchorId} />);
    expect(screen.getByRole("button", { name: "Connect from this anchor" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Connect from this anchor" }));
    expect(props.onChangeDungeon).not.toHaveBeenCalled();
  });
});
