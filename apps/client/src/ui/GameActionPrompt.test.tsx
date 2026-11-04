// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GameActionPrompt, GameConfirmationPrompt } from "./GameActionPrompt.js";

afterEach(cleanup);

describe("GameActionPrompt", () => {
  it("renders canonical title, category, actions, and Cancel hierarchy", () => {
    const onCancel = vi.fn();
    render(<GameActionPrompt
      title="Manor Door"
      category="PORTAL"
      actions={[
        { key: "leave", label: "Leave Manor", onSelect: vi.fn() },
        { key: "inspect", label: "Inspect", tone: "secondary", onSelect: vi.fn() }
      ]}
      onCancel={onCancel}
    />);

    expect(screen.getByText("Manor Door")).toBeTruthy();
    expect(screen.getByText("PORTAL")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Leave Manor" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("hides an unavailable contextual action and keeps Cancel last", () => {
    const view = render(<GameActionPrompt
      title="Dire Wolf"
      category="COMBAT TARGET"
      actionLayout="primary-quick"
      actions={[
        { key: "attack", label: "Attack", onSelect: vi.fn() },
        { key: "shield-charge", label: "Shield Charge", enabled: false, disabledReason: "Equip a Shield to use Shield Charge.", onSelect: vi.fn() }
      ]}
      onCancel={vi.fn()}
    />);

    const actions = view.container.querySelector(".game-compact-actions--primary-quick")!;
    expect(actions).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attack" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Shield Charge" })).toBeNull();
    expect(screen.queryByText("Equip a Shield to use Shield Charge.")).toBeNull();
    expect(actions.lastElementChild).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("hides unavailable actions without helper text and blocks busy ones", () => {
    const disabledAction = vi.fn();
    const busyAction = vi.fn();
    const onCancel = vi.fn();
    render(<GameActionPrompt
      title="Smithing Station"
      category="CRAFTING"
      actions={[
        { key: "disabled", label: "Use Smithing", enabled: false, disabledReason: "Requires access.", onSelect: disabledAction },
        { key: "busy", label: "Approaching…", busy: true, disabledReason: "Walking to the station.", onSelect: busyAction }
      ]}
      onCancel={onCancel}
    />);

    expect(screen.queryByRole("button", { name: "Use Smithing" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approaching…" }));
    expect(disabledAction).not.toHaveBeenCalled();
    expect(busyAction).not.toHaveBeenCalled();
    expect(screen.queryByText("Requires access.")).toBeNull();
    expect(screen.queryByText("Walking to the station.")).toBeNull();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("contains pointer actions instead of leaking them into the scene", () => {
    const sceneClick = vi.fn();
    const action = vi.fn();
    render(<div onClick={sceneClick}>
      <GameActionPrompt
        title="Manor Storage"
        actions={[{ key: "open", label: "Open Storage", onSelect: action }]}
        onCancel={vi.fn()}
      />
    </div>);

    fireEvent.click(screen.getByRole("button", { name: "Open Storage" }));
    expect(action).toHaveBeenCalledOnce();
    expect(sceneClick).not.toHaveBeenCalled();
  });

  it("owns focus and input in a forced top-layer prompt without a Cancel action", () => {
    const scenePointer = vi.fn();
    const sceneClick = vi.fn();
    const onCancel = vi.fn();
    const outerEscape = vi.fn();
    const onOuterKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") outerEscape();
    };
    document.addEventListener("keydown", onOuterKeyDown);
    const view = render(<div onPointerDown={scenePointer} onClick={sceneClick}>
      <GameActionPrompt
        forced
        title="YOU FELL"
        ariaLabel="You fell"
        actions={[{ key: "respawn", label: "Respawn", onSelect: vi.fn() }]}
        onCancel={onCancel}
      />
    </div>);

    const dialog = screen.getByRole("dialog", { name: "You fell" });
    const respawn = screen.getByRole("button", { name: "Respawn" });
    const layer = view.container.querySelector(".game-action-prompt-forced-layer")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(document.activeElement).toBe(respawn);

    fireEvent.keyDown(respawn, { key: "Tab" });
    expect(document.activeElement).toBe(respawn);
    fireEvent.keyDown(respawn, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(outerEscape).not.toHaveBeenCalled();

    fireEvent.pointerDown(layer);
    fireEvent.click(layer);
    expect(scenePointer).not.toHaveBeenCalled();
    expect(sceneClick).not.toHaveBeenCalled();
    document.removeEventListener("keydown", onOuterKeyDown);
  });

  it("moves forced focus to the first action when it becomes enabled", () => {
    const view = render(<GameActionPrompt
      forced
      title="YOU FELL"
      actions={[{ key: "respawn", label: "Respawn", enabled: false, onSelect: vi.fn() }]}
      onCancel={vi.fn()}
    />);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);

    view.rerender(<GameActionPrompt
      forced
      title="YOU FELL"
      actions={[{ key: "respawn", label: "Respawn", enabled: true, onSelect: vi.fn() }]}
      onCancel={vi.fn()}
    />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Respawn" }));
  });

  it("presents provisional actions normally while preventing authority until promotion", () => {
    const action = vi.fn();
    const onCancel = vi.fn();
    const actions = [{ key: "attack", label: "Attack", onSelect: action }];
    const view = render(<GameActionPrompt
      title="Wolf"
      actions={actions}
      presentationState="visible"
      actionsReady={false}
      onCancel={onCancel}
    />);
    const panel = view.container.querySelector(".game-compact-prompt");
    const attack = screen.getByRole("button", { name: "Attack" }) as HTMLButtonElement;

    expect(panel?.getAttribute("data-world-target-presentation")).toBe("visible");
    expect(attack.disabled).toBe(false);
    fireEvent.click(attack);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(action).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    view.rerender(<GameActionPrompt
      title="Wolf"
      actions={actions}
      actionsReady
      onCancel={onCancel}
    />);
    expect(view.container.querySelector(".game-compact-prompt")).toBe(panel);
    fireEvent.click(screen.getByRole("button", { name: "Attack" }));
    expect(action).toHaveBeenCalledOnce();
  });

  it("uses the same compact shell for confirmations", () => {
    const view = render(<GameConfirmationPrompt
      title="Remove this guest?"
      confirmLabel="Remove Guest"
      destructive
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />);
    expect(view.container.querySelector(".game-compact-prompt")).toBeTruthy();
    expect(view.container.querySelector(".game-compact-prompt-elevated")).toBeTruthy();
    expect(view.container.querySelector("button.danger")).toBeTruthy();
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Guest" }));
  });

  it("renders the exact neutral Goblin hostility confirmation labels", () => {
    render(<GameConfirmationPrompt
      title="You Will Become Enemy Of The Goblins"
      confirmLabel="Yes"
      cancelLabel="No"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />);
    expect(screen.getByText("You Will Become Enemy Of The Goblins")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No" })).toBeTruthy();
  });

  it("keeps nested Escape ownership and restores focus", () => {
    const closeOuter = vi.fn();
    const cancelPrompt = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    document.addEventListener("keydown", closeOuter, true);
    const view = render(<GameConfirmationPrompt
      title="Relinquish Mayor?"
      detail="No city resources will be returned."
      confirmLabel="Relinquish Mayor"
      destructive
      onConfirm={vi.fn()}
      onCancel={cancelPrompt}
    />);
    const confirm = screen.getByRole("button", { name: "Relinquish Mayor" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancelPrompt).toHaveBeenCalledOnce();
    expect(closeOuter).not.toHaveBeenCalled();
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    document.removeEventListener("keydown", closeOuter, true);
    trigger.remove();
  });

  it("focuses the first enabled action instead of an earlier disabled action", () => {
    render(<GameActionPrompt
      title="Depleted Mine"
      actions={[
        { key: "mine", label: "Depleted", enabled: false, onSelect: vi.fn() },
        { key: "inspect", label: "Inspect", onSelect: vi.fn() }
      ]}
      onCancel={vi.fn()}
    />);

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inspect" }));
  });

  it("falls back to Cancel when every action is disabled", () => {
    render(<GameActionPrompt
      title="Unavailable actions"
      actions={[{ key: "use", label: "Use", enabled: false, onSelect: vi.fn() }]}
      onCancel={vi.fn()}
    />);

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("focuses the prompt when busy state disables every control", () => {
    render(<GameActionPrompt
      title="Busy actions"
      actions={[{ key: "use", label: "Working…", busy: true, onSelect: vi.fn() }]}
      onCancel={vi.fn()}
    />);

    expect(document.activeElement).toBe(screen.getByLabelText("Busy actions actions"));
  });

  it("dismisses on an outside tap and lets the tap reach the scene for double-tap movement", () => {
    const sceneClick = vi.fn();
    const onCancel = vi.fn();
    const view = render(<div>
      <div data-testid="scene" onClick={sceneClick} />
      <GameActionPrompt
        title="Universal Taunt"
        actions={[]}
        cancelLabel="Close"
        dismissOnOutsideClick
        onCancel={onCancel}
      />
    </div>);
    const scene = view.getByTestId("scene");
    fireEvent.pointerDown(scene, { pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(scene, { pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.click(scene);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(sceneClick).toHaveBeenCalledOnce();
  });
});
