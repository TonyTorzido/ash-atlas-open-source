// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CitySnapshot } from "@ash-atlas/shared";

import { CityPanel } from "./CityPanel.js";

const city: CitySnapshot = {
  id: "00000000-0000-4000-8000-0000000000c1",
  worldId: "main",
  worldSettlementId: "settlement-1",
  worldSettlementSource: "global-boundaries",
  worldSourceSettlementId: "source-1",
  settlementClass: "city",
  settlementReleaseId: "world-settlements-v1",
  settlementReleaseFingerprint: "f".repeat(64),
  name: "Albuquerque",
  countryCode: "US",
  regionCode: "US-NM",
  founderPlayerId: "player-1",
  founderUsername: "Ash",
  mayorPlayerId: "player-1",
  mayorUsername: "Ash",
  mayorConfirmed: true,
  founderMayorClaimDeadline: null,
  seatFlagId: "00000000-0000-4000-8000-000000000001",
  lat: 35.0844,
  lon: -106.6504,
  active: true,
  jumpable: true,
  constructionPhase: "complete",
  constructionCompletedAt: "2026-07-10T00:00:00.000Z",
  constructionContributions: [],
  spatialRevision: "1",
  foundingAnnexRadiusM: 750,
  createdAt: "2026-07-10T00:00:00.000Z"
};

const constructionProps = {
  ownPlayerId: "player-1",
  online: true,
  busy: false,
  error: null,
  onAdvanceConstruction: vi.fn()
};

afterEach(cleanup);

describe("CityPanel", () => {
  it("presents NPC Goblin cities without player membership or leadership semantics", () => {
    const visit = vi.fn();
    render(<CityPanel
      {...constructionProps}
      city={{
        ...city,
        controllerKind: "npc",
        culture: "goblin",
        bannerColor: "#174f2a",
        constructionPhase: "complete"
      }}
      info={null}
      membership={null}
      anchorHouse={null}
      onVisitCity={visit}
      onVisitHouse={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(screen.getByText("GOBLIN CITY")).toBeTruthy();
    expect(screen.getByText("Neutral goblin trading settlement")).toBeTruthy();
    expect(screen.queryByText(/Build a City House/)).toBeNull();
    screen.getByRole("button", { name: "Info" }).click();
    expect(screen.queryByText("Founder")).toBeNull();
    expect(screen.queryByText("Mayor")).toBeNull();
    screen.getByRole("button", { name: "Travel to Goblin City" }).click();
    expect(visit).toHaveBeenCalledWith(city.id);
  });
  it("directs nonmembers to the Build menu without offering construction", () => {
    render(
      <CityPanel {...constructionProps}
        city={city}
        info={{
          city,
          memberCount: 2,
          expansionFlagCount: 0,
          expansionFlagLimit: 11,
          membership: null,
          joinAllowed: false,
          joinReason: "Build a City House on this city’s land to become a member.",
          mayorClaimAllowed: false,
          mayorClaimReason: "Ash is the current Mayor"
        }}
        membership={null}
        anchorHouse={null}
        onVisitCity={vi.fn()}
        onVisitHouse={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Join City" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Leave City" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Build City House" })).toBeNull();
    expect(screen.getByText(/Open the Build menu to place it where you are standing/))
      .toBeTruthy();
  });

  it("keeps mayor controls out of City Hall and City House interactions", () => {
    const { rerender } = render(
      <CityPanel {...constructionProps}
        city={city}
        info={null}
        membership={{
          cityId: city.id,
          cityName: city.name,
          role: "mayor",
          joinedAt: city.createdAt,
          expansionFlagCount: 0,
          expansionFlagLimit: 6,
          houseStructureId: "house-1"
        }}
        anchorHouse={null}
        onVisitCity={vi.fn()}
        onVisitHouse={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Relinquish Mayor" })).toBeNull();

    const vacant = {
      ...city,
      mayorPlayerId: null,
      mayorUsername: "Vacant",
      mayorConfirmed: false
    };
    rerender(
      <CityPanel {...constructionProps}
        city={vacant}
        info={{
          city: vacant,
          memberCount: 2,
          expansionFlagCount: 0,
          expansionFlagLimit: 11,
          membership: null,
          joinAllowed: false,
          joinReason: null,
          mayorClaimAllowed: true,
          mayorClaimReason: null
        }}
        membership={{
          cityId: city.id,
          cityName: city.name,
          role: "member",
          joinedAt: city.createdAt,
          expansionFlagCount: 0,
          expansionFlagLimit: 11,
          houseStructureId: "house-1"
        }}
        anchorHouse={null}
        onVisitCity={vi.fn()}
        onVisitHouse={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Become Mayor" })).toBeNull();
  });

  it("renders nothing without a selected city", () => {
    expect(renderToStaticMarkup(
      <CityPanel {...constructionProps}
        city={null}
        info={null}
        membership={null}
        anchorHouse={null}
        onVisitCity={vi.fn()}
        onVisitHouse={vi.fn()}
        onClose={vi.fn()}
      />
    )).toBe("");
  });

  it("orders Town Hall, Info, and Cancel while closing before travel", () => {
    const visitCity = vi.fn();
    const close = vi.fn();
    render(
      <CityPanel {...constructionProps}
        city={city}
        info={null}
        membership={null}
        anchorHouse={null}
        onVisitCity={visitCity}
        onVisitHouse={vi.fn()}
        onClose={close}
      />
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Travel to Town Hall",
      "Info",
      "Cancel"
    ]);
    screen.getByRole("button", { name: "Travel to Town Hall" }).click();

    expect(close).toHaveBeenCalledOnce();
    expect(visitCity).toHaveBeenCalledWith(city.id);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(
      visitCity.mock.invocationCallOrder[0]!
    );
  });

  it("jumps to a selected City House as its own non-flag anchor", () => {
    const visitHouse = vi.fn();
    render(
      <CityPanel {...constructionProps}
        city={city}
        info={null}
        membership={null}
        anchorHouse={{
          structureId: "00000000-0000-4000-8000-000000000002",
          cityId: city.id,
          type: "city_house",
          tier: 1,
          districtType: null,
          ownerPlayerId: "player-2",
          worldId: "main",
          regionCode: "US-NM",
          lat: 35.085,
          lon: -106.65,
          footprintRadiusM: 10,
          placementRevision: "1",
          state: "active",
          constructionStartedAt: city.createdAt,
          constructionCompletesAt: city.createdAt,
          builtAt: city.createdAt,
          upgradedAt: null,
          destroyedAt: null
        }}
        onVisitCity={vi.fn()}
        onVisitHouse={visitHouse}
        onClose={vi.fn()}
      />
    );

    screen.getByRole("button", { name: "Travel to City House" }).click();
    expect(visitHouse).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002");
    expect(screen.queryByRole("button", { name: "Travel to City Center" })).toBeNull();
  });

  it("shows exactly the current construction action and blocks repeat contributors", () => {
    const advance = vi.fn();
    const { rerender } = render(
      <CityPanel
        {...constructionProps}
        city={{
          ...city,
          constructionPhase: "blueprint",
          constructionContributions: [{
            stage: "blueprint",
            playerId: "player-2",
            contributedAt: city.createdAt
          }]
        }}
        info={null}
        membership={null}
        anchorHouse={null}
        onAdvanceConstruction={advance}
        onVisitCity={vi.fn()}
        onVisitHouse={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Blueprint")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Stone 120" })).toBeTruthy();
    screen.getByRole("button", { name: "Build Foundation" }).click();
    expect(advance).toHaveBeenCalledWith(city.id, "build_foundation");
    expect(screen.queryByRole("button", { name: "Build Frames" })).toBeNull();

    rerender(
      <CityPanel
        {...constructionProps}
        city={{
          ...city,
          constructionPhase: "foundation",
          constructionContributions: [{
            stage: "blueprint",
            playerId: "player-1",
            contributedAt: city.createdAt
          }]
        }}
        info={null}
        membership={null}
        anchorHouse={null}
        onAdvanceConstruction={advance}
        onVisitCity={vi.fn()}
        onVisitHouse={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Build Frames" })).toBeNull();
    expect(screen.queryByText("A different player must complete this stage.")).toBeNull();

    rerender(
      <CityPanel
        {...constructionProps}
        city={{ ...city, constructionPhase: "framing" }}
        info={null}
        membership={null}
        anchorHouse={null}
        onAdvanceConstruction={advance}
        onVisitCity={vi.fn()}
        onVisitHouse={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("Framing")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Gold 4,500" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finishing Touches" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Build Frames" })).toBeNull();
  });
});
