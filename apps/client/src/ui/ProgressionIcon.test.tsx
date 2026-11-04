// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProgressionIcon } from "./ProgressionIcon.js";

describe("ProgressionIcon", () => {
  it("renders an image source with alternative text", () => {
    const { container } = render(
      <ProgressionIcon
        src="/skills/cleave.png"
        alt="Cleave"
        iconKey="cleave"
        size={56}
      />,
    );
    const image = screen.getByRole("img", { name: "Cleave" });
    expect(image.getAttribute("src")).toBe("/skills/cleave.png");
    expect(image.getAttribute("width")).toBe("56");
    expect(
      container
        .querySelector(".progression-icon")
        ?.getAttribute("data-icon-key"),
    ).toBe("cleave");
  });

  it("renders sprite coordinates and a neutral accessible fallback", () => {
    const { rerender } = render(
      <ProgressionIcon
        alt="Archery"
        sprite={{
          src: "/atlas.png",
          x: 32,
          y: 64,
          width: 32,
          height: 32,
          key: "archery",
        }}
      />,
    );
    const sprite = screen.getByRole("img", { name: "Archery" });
    expect(sprite.getAttribute("data-sprite-key")).toBe("archery");
    expect(sprite.getAttribute("data-icon-key")).toBe("archery");
    expect(sprite.getAttribute("style")).toContain(
      "--progression-icon-size: 48px",
    );
    expect(sprite.firstElementChild?.getAttribute("style")).toContain(
      "width: 32px; height: 32px",
    );
    expect(sprite.firstElementChild?.getAttribute("style")).toContain(
      "-32px -64px",
    );
    expect(sprite.firstElementChild?.getAttribute("style")).toContain(
      "translate(0px, 0px) scale(1.5)",
    );
    expect(sprite.firstElementChild?.getAttribute("style")).toContain(
      "transform-origin: center",
    );
    rerender(<ProgressionIcon alt="Unknown profession" />);
    expect(
      screen.getByRole("img", { name: "Unknown profession" }).textContent,
    ).toBe("UP");
    rerender(
      <ProgressionIcon alt="Unknown profession" iconKey="unknown_profession" />,
    );
    const fallback = screen.getByRole("img", { name: "Unknown profession" });
    expect(fallback.classList.contains("progression-icon-fallback")).toBe(true);
    expect(fallback.getAttribute("data-icon-key")).toBe("unknown_profession");
    expect(fallback.textContent).toBe("UP");
  });

  it("applies normalized sprite positioning at the requested frame size", () => {
    const { container } = render(
      <ProgressionIcon
        alt="Adjusted"
        size={40}
        sprite={{ src: "/atlas.png", x: 0, y: 0, width: 100, height: 100,
          offsetX: 0.1, offsetY: -0.2, scale: 1.25 }}
      />
    );
    expect(container.querySelector(".progression-icon-sprite > span")?.getAttribute("style"))
      .toContain("translate(4px, -8px) scale(0.5)");
  });
});
