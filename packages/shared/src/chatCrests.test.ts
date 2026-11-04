import { describe, expect, it } from "vitest";

import {
  CHAT_CRESTS,
  DEFAULT_CHAT_CREST_ID,
  chatCrestDefinition,
  normalizeChatCrestId
} from "./chatCrests.js";

describe("Chat Crest registry", () => {
  it("keeps the starter set registered with a neutral fallback", () => {
    expect(CHAT_CRESTS.map(({ id }) => id)).toEqual(["lion", "leaf", "stag", "cross"]);
    expect(normalizeChatCrestId(null)).toBe(DEFAULT_CHAT_CREST_ID);
    expect(normalizeChatCrestId("legacy-crest")).toBe(DEFAULT_CHAT_CREST_ID);
    expect(chatCrestDefinition("legacy-crest").id).toBe(DEFAULT_CHAT_CREST_ID);
  });
});
