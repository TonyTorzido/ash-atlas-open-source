import { describe, expect, it } from "vitest";

import {
  GOBLIN_DEFENDER_DIALOGUE,
  GOBLIN_DEFENDER_FUNNY_DIALOGUE,
  GOBLIN_DEFENDER_SNARKY_DIALOGUE,
  goblinDefenderDialogueForRoll
} from "./goblinDialogue.js";

describe("Goblin defender dialogue", () => {
  it("keeps 45 snarky and 5 funny lines in 50 unique equal-width bins", () => {
    expect(GOBLIN_DEFENDER_SNARKY_DIALOGUE).toHaveLength(45);
    expect(GOBLIN_DEFENDER_FUNNY_DIALOGUE).toHaveLength(5);
    expect(GOBLIN_DEFENDER_DIALOGUE).toHaveLength(50);
    expect(new Set(GOBLIN_DEFENDER_DIALOGUE)).toHaveLength(50);
    GOBLIN_DEFENDER_DIALOGUE.forEach((line, index) => {
      expect(goblinDefenderDialogueForRoll((index + 0.5) / 50)).toBe(line);
    });
  });
});
