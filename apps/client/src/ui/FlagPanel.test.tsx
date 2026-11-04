// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FlagAccessSnapshot, FlagEnvironmentDetails, FlagEnvironmentDiagnostics, FlagSnapshot, KingdomStateSnapshot, MilitaryUnitGroupSnapshot, PlayerSnapshot } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeveloperDiagnosticsContent, DeveloperFlagDiagnostics } from "./DeveloperFlagDiagnostics.js";
import { FlagPanel } from "./FlagPanel.js";
import { PlayerDetailsContent, PlayerFlagDetails } from "./PlayerFlagDetails.js";
import { KingdomApiClient } from "../kingdom/kingdomClient.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FlagPanel", () => {
  it("shows compact health only while a Flag is damaged", () => {
    const view = render(<FlagPanel
      flag={{ ...flag(), health: 14, maximumHealth: 220, reinforcementLevel: 1, upgradeTier: "stone" }}
      player={player("owner-id")}
      access={accessSnapshot("owner-id")}
      accessTraceId="trace-health"
      onVisitFlag={vi.fn()}
      onDeleteFlag={vi.fn()}
      deleting={false}
      onClose={vi.fn()}
    />);
    expect(screen.getByText("14/220")).toBeTruthy();
    view.rerender(<FlagPanel
      flag={{ ...flag(), health: 220, maximumHealth: 220, reinforcementLevel: 1, upgradeTier: "stone" }}
      player={player("owner-id")}
      access={accessSnapshot("owner-id")}
      accessTraceId="trace-health"
      onVisitFlag={vi.fn()}
      onDeleteFlag={vi.fn()}
      deleting={false}
      onClose={vi.fn()}
    />);
    expect(screen.queryByText("200/200")).toBeNull();
  });

  it("keeps the compact panel human-readable and authorizes delete by player ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ access: accessSnapshot("owner-id") })));
    const view = renderPanel(player("owner-id"));
    expect(screen.getByRole("heading", { name: "Ash's Flag (Private)" })).toBeTruthy();
    expect(screen.queryByText("Flag 9")).toBeNull();
    expect(view.container.querySelector(".flag-panel-owner")).toBeNull();
    expect(await screen.findByRole("button", { name: "Travel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Destroy Flag" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Player Details" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Found Kingdom|Make Kingdom|Convert to Castle/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Developer Diagnostics" })).toBeNull();
    expect(view.container.textContent).not.toContain("53.3498");
    expect(view.container.textContent).not.toContain("world_v1_lat53_lon-7");
    expect(view.container.textContent).not.toContain("owner-id");
    expect(view.container.textContent).not.toContain("Celtic");

    view.rerender(panel(player("other-owner")));
    expect(screen.queryByRole("button", { name: "Destroy Flag" })).toBeNull();
  });

  it("keeps rename out of the contextual More prompt", () => {
    const shrine = { ...flag(), reinforcementLevel: 2, upgradeTier: "atlas_shrine" as const };
    render(<FlagPanel flag={shrine} player={player("owner-id")} access={accessSnapshot("owner-id")}
      accessTraceId="trace-1" onVisitFlag={vi.fn()} onRenameFlag={vi.fn()}
      onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows an owner-based Atlas Shrine heading with authoritative access", () => {
    const access = {
      ...accessSnapshot("owner-id"),
      mode: "public" as const,
      jumpTollGold: "8"
    };
    const view = render(<FlagPanel
      flag={{ ...flag(), reinforcementLevel: 2, upgradeTier: "atlas_shrine" }}
      player={player("owner-id")}
      access={access}
      accessTraceId="trace-shrine"
      onAccessChange={vi.fn()}
      onVisitFlag={vi.fn()}
      onDeleteFlag={vi.fn()}
      deleting={false}
      onClose={vi.fn()}
    />);

    expect(screen.getByRole("heading", { name: "Ash's Shrine (Public) · 8 Gold" })).toBeTruthy();
    expect(view.container.querySelector(".flag-panel-owner")).toBeNull();
  });

  it("orders the owner hardening action before More and routes it through realtime", () => {
    const onHarden = vi.fn(() => true);
    const view = render(
      <FlagPanel
        flag={{ ...flag(), reinforcementLevel: 0 }}
        player={player("owner-id")}
        serverHttpBase="https://game.example"
        csrfToken="csrf"
        access={accessSnapshot("owner-id")}
        accessTraceId="trace-1"
        onAccessChange={vi.fn()}
        onVisitFlag={vi.fn()}
        onDeleteFlag={vi.fn()}
        onHarden={onHarden}
        deleting={false}
        onClose={vi.fn()}
      />
    );
    const actionLabels = screen.getAllByRole("button").map((button) => button.textContent);
    expect(actionLabels.indexOf("Travel")).toBeLessThan(actionLabels.indexOf("Harden"));
    expect(actionLabels.indexOf("Harden")).toBeLessThan(actionLabels.indexOf("More"));

    const harden = screen.getByRole("button", { name: "Harden" });
    fireEvent.click(harden);
    expect(onHarden).toHaveBeenCalledOnce();
    expect(onHarden).toHaveBeenCalledWith(flag().id);
    view.rerender(<FlagPanel
      flag={{ ...flag(), reinforcementLevel: 1, upgradeTier: "stone" }}
      player={player("owner-id")}
      access={accessSnapshot("owner-id")}
      accessTraceId="trace-1"
      onAccessChange={vi.fn()}
      onVisitFlag={vi.fn()}
      onDeleteFlag={vi.fn()}
      onHarden={onHarden}
      deleting={false}
      onClose={vi.fn()}
    />);
    expect(screen.queryByRole("button", { name: "Harden" })).toBeNull();
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("button", { name: "Upgrade to Atlas Shrine" })).toBeNull();
  });

  it("keeps Tower upgrade out of contextual More", () => {
    const common = {
      player: player("owner-id"), access: accessSnapshot("owner-id"), accessTraceId: "trace-1",
      onAccessChange: vi.fn(), onVisitFlag: vi.fn(), onDeleteFlag: vi.fn(), deleting: false,
      onClose: vi.fn()
    };
    const view = render(<FlagPanel {...common} flag={{ ...flag(), reinforcementLevel: 0 }}
      upgradeApproachReachable={false} />);
    expect(screen.queryByRole("button", { name: "Harden" })).toBeNull();
    view.rerender(<FlagPanel {...common}
      flag={{ ...flag(), reinforcementLevel: 1, upgradeTier: "stone" }}
      upgradeApproachReachable={false} />);
    expect(screen.queryByRole("button", { name: "Upgrade to Tower · 25 Stone" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("button", { name: "Upgrade to Tower · 25 Stone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upgrade to Atlas Shrine" })).toBeNull();
  });

  it("orders owner Stone Flag repair between Visit and More and applies the returned snapshot", async () => {
    const repairedFlag = {
      ...flag(),
      reinforcementLevel: 1,
      upgradeTier: "stone" as const,
      burning: false
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/repair")
        ? jsonResponse({ flag: repairedFlag, replayed: false })
        : jsonResponse({ progression: atlasShrineProgression() })
    );
    vi.stubGlobal("fetch", fetchMock);
    const onFlagSnapshot = vi.fn();
    const burningStone = { ...repairedFlag, burning: true };
    const view = render(<FlagPanel
      flag={burningStone}
      player={player("owner-id")}
      serverHttpBase="https://game.example"
      csrfToken="csrf"
      access={accessSnapshot("owner-id")}
      accessTraceId="trace-1"
      onAccessChange={vi.fn()}
      onVisitFlag={vi.fn()}
      onDeleteFlag={vi.fn()}
      onFlagSnapshot={onFlagSnapshot}
      deleting={false}
      onClose={vi.fn()}
    />);

    const actionLabels = screen.getAllByRole("button").map((button) => button.textContent);
    const repairIndex = actionLabels.findIndex((label) => label === "Repair Flag");
    expect(actionLabels.indexOf("Travel")).toBeLessThan(repairIndex);
    expect(repairIndex).toBeLessThan(actionLabels.indexOf("More"));
    fireEvent.click(screen.getByRole("button", { name: /^Repair Flag$/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Repair Flag" }).at(-1)!);

    await waitFor(() => expect(onFlagSnapshot).toHaveBeenCalledWith(repairedFlag));
    expect(fetchMock).toHaveBeenCalledWith(
      `https://game.example/api/flags/${burningStone.id}/repair`,
      expect.objectContaining({ method: "POST", credentials: "include" })
    );

    view.rerender(<FlagPanel
      flag={{ ...burningStone, burning: false }} player={player("owner-id")}
      onVisitFlag={vi.fn()} onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()}
    />);
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
    view.rerender(<FlagPanel
      flag={burningStone} player={player("other-owner")}
      onVisitFlag={vi.fn()} onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()}
    />);
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
    view.rerender(<FlagPanel
      flag={{ ...burningStone }} player={player("owner-id")}
      onVisitFlag={vi.fn()} onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()}
    />);
    expect(screen.getByRole("button", { name: /^Repair Flag$/ })).toBeTruthy();
    view.rerender(<FlagPanel
      flag={{ ...burningStone, anchorKind: "buoy" }} player={player("owner-id")}
      onVisitFlag={vi.fn()} onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()}
    />);
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
  });

  it("hides hardening from non-owners, buoys, and Atlas Shrines", () => {
    const base = {
      player: player("owner-id"),
      onVisitFlag: vi.fn(),
      onDeleteFlag: vi.fn(),
      deleting: false,
      onClose: vi.fn()
    };
    const view = render(<FlagPanel {...base} flag={{ ...flag(), anchorKind: "buoy" }} />);
    expect(screen.queryByRole("button", { name: "Harden" })).toBeNull();
    view.rerender(<FlagPanel {...base} flag={{ ...flag(), upgradeTier: "atlas_shrine" }} />);
    expect(screen.queryByRole("button", { name: "Harden" })).toBeNull();
    view.rerender(<FlagPanel {...base} flag={flag()} player={player("other-owner")} />);
    expect(screen.queryByRole("button", { name: "Harden" })).toBeNull();
  });

  it("labels a buoy distinctly and hides every excluded conversion or upgrade", () => {
    render(
      <FlagPanel
        flag={{ ...flag(), anchorKind: "buoy", name: "Buoy 1" }}
        player={player("owner-id")}
        access={accessSnapshot("owner-id")}
        accessTraceId="trace-1"
        kingdomState={kingdomState()}
        onPreviewCityFounding={vi.fn()}
        onConvertCityFlag={vi.fn()}
        onVisitFlag={vi.fn()}
        onDeleteFlag={vi.fn()}
        deleting={false}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole("heading", { name: "Ash's Buoy (Private)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Destroy Buoy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Stone|Shrine|Place City|Contribute to/ })).toBeNull();
  });

  it("does not offer city or Kingdom conversion for an Atlas Shrine", () => {
    render(
      <FlagPanel
        flag={{ ...flag(), reinforcementLevel: 2, upgradeTier: "atlas_shrine" }}
        player={player("owner-id")}
        access={accessSnapshot("owner-id")}
        accessTraceId="trace-1"
        kingdomState={kingdomState()}
        onPreviewCityFounding={vi.fn()}
        onConvertCityFlag={vi.fn()}
        onVisitFlag={vi.fn()}
        onDeleteFlag={vi.fn()}
        deleting={false}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("button", { name: "Place City Blueprint" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Contribute to Mesa Wardens" })).toBeNull();
  });

  it("keeps player details and developer diagnostics out of contextual More", () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ progression: atlasShrineProgression() })));
    renderPanel(player("owner-id"));
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.queryByRole("button", { name: "Player Details" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Developer Diagnostics" })).toBeNull();
  });

  it("offers the destructive burn for another player's base Flag and Buoy, not an intact Stone Flag", () => {
    const onBurn = vi.fn(() => true);
    const common = {
      player: player("other-owner"),
      onVisitFlag: vi.fn(),
      onDeleteFlag: vi.fn(),
      onBurn,
      deleting: false,
      onClose: vi.fn()
    };
    const view = render(<FlagPanel {...common} flag={{ ...flag(), anchorKind: "flag", upgradeTier: "base", health: 40, maximumHealth: 220 }} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: "Burn Flag · 1 Torch" }));
    expect(onBurn).toHaveBeenCalledWith(flag().id);
    expect(onBurn).toHaveBeenCalledTimes(1);
    expect(common.onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Burn Flag" })).toBeNull();

    // A Buoy is a soft 220 HP anchor and burns like a base Flag.
    view.rerender(<FlagPanel {...common} flag={{ ...flag(), anchorKind: "buoy", upgradeTier: "base", health: 40, maximumHealth: 220 }} />);
    const more = screen.queryByRole("button", { name: "More" });
    if (more) fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Burn Flag · 1 Torch" })).toBeTruthy();
    view.rerender(<FlagPanel {...common} flag={{ ...flag(), anchorKind: "flag", upgradeTier: "stone" }} />);
    expect(screen.queryByRole("button", { name: "Burn Flag · 1 Torch" })).toBeNull();
  });

  it("keeps combat in More for neutral flags and removes Travel for enemy flags", () => {
    const onAttack = vi.fn(() => true);
    const hardened = {
      ...flag(),
      reinforcementLevel: 1,
      upgradeTier: "stone" as const,
      health: 220,
      maximumHealth: 220
    };
    const common = {
      flag: hardened,
      player: player("other-owner"),
      onVisitFlag: vi.fn(),
      onDeleteFlag: vi.fn(),
      onAttack,
      deleting: false,
      onClose: vi.fn()
    };
    const neutral = render(<FlagPanel
      {...common}
      access={{
        ...accessSnapshot("other-owner"),
        mode: "public",
        decision: {
          ...accessSnapshot("other-owner").decision,
          allowed: true,
          reasonCode: "ALLOWED_PUBLIC"
        }
      }}
      accessTraceId="trace-1"
    />);
    expect(screen.getByRole("button", { name: /^Travel/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Attack Flag" })).toBeTruthy();
    neutral.unmount();

    const enemyAccess = {
      ...accessSnapshot("other-owner"),
      decision: {
        ...accessSnapshot("other-owner").decision,
        allowed: false,
        reasonCode: "NORMAL_ENEMY_BLOCKED" as const
      }
    };
    const view = render(<FlagPanel
      {...common}
      access={enemyAccess}
      accessTraceId="trace-2"
    />);
    expect(screen.queryByRole("button", { name: "Travel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Attack Flag" }));
    expect(onAttack).toHaveBeenCalledWith(hardened.id);
    view.rerender(<FlagPanel
      {...common}
      flag={{ ...hardened, health: 110 }}
      access={enemyAccess}
      accessTraceId="trace-2"
      onBurn={vi.fn(() => true)}
    />);
    expect(screen.queryByRole("button", { name: "Travel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Burn Flag · 1 Torch" })).toBeTruthy();
  });

  it("offers a structure-driven Bomber picker without travel for a developer test target", () => {
    const onExplode = vi.fn();
    const onAttack = vi.fn();
    const target = {
      ...flag(),
      // The durable fixture keeps the spawning developer as raw owner; the
      // marker must still present the structure as hostile to that player.
      ownerId: "owner-id",
      ownerUsername: "Developer Test Enemy",
      name: "Test Tower",
      developerTestTarget: true,
      reinforcementLevel: 3,
      upgradeTier: "tower" as const,
      health: 2700,
      maximumHealth: 2700
    };
    render(<FlagPanel
      flag={target}
      player={player("owner-id")}
      access={{
        ...accessSnapshot("owner-id"),
        decision: { ...accessSnapshot("owner-id").decision, allowed: false, reasonCode: "PRIVATE_OWNER_ONLY" }
      }}
      accessTraceId="trace-test-target"
      bomberGroups={[bomberGroup()]}
      onExplode={onExplode}
      onAttack={onAttack}
      onVisitFlag={vi.fn()}
      onDeleteFlag={vi.fn()}
      deleting={false}
      onClose={vi.fn()}
    />);

    expect(screen.queryByRole("button", { name: /^Travel/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Attack Flag" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plant Bomb" }));
    expect(screen.getByRole("heading", { name: "Choose Bomber" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Bomber \+1/ }));
    expect(onExplode).toHaveBeenCalledWith("bomber-group-1", target.id);
  });

  it("keeps Kingdom contribution out of contextual More", () => {
    render(<FlagPanel flag={flag()} player={player("owner-id")}
      access={accessSnapshot("owner-id")} accessTraceId="trace-1"
      kingdomState={kingdomState()} onVisitFlag={vi.fn()}
      onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("button", { name: /Contribute to/ })).toBeNull();
  });

  it("warns about downstream flags before owner removal", async () => {
    const affiliated = {
      ...flag(),
      controlType: "kingdom" as const,
      kingdomId: kingdomState().kingdom!.id,
      kingdomName: "Mesa Wardens",
      kingdomEmblemKey: "sun",
      kingdomAffiliatedAt: "2026-07-10T00:00:00.000Z"
    };
    vi.spyOn(KingdomApiClient.prototype, "getFlagRemovalPreview").mockResolvedValue({
      flagId: affiliated.id,
      kingdomId: affiliated.kingdomId,
      allowed: true,
      reasonCode: null,
      reason: null,
      networkRevision: "9",
      downstreamCount: 2
    });
    render(<FlagPanel flag={affiliated} player={player("owner-id")} kingdomState={kingdomState()}
      serverHttpBase="https://game.example" csrfToken="csrf" onVisitFlag={vi.fn()}
      onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()} />);
    const button = await screen.findByRole("button", { name: "Return to Personal Flag" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Return to Personal Flag?" }).textContent)
      .toContain("2 downstream Kingdom Flags");
    expect(screen.getByText("Kingdom Flag")).toBeTruthy();
    expect(screen.getAllByText("Ash").length).toBeGreaterThan(0);
  });

  it("allows the Kingdom leader to revoke another member's affiliation", async () => {
    const affiliated = {
      ...flag(),
      controlType: "kingdom" as const,
      ownerId: "other-owner",
      ownerUsername: "Other Owner",
      kingdomId: kingdomState().kingdom!.id,
      kingdomName: "Mesa Wardens",
      kingdomAffiliatedAt: "2026-07-10T00:00:00.000Z"
    };
    vi.spyOn(KingdomApiClient.prototype, "getFlagRemovalPreview").mockResolvedValue({
      flagId: affiliated.id,
      kingdomId: affiliated.kingdomId,
      allowed: true,
      reasonCode: null,
      reason: null,
      networkRevision: "12",
      downstreamCount: 0
    });
    const remove = vi.spyOn(KingdomApiClient.prototype, "removeFlag").mockResolvedValue({
      state: kingdomState(), stateRefreshRequired: false, quote: null, replayed: false, message: null
    });
    render(<FlagPanel flag={affiliated} player={player("owner-id")} kingdomState={kingdomState()}
      serverHttpBase="https://game.example" csrfToken="csrf" onVisitFlag={vi.fn()}
      onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()} />);

    const button = await screen.findByRole("button", { name: "Return to Personal Flag" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Return to Personal Flag?" }).textContent)
      .toContain("No downstream Kingdom Flags");
    fireEvent.click(screen.getByRole("button", { name: "Return to Personal" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(affiliated.id, "12"));
  });

  it("keeps Kingdom conversion controls out of contextual More", () => {
    render(<FlagPanel flag={flag()} player={player("owner-id")}
      access={accessSnapshot("owner-id")} accessTraceId="trace-1"
      kingdomState={kingdomState()} onVisitFlag={vi.fn()}
      onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("button", { name: /Contribute to/ })).toBeNull();
  });

  it("does not give an unauthorized contributor owner actions after conversion", () => {
    const state = kingdomState();
    state.membership = { ...state.membership!, role: "member" };
    state.permissions = ["contribute_kingdom_flags"];
    const contributed = {
      ...flag(),
      controlType: "kingdom" as const,
      kingdomId: state.kingdom!.id,
      kingdomName: state.kingdom!.displayName,
      kingdomColor: state.kingdom!.displayColor,
      contributedByPlayerId: "owner-id",
      contributedByUsername: "Ash"
    };
    render(<FlagPanel flag={contributed} player={player("owner-id")} kingdomState={state}
      onVisitFlag={vi.fn()} onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()} />);

    expect(screen.getByText(/contributed by Ash/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Return to Personal Flag" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Destroy Flag" })).toBeNull();
    expect(screen.getByText(/controlled by the Kingdom/)).toBeTruthy();
  });

  it("lets a city member destroy their contributed city flag without exposing Seat destruction", () => {
    const onDeleteFlag = vi.fn();
    const membership = {
      cityId: "22222222-2222-4222-8222-222222222222",
      cityName: "Albuquerque",
      role: "member" as const,
      joinedAt: "2026-07-18T00:00:00.000Z",
      houseStructureId: "house-1",
      expansionFlagCount: 0,
      expansionFlagLimit: 6
    };
    const cityFlag = {
      ...flag(),
      controlType: "city" as const,
      cityId: membership.cityId
    };
    const view = render(
      <FlagPanel
        flag={cityFlag}
        player={player("owner-id")}
        cityMembership={membership}
        onVisitFlag={vi.fn()}
        onDeleteFlag={onDeleteFlag}
        deleting={false}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Destroy Flag" }));
    expect(onDeleteFlag).toHaveBeenCalledTimes(1);

    view.rerender(
      <FlagPanel
        flag={{ ...cityFlag, controlType: "city_seat" as const }}
        player={player("owner-id")}
        cityMembership={membership}
        onVisitFlag={vi.fn()}
        onDeleteFlag={onDeleteFlag}
        deleting={false}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Destroy Flag" })).toBeNull();
  });

  it("keeps city contribution out of contextual More even when over capacity", () => {
    render(<FlagPanel flag={flag()} player={player("owner-id")}
      access={accessSnapshot("owner-id")} accessTraceId="trace-1"
      cityMembership={{
        cityId: "22222222-2222-4222-8222-222222222222",
        cityName: "Albuquerque",
        role: "member",
        joinedAt: "2026-07-18T00:00:00.000Z",
        houseStructureId: "house-1",
        expansionFlagCount: 16,
        expansionFlagLimit: 11
      }}
      onConvertCityFlag={vi.fn()} onVisitFlag={vi.fn()}
      onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("button", { name: "Contribute to Albuquerque" })).toBeNull();
  });
});

describe("PlayerFlagDetails", () => {
  it("shows concise gameplay fields and hides developer-only data", () => {
    const view = render(<PlayerDetailsContent details={details()} />);
    for (const text of ["Overview", "Location", "Terrain", "Ecology", "Nearby Water", "Albuquerque", "New Mexico", "United States", "1,511 m", "Flat", "Mixed Or Mosaic", "Deserts & Xeric Shrublands", "Colorado Plateau shrublands", "Exact ecology from older map snapshot", "Rio Grande · River · Fresh · 178 m", "Not associated with a player city", "This flag uses an older stored world snapshot."]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    for (const hidden of [flag().id, "owner-id", "53.3498", "world_v1_lat53_lon-7", "HydroRIVERS ID", "Profile-set fingerprint", "Raw Snapshot", "nearest_water_search_radius_m"]) {
      expect(view.container.textContent).not.toContain(hidden);
    }
  });

  it("uses semantic coastline states for legacy and bounded searches", () => {
    const legacy = details();
    const view = render(<PlayerDetailsContent details={legacy} />);
    expect(screen.getByText("Coastline distance was not recorded in this older map snapshot")).toBeTruthy();
    cleanup();
    const bounded = details();
    bounded.provenance.snapshotStatus = "current";
    bounded.terrain.coastlineSearchComplete = true;
    bounded.terrain.coastlineSearchRadiusM = 100_000;
    render(<PlayerDetailsContent details={bounded} />);
    expect(screen.getByText("Far inland — no coast within 100 km")).toBeTruthy();
    expect(view.container.scrollWidth).toBeLessThanOrEqual(view.container.clientWidth || view.container.scrollWidth);
  });

  it("labels exact current ecology and unavailable stored snapshots honestly", () => {
    const current = details();
    current.provenance.snapshotStatus = "current";
    current.provenance.environmentSchemaVersion = "world-profile-v2";
    current.ecology.resolution = "exact";
    render(<PlayerDetailsContent details={current} />);
    expect(screen.getByText("Ash's Flag")).toBeTruthy();
    expect(screen.queryByText("Flag 9")).toBeNull();
    expect(screen.getByText("Exact mapped ecology")).toBeTruthy();
    cleanup();

    const unavailable = details();
    unavailable.provenance.snapshotStatus = "unavailable";
    unavailable.provenance.snapshotStatusReason = "No stored world snapshot is available for this flag.";
    unavailable.ecology.resolution = null;
    unavailable.terrain.coastlineSearchComplete = null;
    render(<PlayerDetailsContent details={unavailable} />);
    expect(screen.getByText("No stored world snapshot is available for this flag.")).toBeTruthy();
    expect(screen.getAllByText("Map data could not be determined at this location.").length).toBeGreaterThan(0);
  });

  it("shows a bounded loading failure and retries with a fresh request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "no" }, 503))
      .mockResolvedValueOnce(jsonResponse(details()));
    vi.stubGlobal("fetch", fetchMock);
    render(<PlayerFlagDetails flagId="flag-id" flagName="Flag 9" serverHttpBase="http://127.0.0.1:3305" onClose={vi.fn()} />);

    expect(await screen.findByText("Could not load details")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getAllByText("Nearby Water").length).toBeGreaterThan(0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "include" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ credentials: "include" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).not.toBe(fetchMock.mock.calls[1]?.[1]?.signal);
  });

  it.each([
    [401, "Your session expired. Sign in again to view advanced flag details."],
    [404, "This flag no longer exists."],
    [500, "The server could not load advanced flag details. Try again shortly."]
  ])("shows a bounded error for HTTP %i", async (status, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ internal: "not displayed" }, status)));
    render(<PlayerFlagDetails flagId="flag-id" flagName="Flag 9" serverHttpBase="http://127.0.0.1:3305" onClose={vi.fn()} />);

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText("not displayed")).toBeNull();
  });

  it("distinguishes an invalid successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    render(<PlayerFlagDetails flagId="flag-id" flagName="Flag 9" serverHttpBase="http://127.0.0.1:3305" onClose={vi.fn()} />);

    expect(await screen.findByText("Advanced flag details returned an invalid response.")).toBeTruthy();
  });

});

describe("DeveloperFlagDiagnostics", () => {
  it("renders and fetches nothing without developer access", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<DeveloperFlagDiagnostics developerAccessEnabled={false} flagId={flag().id} flagName="Flag 9" serverHttpBase="http://127.0.0.1:3305" csrfToken="csrf" onRefreshed={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows IDs, legacy schema, full live hydrology, provenance, raw JSON, and diff", () => {
    const payload = diagnostics();
    const rawBefore = JSON.stringify(payload.live.rawLookup);
    render(<DeveloperDiagnosticsContent diagnostics={payload} />);
    for (const text of ["world-profile-v1 (legacy)", flag().id, "owner-id", "651", "20287927", "2.692 m³/s", "9.36 km²", "Not recorded — run live lookup or refresh snapshot", "Map sources agree", "Profile-set fingerprint", "Source · Ecoregions", "Stored database environment_snapshot", "Current live World API lookup", "Stored versus Live Diff (1)"]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText("50 km").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Yes — configured search area completed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("within_search_radius").length).toBeGreaterThan(0);
    expect(JSON.stringify(payload.live.rawLookup)).toBe(rawBefore);
    expect(payload.stored.provenance.environmentSchemaVersion).toBe("world-profile-v1");
  });

  it("runs live lookup without refresh and reloads diagnostics after stored refresh", async () => {
    const payload = diagnostics();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(payload))
      .mockResolvedValueOnce(jsonResponse({ ok: true, requested: 1, refreshed: 1, failures: [], truncated: false }))
      .mockResolvedValueOnce(jsonResponse(payload));
    vi.stubGlobal("fetch", fetchMock);
    render(<DeveloperFlagDiagnostics developerAccessEnabled flagId={flag().id} flagName="Flag 9" serverHttpBase="http://127.0.0.1:3305" csrfToken="csrf" onRefreshed={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText("Snapshot Summary");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Stored Snapshot" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain(flag().id);
  });
});

function renderPanel(currentPlayer: PlayerSnapshot) {
  return render(panel(currentPlayer));
}

function panel(currentPlayer: PlayerSnapshot) {
  return <FlagPanel flag={flag()} player={currentPlayer} serverHttpBase="http://127.0.0.1:3305"
    csrfToken="csrf" access={accessSnapshot(currentPlayer.playerId)} accessTraceId="trace-1"
    onAccessChange={vi.fn()} onVisitFlag={vi.fn()} onDeleteFlag={vi.fn()} deleting={false}
    onClose={vi.fn()} />;
}

function flag(): FlagSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    controlType: "personal",
    ownerId: "owner-id",
    ownerUsername: "Ash",
    ownerColor: "#38bdf8",
    health: 110,
    maximumHealth: 100,
    name: "Flag 9",
    lat: 53.3498,
    lon: -6.2603,
    packageId: "world_v1_lat53_lon-7",
    elevationM: 0,
    terrainClass: "flat",
    biome: "Temperate Broadleaf & Mixed Forests",
    ecoregion: "Celtic broadleaf forests",
    claimRadiusM: 1000,
    cityId: null,
    createdAt: "2026-07-13T08:00:00.000Z"
  };
}

function atlasShrineProgression() {
  return {
    unlockedSlots: 0,
    builtShrines: 0,
    availableCapacity: 1,
    nextSlot: 1,
    requiredLevel: 1,
    playerLevel: 1,
    requiredShards: 1,
    currentShards: 1,
    levelRequirementMet: true,
    shardRequirementMet: true
  };
}

function accessSnapshot(playerId: string): FlagAccessSnapshot {
  return {
    flagId: flag().id,
    ownerPlayerId: "owner-id",
    mode: "private",
    jumpTollGold: "0",
    accessRevision: "0",
    requestPending: false,
    decision: {
      allowed: playerId === "owner-id",
      requestable: false,
      reasonCode: playerId === "owner-id" ? "ALLOWED_OWNER" : "PRIVATE_OWNER_ONLY",
      tollGold: "0"
    },
    management: playerId === "owner-id" ? { pendingRequests: [] } : null
  };
}

function player(playerId: string): PlayerSnapshot {
  return {
    playerId,
    username: "Ash",
    displayColor: "#38bdf8",
    regionCode: "GLOBAL",
    zoneId: "world",
    lat: 53.3498,
    lon: -6.2603,
    anchorLat: 53.3498,
    anchorLon: -6.2603,
    moveLeashRadiusM: 1250,
    movementRevision: 0,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: "2026-07-13T08:00:00.000Z"
  };
}

function bomberGroup(): MilitaryUnitGroupSnapshot {
  return {
    groupId: "bomber-group-1",
    ownerPlayerId: "owner-id",
    unitType: "bomber",
    memberUnitIds: ["bomber-1"],
    memberCount: 1,
    currentHp: 60,
    maxHp: 60,
    locationState: "DEPLOYED_FIELD",
    stationCityId: null,
    warCampId: null,
    lat: 53.3498,
    lon: -6.2603,
    targetFlagId: null,
    nextFireAt: null,
    packingCompletesAt: null,
    movementOrder: "NONE",
    movementTarget: null,
    revision: "1"
  };
}

function kingdomState(): KingdomStateSnapshot {
  const membership = {
    membershipId: "membership-1",
    playerId: "owner-id",
    displayName: "Ash",
    role: "leader" as const,
    status: "active" as const,
    joinedAt: "2026-07-10T00:00:00.000Z",
    endedAt: null,
    perkQualifiedAt: "2026-07-10T00:00:00.000Z",
    chatMutedUntil: null,
    chatMute: { state: "not_muted" as const }
  };
  return {
    spatialRevision: "4",
    membership,
    kingdom: {
      id: "00000000-0000-4000-8000-000000000010",
      displayName: "Mesa Wardens",
      displayColor: "#7c3aed",
      description: null,
      emblemKey: "sun",
      founderPlayerId: membership.playerId,
      leaderPlayerId: membership.playerId,
      level: 1,
      memberCount: 1,
      kingdomFlagCount: 0,
      spatialRevision: "4",
      status: "active",
      seat: null,
      createdAt: "2026-07-10T00:00:00.000Z"
    },
    permissions: [
      "contribute_kingdom_flags", "manage_kingdom_flags",
      "release_kingdom_flags", "destroy_kingdom_flags"
    ], roster: [membership], invitations: [], chatHistory: [], treasury: [],
    donationHistory: null, treasuryExpenditureHistory: null, progression: null,
    advancementProject: null, activityHistory: [], cots: [], decorations: [], kingdomFlags: [],
    decorationCatalog: [], nearbyKingdoms: [], freeConstruction: true, perkQualificationSeconds: 0
  };
}

function details(): FlagEnvironmentDetails {
  return {
    identity: { flagId: flag().id, flagName: "Flag 9", ownerId: "owner-id", ownerName: "Ash", ownerColor: "#38bdf8", createdAt: flag().createdAt, claimRadiusM: 1000, cityId: null, cityName: null },
    coordinates: { latitude: 35.0844, longitude: -106.6504, packageId: "legacy-package-id" },
    administrative: { countryId: "USA", countryName: "United States", countryCode: "US", regionId: "NM", regionName: "New Mexico", regionCode: "NM", cityId: "geo-albuquerque", cityName: "Albuquerque", insideCity: true, cityBoundaryDistanceM: 0 },
    terrain: { elevationM: 1511, terrainClass: "flat", landCoverClass: "mixed_or_mosaic", sourceLandCoverCode: 40, isLand: true, isSaltwater: false, isCoastal: false, coastlineDistanceM: null, coastlineSearchRadiusM: null, coastlineSearchComplete: null, coastalThresholdM: null, landCoverConflict: false },
    ecology: { biomeId: "13", biomeName: "Deserts & Xeric Shrublands", ecoregionId: "651", ecoregionName: "Colorado Plateau shrublands", resolution: "exact_legacy", distanceM: 0, sourcePackageId: "legacy-package-id", fallbackMaxM: null, searchComplete: null },
    water: {
      nearest: { sourceType: "river", sourceId: "rio-grande", sourceName: "Rio Grande", kind: "fresh", distanceM: 178, resolution: "derived_legacy_candidates", searchRadiusM: null, searchComplete: null },
      namedRiver: { id: "rio-grande", name: "Rio Grande", riverClass: "river", distanceM: 178, searchRadiusM: null, searchComplete: null },
      supportingRiver: { id: null, flowOrder: null, dischargeCms: null, drainageAreaSqKm: null, distanceM: null, searchRadiusM: null, searchComplete: null },
      majorLake: { id: "jemez-canyon", name: "Jemez Canyon Reservoir", inside: false, distanceM: 35000, searchRadiusM: null, searchComplete: null },
      oceanDepthClass: "not_applicable"
    },
    provenance: { worldReleaseId: "world-packages-v1", profileSetFingerprint: "a".repeat(64), buildContractFingerprint: "b".repeat(64), boundaryReleaseId: "world-boundaries-v1", packageCount: null, environmentSchemaVersion: "world-profile-v1", sourceVersions: { ecoregions: "2017" }, derivedTags: [], warnings: [], snapshotStatus: "legacy", snapshotStatusReason: "The snapshot predates the comprehensive world-profile-v2 contract.", snapshotUpdatedAt: "2026-07-13T09:00:00.000Z" },
    rawSnapshot: { profile: { environment_schema_version: "world-profile-v1" } }
  };
}

function diagnostics(): FlagEnvironmentDiagnostics {
  const stored = details();
  const live: FlagEnvironmentDetails = {
    ...stored,
    terrain: {
      ...stored.terrain,
      coastlineSearchRadiusM: 100_000,
      coastlineSearchComplete: true,
      coastalThresholdM: 5_000
    },
    ecology: {
      ...stored.ecology,
      resolution: "exact",
      sourcePackageId: "current-package-id",
      fallbackMaxM: 10_000,
      searchComplete: true
    },
    water: {
      ...stored.water,
      nearest: { ...stored.water.nearest, resolution: "within_search_radius", searchRadiusM: 50_000, searchComplete: true },
      namedRiver: { ...stored.water.namedRiver, searchRadiusM: 100_000, searchComplete: true },
      supportingRiver: { id: "20287927", flowOrder: 6, dischargeCms: 2.692, drainageAreaSqKm: 9.36, distanceM: 912, searchRadiusM: 100_000, searchComplete: true },
      majorLake: { ...stored.water.majorLake, searchRadiusM: 100_000, searchComplete: true }
    },
    provenance: {
      ...stored.provenance,
      environmentSchemaVersion: "world-profile-v2",
      packageCount: 142,
      sourceVersions: { ecoregions: "Resolve_Ecoregions2017" },
      snapshotStatus: "current",
      snapshotStatusReason: "The live lookup matches the required world release and schema."
    },
    rawSnapshot: { profile: { environment_schema_version: "world-profile-v2", supporting_river_id: "20287927" } }
  };
  return {
    stored,
    live: {
      details: live,
      rawLookup: live.rawSnapshot,
      lookupStartedAt: "2026-07-13T09:05:00.000Z",
      durationMs: 12.5,
      packageCacheState: "warm"
    },
    comparison: [{ path: "provenance.environmentSchemaVersion", label: "Provenance / Environment Schema Version", kind: "changed", stored: "world-profile-v1", live: "world-profile-v2" }],
    required: { environmentSchemaVersion: "world-profile-v2", worldReleaseId: "world-packages-v1", profileSetFingerprint: "a".repeat(64), buildContractFingerprint: "b".repeat(64), boundaryReleaseId: "world-boundaries-v1" },
    refreshRecommended: true
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
