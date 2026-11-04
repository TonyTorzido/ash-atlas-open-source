// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { consumeAppleCallbackMessage } from "../auth/appleCallbackResult.js";

describe("Apple callback messages", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/play/");
  });

  it("shows cancellation once while preserving unrelated return parameters", () => {
    window.history.replaceState({}, "", "/play/?source=apple&apple_auth=cancelled#login");

    expect(consumeAppleCallbackMessage()).toBe(
      "Apple sign-in was canceled. Please try again when you're ready."
    );
    expect(window.location.pathname + window.location.search + window.location.hash)
      .toBe("/play/?source=apple#login");
    expect(consumeAppleCallbackMessage()).toBeNull();
  });

  it("uses a generic message for a sanitized provider failure", () => {
    window.history.replaceState({}, "", "/play/?apple_auth=provider_error");

    expect(consumeAppleCallbackMessage()).toBe(
      "Apple sign-in could not be completed. Please try again."
    );
    expect(window.location.search).toBe("");
  });
});
