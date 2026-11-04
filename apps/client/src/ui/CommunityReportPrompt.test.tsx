// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CommunityReportPrompt } from "./CommunityReportPrompt.js";

describe("CommunityReportPrompt", () => {
  it("submits a selected report category and optional explanation", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <CommunityReportPrompt
        targetLabel="player Mira"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByRole("radio", { name: "Threat or encouragement of harm" }));
    fireEvent.change(screen.getByLabelText("Report details"), { target: { value: "Repeated threats" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit Report" }));

    expect(onSubmit).toHaveBeenCalledWith("threat", "Repeated threats");
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
  });
});
