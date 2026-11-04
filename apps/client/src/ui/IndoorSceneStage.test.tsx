// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { IndoorSceneStage } from "./IndoorSceneStage.js";

describe("IndoorSceneStage", () => {
  it("fits a square logical room through the canonical inner stage", () => {
    const stageRef = createRef<HTMLDivElement>();
    const view = render(<IndoorSceneStage
      roomWidth={1_000}
      roomHeight={1_000}
      innerClassName="test-room"
      frameClassName="test-frame"
      stageRef={stageRef}
      aria-label="Test room"
    ><span>Room</span></IndoorSceneStage>);
    const frame = view.container.querySelector(".indoor-scene-stage-frame.test-frame");
    const stage = view.container.querySelector(".indoor-scene-stage.test-room") as HTMLDivElement;
    expect(frame).toBeTruthy();
    expect(stage.dataset.indoorView).toBe("fit");
    expect(stage.style.aspectRatio).toBe("1000 / 1000");
    expect(stage.style.width).toBe("min(100cqw, 100cqh)");
    expect(stage.dataset.indoorScale).toBeUndefined();
    expect(stage.style.transform).toBe("");
    expect(stage.getAttribute("aria-label")).toBe("Test room");
    expect(stageRef.current).toBe(stage);
  });

  it("precomputes the height-constrained width for a non-square room", () => {
    const view = render(<IndoorSceneStage
      roomWidth={1_000}
      roomHeight={500}
      innerClassName="wide-room"
      stageRef={createRef<HTMLDivElement>()}
    ><span>Wide room</span></IndoorSceneStage>);
    const stage = view.container.querySelector(".indoor-scene-stage") as HTMLDivElement;
    expect(stage.style.aspectRatio).toBe("1000 / 500");
    expect(stage.style.width).toBe("min(100cqw, 200cqh)");
  });

  it("zooms around the fixed room center without following or translating", () => {
    const view = render(<IndoorSceneStage
      roomWidth={1_200}
      roomHeight={600}
      scale={1.35}
      innerClassName="zoomed-room"
      stageRef={createRef<HTMLDivElement>()}
    ><span>Zoomed room</span></IndoorSceneStage>);
    const stage = view.container.querySelector(".indoor-scene-stage") as HTMLDivElement;
    expect(stage.dataset.indoorScale).toBe("1.35");
    expect(stage.style.transform).toBe("scale(1.35)");
    expect(stage.style.transformOrigin).toBe("center center");
    expect(stage.style.transform).not.toContain("translate");
  });

  it("applies a presentation-only camera translation before the shared zoom", () => {
    const view = render(<IndoorSceneStage
      roomWidth={1_200}
      roomHeight={600}
      scale={1.8}
      translation={{ x: 48, y: -24 }}
      innerClassName="panned-room"
      stageRef={createRef<HTMLDivElement>()}
    ><span>Panned room</span></IndoorSceneStage>);
    const stage = view.container.querySelector(".indoor-scene-stage.panned-room") as HTMLDivElement;
    expect(stage.style.transform).toBe("translate(48px, -24px) scale(1.8)");
    expect(stage.style.transformOrigin).toBe("center center");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid scale %s",
    (scale) => {
      expect(() => render(<IndoorSceneStage
        roomWidth={1_000}
        roomHeight={1_000}
        scale={scale}
        innerClassName="invalid-scale-room"
        stageRef={createRef<HTMLDivElement>()}
      ><span>Invalid</span></IndoorSceneStage>)).toThrow(
        "Indoor scene scale must be a positive finite number."
      );
    }
  );
});
