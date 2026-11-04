import { describe, expect, it } from "vitest";

import { resolveNativeBackAction } from "./nativeBack.js";

const base = {
  keyboardOpen: false,
  modalOpen: false,
  chatOpen: false,
  menuView: "gameplay",
  canGoBack: true
};

describe("native back priority", () => {
  it.each([
    [{ ...base, keyboardOpen: true, modalOpen: true }, "dismiss-keyboard"],
    [{ ...base, modalOpen: true, chatOpen: true }, "close-modal"],
    [{ ...base, chatOpen: true, screenBackAvailable: true }, "close-chat"],
    [{ ...base, modalOpen: true, screenBackAvailable: true }, "close-modal"],
    [{ ...base, appOpen: true, menuView: "inventory", screenBackAvailable: true }, "screen-back"],
    [{ ...base, appOpen: true, menuView: "inventory" }, "close-modal"],
    [{ ...base, menuView: "messages" }, "menu-back"],
    [{ ...base, menuView: "menu", canGoBack: false }, "close-menu"],
    [{ ...base, canGoBack: false }, "confirm-exit"]
  ] as const)("resolves %s before lower-priority actions", (state, expected) => {
    expect(resolveNativeBackAction(state)).toBe(expected);
  });

  it("confirms before leaving the gameplay root even when browser history exists", () => {
    expect(resolveNativeBackAction(base)).toBe("confirm-exit");
  });
});
