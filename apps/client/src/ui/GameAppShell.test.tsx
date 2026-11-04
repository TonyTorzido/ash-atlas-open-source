// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GameAppBackButton,
  GameAppButton,
  GameAppCloseButton,
  GameAppShell,
  GameAppDivider,
  GameAppEmptyState,
  GameAppIconButton,
  GameAppScrollRegion,
  GameAppSectionHeader,
  GameAppState,
  GameAppTabs,
  GameAppText
} from "./GameAppShell.js";

afterEach(cleanup);

describe("GameAppTabs", () => {
  it("renders the canonical equal-width housed presentation without changing tab semantics", () => {
    const onChange = vi.fn();
    const { container } = render(<GameAppTabs
      variant="housed"
      ariaLabel="Example sections"
      activeTab="one"
      onChange={onChange}
      tabs={[{ id: "one", label: "One" }, { id: "two", label: "Two" }, { id: "three", label: "Three" }]}
    />);

    const rail = screen.getByRole("tablist", { name: "Example sections" });
    expect(rail.classList.contains("game-app-tabs-housed")).toBe(true);
    expect(rail.style.getPropertyValue("--game-app-tab-columns")).toBe("3");
    expect(screen.getByRole("tab", { name: "One" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "One" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("two");
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
  });

  it("opts long housed sets into scrolling while preserving selection and keyboard behavior", () => {
    const onChange = vi.fn();
    render(<GameAppTabs
      variant="housed"
      scrollable
      ariaLabel="Long sections"
      activeTab="two"
      onChange={onChange}
      tabs={[{ id: "one", label: "One" }, { id: "two", label: "Two" }, { id: "three", label: "Three" }]}
    />);

    const rail = screen.getByRole("tablist", { name: "Long sections" });
    expect(rail.classList.contains("game-app-tabs-housed-scrollable")).toBe(true);
    expect(screen.getByRole("tab", { name: "Two" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Two" }), { key: "End" });
    expect(onChange).toHaveBeenCalledWith("three");
  });

  it("does not make the default housed rail scrollable", () => {
    render(<GameAppTabs
      variant="housed"
      activeTab="one"
      onChange={vi.fn()}
      tabs={[{ id: "one", label: "One" }, { id: "two", label: "Two" }]}
    />);

    expect(screen.getByRole("tablist").classList.contains("game-app-tabs-housed-scrollable")).toBe(false);
  });

  it("renders compact second-level subtabs with the same semantics and roving keyboard behavior", () => {
    const onChange = vi.fn();
    render(<GameAppTabs
      variant="subtabs"
      scrollable
      ariaLabel="Example categories"
      activeTab="resources"
      onChange={onChange}
      tabs={[
        { id: "all", label: "All" },
        { id: "consumables", label: "Consumables" },
        { id: "resources", label: "Resources" },
        { id: "equipment", label: "Equipment" }
      ]}
    />);

    const rail = screen.getByRole("tablist", { name: "Example categories" });
    expect(rail.classList.contains("game-app-tabs-subtabs")).toBe(true);
    expect(rail.classList.contains("game-app-tabs-subtabs-scrollable")).toBe(true);
    expect(screen.getByRole("tab", { name: "Resources" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Resources" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("equipment");
  });

  it("provides one canonical contract for headings, controls, states, dividers, and scrolling", () => {
    render(<>
      <GameAppSectionHeader
        title="Inventory records"
        titleId="inventory-records-title"
        eyebrow="Items"
        description="Helper copy"
        meta="3 records"
        action={<GameAppIconButton label="Refresh records" onClick={vi.fn()}>↻</GameAppIconButton>}
      />
      <GameAppText tone="body">Body copy</GameAppText>
      <GameAppText tone="helper" as="small">Helper copy</GameAppText>
      <GameAppButton>Standard</GameAppButton>
      <GameAppButton variant="destructive">Destructive</GameAppButton>
      <GameAppDivider />
      <GameAppScrollRegion ariaLabel="Records">Scrollable records</GameAppScrollRegion>
      <GameAppState variant="disabled" title="Unavailable">Reconnect.</GameAppState>
      <GameAppEmptyState>No records.</GameAppEmptyState>
      <GameAppCloseButton label="Close example" />
      <GameAppBackButton label="Back to Inventory" />
    </>);

    expect(screen.getByRole("heading", { name: "Inventory records" }).closest(".game-app-section-header")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh records" }).classList.contains("game-app-icon-button")).toBe(true);
    expect(screen.getByRole("button", { name: "Standard" }).classList.contains("game-app-button-standard")).toBe(true);
    expect(screen.getByRole("button", { name: "Standard" }).getAttribute("type")).toBe("button");
    expect(screen.getByRole("button", { name: "Destructive" }).classList.contains("game-app-button-destructive")).toBe(true);
    expect(screen.getByRole("separator").classList.contains("game-app-divider")).toBe(true);
    expect(screen.getByLabelText("Records").classList.contains("game-app-scroll-region")).toBe(true);
    const statusRegions = screen.getAllByRole("status");
    expect(statusRegions.some((region) => region.textContent?.includes("Unavailable"))).toBe(true);
    expect(statusRegions.some((region) => region.textContent?.includes("No records."))).toBe(true);
    expect(screen.getByRole("button", { name: "Close example" }).classList.contains("game-app-close-button")).toBe(true);
    expect(screen.getByRole("button", { name: "Back to Inventory" }).classList.contains("game-app-back-button")).toBe(true);
  });

  it("does not forward the close click event to the shell callback", () => {
    const onClose = vi.fn();
    render(
      <GameAppShell open title="Inventory" closeLabel="Close Inventory" onClose={onClose}>
        <p>Items</p>
      </GameAppShell>
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Inventory" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith();
  });

  it("keeps narrow app tabs scrollable while retaining touch-safe canonical cells", () => {
    render(<GameAppTabs
      variant="subtabs"
      scrollable
      ariaLabel="Narrow categories"
      activeTab="long"
      onChange={vi.fn()}
      tabs={[{ id: "short", label: "Short" }, { id: "long", label: "Long category label" }]}
    />);

    const rail = screen.getByRole("tablist", { name: "Narrow categories" });
    expect(rail.classList.contains("game-app-tabs-subtabs-scrollable")).toBe(true);
    expect(rail.querySelectorAll("button")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Long category label" }).getAttribute("aria-selected")).toBe("true");
  });
});
