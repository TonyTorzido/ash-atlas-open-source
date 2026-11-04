// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DropItemDialog } from "./DropItemDialog.js";

const selection = {
  key: "wood:default:0",
  stackId: "wood-stack",
  itemId: "wood",
  variant: null,
  name: "Wood",
  maxStack: 500,
  quantity: 8
};

afterEach(cleanup);

describe("DropItemDialog", () => {
  it("shows the selected item, owned amount, and bounded amount controls", () => {
    const html = renderToStaticMarkup(
      <DropItemDialog
        selection={selection}
        amount={3}
        busy={false}
        onAmountChange={() => undefined}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).toContain("Drop from inventory");
    expect(html).toContain("Wood");
    expect(html).toContain("8 available");
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-label="Drop amount slider"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="8"');
    expect(html).toContain("Drop 3");
  });

  it("disables actions while a single drop request is pending", () => {
    const html = renderToStaticMarkup(
      <DropItemDialog
        selection={selection}
        amount={2}
        busy
        onAmountChange={() => undefined}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).toContain("Dropping");
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("clamps an open dialog immediately when the live maximum shrinks", () => {
    const onAmountChange = vi.fn();
    const view = render(
      <DropItemDialog
        selection={selection}
        amount={8}
        busy={false}
        onAmountChange={onAmountChange}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    view.rerender(
      <DropItemDialog
        selection={{ ...selection, quantity: 3 }}
        amount={8}
        busy={false}
        onAmountChange={onAmountChange}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );
    expect(onAmountChange).toHaveBeenCalledWith(3);
  });
});
