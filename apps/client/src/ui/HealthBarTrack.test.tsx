// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HealthBarTrack } from "./HealthBarTrack.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("HealthBarTrack", () => {
  it("renders clamped full, partial, critical, and zero health", () => {
    const view = render(<HealthBarTrack label="Health" current={100} maximum={100} />);
    const progress = screen.getByRole("progressbar", { name: "Health" });
    expect(progress.getAttribute("aria-valuenow")).toBe("100");
    expect(view.container.querySelector<HTMLElement>(".hp-bar-fill")?.style.width)
      .toBe("max(1px, 100%)");

    view.rerender(<HealthBarTrack label="Health" current={25} maximum={100} />);
    expect(progress.classList.contains("is-critical")).toBe(true);
    expect(view.container.querySelector<HTMLElement>(".hp-bar-fill")?.style.width)
      .toBe("max(1px, 25%)");

    view.rerender(<HealthBarTrack label="Health" current={0} maximum={100} />);
    expect(progress.classList.contains("is-critical")).toBe(false);
    expect(view.container.querySelector<HTMLElement>(".hp-bar-fill")?.style.width).toBe("0%");

    view.rerender(<HealthBarTrack label="Health" current={140} maximum={100} />);
    expect(progress.getAttribute("aria-valuenow")).toBe("100");
    expect(view.container.querySelector<HTMLElement>(".hp-bar-fill")?.style.width)
      .toBe("max(1px, 100%)");
  });

  it("shows damage trail for rapid damage but not healing", () => {
    const view = render(<HealthBarTrack label="Health" current={100} maximum={100} />);
    view.rerender(<HealthBarTrack label="Health" current={60} maximum={100} />);
    let trail = view.container.querySelector<HTMLElement>(".hp-bar-damage-trail")!;
    expect(trail.dataset.active).toBe("true");
    expect(trail.style.width).toBe("max(1px, 60%)");

    view.rerender(<HealthBarTrack label="Health" current={30} maximum={100} />);
    trail = view.container.querySelector<HTMLElement>(".hp-bar-damage-trail")!;
    expect(trail.dataset.active).toBe("true");

    view.rerender(<HealthBarTrack label="Health" current={70} maximum={100} />);
    trail = view.container.querySelector<HTMLElement>(".hp-bar-damage-trail")!;
    expect(trail.dataset.active).toBe("false");
  });

  it("layers blue Ward onto green health and exposes its numeric value", () => {
    const view = render(<HealthBarTrack label="Health" current={60} maximum={100} ward={8} />);
    const progress = screen.getByRole("progressbar", { name: "Health" });
    expect(progress.getAttribute("aria-valuetext")).toBe("60 of 100 health, 8 Ward");
    expect(view.container.querySelector<HTMLElement>(".hp-bar-fill")?.style.width).toBe("max(1px, 60%)");
    const ward = view.container.querySelector<HTMLElement>(".hp-bar-ward")!;
    expect(ward.dataset.ward).toBe("8");
    expect(ward.style.left).toBe("60%");
    expect(ward.style.width).toBe("8%");
  });

  it("cleans up its only timeout when removed during a damage transition", () => {
    vi.useFakeTimers();
    const view = render(<HealthBarTrack label="Health" current={100} maximum={100} />);
    view.rerender(<HealthBarTrack label="Health" current={50} maximum={100} />);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
