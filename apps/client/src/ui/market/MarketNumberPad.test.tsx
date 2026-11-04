// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { MarketNumberInput, MarketNumberPadProvider } from "./MarketNumberPad.js";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-number-pad-open");
});

function Harness({ phone }: { phone: boolean }): React.JSX.Element {
  const [price, setPrice] = useState("1");
  const [quantity, setQuantity] = useState("4");
  const fields = (
    <>
      <MarketNumberInput label="Price each" value={price} onValueChange={setPrice} onCommit={() => setPrice((v) => v || "1")} />
      <MarketNumberInput label="Quantity" value={quantity} onValueChange={setQuantity} />
      <button type="button">Elsewhere</button>
    </>
  );
  return phone ? <MarketNumberPadProvider>{fields}</MarketNumberPadProvider> : fields;
}

const key = (name: string): void => { fireEvent.click(screen.getByRole("button", { name })); };
const priceBox = (): HTMLInputElement => screen.getByLabelText("Price each") as HTMLInputElement;

describe("MarketNumberPad", () => {
  it("keeps a normal typed input off phone", () => {
    render(<Harness phone={false} />);
    expect(priceBox().readOnly).toBe(false);
    expect(priceBox().getAttribute("inputmode")).toBe("numeric");
    fireEvent.change(priceBox(), { target: { value: "a58" } });
    expect(priceBox().value).toBe("58");
    expect(screen.queryByRole("group", { name: "Number pad" })).toBeNull();
  });

  it("opens the pad on a read-only box that never raises the system keyboard", () => {
    render(<Harness phone />);
    expect(priceBox().readOnly).toBe(true);
    expect(priceBox().getAttribute("inputmode")).toBe("none");
    expect(priceBox().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(priceBox());
    expect(screen.getByRole("group", { name: "Number pad" })).toBeTruthy();
    expect(priceBox().getAttribute("aria-expanded")).toBe("true");
    expect(document.documentElement.hasAttribute("data-number-pad-open")).toBe(true);
  });

  it("replaces on the first key, then appends; backspace and Clear edit", () => {
    render(<Harness phone />);
    fireEvent.click(priceBox());
    key("5");
    expect(priceBox().value).toBe("5");
    key("8");
    expect(priceBox().value).toBe("58");
    key("Backspace");
    expect(priceBox().value).toBe("5");
    key("0");
    key("0");
    expect(priceBox().value).toBe("500");
    key("Clear");
    expect(priceBox().value).toBe("");
    key("0");
    key("7");
    expect(priceBox().value).toBe("7");
  });

  it("caps at 19 digits", () => {
    render(<Harness phone />);
    fireEvent.click(priceBox());
    for (let i = 0; i < 22; i += 1) key("9");
    expect(priceBox().value).toBe("9".repeat(19));
  });

  it("switches target between boxes and starts fresh on each", () => {
    render(<Harness phone />);
    fireEvent.click(priceBox());
    key("2");
    fireEvent.click(screen.getByLabelText("Quantity"));
    key("6");
    expect((screen.getByLabelText("Quantity") as HTMLInputElement).value).toBe("6");
    expect(priceBox().value).toBe("2");
    expect(screen.getAllByRole("group", { name: "Number pad" })).toHaveLength(1);
  });

  it("Done and tapping outside close the pad and run the commit clamp", () => {
    render(<Harness phone />);
    fireEvent.click(priceBox());
    key("Clear");
    key("Done");
    expect(screen.queryByRole("group", { name: "Number pad" })).toBeNull();
    expect(priceBox().value).toBe("1");
    expect(document.documentElement.hasAttribute("data-number-pad-open")).toBe(false);

    fireEvent.click(priceBox());
    key("Clear");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("group", { name: "Number pad" })).toBeNull();
    expect(priceBox().value).toBe("1");
  });

  it("stays open when tapping the pad or a number box", () => {
    render(<Harness phone />);
    fireEvent.click(priceBox());
    fireEvent.pointerDown(screen.getByRole("button", { name: "7" }));
    fireEvent.pointerDown(screen.getByLabelText("Quantity"));
    expect(screen.getByRole("group", { name: "Number pad" })).toBeTruthy();
  });
});
