// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { useModalBehavior } from "./useModalBehavior.js";

describe("useModalBehavior", () => {
  it("focuses the dialog, closes on Escape, and restores launcher focus", () => {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      const dialogRef = useModalBehavior<HTMLElement>({ open, onClose: () => setOpen(false) });
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open menu</button>
        {open ? <section ref={dialogRef} role="dialog" tabIndex={-1}>
          <button type="button">First action</button>
          <button type="button">Last action</button>
        </section> : null}
      </>;
    }

    const view = render(<Harness />);
    const launcher = view.getByRole("button", { name: "Open menu" });
    launcher.focus();
    fireEvent.click(launcher);
    expect(document.activeElement).toBe(view.getByRole("button", { name: "First action" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(launcher);
  });

  it("wraps focus within the dialog", () => {
    function Dialog(): React.JSX.Element {
      const dialogRef = useModalBehavior<HTMLElement>({ open: true, onClose: () => undefined });
      return <section ref={dialogRef} role="dialog" tabIndex={-1}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </section>;
    }

    const view = render(<Dialog />);
    const first = view.getByRole("button", { name: "First" });
    const last = view.getByRole("button", { name: "Last" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
